import {z} from 'zod';
import {createJourneyState,advanceJourneyState,reserveJourneyOperation,projectJourneyResult,journeyStateSchema,type JourneyInput,type JourneyState} from './journey.ts';
import {serverConfig,serverDatabase} from './server-config.ts';
import type {JourneyResult} from './domain.ts';

const TTL_MS=30*60_000;
const LEASE_MS=90_000;
const STEP_MS=65_000;
const rowSchema=z.object({id:z.string(),state:z.string(),phase:journeyStateSchema.shape.phase,revision:z.number().int(),lease_token:z.string().nullable(),lease_until:z.number(),expires_at:z.number()});
type JobRow=z.infer<typeof rowSchema>;
export type JourneySnapshot={jobId:string;phase:JourneyState['phase'];journey:JourneyResult;progress:{checked:number;total:number;analyses:number}};
export class JourneyJobError extends Error{
    status:number;
    constructor(status:number){super(status===404?'이 경로 탐색이 만료되었거나 존재하지 않습니다.':'경로 탐색을 이어갈 수 없습니다.');this.status=status;}
}
function snapshot(id:string,state:JourneyState):JourneySnapshot{
    return {jobId:id,phase:state.phase,journey:projectJourneyResult(state),progress:{checked:Object.values(state.evidence).filter(e=>e.stage!=='reserved').length,total:state.candidates.reduce((n,r)=>n+r.samples.length,0),analyses:state.analyses}};
}
function decode(row:JobRow):JourneyState{
    const state=journeyStateSchema.parse(JSON.parse(row.state));
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
        return rowSchema.parse(row);
    }
    async acquire(id:string,owner:string,token:string,now=Date.now()):Promise<JobRow|null>{
        const row=await this.db.prepare("UPDATE journey_jobs SET lease_token=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND expires_at>? AND phase='running' AND lease_until<=? RETURNING id,state,phase,revision,lease_token,lease_until,expires_at").bind(token,now+LEASE_MS,now,id,owner,now,now).first();
        if(!row) return null;
        const acquired=rowSchema.parse(row);
        const state=decode(acquired);
        let interrupted=false;
        for(const evidence of Object.values(state.evidence)){
            if(evidence.stage!=='reserved') continue;
            evidence.stage='processed';
            evidence.status='unknown';
            evidence.reason='이전 확인 시도가 중단되어 이 구간의 이동 환경을 확인하지 못했습니다.';
            evidence.checkedAt=new Date(now).toISOString();
            delete evidence.finding;
            delete evidence.source;
            interrupted=true;
        }
        return interrupted?this.write(id,owner,acquired,state,false,now):acquired;
    }
    async write(id:string,owner:string,row:JobRow,state:JourneyState,release:boolean,now=Date.now()):Promise<JobRow|null>{
        const result=await this.db.prepare("UPDATE journey_jobs SET state=?,phase=?,revision=revision+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND lease_token=? AND lease_until>? AND expires_at>? AND phase='running' RETURNING id,state,phase,revision,lease_token,lease_until,expires_at").bind(JSON.stringify(state),state.phase,release?null:row.lease_token,release?0:row.lease_until,now,id,owner,row.revision,row.lease_token,now,now).first();
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
    const state=await createJourneyState(input,config,AbortSignal.any([signal,AbortSignal.timeout(STEP_MS)]));
    signal.throwIfAborted();
    const id=crypto.randomUUID();
    await store.insert(id,ownerId,state);
    return snapshot(id,state);
}
export async function readJourney(jobId:string,ownerId:string):Promise<JourneySnapshot>{
    const row=await new JourneyJobStore(serverDatabase()).read(jobId,ownerId);
    return snapshot(jobId,decode(row));
}
export async function cancelJourney(jobId:string,ownerId:string):Promise<JourneySnapshot>{
    const row=await new JourneyJobStore(serverDatabase()).cancel(jobId,ownerId);
    return snapshot(jobId,decode(row));
}
export async function advanceJourney(jobId:string,ownerId:string,signal:AbortSignal):Promise<JourneySnapshot>{
    const store=new JourneyJobStore(serverDatabase());
    const config=serverConfig();
    const row=await store.acquire(jobId,ownerId,crypto.randomUUID());
    if(!row) return readJourney(jobId,ownerId);
    const state=decode(row);
    const operation=reserveJourneyOperation(state);
    const reserved=await store.write(jobId,ownerId,row,state,!operation);
    if(!reserved||!operation) return readJourney(jobId,ownerId);
    try{
        await advanceJourneyState(state,operation,config,AbortSignal.any([signal,AbortSignal.timeout(STEP_MS)]));
    }catch{
        state.phase=signal.aborted?'limited':'failed';
    }
    await store.write(jobId,ownerId,reserved,state,true);
    return readJourney(jobId,ownerId);
}
