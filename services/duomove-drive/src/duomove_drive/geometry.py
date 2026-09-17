"""Metric route geometry. Public coordinates are always (latitude, longitude)."""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

EARTH_M = 6_371_008.8
Point = tuple[float, float]


def finite(value: float, low: float, high: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} outside [{low}, {high}]")
    return float(value)


def point(p) -> Point:
    if not isinstance(p, (list, tuple)) or len(p) != 2:
        raise ValueError("coordinate must contain latitude and longitude")
    return finite(p[0], -85, 85, "latitude"), finite(p[1], -180, 180, "longitude")


def distance(a: Point, b: Point) -> float:
    p, q = math.radians(a[0]), math.radians(b[0])
    h = math.sin((q-p)/2)**2 + math.cos(p)*math.cos(q)*math.sin(math.radians(b[1]-a[1])/2)**2
    return 2*EARTH_M*math.asin(math.sqrt(max(0.0, min(1.0, h))))


def bearing(a: Point, b: Point) -> float:
    p, q, d = math.radians(a[0]), math.radians(b[0]), math.radians(b[1]-a[1])
    return math.degrees(math.atan2(math.sin(d)*math.cos(q), math.cos(p)*math.sin(q)-math.sin(p)*math.cos(q)*math.cos(d))) % 360


def destination(origin: Point, heading: float, metres: float) -> Point:
    p, l, h, d = math.radians(origin[0]), math.radians(origin[1]), math.radians(heading), metres/EARTH_M
    q = math.asin(max(-1, min(1, math.sin(p)*math.cos(d)+math.cos(p)*math.sin(d)*math.cos(h))))
    lon = l+math.atan2(math.sin(h)*math.sin(d)*math.cos(p), math.cos(d)-math.sin(p)*math.sin(q))
    return math.degrees(q), (math.degrees(lon)+180) % 360-180


def interpolate(a: Point, b: Point, fraction: float) -> Point:
    if fraction <= 0: return a
    if fraction >= 1: return b
    return destination(a, bearing(a, b), distance(a, b)*fraction)


@dataclass(frozen=True)
class Node:
    coordinate: Point
    speed_cap: float


class Route:
    def __init__(self, nodes: list[Node]):
        self.nodes = [nodes[0]]
        self.distances = [0.0]
        for n in nodes[1:]:
            d = distance(self.nodes[-1].coordinate, n.coordinate)
            if d < 1e-5:
                last = self.nodes[-1]
                self.nodes[-1] = Node(last.coordinate, min(last.speed_cap, n.speed_cap))
                continue
            self.nodes.append(n)
            self.distances.append(self.distances[-1]+d)
        self.length = self.distances[-1]
        self.cruise = max(n.speed_cap for n in self.nodes)
        if self.length < 0.1 or self.length > 300_000:
            raise ValueError("route length must be between 0.1 m and 300 km")

    def at(self, metres: float) -> tuple[Point, float, float]:
        s = max(0.0, min(self.length, metres))
        i = min(len(self.nodes)-2, max(0, bisect.bisect_right(self.distances, s)-1))
        a, b = self.nodes[i], self.nodes[i+1]
        frac = (s-self.distances[i])/(self.distances[i+1]-self.distances[i])
        cap = a.speed_cap+(b.speed_cap-a.speed_cap)*frac
        if a.speed_cap == b.speed_cap == 0 and 0 < frac < 1:
            cap = self.cruise
        return interpolate(a.coordinate, b.coordinate, frac), bearing(a.coordinate, b.coordinate), cap


def make_route(coordinates, cruise_mps: float, lateral_accel: float = 1.5,
               corner_cut_m: float = 2.0, spacing_m: float = 2.0) -> Route:
    """Round bends inside a bounded corner envelope; never claim lane accuracy.

    Circular fillets limit curvature; nearly reversing bends stop at the vertex.
    Each fillet trims at most 45% of either neighboring segment, so adjacent
    fillets cannot overlap. Spherical interpolation handles longitude wrap.
    """
    if not 2 <= len(coordinates) <= 20_000:
        raise ValueError("route needs 2–20,000 coordinates")
    points: list[Point] = []
    for raw in coordinates:
        p = point(raw)
        if not points or distance(points[-1], p) >= 0.01: points.append(p)
    if len(points) < 2: raise ValueError("route has no movement")
    finite(cruise_mps, 0.1, 60, "cruise_mps")
    finite(lateral_accel, 0.1, 5, "lateral_accel")
    finite(corner_cut_m, 0, 5, "corner_cut_m")
    dense = [Node(points[0], cruise_mps)]

    def line(end: Point, cap: float):
        start = dense[-1].coordinate
        n = max(1, math.ceil(distance(start, end)/spacing_m))
        if len(dense)+n > 200_000: raise ValueError("route geometry exceeds limit")
        dense.extend(Node(interpolate(start, end, j/n), cap) for j in range(1, n+1))

    for a, b, c in zip(points, points[1:], points[2:]):
        incoming, outgoing = bearing(a, b), bearing(b, c)
        signed = (outgoing-incoming+180) % 360-180
        theta = math.radians(abs(signed))
        if theta < math.radians(3):
            line(b, cruise_mps)
            continue
        if theta > math.radians(165) or corner_cut_m == 0:
            line(b, cruise_mps)
            dense[-1] = Node(b, 0.0)  # stop before an unrounded heading discontinuity
            continue
        tangent = math.tan(theta/2)
        radius = min(18.0, corner_cut_m/(1/math.cos(theta/2)-1),
                     0.45*min(distance(a, b), distance(b, c))/tangent)
        trim = radius*tangent
        first = destination(b, incoming+180, trim)
        last = destination(b, outgoing, trim)
        cap = min(cruise_mps, math.sqrt(lateral_accel*radius))
        line(first, cruise_mps)
        dense[-1] = Node(first, cap)
        sign = 1 if signed > 0 else -1
        centre = destination(first, incoming+sign*90, radius)
        start_angle = bearing(centre, first)
        n = max(3, math.ceil(radius*theta/min(spacing_m, 0.5)))
        for j in range(1, n+1):
            p = last if j == n else destination(centre, start_angle+signed*j/n, radius)
            dense.append(Node(p, cap))
    line(points[-1], cruise_mps)
    return Route(dense)
