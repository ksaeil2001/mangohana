import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Database} from '../../packages/storage/src/database.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {canonicalInput,SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostJournal} from '../../packages/domain/src/full-stage-cost-journal.js';
import type {FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalLaMaOriginalInvocation} from '../../packages/providers/src/local-lama-executor.js';
import {LocalLaMaRawStore,lamaRawAllocationKind,lamaRawReceiptKind,type LocalLaMaRawStoreBounds,type LocalLaMaRawReplyRef} from '../../packages/domain/src/local-lama-raw-store.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView} from '../../packages/domain/src/local-lama-attempt-journal.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeLimits} from '../../packages/native/src/dto.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import {LocalLaMaNativePreparation,lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind} from '../../packages/domain/src/local-lama-native-preparation.js';
import {Assets} from '../../packages/domain/src/assets.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Approval-dependent future bodies: actual restricted PG18/account locks and
// small actual FileObjectStore under owned OS Temp. Source descriptors/rates,
// START/replies/costs are controlled metadata. The prepared case also plans
// actual SYNTHETIC native children and memory preparation objects; LaMa,
// external providers and models stay absent. All bodies remain unexecuted.
const databases:Database[]=[],fixturePools:Database[]=[],roots:string[]=[];
const controllers:{controller:NativeController;root:string}[]=[];
let shared:{admin:Database;api:Database;worker:Database}|null=null;
async function closePools(pools:Database[]):Promise<void>{const failures:unknown[]=[];for(const db of pools.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'RAW_TEST_DB_CLOSE_UNCONFIRMED');}
beforeAll(async()=>{const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api');databases.push(api);const worker=await provisionLocalService(admin,'trio_web_worker');databases.push(worker);await api.validateServiceRole();await worker.validateServiceRole();shared={admin,api,worker};});
afterEach(async()=>{const failures:unknown[]=[],unconfirmedRoots=new Set<string>();for(const {controller,root}of controllers.splice(0)){controller.stopClaims();try{await controller.idle();}catch(error){failures.push(error);unconfirmedRoots.add(root);}}vi.restoreAllMocks();try{await closePools(fixturePools);}catch(error){failures.push(error);}for(const root of roots.splice(0)){if(unconfirmedRoots.has(root))continue;expect(path.dirname(root)).toBe(await realpath(tmpdir()));const stat=await lstat(root);expect(stat.isDirectory()&&!stat.isSymbolicLink()).toBe(true);expect(await realpath(root)).toBe(root);await rm(root,{recursive:true});}if(failures.length)throw new AggregateError(failures,'RAW_TEST_TEARDOWN_UNCONFIRMED');});
afterAll(async()=>{const failures:unknown[]=[];for(const pools of [fixturePools,databases]){try{await closePools(pools);}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'RAW_TEST_DB_CLOSE_UNCONFIRMED');});
const limits=():LocalLaMaRawStoreBounds=>({journal:{maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:2,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}},maxRawBytes:1024,maxInFlightMetadataBytes:512*1024*1024,maxInFlightRawBytes:64*1024,maxPublications:4,maxAllocations:4,maxPendingPuts:4,maxIo:4,maxMetadataCalls:4});
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const nativeLimits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:8,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:1048576};
async function fixture(withPreparation=false){
  if(!shared)throw Error('RAW_PG_NOT_READY');const {admin,api}=shared,worker=new Database(shared.worker.connectionString,undefined,'trio_web_worker');fixturePools.push(worker);await worker.validateServiceRole();
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'trio-lama-raw-pg-'));roots.push(root);
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const nativeSource=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),nativeBytes=new Map<string,Buffer>(),nativeReceipts=new Map<string,ObjectReceipt>();
  const objects:ObjectStore={bucket:'raw-prepared-memory',put:async(key,value)=>{const receipt:ObjectReceipt={key,sha256:sha256(value),bytesLength:String(value.length),completedAt:new Date().toISOString(),completedAtPrecisionMilliseconds:1};nativeBytes.set(key,Buffer.from(value));nativeReceipts.set(key,receipt);return receipt;},receipt:async key=>nativeReceipts.get(key)??null,read:async key=>{const value=nativeBytes.get(key);if(!value)throw Error('RAW_PREPARED_OBJECT_ABSENT');return Buffer.from(value);},remove:async()=>{throw Error('RAW_PREPARED_DELETE_FORBIDDEN');}};
  let preparation:LocalLaMaNativePreparation|undefined,gateway:NativeDatabaseGateway|undefined;
  if(withPreparation){
    const assetId=randomUUID(),resultId=randomUUID();await admin.accountTransaction(seed.accountId,async tx=>{
      await tx.client.query("INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,verified_at) VALUES($1,$2,'LIVE',$3,$4,$5,$6,'image/png','NOT_DUE',$7,$8,$8)",[seed.accountId,assetId,objects.bucket,seed.accountId+'/'+assetId,sha256(nativeSource),String(nativeSource.length),seed.contextId,now]);
      await tx.client.query("INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,1,$5,$2::uuid::text,'IMPORT_BASELINE',$6)",[seed.accountId,resultId,seed.contextId,seed.pageIds[0],assetId,JSON.stringify({blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'})]);
      await tx.client.query('UPDATE workspace_pages SET current_result_id=$4,result_revision=1,revision=revision+1,image_width=1,image_height=1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[seed.accountId,seed.contextId,seed.pageIds[0],resultId]);
      await tx.client.query('UPDATE workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId]);
    });nativeBytes.set(seed.accountId+'/'+assetId,Buffer.from(nativeSource));
    const nativeRoot=path.join(root,'native-child');await mkdir(nativeRoot);
    const controller=NativeController.owned({profile:syntheticProfile,limits:nativeLimits,directoryRoot:nativeRoot});controllers.push({controller,root});preparation=new LocalLaMaNativePreparation(worker,limits().journal,syntheticProfile,controller.kernelImplementationDigest);gateway=new NativeDatabaseGateway(worker,controller,objects,undefined,preparation);
  }
  const policy={stageOrder:['CLEANUP'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:withPreparation?syntheticProfile.id:'raw-pg-owned-v1'},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy,{},gateway),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},withPreparation?'1':'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:withPreparation?'1':'0',settingsVersion:'1'}},withPreparation?'2':'1'));
  const expected=(await admin.pool.query<{work_item_id:string;request_id:string}>("SELECT w.work_item_id,r.request_id FROM manga_web.work_items w JOIN manga_web.processing_requests r ON r.account_id=w.account_id AND r.request_id::text=w.target_ref->>'requestId' WHERE w.account_id=$1 AND r.context_id=$2 AND w.kind='DISPATCH'",[seed.accountId,seed.contextId])).rows;expect(expected).toHaveLength(1);
  const candidateQuery=worker.pool.query.bind(worker.pool),selection=vi.spyOn(worker.pool,'query').mockImplementation(((query:unknown)=>{expect(query).toBe('SELECT * FROM manga_web.dispatch_candidates()');return candidateQuery('SELECT * FROM manga_web.dispatch_candidates() WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,expected[0].work_item_id]);}) as typeof worker.pool.query);
  let claim:Awaited<ReturnType<ExecutionService['claim']>>;try{claim=await execution.claim();}finally{selection.mockRestore();}
  expect(claim).not.toBeNull();expect(claim).toMatchObject({accountId:seed.accountId,workId:expected[0].work_item_id,ref:{requestId:expected[0].request_id},kind:'DISPATCH'});
  const input=await execution.authorize(claim!);expect(input).not.toBeNull();const firstClaim={generation:claim!.generation,ownerId:execution.workerId,workItemId:claim!.workId},bounds=limits();
  const profileDigest=sha256('raw-whole-distinct-profile'),snapshot:FullStageCostSnapshot={version:1,state:'UNMEASURED',stage:'CLEANUP',profileDigest,basisVersion:'raw-pg-unmeasured',usdScale:12,rounding:'HALF_UP',evidenceRefs:[],components:[]};
  const basis=(await new FullStageCostJournal(worker,{maxRecordBytes:bounds.journal.maxRecordBytes,maxRecords:bounds.journal.maxRecords,calculator:bounds.journal.calculator}).prepare(input!,snapshot,profileDigest,firstClaim)).basis;
  if(withPreparation){const prepared=await preparation!.prepare(input!,firstClaim);expect(prepared.created).toBe(true);expect(prepared.capture).not.toBeNull();const decoded=await (await execution.nativeCallContext(claim!,input!,'INPUT'))!.native.decodeImage(nativeSource,syntheticProfile);expect(decoded.width).toBe(1);expect(decoded.height).toBe(1);}
  expect(await execution.preflight(claim!,input!)).toBe(true);const pipeline=new PipelineEvidence(worker,{maxRecordBytes:bounds.journal.maxRecordBytes,maxRecords:bounds.journal.maxRecords}),candidate=(await pipeline.candidate(input!)).candidate;
  const dispatchFacade=withPreparation?(await execution.nativeCallContext(claim!,input!,'DISPATCH'))!.native:undefined,nativeMask=dispatchFacade?await dispatchFacade.binaryPolygonMask([],1,1,syntheticProfile):undefined;
  const image=structuredClone(input!.assetDependencies!.find(item=>item.assetId===(input!.currentCleanedAssetId??input!.originalAssetId))!),mask={assetId:candidate.maskAssetId!,sha256:nativeMask?sha256(nativeMask.png):sha256('raw-pg-mask-metadata'),bytesLength:nativeMask?String(nativeMask.png.length):'1',mediaType:'image/png'};
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId:input!.executionId,inputDigest:input!.inputDigest,profileId:input!.envelope!.parameterProfileVersion,profileDigest:sha256('raw-local-distinct-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('raw-pg-weights-fixture'),configSha256:sha256('raw-pg-config-fixture'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:image.sha256,imageByteLength:Number(image.bytesLength),maskSha256:mask.sha256,maskByteLength:Number(mask.bytesLength)},capture:LocalLaMaCapture={...body,captureDigest:digest(body)};
  if(nativeMask)await new Assets(worker,objects).put(seed.accountId,mask.assetId,nativeMask.png,'LIVE','image/png',seed.contextId);
  else await worker.accountTransaction(seed.accountId,async tx=>{await tx.client.query("INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id) VALUES($1,$2,'LIVE','controlled-source',$1::uuid::text||'/'||$2::uuid::text,$3,$4,'image/png','NOT_DUE',$5)",[seed.accountId,mask.assetId,mask.sha256,mask.bytesLength,seed.contextId]);});
  await pipeline.record(input!,'OPERATIONAL_SOURCE',{version:1,candidate,phase:'LAMA_INPUT',value:{capture,image,mask}});
  if(dispatchFacade&&nativeMask){expect((await dispatchFacade.compositeMaskedPixels(nativeSource,nativeMask.png,nativeSource,syntheticProfile)).outsideChangedPixels).toBe(0);await gateway!.idle();}
  const evidence=async()=>(await admin.pool.query('SELECT evidence_id,kind,evidence_digest,protected_evidence_ref,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY kind,evidence_id',[seed.accountId,input!.executionId])).rows;
  const insert=async(kind:string,value:unknown)=>{
    const evidenceId=randomUUID(),wrapper={version:1,accountId:seed.accountId,executionId:input!.executionId,inputDigest:input!.inputDigest,inputFingerprint:digest(canonicalInput(input!)),kind,value};
    await admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,clock_timestamp(),$6)',[seed.accountId,evidenceId,input!.executionId,kind,digest(wrapper),JSON.stringify(wrapper)]);return evidenceId;
  };
  const business=async()=>{
    const counts:Record<string,number>={};for(const table of ['processing_requests','executions','result_applications','free_starts','cost_items','settlements','ledger_entries','native_job_intents','native_job_go_consumptions','native_job_observations'])counts[table]=(await admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[seed.accountId])).rows[0].n;
    return {counts,account:(await admin.pool.query('SELECT free_started_count,balance_credit FROM manga_web.accounts WHERE account_id=$1',[seed.accountId])).rows,free:(await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[seed.accountId])).rows,evidence:(await evidence()).filter(row=>!row.kind.startsWith('LAMA_ATTEMPT_'))};
  };
  const before=await business(),fault={kind:null as string|null,error:Error('RAW_REAL_COMMIT_ACK_LOST')},actualTransaction=worker.accountTransaction.bind(worker);
  vi.spyOn(worker,'accountTransaction').mockImplementation(async(accountId,run,restricted)=>{
    const result=await actualTransaction(accountId,run,restricted);
    if(fault.kind&&(await evidence()).some(row=>row.kind===fault.kind)){fault.kind=null;throw fault.error;}return result;
  });
  const bytes=Buffer.from('small raw PG candidate'),store=(overrides:Partial<LocalLaMaRawStoreBounds>={},db=worker)=>new LocalLaMaRawStore(db,root,{...bounds,...overrides},preparation);
  const unchanged=async(evidenceBaseline=before.evidence)=>{expect(await business()).toEqual({...before,evidence:evidenceBaseline});expect(provider.calls).toHaveLength(0);expect(before.counts).toMatchObject({free_starts:0,cost_items:0,settlements:0,ledger_entries:0,...(withPreparation?{native_job_intents:3,native_job_go_consumptions:3}:{native_job_intents:0,native_job_go_consumptions:0,native_job_observations:0}),result_applications:0});expect(before.account[0].free_started_count).toBe(0);expect(before.free).toEqual([{state:'HELD'}]);};
  return {admin,api,worker,seed,root,input:input!,firstClaim,capture,full:basis.capture,mask,image,bounds,bytes,fault,store,evidence,insert,unchanged,preparation,gateway,nativeBefore:before.counts};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function record<T extends object>(body:T):T&{recordDigest:string}{return {...body,recordDigest:digest(body)};}
function facts(f:Fixture,original:LocalLaMaOriginalInvocation){
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,profileDigest:f.capture.profileDigest,identityDigest:digest(f.capture.identity)},start={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime};
  const cost={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:f.capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.125',evidenceRef:'raw-fixture-cost',basisVersion:'raw-fixture-whole-cost'};
  const reply={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(f.bytes),byteLength:f.bytes.length}};return {runtime,start,cost,reply};
}
const prepare=(f:Fixture,store:LocalLaMaRawStore)=>store.prepareOriginal(f.input,f.capture,f.full,f.firstClaim);
const append=(f:Fixture,store:LocalLaMaRawStore,view:LocalLaMaAttemptMetadataView,value:LocalLaMaAttemptMetadata)=>store.appendMetadata(f.input,f.capture,f.full,view.original,value);
const restore=(f:Fixture,store:LocalLaMaRawStore,view:LocalLaMaAttemptMetadataView)=>store.restore(f.input,f.capture,f.full,view.original);
const replyRef=(view:LocalLaMaAttemptMetadataView):LocalLaMaRawReplyRef=>{const item=view.records.find(row=>row.record.kind==='ENGINE_REPLY')!;return {ordinal:item.ordinal,envelopeDigest:item.envelopeDigest,recordDigest:item.record.recordDigest};};
async function published(f:Fixture,store:LocalLaMaRawStore){
  const original=await prepare(f,store);expect(original.publication).not.toBeNull();const value=facts(f,original.metadata.original),view=await append(f,store,original.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply}));return {...original,publication:original.publication!,view,value,ref:replyRef(view)};
}
async function allocated(f:Fixture,store:LocalLaMaRawStore){const original=await published(f,store),allocation=await store.allocate(original.publication,original.ref);expect(allocation.put).not.toBeNull();return {...original,...allocation,put:allocation.put!};}
const waiting={nextAction:'WAIT'};
const rawRows=async(f:Fixture)=>(await f.evidence()).filter(row=>[lamaRawAllocationKind,lamaRawReceiptKind].includes(row.kind));

describe.sequential('restricted original raw allocation and same-key restoration',()=>{
  it('keeps actual prepared CAPTURE/PRECHECK/JOIN and ordered original facts across raw receipt, a new instance and rejection without preparation',async()=>{
    const f=await fixture(true);expect(f.preparation).toBeDefined();expect(f.gateway).toBeDefined();
    const kinds=[lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind],preparationRows=(await f.evidence()).filter(row=>kinds.includes(row.kind)).sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
    expect(preparationRows.filter(row=>row.kind===lamaPreparationCaptureKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
    for(const row of preparationRows.filter(row=>row.kind===lamaPreparationJoinKind))expect(row.protected_observation.value.sealed.termination).toMatchObject({goAttempted:true,startedComputation:true,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'});
    const store=f.store(),original=await prepare(f,store);expect(original.publication).not.toBeNull();
    const values=facts(f,original.metadata.original),startView=await append(f,store,original.metadata,record({version:1 as const,kind:'START' as const,fact:values.start})),view=await append(f,store,startView,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:values.reply}));
    expect(view.records.map(row=>row.record.kind)).toEqual(['START','ENGINE_REPLY']);
    const allocation=await store.allocate(original.publication!,replyRef(view));expect(allocation.put).not.toBeNull();
    const first={...original,...allocation,view,put:allocation.put!},orderedMetadata=structuredClone(view.records.map(row=>({ordinal:row.ordinal,previousEnvelopeDigest:row.previousEnvelopeDigest,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest})));
    expect(orderedMetadata.map(row=>row.ordinal)).toEqual([1,2]);expect(orderedMetadata[0].previousEnvelopeDigest).toBe(original.metadata.originalEnvelopeDigest);expect(orderedMetadata[1].previousEnvelopeDigest).toBe(orderedMetadata[0].envelopeDigest);
    const originalRows=(await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL'),saved=await store.put(first.put,f.bytes),next=f.store(),restored=await restore(f,next,first.view);
    const journal=new LocalLaMaAttemptJournal(f.worker,f.bounds.journal,f.preparation),read=await f.worker.accountTransaction(f.seed.accountId,tx=>journal.readOriginalIn(tx,f.input,f.capture,f.full,first.metadata.original),true);
    expect(restored).toEqual(saved);expect(restored.metadata.original).toEqual(first.metadata.original);expect(restored.metadata.originalEnvelopeDigest).toBe(first.metadata.originalEnvelopeDigest);expect(restored.metadata.records).toEqual(first.view.records);expect(read.metadata.records).toEqual(first.view.records);
    for(const metadata of [restored.metadata,read.metadata])expect(metadata.records.map(row=>({ordinal:row.ordinal,previousEnvelopeDigest:row.previousEnvelopeDigest,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest}))).toEqual(orderedMetadata);
    expect(read.rows.filter(row=>kinds.includes(row.kind)).sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id))).toEqual(preparationRows);expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toEqual(originalRows);expect(originalRows).toHaveLength(1);expect(await rawRows(f)).toHaveLength(2);
    expect(store.usage().putCalls).toBe(1);expect(next.usage().putCalls).toBe(0);expect((await prepare(f,next)).publication).toBeNull();
    const noPreparation=new LocalLaMaRawStore(f.worker,f.root,f.bounds),before=await f.evidence();await expect(restore(f,noPreparation,first.view)).rejects.toMatchObject(waiting);expect(noPreparation.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(await f.evidence()).toEqual(before);
    const noPreparationJournal=new LocalLaMaAttemptJournal(f.worker,f.bounds.journal);await expect(f.worker.accountTransaction(f.seed.accountId,tx=>noPreparationJournal.readOriginalIn(tx,f.input,f.capture,f.full,first.metadata.original),true)).rejects.toMatchObject(waiting);
    expect(f.nativeBefore).toMatchObject({native_job_intents:3,native_job_go_consumptions:3});await f.unchanged();f.gateway!.stopClaims();await f.gateway!.idle();
  });
  it('uses exactly one actual first creation ACK across concurrent restricted stores',async()=>{
    const f=await fixture(),first=f.store(),second=f.store(),[a,b]=await Promise.all([prepare(f,first),prepare(f,second)]);
    expect([a.publication===null,b.publication===null].sort()).toEqual([false,true]);expect(a.metadata.original).toEqual(b.metadata.original);
    const owner=a.publication?first:second,original=a.publication?a:b,value=facts(f,original.metadata.original),view=await append(f,owner,original.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply})),allocation=await owner.allocate(original.publication!,replyRef(view)),result=await owner.put(allocation.put!,f.bytes);
    const restored=await restore(f,f.store(),view);expect(restored).toEqual(result);expect(result).toMatchObject({kind:'RAW_CANDIDATE',restoration:'BYTES_VERIFIED',metadata:{kind:'METADATA_ONLY',status:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',rawRestoration:'UNCONFIRMED'}});expect(result.bytes).toEqual(f.bytes);
    expect(await rawRows(f)).toHaveLength(2);expect((await prepare(f,f.store())).publication).toBeNull();expect(owner.usage().putCalls).toBe(1);await f.unchanged();
  });
  it.each(['LAMA_ATTEMPT_ORIGINAL',lamaRawAllocationKind])('never reissues PUT authority after actual %s commit ACK loss',async kind=>{
    const f=await fixture(),store=f.store();let view:LocalLaMaAttemptMetadataView;
    if(kind==='LAMA_ATTEMPT_ORIGINAL'){f.fault.kind=kind;await expect(prepare(f,store)).rejects.toBe(f.fault.error);view=(await prepare(f,f.store())).metadata;}
    else{const original=await published(f,store);view=original.view;f.fault.kind=kind;await expect(store.allocate(original.publication,original.ref)).rejects.toBe(f.fault.error);}
    const before=await f.evidence(),next=f.store();expect((await prepare(f,next)).publication).toBeNull();await expect(restore(f,next,view)).rejects.toMatchObject(waiting);expect(await f.evidence()).toEqual(before);expect(next.usage().putCalls).toBe(0);expect(await readdir(f.root)).toEqual([]);await f.unchanged();
  });
  it('recovers the actual committed receipt/ref/time and preserves a non-null deadline without PUT',async()=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store);f.fault.kind=lamaRawReceiptKind;await expect(store.put(first.put,f.bytes)).rejects.toBe(f.fault.error);
    const before=await rawRows(f),saved=before.find(row=>row.kind===lamaRawReceiptKind)!.protected_observation.value.receipt;
    const deadline=(await f.admin.pool.query<{access_deadline:Date}>("UPDATE manga_web.assets SET access_deadline=clock_timestamp()+interval '1 hour',deletion_state='PENDING' WHERE account_id=$1 AND asset_id=$2 RETURNING access_deadline",[f.seed.accountId,first.allocation.assetId])).rows[0].access_deadline;
    const next=f.store(),result=await restore(f,next,first.view);expect(result.receipt).toEqual(saved);expect(result.bytes).toEqual(f.bytes);expect(await rawRows(f)).toEqual(before);expect(next.usage().putCalls).toBe(0);
    const row=(await f.admin.pool.query('SELECT object_created_at,access_deadline,deletion_state FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2',[f.seed.accountId,first.allocation.assetId])).rows[0];expect(row.object_created_at.toISOString()).toBe(saved.completedAt);expect(row.access_deadline).toEqual(deadline);expect(row.deletion_state).toBe('PENDING');await f.unchanged();
  });
  it('holds allocation behind the actual account row lock until its owner transaction commits',async()=>{
    const f=await fixture(),store=f.store(),first=await published(f,store),entered=deferred<void>(),release=deferred<void>();
    const locked=f.admin.transaction(async client=>{await client.query('SELECT account_id FROM manga_web.accounts WHERE account_id=$1 FOR UPDATE',[f.seed.accountId]);entered.resolve();await release.promise;});await entered.promise;
    let finished=false;const allocation=store.allocate(first.publication,first.ref).then(value=>{finished=true;return value;});
    try{
      const blocked=(await f.admin.pool.query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='trio-manga-web' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM accounts WHERE account_id=% FOR UPDATE') AS waiting")).rows[0].waiting;
      // Wait for the DB to report a lock, without replacing the transaction.
      if(!blocked)await vi.waitFor(async()=>{expect((await f.admin.pool.query<{n:number}>("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name='trio-manga-web' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM accounts WHERE account_id=% FOR UPDATE'")).rows[0].n).toBeGreaterThan(0);});
      expect(finished).toBe(false);expect(await rawRows(f)).toEqual([]);const held=store.usage();expect(held.allocations).toBe(1);expect(store.closePublication(first.publication)).toBe(false);expect(store.usage()).toEqual(held);
    }finally{release.resolve();await locked;}
    const committed=await allocation;expect(committed.put).not.toBeNull();expect(await rawRows(f)).toHaveLength(1);expect(store.closePut(committed.put!)).toBe(true);await f.unchanged();
  });
  it('preserves historical original facts through restricted/closed/lease transitions without new dispatch',async()=>{
    const f=await fixture(),store=f.store(),first=await published(f,store);
    await f.admin.transaction(async client=>{
      await client.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[f.seed.accountId]);
      await client.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second',claim_owner=NULL WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.firstClaim.workItemId]);
      await client.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
      await client.query("UPDATE manga_web.processing_requests SET state='STOPPED',terminal_at=clock_timestamp(),terminal_evidence_ref='raw-historical-stop' WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.input.requestId]);
    });
    const allocation=await store.allocate(first.publication,first.ref),result=await store.put(allocation.put!,f.bytes);expect((await restore(f,f.store(),first.view)).receipt).toEqual(result.receipt);expect((await prepare(f,f.store())).publication).toBeNull();expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);await f.unchanged();
    const fresh=await fixture();await fresh.admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[fresh.seed.accountId]);await expect(prepare(fresh,fresh.store())).rejects.toMatchObject({code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED'});expect(await rawRows(fresh)).toEqual([]);await fresh.unchanged();
  });
  it('retains immutable evidence permissions and cross-account RLS without granting payload access',async()=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store);await store.put(first.put,f.bytes);const row=(await rawRows(f))[0],before=await f.evidence(),other=await seedIdentity(f.admin);
    await expect(f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]))).rejects.toMatchObject({code:'42501'});
    for(const sql of ['UPDATE execution_evidence SET protected_observation=protected_observation WHERE account_id=$1 AND evidence_id=$2','DELETE FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2'])await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query(sql,[f.seed.accountId,row.evidence_id]),true)).rejects.toMatchObject({code:'42501'});
    expect((await f.worker.accountTransaction(other.accountId,tx=>tx.client.query('SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]),true)).rows).toEqual([]);
    await expect(f.worker.accountTransaction(other.accountId,tx=>tx.client.query('INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)',[f.seed.accountId,randomUUID(),f.input.executionId,lamaRawAllocationKind,sha256('crossed'),tx.now,'{}']),true)).rejects.toMatchObject({code:'42501'});
    expect(await f.evidence()).toEqual(before);await f.unchanged();
  });
  it.each(['source-deleted','source-expired','purpose','bucket','key','context','sha','length','microsecond-time','raw-deleted','raw-expired'] as const)('rejects actual %s scalar eligibility before GET',async scenario=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store),result=await store.put(first.put,f.bytes),asset=scenario.startsWith('source')?f.image.assetId:first.allocation.assetId;
    const updateValues:unknown[]=[f.seed.accountId,asset];
    if(scenario==='context'){const otherContextId=randomUUID(),otherProjectId=randomUUID();await f.admin.transaction(async client=>{
      await client.query('INSERT INTO manga_web.project_lineages(account_id,project_lineage_id) VALUES($1,$2)',[f.seed.accountId,otherProjectId]);
      await client.query("INSERT INTO manga_web.workspace_contexts(account_id,context_id,project_lineage_id,generation,lifecycle,owner_revision,workspace_revision,connection_generation,heartbeat_seq,project_status,closed_at,close_reason) VALUES($1,$2,$3,1,'CLOSED',0,0,0,0,'IN_PROGRESS',clock_timestamp(),'NORMAL_EXIT')",[f.seed.accountId,otherContextId,otherProjectId]);
    });updateValues.push(otherContextId);}
    const updates:Record<typeof scenario,string>={'source-deleted':"deletion_state='CONFIRMED'",'source-expired':"access_deadline=clock_timestamp()-interval '1 second'",purpose:"purpose='EXPORT'",bucket:"bucket_ref='other-local'",key:"object_key=account_id::text||'/'||gen_random_uuid()::text",context:'related_context_id=$3',sha:"sha256=repeat('b',64)",length:'bytes_length=bytes_length+1','microsecond-time':"object_created_at=object_created_at+interval '0.000001 second'",'raw-deleted':"deletion_state='CONFIRMED'",'raw-expired':"access_deadline=clock_timestamp()-interval '1 second'"};
    await f.admin.pool.query('UPDATE manga_web.assets SET '+updates[scenario]+' WHERE account_id=$1 AND asset_id=$2',updateValues);const before=await f.evidence(),next=f.store();
    await expect(restore(f,next,first.view)).rejects.toMatchObject(waiting);expect(next.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(await f.evidence()).toEqual(before);expect(await readFile(path.join(f.root,result.allocation.key))).toEqual(f.bytes);await f.unchanged();
  });
  it.each(['wrapper','ref','digest','duplicate','oversized','limit-plus-one','unverified-preparation'] as const)('holds protected %s rows and preserves the original allocation',async scenario=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store),row=(await rawRows(f))[0];
    if(scenario==='wrapper'){const wrapper={...row.protected_observation,accountId:randomUUID()};await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id,JSON.stringify(wrapper),digest(wrapper)]);}
    if(scenario==='ref')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_evidence_ref=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id,randomUUID()]);
    if(scenario==='digest')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET evidence_digest=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id,sha256('crossed-row')]);
    if(scenario==='duplicate')await f.insert(lamaRawAllocationKind,{...row.protected_observation.value,assetId:randomUUID()});
    if(scenario==='oversized'){const id=await f.insert('BOUNDED_EXTRA',{payload:'x'.repeat(65536)});expect((await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT CASE WHEN octet_length(protected_observation::text)<=65536 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,id]),true)).rows[0].protected_observation).toBeNull();}
    if(scenario==='unverified-preparation')await f.insert('LAMA_PREPARATION_CAPTURE',{unverified:true});
    const next=f.store(scenario==='limit-plus-one'?{journal:{...f.bounds.journal,maxRecords:6}}:{}),before=await f.evidence();await expect(restore(f,next,first.view)).rejects.toMatchObject(waiting);expect(await f.evidence()).toEqual(before);expect(next.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(store.closePut(first.put)).toBe(true);await f.unchanged(before.filter(row=>!row.kind.startsWith('LAMA_ATTEMPT_')));
  });
  it('allows the exact cost-only holds without asserting lifetime, cost closure or QA',async()=>{
    const f=await fixture(),store=f.store(),first=await prepare(f,store),values=facts(f,first.metadata.original);
    let view=await append(f,store,first.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...values.reply,fullCost:values.cost}}));
    view=await append(f,store,view,record({version:1 as const,kind:'HOLD' as const,code:'LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED',relatedDigest:values.cost.runtimeDigest}));
    const allocation=await store.allocate(first.publication!,replyRef(view)),result=await store.put(allocation.put!,f.bytes);expect(result.metadata).toEqual(view);expect(result.metadata).toMatchObject({status:'HOLD',originalLifetime:'UNCONFIRMED',rawRestoration:'UNCONFIRMED',holds:['LOCAL_LAMA_ATTEMPT_ENGINE_COST_UNCONFIRMED','LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED']});await f.unchanged();
    const next=await fixture(),owner=next.store(),original=await published(next,owner);await append(next,owner,original.view,record({version:1 as const,kind:'HOLD' as const,code:'UNKNOWN_COST_ALIAS',relatedDigest:null}));
    const before=await next.evidence();await expect(owner.allocate(original.publication,original.ref)).rejects.toMatchObject(waiting);expect(await next.evidence()).toEqual(before);expect(await rawRows(next)).toEqual([]);await next.unchanged();
  });
  it('preserves object/intent/key when metadata capacity is exhausted after the one PUT',async()=>{
    const f=await fixture(),bounds={...f.bounds.journal,maxRecords:8},store=f.store({journal:bounds}),first=await allocated(f,store);
    await append(f,store,first.view,record({version:1 as const,kind:'HOLD' as const,code:'LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED',relatedDigest:sha256('pending-whole-cost')}));expect(await f.evidence()).toHaveLength(8);
    await expect(store.put(first.put,f.bytes)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});const before=await f.evidence(),next=f.store({journal:bounds});await expect(restore(f,next,first.view)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});
    expect(await f.evidence()).toEqual(before);expect(await rawRows(f)).toHaveLength(1);expect(await readFile(path.join(f.root,first.allocation.key))).toEqual(f.bytes);expect((await readdir(path.join(f.root,f.seed.accountId))).sort()).toEqual([first.allocation.assetId,first.allocation.assetId+'.put-start.json',first.allocation.assetId+'.receipt.json'].sort());expect(next.usage().putCalls).toBe(0);await f.unchanged();
  });
});
