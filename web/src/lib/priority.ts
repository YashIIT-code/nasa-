// Explainable, configurable priority scoring for field inspection.
//
// A score orders a worklist: it is NOT a probability of a landslide, a road blockage or a disaster, and it
// is not a prediction. Every item carries the reasons it scored what it did, and the weights are plain
// numbers you can change. High scores mean "check this first", nothing more.
//
//   Road stretches:  candidate evidence (the confidence-aware impact), the road class, and the length of
//                    the stretch. Stretches with no candidate nearby are left out: there is nothing to see.
//   Communities:     being possibly cut off, the evidence behind that, and the population that would be
//                    affected. Reachable communities are left out.
import { C } from './content.ts';
import { representativePoint } from './geo.ts';
import { geometryLengthKm } from './lists.ts';
import type {
  Communities, CommunityProps, CommunityStatus, Confidence, RoadImpact, RoadProps, Roads,
} from './types.ts';

export interface PriorityWeights {
  /** strength of the candidate evidence (impact category, or the confidence behind a status) */
  evidence: number;
  /** how important the feature is (road class, or a community being cut off) */
  importance: number;
  /** how much is involved (length of road, or population) */
  extent: number;
}

/** Evidence first, then road class, then length. Tune these to reorder the worklist. */
export const DEFAULT_ROAD_WEIGHTS: PriorityWeights = { evidence: 0.6, importance: 0.25, extent: 0.15 };
/** Isolation first, then the evidence behind it, then population. */
export const DEFAULT_COMMUNITY_WEIGHTS: PriorityWeights = { evidence: 0.3, importance: 0.45, extent: 0.25 };

const IMPACT: Record<RoadImpact, number> = {
  high_priority: 1, potentially_affected: 0.6, low_confidence: 0.3, unknown: 0.1, no_evidence: 0,
};
const ROAD_CLASS: Record<string, number> = {
  motorway: 1, trunk: 0.95, primary: 0.85, secondary: 0.7, tertiary: 0.5,
  unclassified: 0.35, residential: 0.3, living_street: 0.25, service: 0.15, track: 0.1,
};
const COMMUNITY_STATUS: Record<CommunityStatus, number> = { cut_off: 1, unknown: 0.4, reachable: 0 };
const CONFIDENCE: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.3 };

const STRETCH_FULL_KM = 0.5; // road pieces are cut to 500 m, so this is the top of the range
const PEOPLE_FULL = 5000;

type RoadClass = 'major' | 'medium' | 'minor';
type Stretch = 'long' | 'medium' | 'short';
type People = 'many' | 'some' | 'unknown';

/** One worklist entry. `kind` and `props` are paired, so the map can be asked to show it as-is. */
export type PriorityItem =
  | { kind: 'road'; id: string; name: string; score: number; notes: string[]; lngLat: [number, number]; props: RoadProps }
  | { kind: 'community'; id: string; name: string; score: number; notes: string[]; lngLat: [number, number]; props: CommunityProps };

const round1 = (x: number) => Math.round(x * 10) / 10;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Weighted mean of the three 0..1 factors, as a 0..100 score. Weights need not sum to 1. */
export function priorityScore(evidence: number, importance: number, extent: number, w: PriorityWeights): number {
  const sum = w.evidence + w.importance + w.extent;
  if (sum <= 0) return 0;
  const v = (w.evidence * clamp01(evidence) + w.importance * clamp01(importance) + w.extent * clamp01(extent)) / sum;
  return round1(100 * v);
}

function roadClassOf(highway: string | null): RoadClass {
  if (!highway) return 'minor';
  if (highway === 'motorway' || highway === 'trunk' || highway === 'primary') return 'major';
  if (highway === 'secondary' || highway === 'tertiary') return 'medium';
  return 'minor';
}

function stretchOf(km: number): Stretch {
  if (km >= 0.35) return 'long';
  if (km >= 0.15) return 'medium';
  return 'short';
}

function peopleOf(population: number | null): People {
  if (population === null) return 'unknown';
  return population >= 1000 ? 'many' : 'some';
}

/** Road stretches worth a look, strongest first. Stretches with no candidate nearby are left out. */
export function priorityRoads(roads: Roads, weights: PriorityWeights = DEFAULT_ROAD_WEIGHTS): PriorityItem[] {
  const items: PriorityItem[] = [];
  roads.features.forEach((f, i) => {
    const p = f.properties;
    if (p.impact === 'no_evidence') return;
    const km = geometryLengthKm(f.geometry);
    const cls = roadClassOf(p.highway);
    const stretch = stretchOf(km);
    items.push({
      kind: 'road',
      id: `${p.osm_id ?? 'unnamed'}#${i}`,
      name: p.name ?? C.popups.road.unnamed,
      score: priorityScore(IMPACT[p.impact], ROAD_CLASS[p.highway ?? ''] ?? 0.3, clamp01(km / STRETCH_FULL_KM), weights),
      notes: [C.priority.notes.impact[p.impact], C.priority.notes.roadClass[cls], C.priority.notes.stretch[stretch]],
      lngLat: representativePoint(f.geometry),
      props: p,
    });
  });
  return items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Communities worth checking, strongest first. Reachable communities are left out. */
export function priorityCommunities(communities: Communities, weights: PriorityWeights = DEFAULT_COMMUNITY_WEIGHTS): PriorityItem[] {
  const items: PriorityItem[] = [];
  communities.features.forEach((f, i) => {
    const p = f.properties;
    if (p.status === 'reachable') return;
    const people = peopleOf(p.population);
    const extent = people === 'many' ? clamp01((p.population ?? 0) / PEOPLE_FULL) : people === 'some' ? 0.4 : 0.3;
    items.push({
      kind: 'community',
      id: `${p.osm_id ?? 'unnamed'}#${i}`,
      name: p.name,
      score: priorityScore(CONFIDENCE[p.confidence], COMMUNITY_STATUS[p.status], extent, weights),
      notes: [C.priority.notes.status[p.status], C.priority.notes.confidence[p.confidence], C.priority.notes.people[people]],
      lngLat: f.geometry.coordinates,
      props: p,
    });
  });
  return items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
