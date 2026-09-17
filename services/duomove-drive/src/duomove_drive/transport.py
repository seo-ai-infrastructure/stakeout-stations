"""Authenticated JSONL control with resumable uploads and idempotent start."""
from __future__ import annotations

import base64
import hashlib
import json
import socket
import threading
import time
import uuid

from .planner import encode_plan, validate_plan

TERMINAL = frozenset({"COMPLETED","CANCELLED","EXPIRED","FAILED"})
MAX_LINE = 131_072


class PlayerError(RuntimeError): pass


class SocketClient:
    def __init__(self, endpoint, token: str, *, timeout=3.0):
        self.endpoint, self.token, self.timeout = endpoint, token, timeout
        self.socket = self.reader = None
        self.instance = None

    def close(self):
        if self.reader is not None: self.reader.close()
        if self.socket is not None: self.socket.close()
        self.socket = self.reader = None

    def _exchange(self, op: str, **fields) -> dict:
        request_id = uuid.uuid4().hex
        raw = json.dumps({"id":request_id,"op":op,**fields},allow_nan=False,separators=(",", ":")).encode()+b"\n"
        if len(raw) > MAX_LINE: raise PlayerError("control message too large")
        self.socket.sendall(raw)
        line = self.reader.readline(MAX_LINE+1)
        if not line or len(line) > MAX_LINE or not line.endswith(b"\n"): raise ConnectionError("invalid player response")
        try: reply = json.loads(line)
        except (ValueError, UnicodeError): raise ConnectionError("invalid player response") from None
        if reply.get("id") != request_id: raise ConnectionError("response ID mismatch")
        if reply.get("ok") is not True: raise PlayerError(str(reply.get("error", "player rejected command"))[:120])
        return reply

    def connect(self):
        self.close()
        host, port = self.endpoint.open()
        try:
            self.socket = socket.create_connection((host,port),timeout=self.timeout)
            self.socket.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
            self.reader = self.socket.makefile("rb")
            hello = self._exchange("auth",token=self.token,version=1)
            instance = hello.get("instance_id")
            if not isinstance(instance,str) or not instance: raise PlayerError("missing player instance")
            if self.instance is not None and self.instance != instance: raise PlayerError("player restarted; explicit new drive required")
            self.instance = instance
        except BaseException:
            self.close()
            raise

    def request(self, op: str, **fields) -> dict:
        if self.socket is None: self.connect()
        try: return self._exchange(op,**fields)
        except (OSError, ConnectionError, ValueError):
            self.close()
            raise ConnectionError("player connection interrupted") from None


class Driver:
    def __init__(self, client: SocketClient, *, retry_seconds=9.0, heartbeat_seconds=2.0):
        self.client = client
        self.retry_seconds, self.heartbeat_seconds = retry_seconds, heartbeat_seconds

    def _call(self, op: str, cancel: threading.Event | None = None, **fields) -> dict:
        deadline = time.monotonic()+self.retry_seconds
        delay = 0.1
        while True:
            if cancel and cancel.is_set(): raise InterruptedError("drive cancelled")
            try: return self.client.request(op,**fields)
            except (OSError, ConnectionError):
                if time.monotonic() >= deadline: raise ConnectionError("player reconnect deadline exceeded") from None
                if cancel: cancel.wait(delay)
                else: time.sleep(delay)
                delay = min(1.0, delay*2)

    def play(self, plan: dict, session_id: str, cancel: threading.Event, on_status=lambda value: None) -> dict:
        validate_plan(plan)
        uuid.UUID(session_id)
        data = encode_plan(plan)
        prepared = False
        try:
            reply = self._call("prepare",cancel,session_id=session_id,size=len(data),sha256=hashlib.sha256(data).hexdigest())
            prepared = True
            state = reply["state"]
            if state in TERMINAL:
                on_status(reply)
                return reply
            if state == "UPLOADING":
                offset = reply["received_bytes"]
                if type(offset) is not int or not 0 <= offset <= len(data): raise PlayerError("invalid upload offset")
                while offset < len(data):
                    chunk = data[offset:offset+48_000]
                    reply = self._call("append",cancel,session_id=session_id,offset=offset,data=base64.b64encode(chunk).decode())
                    expected = offset+len(chunk)
                    if reply.get("received_bytes") != expected: raise PlayerError("upload acknowledgement mismatch")
                    offset = expected
                reply = self._call("commit",cancel,session_id=session_id)
            if reply["state"] == "READY":
                reply = self._call("start",cancel,session_id=session_id)
            next_heartbeat = time.monotonic()
            while True:
                on_status(reply)
                if reply["state"] in TERMINAL: return reply
                if cancel.wait(max(0.0,next_heartbeat-time.monotonic())): raise InterruptedError("drive cancelled")
                reply = self._call("heartbeat",cancel,session_id=session_id)
                next_heartbeat = time.monotonic()+self.heartbeat_seconds
        except InterruptedError:
            if prepared:
                try:
                    reply = self._call("cancel",session_id=session_id)
                    if reply.get("state") in TERMINAL:
                        on_status(reply)
                        return reply
                except (PlayerError, ConnectionError, OSError): pass
            raise
        except BaseException:
            if prepared:
                try: self._call("cancel",session_id=session_id)
                except (PlayerError, ConnectionError, OSError): pass
            raise
        finally:
            self.client.close()
            self.client.endpoint.close()
