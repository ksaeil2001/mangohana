import {randomUUID,generateKeyPairSync} from 'node:crypto';
import type {NativeCapacityConfiguration,OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';
import {CheckpointValidationJournal,type CheckpointValidationOperation,type CheckpointValidationView} from '../../packages/domain/src/checkpoint-validation.js';
import {canonicalInput,normalizeObservation,type StageInput,type Observation} from '../../packages/domain/src/provider.js';
import type {NativeSealedReceipt} from '../../packages/domain/src/native-receipts.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Database,type Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeLimits} from '../../packages/native/src/dto.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {NativeDatabaseGateway,localLaMaPostCompositeResolver} from '../../packages/domain/src/native-gateway.js';
import {NativeReceiptStore} from '../../packages/domain/src/native-receipts.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import type {FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {Assets} from '../../packages/domain/src/assets.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import {LocalLaMaNativePreparation,lamaPreparationCaptureKind,lamaPreparationJoinKind,lamaPreparationPrecheckKind} from '../../packages/domain/src/local-lama-native-preparation.js';
import type {LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-verifier.js';
import {LocalLaMaAttemptJournal} from '../../packages/domain/src/local-lama-attempt-journal.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// PROPOSAL CANDIDATE: not executed before approval. Owned PNG/pure native child
// and actual restricted SQL/object receipt checks, never LaMa/model/provider.
// The fresh controlled asset/result below is installed before request capture;
// the original seeded result is preserved. It is not representative E2E output.
const pools:Database[]=[],fixtures:Database[]=[],controllers:NativeController[]=[],capacityCleanup:(()=>Promise<void>)[]=[];
let shared:{admin:Database;api:Database;worker:Database}|null=null;
async function closePools(values:Database[]):Promise<void>{const failures:unknown[]=[];for(const db of values.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_PREPARATION_DB_CLOSE_UNCONFIRMED');}
beforeAll(async()=>{const admin=await testDatabase();pools.push(admin);const api=await provisionLocalService(admin,'trio_web_api');pools.push(api);const worker=await provisionLocalService(admin,'trio_web_worker');pools.push(worker);await api.validateServiceRole();await worker.validateServiceRole();shared={admin,api,worker};});
afterEach(async()=>{const failures:unknown[]=[];for(const controller of controllers.splice(0)){controller.stopClaims();try{await controller.idle();}catch(error){failures.push(error);}}vi.restoreAllMocks();for(const restore of capacityCleanup.splice(0).reverse()){try{await restore();}catch(error){failures.push(error);}}try{await closePools(fixtures);}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'OWNED_PREPARATION_TEARDOWN_UNCONFIRMED');});
afterAll(async()=>{await closePools(pools);});
const bounds:LocalLaMaBindingReaderBounds={maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:2,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}};
const limits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:8,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:1048576};
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(loseJoinAcknowledgement=false,losePrecheckAcknowledgement=false,withPredecessor=false){
  if(!shared)throw new Error('OWNED_PREPARATION_DB_NOT_READY');const {admin,api}=shared,worker=new Database(shared.worker.connectionString,undefined,'trio_web_worker');fixtures.push(worker);await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now),bytes=png(),assetId=randomUUID(),resultId=randomUUID();
  await admin.accountTransaction(seed.accountId,async tx=>{
    await tx.client.query("INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,verified_at) VALUES($1,$2,'LIVE','owned-preparation',$3,$4,$5,'image/png','NOT_DUE',$6,$7,$7)",[seed.accountId,assetId,seed.accountId+'/'+assetId,sha256(bytes),String(bytes.length),seed.contextId,now]);
    await tx.client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,1,$5,$2::uuid::text,'IMPORT_BASELINE',$6)",[seed.accountId,resultId,seed.contextId,seed.pageIds[0],assetId,JSON.stringify({blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'})]);
    await tx.client.query('UPDATE workspace_pages SET current_result_id=$4,result_revision=1,revision=revision+1,image_width=1,image_height=1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[seed.accountId,seed.contextId,seed.pageIds[0],resultId]);
    await tx.client.query('UPDATE workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId]);
  });
  const objectBytes=new Map<string,Buffer>([[seed.accountId+'/'+assetId,Buffer.from(bytes)]]),objectReceipts=new Map<string,ObjectReceipt>();
  const objects:ObjectStore={bucket:'owned-preparation',put:async(key,value)=>{const receipt:ObjectReceipt={key,sha256:sha256(value),bytesLength:String(value.length),completedAt:new Date().toISOString(),completedAtPrecisionMilliseconds:1};objectBytes.set(key,Buffer.from(value));objectReceipts.set(key,receipt);return receipt;},receipt:async key=>objectReceipts.get(key)??null,read:async key=>{const value=objectBytes.get(key);if(!value)throw new Error('OWNED_PREPARATION_OBJECT_ABSENT');return Buffer.from(value);},remove:async()=>{throw new Error('OWNED_PREPARATION_DELETE_FORBIDDEN');}};
  let loseNextJoin=loseJoinAcknowledgement,loseNextPrecheck=losePrecheckAcknowledgement;
  if(loseJoinAcknowledgement||losePrecheckAcknowledgement){
    const transaction=worker.accountTransaction.bind(worker);
    vi.spyOn(worker,'accountTransaction').mockImplementation((async<T>(account:string,run:(tx:Transaction)=>Promise<T>,restricted=false)=>{
      let wroteJoin=false,wrotePrecheck=false;const value=await transaction(account,async tx=>{const query=tx.client.query.bind(tx.client),client={query:async(sql:string,values:unknown[]=[])=>{const result=await query(sql,values);if(sql.includes('INSERT INTO execution_evidence')){if(values[3]===lamaPreparationJoinKind)wroteJoin=true;if(values[3]===lamaPreparationPrecheckKind)wrotePrecheck=true;}return result;}};return run({...tx,client} as unknown as Transaction);},restricted);
      if(wroteJoin&&loseNextJoin){loseNextJoin=false;throw new Error('OWNED_JOIN_COMMIT_ACK_UNKNOWN');}
      if(wrotePrecheck&&loseNextPrecheck){loseNextPrecheck=false;throw new Error('OWNED_PRECHECK_COMMIT_ACK_UNKNOWN');}return value;
    }) as Database['accountTransaction']);
  }
  const directoryRoot=await mkdtemp(path.join(tmpdir(),'trio-lama-native-preparation-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot});controllers.push(controller);
  let capacity:NativeCapacityConfiguration|undefined;
  if(withPredecessor){
    const previous=(await admin.pool.query<{current_profile_id:string|null;state:string}>('SELECT current_profile_id,state FROM manga_web.native_capacity_authority WHERE singleton')).rows[0],key=generateKeyPairSync('ed25519');
    const profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'owned-c2-checkpoint-v1',maxSlots:32,nativeProfileDigest:digest(syntheticProfile),kernelDigest:controller.kernelImplementationDigest,controllerId:randomUUID(),keyVersion:'owned-c2-key-v1',environmentDigest:sha256('owned-c2-checkpoint'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:c2/checkpoint-source']},profileId=randomUUID();
    const inserted=(await admin.pool.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
    capacity={reference:{kind:'OWNED_FIXTURE',profileId,profileDigest:inserted.profile_digest,profileVersion:profile.version},profile};
    capacityCleanup.push(async()=>{await admin.pool.query('UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state=$2,revision=revision+1 WHERE singleton AND current_profile_id=$3',[previous.current_profile_id,previous.state,profileId]);});
    await admin.pool.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  }
  const preparation=new LocalLaMaNativePreparation(worker,bounds,syntheticProfile,controller.kernelImplementationDigest),gateway=new NativeDatabaseGateway(worker,controller,objects,capacity,preparation);
  const policy={stageOrder:withPredecessor?['OCR','CLEANUP']:['CLEANUP'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:syntheticProfile.id},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy,{},gateway),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'1'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'1',settingsVersion:'1'}},'2'));
  const work=(await admin.pool.query<{work_item_id:string}>("SELECT work_item_id FROM manga_web.work_items WHERE account_id=$1 AND kind='DISPATCH'",[seed.accountId])).rows;expect(work).toHaveLength(1);
  const originalQuery=worker.pool.query.bind(worker.pool),selection=vi.spyOn(worker.pool,'query').mockImplementation(((sql:unknown)=>{expect(sql).toBe('SELECT * FROM manga_web.dispatch_candidates()');return originalQuery('SELECT * FROM manga_web.dispatch_candidates() WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,work[0].work_item_id]);}) as typeof worker.pool.query);
  let claimed:Awaited<ReturnType<ExecutionService['claim']>>;try{claimed=await execution.claim();}finally{selection.mockRestore();}expect(claimed).not.toBeNull();let input=await execution.authorize(claimed!);expect(input).not.toBeNull();expect(input!.width).toBe(1);expect(input!.height).toBe(1);
  let predecessor:{input:StageInput;output:Observation;view:CheckpointValidationView}|null=null;
  if(withPredecessor){
    const original=input!,claim={generation:claimed!.generation,ownerId:execution.workerId,workItemId:claimed!.workId},profileDigest=sha256('owned-predecessor-cost');
    const costs=new FullStageCostJournal(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,calculator:bounds.calculator});
    await costs.prepare(original,{version:1,state:'UNMEASURED',stage:'OCR',profileDigest,basisVersion:'owned-predecessor',usdScale:12,rounding:'HALF_UP',evidenceRefs:[],components:[]},profileDigest,claim);
    const checkpoints=new CheckpointValidationJournal(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:8,maxJobs:16});
    const view=await worker.accountTransaction(seed.accountId,async tx=>{const attempt=await checkpoints.beginIn(tx,original,'PRE_DISPATCH');return checkpoints.recordIn(tx,original,attempt,{attemptId:attempt.attemptId,operations:[]});});expect(view.state).toBe('VERIFIED');
    await (await execution.nativeCallContext(claimed!,original,'INPUT'))!.native.decodeImage(bytes,syntheticProfile);
    expect(await execution.preflight(claimed!,original)).toBe(true);await execution.observe(seed.accountId,original.executionId,normalizeObservation(original,provider.success(original)),false,claimed!);
    const output=(await admin.pool.query<{output_envelope:Observation}>('SELECT output_envelope FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2',[seed.accountId,original.executionId])).rows;expect(output).toHaveLength(1);predecessor={input:original,output:output[0].output_envelope,view};
    await execution.finish(claimed!,false);
    const nextQuery=worker.pool.query.bind(worker.pool),nextSelection=vi.spyOn(worker.pool,'query').mockImplementation(((sql:unknown)=>{expect(sql).toBe('SELECT * FROM manga_web.dispatch_candidates()');return nextQuery('SELECT * FROM manga_web.dispatch_candidates() WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,work[0].work_item_id]);}) as typeof worker.pool.query);
    try{claimed=await execution.claim();}finally{nextSelection.mockRestore();}expect(claimed).not.toBeNull();
    input=await execution.authorize(claimed!);expect(input?.stage).toBe('CLEANUP');
  }
  const claim={generation:claimed!.generation,ownerId:execution.workerId,workItemId:claimed!.workId},profileDigest=sha256('owned-distinct-full-stage-preparation'),snapshot:FullStageCostSnapshot={version:1,state:'UNMEASURED',stage:'CLEANUP',profileDigest,basisVersion:'owned-preparation-unmeasured',usdScale:12,rounding:'HALF_UP',evidenceRefs:[],components:[]},cost=new FullStageCostJournal(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,calculator:bounds.calculator}),basis:FullStageCostBasis=(await cost.prepare(input!,snapshot,profileDigest,claim)).basis,evidence=new PipelineEvidence(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords});
  const prepared=await preparation.prepare(input!,claim);expect(prepared.created).toBe(true);expect(prepared.capture).not.toBeNull();
  const target=(phase:'INPUT'|'DISPATCH'):NativeTarget=>({accountId:seed.accountId,targetKind:'EXECUTION',targetId:input!.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,input!.requestId,input!),protectedOwnerCapture:prepared.capture!.value.originalOwner,claim,sourceInput:{executionId:input!.executionId,inputEvidenceId:prepared.capture!.value.input.evidenceId,stageInputDigest:input!.inputDigest}});
  const rows=async()=>(await admin.pool.query<{evidence_id:string;kind:string;evidence_digest:string;protected_observation:unknown}>('SELECT evidence_id,kind,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY received_at,evidence_id',[seed.accountId,input!.executionId])).rows;
  const counts=async()=>{const values:Record<string,number>={};for(const name of ['free_starts','cost_items','settlements','ledger_entries','native_job_intents','native_job_go_consumptions'])values[name]=(await admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${name} WHERE account_id=$1`,[seed.accountId])).rows[0].n;return values;};
  const business=async()=>({account:(await admin.pool.query('SELECT free_started_count,balance_credit,access_state FROM manga_web.accounts WHERE account_id=$1',[seed.accountId])).rows,reservations:(await admin.pool.query('SELECT request_id,state FROM manga_web.free_reservations WHERE account_id=$1 ORDER BY request_id',[seed.accountId])).rows,requests:(await admin.pool.query('SELECT request_id,captured_input,first_start_at FROM manga_web.processing_requests WHERE account_id=$1 ORDER BY request_id',[seed.accountId])).rows});
  const baselineBusiness=await business();
  const finishSource=async(mask:Buffer,pixelInsteadOfPng=false)=>{
    const candidate=(await evidence.candidate(input!)).candidate,image=input!.assetDependencies!.find(dep=>dep.assetId===input!.originalAssetId)!,maskBytes=pixelInsteadOfPng?Buffer.from([0]):mask,maskDependency={assetId:candidate.maskAssetId!,sha256:sha256(maskBytes),bytesLength:String(maskBytes.length),mediaType:'image/png'};
    const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId:input!.executionId,inputDigest:input!.inputDigest,profileId:syntheticProfile.id,profileDigest:sha256('owned-distinct-local-lama-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('no-model-owned-metadata'),configSha256:sha256('no-engine-owned-metadata'),weightsLicenseVerified:false,runtimeVerified:false},imageSha256:image.sha256,imageByteLength:Number(image.bytesLength),maskSha256:maskDependency.sha256,maskByteLength:Number(maskDependency.bytesLength)},local:LocalLaMaCapture={...body,captureDigest:digest(body)};
    if(!pixelInsteadOfPng)await new Assets(worker,objects).put(seed.accountId,candidate.maskAssetId!,mask,'LIVE','image/png',seed.contextId);
    await evidence.record(input!,'OPERATIONAL_SOURCE',{version:1,candidate,phase:'LAMA_INPUT',value:{capture:local,image,mask:maskDependency}});
    return {candidate,local,attempts:new LocalLaMaAttemptJournal(worker,bounds,preparation)};
  };
  return {admin,worker,seed,bytes,predecessor,input:input!,claimed:claimed!,claim,basis,provider,preparation,gateway,controller,objects,prepared,target,context:async(phase:'INPUT'|'DISPATCH')=>(await execution.nativeCallContext(claimed!,input!,phase))!.native,rows,counts,business,baselineBusiness,finishSource,execution};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function untouchedBusiness(f:Fixture):Promise<void>{
  expect(await f.business()).toEqual(f.baselineBusiness);expect(f.provider.calls).toHaveLength(0);const counts=await f.counts();for(const name of ['free_starts','cost_items','settlements','ledger_entries'])expect(counts[name]).toBe(0);
}

describe('proposal-only protected local LaMa native preparation journal',()=>{
  it('commits capture before first INPUT native and all three full-checked receipt JOINs and exact precheck before the first original, preserving cache jobs and historical claims',async()=>{
    const f=await fixture();const firstRows=await f.rows();expect(firstRows.map(row=>row.kind)).toEqual(['INPUT','OPERATIONAL_COST_BASIS',lamaPreparationCaptureKind]);expect((await f.preparation.prepare(f.input,f.claim)).capture).toEqual(f.prepared.capture);
    const decoded=await (await f.context('INPUT')).decodeImage(f.bytes,syntheticProfile);expect(decoded.width).toBe(1);expect(decoded.height).toBe(1);
    expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);
    const mask=await (await f.context('DISPATCH')).binaryPolygonMask([],1,1,syntheticProfile),source=await f.finishSource(mask.png);
    const dispatchFacade=await f.context('DISPATCH'),prechecked=await dispatchFacade.compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile);expect(prechecked.outsideChangedPixels).toBe(0);expect((await f.rows()).filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);
    const joined=(await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind);expect(joined).toHaveLength(3);
    const original=await source.attempts.claim(f.input,source.local,f.basis.capture,f.claim);expect(original.created).toBe(true);expect(original.original.localCaptureDigest).toBe(source.local.captureDigest);
    const proofBefore=structuredClone(joined),nativeBefore=await f.counts();
    const post=localLaMaPostCompositeResolver(dispatchFacade);expect(post).toBeTypeOf('function');const later=await (await post!())(f.bytes,mask.png,f.bytes,syntheticProfile);expect(later.outsideChangedPixels).toBe(0);
    expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toEqual(proofBefore);expect((await f.counts()).native_job_go_consumptions).toBe(nativeBefore.native_job_go_consumptions);
    const historical=await source.attempts.lookup({...f.input,claimGeneration:'999'},source.local,f.basis.capture);expect(historical?.original).toEqual(original.original);expect(historical?.originalEnvelopeDigest).toBe(original.originalEnvelopeDigest);
    const prepAfter=await f.preparation.lookup({...f.input,claimGeneration:'999'});expect(prepAfter.capture).toEqual(f.prepared.capture);await untouchedBusiness(f);
    const raw=(await f.admin.pool.query<{candidate_id:string;candidate_digest:string}>('SELECT candidate_id,candidate_digest FROM manga_web.native_result_candidates WHERE account_id=$1 ORDER BY candidate_id',[f.seed.accountId])).rows;expect(raw).toHaveLength(3);
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_candidate FROM native_result_candidates'))).rejects.toMatchObject({code:'42501'});
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_receipt FROM native_result_receipts'))).rejects.toMatchObject({code:'42501'});
  });
  it('does not derive JOIN authority from another facade completion or public seal/clone, then recovers that original verified computation without a new GO',async()=>{
    const f=await fixture(),facade=(await f.context('INPUT'));
    await expect(facade.semanticCache!.seal('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',f.bytes]]),{metadata:{},blobs:new Map()})).rejects.toMatchObject({code:'LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED'});expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(0);
    const ordinary=new NativeDatabaseGateway(f.worker,f.controller,f.objects);await ordinary.forTarget(f.target('INPUT')).decodeImage(f.bytes,syntheticProfile);expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(0);expect((await f.counts()).native_job_go_consumptions).toBe(1);
    // Raw lookup JSON and a directly invoked receipt seal remain read-only
    // facts for preparation: only the hidden full-checker path may append JOIN.
    const publicReceipt=new NativeReceiptStore(f.worker,f.objects,f.target('INPUT'),f.controller.kernelImplementationDigest,{input:f.controller.frameLimits('input'),output:f.controller.frameLimits('output')},()=>{throw new Error('DIRECT_RECEIPT_NATIVE_SOURCE_FORBIDDEN');});
    const metadata={profile:syntheticProfile,sourceBlobId:'source'},inputs=new Map([['source',f.bytes]]),read=await publicReceipt.read('DECODE_IMAGE',metadata,inputs);expect(read.state).toBe('VERIFIED');
    if(read.state!=='VERIFIED')throw new Error('EXPECTED_ORIGINAL_VERIFIED_RECEIPT');
    await publicReceipt.seal('DECODE_IMAGE',metadata,inputs,{metadata:read.result.metadata,blobs:read.blobs});const data=publicReceipt.sealedRecord('DECODE_IMAGE',metadata,inputs);expect(data.origin).toBe('CACHE');expect(data.intent.jobId).toBe(read.result.jobId);
    expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(0);expect((await f.counts()).native_job_go_consumptions).toBe(1);
    expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);const mask=await (await f.context('DISPATCH')).binaryPolygonMask([],1,1,syntheticProfile),source=await f.finishSource(mask.png);
    await expect(source.attempts.claim(f.input,source.local,f.basis.capture,f.claim)).rejects.toMatchObject({nextAction:'WAIT'});expect((await f.rows()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(0);
    const before=(await f.admin.pool.query('SELECT job_id,candidate_digest FROM manga_web.native_result_candidates WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows;
    await facade.withHooks(facade.hooks!).decodeImage(f.bytes,syntheticProfile);const after=(await f.admin.pool.query('SELECT job_id,candidate_digest FROM manga_web.native_result_candidates WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows;expect(after).toEqual(before);expect((await f.counts()).native_job_go_consumptions).toBe(2);
    await (await f.context('DISPATCH')).compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile);expect((await f.rows()).filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);
    expect((await source.attempts.claim(f.input,source.local,f.basis.capture,f.claim)).created).toBe(true);await untouchedBusiness(f);
  });
  it('retains a committed JOIN and original receipt after an unknown COMMIT ACK and retries only those facts with zero additional GO',async()=>{
    const f=await fixture(true),facade=(await f.context('INPUT'));await expect(facade.decodeImage(f.bytes,syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT',termination:{operationJoined:true,directChildClosed:true,kind:'DIRECT_CHILD_ONLY'}});
    const original=(await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind);expect(original).toHaveLength(1);expect((await f.counts()).native_job_go_consumptions).toBe(1);
    const before=(await f.admin.pool.query('SELECT job_id,candidate_id,candidate_digest FROM manga_web.native_result_candidates WHERE account_id=$1',[f.seed.accountId])).rows;
    const recovered=await facade.decodeImage(f.bytes,syntheticProfile);expect(recovered.width).toBe(1);expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toEqual(original);expect((await f.counts()).native_job_go_consumptions).toBe(1);
    expect((await f.admin.pool.query('SELECT job_id,candidate_id,candidate_digest FROM manga_web.native_result_candidates WHERE account_id=$1',[f.seed.accountId])).rows).toEqual(before);await untouchedBusiness(f);
  });
  it('keeps PNG and pixel descriptors distinct and refuses unexpected preparation tasks before GO',async()=>{
    const f=await fixture();await expect((await f.context('INPUT')).writeZip(new Map([['owned.bin',Buffer.from([1])]]),syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});expect((await f.counts()).native_job_go_consumptions).toBe(0);
    await (await f.context('INPUT')).decodeImage(f.bytes,syntheticProfile);expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);const mask=await (await f.context('DISPATCH')).binaryPolygonMask([],1,1,syntheticProfile);expect(mask.png.equals(mask.pixels)).toBe(false);
    const source=await f.finishSource(mask.png,true);await expect(source.attempts.claim(f.input,source.local,f.basis.capture,f.claim)).rejects.toMatchObject({nextAction:'WAIT'});
    expect((await f.rows()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(0);expect((await f.counts()).native_job_go_consumptions).toBe(2);await untouchedBusiness(f);
  });
});


describe('proposal-only PRECHECK acknowledgement and unexpected history preservation',()=>{
  it('recovers the exact committed precheck without a new original GO, then rejects an appended duplicate without erasing either immutable row',async()=>{
    const f=await fixture(false,true);await (await f.context('INPUT')).decodeImage(f.bytes,syntheticProfile);
    expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);
    const facade=await f.context('DISPATCH'),mask=await facade.binaryPolygonMask([],1,1,syntheticProfile),source=await f.finishSource(mask.png),before=await f.counts();
    await expect(facade.compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile)).rejects.toThrow('OWNED_PRECHECK_COMMIT_ACK_UNKNOWN');
    const original=(await f.rows()).filter(row=>row.kind===lamaPreparationPrecheckKind);expect(original).toHaveLength(1);
    expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(2);
    expect((await f.counts()).native_job_go_consumptions).toBe(before.native_job_go_consumptions);
    expect((await facade.compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile)).outsideChangedPixels).toBe(0);
    expect((await f.rows()).filter(row=>row.kind===lamaPreparationPrecheckKind)).toEqual(original);
    expect((await f.rows()).filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
    expect((await f.counts()).native_job_go_consumptions).toBe(before.native_job_go_consumptions+1);
    // A controlled append is not private writer authority. It preserves the
    // committed rows and proves that row existence or a known kind is insufficient.
    const wrapper=structuredClone(original[0].protected_observation) as {value:import('../../packages/domain/src/local-lama-native-preparation.js').LocalLaMaPreparationPrecheck};
    wrapper.value.precheckId=randomUUID();const {precheckDigest:_oldDigest,...body}=wrapper.value;wrapper.value.precheckDigest=digest(body);
    await f.worker.accountTransaction(f.seed.accountId,async tx=>{const id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)`,[f.seed.accountId,id,f.input.executionId,lamaPreparationPrecheckKind,digest(wrapper),tx.now,JSON.stringify(wrapper)]);},true);
    const retained=await f.rows();expect(retained.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(2);
    await expect(source.attempts.claim(f.input,source.local,f.basis.capture,f.claim)).rejects.toMatchObject({nextAction:'WAIT'});
    expect(await f.rows()).toEqual(retained);expect(retained.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(0);
    expect((await f.counts()).native_job_go_consumptions).toBe(before.native_job_go_consumptions+1);await untouchedBusiness(f);
  });
});

describe('C2 actual checkpoint native receipts at LaMa fences',()=>{
  it('allows completed empty current validation after preparation without weakening OWNED checks',async()=>{
    const f=await fixture(),checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:8,maxJobs:16});
    const view=await f.worker.accountTransaction(f.seed.accountId,async tx=>{const attempt=await checkpoints.beginIn(tx,f.input,'PRE_DISPATCH');return checkpoints.recordIn(tx,f.input,attempt,{attemptId:attempt.attemptId,operations:[]});});expect(view.state).toBe('VERIFIED');
    await (await f.context('INPUT')).decodeImage(f.bytes,syntheticProfile);expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);const mask=await (await f.context('DISPATCH')).binaryPolygonMask([],1,1,syntheticProfile),prepared=await f.finishSource(mask.png);await (await f.context('DISPATCH')).compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile);
    expect((await prepared.attempts.claim(f.input,prepared.local,f.basis.capture,f.claim)).created).toBe(true);
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_candidate FROM native_result_candidates'))).rejects.toMatchObject({code:'42501'});
  });

  it.each([false,true])('keeps original EXECUTION cache source and exact LaMa IDs; unknown facts=%s',async unknown=>{
    const f=await fixture(false,false,true),source=f.predecessor!,checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:8,maxJobs:16});
    expect(f.prepared.capture).not.toBeNull();expect((await f.rows()).map(r=>r.kind)).toEqual(['INPUT','OPERATIONAL_COST_BASIS',lamaPreparationCaptureKind]);
    const attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.beginIn(tx,f.input,'PRE_DISPATCH'));expect(attempt.targets).toHaveLength(1);
    const context=await f.execution.nativeCallContext(f.claimed,source.input,'CHECKPOINT',f.input.requestId,source.output);expect(context).toBeDefined();
    const beforeCache=await f.counts();await context!.native.decodeImage(f.bytes,syntheticProfile);expect((await f.counts()).native_job_go_consumptions).toBe(beforeCache.native_job_go_consumptions);
    const sealedRows=(await f.admin.pool.query<{candidate:NativeSealedReceipt['candidate'];receipt:NativeSealedReceipt['receipt'];intent:NativeSealedReceipt['intent'];termination:NativeSealedReceipt['termination']}>(`SELECT c.protected_candidate AS candidate,r.protected_receipt AS receipt,i.protected_intent AS intent,(t.protected_observation->'termination')-'isolation' AS termination FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.native_job_observations t ON t.account_id=i.account_id AND t.job_id=i.job_id AND t.event='TERMINATION' WHERE i.account_id=$1 AND i.target_kind='EXECUTION' AND i.target_id=$2`,[f.seed.accountId,source.input.executionId])).rows;expect(sealedRows).toHaveLength(1);
    // Owned trusted-reader fixture: these events follow the actual callback and
    // object read. Metadata-only or receipt-only records below remain WAIT.
    normalizeObservation(source.input,source.output);const bytes=await f.objects.read(f.seed.accountId+'/'+f.input.originalAssetId);
    const operation:CheckpointValidationOperation={version:1,operationId:randomUUID(),attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:'checkpoint-validation-v1',targetDigest:digest(attempt.targets[0]),sourceInputFingerprint:digest(canonicalInput(source.input)),outputDigest:digest(source.output),semantic:{eventId:randomUUID(),kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:[{eventId:randomUUID(),kind:'OBJECT_READ',assetId:f.input.originalAssetId,sha256:sha256(bytes),bytesLength:String(bytes.length),outcome:'RETURNED'}],native:[{...sealedRows[0],origin:'CACHE'}]};
    const append=async(value:CheckpointValidationOperation)=>f.worker.accountTransaction(f.seed.accountId,async tx=>{const evidenceId=randomUUID(),wrapper={version:1,accountId:f.seed.accountId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),kind:'CHECKPOINT_VALIDATION_OPERATION',value},evidenceDigest=digest(wrapper);await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)`,[f.seed.accountId,evidenceId,f.input.executionId,wrapper.kind,evidenceDigest,tx.now,JSON.stringify(wrapper)]);return {evidenceId,evidenceDigest};});
    if(unknown){
      for(const mode of ['storage','receipt','termination','source'] as const){
        const invalid=structuredClone(operation);invalid.operationId=randomUUID();invalid.semantic.eventId=randomUUID();invalid.storage.forEach(event=>{event.eventId=randomUUID();});
        if(mode==='storage')invalid.storage=[];
        if(mode==='receipt'){const candidateId=randomUUID();invalid.native[0].candidate.candidateId=candidateId;invalid.native[0].receipt.candidateId=candidateId;}
        if(mode==='termination')invalid.native[0].termination.directChildClosed=false;
        if(mode==='source')invalid.sourceInputFingerprint=sha256('unrelated-native-source');
        const missing=await append(invalid);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.recordIn(tx,f.input,attempt,{attemptId:attempt.attemptId,operations:[missing]}))).toMatchObject({state:'WAIT'});
      }
    }
    const actual=await append(operation),verified=await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.recordIn(tx,f.input,attempt,{attemptId:attempt.attemptId,operations:[actual]}));expect(verified.state).toBe('VERIFIED');expect(verified.jobIds).toEqual([sealedRows[0].intent.jobId]);
    const decoded=await (await f.context('INPUT')).decodeImage(f.bytes,syntheticProfile);expect(decoded.width).toBe(1);expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);const mask=await (await f.context('DISPATCH')).binaryPolygonMask((f.input.previousData??f.input.initialData).blocks.map(block=>block.geometry.polygon),1,1,syntheticProfile),prepared=await f.finishSource(mask.png);await (await f.context('DISPATCH')).compositeMaskedPixels(f.bytes,mask.png,f.bytes,syntheticProfile);
    // The unknown raw operation is deliberately retained. An exact-ID journal
    // must refuse that extra row rather than accepting every known kind.
    if(unknown)await expect(prepared.attempts.claim(f.input,prepared.local,f.basis.capture,f.claim)).rejects.toMatchObject({nextAction:'WAIT'});
    else expect((await prepared.attempts.claim(f.input,prepared.local,f.basis.capture,f.claim)).created).toBe(true);
  });
});
describe('C2 sealed final cost history over actual restricted PG',()=>{
  it('preserves sealed history after context/request closure and logical asset deletion while publication waits and performs no new I/O',async()=>{
    const f=await fixture(),j=new CheckpointValidationJournal(f.worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:8,maxJobs:16});expect(await f.execution.preflight(f.claimed,f.input)).toBe(true);await f.execution.observe(f.seed.accountId,f.input.executionId,normalizeObservation(f.input,f.provider.success(f.input)),false,f.claimed);
    const outputs=(await f.admin.pool.query<{output_envelope:Observation}>('SELECT output_envelope FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,f.input.executionId])).rows;expect(outputs).toHaveLength(1);const output=outputs[0].output_envelope,attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>j.beginIn(tx,f.input,'FINAL_COMMIT'));expect(attempt.targets).toHaveLength(1);
    normalizeObservation(f.input,output);const bytes=await f.objects.read(f.seed.accountId+'/'+f.input.originalAssetId),operation:CheckpointValidationOperation={version:1,operationId:randomUUID(),attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:'checkpoint-validation-v1',targetDigest:digest(attempt.targets[0]),sourceInputFingerprint:digest(canonicalInput(f.input)),outputDigest:digest(output),semantic:{eventId:randomUUID(),kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:[{eventId:randomUUID(),kind:'OBJECT_READ',assetId:f.input.originalAssetId,sha256:sha256(bytes),bytesLength:String(bytes.length),outcome:'RETURNED'}],native:[]};
    const view=await f.worker.accountTransaction(f.seed.accountId,async tx=>{const evidenceId=randomUUID(),wrapper={version:1,accountId:f.seed.accountId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),kind:'CHECKPOINT_VALIDATION_OPERATION',value:operation},evidenceDigest=digest(wrapper);await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)`,[f.seed.accountId,evidenceId,f.input.executionId,wrapper.kind,evidenceDigest,tx.now,JSON.stringify(wrapper)]);return j.recordIn(tx,f.input,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId,evidenceDigest}]});});expect(view.state).toBe('VERIFIED');
    const joined=(await f.rows()).filter(row=>view.evidenceIds.includes(row.evidence_id)).map(row=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}));expect(await f.worker.accountTransaction(f.seed.accountId,tx=>j.sealedFinalCostIn(tx,f.input,joined))).toBe('VERIFIED');
    await f.admin.accountTransaction(f.seed.accountId,async tx=>{await tx.client.query("UPDATE processing_requests SET state='COMPLETED',terminal_at=$3,terminal_evidence_ref='OWNED_C2_HISTORY_END',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.input.requestId,tx.now]);await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.input.contextId]);await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$3 WHERE account_id=$1 AND asset_id=$2",[f.seed.accountId,f.input.originalAssetId,new Date(tx.now.valueOf()-1000)]);});
    const read=vi.spyOn(f.objects,'read'),before=await f.counts();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>j.sealedFinalCostIn(tx,f.input,joined))).toBe('VERIFIED');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>j.finalCommitIn(tx,f.input))).toBe('WAIT');expect(read).not.toHaveBeenCalled();expect(await f.counts()).toEqual(before);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>j.sealedFinalCostIn(tx,f.input,joined.slice(1)))).toBe('WAIT');const crossed=structuredClone(joined);crossed[0].evidenceDigest=sha256('crossed-history-ref');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>j.sealedFinalCostIn(tx,f.input,crossed))).toBe('WAIT');
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('UPDATE execution_evidence SET evidence_digest=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,joined[0].evidenceId,sha256('forbidden-mutation')]))).rejects.toMatchObject({code:'42501'});
  });
});