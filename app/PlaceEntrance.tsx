'use client';

import {useEffect,useRef,useState} from 'react';
import type {Coord,Place} from '../lib/domain.ts';
import {entranceResponseSchema,type EntranceResponse} from '../lib/place-entrance.ts';
import EvidencePhoto from './EvidencePhoto';
import {entranceObservationSummary} from '../lib/entrance-observation.ts';

export type Props={place:Place;onLocate?:(coord:Coord)=>void;onVerdict?:(verdict:EntranceResponse['verdict']|null)=>void};
type Photo=Omit<EntranceResponse['evidence'][number],'image'>&{photoUrl:string};
type Result=Omit<EntranceResponse,'evidence'>&{evidence:Photo[]};
type State={kind:'canceled';placeKey:string}|{kind:'loading';placeKey:string}|{kind:'error';placeKey:string}|{kind:'result';placeKey:string;result:Result};
export default function PlaceEntrance({place,onLocate,onVerdict}:Props){
    const placeKey=JSON.stringify([place.id,place.name,place.coord]);
    const body=JSON.stringify({place});
    const [state,setState]=useState<State>({kind:'loading',placeKey});
    const [retry,setRetry]=useState(0);
    const verdictCallback=useRef(onVerdict);
    verdictCallback.current=onVerdict;
    const request=useRef<AbortController|null>(null);
    const sequence=useRef(0);
    const urls=useRef<string[]>([]);
    useEffect(()=>{
        const controller=new AbortController();
        request.current=controller;
        const attempt=++sequence.current;
        setState({kind:'loading',placeKey});
        verdictCallback.current?.(null);
        queueMicrotask(()=>{if(!controller.signal.aborted)void analyze(controller,attempt);});
        return ()=>{
            sequence.current++;
            controller.abort();
            for(const url of urls.current)URL.revokeObjectURL(url);
            urls.current=[];
        };
    },[placeKey,body,retry]);
    const current:State=state.placeKey===placeKey?state:{kind:'loading',placeKey};
    function cancel(){
        sequence.current++;
        request.current?.abort();
        setState({kind:'canceled',placeKey});
    }
    async function analyze(controller:AbortController,attempt:number){
        try{
            const response=await fetch('/api/entrance',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(95000)]),body});
            const value:unknown=await response.json();
            if(!response.ok)throw new Error(value&&typeof value==='object'&&'error' in value&&typeof value.error==='string'?value.error:'입구 확인을 완료하지 못했습니다.');
            const result=entranceResponseSchema.parse(value);
            if(attempt!==sequence.current||controller.signal.aborted)return;
            if(result.place.id!==place.id||result.place.name!==place.name||result.place.coord.some((coord,index)=>coord!==place.coord[index]))throw new Error('선택한 장소와 입구 결과가 다릅니다. 다시 확인해 주세요.');
            const photos:Photo[]=result.evidence.map(({image,...evidence})=>{
                const bytes=Uint8Array.from(atob(image.data),char=>char.charCodeAt(0));
                const photoUrl=URL.createObjectURL(new Blob([bytes],{type:image.mime}));
                urls.current.push(photoUrl);
                return {...evidence,photoUrl};
            });
            setState({kind:'result',placeKey,result:{...result,evidence:photos}});
            verdictCallback.current?.(result.verdict);
        }catch{
            if(attempt!==sequence.current||controller.signal.aborted)return;
            for(const url of urls.current)URL.revokeObjectURL(url);
            urls.current=[];
            setState({kind:'error',placeKey});
        }
    }
    const summary=current.kind==='result'?entranceObservationSummary(current.result):null;
    const technical=current.kind==='result'&&current.result.uncertainty==='technical';
    return <section className="destination-info place-entrance" aria-label={`${place.name} 주변 접근로 관찰`}>
        <h3 className="entrance-title" title={place.name}>{place.name}</h3>
        {current.kind==='canceled'&&<div>
            <div className="entrance-verdict-row"><h4 className="entrance-status" role="status">입구 확인 중지</h4><button type="button" onClick={()=>setRetry(value=>value+1)}>확인 재개</button></div>
            <p className="entrance-reason">주변 접근로 관찰을 중지했어요.</p>
        </div>}
        {current.kind==='loading'&&<div className="entrance-loading" role="status"><p>주변 접근로 사진을 확인하고 있어요</p><button type="button" onClick={cancel}>중지</button></div>}
        {current.kind==='error'&&<div role="alert">
            <div className="entrance-verdict-row"><h4 className="entrance-status">입구 사진 연결 실패</h4><button type="button" onClick={()=>setRetry(value=>value+1)}>다시 확인</button></div>
            <p className="entrance-reason">주변 접근로 사진을 확인하지 못했어요.</p>
        </div>}
        {current.kind==='result'&&summary&&<div aria-live="polite">
            <div className="entrance-verdict-row"><h4 className="entrance-status">{summary.title}</h4>{technical&&<button type="button" onClick={()=>setRetry(value=>value+1)}>다시 확인</button>}</div>
            {(!technical||current.result.evidence.length>0)&&<details className="entrance-details entrance-photos">
                <summary>상세 판정 결과{current.result.evidence.length>0&&` · 입구 사진 ${current.result.evidence.length}장`}</summary>
                <p className="entrance-reason">{summary.reason}</p>
                <p className="entrance-next">{summary.action}</p>
                {onLocate&&<button type="button" onClick={()=>onLocate(place.coord)}>지도에서 선택 위치 보기</button>}
                <p className="capture-disclaimer">선택 위치를 향해 촬영한 주변 구조의 관찰입니다. 출입문까지의 전체 연결·현재 이용 가능 여부는 별도 확인이 필요해요.</p>
                {current.result.evidence.map((photo,index)=><EvidencePhoto key={photo.id} url={photo.photoUrl} source={photo.source} alt={`선택 위치 주변 접근로의 실제 거리 사진 ${index+1}`} caption={photo.identity?.reason}/>)}
            </details>}
        </div>}
    </section>;
}
