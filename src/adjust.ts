import type {
  AdjustResult, ComponentInfo, ObsResidual, Observation, Station, StationResult,
} from './types.ts';
import {
  RAD2DEG, eigen2x2, invert, matVec, rankOf, wrapDeg, zeros, type Mat,
} from './math.ts';
import {
  SIGMA_ANGLE_RAD, effectiveAzimuth, effectiveEndpoints, effectiveVector, vectorCovariance,
} from './obsmodel.ts';
import { buildConnections, computeLoops, connectedComponents } from './graph.ts';

interface RowBlock {
  /** 该行所属观测 */
  obsId: string;
  /** 非零列：{col, val} */
  entries: { col: number; val: number }[];
  /** 右端 b */
  b: number;
  /** 权（标量行）或 3x3 权阵起始行 */
  w: number;
}

interface VecBlock {
  obsId: string;
  rows: [number, number, number];
  w: Mat; // 3x3
}

/**
 * 三维导线网加权最小二乘平差。
 * 观测模型：斜距/方位/倾角 → 三维基线向量观测（协方差由误差传播得来），线性平差；
 * 仅方位边贡献 1 个方向方程。原始观测不被改写，翻转/权重仅为候选状态。
 */
export function adjustNetwork(stations: Station[], observations: Observation[]): AdjustResult {
  const compOf = connectedComponents(stations, observations);
  const loops = computeLoops(stations, observations, compOf);
  const staById = new Map(stations.map((s) => [s.id, s]));
  const conns = buildConnections(observations);

  const datumOf = (s: Station): [number, number, number] =>
    s.locked ? (s.known ?? s.approx) : s.approx;

  const components: ComponentInfo[] = [];
  const stationResults = new Map<string, StationResult>();
  const residuals: ObsResidual[] = [];
  let totalRows = 0;
  let totalUnknowns = 0;
  let totalRank = 0;
  let vtWv = 0;
  let condMax = 0;
  let condMin = Infinity;
  const messages: string[] = [];

  const compIds = [...new Set(compOf.values())].sort((a, b) => a - b);
  for (const comp of compIds) {
    const compStations = stations.filter((s) => compOf.get(s.id) === comp);
    const compObs = observations.filter((o) => compOf.get(o.from) === comp);
    const free = compStations.filter((s) => !s.locked);
    const colOf = new Map(free.map((s, i) => [s.id, i * 3]));
    const unknowns = free.length * 3;

    const scalarRows: RowBlock[] = [];
    const vecBlocks: VecBlock[] = [];
    const aRows: number[][] = [];
    const bVec: number[] = [];
    const wDiag: number[] = []; // 仅标量行用；向量块单独存

    const datum = new Map(compStations.map((s) => [s.id, datumOf(s)]));

    for (const o of compObs) {
      const { effFrom, effTo } = effectiveEndpoints(o);
      const vec = effectiveVector(o);
      const cov = vectorCovariance(o);
      if (vec && cov) {
        // 三维向量观测：pos[effTo] - pos[effFrom] = Δ
        const wInv = invert(cov);
        if (!wInv) continue;
        const w: Mat = wInv.map((row) => row.map((v) => v * o.weight));
        const base = aRows.length;
        const dTo = datum.get(effTo) as [number, number, number];
        const dFrom = datum.get(effFrom) as [number, number, number];
        const b: number[] = [
          vec.e - (dTo[0] - dFrom[0]),
          vec.n - (dTo[1] - dFrom[1]),
          vec.z - (dTo[2] - dFrom[2]),
        ];
        for (let r = 0; r < 3; r++) {
          const row = new Array<number>(unknowns).fill(0);
          const cTo = colOf.get(effTo);
          const cFrom = colOf.get(effFrom);
          if (cTo !== undefined) row[cTo + r] += 1;
          if (cFrom !== undefined) row[cFrom + r] -= 1;
          aRows.push(row);
          bVec.push(b[r]);
          wDiag.push(0);
        }
        vecBlocks.push({ obsId: o.id, rows: [base, base + 1, base + 2], w });
      } else if (o.azimuth != null) {
        // 仅方位：1 个方向方程（无尺度）
        const dTo = datum.get(effTo) as [number, number, number];
        const dFrom = datum.get(effFrom) as [number, number, number];
        const dE = dTo[0] - dFrom[0];
        const dN = dTo[1] - dFrom[1];
        const dh2 = dE * dE + dN * dN;
        const row = new Array<number>(unknowns).fill(0);
        let b = 0;
        if (dh2 > 1e-12) {
          const azComp = Math.atan2(dE, dN);
          const azObs = (effectiveAzimuth(o) as number) / RAD2DEG;
          b = wrapDeg((azObs - azComp) * RAD2DEG) / RAD2DEG;
          const dAzDE = dN / dh2;
          const dAzDN = -dE / dh2;
          const cTo = colOf.get(effTo);
          const cFrom = colOf.get(effFrom);
          if (cTo !== undefined) { row[cTo] += dAzDE; row[cTo + 1] += dAzDN; }
          if (cFrom !== undefined) { row[cFrom] -= dAzDE; row[cFrom + 1] -= dAzDN; }
        }
        aRows.push(row);
        bVec.push(b);
        wDiag.push(o.weight / (SIGMA_ANGLE_RAD * SIGMA_ANGLE_RAD));
        scalarRows.push({
          obsId: o.id,
          entries: [],
          b,
          w: o.weight / (SIGMA_ANGLE_RAD * SIGMA_ANGLE_RAD),
        });
      }
    }

    const rank = unknowns === 0 ? 0 : rankOf(aRows.length ? aRows : [[0]]);
    const defect = unknowns - rank;
    const defectLabels: string[] = [];
    if (defect > 0) {
      let rest = defect;
      if (!compStations.some((s) => s.locked)) {
        defectLabels.push(`平移基准缺失 3 维`);
        rest -= 3;
      }
      if (!compObs.some((o) => o.slope != null)) {
        defectLabels.push(`无距离观测，尺度不可识别 1 维`);
        rest -= 1;
      }
      if (rest > 0) defectLabels.push(`其余不可识别自由度 ${rest} 维（如高程/旋转基准）`);
    }

    components.push({
      index: comp,
      stationIds: compStations.map((s) => s.id),
      observationIds: compObs.map((o) => o.id),
      loopCount: loops.filter((l) => l.component === comp).length,
      rank,
      unknowns,
      defect,
      defectLabels,
    });
    totalRows += aRows.length;
    totalUnknowns += unknowns;
    totalRank += rank;

    if (defect > 0 || unknowns === 0) {
      if (defect > 0) {
        messages.push(`分量 ${comp + 1} 秩亏 ${defect} 维（${defectLabels.join('；')}），不参与平差`);
        for (const s of compStations) {
          stationResults.set(s.id, {
            id: s.id, name: s.name, adjusted: null, ellipse: null, sigmaZ: null,
          });
        }
      } else {
        for (const s of compStations) {
          stationResults.set(s.id, {
            id: s.id, name: s.name, adjusted: datumOf(s), ellipse: null, sigmaZ: null,
          });
        }
      }
      continue;
    }

    // 组法方程 N δ = u
    const N: Mat = zeros(unknowns, unknowns);
    const u = new Array<number>(unknowns).fill(0);
    const addRow = (row: number[], w: number, b: number): void => {
      for (let i = 0; i < unknowns; i++) {
        const ai = row[i];
        if (ai === 0) continue;
        u[i] += ai * w * b;
        for (let j = 0; j < unknowns; j++) {
          if (row[j] !== 0) N[i][j] += ai * w * row[j];
        }
      }
    };
    let rowIdx = 0;
    const vecRowSet = new Map<number, VecBlock>();
    for (const vb of vecBlocks) for (const r of vb.rows) vecRowSet.set(r, vb);
    for (const vb of vecBlocks) {
      // 向量块：Aᵀ W A，W 为 3x3
      const A = vb.rows.map((r) => aRows[r]);
      const b = vb.rows.map((r) => bVec[r]);
      for (let p = 0; p < 3; p++)
        for (let q = 0; q < 3; q++) {
          const w = vb.w[p][q];
          if (w === 0) continue;
          for (let i = 0; i < unknowns; i++) {
            const ap = A[p][i];
            if (ap === 0) continue;
            u[i] += ap * w * b[q];
            for (let j = 0; j < unknowns; j++) {
              if (A[q][j] !== 0) N[i][j] += ap * w * A[q][j];
            }
          }
        }
      rowIdx += 3;
    }
    // 标量行（仅方位）
    for (let r = 0; r < aRows.length; r++) {
      if (vecRowSet.has(r)) continue;
      addRow(aRows[r], wDiag[r], bVec[r]);
    }

    const Q = invert(N);
    if (!Q) {
      messages.push(`分量 ${comp + 1} 法方程奇异，跳过`);
      for (const s of compStations) {
        stationResults.set(s.id, { id: s.id, name: s.name, adjusted: null, ellipse: null, sigmaZ: null });
      }
      continue;
    }
    const delta = matVec(Q, u);
    for (let i = 0; i < unknowns; i++) {
      const d = Math.abs(Q[i][i]);
      if (d > 0) {
        condMax = Math.max(condMax, d);
        condMin = Math.min(condMin, d);
      }
    }

    // 平差后坐标
    const adjusted = new Map<string, [number, number, number]>();
    for (const s of compStations) {
      const d0 = datum.get(s.id) as [number, number, number];
      const c = colOf.get(s.id);
      if (c === undefined) adjusted.set(s.id, d0);
      else adjusted.set(s.id, [d0[0] + delta[c], d0[1] + delta[c + 1], d0[2] + delta[c + 2]]);
    }
    for (const s of compStations) {
      const c = colOf.get(s.id);
      let ellipse: StationResult['ellipse'] = null;
      let sigmaZ: number | null = null;
      if (c !== undefined) {
        const eg = eigen2x2(Q[c][c], Q[c + 1][c + 1], Q[c][c + 1]);
        ellipse = { a: Math.sqrt(eg.l1), b: Math.sqrt(eg.l2), thetaDeg: eg.theta * RAD2DEG };
        sigmaZ = Math.sqrt(Math.max(0, Q[c + 2][c + 2]));
      }
      stationResults.set(s.id, {
        id: s.id, name: s.name, adjusted: adjusted.get(s.id) as [number, number, number], ellipse, sigmaZ,
      });
    }

    // 残差（按观测输出）与 vᵀWv
    for (const o of compObs) {
      const { effFrom, effTo } = effectiveEndpoints(o);
      const pTo = adjusted.get(effTo) as [number, number, number];
      const pFrom = adjusted.get(effFrom) as [number, number, number];
      const y = { e: pTo[0] - pFrom[0], n: pTo[1] - pFrom[1], z: pTo[2] - pFrom[2] };
      const vec = effectiveVector(o);
      if (vec) {
        const v = [y.e - vec.e, y.n - vec.n, y.z - vec.z];
        const vb = vecBlocks.find((b2) => b2.obsId === o.id);
        if (vb) {
          const wv = matVec(vb.w, v);
          vtWv += v[0] * wv[0] + v[1] * wv[1] + v[2] * wv[2];
        }
        const dz = y.z - o.hi + o.ht;
        const dh = Math.hypot(y.e, y.n);
        const sAdj = Math.hypot(dh, dz);
        const azAdj = Math.atan2(y.e, y.n) * RAD2DEG;
        const inclAdj = (Math.asin(Math.max(-1, Math.min(1, dz / sAdj))) * RAD2DEG);
        residuals.push({
          observationId: o.id, from: effFrom, to: effTo, flipped: o.flipped,
          vDist: o.slope != null ? o.slope - sAdj : null,
          vAzSec: o.azimuth != null ? wrapDeg(o.azimuth - azAdj) * 3600 : null,
          vInclSec: o.incl != null ? (o.incl - inclAdj) * 3600 : null,
          vVec: { e: v[0], n: v[1], z: v[2] },
        });
      } else if (o.azimuth != null) {
        const azAdj = Math.atan2(y.e, y.n) * RAD2DEG;
        const vSec = wrapDeg((effectiveAzimuth(o) as number) - azAdj) * 3600;
        const vRad = (vSec / 3600) / RAD2DEG;
        vtWv += vRad * vRad * (o.weight / (SIGMA_ANGLE_RAD * SIGMA_ANGLE_RAD));
        residuals.push({
          observationId: o.id, from: effFrom, to: effTo, flipped: o.flipped,
          vDist: null, vAzSec: vSec, vInclSec: null, vVec: null,
        });
      }
    }
    messages.push(`分量 ${comp + 1} 平差成功（${compStations.length} 站 / ${compObs.length} 观测）`);
  }

  const dof = totalRows - totalRank;
  const sigma0 = dof > 0 ? Math.sqrt(vtWv / dof) : null;
  return {
    ok: components.every((c) => c.defect === 0),
    message: messages.join('；'),
    components,
    loops,
    stations: stations.map((s) => stationResults.get(s.id) as StationResult),
    residuals,
    diagnostics: {
      observations: totalRows,
      unknowns: totalUnknowns,
      rank: totalRank,
      defect: totalUnknowns - totalRank,
      dof,
      sigma0,
      condEstimate: condMin !== Infinity && condMin > 0 ? condMax / condMin : null,
    },
  };
}

/** 网结构摘要（不依赖平差是否成功）。 */
export function networkSummary(stations: Station[], observations: Observation[]): {
  components: number;
  stations: number;
  observations: number;
  connections: number;
  loops: number;
  roundTripGroups: string[];
  duplicateNames: { name: string; ids: string[] }[];
} {
  const compOf = connectedComponents(stations, observations);
  const conns = buildConnections(observations);
  const loops = computeLoops(stations, observations, compOf);
  const groups = new Set(observations.map((o) => o.group).filter((g): g is string => g != null));
  const byName = new Map<string, string[]>();
  for (const s of stations) {
    const arr = byName.get(s.name) ?? [];
    arr.push(s.id);
    byName.set(s.name, arr);
  }
  return {
    components: new Set(compOf.values()).size,
    stations: stations.length,
    observations: observations.length,
    connections: conns.length,
    loops: loops.length,
    roundTripGroups: [...groups],
    duplicateNames: [...byName.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids })),
  };
}
