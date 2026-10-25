import {types} from 'node:util';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import type {LocalLaMaCapture,LocalLaMaExecutionInput,LocalLaMaExecutor,LocalLaMaExecutorReply,LocalLaMaRuntimeFacts,LocalLaMaStartFact,LocalLaMaFullCost} from './local-lama.js';

export type LocalLaMaInvocationBinding=Readonly<{version:1;accountId:string;requestId:string;executionId:string;inputDigest:string;inputFingerprint:string;fullStageCaptureDigest:string;localCaptureDigest:string;mode:'FREE'|'PAID'}>;
export type LocalLaMaOriginalInvocation=Readonly<{version:1;bindingDigest:string;localCaptureDigest:string;invocationId:string}>;
export type LocalLaMaFullCostEvidence=Readonly<{version:1;bindingDigest:string;fullStageCaptureDigest:string;closureEvidenceRef:string;fullCost:LocalLaMaFullCost}>;
export type LocalLaMaInvocationRecord=({version:1;kind:'START';fact:LocalLaMaStartFact}|{version:1;kind:'ENGINE_REPLY';reply:LocalLaMaExecutorReply}|{version:1;kind:'FULL_COST';evidence:LocalLaMaFullCostEvidence}|{version:1;kind:'HOLD';code:string;relatedDigest:string|null})&{recordDigest:string};
export type LocalLaMaAttemptSnapshot={version:1;original:LocalLaMaOriginalInvocation;records:LocalLaMaInvocationRecord[]};
export type LocalLaMaFirstClaim=LocalLaMaAttemptSnapshot&{created:boolean};
export interface LocalLaMaAttemptStore{
  // Capability closures must verify original account/INPUT/current work and
  // worker claim, and the LocalLaMa -> full-stage cost capture relationship.
  // claim is a durable unique first claim; append is immutable and idempotent
  // by recordDigest; lookup preserves the original append order and rechecks
  // the full original history. JSON/UUID equality is not that authority.
  // The actual backend must retain unresolved durable writes/lifetime holds
  // on ACK uncertainty; it may not expose a healthy original while that fact
  // is unconfirmed. This interface alone cannot prove a DB write occurred.
  claim(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture):Promise<LocalLaMaFirstClaim>;
  lookup(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture):Promise<LocalLaMaAttemptSnapshot|null>;
  append(binding:LocalLaMaInvocationBinding,original:LocalLaMaOriginalInvocation,record:LocalLaMaInvocationRecord):Promise<void>;
}
export type LocalLaMaEngineInvocation={reply:Promise<LocalLaMaExecutorReply|null>;joined:Promise<void>};
export interface LocalLaMaEnginePort{
  // These are capability-bound ORIGINAL invocation operations, never a URL,
  // launcher, weights selector, Native GO, new attempt or arbitrary model API.
  // Return the handle synchronously. joined must cover all engine work and
  // callbacks, even after reply rejection, and guarantee no later callbacks.
  // A synchronous throw/malformed handle/join rejection cannot prove lifetime
  // closure; the coordinator retains that call's reservation in that case.
  submit(value:{binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;input:LocalLaMaExecutionInput},onStarted:(fact:LocalLaMaStartFact)=>Promise<void>):LocalLaMaEngineInvocation;
  query(value:{binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;capture:LocalLaMaCapture}):LocalLaMaEngineInvocation;
}
export interface LocalLaMaFullCostReader{
  // Only the trusted actual reader can prove complete original stage closure:
  // model + subsequent composite/verification/storage + all required costs.
  // A model receipt/exit/estimate or fixture label is insufficient. The
  // closureEvidenceRef must refer to that immutable original backend proof.
  lookup(value:{binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;capture:LocalLaMaCapture;runtime:LocalLaMaRuntimeFacts}):Promise<LocalLaMaFullCostEvidence|null>;
}
export type LocalLaMaCoordinatorBounds=Readonly<{maxEncodedBytes:number;maxMetadataBytes:number;maxInFlightBytes:number;maxConcurrentCalls:number;maxRecords:number}>;
export type LocalLaMaCoordinatorOptions={binding:LocalLaMaInvocationBinding;capture:LocalLaMaCapture;bounds:LocalLaMaCoordinatorBounds;attempts:LocalLaMaAttemptStore;engine:LocalLaMaEnginePort;costs:LocalLaMaFullCostReader};

