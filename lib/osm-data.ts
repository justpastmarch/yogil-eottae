import { z } from 'zod';
import { meters, type Route } from './domain.ts';
import { buildPedestrianGraph, type PedestrianGraph } from './osm-graph.ts';

export type GraphLoadResult =
  | { kind: 'available'; graph: PedestrianGraph }
  | { kind: 'unavailable'; reason: 'not-configured' | 'network' | 'incomplete' | 'too-large' | 'no-data' };

const unavailable = (reason: Extract<GraphLoadResult, { kind: 'unavailable' }>['reason']): GraphLoadResult => ({ kind: 'unavailable', reason });
const MAX_BOXES = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 200_000;
const CACHE_TTL = 5 * 60_000;
const MAX_CACHE = 32;
const TIMEOUT = 20_000;
const id = z.number().int().positive().safe();
const tags = z.record(z.string().max(255), z.string().max(2048)).refine(value => Object.keys(value).length <= 100);
const element = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node'), id, lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180), tags: tags.optional() }),
  z.object({ type: z.literal('way'), id, nodes: z.array(id).min(2).max(10_000), tags }),
]);
const envelope = z.object({
  osm3s: z.object({ timestamp_osm_base: z.string().datetime({ offset: true }) }),
  elements: z.array(element).max(MAX_ELEMENTS),
  remark: z.string().optional(),
});
type Element = z.infer<typeof element>;

const cache = new Map<string, { expires: number; result: GraphLoadResult }>();
const flights = new Map<string, { controller: AbortController; promise: Promise<GraphLoadResult>; users: number }>();

// Split even sparse geometries into short corridors instead of one route-wide rectangle.
function queryForRoute(route: Route): string | null {
  if (route.coords.length < 2) return null;
  const boxes: string[] = [];
  let bounds: { west: number; east: number; south: number; north: number; length: number } | undefined;
  const flush = () => {
    if (!bounds) return;
    const latPad = 0.0014;
    const lonPad = latPad / Math.cos(Math.max(Math.abs(bounds.south), Math.abs(bounds.north)) * Math.PI / 180);
    const south = Math.max(-90, bounds.south - latPad);
    const west = Math.max(-180, bounds.west - lonPad);
    const north = Math.min(90, bounds.north + latPad);
    const east = Math.min(180, bounds.east + lonPad);
    boxes.push([Math.floor(south * 1e6) / 1e6, Math.floor(west * 1e6) / 1e6, Math.ceil(north * 1e6) / 1e6, Math.ceil(east * 1e6) / 1e6].join(','));
    bounds = undefined;
  };
  for (let i = 1; i < route.coords.length; i++) {
    const a = route.coords[i - 1], b = route.coords[i];
    if (![...a, ...b].every(Number.isFinite) || Math.abs(a[1]) > 85 || Math.abs(b[1]) > 85 || Math.abs(a[0]) > 180 || Math.abs(b[0]) > 180 || Math.abs(a[0] - b[0]) > 180) return null;
    const distance = meters(a, b);
    const count = Math.max(1, Math.ceil(distance / 500));
    if (count > MAX_BOXES) return null;
    for (let j = 0; j < count; j++) {
      const start = j / count, end = (j + 1) / count;
      const x1 = a[0] + (b[0] - a[0]) * start, x2 = a[0] + (b[0] - a[0]) * end;
      const y1 = a[1] + (b[1] - a[1]) * start, y2 = a[1] + (b[1] - a[1]) * end;
      const length = distance / count;
      if (bounds && bounds.length + length > 500) flush();
      if (!bounds) bounds = { west: Math.min(x1, x2), east: Math.max(x1, x2), south: Math.min(y1, y2), north: Math.max(y1, y2), length };
      else {
        bounds.west = Math.min(bounds.west, x1, x2);
        bounds.east = Math.max(bounds.east, x1, x2);
        bounds.south = Math.min(bounds.south, y1, y2);
        bounds.north = Math.max(bounds.north, y1, y2);
        bounds.length += length;
      }
      if (boxes.length >= MAX_BOXES) return null;
    }
  }
  flush();
  const selectors = [...new Set(boxes)].map(box => `way["highway"~"^(footway|path|pedestrian|steps|cycleway|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track)$"](${box});`).join('');
  return `[out:json][timeout:18];(${selectors});(._;>;);out body;`;
}

function signature(value: Element): string {
  const sortedTags = Object.entries(value.tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return value.type === 'node' ? JSON.stringify([value.lat, value.lon, sortedTags]) : JSON.stringify([value.nodes, sortedTags]);
}

function parseGraph(input: unknown): GraphLoadResult {
  const parsed = envelope.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'elements')) return unavailable('too-large');
    return unavailable('incomplete');
  }
  if (parsed.data.remark) return unavailable('incomplete');
  const unique = new Map<string, Element>();
  for (const item of parsed.data.elements) {
    const key = `${item.type}/${item.id}`;
    const previous = unique.get(key);
    if (previous && signature(previous) !== signature(item)) return unavailable('incomplete');
    if (!previous) unique.set(key, item);
  }
  for (const item of unique.values()) {
    if (item.type === 'way' && item.nodes.some(node => !unique.has(`node/${node}`))) return unavailable('incomplete');
  }
  try {
    const graph = buildPedestrianGraph({ osm3s: parsed.data.osm3s, elements: [...unique.values()] });
    return graph.edges.length ? { kind: 'available', graph } : unavailable('no-data');
  } catch {
    return unavailable('incomplete');
  }
}

async function retrieve(endpoint: string, query: string, controller: AbortController): Promise<GraphLoadResult> {
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Gileum/1.0 (pedestrian route planning)' }, body: new URLSearchParams({ data: query }), signal: controller.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return unavailable(response.status === 413 ? 'too-large' : 'network');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      await response.body.cancel();
      return unavailable('too-large');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return unavailable('too-large');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return unavailable('incomplete'); }
    return parseGraph(input);
  } catch {
    return unavailable('network');
  } finally {
    clearTimeout(timer);
  }
}

export async function loadPedestrianGraph(route: Route, signal: AbortSignal, endpoint?: string): Promise<GraphLoadResult> {
  if (signal.aborted) return unavailable('network');
  if (!endpoint) return unavailable('not-configured');
  let url: URL;
  try { url = new URL(endpoint); } catch { return unavailable('not-configured'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unavailable('not-configured');
  const query = queryForRoute(route);
  if (!query) return unavailable('too-large');
  const key = `${url.href}\n${query}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  cache.delete(key);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const entry = { controller, users: 0, promise: Promise.resolve(unavailable('network')) };
    entry.promise = retrieve(url.href, query, controller).then(result => {
      if (!controller.signal.aborted && (result.kind === 'available' || result.reason === 'no-data')) {
        cache.set(key, { expires: Date.now() + CACHE_TTL, result });
        while (cache.size > MAX_CACHE) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
      }
      return result;
    }).finally(() => { if (flights.get(key) === entry) flights.delete(key); });
    flights.set(key, entry);
    flight = entry;
  }
  const active = flight;
  active.users++;
  const { promise, resolve } = Promise.withResolvers<GraphLoadResult>();
  let finished = false;
  const finish = (result: GraphLoadResult) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    active.users--;
    if (!active.users && flights.get(key) === active) {
      flights.delete(key);
      active.controller.abort();
    }
    resolve(result);
  };
  const onAbort = () => finish(unavailable('network'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  else active.promise.then(finish);
  return promise;
}
