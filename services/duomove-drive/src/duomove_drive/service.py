"""Private Railway service. Vercel's server must authorize tenant/device access."""
from __future__ import annotations

import fcntl
import hmac
import json
import os
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .adb import Adb, AdbTunnel, check_serial
from .planner import Stop, plan_hash, plan_route, validate_plan
from .store import BusyError, Store
from .transport import Driver, PlayerError, SocketClient


@dataclass(frozen=True)
class Target:
    serial: str
    token: str = field(repr=False)
    connect: bool = False


def targets_from_env() -> dict[str, Target]:
    raw = json.loads(os.environ.get("DUOMOVE_TARGETS_JSON", "{}"))
    if not isinstance(raw,dict) or len(raw) > 100: raise ValueError("invalid target configuration")
    result = {}
    for alias, config in raw.items():
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}",alias): raise ValueError("invalid target alias")
        if not isinstance(config,dict) or set(config)-{"serial","token","connect"}: raise ValueError("invalid target fields")
        serial, token = check_serial(config.get("serial")), config.get("token", "")
        if not isinstance(token,str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}",token): raise ValueError("invalid player token")
        if type(config.get("connect",False)) is not bool: raise ValueError("connect must be boolean")
        result[alias] = Target(serial,token,config.get("connect",False))
    if len({t.serial for t in result.values()}) != len(result): raise ValueError("each phone may have only one target alias")
    return result


class Manager:
    def __init__(self, store, targets, capacity=3, driver_factory=None):
        self.store, self.targets, self.capacity = store, targets, capacity
        self.lock = threading.RLock()
        self.active: dict[str,tuple[threading.Event,threading.Thread]] = {}
        self.factory = driver_factory or (lambda target: Driver(SocketClient(AdbTunnel(Adb(target.serial),target.connect),target.token)))

    def submit(self, target, run_id, plan):
        if target not in self.targets: raise KeyError(target)
        uuid.UUID(run_id)
        validate_plan(plan)
        with self.lock:
            if not self.store.reserve(run_id,target,plan_hash(plan),self.capacity): return self.store.get(run_id)
            event = threading.Event()
            thread = threading.Thread(target=self._run,args=(run_id,self.targets[target],plan,event),daemon=True)
            self.active[run_id] = (event,thread)
            thread.start()
        return self.store.get(run_id)

    def _run(self, run_id, target, plan, event):
        try:
            driver = self.factory(target)
            self.store.update(run_id,"CONNECTING",{})
            result = driver.play(plan,run_id,event,lambda s:self.store.update(run_id,s["state"],s))
            self.store.update(run_id,result["state"],result)
        except InterruptedError:
            self.store.update(run_id,"CANCELLED",{"error":"cancel requested; verify phone status or wait for lease expiry"})
        except Exception:
            # Never persist exception text that might contain a serial or credential.
            self.store.update(run_id,"FAILED",{"error":"drive failed; phone lease prevents unattended continuation"})
        finally:
            with self.lock: self.active.pop(run_id,None)

    def cancel(self, run_id):
        with self.lock:
            if run_id in self.active: self.active[run_id][0].set()
        return self.store.get(run_id)

    def shutdown(self):
        with self.lock:
            current = list(self.active.values())
            for event,_ in current: event.set()
        deadline = time.monotonic()+15
        for _,thread in current: thread.join(timeout=max(0,deadline-time.monotonic()))


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    coordinates: list[tuple[float,float]] = Field(min_length=2,max_length=20000)
    cruise_mph: float = 35
    acceleration: float = 1.5
    braking: float = 2
    lateral_acceleration: float = 1.5
    corner_cut_m: float = 2
    arrival_dwell: float = 30
    accuracy_m: float = 8
    altitude_m: float | None = None
    stops: list[dict[str,float]] = Field(default_factory=list,max_length=100)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: uuid.UUID
    target: str = Field(min_length=1,max_length=80)
    plan: dict


def create_app(*, token=None, targets=None, state_dir=None, capacity=None, driver_factory=None):
    secret = token if token is not None else os.environ.get("DUOMOVE_INTERNAL_TOKEN", "")
    configured = targets if targets is not None else targets_from_env()
    root = Path(state_dir or os.environ.get("DUOMOVE_STATE_DIR", "/data/duomove"))
    slots = capacity or int(os.environ.get("DUOMOVE_CAPACITY", "3"))
    if not 1 <= slots <= 100: raise ValueError("capacity must be 1–100")

    @asynccontextmanager
    async def lifespan(app):
        root.mkdir(parents=True,exist_ok=True,mode=0o700)
        handle = (root/"controller.lock").open("a")
        try:
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise RuntimeError("only one controller may own this state directory") from None
        try:
            store = Store(root/"runs.sqlite3")
            store.interrupt_old_runs()
            app.state.manager = Manager(store,configured,slots,driver_factory)
            yield
        finally:
            if hasattr(app.state,"manager"): app.state.manager.shutdown()
            fcntl.flock(handle,fcntl.LOCK_UN)
            handle.close()

    app = FastAPI(title="DuoMove Drive",version="1.0.0",lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)

    def authorized(authorization: str = Header(default="")):
        if len(secret) < 32: raise HTTPException(503,"controller token not configured")
        if not hmac.compare_digest(authorization,"Bearer "+secret): raise HTTPException(401,"unauthorized")

    @app.middleware("http")
    async def bounded_body(request: Request, call_next):
        from starlette.responses import JSONResponse
        # Reject absent/invalid length on body-bearing endpoints and forbid chunked
        # transfer, avoiding unbounded accumulation before Pydantic validation.
        if request.method == "POST":
            length = request.headers.get("content-length", "0")
            if not length.isdecimal() or int(length) > 8_500_000 or "transfer-encoding" in request.headers:
                return JSONResponse({"detail":"request body too large or unbounded"},status_code=413)
        return await call_next(request)

    @app.get("/healthz")
    def health(): return {"status":"ok","device_readiness":"not_checked"}

    @app.get("/v1/targets",dependencies=[Depends(authorized)])
    def targets_view(): return {"targets":list(configured),"capacity":slots}

    @app.post("/v1/plans",dependencies=[Depends(authorized)])
    def plan(body: PlanRequest):
        try:
            options = body.model_dump()
            options["stops"] = [Stop(**s) for s in options["stops"]]
            return plan_route(**options)
        except (ValueError,TypeError): raise HTTPException(422,"invalid route or motion settings") from None

    @app.post("/v1/runs",status_code=202,dependencies=[Depends(authorized)])
    def run(body: RunRequest):
        try: return app.state.manager.submit(body.target,str(body.run_id),body.plan)
        except KeyError: raise HTTPException(404,"unknown configured target") from None
        except BusyError as e: raise HTTPException(409,str(e)) from None
        except (ValueError,TypeError): raise HTTPException(422,"invalid plan or conflicting run ID") from None

    @app.get("/v1/runs/{run_id}",dependencies=[Depends(authorized)])
    def status(run_id: uuid.UUID):
        value = app.state.manager.store.get(str(run_id))
        if value is None: raise HTTPException(404,"unknown run")
        return value

    @app.post("/v1/runs/{run_id}/cancel",dependencies=[Depends(authorized)])
    def cancel(run_id: uuid.UUID):
        value = app.state.manager.cancel(str(run_id))
        if value is None: raise HTTPException(404,"unknown run")
        return value

    return app
