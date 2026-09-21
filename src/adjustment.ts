import type {
  AdjustedCoordinate,
  AdjustmentResult,
  LoopError,
  NormalDiagnostics,
  Observation,
  RankDefect,
  ReciprocalCheck,
  Residual,
  Station,
} from './types.js';
import { add3, norm3, polarToVector, radToDeg, scale3, wrapAngleDeg } from './geometry.js';
import {
  buildLogicalEdges,
  connectedComponents,
  makeActiveObservations,
  minimumCycleBasis,
  observationVector,
  reciprocalDifferences,
  reciprocalPairs,
  type ActiveObservation,
  type LogicalEdge,
} from './graph.js';
import { eigen3, matMul, matVec, pseudoInverseNormal, transpose, zeros, type Matrix } from './matrix.js';

interface Row {
  observation: ActiveObservation;
  type: 'distance' | 'azimuth' | 'inclination';
  observed: number;
  sigma: number;
  weight: number;
}

function buildRows(observations: ActiveObservation[]): Row[] {
  const rows: Row[] = [];
  for (const observation of observations) {
    const baseWeight = Math.max(0, observation.weight);
    if (observation.slope_distance !== null) rows.push({ observation, type: 'distance', observed: observation.slope_distance, sigma: 0.005, weight: baseWeight });
    if (observation.azimuth_deg !== null) rows.push({ observation, type: 'azimuth', observed: observation.azimuth_deg, sigma: 0.02, weight: baseWeight });
    if (observation.inclination_deg !== null) rows.push({ observation, type: 'inclination', observed: observation.inclination_deg, sigma: 0.02, weight: baseWeight });
  }
  return rows.filter((row) => row.weight > 0);
}

function computedValue(row: Row, coordinates: Map<string, [number, number, number]>) {
  const from = coordinates.get(row.observation.activeFromStationId)!;
  const to = coordinates.get(row.observation.activeToStationId)!;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2] + row.observation.target_height - row.observation.instrument_height;
  const horizontal = Math.hypot(dx, dy);
  const rho = Math.hypot(dx, dy, dz);
  if (row.type === 'distance') return rho;
  if (row.type === 'azimuth') return ((radToDeg(Math.atan2(dx, dy)) % 360) + 360) % 360;
  return radToDeg(Math.atan2(dz, horizontal));
}

function observedResidual(row: Row, computed: number): number {
  if (row.type === 'distance') return computed - row.observed;
  return wrapAngleDeg(computed - row.observed);
}

function derivatives(row: Row, coordinates: Map<string, [number, number, number]>) {
  const from = coordinates.get(row.observation.activeFromStationId)!;
  const to = coordinates.get(row.observation.activeToStationId)!;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2] + row.observation.target_height - row.observation.instrument_height;
  const horizontal2 = dx * dx + dy * dy;
  const horizontal = Math.sqrt(horizontal2);
  const rho = Math.hypot(dx, dy, dz);

  if (row.type === 'distance') {
    const common = [dx / rho, dy / rho, dz / rho] as [number, number, number];
    return { from: scale3(common, -1), to: common };
  }
  if (row.type === 'azimuth') {
    const scale = 180 / Math.PI;
    return {
      from: [dy / horizontal2 * scale, -dx / horizontal2 * scale, 0] as [number, number, number],
      to: [-dy / horizontal2 * scale, dx / horizontal2 * scale, 0] as [number, number, number],
    };
  }
  const scale = 180 / Math.PI;
  return {
    from: [dx * dz / (rho * rho * horizontal) * scale, dy * dz / (rho * rho * horizontal) * scale, -horizontal / (rho * rho) * scale] as [number, number, number],
    to: [-dx * dz / (rho * rho * horizontal) * scale, -dy * dz / (rho * rho * horizontal) * scale, horizontal / (rho * rho) * scale] as [number, number, number],
  };
}

function structurallyDefectStationIds(stations: Station[], edges: LogicalEdge[]): Set<string> {
  const components = connectedComponents(stations, edges);
  const ids = new Set<string>();
  for (const component of components) {
    const locked = component.stationIds.some((id) => stations.find((station) => station.id === id)?.locked);
    const hasDistance = component.edges.some((edge) => edge.hasMetricDistance);
    if (!locked && !hasDistance) component.stationIds.forEach((id) => ids.add(id));
  }
  return ids;
}

