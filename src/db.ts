import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Observation, Station } from './types.ts';
import { buildFixture } from './fixture.ts';

export const FIXTURE_VERSION = 'fixture-v1';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ae REAL NOT NULL, an REAL NOT NULL, az REAL NOT NULL,
      known INTEGER NOT NULL DEFAULT 0,
      ke REAL, kn REAL, kz REAL,
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      frm TEXT NOT NULL, tot TEXT NOT NULL,
      slope REAL, azimuth REAL, incl REAL,
      hi REAL NOT NULL, ht REAL NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      flipped INTEGER NOT NULL DEFAULT 0,
      grp TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      result TEXT NOT NULL
    );
  `);
  return db;
}

export function isImported(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('fixture') as { v: string } | undefined;
  return row?.v === FIXTURE_VERSION;
}

/** 清空并重新导入固定算例；原始观测字段只在此处写入，平差永不改写。 */
export function importFixture(db: DatabaseSync): void {
  db.exec('DELETE FROM observations; DELETE FROM stations; DELETE FROM meta;');
  const { stations, observations } = buildFixture();
  const insS = db.prepare(
    'INSERT INTO stations (id,name,ae,an,az,known,ke,kn,kz,locked) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  for (const s of stations) {
    insS.run(
      s.id, s.name, s.approx[0], s.approx[1], s.approx[2],
      s.known ? 1 : 0,
      s.known?.[0] ?? null, s.known?.[1] ?? null, s.known?.[2] ?? null,
      s.locked ? 1 : 0,
    );
  }
  const insO = db.prepare(
    'INSERT INTO observations (id,frm,tot,slope,azimuth,incl,hi,ht,weight,flipped,grp) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const o of observations) {
    insO.run(o.id, o.from, o.to, o.slope, o.azimuth, o.incl, o.hi, o.ht, o.weight, o.flipped ? 1 : 0, o.group);
  }
  db.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run('fixture', FIXTURE_VERSION);
}

export function ensureFixture(db: DatabaseSync): void {
  if (!isImported(db)) importFixture(db);
}

interface StationRow {
  id: string; name: string; ae: number; an: number; az: number;
  known: number; ke: number | null; kn: number | null; kz: number | null; locked: number;
}
interface ObsRow {
  id: string; frm: string; tot: string; slope: number | null; azimuth: number | null;
  incl: number | null; hi: number; ht: number; weight: number; flipped: number; grp: string | null;
}

export function loadStations(db: DatabaseSync): Station[] {
  const rows = db.prepare('SELECT * FROM stations ORDER BY id').all() as unknown as StationRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    approx: [r.ae, r.an, r.az],
    known: r.known ? [r.ke as number, r.kn as number, r.kz as number] : null,
    locked: r.locked === 1,
  }));
}

export function loadObservations(db: DatabaseSync): Observation[] {
  const rows = db.prepare('SELECT * FROM observations ORDER BY id').all() as unknown as ObsRow[];
  return rows.map((r) => ({
    id: r.id, from: r.frm, to: r.tot,
    slope: r.slope, azimuth: r.azimuth, incl: r.incl,
    hi: r.hi, ht: r.ht,
    weight: r.weight, flipped: r.flipped === 1, group: r.grp,
  }));
}

export function setObservationWeight(db: DatabaseSync, id: string, weight: number): boolean {
  const r = db.prepare('UPDATE observations SET weight = ? WHERE id = ?').run(weight, id);
  return r.changes > 0;
}

export function setObservationFlipped(db: DatabaseSync, id: string, flipped: boolean): boolean {
  const r = db.prepare('UPDATE observations SET flipped = ? WHERE id = ?').run(flipped ? 1 : 0, id);
  return r.changes > 0;
}

export function setStationLocked(db: DatabaseSync, id: string, locked: boolean): boolean {
  const r = db.prepare('UPDATE stations SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
  return r.changes > 0;
}

export function saveRun(db: DatabaseSync, result: unknown): number {
  const r = db.prepare('INSERT INTO runs (created_at, result) VALUES (?, ?)').run(
    new Date().toISOString(), JSON.stringify(result),
  );
  return Number(r.lastInsertRowid);
}

export function listRuns(db: DatabaseSync): { id: number; created_at: string }[] {
  return db.prepare('SELECT id, created_at FROM runs ORDER BY id DESC').all() as unknown as { id: number; created_at: string }[];
}

export function getRun(db: DatabaseSync, id: number): { id: number; created_at: string; result: unknown } | null {
  const row = db.prepare('SELECT id, created_at, result FROM runs WHERE id = ?').get(id) as
    | { id: number; created_at: string; result: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, created_at: row.created_at, result: JSON.parse(row.result) };
}
