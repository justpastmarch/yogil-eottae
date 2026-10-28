import type { GraphEdge, PedestrianGraph } from './osm-graph.ts';

type QueueEntry = { node: string; distance: number };

function comesBefore(a: QueueEntry, b: QueueEntry): boolean {
  return a.distance < b.distance || (a.distance === b.distance && a.node < b.node);
}

function push(queue: QueueEntry[], entry: QueueEntry): void {
  let index = queue.length;
  queue.push(entry);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!comesBefore(entry, queue[parent])) break;
    queue[index] = queue[parent];
    index = parent;
  }
  queue[index] = entry;
}

function pop(queue: QueueEntry[]): QueueEntry | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (queue.length === 0 || !last) return first;

  let index = 0;
  while (index * 2 + 1 < queue.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    const child = right < queue.length && comesBefore(queue[right], queue[left]) ? right : left;
    if (!comesBefore(queue[child], last)) break;
    queue[index] = queue[child];
    index = child;
  }
  queue[index] = last;
  return first;
}

/** Finds a shortest directed path in meters. Exclusions apply to exact directed edge IDs. */
export function findPedestrianPath(
  graph: PedestrianGraph,
  startId: string,
  endId: string,
  excludedEdgeIds: ReadonlySet<string>,
): { nodes: string[]; edges: GraphEdge[]; distance: number } | null {
  if (!graph || !graph.nodes || !Array.isArray(graph.edges)) return null;

  const validNodes = new Set<string>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (
      id && node && node.id === id && Array.isArray(node.coord) && node.coord.length === 2 &&
      Number.isFinite(node.coord[0]) && Math.abs(node.coord[0]) <= 180 &&
      Number.isFinite(node.coord[1]) && Math.abs(node.coord[1]) <= 90
    ) validNodes.add(id);
  }
  if (!validNodes.has(startId) || !validNodes.has(endId)) return null;
  if (startId === endId) return { nodes: [startId], edges: [], distance: 0 };

  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (
      !edge || typeof edge.id !== 'string' || !edge.id ||
      typeof edge.from !== 'string' || typeof edge.to !== 'string' ||
      !validNodes.has(edge.from) || !validNodes.has(edge.to) ||
      !Number.isFinite(edge.length) || edge.length < 0 ||
      !Number.isSafeInteger(edge.wayId) || edge.wayId <= 0 ||
      (edge.kind !== 'sidewalk' && edge.kind !== 'crossing' && edge.kind !== 'path' && edge.kind !== 'shared-road') ||
      edge.access !== 'unknown' || excludedEdgeIds.has(edge.id)
    ) continue;
    const outgoing = adjacency.get(edge.from);
    if (outgoing) outgoing.push(edge);
    else adjacency.set(edge.from, [edge]);
  }

  const distances = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, GraphEdge>();
  const queue: QueueEntry[] = [{ node: startId, distance: 0 }];

  while (queue.length > 0) {
    const current = pop(queue);
    if (!current || current.distance !== distances.get(current.node)) continue;
    if (current.node === endId) break;

    for (const edge of adjacency.get(current.node) ?? []) {
      const distance = current.distance + edge.length;
      if (!Number.isFinite(distance) || distance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, distance);
      previous.set(edge.to, edge);
      push(queue, { node: edge.to, distance });
    }
  }

  const distance = distances.get(endId);
  if (distance === undefined) return null;
  const nodes = [endId];
  const edges: GraphEdge[] = [];
  let node = endId;
  while (node !== startId) {
    const edge = previous.get(node);
    if (!edge) return null;
    edges.push(edge);
    node = edge.from;
    nodes.push(node);
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges, distance };
}
