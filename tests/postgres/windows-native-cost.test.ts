import {expect,it,vi} from 'vitest';
vi.hoisted(()=>{vi.doMock('sharp',()=>({default:()=>{throw new Error('W4A_SHARP_FORBIDDEN');}}));});
import {guardWindowsNativeIo,windowsNativeFixture,createWindowsNativeCostRemoteFixture,type WindowsNativeFixture} from '../fixtures/windows-native.js';
import {createWindowsNativeCostOriginalFixture} from '../fixtures/windows-native.js';
import {WindowsNativeCostJournal,WindowsNativeCapacityOperator} from '../../packages/domain/src/windows-native-cost.js';
import {NativeCapacityStore} from '../../packages/domain/src/native-capacity.js';
import {validateWindowsNativeEvidenceBundle,type WindowsNativeOriginalKey} from '../../packages/domain/src/native-receipts.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import pg from 'pg';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {Database} from '../../packages/storage/src/database.js';
import {migrate} from '../../packages/storage/src/migrations.js';
import {seedIdentity} from '../fixtures/database.js';
import {nativeLogicalOperationKey,type NativeJobIntent} from '../../packages/domain/src/native-jobs.js';
import type {NativeCapacityProof,OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';

async function costFixture(run:(f:WindowsNativeFixture,x:Awaited<ReturnType<typeof createWindowsNativeCostRemoteFixture>>)=>Promise<void>){
  const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined,x:Awaited<ReturnType<typeof createWindowsNativeCostRemoteFixture>>|undefined;
  const errors:unknown[]=[];
  try{f=await windowsNativeFixture();x=await createWindowsNativeCostRemoteFixture(f);await run(f,x);}catch(error){errors.push(error);}
  finally{try{await x?.close();}catch(error){errors.push(error);}try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4A_OPERATION_AND_CLEANUP_FAILED');
}

it('W4-A original framed job SEAL FINALIZED link exposes a bounded historical bundle',async()=>costFixture(async(f,x)=>{
  expect((await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.windows_native_records WHERE purpose='SEAL') AS seals,
    (SELECT count(*)::integer FROM manga_web.windows_native_records WHERE purpose='FINALIZED') AS finalized,
    (SELECT count(*)::integer FROM manga_web.windows_native_links) AS links,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) AS go`)).rows).toEqual([{seals:1,finalized:1,links:1,go:1}]);
  const value=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{bundle:unknown}>('SELECT manga_web.windows_native_evidence_lookup($1::jsonb) AS bundle',[JSON.stringify(x.key)])).rows[0].bundle);
  expect(value).toMatchObject({state:{allowed:true,view:{windowsEvidenceRef:x.key.expected}},original:{reservationId:x.binding.capacityReservationId},job:{jobId:x.binding.jobId}});
}));

const waiting={state:'WAIT',operation:null,termination:null};
function journal(f:WindowsNativeFixture){return new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:2});}
function operator(f:WindowsNativeFixture){return new WindowsNativeCapacityOperator(f.operator.client,f.operator.name);}
async function lookup(f:WindowsNativeFixture,key:WindowsNativeOriginalKey){return f.worker.accountTransaction(key.binding.accountId,async tx=>(await tx.client.query<{bundle:unknown}>('SELECT manga_web.windows_native_evidence_lookup($1::jsonb) AS bundle',[JSON.stringify(key)])).rows[0].bundle,true);}
async function bridge(f:WindowsNativeFixture,key:WindowsNativeOriginalKey,write=true){const cost=journal(f);return f.worker.accountTransaction(key.binding.accountId,tx=>write?cost.recordIn(tx,key):cost.lookupIn(tx,key),true);}
async function money(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT
 (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY cost_item_id),'[]') FROM manga_web.cost_items t) AS costs,
 (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY cost_item_id),'[]') FROM manga_web.execution_limit_expenses t) AS expenses,
 (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY execution_id),'[]') FROM manga_web.execution_capacity_permits t) AS permits,
 (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY account_id),'[]') FROM manga_web.accounts t) AS accounts,
 (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY request_id),'[]') FROM manga_web.free_reservations t) AS free`)).rows[0];}
async function bridgeRows(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT evidence_id,evidence_digest,received_at,kind,protected_observation FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION') ORDER BY kind`)).rows;}
async function proofRows(f:WindowsNativeFixture){return (await f.admin.pool.query('SELECT * FROM manga_web.windows_native_termination_proofs ORDER BY proof_id')).rows;}
async function held(f:WindowsNativeFixture){return (await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations ORDER BY reservation_id')).rows;}
async function originalFixture(run:(f:WindowsNativeFixture,x:Awaited<ReturnType<typeof createWindowsNativeCostOriginalFixture>>)=>Promise<void>,options:Parameters<typeof createWindowsNativeCostOriginalFixture>[1]={}){
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined;const errors:unknown[]=[];
 try{f=await windowsNativeFixture(20.5);const x=await createWindowsNativeCostOriginalFixture(f,options);await run(f,x);}catch(error){errors.push(error);}
 finally{try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
 if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W4A_OPERATION_AND_CLEANUP_FAILED');
}

it('W4-A actual worker bridge records distinct canonical refs and exact accounting without billing or object IO',async()=>costFixture(async(f,x)=>{
 const before=await money(f),io={...f.objectIo};expect(await bridge(f,x.key,false)).toEqual(waiting);expect(await bridgeRows(f)).toEqual([]);
 const value=await bridge(f,x.key);expect(value).toMatchObject({state:'VERIFIED'});expect(value.operation!.evidenceId).not.toBe(value.termination!.evidenceId);
 const rows=await bridgeRows(f);expect(rows).toHaveLength(2);for(const row of rows)expect(row.evidence_digest).toBe(digest(row.protected_observation));
 expect(rows[0].protected_observation.value).toMatchObject({binding:x.binding,accounting:{value:{userTime100ns:'9007199254740993',snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS'}}});
 expect(rows[1].protected_observation.value).toMatchObject({jobId:x.binding.jobId,termination:{kind:'WINDOWS_JOB_EMPTY'}});
 expect(await bridge(f,x.key,false)).toEqual(value);expect(await bridge(f,x.key)).toEqual(value);expect(await bridgeRows(f)).toEqual(rows);expect(await money(f)).toEqual(before);expect(f.objectIo).toEqual(io);expect(f.provider.calls).toEqual([]);
}));

it('W4-A Windows confirmation retains HELD and recovery proof until one explicit release',async()=>costFixture(async(f,x)=>{
 const before=await money(f),io={...f.objectIo},bundle=await lookup(f,x.key),facts=validateWindowsNativeEvidenceBundle(bundle,x.key,'trio_web_worker');
 const op=operator(f),decision=await op.confirmWindows(x.key);expect(decision).toMatchObject({allowed:true,reason:'PROOF_CONFIRMED',capacityReservationId:x.binding.capacityReservationId});
 expect(await held(f)).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);
 const recovery=await new NativeCapacityStore(f.worker,f.seed.accountId).recover();expect(recovery).toHaveLength(1);expect(recovery[0].terminationProofId).toBe(decision.proofId);
 const proof=(await proofRows(f))[0];expect(proof.proof_metadata.accountingDigest).toBe(digest(facts.accounting!.value));expect(proof.link_canonical).toBe(facts.link.canonical);expect(proof.link_signature).toBe(facts.link.signature);
 expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_roots()')).rows).toEqual([{n:1}]);
 const released=await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,decision.proofId!);expect(released).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED',proofId:decision.proofId});
 const state=(await held(f))[0];expect(state).toMatchObject({state:'RELEASED',release_proof_id:null,windows_release_proof_id:decision.proofId});expect(state.released_at.getTime()).toBeGreaterThanOrEqual(proof.confirmed_at.getTime());
 expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_roots()')).rows).toEqual([{n:0}]);expect(await money(f)).toEqual(before);expect(f.objectIo).toEqual(io);
}));

it('W4-A TERM-only no-create records original refs and releases without grant consumption raw or child usage',async()=>originalFixture(async(f,x)=>{
 const before=await money(f),value=await bridge(f,x.key);expect(value.state).toBe('VERIFIED');const rows=await bridgeRows(f);
 expect(rows[0].protected_observation.value).toMatchObject({goGrantRef:null,rawResult:null,accounting:null,observations:{result:null}});expect(rows[1].protected_observation.value.termination).toMatchObject({kind:'NO_CHILD_CREATED',goAttempted:false,startedComputation:false,operationJoined:true});
 expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.native_controller_go_grants) AS grants,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) AS consumed,(SELECT count(*)::integer FROM manga_web.native_controller_raw_results) AS raw')).rows).toEqual([{grants:0,consumed:0,raw:0}]);
 const op=operator(f),proof=await op.confirmWindows(x.key);await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proof.proofId!);expect(await money(f)).toEqual(before);expect(f.objectIo).toEqual({get:0,put:0});
}));

it.each(['CREATED_NO_GO','UNKNOWN'] as const)('W4-A %s stays WAIT HELD without bridge or proof',async mode=>originalFixture(async(f,x)=>{
 expect(await bridge(f,x.key)).toEqual(waiting);await expect(operator(f).confirmWindows(x.key)).rejects.toMatchObject({nextAction:'WAIT'});expect(await bridgeRows(f)).toEqual([]);expect(await proofRows(f)).toEqual([]);expect((await held(f))[0].state).toBe('HELD');
},{mode}));

it('W4-A original semantic failure still releases its physical slot without semantic receipt or native ERROR',async()=>{
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined,x:Awaited<ReturnType<typeof createWindowsNativeCostRemoteFixture>>|undefined;
 try{f=await windowsNativeFixture();x=await createWindowsNativeCostRemoteFixture(f,true);expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_result_receipts) AS receipts,(SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='ERROR') AS errors")).rows).toEqual([{receipts:0,errors:0}]);
 const op=operator(f),proof=await op.confirmWindows(x.key);expect((await bridge(f,x.key)).state).toBe('VERIFIED');expect((await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proof.proofId!)).allowed).toBe(true);
 }finally{try{await x?.close();await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});

async function corrupted<T>(f:WindowsNativeFixture,mutate:(client:PoolClient)=>Promise<unknown>,run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await f.admin.pool.connect();try{
  await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');await mutate(client);await client.query('SET LOCAL session_replication_role=origin');
  return await run(client);
 }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
}
async function corruptedBridge(f:WindowsNativeFixture,key:WindowsNativeOriginalKey,mutate:(client:PoolClient)=>Promise<unknown>){return corrupted(f,mutate,async client=>{
 await client.query('SET LOCAL ROLE trio_web_worker');const tx=await f.worker.accountContext(client,key.binding.accountId,true);const value=await journal(f).recordIn(tx,key);
 const rows=(await client.query("SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')")).rows;expect(rows).toEqual([{n:0}]);return value;
});}
const originalFaults=[
 {name:'INPUT missing',sql:"DELETE FROM manga_web.execution_evidence WHERE kind='INPUT'"},
 {name:'INPUT body',sql:"UPDATE manga_web.execution_evidence SET protected_observation=jsonb_set(protected_observation,'{settings,baseFontSizePx}','30') WHERE kind='INPUT'"},
 {name:'BASIS body',sql:"UPDATE manga_web.execution_evidence SET protected_observation=jsonb_set(protected_observation,'{value,captureDigest}',to_jsonb(repeat('b',64))) WHERE kind='OPERATIONAL_COST_BASIS'"},
 {name:'BASIS digest',sql:"UPDATE manga_web.execution_evidence SET evidence_digest=repeat('b',64) WHERE kind='OPERATIONAL_COST_BASIS'"},
 {name:'claim tuple',sql:"UPDATE manga_web.native_job_intents SET protected_intent=jsonb_set(protected_intent,'{claim,generation}','\"99\"')"},
 {name:'key version',sql:"UPDATE manga_web.native_capacity_profiles SET key_version='changed-key',profile_payload=jsonb_set(profile_payload,'{keyVersion}','\"changed-key\"')"},
 {name:'environment',sql:"UPDATE manga_web.native_capacity_profiles SET environment_digest=repeat('b',64),profile_payload=jsonb_set(profile_payload,'{environmentDigest}',to_jsonb(repeat('b',64)))"},
 {name:'capture bytes',sql:"UPDATE manga_web.windows_native_origins SET origin_canonical=origin_canonical||' '"},
 {name:'GO grant',sql:'DELETE FROM manga_web.native_controller_go_grants'},
 {name:'GO consumption',sql:'DELETE FROM manga_web.native_job_go_consumptions'},
 {name:'SEAL event missing',sql:"DELETE FROM manga_web.windows_native_events WHERE kind='FINAL_ACCOUNTING'"},
 {name:'SEAL event digest',sql:"UPDATE manga_web.windows_native_events SET source_digest=repeat('b',64) WHERE kind='FINAL_ACCOUNTING'"},
 {name:'PARENT_JOIN',sql:"DELETE FROM manga_web.windows_native_records WHERE purpose='PARENT_JOIN'"},
 {name:'FINALIZED',sql:"DELETE FROM manga_web.windows_native_records WHERE purpose='FINALIZED'"},
 {name:'link bytes',sql:"UPDATE manga_web.windows_native_links SET canonical=canonical||' '"},
 {name:'RESULT',sql:"DELETE FROM manga_web.native_controller_events WHERE kind='OBSERVATION'"},
 {name:'TERM tuple',sql:"UPDATE manga_web.native_job_observations SET protected_observation=jsonb_set(protected_observation,'{termination,operationJoined}','false') WHERE event='TERMINATION'"},
 {name:'raw object receipt',sql:"UPDATE manga_web.native_controller_object_receipts SET protected_receipt=jsonb_set(protected_receipt,'{sha256}',to_jsonb(repeat('b',64)))"},
 {name:'job bytes',sql:"UPDATE manga_web.native_controller_attempts SET input_canonical=input_canonical||' '"},
 {name:'owner service tuple',sql:"UPDATE manga_web.native_capacity_reservations SET owner_service='trio_web_api'"},
] as const;
it.each(originalFaults)('W4-A original $name tampering cannot create bridge or proof',async fault=>costFixture(async(f,x)=>{
 expect(await corruptedBridge(f,x.key,client=>client.query(fault.sql))).toEqual(waiting);expect((await bridge(f,x.key)).state).toBe('VERIFIED');
}));

it('W4-A canonical-shaped forged original signature fails cryptographic shared validation',async()=>costFixture(async(f,x)=>{
 const signature=Buffer.alloc(64,6).toString('base64');expect(await corruptedBridge(f,x.key,client=>client.query('UPDATE manga_web.windows_native_links SET signature=$1',[signature]))).toEqual(waiting);
 expect(await proofRows(f)).toEqual([]);
}));
it.each(['CONSUMPTION','GRANT'] as const)('W4-A no-create independently rejects a surviving %s even when grant lookup is null',async kind=>originalFixture(async(f,x)=>{
 const mutate=(client:PoolClient)=>kind==='CONSUMPTION'?client.query('INSERT INTO manga_web.native_job_go_consumptions(account_id,job_id,parent_instance_id,consumed_at) VALUES($1,$2,$3,clock_timestamp())',[x.binding.accountId,x.binding.jobId,x.binding.parentInstanceId]):client.query('INSERT INTO manga_web.native_controller_go_grants(account_id,attempt_id,job_id,controller_instance_id,granted_at) VALUES($1,$2,$3,$4,clock_timestamp())',[x.binding.accountId,x.capture.origin.authority.attemptId,x.binding.jobId,f.controllerInstanceId]);
 expect(await corruptedBridge(f,x.key,mutate)).toEqual(waiting);
}));

it('W4-A account and exact key tuples cannot authorize a different original',async()=>costFixture(async(f,x)=>{
 for(const key of [{...x.key,binding:{...x.binding,jobId:randomUUID()}},{...x.key,expected:{...x.key.expected,linkId:randomUUID()}},{...x.key,binding:{...x.binding,parentInstanceId:randomUUID()}}])expect(await bridge(f,key)).toEqual(waiting);
 await expect(f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT manga_web.windows_native_evidence_lookup($1::jsonb)',[JSON.stringify({...x.key,binding:{...x.binding,accountId:randomUUID()}})]))).rejects.toMatchObject({code:'42501'});
 expect(await bridgeRows(f)).toEqual([]);
}));

it('W4-A bridge confirmation and release recover COMMIT ACK loss with original IDs digests and dates',async()=>costFixture(async(f,x)=>{
 const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false;
 const txSpy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async(...args)=>{const result=await transaction(...args);if(!lost){lost=true;throw new Error('W4A_BRIDGE_ACK_LOST_AFTER_COMMIT');}return result;});
 try{await expect(bridge(f,x.key)).rejects.toThrow('W4A_BRIDGE_ACK_LOST_AFTER_COMMIT');}finally{txSpy.mockRestore();}
 const rows=await bridgeRows(f),value=await bridge(f,x.key,false);expect(value.state).toBe('VERIFIED');expect(await bridge(f,x.key)).toEqual(value);expect(await bridgeRows(f)).toEqual(rows);
 const op=operator(f);
 for(const fn of ['native_capacity_confirm_windows_proof','native_capacity_release_windows']){
  const original=f.operator.client.query;let lost=false;
  const spy=vi.spyOn(f.operator.client,'query').mockImplementation((async(...args:unknown[])=>{const result=await Reflect.apply(original,f.operator.client,args);if(!lost&&String(args[0]).includes(fn)){lost=true;throw new Error('W4A_OPERATOR_ACK_LOST_AFTER_COMMIT');}return result;}) as typeof original);
  try{await expect(fn==='native_capacity_confirm_windows_proof'?op.confirmWindows(x.key):op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,(await proofRows(f))[0].proof_id)).rejects.toThrow('W4A_OPERATOR_ACK_LOST_AFTER_COMMIT');}finally{spy.mockRestore();}
  const proofs=await proofRows(f),reservation=await held(f);expect(proofs).toHaveLength(1);
  if(fn==='native_capacity_confirm_windows_proof'){expect((await op.confirmWindows(x.key)).proofId).toBe(proofs[0].proof_id);expect(await proofRows(f)).toEqual(proofs);}
  else{await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proofs[0].proof_id);expect(await held(f)).toEqual(reservation);}
 }
}));

it('W4-A concurrent bridge confirmation and release preserve one proof and one release timestamp',async()=>costFixture(async(f,x)=>{
 const values=await Promise.all([bridge(f,x.key),bridge(f,x.key),bridge(f,x.key)]);expect(values[0].state).toBe('VERIFIED');expect(values[1]).toEqual(values[0]);expect(values[2]).toEqual(values[0]);
 const client=new pg.Client({connectionString:f.operator.connectionString});await client.connect();try{await client.query('SET ROLE trio_web_operator');const first=operator(f),second=new WindowsNativeCapacityOperator(client,f.operator.name);
 const proofs=await Promise.all([first.confirmWindows(x.key),second.confirmWindows(x.key)]);expect(proofs[0].proofId).toBe(proofs[1].proofId);expect(await proofRows(f)).toHaveLength(1);
 await Promise.all([first.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proofs[0].proofId!),second.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proofs[0].proofId!)]);
 const released=await held(f);await first.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proofs[0].proofId!);expect(await held(f)).toEqual(released);expect(await bridgeRows(f)).toHaveLength(2);
 }finally{await client.end();}
}));

