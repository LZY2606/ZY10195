export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

export function wrapAngleDeg(angle: number): number {
  let value = ((angle + 180) % 360 + 360) % 360 - 180;
  if (value === -180) value = 180;
  return value;
}

export interface PolarVector {
  dx: number;
  dy: number;
  dz: number;
  length: number | null;
}

export interface PolarInput {
  slope_distance: number | null;
  azimuth_deg: number | null;
  inclination_deg: number | null;
  instrument_height: number;
  target_height: number;
}

export function polarToVector(input: PolarInput): PolarVector {
  if (input.slope_distance === null) return { dx: 0, dy: 0, dz: 0, length: null };
  const s = input.slope_distance;
  const az = input.azimuth_deg === null ? 0 : degToRad(input.azimuth_deg);
  const incl = input.inclination_deg === null ? 0 : degToRad(input.inclination_deg);
  const horizontal = s * Math.cos(incl);
  const componentZ = s * Math.sin(incl);
  return {
    dx: horizontal * Math.sin(az),
    dy: horizontal * Math.cos(az),
    dz: componentZ + input.instrument_height - input.target_height,
    length: s,
  };
}

export function add3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(a: [number, number, number], scalar: number): [number, number, number] {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

export function norm3(a: [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}
