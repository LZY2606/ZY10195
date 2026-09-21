export type StationId = string;

export interface Station {
  id: StationId;
  name: string;
  x: number;
  y: number;
  z: number;
  locked: boolean;
}

export interface Observation {
  id: string;
  from_station_id: StationId;
  to_station_id: StationId;
  slope_distance: number | null;
  azimuth_deg: number | null;
  inclination_deg: number | null;
  instrument_height: number;
  target_height: number;
  weight: number;
  flipped_candidate_id: string | null;
  candidate_from_station_id?: string | null;
  candidate_to_station_id?: string | null;
}

export interface FlipCandidate {
  id: string;
  original_observation_id: string;
  from_station_id: StationId;
  to_station_id: StationId;
  active: boolean;
  note: string;
}

export type DefectKind = 'translationX' | 'translationY' | 'translationZ' | 'radialScale';

export interface RankDefect {
  kind: DefectKind;
  component_id: string;
  station_ids: string[];
  edge_id?: string;
  label: string;
  mode: Record<string, [number, number, number]>;
}

export interface Residual {
  observation_id: string;
  active_source: 'observation' | 'flip_candidate';
  row: string;
  observed: number | null;
  computed: number;
  residual: number | null;
  correction: number | null;
  sigma: number;
  weighted_residual: number | null;
  from_station_id: string;
  to_station_id: string;
}

export interface LoopError {
  id: string;
  kind: 'independent';
  station_ids: string[];
  edge_ids: string[];
  observation_ids: string[];
  raw_misclosure: [number, number, number];
  adjusted_misclosure: [number, number, number];
  raw_horizontal: number;
  raw_vertical: number;
  raw_3d: number;
  length: number;
}

export interface ReciprocalCheck {
  id: string;
  kind: 'reciprocal';
  edge_id: string;
  forward_observation_id: string;
  reverse_observation_id: string;
  azimuth_difference_deg: number;
  inclination_difference_deg: number;
  distance_difference: number | null;
}

export interface AdjustedCoordinate {
  station_id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  locked: boolean;
  sigma_x: number;
  sigma_y: number;
  sigma_z: number;
  ellipsoid: {
    axes: [number, number, number];
    vectors: [[number, number, number], [number, number, number], [number, number, number]];
    rank: number;
    rank_deficient: boolean;
  };
}

export interface NormalDiagnostics {
  parameters: number;
  observations: number;
  rank: number;
  degrees_of_freedom: number;
  nullity: number;
  condition_number: number | null;
  smallest_positive_eigenvalue: number | null;
  largest_eigenvalue: number | null;
  rms: number;
  weighted_sum_squares: number;
  iterations: number;
  converged: boolean;
}

export interface NetworkSummary {
  station_count: number;
  observation_count: number;
  active_observation_count: number;
  reciprocal_pair_count: number;
  flip_candidate_count: number;
  active_flip_count: number;
  locked_station_count: number;
  independent_ring_count: number;
  components: Array<{ id: string; station_ids: string[]; metric_edge_count: number; observation_count: number; locked: boolean }>;
  duplicate_names: Array<{ name: string; station_ids: string[] }>;
}

export interface AdjustmentResult {
  summary: NetworkSummary;
  loops: LoopError[];
  reciprocalChecks: ReciprocalCheck[];
  residuals: Residual[];
  coordinates: AdjustedCoordinate[];
  diagnostics: NormalDiagnostics;
  rankDefects: RankDefect[];
}

export interface RunRecord {
  id: number;
  created_at: string;
  action: string;
  lock_snapshot: Record<string, boolean>;
  weight_snapshot: Record<string, number>;
  active_candidate_snapshot: string[];
  result: AdjustmentResult;
}
