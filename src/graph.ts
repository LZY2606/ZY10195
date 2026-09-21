import type { Observation, Station } from './types.js';
import { polarToVector, wrapAngleDeg } from './geometry.js';

export interface ActiveObservation extends Observation {
  activeFromStationId: string;
  activeToStationId: string;
  activeSource: 'observation' | 'flip_candidate';
}

export interface LogicalEdge {
  id: string;
  stationA: string;
  stationB: string;
  observations: ActiveObservation[];
  hasMetricDistance: boolean;
}

export function makeActiveObservations(observations: Observation[]): ActiveObservation[] {
  const activeFlips = new Map(
    observations
      .filter((observation) => observation.flipped_candidate_id !== null)
      .map((observation) => [observation.flipped_candidate_id as string, observation])
  );

  return observations.map((observation) => {
    const candidateId = observation.flipped_candidate_id;
    const flip = candidateId ? activeFlips.get(candidateId) : undefined;
    if (candidateId && flip) {
      return {
        ...observation,
        activeFromStationId: flip.candidate_from_station_id ?? flip.to_station_id,
        activeToStationId: flip.candidate_to_station_id ?? flip.from_station_id,
        azimuth_deg: observation.azimuth_deg,
        inclination_deg: observation.inclination_deg,
        instrument_height: observation.instrument_height,
        target_height: observation.target_height,
        activeSource: 'flip_candidate' as const,
      };
    }
    return {
      ...observation,
      activeFromStationId: observation.from_station_id,
      activeToStationId: observation.to_station_id,
      activeSource: 'observation' as const,
    };
  });
}

export function buildLogicalEdges(active: ActiveObservation[]): LogicalEdge[] {
  const edgeMap = new Map<string, LogicalEdge>();
  for (const observation of active) {
    const a = observation.activeFromStationId;
    const b = observation.activeToStationId;
    const key = [a, b].sort().join('\u0000');
    const existing = edgeMap.get(key);
    const edge = existing ?? {
      id: key,
      stationA: key.split('\u0000')[0],
      stationB: key.split('\u0000')[1],
      observations: [],
      hasMetricDistance: false,
    };
    edge.observations.push(observation);
    edge.hasMetricDistance ||= observation.slope_distance !== null;
    edgeMap.set(key, edge);
  }
  return [...edgeMap.values()];
}

export interface GraphComponent {
  id: string;
  stationIds: string[];
  edges: LogicalEdge[];
}

export function connectedComponents(stations: Station[], edges: LogicalEdge[]): GraphComponent[] {
  const adjacency = new Map<string, Set<string>>();
  for (const station of stations) adjacency.set(station.id, new Set());
  for (const edge of edges) {
    adjacency.get(edge.stationA)?.add(edge.stationB);
    adjacency.get(edge.stationB)?.add(edge.stationA);
  }

  const seen = new Set<string>();
  const components: GraphComponent[] = [];
  for (const station of stations) {
    if (seen.has(station.id)) continue;
    const stack = [station.id];
    const stationIds: string[] = [];
    seen.add(station.id);
    while (stack.length) {
      const current = stack.pop() as string;
      stationIds.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const inComponent = new Set(stationIds);
    components.push({
      id: `component-${components.length + 1}`,
      stationIds: stationIds.sort(),
      edges: edges.filter((edge) => inComponent.has(edge.stationA) && inComponent.has(edge.stationB)),
    });
  }
  return components;
}

interface Cycle {
  vertexSet: Set<string>;
  edges: LogicalEdge[];
  weight: number;
}

function enumerateCycles(edges: LogicalEdge[]): Cycle[] {
  const adjacency = new Map<string, Array<{ to: string; edge: LogicalEdge }>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.stationA)) adjacency.set(edge.stationA, []);
    if (!adjacency.has(edge.stationB)) adjacency.set(edge.stationB, []);
    adjacency.get(edge.stationA)!.push({ to: edge.stationB, edge });
    adjacency.get(edge.stationB)!.push({ to: edge.stationA, edge });
  }

  const cycles: Cycle[] = [];
  const vertices = [...adjacency.keys()].sort();

  for (let rootIndex = 0; rootIndex < vertices.length; rootIndex += 1) {
    const root = vertices[rootIndex];

    const walk = (current: string, startPath: string[], usedEdges: Set<string>, visitedVertices: Set<string>) => {
      const neighbors = (adjacency.get(current) ?? [])
        .filter(({ to, edge }) => {
          if (usedEdges.has(edge.id)) return false;
          if (to !== root && (to < root || visitedVertices.has(to))) return false;
          return true;
        })
        .sort((a, b) => a.to.localeCompare(b.to));

      for (const { to, edge } of neighbors) {
        const nextPath = [...startPath, to];
        const nextEdges = new Set(usedEdges);
        nextEdges.add(edge.id);
        if (to === root) {
          if (nextPath.length >= 4) {
            cycles.push({
              vertexSet: new Set(nextPath.slice(0, -1)),
              edges: [...nextEdges].map((id) => edges.find((candidate) => candidate.id === id)!),
              weight: nextEdges.size,
            });
          }
          continue;
        }
        const nextVisited = new Set(visitedVertices);
        nextVisited.add(to);
        walk(to, nextPath, nextEdges, nextVisited);
      }
    };

    walk(root, [root], new Set(), new Set([root]));
  }

  const unique = new Map<string, Cycle>();
  for (const cycle of cycles) {
    const key = [...cycle.vertexSet].sort().join('|') + ':' + [...cycle.edges].map((edge) => edge.id).sort().join('|');
    if (!unique.has(key)) unique.set(key, cycle);
  }
  return [...unique.values()].sort((a, b) => a.weight - b.weight || a.edges.map((edge) => edge.id).join('|').localeCompare(b.edges.map((edge) => edge.id).join('|')));
}


