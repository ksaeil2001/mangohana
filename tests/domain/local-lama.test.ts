import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {LocalLaMaAdapter,type LocalLaMaInput,type LocalLaMaOptions,type LocalLaMaCapture,type LocalLaMaRuntimeFacts,type LocalLaMaStartFact,type LocalLaMaExecutorReply,type LocalLaMaFullCost,type OwnedCleanupInput} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError,createNativeJob,type NativeRunner} from '../../packages/native/src/dto.js';
import {compute} from '../../packages/native/src/kernel.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';

const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const png=(bytes:Buffer)=>sharp(bytes,{raw:{width:4,height:4,channels:4}}).png().toBuffer();
async function fixture(){
  const raw=Buffer.alloc(64);for(let at=0;at<raw.length;at+=4){raw[at]=20+at;raw[at+1]=40;raw[at+2]=60;raw[at+3]=at===0?120:255;}
  const maskRaw=Buffer.alloc(64);for(let at=0;at<64;at+=4)maskRaw[at+3]=255;maskRaw.fill(255,20,24);
  const input:LocalLaMaInput={executionId:randomUUID(),inputDigest:sha256('owned-local-lama-input'),image:await png(raw),mask:await png(maskRaw)};
  const proposal=await png(Buffer.alloc(64,255)),invocationId=randomUUID(),startEvidenceId=randomUUID(),replyEvidenceId=randomUUID();
  const runtime=(capture:LocalLaMaCapture):LocalLaMaRuntimeFacts=>({version:1,kind:'LOCAL_LAMA',invocationId,executionId:capture.executionId,inputDigest:capture.inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)});
  const start=(capture:LocalLaMaCapture):LocalLaMaStartFact=>({version:1,evidenceId:startEvidenceId,captureDigest:capture.captureDigest,runtime:runtime(capture)});
  const cost=(capture:LocalLaMaCapture,actualUsd='0.020000000000'):LocalLaMaFullCost=>({version:1,scope:'FULL_STAGE_PROCESS',captureDigest:capture.captureDigest,runtimeDigest:digest(runtime(capture)),actualUsd,evidenceRef:'owned-full-process-cost-fact',basisVersion:'owned-fixture-only-v1'});
  const reply=(capture:LocalLaMaCapture,withStart=true,fullCost:LocalLaMaFullCost|null=null):LocalLaMaExecutorReply=>({version:1,evidenceId:replyEvidenceId,captureDigest:capture.captureDigest,runtime:runtime(capture),state:'SUCCEEDED',providerSuccess:true,start:withStart?start(capture):null,fullCost,proposal:{sha256:sha256(proposal),byteLength:proposal.length,bytes:proposal}});
  const dispatch=vi.fn(async({capture}:Parameters<LocalLaMaOptions['executor']['dispatch']>[0],onStarted:Parameters<LocalLaMaOptions['executor']['dispatch']>[1])=>{await onStarted(start(capture));return reply(capture);});
  const lookup=vi.fn<LocalLaMaOptions['executor']['lookup']>(async(capture:LocalLaMaCapture)=>reply(capture));
  const nativeRun=vi.fn<NativeRunner['run']>(async(task,metadata,blobs)=>{expect(task).toBe('COMPOSITE_MASKED');const job=createNativeJob(task,digest(metadata.profile),metadata,blobs,{maxMetadataBytes:16384,maxBinaryBytes:16384,maxItems:3});return compute({envelope:job,blobs},'unused-owned-composite-fixture');});
  // This runs the fixed pure kernel in-process using owned PNGs. It is not a
  // child, model, host isolation, DB binding or production measurement test.
  const context={native:new NativeFacade({run:nativeRun})};
  const options:LocalLaMaOptions={enabled:true,identity:{codeCommit:lamaCodeCommit,weightsSha256:'a'.repeat(64),configSha256:'b'.repeat(64),weightsLicenseVerified:true,runtimeVerified:true},profile:{...syntheticProfile,id:'owned-local-lama-unit-v1',kind:'MEASURED',maxImageBytes:4096,maxWidth:4,maxHeight:4,maxPixels:16},executor:{dispatch,lookup},bounds:{maxCapturedExecutions:8,maxInFlightBytes:256*1024}};
  const error=()=>new NativeJobError('NATIVE_JOB_TIMEOUT',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-unknown-native-input'),profileDigest:digest(options.profile),goAttempted:true,startedComputation:true,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'});
  return {raw,maskRaw,input,proposal,options,context,nativeRun,dispatch,lookup,runtime,start,cost,reply,error};
}

