"""Which roads are likely blocked, and which communities are possibly cut off.

Inputs are the detected landslides (output of the radar run), the areas the radar could not see, open road and
place data (OpenStreetMap) and a list of main towns ("hubs"). Everything is computed in a metric coordinate
system (EPSG:32617) and written back in lon/lat.

Road status (first rule that applies, per piece of road of at most `segment_m` metres) is purely geometric:
  blocked  a landslide within `blocked_m` of the road (about one pixel: it touches)
  at_risk  a landslide within `at_risk_m`
  unknown  at least `unknown_share` of the piece lies where the radar could not see
  clear    otherwise
On top of that geometry, every piece carries a confidence-aware `impact` that folds in the confidence of the
nearest candidate landslide, so a single-pass (low-confidence) candidate is never shown the same as one seen
in several passes:
  high_priority        a high-confidence candidate touches the road
  potentially_affected a medium-confidence candidate touches it, or a high-confidence one is within at_risk_m
  low_confidence       only a medium/low-confidence candidate is nearby
  no_evidence          no candidate within at_risk_m and the radar could see the road
  unknown              no candidate within at_risk_m but much of the road was not seen
Each piece also lists the sensitivity `scenarios` in which it counts as affected (strict = high-confidence
candidates only, balanced = high and medium, broad = every eligible candidate). `evidence` is the sentence the
app shows for the classification.

Community status: the road graph is cut at "blocked" pieces. A community is
  reachable  if it can still reach a hub,
  cut_off    if it could reach a hub on the full map but every such route crosses a blocked piece,
  unknown    if there is no mapped road within `far_m`, or its roads do not reach a hub even on the full map.
Every community also carries an `alternative_route` flag, a `confidence` for its status (from the confidence of
the blocking candidates and the number of independent routes) and, when it is cut off, the `crossing` roads
that separate it from a hub. The wording in the app is always "likely blocked" and "possibly cut off": nobody
saw the blockage.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import shapely
from pyproj import Transformer
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiLineString, Point, shape
from shapely.ops import substring

from .export import write_json

METRIC_CRS = "EPSG:32617"
ROAD_CLASSES = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "track"}
PLACE_CLASSES = {"city", "town", "village", "hamlet"}
REPORTED_PLACES = ["Arenas", "El Cacao", "Quebro"]       # places news reports said were cut off (for the sanity check)
NAME_MAX = 120

# Confidence-aware road impact. The order is the severity used when joining pieces into one road run.
IMPACTS = ("high_priority", "potentially_affected", "low_confidence", "no_evidence", "unknown")
SEVERITY = {name: i for i, name in enumerate(reversed(IMPACTS))}
# Sensitivity scenarios and the candidate confidences each one counts.
SCENARIOS = ("strict", "balanced", "broad")
SCENARIO_CONFIDENCE = {"strict": ("high",), "balanced": ("high", "medium"), "broad": ("high", "medium", "low")}
CONF_RANK = {"high": 3, "medium": 2, "low": 1}


class AccessError(Exception):
    """A problem with the inputs (never a crash trace for the user)."""


@dataclass(frozen=True)
class AccessParams:
    blocked_m: float = 10.0
    at_risk_m: float = 100.0
    unknown_share: float = 0.5
    segment_m: float = 500.0
    snap_m: float = 1.0
    far_m: float = 2000.0
    hub_snap_m: float = 3000.0

    @classmethod
    def from_config(cls, cfg: dict) -> "AccessParams":
        return cls(**{k: float(v) for k, v in cfg.get("access", {}).items() if k in cls.__dataclass_fields__})


@dataclass
class Way:
    osm_id: str | None
    name: str | None
    highway: str | None
    line: LineString                      # metric coordinates


@dataclass
class Piece:
    way: int                              # index of the way it belongs to
    order: int                            # position along the way
    line: LineString
    status: str = "clear"
    min_distance_m: float | None = None
    landslide_ids: tuple[str, ...] = ()
    impact: str = "no_evidence"
    evidence: str = ""
    scenarios: tuple[str, ...] = ()
    max_landslide_confidence: str | None = None   # strongest candidate confidence near this piece


# ---- reading inputs ----

def _clean_name(v) -> str | None:
    if not isinstance(v, str):
        return None
    v = " ".join(v.split())
    return v[:NAME_MAX] or None


def _osm_id(props: dict) -> str | None:
    for key in ("osm_id", "@id", "id"):
        v = props.get(key)
        if v not in (None, ""):
            return re.sub(r"^(way|node|relation)/", "", str(v))[:40]
    return None


def _projector(src: str, dst: str) -> Callable[[np.ndarray], np.ndarray]:
    t = Transformer.from_crs(src, dst, always_xy=True)

    def convert(coords: np.ndarray) -> np.ndarray:
        x, y = t.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    return convert


def read_ways(path: Path) -> list[Way]:
    """Road lines from a lon/lat GeoJSON file. Only drivable classes are kept; names are treated as plain text."""
    if not Path(path).is_file():
        raise AccessError(f"roads file not found: {path}")
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    to_metric = _projector("EPSG:4326", METRIC_CRS)
    ways: list[Way] = []
    for f in data.get("features", []):
        props = f.get("properties") or {}
        highway = props.get("highway")
        geom = f.get("geometry")
        if highway not in ROAD_CLASSES or not geom or geom.get("type") not in ("LineString", "MultiLineString"):
            continue
        g = shape(geom)
        for part in (g.geoms if isinstance(g, MultiLineString) else [g]):
            if len(part.coords) >= 2:
                line = shapely.transform(part, to_metric)
                if line.length > 0:
                    ways.append(Way(_osm_id(props), _clean_name(props.get("name")), highway, line))
    if not ways:
        raise AccessError("no usable roads in the roads file (expected OpenStreetMap lines with a 'highway' tag)")
    return ways


def _parse_population(v) -> int | None:
    digits = re.sub(r"[^0-9]", "", str(v)) if v not in (None, "") else ""
    return int(digits) if digits and len(digits) <= 9 else None


@dataclass
class Place:
    osm_id: str | None
    name: str
    place: str
    population: int | None
    xy: tuple[float, float]


def read_places(path: Path) -> list[Place]:
    if not Path(path).is_file():
        raise AccessError(f"places file not found: {path}")
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    to_metric = _projector("EPSG:4326", METRIC_CRS)
    places: list[Place] = []
    for f in data.get("features", []):
        props = f.get("properties") or {}
        name = _clean_name(props.get("name"))
        if props.get("place") not in PLACE_CLASSES or not name or not f.get("geometry"):
            continue
        p = shapely.transform(shape(f["geometry"]).representative_point(), to_metric)
        places.append(Place(_osm_id(props), name, props["place"], _parse_population(props.get("population")), (p.x, p.y)))
    return places


def read_polygons(path: Path, with_ids: bool = False):
    """Polygons from an output GeoJSON file, projected to metres. With ids: [(id, polygon)]."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    to_metric = _projector("EPSG:4326", METRIC_CRS)
    out = []
    for f in data["features"]:
        g = shapely.transform(shape(f["geometry"]), to_metric)
        out.append((str(f["properties"].get("id")), g) if with_ids else g)
    return out


