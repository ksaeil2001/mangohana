import {afterEach,it,expect} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {manualCommands,manualAvailability,invalidateChangedHistory,insertResult,blockDependencies} from '../../packages/domain/src/manual.js';
import {contextRow,pageRow,resultRow,type EditData} from '../../packages/domain/src/model.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {Block,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import type {ProjectManifest} from '../../packages/contracts/src/manifest.generated.js';
import {sha256} from '../../packages/contracts/src/intent.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {ProjectSigner,assessProject,encodeProject} from '../../packages/media/src/project-file.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {readZip,writeZip} from '../../packages/media/src/zip.js';
import {testDatabase,seedIdentity,seedWorkspace} from '../fixtures/database.js';

const connections:Database[]=[];afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
async function fixture(policyChoice?:RequestPolicy['manualFontBelowMinimum'],legacy=false){
  const now=new Date();const clock=async()=>now;const admin=await testDatabase(clock);connections.push(admin);const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const api=await provisionLocalService(admin,'trio_web_api',clock);connections.push(api);const fonts=await FontCatalog.load();
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};const pageId=seed.pageIds[0];
  const blocks:Block[]=[0,1].map(index=>({regionId:randomUUID(),geometry:{polygon:[{x:5+index*45,y:5},{x:45+index*45,y:5},{x:45+index*45,y:85},{x:5+index*45,y:85}],angleDegrees:0,orientation:'HORIZONTAL',readingOrder:index},sourceText:{value:'원문',status:'AI_PROPOSED'},translatedText:{value:'번역',status:'AI_PROPOSED'},fontAssetId:fonts.catalog.fonts[0].id,fontSizePx:24,appliedTranslation:null}));
  const data:EditData={blocks,geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',...(legacy?{}:{renderSpecification:{version:1,fontCatalogVersion:fonts.catalog.version,blocks:blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT'}))}})};
  await admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE page_lineage_id=$1',[pageId,JSON.stringify(data)]);
  const policy:RequestPolicy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false,...(policyChoice?{manualFontBelowMinimum:policyChoice}:{})};
  const workspace=new WorkspaceService(api,policy);workspace.extensions.push(manualCommands(id=>fonts.has(id),syntheticProfile.maxTextLength,syntheticProfile.maxFontSize,{fontCatalogVersion:fonts.catalog.version,manualFontBelowMinimum:policyChoice}));
  const current=()=>api.accountTransaction(actor.accountId,async tx=>{const page=await pageRow(tx,await contextRow(tx,seed.contextId),pageId);return resultRow(tx,page);});
  const history=()=>api.accountTransaction(actor.accountId,async tx=>{const page=await pageRow(tx,await contextRow(tx,seed.contextId),pageId);return manualAvailability(tx,page,await resultRow(tx,page));});
  const command=async(operation:WorkspaceCommand['operation'])=>{const context=(await admin.pool.query<{generation:string;owner_revision:string;workspace_revision:string}>('SELECT generation,owner_revision,workspace_revision FROM manga_web.workspace_contexts WHERE context_id=$1',[seed.contextId])).rows[0];return workspace.handle(actor,{commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:context.generation,tabId:actor.tabId,expectedOwnerRevision:context.owner_revision,expectedWorkspaceRevision:context.workspace_revision},operation});};
  const edit=async(patch:Extract<WorkspaceCommand['operation'],{kind:'MANUAL_EDIT'}>['payload']['patch'],index=0)=>command({kind:'MANUAL_EDIT',payload:{pageId,regionId:blocks[index].regionId,expectedResultRevision:(await current()).result_revision,patch}});
  const undoRedo=async(kind:'UNDO'|'REDO')=>{const h=await history();return command({kind,payload:{pageId,expectedHistoryRevision:h.revision,cursorId:h.cursorId}});};
  const applyDependencyChange=async(change:(data:EditData)=>void)=>api.accountTransaction(actor.accountId,async tx=>{const page=await pageRow(tx,await contextRow(tx,seed.contextId),pageId);const before=await resultRow(tx,page);const after=structuredClone(before.edit_data);change(after);await invalidateChangedHistory(tx,page,before,after);await insertResult(tx,page,before,after);});
  return {admin,api,seed,actor,fonts,pageId,blocks,data,workspace,command,current,history,edit,undoRedo,applyDependencyChange};
}

