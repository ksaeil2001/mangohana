import {afterEach,describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {FileObjectStore} from '../../packages/storage/src/objects.js';
import {Assets} from '../../packages/domain/src/assets.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {FileService} from '../../packages/domain/src/files.js';
import {ExportBuildService} from '../../packages/domain/src/export-build.js';
import {ResultRaster} from '../../packages/domain/src/raster.js';
import {LibraryService} from '../../packages/domain/src/library.js';
import {contextRow,type Actor,type ResultRow} from '../../packages/domain/src/model.js';
import {queueWork} from '../../packages/domain/src/requests.js';
import {closeContext} from '../../packages/domain/src/liveness.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {ProjectSigner} from '../../packages/media/src/project-file.js';
import {canonicalRendererVersion} from '../../packages/media/src/render.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {readZip,writeZip} from '../../packages/media/src/zip.js';
import {decodeImage} from '../../packages/media/src/images.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError,type NativeGateway,type NativeTarget} from '../../packages/native/src/gateway.js';
import {testDatabase,seedIdentity} from '../fixtures/database.js';

// These regressions exercise parent rows through local API/worker LOGIN roles.
// The injected port is a fixture; it does not establish native isolation or durable job resolution.
const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
let fontsPromise:Promise<FontCatalog>|undefined;
function unknown(){return new NativeJobError('NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-input'),profileDigest:digest(syntheticProfile),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'DIRECT_CHILD_ONLY'});}
function gateway(overrides:Partial<Pick<NativeFacade,'decodeImage'|'readZip'|'writeZip'|'renderPage'>>={}){
  const targets:NativeTarget[]=[];
  const native:NativeGateway={forTarget:vi.fn(target=>{targets.push(structuredClone(target));const port=Object.create(NativeFacade.prototype) as NativeFacade;port.decodeImage=decodeImage;port.readZip=readZip;port.writeZip=writeZip;port.renderPage=async bytes=>bytes;return Object.assign(port,overrides);}),stopClaims:vi.fn(),idle:async()=>{}};
  return {native,targets};
}
async function fixture(){
  const now=new Date('2026-10-03T00:00:00Z'),clock=async()=>now,admin=await testDatabase(clock);connections.push(admin);const identity=await seedIdentity(admin,now),api=await provisionLocalService(admin,'trio_web_api',clock),worker=await provisionLocalService(admin,'trio_web_worker',clock);connections.push(api,worker);
  expect((await api.pool.query('SELECT session_user,current_user')).rows[0]).toMatchObject({current_user:'trio_web_api'});expect((await worker.pool.query('SELECT session_user,current_user')).rows[0]).toMatchObject({current_user:'trio_web_worker'});
  const fonts=await (fontsPromise??=FontCatalog.load()),keys=generateKeyPairSync('ed25519'),keyId=`owned-native-${randomUUID()}`;
  await admin.pool.query("INSERT INTO manga_web.signing_verifiers(key_id,algorithm,issuer,public_key,state,catalog_version) VALUES($1,'Ed25519','owned-native-media',$2,'ISSUING','synthetic-v1')",[keyId,keys.publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
  const profile={...syntheticProfile},signer=new ProjectSigner(api,'owned-native-media',keyId,keys.privateKey),objects=new FileObjectStore(await mkdtemp(path.join(tmpdir(),'trio-native-media-port-')),profile.maxZipBytes,()=>now),assets=new Assets(api,objects),workerAssets=new Assets(worker,objects),workspace=new WorkspaceService(api,{stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false}),files=new FileService(api,workspace,assets,fonts,signer,profile);
  const actor:Actor={accountId:identity.accountId,sessionId:identity.sessionId,tabId:randomUUID(),ownerCapability:null};const created=await workspace.create(actor,{commandId:randomUUID(),intentVersion:1,tabId:actor.tabId});actor.ownerCapability=created.ownerCapability!;const contextId=created.reply.operationRef.id!;
  const target=()=>api.accountTransaction(actor.accountId,async tx=>{const c=await contextRow(tx,contextId);return {contextId,contextGeneration:c.generation,tabId:actor.tabId,expectedOwnerRevision:c.owner_revision,expectedWorkspaceRevision:c.workspace_revision};});
  const image=await sharp({create:{width:16,height:12,channels:4,background:'white'}}).png().toBuffer();
  const prepare=async()=>files.prepare(actor,{commandId:randomUUID(),intentVersion:1,purpose:'PAGE_IMAGES',target:await target()});
  const commit=async()=>{const prepared=await prepare(),preview=await files.receive(actor,prepared.operationRef.id!,randomUUID(),'owned.png',image);await workspace.handle(actor,{commandId:randomUUID(),intentVersion:1,target:await target(),operation:{kind:'COMMIT_UPLOAD',payload:{uploadId:preview.uploadId,previewRevision:preview.previewRevision,candidateIdsInOrder:preview.candidateIdsInOrder,explicitDuplicateIds:[]}}});return (await admin.pool.query<{current_result_id:string}>('SELECT current_result_id FROM manga_web.workspace_pages WHERE account_id=$1',[actor.accountId])).rows[0].current_result_id;};
  const nativeFiles=(native:NativeGateway)=>new FileService(api,new WorkspaceService(api,workspace.policy),assets,fonts,signer,profile,native);
  const capture=(kind:'PROJECT_FILE'|'FINAL_ZIP')=>api.accountTransaction(actor.accountId,async tx=>files.capture(tx,await contextRow(tx,contextId),kind));
  const result=(id:string)=>api.accountTransaction(actor.accountId,async tx=>(await tx.client.query<ResultRow>('SELECT * FROM results WHERE account_id=$1 AND result_id=$2',[actor.accountId,id])).rows[0]);
  const queue=(resultId:string)=>worker.accountTransaction(actor.accountId,tx=>queueWork(tx,'STORE',{resultId}));
  return {admin,api,worker,profile,fonts,signer,objects,assets,workerAssets,workspace,files,actor,contextId,image,now,target,prepare,commit,nativeFiles,capture,result,queue};
}

describe('native parent media ports preserve owning rows',()=>{
  it('preserves an unconfirmed upload candidate and bytes instead of decode INVALID or a repeated computation',async()=>{
    const f=await fixture(),prepared=await f.prepare(),candidateId=randomUUID(),error=unknown(),decode=vi.fn(async()=>{throw error;}),g=gateway({decodeImage:decode}),files=f.nativeFiles(g.native);
    await expect(files.receive(f.actor,prepared.operationRef.id!,candidateId,'owned.png',f.image)).rejects.toBe(error);
    const candidate=(await f.admin.pool.query('SELECT * FROM manga_web.upload_candidates WHERE candidate_id=$1',[candidateId])).rows[0],upload=(await f.admin.pool.query('SELECT * FROM manga_web.uploads WHERE upload_id=$1',[prepared.operationRef.id])).rows[0];
    expect(candidate).toMatchObject({decode_state:'UNCONFIRMED',reason_code:'EXECUTION_UNKNOWN',asset_id:candidateId,width:null,height:null});expect(upload).toMatchObject({state:'READY',preview_revision:'1'});expect(await f.assets.bytes(f.actor.accountId,candidateId)).toEqual(f.image);
    const preview=await files.receive(f.actor,upload.upload_id,candidateId,'owned.png',f.image);expect(preview.failures).toEqual([{candidateId,reasonCode:'EXECUTION_UNKNOWN'}]);expect(preview.candidateIdsInOrder).toEqual([]);expect(decode).toHaveBeenCalledOnce();
    expect(g.targets).toHaveLength(1);expect(g.targets[0]).toMatchObject({accountId:f.actor.accountId,targetKind:'UPLOAD',targetId:upload.upload_id,protectedOwnerCapture:{contextId:f.contextId,ownerSessionId:f.actor.sessionId,ownerTabId:f.actor.tabId},claim:{generation:'0',ownerId:f.actor.sessionId,workItemId:null}});expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.workspace_pages')).rows[0].n).toBe(0);
  });
  it('keeps the opaque restore original, upload and empty live slot after a native ZIP failure',async()=>{
    const f=await fixture();await f.api.accountTransaction(f.actor.accountId,async tx=>closeContext(tx,await contextRow(tx,f.contextId),'NORMAL_EXIT'));
    const prepared=await f.files.prepare(f.actor,{commandId:randomUUID(),intentVersion:1,purpose:'PROJECT_IMPORT',target:null}),candidateId=randomUUID(),original=Buffer.from('owned opaque restore candidate');await f.files.receive(f.actor,prepared.operationRef.id!,candidateId,'owned.manga-project.zip',original);
    const error=unknown(),g=gateway({readZip:async()=>{throw error;}}),files=f.nativeFiles(g.native),commandId=randomUUID();await expect(files.restore(f.actor,{commandId,intentVersion:1,uploadId:prepared.operationRef.id!,tabId:f.actor.tabId})).rejects.toBe(error);
    expect(await f.assets.bytes(f.actor.accountId,candidateId)).toEqual(original);expect((await f.admin.pool.query('SELECT state FROM manga_web.uploads WHERE upload_id=$1',[prepared.operationRef.id])).rows[0].state).toBe('READY');expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.account_live_context_slots')).rows[0].n).toBe(0);expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.workspace_contexts')).rows[0].n).toBe(1);
    expect(g.targets[0]).toMatchObject({targetKind:'RESTORE',targetId:prepared.operationRef.id,protectedOwnerCapture:{contextId:null,contextGeneration:null,ownerSessionId:f.actor.sessionId,ownerTabId:f.actor.tabId,ownerRevision:null,workspaceRevision:null},claim:{generation:'1',ownerId:f.actor.sessionId,workItemId:null}});
  });
  it('retains the raster generation, owner and lease without publishing or converting unknown into a QA hold',async()=>{
    const f=await fixture(),resultId=await f.commit(),original=await f.result(resultId),error=unknown(),g=gateway({renderPage:async()=>{throw error;}}),fallback=vi.fn(async bytes=>bytes),raster=new ResultRaster(f.api,f.assets,f.fonts,f.profile,{render:fallback},g.native),put=vi.spyOn(f.objects,'put');
    await expect(raster.get(f.actor.accountId,resultId)).rejects.toBe(error);const claim=(await f.admin.pool.query('SELECT * FROM manga_web.result_render_claims WHERE result_id=$1',[resultId])).rows[0];
    expect(claim).toMatchObject({generation:'1',owner_id:g.targets[0].claim.ownerId,render_digest:g.targets[0].semanticCaptureDigest});expect(claim.lease_until.valueOf()).toBe(f.now.valueOf()+30000);expect(fallback).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.result_render_snapshots')).rows[0].n).toBe(0);expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.result_render_holds')).rows[0].n).toBe(0);expect(await f.result(resultId)).toEqual(original);expect(g.targets[0]).toMatchObject({targetKind:'RASTER',targetId:resultId,claim:{generation:'1',workItemId:null}});
  });
  it('holds a native export render failure under the original claim without candidates, PUT or FAILED',async()=>{
    const f=await fixture();await f.commit();const exportId=await f.capture('FINAL_ZIP'),capture=(await f.admin.pool.query('SELECT * FROM manga_web.exports WHERE export_id=$1',[exportId])).rows[0],error=unknown(),g=gateway({renderPage:async()=>{throw error;}}),fallback=vi.fn(async bytes=>bytes),build=new ExportBuildService(f.api,f.assets,f.fonts,f.signer,f.profile,{render:fallback},g.native),put=vi.spyOn(f.objects,'put');
    await expect(build.build(f.actor,exportId)).rejects.toBe(error);const row=(await f.admin.pool.query('SELECT * FROM manga_web.export_builds WHERE export_id=$1',[exportId])).rows[0],current=(await f.admin.pool.query('SELECT * FROM manga_web.exports WHERE export_id=$1',[exportId])).rows[0];
    expect(row).toMatchObject({state:'BUILDING',generation:'1',last_error_code:'EXECUTION_UNKNOWN',owner_id:g.targets[0].claim.ownerId});expect(row.lease_until.valueOf()).toBe(f.now.valueOf()+30000);expect(current).toMatchObject({state:'ACCEPTED',safe_error_code:'EXECUTION_UNKNOWN',output_asset_id:null,captured_manifest:capture.captured_manifest,snapshot_revision:capture.snapshot_revision});expect(fallback).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.export_build_candidates')).rows[0].n).toBe(0);expect(g.targets[0]).toMatchObject({targetKind:'EXPORT',targetId:exportId,semanticCaptureDigest:digest({version:1,kind:capture.kind,manifest:capture.captured_manifest}),protectedOwnerCapture:{workspaceRevision:capture.snapshot_revision},claim:{generation:'1',workItemId:null}});
  });
  it('preserves a confirmed project candidate when native post-PUT validation is uncertain',async()=>{
    const f=await fixture();await f.commit();const exportId=await f.capture('PROJECT_FILE'),error=unknown(),zipWrite=vi.fn(writeZip),zipRead=vi.fn(async()=>{throw error;}),g=gateway({writeZip:zipWrite,readZip:zipRead}),build=new ExportBuildService(f.api,f.assets,f.fonts,f.signer,f.profile,{},g.native),put=vi.spyOn(f.objects,'put');
    await expect(build.build(f.actor,exportId)).rejects.toBe(error);const candidates=(await f.admin.pool.query('SELECT * FROM manga_web.export_build_candidates WHERE export_id=$1',[exportId])).rows;
    expect(candidates).toHaveLength(1);const candidate=candidates[0],receipt=await f.objects.receipt(candidate.object_key);expect(receipt).toMatchObject({sha256:candidate.sha256,bytesLength:candidate.bytes_length});expect(sha256(await f.objects.read(candidate.object_key))).toBe(candidate.sha256);expect(zipWrite).toHaveBeenCalledOnce();expect(zipRead).toHaveBeenCalledOnce();expect(put).toHaveBeenCalledOnce();expect((await f.admin.pool.query('SELECT state,last_error_code FROM manga_web.export_builds WHERE export_id=$1',[exportId])).rows[0]).toEqual({state:'BUILDING',last_error_code:'EXECUTION_UNKNOWN'});expect((await f.admin.pool.query('SELECT state,output_asset_id FROM manga_web.exports WHERE export_id=$1',[exportId])).rows[0]).toEqual({state:'ACCEPTED',output_asset_id:null});
  });
  it('binds COMPLETE project download validation to the sealed claim and original snapshot after later page edits',async()=>{
    const f=await fixture();await f.commit();const exportId=await f.capture('PROJECT_FILE');await f.files.build(f.actor,exportId);const row=(await f.admin.pool.query('SELECT * FROM manga_web.export_builds WHERE export_id=$1',[exportId])).rows[0],capture=(await f.admin.pool.query('SELECT * FROM manga_web.exports WHERE export_id=$1',[exportId])).rows[0];
    await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE context_id=$1',[f.contextId]);const error=unknown(),zipRead=vi.fn(readZip),decode=vi.fn(async()=>{throw error;}),g=gateway({readZip:zipRead,decodeImage:decode});await expect(f.nativeFiles(g.native).download(f.actor,exportId)).rejects.toBe(error);
    expect(zipRead).toHaveBeenCalledOnce();expect(decode).toHaveBeenCalledOnce();expect(g.targets[0]).toEqual({accountId:f.actor.accountId,targetKind:'EXPORT',targetId:exportId,semanticCaptureDigest:digest({version:1,kind:capture.kind,manifest:capture.captured_manifest}),protectedOwnerCapture:{contextId:f.contextId,contextGeneration:capture.context_generation,ownerSessionId:row.claim_authorization.sessionId,ownerTabId:row.claim_authorization.tabId,ownerRevision:row.claim_authorization.ownerRevision,workspaceRevision:capture.snapshot_revision},claim:{generation:row.generation,ownerId:row.owner_id,workItemId:null}});expect((await f.admin.pool.query('SELECT state,output_asset_id,delivered_at FROM manga_web.exports WHERE export_id=$1',[exportId])).rows[0]).toEqual({state:'AVAILABLE',output_asset_id:capture.output_asset_id,delivered_at:null});
  });
  it('holds an initial resultId-only library work item without creating storage attempts or FAILED',async()=>{
    const f=await fixture(),resultId=await f.commit();await f.admin.pool.query("UPDATE manga_web.results SET origin='AI_APPLIED' WHERE result_id=$1",[resultId]);await f.queue(resultId);const error=unknown(),g=gateway({renderPage:async()=>{throw error;}}),fallback=vi.fn(async bytes=>bytes),library=new LibraryService(f.worker,f.workerAssets,f.fonts,f.profile,{render:fallback},g.native),put=vi.spyOn(f.objects,'put');
    await expect(library.runOnce()).rejects.toBe(error);const operation=(await f.admin.pool.query('SELECT * FROM manga_web.library_store_operations')).rows[0],work=(await f.admin.pool.query("SELECT * FROM manga_web.work_items WHERE kind='STORE'")).rows[0];
    expect(operation).toMatchObject({state:'ACCEPTED',safe_error_code:'EXECUTION_UNKNOWN',asset_id:null,store_completed_at:null});expect(work).toMatchObject({state:'CLAIMED',claim_generation:'1',claim_owner:library.workerId,target_ref:{resultId}});expect(work.lease_until.valueOf()).toBe(f.now.valueOf()+30000);expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.library_store_attempts')).rows[0].n).toBe(0);expect(fallback).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect(g.targets[0]).toMatchObject({targetKind:'LIBRARY',targetId:operation.store_operation_id,semanticCaptureDigest:operation.render_digest,claim:{generation:work.claim_generation,ownerId:library.workerId,workItemId:work.work_item_id}});
  });
  it('stores an immutable result after its source context closes using the library work claim',async()=>{
    const f=await fixture(),resultId=await f.commit();await f.admin.pool.query("UPDATE manga_web.results SET origin='MANUAL_EDIT' WHERE result_id=$1",[resultId]);await f.api.accountTransaction(f.actor.accountId,async tx=>closeContext(tx,await contextRow(tx,f.contextId),'NORMAL_EXIT'));await f.queue(resultId);const render=vi.fn(async bytes=>bytes),g=gateway({renderPage:render}),library=new LibraryService(f.worker,f.workerAssets,f.fonts,f.profile,{},g.native);
    expect(await library.runOnce()).toBe(true);const operation=(await f.admin.pool.query('SELECT * FROM manga_web.library_store_operations')).rows[0];expect(operation.state).toBe('SUCCEEDED');expect(await f.workerAssets.bytes(f.actor.accountId,operation.asset_id)).toEqual(f.image);expect(g.targets[0]).toMatchObject({targetKind:'LIBRARY',protectedOwnerCapture:{contextId:f.contextId,contextGeneration:'1',ownerSessionId:null,ownerTabId:null},claim:{ownerId:library.workerId}});expect(render).toHaveBeenCalledOnce();
  });
  it('uses an existing immutable QA hold without starting a new native library render or storage attempt',async()=>{
    const f=await fixture(),resultId=await f.commit();await f.admin.pool.query("UPDATE manga_web.results SET origin='MANUAL_EDIT' WHERE result_id=$1",[resultId]);const result=await f.result(resultId),renderDigest=digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,data:result.edit_data,fontCatalogVersion:f.fonts.catalog.version,renderer:canonicalRendererVersion(result.edit_data),profile:f.profile.id}),layout={rendererVersion:'pango-canonical-v1',qa:'HOLD',holdReasons:['GLYPHS_OUTSIDE_PAGE'],blocks:[]},overlays:unknown[]=[];
    await f.admin.pool.query('INSERT INTO manga_web.result_render_holds(account_id,result_id,render_digest,evidence_digest,protected_layout,protected_overlays,claim_generation,created_at) VALUES($1,$2,$3,$4,$5,$6,1,$7)',[f.actor.accountId,resultId,renderDigest,digest({layout,overlays}),JSON.stringify(layout),JSON.stringify(overlays),f.now]);await f.queue(resultId);const render=vi.fn(async bytes=>bytes),g=gateway({renderPage:render}),library=new LibraryService(f.worker,f.workerAssets,f.fonts,f.profile,{},g.native);library.canonical=new ResultRaster(f.worker,f.workerAssets,f.fonts,f.profile,{},g.native);
    expect(await library.runOnce()).toBe(true);expect((await f.admin.pool.query('SELECT state,safe_error_code FROM manga_web.library_store_operations')).rows[0]).toEqual({state:'FAILED',safe_error_code:'RENDER_QA_HOLD'});expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.library_store_attempts')).rows[0].n).toBe(0);expect(render).not.toHaveBeenCalled();expect(g.targets).toEqual([]);expect((await f.admin.pool.query('SELECT protected_layout FROM manga_web.result_render_holds WHERE result_id=$1',[resultId])).rows[0].protected_layout).toEqual(layout);
  });
  it.each(['RESULT_ASSET','SNAPSHOT'] as const)('reuses existing %s canonical PNG bytes for native library without calculation or a raster claim',async source=>{
    const f=await fixture(),resultId=await f.commit();await f.admin.pool.query("UPDATE manga_web.results SET origin='MANUAL_EDIT' WHERE result_id=$1",[resultId]);
    const prior=await sharp({create:{width:16,height:12,channels:4,background:'red'}}).png().toBuffer(),assetId=randomUUID();expect(sha256(prior)).not.toBe(sha256(f.image));await f.workerAssets.put(f.actor.accountId,assetId,prior,'LIVE','image/png',f.contextId);
    if(source==='RESULT_ASSET')await f.admin.pool.query('UPDATE manga_web.results SET render_asset_id=$2 WHERE result_id=$1',[resultId,assetId]);
    else{const result=await f.result(resultId),signature=digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,data:result.edit_data,fontCatalogVersion:f.fonts.catalog.version,renderer:canonicalRendererVersion(result.edit_data),profile:f.profile.id});await f.admin.pool.query('INSERT INTO manga_web.result_render_snapshots(account_id,result_id,render_digest,render_asset_id,created_at) VALUES($1,$2,$3,$4,$5)',[f.actor.accountId,resultId,signature,assetId,f.now]);}
    const originalResult=await f.result(resultId);await f.api.accountTransaction(f.actor.accountId,async tx=>closeContext(tx,await contextRow(tx,f.contextId),'NORMAL_EXIT'));await f.queue(resultId);
    const render=vi.fn(async bytes=>bytes),fallback=vi.fn(async bytes=>bytes),g=gateway({renderPage:render}),library=new LibraryService(f.worker,f.workerAssets,f.fonts,f.profile,{render:fallback},g.native),canonical=new ResultRaster(f.worker,f.workerAssets,f.fonts,f.profile,{},g.native),get=vi.spyOn(canonical,'get'),put=vi.spyOn(f.objects,'put');if(source==='SNAPSHOT')library.canonical=canonical;
    expect(await library.runOnce()).toBe(true);const operation=(await f.admin.pool.query('SELECT * FROM manga_web.library_store_operations')).rows[0];expect(operation.state).toBe('SUCCEEDED');expect(await f.workerAssets.bytes(f.actor.accountId,operation.asset_id)).toEqual(prior);expect(await f.workerAssets.bytes(f.actor.accountId,operation.render_asset_id)).toEqual(prior);expect(put).toHaveBeenCalledTimes(2);expect(put.mock.calls.every(([,bytes])=>bytes.equals(prior))).toBe(true);
    expect(render).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(g.targets).toEqual([]);expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.result_render_claims')).rows[0].n).toBe(0);expect((await f.admin.pool.query('SELECT count(*)::int AS n FROM manga_web.result_render_candidates')).rows[0].n).toBe(0);expect(await f.result(resultId)).toEqual(originalResult);
  });
});