it('W4-A historical facts survive owner retention profile-authority and account-state drift after release',async()=>costFixture(async(f,x)=>{
 const before=await lookup(f,x.key),recorded=await bridge(f,x.key),op=operator(f),proof=await op.confirmWindows(x.key);await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proof.proofId!);
 await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1",[f.seed.accountId]);
 await f.admin.pool.query("UPDATE manga_web.assets SET sha256=repeat('b',64),deletion_state='CONFIRMED' WHERE account_id=$1",[f.seed.accountId]);
 await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET state='HALTED',revision=revision+1 WHERE singleton");await f.admin.pool.query("UPDATE manga_web.accounts SET access_state='CLOSED' WHERE account_id=$1",[f.seed.accountId]);
 const io={...f.objectIo};expect(await lookup(f,x.key)).toEqual(before);expect(await bridge(f,x.key,false)).toEqual(recorded);expect((await op.confirmWindows(x.key)).proofId).toBe(proof.proofId);expect((await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proof.proofId!)).reason).toBe('RELEASE_REPLAY');expect(f.objectIo).toEqual(io);
}));

it.each(['trio_web_api','trio_web_worker','trio_web_controller'] as const)('W4-A %s cannot SELECT Windows originals or proofs call operator private functions or write releases',async role=>costFixture(async(f,x)=>{
 const statements=[
  'SELECT * FROM manga_web.windows_native_termination_proofs','SELECT * FROM manga_web.windows_native_links',
  'UPDATE manga_web.native_capacity_reservations SET state=state',
  'INSERT INTO manga_web.windows_native_termination_proofs DEFAULT VALUES',
  'SELECT manga_web.native_capacity_windows_operator_evidence($1::jsonb)',
  "SELECT manga_web.native_capacity_confirm_windows_proof($1::jsonb,'{}','{}','x')",
  'SELECT manga_web.native_capacity_release_windows(NULL,NULL,NULL)',
  "SELECT manga_web.windows_native_evidence_bundle($1::jsonb,'trio_web_worker')",
  'SELECT manga_web.native_capacity_registered_proof(NULL,NULL)',
  "SELECT manga_web.windows_native_evidence_bridge($1::jsonb,'{}','{}',true)",
 ];
 for(const sql of statements){
  const values=sql.includes('$1')?[JSON.stringify(x.key)]:[];
  const run=role==='trio_web_controller'?()=>f.controller.client.query(sql,values):()=>f[role==='trio_web_api'?'api':'worker'].accountTransaction(f.seed.accountId,tx=>tx.client.query(sql,values));
  await expect(run(),sql).rejects.toMatchObject({code:'42501'});
 }
 if(role!=='trio_web_worker'){
  const run=role==='trio_web_controller'?()=>f.controller.client.query('SELECT manga_web.windows_native_evidence_lookup($1::jsonb)',[JSON.stringify(x.key)]):()=>f.api.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT manga_web.windows_native_evidence_lookup($1::jsonb)',[JSON.stringify(x.key)]));
  await expect(run()).rejects.toMatchObject({code:'42501'});
 }
}));

