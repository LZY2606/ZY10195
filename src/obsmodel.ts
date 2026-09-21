import type { Observation, Vec3 } from './types.ts';
import { DEG2RAD, type Mat, zeros } from './math.ts';

/** 仪器标称精度：测距 5mm+2ppm，测角（方位/倾角）5″。 */
export const SIGMA_DIST_FIXED = 0.005;
export const SIGMA_DIST_PPM = 2e-6;
export const SIGMA_ANGLE_SEC = 5;
export const SIGMA_ANGLE_RAD = (SIGMA_ANGLE_SEC / 3600) * DEG2RAD;

/** 翻转候选 = 交换 from/to 标签，数值不变（物理测回不变，仅记录方向写反）。 */
export function effectiveEndpoints(o: Observation): { effFrom: string; effTo: string } {
  return o.flipped ? { effFrom: o.to, effTo: o.from } : { effFrom: o.from, effTo: o.to };
}

/** 原始记录三维向量（记录方向 from→to）。无距离时返回 null。 */
export function recordedVector(o: Observation): Vec3 | null {
  if (o.slope == null || o.azimuth == null || o.incl == null) return null;
  const az = o.azimuth * DEG2RAD;
  const inc = o.incl * DEG2RAD;
  const dh = o.slope * Math.cos(inc);
  return {
    e: dh * Math.sin(az),
    n: dh * Math.cos(az),
    z: o.slope * Math.sin(inc) + o.hi - o.ht,
  };
}

/** 有效观测向量（有效方向 effFrom→effTo）。翻转只换标签，数值不变。 */
export function effectiveVector(o: Observation): Vec3 | null {
  return recordedVector(o);
}

/** 有效方位角（度，有效方向 effFrom→effTo）。 */
export function effectiveAzimuth(o: Observation): number | null {
  return o.azimuth;
}

/** 观测向量协方差 Σ = J·diag(σs²,σα²,σβ²)·Jᵀ（3x3）。 */
export function vectorCovariance(o: Observation): Mat | null {
  if (o.slope == null || o.azimuth == null || o.incl == null) return null;
  const s = o.slope;
  const az = o.azimuth * DEG2RAD;
  const inc = o.incl * DEG2RAD;
  const dh = s * Math.cos(inc);
  const j = zeros(3, 3);
  // ΔE
  j[0][0] = Math.cos(inc) * Math.sin(az);
  j[0][1] = dh * Math.cos(az);
  j[0][2] = -s * Math.sin(inc) * Math.sin(az);
  // ΔN
  j[1][0] = Math.cos(inc) * Math.cos(az);
  j[1][1] = -dh * Math.sin(az);
  j[1][2] = -s * Math.sin(inc) * Math.cos(az);
  // ΔZ
  j[2][0] = Math.sin(inc);
  j[2][1] = 0;
  j[2][2] = s * Math.cos(inc);
  const sd = SIGMA_DIST_FIXED + SIGMA_DIST_PPM * s;
  const d = [sd * sd, SIGMA_ANGLE_RAD * SIGMA_ANGLE_RAD, SIGMA_ANGLE_RAD * SIGMA_ANGLE_RAD];
  const out = zeros(3, 3);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += j[r][k] * d[k] * j[c][k];
      out[r][c] = sum;
    }
  return out;
}
