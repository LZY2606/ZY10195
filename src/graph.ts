import type { LoopInfo, Observation, Station, Vec3 } from './types.ts';
import { effectiveAzimuth, effectiveEndpoints, effectiveVector } from './obsmodel.ts';
import { wrapDeg } from './math.ts';

/**
 * 拓扑图：节点 = 测站（按 id，重名不合并）；
 * 连接 = 无序测站对。往返观测是同一连接上的两条证据，不产生额外环。
 */
export interface Connection {
  key: string;
  u: string;
  v: string;
  observationIds: string[];
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildConnections(observations: Observation[]): Connection[] {
  const map = new Map<string, Connection>();
  for (const o of observations) {
    const key = pairKey(o.from, o.to);
    let c = map.get(key);
    if (!c) {
      c = { key, u: key.split('|')[0], v: key.split('|')[1], observationIds: [] };
      map.set(key, c);
    }
    c.observationIds.push(o.id);
  }
  return [...map.values()];
}

/** 连通分量：返回 stationId → 分量序号。 */
export function connectedComponents(stations: Station[], observations: Observation[]): Map<string, number> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const s of stations) parent.set(s.id, s.id);
  for (const o of observations) {
    if (parent.has(o.from) && parent.has(o.to)) {
      const ra = find(o.from), rb = find(o.to);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const roots = [...new Set(stations.map((s) => find(s.id)))].sort();
  const index = new Map(roots.map((r, i) => [r, i]));
  return new Map(stations.map((s) => [s.id, index.get(find(s.id)) as number]));
}

interface Candidate {
  keys: string[];
  path: string[];
  length: number;
}

/**
 * 最小独立闭合路（Horton 最小环基）：
 * 对每条连接求去掉它之后两端的最短路，候选环按长度排序后做 GF(2) 高斯消元取独立基。
 */
export function minimumCycleBasis(
  nodeIds: string[],
  conns: Connection[],
  connLength: (c: Connection) => number,
): { keys: string[]; path: string[] }[] {
  const adj = new Map<string, { to: string; key: string }[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const c of conns) {
    adj.get(c.u)?.push({ to: c.v, key: c.key });
    adj.get(c.v)?.push({ to: c.u, key: c.key });
  }
  const lenOf = new Map(conns.map((c) => [c.key, connLength(c)]));

  // Dijkstra（连接长度非负）
  const shortestPath = (src: string, dst: string, bannedKey: string): string[] | null => {
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const done = new Set<string>();
    dist.set(src, 0);
    while (true) {
      let cur: string | null = null;
      let best = Infinity;
      for (const [n, d] of dist) {
        if (!done.has(n) && d < best) { best = d; cur = n; }
      }
      if (cur === null) return null;
      if (cur === dst) break;
      done.add(cur);
      for (const e of adj.get(cur) ?? []) {
        if (e.key === bannedKey) continue;
        const nd = best + (lenOf.get(e.key) ?? 1);
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, cur);
        }
      }
    }
    const path = [dst];
    while (path[0] !== src) {
      const p = prev.get(path[0]);
      if (p === undefined) return null;
      path.unshift(p);
    }
    return path;
  };

  const candidates: Candidate[] = [];
  for (const c of conns) {
    const path = shortestPath(c.u, c.v, c.key);
    if (!path) continue; // 桥
    const keys = [...pathKeys(path), c.key];
    const length = keys.reduce((s, k) => s + (lenOf.get(k) ?? 1), 0);
    candidates.push({ keys, path: [...path, c.u], length });
  }
  candidates.sort((a, b) => a.length - b.length);

  // GF(2) 消元取独立基
  const connIndex = new Map(conns.map((c, i) => [c.key, i]));
  const basisRows: { pivot: number; set: Set<number> }[] = [];
  const result: { keys: string[]; path: string[] }[] = [];
  for (const cand of candidates) {
    let set = new Set(cand.keys.map((k) => connIndex.get(k) as number));
    for (const row of basisRows) {
      if (set.has(row.pivot)) set = symdiff(set, row.set);
    }
    if (set.size === 0) continue;
    const pivot = Math.min(...set);
    basisRows.push({ pivot, set });
    basisRows.sort((a, b) => a.pivot - b.pivot);
    result.push({ keys: cand.keys, path: cand.path });
  }
  return result;
}

