import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {digest} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeRemoteController,type NativeRemoteOriginalPort} from '../../packages/native/src/controller-remote.js';
import {createNativeResult,type NativeJob,type NativeLimits,type NativeTermination} from '../../packages/native/src/dto.js';
import type {NativeControllerBinding,NativeControllerRequest,NativeControllerResponse,NativeControllerSnapshot} from '../../packages/native/src/controller-protocol.js';

// Private fake ports only. These cases establish parent control, data and I/O
// invariants, never peer authentication, PostgreSQL, valid ZIP output or a child.
const controllers:NativeRemoteController[]=[],gates:(()=>void)[]=[];
function deferred(){let resolve=()=>{};const promise=new Promise<void>(yes=>{resolve=yes;});gates.push(resolve);return {promise,resolve};}
const limits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:8,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:1024*1024};
function fixture(){
  const accountId=randomUUID(),reservationId=randomUUID(),attemptId=randomUUID(),instanceId=randomUUID(),requests:NativeControllerRequest[]=[],responseFrames:NativeControllerResponse[]=[];
  let job!:NativeJob,binding!:NativeControllerBinding,admissionGate:Promise<void>|undefined,attestationGate:Promise<void>|undefined,failure:string|undefined,change:((response:NativeControllerResponse)=>void)|undefined;
  const output=Buffer.from([5,6,7,8]),blobs=new Map([['source',Buffer.from([1,2,3,4])]]),metadata={profile:structuredClone(syntheticProfile),entries:[{name:'owned.bin',blobId:'source'}]};
  const admit=vi.fn(async(value:NativeJob)=>{
    job=structuredClone(value);await admissionGate;if(failure==='ADMIT_ACK')throw new DomainError('OWNED_REMOTE_ACK_LOST',409,'WAIT');
    binding={accountId,capacityReservationId:reservationId,jobId:job.jobId,parentInstanceId:controller.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:controller.kernelImplementationDigest};return structuredClone(binding);
  });
  const attest=vi.fn(async()=>{await attestationGate;if(failure==='ATTEST_ACK')throw new DomainError('OWNED_REMOTE_ACK_LOST',409,'WAIT');});
  const client={exchange:vi.fn(async(request:NativeControllerRequest)=>{
    requests.push(request);if(failure===request.control.command+'_ACK')throw new DomainError('OWNED_REMOTE_ACK_LOST',409,'WAIT');
    const termination:NativeTermination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
    const snapshot:NativeControllerSnapshot={attemptId,controllerInstanceId:instanceId,phase:request.control.command==='PREPARE'?'READY':'GO_GRANTED',rawResult:null,termination:null,code:'OK'};
    const response:NativeControllerResponse={control:{version:1,requestId:request.control.requestId,command:request.control.command,binding:structuredClone(request.control.binding),snapshot}};
    if(request.control.command==='QUERY'){
      const rawBlobs=new Map([['archive',Buffer.from(output)]]),result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:output.length},blobs:rawBlobs},controller.frameLimits('output'));
      snapshot.rawResult={rawResultId:randomUUID(),resultDigest:digest(result)};snapshot.termination=termination;response.rawResult={envelope:result,blobs:rawBlobs};change?.(response);
    }
    responseFrames.push(response);return response;
  }),shutdown:vi.fn(async()=>{})};
  const options={profile:structuredClone(syntheticProfile),limits:{...limits},client},controller=new NativeRemoteController(options);controllers.push(controller);
  const port:NativeRemoteOriginalPort={accountId,admit,attest};
  return {controller,options,client,port,admit,attest,requests,responseFrames,blobs,metadata,output,get job(){return job;},get binding(){return binding;},setAdmission:(gate:Promise<void>)=>{admissionGate=gate;},setAttestation:(gate:Promise<void>)=>{attestationGate=gate;},setFailure:(value:string)=>{failure=value;},changeResult:(value:(response:NativeControllerResponse)=>void)=>{change=value;}};
}
afterEach(async()=>{for(const resolve of gates.splice(0))resolve();for(const controller of controllers.splice(0))await controller.shutdown();});