def read_landslides(path: Path) -> list[tuple[str, object, dict]]:
    """Candidate landslides with their properties: [(id, polygon, props)]. The properties carry the
    confidence and area that the road impact step needs."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    to_metric = _projector("EPSG:4326", METRIC_CRS)
    out = []
    for f in data["features"]:
        props = f["properties"]
        out.append((str(props.get("id")), shapely.transform(shape(f["geometry"]), to_metric), props))
    return out


# ---- road pieces and their status ----

def split_ways(ways: list[Way], segment_m: float) -> list[Piece]:
    """Cut every way into equal pieces no longer than segment_m."""
    pieces: list[Piece] = []
    for wi, w in enumerate(ways):
        length = w.line.length
        n = max(1, math.ceil(length / segment_m))
        step = length / n
        for k in range(n):
            line = w.line if n == 1 else substring(w.line, k * step, (k + 1) * step if k < n - 1 else length)
            if isinstance(line, LineString) and line.length > 0:
                pieces.append(Piece(wi, k, line))
    return pieces


def _impact(distance: float, confidence: str | None, unseen: bool, params: AccessParams) -> str:
    """The confidence-aware impact of one piece, from the distance to the nearest candidate and that
    candidate's confidence. The only distances used are the documented blocked/at_risk limits."""
    if distance > params.at_risk_m:
        return "unknown" if unseen else "no_evidence"
    if distance <= params.blocked_m:
        if confidence == "high":
            return "high_priority"
        if confidence == "medium":
            return "potentially_affected"
        return "low_confidence"
    return "potentially_affected" if confidence == "high" else "low_confidence"


