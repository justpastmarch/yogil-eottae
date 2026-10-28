import http from 'node:http';
import { chromium } from 'playwright';
import {routeRendererRequest} from './request-policy.mjs';
import { authorized, captureMonth, parseCapture, parseOrigin, parseState, targetHeading } from './contract.mjs';

const token = process.env.ROADVIEW_RENDERER_TOKEN;
if (!token || token.length < 24) throw new Error('ROADVIEW_RENDERER_TOKEN must have at least 24 characters');
const appOrigin = parseOrigin(process.env.ROADVIEW_APP_ORIGIN ?? 'http://localhost:3000');
const port = Number(process.env.PORT ?? 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('Invalid HOST');
let browserPromise;
let active = 0;

function browser() {
  browserPromise ??= chromium.launch({
    headless: true, timeout: 10_000,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    ...(process.env.ROADVIEW_BROWSER_CHANNEL ? { channel: process.env.ROADVIEW_BROWSER_CHANNEL } : {}),
  }).then(instance => {
    instance.on('disconnected', () => { browserPromise = undefined; });
    return instance;
  }).catch(error => { browserPromise = undefined; throw error; });
  return browserPromise;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return parseCapture(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function respond(res, status, body) {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
}

async function capture(input, signal) {
  let context;
  let stage = 'browser';
  let closing = false;
  const close = () => {
    closing = true;
    void context?.close().catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new Error('Capture cancelled');
    context = await (await browser()).newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ko-KR', serviceWorkers: 'block',
    });
    if (closing || signal.aborted) throw new Error('Capture cancelled');
    await context.route('**/*', route => routeRendererRequest(route, appOrigin, process.env.ROADVIEW_APP_ACCESS_TOKEN));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    stage = 'sdk';
    const sdkUrl = new URL('/internal/roadview', appOrigin);
    sdkUrl.search = new URLSearchParams({ lng: String(input.coord[0]), lat: String(input.coord[1]), heading: String(input.heading) }).toString();
    await page.goto(sdkUrl.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const text = document.querySelector('#capture-state')?.textContent;
      if (!text) return false;
      try { return ['ready', 'missing', 'error'].includes(JSON.parse(text).status); } catch { return false; }
    });
    const state = parseState(JSON.parse(await page.locator('#capture-state').textContent()));
    if (!state) return null;
    const heading = input.target ? targetHeading(state.coord, input.target, state.heading) : state.heading;
    const tilt=input.tilt??7,zoom=input.zoom??0;
    const original = new URL('https://map.kakao.com/');
    original.search = new URLSearchParams({ map_type: 'TYPE_MAP', map_attribute: 'ROADVIEW', panoid: state.panoId,
      pan: String(heading), tilt: String(tilt), zoom: String(zoom) }).toString();
    stage = 'viewer';
    let panoramaImages = 0;
    page.on('requestfinished', async request => {
      const response = await request.response().catch(() => null);
      if (!response) return;
      if (response.ok() && new URL(response.url()).hostname === 'map.kakaocdn.net' && new URL(response.url()).pathname.startsWith('/map_roadview/') &&
          /image\//.test(response.headers()['content-type'] ?? '')) panoramaImages++;
    });
    await page.goto(original.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /20\d{2}년\s*(?:0?[1-9]|1[0-2])월/.test(document.body.innerText), null, { timeout: 6000 }).catch(() => {});
    if (new URL(page.url()).hostname !== 'map.kakao.com' ||
        new URL(page.url()).searchParams.get('panoid') !== state.panoId) throw new Error('Panorama changed');
    await page.waitForFunction(() => {
      const large = element => {
        const box = element.getBoundingClientRect();
        return box.width > 400 && box.height > 250 && getComputedStyle(element).visibility !== 'hidden';
      };
      return [...document.querySelectorAll('canvas')].some(large) ||
        [...document.images].some(image => image.complete && image.naturalWidth > 128 && large(image));
    });
    stage = 'panorama_images';
    const imageDeadline = Date.now() + 5000;
    while (panoramaImages < 2 && Date.now() < imageDeadline && !signal.aborted) {
      await page.waitForTimeout(100);
    }
    if (panoramaImages < 2) throw new Error('Panorama images unavailable');
    stage = 'screenshot';
    await page.waitForTimeout(500);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const month = captureMonth(await page.locator('body').innerText());
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 85, animations: 'disabled', timeout: 5000 });
    const painted = await page.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(image, 0, 0);
      const { data: pixels } = ctx.getImageData(384, 160, 640, 360);
      let dark = 0;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 64) {
        if (pixels[i] < 12 && pixels[i + 1] < 12 && pixels[i + 2] < 12) dark++;
        colors.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`);
      }
      return dark / (pixels.length / 64) < 0.95 && colors.size > 12;
    }, jpeg.toString('base64'));
    if (!painted) throw new Error('Panorama did not paint');
    return { image: { mime: 'image/jpeg', data: jpeg.toString('base64') },
      source: { capturedAt: null, ...(month ? { capturedMonth: month } : {}),
        coord: state.coord, heading,tilt,zoom, panoId:state.panoId, url: original.href } };
  } catch (error) {
    if (!signal.aborted) console.error(JSON.stringify({event:'roadview_capture_failed',stage,reason:error instanceof Error && error.name==='TimeoutError'?'timeout':'capture_error'}));
    throw error;
  } finally {
    signal.removeEventListener('abort', close);
    await context?.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return respond(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/capture') return respond(res, 404, { error: 'Not found' });
  if (!authorized(req.headers.authorization, token)) return respond(res, 401, { error: 'Unauthorized' });
  if (active >= 2) { console.warn(JSON.stringify({event:'roadview_capture_busy'})); return respond(res, 429, { error: 'Renderer busy' }); }
  active++;
  const controller = new AbortController();
  const abort = () => { controller.abort(); if (!req.complete) req.destroy(); };
  req.once('aborted', abort);
  res.once('close', abort);
  const timeout = setTimeout(() => { console.warn(JSON.stringify({event:'roadview_capture_deadline'})); abort(); }, 30_000);
  try {
    let input;
    try { input = await readBody(req); }
    catch { return respond(res, 400, { error: 'Invalid capture request' }); }
    const result = await capture(input, controller.signal);
    respond(res, 200, result);
  } catch {
    respond(res, 502, { error: 'Roadview capture unavailable' });
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abort);
    res.off('close', abort);
    active--;
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => process.stdout.write(`Roadview renderer listening on ${host}:${port}\n`));
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => {
  server.close();
  await (await browserPromise?.catch(() => undefined))?.close();
  process.exit(0);
});
