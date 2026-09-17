"""Deterministic distance-domain speed planning, then analytic time sampling."""
from __future__ import annotations

import bisect
import hashlib
import json
import math
from dataclasses import dataclass

from .geometry import Route, finite, make_route

MAX_PLAN_BYTES = 8_000_000
MAX_SAMPLES = 14_401  # four hours at 1 Hz


@dataclass(frozen=True)
class Stop:
    distance_m: float
    dwell_s: float = 10.0


@dataclass(frozen=True)
class Leg:
    start_s: float
    end_s: float
    start_t: float
    end_t: float
    start_v: float
    end_v: float
    phase: str

    def at(self, t: float) -> tuple[float, float]:
        dt = max(0.0, min(t, self.end_t)-self.start_t)
        duration = self.end_t-self.start_t
        a = (self.end_v-self.start_v)/duration if duration else 0
        return min(self.end_s, self.start_s+self.start_v*dt+0.5*a*dt*dt), max(0.0, self.start_v+a*dt)


class Trajectory:
    def __init__(self, route: Route, accel: float, braking: float, stops: list[Stop], arrival_dwell: float):
        self.route = route
        finite(accel, 0.1, 5, "acceleration")
        finite(braking, 0.1, 8, "braking")
        finite(arrival_dwell, 1, 600, "arrival_dwell")
        if len(stops) > 100: raise ValueError("at most 100 stops")
        dwells: dict[float, float] = {}
        for stop in stops:
            s = finite(stop.distance_m, 0, route.length, "stop distance")
            dwell = finite(stop.dwell_s, 0, 600, "stop dwell")
            if s in dwells: raise ValueError("duplicate stop distance")
            dwells[s] = dwell
        dwells[route.length] = max(dwells.get(route.length, 0), arrival_dwell)
        # Keep short start/end and adjacent-stop spans traversable: every span
        # gets an interior node before the forward/backward speed passes.
        base = sorted(set([*route.distances, *dwells]))
        knots = sorted(set(base+[0.5*(a+b) for a,b in zip(base,base[1:])]))
        speeds = [route.at(s)[2] for s in knots]
        speeds[0] = speeds[-1] = 0.0
        for i, s in enumerate(knots):
            if s in dwells: speeds[i] = 0.0
        for i in range(1, len(knots)):
            speeds[i] = min(speeds[i], math.sqrt(speeds[i-1]**2+2*accel*(knots[i]-knots[i-1])))
        for i in range(len(knots)-2, -1, -1):
            speeds[i] = min(speeds[i], math.sqrt(speeds[i+1]**2+2*braking*(knots[i+1]-knots[i])))
        self.legs: list[Leg] = []
        t = 0.0
        if dwells.get(0.0, 0) > 0:
            t = dwells[0.0]
            self.legs.append(Leg(0, 0, 0, t, 0, 0, "dwell"))
        for i in range(len(knots)-1):
            s, e, v, w = knots[i], knots[i+1], speeds[i], speeds[i+1]
            if v+w <= 0: raise ValueError("non-traversable route segment")
            dt = 2*(e-s)/(v+w)
            self.legs.append(Leg(s, e, t, t+dt, v, w, "drive"))
            t += dt
            if dwells.get(e, 0) > 0:
                self.legs.append(Leg(e, e, t, t+dwells[e], 0, 0, "dwell"))
                t += dwells[e]
        self.duration = t
        self.ends = [leg.end_t for leg in self.legs]
        if math.ceil(t)+1 > MAX_SAMPLES: raise ValueError("route exceeds four hours")

    def at(self, seconds: float) -> tuple[float, float, str]:
        if seconds >= self.duration: return self.route.length, 0.0, "dwell"
        leg = self.legs[min(bisect.bisect_right(self.ends, seconds), len(self.legs)-1)]
        s, v = leg.at(seconds)
        return s, v, leg.phase


