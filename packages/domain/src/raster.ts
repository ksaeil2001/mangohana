import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import type {ObjectReceipt} from '../../storage/src/objects.js';
import {contextRow,type ResultRow} from './model.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {renderPage,canonicalRendererVersion,RenderLayoutHold,type RenderLayout} from '../../media/src/render.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import type {Assets} from './assets.js';
import {DurableRenderHold,overlayAvailability,type ProtectedRenderOverlay,type RenderHoldReview} from './render-hold.js';
import {NativeJobError,type NativeGateway,type NativeTarget} from '../../native/src/gateway.js';
type Snapshot={render_asset_id:string;render_digest:string};
type Hold={render_digest:string;evidence_digest:string;protected_layout:RenderLayout;protected_overlays:ProtectedRenderOverlay[]};
type Claim={generation:string;owner_id:string;lease_until:Date;render_digest:string};
type Candidate={asset_id:string;render_digest:string};
type Hooks={render?:typeof renderPage;afterPut?:(assetId:string)=>Promise<void>;beforePut?:(assetId:string)=>Promise<void>;afterHold?:()=>Promise<void>;beforeHoldPublish?:()=>Promise<void>;leaseMilliseconds?:number;heartbeatMilliseconds?:number};
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,50));
export class ResultRaster {
  private readonly owner=randomUUID();
  private readonly inFlight=new Map<string,Promise<{bytes:Buffer;assetId:string}>>();
  constructor(readonly db:Database,readonly assets:Assets,readonly fonts:FontCatalog,readonly profile:MediaProfile,private readonly hooks:Hooks={},readonly native?:NativeGateway){requireCondition(profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');}
  get(accountId:string,resultId:string):Promise<{bytes:Buffer;assetId:string}>{const key=`${accountId}:${resultId}`;const prior=this.inFlight.get(key);if(prior)return prior;const pending=this.render(accountId,resultId).finally(()=>this.inFlight.delete(key));this.inFlight.set(key,pending);return pending;}
  private signature(result:ResultRow):string{return digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,data:result.edit_data,fontCatalogVersion:this.fonts.catalog.version,renderer:canonicalRendererVersion(result.edit_data),profile:this.profile.id});}
  // Lookup performs no rendering, native admission, claim, candidate or publication writes.
  async readExisting(accountId:string,resultId:string):Promise<{bytes:Buffer;assetId:string}|null>{
    const captured=await this.db.accountTransaction(accountId,async tx=>{
      const result=(await tx.client.query<ResultRow>('SELECT * FROM results WHERE account_id=$1 AND result_id=$2',[accountId,resultId])).rows[0];requireCondition(result,'DEPENDENCY_UNAVAILABLE');
      let assetId=result.render_asset_id;
      if(!assetId){const snapshot=await this.snapshot(tx,resultId);if(!snapshot)return null;requireCondition(snapshot.render_digest===this.signature(result),'DEPENDENCY_UNAVAILABLE');assetId=snapshot.render_asset_id;}
      const asset=await this.assets.row(tx,assetId);requireCondition(asset.account_id===accountId&&asset.asset_id===assetId&&asset.media_type==='image/png','DEPENDENCY_UNAVAILABLE');return {assetId,asset};
    },true);
    if(!captured)return null;const bytes=await this.assets.store.read(captured.asset.object_key);requireCondition(sha256(bytes)===captured.asset.sha256&&String(bytes.length)===captured.asset.bytes_length,'DEPENDENCY_UNAVAILABLE');return {bytes,assetId:captured.assetId};
  }
  private snapshot(tx:Transaction,resultId:string):Promise<Snapshot|undefined>{return tx.client.query<Snapshot>('SELECT render_asset_id,render_digest FROM result_render_snapshots WHERE account_id=$1 AND result_id=$2',[tx.account.account_id,resultId]).then(result=>result.rows[0]);}
  private hold(tx:Transaction,resultId:string):Promise<Hold|undefined>{return tx.client.query<Hold>('SELECT render_digest,evidence_digest,protected_layout,protected_overlays FROM result_render_holds WHERE account_id=$1 AND result_id=$2',[tx.account.account_id,resultId]).then(result=>result.rows[0]);}
  private checkHold(hold:Hold,signature?:string):void{requireCondition((!signature||hold.render_digest===signature)&&hold.protected_layout.qa==='HOLD'&&hold.evidence_digest===digest({layout:hold.protected_layout,overlays:hold.protected_overlays}),'DEPENDENCY_UNAVAILABLE');}
  private async held(accountId:string,hold:Hold,signature:string):Promise<DurableRenderHold>{this.checkHold(hold,signature);return new DurableRenderHold({layout:hold.protected_layout,overlays:hold.protected_overlays,availability:await overlayAvailability(this.assets.store,accountId,hold.protected_overlays)});}
  async review(accountId:string,resultId:string):Promise<RenderHoldReview|null>{const hold=await this.db.accountTransaction(accountId,tx=>this.hold(tx,resultId),true);if(!hold)return null;this.checkHold(hold);return {layout:hold.protected_layout,overlays:hold.protected_overlays,availability:await overlayAvailability(this.assets.store,accountId,hold.protected_overlays)};}
  private async render(accountId:string,resultId:string):Promise<{bytes:Buffer;assetId:string}>{
    const result=await this.db.accountTransaction(accountId,async tx=>{const row=(await tx.client.query<ResultRow>('SELECT * FROM results WHERE account_id=$1 AND result_id=$2',[accountId,resultId])).rows[0];requireCondition(row,'DEPENDENCY_UNAVAILABLE');return row;});
    if(result.render_asset_id)return {bytes:await this.assets.bytes(accountId,result.render_asset_id),assetId:result.render_asset_id};
    const signature=this.signature(result);
    const leaseMs=this.hooks.leaseMilliseconds??30000;
    for(let waited=0;waited<600;waited++){
      const claim=await this.db.accountTransaction(accountId,async tx=>{
        const snapshot=await this.snapshot(tx,resultId);if(snapshot)return {kind:'SNAPSHOT' as const,snapshot};
        const hold=await this.hold(tx,resultId);if(hold)return {kind:'HOLD' as const,hold};
        const prior=(await tx.client.query<Claim>('SELECT * FROM result_render_claims WHERE account_id=$1 AND result_id=$2 FOR UPDATE',[accountId,resultId])).rows[0];
        requireCondition(!prior||prior.render_digest===signature,'DEPENDENCY_UNAVAILABLE');
        if(prior&&tx.now<prior.lease_until)return null;
        const context=await contextRow(tx,result.context_id);
        const generation=(BigInt(prior?.generation??'0')+1n).toString();const assetId=randomUUID();
        await tx.client.query(`INSERT INTO result_render_claims(account_id,result_id,render_digest,generation,owner_id,lease_until) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(account_id,result_id) DO UPDATE SET generation=EXCLUDED.generation,owner_id=EXCLUDED.owner_id,lease_until=EXCLUDED.lease_until`,[accountId,resultId,signature,generation,this.owner,new Date(tx.now.valueOf()+leaseMs)]);
        await tx.client.query('INSERT INTO result_render_candidates(account_id,result_id,generation,asset_id,render_digest,created_at) VALUES($1,$2,$3,$4,$5,$6)',[accountId,resultId,generation,assetId,signature,tx.now]);
        const candidates=(await tx.client.query<Candidate>('SELECT asset_id,render_digest FROM result_render_candidates WHERE account_id=$1 AND result_id=$2 AND generation<$3 ORDER BY generation DESC',[accountId,resultId,generation])).rows;
        return {kind:'CLAIM' as const,generation,assetId,candidates,ownerCapture:{contextId:context.context_id,contextGeneration:context.generation,ownerSessionId:context.owner_session_id,ownerTabId:context.owner_tab_id,ownerRevision:context.owner_revision,workspaceRevision:context.workspace_revision}};
      });
      if(!claim){await pause();continue;}
      if(claim.kind==='SNAPSHOT'){requireCondition(claim.snapshot.render_digest===signature,'DEPENDENCY_UNAVAILABLE');return {bytes:await this.assets.bytes(accountId,claim.snapshot.render_asset_id),assetId:claim.snapshot.render_asset_id};}
      if(claim.kind==='HOLD')throw await this.held(accountId,claim.hold,signature);
      let renewal:Promise<void>|null=null;let lost=false;
      const renew=async()=>{try{await this.db.accountTransaction(accountId,async tx=>{const updated=await tx.client.query('UPDATE result_render_claims SET lease_until=$5 WHERE account_id=$1 AND result_id=$2 AND generation=$3 AND owner_id=$4 AND lease_until>$6',[accountId,resultId,claim.generation,this.owner,new Date(tx.now.valueOf()+leaseMs),tx.now]);if(!updated.rowCount)lost=true;});}catch{lost=true;}};
      const timer=setInterval(()=>{if(renewal||lost)return;renewal=renew().finally(()=>{renewal=null;});},this.hooks.heartbeatMilliseconds??10000);
      try{
        let proof:ObjectReceipt|null=null;let bytes:Buffer|null=null;let assetId:string=claim.assetId;
        for(const candidate of claim.candidates){requireCondition(candidate.render_digest===signature,'DEPENDENCY_UNAVAILABLE');try{const receipt=await this.assets.store.receipt(`${accountId}/${candidate.asset_id}`);if(receipt){bytes=await this.assets.store.read(receipt.key);proof=receipt;assetId=candidate.asset_id;break;}}catch{/* An old partial/invalid receipt stays untouched and referenced by its candidate. */}}
        if(!proof){
          try{
            const target:NativeTarget={accountId,targetKind:'RASTER',targetId:resultId,semanticCaptureDigest:signature,protectedOwnerCapture:claim.ownerCapture,claim:{generation:claim.generation,ownerId:this.owner,workItemId:null}};
            const native=this.native?.forTarget(target);const base=await this.assets.bytes(accountId,result.cleaned_asset_id??result.original_asset_id);
            bytes=native?await native.renderPage(base,result.edit_data,this.fonts,this.profile):await (this.hooks.render??renderPage)(base,result.edit_data,this.fonts,this.profile);
          }
          catch(error){
            if(!(error instanceof RenderLayoutHold))throw error;
            const artifacts=error.result.overlays.map(item=>({...item,assetId:randomUUID()}));
            const overlays:ProtectedRenderOverlay[]=artifacts.map(item=>({regionId:item.regionId,bounds:item.bounds,dependency:{assetId:item.assetId,sha256:sha256(item.bytes),bytesLength:String(item.bytes.length),mediaType:'image/png'},storage:'PLANNED'}));
            const layout=error.result.layout,evidenceDigest=digest({layout,overlays});await renew();requireCondition(!lost,'RENDER_PENDING',409,'WAIT');if(this.hooks.beforeHoldPublish)await this.hooks.beforeHoldPublish();
            const published=await this.db.accountTransaction(accountId,async tx=>{
              const snapshot=await this.snapshot(tx,resultId);if(snapshot)return {kind:'SNAPSHOT' as const,snapshot};
              const prior=await this.hold(tx,resultId);if(prior){this.checkHold(prior,signature);const content=(items:ProtectedRenderOverlay[])=>items.map(item=>({regionId:item.regionId,bounds:item.bounds,sha256:item.dependency.sha256,bytesLength:item.dependency.bytesLength,mediaType:item.dependency.mediaType}));requireCondition(digest({layout:prior.protected_layout,overlays:content(prior.protected_overlays)})===digest({layout,overlays:content(overlays)}),'INTENT_CONFLICT');return {kind:'HOLD' as const,hold:prior,inserted:false};}
              const current=(await tx.client.query<Claim>('SELECT * FROM result_render_claims WHERE account_id=$1 AND result_id=$2 FOR UPDATE',[accountId,resultId])).rows[0];
              if(!current||current.owner_id!==this.owner||current.generation!==claim.generation||current.render_digest!==signature||tx.now>=current.lease_until)return null;
              await tx.client.query('INSERT INTO result_render_holds(account_id,result_id,render_digest,evidence_digest,protected_layout,protected_overlays,claim_generation,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[accountId,resultId,signature,evidenceDigest,JSON.stringify(layout),JSON.stringify(overlays),claim.generation,tx.now]);
              return {kind:'HOLD' as const,hold:{render_digest:signature,evidence_digest:evidenceDigest,protected_layout:layout,protected_overlays:overlays},inserted:true};
            });
            if(!published)continue;
            if(published.kind==='SNAPSHOT'){requireCondition(published.snapshot.render_digest===signature,'DEPENDENCY_UNAVAILABLE');return {bytes:await this.assets.bytes(accountId,published.snapshot.render_asset_id),assetId:published.snapshot.render_asset_id};}
            if(published.inserted){if(this.hooks.afterHold)await this.hooks.afterHold();for(const item of artifacts){try{const receipt=await this.assets.store.put(`${accountId}/${item.assetId}`,item.bytes);await this.assets.registerReceipt(accountId,item.assetId,receipt,'LIVE','image/png',result.context_id);}catch{break;}}}
            throw await this.held(accountId,published.hold,signature);
          }
          if(this.hooks.beforePut)await this.hooks.beforePut(assetId);await renew();requireCondition(!lost,'RENDER_PENDING',409,'WAIT');proof=await this.assets.store.put(`${accountId}/${assetId}`,bytes);
        }
        if(this.hooks.afterPut)await this.hooks.afterPut(assetId);
        requireCondition(!lost,'RENDER_PENDING',409,'WAIT');
        const confirmed=await this.db.accountTransaction(accountId,async tx=>{
          const snapshot=await this.snapshot(tx,resultId);if(snapshot)return {kind:'SNAPSHOT' as const,snapshot};
          const hold=await this.hold(tx,resultId);if(hold)return {kind:'HOLD' as const,hold};
          const current=(await tx.client.query<Claim>('SELECT * FROM result_render_claims WHERE account_id=$1 AND result_id=$2 FOR UPDATE',[accountId,resultId])).rows[0];
          if(!current||current.owner_id!==this.owner||current.generation!==claim.generation||current.render_digest!==signature||tx.now>=current.lease_until)return null;
          await this.assets.registerReceiptIn(tx,assetId,proof!,'LIVE','image/png',result.context_id);
          await tx.client.query('INSERT INTO result_render_snapshots(account_id,result_id,render_digest,render_asset_id,created_at) VALUES($1,$2,$3,$4,$5)',[accountId,resultId,signature,assetId,tx.now]);return {kind:'SNAPSHOT' as const,snapshot:{render_digest:signature,render_asset_id:assetId}};
        });
        if(confirmed){if(confirmed.kind==='HOLD')throw await this.held(accountId,confirmed.hold,signature);const snapshot=confirmed.snapshot;requireCondition(snapshot.render_digest===signature,'DEPENDENCY_UNAVAILABLE');return {bytes:snapshot.render_asset_id===assetId?bytes!:await this.assets.bytes(accountId,snapshot.render_asset_id),assetId:snapshot.render_asset_id};}
      }catch(error){if(error instanceof NativeJobError)throw error;await this.db.accountTransaction(accountId,tx=>tx.client.query('UPDATE result_render_claims SET lease_until=$5 WHERE account_id=$1 AND result_id=$2 AND generation=$3 AND owner_id=$4',[accountId,resultId,claim.generation,this.owner,tx.now])).catch(()=>undefined);throw error;}
      finally{clearInterval(timer);if(renewal)await renewal;}
    }
    requireCondition(false,'RENDER_PENDING',409,'WAIT');
  }
}
