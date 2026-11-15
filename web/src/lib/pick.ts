// Turns the properties MapLibre returns for a clicked feature into the typed objects the app uses.
// MapLibre may drop null properties, so missing values are read as null.
import type { Picked } from './AppState.tsx';
import type {
  AlternativeRoute, CommunityProps, Confidence, LandslideProps, RoadImpact, RoadProps,
} from './types.ts';

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A required text field that MapLibre may drop: the file contract says it is a string, so an empty one is used. */
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// The allowed values come from the file contract (types.ts), so a value the contract does not define can never
// reach the app. Where the contract has an "unknown" member that is the fallback; confidence has none, so the
// weakest claim ("low") is used rather than inventing strength.
const ROAD_IMPACTS: readonly RoadImpact[] = ['high_priority', 'potentially_affected', 'low_confidence', 'no_evidence', 'unknown'];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];
const ROUTES: readonly AlternativeRoute[] = ['yes', 'no', 'unknown'];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export const LAYER_KIND: Record<string, Picked['kind']> = {
  landslides: 'landslide',
  roads: 'road',
  'roads-blocked': 'road',
  'roads-risk': 'road',
  communities: 'community',
};

export function toPicked(layerId: string, p: Raw, lngLat: [number, number]): Picked | null {
  switch (LAYER_KIND[layerId]) {
    case 'landslide':
      return {
        kind: 'landslide', lngLat,
        props: {
          id: String(p.id ?? ''), area_m2: Number(p.area_m2), hv_before_db: Number(p.hv_before_db), hv_after_db: Number(p.hv_after_db),
          dhv_db: Number(p.dhv_db), slope_deg: Number(p.slope_deg), pairs_seen: Number(p.pairs_seen), pairs_visible: Number(p.pairs_visible),
          confidence: p.confidence as LandslideProps['confidence'],
        },
      };
    case 'road':
      return {
        kind: 'road', lngLat,
        props: {
          osm_id: str(p.osm_id), name: str(p.name), highway: str(p.highway), status: p.status as RoadProps['status'],
          min_distance_m: num(p.min_distance_m), landslide_ids: text(p.landslide_ids),
          impact: oneOf(p.impact, ROAD_IMPACTS, 'unknown'),
          evidence: text(p.evidence), scenarios: text(p.scenarios),
        },
      };
    case 'community':
      return {
        kind: 'community', lngLat,
        props: {
          osm_id: str(p.osm_id), name: String(p.name ?? ''), place: String(p.place ?? ''), population: num(p.population),
          status: p.status as CommunityProps['status'], nearest_hub: str(p.nearest_hub), reason: String(p.reason ?? ''),
          confidence: oneOf(p.confidence, CONFIDENCES, 'low'),
          alternative_route: oneOf(p.alternative_route, ROUTES, 'unknown'),
          crossing: text(p.crossing),
        },
      };
    default:
      return null;
  }
}
