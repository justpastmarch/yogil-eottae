import {z} from 'zod';
import {cloneDemoJourney} from './journey-demo-cache.ts';
import {JOURNEY_VERSION,createJourneyState,advanceJourneyState,reserveJourneyOperation,projectJourneyResult,journeyStateSchema,type JourneyInput,type JourneyState,type JourneyOperation,type JourneyDependencies} from './journey.ts';
import {serverConfig,serverDatabase,type ServerConfig} from './server-config.ts';
import type {JourneyResult} from './domain.ts';
import type {CapturePreview,CaptureObserver} from './capture-contract.ts';
import {saveJourneyCapture,listJourneyCaptures} from './journey-captures.ts';

const TTL_MS=30*60_000;
const LEASE_MS=175_000;
const STEP_MS=150_000;
const rowSchema=z.object({id:z.string(),state:z.string(),phase:journeyStateSchema.shape.phase,revision:z.number().int(),lease_token:z.string().nullable(),lease_until:z.number(),expires_at:z.number()});
const persistedStateSchema=journeyStateSchema.extend({reservedReplans:journeyStateSchema.shape.pendingReplans.optional()});
type JobRow=z.infer<typeof rowSchema>;
export type JourneySnapshot={jobId:string;phase:JourneyState['phase'];journey:JourneyResult;captures:CapturePreview[];progress:{checked:number;total:number;analyses:number;notice?:string}};
export class JourneyJobError extends Error{
    status:number;
    constructor(status:number){super(status===409?'이전 판정 기준의 작업입니다. 경로 찾기를 다시 실행해 주세요.':status===404?'이 경로 탐색이 만료되었거나 존재하지 않습니다.':'경로 탐색을 이어갈 수 없습니다.');this.status=status;}
}
function snapshot(id:string,state:JourneyState,captures:CapturePreview[]=[]):JourneySnapshot{
    return {jobId:id,phase:state.phase,journey:projectJourneyResult(state),captures,progress:{checked:Object.values(state.evidence).filter(e=>e.stage!=='reserved'&&e.finding&&e.source).length,total:state.candidates.reduce((n,r)=>n+r.samples.length,0),analyses:state.analyses,...(state.notice?{notice:state.notice}:{})}};
}
function decode(row:JobRow):JourneyState{
    const raw:unknown=JSON.parse(row.state);
    if(!raw||typeof raw!=='object'||!('version' in raw)||raw.version!==JOURNEY_VERSION)throw new JourneyJobError(409);
    const state=journeyStateSchema.parse(raw);
    state.phase=row.phase;
    return state;
}
export class JourneyJobStore{
    private db:D1Database;
    constructor(db:D1Database){this.db=db;}
    async insert(id:string,owner:string,state:JourneyState,now=Date.now()){
        await this.db.prepare('DELETE FROM journey_jobs WHERE expires_at <= ?').bind(now).run();
        await this.db.prepare('INSERT INTO journey_jobs (id,owner_id,state,phase,revision,lease_until,expires_at,updated_at) VALUES (?,?,?,?,0,0,?,?)').bind(id,owner,JSON.stringify(state),state.phase,now+TTL_MS,now).run();
    }
    async read(id:string,owner:string,now=Date.now()):Promise<JobRow>{
        const row=await this.db.prepare('SELECT id,state,phase,revision,lease_token,lease_until,expires_at FROM journey_jobs WHERE id=? AND owner_id=? AND expires_at>?').bind(id,owner,now).first();
        if(!row) throw new JourneyJobError(404);
        const parsed=rowSchema.parse(row);
        try {decode(parsed);} catch(error){
            if(error instanceof JourneyJobError&&error.status===409){
                await this.db.prepare("UPDATE journey_jobs SET phase='canceled',lease_token=NULL,lease_until=0,revision=revision+1 WHERE id=? AND owner_id=?").bind(id,owner).run();
            }
            throw error;
        }
        return parsed;
    }
    async acquire(id:string,owner:string,token:string,now=Date.now()):Promise<JobRow|null>{
        await this.read(id,owner,now);
        const row=await this.db.prepare("UPDATE journey_jobs SET lease_token=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND expires_at>? AND phase='running' AND lease_until<=? RETURNING id,state,phase,revision,lease_token,lease_until,expires_at").bind(token,now+LEASE_MS,now,id,owner,now,now).first();
        if(!row) return null;
        const acquired=rowSchema.parse(row);
        const state=decode(acquired);
        let interrupted=false;
        const {reservedReplans}=persistedStateSchema.parse(JSON.parse(acquired.state));
        if(reservedReplans?.length){
            state.pendingReplans.unshift(...reservedReplans);
            state.replans-=reservedReplans.length;
            interrupted=true;
        }
        for(const evidence of Object.values(state.evidence)){
            if(evidence.review?.state==='reserved'){evidence.review.state='complete';evidence.review.failure='service';evidence.review.note='연결부 재확인이 중단되었습니다. 최초 관찰은 보존했습니다.';interrupted=true;}
            if(evidence.stage!=='reserved') continue;
            evidence.stage='processed';
            evidence.status='unknown';
            evidence.failure='service';
            evidence.reason='이전 확인 시도가 중단되어 이 구간의 이동 환경을 확인하지 못했습니다.';
            evidence.checkedAt=new Date(now).toISOString();
            delete evidence.finding;
            delete evidence.source;
            interrupted=true;
        }
        return interrupted?this.write(id,owner,acquired,state,false,now):acquired;
    }
    async write(id:string,owner:string,row:JobRow,state:JourneyState,release:boolean,now=Date.now(),reservedReplans:JourneyState['pendingReplans']=[]):Promise<JobRow|null>{
        const persisted=reservedReplans.length?{...state,reservedReplans}:state;
        const result=await this.db.prepare("UPDATE journey_jobs SET state=?,phase=?,revision=revision+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND lease_token=? AND lease_until>? AND expires_at>? AND phase='running' RETURNING id,state,phase,revision,lease_token,lease_until,expires_at").bind(JSON.stringify(persisted),state.phase,release?null:row.lease_token,release?0:row.lease_until,now,id,owner,row.revision,row.lease_token,now,now).first();
        return result?rowSchema.parse(result):null;
    }
    async cancel(id:string,owner:string,now=Date.now()){
        await this.db.prepare("UPDATE journey_jobs SET phase='canceled',revision=revision+1,lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND owner_id=? AND expires_at>? AND phase='running'").bind(now,id,owner,now).run();
        return this.read(id,owner,now);
    }
}

