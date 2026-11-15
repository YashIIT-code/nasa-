// The inspection worklist: a configurable weighted mean that orders a list, never a probability.
import assert from 'node:assert/strict';
import test from 'node:test';
import { C } from '../src/lib/content.ts';
import {
  DEFAULT_COMMUNITY_WEIGHTS, DEFAULT_ROAD_WEIGHTS, priorityCommunities, priorityRoads, priorityScore,
} from '../src/lib/priority.ts';
import type { Communities, RoadProps, Roads } from '../src/lib/types.ts';

test('the score is a weighted mean of the three factors, as 0..100', () => {
  assert.equal(priorityScore(1, 1, 1, DEFAULT_ROAD_WEIGHTS), 100);
  assert.equal(priorityScore(0, 0, 0, DEFAULT_ROAD_WEIGHTS), 0);
  // weights need not sum to one: only their ratios matter
  assert.equal(priorityScore(1, 0, 0, { evidence: 2, importance: 2, extent: 0 }), 50);
  // factors are clamped to 0..1 before they are combined
  assert.equal(priorityScore(5, -1, 0, { evidence: 1, importance: 1, extent: 1 }), 33.3);
  // all-zero weights cannot divide: the score is 0, never NaN
  assert.equal(priorityScore(1, 1, 1, { evidence: 0, importance: 0, extent: 0 }), 0);
});

const road = (id: string, impact: RoadProps['impact'], highway: string): Roads['features'][number] => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[-80, 7], [-80, 7.4]] },
  properties: {
    osm_id: id, name: null, highway, status: 'blocked', min_distance_m: 5, landslide_ids: 'L0001',
    impact, evidence: 'sentence', scenarios: 'balanced,broad',
  },
});

test('road worklist: strongest first, and stretches with nothing nearby are left out', () => {
  const roads: Roads = {
    type: 'FeatureCollection',
    features: [
      road('r-c', 'low_confidence', 'track'),
      road('r-a', 'high_priority', 'primary'),
      road('r-none', 'no_evidence', 'motorway'), // not a lead: dropped even though it is a main road
      road('r-b', 'potentially_affected', 'tertiary'),
    ],
  };
  const items = priorityRoads(roads);
  assert.deepEqual(items.map((i) => i.id), ['r-a#1', 'r-b#3', 'r-c#0']);
  for (const it of items) {
    assert.ok(it.score >= 0 && it.score <= 100, 'score is on a 0..100 scale');
    assert.equal(it.notes.length, 3, 'impact, road class and stretch are each explained');
    assert.equal(it.kind, 'road');
  }
  assert.ok(items[0].notes.includes(C.priority.notes.roadClass.major));
});

test('road worklist: changing the weights changes the order', () => {
  const roads: Roads = {
    type: 'FeatureCollection',
    features: [road('r-evidence', 'high_priority', 'track'), road('r-importance', 'low_confidence', 'motorway')],
  };
  const byEvidence = priorityRoads(roads, { evidence: 1, importance: 0, extent: 0 });
  assert.equal(byEvidence[0].id, 'r-evidence#0');
  const byImportance = priorityRoads(roads, { evidence: 0, importance: 1, extent: 0 });
  assert.equal(byImportance[0].id, 'r-importance#1');
});

const community = (
  name: string,
  status: Communities['features'][number]['properties']['status'],
  confidence: Communities['features'][number]['properties']['confidence'],
  population: number | null,
): Communities['features'][number] => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-80, 7] },
  properties: {
    osm_id: name, name, place: 'village', population, status, nearest_hub: 'Chitré', reason: 'sentence',
    confidence, alternative_route: 'no', crossing: 'Main St',
  },
});

test('community worklist: reachable places are left out, and each score is explained', () => {
  const communities: Communities = {
    type: 'FeatureCollection',
    features: [
      community('Far', 'unknown', 'low', 50),
      community('Town', 'reachable', 'high', 9000), // a route stays open: nothing to inspect
      community('Cut', 'cut_off', 'high', 2000),
    ],
  };
  const items = priorityCommunities(communities);
  assert.deepEqual(items.map((i) => i.name), ['Cut', 'Far']);
  assert.ok(items[0].notes.includes(C.priority.notes.status.cut_off));
  for (const it of items) {
    assert.equal(it.kind, 'community');
    assert.equal(it.notes.length, 3);
    assert.ok(it.score >= 0 && it.score <= 100);
  }
});

test('wording: the worklist is never called a probability', () => {
  assert.match(C.priority.intro, /not a probability/);
  assert.match(C.priority.methodNote, /not a probability/);
  assert.match(C.priority.intro, /check first/);
  assert.ok(DEFAULT_ROAD_WEIGHTS.evidence > 0 && DEFAULT_COMMUNITY_WEIGHTS.importance > 0);
});
