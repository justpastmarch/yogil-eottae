import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
const names = ['KAKAO_JAVASCRIPT_KEY', 'KAKAO_REST_API_KEY', 'TMAP_API_KEY', 'CHATKHU_API_KEY', 'CHATKHU_MODEL', 'MAPILLARY_TOKEN', 'ROADVIEW_RENDERER_URL', 'ROADVIEW_RENDERER_TOKEN'] as const;
export type ServerEnv = Partial<Record<typeof names[number], string>>;
export type RoutingConfig = { kind: 'kakao'; restKey: string } | { kind: 'tmap'; apiKey: string };
const context = new AsyncLocalStorage<ServerEnv>();
export function runWithServerEnv<T>(env: ServerEnv, run: () => T): T { return context.run(env, run); }
const configSchema = z.object({
    routing: z.discriminatedUnion('kind', [z.object({kind:z.literal('kakao'),restKey:z.string().min(1)}),z.object({kind:z.literal('tmap'),apiKey:z.string().min(1)})]), ai: z.string().min(1), model: z.string().regex(/^(gemini|claude)-[a-z0-9.-]+$/),
    mapillary: z.string(), rendererUrl: z.string().url().optional(), rendererToken: z.string(),
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
    return configSchema.parse({ routing: routingConfig(), ai: env.CHATKHU_API_KEY ?? '', model: env.CHATKHU_MODEL || 'gemini-3.8-flash', mapillary: env.MAPILLARY_TOKEN ?? '', rendererUrl: env.ROADVIEW_RENDERER_URL || undefined, rendererToken: env.ROADVIEW_RENDERER_TOKEN ?? '' });
}
export function routingConfig(): RoutingConfig {
    const env = context.getStore() ?? process.env;
    if (env.KAKAO_REST_API_KEY?.trim()) return {kind:'kakao',restKey:env.KAKAO_REST_API_KEY.trim()};
    return {kind:'tmap',apiKey:z.string().trim().min(1).parse(env.TMAP_API_KEY)};
}
export function publicMapConfig() {
    return {javascriptKey:z.string().trim().regex(/^[a-f0-9]{32}$/i).parse((context.getStore() ?? process.env).KAKAO_JAVASCRIPT_KEY)};
}
