import { timingSafeEqual } from 'node:crypto';

export function parseCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['coord,heading','coord,heading,target'].includes(Object.keys(value).sort().join(',')) ||
      !Array.isArray(value.coord) || value.coord.length !== 2 ||
      !value.coord.every(Number.isFinite) || !Number.isFinite(value.heading) ||
      Math.abs(value.coord[0]) > 180 || Math.abs(value.coord[1]) > 90 ||
      value.heading < 0 || value.heading >= 360) {
    throw new Error('Invalid capture request');
  }
  if (Object.hasOwn(value,'target') && (!Array.isArray(value.target) || value.target.length !== 2 || !value.target.every(Number.isFinite) || Math.abs(value.target[0])>180 || Math.abs(value.target[1])>90 || distance(value.coord,value.target)>60)) throw new Error('Invalid capture target');
  return { coord: value.coord, heading: value.heading, ...(value.target ? {target:value.target}: {}) };

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

function distance(a,b) { const r=Math.PI/180, p=(b[1]-a[1])*r, l=(b[0]-a[0])*r; const v=Math.sin(p/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(l/2)**2; return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v))); }
export function targetHeading(from,to,fallback) { if(distance(from,to)<0.5)return fallback; const r=Math.PI/180; return (Math.atan2(Math.sin((to[0]-from[0])*r)*Math.cos(to[1]*r),Math.cos(from[1]*r)*Math.sin(to[1]*r)-Math.sin(from[1]*r)*Math.cos(to[1]*r)*Math.cos((to[0]-from[0])*r))*180/Math.PI+360)%360; }
