import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DbStation {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  locked: number;
}

export interface DbObservation {
  id: string;
  from_station_id: string;
  to_station_id: string;
  slope_distance: number | null;
  azimuth_deg: number | null;
  inclination_deg: number | null;
  instrument_height: number;
  target_height: number;
  weight: number;
}

export interface DbFlipCandidate {
  id: string;
  original_observation_id: string;
  from_station_id: string;
  to_station_id: string;
  active: number;
  note: string;
}

export interface FixtureData {
  version: number;
  name?: string;
  stations: Array<Omit<DbStation, 'locked'> & { locked: boolean }>;
  observations: DbObservation[];
  flip_candidates: Array<Omit<DbFlipCandidate, 'active'> & { active: boolean }>;
}

export interface RunRow {
  id: number;
  created_at: string;
  action: string;
  lock_json: string;
  weight_json: string;
  candidate_json: string;
  result_json: string;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  from_station_id TEXT NOT NULL REFERENCES stations(id),
  to_station_id TEXT NOT NULL REFERENCES stations(id),
  slope_distance REAL,
  azimuth_deg REAL,
  inclination_deg REAL,
  instrument_height REAL NOT NULL,
  target_height REAL NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  CHECK (from_station_id <> to_station_id)
);
CREATE TABLE IF NOT EXISTS flip_candidates (
  id TEXT PRIMARY KEY,
  original_observation_id TEXT NOT NULL UNIQUE REFERENCES observations(id),
  from_station_id TEXT NOT NULL REFERENCES stations(id),
  to_station_id TEXT NOT NULL REFERENCES stations(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS run_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  lock_json TEXT NOT NULL,
  weight_json TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS observations_raw_values_immutable_update
BEFORE UPDATE OF from_station_id, to_station_id, slope_distance, azimuth_deg, inclination_deg, instrument_height, target_height
ON observations
BEGIN
  SELECT RAISE(ABORT, '原始观测不可改写；权重请更新 weight，翻转请写 flip_candidates');
END;
CREATE TRIGGER IF NOT EXISTS observations_raw_values_immutable_delete
BEFORE DELETE ON observations
BEGIN
  SELECT RAISE(ABORT, '原始观测不可删除；清空库请通过 reset/import 重建');
END;
`;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(SCHEMA);
  return database;
}

export function loadFixture(path: string): FixtureData {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureData;
}

export function seedDatabase(database: DatabaseSync, fixture: FixtureData): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS observations_raw_values_immutable_delete;
    DELETE FROM run_records;
    DELETE FROM flip_candidates;
    DELETE FROM observations;
    DELETE FROM stations;
  `);
  const insertStation = database.prepare('INSERT INTO stations (id,name,x,y,z,locked) VALUES (?,?,?,?,?,?)');
  const insertObservation = database.prepare('INSERT INTO observations (id,from_station_id,to_station_id,slope_distance,azimuth_deg,inclination_deg,instrument_height,target_height,weight) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertCandidate = database.prepare('INSERT INTO flip_candidates (id,original_observation_id,from_station_id,to_station_id,active,note) VALUES (?,?,?,?,?,?)');
  for (const station of fixture.stations) insertStation.run(station.id, station.name, station.x, station.y, station.z, station.locked ? 1 : 0);
  for (const observation of fixture.observations) insertObservation.run(observation.id, observation.from_station_id, observation.to_station_id, observation.slope_distance, observation.azimuth_deg, observation.inclination_deg, observation.instrument_height, observation.target_height, observation.weight);
  for (const candidate of fixture.flip_candidates ?? []) insertCandidate.run(candidate.id, candidate.original_observation_id, candidate.from_station_id, candidate.to_station_id, candidate.active ? 1 : 0, candidate.note ?? '');
  database.prepare(`INSERT INTO schema_meta(key,value) VALUES ('fixture_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(fixture.version));
  database.exec(`
    CREATE TRIGGER observations_raw_values_immutable_delete
    BEFORE DELETE ON observations
    BEGIN
      SELECT RAISE(ABORT, '原始观测不可删除；清空库请通过 reset/import 重建');
    END;
    PRAGMA foreign_keys = ON;
  `);
}

export function isSeeded(database: DatabaseSync): boolean {
  const row = database.prepare('SELECT COUNT(*) AS count FROM stations').get() as { count: number };
  return row.count > 0;
}
