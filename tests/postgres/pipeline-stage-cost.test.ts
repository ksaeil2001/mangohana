import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {canonicalInput,SyntheticProvider} from '../../packages/domain/src/provider.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {OperationalStageCost,type OperationalStageCostWorkSet,type CostEvidenceRef} from '../../packages/domain/src/pipeline-stage-cost.js';
import {CheckpointValidationJournal} from '../../packages/domain/src/checkpoint-validation.js';
import {validateOwnedExecutionLimitProfile,type ExecutionLimitReference} from '../../packages/domain/src/execution-limits.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

// Restricted worker LOGIN and real journal DB. The reader and its original
// operations/rates are invented fixture facts, not measured provider authority.
const databases:Database[]=[];
afterEach(async()=>{vi.restoreAllMocks();const failed:unknown[]=[];for(const db of databases.splice(0).reverse())try{await db.close();}catch(error){failed.push(error);}if(failed.length)throw new AggregateError(failed);});
async function fixture(stage:'OCR'|'TYPESET'='OCR',price:string|null='0.001',withLimit=false){
  const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');databases.push(api,worker);
  await api.validateServiceRole();await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  let executionLimit:ExecutionLimitReference|undefined;
  if(withLimit){
    const start=new Date(now.valueOf()-3600000),profile=validateOwnedExecutionLimitProfile({kind:'OWNED_FIXTURE',version:'owned-pipeline-cost-v1',maxSlots:1,requestLimitUsd:'1',dailyLimitUsd:'2',fullBoundUsd:'1',stages:{[stage]:{boundUsd:'1',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:c2-stage-cost/stage']}},fullBoundEvidenceRefs:['owned-fixture:c2-stage-cost/request'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:start.toISOString(),endAt:new Date(start.valueOf()+86400000).toISOString()}}),profileId=randomUUID();
    const inserted=(await admin.pool.query<{profile_digest:string}>(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),profile.window!.kind,profile.window!.startAt,profile.window!.endAt])).rows[0];
    executionLimit={kind:'OWNED_FIXTURE',profileId,profileDigest:inserted.profile_digest,profileVersion:profile.version};await admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[profileId]);
  }
  const policy={stageOrder:[stage],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:'owned-pipeline-cost-v1',...(executionLimit?{executionLimit}:{})},provider=new SyntheticProvider(),workspace=new WorkspaceService(api,policy),execution=new ExecutionService(worker,provider,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  const claim=await execution.claim();expect(claim).not.toBeNull();const input=(await execution.authorize(claim!))!;expect(input).not.toBeNull();
  const profileDigest=sha256('owned-pipeline-cost-profile'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage,profileDigest,basisVersion:'owned-pipeline-cost-basis',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-catalog'],components:[{componentId:'image',kind:'IMAGE',unit:'pixel',rateVersion:'owned-image-rate',usdPerUnit:price,evidenceRefs:['owned-image-rate']}]};
  const journalBounds={maxRecordBytes:262144,maxRecords:16,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}},journal=new FullStageCostJournal(worker,journalBounds),preparation=new FullStageCostPreparation(journal,[{stage,profileDigest,snapshot}],journalBounds.calculator);
  const bounds={maxRecordBytes:262144,maxRecords:16,maxSources:16,maxExecutions:32,maxInFlight:4};
  let current:OperationalStageCostWorkSet|null=null,finalReady=false,historicalReady=false;
  // Trusted DB fixture: enumerate immutable original work independently of
  // current publication/owner/asset access. Helper semantics have their own tests.
  const reader={workSetIn:vi.fn(async()=>structuredClone(current)),checkpointFactsIn:vi.fn(async()=>null)};
  const sealedFinalCostIn=vi.fn(async(_tx:Transaction,_input:typeof input,_joinedEvidence:CostEvidenceRef[]):Promise<'VERIFIED'|'WAIT'>=>historicalReady?'VERIFIED':'WAIT');
  const checkpoints={beginIn:vi.fn(),recordIn:vi.fn(),lookupIn:vi.fn(),verifiedPredecessorsIn:vi.fn(),finalCommitIn:vi.fn(async()=>finalReady?'ELIGIBLE':'WAIT'),sealedFinalCostIn} as unknown as CheckpointValidationJournal;
  const options={db:worker,preparation,journal,reader,checkpoints,bounds},cost=new OperationalStageCost(options),firstClaim={generation:claim!.generation,ownerId:execution.workerId,workItemId:claim!.workId};
  const read=(target=input)=>worker.accountTransaction(seed.accountId,tx=>cost.readIn(tx,target),true);
  const records=async(kind:string,target=input)=>(await admin.pool.query('SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id',[seed.accountId,target.executionId,kind])).rows;
  const put=async(kind:string,value:unknown,target=input):Promise<CostEvidenceRef>=>{
    const evidenceId=randomUUID(),evidenceDigest=digest(value);await worker.accountTransaction(seed.accountId,tx=>tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)`,[seed.accountId,evidenceId,target.executionId,kind,evidenceDigest,JSON.stringify(value)]),true);return {evidenceId,evidenceDigest};
  };
  const workset=async(target=input):Promise<OperationalStageCostWorkSet>=>{
    const basis=(await journal.lookup(target)).basis!;expect(basis).not.toBeNull();
    const sources:OperationalStageCostWorkSet['sources']=[];
    for(const kind of ['PROVIDER','QUANTITY','ALLOCATION'] as const){const sourceOperationId=randomUUID(),sourceEventId=randomUUID(),ref=await put('OPERATIONAL_SOURCE',{ownedFixture:true,operationId:sourceOperationId,eventId:sourceEventId,executionId:target.executionId},target);sources.push({sourceOperationId,sourceEventId,target:kind,componentId:kind==='QUANTITY'?'image':null,evidence:[ref]});}
    const termination=await put('OPERATIONAL_HOLD',{ownedFixture:true,executionId:target.executionId,originalNoMoreIo:randomUUID()},target),refs=(kind:string)=>sources.find(source=>source.target===kind)!.evidence.map(ref=>ref.evidenceId);
    return {version:1,executionId:target.executionId,inputFingerprint:digest(canonicalInput(target)),captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(source=>source.evidence),terminationEvidence:[termination],sources,
      facts:{provider:{scope:'ACTUAL_AI_USD',captureDigest:basis.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:refs('PROVIDER')},quantities:[{componentId:'image',captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:'2',unit:'pixel',evidenceRefs:refs('QUANTITY')}],allocation:{captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:'FREE_OPERATIONS',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.004',evidenceRefs:refs('ALLOCATION')}}};
  };
  const ended=()=>admin.pool.query("UPDATE manga_web.executions SET state='UNKNOWN',dispatch_attempted_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2",[seed.accountId,input.executionId]);
  const otherInput=async(withBasis=false)=>{
    const target=structuredClone(input);target.executionId=randomUUID();target.envelope!.executionId=target.executionId;
    await admin.pool.query(`INSERT INTO manga_web.executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) SELECT account_id,$3,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,'UNKNOWN',revision FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2`,[seed.accountId,input.executionId,target.executionId]);
    await put('INPUT',canonicalInput(target),target);
    if(withBasis){const calculated=new FullStageCostCalculator(snapshot,journalBounds.calculator).calculate({accountId:seed.accountId,executionId:target.executionId,inputDigest:target.inputDigest,inputFingerprint:digest(canonicalInput(target)),stage,profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
      const basis:FullStageCostBasis={version:1,capture:calculated.capture,captureDigest:calculated.captureDigest,snapshot:structuredClone(snapshot),snapshotDigest:calculated.snapshotDigest};
      await put('OPERATIONAL_COST_BASIS',{version:1,accountId:seed.accountId,executionId:target.executionId,inputDigest:target.inputDigest,inputFingerprint:digest(canonicalInput(target)),kind:'OPERATIONAL_COST_BASIS',value:basis},target);
      await admin.pool.query('UPDATE manga_web.executions SET dispatch_attempted_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2',[seed.accountId,target.executionId]);}
    return target;
  };
  const untouched=async()=>{expect(provider.calls).toHaveLength(0);for(const table of ['cost_items','settlements','ledger_entries','free_starts','native_job_go_consumptions'])expect((await admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[seed.accountId])).rows[0].n).toBe(0);};
  return {admin,worker,input,claim:claim!,execution,provider,policy,firstClaim,options,cost,journal,snapshot,read,records,put,workset,ended,otherInput,untouched,reader,checkpoints,sealedFinalCostIn,set:(value:OperationalStageCostWorkSet|null)=>{current=value;},seal:()=>{finalReady=true;historicalReady=true;},unpublish:()=>{finalReady=false;}};
}

async function terminalTypesetFixture(completion:'EXECUTION'|'TERMINAL_PREPARATION',state:'FAILED'|'PREPARED'|'REJECTED'|'UNKNOWN',requestState:'ACTIVE'|'FAILED'|'STOPPED'){
  const f=await fixture('TYPESET');await f.cost.prepare(f.input,f.firstClaim);const work=await f.workset();work.completion=completion;f.set(work);
  await f.admin.pool.query(`UPDATE manga_web.executions SET state=$3,dispatch_attempted_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END WHERE account_id=$1 AND execution_id=$2`,[f.input.accountId,f.input.executionId,state,completion==='EXECUTION']);
  await f.admin.pool.query(`UPDATE manga_web.processing_requests SET state=$3,terminal_at=CASE WHEN $3 IN ('FAILED','STOPPED') THEN clock_timestamp() ELSE NULL END,terminal_evidence_ref=CASE WHEN $3 IN ('FAILED','STOPPED') THEN $4::text ELSE NULL END WHERE account_id=$1 AND request_id=$2`,[f.input.accountId,f.input.requestId,requestState,work.terminationEvidence[0].evidenceId]);
  // Historical costs must survive loss of current owner/publication authority.
  await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1 WHERE account_id=$1 AND context_id=$2',[f.input.accountId,f.input.contextId]);
  await f.admin.pool.query("UPDATE manga_web.app_sessions SET revoked_at=clock_timestamp(),revocation_reason='OWNED_TERMINAL_COST_FIXTURE' WHERE account_id=$1",[f.input.accountId]);
  const checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:262144,maxRecords:128,maxTargets:4,maxJobs:32}),cost=new OperationalStageCost({...f.options,checkpoints});
  const read=()=>f.worker.accountTransaction(f.input.accountId!,tx=>cost.readIn(tx,f.input),true),publication=()=>f.worker.accountTransaction(f.input.accountId!,tx=>checkpoints.finalCommitIn(tx,f.input),true);
  const evidence=async()=>(await f.admin.pool.query('SELECT evidence_id,evidence_digest,kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY evidence_id',[f.input.accountId,f.input.executionId])).rows;
  const noIo=async()=>{await f.untouched();expect(f.provider.lookups).toEqual([]);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_intents WHERE account_id=$1',[f.input.accountId])).rows[0].n).toBe(0);};
  return {...f,cost,checkpoints,work,read,publication,evidence,noIo};
}

describe('closed original work set and actual restricted journal cost',()=>{
  it.each([
    ['input failure','TERMINAL_PREPARATION','FAILED','FAILED'],
    ['cancelled preparation','TERMINAL_PREPARATION','PREPARED','STOPPED'],
    ['failed preparation request','TERMINAL_PREPARATION','PREPARED','FAILED'],
    ['rejected preparation','TERMINAL_PREPARATION','REJECTED','ACTIVE'],
    ['dispatched failure','EXECUTION','FAILED','FAILED'],
    ['dispatched rejection','EXECUTION','REJECTED','FAILED'],
  ] as const)('closes terminal TYPESET %s at the actual original amount without a success FINAL',async(_label,completion,state,requestState)=>{
    const f=await terminalTypesetFixture(completion,state,requestState),get=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('UNEXPECTED_TERMINAL_COST_GET'));
    const basis=await f.records('OPERATIONAL_COST_BASIS'),original=await f.evidence();expect(await f.publication()).toBe('WAIT');
    await f.cost.finishAttempt(f.input);const view=await f.read();expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');
    const closure=await f.records('OPERATIONAL_COST_CLOSURE'),calculations=await f.records('OPERATIONAL_COST_CALCULATION');expect(closure).toHaveLength(1);expect(calculations).toHaveLength(1);
    const sealed=closure[0].protected_observation.value;expect(sealed.workSet).toEqual(f.work);expect(sealed.basisEvidenceId).toBe(basis[0].evidence_id);expect(sealed.basisEvidenceDigest).toBe(basis[0].evidence_digest);
    expect(view.sealedCalculation).toEqual({evidenceId:sealed.calculationEvidenceId,evidenceDigest:sealed.calculationEvidenceDigest});expect(view.sealedCalculation).toEqual({evidenceId:calculations[0].evidence_id,evidenceDigest:calculations[0].evidence_digest});
    const saved=await f.evidence();expect(saved).toHaveLength(original.length+2);
    for(let attempt=0;attempt<2;attempt++){expect(await f.read()).toEqual(view);await f.cost.finishAttempt(f.input);expect(await f.evidence()).toEqual(saved);}
    expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(basis);expect(await f.publication()).toBe('WAIT');
    expect(await f.records('CHECKPOINT_VALIDATION_ATTEMPT')).toEqual([]);expect(await f.records('CHECKPOINT_VALIDATION_VERIFIED')).toEqual([]);expect(await f.records('OUTCOME')).toEqual([]);
    expect((await f.admin.pool.query('SELECT state FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0].state).toBe(state);
    expect(get).not.toHaveBeenCalled();await f.noIo();
  });
  it('holds dispatched TYPESET UNKNOWN without inventing a failed execution or a zero cost',async()=>{
    const f=await terminalTypesetFixture('EXECUTION','UNKNOWN','ACTIVE'),saved=await f.evidence();
    for(let attempt=0;attempt<2;attempt++){await f.cost.finishAttempt(f.input);const view=await f.read();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(await f.evidence()).toEqual(saved);}
    expect((await f.admin.pool.query('SELECT state FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0].state).toBe('UNKNOWN');expect(await f.publication()).toBe('WAIT');await f.noIo();
  });
  it('holds dispatched TYPESET REJECTED when a confirmed start contradicts the original not-started termination',async()=>{
    const f=await terminalTypesetFixture('EXECUTION','REJECTED','FAILED');await f.admin.pool.query('UPDATE manga_web.executions SET start_confirmed_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId]);const saved=await f.evidence();
    await f.cost.finishAttempt(f.input);const view=await f.read();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(await f.evidence()).toEqual(saved);expect(await f.publication()).toBe('WAIT');await f.noIo();
  });
  it.each(['TERMINAL_PREPARATION','EXECUTION'] as const)('holds terminal TYPESET %s without original termination evidence',async completion=>{
    const f=await terminalTypesetFixture(completion,'FAILED','FAILED'),original=await f.evidence(),get=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('UNEXPECTED_TERMINAL_COST_GET'));
    for(const missing of [[],[{evidenceId:randomUUID(),evidenceDigest:sha256('missing-original-termination')}]]){
      const incomplete=structuredClone(f.work);incomplete.terminationEvidence=missing;f.set(incomplete);
      await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});
      const view=await f.read();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(await f.evidence()).toEqual(original);
    }
    expect(await f.publication()).toBe('WAIT');expect(get).not.toHaveBeenCalled();await f.noIo();
  });
  it.each(['TERMINAL_PREPARATION','EXECUTION'] as const)('revalidates terminal TYPESET %s termination evidence on sealed historical reads',async completion=>{
    const f=await terminalTypesetFixture(completion,'FAILED','FAILED');await f.cost.finishAttempt(f.input);expect((await f.read()).state).toBe('CONFIRMED');const saved=await f.evidence();
    const missing=structuredClone(f.work);missing.terminationEvidence=[];f.set(missing);
    await expect(f.read()).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({nextAction:'WAIT'});
    expect(await f.evidence()).toEqual(saved);expect(await f.publication()).toBe('WAIT');await f.noIo();
  });
  it('waits without capturing rates for missing basis and blocks another INPUT before any BASIS',async()=>{
    const f=await fixture();expect((await f.read()).basis).toBeNull();await expect(f.cost.finishAttempt(f.input)).resolves.toBeUndefined();
    expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual([]);expect(f.reader.workSetIn).not.toHaveBeenCalled();
    expect(await f.worker.accountTransaction(f.input.accountId!,tx=>f.cost.hasPendingOtherIn(tx,randomUUID()),true)).toBe(true);
    expect(await f.worker.accountTransaction(f.input.accountId!,tx=>f.cost.hasPendingOtherIn(tx,f.input.executionId),true)).toBe(false);
    await f.otherInput();expect(await f.worker.accountTransaction(f.input.accountId!,tx=>f.cost.hasPendingOtherIn(tx,f.input.executionId),true)).toBe(true);await f.untouched();
  });
  it('retains basis and a confirmed calculation but does not confirm without a complete original closure',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const set=await f.workset();await f.journal.append(f.input,set.facts);
    expect((await f.journal.lookup(f.input)).state).toBe('CONFIRMED');const held=await f.read();expect(held.basis).not.toBeNull();expect(held.state).toBe('UNCONFIRMED');expect(held.costUsd).toBeNull();expect(held.sealedCalculation).toBeNull();
    f.set(set);await f.cost.finishAttempt(f.input);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);await f.untouched();
  });
  it('appends calculation before immutable closure, recovers lost closure ACK and preserves UNKNOWN execution',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);f.set(await f.workset());await f.ended();
    const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false;
    const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,restricted=false)=>{const value=await transaction(accountId,run,restricted);const rows=await f.records('OPERATIONAL_COST_CLOSURE');if(!lost&&rows.length){lost=true;throw Error('C2_CLOSURE_ACK_LOST');}return value;});
    const withLostAck=new OperationalStageCost(f.options);
    try{await expect(withLostAck.finishAttempt(f.input)).rejects.toThrow('C2_CLOSURE_ACK_LOST');}finally{spy.mockRestore();}
    expect(lost).toBe(true);const saved=await f.records('OPERATIONAL_COST_CLOSURE');expect(saved).toHaveLength(1);await f.cost.finishAttempt(f.input);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(saved);
    const view=await f.read();expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.calculations).toHaveLength(1);
    const closed=saved[0].protected_observation.value;expect(closed.calculationEvidenceId).toBe(view.calculations[0].evidenceId);expect(closed.calculationEvidenceDigest).toBe(view.calculations[0].evidenceDigest);expect(closed.factsDigest).toBe(view.calculations[0].result.factsDigest);
    expect((await f.admin.pool.query('SELECT state FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0].state).toBe('UNKNOWN');await f.untouched();
  });
  it('keeps missing price, quantity, allocation or original join unknown without an implicit zero',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();await f.ended();
    for(const field of ['provider','quantities','allocation'] as const){const partial=structuredClone(full);partial.facts[field]=null;f.set(partial);await f.cost.finishAttempt(f.input);expect((await f.read()).costUsd).toBeNull();expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);}
    const unjoined=structuredClone(full);unjoined.joinedEvidence=[];f.set(unjoined);await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({nextAction:'WAIT'});expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);await f.untouched();
  });
  it('keeps an unknown captured rate null even after every original work and quantity ends',async()=>{
    const f=await fixture('OCR',null);await f.cost.prepare(f.input,f.firstClaim);f.set(await f.workset());await f.ended();await f.cost.finishAttempt(f.input);
    const view=await f.read();expect(view.basis!.snapshot!.components[0].usdPerUnit).toBeNull();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.calculations).toHaveLength(1);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);await f.untouched();
  });
  it('blocks other work until closed cost is projected and preserves conflicting actual DB amounts',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);f.set(await f.workset());await f.ended();await f.cost.finishAttempt(f.input);
    const pending=()=>f.worker.accountTransaction(f.input.accountId!,tx=>f.cost.hasPendingOtherIn(tx,null),true);
    expect(await pending()).toBe(true);
    const costId=randomUUID();await f.admin.pool.query(`INSERT INTO manga_web.cost_items(account_id,cost_item_id,execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at) VALUES($1,$2,$3,'STAGE_TOTAL',0,'CONFIRMED','0.016',$4,'owned-stage-total',clock_timestamp())`,[f.input.accountId,costId,f.input.executionId,(await f.records('OPERATIONAL_COST_CLOSURE'))[0].evidence_id]);
    expect(await pending()).toBe(false);
    await f.admin.pool.query("UPDATE manga_web.cost_items SET actual_usd='0.017' WHERE account_id=$1 AND cost_item_id=$2",[f.input.accountId,costId]);expect(await pending()).toBe(true);
    expect((await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.cost_items WHERE account_id=$1 AND cost_item_id=$2',[f.input.accountId,costId])).rows[0].actual_usd).toBe('0.017000000000');
    await f.admin.pool.query("UPDATE manga_web.cost_items SET state='UNCONFIRMED',actual_usd=NULL WHERE account_id=$1 AND cost_item_id=$2",[f.input.accountId,costId]);expect(await pending()).toBe(true);
  });
  it('returns a conflict when additional joined original work appears after immutable closure',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();f.set(full);await f.ended();await f.cost.finishAttempt(f.input);const saved=await f.records('OPERATIONAL_COST_CLOSURE');
    const changed=structuredClone(full);changed.joinedEvidence.push(await f.put('OPERATIONAL_SOURCE',{ownedFixture:true,lateOriginalWork:randomUUID()}));f.set(changed);
    const view=await f.read();expect(view.state).toBe('CONFLICT');expect(view.costUsd).toBeNull();expect(view.conflicts).toContain('OPERATIONAL_STAGE_COST_CLOSURE_CONFLICT');expect(view.sealedCalculation).toBeNull();expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(saved);await f.untouched();
  });
  it('refuses duplicated operation/event allocation within one reply or across consumers of an account',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();await f.ended();
    for(const field of ['sourceOperationId','sourceEventId'] as const){const duplicate=structuredClone(full);duplicate.sources[1][field]=duplicate.sources[0][field];f.set(duplicate);await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_DUPLICATE_SOURCE'});}
    f.set(full);await f.cost.finishAttempt(f.input);const saved=await f.records('OPERATIONAL_COST_CLOSURE'),other=await f.otherInput(true),reuse=await f.workset(other);reuse.sources[0].sourceOperationId=full.sources[0].sourceOperationId;f.set(reuse);
    await expect(f.cost.finishAttempt(other)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_DUPLICATE_SOURCE'});expect((await f.read(other)).costUsd).toBeNull();expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(saved);await f.untouched();
  });
  it('holds original missing or foreign evidence and caller CLOSED labels',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();await f.ended();
    for(const change of [(value:OperationalStageCostWorkSet)=>{value.terminationEvidence=[];},(value:OperationalStageCostWorkSet)=>{value.joinedEvidence[0].evidenceDigest=sha256('foreign');},(value:OperationalStageCostWorkSet)=>{Object.assign(value,{state:'CLOSED'});},(value:OperationalStageCostWorkSet)=>{value.captureDigest=sha256('foreign');}]){const changed=structuredClone(full);change(changed);f.set(changed);await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({nextAction:'WAIT'});}
    expect(await f.records('OPERATIONAL_COST_CALCULATION')).toEqual([]);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);await f.untouched();
  });
  it('rejects joined/termination evidence overlap as unconfirmed work without appending a calculation or closure',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const work=await f.workset();work.terminationEvidence=[work.joinedEvidence[0]];f.set(work);await f.ended();
    await expect(f.cost.finishAttempt(f.input)).rejects.toMatchObject({code:'OPERATIONAL_STAGE_COST_UNCONFIRMED',nextAction:'WAIT'});
    expect(await f.records('OPERATIONAL_COST_CALCULATION')).toEqual([]);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);expect((await f.read()).sealedCalculation).toBeNull();await f.untouched();
  });
  it('keeps temporary PREPARED work open and closes a terminal original without requiring request completion',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();full.completion='TERMINAL_PREPARATION';f.set(full);
    await f.cost.finishAttempt(f.input);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);
    await f.admin.pool.query("UPDATE manga_web.executions SET state='REJECTED' WHERE account_id=$1 AND execution_id=$2",[f.input.accountId,f.input.executionId]);
    await f.cost.finishAttempt(f.input);expect((await f.read()).state).toBe('CONFIRMED');await f.untouched();
  });
  it('converts the original calculation and closure into limit expense with a real reserved permit',async()=>{
    const f=await fixture('OCR','0.001',true);await f.cost.prepare(f.input,f.firstClaim);expect(await f.execution.preflight(f.claim,f.input)).toBe(true);
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0].n).toBe(1);
    f.set(await f.workset());await f.cost.finishAttempt(f.input);expect((await f.read()).state).toBe('CONFIRMED');
    const projector=new ExecutionService(f.worker,f.provider,f.policy,{},undefined,f.cost);
    const reason=await f.worker.accountTransaction(f.input.accountId!,async tx=>{
      await projector.reconcileOperationalCostIn(tx,f.input);
      return (await tx.client.query<{decision:{reason:string}}>('SELECT manga_web.reconcile_execution_limits($1) AS decision',[f.input.executionId])).rows[0].decision.reason;
    },true);
    const calculation=(await f.read()).calculations[0],cost=(await f.admin.pool.query('SELECT actual_usd::text,usage_ref FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0];
    expect(cost).toEqual({actual_usd:'0.016000000000',usage_ref:'execution-evidence:'+calculation.evidenceId+':'+calculation.evidenceDigest});
    expect(await f.records('OUTCOME')).toEqual([]);expect(await f.records('OPERATIONAL_PLAN')).toEqual([]);expect(f.provider.calls).toHaveLength(0);
    const authority=(await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0],expense=(await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0];
    process.stdout.write(JSON.stringify({scope:'c2-cost-original-calculation-real-permit',reason,authority,expenseCount:expense.n,originalOutcomeCount:0,providerCalls:0})+'\n');
    expect(reason).toBe('RECONCILED');expect(expense.n).toBe(1);expect(authority).toEqual({state:'OPEN',halt_reason:null});
    const originalExpense=(await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows;
    const originalCost=(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows;
    for(let retry=0;retry<3;retry++)await f.worker.accountTransaction(f.input.accountId!,async tx=>{
      await projector.reconcileOperationalCostIn(tx,f.input);
      expect((await tx.client.query('SELECT manga_web.reconcile_execution_limits($1) AS decision',[f.input.executionId])).rows[0].decision.reason).toBe('RECONCILED');
    },true);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual(originalExpense);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual(originalCost);
    expect(await f.records('OPERATIONAL_COST_CLOSURE')).toHaveLength(1);expect(f.provider.calls).toHaveLength(0);

  });
  it('preserves a later confirmed amount conflict even after an original closure',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const full=await f.workset();f.set(full);await f.ended();await f.cost.finishAttempt(f.input);const saved=await f.records('OPERATIONAL_COST_CLOSURE');
    const changed=structuredClone(full.facts);changed.provider!.actualUsd='0.02';await f.journal.append(f.input,changed);
    const held=await f.read();expect(held.state).toBe('CONFLICT');expect(held.costUsd).toBeNull();expect(held.conflicts).toContain('PROVIDER_COST_CONFLICT');expect(held.sealedCalculation).toBeNull();expect(held.calculations).toHaveLength(2);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(saved);await f.untouched();
  });
  it('returns calculation 2 sealed by original work when calculation 1 has the same amount and quantity with different evidence refs',async()=>{
    const f=await fixture();await f.cost.prepare(f.input,f.firstClaim);const first=await f.workset();await f.journal.append(f.input,first.facts);const calculation1=(await f.journal.lookup(f.input)).calculations[0];
    const second=await f.workset();f.set(second);await f.ended();await f.cost.finishAttempt(f.input);const view=await f.read(),calculation2=view.calculations.find(row=>row.result.factsDigest===digest(second.facts))!;
    expect(view.state).toBe('CONFIRMED');expect(view.calculations).toHaveLength(2);expect(view.calculations[0].evidenceId).toBe(calculation1.evidenceId);expect(calculation2.evidenceId).not.toBe(calculation1.evidenceId);
    expect(calculation1.result.actualUsd).toBe('0.016000000000');expect(calculation2.result.actualUsd).toBe(calculation1.result.actualUsd);expect(calculation1.result.facts.quantities![0].quantity).toBe('2');expect(calculation2.result.facts.quantities![0].quantity).toBe('2');expect(calculation2.result.factsDigest).not.toBe(calculation1.result.factsDigest);
    const closure=(await f.records('OPERATIONAL_COST_CLOSURE'))[0].protected_observation.value;expect(closure.calculationEvidenceId).toBe(calculation2.evidenceId);expect(closure.calculationEvidenceDigest).toBe(calculation2.evidenceDigest);expect(view.sealedCalculation).toEqual({evidenceId:calculation2.evidenceId,evidenceDigest:calculation2.evidenceDigest});await f.untouched();
  });
  it('retains sealed TYPESET cost when current publication starts waiting without recapturing or appending',async()=>{
    const f=await fixture('TYPESET');await f.cost.prepare(f.input,f.firstClaim);const work=await f.workset();f.set(work);await f.ended();f.seal();await f.cost.finishAttempt(f.input);
    const closure=await f.records('OPERATIONAL_COST_CLOSURE'),calculations=await f.records('OPERATIONAL_COST_CALCULATION'),basis=await f.records('OPERATIONAL_COST_BASIS'),currentChecks=vi.mocked(f.checkpoints.finalCommitIn).mock.calls.length;f.unpublish();
    const view=await f.read();expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.016000000000');expect(view.sealedCalculation).toEqual({evidenceId:closure[0].protected_observation.value.calculationEvidenceId,evidenceDigest:closure[0].protected_observation.value.calculationEvidenceDigest});
    expect(f.checkpoints.finalCommitIn).toHaveBeenCalledTimes(currentChecks);expect(f.sealedFinalCostIn).toHaveBeenCalledExactlyOnceWith(expect.anything(),f.input,work.joinedEvidence);
    await f.cost.finishAttempt(f.input);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(closure);expect(await f.records('OPERATIONAL_COST_CALCULATION')).toEqual(calculations);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(basis);await f.untouched();
  });
  it('holds TYPESET cost on historical helper WAIT and keeps the original calculation and closure',async()=>{
    const f=await fixture('TYPESET');await f.cost.prepare(f.input,f.firstClaim);const work=await f.workset();f.set(work);await f.ended();f.seal();await f.cost.finishAttempt(f.input);
    const closure=await f.records('OPERATIONAL_COST_CLOSURE'),calculations=await f.records('OPERATIONAL_COST_CALCULATION'),basis=await f.records('OPERATIONAL_COST_BASIS');f.unpublish();f.sealedFinalCostIn.mockResolvedValue('WAIT');
    const view=await f.read();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(view.sealedCalculation).toBeNull();expect(f.sealedFinalCostIn).toHaveBeenCalledExactlyOnceWith(expect.anything(),f.input,work.joinedEvidence);
    await f.cost.finishAttempt(f.input);expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual(closure);expect(await f.records('OPERATIONAL_COST_CALCULATION')).toEqual(calculations);expect(await f.records('OPERATIONAL_COST_BASIS')).toEqual(basis);await f.untouched();
  });
  it('requires the separate FINAL_COMMIT helper seal before final-stage closure',async()=>{
    const f=await fixture('TYPESET');await f.cost.prepare(f.input,f.firstClaim);f.set(await f.workset());await f.ended();await f.cost.finishAttempt(f.input);
    expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);expect((await f.read()).costUsd).toBeNull();f.seal();await f.cost.finishAttempt(f.input);expect((await f.read()).state).toBe('CONFIRMED');expect(f.checkpoints.finalCommitIn).toHaveBeenCalled();await f.untouched();
  });
});

describe.sequential('whole-stage SQL rejects invalid original work references',()=>{
  it.each(['null','missing','wrong_digest','duplicate','input','basis','calculation','closure','cross_execution','cross_account','wrong_protected_ref','oversized','missing_termination'])('%s',async(kind)=>{
    const f=await fixture('OCR','0.001',true);await f.cost.prepare(f.input,f.firstClaim);expect(await f.execution.preflight(f.claim,f.input)).toBe(true);
    let foreign:CostEvidenceRef|null=null;
    if(kind==='cross_execution'){const other=await f.otherInput();foreign=await f.put('OPERATIONAL_HOLD',{ownedForeignEnd:randomUUID()},other);}
    let invalid:CostEvidenceRef|null=null;
    if(kind==='wrong_protected_ref'){
      const evidenceId=randomUUID(),value={ownedInvalidProtectedRef:randomUUID()},evidenceDigest=digest(value);
      await f.worker.accountTransaction(f.input.accountId!,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_SOURCE',$4,'wrong-owned-ref',$5)",[f.input.accountId,evidenceId,f.input.executionId,evidenceDigest,JSON.stringify(value)]),true);
      invalid={evidenceId,evidenceDigest};
    }
    if(kind==='cross_account'){
      const now=(await f.admin.pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
      const foreignSeed=await seedWorkspace(f.admin,await seedIdentity(f.admin,now),1,now),foreignWorkspace=new WorkspaceService(f.admin,{...f.policy,executionLimit:undefined});
      const actor={accountId:foreignSeed.accountId,sessionId:foreignSeed.sessionId,tabId:foreignSeed.tabId,ownerCapability:foreignSeed.ownerCapability};
      const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:foreignSeed.contextId,contextGeneration:'1',tabId:foreignSeed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
      const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
      await foreignWorkspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
      await foreignWorkspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:foreignSeed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
      const foreignRequest=(await f.admin.pool.query('SELECT request_id FROM manga_web.processing_requests WHERE account_id=$1',[foreignSeed.accountId])).rows[0].request_id,foreignExecution=randomUUID();
      await f.admin.pool.query("INSERT INTO manga_web.executions(account_id,execution_id,request_id,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,state,revision) SELECT $3,$4,$5,logical_step_id,contract_version,input_digest,input_asset_refs,claim_generation,'UNKNOWN',revision FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2",[f.input.accountId,f.input.executionId,foreignSeed.accountId,foreignExecution,foreignRequest]);
      const evidenceId=randomUUID(),value={ownedOtherAccount:foreignSeed.accountId,executionId:foreignExecution},evidenceDigest=digest(value);
      await f.admin.pool.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_SOURCE',$4,$2::uuid::text,$5)",[foreignSeed.accountId,evidenceId,foreignExecution,evidenceDigest,JSON.stringify(value)]);
      invalid={evidenceId,evidenceDigest};
      expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[foreignSeed.accountId,evidenceId])).rows[0].n).toBe(1);
    }
    const inputRow=(await f.records('INPUT'))[0],basisRow=(await f.records('OPERATIONAL_COST_BASIS'))[0];
    f.set(await f.workset());
    const original=f.worker.transaction.bind(f.worker);
    vi.spyOn(f.worker,'transaction').mockImplementation(async<T>(run:(client:PoolClient)=>Promise<T>)=>original(async client=>{
      const controlled=Object.create(client) as PoolClient,query=client.query.bind(client);
      controlled.query=(async(sql:string,values?:unknown[])=>{
        if(typeof sql==='string'&&sql.startsWith('INSERT INTO execution_evidence')&&values?.[3]==='OPERATIONAL_COST_CLOSURE'){
          values=[...values];const body=JSON.parse(String(values[6])),work=body.value.workSet,first=work.joinedEvidence[0];
          if(kind==='null')work.joinedEvidence=[null];
          if(kind==='missing')work.joinedEvidence=[{evidenceId:randomUUID(),evidenceDigest:'a'.repeat(64)}];
          if(kind==='wrong_digest')first.evidenceDigest='d'.repeat(64);
          if(kind==='duplicate')work.joinedEvidence.push({...first});
          if(kind==='input')work.joinedEvidence=[{evidenceId:inputRow.evidence_id,evidenceDigest:inputRow.evidence_digest}];
          if(kind==='basis')work.joinedEvidence=[{evidenceId:basisRow.evidence_id,evidenceDigest:basisRow.evidence_digest}];
          if(kind==='calculation')work.joinedEvidence=[{evidenceId:body.value.calculationEvidenceId,evidenceDigest:body.value.calculationEvidenceDigest}];
          if(kind==='closure')work.joinedEvidence=[{evidenceId:values[1],evidenceDigest:values[4]}];
          if(kind==='cross_execution')work.joinedEvidence=[foreign];
          if(kind==='cross_account'||kind==='wrong_protected_ref')work.joinedEvidence=[invalid];
          if(kind==='oversized')body.value.ownedOversizePadding='p'.repeat(1048576);
          if(kind==='missing_termination')work.terminationEvidence=[];
          body.value.workSetDigest=digest(work);values[4]=digest(body);values[6]=JSON.stringify(body);
        }
        return query(sql,values);
      }) as PoolClient['query'];
      return run(controlled);
    }));
    await f.cost.finishAttempt(f.input);
    const calculation=(await f.journal.lookup(f.input)).calculations.find(row=>row.result.state==='CONFIRMED')!;
    const reason=await f.worker.accountTransaction(f.input.accountId!,async tx=>{
      await tx.client.query("INSERT INTO cost_items(account_id,cost_item_id,execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at) VALUES($1,$2,$3,'STAGE_TOTAL',0,'CONFIRMED','0.016',$4,$5,$6)",[f.input.accountId,randomUUID(),f.input.executionId,'execution-evidence:'+calculation.evidenceId+':'+calculation.evidenceDigest,f.snapshot.basisVersion,tx.now]);
      return (await tx.client.query("SELECT manga_web.reconcile_execution_limits($1) AS decision",[f.input.executionId])).rows[0].decision.reason;
    },true);
    expect(reason).toBe('LIMIT_EVIDENCE_CONFLICT');
    expect((await f.admin.pool.query("SELECT actual_usd::text FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2",[f.input.accountId,f.input.executionId])).rows).toEqual([{actual_usd:'0.016000000000'}]);
    expect((await f.admin.pool.query("SELECT count(*)::integer AS n FROM manga_web.execution_limit_expenses WHERE account_id=$1",[f.input.accountId])).rows[0].n).toBe(0);
    expect((await f.admin.pool.query("SELECT state,halt_reason FROM manga_web.execution_limit_authority")).rows[0]).toEqual({state:'HALTED',halt_reason:'LIMIT_EVIDENCE_CONFLICT'});
    expect(f.provider.calls).toHaveLength(0);
  });
});

describe('whole-stage SQL keeps preparation cost when the model did not start',()=>{
  it('keeps the original permit held until the full preparation cost is sealed and then records it once',async()=>{
    const f=await fixture('OCR','0.001',true);await f.cost.prepare(f.input,f.firstClaim);expect(await f.execution.preflight(f.claim,f.input)).toBe(true);
    const projector=new ExecutionService(f.worker,f.provider,f.policy,{},undefined,f.cost);
    await projector.observe(f.input.accountId!,f.input.executionId,{evidenceId:randomUUID(),outcome:'NOT_STARTED',started:false,costUsd:null,usageConfirmed:false,finishReason:'OWNED_NOT_STARTED',providerRef:null,data:null});
    const before=(await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0];
    expect.soft(before).toEqual({capacity_released_at:null,budget_resolved_at:null});
    const reservation=(await f.admin.pool.query('SELECT state,remaining_usd::text FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[f.input.accountId,f.input.requestId])).rows[0];
    expect.soft(reservation).toEqual({state:'HELD',remaining_usd:'1.000000000000'});
    const work=await f.workset();work.facts.provider!.actualUsd='0';f.set(work);await f.cost.finishAttempt(f.input);expect((await f.read()).state).toBe('CONFIRMED');expect((await f.read()).costUsd).toBe('0.006000000000');
    const reason=await f.worker.accountTransaction(f.input.accountId!,async tx=>{await projector.reconcileOperationalCostIn(tx,f.input);return (await tx.client.query('SELECT manga_web.reconcile_execution_limits($1) AS decision',[f.input.executionId])).rows[0].decision.reason;},true);
    expect.soft(reason).toBe('RECONCILED');
    const expense=(await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows;
    expect.soft(expense).toEqual([{actual_usd:'0.006000000000'}]);
    expect.soft((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'OPEN',halt_reason:null});
    const after=(await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at,capacity_evidence_id FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0];
    expect(after.capacity_released_at).not.toBeNull();expect(after.budget_resolved_at).not.toBeNull();
    const closure=(await f.records('OPERATIONAL_COST_CLOSURE'))[0];expect(after.capacity_evidence_id).toBe(closure.evidence_id);expect(after.capacity_released_at).toEqual((await f.admin.pool.query('SELECT received_at FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.input.accountId,closure.evidence_id])).rows[0].received_at);
    const saved=(await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows;
    await f.worker.accountTransaction(f.input.accountId!,tx=>projector.reconcileOperationalCostIn(tx,f.input),true);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual(saved);expect(f.provider.calls).toHaveLength(0);
  });
});

describe('whole-stage SQL preserves whole-cost contradiction and over-bound facts',()=>{
  it('halts a contradictory NOT_STARTED with an original START while original whole cost stays unconfirmed',async()=>{
    const f=await fixture('OCR','0.001',true);await f.cost.prepare(f.input,f.firstClaim);expect(await f.execution.preflight(f.claim,f.input)).toBe(true);const projector=new ExecutionService(f.worker,f.provider,f.policy,{},undefined,f.cost);
    await projector.started(f.input.accountId!,f.input.executionId,randomUUID());
    await projector.observe(f.input.accountId!,f.input.executionId,{evidenceId:randomUUID(),outcome:'NOT_STARTED',started:false,costUsd:null,usageConfirmed:false,finishReason:'OWNED_CONTRADICTORY_NOT_STARTED',providerRef:null,data:null});
    const work=await f.workset();work.facts.provider!.actualUsd='0';f.set(work);await f.cost.finishAttempt(f.input);
    const reason=await f.worker.accountTransaction(f.input.accountId!,async tx=>{await projector.reconcileOperationalCostIn(tx,f.input);return (await tx.client.query('SELECT manga_web.reconcile_execution_limits($1) AS decision',[f.input.executionId])).rows[0].decision.reason;},true);
    expect(reason).toBe('LIMIT_EVIDENCE_CONFLICT');expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'HALTED',halt_reason:'LIMIT_EVIDENCE_CONFLICT'});
    expect((await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows[0]).toEqual({capacity_released_at:null,budget_resolved_at:null});
    expect((await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual([]);expect((await f.read()).state).toBe('UNCONFIRMED');expect((await f.read()).sealedCalculation).toBeNull();expect(await f.records('OPERATIONAL_COST_CLOSURE')).toEqual([]);expect(f.provider.calls).toHaveLength(0);
  });
  it('records the full original amount beyond the stage bound and stops issuance without clamping',async()=>{
    const f=await fixture('OCR','0.001',true);await f.cost.prepare(f.input,f.firstClaim);expect(await f.execution.preflight(f.claim,f.input)).toBe(true);const work=await f.workset();work.facts.provider!.actualUsd='1.01';f.set(work);await f.cost.finishAttempt(f.input);const projector=new ExecutionService(f.worker,f.provider,f.policy,{},undefined,f.cost);
    const reason=await f.worker.accountTransaction(f.input.accountId!,async tx=>{await projector.reconcileOperationalCostIn(tx,f.input);return (await tx.client.query('SELECT manga_web.reconcile_execution_limits($1) AS decision',[f.input.executionId])).rows[0].decision.reason;},true);
    expect(reason).toBe('LIMIT_ACTUAL_OVER_BOUND');expect((await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual([{actual_usd:'1.016000000000'}]);
    expect((await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2',[f.input.accountId,f.input.executionId])).rows).toEqual([{actual_usd:'1.016000000000'}]);expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'HALTED',halt_reason:'LIMIT_ACTUAL_OVER_BOUND'});expect(f.provider.calls).toHaveLength(0);
  });
});
