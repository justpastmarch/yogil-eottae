import { timingSafeEqual } from 'node:crypto';

export class CaptureError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function coordinate(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

export function parseCapture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.keys(value).every(key => ['coord','heading','target','tilt','zoom','maxDistance'].includes(key)) ||
      !coordinate(value.coord) || !Number.isFinite(value.heading) || value.heading < 0 || value.heading >= 360) {
    throw new Error('Invalid capture request');
  }
  if (Object.hasOwn(value,'target') && (!coordinate(value.target) || distance(value.coord,value.target)>60)) throw new Error('Invalid capture target');
  if (value.tilt !== undefined && (!Number.isFinite(value.tilt) || value.tilt < -45 || value.tilt > 45)) throw new Error('Invalid capture tilt');
  if (value.zoom !== undefined && (!Number.isInteger(value.zoom) || value.zoom < 0 || value.zoom > 2)) throw new Error('Invalid capture zoom');
  if (value.maxDistance !== undefined && ![20,60].includes(value.maxDistance)) throw new Error('Invalid capture radius');
  return {coord:value.coord,heading:value.heading,...(value.target?{target:value.target}:{}),tilt:value.tilt??7,zoom:value.zoom??0,maxDistance:value.maxDistance??20};
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

// The SDK's timezone is undocumented. Validate its observed calendar representation,
// publish month precision only, and conservatively reject dates after today's UTC day.
export function captureMonth(value, now = new Date()) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(20\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d))?$/);
  if (!match) return null;
  const today = now.toISOString();
  if (match[3]) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day || day > today.slice(0,10)) return null;
  }
  return value.slice(0,7) <= today.slice(0,7) ? value.slice(0,7) : null;
}

export function parseState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureError('Invalid viewer state');
  if (value.status === 'missing' && value.reason === 'distance') return null;
  if (value.status === 'error') throw new CaptureError('Viewer unavailable', value.code === 'auth' ? 403 : 502);
  if (value.status !== 'ready' || typeof value.panoId !== 'string' || value.panoId.length < 1 ||
      value.panoId.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.panoId) || !coordinate(value.coord) ||
      !Number.isFinite(value.heading) || value.heading < 0 || value.heading >= 360 ||
      !Number.isFinite(value.tilt) || value.tilt < -45 || value.tilt > 45 ||
      !Number.isFinite(value.fov) || value.fov < 20 || value.fov > 100) throw new CaptureError('Invalid framed panorama');
  const month = captureMonth(value.capturedMonth);
  if (value.capturedMonth !== undefined && !month) throw new CaptureError('Invalid panorama date');
  return {panoId:value.panoId,coord:value.coord,heading:value.heading,tilt:value.tilt,fov:value.fov,...(month?{capturedMonth:month}:{})};
}

export function distance(a,b) {
  const r=Math.PI/180,p=(b[1]-a[1])*r,l=(b[0]-a[0])*r;
  const v=Math.sin(p/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(l/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
}
export function targetHeading(from,to,fallback) {
  if(distance(from,to)<0.5)return fallback;
  const r=Math.PI/180;
  return (Math.atan2(Math.sin((to[0]-from[0])*r)*Math.cos(to[1]*r),Math.cos(from[1]*r)*Math.sin(to[1]*r)-Math.sin(from[1]*r)*Math.cos(to[1]*r)*Math.cos((to[0]-from[0])*r))*180/Math.PI+360)%360;
}
function headingDifference(a,b) { return Math.abs(((a-b+540)%360)-180); }

export function assertFramedState(input,state) {
  if (distance(input.coord,state.coord)>input.maxDistance) throw new CaptureError('Panorama outside capture radius');
  const heading=input.target?targetHeading(state.coord,input.target,input.heading):input.heading;
  if (headingDifference(state.heading,heading)>0.1 || Math.abs(state.tilt-input.tilt)>0.1 || Math.abs(state.fov-[90,60,40][input.zoom])>0.1) {
    throw new CaptureError('Panorama framing changed');
  }
}

export function sameFrame(a,b) {
  return a.panoId===b.panoId && distance(a.coord,b.coord)<0.05 && headingDifference(a.heading,b.heading)<0.01 &&
    Math.abs(a.tilt-b.tilt)<0.01 && Math.abs(a.fov-b.fov)<0.01 && a.capturedMonth===b.capturedMonth;
}

export function viewerUrl(state) {
  const url=new URL('https://viewer.map.naver.com/panorama');
  url.search=new URLSearchParams({id:state.panoId,heading:String(state.heading>180?state.heading-360:state.heading),tilt:String(-state.tilt),fov:String(state.fov)}).toString();
  return url.href;
}

export function texturePanoId(value) {
  const url=new URL(value);
  const match=url.pathname.match(/^\/image\/([^/]+)\/.+/);
  return url.hostname==='panorama.pstatic.net' && match ? decodeURIComponent(match[1]) : null;
}

export function texturesReady(textures,pending,panoId,lastActivity,now=Date.now()) {
  if(pending!==0 || now-lastActivity<500)return false;
  let decoded=0;
  for(const texture of textures){
    if(texture.panoId!==panoId)continue;
    if(texture.failed)return false;
    if(texture.width>=512 && texture.height>=512)decoded++;
  }
  return decoded>=2;
}
