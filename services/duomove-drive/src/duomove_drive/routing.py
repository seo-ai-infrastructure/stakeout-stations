"""Bounded OSRM requests to an operator-configured HTTPS origin."""
from __future__ import annotations

import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from .geometry import point


def geojson_coordinates(document: dict) -> list[tuple[float, float]]:
    if document.get("type") == "Feature": document = document["geometry"]
    if document.get("type") != "LineString": raise ValueError("expected a GeoJSON LineString or Feature")
    raw = document.get("coordinates")
    if not isinstance(raw, list) or not 2 <= len(raw) <= 20_000: raise ValueError("invalid route geometry")
    result = []
    for p in raw:
        if not isinstance(p, list) or len(p) < 2: raise ValueError("invalid GeoJSON coordinate")
        result.append(point((p[1], p[0])))
    return result


def fetch_route(start, end, *, base_url: str, timeout: float = 10.0) -> list[tuple[float,float]]:
    a, b = point(start), point(end)
    url = urlsplit(base_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("OSRM base must be an HTTPS origin/path without credentials or query")
    suffix = f"/route/v1/driving/{a[1]},{a[0]};{b[1]},{b[0]}?"+urlencode({"overview":"full","geometries":"geojson","steps":"true"})
    request = Request(base_url.rstrip("/")+suffix, headers={"User-Agent":"DuoMove-Drive/1.0","Accept":"application/json"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=timeout) as response:
                # urllib follows redirects; require the same HTTPS host after it.
                actual = urlsplit(response.geturl())
                if actual.scheme != "https" or actual.netloc != url.netloc:
                    raise ValueError("unexpected routing redirect")
                raw = response.read(4_000_001)
            if len(raw) > 4_000_000: raise ValueError("routing response too large")
            data = json.loads(raw)
            if data.get("code") != "Ok" or not data.get("routes"): raise ValueError("OSRM returned no usable route")
            return geojson_coordinates(data["routes"][0]["geometry"])
        except HTTPError as exc:
            if exc.code not in (429, 502, 503, 504) or attempt == 2:
                raise RuntimeError("routing provider request failed") from None
            retry = exc.headers.get("Retry-After", "")
            delay = min(10.0, max(0.5, float(retry))) if retry.isdecimal() else 0.5*2**attempt
        except (URLError, TimeoutError):
            if attempt == 2: raise RuntimeError("routing provider unavailable") from None
            delay = 0.5*2**attempt
        time.sleep(delay)
    raise RuntimeError("routing provider unavailable")
