import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
const names = ['NAVER_MAP_CLIENT_ID', 'KAKAO_REST_API_KEY', 'TMAP_API_KEY', 'CHATKHU_API_KEY', 'CHATKHU_MODEL', 'MAPILLARY_TOKEN', 'ROADVIEW_RENDERER_URL', 'ROADVIEW_RENDERER_TOKEN', 'STREET_IMAGERY_PROVIDER', 'ODSAY_API_KEY', 'OSM_OVERPASS_URL', 'GOOGLE_STREET_VIEW_API_KEY'] as const;
export type ServerEnv = Partial<Record<typeof names[number], string>> & {DB?: D1Database};
export type RoutingConfig = { kind: 'kakao'; restKey: string } | { kind: 'tmap'; apiKey: string };
const context = new AsyncLocalStorage<ServerEnv>();
export function runWithServerEnv<T>(env: ServerEnv, run: () => T): T { return context.run(env, run); }
const configSchema = z.object({
    routing: z.discriminatedUnion('kind', [z.object({kind:z.literal('kakao'),restKey:z.string().min(1)}),z.object({kind:z.literal('tmap'),apiKey:z.string().min(1)})]), ai: z.string().min(1), model: z.string().regex(/^(gemini|claude)-[a-z0-9.-]+$/),
    mapillary: z.string(), rendererUrl: z.string().url().optional(), rendererToken: z.string(), imageryProvider:z.enum(['configured','kartaview','google']).optional(), googleStreetViewKey:z.string().optional(), osmEndpoint:z.string().url().optional(),
}).superRefine((v, ctx) => {
    if (v.rendererUrl) {
        const u = new URL(v.rendererUrl);
        const local = process.env.NODE_ENV !== 'production' && u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname);
        if ((!local && u.protocol !== 'https:') || u.username || u.password || u.hash || u.search || !v.rendererToken)
            ctx.addIssue({ code: 'custom', message: 'Invalid renderer configuration' });
    }
});
export type ServerConfig = z.infer<typeof configSchema>;
export function serverConfig(): ServerConfig {
    const env = context.getStore() ?? process.env;
    return configSchema.parse({ routing: routingConfig(), ai: env.CHATKHU_API_KEY ?? '', model: env.CHATKHU_MODEL || 'gemini-3.8-flash', mapillary: env.MAPILLARY_TOKEN ?? '', rendererUrl: env.ROADVIEW_RENDERER_URL || undefined, rendererToken: env.ROADVIEW_RENDERER_TOKEN ?? '', imageryProvider:env.STREET_IMAGERY_PROVIDER?.trim()||undefined, googleStreetViewKey:env.GOOGLE_STREET_VIEW_API_KEY?.trim()||undefined, osmEndpoint:env.OSM_OVERPASS_URL?.trim() || (import.meta.env?.DEV ? 'http://127.0.0.1:8789/api/interpreter' : undefined) });
}
export function routingConfig(): RoutingConfig {
    const env = context.getStore() ?? process.env;
    if (env.KAKAO_REST_API_KEY?.trim()) return {kind:'kakao',restKey:env.KAKAO_REST_API_KEY.trim()};
    return {kind:'tmap',apiKey:z.string().trim().min(1).parse(env.TMAP_API_KEY)};
}
export function transitApiKey():string|undefined {
    return (context.getStore() ?? process.env).ODSAY_API_KEY?.trim() || undefined;
}
export function publicMapConfig() {
    return {clientId:z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/).parse((context.getStore() ?? process.env).NAVER_MAP_CLIENT_ID)};
}

export function serverDatabase(): D1Database {
    const db=context.getStore()?.DB;
    if(!db) throw new Error('Journey database is unavailable.');
    return db;
}
