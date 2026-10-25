import {randomUUID} from 'node:crypto';
import {CheckpointValidationJournal} from '../../packages/domain/src/checkpoint-validation.js';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {canonicalInput,SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {PipelineEvidence,type PipelineStageCandidate} from '../../packages/domain/src/pipeline-evidence.js';
import {LocalLaMaBindingReader,type LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-reader.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView} from '../../packages/domain/src/local-lama-attempt-journal.js';
import type {LocalLaMaOriginalInvocation} from '../../packages/providers/src/local-lama-executor.js';
import {NativeJobStore,nativeLogicalOperationKey} from '../../packages/domain/src/native-jobs.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Actual restricted SQL identity/claim checks; image, mask, runtime and rates
// are owned metadata fixtures. No bytes are fetched/decoded/PUT, and no native,
// provider, engine, public listener or operational activation runs here.
const databases:Database[]=[],fixturePools:Database[]=[];
let shared:{admin:Database;api:Database;worker:Database}|null=null;
async function closePools(pools:Database[]):Promise<void>{const failures:unknown[]=[];for(const db of pools.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_BINDING_DB_CLOSE_UNCONFIRMED');}
// Migrate/provision once in this owned test DB. Every fixture still creates a
// distinct account/context/request and owns a separate restricted worker pool.
// Register each pool immediately, including partial beforeAll failures.
beforeAll(async()=>{const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api');databases.push(api);const worker=await provisionLocalService(admin,'trio_web_worker');databases.push(worker);await api.validateServiceRole();await worker.validateServiceRole();shared={admin,api,worker};});
afterEach(async()=>{vi.restoreAllMocks();await closePools(fixturePools);});
afterAll(async()=>{const failures:unknown[]=[];for(const pools of [fixturePools,databases]){try{await closePools(pools);}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_BINDING_DB_CLOSE_UNCONFIRMED');});
type Prefix='INPUT'|'BASIS'|'CANDIDATE'|'SOURCE';
async function fixture(prefix:Prefix='SOURCE'){
  if(shared===null)throw new Error('OWNED_BINDING_DB_NOT_READY');const {admin,api}=shared,worker=new Database(shared.worker.connectionString,undefined,'trio_web_worker');fixturePools.push(worker);await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const policy={stageOrder:['CLEANUP'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:'owned-lama-binding-pg-v1'},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  const expected=(await admin.pool.query<{work_item_id:string;request_id:string}>("SELECT w.work_item_id,r.request_id FROM manga_web.work_items w JOIN manga_web.processing_requests r ON r.account_id=w.account_id AND r.request_id::text=w.target_ref->>'requestId' WHERE w.account_id=$1 AND r.context_id=$2 AND w.kind='DISPATCH'",[seed.accountId,seed.contextId])).rows;expect(expected).toHaveLength(1);
  // Restrict only candidate discovery to this fixture's exact work item. The
  // service's original restricted transaction/owner/generation/lease claim and
  // authorize checks still run. No candidates or rows are synthesized, and
  // older expired work in the shared DB cannot become this fixture's claim.
  const candidateQuery=worker.pool.query.bind(worker.pool),selection=vi.spyOn(worker.pool,'query').mockImplementation(((query:unknown)=>{expect(query).toBe('SELECT * FROM manga_web.dispatch_candidates()');return candidateQuery('SELECT * FROM manga_web.dispatch_candidates() WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,expected[0].work_item_id]);}) as typeof worker.pool.query);
  let claim:Awaited<ReturnType<ExecutionService['claim']>>;try{claim=await execution.claim();}finally{selection.mockRestore();}expect(claim).not.toBeNull();expect(claim).toMatchObject({accountId:seed.accountId,workId:expected[0].work_item_id,kind:'DISPATCH',ref:{requestId:expected[0].request_id}});const input=await execution.authorize(claim!);expect(input).not.toBeNull();expect(input).toMatchObject({accountId:seed.accountId,requestId:expected[0].request_id});
  const firstClaim={generation:claim!.generation,ownerId:execution.workerId,workItemId:claim!.workId};
  const bounds:LocalLaMaBindingReaderBounds={maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:2,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}};
  const profileDigest=sha256('owned-distinct-full-stage-binding-profile'),snapshot:FullStageCostSnapshot={version:1,state:'UNMEASURED',stage:'CLEANUP',profileDigest,basisVersion:'owned-unmeasured-binding-basis',usdScale:12,rounding:'HALF_UP',evidenceRefs:[],components:[]};
  const cost=new FullStageCostJournal(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,calculator:bounds.calculator});let basis:FullStageCostBasis|null=null;
  if(prefix!=='INPUT')basis=(await cost.prepare(input!,snapshot,profileDigest,firstClaim)).basis;
  const journal=new PipelineEvidence(worker,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords});
  let candidate:PipelineStageCandidate={version:1,executionId:input!.executionId,inputDigest:input!.inputDigest,inputFingerprint:digest(canonicalInput(input!)),stage:'CLEANUP',claimGeneration:firstClaim.generation,evidenceId:randomUUID(),maskAssetId:randomUUID(),cleanedAssetId:randomUUID(),renderAssetId:null};
  if(prefix==='CANDIDATE'||prefix==='SOURCE'){expect(await execution.preflight(claim!,input!)).toBe(true);candidate=(await journal.candidate(input!)).candidate;}
  const image=structuredClone(input!.assetDependencies!.find(item=>item.assetId===(input!.currentCleanedAssetId??input!.originalAssetId))!),mask={assetId:candidate.maskAssetId!,sha256:sha256('owned-mask-metadata'),bytesLength:'1',mediaType:'image/png'};
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId:input!.executionId,inputDigest:input!.inputDigest,profileId:input!.envelope!.parameterProfileVersion,profileDigest:sha256('owned-distinct-local-binding-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('owned-weights-metadata'),configSha256:sha256('owned-config-metadata'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:image.sha256,imageByteLength:Number(image.bytesLength),maskSha256:mask.sha256,maskByteLength:Number(mask.bytesLength)},capture:LocalLaMaCapture={...body,captureDigest:digest(body)};
  const source={version:1 as const,candidate,phase:'LAMA_INPUT' as const,value:{capture,image,mask}};
  if(prefix==='SOURCE')await journal.record(input!,'OPERATIONAL_SOURCE',source);
  const reader=(custom:LocalLaMaBindingReaderBounds=bounds)=>new LocalLaMaBindingReader(worker,custom);
  const evidence=async()=>(await admin.pool.query('SELECT evidence_id,kind,evidence_digest,protected_evidence_ref,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY kind,evidence_id',[seed.accountId,input!.executionId])).rows;
  const insert=async(kind:string,value:unknown,wrapped=true)=>{
    const id=randomUUID(),record=wrapped?{version:1,accountId:seed.accountId,executionId:input!.executionId,inputDigest:input!.inputDigest,inputFingerprint:digest(canonicalInput(input!)),kind,value}:value;
    await admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,clock_timestamp(),$6)',[seed.accountId,id,input!.executionId,kind,digest(record),JSON.stringify(record)]);return id;
  };
  const unchangedBusiness=async(before:Awaited<ReturnType<typeof evidence>>,expectedNativeIntents=0)=>{
    expect((await evidence()).filter(row=>!row.kind.startsWith('LAMA_ATTEMPT_'))).toEqual(before.filter(row=>!row.kind.startsWith('LAMA_ATTEMPT_')));expect(provider.calls).toHaveLength(0);
    for(const table of ['free_starts','cost_items','settlements','ledger_entries','native_job_go_consumptions','native_job_observations'])expect((await admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[seed.accountId])).rows[0].n).toBe(0);
    expect((await admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.native_job_intents WHERE account_id=$1',[seed.accountId])).rows[0].n).toBe(expectedNativeIntents);
    expect((await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[seed.accountId])).rows).toEqual([{state:'HELD'}]);
    expect((await admin.pool.query('SELECT free_started_count FROM manga_web.accounts WHERE account_id=$1',[seed.accountId])).rows[0].free_started_count).toBe(0);
  };
  return {admin,api,worker,seed,input:input!,claim:claim!,firstClaim,provider,execution,bounds,basis,journal,candidate,image,mask,capture,source,reader,attempts:(custom:LocalLaMaBindingReaderBounds=bounds)=>new LocalLaMaAttemptJournal(worker,custom),evidence,insert,unchangedBusiness};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function record<T extends object>(body:T):T&{recordDigest:string}{return {...body,recordDigest:digest(body)};}
const first=(f:Fixture,journal=f.attempts())=>journal.claim(f.input,f.capture,f.basis!.capture,f.firstClaim);
const lookup=(f:Fixture,journal=f.attempts())=>journal.lookup(f.input,f.capture,f.basis!.capture);
const append=(f:Fixture,view:LocalLaMaAttemptMetadataView,value:LocalLaMaAttemptMetadata,journal=f.attempts())=>journal.append(f.input,f.capture,f.basis!.capture,view.original,value);
function facts(f:Fixture,original:LocalLaMaOriginalInvocation){
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,profileDigest:f.capture.profileDigest,identityDigest:digest(f.capture.identity)},start={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime};
  const cost={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:f.capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.125',evidenceRef:'owned-pg-cost-claim',basisVersion:'owned-pg-full-stage-claim'};
  const reply={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256('owned-pg-metadata-only-proposal'),byteLength:16}};return {runtime,start,cost,reply};
}
const dispatchHold={code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED',nextAction:'WAIT'},legacyHold={code:'LOCAL_LAMA_ATTEMPT_LEGACY_UNCONFIRMED',nextAction:'WAIT'},uncertain={nextAction:'WAIT'};
async function anotherWorker(f:Fixture){const worker=new Database(f.worker.connectionString,undefined,'trio_web_worker');fixturePools.push(worker);await worker.validateServiceRole();return worker;}

describe.sequential('actual restricted metadata-only original LaMa journal',()=>{
  it('creates one original and one first ACK across two restricted concurrent transactions',async()=>{
    const f=await fixture(),before=await f.evidence(),second=await anotherWorker(f),other=new LocalLaMaAttemptJournal(second,f.bounds);
    const [a,b]=await Promise.all([first(f),first(f,other)]);expect([a.created,b.created].sort()).toEqual([false,true]);expect(a.original).toEqual(b.original);expect(a).toMatchObject({kind:'METADATA_ONLY',rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:'UNCONFIRMED'});expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);expect(await lookup(f,other)).toMatchObject({original:a.original,records:[]});await f.unchangedBusiness(before);
  });
  it('recovers the exact original in a new instance after a real commit loses its response ACK',async()=>{
    const f=await fixture(),before=await f.evidence(),original=f.worker.accountTransaction.bind(f.worker),lost=Error('OWNED_JOURNAL_ACK_LOST_AFTER_COMMIT');let once=true;
    const ack=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async(accountId,run,allowRestricted)=>{const value=await original(accountId,run,allowRestricted);if(once&&value&&typeof value==='object'&&'created'in value&&value.created===true){once=false;throw lost;}return value;});
    const journal=f.attempts();try{await expect(first(f,journal)).rejects.toBe(lost);}finally{ack.mockRestore();}
    expect(once).toBe(false);const evidence=(await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL');expect(evidence).toHaveLength(1);const recovered=await lookup(f);expect(recovered!.original).toEqual(evidence[0].protected_observation.value.original);expect(await first(f)).toEqual({...recovered!,created:false});expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toEqual(evidence);await f.unchangedBusiness(before);
  });
  it('rechecks changed owner, work generation and expired lease after an earlier successful reader transaction',async()=>{
    for(const change of ['owner','generation','lease'] as const){const f=await fixture(),before=await f.evidence();expect(await f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).not.toBeNull();
      if(change==='owner')await f.admin.pool.query('UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId,randomUUID()]);
      if(change==='generation')await f.admin.transaction(async client=>{await client.query('UPDATE manga_web.work_items SET claim_generation=2 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId]);await client.query('UPDATE manga_web.executions SET claim_generation=2 WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,f.input.executionId]);});
      if(change==='lease')await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
      await expect(first(f)).rejects.toMatchObject(dispatchHold);expect((await f.evidence()).filter(row=>row.kind.startsWith('LAMA_ATTEMPT_'))).toHaveLength(0);await f.unchangedBusiness(before);
    }
  });
  it('retains original/ordinal metadata through expired, restricted, terminal and closed-context lookups',async()=>{
    const f=await fixture(),before=await f.evidence(),claimed=await first(f),value=facts(f,claimed.original),view=await append(f,claimed,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply}));
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second',claim_owner=NULL WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);await f.admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[f.seed.accountId]);
    await f.admin.pool.query("UPDATE manga_web.processing_requests SET state='STOPPED',terminal_at=clock_timestamp(),terminal_evidence_ref='owned-journal-stop' WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.input.requestId]);
    await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
    expect(await lookup(f)).toEqual(view);expect(await first(f)).toEqual({...view,created:false});expect(view).toMatchObject({rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:'UNCONFIRMED'});expect(view.records[0].record).toMatchObject({reply:{state:'SUCCEEDED',providerSuccess:true,proposal:value.reply.proposal}});await f.unchangedBusiness(before);
  });
  it('preserves legacy LAMA, plan, output and START facts and holds instead of adopting an original',async()=>{
    for(const kind of ['LAMA_START','LAMA_OUTCOME','LAMA_RECONCILIATION','OPERATIONAL_PLAN','OPERATIONAL_OUTPUT','START','OTHER_ORIGINAL'] as const){const f=await fixture();
      if(kind.startsWith('LAMA_'))await f.journal.record(f.input,'OPERATIONAL_SOURCE',{version:1,candidate:f.candidate,phase:kind,value:kind==='LAMA_START'?{evidenceId:randomUUID(),captureDigest:f.capture.captureDigest}:{state:'UNKNOWN'}});
      else await f.insert(kind,{owned:'already-recorded-fact'});const before=await f.evidence();await expect(first(f)).rejects.toMatchObject(legacyHold);await expect(lookup(f)).rejects.toMatchObject(legacyHold);expect((await f.evidence()).filter(row=>row.kind.startsWith('LAMA_ATTEMPT_'))).toHaveLength(0);await f.unchangedBusiness(before);
    }
    const started=await fixture();await started.admin.pool.query('UPDATE manga_web.executions SET start_confirmed_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2',[started.seed.accountId,started.input.executionId]);const before=await started.evidence();await expect(first(started)).rejects.toMatchObject(legacyHold);await started.unchangedBusiness(before);
  });
  it('appends explicitly ordered immutable metadata with idempotent concurrent digest retries',async()=>{
    const f=await fixture(),before=await f.evidence(),claimed=await first(f),value=facts(f,claimed.original),start=record({version:1 as const,kind:'START' as const,fact:value.start}),worker=await anotherWorker(f),other=new LocalLaMaAttemptJournal(worker,f.bounds);
    const [a,b]=await Promise.all([append(f,claimed,start),append(f,claimed,start,other)]);expect(a).toEqual(b);expect(a.records).toHaveLength(1);const reply=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply}),cost=record({version:1 as const,kind:'FULL_COST' as const,evidence:{version:1 as const,bindingDigest:claimed.original.bindingDigest,fullStageCaptureDigest:f.basis!.capture.captureDigest,closureEvidenceRef:'owned-whole-stage-closure-claim',fullCost:value.cost}});
    await Promise.all([append(f,a,reply),append(f,a,cost,other)]);let view=(await lookup(f))!;expect(view.records.map(row=>row.ordinal)).toEqual([1,2,3]);expect(view.records[0].previousEnvelopeDigest).toBe(claimed.originalEnvelopeDigest);for(let at=1;at<view.records.length;at++)expect(view.records[at].previousEnvelopeDigest).toBe(view.records[at-1].envelopeDigest);expect(await append(f,view,reply)).toEqual(view);
    view=await append(f,view,record({version:1 as const,kind:'HOLD' as const,code:'OWNED_ORIGINAL_LIFETIME_UNCONFIRMED',relatedDigest:null}));expect(view.status).toBe('HOLD');expect((await lookup(f,other))!.holds).toContain('OWNED_ORIGINAL_LIFETIME_UNCONFIRMED');expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_METADATA')).toHaveLength(4);await f.unchangedBusiness(before);
  });
  it('holds an actual protected native intent without consuming GO or creating a journal original',async()=>{
    const f=await fixture(),before=await f.evidence();expect(await f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).not.toBeNull();
    const owner=(await f.admin.pool.query<{generation:string;owner_session_id:string;owner_tab_id:string;owner_revision:string;workspace_revision:string}>('SELECT generation::text,owner_session_id,owner_tab_id,owner_revision::text,workspace_revision::text FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId])).rows[0];
    const value={version:1 as const,jobId:randomUUID(),task:'POLYGON_MASK' as const,taskVersion:'native-pure-v1' as const,profileDigest:sha256('owned-intent-profile'),inputDigest:sha256('owned-intent-input'),operationInputDigest:sha256('owned-intent-operation'),parentInstanceId:randomUUID(),targetKind:'EXECUTION' as const,targetId:f.input.executionId,semanticCaptureDigest:sha256('owned-intent-semantic-capture'),protectedOwnerCapture:{contextId:f.seed.contextId,contextGeneration:owner.generation,ownerSessionId:owner.owner_session_id,ownerTabId:owner.owner_tab_id,ownerRevision:owner.owner_revision,workspaceRevision:owner.workspace_revision},claim:f.firstClaim};
    const intent={...value,logicalOperationKey:nativeLogicalOperationKey(value)};expect(await new NativeJobStore(f.worker,f.seed.accountId).beforeIntent(intent)).toMatchObject({allowed:true});
    const native=async()=>(await f.admin.pool.query('SELECT job_id,intent_digest,protected_intent FROM manga_web.native_job_intents WHERE account_id=$1',[f.seed.accountId])).rows,original=await native();expect(original).toHaveLength(1);expect(original[0].protected_intent).toEqual(intent);
    await expect(first(f)).rejects.toMatchObject(legacyHold);await expect(lookup(f)).rejects.toMatchObject(legacyHold);expect((await f.evidence()).filter(row=>row.kind.startsWith('LAMA_ATTEMPT_'))).toHaveLength(0);expect(await native()).toEqual(original);await f.unchangedBusiness(before,1);
  });
  it('retains conflicting same evidenceId engine observations and holds them across restarts',async()=>{
    const f=await fixture(),before=await f.evidence(),claimed=await first(f),value=facts(f,claimed.original),a=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply});let view=await append(f,claimed,a);
    const b=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...value.reply,state:'UNKNOWN' as const,providerSuccess:null,start:null,proposal:null}});view=await append(f,view,b);expect(view.records).toHaveLength(2);expect(view).toMatchObject({status:'HOLD',holds:expect.arrayContaining(['LOCAL_LAMA_ATTEMPT_ENGINE_EVIDENCE_CONFLICT'])});expect(await lookup(f)).toEqual(view);expect((await f.evidence()).filter(row=>row.kind==='LAMA_ATTEMPT_METADATA')).toHaveLength(2);await f.unchangedBusiness(before);
  });
  it('checks account/INPUT/two-capture ownership and forbids crossed original appends',async()=>{
    const f=await fixture(),before=await f.evidence(),other=await seedIdentity(f.admin);for(const input of [{...f.input,accountId:other.accountId},{...f.input,width:f.input.width+1}])await expect(f.attempts().claim(input,f.capture,f.basis!.capture,f.firstClaim)).rejects.toMatchObject(uncertain);
    const {captureDigest:_local,...local}=f.capture,changed={...local,maskSha256:sha256('crossed-mask')};await expect(f.attempts().claim(f.input,{...changed,captureDigest:digest(changed)},f.basis!.capture,f.firstClaim)).rejects.toMatchObject(uncertain);
    const {captureDigest:_whole,...whole}=f.basis!.capture,next={...whole,profileDigest:sha256('crossed-whole-stage')};await expect(f.attempts().claim(f.input,f.capture,new FullStageCostCalculator(null,f.bounds.calculator).capture(next),f.firstClaim)).rejects.toMatchObject(uncertain);
    const claimed=await first(f),hold=record({version:1 as const,kind:'HOLD' as const,code:'OWNED_HOLD',relatedDigest:null});await expect(f.attempts().append(f.input,f.capture,f.basis!.capture,{...claimed.original,invocationId:randomUUID()},hold)).rejects.toMatchObject(uncertain);await f.unchangedBusiness(before);
  });
  it('detects gap, fork, duplicate ordinal/record, wrong SHA/ref and wrapper without dropping original facts',async()=>{
    for(const scenario of ['gap','fork','ordinal','record','sha','ref','wrapper','orphan'] as const){const f=await fixture(),claimed=await first(f),hold=record({version:1 as const,kind:'HOLD' as const,code:'OWNED_CHAIN_HOLD',relatedDigest:null});const view=await append(f,claimed,hold),rows=(await f.evidence()).filter(row=>row.kind.startsWith('LAMA_ATTEMPT_')),old=rows.find(row=>row.kind==='LAMA_ATTEMPT_METADATA')!,body=structuredClone(old.protected_observation.value) as {ordinal:number;previousEnvelopeDigest:string;record:LocalLaMaAttemptMetadata};
      if(scenario==='gap')body.ordinal=3;if(scenario==='fork'){body.ordinal=2;body.previousEnvelopeDigest=sha256('crossed-predecessor');body.record=record({version:1 as const,kind:'HOLD' as const,code:'OTHER_HOLD',relatedDigest:null});}if(scenario==='ordinal')body.record=record({version:1 as const,kind:'HOLD' as const,code:'SECOND_ORDINAL_ONE',relatedDigest:null});if(scenario==='record'){body.ordinal=2;body.previousEnvelopeDigest=view.records[0].envelopeDigest;}
      if(['gap','fork','ordinal','record'].includes(scenario))await f.insert('LAMA_ATTEMPT_METADATA',body);
      if(scenario==='sha')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET evidence_digest=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,old.evidence_id,sha256('wrong-SHA')]);
      if(scenario==='ref')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_evidence_ref=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,old.evidence_id,randomUUID()]);
      if(scenario==='wrapper'){const crossed={...old.protected_observation,accountId:randomUUID()};await f.insert('LAMA_ATTEMPT_METADATA',crossed,false);}
      if(scenario==='orphan')await f.admin.pool.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND kind=$2',[f.seed.accountId,'LAMA_ATTEMPT_ORIGINAL']);const before=await f.evidence();await expect(lookup(f)).rejects.toMatchObject(uncertain);await expect(first(f)).rejects.toMatchObject(uncertain);expect(await f.evidence()).toEqual(before);await f.unchangedBusiness(before);
    }
  });
  it('rejects duplicate originals and oversized/NULL payload or ref at the bounded SQL boundary',async()=>{
    const duplicate=await fixture(),claimed=await first(duplicate),original=(await duplicate.evidence()).find(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')!;await duplicate.insert('LAMA_ATTEMPT_ORIGINAL',{...original.protected_observation.value,original:{...claimed.original,invocationId:randomUUID()}});const duplicateBefore=await duplicate.evidence();await expect(lookup(duplicate)).rejects.toMatchObject(uncertain);await duplicate.unchangedBusiness(duplicateBefore);
    for(const scenario of ['payload','ref','null'] as const){const f=await fixture();await first(f);const maximum=32768,id=await f.insert('LAMA_ATTEMPT_METADATA',scenario==='payload'?{ownedPayload:'x'.repeat(maximum)}:{owned:'invalid'});
      if(scenario==='ref')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_evidence_ref=$3 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,id,'x'.repeat(maximum)]);
      if(scenario==='null')await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=NULL WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,id]);const before=await f.evidence();
      const capped=await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT CASE WHEN octet_length(protected_observation::text)<=$3 THEN protected_observation ELSE NULL END AS protected_observation,CASE WHEN octet_length(protected_evidence_ref)<=36 THEN protected_evidence_ref ELSE NULL END AS protected_evidence_ref FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,id,maximum]),true);expect(scenario==='ref'?capped.rows[0].protected_evidence_ref:capped.rows[0].protected_observation).toBeNull();await expect(lookup(f,f.attempts({...f.bounds,maxRecordBytes:maximum}))).rejects.toMatchObject(uncertain);await f.unchangedBusiness(before);
    }
  });
  it('holds total LIMIT+1 overflow before an existing-original return and makes no append past capacity',async()=>{
    const f=await fixture(),claimed=await first(f),journal=f.attempts({...f.bounds,maxRecords:5}),before=await f.evidence();expect(await lookup(f,journal)).not.toBeNull();await expect(append(f,claimed,record({version:1 as const,kind:'HOLD' as const,code:'OWNED_LIMIT',relatedDigest:null}),journal)).rejects.toMatchObject({code:'LOCAL_LAMA_ATTEMPT_CAPACITY'});
    await f.insert('LAMA_ATTEMPT_METADATA',{version:1,ordinal:1,previousEnvelopeDigest:claimed.originalEnvelopeDigest,original:claimed.original,record:record({version:1 as const,kind:'HOLD' as const,code:'OWNED_OVERFLOW',relatedDigest:null})});const after=await f.evidence();expect(after).toHaveLength(6);await expect(lookup(f,journal)).rejects.toMatchObject(uncertain);await f.unchangedBusiness(before);
  });
  it('keeps API payload inaccessible, worker rows immutable and cross-account RLS effective',async()=>{
    const f=await fixture(),before=await f.evidence(),claimed=await first(f),row=(await f.evidence()).find(item=>item.kind==='LAMA_ATTEMPT_ORIGINAL')!,other=await seedIdentity(f.admin);
    await expect(f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]))).rejects.toMatchObject({code:'42501'});
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('UPDATE execution_evidence SET protected_observation=protected_observation WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]),true)).rejects.toMatchObject({code:'42501'});
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('DELETE FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]),true)).rejects.toMatchObject({code:'42501'});
    const hidden=await f.worker.accountTransaction(other.accountId,tx=>tx.client.query('SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,row.evidence_id]),true);expect(hidden.rows).toHaveLength(0);await expect(f.worker.accountTransaction(other.accountId,tx=>tx.client.query('INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)',[f.seed.accountId,randomUUID(),f.input.executionId,'LAMA_ATTEMPT_METADATA',sha256('owned-cross-account'),tx.now,'{}']),true)).rejects.toMatchObject({code:'42501'});expect((await lookup(f))!.original).toEqual(claimed.original);await f.unchangedBusiness(before);
  });
});

describe('C2 checkpoint validation exact-ID compatibility',()=>{
  it('permits completed empty PRE_DISPATCH evidence without accepting an unknown extra row',async()=>{
    const f=await fixture(),checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:f.bounds.maxRecordBytes,maxRecords:f.bounds.maxRecords,maxTargets:8,maxJobs:16});
    const view=await f.worker.accountTransaction(f.seed.accountId,async tx=>{const attempt=await checkpoints.beginIn(tx,f.input,'PRE_DISPATCH');expect(attempt.targets).toEqual([]);return checkpoints.recordIn(tx,f.input,attempt,{attemptId:attempt.attemptId,operations:[]});});expect(view.state).toBe('VERIFIED');
    const original=await first(f);expect(original.created).toBe(true);
    const other=await fixture();await other.insert('CHECKPOINT_VALIDATION_OPERATION',{version:1,attemptId:randomUUID(),operations:[]});await expect(first(other)).rejects.toMatchObject({nextAction:'WAIT'});
  });
});