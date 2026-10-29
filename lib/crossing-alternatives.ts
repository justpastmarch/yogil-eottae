import { bearing, meters, projectOnRoute, samplesFor, type BlockedPassage, type Coord, type Place, type Route } from './domain.ts';
import { discoverRouteCrossings, type CrossingMatch } from './osm-crossings.ts';
import type { GraphEdge, PedestrianGraph } from './osm-graph.ts';
import { findPedestrianPath } from './pedestrian-routing.ts';

export type CrossingProposal = {
  id: string;
  label: string;
  via: Coord[];
  crossingWayIds: number[];
  distanceMeters: number;
  crossings: { wayId: number; entry: Coord; exit: Coord }[];
  graphSegment: {
    provider: 'openstreetmap';
    snapshotAt: string;
    startGapMeters: number;
    endGapMeters: number;
    sharedRoadMeters: number;
  };
};
export type CrossingChoice = { id: string; wayIds: number[]; along: number; coord: Coord };

function positionAt(coords: Coord[], along: number): Coord | undefined {
  let total = 0;
  for (let index = 1; index < coords.length; index++) {
    const from = coords[index - 1], to = coords[index], length = meters(from, to);
    if (length > 0 && along >= total && along <= total + length) {
      const fraction = (along - total) / length;
      return [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction];
    }
    total += length;
  }
  return undefined;
}

export function crossingChoices(route: Route): CrossingChoice[] {
  const choices: CrossingChoice[] = [];
  for (const source of route.crossingSources ?? []) {
    const coord = positionAt(route.coords, source.along);
    const wayIds = [...new Set(source.wayIds)];
    if (!coord || !wayIds.length) continue;
    const id = `crossing:${wayIds.join('-')}:${source.along}`;
    if (!choices.some(choice => choice.id === id)) choices.push({ id, wayIds, along: source.along, coord });
  }
  return choices.sort((a, b) => a.along - b.along);
}

function physicalEdge(edge: GraphEdge): string {
  return JSON.stringify([edge.wayId, ...[edge.from, edge.to].sort()]);
}

function overlapsPassage(from: Coord, to: Coord, passage: BlockedPassage, tolerance = 0.25, minimumOverlap = 0.25): boolean {
  const length = meters(from, to);
  if (length <= 0) return false;
  const scale = Math.cos((from[1] + to[1]) / 2 * Math.PI / 180);
  const dx = (to[0] - from[0]) * scale, dy = to[1] - from[1];
  const squared = dx * dx + dy * dy;
  for (let index = 1; index < passage.coords.length; index++) {
    const a = passage.coords[index - 1], b = passage.coords[index];
    if (meters(a, b) <= 0) continue;
    const difference = Math.abs(bearing(from, to) - bearing(a, b)) % 180;
    if (Math.min(difference, 180 - difference) > 25) continue;
    const fraction = (point: Coord) => (((point[0] - from[0]) * scale * dx) + (point[1] - from[1]) * dy) / squared;
    const first = fraction(a), last = fraction(b);
    const low = Math.max(0, Math.min(first, last)), high = Math.min(1, Math.max(first, last));
    if ((high - low) * length < minimumOverlap) continue;
    const firstPoint: Coord = [from[0] + (to[0] - from[0]) * low, from[1] + (to[1] - from[1]) * low];
    const lastPoint: Coord = [from[0] + (to[0] - from[0]) * high, from[1] + (to[1] - from[1]) * high];
    const firstProjection = projectOnRoute([a, b], firstPoint), lastProjection = projectOnRoute([a, b], lastPoint);
    if (firstProjection && lastProjection && Math.max(firstProjection.distance, lastProjection.distance) <= tolerance) return true;
  }
  return false;
}

function excludedPassageEdges(graph: PedestrianGraph, exclusions: BlockedPassage[]): Set<string> {
  const physical = new Set<string>(), crossingWays = new Set<number>();
  const edges = new Map(graph.edges.map(edge => [physicalEdge(edge), edge]));
  for (const passage of exclusions) {
    const nearbyCrossings = new Set<number>();
    for (const [key, edge] of edges) {
      const from = graph.nodes[edge.from], to = graph.nodes[edge.to];
      if (!from || !to) continue;
      if (overlapsPassage(from.coord, to.coord, passage)) physical.add(key);
      // Provider/OSM offsets may identify a crossing only within a 5 m aligned
      // corridor with at least 6 m overlap. Never widen ordinary path exclusions,
      // and leave parallel-crossing ambiguity to complete provider validation.
      if (edge.kind === 'crossing' && overlapsPassage(from.coord, to.coord, passage, 5, 6)) nearbyCrossings.add(edge.wayId);
    }
    if (nearbyCrossings.size === 1) for (const wayId of nearbyCrossings) crossingWays.add(wayId);
  }
  return new Set(graph.edges.filter(edge => physical.has(physicalEdge(edge)) || edge.kind === 'crossing' && crossingWays.has(edge.wayId)).map(edge => edge.id));
}

