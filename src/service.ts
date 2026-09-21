import type { DatabaseSync } from 'node:sqlite';
import type {} from './db.js';
import { getCandidates, getObservations, getStations, listRuns, saveRun, setCandidateActive, setObservationWeight, setStationLocked, createCandidate } from './repository.js';
import { adjustNetwork } from './adjustment.js';
import type { AdjustmentResult, RunRecord } from './types.js';

export function currentResult(database: DatabaseSync): AdjustmentResult {
  return adjustNetwork(getStations(database), getObservations(database));
}

export function recomputeAndRecord(database: DatabaseSync, action: string): { result: AdjustmentResult; run: RunRecord } {
  const result = currentResult(database);
  const run = saveRun(database, action, result);
  return { result, run };
}

export function toggleLock(database: DatabaseSync, stationId: string, locked: boolean): RunRecord {
  setStationLocked(database, stationId, locked);
  return recomputeAndRecord(database, locked ? `锁定 ${stationId}` : `解锁 ${stationId}`).run;
}

export function changeWeight(database: DatabaseSync, observationId: string, weight: number): RunRecord {
  setObservationWeight(database, observationId, weight);
  return recomputeAndRecord(database, `更新 ${observationId} 权重为 ${weight}`).run;
}

export function toggleFlip(database: DatabaseSync, candidateId: string, active: boolean): RunRecord {
  setCandidateActive(database, candidateId, active);
  return recomputeAndRecord(database, `${active ? '启用' : '停用'}翻转候选 ${candidateId}`).run;
}

export function addFlip(database: DatabaseSync, observationId: string, active: boolean): RunRecord {
  createCandidate(database, observationId, active);
  return recomputeAndRecord(database, `为 ${observationId} 创建${active ? '并启用' : ''}翻转候选`).run;
}

export function runs(database: DatabaseSync): RunRecord[] {
  return listRuns(database);
}

export { getStations, getObservations, getCandidates };
