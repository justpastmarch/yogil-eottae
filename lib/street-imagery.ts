import { z } from 'zod';
import { imageInput, MAX_IMAGE_BYTES } from './khu';
import { meters, type Sample } from './domain';
import type { ServerConfig } from './server-config';
const coordinate = z.tuple([z.number().min(124).max(132), z.number().min(33).max(40)]);
const source = z.object({ url: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && ['map.kakao.com', 'kko.to', 'map.naver.com', 'naver.me', 'www.mapillary.com'].includes(u.hostname); }), capturedAt: z.number().min(0).refine(value => value <= Date.now()), coord: coordinate, heading: z.number().min(0).max(360) });
const rendered = z.object({ image: imageInput, source });
export type StreetImage = {
    image: z.infer<typeof imageInput>;
    source: z.infer<typeof source>;
};
const capture = z.object({ id: z.string(), geometry: z.object({ coordinates: coordinate }), captured_at: z.number(), thumb_1024_url: z.string().url(), compass_angle: z.number().nullable().optional(), is_pano: z.boolean().optional() });
const captures = z.object({ data: z.array(capture), paging: z.object({ next: z.string().optional() }).optional() });
export class ImageryServiceError extends Error {
    constructor(public status:number){super('Imagery service unavailable');}
}
async function checkedFetch(url: string, init: RequestInit, signal: AbortSignal) { const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) }); if (!response.ok)
    throw new ImageryServiceError(response.status); return response; }
async function boundedBytes(response: Response, max: number) { const reader = response.body?.getReader(); if (!reader)
    throw new Error('Empty image'); const chunks: Uint8Array[] = []; let size = 0; while (true) {
    const chunk = await reader.read();
    if (chunk.done)
        break;
    size += chunk.value.length;
    if (size > max) {
        await reader.cancel();
        throw new Error('Image too large');
    }
    chunks.push(chunk.value);
} const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
} return bytes; }
async function mapillary(sample: Sample, config: ServerConfig, signal: AbortSignal): Promise<StreetImage | null> {
    const [x, y] = sample.coord, dy = 25 / 111320, dx = dy / Math.cos(y * Math.PI / 180);
    const params = new URLSearchParams({ fields: 'id,geometry,captured_at,thumb_1024_url,compass_angle,is_pano', bbox: [x - dx, y - dy, x + dx, y + dy].join(','), limit: '2000' });
    const result = captures.parse(await (await checkedFetch('https://graph.mapillary.com/images?' + params, { headers: { Authorization: 'OAuth ' + config.mapillary } }, signal)).json());
    if (result.paging?.next || result.data.length >= 2000)
        return null;
    const candidate = result.data.filter(i => !i.is_pano && i.compass_angle != null && meters(sample.coord, i.geometry.coordinates) <= 20 && Math.abs(((i.compass_angle - sample.heading + 540) % 360) - 180) < 65 && i.captured_at <= Date.now() && Date.now() - i.captured_at <= 365 * 86400000).sort((a, b) => b.captured_at - a.captured_at)[0];
    if (!candidate || candidate.compass_angle == null)
        return null;
    const url = new URL(candidate.thumb_1024_url);
    if (url.protocol !== 'https:' || !(url.hostname.endsWith('.fbcdn.net') || url.hostname.endsWith('.mapillary.com')))
        throw new Error('Invalid image host');
    const response = await checkedFetch(url.href, {}, signal), bytes = await boundedBytes(response, MAX_IMAGE_BYTES);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const image = imageInput.parse({ mime: response.headers.get('content-type')?.split(';')[0], data: btoa(binary) });
    return { image, source: { url: 'https://www.mapillary.com/app/?pKey=' + encodeURIComponent(candidate.id) + '&focus=photo', capturedAt: candidate.captured_at, coord: candidate.geometry.coordinates, heading: candidate.compass_angle } };
}
export async function streetImage(sample: Sample, config: ServerConfig, signal: AbortSignal): Promise<StreetImage | null> {
    if (config.rendererUrl) {
        const response = await checkedFetch(config.rendererUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + config.rendererToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ coord: sample.coord, heading: sample.heading }) }, signal);
        const bytes = await boundedBytes(response, 6 * 1024 * 1024), raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (raw !== null) {
            const image = rendered.parse(raw);
            if (meters(sample.coord, image.source.coord) > 20 || Math.abs(((image.source.heading - sample.heading + 540) % 360) - 180) > 65 || Date.now() - image.source.capturedAt > 365 * 86400000)
                return null;
            return image;
        }
    }
    return config.mapillary ? mapillary(sample, config, signal) : null;
}