function independentCycleSet(edges: LogicalEdge[]): Cycle[] {
  const cycles = enumerateCycles(edges);
  const vectors: Array<Set<string>> = [];
  const selected: Cycle[] = [];

  for (const cycle of cycles) {
    const candidate = new Set(cycle.edges.map((edge) => edge.id));
    for (const vector of vectors) {
      if (![...vector].some((edgeId) => candidate.has(edgeId))) continue;
      for (const edgeId of vector) {
        if (candidate.has(edgeId)) candidate.delete(edgeId);
        else candidate.add(edgeId);
      }
    }
    if (candidate.size > 0) {
      vectors.push(candidate);
      selected.push(cycle);
    }
  }
  return selected;
}

export function minimumCycleBasis(component: GraphComponent): Cycle[] {
  const metricEdges = component.edges.filter((edge) => edge.hasMetricDistance);
  const expected = Math.max(0, metricEdges.length - component.stationIds.length + 1);
  return independentCycleSet(metricEdges).slice(0, expected);
}

export interface ReciprocalPair {
  edge: LogicalEdge;
  forward: ActiveObservation;
  reverse: ActiveObservation;
}

export function reciprocalPairs(edges: LogicalEdge[]): ReciprocalPair[] {
  const pairs: ReciprocalPair[] = [];
  for (const edge of edges) {
    if (edge.observations.length < 2) continue;
    for (let i = 0; i < edge.observations.length; i += 1) {
      for (let j = i + 1; j < edge.observations.length; j += 1) {
        const first = edge.observations[i];
        const second = edge.observations[j];
        if (first.activeFromStationId === second.activeToStationId && first.activeToStationId === second.activeFromStationId) {
          pairs.push({ edge, forward: first, reverse: second });
        }
      }
    }
  }
  return pairs;
}

export function reciprocalDifferences(pair: ReciprocalPair) {
  const forwardAz = pair.forward.azimuth_deg;
  const reverseAz = pair.reverse.azimuth_deg;
  const forwardIncl = pair.forward.inclination_deg;
  const reverseIncl = pair.reverse.inclination_deg;
  let azimuthDifference: number;
  if (forwardAz === null || reverseAz === null) azimuthDifference = NaN;
  else azimuthDifference = Math.abs(wrapAngleDeg(reverseAz - (forwardAz + 180)));
  const inclinationDifference = forwardIncl === null || reverseIncl === null
    ? NaN
    : Math.abs(forwardIncl + reverseIncl);
  const distanceDifference = pair.forward.slope_distance === null || pair.reverse.slope_distance === null
    ? null
    : pair.forward.slope_distance - pair.reverse.slope_distance;
  return { azimuthDifference, inclinationDifference, distanceDifference };
}

export function observationVector(observation: ActiveObservation) {
  return polarToVector(observation);
}
