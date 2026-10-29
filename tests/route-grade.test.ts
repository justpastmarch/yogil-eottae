import test from 'node:test';
import assert from 'node:assert/strict';
import type {Coord,Route} from '../lib/domain.ts';
import {loadRouteGrades,orderByRoutePreference,routeGradeSchema} from '../lib/route-grade.ts';

const METERS_PER_DEGREE=6371000*Math.PI/180;
const north=(along:number,lng:number):Coord=>[lng,along/METERS_PER_DEGREE];
function route(id:string,coords:Coord[],seconds=100):Route{
    return {id,name:id,coords,seconds,distance:180,options:[],steps:[],samples:[],fetchedAt:'2026-10-28T00:00:00.000Z'};
}
async function withTerrain<T>(height:(coord:Coord)=>number|null,body:(requests:Coord[][])=>Promise<T>):Promise<T>{
    const original=globalThis.fetch;
    const requests:Coord[][]=[];
    globalThis.fetch=async input=>{
        const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
        assert.equal(url.origin,'https://api.opentopodata.org');
        assert.equal(url.pathname,'/v1/srtm30m');
        const coords:Coord[]=(url.searchParams.get('locations')??'').split('|').map(location=>{
            const [lat,lng]=location.split(',').map(Number);
            return [lng,lat];
        });
        assert.ok(coords.length<=100,'terrain requests are bounded to the endpoint limit');
        requests.push(coords);
        return Response.json({status:'OK',results:coords.map(coord=>({dataset:'srtm30m',elevation:height(coord),location:{lng:coord[0],lat:coord[1]}}))});
    };
    try{return await body(requests);}finally{globalThis.fetch=original;}
}

test('terrain grades reverse direction with ascent and descent, without changing absolute steepness',async()=>{
    const forward=route('forward',[north(0,10),north(180,10)]);
    const reverse=route('reverse',[...forward.coords].reverse());
    await withTerrain(coord=>coord[1]*METERS_PER_DEGREE/10,async()=>{
        const grades=await loadRouteGrades([forward,reverse],new AbortController().signal);
        const up=grades.forward,down=grades.reverse;
        assert.equal(up.status,'available');
        assert.equal(down.status,'available');
        assert.ok(up.segments.every(segment=>Math.abs(segment.gradePercent-10)<1e-6));
        assert.ok(down.segments.every(segment=>Math.abs(segment.gradePercent+10)<1e-6));
        assert.ok(Math.abs(up.ascentMeters-18)<1e-6);
        assert.ok(Math.abs(down.descentMeters-18)<1e-6);
        assert.equal(up.descentMeters,0);
        assert.equal(down.ascentMeters,0);
        assert.ok(Math.abs(up.maxAbsPercent-down.maxAbsPercent)<1e-6);
        assert.equal(up.coverageFraction,1);
        assert.equal(up.dataset,'srtm30m');
        assert.equal(up.resolutionMeters,30);
        assert.equal(up.baselineMeters,60);
        assert.ok(Number.isFinite(Date.parse(up.retrievedAt)));
        assert.ok(up.segments.every(segment=>segment.toAlong-segment.fromAlong>=60-1e-6));
        assert.equal(routeGradeSchema.safeParse(up).success,true);
    });
});

test('missing elevations produce partial coverage and never interpolate across a hole',async()=>{
    await withTerrain(coord=>{
        const along=coord[1]*METERS_PER_DEGREE;
        return Math.abs(along-150)<2?null:along/10;
    },async()=>{
        const grades=await loadRouteGrades([route('hole',[north(0,11),north(300,11)])],new AbortController().signal);
        const grade=grades.hole;
        assert.equal(grade.status,'partial');
        assert.ok(grade.coverageFraction>0&&grade.coverageFraction<1);
        assert.ok(grade.segments.every(segment=>segment.toAlong<150||segment.fromAlong>150));
        assert.ok(grade.segments.every(segment=>segment.toAlong-segment.fromAlong>=60-1e-6));
        assert.ok(Math.abs(grade.maxAbsPercent-10)<1e-6);
        assert.equal(routeGradeSchema.safeParse(grade).success,true);
    });
});