const configCode='LOCAL_LAMA_EXECUTOR_CONFIG_INVALID',factCode='LOCAL_LAMA_EXECUTOR_FACT_INVALID',inputCode='LOCAL_LAMA_EXECUTOR_INPUT_INVALID',conflictCode='LOCAL_LAMA_EXECUTOR_FACT_CONFLICT';
const capacityCode='LOCAL_LAMA_EXECUTOR_CAPACITY_WAIT',unknownCode='LOCAL_LAMA_EXECUTOR_ORIGINAL_UNCONFIRMED',lifetimeCode='LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED';
const softHolds=new Set(['LOCAL_LAMA_EXECUTOR_START_IO_UNCONFIRMED','LOCAL_LAMA_EXECUTOR_REPLY_IO_UNCONFIRMED','LOCAL_LAMA_EXECUTOR_COST_IO_UNCONFIRMED','LOCAL_LAMA_EXECUTOR_ENGINE_REPLY_UNCONFIRMED']);
type RecordBody=Omit<Extract<LocalLaMaInvocationRecord,{kind:'START'}>,'recordDigest'>|Omit<Extract<LocalLaMaInvocationRecord,{kind:'ENGINE_REPLY'}>,'recordDigest'>|Omit<Extract<LocalLaMaInvocationRecord,{kind:'FULL_COST'}>,'recordDigest'>|Omit<Extract<LocalLaMaInvocationRecord,{kind:'HOLD'}>,'recordDigest'>;
type Operation={held:number;joined:boolean;original:LocalLaMaOriginalInvocation|null;records:LocalLaMaInvocationRecord[];ioError:boolean};
type Facts={runtime:LocalLaMaRuntimeFacts|null;start:LocalLaMaStartFact|null;cost:LocalLaMaFullCost|null;reply:LocalLaMaExecutorReply|null;providerSuccess:boolean|null;conflict:boolean};
const nativePromise=Promise,nativePromisePrototype=Promise.prototype;
const nativeSpeciesGetter=Object.getOwnPropertyDescriptor(nativePromise,Symbol.species)!.get;
const intrinsicThen=Function.prototype.call.bind(Promise.prototype.then) as (promise:Promise<unknown>,fulfilled:(value:unknown)=>unknown,rejected:(reason:unknown)=>unknown)=>Promise<unknown>;

function standardNativePromise(value:unknown):value is Promise<unknown>{
  if(types.isProxy(value)||!types.isPromise(value)||Object.getPrototypeOf(value)!==nativePromisePrototype)return false;
  // Intrinsic then still reads constructor/Symbol.species. Descriptor checks
  // admit only the original native constructor and known builtin species;
  // no user getter, subclass, Proxy constructor or thenable may be executed.
  const ownConstructor=Object.getOwnPropertyDescriptor(value,'constructor'),prototypeConstructor=Object.getOwnPropertyDescriptor(nativePromisePrototype,'constructor'),species=Object.getOwnPropertyDescriptor(nativePromise,Symbol.species);
  return (!ownConstructor||'value'in ownConstructor&&ownConstructor.value===nativePromise)&&!!prototypeConstructor&&'value'in prototypeConstructor&&prototypeConstructor.value===nativePromise&&typeof nativeSpeciesGetter==='function'&&!!species&&species.get===nativeSpeciesGetter&&species.set===undefined;
}
function observeHandleRejections(value:unknown):void{
  if(types.isProxy(value)||value===null||typeof value!=='object')return;
  for(const key of ['reply','joined']){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor)||!standardNativePromise(descriptor.value))continue;
    // Observe only own data before shape validation. This does not accept the
    // handle, await/join the engine, change its original rejection, or free a
    // reservation. Both branches return undefined, and the returned observer
    // itself gets an intrinsic rejection observer, without reading .then.
    const observer=intrinsicThen(descriptor.value,()=>undefined,()=>undefined);intrinsicThen(observer,()=>undefined,()=>undefined);
  }
}