function solveAdjustment(stations: Station[], rows: Row[], edges: LogicalEdge[]) {
  const defectStationIds = structurallyDefectStationIds(stations, edges);
  const freeStations = stations.filter((station) => !station.locked && !defectStationIds.has(station.id));
  const parameterIndex = new Map(freeStations.map((station, index) => [station.id, index]));
  let coordinates = new Map(stations.map((station) => [station.id, [station.x, station.y, station.z] as [number, number, number]]));
  let iterations = 0;
  let converged = false;
  let weightedSum = 0;
  let finalResiduals: number[] = [];

  for (iterations = 0; iterations < 60; iterations += 1) {
    const jacobian: Matrix = zeros(rows.length, freeStations.length * 3);
    const misclosure: number[] = [];
    weightedSum = 0;

    rows.forEach((row, rowIndex) => {
      const computed = computedValue(row, coordinates);
      const residual = observedResidual(row, computed);
      const scaledResidual = residual / row.sigma;
      misclosure.push(-scaledResidual * Math.sqrt(row.weight));
      weightedSum += row.weight * scaledResidual * scaledResidual;
      const derivative = derivatives(row, coordinates);
      const fromIndex = parameterIndex.get(row.observation.activeFromStationId);
      const toIndex = parameterIndex.get(row.observation.activeToStationId);
      const place = (index: number | undefined, value: [number, number, number]) => {
        if (index === undefined) return;
        const weightScale = Math.sqrt(row.weight);
        jacobian[rowIndex][index * 3] = (value[0] / row.sigma) * weightScale;
        jacobian[rowIndex][index * 3 + 1] = (value[1] / row.sigma) * weightScale;
        jacobian[rowIndex][index * 3 + 2] = (value[2] / row.sigma) * weightScale;
      };
      place(fromIndex, derivative.from);
      place(toIndex, derivative.to);
    });

    const jt = transpose(jacobian);
    const normal = matMul(jt, jacobian);
    const right = matVec(jt, misclosure);
    const { inverse, rank } = pseudoInverseNormal(normal, 1e-7);
    const correction = matVec(inverse, right);
    const currentCost = rows.reduce((sum, row) => {
      const residual = observedResidual(row, computedValue(row, coordinates)) / row.sigma;
      return sum + row.weight * residual * residual;
    }, 0);
    const correctionSize = Math.hypot(...correction);
    let step = 1;
    let bestCoordinates = coordinates;
    let bestCost = currentCost;
    for (const candidateStep of [1, 0.5, 0.25, 0.1, 0.04, 0.01]) {
      const candidateCoordinates = new Map(coordinates);
      freeStations.forEach((station, index) => {
        const current = candidateCoordinates.get(station.id)!;
        candidateCoordinates.set(station.id, [
          current[0] + correction[index * 3] * candidateStep,
          current[1] + correction[index * 3 + 1] * candidateStep,
          current[2] + correction[index * 3 + 2] * candidateStep,
        ]);
      });
      const candidateCost = rows.reduce((sum, row) => {
        const residual = observedResidual(row, computedValue(row, candidateCoordinates)) / row.sigma;
        return sum + row.weight * residual * residual;
      }, 0);
      if (candidateCost <= bestCost) {
        step = candidateStep;
        bestCost = candidateCost;
        bestCoordinates = candidateCoordinates;
      }
    }
    coordinates = bestCoordinates;
    finalResiduals = rows.map((row) => observedResidual(row, computedValue(row, coordinates)) / row.sigma);
    if (correctionSize * step < 1e-3) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  const jacobian: Matrix = zeros(rows.length, freeStations.length * 3);
  const rawResiduals: number[] = [];
  rows.forEach((row, rowIndex) => {
    const derivative = derivatives(row, coordinates);
    rawResiduals.push(observedResidual(row, computedValue(row, coordinates)));
    const fromIndex = parameterIndex.get(row.observation.activeFromStationId);
    const toIndex = parameterIndex.get(row.observation.activeToStationId);
    const place = (index: number | undefined, value: [number, number, number]) => {
      if (index === undefined) return;
      const weightScale = Math.sqrt(rows[rowIndex].weight);
      jacobian[rowIndex][index * 3] = (value[0] / rows[rowIndex].sigma) * weightScale;
      jacobian[rowIndex][index * 3 + 1] = (value[1] / rows[rowIndex].sigma) * weightScale;
      jacobian[rowIndex][index * 3 + 2] = (value[2] / rows[rowIndex].sigma) * weightScale;
    };
    place(fromIndex, derivative.from);
    place(toIndex, derivative.to);
  });
  const jt = transpose(jacobian);
  const normal = matMul(jt, jacobian);
  const pinv = pseudoInverseNormal(normal, 1e-7);
  weightedSum = rawResiduals.reduce((sum, residual, index) => sum + rows[index].weight * (residual / rows[index].sigma) ** 2, 0);

  return { coordinates, freeStations, parameterIndex, normal, pinv, rows, rawResiduals, weightedSum, iterations, converged, defectStationIds };
}

function orderCycleEdges(edges: LogicalEdge[]): Array<{ edge: LogicalEdge; forward: boolean; from: string; to: string }> {
  if (edges.length === 0) return [];
  const remaining = new Map(edges.map((edge) => [edge.id, edge]));
  const first = edges[0];
  remaining.delete(first.id);
  const ordered: Array<{ edge: LogicalEdge; forward: boolean; from: string; to: string }> = [{ edge: first, forward: true, from: first.stationA, to: first.stationB }];
  let current = first.stationB;
  const start = first.stationA;
  while (remaining.size) {
    const next = [...remaining.values()].find((edge) => edge.stationA === current || edge.stationB === current);
    if (!next) break;
    remaining.delete(next.id);
    const forward = next.stationA === current;
    const from = current;
    const to = forward ? next.stationB : next.stationA;
    ordered.push({ edge: next, forward, from, to });
    current = to;
  }
  if (current !== start) {
    ordered[0] = { edge: first, forward: false, from: first.stationB, to: first.stationA };
    current = first.stationB;
    for (const item of ordered.slice(1)) {
      item.from = current;
      item.forward = item.edge.stationA === current;
      item.to = item.forward ? item.edge.stationB : item.edge.stationA;
      current = item.to;
    }
  }
  return ordered;
}

function edgeRawVector(edge: LogicalEdge, from: string, to: string): [number, number, number] {
  let sum: [number, number, number] = [0, 0, 0];
  for (const observation of edge.observations) {
    const vector = observationVector(observation);
    const oriented: [number, number, number] = observation.activeFromStationId === from && observation.activeToStationId === to
      ? [vector.dx, vector.dy, vector.dz]
      : observation.activeFromStationId === to && observation.activeToStationId === from
        ? [-vector.dx, -vector.dy, -vector.dz]
        : [0, 0, 0];
    sum = add3(sum, oriented);
  }
  return scale3(sum, 1 / edge.observations.length);
}

function edgeAdjustedVector(edge: LogicalEdge, from: string, to: string, coordinates: Map<string, [number, number, number]>): [number, number, number] {
  const a = coordinates.get(from)!;
  const b = coordinates.get(to)!;
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

function buildLoops(
  stations: Station[],
  edges: LogicalEdge[],
  coordinates: Map<string, [number, number, number]>
): LoopError[] {
  const components = connectedComponents(stations, edges);
  const loops: LoopError[] = [];
  for (const component of components) {
    for (const cycle of minimumCycleBasis(component)) {
      const ordered = orderCycleEdges(cycle.edges);
      let raw: [number, number, number] = [0, 0, 0];
      let adjusted: [number, number, number] = [0, 0, 0];
      let length = 0;
      for (const item of ordered) {
        const rawVector = edgeRawVector(item.edge, item.from, item.to);
        const adjustedVector = edgeAdjustedVector(item.edge, item.from, item.to, coordinates);
        raw = add3(raw, rawVector);
        adjusted = add3(adjusted, adjustedVector);
        length += Math.hypot(rawVector[0], rawVector[1], rawVector[2]);
      }
      loops.push({
        id: `loop-${loops.length + 1}`,
        kind: 'independent',
        station_ids: ordered.map((item) => item.from),
        edge_ids: ordered.map((item) => item.edge.id),
        observation_ids: cycle.edges.flatMap((edge) => edge.observations.map((observation) => observation.id)),
        raw_misclosure: raw,
        adjusted_misclosure: adjusted,
        raw_horizontal: Math.hypot(raw[0], raw[1]),
        raw_vertical: raw[2],
        raw_3d: norm3(raw),
        length,
      });
    }
  }
  return loops;
}

function buildReciprocalChecks(edges: LogicalEdge[]): ReciprocalCheck[] {
  return reciprocalPairs(edges).map((pair, index) => {
    const differences = reciprocalDifferences(pair);
    return {
      id: `reciprocal-${index + 1}`,
      kind: 'reciprocal',
      edge_id: pair.edge.id,
      forward_observation_id: pair.forward.id,
      reverse_observation_id: pair.reverse.id,
      azimuth_difference_deg: differences.azimuthDifference,
      inclination_difference_deg: differences.inclinationDifference,
      distance_difference: differences.distanceDifference,
    };
  });
}

function buildResiduals(rows: Row[], rawResiduals: number[]): Residual[] {
  return rows.map((row, index) => {
    const residual = rawResiduals[index];
    return {
      observation_id: row.observation.id,
      active_source: row.observation.activeSource,
      row: `${row.observation.id}/${row.type}`,
      observed: row.observed,
      computed: row.observed + residual,
      residual,
      correction: -residual,
      sigma: row.sigma,
      weighted_residual: residual / row.sigma,
      from_station_id: row.observation.activeFromStationId,
      to_station_id: row.observation.activeToStationId,
    };
  });
}

function buildCoordinates(
  stations: Station[],
  coordinates: Map<string, [number, number, number]>,
  parameterStations: Station[],
  covariance: Matrix,
  structurallyDefectIds: Set<string>
): AdjustedCoordinate[] {
  const parameterIndex = new Map(parameterStations.map((station, index) => [station.id, index]));
  return stations.map((station) => {
    const coordinate = coordinates.get(station.id)!;
    if (station.locked) {
      return {
        station_id: station.id,
        name: station.name,
        x: coordinate[0],
        y: coordinate[1],
        z: coordinate[2],
        locked: true,
        sigma_x: 0,
        sigma_y: 0,
        sigma_z: 0,
        ellipsoid: { axes: [0, 0, 0], vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], rank: 3, rank_deficient: false },
      };
    }
    if (structurallyDefectIds.has(station.id)) {
      return {
        station_id: station.id,
        name: station.name,
        x: coordinate[0],
        y: coordinate[1],
        z: coordinate[2],
        locked: false,
        sigma_x: Number.NaN,
        sigma_y: Number.NaN,
        sigma_z: Number.NaN,
        ellipsoid: { axes: [Number.NaN, Number.NaN, Number.NaN], vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], rank: 0, rank_deficient: true },
      };
    }
    const index = parameterIndex.get(station.id)!;
    const block: Matrix = zeros(3, 3);
    for (const row of [0, 1, 2]) {
      for (const column of [0, 1, 2]) block[row][column] = Math.max(0, covariance[index * 3 + row][index * 3 + column]);
    }
    const eigen = eigen3(block);
    const rank = eigen.values.filter((value) => value > 1e-10).length;
    return {
      station_id: station.id,
      name: station.name,
      x: coordinate[0],
      y: coordinate[1],
      z: coordinate[2],
      locked: false,
      sigma_x: Math.sqrt(Math.max(0, block[0][0])),
      sigma_y: Math.sqrt(Math.max(0, block[1][1])),
      sigma_z: Math.sqrt(Math.max(0, block[2][2])),
      ellipsoid: {
        axes: eigen.values.map((value) => 2.79 * Math.sqrt(Math.max(0, value))) as [number, number, number],
        vectors: [0, 1, 2].map((axis) => [eigen.vectors[0][axis], eigen.vectors[1][axis], eigen.vectors[2][axis]]) as AdjustedCoordinate['ellipsoid']['vectors'],
        rank,
        rank_deficient: rank < 3,
      },
    };
  });
}