export async function startJourney(input:JourneyInput,ownerId:string,signal:AbortSignal):Promise<JourneySnapshot>{
    const store=new JourneyJobStore(serverDatabase());
    const config=serverConfig();
    if(import.meta.env?.DEV&&process.env.DEMO_JOURNEY_CACHE==='1'){
        const cachedId=await cloneDemoJourney(serverDatabase(),input,ownerId,config);
        if(cachedId)return readJourney(cachedId,ownerId);
    }
    const state=await createJourneyState(input,config,AbortSignal.any([signal,AbortSignal.timeout(STEP_MS)]));
    signal.throwIfAborted();
    const id=crypto.randomUUID();
    await store.insert(id,ownerId,state);
    return snapshot(id,state);
}
export async function readJourney(jobId:string,ownerId:string):Promise<JourneySnapshot>{
    const db=serverDatabase(),row=await new JourneyJobStore(db).read(jobId,ownerId);
    return snapshot(jobId,decode(row),await listJourneyCaptures(db,jobId,ownerId));
}
export async function cancelJourney(jobId:string,ownerId:string):Promise<JourneySnapshot>{
    const db=serverDatabase(),row=await new JourneyJobStore(db).cancel(jobId,ownerId);
    return snapshot(jobId,decode(row),await listJourneyCaptures(db,jobId,ownerId));
}

