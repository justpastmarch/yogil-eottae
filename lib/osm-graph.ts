import { z } from 'zod';
import { meters, type Coord } from './domain.ts';

export type GraphNode = { id: string; coord: Coord };
export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  length: number;
  wayId: number;
  kind: 'sidewalk' | 'crossing' | 'path' | 'shared-road' | 'steps';
  access: 'unknown' | 'blocked';
  structure?:'tunnel';
};
export type PedestrianGraph = { nodes: Record<string, GraphNode>; edges: GraphEdge[]; snapshotAt: string };

const MAX_ELEMENTS = 200_000;
const MAX_WAY_NODES = 10_000;
const idSchema = z.number().int().positive().safe();
const tagsSchema = z.record(z.string().max(255), z.string().max(2048)).refine(tags => Object.keys(tags).length <= 100);
const nodeSchema = z.object({
  type: z.literal('node'), id: idSchema,
  lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180),
  tags: tagsSchema.optional(),
});
const waySchema = z.object({
  type: z.literal('way'), id: idSchema,
  nodes: z.array(idSchema).min(2).max(MAX_WAY_NODES), tags: tagsSchema,
});
const envelopeSchema = z.object({
  elements: z.array(z.unknown()).max(MAX_ELEMENTS),
  osm3s: z.object({ timestamp_osm_base: z.string().datetime({ offset: true }) }),
  remark: z.string().optional(),
});
type Tags = z.infer<typeof tagsSchema>;
type OsmNode = z.infer<typeof nodeSchema>;
type OsmWay = z.infer<typeof waySchema>;

