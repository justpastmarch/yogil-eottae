'use client';

import {useEffect,useRef,useState} from 'react';
import {ExternalLink,X} from 'lucide-react';
import type {EvidenceSource} from '../lib/domain.ts';
import {loadNaverMaps,subscribeNaverAuthFailure,type NaverPanorama} from '../lib/naver-map-sdk.ts';
import {naverPanoramaPose} from '../lib/roadview-source.ts';

type Source=Omit<EvidenceSource,'distance'>;
export default function PanoramaModal({source,onClose}:{source:Source;onClose():void}){
    const container=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDialogElement>(null);
    const [error,setError]=useState('');
    useEffect(()=>{
        const element=container.current,bounds=viewport.current,modal=dialog.current,opener=document.activeElement;
        let disposed=false,failed=false,view:NaverPanorama|undefined;
        const removers:(()=>void)[]=[];
        const fail=(message:string)=>{
            if(disposed)return;
            failed=true;
            clearTimeout(timer);
            view?.setVisible(false);
            setError(message+' 보관된 판독 사진은 바뀌지 않으며 원본 링크는 별도로 열 수 있습니다.');
        };
        const timer=setTimeout(()=>fail('NAVER 거리뷰 응답 시간이 초과되었습니다.'),15000);
        const unsubscribe=subscribeNaverAuthFailure(error=>fail(error.message));
        modal?.showModal();
        setError('');
        const pose=naverPanoramaPose(source);
        if(!pose)fail('이 사진에는 재현 가능한 NAVER 파노라마 촬영 정보가 없습니다.');
        else void loadNaverMaps().then(sdk=>{
            if(disposed||failed||!element||!bounds)return;
            const resize=()=>{
                if(disposed||failed||!view)return;
                view.setSize({width:bounds.clientWidth,height:bounds.clientHeight});
            };
            view=new sdk.Panorama(element,{panoId:pose.panoId,pov:{pan:pose.pan,tilt:pose.tilt,fov:pose.fov}});
            const onInit=()=>{
                if(disposed||failed||!view)return;
                if(view.getPanoId()!==pose.panoId){fail('저장된 사진과 다른 파노라마가 반환되었습니다.');return;}
                view.setPov({pan:pose.pan,tilt:pose.tilt,fov:pose.fov});
                resize();
                clearTimeout(timer);
            };
            const init=sdk.Event.addListener(view,'init',onInit);
            const status=sdk.Event.addListener(view,'pano_status',status=>{
                if(status!=='OK')fail('이 촬영 위치의 NAVER 거리뷰를 열 수 없습니다.');
            });
            removers.push(()=>sdk.Event.removeListener(init),()=>sdk.Event.removeListener(status));
            const observer=new ResizeObserver(resize);
            observer.observe(bounds);
            removers.push(()=>observer.disconnect());
            resize();
        }).catch(()=>fail('NAVER 거리뷰를 초기화하지 못했습니다.'));
        return ()=>{
            disposed=true;
            clearTimeout(timer);
            unsubscribe();
            for(const remove of removers)remove();
            view?.setVisible(false);
            modal?.close();
            element?.replaceChildren();
            if(opener instanceof HTMLElement&&opener.isConnected)opener.focus({preventScroll:true});
        };
    },[source]);
    return <dialog ref={dialog} className="roadview-dialog" aria-label="NAVER 360도 거리뷰 확인" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
        <div className="roadview-modal-content">
            <header className="roadview-modal-header"><div><h3>NAVER 360° 거리뷰</h3><p>이 사진의 촬영 위치·시야에서 시작합니다. 현재 현장이나 보관된 판독 사진을 대신하지 않습니다.</p></div><button type="button" onClick={onClose} aria-label="거리뷰 닫기"><X size={20}/></button></header>
            {error&&<p role="alert" className="notice">{error}</p>}
            <div ref={viewport} className="roadview-modal-viewport" style={{width:'100%',height:'min(60vh, 600px)',position:'relative'}}><div ref={container} style={{width:'100%',height:'100%'}}/></div>
            <footer className="roadview-modal-footer"><span>© NAVER Corp. · 촬영 {source.capturedMonth??(source.capturedAt===null?'시점 미상':new Date(source.capturedAt).toLocaleDateString('ko-KR'))} · 실제 FOV {source.fov}°</span><a href={source.url} target="_blank" rel="noopener noreferrer">NAVER 촬영 원본 <ExternalLink size={12}/></a></footer>
        </div>
    </dialog>;
}