it('W4-A operator has only bounded capabilities and no direct proof table or worker bridge access',async()=>costFixture(async(f,x)=>{
 for(const sql of ['SELECT * FROM manga_web.windows_native_termination_proofs','SELECT * FROM manga_web.windows_native_origins','SELECT manga_web.windows_native_evidence_lookup($1::jsonb)',"SELECT manga_web.windows_native_evidence_record($1::jsonb,'{}','{}')","SELECT manga_web.windows_native_evidence_bundle($1::jsonb,NULL)"])
  await expect(f.operator.client.query(sql,sql.includes('$1')?[JSON.stringify(x.key)]:[]),sql).rejects.toMatchObject({code:'42501'});
 const rows=(await f.admin.pool.query(`SELECT c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid='manga_web.windows_native_termination_proofs'::regclass`)).rows;expect(rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
}));

it('W4-A operator compares exact original link bytes signature and metadata tuple on every retry',async()=>costFixture(async(f,x)=>{
 const op=operator(f),confirmed=await op.confirmWindows(x.key),rows=await proofRows(f),proof=rows[0];
 const changes=[{...proof.proof_metadata,adoptionId:randomUUID()},{...proof.proof_metadata,accountingDigest:digest({wrong:'event wrapper'})},{...proof.proof_metadata,binding:{...x.binding,parentInstanceId:randomUUID()}},{...proof.proof_metadata,source:{...proof.proof_metadata.source,inputFingerprint:'b'.repeat(64)}},{...proof.proof_metadata,verified:true}];
 for(const metadata of changes){const value=(await f.operator.client.query('SELECT manga_web.native_capacity_confirm_windows_proof($1::jsonb,$2::jsonb,$3,$4) AS decision',[JSON.stringify(x.key),JSON.stringify(metadata),proof.link_canonical,proof.link_signature])).rows[0].decision;expect(value.allowed).toBe(false);}
 for(const [canonical,signature] of [[proof.link_canonical+' ',proof.link_signature],[proof.link_canonical,Buffer.alloc(64,7).toString('base64')]]){
  const value=(await f.operator.client.query('SELECT manga_web.native_capacity_confirm_windows_proof($1::jsonb,$2::jsonb,$3,$4) AS decision',[JSON.stringify(x.key),JSON.stringify(proof.proof_metadata),canonical,signature])).rows[0].decision;expect(value.allowed).toBe(false);
 }
 expect(await proofRows(f)).toEqual(rows);expect((await held(f))[0].state).toBe('HELD');expect((await op.confirmWindows(x.key)).proofId).toBe(confirmed.proofId);
}));

it('W4-A release state FK and profile guard reject HELD proof attachment dual proofs and cross reservations',async()=>costFixture(async(f,x)=>{
 const proof=await operator(f).confirmWindows(x.key),id=proof.proofId!;
 for(const sql of [
  'UPDATE manga_web.native_capacity_reservations SET windows_release_proof_id=$1',
  "UPDATE manga_web.native_capacity_reservations SET state='RELEASED',released_at=clock_timestamp(),release_proof_id=$1,windows_release_proof_id=$1",
  "UPDATE manga_web.native_capacity_reservations SET state='RELEASED',released_at=clock_timestamp(),release_proof_id=$1",
 ])await expect(f.admin.pool.query(sql,[id])).rejects.toMatchObject({code:'23514'});
 await expect(operator(f).releaseWindows(f.seed.accountId,randomUUID(),id)).rejects.toMatchObject({nextAction:'WAIT'});await expect(operator(f).releaseWindows(randomUUID(),x.binding.capacityReservationId,id)).rejects.toMatchObject({nextAction:'WAIT'});
 const client=await f.admin.pool.connect();try{await client.query('BEGIN');await client.query('ALTER TABLE manga_web.native_capacity_reservations DISABLE TRIGGER native_capacity_reservation_record');
  await expect(client.query("UPDATE manga_web.native_capacity_reservations SET state='RELEASED',released_at=clock_timestamp(),windows_release_proof_id=$1",[randomUUID()])).rejects.toMatchObject({code:'23503'});
 }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
 expect((await held(f))[0].state).toBe('HELD');
}));

it('W4-A confirmed Windows proof blocks capacity current and GO while SQL promotion adoption and occupancy recognize v2',async()=>originalFixture(async(f,x)=>{
 // Provider preflight intentionally retains the W4-C native-wait gate. This
 // W4-A case exercises the actual SQL admission capability and its proof consumer.
 const reserve=()=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.reserve_execution_limits($1,$2,$3,$4,$5::jsonb) decision',[x.execution.input.executionId,x.execution.claim.workId,x.execution.claim.generation,f.service.workerId,JSON.stringify(f.requestPolicy.executionLimit)])).rows[0].decision);
 const op=operator(f);expect(await reserve()).toMatchObject({allowed:false,reason:'NATIVE_CAPACITY_TERMINATION_UNCONFIRMED'});
 const decision=await op.confirmWindows(x.key);expect((await x.ports.original.readOriginal(x.capture)).state).toBe('CONFIRMED');
 const context={binding:x.binding,attemptId:x.capture.origin.authority.attemptId,controllerInstanceId:f.controllerInstanceId,controllerId:f.profile.controllerId,ownerService:f.peer.serviceRole,peerId:f.peer.peerId};
 await expect(f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.windows_native_ready($1::jsonb,$2) decision',[JSON.stringify(context),canonicalize(x.script.prepared)])).rejects.toMatchObject({code:'NATIVE_CAPACITY_RESERVATION_UNCONFIRMED',nextAction:'WAIT'});await expect(x.ports.original.grantOriginal(x.capture)).rejects.toMatchObject({nextAction:'WAIT'});
 expect(await reserve()).toMatchObject({allowed:true});
 const recovery=await new NativeCapacityStore(f.worker,f.seed.accountId).recover();expect(recovery[0]).toMatchObject({rootKind:'EXECUTION',executionId:x.execution.input.executionId,terminationProofId:decision.proofId});
 expect((await f.admin.pool.query('SELECT mode,reservation_id FROM manga_web.native_capacity_adoptions')).rows).toEqual([{mode:'PROMOTE',reservation_id:x.binding.capacityReservationId}]);
 const next=await f.originalIntent(x.execution,'EXECUTION',x.execution.input.requestId,'POLYGON_MASK');expect(await next.reserve(x.capacity)).toMatchObject({allowed:true,reason:'CREATED'});
 expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_roots()')).rows).toEqual([{n:1}]);
}));

it('W4-A missing duplicate or altered real non-billing bridge rows stay WAIT without repair or rebilling',async()=>costFixture(async(f,x)=>{
 expect((await bridge(f,x.key)).state).toBe('VERIFIED');const rows=await bridgeRows(f);
 for(const mode of ['MISSING','DUPLICATE','ALTERED'] as const){
  const value=await corrupted(f,async client=>{
   if(mode==='MISSING')await client.query("DELETE FROM manga_web.execution_evidence WHERE kind='WINDOWS_NATIVE_TERMINATION'");
   if(mode==='ALTERED')await client.query("UPDATE manga_web.execution_evidence SET protected_observation=jsonb_set(protected_observation,'{value,accounting}', 'null') WHERE kind='WINDOWS_NATIVE_OPERATION'");
   if(mode==='DUPLICATE')await client.query("INSERT INTO manga_web.execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) SELECT account_id,$1,execution_id,kind,repeat('b',64),$1::uuid::text,received_at,protected_observation FROM manga_web.execution_evidence WHERE kind='WINDOWS_NATIVE_OPERATION'",[randomUUID()]);
  },async client=>{await client.query('SET LOCAL ROLE trio_web_worker');const tx=await f.worker.accountContext(client,f.seed.accountId,true);return journal(f).recordIn(tx,x.key);});
  expect(value,mode).toEqual(waiting);
 }
 expect(await bridgeRows(f)).toEqual(rows);
}));

it('W4-A large original BASIS and fractional source INPUT remain refs-only in bridge and proof metadata',async()=>originalFixture(async(f,x)=>{
 const bundle=await lookup(f,x.key),facts=validateWindowsNativeEvidenceBundle(bundle,x.key,'trio_web_worker');expect(x.execution.input.settings.baseFontSizePx).toBe(20.5);expect(Buffer.byteLength(JSON.stringify(x.basis))).toBeGreaterThan(96000);
 expect((await bridge(f,x.key)).state).toBe('VERIFIED');for(const row of await bridgeRows(f)){expect(Buffer.byteLength(JSON.stringify(row.protected_observation))).toBeLessThan(32768);expect(row.protected_observation.value.source.basisRef).toEqual({evidenceId:x.basis!.evidenceId,evidenceDigest:x.basis!.evidenceDigest});}
 const proof=await operator(f).confirmWindows(x.key);expect((await proofRows(f))[0].proof_metadata.accountingDigest).toBe(null);expect(facts.source.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);expect(proof.allowed).toBe(true);
},{basis:'LARGE'}));

it('W4-A signed null BASIS remains null after a later BASIS is recorded',async()=>originalFixture(async(f,x)=>{
 const before=await lookup(f,x.key);await f.seedBasis(x.execution.input);expect(await lookup(f,x.key)).toEqual(before);expect((await bridge(f,x.key)).state).toBe('VERIFIED');expect((await bridgeRows(f))[0].protected_observation.value.source.basisRef).toBeNull();
},{basis:'NONE'}));

it('W4-A capture-null BASIS created before original signing remains valid for bridge and confirmation',async()=>originalFixture(async(f,x)=>{
 expect(x.capture.origin.identity.basisRef).toBeNull();expect(x.basis).not.toBeNull();expect((await bridge(f,x.key)).state).toBe('VERIFIED');expect((await operator(f).confirmWindows(x.key)).allowed).toBe(true);
 expect((await bridgeRows(f))[0].protected_observation.value.source.basisRef).toEqual({evidenceId:x.basis!.evidenceId,evidenceDigest:x.basis!.evidenceDigest});
},{basis:'NONE',basisAfterCapture:true}));

it.each([131071,131072])('W4-A original SQL INPUT and BASIS value %i bytes survive larger snapshot wrappers',async bytes=>originalFixture(async(f,x)=>{
 const sizes=(await f.admin.pool.query(`SELECT octet_length((input_snapshot->'value')::text) input_value,octet_length(input_snapshot::text) input_wrapper,
 octet_length((basis_snapshot->'value')::text) basis_value,octet_length(basis_snapshot::text) basis_wrapper FROM manga_web.windows_native_origins`)).rows[0];
 expect(sizes.input_value).toBe(bytes);expect(sizes.basis_value).toBe(bytes);expect(sizes.input_wrapper).toBeGreaterThan(131072);expect(sizes.basis_wrapper).toBeGreaterThan(131072);
 expect(Buffer.byteLength(JSON.stringify(x.execution.input))).toBeLessThan(bytes);expect(Buffer.byteLength(JSON.stringify(x.basis!.value))).toBeLessThan(bytes);
 const definition=(await f.admin.pool.query("SELECT pg_get_functiondef('manga_web.windows_native_evidence_bundle(jsonb,text)'::regprocedure) definition")).rows[0].definition as string;
 let oldDefinition=definition;
 for(const field of ['input_snapshot','basis_snapshot']){const before=`octet_length((o.${field}->'value')::text)>131072`,after=`octet_length(o.${field}::text)>131072`;expect(oldDefinition.split(before)).toHaveLength(2);oldDefinition=oldDefinition.replace(before,after);}
 const red=await corrupted(f,client=>client.query(oldDefinition),async client=>{await client.query('SET LOCAL ROLE trio_web_worker');return journal(f).recordIn(await f.worker.accountContext(client,f.seed.accountId,true),x.key);});expect(red).toEqual(waiting);
 expect((await bridge(f,x.key)).state).toBe('VERIFIED');const op=operator(f),proof=await op.confirmWindows(x.key);expect(proof.allowed).toBe(true);expect((await op.releaseWindows(f.seed.accountId,x.binding.capacityReservationId,proof.proofId!)).allowed).toBe(true);
 console.info(JSON.stringify({w4aSqlValueBoundary:{...sizes,inputCompact:Buffer.byteLength(JSON.stringify(x.execution.input)),basisCompact:Buffer.byteLength(JSON.stringify(x.basis!.value))}}));
},{inputBytes:bytes,basisBytes:bytes}));

it.each(['INPUT','BASIS'] as const)('W4-A original SQL %s value 131073 bytes is refused before capture or bridge',async kind=>{
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined;try{
  f=await windowsNativeFixture(20.5);await expect(createWindowsNativeCostOriginalFixture(f,kind==='INPUT'?{inputBytes:131073}:{basisBytes:131073})).rejects.toMatchObject(kind==='INPUT'?{nextAction:'WAIT'}:{code:'23514',message:'WINDOWS_NATIVE_BASIS_UNCONFIRMED'});
  expect(await bridgeRows(f)).toEqual([]);expect(await proofRows(f)).toEqual([]);expect(f.objectIo).toEqual({get:0,put:0});
 }finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});

it('W4-A actual installed SQL bundle record link and event limit expressions enforce minus equal plus one',async()=>costFixture(async(f,x)=>{
 const installed=(await f.admin.pool.query("SELECT prosrc,pg_get_functiondef(oid) definition FROM pg_catalog.pg_proc WHERE oid='manga_web.windows_native_evidence_bundle(jsonb,text)'::regprocedure")).rows[0],source=installed.prosrc as string;
 const migration=await readFile(new URL('../../db/migrations/0022_windows_native_cost.sql',import.meta.url),'utf8'),migrationDigest=sha256(migration);
 expect((await f.admin.pool.query("SELECT sha256 FROM trio_migrations.applied WHERE name='0022_windows_native_cost.sql'")).rows).toEqual([{sha256:migrationDigest}]);
 const migrationBodies=[...migration.matchAll(/CREATE FUNCTION windows_native_evidence_bundle\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)];expect(migrationBodies).toHaveLength(1);expect(migrationBodies[0][1]).toBe(source);
 const skeleton=windowsNativeCostBoundSkeleton();expect((await f.admin.pool.query('SELECT octet_length($1::jsonb::text) bytes',[JSON.stringify(skeleton)])).rows).toEqual([{bytes:7072}]);
 console.info(JSON.stringify({w4aInstalledDefinition:{migrationSha256:migrationDigest,prosrcSha256:sha256(source),definitionSha256:sha256(installed.definition),migrationBodyMatches:1,skeletonSqlBytes:7072}}));
 const specifications=[
  {name:'BUNDLE',pattern:/octet_length\(bundle::text\)<=1572864/,limit:1572864,column:'bundle',json:true,accepted:true},
  {name:'RECORD',pattern:/octet_length\(canonical\)>65536/,limit:65536,column:'canonical',json:false,accepted:false},
  {name:'LINK',pattern:/octet_length\(l\.canonical\)>32768/,limit:32768,column:'canonical',json:false,accepted:false},
 ];
 for(const specimen of specifications){const matches=[...source.matchAll(new RegExp(specimen.pattern.source,'g'))];expect(matches,specimen.name).toHaveLength(1);const expression=matches[0][0];
  console.info(JSON.stringify({w4aInstalledLimit:{definitionSha256:sha256(source),name:specimen.name,expression,parameterType:specimen.json?'jsonb':'text',bound:specimen.limit,exactMatches:matches.length}}));
  for(const delta of [-1,0,1]){let input:unknown='x'.repeat(specimen.limit+delta);
   if(specimen.json){const overhead=(await f.admin.pool.query("SELECT octet_length(jsonb_build_object('padding','')::text) bytes")).rows[0].bytes as number;input=JSON.stringify({padding:'x'.repeat(specimen.limit+delta-overhead)});}
   const result=(await f.admin.pool.query(`SELECT ${expression} AS result FROM(SELECT $1::${specimen.json?'jsonb':'text'} ${specimen.column}) l`,[input])).rows[0].result;
   expect(result,`${specimen.name}:${delta}`).toBe(delta<=0?specimen.accepted:!specimen.accepted);
  }
 }
 const eventMatches=[...source.matchAll(/\(SELECT count\(\*\) FROM manga_web\.windows_native_events WHERE account_id=r\.account_id AND attempt_id=a\.attempt_id\)>64/g)];expect(eventMatches).toHaveLength(1);const eventExpression=eventMatches[0][0];
 console.info(JSON.stringify({w4aInstalledLimit:{definitionSha256:sha256(source),name:'EVENTS',expression:eventExpression,parameterTypes:['uuid','uuid','integer'],bound:64,exactMatches:eventMatches.length}}));
 for(const count of [63,64,65]){const result=(await f.admin.pool.query(`WITH boundary_events AS(SELECT $1::uuid account_id,$2::uuid attempt_id FROM generate_series(1,$3::integer)) SELECT ${eventExpression!.replace('manga_web.windows_native_events','boundary_events')} AS result FROM(SELECT $1::uuid account_id) r CROSS JOIN(SELECT $2::uuid attempt_id) a`,[f.seed.accountId,randomUUID(),count])).rows[0].result;expect(result).toBe(count>64);}
 // Execute the installed RETURN/guard blocks themselves. Large boundary
 // containers are size probes, not assertions of valid original link grammar.
 const extract=(pattern:RegExp)=>{const matches=[...source.matchAll(pattern)];expect(matches).toHaveLength(1);return matches[0][0];};
 const bundleReturn=extract(/RETURN CASE WHEN octet_length\(bundle::text\)<=1572864 THEN bundle ELSE NULL END;/g);
 const recordGuard=extract(/IF octet_length\(a\.input_canonical\)>131072[\s\S]*?THEN RETURN NULL;END IF;/g);
 const linkGuard=extract(/IF s\.record_id IS NULL OR j\.record_id IS NULL[\s\S]*?THEN RETURN NULL;END IF;/g);
 for(const [name,block,parameterTypes] of [['BUNDLE',bundleReturn,['jsonb']],['RECORD',recordGuard,['jsonb','jsonb','text']],['LINK',linkGuard,['jsonb','jsonb','text']]] as const)
  console.info(JSON.stringify({w4aInstalledReturn:{migrationSha256:migrationDigest,prosrcSha256:sha256(source),definitionSha256:sha256(installed.definition),name,block,parameterTypes,exactMatches:1}}));
 const normal=await lookup(f,x.key);expect(normal).toMatchObject({state:{allowed:true}});const probe=await f.admin.pool.connect();
 try{await probe.query('BEGIN');await probe.query(`CREATE FUNCTION pg_temp.w4a_bundle_return(bundle jsonb) RETURNS jsonb LANGUAGE plpgsql AS $w4a$ BEGIN ${bundleReturn} END $w4a$`);
  const overhead=(await probe.query("SELECT octet_length(jsonb_build_object('padding','')::text) bytes")).rows[0].bytes as number;
  for(const delta of [-1,0,1]){const input={padding:'x'.repeat(1572864+delta-overhead)},result=(await probe.query('SELECT octet_length($1::jsonb::text) bytes,pg_temp.w4a_bundle_return($1::jsonb) value',[JSON.stringify(input)])).rows[0];
   expect(result.bytes).toBe(1572864+delta);expect(result.value,`BUNDLE RETURN:${delta}`).toEqual(delta<=0?input:null);
   console.info(JSON.stringify({w4aInstalledReturnResult:{name:'BUNDLE',delta,sqlBytes:result.bytes,originalReturned:delta<=0,nullReturned:result.value===null}}));
  }
 }finally{try{await probe.query('ROLLBACK');}finally{probe.release();}}
 const declarations=`DECLARE r manga_web.native_capacity_reservations%ROWTYPE;a manga_web.native_controller_attempts%ROWTYPE;o manga_web.windows_native_origins%ROWTYPE;p manga_web.native_capacity_profiles%ROWTYPE;s manga_web.windows_native_records%ROWTYPE;j manga_web.windows_native_records%ROWTYPE;z manga_web.windows_native_records%ROWTYPE;l manga_web.windows_native_links%ROWTYPE;expected jsonb:=p_key->'expected';`;
 const load=`SELECT * INTO r FROM manga_web.native_capacity_reservations WHERE account_id=(p_key->'binding'->>'accountId')::uuid AND reservation_id=(p_key->'binding'->>'capacityReservationId')::uuid;
 SELECT * INTO a FROM manga_web.native_controller_attempts WHERE account_id=r.account_id AND reservation_id=r.reservation_id;
 SELECT * INTO o FROM manga_web.windows_native_origins WHERE account_id=r.account_id AND attempt_id=a.attempt_id;
 SELECT * INTO p FROM manga_web.native_capacity_profiles WHERE profile_id=r.profile_id;
 SELECT * INTO s FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='SEAL';
 SELECT * INTO j FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='PARENT_JOIN';
 SELECT * INTO z FROM manga_web.windows_native_records WHERE account_id=r.account_id AND attempt_id=a.attempt_id AND purpose='FINALIZED';
 SELECT * INTO l FROM manga_web.windows_native_links WHERE account_id=r.account_id AND attempt_id=a.attempt_id;`;
 for(const [name,block,limit] of [['RECORD',recordGuard,65536],['LINK',linkGuard,32768]] as const)for(const delta of [-1,0,1]){
  const result=await corrupted(f,async client=>{await client.query(`CREATE FUNCTION pg_temp.w4a_guard_return(p_key jsonb,p_good jsonb,p_bytes text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,manga_web,pg_temp SET timezone='UTC' AS $w4a$ ${declarations} BEGIN ${load} ${name==='LINK'?'l.canonical:=p_bytes;':''} ${block} RETURN p_good; END $w4a$`);
   if(name==='RECORD')await client.query("UPDATE manga_web.windows_native_records SET canonical=$2 WHERE account_id=$1 AND purpose='SEAL'",[f.seed.accountId,'x'.repeat(limit+delta)]);
  },async client=>(await client.query('SELECT pg_temp.w4a_guard_return($1::jsonb,$2::jsonb,$3::text) value',[JSON.stringify(x.key),JSON.stringify(normal),'x'.repeat(limit+delta)])).rows[0].value);
  expect(result,`${name} RETURN:${delta}`).toEqual(delta<=0?normal:null);
  console.info(JSON.stringify({w4aInstalledReturnResult:{name,delta,sqlBytes:limit+delta,originalReturned:delta<=0,nullReturned:result===null}}));
 }
 // These evaluate the installed expressions on deliberately synthetic large
 // containers. Closed link/event grammar is independently enforced below and
 // does not permit a valid 32-KiB link or 64 distinct event kinds.
 const proof=await operator(f).confirmWindows(x.key),row=(await proofRows(f))[0];
 expect((await f.operator.client.query('SELECT manga_web.native_capacity_confirm_windows_proof($1::jsonb,$2::jsonb,$3,$4) decision',[JSON.stringify(x.key),JSON.stringify(row.proof_metadata),'x'.repeat(32769),row.link_signature])).rows[0].decision.allowed).toBe(false);
 expect((await proofRows(f))[0].proof_id).toBe(proof.proofId);
}));

// Closed-grammar width skeleton used by the A06 component bound calculation.
// Null payloads are deliberate placeholders; this is not a valid native proof.
function windowsNativeCostBoundSkeleton(){
 const id='11111111-1111-4111-8111-111111111111',hash='f'.repeat(64),version='x'.repeat(128),ref={evidenceId:id,evidenceDigest:hash},windowsRef={recordId:id,recordDigest:hash,linkId:id,linkDigest:hash};
 const observation=()=>({...ref,value:{version:2,parentInstanceId:id,event:'TERMINATION',code:'OK',resultDigest:hash,termination:{jobId:id,inputDigest:hash,profileDigest:hash,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'WINDOWS_JOB_EMPTY',isolation:'WINDOWS_JOB_OBJECT'},windowsRecordRef:{recordId:id,recordDigest:hash}}});
 return {state:{allowed:false,view:{capture:{origin:null,originDigest:hash,frameInputDigest:hash,launchRef:id},record:{ref:{recordId:id,digest:hash},envelope:null},windowsEvidenceRef:windowsRef},facts:{capacity:{reference:{kind:'WINDOWS_JOB_OBJECT',profileId:id,profileDigest:hash,profileVersion:version},profile:null,sourceInput:{executionId:id,inputEvidenceId:id,stageInputDigest:hash}},input:{...ref,value:null},basis:{...ref,value:null},goGrantRef:{jobId:id,rowDigest:hash},rawResult:{rawResultId:id,resultDigest:hash},observations:[observation(),observation()],records:['READY','PARENT_JOIN','SEAL','FINALIZED'].map(purpose=>({purpose,recordId:id,digest:hash,value:null})),link:{linkId:id,canonical:null,digest:hash,signature:'A'.repeat(88)},peer:{serviceRole:'trio_web_worker',peerId:id}}},observationDigests:[hash,hash],original:{reservationId:id,adoptionId:id,sourceExecutionId:id,sourceInputEvidenceId:id,ownerService:'trio_web_worker',profileId:id,profileDigest:hash,profileVersion:version,protectedIntent:{version:1,jobId:id,task:'SYNTHETIC_CLEANUP',taskVersion:'native-pure-v1',profileDigest:hash,inputDigest:hash,operationInputDigest:hash,parentInstanceId:id,targetKind:'REQUEST_CHECKPOINT',targetId:id,semanticCaptureDigest:hash,logicalOperationKey:hash,protectedOwnerCapture:{contextId:id,contextGeneration:'9'.repeat(19),ownerSessionId:id,ownerTabId:id,ownerRevision:'9'.repeat(19),workspaceRevision:'9'.repeat(19)},claim:{generation:'9'.repeat(19),ownerId:id,workItemId:id}},intentDigest:hash,actualIntentDigest:hash},job:null};
}

it('W4-A 0022 migrates an existing RELEASED v1 proof without changing old FK OID owner ACL search_path or roles',async()=>{
 const guard=guardWindowsNativeIo(),connectionString=process.env.TRIO_TEST_DATABASE_URL;expect(connectionString).toMatch(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/postgres$/);
 const root=new pg.Client({connectionString});await root.connect();let db:Database|undefined;
 try{
  const name='trio_w4a_old_'+randomUUID().replaceAll('-','');await root.query(`CREATE DATABASE "${name}"`);const url=new URL(connectionString!);url.pathname='/'+name;db=new Database(url.toString());
  const directory=new URL('../../db/migrations/',import.meta.url),names=(await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)&&name<'0022').sort();expect(names).toHaveLength(21);
  await db.transaction(async client=>{await client.query('CREATE SCHEMA trio_migrations; CREATE TABLE trio_migrations.applied(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');for(const name of names){const sql=await readFile(new URL(name,directory),'utf8');await client.query(sql);await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2)',[name,sha256(sql)]);}});
  const key=generateKeyPairSync('ed25519'),profileId=randomUUID(),profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'w4a-existing-owned-v1',maxSlots:1,nativeProfileDigest:sha256('w4a-existing-native'),kernelDigest:sha256('w4a-existing-kernel'),controllerId:randomUUID(),keyVersion:'w4a-existing-key',environmentDigest:sha256('w4a-existing-environment'),publicKeySpki:key.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['owned-fixture:w4a/migration']};
  const now=(await db.pool.query('SELECT clock_timestamp() now')).rows[0].now as Date,seed=await seedIdentity(db,now);
  const pd=(await db.pool.query(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0].profile_digest as string;
  const body={version:1 as const,jobId:randomUUID(),parentInstanceId:randomUUID(),task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1' as const,profileDigest:profile.nativeProfileDigest,inputDigest:sha256('w4a-existing-input'),operationInputDigest:sha256('w4a-existing-operation'),targetKind:'UPLOAD' as const,targetId:randomUUID(),semanticCaptureDigest:sha256('w4a-existing-capture'),protectedOwnerCapture:{contextId:null,contextGeneration:null,ownerSessionId:null,ownerTabId:null,ownerRevision:null,workspaceRevision:null},claim:{generation:'0',ownerId:randomUUID(),workItemId:null}},intent:NativeJobIntent={...body,logicalOperationKey:nativeLogicalOperationKey(body)};
  await db.pool.query(`INSERT INTO manga_web.native_job_intents(account_id,job_id,owner_service,parent_instance_id,task,task_version,profile_digest,input_digest,operation_input_digest,target_kind,target_id,semantic_capture_digest,logical_operation_key,protected_intent,intent_digest,created_at) VALUES($1,$2,'trio_web_worker',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,encode(sha256(convert_to($13::jsonb::text,'UTF8')),'hex'),clock_timestamp())`,[seed.accountId,intent.jobId,intent.parentInstanceId,intent.task,intent.taskVersion,intent.profileDigest,intent.inputDigest,intent.operationInputDigest,intent.targetKind,intent.targetId,intent.semanticCaptureDigest,intent.logicalOperationKey,JSON.stringify(intent)]);
  const reservationId=randomUUID(),adoptionId=randomUUID(),observationId=randomUUID();await db.pool.query(`INSERT INTO manga_web.native_capacity_reservations(account_id,reservation_id,job_id,adoption_id,owner_service,profile_id,profile_digest,profile_version,root_kind,reserved_at,state) VALUES($1,$2,$3,$4,'trio_web_worker',$5,$6,$7,'STANDALONE',clock_timestamp(),'HELD')`,[seed.accountId,reservationId,intent.jobId,adoptionId,profileId,pd,profile.version]);
  const termination={jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:true,kind:'NO_CHILD_CREATED',isolation:'OWNED_FIXTURE'},observation={version:1,parentInstanceId:intent.parentInstanceId,event:'TERMINATION',code:'OK',resultDigest:null,termination};
  const observationDigest=(await db.pool.query(`INSERT INTO manga_web.native_job_observations(account_id,observation_id,job_id,parent_instance_id,event,observation_digest,protected_observation,received_at) VALUES($1,$2,$3,$4,'TERMINATION',encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),$5,clock_timestamp()) RETURNING observation_digest`,[seed.accountId,observationId,intent.jobId,intent.parentInstanceId,JSON.stringify(observation)])).rows[0].observation_digest as string;
  const proof:NativeCapacityProof={version:1,kind:'OWNED_FIXTURE',accountId:seed.accountId,capacityReservationId:reservationId,adoptionId,jobId:intent.jobId,inputDigest:intent.inputDigest,nativeProfileDigest:intent.profileDigest,parentInstanceId:intent.parentInstanceId,controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,terminationObservationId:observationId,terminationObservationDigest:observationDigest,goAttempted:false,startedComputation:false,operationJoined:true,directChildClosed:false,subtreeTerminationConfirmed:false,terminationKind:'NO_CHILD_CREATED'};
  const canonical=(await import('canonicalize')).default(proof)!;
  const confirmed=await db.transaction(async client=>{await client.query('SET LOCAL ROLE trio_web_operator');return (await client.query('SELECT manga_web.native_capacity_confirm_proof($1,$2) decision',[canonical,sign(null,Buffer.from(canonical),key.privateKey).toString('base64')])).rows[0].decision;});expect(confirmed.allowed).toBe(true);
  const released=await db.transaction(async client=>{await client.query('SET LOCAL ROLE trio_web_operator');return (await client.query('SELECT manga_web.native_capacity_release($1,$2,$3) decision',[seed.accountId,reservationId,confirmed.proofId])).rows[0].decision;});expect(released.allowed).toBe(true);
  const functions=`SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,p.proowner,p.proacl,p.proconfig,p.prosecdef FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid`;
  const before=(await db.pool.query('SELECT to_jsonb(r) value FROM manga_web.native_capacity_reservations r')).rows[0].value,proofBefore=(await db.pool.query('SELECT * FROM manga_web.native_capacity_termination_proofs')).rows,functionsBefore=(await db.pool.query(functions)).rows;
  const roles=(await db.pool.query("SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname LIKE 'trio_web_%' ORDER BY oid")).rows;
  const foreignBefore=(await db.pool.query("SELECT oid,conname,confrelid,conkey,confkey FROM pg_catalog.pg_constraint WHERE conrelid='manga_web.native_capacity_reservations'::regclass AND contype='f' ORDER BY oid")).rows;
  // Keep the original W4-A 0022-only acceptance assertions below at their
  // original boundary; the normal runner subsequently applies exactly 0023.
  const sql0022=await readFile(new URL('0022_windows_native_cost.sql',directory),'utf8');
  await db.transaction(async client=>{await client.query(sql0022);expect((await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2) RETURNING name',['0022_windows_native_cost.sql',sha256(sql0022)])).rows).toEqual([{name:'0022_windows_native_cost.sql'}]);});
  const after=(await db.pool.query("SELECT to_jsonb(r)-'windows_release_proof_id' value FROM manga_web.native_capacity_reservations r")).rows[0].value;expect(after).toEqual(before);expect(after.state).toBe('RELEASED');expect(after.release_proof_id).toBe(confirmed.proofId);expect(await db.pool.query('SELECT * FROM manga_web.native_capacity_termination_proofs').then(x=>x.rows)).toEqual(proofBefore);
  const functionsAfter=(await db.pool.query(functions)).rows;for(const item of functionsBefore)expect(functionsAfter.find(next=>next.oid===item.oid)).toEqual(item);
  expect((await db.pool.query("SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname LIKE 'trio_web_%' ORDER BY oid")).rows).toEqual(roles);
  const foreignAfter=(await db.pool.query("SELECT oid,conname,confrelid,conkey,confkey FROM pg_catalog.pg_constraint WHERE conrelid='manga_web.native_capacity_reservations'::regclass AND contype='f' ORDER BY oid")).rows;for(const item of foreignBefore)expect(foreignAfter).toContainEqual(item);
  expect((await db.pool.query('SELECT manga_web.native_capacity_registered_proof($1,$2) proof',[seed.accountId,reservationId])).rows).toEqual([{proof:confirmed.proofId}]);expect((await db.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_roots()')).rows).toEqual([{n:0}]);
  const definitions=`SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosrc,p.provolatile,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='manga_web' ORDER BY p.oid`;
  const definitions0022=(await db.pool.query(definitions)).rows,metadata0022=(await db.pool.query(functions)).rows;
  expect(await migrate(db.pool)).toEqual(['0023_windows_native_cost_owner.sql']);expect(await migrate(db.pool)).toEqual([]);
  const wrappers=[
   'native_job_create_intent(jsonb)','native_receipt_create_intent(jsonb)','native_capacity_create_intent(jsonb,boolean,jsonb)','native_capacity_base_intent(jsonb,boolean)','native_capacity_base_create_intent_v13(jsonb)',
   'native_job_consume_go(uuid,uuid,jsonb,jsonb)','native_job_go_current_owned(uuid,uuid,jsonb,jsonb,text)','native_job_go_owned(uuid,uuid,jsonb,jsonb,text)','native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text)','native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text,uuid,uuid)','native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text)',
   'windows_native_offer(jsonb)','windows_native_capture(jsonb,text,text)','windows_native_scope(jsonb)','windows_native_current(jsonb)','windows_native_ready(jsonb,text)','windows_native_grant_go(jsonb)',
   'native_controller_original(jsonb,uuid,text)','native_controller_claim(jsonb,text,uuid,uuid,uuid,text,uuid)','native_controller_ready(jsonb,uuid,uuid,uuid,text,uuid)','native_controller_grant_go(jsonb,uuid,uuid,uuid,text)','native_controller_allocate_raw(jsonb,uuid,uuid,uuid,text,uuid,text,jsonb,text)','native_controller_register_raw_object(jsonb,uuid,text,uuid,text,jsonb,text)','native_controller_raw_lookup(jsonb,uuid,text,text)',
   'native_receipt_lookup(jsonb)','native_receipt_prepare(jsonb,jsonb)','native_receipt_register_asset(uuid,text,jsonb,text,jsonb)','native_receipt_verify(uuid,jsonb,jsonb)','reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb)'];
  const wrapperOids=(await db.pool.query("SELECT to_regprocedure('manga_web.'||signature)::oid oid FROM unnest($1::text[]) signature",[wrappers])).rows.map(row=>row.oid).sort((a,b)=>a-b);
  expect(new Set(wrapperOids).size).toBe(wrappers.length);
  const definitions0023=(await db.pool.query(definitions)).rows,metadata0023=(await db.pool.query(functions)).rows;
  expect(definitions0022.filter(old=>definitions0023.find(next=>next.oid===old.oid)?.prosrc!==old.prosrc).map(row=>row.oid).sort((a,b)=>a-b)).toEqual(wrapperOids);
  for(const old of metadata0022)expect(metadata0023.find(next=>next.oid===old.oid)).toEqual(old);
  for(const old of definitions0022){
   const next=definitions0023.find(next=>next.oid===old.oid)!;expect(next).toBeDefined();
   if(!wrapperOids.includes(old.oid)){expect(next).toEqual(old);continue;}
   if(old.lanname==='sql'){
    expect(next.lanname).toBe('plpgsql');expect(['native_receipt_lookup','native_receipt_prepare','native_receipt_register_asset','native_receipt_verify']).toContain(old.proname);
    const core=definitions0023.find(row=>row.proname==='windows_native_cost_'+old.proname+'_core'&&row.args===old.args);expect(core?.prosrc).toBe(old.prosrc);expect(next.prosrc).toContain('RETURN manga_web.windows_native_cost_'+old.proname+'_core(');
   }else{
    const first=old.prosrc.indexOf('BEGIN');expect(first).toBeGreaterThanOrEqual(0);expect(next.prosrc.startsWith(old.prosrc.slice(0,first)+'BEGIN\n')).toBe(true);expect(next.prosrc.endsWith(old.prosrc.slice(first+5))).toBe(true);
    const prefix=next.prosrc.slice(first+6,next.prosrc.length-old.prosrc.slice(first+5).length);expect(prefix).toContain('windows_native_cost_');expect(prefix).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/);
   }
  }
  expect((await db.pool.query("SELECT to_jsonb(r)-'windows_release_proof_id' value FROM manga_web.native_capacity_reservations r")).rows[0].value).toEqual(before);
  expect((await db.pool.query('SELECT * FROM manga_web.native_capacity_termination_proofs')).rows).toEqual(proofBefore);
  expect((await db.pool.query("SELECT oid,rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname LIKE 'trio_web_%' ORDER BY oid")).rows).toEqual(roles);
  expect((await db.pool.query("SELECT oid,conname,confrelid,conkey,confkey FROM pg_catalog.pg_constraint WHERE conrelid='manga_web.native_capacity_reservations'::regclass AND contype='f' ORDER BY oid")).rows).toEqual(foreignAfter);
  expect((await db.pool.query('SELECT manga_web.native_capacity_registered_proof($1,$2) proof',[seed.accountId,reservationId])).rows).toEqual([{proof:confirmed.proofId}]);expect((await db.pool.query('SELECT count(*)::integer n FROM manga_web.native_capacity_roots()')).rows).toEqual([{n:0}]);
  console.info(JSON.stringify({w4b1Migration:{separate0022:true,normal0023:true,unchangedOriginalMetadata:metadata0022.length,exactWrapperChanges:wrappers.length,originalProofAndFkPreserved:true}}));
 }finally{try{await db?.close();await root.end();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});

// W4-B1 DB-only parent boundary: the operational authorizer is connected in B3.
it('W4-B1 source-preserving REQUEST_CHECKPOINT fresh enrollment has a real consumer INPUT BASIS and attempt',async()=>{
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined;
 try{
  f=await windowsNativeFixture(20.5);const source=await f.checkpointRetry(),sourceBasis=await f.seedBasis(source.input);
  const sourceBefore=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE execution_id=$1 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[source.input.executionId])).rows;
  expect(await f.service.validateCheckpoints(source.claim)).toBe(true);
  const transaction=f.worker.transaction.bind(f.worker);let enrolled:unknown=null;
  const cap=(await f.admin.pool.query("SELECT to_regprocedure('manga_web.windows_native_cost_enroll_input(jsonb)')::text AS capability")).rows[0].capability;
  const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{
   const result=await run(client);
   const inputs=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE kind='INPUT' AND xmin::text=pg_current_xact_id()::text")).rows;
   if(inputs.length&&cap){expect(inputs).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) AS value',[JSON.stringify({evidenceId:inputs[0].evidence_id,evidenceDigest:inputs[0].evidence_digest})])).rows[0].value;}
   return result;
  }));
  let consumer;try{consumer=await f.service.authorize(source.claim);}finally{spy.mockRestore();}
  expect(consumer).not.toBeNull();expect(consumer!.executionId).not.toBe(source.input.executionId);expect(consumer!.requestId).toBe(source.retryId);
  const consumerBasis=await w4bBasis(f,consumer!);
  await f.admin.pool.query("UPDATE manga_web.assets SET object_key=account_id::text||'/'||asset_id::text,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId]);
  const {CheckpointValidationJournal}=await import('../../packages/domain/src/checkpoint-validation.js');
  const validation=new CheckpointValidationJournal(f.worker,{maxRecordBytes:262144,maxRecords:64,maxTargets:64,maxJobs:64});
  const attempt=await f.worker.accountTransaction(f.seed.accountId,tx=>validation.beginIn(tx,consumer!,'PRE_DISPATCH'));
  expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0]).toMatchObject({sourceExecutionId:source.input.executionId,inputFingerprint:sourceBefore.find(r=>r.protected_observation.executionId===source.input.executionId&&r.protected_observation.kind===undefined)!.evidence_digest,basis:{evidenceId:sourceBasis.evidenceId,evidenceDigest:sourceBasis.evidenceDigest}});
  expect(attempt.consumerExecutionId).toBe(consumer!.executionId);expect(attempt.basisEvidenceId).toBe(consumerBasis.evidenceId);
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE execution_id=$1 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[source.input.executionId])).rows).toEqual(sourceBefore);
  // The first RED is a capability assertion after all actual parent facts passed.
  expect(cap,'W4B1_COST_OWNER_ENROLLMENT_CAPABILITY_MISSING').not.toBeNull();expect(enrolled).not.toBeNull();
  const original=await f.originalIntent(source,'REQUEST_CHECKPOINT',source.retryId),owner={executionId:consumer!.executionId,inputEvidenceId:attempt.inputEvidenceId,inputFingerprint:attempt.inputFingerprint,basisRef:{evidenceId:consumerBasis.evidenceId,evidenceDigest:consumerBasis.evidenceDigest},claim:{generation:source.claim.generation,ownerId:f.service.workerId,workItemId:source.claim.workId},validationAttemptRef:(await f.admin.pool.query("SELECT evidence_id AS \"evidenceId\",evidence_digest AS \"evidenceDigest\" FROM manga_web.execution_evidence WHERE execution_id=$1 AND kind='CHECKPOINT_VALIDATION_ATTEMPT'",[consumer!.executionId])).rows[0]};
  const costs=journal(f),components=[{task:'DECODE_IMAGE' as const,componentId:'native-image'}];expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components))).not.toBeNull();
  const {nativeExecutionCaptureDigest}=await import('../../packages/domain/src/native-execution-wait.js'),output=(await f.admin.pool.query('SELECT output_envelope FROM manga_web.checkpoints WHERE execution_id=$1',[source.input.executionId])).rows[0].output_envelope;
  const target={accountId:f.seed.accountId,targetKind:'REQUEST_CHECKPOINT' as const,targetId:source.retryId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',source.retryId,source.input,output),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:owner.claim,sourceInput:original.sourceInput};
  const scope=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginScopeIn(tx,owner,target,'CHECKPOINT',digest(attempt.targets[0]),randomUUID()));expect(scope).not.toBeNull();
  const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:original.intent.task,taskVersion:original.intent.taskVersion,profileDigest:original.intent.profileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:original.intent.operationInputDigest,componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.registerCallIn(tx,scope!,call))).toEqual(call);
  const capacity={...await f.registerWindowsProfile(),sourceInput:original.sourceInput},intentBody={...original.intent,semanticCaptureDigest:target.semanticCaptureDigest},intent={...intentBody,logicalOperationKey:nativeLogicalOperationKey(intentBody)};
  expect(await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.native_capacity_create_intent($1::jsonb,true,$2::jsonb) AS value',[JSON.stringify(intent),JSON.stringify(capacity)])).rows[0].value)).toMatchObject({allowed:false,reason:'WINDOWS_NATIVE_COST_SCOPE_REQUIRED'});
  const admitted=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.admitIn(tx,scope!,call,intent,capacity,'native-image'));expect(admitted).toMatchObject({allowed:true,reason:'CREATED'});
  const mapping=(await f.admin.pool.query('SELECT r.source_execution_id,r.source_input_evidence_id,b.execution_id,b.call_id,r.reservation_id FROM manga_web.native_capacity_reservations r JOIN manga_web.windows_native_cost_bindings b USING(account_id,job_id) WHERE b.job_id=$1',[intent.jobId])).rows;
  expect(mapping).toEqual([{source_execution_id:source.input.executionId,source_input_evidence_id:original.sourceInput.inputEvidenceId,execution_id:consumer!.executionId,call_id:call.callId,reservation_id:admitted!.capacityReservationId}]);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.admitIn(tx,scope!,call,intent,capacity,'native-image'))).toMatchObject({allowed:true,capacityReservationId:admitted!.capacityReservationId});
  expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:0}]);
  const finished=await w4bFinishNative(f,costs,{binding:original.binding(admitted!.capacityReservationId!),call,frame:original.frame},await w4bOpenNative(f,{binding:original.binding(admitted!.capacityReservationId!),call,frame:original.frame},{reference:capacity.reference,profile:capacity.profile},'CREATED'));
  const originalBridge=finished.bridge;expect(originalBridge.state).toBe('VERIFIED');
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions WHERE job_id=$1',[intent.jobId])).rows).toEqual([{n:1}]);
  expect(finished.open.script.evidence().final.outcome).toBe('JOB_EMPTY');expect(finished.open.script.evidence().final.accounting).not.toBeNull();
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_io_starts WHERE call_id=$1',[call.callId])).rows).toEqual([{n:2}]);
  const ending={version:1 as const,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'THREW' as const,terminalEvidence:[originalBridge.operation!,originalBridge.termination!]};
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,{...ending,terminalEvidence:[{evidenceId:sourceBefore[0].evidence_id,evidenceDigest:sourceBefore[0].evidence_digest}]}),true)).toBe('WAIT');
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,ending),true)).toBe('JOINED');
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,ending),true)).toBe('JOINED');
  expect((await f.admin.pool.query("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE execution_id=$1 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[source.input.executionId])).rows).toEqual(sourceBefore);
 }finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});

