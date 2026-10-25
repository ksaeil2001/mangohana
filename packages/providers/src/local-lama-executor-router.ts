import {types} from 'node:util';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {money} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import type {LocalLaMaCapture,LocalLaMaExecutionInput,LocalLaMaExecutor,LocalLaMaExecutorReply,LocalLaMaRuntimeFacts,LocalLaMaStartFact,LocalLaMaFullCost} from './local-lama.js';
import type {LocalLaMaCoordinatorBounds,LocalLaMaInvocationBinding} from './local-lama-executor.js';

export type LocalLaMaExecutorRouterBounds={maxRoutes:number;maxRetainedCoordinatorBytes:number;maxConcurrentCalls:number;maxInFlightBytes:number;maxEncodedBytes:number;maxMetadataBytes:number};
type Route={binding:LocalLaMaInvocationBinding;capture:LocalLaMaCapture;budget:LocalLaMaCoordinatorBounds;registrationDigest:string;executor:LocalLaMaExecutor;dispatch:LocalLaMaExecutor['dispatch'];lookup:LocalLaMaExecutor['lookup'];lateCallback:boolean;unjoinedLifetime:boolean};
const invalid='LOCAL_LAMA_ROUTER_INPUT_UNCONFIRMED',factCode='LOCAL_LAMA_ROUTER_FACT_UNCONFIRMED',conflict='LOCAL_LAMA_ROUTER_CONFLICT',capacity='LOCAL_LAMA_ROUTER_CAPACITY_WAIT',missing='LOCAL_LAMA_ROUTER_ORIGINAL_UNCONFIRMED',callbackCode='LOCAL_LAMA_ROUTER_CALLBACK_UNCONFIRMED',lifetimeCode='LOCAL_LAMA_ROUTER_LIFETIME_UNCONFIRMED';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[0-9a-f]{64}$/;
const nativePromise=Promise,nativePromisePrototype=Promise.prototype,nativeSpeciesGetter=Object.getOwnPropertyDescriptor(Promise,Symbol.species)!.get;
const intrinsicThen=Function.prototype.call.bind(Promise.prototype.then) as (value:Promise<unknown>,fulfilled:(value:unknown)=>unknown,rejected:(reason:unknown)=>unknown)=>Promise<unknown>;
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object,byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
function must(condition:unknown,code=invalid):asserts condition{requireCondition(condition,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[],code=invalid):void{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,code);
  const fields=Object.getOwnPropertyDescriptors(value);must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]),code);
}
function positive(value:unknown,maximum=Number.MAX_SAFE_INTEGER,code=invalid):asserts value is number{must(typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=maximum,code);}
function id(value:unknown,code=invalid):asserts value is string{must(typeof value==='string'&&uuid.test(value),code);}
function hexadecimal(value:unknown,code=invalid):asserts value is string{must(typeof value==='string'&&hash.test(value),code);}
function own<T>(value:T,maximum:number,code=invalid):T{
  const active=new Set<object>();let visited=0;const walk=(item:unknown,depth:number):void=>{
    must(++visited<=maximum&&!types.isProxy(item)&&depth<=64,code);if(item===null||typeof item==='boolean')return;if(typeof item==='string'){must(Buffer.byteLength(item)<=maximum,code);return;}if(typeof item==='number'){must(Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER,code);return;}
    must(item!==null&&typeof item==='object'&&!active.has(item),code);active.add(item);
    if(Array.isArray(item)){must(Object.getPrototypeOf(item)===Array.prototype,code);const length=Object.getOwnPropertyDescriptor(item,'length');must(length&&'value'in length&&Number.isSafeInteger(length.value)&&length.value<=maximum&&Reflect.ownKeys(item).length===length.value+1,code);for(let at=0;at<length.value;at++){const field=Object.getOwnPropertyDescriptor(item,String(at));must(field?.enumerable&&'value'in field,code);walk(field.value,depth+1);}}
    else{must(Object.getPrototypeOf(item)===Object.prototype,code);const keys=Reflect.ownKeys(item);must(keys.length<=maximum,code);for(const key of keys){const field=Object.getOwnPropertyDescriptor(item,key);must(typeof key==='string'&&Buffer.byteLength(key)<=maximum&&field?.enumerable&&'value'in field,code);walk(field.value,depth+1);}}
    active.delete(item);
  };
  try{walk(value,0);return JSON.parse(nativeJsonBytes(value,maximum).toString('utf8')) as T;}catch{throw new DomainError(code,409,'WAIT');}
}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function capture(value:LocalLaMaCapture,maximum:number):LocalLaMaCapture{
  closed(value,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);must(value.version===1&&typeof value.profileId==='string'&&value.profileId.trim().length>0&&!value.profileId.includes('\0')&&Buffer.byteLength(value.profileId)<=160);id(value.executionId);
  for(const key of ['inputDigest','profileDigest','imageSha256','maskSha256','captureDigest'] as const)hexadecimal(value[key]);positive(value.imageByteLength,maximum);positive(value.maskByteLength,maximum);
  closed(value.identity,['codeCommit','weightsSha256','configSha256','weightsLicenseVerified','runtimeVerified']);must(typeof value.identity.codeCommit==='string'&&/^[0-9a-f]{40}$/.test(value.identity.codeCommit)&&typeof value.identity.weightsLicenseVerified==='boolean'&&typeof value.identity.runtimeVerified==='boolean');hexadecimal(value.identity.weightsSha256);hexadecimal(value.identity.configSha256);
  const {captureDigest,...body}=value;must(digest(body)===captureDigest);return value;
}
function portMethod<K extends 'dispatch'|'lookup'>(executor:LocalLaMaExecutor,key:K):LocalLaMaExecutor[K]{
  must(executor!==null&&typeof executor==='object'&&!types.isProxy(executor));const prototype=Object.getPrototypeOf(executor);must(!types.isProxy(prototype));const field=Object.getOwnPropertyDescriptor(executor,key)??(prototype?Object.getOwnPropertyDescriptor(prototype,key):undefined);must(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value));return field.value as LocalLaMaExecutor[K];
}
function bufferLength(value:unknown,maximum:number):number{
  must(!types.isProxy(value)&&Buffer.isBuffer(value)&&Object.getPrototypeOf(value)===Buffer.prototype);let length:number;try{length=byteLengthGetter.call(value) as number;}catch{throw new DomainError(invalid,409,'WAIT');}positive(length,maximum);
  return length;
}
function bufferCopy(value:Buffer,maximum:number):Buffer{const length=bufferLength(value,maximum),keys=Reflect.ownKeys(value);must(keys.length===length);for(const key of keys){must(typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<length);const field=Object.getOwnPropertyDescriptor(value,key);must(field?.enumerable&&'value'in field);}return Buffer.from(value);}
function standardPromise(value:unknown):value is Promise<unknown>{
  if(types.isProxy(value)||!types.isPromise(value)||Object.getPrototypeOf(value)!==nativePromisePrototype)return false;const constructor=Object.getOwnPropertyDescriptor(value,'constructor'),prototypeConstructor=Object.getOwnPropertyDescriptor(nativePromisePrototype,'constructor'),species=Object.getOwnPropertyDescriptor(nativePromise,Symbol.species);
  return (!constructor||'value'in constructor&&constructor.value===nativePromise)&&!!prototypeConstructor&&'value'in prototypeConstructor&&prototypeConstructor.value===nativePromise&&typeof nativeSpeciesGetter==='function'&&!!species&&species.get===nativeSpeciesGetter&&species.set===undefined;
}
function joinedValue<T>(value:unknown,code:string,onUnjoinable:()=>void):Promise<{value:T}>{
  if(!standardPromise(value)){onUnjoinable();throw new DomainError(code,409,'WAIT');}
  try{return intrinsicThen(value,result=>({value:result}),()=>{throw new DomainError(code,409,'WAIT');}) as Promise<{value:T}>;}catch{onUnjoinable();throw new DomainError(code,409,'WAIT');}
}
function observe(value:Promise<unknown>):void{const observed=intrinsicThen(value,()=>undefined,()=>undefined);intrinsicThen(observed,()=>undefined,()=>undefined);}
function runtime(value:LocalLaMaRuntimeFacts,original:LocalLaMaCapture):void{
  closed(value,['version','kind','invocationId','executionId','inputDigest','profileDigest','identityDigest'],factCode);id(value.invocationId,factCode);must(value.version===1&&value.kind==='LOCAL_LAMA'&&value.executionId===original.executionId&&value.inputDigest===original.inputDigest&&value.profileDigest===original.profileDigest&&value.identityDigest===digest(original.identity),factCode);
}
function start(value:LocalLaMaStartFact,original:LocalLaMaCapture):void{closed(value,['version','evidenceId','captureDigest','runtime'],factCode);id(value.evidenceId,factCode);must(value.version===1&&value.captureDigest===original.captureDigest,factCode);runtime(value.runtime,original);}
function fullCost(value:LocalLaMaFullCost,original:LocalLaMaCapture,facts:LocalLaMaRuntimeFacts):void{
  closed(value,['version','scope','captureDigest','runtimeDigest','actualUsd','evidenceRef','basisVersion'],factCode);must(value.version===1&&value.scope==='FULL_STAGE_PROCESS'&&value.captureDigest===original.captureDigest&&value.runtimeDigest===digest(facts)&&typeof value.actualUsd==='string'&&Buffer.byteLength(value.actualUsd)<=128,factCode);try{money(value.actualUsd);}catch{throw new DomainError(factCode,409,'WAIT');}
  for(const key of ['evidenceRef','basisVersion'] as const)must(typeof value[key]==='string'&&value[key].trim().length>0&&!value[key].includes('\0')&&Buffer.byteLength(value[key])<=160,factCode);
}

