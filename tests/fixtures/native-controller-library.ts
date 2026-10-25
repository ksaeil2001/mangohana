import {expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {NativeControllerStore} from '../../packages/domain/src/native-controller-store.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent} from '../../packages/domain/src/native-jobs.js';
import {readZip,writeZip} from '../../packages/media/src/zip.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {createNativeJob,createNativeResult,type NativeComputation,type NativeJobEvidence,type NativeTermination} from '../../packages/native/src/dto.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import type {NativeOriginalAttempt} from '../../packages/native/src/controller-attempts.js';
import {validateNativeJob} from '../../packages/native/src/jobs.js';
import {FileObjectStore,type ObjectReceipt,type ObjectStore} from '../../packages/storage/src/objects.js';
import {controllerFrameLimits,nativeControllerFixture,type NativeControllerFixture} from './native-controller.js';

export const controllerLibraryThirtyDays=30*86400000;

async function seedLibraryOriginal(base:NativeControllerFixture){
  const result=(await base.admin.pool.query<{result_id:string;original_asset_id:string}>(
    `SELECT r.result_id,r.original_asset_id FROM manga_web.results r JOIN manga_web.workspace_pages p
      ON p.account_id=r.account_id AND p.current_result_id=r.result_id
      WHERE p.account_id=$1 AND p.context_id=$2 AND p.page_lineage_id=$3`,
    [base.seed.accountId,base.seed.contextId,base.seed.pageIds[0]])).rows[0];
  expect(result).toBeDefined();
  // seedWorkspace's placeholder is made an actual owned PNG dependency without
  // changing the result identity or its captured owner/revision.
  const sourceProof=await base.files.put(`${base.seed.accountId}/${result.original_asset_id}`,base.source);
  const operationId=randomUUID(),workItemId=randomUUID(),workerId=randomUUID(),retryGroupId=randomUUID(),attemptId=randomUUID();
  await base.admin.transaction(async client=>{
    await client.query(`UPDATE manga_web.assets SET bucket_ref=$3,object_key=$4,sha256=$5,bytes_length=$6,
      media_type='image/png',object_created_at=$7 WHERE account_id=$1 AND asset_id=$2`,
    [base.seed.accountId,result.original_asset_id,base.files.bucket,sourceProof.key,sourceProof.sha256,sourceProof.bytesLength,sourceProof.completedAt]);
    await client.query(`INSERT INTO manga_web.library_store_operations(
      account_id,store_operation_id,source_context_id,page_lineage_id,result_id,render_digest,purpose,state,revision,retry_group_id)
      VALUES($1,$2,$3,$4,$5,$6,'LIBRARY_RESULT','ACCEPTED',0,$7)`,
    [base.seed.accountId,operationId,base.seed.contextId,base.seed.pageIds[0],result.result_id,sha256('owned-controller-library-render'),retryGroupId]);
    await client.query(`INSERT INTO manga_web.work_items(
      account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision)
      VALUES($1,$2,'STORE',$3,$4,clock_timestamp(),clock_timestamp()+interval '10 minutes',$5,1,'CLAIMED',0)`,
    [base.seed.accountId,workItemId,sha256(workItemId),JSON.stringify({storeOperationId:operationId,resultId:result.result_id,retryGroupId}),workerId]);
    await client.query(`INSERT INTO manga_web.library_store_attempts(
      account_id,attempt_id,store_operation_id,retry_group_id,ordinal,due_at,state,evidence_ref)
      VALUES($1,$2,$3,$4,1,clock_timestamp(),'STARTED',NULL)`,
    [base.seed.accountId,attemptId,operationId,retryGroupId]);
  });
  return {operationId,workItemId,workerId,retryGroupId,attemptId,resultId:result.result_id,sourceAssetId:result.original_asset_id,sourceProof};
}

function rawObjectPort(base:NativeControllerFixture){
  let completionTimes:Date[]=[],beforePut:((ordinal:number,key:string)=>Promise<void>)|undefined;
  // These are explicit owned storage-clock specimens. They establish neither a
  // production clock nor actual 30-day wall-clock retention evidence.
  const files=new FileObjectStore(base.files.root,controllerFrameLimits.maxBinaryBytes,()=>completionTimes.shift()??new Date());
  const events:{operation:'PUT'|'GET'|'RECEIPT';key:string}[]=[];
  const put=vi.fn(async(key:string,bytes:Buffer):Promise<ObjectReceipt>=>{
    events.push({operation:'PUT',key});await beforePut?.(events.filter(item=>item.operation==='PUT').length,key);return files.put(key,bytes);
  });
  const read=vi.fn(async(key:string)=>{events.push({operation:'GET',key});return files.read(key);});
  const receipt=vi.fn(async(key:string)=>{events.push({operation:'RECEIPT',key});return files.receipt(key);});
  const remove=vi.fn(async(_key:string):Promise<boolean>=>{throw new Error('Deletion is outside the owned Library controller fixture');});
  const objects:ObjectStore={bucket:files.bucket,put,read,receipt,remove};
  return {objects,events,put,read,receipt,remove,
    useCompletionTimes:(...times:Date[])=>{expect(times.every(time=>Number.isFinite(time.valueOf()))).toBe(true);completionTimes=times.map(time=>new Date(time));},
    onBeforePut:(hook:(ordinal:number,key:string)=>Promise<void>)=>{beforePut=hook;}};
}

export async function nativeControllerLibraryFixture(outputBlobs:1|2=1){
  const base=await nativeControllerFixture();
  try{
    const original=await seedLibraryOriginal(base),port=rawObjectPort(base);
    // Both shapes use actual owned ZIP bytes, rather than repeating the base
    // upload's unresolved DECODE_IMAGE operation with cosmetic identifier changes.
    const entries=new Map<string,Buffer>([['original.png',Buffer.from(base.source)]]);
    if(outputBlobs===2)entries.set('second.png',Buffer.from(base.source));
    const archive=await writeZip(entries,syntheticProfile),decoded=await readZip(archive,syntheticProfile);
    expect(decoded).toEqual(entries);expect(decoded.size).toBe(outputBlobs);
    const inputs=new Map<string,Buffer>([['archive',archive]]);
    const job=createNativeJob('ZIP_READ',base.profile.nativeProfileDigest,{profile:syntheticProfile,archiveBlobId:'archive'},inputs,controllerFrameLimits);
    expect(nativeOperationInputDigest(job)).not.toBe(nativeOperationInputDigest(base.job));
    const blobs=new Map<string,Buffer>();
    const outputEntries=[...decoded].map(([name,bytes],index)=>{const blobId=`zip-entry-${index}`;blobs.set(blobId,bytes);return {name,blobId,byteLength:bytes.length};});
    const computation:NativeComputation={metadata:{entries:outputEntries},blobs};
    validateNativeJob({envelope:job,blobs:inputs});
    const capture={contextId:base.seed.contextId,contextGeneration:'1',ownerSessionId:base.seed.sessionId,ownerTabId:base.seed.tabId,ownerRevision:'0',workspaceRevision:'0'};
    const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,
      operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:'LIBRARY' as const,targetId:original.operationId,
      semanticCaptureDigest:digest({kind:'LIBRARY',operationId:original.operationId,resultId:original.resultId}),protectedOwnerCapture:capture,
      claim:{generation:'1',ownerId:original.workerId,workItemId:original.workItemId}};
    const intent:NativeJobIntent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},jobs=new NativeJobStore(base.worker,base.seed.accountId);
    const admission=await jobs.beforeIntent(intent,true,base.capacity);expect(admission.allowed).toBe(true);expect(admission.capacityReservationId).toMatch(/^[a-f0-9-]{36}$/);
    const binding:NativeControllerBinding={accountId:base.seed.accountId,capacityReservationId:admission.capacityReservationId!,jobId:job.jobId,
      parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:base.profile.kernelDigest};
    const result=createNativeResult(job,computation,controllerFrameLimits);
    const freshStore=(index=0)=>new NativeControllerStore(base.controllers[index].database,
      {controllerId:base.profile.controllerId,controllerInstanceId:base.controllers[index].instanceId,input:controllerFrameLimits,output:controllerFrameLimits},port.objects,base.files.bucket);
    return {base,...original,job,inputs,computation,result,intent,binding,jobs,port,freshStore,store:freshStore(),peer:base.workerPeer,close:base.close};
  }catch(error){await base.close();throw error;}
}
export type NativeControllerLibraryFixture=Awaited<ReturnType<typeof nativeControllerLibraryFixture>>;

