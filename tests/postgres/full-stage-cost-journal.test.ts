import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import {nativeLogicalOperationKey,validateNativeJobIntent,type NativeJobIntent} from '../../packages/domain/src/native-jobs.js';
import type {FullStageCostFacts,FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Real restricted LOGIN/PG authority and records; owned fake prices and workspace
// assets only. MEASURED/CONFIRMED labels do not prove actual costs. No provider,
// engine, native task, object PUT, public listener or operational startup runs.
const databases:Database[]=[];
afterEach(async()=>{vi.restoreAllMocks();const failures:unknown[]=[];for(const db of databases.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'OWNED_COST_DB_CLOSE_UNCONFIRMED');});
async function fixture(){
  const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');databases.push(api,worker);await api.validateServiceRole();await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const policy={stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:'owned-cost-journal-pg-v1'},workspace=new WorkspaceService(api,policy),provider=new SyntheticProvider(),execution=new ExecutionService(worker,provider,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  const claim=await execution.claim();expect(claim).not.toBeNull();const input=await execution.authorize(claim!);expect(input).not.toBeNull();
  const profileDigest=sha256('owned-cost-profile-pg'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'owned-cost-basis-pg-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-catalog-pg'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-image-pg-v1',usdPerUnit:'0.001',evidenceRefs:['owned-image-rate-pg']}]};
  const bounds={maxRecordBytes:262144,maxRecords:4,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}},journal=()=>new FullStageCostJournal(worker,bounds);
  const records=async(kind:string)=>(await admin.pool.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:Record<string,unknown>}>('SELECT evidence_id,evidence_digest,protected_evidence_ref,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id',[seed.accountId,input!.executionId,kind])).rows;
  const facts=(basis:FullStageCostBasis):FullStageCostFacts=>({provider:{scope:'ACTUAL_AI_USD',captureDigest:basis.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:['owned-provider-usage-pg']},quantities:[{componentId:'image',captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:'2',unit:'pixel',evidenceRefs:['owned-image-measure-pg']}],allocation:{captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:'FREE_OPERATIONS',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.004',evidenceRefs:['owned-allocation-pg']}});
  const untouched=async()=>{
    expect(provider.calls).toHaveLength(0);expect(await records('START')).toEqual([]);expect(await records('STALE_START')).toEqual([]);expect(await records('OUTCOME')).toEqual([]);
    for(const table of ['free_starts','cost_items','settlements','ledger_entries'])expect((await admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[seed.accountId])).rows[0].n).toBe(0);
    expect((await admin.pool.query<{state:string}>('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[seed.accountId])).rows).toEqual([{state:'HELD'}]);
  };
  return {admin,api,worker,seed,provider,execution,claim:claim!,firstClaim:{generation:claim!.generation,ownerId:execution.workerId,workItemId:claim!.workId},input:input!,profileDigest,snapshot,bounds,journal,records,facts,untouched};
}

describe('actual restricted original full-stage cost journal',()=>{
  it('reads and verifies the original basis inside the caller account transaction without nesting',async()=>{
    const f=await fixture();await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim);
    const journal=f.journal(),expected=await journal.lookup(f.input);
    await f.worker.accountTransaction(f.seed.accountId,async tx=>{
      const nested=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async()=>{throw Error('C2_COST_NESTED_TRANSACTION');});
      try{
        expect(await journal.lookupIn(tx,f.input)).toEqual(expected);
        await expect(journal.lookupIn(tx,{...f.input,width:f.input.width+1})).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});
        await expect(journal.lookupIn({...tx,account:{...tx.account,account_id:randomUUID()}},f.input)).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});
        expect(nested).not.toHaveBeenCalled();
      }finally{nested.mockRestore();}
    },true);await f.untouched();
  });
  it('requires the exact current first work and owning worker tuple without changing the lease',async()=>{
    const f=await fixture(),lease=async()=>(await f.admin.pool.query('SELECT state,claim_generation,claim_owner,lease_until FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,f.claim.workId])).rows[0],saved=await lease();
    await expect(f.journal().prepare(f.input,f.snapshot,f.profileDigest)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    for(const claim of [{...f.firstClaim,ownerId:randomUUID()},{...f.firstClaim,workItemId:randomUUID()},{...f.firstClaim,generation:'2'}])await expect(f.journal().prepare(f.input,f.snapshot,f.profileDigest,claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);expect(await lease()).toEqual(saved);expect((await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).created).toBe(true);expect(await lease()).toEqual(saved);
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);expect((await f.journal().prepare({...f.input,claimGeneration:'99'},f.snapshot,f.profileDigest)).created).toBe(false);await f.untouched();
  });
  it('preserves confirmed allocation contradictions across an initially missing basis version',async()=>{
    const f=await fixture(),basis=(await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).basis,partial=f.facts(basis);partial.allocation!.basisVersion=null;partial.allocation!.funding=null;
    const first=await f.journal().append(f.input,partial);expect(first.view.state).toBe('UNCONFIRMED');expect(first.view.costUsd).toBeNull();const saved=await f.records('OPERATIONAL_COST_CALCULATION');expect(saved).toHaveLength(1);
    const confirmed=f.facts(basis);confirmed.allocation!.actualUsd='0.005';const next=await f.journal().append(f.input,confirmed);expect(next.view.state).toBe('CONFLICT');expect(next.view.costUsd).toBeNull();expect(next.view.conflicts).toEqual(['ALLOCATION_COST_CONFLICT']);expect(next.view.calculations).toHaveLength(2);
    expect((await f.journal().append(f.input,confirmed)).appended).toBe(false);expect((await f.journal().lookup(f.input)).state).toBe('CONFLICT');const after=await f.records('OPERATIONAL_COST_CALCULATION');expect(after).toHaveLength(2);expect(after.find(row=>row.evidence_id===saved[0].evidence_id)).toEqual(saved[0]);await f.untouched();
  });
  it('captures original basis before preflight and holds late first capture after private source',async()=>{
    const f=await fixture(),state=async()=>(await f.admin.pool.query<{state:string;dispatch_attempted_at:Date|null}>('SELECT state,dispatch_attempted_at FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,f.input.executionId])).rows[0];
    expect(await state()).toEqual({state:'PREPARED',dispatch_attempted_at:null});
    expect((await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).created).toBe(true);expect(await state()).toEqual({state:'PREPARED',dispatch_attempted_at:null});
    expect(await f.execution.preflight(f.claim,f.input)).toBe(true);expect((await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).created).toBe(false);await f.untouched();
    const late=await fixture();expect(await late.execution.preflight(late.claim,late.input)).toBe(true);const pipeline=new PipelineEvidence(late.worker,{maxRecordBytes:65536,maxRecords:8}),candidate=(await pipeline.candidate(late.input)).candidate;
    await pipeline.record(late.input,'OPERATIONAL_SOURCE',{version:1,candidate,phase:'PROVIDER_START',value:{evidenceId:randomUUID()}});const original=await late.records('OPERATIONAL_SOURCE');
    await expect(late.journal().prepare(late.input,late.snapshot,late.profileDigest,late.firstClaim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    expect(await late.records('OPERATIONAL_COST_BASIS')).toEqual([]);expect(await late.records('OPERATIONAL_SOURCE')).toEqual(original);await late.untouched();
  });
  it('holds first basis after original execution and current checkpoint native intents before preflight',async()=>{
    // Owner/admin inserts bounded fake metadata to exercise the existing read
    // fence. Neither service gets intent INSERT privileges or native GO.
    const insert=async(f:Awaited<ReturnType<typeof fixture>>,targetKind:'EXECUTION'|'REQUEST_CHECKPOINT',workItemId:string)=>{
      const base={version:1 as const,jobId:randomUUID(),task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1' as const,profileDigest:f.profileDigest,inputDigest:sha256('owned-native-input-cost-fence'),operationInputDigest:sha256('owned-native-operation-cost-fence'),parentInstanceId:randomUUID(),targetKind,targetId:targetKind==='EXECUTION'?f.input.executionId:f.input.requestId,semanticCaptureDigest:digest({executionId:f.input.executionId}),protectedOwnerCapture:{contextId:f.input.contextId,contextGeneration:'1',ownerSessionId:null,ownerTabId:null,ownerRevision:null,workspaceRevision:null},claim:{generation:f.claim.generation,ownerId:f.execution.workerId,workItemId}};
      const intent:NativeJobIntent=validateNativeJobIntent({...base,logicalOperationKey:nativeLogicalOperationKey(base)});
      await f.admin.pool.query(`INSERT INTO manga_web.native_job_intents(account_id,job_id,owner_service,parent_instance_id,task,task_version,profile_digest,input_digest,operation_input_digest,target_kind,target_id,semantic_capture_digest,logical_operation_key,protected_intent,intent_digest,created_at)
        VALUES($1,$2,'trio_web_worker',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp())`,[f.seed.accountId,intent.jobId,intent.parentInstanceId,intent.task,intent.taskVersion,intent.profileDigest,intent.inputDigest,intent.operationInputDigest,intent.targetKind,intent.targetId,intent.semanticCaptureDigest,intent.logicalOperationKey,JSON.stringify(intent),digest(intent)]);
      return intent;
    };
    for(const targetKind of ['EXECUTION','REQUEST_CHECKPOINT'] as const){
      const f=await fixture(),intent=await insert(f,targetKind,f.claim.workId);
      await expect(f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);
      const rows=(await f.admin.pool.query<{protected_intent:NativeJobIntent}>('SELECT protected_intent FROM manga_web.native_job_intents WHERE account_id=$1',[f.seed.accountId])).rows;expect(rows).toEqual([{protected_intent:intent}]);
      for(const table of ['native_job_go_consumptions','native_job_observations'])expect((await f.admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[f.seed.accountId])).rows[0].n).toBe(0);await f.untouched();
    }
    const other=await fixture();await insert(other,'REQUEST_CHECKPOINT',randomUUID());expect((await other.journal().prepare(other.input,other.snapshot,other.profileDigest,other.firstClaim)).created).toBe(true);await other.untouched();
  });
  it('keeps original basis after ACK loss and preserves late confirmations without dispatch',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-cost-journal-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');const f=await fixture();trace('ORIGINAL_INPUT_PREPARED');
    expect((await f.journal().lookup(f.input)).basis).toBeNull();expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);
    const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false;
    const loseCreated:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{const value=await transaction(accountId,run,restricted);if(!lost&&value!==null&&typeof value==='object'&&'created'in value&&value.created===true){lost=true;throw Error('OWNED_COST_BASIS_COMMIT_ACK_LOST');}return value;};
    const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(loseCreated);let race:PromiseSettledResult<Awaited<ReturnType<FullStageCostJournal['prepare']>>>[];
    try{race=await Promise.allSettled([f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim),f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)]);}finally{spy.mockRestore();}
    expect(lost).toBe(true);expect(race.filter(result=>result.status==='rejected')).toHaveLength(1);const survivor=race.find(result=>result.status==='fulfilled');expect(survivor?.status==='fulfilled'&&survivor.value.created).toBe(false);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);
    const original=(await f.journal().lookup(f.input)).basis!;expect(original.capture.mode).toBe('FREE');await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
    expect((await f.journal().prepare({...f.input,claimGeneration:'99'},f.snapshot,f.profileDigest)).created).toBe(false);const unknown=f.facts(original);unknown.provider!.state='UNCONFIRMED';unknown.provider!.actualUsd=null;unknown.provider!.evidenceRefs=[];
    const first=await f.journal().append({...f.input,claimGeneration:'99'},unknown);expect(first.view.costUsd).toBeNull();expect(first.view.state).toBe('UNCONFIRMED');trace('UNKNOWN_ORIGINAL_FACTS_RETAINED');
    const facts=f.facts(original);let factsLost=false;const loseFacts:typeof f.worker.accountTransaction=async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false):Promise<T>=>{const value=await transaction(accountId,run,restricted);if(!factsLost&&value!==null&&typeof value==='object'&&'appended'in value&&value.appended===true){factsLost=true;throw Error('OWNED_COST_FACT_COMMIT_ACK_LOST');}return value;};
    const factsSpy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(loseFacts);try{await expect(f.journal().append(f.input,facts)).rejects.toThrow('OWNED_COST_FACT_COMMIT_ACK_LOST');}finally{factsSpy.mockRestore();}
    const recovered=await f.journal().append({...f.input,claimGeneration:'100'},facts);expect(recovered.appended).toBe(false);expect(recovered.view.state).toBe('CONFIRMED');expect(recovered.view.costUsd).toBe('0.016000000000');expect(recovered.view.calculations).toHaveLength(2);expect(recovered.view.calculations.some(record=>record.result.actualUsd===null)).toBe(true);
    const saved=await f.records('OPERATIONAL_COST_BASIS'),changed=structuredClone(f.snapshot);changed.components[0].usdPerUnit='9';await expect(f.journal().prepare(f.input,changed,f.profileDigest,f.firstClaim)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(saved);
    await expect(f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT protected_observation FROM execution_evidence WHERE execution_id=$1',[f.input.executionId]))).rejects.toMatchObject({code:'42501'});
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('DELETE FROM execution_evidence WHERE execution_id=$1',[f.input.executionId]))).rejects.toMatchObject({code:'42501'});await f.untouched();trace('ORIGINAL_COST_HISTORY_NO_START_SETTLEMENT_OR_REDISPATCH');
  });
  it('holds expired first capture and re-signed conflicting evidence without rewriting original facts',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-cost-conflict-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');const f=await fixture();trace('ORIGINAL_DISPATCH_READY');
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);await expect(f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);
    // Owned operator restores only this fake fixture's original lease.
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()+interval '30 seconds' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);const basis=(await f.journal().prepare(f.input,f.snapshot,f.profileDigest,f.firstClaim)).basis,facts=f.facts(basis);await f.journal().append(f.input,facts);
    const foreign=structuredClone(facts);foreign.provider!.captureDigest=sha256('foreign-original-execution');await expect(f.journal().append(f.input,foreign)).rejects.toMatchObject({code:'FULL_STAGE_COST_BINDING_CONFLICT'});await expect(f.journal().lookup({...f.input,width:f.input.width+1})).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});
    const conflicting=structuredClone(facts);conflicting.provider!.actualUsd='0.011';conflicting.provider!.evidenceRefs=['owned-conflicting-provider-pg'];const held=await f.journal().append(f.input,conflicting);expect(held.view.state).toBe('CONFLICT');expect(held.view.costUsd).toBeNull();expect(held.view.calculations).toHaveLength(2);const preserved=await f.records('OPERATIONAL_COST_CALCULATION');
    const tampered=structuredClone(preserved[0].protected_observation);(tampered.value as Record<string,unknown>).actualUsd='0.000000000000';const id=randomUUID();await f.admin.pool.query(`INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation)
      VALUES($1,$2,$3,'OPERATIONAL_COST_CALCULATION',$4,$2::uuid::text,$5)`,[f.seed.accountId,id,f.input.executionId,digest(tampered),JSON.stringify(tampered)]);
    await expect(f.journal().lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});const after=await f.records('OPERATIONAL_COST_CALCULATION');expect(after).toHaveLength(3);for(const original of preserved)expect(after.find(row=>row.evidence_id===original.evidence_id)).toEqual(original);expect(await f.records('OPERATIONAL_COST_BASIS')).toHaveLength(1);
    await f.untouched();trace('ALL_CONFLICTING_EVIDENCE_RETAINED_WITHOUT_COST_AUTHORITY');
  });
});