describe('private local LaMa adapter with owned PNGs and fake executor/kernel facts',()=>{
  it('validates before dispatch, uses only the executor START callback and preserves every outside RGBA channel',async()=>{
    const f=await fixture(),adapter=new LocalLaMaAdapter(f.options),started=vi.fn();const before=Buffer.from(f.input.image);const result=await adapter.dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'SUCCEEDED',started:true,providerSuccess:true,costUsd:null,usageConfirmed:false,outsideChangedPixels:0,backgroundQa:'NEEDS_REVIEW',approval:'UNAPPROVED',nativeFailure:null});
    expect(started).toHaveBeenCalledExactlyOnceWith(f.start(adapter.capture(f.input)).evidenceId);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.lookup).not.toHaveBeenCalled();expect(f.nativeRun).toHaveBeenCalledTimes(2);
    const after=await sharp(result.png!).ensureAlpha().raw().toBuffer();for(let at=0;at<64;at+=4)expect(after.subarray(at,at+4)).toEqual(at===20?Buffer.alloc(4,255):f.raw.subarray(at,at+4));expect(f.input.image).toEqual(before);
  });
  it.each([false,true])('holds a successful proposal without an actual START fact and preserves full cost=%s',async confirmed=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture})=>f.reply(capture,false,confirmed?f.cost(capture):null));const started=vi.fn(),adapter=new LocalLaMaAdapter(f.options),result=await adapter.dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_START_UNCONFIRMED',providerSuccess:true,started:null,costUsd:confirmed?'0.020000000000':null,usageConfirmed:confirmed,start:null,fullCost:confirmed?f.cost(adapter.capture(f.input)):null,png:null,outsideChangedPixels:0,approval:'UNAPPROVED',nativeFailure:null});expect(started).not.toHaveBeenCalled();expect(f.dispatch).toHaveBeenCalledOnce();expect(f.nativeRun).toHaveBeenCalledTimes(2);
  });
  it.each(['REPLY','CALLBACK'] as const)('keeps success when the original START fact is confirmed by %s only',async via=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{if(via==='CALLBACK')await onStarted(f.start(capture));return f.reply(capture,via==='REPLY',f.cost(capture));});const started=vi.fn(),adapter=new LocalLaMaAdapter(f.options),result=await adapter.dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'SUCCEEDED',started:true,start:f.start(adapter.capture(f.input)),providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,outsideChangedPixels:0,backgroundQa:'NEEDS_REVIEW',approval:'UNAPPROVED'});expect(Buffer.isBuffer(result.png)).toBe(true);expect(started).toHaveBeenCalledTimes(via==='CALLBACK'?1:0);expect(f.nativeRun).toHaveBeenCalledTimes(2);
  });
  it('preserves missing-START provider/cost facts and original native uncertainty instead of replacing the termination',async()=>{
    const f=await fixture(),error=f.error(),originalRun=f.nativeRun.getMockImplementation()!;f.nativeRun.mockImplementationOnce(originalRun).mockRejectedValueOnce(error);f.dispatch.mockImplementation(async({capture})=>f.reply(capture,false,f.cost(capture)));const started=vi.fn(),result=await new LocalLaMaAdapter(f.options).dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'NATIVE_EXECUTION_UNCONFIRMED',providerSuccess:true,started:null,costUsd:'0.020000000000',usageConfirmed:true,png:null,nativeFailure:{code:error.code,termination:error.termination}});expect(result.nativeFailure!.termination).toBe(error.termination);expect(started).not.toHaveBeenCalled();expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('keeps the same-runtime earlier callback START when query-only recovery has no repeated START fact',async()=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));throw Error('OWNED_REPLY_LOST_AFTER_START');});f.lookup.mockImplementation(async capture=>f.reply(capture,false,f.cost(capture)));const adapter=new LocalLaMaAdapter(f.options),started=vi.fn();expect(await adapter.dispatch(f.input,started,f.context)).toMatchObject({state:'UNKNOWN',started:true});const result=await adapter.dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'SUCCEEDED',started:true,start:f.start(adapter.capture(f.input)),providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,outsideChangedPixels:0});expect(Buffer.isBuffer(result.png)).toBe(true);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledOnce();expect(started).toHaveBeenCalledOnce();
  });
  it('holds missing-START successful facts during original lookup after adapter recreation without submitting',async()=>{
    const f=await fixture(),capture=new LocalLaMaAdapter(f.options).capture(f.input);f.lookup.mockImplementation(async original=>f.reply(original,false,f.cost(original)));const result=await new LocalLaMaAdapter({...f.options,enabled:false}).lookup(f.input,f.context,JSON.parse(JSON.stringify(capture)) as LocalLaMaCapture);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_START_UNCONFIRMED',capture,started:null,providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,outsideChangedPixels:0,png:null});expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).toHaveBeenCalledOnce();expect(f.nativeRun).toHaveBeenCalledOnce();
  });
  it('rejects a different reply runtime despite an earlier actual callback START',async()=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));const reply=f.reply(capture,false,f.cost(capture));reply.runtime={...reply.runtime,invocationId:randomUUID()};reply.fullCost={...reply.fullCost!,runtimeDigest:digest(reply.runtime)};return reply;});const started=vi.fn(),result=await new LocalLaMaAdapter(f.options).dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_REPLY_UNCONFIRMED',started:true,providerSuccess:null,costUsd:null,usageConfirmed:false,png:null});expect(started).toHaveBeenCalledOnce();expect(f.nativeRun).toHaveBeenCalledOnce();
  });
  it('blocks disabled, unmeasured and invalid identity gates before native or executor work',async()=>{
    const f=await fixture();const variants:LocalLaMaOptions[]=[{...f.options,enabled:false},{...f.options,profile:{...f.options.profile,enabled:false}},{...f.options,profile:{...f.options.profile,kind:'SYNTHETIC'}},...(['weightsLicenseVerified','runtimeVerified'] as const).map(key=>({...f.options,identity:{...f.options.identity,[key]:false}})),{...f.options,identity:{...f.options.identity,weightsSha256:'unknown'}},{...f.options,identity:{...f.options.identity,configSha256:'unknown'}},{...f.options,identity:{...f.options.identity,codeCommit:'wrong' as typeof lamaCodeCommit}}];
    for(const options of variants)expect(await new LocalLaMaAdapter(options).dispatch(f.input,vi.fn(),f.context)).toMatchObject({state:'NOT_STARTED',reason:'CLEANUP_ACTIVATION_GATE',started:false,costUsd:null,usageConfirmed:false});
    expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).not.toHaveBeenCalled();
  });
  it('rejects oversized, empty, wrong-type and nonclosed input before copying or submitting it',async()=>{
    const f=await fixture(),adapter=new LocalLaMaAdapter(f.options);const inputs=[{...f.input,image:Buffer.alloc(4097)},{...f.input,mask:Buffer.alloc(0)},{...f.input,image:new Uint8Array(8)},{...f.input,url:'owned-forbidden-field'}];
    for(const input of inputs)await expect(adapter.dispatch(input as LocalLaMaInput,vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_INPUT_INVALID'});expect(f.dispatch).not.toHaveBeenCalled();expect(f.nativeRun).not.toHaveBeenCalled();
  });
  it('rejects accessors and missing owning native context without reading the accessor or submitting',async()=>{
    const f=await fixture(),adapter=new LocalLaMaAdapter(f.options),get=vi.fn(()=>f.input.image);const input={...f.input};Object.defineProperty(input,'image',{enumerable:true,get});await expect(adapter.dispatch(input,vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_INPUT_INVALID'});
    await expect(adapter.dispatch(f.input,vi.fn(),{native:{} as NativeFacade})).rejects.toMatchObject({code:'LOCAL_LAMA_NATIVE_REQUIRED'});expect(get).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects binary mask and dimension violations before the model executor',async()=>{
    const f=await fixture();const invalid=Buffer.from(f.maskRaw);invalid[20]=invalid[21]=invalid[22]=128;
    for(const mask of [await png(invalid),await sharp({create:{width:3,height:4,channels:4,background:'#ffffffff'}}).png().toBuffer()])expect(await new LocalLaMaAdapter(f.options).dispatch({...f.input,mask},vi.fn(),f.context)).toMatchObject({state:'NOT_STARTED',reason:'CLEANUP_INPUT_REJECTED',costUsd:null,usageConfirmed:false});expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('copies options, identity, native capability and input Buffers before the first await',async()=>{
    const f=await fixture(),entered=deferred<void>(),release=deferred<void>(),originalRun=f.nativeRun.getMockImplementation()!,image=Buffer.from(f.input.image),mask=Buffer.from(f.input.mask);
    f.nativeRun.mockImplementationOnce(async(...args)=>{entered.resolve();await release.promise;return originalRun(...args);});const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),started=vi.fn();const pending=adapter.dispatch(f.input,started,f.context);await entered.promise;
    f.options.enabled=false;f.options.profile.maxImageBytes=1;f.options.identity.weightsSha256='c'.repeat(64);f.options.executor.dispatch=vi.fn(async()=>{throw Error('REPLACED_EXECUTOR');});f.context.native=new NativeFacade({run:vi.fn(async()=>{throw Error('REPLACED_NATIVE');})});f.input.image.fill(0);f.input.mask.fill(0);release.resolve();const result=await pending;
    expect(result).toMatchObject({state:'SUCCEEDED',capture,started:true});expect(f.dispatch).toHaveBeenCalledOnce();const sent=f.dispatch.mock.calls[0][0];expect(sent.image).toEqual(image);expect(sent.mask).toEqual(mask);expect(sent.capture.identity.weightsSha256).toBe('a'.repeat(64));expect(started).toHaveBeenCalledOnce();
  });
  it('keeps the original source when the executor mutates its own model input copies',async()=>{
    const f=await fixture(),before=Buffer.from(f.input.image);f.dispatch.mockImplementation(async({capture,image,mask},onStarted)=>{image.fill(0);mask.fill(0);await onStarted(f.start(capture));return f.reply(capture);});const result=await new LocalLaMaAdapter(f.options).dispatch(f.input,vi.fn(),f.context);
    expect(result.state).toBe('SUCCEEDED');expect(f.input.image).toEqual(before);const after=await sharp(result.png!).ensureAlpha().raw().toBuffer();expect(after.subarray(0,4)).toEqual(f.raw.subarray(0,4));
  });
  it('preserves native preflight uncertainty and original termination with no model submit or invented START/cost',async()=>{
    const f=await fixture(),error=f.error();f.nativeRun.mockRejectedValueOnce(error);const started=vi.fn();const result=await new LocalLaMaAdapter(f.options).dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'NATIVE_EXECUTION_UNCONFIRMED',started:null,providerSuccess:null,costUsd:null,usageConfirmed:false,nativeFailure:{code:error.code,termination:error.termination}});expect(result.nativeFailure!.termination).toBe(error.termination);expect(f.dispatch).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();
  });
  it.each([false,true])('preserves received provider success, actual START and full cost=%s after native composition remains unknown',async confirmed=>{
    const f=await fixture(),error=f.error(),originalRun=f.nativeRun.getMockImplementation()!;f.nativeRun.mockImplementationOnce(originalRun).mockRejectedValueOnce(error);f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));return f.reply(capture,true,confirmed?f.cost(capture):null);});
    const result=await new LocalLaMaAdapter(f.options).dispatch(f.input,vi.fn(),f.context);expect(result).toMatchObject({state:'UNKNOWN',reason:'NATIVE_EXECUTION_UNCONFIRMED',providerSuccess:true,started:true,costUsd:confirmed?'0.020000000000':null,usageConfirmed:confirmed,png:null,nativeFailure:{code:error.code,termination:error.termination}});expect(result.nativeFailure!.termination).toBe(error.termination);
  });
  it('preserves validated received facts when proposal bytes or their digest are invalid',async()=>{
    const f=await fixture();for(const kind of ['DIGEST','LENGTH','BYTES','NATIVE_IMAGE']){f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));const reply=f.reply(capture,true,f.cost(capture));if(kind==='DIGEST')reply.proposal!.sha256='c'.repeat(64);if(kind==='LENGTH')reply.proposal!.byteLength++;if(kind==='BYTES')reply.proposal!.bytes=new Uint8Array(f.proposal) as Buffer;if(kind==='NATIVE_IMAGE'){reply.proposal!.bytes=Buffer.from('invalid-png');reply.proposal!.byteLength=11;reply.proposal!.sha256=sha256(reply.proposal!.bytes);}return reply;});
      expect(await new LocalLaMaAdapter(f.options).dispatch(f.input,vi.fn(),f.context)).toMatchObject({state:kind==='NATIVE_IMAGE'?'UNKNOWN':'FAILED',reason:kind==='NATIVE_IMAGE'?'NATIVE_EXECUTION_UNCONFIRMED':'CLEANUP_OUTPUT_INVALID',providerSuccess:true,started:true,costUsd:'0.020000000000',usageConfirmed:true,backgroundQa:kind==='NATIVE_IMAGE'?null:'FAILED',approval:'UNAPPROVED',png:null});}
  });
  it.each([1,2])('keeps an unexpected native exception at phase %s UNKNOWN instead of inventing confirmed input/provider failure',async phase=>{
    const f=await fixture(),originalRun=f.nativeRun.getMockImplementation()!;if(phase===2)f.nativeRun.mockImplementationOnce(originalRun);f.nativeRun.mockRejectedValueOnce(Error('OWNED_NATIVE_UNCONFIRMED'));
    f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));return f.reply(capture,true,f.cost(capture));});const started=vi.fn(),result=await new LocalLaMaAdapter(f.options).dispatch(f.input,started,f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'NATIVE_EXECUTION_UNCONFIRMED',started:phase===2?true:null,providerSuccess:phase===2?true:null,costUsd:phase===2?'0.020000000000':null,usageConfirmed:phase===2,nativeFailure:null,png:null});expect(f.dispatch).toHaveBeenCalledTimes(phase===2?1:0);expect(started).toHaveBeenCalledTimes(phase===2?1:0);
  });
  it('keeps UNKNOWN after executor loss and repeated dispatch performs only original lookup',async()=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));throw Error('OWNED_LOST_RESPONSE');});f.lookup.mockResolvedValue(null as unknown as LocalLaMaExecutorReply);const adapter=new LocalLaMaAdapter(f.options),started=vi.fn();const first=await adapter.dispatch(f.input,started,f.context),second=await adapter.dispatch(f.input,started,f.context);
    expect(first).toMatchObject({state:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});expect(second).toMatchObject({state:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});expect(f.dispatch).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledExactlyOnceWith(adapter.capture(f.input));expect(started).toHaveBeenCalledOnce();
  });
  it('reconstructs original capture after adapter restart and lookup never submits or emits a START callback',async()=>{
    const f=await fixture(),first=new LocalLaMaAdapter(f.options),capture=first.capture(f.input);await first.dispatch(f.input,vi.fn(),f.context);const restored=JSON.parse(JSON.stringify(capture)) as LocalLaMaCapture;
    const second=new LocalLaMaAdapter({...f.options,enabled:false});expect(second.capture(f.input)).toEqual(capture);const result=await second.lookup(f.input,f.context,restored);expect(result).toMatchObject({state:'SUCCEEDED',started:true,capture});expect(f.dispatch).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledOnce();
  });
  it('preserves original lookup START/provider/full-cost facts on a recovering native failure without submitting',async()=>{
    const f=await fixture(),error=f.error();f.lookup.mockImplementation(async capture=>f.reply(capture,true,f.cost(capture)));f.nativeRun.mockRejectedValueOnce(error);const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),result=await adapter.lookup(f.input,f.context,capture);
    expect(result).toMatchObject({state:'UNKNOWN',started:true,providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,nativeFailure:{code:error.code,termination:error.termination},png:null});expect(result.nativeFailure!.termination).toBe(error.termination);expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).toHaveBeenCalledOnce();
  });
  it('rejects substituted original bytes, identity, profile and capture digest before original lookup',async()=>{
    const f=await fixture(),capture=new LocalLaMaAdapter(f.options).capture(f.input);const cases=[{input:{...f.input,image:Buffer.from(f.proposal)},options:f.options,capture},{input:f.input,options:{...f.options,identity:{...f.options.identity,weightsSha256:'c'.repeat(64)}},capture},{input:f.input,options:{...f.options,profile:{...f.options.profile,id:'changed-profile'}},capture},{input:f.input,options:f.options,capture:{...capture,captureDigest:'d'.repeat(64)}}];
    for(const item of cases)await expect(new LocalLaMaAdapter(item.options).lookup(item.input,f.context,item.capture)).rejects.toMatchObject({code:item.capture.captureDigest!==capture.captureDigest?'LOCAL_LAMA_FACT_INVALID':'LOCAL_LAMA_CAPTURE_CONFLICT'});expect(f.lookup).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects reply/runtime/START binding changes and nonclosed facts without making new execution claims',async()=>{
    const f=await fixture();for(const kind of ['CAPTURE','RUNTIME','IDENTITY','START','EXTRA']){f.dispatch.mockImplementation(async({capture})=>{const reply=f.reply(capture,false);if(kind==='CAPTURE')reply.captureDigest='c'.repeat(64);if(kind==='RUNTIME')reply.runtime={...reply.runtime,executionId:randomUUID()};if(kind==='IDENTITY')reply.runtime={...reply.runtime,identityDigest:'c'.repeat(64)};if(kind==='START')reply.start={...f.start(capture),captureDigest:'c'.repeat(64)};if(kind==='EXTRA')Object.assign(reply,{url:'forbidden-private-field'});return reply;});const started=vi.fn();expect(await new LocalLaMaAdapter(f.options).dispatch(f.input,started,f.context)).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_REPLY_UNCONFIRMED',started:null,costUsd:null,usageConfirmed:false});expect(started).not.toHaveBeenCalled();}
  });
  it('rejects model-only, unbound or missing cost basis instead of inventing confirmed full cost',async()=>{
    const f=await fixture();for(const kind of ['SCOPE','CAPTURE','RUNTIME','BASIS','NEGATIVE']){f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));const cost=f.cost(capture);if(kind==='SCOPE')Object.assign(cost,{scope:'MODEL_ONLY'});if(kind==='CAPTURE')Object.assign(cost,{captureDigest:'c'.repeat(64)});if(kind==='RUNTIME')Object.assign(cost,{runtimeDigest:'c'.repeat(64)});if(kind==='BASIS')Object.assign(cost,{basisVersion:''});if(kind==='NEGATIVE')Object.assign(cost,{actualUsd:'-1'});return f.reply(capture,true,cost);});expect(await new LocalLaMaAdapter(f.options).dispatch(f.input,vi.fn(),f.context)).toMatchObject({state:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});}
  });
  it('preserves original full cost and START on later conflicting lookup facts',async()=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{await onStarted(f.start(capture));return f.reply(capture,true,f.cost(capture));});f.lookup.mockImplementation(async capture=>f.reply(capture,true,f.cost(capture,'0.030000000000')));const adapter=new LocalLaMaAdapter(f.options);await adapter.dispatch(f.input,vi.fn(),f.context);
    expect(await adapter.lookup(f.input,f.context)).toMatchObject({state:'UNKNOWN',started:true,costUsd:'0.020000000000',usageConfirmed:true,providerSuccess:true});expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('deduplicates identical START facts and joins ignored START I/O before returning or releasing byte capacity',async()=>{
    const f=await fixture(),ack=deferred<void>(),entered=deferred<void>();f.options.bounds.maxInFlightBytes=6*(f.input.image.length+f.input.mask.length+f.options.profile.maxImageBytes);
    f.dispatch.mockImplementation(async({capture},onStarted)=>{void onStarted(f.start(capture));void onStarted(f.start(capture));return f.reply(capture);});const started=vi.fn(async()=>{entered.resolve();await ack.promise;});const adapter=new LocalLaMaAdapter(f.options);let finished=false;const first=adapter.dispatch(f.input,started,f.context).then(result=>{finished=true;return result;});await entered.promise;
    await expect(adapter.dispatch({...f.input,executionId:randomUUID()},vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_CAPACITY_WAIT'});expect(finished).toBe(false);expect(f.dispatch).toHaveBeenCalledOnce();expect(started).toHaveBeenCalledOnce();ack.resolve();expect((await first).state).toBe('SUCCEEDED');expect((await adapter.dispatch({...f.input,executionId:randomUUID()},vi.fn(),f.context)).state).toBe('SUCCEEDED');
  });
  it('owns received reply Buffer/facts while the upper START acknowledgement is pending',async()=>{
    const f=await fixture(),ack=deferred<void>(),entered=deferred<void>();let received:LocalLaMaExecutorReply|undefined;
    f.dispatch.mockImplementation(async({capture},onStarted)=>{void onStarted(f.start(capture));received=f.reply(capture,true,f.cost(capture));return received;});const adapter=new LocalLaMaAdapter(f.options);const pending=adapter.dispatch(f.input,async()=>{entered.resolve();await ack.promise;},f.context);await entered.promise;await Promise.resolve();await Promise.resolve();
    received!.proposal!.bytes.fill(0);Object.assign(received!.fullCost!,{actualUsd:'999'});Object.assign(received!.runtime,{executionId:randomUUID()});ack.resolve();expect(await pending).toMatchObject({state:'SUCCEEDED',costUsd:'0.020000000000',usageConfirmed:true,started:true});
  });
  it('keeps actual START and received cost when the upper START write fails',async()=>{
    const f=await fixture();f.dispatch.mockImplementation(async({capture},onStarted)=>{void onStarted(f.start(capture));return f.reply(capture,true,f.cost(capture));});const result=await new LocalLaMaAdapter(f.options).dispatch(f.input,async()=>{throw Error('OWNED_START_ACK_LOST');},f.context);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_START_UNCONFIRMED',started:true,providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,png:null});
  });
  it('rejects a late START callback after executor join without changing returned facts',async()=>{
    const f=await fixture();let late!:(fact:LocalLaMaStartFact)=>Promise<void>;f.dispatch.mockImplementation(async({capture},onStarted)=>{late=onStarted;return f.reply(capture,false);});const adapter=new LocalLaMaAdapter(f.options),started=vi.fn(),result=await adapter.dispatch(f.input,started,f.context);
    await expect(late(f.start(adapter.capture(f.input)))).rejects.toMatchObject({code:'LOCAL_LAMA_LATE_START'});expect(result.started).toBeNull();expect(started).not.toHaveBeenCalled();
  });
  it('rolls back byte reservations on capture failure and bounds retained execution fences without evicting them',async()=>{
    const f=await fixture();f.options.bounds.maxCapturedExecutions=1;f.options.bounds.maxInFlightBytes=6*(f.input.image.length+f.input.mask.length+f.options.profile.maxImageBytes);const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);
    await expect(adapter.lookup(f.input,f.context,{...capture,captureDigest:'c'.repeat(64)})).rejects.toMatchObject({code:'LOCAL_LAMA_FACT_INVALID'});expect((await adapter.dispatch(f.input,vi.fn(),f.context)).state).toBe('SUCCEEDED');await expect(adapter.dispatch({...f.input,executionId:randomUUID()},vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_CAPACITY_WAIT'});expect((await adapter.lookup(f.input,f.context,capture)).state).toBe('SUCCEEDED');expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it('projects original START and full cost without a native composite or a new output claim',async()=>{
    const f=await fixture();f.lookup.mockImplementation(async capture=>f.reply(capture,true,f.cost(capture)));const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),result=await adapter.lookupFacts(capture);
    expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_ORIGINAL_FACTS',capture,started:true,providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,png:null,outsideChangedPixels:null,backgroundQa:null,approval:'UNAPPROVED'});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).toHaveBeenCalledExactlyOnceWith(capture);
  });
  it('keeps START unconfirmed in facts-only lookup even when the model reports success and full cost',async()=>{
    const f=await fixture();f.lookup.mockImplementation(async capture=>f.reply(capture,false,f.cost(capture)));const adapter=new LocalLaMaAdapter(f.options),result=await adapter.lookupFacts(adapter.capture(f.input));expect(result).toMatchObject({state:'UNKNOWN',started:null,providerSuccess:true,costUsd:'0.020000000000',usageConfirmed:true,png:null});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('keeps malformed proposal uncertainty and known runtime/START/cost in a facts projection',async()=>{
    const f=await fixture();f.lookup.mockImplementation(async capture=>{const reply=f.reply(capture,true,f.cost(capture));reply.proposal={...reply.proposal!,sha256:'c'.repeat(64)};return reply;});const adapter=new LocalLaMaAdapter(f.options),result=await adapter.lookupFacts(adapter.capture(f.input));expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_REPLY_UNCONFIRMED',started:true,providerSuccess:true,costUsd:'0.020000000000',png:null});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('preserves the first known cost across a conflicting facts-only query',async()=>{
    const f=await fixture();f.lookup.mockImplementationOnce(async capture=>f.reply(capture,true,f.cost(capture))).mockImplementationOnce(async capture=>f.reply(capture,true,f.cost(capture,'0.03')));const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);await adapter.lookupFacts(capture);expect(await adapter.lookupFacts(capture)).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_REPLY_UNCONFIRMED',started:true,costUsd:'0.020000000000',usageConfirmed:true});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('owns the original capture before a pending facts lookup without accepting caller mutation',async()=>{
    const f=await fixture(),adapter=new LocalLaMaAdapter(f.options),capture=JSON.parse(JSON.stringify(adapter.capture(f.input))) as LocalLaMaCapture,original=structuredClone(capture),gate=deferred<LocalLaMaExecutorReply|null>();f.lookup.mockReturnValueOnce(gate.promise);const pending=adapter.lookupFacts(capture);Object.assign(capture,{executionId:randomUUID(),captureDigest:'c'.repeat(64)});gate.resolve(f.reply(original,true,f.cost(original)));expect(await pending).toMatchObject({capture:original,started:true,png:null});expect(f.lookup).toHaveBeenCalledExactlyOnceWith(original);expect(f.nativeRun).not.toHaveBeenCalled();
  });
  it('holds facts byte capacity through lookup and releases it only after original reply completion',async()=>{
    const f=await fixture();f.options.bounds.maxInFlightBytes=3*f.options.profile.maxImageBytes+4096;const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),gate=deferred<LocalLaMaExecutorReply|null>();f.lookup.mockReturnValueOnce(gate.promise);const one=adapter.lookupFacts(capture);await expect(adapter.lookupFacts(capture)).rejects.toMatchObject({code:'LOCAL_LAMA_CAPACITY_WAIT'});expect(f.lookup).toHaveBeenCalledOnce();gate.resolve(f.reply(capture));expect((await one).png).toBeNull();expect((await adapter.lookupFacts(capture)).state).toBe('UNKNOWN');expect(f.lookup).toHaveBeenCalledTimes(2);expect(f.nativeRun).not.toHaveBeenCalled();
  });
  it('rejects crossed facts capture and releases its reservation before a valid read',async()=>{
    const f=await fixture();f.options.bounds.maxInFlightBytes=3*f.options.profile.maxImageBytes+4096;const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);await expect(adapter.lookupFacts({...capture,captureDigest:'c'.repeat(64)})).rejects.toMatchObject({code:'LOCAL_LAMA_FACT_INVALID'});expect(f.lookup).not.toHaveBeenCalled();expect((await adapter.lookupFacts(capture)).png).toBeNull();expect(f.lookup).toHaveBeenCalledOnce();expect(f.nativeRun).not.toHaveBeenCalled();
  });
  it('rejects a facts capture Proxy before reflection and rolls back its held bytes',async()=>{
    const f=await fixture();f.options.bounds.maxInFlightBytes=3*f.options.profile.maxImageBytes+4096;const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);let traps=0;const trap=()=>{traps++;throw Error('OWNED_CAPTURE_PROXY');},value=new Proxy(capture,{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap});await expect(adapter.lookupFacts(value)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_INVALID'});expect(traps).toBe(0);expect(f.lookup).not.toHaveBeenCalled();expect((await adapter.lookupFacts(capture)).png).toBeNull();expect(f.nativeRun).not.toHaveBeenCalled();
  });
  it('releases facts reservations after original lookup failure without a dispatch fallback',async()=>{
    const f=await fixture();f.options.bounds.maxInFlightBytes=3*f.options.profile.maxImageBytes+4096;const adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);f.lookup.mockRejectedValueOnce(Error('OWNED_ORIGINAL_READ_UNCONFIRMED'));expect(await adapter.lookupFacts(capture)).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_LOOKUP_UNCONFIRMED',png:null});expect((await adapter.lookupFacts(capture)).png).toBeNull();expect(f.lookup).toHaveBeenCalledTimes(2);expect(f.dispatch).not.toHaveBeenCalled();expect(f.nativeRun).not.toHaveBeenCalled();
  });
});


