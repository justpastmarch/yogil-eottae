'use client';

import {useEffect,useRef,useState} from 'react';
import {Expand,ExternalLink,Eye,X} from 'lucide-react';
import type {EvidenceSource} from '../lib/domain.ts';
import {imageryProviderLabel,naverPanoramaPose} from '../lib/roadview-source.ts';
import PanoramaModal from './PanoramaModal';

type Source=Omit<EvidenceSource,'distance'>;
export function captureDate(source:Source){
    return source.capturedMonth??(source.capturedAt===null?'시점 미상':new Date(source.capturedAt).toLocaleDateString('ko-KR'));
}
function Attribution({source}:{source:Source}){
    const kartaview=new URL(source.url).hostname==='kartaview.org';
    return <>{source.provider==='naver'&&<span>© NAVER Corp.</span>}{kartaview&&<span>© Grab and KartaView Contributors · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a></span>}</>;
}
export function EvidenceSourceInfo({source,imageUrl,onExpand}:{source:Source;imageUrl?:string;onExpand?:()=>void}){
    const [panoramaOpen,setPanoramaOpen]=useState(false);
    return <div className="evidence-photo-info">
        <strong>{imageryProviderLabel(source)} · {captureDate(source)} 촬영</strong>
        <div className="evidence-photo-attribution"><Attribution source={source}/></div>
        <div className="evidence-photo-actions">
            {onExpand&&<button type="button" onClick={onExpand}><Expand size={16}/> 사진 크게 보기</button>}
            {naverPanoramaPose(source)&&<button type="button" className="roadview-open-btn" onClick={()=>setPanoramaOpen(true)}><Eye size={16}/> 이 사진 위치 360° 거리뷰</button>}
        </div>
        <details className="evidence-photo-secondary"><summary>외부 원본·촬영 정보</summary>
            <div className="evidence-photo-links">
                {imageUrl&&<a href={imageUrl} target="_blank" rel="noreferrer">보관 사진 원본 열기 <ExternalLink size={14}/></a>}
                <a href={source.url} target="_blank" rel="noreferrer">촬영 위치 원본 열기 <ExternalLink size={14}/></a>
            </div>
            <dl><dt>촬영 좌표</dt><dd>{source.coord.join(', ')}</dd>
                {source.panoId&&<><dt>파노라마 ID</dt><dd>{source.panoId}</dd></>}
                {source.heading!==undefined&&<><dt>방향</dt><dd>{source.heading}°</dd></>}
                {source.tilt!==undefined&&<><dt>기울기</dt><dd>{source.tilt}°</dd></>}
                {source.fov!==undefined&&<><dt>화각 (FOV)</dt><dd>{source.fov}°</dd></>}
            </dl>
        </details>
        {panoramaOpen&&<PanoramaModal source={source} onClose={()=>setPanoramaOpen(false)}/>}
    </div>;
}
function PhotoDialog({url,source,alt,onClose}:{url:string;source:Source;alt:string;onClose():void}){
    const dialog=useRef<HTMLDialogElement>(null);
    const [unavailable,setUnavailable]=useState(false);
    useEffect(()=>{
        const modal=dialog.current,opener=document.activeElement;
        modal?.showModal();
        return ()=>{modal?.close();if(opener instanceof HTMLElement&&opener.isConnected)opener.focus({preventScroll:true});};
    },[]);
    return <dialog ref={dialog} className="evidence-photo-dialog" aria-label="거리 사진 크게 보기" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
        <header><h3>보관된 거리 사진</h3><button type="button" onClick={onClose} aria-label="사진 닫기"><X size={20}/></button></header>
        <div className="evidence-photo-full">{unavailable?<p role="alert">사진을 불러오지 못했어요. 외부 원본에서 다시 확인하세요.</p>:<img src={url} alt={alt} onError={()=>setUnavailable(true)}/>}</div>
        <footer><span>{imageryProviderLabel(source)} · {captureDate(source)} 촬영</span><Attribution source={source}/><a href={url} target="_blank" rel="noreferrer">보관 사진 원본 열기 <ExternalLink size={14}/></a></footer>
    </dialog>;
}
export default function EvidencePhoto({url,source,alt,caption}:{url:string;source:Source;alt:string;caption?:string}){
    const [expanded,setExpanded]=useState(false),[unavailable,setUnavailable]=useState(false);
    return <figure className="capture-frame evidence-photo">
        {unavailable?<p className="capture-unavailable">사진을 불러오지 못했어요. 외부 원본에서 다시 확인하세요.</p>:<div className="capture-thumbnail evidence-photo-thumbnail"><img src={url} alt={alt} loading="lazy" onError={()=>setUnavailable(true)}/></div>}
        <figcaption>{caption&&<p>{caption}</p>}<EvidenceSourceInfo source={source} imageUrl={url} onExpand={()=>setExpanded(true)}/></figcaption>
        {expanded&&<PhotoDialog url={url} source={source} alt={alt} onClose={()=>setExpanded(false)}/>}
    </figure>;
}
