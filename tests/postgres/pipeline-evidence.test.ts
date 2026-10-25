import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import {digest} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Actual restricted LOGIN/PG records, fake workspace asset catalog only. This
// journal case starts no provider, native computation, storage PUT or service.
const databases:Database[]=[];
afterEach(async()=>{const failures:unknown[]=[];for(const db of databases.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_PIPELINE_DB_CLOSE_UNCONFIRMED');});
async function fixture(stage='OCR'){
  const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');databases.push(api,worker);await api.validateServiceRole();await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const policy={stageOrder:[stage],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:'owned-pipeline-journal-pg-v1'},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy);
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  const claim=await execution.claim();expect(claim).not.toBeNull();const input=await execution.authorize(claim!);expect(input).not.toBeNull();expect(await execution.preflight(claim!,input!)).toBe(true);
  const bounds={maxRecordBytes:65536,maxRecords:2},journal=()=>new PipelineEvidence(worker,bounds);
  const records=async(kind:string)=>(await admin.pool.query<{evidence_id:string;evidence_digest:string;protected_observation:Record<string,unknown>}>('SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY evidence_id',[seed.accountId,input!.executionId,kind])).rows;
  return {admin,api,worker,seed,provider,execution,claim:claim!,input:input!,bounds,journal,records};
}

describe('actual restricted worker original pipeline evidence journal',()=>{
  it('looks up missing and original candidates after expiry without preparing or changing original dispatch authority',async()=>{
    const f=await fixture();expect(await f.journal().existingCandidate(f.input)).toBeNull();expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual([]);
    const original=await f.journal().candidate(f.input);await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
    expect(await f.journal().existingCandidate({...f.input,claimGeneration:'99'})).toEqual(original.candidate);expect(await f.records('OPERATIONAL_CANDIDATE')).toHaveLength(1);expect(f.provider.calls).toHaveLength(0);expect(await f.records('START')).toEqual([]);
    process.stdout.write(JSON.stringify({scope:'owned-pipeline-readonly-pg',stage:'MISSING_LOOKUP_NO_PREPARATION_EXPIRED_ORIGINAL_RETAINED'})+'\n');
  });
  it('keeps committed candidate ACK loss and concurrent claims query only without START or a second candidate',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-pipeline-journal-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');const f=await fixture();trace('ORIGINAL_DISPATCH_READY');
    const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false;
    const loseCreated:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,allowRestricted=false):Promise<T>=>{
      const value=await transaction(accountId,run,allowRestricted);if(!lost&&value!==null&&typeof value==='object'&&'created'in value&&value.created===true){lost=true;throw new Error('OWNED_PIPELINE_COMMIT_ACK_LOST');}return value;
    };
    const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(loseCreated);
    let results:PromiseSettledResult<Awaited<ReturnType<PipelineEvidence['candidate']>>>[];
    try{results=await Promise.allSettled([f.journal().candidate(f.input),f.journal().candidate(f.input)]);}finally{spy.mockRestore();}
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(lost).toBe(true);
    const surviving=results.find(result=>result.status==='fulfilled');expect(surviving?.status==='fulfilled'&&surviving.value.created).toBe(false);
    const original=await f.records('OPERATIONAL_CANDIDATE');expect(original).toHaveLength(1);expect(original[0].evidence_digest).toBe(digest(original[0].protected_observation));
    const next=await f.journal().candidate({...f.input,claimGeneration:'2'});expect(next.created).toBe(false);expect(next.candidate).toEqual(original[0].protected_observation.value);expect(next.candidate.claimGeneration).toBe(f.claim.generation);trace('ORIGINAL_CANDIDATE_RECOVERED');
    const source={started:null,costUsd:null,usageConfirmed:false,providerSuccess:false};await f.journal().record(f.input,'OPERATIONAL_SOURCE',source);await f.journal().record({...f.input,claimGeneration:'3'},'OPERATIONAL_SOURCE',source);
    expect(await f.journal().records(f.input,'OPERATIONAL_SOURCE')).toEqual([source]);expect(await f.records('OPERATIONAL_SOURCE')).toHaveLength(1);
    const changed={...structuredClone(f.input),width:f.input.width+1};await expect(f.journal().candidate(changed)).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual(original);
    await expect(f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE execution_id=$1',[f.input.executionId]))).rejects.toMatchObject({code:'42501'});
    const other=await seedIdentity(f.admin,(await f.admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now);await expect(f.journal().candidate({...f.input,accountId:other.accountId})).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});
    expect(f.provider.calls).toHaveLength(0);expect((await f.admin.pool.query<{n:number}>('SELECT count(*)::integer AS n FROM manga_web.free_starts WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(0);
    expect((await f.admin.pool.query<{state:string}>('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{state:'HELD'}]);
    expect(await f.records('START')).toEqual([]);expect(await f.records('OUTCOME')).toEqual([]);trace('NO_START_COST_OR_NEW_EXECUTION_AUTHORITY');
  });
  it('rejects an expired first claim and conflicting original evidence while preserving every record',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-pipeline-conflict-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');const f=await fixture();trace('ORIGINAL_DISPATCH_READY');
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
    await expect(f.journal().candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual([]);
    // Only the owned fixture operator restores its original lease for testing;
    // the journal neither renews nor invents a new claim generation/authority.
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()+interval '30 seconds' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
    await f.journal().candidate(f.input);await f.journal().record(f.input,'OPERATIONAL_SOURCE',{revision:0,costUsd:null});await f.journal().record(f.input,'OPERATIONAL_SOURCE',{revision:1,costUsd:null});const sources=await f.records('OPERATIONAL_SOURCE');
    await expect(f.journal().record(f.input,'OPERATIONAL_SOURCE',{revision:2,costUsd:null})).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});expect(await f.records('OPERATIONAL_SOURCE')).toEqual(sources);
    const first=(await f.records('OPERATIONAL_CANDIDATE'))[0],conflicting=structuredClone(first.protected_observation);(conflicting.value as Record<string,unknown>).evidenceId=randomUUID();const id=randomUUID();
    await f.admin.pool.query(`INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation)
      VALUES($1,$2,$3,'OPERATIONAL_CANDIDATE',$4,$2::uuid::text,$5)`,[f.seed.accountId,id,f.input.executionId,digest(conflicting),JSON.stringify(conflicting)]);
    const before=await f.records('OPERATIONAL_CANDIDATE');expect(before).toHaveLength(2);await expect(f.journal().candidate({...f.input,claimGeneration:'4'})).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual(before);
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('DELETE FROM execution_evidence WHERE execution_id=$1',[f.input.executionId]))).rejects.toMatchObject({code:'42501'});
    expect(f.provider.calls).toHaveLength(0);expect(await f.records('OPERATIONAL_OUTPUT')).toEqual([]);trace('EXPIRED_AND_CONFLICTING_FACTS_PRESERVED');
  });
});

it('separates outer OCR and raw OCR candidates and source records without consuming the inner claim',async()=>{
  const f=await fixture(),outer=new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1'),raw=new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1');
  const first=await outer.candidate(f.input),second=await raw.candidate(f.input);
  expect(first.created).toBe(true);expect(second.created).toBe(true);expect(second.candidate.evidenceId).not.toBe(first.candidate.evidenceId);
  await outer.record(f.input,'OPERATIONAL_SOURCE',{phase:'PROVIDER',owner:'outer'});
  await raw.record(f.input,'OPERATIONAL_SOURCE',{phase:'CAPTURE',owner:'ocr'});
  expect(await outer.records(f.input,'OPERATIONAL_SOURCE')).toEqual([{phase:'PROVIDER',owner:'outer'}]);
  expect(await raw.records(f.input,'OPERATIONAL_SOURCE')).toEqual([{phase:'CAPTURE',owner:'ocr'}]);
  for(const kind of ['P01C_PIPELINE_V1_CANDIDATE','LOCAL_OCR_V1_CANDIDATE','P01C_PIPELINE_V1_SOURCE','LOCAL_OCR_V1_SOURCE'])expect(await f.records(kind)).toHaveLength(1);
  expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual([]);expect(await f.records('START')).toEqual([]);
});
it('legacy_candidate_blocks_new_namespace_dispatch and preserves historical bytes',async()=>{
  const f=await fixture();await f.journal().candidate(f.input);await f.journal().record(f.input,'OPERATIONAL_SOURCE',{historical:true,costUsd:null});
  const before={candidate:await f.records('OPERATIONAL_CANDIDATE'),source:await f.records('OPERATIONAL_SOURCE')};
  for(const owner of ['PIPELINE_V1','LOCAL_OCR_V1'] as const)await expect(new PipelineEvidence(f.worker,f.bounds,owner).candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  expect(await f.journal().records(f.input,'OPERATIONAL_SOURCE')).toEqual([{historical:true,costUsd:null}]);
  expect({candidate:await f.records('OPERATIONAL_CANDIDATE'),source:await f.records('OPERATIONAL_SOURCE')}).toEqual(before);
});
it('new_namespace_blocks_legacy_dispatch and atomic owner races admit only one outer owner',async()=>{
  const f=await fixture(),results=await Promise.allSettled([f.journal().candidate(f.input),new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1').candidate(f.input)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect([...(await f.records('OPERATIONAL_CANDIDATE')),...(await f.records('P01C_PIPELINE_V1_CANDIDATE'))]).toHaveLength(1);
  const fresh=await fixture();await new PipelineEvidence(fresh.worker,fresh.bounds,'PIPELINE_V1').candidate(fresh.input);
  await expect(fresh.journal().candidate(fresh.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
});
it('refuses raw OCR before its outer candidate and refuses a later claim generation',async()=>{
  const f=await fixture(),raw=new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1');
  await expect(raw.candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  await new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1').candidate(f.input);
  await expect(raw.candidate({...f.input,claimGeneration:'99'})).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  expect(await f.records('LOCAL_OCR_V1_CANDIDATE')).toEqual([]);
});
it('foreign_owner_source_is_rejected rather than interpreted as raw OCR',async()=>{
  const f=await fixture(),outer=new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1'),raw=new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1');
  await outer.candidate(f.input);await raw.candidate(f.input);await outer.record(f.input,'OPERATIONAL_SOURCE',{phase:'PROVIDER'});
  const source=(await f.records('P01C_PIPELINE_V1_SOURCE'))[0],id=randomUUID();
  await f.admin.pool.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,'LOCAL_OCR_V1_SOURCE',$4,$2::uuid::text,$5)",[f.seed.accountId,id,f.input.executionId,source.evidence_digest,JSON.stringify(source.protected_observation)]);
  await expect(raw.records(f.input,'OPERATIONAL_SOURCE')).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});
  expect(await f.records('P01C_PIPELINE_V1_SOURCE')).toEqual([source]);
});
it.each(['TRANSLATE','CLEANUP','TYPESET'])('keeps original OPERATIONAL record kinds for non-OCR %s',async stage=>{
  const f=await fixture(stage),journal=new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1');await journal.candidate(f.input);await journal.record(f.input,'OPERATIONAL_SOURCE',{stage});
  expect(await f.records('OPERATIONAL_CANDIDATE')).toHaveLength(1);expect(await f.journal().records(f.input,'OPERATIONAL_SOURCE')).toEqual([{stage}]);
  expect(await f.records('P01C_PIPELINE_V1_CANDIDATE')).toEqual([]);
  await expect(new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1').candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});
});

it.each(['OPERATIONAL_SOURCE','LOCAL_OCR_V1_SOURCE'])('orphan %s blocks a fresh outer/legacy owner without replacing ambiguous records',async kind=>{
  const f=await fixture(),id=randomUUID(),stored={...f.input};delete stored.claimGeneration;
  const record={version:1,accountId:f.seed.accountId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(stored),kind,value:{phase:'START',started:true,costUsd:null}};
  await f.admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)',[f.seed.accountId,id,f.input.executionId,kind,digest(record),JSON.stringify(record)]);
  const before=await f.records(kind);
  await expect(new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1').candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  if(kind==='LOCAL_OCR_V1_SOURCE')await expect(f.journal().candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  else await expect(new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1').candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  expect(await f.records(kind)).toEqual(before);expect(await f.records('P01C_PIPELINE_V1_CANDIDATE')).toEqual([]);expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);expect(await f.records('START')).toEqual([]);
});

it('an existing outer fences legacy while raw OCR claims its first candidate concurrently',async()=>{
  const f=await fixture(),outer=new PipelineEvidence(f.worker,f.bounds,'PIPELINE_V1'),raw=new PipelineEvidence(f.worker,f.bounds,'LOCAL_OCR_V1');await outer.candidate(f.input);
  const results=await Promise.allSettled([raw.candidate(f.input),f.journal().candidate(f.input)]);
  expect(results[0].status).toBe('fulfilled');if(results[0].status==='fulfilled')expect(results[0].value.created).toBe(true);
  expect(results[1].status).toBe('rejected');if(results[1].status==='rejected')expect(results[1].reason).toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
  expect(await f.records('P01C_PIPELINE_V1_CANDIDATE')).toHaveLength(1);expect(await f.records('LOCAL_OCR_V1_CANDIDATE')).toHaveLength(1);expect(await f.records('OPERATIONAL_CANDIDATE')).toEqual([]);expect(await f.records('START')).toEqual([]);
});
