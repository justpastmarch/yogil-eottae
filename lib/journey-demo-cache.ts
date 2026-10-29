import {z} from 'zod';
import {journeyStateSchema,type JourneyInput,type JourneyState} from './journey.ts';
import type {ServerConfig} from './server-config.ts';

const rowSchema=z.object({id:z.string(),state:z.string(),phase:journeyStateSchema.shape.phase,revision:z.number(),expires_at:z.number()});
const storedSchema=journeyStateSchema.extend({reservedReplans:journeyStateSchema.shape.pendingReplans.optional()});
function tripKey(input:JourneyInput,provider:string,imagery:string){
    return JSON.stringify([input.start.id,input.start.coord,input.end.id,input.end.coord,input.profile,input.goal,input.maxSlope??null,provider,imagery]);
}

// Explicit local filming mode: existing jobs predate model fingerprints and must never become a production cache.
export async function cloneDemoJourney(db:D1Database,input:JourneyInput,owner:string,config:ServerConfig,now=Date.now()):Promise<string|null>{
    const rows=await db.prepare('SELECT id,state,phase,revision,expires_at FROM journey_jobs WHERE owner_id=? AND expires_at>? ORDER BY updated_at DESC LIMIT 30').bind(owner,now+60_000).all();
    const key=tripKey(input,config.routing.kind,input.imageryProvider??config.imageryProvider??'configured');
    const candidates=rows.results.flatMap(raw=>{
        const row=rowSchema.safeParse(raw);if(!row.success)return [];
        let parsed:unknown;try{parsed=JSON.parse(row.data.state);}catch{return [];}
        const stored=storedSchema.safeParse(parsed);if(!stored.success)return [];
        const state=stored.data;
        if(tripKey(state,state.provider,state.imageryProvider??'configured')!==key)return [];
        const completed=Object.values(state.evidence).filter(item=>item.stage==='processed'&&item.finding&&item.source).length;
        return completed?[{row:row.data,state,completed}]:[];
    }).sort((a,b)=>b.completed-a.completed);
    for(const candidate of candidates){
        const {row}=candidate;
        const state:JourneyState=journeyStateSchema.parse(candidate.state);
        if(candidate.state.reservedReplans?.length){state.pendingReplans.unshift(...candidate.state.reservedReplans);state.replans=Math.max(0,state.replans-candidate.state.reservedReplans.length);}
        for(const [evidenceId,item] of Object.entries(state.evidence)){
            if(item.stage==='reserved'){delete state.evidence[evidenceId];continue;}
            if(item.review?.state==='reserved')item.review.state='pending';
        }
        state.phase=row.phase==='ready'||row.phase==='limited'?row.phase:'running';
        const id=crypto.randomUUID();
        const captures=await db.prepare('SELECT id,evidence_id FROM journey_captures WHERE job_id=?').bind(row.id).all();
        const statements=[db.prepare('INSERT INTO journey_jobs (id,owner_id,state,phase,revision,lease_until,expires_at,updated_at) SELECT ?,owner_id,?,?,0,0,expires_at,? FROM journey_jobs WHERE id=? AND owner_id=? AND revision=? AND expires_at>?').bind(id,JSON.stringify(state),state.phase,now,row.id,owner,row.revision,now+60_000)];
        for(const raw of captures.results){
            const capture=z.object({id:z.string(),evidence_id:z.string()}).parse(raw);
            if(!state.evidence[capture.evidence_id])continue;
            const captureId=crypto.randomUUID();
            statements.push(db.prepare('INSERT INTO journey_captures (id,job_id,evidence_id,view_id,source,mime,byte_length,created_at) SELECT ?,?,evidence_id,view_id,source,mime,byte_length,created_at FROM journey_captures WHERE id=? AND EXISTS (SELECT 1 FROM journey_jobs WHERE id=?)').bind(captureId,id,capture.id,id));
            statements.push(db.prepare('INSERT INTO journey_capture_parts (capture_id,part_index,bytes) SELECT ?,part_index,bytes FROM journey_capture_parts WHERE capture_id=? AND EXISTS (SELECT 1 FROM journey_captures WHERE id=?)').bind(captureId,capture.id,captureId));
        }
        const results=await db.batch(statements);
        if(results[0].meta.changes===1)return id;
    }
    return null;
}