def _evidence(impact: str, lid: str | None, confidence: str | None, area: float | None,
              distance: float | None, params: AccessParams) -> str:
    """The sentence the app shows for a classification. It names the candidate and the distance it rests on."""
    if impact == "no_evidence":
        return f"No detected landslide candidate within {params.at_risk_m:g} m."
    if impact == "unknown":
        return "More than half of this road lies where the radar could not see, so impact is unknown."
    size = f"{area:,.0f} m²" if isinstance(area, (int, float)) else "unrecorded size"
    conf = (confidence or "unrecorded") + "-confidence"
    lid = lid or "a candidate"
    d = f"{distance:g} m"
    if impact == "high_priority":
        return f"High-confidence landslide {lid} ({size}) touches this road ({d} away)."
    if impact == "potentially_affected":
        if distance is not None and distance <= params.blocked_m:
            return f"{conf.capitalize()} landslide {lid} ({size}) touches this road ({d} away)."
        return f"High-confidence landslide {lid} ({size}) is {d} away."
    return f"{conf.capitalize()} landslide {lid} ({size}) is {d} away."


def classify_pieces(pieces: list[Piece], landslides: list[tuple[str, object, dict]], unknown: list,
                    params: AccessParams) -> None:
    """Set status, min_distance_m, landslide_ids and the confidence-aware impact on every piece (in place).

    `landslides` is [(id, polygon, properties)] as read by `read_landslides`; the properties carry the
    confidence and area used for the impact.
    """
    if not pieces:
        return
    lines = np.array([p.line for p in pieces], dtype=object)
    dmin = np.full(len(pieces), np.inf)
    ids: list[set[str]] = [set() for _ in pieces]
    near_conf: list[str | None] = [None] * len(pieces)
    near_id: list[str | None] = [None] * len(pieces)
    near_area: list[float | None] = [None] * len(pieces)
    scenarios: list[set[str]] = [set() for _ in pieces]
    if landslides:
        conf_by_id = {lid: props.get("confidence") for lid, _, props in landslides}
        tree = shapely.STRtree([g for _, g, _ in landslides])
        idx, dist = tree.query_nearest(lines, return_distance=True, all_matches=False)
        dmin[idx[0]] = dist
        for pi, li in zip(idx[0], idx[1]):
            near_id[pi], props = landslides[li][0], landslides[li][2]
            near_conf[pi] = props.get("confidence")
            area = props.get("area_m2")
            near_area[pi] = float(area) if isinstance(area, (int, float)) else None
        near = tree.query(lines, predicate="dwithin", distance=params.at_risk_m)
        for pi, li in zip(near[0], near[1]):
            ids[pi].add(landslides[li][0])
            conf = landslides[li][2].get("confidence")
            for scenario, allowed in SCENARIO_CONFIDENCE.items():
                if conf in allowed:
                    scenarios[pi].add(scenario)
    share = np.zeros(len(pieces))
    if unknown:
        utree = shapely.STRtree(unknown)
        pi, ui = utree.query(lines, predicate="intersects")
        if len(pi):
            inter = shapely.length(shapely.intersection(lines[pi], np.array(unknown, dtype=object)[ui]))
            np.add.at(share, pi, inter)
        share = share / np.maximum(shapely.length(lines), 1e-9)
    for i, p in enumerate(pieces):
        d = float(dmin[i])
        unseen = bool(share[i] >= params.unknown_share)
        if d <= params.blocked_m:
            p.status = "blocked"
        elif d <= params.at_risk_m:
            p.status = "at_risk"
        elif unseen:
            p.status = "unknown"
        else:
            p.status = "clear"
        # round up, so a rounded distance can never cross a limit that decided the status
        p.min_distance_m = None if math.isinf(d) else math.ceil(d * 10) / 10
        p.landslide_ids = tuple(sorted(ids[i]))
        p.scenarios = tuple(s for s in SCENARIOS if s in scenarios[i])
        p.max_landslide_confidence = max((conf_by_id[i] for i in p.landslide_ids), key=lambda c: CONF_RANK.get(c, 0),
                                         default=None) if landslides else None
        p.impact = _impact(d, near_conf[i], unseen, params)
        p.evidence = _evidence(p.impact, near_id[i], near_conf[i], near_area[i], p.min_distance_m, params)


