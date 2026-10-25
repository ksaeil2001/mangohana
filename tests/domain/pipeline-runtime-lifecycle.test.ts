import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createApiRuntime,createRuntime,createWorkerRuntime,type ApiRuntimeOptions,type WorkerRuntimeOptions} from '../../apps/api/src/runtime.js';
import {RuntimeLifecycle} from '../../packages/operations/src/runtime-lifecycle.js';
import {OperationalStageCost} from '../../packages/domain/src/pipeline-stage-cost.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import type {ProjectSigner} from '../../packages/media/src/project-file.js';
import type {AuthProvider} from '../../packages/domain/src/auth-provider.js';
import type {Actor} from '../../packages/domain/src/model.js';

// 실제 factory의 연결만 검사한다. DB/제공자/native/비용 포트는 가짜이며
// 실제 C2 pending과 원 기록의 PG 검사는 별도 파일에서 수행한다.
function deferred<T=void>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const turn=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function fixture(){
  const forbidden=vi.fn(async()=>{throw Error('C4_FORBIDDEN_IO');});
  const query=vi.fn(async()=>({rows:[]}));
  const worker={role:'trio_web_worker',pool:{query},accountTransaction:forbidden} as unknown as Database;
  const api={pool:{query:forbidden},accountTransaction:forbidden} as unknown as Database;
  const objects={bucket:'c4-memory',put:forbidden,read:forbidden,receipt:forbidden,remove:forbidden} as ObjectStore;
  const fonts={catalog:{version:'c4-memory',fonts:[]},bytes:new Map()} as unknown as FontCatalog;
  const gateway=()=>({forTarget:vi.fn(()=>{throw Error('C4_FORBIDDEN_NATIVE');}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})});
  const apiNative=gateway(),workerNative=gateway(),providerIdle=vi.fn(async()=>{});
  const cost=Object.assign(Object.create(OperationalStageCost.prototype),{idle:vi.fn(async()=>{})}) as OperationalStageCost;
  const options:ApiRuntimeOptions&WorkerRuntimeOptions&{workerProviderIdle:()=>Promise<void>}={
    api,worker,objects,fonts,signer:{} as ProjectSigner,authProvider:{} as AuthProvider,allowedAccounts:new Set(),limiterSecret:Buffer.alloc(32,5),
    profile:syntheticProfile,policy:{stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false},
    provider:new SyntheticProvider(),apiNative,workerNative,workerOperationalCost:cost,workerProviderIdle:providerIdle,
  };
  const create=(mode:'worker'|'composed')=>mode==='worker'?createWorkerRuntime(options):createRuntime(options);
  return {options,create,apiNative,workerNative,providerIdle,cost,forbidden,query};
}
it.each(['worker','composed'] as const)('C4 joins fixed provider, native and late original cost in order through %s',async mode=>{
  const f=fixture(),provider=deferred(),native=deferred(),late=deferred(),entered=deferred(),events:string[]=[];
  let costWork=Promise.resolve();
  f.providerIdle.mockImplementation(async()=>{events.push('provider');entered.resolve();await provider.promise;});
  f.workerNative.idle.mockImplementation(async()=>{events.push('native');await native.promise;costWork=late.promise;});
  vi.mocked(f.cost.idle).mockImplementation(async()=>{events.push('cost');await costWork;});
  const runtime=f.create(mode),replacement=vi.fn(async()=>{throw Error('C4_REPLACED_PORT');});
  f.options.workerProviderIdle=replacement;f.options.workerOperationalCost=Object.assign(Object.create(OperationalStageCost.prototype),{idle:replacement}) as OperationalStageCost;
  runtime.stopClaims();const complete=vi.fn(),waiting=runtime.idle().then(complete),settled=waiting.then(()=>false,()=>false);
  try{
    await turn();expect(f.providerIdle).toHaveBeenCalledOnce();
    expect(events).toEqual(['provider']);expect(complete).not.toHaveBeenCalled();
    provider.resolve();await turn();expect(events).toEqual(['provider','native']);
    native.resolve();await turn();expect(events).toEqual(['provider','native','cost']);expect(complete).not.toHaveBeenCalled();
    late.resolve();await waiting;expect(complete).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();expect(vi.mocked(f.cost.idle).mock.contexts[0]===f.cost).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();
  }finally{provider.resolve();native.resolve();late.resolve();await settled;}
});
it('C4 waits for both producers despite a tick rejection before draining later ports',async()=>{
  const f=fixture(),runtime=f.create('worker'),tick=deferred<boolean>(),maintenance=deferred<{rows:never[]}>(),error=Error('C4_TICK_FAILURE');
  vi.spyOn(runtime.execution,'runOnce').mockImplementation(()=>tick.promise);
  f.query.mockImplementation(()=>maintenance.promise);
  const running=runtime.tick(),observed=running.catch(e=>e),maintaining=runtime.maintenance();
  runtime.stopClaims();const waiting=runtime.idle(),outcome=waiting.then(()=>null,e=>e);
  try{
    tick.reject(error);await observed;await turn();expect(f.providerIdle).not.toHaveBeenCalled();
    maintenance.resolve({rows:[]});await maintaining;expect(await outcome).toBe(error);
    expect(f.providerIdle).toHaveBeenCalledOnce();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();
    expect(f.forbidden).not.toHaveBeenCalled();
  }finally{tick.resolve(false);maintenance.resolve({rows:[]});await Promise.allSettled([running,maintaining,waiting]);}
});
it('C4 still joins original cost after native idle rejects and preserves the single error',async()=>{
  const f=fixture(),error=Error('C4_NATIVE_JOIN_UNKNOWN'),cost=deferred(),entered=deferred();
  f.workerNative.idle.mockRejectedValue(error);vi.mocked(f.cost.idle).mockImplementation(async()=>{entered.resolve();await cost.promise;});
  const runtime=f.create('worker');runtime.stopClaims();const waiting=runtime.idle(),outcome=waiting.then(()=>null,e=>e);
  try{await turn();expect(f.cost.idle).toHaveBeenCalledOnce();cost.resolve();expect(await outcome).toBe(error);}
  finally{cost.resolve();await outcome;}
});
it('C4 attempts every worker admission barrier and preserves a repeated stop failure',async()=>{
  const f=fixture(),runtime=f.create('worker'),error=Error('C4_EXECUTION_STOP_UNKNOWN');
  const execution=vi.spyOn(runtime.execution,'stopClaims').mockImplementation(()=>{throw error;}),media=vi.spyOn(runtime.mediaWorker,'stopClaims');
  expect(()=>runtime.stopClaims()).toThrow(error);
  expect(media).toHaveBeenCalledOnce();expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();
  expect(()=>runtime.stopClaims()).toThrow(error);expect(execution).toHaveBeenCalledOnce();expect(media).toHaveBeenCalledOnce();expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();
  const run=vi.spyOn(runtime.execution,'runOnce');await runtime.tick();await runtime.maintenance();expect(run).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
it('C4 attempts worker admission even if the composed API barrier throws',()=>{
  const f=fixture(),error=Error('C4_API_STOP_UNKNOWN');f.apiNative.stopClaims.mockImplementation(()=>{throw error;});
  const runtime=f.create('composed');expect(()=>runtime.stopClaims()).toThrow(error);expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();
  expect(()=>runtime.stopClaims()).toThrow(error);expect(f.apiNative.stopClaims).toHaveBeenCalledOnce();expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();
});
it('C4 joins API native work after a pending build rejects without discarding its failure',async()=>{
  const f=fixture(),runtime=createApiRuntime(f.options),build=deferred(),native=deferred(),entered=deferred(),error=Error('C4_BUILD_UNKNOWN');
  vi.spyOn(runtime.files,'build').mockImplementation(()=>build.promise);
  f.apiNative.idle.mockImplementation(async()=>{entered.resolve();await native.promise;});
  const building=runtime.build({} as Actor,randomUUID()),observed=building.catch(e=>e);
  runtime.stopClaims();const waiting=runtime.idle(),outcome=waiting.then(()=>null,e=>e);
  try{await turn();build.reject(error);await observed;expect(await Promise.race([entered.promise.then(()=>true),outcome.then(()=>false)])).toBe(true);native.resolve();expect(await outcome).toBe(error);}
  finally{build.resolve();native.resolve();await outcome;}
});
it('C4 joins composed API work even if worker native shutdown fails',async()=>{
  const f=fixture(),error=Error('C4_WORKER_UNKNOWN'),api=deferred(),entered=deferred();f.workerNative.idle.mockRejectedValue(error);
  f.apiNative.idle.mockImplementation(async()=>{entered.resolve();await api.promise;});
  const runtime=f.create('composed');runtime.stopClaims();const waiting=runtime.idle(),outcome=waiting.then(()=>null,e=>e);
  try{await turn();expect(f.apiNative.idle).toHaveBeenCalledOnce();api.resolve();expect(await outcome).toBe(error);}
  finally{api.resolve();await outcome;}
});
it.each(['worker','composed'] as const)('C4 shares concurrent %s idle but never caches success across later work',async mode=>{
  const f=fixture(),one=deferred(),two=deferred();vi.mocked(f.cost.idle).mockImplementationOnce(()=>one.promise).mockImplementationOnce(()=>two.promise);
  const runtime=f.create(mode);const a=runtime.idle(),b=runtime.idle(),caught=Promise.allSettled([a,b]);
  try{
    expect(a===b).toBe(true);await turn();expect(f.cost.idle).toHaveBeenCalledOnce();one.resolve();await a;await turn();
    const finished=vi.fn(),next=runtime.idle().then(finished);await turn();expect(f.cost.idle).toHaveBeenCalledTimes(2);expect(finished).not.toHaveBeenCalled();two.resolve();await next;
  }finally{one.resolve();two.resolve();await caught;}
});
it('C4 keeps provider/cost absence compatible with the existing generic worker',async()=>{
  const f=fixture();Reflect.deleteProperty(f.options,'workerProviderIdle');Reflect.deleteProperty(f.options,'workerOperationalCost');
  const runtime=f.create('worker');runtime.stopClaims();await runtime.idle();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
});
it('C4 lifecycle timeout retains the pool while original provider and cost remain pending',async()=>{
  vi.useFakeTimers();const f=fixture(),provider=deferred(),cost=deferred(),close=vi.fn(async()=>{});
  f.providerIdle.mockImplementation(()=>provider.promise);vi.mocked(f.cost.idle).mockImplementation(()=>cost.promise);
  const runtime=f.create('worker'),lifecycle=new RuntimeLifecycle({stopAdmissions:runtime.stopClaims,tick:runtime.tick,idle:runtime.idle,close},{tickMilliseconds:10,maintenanceMilliseconds:100,shutdownMilliseconds:50});
  const stopping=lifecycle.stop();try{
    await vi.advanceTimersByTimeAsync(50);expect(await stopping).toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(close).not.toHaveBeenCalled();
    provider.resolve();await turn();expect(f.cost.idle).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
    cost.resolve();await turn();expect(close).toHaveBeenCalledOnce();expect(lifecycle.stop()===stopping).toBe(true);
    expect(await stopping).toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(f.forbidden).not.toHaveBeenCalled();
  }finally{provider.resolve();cost.resolve();await turn();}
});

it('C4 attempts the API native stop even if the file barrier fails',()=>{
  const f=fixture(),runtime=createApiRuntime(f.options),error=Error('C4_FILE_STOP_UNKNOWN');
  const files=vi.spyOn(runtime.files,'stopClaims').mockImplementation(()=>{throw error;});
  expect(()=>runtime.stopClaims()).toThrow(error);expect(f.apiNative.stopClaims).toHaveBeenCalledOnce();
  expect(()=>runtime.stopClaims()).toThrow(error);expect(files).toHaveBeenCalledOnce();expect(f.apiNative.stopClaims).toHaveBeenCalledOnce();
});
it('C4 preserves every distinct idle failure after joining all worker phases',async()=>{
  const f=fixture(),one=Error('C4_NATIVE_FAILURE'),two=Error('C4_COST_FAILURE');
  f.workerNative.idle.mockRejectedValue(one);vi.mocked(f.cost.idle).mockRejectedValue(two);
  const runtime=f.create('worker');runtime.stopClaims();const error:unknown=await runtime.idle().then(()=>null,e=>e);
  expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors).toEqual([one,two]);
  expect(f.providerIdle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();
});

it.each(['worker','composed'] as const)('C4 reuses completed terminal idle for stopped %s without repeating native or cost joins',async mode=>{
  const f=fixture(),runtime=f.create(mode);runtime.stopClaims();
  const one=runtime.idle();await one;const two=runtime.idle();expect(two===one).toBe(true);await two;
  expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();expect(f.providerIdle).toHaveBeenCalledOnce();
});

it.each(['worker','composed'] as const)('C4 reports a producer error once but reuses successful resource joins on later stopped %s idle',async mode=>{
  const f=fixture(),runtime=f.create(mode),tick=deferred<boolean>(),error=Error('C4_COMPLETED_BUSINESS_FAILURE');
  vi.spyOn(runtime.execution,'runOnce').mockImplementation(()=>tick.promise);
  const running=runtime.tick(),business=running.catch(e=>e);runtime.stopClaims();
  const first=runtime.idle(),outcome=first.then(()=>null,e=>e);
  tick.reject(error);expect(await business).toBe(error);expect(await outcome).toBe(error);
  expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();
  await expect(runtime.idle()).resolves.toBeUndefined();
  expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();
  expect(f.providerIdle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
});

it.each([['worker','tick'],['worker','maintenance'],['composed','tick'],['composed','maintenance']] as const)('C4 rechecks a pre-stop idle for the latest %s %s before final resource joins',async(mode,kind)=>{
  const f=fixture(),runtime=f.create(mode),tick=deferred<boolean>(),maintenance=deferred<{rows:never[]}>(),provider=deferred(),cost=deferred(),complete=vi.fn();
  vi.spyOn(runtime.execution,'runOnce').mockImplementation(()=>tick.promise);
  f.query.mockImplementation(()=>maintenance.promise);
  f.providerIdle.mockImplementation(()=>provider.promise);vi.mocked(f.cost.idle).mockImplementation(()=>cost.promise);
  const beforeStop=runtime.idle(),beforeOutcome=beforeStop.then(()=>null,e=>e);
  const producer=kind==='tick'?runtime.tick():runtime.maintenance(),observed=producer.then(()=>null,e=>e);
  runtime.stopClaims();const afterStop=runtime.idle().then(complete),afterOutcome=afterStop.then(()=>null,e=>e);
  try{
    await turn();expect(complete).not.toHaveBeenCalled();expect(f.providerIdle).not.toHaveBeenCalled();expect(f.workerNative.idle).not.toHaveBeenCalled();
    tick.resolve(false);maintenance.resolve({rows:[]});await producer;await turn();
    expect(f.providerIdle).toHaveBeenCalledOnce();expect(f.workerNative.idle).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
    provider.resolve();await turn();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();expect(complete).not.toHaveBeenCalled();
    cost.resolve();await Promise.all([beforeStop,afterStop]);expect(complete).toHaveBeenCalledOnce();
    await runtime.idle();expect(f.providerIdle).toHaveBeenCalledOnce();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.cost.idle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
  }finally{tick.resolve(false);maintenance.resolve({rows:[]});provider.resolve();cost.resolve();await Promise.all([beforeOutcome,observed,afterOutcome]);}
});
it('C4 rechecks an API pre-stop idle before joining the latest tick and native work',async()=>{
  const f=fixture(),runtime=createApiRuntime(f.options),tick=deferred(),native=deferred(),complete=vi.fn();
  vi.spyOn(runtime.files.builds,'runOnce').mockImplementation(()=>tick.promise);f.apiNative.idle.mockImplementation(()=>native.promise);
  const beforeStop=runtime.idle(),beforeOutcome=beforeStop.then(()=>null,e=>e),producer=runtime.tick(),observed=producer.then(()=>null,e=>e);
  runtime.stopClaims();const afterStop=runtime.idle().then(complete),afterOutcome=afterStop.then(()=>null,e=>e);
  try{
    await turn();expect(complete).not.toHaveBeenCalled();expect(f.apiNative.idle).not.toHaveBeenCalled();
    tick.resolve();await producer;await turn();expect(f.apiNative.idle).toHaveBeenCalledOnce();expect(complete).not.toHaveBeenCalled();
    native.resolve();await Promise.all([beforeStop,afterStop]);await runtime.idle();expect(complete).toHaveBeenCalledOnce();expect(f.apiNative.idle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
  }finally{tick.resolve();native.resolve();await Promise.all([beforeOutcome,observed,afterOutcome]);}
});
it.each(['worker','composed'] as const)('C4 rejoins resources for a new %s producer after an earlier provider drain has begun',async mode=>{
  const f=fixture(),runtime=f.create(mode),firstProvider=deferred(),tick=deferred<boolean>(),lateCost=deferred(),complete=vi.fn();
  let costWork=Promise.resolve();
  f.providerIdle.mockImplementationOnce(()=>firstProvider.promise);
  vi.mocked(f.cost.idle).mockImplementation(()=>costWork);
  vi.spyOn(runtime.execution,'runOnce').mockImplementation(async()=>{await tick.promise;costWork=lateCost.promise;return false;});
  const beforeStop=runtime.idle(),beforeOutcome=beforeStop.then(()=>null,e=>e);await turn();expect(f.providerIdle).toHaveBeenCalledOnce();
  const producer=runtime.tick(),observed=producer.then(()=>null,e=>e);runtime.stopClaims();const afterStop=runtime.idle().then(complete),afterOutcome=afterStop.then(()=>null,e=>e);
  try{
    firstProvider.resolve();await turn();expect(complete).not.toHaveBeenCalled();
    tick.resolve(false);await producer;await turn();expect(complete).not.toHaveBeenCalled();expect(f.cost.idle).toHaveBeenCalledTimes(2);
    lateCost.resolve();await Promise.all([beforeStop,afterStop]);expect(complete).toHaveBeenCalledOnce();
    await runtime.idle();expect(f.providerIdle).toHaveBeenCalledTimes(2);expect(f.workerNative.idle).toHaveBeenCalledTimes(2);expect(f.cost.idle).toHaveBeenCalledTimes(2);expect(f.forbidden).not.toHaveBeenCalled();
  }finally{firstProvider.resolve();tick.resolve(false);lateCost.resolve();await Promise.all([beforeOutcome,observed,afterOutcome]);}
});
