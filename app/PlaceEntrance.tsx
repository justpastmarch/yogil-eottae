'use client';

import Image from 'next/image';
import {useEffect,useRef,useState} from 'react';
import type {Coord,Place} from '../lib/domain.ts';
import {entranceResponseSchema,type EntranceResponse} from '../lib/place-entrance.ts';

export type Props={place:Place;onLocate?:(coord:Coord)=>void};
type Photo=Omit<EntranceResponse['evidence'][number],'image'>&{photoUrl:string};
type Result=Omit<EntranceResponse,'evidence'>&{evidence:Photo[]};
type State={kind:'idle'}|{kind:'loading';placeKey:string}|{kind:'error';placeKey:string;message:string}|{kind:'result';placeKey:string;result:Result};
function entranceSummary(result:Result){
    switch(result.verdict){
        case 'flat':return {title:'사진상 단차 없이 연결',reason:'확인 범위: 보도에서 이 출입문까지',action:'입구 사진에서 출입문과 위치를 확인하세요.'};
        case 'ramp':return {title:'사진상 경사로로 연결',reason:'같은 출입문으로 이어지는 경사로가 보여요.',action:'입구 사진에서 경사로 위치를 확인하세요.'};
        case 'raised':return {title:'사진상 계단·턱 있음',reason:'같은 입구에서 우회 연결은 관찰되지 않았어요.',action:'시설에 계단 없는 다른 입구를 문의하세요.'};
        case 'unknown':{
            const photographedSteps=result.evidence.some(photo=>{
                const view=photo.identity;
                return view&&view.branchMatch==='unknown'&&(view.nameMatch==='exact'||view.nameMatch==='transliteration')&&view.entranceVisible&&(view.connection==='stairs'||view.connection==='raised');
            });
            if(photographedSteps)return {title:'사진에 계단·턱 · 선택한 지점 여부 미확인',reason:'읽힌 간판만으로 선택한 지점의 입구라고 확정하지 않았어요.',action:'사진 위치를 비교하거나 시설에 다른 입구를 문의하세요.'};
            switch(result.uncertainty){
                case 'technical':return {title:'입구 사진 분석 중단',reason:result.reason,action:result.nextAction};
                case 'identity':{
                    const visibleName=result.evidence.find(photo=>photo.identity?.visibleName)?.identity?.visibleName;
                    return {title:'선택한 장소인지 미확인',reason:visibleName?`사진 간판: ${visibleName} · 선택 장소와 대조 필요`:'사진에서 점포 간판을 읽지 못했어요.',action:'간판과 지점이 보이는 사진을 확인하세요.'};
                }
                case 'connection':
                case undefined:return {title:'보도–입구 연결 미확인',reason:'사진만으로 출입문까지의 연결을 확인하지 못했어요.',action:'문 아래 연결부 사진을 보거나 시설에 문의하세요.'};
            }
        }
    }
}