const WALKING_WAYS: Record<string, true> = Object.fromEntries(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'track'].map(value => [value, true]));
const ROADS: Record<string, true> = Object.fromEntries(['living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'track'].map(value => [value, true]));
const DENIED: Record<string, true> = Object.fromEntries(['no', 'private', 'customers', 'permit', 'delivery', 'agricultural', 'forestry', 'use_sidepath'].map(value => [value, true]));

function denied(tags: Tags): boolean {
  return DENIED[tags.foot ?? tags.access ?? ''] === true;
}

function kindOf(tags: Tags): GraphEdge['kind'] | null {
  const highway = tags.highway;
  if (!highway || WALKING_WAYS[highway] !== true || tags.area === 'yes') return null;
  if (highway === 'cycleway' && tags.foot !== 'yes' && tags.foot !== 'designated' && tags.foot !== 'permissive') return null;
  if (highway === 'steps') return 'steps';
  if (tags.footway === 'crossing' || tags.path === 'crossing') return 'crossing';
  if (highway === 'footway' && tags.footway === 'sidewalk') return 'sidewalk';
  return ROADS[highway] === true ? 'shared-road' : 'path';
}

// Unknown or multi-valued vertical classifications are kept separate rather than
// guessing that two ways meet. Explicit bridge/tunnel structure also separates ways.
function verticalKey(tags: Tags): string | null {
  const layer = tags.layer ?? '0';
  const level = tags.level ?? '0';
  if (!/^-?\d+(?:\.\d+)?$/.test(layer) || !/^-?\d+(?:\.\d+)?$/.test(level)) return null;
  const bridge = tags.bridge && tags.bridge !== 'no' ? tags.bridge : '';
  const tunnel = tags.tunnel && tags.tunnel !== 'no' ? tags.tunnel : '';
  return JSON.stringify([Number(layer), Number(level), bridge, tunnel]);
}

function nodeSignature(node: OsmNode): string {
  return JSON.stringify([node.lat, node.lon, Object.entries(node.tags ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Build a directed graph from a bounded Overpass snapshot. Invalid elements are omitted. */
export function buildPedestrianGraph(input: unknown): PedestrianGraph {
  const envelope = envelopeSchema.parse(input);
  if (envelope.remark) throw new Error('Overpass snapshot reports an incomplete result');
  const osmNodes = new Map<number, OsmNode>();
  const invalidNodes = new Set<number>();
  const osmWays = new Map<number, OsmWay>();
  const invalidWays = new Set<number>();

  for (const element of envelope.elements) {
    const node = nodeSchema.safeParse(element);
    if (node.success) {
      const previous = osmNodes.get(node.data.id);
      if (previous && nodeSignature(previous) !== nodeSignature(node.data)) invalidNodes.add(node.data.id);
      else if (!previous) osmNodes.set(node.data.id, node.data);
      continue;
    }
    const way = waySchema.safeParse(element);
    if (way.success) {
      if (osmWays.has(way.data.id)) invalidWays.add(way.data.id);
      else osmWays.set(way.data.id, way.data);
      continue;
    }
    // A malformed duplicate must not leave a valid copy available for routing.
    const identity = z.object({ type: z.enum(['node', 'way']), id: idSchema }).safeParse(element);
    if (identity.success) {
      if (identity.data.type === 'node') invalidNodes.add(identity.data.id);
      else invalidWays.add(identity.data.id);
    }
  }
  const ground = JSON.stringify([0, 0, '', '']);
  const groundNodes = new Set<number>();
  const structuralEnds = new Set<number>();
  for (const way of osmWays.values()) {
    if (invalidWays.has(way.id) || !kindOf(way.tags)) continue;
    const vertical = verticalKey(way.tags);
    if (vertical === ground) for (const id of way.nodes) groundNodes.add(id);
    else if (vertical && (way.tags.bridge && way.tags.bridge !== 'no' || way.tags.tunnel && way.tags.tunnel !== 'no')) {
      structuralEnds.add(way.nodes[0]);
      structuralEnds.add(way.nodes[way.nodes.length - 1]);
    }
  }
  const portals = new Set([...structuralEnds].filter(id => groundNodes.has(id)));

  const nodes: Record<string, GraphNode> = Object.create(null);
  const edges: GraphEdge[] = [];
  for (const way of osmWays.values()) {
    if (invalidWays.has(way.id)) continue;
    const kind = kindOf(way.tags);
    const vertical = verticalKey(way.tags);
    if (!kind || vertical === null) continue;
    const direction = way.tags['oneway:foot'];
    if (direction && !['yes', '1', 'true', '-1', 'no', '0', 'false'].includes(direction)) continue;
    if(kind==='crossing'&&way.nodes.some((id,index)=>{
      const node=osmNodes.get(id),previous=index?osmNodes.get(way.nodes[index-1]):undefined;
      return !node||invalidNodes.has(id)||denied(node.tags??{})||!!previous&&(id===way.nodes[index-1]||meters([previous.lon,previous.lat],[node.lon,node.lat])<=0);
    }))continue;
    for (let i = 0; i < way.nodes.length - 1; i++) {
      const firstId = way.nodes[i];
      const secondId = way.nodes[i + 1];
      const first = osmNodes.get(firstId);
      const second = osmNodes.get(secondId);
      if (!first || !second || invalidNodes.has(firstId) || invalidNodes.has(secondId) || firstId === secondId) continue;
      if (denied(first.tags ?? {}) || denied(second.tags ?? {})) continue;
      const firstCoord: Coord = [first.lon, first.lat];
      const secondCoord: Coord = [second.lon, second.lat];
      const length = meters(firstCoord, secondCoord);
      if (!Number.isFinite(length) || length <= 0) continue;
      const key = (id:number) => portals.has(id) && (vertical===ground || (id===way.nodes[0] || id===way.nodes[way.nodes.length-1]) && (way.tags.bridge && way.tags.bridge!=='no' || way.tags.tunnel && way.tags.tunnel!=='no')) ? `${id}@portal` : `${id}@${vertical}`;
      const from = key(firstId), to = key(secondId);
      nodes[from] = { id: from, coord: firstCoord };
      nodes[to] = { id: to, coord: secondCoord };
      for(const directionName of ['forward','backward'] as const){
        if(directionName==='forward'&&direction==='-1'||directionName==='backward'&&['yes','1','true'].includes(direction??''))continue;
        const foot=way.tags[`foot:${directionName}`]??way.tags.foot??way.tags[`access:${directionName}`]??way.tags.access??'';
        const wheelchair=way.tags[`wheelchair:${directionName}`]??way.tags.wheelchair;
        const blockedNodes=first.tags?.wheelchair==='no'||second.tags?.wheelchair==='no'||['stile','turnstile','kissing_gate'].includes(first.tags?.barrier??'')||['stile','turnstile','kissing_gate'].includes(second.tags?.barrier??'');
        const access=DENIED[foot]||kind==='steps'||wheelchair==='no'||blockedNodes?'blocked':'unknown';
        edges.push({id:`${way.id}:${i}:${directionName}`,from:directionName==='forward'?from:to,to:directionName==='forward'?to:from,length,wayId:way.id,kind,access,...(way.tags.tunnel==='yes'?{structure:'tunnel'}:{})});
      }
    }
  }
  return { nodes, edges, snapshotAt: envelope.osm3s.timestamp_osm_base };
}
