import {afterEach,describe,expect,it,vi} from 'vitest';
// The legacy fixture imports sharp before any per-test guard can run. A W3-B
// run must refuse that addon import as well as every later decoder invocation.
vi.hoisted(()=>{
  if(process.env.TRIO_TEST_NAME_PATTERN==='^W3-B ')vi.doMock('sharp',()=>({default:()=>{throw new Error('W3B_NATIVE_IMAGE_DECODER_FORBIDDEN');}}));
});
import {randomUUID} from 'node:crypto';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {NativeControllerStore} from '../../packages/domain/src/native-controller-store.js';
import {NativeCapacityStore} from '../../packages/domain/src/native-capacity.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeControllerAttempts} from '../../packages/native/src/controller-attempts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {nativeControllerFunctions} from '../../packages/storage/src/native-controller-role.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import type {NativeOriginalAttempt,NativeRawAllocation} from '../../packages/native/src/controller-attempts.js';
import {controllerFacts,controllerFrameLimits,controllerPrivateTables,nativeControllerFixture,seedControllerUpload,type NativeControllerFixture} from '../fixtures/native-controller.js';

const privateHelpers=[
  'native_job_go_current_owned(uuid,uuid,jsonb,jsonb,text)',
  'native_job_go_owned(uuid,uuid,jsonb,jsonb,text)',
  'native_job_observation_owned(uuid,jsonb,text)',
  'native_capacity_current_owned(uuid,uuid,jsonb,jsonb,jsonb,text)',
  'native_capacity_go_owned(uuid,uuid,jsonb,jsonb,jsonb,text)',
  'native_controller_caller()',
  'native_controller_binding_valid(jsonb)',
  'native_controller_original(jsonb,uuid,text)',
  'native_controller_snapshot(uuid,uuid)'
] as const;
type Specimen=Awaited<ReturnType<typeof seedControllerUpload>>;
const fixtures:NativeControllerFixture[]=[];
async function fixture(){const value=await nativeControllerFixture();fixtures.push(value);return value;}
async function claim(f:NativeControllerFixture,specimen:Pick<Specimen,'binding'|'job'>=f,index=0){
  const id=randomUUID(),record=await f.freshStore(index).claim(f.peer,specimen.binding,specimen.job,id,f.controllers[index].instanceId);
  expect(record.created).toBe(true);expect(record.attempt).toEqual({binding:specimen.binding,job:specimen.job,snapshot:{attemptId:id,controllerInstanceId:f.controllers[index].instanceId,phase:'PREPARING',rawResult:null,termination:null,code:'OK'}});return record.attempt;
}
async function grant(f:NativeControllerFixture,attempt:NativeOriginalAttempt){
  const ready=await f.store.ready(f.peer,attempt);expect(ready.snapshot.phase).toBe('READY');const record=await f.store.grantGo(f.peer,ready);expect(record.created).toBe(true);expect(record.attempt.snapshot.phase).toBe('GO_GRANTED');return record.attempt;
}
type CountTable=typeof controllerPrivateTables[number]|'native_job_intents'|'native_job_go_consumptions'|'native_job_observations'|'native_capacity_reservations'|'native_capacity_termination_proofs'|'native_result_receipts'|'executions'|'work_items';
async function count(f:NativeControllerFixture,table:CountTable){return (await f.admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table}`)).rows[0].n;}
async function held(f:NativeControllerFixture,specimen:Pick<Specimen,'seed'|'binding'>=f){
  const reservations=await new NativeCapacityStore(f.api,specimen.seed.accountId).recover();const original=reservations.find(row=>row.capacityReservationId===specimen.binding.capacityReservationId);
  expect(original).toMatchObject({capacityReservationId:specimen.binding.capacityReservationId,jobId:specimen.binding.jobId,parentInstanceId:specimen.binding.parentInstanceId,state:'HELD',terminationProofId:null});return original!;
}
function deniedCall(signature:string){
  const matched=/^([a-z_]+)\(([^()]*)\)$/.exec(signature);expect(matched).not.toBeNull();
  const types=matched![2]?matched![2].split(','):[];expect(types.every(type=>['uuid','jsonb','text'].includes(type))).toBe(true);
  return `SELECT manga_web.${matched![1]}(${types.map(type=>`NULL::${type}`).join(',')})`;
}
afterEach(async()=>{for(const value of fixtures.splice(0).reverse())await value.close();});

// Real isolated PG18 transactions and actual service LOGINs. The peer transport
// and child observations are owned fixtures; these cases establish neither TLS
// identity, a physical subtree proof, host activation nor provider execution.
describe('owned native controller durable attempts and privileges',{timeout:20000},()=>{
  it('two controller LOGIN instances claim exactly one original attempt concurrently',async()=>{
    const f=await fixture(),ids=[randomUUID(),randomUUID()];
    const records=await Promise.all(f.controllers.map((controller,index)=>f.freshStore(index).claim(f.peer,f.binding,f.job,ids[index],controller.instanceId)));
    expect(records.filter(record=>record.created)).toHaveLength(1);expect(records[0].attempt).toEqual(records[1].attempt);const winner=records.findIndex(record=>record.created);
    expect(records[0].attempt).toEqual({binding:f.binding,job:f.job,snapshot:{attemptId:ids[winner],controllerInstanceId:f.controllers[winner].instanceId,phase:'PREPARING',rawResult:null,termination:null,code:'OK'}});
    expect(await count(f,'native_controller_attempts')).toBe(1);expect(await count(f,'native_job_go_consumptions')).toBe(0);expect(await count(f,'native_controller_go_grants')).toBe(0);
    const saved=(await f.admin.pool.query(`SELECT attempt_id,controller_instance_id,authenticated_peer_id,owner_service,protected_binding,protected_job,protected_capacity,source_asset_dependencies FROM manga_web.native_controller_attempts`)).rows[0];
    expect(saved).toMatchObject({attempt_id:ids[winner],controller_instance_id:f.controllers[winner].instanceId,authenticated_peer_id:f.peer.peerId,owner_service:'trio_web_api',protected_binding:f.binding,protected_job:f.job,protected_capacity:f.capacity});
    expect(saved.source_asset_dependencies).toHaveLength(1);expect(f.binding.parentInstanceId).not.toBe(saved.controller_instance_id);expect(f.port.put).not.toHaveBeenCalled();expect((await held(f)).go).toBe('UNCONSUMED');
  });

  it('claim commit followed by owned ACK loss recovers only the original attempt in a new store',async()=>{
    const f=await fixture();let committed:NativeOriginalAttempt|undefined;
    await expect((async()=>{committed=await claim(f);throw new Error('OWNED_CONTROLLER_CLAIM_ACK_LOST');})()).rejects.toThrow('OWNED_CONTROLLER_CLAIM_ACK_LOST');expect(committed).toBeDefined();
    const recoveredStore=f.freshStore(1),claimSpy=vi.spyOn(recoveredStore,'claim'),readySpy=vi.spyOn(recoveredStore,'ready'),goSpy=vi.spyOn(recoveredStore,'grantGo');
    expect(await recoveredStore.load(f.peer,f.binding)).toEqual(committed);expect(await recoveredStore.readExisting(f.peer,committed!)).toBeNull();
    for(const spy of [claimSpy,readySpy,goSpy])expect(spy).not.toHaveBeenCalled();expect(f.port.put).not.toHaveBeenCalled();expect(await count(f,'native_controller_attempts')).toBe(1);expect(await count(f,'native_controller_events')).toBe(0);expect(await count(f,'native_job_go_consumptions')).toBe(0);
  });

  it('GO consumption and controller grant roll back together and retry creates no second GO',async()=>{
    const f=await fixture(),attempt=await claim(f),ready=await f.store.ready(f.peer,attempt);
    await f.admin.pool.query(`CREATE FUNCTION manga_web.owned_controller_grant_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWNED_GRANT_TX_ABORT'; END $$`);
    await f.admin.pool.query('REVOKE ALL ON FUNCTION manga_web.owned_controller_grant_abort() FROM PUBLIC,trio_web_api,trio_web_worker,trio_web_operator,trio_web_controller');
    await f.admin.pool.query(`CREATE TRIGGER owned_controller_grant_abort BEFORE INSERT ON manga_web.native_controller_go_grants FOR EACH ROW EXECUTE FUNCTION manga_web.owned_controller_grant_abort()`);
    await expect(f.store.grantGo(f.peer,ready)).rejects.toMatchObject({code:'P0001',message:'OWNED_GRANT_TX_ABORT'});
    expect(await count(f,'native_job_go_consumptions')).toBe(0);expect(await count(f,'native_controller_go_grants')).toBe(0);expect((await f.store.load(f.peer,f.binding)).snapshot.phase).toBe('READY');expect((await held(f)).go).toBe('UNCONSUMED');
    await f.admin.pool.query('ALTER TABLE manga_web.native_controller_go_grants DISABLE TRIGGER owned_controller_grant_abort');
    const first=await f.store.grantGo(f.peer,ready);expect(first.created).toBe(true);const replay=await f.freshStore().grantGo(f.peer,ready);expect(replay).toEqual({...first,created:false});
    expect(await count(f,'native_job_go_consumptions')).toBe(1);expect(await count(f,'native_controller_go_grants')).toBe(1);expect((await held(f)).go).toBe('CONSUMED');
    expect((await f.admin.pool.query('SELECT job_id,parent_instance_id FROM manga_web.native_job_go_consumptions')).rows).toEqual([{job_id:f.job.jobId,parent_instance_id:f.binding.parentInstanceId}]);
  });

  it('crossed account reservation job input profile parent and controller identities cannot mutate the original',async()=>{
    const f=await fixture(),original=await claim(f),second=await seedControllerUpload(f),other=await claim(f,second);
    const crossed:NativeControllerBinding[]=[{...f.binding,accountId:second.binding.accountId},{...f.binding,capacityReservationId:second.binding.capacityReservationId},{...f.binding,jobId:second.binding.jobId},{...f.binding,inputDigest:second.binding.inputDigest},{...f.binding,profileDigest:sha256('owned-cross-profile')},{...f.binding,parentInstanceId:second.binding.parentInstanceId},{...f.binding,kernelDigest:sha256('owned-cross-kernel')}];
    for(const binding of crossed){
      await expect(f.store.load(f.peer,binding)).rejects.toMatchObject({code:'23514',message:'NATIVE_CONTROL_BINDING_MISMATCH'});
      await expect(f.store.claim(f.peer,binding,f.job,randomUUID(),f.controllers[0].instanceId)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    }
    await expect(f.store.load(f.workerPeer,f.binding)).rejects.toMatchObject({code:'23514',message:'NATIVE_CONTROL_BINDING_MISMATCH'});
    await expect(f.store.claim(f.workerPeer,f.binding,f.job,randomUUID(),f.controllers[0].instanceId)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    const wrongController=new NativeControllerStore(f.controllers[0].database,{controllerId:randomUUID(),controllerInstanceId:f.controllers[0].instanceId,input:controllerFrameLimits,output:controllerFrameLimits},f.port.objects,f.files.bucket);
    await expect(wrongController.load(f.peer,f.binding)).rejects.toMatchObject({code:'23514',message:'NATIVE_CONTROL_BINDING_MISMATCH'});
    await expect(f.store.claim(f.peer,f.binding,f.job,randomUUID(),f.controllers[1].instanceId)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    const forged={...original,snapshot:{...original.snapshot,controllerInstanceId:f.controllers[1].instanceId}},foreignStore=f.freshStore(1),facts=controllerFacts(f,original);
    await expect(foreignStore.ready(f.peer,original)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});
    await expect(foreignStore.ready(f.peer,forged)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});
    await expect(foreignStore.grantGo(f.peer,forged)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});
    await expect(foreignStore.observe(f.peer,forged,'TERMINATION',facts.evidence,facts.termination,null)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});
    await expect(foreignStore.unknown(f.peer,forged,'OWNED_CROSS_INSTANCE')).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});
    await expect(f.store.allocate(f.peer,original,{...f.result,jobId:second.job.jobId})).rejects.toMatchObject({code:'NATIVE_OUTPUT_MISMATCH'});
    expect(await f.store.load(f.peer,f.binding)).toEqual(original);expect(await f.store.load(f.peer,second.binding)).toEqual(other);expect(await count(f,'native_controller_attempts')).toBe(2);expect(await count(f,'native_controller_events')).toBe(0);expect(await count(f,'native_job_go_consumptions')).toBe(0);expect(f.port.put).not.toHaveBeenCalled();
  });

  it('lost upload owner or preview revision refuses new GO while original raw and late facts survive',async()=>{
    for(const changed of ['OWNER','PREVIEW_REVISION'] as const){
      const f=await fixture(),finished=await grant(f,await claim(f)),waitingInput=await seedControllerUpload(f,f.seed,'source-waiting'),waiting=await f.store.ready(f.peer,await claim(f,waitingInput));
      if(changed==='OWNER')await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_tab_id=$3,owner_revision=owner_revision+1 WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId,randomUUID()]);
      else await f.admin.pool.query('UPDATE manga_web.uploads SET preview_revision=preview_revision+1 WHERE account_id=$1',[f.seed.accountId]);
      await expect(f.store.grantGo(f.peer,waiting)).rejects.toMatchObject({code:'NATIVE_TARGET_FENCE_REJECTED'});
      await f.store.unknown(f.peer,finished,'OWNED_CAPTURE_LOST');const allocation=await f.store.allocate(f.peer,finished,f.result);await f.store.putOriginal(f.peer,allocation,f.computation.blobs);
      const facts=controllerFacts(f,finished);await f.store.observe(f.peer,finished,'OBSERVATION',facts.evidence,facts.termination,f.result);await f.store.observe(f.peer,finished,'TERMINATION',facts.evidence,facts.termination,null);
      const snapshot=await f.freshStore(1).load(f.peer,f.binding);expect(snapshot.snapshot).toMatchObject({attemptId:finished.snapshot.attemptId,phase:'UNKNOWN',code:'OWNED_CAPTURE_LOST',rawResult:allocation.reference,termination:facts.termination});
      expect(await f.freshStore(1).readExisting(f.peer,snapshot)).toEqual({envelope:f.result,blobs:f.computation.blobs});expect(await count(f,'native_job_go_consumptions')).toBe(1);expect(await count(f,'native_controller_go_grants')).toBe(1);expect((await held(f,waitingInput)).go).toBe('UNCONSUMED');expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect(await count(f,'native_result_receipts')).toBe(0);await f.close();
    }
  });

  it('raw allocation commit ACK loss preserves original refs and recovery has no fresh PUT authority',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f));let committed:NativeRawAllocation|undefined;
    await expect((async()=>{committed=await f.store.allocate(f.peer,attempt,f.result);throw new Error('OWNED_CONTROLLER_ALLOCATE_ACK_LOST');})()).rejects.toThrow('OWNED_CONTROLLER_ALLOCATE_ACK_LOST');expect(committed).toBeDefined();
    const saved=(await f.admin.pool.query('SELECT raw_result_id,blob_refs,result_canonical FROM manga_web.native_controller_raw_results')).rows[0],recoveredStore=f.freshStore(1),allocateSpy=vi.spyOn(recoveredStore,'allocate');
    const recovered=await recoveredStore.load(f.peer,f.binding);expect(recovered.snapshot.rawResult).toEqual(committed!.reference);expect(saved.raw_result_id).toBe(committed!.reference.rawResultId);expect(saved.blob_refs).toHaveLength(1);expect(JSON.parse(saved.result_canonical)).toEqual(f.result);
    expect(await recoveredStore.readExisting(f.peer,recovered)).toBeNull();expect(allocateSpy).not.toHaveBeenCalled();expect(f.port.put).not.toHaveBeenCalled();expect(f.port.read).not.toHaveBeenCalled();
    await expect(recoveredStore.putOriginal(f.peer,committed!,f.computation.blobs)).rejects.toMatchObject({code:'NATIVE_RAW_RESULT_UNCONFIRMED'});
    expect((await f.admin.pool.query('SELECT raw_result_id,blob_refs,result_canonical FROM manga_web.native_controller_raw_results')).rows).toEqual([saved]);expect(await count(f,'native_controller_raw_results')).toBe(1);expect(await count(f,'native_controller_object_receipts')).toBe(0);
  });

  it('object PUT ACK loss recovers the original bytes with GET and receipts without another PUT',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f)),allocation=await f.store.allocate(f.peer,attempt,f.result);
    const raw=(await f.admin.pool.query('SELECT raw_result_id,blob_refs FROM manga_web.native_controller_raw_results')).rows[0],key=`${f.seed.accountId}/${raw.blob_refs[0].assetId}`;
    f.port.loseNextPutAck();await expect(f.store.putOriginal(f.peer,allocation,f.computation.blobs)).rejects.toThrow('OWNED_CONTROLLER_PUT_ACK_LOST');expect(f.port.put).toHaveBeenCalledTimes(1);expect(f.port.put.mock.calls[0][0]).toBe(key);expect(await count(f,'native_controller_object_receipts')).toBe(0);
    const recoveredStore=f.freshStore(1),allocateSpy=vi.spyOn(recoveredStore,'allocate'),recovered=await recoveredStore.load(f.peer,f.binding);expect(recovered.snapshot.rawResult).toEqual(allocation.reference);
    expect(await recoveredStore.readExisting(f.peer,recovered)).toEqual({envelope:f.result,blobs:f.computation.blobs});expect(await recoveredStore.readExisting(f.peer,recovered)).toEqual({envelope:f.result,blobs:f.computation.blobs});
    expect(allocateSpy).not.toHaveBeenCalled();expect(f.port.put).toHaveBeenCalledTimes(1);expect(f.port.read.mock.calls.map(([value])=>value)).toEqual([key,key]);expect(f.port.receipt.mock.calls.map(([value])=>value)).toEqual([key,key]);expect(f.port.remove).not.toHaveBeenCalled();
    expect((await f.admin.pool.query('SELECT raw_result_id,blob_refs FROM manga_web.native_controller_raw_results')).rows).toEqual([raw]);expect(await count(f,'native_controller_raw_results')).toBe(1);expect(await count(f,'native_controller_object_receipts')).toBe(1);expect(await count(f,'native_job_go_consumptions')).toBe(1);expect(await count(f,'native_capacity_termination_proofs')).toBe(0);
  });

  it('UNKNOWN remains held while late RESULT TERM and original raw facts are appended',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f));await f.store.unknown(f.peer,attempt,'OWNED_PARENT_ACK_UNCONFIRMED');
    const first=(await f.jobs.unresolved(f.intent.logicalOperationKey))[0];expect(first.firstError?.snapshot.code).toBe('OWNED_PARENT_ACK_UNCONFIRMED');
    const allocation=await f.store.allocate(f.peer,attempt,f.result);await f.store.putOriginal(f.peer,allocation,f.computation.blobs);const facts=controllerFacts(f,attempt);
    await f.store.observe(f.peer,attempt,'OBSERVATION',facts.evidence,facts.termination,f.result);await f.store.observe(f.peer,attempt,'TERMINATION',facts.evidence,facts.termination,null);
    const recovered=await f.store.load(f.peer,f.binding);expect(recovered.snapshot).toMatchObject({attemptId:attempt.snapshot.attemptId,controllerInstanceId:attempt.snapshot.controllerInstanceId,phase:'UNKNOWN',code:'OWNED_PARENT_ACK_UNCONFIRMED',rawResult:allocation.reference,termination:facts.termination});
    const state=(await f.jobs.unresolved(f.intent.logicalOperationKey))[0];expect(state).toMatchObject({jobId:f.job.jobId,parentInstanceId:f.binding.parentInstanceId,go:'CONSUMED',result:'OBSERVED',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true,firstError:first.firstError});
    const observations=(await f.admin.pool.query('SELECT parent_instance_id,event,protected_observation FROM manga_web.native_job_observations ORDER BY received_at,observation_id')).rows;expect(observations.map(row=>row.event)).toEqual(['ERROR','RESULT','TERMINATION']);
    for(const row of observations){expect(row.parent_instance_id).toBe(f.binding.parentInstanceId);expect(row.parent_instance_id).not.toBe(attempt.snapshot.controllerInstanceId);expect(row.protected_observation.termination).toMatchObject({jobId:f.job.jobId,inputDigest:f.job.inputDigest,profileDigest:f.job.profileDigest});}
    expect(observations[1].protected_observation.resultDigest).toBe(digest(f.result));expect(await count(f,'native_controller_raw_results')).toBe(1);expect(await count(f,'native_controller_object_receipts')).toBe(1);expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect(await count(f,'native_result_receipts')).toBe(0);expect(await count(f,'executions')).toBe(0);expect(await count(f,'work_items')).toBe(0);expect((await held(f)).go).toBe('CONSUMED');
  });

  it('raw bucket substitution is rejected before object GET and cannot mint replacement refs',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f)),allocation=await f.store.allocate(f.peer,attempt,f.result);await f.store.putOriginal(f.peer,allocation,f.computation.blobs);
    const saved=(await f.admin.pool.query('SELECT raw_result_id,bucket_ref,blob_refs FROM manga_web.native_controller_raw_results')).rows;
    const bucket='owned-other-controller-bucket',objects={...f.port.objects,bucket};
    const other=new NativeControllerStore(f.controllers[0].database,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllers[0].instanceId,input:controllerFrameLimits,output:controllerFrameLimits},objects,bucket);
    const reads=f.port.read.mock.calls.length,receipts=f.port.receipt.mock.calls.length;
    await expect(other.readExisting(f.peer,attempt)).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
    await expect(other.allocate(f.peer,attempt,f.result)).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
    expect(f.port.read).toHaveBeenCalledTimes(reads);expect(f.port.receipt).toHaveBeenCalledTimes(receipts);expect(f.port.put).toHaveBeenCalledTimes(1);
    expect((await f.admin.pool.query('SELECT raw_result_id,bucket_ref,blob_refs FROM manga_web.native_controller_raw_results')).rows).toEqual(saved);
  });

  it('registered raw asset identity drift refuses GET and receipt replay instead of accepting original bytes',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f)),allocation=await f.store.allocate(f.peer,attempt,f.result);await f.store.putOriginal(f.peer,allocation,f.computation.blobs);
    const raw=(await f.admin.pool.query('SELECT blob_refs FROM manga_web.native_controller_raw_results')).rows[0],ref=raw.blob_refs[0];
    const proof=(await f.admin.pool.query('SELECT protected_receipt FROM manga_web.native_controller_object_receipts')).rows[0].protected_receipt;
    await f.admin.pool.query('UPDATE manga_web.assets SET sha256=$3 WHERE account_id=$1 AND asset_id=$2',[f.seed.accountId,ref.assetId,sha256('owned-raw-catalog-drift')]);
    const reads=f.port.read.mock.calls.length,receipts=f.port.receipt.mock.calls.length;
    expect(await f.freshStore(1).readExisting(f.peer,attempt)).toBeNull();
    await expect(f.controllers[0].database.decision(f.seed.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(f.binding),f.profile.controllerId,f.peer.serviceRole,allocation.reference.rawResultId,ref.blobId,JSON.stringify(proof),f.files.bucket])).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
    expect(f.port.read).toHaveBeenCalledTimes(reads);expect(f.port.receipt).toHaveBeenCalledTimes(receipts);expect(f.port.put).toHaveBeenCalledTimes(1);expect(f.port.remove).not.toHaveBeenCalled();expect(await count(f,'native_controller_object_receipts')).toBe(1);
  });

  it('late UNKNOWN records an independent error after a stored cgroup TERM without losing that TERM',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f)),facts=controllerFacts(f,attempt);
    // Owned facts only: this validates durable projection and establishes no
    // physical Linux subtree, host proof or authority to release the slot.
    const termination={...facts.termination,subtreeTerminationConfirmed:true,kind:'CGROUP_EMPTY' as const},evidence={...facts.evidence,isolation:'LINUX_CGROUP_V2' as const,subtreeTerminationConfirmed:true};
    await f.store.observe(f.peer,attempt,'TERMINATION',evidence,termination,null);
    const loaded=await f.store.load(f.peer,f.binding);expect(loaded.snapshot.termination).toEqual(termination);
    await f.store.unknown(f.peer,loaded,'OWNED_LATE_PEER_ACK_UNKNOWN');
    expect((await f.store.load(f.peer,f.binding)).snapshot).toMatchObject({phase:'UNKNOWN',code:'OWNED_LATE_PEER_ACK_UNKNOWN',termination});
    const error=(await f.admin.pool.query("SELECT protected_observation FROM manga_web.native_job_observations WHERE event='ERROR'")).rows[0].protected_observation;
    expect(error.termination).toMatchObject({kind:'UNCONFIRMED',subtreeTerminationConfirmed:false,operationJoined:false});expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect((await held(f)).state).toBe('HELD');
  });

  it('stronger original TERM survives later direct-child and joined unconfirmed observations',async()=>{
    const f=await fixture(),attempt=await grant(f,await claim(f)),facts=controllerFacts(f,attempt);
    const termination={...facts.termination,subtreeTerminationConfirmed:true,kind:'CGROUP_EMPTY' as const},evidence={...facts.evidence,isolation:'LINUX_CGROUP_V2' as const,subtreeTerminationConfirmed:true};
    await f.store.observe(f.peer,attempt,'TERMINATION',evidence,termination,null);
    await f.store.observe(f.peer,attempt,'TERMINATION',facts.evidence,facts.termination,null);
    await f.store.observe(f.peer,attempt,'TERMINATION',facts.evidence,{...facts.termination,kind:'UNCONFIRMED'},null);
    expect((await f.store.load(f.peer,f.binding)).snapshot.termination).toEqual(termination);
    expect(await count(f,'native_controller_events')).toBe(4);expect(await count(f,'native_job_observations')).toBe(3);expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect((await held(f)).state).toBe('HELD');
  });

  it('actual API worker and operator LOGINs cannot call controller owning functions tables or private helpers',async()=>{
    const f=await fixture();
    for(const client of [f.api.pool,f.worker.pool,f.operator]){
      for(const signature of [...nativeControllerFunctions,...privateHelpers])await expect(client.query(deniedCall(signature))).rejects.toMatchObject({code:'42501'});
      for(const table of controllerPrivateTables)await expect(client.query(`SELECT * FROM manga_web.${table}`)).rejects.toMatchObject({code:'42501'});
      await expect(client.query('SET ROLE trio_web_controller')).rejects.toMatchObject({code:'42501'});
    }
    expect((await f.admin.pool.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='manga_web' AND table_type='BASE TABLE'")).rows[0].n).toBe(79);
    const tables=(await f.admin.pool.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND c.relname=ANY($1::text[])`,[controllerPrivateTables])).rows;
    expect(tables).toHaveLength(5);expect(tables.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);expect(await count(f,'native_controller_attempts')).toBe(0);expect(f.port.put).not.toHaveBeenCalled();
  });

  it('actual controller LOGIN cannot execute private helpers operator release profile edits or general user writes',async()=>{
    const f=await fixture();
    for(const controller of f.controllers){
      for(const signature of privateHelpers)await expect(controller.client.query(deniedCall(signature))).rejects.toMatchObject({code:'42501'});
      await expect(controller.client.query('SELECT manga_web.native_capacity_release($1,$2,$3)',[f.seed.accountId,f.binding.capacityReservationId,randomUUID()])).rejects.toMatchObject({code:'42501'});
      await expect(controller.client.query('UPDATE manga_web.native_capacity_profiles SET max_slots=max_slots')).rejects.toMatchObject({code:'42501'});
      await expect(controller.client.query('UPDATE manga_web.assets SET sha256=sha256 WHERE account_id=$1',[f.seed.accountId])).rejects.toMatchObject({code:'42501'});
      for(const table of controllerPrivateTables)await expect(controller.client.query(`SELECT * FROM manga_web.${table}`)).rejects.toMatchObject({code:'42501'});
      for(const role of ['trio_web_api','trio_web_worker','trio_web_operator'])await expect(controller.client.query(`SET ROLE ${role}`)).rejects.toMatchObject({code:'42501'});
      await controller.database.validate();
    }
    expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect(await count(f,'native_controller_attempts')).toBe(0);expect(f.port.put).not.toHaveBeenCalled();expect(f.port.remove).not.toHaveBeenCalled();expect((await held(f)).go).toBe('UNCONSUMED');
  });

  it('controller startup refuses extra membership direct grants helper execution and search path drift',async()=>{
    const f=await fixture(),controller=f.controllers[0],db=controller.database,login=controller.loginRole;
    const changes=[
      [`GRANT trio_web_worker TO "${login}"`,`REVOKE trio_web_worker FROM "${login}"`],
      [`GRANT SELECT ON manga_web.native_controller_attempts TO "${login}"`,`REVOKE SELECT ON manga_web.native_controller_attempts FROM "${login}"`],
      ['GRANT EXECUTE ON FUNCTION manga_web.native_job_go_owned(uuid,uuid,jsonb,jsonb,text) TO trio_web_controller','REVOKE EXECUTE ON FUNCTION manga_web.native_job_go_owned(uuid,uuid,jsonb,jsonb,text) FROM trio_web_controller'],
      ['ALTER FUNCTION manga_web.native_controller_load(jsonb,uuid,text) SET search_path=pg_catalog,public','ALTER FUNCTION manga_web.native_controller_load(jsonb,uuid,text) SET search_path=pg_catalog,manga_web,pg_temp']
    ];
    for(const [change,restore] of changes){
      await f.admin.pool.query(change);
      await expect(db.validate()).rejects.toMatchObject({code:'NATIVE_CONTROLLER_ROLE_UNSAFE'});
      await expect(db.decision(f.seed.accountId,'SELECT manga_web.native_controller_load($1::jsonb,$2,$3) AS decision',[JSON.stringify(f.binding),f.profile.controllerId,f.peer.serviceRole])).rejects.toMatchObject({code:'NATIVE_CONTROLLER_ROLE_UNVERIFIED'});
      await f.admin.pool.query(restore);await db.validate();
    }
    expect(await count(f,'native_controller_attempts')).toBe(0);expect(f.port.put).not.toHaveBeenCalled();expect((await held(f)).go).toBe('UNCONSUMED');
  });

  it('actual owned child and PG attempt complete one original job and restart queries without another child or PUT',async()=>{
    const startedAt=Date.now(),trace=(stage:string)=>{process.stdout.write(JSON.stringify({scope:'owned-controller-pg-child',stage,elapsedMs:Date.now()-startedAt})+'\n');};trace('FIXTURE_BEGIN');
    const f=await fixture();trace('FIXTURE_READY');
    const runner=NativeController.owned({profile:syntheticProfile,observe:evidence=>trace(`NATIVE_${evidence.state}_${evidence.code}_JOINED_${evidence.operationJoined}`),limits:{maxMetadataBytes:controllerFrameLimits.maxMetadataBytes,maxInputBytes:controllerFrameLimits.maxBinaryBytes,maxOutputBytes:controllerFrameLimits.maxBinaryBytes,maxItems:controllerFrameLimits.maxItems,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024}});
    const store=new NativeControllerStore(f.controllers[0].database,{controllerId:f.profile.controllerId,controllerInstanceId:runner.parentInstanceId,input:controllerFrameLimits,output:controllerFrameLimits},f.port.objects,f.files.bucket);
    const starts=vi.spyOn(runner,'runCaptured'),bounds={maxControlBytes:64*1024,goWaitMilliseconds:5000,maxInFlightBytes:8*1024*1024},coordinator=new NativeControllerAttempts(runner,f.verifier,store,store,bounds),reply=vi.fn(async()=>{});
    let probePromise:Promise<void>|undefined;
    const probe=setTimeout(()=>{probePromise=(async()=>{const original=await store.load(f.peer,f.binding);trace(`PROBE_${original.snapshot.phase}_${original.snapshot.code}_${original.snapshot.termination?.kind??'NO_TERM'}`);})();void probePromise.catch(()=>trace('PROBE_UNCONFIRMED'));},10000);
    try{
      trace('PREPARE_BEGIN');const prepared=await coordinator.serve(f.apiTransport,{control:{version:1,requestId:randomUUID(),binding:f.binding,command:'PREPARE'},input:{envelope:f.job,blobs:f.inputs}},reply);trace('PREPARE_END');expect(prepared.snapshot.phase).toBe('READY');
      trace('GO_BEGIN');await coordinator.serve(f.apiTransport,{control:{version:1,requestId:randomUUID(),binding:f.binding,command:'GO',attemptId:prepared.snapshot.attemptId,controllerInstanceId:prepared.snapshot.controllerInstanceId}},reply);trace('GO_END');trace('FIRST_IDLE_BEGIN');await coordinator.idle();trace('FIRST_IDLE_END');
      const saved=await store.load(f.peer,f.binding);expect(saved.snapshot).toMatchObject({attemptId:prepared.snapshot.attemptId,phase:'GO_GRANTED',code:'OK',termination:{kind:'DIRECT_CHILD_ONLY',operationJoined:true,subtreeTerminationConfirmed:false}});
      expect(await store.readExisting(f.peer,saved)).toEqual({envelope:f.result,blobs:f.computation.blobs});expect(starts).toHaveBeenCalledTimes(1);expect(f.port.put).toHaveBeenCalledTimes(1);
      const nextRunner=NativeController.owned({profile:syntheticProfile,limits:{maxMetadataBytes:controllerFrameLimits.maxMetadataBytes,maxInputBytes:controllerFrameLimits.maxBinaryBytes,maxOutputBytes:controllerFrameLimits.maxBinaryBytes,maxItems:controllerFrameLimits.maxItems,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024}}),nextStarts=vi.spyOn(nextRunner,'runCaptured'),nextStore=new NativeControllerStore(f.controllers[1].database,{controllerId:f.profile.controllerId,controllerInstanceId:nextRunner.parentInstanceId,input:controllerFrameLimits,output:controllerFrameLimits},f.port.objects,f.files.bucket),recovered=new NativeControllerAttempts(nextRunner,f.verifier,nextStore,nextStore,bounds);
      try{
        const responses:unknown[]=[];await recovered.serve(f.apiTransport,{control:{version:1,requestId:randomUUID(),binding:f.binding,command:'QUERY',includeRawResult:true}},async response=>{responses.push(response);});
        expect(responses).toHaveLength(1);expect(responses[0]).toMatchObject({control:{snapshot:saved.snapshot},rawResult:{envelope:f.result,blobs:f.computation.blobs}});
        const replay=await recovered.serve(f.apiTransport,{control:{version:1,requestId:randomUUID(),binding:f.binding,command:'PREPARE'},input:{envelope:f.job,blobs:f.inputs}},reply);expect(replay.snapshot).toEqual(saved.snapshot);expect(nextStarts).not.toHaveBeenCalled();
      }finally{recovered.stopClaims();await recovered.idle();}
      expect(f.port.put).toHaveBeenCalledTimes(1);expect(await count(f,'native_controller_attempts')).toBe(1);expect(await count(f,'native_job_go_consumptions')).toBe(1);expect(await count(f,'native_controller_raw_results')).toBe(1);expect(await count(f,'native_capacity_termination_proofs')).toBe(0);expect((await held(f)).state).toBe('HELD');
    }finally{clearTimeout(probe);await probePromise?.catch(()=>{});trace('FINAL_IDLE_BEGIN');coordinator.stopClaims();await coordinator.idle();trace('FINAL_IDLE_END');}
  });
});

// These cases alone are selected by the approved isolated PostgreSQL runner.
// The legacy helper's decoder and actual child are never called by this suite.
async function w3bFixture(run:(f:import('../fixtures/windows-native.js').WindowsNativeFixture)=>Promise<void>){
  const {guardWindowsNativeIo,windowsNativeFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined;
  try{f=await windowsNativeFixture();await run(f);}finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
}
async function w3bSetup(f:import('../fixtures/windows-native.js').WindowsNativeFixture,options:{memoryBytes?:number;parentRelease?:Promise<void>;brokerEnd?:'EXPECTED'|'LOST'}={}){
  const {createWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js');
  const {createNativeControllerMemory}=await import('../../packages/native/src/controller-attempts.js');
  const {createWindowsOriginalController}=await import('../../packages/native/src/controller.js');
  const {createWindowsNativeBroker,createWindowsNativeClock,windowsNativeLimits}=await import('../fixtures/windows-native.js');
  expect(createWindowsControllerPorts).toBeTypeOf('function');expect(createWindowsOriginalController).toBeTypeOf('function');
  await f.request();const execution=await f.prepareExecution();await f.seedBasis(execution.input);
  const original=await f.originalIntent(execution),capacity=await f.registerWindowsProfile(),reservation=await original.reserve(capacity);
  expect(reservation).toMatchObject({allowed:true,reason:'CREATED'});expect(original.frame.blobs.get('source')?.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  const binding=original.binding(reservation.capacityReservationId!),memory=createNativeControllerMemory(options.memoryBytes??33554432);
  const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('W3B_OBJECT_DELETE_FORBIDDEN');}};
  const configuration={controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:windowsNativeLimits,signer:f.signer};
  const ports=createWindowsControllerPorts({db:f.controllerDb,configuration,objects,bucketRef:f.files.bucket,memory});f.journals.push(ports.journal);
  const host=createWindowsNativeBroker(original.frame,options),virtual=createWindowsNativeClock(),controller=createWindowsOriginalController({...ports,broker:host.broker,clock:virtual.clock});
  const transport=Object.freeze({peer:randomUUID()}),peers={authenticate:async(value:unknown)=>{if(value!==transport)throw new Error('W3B_PEER_UNCONFIRMED');return {...f.peer};}};
  const bounds={maxControlBytes:8192,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes},attempts=new NativeControllerAttempts(controller,peers,bounds);
  const baseline=memory.available();return {f,execution,original,capacity,binding,memory,objects,configuration,ports,host,virtual,controller,transport,peers,bounds,attempts,baseline};
}
type W3b=Awaited<ReturnType<typeof w3bSetup>>;
async function w3bWire(x:Pick<W3b,'attempts'|'transport'|'bounds'|'controller'|'original'>,control:import('../../packages/native/src/controller-protocol.js').NativeControllerRequestControlV2,input?:import('../../packages/native/src/frame.js').NativeFrame<import('../../packages/native/src/dto.js').NativeJob>){
  const {Writable}=await import('node:stream'),{writeNativeControllerRequest,readNativeControllerResponse}=await import('../../packages/native/src/controller-protocol.js');
  const limits={maxControlBytes:x.bounds.maxControlBytes,input:x.controller.frameLimits('input'),output:x.controller.frameLimits('output')},encoded:Buffer[]=[],replied:Buffer[]=[];
  await writeNativeControllerRequest(new Writable({write:(chunk:Buffer,_encoding,done)=>{encoded.push(Buffer.from(chunk));done();}}),{control,...(input?{input}:{})},limits);
  // Split the real control/native-frame bytes across prefix and body boundaries.
  const bytes=Buffer.concat(encoded),source=async function*(){for(let n=0;n<bytes.length;n+=37)yield bytes.subarray(n,n+37);};
  const returned=await x.attempts.serveFramed(x.transport,source(),new Writable({write:(chunk:Buffer,_encoding,done)=>{replied.push(Buffer.from(chunk));done();}}));
  const response=await readNativeControllerResponse((async function*(){for(const chunk of replied)yield chunk;})(),limits,control,x.original.frame.envelope);
  expect(response.control).toEqual(returned);expect(response.control.version).toBe(2);return response;
}
async function w3bPrepare(x:W3b){return w3bWire(x,{version:2,command:'PREPARE',requestId:randomUUID(),binding:x.binding},x.original.frame);}
async function w3bGo(x:W3b,snapshot:import('../../packages/native/src/controller-protocol.js').NativeControllerSnapshotV2){return w3bWire(x,{version:2,command:'GO',requestId:randomUUID(),binding:x.binding,attemptId:snapshot.attemptId,controllerInstanceId:snapshot.controllerInstanceId});}
async function w3bQuery(x:W3b,includeRawResult=false){return w3bWire(x,{version:2,command:'QUERY',requestId:randomUUID(),binding:x.binding,includeRawResult});}
async function w3bRows(x:W3b){return (await x.f.admin.pool.query(`SELECT
  (SELECT count(*)::integer FROM manga_web.native_controller_attempts) AS attempts,
  (SELECT count(*)::integer FROM manga_web.windows_native_origins) AS origins,
  (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) AS go,
  (SELECT count(*)::integer FROM manga_web.native_controller_go_grants) AS grants,
  (SELECT count(*)::integer FROM manga_web.windows_native_events) AS events,
  (SELECT count(*)::integer FROM manga_web.native_controller_raw_results) AS raw,
  (SELECT count(*)::integer FROM manga_web.native_controller_object_receipts) AS receipts,
  (SELECT count(*)::integer FROM manga_web.windows_native_links) AS links,
  (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='RESULT') AS results,
  (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='TERMINATION') AS terms`)).rows[0];}
function w3bLoseAck(f:import('../fixtures/windows-native.js').WindowsNativeFixture,name:string,purpose?:string){
  const decision=f.controllerDb.decision.bind(f.controllerDb);let losses=0;
  f.controllerDb.decision=async(accountId,query,values,check)=>{
    const result=await decision(accountId,query,values,check);
    if(losses===0&&query.includes(name)&&(purpose===undefined||values[1]===purpose)){losses++;throw new Error('W3B_ACK_LOST_AFTER_COMMIT');}return result;
  };
  return ()=>losses;
}
async function w3bFinal(x:W3b){
  await x.controller.idle();const response=await w3bQuery(x,true),snapshot=response.control.snapshot;
  expect(snapshot).toMatchObject({version:2,phase:'GO_GRANTED',code:'OK',termination:{kind:'WINDOWS_JOB_EMPTY',operationJoined:true,subtreeTerminationConfirmed:true}});expect(snapshot.windowsEvidenceRef).not.toBeNull();expect(snapshot.rawResult).not.toBeNull();
  expect(Reflect.ownKeys(snapshot).sort()).toEqual(['attemptId','code','controllerInstanceId','phase','rawResult','termination','version','windowsEvidenceRef']);expect(response.rawResult).toEqual(x.host.result);
  expect(await w3bRows(x)).toEqual({attempts:1,origins:1,go:1,grants:1,events:12,raw:1,receipts:1,links:1,results:1,terms:1});
  expect(x.host.captures).toHaveLength(1);expect(x.host.joins).toBe(1);expect(x.host.controls.filter(value=>value.command==='GRANT_GO')).toHaveLength(1);expect(x.host.failures).toEqual([]);expect(x.f.objectIo.put).toBe(1);
  expect(x.host.receivedParentAcks).toHaveLength(1);expect(x.host.script!.seal().parentJoinAck).toEqual(x.host.receivedParentAcks[0]);
  const stored=(await x.f.admin.pool.query(`SELECT e.protected_event,e.protected_source FROM manga_web.windows_native_events e ORDER BY e.sequence`)).rows;
  expect(stored.find(row=>row.protected_event.kind==='CREATED_SUSPENDED').protected_source.facts.map((fact:{qpcTicks:string})=>fact.qpcTicks)).toEqual(['120','127']);
  expect(stored.find(row=>row.protected_event.kind==='IO_JOINED').protected_source.facts.find((fact:{kind:string})=>fact.kind==='PARENT_ACK').ack).toEqual(x.host.receivedParentAcks[0]);
  expect(x.host.script!.evidence().final.accounting?.userTime100ns).toBe('9007199254740993');
  expect((await x.f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations WHERE reservation_id=$1',[x.binding.capacityReservationId])).rows).toEqual([{state:'HELD'}]);
  expect(x.virtual.pending()).toBe(0);expect(x.memory.available()).toBe(x.baseline);return response;
}

it('W3-B PREPARE GO QUERY connects real W2 Journal raw DB and framed codec once',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f),[prepared,concurrent]=await Promise.all([w3bPrepare(x),w3bPrepare(x)]);expect(concurrent.control.snapshot).toEqual(prepared.control.snapshot);expect(prepared.control.snapshot).toMatchObject({version:2,phase:'READY',termination:null,rawResult:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'});
  expect((await w3bPrepare(x)).control.snapshot).toEqual(prepared.control.snapshot);await w3bGo(x,prepared.control.snapshot);const final=await w3bFinal(x),counts=await w3bRows(x);
  expect((await w3bPrepare(x)).control.snapshot).toEqual(final.control.snapshot);expect(await w3bRows(x)).toEqual(counts);expect(f.objectIo.put).toBe(1);
  const {createWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js'),{createWindowsOriginalController}=await import('../../packages/native/src/controller.js'),{createWindowsNativeBroker,createWindowsNativeClock}=await import('../fixtures/windows-native.js');
  const ports=createWindowsControllerPorts({db:f.controllerDb,configuration:{...x.configuration,controllerInstanceId:randomUUID()},objects:x.objects,bucketRef:f.files.bucket,memory:x.memory});f.journals.push(ports.journal);
  const host=createWindowsNativeBroker(x.original.frame),clock=createWindowsNativeClock(),controller=createWindowsOriginalController({...ports,broker:host.broker,clock:clock.clock}),attempts=new NativeControllerAttempts(controller,x.peers,x.bounds);
  const history=await w3bWire({...x,controller,attempts},{version:2,command:'QUERY',requestId:randomUUID(),binding:x.binding,includeRawResult:true});expect(history.control.snapshot).toEqual(final.control.snapshot);expect(history.rawResult).toEqual(x.host.result);expect(host.captures).toEqual([]);expect(host.controls).toEqual([]);expect(f.objectIo.put).toBe(1);
  await controller.idle();await f.close();expect(x.memory.available()).toBe(x.memory.maxBytes);
}));

it('W3-B M equal to L refuses before original offer capture or broker open',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f,{memoryBytes:8388608});
  await expect(w3bPrepare(x)).rejects.toMatchObject({code:'NATIVE_CONTROL_CAPACITY_WAIT'});expect(f.decisionCalls.filter(query=>query.includes('windows_native_offer'))).toEqual([]);expect(x.host.captures).toEqual([]);expect(await w3bRows(x)).toEqual({attempts:0,origins:0,go:0,grants:0,events:0,raw:0,receipts:0,links:0,results:0,terms:0});
  await x.controller.idle();expect(x.memory.available()).toBe(x.baseline);await f.close();expect(x.memory.available()).toBe(x.memory.maxBytes);
}));

it('W3-B intermediate QUERY stays finite while the real parent ACK gates FINALIZED and broker join',async()=>w3bFixture(async f=>{
  let release!:()=>void;const parentRelease=new Promise<void>(resolve=>{release=resolve;}),x=await w3bSetup(f,{parentRelease});
  try{
    const prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await vi.waitFor(()=>expect(x.host.receivedParentAcks).toHaveLength(1));
    expect(x.host.finalized).toBeNull();expect(x.host.controls.some(value=>value.command==='ACK_FINAL')).toBe(false);
    const gets=f.objectIo.get,query=await w3bQuery(x,true);expect(query.control.snapshot).toMatchObject({phase:'GO_GRANTED',termination:null,rawResult:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'});expect(query.rawResult).toBeUndefined();expect(f.objectIo.get).toBe(gets);expect(x.memory.available()).toBeLessThan(x.baseline);
    release();await w3bFinal(x);
  }finally{release();}
}));

it.each([{name:'windows_native_append'},{name:'windows_native_record',purpose:'SEAL'},{name:'windows_native_finish'},{name:'windows_native_link'}])('W3-B $name COMMIT ACK loss recovers the original refs without another GO or PUT',async failure=>w3bFixture(async f=>{
  const losses=w3bLoseAck(f,failure.name,'purpose'in failure?failure.purpose:undefined),x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await w3bFinal(x);expect(losses()).toBe(1);
}));
it('W3-B original DB snapshot requires exactly nine keys before projecting eight wire keys',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await w3bFinal(x);
  const decision=f.controllerDb.decision.bind(f.controllerDb);let change:(snapshot:Record<string,unknown>)=>void=()=>{};
  f.controllerDb.decision=(accountId,query,values,check)=>decision(accountId,query,values,record=>{
    if(query.includes('native_controller_load'))change((record as unknown as {attempt:{snapshot:Record<string,unknown>}}).attempt.snapshot);check?.(record);
  });
  const cases=[
    {change:(snapshot:Record<string,unknown>)=>{snapshot.extra='refuse';},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{Object.defineProperty(snapshot,'hidden',{value:true});},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{delete snapshot.isolation;},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{snapshot.isolation='OWNED_FIXTURE';},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{snapshot.version=1;},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{snapshot.windowsEvidenceRef={recordId:randomUUID(),recordDigest:sha256('only record')};},code:'NATIVE_CONTROLLER_RECORD_UNCONFIRMED'},
    {change:(snapshot:Record<string,unknown>)=>{(snapshot.termination as Record<string,unknown>).jobId=randomUUID();},code:'NATIVE_CONTROL_BINDING_MISMATCH'}
  ];
  for(const specimen of cases){change=specimen.change;await expect(x.ports.journal.loadOriginal(f.peer,x.binding)).rejects.toMatchObject({code:specimen.code});expect(x.memory.available()).toBe(x.baseline);}
  change=()=>{};expect((await x.ports.journal.loadOriginal(f.peer,x.binding)).snapshot.windowsEvidenceRef).not.toBeNull();expect(x.memory.available()).toBe(x.baseline);expect(f.objectIo.put).toBe(1);
}));

it('W3-B raw allocation COMMIT ACK loss preserves one allocation and never gains a fresh PUT token',async()=>w3bFixture(async f=>{
  const losses=w3bLoseAck(f,'native_controller_allocate_raw'),x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);
  await expect(x.controller.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});expect(losses()).toBe(1);
  const before=await w3bRows(x);expect(before).toMatchObject({attempts:1,origins:1,go:1,grants:1,raw:1,receipts:0,links:0,results:0,terms:0});expect(f.objectIo.put).toBe(0);
  const attempt=await x.ports.journal.loadOriginal(f.peer,x.binding);expect(attempt.snapshot).toMatchObject({phase:'GO_GRANTED',rawResult:null,termination:null,windowsEvidenceRef:null});
  expect(await x.ports.raw.readExisting(f.peer,attempt)).toBeNull();expect(await w3bRows(x)).toEqual(before);expect(f.objectIo.put).toBe(0);expect(f.decisionCalls.filter(query=>query.includes('native_controller_allocate_raw'))).toHaveLength(1);
  await expect(x.ports.raw.putOriginal(f.peer,{attemptId:attempt.snapshot.attemptId,reference:{rawResultId:randomUUID(),resultDigest:digest(x.host.result.envelope)},result:x.host.result.envelope},x.host.result.blobs)).rejects.toMatchObject({code:'NATIVE_RAW_RESULT_UNCONFIRMED'});expect(f.objectIo.put).toBe(0);
  expect(x.virtual.pending()).toBe(0);expect(x.memory.available()).toBe(x.baseline-4096);
}));
it('W3-B concurrent domain loads retain separate 4J scopes until actual DB reads finish',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await w3bFinal(x);
  const decision=f.controllerDb.decision.bind(f.controllerDb);let release!:()=>void,blocked=0,blocking=true;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.controllerDb.decision=async(accountId,query,values,check)=>{const result=await decision(accountId,query,values,check);if(blocking&&query.includes('windows_native_read')){blocked++;await gate;}return result;};
  const {createWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js'),ports=createWindowsControllerPorts({db:f.controllerDb,configuration:x.configuration,objects:x.objects,bucketRef:f.files.bucket,memory:x.memory});f.journals.push(ports.journal);
  const baseline=x.memory.available(),replyBytes=3*(4096+8192+4096),reply1=x.memory.hold(replyBytes),reply2=x.memory.hold(replyBytes);
  let first:Promise<import('../../packages/native/src/controller-attempts.js').NativeOriginalAttemptV2>|undefined=ports.journal.loadOriginal(f.peer,x.binding),second:Promise<import('../../packages/native/src/controller-attempts.js').NativeOriginalAttemptV2>|undefined=ports.journal.loadOriginal(f.peer,x.binding);
  try{
    await vi.waitFor(()=>expect(blocked).toBe(2));expect(x.memory.available()).toBeLessThanOrEqual(baseline-2*replyBytes-2*3*4*131072);
    blocking=false;release();let values:Awaited<NonNullable<typeof first>>[]|undefined=await Promise.all([first,second]);expect(values[0]).toEqual(values[1]);expect(values[0]).not.toBe(values[1]);
    expect(x.memory.available()).toBe(baseline-2*replyBytes);values=undefined;first=undefined;second=undefined;
  }finally{blocking=false;release();await Promise.allSettled([first,second]);first=undefined;second=undefined;reply1();reply2();}
  expect(x.memory.available()).toBe(baseline);
}));

it('W3-B original PUT ACK loss recovers persisted bytes with receipt GET and no second PUT',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f),put=x.objects.put;let lost=false;
  x.objects.put=async(key,bytes)=>{const proof=await put(key,bytes);if(!lost){lost=true;throw new Error('W3B_PUT_ACK_LOST_AFTER_ORIGINAL_BYTES');}return proof;};
  const prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await w3bFinal(x);
  expect(lost).toBe(true);expect(f.objectIo.put).toBe(1);const attempt=await x.ports.journal.loadOriginal(f.peer,x.binding),saved=await x.ports.raw.readExisting(f.peer,attempt);expect(saved).toEqual(x.host.result);expect(f.objectIo.put).toBe(1);
  const rows=await w3bRows(x);expect(rows).toMatchObject({raw:1,receipts:1,links:1,results:1,terms:1});expect(await x.ports.raw.readExisting(f.peer,attempt)).toEqual(x.host.result);expect(f.objectIo.put).toBe(1);expect(await w3bRows(x)).toEqual(rows);
  expect(x.virtual.pending()).toBe(0);expect(x.memory.available()).toBe(x.baseline);
}));

it('W3-B LOST broker join preserves original raw refs but masks final termination and raw response',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f,{brokerEnd:'LOST'}),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await expect(x.controller.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});
  expect(x.host.receivedParentAcks).toHaveLength(1);expect(x.host.finalized).toMatchObject({handles:'CLOSED'});expect(x.host.joins).toBe(1);expect(x.host.failures).toEqual([]);
  const gets=f.objectIo.get,response=await w3bQuery(x,true);expect(response.control.snapshot).toMatchObject({phase:'GO_GRANTED',termination:null,rawResult:null,windowsEvidenceRef:null});expect(response.rawResult).toBeUndefined();expect(f.objectIo.get).toBe(gets);expect(f.objectIo.put).toBe(1);expect(await w3bRows(x)).toMatchObject({go:1,grants:1,raw:1,receipts:1,links:0,results:0,terms:0});
}));

it('W3-B raw asset identity drift refuses GET while the original Windows link and DB refs survive',async()=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);const final=await w3bFinal(x),before=await w3bRows(x),gets=f.objectIo.get;
  await f.admin.pool.query('UPDATE manga_web.assets SET sha256=$2 WHERE asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=$1)',[x.binding.accountId,sha256('W3-B synthetic raw drift')]);
  const query=await w3bQuery(x,true);expect(f.objectIo.get).toBe(gets);expect(f.objectIo.put).toBe(1);expect(query.rawResult).toBeUndefined();expect(query.control.snapshot).toEqual({...final.control.snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'});expect(await w3bRows(x)).toEqual(before);
}));

async function w3bDrift(x:W3b,kind:'OWNER'|'WORKSPACE_REVISION'){
  if(kind==='OWNER')await x.f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_tab_id=$3,owner_revision=owner_revision+1 WHERE account_id=$1 AND context_id=$2',[x.binding.accountId,x.f.seed.contextId,randomUUID()]);
  else await x.f.admin.pool.query('UPDATE manga_web.workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[x.binding.accountId,x.f.seed.contextId]);
}
it.each(['OWNER','WORKSPACE_REVISION'] as const)('W3-B CURRENT_AUTHORITY %s drift forbids additional raw-store GET without weakening v1 history',async kind=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await w3bFinal(x);const attempt=await x.ports.journal.loadOriginal(f.peer,x.binding),gets=f.objectIo.get,rows=await w3bRows(x);
  await w3bDrift(x,kind);const result=await x.ports.raw.readExisting(f.peer,attempt);
  expect(f.objectIo.get,'W3-B current owner/revision loss must refuse before object GET').toBe(gets);expect(result).toBeNull();expect(f.objectIo.put).toBe(1);expect(await w3bRows(x)).toEqual(rows);
}));
it.each(['OWNER','WORKSPACE_REVISION'] as const)('W3-B CURRENT_AUTHORITY %s drift QUERY includeRawResult preserves historical refs with no additional GET',async kind=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);const final=await w3bFinal(x),gets=f.objectIo.get,rows=await w3bRows(x);
  await w3bDrift(x,kind);const query=await w3bQuery(x,true);
  expect(f.objectIo.get,'W3-B QUERY must refuse current-bound raw bytes before object GET').toBe(gets);expect(query.rawResult).toBeUndefined();expect(query.control.snapshot).toEqual({...final.control.snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'});expect(f.objectIo.put).toBe(1);expect(await w3bRows(x)).toEqual(rows);
}));
it('W3-B capture COMMIT ACK loss remains read only across a new controller instance',async()=>w3bFixture(async f=>{
  const losses=w3bLoseAck(f,'windows_native_capture'),x=await w3bSetup(f),prepared=await w3bPrepare(x);
  expect(prepared.control.snapshot).toMatchObject({version:2,phase:'PREPARING',windowsEvidenceRef:null,termination:null,rawResult:null});
  await expect(x.controller.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});expect(losses()).toBe(1);expect(x.host.captures).toEqual([]);
  const before=await w3bRows(x);expect(before).toMatchObject({attempts:1,origins:1,go:0,grants:0,events:0,raw:0,links:0,results:0,terms:0});
  const {createWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js'),{createWindowsOriginalController}=await import('../../packages/native/src/controller.js'),{createWindowsNativeBroker,createWindowsNativeClock}=await import('../fixtures/windows-native.js');
  const ports=createWindowsControllerPorts({db:f.controllerDb,configuration:{...x.configuration,controllerInstanceId:randomUUID()},objects:x.objects,bucketRef:f.files.bucket,memory:x.memory});f.journals.push(ports.journal);
  const host=createWindowsNativeBroker(x.original.frame),virtual=createWindowsNativeClock(),controller=createWindowsOriginalController({...ports,broker:host.broker,clock:virtual.clock}),attempts=new NativeControllerAttempts(controller,x.peers,x.bounds),next={...x,ports,host,controller,attempts};
  const history=await w3bPrepare(next);expect(history.control.snapshot).toMatchObject({attemptId:prepared.control.snapshot.attemptId,phase:'PREPARING',code:'WINDOWS_ATTEMPT_NOT_LIVE',windowsEvidenceRef:null,termination:null,rawResult:null});
  await expect(w3bGo(next,prepared.control.snapshot)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});await controller.idle();
  expect(host.captures).toEqual([]);expect(host.controls).toEqual([]);expect(await w3bRows(x)).toEqual(before);expect(f.objectIo).toEqual({get:0,put:0});expect(x.virtual.pending()).toBe(0);expect(virtual.pending()).toBe(0);
}));
it('W3-B GO COMMIT ACK loss consumes one original grant without forwarding or replaying physical GO',async()=>w3bFixture(async f=>{
  const losses=w3bLoseAck(f,'windows_native_grant_go'),x=await w3bSetup(f),prepared=await w3bPrepare(x);
  await expect(w3bGo(x,prepared.control.snapshot)).rejects.toMatchObject({code:'WINDOWS_GO_UNCONFIRMED'});await expect(x.controller.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});expect(losses()).toBe(1);
  const before=await w3bRows(x);expect(before).toMatchObject({attempts:1,origins:1,go:1,grants:1,raw:0,links:0,results:0,terms:0});
  const query=await w3bQuery(x,true);expect(query.control.snapshot).toMatchObject({phase:'GO_GRANTED',windowsEvidenceRef:null,termination:null,rawResult:null});expect(query.rawResult).toBeUndefined();
  await expect(w3bGo(x,prepared.control.snapshot)).rejects.toMatchObject({code:'NATIVE_CONTROLLER_INSTANCE_UNCONFIRMED'});await w3bPrepare(x);
  expect(await w3bRows(x)).toEqual(before);expect(x.host.captures).toHaveLength(1);expect(x.host.controls.filter(value=>value.command==='GRANT_GO')).toHaveLength(0);expect(f.objectIo).toEqual({get:0,put:0});expect(x.virtual.pending()).toBe(0);expect(x.memory.available()).toBe(x.baseline-4096);
}));


// B05 current byte authority is independent of immutable attempt/termination history.
const w3bAuthorityLosses=['ACCOUNT_RESTRICTED','ACCOUNT_CLOSED','CONTEXT_CLOSED','SESSION_REVOKED','SESSION_EXPIRED','LOGIN_REVOKED','AUTH_GENERATION','SOURCE_RETENTION','RAW_RETENTION'] as const;
type W3bAuthorityLoss=typeof w3bAuthorityLosses[number];
async function w3bLoseAuthority(x:W3b,kind:W3bAuthorityLoss){
  const values=[x.binding.accountId,x.f.seed.sessionId];
  switch(kind){
    case 'ACCOUNT_RESTRICTED':case 'ACCOUNT_CLOSED':
      await x.f.admin.pool.query('UPDATE manga_web.accounts SET access_state=$2 WHERE account_id=$1',[x.binding.accountId,kind==='ACCOUNT_CLOSED'?'CLOSED':'RESTRICTED']);break;
    case 'CONTEXT_CLOSED':
      await x.f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[x.binding.accountId,x.f.seed.contextId]);break;
    case 'SESSION_REVOKED':
      await x.f.admin.pool.query("UPDATE manga_web.app_sessions SET revoked_at=clock_timestamp(),revocation_reason='B05_SYNTHETIC_REVOKED' WHERE account_id=$1 AND session_id=$2",values);break;
    case 'SESSION_EXPIRED':
      await x.f.admin.pool.query("WITH boundary AS(SELECT clock_timestamp()-interval '1 second' AS at) UPDATE manga_web.app_sessions SET absolute_expires_at=boundary.at,fresh_login_verified_at=boundary.at-interval '7 days' FROM boundary WHERE account_id=$1 AND session_id=$2",values);break;
    case 'LOGIN_REVOKED':
      await x.f.admin.pool.query("UPDATE manga_web.login_bindings SET state='REVOKED',revoked_at=clock_timestamp() WHERE account_id=$1 AND binding_id=$2",[x.binding.accountId,x.f.seed.bindingId]);break;
    case 'AUTH_GENERATION':
      await x.f.admin.pool.query('UPDATE manga_web.accounts SET auth_generation=auth_generation+1 WHERE account_id=$1',[x.binding.accountId]);break;
    case 'SOURCE_RETENTION':
      await x.f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND asset_id IN(SELECT (dep->>'assetId')::uuid FROM manga_web.native_controller_attempts a CROSS JOIN LATERAL jsonb_array_elements(a.source_asset_dependencies) dep WHERE a.account_id=$1)",[x.binding.accountId]);break;
    case 'RAW_RETENTION':
      await x.f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=$1)",[x.binding.accountId]);break;
  }
}
async function w3bHistory(x:Pick<W3b,'f'|'binding'>){
  const tables=['native_controller_attempts','native_controller_events','native_controller_go_grants','native_controller_raw_results','native_controller_object_receipts','native_job_intents','native_job_go_consumptions','native_job_observations','windows_native_origins','windows_native_events','windows_native_records','windows_native_links'] as const;
  return Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await x.f.admin.pool.query("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS history FROM manga_web."+table+' t WHERE account_id=$1',[x.binding.accountId])).rows[0].history])));
}
it.each(w3bAuthorityLosses)('W3-B B05 %s current authority refuses raw and framed QUERY bytes while all original history survives',async kind=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);const final=await w3bFinal(x),attempt=await x.ports.journal.loadOriginal(f.peer,x.binding),history=await w3bHistory(x),rows=await w3bRows(x),io={...f.objectIo};
  await w3bLoseAuthority(x,kind);
  const raw=await x.ports.raw.readExisting(f.peer,attempt);
  expect(f.objectIo,'B05 '+kind+': revoked byte authority must precede object GET/PUT').toEqual(io);expect(raw).toBeNull();
  const query=await w3bQuery(x,true);expect(query.rawResult).toBeUndefined();expect(query.control.snapshot).toEqual({...final.control.snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'});
  expect((await x.ports.journal.loadOriginal(f.peer,x.binding)).snapshot).toEqual(attempt.snapshot);
  expect(f.objectIo).toEqual(io);expect(await w3bRows(x)).toEqual(rows);expect(await w3bHistory(x)).toEqual(history);expect(x.memory.available()).toBe(x.baseline);expect(x.virtual.pending()).toBe(0);
}));

it.each([...w3bAuthorityLosses.filter(kind=>kind!=='RAW_RETENTION'),'OWNER','WORKSPACE_REVISION'] as const)('W3-B B05 %s after committed allocation refuses fresh PUT and preserves the original unconfirmed refs',async kind=>w3bFixture(async f=>{
  const x=await w3bSetup(f),decision=f.controllerDb.decision.bind(f.controllerDb);let changed=false,reference:unknown;
  f.controllerDb.decision=async(accountId,query,values,check)=>{
    const result=await decision(accountId,query,values,check);
    if(!changed&&query.includes('native_controller_allocate_raw')){
      changed=true;reference=(result as unknown as {allocation:{reference:unknown}}).allocation.reference;
      if(kind==='OWNER'||kind==='WORKSPACE_REVISION')await w3bDrift(x,kind);else await w3bLoseAuthority(x,kind);
    }return result;
  };
  const prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);await expect(x.controller.idle()).rejects.toMatchObject({code:'WINDOWS_TERMINATION_UNCONFIRMED'});
  expect(changed).toBe(true);expect(reference).toMatchObject({rawResultId:expect.any(String),resultDigest:digest(x.host.result.envelope)});expect(f.objectIo).toEqual({get:0,put:0});
  const rows=await w3bRows(x),history=await w3bHistory(x);expect(rows).toMatchObject({attempts:1,origins:1,go:1,grants:1,raw:1,receipts:0,links:0,results:0,terms:0});
  const saved=(await f.admin.pool.query('SELECT raw_result_id,result_digest FROM manga_web.native_controller_raw_results WHERE account_id=$1',[x.binding.accountId])).rows;
  expect(saved).toEqual([{raw_result_id:(reference as {rawResultId:string}).rawResultId,result_digest:digest(x.host.result.envelope)}]);
  const attempt=await x.ports.journal.loadOriginal(f.peer,x.binding);expect(await x.ports.raw.readExisting(f.peer,attempt)).toBeNull();
  const query=await w3bQuery(x,true);expect(query.rawResult).toBeUndefined();expect(query.control.snapshot).toMatchObject({attemptId:prepared.control.snapshot.attemptId,phase:'GO_GRANTED',rawResult:null,termination:null,windowsEvidenceRef:null});
  expect(f.objectIo).toEqual({get:0,put:0});expect(await w3bRows(x)).toEqual(rows);expect(await w3bHistory(x)).toEqual(history);expect(x.virtual.pending()).toBe(0);
}));

const w3bBlockedExpiryCases=[
  {expiry:'SESSION',table:'workspace_contexts'},
  {expiry:'SESSION',table:'app_sessions'},
  {expiry:'SESSION',table:'login_bindings'},
  {expiry:'RAW_RETENTION',table:'workspace_contexts'},
  {expiry:'SOURCE_RETENTION',table:'accounts'}
] as const;
it.each(w3bBlockedExpiryCases)('W3-B B05 $expiry expires while raw lookup is actually blocked on $table and refuses all object IO after release',async specimen=>w3bFixture(async f=>{
  const x=await w3bSetup(f),prepared=await w3bPrepare(x);await w3bGo(x,prepared.control.snapshot);const final=await w3bFinal(x),attempt=await x.ports.journal.loadOriginal(f.peer,x.binding),history=await w3bHistory(x),rows=await w3bRows(x),io={...f.objectIo};
  const expiry=specimen.expiry==='SESSION'
    ?(await f.admin.pool.query<{boundary:string}>("WITH boundary AS(SELECT clock_timestamp()+interval '4 seconds' AS at) UPDATE manga_web.app_sessions SET absolute_expires_at=boundary.at,fresh_login_verified_at=boundary.at-interval '7 days' FROM boundary WHERE account_id=$1 AND session_id=$2 RETURNING absolute_expires_at::text AS boundary",[x.binding.accountId,f.seed.sessionId])).rows
    :(await f.admin.pool.query<{boundary:string}>("WITH boundary AS(SELECT clock_timestamp()+interval '4 seconds' AS at) UPDATE manga_web.assets SET access_deadline=boundary.at FROM boundary WHERE account_id=$1 AND asset_id IN("+(specimen.expiry==='RAW_RETENTION'?'SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=$1':"SELECT (dep->>'assetId')::uuid FROM manga_web.native_controller_attempts a CROSS JOIN LATERAL jsonb_array_elements(a.source_asset_dependencies) dep WHERE a.account_id=$1")+') RETURNING access_deadline::text AS boundary',[x.binding.accountId])).rows;
  expect(expiry).toHaveLength(1);const boundary=expiry[0].boundary,blocker=await f.admin.pool.connect();let pending:ReturnType<typeof x.ports.raw.readExisting>|undefined,settled=false;
  try{
    await blocker.query('BEGIN');const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const column=specimen.table==='workspace_contexts'?'context_id':specimen.table==='app_sessions'?'session_id':specimen.table==='login_bindings'?'binding_id':null;
    const rowId=specimen.table==='workspace_contexts'?f.seed.contextId:specimen.table==='app_sessions'?f.seed.sessionId:f.seed.bindingId;
    expect((await blocker.query('SELECT 1 FROM manga_web.'+specimen.table+' WHERE account_id=$1'+(column?' AND '+column+'=$2':'')+' FOR UPDATE',column?[x.binding.accountId,rowId]:[x.binding.accountId])).rowCount).toBe(1);
    pending=x.ports.raw.readExisting(f.peer,attempt);void pending.then(()=>{settled=true;},()=>{settled=true;});
    let observed:Record<string,unknown>|undefined;
    await vi.waitFor(async()=>{
      const blocked=(await f.admin.pool.query("SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,query_start::text,clock_timestamp()::text AS sampled,clock_timestamp()<$3::timestamptz AS before_expiry FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND query LIKE 'SELECT manga_web.native_controller_raw_lookup%' AND state='active' AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",[f.controller.name,blockerPid,boundary])).rows;
      expect(blocked,'raw lookup must wait on an actual owner-authority row lock').toHaveLength(1);expect(blocked[0].before_expiry,'the call must start blocking before the DB expiry boundary').toBe(true);observed=blocked[0];
    },{timeout:2000,interval:20});
    expect(settled).toBe(false);expect(f.objectIo).toEqual(io);console.info('B05_LOCK_BLOCKED '+JSON.stringify({specimen,boundary,blockerPid,observed}));
    let crossed:Record<string,unknown>|undefined;
    await vi.waitFor(async()=>{
      const row=(await f.admin.pool.query("SELECT sampled::text,sampled>=$1::timestamptz AS expired FROM(SELECT clock_timestamp() sampled) s",[boundary])).rows[0];expect(row.expired).toBe(true);crossed=row;
    },{timeout:7000,interval:20});
    expect((await f.admin.pool.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",[f.controller.name,blockerPid])).rows).toEqual([{n:1}]);
    expect(settled).toBe(false);expect(f.objectIo).toEqual(io);console.info('B05_LOCK_DB_BOUNDARY '+JSON.stringify({specimen,boundary,crossed}));
  }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(pending?[pending]:[]);}
  expect(pending).toBeDefined();expect(await pending).toBeNull();expect(f.objectIo).toEqual(io);
  const query=await w3bQuery(x,true);expect(query.rawResult).toBeUndefined();expect(query.control.snapshot).toEqual({...final.control.snapshot,rawResult:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'});
  expect((await x.ports.journal.loadOriginal(f.peer,x.binding)).snapshot).toEqual(attempt.snapshot);expect(await w3bRows(x)).toEqual(rows);expect(await w3bHistory(x)).toEqual(history);expect(f.objectIo).toEqual(io);expect(x.memory.available()).toBe(x.baseline);
}),20000);
// This v1 specimen uses the existing worker INPUT/BASIS and hand-owned PNG bytes.
// Its RESULT/TERM are synthetic DB facts; no decoder, child or OS probe runs.
async function w3bV1(f:import('../fixtures/windows-native.js').WindowsNativeFixture){
  const {NativeJobStore}=await import('../../packages/domain/src/native-jobs.js'),{createNativeResult}=await import('../../packages/native/src/dto.js'),{windowsFrameLimits}=await import('../fixtures/windows-native.js');
  await f.request();const execution=await f.prepareExecution();await f.seedBasis(execution.input);const original=await f.originalIntent(execution);
  const profile={kind:'OWNED_FIXTURE' as const,version:'b05-v1-synthetic',maxSlots:f.profile.maxSlots,nativeProfileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,controllerId:f.profile.controllerId,keyVersion:f.profile.keyVersion,environmentDigest:f.profile.environmentDigest,publicKeySpki:f.profile.publicKeySpki,evidenceRefs:['owned-fixture:b05/v1/raw']};
  const profileId=randomUUID(),profileDigest=(await f.operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0].profile_digest;
  await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const capacity={reference:{kind:'OWNED_FIXTURE' as const,profileId,profileDigest,profileVersion:profile.version},profile,sourceInput:original.sourceInput};
  const admission=await new NativeJobStore(f.worker,f.seed.accountId).beforeIntent(original.intent,true,capacity);expect(admission).toMatchObject({allowed:true,reason:'CREATED'});expect(admission.capacityReservationId).toBeTypeOf('string');
  const binding=original.binding(admission.capacityReservationId!),objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('B05_V1_OBJECT_DELETE_FORBIDDEN');}};
  const configuration={controllerId:profile.controllerId,controllerInstanceId:f.controllerInstanceId,input:windowsFrameLimits,output:windowsFrameLimits},store=new NativeControllerStore(f.controllerDb,configuration,objects,f.files.bucket);
  const claimed=await store.claim(f.peer,binding,original.frame.envelope,randomUUID(),f.controllerInstanceId);expect(claimed.created).toBe(true);expect(claimed.attempt.snapshot).not.toHaveProperty('version');
  const ready=await store.ready(f.peer,claimed.attempt),granted=await store.grantGo(f.peer,ready);expect(granted.created).toBe(true);expect(granted.attempt.snapshot.phase).toBe('GO_GRANTED');
  const bytes=Buffer.from(original.frame.blobs.get('source')!),blobs=new Map([['output',bytes]]),frame={envelope:createNativeResult(original.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'output',canonicalPngByteLength:bytes.length},blobs},windowsFrameLimits),blobs};
  const allocation=await store.allocate(f.peer,granted.attempt,frame.envelope);await store.putOriginal(f.peer,allocation,blobs);
  const termination={jobId:binding.jobId,inputDigest:binding.inputDigest,profileDigest:binding.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY' as const};
  const evidence={version:1 as const,jobId:binding.jobId,task:original.frame.envelope.task,inputDigest:binding.inputDigest,profileDigest:binding.profileDigest,isolation:'OWNED_FIXTURE' as const,state:'SUCCEEDED' as const,code:'OK',goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,elapsedMs:0,inputBytes:bytes.length,outputBytes:bytes.length};
  await store.observe(f.peer,granted.attempt,'OBSERVATION',evidence,termination,frame.envelope);await store.observe(f.peer,granted.attempt,'TERMINATION',evidence,termination,null);
  const attempt=await store.load(f.peer,binding);expect(attempt.snapshot).toMatchObject({phase:'GO_GRANTED',rawResult:allocation.reference,termination,code:'OK'});expect(await store.readExisting(f.peer,attempt)).toEqual(frame);expect(f.objectIo.put).toBe(1);
  return {f,binding,store,configuration,objects,frame,attempt,allocation};
}
it.each(['OWNER','WORKSPACE_REVISION'] as const)('W3-B B05 v1 %s drift still reads the original real raw objects and preserves synthetic RESULT TERM history',async kind=>w3bFixture(async f=>{
  const x=await w3bV1(f),history=await w3bHistory(x),io={...f.objectIo};
  if(kind==='OWNER')await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_tab_id=$3,owner_revision=owner_revision+1 WHERE account_id=$1 AND context_id=$2',[x.binding.accountId,f.seed.contextId,randomUUID()]);
  else await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[x.binding.accountId,f.seed.contextId]);
  expect(await x.store.readExisting(f.peer,x.attempt)).toEqual(x.frame);expect(f.objectIo).toEqual({get:io.get+1,put:io.put});expect(await x.store.load(f.peer,x.binding)).toEqual(x.attempt);expect(await w3bHistory(x)).toEqual(history);
  expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.windows_native_origins WHERE account_id=$1',[x.binding.accountId])).rows).toEqual([{n:0}]);
}));
it.each(['SOURCE_RETENTION','RAW_RETENTION','ASSET_IDENTITY','BUCKET'] as const)('W3-B B05 v1 %s still refuses unavailable raw before object GET without replacing original refs',async kind=>w3bFixture(async f=>{
  const x=await w3bV1(f),history=await w3bHistory(x),io={...f.objectIo};
  if(kind==='SOURCE_RETENTION')await f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND asset_id IN(SELECT (dep->>'assetId')::uuid FROM manga_web.native_controller_attempts a CROSS JOIN LATERAL jsonb_array_elements(a.source_asset_dependencies) dep WHERE a.account_id=$1)",[x.binding.accountId]);
  else if(kind==='RAW_RETENTION')await f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=$1)",[x.binding.accountId]);
  else if(kind==='ASSET_IDENTITY')await f.admin.pool.query('UPDATE manga_web.assets SET sha256=$2 WHERE account_id=$1 AND asset_id IN(SELECT asset_id FROM manga_web.native_controller_object_receipts WHERE account_id=$1)',[x.binding.accountId,sha256('b05-v1-raw-drift')]);
  if(kind==='BUCKET')await expect(new NativeControllerStore(f.controllerDb,x.configuration,{...x.objects,bucket:'b05-wrong-bucket'},'b05-wrong-bucket').readExisting(f.peer,x.attempt)).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
  else expect(await x.store.readExisting(f.peer,x.attempt)).toBeNull();
  expect(f.objectIo).toEqual(io);expect(await x.store.load(f.peer,x.binding)).toEqual(x.attempt);expect(await w3bHistory(x)).toEqual(history);
}));

async function w3bCatalog(f:import('../fixtures/windows-native.js').WindowsNativeFixture){
  const functions=(await f.admin.pool.query(`SELECT p.oid::text,p.proname,p.proargtypes::text,p.proowner::text,p.proacl::text,p.proconfig,p.prosecdef,p.provolatile,p.prosrc,
    has_function_privilege('trio_web_controller',p.oid,'EXECUTE') AS controller,has_function_privilege('trio_web_api',p.oid,'EXECUTE') AS api,has_function_privilege('trio_web_worker',p.oid,'EXECUTE') AS worker
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' ORDER BY p.oid`)).rows;
  const relations=(await f.admin.pool.query("SELECT c.oid::text,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' ORDER BY c.oid")).rows;
  const columns=(await f.admin.pool.query("SELECT a.attrelid::text,a.attnum,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='manga_web' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum")).rows;
  const schemas=(await f.admin.pool.query("SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='manga_web'")).rows;
  const memberships=(await f.admin.pool.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows;
  return {functions,relations,columns,schemas,memberships};
}
it('W3-B B05 exact approved 0021 transaction preserves function OID owner ACL search_path definer and every service privilege',async()=>w3bFixture(async f=>{
  const {readFile}=await import('node:fs/promises'),legacy=await readFile(new URL('../../db/migrations/0016_native_controller.sql',import.meta.url),'utf8'),sql=await readFile(new URL('../../db/migrations/0021_windows_raw_authority.sql',import.meta.url),'utf8');
  expect(sha256(sql)).toBe('42f4e5a9131910f8662c2edfbd77dd912d08a88dbdbe0f3ca6aa5367da537e77');
  const raw=legacy.match(/CREATE FUNCTION native_controller_raw_lookup\([\s\S]*?END \$\$;/);expect(raw).not.toBeNull();
  // Restore only this old function in this owned synthetic DB, never a migration file.
  await f.admin.transaction(async client=>{await client.query('SET LOCAL search_path TO manga_web,pg_catalog');await client.query(raw![0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));});
  const before=await w3bCatalog(f),original=before.functions.find(row=>row.proname==='native_controller_raw_lookup');expect(original).toMatchObject({provolatile:'s',prosecdef:true,proconfig:['search_path=pg_catalog, manga_web, pg_temp'],controller:true,api:false,worker:false});
  const metadata=(row:NonNullable<typeof original>)=>({oid:row.oid,owner:row.proowner,acl:row.proacl,searchPath:row.proconfig,securityDefiner:row.prosecdef,volatility:row.provolatile,bodySha256:sha256(row.prosrc)});
  console.info('B05_SQL_META_BEFORE '+JSON.stringify(metadata(original!)));await f.admin.transaction(client=>client.query(sql));
  const after=await w3bCatalog(f),replaced=after.functions.find(row=>row.proname==='native_controller_raw_lookup');expect(replaced?.provolatile).toBe('v');
  expect({...after,functions:after.functions.map(row=>row.oid===original!.oid?{...row,provolatile:original!.provolatile,prosrc:original!.prosrc}:row)}).toEqual(before);
  console.info('B05_SQL_META_AFTER '+JSON.stringify(metadata(replaced!)));await f.controllerDb.validate();await f.api.validateServiceRole();await f.worker.validateServiceRole();
  for(const db of [f.api,f.worker])await expect(db.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT manga_web.native_controller_raw_lookup(NULL::jsonb,NULL::uuid,NULL::text,NULL::text)'))).rejects.toMatchObject({code:'42501'});
  await expect(f.controller.client.query('SELECT manga_web.windows_native_owner_current(NULL::jsonb)')).rejects.toMatchObject({code:'42501'});expect(f.objectIo).toEqual({get:0,put:0});
}));

vi.hoisted(()=>{if(process.env.TRIO_TEST_NAME_PATTERN?.startsWith('^W4-B1 '))vi.doMock('sharp',()=>({default:()=>{throw new Error('W4B1_SHARP_FORBIDDEN');}}));});
it('W4-B1 unscoped legacy admission after enrollment cannot create job reservation or GO',async()=>{
 const {guardWindowsNativeIo,windowsNativeFixture,prepareWindowsCostedTarget}=await import('../fixtures/windows-native.js'),guard=guardWindowsNativeIo();let f:import('../fixtures/windows-native.js').WindowsNativeFixture|undefined;
 try{
  f=await windowsNativeFixture();const x=await prepareWindowsCostedTarget(f),original=await f.originalIntent(x.execution),account=f.seed.accountId;
  const decision=await f.worker.accountTransaction(account,async tx=>(await tx.client.query('SELECT manga_web.native_capacity_create_intent($1::jsonb,true,$2::jsonb) AS decision',[JSON.stringify(original.intent),JSON.stringify({...x.capacity,sourceInput:original.sourceInput})])).rows[0].decision);
  expect(decision).toMatchObject({allowed:false,reason:'WINDOWS_NATIVE_COST_SCOPE_REQUIRED'});
  expect((await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS jobs,(SELECT count(*)::integer FROM manga_web.native_capacity_reservations WHERE account_id=$1) AS reservations,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go`,[account])).rows[0]).toEqual({jobs:0,reservations:0,go:0});expect(f.objectIo).toEqual({get:0,put:0});
 }finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});