describe('original remote native parent control and bounded I/O',{timeout:20_000},()=>{
  it('captures before admission and performs one original PREPARE GO then QUERY before parent attestation',async()=>{
    const f=fixture(),gate=deferred();f.setAdmission(gate.promise);const promise=f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs);
    expect(f.admit).toHaveBeenCalledTimes(1);expect(f.client.exchange).not.toHaveBeenCalled();expect(f.controller.usage().reservedBytes).toBeGreaterThan(0);
    f.blobs.get('source')!.fill(9);f.blobs.clear();f.metadata.entries=[];f.options.profile.enabled=false;f.options.limits.timeoutMs=1;gate.resolve();
    const value=await promise;expect(value).toEqual({metadata:{archiveBlobId:'archive',byteLength:4},blobs:new Map([['archive',f.output]])});
    expect(f.requests.map(item=>item.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.requests[0].input?.blobs.get('source')).toEqual(Buffer.from([1,2,3,4]));
    expect(f.requests[0].input?.envelope.metadata.entries).toEqual([{name:'owned.bin',blobId:'source'}]);expect(f.requests.every(item=>item.control.binding.parentInstanceId===f.controller.parentInstanceId)).toBe(true);
    expect(f.attest).toHaveBeenCalledTimes(1);expect(f.controller.usage()).toMatchObject({reservedBytes:0,active:0});
  });
  it('shares parent capacity across different targets and refuses before copying another input',async()=>{
    const f=fixture(),gate=deferred();f.setAdmission(gate.promise);const first=f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs);
    const copied=vi.spyOn(Buffer,'from'),clone=vi.spyOn(globalThis,'structuredClone');
    try{expect(()=>f.controller.forPort({...f.port,accountId:randomUUID()}).run('ZIP_WRITE',f.metadata,f.blobs)).toThrow('NATIVE_PARENT_CAPACITY_WAIT');expect(copied).not.toHaveBeenCalled();expect(clone).not.toHaveBeenCalled();}
    finally{copied.mockRestore();clone.mockRestore();}gate.resolve();await first;expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('waits on the original QUERY when raw allocation is visible before PUT receipt and final TERM',async()=>{
    const f=fixture();let query=0;f.changeResult(response=>{if(query++===0){delete response.rawResult;Object.assign(response.control.snapshot,{rawResult:null,termination:null,code:'NATIVE_RAW_RESULT_UNCONFIRMED'});}});
    expect((await f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs)).blobs.get('archive')).toEqual(f.output);
    expect(f.requests.map(item=>item.control.command)).toEqual(['PREPARE','GO','QUERY','QUERY']);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.attest).toHaveBeenCalledTimes(1);
    expect(f.controller.usage()).toMatchObject({active:0,reservedBytes:0});
  });
  it.each(['FINAL_TERM','UNKNOWN_PHASE'])('never promotes missing raw with %s to transient progress',async condition=>{
    const f=fixture();f.changeResult(response=>{delete response.rawResult;response.control.snapshot.rawResult=null;response.control.snapshot.code='NATIVE_RAW_RESULT_UNCONFIRMED';if(condition==='UNKNOWN_PHASE'){response.control.snapshot.phase='UNKNOWN';response.control.snapshot.termination=null;}});
    await expect(f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs)).rejects.toMatchObject({code:'NATIVE_REMOTE_EXECUTION_UNCONFIRMED'});
    expect(f.requests.map(item=>item.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.attest).not.toHaveBeenCalled();
  });
  it.each(['ADMIT_ACK','PREPARE_ACK','GO_ACK','QUERY_ACK','ATTEST_ACK'])('keeps original unknown on %s and never replays admission PREPARE or GO',async boundary=>{
    const f=fixture();f.setFailure(boundary);await expect(f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs)).rejects.toMatchObject({code:'OWNED_REMOTE_ACK_LOST',nextAction:'WAIT',termination:{jobId:expect.any(String),subtreeTerminationConfirmed:false}});
    expect(f.admit).toHaveBeenCalledTimes(1);expect(f.requests.filter(item=>item.control.command==='PREPARE').length).toBeLessThanOrEqual(1);expect(f.requests.filter(item=>item.control.command==='GO').length).toBeLessThanOrEqual(1);
    expect(f.controller.usage().reservedBytes).toBe(0);if(boundary==='ATTEST_ACK')expect(f.responseFrames.at(-1)?.control.snapshot.termination?.kind).toBe('DIRECT_CHILD_ONLY');
  });
  it.each(['BINDING','ATTEMPT','RAW_DIGEST','BYTES','TERM'])('rejects changed %s before attestation or returning a computation',async condition=>{
    const f=fixture();f.changeResult(response=>{
      if(condition==='BINDING')response.control.binding.accountId=randomUUID();else if(condition==='ATTEMPT')response.control.snapshot.attemptId=randomUUID();
      else if(condition==='RAW_DIGEST')response.control.snapshot.rawResult!.resultDigest='0'.repeat(64);else if(condition==='BYTES')response.rawResult!.blobs.get('archive')!.fill(0);
      else response.control.snapshot.termination!.operationJoined=false;
    });await expect(f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs)).rejects.toBeInstanceOf(DomainError);expect(f.attest).not.toHaveBeenCalled();expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it('explicit original recovery in a new parent sends QUERY only and preserves the old frame parent identity',async()=>{
    const f=fixture();await f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs);const before=f.requests.length;
    const next=new NativeRemoteController({profile:syntheticProfile,limits,client:f.client});controllers.push(next);expect(next.parentInstanceId).not.toBe(f.binding.parentInstanceId);
    expect((await next.queryOriginal(f.port,f.job,f.binding)).blobs.get('archive')).toEqual(f.output);
    expect(f.requests.slice(before).map(item=>item.control.command)).toEqual(['QUERY']);expect(f.requests.at(-1)?.control.binding.parentInstanceId).toBe(f.binding.parentInstanceId);expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('keeps copied buffers and shutdown pending until original admission I/O actually joins',async()=>{
    const f=fixture(),gate=deferred();f.setAdmission(gate.promise);const operation=f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs),rejection=expect(operation).rejects.toMatchObject({code:'NATIVE_SHUTDOWN_WAIT'});
    let joined=false;const shutdown=f.controller.shutdown().then(()=>{joined=true;});await Promise.resolve();expect(joined).toBe(false);expect(f.controller.usage().reservedBytes).toBeGreaterThan(0);expect(f.client.shutdown).not.toHaveBeenCalled();
    gate.resolve();await rejection;await shutdown;expect(f.client.exchange).not.toHaveBeenCalled();expect(f.client.shutdown).toHaveBeenCalledTimes(1);expect(f.controller.usage()).toMatchObject({reservedBytes:0,active:0,accepting:false});
  });
  it('checks its original deadline after late admission and never sends a frame while the acknowledgement is pending',async()=>{
    const f=fixture(),gate=deferred(),short=new NativeRemoteController({profile:syntheticProfile,limits:{...limits,timeoutMs:10},client:f.client});controllers.push(short);f.setAdmission(gate.promise);
    const port={...f.port,admit:async(job:NativeJob)=>{await gate.promise;return {accountId:f.port.accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:short.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:short.kernelImplementationDigest};}};
    const operation=short.forPort(port).run('ZIP_WRITE',f.metadata,f.blobs),rejection=expect(operation).rejects.toMatchObject({code:'NATIVE_JOB_TIMEOUT'});
    await new Promise(resolve=>setTimeout(resolve,25));expect(short.usage().reservedBytes).toBeGreaterThan(0);expect(f.client.exchange).not.toHaveBeenCalled();gate.resolve();await rejection;expect(short.usage().reservedBytes).toBe(0);
  });
  it('rechecks actual result bytes after attestation and does not pass mutations through the parent port',async()=>{
    const f=fixture(),gate=deferred();f.setAttestation(gate.promise);const operation=f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs),rejection=expect(operation).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
    while(!f.attest.mock.calls.length)await new Promise(resolve=>setTimeout(resolve,2));f.responseFrames.at(-1)!.rawResult!.blobs.get('archive')!.fill(0);gate.resolve();await rejection;expect(f.controller.usage().reservedBytes).toBe(0);
  });
});

