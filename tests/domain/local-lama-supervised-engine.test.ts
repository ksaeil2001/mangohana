import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams,SpawnOptions} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {LocalLaMaInvocationCoordinator,type LocalLaMaAttemptStore,type LocalLaMaInvocationRecord,type LocalLaMaOriginalInvocation,type LocalLaMaInvocationBinding} from '../../packages/providers/src/local-lama-executor.js';
import {localLaMaSupervisedEngine,type LocalLaMaPinnedFile,type LocalLaMaSupervisorRuntime} from '../../packages/providers/src/local-lama-supervised-engine.js';
import type {LocalLaMaCapture,LocalLaMaStartFact} from '../../packages/providers/src/local-lama.js';

// Fake process/domain ports only. These tests run no Python, model, DB, API or
// native provider and do not establish a real supervised runtime or image QA.
const transport=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:transport.spawn}));
const CANDIDATE='C:/Users/ksaei/AppData/Local/Temp/codex-trio-web-validation-01a1018a/run-tmp/runtime-direction-4739cf8cbe8040a89f7415afaeee9135/st';
const TEMPLATE=path.join(path.dirname(CANDIDATE),'real-model-synthetic-5e1f0267-df19-417e-a4f2-a3d61d16dc7d');
const SOURCE_SHA='4e40c5eece914d30ea16c3aafc0699f46e07c924c98f3aeecc6dcb8642b53cf8';
const limits={processCount:3,processMemoryBytes:3221225472,jobMemoryBytes:4294967296,timeoutMs:600000,joinTimeoutMs:3000,stdoutBytes:1048576,stderrBytes:1048576,observationBytes:2048,maxOutputBytes:4194304};
const bounds={maxEncodedBytes:4096,maxMetadataBytes:16384,maxInFlightBytes:4*1024*1024,maxConcurrentCalls:2,maxRecords:24};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
function copy<T>(value:T):T{if(Buffer.isBuffer(value))return Buffer.from(value) as T;if(Array.isArray(value))return value.map(copy) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;return value;}
function pngFixture(tag:string){const bytes=Buffer.alloc(32+Buffer.byteLength(tag));Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(663,16);bytes.writeUInt32BE(937,20);bytes.write(tag,32);return bytes;}
async function fixture(){
  const parent=path.join(CANDIDATE,'unit-fake-runs');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'case-')),modelRoot=path.join(root,'fixture-model');await fs.mkdir(modelRoot);
  const local=async(name:string,body:string):Promise<LocalLaMaPinnedFile>=>{const file=path.join(root,name),bytes=Buffer.from(body);await fs.writeFile(file,bytes,{flag:'wx'});return {file,bytes:bytes.length,sha256:sha256(bytes)};};
  await fs.mkdir(path.join(modelRoot,'models'));const weights=await local('fixture-model/models/best.ckpt','FAKE UNIT WEIGHTS'),config=await local('fixture-model/config.yaml','FAKE UNIT CONFIG'),dependencyReceipt=await local('fake-dependency-receipt','FAKE UNIT DEPENDENCY'),importPin=await local('fake-import','FAKE UNIT IMPORT');
  const runtime:LocalLaMaSupervisorRuntime={root,modelRoot,systemRoot:'C:/Windows',windowsDirectory:'C:/Windows',python:{file:'C:/Users/ksaei/AppData/Local/Programs/Python/Python310/python.exe',bytes:103192,sha256:'47942e1f899c5b0ccd23ba0730adbbc979b1488e0f2e5274abf398360877b7ec'},bootstrap:{file:path.join(TEMPLATE,'original_lama_bootstrap.py'),bytes:20838,sha256:'2be3a0bc64cc6aa0a83d2ddaddd643ffa997283d7c5cf5c0fec15a046901d73b'},supervisor:{file:path.join(TEMPLATE,'original_lama_supervisor.py'),bytes:42023,sha256:'b9603cfd26fb5e375fcdfc7b6c2591975763c14c708ef19c566b4f5870df3545'},weights,config,dependencyReceipt,importEvidence:[importPin],limits};
  const image=pngFixture('FAKE INPUT'),mask=pngFixture('FAKE MASK'),proposal=pngFixture('FAKE MODEL PROPOSAL'),executionId=randomUUID(),inputDigest=sha256('fake-owned-input');
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest,profileId:'unit-fake-profile',profileDigest:sha256('fake-profile'),identity:{codeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7',weightsSha256:weights.sha256,configSha256:config.sha256,weightsLicenseVerified:true,runtimeVerified:true},imageSha256:sha256(image),imageByteLength:image.length,maskSha256:sha256(mask),maskByteLength:mask.length};
  const capture:LocalLaMaCapture={...body,captureDigest:digest(body)},binding:LocalLaMaInvocationBinding={version:1,accountId:randomUUID(),requestId:randomUUID(),executionId,inputDigest,inputFingerprint:sha256('fake-canonical-input'),fullStageCaptureDigest:sha256('fake-full-cost-capture'),localCaptureDigest:capture.captureDigest,mode:'FREE'};
  const original:LocalLaMaOriginalInvocation={version:1,bindingDigest:digest(binding),localCaptureDigest:capture.captureDigest,invocationId:randomUUID()};let claimed=false;const records:LocalLaMaInvocationRecord[]=[];
  const snapshot=()=>({version:1 as const,original:copy(original),records:copy(records)});
  const claim=vi.fn<LocalLaMaAttemptStore['claim']>(async()=>{const created=!claimed;claimed=true;return {...snapshot(),created};}),lookup=vi.fn<LocalLaMaAttemptStore['lookup']>(async()=>claimed?snapshot():null),append=vi.fn<LocalLaMaAttemptStore['append']>(async(_binding,_original,record)=>{if(!records.some(old=>old.recordDigest===record.recordDigest))records.push(copy(record));});
  const attempts={claim,lookup,append},create=(next=runtime)=>localLaMaSupervisedEngine({runtime:next,binding,capture,attempts}),producer=create(),input={capture,image,mask};
  const coordinator=(selected=producer)=>new LocalLaMaInvocationCoordinator({binding,capture,attempts,engine:selected.engine,bounds,costs:{lookup:async()=>null}});
  const direct=async(selected=producer,onStarted:(fact:LocalLaMaStartFact)=>Promise<void>=vi.fn(async()=>{}))=>{await claim(binding,capture);return selected.engine.submit({binding,original,input},onStarted);};
  return {root,runtime,binding,capture,original,input,proposal,records,claim,lookup,append,create,producer,coordinator,direct};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Mode='SUCCESS'|'RESULT_ONLY_FAILURE'|'STDOUT_OVERFLOW'|'STDERR_OVERFLOW'|'NO_STDOUT_EOF'|'READ_ERROR'|'SPAWN_ERROR'|'SPAWN_THROW'|'REPORT_MISSING'|'OUTPUT_MISSING'|'FALSE_PHYSICAL_JOIN'|'BAD_IDENTITY'|'EXIT_OUTPUT_ONLY'|'OBS_EXTRA_KEY'|'FRAME_EXTRA_KEY'|'OBS_NONCE'|'OBS_ORIGINAL'|'OBS_CAPTURE'|'OBS_COMMIT'|'OBS_SOURCE'|'OBS_MODEL_LINE'|'OBS_RETURN_LINE'|'OBS_VERSION'|'OBS_KIND'|'OBS_DUPLICATE'|'OBS_AFTER_RESULT'|'OBS_TRUNCATED'|'RESULT_TRUNCATED'|'RESULT_EXTRA_KEY'|'RESULT_DUPLICATE'|'NONZERO_EXIT'|'OUTPUT_BAD_PIN'|'REPORT_OUTPUT_ERROR'|'OBS_SPLIT'|'PAUSE_AFTER_OBSERVATION';
function fakeProcess(f:Fixture,mode:Mode='SUCCESS'){
  const observationSent=deferred<void>(),release=deferred<void>(),closeObserved=deferred<void>();
  transport.spawn.mockImplementation((file:string,args:readonly string[],options:SpawnOptions)=>{
    expect(file).toBe(f.runtime.python.file);expect(args.slice(0,3)).toEqual(['-I','-S','-B']);expect(args[4]).toBe('--private-request');expect(options.windowsHide).toBe(true);expect(options.stdio).toEqual(['ignore','pipe','pipe']);expect(f.records).toHaveLength(0);
    if(mode==='SPAWN_THROW')throw Error('FAKE SPAWN THROW');
    const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough();Object.assign(child,{stdout,stderr});
    const perform=async()=>{
      const requestFile=args[5],run=path.dirname(requestFile),requestBytes=await fs.readFile(requestFile),request=JSON.parse(requestBytes.toString('utf8')) as {identity:{nonce:string;originalId:string;captureDigest:string};limits:typeof limits;paths:{runRoot:string;modelRoot:string}};
      // Directly observes the launch-time closed layout; the original scripts
      // themselves are read as pinned bytes and never run by this fake.
      expect((await fs.readdir(run)).sort()).toEqual(['input','output','request.json','work']);expect((await fs.readdir(path.join(run,'input'))).sort()).toEqual(['image.png','image_mask001.png']);expect(await fs.readdir(path.join(run,'output'))).toEqual([]);expect(await fs.readdir(path.join(run,'work'))).toEqual([]);expect(request.limits).toEqual(limits);expect(request.paths.runRoot).toBe(run);expect(request.paths.modelRoot).toBe(f.runtime.modelRoot);
      const failed=mode==='RESULT_ONLY_FAILURE',observation:Record<string,unknown>|null=failed||mode==='EXIT_OUTPUT_ONLY'?null:{version:1,kind:'INFERENCE_COMPLETED_OBSERVATION',originalCommit:f.capture.identity.codeCommit,sourceSha256:SOURCE_SHA,modelCallLine:85,observationLine:86,...request.identity};
      if(observation){
        if(mode==='OBS_EXTRA_KEY')observation.extra='UNTRUSTED';if(mode==='OBS_NONCE')observation.nonce=sha256('foreign-nonce');if(mode==='OBS_ORIGINAL')observation.originalId=randomUUID();if(mode==='OBS_CAPTURE')observation.captureDigest=sha256('foreign-capture');if(mode==='OBS_COMMIT')observation.originalCommit=sha256('foreign-commit').slice(0,40);if(mode==='OBS_SOURCE')observation.sourceSha256=sha256('foreign-source');if(mode==='OBS_MODEL_LINE')observation.modelCallLine=84;if(mode==='OBS_RETURN_LINE')observation.observationLine=87;if(mode==='OBS_VERSION')observation.version=2;if(mode==='OBS_KIND')observation.kind='START';
      }
      const pipe={eofObserved:true,overflow:false,readError:null},report={version:1,identity:mode==='BAD_IDENTITY'?{...request.identity,originalId:randomUUID()}:request.identity,originalCommit:f.capture.identity.codeCommit,sourceSha256:SOURCE_SHA,requestSha256:sha256(requestBytes),requestedLimits:request.limits,physicalJoined:mode!=='FALSE_PHYSICAL_JOIN',lastVerifiedActiveCount:0,workerExitObserved:true,jobHandleClosed:true,pipes:{observation:pipe,stdout:pipe,stderr:pipe},workerExitCode:failed||mode==='NONZERO_EXIT'?1:0,processOutcome:failed?'FAILED_WITHOUT_MODEL_RETURN':mode==='NONZERO_EXIT'?'FAILED_AFTER_MODEL_RETURN_OBSERVATION':mode==='EXIT_OUTPUT_ONLY'?'COMPLETED_WITHOUT_MODEL_RETURN_OBSERVATION':'COMPLETED_WITH_MODEL_RETURN_OBSERVATION',timedOut:false,joinDeadlineExceeded:false,protocolError:false,parentPipeError:false,overflow:false,errorCount:failed||mode==='NONZERO_EXIT'?1:0,observationDelivery:{attempted:observation!==null,complete:observation!==null,error:null,pending:false},observation,output:failed?null:{path:path.join(run,'output/image_mask001.png'),bytes:f.proposal.length,sha256:mode==='OUTPUT_BAD_PIN'?sha256('different-output'):sha256(f.proposal),width:663,height:937,error:mode==='REPORT_OUTPUT_ERROR'?'FAKE_OUTPUT_ERROR':null,headerVerified:true,fullDecodeOrQa:false}};
      if(mode!=='REPORT_MISSING')await fs.writeFile(path.join(run,'supervisor-report.json'),JSON.stringify(report)+'\n',{flag:'wx'});
      if(!failed&&mode!=='OUTPUT_MISSING')await fs.writeFile(path.join(run,'output/image_mask001.png'),f.proposal,{flag:'wx'});
      const first=observation?JSON.stringify({version:1,kind:'OBSERVATION',observation,...(mode==='FRAME_EXTRA_KEY'?{extra:'UNTRUSTED'}:{})})+'\n':'',last=JSON.stringify({version:1,kind:'RESULT',report,...(mode==='RESULT_EXTRA_KEY'?{extra:'UNTRUSTED'}:{})})+'\n';
      let frames=first+last;if(mode==='OBS_DUPLICATE')frames=first+first+last;if(mode==='RESULT_DUPLICATE')frames+=last;if(mode==='OBS_AFTER_RESULT')frames=last+first;if(mode==='OBS_TRUNCATED')frames=first.slice(0,-2);if(mode==='RESULT_TRUNCATED')frames=first+last.slice(0,-2);
      if(mode==='PAUSE_AFTER_OBSERVATION'){stdout.write(first);observationSent.resolve();await release.promise;stdout.write(last);}else if(mode==='OBS_SPLIT'){const bytes=Buffer.from(frames);for(let at=0;at<bytes.length;at+=7)stdout.write(bytes.subarray(at,at+7));}else stdout.write(mode==='STDOUT_OVERFLOW'?Buffer.alloc(65537,65):frames);
      if(mode==='STDERR_OVERFLOW')stderr.write(Buffer.alloc(limits.stderrBytes+1,66));
      if(mode==='READ_ERROR')stdout.emit('error',Error('FAKE PIPE READ ERROR'));if(mode==='SPAWN_ERROR')child.emit('error',Error('FAKE SPAWN ERROR'));
      const ended=mode==='NO_STDOUT_EOF'?Promise.resolve():new Promise<void>(done=>stdout.once('end',done)),stderrEnded=new Promise<void>(done=>stderr.once('end',done));if(mode!=='NO_STDOUT_EOF')stdout.end();stderr.end();await Promise.all([ended,stderrEnded]);child.emit('close',failed||mode==='NONZERO_EXIT'?1:0,null);closeObserved.resolve();
    };
    void perform().catch(error=>{child.emit('error',error);stdout.end();stderr.end();setImmediate(()=>child.emit('close',1,null));});return child as ChildProcessWithoutNullStreams;
  });
  return {observationSent,release,closeObserved};
}
beforeEach(()=>{transport.spawn.mockReset();});
afterEach(()=>{vi.restoreAllMocks();});
describe('Temp supervised producer with builtin spawn mocked and fake durable authority',()=>{
  it('preserves verified late START before an owning output read settles',async()=>{
    const f=await fixture();fakeProcess(f);const entered=deferred<void>(),release=deferred<void>(),open=fs.open.bind(fs),started=vi.fn(async(_fact:LocalLaMaStartFact)=>{});
    vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).replaceAll('\\','/').endsWith('output/image_mask001.png')){entered.resolve();await release.promise;}return handle;});
    const handle=await f.direct(f.producer,started);
    try{await Promise.race([entered.promise,handle.reply.then(()=>{throw Error('REPLY_SETTLED_BEFORE_OWNING_READ');},error=>{throw error;})]);expect(started).toHaveBeenCalledOnce();expect(started.mock.calls[0][0]).toMatchObject({captureDigest:f.capture.captureDigest,runtime:{invocationId:f.original.invocationId}});expect(f.producer.counts).toMatchObject({actualModelCalls:1,closed:false});}
    finally{release.resolve();await Promise.allSettled([handle.reply,handle.joined]);}
  });
  it('submits after first durable claim and journals late START before raw reply without full-cost promotion',async()=>{
    const f=await fixture();fakeProcess(f);const started=vi.fn(async()=>{}),result=await f.coordinator().dispatch(f.input,started);
    expect(result).toMatchObject({state:'SUCCEEDED',providerSuccess:true,start:{captureDigest:f.capture.captureDigest,runtime:{invocationId:f.original.invocationId}},fullCost:null});expect(result.proposal!.bytes).toEqual(f.proposal);expect(started).toHaveBeenCalledOnce();expect(started.mock.calls[0]).toEqual([result.start]);expect(f.claim).toHaveBeenCalledOnce();expect(f.records.map(row=>row.kind)).toEqual(['START','ENGINE_REPLY']);expect(f.producer.counts).toMatchObject({submit:1,query:0,supervisorLaunches:1,actualModelCalls:1,closed:true});expect(transport.spawn).toHaveBeenCalledOnce();
    const before=copy(f.records),restored=await f.coordinator().lookup(f.capture);expect(restored).toEqual(result);expect(f.records).toEqual(before);expect(f.producer.counts).toMatchObject({submit:1,query:1,supervisorLaunches:1});expect(transport.spawn).toHaveBeenCalledOnce();
    const fresh=f.create(),afterRestart=await f.coordinator(fresh).lookup(f.capture);expect(afterRestart).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:result.start,fullCost:null});expect(fresh.counts).toMatchObject({submit:0,query:1,supervisorLaunches:0,actualModelCalls:0,closed:false});expect(f.records.some(record=>record.kind==='HOLD'&&record.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('returns synchronous native handles and rejects repeat submit',async()=>{
    const f=await fixture();fakeProcess(f);const handle=await f.direct();expect(handle.reply).toBeInstanceOf(Promise);expect(handle.joined).toBeInstanceOf(Promise);expect(Object.getPrototypeOf(handle.reply)).toBe(Promise.prototype);expect(Object.getPrototypeOf(handle.joined)).toBe(Promise.prototype);await expect(handle.reply).resolves.toMatchObject({state:'SUCCEEDED',start:{captureDigest:f.capture.captureDigest},fullCost:null});await expect(handle.joined).resolves.toBeUndefined();expect(()=>f.producer.engine.submit({binding:f.binding,original:f.original,input:f.input},vi.fn())).toThrow();expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('rejects unclaimed original before launch and retains lifetime HOLD',async()=>{
    const f=await fixture();fakeProcess(f);const handle=f.producer.engine.submit({binding:f.binding,original:f.original,input:f.input},vi.fn());await expect(handle.reply).rejects.toThrow();await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(transport.spawn).not.toHaveBeenCalled();
  });
  it('never considers a RESULT-only model failure successful, but can join its physical close',async()=>{
    const f=await fixture();fakeProcess(f,'RESULT_ONLY_FAILURE');const handle=await f.direct();await expect(handle.reply).rejects.toThrow();await expect(handle.joined).resolves.toBeUndefined();expect(f.producer.counts).toMatchObject({closed:true,actualModelCalls:0});expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it.each(['STDOUT_OVERFLOW','SPAWN_THROW'] as const)('rejects %s without START or automatic retry',async mode=>{
    const f=await fixture();fakeProcess(f,mode);const handle=await f.direct();await expect(handle.reply).rejects.toThrow();await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(f.producer.counts.closed).toBe(false);expect(transport.spawn).toHaveBeenCalledOnce();expect(f.producer.counts.actualModelCalls).toBe(0);
  });
  it.each(['STDERR_OVERFLOW','NO_STDOUT_EOF','READ_ERROR','SPAWN_ERROR','REPORT_MISSING','FALSE_PHYSICAL_JOIN','BAD_IDENTITY'] as const)('preserves a prior verified START after %s without claiming lifetime closure',async mode=>{
    const f=await fixture();fakeProcess(f,mode);const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),handle=await f.direct(f.producer,started);await expect(handle.reply).resolves.toMatchObject({state:'UNKNOWN',start:{captureDigest:f.capture.captureDigest},providerSuccess:true,proposal:null,fullCost:null});await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(started).toHaveBeenCalledOnce();expect(f.producer.counts).toMatchObject({closed:false,actualModelCalls:1});expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('keeps a post-close output read error unsuccessful while joining all remaining processing',async()=>{
    const f=await fixture();fakeProcess(f,'OUTPUT_MISSING');const handle=await f.direct();await expect(handle.reply).resolves.toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},proposal:null,fullCost:null});await expect(handle.joined).resolves.toBeUndefined();expect(f.producer.counts.closed).toBe(true);
  });
  it('delivers the pinned normal-return fact before RESULT and physical close',async()=>{
    const f=await fixture(),control=fakeProcess(f,'PAUSE_AFTER_OBSERVATION'),entered=deferred<void>(),started=vi.fn(async(_fact:LocalLaMaStartFact)=>{entered.resolve();}),handle=await f.direct(f.producer,started);let replied=false,joined=false;void handle.reply.then(()=>{replied=true;},()=>undefined);void handle.joined.then(()=>{joined=true;},()=>undefined);
    try{await control.observationSent.promise;await entered.promise;expect(started).toHaveBeenCalledOnce();expect(f.producer.counts).toMatchObject({actualModelCalls:1,closed:false});expect(replied).toBe(false);expect(joined).toBe(false);}
    finally{control.release.resolve();await handle.reply;await handle.joined;}
  });
  it.each(['SUCCESS','OUTPUT_MISSING','RESULT_TRUNCATED'] as const)('joins a pending START callback after %s before settling reply or joined',async mode=>{
    const f=await fixture(),control=fakeProcess(f,mode),entered=deferred<void>(),release=deferred<void>(),started=vi.fn(async(_fact:LocalLaMaStartFact)=>{entered.resolve();await release.promise;}),handle=await f.direct(f.producer,started);let replied=false,joined=false;void handle.reply.then(()=>{replied=true;},()=>undefined);void handle.joined.then(()=>{joined=true;},()=>undefined);
    try{await entered.promise;await control.closeObserved.promise;await new Promise<void>(done=>setImmediate(done));expect(started).toHaveBeenCalledOnce();expect(replied).toBe(false);expect(joined).toBe(false);expect(f.producer.counts.closed).toBe(false);}
    finally{release.resolve();}
    await expect(handle.reply).resolves.toMatchObject({state:mode==='SUCCESS'?'SUCCEEDED':'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},fullCost:null});if(mode==='RESULT_TRUNCATED')await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});else await expect(handle.joined).resolves.toBeUndefined();
  });
  it('keeps START, verified raw and a durable START_IO HOLD after callback rejection and same-instance lookup',async()=>{
    const f=await fixture();fakeProcess(f);const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{throw Error('FAKE START CALLBACK REJECTED');}),result=await f.coordinator().dispatch(f.input,started);
    expect(result).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},fullCost:null});expect(result.proposal!.bytes).toEqual(f.proposal);expect(started).toHaveBeenCalledOnce();expect(f.records.map(row=>row.kind)).toEqual(['START','ENGINE_REPLY','HOLD']);expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_START_IO_UNCONFIRMED')).toBe(true);
    const before=copy(f.records),restored=await f.coordinator().lookup(f.capture);expect(restored).toEqual(result);expect(f.records).toEqual(before);expect(started).toHaveBeenCalledOnce();expect(f.producer.counts).toMatchObject({submit:1,query:1,supervisorLaunches:1,actualModelCalls:1,closed:true});
  });
  it.each(['OBS_EXTRA_KEY','FRAME_EXTRA_KEY','OBS_NONCE','OBS_ORIGINAL','OBS_CAPTURE','OBS_COMMIT','OBS_SOURCE','OBS_MODEL_LINE','OBS_RETURN_LINE','OBS_VERSION','OBS_KIND','OBS_AFTER_RESULT','OBS_TRUNCATED'] as const)('does not create START from invalid, unbound or unordered %s',async mode=>{
    const f=await fixture();fakeProcess(f,mode);const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),handle=await f.direct(f.producer,started);await expect(handle.reply).rejects.toThrow();await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(started).not.toHaveBeenCalled();expect(f.producer.counts).toMatchObject({actualModelCalls:0,closed:false});expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it.each(['OBS_DUPLICATE','RESULT_DUPLICATE','RESULT_EXTRA_KEY','RESULT_TRUNCATED'] as const)('retains one earlier START after %s but never accepts the later protocol as closed',async mode=>{
    const f=await fixture();fakeProcess(f,mode);const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),handle=await f.direct(f.producer,started);await expect(handle.reply).resolves.toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},proposal:null,fullCost:null});await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(started).toHaveBeenCalledOnce();expect(f.producer.counts).toMatchObject({actualModelCalls:1,closed:false});
  });
  it.each(['NONZERO_EXIT','OUTPUT_BAD_PIN','REPORT_OUTPUT_ERROR'] as const)('preserves START after %s while a valid physical close does not imply output success',async mode=>{
    const f=await fixture();fakeProcess(f,mode);const handle=await f.direct();await expect(handle.reply).resolves.toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},proposal:null,fullCost:null});await expect(handle.joined).resolves.toBeUndefined();expect(f.producer.counts).toMatchObject({actualModelCalls:1,closed:true});
  });
  it('does not infer START from exit zero, a PNG and matching RESULT metadata alone',async()=>{
    const f=await fixture();fakeProcess(f,'EXIT_OUTPUT_ONLY');const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),handle=await f.direct(f.producer,started);await expect(handle.reply).rejects.toThrow();await expect(handle.joined).resolves.toBeUndefined();expect(started).not.toHaveBeenCalled();expect(f.producer.counts).toMatchObject({actualModelCalls:0,closed:true});
  });
  it('handles newline frames split across data events without delaying or duplicating START',async()=>{
    const f=await fixture();fakeProcess(f,'OBS_SPLIT');const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),handle=await f.direct(f.producer,started),result=await handle.reply;await handle.joined;expect(result).toMatchObject({state:'SUCCEEDED',start:{captureDigest:f.capture.captureDigest},fullCost:null});expect(started).toHaveBeenCalledOnce();expect(f.producer.counts.actualModelCalls).toBe(1);
  });
  it('isolates callback, returned START, runtime and raw mutations from stable original queries',async()=>{
    const f=await fixture();fakeProcess(f);const started=vi.fn(async(fact:LocalLaMaStartFact)=>{Object.assign(fact,{captureDigest:sha256('CALLBACK MUTATION')});Object.assign(fact.runtime,{invocationId:randomUUID(),executionId:randomUUID()});}),handle=await f.direct(f.producer,started),result=await handle.reply;await handle.joined;expect(result).toMatchObject({state:'SUCCEEDED',start:{captureDigest:f.capture.captureDigest,runtime:{invocationId:f.original.invocationId}}});
    const original=copy(result);Object.assign(result!.runtime,{invocationId:randomUUID()});Object.assign(result!.start!,{captureDigest:sha256('RETURN MUTATION')});Object.assign(result!.start!.runtime,{executionId:randomUUID()});result!.proposal!.bytes.fill(0);
    const request={binding:f.binding,original:f.original,capture:f.capture},first=f.producer.engine.query(request),restored=await first.reply;await first.joined;expect(restored).toEqual(original);restored!.proposal!.bytes.fill(1);Object.assign(restored!.start!.runtime,{invocationId:randomUUID()});const second=f.producer.engine.query(request);expect(await second.reply).toEqual(original);await second.joined;expect(started).toHaveBeenCalledOnce();expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('does not join a pending output handle close or its same-instance query prematurely',async()=>{
    const f=await fixture();fakeProcess(f);const entered=deferred<void>(),release=deferred<void>(),open=fs.open.bind(fs);vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).replaceAll('\\','/').endsWith('output/image_mask001.png')){const close=handle.close.bind(handle);vi.spyOn(handle,'close').mockImplementation(async()=>{entered.resolve();await release.promise;return close();});}return handle;});
    const handle=await f.direct();let joined=false,replied=false;void handle.joined.then(()=>{joined=true;},()=>undefined);void handle.reply.then(()=>{replied=true;},()=>undefined);await entered.promise;const query=f.producer.engine.query({binding:f.binding,original:f.original,capture:f.capture});let queryJoined=false;void query.joined.then(()=>{queryJoined=true;},()=>undefined);
    try{await new Promise<void>(done=>setImmediate(done));expect(joined).toBe(false);expect(replied).toBe(false);expect(queryJoined).toBe(false);expect(f.producer.counts.closed).toBe(false);}
    finally{release.resolve();await handle.reply;await handle.joined;await query.reply;await query.joined;}
  });
  it('retains START and original lifetime HOLD after an output close rejection across same-instance lookup',async()=>{
    const f=await fixture();fakeProcess(f);const open=fs.open.bind(fs);vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{const handle=await open(...args);if(String(args[0]).replaceAll('\\','/').endsWith('output/image_mask001.png')){const close=handle.close.bind(handle);vi.spyOn(handle,'close').mockImplementation(async()=>{await close();throw Error('FAKE OUTPUT CLOSE UNCONFIRMED');});}return handle;});
    const started=vi.fn(async(_fact:LocalLaMaStartFact)=>{}),result=await f.coordinator().dispatch(f.input,started);expect(result).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},proposal:null,fullCost:null});expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);
    const before=copy(f.records),restored=await f.coordinator().lookup(f.capture);expect(restored).toEqual(result);expect(f.records).toEqual(before);expect(started).toHaveBeenCalledOnce();expect(f.producer.counts).toMatchObject({actualModelCalls:1,closed:false,query:1});expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('retains already verified raw and START if the owning result write fails without claiming parent I/O joined',async()=>{
    const f=await fixture();fakeProcess(f);const write=fs.writeFile.bind(fs);vi.spyOn(fs,'writeFile').mockImplementation(async(...args:Parameters<typeof fs.writeFile>)=>{if(String(args[0]).endsWith('component-result.json'))throw Error('FAKE OWNING WRITE UNCONFIRMED');return write(...args);});
    const handle=await f.direct(),result=await handle.reply;expect(result).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},fullCost:null});expect(result!.proposal!.bytes).toEqual(f.proposal);await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(f.producer.counts.closed).toBe(false);
  });
  it('does not settle join after physical close until the owning result-file write completes',async()=>{
    const f=await fixture();fakeProcess(f);const io=deferred<void>(),write=fs.writeFile.bind(fs),entered=deferred<void>();vi.spyOn(fs,'writeFile').mockImplementation(async(...args:Parameters<typeof fs.writeFile>)=>{if(String(args[0]).endsWith('component-result.json')){entered.resolve();await io.promise;}return write(...args);});
    const handle=await f.direct();let replied=false,joined=false;void handle.reply.then(()=>{replied=true;},()=>undefined);void handle.joined.then(()=>{joined=true;},()=>undefined);await Promise.race([entered.promise,handle.reply.then(()=>{throw Error('RESULT_SETTLED_BEFORE_OWNING_WRITE');})]);expect(replied).toBe(false);expect(joined).toBe(false);expect(f.producer.counts.closed).toBe(false);io.resolve();await handle.reply;await handle.joined;expect(replied).toBe(true);expect(joined).toBe(true);
  });
  it('rejects original/binding/capture mismatches before selecting another original handle',async()=>{
    const f=await fixture();fakeProcess(f);const handle=await f.direct();await handle.reply;await handle.joined;f.lookup.mockClear();const query={binding:f.binding,original:f.original,capture:f.capture};
    expect(()=>f.producer.engine.query({...query,original:{...f.original,invocationId:randomUUID()}})).toThrow();expect(()=>f.producer.engine.query({...query,binding:{...f.binding,requestId:randomUUID()}})).toThrow();expect(()=>f.producer.engine.query({...query,capture:{...f.capture,inputDigest:sha256('foreign-input')}})).toThrow();expect(f.lookup).not.toHaveBeenCalled();expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('rechecks original store authority for same-instance query, even after successful join',async()=>{
    const f=await fixture();fakeProcess(f);const handle=await f.direct();await handle.reply;await handle.joined;f.lookup.mockResolvedValueOnce({version:1,original:{...f.original,invocationId:randomUUID()},records:[]});const queried=f.producer.engine.query({binding:f.binding,original:f.original,capture:f.capture});await expect(queried.reply).rejects.toThrow();await expect(queried.joined).rejects.toThrow();expect(transport.spawn).toHaveBeenCalledOnce();
  });
  it('fresh instance query rejects lifetime even without any files or raw evidence to inspect',async()=>{
    const f=await fixture(),queried=f.producer.engine.query({binding:f.binding,original:f.original,capture:f.capture});await expect(queried.reply).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});await expect(queried.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(f.lookup).not.toHaveBeenCalled();expect(transport.spawn).not.toHaveBeenCalled();
  });
  it.each(['python','bootstrap','supervisor'] as const)('rejects a changed preserved %s source pin before any launch',async key=>{
    const f=await fixture();expect(()=>f.create({...f.runtime,[key]:{...f.runtime[key],sha256:sha256('different-source')}})).toThrow();expect(transport.spawn).not.toHaveBeenCalled();
  });
  it.each(['weights','config'] as const)('rejects a pinned %s file outside the supervisor model alias before launch',async key=>{
    const f=await fixture();expect(()=>f.create({...f.runtime,[key]:{...f.runtime[key],file:path.join(f.root,'different-pinned-model-file')}})).toThrow();expect(transport.spawn).not.toHaveBeenCalled();
  });
  it.each(['WRONG_PIN','MISSING_FILE','OVERSIZE','SYMLINK'] as const)('rejects bounded regular-file %s before creating a child',async mode=>{
    const f=await fixture();let runtime=copy(f.runtime);
    if(mode==='WRONG_PIN')runtime={...runtime,dependencyReceipt:{...runtime.dependencyReceipt,sha256:sha256('wrong')}};
    if(mode==='MISSING_FILE')runtime={...runtime,dependencyReceipt:{...runtime.dependencyReceipt,file:path.join(f.root,'absent')}};
    if(mode==='OVERSIZE')runtime={...runtime,dependencyReceipt:{...runtime.dependencyReceipt,bytes:2*1024*1024*1024+1}};
    if(mode==='SYMLINK'){const lstat=fs.lstat.bind(fs);vi.spyOn(fs,'lstat').mockImplementation(async(...args:Parameters<typeof fs.lstat>)=>{const value=await lstat(...args);if(String(args[0])===runtime.dependencyReceipt.file)return Object.assign(Object.create(Object.getPrototypeOf(value)) as typeof value,value,{isSymbolicLink:()=>true});return value;});}
    const handle=await f.direct(f.create(runtime));await expect(handle.reply).rejects.toThrow();await expect(handle.joined).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED'});expect(transport.spawn).not.toHaveBeenCalled();
  });
  it('rejects changed image/mask pins before copying bytes or invoking a child',async()=>{
    const f=await fixture();await f.claim(f.binding,f.capture);expect(()=>f.producer.engine.submit({binding:f.binding,original:f.original,input:{...f.input,image:pngFixture('different')}},vi.fn())).toThrow();expect(()=>f.producer.engine.submit({binding:f.binding,original:f.original,input:{...f.input,mask:pngFixture('different')}},vi.fn())).toThrow();expect(transport.spawn).not.toHaveBeenCalled();
  });
});
