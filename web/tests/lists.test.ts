import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterLandslides, geometryLengthKm, groupCommunities, haversineKm, roadKmByStatus, sortLandslides,
} from '../src/lib/lists.ts';
import type { Communities, CommunityProps, Confidence, Landslides, RoadProps, Roads } from '../src/lib/types.ts';

const slide = (id: string, area: number, seen: number, confidence: Confidence) => ({
  type: 'Feature' as const,
  geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
  properties: { id, area_m2: area, hv_before_db: -12, hv_after_db: -18, dhv_db: -6, slope_deg: 20, pairs_seen: seen, pairs_visible: 4, confidence },
});
const FEATURES: Landslides['features'] = [
  slide('L0001', 100, 2, 'medium'), slide('L0002', 500, 1, 'low'), slide('L0003', 300, 4, 'high'), slide('L0004', 300, 3, 'high'),
];

/** A road in the file contract: nullable fields are null, the confidence-aware fields take the contract's weakest value. */
const road = (status: RoadProps['status'], lat: number, extra: Partial<RoadProps> = {}) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates: [[-80, lat], [-80, lat + 1]] },
  properties: {
    osm_id: null, name: null, highway: null, status, min_distance_m: null, landslide_ids: '',
    impact: 'unknown' as const, evidence: '', scenarios: '', ...extra,
  },
});

/** A community in the file contract: nullable fields are null, the confidence-aware fields take the contract's weakest value. */
const community = (name: string, status: CommunityProps['status'], extra: Partial<CommunityProps> = {}) => ({
  type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] as [number, number] },
  properties: {
    osm_id: null, name, place: 'village', population: null, status, nearest_hub: null, reason: '',
    confidence: 'low' as const, alternative_route: 'unknown' as const, crossing: '', ...extra,
  },
});

test('confidence filter keeps the chosen level and above', () => {
  assert.equal(filterLandslides(FEATURES, 'all').length, 4);
  assert.deepEqual(filterLandslides(FEATURES, 'medium').map((f) => f.properties.id), ['L0001', 'L0003', 'L0004']);
  assert.deepEqual(filterLandslides(FEATURES, 'high').map((f) => f.properties.id), ['L0003', 'L0004']);
});

test('sorting by size, confidence and passes', () => {
  const ids = (key: 'size' | 'confidence' | 'passes') => sortLandslides(FEATURES, key).map((f) => f.properties.id);
  assert.deepEqual(ids('size'), ['L0002', 'L0003', 'L0004', 'L0001']);          // ties broken by id
  assert.deepEqual(ids('confidence'), ['L0003', 'L0004', 'L0001', 'L0002']);
  assert.deepEqual(ids('passes'), ['L0003', 'L0004', 'L0001', 'L0002']);
});

test('sorting does not change the input', () => {
  const copy = JSON.stringify(FEATURES);
  sortLandslides(FEATURES, 'size');
  assert.equal(JSON.stringify(FEATURES), copy);
});

test('distance: one degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(haversineKm([-80, 7], [-80, 8]) - 111.19) < 0.1);
  assert.equal(haversineKm([-80, 7], [-80, 7]), 0);
});

test('line lengths add up over segments and multi-lines', () => {
  const one = geometryLengthKm({ type: 'LineString', coordinates: [[-80, 7], [-80, 7.5], [-80, 8]] });
  assert.ok(Math.abs(one - 111.19) < 0.1);
  const multi = geometryLengthKm({ type: 'MultiLineString', coordinates: [[[-80, 7], [-80, 8]], [[-81, 7], [-81, 8]]] });
  assert.ok(Math.abs(multi - 2 * 111.19) < 0.2);
});

test('road kilometres are summed per status', () => {
  const roads: Roads = { type: 'FeatureCollection', features: [road('blocked', 0), road('blocked', 2), road('clear', 4)] };
  const km = roadKmByStatus(roads);
  assert.ok(Math.abs(km.blocked - 2 * 111.19) < 0.3 && Math.abs(km.clear - 111.19) < 0.2);
  assert.equal(km.at_risk, 0);
  assert.deepEqual(roadKmByStatus({ type: 'FeatureCollection', features: [] }), { blocked: 0, at_risk: 0, clear: 0, unknown: 0 });
});

test('communities are grouped by status and sorted by name', () => {
  const fc: Communities = { type: 'FeatureCollection', features: [community('B', 'cut_off'), community('A', 'cut_off'), community('C', 'reachable')] };
  const g = groupCommunities(fc);
  assert.deepEqual(g.cut_off.map((f) => f.properties.name), ['A', 'B']);
  assert.equal(g.reachable.length, 1);
  assert.equal(g.unknown.length, 0);
});

test('road properties keep nulls and carry the confidence-aware fields', () => {
  const bare = road('unknown', 0);
  assert.equal(bare.properties.osm_id, null);
  assert.equal(bare.properties.name, null);
  assert.equal(bare.properties.highway, null);
  assert.equal(bare.properties.min_distance_m, null);
  assert.equal(bare.properties.impact, 'unknown');
  assert.equal(bare.properties.evidence, '');
  assert.equal(bare.properties.scenarios, '');

  const filled = road('blocked', 0, {
    osm_id: 'way/1', name: 'Main St', highway: 'primary', min_distance_m: 5, landslide_ids: 'L0001',
    impact: 'high_priority', evidence: 'A candidate landslide lies within 10 m of this stretch.', scenarios: 'balanced,broad',
  });
  assert.equal(filled.properties.osm_id, 'way/1');
  assert.equal(filled.properties.highway, 'primary');
  assert.equal(filled.properties.impact, 'high_priority');
  assert.equal(filled.properties.evidence, 'A candidate landslide lies within 10 m of this stretch.');
  assert.deepEqual(filled.properties.scenarios.split(','), ['balanced', 'broad']);
});

test('community properties keep nulls and carry the confidence-aware fields', () => {
  const bare = community('Far', 'unknown');
  assert.equal(bare.properties.osm_id, null);
  assert.equal(bare.properties.population, null);
  assert.equal(bare.properties.nearest_hub, null);
  assert.equal(bare.properties.confidence, 'low');
  assert.equal(bare.properties.alternative_route, 'unknown');
  assert.equal(bare.properties.crossing, '');

  const filled = community('Cut', 'cut_off', {
    osm_id: 'node/42', population: 2000, nearest_hub: 'Chitré', reason: 'Every mapped route to a town is likely blocked.',
    confidence: 'high', alternative_route: 'no', crossing: 'Main St',
  });
  assert.equal(filled.properties.population, 2000);
  assert.equal(filled.properties.nearest_hub, 'Chitré');
  assert.equal(filled.properties.confidence, 'high');
  assert.equal(filled.properties.alternative_route, 'no');
  assert.equal(filled.properties.crossing, 'Main St');
  assert.equal(filled.properties.reason, 'Every mapped route to a town is likely blocked.');
});
