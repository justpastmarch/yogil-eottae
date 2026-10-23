import {z} from 'zod';

export interface KakaoLatLng { getLat(): number; getLng(): number }
export interface KakaoBounds { extend(point: KakaoLatLng): void }
export interface KakaoMap {
  setCenter(point: KakaoLatLng): void;
  setLevel(level: number): void;
  setBounds(bounds: KakaoBounds, top?: number, right?: number, bottom?: number, left?: number): void;
  relayout(): void;
  addControl(control: object, position: number): void;
}
export interface KakaoOverlay { setMap(map: KakaoMap | null): void }
export interface KakaoMapClick { latLng: KakaoLatLng }
export interface KakaoMaps {
  load(callback: () => void): void;
  Map: new (container: HTMLElement, options: {center: KakaoLatLng; level: number}) => KakaoMap;
  LatLng: new (latitude: number, longitude: number) => KakaoLatLng;
  LatLngBounds: new () => KakaoBounds;
  Polyline: new (options: {map: KakaoMap; path: KakaoLatLng[]; strokeWeight: number; strokeColor: string; strokeOpacity: number}) => KakaoOverlay;
  CustomOverlay: new (options: {map: KakaoMap; position: KakaoLatLng; content: HTMLElement; yAnchor: number; zIndex: number}) => KakaoOverlay;
  ZoomControl: new () => object;
  ControlPosition: {BOTTOMRIGHT: number};
  event: {
    addListener(target: KakaoMap, type: 'click', callback: (event: KakaoMapClick) => void): void;
    removeListener(target: KakaoMap, type: 'click', callback: (event: KakaoMapClick) => void): void;
    preventMap(): void;
  };
}

declare global { interface Window { kakao?: {maps: KakaoMaps} } }

const mapConfigSchema = z.object({javascriptKey: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(256)});
let pending: Promise<KakaoMaps> | undefined;

export function loadKakaoMaps(): Promise<KakaoMaps> {
  if (pending) return pending;
  const available = window.kakao?.maps;
  if (available && typeof available.Map === 'function') return Promise.resolve(available);
  const attempt = new Promise<KakaoMaps>((resolve, reject) => {
    const controller = new AbortController();
    let script: HTMLScriptElement | undefined;
    let settled = false;
    const finish = (maps?: KakaoMaps) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      if (script) { script.onload = null; script.onerror = null; }
      if (maps) resolve(maps);
      else { script?.remove(); reject(new Error('지도를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')); }
    };
    const timer = setTimeout(() => finish(), 12_000);
    fetch('/api/map-config', {signal: controller.signal, cache: 'no-store'})
      .then(async response => {
        if (!response.ok) throw new Error('Map configuration unavailable');
        const value: unknown = await response.json();
        return mapConfigSchema.parse(value);
      })
      .then(({javascriptKey}) => {
        if (settled) return;
        script = document.createElement('script');
        const url = new URL('https://dapi.kakao.com/v2/maps/sdk.js');
        url.searchParams.set('appkey', javascriptKey);
        url.searchParams.set('autoload', 'false');
        script.src = url.href;
        script.async = true;
        script.onerror = () => finish();
        script.onload = () => {
          const maps = window.kakao?.maps;
          if (!maps) { finish(); return; }
          try { maps.load(() => finish(maps)); }
          catch { finish(); }
        };
        document.head.appendChild(script);
      }).catch(() => finish());
  });
  pending = attempt;
  void attempt.catch(() => { if (pending === attempt) pending = undefined; });
  return attempt;
}