export async function prepareControllerLibraryUserPut(fixture:NativeControllerLibraryFixture,completedAt:Date):Promise<ObjectReceipt>{
  expect(Number.isFinite(completedAt.valueOf())).toBe(true);
  const files=new FileObjectStore(fixture.base.files.root,controllerFrameLimits.maxBinaryBytes,()=>new Date(completedAt));
  const proof=await files.put(`${fixture.base.seed.accountId}/${fixture.operationId}`,fixture.base.source);
  expect(proof.completedAt).toBe(completedAt.toISOString());return proof;
}

export async function confirmControllerLibraryUserPut(fixture:NativeControllerLibraryFixture,proof:ObjectReceipt){
  const {base}=fixture;
  expect(await base.files.receipt(`${base.seed.accountId}/${fixture.operationId}`)).toEqual(proof);
  expect(await base.files.read(proof.key)).toEqual(base.source);
  await base.admin.transaction(async client=>{
    await client.query(`INSERT INTO manga_web.assets(
      account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,access_deadline)
      VALUES($1,$2,'LIBRARY',$3,$4,$5,$6,'image/png','NOT_DUE',$7,$8,$8::timestamptz+interval '30 days')`,
    [base.seed.accountId,fixture.operationId,base.files.bucket,proof.key,proof.sha256,proof.bytesLength,base.seed.contextId,proof.completedAt]);
    await client.query(`UPDATE manga_web.library_store_operations SET state='SUCCEEDED',asset_id=$2,
      store_completed_at=$3,expires_at=$3::timestamptz+interval '30 days',revision=revision+1
      WHERE account_id=$1 AND store_operation_id=$2`,[base.seed.accountId,fixture.operationId,proof.completedAt]);
    await client.query("UPDATE manga_web.library_store_attempts SET state='SUCCEEDED',evidence_ref=$3 WHERE account_id=$1 AND attempt_id=$2",
      [base.seed.accountId,fixture.attemptId,digest(proof)]);
  });
}

