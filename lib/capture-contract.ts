import {z} from 'zod';
import {evidenceSourceSchema} from './domain.ts';
import type {StreetImage} from './street-imagery.ts';
import type {Sample} from './domain.ts';

export const capturePreviewSchema=z.object({
 id:z.string().uuid(),evidenceId:z.string(),viewId:z.string(),url:z.string().startsWith('/api/journey-image?'),source:evidenceSourceSchema,createdAt:z.string(),
});
export type CapturePreview=z.infer<typeof capturePreviewSchema>;
export type CapturedJourneyView={evidenceId:string;viewId:string;image:StreetImage;target:Sample};
export type CaptureObserver=(view:CapturedJourneyView)=>Promise<void>;
