import {types} from 'node:util';
import path from 'node:path';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import type {Settings} from '../../contracts/src/wire.generated.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import type {NativeGateway} from '../../native/src/gateway.js';
import type {Database} from '../../storage/src/database.js';
import {ServiceRoleError} from '../../storage/src/service-role.js';
import type {ObjectStore} from '../../storage/src/objects.js';
import {FontCatalog} from '../../media/src/fonts.js';
import {Assets} from '../../domain/src/assets.js';
import {PipelineEvidence} from '../../domain/src/pipeline-evidence.js';
import {OperationalPipelineProvider,type OperationalPipelineBounds,type OperationalRenderCostReader} from '../../domain/src/operational-pipeline.js';
import {OperationalStageCost} from '../../domain/src/pipeline-stage-cost.js';
import {LocalLaMaNativePreparation} from '../../domain/src/local-lama-native-preparation.js';
import type {ProviderAdapter,StageInput} from '../../domain/src/provider.js';
import {validateOperationalLimitIdentity,type OperationalLimitIdentity} from '../../domain/src/operational-execution-limits.js';
import {LocalOcrAdapter,type LocalOcrConfig} from '../../providers/src/local-ocr.js';
import type {LocalOcrEnginePort} from '../../providers/src/local-ocr-executor.js';
import {LocalLaMaAdapter} from '../../providers/src/local-lama.js';
import {TextStagesProvider} from '../../providers/src/text-stages.js';
import type {WorkerRuntime} from '../../../apps/api/src/runtime.js';
import {measuredMediaProfile} from './measurement-profile.js';
import {RuntimeConfigError,validateRuntimeConfig,type WorkerRuntimeConfig} from './runtime-config.js';
import {createOperationalRequestPolicy,createVerifiedWorkerRuntime,publicRuntimeFailure} from './runtime-startup.js';