function closed(value:unknown,keys:readonly string[],code=factCode):Record<string,unknown>{
  requireCondition(!types.isProxy(value)&&value!==null&&typeof value==='object'&&!Array.isArray(value),code,422);
  const prototype=Object.getPrototypeOf(value);requireCondition(prototype===Object.prototype||prototype===null,code,422);
  const actual=Reflect.ownKeys(value);requireCondition(actual.length===keys.length&&actual.every(key=>typeof key==='string'&&keys.includes(key)),code,422);
  const result:Record<string,unknown>={};for(const key of keys){const property=Object.getOwnPropertyDescriptor(value,key);requireCondition(property&&property.enumerable&&'value'in property,code,422);result[key]=property.value;}return result;
}
function integer(value:unknown,minimum=1,maximum=Number.MAX_SAFE_INTEGER,code=factCode):asserts value is number{requireCondition(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum&&value<=maximum,code,422);}
function hash(value:unknown,code=factCode):asserts value is string{requireCondition(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),code,422);}
function id(value:unknown,code=factCode):asserts value is string{requireCondition(typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),code,422);}
function text(value:unknown,maximum:number,code=factCode):asserts value is string{requireCondition(typeof value==='string'&&value.length>0&&value.trim().length>0&&!value.includes('\0')&&Buffer.byteLength(value)<=maximum,code,422);nativeJsonBytes(value,maximum+2);}
function metadata(value:unknown,bounds:LocalLaMaCoordinatorBounds):void{nativeJsonBytes(value,bounds.maxMetadataBytes);}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
function bytes(value:unknown,maximum:number):Buffer{
  requireCondition(!types.isProxy(value)&&Buffer.isBuffer(value)&&Object.getPrototypeOf(value)===Buffer.prototype,inputCode,422);
  let length:number;try{length=byteLengthGetter.call(value) as number;}catch{throw new DomainError(inputCode,422);}
  integer(length,1,maximum,inputCode);const keys=Reflect.ownKeys(value);requireCondition(keys.length===length,inputCode,422);
  for(const key of keys){requireCondition(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<length,inputCode,422);const property=Object.getOwnPropertyDescriptor(value,key);requireCondition(property&&property.enumerable&&'value'in property,inputCode,422);}
  return Buffer.from(value);
}
function array(value:unknown,maximum:number):unknown[]{
  requireCondition(!types.isProxy(value)&&Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype,factCode,422);
  const property=Object.getOwnPropertyDescriptor(value,'length');requireCondition(property&&'value'in property,factCode,422);integer(property.value,0,maximum);
  const length=property.value as number;requireCondition(Reflect.ownKeys(value).length===length+1,factCode,422);const result:unknown[]=[];
  for(let index=0;index<length;index++){const item=Object.getOwnPropertyDescriptor(value,String(index));requireCondition(item&&item.enumerable&&'value'in item,factCode,422);result.push(item.value);}return result;
}
function captureCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaCapture{
  const item=closed(value,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);requireCondition(item.version===1,factCode,422);id(item.executionId);
  for(const key of ['inputDigest','profileDigest','imageSha256','maskSha256','captureDigest'])hash(item[key]);text(item.profileId,bounds.maxMetadataBytes);
  integer(item.imageByteLength,1,bounds.maxEncodedBytes);integer(item.maskByteLength,1,bounds.maxEncodedBytes);
  const identity=closed(item.identity,['codeCommit','weightsSha256','configSha256','weightsLicenseVerified','runtimeVerified']);requireCondition(typeof identity.codeCommit==='string'&&/^[0-9a-f]{40}$/.test(identity.codeCommit)&&typeof identity.weightsLicenseVerified==='boolean'&&typeof identity.runtimeVerified==='boolean',factCode,422);hash(identity.weightsSha256);hash(identity.configSha256);item.identity=Object.freeze(identity);
  const {captureDigest,...body}=item;metadata(item,bounds);requireCondition(digest(body)===captureDigest,factCode,422);return Object.freeze(item) as LocalLaMaCapture;
}
function bindingCopy(value:unknown,capture:LocalLaMaCapture,bounds:LocalLaMaCoordinatorBounds):LocalLaMaInvocationBinding{
  const item=closed(value,['version','accountId','requestId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode'],configCode);requireCondition(item.version===1&&(item.mode==='FREE'||item.mode==='PAID'),configCode,422);
  for(const key of ['accountId','requestId','executionId'])id(item[key],configCode);for(const key of ['inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest'])hash(item[key],configCode);
  requireCondition(item.executionId===capture.executionId&&item.inputDigest===capture.inputDigest&&item.localCaptureDigest===capture.captureDigest,configCode,422);metadata(item,bounds);return Object.freeze(item) as LocalLaMaInvocationBinding;
}
function runtimeCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaRuntimeFacts{
  const item=closed(value,['version','kind','invocationId','executionId','inputDigest','profileDigest','identityDigest']);requireCondition(item.version===1&&item.kind==='LOCAL_LAMA',factCode,422);id(item.invocationId);id(item.executionId);for(const key of ['inputDigest','profileDigest','identityDigest'])hash(item[key]);metadata(item,bounds);return Object.freeze(item) as LocalLaMaRuntimeFacts;
}
function startCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaStartFact{const item=closed(value,['version','evidenceId','captureDigest','runtime']);requireCondition(item.version===1,factCode,422);id(item.evidenceId);hash(item.captureDigest);item.runtime=runtimeCopy(item.runtime,bounds);metadata(item,bounds);return Object.freeze(item) as LocalLaMaStartFact;}
function costCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaFullCost{
  const item=closed(value,['version','scope','captureDigest','runtimeDigest','actualUsd','evidenceRef','basisVersion']);requireCondition(item.version===1&&item.scope==='FULL_STAGE_PROCESS',factCode,422);hash(item.captureDigest);hash(item.runtimeDigest);
  requireCondition(typeof item.actualUsd==='string'&&/^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(item.actualUsd),factCode,422);text(item.evidenceRef,bounds.maxMetadataBytes);text(item.basisVersion,bounds.maxMetadataBytes);metadata(item,bounds);return Object.freeze(item) as LocalLaMaFullCost;
}
function costEvidenceCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaFullCostEvidence{
  const item=closed(value,['version','bindingDigest','fullStageCaptureDigest','closureEvidenceRef','fullCost']);requireCondition(item.version===1,factCode,422);hash(item.bindingDigest);hash(item.fullStageCaptureDigest);text(item.closureEvidenceRef,bounds.maxMetadataBytes);item.fullCost=costCopy(item.fullCost,bounds);metadata(item,bounds);return Object.freeze(item) as LocalLaMaFullCostEvidence;
}
function replyMetadata(reply:LocalLaMaExecutorReply){return {...reply,proposal:reply.proposal?{sha256:reply.proposal.sha256,byteLength:reply.proposal.byteLength}:null};}
function replyCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaExecutorReply{
  const item=closed(value,['version','evidenceId','captureDigest','runtime','state','providerSuccess','start','fullCost','proposal']);requireCondition(item.version===1&&['SUCCEEDED','FAILED','NOT_STARTED','UNKNOWN'].includes(item.state as string)&&(item.providerSuccess===null||typeof item.providerSuccess==='boolean'),factCode,422);id(item.evidenceId);hash(item.captureDigest);item.runtime=runtimeCopy(item.runtime,bounds);item.start=item.start===null?null:startCopy(item.start,bounds);item.fullCost=item.fullCost===null?null:costCopy(item.fullCost,bounds);
  if(item.proposal!==null){const proposal=closed(item.proposal,['sha256','byteLength','bytes']);hash(proposal.sha256);integer(proposal.byteLength,1,bounds.maxEncodedBytes);proposal.bytes=bytes(proposal.bytes,bounds.maxEncodedBytes);requireCondition((proposal.bytes as Buffer).length===proposal.byteLength&&sha256(proposal.bytes as Buffer)===proposal.sha256,factCode,422);item.proposal=Object.freeze(proposal);}
  metadata(replyMetadata(item as LocalLaMaExecutorReply),bounds);return Object.freeze(item) as LocalLaMaExecutorReply;
}
function recordMetadata(record:RecordBody){return record.kind==='ENGINE_REPLY'?{...record,reply:replyMetadata(record.reply)}:record;}
function record(body:RecordBody,bounds:LocalLaMaCoordinatorBounds):LocalLaMaInvocationRecord{const value=recordMetadata(body);metadata(value,bounds);return Object.freeze({...body,recordDigest:digest(value)});}
function recordCopy(value:unknown,bounds:LocalLaMaCoordinatorBounds):LocalLaMaInvocationRecord{
  requireCondition(!types.isProxy(value)&&value!==null&&typeof value==='object',factCode,422);const kind=Object.getOwnPropertyDescriptor(value,'kind');requireCondition(kind&&'value'in kind,factCode,422);
  let body:RecordBody,recordDigest:unknown;
  if(kind.value==='START'){const item=closed(value,['version','kind','fact','recordDigest']);body={version:1,kind:'START',fact:startCopy(item.fact,bounds)};recordDigest=item.recordDigest;requireCondition(item.version===1,factCode,422);}
  else if(kind.value==='ENGINE_REPLY'){const item=closed(value,['version','kind','reply','recordDigest']);body={version:1,kind:'ENGINE_REPLY',reply:replyCopy(item.reply,bounds)};recordDigest=item.recordDigest;requireCondition(item.version===1,factCode,422);}
  else if(kind.value==='FULL_COST'){const item=closed(value,['version','kind','evidence','recordDigest']);body={version:1,kind:'FULL_COST',evidence:costEvidenceCopy(item.evidence,bounds)};recordDigest=item.recordDigest;requireCondition(item.version===1,factCode,422);}
  else{const item=closed(value,['version','kind','code','relatedDigest','recordDigest']);requireCondition(item.version===1&&item.kind==='HOLD',factCode,422);text(item.code,bounds.maxMetadataBytes);if(item.relatedDigest!==null)hash(item.relatedDigest);body={version:1,kind:'HOLD',code:item.code,relatedDigest:item.relatedDigest as string|null};recordDigest=item.recordDigest;}
  const copied=record(body,bounds);requireCondition(copied.recordDigest===recordDigest,factCode,422);return copied;
}
function port<T>(value:unknown,keys:readonly string[]):T{
  const item=closed(value,keys,configCode);for(const key of keys){requireCondition(!types.isProxy(item[key])&&typeof item[key]==='function',configCode,422);const ownBind=Object.getOwnPropertyDescriptor(item[key],'bind');requireCondition(!ownBind||'value'in ownBind,configCode,422);}
  // Own immutable method resolution; backend authority must live in closures.
  const receiver=Object.freeze({...item});return Object.freeze(Object.fromEntries(keys.map(key=>[key,Function.prototype.bind.call(item[key] as (...args:unknown[])=>unknown,receiver)]))) as T;
}

