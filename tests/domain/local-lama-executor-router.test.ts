import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import {LocalLaMaAdapter,type LocalLaMaCapture,type LocalLaMaExecutionInput,type LocalLaMaExecutor,type LocalLaMaExecutorReply,type LocalLaMaRuntimeFacts,type LocalLaMaStartFact} from '../../packages/providers/src/local-lama.js';
import {LocalLaMaInvocationCoordinator,type LocalLaMaCoordinatorBounds,type LocalLaMaInvocationBinding,type LocalLaMaAttemptSnapshot,type LocalLaMaInvocationRecord,type LocalLaMaCoordinatorOptions} from '../../packages/providers/src/local-lama-executor.js';
import {LocalLaMaExecutorRouter,type LocalLaMaExecutorRouterBounds} from '../../packages/providers/src/local-lama-executor-router.js';
import {syntheticProfile,type MediaProfile} from '../../packages/media/src/profile.js';

// Owned bytes/metadata/fake capabilities. Declared budgets and rates do not
// prove actual engine, SQL/current claim, physical memory or whole-stage cost.
const bounds=():LocalLaMaExecutorRouterBounds=>({maxRoutes:2,maxRetainedCoordinatorBytes:2*1024*1024,maxConcurrentCalls:2,maxInFlightBytes:2*1024*1024,maxEncodedBytes:4096,maxMetadataBytes:4096});
const budget=():LocalLaMaCoordinatorBounds=>({maxEncodedBytes:4096,maxMetadataBytes:4096,maxInFlightBytes:1024*1024,maxConcurrentCalls:2,maxRecords:8});
function fixture(profile?:MediaProfile){
  const executionId=randomUUID(),inputDigest=sha256('owned-router-input-'+executionId),image=Buffer.from('owned-image'),mask=Buffer.from('owned-mask'),proposal=Buffer.from('owned-proposal');
  const body:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest,profileId:profile?.id??'owned-router-profile',profileDigest:profile?digest(profile):sha256('owned-router-profile'),identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('owned-router-weights'),configSha256:sha256('owned-router-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:sha256(image),imageByteLength:image.length,maskSha256:sha256(mask),maskByteLength:mask.length};
  const capture:LocalLaMaCapture={...body,captureDigest:digest(body)},binding:LocalLaMaInvocationBinding={version:1,accountId:randomUUID(),requestId:randomUUID(),executionId,inputDigest,inputFingerprint:sha256('owned-original-input-'+executionId),fullStageCaptureDigest:sha256('owned-distinct-full-capture-'+executionId),localCaptureDigest:capture.captureDigest,mode:'FREE'};
  const runtime:LocalLaMaRuntimeFacts={version:1,kind:'LOCAL_LAMA',invocationId:randomUUID(),executionId,inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)},start:LocalLaMaStartFact={version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime};
  const reply:LocalLaMaExecutorReply={version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime,state:'SUCCEEDED',providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(proposal),byteLength:proposal.length,bytes:proposal}};
  const input:LocalLaMaExecutionInput={capture,image,mask},dispatch=vi.fn<LocalLaMaExecutor['dispatch']>(async()=>reply),lookup=vi.fn<LocalLaMaExecutor['lookup']>(async()=>reply),executor:LocalLaMaExecutor={dispatch,lookup};
  return {input,capture,binding,runtime,start,reply,executor,dispatch,lookup,budget:budget()};
}
const hold={code:'LOCAL_LAMA_ROUTER_CAPACITY_WAIT',nextAction:'WAIT'},conflict={code:'LOCAL_LAMA_ROUTER_CONFLICT',nextAction:'WAIT'};
const missing={code:'LOCAL_LAMA_ROUTER_ORIGINAL_UNCONFIRMED',nextAction:'WAIT'},invalid={code:'LOCAL_LAMA_ROUTER_INPUT_UNCONFIRMED',nextAction:'WAIT'},factHold={code:'LOCAL_LAMA_ROUTER_FACT_UNCONFIRMED',nextAction:'WAIT'},callbackHold={code:'LOCAL_LAMA_ROUTER_CALLBACK_UNCONFIRMED',nextAction:'WAIT'};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
function copy<T>(value:T):T{if(Buffer.isBuffer(value))return Buffer.from(value) as T;if(Array.isArray(value))return value.map(copy) as T;if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;return value;}
function proxy<T extends object>(value:T){let calls=0;const trap=()=>{calls++;throw Error('OWNED_PROXY_TRAP');};return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}
function getter<T extends object>(value:T,key:string){let calls=0;Object.defineProperty(value,key,{enumerable:true,configurable:true,get(){calls++;throw Error('OWNED_GETTER');}});return {value,calls:()=>calls};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function coordinatorFixture(){
  const f=fixture(),original={version:1 as const,bindingDigest:digest(f.binding),localCaptureDigest:f.capture.captureDigest,invocationId:f.runtime.invocationId},records:LocalLaMaInvocationRecord[]=[];let claimed=false;
  const snapshot=():LocalLaMaAttemptSnapshot=>({version:1,original:copy(original),records:copy(records)});
  const claim=vi.fn<LocalLaMaCoordinatorOptions['attempts']['claim']>(async()=>{const created=!claimed;claimed=true;return {...snapshot(),created};});
  const lookup=vi.fn<LocalLaMaCoordinatorOptions['attempts']['lookup']>(async()=>claimed?snapshot():null);
  const append=vi.fn<LocalLaMaCoordinatorOptions['attempts']['append']>(async(_binding,_original,row)=>{if(!records.some(known=>known.recordDigest===row.recordDigest))records.push(copy(row));});
  const submit=vi.fn<LocalLaMaCoordinatorOptions['engine']['submit']>(()=>({reply:Promise.resolve(copy(f.reply)),joined:Promise.reject(Error('OWNED_ORIGINAL_JOIN_UNKNOWN'))}));
  const query=vi.fn<LocalLaMaCoordinatorOptions['engine']['query']>(()=>({reply:Promise.resolve(copy(f.reply)),joined:Promise.resolve()}));
  const costs=vi.fn<LocalLaMaCoordinatorOptions['costs']['lookup']>(async()=>null);
  const options:LocalLaMaCoordinatorOptions={binding:f.binding,capture:f.capture,bounds:f.budget,attempts:{claim,lookup,append},engine:{submit,query},costs:{lookup:costs}};
  return {...f,original,records,options,claim,storeLookup:lookup,append,submit,query,costs};
}
describe('private original LocalLaMa executor catalogue',()=>{
  it('preserves a valid successful proposal with unknown START and independent unknown full cost',async()=>{
    const a=fixture(),router=new LocalLaMaExecutorRouter(bounds()),onStarted=vi.fn(async()=>{});a.reply.start=null;router.register(a.binding,a.capture,a.executor,a.budget);
    const dispatched=await router.dispatch(a.input,onStarted);expect(dispatched).toEqual(a.reply);expect(dispatched.state).toBe('SUCCEEDED');expect(dispatched.providerSuccess).toBe(true);expect(dispatched.start).toBeNull();expect(dispatched.fullCost).toBeNull();expect(onStarted).not.toHaveBeenCalled();
    const queried=await router.lookup(a.capture);expect(queried).toEqual(a.reply);expect(queried!.proposal!.bytes).toEqual(a.reply.proposal!.bytes);expect(queried!.start).toBeNull();expect(queried!.fullCost).toBeNull();
  });
  it('dispatches each original execution only through its registered capability',async()=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter(bounds()),onStarted=vi.fn(async()=>{});router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);
    expect(await router.dispatch(a.input,onStarted)).toEqual(a.reply);expect(await router.dispatch(b.input,onStarted)).toEqual(b.reply);expect(a.dispatch).toHaveBeenCalledExactlyOnceWith(a.input,expect.any(Function));expect(b.dispatch).toHaveBeenCalledExactlyOnceWith(b.input,expect.any(Function));expect(a.lookup).not.toHaveBeenCalled();expect(b.lookup).not.toHaveBeenCalled();
  });
  it('keeps exact re-registration idempotent without double reserving the declared coordinator budget',async()=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);expect(await router.lookup(a.capture)).toEqual(a.reply);expect(await router.lookup(b.capture)).toEqual(b.reply);expect(a.dispatch).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();
  });
  it('keeps the first capability when another account tries to register the same original execution',async()=>{
    const a=fixture(),other={...a.binding,accountId:randomUUID()},router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);expect(()=>router.register(other,a.capture,a.executor,a.budget)).toThrowError(expect.objectContaining(conflict));expect(await router.lookup(a.capture)).toEqual(a.reply);
  });
  it('refuses a new original route once the retained catalogue is full',async()=>{
    const a=fixture(),b=fixture(),c=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);expect(()=>router.register(c.binding,c.capture,c.executor,c.budget)).toThrowError(expect.objectContaining(hold));expect(a.dispatch).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();expect(c.dispatch).not.toHaveBeenCalled();
  });
  it('returns null for an unknown lookup and WAIT for dispatch without selecting another capability',async()=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);expect(await router.lookup(b.capture)).toBeNull();await expect(router.dispatch(b.input,vi.fn(async()=>{}))).rejects.toMatchObject(missing);expect(a.dispatch).not.toHaveBeenCalled();expect(a.lookup).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();expect(b.lookup).not.toHaveBeenCalled();
  });
  it('preserves the first route on port, original binding, capture and declaration conflicts',async()=>{
    for(const kind of ['port','binding','capture','budget']){const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);
      let binding=a.binding,capture=a.capture,executor=a.executor,declared=a.budget;if(kind==='port')executor=b.executor;if(kind==='binding')binding={...binding,requestId:randomUUID()};if(kind==='budget')declared={...declared,maxInFlightBytes:declared.maxInFlightBytes+1};if(kind==='capture'){const {captureDigest:_digest,...body}=capture,changed={...body,maskSha256:sha256('different-original-mask')};capture={...changed,captureDigest:digest(changed)};binding={...binding,localCaptureDigest:capture.captureDigest};}
      expect(()=>router.register(binding,capture,executor,declared)).toThrowError(expect.objectContaining(conflict));expect(await router.lookup(a.capture)).toEqual(a.reply);expect(b.lookup).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();
    }
  });
  it('rejects reuse of the same capability object across different original executions',async()=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);expect(()=>router.register(b.binding,b.capture,a.executor,b.budget)).toThrowError(expect.objectContaining(conflict));expect(await router.lookup(b.capture)).toBeNull();expect(await router.lookup(a.capture)).toEqual(a.reply);expect(a.lookup).toHaveBeenCalledExactlyOnceWith(a.capture);expect(a.dispatch).not.toHaveBeenCalled();
  });
  it('owns registration metadata/bounds and captures the original methods despite later caller mutation',async()=>{
    const a=fixture(),owned=copy(a.input),binding=copy(a.binding),declared=copy(a.budget),limits=bounds(),router=new LocalLaMaExecutorRouter(limits);router.register(a.binding,a.capture,a.executor,a.budget);
    Object.assign(a.binding,{accountId:randomUUID()});Object.assign(a.capture.identity,{weightsSha256:sha256('changed-caller-identity')});Object.assign(a.budget,{maxInFlightBytes:1,maxRecords:1});limits.maxRoutes=1;limits.maxInFlightBytes=1;const newDispatch=vi.fn<LocalLaMaExecutor['dispatch']>(async()=>{throw Error('REPLACED_DISPATCH');}),newLookup=vi.fn<LocalLaMaExecutor['lookup']>(async()=>{throw Error('REPLACED_LOOKUP');});a.executor.dispatch=newDispatch;a.executor.lookup=newLookup;
    expect(await router.dispatch(owned,vi.fn(async()=>{}))).toEqual(a.reply);expect(await router.lookup(owned.capture)).toEqual(a.reply);expect(a.dispatch).toHaveBeenCalledOnce();expect(a.lookup).toHaveBeenCalledOnce();expect(newDispatch).not.toHaveBeenCalled();expect(newLookup).not.toHaveBeenCalled();expect(()=>router.register(binding,owned.capture,a.executor,declared)).toThrowError(expect.objectContaining(conflict));
  });
  it('rejects registration and method descriptors/Proxies without executing traps or calling a delegate',()=>{
    for(const kind of ['bounds-proxy','bounds-getter','binding-proxy','capture-getter','identity-proxy','budget-getter','port-proxy','port-getter','method-proxy']){const a=fixture();let calls=()=>0;let limits=bounds(),binding=a.binding,capture=a.capture,executor=a.executor,declared=a.budget;
      if(kind==='bounds-proxy'){const bad=proxy(limits);limits=bad.value;calls=bad.calls;}if(kind==='bounds-getter'){const bad=getter(limits,'maxRoutes');limits=bad.value;calls=bad.calls;}if(kind==='binding-proxy'){const bad=proxy(binding);binding=bad.value;calls=bad.calls;}if(kind==='capture-getter'){const bad=getter({...capture},'profileId');capture=bad.value;calls=bad.calls;}if(kind==='identity-proxy'){const bad=proxy(capture.identity);capture={...capture,identity:bad.value};calls=bad.calls;}if(kind==='budget-getter'){const bad=getter({...declared},'maxRecords');declared=bad.value;calls=bad.calls;}if(kind==='port-proxy'){const bad=proxy(executor);executor=bad.value;calls=bad.calls;}if(kind==='port-getter'){const bad=getter(executor,'lookup');executor=bad.value;calls=bad.calls;}if(kind==='method-proxy'){const bad=proxy(a.dispatch);executor={dispatch:bad.value,lookup:a.lookup};calls=bad.calls;}
      expect(()=>{const router=new LocalLaMaExecutorRouter(limits);router.register(binding,capture,executor,declared);}).toThrowError(expect.objectContaining(invalid));expect(calls()).toBe(0);expect(a.dispatch).not.toHaveBeenCalled();expect(a.lookup).not.toHaveBeenCalled();
    }
  });
  it('owns independent outbound image/mask/metadata and returned proposal bytes',async()=>{
    const a=fixture(),original=copy(a.input),reply=copy(a.reply),gate=deferred<LocalLaMaExecutorReply>(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);a.dispatch.mockReturnValueOnce(gate.promise);
    const pending=router.dispatch(a.input,vi.fn(async()=>{}));a.input.image.fill(0);a.input.mask.fill(255);Object.assign(a.capture.identity,{weightsSha256:sha256('changed-while-awaiting')});expect(a.dispatch.mock.calls[0][0]).toEqual(original);expect(a.dispatch.mock.calls[0][0].image).not.toBe(a.input.image);expect(a.dispatch.mock.calls[0][0].mask).not.toBe(a.input.mask);
    gate.resolve(a.reply);const result=await pending;expect(result).toEqual(reply);expect(result.proposal!.bytes).not.toBe(a.reply.proposal!.bytes);a.reply.proposal!.bytes.fill(0);expect(result).toEqual(reply);
  });
  it('rejects hash/length/binary shape before delegating and protects the original route',async()=>{
    for(const kind of ['image-sha','mask-sha','image-length','mask-length','buffer-proxy','buffer-extra','capture-getter','metadata-width']){const a=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);const input=copy(a.input);let calls=()=>0;
      if(kind==='image-sha')input.image[0]^=1;if(kind==='mask-sha')input.mask[0]^=1;if(kind==='image-length')input.image=Buffer.concat([input.image,Buffer.from('x')]);if(kind==='mask-length')input.mask=input.mask.subarray(1);if(kind==='buffer-proxy'){const bad=proxy(input.image);input.image=bad.value;calls=bad.calls;}if(kind==='buffer-extra')Object.defineProperty(input.image,'extra',{value:true,enumerable:true});if(kind==='capture-getter'){const bad=getter({...input.capture},'profileId');input.capture=bad.value;calls=bad.calls;}if(kind==='metadata-width')Object.assign(input.capture,{extra:'x'.repeat(4096)});
      await expect(router.dispatch(input,vi.fn(async()=>{}))).rejects.toMatchObject(invalid);expect(calls()).toBe(0);expect(a.dispatch).not.toHaveBeenCalled();expect(await router.lookup(a.capture)).toEqual(a.reply);
    }
  });
  it('rejects malformed native Promise capabilities without invoking then/constructor getters',async()=>{
    for(const kind of ['plain','proxy','constructor-getter','then-getter'] as const){const a=fixture(),router=new LocalLaMaExecutorRouter(bounds());let calls=()=>0;let result:unknown=Promise.resolve(a.reply);
      if(kind==='plain'){const bad=getter({},'then');result=bad.value;calls=bad.calls;}if(kind==='proxy'){const bad=proxy(result as Promise<LocalLaMaExecutorReply>);result=bad.value;calls=bad.calls;}if(kind==='constructor-getter'){const bad=getter(result as Promise<LocalLaMaExecutorReply>,'constructor');result=bad.value;calls=bad.calls;}if(kind==='then-getter'){const bad=getter(result as Promise<LocalLaMaExecutorReply>,'then');result=bad.value;calls=bad.calls;}
      // A spy inspects returned .then/instanceof Promise itself; a plain owned
      // port keeps these malformed values at the router boundary only.
      let reads=0;const executor:LocalLaMaExecutor={dispatch:a.dispatch,lookup:()=>++reads===1?result as ReturnType<LocalLaMaExecutor['lookup']>:Promise.resolve(a.reply)};router.register(a.binding,a.capture,executor,a.budget);
      if(kind==='then-getter'){expect(await router.lookup(a.capture)).toEqual(a.reply);expect(await router.lookup(a.capture)).toEqual(a.reply);expect(reads).toBe(2);}else{await expect(router.lookup(a.capture)).rejects.toMatchObject(missing);await expect(router.lookup(a.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_ROUTER_LIFETIME_UNCONFIRMED',nextAction:'WAIT'});expect(reads).toBe(1);}expect(calls()).toBe(0);expect(a.dispatch).not.toHaveBeenCalled();
    }
  });
  it('validates returned reply/runtime/proposal/cost shapes while preserving unknown START',async()=>{
    for(const kind of ['reply-extra','runtime-id','runtime-capture','runtime-proxy','proposal-sha','proposal-length','proposal-proxy','provider','model-cost']){const a=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);const reply=copy(a.reply);let calls=()=>0;
      if(kind==='reply-extra')Object.assign(reply,{extra:true});if(kind==='runtime-id')Object.assign(reply.runtime,{invocationId:'invalid'});if(kind==='runtime-capture')Object.assign(reply.runtime,{executionId:randomUUID()});if(kind==='runtime-proxy'){const bad=proxy(reply.runtime);reply.runtime=bad.value;calls=bad.calls;}if(kind==='proposal-sha')reply.proposal!.sha256=sha256('wrong-proposal');if(kind==='proposal-length')reply.proposal!.byteLength++;if(kind==='proposal-proxy'){const bad=proxy(reply.proposal!.bytes);reply.proposal!.bytes=bad.value;calls=bad.calls;}if(kind==='provider')reply.providerSuccess=false;if(kind==='model-cost')reply.fullCost={version:1,scope:'MODEL_ONLY',captureDigest:a.capture.captureDigest,runtimeDigest:digest(a.runtime),actualUsd:'0.01',evidenceRef:'owned-model-only',basisVersion:'owned'} as unknown as NonNullable<LocalLaMaExecutorReply['fullCost']>;
      a.lookup.mockResolvedValueOnce(reply);await expect(router.lookup(a.capture)).rejects.toMatchObject(kind==='proposal-proxy'?invalid:factHold);expect(calls()).toBe(0);expect(await router.lookup(a.capture)).toEqual(a.reply);
    }
  });
  it('denies temporary concurrent/byte capacity without delegate calls and releases after joined success',async()=>{
    for(const constrained of ['calls','bytes']){const a=fixture(),b=fixture(),limits=bounds();if(constrained==='calls')limits.maxConcurrentCalls=1;else limits.maxInFlightBytes=4*(a.input.image.length+a.input.mask.length+limits.maxEncodedBytes)+8*limits.maxMetadataBytes*(a.budget.maxRecords+4);
      const router=new LocalLaMaExecutorRouter(limits),gate=deferred<LocalLaMaExecutorReply>();router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);a.dispatch.mockReturnValueOnce(gate.promise);const pending=router.dispatch(a.input,vi.fn(async()=>{}));
      await expect(router.lookup(b.capture)).rejects.toMatchObject(hold);await expect(router.dispatch(b.input,vi.fn(async()=>{}))).rejects.toMatchObject(hold);expect(b.lookup).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();gate.resolve(a.reply);await pending;expect(await router.lookup(b.capture)).toEqual(b.reply);
    }
  });
  it('releases temporary capacity after delegate error while never evicting a retained coordinator declaration',async()=>{
    const a=fixture(),b=fixture(),c=fixture(),router=new LocalLaMaExecutorRouter({...bounds(),maxRoutes:3,maxConcurrentCalls:1});router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);a.dispatch.mockRejectedValueOnce(Error('OWNED_DELEGATE_ERROR'));
    await expect(router.dispatch(a.input,vi.fn(async()=>{}))).rejects.toMatchObject(missing);expect(await router.lookup(a.capture)).toEqual(a.reply);expect(await router.lookup(b.capture)).toEqual(b.reply);expect(()=>router.register(c.binding,c.capture,c.executor,c.budget)).toThrowError(expect.objectContaining(hold));expect(c.dispatch).not.toHaveBeenCalled();expect(c.lookup).not.toHaveBeenCalled();
  });
  it.each(['success','error'] as const)('joins pending START I/O before settling delegate %s and releasing temporary capacity',async outcome=>{
    const a=fixture(),router=new LocalLaMaExecutorRouter({...bounds(),maxConcurrentCalls:1}),io=deferred<void>(),onStarted=vi.fn(async()=>io.promise);router.register(a.binding,a.capture,a.executor,a.budget);a.dispatch.mockImplementationOnce(async(_input,started)=>{void started(a.start);if(outcome==='error')throw Error('OWNED_DELEGATE_ERROR');return a.reply;});
    const pending=router.dispatch(a.input,onStarted);let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});const assertion=outcome==='error'?expect(pending).rejects.toMatchObject(missing):expect(pending).resolves.toEqual(a.reply);await tick();expect(onStarted).toHaveBeenCalledExactlyOnceWith(a.start);expect(settled).toBe(false);await expect(router.lookup(a.capture)).rejects.toMatchObject(hold);expect(a.lookup).not.toHaveBeenCalled();io.resolve();await assertion;expect(await router.lookup(a.capture)).toEqual(a.reply);
  });
  it('owns the validated reply and START metadata before pending callback I/O',async()=>{
    const a=fixture(),reply=copy(a.reply),fact=copy(a.start),router=new LocalLaMaExecutorRouter(bounds()),io=deferred<void>();router.register(a.binding,a.capture,a.executor,a.budget);const onStarted=vi.fn(async(value:LocalLaMaStartFact)=>{Object.assign(value.runtime,{identityDigest:sha256('changed-callback-copy')});await io.promise;});a.dispatch.mockImplementationOnce(async(_input,started)=>{void started(a.start);return a.reply;});const pending=router.dispatch(a.input,onStarted);await tick();
    expect(a.start).toEqual(fact);expect(onStarted.mock.calls[0][0]).not.toBe(a.start);expect(onStarted.mock.calls[0][0].runtime).not.toBe(a.start.runtime);a.reply.proposal!.bytes.fill(0);a.reply.evidenceId=randomUUID();Object.assign(a.reply.runtime,{identityDigest:sha256('changed-reply-copy')});io.resolve();expect(await pending).toEqual(reply);expect(onStarted).toHaveBeenCalledOnce();
  });
  it.each(['then','constructor','forged-then'] as const)('joins private START I/O without rereading the exposed callback Promise %s',async key=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter({...bounds(),maxConcurrentCalls:1}),io=deferred<void>();let traps=0;
    router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);
    a.dispatch.mockImplementationOnce(async(_input,started)=>{const exposed=started(a.start);if(key==='forged-then')Object.defineProperty(exposed,'then',{value:(done:()=>unknown)=>{traps++;done();return Promise.resolve();}});else Object.defineProperty(exposed,key,{get(){traps++;throw Error('OWNED_EXPOSED_PROMISE_GETTER');}});return a.reply;});
    const pending=router.dispatch(a.input,()=>io.promise);let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});await tick();
    const before={settled,traps},capacity=await router.lookup(b.capture).then(()=>null,(error:unknown)=>error);io.resolve();const outcome=await pending.then(value=>({value}),(error:unknown)=>({error}));
    expect(before).toEqual({settled:false,traps:0});expect(capacity).toMatchObject(hold);expect(b.lookup).not.toHaveBeenCalled();expect(outcome).toEqual({value:a.reply});expect(traps).toBe(0);expect(await router.lookup(b.capture)).toEqual(b.reply);
  });
  it.each(['callback-calls','dispatch-calls','lookup-calls','callback-bytes','dispatch-bytes','lookup-bytes'] as const)('retains transient capacity when the invoked %s port returns an unjoinable native Promise',async variant=>{
    const kind=variant.split('-')[0],a=fixture(),b=fixture(),limits={...bounds(),maxConcurrentCalls:variant.endsWith('calls')?1:2};if(variant.endsWith('bytes'))limits.maxInFlightBytes=4*(a.input.image.length+a.input.mask.length+limits.maxEncodedBytes)+8*limits.maxMetadataBytes*(a.budget.maxRecords+4);
    const router=new LocalLaMaExecutorRouter(limits),io=deferred<void>(),delegate=deferred<LocalLaMaExecutorReply>();let traps=0,reads=0,writes=0,dispatches=0;
    const raw=kind==='callback'?io.promise:delegate.promise;Object.defineProperty(raw,'constructor',{get(){traps++;throw Error('OWNED_UNJOINABLE_PROMISE');}});
    const executor:LocalLaMaExecutor={dispatch:(_input,started)=>{dispatches++;if(kind==='callback'){void started(a.start);return Promise.resolve(a.reply);}return delegate.promise;},lookup:()=>{reads++;return delegate.promise;}};
    router.register(a.binding,a.capture,executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);
    const pending=kind==='lookup'?router.lookup(a.capture):router.dispatch(a.input,()=>{writes++;return io.promise;});await expect(pending).rejects.toMatchObject(kind==='callback'?callbackHold:missing);
    expect(traps).toBe(0);expect(writes).toBe(kind==='callback'?1:0);expect(dispatches).toBe(kind==='lookup'?0:1);expect(reads).toBe(kind==='lookup'?1:0);
    const queryCapacity=await router.lookup(b.capture).then(()=>null,(error:unknown)=>error),dispatchCapacity=await router.dispatch(b.input,async()=>{}).then(()=>null,(error:unknown)=>error);io.resolve();delegate.resolve(a.reply);await tick();
    expect(queryCapacity).toMatchObject(hold);expect(dispatchCapacity).toMatchObject(hold);expect(b.lookup).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();router.register(a.binding,a.capture,executor,a.budget);await expect(router.lookup(a.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_ROUTER_LIFETIME_UNCONFIRMED',nextAction:'WAIT'});await expect(router.lookup(b.capture)).rejects.toMatchObject(hold);expect(traps).toBe(0);
  });
  it.each(['callback','dispatch','lookup'] as const)('keeps a synchronous %s throw distinct from an unjoinable returned Promise',async kind=>{
    const a=fixture(),b=fixture(),router=new LocalLaMaExecutorRouter({...bounds(),maxConcurrentCalls:1});let calls=0;
    const executor:LocalLaMaExecutor={dispatch:(_input,started)=>{if(kind==='callback'){void started(a.start);return Promise.resolve(a.reply);}throw Error('OWNED_SYNC_DISPATCH_THROW');},lookup:()=>{calls++;if(kind==='lookup'&&calls===1)throw Error('OWNED_SYNC_LOOKUP_THROW');return Promise.resolve(a.reply);}};
    router.register(a.binding,a.capture,executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);
    if(kind==='lookup')await expect(router.lookup(a.capture)).rejects.toThrow('OWNED_SYNC_LOOKUP_THROW');else await expect(router.dispatch(a.input,()=>{throw Error('OWNED_SYNC_CALLBACK_THROW');})).rejects.toMatchObject(kind==='callback'?callbackHold:{message:'OWNED_SYNC_DISPATCH_THROW'});
    expect(await router.lookup(a.capture)).toEqual(a.reply);expect(await router.lookup(b.capture)).toEqual(b.reply);
  });
  it('cannot hide an ignored callback rejection, malformed fact or callback return',async()=>{
    for(const kind of ['rejected','invalid-fact','getter-fact','thenable-return','proxy-return']){const a=fixture(),router=new LocalLaMaExecutorRouter(bounds());router.register(a.binding,a.capture,a.executor,a.budget);let calls=()=>0;let fact=a.start;if(kind==='invalid-fact')fact={...fact,captureDigest:sha256('different-start')};if(kind==='getter-fact'){const bad=getter({...fact},'runtime');fact=bad.value;calls=bad.calls;}
      let returned:unknown=Promise.resolve();if(kind==='rejected')returned=Promise.reject(Error('OWNED_START_IO_REJECTED'));if(kind==='thenable-return'){const bad=getter({},'then');returned=bad.value;calls=bad.calls;}if(kind==='proxy-return'){const bad=proxy(Promise.resolve());returned=bad.value;calls=bad.calls;}
      let writes=0;const onStarted=()=>{writes++;return returned as Promise<void>;};a.dispatch.mockImplementationOnce(async(_input,started)=>{void started(fact);return a.reply;});await expect(router.dispatch(a.input,onStarted)).rejects.toMatchObject(callbackHold);expect(calls()).toBe(0);expect(writes).toBe(['invalid-fact','getter-fact'].includes(kind)?0:1);
    }
  });
  it('bounds callback I/O count even when a delegate ignores refused callbacks',async()=>{
    const a=fixture(),router=new LocalLaMaExecutorRouter(bounds()),onStarted=vi.fn(async()=>{});router.register(a.binding,a.capture,a.executor,{...a.budget,maxRecords:2});a.dispatch.mockImplementationOnce(async(_input,started)=>{for(let at=0;at<3;at++)void started(a.start);return a.reply;});await expect(router.dispatch(a.input,onStarted)).rejects.toMatchObject(callbackHold);expect(onStarted).toHaveBeenCalledTimes(2);
  });
  it('prevents late callback I/O and keeps the route hold through exact re-registration',async()=>{
    const a=fixture(),router=new LocalLaMaExecutorRouter(bounds()),onStarted=vi.fn(async()=>{});router.register(a.binding,a.capture,a.executor,a.budget);let callback!:Parameters<LocalLaMaExecutor['dispatch']>[1];a.dispatch.mockImplementationOnce(async(_input,started)=>{callback=started;return a.reply;});expect(await router.dispatch(a.input,onStarted)).toEqual(a.reply);
    await expect(callback(a.start)).rejects.toMatchObject(callbackHold);expect(onStarted).not.toHaveBeenCalled();router.register(a.binding,a.capture,a.executor,a.budget);await expect(router.lookup(a.capture)).rejects.toMatchObject(callbackHold);await expect(router.dispatch(a.input,onStarted)).rejects.toMatchObject(callbackHold);expect(a.dispatch).toHaveBeenCalledOnce();expect(a.lookup).not.toHaveBeenCalled();
  });
  it('projects two original router capabilities through actual lookupFacts without fabricating START, success material or cost',async()=>{
    const profile:MediaProfile={...syntheticProfile,id:'owned-router-facts-profile',kind:'MEASURED',maxImageBytes:4096},a=fixture(profile),b=fixture(profile),router=new LocalLaMaExecutorRouter(bounds());a.reply.start=null;b.reply.start=null;router.register(a.binding,a.capture,a.executor,a.budget);router.register(b.binding,b.capture,b.executor,b.budget);
    const adapter=()=>new LocalLaMaAdapter({enabled:true,profile,identity:a.capture.identity,executor:router,bounds:{maxCapturedExecutions:2,maxInFlightBytes:1024*1024}});
    const reader=adapter(),first=await reader.lookupFacts(a.capture),second=await reader.lookupFacts(b.capture),reopened=await adapter().lookupFacts(a.capture);
    for(const [result,original] of [[first,a],[second,b],[reopened,a]] as const){expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_ORIGINAL_FACTS',started:null,providerSuccess:true,costUsd:null,usageConfirmed:false,start:null,fullCost:null,png:null,approval:'UNAPPROVED',runtime:original.runtime,capture:original.capture});}
    expect(a.lookup).toHaveBeenCalledTimes(2);expect(b.lookup).toHaveBeenCalledOnce();expect(a.dispatch).not.toHaveBeenCalled();expect(b.dispatch).not.toHaveBeenCalled();
  });
  it('retains the actual coordinator hard lifetime HOLD and prevents a replacement route or query from clearing it',async()=>{
    const a=coordinatorFixture(),router=new LocalLaMaExecutorRouter(bounds()),coordinator=new LocalLaMaInvocationCoordinator(a.options),onStarted=vi.fn(async()=>{});router.register(a.binding,a.capture,coordinator,a.budget);
    const first=await router.dispatch(a.input,onStarted);expect(first).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:a.start,fullCost:null});expect(first.proposal!.bytes).toEqual(a.reply.proposal!.bytes);expect(a.records.some(row=>row.kind==='HOLD'&&row.code==='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED')).toBe(true);expect(a.submit).toHaveBeenCalledOnce();
    const reopened=new LocalLaMaInvocationCoordinator(a.options);expect(()=>router.register(a.binding,a.capture,reopened,a.budget)).toThrowError(expect.objectContaining(conflict));router.register(a.binding,a.capture,coordinator,a.budget);expect(await router.lookup(a.capture)).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:a.start,fullCost:null});
    const newRouter=new LocalLaMaExecutorRouter(bounds());newRouter.register(a.binding,a.capture,reopened,a.budget);expect(await newRouter.lookup(a.capture)).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:a.start,fullCost:null});expect(a.submit).toHaveBeenCalledOnce();expect(a.claim).toHaveBeenCalledOnce();expect(a.query).toHaveBeenCalledTimes(2);expect(a.costs).not.toHaveBeenCalled();
  });
});