import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import {prepareWindowsCostedTarget,createWindowsCostedObjectIo} from '../fixtures/windows-native.js';
import type {WindowsNativeCostCall,WindowsNativeCostScope} from '../../packages/domain/src/windows-native-cost.js';
async function w4bBasis(f:WindowsNativeFixture,input:StageInput){
 const profileDigest=sha256('W4B1 synthetic original basis'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:input.stage as 'OCR'|'TRANSLATE',profileDigest,basisVersion:'w4b1-db-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['fixture:basis'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'fixture-rate-v1',usdPerUnit:'0.01',evidenceRefs:['fixture:unit']}]};
 const mode=(await f.admin.pool.query('SELECT mode FROM manga_web.processing_requests WHERE request_id=$1',[input.requestId])).rows[0].mode,calculation=new FullStageCostCalculator(snapshot,{maxInputBytes:131072,maxOutputBytes:131072,maxComponents:64,maxEvidenceRefs:128,maxStringBytes:4096}).calculate({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage as 'OCR'|'TRANSLATE',profileDigest,mode},{provider:null,quantities:null,allocation:null});
 const value={version:1,accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:calculation.snapshot,snapshotDigest:calculation.snapshotDigest}},ref={evidenceId:randomUUID(),evidenceDigest:digest(value)};
 await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,ref.evidenceId,input.executionId,ref.evidenceDigest,tx.now,JSON.stringify(value)]));return {...ref,value};
}
async function w4bFixture(run:(f:WindowsNativeFixture,x:Awaited<ReturnType<typeof prepareWindowsCostedTarget>>,scope:WindowsNativeCostScope)=>Promise<void>){
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined;try{f=await windowsNativeFixture(20.5);const x=await prepareWindowsCostedTarget(f),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()));expect(scope).not.toBeNull();await run(f,x,scope!);}finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
}
function w4bCall(f:WindowsNativeFixture,scope:WindowsNativeCostScope,index=0):WindowsNativeCostCall{const body={version:1 as const,callId:randomUUID(),scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1',profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('w4b1-call-'+index),componentId:'native-image'};return {...body,callDigest:digest(body)};}
async function w4bSql(f:WindowsNativeFixture,name:string,values:unknown[]){return f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query(`SELECT manga_web.${name}(${values.map((_,i)=>'$'+(i+1)+'::jsonb').join(',')}) AS value`,values.map(x=>JSON.stringify(x)))).rows[0].value,true);}
it('W4-B1 immutable root scope call replay current/history fences and no late INPUT opt-in',async()=>w4bFixture(async(f,x,scope)=>{
 const lookup=()=>f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_native_cost_lookup($1::jsonb,64) AS value',[JSON.stringify(x.owner)])).rows[0].value,true);
 expect(await lookup()).toEqual({scopes:[scope]});expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupScopeIn(tx,scope.scopeId))).toEqual(scope);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.lookupScopeIn(tx,randomUUID()))).toBeNull();expect(await w4bSql(f,'windows_native_cost_enroll_input',[{evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint}])).not.toBeNull();
 const call=w4bCall(f,scope);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call))).toEqual(call);
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call))).toEqual(call);
 const body={...call,operationInputDigest:sha256('different')};const {callDigest:_digest,...without}=body;
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,{...without,callDigest:digest(without)}))).toBeNull();
 await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1",[f.seed.accountId]);
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,w4bCall(f,scope,2)),true)).toBeNull();expect(await lookup()).toEqual({scopes:[scope]});
 const end={version:1 as const,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:'THREW' as const,terminalEvidence:[]};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,end),true)).toBe('JOINED');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,end),true)).toBe('JOINED');
 const first=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_scope_ends')).rows;expect(first).toHaveLength(1);expect(await lookup()).toEqual({scopes:[scope]});
}));
it('W4-B1 real fake object IO preserves START END thrown reads ACK replay and denies work after JOINED',async()=>w4bFixture(async(f,x,scope)=>{
 const call=w4bCall(f,scope);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call))).toEqual(call);
 const bytes=Buffer.from('W4B1 original fake object'),key=f.seed.accountId+'/'+randomUUID();await f.files.put(key,bytes);let reads=0;
 const objects={bucket:f.files.bucket,read:async(k:string)=>{reads++;expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_io_starts')).rows[0].n).toBe(reads);if(reads===2)throw new Error('actual fake read failed');return f.files.read(k);},put:f.files.put.bind(f.files),receipt:f.files.receipt.bind(f.files),remove:f.files.remove.bind(f.files)};
 const io=createWindowsCostedObjectIo({objects,maxBytes:16384,begin:r=>w4bSql(f,'windows_native_cost_io_begin',[r]),end:e=>w4bSql(f,'windows_native_cost_io_end',[e]),lookup:r=>w4bSql(f,'windows_native_cost_io_lookup',[r])});
 const make=()=>({version:1 as const,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ' as const,key,expected:{sha256:sha256(bytes),bytesLength:String(bytes.length)}}),r1=make(),first=await io.read(r1),r2=make(),second=await io.read(r2);
 expect(first).toMatchObject({state:'RETURNED',event:{state:'RETURNED',observed:r1.expected}});expect(second).toMatchObject({state:'THREW',event:{state:'THREW',code:'STORAGE_UNCONFIRMED'}});expect(first.event.started).not.toEqual(first.event.ended);expect(second.event.started).not.toEqual(first.event.started);
 expect(await io.read(r1)).toEqual(first);expect(reads).toBe(2);expect(await io.lookup(r1)).toEqual(first.event);
 expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) AS starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends) AS ends')).rows).toEqual([{starts:2,ends:2}]);
 const ending={version:1 as const,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:'THREW' as const,terminalEvidence:[first.event.ended!,second.event.ended!]};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,ending))).toBe('JOINED');
 await expect(io.read(make())).rejects.toMatchObject({code:'WINDOWS_NATIVE_COST_IO_UNCONFIRMED'});expect(reads).toBe(2);
}));
it('W4-B1 64 scopes calls and IO are accepted while 65 refuses and unfinished START prevents JOINED',async()=>w4bFixture(async(f,x,scope)=>{
 const calls:WindowsNativeCostCall[]=[];for(let n=0;n<64;n++){const call=w4bCall(f,scope,n);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call))).toEqual(call);calls.push(call);}
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,w4bCall(f,scope,65)))).toBeNull();
 for(let n=1;n<64;n++)expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()))).not.toBeNull();
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()))).toBeNull();
 for(let n=0;n<64;n++)expect(await w4bSql(f,'windows_native_cost_io_begin',[{version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:calls[0].callId,callDigest:calls[0].callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null}])).not.toBeNull();
 expect(await w4bSql(f,'windows_native_cost_io_begin',[{version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:calls[0].callId,callDigest:calls[0].callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null}])).toBeNull();
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,{version:1,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:[]}))).toBe('WAIT');
 const count=(await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.windows_native_cost_scopes')).rows[0].n;expect(count).toBe(64);
 const values=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_native_cost_lookup($1::jsonb,64) AS value',[JSON.stringify(x.owner)])).rows[0].value);expect(values.scopes).toHaveLength(64);
}),60000);