export type PreparedPipelineRegistration={
  identity:OperationalLimitIdentity;sourceLanguage:'ja';targetLanguage:'ko';scope:'PAGE';
  modelId:string;contractVersion:string;reasoningLevels:readonly Settings['reasoningLevel'][];
};
export type PreparedPipelineResources={
  worker:Database;objects:ObjectStore;fonts:FontCatalog;native:NativeGateway;registration:PreparedPipelineRegistration;
  ocr:{config:Extract<LocalOcrConfig,{version:2}>;engine:LocalOcrEnginePort};
  translation:{modelId:string;adapter:ProviderAdapter&{idle:()=>Promise<void>}};lama:LocalLaMaAdapter;
  cost:OperationalStageCost;renderCost:OperationalRenderCostReader;cleanupPreparation:LocalLaMaNativePreparation;
  bounds:OperationalPipelineBounds;evidenceBounds:{maxRecordBytes:number;maxRecords:number};
};
const invalid='RUNTIME_FACTORY_OPTIONS_INVALID';
const preparationSameDatabase=LocalLaMaNativePreparation.prototype.sameDatabase;
function must(condition:unknown):asserts condition{if(!condition)throw new RuntimeConfigError(invalid);}
function object(value:unknown):asserts value is object{must(value!==null&&typeof value==='object'&&!types.isProxy(value));}
function field<T>(value:object,key:string):T{
  object(value);const descriptor=Object.getOwnPropertyDescriptor(value,key);
  must(descriptor?.enumerable&&'value'in descriptor);return descriptor.value as T;
}
function closed(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
  object(value);must(Object.getPrototypeOf(value)===Object.prototype);
  const fields=Object.getOwnPropertyDescriptors(value);
  must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]));
}
function method<T extends object,K extends keyof T>(owner:T,key:K,optional=false):T[K]{
  object(owner);let at:object|null=owner;
  for(let depth=0;at&&depth<8;depth++){
    object(at);const descriptor=Object.getOwnPropertyDescriptor(at,key);
    if(descriptor){must('value'in descriptor);if(optional&&descriptor.value===undefined)return undefined as T[K];must(typeof descriptor.value==='function'&&!types.isProxy(descriptor.value));return descriptor.value.bind(owner) as T[K];}
    at=Object.getPrototypeOf(at);
  }
  must(optional);return undefined as T[K];
}
function copy<T>(value:T,maxBytes:number):T{
  must(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=2147483647);
  let nodes=0,stringBytes=0;const active=new Set<object>();
  const walk=(item:unknown,depth:number):void=>{
    must(!types.isProxy(item)&&depth<=64&&++nodes<=maxBytes);
    if(typeof item==='string'){stringBytes+=Buffer.byteLength(item);must(stringBytes<=maxBytes);return;}
    if(item===null||typeof item==='boolean'||typeof item==='number')return;
    object(item);must(!active.has(item));active.add(item);
    const array=Array.isArray(item);must(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype));
    const keys=Reflect.ownKeys(item);must(keys.length<=maxBytes-nodes+1);
    if(array)must(keys.length===item.length+1&&keys.every(key=>typeof key==='string'&&(key==='length'||/^(0|[1-9][0-9]*)$/.test(key))));
    for(const key of keys){if(array&&key==='length')continue;must(typeof key==='string');walk(field(item,key),depth+1);}
    active.delete(item);
  };
  walk(value,0);nativeJsonBytes(value,maxBytes);return structuredClone(value);
}
function fontsCopy(value:FontCatalog,metadataLimit:number,byteLimit:number):FontCatalog{
  const root=field<string>(value,'root'),catalog=copy(field<FontCatalog['catalog']>(value,'catalog'),metadataLimit),source=field<Map<string,Buffer>>(value,'bytes');
  object(source);must(Object.getPrototypeOf(source)===Map.prototype&&Reflect.ownKeys(source).length===0&&typeof root==='string');
  const refs=[...catalog.fonts,catalog.license];must(new Set(refs.map(item=>item.id)).size===refs.length&&source.size===refs.length);
  let bytes=0;const entries:[string,Buffer][]=[];
  for(const item of refs){const raw=Map.prototype.get.call(source,item.id) as unknown;must(Buffer.isBuffer(raw)&&!types.isProxy(raw));bytes+=raw.length;must(Number.isSafeInteger(bytes)&&bytes<=byteLimit);entries.push([item.id,Buffer.from(raw)]);}
  return Object.freeze(Object.assign(Object.create(FontCatalog.prototype),{root,catalog,bytes:new Map(entries)})) as FontCatalog;
}
function registeredInput(value:StageInput,registration:PreparedPipelineRegistration,profileVersion:string,maxBytes:number):StageInput{
  const input=copy(value,maxBytes),envelope=input.envelope;
  must(['OCR','TRANSLATE','CLEANUP','TYPESET'].includes(input.stage)&&input.scope?.kind==='PAGE'&&envelope);
  assertWire('stageInputEnvelope',envelope);
  must(input.settings?.sourceLanguage===registration.sourceLanguage&&input.settings.targetLanguage===registration.targetLanguage&&
    input.settings.modelId===registration.modelId&&input.settings.contractVersion===registration.contractVersion&&registration.reasoningLevels.includes(input.settings.reasoningLevel)&&
    envelope.executionId===input.executionId&&envelope.requestId===input.requestId&&envelope.contextId===input.contextId&&envelope.logicalStepId===input.stage&&envelope.inputDigest===input.inputDigest&&
    envelope.stageContract===registration.contractVersion&&envelope.parameterProfileVersion===profileVersion&&digest(envelope.capturedSettings)===digest(input.settings));
  if(input.stage==='OCR')must(Array.isArray(input.initialData?.blocks)&&input.initialData.blocks.length===0&&
    (input.previousData===null||Array.isArray(input.previousData?.blocks)&&input.previousData.blocks.length===0)&&envelope.regionIds.length===0);
  return input;
}

