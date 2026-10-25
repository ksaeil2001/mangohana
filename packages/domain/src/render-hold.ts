import type {RenderedPage,RenderLayout} from '../../media/src/render.js';
import type {ObjectStore} from '../../storage/src/objects.js';
import {DomainError} from '../../contracts/src/errors.js';
import {sha256} from '../../contracts/src/intent.js';
import type {AssetDependency} from './model.js';

export type ProtectedRenderOverlay={regionId:string;bounds:RenderedPage['overlays'][number]['bounds'];dependency:AssetDependency;storage:'PLANNED'};
export type OverlayAvailability={assetId:string;state:'COMPLETE'|'NOT_PRESENT'|'UNCONFIRMED'};
export type RenderHoldReview={layout:RenderLayout;overlays:ProtectedRenderOverlay[];availability:OverlayAvailability[]};
export class DurableRenderHold extends DomainError {
  constructor(readonly review:RenderHoldReview){super('RENDER_QA_HOLD',409,'WAIT');}
}

// Availability is sampled separately. It never changes the protected layout or an evidence digest.
export async function overlayAvailability(store:ObjectStore,accountId:string,overlays:ProtectedRenderOverlay[]):Promise<OverlayAvailability[]> {
  return Promise.all(overlays.map(async overlay=>{
    const expected=overlay.dependency,key=`${accountId}/${expected.assetId}`;let state:OverlayAvailability['state']='UNCONFIRMED';
    try {
      const proof=await store.receipt(key);
      if(proof&&proof.sha256===expected.sha256&&proof.bytesLength===expected.bytesLength){const bytes=await store.read(key);if(bytes.length.toString()===expected.bytesLength&&sha256(bytes)===expected.sha256)state='COMPLETE';}
      else if(!proof&&await store.presence?.(key)==='ABSENT')state='NOT_PRESENT';
    }catch{/* Partial files, receipt parse errors, denied reads and digest mismatches stay unconfirmed. */}
    return {assetId:expected.assetId,state};
  }));
}