function nearestNode(graph: PedestrianGraph, coord: Coord, usable: Set<string>): { id: string; distance: number } | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const id of usable) {
    const node = graph.nodes[id];
    if (!node) continue;
    const distance = meters(coord, node.coord);
    if (distance <= 100 && (!best || distance < best.distance || distance === best.distance && id < best.id)) best = { id, distance };
  }
  return best;
}

type GraphPath = { nodes: string[]; edges: GraphEdge[]; distance: number };

function mappedCrossingPaths(graph: PedestrianGraph): GraphPath[] {
  const ways = new Map<number, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'crossing') continue;
    const edges = ways.get(edge.wayId) ?? [];
    edges.push(edge);
    ways.set(edge.wayId, edges);
  }
  const paths: GraphPath[] = [];
  for (const edges of ways.values()) {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of edges) {
      const from = neighbors.get(edge.from) ?? new Set<string>();
      const to = neighbors.get(edge.to) ?? new Set<string>();
      from.add(edge.to); to.add(edge.from);
      neighbors.set(edge.from, from); neighbors.set(edge.to, to);
    }
    const endpoints = [...neighbors].filter(([, adjacent]) => adjacent.size === 1).map(([id]) => id);
    const first = endpoints[0], last = endpoints[1];
    if (endpoints.length !== 2 || !first || !last || [...neighbors.values()].some(adjacent => adjacent.size > 2)) continue;
    for (const [from, to] of [[first, last], [last, first]]) {
      const path = findPedestrianPath({ ...graph, edges }, from, to, new Set());
      if (path && path.nodes.length === neighbors.size) paths.push(path);
    }
  }
  return paths;
}

function crossingSpans(edges: GraphEdge[], graph: PedestrianGraph, mapped: GraphPath[]): CrossingProposal['crossings'] | null {
  const spans: CrossingProposal['crossings'] = [];
  for (let index = 0; index < edges.length; index++) {
    const first = edges[index];
    if (first.kind !== 'crossing') continue;
    const begin = index;
    while (edges[index + 1]?.kind === 'crossing' && edges[index + 1].wayId === first.wayId) index++;
    if (spans.some(span => span.wayId === first.wayId)) return null;
    const span = mapped.find(path => path.edges.length === index - begin + 1
      && path.edges.every((edge, offset) => edge.id === edges[begin + offset].id));
    if (!span) return null;
    const entry = graph.nodes[first.from], exit = graph.nodes[edges[index].to];
    if (!entry || !exit) return null;
    spans.push({ wayId: first.wayId, entry: entry.coord, exit: exit.coord });
  }
  return spans;
}

function avoidingNodes(graph: PedestrianGraph, excluded: ReadonlySet<string>, nodes: string[]): Set<string> {
  const blocked = new Set(nodes), edges = new Set(excluded);
  for (const edge of graph.edges) if (blocked.has(edge.from) || blocked.has(edge.to)) edges.add(edge.id);
  return edges;
}

function pathsThroughCrossing(graph: PedestrianGraph, start: string, end: string, span: GraphPath, excluded: ReadonlySet<string>): GraphPath[] {
  if (span.edges.some(edge => excluded.has(edge.id))) return [];
  const entry = span.nodes[0], exit = span.nodes[span.nodes.length - 1];
  const paths: GraphPath[] = [];
  // Reserve the whole crossing, then keep the two approaches disjoint. Trying
  // either approach first avoids privileging a shortest prefix over the suffix.
  for (const prefixFirst of [true, false]) {
    let prefix: GraphPath | null, suffix: GraphPath | null;
    if (prefixFirst) {
      prefix = findPedestrianPath(graph, start, entry, avoidingNodes(graph, excluded, span.nodes.slice(1)));
      if (!prefix) continue;
      suffix = findPedestrianPath(graph, exit, end, avoidingNodes(graph, excluded, [...prefix.nodes, ...span.nodes.slice(0, -1)]));
    } else {
      suffix = findPedestrianPath(graph, exit, end, avoidingNodes(graph, excluded, span.nodes.slice(0, -1)));
      if (!suffix) continue;
      prefix = findPedestrianPath(graph, start, entry, avoidingNodes(graph, excluded, [...suffix.nodes, ...span.nodes.slice(1)]));
    }
    if (!prefix || !suffix) continue;
    const nodes = [...prefix.nodes, ...span.nodes.slice(1), ...suffix.nodes.slice(1)];
    if (new Set(nodes).size !== nodes.length) continue;
    paths.push({ nodes, edges: [...prefix.edges, ...span.edges, ...suffix.edges], distance: prefix.distance + span.distance + suffix.distance });
  }
  return paths;
}

