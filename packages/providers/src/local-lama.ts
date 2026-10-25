import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {money} from '../../contracts/src/validation.js';
import type {ProviderCallContext} from '../../domain/src/provider.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {NativeFacade} from '../../native/src/facade.js';
import {localLaMaPostCompositeResolver} from '../../domain/src/native-gateway.js';
import {NativeJobError,nativeJsonBytes,type NativeTermination} from '../../native/src/dto.js';
import {nativeHash,nativeId,nativeInteger,nativeString,validateNativeProfile} from '../../native/src/jobs.js';
import {lamaCodeCommit,type LaMaIdentity} from './lama.js';

// These parent-only types are not a wire contract or authority for activating a
// model. The trusted local executor owns durable one-submit admission, actual
// inference START, its runtime lifetime and the verification of full cost.
export type LocalLaMaInput={executionId:string;inputDigest:string;image:Buffer;mask:Buffer};
export type LocalLaMaCapture=Readonly<{version:1;executionId:string;inputDigest:string;profileId:string;profileDigest:string;
  identity:Readonly<LaMaIdentity>;imageSha256:string;imageByteLength:number;maskSha256:string;maskByteLength:number;captureDigest:string}>;
export type LocalLaMaRuntimeFacts=Readonly<{version:1;kind:'LOCAL_LAMA';invocationId:string;executionId:string;inputDigest:string;profileDigest:string;identityDigest:string}>;
export type LocalLaMaStartFact=Readonly<{version:1;evidenceId:string;captureDigest:string;runtime:LocalLaMaRuntimeFacts}>;
// A model-only usage estimate or process exit is not FULL_STAGE_PROCESS cost.
// The port must verify the actual complete cost and its immutable basis first.
export type LocalLaMaFullCost=Readonly<{version:1;scope:'FULL_STAGE_PROCESS';captureDigest:string;runtimeDigest:string;actualUsd:string;evidenceRef:string;basisVersion:string}>;
export type LocalLaMaBinary={sha256:string;byteLength:number;bytes:Buffer};
export type LocalLaMaExecutorReply={version:1;evidenceId:string;captureDigest:string;runtime:LocalLaMaRuntimeFacts;
  state:'SUCCEEDED'|'FAILED'|'NOT_STARTED'|'UNKNOWN';providerSuccess:boolean|null;start:LocalLaMaStartFact|null;fullCost:LocalLaMaFullCost|null;proposal:LocalLaMaBinary|null};
export type LocalLaMaExecutionInput={capture:LocalLaMaCapture;image:Buffer;mask:Buffer};
export interface LocalLaMaExecutor {
  // Join all work and all onStarted callbacks before settling. This private
  // local capability accepts no URL, credential, path or external transport.
  dispatch(input:LocalLaMaExecutionInput,onStarted:(fact:LocalLaMaStartFact)=>Promise<void>):Promise<LocalLaMaExecutorReply>;
  // Read the original invocation only: no model submit, new attempt or billing.
  lookup(capture:LocalLaMaCapture):Promise<LocalLaMaExecutorReply|null>;
}
export type LocalLaMaBounds={maxCapturedExecutions:number;maxInFlightBytes:number};
// Private server assembly pins one source image; this is not a browser option,
// measured-host claim or a one-run permit. The request owner seals each run.
export type OwnedCleanupInput=Readonly<{profileDigest:string;sourceImageSha256:string;widthPx:number;heightPx:number}>;
export type LocalLaMaOptions={enabled:boolean;identity:LaMaIdentity;profile:MediaProfile;executor:LocalLaMaExecutor;bounds:LocalLaMaBounds;ownedCleanupInput?:OwnedCleanupInput};
export type LocalLaMaObservation={state:'SUCCEEDED'|'FAILED'|'NOT_STARTED'|'UNKNOWN';reason:string;capture:LocalLaMaCapture|null;
  evidenceId:string|null;started:boolean|null;providerSuccess:boolean|null;costUsd:string|null;usageConfirmed:boolean;
  start:LocalLaMaStartFact|null;fullCost:LocalLaMaFullCost|null;runtime:LocalLaMaRuntimeFacts|null;png:Buffer|null;
  outsideChangedPixels:0|null;backgroundQa:'NEEDS_REVIEW'|'FAILED'|null;approval:'UNAPPROVED';
  nativeFailure:{code:string;termination:Readonly<NativeTermination>}|null};
