import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import measurement from '../../packages/contracts/schemas/measurement-profile.json';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {EditData} from '../../packages/domain/src/model.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import type {Database} from '../../packages/storage/src/database.js';
import {FullStageCostJournal} from '../../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {CheckpointValidationJournal} from '../../packages/domain/src/checkpoint-validation.js';
import {OperationalStageCost} from '../../packages/domain/src/pipeline-stage-cost.js';
import {LocalLaMaNativePreparation} from '../../packages/domain/src/local-lama-native-preparation.js';
import {OperationalPipelineProvider} from '../../packages/domain/src/operational-pipeline.js';
import {PipelineEvidence,type PipelineStageCandidate,type PipelineRecordKind} from '../../packages/domain/src/pipeline-evidence.js';
import {canonicalInput,normalizeObservation,type Observation,type StageInput} from '../../packages/domain/src/provider.js';
import {LocalOcrAdapter} from '../../packages/providers/src/local-ocr.js';
import {LocalLaMaAdapter} from '../../packages/providers/src/local-lama.js';
import {TextStagesProvider} from '../../packages/providers/src/text-stages.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';
import {validateMeasurementProfile,measuredMediaProfile} from '../../packages/operations/src/measurement-profile.js';
import type {WorkerRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import {inspectRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import * as limits from '../../packages/domain/src/operational-execution-limits.js';
import {createPreparedPipelineWorker,type PreparedPipelineResources} from '../../packages/operations/src/pipeline-runtime.js';
import {operationalLimitFixture} from '../fixtures/operational-execution-limits.js';

// 실제 생성자/등록 검사와 기존 router를 사용한다. 원가/DB/native/engine은 가짜 포트다.
// 실제 프로세스·모델·객체 I/O·운영 권한 또는 전체 네 단계 PG 완료의 증거가 아니다.
let pinnedFonts:FontCatalog;
beforeAll(async()=>{pinnedFonts=await FontCatalog.load();});
afterEach(()=>vi.restoreAllMocks());
const calculator={maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function fixture(){
  const events:string[]=[],forbidden=vi.fn(async()=>{throw Error('C3_FORBIDDEN_IO');});
  const profile=validateMeasurementProfile({...measurement,version:'c3-owned-profile',state:'MEASURED',evidenceReferences:['c3-owned-fixture'],
    limits:{maxFileBytes:1024,maxPixelsPerPage:100,maxFilesPerUpload:2,maxWorkspacePages:4,maxWorkspaceBytes:4096,maxArchiveCompressedBytes:8192,maxArchiveExpandedBytes:16384,maxArchiveEntries:12,maxArchiveRatio:20,maxManifestBytes:2048,maxDecodeMemoryBytes:4096,maxStageMilliseconds:1000,maxConcurrentImageStages:1,minReadableFontSizePx:12.5,maxRequestCostUsd:'0.2',maxDailyOperatorSpendUsd:'1'},
    mediaBounds:{maxWidth:10,maxHeight:10,maxTextLength:100,maxFontSize:24,maxBlocks:4}});
  const config:WorkerRuntimeConfig={version:1,kind:'worker',origin:'https://workspace.example.invalid',secretRoot:path.join(tmpdir(),'c3-fake-secrets'),
    database:{loginRole:'c3_owned_worker',connectionStringSecret:'worker.txt'},fonts:{root:pinnedFonts.root,catalogVersion:pinnedFonts.catalog.version},profile,
    gates:{operationalEnabled:false,realProviderEnabled:true,paidExecutionEnabled:false,purchaseEnabled:false},
    host:{httpsProxyVerified:false,resourceIsolationVerified:false,evidenceReferences:[]},
    capabilities:{geminiExactModelVerified:false,thinkingMappingVerified:false,lamaRuntimeVerified:false,lamaWeightsLicenseVerified:false,fullCostVerified:false},
    r2:{accountId:'1'.repeat(32),bucket:'c3-owned-memory',enabled:false,credentialsSecret:'r2.json',requestMilliseconds:1000},
    loop:{tickMilliseconds:100,maintenanceMilliseconds:1000,shutdownMilliseconds:1000},
    pipeline:{geminiApiKeySecret:'gemini.txt',lamaCodeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7',lamaWeightsSha256:'2'.repeat(64),lamaConfigSha256:'3'.repeat(64)}};
  config.profile.realProviderEnabled=true;
  const media=measuredMediaProfile(profile),data=operationalLimitFixture(undefined,{profileVersion:profile.version,mediaProfileDigest:digest(media)});
  const limitRead=vi.spyOn(limits,'readVerifiedOperationalExecutionLimit').mockImplementation(async(_db,identity)=>{
    events.push('LIMIT_READ');expect(identity).toEqual(data.profile.identity);
    return {reference:{kind:data.profile.kind,profileId:randomUUID(),profileVersion:profile.version,profileDigest:sha256('c3-db-profile')},
      profile:data.profile,evidence:{id:data.profile.evidence.id,sha256:data.profile.evidence.sha256,reviewedBy:'c3-fake-operator',reviewedAt:'2026-10-16T00:00:00.000Z'}};
  });
  // 같은 DB 참조를 두 번 읽어도 policy의 원 reference가 동일하다.
  const reference={kind:data.profile.kind,profileId:randomUUID(),profileVersion:profile.version,profileDigest:sha256('c3-db-profile')};
  limitRead.mockImplementation(async(_db,identity)=>{events.push('LIMIT_READ');expect(identity).toEqual(data.profile.identity);return {reference,profile:data.profile,evidence:{id:data.profile.evidence.id,sha256:data.profile.evidence.sha256,reviewedBy:'c3-fake-operator',reviewedAt:'2026-10-16T00:00:00.000Z'}};});
  const validate=vi.fn(async()=>{events.push('ROLE');return {serviceRole:'trio_web_worker' as const,sessionUser:config.database.loginRole,currentUser:'trio_web_worker',membershipRoles:['trio_web_worker']};});
  const query=vi.fn(async(sql:string)=>{if(['BEGIN READ ONLY','COMMIT','ROLLBACK'].includes(sql)||sql==='SELECT account_id FROM manga_web.active_accounts() LIMIT 1001')return {rows:[]};throw Error('C3_UNEXPECTED_SQL');});
  const close=vi.fn(async()=>{}),release=vi.fn(),connect=vi.fn(async()=>({query,release}));
  const worker={role:'trio_web_worker',validateServiceRole:validate,close,pool:{connect,query:forbidden},accountTransaction:forbidden} as unknown as Database;
  const fonts=Object.assign(Object.create(FontCatalog.prototype),{root:pinnedFonts.root,catalog:structuredClone(pinnedFonts.catalog),bytes:new Map(pinnedFonts.bytes)}) as FontCatalog;
  const objects={bucket:config.r2.bucket,put:forbidden,read:forbidden,receipt:forbidden,remove:forbidden};
  const native={forTarget:vi.fn(()=>{throw Error('C3_FORBIDDEN_NATIVE');}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};
  const journal=new FullStageCostJournal(worker,{maxRecordBytes:262144,maxRecords:16,calculator});
  const reader={workSetIn:vi.fn(async()=>null),checkpointFactsIn:vi.fn(async()=>null)};
  const cost=new OperationalStageCost({db:worker,preparation:new FullStageCostPreparation(journal,[],calculator),journal,reader,
    checkpoints:new CheckpointValidationJournal(worker,{maxRecordBytes:262144,maxRecords:16,maxTargets:16,maxJobs:16}),
    bounds:{maxRecordBytes:262144,maxRecords:16,maxSources:16,maxExecutions:16,maxInFlight:4}});
  const cleanupPreparation=new LocalLaMaNativePreparation(worker,{maxRecordBytes:262144,maxRecords:16,maxInFlightBytes:256*1024*1024,maxConcurrentReads:2,calculator},media,sha256('c3-fake-kernel'));
  const cleanup=vi.spyOn(cleanupPreparation,'prepare').mockImplementation(async()=>{events.push('CLEANUP_PREPARE');return {version:1,capture:null,created:false};});
  const lama=new LocalLaMaAdapter({enabled:false,identity:{...{codeCommit:config.pipeline.lamaCodeCommit,weightsSha256:config.pipeline.lamaWeightsSha256,configSha256:config.pipeline.lamaConfigSha256},weightsLicenseVerified:false,runtimeVerified:false},
    profile:media,executor:{dispatch:forbidden,lookup:forbidden},bounds:{maxCapturedExecutions:2,maxInFlightBytes:1024*1024}});
  const registration={identity:structuredClone(data.identity),sourceLanguage:'ja' as const,targetLanguage:'ko' as const,scope:'PAGE' as const,modelId:'c3-owned-text',contractVersion:'c3-owned-v1',reasoningLevels:['LOW'] as ('LOW'|'MEDIUM'|'HIGH')[]};
  const pin={path:path.join(tmpdir(),'c3-unused-pin'),sha256:'4'.repeat(64),bytesLength:1};
  const engine={invoke:vi.fn(()=>{throw Error('C3_FORBIDDEN_ENGINE');})};
  const translation={modelId:registration.modelId,adapter:{synthetic:false,dispatch:vi.fn(async(input:StageInput)=>reply(input)),lookup:vi.fn(async()=>null),idle:vi.fn(async()=>{})}};
  const renderCost={lookup:vi.fn(async()=>null)};
  const resources:PreparedPipelineResources={worker,objects,fonts,native,registration,
    ocr:{config:{version:2,ownedTempRoot:path.join(tmpdir(),'c3-ocr-unused'),python:pin,worker:pin,dependencyRoots:[],dependencyPins:[],detector:pin,ocr:{directory:path.join(tmpdir(),'c3-unused-model'),files:[pin]},
      settings:{modelId:registration.modelId,contractVersion:registration.contractVersion},maxRegions:4,timeoutMilliseconds:1000},engine},
    translation,lama,cost,renderCost,cleanupPreparation,bounds:{maxEncodedStageBytes:64*1024*1024,maxMetadataBytes:262144,maxInFlightBytes:300*1024*1024},evidenceBounds:{maxRecordBytes:262144,maxRecords:16}};
  return {resources,config,identity:data.identity,reference,events,forbidden,validate,close,connect,query,limitRead,cleanup,engine,translation,renderCost,reader};
}
function inputFor(f:ReturnType<typeof fixture>,stage='OCR'):StageInput {
  const executionId=randomUUID(),requestId=randomUUID(),contextId=randomUUID(),originalAssetId=randomUUID(),font=f.resources.fonts.catalog.fonts[0],license=f.resources.fonts.catalog.license;
  const settings={settingsVersion:'1',contractVersion:f.resources.registration.contractVersion,modelId:f.resources.registration.modelId,sourceLanguage:'ja',targetLanguage:'ko',reasoningLevel:'LOW',fontAssetId:font.id,baseFontSizePx:20,minFontSizePx:13} as const;
  const data:EditData={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',blocks:[],renderSpecification:{version:1,fontCatalogVersion:f.resources.fonts.catalog.version,blocks:[]}};
  const assetDependencies=[{assetId:originalAssetId,sha256:sha256('c3-fake-original'),bytesLength:'3',mediaType:'image/png'},...([font,license].map(item=>({assetId:item.id,sha256:item.sha256,bytesLength:item.bytesLength,mediaType:item.id===license.id?'text/plain':'font/otf'})))];
  return {accountId:randomUUID(),contextId,executionId,requestId,stage,inputDigest:sha256('c3-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:data,previousData:null,width:4,height:4,claimGeneration:'1',assetDependencies,
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:stage,stageContract:settings.contractVersion,inputDigest:sha256('c3-input'),assetIds:assetDependencies.map(item=>item.assetId),regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.02',parameterProfileVersion:f.config.profile.version}};
}
function reply(input:StageInput):Observation{return {evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,finishReason:'C3_FAKE_ADAPTER',providerRef:input.executionId,data:structuredClone(input.previousData??input.initialData)};}
const claim=()=>({workItemId:randomUUID(),ownerId:randomUUID(),generation:'1'});
async function failure(action:Promise<unknown>){const error:unknown=await action.then(()=>null,error=>error);expect(error).toBeInstanceOf(Error);return error as Error;}

describe('C3 prepared four-stage worker',()=>{
  it('prepared_worker_uses_fixed_four_stage_route_without_starting_work',async()=>{
    const f=fixture(),runtime=await createPreparedPipelineWorker(f.resources,f.config,f.identity);
    expect(runtime.execution.provider).toBeInstanceOf(OperationalPipelineProvider);expect(runtime.execution.policy.stageOrder).toEqual(['OCR','TRANSLATE','CLEANUP','TYPESET']);
    expect(runtime.execution.operationalCost===f.resources.cost).toBe(true);expect(runtime.execution.nativeGateway===f.resources.native).toBe(true);
    expect(runtime.execution.policy.executionLimit).toEqual(f.reference);expect(f.events[0]).toBe('ROLE');expect(f.limitRead).toHaveBeenCalledTimes(2);
    expect(inspectRuntimeConfig(f.config).ready).toBe(false);expect(f.close).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.resources.native.forTarget).not.toHaveBeenCalled();expect(f.engine.invoke).not.toHaveBeenCalled();
    expect(f.translation.adapter.dispatch).not.toHaveBeenCalled();expect(f.renderCost.lookup).not.toHaveBeenCalled();expect(f.reader.workSetIn).not.toHaveBeenCalled();
  });
  it.each(['OCR','TRANSLATE','CLEANUP','TYPESET'])('cost_and_cleanup_preparation_precede_native: common hook prepares only CLEANUP for %s',async stage=>{
    const f=fixture(),runtime=await createPreparedPipelineWorker(f.resources,f.config,f.identity),input=inputFor(f,stage),original=structuredClone(input),firstClaim=claim();
    await runtime.execution.hooks.beforeValidateInput!(input,firstClaim);
    expect(f.cleanup).toHaveBeenCalledTimes(stage==='CLEANUP'?1:0);
    if(stage==='CLEANUP'){expect(f.cleanup).toHaveBeenCalledWith(original,firstClaim);expect(f.cleanup.mock.contexts[0]===f.resources.cleanupPreparation).toBe(true);}
    expect(input).toEqual(original);expect(f.resources.native.forTarget).not.toHaveBeenCalled();expect(f.engine.invoke).not.toHaveBeenCalled();
  });
  it.each(['language','scope','model','contract','reasoning','envelope','existing OCR text'])('unsupported_input_never_falls_back: refuses %s before checkpoint/native I/O',async kind=>{
    const f=fixture(),runtime=await createPreparedPipelineWorker(f.resources,f.config,f.identity),input=inputFor(f);
    if(kind==='language')input.settings={...input.settings,sourceLanguage:'en'};
    if(kind==='scope')input.scope={kind:'REGIONS',regionIds:[randomUUID()]};
    if(kind==='model')input.settings={...input.settings,modelId:'unregistered'};
    if(kind==='contract')input.settings={...input.settings,contractVersion:'unregistered'};
    if(kind==='reasoning')input.settings={...input.settings,reasoningLevel:'HIGH'};
    if(kind==='envelope')input.envelope!.executionId=randomUUID();
    if(kind==='existing OCR text')input.initialData.blocks=[{regionId:randomUUID()}] as EditData['blocks'];
    const error=await failure(runtime.execution.hooks.beforeValidateInput!(input,claim()));expect(error.message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');
    expect(f.cleanup).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.resources.native.forTarget).not.toHaveBeenCalled();expect(f.translation.adapter.dispatch).not.toHaveBeenCalled();
  });
  it.each(['identity','ocr settings','v1','missing engine','synthetic translation','missing cost','missing renderCost','wrong preparation DB','unknown key'])('factory_rejects_mutated_identity_or_route: %s',async kind=>{
    const f=fixture(),resources={...f.resources};
    if(kind==='identity')resources.registration={...resources.registration,identity:{...f.identity,pipelineDigest:'9'.repeat(64)}};
    if(kind==='ocr settings')resources.ocr={...resources.ocr,config:{...resources.ocr.config,settings:{modelId:'different',contractVersion:resources.registration.contractVersion}}};
    if(kind==='v1')Object.assign(resources.ocr,{config:{...resources.ocr.config,version:1}});
    if(kind==='missing engine')Reflect.deleteProperty(resources.ocr,'engine');
    if(kind==='synthetic translation')resources.translation={...resources.translation,adapter:{...resources.translation.adapter,synthetic:true}};
    if(kind==='missing cost')Reflect.deleteProperty(resources,'cost');
    if(kind==='missing renderCost')Reflect.deleteProperty(resources,'renderCost');
    if(kind==='wrong preparation DB')resources.worker={...resources.worker} as Database;
    if(kind==='unknown key')Object.defineProperty(resources,'enabled',{value:true,enumerable:true});
    expect((await failure(createPreparedPipelineWorker(resources,f.config,f.identity))).message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');
    expect(f.validate).not.toHaveBeenCalled();expect(f.limitRead).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
  });
  it('does not evaluate data getters or proxy descriptor traps',async()=>{
    const f=fixture(),getter=vi.fn(()=>f.resources.registration),resources={...f.resources};
    Object.defineProperty(resources,'registration',{enumerable:true,get:getter});
    expect((await failure(createPreparedPipelineWorker(resources,f.config,f.identity))).message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');expect(getter).not.toHaveBeenCalled();
    const traps=vi.fn(),proxy=new Proxy(f.resources,{getOwnPropertyDescriptor(...args){traps();return Reflect.getOwnPropertyDescriptor(...args);}});
    expect((await failure(createPreparedPipelineWorker(proxy,f.config,f.identity))).message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');expect(traps).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();
  });
  it('factory_captures_resources_before_await_and_keeps_the_original_gateway_identity',async()=>{
    const f=fixture(),entered=deferred(),resume=deferred(),originalNative=f.resources.native,originalCost=f.resources.cost,originalCleanup=f.resources.cleanupPreparation,originalModel=f.resources.registration.modelId;
    const before=structuredClone(f.resources.registration),role=f.validate.getMockImplementation()!;
    f.validate.mockImplementationOnce(async()=>{entered.resolve();await resume.promise;return role();});
    const pending=createPreparedPipelineWorker(f.resources,f.config,f.identity),settled=pending.then(()=>false,()=>false);
    try{
      expect(await Promise.race([entered.promise.then(()=>true),settled])).toBe(true);
      f.identity.pipelineDigest='8'.repeat(64);f.resources.registration.modelId='changed';f.resources.ocr.config.settings.modelId='changed';f.resources.bounds.maxMetadataBytes=1;
      f.resources.native={forTarget:vi.fn(()=>{throw Error('C3_REPLACED_NATIVE');}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};
      f.resources.cleanupPreparation={} as LocalLaMaNativePreparation;f.resources.cost={} as OperationalStageCost;
      f.resources.fonts.catalog.fonts[0].sha256='8'.repeat(64);f.config.fonts.root=path.join(tmpdir(),'changed-font-root');f.config.r2.bucket='changed-bucket';
    }finally{resume.resolve();}
    expect(f.identity.pipelineDigest).not.toBe(before.identity.pipelineDigest);
    const runtime=await pending;expect(runtime.execution.nativeGateway===originalNative).toBe(true);expect(runtime.execution.operationalCost===originalCost).toBe(true);
    const input=inputFor(f,'CLEANUP');input.settings={...input.settings,modelId:originalModel};input.envelope!.capturedSettings={...input.settings};
    await runtime.execution.hooks.beforeValidateInput!(input,claim());expect(f.cleanup).toHaveBeenCalledOnce();expect(f.cleanup.mock.contexts[0]===originalCleanup).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(['role','before handoff','after handoff','close failure'])('role_failure_precedes_limit_read / factory_failure_closes_owned_pool_once: %s',async kind=>{
    const f=fixture();
    if(kind==='role')f.validate.mockRejectedValue(Error('C3_ROLE_FAILURE'));
    if(kind==='before handoff')f.limitRead.mockRejectedValue(Error('C3_LIMIT_FAILURE'));
    if(kind==='after handoff')f.query.mockRejectedValue(Error('C3_FONT_FACT_FAILURE'));
    if(kind==='close failure'){f.limitRead.mockRejectedValue(Error('C3_LIMIT_FAILURE'));f.close.mockRejectedValue(Error('C3_CLOSE_FAILURE'));}
    const error=await failure(createPreparedPipelineWorker(f.resources,f.config,f.identity));expect(f.close).toHaveBeenCalledOnce();
    if(kind==='role')expect(f.limitRead).not.toHaveBeenCalled();
    if(kind==='close failure')expect(error.message).toBe('RUNTIME_POOL_CLOSE_UNCONFIRMED');
    expect(f.forbidden).not.toHaveBeenCalled();expect(f.resources.native.forTarget).not.toHaveBeenCalled();
  });
  it('routes OCR and translation through actual TextStagesProvider and outer pipeline with isolated adapter/journal ports',async()=>{
    const f=fixture(),records=new Map<string,unknown[]>(),ownerNames:string[]=[],candidates=new Map<string,PipelineStageCandidate>();
    vi.spyOn(PipelineEvidence.prototype,'candidate').mockImplementation(async function(this:PipelineEvidence,input:StageInput){
      ownerNames.push(String(Object.getOwnPropertyDescriptor(this,'owner')?.value));
      const candidate:PipelineStageCandidate={version:1,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage,claimGeneration:'1',evidenceId:randomUUID(),maskAssetId:null,cleanedAssetId:null,renderAssetId:null};
      candidates.set(input.executionId,candidate);return {created:true,candidate};
    });
    vi.spyOn(PipelineEvidence.prototype,'record').mockImplementation(async(input,kind,value)=>{records.set(input.executionId+kind,[...(records.get(input.executionId+kind)??[]),value]);});
    vi.spyOn(PipelineEvidence.prototype,'records').mockImplementation(async<T>(input:StageInput,kind:PipelineRecordKind):Promise<T[]>=>structuredClone(records.get(input.executionId+kind)??[]) as T[]);
    const ocr=vi.spyOn(LocalOcrAdapter.prototype,'dispatch').mockImplementation(async function(this:LocalOcrAdapter,input:StageInput){
      const options=Object.getOwnPropertyDescriptor(this,'options')!.value as {journal:PipelineEvidence};
      ownerNames.push(String(Object.getOwnPropertyDescriptor(options.journal,'owner')?.value));return reply(input);
    });
    const text=vi.spyOn(TextStagesProvider.prototype,'dispatch'),runtime=await createPreparedPipelineWorker(f.resources,f.config,f.identity);
    for(const stage of ['OCR','TRANSLATE']){
      const input=inputFor(f,stage);await runtime.execution.hooks.beforeValidateInput!(input,claim());
      const result=await runtime.execution.provider.dispatch(input,vi.fn(),{native:{} as NativeFacade});
      expect(result.outcome).toBe('SUCCESS');expect(result.costUsd).toBeNull();expect(result.usageConfirmed).toBe(false);
      expect(result.stageOutput).toBeDefined();expect(normalizeObservation(input,result)).toEqual(result);
    }
    expect(text).toHaveBeenCalledTimes(2);expect(ocr).toHaveBeenCalledOnce();expect(f.translation.adapter.dispatch).toHaveBeenCalledOnce();
    expect(ownerNames).toEqual(['PIPELINE_V1','LOCAL_OCR_V1','PIPELINE_V1']);expect(candidates.size).toBe(2);expect(f.engine.invoke).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
  });
});

it.each(['getter','proxy function','wrong value'])('C3 refuses native maintenance %s without accessor execution or role/limit I/O',async kind=>{
  const f=fixture(),getter=vi.fn(()=>undefined),native=f.resources.native;
  if(kind==='getter')Object.defineProperty(native,'maintenance',{enumerable:true,get:getter});
  else Object.defineProperty(native,'maintenance',{enumerable:true,value:kind==='proxy function'?new Proxy(async()=>{},{apply(){throw Error('C3_PROXY_EXECUTED');}}):17});
  const error=await failure(createPreparedPipelineWorker(f.resources,f.config,f.identity));
  expect(error.message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');expect(getter).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();expect(f.limitRead).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});
it.each(['bytes','nested accessor'])('C3 bounds metadata and refuses %s before role/limit I/O',async kind=>{
  const f=fixture(),getter=vi.fn(()=>['untrusted']);
  if(kind==='bytes')f.resources.registration.modelId='x'.repeat(f.resources.bounds.maxMetadataBytes+1);
  else Object.defineProperty(f.config.profile,'evidenceReferences',{enumerable:true,get:getter});
  expect((await failure(createPreparedPipelineWorker(f.resources,f.config,f.identity))).message).toBe('RUNTIME_FACTORY_OPTIONS_INVALID');
  expect(getter).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();expect(f.limitRead).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});
it('C3 preserves font bytes and directly bound translation, engine, object, render-cost and preparation methods across the first await',async()=>{
  const f=fixture(),entered=deferred(),resume=deferred(),validate=f.validate.getMockImplementation()!,fontId=f.resources.fonts.catalog.fonts[0].id;
  const sourceBytes=Buffer.from(f.resources.fonts.bytes.get(fontId)!);f.resources.fonts.bytes.set(fontId,sourceBytes);const first=sourceBytes[0];
  const originalStore={...f.resources.objects,read:vi.fn(async()=>Buffer.from('C3_ORIGINAL_BYTES'))};f.resources.objects=originalStore;
  const originalEngine=f.resources.ocr.engine,originalInvoke=originalEngine.invoke;
  const originalTranslation=f.resources.translation.adapter,originalDispatch=originalTranslation.dispatch;
  const originalRender=f.resources.renderCost,originalLookup=originalRender.lookup;
  const originalPreparation=f.resources.cleanupPreparation,originalPrepare=originalPreparation.prepare;
  const ocr=vi.spyOn(LocalOcrAdapter.prototype,'dispatch').mockImplementation(async function(this:LocalOcrAdapter,input:StageInput){
    const engine=Object.getOwnPropertyDescriptor(this,'engine')!.value as {invoke:typeof originalInvoke};
    const config=f.resources.ocr.config;
    const request={version:2 as const,executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),configDigest:digest(config),ownedTempRoot:config.ownedTempRoot,outputDirectory:config.ownedTempRoot,
      source:{sha256:input.assetDependencies![0].sha256,width:input.width,height:input.height,page:input.envelope!.pageLineageId,path:config.worker.path},
      detector:config.detector,ocr:config.ocr,dependencyRoots:config.dependencyRoots,maxRegions:config.maxRegions,threads:4 as const,maxNewTokens:100 as const,cropPadding:3 as const};
    expect(()=>engine.invoke(input,request,vi.fn())).toThrow('C3_FORBIDDEN_ENGINE');return reply(input);
  });
  f.validate.mockImplementationOnce(async()=>{entered.resolve();await resume.promise;return validate();});
  const pending=createPreparedPipelineWorker(f.resources,f.config,f.identity),settled=pending.then(()=>false,()=>false);
  const replaced=vi.fn(async()=>{throw Error('C3_REPLACED_METHOD_EXECUTED');}),replacementEngine=vi.fn(()=>{throw Error('C3_REPLACED_ENGINE_EXECUTED');});
  try{
    expect(await Promise.race([entered.promise.then(()=>true),settled])).toBe(true);sourceBytes[0]^=255;
    originalStore.read=replaced;originalTranslation.dispatch=replaced;originalEngine.invoke=replacementEngine;originalRender.lookup=replaced;originalPreparation.prepare=replaced;
  }finally{resume.resolve();}
  const runtime=await pending;
  expect(runtime.options.fonts.bytes.get(fontId)![0]).toBe(first);expect(runtime.options.fonts.bytes.get(fontId)===sourceBytes).toBe(false);
  expect(await runtime.options.objects.read('c3-owned-key')).toEqual(Buffer.from('C3_ORIGINAL_BYTES'));
  const options=Object.getOwnPropertyDescriptor(runtime.execution.provider,'options')!.value as import('../../packages/domain/src/operational-pipeline.js').OperationalPipelineOptions;
  expect(await options.renderCost.lookup(inputFor(f,'TYPESET'),sha256('c3-render'))).toBeNull();
  await options.provider.dispatch(inputFor(f,'TRANSLATE'),vi.fn());await options.provider.dispatch(inputFor(f,'OCR'),vi.fn());
  await runtime.execution.hooks.beforeValidateInput!(inputFor(f,'CLEANUP'),claim());
  expect(f.cleanup).toHaveBeenCalledOnce();expect(f.cleanup.mock.contexts[0]===originalPreparation).toBe(true);
  expect(f.translation.adapter===originalTranslation).toBe(true);expect((originalDispatch as typeof f.translation.adapter.dispatch).mock.contexts[0]===originalTranslation).toBe(true);
  expect(originalStore.read===replaced).toBe(true);expect(f.engine.invoke===replacementEngine).toBe(true);
  expect((originalInvoke as typeof f.engine.invoke).mock.contexts[0]===originalEngine).toBe(true);
  expect((originalLookup as typeof f.renderCost.lookup).mock.contexts[0]===originalRender).toBe(true);
  expect(originalPrepare===f.cleanup).toBe(true);expect(ocr).toHaveBeenCalledOnce();expect(replaced).not.toHaveBeenCalled();expect(replacementEngine).not.toHaveBeenCalled();
});

it('C4 fixes the original translation idle before the role await without invoking it during assembly',async()=>{
  const f=fixture(),entered=deferred(),resume=deferred(),original=f.validate.getMockImplementation()!,adapter=f.translation.adapter;
  adapter.idle=vi.fn(async()=>{});
  const idle=adapter.idle,replacement=vi.fn(async()=>{throw Error('C4_REPLACED_TRANSLATION_IDLE');});
  f.validate.mockImplementation(async()=>{entered.resolve();await resume.promise;return original();});
  const pending=createPreparedPipelineWorker(f.resources,f.config,f.identity);
  try{await entered.promise;adapter.idle=replacement;}finally{resume.resolve();}
  const runtime=await pending;expect(typeof runtime.options.workerProviderIdle).toBe('function');expect(idle).not.toHaveBeenCalled();
  runtime.stopClaims();await runtime.idle();expect(idle).toHaveBeenCalledOnce();expect(idle.mock.contexts[0]===adapter).toBe(true);expect(replacement).not.toHaveBeenCalled();expect(f.engine.invoke).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
});
it.each(['missing','getter','proxy'] as const)('C4 refuses translation idle %s before role and limit I/O',async kind=>{
  const f=fixture(),getter=vi.fn(()=>async()=>{}),adapter=f.translation.adapter;
  if(kind==='missing')Reflect.deleteProperty(adapter,'idle');
  else Object.defineProperty(adapter,'idle',{enumerable:true,configurable:true,...(kind==='getter'?{get:getter}:{value:new Proxy(async()=>{},{apply(){throw Error('C4_PROXY_TRANSLATION_IDLE');}})})});
  const error:unknown=await createPreparedPipelineWorker(f.resources,f.config,f.identity).then(()=>null,e=>e);
  expect(error).toMatchObject({code:'RUNTIME_FACTORY_OPTIONS_INVALID'});expect(getter).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();expect(f.limitRead).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});

it('C4 joins both provider ports before draining native and cost after one provider failure',async()=>{
  const f=fixture(),ocr=deferred(),error=Error('C4_TRANSLATION_IDLE_UNKNOWN'),idle=vi.spyOn(LocalOcrAdapter.prototype,'idle').mockImplementation(()=>ocr.promise);
  f.translation.adapter.idle.mockRejectedValue(error);
  const cost=vi.spyOn(f.resources.cost,'idle'),runtime=await createPreparedPipelineWorker(f.resources,f.config,f.identity);
  runtime.stopClaims();const outcome=runtime.idle().then(()=>null,e=>e);
  try{
    for(let i=0;i<20;i++)await Promise.resolve();expect(idle).toHaveBeenCalledOnce();expect(f.translation.adapter.idle).toHaveBeenCalledOnce();
    expect(f.resources.native.idle).not.toHaveBeenCalled();expect(cost).not.toHaveBeenCalled();
    ocr.resolve();expect(await outcome).toBe(error);expect(f.resources.native.idle).toHaveBeenCalledOnce();expect(cost).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
  }finally{ocr.resolve();await outcome;}
});
