import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {NativeOriginalAttempt,NativeRawAllocation} from '../../packages/native/src/controller-attempts.js';
import {confirmControllerLibraryUserPut,controllerLibraryFacts,controllerLibraryThirtyDays,controllerLibraryUserFacts,
  nativeControllerLibraryFixture,prepareControllerLibraryUserPut,type NativeControllerLibraryFixture} from '../fixtures/native-controller-library.js';

const fixtures:NativeControllerLibraryFixture[]=[];
async function fixture(outputBlobs:1|2=1){const value=await nativeControllerLibraryFixture(outputBlobs);fixtures.push(value);return value;}
afterEach(async()=>{for(const value of fixtures.splice(0).reverse())await value.close();});

async function now(f:NativeControllerLibraryFixture){return (await f.base.admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;}
async function grant(f:NativeControllerLibraryFixture):Promise<NativeOriginalAttempt>{
  const claim=await f.store.claim(f.peer,f.binding,f.job,randomUUID(),f.base.controllers[0].instanceId);expect(claim.created).toBe(true);
  const ready=await f.store.ready(f.peer,claim.attempt);expect(ready.snapshot.phase).toBe('READY');
  const granted=await f.store.grantGo(f.peer,ready);expect(granted.created).toBe(true);expect(granted.attempt.snapshot.phase).toBe('GO_GRANTED');return granted.attempt;
}

type RawAsset={asset_id:string;purpose:string;object_created_at:Date;access_deadline:Date|null;sha256:string;bytes_length:string;related_context_id:string;bucket_ref:string;object_key:string};
async function rawAssets(f:NativeControllerLibraryFixture,allocation:NativeRawAllocation){
  return (await f.base.admin.pool.query<RawAsset>(`SELECT b.asset_id,b.purpose,b.object_created_at,b.access_deadline,b.sha256,b.bytes_length,b.related_context_id,b.bucket_ref,b.object_key
    FROM manga_web.native_controller_object_receipts r JOIN manga_web.assets b USING(account_id,asset_id)
    WHERE r.account_id=$1 AND r.raw_result_id=$2 ORDER BY r.blob_id`,[f.base.seed.accountId,allocation.reference.rawResultId])).rows;
}
async function immutableNativeFacts(f:NativeControllerLibraryFixture){
  const account=f.base.seed.accountId,job=f.job.jobId,db=f.base.admin;
  return {
    intent:(await db.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 AND job_id=$2',[account,job])).rows,
    go:(await db.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1 AND job_id=$2',[account,job])).rows,
    observations:(await db.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 ORDER BY received_at,observation_id',[account,job])).rows,
    attempt:(await db.pool.query('SELECT * FROM manga_web.native_controller_attempts WHERE account_id=$1 AND job_id=$2',[account,job])).rows,
    events:(await db.pool.query(`SELECT e.* FROM manga_web.native_controller_events e JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id)
      WHERE a.account_id=$1 AND a.job_id=$2 ORDER BY e.event_sequence`,[account,job])).rows,
    raw:(await db.pool.query(`SELECT r.* FROM manga_web.native_controller_raw_results r JOIN manga_web.native_controller_attempts a USING(account_id,attempt_id)
      WHERE a.account_id=$1 AND a.job_id=$2`,[account,job])).rows,
    capacity:(await db.pool.query('SELECT * FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND reservation_id=$2',[account,f.binding.capacityReservationId])).rows,
    semanticReceipts:(await db.pool.query('SELECT candidate_id FROM manga_web.native_result_receipts WHERE account_id=$1',[account])).rows,
    releaseProofs:(await db.pool.query('SELECT proof_id FROM manga_web.native_capacity_termination_proofs WHERE account_id=$1',[account])).rows,
    state:await f.jobs.unresolved(f.intent.logicalOperationKey)
  };
}

describe('native controller Library raw retention under actual worker and controller LOGINs',()=>{
  it('a Library expiry confirmed after raw PUT shortens registered raw assets to the original earlier future bound',async()=>{
    const f=await fixture(),sampled=await now(f),userProof=await prepareControllerLibraryUserPut(f,new Date(sampled.valueOf()-86400000));
    expect((await controllerLibraryUserFacts(f)).operation).toMatchObject({state:'ACCEPTED',store_completed_at:null,expires_at:null});
    const attempt=await grant(f),allocation=await f.store.allocate(f.peer,attempt,f.result);
    expect((await f.base.admin.pool.query('SELECT access_deadline FROM manga_web.native_controller_attempts WHERE account_id=$1 AND job_id=$2',[f.base.seed.accountId,f.job.jobId])).rows[0]).toEqual({access_deadline:null});
    await f.store.putOriginal(f.peer,allocation,f.computation.blobs);const beforeAssets=await rawAssets(f,allocation);
    expect(beforeAssets).toHaveLength(1);expect(beforeAssets[0].access_deadline).toEqual(new Date(beforeAssets[0].object_created_at.valueOf()+controllerLibraryThirtyDays));
    await confirmControllerLibraryUserPut(f,userProof);const userBefore=await controllerLibraryUserFacts(f),nativeBefore=await immutableNativeFacts(f);
    const deadline=new Date(Date.parse(userProof.completedAt)+controllerLibraryThirtyDays);
    expect(userBefore.operation).toMatchObject({state:'SUCCEEDED',store_completed_at:new Date(userProof.completedAt),expires_at:deadline});
    expect((await f.base.admin.pool.query<{live:boolean}>('SELECT clock_timestamp()<$1 AS live',[deadline])).rows[0].live).toBe(true);
    expect(beforeAssets[0].access_deadline!.valueOf()).toBeGreaterThan(deadline.valueOf());
    const recovered=f.freshStore(1),loaded=await recovered.load(f.peer,f.binding);
    expect(await recovered.readExisting(f.peer,loaded)).toEqual({envelope:f.result,blobs:f.computation.blobs});
    const afterAssets=await rawAssets(f,allocation);expect(afterAssets).toEqual(beforeAssets.map(asset=>({...asset,access_deadline:deadline})));
    expect(await recovered.readExisting(f.peer,loaded)).toEqual({envelope:f.result,blobs:f.computation.blobs});expect(await rawAssets(f,allocation)).toEqual(afterAssets);
    expect(f.port.put).toHaveBeenCalledTimes(1);expect(f.port.remove).not.toHaveBeenCalled();
    expect(await controllerLibraryUserFacts(f)).toEqual(userBefore);expect(await immutableNativeFacts(f)).toEqual(nativeBefore);
  },20000);

  it('an expired original Library stops raw GET receipt and fresh PUT before I/O while raw UNKNOWN TERM and user attempts remain unchanged',async()=>{
    const f=await fixture(),sampled=await now(f),userProof=await prepareControllerLibraryUserPut(f,new Date(sampled.valueOf()-31*86400000));
    const attempt=await grant(f),allocation=await f.store.allocate(f.peer,attempt,f.result),facts=controllerLibraryFacts(f,attempt);
    await f.store.unknown(f.peer,attempt,'OWNED_LIBRARY_ACK_UNCONFIRMED');
    await f.store.observe(f.peer,attempt,'OBSERVATION',facts.evidence,facts.termination,f.result);await f.store.observe(f.peer,attempt,'TERMINATION',facts.evidence,facts.termination,null);
    await confirmControllerLibraryUserPut(f,userProof);const userBefore=await controllerLibraryUserFacts(f),nativeBefore=await immutableNativeFacts(f);
    expect(userBefore.attempts).toEqual([expect.objectContaining({attempt_id:f.attemptId,ordinal:1,state:'SUCCEEDED'})]);
    expect((await f.base.admin.pool.query<{expired:boolean}>('SELECT clock_timestamp()>=$1 AS expired',[userBefore.operation.expires_at])).rows[0].expired).toBe(true);
    const recovered=f.freshStore(1),loaded=await recovered.load(f.peer,f.binding);
    expect(loaded.snapshot).toMatchObject({phase:'UNKNOWN',code:'OWNED_LIBRARY_ACK_UNCONFIRMED',rawResult:allocation.reference,termination:facts.termination});
    expect(await recovered.readExisting(f.peer,loaded)).toBeNull();
    await expect(f.store.putOriginal(f.peer,allocation,f.computation.blobs)).rejects.toMatchObject({code:'NATIVE_RAW_RESULT_UNCONFIRMED'});
    expect(f.port.events).toEqual([]);for(const spy of [f.port.put,f.port.read,f.port.receipt,f.port.remove])expect(spy).not.toHaveBeenCalled();
    expect(await rawAssets(f,allocation)).toEqual([]);expect(await controllerLibraryUserFacts(f)).toEqual(userBefore);expect(await immutableNativeFacts(f)).toEqual(nativeBefore);
    expect((await recovered.load(f.peer,f.binding)).snapshot).toEqual(loaded.snapshot);
  },20000);

  it('a later registered earlier original PUT receipt shortens only this two-blob raw candidate to first PUT plus thirty days',async()=>{
    const f=await fixture(2),sampled=await now(f),userProof=await prepareControllerLibraryUserPut(f,sampled);
    await confirmControllerLibraryUserPut(f,userProof);const userBefore=await controllerLibraryUserFacts(f);
    const unrelatedBefore=(await f.base.admin.pool.query('SELECT * FROM manga_web.assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY asset_id',[f.base.seed.accountId,[f.operationId,f.sourceAssetId,f.base.sourceAssetId]])).rows;
    expect(unrelatedBefore).toHaveLength(3);
    const attempt=await grant(f),allocation=await f.store.allocate(f.peer,attempt,f.result),later=new Date(sampled.valueOf()-1000),earlier=new Date(sampled.valueOf()-2000);
    const rawBefore=(await f.base.admin.pool.query('SELECT * FROM manga_web.native_controller_raw_results WHERE account_id=$1 AND raw_result_id=$2',[f.base.seed.accountId,allocation.reference.rawResultId])).rows;
    expect(rawBefore[0].blob_refs).toHaveLength(2);f.port.useCompletionTimes(later,earlier);
    let firstRegistered:RawAsset[]=[];
    f.port.onBeforePut(async ordinal=>{if(ordinal===2){firstRegistered=await rawAssets(f,allocation);expect(firstRegistered).toHaveLength(1);expect(firstRegistered[0].access_deadline).toEqual(new Date(later.valueOf()+controllerLibraryThirtyDays));}});
    await f.store.putOriginal(f.peer,allocation,f.computation.blobs);expect(firstRegistered).toHaveLength(1);
    const assets=await rawAssets(f,allocation),deadline=new Date(earlier.valueOf()+controllerLibraryThirtyDays);expect(assets).toHaveLength(2);
    expect(assets.map(asset=>asset.object_created_at)).toEqual([later,earlier]);expect(assets.every(asset=>asset.access_deadline?.valueOf()===deadline.valueOf())).toBe(true);
    expect(assets[0]).toEqual({...firstRegistered[0],access_deadline:deadline});
    expect(f.port.put).toHaveBeenCalledTimes(2);expect(f.port.remove).not.toHaveBeenCalled();
    const nativeBefore=await immutableNativeFacts(f),loaded=await f.freshStore(1).load(f.peer,f.binding);
    expect(await f.freshStore(1).readExisting(f.peer,loaded)).toEqual({envelope:f.result,blobs:f.computation.blobs});expect(await rawAssets(f,allocation)).toEqual(assets);
    expect((await f.base.admin.pool.query('SELECT * FROM manga_web.assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY asset_id',[f.base.seed.accountId,[f.operationId,f.sourceAssetId,f.base.sourceAssetId]])).rows).toEqual(unrelatedBefore);
    expect((await f.base.admin.pool.query('SELECT * FROM manga_web.native_controller_raw_results WHERE account_id=$1 AND raw_result_id=$2',[f.base.seed.accountId,allocation.reference.rawResultId])).rows).toEqual(rawBefore);
    expect(await controllerLibraryUserFacts(f)).toEqual(userBefore);expect(await immutableNativeFacts(f)).toEqual(nativeBefore);expect(f.port.put).toHaveBeenCalledTimes(2);
  },20000);
});
