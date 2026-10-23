import { z } from 'zod';
const coord = z.tuple([z.number().min(124).max(132), z.number().min(33).max(40)]);
const place = z.object({ id: z.string().max(100), name: z.string().max(200), address: z.string().max(300), coord }).strict();
export const requestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('search'), query: z.string().min(2).max(150), address: z.boolean().optional() }).strict(),
    z.object({ action: z.literal('journey'), start: place, end: place, profile: z.enum(['수동 휠체어', '전동 휠체어', '유아차', '보행 보조기']) }).strict(),
]);
const finding = z.object({ status: z.enum(['clear', 'caution', 'blocked', 'unknown']), reason: z.string(), evidence: z.array(z.string()), limitations: z.array(z.string()), pathVisible: z.boolean() });
const sample = z.object({ id: z.string(), coord, heading: z.number(), along: z.number(), critical: z.boolean() });
const route = z.object({ id: z.string(), name: z.string(), options: z.array(z.string()), coords: z.array(coord), distance: z.number(), seconds: z.number(), steps: z.array(z.object({ text: z.string(), coord })), samples: z.array(sample), fetchedAt: z.string() });
const evidence = z.object({ sampleId: z.string(), status: finding.shape.status, reason: z.string(), finding: finding.optional(), source: z.object({ url: z.string().url(), capturedAt: z.number(), coord, distance: z.number() }).optional(), checkedAt: z.string() });
export const journeyResponse = z.object({ routes: z.array(route), evidence: z.record(evidence), recommendedId: z.string().nullable(), status: z.enum(['ready', 'limited']) });
export const searchResponse = z.object({ places: z.array(place) });
