import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../src/server.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  const { handle } = createApp(':memory:');
  server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (p: string) => fetch(base + p).then((r) => r.json());
const post = (p: string, body?: unknown) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

describe('HTTP API', () => {
  it('首页包含标题', async () => {
    const html = await fetch(base + '/').then((r) => r.text());
    expect(html).toContain('地下环闭合仪');
  });

  it('验收流程：翻转写反边 → 平差 → 往返证据仍在 → 秩亏子图报告', async () => {
    let state = await get('/api/state');
    expect(state.summary.loops).toBe(1);
    expect(state.loops).toHaveLength(1);
    const f0 = state.loops[0].misclosure;
    expect(Math.hypot(f0.e, f0.n, f0.z)).toBeGreaterThan(100);

    // 翻转疑似写反的边 o5
    state = await post('/api/observation', { id: 'o5', flipped: true });
    const o5 = state.observations.find((o: { id: string }) => o.id === 'o5');
    expect(o5.flipped).toBe(true);
    expect(o5.from).toBe('K01'); // 原记录不改写
    expect(o5.to).toBe('P3');

    // 平差：闭合差消失，往返观测 o2/o3 仍是两条证据
    const result = await post('/api/adjust');
    expect(result.runId).toBeGreaterThan(0);
    const f1 = result.loops[0].misclosure;
    expect(Math.hypot(f1.e, f1.n, f1.z)).toBeLessThan(0.05);
    const rt = result.residuals.filter((r: { observationId: string }) => ['o2', 'o3'].includes(r.observationId));
    expect(rt).toHaveLength(2);
    const iso = result.components.find((c: { stationIds: string[] }) => c.stationIds.includes('X1'));
    expect(iso.defect).toBe(7);
    expect(iso.defectLabels.join('')).toContain('尺度');

    // 运行记录可导出
    const exported = await fetch(`${base}/api/runs/${result.runId}/export`).then((r) => r.json());
    expect(exported.result.diagnostics.rank).toBeGreaterThan(0);

    // 修改权重与锁定
    state = await post('/api/observation', { id: 'o1', weight: 3 });
    expect(state.observations.find((o: { id: string }) => o.id === 'o1').weight).toBe(3);
    state = await post('/api/station', { id: 'P1', locked: true });
    expect(state.stations.find((s: { id: string }) => s.id === 'P1').locked).toBe(true);

    // 清空并重新导入复核
    state = await post('/api/reset');
    expect(state.observations.find((o: { id: string }) => o.id === 'o5').flipped).toBe(false);
    expect(state.stations.find((s: { id: string }) => s.id === 'P1').locked).toBe(false);
    const runs = await get('/api/runs');
    expect(runs.length).toBeGreaterThan(0);
  });
});
