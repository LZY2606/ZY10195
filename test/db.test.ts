import { describe, expect, it } from 'vitest';
import {
  ensureFixture, getRun, importFixture, listRuns, loadObservations, loadStations,
  openDb, saveRun, setObservationFlipped, setObservationWeight, setStationLocked,
} from '../src/db.ts';
import { adjustNetwork } from '../src/adjust.ts';

describe('SQLite 持久化', () => {
  it('导入算例、修改候选状态、清空后重新导入', () => {
    const db = openDb(':memory:');
    ensureFixture(db);
    expect(loadStations(db)).toHaveLength(7);
    expect(loadObservations(db)).toHaveLength(7);

    setObservationFlipped(db, 'o5', true);
    setObservationWeight(db, 'o1', 2.5);
    setStationLocked(db, 'P1', true);
    let obs = loadObservations(db);
    expect(obs.find((o) => o.id === 'o5')!.flipped).toBe(true);
    expect(obs.find((o) => o.id === 'o1')!.weight).toBe(2.5);
    expect(loadStations(db).find((s) => s.id === 'P1')!.locked).toBe(true);

    // 清空并重新导入：候选状态复位，原始观测不变
    importFixture(db);
    obs = loadObservations(db);
    expect(obs.find((o) => o.id === 'o5')!.flipped).toBe(false);
    expect(obs.find((o) => o.id === 'o1')!.weight).toBe(1);
    expect(loadStations(db).find((s) => s.id === 'P1')!.locked).toBe(false);
    expect(obs.find((o) => o.id === 'o5')!.from).toBe('K01');
    expect(obs.find((o) => o.id === 'o5')!.to).toBe('P3');
  });

  it('运行记录保存与导出（复核）', () => {
    const db = openDb(':memory:');
    ensureFixture(db);
    setObservationFlipped(db, 'o5', true);
    const result = adjustNetwork(loadStations(db), loadObservations(db));
    const id = saveRun(db, result);
    expect(id).toBeGreaterThan(0);
    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    const run = getRun(db, id)!;
    expect(run.result).toMatchObject({ diagnostics: expect.any(Object) });
    // 清空数据库重新导入后运行记录仍可复核
    importFixture(db);
    expect(getRun(db, id)).not.toBeNull();
    expect(loadObservations(db)).toHaveLength(7);
  });
});
