import {expect,vi} from 'vitest';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {lstat,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type {Database} from '../../packages/storage/src/database.js';
import {NativeControllerDatabase} from '../../packages/storage/src/native-controller-role.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {FileObjectStore,type ObjectReceipt,type ObjectStore} from '../../packages/storage/src/objects.js';
import {NativeControllerStore} from '../../packages/domain/src/native-controller-store.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent} from '../../packages/domain/src/native-jobs.js';
import type {NativeCapacityConfiguration,OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';
import type {NativeControllerPeer,NativeControllerPeerVerifier,NativeOriginalAttempt} from '../../packages/native/src/controller-attempts.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import {createNativeJob,createNativeResult,type NativeFrameLimits,type NativeJobEvidence,type NativeTermination} from '../../packages/native/src/dto.js';
import {nativeKernelImplementationDigest} from '../../packages/native/src/identity.js';
import {decodeImage} from '../../packages/media/src/images.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {seedIdentity,seedWorkspace,testDatabase} from './database.js';
import {ownedNativePng,ownedNativePngSha256} from './native-images.js';

export const controllerFrameLimits:NativeFrameLimits={maxMetadataBytes:64*1024,maxBinaryBytes:1024*1024,maxItems:8};
export const controllerPrivateTables=['native_controller_attempts','native_controller_events','native_controller_go_grants','native_controller_raw_results','native_controller_object_receipts'] as const;
type Workspace=Awaited<ReturnType<typeof seedWorkspace>>;
type ControllerLogin={database:NativeControllerDatabase;client:pg.Client;loginRole:string;connectionString:string;instanceId:string};

// An explicitly owned, out-of-band authentication fixture. No listener, TLS,
// certificate, production identity or wire-supplied peer is established here.
class OwnedControllerPeerVerifier implements NativeControllerPeerVerifier{
  private readonly peers=new WeakMap<object,NativeControllerPeer>();
  bind(peer:NativeControllerPeer):object{const transport=Object.freeze({ownedTransportId:randomUUID()});this.peers.set(transport,Object.freeze({...peer}));return transport;}
  async authenticate(transport:unknown):Promise<NativeControllerPeer>{
    const peer=transport!==null&&typeof transport==='object'?this.peers.get(transport):undefined;
    if(!peer)throw new DomainError('NATIVE_CONTROL_PEER_UNCONFIRMED',409,'WAIT');return {...peer};
  }
}

function ownedObjects(files:FileObjectStore){
  let losePutAck=false;
  const events:{operation:'PUT'|'GET'|'RECEIPT';key:string}[]=[];
  const put=vi.fn(async(key:string,bytes:Buffer):Promise<ObjectReceipt>=>{
    events.push({operation:'PUT',key});const receipt=await files.put(key,bytes);
    if(losePutAck){losePutAck=false;throw new Error('OWNED_CONTROLLER_PUT_ACK_LOST');}return receipt;
  });
  const read=vi.fn(async(key:string)=>{events.push({operation:'GET',key});return files.read(key);});
  const receipt=vi.fn(async(key:string)=>{events.push({operation:'RECEIPT',key});return files.receipt(key);});
  const remove=vi.fn(async(_key:string):Promise<boolean>=>{throw new Error('Deletion is outside this owned controller fixture');});
  const objects:ObjectStore={bucket:files.bucket,put,read,receipt,remove};
  return {objects,events,put,read,receipt,remove,loseNextPutAck:()=>{losePutAck=true;}};
}

type Environment={admin:Database;api:Database;worker:Database;files:FileObjectStore;port:ReturnType<typeof ownedObjects>;profile:OwnedNativeCapacityProfile;capacity:NativeCapacityConfiguration};
export async function seedControllerUpload(environment:Environment,seed?:Workspace,sourceBlobId='source'){
  const {admin,api,files,profile,capacity}=environment;
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  const workspace=seed??await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const source=Buffer.from(ownedNativePng,'base64');expect(sha256(source)).toBe(ownedNativePngSha256);
  // Decode all owned PNG bytes rather than treating a header or an arbitrary
  // base64 specimen as valid output. This remains local synthetic media work.
  const decoded=await decodeImage(source,syntheticProfile);expect(decoded).toMatchObject({width:1,height:1,mediaType:'image/png'});
  const uploadId=randomUUID(),sourceAssetId=randomUUID(),candidateId=randomUUID();
  const capture={contextId:workspace.contextId,contextGeneration:'1',ownerSessionId:workspace.sessionId,ownerTabId:workspace.tabId,ownerRevision:'0',workspaceRevision:'0'};
  const expiry=(await admin.pool.query<{expires_at:Date}>(`INSERT INTO manga_web.uploads(
    account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,
    owner_revision,context_generation,owner_session_id,owner_tab_id,captured_workspace_revision)
    SELECT $1,$2,$3,'PAGE_IMAGES',0,'PREPARED',n,n+interval '1 hour',0,1,$4,$5,0
    FROM(SELECT clock_timestamp() n) sampled RETURNING expires_at`,[workspace.accountId,uploadId,workspace.contextId,workspace.sessionId,workspace.tabId])).rows[0].expires_at;
  const proof=await files.put(`${workspace.accountId}/${sourceAssetId}`,source);
  await admin.transaction(async client=>{
    await client.query(`INSERT INTO manga_web.assets(
      account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,
      related_context_id,object_created_at,access_deadline)
      VALUES($1,$2,'UPLOAD_TEMP',$3,$4,$5,$6,'image/png','NOT_DUE',$7,$8,$9)`,
    [workspace.accountId,sourceAssetId,files.bucket,proof.key,proof.sha256,proof.bytesLength,workspace.contextId,proof.completedAt,expiry]);
    await client.query(`INSERT INTO manga_web.upload_candidates(
      account_id,candidate_id,upload_id,asset_id,protected_display_name_ref,input_ordinal,decode_state,reason_code)
      VALUES($1,$2,$3,$4,'owned-controller-source',0,'PREPARED','OK')`,[workspace.accountId,candidateId,uploadId,sourceAssetId]);
  });
  const inputs=new Map([[sourceBlobId,source]]),job=createNativeJob('DECODE_IMAGE',profile.nativeProfileDigest,{profile:syntheticProfile,sourceBlobId},inputs,controllerFrameLimits);
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,
    operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:'UPLOAD' as const,targetId:uploadId,
    semanticCaptureDigest:digest({kind:'UPLOAD',uploadId,capture}),protectedOwnerCapture:capture,claim:{generation:'0',ownerId:workspace.sessionId,workItemId:null}};
  const intent:NativeJobIntent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},jobs=new NativeJobStore(api,workspace.accountId);
  const admission=await jobs.beforeIntent(intent,true,capacity);expect(admission.allowed).toBe(true);expect(admission.capacityReservationId).toMatch(/^[a-f0-9-]{36}$/);
  const binding:NativeControllerBinding={accountId:workspace.accountId,capacityReservationId:admission.capacityReservationId!,jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:profile.kernelDigest};
  const computation={metadata:{width:decoded.width,height:decoded.height,mediaType:decoded.mediaType,canonicalPngBlobId:'canonical-png',canonicalPngByteLength:decoded.canonicalPng.length},blobs:new Map([['canonical-png',decoded.canonicalPng]])};
  const result=createNativeResult(job,computation,controllerFrameLimits);
  return {seed:workspace,uploadId,sourceAssetId,candidateId,source,inputs,job,intent,binding,computation,result,jobs};
}

