import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjustNetwork } from '../src/adjustment.ts';
import { wrapAngleDeg } from '../src/geometry.ts';
import type { FixtureData } from '../src/db.ts';
import type { Observation, Station } from '../src/types.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'fixture.json'), 'utf8')) as FixtureData;

function observations(activeFlip: boolean): Observation[] {
  return fixture.observations.map((observation) => ({
    ...observation,
    flipped_candidate_id: activeFlip && observation.id === 'obs-da-1' ? 'flip-da-1' : null,
    ...(activeFlip && observation.id === 'obs-da-1' ? { candidate_from_station_id: 'A', candidate_to_station_id: 'D' } : {}),
  }));
}

const stations: Station[] = fixture.stations.map((station) => ({ ...station }));

test('fixed fixture has one independent ring, one isolated component, and distinct duplicate-name stations', () => {
  const result = adjustNetwork(stations, observations(false));
  assert.equal(result.summary.independent_ring_count, 1);
  assert.equal(result.summary.components.length, 2);
  assert.deepEqual(result.summary.duplicate_names, [{ name: '同名点', station_ids: ['D', 'F'] }]);
  assert.equal(result.summary.reciprocal_pair_count, 1);
  assert.equal(result.loops[0].station_ids.join(','), 'A,B,C,D');
  assert.ok(result.loops[0].raw_3d > 1);
  assert.deepEqual(result.loops[0].adjusted_misclosure, [0, 0, 0]);
});

test('azimuth residual wraps across zero without a nearly full-circle error', () => {
  assert.equal(Math.round(wrapAngleDeg(359.9 - 0.1) * 10) / 10, -0.2);
  assert.equal(Math.round(wrapAngleDeg(0.1 - 359.9) * 10) / 10, 0.2);
});

test('flip candidate repairs the suspected edge while original reciprocal observations remain two rows', () => {
  const wrong = adjustNetwork(stations, observations(false));
  const fixed = adjustNetwork(stations, observations(true));
  const wrongBad = wrong.residuals.filter((row) => row.observation_id === 'obs-da-1');
  const fixedBad = fixed.residuals.filter((row) => row.observation_id === 'obs-da-1');
  assert.ok(Math.max(...wrongBad.map((row) => Math.abs(row.residual ?? 0))) > 20);
  assert.ok(Math.max(...fixedBad.map((row) => Math.abs(row.residual ?? 0))) < 0.01);
  assert.ok(fixed.loops[0].raw_3d < wrong.loops[0].raw_3d / 100);
  assert.equal(fixed.summary.reciprocal_pair_count, 1);
  assert.deepEqual(fixed.reciprocalChecks[0].forward_observation_id, 'obs-ab-1');
  assert.deepEqual(fixed.reciprocalChecks[0].reverse_observation_id, 'obs-ba-1');
  assert.ok(fixedBad.every((row) => row.active_source === 'flip_candidate'));
  assert.equal(fixture.observations.filter((observation) => observation.from_station_id === 'D' && observation.to_station_id === 'A').length, 1);
});

test('azimuth-only isolated subgraph reports identifiable rank and five unidentifiable degrees of freedom', () => {
  const result = adjustNetwork(stations, observations(false));
  assert.equal(result.diagnostics.nullity, 5);
  assert.equal(result.rankDefects.filter((defect) => defect.kind.startsWith('translation')).length, 3);
  assert.equal(result.rankDefects.filter((defect) => defect.kind === 'radialScale').length, 2);
  assert.deepEqual([...new Set(result.rankDefects.flatMap((defect) => defect.station_ids))].sort(), ['F', 'G', 'H']);
  for (const coordinate of result.coordinates.filter((item) => 'FGH'.includes(item.station_id))) {
    assert.equal(coordinate.ellipsoid.rank_deficient, true);
    assert.equal(coordinate.ellipsoid.rank, 0);
  }
});
