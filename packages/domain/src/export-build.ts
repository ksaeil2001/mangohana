import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import type {ObjectReceipt} from '../../storage/src/objects.js';
import type {ProjectManifest} from '../../contracts/src/manifest.generated.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {requireProfile} from '../../media/src/profile.js';
import {assessProject,encodeProject,type ProjectSigner} from '../../media/src/project-file.js';
import {canonicalRendererVersion,renderPage} from '../../media/src/render.js';
import {writeZip} from '../../media/src/zip.js';
import {contextRow,currentSession,owner,type Actor,type ContextRow} from './model.js';
import type {Assets} from './assets.js';
import type {ExportRow} from './files.js';
import {NativeJobError,type NativeGateway,type NativeTarget} from '../../native/src/gateway.js';

type Authorization={sessionId:string;tabId:string;ownerRevision:string;contextGeneration:string;bindingId:string;authGeneration:string};
type BuildRow={capture_digest:string;runtime_fingerprint:string;protected_runtime:RuntimeEvidence;captured_authorization:Authorization;claim_authorization:Authorization;generation:string;owner_id:string|null;lease_until:Date|null;state:'ACCEPTED'|'BUILDING'|'FAILED'|'COMPLETE';completed_at:Date|null;captured_at:Date};
type Candidate={generation:string;asset_id:string;object_key:string;capture_digest:string;runtime_fingerprint:string;sha256:string;bytes_length:string;media_type:string;created_at:Date};
type RuntimeEvidence={contract:string;profile:MediaProfile;storageBucket:string;catalogVersion:string;fonts:unknown[];renderers:unknown[];signingPublicKeySha256:string|null};
type Claim={accountId:string;capture:ExportRow;build:BuildRow;generation:string;authorization:Authorization};
type NativePort=ReturnType<NativeGateway['forTarget']>;
export type ExportBuildHooks={render?:typeof renderPage;afterClaim?:()=>Promise<void>;beforePut?:(candidate:Candidate)=>Promise<void>;afterPut?:(candidate:Candidate)=>Promise<void>;beforePublish?:()=>Promise<void>;leaseMilliseconds?:number;renewalMilliseconds?:number};
// A private fixture can stop a process between durable facts without recording a confirmed failure.
export class ExportBuildInterruption extends Error {}