def merge_runs(ways: list[Way], pieces: list[Piece]) -> list[dict]:
    """Join neighbouring pieces of one way that share a status into single lines. Returns lon/lat features."""
    to_lonlat = _projector(METRIC_CRS, "EPSG:4326")
    feats: list[dict] = []
    by_way: dict[int, list[Piece]] = {}
    for p in sorted(pieces, key=lambda p: (p.way, p.order)):
        by_way.setdefault(p.way, []).append(p)
    for wi, group in by_way.items():
        w = ways[wi]
        runs: list[list[Piece]] = []
        for p in group:
            if runs and runs[-1][-1].status == p.status:
                runs[-1].append(p)
            else:
                runs.append([p])
        for run in runs:
            coords = [c for p in run for c in (p.line.coords if p is run[0] else list(p.line.coords)[1:])]
            ll = to_lonlat(np.array(coords))
            dists = [p.min_distance_m for p in run if p.min_distance_m is not None]
            # the run keeps the most severe impact among its pieces and the union of their scenarios,
            # and explains itself with the sentence of that most severe piece
            worst = max(run, key=lambda p: SEVERITY.get(p.impact, 0))
            scenarios = [s for s in SCENARIOS if any(s in p.scenarios for p in run)]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[round(float(x), 6), round(float(y), 6)] for x, y in ll]},
                "properties": {
                    "osm_id": w.osm_id, "name": w.name, "highway": w.highway, "status": run[0].status,
                    "min_distance_m": min(dists) if dists else None,
                    "landslide_ids": ",".join(sorted({i for p in run for i in p.landslide_ids})),
                    "impact": worst.impact, "evidence": worst.evidence, "scenarios": ",".join(scenarios),
                },
            })
    return feats


# ---- road graph and community access ----

@dataclass
class Graph:
    keys: dict                            # snapped coordinates -> node number
    xy: np.ndarray                        # node coordinates (metres)
    full: np.ndarray                      # connected-component label of each node, all roads
    open: np.ndarray                      # the same with blocked pieces removed
    names: list                           # way name per way index (for naming a crossing stretch)
    blocked_edges: tuple                  # (u, v, way index) of the edges that cross a blocked piece
    way_confidence: list                  # strongest candidate confidence near each way (for the cut-off confidence)