export function adjustNetwork(stationsInput: Station[], observationsInput: Observation[]): AdjustmentResult {
  const stations = stationsInput.map((station) => ({ ...station }));
  const active = makeActiveObservations(observationsInput);
  const activeEdges = buildLogicalEdges(active);
  const originalEdges = buildLogicalEdges(observationsInput.map((observation) => ({
    ...observation,
    activeFromStationId: observation.from_station_id,
    activeToStationId: observation.to_station_id,
    activeSource: 'observation' as const,
  })));
  const rows = buildRows(active);
  const solved = solveAdjustment(stations, rows, activeEdges);
  const positive = solved.pinv.values.filter((value) => value > 1e-8 * Math.max(1, ...solved.pinv.values.map((item) => Math.abs(item))));
  const parameters = stations.filter((station) => !station.locked).length * 3;
  const structuralRanks = [...structuralRankByComponent(stations, activeEdges).values()].reduce((sum, value) => sum + value, 0);
  const rank = solved.pinv.rank + structuralRanks;
  const diagnostics: NormalDiagnostics = {
    parameters,
    observations: rows.length,
    rank,
    degrees_of_freedom: rows.length - rank,
    nullity: parameters - rank,
    condition_number: positive.length ? Math.max(...positive) / Math.min(...positive) : null,
    smallest_positive_eigenvalue: positive.length ? Math.min(...positive) : null,
    largest_eigenvalue: solved.pinv.values.length ? Math.max(...solved.pinv.values) : null,
    rms: Math.sqrt(solved.weightedSum / Math.max(1, rows.length - rank)),
    weighted_sum_squares: solved.weightedSum,
    iterations: solved.iterations,
    converged: solved.converged,
  };
  const components = connectedComponents(stations, activeEdges);
  const duplicateDetailed = [...new Set(stations.map((station) => station.name))]
    .map((name) => ({ name, station_ids: stations.filter((station) => station.name === name).map((station) => station.id) }))
    .filter((item) => item.station_ids.length > 1);

  return {
    summary: {
      station_count: stations.length,
      observation_count: observationsInput.length,
      active_observation_count: active.length,
      reciprocal_pair_count: reciprocalPairs(originalEdges).length,
      flip_candidate_count: observationsInput.filter((observation) => observation.flipped_candidate_id).length,
      active_flip_count: active.filter((observation) => observation.activeSource === 'flip_candidate').length,
      locked_station_count: stations.filter((station) => station.locked).length,
      independent_ring_count: components.reduce((sum, component) => sum + minimumCycleBasis(component).length, 0),
      components: components.map((component) => ({
        id: component.id,
        station_ids: component.stationIds,
        metric_edge_count: component.edges.filter((edge) => edge.hasMetricDistance).length,
        observation_count: component.edges.reduce((sum, edge) => sum + edge.observations.length, 0),
        locked: component.stationIds.some((id) => stations.find((station) => station.id === id)?.locked),
      })),
      duplicate_names: duplicateDetailed,
    },
    loops: buildLoops(stations, activeEdges, solved.coordinates),
    reciprocalChecks: buildReciprocalChecks(originalEdges),
    residuals: buildResiduals(rows, solved.rawResiduals),
    coordinates: buildCoordinates(stations, solved.coordinates, solved.freeStations, solved.pinv.inverse, solved.defectStationIds),
    diagnostics,
    rankDefects: buildStructuralRankDefects(stations, activeEdges),
  };
}

