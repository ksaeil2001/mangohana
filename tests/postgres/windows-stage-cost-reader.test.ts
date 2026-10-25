import {it,expect,vi} from 'vitest';
vi.hoisted(()=>{vi.doMock('sharp',()=>({default:()=>{throw new Error('W4B2_SHARP_FORBIDDEN');}}));});
import {guardWindowsNativeIo,windowsNativeFixture,prepareWindowsCostedTarget,windowsNativeScript,windowsNativeLimits,windowsFrameLimits,createWindowsCostedObjectIo,createWindowsCostedRemoteFixture,type WindowsNativeFixture,type WindowsNativeAccountingOverrides} from '../fixtures/windows-native.js';
import {testDatabase} from '../fixtures/database.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {WindowsNativeCostOwner,WindowsNativeCostRef,WindowsCostedIoEvent,WindowsCostedIoRequest,WindowsNativeCostComponent} from '../../packages/domain/src/windows-native-cost.js';
import {WindowsNativeCapacityOperator,WindowsNativeCostJournal} from '../../packages/domain/src/windows-native-cost.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import {createNativeJob,createNativeResult,nativeTaskVersion} from '../../packages/native/src/dto.js';
import type {NativeControllerBinding,NativeRawResultReference} from '../../packages/native/src/controller-protocol.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {WindowsNativeJournal,createWindowsJournalMemory} from '../../packages/domain/src/windows-native-journal.js';
import {validateWindowsNativeEvidenceBundle,type WindowsNativeOriginalKey} from '../../packages/domain/src/native-receipts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {ownedNativePng} from '../fixtures/native-images.js';
import {WindowsStageCostReader,windowsStageCostBounds} from '../../packages/domain/src/windows-stage-cost-reader.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {OperationalStageCost,type OperationalStageCostWorkSet} from '../../packages/domain/src/pipeline-stage-cost.js';
import {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {CheckpointValidationJournal,checkpointValidationVersion,type CheckpointValidationAttempt,type CheckpointValidationTarget,type CheckpointValidationOperation} from '../../packages/domain/src/checkpoint-validation.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import pg from 'pg';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {canonicalInput,normalizeObservation} from '../../packages/domain/src/provider.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import type {OwnedExecutionLimitProfile} from '../../packages/domain/src/execution-limits.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {finalizeSafe} from '../../packages/domain/src/liveness.js';
import type {RequestRow} from '../../packages/domain/src/model.js';

const publicSignatures=[
  'manga_web.windows_stage_cost_project(jsonb,jsonb,jsonb,jsonb)',
  'manga_web.windows_stage_cost_seal(jsonb,jsonb)',
  'manga_web.windows_stage_cost_lookup(jsonb,integer)',
] as const;

it('W4-B2 public3 exact SQL contracts exist before any cost projection or seal',async()=>{
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let db:Database|undefined;
  try{
    db=await testDatabase();
    expect((await db.pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^18\./);
    const rows=(await db.pool.query<{signature:string;installed:string|null}>(
      'SELECT signature,to_regprocedure(signature)::text AS installed FROM unnest($1::text[]) AS signature ORDER BY signature',
      [[...publicSignatures]],
    )).rows;
    expect(rows.map(row=>row.signature)).toEqual([...publicSignatures].sort());
    expect(rows.map(row=>row.installed===null?null:row.installed.replace(/^manga_web\./,'')),'W4-B2 public3 actual to_regprocedure NULL is the missing-contract RED').toEqual([...publicSignatures].sort().map(signature=>signature.replace(/^manga_web\./,'')));
  }catch(error){errors.push(error);}
  finally{
    try{await db?.close();expect(guard.denied).toEqual([]);console.info(JSON.stringify({w4b2SqlGuard:{denied:guard.denied,realNativeChildCalls:0,externalApiModelCalls:0,staticSharp:'throwing-loader'}}));}catch(error){errors.push(error);}finally{guard.restore();}
  }
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,'W4B2_OPERATION_AND_CLEANUP_FAILED');
});

type Prepared=Omit<Awaited<ReturnType<typeof prepareWindowsCostedTarget>>,'components'>&{components:WindowsNativeCostComponent[]};
type Selector=Pick<WindowsNativeCostOwner,'executionId'|'inputEvidenceId'|'inputFingerprint'|'basisRef'>;
type Ref=WindowsNativeCostRef;
type RawRow={kind:string;id:string;ref:Ref|null;contentDigest:string;completedAt:string|null};
type Manifest={version:1;chunkSize:256;counts:{kind:string;count:number}[];leaves:{kind:string;chunk:number;count:number;digest:string}[]};
type Census={version:1;mode:'CENSUS';owner:WindowsNativeCostOwner;root:{ref:Ref;components:Prepared['components'];componentsDigest:string};inputRef:Ref;basisRef:Ref;rawSetDigest:string;manifest:Manifest;rows:RawRow[];originals:unknown[];completion:unknown};
const selector=(owner:WindowsNativeCostOwner):Selector=>({executionId:owner.executionId,inputEvidenceId:owner.inputEvidenceId,inputFingerprint:owner.inputFingerprint,basisRef:owner.basisRef});

async function withPrepared(run:(f:WindowsNativeFixture,x:Prepared)=>Promise<void>,prepare:(f:WindowsNativeFixture)=>Promise<Prepared>=prepareWindowsCostedTarget){
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let f:WindowsNativeFixture|undefined;
  try{f=await windowsNativeFixture(20.5);await run(f,await prepare(f));}catch(error){errors.push(error);}
  finally{try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_OPERATION_AND_CLEANUP_FAILED');
}
// Explicit synthetic BASIS variants reuse the unchanged original INPUT/enroll
// transaction and calculator; no production default/rate is introduced.
async function prepareWithBasis(f:WindowsNativeFixture,change:(snapshot:FullStageCostSnapshot)=>FullStageCostSnapshot,components:WindowsNativeCostComponent[]=[{task:'DECODE_IMAGE',componentId:'native-image'}]):Promise<Prepared>{
  const costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),transaction=f.worker.transaction.bind(f.worker);await f.request();let enrolled:unknown=null;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{const value=await run(client),rows=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[f.seed.accountId])).rows;if(rows.length){expect(rows).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) value',[JSON.stringify({evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest})])).rows[0].value;}return value;}));
  let execution:Awaited<ReturnType<WindowsNativeFixture['prepareExecution']>>;try{execution=await f.prepareExecution();}finally{spy.mockRestore();}expect(enrolled).not.toBeNull();
  const input=execution.input,original=await f.originalIntent(execution),profileDigest=sha256('w4b2-controlled-basis'),mode=(await f.admin.pool.query('SELECT mode FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,input.requestId])).rows[0].mode;
  const snapshot=change({version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'w4b2-controlled-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:w4b2/snapshot'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'w4b2-synthetic-unit-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b2/unit']}]});
  const calculated=new FullStageCostCalculator(snapshot,calculatorBounds).calculate({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'OCR',profileDigest,mode},{provider:null,quantities:null,allocation:null}),basis={version:1,capture:calculated.capture,captureDigest:calculated.captureDigest,snapshot:calculated.snapshot,snapshotDigest:calculated.snapshotDigest},body={version:1,accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'OPERATIONAL_COST_BASIS',value:basis},basisRef={evidenceId:randomUUID(),evidenceDigest:digest(body)};
  await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,basisRef.evidenceId,input.executionId,basisRef.evidenceDigest,tx.now,JSON.stringify(body)]),true);
  const owner:WindowsNativeCostOwner={executionId:input.executionId,inputEvidenceId:original.sourceInput.inputEvidenceId,inputFingerprint:digest(canonicalInput(input)),basisRef,claim:{generation:execution.claim.generation,ownerId:f.service.workerId,workItemId:execution.claim.workId},validationAttemptRef:null},root=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components),true);expect(root).not.toBeNull();
  const capacity=await f.registerWindowsProfile(),target:Prepared['target']={accountId:f.seed.accountId,targetKind:'EXECUTION',targetId:input.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest('INPUT',input.requestId,input),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:owner.claim,sourceInput:original.sourceInput};return {costs,execution,original,owner,root,components,capacity,target,source:Buffer.from(ownedNativePng,'base64')};
}
async function lookup<T>(f:WindowsNativeFixture,query:unknown,limit=64):Promise<T|null>{
  return f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{value:T|null}>(
    'SELECT manga_web.windows_stage_cost_lookup($1::jsonb,$2::integer) AS value',[JSON.stringify(query),limit],
  )).rows[0].value,true);
}
async function project<T>(f:WindowsNativeFixture,owner:WindowsNativeCostOwner,key:unknown,operation:unknown=null,termination:unknown=null):Promise<T|null>{
  return f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{value:T|null}>(
    'SELECT manga_web.windows_stage_cost_project($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) AS value',
    [JSON.stringify(owner),JSON.stringify(key),operation===null?null:JSON.stringify(operation),termination===null?null:JSON.stringify(termination)],
  )).rows[0].value,true);
}
function manifest(rows:RawRow[]):Manifest{
  const result:Manifest={version:1,chunkSize:256,counts:[],leaves:[]};
  const compare=(left:string,right:string)=>left<right?-1:left>right?1:0;
  const sorted=[...rows].sort((left,right)=>compare(left.kind,right.kind)||compare(left.id,right.id));
  for(const kind of [...new Set(sorted.map(row=>row.kind))]){
    const group=sorted.filter(row=>row.kind===kind);result.counts.push({kind,count:group.length});
    for(let start=0;start<group.length;start+=256){const chunk=start/256,leaf=group.slice(start,start+256);result.leaves.push({kind,chunk,count:leaf.length,digest:digest({version:1,kind,chunk,rows:leaf})});}
  }
  return result;
}

// These two helpers exist only in this disposable test DB. The first enables
// transaction-local PostgreSQL timing; the second observes the unchanged
// private gate in the SAME worker transaction, without granting work or cost.
async function installSqlObservation(f:WindowsNativeFixture){
  await f.admin.pool.query(`CREATE FUNCTION manga_web.w4b2_test_profile() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$BEGIN PERFORM set_config('track_functions','all',true);END$$;
    REVOKE ALL ON FUNCTION manga_web.w4b2_test_profile() FROM PUBLIC;GRANT EXECUTE ON FUNCTION manga_web.w4b2_test_profile() TO trio_web_worker;
    CREATE FUNCTION manga_web.w4b2_test_owner(owner jsonb,capture jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
    DECLARE sampled timestamptz:=clock_timestamp();value jsonb;BEGIN
    SELECT jsonb_build_object('sampledAt',sampled,'leaseUntil',w.lease_until,'leaseLive',w.lease_until>sampled,'executionClaim',ex.claim_generation::text=owner->'claim'->>'generation','workClaim',w.claim_generation::text=owner->'claim'->>'generation','claimOwner',w.claim_owner=owner->'claim'->>'ownerId','workState',w.state,'targetMatches',((w.kind IN('DISPATCH','APPLY') AND w.target_ref->>'requestId'=r.request_id::text) OR(w.kind='RECONCILE' AND w.target_ref->>'executionId'=ex.execution_id::text)),
      'requestState',r.state,'requestTerminalAt',r.terminal_at,'requestActive',r.terminal_at IS NULL AND r.state IN('ACCEPTED','ACTIVE','WAITING'),'requestContextMatches',r.context_id::text=capture->>'contextId' AND r.context_generation::text=capture->>'contextGeneration',
      'activePage',EXISTS(SELECT 1 FROM manga_web.active_page_requests p WHERE p.account_id=r.account_id AND p.request_id=r.request_id AND p.page_lineage_id=r.page_lineage_id),'pageRevision',EXISTS(SELECT 1 FROM manga_web.workspace_pages p WHERE p.account_id=r.account_id AND p.context_id=r.context_id AND p.page_lineage_id=r.page_lineage_id AND NOT p.excluded AND p.result_revision=r.expected_result_revision)) INTO value
      FROM manga_web.executions ex JOIN manga_web.processing_requests r USING(account_id,request_id) JOIN manga_web.work_items w ON w.account_id=ex.account_id AND w.work_item_id=(owner->'claim'->>'workItemId')::uuid WHERE ex.account_id=manga_web.current_account() AND ex.execution_id=(owner->>'executionId')::uuid;
    RETURN value||jsonb_build_object('ownerValid',manga_web.windows_native_cost_owner_valid(owner),'captureCurrent',manga_web.windows_native_owner_current(capture),'ownerCurrent',manga_web.windows_native_cost_owner_current(owner,capture));END$$;
    REVOKE ALL ON FUNCTION manga_web.w4b2_test_owner(jsonb,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION manga_web.w4b2_test_owner(jsonb,jsonb) TO trio_web_worker;`);
}

async function renewObserved(f:WindowsNativeFixture,x:Prepared,phase:string){
  const success=await f.service.renew(x.execution.claim);expect(success).toBe(true);
  const row=(await f.admin.pool.query("SELECT clock_timestamp() AS sampled_at,lease_until,claim_generation,claim_owner,state FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,x.execution.claim.workId])).rows[0];
  console.info(JSON.stringify({w4b2Renew:{phase,success,...row,sameGeneration:row.claim_generation===x.execution.claim.generation,sameOwner:row.claim_owner===f.service.workerId}}));
}

it('W4-B2 CENSUS bootstraps only the stored root owner from INPUT BASIS identity without caller claim',async()=>withPrepared(async(f,x)=>{
  const originalIo={...f.objectIo},query={version:1,mode:'CENSUS',owner:selector(x.owner)},value=await lookup<Census>(f,query);
  expect(value).not.toBeNull();expect(value!.owner).toEqual(x.owner);
  expect(Object.keys(value!).sort()).toEqual(['version','mode','owner','root','inputRef','basisRef','rawSetDigest','manifest','rows','originals','completion'].sort());
  expect(value!.inputRef).toEqual({evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint});expect(value!.basisRef).toEqual(x.owner.basisRef);
  expect(value!.root).toEqual({ref:x.root,components:x.components,componentsDigest:digest(x.components)});
  expect(value!.originals).toEqual([]);expect(value!.manifest).toEqual(manifest(value!.rows));expect(value!.rawSetDigest).toBe(digest(value!.manifest));
  expect(await lookup(f,{...query,owner:{...selector(x.owner),claim:x.owner.claim}})).toBeNull();
  expect(await lookup(f,{...query,owner:{...selector(x.owner),inputFingerprint:'f'.repeat(64)}})).toBeNull();
  expect(await lookup(f,{...query,hidden:true})).toBeNull();
  expect(await lookup(f,{version:1,mode:'SEALED',owner:selector(x.owner)})).toBeNull();expect(f.objectIo).toEqual(originalIo);
}));

it('W4-B2 SOURCE exposes only the census-authorized original INPUT and BASIS with exact refs',async()=>withPrepared(async(f,x)=>{
  const refs=[{evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint},x.owner.basisRef];
  for(const ref of refs){
    const source=await lookup<{version:1;mode:'SOURCE';ref:Ref;kind:string;value:unknown}>(f,{version:1,mode:'SOURCE',owner:x.owner,ref});
    const original=(await f.admin.pool.query('SELECT kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,ref.evidenceId])).rows[0];
    expect(source).toEqual({version:1,mode:'SOURCE',ref,kind:original.kind,value:original.protected_observation});
    expect(digest(source!.value)).toBe(ref.evidenceDigest);
    expect(await lookup(f,{version:1,mode:'SOURCE',owner:x.owner,ref:{...ref,evidenceDigest:'f'.repeat(64)}})).toBeNull();
  }
  expect(await lookup(f,{version:1,mode:'SOURCE',owner:x.owner,ref:{evidenceId:x.root!.evidenceId,evidenceDigest:x.root!.evidenceDigest}})).toBeNull();
}));

it('W4-B2 zero native work uses distinct DB census events and retries the same absence refs',async()=>withPrepared(async(f,x)=>{
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();
  const key={version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef};
  const first=await project<{version:1;kind:'ABSENCE';operation:Ref;termination:Ref;value:Record<string,unknown>}>(f,x.owner,key);
  expect(first).not.toBeNull();expect(first!.operation.evidenceId).not.toBe(first!.termination.evidenceId);
  expect(first!.value).toMatchObject({version:1,componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef,quantity:'0',unit:'windows-job-cpu-second-v1'});
  expect(first!.value.operationId).not.toBe(first!.value.eventId);
  expect(await project(f,x.owner,key)).toEqual(first);
  expect(await project(f,x.owner,{...key,rawSetDigest:'f'.repeat(64)})).toBeNull();
  const rows=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION') ORDER BY evidence_id",[f.seed.accountId])).rows;
  expect(rows).toHaveLength(2);for(const row of rows)expect(digest(row.protected_observation)).toBe(row.evidence_digest);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:0}]);
  expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.cost_items WHERE component='STAGE_TOTAL'")).rows).toEqual([{n:0}]);
}));

it('W4-B2 a later real B1 scope invalidates an old absence census without creating a seal or cost',async()=>withPrepared(async(f,x)=>{
  const query={version:1,mode:'CENSUS',owner:selector(x.owner)},before=await lookup<Census>(f,query);expect(before).not.toBeNull();
  const key={version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:before!.rawSetDigest,basisRef:x.owner.basisRef};
  expect(await project(f,x.owner,key)).not.toBeNull();
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()));expect(scope).not.toBeNull();
  const after=await lookup<Census>(f,query);expect(after).not.toBeNull();expect(after!.rawSetDigest).not.toBe(before!.rawSetDigest);
  expect(after!.rows.filter(row=>row.kind==='SCOPE').map(row=>row.id)).toEqual([scope!.scopeId]);
  expect(await project(f,x.owner,key)).toBeNull();
  expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CLOSURE')")).rows).toEqual([{n:0}]);
}));

it('W4-B2 historical root and SOURCE reads preserve the original claim after current owner context drift',async()=>withPrepared(async(f,x)=>{
  const query={version:1,mode:'CENSUS',owner:selector(x.owner)},before=await lookup<Census>(f,query);expect(before).not.toBeNull();
  await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
  const after=await lookup<Census>(f,query);expect(after).not.toBeNull();expect(after!.owner).toEqual(before!.owner);expect(after!.rawSetDigest).toBe(before!.rawSetDigest);
  expect(await lookup(f,{version:1,mode:'SOURCE',owner:x.owner,ref:x.owner.basisRef})).not.toBeNull();
  expect(await lookup(f,{version:1,mode:'SOURCE',owner:{...x.owner,claim:{...x.owner.claim,ownerId:randomUUID()}},ref:x.owner.basisRef})).toBeNull();
}));

it('W4-B2 bounded raw leaf encoder is byte and hash identical for null timestamp escaping numeric chunk keys and array order',async()=>withPrepared(async(f)=>{
  const rows:RawRow[]=Array.from({length:256},(_,i)=>({kind:'RAW_OBJECT',id:`${String(i).padStart(3,'0')}/"\\\n\t한글😀`,ref:i%2===0?{evidenceId:randomUUID(),evidenceDigest:sha256(String(i))}:null,contentDigest:sha256('content'+i),completedAt:i%3===0?null:'2026-10-21T01:02:03.123456+00:00'}));
  for(const count of [1,2,255,256])for(const chunk of [0,1,63]){const body={version:1,kind:'RAW_OBJECT',chunk,rows:rows.slice(0,count)},result=(await f.admin.pool.query('SELECT manga_web.windows_stage_cost_leaf($1,$2,$3::jsonb) fast,manga_web.windows_native_cost_canonical($4::jsonb) original',[body.kind,chunk,JSON.stringify(body.rows),JSON.stringify(body)])).rows[0];expect(Buffer.from(result.fast)).toEqual(Buffer.from(result.original));expect(sha256(result.fast)).toBe(digest(body));}
  for(const invalid of [[...rows,rows[0]],[{...rows[0],hidden:true}],[{...rows[0],ref:{...rows[0].ref,hidden:true}}]])expect((await f.admin.pool.query('SELECT manga_web.windows_stage_cost_leaf($1,0,$2::jsonb) value',['RAW_OBJECT',JSON.stringify(invalid)])).rows[0].value).toBeNull();
}));

it('W4-B2 raw only collection has identical manifest hashes and bounded function counts across ORIGINAL SOURCE project and final full seal',async()=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);await nativeOriginal(f,x,'CREATED');const {basis,reader}=await zeroWindowsWork(f,x);
  await f.admin.accountTransaction(f.seed.accountId,async tx=>{
    await tx.client.query("SET LOCAL track_functions='all'");
    const full=(await tx.client.query('SELECT manga_web.windows_stage_cost_census($1::jsonb,64) value',[JSON.stringify(x.owner)])).rows[0].value;
    await tx.client.query('RESET ROLE');const raw=(await tx.client.query('SELECT manga_web.windows_stage_cost_collect($1::jsonb,64,false) value',[JSON.stringify(x.owner)])).rows[0].value;expect(raw).toEqual({...full,originals:[]});
    const before=(await tx.client.query("SELECT calls::integer FROM pg_stat_xact_user_functions WHERE funcname='windows_stage_cost_collect'")).rows[0].calls;await tx.client.query('SET LOCAL ROLE trio_web_worker');
    const work=await reader.candidateIn(tx,x.execution.input,basis);expect(work).not.toBeNull();expect(await reader.sealIn(tx,x.execution.input,basis,work!)).not.toBeNull();
    await tx.client.query('RESET ROLE');const counts=(await tx.client.query("SELECT funcname,calls::integer,total_time FROM pg_stat_xact_user_functions WHERE funcname IN('windows_stage_cost_collect','windows_stage_cost_original','windows_native_evidence_bundle','windows_stage_cost_project') ORDER BY funcname")).rows;
    expect(counts.find(r=>r.funcname==='windows_stage_cost_collect')!.calls-before).toBe(3);console.info(JSON.stringify({w4b2BoundedFunctionCounts:counts,rawAndFullIdentical:true}));
  },true);
}));

it('W4-B2 actual 1024 completed I/O profile preserves worker role and measures fixed raw content function costs',async()=>withPrepared(async(f,x)=>{
  await installSqlObservation(f);const bytes=Buffer.from(ownedNativePng,'base64'),key=f.seed.accountId+'/'+randomUUID();await f.files.put(key,bytes);
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)});
  for(let group=0;group<16;group++){
    await renewObserved(f,x,'profile-io-'+group);const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
    const body={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1',profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('profile-io-'+group),componentId:'native-image'},call={...body,callDigest:digest(body)};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
    const refs:Ref[]=[];for(let index=0;index<64;index++){const request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_RECEIPT',key,expected:{sha256:sha256(bytes),bytesLength:String(bytes.length)}},value=await io.receipt(request);expect(value.state).toBe('RETURNED');refs.push(value.event.ended!);}
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:refs}),true)).toBe('JOINED');
  }
  await f.worker.accountTransaction(f.seed.accountId,async tx=>{
    await tx.client.query('SELECT manga_web.w4b2_test_profile()');expect((await tx.client.query('SELECT current_user role')).rows[0].role).toBe('trio_web_worker');
    const value=await x.costs.stageLookupIn(tx,{version:1,mode:'CENSUS',owner:selector(x.owner)},64);expect(value).not.toBeNull();
    const counts=(await tx.client.query('SELECT funcname,calls::integer,total_time,self_time FROM pg_stat_xact_user_functions ORDER BY total_time DESC,funcname LIMIT 20')).rows;console.info(JSON.stringify({w4b2ActualIoProfile:{starts:1024,ends:1024,sourceClaims:'raw profile only; no monetary acceptance',counts}}));
    expect((await tx.client.query('SELECT current_user role')).rows[0].role).toBe('trio_web_worker');
  },true);
}),180000);

// B1/W4-A originals use real DB capabilities and fake broker/OS-shaped ports.
// These helpers are local; importing another test file would run its tests.
async function nativeOriginal(f:WindowsNativeFixture,x:Prepared,mode:'CREATED'|'NOT_ATTEMPTED',accounting:WindowsNativeAccountingOverrides={},extraIo=0,scopeOptions?:{phase:'INPUT'|'CHECKPOINT';validationTargetDigest:string|null}){
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,scopeOptions?.phase??'INPUT',scopeOptions?.validationTargetDigest??null,randomUUID()));expect(scope).not.toBeNull();
  const sourceId='source-'+randomUUID(),blobs=new Map([[sourceId,Buffer.from(ownedNativePng,'base64')]]),envelope=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId:sourceId},blobs,windowsFrameLimits);
  const intentBody={version:1 as const,jobId:envelope.jobId,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,inputDigest:envelope.inputDigest,operationInputDigest:nativeOperationInputDigest(envelope),parentInstanceId:randomUUID(),targetKind:x.target.targetKind,targetId:x.target.targetId,semanticCaptureDigest:x.target.semanticCaptureDigest,protectedOwnerCapture:x.target.protectedOwnerCapture,claim:x.target.claim};
  const componentId=x.components.find(mapping=>mapping.task==='DECODE_IMAGE')!.componentId,intent={...intentBody,logicalOperationKey:nativeLogicalOperationKey(intentBody)},callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:intent.operationInputDigest,componentId},call={...callBody,callDigest:digest(callBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call))).toEqual(call);
  const admission=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.admitIn(tx,scope!,call,intent,{...x.capacity,sourceInput:x.target.sourceInput!},componentId));expect(admission).toMatchObject({allowed:true,reason:'CREATED'});
  const binding:NativeControllerBinding={accountId:f.seed.accountId,capacityReservationId:admission!.capacityReservationId!,jobId:envelope.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:envelope.inputDigest,profileDigest:envelope.profileDigest,kernelDigest:f.profile.kernelDigest};
  f.memory??=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);
  const journal=new WindowsNativeJournal(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity:x.capacity,limits:windowsNativeLimits,signer:f.signer},f.memory);f.journals.push(journal);
  const ports=journal.portsFor(f.peer),prepared=await journal.offerOriginal(f.peer,binding,{envelope,blobs}),capture=await ports.original.captureFresh(prepared),script=windowsNativeScript(prepared,mode,accounting);
  expect(capture.created).toBe(true);for(const entry of script.entries)await ports.journal.appendOriginal(capture.capture,entry.event,entry.source);
  let rawResult:NativeRawResultReference|null=null;
  if(mode==='CREATED'){
    await journal.readyOriginal(capture.capture,script.prepared);const grant=await ports.original.grantOriginal(capture.capture),offset=script.entries.length;expect(grant.created).toBe(true);script.complete(grant.goGrantRef);
    for(const entry of script.entries.slice(offset))await ports.journal.appendOriginal(capture.capture,entry.event,entry.source);
    const bytes=Buffer.from(ownedNativePng,'base64'),result=createNativeResult(envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs:new Map([['canonical-png',bytes]])},windowsFrameLimits);
    const ref={blobId:'canonical-png',assetId:randomUUID(),sha256:sha256(bytes),bytesLength:String(bytes.length)},allocation=await f.controllerDb.decision<{allowed:boolean;created:boolean;allocation:{reference:NativeRawResultReference}}>(f.seed.accountId,'SELECT manga_web.native_controller_allocate_raw($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) AS decision',[JSON.stringify(binding),capture.capture.origin.authority.attemptId,f.controllerInstanceId,f.profile.controllerId,f.peer.serviceRole,randomUUID(),canonicalize(result),JSON.stringify([ref]),f.files.bucket]);
    expect(allocation.created).toBe(true);rawResult=allocation.allocation.reference;
    const invoke=async(kind:'begin'|'end'|'lookup',value:unknown)=>(await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[JSON.stringify(binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(value),JSON.stringify({purpose:'RUN_RECOVERY'})])).event;
    const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:windowsNativeLimits.maxOutputBytes,begin:value=>invoke('begin',value),end:value=>invoke('end',value),lookup:value=>invoke('lookup',value)});
    const request=(kind:'OBJECT_PUT'|'OBJECT_READ'|'OBJECT_RECEIPT'):WindowsCostedIoRequest=>({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind,key:f.seed.accountId+'/'+ref.assetId,expected:{sha256:ref.sha256,bytesLength:ref.bytesLength}});
    const put=await io.put(request('OBJECT_PUT'),bytes);expect(put.state).toBe('RETURNED');if(put.state!=='RETURNED')throw new Error('W4B2_RAW_PUT_REQUIRED');
    const read=await io.read(request('OBJECT_READ'));expect(read.state).toBe('RETURNED');if(read.state!=='RETURNED')throw new Error('W4B2_RAW_READ_REQUIRED');expect(read.value).toEqual(bytes);
    for(let count=0;count<extraIo;count++)expect((await io.receipt(request('OBJECT_RECEIPT'))).state).toBe('RETURNED');
    expect(await f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(binding),f.profile.controllerId,f.peer.serviceRole,rawResult.rawResultId,ref.blobId,JSON.stringify(put.value),f.files.bucket])).toMatchObject({allowed:true});
  }
  await journal.parentJoinedOriginal(capture.capture,script.joinAck);const record=await ports.journal.sealOriginal(capture.capture,script.seal()),finalized=script.finalized(record),expected=await journal.finishOriginal(capture.capture,{outcome:script.outcome(record,rawResult),finalized,brokerJoin:{end:'EXPECTED',finalized}}),key={binding,expected};
  const bridge=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.recordIn(tx,key),true);expect(bridge.state).toBe('VERIFIED');
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[bridge.operation!,bridge.termination!]}),true)).toBe('JOINED');
  return {scope:scope!,call,key,bridge,journal,ports,capture:capture.capture};
}
async function originalFacts(f:WindowsNativeFixture,owner:WindowsNativeCostOwner,key:WindowsNativeOriginalKey){
  type Bundle={state:{facts:{input:{value:unknown};basis:{value:unknown}|null}}};
  const original=await lookup<{version:1;mode:'ORIGINAL';key:WindowsNativeOriginalKey;inputRef:Ref;basisRef:Ref|null;bundle:Bundle}>(f,{version:1,mode:'ORIGINAL',owner,key});expect(original).not.toBeNull();
  expect(original!.bundle.state.facts.input.value).toBeNull();const bundle=structuredClone(original!.bundle),input=await lookup<{value:unknown}>(f,{version:1,mode:'SOURCE',owner,ref:original!.inputRef});expect(input).not.toBeNull();bundle.state.facts.input.value=input!.value;
  if(original!.basisRef!==null){expect(bundle.state.facts.basis!.value).toBeNull();const basis=await lookup<{value:unknown}>(f,{version:1,mode:'SOURCE',owner,ref:original!.basisRef});expect(basis).not.toBeNull();bundle.state.facts.basis!.value=basis!.value;}
  expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(1572864);return validateWindowsNativeEvidenceBundle(bundle,key,'trio_web_worker');
}

it.each([
  {mode:'CREATED' as const,user:'9007199254740995',kernel:'0',expected:'900719925.4740995'},
  {mode:'CREATED' as const,user:'18446744073709551615',kernel:'18446744073709551615',expected:'3689348814741.910323'},
  {mode:'NOT_ATTEMPTED' as const,user:'0',kernel:'0',expected:'0'},
])('W4-B2 real original $mode user=$user kernel=$kernel projects exact CPU $expected',async test=>withPrepared(async(f,x)=>{
  const native=await nativeOriginal(f,x,test.mode,test.mode==='CREATED'?{userTime100ns:test.user,kernelTime100ns:test.kernel}:{}),facts=await originalFacts(f,x.owner,native.key),census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();
  const scopeRef={evidenceId:native.scope.scopeId,evidenceDigest:native.scope.scopeDigest},callRef={evidenceId:native.call.callId,evidenceDigest:native.call.callDigest},key={version:1,kind:'NATIVE',originalKey:native.key,scopeRef,callRef,componentId:'native-image',rawSetDigest:census!.rawSetDigest};
  const base={version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint},operation={...base,kind:'WINDOWS_NATIVE_COST_ATTRIBUTION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceOperation:native.bridge.operation,sourceTermination:native.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,sourceOperationId:facts.binding.jobId,sourceEventId:facts.accounting?.event.eventId??facts.observations.termination.evidenceId,accounting:facts.accounting,quantity:test.expected,unit:'windows-job-cpu-second-v1'}},termination={...base,kind:'WINDOWS_NATIVE_COST_TERMINATION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceTermination:native.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,termination:facts.termination}};
  const before=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id")).rows;
  const projected=await project<{operation:Ref;termination:Ref}>(f,x.owner,key,operation,termination);expect(projected).not.toBeNull();expect(projected!.operation.evidenceDigest).toBe(digest(operation));expect(projected!.termination.evidenceDigest).toBe(digest(termination));expect(projected!.operation.evidenceId).not.toBe(projected!.termination.evidenceId);
  expect(await project(f,x.owner,key,operation,termination)).toEqual(projected);expect(await project(f,x.owner,key,{...operation,value:{...operation.value,quantity:'1'}},termination)).toBeNull();
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id")).rows).toEqual(before);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_allocations')).rows).toEqual([{n:0}]);
  if(test.mode==='NOT_ATTEMPTED'){expect(facts.accounting).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:0}]);}
}),120000);

async function putOriginal(f:WindowsNativeFixture,x:Pick<Prepared,'owner'|'execution'>,kind:string,value:unknown){
  const wrapper=kind==='OUTCOME'?value:{version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint,kind,value},ref={evidenceId:randomUUID(),evidenceDigest:digest(wrapper)};
  await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)',[f.seed.accountId,ref.evidenceId,x.owner.executionId,kind,ref.evidenceDigest,tx.now,JSON.stringify(wrapper)]));return ref;
}

it('W4-B2 an original ATTEMPT and checkpoint intent without reservation or binding remain visible and forbid absence',async()=>withPrepared(async(f,x)=>{
  const target={sourceExecutionId:x.owner.executionId,inputFingerprint:x.owner.inputFingerprint,outputDigest:sha256('W4B2 original checkpoint output')},attempt={version:1,attemptId:randomUUID(),attemptDigest:sha256('W4B2 original attempt'),purpose:'PRE_DISPATCH',consumerExecutionId:x.owner.executionId,consumerRequestId:x.execution.input.requestId,targets:[target]};
  await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',attempt);
  const original=await f.originalIntent(x.execution,'REQUEST_CHECKPOINT'),semanticCaptureDigest=digest({version:1,phase:'CHECKPOINT',currentRequestId:x.execution.input.requestId,originExecutionId:target.sourceExecutionId,inputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest}),{logicalOperationKey:_old,...base}=original.intent,intent={...base,semanticCaptureDigest,logicalOperationKey:nativeLogicalOperationKey({...base,semanticCaptureDigest})};
  // An administrator supplies a pre-existing legacy raw row in this isolated DB.
  await f.admin.transaction(async client=>{
    await client.query('ALTER TABLE manga_web.native_job_intents DISABLE TRIGGER windows_native_cost_intent_guard');
    await client.query('INSERT INTO manga_web.native_job_intents(account_id,job_id,owner_service,parent_instance_id,task,task_version,profile_digest,input_digest,operation_input_digest,target_kind,target_id,semantic_capture_digest,logical_operation_key,protected_intent,intent_digest,created_at) VALUES($1,$2,\'trio_web_worker\',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp())',[f.seed.accountId,intent.jobId,intent.parentInstanceId,intent.task,intent.taskVersion,intent.profileDigest,intent.inputDigest,intent.operationInputDigest,intent.targetKind,intent.targetId,intent.semanticCaptureDigest,intent.logicalOperationKey,JSON.stringify(intent),digest(intent)]);
    await client.query('ALTER TABLE manga_web.native_job_intents ENABLE TRIGGER windows_native_cost_intent_guard');
  });
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.rows.some(row=>row.kind==='INTENT'&&row.id===intent.jobId)).toBe(true);expect(census!.originals).toEqual([expect.objectContaining({key:null,classification:'UNCONFIRMED'})]);
  expect(await project(f,x.owner,{version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef})).toBeNull();
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_reservations')).rows).toEqual([{n:0}]);
}));

it('W4-B2 a unique immutable legacy scope bootstraps reads without writes and first project registers the original owner',async()=>withPrepared(async(f,x)=>{
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()))).not.toBeNull();
  await f.admin.transaction(async client=>{await client.query('ALTER TABLE manga_web.windows_stage_cost_owners DISABLE TRIGGER immutable_record');await client.query('DELETE FROM manga_web.windows_stage_cost_owners WHERE account_id=$1',[f.seed.accountId]);await client.query('ALTER TABLE manga_web.windows_stage_cost_owners ENABLE TRIGGER immutable_record');});
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census?.owner).toEqual(x.owner);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_owners')).rows).toEqual([{n:0}]);
  expect(await project(f,x.owner,{version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef})).not.toBeNull();
  expect((await f.admin.pool.query('SELECT owner_body,owner_capture FROM manga_web.windows_stage_cost_owners')).rows).toEqual([{owner_body:x.owner,owner_capture:x.target.protectedOwnerCapture}]);
}));

it('W4-B2 completion refs select the original FINAL verified operations and exclude PRE and crossed attempt digests',async()=>withPrepared(async(f,x)=>{
  const outcome=await putOriginal(f,x,'OUTCOME',{outcome:'FAILURE',usageConfirmed:true,costUsd:'0'}),target=originalTarget(x,'synthetic-final-output'),attempt=await originalFinalAttempt(f,x,[target]),final=await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',attempt);
  const operation=await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',originalValidationOperation(attempt,target)),verified=await putOriginal(f,x,'CHECKPOINT_VALIDATION_VERIFIED',{version:1,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,facts:{attemptId:attempt.attemptId,operations:[operation]}}),preId=randomUUID(),preDigest=sha256('W4B2 PRE');
  await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',{...attempt,purpose:'PRE_DISPATCH',attemptId:preId,attemptDigest:preDigest,targets:[]});await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',{...originalValidationOperation(attempt,target),attemptId:preId,attemptDigest:preDigest});await putOriginal(f,x,'CHECKPOINT_VALIDATION_VERIFIED',{version:1,attemptId:attempt.attemptId,attemptDigest:preDigest,facts:{attemptId:attempt.attemptId,operations:[]}});
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.completion).toEqual({kind:'EXECUTION',refs:[outcome,final,operation,verified].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1)});
}));

it.each(['missing-verified','unlisted-operation','missing-operation','ambiguous-final'] as const)('W4-B2 original FINAL completion waits on %s rather than selecting a partial set',async defect=>withPrepared(async(f,x)=>{
  await putOriginal(f,x,'OUTCOME',{outcome:'SUCCESS',usageConfirmed:true,costUsd:'0',evidenceId:randomUUID(),started:true,finishReason:'ORIGINAL_COMPLETION',providerRef:null,data:null});
  const target=originalTarget(x,defect),attempt=await originalFinalAttempt(f,x,defect==='missing-operation'?[target]:[]),{attemptId,attemptDigest}=attempt;await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',attempt);
  if(defect!=='missing-verified')await putOriginal(f,x,'CHECKPOINT_VALIDATION_VERIFIED',{version:1,attemptId,attemptDigest,facts:{attemptId,operations:defect==='missing-operation'?[{evidenceId:randomUUID(),evidenceDigest:sha256('missing-operation')}]:[]}});
  if(defect==='unlisted-operation')await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',originalValidationOperation(attempt,target));
  if(defect==='ambiguous-final')await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',{...attempt,attemptId:randomUUID(),attemptDigest:sha256('other-final')});
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.completion).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
}));

function originalTarget(x:Prepared,label:string):CheckpointValidationTarget{return {checkpointId:randomUUID(),sourceRequestId:x.execution.input.requestId,sourceExecutionId:x.owner.executionId,logicalStepId:x.execution.input.stage,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint,input:{evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint},basis:x.owner.basisRef,outputDigest:sha256(label),stageContract:x.execution.input.settings.contractVersion,assets:[]};}
async function originalFinalAttempt(f:WindowsNativeFixture,x:Prepared,targets:CheckpointValidationTarget[]):Promise<CheckpointValidationAttempt>{
  // The unchanged journal supplies the original owner/INPUT/BASIS/claim schema.
  // FINAL metadata here is a v1 SQL fixture, not a nonempty v2 live consumer.
  const journal=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64}),pre=await f.worker.accountTransaction(f.seed.accountId,tx=>journal.beginIn(tx,x.execution.input,'PRE_DISPATCH'),true),{attemptDigest:_digest,...original}=pre;
  const body={...original,purpose:'FINAL_COMMIT' as const,attemptId:randomUUID(),targets};return {...body,attemptDigest:digest(body)};
}
function originalValidationOperation(attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget):CheckpointValidationOperation{return {version:1,operationId:randomUUID(),attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest,semantic:{eventId:randomUUID(),kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:[],native:[]};}

it('W4-B2 real FINAL_COMMIT purpose and original empty v1 schema are present in public census completion',async()=>withPrepared(async(f,x)=>{
  const {work:nw}=await zeroWindowsWork(f,x),attempt=await originalFinalAttempt(f,x,[]),ref=await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',attempt),verified=await putOriginal(f,x,'CHECKPOINT_VALIDATION_VERIFIED',{version:1,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,facts:{attemptId:attempt.attemptId,operations:[]}});
  const outcome=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE kind='OUTCOME'")).rows[0];expect(nw.terminationEvidence).toContainEqual(outcome);
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.completion).toEqual({kind:'EXECUTION',refs:[outcome,ref,verified].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1)});
}));

it.each(['duplicate-operation-target','duplicate-target'] as const)('W4-B2 original FINAL_COMMIT %s refuses both public CENSUS completion and public SEAL',async defect=>withPrepared(async(f,x)=>{
  const {basis,reader,work:nw}=await zeroWindowsWork(f,x),a=originalTarget(x,'A'),b=defect==='duplicate-target'?a:originalTarget(x,'B'),attempt=await originalFinalAttempt(f,x,[a,b]);await putOriginal(f,x,'CHECKPOINT_VALIDATION_ATTEMPT',attempt);
  const operations=[await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',originalValidationOperation(attempt,a)),await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',originalValidationOperation(attempt,a))];await putOriginal(f,x,'CHECKPOINT_VALIDATION_VERIFIED',{version:1,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,facts:{attemptId:attempt.attemptId,operations}});
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect.soft(census!.completion).toBeNull();
  let work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);
  if(work===null){const p=await project<{operation:Ref;termination:Ref;value:{operationId:string;eventId:string}}>(f,x.owner,{version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef});expect(p).not.toBeNull();work={...structuredClone(nw),joinedEvidence:[...nw.joinedEvidence,p!.operation],terminationEvidence:[...nw.terminationEvidence,p!.termination],sources:[...nw.sources,{sourceOperationId:p!.value.operationId,sourceEventId:p!.value.eventId,target:'QUANTITY',componentId:'native-image',evidence:[p!.operation]}],facts:{...nw.facts,quantities:[{componentId:'native-image',captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:'0',unit:'windows-job-cpu-second-v1',evidenceRefs:[p!.operation.evidenceId]}]}};}
  const candidate=await sqlCandidate(f,x,work,nw),sealed=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value,true);expect.soft(sealed).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
}));

async function zeroWindowsWork(f:WindowsNativeFixture,x:Pick<Prepared,'costs'|'execution'|'owner'>,options:{preparation?:'STOPPED'|'FAILED';providerUsd?:string;rich?:boolean;omitSourceTargets?:readonly('PROVIDER'|'ALLOCATION')[];sourceIds?:Partial<Record<'PROVIDER'|'ALLOCATION',{operationId:string;eventId:string}>>}={}){
  if(!(await f.admin.pool.query('SELECT 1 FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId])).rowCount)expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId])).rows).toEqual([{n:1}]);
  const basis=(await f.admin.pool.query<{body:FullStageCostBasis}>('SELECT protected_observation->\'value\' AS body FROM manga_web.execution_evidence WHERE evidence_id=$1',[x.owner.basisRef.evidenceId])).rows[0].body,captureDigest=basis.captureDigest;
  const provider={scope:'ACTUAL_AI_USD' as const,captureDigest,state:'CONFIRMED' as const,actualUsd:options.providerUsd??'0'},allocation={captureDigest,mode:basis.capture.mode,funding:basis.capture.mode==='FREE'?'FREE_OPERATIONS' as const:'PAID_PROCESSING' as const,basisVersion:basis.snapshot!.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'};
  const sources:OperationalStageCostWorkSet['sources']=[],operations:{operationId:string;eventId:string;outcome:'RETURNED'}[]=[];
  const quantities:NonNullable<OperationalStageCostWorkSet['facts']['quantities']>=options.rich?[{componentId:'s'.repeat(128),captureDigest,state:'CONFIRMED',quantity:'1024',unit:'b'.repeat(128),evidenceRefs:[]},{componentId:'m'.repeat(128),captureDigest,state:'CONFIRMED',quantity:'256',unit:'e'.repeat(128),evidenceRefs:[]}]:[];
  for(const [target,fact] of [['PROVIDER',provider],['ALLOCATION',allocation]] as const){if(options.omitSourceTargets?.includes(target))continue;const ids=options.sourceIds?.[target],operationId=ids?.operationId??randomUUID(),eventId=ids?.eventId??randomUUID(),evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact});sources.push({sourceOperationId:operationId,sourceEventId:eventId,target,componentId:null,evidence:[evidence]});operations.push({operationId,eventId,outcome:'RETURNED'});}
  const ended=(await f.admin.pool.query<{protected_event:WindowsCostedIoEvent}>('SELECT en.protected_event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 ORDER BY st.operation_id',[f.seed.accountId,x.owner.executionId])).rows;
  for(const {protected_event:io} of ended){const fact=options.rich?(({evidenceRefs:_refs,...fact})=>fact)(quantities[0]):provider,evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:io.operationId,eventId:io.eventId,fact,io});sources.push({sourceOperationId:io.operationId,sourceEventId:io.eventId,target:options.rich?'QUANTITY':'PROVIDER',componentId:options.rich?quantities[0].componentId:null,evidence:[evidence]});operations.push({operationId:io.operationId,eventId:io.eventId,outcome:io.state as 'RETURNED'});}
  if(options.rich)for(let index=0;index<256;index++){const operationId=randomUUID(),eventId=randomUUID(),fact=(({evidenceRefs:_refs,...fact})=>fact)(quantities[1]),evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact});sources.push({sourceOperationId:operationId,sourceEventId:eventId,target:'QUANTITY',componentId:quantities[1].componentId,evidence:[evidence]});operations.push({operationId,eventId,outcome:'RETURNED'});}
  for(const q of quantities)q.evidenceRefs=sources.filter(source=>source.target==='QUANTITY'&&source.componentId===q.componentId).flatMap(source=>source.evidence.map(r=>r.evidenceId)).sort();
  const termination=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations}),outcome=await putOriginal(f,x,'OUTCOME',{outcome:options.preparation?'NOT_STARTED':'FAILURE',usageConfirmed:true,costUsd:options.providerUsd??'0',evidenceId:randomUUID(),started:false,finishReason:'SYNTHETIC_LOCAL_ORIGINAL',providerRef:null,data:null});
  await f.admin.pool.query("UPDATE manga_web.executions SET state='FAILED',dispatch_attempted_at=clock_timestamp(),finished_confirmed_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,x.owner.executionId]);
  if(options.preparation){
    await f.admin.pool.query('UPDATE manga_web.executions SET dispatch_attempted_at=NULL,start_confirmed_at=NULL WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId]);
    await f.worker.accountTransaction(f.seed.accountId,async tx=>{const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[f.seed.accountId,x.execution.input.requestId])).rows[0];expect(await finalizeSafe(tx,request,options.preparation!,outcome.evidenceId)).toBe(true);},true);
    expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.active_page_requests WHERE account_id=$1 AND request_id=$2) active,(SELECT count(*)::integer FROM manga_web.free_reservations WHERE account_id=$1 AND request_id=$2 AND state=\'HELD\') held',[f.seed.accountId,x.execution.input.requestId])).rows).toEqual([{active:0,held:0}]);
  }
  const refs=(target:string)=>sources.filter(source=>source.target===target).flatMap(source=>source.evidence.map(ref=>ref.evidenceId));
  const work:OperationalStageCostWorkSet={version:1,executionId:x.owner.executionId,inputFingerprint:x.owner.inputFingerprint,captureDigest,completion:options.preparation?'TERMINAL_PREPARATION':'EXECUTION',joinedEvidence:sources.flatMap(source=>source.evidence).sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),terminationEvidence:[termination,outcome].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER')},quantities,allocation:{...allocation,evidenceRefs:refs('ALLOCATION')}}};
  const nonWindows={nonWindowsIn:async()=>structuredClone(work),checkpointFactsIn:async()=>null},reader=new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows,bounds:{...windowsStageCostBounds}});return {basis,work,reader};
}

it('W4-B2 real empty native census and complete original nonWindows set seal once with historical refs and no native or object calls',async()=>withPrepared(async(f,x)=>{
  const {basis,reader}=await zeroWindowsWork(f,x),io={...f.objectIo};
  const work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(work).not.toBeNull();
  const sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,basis,work!),true);expect(sealed).not.toBeNull();
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:1}]);
  const saved=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at FROM manga_web.execution_evidence WHERE kind='WINDOWS_STAGE_COST_SEAL'")).rows;
  await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.workSetIn(tx,x.execution.input,basis),true)).toEqual(sealed);
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at FROM manga_web.execution_evidence WHERE kind='WINDOWS_STAGE_COST_SEAL'")).rows).toEqual(saved);expect(f.objectIo).toEqual(io);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:0}]);
  const journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:{maxInputBytes:1048576,maxOutputBytes:786432,maxComponents:64,maxEvidenceRefs:8192,maxStringBytes:4096}});
  expect((await journal.lookup(x.execution.input)).state).toBe('UNCONFIRMED');
  const appended=await journal.append(x.execution.input,sealed!.facts);expect(appended.view.state).toBe('CONFIRMED');expect(appended.view.costUsd).toBe('0.000000000000');
}),120000);

const calculatorBounds={maxInputBytes:1048576,maxOutputBytes:786432,maxComponents:64,maxEvidenceRefs:8192,maxStringBytes:4096};
function windowsCost(f:WindowsNativeFixture,basis:FullStageCostBasis,reader:WindowsStageCostReader){
  const journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:calculatorBounds}),preparation=new FullStageCostPreparation(journal,[{stage:basis.capture.stage,profileDigest:basis.capture.profileDigest,snapshot:basis.snapshot}],calculatorBounds),checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64});
  return {journal,cost:OperationalStageCost.windows({db:f.worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}})};
}
async function costsSnapshot(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT
 (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY cost_item_id),'[]') FROM manga_web.cost_items x) costs,
 (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY cost_item_id),'[]') FROM manga_web.execution_limit_expenses x) expenses,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('evidenceId',evidence_id,'digest',evidence_digest,'receivedAt',received_at) ORDER BY evidence_id),'[]') FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')) refs`)).rows[0];}

it('W4-B2 nominal Windows factory completes original C2 CLOSURE and 0019 expense exactly once with historical recovery',async()=>withPrepared(async(f,x)=>{
  const {basis,reader}=await zeroWindowsWork(f,x),{cost}=windowsCost(f,basis,reader),service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
  await cost.prepare(x.execution.input,x.owner.claim);await cost.finishAttempt(x.execution.input);await cost.idle();
  const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.000000000000');expect(view.sealedCalculation).not.toBeNull();
  await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='WINDOWS_STAGE_COST_SEAL') seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures,(SELECT count(*)::integer FROM manga_web.cost_items WHERE component='STAGE_TOTAL') totals,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses")).rows).toEqual([{seals:1,closures:1,totals:1,expenses:1}]);
  const saved=await costsSnapshot(f),io={...f.objectIo};await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
  const recovered=windowsCost(f,basis,reader).cost,next=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,recovered);await recovered.finishAttempt(x.execution.input);await recovered.idle();await f.worker.accountTransaction(f.seed.accountId,tx=>next.reconcileOperationalCostIn(tx,x.execution.input),true);
  expect(await costsSnapshot(f)).toEqual(saved);expect(f.objectIo).toEqual(io);expect(f.provider.calls).toEqual([]);
}),120000);

it('W4-B2 direct forged projection calculation CLOSURE and STAGE_TOTAL writes are denied with 42501',async()=>withPrepared(async(f,x)=>{
  for(const kind of ['WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CLOSURE','OPERATIONAL_COST_CALCULATION']){
    const body={version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint,kind,value:{version:1,state:'CONFIRMED',actualUsd:'0'}};
    await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)',[f.seed.accountId,randomUUID(),x.owner.executionId,kind,digest(body),tx.now,JSON.stringify(body)]),true)).rejects.toMatchObject({code:'42501'});
  }
  await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO manga_web.cost_items(account_id,cost_item_id,execution_id,component,ordinal,state,actual_usd,usage_ref,rate_version,confirmed_at) VALUES($1,$2,$3,'STAGE_TOTAL',0,'CONFIRMED','0','forged','forged',$4)",[f.seed.accountId,randomUUID(),x.owner.executionId,tx.now]),true)).rejects.toMatchObject({code:'42501'});
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
}));

it('W4-B2 signed fresh original and actual I/O complete the full factory seal C2 and 0019 amount with grant replay',async()=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'10000000'}),{basis,reader}=await zeroWindowsWork(f,x),{cost}=windowsCost(f,basis,reader),service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
  await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);
  expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.020000000000');
  await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.cost_items WHERE actual_usd=0.02) totals,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses WHERE actual_usd=0.02) expenses,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go")).rows).toEqual([{seals:1,totals:1,expenses:1,go:1}]);
  const before=await costsSnapshot(f),io={...f.objectIo},replay=await native.ports.original.grantOriginal(native.capture);expect(replay.created).toBe(false);await cost.finishAttempt(x.execution.input);await cost.idle();expect(await costsSnapshot(f)).toEqual(before);expect(f.objectIo).toEqual(io);
}),120000);

it.each(['hidden-source','missing-fact-ref','duplicate-termination','unreferenced-termination'] as const)('W4-B2 direct SQL seal refuses %s in original nonWindows whole set',async defect=>withPrepared(async(f,x)=>{
  const {basis,reader,work:nw}=await zeroWindowsWork(f,x);
  if(defect==='hidden-source')await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:randomUUID(),eventId:randomUUID(),fact:{...nw.facts.provider,evidenceRefs:undefined}});
  if(defect==='missing-fact-ref')nw.facts.provider!.evidenceRefs=[];
  if(defect==='duplicate-termination'){
    const original=(await f.admin.pool.query("SELECT protected_observation->'value' value FROM manga_web.execution_evidence WHERE kind='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION'")).rows[0].value,extra=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{...original,version:2});nw.terminationEvidence.push(extra);
  }
  if(defect==='unreferenced-termination')await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId:randomUUID(),eventId:randomUUID(),outcome:'RETURNED'}]});
  const work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);
  if(work!==null){const candidate=await sqlCandidate(f,x,work,nw);expect(await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value,true)).toBeNull();}
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.cost_items) costs,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses")).rows).toEqual([{seals:0,costs:0,expenses:0}]);
}));

it('W4-B2 forced postseal raw mismatch latches conflict while preserving original amount refs dates expense and reservation',async()=>withPrepared(async(f,x)=>{
  const {basis,reader}=await zeroWindowsWork(f,x),{cost}=windowsCost(f,basis,reader),service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost),input=x.execution.input;
  await cost.finishAttempt(input);await cost.idle();await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,input),true);
  const saved=await costsSnapshot(f),permits=(await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits')).rows,budget=(await f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations')).rows,io={...f.objectIo};expect(saved.expenses).toHaveLength(1);
  await f.admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)',[f.seed.accountId,randomUUID(),input.executionId,'FORCED_POSTSEAL_RAW',digest({late:true}),JSON.stringify({late:true})]);
  const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,input),true);expect(view.state).toBe('CONFLICT');expect(view.costUsd).toBeNull();expect(view.calculations).toHaveLength(1);
  await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,input),true);
  const after=await costsSnapshot(f);expect(after.expenses).toEqual(saved.expenses);expect(after.refs).toEqual(saved.refs);expect(after.costs).toEqual(saved.costs.map((row:Record<string,unknown>)=>({...row,evidence_conflict:true})));
  expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits')).rows).toEqual(permits);expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations')).rows).toEqual(budget);expect(f.objectIo).toEqual(io);
  await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("UPDATE cost_items SET actual_usd='0.01' WHERE account_id=$1",[f.seed.accountId]),true)).rejects.toMatchObject({code:'42501'});
}),120000);

it.each(['STOPPED','FAILED'] as const)('W4-B2 %s NOT_STARTED terminal preparation closes actual preparation I/O and cost without reopening GO or I/O',async requestState=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()));expect(scope).not.toBeNull();
  const envelope=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId:'preparation-io'},new Map([['preparation-io',x.source]]),windowsFrameLimits),body={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:nativeOperationInputDigest(envelope),componentId:'native-image'},call={...body,callDigest:digest(body)};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call))).toEqual(call);
  const request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null},io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),receipt=await io.receipt(request);expect(receipt.state).toBe('RETURNED');
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[receipt.event.ended!]}),true)).toBe('JOINED');
  const {basis,reader}=await zeroWindowsWork(f,x,{preparation:requestState,providerUsd:'0.02'}),{cost}=windowsCost(f,basis,reader),objects={...f.objectIo},intentBody={version:1 as const,jobId:envelope.jobId,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,inputDigest:envelope.inputDigest,operationInputDigest:call.operationInputDigest,parentInstanceId:randomUUID(),targetKind:x.target.targetKind,targetId:x.target.targetId,semanticCaptureDigest:x.target.semanticCaptureDigest,protectedOwnerCapture:x.target.protectedOwnerCapture,claim:x.target.claim},intent={...intentBody,logicalOperationKey:nativeLogicalOperationKey(intentBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.admitIn(tx,scope!,call,intent,{...x.capacity,sourceInput:x.target.sourceInput!},'native-image'),true)).toMatchObject({allowed:false,reason:'WINDOWS_NATIVE_COST_SCOPE_UNCONFIRMED'});
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true)).toBeNull();
  expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents) intents,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go')).rows).toEqual([{intents:0,go:0}]);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,{...request,operationId:randomUUID(),eventId:randomUUID()}),true)).toBeNull();
  await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.020000000000');
  await f.worker.accountTransaction(f.seed.accountId,tx=>new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost).reconcileOperationalCostIn(tx,x.execution.input),true);
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE work_set->>'completion'='TERMINAL_PREPARATION') seals,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses WHERE actual_usd=0.02) expenses,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go")).rows).toEqual([{seals:1,expenses:1,go:0}]);
  const saved=await costsSnapshot(f);await f.admin.pool.query("UPDATE manga_web.executions SET state='SUCCEEDED',dispatch_attempted_at=clock_timestamp(),start_confirmed_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId]);await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
  expect((await f.worker.accountTransaction(f.seed.accountId,tx=>windowsCost(f,basis,reader).cost.readIn(tx,x.execution.input),true)).state).toBe('CONFIRMED');expect(await costsSnapshot(f)).toEqual(saved);expect(f.objectIo).toEqual(objects);expect(f.provider.calls).toEqual([]);
}),120000);

it.each(['NATIVE','ABSENCE','SEAL','CALCULATION','CLOSURE','STAGE_TOTAL','EXPENSE'] as const)('W4-B2 %s actual COMMIT then ACK loss reuses original refs amounts dates and expense',async phase=>withPrepared(async(f,x)=>{
  if(phase==='NATIVE'){expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);await nativeOriginal(f,x,'CREATED');}
  const {basis,reader}=await zeroWindowsWork(f,x),{cost,journal}=windowsCost(f,basis,reader),input=x.execution.input,transaction=f.worker.transaction.bind(f.worker);
  const marker=phase==='NATIVE'?'WINDOWS_NATIVE_COST_ATTRIBUTION':phase==='ABSENCE'?'WINDOWS_NATIVE_COST_ABSENCE':phase==='SEAL'?'WINDOWS_STAGE_COST_SEAL':phase==='CALCULATION'?'OPERATIONAL_COST_CALCULATION':phase==='CLOSURE'?'OPERATIONAL_COST_CLOSURE':null;
  const count=async()=>marker?(await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE kind=$1',[marker])).rows[0].n:phase==='EXPENSE'?(await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.execution_limit_expenses')).rows[0].n:(await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.cost_items WHERE component='STAGE_TOTAL'")).rows[0].n;
  let work:OperationalStageCostWorkSet|null=null,sealed:OperationalStageCostWorkSet|null=null;
  if(phase!=='ABSENCE'&&phase!=='NATIVE')work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,input,basis),true);
  if(phase==='CALCULATION')sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,input,basis,work!),true);
  if(phase==='STAGE_TOTAL'||phase==='EXPENSE'){await cost.finishAttempt(input);await cost.idle();}
  const before=await count();let lost=false;const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>{const value=await transaction(run);if(!lost&&await count()>before){lost=true;throw new Error('W4B2_ACK_LOST_AFTER_COMMIT');}return value;});
  try{
    const action=()=>phase==='ABSENCE'||phase==='NATIVE'?f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,input,basis),true):phase==='SEAL'?f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,input,basis,work!),true):phase==='CALCULATION'?journal.append(input,sealed!.facts):phase==='CLOSURE'?cost.finishAttempt(input):f.worker.accountTransaction(f.seed.accountId,tx=>new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost).reconcileOperationalCostIn(tx,input),true);
    await expect(action()).rejects.toThrow('W4B2_ACK_LOST_AFTER_COMMIT');expect(lost).toBe(true);
  }finally{spy.mockRestore();}
  const saved=await costsSnapshot(f),projectionRows=(await f.admin.pool.query('SELECT operation_id,operation_digest,termination_id,termination_digest,created_at FROM manga_web.windows_stage_cost_projections')).rows;
  if(phase==='ABSENCE'||phase==='NATIVE'){expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,input,basis),true)).not.toBeNull();expect((await f.admin.pool.query('SELECT operation_id,operation_digest,termination_id,termination_digest,created_at FROM manga_web.windows_stage_cost_projections')).rows).toEqual(projectionRows);}
  else if(phase==='SEAL'){expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.workSetIn(tx,input,basis),true)).not.toBeNull();expect(await costsSnapshot(f)).toEqual(saved);}
  else if(phase==='CALCULATION'){expect((await journal.append(input,sealed!.facts)).view.state).toBe('CONFIRMED');expect(await costsSnapshot(f)).toEqual(saved);}
  else{await cost.finishAttempt(input);await cost.idle();if(phase==='STAGE_TOTAL'||phase==='EXPENSE'){expect(saved.expenses).toHaveLength(1);await f.worker.accountTransaction(f.seed.accountId,tx=>new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost).reconcileOperationalCostIn(tx,input),true);}expect(await costsSnapshot(f)).toEqual(saved);}
}),120000);

async function twoClientRace(f:WindowsNativeFixture,leftSql:string,leftValues:unknown[],rightSql:string,rightValues:unknown[],roles:{left:'trio_web_worker'|'trio_web_controller';right:'trio_web_worker'|'trio_web_controller'}={left:'trio_web_worker',right:'trio_web_worker'}){
  const make=(role:typeof roles.left)=>new pg.Client({connectionString:role==='trio_web_worker'?f.worker.connectionString:f.controller.connectionString,options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});
  const left=make(roles.left),right=make(roles.right);let pending:Promise<pg.QueryResult>|undefined,pendingFault:unknown;
  try{
    await left.connect();await right.connect();for(const [client,role] of [[left,roles.left],[right,roles.right]] as const){await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query('SET LOCAL ROLE '+role);await client.query("SET LOCAL statement_timeout='10s'");await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);expect((await client.query('SELECT current_user role')).rows[0].role).toBe(role);}
    const leftPid=(await left.query('SELECT pg_backend_pid() id')).rows[0].id,rightPid=(await right.query('SELECT pg_backend_pid() id')).rows[0].id,first=(await left.query(leftSql,leftValues)).rows[0].value;
    pending=right.query(rightSql,rightValues);void pending.catch(error=>{pendingFault=error;});let blocked=false;for(let tick=0;tick<200;tick++){if(pendingFault)throw pendingFault;blocked=(await f.admin.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) blocked',[leftPid,rightPid])).rows[0].blocked;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));}
    expect(blocked).toBe(true);await left.query('COMMIT');const second=(await pending).rows[0].value;await right.query('COMMIT');console.info(JSON.stringify({w4b2Race:{actualClients:2,roles,blockingPids:{left:leftPid,right:rightPid},blockingObserved:true,retries:0,deadlocks:0,serializationFailures:0}}));return {first,second};
  }finally{await left.query('ROLLBACK').catch(()=>undefined);await right.query('ROLLBACK').catch(()=>undefined);if(pending)await pending.catch(()=>undefined);await left.end();await right.end();}
}

async function sqlCandidate(f:WindowsNativeFixture,x:Pick<Prepared,'owner'>,work:OperationalStageCostWorkSet,nonWindows:OperationalStageCostWorkSet){
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();const sorted=(refs:Ref[])=>refs.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
  const projections=(await f.admin.pool.query('SELECT kind,operation_id,operation_digest,termination_id,termination_digest FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND raw_set_digest=$2',[f.seed.accountId,raw!.rawSetDigest])).rows,nw=structuredClone(nonWindows),workSet=structuredClone(work);
  for(const set of [nw,workSet]){set.sources.sort((a,b)=>a.sourceOperationId<b.sourceOperationId?-1:1);for(const source of set.sources)sorted(source.evidence);set.joinedEvidence=sorted(set.joinedEvidence);set.terminationEvidence=sorted(set.terminationEvidence);set.facts.provider!.evidenceRefs.sort();set.facts.allocation!.evidenceRefs.sort();for(const q of set.facts.quantities!)q.evidenceRefs.sort();}
  const membership={version:1,rawSetDigest:raw!.rawSetDigest,scopeRefs:sorted(raw!.rows.filter(row=>row.kind==='SCOPE').map(row=>row.ref!)),attributionRefs:sorted(projections.filter(row=>row.kind==='NATIVE').map(row=>({evidenceId:row.operation_id,evidenceDigest:row.operation_digest}))),absenceRefs:sorted(projections.filter(row=>row.kind==='ABSENCE').map(row=>({evidenceId:row.operation_id,evidenceDigest:row.operation_digest}))),terminationRefs:sorted(projections.map(row=>({evidenceId:row.termination_id,evidenceDigest:row.termination_digest}))),nonWindowsWorkSetDigest:digest(nw),componentMappingDigest:raw!.root.componentsDigest,completion:raw!.completion};
  return {version:1,rawSetDigest:raw!.rawSetDigest,membershipDigest:digest(membership),nonWindowsWorkSet:nw,workSet,completion:raw!.completion};
}

// Build a genuine current DB absence projection independently of the TS reader.
// Direct SQL rejection cannot be credited to an earlier reader validation.
async function absenceCandidate(f:WindowsNativeFixture,x:Pick<Prepared,'owner'>,basis:FullStageCostBasis,nw:OperationalStageCostWorkSet){
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();
  const p=await project<{operation:Ref;termination:Ref;value:{operationId:string;eventId:string}}>(f,x.owner,{version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:census!.rawSetDigest,basisRef:x.owner.basisRef});expect(p).not.toBeNull();
  const work:OperationalStageCostWorkSet={...structuredClone(nw),joinedEvidence:[...nw.joinedEvidence,p!.operation],terminationEvidence:[...nw.terminationEvidence,p!.termination],sources:[...nw.sources,{sourceOperationId:p!.value.operationId,sourceEventId:p!.value.eventId,target:'QUANTITY',componentId:'native-image',evidence:[p!.operation]}],facts:{...nw.facts,quantities:[...nw.facts.quantities!,{componentId:'native-image',captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:'0',unit:'windows-job-cpu-second-v1',evidenceRefs:[p!.operation.evidenceId]}]}};
  work.facts.quantities!.sort((a,b)=>a.componentId<b.componentId?-1:a.componentId>b.componentId?1:0);
  return sqlCandidate(f,x,work,nw);
}

it('W4-B2 direct SQL seal rejects an unfinished source B hidden as extra evidence of ended source A',async()=>withPrepared(async(f,x)=>{
  const {basis,work:nw}=await zeroWindowsWork(f,x),a=nw.sources.find(source=>source.target==='PROVIDER')!,b=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:randomUUID(),eventId:randomUUID(),fact:(({evidenceRefs:_refs,...fact})=>fact)(nw.facts.provider!)});
  a.evidence.push(b);nw.joinedEvidence.push(b);nw.facts.provider!.evidenceRefs.push(b.evidenceId);
  const candidate=await absenceCandidate(f,x,basis,nw),raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw!.rawSetDigest).toBe(candidate.rawSetDigest);expect(raw!.rows.some(row=>row.ref?.evidenceId===b.evidenceId)).toBe(true);
  expect(await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value,true)).toBeNull();
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures")).rows).toEqual([{seals:0,allocations:0,closures:0}]);
}));

it.each(['WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION'] as const)('W4-B2 source job N+1 %s with a different original Windows ref cannot hide behind exact joins',async kind=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const native=await nativeOriginal(f,x,'NOT_ATTEMPTED'),{basis,reader,work:nw}=await zeroWindowsWork(f,x),work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(work).not.toBeNull();
  const original=(await f.admin.pool.query('SELECT protected_observation body FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,kind==='WINDOWS_NATIVE_OPERATION'?native.bridge.operation!.evidenceId:native.bridge.termination!.evidenceId])).rows[0].body,extra={...original,value:{...original.value,windowsEvidenceRef:{...original.value.windowsEvidenceRef,recordId:randomUUID()}}},extraRef={evidenceId:randomUUID(),evidenceDigest:digest(extra)};
  await f.admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)',[f.seed.accountId,extraRef.evidenceId,original.executionId,kind,extraRef.evidenceDigest,JSON.stringify(extra)]);
  expect((await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIn(tx,native.key),true)).state).toBe('WAIT');
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.rows.some(row=>row.ref?.evidenceId===extraRef.evidenceId&&row.contentDigest===extraRef.evidenceDigest)).toBe(true);expect.soft((census!.originals[0] as {classification:string}).classification).toBe('UNCONFIRMED');
  expect.soft(await lookup(f,{version:1,mode:'ORIGINAL',owner:x.owner,key:native.key})===null).toBe(true);
  // Admin-only adversarial setup carries the genuine immutable projection to
  // this actual changed raw set, so final SEAL is checked independently of an
  // earlier TS/project rejection. Source bodies and evidence stay unchanged.
  const updated=(await f.admin.pool.query(`INSERT INTO manga_web.windows_stage_cost_projections(account_id,execution_id,key_digest,key_body,kind,component_id,job_id,raw_set_digest,operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body,created_at)
    SELECT account_id,execution_id,manga_web.windows_native_cost_hash(jsonb_set(key_body,'{rawSetDigest}',to_jsonb($3::text))),jsonb_set(key_body,'{rawSetDigest}',to_jsonb($3::text)),kind,component_id,job_id,$3,operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body,created_at
    FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND kind='NATIVE' ORDER BY created_at LIMIT 1 RETURNING key_body`,[f.seed.accountId,x.owner.executionId,census!.rawSetDigest])).rows;expect(updated).toHaveLength(1);
  const projection=(await f.admin.pool.query('SELECT operation_body,termination_body FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND raw_set_digest=$3',[f.seed.accountId,x.owner.executionId,census!.rawSetDigest])).rows[0];expect.soft(await project(f,x.owner,updated[0].key_body,projection.operation_body,projection.termination_body)===null).toBe(true);
  const candidate=await sqlCandidate(f,x,work!,nw);expect(candidate.rawSetDigest).toBe(census!.rawSetDigest);expect.soft(await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value===null,true)).toBe(true);
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures")).rows).toEqual([{seals:0,allocations:0,closures:0}]);
}),120000);

it.each(['WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION'] as const)('W4-B2 sealed ORIGINAL refuses contradictory %s in its whole source job without current authorization',async kind=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const native=await nativeOriginal(f,x,'NOT_ATTEMPTED'),{basis,reader}=await zeroWindowsWork(f,x);
  expect(await lookup(f,{version:1,mode:'ORIGINAL',owner:x.owner,key:native.key})).not.toBeNull();
  const candidate=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(candidate).not.toBeNull();
  const sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,basis,candidate!),true);expect(sealed).not.toBeNull();
  const before=(await f.admin.pool.query('SELECT seal_id,seal_digest,lookup_membership,work_set,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations FROM manga_web.windows_stage_cost_seals')).rows;
  await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
  expect(await lookup(f,{version:1,mode:'ORIGINAL',owner:x.owner,key:native.key})).not.toBeNull();
  expect(await lookup(f,{version:1,mode:'SEALED',owner:selector(x.owner)})).not.toBeNull();
  const original=(await f.admin.pool.query('SELECT protected_observation body FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,kind==='WINDOWS_NATIVE_OPERATION'?native.bridge.operation!.evidenceId:native.bridge.termination!.evidenceId])).rows[0].body;
  const extra={...original,value:{...original.value,windowsEvidenceRef:{...original.value.windowsEvidenceRef,recordId:randomUUID()}}},ref={evidenceId:randomUUID(),evidenceDigest:digest(extra)};
  await f.admin.pool.query('INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6)',[f.seed.accountId,ref.evidenceId,original.executionId,kind,ref.evidenceDigest,JSON.stringify(extra)]);
  expect.soft(await lookup(f,{version:1,mode:'ORIGINAL',owner:x.owner,key:native.key})===null).toBe(true);
  expect(await lookup(f,{version:1,mode:'SEALED',owner:selector(x.owner)})).toBeNull();
  expect((await f.admin.pool.query('SELECT seal_id,seal_digest,lookup_membership,work_set,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations FROM manga_web.windows_stage_cost_seals')).rows).toEqual(before);
  expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE'")).rows).toEqual([{n:0}]);
}),120000);

it.each(['snapshot-evidence','rate-evidence','rate-version','rate-usd'] as const)('W4-B2 direct SQL seal waits before immutable insertion when captured BASIS lacks %s',async defect=>withPrepared(async(f,x)=>{
  const {basis,work:nw}=await zeroWindowsWork(f,x),candidate=await absenceCandidate(f,x,basis,nw),{captureDigest:_captureDigest,...capture}=basis.capture,calculated=new FullStageCostCalculator(basis.snapshot,calculatorBounds).calculate(capture,candidate.workSet.facts);
  expect(calculated.state).toBe('UNCONFIRMED');
  expect(await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value,true)).toBeNull();
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.cost_items) costs,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses")).rows).toEqual([{seals:0,costs:0,expenses:0}]);
},f=>prepareWithBasis(f,snapshot=>({...snapshot,evidenceRefs:defect==='snapshot-evidence'?[]:snapshot.evidenceRefs,components:snapshot.components.map(rate=>({...rate,evidenceRefs:defect==='rate-evidence'?[]:rate.evidenceRefs,rateVersion:defect==='rate-version'?null:rate.rateVersion,usdPerUnit:defect==='rate-usd'?null:rate.usdPerUnit}))}))));
it.each(['work-first','seal-first'] as const)('W4-B2 actual two-client %s new scope versus full seal has zero retries and extra side effects',async order=>withPrepared(async(f,x)=>{
  const {basis,reader,work:nw}=await zeroWindowsWork(f,x),work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(work).not.toBeNull();const candidate=await sqlCandidate(f,x,work!,nw);
  const body={version:1,scopeId:randomUUID(),owner:x.owner,target:x.target,phase:'INPUT',validationTargetDigest:null},scope={...body,scopeDigest:digest(body)},scopeSql='SELECT manga_web.windows_native_cost_begin($1::jsonb,$2::jsonb) AS value',sealSql='SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) AS value',scopeValues=[JSON.stringify(x.owner),JSON.stringify(scope)],sealValues=[JSON.stringify(x.owner),JSON.stringify(candidate)];
  const result=await twoClientRace(f,order==='work-first'?scopeSql:sealSql,order==='work-first'?scopeValues:sealValues,order==='work-first'?sealSql:scopeSql,order==='work-first'?sealValues:scopeValues);
  expect(result.first).not.toBeNull();expect(result.second).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:order==='seal-first'?1:0}]);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_scopes')).rows).toEqual([{n:order==='work-first'?1:0}]);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:0}]);
}),120000);

it.each(['REPEATABLE READ','SERIALIZABLE'] as const)('W4-B2 %s refuses first seal without changing transaction isolation or writing a prefix',async isolation=>withPrepared(async(f,x)=>{
  const {basis,reader,work:nw}=await zeroWindowsWork(f,x),work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(work).not.toBeNull();const candidate=await sqlCandidate(f,x,work!,nw),client=new pg.Client({connectionString:f.worker.connectionString,options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});
  try{await client.connect();await client.query('BEGIN ISOLATION LEVEL '+isolation);await client.query('SET LOCAL ROLE trio_web_worker');await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);expect((await client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) AS value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value).toBeNull();expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe(isolation.toLowerCase());await client.query('COMMIT');}finally{await client.query('ROLLBACK').catch(()=>undefined);await client.end();}
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
}));

it('W4-B2 original signed 64 u64-max jobs and actual 1024 I/O form one complete cost seal within encoded bounds',async()=>withPrepared(async(f,x)=>{
  await installSqlObservation(f);
  const originalClaim=x.execution.claim,serviceRenew=f.service.renew.bind(f.service),renewClaims:(typeof originalClaim)[]=[];
  const renewSpy=vi.spyOn(f.service,'renew').mockImplementation(async claim=>{renewClaims.push(claim);expect(claim).toBe(originalClaim);return serviceRenew(claim);});
  try{
  const started=performance.now(),lookupPort=x.costs.stageLookupIn.bind(x.costs),projectPort=x.costs.stageProjectIn.bind(x.costs),sealPort=x.costs.stageSealIn.bind(x.costs),ports:Record<string,number>={},portMs:Record<string,number>={};
  vi.spyOn(x.costs,'stageLookupIn').mockImplementation(async(...args)=>{const mode=(args[1] as {mode:string}).mode,time=performance.now(),value=await lookupPort(...args);portMs[mode]=(portMs[mode]??0)+performance.now()-time;ports[mode]=(ports[mode]??0)+1;if(ports[mode]%32===0)console.info(JSON.stringify({w4b2MaximumPort:{mode,count:ports[mode],totalMs:Math.round(portMs[mode]),elapsedMs:Math.round(performance.now()-started),nullReply:value===null}}));return value;});
  vi.spyOn(x.costs,'stageProjectIn').mockImplementation(async(...args)=>{const time=performance.now(),value=await projectPort(...args);portMs.PROJECT=(portMs.PROJECT??0)+performance.now()-time;ports.PROJECT=(ports.PROJECT??0)+1;if(ports.PROJECT%16===0)console.info(JSON.stringify({w4b2MaximumPort:{mode:'PROJECT',count:ports.PROJECT,totalMs:Math.round(portMs.PROJECT),elapsedMs:Math.round(performance.now()-started),nullReply:value===null}}));return value;});
  vi.spyOn(x.costs,'stageSealIn').mockImplementation(async(...args)=>{const observed=(await args[0].client.query('SELECT manga_web.w4b2_test_owner($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(x.target.protectedOwnerCapture)])).rows[0].value;console.info(JSON.stringify({w4b2BeforeActualSeal:{elapsedMs:Math.round(performance.now()-started),observed}}));const time=performance.now(),value=await sealPort(...args);portMs.SEAL=(portMs.SEAL??0)+performance.now()-time;ports.SEAL=(ports.SEAL??0)+1;console.info(JSON.stringify({w4b2MaximumPort:{mode:'SEAL',count:ports.SEAL,totalMs:Math.round(portMs.SEAL),elapsedMs:Math.round(performance.now()-started),nullReply:value===null}}));return value;});
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name);
  for(let index=0;index<64;index++){
    await renewObserved(f,x,'before-original-'+index);
    const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'18446744073709551615',kernelTime100ns:'18446744073709551615'},14),proof=await operator.confirmWindows(native.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,native.key.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});
    if(index%8===7)console.info(JSON.stringify({w4b2ActualMaximumProgress:{signedOriginals:index+1,actualIo:(index+1)*16}}));
  }
  await renewObserved(f,x,'before-source-assembly');const {basis,reader}=await zeroWindowsWork(f,x,{rich:true,providerUsd:'0.014'}),{cost}=windowsCost(f,basis,reader),census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();expect(census!.originals).toHaveLength(64);console.info(JSON.stringify({w4b2MaximumCensus:{rows:census!.rows.length,elapsedMs:Math.round(performance.now()-started)}}));
  expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends) ends,(SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE state=\'RELEASED\') released')).rows).toEqual([{starts:1024,ends:1024,released:64}]);
  await renewObserved(f,x,'before-cost-finish');const renewalCleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    const transport=await b2SplitTransport(f,x,{profile:true});renewalCleanup.push(()=>transport.close());
    let inFlight:Promise<void>|null=null,successes=0,ticks=0;const failures:unknown[]=[];
    const renew=async(phase:string)=>{const result=await transport.renew(phase);expect(result.success).toBe(true);successes++;};
    await renew('explicit-caller-before-finish');
    // This fixture caller owns the timer; reader/calculator/runtime do not.
    // Each tick calls the existing service.renew(originalClaim), not SQL UPDATE.
    const timer=setInterval(()=>{if(inFlight)return;ticks++;inFlight=renew('explicit-caller-finish-'+ticks).catch(error=>{failures.push(error);}).finally(()=>{inFlight=null;});},1000);
    renewalCleanup.push(async()=>{clearInterval(timer);await inFlight;console.info(JSON.stringify({w4b2MaximumCallerRenew:{originalClaim:x.execution.claim,originalOwnerClaim:x.owner.claim,renewPid:transport.renewPid,ticks,successes,failures:failures.map(error=>error instanceof Error?error.message:String(error)),committedPreparationAndCostTransactions:transport.records.filter(row=>!row.renew&&row.committed).length,callbackAttempts:transport.records.filter(row=>!row.renew).map(row=>({pid:row.pid,attempt:row.attempts,committed:row.committed,observed:row.observation}))}}));if(failures.length)throw new AggregateError(failures,'W4B2_MAXIMUM_ORIGINAL_CLAIM_RENEW_FAILED');});
    await cost.finishAttempt(x.execution.input);await cost.idle();expect(successes).toBeGreaterThan(1);
    const commits=transport.records.filter(row=>!row.renew&&row.committed);expect(commits.length).toBeGreaterThanOrEqual(66);for(const record of commits){expect(record.pid).not.toBe(transport.renewPid);expect(record.observation).not.toBeNull();expect(record.observation!.work_item_id).toBe(x.execution.claim.workId);expect(record.observation!.claim_generation).toBe(x.execution.claim.generation);expect(record.observation!.claim_owner).toBe(x.owner.claim.ownerId);expect(record.observation!.execution_generation).toBe(x.execution.claim.generation);expect(record.observation!.state).toBe('CLAIMED');expect(record.observation!.lease_live).toBe(true);}
  },renewalCleanup);
  const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.calculations[0].result.facts.quantities!.find(q=>q.componentId==='w'.repeat(128))!.quantity).toBe('236118324143482.260672');expect(view.costUsd).toBe('236.132324144762');
  const work=(await f.admin.pool.query('SELECT work_set FROM manga_web.windows_stage_cost_seals')).rows[0].work_set,result=view.calculations[0].result,closure=(await f.admin.pool.query("SELECT protected_observation FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE'")).rows[0].protected_observation;
  const wrapper=(await f.admin.pool.query("SELECT protected_observation FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION'")).rows[0].protected_observation,bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value)),metrics={jobs:64,starts:1024,ends:1024,semantic:256,snapshotComponents:basis.snapshot!.components.length,componentUnitRateVersionMaxBytes:128,operationEventBytes:36,sources:work.sources.length,joined:work.joinedEvidence.length,term:work.terminationEvidence.length,snapshotAndFactRefs:basis.snapshot!.evidenceRefs.length+basis.snapshot!.components.reduce((n,r)=>n+r.evidenceRefs.length,0)+result.facts.provider!.evidenceRefs.length+result.facts.allocation!.evidenceRefs.length+result.facts.quantities!.reduce((n,q)=>n+q.evidenceRefs.length,0),workBytes:bytes(work),resultBytes:bytes(result),wrapperBytes:bytes(wrapper),closureBytes:bytes(closure),summaryBytes:bytes(census)};
  expect(metrics.sources).toBeLessThanOrEqual(2046);expect(metrics.joined+metrics.term).toBeLessThanOrEqual(2046);expect(metrics.snapshotAndFactRefs).toBeLessThanOrEqual(8192);expect(metrics.workBytes).toBeLessThanOrEqual(1048576);expect(metrics.resultBytes).toBeLessThanOrEqual(786432);expect(metrics.wrapperBytes).toBeLessThanOrEqual(1048576);expect(metrics.closureBytes).toBeLessThanOrEqual(1048576);expect(metrics.summaryBytes).toBeLessThanOrEqual(8388608);console.info(JSON.stringify({w4b2ActualMaximum:metrics,ports,portMs,elapsedMs:Math.round(performance.now()-started)}));
  const expenseService=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
  await f.worker.accountTransaction(f.seed.accountId,tx=>expenseService.reconcileOperationalCostIn(tx,x.execution.input),true);
  const settled=await costsSnapshot(f);expect(settled.costs).toHaveLength(1);expect(settled.expenses).toHaveLength(1);expect(settled.costs[0]).toMatchObject({component:'STAGE_TOTAL',ordinal:0,state:'CONFIRMED',usage_ref:'execution-evidence:'+view.calculations[0].evidenceId+':'+view.calculations[0].evidenceDigest});
  const exactCost=async()=>(await f.admin.pool.query('SELECT c.actual_usd::text stage_usd,x.actual_usd::text expense_usd,c.usage_ref,x.evidence_id,x.evidence_digest FROM manga_web.cost_items c JOIN manga_web.execution_limit_expenses x USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 AND c.component=\'STAGE_TOTAL\' AND c.ordinal=0',[f.seed.accountId,x.execution.input.executionId])).rows;
  const exact=await exactCost();expect(exact).toEqual([{stage_usd:'236.132324144762',expense_usd:'236.132324144762',usage_ref:'execution-evidence:'+view.calculations[0].evidenceId+':'+view.calculations[0].evidenceDigest,evidence_id:view.calculations[0].evidenceId,evidence_digest:view.calculations[0].evidenceDigest}]);
  const permitAfter=(await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits ORDER BY execution_id')).rows,budgetAfter=(await f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations ORDER BY request_id')).rows;expect(permitAfter).toHaveLength(1);expect(permitAfter[0].stage_bound_usd).toBe('3.000000000000');expect(budgetAfter).toHaveLength(1);expect(budgetAfter[0].initial_bound_usd).toBe('10.000000000000');
  expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority WHERE singleton')).rows).toEqual([{state:'HALTED',halt_reason:'LIMIT_ACTUAL_OVER_BOUND'}]);
  await f.worker.accountTransaction(f.seed.accountId,tx=>expenseService.reconcileOperationalCostIn(tx,x.execution.input),true);
  expect(await costsSnapshot(f)).toEqual(settled);expect(await exactCost()).toEqual(exact);expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits ORDER BY execution_id')).rows).toEqual(permitAfter);expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations ORDER BY request_id')).rows).toEqual(budgetAfter);
  console.info(JSON.stringify({w4b2MaximumExpense:{stageTotals:1,expenses:1,actualUsd:'236.132324144762',sameOriginalCalculationRef:true,secondCallPreservesRefsAmountDatesPermitAndBudget:true,originalBoundUsd:'3',originalOverBoundGuardPreserved:true}}));
  }finally{try{console.info(JSON.stringify({w4b2MaximumRenewIdentity:{callThrough:true,calls:renewClaims.length,sameOriginalClaimObject:renewClaims.every(claim=>claim===originalClaim),originalClaim}}));}finally{renewSpy.mockRestore();}}
},f=>prepareWithBasis(f,snapshot=>({...snapshot,components:[{componentId:'w'.repeat(128),kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/windows']},{componentId:'z'.repeat(128),kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/absence']},{componentId:'s'.repeat(128),kind:'STORAGE',unit:'b'.repeat(128),rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/storage']},{componentId:'m'.repeat(128),kind:'RENDER',unit:'e'.repeat(128),rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/semantic']}]}),[{task:'DECODE_IMAGE',componentId:'w'.repeat(128)},{task:'POLYGON_MASK',componentId:'z'.repeat(128)}])),600000);
it('W4-B2 0024 preserves original 0023 function OIDs owners ACL search_path roles and all unrelated bodies',async()=>{
  const guard=guardWindowsNativeIo(),connectionString=process.env.TRIO_TEST_DATABASE_URL;
  expect(connectionString).toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/);
  const root=new pg.Client({connectionString});let db:import('../../packages/storage/src/database.js').Database|undefined;
  const {Database}=await import('../../packages/storage/src/database.js'),{migrate}=await import('../../packages/storage/src/migrations.js'),{readFile,readdir}=await import('node:fs/promises');
  try{
    await root.connect();const name='trio_w4b2_old_'+randomUUID().replaceAll('-','');await root.query(`CREATE DATABASE "${name}"`);const url=new URL(connectionString!);url.pathname='/'+name;db=new Database(url.toString());
    const directory=new URL('../../db/migrations/',import.meta.url),names=(await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)&&name<'0024').sort();expect(names).toHaveLength(23);
    await db.transaction(async client=>{await client.query('CREATE SCHEMA trio_migrations; CREATE TABLE trio_migrations.applied(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');for(const name of names){const sql=await readFile(new URL(name,directory),'utf8');await client.query(sql);await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2)',[name,sha256(sql)]);}});
    const metadataSql=`SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.prorettype,p.proretset,p.proisstrict FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid`,bodySql=`SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosrc,p.provolatile,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='manga_web' ORDER BY p.oid`,rolesSql="SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_catalog.pg_roles WHERE rolname LIKE 'trio_web_%' ORDER BY oid";
    const metadataBefore=(await db.pool.query(metadataSql)).rows,bodiesBefore=(await db.pool.query(bodySql)).rows,rolesBefore=(await db.pool.query(rolesSql)).rows,appliedBefore=(await db.pool.query('SELECT name,sha256 FROM trio_migrations.applied ORDER BY name')).rows;
    expect(await migrate(db.pool)).toEqual(['0024_windows_stage_cost_seal.sql']);expect(await migrate(db.pool)).toEqual([]);
    const metadataAfter=(await db.pool.query(metadataSql)).rows,bodiesAfter=(await db.pool.query(bodySql)).rows;
    for(const old of metadataBefore)expect(metadataAfter.find(next=>next.oid===old.oid)).toEqual(old);
    expect((await db.pool.query(rolesSql)).rows).toEqual(rolesBefore);
    expect((await db.pool.query("SELECT name,sha256 FROM trio_migrations.applied WHERE name<'0024' ORDER BY name")).rows).toEqual(appliedBefore);
    const replaceSignatures=['windows_native_cost_activate(jsonb,jsonb)','windows_native_cost_open(uuid)','windows_native_cost_total_guard()','windows_native_cost_cost_guard()'],replaceOids=(await db.pool.query("SELECT to_regprocedure('manga_web.'||signature)::oid oid FROM unnest($1::text[]) signature",[replaceSignatures])).rows.map(row=>row.oid).sort((a,b)=>a-b);
    expect(new Set(replaceOids).size).toBe(replaceSignatures.length);
    expect(bodiesBefore.filter(old=>bodiesAfter.find(next=>next.oid===old.oid)?.prosrc!==old.prosrc).map(row=>row.oid).sort((a,b)=>a-b)).toEqual(replaceOids);
    for(const old of bodiesBefore)if(!replaceOids.includes(old.oid))expect(bodiesAfter.find(next=>next.oid===old.oid)).toEqual(old);
    console.info(JSON.stringify({w4b2Migration:{oldMigrations:23,unchangedMetadata:metadataBefore.length,exactReplacements:replaceSignatures,rolesPreserved:true,originalAppliedHashesPreserved:true}}));
  }finally{try{await db?.close();await root.end();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
},120000);


/*
기존 tests/postgres/windows-stage-cost-reader.test.ts 안에 통합할 초안이다.
아직 실행하지 않았다. SOURCE/consumer 분리의 실제 원자료와 projection 증거만 담당한다.
helper nativeOriginal의 마지막 선택 인자:
  scopeOptions?:{phase:'INPUT'|'CHECKPOINT';validationTargetDigest:string|null}
beginScopeIn 호출만
  scopeOptions?.phase??'INPUT',scopeOptions?.validationTargetDigest??null
로 바꾼다. 기존 호출과 본문 동작은 그대로다.
*/

async function separatedConsumerBasis(f:WindowsNativeFixture,input:import('../../packages/domain/src/provider.js').StageInput,components:FullStageCostSnapshot['components']=[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'fixture-separated-rate-v1',usdPerUnit:'0.01',evidenceRefs:['fixture:separated-unit']}]){
  const profileDigest=sha256('W4B2 separated original source basis');
  const snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:input.stage as FullStageCostSnapshot['stage'],profileDigest,basisVersion:'w4b2-separated-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['fixture:separated-basis'],components};
  const mode=(await f.admin.pool.query('SELECT mode FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,input.requestId])).rows[0].mode;
  const calculation=new FullStageCostCalculator(snapshot,calculatorBounds).calculate({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:snapshot.stage,profileDigest,mode},{provider:null,quantities:null,allocation:null});
  const value={version:1,accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:calculation.snapshot,snapshotDigest:calculation.snapshotDigest}},ref={evidenceId:randomUUID(),evidenceDigest:digest(value)};
  await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,ref.evidenceId,input.executionId,ref.evidenceDigest,tx.now,JSON.stringify(value)]),true);
  return {...ref,value};
}
async function prepareSeparatedCheckpointConsumer(f:WindowsNativeFixture){
  const source=await f.checkpointRetry(),sourceBasis=await f.seedBasis(source.input);
  const sourceBefore=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[f.seed.accountId,source.input.executionId])).rows;
  expect(await f.service.validateCheckpoints(source.claim)).toBe(true);
  const transaction=f.worker.transaction.bind(f.worker);let enrolled:unknown=null;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{
    const answer=await run(client),rows=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[f.seed.accountId])).rows;
    if(rows.length){expect(rows).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) AS value',[JSON.stringify({evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest})])).rows[0].value;}
    return answer;
  }));
  let input:import('../../packages/domain/src/provider.js').StageInput|null=null;
  try{input=await f.service.authorize(source.claim);}finally{spy.mockRestore();}
  expect(input).not.toBeNull();expect(enrolled).not.toBeNull();expect(input!.executionId).not.toBe(source.input.executionId);
  const basis=await separatedConsumerBasis(f,input!);
  await f.admin.pool.query("UPDATE manga_web.assets SET object_key=account_id::text||'/'||asset_id::text,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId]);
  const validation=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64});
  const attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.beginIn(tx,input!,'PRE_DISPATCH'),true);
  expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0]).toMatchObject({sourceExecutionId:source.input.executionId,basis:{evidenceId:sourceBasis.evidenceId,evidenceDigest:sourceBasis.evidenceDigest}});
  const attemptRef=(await f.admin.pool.query('SELECT evidence_id AS "evidenceId",evidence_digest AS "evidenceDigest" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'CHECKPOINT_VALIDATION_ATTEMPT\' AND protected_observation->\'value\'->>\'attemptId\'=$3',[f.seed.accountId,input!.executionId,attempt.attemptId])).rows[0] as Ref;
  const costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),owner:WindowsNativeCostOwner={executionId:input!.executionId,inputEvidenceId:attempt.inputEvidenceId,inputFingerprint:attempt.inputFingerprint,basisRef:{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest},claim:{generation:source.claim.generation,ownerId:f.service.workerId,workItemId:source.claim.workId},validationAttemptRef:attemptRef},components:WindowsNativeCostComponent[]=[{task:'DECODE_IMAGE',componentId:'native-image'}];
  const root=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components),true);expect(root).not.toBeNull();
  const original=await f.originalIntent(source,'REQUEST_CHECKPOINT',source.retryId),output=(await f.admin.pool.query('SELECT output_envelope FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,source.input.executionId])).rows[0].output_envelope;
  const target:Prepared['target']={accountId:f.seed.accountId,targetKind:'REQUEST_CHECKPOINT',targetId:source.retryId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',source.retryId,source.input,output),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:owner.claim,sourceInput:original.sourceInput};
  const prepared:Prepared={costs,execution:{claim:source.claim,input:input!},original,owner,root,components,capacity:await f.registerWindowsProfile(),target,source:Buffer.from(ownedNativePng,'base64')};
  return {x:prepared,source,sourceBasis,sourceBefore,attempt,validation};
}
it('W4-B2 separated source keeps original INPUT BASIS job claim and bridge while consumer projection has distinct refs',async()=>{
  let separated:Awaited<ReturnType<typeof prepareSeparatedCheckpointConsumer>>|undefined;
  await withPrepared(async(f,x)=>{
  const {source,sourceBasis,sourceBefore,attempt}=separated!;
  const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'20000000'},0,{phase:'CHECKPOINT',validationTargetDigest:digest(attempt.targets[0])});
  const facts=await originalFacts(f,x.owner,native.key),census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();
  expect(facts.source.input.executionId).toBe(source.input.executionId);expect(facts.source.input.executionId).not.toBe(x.owner.executionId);expect(facts.source.basisRef).toEqual({evidenceId:sourceBasis.evidenceId,evidenceDigest:sourceBasis.evidenceDigest});
  const scopeRef={evidenceId:native.scope.scopeId,evidenceDigest:native.scope.scopeDigest},callRef={evidenceId:native.call.callId,evidenceDigest:native.call.callDigest};
  const base={version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint};
  const operation={...base,kind:'WINDOWS_NATIVE_COST_ATTRIBUTION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceOperation:native.bridge.operation,sourceTermination:native.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,sourceOperationId:facts.binding.jobId,sourceEventId:facts.accounting!.event.eventId,accounting:facts.accounting,quantity:'3',unit:'windows-job-cpu-second-v1'}};
  const termination={...base,kind:'WINDOWS_NATIVE_COST_TERMINATION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceTermination:native.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,termination:facts.termination}};
  const key={version:1,kind:'NATIVE',originalKey:native.key,scopeRef,callRef,componentId:'native-image',rawSetDigest:census!.rawSetDigest};
  const before=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,execution_id,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[f.seed.accountId,source.input.executionId])).rows;expect(before).toHaveLength(2);
  const originalBinding=(await f.admin.pool.query('SELECT protected_binding FROM manga_web.native_controller_attempts WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,native.key.binding.jobId])).rows;
  const projected=await project<{operation:Ref;termination:Ref}>(f,x.owner,key,operation,termination);expect(projected).not.toBeNull();expect(await project(f,x.owner,key,operation,termination)).toEqual(projected);
  const ids=[projected!.operation.evidenceId,projected!.termination.evidenceId];expect(new Set(ids).size).toBe(2);expect(ids.every(id=>!before.some(row=>row.evidence_id===id))).toBe(true);
  expect((await f.admin.pool.query('SELECT evidence_id,execution_id,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=ANY($2::uuid[]) ORDER BY evidence_id',[f.seed.accountId,ids])).rows.every(row=>row.execution_id===x.owner.executionId&&row.protected_observation.executionId===x.owner.executionId&&row.protected_observation.value.source.input.executionId===source.input.executionId)).toBe(true);
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,execution_id,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[f.seed.accountId,source.input.executionId])).rows).toEqual(before);
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[f.seed.accountId,source.input.executionId])).rows).toEqual(sourceBefore);
  expect((await f.admin.pool.query('SELECT protected_binding FROM manga_web.native_controller_attempts WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,native.key.binding.jobId])).rows).toEqual(originalBinding);
  expect((await f.admin.pool.query('SELECT source_execution_id,source_input_evidence_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,native.key.binding.jobId])).rows).toEqual([{source_execution_id:source.input.executionId,source_input_evidence_id:x.target.sourceInput!.inputEvidenceId}]);
  expect(await project(f,x.owner,key,{...operation,value:{...operation.value,source:{...facts.source,input:{...facts.source.input,executionId:x.owner.executionId}}}},termination)).toBeNull();
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions WHERE job_id=$1',[native.key.binding.jobId])).rows).toEqual([{n:1}]);
  // 실제 v2 PRE 검증/전체 비용 완료는 B3 경계다. 이 검사는 원자료/소비자 projection을 증명한다.
},async f=>{separated=await prepareSeparatedCheckpointConsumer(f);return separated.x;});
},120000);

/*
추가 import: createWindowsCostedRemoteFixture (기존 Windows fixture 모듈)
선행 helper: parent-separated-consumer-draft.ts의 separatedConsumerBasis.
아직 문법 이외 검증/PG 실행 전인 초안이다.
원 producer의 CPU 비용 마감 완료를 주장하지 않는다.
현재 consumer의 CACHE-only CPU 0, 원 producer/job/claim 불변,
새 현재 GET 원자료와 B2 전체 비용 경로만 확인한다.
*/
async function prepareIndependentCacheConsumer(f:WindowsNativeFixture,costs:WindowsNativeCostJournal,basisComponents?:FullStageCostSnapshot['components']){
  const pageId=randomUUID(),assetId=randomUUID(),resultId=randomUUID(),bytes=Buffer.from(ownedNativePng,'base64'),key=f.seed.accountId+'/'+assetId;
  await f.files.put(key,bytes);
  // 새 가짜 페이지/원본 자산은 consumer INPUT보다 먼저 완전하게 구성한다.
  await f.admin.transaction(async client=>{
    await client.query('INSERT INTO manga_web.page_lineages(account_id,page_lineage_id,project_lineage_id) VALUES($1,$2,$3)',[f.seed.accountId,pageId,f.seed.projectId]);
    await client.query("INSERT INTO manga_web.workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,paid_baseline_credit,baseline_contribution_refs,revision,image_width,image_height) VALUES($1,$2,$3,$4,(SELECT COALESCE(max(display_order),-1)+1 FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2),false,false,0,0,'[]',0,1,1)",[f.seed.accountId,f.seed.contextId,f.seed.projectId,pageId]);
    await client.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,verified_at) VALUES($1,$2,'LIVE',$3,$4,$5,$6,'image/png','NOT_DUE',$7,clock_timestamp(),clock_timestamp())",[f.seed.accountId,assetId,f.files.bucket,key,sha256(bytes),String(bytes.length),f.seed.contextId]);
    await client.query("INSERT INTO manga_web.results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,0,$5,$2::uuid::text,'UPLOAD',$6)",[f.seed.accountId,resultId,f.seed.contextId,pageId,assetId,JSON.stringify({blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'})]);
    await client.query('UPDATE manga_web.workspace_pages SET current_result_id=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,pageId,resultId]);
  });
  await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_TRANSLATION',payload:{pageId,scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}));
  const transaction=f.worker.transaction.bind(f.worker);let enrolled:unknown=null;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{
    const answer=await run(client),rows=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[f.seed.accountId])).rows;
    if(rows.length){expect(rows).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) AS value',[JSON.stringify({evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest})])).rows[0].value;}
    return answer;
  }));
  let execution:Awaited<ReturnType<WindowsNativeFixture['prepareExecution']>>;
  try{execution=await f.prepareExecution();}finally{spy.mockRestore();}
  expect(enrolled).not.toBeNull();const original=await f.originalIntent(execution),basis=await separatedConsumerBasis(f,execution.input,basisComponents);
  const owner:WindowsNativeCostOwner={executionId:execution.input.executionId,inputEvidenceId:original.sourceInput.inputEvidenceId,inputFingerprint:digest(canonicalInput(execution.input)),basisRef:{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest},claim:{generation:execution.claim.generation,ownerId:f.service.workerId,workItemId:execution.claim.workId},validationAttemptRef:null},components:WindowsNativeCostComponent[]=[{task:'DECODE_IMAGE',componentId:'native-image'}];
  const root=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components),true);expect(root).not.toBeNull();
  const target:Prepared['target']={accountId:f.seed.accountId,targetKind:'EXECUTION',targetId:execution.input.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest('INPUT',execution.input.requestId,execution.input),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:owner.claim,sourceInput:original.sourceInput};
  return {execution,original,owner,root,components,target,source:bytes,costs};
}
it('W4-B2 actual CACHE-only consumer seals measured native zero and preserves original producer CPU identity',async()=>{
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let f:WindowsNativeFixture|undefined,producer:Awaited<ReturnType<typeof createWindowsCostedRemoteFixture>>|undefined;
  try{
    f=await windowsNativeFixture(20.5);producer=await createWindowsCostedRemoteFixture(f);
    expect(await producer.gateway.forCostOwner(producer.target,producer.owner,'INPUT',null).decodeImage(producer.source,syntheticProfile)).toMatchObject({width:1,height:1});
    const sourceState=async()=>(await f!.admin.pool.query("SELECT evidence_id,evidence_digest,execution_id,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS','WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[f!.seed.accountId,producer!.owner.executionId])).rows;
    const before=await sourceState();expect(before).toHaveLength(4);
    const bindingBefore=(await f.admin.pool.query('SELECT job_id,execution_id,call_id,protected_intent FROM manga_web.windows_native_cost_bindings WHERE account_id=$1',[f.seed.accountId])).rows;expect(bindingBefore).toHaveLength(1);
    const sourceJobId=bindingBefore[0].job_id;
    const originalOperation=before.find(row=>row.protected_observation.kind==='WINDOWS_NATIVE_OPERATION')!.protected_observation;
    expect(originalOperation.value.accounting).not.toBeNull();
    const queryCounts=async()=>(await f!.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) intents,(SELECT count(*)::integer FROM manga_web.windows_native_cost_bindings WHERE account_id=$1) bindings",[f!.seed.accountId])).rows[0];
    const countsBefore=await queryCounts(),ioBefore={...f.objectIo},goWire=producer.exchange.captures.filter(c=>c.control.command==='GO').length;
    expect(await f.service.renew(producer.execution.claim)).toBe(true);
    const consumer=await prepareIndependentCacheConsumer(f,producer.costs);
    expect(consumer.owner.executionId).not.toBe(producer.owner.executionId);
    expect(await producer.gateway.forCostOwner(consumer.target,consumer.owner,'INPUT',null).decodeImage(consumer.source,syntheticProfile)).toMatchObject({width:1,height:1});
    expect(await queryCounts()).toEqual(countsBefore);expect(producer.exchange.captures.filter(c=>c.control.command==='GO')).toHaveLength(goWire);
    expect(f.objectIo.put).toBe(ioBefore.put);expect(f.objectIo.get).toBeGreaterThan(ioBefore.get);
    expect((await f.admin.pool.query('SELECT job_id,execution_id,call_id,protected_intent FROM manga_web.windows_native_cost_bindings WHERE account_id=$1',[f.seed.accountId])).rows).toEqual(bindingBefore);
    expect(await sourceState()).toEqual(before);
    const uses=(await f.admin.pool.query('SELECT u.job_id,c.execution_id,u.protected_source FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=$1 AND c.execution_id=$2',[f.seed.accountId,consumer.owner.executionId])).rows;
    expect(uses).toHaveLength(1);expect(uses[0].job_id).toBe(sourceJobId);expect(uses[0].protected_source.origin).toBe('CACHE');
    const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(consumer.owner)});expect(census).not.toBeNull();
    expect(census!.originals).toEqual([expect.objectContaining({classification:'CACHE',key:expect.objectContaining({binding:expect.objectContaining({jobId:sourceJobId})})})]);
    expect(census!.rows.filter(row=>row.kind==='BINDING')).toHaveLength(0);expect(census!.rows.filter(row=>row.kind==='CACHE_USE')).toHaveLength(1);
    // capacity는 기존 실제 producer profile을 재사용하며 새로운 admission은 만들지 않는다.
    const x:Prepared={...consumer,capacity:producer.capacity},ready=await zeroWindowsWork(f,x),cost=windowsCost(f,ready.basis,ready.reader).cost;
    expect(await f.service.renew(x.execution.claim)).toBe(true);await cost.prepare(x.execution.input,x.owner.claim);await cost.finishAttempt(x.execution.input);await cost.idle();
    const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.000000000000');
    expect(view.calculations[0].result.facts.quantities).toEqual([expect.objectContaining({componentId:'native-image',quantity:'0',unit:'windows-job-cpu-second-v1'})]);
    const evidence=(await f.admin.pool.query("SELECT kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_ABSENCE')",[f.seed.accountId,x.owner.executionId])).rows;
    expect(evidence).toHaveLength(1);expect(evidence[0].kind).toBe('WINDOWS_NATIVE_COST_ABSENCE');
    expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_allocations WHERE account_id=$1 AND event_id=ANY($2::uuid[])',[f.seed.accountId,[sourceJobId,originalOperation.value.accounting.event.eventId]])).rows).toEqual([{n:0}]);
    expect(await sourceState()).toEqual(before);expect(await queryCounts()).toEqual(countsBefore);
  }catch(error){errors.push(error);}
  finally{
    try{await producer?.close();}catch(error){errors.push(error);}
    try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}
  }
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_CACHE_AND_CLEANUP_UNCONFIRMED');
},120000);
// 담당 PG 파일에만 통합할 실제 TYPESET/v1 FINAL fixture 초안. 아직 NOT_RUN.
// 추가 import: WorkspaceService; normalizeObservation; OwnedExecutionLimitProfile.
it('W4-B2 actual TYPESET v1 FINAL writer seals cost history after owner asset and context drift',async()=>{
  const guard=guardWindowsNativeIo(),errors:unknown[]=[],restoreFileSpies:(()=>void)[]=[];let f:WindowsNativeFixture|undefined;
  try{
    f=await windowsNativeFixture(20.5);const fixture=f;
    const fileReads=vi.spyOn(f.files,'read');restoreFileSpies.push(()=>fileReads.mockRestore());
    const filePuts=vi.spyOn(f.files,'put');restoreFileSpies.push(()=>filePuts.mockRestore());
    const now=(await f.admin.pool.query('SELECT clock_timestamp() now')).rows[0].now as Date;
    const profile:OwnedExecutionLimitProfile={kind:'OWNED_FIXTURE',version:'w4b2-final-typeset-v1',maxSlots:2,requestLimitUsd:'10',dailyLimitUsd:'100',fullBoundUsd:'10',stages:{TYPESET:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:w4b2/typeset']}},fullBoundEvidenceRefs:['owned-fixture:w4b2/final'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+23*3600000).toISOString()}},profileId=randomUUID();
    const registered=(await f.operator.client.query(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),profile.window!.kind,profile.window!.startAt,profile.window!.endAt])).rows[0];
    await f.operator.client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[profileId]);
    const policy={...f.requestPolicy,stageOrder:['TYPESET'],executionLimit:{kind:'OWNED_FIXTURE' as const,profileId,profileDigest:registered.profile_digest as string,profileVersion:profile.version},parameterProfileVersion:profile.version};
    const asset=(await f.admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1',[f.seed.accountId])).rows[0],bytes=Buffer.from(ownedNativePng,'base64'),key=f.seed.accountId+'/'+asset.asset_id;
    await f.files.put(key,bytes);
    await f.admin.pool.query("UPDATE manga_web.assets SET bucket_ref=$2,object_key=$3,sha256=$4,bytes_length=$5,media_type='image/png',object_created_at=clock_timestamp(),verified_at=clock_timestamp(),access_deadline=NULL WHERE account_id=$1 AND asset_id=$6",[f.seed.accountId,f.files.bucket,key,sha256(bytes),String(bytes.length),asset.asset_id]);
    await f.admin.pool.query("UPDATE manga_web.workspace_pages SET image_width=1,image_height=1 WHERE account_id=$1",[f.seed.accountId]);
    await f.admin.pool.query("UPDATE manga_web.results SET edit_data=jsonb_set(edit_data,'{renderSpecification}',$2::jsonb) WHERE account_id=$1",[f.seed.accountId,JSON.stringify({version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[]})]);
    const profileDigest=sha256('w4b2-actual-final-synthetic-rate'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'TYPESET',profileDigest,basisVersion:'w4b2-final-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:w4b2/final-snapshot'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'synthetic-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b2/final-native']},{componentId:'object-bytes',kind:'STORAGE',unit:'byte',rateVersion:'synthetic-v1',usdPerUnit:'0.000001',evidenceRefs:['owned-fixture:w4b2/final-storage']},{componentId:'semantic',kind:'RENDER',unit:'event',rateVersion:'synthetic-v1',usdPerUnit:'0.001',evidenceRefs:['owned-fixture:w4b2/final-semantic']}]};
    const windows=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:calculatorBounds}),preparation=new FullStageCostPreparation(journal,[{stage:'TYPESET',profileDigest,snapshot}],calculatorBounds),checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64});
    let nonWindows:OperationalStageCostWorkSet|null=null;
    const reader=new WindowsStageCostReader({db:f.worker,windows,nonWindows:{nonWindowsIn:async()=>structuredClone(nonWindows),checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds}}),cost=OperationalStageCost.windows({db:f.worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}}),workspace=new WorkspaceService(f.api,policy),service=new ExecutionService(f.worker,f.provider,policy,{},undefined,cost);
    await workspace.handle(f.actor,await f.command({kind:'REQUEST_TRANSLATION',payload:{pageId:f.seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}));
    const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');const transaction=f.worker.transaction.bind(f.worker);let inputRef:Ref|undefined;
    const enroll=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{const value=await run(client),rows=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[fixture.seed.accountId])).rows;if(rows.length){expect(rows).toHaveLength(1);inputRef={evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest};expect((await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) value',[JSON.stringify(inputRef)])).rows[0].value).not.toBeNull();}return value;}));
    let input:import('../../packages/domain/src/provider.js').StageInput|null;try{input=await service.authorize(claim!);}finally{enroll.mockRestore();}expect(input!).not.toBeNull();expect(inputRef).toBeDefined();
    const firstClaim={generation:claim!.generation,ownerId:service.workerId,workItemId:claim!.workId};await cost.prepare(input!,firstClaim);await cost.idle();const basis=(await journal.lookup(input!)).basis!;expect(basis.snapshot?.state).toBe('MEASURED');
    const original=await f.originalIntent({claim:claim!,input:input!});original.intent.claim=firstClaim;
    const basisRow=(await f.admin.pool.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_BASIS'",[f.seed.accountId,input!.executionId])).rows[0],owner:WindowsNativeCostOwner={executionId:input!.executionId,inputEvidenceId:inputRef!.evidenceId,inputFingerprint:digest(canonicalInput(input!)),basisRef:{evidenceId:basisRow.evidence_id,evidenceDigest:basisRow.evidence_digest},claim:firstClaim,validationAttemptRef:null},components:WindowsNativeCostComponent[]=[{task:'DECODE_IMAGE',componentId:'native-image'}];
    const root=await f.worker.accountTransaction(f.seed.accountId,tx=>windows.activateRootIn(tx,owner,components),true);expect(root).not.toBeNull();const capacity=await f.registerWindowsProfile(),target:Prepared['target']={accountId:f.seed.accountId,targetKind:'EXECUTION',targetId:input!.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest('INPUT',input!.requestId,input!),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:firstClaim,sourceInput:original.sourceInput},x:Prepared={costs:windows,execution:{claim:claim!,input:input!},original,owner,root,components,capacity,target,source:bytes};
    const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>windows.beginScopeIn(tx,owner,target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
    const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('w4b2-final-object-read'),componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>windows.registerCallIn(tx,scope!,call),true)).toEqual(call);
    const ioRequest:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ',key,expected:{sha256:sha256(bytes),bytesLength:String(bytes.length)}};
    const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:1048576,begin:r=>f!.worker.accountTransaction(fixture.seed.accountId,tx=>windows.beginIoIn(tx,r),true),end:event=>f!.worker.accountTransaction(fixture.seed.accountId,tx=>windows.endIoIn(tx,event),true),lookup:r=>f!.worker.accountTransaction(fixture.seed.accountId,tx=>windows.lookupIoIn(tx,r),true)});
    const read=await io.read(ioRequest);expect(read.state).toBe('RETURNED');if(read.state!=='RETURNED')throw new Error('W4B2_FINAL_READ_REQUIRED');expect(read.value).toEqual(bytes);expect(sha256(read.value)).toBe(ioRequest.expected!.sha256);expect(String(read.value.length)).toBe(ioRequest.expected!.bytesLength);
    expect(read.event.ended).not.toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>windows.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[read.event.ended!]}),true)).toBe('JOINED');
    expect(await service.preflight(claim!,input!)).toBe(true);await service.observe(f.seed.accountId,input!.executionId,normalizeObservation(input!,f.provider.success(input!)),false,claim!);
    expect((await f.admin.pool.query("SELECT e.state,(SELECT count(*)::integer FROM manga_web.checkpoints c WHERE c.account_id=e.account_id AND c.execution_id=e.execution_id) checkpoints,(SELECT count(*)::integer FROM manga_web.execution_evidence v WHERE v.account_id=e.account_id AND v.execution_id=e.execution_id AND v.kind='OUTCOME' AND v.protected_observation->>'outcome'='SUCCESS') outcomes FROM manga_web.executions e WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,input!.executionId])).rows).toEqual([{state:'SUCCEEDED',checkpoints:1,outcomes:1}]);
    expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures")).rows).toEqual([{seals:0,closures:0}]);
    const attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.beginIn(tx,input!,'FINAL_COMMIT'),true);expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0].assets).toEqual([expect.objectContaining({assetId:asset.asset_id,sha256:sha256(bytes),bytesLength:String(bytes.length),objectKey:key})]);
    const operation:CheckpointValidationOperation={version:1,operationId:randomUUID(),attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(attempt.targets[0]),sourceInputFingerprint:owner.inputFingerprint,outputDigest:attempt.targets[0].outputDigest,semantic:{eventId:randomUUID(),kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:[{eventId:read.event.eventId,kind:'OBJECT_READ',assetId:asset.asset_id,sha256:sha256(read.value),bytesLength:String(read.value.length),outcome:'RETURNED'}],native:[]},operationRef=await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',operation),verified=await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.recordIn(tx,input!,attempt,{attemptId:attempt.attemptId,operations:[operationRef]}),true);expect(verified.state).toBe('VERIFIED');expect(verified.jobIds).toEqual([]);
    const finalRefs=(await f.admin.pool.query('SELECT evidence_id AS "evidenceId",evidence_digest AS "evidenceDigest" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=ANY($3::uuid[]) ORDER BY evidence_id',[f.seed.accountId,input!.executionId,verified.evidenceIds])).rows as Ref[];
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.finalCommitIn(tx,input!),true)).toBe('ELIGIBLE');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.sealedFinalCostIn(tx,input!,finalRefs),true)).toBe('VERIFIED');
    expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.native_job_intents WHERE account_id=$1 AND target_kind='REQUEST_CHECKPOINT'",[f.seed.accountId])).rows).toEqual([{n:0}]);
    const provider={scope:'ACTUAL_AI_USD' as const,captureDigest:basis.captureDigest,state:'CONFIRMED' as const,actualUsd:'0.01'},allocation={captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:'FREE_OPERATIONS' as const,basisVersion:snapshot.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'},storage={componentId:'object-bytes',captureDigest:basis.captureDigest,state:'CONFIRMED' as const,quantity:String(bytes.length),unit:'byte'},semantic={componentId:'semantic',captureDigest:basis.captureDigest,state:'CONFIRMED' as const,quantity:'1',unit:'event'};
    const sources:OperationalStageCostWorkSet['sources']=[],ended:{operationId:string;eventId:string;outcome:'RETURNED'}[]=[];
    for(const item of [{target:'PROVIDER' as const,fact:provider,componentId:null,operationId:randomUUID(),eventId:randomUUID(),extra:[] as Ref[],io:null},{target:'ALLOCATION' as const,fact:allocation,componentId:null,operationId:randomUUID(),eventId:randomUUID(),extra:[] as Ref[],io:null},{target:'QUANTITY' as const,fact:storage,componentId:'object-bytes',operationId:read.event.operationId,eventId:read.event.eventId,extra:[] as Ref[],io:read.event},{target:'QUANTITY' as const,fact:semantic,componentId:'semantic',operationId:operation.operationId,eventId:operation.semantic.eventId,extra:finalRefs,io:null}]){
      const proof=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:item.operationId,eventId:item.eventId,fact:item.fact,...(item.io?{io:item.io}:{})});sources.push({sourceOperationId:item.operationId,sourceEventId:item.eventId,target:item.target,componentId:item.componentId,evidence:[proof,...item.extra]});ended.push({operationId:item.operationId,eventId:item.eventId,outcome:'RETURNED'});
    }
    const termination=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:ended}),outcomes=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME'",[f.seed.accountId,input!.executionId])).rows as Ref[],refs=(target:string,componentId:string|null)=>sources.filter(s=>s.target===target&&s.componentId===componentId).flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();
    nonWindows={version:1,executionId:input!.executionId,inputFingerprint:owner.inputFingerprint,captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(s=>s.evidence).sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),terminationEvidence:[termination,...outcomes].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER',null)},allocation:{...allocation,evidenceRefs:refs('ALLOCATION',null)},quantities:[{...storage,evidenceRefs:refs('QUANTITY','object-bytes')},{...semantic,evidenceRefs:refs('QUANTITY','semantic')}]}};
    expect(await service.renew(claim!)).toBe(true);const candidate=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,input!,basis),true);expect(candidate).not.toBeNull();
    const parserControl=structuredClone(nonWindows);parserControl.joinedEvidence=parserControl.joinedEvidence.filter(ref=>ref.evidenceId!==operationRef.evidenceId);for(const source of parserControl.sources)source.evidence=source.evidence.filter(ref=>ref.evidenceId!==operationRef.evidenceId);parserControl.facts.quantities!.find(q=>q.componentId==='semantic')!.evidenceRefs=parserControl.facts.quantities!.find(q=>q.componentId==='semantic')!.evidenceRefs.filter(id=>id!==operationRef.evidenceId);
    const gates=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_non_windows($1::jsonb,$3::jsonb) actual_final,manga_web.windows_stage_cost_non_windows($2::jsonb,$3::jsonb) parser_control,manga_web.windows_native_cost_owner_current($3::jsonb,$4::jsonb) owner_current',[JSON.stringify(nonWindows),JSON.stringify(parserControl),JSON.stringify(owner),JSON.stringify(target.protectedOwnerCapture)])).rows[0],true);
    console.info(JSON.stringify({w4b2ActualFinal:{purpose:attempt.purpose,verified:verified.state,nativeJobs:verified.jobIds.length,parserControlOnly:true,gates}}));
    await cost.finishAttempt(input!);await cost.idle();
    const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,input!),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.'+(11000n+BigInt(bytes.length)).toString().padStart(6,'0')+'000000');expect(view.calculations[0].result.facts.quantities!.find(q=>q.componentId==='native-image')?.quantity).toBe('0');await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,input!),true);
    const closure=(await f.admin.pool.query("SELECT protected_observation->'value' value FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,input!.executionId])).rows[0].value as {workSet:OperationalStageCostWorkSet};
    expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION') calculations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures,(SELECT count(*)::integer FROM manga_web.cost_items WHERE component='STAGE_TOTAL') totals,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses")).rows).toEqual([{seals:1,calculations:1,closures:1,totals:1,expenses:1}]);
    await f.admin.accountTransaction(f.seed.accountId,async tx=>{await tx.client.query("UPDATE processing_requests SET state='COMPLETED',terminal_at=$3,terminal_evidence_ref='W4B2_ACTUAL_FINAL',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[fixture.seed.accountId,input!.requestId,tx.now]);await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[fixture.seed.accountId,input!.contextId,tx.now]);await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$3 WHERE account_id=$1 AND asset_id=$2",[fixture.seed.accountId,asset.asset_id,new Date(tx.now.valueOf()-1000)]);});
    expect(fileReads.mock.calls.length).toBeGreaterThan(0);expect(filePuts.mock.calls.length).toBeGreaterThan(0);
    const fileCallsBefore={read:fileReads.mock.calls.length,put:filePuts.mock.calls.length};
    const saved=await costsSnapshot(f),ioBefore={...f.objectIo},counts=async()=>(await fixture.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries) queries,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections) projections,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION') calculations")).rows,before=await counts();
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.sealedFinalCostIn(tx,input!,closure.workSet.joinedEvidence),true)).toBe('VERIFIED');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.finalCommitIn(tx,input!),true)).toBe('WAIT');
    await cost.finishAttempt(input!);await cost.idle();expect((await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,input!),true)).costUsd).toBe(view.costUsd);expect(await costsSnapshot(f)).toEqual(saved);expect(f.objectIo).toEqual(ioBefore);expect(await counts()).toEqual(before);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.sealedFinalCostIn(tx,input!,closure.workSet.joinedEvidence.filter(ref=>ref.evidenceId!==operationRef.evidenceId)),true)).toBe('WAIT');const crossed=structuredClone(closure.workSet.joinedEvidence);crossed.find(ref=>ref.evidenceId===operationRef.evidenceId)!.evidenceDigest=sha256('crossed-actual-final-history');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.sealedFinalCostIn(tx,input!,crossed),true)).toBe('WAIT');
    expect(f.provider.calls).toEqual([]);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_intents')).rows).toEqual([{n:0}]);
    const fileCallsAfter={read:fileReads.mock.calls.length,put:filePuts.mock.calls.length};expect(fileCallsAfter).toEqual(fileCallsBefore);
    console.info(JSON.stringify({w4b2ActualFinalFileIo:{callThrough:true,normal:fileCallsBefore,afterHistory:fileCallsAfter,historyAdditionalRead:fileCallsAfter.read-fileCallsBefore.read,historyAdditionalPut:fileCallsAfter.put-fileCallsBefore.put}}));
  }catch(error){errors.push(error);}
  finally{try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{for(const restore of restoreFileSpies.reverse())try{restore();}catch(error){errors.push(error);}guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_ACTUAL_FINAL_AND_CLEANUP_FAILED');
},120000);
// Temp-only; parent PG owns the cluster. No semantic/PG validation yet.
// twoClientRace gains optional {left,right} role selection using the matching
// f.worker/f.controller connection, SET LOCAL ROLE, immediate error capture and
// observed pg_blocking_pids. It must retain actual failures and zero retries.
type B2RaceScope=Awaited<ReturnType<typeof nativeOriginal>>['scope'];
type B2RaceRole='trio_web_worker'|'trio_web_controller';
type B2RaceStatement={role:B2RaceRole;sql:string;values:unknown[]};
function b2RaceEnding(scope:B2RaceScope,terminalEvidence:Ref[]=[]){return {version:1 as const,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:'RETURNED' as const,terminalEvidence};}
async function b2RaceCall(f:WindowsNativeFixture,x:Prepared,scope:B2RaceScope,register=true){
  const sourceId='b2-race-'+randomUUID(),blobs=new Map([[sourceId,x.source]]),envelope=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId:sourceId},blobs,windowsFrameLimits);
  const body={version:1 as const,jobId:envelope.jobId,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,inputDigest:envelope.inputDigest,operationInputDigest:nativeOperationInputDigest(envelope),parentInstanceId:randomUUID(),targetKind:scope.target.targetKind,targetId:scope.target.targetId,semanticCaptureDigest:scope.target.semanticCaptureDigest,protectedOwnerCapture:scope.target.protectedOwnerCapture,claim:scope.target.claim},intent={...body,logicalOperationKey:nativeLogicalOperationKey(body)};
  const cb={version:1 as const,callId:randomUUID(),scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:intent.operationInputDigest,componentId:'native-image'},call={...cb,callDigest:digest(cb)};
  if(register)expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call),true)).toEqual(call);
  return {scope,call,intent,frame:{envelope,blobs}};
}
function b2RaceBinding(f:WindowsNativeFixture,p:Awaited<ReturnType<typeof b2RaceCall>>,reservationId:string):NativeControllerBinding{return {accountId:f.seed.accountId,capacityReservationId:reservationId,jobId:p.intent.jobId,parentInstanceId:p.intent.parentInstanceId,inputDigest:p.intent.inputDigest,profileDigest:p.intent.profileDigest,kernelDigest:f.profile.kernelDigest};}
async function b2RaceAdmit(f:WindowsNativeFixture,x:Prepared,p:Awaited<ReturnType<typeof b2RaceCall>>){
  const decision=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.admitIn(tx,p.scope,p.call,p.intent,{...x.capacity,sourceInput:p.scope.target.sourceInput!},'native-image'),true);expect(decision).toMatchObject({allowed:true,reason:'CREATED'});return {...p,binding:b2RaceBinding(f,p,decision.capacityReservationId!)};
}
async function b2RaceOpen(f:WindowsNativeFixture,x:Prepared,native:Awaited<ReturnType<typeof b2RaceAdmit>>,mode:'CREATED'|'NOT_ATTEMPTED'){
  f.memory??=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);const journal=new WindowsNativeJournal(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity:x.capacity,limits:windowsNativeLimits,signer:f.signer},f.memory);f.journals.push(journal);
  const ports=journal.portsFor(f.peer),prepared=await journal.offerOriginal(f.peer,native.binding,native.frame),capture=await ports.original.captureFresh(prepared),script=windowsNativeScript(prepared,mode);expect(capture.created).toBe(true);for(const entry of script.entries)await ports.journal.appendOriginal(capture.capture,entry.event,entry.source);return {journal,ports,prepared,capture:capture.capture,script,mode};
}
function b2RaceControllerIo(f:WindowsNativeFixture,native:Awaited<ReturnType<typeof b2RaceAdmit>>,readContext:unknown={purpose:'RUN_RECOVERY'}){
  const invoke=async(kind:'begin'|'end'|'lookup',value:unknown)=>(await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(value),JSON.stringify(readContext)])).event;
  return createWindowsCostedObjectIo({objects:f.files,maxBytes:windowsNativeLimits.maxOutputBytes,begin:v=>invoke('begin',v),end:v=>invoke('end',v),lookup:v=>invoke('lookup',v)});
}
async function b2RaceFinish(f:WindowsNativeFixture,x:Prepared,native:Awaited<ReturnType<typeof b2RaceAdmit>>,open:Awaited<ReturnType<typeof b2RaceOpen>>,goAlreadyGranted=false){
  let rawResult:NativeRawResultReference|null=null,raw:ReturnType<typeof createNativeResult>|null=null;const refs:{blobId:string;assetId:string;sha256:string;bytesLength:string}[]=[];
  if(open.mode==='CREATED'){
    if(!goAlreadyGranted)await open.journal.readyOriginal(open.capture,open.script.prepared);const grant=await open.ports.original.grantOriginal(open.capture),prefix=open.script.entries.length;expect(grant.created).toBe(!goAlreadyGranted);open.script.complete(grant.goGrantRef);for(const entry of open.script.entries.slice(prefix))await open.ports.journal.appendOriginal(open.capture,entry.event,entry.source);
    const bytes=Buffer.from(ownedNativePng,'base64');raw=createNativeResult(native.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs:new Map([['canonical-png',bytes]])},windowsFrameLimits);refs.push({blobId:'canonical-png',assetId:randomUUID(),sha256:sha256(bytes),bytesLength:String(bytes.length)});
    const allocated=await f.controllerDb.decision<{allowed:boolean;created:boolean;allocation:{reference:NativeRawResultReference}}>(f.seed.accountId,'SELECT manga_web.native_controller_allocate_raw($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) AS decision',[JSON.stringify(native.binding),open.capture.origin.authority.attemptId,f.controllerInstanceId,f.profile.controllerId,f.peer.serviceRole,randomUUID(),canonicalize(raw),JSON.stringify(refs),f.files.bucket]);expect(allocated.created).toBe(true);rawResult=allocated.allocation.reference;
    for(const ref of refs){const request=(kind:'OBJECT_PUT'|'OBJECT_READ'):WindowsCostedIoRequest=>({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:native.call.callId,callDigest:native.call.callDigest},kind,key:f.seed.accountId+'/'+ref.assetId,expected:{sha256:ref.sha256,bytesLength:ref.bytesLength}}),io=b2RaceControllerIo(f,native),put=await io.put(request('OBJECT_PUT'),bytes);expect(put.state).toBe('RETURNED');if(put.state!=='RETURNED')throw new Error('B2_RACE_PUT_REQUIRED');expect((await io.read(request('OBJECT_READ'))).state).toBe('RETURNED');expect(await f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,rawResult.rawResultId,ref.blobId,JSON.stringify(put.value),f.files.bucket])).toMatchObject({allowed:true});}
  }
  await open.journal.parentJoinedOriginal(open.capture,open.script.joinAck);const record=await open.ports.journal.sealOriginal(open.capture,open.script.seal()),finalized=open.script.finalized(record),expected=await open.journal.finishOriginal(open.capture,{outcome:open.script.outcome(record,rawResult),finalized,brokerJoin:{end:'EXPECTED',finalized}}),key={binding:native.binding,expected},bridge=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.recordIn(tx,key),true);expect(bridge.state).toBe('VERIFIED');return {key,bridge,open,rawResult,raw,refs};
}
async function b2RaceAddIoFacts(f:WindowsNativeFixture,x:Prepared,work:OperationalStageCostWorkSet){
  const rows=(await f.admin.pool.query<{protected_event:WindowsCostedIoEvent}>('SELECT en.protected_event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 ORDER BY st.operation_id',[f.seed.accountId,x.owner.executionId])).rows,operations:{operationId:string;eventId:string;outcome:'RETURNED'|'THREW'}[]=[];
  for(const {protected_event:io} of rows){if(work.sources.some(s=>s.sourceOperationId===io.operationId))continue;expect(io.state).not.toBe('UNCONFIRMED');const {evidenceRefs:_refs,...fact}=work.facts.provider!,proof=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:io.operationId,eventId:io.eventId,fact,io});work.sources.push({sourceOperationId:io.operationId,sourceEventId:io.eventId,target:'PROVIDER',componentId:null,evidence:[proof]});work.joinedEvidence.push(proof);operations.push({operationId:io.operationId,eventId:io.eventId,outcome:io.state as 'RETURNED'|'THREW'});}
  if(operations.length)work.terminationEvidence.push(await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations}));work.facts.provider!.evidenceRefs=work.sources.filter(s=>s.target==='PROVIDER').flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();work.joinedEvidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);work.terminationEvidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
}
async function b2RaceCounts(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT
 (SELECT count(*)::integer FROM manga_web.windows_native_cost_calls) calls,(SELECT count(*)::integer FROM manga_web.native_job_intents) intents,(SELECT count(*)::integer FROM manga_web.native_capacity_reservations) reservations,(SELECT count(*)::integer FROM manga_web.windows_native_cost_bindings) bindings,
 (SELECT count(*)::integer FROM manga_web.native_controller_go_grants) grants,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) consumptions,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends) ends,
 (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries) queries,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_claims) claims,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_acks) acks,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations`)).rows[0];}
async function b2RaceQueryAck(f:WindowsNativeFixture,x:Prepared,native:Awaited<ReturnType<typeof b2RaceAdmit>>,finished:Awaited<ReturnType<typeof b2RaceFinish>>,request:{control:{version:2;requestId:string;binding:NativeControllerBinding;command:'QUERY';includeRawResult:true}}){
  const context={purpose:'PARENT_QUERY',requestId:request.control.requestId,requestDigest:digest(request.control),deliveryClaimId:randomUUID(),authenticatedPeerId:f.peer.peerId},claim=(await f.controllerDb.decision<{allowed:boolean;value:unknown}>(f.seed.accountId,"SELECT jsonb_build_object('allowed',true,'value',manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb)) AS decision",[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(context)])).value;expect(claim).not.toBeNull();
  expect(await f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.windows_native_cost_raw_lookup($1::jsonb,$2,$3,$4,$5::jsonb) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,f.files.bucket,JSON.stringify(context)])).toMatchObject({allowed:true,available:true});
  const ref=finished.refs[0],io=b2RaceControllerIo(f,native,context),read=await io.read({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:native.call.callId,callDigest:native.call.callDigest},kind:'OBJECT_READ',key:f.seed.accountId+'/'+ref.assetId,expected:{sha256:ref.sha256,bytesLength:ref.bytesLength}});expect(read.state).toBe('RETURNED');
  const loaded=await f.controllerDb.decision<{allowed:boolean;attempt:{snapshot:Record<string,unknown>}}>(f.seed.accountId,'SELECT manga_web.native_controller_load($1::jsonb,$2,$3) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole]),{isolation:_isolation,...snapshot}=loaded.attempt.snapshot,response={requestId:request.control.requestId,responseDigest:digest({control:{version:2,requestId:request.control.requestId,command:'QUERY',binding:native.binding,snapshot},rawResult:finished.raw})};
  const ack=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.finishResultQueryIn(tx,native.call,request,response),true);expect(ack).not.toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.finishResultQueryIn(tx,native.call,request,response),true)).toEqual(ack);return ack!;
}

it.each(['CALL','ADMISSION','FIRST_GO','START','QUERY'] as const)('W4-B2 actual barrier work-first %s succeeds at its own phase then full seal waits and final closure remains possible',async kind=>withPrepared(async(f,x)=>{
  const {basis,reader,work}=await zeroWindowsWork(f,x),old=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(old).not.toBeNull();const oldCandidate=await sqlCandidate(f,x,old!,work);
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const p=await b2RaceCall(f,x,scope!,kind!=='CALL');let native:Awaited<ReturnType<typeof b2RaceAdmit>>|undefined,open:Awaited<ReturnType<typeof b2RaceOpen>>|undefined,finished:Awaited<ReturnType<typeof b2RaceFinish>>|undefined;
  if(kind==='FIRST_GO'||kind==='QUERY'){native=await b2RaceAdmit(f,x,p);open=await b2RaceOpen(f,x,native,'CREATED');if(kind==='FIRST_GO')await open.journal.readyOriginal(open.capture,open.script.prepared);else finished=await b2RaceFinish(f,x,native,open);}
  const request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:p.call.callId,callDigest:p.call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null},query={control:{version:2 as const,requestId:randomUUID(),binding:native?.binding??b2RaceBinding(f,p,randomUUID()),command:'QUERY' as const,includeRawResult:true as const}};
  let action:B2RaceStatement;
  if(kind==='CALL')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_register_call($1,$2::jsonb) value',values:[scope!.scopeId,JSON.stringify(p.call)]};
  else if(kind==='ADMISSION')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_admit($1,$2::jsonb,$3::jsonb,$4) value',values:[p.call.callId,JSON.stringify(p.intent),JSON.stringify({...x.capacity,sourceInput:scope!.target.sourceInput!}),'native-image']};
  else if(kind==='FIRST_GO')action={role:'trio_web_controller',sql:'SELECT manga_web.windows_native_grant_go($1::jsonb) value',values:[JSON.stringify({binding:native!.binding,attemptId:open!.capture.origin.authority.attemptId,controllerInstanceId:f.controllerInstanceId,controllerId:f.profile.controllerId,ownerService:f.peer.serviceRole,peerId:f.peer.peerId})]};
  else if(kind==='START')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_io_begin($1::jsonb) value',values:[JSON.stringify(request)]};
  else action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_authorize_result_query($1,$2::jsonb) value',values:[p.call.callId,JSON.stringify(query)]};
  const before=await b2RaceCounts(f),result=await twoClientRace(f,action.sql,action.values,'SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(oldCandidate)],{left:action.role,right:'trio_web_worker'});expect(result.second).toBeNull();const after=await b2RaceCounts(f);
  if(kind==='CALL'){expect(result.first).toEqual(p.call);expect(after.calls-before.calls).toBe(1);}
  else if(kind==='ADMISSION'){expect(result.first).toMatchObject({allowed:true,reason:'CREATED'});for(const key of ['intents','bindings','reservations'])expect(after[key]-before[key]).toBe(1);expect(after.grants).toBe(0);native={...p,binding:b2RaceBinding(f,p,result.first.capacityReservationId)};}
  else if(kind==='FIRST_GO'){expect(result.first).toMatchObject({allowed:true,created:true});expect(before.grants).toBe(0);expect(before.consumptions).toBe(0);expect(after.grants).toBe(1);expect(after.consumptions).toBe(1);}
  else if(kind==='START'){expect(result.first).toMatchObject({state:'UNCONFIRMED',operationId:request.operationId,eventId:request.eventId});expect(after.starts-before.starts).toBe(1);expect(after.ends-before.ends).toBe(0);}
  else {expect(result.first).not.toBeNull();expect(after.queries-before.queries).toBe(1);expect(after.claims).toBe(0);expect(after.acks).toBe(0);}
  expect(after.seals).toBe(0);expect(after.allocations).toBe(0);
  if(kind==='ADMISSION'){open=await b2RaceOpen(f,x,native!,'NOT_ATTEMPTED');finished=await b2RaceFinish(f,x,native!,open);}
  if(kind==='FIRST_GO')finished=await b2RaceFinish(f,x,native!,open!,true);
  if(kind==='START'){const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)});expect((await io.receipt(request)).state).toBe('RETURNED');}
  if(kind==='QUERY')await b2RaceQueryAck(f,x,native!,finished!,query);
  await b2RaceAddIoFacts(f,x,work);const ended=(await f.admin.pool.query('SELECT en.evidence_id AS "evidenceId",en.evidence_digest AS "evidenceDigest" FROM manga_web.windows_native_cost_io_ends en JOIN manga_web.windows_native_cost_io_starts st USING(account_id,operation_id) WHERE st.account_id=$1 AND st.call_id=$2 ORDER BY en.evidence_id',[f.seed.accountId,p.call.callId])).rows as Ref[],terminal=[...(finished?[finished.bridge.operation!,finished.bridge.termination!]:[]),...ended];expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!,terminal)),true)).toBe('JOINED');
  if(finished){const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name),proof=await operator.confirmWindows(finished.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,finished.key.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});}
  expect(await f.service.renew(x.execution.claim)).toBe(true);const fresh=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(fresh).not.toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,basis,fresh!),true)).not.toBeNull();
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});console.info(JSON.stringify({w4b2StageRace:{kind,order:'work-first',role:action.role,phaseBefore:before,phaseAfter:after,oldSeal:null,freshSeal:true,terminalRefs:terminal,rawRefs:raw!.rows.filter(row=>['CALL','BINDING','GO_GRANT','GO_CONSUMPTION','IO_START','IO_END','RESULT_QUERY','RESULT_CLAIM','RESULT_ACK'].includes(row.kind)).map(row=>({kind:row.kind,id:row.id,ref:row.ref}))}}));
}),120000);

// Seal-first uses an actually complete signed original and joined scope. The
// same job cannot simultaneously be ready for a first GO and fully sealable.
// These rows explicitly retain prior JOIN/TERM rejection as an additional cause.
it.each(['CALL','ADMISSION','FIRST_GO','START','QUERY'] as const)('W4-B2 actual barrier seal-first %s adds no new work and records prior JOIN TERM fences separately',async kind=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const native=await nativeOriginal(f,x,kind==='FIRST_GO'?'NOT_ATTEMPTED':'CREATED'),ready=await zeroWindowsWork(f,x),work=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.candidateIn(tx,x.execution.input,ready.basis),true);expect(work).not.toBeNull();const candidate=await sqlCandidate(f,x,work!,ready.work),p=await b2RaceCall(f,x,native.scope,false),query={control:{version:2,requestId:randomUUID(),binding:native.key.binding,command:'QUERY',includeRawResult:true}};
  const request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:native.call.callId,callDigest:native.call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null};let action:B2RaceStatement;
  if(kind==='CALL')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_register_call($1,$2::jsonb) value',values:[native.scope.scopeId,JSON.stringify(p.call)]};
  else if(kind==='ADMISSION')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_admit($1,$2::jsonb,$3::jsonb,$4) value',values:[native.call.callId,JSON.stringify(p.intent),JSON.stringify({...x.capacity,sourceInput:x.target.sourceInput!}),'native-image']};
  else if(kind==='FIRST_GO')action={role:'trio_web_controller',sql:'SELECT manga_web.windows_native_grant_go($1::jsonb) value',values:[JSON.stringify({binding:native.key.binding,attemptId:native.capture.origin.authority.attemptId,controllerInstanceId:f.controllerInstanceId,controllerId:f.profile.controllerId,ownerService:f.peer.serviceRole,peerId:f.peer.peerId})]};
  else if(kind==='START')action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_io_begin($1::jsonb) value',values:[JSON.stringify(request)]};
  else action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_authorize_result_query($1,$2::jsonb) value',values:[native.call.callId,JSON.stringify(query)]};
  const before=await b2RaceCounts(f),result=await twoClientRace(f,'SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)],action.sql,action.values,{left:'trio_web_worker',right:action.role});expect(result.first).not.toBeNull();if(kind==='FIRST_GO'||kind==='ADMISSION')expect(result.second.allowed).toBe(false);else expect(result.second).toBeNull();const after=await b2RaceCounts(f);
  for(const key of ['calls','intents','reservations','bindings','grants','consumptions','starts','ends','queries','claims','acks'])expect(after[key]).toBe(before[key]);expect(after.seals).toBe(1);
  if(kind!=='FIRST_GO'){const replay=await native.ports.original.grantOriginal(native.capture);expect(replay.created).toBe(false);expect((await b2RaceCounts(f)).consumptions).toBe(after.consumptions);}
  console.info(JSON.stringify({w4b2StageRace:{kind,order:'seal-first',role:action.role,priorJoined:true,priorNativeTerm:true,normalFirstGoPossibleAtSeal:false,isolatedSealEffect:false,phaseBefore:before,phaseAfter:after,newEffects:0}}));
}),120000);

it('W4-B2 legacy intent windows remain SCOPE_REQUIRED before and after seal without inventing an intent creation race',async()=>withPrepared(async(f,x)=>{
  const {basis,reader}=await zeroWindowsWork(f,x),work=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.candidateIn(tx,x.execution.input,basis),true);expect(work).not.toBeNull();
  const {logicalOperationKey:_key,...original}=x.original.intent,body={...original,semanticCaptureDigest:x.target.semanticCaptureDigest},intent={...body,logicalOperationKey:nativeLogicalOperationKey(body)},capacity={...x.capacity,sourceInput:x.target.sourceInput!};
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)}),decisions:unknown[]=[];
  for(const phase of ['before','after'] as const){
    if(phase==='after')expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,basis,work!),true)).not.toBeNull();
    for(const query of ["SELECT manga_web.native_job_create_intent($1::jsonb) value","SELECT manga_web.native_receipt_create_intent($1::jsonb) value","SELECT manga_web.native_capacity_create_intent($1::jsonb,false,$2::jsonb) value"]){
      const decision=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query(query,query.includes('$2')?[JSON.stringify(intent),JSON.stringify(capacity)]:[JSON.stringify(intent)])).rows[0].value,true);expect(decision).toMatchObject({allowed:false,reason:'WINDOWS_NATIVE_COST_SCOPE_REQUIRED'});decisions.push({phase,query,decision});
    }
    const count=await b2RaceCounts(f);for(const key of ['intents','reservations','bindings','grants','consumptions'])expect(count[key]).toBe(0);expect((await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)}))!.rawSetDigest).toBe(raw!.rawSetDigest);
  }
  console.info(JSON.stringify({w4b2LegacyWindows:{decisions,rawChanged:false,newNativeRows:0,claim:'bypass denial only; atomic intent creation is proved by actual admission race'}}));
}),120000);

// TEMP ONLY: concatenate with the assigned PG test in a virtual compiler host.
// No PG execution, repo integration, or acceptance result is implied here.
// Uses the approved prepareCandidate(input,basis) action and the ORIGINAL service
// renew(claim). The reserved connection selects transport, never a new owner.
type B2SplitClient=Parameters<Parameters<Database['transaction']>[0]>[0];
type B2SplitCleanup=()=>void|Promise<void>;
type B2SplitObservation={sampled_at:string;pid:number;role:string;work_item_id:string;claim_generation:string;claim_owner:string|null;state:string;lease_until:string|null;lease_live:boolean|null;remaining_ms:number|null;execution_generation:string};
type B2SplitCommit={pid:number;attempts:number;renew:boolean;observation:B2SplitObservation|null};

function b2SplitDeferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function b2SplitFinally(run:()=>Promise<void>,cleanup:B2SplitCleanup[]){const errors:unknown[]=[];try{await run();}catch(error){errors.push(error);}finally{for(const close of cleanup.reverse())try{await close();}catch(error){errors.push(error);}}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_SPLIT_AND_CLEANUP_FAILED');}
async function b2SplitAwait<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('W4B2_SPLIT_BARRIER_TIMEOUT')),10000);})]);}finally{if(timer)clearTimeout(timer);}}

async function b2SplitObserve(client:B2SplitClient,f:WindowsNativeFixture,x:Prepared):Promise<B2SplitObservation|null>{
  return (await client.query<B2SplitObservation>(`WITH sampled AS MATERIALIZED(SELECT clock_timestamp() value)
    SELECT sampled.value::text sampled_at,pg_backend_pid() pid,current_user::text role,w.work_item_id::text,w.claim_generation::text,w.claim_owner::text,w.state,w.lease_until::text,
      w.lease_until>sampled.value lease_live,floor(extract(epoch FROM(w.lease_until-sampled.value))*1000)::integer remaining_ms,e.claim_generation::text execution_generation
    FROM sampled,manga_web.work_items w JOIN manga_web.executions e ON e.account_id=w.account_id AND e.execution_id=$3
    WHERE w.account_id=$1 AND w.work_item_id=$2`,[f.seed.accountId,x.execution.claim.workId,x.owner.executionId])).rows[0]??null;
}

async function b2SplitTransport(f:WindowsNativeFixture,x:Prepared,options:{profile?:boolean;afterCommit?:(event:B2SplitCommit)=>Promise<void>}={}){
  const reserved=await f.worker.pool.connect(),base=f.worker.transaction.bind(f.worker);
  const renewPid=(await reserved.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
  const records:(B2SplitCommit&{committed:boolean})[]=[];let routeRenew=false,renewBusy=false,closed=false;
  let restore:(()=>void)|undefined;
  try{
    const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>{
      const renew=routeRenew;let last:(B2SplitCommit&{committed:boolean})|undefined,attempts=0;
      const invoke=async(client:B2SplitClient)=>{
        attempts++;const pid=(await client.query('SELECT pg_backend_pid() pid,current_user::text role')).rows[0];expect(pid.role).toBe('trio_web_worker');expect(pid.pid===renewPid).toBe(renew);
        if(options.profile&&!renew)await client.query('SELECT manga_web.w4b2_test_profile()');
        const value=await run(client),observation=await b2SplitObserve(client,f,x);last={pid:pid.pid,attempts,renew,observation,committed:false};records.push(last);
        if(options.profile&&!renew){const counts=(await client.query('SELECT funcname,calls::integer,total_time,self_time FROM pg_stat_xact_user_functions WHERE calls>0 ORDER BY total_time DESC,funcname')).rows;console.info(JSON.stringify({w4b2SplitFunctions:{pid:pid.pid,attempt:attempts,observation,counts}}));}
        return value;
      };
      let value;
      if(renew){
        await reserved.query('BEGIN');
        try{await reserved.query("SET LOCAL ROLE trio_web_worker;SET LOCAL search_path TO pg_catalog,manga_web,pg_temp;SET LOCAL timezone TO 'UTC'");value=await invoke(reserved);await reserved.query('COMMIT');}
        catch(error){await reserved.query('ROLLBACK').catch(()=>undefined);throw error;}
      }else value=await base(invoke);
      if(!last)throw new Error('W4B2_SPLIT_MISSING_COMMIT_OBSERVATION');last.committed=true;
      if(!renew)await options.afterCommit?.(last);return value;
    });restore=()=>spy.mockRestore();
  }catch(error){reserved.release();throw error;}
  return {renewPid,records,async renew(phase:string){
    if(renewBusy)throw new Error('W4B2_SPLIT_OVERLAPPING_RENEW');renewBusy=true;
    try{
      let pending:Promise<boolean>;routeRenew=true;try{pending=f.service.renew(x.execution.claim);}finally{routeRenew=false;}
      const success=await pending,record=records.filter(row=>row.renew&&row.committed).at(-1);expect(record).toBeDefined();const observed=record!.observation;expect(observed).not.toBeNull();
      console.info(JSON.stringify({w4b2SplitRenew:{phase,success,originalClaim:x.execution.claim,originalOwnerClaim:x.owner.claim,...observed}}));
      if(success){expect(observed!.pid).toBe(renewPid);expect(observed!.role).toBe('trio_web_worker');expect(observed!.work_item_id).toBe(x.execution.claim.workId);expect(observed!.claim_generation).toBe(x.execution.claim.generation);expect(observed!.execution_generation).toBe(x.execution.claim.generation);expect(observed!.claim_owner).toBe(f.service.workerId);expect(observed!.state).toBe('CLAIMED');expect(observed!.lease_live).toBe(true);expect(observed!.remaining_ms).toBeGreaterThan(0);expect(observed!.remaining_ms).toBeLessThanOrEqual(30000);}
      return {success,observed:observed!};
    }finally{renewBusy=false;}
  },close(){if(closed)return;closed=true;try{restore?.();}finally{reserved.release();}}};
}

function b2SplitReader(f:WindowsNativeFixture,x:Prepared,work:OperationalStageCostWorkSet,maxActionBytes:number=windowsStageCostBounds.maxActionBytes){return new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows:{nonWindowsIn:async()=>structuredClone(work),checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds,maxActionBytes}});}
async function b2SplitCounts(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT
  (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,
  (SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations,
  (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION') calculations,
  (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures,
  (SELECT count(*)::integer FROM manga_web.cost_items WHERE component='STAGE_TOTAL') totals,
  (SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses`)).rows[0] as Record<string,number>;}
async function b2SplitProjectionRows(f:WindowsNativeFixture){return (await f.admin.pool.query('SELECT operation_id,operation_digest,termination_id,termination_digest,created_at FROM manga_web.windows_stage_cost_projections ORDER BY operation_id,created_at')).rows;}
async function b2SplitOrigins(f:WindowsNativeFixture){return {evidence:(await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY evidence_id")).rows,roots:(await f.admin.pool.query('SELECT to_jsonb(r) body FROM manga_web.windows_native_cost_roots r')).rows};}
async function b2SplitOriginals(f:WindowsNativeFixture,x:Prepared,count=2){
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name);
  for(let index=0;index<count;index++){expect(await f.service.renew(x.execution.claim)).toBe(true);const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'20000000'}),proof=await operator.confirmWindows(native.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,native.key.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});}
  return zeroWindowsWork(f,x,{providerUsd:'0.02'});
}
async function b2SplitPausedCandidate(f:WindowsNativeFixture,x:Prepared,basis:FullStageCostBasis,work:OperationalStageCostWorkSet,cleanup:B2SplitCleanup[]){
  const reached=b2SplitDeferred<B2SplitCommit>(),resume=b2SplitDeferred<void>();reached.promise.catch(()=>undefined);let projected=false,paused=false,consumed=false;
  const transport=await b2SplitTransport(f,x,{afterCommit:async event=>{if(projected&&!paused){projected=false;paused=true;reached.resolve(event);await resume.promise;}}});cleanup.push(()=>transport.close());
  const project=x.costs.stageProjectIn.bind(x.costs),spy=vi.spyOn(x.costs,'stageProjectIn').mockImplementation(async(...args)=>{const value=await project(...args);if(value!==null)projected=true;return value;});cleanup.push(()=>spy.mockRestore());
  const reader=b2SplitReader(f,x,work),pending=reader.prepareCandidate(x.execution.input,basis);
  pending.then(value=>{if(!paused)reached.reject(new Error('W4B2_SPLIT_NO_COMMITTED_PROJECTION:'+String(value)));},error=>reached.reject(error));
  cleanup.push(async()=>{resume.resolve();if(!consumed)await pending;});
  const committed=await b2SplitAwait(reached.promise);expect(committed.renew).toBe(false);expect(committed.pid).not.toBe(transport.renewPid);expect(committed.observation?.lease_live).toBe(true);
  return {reader,transport,committed,resume:()=>resume.resolve(),async result(){try{return await pending;}finally{consumed=true;}}};
}

it('W4-B2 split action commits between jobs and renews only the original claim on a distinct client before private candidate sealing',async()=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    const origins=await b2SplitOrigins(f),paused=await b2SplitPausedCandidate(f,x,ready.basis,ready.work,cleanup),saved=await b2SplitProjectionRows(f);expect(saved).toHaveLength(1);expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);
    const renewal=await paused.transport.renew('between-first-and-second-original');expect(renewal.success).toBe(true);expect(renewal.observed.pid).not.toBe(paused.committed.pid);paused.resume();const candidate=await paused.result();expect(candidate).not.toBeNull();expect(candidate!.facts.quantities!.find(row=>row.componentId==='native-image')!.quantity).toBe('6');
    // Copies have no private candidate identity. Observe the real DB row count.
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>paused.reader.sealIn(tx,x.execution.input,ready.basis,structuredClone(candidate!)),true)).toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>paused.reader.sealIn(tx,x.execution.input,ready.basis,JSON.parse(JSON.stringify(candidate))),true)).toBeNull();expect((await b2SplitCounts(f)).seals).toBe(0);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>paused.reader.sealIn(tx,x.execution.input,ready.basis,candidate!),true)).not.toBeNull();expect(await b2SplitOrigins(f)).toEqual(origins);expect(await b2SplitProjectionRows(f)).toContainEqual(saved[0]);
    const action=vi.spyOn(paused.reader,'prepareCandidate');cleanup.push(()=>action.mockRestore());const {cost}=windowsCost(f,ready.basis,paused.reader);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.080000000000');expect(action).not.toHaveBeenCalled();const snapshot=await costsSnapshot(f);
    await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);await cost.finishAttempt(x.execution.input);await cost.idle();expect(action).not.toHaveBeenCalled();expect(await costsSnapshot(f)).toEqual(snapshot);
  },cleanup);
}),120000);

it.each(['claim-replaced','actual-expiry'] as const)('W4-B2 split action stops after %s without promoting original owner or charging partial projections',async mode=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    const origins=await b2SplitOrigins(f),paused=await b2SplitPausedCandidate(f,x,ready.basis,ready.work,cleanup),partial=await b2SplitProjectionRows(f);
    if(mode==='claim-replaced'){await f.service.finish(x.execution.claim,false);const replacement=new ExecutionService(f.worker,f.provider,f.requestPolicy),claim=await replacement.claim();expect(claim).not.toBeNull();expect(claim!.workId).toBe(x.execution.claim.workId);expect(BigInt(claim!.generation)).toBe(BigInt(x.execution.claim.generation)+1n);expect(replacement.workerId).not.toBe(x.owner.claim.ownerId);}
    else{const renewal=await paused.transport.renew('before-real-thirty-second-expiry');expect(renewal.success).toBe(true);const wait=Math.max(0,renewal.observed.remaining_ms??0)+50;expect(wait).toBeLessThanOrEqual(30050);await new Promise(resolve=>setTimeout(resolve,wait));}
    const renewal=await paused.transport.renew(mode);expect(renewal.success).toBe(false);if(mode==='actual-expiry')expect(renewal.observed.lease_live).toBe(false);paused.resume();expect(await paused.result()).toBeNull();expect(await b2SplitOrigins(f)).toEqual(origins);expect(await b2SplitProjectionRows(f)).toEqual(partial);expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);
    console.info(JSON.stringify({w4b2SplitLostClaim:{mode,renewal,partial,charged:false}}));
  },cleanup);
}),120000);

it('W4-B2 split action refuses a new genuine scope during preparation then fresh preparation reuses immutable original projection refs',async()=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    const paused=await b2SplitPausedCandidate(f,x,ready.basis,ready.work,cleanup),partial=await b2SplitProjectionRows(f),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();paused.resume();expect(await paused.result()).toBeNull();expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);expect(await b2SplitProjectionRows(f)).toEqual(partial);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!)),true)).toBe('JOINED');expect((await paused.transport.renew('after-new-scope-join')).success).toBe(true);const fresh=await paused.reader.prepareCandidate(x.execution.input,ready.basis);expect(fresh).not.toBeNull();expect(await b2SplitProjectionRows(f)).toContainEqual(partial[0]);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>paused.reader.sealIn(tx,x.execution.input,ready.basis,fresh!),true)).not.toBeNull();
  },cleanup);
}),120000);

it('W4-B2 split actual projection COMMIT then lost ACK preserves refs and no charge until successful retry',async()=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    let projected=false,lost=false;const transport=await b2SplitTransport(f,x,{afterCommit:async()=>{if(projected&&!lost){lost=true;throw new Error('W4B2_SPLIT_ACK_LOST_AFTER_COMMIT');}}});cleanup.push(()=>transport.close());const project=x.costs.stageProjectIn.bind(x.costs),spy=vi.spyOn(x.costs,'stageProjectIn').mockImplementation(async(...args)=>{const value=await project(...args);if(value!==null)projected=true;return value;});cleanup.push(()=>spy.mockRestore());
    const reader=b2SplitReader(f,x,ready.work);await expect(reader.prepareCandidate(x.execution.input,ready.basis)).rejects.toThrow('W4B2_SPLIT_ACK_LOST_AFTER_COMMIT');expect(lost).toBe(true);const partial=await b2SplitProjectionRows(f);expect(partial).toHaveLength(1);expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);expect((await transport.renew('retry-after-committed-projection-ack-loss')).success).toBe(true);
    const candidate=await reader.prepareCandidate(x.execution.input,ready.basis);expect(candidate).not.toBeNull();expect(await b2SplitProjectionRows(f)).toContainEqual(partial[0]);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,ready.basis,candidate!),true)).not.toBeNull();const {cost}=windowsCost(f,ready.basis,reader);await cost.finishAttempt(x.execution.input);await cost.idle();expect((await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true)).costUsd).toBe('0.080000000000');
  },cleanup);
}),120000);

it.each(['40001','40P01'] as const)('W4-B2 split actual %s at projection COMMIT retries the DB callback without double quantities sources or refs',async code=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    // The disposable test sequence is non-transactional, so exactly the first
    // deferred COMMIT fails. No product GUC, owner override or retry loop is added.
    await f.admin.pool.query(`CREATE SEQUENCE manga_web.w4b2_split_retry_sequence;
      CREATE FUNCTION manga_web.w4b2_split_retry_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN
        IF nextval('manga_web.w4b2_split_retry_sequence')=1 THEN RAISE EXCEPTION 'W4B2_TEST_COMMIT_RETRY' USING ERRCODE='${code}';END IF;RETURN NEW;END$$;
      REVOKE ALL ON FUNCTION manga_web.w4b2_split_retry_commit() FROM PUBLIC;
      CREATE CONSTRAINT TRIGGER w4b2_split_retry AFTER INSERT ON manga_web.windows_stage_cost_projections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION manga_web.w4b2_split_retry_commit();`);
    cleanup.push(async()=>{await f.admin.pool.query('DROP TRIGGER w4b2_split_retry ON manga_web.windows_stage_cost_projections;DROP FUNCTION manga_web.w4b2_split_retry_commit();DROP SEQUENCE manga_web.w4b2_split_retry_sequence;');});
    const transport=await b2SplitTransport(f,x);cleanup.push(()=>transport.close());const reader=b2SplitReader(f,x,ready.work),candidate=await reader.prepareCandidate(x.execution.input,ready.basis);expect(candidate).not.toBeNull();expect(candidate!.facts.quantities!.find(row=>row.componentId==='native-image')!.quantity).toBe('6');expect(candidate!.sources.filter(source=>source.target==='QUANTITY')).toHaveLength(2);expect(new Set(candidate!.joinedEvidence.map(ref=>ref.evidenceId)).size).toBe(candidate!.joinedEvidence.length);expect(await b2SplitProjectionRows(f)).toHaveLength(2);expect((await f.admin.pool.query('SELECT last_value::integer value FROM manga_web.w4b2_split_retry_sequence')).rows[0].value).toBe(3);expect(transport.records.some(row=>!row.renew&&row.committed&&row.attempts===2)).toBe(true);
    expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);expect((await transport.renew('after-original-db-commit-retry')).success).toBe(true);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,x.execution.input,ready.basis,candidate!),true)).not.toBeNull();console.info(JSON.stringify({w4b2SplitCommitRetry:{code,observedCallbackAttempts:transport.records.map(row=>({attempts:row.attempts,committed:row.committed,renew:row.renew})),quantity:'6',projectionRows:2}}));
  },cleanup);
}),120000);

it.each(['40001','40P01'] as const)('W4-B2 split actual %s at final seal COMMIT retains original candidate identity through the existing outer retry',async code=>withPrepared(async(f,x)=>{
  const ready=await b2SplitOriginals(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    await f.admin.pool.query(`CREATE SEQUENCE manga_web.w4b2_split_final_retry_sequence;
      CREATE FUNCTION manga_web.w4b2_split_final_retry_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN
        IF nextval('manga_web.w4b2_split_final_retry_sequence')=1 THEN RAISE EXCEPTION 'W4B2_TEST_FINAL_COMMIT_RETRY' USING ERRCODE='${code}';END IF;RETURN NEW;END$$;
      REVOKE ALL ON FUNCTION manga_web.w4b2_split_final_retry_commit() FROM PUBLIC;
      CREATE CONSTRAINT TRIGGER w4b2_split_final_retry AFTER INSERT ON manga_web.windows_stage_cost_seals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION manga_web.w4b2_split_final_retry_commit();`);
    cleanup.push(async()=>{await f.admin.pool.query('DROP TRIGGER w4b2_split_final_retry ON manga_web.windows_stage_cost_seals;DROP FUNCTION manga_web.w4b2_split_final_retry_commit();DROP SEQUENCE manga_web.w4b2_split_final_retry_sequence;');});
    const transport=await b2SplitTransport(f,x);cleanup.push(()=>transport.close());const reader=b2SplitReader(f,x,ready.work),prepare=vi.spyOn(reader,'prepareCandidate');cleanup.push(()=>prepare.mockRestore());
    const seal=reader.sealIn.bind(reader),objects:OperationalStageCostWorkSet[]=[],sealSpy=vi.spyOn(reader,'sealIn').mockImplementation(async(...args)=>{objects.push(args[3]);return seal(...args);});cleanup.push(()=>sealSpy.mockRestore());
    const {cost}=windowsCost(f,ready.basis,reader);await cost.finishAttempt(x.execution.input);await cost.idle();expect(prepare).toHaveBeenCalledTimes(1);expect(objects).toHaveLength(2);expect(objects[0]).toBe(objects[1]);expect(transport.records.some(row=>!row.renew&&row.committed&&row.attempts===2)).toBe(true);expect((await f.admin.pool.query('SELECT last_value::integer value FROM manga_web.w4b2_split_final_retry_sequence')).rows[0].value).toBe(2);
    const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.080000000000');const counts=await b2SplitCounts(f);expect(counts.seals).toBe(1);expect(counts.calculations).toBe(1);expect(counts.closures).toBe(1);expect(await b2SplitProjectionRows(f)).toHaveLength(2);
    console.info(JSON.stringify({w4b2SplitFinalCommitRetry:{code,originalCandidateIdentity:objects[0]===objects[1],prepareCalls:prepare.mock.calls.length,sealCalls:objects.length,counts}}));
  },cleanup);
}),120000);

it('W4-B2 split real postwrite verify byte cap rolls back SQL seal and allocations before committing WAIT',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x),cleanup:B2SplitCleanup[]=[];
  await b2SplitFinally(async()=>{
    await f.admin.pool.query(`CREATE FUNCTION manga_web.w4b2_split_observe_writes() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$SELECT jsonb_build_object('seals',(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=manga_web.current_account()),'allocations',(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations WHERE account_id=manga_web.current_account()))$$;REVOKE ALL ON FUNCTION manga_web.w4b2_split_observe_writes() FROM PUBLIC;GRANT EXECUTE ON FUNCTION manga_web.w4b2_split_observe_writes() TO trio_web_worker;`);
    cleanup.push(async()=>{await f.admin.pool.query('DROP FUNCTION manga_web.w4b2_split_observe_writes()');});
    type Trial={cap:number;candidate:boolean;sqlCalled:boolean;sqlReply:boolean;afterWrite:Record<string,number>|null;result:OperationalStageCostWorkSet|null};
    let current:Trial|undefined;const trials:Trial[]=[],seal=x.costs.stageSealIn.bind(x.costs),spy=vi.spyOn(x.costs,'stageSealIn').mockImplementation(async(...args)=>{
      const value=await seal(...args);if(!current)throw new Error('W4B2_SPLIT_CAP_MISSING_TRIAL');current.sqlCalled=true;current.sqlReply=value!==null;
      current.afterWrite=(await args[0].client.query('SELECT manga_web.w4b2_split_observe_writes() value')).rows[0].value;return value;
    });cleanup.push(()=>spy.mockRestore());
    const rollback=new Error('W4B2_SPLIT_CAP_CALIBRATION_ROLLBACK');
    const trial=async(cap:number,commit=false)=>{
      const state:Trial={cap,candidate:false,sqlCalled:false,sqlReply:false,afterWrite:null,result:null};current=state;const reader=b2SplitReader(f,x,ready.work,cap),candidate=await reader.prepareCandidate(x.execution.input,ready.basis);state.candidate=candidate!==null;
      if(candidate!==null){try{await f.worker.accountTransaction(f.seed.accountId,async tx=>{state.result=await reader.sealIn(tx,x.execution.input,ready.basis,candidate);if(!commit)throw rollback;},true);}catch(error){if(error!==rollback)throw error;}}
      trials.push(state);return state;
    };
    expect(await f.service.renew(x.execution.claim)).toBe(true);const full=await trial(windowsStageCostBounds.maxActionBytes);expect(full.sqlReply).toBe(true);expect(full.result).not.toBeNull();expect(full.afterWrite!.seals).toBe(1);expect(full.afterWrite!.allocations).toBeGreaterThan(0);expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);
    // Locate the first public cap that reaches the real SQL writer. Calibration
    // transactions always roll back, including positive controls, so the final
    // committed WAIT independently observes the reader savepoint's rollback.
    let low:number=1,high:number=windowsStageCostBounds.maxActionBytes;
    while(low<high){if(trials.length%4===0)expect(await f.service.renew(x.execution.claim)).toBe(true);const middle=Math.floor((low+high)/2),value=await trial(middle);if(value.sqlCalled)high=middle;else low=middle+1;expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);}
    expect(await f.service.renew(x.execution.claim)).toBe(true);const bounded=await trial(low,true);expect(bounded.candidate).toBe(true);expect(bounded.sqlCalled).toBe(true);expect(bounded.sqlReply).toBe(true);expect(bounded.afterWrite!.seals).toBe(1);expect(bounded.afterWrite!.allocations).toBeGreaterThan(0);expect(bounded.result).toBeNull();expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);
    console.info(JSON.stringify({w4b2SplitPostwriteCap:{cap:low,calibrationAttempts:trials.length,actualAfterSqlWrite:bounded.afterWrite,returned:null,afterCommit:await b2SplitCounts(f)}}));
  },cleanup);
}),120000);

// SQL-independent fact -> SOURCE coverage. No reader method is called.
// Missing source targets are omitted BEFORE original SOURCE/end creation.
type B2CoverageTarget='PROVIDER'|'ALLOCATION'|'QUANTITY';
type B2CoverageReady=Awaited<ReturnType<typeof zeroWindowsWork>>;
const b2CoverageCases=(['PROVIDER','ALLOCATION','QUANTITY'] as const).flatMap(target=>(['EMPTY','UNRELATED'] as const).map(refs=>({target,refs})));
function b2CoveragePrepare(f:WindowsNativeFixture,target:B2CoverageTarget){return prepareWithBasis(f,snapshot=>target==='QUANTITY'?{...snapshot,components:[...snapshot.components,{componentId:'storage-x',kind:'STORAGE' as const,unit:'fixture-storage-byte-v1',rateVersion:'fixture-storage-rate-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b2/storage-x']}]}:snapshot);}
async function b2CoverageQuantity(f:WindowsNativeFixture,x:Prepared,ready:B2CoverageReady,withSource:boolean){
  const quantity:NonNullable<OperationalStageCostWorkSet['facts']['quantities']>[number]={componentId:'storage-x',captureDigest:ready.basis.captureDigest,state:'CONFIRMED',quantity:'7',unit:'fixture-storage-byte-v1',evidenceRefs:[]};ready.work.facts.quantities=[quantity];
  if(withSource){
    const operationId=randomUUID(),eventId=randomUUID(),{evidenceRefs:_refs,...fact}=quantity,source=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact});
    quantity.evidenceRefs=[source.evidenceId];ready.work.sources.push({sourceOperationId:operationId,sourceEventId:eventId,target:'QUANTITY',componentId:'storage-x',evidence:[source]});ready.work.joinedEvidence.push(source);
    ready.work.terminationEvidence.push(await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId,eventId,outcome:'RETURNED'}]}));
  }
  return quantity;
}
async function b2CoverageSourceRows(f:WindowsNativeFixture,x:Prepared){return (await f.admin.pool.query<{evidence_id:string;fact:{scope?:string;funding?:string;componentId?:string}}>("SELECT evidence_id,protected_observation->'value'->'fact' fact FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE' ORDER BY evidence_id",[f.seed.accountId,x.owner.executionId])).rows;}
function b2CoverageMatches(fact:{scope?:string;funding?:string;componentId?:string},target:B2CoverageTarget){return target==='PROVIDER'?fact.scope==='ACTUAL_AI_USD':target==='ALLOCATION'?typeof fact.funding==='string':fact.componentId==='storage-x';}
async function b2CoverageGates(f:WindowsNativeFixture,x:Prepared,ready:B2CoverageReady,candidate:Awaited<ReturnType<typeof absenceCandidate>>){return f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_non_windows($1::jsonb,$2::jsonb) coverage,manga_web.windows_stage_cost_amount($3::jsonb,$4::jsonb) amount',[JSON.stringify(candidate.nonWindowsWorkSet),JSON.stringify(x.owner),JSON.stringify(ready.basis),JSON.stringify(candidate.workSet.facts)])).rows[0],true);}
async function b2CoverageSeal(f:WindowsNativeFixture,x:Pick<Prepared,'owner'>,candidate:Awaited<ReturnType<typeof absenceCandidate>>){return f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value,true);}

it.each(b2CoverageCases)('W4-B2 SQL fact-source missing $target SOURCE with $refs refs cannot seal facts-only usage',async({target,refs})=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02',omitSourceTargets:target==='QUANTITY'?[]:[target]});
  const fact=target==='QUANTITY'?await b2CoverageQuantity(f,x,ready,false):target==='PROVIDER'?ready.work.facts.provider!:ready.work.facts.allocation!;
  const sourceRows=await b2CoverageSourceRows(f,x);expect(sourceRows.filter(row=>b2CoverageMatches(row.fact,target))).toHaveLength(0);expect(sourceRows).toHaveLength(target==='QUANTITY'?2:1);
  expect(ready.work.sources.filter(source=>source.target===target&&(target!=='QUANTITY'||source.componentId==='storage-x'))).toHaveLength(0);
  if(refs==='UNRELATED'){const unrelated=ready.work.sources.find(source=>source.target!==target)!.evidence[0];expect(ready.work.joinedEvidence).toContainEqual(unrelated);fact.evidenceRefs=[unrelated.evidenceId];}else fact.evidenceRefs=[];
  const basisBefore=(await f.admin.pool.query('SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE evidence_id=$1',[x.owner.basisRef.evidenceId])).rows;
  if(target==='QUANTITY'){expect(ready.basis.snapshot!.components.find(row=>row.componentId==='storage-x')).toMatchObject({kind:'STORAGE',unit:'fixture-storage-byte-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b2/storage-x']});expect(x.components.some(row=>row.componentId==='storage-x')).toBe(false);}
  const candidate=await absenceCandidate(f,x,ready.basis,ready.work),raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();expect(candidate.rawSetDigest).toBe(raw!.rawSetDigest);expect(raw!.rawSetDigest).toBe(digest(manifest(raw!.rows)));expect(candidate.nonWindowsWorkSet.facts).toEqual(ready.work.facts);
  if(target==='QUANTITY'){expect(candidate.workSet.facts.quantities!.find(row=>row.componentId==='storage-x')!.quantity).toBe('7');expect(candidate.workSet.facts.quantities!.find(row=>row.componentId==='native-image')!.quantity).toBe('0');}
  const gates=await b2CoverageGates(f,x,ready,candidate),result=await b2CoverageSeal(f,x,candidate),counts=await b2SplitCounts(f);
  console.info(JSON.stringify({w4b2FactSource:{target,refs,declaredSources:ready.work.sources.length,originalSourceRows:sourceRows.length,matchingOriginalSources:0,rawSetDigest:raw!.rawSetDigest,rawRows:raw!.rows.length,amountGate:gates.amount,coverageGate:gates.coverage,sealed:result!==null,counts,readerMethodsCalled:0}}));
  // Execute public SQL before any assertion on the private diagnostic gate.
  expect(result).toBeNull();expect(counts).toEqual({seals:0,allocations:0,calculations:0,closures:0,totals:0,expenses:0});expect(gates.coverage).toBe(false);
  expect(await b2CoverageSourceRows(f,x)).toEqual(sourceRows);expect((await f.admin.pool.query('SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE evidence_id=$1',[x.owner.basisRef.evidenceId])).rows).toEqual(basisBefore);expect(f.provider.calls).toEqual([]);
},f=>b2CoveragePrepare(f,target)),120000);

it.each(['PROVIDER','ALLOCATION','QUANTITY'] as const)('W4-B2 SQL fact-source complete %s original source usage and end remain a public seal positive',async target=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'});if(target==='QUANTITY')await b2CoverageQuantity(f,x,ready,true);
  const sourceRows=await b2CoverageSourceRows(f,x);expect(sourceRows.filter(row=>b2CoverageMatches(row.fact,target))).toHaveLength(1);
  const candidate=await absenceCandidate(f,x,ready.basis,ready.work),gates=await b2CoverageGates(f,x,ready,candidate);expect(gates.coverage).toBe(true);expect(gates.amount.actualUsd).toBe(target==='QUANTITY'?'0.090000000000':'0.020000000000');
  const {captureDigest:_captureDigest,...capture}=ready.basis.capture,calculated=new FullStageCostCalculator(ready.basis.snapshot,calculatorBounds).calculate(capture,candidate.workSet.facts);expect(calculated.state).toBe('CONFIRMED');expect(calculated.actualUsd).toBe(target==='QUANTITY'?'0.090000000000':'0.020000000000');
  expect(await b2CoverageSeal(f,x,candidate)).not.toBeNull();const counts=await b2SplitCounts(f);expect(counts.seals).toBe(1);expect(counts.calculations).toBe(0);expect(counts.closures).toBe(0);expect(counts.totals).toBe(0);expect(counts.expenses).toBe(0);
  const expectedIds=candidate.workSet.sources.flatMap(source=>[source.sourceOperationId,source.sourceEventId]).sort(),actualIds=(await f.admin.pool.query<{event_id:string}>('SELECT event_id FROM manga_web.windows_stage_cost_allocations WHERE account_id=$1 ORDER BY event_id',[f.seed.accountId])).rows.map(row=>row.event_id);expect(actualIds).toEqual(expectedIds);
  console.info(JSON.stringify({w4b2FactSourceControl:{target,coverageGate:true,actualUsd:calculated.actualUsd,allocations:actualIds.length,declaredSources:ready.work.sources.length,sealed:true,readerMethodsCalled:0}}));expect(f.provider.calls).toEqual([]);
},f=>b2CoveragePrepare(f,target)),120000);

// Temp draft. Normal N-1/N use actual B1 public methods/fake object receipts.
// N+1 first checks the unchanged public admission bound, then admin inserts a
// well-shaped overflow row solely to test B2's independent full-census guard.
// No monetary/full-seal success is claimed from these open-scope cap fixtures.
async function b2CapRaw(f:WindowsNativeFixture,x:Prepared,kind:'SCOPE'|'CALL'|'IO_START',expected:number){
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();expect(raw!.rows.filter(row=>row.kind===kind)).toHaveLength(expected);expect(raw!.rawSetDigest).toBe(digest(manifest(raw!.rows)));expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(8388608);return raw!;
}
function b2CapCall(f:WindowsNativeFixture,scope:B2RaceScope,index:number){const body={version:1 as const,callId:randomUUID(),scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('b2-independent-cap-'+index),componentId:'native-image'};return {...body,callDigest:digest(body)};}
async function b2CapInsertCall(f:WindowsNativeFixture,x:Prepared,call:ReturnType<typeof b2CapCall>){await f.admin.pool.query('INSERT INTO manga_web.windows_native_cost_calls(account_id,execution_id,scope_id,call_id,call_digest,protected_call,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',[f.seed.accountId,x.owner.executionId,call.scopeId,call.callId,call.callDigest,JSON.stringify(call)]);}
async function b2CapInsertStart(f:WindowsNativeFixture,x:Prepared,request:WindowsCostedIoRequest){await f.admin.pool.query("INSERT INTO manga_web.windows_native_cost_io_starts(account_id,execution_id,call_id,operation_id,event_id,protected_request,principal,job_id,read_context,evidence_id,evidence_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,'trio_web_worker',NULL,NULL,$7,manga_web.windows_native_cost_hash(jsonb_build_object('version',1,'kind','WINDOWS_NATIVE_COST_IO_START','request',$6::jsonb,'principal','trio_web_worker','jobId',NULL,'context',NULL)),clock_timestamp())",[f.seed.accountId,x.owner.executionId,request.call.callId,request.operationId,request.eventId,JSON.stringify(request),randomUUID()]);}
it.each(['SCOPES','CALLS_PER_SCOPE','CALLS_OWNER','IO_PER_CALL','IO_OWNER'] as const)('W4-B2 independent actual %s minus equal plus one bound rejects the whole census without a prefix',async kind=>withPrepared(async(f,x)=>{
  const scope=async()=>{const value=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(value).not.toBeNull();return value!;};
  const call=async(s:B2RaceScope,index:number)=>{const value=b2CapCall(f,s,index);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,s,value),true)).toEqual(value);return value;};
  let acceptedMinus:Census,accepted:Census,normalLimit:number,field:'SCOPE'|'CALL'|'IO_START';
  if(kind==='SCOPES'){
    const scopes:B2RaceScope[]=[];for(let index=0;index<63;index++)scopes.push(await scope());acceptedMinus=await b2CapRaw(f,x,'SCOPE',63);scopes.push(await scope());accepted=await b2CapRaw(f,x,'SCOPE',64);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true)).toBeNull();const {scopeDigest:_old,...base}=scopes[0],body={...base,scopeId:randomUUID()},extra={...body,scopeDigest:digest(body)};
    await f.admin.pool.query('INSERT INTO manga_web.windows_native_cost_scopes(account_id,execution_id,scope_id,scope_digest,protected_scope,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',[f.seed.accountId,x.owner.executionId,extra.scopeId,extra.scopeDigest,JSON.stringify(extra)]);normalLimit=64;field='SCOPE';
  }else if(kind==='CALLS_PER_SCOPE'||kind==='CALLS_OWNER'){
    const scopes:B2RaceScope[]=[];for(let index=0;index<(kind==='CALLS_OWNER'?5:1);index++)scopes.push(await scope());normalLimit=kind==='CALLS_OWNER'?256:64;
    for(let index=0;index<normalLimit-1;index++){await call(scopes[Math.floor(index/64)],index);if(index%64===63)expect(await f.service.renew(x.execution.claim)).toBe(true);}acceptedMinus=await b2CapRaw(f,x,'CALL',normalLimit-1);await call(scopes[Math.floor((normalLimit-1)/64)],normalLimit-1);accepted=await b2CapRaw(f,x,'CALL',normalLimit);
    const extra=b2CapCall(f,scopes[kind==='CALLS_OWNER'?4:0],normalLimit);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scopes[kind==='CALLS_OWNER'?4:0],extra),true)).toBeNull();await b2CapInsertCall(f,x,extra);field='CALL';
  }else{
    const s=await scope(),calls:ReturnType<typeof b2CapCall>[]=[];for(let index=0;index<(kind==='IO_OWNER'?17:1);index++)calls.push(await call(s,index));normalLimit=kind==='IO_OWNER'?1024:64;
    let actualReceipts=0;const objects={bucket:f.files.bucket,put:f.files.put.bind(f.files),read:f.files.read.bind(f.files),remove:f.files.remove.bind(f.files),receipt:async(key:string)=>{actualReceipts++;return f.files.receipt(key);}},io=createWindowsCostedObjectIo({objects,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),request=(c:ReturnType<typeof b2CapCall>):WindowsCostedIoRequest=>({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:c.callId,callDigest:c.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null});
    for(let index=0;index<normalLimit-1;index++){if(index%64===0)expect(await f.service.renew(x.execution.claim)).toBe(true);expect((await io.receipt(request(calls[Math.floor(index/64)]))).state).toBe('RETURNED');}acceptedMinus=await b2CapRaw(f,x,'IO_START',normalLimit-1);expect((await io.receipt(request(calls[Math.floor((normalLimit-1)/64)]))).state).toBe('RETURNED');accepted=await b2CapRaw(f,x,'IO_START',normalLimit);expect(actualReceipts).toBe(normalLimit);
    expect(accepted.rows.filter(row=>row.kind==='IO_END')).toHaveLength(normalLimit);const extra=request(calls[kind==='IO_OWNER'?16:0]);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,extra),true)).toBeNull();expect(actualReceipts).toBe(normalLimit);await b2CapInsertStart(f,x,extra);field='IO_START';
  }
  expect(await lookup(f,{version:1,mode:'CENSUS',owner:selector(x.owner)})).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
  console.info(JSON.stringify({w4b2IndependentCap:{kind,field,normalMinus:normalLimit-1,normalEqual:normalLimit,adminInjectedOverflow:normalLimit+1,normalB1OverflowRejected:true,b2WholeOverflow:null,prefixReturned:false,moneyClaim:false,minusBytes:Buffer.byteLength(JSON.stringify(acceptedMinus)),equalBytes:Buffer.byteLength(JSON.stringify(accepted))}}));
}),180000);

function b2CapLeafBody(bytes:number){
  const kind='RAW_OBJECT',chunk=16384,rows:RawRow[]=Array.from({length:256},(_,index)=>({kind,id:String(index).padStart(3,'0')+':',ref:null,contentDigest:sha256('bounded-leaf-'+index),completedAt:null}));
  const missing=bytes-Buffer.byteLength(canonicalize({version:1,kind,chunk,rows})!),each=Math.floor(missing/rows.length),remainder=missing%rows.length;expect(missing).toBeGreaterThanOrEqual(0);
  for(let index=0;index<rows.length;index++)rows[index].id+='x'.repeat(each+(index<remainder?1:0));for(const row of rows)expect(Buffer.byteLength(row.id)).toBeLessThanOrEqual(4096);
  const body={version:1,kind,chunk,rows};expect(Buffer.byteLength(canonicalize(body)!)).toBe(bytes);return body;
}
async function b2CapLeaf(f:WindowsNativeFixture,body:{kind:string;chunk:number;rows:RawRow[]}){return (await f.admin.pool.query<{bytes:number|null;hash:string|null}>(`WITH encoded AS MATERIALIZED(SELECT manga_web.windows_stage_cost_leaf($1,$2,$3::jsonb) value)
  SELECT octet_length(value) bytes,encode(sha256(convert_to(value,'UTF8')),'hex') hash FROM encoded`,[body.kind,body.chunk,JSON.stringify(body.rows)])).rows[0];}

it.each([1048575,1048576,1048577])('W4-B2 independent closed raw leaf %i bytes preserves byte hash at the one MiB boundary',async bytes=>withPrepared(async(f)=>{
  const body=b2CapLeafBody(bytes),actual=await b2CapLeaf(f,body);if(bytes<=1048576){expect(actual.bytes).toBe(bytes);expect(actual.hash).toBe(digest(body));}else expect(actual).toEqual({bytes:null,hash:null});
  console.info(JSON.stringify({w4b2LeafCap:{bytes,actual,codecOnly:true,publicAuthorityOrMoneyClaim:false}}));
}));

it('W4-B2 independent closed raw leaf field and row bounds do not borrow another cap rejection',async()=>withPrepared(async(f)=>{
  const row:RawRow={kind:'RAW_OBJECT',id:'object',ref:{evidenceId:randomUUID(),evidenceDigest:sha256('reference')},contentDigest:sha256('content'),completedAt:null};
  for(const field of ['kind','id','completedAt','chunk','rows'] as const){const boundary={kind:64,id:4096,completedAt:64,chunk:16384,rows:256}[field];
    for(const delta of [-1,0,1]){const size=boundary+delta,kind=field==='kind'?'A'.repeat(size):row.kind,chunk=field==='chunk'?size:0,entry={...row,kind,id:field==='id'?'x'.repeat(size):row.id,completedAt:field==='completedAt'?'0'.repeat(size):row.completedAt},rows=Array.from({length:field==='rows'?size:1},(_,index)=>({...entry,id:field==='rows'?String(index):entry.id})),body={version:1,kind,chunk,rows};
      const actual=await b2CapLeaf(f,body);if(delta<=0){expect(actual.bytes).toBe(Buffer.byteLength(canonicalize(body)!));expect(actual.hash).toBe(digest(body));}else expect(actual).toEqual({bytes:null,hash:null});
    }
  }
  // completedAt strings exercise this closed codec's byte bound, not original
  // timestamp validity or authorization. No synthetic string becomes evidence.
}));

// B2 공개 census의 독립 구조 상한 검사 초안. 아직 repo/PG 미실행이다.
// 관리자가 미등록 job 참조를 넣는 공격 자료를 사용하며 UNCONFIRMED를 유지한다.
// B1 정상 QUERY/CACHE 허가·전달·서명·금액 양성으로 계산하지 않는다.
// N-1/N은 전체 raw 열거, N+1은 null을 요구한다. 다른 상한은 모두 아래에 둔다.
type MetadataCapKind='QUERY_PER_CALL'|'QUERY_OWNER'|'CACHE_OWNER'|'NATIVE_FOOTPRINT';
type MetadataCapRow={callId:string;jobId:string;requestId:string;requestDigest:string;request:unknown;authority:unknown;source:unknown;evidenceId:string;evidenceDigest:string};
async function metadataCapRows(f:WindowsNativeFixture,x:Prepared,kind:MetadataCapKind,count:number){
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
  const calls:{callId:string;callDigest:string}[]=[];const number=kind==='QUERY_OWNER'||kind==='CACHE_OWNER'?17:1;
  for(let n=0;n<number;n++){
    const body={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('metadata-cap-'+n),componentId:'native-image'},call={...body,callDigest:digest(body)};
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call),true)).toEqual(call);calls.push(call);
  }
  const jobs=Array.from({length:kind==='NATIVE_FOOTPRINT'?65:kind==='CACHE_OWNER'?64:1},()=>randomUUID());
  const rows:MetadataCapRow[]=[];
  for(let n=0;n<count;n++){
    const call=calls[kind==='QUERY_OWNER'||kind==='CACHE_OWNER'?Math.floor(n/64):0],jobId=jobs[kind==='NATIVE_FOOTPRINT'?n:kind==='CACHE_OWNER'?n%64:0];
    const request={version:2,requestId:randomUUID(),binding:{accountId:f.seed.accountId,capacityReservationId:randomUUID(),jobId,parentInstanceId:randomUUID(),inputDigest:sha256('unregistered-input'),profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest},command:'QUERY',includeRawResult:true};
    const authority={version:1,requestId:request.requestId,requestDigest:digest(request),callRef:{callId:call.callId,callDigest:call.callDigest},binding:request.binding,attemptId:randomUUID(),controllerInstanceId:f.controllerInstanceId,peerService:f.peer.serviceRole,peerId:f.peer.peerId};
    const source={candidate:{jobId},receipt:null,intent:null,termination:null,origin:'CACHE'};
    rows.push({callId:call.callId,jobId,requestId:request.requestId,requestDigest:digest(request),request,authority,source,evidenceId:randomUUID(),evidenceDigest:digest(kind==='QUERY_PER_CALL'||kind==='QUERY_OWNER'?authority:{callId:call.callId,source})});
  }
  return rows;
}
async function metadataCapInsert(f:WindowsNativeFixture,x:Prepared,kind:MetadataCapKind,rows:MetadataCapRow[]){
  if(kind==='QUERY_PER_CALL'||kind==='QUERY_OWNER'){
    await f.admin.pool.query(`INSERT INTO manga_web.windows_native_cost_result_queries(account_id,execution_id,call_id,job_id,request_id,request_digest,protected_request,authority,evidence_id,evidence_digest,created_at)
      SELECT $1,$2,(r->>'callId')::uuid,(r->>'jobId')::uuid,(r->>'requestId')::uuid,r->>'requestDigest',r->'request',r->'authority',(r->>'evidenceId')::uuid,r->>'evidenceDigest',clock_timestamp() FROM jsonb_array_elements($3::jsonb) r`,[f.seed.accountId,x.owner.executionId,JSON.stringify(rows)]);
  }else{
    await f.admin.pool.query(`INSERT INTO manga_web.windows_native_cost_cache_uses(account_id,call_id,job_id,protected_source,evidence_id,evidence_digest,created_at)
      SELECT $1,(r->>'callId')::uuid,(r->>'jobId')::uuid,r->'source',(r->>'evidenceId')::uuid,r->>'evidenceDigest',clock_timestamp() FROM jsonb_array_elements($2::jsonb) r`,[f.seed.accountId,JSON.stringify(rows)]);
  }
}

async function metadataCapObserve(f:WindowsNativeFixture,x:Prepared,kind:MetadataCapKind,expected:MetadataCapRow[]){
  const queryKind=kind==='QUERY_PER_CALL'||kind==='QUERY_OWNER';
  const actual=queryKind?(await f.admin.pool.query<{id:string;call_id:string;job_id:string;evidence_id:string;evidence_digest:string;request_digest:string;protected_request:unknown;authority:unknown}>(`SELECT request_id::text id,call_id,job_id,evidence_id,evidence_digest,request_digest,protected_request,authority FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1 AND execution_id=$2 ORDER BY request_id LIMIT 1026`,[f.seed.accountId,x.owner.executionId])).rows:
    (await f.admin.pool.query<{id:string;call_id:string;job_id:string;evidence_id:string;evidence_digest:string;protected_source:unknown}>(`SELECT u.call_id::text||'/'||u.job_id::text id,u.call_id,u.job_id,u.evidence_id,u.evidence_digest,u.protected_source FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=$1 AND c.execution_id=$2 ORDER BY u.call_id,u.job_id LIMIT 1026`,[f.seed.accountId,x.owner.executionId])).rows;
  const projected=expected.map(row=>queryKind?{id:row.requestId,call_id:row.callId,job_id:row.jobId,evidence_id:row.evidenceId,evidence_digest:row.evidenceDigest,request_digest:row.requestDigest,protected_request:row.request,authority:row.authority}:{id:row.callId+'/'+row.jobId,call_id:row.callId,job_id:row.jobId,evidence_id:row.evidenceId,evidence_digest:row.evidenceDigest,protected_source:row.source});
  const compare=(a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0;expect([...actual].sort(compare)).toEqual(projected.sort(compare));
  const stats=(await f.admin.pool.query(`SELECT
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_scopes WHERE account_id=$1 AND execution_id=$2) scopes,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_calls WHERE account_id=$1 AND execution_id=$2) calls,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2) io,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1 AND execution_id=$2) queries,
    (SELECT count(*)::integer FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=$1 AND c.execution_id=$2) caches,
    (SELECT count(*)::integer FROM(SELECT job_id FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1 AND execution_id=$2 UNION SELECT u.job_id FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE u.account_id=$1 AND c.execution_id=$2) jobs) unique_jobs,
    COALESCE((SELECT max(n)::integer FROM(SELECT count(*) n FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1 AND execution_id=$2 GROUP BY call_id) groups),0) max_query_per_call,
    (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2) seals,
    (SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations WHERE account_id=$1 AND execution_id=$2) allocations,
    (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE') closures`,[f.seed.accountId,x.owner.executionId])).rows[0];
  expect(stats).toEqual({scopes:1,calls:kind==='QUERY_OWNER'||kind==='CACHE_OWNER'?17:1,io:0,queries:queryKind?expected.length:0,caches:queryKind?0:expected.length,unique_jobs:new Set(expected.map(row=>row.jobId)).size,max_query_per_call:queryKind?Math.max(...[...new Set(expected.map(row=>row.callId))].map(call=>expected.filter(row=>row.callId===call).length)):0,seals:0,allocations:0,closures:0});
  const raw:RawRow[]=expected.map(row=>({kind:queryKind?'RESULT_QUERY':'CACHE_USE',id:queryKind?row.requestId:row.callId+'/'+row.jobId,ref:{evidenceId:row.evidenceId,evidenceDigest:row.evidenceDigest},contentDigest:digest(queryKind?{request:row.request,authority:row.authority,callId:row.callId}:row.source),completedAt:null}));
  return {raw:raw.sort(compare),stats};
}
it.each(['QUERY_PER_CALL','QUERY_OWNER','CACHE_OWNER','NATIVE_FOOTPRINT'] as const)('W4-B2 independent census-only %s minus equal plus one isolates its own structural cap',async kind=>withPrepared(async(f,x)=>{
  const maximum=kind==='QUERY_PER_CALL'||kind==='NATIVE_FOOTPRINT'?64:1024,rows=await metadataCapRows(f,x,kind,maximum+1),rawKind=kind==='QUERY_PER_CALL'||kind==='QUERY_OWNER'?'RESULT_QUERY':'CACHE_USE',requestLimit=kind==='NATIVE_FOOTPRINT'?65:64;
  await metadataCapInsert(f,x,kind,rows.slice(0,maximum-1));
  for(const count of [maximum-1,maximum]){
    if(count===maximum)await metadataCapInsert(f,x,kind,rows.slice(maximum-1,maximum));
    const original=await metadataCapObserve(f,x,kind,rows.slice(0,count));
    const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)},requestLimit);expect(census).not.toBeNull();
    const metadata=census!.rows.filter(row=>row.kind===rawKind).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);expect(metadata).toEqual(original.raw);
    expect(census!.originals).toHaveLength(original.stats.unique_jobs);expect(census!.originals.every(original=>{const item=original as {key:unknown;classification:unknown};return item.key===null&&item.classification==='UNCONFIRMED';})).toBe(true);
    expect(census!.manifest).toEqual(manifest(census!.rows));expect(census!.rawSetDigest).toBe(digest(census!.manifest));
    console.info(JSON.stringify({w4b2IndependentMetadataCap:{kind,count,requestLimit,...original.stats,censusBytes:Buffer.byteLength(JSON.stringify(census)),unconfirmed:true,authorizationOrMoneyClaim:false}}));
  }
  await metadataCapInsert(f,x,kind,rows.slice(maximum));
  const original=await metadataCapObserve(f,x,kind,rows);
  expect(await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)},requestLimit)).toBeNull();
  console.info(JSON.stringify({w4b2IndependentMetadataOverflow:{kind,attempted:maximum+1,requestLimit,rawRows:rawKind,prefix:false,...original.stats,censusReadOnly:true,candidateOrSealCalled:false,authorizationOrMoneyClaim:false}}));
}),60000);

/*
B2-02 담당 신규 PG 파일에 통합할 Temp 초안이다. 아직 타입/PG 미검증이다.
다른 owner에서 이미 사용한 operation/event를 새 owner의 정합 source에
담은 경우를 B2 private 배정과 실제 generic/v1 CLOSURE 각각에서 대조한다.

기존 helper의 최소 변경(기본 동작 유지):
1. separatedConsumerBasis의 세번째 선택 인자 components:
   FullStageCostSnapshot['components']를 받는다. 기본값은 기존 IMAGE 1개.
   snapshot.components만 해당 인자로 둔다. legacy에는 []를 전달한다.
2. zeroWindowsWork의 x는 Pick<Prepared,'costs'|'execution'|'owner'>로 좁힌다.
   options에 sourceIds?:Partial<Record<'PROVIDER'|'ALLOCATION',
   {operationId:string;eventId:string}>>를 추가한다.
   기존 PROVIDER/ALLOCATION 원 SOURCE 생성 직전에만:
     const ids=options.sourceIds?.[target];
     const operationId=ids?.operationId??randomUUID();
     const eventId=ids?.eventId??randomUUID();
   를 사용한다. SOURCE/END/ref/fact 생성과 실제 preflight는 그대로다.
3. sqlCandidate와 absenceCandidate의 x는 실제 사용하는 owner만
   Pick<Prepared,'owner'>로 받는다. 새 current/control은 native capacity를
   재등록하거나 가짜 capacity 필드를 만들지 않는다.
   이미 저장한 원 SOURCE를 삭제하거나 숨기지 않는다.

legacy에는 실제 INPUT/BASIS/claim만 사용한다. root/Windows enrollment를
조작하거나 가짜 root를 만들지 않으며 generic OperationalStageCost가
실제 계산과 CLOSURE를 저장한 뒤 원 registry 행0을 먼저 확인한다.
현재 owner의 body/capture/fact/hash/membership/원 종료는 모두 정합이다.
*/

type EventReuseOrigin='B2'|'LEGACY';
type EventReuseTarget='PROVIDER'|'ALLOCATION';
const eventReuseCases:{origin:EventReuseOrigin;priorTarget:EventReuseTarget;currentTarget:EventReuseTarget}[]=([
  ['B2','PROVIDER','PROVIDER'],['B2','PROVIDER','ALLOCATION'],
  ['B2','ALLOCATION','PROVIDER'],['B2','ALLOCATION','ALLOCATION'],
  ['LEGACY','PROVIDER','PROVIDER'],['LEGACY','PROVIDER','ALLOCATION'],
  ['LEGACY','ALLOCATION','PROVIDER'],['LEGACY','ALLOCATION','ALLOCATION'],
] as const).map(([origin,priorTarget,currentTarget])=>({origin,priorTarget,currentTarget}));

async function priorLegacyEventWork(f:WindowsNativeFixture){
  await f.request();const execution=await f.prepareExecution();
  const basisRecord=await separatedConsumerBasis(f,execution.input,[{componentId:'legacy-storage',kind:'STORAGE',unit:'fixture-storage-byte-v1',rateVersion:'fixture-legacy-storage-v1',usdPerUnit:'0.01',evidenceRefs:['fixture:legacy-storage-rate']}]);
  const original=await f.originalIntent(execution);
  const owner:WindowsNativeCostOwner={executionId:execution.input.executionId,
    inputEvidenceId:original.sourceInput.inputEvidenceId,
    inputFingerprint:digest(canonicalInput(execution.input)),
    basisRef:{evidenceId:basisRecord.evidenceId,evidenceDigest:basisRecord.evidenceDigest},
    claim:{generation:execution.claim.generation,ownerId:f.service.workerId,workItemId:execution.claim.workId},
    validationAttemptRef:null};
  const costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256});
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,owner.executionId])).rows).toEqual([{n:0}]);
  const operationId=randomUUID(),eventId=randomUUID(),fact={componentId:'legacy-storage',captureDigest:basisRecord.value.value.captureDigest,state:'CONFIRMED' as const,quantity:'0',unit:'fixture-storage-byte-v1'},source=await putOriginal(f,{execution,owner},'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact}),termination=await putOriginal(f,{execution,owner},'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId,eventId,outcome:'RETURNED'}]});
  return {execution,owner,costs,legacyQuantity:{...fact,evidenceRefs:[source.evidenceId]},legacySource:{sourceOperationId:operationId,sourceEventId:eventId,target:'QUANTITY' as const,componentId:fact.componentId,evidence:[source]},legacyTermination:termination};
}

function genericPriorCost(f:WindowsNativeFixture,basis:FullStageCostBasis,work:OperationalStageCostWorkSet){
  const journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:calculatorBounds});
  const preparation=new FullStageCostPreparation(journal,[{stage:basis.capture.stage,profileDigest:basis.capture.profileDigest,snapshot:basis.snapshot}],calculatorBounds);
  const checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64});
  return new OperationalStageCost({db:f.worker,preparation,journal,
    reader:{workSetIn:async()=>structuredClone(work),checkpointFactsIn:async()=>null},
    checkpoints,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});
}

type EventReuseMode='BOTH'|'EVENT_ONLY'|'OPERATION_ONLY';
async function runEventReuseCase({origin,priorTarget,currentTarget,mode='BOTH'}:(typeof eventReuseCases)[number]&{mode?:EventReuseMode}){
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let f:WindowsNativeFixture|undefined;
  try{
    f=await windowsNativeFixture(20.5);const fixture=f;
    const previous=origin==='B2'?await prepareWindowsCostedTarget(f):await priorLegacyEventWork(f);
    const prior=await zeroWindowsWork(f,previous,{preparation:'FAILED',providerUsd:'0.03'});
    if('legacyQuantity' in previous){prior.work.facts.quantities!.push(previous.legacyQuantity);prior.work.sources.push(previous.legacySource);prior.work.joinedEvidence.push(...previous.legacySource.evidence);prior.work.terminationEvidence.push(previous.legacyTermination);}
    const cost=origin==='B2'?windowsCost(f,prior.basis,prior.reader).cost:genericPriorCost(f,prior.basis,prior.work);
    await cost.finishAttempt(previous.execution.input);await cost.idle();
    const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,previous.execution.input),true);
    expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.030000000000');
    const service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
    await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,previous.execution.input),true);
    expect((await f.admin.pool.query('SELECT capacity_released_at IS NOT NULL capacity_released,budget_resolved_at IS NOT NULL budget_resolved FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,previous.owner.executionId])).rows).toEqual([{capacity_released:true,budget_resolved:true}]);
    expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,previous.owner.executionId])).rows).toEqual([{n:origin==='LEGACY'?0:1}]);
    const old=(await f.admin.pool.query("SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,previous.owner.executionId])).rows;
    expect(old).toHaveLength(1);
    const oldSource=prior.work.sources.find(s=>s.target===priorTarget)!;
    expect(old[0].protected_observation.value.workSet.sources).toContainEqual(oldSource);
    const registry=(await f.admin.pool.query('SELECT event_id,execution_id,target FROM manga_web.windows_stage_cost_allocations WHERE account_id=$1 AND event_id=ANY($2::uuid[]) ORDER BY event_id',[f.seed.accountId,[oldSource.sourceOperationId,oldSource.sourceEventId]])).rows;
    expect(registry).toHaveLength(origin==='B2'?2:0);
    if(origin==='B2')expect(registry.every(r=>r.execution_id===previous.owner.executionId&&r.target===priorTarget)).toBe(true);
    expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,previous.owner.executionId])).rows).toEqual([{n:origin==='B2'?1:0}]);
    const next=await prepareIndependentCacheConsumer(f,previous.costs);
    const current=next;
    expect(current.owner.executionId).not.toBe(previous.owner.executionId);
    const reused={operationId:mode==='EVENT_ONLY'?randomUUID():oldSource.sourceOperationId,eventId:mode==='OPERATION_ONLY'?randomUUID():oldSource.sourceEventId};
    expect(reused.operationId).not.toBe(reused.eventId);if(mode==='EVENT_ONLY'){expect(reused.operationId).not.toBe(oldSource.sourceOperationId);expect(reused.operationId).not.toBe(oldSource.sourceEventId);}if(mode==='OPERATION_ONLY'){expect(reused.eventId).not.toBe(oldSource.sourceEventId);expect(reused.eventId).not.toBe(oldSource.sourceOperationId);}
    const now=await zeroWindowsWork(f,current,{providerUsd:'0.07',sourceIds:{[currentTarget]:reused}});
    const declared=now.work.sources.find(s=>s.target===currentTarget)!;
    expect([declared.sourceOperationId,declared.sourceEventId]).toEqual([reused.operationId,reused.eventId]);
    expect(declared.evidence.every(ref=>!oldSource.evidence.some(oldRef=>oldRef.evidenceId===ref.evidenceId))).toBe(true);
    // 정상 source 완전성과 종료를 먼저 확인해 다른 앞선 거부를 증거로 쓰지 않는다.
    const complete=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_non_windows($1::jsonb,$2::jsonb) valid',[JSON.stringify(now.work),JSON.stringify(current.owner)])).rows[0].valid,true);
    expect(complete).toBe(true);
    const candidate=await absenceCandidate(f,current,now.basis,now.work);
    expect(await f.service.renew(current.execution.claim)).toBe(true);
    const counts=async()=>(await fixture.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind=\'OPERATIONAL_COST_CLOSURE\') closures')).rows;
    const before=await counts(),saved=await costsSnapshot(f);
    const result=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(current.owner),JSON.stringify(candidate)])).rows[0].value,true);
    expect(result).toBeNull();expect(await counts()).toEqual(before);expect(await costsSnapshot(f)).toEqual(saved);
    expect((await f.admin.pool.query("SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,previous.owner.executionId])).rows).toEqual(old);
    // 새 사건 ID만 쓰는 같은 account/구성의 별도 owner는 public SEAL 양성이어야 한다.
    const control=await prepareIndependentCacheConsumer(f,previous.costs),fresh=await zeroWindowsWork(f,control,{providerUsd:'0.07'});
    expect(fresh.work.sources.every(source=>![reused.operationId,reused.eventId].includes(source.sourceOperationId)&&![reused.operationId,reused.eventId].includes(source.sourceEventId))).toBe(true);
    const controlCandidate=await absenceCandidate(f,control,fresh.basis,fresh.work);expect(await f.service.renew(control.execution.claim)).toBe(true);
    const positive=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(control.owner),JSON.stringify(controlCandidate)])).rows[0].value,true);
    expect(positive).not.toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,control.owner.executionId])).rows).toEqual([{n:1}]);
    expect(f.provider.calls).toEqual([]);
    console.info(JSON.stringify({w4b2EventReuse:{origin,mode,priorTarget,currentTarget,originalConfirmedUsd:view.costUsd,oldRegistryRows:registry.length,newSeal:0,newAllocation:0,currentSourceComplete:true,freshEventControlSealed:true}}));
  }catch(error){errors.push(error);}
  finally{try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_EVENT_REUSE_AND_CLEANUP_FAILED');
}
it.each(eventReuseCases)('W4-B2 original $origin $priorTarget event cannot be allocated to a new owner $currentTarget',runEventReuseCase,120000);
const eventSingleIdCases=eventReuseCases.flatMap(test=>(['EVENT_ONLY','OPERATION_ONLY'] as const).map(mode=>({...test,mode})));
it.each(eventSingleIdCases)('W4-B2 single-id $mode original $origin $priorTarget cannot be allocated to a new owner $currentTarget',runEventReuseCase,120000);

// 승인 PG 파일에 append할 B2-06 직접 회귀. 실제 PG 실행 전 초안이다.
it.each(['SEAL','CALCULATION'] as const)('W4-B2 signed FRESH history after %s restores original full cost after owner revision and asset expiry without object calls',async phase=>withPrepared(async(f,x)=>{
  const restore:(()=>void)[]=[],errors:unknown[]=[];
  try{
    const reads=vi.spyOn(f.files,'read');restore.push(()=>reads.mockRestore());
    const puts=vi.spyOn(f.files,'put');restore.push(()=>puts.mockRestore());
    expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
    const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'0'});
    const {basis,reader}=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),first=windowsCost(f,basis,reader),input=x.execution.input;
    const candidate=await reader.prepareCandidate(input,basis);expect(candidate).not.toBeNull();
    const sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,input,basis,candidate!),true);expect(sealed).not.toBeNull();
    if(phase==='CALCULATION'){const appended=await first.journal.append(input,sealed!.facts);expect(appended.view.state).toBe('CONFIRMED');expect(appended.view.costUsd).toBe('0.030000000000');}
    const immutable=async()=>(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS','WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION') ORDER BY evidence_id",[f.seed.accountId,input.executionId])).rows;
    const originalRows=await immutable();expect(originalRows.filter(r=>r.protected_observation.kind==='WINDOWS_NATIVE_OPERATION')).toHaveLength(1);expect(originalRows.filter(r=>r.protected_observation.kind==='WINDOWS_NATIVE_TERMINATION')).toHaveLength(1);
    expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,input.executionId])).rows).toEqual([{n:0}]);
    await f.admin.accountTransaction(f.seed.accountId,async tx=>{
      await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,input.contextId,tx.now]);
      await tx.client.query('UPDATE workspace_pages SET revision=revision+1 WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,input.contextId]);
      await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$2 WHERE account_id=$1",[f.seed.accountId,new Date(tx.now.valueOf()-1000)]);
    });
    const counts=async()=>(await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries) queries,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections) projections,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals")).rows;
    expect(reads.mock.calls.length).toBeGreaterThan(0);expect(puts.mock.calls.length).toBeGreaterThan(0);
    const filesBefore={read:reads.mock.calls.length,put:puts.mock.calls.length},countsBefore=await counts();
    const nextReader=new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows:{nonWindowsIn:async()=>{throw new Error('W4B2_HISTORY_MUST_NOT_PREPARE');},checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds}});
    const next=windowsCost(f,basis,nextReader).cost,service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,next);
    await next.finishAttempt(input);await next.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>next.readIn(tx,input),true);
    expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.030000000000');expect(view.calculations).toHaveLength(1);
    await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,input),true);
    const saved=await costsSnapshot(f);expect(saved.costs).toHaveLength(1);expect(saved.expenses).toHaveLength(1);
    const exactExpense=(await f.admin.pool.query('SELECT actual_usd::text actual_usd,evidence_id,evidence_digest FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,input.executionId])).rows;expect(exactExpense).toEqual([{actual_usd:'0.030000000000',evidence_id:view.calculations[0].evidenceId,evidence_digest:view.calculations[0].evidenceDigest}]);
    for(const row of originalRows)expect((await immutable()).find(r=>r.evidence_id===row.evidence_id)).toEqual(row);
    expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,input.executionId])).rows).toEqual([{n:1}]);
    await next.finishAttempt(input);await next.idle();await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,input),true);
    expect(await costsSnapshot(f)).toEqual(saved);expect(await counts()).toEqual(countsBefore);expect({read:reads.mock.calls.length,put:puts.mock.calls.length}).toEqual(filesBefore);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true)).toBeNull();
    expect(originalRows.find(r=>r.protected_observation.kind==='WINDOWS_NATIVE_OPERATION')!.protected_observation.value.binding.jobId).toBe(native.key.binding.jobId);
    console.info(JSON.stringify({w4b2SignedHistory:{phase,ownerClosedAndNull:true,revisionsChanged:true,assetsDeletedAndExpired:true,newInstance:true,actualUsd:view.costUsd,exactExpenseUsd:exactExpense[0].actual_usd,originalRefsDatesUnchanged:true,filesBefore,filesAfter:{read:reads.mock.calls.length,put:puts.mock.calls.length},newGoStartQueryProjectionSeal:0,firstReservationReleaseNotClaimed:true}}));
  }catch(error){errors.push(error);}finally{for(const reset of restore.reverse())try{reset();}catch(error){errors.push(error);}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_SIGNED_HISTORY_AND_RESTORE_FAILED');
}),120000);

// Same-consumer direct SQL attacks. Every original SOURCE/ref/fact is retained;
// one real synthetic end tuple is stored per distinct operation/event pair.
type EventPair='PROVIDER_ALLOCATION'|'QUANTITY_COMPONENTS';
function eventPairIds(mode:EventReuseMode|'DISTINCT'){
  const first={operationId:randomUUID(),eventId:randomUUID()},second={operationId:mode==='BOTH'||mode==='OPERATION_ONLY'?first.operationId:randomUUID(),eventId:mode==='BOTH'||mode==='EVENT_ONLY'?first.eventId:randomUUID()};return [first,second] as const;
}
function eventPairSnapshot(snapshot:FullStageCostSnapshot,pair:EventPair):FullStageCostSnapshot{return pair==='PROVIDER_ALLOCATION'?snapshot:{...snapshot,components:[...snapshot.components,...['quantity-a','quantity-b'].map(componentId=>({componentId,kind:'RENDER' as const,unit:'fixture-semantic-event-v1',rateVersion:'fixture-component-event-v1',usdPerUnit:'0.01',evidenceRefs:['fixture:component-event-rate']}))]};}
async function eventPairWork(f:WindowsNativeFixture,x:Pick<Prepared,'costs'|'execution'|'owner'>,pair:EventPair,mode:EventReuseMode|'DISTINCT'){
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02',omitSourceTargets:pair==='PROVIDER_ALLOCATION'?['PROVIDER','ALLOCATION']:[]}),ids=eventPairIds(mode);
  const quantities:NonNullable<OperationalStageCostWorkSet['facts']['quantities']>=pair==='QUANTITY_COMPONENTS'?['quantity-a','quantity-b'].map(componentId=>({componentId,captureDigest:ready.basis.captureDigest,state:'CONFIRMED',quantity:'1',unit:'fixture-semantic-event-v1',evidenceRefs:[]})):[];
  if(pair==='QUANTITY_COMPONENTS')ready.work.facts.quantities=quantities;
  const entries=pair==='PROVIDER_ALLOCATION'?[{target:'PROVIDER' as const,componentId:null,fact:ready.work.facts.provider!},{target:'ALLOCATION' as const,componentId:null,fact:ready.work.facts.allocation!}]:quantities.map(fact=>({target:'QUANTITY' as const,componentId:fact.componentId,fact}));
  const operations:{operationId:string;eventId:string;outcome:'RETURNED'}[]=[];
  for(let index=0;index<entries.length;index++){
    const entry=entries[index],identity=ids[index],{evidenceRefs:_refs,...fact}=entry.fact,evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,...identity,fact});entry.fact.evidenceRefs=[evidence.evidenceId];
    ready.work.sources.push({sourceOperationId:identity.operationId,sourceEventId:identity.eventId,target:entry.target,componentId:entry.componentId,evidence:[evidence]});ready.work.joinedEvidence.push(evidence);
    if(!operations.some(row=>row.operationId===identity.operationId&&row.eventId===identity.eventId))operations.push({...identity,outcome:'RETURNED'});
  }
  ready.work.terminationEvidence.push(await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations}));return {ready,ids};
}
const eventPairCases=(['PROVIDER_ALLOCATION','QUANTITY_COMPONENTS'] as const).flatMap(pair=>(['BOTH','EVENT_ONLY','OPERATION_ONLY'] as const).map(mode=>({pair,mode})));
it.each(eventPairCases)('W4-B2 same-consumer $pair $mode reuse preserves complete facts but cannot seal two target allocations',async({pair,mode})=>withPrepared(async(f,x)=>{
  const {ready,ids}=await eventPairWork(f,x,pair,mode),candidate=await absenceCandidate(f,x,ready.basis,ready.work),gates=await b2CoverageGates(f,x,ready,candidate),expectedUsd=pair==='PROVIDER_ALLOCATION'?'0.020000000000':'0.040000000000';
  const {captureDigest:_captureDigest,...capture}=ready.basis.capture,calculated=new FullStageCostCalculator(ready.basis.snapshot,calculatorBounds).calculate(capture,candidate.workSet.facts);expect(calculated.state).toBe('CONFIRMED');expect(calculated.actualUsd).toBe(expectedUsd);expect(gates.amount.actualUsd).toBe(expectedUsd);
  for(const source of ready.work.sources){
    const fact=source.target==='PROVIDER'?ready.work.facts.provider!:source.target==='ALLOCATION'?ready.work.facts.allocation!:ready.work.facts.quantities!.find(row=>row.componentId===source.componentId)!,{evidenceRefs,...body}=fact;expect(evidenceRefs).toEqual(source.evidence.map(ref=>ref.evidenceId));
    const proof=(await f.admin.pool.query('SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,source.evidence[0].evidenceId])).rows[0].protected_observation;expect(digest(proof)).toBe(source.evidence[0].evidenceDigest);expect(proof.value).toEqual({version:1,operationId:source.sourceOperationId,eventId:source.sourceEventId,fact:body});
  }
  expect(candidate.rawSetDigest).toBe((await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)}))!.rawSetDigest);expect(await b2CoverageSeal(f,x,candidate)).toBeNull();expect(gates.coverage).toBe(false);expect(await b2SplitCounts(f)).toEqual({seals:0,allocations:0,calculations:0,closures:0,totals:0,expenses:0});
  const control=await prepareIndependentCacheConsumer(f,x.costs,ready.basis.snapshot!.components),fresh=await eventPairWork(f,control,pair,'DISTINCT'),controlCandidate=await absenceCandidate(f,control,fresh.ready.basis,fresh.ready.work);
  expect(await f.service.renew(control.execution.claim)).toBe(true);expect(await b2CoverageSeal(f,control,controlCandidate)).not.toBeNull();expect((await b2SplitCounts(f)).seals).toBe(1);expect((await b2SplitCounts(f)).closures).toBe(0);expect(f.provider.calls).toEqual([]);
  console.info(JSON.stringify({w4b2SameConsumerEvent:{pair,mode,ids,pureAmount:expectedUsd,originalSources:ready.work.sources.length,sourceRefAndBodyExact:true,coverageGate:false,publicSeal:null,newAllocation:0,newClosure:0,freshIdentityControlSealed:true,registryIsNotClaimedAsSoleRejector:true}}));
},f=>prepareWithBasis(f,snapshot=>eventPairSnapshot(snapshot,pair))),120000);

// B2-09 실제 PG 원 SOURCE 집합 검사 초안. 제품/fixture 파일은 바꾸지 않는다.
// PNG 내용은 같아도 실제 metadata/blob ID를 함께 바꾸어 정상 operation digest를 분리한다.
async function b2LargeSourcePage(f:WindowsNativeFixture){
  const pageId=randomUUID(),assetId=randomUUID(),resultId=randomUUID(),bytes=Buffer.from(ownedNativePng,'base64'),key=f.seed.accountId+'/'+assetId;
  await f.files.put(key,bytes);
  await f.admin.transaction(async client=>{
    await client.query('INSERT INTO manga_web.page_lineages(account_id,page_lineage_id,project_lineage_id) VALUES($1,$2,$3)',[f.seed.accountId,pageId,f.seed.projectId]);
    await client.query("INSERT INTO manga_web.workspace_pages(account_id,context_id,project_lineage_id,page_lineage_id,display_order,excluded,skip,result_revision,paid_baseline_credit,baseline_contribution_refs,revision,image_width,image_height) SELECT $1,$2,$3,$4,COALESCE(MAX(display_order),-1)+1,false,false,0,0,'[]',0,1,1 FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId,f.seed.projectId,pageId]);
    await client.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,verified_at) VALUES($1,$2,'LIVE',$3,$4,$5,$6,'image/png','NOT_DUE',$7,clock_timestamp(),clock_timestamp())",[f.seed.accountId,assetId,f.files.bucket,key,sha256(bytes),String(bytes.length),f.seed.contextId]);
    await client.query("INSERT INTO manga_web.results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,protected_edit_data_ref,origin,edit_data) VALUES($1,$2,$3,$4,0,$5,$2::uuid::text,'UPLOAD',$6)",[f.seed.accountId,resultId,f.seed.contextId,pageId,assetId,JSON.stringify({blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'})]);
    await client.query('UPDATE manga_web.workspace_pages SET current_result_id=$4 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,pageId,resultId]);
  });
  return (await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_TRANSLATION',payload:{pageId,scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}))).reply.operationRef.id!;
}
async function b2LargeSourceProducer(f:WindowsNativeFixture,costs:WindowsNativeCostJournal,capacity:Prepared['capacity'],index:number){
  const {createWindowsNativeCostOriginalFixture}=await import('../fixtures/windows-native.js');
  const {validateNativeJob}=await import('../../packages/native/src/jobs.js');
  const {NativeReceiptStore,readWindowsNativeOriginal}=await import('../../packages/domain/src/native-receipts.js');
  const originalIntent:WindowsNativeFixture['originalIntent']=async(prepared,kind,requestId,task)=>{
    const base=await f.originalIntent(prepared,kind,requestId,task),sourceBlobId='source-'+index,blobs=new Map([[sourceBlobId,Buffer.from(ownedNativePng,'base64')]]);
    const job=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId},blobs,windowsFrameLimits);validateNativeJob({envelope:job,blobs});
    const body={...base.intent,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),claim:{...base.intent.claim,ownerId:f.service.workerId}};
    const intent={...body,logicalOperationKey:nativeLogicalOperationKey(body)};
    const reserve:typeof base.reserve=async admitted=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.native_capacity_create_intent($1::jsonb,false,$2::jsonb) AS decision',[JSON.stringify(intent),JSON.stringify({...admitted,sourceInput:base.sourceInput})])).rows[0].decision);
    const binding:typeof base.binding=id=>({accountId:f.seed.accountId,capacityReservationId:id,jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:f.profile.kernelDigest});
    return {...base,intent,frame:{envelope:job,blobs},reserve,binding};
  };
  // 큰 본문은 기존 W4-A helper가 원 native capture 전에 완성한다. B1 root는 없다.
  const isolated:WindowsNativeFixture={...f,request:()=>b2LargeSourcePage(f),registerWindowsProfile:async()=>capacity,originalIntent};
  const source=await createWindowsNativeCostOriginalFixture(isolated,{mode:'CREATED',inputBytes:130000,basisBytes:130000,accounting:{userTime100ns:'10000000',kernelTime100ns:'0'}});
  expect(await f.service.renew(source.execution.claim)).toBe(true);
  const bridge=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.recordIn(tx,source.key),true);expect(bridge.state).toBe('VERIFIED');
  const job=source.original.frame.envelope,facts=await readWindowsNativeOriginal(f.worker,job,source.binding,source.key.expected,{input:windowsFrameLimits,output:windowsFrameLimits});
  expect(facts.resultObservation).not.toBeNull();expect(facts.termination.kind).toBe('WINDOWS_JOB_EMPTY');
  const bytes=Buffer.from(ownedNativePng,'base64'),computation={metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs:new Map([['canonical-png',bytes]])};
  const result=createNativeResult(job,computation,windowsFrameLimits);expect(digest(result)).toBe(facts.rawResult!.resultDigest);
  let produced=0;
  const target:Prepared['target']={accountId:f.seed.accountId,targetKind:'EXECUTION',targetId:source.execution.input.executionId,semanticCaptureDigest:facts.intent.semanticCaptureDigest,protectedOwnerCapture:facts.intent.protectedOwnerCapture,claim:facts.intent.claim,sourceInput:facts.sourceInput};
  const cache=NativeReceiptStore.windows(f.worker,f.files,target,f.profile.kernelDigest,{input:windowsFrameLimits,output:windowsFrameLimits},()=>{produced++;return {intent:facts.intent,job,result,resultObservationId:facts.resultObservation!.evidenceId,resultObservationDigest:facts.resultObservation!.evidenceDigest,termination:facts.termination,sourceInput:facts.sourceInput,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservationId:facts.terminationObservation.evidenceId,terminationObservationDigest:facts.terminationObservation.evidenceDigest};});
  await cache.seal('DECODE_IMAGE',job.metadata,source.original.frame.blobs,computation);expect(produced).toBe(1);
  const receipt=cache.sealedWindowsRecord('DECODE_IMAGE',job.metadata,source.original.frame.blobs);expect(receipt.origin).toBe('FRESH');expect(receipt.candidate.jobId).toBe(job.jobId);
  const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name),proof=await operator.confirmWindows(source.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,source.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});
  // provider를 호출하지 않은 합성 원본 준비 종료. 원 native 비용은 서명 원자료에 보존하며 producer 정산을 주장하지 않는다.
  const outcome={evidenceId:randomUUID(),outcome:'NOT_STARTED',started:false,usageConfirmed:true,costUsd:'0',finishReason:'SYNTHETIC_NATIVE_SOURCE_ONLY',providerRef:null,data:null};
  await f.admin.pool.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) VALUES($1,$2,$3,'OUTCOME',$4,$2::uuid::text,$5)",[f.seed.accountId,outcome.evidenceId,source.execution.input.executionId,digest(outcome),JSON.stringify(outcome)]);
  await f.admin.pool.query("UPDATE manga_web.executions SET state='FAILED',finished_confirmed_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,source.execution.input.executionId]);
  // B3에서 연결할 원 Windows 종료 인식은 이 SOURCE 검사로 고치거나 우회하지 않는다.
  // 첫 원본에서 실제 현재 경계를 관측하고 무료 HELD/원 TERM/원 request를 보존한다.
  if(index===0){
    await f.worker.accountTransaction(f.seed.accountId,async tx=>{const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',[f.seed.accountId,source.execution.input.requestId])).rows[0];expect(await finalizeSafe(tx,request,'FAILED',outcome.evidenceId)).toBe(false);},true);
    const row=(await f.admin.pool.query('SELECT state,terminal_at,hold_reasons FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,source.execution.input.requestId])).rows[0];expect(row.state).toBe('STOP_REQUESTED');expect(row.terminal_at).toBeNull();expect(row.hold_reasons).toContain('NATIVE_EXECUTION_UNCONFIRMED');
  }
  await f.service.finish(source.execution.claim,true);
  expect((await f.admin.pool.query('SELECT state FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,source.execution.claim.workId])).rows).toEqual([{state:'DONE'}]);
  return {source,job,receipt,computation};
}
it.each([2,64])('W4-B2 actual large SOURCE CACHE %i distinct original INPUT BASIS pairs finish one prepared action and seal',async count=>{
  const guard=guardWindowsNativeIo(),errors:unknown[]=[],restore:(()=>void)[]=[];let f:WindowsNativeFixture|undefined,pulse:ReturnType<typeof setInterval>|undefined,activePulse:Promise<void>|null=null,pulseError:unknown=null,currentClaim:Prepared['execution']['claim']|null=null;let heartbeats=0,claimRenews=0;
  try{
    f=await windowsNativeFixture(20.5);const original=f,policy={...original.requestPolicy,paidEnabled:true},service=new ExecutionService(original.worker,original.provider,policy),workspace=new WorkspaceService(original.api,policy);
    // 명시 합성 PAID 요청을 사용하는 별도 서비스다. 원 무료10/잔액100/실행 한도와 전역 설정은 보존한다.
    f={...original,service,workspace,requestPolicy:policy,prepareExecution:async()=>{const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');const input=await service.authorize(claim!);expect(input).not.toBeNull();return {claim:claim!,input:input!};}};
    expect(original.requestPolicy.paidEnabled).toBe(false);const fixture=f,capacity=await f.registerWindowsProfile(),costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256});
    const pulseNow=async()=>{const c=(await fixture.admin.pool.query('SELECT generation,owner_revision,connection_generation,heartbeat_seq FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[fixture.seed.accountId,fixture.seed.contextId])).rows[0];const reply=await workspace.heartbeat(fixture.actor,{contextId:fixture.seed.contextId,contextGeneration:c.generation,tabId:fixture.actor.tabId,expectedOwnerRevision:c.owner_revision,connectionGeneration:c.connection_generation,heartbeatSeq:String(BigInt(c.heartbeat_seq)+1n)});expect(reply.lastAcceptedSeq).toBe(String(BigInt(c.heartbeat_seq)+1n));heartbeats++;if(currentClaim){expect(await service.renew(currentClaim)).toBe(true);claimRenews++;}};
    await pulseNow();pulse=setInterval(()=>{if(!activePulse)activePulse=pulseNow().catch(error=>{pulseError=error;}).finally(()=>{activePulse=null;});},3000);
    const reads=vi.spyOn(f.files,'read');restore.push(()=>reads.mockRestore());const puts=vi.spyOn(f.files,'put');restore.push(()=>puts.mockRestore());
    const producers:Awaited<ReturnType<typeof b2LargeSourceProducer>>[]=[];
    for(let index=0;index<count;index++){if(pulseError)throw pulseError;producers.push(await b2LargeSourceProducer(f,costs,capacity,index));}
    const executions=producers.map(p=>p.source.execution.input.executionId),jobIds=producers.map(p=>p.job.jobId),inputIds=producers.map(p=>p.source.original.sourceInput.inputEvidenceId),basisIds=producers.map(p=>p.source.basis!.evidenceId);
    for(const set of [executions,jobIds,inputIds,basisIds,producers.map(p=>nativeOperationInputDigest(p.job))])expect(new Set(set).size).toBe(count);
    const originalRows=async()=>(await fixture.admin.pool.query("SELECT evidence_id,evidence_digest,execution_id,received_at,protected_observation,octet_length(protected_observation::text) bytes FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=ANY($2::uuid[]) AND kind IN('INPUT','OPERATIONAL_COST_BASIS','WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[fixture.seed.accountId,executions])).rows;
    const before=await originalRows();expect(before).toHaveLength(4*count);const sourceRows=before.filter(r=>inputIds.includes(r.evidence_id)||basisIds.includes(r.evidence_id));expect(sourceRows).toHaveLength(2*count);for(const row of sourceRows)expect(row.bytes).toBe(130000);
    expect((await f.admin.pool.query("SELECT (SELECT balance_credit=100 FROM manga_web.accounts WHERE account_id=$1) balance100,(SELECT count(*)::integer FROM manga_web.execution_capacity_permits WHERE account_id=$1) permits,(SELECT count(*)::integer FROM manga_web.execution_budget_reservations WHERE account_id=$1) budgets,(SELECT count(*)::integer FROM manga_web.cost_items WHERE account_id=$1) costs,(SELECT count(*)::integer FROM manga_web.processing_requests WHERE account_id=$1 AND terminal_at IS NOT NULL) terminal",[f.seed.accountId])).rows).toEqual([{balance100:true,permits:0,budgets:0,costs:0,terminal:0}]);
    if(count===64)expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.free_reservations WHERE account_id=$1 AND state='HELD'",[f.seed.accountId])).rows).toEqual([{n:10}]);
    const consumer=await prepareIndependentCacheConsumer(f,costs),x:Prepared={...consumer,capacity};currentClaim=x.execution.claim;
    expect((await f.admin.pool.query('SELECT mode FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,x.execution.input.requestId])).rows).toEqual([{mode:count===64?'PAID':'FREE'}]);
    const counts=async()=>(await fixture.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents) intents,(SELECT count(*)::integer FROM manga_web.native_capacity_reservations) admissions,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go")).rows;
    const countsBefore=await counts(),filesBefore={read:reads.mock.calls.length,put:puts.mock.calls.length};let consumerSourceCalls=0;
    const {NativeReceiptStore}=await import('../../packages/domain/src/native-receipts.js');
    const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:windowsNativeLimits.maxOutputBytes,begin:value=>fixture.worker.accountTransaction(fixture.seed.accountId,tx=>costs.beginIoIn(tx,value),true),end:value=>fixture.worker.accountTransaction(fixture.seed.accountId,tx=>costs.endIoIn(tx,value),true),lookup:value=>fixture.worker.accountTransaction(fixture.seed.accountId,tx=>costs.lookupIoIn(tx,value),true)});
    for(const producer of producers){
      expect(await f.service.renew(x.execution.claim)).toBe(true);
      const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
      const body={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:producer.job.task,taskVersion:producer.job.taskVersion,profileDigest:producer.job.profileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:nativeOperationInputDigest(producer.job),componentId:'native-image'},call={...body,callDigest:digest(body)};
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
      const cache=NativeReceiptStore.windowsCosted({db:f.worker,io,target:x.target,kernelImplementationDigest:f.profile.kernelDigest,limits:{input:windowsFrameLimits,output:windowsFrameLimits},source:()=>{consumerSourceCalls++;throw new Error('W4B2_CACHE_SOURCE_MUST_NOT_RUN');},costs,call});
      const found=await cache.read('DECODE_IMAGE',producer.job.metadata,producer.source.original.frame.blobs);expect(found.state).toBe('VERIFIED');if(found.state!=='VERIFIED')throw new Error('W4B2_CACHE_MUST_BE_VERIFIED');
      expect(found.result.jobId).toBe(producer.job.jobId);expect(found.operationInputDigest).toBe(nativeOperationInputDigest(producer.job));expect(found.blobs.get('canonical-png')).toEqual(producer.computation.blobs.get('canonical-png'));
      await cache.seal('DECODE_IMAGE',producer.job.metadata,producer.source.original.frame.blobs,{metadata:found.result.metadata,blobs:found.blobs});expect(cache.sealedWindowsRecord('DECODE_IMAGE',producer.job.metadata,producer.source.original.frame.blobs).origin).toBe('CACHE');
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}),true)).toBe('JOINED');
    }
    expect(consumerSourceCalls).toBe(0);expect(await counts()).toEqual(countsBefore);expect(puts.mock.calls.length).toBe(filesBefore.put);expect(reads.mock.calls.length).toBeGreaterThan(filesBefore.read);
    const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(census).not.toBeNull();
    const originals=census!.originals as {classification:string;key:WindowsNativeOriginalKey}[];expect(originals).toHaveLength(count);expect(originals.every(item=>item.classification==='CACHE')).toBe(true);expect(originals.map(item=>item.key.binding.jobId).sort()).toEqual([...jobIds].sort());expect(census!.rows.filter(row=>row.kind==='CACHE_USE')).toHaveLength(count);expect(census!.rows.filter(row=>row.kind==='BINDING')).toHaveLength(0);
    for(const row of sourceRows){const value=await lookup<{ref:Ref;value:unknown}>(f,{version:1,mode:'SOURCE',owner:x.owner,ref:{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}});expect(value).not.toBeNull();expect(value!.value).toEqual(row.protected_observation);}
    const readerCounts={source:0,original:0},lookupIn=costs.stageLookupIn.bind(costs);
    const portSpy=vi.spyOn(costs,'stageLookupIn').mockImplementation(async(tx,query,limit)=>{if(query.mode==='SOURCE')readerCounts.source++;if(query.mode==='ORIGINAL')readerCounts.original++;return lookupIn(tx,query,limit);});restore.push(()=>portSpy.mockRestore());
    const ready=await zeroWindowsWork(f,x);readerCounts.source=0;readerCounts.original=0;
    expect(await f.service.renew(x.execution.claim)).toBe(true);const candidate=await ready.reader.prepareCandidate(x.execution.input,ready.basis);expect(candidate).not.toBeNull();const preparedCounts={...readerCounts};
    expect(await f.service.renew(x.execution.claim)).toBe(true);const sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.sealIn(tx,x.execution.input,ready.basis,candidate!),true);expect(sealed).not.toBeNull();expect(preparedCounts.source).toBe(2*count);expect(readerCounts.source).toBe(2*count);expect(preparedCounts.original).toBe(count);expect(readerCounts.original).toBe(count);
    const allow=(await f.admin.pool.query('SELECT lookup_membership FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId])).rows[0].lookup_membership as {originals:{key:WindowsNativeOriginalKey}[];sources:Ref[]};
    expect(allow.originals).toEqual(census!.originals);expect(allow.originals).toHaveLength(count);
    const keyOrder=(a:WindowsNativeOriginalKey,b:WindowsNativeOriginalKey)=>a.binding.jobId<b.binding.jobId?-1:1;
    expect(allow.originals.map(row=>row.key).sort(keyOrder)).toEqual(producers.map(row=>row.source.key).sort(keyOrder));
    const expectedSources:Ref[]=[...sourceRows.map(row=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest})),{evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint},x.owner.basisRef];
    expect(allow.sources).toHaveLength(2*count+2);expect(allow.sources).toEqual(expectedSources.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1));
    const cost=windowsCost(f,ready.basis,ready.reader).cost;await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.000000000000');expect(view.calculations[0].result.facts.quantities).toEqual([expect.objectContaining({componentId:'native-image',quantity:'0'})]);
    expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE') closures,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_NATIVE_COST_ABSENCE') absences,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_NATIVE_COST_ATTRIBUTION') native_attributions",[f.seed.accountId,x.owner.executionId])).rows).toEqual([{seals:1,closures:1,absences:1,native_attributions:0}]);
    expect(await originalRows()).toEqual(before);expect(await counts()).toEqual(countsBefore);expect(puts.mock.calls.length).toBe(filesBefore.put);if(pulseError)throw pulseError;
    console.info(JSON.stringify({w4b2LargeActualSources:{count,inputPairs:count,basisPairs:count,pgSourceBodyBytes:sourceRows.reduce((sum,row)=>sum+row.bytes,0),readerCounts,preparedCounts,classification:'CACHE',consumerSourceCalls,newAdmissionGoPut:0,consumerNativeCpu:'0',producerCostCompletion:false,producerFinalizeSafeWindowsWaitObserved:true,syntheticPaidRequestPolicy:true,originalFreeLimitAndBalanceUnchanged:true,heartbeats,claimRenews,lowerReceiptCapability:true,facadeConsumerIntegrationNotClaimed:true}}));
  }catch(error){errors.push(error);}
  finally{if(pulse)clearInterval(pulse);if(activePulse)await activePulse;if(pulseError&&!errors.includes(pulseError))errors.push(pulseError);try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{for(const reset of restore.reverse())try{reset();}catch(error){errors.push(error);}guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4B2_LARGE_SOURCE_AND_CLEANUP_FAILED');
},600000);

type B2TerminalFault='MISSING_OUTCOME'|'DUPLICATE_OUTCOME'|'BODY_MISMATCH'|'HASH_MISMATCH'|'MISSING_FINISHED'|'CLAIM_REPLACED'|'CLAIM_EXPIRED'|'CONTEXT_CLOSED'|'OWNER_LOST';
const b2TerminalFaults:B2TerminalFault[]=['MISSING_OUTCOME','DUPLICATE_OUTCOME','BODY_MISMATCH','HASH_MISMATCH','MISSING_FINISHED','CLAIM_REPLACED','CLAIM_EXPIRED','CONTEXT_CLOSED','OWNER_LOST'];
async function b2TerminalNegative(f:WindowsNativeFixture,x:Prepared,basis:FullStageCostBasis,nw:OperationalStageCostWorkSet,full:Awaited<ReturnType<typeof sqlCandidate>>,observation:ReturnType<typeof normalizeObservation>,cost:OperationalStageCost,service:ExecutionService,fault:B2TerminalFault){
  // 결함 주입 전 같은 fixture의 실제 공개 SEAL 양성을 검증하고 거래를 되돌린다.
  // private registry/정산을 남기지 않아 이후 음성을 독립적으로 관측할 수 있다.
  const marker=new Error('B2_TERMINAL_CONTROL_ROLLBACK');let positive=false;
  try{await f.worker.accountTransaction(f.seed.accountId,async tx=>{const value=(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(full)])).rows[0].value;expect(value).not.toBeNull();positive=true;throw marker;},true);}catch(error){if(error!==marker)throw error;}
  expect(positive).toBe(true);expect(await b2SplitCounts(f)).toMatchObject({seals:0,allocations:0,calculations:0,closures:0,expenses:0});
  const originalOutcome=nw.terminationEvidence.find(r=>r.evidenceId===observation.evidenceId)!;expect(originalOutcome).toBeDefined();
  // 아래 관리자 주입은 한 사례에서 한 원인만 바꾼다. 원 SOURCE/단가/claim을
  // 나중에 조작해 양성을 맞추지 않으며, context CLOSED는 표의 필수 부수열도 닫는다.
  if(fault==='MISSING_OUTCOME'){await f.admin.pool.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,observation.evidenceId]);nw.terminationEvidence=nw.terminationEvidence.filter(r=>r.evidenceId!==observation.evidenceId);}
  else if(fault==='DUPLICATE_OUTCOME')nw.terminationEvidence.push(await putOriginal(f,x,'OUTCOME',{...observation,evidenceId:randomUUID(),finishReason:'SECOND_COMPLETE_FAILURE'}));
  else if(fault==='BODY_MISMATCH'){const body={...observation,finishReason:'DIFFERENT_FROM_EXECUTION_OUTPUT'},ref={evidenceId:observation.evidenceId,evidenceDigest:digest(body)};await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$4,evidence_digest=$5 WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,ref.evidenceId,JSON.stringify(body),ref.evidenceDigest]);nw.terminationEvidence=nw.terminationEvidence.map(r=>r.evidenceId===ref.evidenceId?ref:r);}
  else if(fault==='HASH_MISMATCH'){const ref={evidenceId:observation.evidenceId,evidenceDigest:sha256('B2 invalid original OUTCOME content hash')};await f.admin.pool.query('UPDATE manga_web.execution_evidence SET evidence_digest=$4 WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,ref.evidenceId,ref.evidenceDigest]);nw.terminationEvidence=nw.terminationEvidence.map(r=>r.evidenceId===ref.evidenceId?ref:r);}
  else if(fault==='MISSING_FINISHED')await f.admin.pool.query('UPDATE manga_web.executions SET finished_confirmed_at=NULL WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId]);
  else if(fault==='CLAIM_REPLACED')await f.admin.pool.query('UPDATE manga_web.work_items SET claim_owner=$3 WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,x.execution.claim.workId,randomUUID()]);
  else if(fault==='CLAIM_EXPIRED')await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,x.execution.claim.workId]);
  else if(fault==='CONTEXT_CLOSED')await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
  else if(fault==='OWNER_LOST')await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId]);
  nw.terminationEvidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
  const candidate=await absenceCandidate(f,x,basis,nw),raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();expect(candidate.rawSetDigest).toBe(raw!.rawSetDigest);expect(raw!.manifest).toEqual(manifest(raw!.rows));
  const gates=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query(`SELECT manga_web.windows_stage_cost_non_windows($1::jsonb,$2::jsonb) coverage,
    (manga_web.windows_stage_cost_amount($3::jsonb,$4::jsonb)->>'actualUsd')::numeric(28,12)::text facts_amount,
    manga_web.windows_native_cost_owner_current($2::jsonb,$5::jsonb) current_owner,manga_web.windows_stage_cost_terminal_owner($2::jsonb,$5::jsonb) terminal_owner`,[JSON.stringify(nw),JSON.stringify(x.owner),JSON.stringify(basis),JSON.stringify(candidate.workSet.facts),JSON.stringify(x.target.protectedOwnerCapture)])).rows[0],true);
  const seal=await b2CoverageSeal(f,x,candidate);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);const counts=await b2SplitCounts(f);
  const actual=(await f.admin.pool.query(`SELECT e.state,e.finished_confirmed_at IS NOT NULL finished,e.output_envelope,r.state request_state,r.terminal_at IS NOT NULL request_terminal,
    w.claim_owner::text,w.claim_generation::text,w.lease_until>clock_timestamp() lease_live,c.lifecycle,c.owner_session_id::text,c.owner_tab_id::text,
    (SELECT count(*)::integer FROM manga_web.active_page_requests p WHERE p.account_id=e.account_id AND p.request_id=e.request_id) active,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('evidenceId',v.evidence_id,'evidenceDigest',v.evidence_digest,'body',v.protected_observation) ORDER BY v.evidence_id),'[]') FROM manga_web.execution_evidence v WHERE v.account_id=e.account_id AND v.execution_id=e.execution_id AND v.kind='OUTCOME') outcomes
    FROM manga_web.executions e JOIN manga_web.processing_requests r USING(account_id,request_id) JOIN manga_web.work_items w ON w.account_id=e.account_id AND w.work_item_id=$3 JOIN manga_web.workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id WHERE e.account_id=$1 AND e.execution_id=$2`,[f.seed.accountId,x.owner.executionId,x.execution.claim.workId])).rows[0];
  console.info(JSON.stringify({w4b2TerminalNegative:{fault,controlSealRolledBack:positive,rawSetDigest:raw!.rawSetDigest,membershipDigest:candidate.membershipDigest,completion:raw!.completion,originalOutcome,gates,actual,seal,view:{state:view.state,costUsd:view.costUsd},counts}}));
  expect(gates.facts_amount).toBe('0.020000000000');expect(gates.current_owner).toBe(false);expect(seal).toBeNull();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(counts).toMatchObject({seals:0,allocations:0,calculations:0,closures:0,expenses:0,totals:1});expect(actual.active).toBe(0);expect(actual.request_state).toBe('FAILED');expect(actual.state).toBe('FAILED');
  if(['CLAIM_REPLACED','CLAIM_EXPIRED','CONTEXT_CLOSED','OWNER_LOST'].includes(fault))expect(gates.terminal_owner).toBe(false);else expect(gates.terminal_owner).toBe(true);
}

// 실제 dispatch/observe/finalizeSafe와 원 claim을 공유하는 양성·음성 fixture다.
async function b2TerminalExecutionCase(f:WindowsNativeFixture,x:Prepared,fault:B2TerminalFault|null=null){
  const basis=(await f.admin.pool.query<{basis:FullStageCostBasis}>("SELECT protected_observation->'value' basis FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2",[f.seed.accountId,x.owner.basisRef.evidenceId])).rows[0].basis;
  let nonWindows:OperationalStageCostWorkSet|null=null;
  const reader=new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows:{nonWindowsIn:async()=>nonWindows===null?null:structuredClone(nonWindows),checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds}}),{cost}=windowsCost(f,basis,reader),service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const nativeCall=await b2RaceCall(f,x,scope!),request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:nativeCall.call.callId,callDigest:nativeCall.call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null};
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:event=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,event),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),ended=await io.receipt(request);expect(ended.state).toBe('RETURNED');if(ended.state!=='RETURNED')throw new Error('B2_TERMINAL_RECEIPT_REQUIRED');expect(ended.event.ended).not.toBeNull();
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!,[ended.event.ended!])),true)).toBe('JOINED');
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  expect((await f.admin.pool.query("SELECT state,dispatch_attempted_at IS NOT NULL dispatched FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,x.owner.executionId])).rows).toEqual([{state:'DISPATCHING',dispatched:true}]);
  const observation=normalizeObservation(x.execution.input,{evidenceId:randomUUID(),outcome:'FAILURE',started:true,usageConfirmed:true,costUsd:'0.02',finishReason:'SYNTHETIC_TERMINAL_FAILURE',providerRef:null,data:null});
  await service.observe(f.seed.accountId,x.owner.executionId,observation);
  const terminal=(await f.admin.pool.query(`SELECT e.state,e.dispatch_attempted_at IS NOT NULL dispatched,e.start_confirmed_at IS NOT NULL started,e.finished_confirmed_at IS NOT NULL finished,r.state request_state,r.terminal_at IS NOT NULL request_terminal,
    (SELECT count(*)::integer FROM manga_web.active_page_requests p WHERE p.account_id=e.account_id AND p.request_id=e.request_id) active,
    (SELECT count(*)::integer FROM manga_web.native_job_intents i WHERE i.account_id=e.account_id) native_intents,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions g WHERE g.account_id=e.account_id) go,
    (SELECT count(*)::integer FROM manga_web.execution_evidence v WHERE v.account_id=e.account_id AND v.execution_id=e.execution_id AND v.kind='OUTCOME' AND v.evidence_id=$3 AND v.protected_observation->>'outcome'='FAILURE') failure_outcomes
    FROM manga_web.executions e JOIN manga_web.processing_requests r USING(account_id,request_id) WHERE e.account_id=$1 AND e.execution_id=$2`,[f.seed.accountId,x.owner.executionId,observation.evidenceId])).rows[0];
  expect(terminal).toEqual({state:'FAILED',dispatched:true,started:true,finished:true,request_state:'FAILED',request_terminal:true,active:0,native_intents:0,go:0,failure_outcomes:1});
  expect(await f.service.renew(x.execution.claim)).toBe(true);
  const ownerGates=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query(`SELECT manga_web.windows_native_cost_owner_current($1::jsonb,$2::jsonb) current_owner,manga_web.windows_stage_cost_terminal_owner($1::jsonb,$2::jsonb) terminal_owner,
    w.state,w.claim_owner::text,w.claim_generation::text,w.lease_until>clock_timestamp() lease_live,c.lifecycle,c.owner_session_id IS NOT NULL session_present,c.owner_tab_id IS NOT NULL tab_present
    FROM manga_web.work_items w JOIN manga_web.workspace_contexts c ON c.account_id=w.account_id AND c.context_id=$4 WHERE w.account_id=$3 AND w.work_item_id=$5`,[JSON.stringify(x.owner),JSON.stringify(x.target.protectedOwnerCapture),f.seed.accountId,f.seed.contextId,x.execution.claim.workId])).rows[0],true);
  expect(ownerGates).toMatchObject({current_owner:false,terminal_owner:true,state:'CLAIMED',claim_owner:x.owner.claim.ownerId,claim_generation:x.owner.claim.generation,lease_live:true,lifecycle:'OPEN',session_present:true,tab_present:true});
  const provider={scope:'ACTUAL_AI_USD' as const,captureDigest:basis.captureDigest,state:'CONFIRMED' as const,actualUsd:'0.02'},allocation={captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:basis.capture.mode==='FREE'?'FREE_OPERATIONS' as const:'PAID_PROCESSING' as const,basisVersion:basis.snapshot!.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'},sources:OperationalStageCostWorkSet['sources']=[],operations:{operationId:string;eventId:string;outcome:'RETURNED'}[]=[];
  for(const item of [{target:'PROVIDER' as const,fact:provider,operationId:randomUUID(),eventId:randomUUID(),io:null},{target:'ALLOCATION' as const,fact:allocation,operationId:randomUUID(),eventId:randomUUID(),io:null},{target:'PROVIDER' as const,fact:provider,operationId:ended.event.operationId,eventId:ended.event.eventId,io:ended.event}]){const ref=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:item.operationId,eventId:item.eventId,fact:item.fact,...(item.io?{io:item.io}:{})});sources.push({sourceOperationId:item.operationId,sourceEventId:item.eventId,target:item.target,componentId:null,evidence:[ref]});operations.push({operationId:item.operationId,eventId:item.eventId,outcome:'RETURNED'});}
  const termination=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations}),outcome=(await f.admin.pool.query<Ref>('SELECT evidence_id AS "evidenceId",evidence_digest AS "evidenceDigest" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,observation.evidenceId])).rows[0],refs=(target:string)=>sources.filter(s=>s.target===target).flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();
  nonWindows={version:1,executionId:x.owner.executionId,inputFingerprint:x.owner.inputFingerprint,captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(s=>s.evidence).sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),terminationEvidence:[termination,outcome].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1),sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER')},allocation:{...allocation,evidenceRefs:refs('ALLOCATION')},quantities:[]}};
  const candidate=await reader.prepareCandidate(x.execution.input,basis);expect(candidate).not.toBeNull();const full=await sqlCandidate(f,x,candidate!,nonWindows),raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw!.completion).toMatchObject({kind:'EXECUTION'});expect(raw!.originals).toEqual([]);expect(full.rawSetDigest).toBe(raw!.rawSetDigest);
  if(fault!==null){await b2TerminalNegative(f,x,basis,nonWindows,full,observation,cost,service,fault);return;}
  const seal=await b2CoverageSeal(f,x,full);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);
  const counts=await b2SplitCounts(f),money=(await f.admin.pool.query("SELECT c.actual_usd::text actual_usd,l.actual_usd::text expense_usd,c.usage_ref,c.confirmed_at,l.evidence_id,l.evidence_digest FROM manga_web.cost_items c JOIN manga_web.execution_limit_expenses l USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 AND c.component='STAGE_TOTAL'",[f.seed.accountId,x.owner.executionId])).rows;
  const blockedScope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true),blockedIo=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,{...request,operationId:randomUUID(),eventId:randomUUID()}),true),admission=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.admitIn(tx,scope!,nativeCall.call,nativeCall.intent,{...x.capacity,sourceInput:x.target.sourceInput!},'native-image'),true);
  console.info(JSON.stringify({w4b2TerminalExecution:{terminal,ownerGates,rawSetDigest:raw!.rawSetDigest,membershipDigest:full.membershipDigest,seal:seal!==null,view:{state:view.state,costUsd:view.costUsd},counts,money,blockedScope,blockedIo,admission,originalClaim:x.execution.claim,b1PriorJoinedFenceAlsoPresent:true}}));
  expect(blockedScope).toBeNull();expect(blockedIo).toBeNull();expect(admission.allowed).toBe(false);expect(seal).not.toBeNull();expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.020000000000');expect(counts).toMatchObject({seals:1,closures:1,calculations:1,totals:1,expenses:1});expect(money).toEqual([expect.objectContaining({actual_usd:'0.020000000000',expense_usd:'0.020000000000'})]);
  // 실제 0019 마감 뒤 원 permit의 release/resolve 근거와 예산을 직접 읽는다.
  const reservationSnapshot=async()=>(await f.admin.pool.query(`SELECT to_jsonb(p) permit,to_jsonb(b) budget,p.capacity_released_at IS NOT NULL capacity_released,p.budget_resolved_at IS NOT NULL budget_resolved,
    p.capacity_evidence_id=(SELECT evidence_id FROM manga_web.execution_evidence v WHERE v.account_id=p.account_id AND v.execution_id=p.execution_id AND v.kind='OPERATIONAL_COST_CLOSURE') capacity_uses_closure,
    p.budget_evidence_id=(SELECT evidence_id FROM manga_web.execution_limit_expenses v WHERE v.account_id=p.account_id AND v.execution_id=p.execution_id AND v.component='STAGE_TOTAL') budget_uses_calculation,
    p.stage_bound_usd::text stage_bound,b.initial_bound_usd::text request_bound,b.remaining_usd::text remaining_usd,b.state budget_state
    FROM manga_web.execution_capacity_permits p JOIN manga_web.execution_budget_reservations b USING(account_id,request_id) WHERE p.account_id=$1 AND p.execution_id=$2`,[f.seed.accountId,x.owner.executionId])).rows;
  const reservationBefore=await reservationSnapshot();expect(reservationBefore).toEqual([expect.objectContaining({capacity_released:true,budget_resolved:true,capacity_uses_closure:true,budget_uses_calculation:true,stage_bound:'3.000000000000',request_bound:'10.000000000000',remaining_usd:'0.000000000000',budget_state:'RELEASED'})]);
  console.info(JSON.stringify({w4b2TerminalReservations:{originalClaim:x.execution.claim,beforeRepeat:reservationBefore}}));
  const saved=await costsSnapshot(f);await cost.finishAttempt(x.execution.input);await cost.idle();await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);expect(await costsSnapshot(f)).toEqual(saved);expect(await reservationSnapshot()).toEqual(reservationBefore);expect(f.provider.calls).toEqual([]);
}

it('W4-B2 terminal EXECUTION actual FAILED finalizeSafe closes the request before first seal and retains full actual cost',async()=>withPrepared((f,x)=>b2TerminalExecutionCase(f,x)),120000);
it.each(b2TerminalFaults)('W4-B2 terminal EXECUTION isolated %s cannot seal or allocate the complete original cost',async fault=>withPrepared((f,x)=>b2TerminalExecutionCase(f,x,fault)),120000);

const b2CalculationCases=[
  {variant:'provider-fact-digest',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'normal-control',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'actual-usd-canonical',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'exact-total-canonical',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'wrapper-version-null',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'result-version-null',providerUsd:'0.02',expectedUsd:'0.020000000000'},
  {variant:'normal-control-10',providerUsd:'10',expectedUsd:'10.000000000000'},
  {variant:'normal-control-100',providerUsd:'100',expectedUsd:'100.000000000000'},
] as const;
it.each(b2CalculationCases)('W4-B2 calculation breakdown original C2 contract $variant',async({variant,providerUsd,expectedUsd})=>withPrepared(async(f,x)=>{
  const {basis,reader}=await zeroWindowsWork(f,x,{providerUsd}),input=x.execution.input,{journal}=windowsCost(f,basis,reader),normal=variant.startsWith('normal-control');
  const candidate=await reader.prepareCandidate(input,basis);expect(candidate).not.toBeNull();const sealed=await f.worker.accountTransaction(f.seed.accountId,tx=>reader.sealIn(tx,input,basis,candidate!),true);expect(sealed).not.toBeNull();
  expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CALCULATION'",[f.seed.accountId,input.executionId])).rows).toEqual([{n:0}]);
  const original=new FullStageCostCalculator(basis.snapshot,calculatorBounds).calculate({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:x.owner.inputFingerprint,stage:basis.capture.stage,profileDigest:basis.capture.profileDigest,mode:basis.capture.mode},sealed!.facts);
  expect(original.state).toBe('CONFIRMED');expect(original.captureDigest).toBe(basis.captureDigest);expect(original.snapshotDigest).toBe(basis.snapshotDigest);expect(original.actualUsd).toBe(expectedUsd);expect(original.exactTotalUsd).toBe(providerUsd);
  // 원 facts·수치 금액은 유지하고, 각 공격은 원 C2 출력의 한 필드만 바꾼다.
  const value=variant==='provider-fact-digest'?{...original,breakdown:{...original.breakdown,provider:{...original.breakdown.provider,factDigest:original.breakdown.provider.factDigest==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)}}}:
    variant==='actual-usd-canonical'?{...original,actualUsd:'0.02'}:variant==='exact-total-canonical'?{...original,exactTotalUsd:'0.020'}:variant==='result-version-null'?{...original,version:null}:original;
  const wrapper={version:variant==='wrapper-version-null'?null:1,accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:x.owner.inputFingerprint,kind:'OPERATIONAL_COST_CALCULATION',value},id=randomUUID(),recordDigest=digest(wrapper);
  expect(value.facts).toEqual(original.facts);expect(value.factsDigest).toBe(original.factsDigest);if(variant==='actual-usd-canonical'){expect(value.actualUsd).toBe('0.02');expect(Number(value.actualUsd)).toBe(Number(original.actualUsd));}else expect(value.actualUsd).toBe(original.actualUsd);
  if(variant==='exact-total-canonical'){expect(value.exactTotalUsd).toBe('0.020');expect(Number(value.exactTotalUsd)).toBe(Number(original.exactTotalUsd));}else expect(value.exactTotalUsd).toBe(original.exactTotalUsd);
  let insertion:'ADMITTED'|'DENIED'='ADMITTED';try{await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_CALCULATION',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,id,input.executionId,recordDigest,tx.now,JSON.stringify(wrapper)]),true);}catch(error){if(error===null||typeof error!=='object'||!('code' in error)||error.code!=='42501')throw error;insertion='DENIED';}
  if(!normal&&insertion==='ADMITTED'){await expect(journal.lookup(input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});await expect(journal.append(input,sealed!.facts)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});}
  console.info(JSON.stringify({w4b2CalculationBreakdown:{variant,insertion,originalUsd:original.actualUsd,originalExact:original.exactTotalUsd,actualUsd:value.actualUsd,exactTotalUsd:value.exactTotalUsd,factsPreserved:true,wrapperDigestRecomputed:true,versionGuardsUnchanged:true}}));
  expect(insertion,'원 C2 계산 내역과 다른 보호 계산 행은 worker INSERT에서 42501로 거부해야 한다').toBe(normal?'ADMITTED':'DENIED');
  if(!normal){expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CALCULATION'",[f.seed.accountId,input.executionId])).rows).toEqual([{n:0}]);expect((await journal.lookup(input)).state).toBe('UNCONFIRMED');expect((await journal.append(input,sealed!.facts)).view.state).toBe('CONFIRMED');}
  const view=await journal.lookup(input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe(expectedUsd);expect(view.calculations).toHaveLength(1);expect(digest(view.calculations[0].result)).toBe(digest(original));
  const before=await costsSnapshot(f);expect((await journal.append(input,sealed!.facts)).appended).toBe(false);expect(await costsSnapshot(f)).toEqual(before);expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE') closures,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses WHERE account_id=$1 AND execution_id=$2) expenses",[f.seed.accountId,input.executionId])).rows).toEqual([{closures:0,expenses:0}]);
}),120000);

const b2SignedRoundingCases=[
  {name:'ZERO_HALF_UP',ticks:'0',rate:'0.000000000001',rounding:'HALF_UP',quantity:'0',exact:'0',actual:'0.000000000000'},
  {name:'MIN_HALF_UP',ticks:'1',rate:'0.000000000001',rounding:'HALF_UP',quantity:'0.0000001',exact:'0.0000000000000000001',actual:'0.000000000000'},
  {name:'MIN_UP',ticks:'1',rate:'0.000000000001',rounding:'UP',quantity:'0.0000001',exact:'0.0000000000000000001',actual:'0.000000000001'},
  {name:'BELOW_HALF_UP',ticks:'1',rate:'0.000004999999',rounding:'HALF_UP',quantity:'0.0000001',exact:'0.0000000000004999999',actual:'0.000000000000'},
  {name:'TIE_HALF_UP',ticks:'1',rate:'0.000005',rounding:'HALF_UP',quantity:'0.0000001',exact:'0.0000000000005',actual:'0.000000000001'},
  {name:'ABOVE_HALF_UP',ticks:'1',rate:'0.000005000001',rounding:'HALF_UP',quantity:'0.0000001',exact:'0.0000000000005000001',actual:'0.000000000001'},
] as const;
it.each(b2SignedRoundingCases)('W4-B2 calculation exact signed rounding $name matches original C2 before protected append',async test=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:test.ticks,kernelTime100ns:'0'}),facts=await originalFacts(f,x.owner,native.key);expect(facts.accounting).not.toBeNull();expect(facts.accounting!.value.userTime100ns).toBe(test.ticks);expect(facts.accounting!.value.kernelTime100ns).toBe('0');
  const ready=await zeroWindowsWork(f,x),{cost,journal}=windowsCost(f,ready.basis,ready.reader);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await journal.lookup(x.execution.input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe(test.actual);expect(view.calculations).toHaveLength(1);const result=view.calculations[0].result;
  expect(result.snapshot!.rounding).toBe(test.rounding);expect(result.snapshot!.components[0].usdPerUnit).toBe(test.rate);expect(result.facts.quantities).toEqual([expect.objectContaining({componentId:'native-image',quantity:test.quantity})]);expect(result.exactTotalUsd).toBe(test.exact);expect(result.actualUsd).toBe(test.actual);const calculated=new FullStageCostCalculator(ready.basis.snapshot,calculatorBounds).calculate({accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint,stage:ready.basis.capture.stage,profileDigest:ready.basis.capture.profileDigest,mode:ready.basis.capture.mode},structuredClone(result.facts) as OperationalStageCostWorkSet['facts']);expect(digest(result)).toBe(digest(calculated));
  const amounts=(await f.admin.pool.query("SELECT protected_observation->'value'->>'actualUsd' actual_usd,protected_observation->'value'->>'exactTotalUsd' exact_total FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CALCULATION'",[f.seed.accountId,x.owner.executionId])).rows;expect(amounts).toEqual([{actual_usd:test.actual,exact_total:test.exact}]);const before=await costsSnapshot(f);await cost.finishAttempt(x.execution.input);await cost.idle();expect(await costsSnapshot(f)).toEqual(before);
  console.info(JSON.stringify({w4b2SignedRounding:{name:test.name,originalKey:native.key,accounting:facts.accounting,quantity:test.quantity,rate:test.rate,rounding:test.rounding,exactTotalUsd:result.exactTotalUsd,actualUsd:result.actualUsd,sourceAndRatePreparedBeforeOriginalCapture:true}}));
},f=>prepareWithBasis(f,snapshot=>({...snapshot,rounding:test.rounding,components:snapshot.components.map(rate=>({...rate,usdPerUnit:test.rate}))}))),120000);

const b2BreakdownFieldCases=['PROVIDER_EVIDENCE_ORDER','ALLOCATION_FUNDING','ALLOCATION_EXACT_USD','COMPONENT_KIND','COMPONENT_EXACT_USD','RATE_EVIDENCE_ORDER','QUANTITY_EVIDENCE_ORDER','COMPONENT_ARRAY_ORDER'] as const;
it.each(b2BreakdownFieldCases)('W4-B2 calculation exact full breakdown %s cannot poison original protected C2 history',async variant=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const native=[],operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name);for(let index=0;index<2;index++){const original=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'0'});native.push(original);const proof=await operator.confirmWindows(original.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,original.key.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});}const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),{cost,journal}=windowsCost(f,ready.basis,ready.reader);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await journal.lookup(x.execution.input);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.040000000000');expect(view.calculations).toHaveLength(1);const original=view.calculations[0].result,first=original.breakdown.components[0];expect(original.breakdown.components).toHaveLength(2);expect(first.componentId).toBe('native-image');expect(first.rateEvidenceRefs).toHaveLength(2);expect(first.quantityEvidenceRefs).toHaveLength(2);expect(original.breakdown.provider.evidenceRefs.length).toBeGreaterThan(1);
  // 변경 대상은 저장된 계산 내역 한 필드/배열이다. 원 단가·사용량·원서명은 보존한다.
  const changed=variant==='COMPONENT_KIND'?{...first,kind:'STORAGE' as const}:variant==='COMPONENT_EXACT_USD'?{...first,exactUsd:'0.020'}:variant==='RATE_EVIDENCE_ORDER'?{...first,rateEvidenceRefs:[...first.rateEvidenceRefs].reverse()}:variant==='QUANTITY_EVIDENCE_ORDER'?{...first,quantityEvidenceRefs:[...first.quantityEvidenceRefs].reverse()}:first;
  const value={...original,breakdown:{...original.breakdown,provider:variant==='PROVIDER_EVIDENCE_ORDER'?{...original.breakdown.provider,evidenceRefs:[...original.breakdown.provider.evidenceRefs].reverse()}:original.breakdown.provider,allocation:variant==='ALLOCATION_FUNDING'?{...original.breakdown.allocation,funding:'PAID_PROCESSING' as const}:variant==='ALLOCATION_EXACT_USD'?{...original.breakdown.allocation,exactUsd:'0.000'}:original.breakdown.allocation,components:variant==='COMPONENT_ARRAY_ORDER'?[...original.breakdown.components].reverse():[changed,...original.breakdown.components.slice(1)]}};
  expect(value.facts).toEqual(original.facts);expect(value.snapshot).toEqual(original.snapshot);expect(value.actualUsd).toBe(original.actualUsd);expect(value.exactTotalUsd).toBe(original.exactTotalUsd);expect(digest(value)).not.toBe(digest(original));const wrapper={version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint,kind:'OPERATIONAL_COST_CALCULATION',value},id=randomUUID(),before=await costsSnapshot(f);
  await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_CALCULATION',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,id,x.owner.executionId,digest(wrapper),tx.now,JSON.stringify(wrapper)]),true)).rejects.toMatchObject({code:'42501'});
  expect(await costsSnapshot(f)).toEqual(before);const recovered=await journal.lookup(x.execution.input);expect(recovered.state).toBe('CONFIRMED');expect(recovered.costUsd).toBe('0.040000000000');expect(recovered.calculations).toHaveLength(1);expect(digest(recovered.calculations[0].result)).toBe(digest(original));expect((await journal.append(x.execution.input,structuredClone(original.facts) as OperationalStageCostWorkSet['facts'])).appended).toBe(false);expect(await costsSnapshot(f)).toEqual(before);console.info(JSON.stringify({w4b2ExactBreakdown:{variant,signedOriginals:native.map(row=>row.key),amount:'0.040000000000',mutatedRows:0,originalResultDigest:digest(original),candidateResultDigest:digest(value)}}));
},f=>prepareWithBasis(f,snapshot=>({...snapshot,components:[{...snapshot.components[0],evidenceRefs:['owned-fixture:w4b2/rate-z','owned-fixture:w4b2/rate-a']},{...snapshot.components[0],componentId:'unused-render',kind:'RENDER',evidenceRefs:['owned-fixture:w4b2/unused']}]}),[{task:'DECODE_IMAGE',componentId:'native-image'},{task:'RENDER_PAGE',componentId:'unused-render'}])),120000);

// Temp 초안이다. 고정 PG 사본에 가상으로 결합해 타입만 검사한다.
// 제품 수정·repo 통합·PG 실행·인수 통과를 뜻하지 않는다.
type B201Ready=Awaited<ReturnType<typeof zeroWindowsWork>>;
type B201Projection={key_body:Record<string,unknown>;kind:'NATIVE'|'ABSENCE';component_id:string;job_id:string|null;operation_id:string;operation_digest:string;operation_body:{kind:string;value:Record<string,unknown>};termination_id:string;termination_digest:string;termination_body:{kind:string;value:Record<string,unknown>}};
type B201Control={work:OperationalStageCostWorkSet;raw:Census;projections:B201Projection[]};

async function b201Raw(f:WindowsNativeFixture,x:Prepared){
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();
  expect(raw!.manifest).toEqual(manifest(raw!.rows));expect(raw!.rawSetDigest).toBe(digest(raw!.manifest));return raw!;
}
async function b201Inventory(f:WindowsNativeFixture,x:Prepared,raw:Census){
  // consumer의 owner/profile/state 필터와 분리한 관리자 원표 대조다.
  // 사례별 격리 계정만 읽으며 다른 계정은 조사하지 않는다.
  const params=[f.seed.accountId,x.owner.executionId],intents=(await f.admin.pool.query('SELECT job_id,parent_instance_id,target_kind,target_id,profile_digest,intent_digest,protected_intent FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows;
  const reservations=(await f.admin.pool.query('SELECT reservation_id,job_id,state,profile_id,profile_digest,base_execution_id,source_execution_id,source_input_evidence_id,release_proof_id,windows_release_proof_id,(SELECT count(*)::integer FROM manga_web.native_capacity_termination_proofs p WHERE p.account_id=r.account_id AND p.reservation_id=r.reservation_id AND p.proof_id=r.release_proof_id) release_proofs,(SELECT count(*)::integer FROM manga_web.windows_native_termination_proofs p WHERE p.account_id=r.account_id AND p.reservation_id=r.reservation_id AND p.proof_id=r.windows_release_proof_id) windows_release_proofs FROM manga_web.native_capacity_reservations r WHERE account_id=$1 ORDER BY reservation_id',[f.seed.accountId])).rows;
  const evidence=(await f.admin.pool.query('SELECT evidence_id,evidence_digest,kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN(\'WINDOWS_NATIVE_OPERATION\',\'WINDOWS_NATIVE_TERMINATION\') ORDER BY evidence_id',params)).rows;
  const starts=(await f.admin.pool.query('SELECT operation_id,event_id,evidence_id,evidence_digest,protected_request FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2 ORDER BY operation_id',params)).rows;
  const ends=(await f.admin.pool.query('SELECT e.operation_id,e.evidence_id,e.evidence_digest,e.protected_event FROM manga_web.windows_native_cost_io_ends e JOIN manga_web.windows_native_cost_io_starts s USING(account_id,operation_id) WHERE s.account_id=$1 AND s.execution_id=$2 ORDER BY operation_id',params)).rows;
  const queries=(await f.admin.pool.query('SELECT request_id,job_id,evidence_id,evidence_digest,protected_request,authority FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1 AND execution_id=$2 ORDER BY request_id',params)).rows;
  const claims=(await f.admin.pool.query('SELECT q.request_id,c.claim_id FROM manga_web.windows_native_cost_result_queries q JOIN manga_web.windows_native_cost_result_claims c USING(account_id,request_id) WHERE q.account_id=$1 AND q.execution_id=$2 ORDER BY request_id',params)).rows;
  const acks=(await f.admin.pool.query('SELECT q.request_id,a.evidence_id,a.evidence_digest,a.response_ref FROM manga_web.windows_native_cost_result_queries q JOIN manga_web.windows_native_cost_result_acks a USING(account_id,request_id) WHERE q.account_id=$1 AND q.execution_id=$2 ORDER BY request_id',params)).rows;
  const cache=(await f.admin.pool.query('SELECT u.call_id,u.job_id,u.evidence_id,u.evidence_digest,u.protected_source FROM manga_web.windows_native_cost_cache_uses u JOIN manga_web.windows_native_cost_calls c USING(account_id,call_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY u.call_id,u.job_id',params)).rows;
  const refs=(kind:string)=>raw.rows.filter(row=>row.kind===kind).map(row=>({id:row.id,ref:row.ref})),ref=(row:{evidence_id:string;evidence_digest:string})=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest});
  expect(raw.rows.filter(row=>row.kind==='INTENT').map(row=>({id:row.id,digest:row.contentDigest}))).toEqual(intents.map(row=>({id:row.job_id,digest:row.intent_digest})));
  expect(refs('RESERVATION')).toEqual(reservations.map(row=>({id:row.reservation_id,ref:null})));
  for(const row of evidence)expect(raw.rows).toContainEqual(expect.objectContaining({kind:'EVIDENCE',id:row.evidence_id,ref:ref(row),contentDigest:row.evidence_digest}));
  expect(refs('IO_START')).toEqual(starts.map(row=>({id:row.operation_id,ref:ref(row)})));expect(refs('IO_END')).toEqual(ends.map(row=>({id:row.operation_id,ref:ref(row)})));
  expect(refs('RESULT_QUERY')).toEqual(queries.map(row=>({id:row.request_id,ref:ref(row)})));expect(refs('RESULT_CLAIM')).toEqual(claims.map(row=>({id:row.request_id,ref:null})));expect(refs('RESULT_ACK')).toEqual(acks.map(row=>({id:row.request_id,ref:ref(row)})));
  expect(refs('CACHE_USE')).toEqual(cache.map(row=>({id:row.call_id+'/'+row.job_id,ref:ref(row)})));
  expect(raw.originals).toHaveLength(new Set([...intents.map(row=>row.job_id),...reservations.map(row=>row.job_id),...queries.map(row=>row.job_id),...cache.map(row=>row.job_id)]).size);
  return {intents,reservations,evidence,starts,ends,queries,claims,acks,cache,rawRefs:raw.rows.map(row=>({kind:row.kind,id:row.id,ref:row.ref,contentDigest:row.contentDigest})),originals:raw.originals};
}
async function b201Control(f:WindowsNativeFixture,x:Prepared,ready:B201Ready):Promise<B201Control>{
  expect(await f.service.renew(x.execution.claim)).toBe(true);const work=await ready.reader.prepareCandidate(x.execution.input,ready.basis);expect(work).not.toBeNull();const raw=await b201Raw(f,x),candidate=await sqlCandidate(f,x,work!,ready.work);
  const rollback=new Error('B201_CONTROL_SEAL_ROLLBACK');let returned=false;
  try{await f.worker.accountTransaction(f.seed.accountId,async tx=>{const reply=(await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value;expect(reply).not.toBeNull();const sameTx=(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,4096) value',[JSON.stringify({version:1,mode:'SEALED',owner:selector(x.owner)})])).rows[0].value;expect(sameTx).toEqual(reply);returned=true;throw rollback;},true);}catch(error){if(error!==rollback)throw error;}
  expect(returned).toBe(true);expect(Object.values(await b2SplitCounts(f))).toEqual([0,0,0,0,0,0]);
  const projections=(await f.admin.pool.query<B201Projection>('SELECT key_body,kind,component_id,job_id,operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND raw_set_digest=$3 ORDER BY operation_id',[f.seed.accountId,x.owner.executionId,raw.rawSetDigest])).rows;expect(projections.length).toBeGreaterThan(0);return {work:work!,raw,projections};
}
async function b201ImportIntent(f:WindowsNativeFixture,intent:Prepared['original']['intent']){
  // 격리 DB의 관리자 저장소 결함 주입이다. worker의 정상 허가 양성이 아니다.
  // trigger 변경과 INSERT는 같은 거래에서 종료되며 원 표 정의는 복구한다.
  await f.admin.transaction(async client=>{await client.query('ALTER TABLE manga_web.native_job_intents DISABLE TRIGGER windows_native_cost_intent_guard');await client.query("INSERT INTO manga_web.native_job_intents(account_id,job_id,owner_service,parent_instance_id,task,task_version,profile_digest,input_digest,operation_input_digest,target_kind,target_id,semantic_capture_digest,logical_operation_key,protected_intent,intent_digest,created_at) VALUES($1,$2,'trio_web_worker',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp())",[f.seed.accountId,intent.jobId,intent.parentInstanceId,intent.task,intent.taskVersion,intent.profileDigest,intent.inputDigest,intent.operationInputDigest,intent.targetKind,intent.targetId,intent.semanticCaptureDigest,intent.logicalOperationKey,JSON.stringify(intent),digest(intent)]);await client.query('ALTER TABLE manga_web.native_job_intents ENABLE TRIGGER windows_native_cost_intent_guard');});return intent;
}
async function b201AdminIntent(f:WindowsNativeFixture,x:Prepared,otherProfile=false){
  const original=await f.originalIntent(x.execution),{logicalOperationKey:_key,...old}=original.intent,body={...old,jobId:randomUUID(),parentInstanceId:randomUUID(),profileDigest:otherProfile?sha256('B201 other immutable profile'):old.profileDigest},intent={...body,logicalOperationKey:nativeLogicalOperationKey(body)};return b201ImportIntent(f,intent);
}
async function b201CoherentDirect(f:WindowsNativeFixture,x:Prepared,ready:B201Ready,control:B201Control,raw:Census){
  const work=structuredClone(control.work),replace=new Map<string,Ref>(),ids=new Map<string,{operationId:string;eventId:string}>();
  // 관리자 공격으로 최신 digest와 본문·해시·참조가 일치하는 projection을 만든다.
  // 옛 membership/absence의 stale 거부를 전체 집합 방어로 잘못 세지 않는다.
  // 원 INPUT/BASIS·B1 binding·서명된 Windows source는 보존한다.
  for(const p of control.projections){
    const key={...structuredClone(p.key_body),rawSetDigest:raw.rawSetDigest},op=structuredClone(p.operation_body),term=structuredClone(p.termination_body),operationId=p.kind==='NATIVE'?p.operation_id:randomUUID(),terminationId=p.kind==='NATIVE'?p.termination_id:randomUUID();
    if(p.kind==='ABSENCE'){const proof={...op.value,rawSetDigest:raw.rawSetDigest,operationId:randomUUID(),eventId:randomUUID()};ids.set(String(op.value.operationId),{operationId:proof.operationId,eventId:proof.eventId});op.value=proof;term.value=structuredClone(proof);}
    const operationDigest=digest(op),terminationDigest=digest(term);if(p.kind==='NATIVE'){expect(operationId).toBe(p.operation_id);expect(terminationId).toBe(p.termination_id);expect(operationDigest).toBe(p.operation_digest);expect(terminationDigest).toBe(p.termination_digest);}replace.set(p.operation_id,{evidenceId:operationId,evidenceDigest:operationDigest});replace.set(p.termination_id,{evidenceId:terminationId,evidenceDigest:terminationDigest});
    await f.admin.transaction(async client=>{
      await client.query('INSERT INTO manga_web.windows_stage_cost_projections(account_id,execution_id,key_digest,key_body,kind,component_id,job_id,raw_set_digest,operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $5=\'NATIVE\' THEN (SELECT received_at FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$9) ELSE clock_timestamp() END)',[f.seed.accountId,x.owner.executionId,digest(key),JSON.stringify(key),p.kind,p.component_id,p.job_id,raw.rawSetDigest,operationId,operationDigest,JSON.stringify(op),terminationId,terminationDigest,JSON.stringify(term)]);
      await client.query(`INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
        SELECT account_id,operation_id,execution_id,operation_body->>'kind',operation_digest,operation_id::text,created_at,operation_body FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND key_digest=$3
        UNION ALL SELECT account_id,termination_id,execution_id,termination_body->>'kind',termination_digest,termination_id::text,created_at,termination_body FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND key_digest=$3
        ON CONFLICT(account_id,execution_id,kind,evidence_digest) DO NOTHING`,[f.seed.accountId,x.owner.executionId,digest(key)]);
    });
  }
  const map=(r:Ref)=>replace.get(r.evidenceId)??r;work.joinedEvidence=work.joinedEvidence.map(map);work.terminationEvidence=work.terminationEvidence.map(map);
  for(const source of work.sources){source.evidence=source.evidence.map(map);const changed=ids.get(source.sourceOperationId);if(changed){source.sourceOperationId=changed.operationId;source.sourceEventId=changed.eventId;}}
  for(const fact of [work.facts.provider,work.facts.allocation,...work.facts.quantities!])if(fact)fact.evidenceRefs=fact.evidenceRefs.map(id=>replace.get(id)?.evidenceId??id);
  const latest=await b201Raw(f,x);expect(latest.rawSetDigest).toBe(raw.rawSetDigest);const candidate=await sqlCandidate(f,x,work,ready.work);expect(candidate.rawSetDigest).toBe(latest.rawSetDigest);
  const projections=(await f.admin.pool.query<{operation_id:string;operation_digest:string;operation_body:unknown;termination_id:string;termination_digest:string;termination_body:unknown;key_body:unknown;key_digest:string}>('SELECT operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body,key_body,key_digest FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND raw_set_digest=$3 ORDER BY operation_id',[f.seed.accountId,x.owner.executionId,latest.rawSetDigest])).rows;
  expect(projections).toHaveLength(control.projections.length);for(const p of projections){expect(digest(p.operation_body)).toBe(p.operation_digest);expect(digest(p.termination_body)).toBe(p.termination_digest);expect(digest(p.key_body)).toBe(p.key_digest);expect(candidate.workSet.joinedEvidence).toContainEqual({evidenceId:p.operation_id,evidenceDigest:p.operation_digest});expect(candidate.workSet.terminationEvidence).toContainEqual({evidenceId:p.termination_id,evidenceDigest:p.termination_digest});}
  return candidate;
}
async function b201Reject(f:WindowsNativeFixture,x:Prepared,ready:B201Ready,control:B201Control,label:string,absenceExpected:'NULL'|'CPU_ZERO'='NULL'){
  expect(await f.service.renew(x.execution.claim)).toBe(true);const raw=await b201Raw(f,x),inventory=await b201Inventory(f,x,raw),prepared=await ready.reader.prepareCandidate(x.execution.input,ready.basis),inTx=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.candidateIn(tx,x.execution.input,ready.basis),true),candidate=await b201CoherentDirect(f,x,ready,control,raw),seal=await b2CoverageSeal(f,x,candidate);
  const {cost}=windowsCost(f,ready.basis,ready.reader);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true),counts=await b2SplitCounts(f),absence=await project(f,x.owner,{version:1,kind:'ABSENCE',componentId:'native-image',rawSetDigest:raw.rawSetDigest,basisRef:x.owner.basisRef});
  console.info(JSON.stringify({w4b2B201:{label,adminFaultProjection:true,inventory,reader:prepared===null?'WAIT':'CANDIDATE',candidateIn:inTx===null?'WAIT':'CANDIDATE',rawSetDigest:raw.rawSetDigest,membershipDigest:candidate.membershipDigest,sqlSeal:seal,absence,view:{state:view.state,costUsd:view.costUsd,calculations:view.calculations},counts}}));
  expect(prepared).toBeNull();expect(inTx).toBeNull();expect(seal).toBeNull();expect(view.state).toBe('UNCONFIRMED');expect(view.costUsd).toBeNull();expect(Object.values(counts)).toEqual([0,0,0,0,0,0]);
  if(absenceExpected==='NULL')expect(absence).toBeNull();else expect(absence).toMatchObject({value:{quantity:'0'}});return {raw,inventory};
}

it.each(['UNBOUND_EXECUTION','OTHER_PROFILE','UNPROVEN_RELEASED'] as const)('W4-B2 B201 whole footprint %s cannot disappear before current candidate public seal or CLOSURE',async kind=>withPrepared(async(f,x)=>{
  // RELEASED 공격에는 같은 root의 정상 signed 원 작업과 원 proof를 완전히 포함한다.
  // 새 raw가 다른 reservation의 proof를 가리키므로 FK는 유효하고 자기 종료 proof는 없다.
  let releaseControl:{jobId:string;reservationId:string;proofId:string}|null=null;
  if(kind==='UNPROVEN_RELEASED'){expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const original=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'0'}),operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name),proof=await operator.confirmWindows(original.key);expect(proof.allowed).toBe(true);expect(await operator.releaseWindows(f.seed.accountId,original.key.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});releaseControl={jobId:original.key.binding.jobId,reservationId:original.key.binding.capacityReservationId,proofId:proof.proofId!};}
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),intent=await b201AdminIntent(f,x,kind==='OTHER_PROFILE');
  if(kind==='UNPROVEN_RELEASED')await f.admin.pool.query(`INSERT INTO manga_web.native_capacity_reservations(account_id,reservation_id,job_id,adoption_id,owner_service,profile_id,profile_digest,profile_version,execution_profile_id,root_kind,base_execution_id,source_execution_id,source_input_evidence_id,reserved_at,state,released_at,windows_release_proof_id)
    SELECT $1,$2,$3,$4,'trio_web_worker',$5,$6,$7,(SELECT current_profile_id FROM manga_web.execution_limit_authority WHERE singleton),'EXECUTION',$8,$8,$9,clock_timestamp(),'RELEASED',clock_timestamp(),$10 FROM manga_web.execution_capacity_permits p WHERE p.account_id=$1 AND p.execution_id=$8`,[f.seed.accountId,randomUUID(),intent.jobId,randomUUID(),x.capacity.reference.profileId,x.capacity.reference.profileDigest,x.capacity.reference.profileVersion,x.owner.executionId,x.owner.inputEvidenceId,releaseControl!.proofId]);
  const {inventory,raw}=await b201Reject(f,x,ready,control,kind),originals=raw.originals as {classification:string;key:WindowsNativeOriginalKey|null}[];expect(inventory.intents).toHaveLength(releaseControl?2:1);expect(inventory.intents.some(row=>row.job_id===intent.jobId)).toBe(true);expect(originals.filter(row=>row.classification==='UNCONFIRMED')).toEqual([expect.objectContaining({classification:'UNCONFIRMED',key:null})]);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_bindings WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:releaseControl?1:0}]);
  if(kind==='OTHER_PROFILE')expect(inventory.intents[0].profile_digest).not.toBe(x.capacity.profile.nativeProfileDigest);
  if(releaseControl){expect(inventory.reservations).toHaveLength(2);expect(inventory.reservations.find(row=>row.job_id===intent.jobId)).toMatchObject({job_id:intent.jobId,state:'RELEASED',release_proof_id:null,windows_release_proof_id:releaseControl.proofId,release_proofs:0,windows_release_proofs:0});expect(inventory.reservations.find(row=>row.job_id===releaseControl.jobId)).toMatchObject({reservation_id:releaseControl.reservationId,state:'RELEASED',release_proof_id:null,windows_release_proof_id:releaseControl.proofId,release_proofs:0,windows_release_proofs:1});expect(originals.filter(row=>row.classification==='FRESH')).toHaveLength(1);expect(control.work.facts.quantities).toEqual([expect.objectContaining({componentId:'native-image',quantity:'1'})]);expect(control.raw.originals).toHaveLength(1);}else expect(inventory.reservations).toEqual([]);
}),120000);

it.each(['WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION'] as const)('W4-B2 B201 missing original %s rejects the latest full membership while preserving surviving signed sources',async kind=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const native=await nativeOriginal(f,x,'CREATED',{userTime100ns:'10000000',kernelTime100ns:'0'}),ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),before=await b201Inventory(f,x,control.raw);
  const lost=before.evidence.find(row=>row.kind===kind)!;expect(lost).toBeDefined();expect((await f.admin.pool.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3 RETURNING evidence_id,evidence_digest',[f.seed.accountId,x.owner.executionId,lost.evidence_id])).rows).toEqual([{evidence_id:lost.evidence_id,evidence_digest:lost.evidence_digest}]);
  const {inventory,raw}=await b201Reject(f,x,ready,control,kind);expect(inventory.evidence).toEqual(before.evidence.filter(row=>row.kind!==kind));expect(inventory.evidence).toHaveLength(1);expect(raw.originals).toEqual([expect.objectContaining({classification:'UNCONFIRMED'})]);
  expect(await lookup(f,{version:1,mode:'ORIGINAL',owner:x.owner,key:native.key})).toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_links WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:1}]);
}),120000);

it('W4-B2 B201 created suspended without GO remains unknown and cannot use a no-child or zero-cost seal',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),native=await b2RaceAdmit(f,x,call),open=await b2RaceOpen(f,x,native,'CREATED');
  const {raw}=await b201Reject(f,x,ready,control,'CREATED_NO_GO');const events=(await f.admin.pool.query('SELECT kind,protected_event,protected_source FROM manga_web.windows_native_events WHERE account_id=$1 AND attempt_id=$2 ORDER BY sequence',[f.seed.accountId,open.capture.origin.authority.attemptId])).rows;
  expect(events.some(row=>row.kind==='CREATED_SUSPENDED')).toBe(true);expect(events.some(row=>row.kind==='GO_WRITE'||row.kind==='GO_AUTHORIZED'||row.kind==='FINAL_ACCOUNTING')).toBe(false);expect(raw.rows.filter(row=>['GO_GRANT','GO_CONSUMPTION','RAW_RESULT','WINDOWS_LINK'].includes(row.kind))).toEqual([]);
  expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')",[f.seed.accountId])).rows).toEqual([{n:0}]);
}),120000);

it('W4-B2 B201 actual unfinished I/O keeps CPU absence distinct from incomplete total cost and seals after real END JOIN',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.call.callId,callDigest:call.call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,request),true)).toMatchObject({state:'UNCONFIRMED',operationId:request.operationId,eventId:request.eventId});const {inventory}=await b201Reject(f,x,ready,control,'UNFINISHED_IO','CPU_ZERO');expect(inventory.starts).toHaveLength(1);expect(inventory.ends).toEqual([]);
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)});expect((await io.receipt(request)).state).toBe('RETURNED');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!)),true)).toBe('JOINED');await b2RaceAddIoFacts(f,x,ready.work);
  expect(await f.service.renew(x.execution.claim)).toBe(true);const fresh=await ready.reader.prepareCandidate(x.execution.input,ready.basis);expect(fresh).not.toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.sealIn(tx,x.execution.input,ready.basis,fresh!),true)).not.toBeNull();const after=await b201Inventory(f,x,await b201Raw(f,x));expect(after.starts).toHaveLength(1);expect(after.ends).toHaveLength(1);
}),120000);

function b201Cpu(ticks:bigint){const whole=ticks/10000000n,fraction=(ticks%10000000n).toString().padStart(7,'0').replace(/0+$/,'');return whole.toString()+(fraction?'.'+fraction:'');}
function b201Usd(ticks:bigint,providerCents=2n){const scaled=ticks*1000n+providerCents*10000000000n;return (scaled/1000000000000n).toString()+'.'+(scaled%1000000000000n).toString().padStart(12,'0');}
async function b201CompletedProjection(f:WindowsNativeFixture,x:Prepared,native:Awaited<ReturnType<typeof b2RaceAdmit>>,finished:Awaited<ReturnType<typeof b2RaceFinish>>,ready:B201Ready){
  const facts=await originalFacts(f,x.owner,finished.key),raw=await b201Raw(f,x);expect(facts.accounting).not.toBeNull();const accounting=facts.accounting!,ticks=BigInt(accounting.value.userTime100ns)+BigInt(accounting.value.kernelTime100ns),quantity=b201Cpu(ticks),scopeRef={evidenceId:native.scope.scopeId,evidenceDigest:native.scope.scopeDigest},callRef={evidenceId:native.call.callId,evidenceDigest:native.call.callDigest},base={version:1,accountId:f.seed.accountId,executionId:x.owner.executionId,inputDigest:x.execution.input.inputDigest,inputFingerprint:x.owner.inputFingerprint};
  const key={version:1,kind:'NATIVE',originalKey:finished.key,scopeRef,callRef,componentId:'native-image',rawSetDigest:raw.rawSetDigest},operation={...base,kind:'WINDOWS_NATIVE_COST_ATTRIBUTION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceOperation:finished.bridge.operation,sourceTermination:finished.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,sourceOperationId:facts.binding.jobId,sourceEventId:accounting.event.eventId,accounting,quantity,unit:'windows-job-cpu-second-v1'}},termination={...base,kind:'WINDOWS_NATIVE_COST_TERMINATION',value:{version:1,owner:x.owner,scopeRef,callRef,componentId:'native-image',source:facts.source,jobId:facts.binding.jobId,sourceTermination:finished.bridge.termination,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,termination:facts.termination}},projected=await project<{operation:Ref;termination:Ref}>(f,x.owner,key,operation,termination);expect(projected).not.toBeNull();
  const work=structuredClone(ready.work);work.joinedEvidence.push(projected!.operation);work.terminationEvidence.push(projected!.termination);work.sources.push({sourceOperationId:facts.binding.jobId,sourceEventId:accounting.event.eventId,target:'QUANTITY',componentId:'native-image',evidence:[projected!.operation]});work.facts.quantities!.push({componentId:'native-image',captureDigest:ready.basis.captureDigest,state:'CONFIRMED',quantity,unit:'windows-job-cpu-second-v1',evidenceRefs:[projected!.operation.evidenceId]});
  const projections=(await f.admin.pool.query<B201Projection>('SELECT key_body,kind,component_id,job_id,operation_id,operation_digest,operation_body,termination_id,termination_digest,termination_body FROM manga_web.windows_stage_cost_projections WHERE account_id=$1 AND execution_id=$2 AND raw_set_digest=$3 ORDER BY operation_id',[f.seed.accountId,x.owner.executionId,raw.rawSetDigest])).rows;expect(projections).toHaveLength(1);return {work,raw,projections,ticks};
}

it('W4-B2 B201 actual pending result QUERY ACK is enumerated after signed native TERM and completes only after real claim GET ACK JOIN',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'});await b201Control(f,x,ready);const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),native=await b2RaceAdmit(f,x,call),open=await b2RaceOpen(f,x,native,'CREATED'),finished=await b2RaceFinish(f,x,native,open);await b2RaceAddIoFacts(f,x,ready.work);const control=await b201CompletedProjection(f,x,native,finished,ready),query={control:{version:2 as const,requestId:randomUUID(),binding:native.binding,command:'QUERY' as const,includeRawResult:true as const}};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,native.call,query),true)).not.toBeNull();const {inventory,raw}=await b201Reject(f,x,ready,control,'UNFINISHED_QUERY');expect(inventory.queries).toHaveLength(1);expect(inventory.claims).toEqual([]);expect(inventory.acks).toEqual([]);expect(raw.originals).toEqual([expect.objectContaining({classification:'FRESH'})]);
  await b2RaceQueryAck(f,x,native,finished,query);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!,[finished.bridge.operation!,finished.bridge.termination!])),true)).toBe('JOINED');await b2RaceAddIoFacts(f,x,ready.work);expect(await f.service.renew(x.execution.claim)).toBe(true);const fresh=await ready.reader.prepareCandidate(x.execution.input,ready.basis);expect(fresh).not.toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.sealIn(tx,x.execution.input,ready.basis,fresh!),true)).not.toBeNull();const after=await b201Inventory(f,x,await b201Raw(f,x));expect(after.queries).toHaveLength(1);expect(after.claims).toHaveLength(1);expect(after.acks).toHaveLength(1);
}),120000);

it('W4-B2 B201 imported schema v1 legacy CACHE stays visible without Windows original authority and cannot become absence',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),intent=await b201ImportIntent(f,call.intent),bytes=Buffer.from(ownedNativePng,'base64'),blob={blobId:'canonical-png',assetId:randomUUID(),sha256:sha256(bytes),bytesLength:String(bytes.length)},result=createNativeResult(call.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs:new Map([['canonical-png',bytes]])},windowsFrameLimits);
  const receipt=await f.files.put(f.seed.accountId+'/'+blob.assetId,bytes);expect(await f.files.read(receipt.key)).toEqual(bytes);
  // 실제 파일 bytes/receipt와 닫힌 v1 원 DTO를 저장소에 관리자 주입한다.
  // 원 v1 writer의 정상 허가·생산자 실행 증거로 확대하지 않는다.
  const termination={jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'},observationId=randomUUID(),observation={version:1,parentInstanceId:intent.parentInstanceId,event:'RESULT',code:'OK',resultDigest:digest(result),termination:{...termination,isolation:'OWNED_FIXTURE'}};
  const observationDigest=await f.admin.transaction(async client=>{await client.query('INSERT INTO manga_web.native_job_go_consumptions(account_id,job_id,parent_instance_id,consumed_at) VALUES($1,$2,$3,clock_timestamp())',[f.seed.accountId,intent.jobId,intent.parentInstanceId]);return (await client.query("INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES($1,$2,$3,$4,'RESULT',encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'),$5,clock_timestamp()) RETURNING observation_digest",[f.seed.accountId,observationId,intent.jobId,intent.parentInstanceId,JSON.stringify(observation)])).rows[0].observation_digest as string;});
  const {inputDigest:_inputDigest,...withoutInputDigest}=call.frame.envelope,candidate={version:1,candidateId:randomUUID(),jobId:intent.jobId,parentInstanceId:intent.parentInstanceId,operationInputDigest:intent.operationInputDigest,kernelImplementationDigest:f.profile.kernelDigest,verificationVersion:'native-facade-verification-v1',resultObservationId:observationId,resultObservationDigest:observationDigest,resultDigest:digest(result),inputCanonical:canonicalize(withoutInputDigest),resultCanonical:canonicalize(result),blobs:[blob]},proof={version:1,candidateId:candidate.candidateId,kernelImplementationDigest:f.profile.kernelDigest,verificationVersion:'native-facade-verification-v1',blobs:[{blobId:blob.blobId,receipt}]},source={candidate,receipt:proof,intent,termination,origin:'CACHE'};
  await f.admin.transaction(async client=>{await client.query("INSERT INTO manga_web.native_result_candidates(account_id,candidate_id,job_id,parent_instance_id,operation_input_digest,kernel_implementation_digest,verification_version,result_observation_id,protected_candidate,source_asset_dependencies,candidate_digest,asset_purpose,related_context_id,access_deadline,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]',encode(sha256(convert_to(($9::jsonb)::text,'UTF8')),'hex'),'LIVE',$10,NULL,clock_timestamp())",[f.seed.accountId,candidate.candidateId,intent.jobId,intent.parentInstanceId,intent.operationInputDigest,f.profile.kernelDigest,candidate.verificationVersion,observationId,JSON.stringify(candidate),f.seed.contextId]);await client.query("INSERT INTO manga_web.native_result_receipts(account_id,candidate_id,protected_receipt,receipt_digest,verified_at) VALUES($1,$2,$3,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex'),clock_timestamp())",[f.seed.accountId,candidate.candidateId,JSON.stringify(proof)]);});
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.recordCacheUseIn(tx,call.call,source),true)).toBeNull();
  await f.admin.pool.query('INSERT INTO manga_web.windows_native_cost_cache_uses(account_id,call_id,job_id,protected_source,evidence_id,evidence_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',[f.seed.accountId,call.call.callId,intent.jobId,JSON.stringify(source),randomUUID(),digest({callId:call.call.callId,source})]);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,b2RaceEnding(scope!)),true)).toBe('JOINED');
  const {inventory,raw}=await b201Reject(f,x,ready,control,'LEGACY_CACHE');expect(inventory.cache).toHaveLength(1);expect(inventory.cache[0].protected_source).toEqual(source);expect(raw.originals).toEqual([expect.objectContaining({key:null,classification:'UNCONFIRMED'})]);expect(raw.rows.some(row=>row.kind==='CACHE_USE'&&row.id===call.call.callId+'/'+intent.jobId)).toBe(true);expect(raw.rows.filter(row=>['BINDING','ORIGIN','WINDOWS_EVENT','WINDOWS_LINK'].includes(row.kind))).toEqual([]);
}),120000);

async function b201ExitSeven(open:Awaited<ReturnType<typeof b2RaceOpen>>){
  const {validateWindowsJobEvidence}=await import('../../packages/native/src/windows-job-evidence.js'),{windowsEvidenceBounds}=await import('../fixtures/windows-native.js'),original=open.script;let evidence:ReturnType<typeof original.evidence>|null=null;
  // 최초 ROOT_EXIT 저장 전에 event/source/lifecycle와 후속 chain을 함께 만든다.
  // 원 유효 frame·accounting·physical failureCode는 바꾸지 않는다.
  const script={...original,complete:(go:Parameters<typeof original.complete>[0])=>{
    original.complete(go);const prior=original.evidence(),exit=original.entries.findIndex(row=>row.event.kind==='ROOT_EXIT');expect(exit).toBeGreaterThan(0);expect(prior.lifecycle.rootExit).not.toBeNull();
    for(let index=exit;index<original.entries.length;index++){const row=original.entries[index],{payloadDigest:_payloadDigest,...previous}=row.event,body={...previous,previousDigest:original.entries[index-1].event.payloadDigest,payload:row.event.kind==='ROOT_EXIT'?{exitCode:7}:previous.payload};row.event={...body,payloadDigest:digest(body)} as typeof row.event;row.source=structuredClone(row.source);if(row.event.kind==='ROOT_EXIT')row.source.facts=row.source.facts.map(fact=>fact.kind==='WIN32'&&fact.api==='GetExitCodeProcess'?{...fact,value:{exitCode:7}}:fact);row.sourceDigest=digest(row.source);}
    evidence=validateWindowsJobEvidence({...structuredClone(prior),lifecycle:{...structuredClone(prior.lifecycle),rootExit:{...prior.lifecycle.rootExit!,exitCode:7},events:original.entries.map(row=>row.event)}},windowsEvidenceBounds);expect(evidence.final).toEqual(prior.final);expect(evidence.final.outcome).toBe('JOB_EMPTY');
  },evidence:()=>{if(evidence===null)throw new Error('B201_EXIT7_NOT_COMPLETED');return evidence;},seal:()=>{if(evidence===null)throw new Error('B201_EXIT7_NOT_COMPLETED');return {version:1 as const,originDigest:original.originDigest,evidence,entries:original.entries.map(row=>({eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest})),parentJoinAck:original.joinAck};},outcome:(ref:Parameters<typeof original.outcome>[0],raw:Parameters<typeof original.outcome>[1]):ReturnType<typeof original.outcome>=>{if(evidence===null)throw new Error('B201_EXIT7_NOT_COMPLETED');return {state:'JOINED',code:'OK',evidence,rawResult:raw,journalRef:ref};}};
  return {...open,script};
}

async function b201FailureCost(f:WindowsNativeFixture,x:Prepared,label:string){
  const raw=await b201Raw(f,x),inventory=await b201Inventory(f,x,raw),identity=(raw.originals as {classification:string;key:WindowsNativeOriginalKey}[])[0];expect(identity.classification).toBe('FRESH');const facts=await originalFacts(f,x.owner,identity.key);expect(facts.accounting).not.toBeNull();expect(facts.termination.kind).toBe('WINDOWS_JOB_EMPTY');const ticks=BigInt(facts.accounting!.value.userTime100ns)+BigInt(facts.accounting!.value.kernelTime100ns);expect(ticks).toBeGreaterThan(0n);
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),{cost}=windowsCost(f,ready.basis,ready.reader);expect(await f.service.renew(x.execution.claim)).toBe(true);await cost.finishAttempt(x.execution.input);await cost.idle();const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe(b201Usd(ticks));expect(view.calculations[0].result.facts.quantities).toEqual([expect.objectContaining({componentId:'native-image',quantity:b201Cpu(ticks),unit:'windows-job-cpu-second-v1'})]);expect(await b2SplitCounts(f)).toMatchObject({seals:1,calculations:1,closures:1});
  const after=await b201Inventory(f,x,await b201Raw(f,x));expect(after.evidence).toEqual(inventory.evidence);expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_NATIVE_COST_ABSENCE'",[f.seed.accountId,x.owner.executionId])).rows).toEqual([{n:0}]);
  console.info(JSON.stringify({w4b2B201Failure:{label,key:identity.key,originalOperation:facts.observations.result,originalTermination:facts.observations.termination,accounting:facts.accounting,quantity:b201Cpu(ticks),usd:b201Usd(ticks),view:{state:view.state,costUsd:view.costUsd},representsAllFailures:false,realChild:false}}));return facts;
}

it('W4-B2 B201 produced valid frame with actual signed root exit 7 preserves nonzero native CPU full cost',async()=>withPrepared(async(f,x)=>{
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),native=await b2RaceAdmit(f,x,call),open=await b201ExitSeven(await b2RaceOpen(f,x,native,'CREATED')),finished=await b2RaceFinish(f,x,native,open);
  expect(finished.rawResult).not.toBeNull();expect(open.script.evidence().lifecycle.rootExit!.exitCode).toBe(7);expect(open.script.evidence().final.failureCode).toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{...b2RaceEnding(scope!,[finished.bridge.operation!,finished.bridge.termination!]),outcome:'THREW'}),true)).toBe('JOINED');
  const exit=(await f.admin.pool.query("SELECT protected_event,protected_source FROM manga_web.windows_native_events WHERE account_id=$1 AND attempt_id=$2 AND kind='ROOT_EXIT'",[f.seed.accountId,open.capture.origin.authority.attemptId])).rows;expect(exit).toHaveLength(1);expect(exit[0].protected_event.payload.exitCode).toBe(7);expect(exit[0].protected_source.facts.find((fact:{kind:string;api?:string})=>fact.kind==='WIN32'&&fact.api==='GetExitCodeProcess').value.exitCode).toBe(7);await b201FailureCost(f,x,'PRODUCED_FRAME_ROOT_EXIT_7');
}),120000);

it('W4-B2 B201 actual facade semantic failure retains signed OP TERM GO accounting and nonzero native CPU full cost',async()=>{
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let f:WindowsNativeFixture|undefined,remote:Awaited<ReturnType<typeof createWindowsCostedRemoteFixture>>|undefined;
  try{f=await windowsNativeFixture(20.5);remote=await createWindowsCostedRemoteFixture(f,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'missing',canonicalPngByteLength:68}});expect(await f.service.preflight(remote.execution.claim,remote.execution.input)).toBe(true);await expect(remote.gateway.forCostOwner(remote.target,remote.owner,'INPUT',null).decodeImage(remote.source,syntheticProfile)).rejects.toMatchObject({code:'NATIVE_OUTPUT_INVALID',version:2,termination:{kind:'WINDOWS_JOB_EMPTY'}});
    const x:Prepared={...remote,components:[...remote.components]},facts=await b201FailureCost(f,x,'ACTUAL_FACADE_SEMANTIC_FAILURE');expect(facts.rawResult).not.toBeNull();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:1}]);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_result_receipts WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{n:0}]);
  }catch(error){errors.push(error);}finally{try{await remote?.close();}catch(error){errors.push(error);}try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'B201_FAILURE_AND_CLEANUP');
},120000);

it('W4-B2 B201 CREATED with complete physical resource record but no RAW_RESULT remains unknown without premature closure',async()=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),control=await b201Control(f,x,ready),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();const call=await b2RaceCall(f,x,scope!),native=await b2RaceAdmit(f,x,call),open=await b2RaceOpen(f,x,native,'CREATED');await open.journal.readyOriginal(open.capture,open.script.prepared);const grant=await open.ports.original.grantOriginal(open.capture),offset=open.script.entries.length;expect(grant.created).toBe(true);open.script.complete(grant.goGrantRef);for(const entry of open.script.entries.slice(offset))await open.ports.journal.appendOriginal(open.capture,entry.event,entry.source);
  await open.journal.parentJoinedOriginal(open.capture,open.script.joinAck);const record=await open.ports.journal.sealOriginal(open.capture,open.script.seal()),finalized=open.script.finalized(record);
  // JOINED/OK는 기존 fixture의 물리 자원 보고다. native 성공이나 NO_CHILD로
  // 바꾸지 않으며, 원 SQL/journal은 생성된 작업의 RAW 부재를 계속 거부한다.
  await expect(open.journal.finishOriginal(open.capture,{outcome:open.script.outcome(record,null),finalized,brokerJoin:{end:'EXPECTED',finalized}})).rejects.toMatchObject({code:'WINDOWS_NATIVE_TREE_UNCONFIRMED'});
  expect(open.script.evidence().lifecycle.creation).toBe('CREATED');expect(open.script.evidence().final.outcome).toBe('JOB_EMPTY');const physical=(await f.admin.pool.query("SELECT record_id,digest FROM manga_web.windows_native_records WHERE account_id=$1 AND attempt_id=$2 AND purpose='SEAL'",[f.seed.accountId,open.capture.origin.authority.attemptId])).rows;expect(physical).toEqual([{record_id:record.recordId,digest:record.digest}]);const {raw}=await b201Reject(f,x,ready,control,'CREATED_NO_RAW_UNSUPPORTED');expect(raw.rows.filter(row=>row.kind==='RAW_RESULT'||row.kind==='WINDOWS_LINK')).toEqual([]);expect(raw.rows.filter(row=>row.kind==='GO_CONSUMPTION')).toHaveLength(1);console.info(JSON.stringify({w4b2B201NoRaw:{originalRefusalCode:'WINDOWS_NATIVE_TREE_UNCONFIRMED',physicalWindowsSeals:physical,b2CostSeals:0,rawResults:0,windowsLinks:0,goConsumptions:1}}));
}),120000);


// 폐기되는 검사 DB에만 읽기 전용 함수를 설치한다. 제품 함수와 권한은 바꾸지 않는다.
const b2IoBijectionQueries={
  old:`SELECT EXISTS(SELECT 1 FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=a AND st.execution_id=e AND
  (SELECT count(*) FROM jsonb_array_elements(non_windows->'sources') src,jsonb_array_elements(src->'evidence') er JOIN manga_web.execution_evidence ev ON ev.account_id=a AND ev.execution_id=e AND ev.evidence_id::text=er->>'evidenceId' AND ev.evidence_digest=er->>'evidenceDigest'
   WHERE src->>'sourceOperationId'=st.operation_id::text AND src->>'sourceEventId'=st.event_id::text AND ev.protected_observation->'value'->'io'=(en.protected_event||jsonb_build_object('ended',manga_web.windows_native_cost_reference(en.evidence_id,en.evidence_digest))))<>1) INTO rejected;`,
  materialized:`SELECT EXISTS(
  WITH declared_io_counts AS MATERIALIZED(
   SELECT io_source.value->>'sourceOperationId' AS op_id,
    io_source.value->>'sourceEventId' AS event_id,
    io_evidence.protected_observation->'value'->'io' AS io_body,count(*) AS match_count
   FROM jsonb_array_elements(non_windows->'sources') AS io_source(value)
   CROSS JOIN LATERAL jsonb_array_elements(io_source.value->'evidence') AS io_reference(value)
   JOIN manga_web.execution_evidence AS io_evidence ON io_evidence.account_id=a AND io_evidence.execution_id=e
    AND io_evidence.evidence_id::text=io_reference.value->>'evidenceId'
    AND io_evidence.evidence_digest=io_reference.value->>'evidenceDigest'
   GROUP BY io_source.value->>'sourceOperationId',io_source.value->>'sourceEventId',io_evidence.protected_observation->'value'->'io'
  ),original_io AS MATERIALIZED(
   SELECT io_start.operation_id::text AS op_id,io_start.event_id::text AS event_id,
    io_end.protected_event||jsonb_build_object('ended',manga_web.windows_native_cost_reference(io_end.evidence_id,io_end.evidence_digest)) AS io_body
   FROM manga_web.windows_native_cost_io_starts AS io_start
   JOIN manga_web.windows_native_cost_io_ends AS io_end USING(account_id,operation_id)
   WHERE io_start.account_id=a AND io_start.execution_id=e
  )
  SELECT 1 FROM original_io AS owned_io
  LEFT JOIN declared_io_counts AS declared ON declared.op_id=owned_io.op_id
   AND declared.event_id=owned_io.event_id AND declared.io_body=owned_io.io_body
  WHERE COALESCE(declared.match_count,0)<>1
 ) INTO rejected;`,
} as const;
async function b2InstallIoBijectionDiagnostic(f:WindowsNativeFixture){
  await installSqlObservation(f);
  for(const [name,query] of Object.entries(b2IoBijectionQueries))await f.admin.pool.query(`
    CREATE FUNCTION manga_web.w4b2_test_io_bijection_${name}(p_execution uuid,p_non_windows jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $diagnostic$
    DECLARE a uuid:=manga_web.current_account();e uuid:=p_execution;non_windows jsonb:=p_non_windows;rejected boolean;
    BEGIN
      IF a IS NULL OR NOT EXISTS(SELECT 1 FROM manga_web.executions WHERE account_id=a AND execution_id=e) THEN RAISE EXCEPTION 'W4B2_DIAGNOSTIC_ACCOUNT_REQUIRED' USING ERRCODE='42501';END IF;
      ${query}
      RETURN rejected;
    END $diagnostic$;
    REVOKE ALL ON FUNCTION manga_web.w4b2_test_io_bijection_${name}(uuid,jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION manga_web.w4b2_test_io_bijection_${name}(uuid,jsonb) TO trio_web_worker;
  `);
}
async function b2IoBijectionStatement(f:WindowsNativeFixture,x:Prepared,name:keyof typeof b2IoBijectionQueries,nonWindows:unknown,tx:Awaited<ReturnType<Database['accountContext']>>){
    await tx.client.query('SELECT manga_web.w4b2_test_profile()');
    const identity=async()=>(await tx.client.query('SELECT current_user AS role,manga_web.current_account()::text AS account')).rows[0];
    expect(await identity()).toEqual({role:'trio_web_worker',account:f.seed.accountId});
    const stats=async()=>((await tx.client.query<{calls:number;total_ms:number;self_ms:number}>("SELECT calls::integer,total_time AS total_ms,self_time AS self_ms FROM pg_stat_xact_user_functions WHERE funcname='windows_native_cost_reference'")).rows[0]??{calls:0,total_ms:0,self_ms:0});
    const before=await stats(),started=performance.now();
    const rejected=(await tx.client.query<{rejected:boolean}>(`SELECT manga_web.w4b2_test_io_bijection_${name}($1::uuid,$2::jsonb) AS rejected`,[x.owner.executionId,nonWindows===undefined?null:JSON.stringify(nonWindows)])).rows[0].rejected;
    const elapsedMs=performance.now()-started,after=await stats();
    expect(await identity()).toEqual({role:'trio_web_worker',account:f.seed.accountId});
    return {rejected,elapsedMs,referenceCalls:after.calls-before.calls,referenceTotalMs:after.total_ms-before.total_ms,referenceSelfMs:after.self_ms-before.self_ms};
}
async function b2IoBijectionPair(f:WindowsNativeFixture,x:Prepared,nonWindows:unknown){
  return f.worker.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const tx=await f.worker.accountContext(client,f.seed.accountId,true),snapshot=async()=>(await client.query('SELECT pg_current_snapshot()::text AS value')).rows[0].value as string;
    const before=await snapshot(),old=await b2IoBijectionStatement(f,x,'old',nonWindows,tx),materialized=await b2IoBijectionStatement(f,x,'materialized',nonWindows,tx),after=await snapshot();expect(after).toBe(before);
    return {snapshot:before,sameSnapshot:true,old,materialized};
  });
}
// 기존 I/O 1024개 계측 검사의 실제 B1 scope/call/receipt/END/JOIN 순서를 그대로 사용한다.
async function b2IoBijectionFixture(f:WindowsNativeFixture,x:Prepared,count:1|1024,onFirst?:(io:WindowsCostedIoEvent)=>Promise<void>){
  const bytes=Buffer.from(ownedNativePng,'base64'),key=f.seed.accountId+'/'+randomUUID();await f.files.put(key,bytes);
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:16384,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),events:WindowsCostedIoEvent[]=[];
  for(let group=0;group<Math.ceil(count/64);group++){
    await renewObserved(f,x,'io-bijection-'+group);const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
    const body={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1',profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('io-bijection-'+group),componentId:'native-image'},call={...body,callDigest:digest(body)};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
    const refs:Ref[]=[];for(let index=0;index<Math.min(64,count-group*64);index++){
      const request:WindowsCostedIoRequest={version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_RECEIPT',key,expected:{sha256:sha256(bytes),bytesLength:String(bytes.length)}},value=await io.receipt(request);expect(value.state).toBe('RETURNED');events.push(value.event);refs.push(value.event.ended!);if(events.length===1)await onFirst?.(value.event);
    }
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:refs}),true)).toBe('JOINED');
  }
  expect(events).toHaveLength(count);return events;
}
async function b2IoBijectionSideEffects(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT
  (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go,
  (SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections) projections,
  (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,
  (SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations) allocations,
  (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION') calculations,
  (SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures,
  (SELECT count(*)::integer FROM manga_web.cost_items WHERE component='STAGE_TOTAL') totals,
  (SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses`)).rows[0];}

it('W4-B2 I/O bijection statement comparison preserves null text digest body and multiset boundaries',async()=>withPrepared(async(f,x)=>{
  await b2InstallIoBijectionDiagnostic(f);const effects=await b2IoBijectionSideEffects(f),measurements:unknown[]=[];
  const compare=async(label:string,value:unknown,expectedRejected:boolean,ioCount:number)=>{
    const {snapshot,sameSnapshot,old,materialized}=await b2IoBijectionPair(f,x,value);
    expect(old.rejected,label).toBe(expectedRejected);expect(materialized.rejected,label).toBe(old.rejected);expect(materialized.referenceCalls,label).toBeLessThanOrEqual(ioCount);if(!expectedRejected)expect(materialized.referenceCalls,label).toBe(ioCount);
    measurements.push({label,ioCount,snapshot,sameSnapshot,old,materialized});
  };
  for(const [label,value] of [['ZERO_IO_EMPTY',{sources:[]}],['ZERO_IO_SQL_NULL',undefined],['ZERO_IO_JSON_NULL',null]] as const)await compare(label,value,false,0);
  await b2IoBijectionFixture(f,x,1,async io=>{
    const value={version:1,operationId:io.operationId,eventId:io.eventId,fact:{state:'CONFIRMED',actualUsd:'0'},io},valid=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',value),missingIo=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',(({io:_io,...rest})=>rest)(value)),nullIo=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{...value,io:null}),changedIo=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{...value,io:{...io,key:io.key+'/changed'}}),changedEnded=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{...value,io:{...io,ended:{...io.ended!,evidenceDigest:sha256('changed-ended')}}});
    const source={sourceOperationId:io.operationId,sourceEventId:io.eventId,target:'PROVIDER',componentId:null,evidence:[valid]},withoutOp=(({sourceOperationId:_operation,...rest})=>rest)(source),withoutEvent=(({sourceEventId:_event,...rest})=>rest)(source);
    const cases:{label:string;value:unknown;matches:number}[]=[
      {label:'ONE_MATCH',value:{sources:[source]},matches:1},
      {label:'ZERO_MATCH',value:{sources:[]},matches:0},
      {label:'TWO_SOURCE_MATCHES',value:{sources:[source,source]},matches:2},
      {label:'TWO_REFERENCE_MATCHES',value:{sources:[{...source,evidence:[valid,valid]}]},matches:2},
      {label:'SQL_NULL_INPUT',value:undefined,matches:0},
      {label:'JSON_NULL_INPUT',value:null,matches:0},
      {label:'SQL_NULL_SOURCES_MISSING',value:{},matches:0},
      {label:'OP_CHANGED',value:{sources:[{...source,sourceOperationId:randomUUID()}]},matches:0},
      {label:'OP_SQL_NULL_MISSING',value:{sources:[withoutOp]},matches:0},
      {label:'OP_JSON_NULL',value:{sources:[{...source,sourceOperationId:null}]},matches:0},
      {label:'EVENT_CHANGED',value:{sources:[{...source,sourceEventId:randomUUID()}]},matches:0},
      {label:'EVENT_SQL_NULL_MISSING',value:{sources:[withoutEvent]},matches:0},
      {label:'EVENT_JSON_NULL',value:{sources:[{...source,sourceEventId:null}]},matches:0},
      {label:'ID_TEXT_UPPERCASE',value:{sources:[{...source,evidence:[{...valid,evidenceId:valid.evidenceId.toUpperCase()}]}]},matches:0},
      {label:'ID_TEXT_NON_UUID',value:{sources:[{...source,evidence:[{...valid,evidenceId:'not-a-uuid'}]}]},matches:0},
      {label:'ID_TEXT_SQL_NULL_MISSING',value:{sources:[{...source,evidence:[{evidenceDigest:valid.evidenceDigest}]}]},matches:0},
      {label:'ID_TEXT_JSON_NULL',value:{sources:[{...source,evidence:[{...valid,evidenceId:null}]}]},matches:0},
      {label:'DIGEST_CHANGED',value:{sources:[{...source,evidence:[{...valid,evidenceDigest:sha256('changed-ref')}]}]},matches:0},
      {label:'DIGEST_SQL_NULL_MISSING',value:{sources:[{...source,evidence:[{evidenceId:valid.evidenceId}]}]},matches:0},
      {label:'DIGEST_JSON_NULL',value:{sources:[{...source,evidence:[{...valid,evidenceDigest:null}]}]},matches:0},
      {label:'IO_SQL_NULL_MISSING',value:{sources:[{...source,evidence:[missingIo]}]},matches:0},
      {label:'IO_JSON_NULL',value:{sources:[{...source,evidence:[nullIo]}]},matches:0},
      {label:'FULL_IO_KEY_CHANGED',value:{sources:[{...source,evidence:[changedIo]}]},matches:0},
      {label:'FULL_IO_ENDED_DIGEST_CHANGED',value:{sources:[{...source,evidence:[changedEnded]}]},matches:0},
    ];
    expect(valid.evidenceId.toUpperCase()).not.toBe(valid.evidenceId);
    for(const c of cases){
      const matches=(await f.admin.pool.query<{matches:number}>(`SELECT count(*)::integer AS matches FROM jsonb_array_elements($1::jsonb->'sources') s CROSS JOIN LATERAL jsonb_array_elements(s->'evidence') r JOIN manga_web.execution_evidence ev ON ev.account_id=$2 AND ev.execution_id=$3 AND ev.evidence_id::text=r->>'evidenceId' AND ev.evidence_digest=r->>'evidenceDigest' WHERE s->>'sourceOperationId'=$4 AND s->>'sourceEventId'=$5 AND ev.protected_observation->'value'->'io'=$6::jsonb`,[c.value===undefined?null:JSON.stringify(c.value),f.seed.accountId,x.owner.executionId,io.operationId,io.eventId,JSON.stringify(io)])).rows[0].matches;
      expect(matches,c.label).toBe(c.matches);await compare(c.label,c.value,c.matches!==1,1);
    }
    // JSON null 배열은 선행 닫힌 자료 검증의 대상이다. 두 문장 모두 같은 원 SQL 오류를 유지한다.
    const errorSnapshot=await f.worker.transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const tx=await f.worker.accountContext(client,f.seed.accountId,true),before=(await client.query('SELECT pg_current_snapshot()::text AS value')).rows[0].value;
      for(const name of ['old','materialized'] as const){await client.query('SAVEPOINT io_diagnostic_error');try{await expect(b2IoBijectionStatement(f,x,name,{sources:null},tx)).rejects.toMatchObject({code:'22023'});}finally{await client.query('ROLLBACK TO SAVEPOINT io_diagnostic_error');await client.query('RELEASE SAVEPOINT io_diagnostic_error');}}
      expect((await client.query('SELECT pg_current_snapshot()::text AS value')).rows[0].value).toBe(before);expect((await client.query('SELECT current_user AS role,manga_web.current_account()::text AS account')).rows[0]).toEqual({role:'trio_web_worker',account:f.seed.accountId});return before as string;
    });
    measurements.push({label:'JSON_NULL_SOURCES_ARRAY',snapshot:errorSnapshot,sameSnapshot:true,oldSqlState:'22023',materializedSqlState:'22023'});
  });
  expect(await b2IoBijectionSideEffects(f)).toEqual(effects);console.info(JSON.stringify({w4b2IoBijectionShapes:{measurements,sideEffectsUnchanged:true,productSqlChanged:false,claims:'문장 비교만 확인하며 전체 비용과 최초 봉인 양성으로 확대하지 않는다.'}}));
}),180000);

it('W4-B2 I/O bijection statement comparison bounds references for actual 1024 completed I/O',async()=>withPrepared(async(f,x)=>{
  await b2InstallIoBijectionDiagnostic(f);const effects=await b2IoBijectionSideEffects(f),events=await b2IoBijectionFixture(f,x,1024),sources:{sourceOperationId:string;sourceEventId:string;target:string;componentId:null;evidence:Ref[]}[]=[];
  for(const [index,io] of events.entries()){
    if(index%64===0)await renewObserved(f,x,'io-bijection-source-'+index);
    const evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:io.operationId,eventId:io.eventId,fact:{state:'CONFIRMED',actualUsd:'0'},io});sources.push({sourceOperationId:io.operationId,sourceEventId:io.eventId,target:'PROVIDER',componentId:null,evidence:[evidence]});
  }
  // 관련 없는 출처 323개는 원문이 반복해서 펼치는 자료량만 늘린다. 요금·종료 양성은 주장하지 않는다.
  for(let index=0;index<323;index++){
    if(index%64===0)await renewObserved(f,x,'io-bijection-unrelated-'+index);const operationId=randomUUID(),eventId=randomUUID(),evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact:{state:'CONFIRMED',actualUsd:'0'}});sources.push({sourceOperationId:operationId,sourceEventId:eventId,target:'PROVIDER',componentId:null,evidence:[evidence]});
  }
  const inventory=(await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends en JOIN manga_web.windows_native_cost_io_starts st USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2) ends,(SELECT count(*)::integer FROM manga_web.windows_native_cost_scopes WHERE account_id=$1 AND execution_id=$2) scopes,(SELECT count(*)::integer FROM manga_web.windows_native_cost_calls WHERE account_id=$1 AND execution_id=$2) calls`,[f.seed.accountId,x.owner.executionId])).rows[0];
  expect(inventory).toEqual({starts:1024,ends:1024,scopes:16,calls:16});expect(sources).toHaveLength(1347);
  await renewObserved(f,x,'io-bijection-before-statements');const input={sources},{snapshot,sameSnapshot,old,materialized}=await b2IoBijectionPair(f,x,input);
  expect(old.rejected).toBe(false);expect(materialized.rejected).toBe(old.rejected);expect(materialized.referenceCalls).toBe(1024);expect(materialized.referenceCalls).toBeLessThan(old.referenceCalls);expect(await b2IoBijectionSideEffects(f)).toEqual(effects);
  console.info(JSON.stringify({w4b2IoBijection1024:{inventory,declaredSources:sources.length,declaredReferences:sources.reduce((n,s)=>n+s.evidence.length,0),snapshot,sameSnapshot,old,materialized,sideEffectsUnchanged:true,productSqlChanged:false,claims:'이 문장의 참조 생성 횟수와 시간만 측정한다. 전체 봉인 함수 호출수·금액·최종 현재성·30초 내 거래 완료는 검증하지 않는다.'}}));
}),180000);


it.each(['MISSING','DUPLICATE'] as const)('W4-B2 I/O full guard %s keeps exact nonWindows coverage but refuses unmatched original I/O',async defect=>withPrepared(async(f,x)=>{
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),events=await b2IoBijectionFixture(f,x,1),io=events[0];
  const control=async()=>{
    const candidate=await absenceCandidate(f,x,ready.basis,ready.work),gates=await b2CoverageGates(f,x,ready,candidate);expect(gates.coverage).toBe(true);expect(gates.amount).not.toBeNull();
    const rollback=new Error('W4B2_IO_GUARD_CONTROL_ROLLBACK');let reached=false;
    try{await f.worker.accountTransaction(f.seed.accountId,async tx=>{expect((await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value).not.toBeNull();reached=true;throw rollback;},true);}catch(error){if(error!==rollback)throw error;}expect(reached).toBe(true);
  };
  if(defect==='DUPLICATE'){
    await b2RaceAddIoFacts(f,x,ready.work);await control();
    // 동일 원 I/O 본문을 추가 보조 증거로 재사용한다. 원 SOURCE/fact/종료는 완전하게 유지한다.
    const extra=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_IO_WITNESS',{io}),source=ready.work.sources.find(s=>s.sourceOperationId===io.operationId)!;source.evidence.push(extra);ready.work.joinedEvidence.push(extra);ready.work.facts.provider!.evidenceRefs.push(extra.evidenceId);
  }
  const candidate=await absenceCandidate(f,x,ready.basis,ready.work),gates=await b2CoverageGates(f,x,ready,candidate);expect(gates.coverage).toBe(true);expect(gates.amount).not.toBeNull();
  const matches=(await f.admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM jsonb_array_elements($1::jsonb->'sources') s CROSS JOIN LATERAL jsonb_array_elements(s->'evidence') r JOIN manga_web.execution_evidence ev ON ev.account_id=$2 AND ev.execution_id=$3 AND ev.evidence_id::text=r->>'evidenceId' AND ev.evidence_digest=r->>'evidenceDigest' WHERE s->>'sourceOperationId'=$4 AND s->>'sourceEventId'=$5 AND ev.protected_observation->'value'->'io'=$6::jsonb`,[JSON.stringify(candidate.nonWindowsWorkSet),f.seed.accountId,x.owner.executionId,io.operationId,io.eventId,JSON.stringify(io)])).rows[0].n;
  expect(matches).toBe(defect==='MISSING'?0:2);expect(await b2CoverageSeal(f,x,candidate)).toBeNull();
  const counts=await b2IoBijectionSideEffects(f);expect(counts).toMatchObject({go:0,seals:0,allocations:0,calculations:0,closures:0,totals:0,expenses:0});
  if(defect==='MISSING'){await b2RaceAddIoFacts(f,x,ready.work);await control();}
  console.info(JSON.stringify({w4b2IoFullGuard:{defect,actualStarts:1,actualEnds:1,matchingReferences:matches,nonWindowsCoverage:gates.coverage,amountConfirmed:gates.amount!==null,publicSeal:null,normalOneMatchControl:true,counts}}));
}),120000);


// 후보 본문은 폐기되는 검사 DB의 별도 이름으로만 설치한다. 제품 함수는 호출만 한다.
const b2NwGroupCandidateSql=`CREATE FUNCTION manga_web.w4b2_test_non_windows_group_candidate(work jsonb,owner jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$
DECLARE a uuid:=manga_web.current_account();e uuid:=(owner->>'executionId')::uuid;s jsonb;r jsonb;f jsonb;proof jsonb;proof_kind text;fact_target text;all_refs jsonb:='[]';seen uuid[]:='{}';used uuid[]:='{}';matching integer;terminal_count integer;expected_refs jsonb;reference_group_keys jsonb[]:='{}';reference_group_refs jsonb[]:='{}';reference_group_key jsonb;reference_group_index integer;
BEGIN
 IF NOT manga_web.windows_native_object(work,ARRAY['version','executionId','inputFingerprint','captureDigest','completion','joinedEvidence','terminationEvidence','sources','facts']) OR work->'version' IS DISTINCT FROM '1'::jsonb OR
  work->>'executionId' IS DISTINCT FROM e::text OR work->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR octet_length(work::text)>1048576 OR
  NOT manga_web.windows_stage_cost_refs(work->'joinedEvidence',2046) OR NOT manga_web.windows_stage_cost_refs(work->'terminationEvidence',2046) OR jsonb_typeof(work->'sources') IS DISTINCT FROM 'array' OR
  NOT manga_web.windows_native_object(work->'facts',ARRAY['provider','quantities','allocation']) OR jsonb_typeof(work->'facts'->'quantities') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(work->'facts'->'quantities')>64 THEN RETURN false;END IF;
 IF jsonb_array_length(work->'sources')>2046 OR jsonb_array_length(work->'terminationEvidence')=0 OR jsonb_array_length(work->'joinedEvidence')+jsonb_array_length(work->'terminationEvidence')>2046 OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(work->'joinedEvidence') x,jsonb_array_elements(work->'terminationEvidence') y WHERE x->>'evidenceId'=y->>'evidenceId') THEN RETURN false;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(work->'sources') LOOP
  IF NOT manga_web.windows_native_object(s,ARRAY['sourceOperationId','sourceEventId','target','componentId','evidence']) OR NOT manga_web.windows_native_cost_uuid(s->>'sourceOperationId') OR NOT manga_web.windows_native_cost_uuid(s->>'sourceEventId') OR s->>'target' NOT IN('PROVIDER','QUANTITY','ALLOCATION') OR
   NOT manga_web.windows_stage_cost_refs(s->'evidence',2046) OR jsonb_array_length(s->'evidence')=0 THEN RETURN false;END IF;
  IF (s->>'sourceOperationId')::uuid=ANY(seen) OR(s->>'sourceEventId')::uuid=ANY(seen) OR s->>'sourceOperationId'=s->>'sourceEventId' THEN RETURN false;END IF;seen:=seen||ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid];
  IF EXISTS(SELECT 1 FROM manga_web.native_job_intents WHERE account_id=a AND job_id=ANY(ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid])) OR EXISTS(SELECT 1 FROM manga_web.windows_native_events WHERE account_id=a AND event_id=ANY(ARRAY[(s->>'sourceOperationId')::uuid,(s->>'sourceEventId')::uuid])) THEN RETURN false;END IF;
  IF s->>'target'='QUANTITY' THEN SELECT value INTO f FROM jsonb_array_elements(work->'facts'->'quantities') WHERE value->>'componentId'=s->>'componentId';
  ELSE IF s->'componentId'<>'null'::jsonb THEN RETURN false;END IF;f:=CASE WHEN s->>'target'='PROVIDER' THEN work->'facts'->'provider' ELSE work->'facts'->'allocation' END;END IF;
  IF f IS NULL OR f='null'::jsonb THEN RETURN false;END IF;matching:=0;
  reference_group_key:=jsonb_build_array(s->>'target',s->'componentId');
  reference_group_index:=array_position(reference_group_keys,reference_group_key);
  IF reference_group_index IS NULL THEN
   SELECT COALESCE(jsonb_agg(er.value->>'evidenceId' ORDER BY er.value->>'evidenceId' COLLATE "C"),'[]') INTO expected_refs
    FROM jsonb_array_elements(work->'sources') same_source,LATERAL jsonb_array_elements(same_source->'evidence') er
    WHERE same_source->>'target'=s->>'target' AND same_source->'componentId'=s->'componentId';
   reference_group_keys:=array_append(reference_group_keys,reference_group_key);
   reference_group_refs:=array_append(reference_group_refs,expected_refs);
  ELSE expected_refs:=reference_group_refs[reference_group_index];END IF;
  IF f->'evidenceRefs' IS DISTINCT FROM expected_refs THEN RETURN false;END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(s->'evidence') LOOP
   IF (r->>'evidenceId')::uuid=ANY(used) OR NOT(work->'joinedEvidence' @> jsonb_build_array(r)) THEN RETURN false;END IF;used:=array_append(used,(r->>'evidenceId')::uuid);all_refs:=all_refs||jsonb_build_array(r);
   SELECT protected_observation,kind INTO proof,proof_kind FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND evidence_id=(r->>'evidenceId')::uuid AND evidence_digest=r->>'evidenceDigest' AND protected_evidence_ref=evidence_id::text;
   IF proof IS NULL OR manga_web.windows_native_cost_hash(proof) IS DISTINCT FROM r->>'evidenceDigest' THEN RETURN false;END IF;
   -- An original start/source cannot be borrowed as another operation's extra
   -- reference. Each such row must declare its own operation/event and fact.
   IF proof_kind='CHECKPOINT_VALIDATION_OPERATION' THEN
    -- Original v1 semantic evidence uses semantic.eventId, not a cost fact.
    -- It is auxiliary evidence of this exact declared semantic source; the
    -- separately required cost SOURCE/fact and original end remain mandatory.
    IF NOT manga_web.windows_native_object(proof,ARRAY['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']) OR proof->'version' IS DISTINCT FROM '1'::jsonb OR proof->>'kind' IS DISTINCT FROM proof_kind OR proof->>'accountId' IS DISTINCT FROM a::text OR proof->>'executionId' IS DISTINCT FROM e::text OR proof->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR
     NOT manga_web.windows_native_object(proof->'value',ARRAY['version','operationId','attemptId','attemptDigest','validationVersion','targetDigest','sourceInputFingerprint','outputDigest','semantic','storage','native']) OR proof->'value'->'version' IS DISTINCT FROM '1'::jsonb OR proof->'value'->>'validationVersion' IS DISTINCT FROM 'checkpoint-validation-v1' OR proof->'value'->'native' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(proof->'value'->'storage') IS DISTINCT FROM 'array' OR
     NOT manga_web.windows_native_object(proof->'value'->'semantic',ARRAY['eventId','kind','outcome']) OR proof->'value'->'semantic'->>'kind' IS DISTINCT FROM 'SEMANTIC_VALIDATION' OR proof->'value'->'semantic'->>'outcome' IS DISTINCT FROM 'RETURNED' OR proof->'value'->>'operationId' IS DISTINCT FROM s->>'sourceOperationId' OR proof->'value'->'semantic'->>'eventId' IS DISTINCT FROM s->>'sourceEventId' OR
     s->>'target' IS DISTINCT FROM 'QUANTITY' OR f->>'componentId' IS DISTINCT FROM s->>'componentId' OR f->>'captureDigest' IS DISTINCT FROM work->>'captureDigest' OR NOT EXISTS(
      SELECT 1 FROM manga_web.execution_evidence basis,LATERAL jsonb_array_elements(basis.protected_observation->'value'->'snapshot'->'components') rate WHERE basis.account_id=a AND basis.execution_id=e AND basis.kind='OPERATIONAL_COST_BASIS' AND basis.evidence_id::text=owner->'basisRef'->>'evidenceId' AND basis.evidence_digest=owner->'basisRef'->>'evidenceDigest' AND basis.protected_observation->'value'->>'captureDigest'=f->>'captureDigest' AND rate->>'componentId'=s->>'componentId' AND rate->>'kind'='RENDER' AND rate->>'unit'=f->>'unit') OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'value'->'storage') observed WHERE NOT manga_web.windows_native_object(observed,ARRAY['eventId','kind','assetId','sha256','bytesLength','outcome']) OR observed->>'kind' IS DISTINCT FROM 'OBJECT_READ' OR observed->>'outcome' IS DISTINCT FROM 'RETURNED' OR NOT EXISTS(
      SELECT 1 FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=a AND st.execution_id=e AND st.event_id::text=observed->>'eventId' AND st.protected_request->>'kind'='OBJECT_READ' AND st.protected_request->>'key'=a::text||'/'||(observed->>'assetId') AND en.protected_event->>'state'='RETURNED' AND en.protected_event->'observed'=jsonb_build_object('sha256',observed->>'sha256','bytesLength',observed->>'bytesLength') AND EXISTS(
       SELECT 1 FROM jsonb_array_elements(work->'sources') io_source WHERE io_source->>'sourceOperationId'=st.operation_id::text AND io_source->>'sourceEventId'=st.event_id::text))) THEN RETURN false;END IF;
   ELSIF proof->'value' ?| ARRAY['operationId','eventId','fact'] AND(proof->>'accountId' IS DISTINCT FROM a::text OR proof->>'executionId' IS DISTINCT FROM e::text OR proof->>'inputFingerprint' IS DISTINCT FROM owner->>'inputFingerprint' OR proof->'value'->>'operationId' IS DISTINCT FROM s->>'sourceOperationId' OR proof->'value'->>'eventId' IS DISTINCT FROM s->>'sourceEventId' OR proof->'value'->'fact' IS DISTINCT FROM(f-'evidenceRefs')) THEN RETURN false;END IF;
   IF proof->>'accountId'=a::text AND proof->>'executionId'=e::text AND proof->>'inputFingerprint'=owner->>'inputFingerprint' AND proof->'value'->>'operationId'=s->>'sourceOperationId' AND proof->'value'->>'eventId'=s->>'sourceEventId' AND proof->'value'->'fact'=(f-'evidenceRefs') THEN matching:=matching+1;END IF;
  END LOOP;
  IF matching<>1 THEN RETURN false;END IF;
  SELECT count(*) INTO terminal_count FROM jsonb_array_elements(work->'terminationEvidence') tr JOIN manga_web.execution_evidence v ON v.account_id=a AND v.execution_id=e AND v.evidence_id::text=tr.value->>'evidenceId' AND v.evidence_digest=tr.value->>'evidenceDigest',
   LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.protected_observation->'value'->'operations')='array' THEN v.protected_observation->'value'->'operations' ELSE '[]' END) ended
   WHERE ended->>'operationId'=s->>'sourceOperationId' AND ended->>'eventId'=s->>'sourceEventId' AND ended->>'outcome' IN('RETURNED','THREW');
  IF terminal_count<>1 THEN RETURN false;END IF;
 END LOOP;
 -- Source traversal alone cannot establish that a fact has any source. Every
 -- provider, allocation and nonWindows quantity needs its complete exact set.
 FOR fact_target,f IN SELECT 'PROVIDER'::text,work->'facts'->'provider'
  UNION ALL SELECT 'ALLOCATION'::text,work->'facts'->'allocation'
  UNION ALL SELECT 'QUANTITY'::text,value FROM jsonb_array_elements(work->'facts'->'quantities') LOOP
  SELECT COALESCE(jsonb_agg(er.value->>'evidenceId' ORDER BY er.value->>'evidenceId' COLLATE "C"),'[]') INTO expected_refs
   FROM jsonb_array_elements(work->'sources') same_source,LATERAL jsonb_array_elements(same_source->'evidence') er
   WHERE same_source->>'target'=fact_target AND same_source->'componentId'=CASE WHEN fact_target='QUANTITY' THEN f->'componentId' ELSE 'null'::jsonb END;
  IF expected_refs='[]'::jsonb OR f->'evidenceRefs' IS DISTINCT FROM expected_refs THEN RETURN false;END IF;
 END LOOP;
 -- Every original source/start and original nonWindows end belongs to this
 -- complete set. A caller cannot omit a pending or expensive original row.
 IF EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND
   ((ev.protected_observation->'value' ?| ARRAY['operationId','eventId','fact']) AND ev.kind NOT IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION','CHECKPOINT_VALIDATION_OPERATION','WINDOWS_NATIVE_COST_ATTRIBUTION','WINDOWS_NATIVE_COST_TERMINATION','WINDOWS_NATIVE_COST_ABSENCE','WINDOWS_NATIVE_COST_CENSUS_TERMINATION','WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')) AND
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work->'joinedEvidence') er WHERE er->>'evidenceId'=ev.evidence_id::text AND er->>'evidenceDigest'=ev.evidence_digest)) OR
  EXISTS(SELECT 1 FROM manga_web.execution_evidence ev WHERE ev.account_id=a AND ev.execution_id=e AND jsonb_typeof(ev.protected_observation->'value'->'operations')='array' AND ev.kind NOT IN('CHECKPOINT_VALIDATION_VERIFIED') AND
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work->'terminationEvidence') er WHERE er->>'evidenceId'=ev.evidence_id::text AND er->>'evidenceDigest'=ev.evidence_digest)) THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(work->'terminationEvidence') LOOP
  SELECT protected_observation INTO proof FROM manga_web.execution_evidence WHERE account_id=a AND execution_id=e AND evidence_id=(r->>'evidenceId')::uuid AND evidence_digest=r->>'evidenceDigest' AND protected_evidence_ref=evidence_id::text;
  IF proof IS NULL OR manga_web.windows_native_cost_hash(proof) IS DISTINCT FROM r->>'evidenceDigest' THEN RETURN false;END IF;
  IF proof->'value' ? 'operations' THEN
   IF jsonb_typeof(proof->'value'->'operations') IS DISTINCT FROM 'array' OR jsonb_array_length(proof->'value'->'operations')>2046 OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'value'->'operations') ended WHERE
     NOT manga_web.windows_native_object(ended,ARRAY['operationId','eventId','outcome']) OR ended->>'outcome' NOT IN('RETURNED','THREW') OR
     (SELECT count(*) FROM jsonb_array_elements(work->'sources') src WHERE src->>'sourceOperationId'=ended->>'operationId' AND src->>'sourceEventId'=ended->>'eventId')<>1) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN manga_web.windows_stage_cost_sorted_refs(all_refs)=manga_web.windows_stage_cost_sorted_refs(work->'joinedEvidence');
END $$;
`;
async function b2InstallNwGroupDiagnostic(f:WindowsNativeFixture){
  const signatures=[...publicSignatures,'manga_web.windows_stage_cost_non_windows(jsonb,jsonb)'],metadata=async()=>(await f.admin.pool.query('SELECT oid::text,proowner::text,proacl::text,proconfig,prosecdef,provolatile,prosrc FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid',[signatures])).rows,before=await metadata();
  await installSqlObservation(f);await f.admin.pool.query(b2NwGroupCandidateSql);
  await f.admin.pool.query(`REVOKE ALL ON FUNCTION manga_web.w4b2_test_non_windows_group_candidate(jsonb,jsonb) FROM PUBLIC;
    CREATE FUNCTION manga_web.w4b2_test_non_windows_group(work jsonb,owner jsonb,use_candidate boolean) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$BEGIN
      IF manga_web.current_account() IS NULL THEN RAISE EXCEPTION 'W4B2_DIAGNOSTIC_ACCOUNT_REQUIRED' USING ERRCODE='42501';END IF;
      IF use_candidate THEN RETURN manga_web.w4b2_test_non_windows_group_candidate(work,owner);END IF;
      RETURN manga_web.windows_stage_cost_non_windows(work,owner);
    END $$;
    REVOKE ALL ON FUNCTION manga_web.w4b2_test_non_windows_group(jsonb,jsonb,boolean) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION manga_web.w4b2_test_non_windows_group(jsonb,jsonb,boolean) TO trio_web_worker;`);
  expect(await metadata()).toEqual(before);
}
async function b2NwGroupPair(f:WindowsNativeFixture,x:Prepared,work:unknown,expected:boolean){
  return f.worker.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await f.worker.accountContext(client,f.seed.accountId,true);await client.query('SELECT manga_web.w4b2_test_profile()');
    const identity=async()=>(await client.query('SELECT current_user AS role,manga_web.current_account()::text AS account,pg_current_snapshot()::text AS snapshot')).rows[0],before=await identity();expect(before).toMatchObject({role:'trio_web_worker',account:f.seed.accountId});
    expect((await client.query("SELECT has_function_privilege(current_user,'manga_web.windows_stage_cost_non_windows(jsonb,jsonb)','EXECUTE') AS original,has_function_privilege(current_user,'manga_web.w4b2_test_non_windows_group_candidate(jsonb,jsonb)','EXECUTE') AS candidate")).rows[0]).toEqual({original:false,candidate:false});
    const params=[work===undefined?null:JSON.stringify(work),JSON.stringify(x.owner)],measure=async(useCandidate:boolean)=>{
      const name=useCandidate?'w4b2_test_non_windows_group_candidate':'windows_stage_cost_non_windows',stats=async()=>((await client.query<{calls:number;total_ms:number;self_ms:number}>('SELECT calls::integer,total_time AS total_ms,self_time AS self_ms FROM pg_stat_xact_user_functions WHERE funcname=$1',[name])).rows[0]??{calls:0,total_ms:0,self_ms:0}),prior=await stats(),started=performance.now();
      const value=(await client.query<{value:boolean}>('SELECT manga_web.w4b2_test_non_windows_group($1::jsonb,$2::jsonb,$3::boolean) value',[...params,useCandidate])).rows[0].value,elapsedMs=performance.now()-started,after=await stats();
      return {value,elapsedMs,calls:after.calls-prior.calls,totalMs:after.total_ms-prior.total_ms,selfMs:after.self_ms-prior.self_ms};
    };
    const original=await measure(false),candidate=await measure(true);expect(original.value).toBe(expected);expect(candidate.value).toBe(original.value);expect(original.calls).toBe(1);expect(candidate.calls).toBe(1);expect(await identity()).toEqual(before);
    return {snapshot:before.snapshot as string,sameSnapshot:true,original,candidate};
  });
}
function b2NwGroupSort(work:OperationalStageCostWorkSet){
  work.sources.sort((a,b)=>a.sourceOperationId<b.sourceOperationId?-1:1);work.joinedEvidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);work.terminationEvidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
  for(const source of work.sources)source.evidence.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
  for(const [target,fact] of [['PROVIDER',work.facts.provider],['ALLOCATION',work.facts.allocation]] as const)fact!.evidenceRefs=work.sources.filter(source=>source.target===target).flatMap(source=>source.evidence.map(ref=>ref.evidenceId)).sort();
  for(const quantity of work.facts.quantities!)quantity.evidenceRefs=work.sources.filter(source=>source.target==='QUANTITY'&&source.componentId===quantity.componentId).flatMap(source=>source.evidence.map(ref=>ref.evidenceId)).sort();
}
async function b2NwGroupComplete(f:WindowsNativeFixture,x:Prepared){
  const ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'});await b2CoverageQuantity(f,x,ready,true);const operations:{operationId:string;eventId:string;outcome:'RETURNED'}[]=[];
  for(const source of [...ready.work.sources]){
    const target=source.target,fact=target==='PROVIDER'?ready.work.facts.provider!:target==='ALLOCATION'?ready.work.facts.allocation!:ready.work.facts.quantities!.find(q=>q.componentId===source.componentId)!,{evidenceRefs:_refs,...body}=fact,operationId=randomUUID(),eventId=randomUUID(),evidence=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId,eventId,fact:body});
    ready.work.sources.push({sourceOperationId:operationId,sourceEventId:eventId,target,componentId:source.componentId,evidence:[evidence]});ready.work.joinedEvidence.push(evidence);operations.push({operationId,eventId,outcome:'RETURNED'});
  }
  ready.work.terminationEvidence.push(await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations}));b2NwGroupSort(ready.work);return ready;
}

it('W4-B2 nonWindows group comparison preserves complete groups refs forward proofs and null boundaries',async()=>withPrepared(async(f,x)=>{
  await b2InstallNwGroupDiagnostic(f);const effects=await b2IoBijectionSideEffects(f),ready=await b2NwGroupComplete(f,x),work=ready.work,measurements:unknown[]=[];
  expect(work.sources).toHaveLength(6);expect(work.facts.provider!.evidenceRefs).toHaveLength(2);expect(work.facts.allocation!.evidenceRefs).toHaveLength(2);expect(work.facts.quantities![0].evidenceRefs).toHaveLength(2);
  const compare=async(label:string,value:unknown,expected:boolean)=>measurements.push({label,...await b2NwGroupPair(f,x,value,expected)});
  await compare('COMPLETE_THREE_GROUPS_TWO_SOURCES_EACH',work,true);const reordered=structuredClone(work);reordered.sources.reverse();reordered.joinedEvidence.reverse();reordered.terminationEvidence.reverse();await compare('SOURCE_JOINED_END_ORDER_PRESERVED',reordered,true);
  const variants:[string,(value:OperationalStageCostWorkSet)=>void][]=[
    ['PROVIDER_REFS_MISSING',v=>{v.facts.provider!.evidenceRefs.pop();}],
    ['ALLOCATION_REFS_EXTRA',v=>{v.facts.allocation!.evidenceRefs.push(v.facts.provider!.evidenceRefs[0]);}],
    ['QUANTITY_REFS_DUPLICATE',v=>{v.facts.quantities![0].evidenceRefs[1]=v.facts.quantities![0].evidenceRefs[0];}],
    ['PROVIDER_REFS_ORDER',v=>{v.facts.provider!.evidenceRefs.reverse();}],
    ['ALLOCATION_REFS_ORDER',v=>{v.facts.allocation!.evidenceRefs.reverse();}],
    ['QUANTITY_REFS_ORDER',v=>{v.facts.quantities![0].evidenceRefs.reverse();}],
    ['DIFFERENT_TARGET_REFS',v=>{v.facts.provider!.evidenceRefs=[...v.facts.allocation!.evidenceRefs];}],
    ['SOURCE_EVIDENCE_DIGEST',v=>{v.sources[0].evidence[0].evidenceDigest=sha256('changed-original-source');}],
    ['SOURCE_TUPLE_DUPLICATE',v=>{v.sources.push(structuredClone(v.sources[0]));}],
    ['JOINED_REF_DUPLICATE',v=>{v.joinedEvidence.push(structuredClone(v.joinedEvidence[0]));}],
    ['ORIGINAL_END_MISSING',v=>{v.terminationEvidence=[];}],
  ];
  for(const [label,change] of variants){const value=structuredClone(work);change(value);await compare(label,value,false);}
  await compare('SQL_NULL_WORK',undefined,false);await compare('JSON_NULL_WORK',null,false);await compare('JSON_NULL_SOURCES',{...work,sources:null},false);
  const missingKey=structuredClone(work) as unknown as {sources:Record<string,unknown>[]};delete missingKey.sources[0].componentId;await compare('SQL_NULL_COMPONENT_MISSING_KEY_OUTSIDE_CLOSED_SHAPE',missingKey,false);
  const numericKey=structuredClone(work) as unknown as {sources:Record<string,unknown>[]};numericKey.sources.find(s=>s.target==='QUANTITY')!.componentId=1;await compare('NUMERIC_COMPONENT_OUTSIDE_CAPTURED_CONTRACT',numericKey,false);
  const errorSnapshot=await f.worker.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await f.worker.accountContext(client,f.seed.accountId,true);const identity=async()=>(await client.query('SELECT current_user AS role,manga_web.current_account()::text AS account,pg_current_snapshot()::text AS snapshot')).rows[0],before=await identity();
    for(const candidate of [false,true]){await client.query('SAVEPOINT nw_diagnostic_error');try{await expect(client.query('SELECT manga_web.w4b2_test_non_windows_group($1::jsonb,$2::jsonb,$3::boolean)',[JSON.stringify(work),JSON.stringify({...x.owner,executionId:'not-a-uuid'}),candidate])).rejects.toMatchObject({code:'22P02'});}finally{await client.query('ROLLBACK TO SAVEPOINT nw_diagnostic_error');await client.query('RELEASE SAVEPOINT nw_diagnostic_error');}}
    expect(await identity()).toEqual(before);expect(before).toMatchObject({role:'trio_web_worker',account:f.seed.accountId});return before.snapshot as string;
  });
  measurements.push({label:'OWNER_UUID_DECLARATION_ERROR',snapshot:errorSnapshot,sameSnapshot:true,originalSqlState:'22P02',candidateSqlState:'22P02'});expect(await b2IoBijectionSideEffects(f)).toEqual(effects);
  console.info(JSON.stringify({w4b2NwGroupShapes:{sources:work.sources.length,groups:3,measurements,sideEffectsUnchanged:true,productSqlMutatedByDiagnostic:false,claims:'유효 전체 비Windows 자료와 경계의 함수 판정만 비교한다. 비용 봉인과 정산 양성은 주장하지 않는다.'}}));
},f=>b2CoveragePrepare(f,'QUANTITY')),180000);

it.each(b2CoverageCases)('W4-B2 nonWindows group comparison fact-only $target $refs preserves reverse coverage refusal',async({target,refs})=>withPrepared(async(f,x)=>{
  await b2InstallNwGroupDiagnostic(f);const effects=await b2IoBijectionSideEffects(f),ready=await zeroWindowsWork(f,x,{providerUsd:'0.02',omitSourceTargets:target==='QUANTITY'?[]:[target]});if(target==='QUANTITY')await b2CoverageQuantity(f,x,ready,false);
  const fact=target==='PROVIDER'?ready.work.facts.provider!:target==='ALLOCATION'?ready.work.facts.allocation!:ready.work.facts.quantities![0];fact.evidenceRefs=refs==='EMPTY'?[]:[ready.work.sources[0].evidence[0].evidenceId];
  const rows=await b2CoverageSourceRows(f,x);expect(rows.filter(row=>b2CoverageMatches(row.fact,target))).toHaveLength(0);const pair=await b2NwGroupPair(f,x,ready.work,false);expect(await b2IoBijectionSideEffects(f)).toEqual(effects);
  console.info(JSON.stringify({w4b2NwGroupFactOnly:{target,refs,matchingOriginalSourceRows:0,pair,sideEffectsUnchanged:true}}));
},f=>b2CoveragePrepare(f,target)),120000);

it('W4-B2 nonWindows group comparison isolated JSONB keys preserve numeric scale text and explicit null distinctions',async()=>withPrepared(async(f)=>{
  const value=await f.worker.accountTransaction(f.seed.accountId,async tx=>{
    expect((await tx.client.query('SELECT current_user AS role,manga_web.current_account()::text AS account')).rows[0]).toEqual({role:'trio_web_worker',account:f.seed.accountId});
    return (await tx.client.query(`SELECT
      '1'::jsonb='1.0'::jsonb AS numeric_scale_equal,
      '1'::jsonb='"1"'::jsonb AS text_numeric_equal,
      array_position(ARRAY['["QUANTITY",1]'::jsonb],'["QUANTITY",1.0]'::jsonb) AS numeric_group_position,
      array_position(ARRAY['["QUANTITY",1]'::jsonb],'["QUANTITY","1"]'::jsonb) AS text_group_position,
      ('{"componentId":null}'::jsonb->'componentId')=('{}'::jsonb->'componentId') AS missing_key_equality,
      ('{"componentId":null}'::jsonb->'componentId')=(' {"componentId":null}'::jsonb->'componentId') AS explicit_null_equality,
      jsonb_build_array('QUANTITY','{}'::jsonb->'componentId')=jsonb_build_array('QUANTITY','{"componentId":null}'::jsonb->'componentId') AS missing_key_normalizes_to_null`)).rows[0];
  },true);
  expect(value).toEqual({numeric_scale_equal:true,text_numeric_equal:false,numeric_group_position:1,text_group_position:null,missing_key_equality:null,explicit_null_equality:true,missing_key_normalizes_to_null:true});
  console.info(JSON.stringify({w4b2NwGroupKeys:{value,claims:'집계 키의 JSONB 의미만 관측했다. 누락 키와 숫자 component를 지원 계약으로 확대하지 않으며 원 닫힌 자료 검증의 거부를 유지한다.'}}));
}));

it('W4-B2 nonWindows group comparison profiles complete original 1024 I/O and 256 semantic sources without sealing',async()=>withPrepared(async(f,x)=>{
  await b2InstallNwGroupDiagnostic(f);const effects=await b2IoBijectionSideEffects(f);await b2IoBijectionFixture(f,x,1024);await renewObserved(f,x,'nw-group-before-source-assembly');const ready=await zeroWindowsWork(f,x,{rich:true,providerUsd:'0.014'});b2NwGroupSort(ready.work);
  const count=(await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends en JOIN manga_web.windows_native_cost_io_starts st USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2) ends,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE') source_rows`,[f.seed.accountId,x.owner.executionId])).rows[0];
  expect(count).toEqual({starts:1024,ends:1024,source_rows:1282});expect(ready.work.sources).toHaveLength(1282);expect(ready.work.sources.filter(s=>s.target==='QUANTITY'&&s.componentId==='s'.repeat(128))).toHaveLength(1024);expect(ready.work.sources.filter(s=>s.target==='QUANTITY'&&s.componentId==='m'.repeat(128))).toHaveLength(256);
  const refs=ready.work.sources.reduce((n,s)=>n+s.evidence.length,0),groups=new Set(ready.work.sources.map(s=>JSON.stringify([s.target,s.componentId]))).size,workBytes=Buffer.byteLength(JSON.stringify(ready.work));expect(refs).toBe(1282);expect(groups).toBe(4);expect(ready.work.joinedEvidence.length+ready.work.terminationEvidence.length).toBeLessThanOrEqual(2046);expect(workBytes).toBeLessThanOrEqual(1048576);
  await renewObserved(f,x,'nw-group-before-statements');const pair=await b2NwGroupPair(f,x,ready.work,true);expect(await b2IoBijectionSideEffects(f)).toEqual(effects);
  console.info(JSON.stringify({w4b2NwGroupProfile:{count,sources:ready.work.sources.length,groupCount:groups,boundedCachedReferenceItems:refs,workBytes,pair,sideEffectsUnchanged:true,productSqlMutatedByDiagnostic:false,claims:'완전한 원 비Windows 함수 입력의 판정과 함수 시간만 비교한다. 키·배열·임시 할당이 추가되므로 총 메모리 불변을 주장하지 않는다. 전체 봉인·정산·30초 최종 거래는 미검증이다.'}}));
},f=>prepareWithBasis(f,snapshot=>({...snapshot,components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/windows']},{componentId:'z'.repeat(128),kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/absence']},{componentId:'s'.repeat(128),kind:'STORAGE',unit:'b'.repeat(128),rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/storage']},{componentId:'m'.repeat(128),kind:'RENDER',unit:'e'.repeat(128),rateVersion:'r'.repeat(128),usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:w4b2/semantic']}]}),[{task:'DECODE_IMAGE',componentId:'native-image'},{task:'POLYGON_MASK',componentId:'z'.repeat(128)}])),180000);

// B3-B: 기존 본문을 보존하고 실제 W2/PG 자료로 SQL 경계를 별도 검사한다.
import {createB3WindowsRemoteFixture} from '../fixtures/windows-native.js';
import type {NativeSealedReceiptV2} from '../../packages/domain/src/native-receipts.js';
import type {Transaction} from '../../packages/storage/src/database.js';
import {readFile as b3ReadFile} from 'node:fs/promises';

const b3OwnerSql=(await b3ReadFile(new URL('../../db/migrations/0024_windows_stage_cost_seal.sql',import.meta.url),'utf8'))
  .match(/CREATE FUNCTION windows_stage_cost_owner\([\s\S]*?END \$\$;/)![0]
  .replace('CREATE FUNCTION windows_stage_cost_owner(','CREATE OR REPLACE FUNCTION manga_web.windows_stage_cost_owner(')
  .replace('o jsonb;n integer;','o jsonb;n integer;scope_row record;')
  .replace(" OR\r\n  EXISTS(SELECT 1 FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id AND protected_scope->'owner' IS DISTINCT FROM o)",'')
  .replace(' RETURN o;',[
    ' FOR scope_row IN SELECT * FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id LOOP',
    "  IF (scope_row.protected_scope->'owner')-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR",
    "   scope_row.protected_scope->>'scopeId' IS DISTINCT FROM scope_row.scope_id::text OR scope_row.protected_scope->>'scopeDigest' IS DISTINCT FROM scope_row.scope_digest OR",
    '   manga_web.windows_native_cost_scope_history_valid(scope_row.protected_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;',
    ' END LOOP;',' RETURN o;',
  ].join('\r\n'));
// ORIGINAL RED에서 선행 owner만 분리한다. OID/ACL/본문 원복까지 검사한다.
async function b3OwnerIsolation<T>(f:WindowsNativeFixture,run:(tx:Transaction)=>Promise<T>):Promise<T>{
  const observe=async()=>(await f.admin.pool.query("SELECT oid::text,proacl::text,proowner::text,prosrc FROM pg_proc WHERE oid='manga_web.windows_stage_cost_owner(jsonb)'::regprocedure")).rows;
  const before=await observe(),rollback=new Error('B3B_OWNER_ISOLATION_ROLLBACK');let result:T|undefined,completed=false;
  try{await f.admin.accountTransaction(f.seed.accountId,async tx=>{
    await tx.client.query(b3OwnerSql);
    const installed=(await tx.client.query("SELECT oid::text,proacl::text,proowner::text FROM pg_proc WHERE oid='manga_web.windows_stage_cost_owner(jsonb)'::regprocedure")).rows;
    expect(installed).toEqual(before.map(({prosrc:_body,...metadata})=>metadata));
    await tx.client.query('SET LOCAL ROLE trio_web_worker');result=await run(tx);completed=true;throw rollback;
  },true);}catch(error){if(error!==rollback)throw error;}
  expect(completed).toBe(true);expect(await observe()).toEqual(before);return result!;
}
const b3Rates:FullStageCostSnapshot['components']=[
  {componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'fixture-separated-rate-v1',usdPerUnit:'0.01',evidenceRefs:['fixture:separated-unit']},
  {componentId:'semantic',kind:'RENDER',unit:'event',rateVersion:'w4b2-event-v1',usdPerUnit:'0.001',evidenceRefs:['fixture:semantic-unit']},
];
async function b3CheckpointBase(f:WindowsNativeFixture,capacity:Prepared['capacity'],rootAttempt=false){
  // 원 0012 profile과 INPUT/native profile ID를 같은 합성 버전으로 만든다.
  // 원 maxSlots/3·2/10/100 금액과 window는 그대로 복사한다.
  const profileId=randomUUID(),profile=(await f.operator.client.query("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) SELECT $1,jsonb_set(profile_payload,'{version}',to_jsonb($2::text)),$2,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end FROM manga_web.execution_limit_profiles WHERE profile_id=$3 RETURNING profile_digest",[profileId,syntheticProfile.id,f.requestPolicy.executionLimit!.profileId])).rows[0];
  await f.operator.client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,revision=revision+1 WHERE singleton",[profileId]);
  f.requestPolicy.executionLimit={...f.requestPolicy.executionLimit!,profileId,profileDigest:profile.profile_digest,profileVersion:syntheticProfile.id};
  f.requestPolicy.parameterProfileVersion=syntheticProfile.id;
  const bytes=Buffer.from(ownedNativePng,'base64'),originalAssets=(await f.admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1',[f.seed.accountId])).rows;
  for(const asset of originalAssets)await f.files.put(f.seed.accountId+'/'+asset.asset_id,bytes);
  await f.admin.pool.query("UPDATE manga_web.assets SET bucket_ref=$2,object_key=account_id::text||'/'||asset_id::text,sha256=$3,bytes_length=$4,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId,f.files.bucket,sha256(bytes),String(bytes.length)]);
  const source=await f.checkpointRetry(),sourceBasis=await f.seedBasis(source.input);
  expect(await f.service.validateCheckpoints(source.claim)).toBe(true);
  const transaction=f.worker.transaction.bind(f.worker);let enrolled:unknown=null;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{
    const answer=await run(client),rows=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[f.seed.accountId])).rows;
    if(rows.length){expect(rows).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) value',[JSON.stringify({evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest})])).rows[0].value;}return answer;
  }));
  let input:import('../../packages/domain/src/provider.js').StageInput|null=null;
  try{input=await f.service.authorize(source.claim);}finally{spy.mockRestore();}
  expect(input).not.toBeNull();expect(enrolled).not.toBeNull();
  const basis=await separatedConsumerBasis(f,input!,b3Rates);
  const assets=(await f.admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1',[f.seed.accountId])).rows;
  for(const asset of assets)await f.files.put(f.seed.accountId+'/'+asset.asset_id,bytes);
  await f.admin.pool.query("UPDATE manga_web.assets SET bucket_ref=$2,object_key=account_id::text||'/'||asset_id::text,sha256=$3,bytes_length=$4,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId,f.files.bucket,sha256(bytes),String(bytes.length)]);
  const validation=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,maxTargets:64,maxJobs:64});
  const attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.beginIn(tx,input!,'PRE_DISPATCH'),true);
  expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0].sourceExecutionId).not.toBe(input!.executionId);
  const attemptRef=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'attemptId'=$3",[f.seed.accountId,input!.executionId,attempt.attemptId])).rows[0] as Ref;
  const costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),scopeOwner:WindowsNativeCostOwner={executionId:input!.executionId,inputEvidenceId:attempt.inputEvidenceId,inputFingerprint:attempt.inputFingerprint,basisRef:{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest},claim:{generation:source.claim.generation,ownerId:f.service.workerId,workItemId:source.claim.workId},validationAttemptRef:attemptRef};
  const owner={...scopeOwner,validationAttemptRef:rootAttempt?attemptRef:null},components:WindowsNativeCostComponent[]=[{task:'DECODE_IMAGE',componentId:'native-image'}];
  const root=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components),true);expect(root).not.toBeNull();
  const original=await f.originalIntent(source,'REQUEST_CHECKPOINT',source.retryId),output=(await f.admin.pool.query('SELECT output_envelope FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,source.input.executionId])).rows[0].output_envelope;
  const target:Prepared['target']={accountId:f.seed.accountId,targetKind:'REQUEST_CHECKPOINT',targetId:source.retryId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',source.retryId,source.input,output),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:scopeOwner.claim,sourceInput:original.sourceInput};
  const x:Prepared={costs,execution:{claim:source.claim,input:input!},original,owner,root,components,capacity,target,source:bytes};
  return {x,scopeOwner,source,sourceBasis,attempt,attemptRef,validation};
}
async function b3WithCheckpoint(run:(f:WindowsNativeFixture,remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>,base:Awaited<ReturnType<typeof b3CheckpointBase>>)=>Promise<void>,rootAttempt=false){
  const guard=guardWindowsNativeIo(),errors:unknown[]=[];let f:WindowsNativeFixture|undefined,remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>|undefined;
  try{f=await windowsNativeFixture(20.5);remote=await createB3WindowsRemoteFixture(f);await run(f,remote,await b3CheckpointBase(f,remote.capacity,rootAttempt));}catch(error){errors.push(error);}
  finally{try{await remote?.close();}catch(error){errors.push(error);}try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'B3B_SQL_AND_CLEANUP_FAILED');
}
async function b3Sealed(f:WindowsNativeFixture,jobId?:string):Promise<NativeSealedReceiptV2>{
  const rows=(await f.admin.pool.query("SELECT c.protected_candidate candidate,r.protected_receipt receipt,i.protected_intent intent,o.protected_observation->'termination' termination FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.native_job_observations o ON o.account_id=c.account_id AND o.job_id=c.job_id AND o.event='TERMINATION' WHERE c.account_id=$1 AND($2::uuid IS NULL OR c.job_id=$2) ORDER BY c.candidate_id",[f.seed.accountId,jobId??null])).rows;
  expect(rows).toHaveLength(1);const {isolation:_isolation,...termination}=rows[0].termination;
  return {...rows[0],termination,origin:'FRESH'} as NativeSealedReceiptV2;
}
it('B3-B owner public CENSUS preserves root full owner and accepts exact historical checkpoint scope authority',async()=>b3WithCheckpoint(async(f,_remote,{x,scopeOwner,attempt})=>{
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,scopeOwner,x.target,'CHECKPOINT',digest(attempt.targets[0]),randomUUID()),true);expect(scope).not.toBeNull();
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}),true)).toBe('JOINED');
  expect(await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_native_cost_scope_history_valid($1::jsonb) value',[JSON.stringify(scope)])).rows[0].value,true)).toBe(true);
  const census=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});
  expect(census,'B3-B owner RED: stored root and exact checkpoint scope may differ in attempt ref').not.toBeNull();expect(census!.owner).toEqual(x.owner);expect(census!.rows.filter(r=>r.kind==='SCOPE')).toHaveLength(1);
}),120000);
it('B3-B original public ORIGINAL accepts original checkpoint job under exact owner prerequisite rollback',async()=>b3WithCheckpoint(async(f,remote,{x,scopeOwner,attempt})=>{
  expect(await remote.gateway.forCostOwner(x.target,scopeOwner,'CHECKPOINT',digest(attempt.targets[0])).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
  const sealed=await b3Sealed(f),binding=(await f.admin.pool.query('SELECT protected_binding FROM manga_web.native_controller_attempts WHERE account_id=$1 AND job_id=$2',[f.seed.accountId,sealed.candidate.jobId])).rows[0].protected_binding,key={binding,expected:sealed.candidate.windowsEvidenceRef};
  const original=await b3OwnerIsolation(f,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify({version:1,mode:'ORIGINAL',owner:x.owner,key})])).rows[0].value);
  expect(original,'B3-B original RED under exact owner candidate; original scope must retain its own full authority').not.toBeNull();expect(original.key).toEqual(key);
}),120000);


async function b3NonWindowsReady(f:WindowsNativeFixture,remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>,base:Awaited<ReturnType<typeof b3CheckpointBase>>){
  const {x,scopeOwner,attempt}=base,target=attempt.targets[0];
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const semanticId=randomUUID(),eventId=randomUUID();
  expect(await remote.gateway.forCostOwner(x.target,scopeOwner,'CHECKPOINT',digest(target)).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
  const sealed=await b3Sealed(f),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,scopeOwner,x.target,'CHECKPOINT',digest(target),randomUUID()),true);expect(scope).not.toBeNull();
  const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('B3B actual checkpoint storage'),componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:1048576,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),storage:CheckpointValidationOperation['storage']=[],endRefs:Ref[]=[];
  for(const asset of target.assets){
    const result=await io.read({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ',key:asset.objectKey,expected:{sha256:asset.sha256,bytesLength:asset.bytesLength}});
    expect(result.state).toBe('RETURNED');if(result.state!=='RETURNED')throw new Error('B3B_ACTUAL_READ_REQUIRED');
    expect(sha256(result.value)).toBe(asset.sha256);expect(String(result.value.length)).toBe(asset.bytesLength);endRefs.push(result.event.ended!);
    storage.push({eventId:result.event.eventId,kind:'OBJECT_READ',assetId:asset.assetId,sha256:sha256(result.value),bytesLength:String(result.value.length),outcome:'RETURNED'});
  }
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:endRefs}),true)).toBe('JOINED');
  const operation:Omit<CheckpointValidationOperation,'native'>&{native:NativeSealedReceiptV2[]}={version:1,operationId:semanticId,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest,semantic:{eventId,kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage,native:[sealed]};
  const operationRef=await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',operation),ready=await zeroWindowsWork(f,x,{providerUsd:'0.02'}),fact={componentId:'semantic',captureDigest:ready.basis.captureDigest,state:'CONFIRMED' as const,quantity:'1',unit:'event'},source=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,operationId:semanticId,eventId,fact}),term=await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId:semanticId,eventId,outcome:'RETURNED'}]});
  ready.work.sources.push({sourceOperationId:semanticId,sourceEventId:eventId,target:'QUANTITY',componentId:'semantic',evidence:[source,operationRef]});
  ready.work.joinedEvidence.push(source,operationRef);ready.work.terminationEvidence.push(term);ready.work.facts.quantities!.push({...fact,evidenceRefs:[source.evidenceId,operationRef.evidenceId].sort()});
  return {...ready,sealed,operation,operationRef};
}
function b3OmitOperation(work:OperationalStageCostWorkSet,operation:Ref){
  const result=structuredClone(work);
  result.joinedEvidence=result.joinedEvidence.filter(r=>r.evidenceId!==operation.evidenceId);
  for(const source of result.sources)source.evidence=source.evidence.filter(r=>r.evidenceId!==operation.evidenceId);
  for(const q of result.facts.quantities!)q.evidenceRefs=q.evidenceRefs.filter(id=>id!==operation.evidenceId);
  return result;
}
async function b3RollbackSeal(f:WindowsNativeFixture,x:Prepared,candidate:Awaited<ReturnType<typeof sqlCandidate>>){
  return f.worker.accountTransaction(f.seed.accountId,async tx=>{
    await tx.client.query('SAVEPOINT b3b_control');
    try{return (await tx.client.query('SELECT manga_web.windows_stage_cost_seal($1::jsonb,$2::jsonb) value',[JSON.stringify(x.owner),JSON.stringify(candidate)])).rows[0].value;}
    finally{await tx.client.query('ROLLBACK TO SAVEPOINT b3b_control');await tx.client.query('RELEASE SAVEPOINT b3b_control');}
  },true);
}
it('B3-B non_windows public SEAL accepts actual v2 PRE only after complete coverage rate raw membership rollback control',async()=>b3WithCheckpoint(async(f,remote,base)=>{
  const {x}=base,ready=await b3NonWindowsReady(f,remote,base);
  expect(await f.service.renew(x.execution.claim)).toBe(true);
  const fullWork=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.candidateIn(tx,x.execution.input,ready.basis),true);expect(fullWork).not.toBeNull();
  const control=await sqlCandidate(f,x,b3OmitOperation(fullWork!,ready.operationRef),b3OmitOperation(ready.work,ready.operationRef));
  const positive=await b3RollbackSeal(f,x,control);expect(positive,'원 SOURCE/fact/종료·단가·최신 raw/membership 정상 rollback 대조').not.toBeNull();
  const candidate=await sqlCandidate(f,x,fullWork!,ready.work);
  const gates=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_amount($1::jsonb,$2::jsonb) amount,manga_web.windows_stage_cost_non_windows($3::jsonb,$4::jsonb) coverage',[JSON.stringify(ready.basis),JSON.stringify(candidate.workSet.facts),JSON.stringify(control.nonWindowsWorkSet),JSON.stringify(x.owner)])).rows[0],true);
  expect(gates.coverage).toBe(true);expect(gates.amount).not.toBeNull();expect(candidate.rawSetDigest).toBe(control.rawSetDigest);
  expect(await b3RollbackSeal(f,x,candidate),'B3-B non_windows RED: actual W2 candidate/proof with complete separate source/end').not.toBeNull();
  console.info(JSON.stringify({b3bSqlNonWindowsRed:{gates,actualSourceDifferent:base.source.input.executionId!==x.owner.executionId,operationNative:ready.operation.native.length,normalRollback:true}}));
},true),120000);


// 직접 SQL 공격에서도 원 OP body/hash와 모든 비용 참조를 함께 갱신한다.
async function b3RewriteOperation(f:WindowsNativeFixture,x:Prepared,old:Ref,operation:unknown){
  const row=(await f.admin.pool.query('SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,old.evidenceId])).rows[0];
  const wrapper={...row.protected_observation,value:operation},ref={evidenceId:old.evidenceId,evidenceDigest:digest(wrapper)};
  await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$4,evidence_digest=$5 WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3',[f.seed.accountId,x.owner.executionId,old.evidenceId,JSON.stringify(wrapper),ref.evidenceDigest]);return ref;
}
function b3RefreshOperationRefs(work:OperationalStageCostWorkSet,before:Ref,after:Ref){
  const result=structuredClone(work),change=(ref:Ref)=>ref.evidenceId===before.evidenceId?after:ref;
  result.joinedEvidence=result.joinedEvidence.map(change);result.terminationEvidence=result.terminationEvidence.map(change);
  for(const source of result.sources)source.evidence=source.evidence.map(change);return result;
}
it.each(['EMPTY_NATIVE','EXTRA_CANDIDATE','EXTRA_PROOF','PROOF_REF','VERSION_ONE','CACHE_WITHOUT_USE','DUPLICATE','OTHER_ATTEMPT','OTHER_TARGET'] as const)(
'B3-B SQL direct native attack %s retains coverage rate latest raw membership and normal rollback',async fault=>b3WithCheckpoint(async(f,remote,base)=>{
  const {x}=base,ready=await b3NonWindowsReady(f,remote,base);
  expect(await f.service.renew(x.execution.claim)).toBe(true);
  const work=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.candidateIn(tx,x.execution.input,ready.basis),true);expect(work).not.toBeNull();
  const normal=await sqlCandidate(f,x,work!,ready.work);expect(await b3RollbackSeal(f,x,normal)).not.toBeNull();
  const operation=structuredClone(ready.operation);
  if(fault==='EMPTY_NATIVE')operation.native=[];
  else if(fault==='EXTRA_CANDIDATE')Object.assign(operation.native[0].candidate,{extra:true});
  else if(fault==='EXTRA_PROOF')Object.assign(operation.native[0].receipt,{extra:true});
  else if(fault==='PROOF_REF')operation.native[0].receipt.windowsEvidenceRef.linkDigest=sha256('B3 wrong proof link');
  else if(fault==='VERSION_ONE')Object.assign(operation.native[0].candidate,{version:1});
  else if(fault==='CACHE_WITHOUT_USE')operation.native[0].origin='CACHE';
  else if(fault==='DUPLICATE')operation.native.push(structuredClone(operation.native[0]));
  else if(fault==='OTHER_ATTEMPT'){operation.attemptId=randomUUID();operation.attemptDigest=sha256('B3 other attempt');}
  else operation.targetDigest=sha256('B3 other target');
  const changed=await b3RewriteOperation(f,x,ready.operationRef,operation),nonWindows=b3RefreshOperationRefs(ready.work,ready.operationRef,changed);
  const nextWork=await f.worker.accountTransaction(f.seed.accountId,tx=>new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows:{nonWindowsIn:async()=>nonWindows,checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds}}).candidateIn(tx,x.execution.input,ready.basis),true);expect(nextWork).not.toBeNull();
  const candidate=await sqlCandidate(f,x,nextWork!,nonWindows),gates=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_stage_cost_amount($1::jsonb,$2::jsonb) amount',[JSON.stringify(ready.basis),JSON.stringify(candidate.workSet.facts)])).rows[0],true);
  expect(gates.amount).not.toBeNull();expect(candidate.rawSetDigest).not.toBe(normal.rawSetDigest);
  expect(await b3RollbackSeal(f,x,candidate),'메인 checkpoint TS 검증을 호출하지 않은 직접 public SEAL').toBeNull();
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2) seals,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_allocations WHERE account_id=$1 AND execution_id=$2) allocations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE')) costs",[f.seed.accountId,x.owner.executionId])).rows).toEqual([{seals:0,allocations:0,costs:0}]);
  console.info(JSON.stringify({b3bDirectNativeAttack:{fault,normalRollback:true,latestRaw:true,amount:gates.amount,submitted:operation.native.length}}));
},true),120000);

type B3Operation={operation:CheckpointValidationOperation;ref:Ref};
async function b3CollectOperation(f:WindowsNativeFixture,remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>,base:Awaited<ReturnType<typeof b3CheckpointBase>>,attempt:CheckpointValidationAttempt,target:CheckpointValidationTarget,native:boolean,existing?:Ref):Promise<B3Operation>{
  const {x}=base,rows=(await f.admin.pool.query("SELECT i.protected_observation input,c.output_envelope output FROM manga_web.execution_evidence i JOIN manga_web.checkpoints c USING(account_id,execution_id) WHERE i.account_id=$1 AND i.evidence_id=$2 AND i.kind='INPUT'",[f.seed.accountId,target.input.evidenceId])).rows;expect(rows).toHaveLength(1);
  const source=rows[0].input as import('../../packages/domain/src/provider.js').StageInput,output=rows[0].output as import('../../packages/domain/src/provider.js').Observation;
  const attemptRef=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_ATTEMPT' AND protected_observation->'value'->>'attemptId'=$3",[f.seed.accountId,x.owner.executionId,attempt.attemptId])).rows[0] as Ref;
  const scopeOwner={...x.owner,validationAttemptRef:attemptRef},sourceTarget:Prepared['target']={accountId:f.seed.accountId,targetKind:'REQUEST_CHECKPOINT',targetId:x.execution.input.requestId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',x.execution.input.requestId,source,output),protectedOwnerCapture:attempt.owner,claim:scopeOwner.claim,sourceInput:{executionId:source.executionId,inputEvidenceId:target.input.evidenceId,stageInputDigest:source.inputDigest}};
  const operationId=randomUUID(),eventId=randomUUID();expect(digest(normalizeObservation(source,output))).toBe(target.outputDigest);
  let receipts:NativeSealedReceiptV2[]=[];
  if(native){
    expect(await remote.gateway.forCostOwner(sourceTarget,scopeOwner,'CHECKPOINT',digest(target)).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
    const cache=(await f.admin.pool.query("SELECT cu.protected_source FROM manga_web.windows_native_cost_cache_uses cu JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id) JOIN manga_web.windows_native_cost_scopes sc USING(account_id,scope_id) WHERE cu.account_id=$1 AND cc.execution_id=$2 AND sc.protected_scope->'owner'->'validationAttemptRef'=$3::jsonb AND sc.protected_scope->>'validationTargetDigest'=$4 ORDER BY cu.created_at DESC",[f.seed.accountId,x.owner.executionId,JSON.stringify(attemptRef),digest(target)])).rows;
    receipts=[cache.length?cache[0].protected_source as NativeSealedReceiptV2:await b3Sealed(f)];
  }
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,scopeOwner,sourceTarget,'CHECKPOINT',digest(target),randomUUID()),true);expect(scope).not.toBeNull();
  const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('B3 actual dependency read '+operationId),componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
  const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:1048576,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupIoIn(tx,r),true)}),storage:CheckpointValidationOperation['storage']=[],ends:Ref[]=[];
  for(const asset of target.assets){const read=await io.read({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ',key:asset.objectKey,expected:{sha256:asset.sha256,bytesLength:asset.bytesLength}});expect(read.state).toBe('RETURNED');if(read.state!=='RETURNED')throw new Error('B3_FINAL_ACTUAL_READ_REQUIRED');expect(sha256(read.value)).toBe(asset.sha256);expect(String(read.value.length)).toBe(asset.bytesLength);ends.push(read.event.ended!);storage.push({eventId:read.event.eventId,kind:'OBJECT_READ',assetId:asset.assetId,sha256:sha256(read.value),bytesLength:String(read.value.length),outcome:'RETURNED'});}
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:ends}),true)).toBe('JOINED');
  const operation:CheckpointValidationOperation={version:1,operationId,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest,semantic:{eventId,kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage,native:receipts};
  return {operation,ref:existing??await putOriginal(f,x,'CHECKPOINT_VALIDATION_OPERATION',operation)};
}
async function b3CostWork(f:WindowsNativeFixture,x:Prepared,operations:B3Operation[],extra:Ref[]){
  const basis=(await f.admin.pool.query("SELECT protected_observation->'value' body FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2",[f.seed.accountId,x.owner.basisRef.evidenceId])).rows[0].body as FullStageCostBasis;
  const provider={scope:'ACTUAL_AI_USD' as const,captureDigest:basis.captureDigest,state:'CONFIRMED' as const,actualUsd:'0.01'},allocation={captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:'FREE_OPERATIONS' as const,basisVersion:basis.snapshot!.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'},semantic={componentId:'semantic',captureDigest:basis.captureDigest,state:'CONFIRMED' as const,quantity:String(operations.length),unit:'event'};
  const sources:OperationalStageCostWorkSet['sources']=[],terminationEvidence:Ref[]=[];
  const io=(await f.admin.pool.query<{protected_event:WindowsCostedIoEvent}>('SELECT en.protected_event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 ORDER BY st.operation_id',[f.seed.accountId,x.owner.executionId])).rows;
  const sourceFacts=[{target:'PROVIDER' as const,componentId:null,fact:provider,operationId:sha256('B3 provider').slice(0,32),eventId:sha256('B3 provider event').slice(0,32),extra:[] as Ref[],io:null as WindowsCostedIoEvent|null},{target:'ALLOCATION' as const,componentId:null,fact:allocation,operationId:sha256('B3 allocation').slice(0,32),eventId:sha256('B3 allocation event').slice(0,32),extra:[] as Ref[],io:null as WindowsCostedIoEvent|null}];
  // 이 가짜 비용 reader의 실제 ID는 DB 원자료가 최초 생성될 때만 만든다.
  const ids=(await f.admin.pool.query("SELECT protected_observation->'value' v FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE' AND protected_observation->'value'->'fact' ? 'scope' AND NOT(protected_observation->'value' ? 'io')",[f.seed.accountId,x.owner.executionId])).rows;
  const allocationIds=(await f.admin.pool.query("SELECT protected_observation->'value' v FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE' AND protected_observation->'value'->'fact' ? 'funding'",[f.seed.accountId,x.owner.executionId])).rows;
  expect(ids.length).toBeLessThanOrEqual(1);expect(allocationIds.length).toBeLessThanOrEqual(1);
  for(const [index,existing] of [ids,allocationIds].entries()){sourceFacts[index].operationId=existing[0]?.v.operationId??randomUUID();sourceFacts[index].eventId=existing[0]?.v.eventId??randomUUID();}
  const all=[...sourceFacts,...io.map(({protected_event:v})=>({target:'PROVIDER' as const,componentId:null,fact:provider,operationId:v.operationId,eventId:v.eventId,extra:[] as Ref[],io:v})),...operations.map((entry,index)=>({target:'QUANTITY' as const,componentId:'semantic',fact:semantic,operationId:entry.operation.operationId,eventId:entry.operation.semantic.eventId,extra:[entry.ref,...(index===0?extra:[])],io:null}))];
  for(const item of all){
    const value={version:1,operationId:item.operationId,eventId:item.eventId,fact:item.fact,...(item.io?{io:item.io}:{})},existing=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\",protected_observation->'value' value FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE' AND protected_observation->'value'->>'operationId'=$3 AND protected_observation->'value'->>'eventId'=$4",[f.seed.accountId,x.owner.executionId,item.operationId,item.eventId])).rows;
    expect(existing.length).toBeLessThanOrEqual(1);if(existing.length)expect(existing[0].value).toEqual(value);
    const ref:Ref=existing.length?{evidenceId:existing[0].evidenceId,evidenceDigest:existing[0].evidenceDigest}:await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',value);
    sources.push({sourceOperationId:item.operationId,sourceEventId:item.eventId,target:item.target,componentId:item.componentId,evidence:[ref,...item.extra]});
    const ends=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION' AND protected_observation->'value'->'operations' @> $3::jsonb",[f.seed.accountId,x.owner.executionId,JSON.stringify([{operationId:item.operationId,eventId:item.eventId,outcome:'RETURNED'}])])).rows;
    expect(ends.length).toBeLessThanOrEqual(1);terminationEvidence.push(ends.length?ends[0] as Ref:await putOriginal(f,x,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId:item.operationId,eventId:item.eventId,outcome:'RETURNED'}]}));
  }
  const outcomes=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME'",[f.seed.accountId,x.owner.executionId])).rows as Ref[];
  const refs=(target:string)=>sources.filter(s=>s.target===target).flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();
  const work:OperationalStageCostWorkSet={version:1,executionId:x.owner.executionId,inputFingerprint:x.owner.inputFingerprint,captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(s=>s.evidence),terminationEvidence:[...terminationEvidence,...outcomes],sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER')},allocation:{...allocation,evidenceRefs:refs('ALLOCATION')},quantities:[{...semantic,evidenceRefs:refs('QUANTITY')}]}};
  const reader=new WindowsStageCostReader({db:f.worker,windows:x.costs,nonWindows:{nonWindowsIn:async()=>structuredClone(work),checkpointFactsIn:async()=>null},bounds:{...windowsStageCostBounds}});
  return {basis,work,reader};
}
async function b3FinalReady(f:WindowsNativeFixture,remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>,base:Awaited<ReturnType<typeof b3CheckpointBase>>){
  const {x,attempt,validation}=base;
  expect(await f.service.preflight(x.execution.claim,x.execution.input)).toBe(true);
  const pre=await b3CollectOperation(f,remote,base,attempt,attempt.targets[0],true);
  const verifiedPre=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.recordIn(tx,x.execution.input,attempt,{attemptId:attempt.attemptId,operations:[pre.ref]}),true);expect(verifiedPre.state,'실제 PRE recordIn').toBe('VERIFIED');
  // E2와 동일한 경계: 성공 실행/OUTCOME/checkpoint는 합성 선행 자료다.
  const input=x.execution.input,raw=f.provider.success(input),checkpointId=randomUUID(),observation=normalizeObservation(input,{...raw,stageOutput:{executionId:input.executionId,inputDigest:input.inputDigest,stageContract:input.settings.contractVersion,outcome:'CONFIRMED_SUCCESS',protectedEvidenceRef:raw.evidenceId,outputAssetIds:[],checkpointId,usageState:'CONFIRMED',actualCostUsd:raw.costUsd,finishReason:raw.finishReason}});
  await putOriginal(f,x,'OUTCOME',observation);
  await f.admin.pool.query("UPDATE manga_web.executions SET state='SUCCEEDED',output_envelope=$3,finished_confirmed_at=clock_timestamp(),start_confirmed_at=COALESCE(start_confirmed_at,clock_timestamp()) WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,x.owner.executionId,JSON.stringify(observation)]);
  await f.admin.pool.query("INSERT INTO manga_web.checkpoints(account_id,checkpoint_id,execution_id,stage_contract,dependency_digest,protected_manifest_ref,verification_state,output_envelope) VALUES($1,$2,$3,$4,$5,$3::uuid::text,'VERIFIED',$6)",[f.seed.accountId,checkpointId,x.owner.executionId,input.settings.contractVersion,input.inputDigest,JSON.stringify(observation)]);
  const final=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.beginIn(tx,input,'FINAL_COMMIT'),true);expect(final.targets).toHaveLength(2);
  const operations:B3Operation[]=[];for(const target of final.targets)operations.push(await b3CollectOperation(f,remote,base,final,target,target.sourceExecutionId!==x.owner.executionId));
  expect(operations.flatMap(op=>op.operation.native)).toHaveLength(1);expect(operations[0].operation.native[0].origin).toBe('CACHE');
  const verified=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.recordIn(tx,input,final,{attemptId:final.attemptId,operations:operations.map(op=>op.ref)}),true);expect(verified.state,'실제 FINAL recordIn').toBe('VERIFIED');
  const extra=(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED') ORDER BY evidence_id",[f.seed.accountId,x.owner.executionId])).rows as Ref[];
  return {pre,final,operations,extra,validation};
}
it('B3-B SQL wrong source CACHE direct SEAL rejects A receipt under B self target after normal A to A rollback',async()=>b3WithCheckpoint(async(f,remote,base)=>{
  const {x}=base,normal=await b3FinalReady(f,remote,base),ready=await b3CostWork(f,x,[normal.pre,...normal.operations],normal.extra);
  expect(await f.service.renew(x.execution.claim)).toBe(true);
  const work=await f.worker.accountTransaction(f.seed.accountId,tx=>ready.reader.candidateIn(tx,x.execution.input,ready.basis),true);expect(work).not.toBeNull();
  const candidate=await sqlCandidate(f,x,work!,ready.work);expect(await b3RollbackSeal(f,x,candidate),'정상 A→A FINAL CACHE와 self native=[] rollback').not.toBeNull();
  const self=normal.final.targets.find(t=>t.sourceExecutionId===x.owner.executionId)!,prior=normal.operations.find(op=>op.operation.targetDigest===digest(self))!,wrong=await b3CollectOperation(f,remote,base,normal.final,self,true,prior.ref);
  // 새 OP 대신 기존 self OP의 원 semantic/storage ID를 보존하여 native만 공격한다.
  const operation={...prior.operation,native:wrong.operation.native},changed=await b3RewriteOperation(f,x,prior.ref,operation);
  // 추가 call의 실제 I/O도 아래 새 SOURCE/END 전체 집합에 포함한다.
  normal.operations=normal.operations.map(op=>op.ref.evidenceId===prior.ref.evidenceId?{operation,ref:changed}:op);
  const records=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_VERIFIED' AND protected_observation->'value'->>'attemptId'=$3",[f.seed.accountId,x.owner.executionId,normal.final.attemptId])).rows;expect(records).toHaveLength(1);
  const verifiedBody=structuredClone(records[0].protected_observation);verifiedBody.value.facts.operations=normal.operations.map(op=>op.ref);const verifiedRef={evidenceId:records[0].evidence_id,evidenceDigest:digest(verifiedBody)};
  await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,verifiedRef.evidenceId,JSON.stringify(verifiedBody),verifiedRef.evidenceDigest]);normal.extra=normal.extra.map(ref=>ref.evidenceId===verifiedRef.evidenceId?verifiedRef:ref);
  const attacked=await b3CostWork(f,x,[normal.pre,...normal.operations],normal.extra),attackedWork=await f.worker.accountTransaction(f.seed.accountId,tx=>attacked.reader.candidateIn(tx,x.execution.input,attacked.basis),true);expect(attackedWork).not.toBeNull();
  const direct=await sqlCandidate(f,x,attackedWork!,attacked.work);expect(direct.rawSetDigest).not.toBe(candidate.rawSetDigest);
  expect(await b3RollbackSeal(f,x,direct),'원 A INPUT/BASIS가 B target과 다르면 메인 TS 없이 SQL이 직접 거부해야 한다').toBeNull();
}),120000);


it('B3-B actual nonempty v2 FINAL cost and history preserve exact refs without new file or native work',async()=>b3WithCheckpoint(async(f,remote,base)=>{
  const {x}=base,restores:(()=>void)[]=[],validation=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:512,maxTargets:64,maxJobs:64});
  const costFactory=(basis:FullStageCostBasis,reader:WindowsStageCostReader)=>{
    const journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:calculatorBounds}),preparation=new FullStageCostPreparation(journal,[{stage:basis.capture.stage,profileDigest:basis.capture.profileDigest,snapshot:basis.snapshot}],calculatorBounds);
    return OperationalStageCost.windows({db:f.worker,preparation,journal,reader,checkpoints:validation,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});
  };
  try{
    const reads=vi.spyOn(f.files,'read');restores.push(()=>reads.mockRestore());
    const puts=vi.spyOn(f.files,'put');restores.push(()=>puts.mockRestore());
    const final=await b3FinalReady(f,remote,base),ready=await b3CostWork(f,x,[final.pre,...final.operations],final.extra);
    expect(final.operations.flatMap(item=>item.operation.native)).toHaveLength(1);
    // 실제 SOURCE/END를 추가한 원집합은 작은64건 예산에서 대기한다.
    // C5에서 사용한512건 검증 예산만 이 새 양성에 명시하며 기존 예산 검사는 보존한다.
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>base.validation.finalCommitIn(tx,x.execution.input),true)).toBe('WAIT');
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.finalCommitIn(tx,x.execution.input),true)).toBe('ELIGIBLE');
    expect(await f.service.renew(x.execution.claim)).toBe(true);
    const cost=costFactory(ready.basis,ready.reader),service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
    await cost.finishAttempt(x.execution.input);await cost.idle();
    const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);
    // 원 합성 user 9007199254740993 + kernel300 ticks, 단가.01,
    // 별도 provider.01 + semantic3*.001을 독립적으로 계산한 정확 기대값이다.
    expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('9007199.267741293000');expect(view.sealedCalculation).not.toBeNull();
    expect(view.calculations[0].result.facts.quantities!.find(q=>q.componentId==='native-image')!.quantity).toBe('900719925.4741293');
    await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);
    const exact=(await f.admin.pool.query("SELECT c.actual_usd::text,c.usage_ref,e.actual_usd::text AS expense FROM manga_web.cost_items c JOIN manga_web.execution_limit_expenses e USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 AND c.component='STAGE_TOTAL'",[f.seed.accountId,x.owner.executionId])).rows;
    expect(exact).toEqual([{actual_usd:'9007199.267741293000',usage_ref:`execution-evidence:${view.sealedCalculation!.evidenceId}:${view.sealedCalculation!.evidenceDigest}`,expense:'9007199.267741293000'}]);
    const closures=(await f.admin.pool.query("SELECT protected_observation->'value' value FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CLOSURE'",[f.seed.accountId,x.owner.executionId])).rows;
    expect(closures).toHaveLength(1);const joined=(closures[0].value as {workSet:OperationalStageCostWorkSet}).workSet.joinedEvidence;
    const counts=async()=>(await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1) queries,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_projections WHERE account_id=$1) projections,(SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals WHERE account_id=$1) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_CALCULATION') calculations",[f.seed.accountId,x.owner.executionId])).rows;
    const nativeBefore=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[f.seed.accountId])).rows;
    expect(nativeBefore).toHaveLength(2);expect(reads.mock.calls.length).toBeGreaterThan(0);expect(puts.mock.calls.length).toBeGreaterThan(0);
    await f.admin.accountTransaction(f.seed.accountId,async tx=>{
      await tx.client.query("UPDATE processing_requests SET state='COMPLETED',terminal_at=$3,terminal_evidence_ref='B3B_FINAL_FIXTURE',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,x.execution.input.requestId,tx.now]);
      await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,x.execution.input.contextId,tx.now]);
      await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$2 WHERE account_id=$1",[f.seed.accountId,new Date(tx.now.valueOf()-1000)]);
    });
    const saved=await costsSnapshot(f),before=await counts(),fileBefore={read:reads.mock.calls.length,put:puts.mock.calls.length};
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.sealedFinalCostIn(tx,x.execution.input,joined),true)).toBe('VERIFIED');
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.finalCommitIn(tx,x.execution.input),true)).toBe('WAIT');
    const recovered=costFactory(ready.basis,ready.reader);
    await recovered.finishAttempt(x.execution.input);await recovered.idle();
    expect((await f.worker.accountTransaction(f.seed.accountId,tx=>recovered.readIn(tx,x.execution.input),true)).costUsd).toBe(view.costUsd);
    expect(await costsSnapshot(f)).toEqual(saved);expect(await counts()).toEqual(before);expect({read:reads.mock.calls.length,put:puts.mock.calls.length}).toEqual(fileBefore);
    expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY evidence_id",[f.seed.accountId])).rows).toEqual(nativeBefore);
    const opRef=final.operations[0].ref;
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.sealedFinalCostIn(tx,x.execution.input,joined.filter(ref=>ref.evidenceId!==opRef.evidenceId)),true)).toBe('WAIT');
    const crossed=structuredClone(joined);crossed.find(ref=>ref.evidenceId===opRef.evidenceId)!.evidenceDigest=sha256('다른 FINAL digest');
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.sealedFinalCostIn(tx,x.execution.input,crossed),true)).toBe('WAIT');
    console.info(JSON.stringify({b3bNonemptyFinalHistory:{native:1,sourceDifferent:true,cost:view.costUsd,fileBefore,fileAfter:{read:reads.mock.calls.length,put:puts.mock.calls.length},counts:before,syntheticPredecessorAndSuccess:true,realWin32:false,continuousRequest:false}}));
  }finally{for(const restore of restores.reverse())restore();}
}),120000);

// 모든 scope를 매번 검증하던 원 구현은 검사 DB의 동치 대조 기준이다.
const b3OwnerFullValidationSql="CREATE FUNCTION manga_web.b3b_owner_full_validation(selector jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$\r\nDECLARE r manga_web.windows_native_cost_roots%ROWTYPE;o jsonb;n integer;scope_row record;\r\nBEGIN\r\n IF NOT manga_web.windows_native_object(selector,ARRAY['executionId','inputEvidenceId','inputFingerprint','basisRef']) OR\r\n  NOT manga_web.windows_native_cost_uuid(selector->>'executionId') OR NOT manga_web.windows_native_cost_uuid(selector->>'inputEvidenceId') OR\r\n  (selector->>'inputFingerprint'~'^[a-f0-9]{64}$') IS DISTINCT FROM true OR NOT manga_web.windows_native_cost_ref(selector->'basisRef') THEN RETURN NULL;END IF;\r\n SELECT * INTO r FROM manga_web.windows_native_cost_roots WHERE account_id=manga_web.current_account() AND execution_id=(selector->>'executionId')::uuid;\r\n IF NOT FOUND OR r.owner_identity IS DISTINCT FROM selector THEN RETURN NULL;END IF;\r\n SELECT owner_body INTO o FROM manga_web.windows_stage_cost_owners WHERE account_id=r.account_id AND execution_id=r.execution_id;\r\n IF NOT FOUND THEN\r\n  SELECT count(*),min(v::text)::jsonb INTO n,o FROM(SELECT DISTINCT protected_scope->'owner' v FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id) s;\r\n  IF n<>1 THEN RETURN NULL;END IF;\r\n END IF;\r\n IF o-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR manga_web.windows_native_cost_owner_valid(o) IS DISTINCT FROM true THEN RETURN NULL;END IF;\r\n FOR scope_row IN SELECT * FROM manga_web.windows_native_cost_scopes WHERE account_id=r.account_id AND execution_id=r.execution_id LOOP\r\n  IF (scope_row.protected_scope->'owner')-'claim'-'validationAttemptRef' IS DISTINCT FROM selector OR\r\n   scope_row.protected_scope->>'scopeId' IS DISTINCT FROM scope_row.scope_id::text OR scope_row.protected_scope->>'scopeDigest' IS DISTINCT FROM scope_row.scope_digest OR\r\n   manga_web.windows_native_cost_scope_history_valid(scope_row.protected_scope) IS DISTINCT FROM true THEN RETURN NULL;END IF;\r\n END LOOP;\r\n RETURN o;\r\nEND $$;";
async function b3InstallOwnerComparison(f:WindowsNativeFixture){
  await f.admin.pool.query(b3OwnerFullValidationSql);
  await f.admin.pool.query([
    "REVOKE ALL ON FUNCTION manga_web.b3b_owner_full_validation(jsonb) FROM PUBLIC;",
    "CREATE FUNCTION manga_web.b3b_compare_owner(s jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$",
    "DECLARE r jsonb;p jsonb;c0 bigint;c1 bigint;c2 bigint;snapshot_before text:=pg_current_snapshot()::text;",
    "BEGIN PERFORM set_config('track_functions','all',true);",
    "SELECT coalesce(sum(calls),0) INTO c0 FROM pg_stat_xact_user_functions WHERE funcid='manga_web.windows_native_cost_scope_history_valid(jsonb)'::regprocedure;",
    "r:=manga_web.b3b_owner_full_validation(s);",
    "SELECT coalesce(sum(calls),0) INTO c1 FROM pg_stat_xact_user_functions WHERE funcid='manga_web.windows_native_cost_scope_history_valid(jsonb)'::regprocedure;",
    "p:=manga_web.windows_stage_cost_owner(s);",
    "SELECT coalesce(sum(calls),0) INTO c2 FROM pg_stat_xact_user_functions WHERE funcid='manga_web.windows_native_cost_scope_history_valid(jsonb)'::regprocedure;",
    "RETURN jsonb_build_object('reference',r,'product',p,'referenceCalls',c1-c0,'productCalls',c2-c1,'snapshotBefore',snapshot_before,'snapshotAfter',pg_current_snapshot()::text); END $$;",
    "REVOKE ALL ON FUNCTION manga_web.b3b_compare_owner(jsonb) FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION manga_web.b3b_compare_owner(jsonb) TO trio_web_worker;"
  ].join('\n'));
}

type B3OwnerComparison={reference:unknown;product:unknown;referenceCalls:number;productCalls:number;snapshotBefore:string;snapshotAfter:string};
async function b3ReadOwnerComparison(client:Parameters<Database['time']>[0],f:WindowsNativeFixture,x:Prepared,readOnly:'on'|'off'){
  const identity=async()=>(await client.query("SELECT current_user role,manga_web.current_account() account,pg_current_snapshot()::text snapshot,has_function_privilege(current_user,'manga_web.windows_stage_cost_owner(jsonb)','EXECUTE') direct,current_setting('transaction_read_only') read_only")).rows[0];
  const before=await identity(),answer=(await client.query('SELECT manga_web.b3b_compare_owner($1::jsonb) value',[JSON.stringify(selector(x.owner))])).rows[0].value as B3OwnerComparison;
  expect(await identity()).toEqual(before);expect(before).toMatchObject({role:'trio_web_worker',account:f.seed.accountId,direct:false,read_only:readOnly});expect(answer.snapshotBefore).toBe(before.snapshot);expect(answer.snapshotAfter).toBe(before.snapshot);expect(answer.product).toEqual(answer.reference);return answer;
}
async function b3CompareOwner(f:WindowsNativeFixture,x:Prepared){
  return f.worker.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);
    return b3ReadOwnerComparison(client,f,x,'on');
  });
}
type B3OwnerScope=NonNullable<Awaited<ReturnType<WindowsNativeCostJournal['beginScopeIn']>>>;
async function b3CompareForgedScope(f:WindowsNativeFixture,x:Prepared,source:B3OwnerScope,fault:'ROW_ID'|'BODY_HASH'|'EXTRA_KEY'|'VERSION'|'ATTEMPT'|'ZERO_UUID'){
  const scope={...structuredClone(source),scopeId:fault==='ZERO_UUID'?'00000000-0000-0000-0000-000000000000':randomUUID()},rowId=scope.scopeId;
  const changed=fault==='ROW_ID'?{...scope,scopeId:randomUUID()}:fault==='BODY_HASH'?{...scope,phase:'INPUT' as const}:fault==='EXTRA_KEY'?{...scope,extra:true}:fault==='VERSION'?{...scope,version:2}:fault==='ATTEMPT'?{...scope,owner:{...scope.owner,validationAttemptRef:{evidenceId:randomUUID(),evidenceDigest:sha256('변조된 원 attempt')}}}:scope;
  const {scopeDigest:_scopeDigest,...body}=changed,edited={...body,scopeDigest:fault==='BODY_HASH'?scope.scopeDigest:digest(body)};
  return f.admin.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);
    await client.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; SAVEPOINT owner_fault');
    try{
      await client.query('INSERT INTO manga_web.windows_native_cost_scopes(account_id,execution_id,scope_id,scope_digest,protected_scope,created_at) VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp())',[f.seed.accountId,x.owner.executionId,rowId,edited.scopeDigest,JSON.stringify(edited)]);
      await client.query('SET LOCAL ROLE trio_web_worker');
      const result=await b3ReadOwnerComparison(client,f,x,'off');expect(result.reference,fault).toBeNull();expect(result.product,fault).toBeNull();return result;
    }finally{await client.query('ROLLBACK TO SAVEPOINT owner_fault; RELEASE SAVEPOINT owner_fault');}
  });
}
it('B3-B owner validation context grouping preserves 64 original scopes and avoids repeated historical authority reads',async()=>withPrepared(async(f,x)=>{
  await b3InstallOwnerComparison(f);
  for(let index=0;index<64;index++){
    const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}),true)).toBe('JOINED');
  }
  const result=await b3CompareOwner(f,x);expect(result.reference).toEqual(x.owner);expect(result.referenceCalls).toBe(64);expect(result.productCalls).toBe(2);
  console.info(JSON.stringify({b3bOwnerGrouping:{scopes:64,referenceCalls:result.referenceCalls,productCalls:result.productCalls,sameSnapshot:true,readOnly:true,newRuntimePermission:false}}));
}),120000);
it('B3-B owner validation context grouping preserves PRE FINAL targets row integrity and fresh historical rechecks',async()=>b3WithCheckpoint(async(f,remote,base)=>{
  await b3FinalReady(f,remote,base);await b3InstallOwnerComparison(f);
  const rows=(await f.admin.pool.query("SELECT scope_id,scope_digest,protected_scope FROM manga_web.windows_native_cost_scopes WHERE account_id=$1 AND execution_id=$2 ORDER BY scope_id",[f.seed.accountId,base.x.owner.executionId])).rows as {scope_id:string;scope_digest:string;protected_scope:NonNullable<Awaited<ReturnType<WindowsNativeCostJournal['beginScopeIn']>>>}[];
  const groups=new Set(rows.map(row=>{const {scopeId:_scopeId,scopeDigest:_scopeDigest,...context}=row.protected_scope;return digest(context);}));
  expect(groups.size).toBeGreaterThan(1);const normal=await b3CompareOwner(f,base.x);expect(normal.reference).toEqual(base.x.owner);expect(normal.referenceCalls).toBe(rows.length);expect(normal.productCalls).toBe(rows.length);
  const original=rows.find(row=>row.protected_scope.owner.validationAttemptRef!==null)!;expect(original).toBeDefined();
  for(const fault of ['ROW_ID','BODY_HASH','EXTRA_KEY','VERSION','ATTEMPT'] as const){await b3CompareForgedScope(f,base.x,original.protected_scope,fault);expect((await b3CompareOwner(f,base.x)).product).toEqual(base.x.owner);}
  console.info(JSON.stringify({b3bOwnerContexts:{scopes:rows.length,contexts:groups.size,faults:5,restoredAfterEach:true,crossInvocationCache:false,sameSnapshot:true,readOnly:true}}));
}),120000);

it('B3-B owner validation context grouping zero UUID preserves the normal representative and rejects a rehashed later scope',async()=>withPrepared(async(f,x)=>{
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}),true)).toBe('JOINED');
  await b3InstallOwnerComparison(f);
  const normal=await b3CompareOwner(f,x);expect(normal.reference).toEqual(x.owner);expect(normal.referenceCalls).toBe(1);expect(normal.productCalls).toBe(2);
  const readScopes=async()=>(await f.admin.pool.query('SELECT scope_id,scope_digest,protected_scope,created_at FROM manga_web.windows_native_cost_scopes WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId])).rows,before=await readScopes();
  expect(before).toHaveLength(1);
  const result=await b3CompareForgedScope(f,x,scope!,'ZERO_UUID');
  expect(result.reference).toBeNull();expect(result.product).toBeNull();expect(result.referenceCalls).toBe(2);expect(result.referenceCalls).toBeLessThan(64);
  expect(await readScopes()).toEqual(before);expect((await b3CompareOwner(f,x)).product).toEqual(x.owner);
  console.info(JSON.stringify({b3bOwnerZeroUuid:{originalScopes:before.length,discardedScopes:result.referenceCalls,referenceCalls:result.referenceCalls,normalRepresentativeFirst:true,rehashedZeroUuid:true,rolledBack:true}}));
}));

type B3OwnerHistoryDefinition={oid:string;proowner:string;proacl:string|null;provolatile:string;proconfig:string[]|null;prosecdef:boolean;definition:string};
type B3OwnerHistoryNotice={pid:number;scopeId:string;valid:boolean|null};
async function b3OwnerBasisCommitRace(f:WindowsNativeFixture,x:Prepared,mode:'REFERENCE'|'PRODUCT'){
  const scopes:B3OwnerScope[]=[];
  for(let index=0;index<2;index++){
    const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()),true);expect(scope).not.toBeNull();scopes.push(scope!);
    expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}),true)).toBe('JOINED');
  }
  expect(new Set(scopes.map(({scopeId:_scopeId,scopeDigest:_scopeDigest,...context})=>digest(context))).size).toBe(1);
  await b3InstallOwnerComparison(f);
  const normal=await b3CompareOwner(f,x);expect(normal.reference).toEqual(x.owner);expect(normal.referenceCalls).toBe(2);expect(normal.productCalls).toBe(2);
  const readBasis=async()=>(await f.admin.pool.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string;received_at:Date;protected_observation:{value:{captureDigest:string}};inserted_xid:string}>(
    "SELECT evidence_id,evidence_digest,protected_evidence_ref,received_at,protected_observation,xmin::text AS inserted_xid FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_BASIS' ORDER BY evidence_id",
    [f.seed.accountId,x.owner.executionId],
  )).rows;
  const originalBasis=await readBasis();expect(originalBasis).toHaveLength(1);expect(originalBasis[0]).toMatchObject({evidence_id:x.owner.basisRef.evidenceId,evidence_digest:x.owner.basisRef.evidenceDigest});
  const sideEffects=async()=>(await f.admin.pool.query(
    "SELECT (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_calls WHERE account_id=$1) calls,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_scopes WHERE account_id=$1 AND execution_id=$2) scopes",
    [f.seed.accountId,x.owner.executionId],
  )).rows[0];
  const beforeEffects=await sideEffects();expect(beforeEffects).toEqual({go:0,calls:0,starts:0,scopes:2});expect(f.objectIo).toEqual({get:0,put:0});
  const historyDefinition=async()=>(await f.admin.pool.query<B3OwnerHistoryDefinition>(
    "SELECT oid::text,proowner::text,proacl::text,provolatile,proconfig,prosecdef,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='manga_web.windows_native_cost_scope_history_valid(jsonb)'::regprocedure",
  )).rows[0],originalHistory=await historyDefinition();
  expect(originalHistory.provolatile).toBe('v');expect(originalHistory.prosecdef).toBe(true);
  const gateKey=BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)).toString(),messages:string[]=[],errors:unknown[]=[];
  const notices=()=>messages.map(message=>JSON.parse(message.slice('B3B_OWNER_HISTORY '.length)) as B3OwnerHistoryNotice);
  const contender=new pg.Client({connectionString:f.worker.connectionString,options:'-c role=trio_web_worker -c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});
  let connected=false,gateHeld=false,historyTouched=false,aPid:number|null=null,bPid:number|null=null,pending:Promise<{value:unknown}>|undefined,pendingDone=false,pendingFault:unknown,attempts=0;
  let report:{first:B3OwnerHistoryNotice;last:B3OwnerHistoryNotice;duplicateRef:Ref;blockingObserved:boolean}|undefined;
  try{
    historyTouched=true;
    // 검사 DB에서 원 판정 뒤에만 대기한다. 판정값과 기존 권한은 바꾸지 않는다.
    await f.admin.pool.query([
      "CREATE OR REPLACE FUNCTION manga_web.windows_native_cost_scope_history_valid(s jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$",
      "DECLARE answer boolean;BEGIN answer:=manga_web.windows_native_cost_scope_check(s,false);",
      " RAISE NOTICE 'B3B_OWNER_HISTORY %',jsonb_build_object('pid',pg_backend_pid(),'scopeId',s->>'scopeId','valid',answer);",
      " PERFORM pg_advisory_xact_lock("+gateKey+"::bigint);RETURN answer;END $$;",
      "CREATE FUNCTION manga_web.b3b_owner_basis_race(p text,s jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,manga_web,pg_temp AS $$",
      "BEGIN IF p='REFERENCE' THEN RETURN manga_web.b3b_owner_full_validation(s);ELSIF p='PRODUCT' THEN RETURN manga_web.windows_stage_cost_owner(s);",
      " ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='B3B_OWNER_RACE_MODE';END IF;END $$;",
      "REVOKE ALL ON FUNCTION manga_web.b3b_owner_basis_race(text,jsonb) FROM PUBLIC;",
      "GRANT EXECUTE ON FUNCTION manga_web.b3b_owner_basis_race(text,jsonb) TO trio_web_worker;",
    ].join('\n'));
    const {definition:_originalDefinition,...originalMetadata}=originalHistory,{definition:_installedDefinition,...installedMetadata}=await historyDefinition();
    expect(installedMetadata).toEqual(originalMetadata);
    await contender.connect();connected=true;
    const bIdentity=(await contender.query('SELECT pg_backend_pid() pid,current_user role')).rows[0];bPid=bIdentity.pid as number;expect(bIdentity.role).toBe('trio_web_worker');
    await contender.query('SELECT pg_advisory_lock($1::bigint)',[gateKey]);gateHeld=true;
    // A는 계정 행 잠금 없이 실제 worker 거래로 원 owner 한 경로만 호출한다.
    pending=f.worker.transaction(async client=>{
      attempts++;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);
      const identity=async()=>(await client.query(
        "SELECT pg_backend_pid() pid,current_user role,manga_web.current_account()::text account,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only,has_function_privilege(current_user,'manga_web.windows_stage_cost_owner(jsonb)','EXECUTE') product_direct,has_function_privilege(current_user,'manga_web.b3b_owner_full_validation(jsonb)','EXECUTE') reference_direct,has_function_privilege(current_user,'manga_web.windows_native_cost_scope_history_valid(jsonb)','EXECUTE') history_direct",
      )).rows[0],before=await identity();
      aPid=before.pid as number;expect(aPid).not.toBe(bPid);expect(before).toMatchObject({role:'trio_web_worker',account:f.seed.accountId,isolation:'read committed',read_only:'off',product_direct:false,reference_direct:false,history_direct:false});
      const onNotice=(notice:{message?:string})=>{if(notice.message?.startsWith('B3B_OWNER_HISTORY '))messages.push(notice.message);};
      client.on('notice',onNotice);
      try{
        const result=(await client.query<{value:unknown}>('SELECT manga_web.b3b_owner_basis_race($1::text,$2::jsonb) value',[mode,JSON.stringify(selector(x.owner))])).rows[0];
        expect(await identity()).toEqual(before);return result;
      }finally{client.off('notice',onNotice);}
    });
    void pending.then(()=>{pendingDone=true;},error=>{pendingDone=true;pendingFault=error;});
    let blocked=false;
    for(let tick=0;tick<200;tick++){
      if(pendingDone){if(pendingFault)throw pendingFault;throw new Error('B3B_OWNER_RACE_DID_NOT_BLOCK');}
      if(aPid!==null)blocked=(await f.admin.pool.query<{blocked:boolean}>('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked',[bPid,aPid])).rows[0].blocked;
      if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));
    }
    expect(blocked).toBe(true);
    const firstNotices=notices();expect(firstNotices).toHaveLength(1);expect(firstNotices[0]).toMatchObject({pid:aPid,valid:true});expect(scopes.some(scope=>scope.scopeId===firstNotices[0].scopeId)).toBe(true);
    await contender.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await contender.query('SET LOCAL ROLE trio_web_worker');
    await contender.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);
    const permissions=(await contender.query(
      "SELECT current_user role,manga_web.current_account()::text account,current_setting('transaction_isolation') isolation,has_table_privilege(current_user,'manga_web.execution_evidence','INSERT') can_insert,has_table_privilege(current_user,'manga_web.execution_evidence','UPDATE') can_update,has_table_privilege(current_user,'manga_web.execution_evidence','DELETE') can_delete",
    )).rows[0];
    expect(permissions).toEqual({role:'trio_web_worker',account:f.seed.accountId,isolation:'read committed',can_insert:true,can_update:false,can_delete:false});
    for(const sql of [
      'UPDATE manga_web.execution_evidence SET evidence_digest=evidence_digest WHERE account_id=$1 AND evidence_id=$2',
      'DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',
    ]){
      await contender.query('SAVEPOINT b3b_basis_immutable');
      try{await expect(contender.query(sql,[f.seed.accountId,x.owner.basisRef.evidenceId])).rejects.toMatchObject({code:'42501'});}
      finally{await contender.query('ROLLBACK TO SAVEPOINT b3b_basis_immutable; RELEASE SAVEPOINT b3b_basis_immutable');}
    }
    const duplicateBody=structuredClone(originalBasis[0].protected_observation);duplicateBody.value.captureDigest=sha256('b3b-duplicate-basis-'+randomUUID());
    expect(duplicateBody.value.captureDigest).not.toBe(originalBasis[0].protected_observation.value.captureDigest);
    const duplicateRef:Ref={evidenceId:randomUUID(),evidenceDigest:digest(duplicateBody)};expect(duplicateRef.evidenceDigest).not.toBe(x.owner.basisRef.evidenceDigest);
    const inserted=(await contender.query<{evidence_id:string;evidence_digest:string;inserted_xid:string}>(
      "INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,clock_timestamp(),$5::jsonb) RETURNING evidence_id,evidence_digest,xmin::text AS inserted_xid",
      [f.seed.accountId,duplicateRef.evidenceId,x.owner.executionId,duplicateRef.evidenceDigest,JSON.stringify(duplicateBody)],
    )).rows[0];
    expect(inserted).toMatchObject({evidence_id:duplicateRef.evidenceId,evidence_digest:duplicateRef.evidenceDigest});expect(inserted.inserted_xid).not.toBe(originalBasis[0].inserted_xid);
    expect(notices()).toEqual(firstNotices);
    expect((await f.admin.pool.query<{blocked:boolean}>('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked',[bPid,aPid])).rows[0].blocked).toBe(true);
    await contender.query('COMMIT');
    const committedBasis=await readBasis();expect(committedBasis).toHaveLength(2);expect(committedBasis.find(row=>row.evidence_id===originalBasis[0].evidence_id)).toEqual(originalBasis[0]);expect(committedBasis.find(row=>row.evidence_id===duplicateRef.evidenceId)).toMatchObject({evidence_digest:duplicateRef.evidenceDigest,protected_evidence_ref:duplicateRef.evidenceId,protected_observation:duplicateBody,inserted_xid:inserted.inserted_xid});
    expect(notices()).toEqual(firstNotices);
    expect((await contender.query<{unlocked:boolean}>('SELECT pg_advisory_unlock($1::bigint) unlocked',[gateKey])).rows[0].unlocked).toBe(true);gateHeld=false;
    const result=await pending;expect(result.value).toBeNull();expect(attempts).toBe(1);
    const observed=notices();expect(observed).toHaveLength(2);expect(observed[0]).toEqual(firstNotices[0]);expect(observed[1]).toMatchObject({pid:aPid,valid:false});
    if(mode==='REFERENCE')expect(observed[1].scopeId).not.toBe(observed[0].scopeId);else expect(observed[1].scopeId).toBe(observed[0].scopeId);
    expect(await sideEffects()).toEqual(beforeEffects);expect(f.objectIo).toEqual({get:0,put:0});
    report={first:observed[0],last:observed[1],duplicateRef,blockingObserved:blocked};
  }catch(error){errors.push(error);}
  finally{
    if(connected){
      try{await contender.query('ROLLBACK');}catch(error){errors.push(error);}
      if(gateHeld)try{expect((await contender.query<{unlocked:boolean}>('SELECT pg_advisory_unlock($1::bigint) unlocked',[gateKey])).rows[0].unlocked).toBe(true);gateHeld=false;}catch(error){errors.push(error);}
    }
    try{await contender.end();}catch(error){errors.push(error);}
    if(pending){
      if(!pendingDone&&aPid!==null)try{await f.admin.pool.query('SELECT pg_cancel_backend($1::integer)',[aPid]);}catch(error){errors.push(error);}
      try{await pending;}catch(error){if(!errors.includes(error))errors.push(error);}
    }
    if(historyTouched){
      try{await f.admin.pool.query(originalHistory.definition);expect(await historyDefinition()).toEqual(originalHistory);}catch(error){errors.push(error);}
    }
  }
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'B3B_OWNER_BASIS_RACE_AND_CLEANUP_FAILED');
  expect(report).toBeDefined();
  console.info(JSON.stringify({b3bOwnerBasisRace:{mode,scopes:scopes.length,contexts:1,...report,historyRestored:true,originalBasisPreserved:true,workerUpdateDeleteDenied:true,attempts,additionalGo:0,objectIo:f.objectIo}}));
}

it.each(['REFERENCE','PRODUCT'] as const)('B3-B owner validation context grouping %s rejects a committed duplicate BASIS after the first true history check',async mode=>withPrepared((f,x)=>b3OwnerBasisCommitRace(f,x,mode)));

// 원 25 봉인을 실제 생성한 뒤 26 전환과 새 B PRE를 검증한다.
import {createWindowsNativeMigrationEpoch as fixF10CreateEpoch} from '../fixtures/windows-native.js';
import {migrate as fixF10Migrate26} from '../../packages/storage/src/migrations.js';

type FixF10Epoch=Awaited<ReturnType<typeof fixF10CreateEpoch>>;
type FixF10Legacy={
  db:Database;epoch:FixF10Epoch;
  fixture():Promise<WindowsNativeFixture>;
  costs:OperationalStageCost[];
  remotes:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>[];
  registerClose(close:()=>Promise<void>):void;
  quiesce():Promise<void>;
};
async function fixF10WithLegacy(run:(legacy:FixF10Legacy)=>Promise<void>){
  const guard=guardWindowsNativeIo(),errors:unknown[]=[],fixtures:WindowsNativeFixture[]=[],costs:OperationalStageCost[]=[],remotes:FixF10Legacy['remotes']=[];
  const closers:(()=>Promise<void>)[]=[];
  let db:Database|undefined;
  try{
    const connectionString=process.env.TRIO_TEST_DATABASE_URL;
    expect(connectionString).toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/);
    const root=new pg.Client({connectionString});await root.connect();
    const name='trio_fix_f10_'+randomUUID().replaceAll('-','');
    try{await root.query('CREATE DATABASE "'+name+'"');}finally{await root.end();}
    const url=new URL(connectionString!);url.pathname='/'+name;
    const {Database:DatabaseClass}=await import('../../packages/storage/src/database.js');
    db=new DatabaseClass(url.toString());const epoch=await fixF10CreateEpoch();
    const copied=JSON.parse(await b3ReadFile(epoch.directory+'/source-sha256.json','utf8')) as {files:{path:string}[]};
    expect(await epoch.migrate(db.pool)).toEqual(copied.files.filter(file=>file.path.startsWith('db/migrations/')).map(file=>file.path.slice('db/migrations/'.length)));
    expect((await db.pool.query<{name:string}>('SELECT name FROM trio_migrations.applied ORDER BY name')).rows.map(row=>Number(row.name.slice(0,4)))).toEqual(Array.from({length:25},(_,index)=>index+1));
    const owned=db,legacy:FixF10Legacy={db:owned,epoch,costs,remotes,registerClose:close=>{closers.push(close);},fixture:async()=>{const supplied=new DatabaseClass(owned.connectionString),fixture=await windowsNativeFixture(20.5,supplied);fixtures.push(fixture);return fixture;},quiesce:async()=>{for(const remote of remotes.splice(0).reverse())await remote.close();for(const cost of costs)await cost.idle();}};
    await run(legacy);
  }catch(error){errors.push(error);}
  finally{
    for(const remote of remotes.splice(0).reverse())try{await remote.close();}catch(error){errors.push(error);}
    for(const cost of costs)try{await cost.idle();}catch(error){errors.push(error);}
    for(const close of closers.reverse())try{await close();}catch(error){errors.push(error);}
    for(const fixture of fixtures.reverse())try{await fixture.close();}catch(error){errors.push(error);}
    try{await db?.close();}catch(error){errors.push(error);}
    try{expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}
  }
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'F10 검사와 종료 확인이 함께 실패했다');
}
async function fixF10Financial(db:Database,accountId:string|null=null){
  const rows={
    costs:(await db.pool.query('SELECT * FROM manga_web.cost_items WHERE $1::uuid IS NULL OR account_id=$1 ORDER BY account_id,cost_item_id',[accountId])).rows,
    expenses:(await db.pool.query('SELECT * FROM manga_web.execution_limit_expenses WHERE $1::uuid IS NULL OR account_id=$1 ORDER BY account_id,cost_item_id',[accountId])).rows,
    evidence:(await db.pool.query("SELECT * FROM manga_web.execution_evidence WHERE($1::uuid IS NULL OR account_id=$1) AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY account_id,evidence_id",[accountId])).rows,
    seals:(await db.pool.query('SELECT * FROM manga_web.windows_stage_cost_seals WHERE $1::uuid IS NULL OR account_id=$1 ORDER BY account_id,execution_id',[accountId])).rows,
  };return rows;
}
async function fixF10Catalog(db:Database){
  return {functions:(await db.pool.query("SELECT p.oid::text AS oid,p.proname,to_jsonb(p) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid")).rows,applied:(await db.pool.query('SELECT name,sha256,applied_at::text AS applied_at FROM trio_migrations.applied ORDER BY name')).rows};
}
async function fixF10Decision(db:Database,accountId:string,executionId:string){
  const rows=(await db.pool.query('SELECT * FROM manga_web.windows_stage_cost_ownership_transitions WHERE account_id=$1 AND execution_id=$2',[accountId,executionId])).rows;expect(rows).toHaveLength(1);return rows[0];
}
async function fixF10Healthy(legacy:FixF10Legacy){
  const f=await legacy.fixture(),x=await prepareWindowsCostedTarget(f),ready=await zeroWindowsWork(f,x,{providerUsd:'0.01'}),{cost}=windowsCost(f,ready.basis,ready.reader);legacy.costs.push(cost);
  await cost.finishAttempt(x.execution.input);await cost.idle();
  const view=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,x.execution.input),true);
  expect(view.state).toBe('CONFIRMED');expect(view.costUsd).toBe('0.010000000000');expect(view.sealedCalculation).not.toBeNull();
  const service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);
  await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,x.execution.input),true);
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(raw).not.toBeNull();
  const seals=(await f.admin.pool.query('SELECT * FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,x.owner.executionId])).rows;expect(seals).toHaveLength(1);expect(seals[0].raw_set_digest).toBe(raw!.rawSetDigest);expect(seals[0].lookup_membership.originals).toEqual(raw!.originals);
  const financial=await fixF10Financial(f.admin,f.seed.accountId);expect(financial.costs.some(row=>row.component==='STAGE_TOTAL'&&row.state==='CONFIRMED')).toBe(true);expect(financial.expenses).toHaveLength(1);
  return {f,x,ready,cost,view,raw:raw!,seal:seals[0],financial};
}
type FixF10Healthy=Awaited<ReturnType<typeof fixF10Healthy>>;
async function fixF10FreshHistory(legacy:FixF10Legacy,old:FixF10Healthy){
  const reader=new WindowsStageCostReader({db:old.f.worker,windows:old.x.costs,nonWindows:{nonWindowsIn:async()=>{throw new Error('역사 조회에서 새 원자료를 만들 수 없다');},checkpointFactsIn:async()=>{throw new Error('역사 조회에서 검증을 다시 실행할 수 없다');}},bounds:{...windowsStageCostBounds}}),{cost}=windowsCost(old.f,old.ready.basis,reader);legacy.costs.push(cost);
  return old.f.worker.accountTransaction(old.f.seed.accountId,tx=>cost.readIn(tx,old.x.execution.input),true);
}
async function fixF10Context(client:pg.PoolClient){return (await client.query<{raw:string|null;account:string|null;pid:number}>("SELECT current_setting('trio.account_id',true) raw,manga_web.current_account()::text account,pg_backend_pid() pid")).rows[0];}
async function fixF10PinnedMigration(db:Database,initialAccount:string|null,run:(pool:pg.Pool)=>Promise<void>){
  const pool=new pg.Pool({connectionString:db.connectionString,max:1,options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});
  try{
    const first=await pool.connect();let before:Awaited<ReturnType<typeof fixF10Context>>;
    try{if(initialAccount!==null)await first.query("SELECT set_config('trio.account_id',$1,false)",[initialAccount]);before=await fixF10Context(first);if(initialAccount===null){expect(before.raw).toBeNull();expect(before.account).toBeNull();}else{expect(before.raw).toBe(initialAccount);expect(before.account).toBe(initialAccount.toLowerCase());}}finally{first.release();}
    await run(pool);
    const last=await pool.connect();try{const after=await fixF10Context(last);expect(after.pid).toBe(before.pid);if(initialAccount===null){expect(after.raw===null||after.raw==='').toBe(true);expect(after.account).toBeNull();}else{expect(after.raw).toBe(initialAccount);expect(after.account).toBe(initialAccount.toLowerCase());}expect((await last.query("SELECT to_regclass('pg_temp.windows_stage_cost_transition_stage')::text stage")).rows).toEqual([{stage:null}]);console.info(JSON.stringify({fixF10Context:{before,after}}));}finally{last.release();}
  }finally{await pool.end();}
}
async function fixF10Migrate(legacy:FixF10Legacy,initialAccount:string|null){
  await legacy.quiesce();const financial=await fixF10Financial(legacy.db),before=await fixF10Catalog(legacy.db);
  await fixF10PinnedMigration(legacy.db,initialAccount,async pool=>{expect(await fixF10Migrate26(pool)).toEqual(['0026_windows_stage_cost_ownership.sql']);});
  const after=await fixF10Catalog(legacy.db);expect(after.applied.slice(0,25)).toEqual(before.applied);expect(await fixF10Financial(legacy.db)).toEqual(financial);
  expect(after.functions.filter(row=>before.functions.find(old=>old.oid===row.oid)?.definition.prosrc!==row.definition.prosrc).map(row=>row.proname)).toEqual(['windows_stage_cost_collect']);
}

it.each(['UNSET','OTHER_ACCOUNT'] as const)('B3-C F10 실제 1..25의 두 계정 건강한 봉인은 26 이후 EXACT이며 원 %s 문맥과 금융 자료를 보존한다',async context=>fixF10WithLegacy(async legacy=>{
  const a=await fixF10Healthy(legacy),b=await fixF10Healthy(legacy);expect(a.f.seed.accountId).not.toBe(b.f.seed.accountId);
  const initial=context==='UNSET'?null:b.f.seed.accountId.toUpperCase();await fixF10Migrate(legacy,initial);
  const decisions=(await legacy.db.pool.query('SELECT * FROM manga_web.windows_stage_cost_ownership_transitions ORDER BY account_id,execution_id')).rows;expect(decisions).toHaveLength(2);
  for(const old of [a,b]){
    const decision=await fixF10Decision(legacy.db,old.f.seed.accountId,old.x.owner.executionId);
    expect(decision).toMatchObject({seal_id:old.seal.seal_id,seal_digest:old.seal.seal_digest,old_rule:'windows-stage-cost-0025',disposition:'LEGACY_EXACT',reason:'EXACT',old_raw_set_digest:old.seal.raw_set_digest,new_raw_set_digest:old.seal.raw_set_digest});expect(decision.old_originals_digest).toBe(decision.new_originals_digest);
    const raw=await lookup<Census>(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)});expect(raw).toEqual(old.raw);
    const history=await fixF10FreshHistory(legacy,old);expect(history.state).toBe('CONFIRMED');expect(history.costUsd).toBe(old.view.costUsd);expect(history.sealedCalculation).toEqual(old.view.sealedCalculation);expect(await fixF10Financial(old.f.admin,old.f.seed.accountId)).toEqual(old.financial);
  }
  expect((await legacy.db.pool.query('SELECT * FROM manga_web.windows_stage_cost_ownership_transitions ORDER BY account_id,execution_id')).rows).toEqual(decisions);
}),120000);

it.each(['RAW_MISMATCH','PERSISTENT_CONFLICT','INVALID_OLD_PROOF'] as const)('B3-C F10 원 %s 봉인은 26에서 HOLD이며 원 자료 복원이나 새 기준 일치로 자동 해제되지 않는다',async defect=>fixF10WithLegacy(async legacy=>{
  const old=await fixF10Healthy(legacy),control=await fixF10Healthy(legacy),account=old.f.seed.accountId,input=old.x.execution.input;
  let injected:Ref|null=null,basisBody:unknown=null;
  if(defect==='INVALID_OLD_PROOF'){
    basisBody=(await old.f.admin.pool.query('SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2',[account,old.x.owner.basisRef.evidenceId])).rows[0].protected_observation;
    // 실제 봉인의 원 BASIS 본문만 손상시키며 봉인 JSON과 금융 행은 만들거나 고치지 않는다.
    await old.f.admin.pool.query("UPDATE manga_web.execution_evidence SET protected_observation=protected_observation||jsonb_build_object('fixF10InvalidProof',true) WHERE account_id=$1 AND evidence_id=$2",[account,old.x.owner.basisRef.evidenceId]);
    expect(await lookup(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)})).toBeNull();
  }else{
    injected=await putOriginal(old.f,old.x,'FIX_F10_RAW_DRIFT',{version:1,eventId:randomUUID()});
    const raw=await lookup<Census>(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)});expect(raw).not.toBeNull();expect(raw!.rawSetDigest).not.toBe(old.seal.raw_set_digest);
    if(defect==='PERSISTENT_CONFLICT'){
      const conflict=await old.f.worker.accountTransaction(account,tx=>old.cost.readIn(tx,input),true);expect(conflict.state).toBe('CONFLICT');
      const service=new ExecutionService(old.f.worker,old.f.provider,old.f.requestPolicy,{},undefined,old.cost);await old.f.worker.accountTransaction(account,tx=>service.reconcileOperationalCostIn(tx,input),true);
      expect((await old.f.admin.pool.query("SELECT evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 AND component='STAGE_TOTAL'",[account,input.executionId])).rows).toEqual([{evidence_conflict:true}]);
      expect((await old.f.admin.pool.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2 RETURNING evidence_id',[account,injected.evidenceId])).rows).toEqual([{evidence_id:injected.evidenceId}]);injected=null;
      const exact=await lookup<Census>(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)});expect(exact!.rawSetDigest).toBe(old.seal.raw_set_digest);expect(exact!.originals).toEqual(old.seal.lookup_membership.originals);
    }
  }
  if(defect!=='PERSISTENT_CONFLICT')expect((await old.f.admin.pool.query("SELECT evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 AND component='STAGE_TOTAL'",[account,input.executionId])).rows).toEqual([{evidence_conflict:false}]);
  const financial=await fixF10Financial(legacy.db);await fixF10Migrate(legacy,control.f.seed.accountId);
  const decision=await fixF10Decision(legacy.db,account,input.executionId),reason=defect==='RAW_MISMATCH'?'OLD_RAW_CHANGED':defect==='PERSISTENT_CONFLICT'?'KNOWN_CONFLICT':'OLD_UNCONFIRMED';expect(decision.disposition).toBe('LEGACY_HOLD');expect(decision.reason).toBe(reason);
  if(defect==='PERSISTENT_CONFLICT'){expect(decision.old_raw_set_digest).toBe(old.seal.raw_set_digest);expect(decision.new_raw_set_digest).toBe(old.seal.raw_set_digest);expect(decision.new_originals_digest).toBe(decision.old_originals_digest);}
  if(injected)expect((await old.f.admin.pool.query('DELETE FROM manga_web.execution_evidence WHERE account_id=$1 AND evidence_id=$2 RETURNING evidence_id',[account,injected.evidenceId])).rows).toEqual([{evidence_id:injected.evidenceId}]);
  if(defect==='INVALID_OLD_PROOF')await old.f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3 WHERE account_id=$1 AND evidence_id=$2',[account,old.x.owner.basisRef.evidenceId,JSON.stringify(basisBody)]);
  for(let pass=0;pass<2;pass++){expect(await lookup(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)})).toBeNull();expect(await lookup(old.f,{version:1,mode:'SEALED',owner:selector(old.x.owner)})).toBeNull();expect((await fixF10FreshHistory(legacy,old)).state).toBe('CONFLICT');}
  expect(await fixF10Decision(legacy.db,account,input.executionId)).toEqual(decision);expect(await fixF10Financial(legacy.db)).toEqual(financial);
  const healthy=await fixF10Decision(legacy.db,control.f.seed.accountId,control.x.owner.executionId);expect(healthy.disposition).toBe('LEGACY_EXACT');expect((await fixF10FreshHistory(legacy,control)).state).toBe('CONFIRMED');
}),120000);

it('B3-C F10 원 25의 실제 FOREIGN FINAL 혼합 봉인은 26에서 NEW_RULE_CHANGED HOLD로 남고 원금융을 보존한다',async()=>fixF10WithLegacy(async legacy=>{
  const f=await legacy.fixture(),remote=await createB3WindowsRemoteFixture(f);legacy.remotes.push(remote);
  const base=await b3CheckpointBase(f,remote.capacity),final=await b3FinalReady(f,remote,base),ready=await b3CostWork(f,base.x,[final.pre,...final.operations],final.extra);
  const validation=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:512,maxTargets:64,maxJobs:64}),journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator:calculatorBounds}),preparation=new FullStageCostPreparation(journal,[{stage:ready.basis.capture.stage,profileDigest:ready.basis.capture.profileDigest,snapshot:ready.basis.snapshot}],calculatorBounds);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>validation.finalCommitIn(tx,base.x.execution.input),true)).toBe('ELIGIBLE');expect(await f.service.renew(base.x.execution.claim)).toBe(true);
  const cost=OperationalStageCost.windows({db:f.worker,preparation,journal,reader:ready.reader,checkpoints:validation,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});legacy.costs.push(cost);await cost.finishAttempt(base.x.execution.input);await cost.idle();
  const before=await f.worker.accountTransaction(f.seed.accountId,tx=>cost.readIn(tx,base.x.execution.input),true);expect(before.state).toBe('CONFIRMED');expect(before.costUsd).toBe('9007199.267741293000');
  const service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},undefined,cost);await f.worker.accountTransaction(f.seed.accountId,tx=>service.reconcileOperationalCostIn(tx,base.x.execution.input),true);
  const raw=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(base.x.owner)});expect(raw).not.toBeNull();
  const unrelated=(await f.admin.pool.query("SELECT evidence_id FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME'",[f.seed.accountId,base.source.input.executionId])).rows;expect(unrelated).toHaveLength(1);expect(raw!.rows.some(row=>row.kind==='EVIDENCE'&&row.id===unrelated[0].evidence_id)).toBe(true);
  const seal=(await f.admin.pool.query('SELECT * FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,base.x.owner.executionId])).rows[0];expect(seal.raw_set_digest).toBe(raw!.rawSetDigest);expect(seal.lookup_membership.originals).toEqual(raw!.originals);
  const financial=await fixF10Financial(legacy.db);await fixF10Migrate(legacy,f.seed.accountId);
  const decision=await fixF10Decision(legacy.db,f.seed.accountId,base.x.owner.executionId);expect(decision).toMatchObject({disposition:'LEGACY_HOLD',reason:'NEW_RULE_CHANGED',seal_id:seal.seal_id,seal_digest:seal.seal_digest,old_raw_set_digest:seal.raw_set_digest});expect(decision.new_raw_set_digest).not.toBeNull();expect(decision.new_raw_set_digest).not.toBe(seal.raw_set_digest);
  expect(await lookup(f,{version:1,mode:'SEALED',owner:selector(base.x.owner)})).toBeNull();expect(await fixF10Financial(legacy.db)).toEqual(financial);expect(await fixF10Decision(legacy.db,f.seed.accountId,base.x.owner.executionId)).toEqual(decision);
}),120000);

async function fixF10InstallFailure(db:Database,phase:'STAGE_READY'|'OLD_OBSERVED'|'DECISIONS_WRITTEN'){
  const suffix=randomUUID().replaceAll('-',''),schema='fix_f10_fault_'+suffix,event='fix_f10_fault_'+suffix;
  await db.pool.query('CREATE SCHEMA '+schema);
  await db.pool.query(`CREATE FUNCTION ${schema}.fail_transition() RETURNS event_trigger LANGUAGE plpgsql AS $$
    DECLARE stage_rows integer;old_exact_rows integer;transition_rows integer;hit boolean:=false;
    BEGIN
      IF '${phase}'='STAGE_READY' AND TG_TAG IN('CREATE TABLE','CREATE TABLE AS') AND to_regclass('pg_temp.windows_stage_cost_transition_stage') IS NOT NULL THEN hit:=true;
      ELSIF TG_TAG='CREATE FUNCTION' AND EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE objid='manga_web.windows_stage_cost_collect(jsonb,integer,boolean)'::regprocedure) THEN
        IF '${phase}'='OLD_OBSERVED' THEN hit:=true;
        ELSIF '${phase}'='DECISIONS_WRITTEN' THEN SELECT count(*) INTO transition_rows FROM manga_web.windows_stage_cost_ownership_transitions;hit:=transition_rows>0;END IF;
      END IF;
      IF hit THEN
        SELECT count(*),count(*) FILTER(WHERE old_exact) INTO stage_rows,old_exact_rows FROM pg_temp.windows_stage_cost_transition_stage;
        SELECT count(*) INTO transition_rows FROM manga_web.windows_stage_cost_ownership_transitions;
        RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='FIX_F10_${phase}',DETAIL=json_build_object('stageRows',stage_rows,'oldExactRows',old_exact_rows,'transitionRows',transition_rows)::text;
      END IF;
    END $$`);
  await db.pool.query('CREATE EVENT TRIGGER '+event+' ON ddl_command_end EXECUTE FUNCTION '+schema+'.fail_transition()');
  // 이 정리 대상은 이번 폐기 DB에서 만든 고유 검사 객체뿐이다. 제품 객체를 삭제하지 않는다.
  return async()=>{await db.pool.query('DROP EVENT TRIGGER '+event);await db.pool.query('DROP SCHEMA '+schema+' CASCADE');};
}
it.each(['STAGE_READY','OLD_OBSERVED','DECISIONS_WRITTEN'] as const)('B3-C F10 실제 migration %s 중간 SQL 오류는 구 함수·봉인·금융·applied·판정을 거래 전체로 되돌린다',async phase=>fixF10WithLegacy(async legacy=>{
  const a=await fixF10Healthy(legacy),b=await fixF10Healthy(legacy);await legacy.quiesce();const before=await fixF10Catalog(legacy.db),financial=await fixF10Financial(legacy.db),removeFailure=await fixF10InstallFailure(legacy.db,phase);
  try{
    await fixF10PinnedMigration(legacy.db,b.f.seed.accountId.toUpperCase(),async pool=>{
      let caught:unknown;try{await fixF10Migrate26(pool);}catch(error){caught=error;}
      expect(caught).toMatchObject({code:'40001',message:'FIX_F10_'+phase});const detail=JSON.parse((caught as {detail:string}).detail);expect(detail.stageRows).toBe(2);expect(detail.oldExactRows).toBe(phase==='STAGE_READY'?0:2);expect(detail.transitionRows).toBe(phase==='DECISIONS_WRITTEN'?2:0);
    });
    expect(await fixF10Catalog(legacy.db)).toEqual(before);expect(await fixF10Financial(legacy.db)).toEqual(financial);
    expect((await legacy.db.pool.query("SELECT to_regclass('manga_web.windows_stage_cost_ownership_transitions')::text transition")).rows).toEqual([{transition:null}]);
    for(const old of [a,b])expect(await lookup(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)})).toEqual(old.raw);
  }finally{await removeFailure();}
  await fixF10Migrate(legacy,b.f.seed.accountId);expect((await legacy.db.pool.query('SELECT disposition FROM manga_web.windows_stage_cost_ownership_transitions ORDER BY account_id,execution_id')).rows).toEqual([{disposition:'LEGACY_EXACT'},{disposition:'LEGACY_EXACT'}]);expect(await fixF10Financial(legacy.db)).toEqual(financial);
}),120000);



import {createB3CWindowsExecutionFixture as fixF10CreateB3C} from '../fixtures/windows-native.js';

it('B3-C F10 실제 25 A 봉인 뒤 26과 B PRE는 A의 원 집합·금액·ref·시각과 새 역사 조회를 보존한다',async()=>fixF10WithLegacy(async legacy=>{
  const {Database:DatabaseClass}=await import('../../packages/storage/src/database.js'),supplied=new DatabaseClass(legacy.db.connectionString);
  const f=await fixF10CreateB3C({mode:'PRE_BOUNDARY'},supplied);legacy.registerClose(()=>f.close());legacy.costs.push(f.cost);
  await f.cost.idle();await f.remote.gateway.idle();await f.remote.controller?.idle();
  expect(f.consumer).toBeNull();expect(f.producerBefore.go).toEqual([]);expect(f.producerBefore.intents).toEqual([]);
  expect((await legacy.db.pool.query<{name:string}>('SELECT name FROM trio_migrations.applied ORDER BY name')).rows.map(row=>Number(row.name.slice(0,4)))).toEqual(Array.from({length:25},(_,index)=>index+1));
  const original=await f.worker.accountTransaction(f.seed.accountId,tx=>f.cost.readIn(tx,f.source),true);
  expect(original.state).toBe('CONFIRMED');expect(original.costUsd).toBe('0.010000000000');expect(original.sealedCalculation).not.toBeNull();
  const refs=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{kind:string;evidence_id:string;evidence_digest:string}>("SELECT kind,evidence_id,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind,evidence_id",[f.seed.accountId,f.source.executionId])).rows,true);
  const inputs=refs.filter(row=>row.kind==='INPUT'),bases=refs.filter(row=>row.kind==='OPERATIONAL_COST_BASIS');expect(inputs).toHaveLength(1);expect(bases).toHaveLength(1);expect(inputs[0].evidence_digest).toBe(digest(canonicalInput(f.source)));
  const owner:Selector={executionId:f.source.executionId,inputEvidenceId:inputs[0].evidence_id,inputFingerprint:inputs[0].evidence_digest,basisRef:{evidenceId:bases[0].evidence_id,evidenceDigest:bases[0].evidence_digest}};
  const census=()=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{value:Census|null}>('SELECT manga_web.windows_stage_cost_lookup($1::jsonb,64) value',[JSON.stringify({version:1,mode:'CENSUS',owner})])).rows[0].value,true);
  const financial=async()=>({
    costs:(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',[f.seed.accountId,f.source.executionId])).rows,
    expenses:(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',[f.seed.accountId,f.source.executionId])).rows,
    evidence:(await f.admin.pool.query("SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY evidence_id",[f.seed.accountId,f.source.executionId])).rows,
    seals:(await f.admin.pool.query('SELECT * FROM manga_web.windows_stage_cost_seals WHERE account_id=$1 AND execution_id=$2 ORDER BY seal_id',[f.seed.accountId,f.source.executionId])).rows,
  });
  const raw=await census(),saved=await financial();expect(raw).not.toBeNull();expect(raw!.rows.length).toBeGreaterThan(0);expect(raw!.originals).toEqual([]);expect(saved.seals).toHaveLength(1);expect(saved.evidence).toHaveLength(3);expect(saved.costs).toHaveLength(1);expect(saved.expenses).toHaveLength(1);expect(saved.seals[0].raw_set_digest).toBe(raw!.rawSetDigest);expect(saved.costs[0].evidence_conflict).toBe(false);
  await fixF10Migrate(legacy,null);
  const decision=await fixF10Decision(legacy.db,f.seed.accountId,f.source.executionId);expect(decision).toMatchObject({disposition:'LEGACY_EXACT',reason:'EXACT',seal_id:saved.seals[0].seal_id,seal_digest:saved.seals[0].seal_digest,old_raw_set_digest:raw!.rawSetDigest,new_raw_set_digest:raw!.rawSetDigest});expect(decision.old_originals_digest).toBe(decision.new_originals_digest);expect(await census()).toEqual(raw);expect(await financial()).toEqual(saved);
  await f.runBoundary();const current=await f.inspect();
  expect(f.consumer).not.toBeNull();expect(f.consumer!.executionId).not.toBe(f.source.executionId);expect(current.inputs).toHaveLength(1);expect(current.enrollments).toHaveLength(1);expect(current.bases).toHaveLength(1);expect(current.roots).toHaveLength(1);
  expect(current.pre.state).toBe('VERIFIED');expect(current.pre.jobIds).toHaveLength(1);expect(current.pre.attempt!.targets.map(target=>target.sourceExecutionId)).toEqual([f.source.executionId]);expect(current.cost.state).toBe('UNCONFIRMED');expect(current.counts).toMatchObject({go:1,calculation:0,closure:0,expense:0});
  const owners=(await f.admin.pool.query("SELECT bi.execution_id cost_execution_id,n.source_execution_id,i.target_kind FROM manga_web.windows_native_cost_bindings bi JOIN manga_web.native_capacity_reservations n USING(account_id,job_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) WHERE bi.account_id=$1 AND bi.job_id=$2",[f.seed.accountId,current.pre.jobIds[0]])).rows;expect(owners).toEqual([{cost_execution_id:f.consumer!.executionId,source_execution_id:f.source.executionId,target_kind:'REQUEST_CHECKPOINT'}]);
  await f.cost.idle();await f.remote.gateway.idle();await f.remote.controller?.idle();expect(await census()).toEqual(raw);expect(await financial()).toEqual(saved);
  const history=f.reopenCost();expect(history).not.toBe(f.cost);legacy.costs.push(history);
  const reads=vi.spyOn(f.files,'read'),puts=vi.spyOn(f.files,'put');
  try{
    const recovered=await f.worker.accountTransaction(f.seed.accountId,tx=>history.readIn(tx,f.source),true);await history.idle();
    expect(recovered.state).toBe('CONFIRMED');expect(recovered.costUsd).toBe(original.costUsd);expect(recovered.sealedCalculation).toEqual(original.sealedCalculation);expect(recovered.calculations).toEqual(original.calculations);expect(reads).not.toHaveBeenCalled();expect(puts).not.toHaveBeenCalled();
    expect(await census()).toEqual(raw);expect(await financial()).toEqual(saved);expect(await fixF10Decision(legacy.db,f.seed.accountId,f.source.executionId)).toEqual(decision);
  }finally{reads.mockRestore();puts.mockRestore();}
}),120000);


async function fixF10InstallMembershipFault(db:Database,mode:'MISSING'|'DUPLICATE'){
  const suffix=randomUUID().replaceAll('-',''),schema='fix_members_'+suffix,event='fix_members_'+suffix;
  await db.pool.query('CREATE SCHEMA '+schema);
  await db.pool.query('CREATE FUNCTION '+schema+'.distort() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN '+(mode==='MISSING'?'RETURN NULL;':"IF pg_trigger_depth()=1 THEN INSERT INTO manga_web.windows_stage_cost_ownership_transitions SELECT (NEW).*;END IF;RETURN NEW;")+' END $fault$');
  await db.pool.query('CREATE FUNCTION '+schema+'.install_fault() RETURNS event_trigger LANGUAGE plpgsql AS $fault$ BEGIN '+
    "IF TG_TAG='CREATE TABLE' AND to_regclass('manga_web.windows_stage_cost_ownership_transitions') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('manga_web.windows_stage_cost_ownership_transitions') AND tgname='fix_membership_fault') THEN "+
    'CREATE TRIGGER fix_membership_fault BEFORE INSERT ON manga_web.windows_stage_cost_ownership_transitions FOR EACH ROW EXECUTE FUNCTION '+schema+'.distort();END IF;END $fault$');
  await db.pool.query('CREATE EVENT TRIGGER '+event+' ON ddl_command_end EXECUTE FUNCTION '+schema+'.install_fault()');
  return async()=>{await db.pool.query('DROP EVENT TRIGGER '+event);await db.pool.query('DROP SCHEMA '+schema+' CASCADE');};
}
it.each(['MISSING','DUPLICATE'] as const)('B3-C F10 actual transition %s decision cannot commit or change old money',async mode=>fixF10WithLegacy(async legacy=>{
  const old=await fixF10Healthy(legacy);await legacy.quiesce();
  const before=await fixF10Catalog(legacy.db),money=await fixF10Financial(legacy.db),removeFault=await fixF10InstallMembershipFault(legacy.db,mode);
  try{
    await fixF10PinnedMigration(legacy.db,old.f.seed.accountId,async pool=>{
      if(mode==='MISSING')await expect(fixF10Migrate26(pool)).rejects.toMatchObject({code:'40001',message:'WINDOWS_STAGE_COST_TRANSITION_MEMBERSHIP_CHANGED'});
      else await expect(fixF10Migrate26(pool)).rejects.toMatchObject({code:'23505'});
    });
    expect(await fixF10Catalog(legacy.db)).toEqual(before);expect(await fixF10Financial(legacy.db)).toEqual(money);
    expect((await legacy.db.pool.query("SELECT to_regclass('manga_web.windows_stage_cost_ownership_transitions')::text value")).rows).toEqual([{value:null}]);
    expect(await lookup<Census>(old.f,{version:1,mode:'CENSUS',owner:selector(old.x.owner)})).toEqual(old.raw);
  }finally{await removeFault();}
  await fixF10Migrate(legacy,null);expect((await fixF10Decision(legacy.db,old.f.seed.accountId,old.x.owner.executionId)).disposition).toBe('LEGACY_EXACT');
}),120000);

it.each(['CURRENT_ROLE','FUNCTION_OWNER'] as const)('B3-C F10 forced RLS %s cannot turn hidden old seals into an empty migration',async mode=>fixF10WithLegacy(async legacy=>{
  const old=await fixF10Healthy(legacy);await legacy.quiesce();const role='fix_rls_'+randomUUID().replaceAll('-',''),functionName='manga_web.windows_stage_cost_collect(jsonb,integer,boolean)';
  const originalOwner=(await legacy.db.pool.query('SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=$1::regprocedure',[functionName])).rows[0].owner as string;
  const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
  await legacy.db.pool.query('CREATE ROLE '+quoted(role)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  try{
    const database=(await legacy.db.pool.query('SELECT current_database() name')).rows[0].name as string;
    await legacy.db.pool.query('GRANT CREATE,TEMP ON DATABASE '+quoted(database)+' TO '+quoted(role));
    await legacy.db.pool.query('GRANT USAGE,CREATE ON SCHEMA manga_web,trio_migrations TO '+quoted(role));
    await legacy.db.pool.query('GRANT SELECT,REFERENCES ON manga_web.windows_stage_cost_seals TO '+quoted(role));
    await legacy.db.pool.query('GRANT SELECT,INSERT ON trio_migrations.applied TO '+quoted(role));
    await legacy.db.pool.query('GRANT EXECUTE ON FUNCTION manga_web.immutable_native_job_record() TO '+quoted(role));
    if(mode==='FUNCTION_OWNER')await legacy.db.pool.query('ALTER FUNCTION '+functionName+' OWNER TO '+quoted(role));
    const before=await fixF10Catalog(legacy.db),money=await fixF10Financial(legacy.db),roles=(await legacy.db.pool.query('SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows;
    expect(roles).toEqual([{rolname:role,rolsuper:false,rolbypassrls:false}]);
    const pool=new pg.Pool({connectionString:legacy.db.connectionString,max:1});
    try{
      const first=await pool.connect();try{
        await first.query('SET ROLE '+quoted(role));
        expect((await first.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:0}]);
        expect((await legacy.db.pool.query('SELECT count(*)::integer n FROM manga_web.windows_stage_cost_seals')).rows).toEqual([{n:1}]);
        if(mode==='FUNCTION_OWNER')await first.query('RESET ROLE');
      }finally{first.release();}
      await expect(fixF10Migrate26(pool)).rejects.toMatchObject({code:'42501',message:'WINDOWS_STAGE_COST_TRANSITION_ACCESS_DENIED'});
      const last=await pool.connect();try{await last.query('RESET ROLE');expect((await last.query("SELECT to_regclass('pg_temp.windows_stage_cost_transition_stage')::text value")).rows).toEqual([{value:null}]);}finally{last.release();}
    }finally{await pool.end();}
    expect(await fixF10Catalog(legacy.db)).toEqual(before);expect(await fixF10Financial(legacy.db)).toEqual(money);
    expect((await legacy.db.pool.query("SELECT to_regclass('manga_web.windows_stage_cost_ownership_transitions')::text value")).rows).toEqual([{value:null}]);
    expect((await legacy.db.pool.query('SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows).toEqual(roles);
  }finally{
    if(mode==='FUNCTION_OWNER')await legacy.db.pool.query('ALTER FUNCTION '+functionName+' OWNER TO '+quoted(originalOwner));
    expect((await legacy.db.pool.query("SELECT count(*)::integer n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)",[role])).rows).toEqual([{n:0}]);
    await legacy.db.pool.query('DROP OWNED BY '+quoted(role));await legacy.db.pool.query('DROP ROLE '+quoted(role));
  }
  await fixF10Migrate(legacy,null);expect((await fixF10Decision(legacy.db,old.f.seed.accountId,old.x.owner.executionId)).disposition).toBe('LEGACY_EXACT');
}),120000);



it('B3-C F12 actual own raw rows 16383 16384 16385 preserve exact full raw-only manifests and reject the entire excess',async()=>withPrepared(async(f,x)=>{
  await zeroWindowsWork(f,x);
  const base=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});expect(base).not.toBeNull();expect(base!.originals).toEqual([]);
  const insert=async(first:number,count:number)=>f.admin.pool.query(
    "WITH ids AS(SELECT gen_random_uuid() id,n FROM generate_series($3::integer,$3::integer+$4::integer-1) n),bodies AS(SELECT id,jsonb_build_object('version',1,'accountId',$1::text,'executionId',$2::text,'kind','FIX_RAW_ROW_BOUND','value',jsonb_build_object('ordinal',n)) body FROM ids) INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation) SELECT $1::uuid,item.id,$2::uuid,'FIX_RAW_ROW_BOUND',manga_web.windows_native_cost_hash(item.body),item.id::text,item.body FROM bodies item",
    [f.seed.accountId,x.owner.executionId,first,count]);
  let inserted=0;
  for(const expected of [16383,16384,16385]){
    const add=expected-base!.rows.length-inserted;expect(add).toBeGreaterThan(0);await insert(inserted+1,add);inserted+=add;
    expect((await f.admin.pool.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='FIX_RAW_ROW_BOUND'",[f.seed.accountId,x.owner.executionId])).rows).toEqual([{n:inserted}]);
    const full=await lookup<Census>(f,{version:1,mode:'CENSUS',owner:selector(x.owner)});
    const rawOnly=await f.admin.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{value:Census|null}>('SELECT manga_web.windows_stage_cost_collect($1::jsonb,64,false) value',[JSON.stringify(x.owner)])).rows[0].value,true);
    if(expected<=16384){
      expect(full).not.toBeNull();expect(rawOnly).not.toBeNull();expect(full!.rows).toHaveLength(expected);
      expect(full!.rows.filter(row=>row.kind==='EVIDENCE'&&row.id)).toHaveLength(base!.rows.filter(row=>row.kind==='EVIDENCE').length+inserted);
      expect(rawOnly!.rows).toEqual(full!.rows);expect(rawOnly!.manifest).toEqual(full!.manifest);expect(rawOnly!.rawSetDigest).toBe(full!.rawSetDigest);
      expect(full!.manifest).toEqual(manifest(full!.rows));expect(full!.rawSetDigest).toBe(digest(full!.manifest));expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(8388608);
    }else{expect(full).toBeNull();expect(rawOnly).toBeNull();}
  }
  expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_stage_cost_seals) seals,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CALCULATION') calculations,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind='OPERATIONAL_COST_CLOSURE') closures,(SELECT count(*)::integer FROM manga_web.execution_limit_expenses) expenses")).rows).toEqual([{seals:0,calculations:0,closures:0,expenses:0}]);
}),120000);