it('blocks only a changed size below the captured minimum while the choice remains pending',async()=>{
  const f=await fixture();const before=await f.current();await expect(f.edit({fontSizePx:8})).rejects.toMatchObject({code:'POLICY_DECISION_REQUIRED'});expect(await f.current()).toEqual(before);expect((await f.history()).canUndo).toBe(false);
  await f.edit({fontSizePx:24});expect((await f.current()).edit_data.renderSpecification).toEqual(before.edit_data.renderSpecification);
  await f.edit({translatedText:'텍스트만 수정',fontAssetId:f.fonts.catalog.fonts[1].id});expect((await f.current()).edit_data.blocks[0].translatedText.value).toBe('텍스트만 수정');
  await f.edit({fontSizePx:14});const changed=await f.current();expect(changed.edit_data.blocks[0].fontSizePx).toBe(14);expect(changed.edit_data.renderSpecification?.blocks[0]).toMatchObject({minimumFontSizePx:12,sizing:'EXACT'});
});

it('honors ALLOW, captures the exact user size and restores per-block sizing through Undo and Redo',async()=>{
  const f=await fixture('ALLOW');const before=await f.current();await f.edit({fontSizePx:8});let result=await f.current();expect(result.edit_data.blocks[0].fontSizePx).toBe(8);expect(result.edit_data.renderSpecification?.fontCatalogVersion).toBe(f.fonts.catalog.version);expect(result.edit_data.renderSpecification?.blocks[0]).toMatchObject({minimumFontSizePx:12,sizing:'EXACT'});expect(result.edit_data.blocks[1]).toEqual(before.edit_data.blocks[1]);expect(result.edit_data.renderSpecification?.blocks[1]).toEqual(before.edit_data.renderSpecification?.blocks[1]);
  expect((await f.history()).canUndo).toBe(true);await f.undoRedo('UNDO');result=await f.current();expect(result.edit_data.blocks[0]).toEqual(before.edit_data.blocks[0]);expect(result.edit_data.renderSpecification).toEqual(before.edit_data.renderSpecification);expect((await f.history()).canRedo).toBe(true);
  await f.undoRedo('REDO');result=await f.current();expect(result.edit_data.blocks[0].fontSizePx).toBe(8);expect(result.edit_data.renderSpecification?.blocks[0].sizing).toBe('EXACT');expect((await f.history()).canUndo).toBe(true);
});

it('honors REJECT without changing the result/history and accepts an exact size above the minimum',async()=>{
  const f=await fixture('REJECT');const before=await f.current();await expect(f.edit({fontSizePx:8})).rejects.toMatchObject({code:'INPUT_INVALID',status:422});expect(await f.current()).toEqual(before);expect((await f.admin.pool.query('SELECT count(*) AS count FROM manga_web.manual_history')).rows[0].count).toBe('0');
  await f.edit({fontSizePx:16});expect((await f.current()).edit_data.renderSpecification?.blocks[0]).toMatchObject({minimumFontSizePx:12,sizing:'EXACT'});
});

it('does not block the same existing below-minimum size or text/font edits while the policy is pending',async()=>{
  const f=await fixture();const existing=structuredClone(f.data);existing.blocks[0].fontSizePx=8;existing.renderSpecification!.blocks[0].sizing='EXACT';await f.admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE page_lineage_id=$1',[f.pageId,JSON.stringify(existing)]);
  await f.edit({fontSizePx:8,translatedText:'기존 크기를 유지'});await f.edit({fontAssetId:f.fonts.catalog.fonts[1].id});expect((await f.current()).edit_data.blocks[0].fontSizePx).toBe(8);expect((await f.current()).edit_data.renderSpecification?.blocks[0]).toMatchObject({minimumFontSizePx:12,sizing:'EXACT'});
  await expect(f.edit({fontSizePx:7})).rejects.toMatchObject({code:'POLICY_DECISION_REQUIRED'});
});