// This parent-only adapter accepts already verified capability closures. It
// does not verify SQL privileges, grant admission/START/GO, activate a runtime,
// determine prices/measurements or equate the two distinct capture digests.
export class LocalLaMaInvocationCoordinator implements LocalLaMaExecutor{
  private readonly binding:LocalLaMaInvocationBinding;
  private readonly bindingDigest:string;
  private readonly capture:LocalLaMaCapture;
  private readonly bounds:LocalLaMaCoordinatorBounds;
  private readonly attempts:LocalLaMaAttemptStore;
  private readonly engine:LocalLaMaEnginePort;
  private readonly costs:LocalLaMaFullCostReader;
  private activeCalls=0;
  private heldBytes=0;
  private original:LocalLaMaOriginalInvocation|null=null;
  private submitted=false;
  constructor(options:LocalLaMaCoordinatorOptions){
    const item=closed(options,['binding','capture','bounds','attempts','engine','costs'],configCode),bounds=closed(item.bounds,['maxEncodedBytes','maxMetadataBytes','maxInFlightBytes','maxConcurrentCalls','maxRecords'],configCode);for(const key of Object.keys(bounds))integer(bounds[key],1,Number.MAX_SAFE_INTEGER,configCode);
    this.bounds=Object.freeze(bounds) as LocalLaMaCoordinatorBounds;this.capture=captureCopy(item.capture,this.bounds);this.binding=bindingCopy(item.binding,this.capture,this.bounds);this.bindingDigest=digest(this.binding);
    this.attempts=port(item.attempts,['claim','lookup','append']);this.engine=port(item.engine,['submit','query']);this.costs=port(item.costs,['lookup']);
    integer(this.reservation(),1,Number.MAX_SAFE_INTEGER,configCode);
  }
  private reservation():number{
    // Conservative encoded bytes for owned input/outbound copies, reply and
    // original history + duplicate store/return copies. This is not physical
    // RSS, decoded tensor/native capacity or MEASURED throughput evidence.
    return 8*(this.capture.imageByteLength+this.capture.maskByteLength+this.bounds.maxEncodedBytes)+4*this.bounds.maxRecords*(this.bounds.maxEncodedBytes+this.bounds.maxMetadataBytes);
  }
  private take():Operation{const held=this.reservation();requireCondition(this.activeCalls<this.bounds.maxConcurrentCalls&&Number.isSafeInteger(this.heldBytes+held)&&this.heldBytes+held<=this.bounds.maxInFlightBytes,capacityCode,409,'WAIT');this.activeCalls++;this.heldBytes+=held;return {held,joined:true,original:null,records:[],ioError:false};}
  private release(operation:Operation):void{if(operation.joined){this.activeCalls--;this.heldBytes-=operation.held;}}
  private captured(value:unknown):LocalLaMaCapture{const capture=captureCopy(value,this.bounds);requireCondition(capture.captureDigest===this.capture.captureDigest,inputCode,422);return capture;}
  private input(value:unknown):LocalLaMaExecutionInput{
    const item=closed(value,['capture','image','mask'],inputCode),capture=this.captured(item.capture),image=bytes(item.image,this.bounds.maxEncodedBytes),mask=bytes(item.mask,this.bounds.maxEncodedBytes);
    requireCondition(image.length===capture.imageByteLength&&mask.length===capture.maskByteLength&&sha256(image)===capture.imageSha256&&sha256(mask)===capture.maskSha256,inputCode,422);return {capture,image,mask};
  }
  private snapshot(value:unknown,first=false):LocalLaMaAttemptSnapshot&{created?:boolean}{
    const item=closed(value,['version','original','records',...(first?['created']:[])]);requireCondition(item.version===1&&(!first||typeof item.created==='boolean'),factCode,422);
    const original=closed(item.original,['version','bindingDigest','localCaptureDigest','invocationId']);requireCondition(original.version===1&&original.bindingDigest===this.bindingDigest&&original.localCaptureDigest===this.capture.captureDigest,factCode,422);id(original.invocationId);
    const owned=Object.freeze(original) as LocalLaMaOriginalInvocation;requireCondition(this.original===null||digest(this.original)===digest(owned),conflictCode,409,'WAIT');
    const records=array(item.records,this.bounds.maxRecords).map(value=>recordCopy(value,this.bounds));requireCondition(new Set(records.map(row=>row.recordDigest)).size===records.length,factCode,422);metadata({version:1,original:owned,records:records.map(row=>recordMetadata(row))},this.bounds);
    this.original??=owned;return {version:1,original:owned,records,...(first?{created:item.created as boolean}:{})};
  }
  private validRuntime(runtime:LocalLaMaRuntimeFacts,original:LocalLaMaOriginalInvocation):boolean{return runtime.invocationId===original.invocationId&&runtime.executionId===this.capture.executionId&&runtime.inputDigest===this.capture.inputDigest&&runtime.profileDigest===this.capture.profileDigest&&runtime.identityDigest===digest(this.capture.identity);}
  private facts(operation:Operation):Facts{
    const facts:Facts={runtime:null,start:null,cost:null,reply:null,providerSuccess:null,conflict:false},original=operation.original!;
    let costProof:string|null=null;const engineEvidence=new Map<string,string>();
    const keepRuntime=(runtime:LocalLaMaRuntimeFacts)=>{if(!this.validRuntime(runtime,original)||facts.runtime&&digest(facts.runtime)!==digest(runtime)){facts.conflict=true;return false;}facts.runtime??=runtime;return true;};
    const keepStart=(start:LocalLaMaStartFact)=>{if(start.captureDigest!==this.capture.captureDigest||!keepRuntime(start.runtime)||facts.start&&digest(facts.start)!==digest(start)){facts.conflict=true;return;}facts.start??=start;};
    // Facts are monotonic. A later UNKNOWN/null observation cannot erase known
    // START/provider success/material/full cost; contradictory facts hold.
    for(const row of operation.records){
      if(row.kind==='START')keepStart(row.fact);
      else if(row.kind==='HOLD'){if(!softHolds.has(row.code))facts.conflict=true;}
      else if(row.kind==='ENGINE_REPLY'){
        const reply=row.reply,sourceDigest=digest(replyMetadata(reply)),known=engineEvidence.get(reply.evidenceId);if(known&&known!==sourceDigest)facts.conflict=true;engineEvidence.set(reply.evidenceId,sourceDigest);
        if(reply.captureDigest!==this.capture.captureDigest||!keepRuntime(reply.runtime)){facts.conflict=true;continue;}if(reply.start)keepStart(reply.start);
        if(reply.fullCost!==null)facts.conflict=true; // Engine/model-only costs are never adopted.
        if(reply.providerSuccess!==null){if(facts.providerSuccess!==null&&facts.providerSuccess!==reply.providerSuccess)facts.conflict=true;if(reply.providerSuccess===true)facts.providerSuccess=true;else facts.providerSuccess??=false;}
        if(reply.state==='SUCCEEDED'&&(reply.providerSuccess!==true||reply.proposal===null)||reply.proposal!==null&&reply.providerSuccess!==true||reply.state==='NOT_STARTED'&&(reply.start!==null||reply.providerSuccess!==null||reply.proposal!==null))facts.conflict=true;
        if(facts.reply?.proposal&&reply.proposal&&facts.reply.proposal.sha256!==reply.proposal.sha256)facts.conflict=true;
        if(!facts.reply||reply.state==='SUCCEEDED'&&facts.reply.state!=='SUCCEEDED'||reply.proposal!==null&&facts.reply.proposal===null)facts.reply=reply;
      }
    }
    for(const row of operation.records)if(row.kind==='FULL_COST'){
      const evidence=row.evidence,cost=evidence.fullCost;if(evidence.bindingDigest!==this.bindingDigest||evidence.fullStageCaptureDigest!==this.binding.fullStageCaptureDigest||cost.captureDigest!==this.capture.captureDigest||!facts.runtime||cost.runtimeDigest!==digest(facts.runtime)){facts.conflict=true;continue;}
      if(facts.cost!==null&&(digest(facts.cost)!==digest(cost)||costProof!==digest(evidence))){facts.conflict=true;continue;}facts.cost??=cost;costProof??=digest(evidence);
    }
    if(facts.start&&operation.records.some(row=>row.kind==='ENGINE_REPLY'&&row.reply.state==='NOT_STARTED'))facts.conflict=true;return facts;
  }
  private async append(operation:Operation,body:RecordBody):Promise<void>{
    const value=record(body,this.bounds);if(operation.records.some(row=>row.recordDigest===value.recordDigest))return;
    requireCondition(operation.records.length<this.bounds.maxRecords,capacityCode,409,'WAIT');metadata({records:[...operation.records,value].map(row=>recordMetadata(row))},this.bounds);
    // Preserve our copy even if the durable append ACK is lost. The port gets
    // a separate owned buffer copy and cannot mutate the retained observation.
    operation.records.push(value);try{await this.attempts.append(this.binding,operation.original!,recordCopy(value,this.bounds));}catch(error){operation.ioError=true;throw error;}
  }
  private async hold(operation:Operation,code:string,relatedDigest:string|null=null):Promise<void>{try{await this.append(operation,{version:1,kind:'HOLD',code,relatedDigest});}catch{operation.ioError=true;}}
  private async invoke(operation:Operation,input:LocalLaMaExecutionInput|null,onStarted?:((fact:LocalLaMaStartFact)=>Promise<void>)):Promise<void>{
    let accepting=true,callbackError=false;const pending=new Map<string,Promise<void>>();
    const callback=(value:LocalLaMaStartFact):Promise<void>=>{
      try{
        requireCondition(accepting,'LOCAL_LAMA_EXECUTOR_LATE_START',409,'WAIT');const fact=startCopy(value,this.bounds),key=digest(fact),old=pending.get(key);if(old)return old;
        requireCondition(pending.size<this.bounds.maxRecords,capacityCode,409,'WAIT');
        const io=(async()=>{await this.append(operation,{version:1,kind:'START',fact});requireCondition(fact.captureDigest===this.capture.captureDigest&&this.validRuntime(fact.runtime,operation.original!)&&!this.facts(operation).conflict,conflictCode,409,'WAIT');await onStarted?.(fact);})();
        const watched=io.catch(error=>{callbackError=true;throw error;});void watched.catch(()=>undefined);pending.set(key,watched);return watched;
      }catch(error){callbackError=true;const rejected=Promise.reject(error);void rejected.catch(()=>undefined);return rejected;}
    };
    let handle:LocalLaMaEngineInvocation;
    // No finally release based merely on reply completion, ACK, TERM, or throw.
    operation.joined=false;
    try{
      const value=input?this.engine.submit({binding:this.binding,original:operation.original!,input:{capture:this.capture,image:Buffer.from(input.image),mask:Buffer.from(input.mask)}},callback):this.engine.query({binding:this.binding,original:operation.original!,capture:this.capture});
      observeHandleRejections(value);
      const item=closed(value,['reply','joined']);for(const key of ['reply','joined'])requireCondition(standardNativePromise(item[key])&&Reflect.ownKeys(item[key]).length===0,factCode,422);handle=item as LocalLaMaEngineInvocation;
    }catch(error){accepting=false;await Promise.allSettled(pending.values());await this.hold(operation,lifetimeCode);throw error;}
    const joined=intrinsicThen(handle.joined,()=>{accepting=false;operation.joined=true;},()=>{accepting=false;operation.joined=false;operation.ioError=true;});
    let engineError:unknown=null;
    try{
      const value=await handle.reply;if(value!==null){const reply=replyCopy(value,this.bounds);await this.append(operation,{version:1,kind:'ENGINE_REPLY',reply});if(reply.start)await this.append(operation,{version:1,kind:'START',fact:reply.start});}
    }catch(error){engineError=error;operation.ioError=true;}
    await joined;await Promise.allSettled(pending.values());
    // A later query's joined proves only that query's lifetime. It cannot
    // clear an earlier original invocation's missing join. Preserve the hard
    // durable HOLD across instances; this scope adds no release authority.
    if(!operation.joined)await this.hold(operation,lifetimeCode);
    if(callbackError){operation.ioError=true;await this.hold(operation,'LOCAL_LAMA_EXECUTOR_START_IO_UNCONFIRMED');}
    if(engineError!==null){await this.hold(operation,'LOCAL_LAMA_EXECUTOR_ENGINE_REPLY_UNCONFIRMED');if(this.facts(operation).runtime===null)throw engineError;}
  }
  private async complete(operation:Operation):Promise<LocalLaMaExecutorReply|null>{
    let facts=this.facts(operation);
    if(facts.conflict)await this.hold(operation,conflictCode);
    if(facts.runtime&&!facts.conflict){
      try{const value=await this.costs.lookup({binding:this.binding,original:operation.original!,capture:this.capture,runtime:facts.runtime});if(value!==null){const evidence=costEvidenceCopy(value,this.bounds);await this.append(operation,{version:1,kind:'FULL_COST',evidence});}}
      catch(error){operation.ioError=true;await this.hold(operation,error instanceof DomainError?'LOCAL_LAMA_EXECUTOR_COST_FACT_CONFLICT':'LOCAL_LAMA_EXECUTOR_COST_IO_UNCONFIRMED');}
    }
    // A concurrent original callback/query may have appended facts while this
    // call awaited engine/store/cost I/O. Re-read them before returning. Keep
    // local actual facts on an ACK/DB error, but never call a new first claim.
    try{
      const value=await this.attempts.lookup(this.binding,this.capture);requireCondition(value!==null,factCode,409,'WAIT');const current=this.snapshot(value);
      const combined=[...operation.records,...current.records.filter(row=>!operation.records.some(known=>known.recordDigest===row.recordDigest))];requireCondition(combined.length<=this.bounds.maxRecords,capacityCode,409,'WAIT');metadata({records:combined.map(row=>recordMetadata(row))},this.bounds);operation.records=combined;
    }catch(error){operation.ioError=true;await this.hold(operation,error instanceof DomainError?factCode:'LOCAL_LAMA_EXECUTOR_REPLY_IO_UNCONFIRMED');}
    facts=this.facts(operation);if(facts.conflict)await this.hold(operation,conflictCode);
    if(facts.runtime===null)return null;
    const reply=facts.reply,start=facts.start,hasSuccess=reply?.state==='SUCCEEDED'&&reply.proposal!==null;
    const state=facts.conflict||operation.ioError||!operation.joined||hasSuccess&&!start?'UNKNOWN':reply?.state??'UNKNOWN';
    return replyCopy({version:1,evidenceId:reply?.evidenceId??start!.evidenceId,captureDigest:this.capture.captureDigest,runtime:facts.runtime,state,providerSuccess:facts.providerSuccess,start,fullCost:facts.cost,proposal:reply?.proposal??null},this.bounds);
  }
  async dispatch(input:LocalLaMaExecutionInput,onStarted:(fact:LocalLaMaStartFact)=>Promise<void>):Promise<LocalLaMaExecutorReply>{
    const operation=this.take();try{
      requireCondition(!types.isProxy(onStarted)&&typeof onStarted==='function',inputCode,422);const owned=this.input(input);let claimed:(LocalLaMaAttemptSnapshot&{created?:boolean})|null=null,ack:unknown,acknowledged=false;
      try{ack=await this.attempts.claim(this.binding,this.capture);acknowledged=true;}
      catch(error){if(error instanceof DomainError)throw error;const recovered=await this.attempts.lookup(this.binding,this.capture);if(recovered===null)throw error;claimed=this.snapshot(recovered);}
      // An invalid response is an original-fact error, not an ambiguous ACK
      // which may be silently replaced by another response or fresh capture.
      if(acknowledged)claimed=this.snapshot(ack,true);requireCondition(claimed!==null,factCode,422);
      operation.original=claimed.original;operation.records=claimed.records;
      const submit=claimed.created===true&&!this.submitted&&claimed.records.length===0;if(submit)this.submitted=true;
      await this.invoke(operation,submit?owned:null,submit?onStarted:undefined);const result=await this.complete(operation);requireCondition(result!==null,unknownCode,409,'WAIT');return result;
    }finally{this.release(operation);}
  }
  async lookup(capture:LocalLaMaCapture):Promise<LocalLaMaExecutorReply|null>{
    const operation=this.take();try{this.captured(capture);const value=await this.attempts.lookup(this.binding,this.capture);if(value===null)return null;const original=this.snapshot(value);operation.original=original.original;operation.records=original.records;await this.invoke(operation,null);return await this.complete(operation);}finally{this.release(operation);}
  }
}
