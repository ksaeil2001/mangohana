import { randomBytes,randomUUID } from 'node:crypto';
import type { Database,Transaction } from '../../storage/src/database.js';
import type { CommandReply,ImportProjectFile,PrepareUpload,UploadView } from '../../contracts/src/wire.generated.js';
import type { ProjectManifest } from '../../contracts/src/manifest.generated.js';
import { assertWire } from '../../contracts/src/validation.js';
import { requireCondition } from '../../contracts/src/errors.js';
import { digest,sha256 } from '../../contracts/src/intent.js';
import { naturalSort } from '../../contracts/src/natural-sort.js';
import { type Actor,type ContextRow,type PageRow,type ResultRow,bumpWorkspace,compositionIdle,contextRow,currentSession,owner,reply,settingsRow } from './model.js';
import { type CommandExtension,WorkspaceService } from './workspace.js';
import type { MediaProfile } from '../../media/src/profile.js';
import { requireProfile } from '../../media/src/profile.js';
import { decodeImage } from '../../media/src/images.js';
import { type FontCatalog } from '../../media/src/fonts.js';
import { assessProject,type ProjectSigner } from '../../media/src/project-file.js';
import { Assets } from './assets.js';
import { sweepAccount } from './liveness.js';
import {costProjection} from './cost-baseline.js';
import {ExportBuildService} from './export-build.js';
import {NativeJobError,type NativeGateway,type NativeTarget} from '../../native/src/gateway.js';

