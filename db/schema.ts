import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const journeyJobs=sqliteTable('journey_jobs',{
    id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),state:text('state').notNull(),
    phase:text('phase').notNull(),revision:integer('revision').notNull().default(0),
    leaseToken:text('lease_token'),leaseUntil:integer('lease_until').notNull().default(0),
    expiresAt:integer('expires_at').notNull(),updatedAt:integer('updated_at').notNull(),
},table=>[index('journey_jobs_expiry').on(table.expiresAt)]);