export default function PlaceEntrance({place,onLocate}:Props){
    const [state,setState]=useState<State>({kind:'idle'});
    const request=useRef<AbortController|null>(null);
    const sequence=useRef(0);
    const urls=useRef<string[]>([]);
    const placeKey=JSON.stringify([place.id,place.name,place.coord]);
    useEffect(()=>{
        setState({kind:'idle'});
        return ()=>{
            sequence.current++;
            request.current?.abort();
            for(const url of urls.current)URL.revokeObjectURL(url);
            urls.current=[];
        };
    },[placeKey]);
    const current:State=state.kind!=='idle'&&state.placeKey!==placeKey?{kind:'idle'}:state;
    function cancel(){
        sequence.current++;
        request.current?.abort();
        setState({kind:'idle'});
    }
    async function analyze(){
        request.current?.abort();
        for(const url of urls.current)URL.revokeObjectURL(url);
        urls.current=[];
        const controller=new AbortController();
        request.current=controller;
        const attempt=++sequence.current;
        setState({kind:'loading',placeKey});
        try{
            const response=await fetch('/api/entrance',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(95000)]),body:JSON.stringify({place})});
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
        }catch(error){
            if(attempt!==sequence.current||controller.signal.aborted)return;
            for(const url of urls.current)URL.revokeObjectURL(url);
            urls.current=[];
            const message=error instanceof Error&&error.name==='TimeoutError'?'입구 사진 응답 제한 시간이 끝났습니다.':error instanceof TypeError?'입구 사진 서비스에 연결하지 못했습니다.':error instanceof Error&&error.name!=='ZodError'?error.message:'입구 사진 결과 형식을 읽지 못했습니다.';
            setState({kind:'error',placeKey,message});
        }
    }
    const summary=current.kind==='result'?entranceSummary(current.result):null;
    const technical=current.kind==='result'&&current.result.uncertainty==='technical';
    const needsCall=current.kind==='result'&&(current.result.verdict==='raised'||current.result.verdict==='unknown'&&current.result.uncertainty==='connection');
    return <section className="destination-info place-entrance" aria-label={`${place.name} 도로변 입구 확인`}>
        <h3 className="entrance-title">{place.name}</h3>
        {current.kind==='idle'&&<>
            <p className="entrance-reason">거리 사진에서 간판·입구 연결을 확인해요.</p>
            <div className="entrance-actions"><button className="entrance-primary" type="button" aria-label="입구 확인" onClick={()=>void analyze()}>입구 사진 확인</button></div>
        </>}
        {current.kind==='loading'&&<div className="entrance-loading" role="status"><p>입구 사진 분석 중</p><button type="button" onClick={cancel}>취소</button></div>}
        {current.kind==='error'&&<div role="alert">
            <h4 className="entrance-status">입구 사진 분석 중단</h4>
            <p className="entrance-reason">{current.message}</p>
            <p className="entrance-next">잠시 후 다시 시도하거나 시설에 입구를 문의하세요.</p>
            <div className="entrance-actions"><button className="entrance-primary" type="button" onClick={()=>void analyze()}>다시 확인</button></div>
            <details className="entrance-details"><summary>다시 시도·장소 정보</summary>
                <div className="entrance-secondary-actions">
                    {place.phone&&<a href={`tel:${place.phone.replace(/[^+0-9]/g,'')}`}>입구 문의 전화</a>}
                    {place.placeUrl&&<a href={place.placeUrl} target="_blank" rel="noopener noreferrer">장소 상세 보기</a>}
                </div>
            </details>
        </div>}
        {current.kind==='result'&&summary&&<div aria-live="polite">
            <h4 className="entrance-status">{summary.title}</h4>
            <p className="entrance-reason">{summary.reason}</p>
            <p className="entrance-next">{summary.action}</p>
            {technical?<div className="entrance-actions"><button className="entrance-primary" type="button" onClick={()=>void analyze()}>다시 확인</button></div>:needsCall&&place.phone&&<div className="entrance-actions"><a className="entrance-primary" href={`tel:${place.phone.replace(/[^+0-9]/g,'')}`}>입구 문의 전화</a></div>}
            {!!current.result.evidence.length&&<details className="entrance-photos">
                <summary className={!technical&&!(needsCall&&place.phone)?'entrance-primary':undefined}>입구 연결 사진 더 보기 ({current.result.evidence.length}장)</summary>
                {current.result.evidence.map((photo,index)=><figure key={photo.id}>
                    <a href={photo.source.url} target="_blank" rel="noopener noreferrer" aria-label={`입구 거리 사진 ${index+1} 원본 위치 보기`}><Image src={photo.photoUrl} alt={`${place.name} 입구 확인용 실제 거리 사진 ${index+1}`} width={640} height={640} unoptimized style={{maxWidth:'100%',height:'auto'}}/></a>
                    <figcaption>
                        <p>촬영 시점 {photo.source.capturedMonth??(photo.source.capturedAt===null?'미제공':new Date(photo.source.capturedAt).toISOString().slice(0,10))}</p>
                        <p>{photo.identity?.reason??'사진은 확보했으나 이 시야의 공동 대조 관찰을 완료하지 못했습니다.'}</p>
                        {photo.identity&&<><p>읽힌 간판: {photo.identity.visibleName||'판독 불가'}</p><p>{photo.identity.identityReason}</p><p>거리사진에서 확인할 시야: {photo.identity.nextAction}</p></>}
                        <a href={photo.source.url} target="_blank" rel="noopener noreferrer">거리 사진 원본 위치 보기</a>
                        <details><summary>분석에 사용한 사진 정보</summary>
                            <p>촬영 좌표 {photo.source.coord.join(', ')} · 방향 {photo.source.heading}°{photo.source.panoId?` · 파노라마 ${photo.source.panoId}`:''}</p>
                            <p>요청 좌표 {photo.input.coord.join(', ')} · 목표 {photo.input.target.join(', ')} · 요청 방향 {photo.input.heading}° · 기울임 {photo.input.tilt}° · 확대 {photo.input.zoom}</p>
                        </details>
                    </figcaption>
                </figure>)}
            </details>}
            <details className="entrance-details">
                <summary>판단 근거·한계·다시 확인</summary>
                <p>{current.result.reason}</p>
                <p>다음 확인: {current.result.nextAction}</p>
                <ul>{current.result.limitations.map((limitation,index)=><li key={index}>{limitation}</li>)}</ul>
                <small>분석 {new Date(current.result.checkedAt).toLocaleString('ko-KR')} · {current.result.model}</small>
                <div className="entrance-secondary-actions">
                    {!technical&&<button type="button" onClick={()=>void analyze()}>다시 확인</button>}
                    {place.phone&&<a href={`tel:${place.phone.replace(/[^+0-9]/g,'')}`}>입구 문의 전화</a>}
                    {onLocate&&<button type="button" onClick={()=>onLocate(place.coord)}>지도에서 장소 보기</button>}
                    {place.placeUrl&&<a href={place.placeUrl} target="_blank" rel="noopener noreferrer">장소 상세 보기</a>}
                </div>
            </details>
        </div>}
    </section>;
}
