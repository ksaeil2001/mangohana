import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {LocalLaMaInvocationCoordinator,type LocalLaMaCoordinatorOptions,type LocalLaMaInvocationRecord,type LocalLaMaAttemptSnapshot,type LocalLaMaOriginalInvocation,type LocalLaMaEngineInvocation,type LocalLaMaFullCostEvidence} from '../../packages/providers/src/local-lama-executor.js';
import type {LocalLaMaCapture,LocalLaMaExecutionInput,LocalLaMaExecutorReply,LocalLaMaStartFact,LocalLaMaFullCost} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';

// Owned bytes and closure ports only. CONFIRMED/full-stage fixture facts are
// not actual DB authority, measurement, engine execution or production proof.
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
function copy<T>(value:T):T{if(Buffer.isBuffer(value))return Buffer.from(value) as T;if(Array.isArray(value))return value.map(copy) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;return value;}
function fixture(){
  const image=Buffer.from('owned-original-image'),mask=Buffer.from('owned-binary-mask'),proposal=Buffer.from('owned-model-proposal'),executionId=randomUUID(),inputDigest=sha256('owned-input');
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest,profileId:'owned-profile-only',profileDigest:sha256('owned-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('owned-weights'),configSha256:sha256('owned-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:sha256(image),imageByteLength:image.length,maskSha256:sha256(mask),maskByteLength:mask.length};
  const capture:LocalLaMaCapture={...body,captureDigest:digest(body)};
  const binding={version:1 as const,accountId:randomUUID(),requestId:randomUUID(),executionId,inputDigest,inputFingerprint:sha256('owned-canonical-stage-input'),fullStageCaptureDigest:sha256('owned-full-stage-cost-capture'),localCaptureDigest:capture.captureDigest,mode:'FREE' as const};
  const original:LocalLaMaOriginalInvocation={version:1,bindingDigest:digest(binding),localCaptureDigest:capture.captureDigest,invocationId:randomUUID()};
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId,inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)};
  const start:LocalLaMaStartFact={version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime};
  const reply:LocalLaMaExecutorReply={version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime,state:'SUCCEEDED',providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(proposal),byteLength:proposal.length,bytes:proposal}};
  const fullCost:LocalLaMaFullCost={version:1,scope:'FULL_STAGE_PROCESS',captureDigest:capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.024000000000',evidenceRef:'owned-complete-process-fact',basisVersion:'owned-basis-v1'};
  const costEvidence:LocalLaMaFullCostEvidence={version:1,bindingDigest:digest(binding),fullStageCaptureDigest:binding.fullStageCaptureDigest,closureEvidenceRef:'owned-composite-verification-storage-closure',fullCost};
  let claimed=false;const records:LocalLaMaInvocationRecord[]=[];
  const snapshot=():LocalLaMaAttemptSnapshot=>({version:1,original:copy(original),records:copy(records)});
  const claim=vi.fn<LocalLaMaCoordinatorOptions['attempts']['claim']>(async()=>{const created=!claimed;claimed=true;return {...snapshot(),created};});
  const lookup=vi.fn<LocalLaMaCoordinatorOptions['attempts']['lookup']>(async()=>claimed?snapshot():null);
  const append=vi.fn<LocalLaMaCoordinatorOptions['attempts']['append']>(async(_binding,_original,record)=>{if(!records.some(row=>row.recordDigest===record.recordDigest))records.push(copy(record));});
  const invocation=(value:LocalLaMaExecutorReply|null):LocalLaMaEngineInvocation=>({reply:Promise.resolve(copy(value)),joined:Promise.resolve()});
  const submit=vi.fn<LocalLaMaCoordinatorOptions['engine']['submit']>((_value,onStarted)=>{const done=(async()=>{await onStarted(copy(start));return copy(reply);})();return {reply:done,joined:done.then(()=>undefined,()=>undefined)};});
  const query=vi.fn<LocalLaMaCoordinatorOptions['engine']['query']>(()=>invocation(reply));
  const costLookup=vi.fn<LocalLaMaCoordinatorOptions['costs']['lookup']>(async()=>null);
  const options:LocalLaMaCoordinatorOptions={binding,capture,bounds:{maxEncodedBytes:1024,maxMetadataBytes:16384,maxInFlightBytes:2*1024*1024,maxConcurrentCalls:4,maxRecords:24},attempts:{claim,lookup,append},engine:{submit,query},costs:{lookup:costLookup}};
  const input:LocalLaMaExecutionInput={capture,image,mask};
  return {options,input,capture,binding,original,runtime,start,reply,proposal,fullCost,costEvidence,records,claim,lookup,append,submit,query,costLookup,invocation,snapshot};
}

