import { describe, expect, it } from 'vitest';
import { buildFixture } from '../src/fixture.ts';
import { adjustNetwork, networkSummary } from '../src/adjust.ts';
import { azimuthResidualDeg, wrapDeg } from '../src/math.ts';
import { buildConnections, computeLoops, connectedComponents } from '../src/graph.ts';

describe('固定算例结构', () => {
  it('重名测站身份不同、不合并', () => {
    const { stations, observations } = buildFixture();
    const named = stations.filter((s) => s.name === 'A1');
    expect(named.map((s) => s.id).sort()).toEqual(['P1', 'X1']);
    const summary = networkSummary(stations, observations);
    expect(summary.stations).toBe(7);
    expect(summary.duplicateNames).toEqual([{ name: 'A1', ids: ['P1', 'X1'] }]);
    // 两个 A1 分属不同分量
    const compOf = connectedComponents(stations, observations);
    expect(compOf.get('P1')).not.toBe(compOf.get('X1'));
  });

  it('主网恰有 1 个独立闭合环，往返观测不产生额外环', () => {
    const { stations, observations } = buildFixture();
    const compOf = connectedComponents(stations, observations);
    const loops = computeLoops(stations, observations, compOf);
    expect(loops).toHaveLength(1);
    expect(loops[0].component).toBe(compOf.get('K01'));
    // 往返观测 o2/o3 是同一连接上的两条证据
    const conns = buildConnections(observations);
    const rt = conns.find((c) => c.observationIds.includes('o2'));
    expect(rt?.observationIds.sort()).toEqual(['o2', 'o3']);
    expect(conns).toHaveLength(6);
  });

  it('孤立子图存在且仅含方位观测', () => {
    const { stations, observations } = buildFixture();
    const summary = networkSummary(stations, observations);
    expect(summary.components).toBe(2);
    const x = observations.filter((o) => o.id.startsWith('x'));
    expect(x.every((o) => o.slope === null && o.azimuth !== null)).toBe(true);
  });
});

describe('闭合差与翻转候选', () => {
  it('写反边导致巨大闭合差，翻转后闭合差消失', () => {
    const { stations, observations } = buildFixture();
    let r = adjustNetwork(stations, observations);
    const f0 = r.loops[0].misclosure;
    expect(f0).not.toBeNull();
    expect(Math.hypot(f0!.e, f0!.n, f0!.z)).toBeGreaterThan(100);
    // 翻转疑似写反的 o5
    observations.find((o) => o.id === 'o5')!.flipped = true;
    r = adjustNetwork(stations, observations);
    const f1 = r.loops[0].misclosure;
    expect(Math.hypot(f1!.e, f1!.n, f1!.z)).toBeLessThan(0.05);
    expect(r.loops[0].relative!).toBeGreaterThan(10000);
  });

  it('翻转不改写原观测，往返两条证据都保留', () => {
    const { stations, observations } = buildFixture();
    const before = observations.find((o) => o.id === 'o2')!;
    const origFrom = before.from;
    const origTo = before.to;
    const origSlope = before.slope;
    before.flipped = true;
    // 原记录字段不变
    expect(before.from).toBe(origFrom);
    expect(before.to).toBe(origTo);
    expect(before.slope).toBe(origSlope);
    // 往返两条证据都还在，且互不影响
    const o3 = observations.find((o) => o.id === 'o3')!;
    expect(o3.flipped).toBe(false);
    expect(observations.filter((o) => o.group === 'RT1')).toHaveLength(2);
    // 平差残差中两条往返观测都出现
    observations.find((o) => o.id === 'o5')!.flipped = true;
    const r = adjustNetwork(stations, observations);
    const ids = r.residuals.map((x) => x.observationId);
    expect(ids).toContain('o2');
    expect(ids).toContain('o3');
    expect(r.residuals.find((x) => x.observationId === 'o2')!.flipped).toBe(true);
  });
});