// W3-C 회귀는 원격 부모와 합성 포트만 사용한다. 실제 Windows/DB/API는 실행하지 않는다.
import {NativeJobErrorV2,type NativeRemoteControllerV2,type NativeRemoteExchangePortV2,type NativeRemoteOriginalPortV2} from '../../packages/native/src/controller-remote.js';
import type {NativeTerminationV2,WindowsEvidenceRef} from '../../packages/native/src/dto.js';
import type {NativeControllerRequestV2,NativeControllerResponseV2,NativeControllerSnapshotV2} from '../../packages/native/src/controller-protocol.js';

const windowsControllers:NativeRemoteControllerV2[]=[];
function windowsFixture(timeoutMs=limits.timeoutMs){
  // 재실행/GO/이력의 잘못된 분기, 원 자료 변조와 I/O 조기 반환을 잡는 합성 경계다.
  expect(NativeRemoteController.windows).toBeTypeOf('function');
  const accountId=randomUUID(),reservationId=randomUUID(),attemptId=randomUUID(),instanceId=randomUUID(),rawResultId=randomUUID();
  const ref:WindowsEvidenceRef={recordId:randomUUID(),recordDigest:'a'.repeat(64),linkId:randomUUID(),linkDigest:'b'.repeat(64)};
  const requests:NativeControllerRequestV2[]=[],responses:NativeControllerResponseV2[]=[],originalJobs:(NativeJob|undefined)[]=[];
  let job!:NativeJob,binding!:NativeControllerBinding,admissionGate:Promise<void>|undefined,attestationGate:Promise<void>|undefined;
  let replyGate:{command:string;promise:Promise<void>}|undefined,change:((response:NativeControllerResponseV2,request:NativeControllerRequestV2)=>void)|undefined,failure:unknown;
  let boundary:string|undefined;
  const output=Buffer.from([5,6,7,8]),blobs=new Map([['source',Buffer.from([1,2,3,4])]]),metadata={profile:structuredClone(syntheticProfile),entries:[{name:'owned.bin',blobId:'source'}]};
  const admit=vi.fn(async(value:NativeJob)=>{
    job=structuredClone(value);await admissionGate;if(boundary==='ADMIT')throw failure;
    binding={accountId,capacityReservationId:reservationId,jobId:job.jobId,parentInstanceId:controller.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:controller.kernelImplementationDigest};
    return structuredClone(binding);
  });
  const attest=vi.fn(async(_job:NativeJob,_binding:NativeControllerBinding,_result:import('../../packages/native/src/dto.js').NativeResult,_snapshot:NativeControllerSnapshotV2)=>{
    await attestationGate;if(boundary==='ATTEST')throw failure;
  });
  function termination():NativeTerminationV2{return {jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY'};}
  const client:NativeRemoteExchangePortV2={exchange:vi.fn(async(request:NativeControllerRequestV2,originalJob?:NativeJob)=>{
    requests.push(request);originalJobs.push(originalJob);if(replyGate?.command===request.control.command)await replyGate.promise;if(boundary===request.control.command)throw failure;
    const snapshot:NativeControllerSnapshotV2={version:2,attemptId,controllerInstanceId:instanceId,phase:request.control.command==='PREPARE'?'READY':'GO_GRANTED',rawResult:null,termination:null,windowsEvidenceRef:null,code:'OK'};
    const response:NativeControllerResponseV2={control:{version:2,requestId:request.control.requestId,command:request.control.command,binding:structuredClone(request.control.binding),snapshot}};
    if(request.control.command==='QUERY'){
      const rawBlobs=new Map([['archive',Buffer.from(output)]]),result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:4},blobs:rawBlobs},controller.frameLimits('output'));
      snapshot.rawResult={rawResultId,resultDigest:digest(result)};snapshot.termination=termination();snapshot.windowsEvidenceRef=structuredClone(ref);
      if(request.control.includeRawResult)response.rawResult={envelope:result,blobs:rawBlobs};
    }
    change?.(response,request);responses.push(response);return response;
  }),shutdown:vi.fn(async()=>{})};
  const options={profile:structuredClone(syntheticProfile),limits:{...limits,timeoutMs},client,windows:{version:2 as const}};
  const controller=NativeRemoteController.windows(options);windowsControllers.push(controller);
  const port:NativeRemoteOriginalPortV2={accountId,admit,attest};
  return {controller,options,client,port,admit,attest,requests,responses,originalJobs,metadata,blobs,output,ref,termination,
    get job(){return job;},get binding(){return binding;},
    change:(fn:(response:NativeControllerResponseV2,request:NativeControllerRequestV2)=>void)=>{change=fn;},
    gateAdmission:(promise:Promise<void>)=>{admissionGate=promise;},gateAttestation:(promise:Promise<void>)=>{attestationGate=promise;},
    gateReply:(command:string,promise:Promise<void>)=>{replyGate={command,promise};},fail:(at:string,error:unknown)=>{boundary=at;failure=error;}};
}
afterEach(async()=>{for(const resolve of gates.splice(0))resolve();for(const controller of windowsControllers.splice(0))await controller.shutdown();});

