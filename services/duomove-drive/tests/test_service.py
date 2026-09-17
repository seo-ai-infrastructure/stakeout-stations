import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from duomove_drive.geometry import destination
from duomove_drive.planner import plan_route
from duomove_drive.service import Target,create_app,targets_from_env
from duomove_drive.store import BusyError,Store

TOKEN='t'*40
HEADERS={'Authorization':'Bearer '+TOKEN}


def test_service_auth_no_arbitrary_device_and_cancellation(tmp_path):
    class FakeDriver:
        def play(self,plan,run_id,cancel,on_status):
            on_status({'state':'RUNNING','applied_seq':0})
            cancel.wait(5)
            return {'state':'CANCELLED','applied_seq':0}
    app=create_app(token=TOKEN,targets={'one':Target('emulator-5554','x'*40)},state_dir=tmp_path,driver_factory=lambda _:FakeDriver())
    with TestClient(app) as c:
        assert c.get('/healthz').status_code==200
        assert c.get('/v1/targets').status_code==401
        assert c.get('/v1/targets',headers=HEADERS).json()['targets']==['one']
        p=plan_route([(28,-81),destination((28,-81),90,30)],arrival_dwell=1)
        body={'run_id':str(uuid.uuid4()),'target':'one','plan':p}
        assert c.post('/v1/runs',json={**body,'serial':'attacker:5555'},headers=HEADERS).status_code==422
        assert c.post('/v1/runs',json={**body,'target':'unknown'},headers=HEADERS).status_code==404
        assert c.post('/v1/runs',json=body,headers=HEADERS).status_code==202
        assert c.post('/v1/runs',json=body,headers=HEADERS).status_code==202
        assert c.post('/v1/runs',json={**body,'run_id':str(uuid.uuid4())},headers=HEADERS).status_code==409
        assert c.post('/v1/runs/'+body['run_id']+'/cancel',headers=HEADERS).status_code==200


def test_durable_reservation_has_one_winner(tmp_path):
    store=Store(tmp_path/'runs.sqlite3')
    def reserve(_):
        try:return store.reserve(str(uuid.uuid4()),'phone','digest',10)
        except BusyError:return False
    with ThreadPoolExecutor(max_workers=8) as pool:assert sum(pool.map(reserve,range(20)))==1


def test_process_restart_marks_active_runs_interrupted(tmp_path):
    store=Store(tmp_path/'runs.sqlite3');run=str(uuid.uuid4())
    assert store.reserve(run,'phone','digest',3)
    store.interrupt_old_runs()
    assert store.get(run)['state']=='INTERRUPTED'
    assert store.reserve(run,'phone','digest',3) is False


def test_duplicate_aliases_cannot_double_book_a_phone(monkeypatch):
    import json
    value={'a':{'serial':'emulator-5554','token':'x'*40},'b':{'serial':'emulator-5554','token':'x'*40}}
    monkeypatch.setenv('DUOMOVE_TARGETS_JSON',json.dumps(value))
    with pytest.raises(ValueError):targets_from_env()


def test_two_process_owners_of_same_state_are_rejected(tmp_path):
    first=create_app(token=TOKEN,targets={},state_dir=tmp_path)
    second=create_app(token=TOKEN,targets={},state_dir=tmp_path)
    with TestClient(first):
        with pytest.raises(RuntimeError):
            with TestClient(second):pass


@pytest.mark.parametrize('sample',[None,[],{},42,{'seq':False,'t_ms':0}])
def test_malformed_plan_is_rejected_before_device_reservation(tmp_path,sample):
    app=create_app(token=TOKEN,targets={'one':Target('emulator-5554','x'*40)},state_dir=tmp_path,
                   driver_factory=lambda _:pytest.fail('malformed plan reached device'))
    with TestClient(app) as client:
        body={'run_id':str(uuid.uuid4()),'target':'one','plan':{'version':1,'interval_ms':1000,'samples':[sample,sample]}}
        assert client.post('/v1/runs',json=body,headers=HEADERS).status_code==422