// Trusted installation catalogue only. Equality routes a capability; it does
// not authorize the current worker, create an attempt or prove its budget.
// Assembly and the actual first-claim store must recheck current INPUT/claim.
// Declared delegate budgets and encoded metadata limits are not physical RSS.
// There is deliberately no eviction/replacement/release API: an original
// coordinator may retain unresolved lifetime/cost holds after Promise closure.
export class LocalLaMaExecutorRouter implements LocalLaMaExecutor{
  private readonly bounds:Readonly<LocalLaMaExecutorRouterBounds>;
  private readonly routes=new Map<string,Route>();private retainedBytes=0;private activeCalls=0;private heldBytes=0;
  constructor(bounds:LocalLaMaExecutorRouterBounds){
    closed(bounds,['maxRoutes','maxRetainedCoordinatorBytes','maxConcurrentCalls','maxInFlightBytes','maxEncodedBytes','maxMetadataBytes']);for(const value of Object.values(bounds))positive(value);must(bounds.maxEncodedBytes<=2147483647&&bounds.maxMetadataBytes<=2147483647&&Number.isSafeInteger(8*(bounds.maxRoutes+2)*bounds.maxMetadataBytes));this.bounds=Object.freeze({...bounds});
  }
  register(bindingValue:LocalLaMaInvocationBinding,captureValue:LocalLaMaCapture,executor:LocalLaMaExecutor,declaredBudget:LocalLaMaCoordinatorBounds):void{
    const registration=own({binding:bindingValue,capture:captureValue,budget:declaredBudget},this.bounds.maxMetadataBytes),{binding,capture:local,budget}=registration;
    closed(binding,['version','accountId','requestId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode']);must(binding.version===1&&['FREE','PAID'].includes(binding.mode));for(const key of ['accountId','requestId','executionId'] as const)id(binding[key]);for(const key of ['inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest'] as const)hexadecimal(binding[key]);capture(local,this.bounds.maxEncodedBytes);
    must(binding.executionId===local.executionId&&binding.inputDigest===local.inputDigest&&binding.localCaptureDigest===local.captureDigest&&binding.fullStageCaptureDigest!==binding.localCaptureDigest);
    closed(budget,['maxEncodedBytes','maxMetadataBytes','maxInFlightBytes','maxConcurrentCalls','maxRecords']);for(const value of Object.values(budget))positive(value);must(budget.maxEncodedBytes<=this.bounds.maxEncodedBytes&&budget.maxMetadataBytes<=this.bounds.maxMetadataBytes&&Number.isSafeInteger(budget.maxMetadataBytes*(budget.maxRecords+1)));
    must(executor!==this);const dispatch=portMethod(executor,'dispatch'),lookup=portMethod(executor,'lookup'),key=binding.executionId.toLowerCase(),registrationDigest=digest(registration),prior=this.routes.get(key);
    if(prior){must(prior.registrationDigest===registrationDigest&&prior.executor===executor&&prior.dispatch===dispatch&&prior.lookup===lookup,conflict);return;}
    must(![...this.routes.values()].some(route=>route.executor===executor),conflict);
    must(this.routes.size<this.bounds.maxRoutes&&budget.maxInFlightBytes<=this.bounds.maxRetainedCoordinatorBytes-this.retainedBytes,capacity);
    // One combined registration has a maxMetadataBytes encoded cap; the route
    // table has maxRoutes entries plus bounded synchronous registration scratch.
    // Metadata remains separate from the declared
    // sum of delegate maxInFlightBytes and temporary per-call reservations.
    const frozen=freeze(registration);this.routes.set(key,{binding:frozen.binding,capture:frozen.capture,budget:frozen.budget,registrationDigest,executor,dispatch,lookup,lateCallback:false,unjoinedLifetime:false});this.retainedBytes+=budget.maxInFlightBytes;
  }
  private route(value:LocalLaMaCapture):Route|null{
    const route=this.routes.get(value.executionId.toLowerCase());if(!route)return null;must(digest(route.capture)===digest(value),conflict);must(!route.unjoinedLifetime,lifetimeCode);must(!route.lateCallback,callbackCode);return route;
  }
  private reserve(route:Route,imageBytes=0,maskBytes=0):()=>void{
    // Includes bounded simultaneous callback facts, reply metadata and input /
    // proposal copies. The retained delegate declaration is never released.
    const held=4*(imageBytes+maskBytes+this.bounds.maxEncodedBytes)+8*this.bounds.maxMetadataBytes*(route.budget.maxRecords+4);
    must(Number.isSafeInteger(held)&&this.activeCalls<this.bounds.maxConcurrentCalls&&held<=this.bounds.maxInFlightBytes-this.heldBytes,capacity);this.activeCalls++;this.heldBytes+=held;let released=false;return ()=>{if(!released){released=true;this.activeCalls--;this.heldBytes-=held;}};
  }
  private reply(value:LocalLaMaExecutorReply,route:Route):LocalLaMaExecutorReply{
    closed(value,['version','evidenceId','captureDigest','runtime','state','providerSuccess','start','fullCost','proposal'],factCode);
    let proposal:LocalLaMaExecutorReply['proposal']=null;
    if(value.proposal!==null){closed(value.proposal,['sha256','byteLength','bytes'],factCode);hexadecimal(value.proposal.sha256,factCode);positive(value.proposal.byteLength,this.bounds.maxEncodedBytes,factCode);const length=bufferLength(value.proposal.bytes,this.bounds.maxEncodedBytes),bytes=bufferCopy(value.proposal.bytes,this.bounds.maxEncodedBytes);must(length===value.proposal.byteLength&&sha256(bytes)===value.proposal.sha256,factCode);proposal={sha256:value.proposal.sha256,byteLength:length,bytes};}
    const metadata=own({...value,proposal:proposal===null?null:{sha256:proposal.sha256,byteLength:proposal.byteLength}},this.bounds.maxMetadataBytes,factCode);
    must(metadata.version===1&&metadata.captureDigest===route.capture.captureDigest&&['SUCCEEDED','FAILED','NOT_STARTED','UNKNOWN'].includes(metadata.state)&&(metadata.providerSuccess===null||typeof metadata.providerSuccess==='boolean'),factCode);id(metadata.evidenceId,factCode);runtime(metadata.runtime,route.capture);
    if(metadata.start!==null){start(metadata.start,route.capture);must(digest(metadata.start.runtime)===digest(metadata.runtime),factCode);}if(metadata.fullCost!==null)fullCost(metadata.fullCost,route.capture,metadata.runtime);
    must(metadata.state!=='NOT_STARTED'||(metadata.start===null&&metadata.providerSuccess===null&&proposal===null),factCode);must(metadata.state!=='SUCCEEDED'||(metadata.providerSuccess===true&&proposal!==null),factCode);must(proposal===null||metadata.providerSuccess===true,factCode);
    return {...metadata,proposal};
  }
  async dispatch(value:LocalLaMaExecutionInput,onStarted:(fact:LocalLaMaStartFact)=>Promise<void>):Promise<LocalLaMaExecutorReply>{
    closed(value,['capture','image','mask']);must(typeof onStarted==='function'&&!types.isProxy(onStarted));closed(value.capture,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);id(value.capture.executionId);const route=this.routes.get(value.capture.executionId.toLowerCase());must(route,missing);must(!route.unjoinedLifetime,lifetimeCode);must(!route.lateCallback,callbackCode);
    const imageBytes=bufferLength(value.image,this.bounds.maxEncodedBytes),maskBytes=bufferLength(value.mask,this.bounds.maxEncodedBytes),release=this.reserve(route,imageBytes,maskBytes);
    let accepting=true,callbackError=false,callbackSlots=0,joinable=true;let refused:Promise<void>|null=null;const callbacks:Promise<unknown>[]=[],started:LocalLaMaStartFact[]=[];
    const unjoinable=()=>{joinable=false;route.unjoinedLifetime=true;};
    const callback=(fact:LocalLaMaStartFact):Promise<void>=>{
      if(!accepting||callbackSlots>=route.budget.maxRecords){if(!accepting)route.lateCallback=true;callbackError=true;if(!refused){refused=nativePromise.reject(new DomainError(callbackCode,409,'WAIT'));observe(refused);}return refused;}
      callbackSlots++;const task=(async()=>{const owned=own(fact,this.bounds.maxMetadataBytes,factCode);start(owned,route.capture);started.push(structuredClone(owned));await joinedValue<void>(Reflect.apply(onStarted,undefined,[owned]),callbackCode,unjoinable);})();
      // An ignored callback rejection is still observed. No successful reply
      // can hide a pre-close callback error; late callbacks never reach I/O.
      // The delegate may mutate its returned Promise. Join only an unexposed
      // internal Promise connected before returning the separate public one.
      observe(task);const internalJoin=intrinsicThen(task,()=>undefined,()=>{callbackError=true;});callbacks.push(internalJoin);
      const exposed=intrinsicThen(task,()=>undefined,()=>{throw new DomainError(callbackCode,409,'WAIT');}) as Promise<void>;observe(exposed);return exposed;
    };
    try{
      const original=capture(own(value.capture,this.bounds.maxMetadataBytes),this.bounds.maxEncodedBytes);must(this.route(original)===route,conflict);const image=bufferCopy(value.image,this.bounds.maxEncodedBytes),mask=bufferCopy(value.mask,this.bounds.maxEncodedBytes);must(imageBytes===original.imageByteLength&&maskBytes===original.maskByteLength&&sha256(image)===original.imageSha256&&sha256(mask)===original.maskSha256);
      const input={capture:original,image,mask};let result:LocalLaMaExecutorReply|undefined,delegateError:unknown;
      try{const settled=await joinedValue<LocalLaMaExecutorReply>(Reflect.apply(route.dispatch,route.executor,[input,callback]),missing,unjoinable);result=this.reply(settled.value,route);}catch(error){delegateError=error;}
      accepting=false;await Promise.allSettled(callbacks);must(!callbackError&&!route.lateCallback,callbackCode);if(delegateError!==undefined)throw delegateError;must(result!==undefined,factCode);
      if(started.length){must(result.start!==null&&started.every(fact=>digest(fact)===digest(result.start)),factCode);}return result;
    }finally{accepting=false;if(joinable)release();}
  }
  async lookup(value:LocalLaMaCapture):Promise<LocalLaMaExecutorReply|null>{
    closed(value,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);id(value.executionId);const route=this.routes.get(value.executionId.toLowerCase());
    if(!route){capture(own(value,this.bounds.maxMetadataBytes),this.bounds.maxEncodedBytes);return null;}must(!route.unjoinedLifetime,lifetimeCode);must(!route.lateCallback,callbackCode);const release=this.reserve(route);let joinable=true;
    const unjoinable=()=>{joinable=false;route.unjoinedLifetime=true;};
    try{const original=capture(own(value,this.bounds.maxMetadataBytes),this.bounds.maxEncodedBytes);must(this.route(original)===route,conflict);const result=await joinedValue<LocalLaMaExecutorReply|null>(Reflect.apply(route.lookup,route.executor,[original]),missing,unjoinable);return result.value===null?null:this.reply(result.value,route);}finally{if(joinable)release();}
  }
}
