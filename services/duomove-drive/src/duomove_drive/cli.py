from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import tempfile
import threading
import uuid
from pathlib import Path

from .adb import Adb, AdbTunnel, provision
from .planner import Stop, plan_route, validate_plan
from .routing import fetch_route, geojson_coordinates
from .transport import Driver, SocketClient


def write_json(path: Path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix=".duomove-",dir=path.parent)
    try:
        with os.fdopen(fd,"w") as out:
            json.dump(value,out,allow_nan=False,indent=2);out.write("\n");out.flush();os.fsync(out.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)


def read_plan(path: Path):
    if path.stat().st_size>8_500_000:raise ValueError("plan too large")
    value=json.loads(path.read_text());validate_plan(value);return value


def coordinates(text):
    try:a,b=text.split(",");return float(a),float(b)
    except ValueError:raise argparse.ArgumentTypeError("use latitude,longitude") from None


def stop(text):
    try:a,b=text.split(":");return Stop(float(a),float(b))
    except ValueError:raise argparse.ArgumentTypeError("use distance_metres:dwell_seconds") from None


def main(argv=None):
    parser=argparse.ArgumentParser(description="DuoMove deterministic drive planner and Android player")
    commands=parser.add_subparsers(dest="command",required=True)
    p=commands.add_parser("plan",help="prepare a route without changing a phone")
    source=p.add_mutually_exclusive_group(required=True)
    source.add_argument("--geojson",type=Path);source.add_argument("--start",type=coordinates)
    p.add_argument("--end",type=coordinates);p.add_argument("--osrm",default=os.environ.get("DUOMOVE_OSRM_URL"))
    p.add_argument("--mph",type=float,default=35);p.add_argument("--acceleration",type=float,default=1.5)
    p.add_argument("--braking",type=float,default=2);p.add_argument("--corner-cut",type=float,default=2)
    p.add_argument("--stop",type=stop,action="append",default=[]);p.add_argument("--arrival-dwell",type=float,default=30)
    p.add_argument("--out",type=Path,required=True)
    for name in ("run","status","provision"):
        p=commands.add_parser(name)
        p.add_argument("--serial",required=True);p.add_argument("--token-file",type=Path,required=True)
        p.add_argument("--connect",action="store_true",help="connect to this explicit HOST:PORT first")
        if name=="run":
            p.add_argument("--plan",type=Path,required=True);p.add_argument("--run-id",default=None)
            p.add_argument("--report",type=Path,required=True)
        elif name=="provision":p.add_argument("--apk",type=Path,required=True)
    commands.add_parser("serve",help="run the authenticated Railway service; no drives run automatically")
    args=parser.parse_args(argv)
    try:
        if args.command=="serve":
            from .server import serve
            serve()
            return 0
        if args.command=="plan":
            if args.geojson:
                if args.geojson.stat().st_size>4_000_000:raise ValueError("route file too large")
                route=geojson_coordinates(json.loads(args.geojson.read_text()))
            else:
                if args.end is None or not args.osrm:raise ValueError("--start needs --end and an explicit --osrm HTTPS endpoint")
                route=fetch_route(args.start,args.end,base_url=args.osrm)
            plan=plan_route(route,cruise_mph=args.mph,acceleration=args.acceleration,braking=args.braking,
                            corner_cut_m=args.corner_cut,stops=args.stop,arrival_dwell=args.arrival_dwell)
            write_json(args.out,plan)
            print(json.dumps({"distance_m":round(plan["total_distance_m"],1),"duration_seconds":plan["duration_ms"]/1000,"samples":len(plan["samples"]),"file":str(args.out)}))
            return 0
        adb=Adb(args.serial)
        if args.command=="provision":
            if not args.token_file.exists():
                fd=os.open(args.token_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,"w") as out:out.write(secrets.token_urlsafe(32))
            token=args.token_file.read_text().strip()
            if args.connect:adb.connect()
            provision(adb,args.apk,token)
            print("Player installed and mock-location app-op configured. Verify its Ready screen.")
            return 0
        token=args.token_file.read_text().strip()
        endpoint=AdbTunnel(adb,args.connect)
        client=SocketClient(endpoint,token)
        if args.command=="status":
            try:print(json.dumps(client.request("status"),indent=2))
            finally:client.close();endpoint.close()
            return 0
        plan=read_plan(args.plan);run_id=args.run_id or str(uuid.uuid4());event=threading.Event()
        for sig in (signal.SIGINT,signal.SIGTERM):signal.signal(sig,lambda *_:event.set())
        def progress(state):
            write_json(args.report,{"run_id":run_id,**state})
            print(json.dumps({"run_id":run_id,"state":state["state"],"applied_seq":state.get("applied_seq",-1),
                              "framework_observed_seq":state.get("framework_observed_seq",-1),"fused_observed_seq":state.get("fused_observed_seq",-1)}),flush=True)
        try:
            result=Driver(client).play(plan,run_id,event,progress)
            return 0 if result["state"]=="COMPLETED" else 2
        except InterruptedError:
            write_json(args.report,{"run_id":run_id,"state":"CANCELLED","phone_stop":"requested; lease is fallback"})
            return 130
        except Exception:
            write_json(args.report,{"run_id":run_id,"state":"FAILED","phone_stop":"requested; lease is fallback"})
            raise
    except (ValueError,RuntimeError,OSError):
        print("Command failed. Check input, device connectivity, player readiness, and the run report.")
        return 2


if __name__=="__main__":raise SystemExit(main())
