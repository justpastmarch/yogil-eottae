import { timingSafeEqual } from 'node:crypto';

export function parseCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'coord,heading' ||
      !Array.isArray(value.coord) || value.coord.length !== 2 ||
      !value.coord.every(Number.isFinite) || !Number.isFinite(value.heading) ||
      Math.abs(value.coord[0]) > 180 || Math.abs(value.coord[1]) > 90 ||
      value.heading < 0 || value.heading >= 360) {
    throw new Error('Invalid capture request');
  }
  return { coord: value.coord, heading: value.heading };
}

export function parseOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('ROADVIEW_APP_ORIGIN must be an HTTPS origin or local HTTP origin');
  }
  return url.origin;
}

export function authorized(header, token) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function captureMonth(text) {
  const match = text.match(/(20\d{2})년\s*(0?[1-9]|1[0-2])월/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}` : null;
}

export function parseState(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid viewer state');
  if (value.status === 'missing') return null;
  if (value.status !== 'ready' || !/^\d+$/.test(String(value.panoId))) {
    throw new Error('Viewer unavailable');
  }
  return { ...parseCapture({ coord: value.coord, heading: value.heading }), panoId: String(value.panoId) };
}