describe('ordinary LocalLaMaAdapter captured native method across precheck and executor waits',()=>{
  it.each(['PRECHECK','EXECUTOR'] as const)('keeps the original ordinary composite method when its owning facade method changes during %s',async phase=>{
    const f=await fixture(),entered=deferred<void>(),release=deferred<void>(),originalRun=f.nativeRun.getMockImplementation()!,native=f.context.native;
    if(phase==='PRECHECK')f.nativeRun.mockImplementationOnce(async(...args)=>{entered.resolve();await release.promise;return originalRun(...args);});
    else f.dispatch.mockImplementationOnce(async({capture},onStarted)=>{await onStarted(f.start(capture));entered.resolve();await release.promise;return f.reply(capture);});
    const replacement=vi.fn<NativeFacade['compositeMaskedPixels']>(async()=>{throw Error('ORDINARY_COMPOSITE_METHOD_REPLACED_DURING_AWAIT');});
    const adapter=new LocalLaMaAdapter(f.options),started=vi.fn(),pending=adapter.dispatch(f.input,started,f.context);
    try{
      await entered.promise;expect(f.context.native).toBe(native);
      Object.defineProperty(native,'compositeMaskedPixels',{value:replacement,writable:true,enumerable:true,configurable:true});
      release.resolve();const result=await pending;
      expect(result).toMatchObject({state:'SUCCEEDED',started:true,providerSuccess:true,costUsd:null,usageConfirmed:false,outsideChangedPixels:0,backgroundQa:'NEEDS_REVIEW',approval:'UNAPPROVED',nativeFailure:null});
      expect(Buffer.isBuffer(result.png)).toBe(true);expect(replacement).not.toHaveBeenCalled();
      expect(f.nativeRun).toHaveBeenCalledTimes(2);expect(f.dispatch).toHaveBeenCalledOnce();expect(f.lookup).not.toHaveBeenCalled();expect(started).toHaveBeenCalledOnce();
    }finally{release.resolve();await pending;Reflect.deleteProperty(native,'compositeMaskedPixels');}
  });
  it('keeps the original ordinary composite method while original lookup is pending without dispatching',async()=>{
    const f=await fixture(),entered=deferred<void>(),release=deferred<void>(),native=f.context.native;
    f.lookup.mockImplementationOnce(async capture=>{entered.resolve();await release.promise;return f.reply(capture);});
    const replacement=vi.fn<NativeFacade['compositeMaskedPixels']>(async()=>{throw Error('ORDINARY_LOOKUP_COMPOSITE_METHOD_REPLACED_DURING_AWAIT');});
    const adapter=new LocalLaMaAdapter(f.options),pending=adapter.lookup(f.input,f.context);
    try{
      await entered.promise;Object.defineProperty(native,'compositeMaskedPixels',{value:replacement,writable:true,enumerable:true,configurable:true});
      release.resolve();const result=await pending;
      expect(result).toMatchObject({state:'SUCCEEDED',started:true,providerSuccess:true,costUsd:null,usageConfirmed:false,outsideChangedPixels:0,backgroundQa:'NEEDS_REVIEW',approval:'UNAPPROVED',nativeFailure:null});
      expect(Buffer.isBuffer(result.png)).toBe(true);expect(replacement).not.toHaveBeenCalled();expect(f.nativeRun).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledOnce();expect(f.dispatch).not.toHaveBeenCalled();
    }finally{release.resolve();await pending;Reflect.deleteProperty(native,'compositeMaskedPixels');}
  });
});

