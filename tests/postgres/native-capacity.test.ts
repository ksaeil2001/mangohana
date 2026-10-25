import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import pg from 'pg';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import canonicalize from 'canonicalize';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {sha256,digest} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {nativeKernelImplementationDigest} from '../../packages/native/src/identity.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeTarget,NativeGateway} from '../../packages/native/src/gateway.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';
import {FileObjectStore} from '../../packages/storage/src/objects.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent,type NativeJobObservation} from '../../packages/domain/src/native-jobs.js';
import {NativeCapacityOperator,NativeCapacityStore,validateNativeCapacityConfiguration,type NativeCapacityConfiguration,type NativeCapacityAdmission,type NativeCapacityProof,type OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';
import {validateOwnedExecutionLimitProfile,type ExecutionLimitReference,type OwnedExecutionLimitProfile} from '../../packages/domain/src/execution-limits.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,type StageInput,type Observation} from '../../packages/domain/src/provider.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';
import {ownedNativePng,ownedNativePngSha256} from '../fixtures/native-images.js';

import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {NativeReceiptStore} from '../../packages/domain/src/native-receipts.js';
import {guardWindowsNativeIo,windowsNativeFixture,windowsFrameLimits,type WindowsNativeFixture} from '../fixtures/windows-native.js';

const connections:Database[]=[],operators:pg.Client[]=[];
afterEach(async()=>{for(const client of operators.splice(0).reverse())await client.end();for(const db of connections.splice(0).reverse())await db.close();});
type Workspace=Awaited<ReturnType<typeof seedWorkspace>>;
async function fixture(options:{slots?:number;accounts?:number;execution?:boolean}={}){
  const started=Date.now();const trace=(phase:string)=>console.info(JSON.stringify({nativeCapacityTrace:phase,elapsedMilliseconds:Date.now()-started,physicalChildren:0,realProviderCalls:0}));trace('fixture_start');
  const admin=await testDatabase();connections.push(admin);trace('migrations_done');
  const api=await provisionLocalService(admin,'trio_web_api'),workers=await Promise.all([provisionLocalService(admin,'trio_web_worker'),provisionLocalService(admin,'trio_web_worker')]);connections.push(api,...workers);
  for(const db of [api,...workers])await db.validateServiceRole();
  const login='trio_native_operator_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('base64url');
  await admin.pool.query(`CREATE ROLE "${login}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);await admin.pool.query(`GRANT trio_web_operator TO "${login}"`);
  const url=new URL(admin.connectionString);url.username=login;url.password=password;const client=new pg.Client({connectionString:url.toString()});await client.connect();operators.push(client);await client.query('SET ROLE trio_web_operator');
  const operator=new NativeCapacityOperator(client,login),key=generateKeyPairSync('ed25519');
  const profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'owned-native-capacity-v1',maxSlots:options.slots??1,nativeProfileDigest:digest(syntheticProfile),kernelDigest:nativeKernelImplementationDigest(),controllerId:randomUUID(),keyVersion:'owned-key-v1',environmentDigest:sha256('owned fixture environment'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:capacity/state-transitions']};
  const profileId=randomUUID(),inserted=(await client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
  const capacity:NativeCapacityConfiguration={reference:{kind:'OWNED_FIXTURE',profileId,profileDigest:inserted.profile_digest,profileVersion:profile.version},profile};
  await client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  const executionProfile=validateOwnedExecutionLimitProfile({kind:'OWNED_FIXTURE',version:'owned-execution-limits-v1',maxSlots:options.slots??1,requestLimitUsd:'10',dailyLimitUsd:'100',fullBoundUsd:'10',stages:{OCR:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:ocr/full-cost']},TRANSLATE:{boundUsd:'2',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:translate/full-cost']}},fullBoundEvidenceRefs:['owned-fixture:request/full-cost-including-retries'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+23*3600000).toISOString()}} satisfies OwnedExecutionLimitProfile);
  const executionProfileId=randomUUID(),executionSeal=(await client.query<{profile_digest:string}>(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest`,[executionProfileId,JSON.stringify(executionProfile),executionProfile.version,executionProfile.maxSlots,executionProfile.requestLimitUsd,executionProfile.dailyLimitUsd,executionProfile.fullBoundUsd,JSON.stringify(executionProfile.stages),JSON.stringify(executionProfile.fullBoundEvidenceRefs),executionProfile.window!.kind,executionProfile.window!.startAt,executionProfile.window!.endAt])).rows[0];
  const executionReference:ExecutionLimitReference={kind:'OWNED_FIXTURE',profileId:executionProfileId,profileDigest:executionSeal.profile_digest,profileVersion:executionProfile.version};
  await client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[executionProfileId]);
  const seeds:Workspace[]=[];for(let index=0;index<(options.accounts??2);index++){const sampled=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;seeds.push(await seedWorkspace(admin,await seedIdentity(admin,sampled),1,sampled));}
  const provider=new SyntheticProvider(),policy:RequestPolicy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:executionReference.profileVersion,executionLimit:executionReference};
  const workspace=new WorkspaceService(api,policy),services=workers.map(db=>new ExecutionService(db,provider,policy));
  if(options.execution)for(const seed of seeds){
    const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
    const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
    const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
    await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
    await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  }
  trace('fixture_ready');return {admin,api,workers,client,operator,key,profile,capacity,seeds,services,provider,policy,executionReference,trace,admissions:new Map<string,NativeCapacityAdmission>()};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function ownerCapture(f:Fixture,seed:Workspace){const row=(await f.admin.pool.query('SELECT generation,owner_revision,workspace_revision FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId])).rows[0];return {contextId:seed.contextId,contextGeneration:row.generation as string,ownerSessionId:seed.sessionId,ownerTabId:seed.tabId,ownerRevision:row.owner_revision as string,workspaceRevision:row.workspace_revision as string};}
async function uploadIntent(f:Fixture,seed=f.seeds[0]){
  const targetId=randomUUID(),capture=await ownerCapture(f,seed);
  await f.admin.pool.query(`INSERT INTO manga_web.uploads(account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,owner_revision,context_generation,owner_session_id,owner_tab_id,captured_workspace_revision) SELECT $1,$2,$3,'PAGE_IMAGES',0,'PREPARED',n,n+interval '1 hour',$4,$5,$6,$7,$8 FROM(SELECT clock_timestamp() n)t`,[seed.accountId,targetId,seed.contextId,capture.ownerRevision,capture.contextGeneration,seed.sessionId,seed.tabId,capture.workspaceRevision]);
  const value={version:1 as const,jobId:randomUUID(),task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1' as const,profileDigest:f.profile.nativeProfileDigest,inputDigest:sha256(randomUUID()),operationInputDigest:sha256(randomUUID()),parentInstanceId:randomUUID(),targetKind:'UPLOAD' as const,targetId,semanticCaptureDigest:sha256('owned-upload-capture'),protectedOwnerCapture:capture,claim:{generation:'0',ownerId:randomUUID(),workItemId:null}};
  return {...value,logicalOperationKey:nativeLogicalOperationKey(value)};
}
function store(f:Fixture,accountId:string,worker=false){return new NativeJobStore(worker?f.workers[0]:f.api,accountId);}
async function sourceCapture(f:Fixture,input:StageInput){
  const rows=(await f.admin.pool.query<{evidence_id:string}>('SELECT evidence_id FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'INPUT\'',[input.accountId,input.executionId])).rows;expect(rows).toHaveLength(1);
  return {executionId:input.executionId,inputEvidenceId:rows[0].evidence_id,stageInputDigest:input.inputDigest};
}
async function admit(f:Fixture,accountId:string,intent:NativeJobIntent,worker=false,capacity?:NativeCapacityAdmission){
  let captured:NativeCapacityAdmission=capacity??f.capacity;
  if(!capacity&&intent.targetKind==='EXECUTION'){
    const original=(await f.admin.pool.query<{protected_observation:StageInput}>('SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'INPUT\'',[accountId,intent.targetId])).rows;expect(original).toHaveLength(1);captured={...f.capacity,sourceInput:await sourceCapture(f,original[0].protected_observation)};
  }
  const decision=await store(f,accountId,worker).beforeIntent(intent,false,captured);f.admissions.set(intent.jobId,structuredClone(captured));return decision;
}
function go(f:Fixture,accountId:string,intent:NativeJobIntent,worker=false){return store(f,accountId,worker).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.admissions.get(intent.jobId));}
async function rootCount(f:Fixture){return Number((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_roots()')).rows[0].n);}
type Prepared={service:ExecutionService;claim:Claim;input:StageInput};
async function nextClaim(service:ExecutionService,kind:'DISPATCH'|'APPLY'):Promise<Claim>{
  for(let index=0;index<8;index++){const claim=await service.claim();expect(claim).not.toBeNull();if(claim!.kind==='SETTLE'){expect(await service.settle(claim!.accountId,claim!.ref.costItemId)).toBe(true);await service.finish(claim!,true);continue;}expect(claim!.kind).toBe(kind);return claim!;}
  throw new Error('OWNED_FIXTURE_WORK_BOUND_EXCEEDED');
}
async function prepare(service:ExecutionService):Promise<Prepared>{const claim=await nextClaim(service,'DISPATCH'),input=await service.authorize(claim);expect(input).not.toBeNull();return {service,claim,input:input!};}
async function executionIntent(f:Fixture,p:Prepared){const seed=f.seeds.find(s=>s.accountId===p.claim.accountId)!;const value={version:1 as const,jobId:randomUUID(),task:'GEMINI_PREPARE' as const,taskVersion:'native-pure-v1' as const,profileDigest:f.profile.nativeProfileDigest,inputDigest:sha256(randomUUID()),operationInputDigest:sha256(randomUUID()),parentInstanceId:randomUUID(),targetKind:'EXECUTION' as const,targetId:p.input.executionId,semanticCaptureDigest:sha256('owned-input-phase-capture'),protectedOwnerCapture:await ownerCapture(f,seed),claim:{generation:p.claim.generation,ownerId:p.service.workerId,workItemId:p.claim.workId}};return {...value,logicalOperationKey:nativeLogicalOperationKey(value)};}
async function prove(f:Fixture,accountId:string,intent:NativeJobIntent,worker=false,kind:'NO_CHILD_CREATED'|'DIRECT_CHILD_ONLY'='DIRECT_CHILD_ONLY'){
  const own=store(f,accountId,worker),observedId=randomUUID();
  const observation:NativeJobObservation={version:1,parentInstanceId:intent.parentInstanceId,event:'TERMINATION',code:'OK',resultDigest:null,termination:{jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:kind==='DIRECT_CHILD_ONLY',startedComputation:kind==='DIRECT_CHILD_ONLY',directChildClosed:kind==='DIRECT_CHILD_ONLY',subtreeTerminationConfirmed:false,operationJoined:true,kind,isolation:'OWNED_FIXTURE'}};
  const decision=await own.observe(observedId,observation),recovery=await new NativeCapacityStore(worker?f.workers[0]:f.api,accountId).recover(),reservation=recovery.find(r=>r.jobId===intent.jobId)!;expect(reservation).toBeDefined();
  const proof:NativeCapacityProof={version:1,kind:'OWNED_FIXTURE',accountId,capacityReservationId:reservation.capacityReservationId,adoptionId:reservation.adoptionId!,jobId:intent.jobId,inputDigest:intent.inputDigest,nativeProfileDigest:intent.profileDigest,parentInstanceId:intent.parentInstanceId,controllerId:f.profile.controllerId,keyVersion:f.profile.keyVersion,environmentDigest:f.profile.environmentDigest,terminationObservationId:observedId,terminationObservationDigest:decision.observationDigest!,goAttempted:observation.termination.goAttempted,startedComputation:observation.termination.startedComputation,operationJoined:true,directChildClosed:observation.termination.directChildClosed,subtreeTerminationConfirmed:false,terminationKind:kind};
  const canonical=canonicalize(proof)!;return {proof,signed:{canonical,signature:sign(null,Buffer.from(canonical),f.key.privateKey).toString('base64')},reservation,observation};
}
const failure=(usd:string|null='1'):Observation=>({evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:usd,usageConfirmed:usd!==null,finishReason:'OWNED_CONFIRMED_TERMINAL',providerRef:null,data:null});
async function checkpointPair(f:Fixture){
  const inputs:StageInput[]=[];
  for(let index=0;index<2;index++){
    const p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(true);
    expect(p.input.stage).toBe(index===0?'OCR':'TRANSLATE');const observation=await p.service.validated(p.input,f.provider.success(p.input),p.claim);expect(observation.outcome).toBe('SUCCESS');expect(observation.stageOutput).toBeDefined();
    await p.service.observe(p.claim.accountId,p.input.executionId,observation,false,p.claim);await p.service.finish(p.claim,false,0);inputs.push(p.input);
  }
  const checkpoints=(await f.admin.pool.query<{checkpoint_id:string;execution_id:string}>('SELECT checkpoint_id,execution_id FROM manga_web.checkpoints WHERE account_id=$1',[f.seeds[0].accountId])).rows;expect(checkpoints).toHaveLength(2);
  const verified=(await f.admin.pool.query("SELECT c.checkpoint_id,c.verification_state,c.output_envelope->'stageOutput'->>'checkpointId' AS envelope_id,e.state FROM manga_web.checkpoints c JOIN manga_web.executions e USING(account_id,execution_id) WHERE c.account_id=$1",[f.seeds[0].accountId])).rows;expect(verified.every(row=>row.state==='SUCCEEDED'&&row.verification_state==='VERIFIED'&&row.envelope_id===row.checkpoint_id)).toBe(true);
  const targets:NativeTarget[]=[],gateway:NativeGateway={forTarget:target=>{targets.push(structuredClone(target));return {} as NativeFacade;},stopClaims:()=>{},idle:async()=>{}};
  const service=new ExecutionService(f.workers[0],f.provider,f.policy,{},gateway),claim=await nextClaim(service,'DISPATCH');
  return {inputs,checkpoints,targets,service,claim};
}
async function checkpointIntent(f:Fixture,p:Pick<Prepared,'service'|'claim'>,input:StageInput,currentRequestId=input.requestId){
  const base=await executionIntent(f,{...p,input}),value={...base,targetKind:'REQUEST_CHECKPOINT' as const,targetId:currentRequestId};return {...value,logicalOperationKey:nativeLogicalOperationKey(value)};
}

describe('owning PG roles and private native global capacity',()=>{
  it('checkpoint priority refuses an unselected current execution when an explicit reuse exists',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await checkpointPair(f),original=p.inputs[0],selected=p.checkpoints.find(row=>row.execution_id===p.inputs[1].executionId)!;
    await f.admin.pool.query('UPDATE manga_web.request_steps SET reuse_checkpoint_id=$3 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=\'OCR\'',[original.accountId,original.requestId,selected.checkpoint_id]);
    await expect(p.service.nativeCallContext(p.claim,original,'CHECKPOINT')).rejects.toMatchObject({code:'CHECKPOINT_DEPENDENCY_INVALID'});expect(p.targets).toEqual([]);expect(f.provider.calls).toEqual([]);
  });
  it('exact source tuple rejects another INPUT row or StageInput digest before admission and GO',async()=>{
    const f=await fixture({execution:true,slots:2}),p=await prepare(f.services[0]),q=await prepare(f.services[1]),intent=await executionIntent(f,p),original=await sourceCapture(f,p.input),other=await sourceCapture(f,q.input),account=p.claim.accountId;
    for(const sourceInput of [{...original,inputEvidenceId:other.inputEvidenceId},{...original,executionId:other.executionId},{...original,stageInputDigest:sha256('changed original StageInput')}])await expect(admit(f,account,intent,true,{...f.capacity,sourceInput})).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});
    await expect(admit(f,account,intent,true,f.capacity)).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});expect(await rootCount(f)).toBe(0);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_intents')).rows[0].n).toBe('0');
    await admit(f,account,intent,true,{...f.capacity,sourceInput:original});const recovered=(await new NativeCapacityStore(f.workers[0],account).recover())[0];expect(recovered.sourceInput).toEqual(original);
    for(const sourceInput of [{...original,inputEvidenceId:other.inputEvidenceId},{...original,stageInputDigest:sha256('replacement after admission')}])await expect(store(f,account,true).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,{...f.capacity,sourceInput})).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});
    expect((await new NativeCapacityStore(f.workers[0],account).recover())[0]).toMatchObject({capacityReservationId:recovered.capacityReservationId,sourceInput:original,go:'UNCONSUMED',state:'HELD'});await go(f,account,intent,true);expect((await new NativeCapacityStore(f.workers[0],account).recover())[0].go).toBe('CONSUMED');expect(f.provider.calls).toEqual([]);
  });
  it('source tuple cannot adopt an old intent under a reclaimed parent generation',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]),intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);
    const generation=(BigInt(p.claim.generation)+1n).toString(),ownerId=randomUUID();await f.admin.pool.query('UPDATE manga_web.work_items SET claim_generation=$3,claim_owner=$4 WHERE account_id=$1 AND work_item_id=$2',[p.claim.accountId,p.claim.workId,generation,ownerId]);
    await expect(go(f,p.claim.accountId,intent,true)).rejects.toMatchObject({code:'NATIVE_TARGET_FENCE_REJECTED'});await expect(store(f,p.claim.accountId,true).beforeGo(intent.jobId,intent.parentInstanceId,{...intent.claim,generation,ownerId},intent.protectedOwnerCapture,f.admissions.get(intent.jobId))).rejects.toMatchObject({code:'NATIVE_INTENT_FENCE_REJECTED'});
    expect((await new NativeCapacityStore(f.workers[0],p.claim.accountId).recover())[0]).toMatchObject({jobId:intent.jobId,state:'HELD',go:'UNCONSUMED'});expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('0');expect(f.provider.calls).toEqual([]);
  });
  it('multiple same request checkpoints bind each original INPUT without guessing a unique row',async()=>{
    const f=await fixture({execution:true,accounts:1,slots:2}),p=await checkpointPair(f),account=p.claim.accountId,intents=await Promise.all(p.inputs.map(input=>checkpointIntent(f,p,input))),sources=await Promise.all(p.inputs.map(input=>sourceCapture(f,input)));
    for(let index=0;index<2;index++){await p.service.nativeCallContext(p.claim,p.inputs[index],'CHECKPOINT');expect(p.targets.at(-1)?.sourceInput).toEqual(sources[index]);await admit(f,account,intents[index],true,{...f.capacity,sourceInput:sources[index]});}
    const reservations=await new NativeCapacityStore(f.workers[0],account).recover();expect(reservations).toHaveLength(2);expect(new Set(reservations.map(row=>row.sourceInput!.inputEvidenceId)).size).toBe(2);expect(reservations.every(row=>Object.keys(row.protectedIntent).length===14&&!Object.hasOwn(row.protectedIntent,'sourceInput'))).toBe(true);
    await expect(store(f,account,true).beforeGo(intents[0].jobId,intents[0].parentInstanceId,intents[0].claim,intents[0].protectedOwnerCapture,{...f.capacity,sourceInput:sources[1]})).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});for(const intent of intents)await go(f,account,intent,true);
    expect(await rootCount(f)).toBe(2);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('2');expect(f.provider.calls).toEqual([]);
  });
  it('checkpoint source priority and changed selection reject GO while preserving the original HELD tuple',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await checkpointPair(f),account=p.claim.accountId,first=p.inputs[0],second=p.inputs[1],firstCheckpoint=p.checkpoints.find(row=>row.execution_id===first.executionId)!,secondCheckpoint=p.checkpoints.find(row=>row.execution_id===second.executionId)!;
    await f.admin.pool.query('UPDATE manga_web.request_steps SET reuse_checkpoint_id=$3 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=\'OCR\'',[account,first.requestId,secondCheckpoint.checkpoint_id]);
    const rejected=await checkpointIntent(f,p,first),intent=await checkpointIntent(f,p,second),sourceInput=await sourceCapture(f,second);await expect(admit(f,account,rejected,true,{...f.capacity,sourceInput:await sourceCapture(f,first)})).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});await admit(f,account,intent,true,{...f.capacity,sourceInput});
    await f.admin.pool.query('UPDATE manga_web.request_steps SET reuse_checkpoint_id=$3 WHERE account_id=$1 AND request_id=$2',[account,first.requestId,firstCheckpoint.checkpoint_id]);await expect(go(f,account,intent,true)).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});
    expect((await new NativeCapacityStore(f.workers[0],account).recover())[0]).toMatchObject({jobId:intent.jobId,sourceInput,state:'HELD',go:'UNCONSUMED'});expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('0');expect(f.provider.calls).toEqual([]);
  });
  it('retry accepts its selected earlier request checkpoint and rejects the unlinked failed INPUT',async()=>{
    const f=await fixture({execution:true,accounts:1}),first=await prepare(f.services[0]);expect(await first.service.preflight(first.claim,first.input)).toBe(true);const success=await first.service.validated(first.input,f.provider.success(first.input),first.claim);expect(success.outcome).toBe('SUCCESS');await first.service.observe(first.claim.accountId,first.input.executionId,success,false,first.claim);await first.service.finish(first.claim,false,0);
    const failed=await prepare(f.services[0]);expect(await failed.service.preflight(failed.claim,failed.input)).toBe(true);await failed.service.observe(failed.claim.accountId,failed.input.executionId,failure(),false,failed.claim);await failed.service.finish(failed.claim,true);
    const seed=f.seeds[0],owner=await ownerCapture(f,seed),workspace=new WorkspaceService(f.api,f.policy),reply=await workspace.handle({accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability},{commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:owner.contextGeneration!,tabId:seed.tabId,expectedOwnerRevision:owner.ownerRevision!,expectedWorkspaceRevision:owner.workspaceRevision!},operation:{kind:'RETRY_REQUEST',payload:{requestId:first.input.requestId}}}),requestId=reply.reply.operationRef.id!;
    const targets:NativeTarget[]=[],gateway:NativeGateway={forTarget:target=>{targets.push(structuredClone(target));return {} as NativeFacade;},stopClaims:()=>{},idle:async()=>{}},service=new ExecutionService(f.workers[0],f.provider,f.policy,{},gateway),claim=await nextClaim(service,'DISPATCH');expect(claim.ref.requestId).toBe(requestId);expect(requestId).not.toBe(first.input.requestId);
    const sourceInput=await sourceCapture(f,first.input);await service.nativeCallContext(claim,first.input,'CHECKPOINT',requestId);expect(targets.at(-1)).toMatchObject({targetKind:'REQUEST_CHECKPOINT',targetId:requestId,sourceInput});const intent=await checkpointIntent(f,{service,claim},first.input,requestId);await admit(f,seed.accountId,intent,true,{...f.capacity,sourceInput});
    const unlinked=await checkpointIntent(f,{service,claim},failed.input,requestId);await expect(admit(f,seed.accountId,unlinked,true,{...f.capacity,sourceInput:await sourceCapture(f,failed.input)})).rejects.toMatchObject({code:'NATIVE_CAPACITY_INPUT_MISMATCH'});await go(f,seed.accountId,intent,true);expect((await new NativeCapacityStore(f.workers[0],seed.accountId).recover())[0]).toMatchObject({jobId:intent.jobId,sourceInput,state:'HELD',go:'CONSUMED'});expect(f.provider.calls).toEqual([]);
  });
  it('P2 payload binding rejects kernel controller key and environment swaps before intent or GO',async()=>{
    const f=await fixture({accounts:1}),intent=await uploadIntent(f),other=generateKeyPairSync('ed25519');
    for(const altered of [{...f.profile,kernelDigest:sha256('different kernel')},{...f.profile,controllerId:randomUUID()},{...f.profile,keyVersion:'other-key'},{...f.profile,environmentDigest:sha256('different environment')},{...f.profile,publicKeySpki:other.publicKey.export({format:'der',type:'spki'}).toString('base64')}]){
      const mismatched=validateNativeCapacityConfiguration({reference:f.capacity.reference,profile:altered},altered.nativeProfileDigest,altered.kernelDigest);
      await expect(admit(f,f.seeds[0].accountId,intent,false,mismatched)).rejects.toMatchObject({code:'NATIVE_CAPACITY_PROFILE_MISMATCH'});
    }
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_intents')).rows[0].n).toBe('0');expect(await rootCount(f)).toBe(0);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('0');
  });
  it('P2 halted common authority denies GO and preserves the acknowledged HELD reservation',async()=>{
    const f=await fixture({accounts:1}),intent=await uploadIntent(f),account=f.seeds[0].accountId;await admit(f,account,intent);
    await f.client.query("UPDATE manga_web.execution_limit_authority SET state='HALTED',halt_reason='OWNED_COST_OVERRUN',revision=revision+1 WHERE singleton");
    await expect(store(f,account).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.capacity)).rejects.toMatchObject({code:'LIMIT_AUTHORITY_UNCONFIRMED'});
    expect(await rootCount(f)).toBe(1);expect((await new NativeCapacityStore(f.api,account).recover())[0]).toMatchObject({jobId:intent.jobId,state:'HELD',go:'UNCONSUMED'});
  });
  it('native native race serializes two accounts at the last shared slot without a ghost intent',async()=>{
    const f=await fixture(),intents=await Promise.all(f.seeds.map(seed=>uploadIntent(f,seed)));
    const outcomes=await Promise.allSettled(intents.map((intent,index)=>admit(f,f.seeds[index].accountId,intent)));
    expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(o=>o.status==='rejected')).toHaveLength(1);expect((outcomes.find(o=>o.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'NATIVE_CAPACITY_WAIT'});
    expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_intents')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_reservations')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('0');
  });
  it('native execution race uses the same total and global lock from both public admissions',async()=>{
    const f=await fixture({execution:true}),p=await prepare(f.services[0]),seed=f.seeds.find(s=>s.accountId!==p.claim.accountId)!,intent=await uploadIntent(f,seed);
    const [native,execution]=await Promise.all([admit(f,seed.accountId,intent).then(()=>true,error=>{expect(error).toMatchObject({code:'NATIVE_CAPACITY_WAIT'});return false;}),p.service.preflight(p.claim,p.input)]);
    expect(Number(native)+Number(execution)).toBe(1);expect(await rootCount(f)).toBe(1);expect(f.provider.calls).toEqual([]);
    const counts=(await f.admin.pool.query("SELECT (SELECT count(*) FROM manga_web.native_capacity_reservations WHERE state='HELD') AS native,(SELECT count(*) FROM manga_web.execution_capacity_permits WHERE capacity_released_at IS NULL) AS execution")).rows[0];expect(Number(counts.native)+Number(counts.execution)).toBe(1);
  });
  it('native first prevents the old execution path from ignoring standalone occupancy',async()=>{
    const f=await fixture({execution:true}),p=await prepare(f.services[0]),seed=f.seeds.find(s=>s.accountId!==p.claim.accountId)!,intent=await uploadIntent(f,seed);await admit(f,seed.accountId,intent);
    expect(await p.service.preflight(p.claim,p.input)).toBe(false);expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');expect(f.provider.calls).toEqual([]);
  });
  it('execution first prevents standalone native admission from creating an extra root',async()=>{
    const f=await fixture({execution:true}),p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(true);const seed=f.seeds.find(s=>s.accountId!==p.claim.accountId)!,intent=await uploadIntent(f,seed);
    await expect(admit(f,seed.accountId,intent)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_intents')).rows[0].n).toBe('0');expect(f.provider.calls).toEqual([]);
  });
  it('borrowed execution permits exactly one active child and counts its native occupancy once',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(true);const first=await executionIntent(f,p),second=await executionIntent(f,p);
    await admit(f,p.claim.accountId,first,true);await expect(admit(f,p.claim.accountId,second,true)).rejects.toMatchObject({code:'NATIVE_CAPACITY_EXECUTION_OCCUPIED'});
    expect(await rootCount(f)).toBe(1);const recovered=await new NativeCapacityStore(f.workers[0],p.claim.accountId).recover();expect(recovered).toHaveLength(1);expect(recovered[0]).toMatchObject({jobId:first.jobId,rootKind:'EXECUTION',executionId:p.input.executionId,terminationProofId:null});
    expect((await f.admin.pool.query('SELECT mode,execution_id FROM manga_web.native_capacity_adoptions')).rows).toEqual([{mode:'BORROW',execution_id:p.input.executionId}]);
  });
  it('provider terminal first keeps the native root until its independent proof is explicitly released',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(true);const intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);await go(f,p.claim.accountId,intent,true);
    await p.service.observe(p.claim.accountId,p.input.executionId,failure());expect((await f.admin.pool.query('SELECT capacity_released_at FROM manga_web.execution_capacity_permits')).rows[0].capacity_released_at).not.toBeNull();expect(await rootCount(f)).toBe(1);
    const sealed=await prove(f,p.claim.accountId,intent,true),confirmed=await f.operator.confirm(sealed.signed);expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations')).rows[0].state).toBe('HELD');
    await f.operator.release(p.claim.accountId,sealed.reservation.capacityReservationId,confirmed.proofId!);expect(await rootCount(f)).toBe(0);expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows).toEqual([{actual_usd:'1.000000000000'}]);expect((await f.admin.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(1);expect(f.provider.calls).toEqual([]);
  });
  it('native release first preserves the provider UNKNOWN capacity and independently held budget',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(true);const intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);await go(f,p.claim.accountId,intent,true);
    await p.service.observe(p.claim.accountId,p.input.executionId,{evidenceId:randomUUID(),outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'OWNED_UNCONFIRMED_PROVIDER',providerRef:null,data:null});
    const sealed=await prove(f,p.claim.accountId,intent,true),confirmed=await f.operator.confirm(sealed.signed);await f.operator.release(p.claim.accountId,sealed.reservation.capacityReservationId,confirmed.proofId!);
    expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits')).rows[0]).toEqual({capacity_released_at:null,budget_resolved_at:null});expect((await f.admin.pool.query('SELECT state,remaining_usd FROM manga_web.execution_budget_reservations')).rows[0]).toEqual({state:'HELD',remaining_usd:'10.000000000000'});
    await p.service.observe(p.claim.accountId,p.input.executionId,failure());expect(await rootCount(f)).toBe(0);expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows).toEqual([{actual_usd:'1.000000000000'}]);
  });
  it('standalone promotion keeps the original reservation and aliases exactly one execution without self wait',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]),intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);const original=(await new NativeCapacityStore(f.workers[0],p.claim.accountId).recover())[0];expect(original.rootKind).toBe('STANDALONE');expect(await rootCount(f)).toBe(1);
    await go(f,p.claim.accountId,intent,true);const sealed=await prove(f,p.claim.accountId,intent,true),confirmed=await f.operator.confirm(sealed.signed);expect(await rootCount(f)).toBe(1);
    await store(f,p.claim.accountId,true).observe(randomUUID(),{...sealed.observation,event:'RESULT',resultDigest:sha256('owned-success-before-provider-preflight')});
    expect(await p.service.preflight(p.claim,p.input)).toBe(true);expect(await rootCount(f)).toBe(1);const current=(await new NativeCapacityStore(f.workers[0],p.claim.accountId).recover())[0];expect(current).toMatchObject({capacityReservationId:original.capacityReservationId,adoptionId:original.adoptionId,jobId:intent.jobId,rootKind:'EXECUTION',executionId:p.input.executionId,state:'HELD',terminationProofId:confirmed.proofId});
    expect((await f.admin.pool.query('SELECT root_kind,state FROM manga_web.native_capacity_reservations')).rows).toEqual([{root_kind:'STANDALONE',state:'HELD'}]);expect((await f.admin.pool.query('SELECT mode,execution_id FROM manga_web.native_capacity_adoptions')).rows).toEqual([{mode:'PROMOTE',execution_id:p.input.executionId}]);
    await f.operator.release(p.claim.accountId,original.capacityReservationId,confirmed.proofId!);expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT capacity_released_at FROM manga_web.execution_capacity_permits')).rows[0].capacity_released_at).toBeNull();
  });
  it('unconfirmed standalone cannot promote or release when the owning execution preflights',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]),intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);
    expect(await p.service.preflight(p.claim,p.input)).toBe(false);expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_adoptions')).rows[0].n).toBe('0');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');expect((await f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations')).rows[0].state).toBe('HELD');
  });
  it('trusted no child proof without native RESULT keeps provider preflight waiting',async()=>{
    const f=await fixture({execution:true,accounts:1}),p=await prepare(f.services[0]),intent=await executionIntent(f,p);await admit(f,p.claim.accountId,intent,true);
    const sealed=await prove(f,p.claim.accountId,intent,true,'NO_CHILD_CREATED'),confirmed=await f.operator.confirm(sealed.signed);expect(confirmed.allowed).toBe(true);
    expect(await p.service.preflight(p.claim,p.input)).toBe(false);expect(await rootCount(f)).toBe(1);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_adoptions')).rows[0].n).toBe('0');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');
    expect((await f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations')).rows[0].state).toBe('HELD');expect((await f.admin.pool.query('SELECT hold_reasons FROM manga_web.processing_requests')).rows[0].hold_reasons).toContain('NATIVE_EXECUTION_UNCONFIRMED');expect(f.provider.calls).toEqual([]);
  });
  it('ACK restart keeps original identity and one GO while proof and release replays remain idempotent',async()=>{
    const f=await fixture({accounts:1}),intent=await uploadIntent(f),account=f.seeds[0].accountId;await expect((async()=>{await admit(f,account,intent);throw new Error('OWNED_ACK_LOST');})()).rejects.toThrow('OWNED_ACK_LOST');
    const fresh=await provisionLocalService(f.admin,'trio_web_api');connections.push(fresh);await fresh.validateServiceRole();const recovered=(await new NativeCapacityStore(fresh,account).recover())[0];expect(recovered).toMatchObject({jobId:intent.jobId,parentInstanceId:intent.parentInstanceId,go:'UNCONSUMED',state:'HELD'});
    await expect(new NativeJobStore(fresh,account).beforeGo(intent.jobId,randomUUID(),intent.claim,intent.protectedOwnerCapture,f.capacity)).rejects.toMatchObject({code:'NATIVE_INTENT_FENCE_REJECTED'});
    await store(f,account).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.capacity);await expect(new NativeJobStore(fresh,account).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.capacity)).rejects.toMatchObject({code:'NATIVE_GO_ALREADY_CONSUMED'});
    const sealed=await prove(f,account,intent),confirmed=await f.operator.confirm(sealed.signed),repeat=await f.operator.confirm(sealed.signed);expect(repeat).toMatchObject({reason:'PROOF_REPLAY',proofId:confirmed.proofId});await f.operator.release(account,recovered.capacityReservationId,confirmed.proofId!);expect(await f.operator.release(account,recovered.capacityReservationId,confirmed.proofId!)).toMatchObject({reason:'RELEASE_REPLAY'});
    expect(await rootCount(f)).toBe(0);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe('1');expect((await new NativeCapacityStore(fresh,account).recover())).toEqual([]);
    const another={...intent,jobId:randomUUID()};await expect(admit(f,account,another)).rejects.toMatchObject({code:'NATIVE_JOB_UNRESOLVED'});
  });
  it('cross proof rejects a valid signature transplanted to another account permit and observation',async()=>{
    const f=await fixture({slots:2}),intents=await Promise.all(f.seeds.map(seed=>uploadIntent(f,seed)));for(let i=0;i<2;i++)await admit(f,f.seeds[i].accountId,intents[i]);
    const first=await prove(f,f.seeds[0].accountId,intents[0],false,'NO_CHILD_CREATED'),second=(await new NativeCapacityStore(f.api,f.seeds[1].accountId).recover())[0],confirmed=await f.operator.confirm(first.signed);
    const transplanted={...first.proof,accountId:f.seeds[1].accountId,capacityReservationId:second.capacityReservationId,adoptionId:second.adoptionId!,jobId:intents[1].jobId,inputDigest:intents[1].inputDigest,parentInstanceId:intents[1].parentInstanceId};
    const canonical=canonicalize(transplanted)!;await expect(f.operator.confirm({canonical,signature:sign(null,Buffer.from(canonical),f.key.privateKey).toString('base64')})).rejects.toMatchObject({code:'NATIVE_CAPACITY_PROOF_UNCONFIRMED'});await expect(f.operator.release(f.seeds[1].accountId,second.capacityReservationId,confirmed.proofId!)).rejects.toMatchObject({code:'NATIVE_CAPACITY_PROOF_UNCONFIRMED'});
    expect(await rootCount(f)).toBe(2);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe('1');
  });
  it('actual service LOGINs cannot invoke operator release private bases or upgrade an owned profile',async()=>{
    const f=await fixture({accounts:1}),intent=await uploadIntent(f),account=f.seeds[0].accountId;await admit(f,account,intent);const sealed=await prove(f,account,intent,false,'NO_CHILD_CREATED');
    for(const db of [f.api,f.workers[0]]){
      await expect(db.pool.query('SELECT manga_web.native_capacity_confirm_proof($1,$2)',[sealed.signed.canonical,sealed.signed.signature])).rejects.toMatchObject({code:'42501'});await expect(db.pool.query('SELECT manga_web.native_capacity_release($1,$2,$3)',[account,sealed.reservation.capacityReservationId,randomUUID()])).rejects.toMatchObject({code:'42501'});
      await expect(db.accountTransaction(account,tx=>tx.client.query('SELECT manga_web.native_capacity_base_create_intent_v13($1::jsonb)',[JSON.stringify(intent)]))).rejects.toMatchObject({code:'42501'});await expect(db.pool.query('SELECT profile_payload FROM manga_web.native_capacity_profiles')).rejects.toMatchObject({code:'42501'});
      const role=(await db.pool.query<{login:string}>('SELECT session_user AS login')).rows[0];const client=await db.pool.connect();try{await expect(new NativeCapacityOperator(client,role.login).confirm(sealed.signed)).rejects.toMatchObject({code:'NATIVE_CAPACITY_OPERATOR_UNCONFIRMED'});}finally{client.release();}
    }
    const newIntent={...intent,jobId:randomUUID(),operationInputDigest:sha256(randomUUID())};newIntent.logicalOperationKey=nativeLogicalOperationKey(newIntent);await expect(store(f,account).beforeIntent(newIntent)).rejects.toMatchObject({code:'NATIVE_CAPACITY_REFERENCE_REQUIRED'});await expect(store(f,account).beforeIntent(newIntent,true)).rejects.toMatchObject({code:'NATIVE_CAPACITY_REFERENCE_REQUIRED'});
    await expect(f.client.query(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),JSON.stringify({...f.profile,kind:'MEASURED'}),f.profile.version,f.profile.maxSlots,f.profile.nativeProfileDigest,f.profile.kernelDigest,f.profile.controllerId,f.profile.keyVersion,f.profile.environmentDigest,f.profile.publicKeySpki])).rejects.toMatchObject({code:'23514'});
    expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe('0');
  });
  it('profile replacement counts older unresolved roots and rejects GO under a changed capture',async()=>{
    const f=await fixture({execution:true}),intent=await uploadIntent(f),account=f.seeds[0].accountId;await admit(f,account,intent);
    const profile={...f.profile,version:'owned-native-capacity-v2'},id=randomUUID(),inserted=(await f.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[id,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
    await f.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,revision=revision+1 WHERE singleton",[id]);const capacity:NativeCapacityConfiguration={reference:{kind:'OWNED_FIXTURE',profileId:id,profileDigest:inserted.profile_digest,profileVersion:profile.version},profile};
    const other=await uploadIntent(f,f.seeds[1]);await expect(admit(f,f.seeds[1].accountId,other,false,capacity)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});await expect(store(f,account).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.capacity)).rejects.toMatchObject({code:'NATIVE_CAPACITY_PROFILE_MISMATCH'});expect(await rootCount(f)).toBe(1);
    const p=await prepare(f.services[0]);expect(await p.service.preflight(p.claim,p.input)).toBe(false);expect((await new NativeCapacityStore(f.api,account).recover())[0]).toMatchObject({state:'HELD',reference:f.capacity.reference});expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('0');
  });
  it('no child candidate contradicting durable GO cannot become a release proof',async()=>{
    const f=await fixture({accounts:1}),account=f.seeds[0].accountId,intent=await uploadIntent(f);await admit(f,account,intent);await store(f,account).beforeGo(intent.jobId,intent.parentInstanceId,intent.claim,intent.protectedOwnerCapture,f.capacity);
    const sealed=await prove(f,account,intent,false,'NO_CHILD_CREATED');await expect(f.operator.confirm(sealed.signed)).rejects.toMatchObject({code:'NATIVE_CAPACITY_GO_CONTRADICTION'});expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe('0');expect((await new NativeCapacityStore(f.api,account).recover())[0]).toMatchObject({state:'HELD',go:'CONSUMED',terminationProofId:null});
  });
  it('owned child cache hit reuses exact bytes without another reservation GO or release of the original hold',async()=>{
    const f=await fixture({accounts:1}),intent=await uploadIntent(f),root=await mkdtemp(path.join(tmpdir(),'trio-native-capacity-cache-'));expect(path.dirname(root).toLowerCase()).toBe(path.resolve('E:\\Codex-Trio-Web-Validation-01a1018a\\run-tmp').toLowerCase());
    const controller=NativeController.owned({profile:syntheticProfile,limits:{maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16*1024*1024},directoryRoot:root}),objects=new FileObjectStore(path.join(root,'objects'),1024*1024),gateway=new NativeDatabaseGateway(f.api,controller,objects,f.capacity);
    const target=(job:NativeJobIntent):NativeTarget=>({accountId:f.seeds[0].accountId,targetKind:job.targetKind,targetId:job.targetId,semanticCaptureDigest:job.semanticCaptureDigest,protectedOwnerCapture:job.protectedOwnerCapture,claim:job.claim}),source=Buffer.from(ownedNativePng,'base64');expect(sha256(source)).toBe(ownedNativePngSha256);
    // An UPLOAD without stored refs owns the exact one-blob DECODE_IMAGE source.
    // ZIP_WRITE belongs to a captured export and cannot bypass that source guard.
    try{const first=await gateway.forTarget(target(intent)).decodeImage(source,syntheticProfile);await gateway.idle();expect(first).toMatchObject({width:1,height:1,mediaType:'image/png'});const before=(await new NativeCapacityStore(f.api,f.seeds[0].accountId).recover())[0];expect(before).toMatchObject({state:'HELD',go:'CONSUMED',terminationProofId:null});
      const next=await uploadIntent(f),cached=await gateway.forTarget(target(next)).decodeImage(source,syntheticProfile);await gateway.idle();expect(cached).toEqual(first);expect(await rootCount(f)).toBe(1);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_intents')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_reservations')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe('1');expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe('0');expect((await new NativeCapacityStore(f.api,f.seeds[0].accountId).recover())[0]).toEqual(before);expect(f.provider.calls).toEqual([]);console.info(JSON.stringify({nativeCapacityTrace:'owned_child_cache_reused',physicalChildren:1,realProviderCalls:0,reservations:1,go:1,releaseProofs:0}));
    }finally{await gateway.idle();}
  });
});

