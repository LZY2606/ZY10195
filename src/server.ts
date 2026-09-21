import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import {
  ensureFixture, getRun, importFixture, listRuns, loadObservations, loadStations,
  openDb, saveRun, setObservationFlipped, setObservationWeight, setStationLocked,
} from './db.ts';
import { adjustNetwork, networkSummary } from './adjust.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, '..', 'public');
const DB_PATH = process.env.CAVE_DB_PATH ?? join(ROOT, '..', 'data', 'cave.db');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function createApp(dbPath: string = DB_PATH) {
  const db = openDb(dbPath);
  ensureFixture(db);

  const state = (): unknown => {
    const stations = loadStations(db);
    const observations = loadObservations(db);
    const preview = adjustNetwork(stations, observations);
    return {
      stations,
      observations,
      summary: networkSummary(stations, observations),
      components: preview.components,
      loops: preview.loops,
      runs: listRuns(db),
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, state());
      return;
    }
    if (req.method === 'POST' && path === '/api/adjust') {
      const stations = loadStations(db);
      const observations = loadObservations(db);
      const result = adjustNetwork(stations, observations);
      const runId = saveRun(db, {
        summary: networkSummary(stations, observations),
        ...result,
      });
      sendJson(res, 200, { runId, ...result });
      return;
    }
    if (req.method === 'POST' && path === '/api/observation') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      let ok = false;
      if (body.weight !== undefined) {
        const w = Number(body.weight);
        if (!Number.isFinite(w) || w <= 0) {
          sendJson(res, 400, { error: '权重必须为正数' });
          return;
        }
        ok = setObservationWeight(db, id, w) || ok;
      }
      if (body.flipped !== undefined) {
        ok = setObservationFlipped(db, id, Boolean(body.flipped)) || ok;
      }
      sendJson(res, ok ? 200 : 404, ok ? state() : { error: `观测 ${id} 不存在` });
      return;
    }
    if (req.method === 'POST' && path === '/api/station') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const ok = setStationLocked(db, id, Boolean(body.locked));
      sendJson(res, ok ? 200 : 404, ok ? state() : { error: `测站 ${id} 不存在` });
      return;
    }
    if (req.method === 'POST' && path === '/api/reset') {
      importFixture(db);
      sendJson(res, 200, state());
      return;
    }
    if (req.method === 'GET' && path === '/api/runs') {
      sendJson(res, 200, listRuns(db));
      return;
    }
    const runMatch = path.match(/^\/api\/runs\/(\d+)(\/export)?$/);
    if (req.method === 'GET' && runMatch) {
      const run = getRun(db, Number(runMatch[1]));
      if (!run) {
        sendJson(res, 404, { error: '运行记录不存在' });
        return;
      }
      if (runMatch[2]) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="run-${run.id}.json"`,
        });
        res.end(JSON.stringify(run, null, 2));
      } else {
        sendJson(res, 200, run);
      }
      return;
    }

    // 静态文件
    if (req.method === 'GET') {
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const file = normalize(join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      try {
        const data = await readFile(file);
        const ext = file.slice(file.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        res.end(data);
        return;
      } catch {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
    }
    sendJson(res, 405, { error: 'method not allowed' });
  };

  return { db, handle };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = argValue('--host') ?? '127.0.0.1';
  const port = Number(argValue('--port') ?? '5535');
  const { handle } = createApp();
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  }).listen(port, host, () => {
    console.log(`地下环闭合仪 → http://${host}:${port}`);
  });
}
