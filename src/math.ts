/** 通用数学工具：角度环绕、向量、稠密矩阵（规模很小，直接高斯消元）。 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
/** 弧度转角秒 */
export const RAD2SEC = 180 * 3600 / Math.PI;

/** 把角度（度）归算到 (-180, 180]，用于跨零度的最短环绕解释。 */
export function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  // 上一步只处理了一圈，极端值再归一化
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

/** 方位残差：obs - comp，按最短环绕解释（度）。 */
export function azimuthResidualDeg(obsDeg: number, compDeg: number): number {
  return wrapDeg(obsDeg - compDeg);
}

export type Mat = number[][];

export function zeros(r: number, c: number): Mat {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function eye(n: number): Mat {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function matMul(a: Mat, b: Mat): Mat {
  const r = a.length, k = b.length, c = b[0].length;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++)
    for (let p = 0; p < k; p++) {
      const av = a[i][p];
      if (av === 0) continue;
      for (let j = 0; j < c; j++) out[i][j] += av * b[p][j];
    }
  return out;
}

export function matT(a: Mat): Mat {
  const out = zeros(a[0].length, a.length);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < a[0].length; j++) out[j][i] = a[i][j];
  return out;
}

export function matVec(a: Mat, x: number[]): number[] {
  return a.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
}

/** 对称（或一般）方阵求逆，部分主元高斯消元；奇异返回 null。 */
export function invert(a: Mat, tol = 1e-12): Mat | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...eye(n)[i]]);
  let maxAbs = 0;
  for (const row of a) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  const eps = tol * Math.max(maxAbs, 1e-30);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) <= eps) return null;
    if (piv !== col) [m[piv], m[col]] = [m[col], m[piv]];
    const d = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/** 解 Ax=b（A 方阵），奇异返回 null。 */
export function solve(a: Mat, b: number[]): number[] | null {
  const n = a.length;
  const inv = invert(a);
  if (!inv) return null;
  return matVec(inv, b);
}

/** 矩阵秩：行阶梯化主元计数。 */
export function rankOf(a: Mat, tol = 1e-9): number {
  const m = a.map((row) => [...row]);
  const rows = m.length, cols = m[0]?.length ?? 0;
  let maxAbs = 0;
  for (const row of m) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  const eps = tol * Math.max(maxAbs, 1e-30);
  let rank = 0;
  for (let col = 0; col < cols && rank < rows; col++) {
    let piv = rank;
    for (let r = rank + 1; r < rows; r++)
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) <= eps) continue;
    [m[piv], m[rank]] = [m[rank], m[piv]];
    const d = m[rank][col];
    for (let j = col; j < cols; j++) m[rank][j] /= d;
    for (let r = 0; r < rows; r++) {
      if (r === rank) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = col; j < cols; j++) m[r][j] -= f * m[rank][j];
    }
    rank++;
  }
  return rank;
}

/** 2x2 对称矩阵特征值（用于误差椭圆）。返回 [λmax, λmin, 长轴方位角rad(自E轴逆时针? 否: 自N轴顺时针)] */
export function eigen2x2(qee: number, qnn: number, qen: number): { l1: number; l2: number; theta: number } {
  const tr = qee + qnn;
  const det = qee * qnn - qen * qen;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  // 长轴方向：特征向量 (qen, l1 - qee)；方位角自 N 轴顺时针
  const ve = qen;
  const vn = l1 - qee;
  const theta = Math.atan2(ve, vn);
  return { l1: Math.max(0, l1), l2, theta };
}