export function controllerLibraryFacts(fixture:NativeControllerLibraryFixture,attempt:NativeOriginalAttempt){
  const {job}=attempt;
  // Explicit state specimens only: this test does not create or terminate a child.
  const termination:NativeTermination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,
    directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const evidence:NativeJobEvidence={version:1,jobId:job.jobId,task:job.task,inputDigest:job.inputDigest,profileDigest:job.profileDigest,isolation:'OWNED_FIXTURE',
    state:'SUCCEEDED',code:'OK',goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,
    elapsedMs:1,inputBytes:[...fixture.inputs.values()].reduce((sum,bytes)=>sum+bytes.length,0),outputBytes:[...fixture.computation.blobs.values()].reduce((sum,bytes)=>sum+bytes.length,0)};
  return {evidence,termination};
}

export async function controllerLibraryUserFacts(fixture:NativeControllerLibraryFixture){
  const {admin,seed}=fixture.base;
  const operation=(await admin.pool.query('SELECT * FROM manga_web.library_store_operations WHERE account_id=$1 AND store_operation_id=$2',[seed.accountId,fixture.operationId])).rows[0];
  const attempts=(await admin.pool.query('SELECT * FROM manga_web.library_store_attempts WHERE account_id=$1 AND store_operation_id=$2 ORDER BY ordinal',[seed.accountId,fixture.operationId])).rows;
  const work=(await admin.pool.query('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[seed.accountId,fixture.workItemId])).rows[0];
  return {operation,attempts,work};
}
