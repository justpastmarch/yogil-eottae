import type {EvidenceSource} from './domain.ts';
import {z} from 'zod';

type PanoramaSource=Pick<EvidenceSource,'url'|'panoId'|'provider'|'heading'|'tilt'|'fov'>;
const naverPoseSchema=z.object({
    provider:z.literal('naver'),
    panoId:z.string().min(1).max(256),
    heading:z.number().finite().min(0).max(360),
    tilt:z.number().finite().min(-45).max(45),
    fov:z.number().finite().min(20).max(100),
});
export type NaverPanoramaPose={panoId:string;pan:number;tilt:number;fov:number};

export function naverPanoramaId(source:Pick<EvidenceSource,'url'|'panoId'|'provider'>):string|null{
    if(source.provider!=='naver'||!source.panoId)return null;
    let url:URL;
    try{url=new URL(source.url);}catch{return null;}
    if(url.protocol!=='https:'||url.hostname!=='viewer.map.naver.com'||url.port||url.username||url.password||url.pathname!=='/panorama'||url.searchParams.getAll('id').length!==1||url.searchParams.get('id')!==source.panoId)return null;
    return source.panoId;
}

export function naverPanoramaPose(source:PanoramaSource):NaverPanoramaPose|null{
    const parsed=naverPoseSchema.safeParse(source);
    if(!parsed.success||naverPanoramaId(source)===null)return null;
    const url=new URL(source.url);
    const number=(key:string)=>{
        const values=url.searchParams.getAll(key);
        if(values.length!==1||!values[0].trim())return NaN;
        return Number(values[0]);
    };
    const pan=number('heading'),tilt=number('tilt'),fov=number('fov');
    const heading=(pan+360)%360;
    if(!Number.isFinite(pan)||pan < -180||pan > 180||!Number.isFinite(tilt)||!Number.isFinite(fov)||Math.abs(heading-parsed.data.heading%360)>1e-6||Math.abs(tilt+parsed.data.tilt)>1e-6||Math.abs(fov-parsed.data.fov)>1e-6)return null;
    return {panoId:parsed.data.panoId,pan,tilt,fov};
}

export function imageryProviderLabel(source:Pick<EvidenceSource,'url'|'provider'>):string{
    const host=new URL(source.url).hostname;
    return source.provider==='naver'&&host==='viewer.map.naver.com'?'NAVER 거리뷰':host==='map.kakao.com'||host==='kko.to'?'카카오 로드뷰 (보관 자료)':host==='www.google.com'?'Google Street View':host==='kartaview.org'?'KartaView':host==='www.mapillary.com'?'Mapillary':'거리영상';
}

export function kakaoPanoramaId(source:Pick<EvidenceSource,'url'|'panoId'>):number|null{
    if(!source.panoId||!/^\d+$/.test(source.panoId))return null;
    let url:URL;
    try{url=new URL(source.url);}catch{return null;}
    if(url.protocol!=='https:'||url.hostname!=='map.kakao.com'||url.username||url.password||url.port||url.searchParams.get('panoid')!==source.panoId)return null;
    const id=Number(source.panoId);
    return Number.isSafeInteger(id)&&id>0?id:null;
}