def plan_route(coordinates, *, cruise_mph=35.0, acceleration=1.5, braking=2.0,
               lateral_acceleration=1.5, corner_cut_m=2.0, stops=(), arrival_dwell=30.0,
               accuracy_m=8.0, altitude_m=None) -> dict:
    cruise = finite(cruise_mph, 0.25, 130, "cruise_mph")*0.44704
    accuracy = finite(accuracy_m, 0.1, 1000, "accuracy_m")
    altitude = None if altitude_m is None else finite(altitude_m, -12000, 100000, "WGS84 altitude")
    route = make_route(coordinates, cruise, lateral_acceleration, corner_cut_m)
    trajectory = Trajectory(route, acceleration, braking, list(stops), arrival_dwell)
    samples = []
    for seq in range(math.ceil(trajectory.duration)+1):
        s, speed, phase = trajectory.at(seq)
        coordinate, heading, _ = route.at(s)
        samples.append({"seq":seq,"t_ms":seq*1000,"lat":coordinate[0],"lon":coordinate[1],
                        "speed_mps":speed,"bearing_deg":heading,"accuracy_m":accuracy,
                        "altitude_m":altitude,"distance_m":s,"phase":phase})
    result = {"version":1,"interval_ms":1000,"total_distance_m":route.length,
              "motion_and_dwell_seconds":trajectory.duration,"duration_ms":samples[-1]["t_ms"],
              "metadata":{"synthetic":True,"altitude_datum":"WGS84_ELLIPSOID" if altitude is not None else None,
                          "corner_cut_m":corner_cut_m,"acceleration_mps2":acceleration,
                          "braking_mps2":braking,"lateral_acceleration_mps2":lateral_acceleration},
              "samples":samples}
    encode_plan(result)
    return result


def encode_plan(plan: dict) -> bytes:
    data = json.dumps(plan, allow_nan=False, separators=(",", ":"), sort_keys=True).encode()
    if len(data) > MAX_PLAN_BYTES: raise ValueError("plan too large")
    return data


def plan_hash(plan: dict) -> str:
    return hashlib.sha256(encode_plan(plan)).hexdigest()


def validate_plan(plan: dict) -> None:
    if not isinstance(plan, dict): raise ValueError("plan must be an object")
    if type(plan.get("version")) is not int or plan["version"] != 1 or type(plan.get("interval_ms")) is not int or plan["interval_ms"] != 1000:
        raise ValueError("unsupported plan version or interval")
    samples = plan.get("samples")
    if not isinstance(samples, list) or not 2 <= len(samples) <= MAX_SAMPLES: raise ValueError("invalid sample count")
    from .geometry import point, distance
    previous = previous_phase = None
    for i, sample in enumerate(samples):
        if not isinstance(sample, dict): raise ValueError("sample must be an object")
        if type(sample.get("seq")) is not int or sample["seq"] != i or type(sample.get("t_ms")) is not int or sample["t_ms"] != 1000*i:
            raise ValueError("non-contiguous samples")
        p = point((sample.get("lat"), sample.get("lon")))
        finite(sample.get("speed_mps"), 0, 60, "speed")
        finite(sample.get("bearing_deg"), 0, 359.999999999, "bearing")
        finite(sample.get("accuracy_m"), 0.1, 1000, "accuracy")
        if sample.get("altitude_m") is not None: finite(sample["altitude_m"], -12000, 100000, "altitude")
        if sample.get("phase") not in ("drive", "dwell"): raise ValueError("invalid phase")
        if sample["phase"] == "dwell" and sample["speed_mps"] != 0: raise ValueError("moving dwell")
        if previous is not None and distance(previous, p) > 61: raise ValueError("position exceeds speed ceiling")
        if previous is not None and previous_phase == sample["phase"] == "dwell" and distance(previous, p) > 0.01:
            raise ValueError("dwell position changed")
        previous = p
        previous_phase = sample["phase"]
    if samples[0]["speed_mps"] != 0 or samples[-1]["speed_mps"] != 0: raise ValueError("route must start and finish stopped")
    if type(plan.get("duration_ms")) is not int or plan["duration_ms"] != samples[-1]["t_ms"]: raise ValueError("duration mismatch")
    encode_plan(plan)