type Upload={upload_id:string;context_id:string|null;purpose:string;preview_revision:string;state:string;expires_at:Date;owner_revision:string|null;context_generation:string|null;owner_session_id:string;owner_tab_id:string;captured_workspace_revision:string|null};
type Candidate={candidate_id:string;asset_id:string|null;input_ordinal:number;decode_state:string;reason_code:string;duplicate_asset_id:string|null;display_name:string;width:number|null;height:number|null;sha256:string|null;bytes_length:string|null;media_type:string|null};
export type ExportRow={export_id:string;context_id:string;context_generation:string;kind:'PROJECT_FILE'|'FINAL_ZIP';snapshot_revision:string;captured_at:Date;retry_deadline:Date;state:string;captured_manifest:ProjectManifest;output_asset_id:string|null;safe_error_code:string|null;failed_page_ids:string[];delivered_at:Date|null};
export class FileService {
  readonly builds:ExportBuildService;
  constructor(readonly db:Database,readonly workspace:WorkspaceService,readonly assets:Assets,readonly fonts:FontCatalog,readonly signer:ProjectSigner,readonly profile:MediaProfile,readonly native?:NativeGateway) {requireCondition(profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');workspace.extensions.push(this.commands);this.builds=new ExportBuildService(db,assets,fonts,signer,profile,{},native);}
  private uploadNative(actor:Actor,upload:Upload,targetKind:'UPLOAD'|'RESTORE',capture:unknown){
    const target:NativeTarget={accountId:actor.accountId,targetKind,targetId:upload.upload_id,semanticCaptureDigest:digest(capture),protectedOwnerCapture:{contextId:upload.context_id,contextGeneration:upload.context_generation,ownerSessionId:upload.owner_session_id,ownerTabId:upload.owner_tab_id,ownerRevision:upload.owner_revision,workspaceRevision:upload.captured_workspace_revision},claim:{generation:upload.preview_revision,ownerId:upload.owner_session_id,workItemId:null}};
    return this.native?.forTarget(target);
  }
  async prepare(actor:Actor,input:unknown):Promise<CommandReply> {
    assertWire<PrepareUpload>('prepareUpload',input);requireProfile(this.profile);await sweepAccount(this.db,actor.accountId);
    return this.db.accountTransaction(actor.accountId,async(tx)=>{
      await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return prior;let context:ContextRow|null=null;
      if(input.purpose==='PAGE_IMAGES'){requireCondition(input.target,'INPUT_INVALID',422);context=await contextRow(tx,input.target.contextId);await owner(tx,actor,input.target,context);await compositionIdle(tx,context);requireCondition(context.lifecycle==='OPEN','CONTEXT_CLOSED');}
      else requireCondition(input.target===null&&!(await tx.client.query('SELECT 1 FROM account_live_context_slots WHERE account_id=$1',[actor.accountId])).rowCount,'SLOT_OCCUPIED');
      const id=randomUUID();await tx.client.query(`INSERT INTO uploads(account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,owner_revision,context_generation,owner_session_id,owner_tab_id,prepare_command_id,captured_workspace_revision)
        VALUES($1,$2,$3,$4,0,'PREPARED',$5,$6,$7,$8,$9,$10,$11,$12)`,[actor.accountId,id,context?.context_id??null,input.purpose,tx.now,new Date(tx.now.valueOf()+3600000),context?.owner_revision??null,context?.generation??null,actor.sessionId,actor.tabId,input.commandId,context?.workspace_revision??null]);
      const response=reply(input.commandId,tx,context,{kind:'UPLOAD',id},true);await this.workspace.record(tx,input,response,'PREPARE_UPLOAD',context?.context_id??null);return response;
    });
  }
  async upload(tx:Transaction,actor:Actor,id:string,mutable=true):Promise<Upload> {
    await currentSession(tx,actor);const row=(await tx.client.query<Upload>('SELECT * FROM uploads WHERE account_id=$1 AND upload_id=$2 FOR UPDATE',[actor.accountId,id])).rows[0];
    requireCondition(row&&tx.now<row.expires_at,'CAPTURE_EXPIRED');requireCondition(row.owner_session_id===actor.sessionId&&row.owner_tab_id===actor.tabId,'OWNER_REQUIRED');
    if(mutable)requireCondition(row.state!=='COMMITTED','REVISION_CONFLICT');
    if(row.context_id){const context=await contextRow(tx,row.context_id);await owner(tx,actor,{contextId:context.context_id,contextGeneration:row.context_generation!,tabId:actor.tabId,expectedOwnerRevision:row.owner_revision!,expectedWorkspaceRevision:context.workspace_revision},context);}
    return row;
  }
  async receive(actor:Actor,uploadId:string,candidateId:string,name:string,bytes:Buffer):Promise<UploadView> {
    requireProfile(this.profile);requireCondition(name.length<=256&&!/[\x00-\x1f]/.test(name)&&/^[0-9a-f-]{36}$/.test(candidateId),'INPUT_INVALID',422);
    const prepared=await this.db.accountTransaction(actor.accountId,async(tx)=>{const upload=await this.upload(tx,actor,uploadId);if(upload.context_id)await compositionIdle(tx,await contextRow(tx,upload.context_id));return upload;});
    requireCondition(bytes.length<= (prepared.purpose==='PAGE_IMAGES'?this.profile.maxImageBytes:this.profile.maxZipBytes),'INPUT_INVALID',413);
    const previous=await this.db.accountTransaction(actor.accountId,async(tx)=>(await tx.client.query<Candidate>(`SELECT c.*,a.sha256,a.bytes_length FROM upload_candidates c LEFT JOIN assets a USING(account_id,asset_id) WHERE c.account_id=$1 AND c.candidate_id=$2 AND c.upload_id=$3`,[actor.accountId,candidateId,uploadId])).rows[0]);
    if(previous){requireCondition(previous.sha256===sha256(bytes)&&previous.bytes_length===bytes.length.toString()&&previous.display_name===name,'INTENT_CONFLICT');return this.preview(actor,uploadId);}
    let state='VALID';let width:number|null=null;let height:number|null=null;let mediaType='application/zip';let nativeFailure:NativeJobError|null=null;
    if(prepared.purpose==='PAGE_IMAGES'){try{const native=this.uploadNative(actor,prepared,'UPLOAD',{version:1,purpose:prepared.purpose,candidateId,name,sha256:sha256(bytes),bytesLength:String(bytes.length)});const decoded=native?await native.decodeImage(bytes,this.profile):await decodeImage(bytes,this.profile);width=decoded.width;height=decoded.height;mediaType=decoded.mediaType;}catch(error){if(error instanceof NativeJobError){nativeFailure=error;state='UNCONFIRMED';}else state='INVALID';mediaType='application/octet-stream';}}
    try{
    const asset=await this.assets.put(actor.accountId,candidateId,bytes,'UPLOAD_TEMP',mediaType,prepared.context_id);
    await this.db.accountTransaction(actor.accountId,async(tx)=>{
      const upload=await this.upload(tx,actor,uploadId);if(upload.context_id)await compositionIdle(tx,await contextRow(tx,upload.context_id));
      const count=Number((await tx.client.query<{count:string}>('SELECT count(*) AS count FROM upload_candidates WHERE account_id=$1 AND upload_id=$2',[actor.accountId,uploadId])).rows[0].count);requireCondition(count<this.profile.maxFilesPerUpload,'BATCH_CAPACITY_EXCEEDED',422);
      const duplicate=(await tx.client.query<{asset_id:string}>(`SELECT a.asset_id FROM assets a WHERE a.account_id=$1 AND a.asset_id<>$2 AND a.sha256=$3 AND a.bytes_length=$4 AND (EXISTS(SELECT 1 FROM workspace_pages p JOIN results r ON r.account_id=p.account_id AND r.result_id=p.current_result_id WHERE p.account_id=a.account_id AND p.context_id=$5 AND NOT p.excluded AND r.original_asset_id=a.asset_id) OR EXISTS(SELECT 1 FROM upload_candidates c WHERE c.account_id=a.account_id AND c.upload_id=$6 AND c.asset_id=a.asset_id AND c.decode_state='VALID')) ORDER BY a.asset_id LIMIT 1`,[actor.accountId,asset.asset_id,asset.sha256,asset.bytes_length,upload.context_id,uploadId])).rows[0];
      await tx.client.query(`INSERT INTO upload_candidates(account_id,candidate_id,upload_id,asset_id,protected_display_name_ref,input_ordinal,decode_state,reason_code,duplicate_asset_id,display_name,width,height)
        VALUES($1,$2,$3,$2,$2::uuid::text,$4,$5,$6,$7,$8,$9,$10)`,[actor.accountId,candidateId,uploadId,count,state,state==='VALID'?'NONE':nativeFailure?'EXECUTION_UNKNOWN':'INPUT_INVALID',duplicate?.asset_id??null,name,width,height]);
      await tx.client.query('UPDATE uploads SET preview_revision=preview_revision+1,state=\'READY\' WHERE account_id=$1 AND upload_id=$2',[actor.accountId,uploadId]);
    });}catch(error){if(nativeFailure)throw nativeFailure;throw error;}if(nativeFailure)throw nativeFailure;return this.preview(actor,uploadId);
  }
  async preview(actor:Actor,id:string):Promise<UploadView> {
    return this.db.accountTransaction(actor.accountId,async(tx)=>{
      const upload=await this.upload(tx,actor,id,false);const candidates=(await tx.client.query<Candidate>('SELECT c.*,a.sha256,a.bytes_length,a.media_type FROM upload_candidates c LEFT JOIN assets a USING(account_id,asset_id) WHERE c.account_id=$1 AND c.upload_id=$2 ORDER BY c.input_ordinal',[actor.accountId,id])).rows;
      const valid=candidates.filter(c=>c.decode_state==='VALID');const ordered=naturalSort(valid.map(c=>({...c,displayName:c.display_name,inputOrdinal:c.input_ordinal})));
      const views:UploadView['candidates']=[];for(const c of candidates){const duplicatePages=(await tx.client.query<{page_lineage_id:string}>(`SELECT p.page_lineage_id FROM workspace_pages p JOIN results r ON r.account_id=p.account_id AND r.result_id=p.current_result_id JOIN assets a ON a.account_id=r.account_id AND a.asset_id=r.original_asset_id WHERE p.account_id=$1 AND p.context_id=$2 AND NOT p.excluded AND a.sha256=$3 AND a.bytes_length=$4`,[actor.accountId,upload.context_id,c.sha256,c.bytes_length])).rows.map(p=>p.page_lineage_id);
        const duplicateCandidates=candidates.filter(other=>other.input_ordinal<c.input_ordinal&&other.sha256===c.sha256&&other.bytes_length===c.bytes_length&&other.decode_state==='VALID').map(other=>other.candidate_id);
        views.push({candidateId:c.candidate_id,inputOrdinal:c.input_ordinal,displayName:c.display_name,assetId:c.asset_id,decodeState:c.decode_state as 'VALID'|'INVALID'|'UNCONFIRMED',reasonCode:c.decode_state==='VALID'?'NONE':c.reason_code==='EXECUTION_UNKNOWN'?'EXECUTION_UNKNOWN':'INPUT_INVALID',widthPx:c.width,heightPx:c.height,bytesLength:c.bytes_length,duplicateOfPageIds:duplicatePages,duplicateOfCandidateIds:duplicateCandidates});}
      return {uploadId:id,previewRevision:upload.preview_revision,candidateIdsInOrder:ordered.map(c=>c.candidate_id),duplicateCandidateIds:valid.filter(c=>c.duplicate_asset_id).map(c=>c.candidate_id),failures:candidates.filter(c=>c.decode_state!=='VALID').map(c=>({candidateId:c.candidate_id,reasonCode:c.reason_code==='EXECUTION_UNKNOWN'?'EXECUTION_UNKNOWN':'INPUT_INVALID'})),expiresAt:upload.expires_at.toISOString(),serverTime:tx.now.toISOString(),candidates:views};
    });
  }
  readonly commands:CommandExtension=async(tx,_actor,context,command)=>{
    const op=command.operation;
    if(op.kind==='COMMIT_UPLOAD') {
      await compositionIdle(tx,context);requireCondition(context.lifecycle==='OPEN','CONTEXT_CLOSED');const upload=await this.upload(tx,_actor,op.payload.uploadId);
      requireCondition(upload.context_id===context.context_id&&upload.preview_revision===op.payload.previewRevision&&upload.captured_workspace_revision===context.workspace_revision,'REVISION_CONFLICT');
      const ids=op.payload.candidateIdsInOrder;requireCondition(ids.length===new Set(ids).size&&op.payload.explicitDuplicateIds.length===new Set(op.payload.explicitDuplicateIds).size&&op.payload.explicitDuplicateIds.every(id=>ids.includes(id)),'INPUT_INVALID',422);
      const all=(await tx.client.query<Candidate>('SELECT c.*,a.sha256,a.bytes_length FROM upload_candidates c JOIN assets a USING(account_id,asset_id) WHERE c.account_id=$1 AND c.upload_id=$2',[context.account_id,upload.upload_id])).rows;
      const selected=ids.map(id=>all.find(c=>c.candidate_id===id));requireCondition(selected.every(c=>c?.decode_state==='VALID'),'INPUT_INVALID',422);
      for(const candidate of selected){if(candidate!.duplicate_asset_id)requireCondition(op.payload.explicitDuplicateIds.includes(candidate!.candidate_id),'DUPLICATE_CHOICE_REQUIRED',409,'RESELECT_UPLOAD');}
      const usage=(await tx.client.query<{count:string;bytes:string}>(`SELECT count(*) AS count,COALESCE(sum(a.bytes_length),0)::text AS bytes FROM workspace_pages p JOIN results r ON r.account_id=p.account_id AND r.result_id=p.current_result_id JOIN assets a ON a.account_id=r.account_id AND a.asset_id=r.original_asset_id WHERE p.account_id=$1 AND p.context_id=$2 AND NOT p.excluded`,[context.account_id,context.context_id])).rows[0];
      requireCondition(Number(usage.count)+selected.length<=this.profile.maxProjectPages&&BigInt(usage.bytes)+selected.reduce((n,c)=>n+BigInt(c!.bytes_length!),0n)<=BigInt(this.profile.maxProjectSourceBytes),'BATCH_CAPACITY_EXCEEDED',422,'RESELECT_UPLOAD');
      let order=Number((await tx.client.query<{order:number}>('SELECT COALESCE(max(display_order)+1,0) AS "order" FROM workspace_pages WHERE account_id=$1 AND context_id=$2',[context.account_id,context.context_id])).rows[0].order);
      for(const c of selected){const candidate=c!;const pageId=randomUUID();const resultId=randomUUID();await tx.client.query('INSERT INTO page_lineages(account_id,project_lineage_id,page_lineage_id) VALUES($1,$2,$3)',[context.account_id,context.project_lineage_id,pageId]);
        await tx.client.query(`INSERT INTO workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,revision,paid_baseline_credit,baseline_contribution_refs,image_width,image_height,display_name)
          VALUES($1,$2,$3,$4,$5,false,false,0,0,0,'[]',$6,$7,$8)`,[context.account_id,context.context_id,context.project_lineage_id,pageId,order++,candidate.width,candidate.height,candidate.display_name]);
        await tx.client.query(`INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,0,$5,$2::uuid::text,'UPLOAD',$6)`,[context.account_id,resultId,context.context_id,pageId,candidate.asset_id,JSON.stringify({blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'})]);
        await tx.client.query('UPDATE workspace_pages SET current_result_id=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[context.account_id,context.context_id,pageId,resultId]);await tx.client.query("UPDATE assets SET purpose='LIVE' WHERE account_id=$1 AND asset_id=$2",[context.account_id,candidate.asset_id]);
      }
      await tx.client.query("UPDATE uploads SET state='COMMITTED' WHERE account_id=$1 AND upload_id=$2",[context.account_id,upload.upload_id]);await bumpWorkspace(tx,context);return reply(command.commandId,tx,context,{kind:'UPLOAD',id:upload.upload_id});
    }
    if(op.kind==='CAPTURE_ZIP'){const id=await this.capture(tx,context,'FINAL_ZIP');return reply(command.commandId,tx,context,{kind:'EXPORT',id},true);}
    if(op.kind==='RETRY_ZIP'){const row=await this.exportRow(tx,op.payload.exportId);requireCondition(row.context_id===context.context_id&&row.kind==='FINAL_ZIP'&&tx.now<row.retry_deadline,'CAPTURE_EXPIRED');requireCondition(row.safe_error_code!=='RENDER_QA_HOLD','RENDER_QA_HOLD',409,'NEW_CAPTURE');return reply(command.commandId,tx,context,{kind:'EXPORT',id:row.export_id},true);}
    return null;
  };
  async capture(tx:Transaction,context:ContextRow,kind:'PROJECT_FILE'|'FINAL_ZIP'):Promise<string> {
    const exportId=randomUUID();const pages=(await tx.client.query<PageRow&ResultRow>('SELECT p.*,r.original_asset_id,r.cleaned_asset_id,COALESCE(r.render_asset_id,s.render_asset_id) AS render_asset_id,r.edit_data FROM workspace_pages p JOIN results r ON r.account_id=p.account_id AND r.result_id=p.current_result_id LEFT JOIN result_render_snapshots s ON s.account_id=r.account_id AND s.result_id=r.result_id WHERE p.account_id=$1 AND p.context_id=$2 AND NOT p.excluded ORDER BY p.display_order',[context.account_id,context.context_id])).rows;
    const settings=context.current_settings_revision===null?null:await settingsRow(tx,context);const fontIds=new Set<string>(settings?[settings.fontAssetId]:[]);for(const page of pages)for(const block of page.edit_data.blocks)fontIds.add(block.fontAssetId);
    const assets:ProjectManifest['assets']=[];const seen=new Set<string>();const add=async(id:string,purpose:ProjectManifest['assets'][number]['purpose'])=>{if(seen.has(id))return;seen.add(id);const asset=await this.assets.row(tx,id);assets.push({assetId:id,entry:purpose==='LICENSE'?`licenses/${id}.txt`:`${purpose==='FONT'?'fonts':'assets'}/${id}.bin`,purpose,mediaType:asset.media_type as ProjectManifest['assets'][number]['mediaType'],bytesLength:asset.bytes_length,sha256:asset.sha256,requiredFor:'EDIT'});};
    for(const page of pages){await add(page.original_asset_id,'ORIGINAL');if(page.cleaned_asset_id)await add(page.cleaned_asset_id,'CLEANED');if(page.render_asset_id)await add(page.render_asset_id,'RENDER');}
    const fonts:ProjectManifest['fonts']=[];for(const id of fontIds){const font=this.fonts.font(id);await add(id,'FONT');await add(font.licenseId,'LICENSE');fonts.push({fontAssetId:id,family:font.family,fontVersion:font.version,fontCatalogVersion:font.catalogVersion,licenseAssetId:font.licenseId});}
    const unsettledReferences:ProjectManifest['unsettledReferences']=[];const manifestPages:ProjectManifest['pages']=[];
    for(const page of pages){const cost=await costProjection(tx,context,page);unsettledReferences.push(...cost.unsettled);
      manifestPages.push({pageLineageId:page.page_lineage_id,originalAssetId:page.original_asset_id,widthPx:page.image_width,heightPx:page.image_height,skip:page.skip,resultRevision:page.result_revision,cleanedAssetId:page.cleaned_asset_id,renderAssetId:page.render_asset_id,blocks:page.edit_data.blocks,paidCumulativeBaselineCredit:cost.credit,paidCumulativeBaselineState:cost.confirmed?'CONFIRMED':'UNCONFIRMED',baselineContributionIds:cost.contributions,geometryContract:page.edit_data.geometryContract,renderContract:page.edit_data.renderContract,renderSpecification:page.edit_data.renderSpecification??null,cleanupQa:page.edit_data.cleanupQa,displayName:page.display_name});
    }
    const manifest:ProjectManifest={format:'trio.manga-project',schemaVersion:1,issuer:this.signer.issuer,keyId:this.signer.keyId,algorithm:'Ed25519',exportId,createdAt:tx.now.toISOString(),creatorAccountId:context.account_id,projectLineageId:context.project_lineage_id,snapshotRevision:context.workspace_revision,projectStatus:context.project_status,settings,pages:manifestPages,assets,unsettledReferences,optionalCheckpoints:[],fonts};
    await tx.client.query(`INSERT INTO exports(account_id,export_id,context_id,context_generation,kind,snapshot_revision,protected_manifest_ref,captured_at,retry_deadline,state,captured_manifest,captured_asset_ids) VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text,$7,$8,'ACCEPTED',$9,$10)`,[context.account_id,exportId,context.context_id,context.generation,kind,context.workspace_revision,tx.now,new Date(tx.now.valueOf()+1800000),JSON.stringify(manifest),JSON.stringify([...seen])]);
    await this.builds.capture(tx,context,await this.exportRow(tx,exportId));return exportId;
  }
  async registerFonts(accountId:string,fontIds=this.fonts.catalog.fonts.map(f=>f.id)):Promise<void> {for(const id of fontIds){const font=this.fonts.font(id);await this.assets.put(accountId,font.id,this.fonts.bytes.get(font.id)!,'FONT','font/otf');}const license=this.fonts.catalog.license;await this.assets.put(accountId,license.id,this.fonts.bytes.get(license.id)!,'FONT','text/plain');}
  async exportRow(tx:Transaction,id:string):Promise<ExportRow> {const row=(await tx.client.query<ExportRow>('SELECT * FROM exports WHERE account_id=$1 AND export_id=$2 FOR UPDATE',[tx.account.account_id,id])).rows[0];requireCondition(row,'INPUT_INVALID',422);return row;}
  async build(actor:Actor,id:string):Promise<void> {await this.builds.build(actor,id);}
  stopClaims():void{this.builds.stopClaims();}
  async download(actor:Actor,id:string):Promise<{bytes:Buffer;name:string;sha256:string}> {
    const captured=await this.db.accountTransaction(actor.accountId,async(tx)=>{
      await currentSession(tx,actor);const row=await this.exportRow(tx,id);const context=await contextRow(tx,row.context_id);requireCondition(context.lifecycle!=='CLOSED'&&row.state==='AVAILABLE'&&row.output_asset_id&&tx.now<row.retry_deadline,'CAPTURE_EXPIRED');
      let target:NativeTarget|undefined;
      if(this.native&&row.kind==='PROJECT_FILE'){
        const build=(await tx.client.query<{state:string;generation:string;owner_id:string|null;completed_at:Date|null;claim_authorization:{sessionId:string;tabId:string;ownerRevision:string}}>('SELECT state,generation,owner_id,completed_at,claim_authorization FROM export_builds WHERE account_id=$1 AND export_id=$2',[actor.accountId,id])).rows[0];
        requireCondition(build?.state==='COMPLETE'&&build.owner_id&&build.completed_at,'CAPTURE_UNCONFIRMED',409,'WAIT');
        target={accountId:actor.accountId,targetKind:'EXPORT',targetId:row.export_id,semanticCaptureDigest:digest({version:1,kind:row.kind,manifest:row.captured_manifest}),protectedOwnerCapture:{contextId:row.context_id,contextGeneration:row.context_generation,ownerSessionId:build.claim_authorization.sessionId,ownerTabId:build.claim_authorization.tabId,ownerRevision:build.claim_authorization.ownerRevision,workspaceRevision:row.snapshot_revision},claim:{generation:build.generation,ownerId:build.owner_id,workItemId:null}};
      }
      return {row,target};
    });const row=captured.row;
    const bytes=await this.assets.bytes(actor.accountId,row.output_asset_id!);const expected=await this.db.accountTransaction(actor.accountId,tx=>this.assets.row(tx,row.output_asset_id!));requireCondition(sha256(bytes)===expected.sha256&&String(bytes.length)===expected.bytes_length&&expected.media_type==='application/zip','FILE_INVALID',422);if(row.kind==='PROJECT_FILE'){const native=captured.target?this.native!.forTarget(captured.target):undefined;const checked=await assessProject(bytes,actor.accountId,this.signer,this.fonts,this.profile,native);requireCondition(digest(checked.manifest)===digest(row.captured_manifest),'FILE_INVALID',422);}await this.checkDownload(actor,id);
    return {bytes,name:row.kind==='PROJECT_FILE'?'project.manga-project.zip':'translated-pages.zip',sha256:sha256(bytes)};
  }
  async checkDownload(actor:Actor,id:string):Promise<void> {await this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const row=await this.exportRow(tx,id);const context=await contextRow(tx,row.context_id);requireCondition(context.lifecycle!=='CLOSED'&&context.generation===row.context_generation&&row.state==='AVAILABLE'&&tx.now<row.retry_deadline,'CAPTURE_EXPIRED');});}
  async completeDownload(actor:Actor,id:string,deliveredSha256:string):Promise<void> {await this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const row=await this.exportRow(tx,id);const context=await contextRow(tx,row.context_id);requireCondition(context.lifecycle!=='CLOSED'&&context.generation===row.context_generation&&row.state==='AVAILABLE'&&tx.now<row.retry_deadline,'CAPTURE_EXPIRED');const asset=await this.assets.row(tx,row.output_asset_id!);requireCondition(asset.sha256===deliveredSha256,'SNAPSHOT_STALE');await tx.client.query('UPDATE exports SET delivered_at=COALESCE(delivered_at,$3) WHERE account_id=$1 AND export_id=$2',[actor.accountId,id,tx.now]);});}
  async restore(actor:Actor,input:unknown):Promise<{reply:CommandReply;ownerCapability?:string;checkpointReuseAvailable?:boolean}> {
    assertWire<ImportProjectFile>('importProjectFile',input);await sweepAccount(this.db,actor.accountId);
    const early=await this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);return this.workspace.existing(tx,input);});if(early)return this.db.accountTransaction(actor.accountId,tx=>this.workspace.recoverOwnerChannel(tx,actor,early));
    const captured=await this.db.accountTransaction(actor.accountId,async(tx)=>{const upload=await this.upload(tx,actor,input.uploadId);requireCondition(upload.purpose==='PROJECT_IMPORT'&&actor.tabId===input.tabId,'INPUT_INVALID',422);const rows=(await tx.client.query<Candidate>('SELECT * FROM upload_candidates WHERE account_id=$1 AND upload_id=$2',[actor.accountId,input.uploadId])).rows;requireCondition(rows.length===1&&rows[0].asset_id,'FILE_INVALID',422);return {candidate:rows[0],upload};});const candidate=captured.candidate;
    const original=await this.assets.bytes(actor.accountId,candidate.asset_id!);const native=this.uploadNative(actor,captured.upload,'RESTORE',{version:1,purpose:captured.upload.purpose,candidateId:candidate.candidate_id,assetId:candidate.asset_id,sha256:sha256(original),bytesLength:String(original.length)});
    const assessment=await assessProject(original,actor.accountId,this.signer,this.fonts,this.profile,native);const m=assessment.manifest;
    for(const asset of m.assets)if(asset.requiredFor==='EDIT')await this.assets.put(actor.accountId,asset.assetId,assessment.assets.get(asset.assetId)!,'LIVE',asset.mediaType);
    return this.db.accountTransaction(actor.accountId,async(tx)=>{
      await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return this.workspace.recoverOwnerChannel(tx,actor,prior);
      const upload=await this.upload(tx,actor,input.uploadId);requireCondition(upload.purpose==='PROJECT_IMPORT'&&actor.tabId===input.tabId,'INPUT_INVALID',422);const currentCandidates=(await tx.client.query<Candidate>('SELECT * FROM upload_candidates WHERE account_id=$1 AND upload_id=$2 FOR UPDATE',[actor.accountId,input.uploadId])).rows;requireCondition(currentCandidates.length===1&&currentCandidates[0].candidate_id===candidate.candidate_id&&currentCandidates[0].asset_id===candidate.asset_id,'REVISION_CONFLICT');
      requireCondition(!(await tx.client.query('SELECT 1 FROM account_live_context_slots WHERE account_id=$1',[actor.accountId])).rowCount,'SLOT_OCCUPIED');
      const verifier=(await tx.client.query<{state:string;issuer:string}>('SELECT state,issuer FROM signing_verifiers WHERE key_id=$1',[m.keyId])).rows[0];requireCondition(verifier&&['ISSUING','VERIFY_ONLY'].includes(verifier.state)&&verifier.issuer===this.signer.issuer,'FILE_ACCESS_UNCONFIRMED');
      await tx.client.query('INSERT INTO project_lineages(account_id,project_lineage_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.accountId,m.projectLineageId]);
      const generation=(await tx.client.query<{generation:string}>('SELECT (COALESCE(max(generation),0)+1)::text AS generation FROM workspace_contexts WHERE account_id=$1 AND project_lineage_id=$2',[actor.accountId,m.projectLineageId])).rows[0].generation;
      const contextId=randomUUID();const cap=randomBytes(32).toString('base64url');await tx.client.query(`INSERT INTO workspace_contexts(account_id,context_id,project_lineage_id,generation,lifecycle,owner_session_id,owner_tab_id,owner_revision,workspace_revision,connection_generation,heartbeat_seq,last_valid_heartbeat_at,owner_capability_digest,project_status,title)
        VALUES($1,$2,$3,$4,'OPEN',$5,$6,0,0,1,0,$7,$8,$9,'복원한 프로젝트')`,[actor.accountId,contextId,m.projectLineageId,generation,actor.sessionId,actor.tabId,tx.now,sha256(cap),m.projectStatus]);
      await tx.client.query('INSERT INTO account_live_context_slots(account_id,context_id,generation,revision) VALUES($1,$2,$3,0)',[actor.accountId,contextId,generation]);
      if(m.settings){await tx.client.query('INSERT INTO settings_revisions(account_id,context_id,settings_revision,contract_version,captured_settings) VALUES($1,$2,$3,$4,$5)',[actor.accountId,contextId,m.settings.settingsVersion,m.settings.contractVersion,JSON.stringify(m.settings)]);await tx.client.query('UPDATE workspace_contexts SET current_settings_revision=$3 WHERE account_id=$1 AND context_id=$2',[actor.accountId,contextId,m.settings.settingsVersion]);}
      for(const [order,page]of m.pages.entries()){await tx.client.query('INSERT INTO page_lineages(account_id,project_lineage_id,page_lineage_id) VALUES($1,$2,$3) ON CONFLICT(account_id,page_lineage_id) DO NOTHING',[actor.accountId,m.projectLineageId,page.pageLineageId]);const resultId=randomUUID();
        await tx.client.query(`INSERT INTO workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,revision,paid_baseline_credit,paid_baseline_state,baseline_contribution_refs,baseline_unsettled_refs,image_width,image_height,display_name) VALUES($1,$2,$3,$4,$5,false,$6,$7,0,$8,$9,$10,$11,$12,$13,$14)`,[actor.accountId,contextId,m.projectLineageId,page.pageLineageId,order,page.skip,page.resultRevision,page.paidCumulativeBaselineCredit,page.paidCumulativeBaselineState,JSON.stringify(page.baselineContributionIds),JSON.stringify(m.unsettledReferences.filter(r=>r.pageLineageId===page.pageLineageId)),page.widthPx,page.heightPx,page.displayName]);
        await tx.client.query(`INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,cleaned_asset_id,render_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$2::uuid::text,'IMPORT_BASELINE',$9)`,[actor.accountId,resultId,contextId,page.pageLineageId,page.resultRevision,page.originalAssetId,page.cleanedAssetId,page.renderAssetId,JSON.stringify({blocks:page.blocks,geometryContract:page.geometryContract,renderContract:page.renderContract,renderSpecification:page.renderSpecification??null,cleanupQa:page.cleanupQa})]);await tx.client.query('UPDATE workspace_pages SET current_result_id=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[actor.accountId,contextId,page.pageLineageId,resultId]);
      }
      await tx.client.query("UPDATE uploads SET state='COMMITTED',restored_assessment=$3 WHERE account_id=$1 AND upload_id=$2",[actor.accountId,input.uploadId,JSON.stringify({fileSha256:assessment.fileSha256,checkpointReuseAvailable:assessment.checkpointReuseAvailable})]);const context=await contextRow(tx,contextId);const response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:contextId});await this.workspace.record(tx,input,response,'IMPORT_PROJECT',contextId);return {reply:response,ownerCapability:cap,checkpointReuseAvailable:assessment.checkpointReuseAvailable};
    });
  }
}