export async function executeJourneyBatch(state:JourneyState,operations:JourneyOperation[],config:ServerConfig,signal:AbortSignal,deps?:JourneyDependencies,onCapture?:CaptureObserver):Promise<void>{
    const baseline=structuredClone(state);
    const outcomes=await Promise.allSettled(operations.map(async operation=>{
        const local=structuredClone(baseline);
        try {await advanceJourneyState(local,operation,config,signal,deps,onCapture);}
        catch {
            local.phase=signal.aborted?'limited':'failed';
            if(operation.kind!=='replan'){
                const key=operation.route.id+':'+operation.sample.id,item=local.evidence[key];
                if(item?.review?.state==='reserved'){item.review.state='complete';item.review.failure='service';item.review.note='재확인 요청이 중단되었습니다. 최초 관찰은 보존했습니다.';}
                if(item?.stage==='reserved')local.evidence[key]={sampleId:operation.sample.id,stage:'processed',status:'unknown',failure:'service',reason:'분석 요청이 중단되었습니다. 현장 장애 판정이 아닙니다.',checkedAt:new Date().toISOString()};
            }
        }
        return local;
    }));
    const replans=new Map(state.pendingReplans.map(via=>[JSON.stringify(via),via]));
    for(const outcome of outcomes){
        if(outcome.status!=='fulfilled'){state.phase='failed';continue;}
        const local=outcome.value;
        for(const [key,item] of Object.entries(local.evidence))if(JSON.stringify(item)!==JSON.stringify(baseline.evidence[key]))state.evidence[key]=item;
        for(const passage of local.exclusions){
            const index=state.exclusions.findIndex(prior=>prior.id===passage.id);
            if(index===-1)state.exclusions.push(passage);
            else if(state.exclusions[index].reason==='unverified'&&passage.reason!=='unverified')state.exclusions[index]=passage;
        }
        for(const route of local.candidates)if(!state.candidates.some(prior=>prior.id===route.id))state.candidates.unshift(route);
        for(const via of local.pendingReplans)replans.set(JSON.stringify(via),via);
        state.lookups+=local.lookups-baseline.lookups;
        state.analyses+=local.analyses-baseline.analyses;
        if(local.notice)state.notice=local.notice;
        if(local.phase==='failed')state.phase='failed';
        else if(local.phase==='limited'&&state.phase!=='failed')state.phase='limited';
    }
    state.pendingReplans=[...replans.values()];
    if(state.phase==='running'&&projectJourneyResult(state).recommendedId)state.phase='ready';
}

export async function advanceJourney(jobId:string,ownerId:string,signal:AbortSignal):Promise<JourneySnapshot>{
    const store=new JourneyJobStore(serverDatabase()),config=serverConfig();
    const row=await store.acquire(jobId,ownerId,crypto.randomUUID());
    if(!row)return readJourney(jobId,ownerId);
    const state=decode(row),first=reserveJourneyOperation(state);
    const operations:JourneyOperation[]=first?[first]:[];
    if(first?.kind==='capture'){
        const proposed=structuredClone(state),second=reserveJourneyOperation(proposed);
        if(second?.kind==='capture'){Object.assign(state,proposed);operations.push(second);}
    }
    const reservedReplans=operations.flatMap(operation=>operation.kind==='replan'?[operation.via]:[]);
    const reserved=await store.write(jobId,ownerId,row,state,operations.length===0,Date.now(),reservedReplans);
    if(!reserved||!operations.length)return readJourney(jobId,ownerId);
    const token=reserved.lease_token;
    if(!token)return readJourney(jobId,ownerId);
    await executeJourneyBatch(state,operations,config,AbortSignal.any([signal,AbortSignal.timeout(STEP_MS)]),undefined,async view=>{
        signal.throwIfAborted();
        const preview=await saveJourneyCapture(serverDatabase(),{jobId,ownerId,lease:{revision:reserved.revision,token},view});
        if(!preview)throw new DOMException('분석 작업의 이미지 저장 권한이 만료되었습니다.','AbortError');
    });
    signal.throwIfAborted();
    await store.write(jobId,ownerId,reserved,state,true);
    return readJourney(jobId,ownerId);
}
