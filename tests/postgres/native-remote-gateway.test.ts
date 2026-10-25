vi.hoisted(()=>{if(process.env.TRIO_TEST_NAME_PATTERN?.startsWith('^W4-B1 '))vi.doMock('sharp',()=>({default:()=>{throw new Error('W4B1_SHARP_FORBIDDEN');}}));});
// W3-C selects only fake Windows ports; block the legacy fixture's native import before evaluation.
vi.hoisted(()=>{if(process.env.TRIO_TEST_NAME_PATTERN?.startsWith('^W3-C '))vi.doMock('sharp',()=>({default:()=>{throw new Error('W3C_SHARP_FORBIDDEN');}}));});
import {describe,expect,it,vi} from 'vitest';
import {randomUUID,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeRemoteController} from '../../packages/native/src/controller-remote.js';
import {NativeControllerAttempts} from '../../packages/native/src/controller-attempts.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {NativeControllerStore} from '../../packages/domain/src/native-controller-store.js';
import {NativeRemoteDatabaseGateway} from '../../packages/domain/src/native-remote-gateway.js';
import {createNativeControllerTlsServer,NativeControllerTlsClient,type NativeControllerTlsBounds,type NativeControllerTlsMaterials} from '../../packages/native/src/controller-tls.js';
import {controllerFrameLimits,nativeControllerFixture,type NativeControllerFixture} from '../fixtures/native-controller.js';
import {seedIdentity,seedWorkspace} from '../fixtures/database.js';

// Actual owned loopback TLS, public fake certificates, controller-only LOGIN,
// PNG child and PostgreSQL records. No operational trust/host/release is opened.
function pem(name:string):Buffer{return readFileSync(new URL(`../fixtures/native-controller-tls-certs/${name}.pem`,import.meta.url));}
function materials(identity:'server'|'api'):NativeControllerTlsMaterials{return {ca:pem('owned-ca-cert'),certificate:pem(identity+'-cert'),privateKey:pem(identity+'-key')};}
function pin(identity:'server'|'api'):string{return sha256(new X509Certificate(pem(identity+'-cert')).raw);}
const transportBounds:NativeControllerTlsBounds={wire:{maxControlBytes:64*1024,input:controllerFrameLimits,output:controllerFrameLimits},deadlineMilliseconds:5000,maxConnections:4,maxInFlightBytes:64*1024*1024,streamHighWaterMarkBytes:4096,transportAllowanceBytes:256*1024,maxTlsMaterialBytes:64*1024,maxPinnedPeers:4};
const nativeOptions={profile:syntheticProfile,limits:{maxMetadataBytes:controllerFrameLimits.maxMetadataBytes,maxInputBytes:controllerFrameLimits.maxBinaryBytes,maxOutputBytes:controllerFrameLimits.maxBinaryBytes,maxItems:controllerFrameLimits.maxItems,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024}};
type Cleanup=()=>Promise<void>;
async function served(f:NativeControllerFixture,index:number,cleanups:Cleanup[]){
  const runner=NativeController.owned(nativeOptions),starts=vi.spyOn(runner,'runCaptured');
  const store=new NativeControllerStore(f.controllers[index].database,{controllerId:f.profile.controllerId,controllerInstanceId:runner.parentInstanceId,input:controllerFrameLimits,output:controllerFrameLimits},f.port.objects,f.files.bucket);
  let coordinator!:NativeControllerAttempts;
  const server=createNativeControllerTlsServer({materials:materials('server'),pinnedPeers:[{certificateSha256:pin('api'),serviceRole:'trio_web_api',peerId:randomUUID()}],bounds:transportBounds},verifier=>{
    coordinator=new NativeControllerAttempts(runner,verifier,store,store,{maxControlBytes:transportBounds.wire.maxControlBytes,goWaitMilliseconds:5000,maxInFlightBytes:8*1024*1024});return coordinator;
  });cleanups.push(()=>server.shutdown());const address=await server.listen({host:'127.0.0.1',port:0});
  const client=new NativeControllerTlsClient({materials:materials('api'),serverCertificateSha256:pin('server'),host:'127.0.0.1',port:address.port,servername:'server.native-controller.test.invalid',bounds:transportBounds});cleanups.push(()=>client.shutdown());
  const exchange=client.exchange.bind(client),exchanges=vi.spyOn(client,'exchange').mockImplementation(async(request,job)=>{
    try{const value=await exchange(request,job);process.stdout.write(JSON.stringify({scope:'owned-remote-tls-facts',command:request.control.command,phase:value.control.snapshot.phase,code:value.control.snapshot.code,hasRaw:Object.hasOwn(value,'rawResult')})+'\n');return value;}
    catch(error){process.stdout.write(JSON.stringify({scope:'owned-remote-tls-facts',command:request.control.command,errorType:error instanceof Error?error.name:'NON_ERROR',code:error instanceof DomainError?error.code:'NON_DOMAIN_ERROR'})+'\n');throw error;}
  });
  const parent=new NativeRemoteController({...nativeOptions,client}),gateway=new NativeRemoteDatabaseGateway(f.api,parent,f.port.objects,f.capacity);
  cleanups.push(async()=>{gateway.stopClaims();await gateway.idle();});return {runner,starts,store,coordinator,server,client,parent,gateway,exchanges};
}
async function count(f:NativeControllerFixture,accountId:string,table:string):Promise<number>{
  if(!['native_controller_attempts','native_job_intents','native_job_go_consumptions','native_controller_raw_results','native_result_receipts','native_capacity_termination_proofs'].includes(table))throw new Error('Owned count table required');
  return (await f.admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[accountId])).rows[0].n;
}
async function closed(f:NativeControllerFixture,cleanups:Cleanup[]):Promise<void>{
  const failures:unknown[]=[];for(const cleanup of cleanups.reverse()){try{await cleanup();}catch(error){failures.push(error);}}try{await f.close();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'OWNED_REMOTE_GATEWAY_CLOSE_UNCONFIRMED');
}
function originalTarget(f:NativeControllerFixture):NativeTarget{return {accountId:f.seed.accountId,targetKind:f.intent.targetKind,targetId:f.intent.targetId,semanticCaptureDigest:f.intent.semanticCaptureDigest,protectedOwnerCapture:structuredClone(f.intent.protectedOwnerCapture),claim:structuredClone(f.intent.claim)};}