test('short routes and short non-null runs are missing grade, not flat',async()=>{
    await withTerrain(coord=>Math.abs(coord[1]*METERS_PER_DEGREE-60)<2?null:100,async requests=>{
        const grades=await loadRouteGrades([
            route('short',[north(0,12),north(59,12)]),
            route('split',[north(0,12),north(120,12)]),
        ],new AbortController().signal);
        assert.equal(grades.short.status,'unavailable');
        assert.equal(grades.split.status,'unavailable');
        if(grades.short.status!=='unavailable'||grades.split.status!=='unavailable')throw new Error('Expected unavailable profiles');
        assert.equal(grades.short.reason,'insufficient-span');
        assert.equal(grades.split.reason,'insufficient-span');
        assert.deepEqual(grades.split.segments,[]);
        assert.equal(grades.short.coverageFraction,0);
        assert.equal(grades.short.retrievedAt,null);
        assert.ok(requests.flat().every(coord=>Math.abs(coord[1]*METERS_PER_DEGREE-59)>0.1),'short path does not request an unusable baseline');
    });
});

test('gentle and fast preferences expose the actual slope-versus-time tradeoff',async()=>{
    const quick=route('quick',[north(0,13),north(180,13)],60);
    const gentle=route('gentle',[north(0,14),north(180,14)],180);
    await withTerrain(coord=>coord[1]*METERS_PER_DEGREE*(coord[0]===13?0.12:0.02),async()=>{
        const grades=await loadRouteGrades([quick,gentle],new AbortController().signal);
        const candidates=[{...quick,grade:grades.quick},{...gentle,grade:grades.gentle}];
        assert.deepEqual(orderByRoutePreference(candidates,'gentle').map(candidate=>candidate.id),['gentle','quick']);
        assert.deepEqual(orderByRoutePreference(candidates,'fast').map(candidate=>candidate.id),['quick','gentle']);
        assert.deepEqual(candidates.map(candidate=>candidate.id),['quick','gentle'],'ranking does not mutate caller order');
    });
});

test('partial, absent, and unavailable grades never masquerade as the gentlest route',async()=>{
    const complete=route('complete',[north(0,15),north(300,15)],200);
    const partial=route('partial',[north(0,16),north(300,16)],20);
    const missing=route('missing',[north(0,17),north(30,17)],10);
    await withTerrain(coord=>coord[0]===16&&Math.abs(coord[1]*METERS_PER_DEGREE-150)<2?null:coord[0]===16?0:coord[1]*METERS_PER_DEGREE/10,async()=>{
        const grades=await loadRouteGrades([complete,partial,missing],new AbortController().signal);
        assert.equal(grades.complete.status,'available');
        assert.equal(grades.partial.status,'partial');
        const candidates=[{...partial,grade:grades.partial},{...missing,grade:grades.missing},route('absent',[],5),{...complete,grade:grades.complete}];
        assert.equal(orderByRoutePreference(candidates,'gentle')[0].id,'complete');
        assert.equal(orderByRoutePreference(candidates,'fast')[0].id,'absent');
    });
});

test('all candidates including detours are sampled, deduplicated, and cached without refreshing retrieval dates',async()=>{
    const primary=route('primary',[north(0,18),north(180,18)]);
    const detour={...route('detour',[north(0,19),north(180,19)]),detourReason:'Avoid a blocked passage'};
    const duplicate={...primary,id:'duplicate'};
    await withTerrain(coord=>coord[1]*METERS_PER_DEGREE/20,async requests=>{
        const first=await loadRouteGrades([primary,detour,duplicate],new AbortController().signal);
        assert.equal(first.primary.status,'available');
        assert.equal(first.detour.status,'available');
        assert.deepEqual(first.primary,first.duplicate);
        const sent=requests.flat();
        assert.ok(sent.some(coord=>coord[0]===18));
        assert.ok(sent.some(coord=>coord[0]===19));
        assert.equal(new Set(sent.map(coord=>coord.join(','))).size,sent.length);
        const requestCount=requests.length;
        const second=await loadRouteGrades([primary,detour],new AbortController().signal);
        assert.equal(requests.length,requestCount);
        assert.equal(second.primary.retrievedAt,first.primary.retrievedAt);
    });
});