def build_graph(ways: list[Way], pieces: list[Piece], params: AccessParams) -> Graph:
    """Nodes are road vertices snapped to snap_m; an edge joins neighbouring vertices of a way."""
    status = {(p.way, p.order): p.status for p in pieces}
    way_conf: list[str | None] = [None] * len(ways)
    for p in pieces:
        if p.max_landslide_confidence and CONF_RANK.get(p.max_landslide_confidence, 0) > CONF_RANK.get(way_conf[p.way], 0):
            way_conf[p.way] = p.max_landslide_confidence
    n_pieces = {}
    for p in pieces:
        n_pieces[p.way] = max(n_pieces.get(p.way, 0), p.order + 1)
    keys: dict = {}
    coords: list = []

    def node(x: float, y: float) -> int:
        k = (round(x / params.snap_m), round(y / params.snap_m))
        if k not in keys:
            keys[k] = len(coords)
            coords.append((k[0] * params.snap_m, k[1] * params.snap_m))
        return keys[k]

    u_all, v_all, u_open, v_open = [], [], [], []
    b_u, b_v, b_w = [], [], []
    for wi, w in enumerate(ways):
        pts = list(w.line.coords)
        length, n = w.line.length, n_pieces.get(wi, 1)
        step = length / n
        run = 0.0
        for a, b in zip(pts, pts[1:]):
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            first = min(int(run / step), n - 1)
            last = min(int(max(run + seg - 1e-9, run) / step), n - 1)
            run += seg
            ua, vb = node(*a[:2]), node(*b[:2])
            if ua == vb:
                continue
            u_all.append(ua)
            v_all.append(vb)
            # an edge can span several pieces (sparse map vertices): it is blocked if it crosses any blocked piece
            if any(status.get((wi, k)) == "blocked" for k in range(first, last + 1)):
                b_u.append(ua)
                b_v.append(vb)
                b_w.append(wi)
            else:
                u_open.append(ua)
                v_open.append(vb)
    count = len(coords)

    def labels(u, v) -> np.ndarray:
        m = coo_matrix((np.ones(len(u)), (u, v)), shape=(count, count))
        return connected_components(m, directed=False)[1]

    return Graph(keys, np.array(coords, dtype=float).reshape(-1, 2), labels(u_all, v_all), labels(u_open, v_open),
                 [w.name for w in ways], (np.array(b_u, dtype=int), np.array(b_v, dtype=int), np.array(b_w, dtype=int)),
                 way_conf)


@dataclass
class Hub:
    name: str
    xy: tuple[float, float]


@dataclass
class CommunityResult:
    place: Place
    status: str
    nearest_hub: str | None
    reason: str
    confidence: str = "low"               # evidence strength for the status
    alternative_route: str = "unknown"    # "yes" / "no" / "unknown": is there an open route to a hub?
    crossing: str = ""                    # the likely-blocked road name(s) that separate it from a hub


def _crossing_names(graph: Graph, node: int, hub_open: set[int]) -> list[str]:
    """The likely-blocked road names on the shortest route from `node`'s open component to a hub's open
    component, walking the blocked pieces through the full road graph. Several blocked pieces in a row (a
    whole stretch cut in more than one place) are all named, which a single-edge test would miss."""
    bu, bv, bw = graph.blocked_edges
    full_node = int(graph.full[node])
    mine = int(graph.open[node])
    # a small graph whose nodes are the open components and whose edges are the blocked pieces that join them
    adj: dict[int, list[tuple[int, int]]] = {}
    for u, v, w in zip(bu, bv, bw):
        if graph.full[u] != full_node or graph.full[v] != full_node:
            continue
        p, q = int(graph.open[u]), int(graph.open[v])
        if p == q:
            continue
        adj.setdefault(p, []).append((q, int(w)))
        adj.setdefault(q, []).append((p, int(w)))

    def bfs(starts) -> dict[int, int]:
        dist = {s: 0 for s in starts}
        frontier = list(starts)
        while frontier:
            nxt = []
            for n in frontier:
                for m, _ in adj.get(n, ()):
                    if m not in dist:
                        dist[m] = dist[n] + 1
                        nxt.append(m)
            frontier = nxt
        return dist

    to_mine = bfs([mine])
    hubs_here = [h for h in hub_open if h in to_mine]
    if not hubs_here:
        return []
    to_hub = bfs(hubs_here)
    shortest = min(to_mine[h] for h in hubs_here)
    names: set[str] = set()
    for u, v, w in zip(bu, bv, bw):
        p, q = int(graph.open[u]), int(graph.open[v])
        if p == q or p not in to_mine or q not in to_mine or p not in to_hub or q not in to_hub:
            continue
        if min(to_mine[p] + 1 + to_hub[q], to_mine[q] + 1 + to_hub[p]) == shortest:
            names.add(graph.names[w] or "unnamed road")
    return sorted(names)


