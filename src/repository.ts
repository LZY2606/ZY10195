import type { DatabaseSync } from 'node:sqlite';
import type { DbFlipCandidate, DbObservation, DbStation, RunRow } from './db.js';
import type { FlipCandidate, Observation, RunRecord, Station } from './types.js';
import type { AdjustmentResult } from './types.js';

interface ActiveCandidateRow extends DbFlipCandidate {}

export function getStations(database: DatabaseSync): Station[] {
  const rows = database.prepare('SELECT id,name,x,y,z,locked FROM stations ORDER BY id').all() as unknown as DbStation[];
  return rows.map((row) => ({ ...row, locked: Boolean(row.locked) }));
}

export function getObservations(database: DatabaseSync): Observation[] {
  const rows = database.prepare(`
    SELECT o.id, o.from_station_id, o.to_station_id, o.slope_distance, o.azimuth_deg, o.inclination_deg,
           o.instrument_height, o.target_height, o.weight,
           CASE WHEN fc.active = 1 THEN fc.id ELSE NULL END AS flipped_candidate_id,
           fc.from_station_id AS candidate_from_station_id,
           fc.to_station_id AS candidate_to_station_id
      FROM observations o
      LEFT JOIN flip_candidates fc ON fc.original_observation_id = o.id
     ORDER BY o.id
  `).all() as unknown as Array<DbObservation & { flipped_candidate_id: string | null; candidate_from_station_id: string | null; candidate_to_station_id: string | null }>;
  return rows.map((row) => ({ ...row }));
}

export function getCandidates(database: DatabaseSync): FlipCandidate[] {
  const rows = database.prepare('SELECT id,original_observation_id,from_station_id,to_station_id,active,note FROM flip_candidates ORDER BY id').all() as unknown as DbFlipCandidate[];
  return rows.map((row) => ({ ...row, active: Boolean(row.active) }));
}

export function setStationLocked(database: DatabaseSync, id: string, locked: boolean): void {
  const result = database.prepare('UPDATE stations SET locked=? WHERE id=?').run(locked ? 1 : 0, id);
  if (result.changes !== 1) throw new Error(`站点不存在: ${id}`);
}

export function setObservationWeight(database: DatabaseSync, id: string, weight: number): void {
  if (!Number.isFinite(weight) || weight < 0) throw new Error('权重必须是非负有限数');
  const result = database.prepare('UPDATE observations SET weight=? WHERE id=?').run(weight, id);
  if (result.changes !== 1) throw new Error(`观测不存在: ${id}`);
}

export function setCandidateActive(database: DatabaseSync, id: string, active: boolean): void {
  const result = database.prepare('UPDATE flip_candidates SET active=? WHERE id=?').run(active ? 1 : 0, id);
  if (result.changes !== 1) throw new Error(`翻转候选不存在: ${id}`);
}

export function createCandidate(database: DatabaseSync, originalObservationId: string, active = true): FlipCandidate {
  const observation = database.prepare('SELECT * FROM observations WHERE id=?').get(originalObservationId) as DbObservation | undefined;
  if (!observation) throw new Error(`观测不存在: ${originalObservationId}`);
  const existing = database.prepare('SELECT * FROM flip_candidates WHERE original_observation_id=?').get(originalObservationId) as DbFlipCandidate | undefined;
  if (existing) {
    setCandidateActive(database, existing.id, active);
    return { ...existing, active };
  }
  const id = `flip-${originalObservationId}`;
  const note = '用户新增候选：只交换端点标签，原观测值和原往返行均保留。';
  database.prepare('INSERT INTO flip_candidates (id,original_observation_id,from_station_id,to_station_id,active,note) VALUES (?,?,?,?,?,?)')
    .run(id, originalObservationId, observation.to_station_id, observation.from_station_id, active ? 1 : 0, note);
  return {
    id,
    original_observation_id: originalObservationId,
    from_station_id: observation.to_station_id,
    to_station_id: observation.from_station_id,
    active,
    note,
  };
}

export function saveRun(
  database: DatabaseSync,
  action: string,
  result: AdjustmentResult
): RunRecord {
  const locks = Object.fromEntries(getStations(database).map((station) => [station.id, station.locked]));
  const weights = Object.fromEntries((database.prepare('SELECT id, weight FROM observations').all() as Array<{ id: string; weight: number }>).map((row) => [row.id, row.weight]));
  const candidates = (database.prepare('SELECT id FROM flip_candidates WHERE active=1').all() as Array<{ id: string }>).map((row) => row.id);
  const run = database.prepare('INSERT INTO run_records (action, lock_json, weight_json, candidate_json, result_json) VALUES (?,?,?,?,?)')
    .run(action, JSON.stringify(locks), JSON.stringify(weights), JSON.stringify(candidates), JSON.stringify(result));
  return getRun(database, Number(run.lastInsertRowid));
}

export function getRun(database: DatabaseSync, id: number): RunRecord {
  const row = database.prepare('SELECT * FROM run_records WHERE id=?').get(id) as unknown as RunRow | undefined;
  if (!row) throw new Error(`运行记录不存在: ${id}`);
  return {
    id: row.id,
    created_at: row.created_at,
    action: row.action,
    lock_snapshot: JSON.parse(row.lock_json),
    weight_snapshot: JSON.parse(row.weight_json),
    active_candidate_snapshot: JSON.parse(row.candidate_json),
    result: JSON.parse(row.result_json),
  };
}

export function listRuns(database: DatabaseSync): RunRecord[] {
  const rows = database.prepare('SELECT id FROM run_records ORDER BY id DESC').all() as Array<{ id: number }>;
  return rows.map((row) => getRun(database, row.id));
}
