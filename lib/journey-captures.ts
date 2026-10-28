import {z} from 'zod';
import {capturePreviewSchema,type CapturePreview,type CapturedJourneyView} from './capture-contract.ts';
import {evidenceSource} from './adjacent-views.ts';

const PART_BYTES=1024*1024;
const captureRowSchema=z.object({id:z.string().uuid(),evidence_id:z.string(),view_id:z.string(),source:z.string(),created_at:z.number()});
const blobBytes=z.custom<number[]>(value=>Array.isArray(value)&&value.every((byte:unknown)=>typeof byte==='number'&&Number.isInteger(byte)&&byte>=0&&byte<=255));
const imageRowSchema=z.object({mime:z.enum(['image/jpeg','image/png','image/webp']),byte_length:z.number().int().positive(),part_index:z.number().int().nonnegative(),bytes:blobBytes});
export type CaptureLease={revision:number;token:string};

function preview(row:unknown):CapturePreview{
    const capture=captureRowSchema.parse(row);
    return capturePreviewSchema.parse({id:capture.id,evidenceId:capture.evidence_id,viewId:capture.view_id,url:'/api/journey-image?id='+capture.id,source:JSON.parse(capture.source),createdAt:new Date(capture.created_at).toISOString()});
}

export async function saveJourneyCapture(db:D1Database,input:{jobId:string;ownerId:string;lease:CaptureLease;view:CapturedJourneyView},now=Date.now()):Promise<CapturePreview|null>{
    const {jobId,ownerId,lease,view}=input,id=crypto.randomUUID();
    const bytes=Uint8Array.from(atob(view.image.image.data),character=>character.charCodeAt(0));
    const source=JSON.stringify(evidenceSource(view.image,view.target));
    const metadata=db.prepare("INSERT INTO journey_captures (id,job_id,evidence_id,view_id,source,mime,byte_length,created_at) SELECT ?,id,?,?,?,?,?,? FROM journey_jobs WHERE id=? AND owner_id=? AND revision=? AND lease_token=? AND lease_until>? AND expires_at>? AND phase='running'").bind(id,view.evidenceId,view.viewId,source,view.image.image.mime,bytes.length,now,jobId,ownerId,lease.revision,lease.token,now,now);
    const statements=[metadata];
    for(let offset=0;offset<bytes.length;offset+=PART_BYTES){
        statements.push(db.prepare('INSERT INTO journey_capture_parts (capture_id,part_index,bytes) SELECT id,?,? FROM journey_captures WHERE id=?').bind(offset/PART_BYTES,bytes.subarray(offset,offset+PART_BYTES),id));
    }
    // D1 batches are transactional: the fence and every part become visible together.
    const results=await db.batch(statements);
    return results[0].meta.changes===1?preview({id,evidence_id:view.evidenceId,view_id:view.viewId,source,created_at:now}):null;
}

export async function listJourneyCaptures(db:D1Database,jobId:string,ownerId:string,now=Date.now()):Promise<CapturePreview[]>{
    const result=await db.prepare('SELECT c.id,c.evidence_id,c.view_id,c.source,c.created_at FROM journey_captures c JOIN journey_jobs j ON j.id=c.job_id WHERE j.id=? AND j.owner_id=? AND j.expires_at>? ORDER BY c.created_at,c.rowid').bind(jobId,ownerId,now).all();
    return result.results.map(preview);
}

export async function readJourneyCapture(db:D1Database,id:string,ownerId:string,now=Date.now()):Promise<{mime:string;bytes:Uint8Array}|null>{
    const result=await db.prepare('SELECT c.mime,c.byte_length,p.part_index,p.bytes FROM journey_captures c JOIN journey_jobs j ON j.id=c.job_id JOIN journey_capture_parts p ON p.capture_id=c.id WHERE c.id=? AND j.owner_id=? AND j.expires_at>? ORDER BY p.part_index').bind(id,ownerId,now).all();
    if(!result.results.length)return null;
    const parts=z.array(imageRowSchema).parse(result.results),first=parts[0];
    const bytes=new Uint8Array(first.byte_length);
    let offset=0;
    for(const [index,part] of parts.entries()){
        if(part.part_index!==index||part.bytes.length>PART_BYTES||offset+part.bytes.length>bytes.length)throw new Error('Invalid stored journey image parts');
        bytes.set(part.bytes,offset);
        offset+=part.bytes.length;
    }
    if(offset!==bytes.length)throw new Error('Incomplete stored journey image');
    return {mime:first.mime,bytes};
}