def assess_communities(places: list[Place], hubs: list[Hub], graph: Graph, params: AccessParams) -> tuple[list[CommunityResult], list[str]]:
    """Status of every place. Returns (results, names of hubs that could not be placed on the road map)."""
    if len(graph.xy) == 0:
        raise AccessError("the road graph is empty")
    tree = cKDTree(graph.xy)
    usable: list[tuple[Hub, int]] = []
    skipped: list[str] = []
    for h in hubs:
        d, i = tree.query(h.xy)
        if d <= params.hub_snap_m:
            usable.append((h, int(i)))
        else:
            skipped.append(h.name)
    hub_open = {int(graph.open[n]) for _, n in usable}
    far_km = f"{params.far_m / 1000:g}"
    results: list[CommunityResult] = []
    for pl in places:
        d, i = tree.query(pl.xy)
        if d > params.far_m:
            results.append(CommunityResult(pl, "unknown", None, f"No mapped road within {far_km} km, so access is unknown.",
                                           "low", "unknown", ""))
            continue
        i = int(i)

        def nearest(candidates: list[tuple[Hub, int]]) -> str:
            return min(candidates, key=lambda hn: math.hypot(hn[0].xy[0] - pl.xy[0], hn[0].xy[1] - pl.xy[1]))[0].name

        on_map = [(h, n) for h, n in usable if graph.full[n] == graph.full[i]]
        if not on_map:
            results.append(CommunityResult(pl, "unknown", None, "Its mapped roads do not reach a town, so access is unknown.",
                                           "low", "unknown", ""))
            continue
        still = [(h, n) for h, n in usable if graph.open[n] == graph.open[i]]
        if still:
            hub = nearest(still)
            # two or more independent towns still on its open component: the status is hard to overturn
            conf = "high" if len({n for _, n in still}) >= 2 else "medium"
            results.append(CommunityResult(pl, "reachable", hub, f"A mapped road to {hub} has no likely-blocked stretch.",
                                           conf, "yes", ""))
        else:
            hub = nearest(on_map)
            crossing = _crossing_names(graph, i, hub_open)
            conf = "low"
            for name in crossing:
                for wi, wn in enumerate(graph.names):
                    if (wn or "unnamed road") == name:
                        conf = max(conf, graph.way_confidence[wi] or "low", key=lambda c: CONF_RANK.get(c, 0))
            reason = f"Every mapped road to {hub} crosses a likely-blocked stretch."
            if crossing:
                reason += f" The crossing stretch is on {', '.join(crossing)}."
            results.append(CommunityResult(pl, "cut_off", hub, reason, conf, "no", ", ".join(crossing)))
    return results, skipped


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c)).strip()