describe('W3-A Windows profile reservation and legacy GO boundary',()=>{
  let windows:WindowsNativeFixture|undefined,guard:ReturnType<typeof guardWindowsNativeIo>;
  beforeEach(()=>{guard=guardWindowsNativeIo();});
  afterEach(async()=>{try{await windows?.close();windows=undefined;expect(guard.denied).toEqual([]);}finally{guard.restore();}});
  const rawAdmission=(f:WindowsNativeFixture,intent:NativeJobIntent,capacity:unknown)=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string;capacityReservationId?:string}}>('SELECT manga_web.native_capacity_create_intent($1::jsonb,false,$2::jsonb) AS decision',[JSON.stringify(intent),JSON.stringify(capacity)])).rows[0].decision);

  it('recovers the original Windows reservation tag, source INPUT and SQL profile digest',async()=>{
    const f=windows=await windowsNativeFixture(),capacity=await f.registerWindowsProfile();await f.request();const execution=await f.prepareExecution(),original=await f.originalIntent(execution),decision=await original.reserve(capacity);
    expect(decision.allowed).toBe(true);expect(capacity.reference.profileDigest).not.toBe(digest(capacity.profile));
    expect((await new NativeCapacityStore(f.worker,f.seed.accountId).recover())).toMatchObject([{capacityReservationId:decision.capacityReservationId,jobId:original.intent.jobId,reference:capacity.reference,sourceInput:original.sourceInput,state:'HELD',go:'UNCONSUMED',terminationProofId:null}]);
    expect((await f.admin.pool.query('SELECT profile_id,profile_digest,source_execution_id,source_input_evidence_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{profile_id:capacity.reference.profileId,profile_digest:capacity.reference.profileDigest,source_execution_id:execution.input.executionId,source_input_evidence_id:original.sourceInput.inputEvidenceId}]);
    expect(f.provider.calls).toEqual([]);
  });
  it('rejects source omission, replacement and tag crossover in SQL before creating any reservation',async()=>{
    const f=windows=await windowsNativeFixture(),capacity=await f.registerWindowsProfile();await f.request();const execution=await f.prepareExecution(),original=await f.originalIntent(execution);
    for(const sourceInput of [undefined,null,{...original.sourceInput,inputEvidenceId:randomUUID()},{...original.sourceInput,executionId:randomUUID()},{...original.sourceInput,stageInputDigest:sha256('replacement StageInput')}])expect(await rawAdmission(f,original.intent,{...capacity,...(sourceInput===undefined?{}:{sourceInput})})).toMatchObject({allowed:false});
    for(const altered of [{...capacity,reference:{...capacity.reference,kind:'OWNED_FIXTURE'}},{...capacity,profile:{...capacity.profile,kind:'OWNED_FIXTURE'}},{...capacity,reference:{...capacity.reference,profileDigest:sha256('unregistered SQL profile')}}])expect(await rawAdmission(f,original.intent,{...altered,sourceInput:original.sourceInput})).toMatchObject({allowed:false});
    const checkpoint=await f.originalIntent(execution,'REQUEST_CHECKPOINT');expect(await rawAdmission(f,checkpoint.intent,capacity)).toMatchObject({allowed:false});
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_intents')).rows[0].n).toBe(0);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_capacity_reservations')).rows[0].n).toBe(0);expect(f.provider.calls).toEqual([]);
  });
  it('serializes distinct Windows operations at maxSlots without leaving a ghost intent or consuming GO',async()=>{
    const f=windows=await windowsNativeFixture();f.profile.maxSlots=1;const capacity=await f.registerWindowsProfile();await f.request();const execution=await f.prepareExecution(),original=await f.originalIntent(execution);
    const blobs=new Map([['source',Buffer.from('W3-A second original slot operation')]]),job=createNativeJob('DECODE_IMAGE',capacity.profile.nativeProfileDigest,{sourceBlobId:'source'},blobs,windowsFrameLimits),value={...original.intent,jobId:job.jobId,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job)},second={...value,logicalOperationKey:nativeLogicalOperationKey(value)};
    const outcomes=await Promise.all([rawAdmission(f,original.intent,{...capacity,sourceInput:original.sourceInput}),rawAdmission(f,second,{...capacity,sourceInput:original.sourceInput})]);
    expect(outcomes.filter(row=>row.allowed)).toHaveLength(1);expect(outcomes.filter(row=>!row.allowed)).toEqual([{allowed:false,reason:'NATIVE_CAPACITY_WAIT'}]);
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_intents')).rows[0].n).toBe(1);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_capacity_reservations')).rows[0].n).toBe(1);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe(0);expect(f.provider.calls).toEqual([]);
  });
  it('denies Windows GO and claim through the API wrapper and legacy v1 controller authority',async()=>{
    const f=windows=await windowsNativeFixture(),capacity=await f.registerWindowsProfile();await f.request();const execution=await f.prepareExecution(),original=await f.originalIntent(execution),decision=await original.reserve(capacity);expect(decision.allowed).toBe(true);
    await expect(new NativeJobStore(f.worker,f.seed.accountId).beforeGo(original.intent.jobId,original.intent.parentInstanceId,original.intent.claim,original.intent.protectedOwnerCapture,{...capacity,sourceInput:original.sourceInput})).rejects.toMatchObject({status:409,nextAction:'WAIT'});
    const binding=original.binding(decision.capacityReservationId!),{inputDigest:_digest,...frame}=original.frame.envelope;
    await expect(f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.native_controller_claim($1::jsonb,$2,$3,$4,$5,$6,$7) AS decision',[JSON.stringify(binding),canonicalize(frame)!,randomUUID(),f.controllerInstanceId,f.profile.controllerId,'trio_web_worker',randomUUID()])).rejects.toMatchObject({status:409,nextAction:'WAIT'});
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_controller_attempts')).rows[0].n).toBe(0);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe(0);
    expect((await new NativeCapacityStore(f.worker,f.seed.accountId).recover())).toMatchObject([{reference:capacity.reference,sourceInput:original.sourceInput,state:'HELD',go:'UNCONSUMED'}]);expect(f.provider.calls).toEqual([]);
  });
});
describe('W3-A OWNED v1 receipt SQL 보존',()=>{
  let guard:ReturnType<typeof guardWindowsNativeIo>;beforeEach(()=>{guard=guardWindowsNativeIo();});
  afterEach(()=>{try{expect(guard.denied).toEqual([]);}finally{guard.restore();}});
  it('가짜 원 결과로 v1 prepare PUT verify lookup을 유지하고 GO를 재사용한다',async()=>{
    const f=await fixture(),seed=f.seeds[0],base=await uploadIntent(f,seed),blobs=new Map([['source',Buffer.from(ownedNativePng,'base64')]]),limits={maxMetadataBytes:32768,maxBinaryBytes:65536,maxItems:8};
    const metadata={profile:syntheticProfile,sourceBlobId:'source'},job=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,metadata,blobs,limits);
    const value={...base,jobId:job.jobId,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job)},intent={...value,logicalOperationKey:nativeLogicalOperationKey(value)};
    await admit(f,seed.accountId,intent);await go(f,seed.accountId,intent);
    const bytes=Buffer.from(ownedNativePng,'base64'),computation={metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs:new Map([['canonical-png',bytes]])},result=createNativeResult(job,computation,limits);
    const termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY' as const};
    const observation={version:1 as const,parentInstanceId:intent.parentInstanceId,event:'RESULT' as const,code:'OK',resultDigest:digest(result),termination:{...termination,isolation:'OWNED_FIXTURE' as const}},resultObservationId=randomUUID(),recorded=await store(f,seed.accountId).observe(resultObservationId,observation);
    await store(f,seed.accountId).observe(randomUUID(),{...observation,event:'TERMINATION',resultDigest:null});
    const objects=new FileObjectStore(await mkdtemp(path.join(tmpdir(),'trio-w3a-owned-v1-')),65536);let sourceCalls=0;
    const receipt=new NativeReceiptStore(f.api,objects,{accountId:seed.accountId,targetKind:intent.targetKind,targetId:intent.targetId,semanticCaptureDigest:intent.semanticCaptureDigest,protectedOwnerCapture:intent.protectedOwnerCapture,claim:intent.claim},f.profile.kernelDigest,{input:limits,output:limits},()=>{sourceCalls++;return {intent,job,result,resultObservationId,resultObservationDigest:recorded.observationDigest!,termination};});
    await receipt.seal('DECODE_IMAGE',metadata,blobs,computation);const hit=await receipt.read('DECODE_IMAGE',metadata,blobs);expect(hit.state).toBe('VERIFIED');expect(sourceCalls).toBe(1);
    if(hit.state!=='VERIFIED')throw Error('v1 receipt must remain verified');expect(hit.result).toEqual(result);
    const originals=(await f.admin.pool.query('SELECT protected_candidate FROM manga_web.native_result_candidates WHERE account_id=$1',[seed.accountId])).rows;
    expect(originals).toHaveLength(1);expect(originals[0].protected_candidate.version).toBe(1);expect(originals[0].protected_candidate).not.toHaveProperty('windowsEvidenceRef');
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe(1);expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.windows_native_links')).rows[0].n).toBe(0);expect(f.provider.calls).toEqual([]);
  });
});
