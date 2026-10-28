import {sqliteTable,text,integer,index,blob,primaryKey} from 'drizzle-orm/sqlite-core';
export const journeyJobs=sqliteTable('journey_jobs',{
    id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),state:text('state').notNull(),
    phase:text('phase').notNull(),revision:integer('revision').notNull().default(0),
    leaseToken:text('lease_token'),leaseUntil:integer('lease_until').notNull().default(0),
    expiresAt:integer('expires_at').notNull(),updatedAt:integer('updated_at').notNull(),
},table=>[index('journey_jobs_expiry').on(table.expiresAt)]);
export const journeyCaptures=sqliteTable('journey_captures',{
    id:text('id').primaryKey(),jobId:text('job_id').notNull().references(()=>journeyJobs.id,{onDelete:'cascade'}),
    evidenceId:text('evidence_id').notNull(),viewId:text('view_id').notNull(),source:text('source').notNull(),
    mime:text('mime').notNull(),byteLength:integer('byte_length').notNull(),createdAt:integer('created_at').notNull(),
},table=>[index('journey_captures_job').on(table.jobId,table.createdAt)]);
export const journeyCaptureParts=sqliteTable('journey_capture_parts',{
    captureId:text('capture_id').notNull().references(()=>journeyCaptures.id,{onDelete:'cascade'}),
    partIndex:integer('part_index').notNull(),bytes:blob('bytes',{mode:'buffer'}).notNull(),
},table=>[primaryKey({columns:[table.captureId,table.partIndex]})]);
