"""Every operation is pinned to one configured serial; no per-fix shell calls."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

PLAYER_PACKAGE = "net.stakeout.duomove.player"


def check_serial(serial: str) -> str:
    if not isinstance(serial, str) or not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{1,200}", serial) or serial.startswith("-"):
        raise ValueError("invalid ADB serial")
    return serial


class Adb:
    def __init__(self, serial: str, *, executable="adb", timeout=5.0):
        self.serial = check_serial(serial)
        self.executable = executable
        self.timeout = timeout

    def call(self, *args: str, data: bytes | None = None) -> bytes:
        try:
            p = subprocess.run([self.executable,"-s",self.serial,*args], input=data,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=self.timeout,check=True)
            return p.stdout
        except (OSError, subprocess.SubprocessError):
            raise ConnectionError("ADB operation failed or timed out") from None

    def connect(self):
        if not re.fullmatch(r"(?:[A-Za-z0-9_.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}", self.serial):
            raise ValueError("connect requires a configured HOST:PORT endpoint")
        self.call("connect", self.serial)
        if self.call("get-state").strip() != b"device": raise ConnectionError("ADB device not ready")


class AdbTunnel:
    def __init__(self, adb: Adb, connect=False):
        self.adb, self.auto_connect, self.port = adb, connect, None

    def open(self) -> tuple[str,int]:
        self.close()
        if self.auto_connect: self.adb.connect()
        elif self.adb.call("get-state").strip() != b"device": raise ConnectionError("ADB device not ready")
        raw = self.adb.call("forward","tcp:0","tcp:9999").strip()
        if not raw.isdigit() or not 1 <= int(raw) <= 65535: raise ConnectionError("ADB did not allocate a port")
        self.port = int(raw)
        return "127.0.0.1", self.port

    def close(self):
        if self.port is not None:
            port, self.port = self.port, None
            try: self.adb.call("forward","--remove",f"tcp:{port}")
            except ConnectionError: pass


def provision(adb: Adb, apk: Path, token: str):
    """Explicit operator command. Installs a debug helper and authorizes mock data."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token): raise ValueError("invalid player token")
    if not apk.is_file(): raise ValueError("APK missing")
    old_timeout = adb.timeout
    try:
        adb.timeout = max(old_timeout, 60)
        adb.call("install","-r",str(apk.resolve()))
        adb.timeout = old_timeout
        # Token travels through stdin, not a command-line argument or sdcard.
        adb.call("shell","am","force-stop",PLAYER_PACKAGE)
        adb.call("shell","run-as",PLAYER_PACKAGE,"sh","-c","'umask 077; mkdir -p files; cat > files/control-token'",data=token.encode())
        for permission in ("ACCESS_COARSE_LOCATION","ACCESS_FINE_LOCATION"):
            adb.call("shell","pm","grant",PLAYER_PACKAGE,"android.permission."+permission)
        sdk = int(adb.call("shell","getprop","ro.build.version.sdk").strip())
        if sdk >= 33: adb.call("shell","pm","grant",PLAYER_PACKAGE,"android.permission.POST_NOTIFICATIONS")
        adb.call("shell","appops","set",PLAYER_PACKAGE,"android:mock_location","allow")
        adb.call("shell","am","start","-W","-n",PLAYER_PACKAGE+"/.MainActivity")
    finally: adb.timeout = old_timeout
