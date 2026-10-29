import { z } from 'zod';
import { imageInput, MAX_IMAGE_BYTES } from './khu.ts';
import { bearing, meters, evidenceSourceSchema, type Coord, type Sample } from './domain.ts';
import {naverPanoramaPose} from './roadview-source.ts';
import type { ServerConfig } from './server-config';
const coordinate = z.tuple([z.number().min(124).max(132), z.number().min(33).max(40)]);
const source = evidenceSourceSchema.omit({distance:true}).extend({
    url:z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['viewer.map.naver.com','map.kakao.com','kko.to','map.naver.com','naver.me','www.mapillary.com','www.google.com','kartaview.org'].includes(url.hostname);}),
    coord:coordinate,heading:z.number().finite().min(0).max(360),
    capturedAt:z.number().min(0).refine(value=>value<=Date.now()).nullable(),
    tilt:z.number().finite().min(-45).max(45).optional(),zoom:z.number().int().min(0).max(2).optional(),
});
const rendered = z.object({ image: imageInput, source });
export type StreetImage = {
    image: z.infer<typeof imageInput>;
    source: z.infer<typeof source>;
};
const capture = z.object({ id: z.string(), geometry: z.object({ coordinates: coordinate }), captured_at: z.number(), thumb_1024_url: z.string().url(), compass_angle: z.number().nullable().optional(), is_pano: z.boolean().optional() });
const captures = z.object({ data: z.array(capture), paging: z.object({ next: z.string().optional() }).optional() });
export class ImageryServiceError extends Error {
    status:number;
    constructor(status:number,message='Imagery service unavailable'){super(message);this.status=status;}
}
async function waitForRetry(ms:number,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();
    const {promise,resolve,reject}=Promise.withResolvers<void>();
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    await promise;
}
async function checkedFetch<T>(url:string,init:RequestInit,signal:AbortSignal,consume:(response:Response)=>Promise<T>,timeout=12000,service:'renderer'|'mapillary'|'kartaview'|'google'='mapillary'):Promise<T>{
    for(let attempt=0;attempt<3;attempt++){
        let failure:unknown;
        try{
            const response=await fetch(url,{...init,redirect:'manual',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});
            if(response.ok)return await consume(response);
            void response.body?.cancel().catch(()=>{});
            failure=new ImageryServiceError(response.status);
        }catch(error){failure=error;}
        signal.throwIfAborted();
        const retryable=failure instanceof ImageryServiceError?(failure.status===408||failure.status===429||failure.status>=500):failure instanceof TypeError||failure instanceof SyntaxError||failure instanceof DOMException&&failure.name==='TimeoutError';
        if(!retryable)throw failure;
        const reason=failure instanceof ImageryServiceError?`http_${failure.status}`:failure instanceof SyntaxError?'invalid_json':failure instanceof DOMException?'timeout':'network';
        console.warn(JSON.stringify({event:'street_image_request_failed',service,reason,attempt:attempt+1,retrying:attempt<2}));
        if(attempt===2)throw failure;
        await waitForRetry(failure instanceof ImageryServiceError&&(failure.status===429||failure.status===503)?(attempt===0?5000:10000):(attempt===0?500:1500),signal);
    }
    throw new ImageryServiceError(503);
}
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
const googleMetadata=z.object({
    status:z.string(),
    pano_id:z.string().trim().min(1).optional(),
    location:z.object({lat:z.number().finite(),lng:z.number().finite()}).optional(),
    date:z.unknown().optional(),
});
async function googleStreetView(sample:Sample,config:ServerConfig,signal:AbortSignal,options:{target?:Coord;tilt?:number;zoom?:number}):Promise<StreetImage|null>{
    const key=config.googleStreetViewKey?.trim();
    if(!key)throw new ImageryServiceError(401,'Google Street View API key is missing');
    const request=(url:URL,max:number)=>checkedFetch(url.href,{},signal,async response=>({bytes:await boundedBytes(response,max),mime:response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()}),12000,'google');
    try{
        const metadataUrl=new URL('https://maps.googleapis.com/maps/api/streetview/metadata');
        metadataUrl.search=new URLSearchParams({location:`${sample.coord[1]},${sample.coord[0]}`,radius:'20',source:'outdoor',key}).toString();
        const metadata=await checkedFetch(metadataUrl.href,{},signal,async response=>{
            const data=googleMetadata.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response,64*1024))));
            if(data.status==='OVER_QUERY_LIMIT'||data.status==='OVER_DAILY_LIMIT')throw new ImageryServiceError(429,'Google Street View quota exceeded');
            if(data.status==='UNKNOWN_ERROR')throw new ImageryServiceError(502,'Google Street View metadata error');
            return data;
        },12000,'google');
        if(metadata.status==='ZERO_RESULTS')return null;
        if(metadata.status!=='OK'){
            const status=metadata.status==='REQUEST_DENIED'?403:metadata.status==='OVER_QUERY_LIMIT'||metadata.status==='OVER_DAILY_LIMIT'?429:502;
            throw new ImageryServiceError(status,status===403?'Google Street View request denied':status===429?'Google Street View quota exceeded':'Google Street View metadata error');
        }
        const location=metadata.location;
        const coord=location&&coordinate.safeParse([location.lng,location.lat]);
        if(!metadata.pano_id||!coord?.success)throw new ImageryServiceError(502,'Invalid Google Street View metadata');
        if(meters(sample.coord,coord.data)>20)return null;
        const heading=options.target&&meters(coord.data,options.target)>0.5?bearing(coord.data,options.target):sample.heading;
        const params=new URLSearchParams({size:'640x640',pano:metadata.pano_id,heading:String(heading),return_error_code:'true',key});
        if(options.tilt!==undefined)params.set('pitch',String(-options.tilt));
        if(options.zoom!==undefined)params.set('fov',String(Math.min(120,180/2**options.zoom)));
        const imageUrl=new URL('https://maps.googleapis.com/maps/api/streetview');
        imageUrl.search=params.toString();
        const {bytes,mime}=await request(imageUrl,MAX_IMAGE_BYTES);
        let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        const image=imageInput.parse({mime,data:btoa(binary)});
        const link=new URL('https://www.google.com/maps/@');
        link.search=new URLSearchParams({api:'1',map_action:'pano',viewpoint:`${coord.data[1]},${coord.data[0]}`,pano:metadata.pano_id,heading:String(heading),...(options.tilt!==undefined?{pitch:String(-options.tilt)}:{})}).toString();
        const month=typeof metadata.date==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(metadata.date)&&metadata.date<=new Date().toISOString().slice(0,7)?metadata.date:undefined;
        return {image,source:{url:link.href,capturedAt:null,...(month?{capturedMonth:month}:{}),coord:coord.data,heading,panoId:metadata.pano_id,...(options.tilt!==undefined?{tilt:options.tilt}:{}),...(options.zoom!==undefined?{zoom:options.zoom}:{})}};
    }catch(error){
        signal.throwIfAborted();
        if(error instanceof ImageryServiceError)throw error;
        throw new ImageryServiceError(502,'Google Street View service error');
    }
}
async function mapillary(sample: Sample, config: ServerConfig, signal: AbortSignal): Promise<StreetImage | null> {
    const [x, y] = sample.coord, dy = 25 / 111320, dx = dy / Math.cos(y * Math.PI / 180);
    const params = new URLSearchParams({ fields: 'id,geometry,captured_at,thumb_1024_url,compass_angle,is_pano', bbox: [x - dx, y - dy, x + dx, y + dy].join(','), limit: '2000' });
    const result = captures.parse(await checkedFetch('https://graph.mapillary.com/images?' + params, { headers: { Authorization: 'OAuth ' + config.mapillary } }, signal,response=>response.json()));
    if (result.paging?.next || result.data.length >= 2000)
        return null;
    const candidate = result.data.filter(i => !i.is_pano && i.compass_angle != null && meters(sample.coord, i.geometry.coordinates) <= 20 && Math.abs(((i.compass_angle - sample.heading + 540) % 360) - 180) < 65 && i.captured_at <= Date.now()).sort((a, b) => b.captured_at - a.captured_at)[0];
    if (!candidate || candidate.compass_angle == null)
        return null;
    const url = new URL(candidate.thumb_1024_url);
    if (url.protocol !== 'https:' || !(url.hostname.endsWith('.fbcdn.net') || url.hostname.endsWith('.mapillary.com')))
        throw new Error('Invalid image host');
    const {bytes,mime}=await checkedFetch(url.href,{},signal,async response=>({bytes:await boundedBytes(response,MAX_IMAGE_BYTES),mime:response.headers.get('content-type')?.split(';')[0]}));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const image = imageInput.parse({ mime, data: btoa(binary) });
    return { image, source: { url: 'https://www.mapillary.com/app/?pKey=' + encodeURIComponent(candidate.id) + '&focus=photo', capturedAt: candidate.captured_at, coord: candidate.geometry.coordinates, heading: candidate.compass_angle } };
}
const numeric=z.union([z.number(),z.string().regex(/^-?\d+(?:\.\d+)?$/)]).pipe(z.coerce.number().finite());
const kartaPhoto=z.object({
    lat:numeric.pipe(z.number().min(33).max(40)),lng:numeric.pipe(z.number().min(124).max(132)),
    heading:numeric.pipe(z.number().min(0).max(360)),projection:z.literal('PLANE'),
    status:z.literal('active'),visibility:z.literal('public'),
    autoImgProcessingResult:z.literal('BLURRED'),autoImgProcessingStatus:z.literal('FINISHED'),
    sequenceId:z.string().regex(/^\d+$/),sequenceIndex:z.string().regex(/^\d+$/),
    shotDate:z.string().nullish(),imageProcUrl:z.string().url(),
});
const kartaResponse=z.object({status:z.object({apiCode:z.literal(600)}),result:z.object({data:z.array(z.unknown())})});
async function kartaview(sample:Sample,signal:AbortSignal,options:{target?:Coord;tilt?:number;zoom?:number}):Promise<StreetImage|null>{
    // Fixed photographs cannot be rotated or tilted to perform a framing review.
    if(options.tilt!==undefined&&!options.target)return null;
    const params=new URLSearchParams({lat:String(sample.coord[1]),lng:String(sample.coord[0]),zoomLevel:'18',radius:'25',itemsPerPage:'150'});
    const raw=await checkedFetch('https://api.kartaview.org/2.0/photo/?'+params,{},signal,response=>response.json(),12000,'kartaview');
    const photos=kartaResponse.parse(raw).result.data.flatMap(value=>{const parsed=kartaPhoto.safeParse(value);return parsed.success?[parsed.data]:[];});
    const candidates=photos.map(photo=>({photo,coord:[photo.lng,photo.lat] as Coord})).filter(({photo,coord})=>{
        const desired=options.target&&meters(coord,options.target)>0.5?bearing(coord,options.target):sample.heading;
        return meters(sample.coord,coord)<=20&&Math.abs(((photo.heading-desired+540)%360)-180)<=65;
    }).sort((a,b)=>meters(sample.coord,a.coord)-meters(sample.coord,b.coord));
    const selected=candidates[0];if(!selected)return null;
    const url=new URL(selected.photo.imageProcUrl);
    if(url.protocol!=='https:'||url.hostname!=='cdn.kartaview.org'||url.port||url.username||url.password)throw new Error('Invalid image host');
    const {bytes,mime}=await checkedFetch(url.href,{},signal,async response=>({bytes:await boundedBytes(response,MAX_IMAGE_BYTES),mime:response.headers.get('content-type')?.split(';')[0]}),12000,'kartaview');
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const image=imageInput.parse({mime,data:btoa(binary)});
    const month=selected.photo.shotDate?.match(/^(20\d{2}-(?:0[1-9]|1[0-2]))/u)?.[1];
    return {image,source:{url:`https://kartaview.org/details/${selected.photo.sequenceId}/${selected.photo.sequenceIndex}`,capturedAt:null,...(month?{capturedMonth:month}:{}),coord:selected.coord,heading:selected.photo.heading}};
}
export async function streetImage(sample: Sample, config: ServerConfig, signal: AbortSignal, options: {target?:Coord;tilt?:number;zoom?:number;purpose?:'place-entrance'|'route'} = {}): Promise<StreetImage | null> {
    const {purpose,...viewpoint}=options;
    const maxCameraDistance=purpose==='place-entrance'?60:20;
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
    if(config.imageryProvider==='google')return googleStreetView(sample,config,deadline,options);
    if(config.imageryProvider==='kartaview')return kartaview(sample,deadline,options);
    if (config.rendererUrl) {
        try {
            const raw:unknown=await checkedFetch(config.rendererUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + config.rendererToken, 'Content-Type': 'application/json' }, body: JSON.stringify({coord:sample.coord,heading:sample.heading,...viewpoint,maxDistance:maxCameraDistance}) },deadline,async response=>JSON.parse(new TextDecoder().decode(await boundedBytes(response,6*1024*1024))),30000,'renderer');
            if (raw !== null) {
                const image = rendered.parse(raw);
                if(!naverPanoramaPose(image.source))throw new ImageryServiceError(503,'Renderer returned invalid NAVER panorama provenance');
                const expectedHeading = options.target && meters(image.source.coord, options.target) > 0.5 ? bearing(image.source.coord, options.target) : sample.heading;
                const viewpointMatches=(options.tilt===undefined||Math.abs((image.source.tilt??NaN)-options.tilt)<=1)&&(options.zoom===undefined||image.source.zoom===options.zoom);
                if(viewpointMatches&&meters(sample.coord,image.source.coord)<=maxCameraDistance&&Math.abs(((image.source.heading-expectedHeading+540)%360)-180)<=65)return image;
                throw new ImageryServiceError(503,'Renderer returned an unrelated panorama viewpoint');
            }
        } catch (error) {
            signal.throwIfAborted();
            if(error instanceof ImageryServiceError)throw error;
            throw new ImageryServiceError(503);
        }
        return null;
    }
    if(config.mapillary){
        const alternate=await mapillary(options.target&&meters(sample.coord,options.target)>.5?{...sample,heading:bearing(sample.coord,options.target)}:sample,config,deadline);
        if(alternate)return alternate;
    }
    return null;
}