type Facts={capture:LocalLaMaCapture;runtime:LocalLaMaRuntimeFacts|null;start:LocalLaMaStartFact|null;fullCost:LocalLaMaFullCost|null;providerSuccess:boolean|null;evidenceId:string|null;proposalDigest:string|null};
type OwnedReply={state:LocalLaMaExecutorReply['state'];proposal:Buffer|null;invalidProposal:boolean};
const configCode='LOCAL_LAMA_CONFIG_INVALID',inputCode='LOCAL_LAMA_INPUT_INVALID',factCode='LOCAL_LAMA_FACT_INVALID';

function closed(value:unknown,keys:readonly string[],code:string):Record<string,unknown>{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),code,422);
  const actual=Reflect.ownKeys(value);requireCondition(actual.length===keys.length&&actual.every(key=>typeof key==='string'&&keys.includes(key)),code,422);
  const result:Record<string,unknown>={};for(const key of keys){const property=Object.getOwnPropertyDescriptor(value,key);requireCondition(property&&property.enumerable&&'value'in property,code,422);result[key]=property.value;}return result;
}
function identityCopy(value:unknown):Readonly<LaMaIdentity>{
  const item=closed(value,['codeCommit','weightsSha256','configSha256','weightsLicenseVerified','runtimeVerified'],configCode);
  for(const key of ['codeCommit','weightsSha256','configSha256'])nativeString(item[key],128,configCode);
  requireCondition(typeof item.weightsLicenseVerified==='boolean'&&typeof item.runtimeVerified==='boolean',configCode,422);
  return Object.freeze(item as LaMaIdentity);
}
function profileCopy(value:unknown):Readonly<MediaProfile>{
  const optional=Object.getOwnPropertyDescriptor(value??{},'minReadableFontSizePx')?['minReadableFontSizePx']:[];
  const item=closed(value,['id','kind','enabled','maxImageBytes','maxWidth','maxHeight','maxPixels','maxFilesPerUpload','maxProjectPages','maxProjectSourceBytes','maxZipBytes','maxEntries','maxExpandedBytes','maxRatio','maxManifestBytes','maxTextLength','maxFontSize','maxBlocks',...optional],configCode);
  requireCondition(typeof item.enabled==='boolean',configCode,422);validateNativeProfile({...item,enabled:true});return Object.freeze(item as MediaProfile);
}
function inputFields(value:unknown,maximum:number):LocalLaMaInput{
  const item=closed(value,['executionId','inputDigest','image','mask'],inputCode);nativeId(item.executionId,inputCode);nativeHash(item.inputDigest,inputCode);
  requireCondition(Buffer.isBuffer(item.image)&&Buffer.isBuffer(item.mask)&&item.image.length>0&&item.mask.length>0&&item.image.length<=maximum&&item.mask.length<=maximum,inputCode,422);
  return item as LocalLaMaInput;
}
function captureCopy(value:unknown,maximum:number):LocalLaMaCapture{
  const item=closed(value,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest'],factCode);
  requireCondition(item.version===1,factCode,422);nativeId(item.executionId,factCode);nativeString(item.profileId,160,factCode);requireCondition((item.profileId as string).length>0,factCode,422);
  for(const key of ['inputDigest','profileDigest','imageSha256','maskSha256','captureDigest'])nativeHash(item[key],factCode);
  nativeInteger(item.imageByteLength,1,maximum,factCode);nativeInteger(item.maskByteLength,1,maximum,factCode);item.identity=identityCopy(item.identity);
  const {captureDigest,...body}=item;requireCondition(digest(body)===captureDigest,factCode,422);return Object.freeze(item as LocalLaMaCapture);
}
function runtimeCopy(value:unknown,capture:LocalLaMaCapture):LocalLaMaRuntimeFacts{
  const item=closed(value,['version','kind','invocationId','executionId','inputDigest','profileDigest','identityDigest'],factCode);nativeId(item.invocationId,factCode);
  requireCondition(item.version===1&&item.kind==='LOCAL_LAMA'&&item.executionId===capture.executionId&&item.inputDigest===capture.inputDigest&&item.profileDigest===capture.profileDigest&&item.identityDigest===digest(capture.identity),factCode,422);
  return Object.freeze(item as LocalLaMaRuntimeFacts);
}
function startCopy(value:unknown,capture:LocalLaMaCapture):LocalLaMaStartFact{
  const item=closed(value,['version','evidenceId','captureDigest','runtime'],factCode);nativeId(item.evidenceId,factCode);
  requireCondition(item.version===1&&item.captureDigest===capture.captureDigest,factCode,422);item.runtime=runtimeCopy(item.runtime,capture);return Object.freeze(item as LocalLaMaStartFact);
}
function fullCostCopy(value:unknown,capture:LocalLaMaCapture,runtime:LocalLaMaRuntimeFacts):LocalLaMaFullCost{
  const item=closed(value,['version','scope','captureDigest','runtimeDigest','actualUsd','evidenceRef','basisVersion'],factCode);
  requireCondition(item.version===1&&item.scope==='FULL_STAGE_PROCESS'&&item.captureDigest===capture.captureDigest&&item.runtimeDigest===digest(runtime),factCode,422);
  nativeString(item.actualUsd,128,factCode);money(item.actualUsd as string);for(const key of ['evidenceRef','basisVersion']){nativeString(item[key],160,factCode);requireCondition((item[key] as string).trim().length>0,factCode,422);}return Object.freeze(item as LocalLaMaFullCost);
}
function keepRuntime(facts:Facts,runtime:LocalLaMaRuntimeFacts):void{
  requireCondition(facts.runtime===null||digest(facts.runtime)===digest(runtime),'LOCAL_LAMA_FACT_CONFLICT',409,'WAIT');facts.runtime??=runtime;
}
function keepStart(facts:Facts,start:LocalLaMaStartFact):void{
  keepRuntime(facts,start.runtime);requireCondition(facts.start===null||digest(facts.start)===digest(start),'LOCAL_LAMA_FACT_CONFLICT',409,'WAIT');facts.start??=start;
}
function observation(facts:Facts|null,state:LocalLaMaObservation['state'],reason:string):LocalLaMaObservation{
  return {state,reason,capture:facts?.capture??null,evidenceId:facts?.evidenceId??null,started:facts?.start?true:state==='NOT_STARTED'?false:null,
    providerSuccess:facts?.providerSuccess??null,costUsd:facts?.fullCost?.actualUsd??null,usageConfirmed:!!facts?.fullCost,start:facts?.start??null,fullCost:facts?.fullCost??null,runtime:facts?.runtime??null,
    png:null,outsideChangedPixels:null,backgroundQa:null,approval:'UNAPPROVED',nativeFailure:null};
}
function failure(facts:Facts,error:unknown,reason:string):LocalLaMaObservation{
  const result=observation(facts,'UNKNOWN',reason);if(error instanceof NativeJobError)result.nativeFailure={code:error.code,termination:error.termination};return result;
}
const knownImageRejection=(error:unknown)=>error instanceof DomainError&&!(error instanceof NativeJobError)&&['INPUT_INVALID','MASK_INVALID','CLEANUP_OUTPUT_INVALID','CLEANUP_OUTSIDE_CHANGED',inputCode].includes(error.code);

export class LocalLaMaAdapter {
  private readonly enabled:boolean;
  private readonly identity:Readonly<LaMaIdentity>;
  private readonly profile:Readonly<MediaProfile>;
  private readonly bounds:Readonly<LocalLaMaBounds>;
  private readonly ownedCleanupInput:OwnedCleanupInput|null;
  private readonly submit:LocalLaMaExecutor['dispatch'];
  private readonly read:LocalLaMaExecutor['lookup'];
  private readonly captures=new Map<string,Facts>();
  private heldBytes=0;
  constructor(options:LocalLaMaOptions){
    const optional=Object.getOwnPropertyDescriptor(options??{},'ownedCleanupInput')?['ownedCleanupInput']:[];
    const item=closed(options,['enabled','identity','profile','executor','bounds',...optional],configCode);requireCondition(typeof item.enabled==='boolean',configCode,422);
    this.enabled=item.enabled;this.identity=identityCopy(item.identity);this.profile=profileCopy(item.profile);this.ownedCleanupInput=null;
    if(optional.length){
      const pinned=closed(item.ownedCleanupInput,['profileDigest','sourceImageSha256','widthPx','heightPx'],configCode);nativeHash(pinned.profileDigest,configCode);nativeHash(pinned.sourceImageSha256,configCode);
      nativeInteger(pinned.widthPx,1,this.profile.maxWidth,configCode);nativeInteger(pinned.heightPx,1,this.profile.maxHeight,configCode);
      requireCondition(this.profile.kind==='SYNTHETIC'&&pinned.profileDigest===digest(this.profile)&&(pinned.widthPx as number)*(pinned.heightPx as number)<=this.profile.maxPixels,configCode,422);this.ownedCleanupInput=Object.freeze(pinned as OwnedCleanupInput);
    }
    const bounds=closed(item.bounds,['maxCapturedExecutions','maxInFlightBytes'],configCode);for(const key of ['maxCapturedExecutions','maxInFlightBytes'])nativeInteger(bounds[key],1,Number.MAX_SAFE_INTEGER,configCode);this.bounds=Object.freeze(bounds as LocalLaMaBounds);
    requireCondition(item.executor!==null&&typeof item.executor==='object',configCode,422);const executor=item.executor as LocalLaMaExecutor;
    requireCondition(typeof executor.dispatch==='function'&&typeof executor.lookup==='function',configCode,422);this.submit=executor.dispatch.bind(executor);this.read=executor.lookup.bind(executor);
  }
  matchesOwnedCleanupInput(value:OwnedCleanupInput|null):boolean{return digest(this.ownedCleanupInput)===digest(value);}
  validateOwnedCleanupImage(image:Buffer):void{
    const pinned=this.ownedCleanupInput;if(!pinned)return;
    // Header dimensions bind the exact pinned PNG before new native work. The
    // existing native preflight still validates its decode and cleanup mask.
    requireCondition(Buffer.isBuffer(image)&&image.length>=24&&image.length<=this.profile.maxImageBytes&&sha256(image)===pinned.sourceImageSha256&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&image.readUInt32BE(8)===13&&image.toString('ascii',12,16)==='IHDR'&&image.readUInt32BE(16)===pinned.widthPx&&image.readUInt32BE(20)===pinned.heightPx,inputCode,422);
  }
  capture(input:LocalLaMaInput):LocalLaMaCapture{
    const checked=inputFields(input,this.profile.maxImageBytes);this.validateOwnedCleanupImage(checked.image);const body={version:1 as const,executionId:checked.executionId,inputDigest:checked.inputDigest,profileId:this.profile.id,profileDigest:digest(this.profile),identity:this.identity,
      imageSha256:sha256(checked.image),imageByteLength:checked.image.length,maskSha256:sha256(checked.mask),maskByteLength:checked.mask.length};return Object.freeze({...body,captureDigest:digest(body)});
  }
  private allowed():boolean{return this.enabled&&this.profile.enabled&&(this.profile.kind==='MEASURED'||(this.profile.kind==='SYNTHETIC'&&this.ownedCleanupInput!==null))&&this.identity.codeCommit===lamaCodeCommit&&this.identity.weightsLicenseVerified&&this.identity.runtimeVerified&&/^[0-9a-f]{64}$/.test(this.identity.weightsSha256)&&/^[0-9a-f]{64}$/.test(this.identity.configSha256);}
  private facts(capture:LocalLaMaCapture):Facts{
    const old=this.captures.get(capture.executionId);if(old){requireCondition(old.capture.captureDigest===capture.captureDigest,'LOCAL_LAMA_CAPTURE_CONFLICT',409,'WAIT');return old;}
    requireCondition(this.captures.size<this.bounds.maxCapturedExecutions,'LOCAL_LAMA_CAPACITY_WAIT',409,'WAIT');const facts={capture,runtime:null,start:null,fullCost:null,providerSuccess:null,evidenceId:null,proposalDigest:null};this.captures.set(capture.executionId,facts);return facts;
  }
  private take(input:LocalLaMaInput,context:ProviderCallContext,originalCapture?:LocalLaMaCapture){
    const item=closed(context,['native'],inputCode);requireCondition(item.native instanceof NativeFacade,'LOCAL_LAMA_NATIVE_REQUIRED',409,'WAIT');const composite=item.native.compositeMaskedPixels.bind(item.native),post=localLaMaPostCompositeResolver(item.native);
    const checked=inputFields(input,this.profile.maxImageBytes);
    // Reserve before copying. This accounts conservatively for encoded input,
    // executor/native argument copies, proposal and composed-result overlap.
    // Native/executor capacity and caller assets/RSS are separate obligations.
    const held=6*(checked.image.length+checked.mask.length+this.profile.maxImageBytes);requireCondition(Number.isSafeInteger(held)&&this.heldBytes+held<=this.bounds.maxInFlightBytes,'LOCAL_LAMA_CAPACITY_WAIT',409,'WAIT');this.heldBytes+=held;
    try{const capture=this.capture(checked);if(originalCapture)requireCondition(captureCopy(originalCapture,this.profile.maxImageBytes).captureDigest===capture.captureDigest,'LOCAL_LAMA_CAPTURE_CONFLICT',409,'WAIT');const facts=this.facts(capture);return {image:Buffer.from(checked.image),mask:Buffer.from(checked.mask),facts,composite,post,held};}
    catch(error){this.heldBytes-=held;throw error;}
  }
  private receive(value:unknown,facts:Facts):OwnedReply{
    const item=closed(value,['version','evidenceId','captureDigest','runtime','state','providerSuccess','start','fullCost','proposal'],factCode);nativeId(item.evidenceId,factCode);
    requireCondition(item.version===1&&item.captureDigest===facts.capture.captureDigest&&['SUCCEEDED','FAILED','NOT_STARTED','UNKNOWN'].includes(item.state as string)&&(item.providerSuccess===null||typeof item.providerSuccess==='boolean'),factCode,422);
    const runtime=runtimeCopy(item.runtime,facts.capture);const start=item.start===null?null:startCopy(item.start,facts.capture);requireCondition(start===null||digest(start.runtime)===digest(runtime),factCode,422);
    const cost=item.fullCost===null?null:fullCostCopy(item.fullCost,facts.capture,runtime);
    requireCondition(item.state!=='NOT_STARTED'||(start===null&&item.providerSuccess===null&&item.proposal===null&&facts.start===null),factCode,422);
    requireCondition(item.state!=='SUCCEEDED'||(item.providerSuccess===true&&item.proposal!==null),factCode,422);
    requireCondition(item.proposal===null||item.providerSuccess===true,factCode,422);
    keepRuntime(facts,runtime);if(start)keepStart(facts,start);
    if(cost){requireCondition(facts.fullCost===null||digest(facts.fullCost)===digest(cost),'LOCAL_LAMA_FACT_CONFLICT',409,'WAIT');facts.fullCost??=cost;}
    if(item.providerSuccess===true)facts.providerSuccess=true;else facts.providerSuccess??=item.providerSuccess as boolean|null;facts.evidenceId=item.evidenceId as string;
    let proposal:Buffer|null=null,invalidProposal=false;
    if(item.proposal!==null)try{const blob=closed(item.proposal,['sha256','byteLength','bytes'],factCode);nativeHash(blob.sha256,factCode);nativeInteger(blob.byteLength,1,this.profile.maxImageBytes,factCode);requireCondition(Buffer.isBuffer(blob.bytes)&&blob.bytes.length===blob.byteLength&&sha256(blob.bytes)===blob.sha256,factCode,422);
      const proposalDigest=digest({sha256:blob.sha256,byteLength:blob.byteLength});requireCondition(facts.proposalDigest===null||facts.proposalDigest===proposalDigest,'LOCAL_LAMA_FACT_CONFLICT',409,'WAIT');facts.proposalDigest??=proposalDigest;proposal=Buffer.from(blob.bytes);
    }catch{invalidProposal=true;}
    return {state:item.state as LocalLaMaExecutorReply['state'],proposal,invalidProposal};
  }
  private async finish(reply:OwnedReply,owned:ReturnType<LocalLaMaAdapter['take']>):Promise<LocalLaMaObservation>{
    const {facts,image,mask}=owned;let composite=owned.composite;
    if(reply.state!=='SUCCEEDED'){const result=observation(facts,reply.state,reply.state==='UNKNOWN'?'LOCAL_LAMA_EXECUTION_UNCONFIRMED':reply.state==='FAILED'?'LOCAL_LAMA_EXECUTION_FAILED':'LOCAL_LAMA_NOT_STARTED');if(reply.state==='FAILED'&&facts.providerSuccess===true)result.backgroundQa='FAILED';return result;}
    if(reply.invalidProposal||reply.proposal===null){const result=observation(facts,'FAILED','CLEANUP_OUTPUT_INVALID');result.backgroundQa='FAILED';return result;}const proposal=reply.proposal;
    if(owned.post)try{composite=await owned.post();}catch(error){return failure(facts,error,'LOCAL_LAMA_POST_CONTEXT_UNCONFIRMED');}
    try{const composed=await composite(Buffer.from(image),Buffer.from(mask),proposal,this.profile);requireCondition(composed.outsideChangedPixels===0&&composed.maskSha256===facts.capture.maskSha256&&Buffer.isBuffer(composed.png)&&composed.png.length>0&&composed.png.length<=this.profile.maxImageBytes,'CLEANUP_OUTPUT_INVALID',422);
      // Valid pixels and full cost do not establish the original model START.
      if(facts.start===null){const result=observation(facts,'UNKNOWN','LOCAL_LAMA_START_UNCONFIRMED');result.outsideChangedPixels=0;return result;}
      const result=observation(facts,'SUCCEEDED','LOCAL_LAMA_CLEANUP_NEEDS_REVIEW');result.png=Buffer.from(composed.png);result.outsideChangedPixels=0;result.backgroundQa='NEEDS_REVIEW';return result;
    }catch(error){if(!knownImageRejection(error))return failure(facts,error,'NATIVE_EXECUTION_UNCONFIRMED');const result=observation(facts,'FAILED','CLEANUP_OUTPUT_INVALID');result.backgroundQa='FAILED';return result;}
  }
  async dispatch(input:LocalLaMaInput,started:(evidenceId:string)=>Promise<void>,context:ProviderCallContext):Promise<LocalLaMaObservation>{
    if(!this.allowed())return observation(null,'NOT_STARTED','CLEANUP_ACTIVATION_GATE');
    const checked=inputFields(input,this.profile.maxImageBytes);if(this.captures.has(checked.executionId))return this.lookup(checked,context);
    requireCondition(typeof started==='function',inputCode,422);const owned=this.take(checked,context);const {facts,image,mask,composite}=owned;
    try{try{const checkedMask=await composite(Buffer.from(image),Buffer.from(mask),Buffer.from(image),this.profile);requireCondition(checkedMask.outsideChangedPixels===0&&checkedMask.maskSha256===facts.capture.maskSha256,inputCode,422);}catch(error){return knownImageRejection(error)?observation(facts,'NOT_STARTED','CLEANUP_INPUT_REJECTED'):failure(facts,error,'NATIVE_EXECUTION_UNCONFIRMED');}
      let accepting=true;let callbackError:unknown=null;let startIo:Promise<void>|null=null;
      const onStarted=(value:LocalLaMaStartFact):Promise<void>=>{try{requireCondition(accepting,'LOCAL_LAMA_LATE_START',409,'WAIT');const fact=startCopy(value,facts.capture);keepStart(facts,fact);startIo??=Promise.resolve().then(()=>started(fact.evidenceId));void startIo.catch(()=>undefined);return startIo;}catch(error){callbackError=error;const rejected=Promise.reject(error);void rejected.catch(()=>undefined);return rejected;}};
      let reply:OwnedReply|null=null,executorError:unknown=null,replyError:unknown=null;
      try{const received=await this.submit({capture:facts.capture,image:Buffer.from(image),mask:Buffer.from(mask)},onStarted);try{reply=this.receive(received,facts);}catch(error){replyError=error;}}catch(error){executorError=error;}finally{accepting=false;}
      const settled=await Promise.allSettled(startIo?[startIo]:[]);if(replyError!==null)return failure(facts,replyError,'LOCAL_LAMA_REPLY_UNCONFIRMED');
      if(executorError!==null)return failure(facts,executorError,'LOCAL_LAMA_EXECUTION_UNCONFIRMED');if(callbackError!==null||settled.some(result=>result.status==='rejected'))return failure(facts,callbackError,'LOCAL_LAMA_START_UNCONFIRMED');
      requireCondition(reply!==null,factCode,422);return await this.finish(reply,owned);
    }finally{this.heldBytes-=owned.held;}
  }
  async lookup(input:LocalLaMaInput,context:ProviderCallContext,originalCapture?:LocalLaMaCapture):Promise<LocalLaMaObservation>{
    const owned=this.take(input,context,originalCapture);try{let reply:LocalLaMaExecutorReply|null;try{reply=await this.read(owned.facts.capture);}catch(error){return failure(owned.facts,error,'LOCAL_LAMA_LOOKUP_UNCONFIRMED');}
      if(reply===null)return observation(owned.facts,'UNKNOWN','LOCAL_LAMA_EXECUTION_UNCONFIRMED');let received:OwnedReply;try{received=this.receive(reply,owned.facts);}catch(error){return failure(owned.facts,error,'LOCAL_LAMA_REPLY_UNCONFIRMED');}return await this.finish(received,owned);
    }finally{this.heldBytes-=owned.held;}
  }
  async lookupFacts(originalCapture:LocalLaMaCapture):Promise<LocalLaMaObservation>{
    // This projection never reconstructs material or calls native work. The
    // caller must already verify the original successful output and receipts.
    // The durable executor still owns original invocation/START/raw integrity.
    const metadataMaximum=4096,held=3*this.profile.maxImageBytes+metadataMaximum;requireCondition(Number.isSafeInteger(held)&&this.heldBytes+held<=this.bounds.maxInFlightBytes,'LOCAL_LAMA_CAPACITY_WAIT',409,'WAIT');this.heldBytes+=held;
    try{
      const captured=JSON.parse(nativeJsonBytes(originalCapture,metadataMaximum).toString('utf8')) as LocalLaMaCapture,capture=captureCopy(captured,this.profile.maxImageBytes);
      requireCondition(capture.profileId===this.profile.id&&capture.profileDigest===digest(this.profile)&&digest(capture.identity)===digest(this.identity)&&(!this.ownedCleanupInput||capture.imageSha256===this.ownedCleanupInput.sourceImageSha256),'LOCAL_LAMA_CAPTURE_CONFLICT',409,'WAIT');const facts=this.facts(capture);
      let reply:LocalLaMaExecutorReply|null;try{reply=await this.read(capture);}catch(error){return failure(facts,error,'LOCAL_LAMA_LOOKUP_UNCONFIRMED');}
      if(reply===null)return observation(facts,'UNKNOWN','LOCAL_LAMA_EXECUTION_UNCONFIRMED');let received:OwnedReply;
      try{received=this.receive(reply,facts);}catch(error){return failure(facts,error,'LOCAL_LAMA_REPLY_UNCONFIRMED');}
      if(received.invalidProposal)return failure(facts,null,'LOCAL_LAMA_REPLY_UNCONFIRMED');
      // Model success is a provider fact; png/QA/semantic success still belong
      // to the previously verified material. No new image is returned here.
      return observation(facts,received.state==='SUCCEEDED'?'UNKNOWN':received.state,received.state==='SUCCEEDED'?'LOCAL_LAMA_ORIGINAL_FACTS':received.state==='UNKNOWN'?'LOCAL_LAMA_EXECUTION_UNCONFIRMED':received.state==='FAILED'?'LOCAL_LAMA_EXECUTION_FAILED':'LOCAL_LAMA_NOT_STARTED');
    }finally{this.heldBytes-=held;}
  }
}
