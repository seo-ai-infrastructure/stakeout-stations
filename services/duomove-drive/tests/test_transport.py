import hashlib
import json
import socketserver
import threading
import uuid
from contextlib import contextmanager

import pytest

from duomove_drive.geometry import destination
from duomove_drive.planner import plan_route
from duomove_drive.transport import Driver,PlayerError,SocketClient


@contextmanager
def phone(*,drop_append=False,drop_start=False,change_instance=False):
    state={'state':'IDLE','received_bytes':0,'applied_seq':-1,'start_count':0,'auth_count':0,
           'data':bytearray(),'drop_append':drop_append,'drop_start':drop_start}
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            authenticated=False
            while line:=self.rfile.readline(131073):
                request=json.loads(line);op=request['op'];reply={'id':request['id'],'ok':True}
                if op=='auth':
                    state['auth_count']+=1
                    if request['token']!='x'*40:
                        reply.update(ok=False,error='unauthorized')
                    else:
                        authenticated=True
                        reply['instance_id']='changed' if change_instance and state['auth_count']>1 else 'phone-one'
                elif not authenticated:reply.update(ok=False,error='unauthorized')
                elif op=='prepare':
                    state.update(state='UPLOADING',sha=request['sha256'],session_id=request['session_id'])
                elif op=='append':
                    import base64
                    data=base64.b64decode(request['data']);offset=request['offset']
                    if offset==len(state['data']):state['data'].extend(data)
                    else:assert state['data'][offset:offset+len(data)]==data
                    state['received_bytes']=len(state['data'])
                    if state['drop_append']:state['drop_append']=False;return
                elif op=='commit':
                    assert hashlib.sha256(state['data']).hexdigest()==state['sha']
                    state['state']='READY'
                elif op=='start':
                    if state['state']=='READY':state['start_count']+=1;state['state']='RUNNING';state['applied_seq']=0
                    if state['drop_start']:state['drop_start']=False;return
                elif op=='heartbeat':state['state']='COMPLETED';state['applied_seq']=len(json.loads(state['data'])['samples'])-1
                elif op=='cancel':state['state']='CANCELLED';state['cleanup_ok']=True
                reply.update({k:v for k,v in state.items() if k in ('state','received_bytes','applied_seq','session_id','cleanup_ok')})
                self.wfile.write(json.dumps(reply).encode()+b'\n');self.wfile.flush()
    server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler)
    server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    class Endpoint:
        def open(self):return server.server_address
        def close(self):pass
    try:yield Endpoint(),state
    finally:server.shutdown();server.server_close();thread.join()


@pytest.mark.parametrize('drop_append,drop_start',[(True,False),(False,True),(True,True)])
def test_lost_acknowledgements_resume_without_duplicate_start(drop_append,drop_start):
    p=plan_route([(28,-81),destination((28,-81),90,100)],arrival_dwell=1)
    with phone(drop_append=drop_append,drop_start=drop_start) as (endpoint,state):
        driver=Driver(SocketClient(endpoint,'x'*40),retry_seconds=2,heartbeat_seconds=0.01)
        result=driver.play(p,str(uuid.uuid4()),threading.Event())
        assert result['state']=='COMPLETED'
        assert state['start_count']==1
        assert state['auth_count']>=2


def test_player_restart_never_restarts_route():
    p=plan_route([(28,-81),destination((28,-81),90,100)],arrival_dwell=1)
    with phone(drop_start=True,change_instance=True) as (endpoint,state):
        driver=Driver(SocketClient(endpoint,'x'*40),retry_seconds=0.2)
        with pytest.raises(PlayerError,match='restarted'):
            driver.play(p,str(uuid.uuid4()),threading.Event())
        assert state['start_count']==1


def test_incorrect_token_is_rejected_before_upload():
    with phone() as (endpoint,state):
        client=SocketClient(endpoint,'wrong')
        with pytest.raises(PlayerError,match='unauthorized'):client.request('status')
        client.close()
        assert len(state['data'])==0


def test_cancellation_preserves_provider_cleanup_acknowledgement():
    p=plan_route([(28,-81),destination((28,-81),90,100)],arrival_dwell=1)
    with phone() as (endpoint,state):
        cancel=threading.Event()
        def observe(status):
            if status['state']=='RUNNING':cancel.set()
        result=Driver(SocketClient(endpoint,'x'*40)).play(p,str(uuid.uuid4()),cancel,observe)
        assert result['state']=='CANCELLED' and result['cleanup_ok'] is True
        assert state['start_count']==1