describe('方位角跨零度环绕', () => {
  it('残差按最短环绕解释', () => {
    expect(azimuthResidualDeg(0.05, 359.95)).toBeCloseTo(0.1, 10);
    expect(azimuthResidualDeg(359.95, 0.05)).toBeCloseTo(-0.1, 10);
    expect(azimuthResidualDeg(0.001, 359.999)).toBeCloseTo(0.002, 10);
    expect(Math.abs(azimuthResidualDeg(0.001, 359.999))).toBeLessThan(1);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(720.5)).toBeCloseTo(0.5, 10);
  });

  it('跨零度观测的平 residual 不出现近整圈误差', () => {
    const { stations, observations } = buildFixture();
    // 构造一条跨 0° 的边：K01(1000,1000) → 正北偏西一点点
    stations.push({ id: 'N1', name: 'N1', approx: [999.9, 1050, 100], known: null, locked: false });
    const azTrue = (Math.atan2(-0.1, 50) * 180) / Math.PI + 360; // ≈359.885°
    observations.push({
      id: 'n1', from: 'K01', to: 'N1', slope: 50.0001, azimuth: azTrue % 360,
      incl: 0, hi: 1.5, ht: 1.2, weight: 1, flipped: false, group: null,
    });
    observations.find((o) => o.id === 'o5')!.flipped = true;
    const r = adjustNetwork(stations, observations);
    const res = r.residuals.find((x) => x.observationId === 'n1')!;
    expect(Math.abs(res.vAzSec!)).toBeLessThan(30); // 秒级，而非 ±1296000″ 量级
  });
});

describe('秩亏报告', () => {
  it('孤立子图（仅方位无尺度）报告不可识别自由度', () => {
    const { stations, observations } = buildFixture();
    const r = adjustNetwork(stations, observations);
    const iso = r.components.find((c) => c.stationIds.includes('X1'))!;
    expect(iso.defect).toBe(7);
    expect(iso.defectLabels.join('')).toContain('尺度');
    expect(iso.defectLabels.join('')).toContain('平移基准');
    // 主网满秩
    const main = r.components.find((c) => c.stationIds.includes('K01'))!;
    expect(main.defect).toBe(0);
    expect(r.ok).toBe(false); // 整网含秩亏分量
    // 秩亏分量测站坐标不可解
    expect(r.stations.find((s) => s.id === 'X1')!.adjusted).toBeNull();
  });

  it('主网解锁全部控制点后出现平移基准秩亏', () => {
    const { stations, observations } = buildFixture();
    stations.find((s) => s.id === 'K01')!.locked = false;
    const r = adjustNetwork(stations, observations);
    const main = r.components.find((c) => c.stationIds.includes('K01'))!;
    expect(main.defect).toBe(3);
    expect(main.defectLabels.join('')).toContain('平移基准');
  });
});

describe('平差质量', () => {
  it('翻转写反边后：σ0 合理、坐标回到真值附近、残差小', () => {
    const { stations, observations } = buildFixture();
    observations.find((o) => o.id === 'o5')!.flipped = true;
    const r = adjustNetwork(stations, observations);
    expect(r.diagnostics.sigma0!).toBeLessThan(1);
    expect(r.diagnostics.dof).toBeGreaterThan(0);
    const p1 = r.stations.find((s) => s.id === 'P1')!;
    expect(p1.adjusted![0]).toBeCloseTo(1010, 1);
    expect(p1.adjusted![1]).toBeCloseTo(1050, 1);
    expect(p1.adjusted![2]).toBeCloseTo(98, 1);
    expect(p1.ellipse!.a).toBeGreaterThan(0);
    for (const res of r.residuals) {
      if (res.vDist != null) expect(Math.abs(res.vDist)).toBeLessThan(0.02);
      if (res.vAzSec != null && res.observationId.startsWith('o')) {
        expect(Math.abs(res.vAzSec)).toBeLessThan(30);
      }
    }
  });

  it('修改观测权重影响平差但不破坏结构', () => {
    const { stations, observations } = buildFixture();
    observations.find((o) => o.id === 'o5')!.flipped = true;
    const r1 = adjustNetwork(stations, observations);
    observations.find((o) => o.id === 'o1')!.weight = 0.01;
    const r2 = adjustNetwork(stations, observations);
    expect(r2.components.find((c) => c.stationIds.includes('K01'))!.defect).toBe(0);
    const a = r1.stations.find((s) => s.id === 'P1')!.adjusted!;
    const b = r2.stations.find((s) => s.id === 'P1')!.adjusted!;
    expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeGreaterThan(1e-6);
  });
});