// 서버가 함께 준비한 capability만 조립한다. 등록 identity는 실제 환경/모델
// 실측이나 운영 권한의 증명이 아니다. 원 gateway와 preparation을 교체하지 않는다.
export async function createPreparedPipelineWorker(resources:PreparedPipelineResources,config:WorkerRuntimeConfig,identity:OperationalLimitIdentity):Promise<WorkerRuntime>{
  let close:(()=>Promise<void>)|undefined,delegated=false;
  try{
    object(resources);const worker=field<Database>(resources,'worker');object(worker);close=method(worker,'close');
    closed(resources,['worker','objects','fonts','native','registration','ocr','translation','lama','cost','renderCost','cleanupPreparation','bounds','evidenceBounds']);
    must(field(worker,'role')==='trio_web_worker');
    closed(resources.bounds,['maxEncodedStageBytes','maxMetadataBytes','maxInFlightBytes']);
    for(const value of Object.values(resources.bounds))must(Number.isSafeInteger(value)&&value>0&&value<=2147483647);
    const bounds=copy(resources.bounds,1024),maxBytes=bounds.maxMetadataBytes;
    closed(resources.evidenceBounds,['maxRecordBytes','maxRecords']);const evidenceBounds=copy(resources.evidenceBounds,1024);
    must(Number.isSafeInteger(evidenceBounds.maxRecordBytes)&&evidenceBounds.maxRecordBytes>0&&Number.isSafeInteger(evidenceBounds.maxRecords)&&evidenceBounds.maxRecords>0&&evidenceBounds.maxRecords<2147483647&&evidenceBounds.maxRecordBytes<=2147483647);
    const capturedConfig=validateRuntimeConfig(copy(config,maxBytes),'worker') as WorkerRuntimeConfig;
    const capturedIdentity=validateOperationalLimitIdentity(copy(identity,maxBytes));
    const registration=copy(resources.registration,maxBytes);
    closed(registration,['identity','sourceLanguage','targetLanguage','scope','modelId','contractVersion','reasoningLevels']);
    must(digest(validateOperationalLimitIdentity(registration.identity))===digest(capturedIdentity)&&registration.sourceLanguage==='ja'&&registration.targetLanguage==='ko'&&registration.scope==='PAGE'&&
      typeof registration.modelId==='string'&&registration.modelId.trim().length>0&&typeof registration.contractVersion==='string'&&registration.contractVersion.trim().length>0&&
      Array.isArray(registration.reasoningLevels)&&registration.reasoningLevels.length>0&&registration.reasoningLevels.length<=3&&new Set(registration.reasoningLevels).size===registration.reasoningLevels.length&&registration.reasoningLevels.every(level=>['LOW','MEDIUM','HIGH'].includes(level)));
    closed(resources.ocr,['config','engine']);const ocrConfig=copy(resources.ocr.config,maxBytes);
    must(ocrConfig.version===2&&ocrConfig.settings?.modelId===registration.modelId&&ocrConfig.settings.contractVersion===registration.contractVersion);
    const engine=Object.freeze({invoke:method(resources.ocr.engine,'invoke')});
    closed(resources.translation,['modelId','adapter']);must(resources.translation.modelId===registration.modelId);
    const originalTranslation=resources.translation.adapter;must(field(originalTranslation,'synthetic')===false);const translationIdle=method(originalTranslation,'idle');
    const translation:ProviderAdapter=Object.freeze({synthetic:false,dispatch:method(originalTranslation,'dispatch'),lookup:method(originalTranslation,'lookup'),
      validateInput:method(originalTranslation,'validateInput',true),validateObservation:method(originalTranslation,'validateObservation',true)});
    const originalStore=resources.objects,bucket=field<string>(originalStore,'bucket');
    const objects:ObjectStore=Object.freeze({bucket,put:method(originalStore,'put'),read:method(originalStore,'read'),receipt:method(originalStore,'receipt'),remove:method(originalStore,'remove'),presence:method(originalStore,'presence',true)});
    const fonts=fontsCopy(resources.fonts,maxBytes,bounds.maxEncodedStageBytes),profile=measuredMediaProfile(capturedConfig.profile);
    must(path.resolve(fonts.root)===path.resolve(capturedConfig.fonts.root)&&fonts.catalog.version===capturedConfig.fonts.catalogVersion&&bucket===capturedConfig.r2.bucket&&
      capturedIdentity.profileVersion===capturedConfig.profile.version&&capturedIdentity.mediaProfileDigest===digest(profile));
    const native=resources.native;method(native,'forTarget');method(native,'stopClaims');method(native,'idle');method(native,'maintenance',true);
    const lama=resources.lama;object(lama);must(lama instanceof LocalLaMaAdapter);method(lama,'matchesOwnedCleanupInput');method(lama,'capture');method(lama,'dispatch');method(lama,'lookup');
    const cost=resources.cost;object(cost);must(cost instanceof OperationalStageCost);
    for(const key of ['prepare','finishAttempt','readIn','hasPendingOtherIn','idle','collectCheckpointIn'] as const)method(cost,key);
    const cleanupPreparation=resources.cleanupPreparation;object(cleanupPreparation);
    must(preparationSameDatabase.call(cleanupPreparation,worker));const prepareCleanup=method(cleanupPreparation,'prepare');
    const renderCost:OperationalRenderCostReader=Object.freeze({lookup:method(resources.renderCost,'lookup')});
    // 첫 await 전에 caller가 소유한 모든 데이터와 직접 쓰는 메서드를 고정했다.
    // 원 native/cost/LaMa 객체 내부 불변성은 신뢰된 부모의 책임이다.
    await method(worker,'validateServiceRole')({serviceRole:'trio_web_worker',loginRole:capturedConfig.database.loginRole});
    const policy=await createOperationalRequestPolicy(worker,capturedConfig,fonts,capturedIdentity);
    const assets=new Assets(worker,objects),outer=new PipelineEvidence(worker,evidenceBounds,'PIPELINE_V1'),raw=new PipelineEvidence(worker,evidenceBounds,'LOCAL_OCR_V1');
    const ocr=new LocalOcrAdapter(ocrConfig,{assets,journal:raw,fonts,profile,engine});
    const ocrIdle=method(ocr,'idle');
    const providerIdle=async()=>{
      const results=await Promise.allSettled([Promise.resolve().then(ocrIdle),Promise.resolve().then(translationIdle)]);
      const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
      if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'RUNTIME_PROVIDER_IDLE_UNCONFIRMED');
    };
    const provider=new OperationalPipelineProvider({enabled:policy.realProviderEnabled,profile,fonts,assets,journal:outer,provider:new TextStagesProvider({ocr,translation}),lama,renderCost,bounds});
    const hooks={beforeValidateInput:async(input:StageInput,claim:Parameters<LocalLaMaNativePreparation['prepare']>[1])=>{
      const owned=registeredInput(input,registration,profile.id,maxBytes);
      if(owned.stage==='CLEANUP')await prepareCleanup(owned,copy(claim,maxBytes));
    }};
    // 이 호출부터 실패 정리는 기존 verified factory가 소유한다.
    delegated=true;
    return await createVerifiedWorkerRuntime({worker,objects,fonts,profile,policy,provider,workerNative:native,workerOperationalCost:cost,workerExecutionHooks:hooks,workerProviderIdle:providerIdle},capturedConfig,capturedIdentity);
  }catch(error){
    if(!delegated&&close){try{await close();}catch{throw new RuntimeConfigError('RUNTIME_POOL_CLOSE_UNCONFIRMED');}}
    throw new RuntimeConfigError(error instanceof RuntimeConfigError||error instanceof ServiceRoleError?publicRuntimeFailure(error):invalid);
  }
}