function pendingWindows(response:NativeControllerResponseV2,phase:'PREPARING'|'GO_GRANTED'='GO_GRANTED'):void{
  delete response.rawResult;Object.assign(response.control.snapshot,{phase,rawResult:null,termination:null,windowsEvidenceRef:null,code:'WINDOWS_EVIDENCE_PENDING'});
}
function windowsFailure(f:ReturnType<typeof windowsFixture>){return f.controller.forPort(f.port).run('ZIP_WRITE',f.metadata,f.blobs);}

describe('W3-C 원격 Windows V2 부모 계약',{timeout:20_000},()=>{
  it('W3-C 명시 factory만 V2를 고정하고 첫 READY 이후 GO 한 번과 원 QUERY로 완료한다',async()=>{
    const f=windowsFixture(),gate=deferred();f.gateAdmission(gate.promise);const operation=windowsFailure(f);
    expect(f.controller).toMatchObject({protocolVersion:2,observationIsolation:'WINDOWS_JOB_OBJECT',nativeLimitsDigest:digest(f.options.limits)});
    f.options.limits.timeoutMs=1;f.options.profile.enabled=false;f.blobs.get('source')!.fill(9);f.blobs.clear();f.metadata.entries=[];gate.resolve();
    const result=await operation;expect(result).toEqual({metadata:{archiveBlobId:'archive',byteLength:4},blobs:new Map([['archive',Buffer.from([5,6,7,8])]])});
    expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.requests.every(request=>request.control.version===2)).toBe(true);
    expect(f.requests[0].input!.blobs.get('source')).toEqual(Buffer.from([1,2,3,4]));expect(f.requests[0].input!.envelope.metadata.entries).toEqual([{name:'owned.bin',blobId:'source'}]);
    expect(f.originalJobs.every(job=>job?.jobId===f.job.jobId)).toBe(true);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.attest).toHaveBeenCalledTimes(1);
    expect(f.attest.mock.calls[0][3]).toMatchObject({version:2,windowsEvidenceRef:f.ref,termination:{kind:'WINDOWS_JOB_EMPTY'}});
    expect(f.controller.usage()).toMatchObject({reservedBytes:0,active:0,accepting:true});
  });
  it.each(['EXTRA','SYMBOL','GETTER','VERSION','WINDOWS_EXTRA','LIMIT_SYMBOL','DISABLED','PROFILE_KIND'])('W3-C %s 설정은 I/O 전에 거부한다',condition=>{
    const f=windowsFixture(),options=structuredClone({profile:f.options.profile,limits:f.options.limits,windows:f.options.windows}) as Record<string,unknown>;options.client=f.client;
    if(condition==='EXTRA')options.extra=true;
    else if(condition==='SYMBOL')Object.defineProperty(options,Symbol('숨은 키'),{value:true});
    else if(condition==='GETTER')Object.defineProperty(options,'windows',{get(){throw new Error('getter 실행 금지');},enumerable:true});
    else if(condition==='VERSION')options.windows={version:1};
    else if(condition==='WINDOWS_EXTRA')options.windows={version:2,isolation:'WINDOWS_JOB_OBJECT'};
    else if(condition==='LIMIT_SYMBOL')Object.defineProperty(options.limits,Symbol('숨은 한도'),{value:1});
    else if(condition==='DISABLED')(options.profile as typeof syntheticProfile).enabled=false;
    else (options.profile as {kind:string}).kind='WINDOWS';
    expect(()=>NativeRemoteController.windows(options as unknown as Parameters<typeof NativeRemoteController.windows>[0])).toThrow(DomainError);
    expect(f.client.exchange).not.toHaveBeenCalled();expect(f.admit).not.toHaveBeenCalled();
  });
  it('W3-C 정상 V1 port는 V2 타입으로 허용하지 않고 강제 cast 응답은 수신 시 WAIT한다',async()=>{
    const f=windowsFixture();
    // @ts-expect-error V1 control 응답은 V2 exchange port가 아니다.
    const denied:NativeRemoteExchangePortV2={exchange:async(_request:NativeControllerRequest, _job?:NativeJob):Promise<NativeControllerResponse>=>{throw new Error('실행 금지');},shutdown:async()=>{}};
    void denied;
    f.change(response=>{Object.assign(response.control,{version:1});delete (response.control.snapshot as Partial<NativeControllerSnapshotV2>).version;delete (response.control.snapshot as Partial<NativeControllerSnapshotV2>).windowsEvidenceRef;});
    await expect(windowsFailure(f)).rejects.toMatchObject({version:2,nextAction:'WAIT',windowsEvidenceRef:null,termination:{kind:'UNCONFIRMED'}});
    expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE']);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.attest).not.toHaveBeenCalled();
  });
  it('W3-C 진행 pending은 같은 QUERY만 사용하며 유효 원 frame과 ref를 기다린다',async()=>{
    const f=windowsFixture();let queries=0;f.change((response,request)=>{if(request.control.command==='GO'||request.control.command==='QUERY'&&queries++===0)pendingWindows(response);});
    expect((await windowsFailure(f)).blobs.get('archive')).toEqual(f.output);expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','GO','QUERY','QUERY']);expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('W3-C 최초 pending 뒤 QUERY READY는 GO 권한을 만들지 않고 WAIT한다',async()=>{
    const f=windowsFixture();f.change((response,request)=>{pendingWindows(response,'PREPARING');if(request.control.command==='QUERY'){response.control.snapshot.phase='READY';response.control.snapshot.code='OK';}});
    await expect(windowsFailure(f)).rejects.toMatchObject({version:2,nextAction:'WAIT',termination:{goAttempted:false}});
    expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','QUERY']);expect(f.attest).not.toHaveBeenCalled();
  });
  it('W3-C 첫 PREPARE의 미생성 종료와 원 ref를 즉시 보존한다',async()=>{
    const f=windowsFixture();f.change(response=>{const term=f.termination();Object.assign(term,{kind:'NO_CHILD_CREATED',goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false});Object.assign(response.control.snapshot,{code:'WINDOWS_JOB_NOT_CREATED',termination:term,windowsEvidenceRef:f.ref});});
    await expect(windowsFailure(f)).rejects.toMatchObject({version:2,code:'WINDOWS_JOB_NOT_CREATED',windowsEvidenceRef:f.ref,termination:{kind:'NO_CHILD_CREATED',goAttempted:false}});
    expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE']);expect(f.attest).not.toHaveBeenCalled();
  });
  it.each(['RAW_DENIED','NOT_LIVE','UNKNOWN','PERMANENT','FINAL_PENDING'])('W3-C %s 최종 거부를 pending으로 재분류하거나 재호출하지 않는다',async condition=>{
    const f=windowsFixture();f.change((response,request)=>{
      if(request.control.command!=='QUERY')return;delete response.rawResult;response.control.snapshot.rawResult=null;
      response.control.snapshot.code=condition==='RAW_DENIED'?'NATIVE_RAW_RESULT_UNCONFIRMED':condition==='NOT_LIVE'?'WINDOWS_ATTEMPT_NOT_LIVE':condition==='PERMANENT'?'WINDOWS_ORIGINAL_DENIED':condition==='FINAL_PENDING'?'WINDOWS_EVIDENCE_PENDING':'OK';
      if(condition==='UNKNOWN')response.control.snapshot.phase='UNKNOWN';
    });
    await expect(windowsFailure(f)).rejects.toMatchObject({version:2,nextAction:'WAIT',windowsEvidenceRef:f.ref,termination:{kind:'WINDOWS_JOB_EMPTY'}});
    expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.attest).not.toHaveBeenCalled();
  });
  it.each(['REQUEST','COMMAND','ACCOUNT','ATTEMPT','INSTANCE','VERSION','RAW_DIGEST','BYTES','TERM','REF_EXTRA'])('W3-C 교차 또는 변조된 %s는 attestation 전에 거부한다',async condition=>{
    const f=windowsFixture();f.change((response,request)=>{
      if(request.control.command!=='QUERY')return;
      if(condition==='REQUEST')response.control.requestId=randomUUID();else if(condition==='COMMAND')response.control.command='PREPARE';else if(condition==='ACCOUNT')response.control.binding.accountId=randomUUID();
      else if(condition==='ATTEMPT')response.control.snapshot.attemptId=randomUUID();else if(condition==='INSTANCE')response.control.snapshot.controllerInstanceId=randomUUID();else if(condition==='VERSION')Object.assign(response.control,{version:1});
      else if(condition==='RAW_DIGEST')response.control.snapshot.rawResult!.resultDigest='0'.repeat(64);else if(condition==='BYTES')response.rawResult!.blobs.get('archive')!.fill(0);
      else if(condition==='TERM')response.control.snapshot.termination!.operationJoined=false;else Object.assign(response.control.snapshot.windowsEvidenceRef!,{extra:true});
    });
    await expect(windowsFailure(f)).rejects.toBeInstanceOf(NativeJobErrorV2);expect(f.attest).not.toHaveBeenCalled();expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it('W3-C GO ACK의 최종 ref가 QUERY에서 바뀌면 거부한다',async()=>{
    const f=windowsFixture();f.change((response,request)=>{if(request.control.command==='GO')Object.assign(response.control.snapshot,{termination:f.termination(),rawResult:{rawResultId:randomUUID(),resultDigest:'c'.repeat(64)},windowsEvidenceRef:{...f.ref,linkId:randomUUID()}});});
    await expect(windowsFailure(f)).rejects.toBeInstanceOf(NativeJobErrorV2);expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.attest).not.toHaveBeenCalled();
  });
  it.each(['ADMIT','PREPARE','GO','QUERY','ATTEST'])('W3-C %s ACK 실패는 원 V2 오류 객체를 강등 없이 그대로 보존한다',async boundary=>{
    const f=windowsFixture(),error=new NativeJobErrorV2('OWNED_WINDOWS_ACK_LOST',409,'WAIT',{version:2,termination:{jobId:randomUUID(),inputDigest:'c'.repeat(64),profileDigest:'d'.repeat(64),goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'},windowsEvidenceRef:f.ref});f.fail(boundary,error);
    await expect(windowsFailure(f)).rejects.toBe(error);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.requests.filter(request=>request.control.command==='PREPARE').length).toBeLessThanOrEqual(1);expect(f.requests.filter(request=>request.control.command==='GO').length).toBeLessThanOrEqual(1);expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it('W3-C V2 오류의 닫힌 자료를 복제하고 깊이 동결한다',async()=>{
    const f=windowsFixture();await windowsFailure(f);const evidence={version:2 as const,termination:f.termination(),windowsEvidenceRef:{...f.ref}},error=new NativeJobErrorV2('OWNED_WINDOWS_REJECTED',422,'WAIT',evidence);
    evidence.termination.kind='UNCONFIRMED';evidence.windowsEvidenceRef.recordDigest='0'.repeat(64);
    expect(error).toMatchObject({version:2,code:'OWNED_WINDOWS_REJECTED',status:422,nextAction:'WAIT',termination:{kind:'WINDOWS_JOB_EMPTY'},windowsEvidenceRef:f.ref});
    expect(Object.isFrozen(error)).toBe(true);expect(Object.isFrozen(error.termination)).toBe(true);expect(Object.isFrozen(error.windowsEvidenceRef)).toBe(true);
    expect(()=>new NativeJobErrorV2('BAD',409,'WAIT',{...evidence,extra:true} as typeof evidence)).toThrow(DomainError);
  });
  it('W3-C 새 부모의 raw 복구는 옛 binding과 originalJob을 쓴 QUERY만 보낸다',async()=>{
    const f=windowsFixture();await windowsFailure(f);const next=NativeRemoteController.windows(f.options);windowsControllers.push(next);const before=f.requests.length;
    expect((await next.queryOriginal(f.port,f.job,f.binding)).blobs.get('archive')).toEqual(f.output);expect(f.requests.slice(before).map(request=>request.control.command)).toEqual(['QUERY']);
    expect(f.requests.at(-1)!.control).toMatchObject({binding:{parentInstanceId:f.controller.parentInstanceId},includeRawResult:true});expect(next.parentInstanceId).not.toBe(f.controller.parentInstanceId);expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it.each([false,true])('W3-C metadata 조회는 raw/attest 없이 QUERY 한 번으로 pending=%s 원 snapshot을 반환한다',async incomplete=>{
    const f=windowsFixture();await windowsFailure(f);const before=f.requests.length,attestBefore=f.attest.mock.calls.length;
    if(incomplete)f.change(response=>{pendingWindows(response,'PREPARING');});
    const metadata=await f.controller.readOriginalMetadata(f.port,f.job,f.binding);
    expect(metadata).toMatchObject(incomplete?{version:2,phase:'PREPARING',windowsEvidenceRef:null,termination:null,code:'WINDOWS_EVIDENCE_PENDING'}:{version:2,windowsEvidenceRef:f.ref,termination:{kind:'WINDOWS_JOB_EMPTY'}});
    expect(f.requests.slice(before).map(request=>request.control.command)).toEqual(['QUERY']);expect(f.requests.at(-1)!.control).toMatchObject({includeRawResult:false});expect(f.responses.at(-1)).not.toHaveProperty('rawResult');expect(f.attest).toHaveBeenCalledTimes(attestBefore);expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('W3-C parent 예약은 복사 전에 확보하고 다른 target의 합산 초과를 I/O0으로 거부한다',async()=>{
    const f=windowsFixture(),gate=deferred();f.gateAdmission(gate.promise);const first=windowsFailure(f),copy=vi.spyOn(Buffer,'from'),clone=vi.spyOn(globalThis,'structuredClone');
    try{expect(()=>f.controller.forPort({...f.port,accountId:randomUUID()}).run('ZIP_WRITE',f.metadata,f.blobs)).toThrow('NATIVE_PARENT_CAPACITY_WAIT');expect(copy).not.toHaveBeenCalled();expect(clone).not.toHaveBeenCalled();}
    finally{copy.mockRestore();clone.mockRestore();}gate.resolve();await first;expect(f.admit).toHaveBeenCalledTimes(1);expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it.each(['ADMIT','PREPARE','GO','QUERY','ATTEST'])('W3-C %s 실제 I/O 종료까지 stop/idle/shutdown과 예약을 유지한다',async boundary=>{
    const f=windowsFixture(),gate=deferred();if(boundary==='ADMIT')f.gateAdmission(gate.promise);else if(boundary==='ATTEST')f.gateAttestation(gate.promise);else f.gateReply(boundary,gate.promise);
    const operation=windowsFailure(f),rejected=expect(operation).rejects.toMatchObject({version:2,code:'NATIVE_SHUTDOWN_WAIT',nextAction:'WAIT'});
    while(boundary==='ATTEST'?!f.attest.mock.calls.length:boundary==='ADMIT'?!f.admit.mock.calls.length:!f.requests.some(request=>request.control.command===boundary))await new Promise(resolve=>setTimeout(resolve,1));
    let joined=false;const shutdown=f.controller.shutdown().then(()=>{joined=true;});await Promise.resolve();expect(joined).toBe(false);expect(f.controller.usage().reservedBytes).toBeGreaterThan(0);expect(f.client.shutdown).not.toHaveBeenCalled();
    expect(()=>windowsFailure(f)).toThrow('NATIVE_SHUTDOWN_WAIT');gate.resolve();await rejected;await shutdown;expect(f.controller.usage()).toMatchObject({reservedBytes:0,active:0,accepting:false});expect(f.client.shutdown).toHaveBeenCalledTimes(1);
  });
  it('W3-C bounded pending은 같은 QUERY 안에서 timeout하고 추가 GO를 보내지 않는다',async()=>{
    const f=windowsFixture(40);f.change((response,request)=>{if(request.control.command!=='PREPARE')pendingWindows(response);});
    await expect(windowsFailure(f)).rejects.toMatchObject({version:2,code:'NATIVE_JOB_TIMEOUT',termination:{kind:'UNCONFIRMED',goAttempted:true}});expect(f.requests.filter(request=>request.control.command==='GO')).toHaveLength(1);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it('W3-C 늦은 PREPARE ACK는 실제 종료까지 보유한 뒤 timeout하며 GO0이다',async()=>{
    const f=windowsFixture(20),gate=deferred();f.gateReply('PREPARE',gate.promise);const operation=windowsFailure(f),rejected=expect(operation).rejects.toMatchObject({version:2,code:'NATIVE_JOB_TIMEOUT'});
    await new Promise(resolve=>setTimeout(resolve,35));expect(f.controller.usage().reservedBytes).toBeGreaterThan(0);gate.resolve();await rejected;expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE']);
  });
  it('W3-C attestation 후 실제 bytes를 재검사하여 변경된 결과를 반환하지 않는다',async()=>{
    const f=windowsFixture(),gate=deferred();f.gateAttestation(gate.promise);const operation=windowsFailure(f),rejected=expect(operation).rejects.toMatchObject({version:2,code:'NATIVE_CONTROL_RAW_MISMATCH',windowsEvidenceRef:f.ref});
    while(!f.attest.mock.calls.length)await new Promise(resolve=>setTimeout(resolve,1));f.responses.at(-1)!.rawResult!.blobs.get('archive')!.fill(0);gate.resolve();await rejected;expect(f.controller.usage().reservedBytes).toBe(0);
  });
  it('W3-C idle은 이전 caller 오류를 재생하거나 새 호출을 영구 차단하지 않는다',async()=>{
    const f=windowsFixture();f.fail('PREPARE',new DomainError('OWNED_WINDOWS_ACK_LOST',409,'WAIT'));await expect(windowsFailure(f)).rejects.toMatchObject({code:'OWNED_WINDOWS_ACK_LOST'});await expect(f.controller.idle()).resolves.toBeUndefined();f.fail('',undefined);
    expect((await windowsFailure(f)).blobs.get('archive')).toEqual(f.output);expect(f.admit).toHaveBeenCalledTimes(2);
  });
});

it('W3-C 실제 서버 첫 READY pending 응답은 단 한 번 GO하고 후속 원 QUERY로 완료한다',async()=>{
  const f=windowsFixture();f.change((response,request)=>{if(request.control.command==='PREPARE')response.control.snapshot.code='WINDOWS_EVIDENCE_PENDING';});
  expect((await windowsFailure(f)).blobs.get('archive')).toEqual(f.output);
  expect(f.requests.map(request=>request.control.command)).toEqual(['PREPARE','GO','QUERY']);expect(f.admit).toHaveBeenCalledTimes(1);
});

// W4-B1: 실제 V2 부모의 비용형 metadata/전달 경로를 가짜 포트로 확인한다.
import * as w4bRemote from '../../packages/native/src/controller-remote.js';
it('W4-B1 비용형 원 실행은 metadata 뒤 전달 등록 ACK를 기다린 후 원 raw QUERY를 보낸다',async()=>{
  const f=windowsFixture(),order:string[]=[],grant={evidenceId:randomUUID(),evidenceDigest:'c'.repeat(64)};
  const authorizeResultQuery=vi.fn(async(request:NativeControllerRequestV2)=>{order.push('AUTHORIZE');expect(request.control).toMatchObject({command:'QUERY',includeRawResult:true});return grant;});
  const finishResultQuery=vi.fn(async()=>{order.push('FINISH');return grant;});
  f.change((_response,request)=>{if(request.control.command==='QUERY')order.push(request.control.includeRawResult?'RAW':'METADATA');});
  const port=w4bRemote.createCostedRemoteOriginalPortV2({...f.port,authorizeResultQuery,finishResultQuery});
  const result=await f.controller.forCostedPort(port).run('ZIP_WRITE',f.metadata,f.blobs);
  expect(result.blobs.get('archive')).toEqual(f.output);
  expect(f.requests.filter(r=>r.control.command==='QUERY').map(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toEqual([false,true]);
  expect(order).toEqual(['METADATA','AUTHORIZE','RAW','FINISH']);expect(authorizeResultQuery).toHaveBeenCalledTimes(1);expect(finishResultQuery).toHaveBeenCalledTimes(1);expect(f.attest).toHaveBeenCalledTimes(1);
});

function w4bCosted(f:ReturnType<typeof windowsFixture>,options:{authorize?:()=>Promise<import('../../packages/native/src/controller-remote.js').NativeRemoteCostRef|null>;finish?:()=>Promise<import('../../packages/native/src/controller-remote.js').NativeRemoteCostRef|null>}={}){
  const ref={evidenceId:randomUUID(),evidenceDigest:'c'.repeat(64)};
  const authorizeResultQuery=vi.fn(async(request:NativeControllerRequestV2)=>{expect(Object.isFrozen(request.control.binding)).toBe(true);return options.authorize?options.authorize():ref;});
  const finishResultQuery=vi.fn(async(request:NativeControllerRequestV2,responseRef:import('../../packages/native/src/controller-remote.js').NativeRemoteResultResponseRef)=>{
    const response=f.responses.at(-1)!;expect(responseRef).toEqual({requestId:request.control.requestId,responseDigest:digest({control:response.control,rawResult:response.rawResult!.envelope})});
    return options.finish?options.finish():ref;
  });
  const methods={...f.port,authorizeResultQuery,finishResultQuery},port=w4bRemote.createCostedRemoteOriginalPortV2(methods);
  return {port,methods,authorizeResultQuery,finishResultQuery,run:()=>f.controller.forCostedPort(port).run('ZIP_WRITE',f.metadata,f.blobs)};
}
it.each(['EXTRA','SYMBOL','GETTER','PROXY'] as const)('W4-B1 비용 포트 %s는 callback이나 exchange 전에 거부한다',kind=>{
  const f=windowsFixture(),fns={...f.port,authorizeResultQuery:vi.fn(async()=>null),finishResultQuery:vi.fn(async()=>null)};
  if(kind==='EXTRA')Object.assign(fns,{extra:true});else if(kind==='SYMBOL')Object.defineProperty(fns,Symbol('숨은 키'),{value:true});else if(kind==='GETTER')Object.defineProperty(fns,'authorizeResultQuery',{enumerable:true,get(){throw new Error('W4B1_GETTER_FORBIDDEN');}});
  const value=kind==='PROXY'?new Proxy(fns,{}):fns;
  expect(()=>w4bRemote.createCostedRemoteOriginalPortV2(value)).toThrow(DomainError);expect(f.client.exchange).not.toHaveBeenCalled();expect(f.admit).not.toHaveBeenCalled();
});
it('W4-B1 optional callback이나 복제한 객체는 명목 비용 권위를 얻지 못하고 생성 후 methods를 고정한다',async()=>{
  const f=windowsFixture(),x=w4bCosted(f);
  expect(()=>f.controller.forCostedPort({...x.port})).toThrow('NATIVE_REMOTE_COST_PORT_UNCONFIRMED');
  expect(()=>f.controller.forPort(x.methods)).toThrow('NATIVE_REMOTE_PORT_UNCONFIRMED');
  const changed=vi.fn(async()=>{throw new Error('W4B1_REPLACED_METHOD_FORBIDDEN');});x.methods.authorizeResultQuery=changed;
  await x.run();expect(changed).not.toHaveBeenCalled();expect(x.authorizeResultQuery).toHaveBeenCalledTimes(1);expect(Object.isFrozen(x.port)).toBe(true);
});
it.each(['AUTHORIZE','FINISH'] as const)('W4-B1 %s의 null ACK는 WAIT이며 같은 원 결과를 새 requestId로 대체하지 않는다',async at=>{
  const f=windowsFixture(),x=w4bCosted(f,at==='AUTHORIZE'?{authorize:async()=>null}:{finish:async()=>null});
  await expect(x.run()).rejects.toMatchObject({version:2,nextAction:'WAIT',windowsEvidenceRef:f.ref});
  expect(f.requests.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(at==='AUTHORIZE'?0:1);
  expect(x.authorizeResultQuery).toHaveBeenCalledTimes(1);expect(x.finishResultQuery).toHaveBeenCalledTimes(at==='AUTHORIZE'?0:1);expect(f.attest).not.toHaveBeenCalled();expect(f.admit).toHaveBeenCalledTimes(1);expect(f.controller.usage().reservedBytes).toBe(0);
});
it.each(['AUTHORIZE','FINISH'] as const)('W4-B1 %s의 ACK 유실도 실제 promise 종료까지 parent 보유와 shutdown join을 유지한다',async at=>{
  const f=windowsFixture(),gate=deferred(),block=async()=>{await gate.promise;throw new Error('W4B1_COMMITTED_ACK_LOST');},x=w4bCosted(f,at==='AUTHORIZE'?{authorize:block}:{finish:block});
  const operation=x.run(),rejected=expect(operation).rejects.toMatchObject({version:2,nextAction:'WAIT'});
  while(!(at==='AUTHORIZE'?x.authorizeResultQuery:x.finishResultQuery).mock.calls.length)await new Promise(resolve=>setTimeout(resolve,1));
  let closed=false;const shutdown=f.controller.shutdown().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);expect(f.controller.usage().reservedBytes).toBeGreaterThan(0);gate.resolve();await rejected;await shutdown;
  expect(f.requests.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(at==='AUTHORIZE'?0:1);expect(f.admit).toHaveBeenCalledTimes(1);expect(f.attest).not.toHaveBeenCalled();expect(f.controller.usage().reservedBytes).toBe(0);
});
it('W4-B1 진행 pending은 metadata만 반복하고 최종 원 QUERY 하나만 등록한다',async()=>{
  const f=windowsFixture(),x=w4bCosted(f);let metadata=0;
  f.change((response,request)=>{if(request.control.command==='GO'||request.control.command==='QUERY'&&!request.control.includeRawResult&&metadata++===0)pendingWindows(response);});
  await x.run();expect(f.requests.map(r=>r.control.command==='QUERY'?r.control.includeRawResult:r.control.command)).toEqual(['PREPARE','GO',false,false,true]);expect(x.authorizeResultQuery).toHaveBeenCalledTimes(1);expect(f.attest).toHaveBeenCalledTimes(1);
});
it.each(['TRANSPORT','FINISHED_RAW_MISSING'] as const)('W4-B1 원 raw %s는 새 GET 재시도나 새 admission 없이 WAIT한다',async kind=>{
  const f=windowsFixture(),x=w4bCosted(f);f.change((response,request)=>{if(request.control.command==='QUERY'&&request.control.includeRawResult){if(kind==='TRANSPORT')throw new Error('W4B1_RAW_RESPONSE_LOST');delete response.rawResult;response.control.snapshot.rawResult=null;response.control.snapshot.code='NATIVE_RAW_RESULT_UNCONFIRMED';}});
  await expect(x.run()).rejects.toMatchObject({version:2,nextAction:'WAIT'});expect(f.requests.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(1);expect(f.admit).toHaveBeenCalledTimes(1);expect(x.authorizeResultQuery).toHaveBeenCalledTimes(1);expect(x.finishResultQuery).not.toHaveBeenCalled();expect(f.attest).not.toHaveBeenCalled();
});
it.each(['CODE','PHASE'] as const)('W4-B1 최종 raw 응답의 %s 거부를 성공 attest로 바꾸지 않는다',async kind=>{
  const f=windowsFixture(),x=w4bCosted(f);f.change((response,request)=>{if(request.control.command==='QUERY'&&request.control.includeRawResult){if(kind==='CODE')response.control.snapshot.code='NATIVE_RAW_RESULT_UNCONFIRMED';else response.control.snapshot.phase='UNKNOWN';}});
  await expect(x.run()).rejects.toMatchObject({version:2,nextAction:'WAIT'});expect(f.attest).not.toHaveBeenCalled();expect(x.finishResultQuery).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.control.command==='QUERY'&&r.control.includeRawResult)).toHaveLength(1);
});