async function freshUpload(f:NativeControllerFixture):Promise<NativeTarget>{
  const now=(await f.admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  // A separate owned account avoids replacing the fixture's already admitted,
  // unresolved operation. The original no-repeat guard remains in force.
  const seed=await seedWorkspace(f.admin,await seedIdentity(f.admin,now),1,now),uploadId=randomUUID(),assetId=randomUUID(),candidateId=randomUUID();
  const capture={contextId:seed.contextId,contextGeneration:'1',ownerSessionId:seed.sessionId,ownerTabId:seed.tabId,ownerRevision:'0',workspaceRevision:'0'};
  const expiry=(await f.admin.pool.query<{expires_at:Date}>(`INSERT INTO manga_web.uploads(account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,owner_revision,context_generation,owner_session_id,owner_tab_id,captured_workspace_revision)
    SELECT $1,$2,$3,'PAGE_IMAGES',0,'PREPARED',n,n+interval '1 hour',0,1,$4,$5,0 FROM(SELECT clock_timestamp() n) sampled RETURNING expires_at`,[seed.accountId,uploadId,seed.contextId,seed.sessionId,seed.tabId])).rows[0].expires_at;
  const proof=await f.files.put(`${seed.accountId}/${assetId}`,f.source);
  await f.admin.transaction(async client=>{
    await client.query(`INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,access_deadline)
      VALUES($1,$2,'UPLOAD_TEMP',$3,$4,$5,$6,'image/png','NOT_DUE',$7,$8,$9)`,[seed.accountId,assetId,f.files.bucket,proof.key,proof.sha256,proof.bytesLength,seed.contextId,proof.completedAt,expiry]);
    await client.query(`INSERT INTO manga_web.upload_candidates(account_id,candidate_id,upload_id,asset_id,protected_display_name_ref,input_ordinal,decode_state,reason_code)
      VALUES($1,$2,$3,$4,'owned-remote-source',0,'PREPARED','OK')`,[seed.accountId,candidateId,uploadId,assetId]);
  });
  return {accountId:seed.accountId,targetKind:'UPLOAD',targetId:uploadId,semanticCaptureDigest:digest({kind:'UPLOAD',uploadId,capture}),protectedOwnerCapture:capture,claim:{generation:'0',ownerId:seed.sessionId,workItemId:null}};
}

describe('actual remote facade original DB attestation and semantic receipt',()=>{
  it('admits once and reopens a fully checked receipt in a new parent without another child GO or PUT',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-remote-facade-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');
    const f=await nativeControllerFixture(),cleanups:Cleanup[]=[];trace('FIXTURE_READY');
    try{
      const target=await freshUpload(f),first=await served(f,0,cleanups),decoded=await first.gateway.forTarget(target).decodeImage(f.source,syntheticProfile);trace('FACADE_RECEIPT_SEALED');
      expect(decoded).toEqual({width:1,height:1,mediaType:'image/png',canonicalPng:f.computation.blobs.get('canonical-png')});
      expect(first.starts).toHaveBeenCalledTimes(1);expect(f.port.put).toHaveBeenCalledTimes(2);
      for(const table of ['native_job_intents','native_controller_attempts','native_job_go_consumptions','native_controller_raw_results','native_result_receipts'])expect(await count(f,target.accountId,table)).toBe(1);
      const reference=(await f.admin.pool.query<{same_result:boolean;same_parent:boolean;valid_digest:boolean}>(`SELECT c.result_observation_id=o.observation_id AS same_result,c.parent_instance_id=o.parent_instance_id AS same_parent,
        c.protected_candidate->>'resultObservationDigest'=o.observation_digest AND o.observation_digest=encode(sha256(convert_to(o.protected_observation::text,'UTF8')),'hex') AS valid_digest
        FROM manga_web.native_result_candidates c JOIN manga_web.native_job_observations o ON o.account_id=c.account_id AND o.observation_id=c.result_observation_id
        WHERE c.account_id=$1 AND o.event='RESULT'`,[target.accountId])).rows;expect(reference).toEqual([{same_result:true,same_parent:true,valid_digest:true}]);
      first.gateway.stopClaims();await first.gateway.idle();await first.server.shutdown();
      const second=await served(f,1,cleanups),reads=f.port.read.mock.calls.length;trace('NEW_PARENT_READY');
      expect(second.parent.parentInstanceId).not.toBe(first.parent.parentInstanceId);
      expect(await second.gateway.forTarget(target).decodeImage(f.source,syntheticProfile)).toEqual(decoded);
      expect(second.starts).not.toHaveBeenCalled();expect(second.exchanges).not.toHaveBeenCalled();expect(f.port.put).toHaveBeenCalledTimes(2);expect(f.port.read.mock.calls.length).toBeGreaterThan(reads);
      expect(await count(f,target.accountId,'native_job_go_consumptions')).toBe(1);expect(await count(f,target.accountId,'native_capacity_termination_proofs')).toBe(0);
      expect((await f.admin.pool.query<{state:string}>('SELECT state FROM manga_web.native_capacity_reservations WHERE account_id=$1',[target.accountId])).rows).toEqual([{state:'HELD'}]);
      trace('ORIGINAL_VERIFIED_RECEIPT_REOPENED');
    }finally{await closed(f,cleanups);trace('ALL_OWNED_IO_JOINED');}
  });
  it('recovers only original raw facts after parent recreation and rejects a crossed owning intent before TLS',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-remote-original-pg',stage,elapsedMs:Date.now()-began})+'\n');trace('FIXTURE_BEGIN');
    const f=await nativeControllerFixture(),cleanups:Cleanup[]=[];trace('FIXTURE_READY');
    try{
      const first=await served(f,0,cleanups),ready=await first.client.exchange({control:{version:1,requestId:randomUUID(),binding:f.binding,command:'PREPARE'},input:{envelope:f.job,blobs:f.inputs}});
      await first.client.exchange({control:{version:1,requestId:randomUUID(),binding:f.binding,command:'GO',attemptId:ready.control.snapshot.attemptId,controllerInstanceId:ready.control.snapshot.controllerInstanceId}});
      await first.coordinator.idle();trace('ORIGINAL_CHILD_JOINED');expect(first.starts).toHaveBeenCalledTimes(1);expect(f.port.put).toHaveBeenCalledTimes(1);
      first.gateway.stopClaims();await first.gateway.idle();await first.server.shutdown();
      const second=await served(f,1,cleanups),target=originalTarget(f);
      await expect(second.gateway.queryOriginal({...target,targetId:randomUUID()},f.job,f.binding)).rejects.toMatchObject({code:'NATIVE_INTENT_UNCONFIRMED'});expect(second.exchanges).not.toHaveBeenCalled();
      const recovered=await second.gateway.queryOriginal(target,f.job,f.binding);trace('ORIGINAL_DB_FACTS_ATTESTED');
      expect(recovered.computation).toEqual(f.computation);expect(recovered.produced).toMatchObject({intent:f.intent,job:f.job,result:f.result,termination:{kind:'DIRECT_CHILD_ONLY',operationJoined:true,subtreeTerminationConfirmed:false}});
      expect(second.parent.parentInstanceId).not.toBe(f.binding.parentInstanceId);expect(recovered.produced.intent.parentInstanceId).toBe(f.binding.parentInstanceId);
      const observations=(await f.admin.pool.query<{observation_id:string;observation_digest:string}>('SELECT observation_id,observation_digest FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND event=\'RESULT\'',[f.seed.accountId,f.job.jobId])).rows;
      expect(observations).toEqual([{observation_id:recovered.produced.resultObservationId,observation_digest:recovered.produced.resultObservationDigest}]);
      // This explicit recovery returns a raw candidate; the facade still owes
      // the same full semantic checks. It has no semantic receipt authority.
      const checked=await new NativeFacade({run:async()=>recovered.computation}).decodeImage(f.source,syntheticProfile);expect(checked.canonicalPng).toEqual(f.computation.blobs.get('canonical-png'));
      expect(second.exchanges.mock.calls.map(([request])=>request.control.command)).toEqual(['QUERY']);expect(second.starts).not.toHaveBeenCalled();expect(f.port.put).toHaveBeenCalledTimes(1);
      expect(await count(f,f.seed.accountId,'native_result_receipts')).toBe(0);expect(await count(f,f.seed.accountId,'native_job_go_consumptions')).toBe(1);expect(await count(f,f.seed.accountId,'native_capacity_termination_proofs')).toBe(0);
      expect((await f.admin.pool.query<{state:string}>('SELECT state FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,f.binding.capacityReservationId])).rows[0].state).toBe('HELD');
      trace('NO_NEW_COMPUTATION_OR_AUTHORITY');
    }finally{await closed(f,cleanups);trace('ALL_OWNED_IO_JOINED');}
  });
});

// W3-C uses synthetic Windows observations, real service LOGINs, and a fresh loopback database.
it('W3-C Windows gateway factory is required after owning INPUT and BASIS are prepared',async()=>{
  const {guardWindowsNativeIo,windowsNativeFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined;
  try{
    f=await windowsNativeFixture();await f.request();const prepared=await f.prepareExecution();await f.seedBasis(prepared.input);
    const original=await f.originalIntent(prepared);expect(original.inputRecord.evidence_id).toBe(original.sourceInput.inputEvidenceId);
    expect(NativeRemoteDatabaseGateway.windows).toBeTypeOf('function');
  }finally{try{await f?.close();expect(guard.denied).toEqual([]);}finally{guard.restore();}}
});


async function w3cRemote(run:(f:import('../fixtures/windows-native.js').WindowsNativeFixture,x:Awaited<ReturnType<typeof import('../fixtures/windows-native.js')['createWindowsRemoteFixture']>>)=>Promise<void>,options:Parameters<typeof import('../fixtures/windows-native.js')['createWindowsRemoteFixture']>[1]={}){
  const {guardWindowsNativeIo,windowsNativeFixture,createWindowsRemoteFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined,x:Awaited<ReturnType<typeof createWindowsRemoteFixture>>|undefined;
  const errors:unknown[]=[];try{f=await windowsNativeFixture();x=await createWindowsRemoteFixture(f,options);await run(f,x);}catch(error){errors.push(error);}
  finally{try{await x?.close();}catch(error){errors.push(error);}try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W3C_OPERATION_AND_CLEANUP_FAILED');
}
async function w3cCounts(f:import('../fixtures/windows-native.js').WindowsNativeFixture){
  return (await f.admin.pool.query(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_job_intents) AS intents,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) AS go,
    (SELECT count(*)::integer FROM manga_web.native_result_candidates) AS candidates,
    (SELECT count(*)::integer FROM manga_web.native_result_receipts) AS receipts,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='ERROR') AS errors,
    (SELECT count(*)::integer FROM manga_web.windows_native_links) AS links`)).rows[0];
}

it('W3-C fresh framed Windows result is attested checked and sealed then CACHE keeps the original job',async()=>w3cRemote(async(f,x)=>{
  const facade=x.gateway.forTarget(x.target),decoded=await facade.decodeImage(x.source,syntheticProfile);
  expect(decoded).toMatchObject({width:1,height:1,mediaType:'image/png',canonicalPng:x.source});
  expect(await w3cCounts(f)).toEqual({intents:1,go:1,candidates:1,receipts:1,errors:0,links:1});
  expect(f.objectIo.put).toBe(2);expect(x.host?.captures).toHaveLength(1);expect(x.host?.receivedParentAcks).toHaveLength(1);
  const native=await import('../../packages/domain/src/native-receipts.js');
  const sealed=(facade.semanticCache as import('../../packages/domain/src/native-receipts.js').NativeWindowsReceiptStore).sealedWindowsRecord('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',x.source]]));
  expect(sealed.candidate.version).toBe(2);expect(sealed.receipt.version).toBe(2);expect(Object.keys(sealed.candidate)).toHaveLength(14);expect(Object.keys(sealed.receipt)).toHaveLength(6);
  expect(native.validateNativeReceiptCandidateV2(sealed.candidate,x.parent.frameLimits('output'),x.parent.frameLimits('input')).candidate).toEqual(sealed.candidate);
  const next=x.createParent();expect(next.parent.parentInstanceId).not.toBe(x.parent.parentInstanceId);
  const cached=next.gateway.forTarget(x.target);expect(await cached.decodeImage(x.source,syntheticProfile)).toEqual(decoded);
  const reopened=(cached.semanticCache as import('../../packages/domain/src/native-receipts.js').NativeWindowsReceiptStore).sealedWindowsRecord('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',x.source]]));
  expect(reopened.origin).toBe('CACHE');expect(reopened.candidate).toEqual(sealed.candidate);expect(reopened.intent).toEqual(sealed.intent);
  expect(next.exchange.captures).toEqual([]);expect(f.objectIo.put).toBe(2);expect(await w3cCounts(f)).toEqual({intents:1,go:1,candidates:1,receipts:1,errors:0,links:1});
  expect((await f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations')).rows).toEqual([{state:'HELD'}]);
}));

it('W3-C valid wire with invalid Facade metadata preserves raw Windows facts without semantic or native error writes',async()=>w3cRemote(async(f,x)=>{
  await expect(x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({version:2,termination:{kind:'WINDOWS_JOB_EMPTY'},windowsEvidenceRef:expect.any(Object)});
  expect(await w3cCounts(f)).toEqual({intents:1,go:1,candidates:0,receipts:0,errors:0,links:1});expect(f.objectIo.put).toBe(1);
},{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'wrong',canonicalPngByteLength:68}}));

it('W3-C metadata history preserves original refs after owner drift while raw QUERY performs no new GET',async()=>w3cRemote(async(f,x)=>{
  const facade=x.gateway.forTarget(x.target);await facade.decodeImage(x.source,syntheticProfile);
  const job=x.exchange.captures.find(request=>request.control.command==='PREPARE')!.input!.envelope,binding=x.exchange.captures[0].control.binding;
  const original=await x.gateway.readOriginalMetadata(x.target,job,binding),next=x.createParent();
  await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId]);
  const before={...f.objectIo};expect(await next.gateway.readOriginalMetadata(x.target,job,binding)).toEqual(original);expect(f.objectIo).toEqual(before);
  await expect(next.gateway.queryOriginal(x.target,job,binding)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.objectIo).toEqual(before);
  expect(next.exchange.captures.every(request=>request.control.command==='QUERY')).toBe(true);expect(await w3cCounts(f)).toEqual({intents:1,go:1,candidates:1,receipts:1,errors:0,links:1});
}));

it('W3-C stopClaims rejects new calls on an already acquired Facade and idle does not replay an earlier error',async()=>w3cRemote(async(_f,x)=>{
  const facade=x.gateway.forTarget(x.target);x.gateway.stopClaims();
  await expect(facade.decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
  await x.gateway.idle();await x.gateway.idle();expect(x.exchange.captures).toEqual([]);
}));


function w3cDeferred(){let resolve!:()=>void;const done=new Promise<void>(accept=>{resolve=accept;});return {done,resolve};}
it.each(['CACHE_READ','CACHE_MISS','PUT','READBACK','VERIFY','ATTEST'] as const)('W3-C idle joins whole Facade scope through deferred %s after stopClaims',async boundary=>w3cRemote(async(f,x)=>{
  const facade=x.gateway.forTarget(x.target);
  if(boundary==='CACHE_READ')await facade.decodeImage(x.source,syntheticProfile);
  const entered=w3cDeferred(),release=w3cDeferred();let blocked=false;
  const gate=async()=>{if(blocked)return;blocked=true;entered.resolve();await release.done;};
  const restores:(()=>void)[]=[];
  if(boundary==='CACHE_READ'||boundary==='CACHE_MISS'){
    const cache=facade.semanticCache!,read=cache.read.bind(cache),spy=vi.spyOn(cache,'read').mockImplementation(async(...args)=>{await gate();return read(...args);});restores.push(()=>spy.mockRestore());
  }else if(boundary==='PUT'||boundary==='READBACK'){
    const put=x.objects.put.bind(x.objects),read=x.objects.read.bind(x.objects);
    if(boundary==='PUT'){const spy=vi.spyOn(x.objects,'put').mockImplementation(async(...args)=>{if(f.objectIo.put===1)await gate();return put(...args);});restores.push(()=>spy.mockRestore());}
    else{const spy=vi.spyOn(x.objects,'read').mockImplementation(async(...args)=>{if(f.objectIo.put===2)await gate();return read(...args);});restores.push(()=>spy.mockRestore());}
  }else{
    const transaction=f.worker.accountTransaction.bind(f.worker),spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async(accountId,operation,force)=>transaction(accountId,async tx=>{
      const query=tx.client.query;
      tx.client.query=(async(...args:Parameters<typeof query>)=>{const sql=String(args[0]);if(sql.includes(boundary==='VERIFY'?'native_receipt_verify':'windows_native_lookup'))await gate();return Reflect.apply(query,tx.client,args);}) as typeof query;
      try{return await operation(tx);}finally{tx.client.query=query;}
    },force));restores.push(()=>spy.mockRestore());
  }
  const running=facade.decodeImage(x.source,syntheticProfile);void running.catch(()=>{});let idle:Promise<void>|undefined;
  try{
    await Promise.race([entered.done,running.then(()=>{throw new Error('W3C_BOUNDARY_NOT_REACHED');},error=>{throw error;})]);
    x.gateway.stopClaims();let settled=false;idle=x.gateway.idle().then(()=>{settled=true;});
    await new Promise<void>(accept=>setImmediate(accept));expect(settled).toBe(false);
    await expect(facade.decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
    release.resolve();if(boundary==='ATTEST')await expect(running).rejects.toMatchObject({version:2,code:'NATIVE_SHUTDOWN_WAIT',windowsEvidenceRef:expect.any(Object)});else if(boundary==='CACHE_MISS')await expect(running).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});else expect(await running).toMatchObject({width:1,height:1});await idle;expect(settled).toBe(true);
    await x.gateway.idle();expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:boundary==='CACHE_MISS'?0:1}]);
  }finally{release.resolve();await Promise.allSettled([running,...(idle?[idle]:[])]);for(const restore of restores.reverse())restore();}
}));

it('W3-C a failed semantic call is returned once and later idle can finish normally',async()=>w3cRemote(async(_f,x)=>{
  await expect(x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({version:2});
  x.gateway.stopClaims();await x.gateway.idle();await x.gateway.idle();
},{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'wrong',canonicalPngByteLength:68}}));


it.each(['RAW','METADATA'] as const)('W3-C reentrant idle at first %s DB entry cannot miss the original lookup',async mode=>w3cRemote(async(f,x)=>{
  const entered=w3cDeferred(),release=w3cDeferred(),transaction=f.worker.accountTransaction.bind(f.worker);let joining:Promise<void>|undefined,joined=false;
  const hook=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async(accountId,operation,force)=>{
    joining=x.gateway.idle().then(()=>{joined=true;});entered.resolve();await release.done;return transaction(accountId,operation,force);
  });
  const job=x.original.frame.envelope,binding={accountId:x.target.accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:x.original.intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:x.parent.kernelImplementationDigest};
  const running=mode==='RAW'?x.gateway.queryOriginal(x.target,job,binding):x.gateway.readOriginalMetadata(x.target,job,binding);void running.catch(()=>{});
  try{await entered.done;await new Promise<void>(accept=>setImmediate(accept));expect(joined).toBe(false);release.resolve();await expect(running).rejects.toMatchObject({code:'NATIVE_INTENT_UNCONFIRMED'});await joining;}
  finally{release.resolve();await Promise.allSettled([running,...(joining?[joining]:[])]);hook.mockRestore();}
  expect(x.exchange.captures).toEqual([]);
}));


it('W3-C concurrent same operation preserves exactly one attested source despite the refused admission',async()=>w3cRemote(async(f,x)=>{
  const facade=x.gateway.forTarget(x.target),outcomes=await Promise.allSettled([facade.decodeImage(x.source,syntheticProfile),facade.decodeImage(x.source,syntheticProfile)]);
  expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(value=>value.status==='rejected')).toHaveLength(1);
  expect(await w3cCounts(f)).toEqual({intents:1,go:1,candidates:1,receipts:1,errors:0,links:1});expect(f.objectIo.put).toBe(2);
}));
it('W3-C withHooks returned Facade and exposed cache runner respect a later stop',async()=>w3cRemote(async(_f,x)=>{
  const facade=x.gateway.forTarget(x.target),next=facade.withHooks(facade.hooks!);x.gateway.stopClaims();
  await expect(next.decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
  await expect(facade.runner.run('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',x.source]]))).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
  await expect(facade.semanticCache!.read('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',x.source]]))).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
  expect(x.exchange.captures).toEqual([]);await x.gateway.idle();
}));
it('W3-C memory exchange refuses insufficient H before codec copies or server IO',async()=>w3cRemote(async(_f,x)=>{
  const {createNativeControllerMemory}=await import('../../packages/native/src/controller-attempts.js'),{createWindowsNativeExchange,windowsFrameLimits}=await import('../fixtures/windows-native.js');
  const memory=createNativeControllerMemory(1),resolveCoordinator=vi.fn(async()=>{throw new Error('W3C_MUST_NOT_RESOLVE_SERVER');});
  const exchange=createWindowsNativeExchange({resolveCoordinator,transport:{},bounds:{maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},memory}),job=x.original.frame.envelope;
  const binding={accountId:x.target.accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:x.original.intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:x.parent.kernelImplementationDigest};
  await expect(exchange.client.exchange({control:{version:2,command:'PREPARE',requestId:randomUUID(),binding},input:x.original.frame},job)).rejects.toMatchObject({code:'NATIVE_CONTROL_CAPACITY_WAIT'});
  expect(resolveCoordinator).not.toHaveBeenCalled();expect(exchange.captures).toEqual([]);expect(memory.available()).toBe(1);await exchange.client.shutdown();
}));


it.each(['INPUT_WRITE','OUTPUT_WRITE','INPUT_SOURCE_END','OUTPUT_SOURCE_END','WRITE_ERROR','PARTIAL_RESPONSE','BAD_FRAME','BAD_FRAME_CLOSE_ERROR'] as const)('W3-C C07 actual codec %s retains H and R until writer and source cleanup join',async boundary=>w3cRemote(async(f,x)=>{
  await x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile);
  const first=x.exchange.captures.find(request=>request.control.command==='PREPARE')!,job=first.input!.envelope,binding=first.control.binding,ioBefore={...f.objectIo};
  const {createWindowsNativeExchange,windowsNativeLimits,windowsFrameLimits}=await import('../fixtures/windows-native.js'),{createNativeControllerMemory}=await import('../../packages/native/src/controller-attempts.js');
  const entered=w3cDeferred(),release=w3cDeferred(),closeFailure=new Error('W3C_SOURCE_CLOSE_FAILED');let blocked=false;
  const gate=async()=>{if(!blocked){blocked=true;entered.resolve();await release.done;}};
  const io={beforeWrite:async(direction:'input'|'output')=>{
    if((boundary==='INPUT_WRITE'||boundary==='WRITE_ERROR')&&direction==='input'){await gate();if(boundary==='WRITE_ERROR')throw new Error('W3C_WRITER_CALLBACK_FAILED');}
    if(boundary==='OUTPUT_WRITE'&&direction==='output')await gate();
  },beforeSourceEnd:async(direction:'input'|'output')=>{
    if(boundary==='INPUT_SOURCE_END'&&direction==='input')await gate();
    if(['OUTPUT_SOURCE_END','PARTIAL_RESPONSE','BAD_FRAME','BAD_FRAME_CLOSE_ERROR'].includes(boundary)&&direction==='output'){await gate();if(boundary==='BAD_FRAME_CLOSE_ERROR')throw closeFailure;}
  },...(['PARTIAL_RESPONSE','BAD_FRAME','BAD_FRAME_CLOSE_ERROR'].includes(boundary)?{responseFault:boundary==='PARTIAL_RESPONSE'?'PARTIAL' as const:'BAD_MAGIC' as const}:{})};
  const memory=createNativeControllerMemory(4194304),exchange=createWindowsNativeExchange({resolveCoordinator:async()=>x.coordinator!,transport:x.transport,bounds:{maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},memory,io});
  const transportErrors:unknown[]=[],client={exchange:async(...args:Parameters<typeof exchange.client.exchange>)=>{try{return await exchange.client.exchange(...args);}catch(error){transportErrors.push(error);throw error;}},shutdown:()=>exchange.client.shutdown()};
  const parent=NativeRemoteController.windows({profile:syntheticProfile,limits:{...windowsNativeLimits,timeoutMs:10000},client,windows:{version:2}});
  const port={accountId:x.target.accountId,admit:async()=>{throw new Error('W3C_METADATA_ADMISSION_FORBIDDEN');},attest:async()=>{throw new Error('W3C_METADATA_ATTEST_FORBIDDEN');}};
  const running=parent.readOriginalMetadata(port,job,binding);void running.catch(()=>{});let joining:Promise<void>|undefined;
  try{
    expect(await Promise.race([entered.done.then(()=>'ENTERED'),running.then(()=>'SETTLED',()=>'SETTLED')])).toBe('ENTERED');
    let idleDone=false,shutdownDone=false;const idle=parent.idle().then(()=>{idleDone=true;});joining=parent.shutdown().then(()=>{shutdownDone=true;});
    await new Promise<void>(accept=>setImmediate(accept));expect(idleDone).toBe(false);expect(shutdownDone).toBe(false);expect(exchange.pending()).toBe(1);expect(memory.available()).toBeLessThan(memory.maxBytes);expect(parent.usage().reservedBytes).toBeGreaterThan(0);
    release.resolve();await expect(running).rejects.toMatchObject({version:2});await idle;await joining;
    expect(exchange.pending()).toBe(0);expect(memory.available()).toBe(memory.maxBytes);expect(parent.usage().reservedBytes).toBe(0);expect(f.objectIo).toEqual(ioBefore);
    expect(x.host?.controls.filter(value=>value.command==='GRANT_GO')).toHaveLength(1);
    if(boundary==='BAD_FRAME_CLOSE_ERROR'){expect(transportErrors).toHaveLength(1);expect(transportErrors[0]).toBeInstanceOf(AggregateError);const combined=transportErrors[0] as AggregateError;expect(combined.errors).toHaveLength(2);expect(combined.errors[0]).toMatchObject({code:'NATIVE_CONTROL_INVALID'});expect(combined.errors[1]).toBe(closeFailure);}
  }finally{release.resolve();await Promise.allSettled([running,...(joining?[joining]:[])]);await parent.shutdown();}
}));


import {windowsNativeFixture,guardWindowsNativeIo,createWindowsCostedRemoteFixture,type WindowsNativeFixture} from '../fixtures/windows-native.js';
it('W4-B1 costed remote joins original FRESH through one result query raw attest receipt and scope',async()=>{
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined,x:Awaited<ReturnType<typeof createWindowsCostedRemoteFixture>>|undefined;
 try{
  f=await windowsNativeFixture();x=await createWindowsCostedRemoteFixture(f);
  const result=await x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile);expect(result).toMatchObject({width:1,height:1,mediaType:'image/png'});
  const counts=(await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS jobs,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,(SELECT count(*)::integer FROM manga_web.native_result_receipts WHERE account_id=$1) AS receipts,(SELECT count(*)::integer FROM manga_web.windows_native_cost_scope_ends WHERE account_id=$1) AS joined,(SELECT count(*)::integer FROM manga_web.cost_items WHERE account_id=$1 AND component='STAGE_TOTAL' AND state='CONFIRMED') AS totals`,[f.seed.accountId])).rows[0];
  expect(counts).toEqual({jobs:1,go:1,receipts:1,joined:1,totals:0});
  expect(x.exchange.captures.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(1);expect(x.exchange.captures.some(r=>r.control.command==='QUERY'&&!r.control.includeRawResult)).toBe(true);expect(x.host?.failures).toEqual([]);
 }catch(error){const fault=error as {code?:string;version?:number;nextAction?:string;termination?:{kind?:string};cause?:{code?:string}};console.info(JSON.stringify({scope:'w4b1-original-failure',code:fault.code??'NON_DOMAIN_ERROR',version:fault.version??null,nextAction:fault.nextAction??null,termination:fault.termination?.kind??null,cause:fault.cause?.code??null,diagnostics:x?.diagnostics,hostFailures:x?.host?.failures.map(error=>error instanceof Error?error.message:String(error)),hostControls:x?.host?.controls.map(value=>value.command)}));throw error;}
 finally{const failures:unknown[]=[];try{try{await x?.close();}catch(error){failures.push(error);}try{await f?.close();}catch(error){failures.push(error);}expect(guard.denied).toEqual([]);}finally{guard.restore();}if(failures.length)throw new AggregateError(failures,'W4B1_FIXTURE_CLEANUP_UNCONFIRMED');}
});


import pg from 'pg';
import type {NativeControllerRequestV2} from '../../packages/native/src/controller-protocol.js';
type W4BRemote=Awaited<ReturnType<typeof createWindowsCostedRemoteFixture>>;
async function w4bRemoteCase(run:(f:WindowsNativeFixture,x:W4BRemote)=>Promise<void>,options:Parameters<typeof createWindowsCostedRemoteFixture>[1]={},setup?:(f:WindowsNativeFixture)=>void){
 const guard=guardWindowsNativeIo(),failures:unknown[]=[];let f:WindowsNativeFixture|undefined,x:W4BRemote|undefined;
 try{f=await windowsNativeFixture();setup?.(f);x=await createWindowsCostedRemoteFixture(f,options);await run(f,x);}catch(error){failures.push(error);console.info(JSON.stringify({scope:'w4b1-case-failure',message:error instanceof Error?error.message:String(error),diagnostics:x?.diagnostics}));}
 finally{try{try{await x?.close();}catch(error){failures.push(error);}try{await f?.close();}catch(error){failures.push(error);}expect(guard.denied).toEqual([]);}finally{guard.restore();}}
 if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'W4B1_CASE_AND_CLEANUP_FAILED');
}
function w4bLoseWorkerCommitAck(f:WindowsNativeFixture,needle:string){
 const transaction=f.worker.accountTransaction.bind(f.worker);let lost=false,commits=0;
 f.worker.accountTransaction=async(accountId,run,restricted)=>{
  let selected=false;const result=await transaction(accountId,tx=>run({...tx,client:new Proxy(tx.client,{get(target,key,receiver){if(key!=='query')return Reflect.get(target,key,receiver);return(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes(needle))selected=true;return Reflect.apply(target.query,target,args);};}})}),restricted);
  if(selected){commits++;if(!lost){lost=true;throw new Error('W4B1_REAL_COMMIT_ACK_LOST');}}return result;
 };
 return {get lost(){return lost;},get commits(){return commits;}};
}
async function w4bFreshCounts(f:WindowsNativeFixture){return (await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) jobs,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1) grants,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_claims WHERE account_id=$1) claims,(SELECT count(*)::integer FROM manga_web.windows_native_cost_result_acks WHERE account_id=$1) acks,(SELECT count(*)::integer FROM manga_web.windows_native_cost_scope_ends WHERE account_id=$1) joined,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts s LEFT JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE s.account_id=$1 AND e.operation_id IS NULL) pending`,[f.seed.accountId])).rows[0];}
it.each(['begin','register_call','admit','join','io_begin','io_end','authorize_result_query','finish_result_query'] as const)('W4-B1 actual %s COMMIT ACK recovery retains original request and no extra GO',async boundary=>{
 let injection:ReturnType<typeof w4bLoseWorkerCommitAck>;
 await w4bRemoteCase(async(f,x)=>{
  expect(await x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
  expect(injection.lost).toBe(true);expect(injection.commits).toBeGreaterThanOrEqual(1);expect(await w4bFreshCounts(f)).toEqual({jobs:1,go:1,grants:1,claims:1,acks:1,joined:1,pending:0});expect(x.exchange.captures.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(1);expect(f.objectIo.put).toBe(2);
 },{},f=>{injection=w4bLoseWorkerCommitAck(f,'windows_native_cost_'+boundary+'(');});
});
it.each(['begin','end'] as const)('W4-B1 controller IO %s COMMIT ACK recovery keeps original actual START END and PUT',async boundary=>w4bRemoteCase(async(f,x)=>{
 f.loseNextDecision('windows_native_cost_controller_io_'+boundary);expect(await x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
 expect(await w4bFreshCounts(f)).toEqual({jobs:1,go:1,grants:1,claims:1,acks:1,joined:1,pending:0});expect(f.objectIo.put).toBe(2);
 const rows=(await f.admin.pool.query(`SELECT s.operation_id,s.event_id,s.evidence_id AS start_id,e.evidence_id AS end_id,s.protected_request,e.protected_event FROM manga_web.windows_native_cost_io_starts s JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE s.account_id=$1 AND s.principal='trio_web_controller'`,[f.seed.accountId])).rows;
 expect(rows).toHaveLength(4);expect(new Set(rows.flatMap(row=>[row.start_id,row.end_id])).size).toBe(8);for(const row of rows){expect(row.protected_event.operationId).toBe(row.operation_id);expect(row.protected_event.eventId).toBe(row.event_id);expect(row.protected_event.state).toBe('RETURNED');}expect(x.host?.failures).toEqual([]);
}));
it('W4-B1 replay unscoped and altered raw QUERY after JOINED performs zero new GET',async()=>w4bRemoteCase(async(f,x)=>{
 await x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile);
 const original=x.exchange.captures.find(r=>r.control.command==='QUERY'&&r.control.includeRawResult)!,job=x.exchange.captures.find(r=>r.control.command==='PREPARE')!.input!.envelope,before={...f.objectIo},rows=await w4bFreshCounts(f);
 const requests=[original,{control:{...original.control,requestId:randomUUID()}},{control:{...original.control,requestId:randomUUID(),binding:{...original.control.binding,parentInstanceId:randomUUID()}}}];
 for(const request of requests){const result=await x.exchange.client.exchange(request as NativeControllerRequestV2,job).catch(()=>null);expect(result?.rawResult??null).toBeNull();expect(f.objectIo).toEqual(before);}
 expect(await w4bFreshCounts(f)).toEqual(rows);
}));
it('W4-B1 pending original grant refuses replacement and two real delivery claims serialize with loser GET zero',async()=>{
 const entered=w3cDeferred(),release=w3cDeferred();let originalRequest:NativeControllerRequestV2|undefined;
 await w4bRemoteCase(async(f,x)=>{
  const running=x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile);void running.catch(()=>{});
  try{
   expect(await Promise.race([entered.done.then(()=>'ENTERED'),running.then(()=>'SETTLED',()=>'SETTLED')])).toBe('ENTERED');
   const request=originalRequest!,control=request.control,before={...f.objectIo},q=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_result_queries WHERE account_id=$1',[f.seed.accountId])).rows[0],call=(await f.admin.pool.query('SELECT protected_call FROM manga_web.windows_native_cost_calls WHERE call_id=$1',[q.call_id])).rows[0].protected_call;
   expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,call,{control:{...control,requestId:randomUUID()}}))).toBeNull();
   const otherScope=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.beginScopeIn(tx,x.owner,x.target,'INPUT',null,randomUUID()));expect(otherScope).not.toBeNull();const {callDigest:_oldDigest,...callBody}=call,otherBody={...callBody,callId:randomUUID(),scopeId:otherScope!.scopeId,scopeDigest:otherScope!.scopeDigest},otherCall={...otherBody,callDigest:digest(otherBody)};expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.registerCallIn(tx,otherScope!,otherCall))).toEqual(otherCall);expect(await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,otherCall,{control:{...control,requestId:randomUUID()}}))).toBeNull();
   const ref=await f.worker.accountTransaction(f.seed.accountId,tx=>x.costs.authorizeResultQueryIn(tx,call,request));expect(ref).toEqual({evidenceId:q.evidence_id,evidenceDigest:q.evidence_digest});
   const clients=[new pg.Client({connectionString:f.controller.connectionString}),new pg.Client({connectionString:f.controller.connectionString})],contexts=[randomUUID(),randomUUID()].map(deliveryClaimId=>({purpose:'PARENT_QUERY',requestId:control.requestId,requestDigest:digest(control),deliveryClaimId,authenticatedPeerId:f.peer.peerId}));
   try{
    const valid=contexts[0],{authenticatedPeerId:_peer,...legacy}=valid;const invalid=[legacy,{...valid,authenticatedPeerId:randomUUID()},{...valid,authenticatedPeerId:'bad'},{...valid,extra:true},{...valid,requestDigest:sha256('changed request')}];
    for(const context of invalid){const denied=await f.controllerDb.decision<{allowed:boolean;value:unknown}>(f.seed.accountId,"SELECT jsonb_build_object('allowed',true,'value',manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb)) AS decision",[JSON.stringify(control.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(context)]);expect(denied.value).toBeNull();}expect((await w4bFreshCounts(f)).claims).toBe(0);expect(f.objectIo).toEqual(before);
    for(const client of clients){await client.connect();await client.query('BEGIN');await client.query('SET LOCAL ROLE trio_web_controller');await client.query("SELECT set_config('trio.account_id',$1,true)",[f.seed.accountId]);}
    const claim=(index:number)=>clients[index].query('SELECT manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb) AS value',[JSON.stringify(control.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(contexts[index])]);
    const first=(await claim(0)).rows[0].value;expect(first).toMatchObject({requestId:control.requestId,deliveryClaimId:contexts[0].deliveryClaimId});const pid=(await clients[1].query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let settled=false;const second=claim(1).finally(()=>{settled=true;});void second.catch(()=>{});let blocked=false;
    for(let n=0;n<200;n++){blocked=(await f.admin.pool.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,5));}
    expect(blocked).toBe(true);expect(settled).toBe(false);await clients[0].query('COMMIT');expect((await second).rows[0].value).toBeNull();await clients[1].query('COMMIT');
    expect((await f.controllerDb.decision<{allowed:boolean;value:unknown}>(f.seed.accountId,"SELECT jsonb_build_object('allowed',true,'value',manga_web.windows_native_cost_claim_result_query($1::jsonb,$2,$3,$4::jsonb)) AS decision",[JSON.stringify(control.binding),f.profile.controllerId,f.peer.serviceRole,JSON.stringify(contexts[0])])).value).toEqual(first);
   }finally{for(const client of clients){await client.query('ROLLBACK').catch(()=>{});await client.end();}}
   expect(f.objectIo).toEqual(before);release.resolve();await expect(running).rejects.toMatchObject({version:2,nextAction:'WAIT'});expect(f.objectIo).toEqual(before);
   expect(await w4bFreshCounts(f)).toEqual({jobs:1,go:1,grants:1,claims:1,acks:0,joined:0,pending:0});
  }finally{release.resolve();await Promise.allSettled([running]);}
 },{beforeExchange:async request=>{if(request.control.command==='QUERY'&&request.control.includeRawResult){originalRequest=structuredClone(request);entered.resolve();await release.done;}}});
});


it('W4-B1 foreign authenticated peer cannot spend the original unclaimed result delivery authority',async()=>{
 const entered=w3cDeferred(),release=w3cDeferred();let originalRequest:NativeControllerRequestV2|undefined;
 await w4bRemoteCase(async(f,x)=>{
  const running=x.gateway.forCostOwner(x.target,x.owner,'INPUT',null).decodeImage(x.source,syntheticProfile);void running.catch(()=>{});const originalPeer=f.peer.peerId;
  try{
   expect(await Promise.race([entered.done.then(()=>'ENTERED'),running.then(()=>'SETTLED',()=>'SETTLED')])).toBe('ENTERED');const job=x.exchange.captures.find(r=>r.control.command==='PREPARE')!.input!.envelope,before={...f.objectIo};
   f.peer.peerId=randomUUID();const refused=await x.exchange.client.exchange(originalRequest!,job).catch(error=>{expect(error).toMatchObject({code:'NATIVE_REMOTE_RESULT_QUERY_UNCONFIRMED'});return null;});expect(refused?.rawResult??null).toBeNull();if(refused)expect(refused.control.snapshot.code).toBe('NATIVE_RAW_RESULT_UNCONFIRMED');f.peer.peerId=originalPeer;
   expect(f.objectIo).toEqual(before);expect((await w4bFreshCounts(f)).claims).toBe(0);release.resolve();expect(await running).toMatchObject({width:1,height:1});expect(await w4bFreshCounts(f)).toEqual({jobs:1,go:1,grants:1,claims:1,acks:1,joined:1,pending:0});
  }finally{f.peer.peerId=originalPeer;release.resolve();await Promise.allSettled([running]);}
 },{beforeExchange:async request=>{if(request.control.command==='QUERY'&&request.control.includeRawResult){originalRequest=structuredClone(request);entered.resolve();await release.done;}}});
});
