import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadFixture, openDatabase, seedDatabase } from '../src/db.ts';
import { addFlip, changeWeight, currentResult, getObservations, toggleLock, runs } from '../src/service.ts';

let tempDir: string;
let dbPath: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cave-test-'));
  dbPath = join(tempDir, 'test.db');
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('SQLite preserves raw observations while weights, locks, candidates and run records are mutable', () => {
  const db = openDatabase(dbPath);
  seedDatabase(db, loadFixture(join(import.meta.dirname, '..', 'data', 'fixture.json')));
  const original = getObservations(db).find((observation) => observation.id === 'obs-ab-1')!;
  changeWeight(db, 'obs-ab-1', 2.5);
  assert.throws(() => db.prepare('UPDATE observations SET azimuth_deg=1 WHERE id=?').run('obs-ab-1'), /不可改写/);
  toggleLock(db, 'B', true);
  addFlip(db, 'obs-ae-1', true);
  const after = getObservations(db).find((observation) => observation.id === 'obs-ab-1')!;
  assert.equal(after.azimuth_deg, original.azimuth_deg);
  assert.equal(after.weight, 2.5);
  assert.ok(runs(db).length >= 3);
  assert.equal(currentResult(db).summary.active_flip_count, 1);
  db.close();
});

test('HTTP server serves page, state, reset/replay and immutable raw API', async () => {
  const port = 5599;
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'server.ts'), '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, CAVE_DB: join(tempDir, 'http.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await once(child.stdout, 'data');
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    assert.match(html, /地下环闭合仪/);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.result.summary.independent_ring_count, 1);
    const exported = await (await fetch(`http://127.0.0.1:${port}/api/export`)).json();
    assert.ok(exported.fixture.stations.length >= 8);
    const reset = await fetch(`http://127.0.0.1:${port}/api/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