function pathKeys(path: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i + 1 < path.length; i++) keys.push(pairKey(path[i], path[i + 1]));
  return keys;
}

function symdiff(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const x of a) if (!b.has(x)) out.add(x);
  for (const x of b) if (!a.has(x)) out.add(x);
  return out;
}

/** 连接上所有有效观测向量的均值（记录方向无关，统一折算到 u→v）。 */
function connectionMeanVector(conn: Connection, obsById: Map<string, Observation>): Vec3 | null {
  let sum: Vec3 = { e: 0, n: 0, z: 0 };
  let count = 0;
  for (const id of conn.observationIds) {
    const o = obsById.get(id) as Observation;
    const vec = effectiveVector(o);
    if (!vec) return null; // 存在仅方位边 → 该连接无尺度
    const { effFrom } = effectiveEndpoints(o);
    const sign = effFrom === conn.u ? 1 : -1;
    sum = { e: sum.e + sign * vec.e, n: sum.n + sign * vec.n, z: sum.z + sign * vec.z };
    count++;
  }
  if (count === 0) return null;
  return { e: sum.e / count, n: sum.n / count, z: sum.z / count };
}

/** 计算最小独立闭合路及其闭合差。 */
export function computeLoops(
  stations: Station[],
  observations: Observation[],
  compOf: Map<string, number>,
): LoopInfo[] {
  const conns = buildConnections(observations);
  const obsById = new Map(observations.map((o) => [o.id, o]));
  const staById = new Map(stations.map((s) => [s.id, s]));
  const connLength = (c: Connection): number => {
    const a = staById.get(c.u)?.approx;
    const b = staById.get(c.v)?.approx;
    if (!a || !b) return 1;
    return Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  };
  const compIds = [...new Set(compOf.values())].sort((a, b) => a - b);
  const loops: LoopInfo[] = [];
  for (const comp of compIds) {
    const nodes = stations.filter((s) => compOf.get(s.id) === comp).map((s) => s.id);
    const compConns = conns.filter((c) => compOf.get(c.u) === comp);
    const basis = minimumCycleBasis(nodes, compConns, connLength);
    basis.forEach((cyc, i) => {
      const path = cyc.path;
      let misclosure: Vec3 | null = { e: 0, n: 0, z: 0 };
      let length = 0;
      let azimuthClosure: number | null = null;
      const usedObsIds: string[] = [];
      for (let k = 0; k + 1 < path.length; k++) {
        const conn = compConns.find((c) => c.key === pairKey(path[k], path[k + 1])) as Connection;
        usedObsIds.push(...conn.observationIds);
        const mean = connectionMeanVector(conn, obsById);
        if (mean === null) {
          misclosure = null;
        } else if (misclosure) {
          const sign = conn.u === path[k] ? 1 : -1;
          misclosure = {
            e: misclosure.e + sign * mean.e,
            n: misclosure.n + sign * mean.n,
            z: misclosure.z + sign * mean.z,
          };
        }
        length += connLength(conn);
        // 往返方位不符值：同一连接多条有效方位归算到 u→v 方向后的最大差异（最短环绕）
        const azList: number[] = [];
        for (const oid of conn.observationIds) {
          const o = obsById.get(oid) as Observation;
          const az = effectiveAzimuth(o);
          if (az == null) continue;
          const { effFrom } = effectiveEndpoints(o);
          azList.push((((effFrom === conn.u ? az : az + 180) % 360) + 360) % 360);
        }
        for (let a = 0; a < azList.length; a++)
          for (let b = a + 1; b < azList.length; b++) {
            const d = Math.abs(wrapDeg(azList[a] - azList[b]));
            if (azimuthClosure === null || d > azimuthClosure) azimuthClosure = d;
          }
      }
      const absF = misclosure ? Math.hypot(misclosure.e, misclosure.n, misclosure.z) : null;
      loops.push({
        id: `L${comp + 1}-${i + 1}`,
        component: comp,
        path,
        observationIds: [...new Set(usedObsIds)],
        misclosure,
        length,
        azimuthClosure,
        relative: absF != null && absF > 0 ? length / absF : null,
      });
    });
  }
  return loops;
}