export class ExportBuildService {
  private readonly ownerId=randomUUID();
  private claimsStopped=false;
  constructor(readonly db:Database,readonly assets:Assets,readonly fonts:FontCatalog,readonly signer:ProjectSigner,readonly profile:MediaProfile,private readonly hooks:ExportBuildHooks={},readonly native?:NativeGateway){requireCondition(profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');}
  stopClaims():void{this.claimsStopped=true;}
  private nativeFor(claim:Claim):NativePort|undefined{
    const row=claim.capture;const target:NativeTarget={accountId:claim.accountId,targetKind:'EXPORT',targetId:row.export_id,semanticCaptureDigest:digest({version:1,kind:row.kind,manifest:row.captured_manifest}),protectedOwnerCapture:{contextId:row.context_id,contextGeneration:row.context_generation,ownerSessionId:claim.authorization.sessionId,ownerTabId:claim.authorization.tabId,ownerRevision:claim.authorization.ownerRevision,workspaceRevision:row.snapshot_revision},claim:{generation:claim.generation,ownerId:this.ownerId,workItemId:null}};
    return this.native?.forTarget(target);
  }
  private runtime(manifest:ProjectManifest,keySha:string|null):RuntimeEvidence {
    return {contract:'export-build-v1',profile:{...this.profile},storageBucket:this.assets.store.bucket,catalogVersion:this.fonts.catalog.version,
      fonts:manifest.fonts.map(item=>{const font=this.fonts.font(item.fontAssetId);return {...font,actualSha256:sha256(this.fonts.bytes.get(font.id)!),actualLicenseSha256:sha256(this.fonts.bytes.get(font.licenseId)!)};}),
      renderers:manifest.pages.map(page=>({pageLineageId:page.pageLineageId,renderer:canonicalRendererVersion({blocks:page.blocks,geometryContract:page.geometryContract,renderContract:page.renderContract,renderSpecification:page.renderSpecification??null,cleanupQa:page.cleanupQa})})),signingPublicKeySha256:keySha};
  }
  async capture(tx:Transaction,context:ContextRow,row:ExportRow):Promise<void> {
    requireCondition(context.owner_session_id&&context.owner_tab_id,'OWNER_REQUIRED');
    const session=await currentSession(tx,{accountId:context.account_id,sessionId:context.owner_session_id,tabId:context.owner_tab_id,ownerCapability:null});
    const authorization:Authorization={sessionId:context.owner_session_id,tabId:context.owner_tab_id,ownerRevision:context.owner_revision,contextGeneration:context.generation,bindingId:session.binding_id,authGeneration:tx.account.auth_generation};
    const key=row.kind==='PROJECT_FILE'?(await tx.client.query<{public_key:Buffer}>('SELECT public_key FROM signing_verifiers WHERE key_id=$1 AND issuer=$2',[row.captured_manifest.keyId,row.captured_manifest.issuer])).rows[0]:null;
    const runtime=this.runtime(row.captured_manifest,key?sha256(key.public_key):null);
    await tx.client.query(`INSERT INTO export_builds(account_id,export_id,capture_digest,runtime_fingerprint,protected_runtime,captured_authorization,claim_authorization,state,captured_at) VALUES($1,$2,$3,$4,$5,$6,$6,'ACCEPTED',$7)`,[context.account_id,row.export_id,digest(row.captured_manifest),digest(runtime),JSON.stringify(runtime),JSON.stringify(authorization),row.captured_at]);
  }
  private async row(tx:Transaction,id:string):Promise<ExportRow> {const row=(await tx.client.query<ExportRow>('SELECT * FROM exports WHERE account_id=$1 AND export_id=$2 FOR UPDATE',[tx.account.account_id,id])).rows[0];requireCondition(row,'INPUT_INVALID',422);return row;}
  private buildRow(tx:Transaction,id:string):Promise<BuildRow|undefined>{return tx.client.query<BuildRow>('SELECT * FROM export_builds WHERE account_id=$1 AND export_id=$2 FOR UPDATE',[tx.account.account_id,id]).then(result=>result.rows[0]);}
  private async authorization(tx:Transaction,row:ExportRow,actor?:Actor,stored?:Authorization):Promise<Authorization>{
    const context=await contextRow(tx,row.context_id);requireCondition(context.lifecycle!=='CLOSED'&&context.generation===row.context_generation&&tx.now<row.retry_deadline,'CAPTURE_EXPIRED',409,'NEW_CAPTURE');
    const identity=actor??{accountId:tx.account.account_id,sessionId:stored!.sessionId,tabId:stored!.tabId,ownerCapability:null};const session=await currentSession(tx,identity);
    if(actor)await owner(tx,actor,{contextId:context.context_id,contextGeneration:context.generation,tabId:actor.tabId,expectedOwnerRevision:context.owner_revision,expectedWorkspaceRevision:context.workspace_revision},context,false);
    const current:Authorization={sessionId:identity.sessionId,tabId:identity.tabId,ownerRevision:context.owner_revision,contextGeneration:context.generation,bindingId:session.binding_id,authGeneration:tx.account.auth_generation};
    requireCondition(context.owner_session_id===current.sessionId&&context.owner_tab_id===current.tabId&&(!stored||digest(current)===digest(stored)),'OWNER_REQUIRED',409,'USE_OWNER_TAB');return current;
  }
  private async claim(accountId:string,id:string,actor?:Actor):Promise<Claim|null>{
    if(this.claimsStopped)return null;
    return this.db.accountTransaction(accountId,async tx=>{
      const capture=await this.row(tx,id);const build=await this.buildRow(tx,id);
      if(actor)await this.authorization(tx,capture,actor);
      if(capture.state==='AVAILABLE')return null;
      requireCondition(build,'CAPTURE_UNCONFIRMED',409,'NEW_CAPTURE');
      requireCondition(build.capture_digest===digest(capture.captured_manifest)&&build.runtime_fingerprint===digest(build.protected_runtime)&&build.captured_at.valueOf()===capture.captured_at.valueOf()&&capture.retry_deadline.valueOf()===build.captured_at.valueOf()+1800000&&capture.captured_manifest.createdAt===build.captured_at.toISOString()&&capture.captured_manifest.exportId===capture.export_id&&capture.captured_manifest.snapshotRevision===capture.snapshot_revision,'CAPTURE_UNCONFIRMED',409,'NEW_CAPTURE');
      if(!actor&&(!['ACCEPTED','BUILDING'].includes(build.state)||capture.state!=='ACCEPTED'))return null;
      requireCondition(capture.safe_error_code!=='RENDER_QA_HOLD','RENDER_QA_HOLD',409,'NEW_CAPTURE');
      let authorization:Authorization;try{authorization=await this.authorization(tx,capture,actor,actor?undefined:build.claim_authorization);}catch(error){if(!actor&&error instanceof DomainError)return null;throw error;}
      if(build.state==='COMPLETE'||(build.state==='BUILDING'&&build.lease_until&&tx.now<build.lease_until))return null;
      const generation=(BigInt(build.generation)+1n).toString();const lease=new Date(tx.now.valueOf()+(this.hooks.leaseMilliseconds??30000));
      if(this.claimsStopped)return null;
      await tx.client.query(`UPDATE export_builds SET claim_authorization=$3,generation=$4,owner_id=$5,lease_until=$6,state='BUILDING',last_error_code=NULL WHERE account_id=$1 AND export_id=$2`,[accountId,id,JSON.stringify(authorization),generation,this.ownerId,lease]);
      await tx.client.query("UPDATE exports SET state='ACCEPTED',safe_error_code=NULL,failed_page_ids='[]' WHERE account_id=$1 AND export_id=$2 AND state<>'AVAILABLE'",[accountId,id]);
      return {accountId,capture,build,generation,authorization};
    });
  }
  private async fence(tx:Transaction,claim:Claim):Promise<BuildRow|null>{
    const capture=await this.row(tx,claim.capture.export_id);const build=await this.buildRow(tx,claim.capture.export_id);
    if(capture.state==='AVAILABLE'||capture.context_id!==claim.capture.context_id||capture.context_generation!==claim.capture.context_generation||capture.kind!==claim.capture.kind||capture.snapshot_revision!==claim.capture.snapshot_revision||capture.captured_at.valueOf()!==claim.capture.captured_at.valueOf()||capture.retry_deadline.valueOf()!==claim.capture.retry_deadline.valueOf()||!build||build.state!=='BUILDING'||build.owner_id!==this.ownerId||build.generation!==claim.generation||!build.lease_until||tx.now>=build.lease_until||build.capture_digest!==digest(capture.captured_manifest)||build.runtime_fingerprint!==claim.build.runtime_fingerprint)return null;
    try{await this.authorization(tx,capture,undefined,claim.authorization);}catch(error){if(error instanceof DomainError)return null;throw error;}return build;
  }
  private renew(claim:Claim):Promise<boolean>{return this.db.accountTransaction(claim.accountId,async tx=>{if(!await this.fence(tx,claim))return false;await tx.client.query('UPDATE export_builds SET lease_until=$3 WHERE account_id=$1 AND export_id=$2',[claim.accountId,claim.capture.export_id,new Date(tx.now.valueOf()+(this.hooks.leaseMilliseconds??30000))]);return true;});}
  private async runtimeCheck(claim:Claim):Promise<void>{
    requireProfile(this.profile);let keySha:string|null=null;
    if(claim.capture.kind==='PROJECT_FILE'){requireCondition(this.signer.issuer===claim.capture.captured_manifest.issuer&&this.signer.keyId===claim.capture.captured_manifest.keyId,'FILE_ACCESS_UNCONFIRMED',409,'WAIT');keySha=sha256((await this.signer.key(claim.capture.captured_manifest.keyId)).public_key);}
    requireCondition(digest(this.runtime(claim.capture.captured_manifest,keySha))===claim.build.runtime_fingerprint,'DEPENDENCY_UNAVAILABLE',409,'WAIT');
  }
  private async output(claim:Claim,onPage:(id:string)=>void,native?:NativePort):Promise<Buffer>{
    const captured=claim.capture.captured_manifest;const bytes=new Map<string,Buffer>();
    for(const asset of captured.assets){const data=await this.assets.bytes(claim.accountId,asset.assetId);requireCondition(sha256(data)===asset.sha256&&String(data.length)===asset.bytesLength,'DEPENDENCY_UNAVAILABLE');bytes.set(asset.assetId,data);}
    if(claim.capture.kind==='PROJECT_FILE')return encodeProject(captured,bytes,this.signer,this.profile,native);
    const entries=new Map<string,Buffer>();const width=Math.max(4,String(captured.pages.length).length);
    for(const [index,page]of captured.pages.entries()){
      onPage(page.pageLineageId);const base=bytes.get(page.cleanedAssetId??page.originalAssetId)!;const data={blocks:page.blocks,geometryContract:page.geometryContract,renderContract:page.renderContract,renderSpecification:page.renderSpecification??null,cleanupQa:page.cleanupQa};
      entries.set(`${String(index+1).padStart(width,'0')}.png`,page.renderAssetId?bytes.get(page.renderAssetId)!:native?await native.renderPage(base,data,this.fonts,this.profile):await (this.hooks.render??renderPage)(base,data,this.fonts,this.profile));
    }
    return native?native.writeZip(entries,this.profile):writeZip(entries,this.profile);
  }
  private timely(claim:Claim,candidate:Candidate,proof:ObjectReceipt,now:Date):boolean{
    const start=Date.parse(proof.completedAt);const precision=proof.completedAtPrecisionMilliseconds;
    if(!Number.isFinite(start)||(precision!==1&&precision!==1000)||(precision===1000&&start%1000!==0))return false;
    // Immutable candidate intent, key and expected bytes establish causality. A coarse storage time
    // may straddle that intent, but cannot be clearly earlier or outside the still-live deadline.
    const earliest=Math.max(candidate.created_at.valueOf(),claim.capture.captured_at.valueOf(),start);
    return start+precision>earliest&&earliest<=now.valueOf()&&earliest<claim.capture.retry_deadline.valueOf();
  }
  private async confirmed(claim:Claim,candidate:Candidate,native?:NativePort):Promise<{proof:ObjectReceipt;bytes:Buffer}|null>{
    if(candidate.capture_digest!==claim.build.capture_digest||candidate.runtime_fingerprint!==claim.build.runtime_fingerprint||candidate.media_type!=='application/zip'||candidate.object_key!==`${claim.accountId}/${candidate.asset_id}`)return null;
    try{
      const proof=await this.assets.store.receipt(candidate.object_key);if(!proof||proof.key!==candidate.object_key||proof.sha256!==candidate.sha256||proof.bytesLength!==candidate.bytes_length||!Number.isFinite(Date.parse(proof.completedAt)))return null;
      const bytes=await this.assets.store.read(candidate.object_key);if(sha256(bytes)!==candidate.sha256||String(bytes.length)!==candidate.bytes_length)return null;
      if(claim.capture.kind==='PROJECT_FILE'){const checked=await assessProject(bytes,claim.accountId,this.signer,this.fonts,this.profile,native);requireCondition(digest(checked.manifest)===claim.build.capture_digest,'FILE_INVALID',422);}
      const timely=await this.db.accountTransaction(claim.accountId,async tx=>!!await this.fence(tx,claim)&&this.timely(claim,candidate,proof,tx.now));if(!timely)return null;
      return {proof,bytes};
    }catch(error){if(error instanceof NativeJobError)throw error;return null;}
  }
  private async publish(claim:Claim,candidate:Candidate,proof:ObjectReceipt):Promise<boolean>{
    return this.db.accountTransaction(claim.accountId,async tx=>{
      if(!await this.fence(tx,claim))return false;
      if(claim.capture.kind==='PROJECT_FILE'){const key=(await tx.client.query<{issuer:string;algorithm:string;state:string;public_key:Buffer}>('SELECT * FROM signing_verifiers WHERE key_id=$1',[claim.capture.captured_manifest.keyId])).rows[0];requireCondition(key&&key.issuer===this.signer.issuer&&key.algorithm==='Ed25519'&&['ISSUING','VERIFY_ONLY'].includes(key.state)&&sha256(key.public_key)===claim.build.protected_runtime.signingPublicKeySha256,'FILE_ACCESS_UNCONFIRMED',409,'WAIT');}
      const completed=new Date(proof.completedAt);requireCondition(this.timely(claim,candidate,proof,tx.now),'STORAGE_UNCONFIRMED');
      await this.assets.registerReceiptIn(tx,candidate.asset_id,proof,'EXPORT',candidate.media_type,claim.capture.context_id);
      await tx.client.query("UPDATE exports SET state='AVAILABLE',output_asset_id=$3,safe_error_code=NULL,failed_page_ids='[]' WHERE account_id=$1 AND export_id=$2 AND state<>'AVAILABLE'",[claim.accountId,claim.capture.export_id,candidate.asset_id]);
      await tx.client.query("UPDATE export_builds SET state='COMPLETE',completed_at=$3,last_error_code=NULL WHERE account_id=$1 AND export_id=$2",[claim.accountId,claim.capture.export_id,completed]);return true;
    });
  }
  private fail(claim:Claim,code:string,failedPage:string|null):Promise<void>{return this.db.accountTransaction(claim.accountId,async tx=>{if(!await this.fence(tx,claim))return;await tx.client.query("UPDATE exports SET state='FAILED',safe_error_code=$3,failed_page_ids=$4 WHERE account_id=$1 AND export_id=$2 AND state<>'AVAILABLE'",[claim.accountId,claim.capture.export_id,code,JSON.stringify(failedPage?[failedPage]:claim.capture.captured_manifest.pages.map(page=>page.pageLineageId))]);await tx.client.query("UPDATE export_builds SET state='FAILED',last_error_code=$3 WHERE account_id=$1 AND export_id=$2",[claim.accountId,claim.capture.export_id,code]);});}
  private async execute(claim:Claim):Promise<void>{
    let lost=false;let renewal:Promise<void>|null=null;let phase:'BUILD'|'PUT'|'PUBLISH'='BUILD';let failedPage:string|null=null;
    const renew=async()=>{try{if(!await this.renew(claim))lost=true;}catch{lost=true;}};
    const timer=setInterval(()=>{if(lost||renewal)return;renewal=renew().finally(()=>{renewal=null;});},this.hooks.renewalMilliseconds??10000);
    try{
      if(this.hooks.afterClaim)await this.hooks.afterClaim();await this.runtimeCheck(claim);
      const native=this.nativeFor(claim);
      const candidates=await this.db.accountTransaction(claim.accountId,async tx=>(await tx.client.query<Candidate>('SELECT * FROM export_build_candidates WHERE account_id=$1 AND export_id=$2 ORDER BY generation DESC',[claim.accountId,claim.capture.export_id])).rows);
      let candidate:Candidate|undefined;let confirmation:{proof:ObjectReceipt;bytes:Buffer}|null=null;
      for(const prior of candidates){confirmation=await this.confirmed(claim,prior,native);if(confirmation){candidate=prior;break;}}
      if(!confirmation){
        const bytes=await this.output(claim,id=>{failedPage=id;},native);await renew();if(lost)return;
        candidate={generation:claim.generation,asset_id:randomUUID(),object_key:'',capture_digest:claim.build.capture_digest,runtime_fingerprint:claim.build.runtime_fingerprint,sha256:sha256(bytes),bytes_length:String(bytes.length),media_type:'application/zip',created_at:claim.capture.captured_at};candidate.object_key=`${claim.accountId}/${candidate.asset_id}`;
        const planned=await this.db.accountTransaction(claim.accountId,async tx=>{if(!await this.fence(tx,claim))return false;candidate!.created_at=tx.now;await tx.client.query('INSERT INTO export_build_candidates(account_id,export_id,generation,asset_id,object_key,capture_digest,runtime_fingerprint,sha256,bytes_length,media_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[claim.accountId,claim.capture.export_id,candidate!.generation,candidate!.asset_id,candidate!.object_key,candidate!.capture_digest,candidate!.runtime_fingerprint,candidate!.sha256,candidate!.bytes_length,candidate!.media_type,candidate!.created_at]);return true;});if(!planned)return;
        if(this.hooks.beforePut)await this.hooks.beforePut(candidate);await renew();if(lost)return;phase='PUT';await this.assets.store.put(candidate.object_key,bytes);if(this.hooks.afterPut)await this.hooks.afterPut(candidate);
        confirmation=await this.confirmed(claim,candidate,native);requireCondition(confirmation,'STORAGE_UNCONFIRMED',409,'WAIT');
      }
      await renew();if(lost)return;phase='PUBLISH';await this.runtimeCheck(claim);if(this.hooks.beforePublish)await this.hooks.beforePublish();await this.publish(claim,candidate!,confirmation.proof);
    }catch(error){
      if(error instanceof NativeJobError){
        await this.db.accountTransaction(claim.accountId,async tx=>{if(!await this.fence(tx,claim))return;await tx.client.query("UPDATE exports SET safe_error_code='EXECUTION_UNKNOWN' WHERE account_id=$1 AND export_id=$2 AND state='ACCEPTED'",[claim.accountId,claim.capture.export_id]);await tx.client.query("UPDATE export_builds SET last_error_code='EXECUTION_UNKNOWN' WHERE account_id=$1 AND export_id=$2 AND state='BUILDING'",[claim.accountId,claim.capture.export_id]);}).catch(()=>undefined);
        throw error;
      }
      if(error instanceof ExportBuildInterruption)throw error;
      // An interrupted/ambiguous PUT remains unfinished. It is never retried with the same key.
      if(lost||phase==='PUT'||(error instanceof DomainError&&error.code==='STORAGE_UNCONFIRMED'))return;
      const code=error instanceof DomainError?error.code:claim.capture.kind==='FINAL_ZIP'?'RENDER_FAILED':'FILE_INVALID';await this.fail(claim,code,failedPage);
    }finally{clearInterval(timer);if(renewal)await renewal;}
  }
  async build(actor:Actor,id:string):Promise<void>{const claim=await this.claim(actor.accountId,id,actor);if(claim)await this.execute(claim);}
  async runOnce():Promise<void>{if(this.claimsStopped)return;const rows=await this.db.transaction(async client=>(await client.query<{account_id:string;export_id:string}>('SELECT * FROM manga_web.export_build_scan($1)',[await this.db.time(client)])).rows);for(const row of rows){if(this.claimsStopped)return;const claim=await this.claim(row.account_id,row.export_id);if(claim)await this.execute(claim);}}
}