export async function nativeControllerFixture(){
  const databases:{close():Promise<void>}[]=[],clients:pg.Client[]=[];let closed=false;
  const close=async()=>{if(closed)return;closed=true;for(const client of clients.reverse())await client.end();for(const db of databases.reverse())await db.close();};
  try{
    const admin=await testDatabase();databases.push(admin);expect((await admin.pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^18\./);
    const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');databases.push(api,worker);
    await api.validateServiceRole();await worker.validateServiceRole();
    const temporaryRoot=tmpdir();expect(path.isAbsolute(temporaryRoot)).toBe(true);const temporaryInfo=await lstat(temporaryRoot);expect(temporaryInfo.isDirectory()).toBe(true);expect(temporaryInfo.isSymbolicLink()).toBe(false);
    const objectRoot=await mkdtemp(path.join(temporaryRoot,'trio-native-controller-'));expect(path.dirname(path.resolve(objectRoot)).toLowerCase()).toBe(path.resolve(temporaryRoot).toLowerCase());
    const objectInfo=await lstat(objectRoot);expect(objectInfo.isDirectory()).toBe(true);expect(objectInfo.isSymbolicLink()).toBe(false);const files=new FileObjectStore(objectRoot,controllerFrameLimits.maxBinaryBytes),port=ownedObjects(files);
    const key=generateKeyPairSync('ed25519');
    const profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'owned-controller-capacity-v1',maxSlots:2,nativeProfileDigest:digest(syntheticProfile),kernelDigest:nativeKernelImplementationDigest(),controllerId:randomUUID(),keyVersion:'owned-controller-key-v1',environmentDigest:sha256('owned-controller-fixture/environment-v1'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:controller/transactions']};
    const profileId=randomUUID(),inserted=(await admin.pool.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(
      profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,
    [profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
    const capacity:NativeCapacityConfiguration={reference:{kind:'OWNED_FIXTURE',profileId,profileDigest:inserted.profile_digest,profileVersion:profile.version},profile};
    await admin.pool.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
    const controllers:ControllerLogin[]=[];
    for(let index=0;index<2;index++){
      const loginRole='trio_native_controller_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('base64url');
      await admin.pool.query(`CREATE ROLE "${loginRole}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await admin.pool.query(`GRANT trio_web_controller TO "${loginRole}"`);
      const url=new URL(admin.connectionString);url.username=loginRole;url.password=password;
      const database=new NativeControllerDatabase(url.toString(),loginRole);databases.push(database);await database.validate();
      const client=new pg.Client({connectionString:url.toString(),options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});await client.connect();clients.push(client);await client.query('SET ROLE trio_web_controller');
      const role=(await client.query<{login:string;service:string;controller:boolean;api:boolean;worker:boolean;operator:boolean}>(`SELECT session_user::text AS login,current_user::text AS service,
        pg_has_role(session_user,'trio_web_controller','MEMBER') AS controller,pg_has_role(session_user,'trio_web_api','MEMBER') AS api,
        pg_has_role(session_user,'trio_web_worker','MEMBER') AS worker,pg_has_role(session_user,'trio_web_operator','MEMBER') AS operator`)).rows[0];
      expect(role).toEqual({login:loginRole,service:'trio_web_controller',controller:true,api:false,worker:false,operator:false});controllers.push({database,client,loginRole,connectionString:url.toString(),instanceId:randomUUID()});
    }
    const operatorLogin='trio_native_operator_'+randomUUID().replaceAll('-',''),operatorPassword=randomBytes(24).toString('base64url');
    await admin.pool.query(`CREATE ROLE "${operatorLogin}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${operatorPassword}'`);await admin.pool.query(`GRANT trio_web_operator TO "${operatorLogin}"`);
    const operatorUrl=new URL(admin.connectionString);operatorUrl.username=operatorLogin;operatorUrl.password=operatorPassword;
    const operator=new pg.Client({connectionString:operatorUrl.toString(),options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});await operator.connect();clients.push(operator);await operator.query('SET ROLE trio_web_operator');
    const verifier=new OwnedControllerPeerVerifier();
    const apiTransport=verifier.bind({serviceRole:'trio_web_api',peerId:randomUUID()}),workerTransport=verifier.bind({serviceRole:'trio_web_worker',peerId:randomUUID()});
    const peer=await verifier.authenticate(apiTransport),workerPeer=await verifier.authenticate(workerTransport);
    const environment={admin,api,worker,files,port,profile,capacity},specimen=await seedControllerUpload(environment);
    const freshStore=(index=0)=>new NativeControllerStore(controllers[index].database,{controllerId:profile.controllerId,controllerInstanceId:controllers[index].instanceId,input:controllerFrameLimits,output:controllerFrameLimits},port.objects,files.bucket);
    return {...environment,...specimen,controllers,operator,verifier,apiTransport,workerTransport,peer,workerPeer,freshStore,store:freshStore(),close};
  }catch(error){await close();throw error;}
}
export type NativeControllerFixture=Awaited<ReturnType<typeof nativeControllerFixture>>;

export function controllerFacts(fixture:NativeControllerFixture,attempt:NativeOriginalAttempt,code='OK'){
  const {job}=attempt;
  const termination:NativeTermination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const evidence:NativeJobEvidence={version:1,jobId:job.jobId,task:job.task,inputDigest:job.inputDigest,profileDigest:job.profileDigest,isolation:'OWNED_FIXTURE',state:code==='OK'?'SUCCEEDED':'UNKNOWN',code,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,elapsedMs:1,inputBytes:fixture.source.length,outputBytes:fixture.computation.blobs.get('canonical-png')!.length};
  return {evidence,termination};
}