function hasBacktracking(coords: Coord[]): boolean {
  const origin = coords[0];
  if (!origin) return false;
  const scale = 111195 * Math.cos(origin[1] * Math.PI / 180);
  const cells = new Map<string, { coord: Coord; along: number }[]>();
  for (const sample of samplesFor(coords, [], 5)) {
    const x = Math.floor((sample.coord[0] - origin[0]) * scale / 3);
    const y = Math.floor((sample.coord[1] - origin[1]) * 111195 / 3);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if ((cells.get(`${x + dx},${y + dy}`) ?? []).some(prior => sample.along - prior.along >= 30 && meters(sample.coord, prior.coord) <= 3)) return true;
    }
    const key = `${x},${y}`, bucket = cells.get(key) ?? [];
    bucket.push(sample); cells.set(key, bucket);
  }
  return false;
}

/** Returns graph hints only. Endpoint gaps are not established pedestrian connections. */
export function discoverCrossingAlternatives(
  start: Place,
  end: Place,
  baseline: Route[],
  graph: PedestrianGraph,
  exclusions: BlockedPassage[] = [],
): CrossingProposal[] {
  const baselinePlans = baseline.map(route => {
    const sources = crossingChoices(route);
    const ways = sources.length
      ? sources.flatMap(source => source.wayIds)
      : discoverRouteCrossings(route, graph).matches.sort((a, b) => a.targets[0].along - b.targets[0].along).flatMap(match => match.wayIds);
    return ways.filter((wayId, index) => index === 0 || wayId !== ways[index - 1]);
  });
  const baselineWays = [...new Set(baselinePlans.flat())];
  if (!baselineWays.length) return [];
  const passageEdges = excludedPassageEdges(graph, exclusions);
  const usable = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'steps' || edge.access === 'blocked') continue;
    usable.add(edge.from); usable.add(edge.to);
  }
  const first = nearestNode(graph, start.coord, usable), last = nearestNode(graph, end.coord, usable);
  if (!first || !last || first.id === last.id) return [];
  const mapped = mappedCrossingPaths(graph);
  const exclusionsByWay = [new Set(baselineWays), ...baselineWays.map(way => new Set([way]))];
  const visited = new Set<string>(), seenPlans = new Set(baselinePlans.map(plan => plan.join(',')));
  const candidates: GraphPath[] = [];
  for (const excludedWays of exclusionsByWay) {
    const key = [...excludedWays].sort((a, b) => a - b).join(',');
    if (visited.has(key)) continue;
    visited.add(key);
    const excluded = new Set(passageEdges);
    for (const edge of graph.edges) if (edge.kind === 'crossing' && excludedWays.has(edge.wayId)) excluded.add(edge.id);
    for (const span of mapped) candidates.push(...pathsThroughCrossing(graph, first.id, last.id, span, excluded));
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const proposals: CrossingProposal[] = [];
  for (const path of candidates) {
    const crossings = crossingSpans(path.edges, graph, mapped);
    if (!crossings?.length) continue;
    const crossingWayIds = crossings.map(crossing => crossing.wayId), signature = crossingWayIds.join(',');
    if (seenPlans.has(signature)) continue;
    const via: Coord[] = [];
    for (const crossing of crossings) for (const coord of [crossing.entry, crossing.exit]) {
      const previous = via.at(-1);
      if (!previous || previous[0] !== coord[0] || previous[1] !== coord[1]) via.push(coord);
    }
    if (via.length > 5 || hasBacktracking(path.nodes.map(id => graph.nodes[id].coord))) continue;
    seenPlans.add(signature);
    proposals.push({
      id: `crossing-plan:${crossingWayIds.join('-')}`,
      label: `다른 횡단보도 ${proposals.length + 1}`,
      via, crossingWayIds, crossings, distanceMeters: path.distance,
      graphSegment: {
        provider: 'openstreetmap', snapshotAt: graph.snapshotAt,
        startGapMeters: first.distance, endGapMeters: last.distance,
        sharedRoadMeters: path.edges.filter(edge => edge.kind === 'shared-road').reduce((total, edge) => total + edge.length, 0),
      },
    });
    if (proposals.length === 3) break;
  }
  return proposals;
}