import {setTimeout as w4bDelay} from 'node:timers/promises';
import {windowsNativeLimits,windowsNativeScript,windowsFrameLimits} from '../fixtures/windows-native.js';
import {WindowsNativeJournal,createWindowsJournalMemory} from '../../packages/domain/src/windows-native-journal.js';
import {createNativeJob,createNativeResult,type NativeJob} from '../../packages/native/src/dto.js';
import type {NativeFrame} from '../../packages/native/src/frame.js';
import type {NativeControllerBinding,NativeRawResultReference} from '../../packages/native/src/controller-protocol.js';
import type {WindowsCostedIoRequest,WindowsCostedIoEvent,WindowsNativeCostScopeEnd} from '../../packages/domain/src/windows-native-cost.js';
import {nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {ownedNativePng} from '../fixtures/native-images.js';

type W4bNative={binding:NativeControllerBinding;call:WindowsNativeCostCall;frame:NativeFrame<NativeJob>};
type W4bCapacity=Awaited<ReturnType<WindowsNativeFixture['registerWindowsProfile']>>;
async function w4bAdmitNative(f:WindowsNativeFixture,costs:WindowsNativeCostJournal,scope:WindowsNativeCostScope,capacity:W4bCapacity,index:number):Promise<W4bNative>{
 const sourceId='source-'+index,blobs=new Map([[sourceId,Buffer.from(ownedNativePng,'base64')]]),envelope=createNativeJob('DECODE_IMAGE',f.profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId:sourceId},blobs,windowsFrameLimits);
 const body={version:1 as const,jobId:envelope.jobId,task:envelope.task,taskVersion:envelope.taskVersion,profileDigest:envelope.profileDigest,inputDigest:envelope.inputDigest,operationInputDigest:nativeOperationInputDigest(envelope),parentInstanceId:randomUUID(),targetKind:scope.target.targetKind,targetId:scope.target.targetId,semanticCaptureDigest:scope.target.semanticCaptureDigest,protectedOwnerCapture:scope.target.protectedOwnerCapture,claim:scope.target.claim},intent={...body,logicalOperationKey:nativeLogicalOperationKey(body)};
 const base={...w4bCall(f,scope,index),task:intent.task,taskVersion:intent.taskVersion,operationInputDigest:intent.operationInputDigest},without={...base} as Partial<WindowsNativeCostCall>;delete without.callDigest;const call={...base,callDigest:digest(without)};
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.registerCallIn(tx,scope,call))).toEqual(call);
 const decision=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.admitIn(tx,scope,call,intent,{...capacity,sourceInput:scope.target.sourceInput!},'native-image'));expect(decision).toMatchObject({allowed:true,reason:'CREATED'});
 return {binding:{accountId:f.seed.accountId,capacityReservationId:decision!.capacityReservationId!,jobId:intent.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,kernelDigest:f.profile.kernelDigest},call,frame:{envelope,blobs}};
}
async function w4bOpenNative(f:WindowsNativeFixture,native:W4bNative,capacity:W4bCapacity,mode:'CREATED'|'NOT_ATTEMPTED'){
 f.memory??=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);
 const journal=new WindowsNativeJournal(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:windowsNativeLimits,signer:f.signer},f.memory);f.journals.push(journal);
 const ports=journal.portsFor(f.peer),prepared=await journal.offerOriginal(f.peer,native.binding,native.frame),captured=await ports.original.captureFresh(prepared),script=windowsNativeScript(prepared,mode);
 expect(captured.created).toBe(true);for(const entry of script.entries)await ports.journal.appendOriginal(captured.capture,entry.event,entry.source);
 return {journal,ports,prepared,capture:captured.capture,script,mode};
}
function w4bControllerIo(f:WindowsNativeFixture,native:W4bNative,context:{purpose:'RUN_RECOVERY'}|{purpose:'PARENT_QUERY';requestId:string;requestDigest:string;deliveryClaimId:string;authenticatedPeerId:string}){
 const invoke=async(kind:'begin'|'end'|'lookup',value:unknown)=>{
  const decision=await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(value),JSON.stringify(context)]);return decision.event;
 };
 const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:f.files.remove.bind(f.files)};
 return createWindowsCostedObjectIo({objects,maxBytes:windowsNativeLimits.maxOutputBytes,begin:value=>invoke('begin',value),end:value=>invoke('end',value),lookup:value=>invoke('lookup',value)});
}
async function w4bFinishNative(f:WindowsNativeFixture,costs:WindowsNativeCostJournal,native:W4bNative,open:Awaited<ReturnType<typeof w4bOpenNative>>){
 let rawResult:NativeRawResultReference|null=null,raw:ReturnType<typeof createNativeResult>|null=null;const refs:{blobId:string;assetId:string;sha256:string;bytesLength:string}[]=[];
 if(open.mode==='CREATED'){
  await open.journal.readyOriginal(open.capture,open.script.prepared);const grant=await open.ports.original.grantOriginal(open.capture),prefix=open.script.entries.length;expect(grant.created).toBe(true);open.script.complete(grant.goGrantRef);
  for(const entry of open.script.entries.slice(prefix))await open.ports.journal.appendOriginal(open.capture,entry.event,entry.source);
  const bytes=Buffer.from(ownedNativePng,'base64'),blobs=new Map([['canonical-png',bytes]]);raw=createNativeResult(native.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs},windowsFrameLimits);
  refs.push({blobId:'canonical-png',assetId:randomUUID(),sha256:sha256(bytes),bytesLength:String(bytes.length)});
  const allocation=await f.controllerDb.decision<{allowed:boolean;created:boolean;allocation:{reference:NativeRawResultReference}}>(f.seed.accountId,'SELECT manga_web.native_controller_allocate_raw($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) AS decision',[JSON.stringify(native.binding),open.capture.origin.authority.attemptId,f.controllerInstanceId,f.profile.controllerId,f.peer.serviceRole,randomUUID(),canonicalize(raw),JSON.stringify(refs),f.files.bucket]);expect(allocation.created).toBe(true);rawResult=allocation.allocation.reference;
  const io=w4bControllerIo(f,native,{purpose:'RUN_RECOVERY'});
  for(const ref of refs){
   const request=(kind:'OBJECT_PUT'|'OBJECT_READ'):WindowsCostedIoRequest=>({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:native.call.callId,callDigest:native.call.callDigest},kind,key:f.seed.accountId+'/'+ref.assetId,expected:{sha256:ref.sha256,bytesLength:ref.bytesLength}});
   const put=await io.put(request('OBJECT_PUT'),bytes);expect(put.state).toBe('RETURNED');if(put.state!=='RETURNED')throw Error('W4B_RAW_PUT_REQUIRED');
   const read=await io.read(request('OBJECT_READ'));expect(read.state).toBe('RETURNED');if(read.state!=='RETURNED')throw Error('W4B_RAW_READ_REQUIRED');expect(read.value).toEqual(bytes);
   expect(await f.controllerDb.decision(f.seed.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,rawResult.rawResultId,ref.blobId,JSON.stringify(put.value),f.files.bucket])).toMatchObject({allowed:true});
  }
 }
 await open.journal.parentJoinedOriginal(open.capture,open.script.joinAck);const record=await open.ports.journal.sealOriginal(open.capture,open.script.seal()),finalized=open.script.finalized(record),expected=await open.journal.finishOriginal(open.capture,{outcome:open.script.outcome(record,rawResult),finalized,brokerJoin:{end:'EXPECTED',finalized}}),key={binding:native.binding,expected};
 const bridge=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.recordIn(tx,key),true);expect(bridge.state).toBe('VERIFIED');return {key,bridge,open,rawResult,raw,refs};
}
function w4bEnding(scope:WindowsNativeCostScope,terminalEvidence:WindowsNativeCostScopeEnd['terminalEvidence']=[]):WindowsNativeCostScopeEnd{return {version:1,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence};}
function w4bIoRequest(f:WindowsNativeFixture,call:WindowsNativeCostCall):WindowsCostedIoRequest{return {version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_RECEIPT',key:f.seed.accountId+'/'+randomUUID(),expected:null};}

type W4bStatement={role:'trio_web_worker'|'trio_web_controller';sql:string;values:unknown[]};
async function w4bRace(f:WindowsNativeFixture,first:W4bStatement,second:W4bStatement){
 const make=(role:W4bStatement['role'])=>new pg.Client({connectionString:role==='trio_web_worker'?f.worker.connectionString:f.controller.connectionString,options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});
 const left=make(first.role),right=make(second.role);let rightWork:Promise<pg.QueryResult>|undefined;const codes:string[]=[];
 try{
  await left.connect();await right.connect();
  for(const [client,role] of [[left,first.role],[right,second.role]] as const){await client.query('BEGIN');await client.query('SET LOCAL ROLE '+role);await client.query("SET LOCAL statement_timeout='10s'");await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);}
  const leftPid=(await left.query('SELECT pg_backend_pid() pid')).rows[0].pid,rightPid=(await right.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const a=(await left.query(first.sql,first.values)).rows[0].value;
  rightWork=right.query(second.sql,second.values);let fault:unknown;void rightWork.catch(error=>{fault=error;codes.push(error.code??'UNKNOWN');});
  let blocked=false;for(let poll=0;poll<200;poll++){
   if(fault)throw fault;
   const row=(await f.admin.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) blocked',[leftPid,rightPid])).rows[0];if(row.blocked){blocked=true;break;}await w4bDelay(5);
  }
  expect(blocked,'a real second connection must wait on the first operation lock').toBe(true);await left.query('COMMIT');const b=(await rightWork).rows[0].value;await right.query('COMMIT');expect(codes).toEqual([]);
  console.info(JSON.stringify({w4b1Race:{first:first.sql.match(/manga_web\.([a-z_]+)/)?.[1],second:second.sql.match(/manga_web\.([a-z_]+)/)?.[1],observedBlocking:true,deadlocks:codes.filter(x=>x==='40P01').length,retries:0,firstResult:a,secondResult:b}}));return {first:a,second:b};
 }finally{await left.query('ROLLBACK').catch(()=>undefined);await right.query('ROLLBACK').catch(()=>undefined);if(rightWork)await rightWork.catch(()=>undefined);await left.end();await right.end();}
}
it.each(['call','START','READY','GO'] as const)('W4-B1 actual two-client %s before join and join before work serialize with zero retries',async kind=>{
 for(const order of ['work-first','join-first'] as const)await w4bFixture(async(f,x,scope)=>{
  let action:W4bStatement,ending=w4bEnding(scope),expectedJoin:'JOINED'|'WAIT'='JOINED';
  if(kind==='call'){
   const call=w4bCall(f,scope);action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_register_call($1,$2::jsonb) AS value',values:[scope.scopeId,JSON.stringify(call)]};
  }else if(kind==='START'){
   const call=w4bCall(f,scope);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,call))).toEqual(call);
   action={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_io_begin($1::jsonb) AS value',values:[JSON.stringify(w4bIoRequest(f,call))]};if(order==='work-first')expectedJoin='WAIT';
  }else{
   const native=await w4bAdmitNative(f,x.costs,scope,x.capacity,0),open=await w4bOpenNative(f,native,x.capacity,order==='join-first'?'NOT_ATTEMPTED':'CREATED');
   if(order==='join-first'){
    const finished=await w4bFinishNative(f,x.costs,native,open);ending=w4bEnding(scope,[finished.bridge.operation!,finished.bridge.termination!]);
   }else{expectedJoin='WAIT';if(kind==='GO')await open.journal.readyOriginal(open.capture,open.script.prepared);}
   const context={binding:native.binding,attemptId:open.capture.origin.authority.attemptId,controllerInstanceId:f.controllerInstanceId,controllerId:f.profile.controllerId,ownerService:f.peer.serviceRole,peerId:f.peer.peerId};
   action={role:'trio_web_controller',sql:kind==='READY'?'SELECT manga_web.windows_native_ready($1::jsonb,$2) AS value':'SELECT manga_web.windows_native_grant_go($1::jsonb) AS value',values:kind==='READY'?[JSON.stringify(context),canonicalize(open.script.prepared)]:[JSON.stringify(context)]};
  }
  const join:W4bStatement={role:'trio_web_worker',sql:'SELECT manga_web.windows_native_cost_join($1,$2::jsonb) AS value',values:[scope.scopeId,JSON.stringify(ending)]};
  const result=await w4bRace(f,order==='work-first'?action:join,order==='work-first'?join:action),work=order==='work-first'?result.first:result.second,joined=order==='work-first'?result.second:result.first;
  expect(joined).toBe(expectedJoin);
  if(kind==='call'||kind==='START')expect(work===null).toBe(order==='join-first');else expect(work.allowed).toBe(order==='work-first');
  const go=(await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows[0].n;expect(go).toBe(kind==='GO'&&order==='work-first'?1:0);
  if(order==='join-first')expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_scope_ends')).rows[0].n).toBe(1);
 });
},60000);

it('W4-B1 actual owner call 256 and IO 1024 caps preserve exact replay and reject one more on a different nonfull call',async()=>w4bFixture(async(f,x,scope)=>{
 const scopes=[scope];for(let n=1;n<5;n++)scopes.push((await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID())))!);
 const calls:WindowsNativeCostCall[]=[];for(let n=0;n<4;n++)await f.worker.accountTransaction(f.seed.accountId,async tx=>{for(let i=0;i<64;i++){const call=w4bCall(f,scopes[n],n*64+i);expect(await x.costs.registerCallIn(tx,scopes[n],call)).toEqual(call);calls.push(call);}});
 expect(calls).toHaveLength(256);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scopes[4],w4bCall(f,scopes[4],256)))).toBeNull();
 let actualReceipts=0;const objects={bucket:f.files.bucket,put:f.files.put.bind(f.files),read:f.files.read.bind(f.files),receipt:async(key:string)=>{actualReceipts++;return f.files.receipt(key);},remove:f.files.remove.bind(f.files)},io=createWindowsCostedObjectIo({objects,maxBytes:16384,begin:r=>w4bSql(f,'windows_native_cost_io_begin',[r]),end:e=>w4bSql(f,'windows_native_cost_io_end',[e]),lookup:r=>w4bSql(f,'windows_native_cost_io_lookup',[r])});
 let original:WindowsCostedIoRequest|undefined,originalEvent:WindowsCostedIoEvent|undefined;
 for(let n=0;n<16;n++){
  expect(await f.service.renew(x.execution.claim)).toBe(true);
  for(let i=0;i<64;i++){const request=w4bIoRequest(f,calls[n]),value=await io.receipt(request);expect(value.state).toBe('RETURNED');expect(value.event.ended).not.toBeNull();if(!original){original=request;originalEvent=value.event;}}
 }
 expect(actualReceipts).toBe(1024);expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_calls) calls,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends) ends')).rows).toEqual([{calls:256,starts:1024,ends:1024}]);
 expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_io_starts WHERE call_id=$1',[calls[16].callId])).rows).toEqual([{n:0}]);
 await expect(io.receipt(w4bIoRequest(f,calls[16]))).rejects.toMatchObject({code:'WINDOWS_NATIVE_COST_IO_UNCONFIRMED'});expect(actualReceipts).toBe(1024);
 expect(await w4bSql(f,'windows_native_cost_io_begin',[original])).toEqual(originalEvent);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,scope,calls[0]))).toEqual(calls[0]);
 console.info(JSON.stringify({w4b1ActualOwnerCaps:{calls:256,rejectedCall257:true,starts:1024,ends:1024,actualReceipts,rejectedIo1025:true,replayRowsUnchanged:true}}));
}),180000);