it('captures legacy v1 minimum 1 with the pinned catalog and preserves that behavior through the history chain',async()=>{
  const f=await fixture(undefined,true);const original=await f.current();expect(original.edit_data.renderSpecification).toBeUndefined();await f.edit({translatedText:'레거시 대사 수정'});let result=await f.current();expect(result.edit_data.renderSpecification).toEqual({version:1,fontCatalogVersion:f.fonts.catalog.version,blocks:f.blocks.map((block,index)=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT',...(index===0?{rendererVersion:'pango-overflow-v2'}:{})}))});
  await f.edit({fontSizePx:18});expect((await f.current()).edit_data.renderSpecification?.blocks[0].sizing).toBe('EXACT');await f.undoRedo('UNDO');expect((await f.current()).edit_data.renderSpecification?.blocks[0]).toMatchObject({minimumFontSizePx:1,sizing:'AUTO_FIT'});expect((await f.history()).canUndo).toBe(true);await f.undoRedo('UNDO');result=await f.current();expect(result.edit_data.blocks).toEqual(original.edit_data.blocks);expect(result.edit_data.renderSpecification?.fontCatalogVersion).toBe(f.fonts.catalog.version);await f.undoRedo('REDO');await f.undoRedo('REDO');expect((await f.current()).edit_data.blocks[0].fontSizePx).toBe(18);
  expect((await f.admin.pool.query('SELECT edit_data FROM manga_web.results WHERE result_id=$1',[original.result_id])).rows[0].edit_data).toEqual(original.edit_data);
});

it('invalidates only the block whose captured minimum changed and retains another block history',async()=>{
  const f=await fixture();await f.edit({translatedText:'첫 블록 수정'},0);await f.edit({translatedText:'둘째 블록 수정'},1);
  const before=await f.current();await f.applyDependencyChange(data=>{data.renderSpecification!.blocks[0].minimumFontSizePx=13;});const after=await f.current();expect(blockDependencies(before,before.edit_data.blocks[0])).not.toBe(blockDependencies(after,after.edit_data.blocks[0]));expect(blockDependencies(before,before.edit_data.blocks[1])).toBe(blockDependencies(after,after.edit_data.blocks[1]));
  const histories=(await f.admin.pool.query<{validity:string;protected_delta:{regionId:string}}>('SELECT validity,protected_delta FROM manga_web.manual_history ORDER BY sequence_no')).rows;expect(histories).toMatchObject([{validity:'INVALIDATED',protected_delta:{regionId:f.blocks[0].regionId}},{validity:'VALID',protected_delta:{regionId:f.blocks[1].regionId}}]);expect((await f.history()).canUndo).toBe(true);await f.undoRedo('UNDO');expect((await f.current()).edit_data.blocks[1]).toEqual(f.blocks[1]);
});

it.each(['CATALOG','CONTRACT','SIZING'] as const)('invalidates captured history when its %s dependency changes',async dependency=>{
  const f=await fixture();await f.edit({translatedText:'수동 수정'});await f.applyDependencyChange(data=>{if(dependency==='CATALOG')data.renderSpecification!.fontCatalogVersion='different-catalog';else if(dependency==='CONTRACT')data.renderContract='different-contract';else data.renderSpecification!.blocks[0].sizing='EXACT';});expect((await f.history()).canUndo).toBe(false);expect((await f.admin.pool.query('SELECT validity FROM manga_web.manual_history')).rows[0].validity).toBe('INVALIDATED');
});

it('allocates after an immutable NOT_APPLICABLE result without colliding with the current page revision',async()=>{
  const f=await fixture();const before=await f.current();const requestId=randomUUID(),executionId=randomUUID(),lateResultId=randomUUID();
  await f.admin.accountTransaction(f.actor.accountId,async tx=>{
    await tx.client.query("INSERT INTO settings_revisions(account_id,context_id,settings_revision,contract_version,captured_settings) VALUES($1,$2,0,'synthetic-v1','{}')",[f.actor.accountId,f.seed.contextId]);
    await tx.client.query("INSERT INTO processing_requests(account_id,request_id,context_id,context_generation,project_lineage_id,page_lineage_id,settings_revision,scope_digest,captured_scope,state,hold_reasons,mode,revision,terminal_at,terminal_evidence_ref,captured_stage_order) VALUES($1,$2,$3,1,$4,$5,0,repeat('a',64),'{}','COMPLETED','[]','FREE',0,$6,'synthetic-confirmed-terminal','[\"OCR\"]')",[f.actor.accountId,requestId,f.seed.contextId,f.seed.projectId,f.pageId,tx.now]);
    await tx.client.query("INSERT INTO request_steps(account_id,request_id,logical_step_id,execution_generation,revision,ordinal) VALUES($1,$2,'OCR',0,0,0)",[f.actor.accountId,requestId]);
    await tx.client.query("INSERT INTO executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) VALUES($1,$2,$3,'OCR','synthetic-v1',repeat('b',64),'[]',0,'SUCCEEDED',0)",[f.actor.accountId,executionId,requestId]);
    await tx.client.query("UPDATE request_steps SET current_execution_id=$3 WHERE account_id=$1 AND request_id=$2 AND logical_step_id='OCR'",[f.actor.accountId,requestId,executionId]);
    await tx.client.query("INSERT INTO checkpoints(account_id,checkpoint_id,execution_id,stage_contract,dependency_digest,protected_manifest_ref,verification_state) VALUES($1,$2,$3,'synthetic-v1',repeat('b',64),'owned-manual-late-checkpoint','VERIFIED')",[f.actor.accountId,randomUUID(),executionId]);
    await tx.client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,1,$5,$2::uuid::text,'AI_APPLIED',$6)",[f.actor.accountId,lateResultId,f.seed.contextId,f.pageId,before.original_asset_id,JSON.stringify(before.edit_data)]);
    await tx.client.query("INSERT INTO result_applications(account_id,application_id,request_id,execution_id,result_id,context_id,page_lineage_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'NOT_APPLICABLE')",[f.actor.accountId,randomUUID(),requestId,executionId,lateResultId,f.seed.contextId,f.pageId]);
  });
  expect((await f.current()).result_revision).toBe('0');await f.edit({translatedText:'늦은 결과 뒤 수동 편집'});expect((await f.current()).result_revision).toBe('2');expect((await f.admin.pool.query('SELECT result_revision FROM manga_web.results ORDER BY result_revision')).rows.map(row=>row.result_revision)).toEqual(['0','1','2']);expect((await f.admin.pool.query('SELECT outcome FROM manga_web.result_applications WHERE result_id=$1',[lateResultId])).rows[0].outcome).toBe('NOT_APPLICABLE');await f.undoRedo('UNDO');expect((await f.current()).result_revision).toBe('3');
});

it('rejects trusted signed malformed render specifications and preserves optional legacy and EXACT below-minimum imports',async()=>{
  const f=await fixture();const keys=generateKeyPairSync('ed25519');const keyId=`manual-test-${randomUUID()}`;await f.admin.pool.query("INSERT INTO manga_web.signing_verifiers(key_id,algorithm,issuer,public_key,state,catalog_version) VALUES($1,'Ed25519','trio-manual-test',$2,'ISSUING','synthetic-v1')",[keyId,keys.publicKey.export({format:'der',type:'spki'}).subarray(-32)]);const signer=new ProjectSigner(f.api,'trio-manual-test',keyId,keys.privateKey);const font=f.fonts.catalog.fonts[0],license=f.fonts.catalog.license;const originalAsset=(await f.current()).original_asset_id;const image=await sharp({create:{width:100,height:100,channels:4,background:'white'}}).png().toBuffer();const bytes=new Map([[originalAsset,image],[font.id,f.fonts.bytes.get(font.id)!],[license.id,f.fonts.bytes.get(license.id)!]]);
  const asset=(id:string,purpose:ProjectManifest['assets'][number]['purpose'],mediaType:ProjectManifest['assets'][number]['mediaType']):ProjectManifest['assets'][number]=>({assetId:id,entry:`assets/${id}.bin`,purpose,mediaType,bytesLength:String(bytes.get(id)!.length),sha256:sha256(bytes.get(id)!),requiredFor:'EDIT'});
  const manifest:ProjectManifest={format:'trio.manga-project',schemaVersion:1,issuer:signer.issuer,keyId,algorithm:'Ed25519',exportId:randomUUID(),createdAt:new Date().toISOString(),creatorAccountId:f.actor.accountId,projectLineageId:f.seed.projectId,snapshotRevision:'0',projectStatus:'IN_PROGRESS',settings:null,pages:[{pageLineageId:f.pageId,originalAssetId:originalAsset,widthPx:100,heightPx:100,skip:false,resultRevision:'0',cleanedAssetId:null,renderAssetId:null,blocks:f.blocks,paidCumulativeBaselineCredit:'0',baselineContributionIds:[],geometryContract:f.data.geometryContract,renderContract:f.data.renderContract,cleanupQa:'NOT_RUN',displayName:'synthetic.png',paidCumulativeBaselineState:'CONFIRMED',renderSpecification:f.data.renderSpecification}],assets:[asset(originalAsset,'ORIGINAL','image/png'),asset(font.id,'FONT','font/otf'),asset(license.id,'LICENSE','text/plain')],unsettledReferences:[],optionalCheckpoints:[],fonts:[{fontAssetId:font.id,family:font.family,fontVersion:font.version,fontCatalogVersion:font.catalogVersion,licenseAssetId:font.licenseId}]};
  const valid=await encodeProject(manifest,bytes,signer,syntheticProfile);expect((await assessProject(valid,f.actor.accountId,signer,f.fonts,syntheticProfile)).manifest.pages[0].renderSpecification).toEqual(manifest.pages[0].renderSpecification);const entries=await readZip(valid,syntheticProfile);
  const signed=async(value:ProjectManifest)=>{const raw=Buffer.from(JSON.stringify(value));const changed=new Map(entries);changed.set('manifest.json',raw);changed.set('signature.json',Buffer.from(JSON.stringify(await signer.envelope(raw))));return writeZip(changed,syntheticProfile);};
  const corruptions:((value:ProjectManifest)=>void)[]=[
    value=>{value.pages[0].renderSpecification!.fontCatalogVersion='different-catalog';},
    value=>{value.pages[0].renderSpecification!.blocks[0].regionId=randomUUID();},
    value=>{value.pages[0].renderSpecification!.blocks[1].regionId=value.pages[0].renderSpecification!.blocks[0].regionId;},
    value=>{value.pages[0].renderSpecification!.blocks.pop();},
    value=>{value.pages[0].renderSpecification!.blocks.push({regionId:randomUUID(),minimumFontSizePx:12,sizing:'AUTO_FIT'});},
    value=>{value.pages[0].renderSpecification!.blocks[0].minimumFontSizePx=0;},
    value=>{value.pages[0].renderSpecification!.blocks[0].minimumFontSizePx=syntheticProfile.maxFontSize+1;},
    value=>{value.pages[0].renderSpecification!.blocks[0].minimumFontSizePx=25;},
    value=>{const spec=value.pages[0].renderSpecification!.blocks[0];spec.rendererVersion='pango-overflow-v2';spec.typesetBox={left:99,top:0,width:2,height:20};},
    value=>{const spec=value.pages[0].renderSpecification!.blocks[0];spec.rendererVersion='pango-overflow-v2';spec.typesetBox={left:0,top:99,width:20,height:2};},
    value=>{const spec=value.pages[0].renderSpecification!.blocks[0];spec.rendererVersion='pango-overflow-v2';spec.typesetBox={left:100,top:0,width:Number.MIN_VALUE,height:20};},
    value=>{value.pages[0].renderSpecification!.blocks[0].typesetBox={left:0,top:0,width:100,height:100};},
    value=>{value.pages[0].renderSpecification!.blocks[0].targetOrientation='HORIZONTAL';},
    value=>{const spec=value.pages[0].renderSpecification!.blocks[0];spec.rendererVersion='pango-canonical-v1';spec.targetOrientation='HORIZONTAL';},
    value=>{const spec=value.pages[0].renderSpecification!.blocks[0];spec.rendererVersion='pango-canonical-v1';spec.typesetBox={left:0,top:0,width:100,height:100};},
  ];
  for(const corrupt of corruptions){const bad=structuredClone(manifest);corrupt(bad);await expect(assessProject(await signed(bad),f.actor.accountId,signer,f.fonts,syntheticProfile)).rejects.toMatchObject({code:'FILE_INVALID'});}
  const boxed=structuredClone(manifest);boxed.pages[0].renderSpecification!.blocks[0].rendererVersion='pango-overflow-v2';boxed.pages[0].renderSpecification!.blocks[0].typesetBox={left:0,top:0,width:100,height:100};expect((await assessProject(await signed(boxed),f.actor.accountId,signer,f.fonts,syntheticProfile)).manifest.pages[0].renderSpecification).toEqual(boxed.pages[0].renderSpecification);
  const target=structuredClone(boxed);target.pages[0].blocks[0].geometry.orientation='VERTICAL';target.pages[0].renderSpecification!.blocks[0].targetOrientation='HORIZONTAL';expect((await assessProject(await signed(target),f.actor.accountId,signer,f.fonts,syntheticProfile)).manifest.pages[0]).toEqual(target.pages[0]);
  const legacy=structuredClone(manifest);delete legacy.pages[0].renderSpecification;expect((await assessProject(await signed(legacy),f.actor.accountId,signer,f.fonts,syntheticProfile)).manifest.pages[0].renderSpecification).toBeUndefined();
  const exact=structuredClone(manifest);exact.pages[0].blocks[0].fontSizePx=8;exact.pages[0].renderSpecification!.blocks[0].sizing='EXACT';expect((await assessProject(await signed(exact),f.actor.accountId,signer,f.fonts,syntheticProfile)).manifest.pages[0].blocks[0].fontSizePx).toBe(8);
},60000);

it.each([false,true])('preserves cleanup and confirmed text through manual direction Undo/Redo (legacy=%s)',async legacy=>{
  const f=await fixture(undefined,legacy),existing=structuredClone(f.data);
  existing.blocks[0].geometry.orientation='VERTICAL';
  existing.blocks[0].sourceText.status='USER_CONFIRMED';
  existing.blocks[0].translatedText.status='USER_CONFIRMED';
  existing.cleanupQa='NEEDS_REVIEW';
  const initial=await f.current();
  await f.admin.pool.query('UPDATE manga_web.results SET edit_data=$2,cleaned_asset_id=original_asset_id WHERE result_id=$1',[initial.result_id,JSON.stringify(existing)]);
  const before=await f.current();
  const beforeRender=existing.renderSpecification??{version:1,fontCatalogVersion:f.fonts.catalog.version,blocks:existing.blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT' as const}))};
  const expected=structuredClone(existing);
  expected.blocks[0].geometry.orientation='HORIZONTAL';
  expected.renderSpecification=structuredClone(beforeRender);
  expected.renderSpecification.blocks[0].rendererVersion='pango-overflow-v2';
  await f.edit({orientation:'HORIZONTAL'});
  const edited=await f.current();
  expect(edited.edit_data).toEqual(expected);
  expect(edited.original_asset_id).toBe(before.original_asset_id);
  expect(edited.cleaned_asset_id).toBe(before.cleaned_asset_id);
  expect(blockDependencies(before,before.edit_data.blocks[0])).not.toBe(blockDependencies(edited,edited.edit_data.blocks[0]));
  expect(edited.edit_data.blocks[1]).toEqual(before.edit_data.blocks[1]);
  expect((await f.history()).canUndo).toBe(true);
  await f.undoRedo('UNDO');
  const restored=await f.current();
  expect(restored.edit_data.blocks).toEqual(before.edit_data.blocks);
  expect(restored.edit_data.renderSpecification).toEqual(beforeRender);
  expect(restored.cleaned_asset_id).toBe(before.cleaned_asset_id);
  expect((await f.history()).canRedo).toBe(true);
  await f.undoRedo('REDO');
  expect((await f.current()).edit_data).toEqual(expected);
  expect((await f.current()).cleaned_asset_id).toBe(before.cleaned_asset_id);
  expect((await f.admin.pool.query('SELECT edit_data,cleaned_asset_id FROM manga_web.results WHERE result_id=$1',[before.result_id])).rows[0]).toEqual({edit_data:before.edit_data,cleaned_asset_id:before.cleaned_asset_id});
  const histories=(await f.admin.pool.query('SELECT protected_delta,validity FROM manga_web.manual_history ORDER BY sequence_no')).rows;
  expect(histories).toHaveLength(1);
  expect(histories[0]).toMatchObject({validity:'VALID',protected_delta:{before:before.edit_data.blocks[0],after:edited.edit_data.blocks[0]}});
  const work=(await f.admin.pool.query('SELECT kind,target_ref FROM manga_web.work_items ORDER BY due_at,work_item_id')).rows;
  expect(work).toHaveLength(3);
  expect(work.every(row=>row.kind==='STORE')).toBe(true);
  expect(new Set(work.map(row=>row.target_ref.resultId))).toEqual(new Set([edited.result_id,restored.result_id,(await f.current()).result_id]));
});

it.each([false,true])('preserves geometry, confirmed provenance and cleanup through typeset box set/clear/Undo/Redo (legacy=%s)',async legacy=>{
  const f=await fixture(undefined,legacy),existing=structuredClone(f.data),initial=await f.current(),box={left:0,top:0,width:90,height:70};
  existing.blocks[0].sourceText.status='USER_CONFIRMED';existing.blocks[0].translatedText.status='USER_CONFIRMED';
  existing.blocks[0].appliedTranslation={sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',modelContract:'synthetic-v1',promptContract:'owned-confirmed-v1',originExecutionId:randomUUID()};existing.cleanupQa='NEEDS_REVIEW';
  await f.admin.pool.query('UPDATE manga_web.results SET edit_data=$2,cleaned_asset_id=original_asset_id WHERE result_id=$1',[initial.result_id,JSON.stringify(existing)]);
  const before=await f.current();await f.edit({typesetBox:box});const boxed=await f.current();
  expect(boxed.edit_data.blocks).toEqual(before.edit_data.blocks);expect(boxed.edit_data.renderSpecification!.blocks[0]).toMatchObject({typesetBox:box,rendererVersion:'pango-overflow-v2',sizing:'AUTO_FIT'});expect(boxed.cleaned_asset_id).toBe(before.cleaned_asset_id);expect(boxed.original_asset_id).toBe(before.original_asset_id);
  expect(blockDependencies(before,before.edit_data.blocks[0])).not.toBe(blockDependencies(boxed,boxed.edit_data.blocks[0]));expect(boxed.edit_data.renderSpecification!.blocks[1]).not.toHaveProperty('typesetBox');
  await f.edit({typesetBox:null});const cleared=await f.current();expect(cleared.edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('typesetBox');expect(cleared.edit_data.blocks).toEqual(before.edit_data.blocks);
  await f.undoRedo('UNDO');expect((await f.current()).edit_data).toEqual(boxed.edit_data);await f.undoRedo('UNDO');expect((await f.current()).edit_data.blocks).toEqual(before.edit_data.blocks);expect((await f.current()).edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('rendererVersion');
  await f.undoRedo('REDO');expect((await f.current()).edit_data).toEqual(boxed.edit_data);await f.undoRedo('REDO');expect((await f.current()).edit_data).toEqual(cleared.edit_data);expect((await f.current()).cleaned_asset_id).toBe(before.cleaned_asset_id);
  expect((await f.admin.pool.query('SELECT edit_data,cleaned_asset_id FROM manga_web.results WHERE result_id=$1',[before.result_id])).rows[0]).toEqual({edit_data:before.edit_data,cleaned_asset_id:before.cleaned_asset_id});
  const histories=(await f.admin.pool.query('SELECT protected_delta,validity FROM manga_web.manual_history ORDER BY sequence_no')).rows;expect(histories).toHaveLength(2);expect(histories[0]).toMatchObject({validity:'VALID',protected_delta:{before:before.edit_data.blocks[0],after:before.edit_data.blocks[0],afterRender:{block:{typesetBox:box}}}});
  const work=(await f.admin.pool.query('SELECT kind,target_ref FROM manga_web.work_items')).rows;expect(work).toHaveLength(6);expect(work.every(row=>row.kind==='STORE')).toBe(true);
});


it.each([false,true])('captures target direction without changing source and preserves clear Undo/Redo with a box (legacy=%s)',async legacy=>{
  const f=await fixture(undefined,legacy),existing=structuredClone(f.data);existing.blocks[0].geometry.orientation='VERTICAL';existing.blocks[0].sourceText.status='USER_CONFIRMED';existing.blocks[0].translatedText.status='USER_CONFIRMED';await f.admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE page_lineage_id=$1',[f.pageId,JSON.stringify(existing)]);
  const before=await f.current(),box={left:0,top:0,width:90,height:80};await f.edit({targetOrientation:'HORIZONTAL',typesetBox:box});const horizontal=await f.current();expect(horizontal.edit_data.blocks).toEqual(before.edit_data.blocks);expect(horizontal.edit_data.renderSpecification!.blocks[0]).toMatchObject({targetOrientation:'HORIZONTAL',typesetBox:box,rendererVersion:'pango-overflow-v2'});expect(horizontal.original_asset_id).toBe(before.original_asset_id);expect(horizontal.cleaned_asset_id).toBe(before.cleaned_asset_id);
  await f.edit({targetOrientation:null});const cleared=await f.current();expect(cleared.edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');expect(cleared.edit_data.renderSpecification!.blocks[0].typesetBox).toEqual(box);expect(cleared.edit_data.blocks).toEqual(before.edit_data.blocks);
  await f.undoRedo('UNDO');expect((await f.current()).edit_data).toEqual(horizontal.edit_data);await f.undoRedo('REDO');expect((await f.current()).edit_data).toEqual(cleared.edit_data);
  await f.edit({targetOrientation:'VERTICAL'});expect((await f.current()).edit_data.renderSpecification!.blocks[0]).toHaveProperty('targetOrientation','VERTICAL');expect((await f.current()).edit_data.blocks).toEqual(before.edit_data.blocks);
  const histories=(await f.admin.pool.query('SELECT protected_delta,validity FROM manga_web.manual_history ORDER BY sequence_no')).rows;expect(histories[0]).toMatchObject({validity:'VALID',protected_delta:{before:before.edit_data.blocks[0],after:before.edit_data.blocks[0],afterRender:{block:{targetOrientation:'HORIZONTAL',typesetBox:box}}}});
});