test('grade segments follow path bends instead of drawing straight shortcuts',async()=>{
    const corner:Coord=[20,90/METERS_PER_DEGREE];
    const bent=route('bent',[[20,0],corner,[20+90/METERS_PER_DEGREE,90/METERS_PER_DEGREE]]);
    await withTerrain(coord=>(coord[1]+coord[0]-20)*METERS_PER_DEGREE/10,async()=>{
        const grade=(await loadRouteGrades([bent],new AbortController().signal)).bent;
        assert.equal(grade.status,'available');
        assert.ok(grade.segments.some(segment=>segment.coords.some(coord=>coord[0]===corner[0]&&coord[1]===corner[1])));
        const end=grade.segments.at(-1);
        assert.ok(end&&Math.abs(end.toAlong-180)<0.01);
    });
});

test('terrain transport failure stays unavailable and aborts propagate',async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>{throw new Error('offline');};
    try{
        const candidate=route('offline',[north(0,21),north(180,21)]);
        const grade=(await loadRouteGrades([candidate],new AbortController().signal)).offline;
        assert.equal(grade.status,'unavailable');
        if(grade.status!=='unavailable')throw new Error('Expected unavailable terrain');
        assert.equal(grade.reason,'transport');
        assert.equal('maxAbsPercent' in grade,false);
        const controller=new AbortController();controller.abort();
        await assert.rejects(loadRouteGrades([candidate],controller.signal),{name:'AbortError'});
    }finally{globalThis.fetch=original;}
});

test('all-null terrain remains no-data when cached instead of becoming a flat profile',async()=>{
    const candidate=route('no-data',[north(0,22),north(180,22)]);
    await withTerrain(()=>null,async requests=>{
        const first=(await loadRouteGrades([candidate],new AbortController().signal))['no-data'];
        const requestCount=requests.length;
        const second=(await loadRouteGrades([candidate],new AbortController().signal))['no-data'];
        assert.equal(first.status,'unavailable');
        assert.equal(second.status,'unavailable');
        if(first.status!=='unavailable'||second.status!=='unavailable')throw new Error('Expected missing terrain');
        assert.equal(first.reason,'no-data');
        assert.equal(second.reason,'no-data');
        assert.equal(second.coverageFraction,0);
        assert.equal('maxAbsPercent' in second,false);
        assert.equal(requests.length,requestCount);
        assert.equal(second.retrievedAt,first.retrievedAt);
    });
});

test('a route longer than one request is batched without losing path coverage',async()=>{
    await withTerrain(coord=>coord[1]*METERS_PER_DEGREE/20,async requests=>{
        const grade=(await loadRouteGrades([route('long',[north(0,23),north(3300,23)])],new AbortController().signal)).long;
        assert.equal(grade.status,'available');
        assert.ok(requests.length>1);
        assert.ok(requests.every(request=>request.length<=100));
        assert.equal(grade.coverageFraction,1);
    });
});

test('reversing a local hill does not erase its absolute grade or move its physical segment',async()=>{
    const forward=route('hill',[north(0,24),north(210,24)]);
    const reverse=route('hill-reverse',[...forward.coords].reverse());
    await withTerrain(coord=>Math.abs(coord[1]*METERS_PER_DEGREE-60)<1?6:0,async()=>{
        const grades=await loadRouteGrades([forward,reverse],new AbortController().signal);
        const a=grades.hill,b=grades['hill-reverse'];
        assert.equal(a.status,'available');assert.equal(b.status,'available');
        assert.ok(a.maxAbsPercent>9);
        assert.equal(a.maxAbsPercent,b.maxAbsPercent);
        assert.equal(a.ascentMeters,b.descentMeters);
        assert.deepEqual(a.segments.map(segment=>segment.coords),b.segments.map(segment=>[...segment.coords].reverse()).reverse());
    });
});