def reported_place_check(name: str, results: list[CommunityResult]) -> dict:
    """Find a place named in news reports among the assessed places: an exact name first, then names that contain
    it as a whole word (OpenStreetMap often says "La Loma de Quebro" where a report says "Quebro")."""
    target = _fold(name)
    exact = [r for r in results if _fold(r.place.name) == target]
    word = re.compile(r"\b" + re.escape(target) + r"\b")
    partial = [r for r in results if r not in exact and word.search(_fold(r.place.name))]
    found = exact + partial
    return {"name": name, "found_in_map": bool(found), "status": found[0].status if found else None,
            "matches": [{"name": r.place.name, "status": r.status} for r in found]}


def community_features(results: list[CommunityResult]) -> list[dict]:
    to_lonlat = _projector(METRIC_CRS, "EPSG:4326")
    feats = []
    for r in sorted(results, key=lambda r: (r.place.name, r.place.osm_id or "")):
        lon, lat = to_lonlat(np.array([r.place.xy]))[0]
        feats.append({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [round(float(lon), 6), round(float(lat), 6)]},
            "properties": {"osm_id": r.place.osm_id, "name": r.place.name, "place": r.place.place, "population": r.place.population,
                           "status": r.status, "nearest_hub": r.nearest_hub, "reason": r.reason,
                           "confidence": r.confidence, "alternative_route": r.alternative_route, "crossing": r.crossing},
        })
    return feats


# ---- the whole step ----

def run_access(cfg: dict, root: Path, out: Path | None = None, log: Callable[[str], None] = print) -> dict:
    """Read landslides and map data, write roads.geojson and communities.geojson, update stats.json."""
    root = Path(root)
    out = Path(out) if out else (root / cfg["out"]).resolve()
    params = AccessParams.from_config(cfg)
    stats_path = out / "stats.json"
    if not stats_path.is_file() or not (out / "landslides.geojson").is_file():
        raise AccessError("run the radar processing first: there are no landslides to join to the roads yet")
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    if stats.get("mock"):
        raise AccessError("the output folder holds mock data: run the radar processing first")

    ways = read_ways((root / cfg["roads"]).resolve())
    places = read_places((root / cfg["places"]).resolve())
    landslides = read_landslides(out / "landslides.geojson")
    unknown = read_polygons(out / "unknown.geojson") if (out / "unknown.geojson").is_file() else []
    log(f"{len(ways)} road lines, {len(places)} places, {len(landslides)} landslides")

    pieces = split_ways(ways, params.segment_m)
    classify_pieces(pieces, landslides, unknown, params)
    km = {s: 0.0 for s in ("blocked", "at_risk", "clear", "unknown")}
    for p in pieces:
        km[p.status] += p.line.length / 1000.0
    log("roads: " + ", ".join(f"{v:.1f} km {k}" for k, v in km.items()))

    graph = build_graph(ways, pieces, params)
    hubs = []
    for h in cfg["hubs"]:
        x, y = _projector("EPSG:4326", METRIC_CRS)(np.array([[h["lon"], h["lat"]]]))[0]
        hubs.append(Hub(h["name"], (float(x), float(y))))
    results, skipped = assess_communities(places, hubs, graph, params)
    counts = {s: sum(r.status == s for r in results) for s in ("cut_off", "reachable", "unknown")}
    log("communities: " + ", ".join(f"{v} {k}" for k, v in counts.items()))
    if skipped:
        log(f"warning: these towns are not on the road map (more than {params.hub_snap_m / 1000:g} km from any road): {', '.join(skipped)}")

    write_json(out / "roads.geojson", {"type": "FeatureCollection", "features": merge_runs(ways, pieces)}, compact=True)
    write_json(out / "communities.geojson", {"type": "FeatureCollection", "features": community_features(results)}, compact=True)
    stats["roads_blocked_km"] = round(km["blocked"], 2)
    stats["communities_cut_off"] = counts["cut_off"]
    write_json(stats_path, stats)

    reported = [reported_place_check(name, results) for name in cfg.get("reported_cut_off", REPORTED_PLACES)]
    return {"road_km": km, "communities": counts, "skipped_hubs": skipped, "reported_places": reported}