const CROSSING_ALIGNMENT_METERS=8;
/** Validates an explicitly selected mapped crossing against the whole provider traversal. */
export function selectedCrossingMatches(route:Route,proposal:CrossingProposal,graph:PedestrianGraph):CrossingMatch[]|null{
  if(!proposal.crossings.length||proposal.crossingWayIds.length!==proposal.crossings.length)return null;
  const matches:CrossingMatch[]=[];
  let previous=-Infinity;
  for(const [index,crossing] of proposal.crossings.entries()){
    if(proposal.crossingWayIds[index]!==crossing.wayId)return null;
    const edges=graph.edges.filter(edge=>edge.kind==='crossing'&&edge.wayId===crossing.wayId);
    if(!edges.length||edges.some(edge=>!edge.from.endsWith('@[0,0,"",""]')||!edge.to.endsWith('@[0,0,"",""]')))return null;
    const nodes=[...new Set(edges.flatMap(edge=>[edge.from,edge.to]))].map(id=>graph.nodes[id]);
    const start=nodes.find(node=>node&&meters(node.coord,crossing.entry)<.25),end=nodes.find(node=>node&&meters(node.coord,crossing.exit)<.25);
    if(!start||!end)return null;
    const path=findPedestrianPath({...graph,edges},start.id,end.id,new Set());
    if(!path||path.distance<6)return null;
    const coords=path.nodes.map(id=>graph.nodes[id].coord);
    const entry=projectOnRoute(route.coords,start.coord),exit=projectOnRoute(route.coords,end.coord);
    if(!entry||!exit||entry.distance>CROSSING_ALIGNMENT_METERS||exit.distance>CROSSING_ALIGNMENT_METERS||entry.along<previous||exit.along<=entry.along||exit.along-entry.along>path.distance+2*CROSSING_ALIGNMENT_METERS)return null;
    const travelled=exit.along-entry.along;
    const directionError=Math.abs(((bearing(entry.coord,exit.coord)-bearing(start.coord,end.coord)+540)%360)-180);
    if(travelled<Math.max(6,path.distance*.6)||directionError>35)return null;
    const patch:Coord[]=[entry.coord,...route.coords.slice(entry.segmentIndex+1,exit.segmentIndex+1),exit.coord];
    let progress=-Infinity;
    for(const sample of samplesFor(coords,[],2)){
      const projected=projectOnRoute(patch,sample.coord);
      if(!projected||projected.distance>CROSSING_ALIGNMENT_METERS||projected.along<progress-3)return null;
      progress=Math.max(progress,projected.along);
    }
    if(samplesFor(patch,[],2).some(sample=>{const projected=projectOnRoute(coords,sample.coord);return !projected||projected.distance>CROSSING_ALIGNMENT_METERS;}))return null;
    const otherWays=new Map<number,Set<string>>();
    for(const edge of graph.edges)if(edge.kind==='crossing'&&edge.wayId!==crossing.wayId&&edge.from.endsWith('@[0,0,"",""]')&&edge.to.endsWith('@[0,0,"",""]')){
      const set=otherWays.get(edge.wayId)??new Set<string>();set.add(edge.from);set.add(edge.to);otherWays.set(edge.wayId,set);
    }
    for(const [wayId,ids] of otherWays){
      const projections=[...ids].flatMap(id=>{
        const node=graph.nodes[id],point=node&&projectOnRoute(patch,node.coord);
        return point?[{node,point}]:[];
      });
      if(projections.length<2||projections.some(({point})=>point.distance>CROSSING_ALIGNMENT_METERS))continue;
      projections.sort((a,b)=>a.point.along-b.point.along);
      const first=projections[0],last=projections[projections.length-1];
      const competingPath=findPedestrianPath({...graph,edges:graph.edges.filter(edge=>edge.wayId===wayId)},first.node.id,last.node.id,new Set());
      if(!competingPath||last.point.along-first.point.along<Math.max(6,competingPath.distance*.6))continue;
      const angle=Math.abs(((bearing(first.point.coord,last.point.coord)-bearing(first.node.coord,last.node.coord)+540)%360)-180);
      if(angle<=35&&first.point.along<=CROSSING_ALIGNMENT_METERS&&last.point.along>=travelled-CROSSING_ALIGNMENT_METERS)return null;
    }
    const heading=bearing(start.coord,end.coord);
    matches.push({wayIds:[crossing.wayId],snapshotAt:graph.snapshotAt,targets:[
      {nodeId:start.id,coord:start.coord,along:entry.along,heading,target:'crossing-entry'},
      {nodeId:end.id,coord:end.coord,along:exit.along,heading,target:'crossing-exit'},
    ]});
    previous=exit.along;
  }
  return matches;
}

export function validateCrossingProposal(route:Route,proposal:CrossingProposal,graph:PedestrianGraph):boolean{
  return selectedCrossingMatches(route,proposal,graph)!==null;
}
