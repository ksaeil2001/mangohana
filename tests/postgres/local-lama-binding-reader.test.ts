import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {canonicalInput,SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import type {FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {PipelineEvidence,type PipelineStageCandidate} from '../../packages/domain/src/pipeline-evidence.js';
import {LocalLaMaBindingReader,type LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-reader.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
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
  const unchangedBusiness=async(before:Awaited<ReturnType<typeof evidence>>)=>{
    expect(await evidence()).toEqual(before);expect(provider.calls).toHaveLength(0);
    for(const table of ['free_starts','cost_items','settlements','ledger_entries','native_job_intents'])expect((await admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[seed.accountId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[seed.accountId])).rows).toEqual([{state:'HELD'}]);
    expect((await admin.pool.query('SELECT free_started_count FROM manga_web.accounts WHERE account_id=$1',[seed.accountId])).rows[0].free_started_count).toBe(0);
  };
  return {admin,api,worker,seed,input:input!,claim:claim!,firstClaim,provider,execution,bounds,basis,journal,candidate,image,mask,capture,source,reader,evidence,insert,unchangedBusiness};
}
const bindingHold={code:'LOCAL_LAMA_BINDING_UNCONFIRMED',nextAction:'WAIT'},dispatchHold={code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED',nextAction:'WAIT'};

describe.sequential('actual restricted original LaMa binding reader',()=>{
  it('reads normal preparation prefixes without creating original facts',async()=>{
    for(const prefix of ['INPUT','BASIS','CANDIDATE'] as const){const f=await fixture(prefix),before=await f.evidence();expect(await f.reader().readOriginal(f.input,f.capture)).toBeNull();await f.unchangedBusiness(before);}
  });
  it('joins exact original protected records and the current dispatch claim without granting a submit',async()=>{
    const f=await fixture(),before=await f.evidence(),expected={version:1,accountId:f.seed.accountId,requestId:f.input.requestId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),fullStageCaptureDigest:f.basis!.captureDigest,localCaptureDigest:f.capture.captureDigest,mode:'FREE'};
    expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(expected);expect(await f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).toEqual(expected);expect(expected.fullStageCaptureDigest).not.toBe(expected.localCaptureDigest);expect(f.basis!.capture.profileDigest).not.toBe(f.capture.profileDigest);expect(f.basis!.snapshot!.state).toBe('UNMEASURED');
    await expect(f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query("SELECT protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_SOURCE'",[f.seed.accountId,f.input.executionId]))).rejects.toMatchObject({code:'42501'});await f.unchangedBusiness(before);
  });
  it('rejects crossed owners, work items and expired claims while preserving original lookup',async()=>{
    const f=await fixture(),before=await f.evidence(),original=await f.reader().readOriginal(f.input,f.capture);
    for(const current of [{...f.firstClaim,ownerId:randomUUID()},{...f.firstClaim,workItemId:randomUUID()},{...f.firstClaim,generation:'2'}])await expect(f.reader().readForDispatch(f.input,f.capture,current)).rejects.toMatchObject(dispatchHold);
    await f.admin.pool.query('UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId,'x'.repeat(32768)]);
    const cappedOwner=await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT octet_length(claim_owner) AS bytes,CASE WHEN octet_length(claim_owner)<=36 THEN claim_owner ELSE NULL END AS claim_owner FROM work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId]),true);expect(cappedOwner.rows[0].bytes).toBe(32768);expect(cappedOwner.rows[0].claim_owner).toBeNull();await expect(f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).rejects.toMatchObject(dispatchHold);
    await f.admin.pool.query('UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId,f.firstClaim.ownerId]);
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);await expect(f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).rejects.toMatchObject(dispatchHold);expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(original);await f.unchangedBusiness(before);
  });
  it('keeps the first candidate generation when the current work and execution generation advance',async()=>{
    const f=await fixture(),before=await f.evidence(),original=await f.reader().readOriginal(f.input,f.capture);
    await f.admin.transaction(async client=>{await client.query('UPDATE manga_web.executions SET claim_generation=2 WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,f.input.executionId]);await client.query("UPDATE manga_web.work_items SET claim_generation=2,lease_until=clock_timestamp()+interval '2 minutes' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);});
    const input={...f.input,claimGeneration:'2'},current={...f.firstClaim,generation:'2'};expect(await f.reader().readOriginal(input,f.capture)).toEqual(original);expect(await f.reader().readForDispatch(input,f.capture,current)).toEqual(original);expect(f.candidate.claimGeneration).toBe('1');await f.unchangedBusiness(before);
  });
  it('preserves restricted and terminal original identity while rejecting dispatch',async()=>{
    const f=await fixture(),before=await f.evidence(),original=await f.reader().readOriginal(f.input,f.capture);
    await f.admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[f.seed.accountId]);expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(original);await expect(f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).rejects.toMatchObject(dispatchHold);
    await f.admin.pool.query("UPDATE manga_web.accounts SET access_state='ACTIVE' WHERE account_id=$1",[f.seed.accountId]);await f.admin.pool.query("UPDATE manga_web.processing_requests SET state='STOPPED',terminal_at=clock_timestamp(),terminal_evidence_ref='owned-binding-stop' WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,f.input.requestId]);
    expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(original);await expect(f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).rejects.toMatchObject(dispatchHold);await f.unchangedBusiness(before);
  });
  it('preserves closed context original identity without permitting further dispatch',async()=>{
    const f=await fixture(),before=await f.evidence(),original=await f.reader().readOriginal(f.input,f.capture);
    await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
    expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(original);await expect(f.reader().readForDispatch(f.input,f.capture,f.firstClaim)).rejects.toMatchObject(dispatchHold);await f.unchangedBusiness(before);
  });
  it('rejects other accounts and crossed original input or capture without returning another binding',async()=>{
    const f=await fixture(),before=await f.evidence(),other=await seedIdentity(f.admin);
    for(const input of [{...f.input,accountId:other.accountId},{...f.input,executionId:randomUUID()},{...f.input,width:f.input.width+1}])await expect(f.reader().readOriginal(input,f.capture)).rejects.toMatchObject(bindingHold);
    const {captureDigest:ignored,...body}=f.capture;void ignored;const changed={...body,maskSha256:sha256('crossed-original-mask')},capture={...changed,captureDigest:digest(changed)};await expect(f.reader().readOriginal(f.input,capture)).rejects.toMatchObject(bindingHold);await f.unchangedBusiness(before);
  });
  it('does not hide an orphan source when its candidate or basis is absent',async()=>{
    const noCandidate=await fixture('BASIS');await noCandidate.insert('OPERATIONAL_SOURCE',noCandidate.source);const first=await noCandidate.evidence();await expect(noCandidate.reader().readOriginal(noCandidate.input,noCandidate.capture)).rejects.toMatchObject(bindingHold);await noCandidate.unchangedBusiness(first);
    const noBasis=await fixture('INPUT');expect(await noBasis.execution.preflight(noBasis.claim,noBasis.input)).toBe(true);const candidate=(await noBasis.journal.candidate(noBasis.input)).candidate,source={...noBasis.source,candidate,value:{...noBasis.source.value,mask:{...noBasis.mask,assetId:candidate.maskAssetId!}}};await noBasis.journal.record(noBasis.input,'OPERATIONAL_SOURCE',source);const second=await noBasis.evidence();await expect(noBasis.reader().readOriginal(noBasis.input,noBasis.capture)).rejects.toMatchObject(bindingHold);await noBasis.unchangedBusiness(second);
  });
  it('validates malformed basis and trailing source before treating missing LAMA_INPUT as a normal prefix',async()=>{
    const malformed=await fixture('INPUT');await malformed.insert('OPERATIONAL_COST_BASIS',{version:1,captureDigest:sha256('owned-malformed-basis')});const first=await malformed.evidence();await expect(malformed.reader().readOriginal(malformed.input,malformed.capture)).rejects.toMatchObject(bindingHold);await malformed.unchangedBusiness(first);
    const trailing=await fixture('CANDIDATE');await trailing.journal.record(trailing.input,'OPERATIONAL_SOURCE',{version:1,candidate:trailing.candidate,phase:'LAMA_START',value:{evidenceId:randomUUID(),captureDigest:trailing.capture.captureDigest}});const second=await trailing.evidence();await expect(trailing.reader().readOriginal(trailing.input,trailing.capture)).rejects.toMatchObject(bindingHold);await trailing.unchangedBusiness(second);
  });
  it('preserves all conflicting LAMA_INPUT records and rejects the duplicate original selection',async()=>{
    const f=await fixture(),{captureDigest:ignored,...body}=f.capture;void ignored;const changed={...body,maskSha256:sha256('owned-second-mask')},capture={...changed,captureDigest:digest(changed)},source={...f.source,value:{capture,image:f.image,mask:{...f.mask,sha256:changed.maskSha256}}};await f.journal.record(f.input,'OPERATIONAL_SOURCE',source);const before=await f.evidence();expect(before.filter(row=>row.kind==='OPERATIONAL_SOURCE')).toHaveLength(2);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(bindingHold);await f.unchangedBusiness(before);
  });
  it('holds total row overflow instead of reading a truncated healthy history',async()=>{
    const f=await fixture(),bounds={...f.bounds,maxRecords:4};expect(await f.reader(bounds).readOriginal(f.input,f.capture)).not.toBeNull();
    await f.journal.record(f.input,'OPERATIONAL_SOURCE',{version:1,candidate:f.candidate,phase:'LAMA_START',value:{evidenceId:randomUUID(),captureDigest:f.capture.captureDigest}});const before=await f.evidence();expect(before).toHaveLength(5);await expect(f.reader(bounds).readOriginal(f.input,f.capture)).rejects.toMatchObject(bindingHold);await f.unchangedBusiness(before);
  });
  it('keeps oversized protected rows visible as NULL and holds the read without dropping them',async()=>{
    const f=await fixture(),maximum=32768,id=await f.insert('OPERATIONAL_SOURCE',{version:1,candidate:f.candidate,phase:'LAMA_OUTCOME',value:{ownedPayload:'x'.repeat(maximum)}}),before=await f.evidence();
    const capped=await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("SELECT octet_length(protected_observation::text) AS bytes,CASE WHEN octet_length(protected_observation::text)<=$3 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2",[f.seed.accountId,id,maximum]),true);expect(capped.rows).toHaveLength(1);expect(capped.rows[0].bytes).toBeGreaterThan(maximum);expect(capped.rows[0].protected_observation).toBeNull();
    const bounds={...f.bounds,maxRecordBytes:maximum,calculator:{...f.bounds.calculator,maxInputBytes:maximum,maxOutputBytes:maximum}};await expect(f.reader(bounds).readOriginal(f.input,f.capture)).rejects.toMatchObject(bindingHold);await f.unchangedBusiness(before);
  });
});
