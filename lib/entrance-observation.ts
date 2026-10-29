import type {EntranceResponse} from './place-entrance.ts';

type ObservationInput=Pick<EntranceResponse,'observations'|'uncertainty'>&{
    evidence:ReadonlyArray<Pick<EntranceResponse['evidence'][number],'id'|'identity'>>;
};
export function entranceObservationSummary(result:ObservationInput){
    const views=result.evidence.flatMap(photo=>{
        const review=photo.identity;
        if(review?.linkage?.kind==='different')return [];
        const observation=result.observations?.find(item=>item.viewId===photo.id);
        const connection=observation?.connection??review?.connection;
        return connection?[{connection,bypass:review?.bypass,reason:observation?.reason??review?.reason??''}]:[];
    });
    const ramp=views.find(view=>view.connection==='ramp'||view.bypass==='ramp');
    const flat=views.find(view=>view.connection==='flat');
    const steps=views.find(view=>view.connection==='stairs'||view.connection==='raised');
    const visible=ramp??flat??steps;
    if(visible)return {
        title:ramp?'진입 가능 · 경사로 있음':flat?'진입 가능 · 평탄한 접근로':'진입에 유의 · 계단·턱 있음',
        reason:visible.reason,
        action:'사진에서 보이는 접근로와 출입문 아래 연결부를 함께 살펴보세요.',
    };
    if(views.length)return {title:'진입에 유의 · 사진 확인 어려움',reason:views[0].reason,action:'가림을 피하고 바닥이 보이는 낮은 시선으로 선택 위치 주변을 다시 확인하세요.'};
    if(result.uncertainty==='technical')return {title:'입구 사진 연결 실패',reason:'주변 접근로를 관찰하지 못했어요.',action:'사진 서비스에 연결하지 못했거나 사진을 읽지 못했어요. 다시 확인해 주세요.'};
    return {title:'진입에 유의 · 사진 근거 부족',reason:'선택 위치를 향한 접근로 관찰을 확보하지 못했어요.',action:'선택 위치 쪽 바닥과 접근로가 보이는 사진을 다시 확인하세요.'};
}