async function ownedInputFixture(){
  const f=await fixture();f.options.profile={...f.options.profile,kind:'SYNTHETIC'};
  const pinned:OwnedCleanupInput={profileDigest:digest(f.options.profile),sourceImageSha256:sha256(f.input.image),widthPx:4,heightPx:4};f.options.ownedCleanupInput=pinned;return {...f,pinned};
}

describe('server-owned fixed cleanup input with fake executor and in-process pixels only',()=>{
  it('admits the frozen source, preserves outside pixels and null cost, and supplies no one-run authority',async()=>{
    const f=await ownedInputFixture(),original=structuredClone(f.pinned),adapter=new LocalLaMaAdapter(f.options),started=vi.fn();
    (f.pinned as {sourceImageSha256:string}).sourceImageSha256='c'.repeat(64);expect(adapter.matchesOwnedCleanupInput(original)).toBe(true);expect(adapter.matchesOwnedCleanupInput(f.pinned)).toBe(false);
    const result=await adapter.dispatch(f.input,started,f.context);expect(result).toMatchObject({state:'SUCCEEDED',started:true,costUsd:null,usageConfirmed:false,outsideChangedPixels:0,backgroundQa:'NEEDS_REVIEW',approval:'UNAPPROVED'});
    const after=await sharp(result.png!).ensureAlpha().raw().toBuffer();for(let at=0;at<64;at+=4)expect(after.subarray(at,at+4)).toEqual(at===20?Buffer.alloc(4,255):f.raw.subarray(at,at+4));
    const another={...f.input,executionId:randomUUID(),inputDigest:sha256('separately owned request')};expect(await adapter.dispatch(another,started,f.context)).toMatchObject({state:'SUCCEEDED',costUsd:null,usageConfirmed:false});expect(f.dispatch).toHaveBeenCalledTimes(2);expect(started).toHaveBeenCalledTimes(2);
  });
  it('keeps activation, verified identity and runtime conditions for the pinned synthetic source',async()=>{
    const f=await ownedInputFixture();const variants:LocalLaMaOptions[]=[{...f.options,enabled:false},{...f.options,identity:{...f.options.identity,runtimeVerified:false}},{...f.options,identity:{...f.options.identity,weightsLicenseVerified:false}},{...f.options,identity:{...f.options.identity,codeCommit:'wrong' as typeof lamaCodeCommit}},{...f.options,identity:{...f.options.identity,weightsSha256:'unknown'}},{...f.options,identity:{...f.options.identity,configSha256:'unknown'}}];
    const disabledProfile={...f.options.profile,enabled:false};variants.push({...f.options,profile:disabledProfile,ownedCleanupInput:{...f.pinned,profileDigest:digest(disabledProfile)}});
    for(const option of variants)expect(await new LocalLaMaAdapter(option).dispatch(f.input,vi.fn(),f.context)).toMatchObject({state:'NOT_STARTED',reason:'CLEANUP_ACTIVATION_GATE',started:false,costUsd:null,usageConfirmed:false});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).not.toHaveBeenCalled();
  });
  it('rejects unclosed, getter, missing, changed-profile and out-of-bounds private configurations',async()=>{
    const f=await ownedInputFixture(),get=vi.fn(()=>f.pinned.sourceImageSha256),getter={...f.pinned};Object.defineProperty(getter,'sourceImageSha256',{enumerable:true,get});
    for(const pinned of [undefined,{...f.pinned,extra:true},{...f.pinned,profileDigest:'d'.repeat(64)},{...f.pinned,sourceImageSha256:'invalid'},{...f.pinned,widthPx:0},{...f.pinned,heightPx:5},getter])expect(()=>new LocalLaMaAdapter({...f.options,ownedCleanupInput:pinned as OwnedCleanupInput})).toThrow('LOCAL_LAMA_CONFIG_INVALID');
    expect(()=>new LocalLaMaAdapter({...f.options,profile:{...f.options.profile,kind:'MEASURED'}})).toThrow('LOCAL_LAMA_CONFIG_INVALID');expect(get).not.toHaveBeenCalled();expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('blocks different actual source bytes in capture, dispatch and original lookup before executor/native work',async()=>{
    const f=await ownedInputFixture(),adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),changed={...f.input,image:Buffer.from(f.input.image)};changed.image[changed.image.length-1]^=1;
    expect(()=>adapter.capture(changed)).toThrow('LOCAL_LAMA_INPUT_INVALID');await expect(adapter.dispatch(changed,vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_INPUT_INVALID'});await expect(adapter.lookup(changed,f.context,capture)).rejects.toMatchObject({code:'LOCAL_LAMA_INPUT_INVALID'});
    expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(f.lookup).not.toHaveBeenCalled();
  });
  it.each(['DIMENSIONS','HEADER','TYPE','TRUNCATED'] as const)('blocks a pinned %s mismatch before new native work',async variant=>{
    const f=await ownedInputFixture(),image=Buffer.from(f.input.image);if(variant==='DIMENSIONS')image.writeUInt32BE(3,16);if(variant==='HEADER')image[0]=0;if(variant==='TYPE')image.write('IDAT',12,'ascii');const bytes=variant==='TRUNCATED'?image.subarray(0,23):image;
    const adapter=new LocalLaMaAdapter({...f.options,ownedCleanupInput:{...f.pinned,sourceImageSha256:sha256(bytes)}});expect(()=>adapter.capture({...f.input,image:bytes})).toThrow('LOCAL_LAMA_INPUT_INVALID');await expect(adapter.dispatch({...f.input,image:bytes},vi.fn(),f.context)).rejects.toMatchObject({code:'LOCAL_LAMA_INPUT_INVALID'});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('checks changed original capture metadata before query-only recovery and preserves disabled recovery',async()=>{
    const f=await ownedInputFixture(),adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input),changed={...capture,maskSha256:'c'.repeat(64)};const {captureDigest:_old,...body}=changed;changed.captureDigest=digest(body);
    await expect(adapter.lookup(f.input,f.context,changed)).rejects.toMatchObject({code:'LOCAL_LAMA_CAPTURE_CONFLICT'});const metadata={...capture,imageSha256:'c'.repeat(64)};const {captureDigest:_digest,...metadataBody}=metadata;metadata.captureDigest=digest(metadataBody);
    await expect(new LocalLaMaAdapter(f.options).lookupFacts(metadata)).rejects.toMatchObject({code:'LOCAL_LAMA_CAPTURE_CONFLICT'});expect(f.nativeRun).not.toHaveBeenCalled();expect(f.lookup).not.toHaveBeenCalled();
    expect(await new LocalLaMaAdapter({...f.options,enabled:false}).lookup(f.input,f.context,capture)).toMatchObject({state:'SUCCEEDED',started:true,costUsd:null,usageConfirmed:false,outsideChangedPixels:0,approval:'UNAPPROVED'});expect(f.lookup).toHaveBeenCalledOnce();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('reconciles only original fixed-source facts without material reconstruction or a submit',async()=>{
    const f=await ownedInputFixture(),adapter=new LocalLaMaAdapter(f.options),capture=adapter.capture(f.input);expect(await adapter.lookupFacts(capture)).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_ORIGINAL_FACTS',capture,started:true,providerSuccess:true,costUsd:null,usageConfirmed:false,png:null,approval:'UNAPPROVED'});expect(f.lookup).toHaveBeenCalledExactlyOnceWith(capture);expect(f.dispatch).not.toHaveBeenCalled();expect(f.nativeRun).not.toHaveBeenCalled();
  });
});