describe('capability-bound local LaMa original invocation coordinator with fake ports',()=>{
  it('submits once only after an unambiguous durable first-claim ACK and joins the real START callback',async()=>{
    const f=fixture(),started=vi.fn(async()=>{}),coordinator=new LocalLaMaInvocationCoordinator(f.options);
    const result=await coordinator.dispatch(f.input,started);
    expect(result).toMatchObject({state:'SUCCEEDED',providerSuccess:true,start:f.start,fullCost:null});expect(result.proposal!.bytes).toEqual(f.proposal);
    expect(f.submit).toHaveBeenCalledOnce();expect(f.query).not.toHaveBeenCalled();expect(started).toHaveBeenCalledExactlyOnceWith(f.start);
    expect(f.records.map(row=>row.kind)).toContain('START');expect(f.records.map(row=>row.kind)).toContain('ENGINE_REPLY');
    await coordinator.dispatch(f.input,started);await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,started);await coordinator.lookup(f.capture);
    expect(f.submit).toHaveBeenCalledOnce();expect(f.query).toHaveBeenCalledTimes(3);expect(started).toHaveBeenCalledOnce();
  });
  it('queries only after a first-claim ACK is lost, including an original record without START',async()=>{
    const f=fixture(),originalClaim=f.claim.getMockImplementation()!;f.claim.mockImplementationOnce(async(...args)=>{await originalClaim(...args);throw Error('OWNED_CLAIM_ACK_LOST');});f.query.mockImplementation(()=>f.invocation({...f.reply,state:'UNKNOWN',providerSuccess:null,start:null,proposal:null}));
    const result=await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn());
    expect(result).toMatchObject({state:'UNKNOWN',providerSuccess:null,start:null,fullCost:null});expect(f.submit).not.toHaveBeenCalled();expect(f.query).toHaveBeenCalledOnce();
  });
  it('keeps a missing original lookup empty without creating a candidate, submit or cost fact',async()=>{
    const f=fixture();expect(await new LocalLaMaInvocationCoordinator(f.options).lookup(f.capture)).toBeNull();
    expect(f.claim).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.costLookup).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
  });
  it('keeps model success costless until the trusted reader verifies the original whole-stage closure',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);expect((await coordinator.dispatch(f.input,vi.fn())).fullCost).toBeNull();f.costLookup.mockResolvedValue(f.costEvidence);
    const result=await coordinator.lookup(f.capture);expect(result?.fullCost).toEqual(f.fullCost);expect(f.binding.fullStageCaptureDigest).not.toBe(f.capture.captureDigest);expect(f.records.some(row=>row.kind==='FULL_COST')).toBe(true);expect(f.submit).toHaveBeenCalledOnce();
  });
  it('does not turn a malformed first-claim ACK into a replacement original invocation',async()=>{
    const f=fixture(),originalClaim=f.claim.getMockImplementation()!;f.claim.mockImplementationOnce(async(...args)=>({...await originalClaim(...args),original:{...f.original,bindingDigest:sha256('other-account-binding')}}));
    await expect(new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn())).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_FACT_INVALID'});expect(f.submit).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('never retries a claim ACK failure whose original lookup is still missing',async()=>{
    const f=fixture(),error=Error('OWNED_DB_ACK_UNKNOWN');f.claim.mockRejectedValue(error);await expect(new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn())).rejects.toBe(error);
    expect(f.claim).toHaveBeenCalledOnce();expect(f.lookup).toHaveBeenCalledOnce();expect(f.submit).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('never treats an unavailable original store as authority to submit',async()=>{
    const f=fixture(),error=Error('OWNED_DB_UNAVAILABLE');f.lookup.mockRejectedValue(error);await expect(new LocalLaMaInvocationCoordinator(f.options).lookup(f.capture)).rejects.toBe(error);expect(f.claim).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('keeps caller catalog, binding, input buffers and method changes outside the original capture during a claim await',async()=>{
    const f=fixture(),gate=deferred<void>(),originalClaim=f.claim.getMockImplementation()!,originalBinding=copy(f.binding),originalImage=copy(f.input.image),originalMask=copy(f.input.mask),replacement=vi.fn();f.claim.mockImplementation(async(...args)=>{const result=await originalClaim(...args);await gate.promise;return result;});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options),pending=coordinator.dispatch(f.input,vi.fn());await vi.waitFor(()=>expect(f.claim).toHaveBeenCalledOnce());
    f.input.image.fill(90);f.input.mask.fill(91);f.input.capture={...f.capture,inputDigest:sha256('changed-input')};f.options.binding={...f.binding,accountId:randomUUID()};f.options.capture={...f.capture,profileDigest:sha256('changed-profile')};f.options.bounds={...f.options.bounds,maxConcurrentCalls:0};f.options.engine.submit=replacement;
    gate.resolve();expect((await pending).state).toBe('SUCCEEDED');expect(replacement).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();expect(f.submit.mock.calls[0][0].binding).toEqual(originalBinding);expect(f.submit.mock.calls[0][0].input.image).toEqual(originalImage);expect(f.submit.mock.calls[0][0].input.mask).toEqual(originalMask);
  });
  it.each(['START_APPEND','RAW_APPEND','COST_READ'] as const)('holds the entire reservation until pending %s I/O has joined',async phase=>{
    const f=fixture(),gate=deferred<void>();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};const originalAppend=f.append.getMockImplementation()!;
    f.append.mockImplementation(async(...args)=>{if(args[2].kind===(phase==='START_APPEND'?'START':'ENGINE_REPLY')&&phase!=='COST_READ')await gate.promise;await originalAppend(...args);});if(phase==='COST_READ')f.costLookup.mockImplementation(async()=>{await gate.promise;return null;});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options),pending=coordinator.dispatch(f.input,vi.fn());let settled=false;void pending.then(()=>{settled=true;});await vi.waitFor(()=>expect(phase==='COST_READ'?f.costLookup:f.append).toHaveBeenCalled());
    await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});expect(settled).toBe(false);gate.resolve();await pending;await coordinator.lookup(f.capture);expect(f.submit).toHaveBeenCalledOnce();
  });
  it('joins a START callback that arrives after the reply and waits for its parent I/O before releasing the slot',async()=>{
    const f=fixture(),engineJoin=deferred<void>(),parentIo=deferred<void>();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};let notify!:(fact:LocalLaMaStartFact)=>Promise<void>;f.submit.mockImplementation((_value,onStarted)=>{notify=onStarted;return {reply:Promise.resolve({...f.reply,start:null}),joined:engineJoin.promise};});
    const started=vi.fn(async()=>{await parentIo.promise;}),coordinator=new LocalLaMaInvocationCoordinator(f.options),pending=coordinator.dispatch(f.input,started);let settled=false;void pending.then(()=>{settled=true;});await vi.waitFor(()=>expect(f.records.some(row=>row.kind==='ENGINE_REPLY')).toBe(true));
    const callback=notify(copy(f.start));await vi.waitFor(()=>expect(started).toHaveBeenCalledOnce());engineJoin.resolve();await Promise.resolve();expect(settled).toBe(false);await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});parentIo.resolve();await callback;expect((await pending).start).toEqual(f.start);await coordinator.lookup(f.capture);
  });
  it('rejects callbacks after the trusted engine join without recording a manufactured late START',async()=>{
    const f=fixture();let notify!:(fact:LocalLaMaStartFact)=>Promise<void>;f.submit.mockImplementation((_value,onStarted)=>{notify=onStarted;return f.invocation({...f.reply,start:null});});const coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());const before=f.records.length;
    await expect(notify(copy(f.start))).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_LATE_START'});expect(f.records.length).toBe(before);
  });
  it('preserves actual START, raw provider success and whole cost when the parent START callback fails',async()=>{
    const f=fixture();f.costLookup.mockResolvedValue(f.costEvidence);f.submit.mockImplementation((_value,onStarted)=>{const start=onStarted(copy(f.start));void start.catch(()=>undefined);return {reply:Promise.resolve(copy(f.reply)),joined:start.then(()=>undefined,()=>undefined)};});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options),result=await coordinator.dispatch(f.input,vi.fn(async()=>{throw Error('OWNED_PARENT_START_IO_FAILURE');}));expect(result).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true,fullCost:f.fullCost});expect(f.records.map(row=>row.kind)).toContain('ENGINE_REPLY');expect(f.records.map(row=>row.kind)).toContain('START');
    expect(await coordinator.lookup(f.capture)).toMatchObject({state:'SUCCEEDED',start:f.start,fullCost:f.fullCost});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('preserves durable START/raw facts after an append ACK loss and recovers only by original query',async()=>{
    const f=fixture(),originalAppend=f.append.getMockImplementation()!;let lost=false;f.append.mockImplementation(async(...args)=>{await originalAppend(...args);if(args[2].kind==='ENGINE_REPLY'&&!lost){lost=true;throw Error('OWNED_RAW_APPEND_ACK_LOST');}});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options);expect(await coordinator.dispatch(f.input,vi.fn())).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});expect(await coordinator.lookup(f.capture)).toMatchObject({state:'SUCCEEDED',start:f.start});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('keeps known facts and reserves its slot after engine join rejection',async()=>{
    const f=fixture();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.submit.mockImplementation((_value,onStarted)=>{const start=onStarted(copy(f.start));return {reply:start.then(()=>copy(f.reply)),joined:Promise.reject(Error('OWNED_LIFETIME_UNJOINED'))};});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options);expect(await coordinator.dispatch(f.input,vi.fn())).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['THROW','MALFORMED'] as const)('holds a possibly issued engine lifetime after %s instead of freeing on reply/TERM alone',async kind=>{
    const f=fixture();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.submit.mockImplementation(()=>{if(kind==='THROW')throw Error('OWNED_HANDLE_ACK_UNKNOWN');return {reply:Promise.resolve(copy(f.reply))} as LocalLaMaEngineInvocation;});
    const coordinator=new LocalLaMaInvocationCoordinator(f.options);await expect(coordinator.dispatch(f.input,vi.fn())).rejects.toThrow();await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('serializes durable first ownership across concurrent calls and a new coordinator',async()=>{
    const f=fixture(),gate=deferred<void>();f.submit.mockImplementation((_value,onStarted)=>{const result=(async()=>{await onStarted(copy(f.start));await gate.promise;return copy(f.reply);})();return {reply:result,joined:result.then(()=>undefined)};});const first=new LocalLaMaInvocationCoordinator(f.options),second=new LocalLaMaInvocationCoordinator(f.options),started=vi.fn(async()=>{});
    const original=first.dispatch(f.input,started),racing=second.dispatch(f.input,started);await racing;expect(f.submit).toHaveBeenCalledOnce();expect(f.query).toHaveBeenCalledOnce();gate.resolve();await original;expect(started).toHaveBeenCalledOnce();
  });
  it('never accepts a successful proposal without original START even when its full cost is known',async()=>{
    const f=fixture();f.submit.mockImplementation(()=>f.invocation({...f.reply,start:null}));f.costLookup.mockResolvedValue(f.costEvidence);const started=vi.fn(),result=await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,started);
    expect(result).toMatchObject({state:'UNKNOWN',start:null,providerSuccess:true,fullCost:f.fullCost,evidenceId:f.reply.evidenceId});expect(result.proposal!.bytes).toEqual(f.proposal);expect(started).not.toHaveBeenCalled();
  });
  it('records but never adopts engine/model-only fullCost as a complete process cost',async()=>{
    const f=fixture();f.submit.mockImplementation(()=>f.invocation({...f.reply,fullCost:f.fullCost}));const result=await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn());expect(result).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true,fullCost:null});expect(f.records.some(row=>row.kind==='ENGINE_REPLY'&&row.reply.fullCost?.actualUsd===f.fullCost.actualUsd)).toBe(true);expect(f.costLookup).not.toHaveBeenCalled();
  });
  it('retains verified material and cost when a later original query reports UNKNOWN without repeated facts',async()=>{
    const f=fixture();f.costLookup.mockResolvedValue(f.costEvidence);const coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());f.query.mockImplementation(()=>f.invocation({...f.reply,evidenceId:randomUUID(),state:'UNKNOWN',providerSuccess:null,start:null,proposal:null}));f.costLookup.mockResolvedValue(null);
    const result=await coordinator.lookup(f.capture);expect(result).toMatchObject({state:'SUCCEEDED',start:f.start,providerSuccess:true,fullCost:f.fullCost});expect(result?.proposal?.bytes).toEqual(f.proposal);expect(f.submit).toHaveBeenCalledOnce();
  });
  it('holds contradictory NOT_STARTED without erasing the original START or material',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());f.query.mockImplementation(()=>f.invocation({...f.reply,state:'NOT_STARTED',providerSuccess:null,start:null,proposal:null}));expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('holds a changed original proposal and keeps both immutable raw observations',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());const changed=Buffer.from('other-owned-output');f.query.mockImplementation(()=>f.invocation({...f.reply,evidenceId:randomUUID(),proposal:{bytes:changed,byteLength:changed.length,sha256:sha256(changed)}}));expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:f.start});expect(f.records.filter(row=>row.kind==='ENGINE_REPLY')).toHaveLength(2);
  });
  it.each(['invocationId','inputDigest','profileDigest','identityDigest'] as const)('holds raw engine runtime %s mismatch without overwriting original START',async field=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());const runtime={...f.runtime,[field]:field==='invocationId'?randomUUID():sha256('wrong-runtime')};f.query.mockImplementation(()=>f.invocation({...f.reply,evidenceId:randomUUID(),runtime,start:null}));expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});expect(f.records.some(row=>row.kind==='ENGINE_REPLY'&&row.reply.runtime[field]===runtime[field])).toBe(true);
  });
  it('does not adopt a new contradictory START evidence ID for the same invocation',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());f.query.mockImplementation(()=>f.invocation({...f.reply,evidenceId:randomUUID(),start:{...f.start,evidenceId:randomUUID()}}));expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start});
  });
  it.each(['binding','fullStage','localCapture','runtime','actualUsd','closure'] as const)('rejects or holds full-cost %s contradictions and preserves the prior whole cost',async field=>{
    const f=fixture();f.costLookup.mockResolvedValue(f.costEvidence);const coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());const changed=copy(f.costEvidence);
    const next:LocalLaMaFullCostEvidence=field==='binding'?{...changed,bindingDigest:sha256('wrong-binding')}:field==='fullStage'?{...changed,fullStageCaptureDigest:sha256('wrong-full-stage')}:field==='closure'?{...changed,closureEvidenceRef:'other-closure'}:{...changed,fullCost:{...changed.fullCost,...(field==='localCapture'?{captureDigest:sha256('wrong-local-capture')}:field==='runtime'?{runtimeDigest:sha256('wrong-runtime')}:{actualUsd:'0.025000000000'})}};f.costLookup.mockResolvedValue(next);
    expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',fullCost:f.fullCost,start:f.start,providerSuccess:true});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('accepts an explicitly proved complete-process zero and keeps absent cost NULL',async()=>{
    const f=fixture();f.costLookup.mockResolvedValue({...f.costEvidence,fullCost:{...f.fullCost,actualUsd:'0.000000000000'}});expect((await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn())).fullCost?.actualUsd).toBe('0.000000000000');
  });
  it('returns detached output bytes so caller mutation cannot rewrite durable history',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options),result=await coordinator.dispatch(f.input,vi.fn());result.proposal!.bytes.fill(90);expect((await coordinator.lookup(f.capture))?.proposal?.bytes).toEqual(f.proposal);expect(f.records.find(row=>row.kind==='ENGINE_REPLY')?.kind).toBe('ENGINE_REPLY');
  });
  it.each(['accountId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode'] as const)('captures binding %s rather than using caller changes as authority',async key=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options),originalBinding=copy(f.binding);f.options.binding={...f.binding,[key]:key==='mode'?'PAID':key.endsWith('Id')?randomUUID():sha256('later-binding')};await coordinator.dispatch(f.input,vi.fn());expect(f.claim.mock.calls[0][0]).toEqual(originalBinding);
  });
  it.each(['ROOT','BINDING','CAPTURE','IDENTITY','BOUNDS','PORT','METHOD'] as const)('rejects constructor %s Proxy without invoking any trap',async where=>{
    const f=fixture(),trap=vi.fn(()=>{throw Error('OWNED_PROXY_TRAP');}),wrap=<T extends object>(value:T)=>new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap});let options=f.options;
    if(where==='ROOT')options=wrap(options);else if(where==='BINDING')options={...options,binding:wrap(options.binding)};else if(where==='CAPTURE')options={...options,capture:wrap(options.capture)};else if(where==='IDENTITY')options={...options,capture:{...options.capture,identity:wrap(options.capture.identity)}};else if(where==='BOUNDS')options={...options,bounds:wrap(options.bounds)};else if(where==='PORT')options={...options,attempts:wrap(options.attempts)};else options={...options,engine:{...options.engine,submit:wrap(options.engine.submit)}};
    expect(()=>new LocalLaMaInvocationCoordinator(options)).toThrow();expect(trap).not.toHaveBeenCalled();expect(f.claim).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();
  });
  it.each(['OPTIONS','BINDING','PORT'] as const)('rejects a %s getter descriptor before access',where=>{
    const f=fixture(),getter=vi.fn(()=>{throw Error('OWNED_GETTER');}),options=copy({...f.options,attempts:undefined,engine:undefined,costs:undefined});let value:LocalLaMaCoordinatorOptions={...options,attempts:f.options.attempts,engine:f.options.engine,costs:f.options.costs};
    if(where==='OPTIONS')Object.defineProperty(value,'binding',{get:getter,enumerable:true});else if(where==='BINDING')Object.defineProperty(value.binding,'mode',{get:getter,enumerable:true});else{value={...value,engine:{...value.engine}};Object.defineProperty(value.engine,'submit',{get:getter,enumerable:true});}
    expect(()=>new LocalLaMaInvocationCoordinator(value)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it.each([0,-1,Infinity,NaN,1.5])('rejects non-positive or non-integral explicit bounds %s',maximum=>{const f=fixture();f.options.bounds={...f.options.bounds,maxEncodedBytes:maximum};expect(()=>new LocalLaMaInvocationCoordinator(f.options)).toThrow();});
  it.each(['INPUT','BUFFER','CAPTURE'] as const)('rejects %s Proxy before traps/ports and rolls back pre-I/O reservations',async where=>{
    const f=fixture(),trap=vi.fn(()=>{throw Error('OWNED_PROXY_TRAP');}),wrap=<T extends object>(value:T)=>new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),coordinator=new LocalLaMaInvocationCoordinator(f.options),input=where==='INPUT'?wrap(f.input):where==='BUFFER'?{...f.input,image:wrap(f.input.image)}:{...f.input,capture:wrap(f.capture)};
    await expect(coordinator.dispatch(input,vi.fn())).rejects.toThrow();expect(trap).not.toHaveBeenCalled();expect(f.claim).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();expect((await coordinator.dispatch(f.input,vi.fn())).state).toBe('SUCCEEDED');
  });
  it('rejects input getters, extra fields, over-limit bytes and changed input hashes before any claim',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options),getter=vi.fn(),withGetter={...f.input};Object.defineProperty(withGetter,'image',{enumerable:true,get:getter});
    for(const value of [withGetter,{...f.input,extra:true},{...f.input,image:Buffer.alloc(1025)},{...f.input,image:Buffer.from('wrong-image')}])await expect(coordinator.dispatch(value,vi.fn())).rejects.toThrow();expect(getter).not.toHaveBeenCalled();expect(f.claim).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();
  });
  it('reserves capacity before inspecting a second caller buffer',async()=>{
    const f=fixture(),gate=deferred<void>();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.claim.mockImplementation(async()=>{await gate.promise;return {...f.snapshot(),created:true};});const coordinator=new LocalLaMaInvocationCoordinator(f.options),first=coordinator.dispatch(f.input,vi.fn()),getter=vi.fn(()=>{throw Error('OWNED_BUFFER_GETTER');}),second={...f.input};Object.defineProperty(second,'image',{get:getter,enumerable:true});
    await expect(coordinator.dispatch(second,vi.fn())).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});expect(getter).not.toHaveBeenCalled();gate.resolve();await first;
  });
  it.each(['ARRAY_PROXY','ROW_PROXY','DIGEST','DUPLICATE'] as const)('rejects malformed original history %s without engine query or replacement claim',async kind=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());const snapshot=f.snapshot(),trap=vi.fn(()=>{throw Error('OWNED_RECORD_TRAP');});
    if(kind==='ARRAY_PROXY')snapshot.records=new Proxy(snapshot.records,{get:trap,ownKeys:trap,getPrototypeOf:trap});else if(kind==='ROW_PROXY')snapshot.records[0]=new Proxy(snapshot.records[0],{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap});else if(kind==='DIGEST')snapshot.records[0]={...snapshot.records[0],recordDigest:sha256('tampered-record')};else snapshot.records.push(copy(snapshot.records[0]));f.lookup.mockResolvedValue(snapshot);f.query.mockClear();f.claim.mockClear();
    await expect(coordinator.lookup(f.capture)).rejects.toThrow();expect(trap).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.claim).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  });
  it('rejects a changed durable original invocation ID instead of adopting a new invocation',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());f.lookup.mockResolvedValue({...f.snapshot(),original:{...f.original,invocationId:randomUUID()}});await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_FACT_CONFLICT'});expect(f.query).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  });
  it('rechecks original durable facts after a concurrent append rather than confirming from an older snapshot',async()=>{
    const f=fixture(),originalAppend=f.append.getMockImplementation()!;let injected=false;f.costLookup.mockResolvedValue(f.costEvidence);f.append.mockImplementation(async(...args)=>{await originalAppend(...args);if(args[2].kind==='FULL_COST'&&!injected){injected=true;const body={version:1 as const,kind:'FULL_COST' as const,evidence:{...f.costEvidence,fullCost:{...f.fullCost,actualUsd:'0.025000000000'}}};f.records.push({...body,recordDigest:digest(body)});}});
    const result=await new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn());expect(result).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true,fullCost:f.fullCost});expect(f.submit).toHaveBeenCalledOnce();
  });
  it('preserves a known first-claim conflict rather than treating it as an unknown transport ACK',async()=>{
    const f=fixture(),error=new DomainError('LOCAL_LAMA_DURABLE_CAPTURE_CONFLICT',409,'WAIT');await f.claim(f.binding,f.capture);f.claim.mockRejectedValue(error);
    await expect(new LocalLaMaInvocationCoordinator(f.options).dispatch(f.input,vi.fn())).rejects.toBe(error);expect(f.lookup).not.toHaveBeenCalled();expect(f.submit).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('holds an engine evidence ID reused for a changed reply instead of overwriting the original evidence',async()=>{
    const f=fixture(),coordinator=new LocalLaMaInvocationCoordinator(f.options);await coordinator.dispatch(f.input,vi.fn());f.query.mockImplementation(()=>f.invocation({...f.reply,state:'UNKNOWN',start:null,providerSuccess:null,proposal:null}));
    expect(await coordinator.lookup(f.capture)).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:f.start});expect(f.records.filter(row=>row.kind==='ENGINE_REPLY')).toHaveLength(2);expect(f.submit).toHaveBeenCalledOnce();
  });
  it.each(['reply','joined'] as const)('rejects an engine %s Promise getter without executing it and keeps an unproven lifetime held',async field=>{
    const f=fixture(),getter=vi.fn(()=>{throw Error('OWNED_PROMISE_GETTER');});f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.submit.mockImplementation(()=>{const handle=f.invocation(f.reply);Object.defineProperty(handle[field],'then',{get:getter,enumerable:true});return handle;});const coordinator=new LocalLaMaInvocationCoordinator(f.options);
    await expect(coordinator.dispatch(f.input,vi.fn())).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_FACT_INVALID'});expect(getter).not.toHaveBeenCalled();await expect(coordinator.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});
  });
  it('rejects a method bind getter before intrinsic method capture can access it',()=>{
    const f=fixture(),getter=vi.fn(()=>{throw Error('OWNED_BIND_GETTER');}),submit:LocalLaMaCoordinatorOptions['engine']['submit']=(...args)=>f.submit(...args);Object.defineProperty(submit,'bind',{get:getter,enumerable:true});f.options.engine={...f.options.engine,submit};
    expect(()=>new LocalLaMaInvocationCoordinator(f.options)).toThrow();expect(getter).not.toHaveBeenCalled();expect(f.claim).not.toHaveBeenCalled();
  });
  it('rejects missing/extra bounds and oversized captured metadata before constructing a port request',()=>{
    const f=fixture();for(const bounds of [{maxEncodedBytes:1024},{...f.options.bounds,extra:true}])expect(()=>new LocalLaMaInvocationCoordinator({...f.options,bounds} as LocalLaMaCoordinatorOptions)).toThrow();
    const {captureDigest:_old,...body}=f.capture,long={...body,profileId:'x'.repeat(f.options.bounds.maxMetadataBytes)},capture={...long,captureDigest:digest(long)};expect(()=>new LocalLaMaInvocationCoordinator({...f.options,capture,binding:{...f.binding,localCaptureDigest:capture.captureDigest}})).toThrow();expect(f.claim).not.toHaveBeenCalled();
  });
  it.each(['JOIN_REJECTED','SYNC_THROW','INVALID_HANDLE'] as const)('keeps a durable lifetime hard HOLD after %s across a new instance and a healthy query handle',async kind=>{
    const f=fixture();f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};
    f.submit.mockImplementation((_value,onStarted)=>{if(kind==='SYNC_THROW')throw Error('OWNED_ORIGINAL_LIFETIME_ACK_UNKNOWN');if(kind==='INVALID_HANDLE')return {reply:Promise.resolve(copy(f.reply))} as LocalLaMaEngineInvocation;const started=onStarted(copy(f.start));return {reply:started.then(()=>copy(f.reply)),joined:Promise.reject(Error('OWNED_ORIGINAL_JOIN_FAILED'))};});
    const first=new LocalLaMaInvocationCoordinator(f.options);if(kind==='JOIN_REJECTED')expect(await first.dispatch(f.input,vi.fn())).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});else await expect(first.dispatch(f.input,vi.fn())).rejects.toThrow();
    const result=await new LocalLaMaInvocationCoordinator(f.options).lookup(f.capture);expect(result).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);expect(f.submit).toHaveBeenCalledOnce();expect(f.query).toHaveBeenCalledOnce();expect(f.costLookup).not.toHaveBeenCalled();
  });
  it.each(['FULL_STAGE_CLOSURE_CONFLICT','INPUT_INVALID'] as const)('preserves a durable hard closure HOLD for %s after original cost, even with a new coordinator/NULL reader',async code=>{
    const f=fixture();f.costLookup.mockResolvedValue(f.costEvidence);const first=new LocalLaMaInvocationCoordinator(f.options);await first.dispatch(f.input,vi.fn());f.costLookup.mockRejectedValue(new DomainError(code,409,'WAIT'));
    expect(await first.lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true,fullCost:f.fullCost});const newCostReader=vi.fn<LocalLaMaCoordinatorOptions['costs']['lookup']>(async()=>null),recreated=new LocalLaMaInvocationCoordinator({...f.options,costs:{lookup:newCostReader}});
    expect(await recreated.lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true,fullCost:f.fullCost});expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_COST_FACT_CONFLICT')).toBe(true);expect(newCostReader).not.toHaveBeenCalled();expect(f.submit).toHaveBeenCalledOnce();
  });
  it('distinguishes plain cost I/O uncertainty from a confirmed closure conflict without erasing original full cost',async()=>{
    const f=fixture();f.costLookup.mockResolvedValue(f.costEvidence);const first=new LocalLaMaInvocationCoordinator(f.options);await first.dispatch(f.input,vi.fn());f.costLookup.mockRejectedValue(Error('OWNED_COST_READER_IO_UNCONFIRMED'));
    expect(await first.lookup(f.capture)).toMatchObject({state:'UNKNOWN',fullCost:f.fullCost,start:f.start});const newCostReader=vi.fn<LocalLaMaCoordinatorOptions['costs']['lookup']>(async()=>null);expect(await new LocalLaMaInvocationCoordinator({...f.options,costs:{lookup:newCostReader}}).lookup(f.capture)).toMatchObject({state:'SUCCEEDED',fullCost:f.fullCost,start:f.start});expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_COST_FACT_CONFLICT')).toBe(false);expect(f.submit).toHaveBeenCalledOnce();
  });
  it.each(['MISSING_JOINED','EXTRA_FIELD','OWN_THEN_GETTER'] as const)('observes rejected native Promise data before rejecting a malformed %s handle without weakening HOLD/shape guards',async kind=>{
    const f=fixture(),getter=vi.fn(()=>{throw Error('OWNED_REJECTED_PROMISE_THEN_GETTER');});f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.submit.mockImplementation(()=>{
      const reply=Promise.reject<LocalLaMaExecutorReply|null>(Error('OWNED_REJECTED_REPLY_BEFORE_HANDLE_VALIDATION'));
      if(kind==='MISSING_JOINED')return {reply} as LocalLaMaEngineInvocation;
      if(kind==='EXTRA_FIELD')return {reply,joined:Promise.reject<void>(Error('OWNED_REJECTED_JOINED_BEFORE_HANDLE_VALIDATION')),extra:true} as LocalLaMaEngineInvocation;
      Object.defineProperty(reply,'then',{get:getter,enumerable:true});return {reply,joined:Promise.resolve()};
    });const first=new LocalLaMaInvocationCoordinator(f.options);
    await expect(first.dispatch(f.input,vi.fn())).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_FACT_INVALID'});expect(getter).not.toHaveBeenCalled();await expect(first.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});
    expect(await new LocalLaMaInvocationCoordinator(f.options).lookup(f.capture)).toMatchObject({state:'UNKNOWN',start:f.start,providerSuccess:true});expect(f.submit).toHaveBeenCalledOnce();expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);
  });
  it.each(['CONSTRUCTOR_GETTER','PROXY_CONSTRUCTOR','SPECIES_GETTER'] as const)('declines intrinsic observation of unsafe %s metadata without invoking caller code',async kind=>{
    const f=fixture(),trap=vi.fn(()=>{throw Error('OWNED_PROMISE_CONSTRUCTOR_OR_SPECIES_TRAP');});f.options.bounds={...f.options.bounds,maxConcurrentCalls:1};f.submit.mockImplementation(()=>{const reply=Promise.resolve(copy(f.reply));
      if(kind==='CONSTRUCTOR_GETTER')Object.defineProperty(reply,'constructor',{get:trap,enumerable:true});else if(kind==='PROXY_CONSTRUCTOR')Object.defineProperty(reply,'constructor',{value:new Proxy(Promise,{get:trap,getPrototypeOf:trap,construct:trap}),enumerable:true});else{const constructor={};Object.defineProperty(constructor,Symbol.species,{get:trap});Object.defineProperty(reply,'constructor',{value:constructor,enumerable:true});}return {reply,joined:Promise.resolve()};
    });const first=new LocalLaMaInvocationCoordinator(f.options);await expect(first.dispatch(f.input,vi.fn())).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_FACT_INVALID'});expect(trap).not.toHaveBeenCalled();await expect(first.lookup(f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT'});expect(f.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);
  });
});