function componentAngleRowCount(component: ReturnType<typeof connectedComponents>[number]): number {
  return component.edges.reduce((sum, edge) => sum + edge.observations.reduce((edgeSum, observation) => {
    return edgeSum + (observation.azimuth_deg !== null ? 1 : 0) + (observation.inclination_deg !== null ? 1 : 0);
  }, 0), 0);
}

function structuralRankByComponent(stations: Station[], edges: LogicalEdge[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const component of connectedComponents(stations, edges)) {
    const locked = component.stationIds.some((id) => stations.find((station) => station.id === id)?.locked);
    const hasDistance = component.edges.some((edge) => edge.hasMetricDistance);
    if (locked || hasDistance) continue;
    const freeCount = component.stationIds.filter((id) => !stations.find((station) => station.id === id)?.locked).length;
    result.set(component.id, Math.min(freeCount * 3, componentAngleRowCount(component)));
  }
  return result;
}

export function buildStructuralRankDefects(stations: Station[], edges: LogicalEdge[]): RankDefect[] {
  const components = connectedComponents(stations, edges);
  const defects: RankDefect[] = [];
  for (const component of components) {
    const locked = component.stationIds.some((id) => stations.find((station) => station.id === id)?.locked);
    const hasDistance = component.edges.some((edge) => edge.hasMetricDistance);
    if (locked && hasDistance) continue;
    const freeCount = component.stationIds.filter((id) => !stations.find((station) => station.id === id)?.locked).length;
    const structuralRank = !hasDistance ? Math.min(freeCount * 3, componentAngleRowCount(component)) : 0;
    let remaining = freeCount * 3 - structuralRank;
    if (!locked) {
      ([
        ['translationX', '整体 X 平移不可识别', [1, 0, 0]],
        ['translationY', '整体 Y 平移不可识别', [0, 1, 0]],
        ['translationZ', '整体 Z 平移不可识别', [0, 0, 1]],
      ] as const).forEach(([kind, label, direction]) => {
        remaining -= 1;
        const mode: RankDefect['mode'] = {};
        for (const id of component.stationIds) mode[id] = [direction[0], direction[1], direction[2]];
        defects.push({ kind, component_id: component.id, station_ids: component.stationIds, label, mode });
      });
    }
    if (!hasDistance) {
      for (let index = 0; index < remaining; index += 1) {
        const stationId = component.stationIds[index % component.stationIds.length];
        const axis = index % 3;
        const direction: [number, number, number] = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
        const mode: RankDefect['mode'] = {};
        for (const id of component.stationIds) mode[id] = [0, 0, 0];
        mode[stationId] = direction;
        defects.push({
          kind: 'radialScale',
          component_id: component.id,
          station_ids: component.stationIds,
          label: '仅有方位/倾角、无斜距：该分量射线长度和相对尺度不可识别',
          mode,
        });
      }
    }
  }
  return defects;
}
