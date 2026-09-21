import type { Observation, Station, Vec3 } from './types.ts';
import { RAD2DEG } from './math.ts';

/**
 * 固定算例（fixture）：
 * - 主网：控制点 K01 + 测站 A1/B2/C3，构成 1 个独立闭合环 K01→A1→B2→C3→K01；
 *   A1↔B2 为往返观测（两条独立证据，同组 RT1）；
 *   边 o5 记录为 K01→C3，但物理测回是 C3→K01（疑似写反，等待用户翻转为候选）。
 * - 孤立子图：A1(重名，身份不同)/D4/E5，仅方位观测、无距离 → 尺度+基准秩亏。
 * - 两个同名 "A1" 测站身份不同，绝不按名称合并。
 */

const HI = 1.5;
const HT = 1.2;

function delta(a: [number, number, number], b: [number, number, number]): Vec3 {
  return { e: b[0] - a[0], n: b[1] - a[1], z: b[2] - a[2] };
}

/** 由三维向量反算斜距/方位/倾角（度）。 */
function obsFromDelta(d: Vec3, hi: number, ht: number): { slope: number; azimuth: number; incl: number } {
  const dz = d.z - hi + ht; // ΔZ = s·sinβ + hi - ht
  const dh = Math.hypot(d.e, d.n);
  const slope = Math.hypot(dh, dz);
  let azimuth = Math.atan2(d.e, d.n) * RAD2DEG;
  if (azimuth < 0) azimuth += 360;
  const incl = (Math.asin(dz / slope) * RAD2DEG);
  return { slope, azimuth, incl };
}

/** 确定性微小噪声，让残差非零、σ0 有意义。 */
function jitter(seed: number, amp: number): number {
  return Math.sin(seed * 12.9898) * amp;
}

let seq = 0;
function fullObs(id: string, from: string, to: string, d: Vec3, group: string | null): Observation {
  seq += 1;
  const o = obsFromDelta(d, HI, HT);
  return {
    id, from, to,
    slope: o.slope + jitter(seq, 0.004),
    azimuth: o.azimuth + jitter(seq + 100, 3 / 3600),
    incl: o.incl + jitter(seq + 200, 4 / 3600),
    hi: HI, ht: HT,
    weight: 1, flipped: false, group,
  };
}

export function buildFixture(): { stations: Station[]; observations: Observation[] } {
  seq = 0;
  const K01: [number, number, number] = [1000, 1000, 100];
  const A1: [number, number, number] = [1010, 1050, 98];
  const B2: [number, number, number] = [1060, 1065, 101];
  const C3: [number, number, number] = [1075, 1015, 103];

  const stations: Station[] = [
    { id: 'K01', name: 'K01', approx: K01, known: K01, locked: true },
    { id: 'P1', name: 'A1', approx: A1, known: null, locked: false },
    { id: 'P2', name: 'B2', approx: B2, known: null, locked: false },
    { id: 'P3', name: 'C3', approx: C3, known: null, locked: false },
    // 孤立子图：仅方位、无尺度；X1 与 P1 同名 "A1" 但身份不同
    { id: 'X1', name: 'A1', approx: [500, 500, 50], known: null, locked: false },
    { id: 'X2', name: 'D4', approx: [520, 535, 52], known: null, locked: false },
    { id: 'X3', name: 'E5', approx: [545, 528, 49], known: null, locked: false },
  ];

  const observations: Observation[] = [
    fullObs('o1', 'K01', 'P1', delta(K01, A1), null),
    fullObs('o2', 'P1', 'P2', delta(A1, B2), 'RT1'),
    fullObs('o3', 'P2', 'P1', delta(B2, A1), 'RT1'), // 往返观测：第二条证据
    fullObs('o4', 'P2', 'P3', delta(B2, C3), null),
    // 疑似写反：物理测回 C3→K01，记录时 from/to 写反成 K01→C3
    fullObs('o5', 'K01', 'P3', delta(C3, K01), null),
    // 孤立子图：仅方位（无距离 → 无尺度）
    {
      id: 'x1', from: 'X1', to: 'X2', slope: null,
      azimuth: obsFromDelta(delta([500, 500, 50], [520, 535, 52]), HI, HT).azimuth,
      incl: null, hi: HI, ht: HT, weight: 1, flipped: false, group: null,
    },
    {
      id: 'x2', from: 'X2', to: 'X3', slope: null,
      azimuth: obsFromDelta(delta([520, 535, 52], [545, 528, 49]), HI, HT).azimuth,
      incl: null, hi: HI, ht: HT, weight: 1, flipped: false, group: null,
    },
  ];
  return { stations, observations };
}
