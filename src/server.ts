import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, seedDatabase, loadFixture, isSeeded } from './db.js';
import { addFlip, changeWeight, currentResult, getCandidates, getObservations, getStations, recomputeAndRecord, runs, toggleFlip, toggleLock } from './service.js';
import type { FixtureData } from './db.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const hostArg = args.indexOf('--host');
const portArg = args.indexOf('--port');
const host = hostArg >= 0 ? args[hostArg + 1] : '127.0.0.1';
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT ?? 5535);
const fixturePath = process.env.CAVE_FIXTURE ?? join(root, 'data', 'fixture.json');
const databasePath = process.env.CAVE_DB ?? join(root, 'data', 'cave.db');

const database = openDatabase(databasePath);
if (!isSeeded(database)) seedDatabase(database, loadFixture(fixturePath));

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let payload = '';
    request.on('data', (chunk) => {
      payload += chunk;
      if (payload.length > 5_000_000) reject(new Error('请求过大'));
    });
    request.on('end', () => {
      if (!payload) return resolveBody({});
      try { resolveBody(JSON.parse(payload)); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function snapshot() {
  return {
    stations: getStations(database),
    observations: getObservations(database),
    flip_candidates: getCandidates(database),
    result: currentResult(database),
  };
}

function exportBundle() {
  return {
    exported_at: new Date().toISOString(),
    fixture: loadFixture(fixturePath),
    run_records: runs(database),
  };
}

function validateFixture(data: unknown): asserts data is FixtureData {
  if (!data || typeof data !== 'object') throw new Error('导入数据不是对象');
  const candidate = data as Partial<FixtureData>;
  if (!Array.isArray(candidate.stations) || !Array.isArray(candidate.observations) || !Array.isArray(candidate.flip_candidates ?? [])) throw new Error('缺少 stations/observations/flip_candidates 数组');
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'local'}`);
  const method = request.method ?? 'GET';

  try {
    if (method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, snapshot());
    if (method === 'GET' && url.pathname === '/api/runs') return sendJson(response, 200, runs(database));
    if (method === 'POST' && url.pathname === '/api/adjust') return sendJson(response, 200, recomputeAndRecord(database, '手动重算'));
    if (method === 'GET' && url.pathname === '/api/export') return sendJson(response, 200, exportBundle());

    if (method === 'POST' && url.pathname === '/api/stations/lock') {
      const body = await readBody(request) as { station_id?: string; locked?: boolean };
      return sendJson(response, 200, { run: toggleLock(database, body.station_id ?? '', Boolean(body.locked)), result: currentResult(database) });
    }
    if (method === 'POST' && url.pathname === '/api/observations/weight') {
      const body = await readBody(request) as { observation_id?: string; weight?: number };
      return sendJson(response, 200, { run: changeWeight(database, body.observation_id ?? '', Number(body.weight)), result: currentResult(database) });
    }
    if (method === 'POST' && url.pathname === '/api/flips/toggle') {
      const body = await readBody(request) as { candidate_id?: string; active?: boolean };
      return sendJson(response, 200, { run: toggleFlip(database, body.candidate_id ?? '', Boolean(body.active)), result: currentResult(database) });
    }
    if (method === 'POST' && url.pathname === '/api/flips') {
      const body = await readBody(request) as { observation_id?: string; active?: boolean };
      return sendJson(response, 200, { run: addFlip(database, body.observation_id ?? '', body.active !== false), result: currentResult(database) });
    }
    if (method === 'POST' && (url.pathname === '/api/reset' || url.pathname === '/api/import')) {
      const body = url.pathname === '/api/import' ? await readBody(request) as { fixture?: unknown } : {};
      const fixture = url.pathname === '/api/import' ? body.fixture : loadFixture(fixturePath);
      validateFixture(fixture);
      seedDatabase(database, fixture);
      return sendJson(response, 200, recomputeAndRecord(database, url.pathname === '/api/import' ? '导入固定数据并复核' : '清空数据库并重导 fixture'));
    }

    if (method === 'GET') {
      const requested = url.pathname === '/' ? '/public/index.html' : `/public${url.pathname}`;
      const filePath = resolve(join(root, requested));
      const publicRoot = join(root, 'public');
      if (filePath.startsWith(publicRoot) && existsSync(filePath) && statSync(filePath).isFile()) {
        response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
        createReadStream(filePath).pipe(response);
        return;
      }
    }
    sendJson(response, 404, { error: '未找到' });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

const server = createServer((request, response) => {
  void route(request, response);
});

server.listen(port, host, () => {
  console.log(`地下环闭合仪: http://${host}:${port}`);
  console.log(`SQLite: ${databasePath}`);
});
