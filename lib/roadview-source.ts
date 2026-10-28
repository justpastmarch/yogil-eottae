import type {EvidenceSource} from './domain.ts';

export function kakaoPanoramaId(source:Pick<EvidenceSource,'url'|'panoId'>):number|null{
    if(!source.panoId||!/^\d+$/.test(source.panoId))return null;
    let url:URL;
    try{url=new URL(source.url);}catch{return null;}
    if(url.protocol!=='https:'||url.hostname!=='map.kakao.com'||url.searchParams.get('panoid')!==source.panoId)return null;
    const id=Number(source.panoId);
    return Number.isSafeInteger(id)&&id>0?id:null;
}
