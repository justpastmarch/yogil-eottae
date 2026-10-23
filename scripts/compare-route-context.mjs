import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { streetImage } from '../lib/street-imagery.ts';
import { serverConfig } from '../lib/server-config.ts';
import { baselineRouteContext, routeImageContext } from '../lib/route-context.ts';
import { analyzeKhuImage } from '../lib/khu.ts';
import { bearing } from '../lib/domain.ts';

// Run capture first, label the saved images independently, then run inference.
const directory = resolve('.sites-runtime/context-study');
await mkdir(directory, { recursive: true });
const manifestPath = resolve(directory, 'manifest.json');
const config = serverConfig();
if (process.argv[2] === 'capture') {
    const original = JSON.parse(await readFile(resolve('../../outputs/journey.json'), 'utf8'));
    const journey = original.snapshot.journey;
    const candidates = journey.routes.flatMap(route => route.samples.flatMap(sample => {
        const evidence = journey.evidence[`${route.id}:${sample.id}`];
        return evidence?.finding && evidence.source ? [{ route, sample, originalEvidence: evidence }] : [];
    }));
    const selected = [];
    for (const candidate of candidates) {
        if (selected.some(previous => Math.abs(previous.sample.coord[0] - candidate.sample.coord[0]) + Math.abs(previous.sample.coord[1] - candidate.sample.coord[1]) < 0.00002)) continue;
        selected.push(candidate);
        if (selected.length === 3) break;
    }
    const manifest = { createdAt: new Date().toISOString(), selection: 'First three distinct previously analyzed coordinates in the actual route response; not an accuracy sample.', samples: [] };
    for (const [index, candidate] of selected.entries()) {
        const capture = await streetImage(candidate.sample, config, AbortSignal.timeout(40000));
        if (!capture) { console.log(JSON.stringify({ sample: candidate.sample.id, capture: 'unavailable' })); continue; }
        const bytes = Buffer.from(capture.image.data, 'base64');
        const imagePath = resolve(directory, `sample-${index + 1}.jpg`);
        await writeFile(imagePath, bytes);
        manifest.samples.push({ ...candidate, source: capture.source, mime: capture.image.mime, imagePath, sha256: createHash('sha256').update(bytes).digest('hex'), baselineContext: baselineRouteContext({ ...candidate, source: capture.source }), enrichedContext: routeImageContext({ ...candidate, source: capture.source }) });
        console.log(JSON.stringify({ imagePath, source: capture.source, sha256: manifest.samples.at(-1).sha256 }));
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
} else if (process.argv[2] === 'aim') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const original = manifest.samples[1];
    if (!original) throw new Error('Capture the original bridge view first');
    const requestedHeading = bearing(original.source.coord, original.sample.coord);
    const capture = await streetImage({ ...original.sample, heading: requestedHeading }, config, AbortSignal.timeout(40000));
    if (!capture) throw new Error('Target-facing capture unavailable');
    const bytes = Buffer.from(capture.image.data, 'base64');
    const imagePath = resolve(directory, 'sample-2-target-facing.jpg');
    await writeFile(imagePath, bytes);
    const candidate = { ...original, source: capture.source, mime: capture.image.mime, imagePath, sha256: createHash('sha256').update(bytes).digest('hex'), requestedHeading, view: 'Target-facing research view; route travel heading remains unchanged' };
    candidate.baselineContext = baselineRouteContext(candidate);
    candidate.enrichedContext = routeImageContext(candidate);
    manifest.targetFacing = candidate;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ imagePath, source: capture.source, requestedHeading }));
} else if (process.argv[2] === 'infer') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const outputPath = resolve(directory, 'results.json');
    const report = { startedAt: new Date().toISOString(), method: 'Small paired observational pilot, same image bytes per cell, one call per cell, no ground-truth accuracy claim. Validated findings include application safety normalization.', samples: [], results: [] };
    const selected = manifest.targetFacing ? [manifest.samples[0], manifest.samples[1], manifest.targetFacing] : manifest.samples.slice(0, 3);
    for (const sample of selected) {
        const bytes = await readFile(sample.imagePath);
        if (createHash('sha256').update(bytes).digest('hex') !== sample.sha256) throw new Error('Study image changed');
        report.samples.push({ imagePath: sample.imagePath, sha256: sample.sha256, source: sample.source, routeId: sample.route.id, sampleId: sample.sample.id });
        for (const model of ['gemini-3.8-flash', 'gemini-3.1-pro-preview']) {
            for (const context of ['baseline', 'enriched']) {
                const started = Date.now();
                const cell = { imageSha256: sample.sha256, model, context };
                try {
                    cell.result = await analyzeKhuImage({ apiKey: config.ai, model, image: { mime: sample.mime, data: bytes.toString('base64') }, profile: '휠체어 이용자. 계단, 큰 단차와 통행 공간의 장애물을 관찰한다. 사진에서 정확한 경사도는 추정하지 않는다.', context: context === 'baseline' ? sample.baselineContext : sample.enrichedContext });
                } catch (error) {
                    cell.error = error instanceof Error ? error.message : 'Analysis failed';
                }
                cell.elapsedMs = Date.now() - started;
                report.results.push(cell);
                await writeFile(outputPath, JSON.stringify(report, null, 2));
                console.log(JSON.stringify({ model, context, imageSha256: sample.sha256, status: cell.result?.finding.status, routeMatch: cell.result?.finding.routeMatch, error: cell.error }));
            }
        }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify(report, null, 2));
} else throw new Error('Usage: node --env-file=.env.local scripts/compare-route-context.mjs capture|aim|infer');