it('W4-B1 64 actual bound Windows originals produce 128 source refs that JOIN while 129 refs refuse',async()=>w4bFixture(async(f,x,scope)=>{
 const refs:WindowsNativeCostScopeEnd['terminalEvidence']=[];
 for(let index=0;index<64;index++){
  expect(await f.service.renew(x.execution.claim)).toBe(true);const native=await w4bAdmitNative(f,x.costs,scope,x.capacity,index),finished=await w4bFinishNative(f,x.costs,native,await w4bOpenNative(f,native,x.capacity,index===0?'CREATED':'NOT_ATTEMPTED'));
  refs.push(finished.bridge.operation!,finished.bridge.termination!);const proof=await operator(f).confirmWindows(finished.key);expect(proof.allowed).toBe(true);expect(proof.proofId).toBeDefined();expect(await operator(f).releaseWindows(f.seed.accountId,native.binding.capacityReservationId,proof.proofId!)).toMatchObject({allowed:true,reason:'NATIVE_CAPACITY_RELEASED'});
  if(index%8===7)console.info(JSON.stringify({w4b1ActualJoinProgress:{jobs:index+1,refs:refs.length}}));
 }
 expect(new Set(refs.map(ref=>ref.evidenceId)).size).toBe(128);
 const valid=w4bEnding(scope,refs),extra={evidenceId:x.owner.inputEvidenceId,evidenceDigest:x.owner.inputFingerprint};
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,{...valid,terminalEvidence:[...refs,extra]}))).toBe('WAIT');
 expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_scope_ends')).rows).toEqual([{n:0}]);
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,valid))).toBe('JOINED');expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,valid))).toBe('JOINED');
 expect((await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_bindings) bindings,(SELECT count(*)::integer FROM manga_web.execution_evidence WHERE kind IN('WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION')) refs,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go,(SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE state='RELEASED') released")).rows).toEqual([{bindings:64,refs:128,go:1,released:64}]);
 console.info(JSON.stringify({w4b1ActualMaximumJoin:{jobs:64,exactOriginalSourceRefs:128,rejected129:true,joined:true,replay:true}}));
}),240000);
it('W4-B1 actual repeated result QUERY ACKs preserve five-key peer fences and the shared call IO cap',async()=>w4bFixture(async(f,x,scope)=>{
 const native=await w4bAdmitNative(f,x.costs,scope,x.capacity,0),finished=await w4bFinishNative(f,x.costs,native,await w4bOpenNative(f,native,x.capacity,'CREATED'));
 const loaded=await f.controllerDb.decision<{allowed:boolean;attempt:{snapshot:Record<string,unknown>}}>(f.seed.accountId,'SELECT manga_web.native_controller_load($1::jsonb,$2,$3) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole]);
 const {isolation:_isolation,...snapshot}=loaded.attempt.snapshot;expect(_isolation).toBe('WINDOWS_JOB_OBJECT');
 const next=()=>({control:{version:2 as const,requestId:randomUUID(),binding:native.binding,command:'QUERY' as const,includeRawResult:true}});
 const context=(request:ReturnType<typeof next>)=>({purpose:'PARENT_QUERY' as const,requestId:request.control.requestId,requestDigest:digest(request.control),deliveryClaimId:randomUUID(),authenticatedPeerId:f.peer.peerId});
 const claim=async(value:unknown)=>(await f.controllerDb.decision<{allowed:boolean;value:unknown}>(f.seed.accountId,"SELECT jsonb_build_object('allowed',true,'value',manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb)) AS decision",[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(value)])).value;
 const raw=async(value:unknown)=>f.controllerDb.decision<{allowed:boolean;available:boolean}>(f.seed.accountId,'SELECT manga_web.windows_native_cost_raw_lookup($1::jsonb,$2,$3,$4,$5::jsonb) AS decision',[JSON.stringify(native.binding),f.profile.controllerId,f.peer.serviceRole,f.files.bucket,JSON.stringify(value)]);
 const response=(request:ReturnType<typeof next>)=>({requestId:request.control.requestId,responseDigest:digest({control:{version:2,requestId:request.control.requestId,command:'QUERY',binding:native.binding,snapshot},rawResult:finished.raw})});
 const ioRequest=():WindowsCostedIoRequest=>({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:native.call.callId,callDigest:native.call.callDigest},kind:'OBJECT_READ',key:f.seed.accountId+'/'+finished.refs[0].assetId,expected:{sha256:finished.refs[0].sha256,bytesLength:finished.refs[0].bytesLength}});
 for(let index=0;index<62;index++){
  if(index%8===0)expect(await f.service.renew(x.execution.claim)).toBe(true);
  const request=next(),authority=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,native.call,request));expect(authority).not.toBeNull();const readContext=context(request);
  const {authenticatedPeerId:_peer,...oldFourKeys}=readContext;
  if(index===0){
   const before={...f.objectIo};for(const invalid of [oldFourKeys,{...readContext,authenticatedPeerId:randomUUID()},{...readContext,authenticatedPeerId:'bad-peer'},{...readContext,extra:true}]){expect(await claim(invalid)).toBeNull();expect(await raw(invalid)).toMatchObject({allowed:true,available:false});}
   expect(f.objectIo).toEqual(before);expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.windows_native_cost_result_claims')).rows).toEqual([{n:0}]);
  }
  expect(await claim(readContext)).toMatchObject({requestId:request.control.requestId,deliveryClaimId:readContext.deliveryClaimId,peerId:f.peer.peerId});expect(await raw(readContext)).toMatchObject({allowed:true,available:true});
  const read=await w4bControllerIo(f,native,readContext).read(ioRequest());expect(read.state).toBe('RETURNED');
  const ack=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.finishResultQueryIn(tx,native.call,request,response(request)));expect(ack).not.toBeNull();
  if(index===0){expect(await claim(oldFourKeys)).toBeNull();expect(await raw(oldFourKeys)).toMatchObject({allowed:true,available:false});expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.finishResultQueryIn(tx,native.call,request,response(request)))).toEqual(ack);}
 }
 const pending=next(),authority=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,native.call,pending));expect(authority).not.toBeNull();const pendingContext=context(pending);expect(await claim(pendingContext)).not.toBeNull();const counts={...f.objectIo};
 await expect(w4bControllerIo(f,native,pendingContext).read(ioRequest())).rejects.toMatchObject({code:'WINDOWS_NATIVE_COST_IO_UNCONFIRMED'});expect(f.objectIo).toEqual(counts);
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.finishResultQueryIn(tx,native.call,pending,response(pending)))).toBeNull();expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,native.call,next()))).toBeNull();
 expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.joinScopeIn(tx,scope,w4bEnding(scope,[finished.bridge.operation!,finished.bridge.termination!])))).toBe('WAIT');
 expect((await f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries) queries,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_acks) acks,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts) starts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_ends) ends,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) go')).rows).toEqual([{queries:63,acks:62,starts:64,ends:64,go:1}]);
 console.info(JSON.stringify({w4b1ActualQueryIoPressure:{originalRunIo:2,acknowledgedQueries:62,pendingAuthority63:true,sharedCallIo:64,rejectedRead65:true,additionalGet:0,query64AndOwner1024Positive:'not proven; independent IO bound reached first',fiveKeyPeerFence:true}}));
}),60000);