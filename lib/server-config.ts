import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
const names = ['TMAP_API_KEY', 'CHATKHU_API_KEY', 'CHATKHU_MODEL', 'MAPILLARY_TOKEN', 'ROADVIEW_RENDERER_URL', 'ROADVIEW_RENDERER_TOKEN'] as const;
export type ServerEnv = Partial<Record<typeof names[number], string>>;
const context = new AsyncLocalStorage<ServerEnv>();
export function runWithServerEnv<T>(env: ServerEnv, run: () => T): T { return context.run(env, run); }
const configSchema = z.object({
    tmap: z.string().min(1), ai: z.string().min(1), model: z.string().regex(/^(gemini|claude)-[a-z0-9.-]+$/),
    mapillary: z.string(), rendererUrl: z.string().url().optional(), rendererToken: z.string(),
}).superRefine((v, ctx) => {
    if (!v.mapillary && !v.rendererUrl)
        ctx.addIssue({ code: 'custom', message: 'Imagery unavailable' });
    if (v.rendererUrl) {
        const u = new URL(v.rendererUrl);
        if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || !v.rendererToken)
            ctx.addIssue({ code: 'custom', message: 'Invalid renderer configuration' });
    }
});
export type ServerConfig = z.infer<typeof configSchema>;
export function serverConfig(): ServerConfig {
    const env = context.getStore() ?? process.env;
    return configSchema.parse({ tmap: env.TMAP_API_KEY ?? '', ai: env.CHATKHU_API_KEY ?? '', model: env.CHATKHU_MODEL || 'gemini-3.8-flash', mapillary: env.MAPILLARY_TOKEN ?? '', rendererUrl: env.ROADVIEW_RENDERER_URL || undefined, rendererToken: env.ROADVIEW_RENDERER_TOKEN ?? '' });
}
export function searchKey(): string { return z.string().min(1).parse((context.getStore() ?? process.env).TMAP_API_KEY); }
