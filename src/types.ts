/** 测站：身份由 id 决定，name 仅用于展示，重名不合并。 */
export interface Station {
  id: string;
  name: string;
  /** 近似坐标 [E, N, Z]，单位米 */
  approx: [number, number, number];
  /** 已知坐标（控制点），无则为 null */
  known: [number, number, number] | null;
  /** 是否锁定为控制点（平差基准） */
  locked: boolean;
}

/**
 * 观测：测站间斜距/方位/倾角/仪器高/觇标高。
 * 原始记录字段（from/to/slope/azimuth/incl/hi/ht）永不被平差改写；
 * weight 与 flipped 属于平差候选状态，单独存放。
 */
export interface Observation {
  id: string;
  from: string;
  to: string;
  /** 斜距 m；null 表示该边无距离（仅方位） */
  slope: number | null;
  /** 方位角，度 */
  azimuth: number | null;
  /** 倾角（竖直角，水平为 0），度 */
  incl: number | null;
  /** 仪器高 m */
  hi: number;
  /** 觇标高 m */
  ht: number;
  /** 用户权重倍数（默认 1） */
  weight: number;
  /** 翻转候选：疑似写反的边，平差时按反向解释，但原记录保留 */
  flipped: boolean;
  /** 往返观测组标识；同组两条记录互为往返证据 */
  group: string | null;
}

export interface Vec3 {
  e: number;
  n: number;
  z: number;
}

export interface LoopInfo {
  id: string;
  component: number;
  /** 有序测站 id 序列（首尾相同） */
  path: string[];
  /** 有序观测 id 序列（与 path 的边对应） */
  observationIds: string[];
  /** 闭合差向量（米），方位-only 边参与时为 null */
  misclosure: Vec3 | null;
  /** 线路总长 m */
  length: number;
  /** 往返方位不符值（度）：环内含多条观测的连接上，归算到同方向后的最大方位差（最短环绕） */
  azimuthClosure: number | null;
  /** 相对闭合差 1/N */
  relative: number | null;
}

export interface ComponentInfo {
  index: number;
  stationIds: string[];
  observationIds: string[];
  loopCount: number;
  /** 秩亏分析 */
  rank: number;
  unknowns: number;
  /** 不可识别自由度（秩亏维数） */
  defect: number;
  /** 秩亏来源说明，如 ["平移基准 3 维", "尺度 1 维"] */
  defectLabels: string[];
}

export interface ObsResidual {
  observationId: string;
  from: string;
  to: string;
  flipped: boolean;
  /** 距离残差 m（观测-平差后） */
  vDist: number | null;
  /** 方位残差，秒；按最短环绕解释 */
  vAzSec: number | null;
  /** 倾角残差，秒 */
  vInclSec: number | null;
  /** 三维向量残差 [e,n,z] m */
  vVec: Vec3 | null;
}

export interface StationResult {
  id: string;
  name: string;
  adjusted: [number, number, number] | null;
  /** 水平误差椭圆：长半轴/短半轴(m)/长轴方位角(度)，1σ */
  ellipse: { a: number; b: number; thetaDeg: number } | null;
  sigmaZ: number | null;
}

export interface AdjustResult {
  ok: boolean;
  message: string;
  components: ComponentInfo[];
  loops: LoopInfo[];
  stations: StationResult[];
  residuals: ObsResidual[];
  diagnostics: {
    observations: number;
    unknowns: number;
    rank: number;
    defect: number;
    dof: number;
    sigma0: number | null;
    /** 法方程条件数粗略估计 */
    condEstimate: number | null;
  };
}
