import {AsyncLocalStorage} from 'node:async_hooks';
import pg from 'pg';
import canonicalize from 'canonicalize';
import {randomUUID,randomBytes,sign,generateKeyPairSync} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {vi} from 'vitest';
import measurement from '../../packages/contracts/schemas/measurement-profile.json';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {Database,type Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {validateMeasurementProfile,measuredMediaProfile} from '../../packages/operations/src/measurement-profile.js';
import type {WorkerRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import {createOperationalRequestPolicy} from '../../packages/operations/src/runtime-startup.js';
import {createPreparedPipelineWorker} from '../../packages/operations/src/pipeline-runtime.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import {createNativeJob,createNativeResult,verifyNativeInput,describeNativeBlobs,nativeTaskVersion,type NativeJob,type NativeComputation,type NativeRunHooks,type NativeTask,type NativeTermination,type NativeJobEvidence} from '../../packages/native/src/dto.js';
import {nativeKernelImplementationDigest} from '../../packages/native/src/identity.js';
import {validateNativeJob,type NativeInputs} from '../../packages/native/src/jobs.js';
import {NativeCapacityOperator,NativeCapacityStore,type NativeCapacityProof} from '../../packages/domain/src/native-capacity.js';
import type {NativeTarget,NativeSourceInputRef} from '../../packages/native/src/gateway.js';
import {NativeJobStore,nativeOperationInputDigest,type NativeJobClaim} from '../../packages/domain/src/native-jobs.js';
import type {NativeSealedReceipt} from '../../packages/domain/src/native-receipts.js';
import {LocalLaMaNativePreparation} from '../../packages/domain/src/local-lama-native-preparation.js';
import {LocalLaMaDomainAttemptStore} from '../../packages/domain/src/local-lama-attempt-store.js';
import {LocalLaMaInvocationCoordinator,type LocalLaMaInvocationBinding} from '../../packages/providers/src/local-lama-executor.js';
import {LocalLaMaAdapter,type LocalLaMaExecutionInput,type LocalLaMaExecutorReply} from '../../packages/providers/src/local-lama.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalOcrEnginePort,LocalOcrProcessReceipt,LocalOcrRequest} from '../../packages/providers/src/local-ocr-executor.js';
import type {LocalOcrConfig} from '../../packages/providers/src/local-ocr.js';
import {OperationalPipelineProvider} from '../../packages/domain/src/operational-pipeline.js';
import {OperationalStageCost,type OperationalStageCostReader,type OperationalStageCostWorkSet} from '../../packages/domain/src/pipeline-stage-cost.js';
import {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {FullStageCostJournal,type FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import type {FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {CheckpointValidationJournal,checkpointValidationVersion,type CheckpointValidationAttempt,type CheckpointValidationOperation,type CheckpointValidationView} from '../../packages/domain/src/checkpoint-validation.js';
import {canonicalInput,storedInput,normalizeObservation,type StageInput,type ProviderAdapter,type Observation} from '../../packages/domain/src/provider.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {contextRow,type EditData} from '../../packages/domain/src/model.js';
import type {Settings,WorkspaceCommand,OcrProposal,TranslationProposal} from '../../packages/contracts/src/wire.generated.js';
import type {MediaProfile} from '../../packages/media/src/profile.js';
import type {NativeCapacityConfiguration,OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';
import {seedIdentity,seedWorkspace,testDatabase} from './database.js';
import {operationalLimitFixture} from './operational-execution-limits.js';

// 이 파일을 쓰는 C5 검사 프로세스 안에서만 controller 모듈을 대체한다.
// 부모 hooks/DB/facade/receipt는 원 구현이다. 계산은 고정 합성 자료이며 물리 child 증거가 아니다.
const fakeNative=vi.hoisted(()=>{
  class Controller {
    readonly supportsParentHooks=true as const;
    readonly parentInstanceId:string;readonly profileDigest:string;readonly kernelImplementationDigest:string;
    accepting=true;pending=new Set<Promise<unknown>>();jobs:NativeJob[]=[];omitTermination=false;omitResult=false;
    constructor(readonly options:{profile:MediaProfile}){const p=fakeNative.initialize(options.profile);this.parentInstanceId=p.id;this.profileDigest=p.profile;this.kernelImplementationDigest=p.kernel;}
    frameLimits(_direction:'input'|'output'){return {maxMetadataBytes:262144,maxBinaryBytes:64*1024*1024,maxItems:32};}
    run(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:NativeRunHooks){return this.runCaptured(fakeNative.job(task,this.profileDigest,metadata,blobs),blobs,hooks);}
    runCaptured(job:NativeJob,blobs:Map<string,Buffer>,hooks?:NativeRunHooks):Promise<NativeComputation>{
      if(!this.accepting)throw Error('C5_CONTROLLER_STOPPED');const promise=fakeNative.execute(this,job,blobs,hooks);this.pending.add(promise);promise.then(()=>this.pending.delete(promise),error=>{this.pending.delete(promise);fakeNative.onError(error);});return promise;
    }
    stopClaims(){this.accepting=false;}
    async idle(){const r=await Promise.allSettled([...this.pending]);if(r.some(x=>x.status==='rejected'))throw Error('C5_NATIVE_JOIN_FAILED');}
    async reconcileTerminations(){await this.idle();}
  }
  return {Controller,initialize:null! as (profile:MediaProfile)=>{id:string;profile:string;kernel:string},
    beforeComputation:async(_job:NativeJob)=>{},smallLayout:():boolean=>false,observeFile:(_name:string,_key:string,_value:unknown)=>{},afterTermination:async(_job:NativeJob)=>{},onError:(_error:unknown)=>{},observeNative:(_job:NativeJob,_phase:string)=>{},observeSealed:(_record:NativeSealedReceipt,_requested:NativeSealRequest)=>{},
    job:null! as (t:NativeTask,p:string,m:Record<string,unknown>,b:Map<string,Buffer>)=>NativeJob,execute:null! as (c:Controller,j:NativeJob,b:Map<string,Buffer>,h?:NativeRunHooks)=>Promise<NativeComputation>};
});
vi.mock('../../packages/native/src/controller.js',()=>({NativeController:fakeNative.Controller}));
vi.mock('../../packages/domain/src/native-receipts.js',async original=>{
  const module=await original<typeof import('../../packages/domain/src/native-receipts.js')>();
  const seal=module.NativeReceiptStore.prototype.seal,record=module.NativeReceiptStore.prototype.sealedRecord;
  const requested=(store:InstanceType<typeof module.NativeReceiptStore>,task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,sealed:NativeSealedReceipt):NativeSealRequest=>{
    const profileDigest=digest(metadata.profile),operationInputDigest=nativeOperationInputDigest({...sealed.intent,task,taskVersion:nativeTaskVersion,profileDigest,metadata,blobs:describeNativeBlobs(inputs,store.frameLimits('input'))});
    return {task,taskVersion:nativeTaskVersion,profileDigest,operationInputDigest,target:structuredClone(store.target)};
  };
  module.NativeReceiptStore.prototype.seal=async function(...args){const value=await seal.apply(this,args),sealed=record.call(this,args[0],args[1],args[2]);fakeNative.observeSealed(sealed,requested(this,args[0],args[1],args[2],sealed));return value;};
  module.NativeReceiptStore.prototype.sealedRecord=function(...args){const value=record.apply(this,args);fakeNative.observeSealed(value,requested(this,...args,value));return value;};
  return module;
});


vi.mock('../../packages/storage/src/objects.js',async original=>{
  const module=await original<typeof import('../../packages/storage/src/objects.js')>();
  for(const name of ['put','read','receipt','presence'] as const){
    const method=module.FileObjectStore.prototype[name];
    Object.defineProperty(module.FileObjectStore.prototype,name,{...Object.getOwnPropertyDescriptor(module.FileObjectStore.prototype,name),value:async function(this:import('../../packages/storage/src/objects.js').FileObjectStore,...args:unknown[]){
      const result=await (method as (...values:unknown[])=>Promise<unknown>).apply(this,args);
      fakeNative.observeFile(name,String(args[0]),result);return result;
    }});
  }
  return module;
});

export function syntheticPng(width=256,height=256,color=255){
  const crc=(b:Buffer)=>{let n=0xffffffff;for(const x of b){n^=x;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
  const chunk=(kind:string,data:Buffer)=>{const type=Buffer.from(kind),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,data])),8+data.length);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const scan=Buffer.alloc(height*(width*4+1),color);for(let y=0;y<height;y++)scan[y*(width*4+1)]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
const frames={maxMetadataBytes:262144,maxBinaryBytes:64*1024*1024,maxItems:32};
fakeNative.initialize=p=>({id:randomUUID(),profile:digest(p),kernel:nativeKernelImplementationDigest()});
fakeNative.job=(t,p,m,b)=>createNativeJob(t,p,m,b,frames);
fakeNative.execute=async(c,job,blobs,hooks)=>{
  verifyNativeInput(job);validateNativeJob({envelope:job,blobs});c.jobs.push(structuredClone(job));
  if(!hooks)throw Error('C5_PARENT_HOOKS_REQUIRED');
  fakeNative.observeNative(job,'ENTER');await hooks.intent(job);await hooks.consumeGo(job);await fakeNative.beforeComputation(job);
  const computation=fakeComputation(job,blobs),result=createNativeResult(job,computation,frames);
  const termination:NativeTermination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const evidence:NativeJobEvidence={version:1,jobId:job.jobId,task:job.task,inputDigest:job.inputDigest,profileDigest:job.profileDigest,isolation:'OWNED_FIXTURE',state:c.omitResult?'UNKNOWN':'SUCCEEDED',code:c.omitResult?'C5_RESULT_UNCONFIRMED':'OK',goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,elapsedMs:1,inputBytes:[...blobs.values()].reduce((n,b)=>n+b.length,0),outputBytes:[...computation.blobs.values()].reduce((n,b)=>n+b.length,0)};
  await hooks.observation(job,evidence,termination,c.omitResult?null:result);
  if(!c.omitTermination){await hooks.termination(job,evidence,termination);await fakeNative.afterTermination(job);fakeNative.observeNative(job,'TERMINATED');}
  return computation;
};
function fakeComputation(job:NativeJob,blobs:Map<string,Buffer>):NativeComputation{
  const out=new Map<string,Buffer>(),add=(id:string,b:Buffer)=>{out.set(id,Buffer.from(b));return b.length;};
  if(job.task==='DECODE_IMAGE'){const m=job.metadata as NativeInputs['DECODE_IMAGE'];const b=blobs.get(m.sourceBlobId)!;return {metadata:{width:b.readUInt32BE(16),height:b.readUInt32BE(20),mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:add('canonical-png',b)},blobs:out};}
  if(job.task==='POLYGON_MASK'){const m=job.metadata as NativeInputs['POLYGON_MASK'];const b=syntheticPng(m.width,m.height,0),pixels=Buffer.alloc(m.width*m.height);for(const polygon of m.polygons){const x0=Math.min(...polygon.map((p:{x:number;y:number})=>p.x)),x1=Math.max(...polygon.map((p:{x:number;y:number})=>p.x)),y0=Math.min(...polygon.map((p:{x:number;y:number})=>p.y)),y1=Math.max(...polygon.map((p:{x:number;y:number})=>p.y));for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)pixels[y*m.width+x]=255;}return {metadata:{width:m.width,height:m.height,pngBlobId:'mask-png',pngByteLength:add('mask-png',b),pixelsBlobId:'mask-pixels',pixelsByteLength:add('mask-pixels',pixels)},blobs:out};}
  if(job.task==='COMPOSITE_MASKED'){const m=job.metadata as NativeInputs['COMPOSITE_MASKED'];const b=blobs.get(m.sourceBlobId)!;return {metadata:{width:256,height:256,pngBlobId:'composed',pngByteLength:add('composed',b),outsideChangedPixels:0,maskSha256:sha256(blobs.get(m.maskBlobId)!)},blobs:out};}
  if(job.task==='GEMINI_PREPARE'){const m=job.metadata as NativeInputs['GEMINI_PREPARE'];
    const input=m.input as StageInput,selected=[...input.envelope!.regionIds],inputFingerprint=digest(canonicalInput(input)),source=blobs.get('source');
    const crops=source?[{inputRegionId:null,requiredReadingOrder:null,origin:{x:0,y:0},width:input.width,height:input.height,pngSha256:sha256(source),maskSha256:sha256(Buffer.alloc(input.width*input.height,255)),allowedPolygon:null}]:[];
    const texts=selected.map(regionId=>({regionId,sha256:sha256((input.previousData??input.initialData).blocks.find(b=>b.regionId===regionId)!.sourceText.value)}));
    const scopeDigest=digest({version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint,scope:input.scope,paintStrokes:input.paintStrokes??[],paintInclusion:input.paintInclusion??null,crops,texts});
    const plan={version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint,scopeDigest,stage:input.stage,selectedRegionIds:selected,crops,texts,fontCatalogVersion:m.fonts.catalog.version,parameterProfileVersion:m.profile.id,maskSampleCount:source?input.width*input.height:0};
    const images=source?[{mediaType:'image/png',scopeDigest,coordinateOrigin:{x:0,y:0},width:input.width,height:input.height,inputRegionId:null,requiredReadingOrder:null,maskSha256:crops[0].maskSha256,blobId:'crop-0',byteLength:add('crop-0',source)}]:[];
    return {metadata:{plan,material:{envelope:input.envelope,stage:input.stage,sourceTexts:selected.map(inputRegionId=>({inputRegionId,sourceText:(input.previousData??input.initialData).blocks.find(b=>b.regionId===inputRegionId)!.sourceText.value})),images,scopeDigest}},blobs:out};
  }
  if(job.task==='GEMINI_APPLY'){const m=job.metadata as NativeInputs['GEMINI_APPLY'];
    const input=m.input as StageInput,data=structuredClone(input.previousData??input.initialData);
    if(input.stage==='OCR')data.blocks=(m.proposal as OcrProposal).regions.map((r,i:number)=>({regionId:m.novelRegionIds[i],geometry:r.geometry,sourceText:{value:r.sourceText,status:'AI_PROPOSED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:input.settings.fontAssetId,fontSizePx:input.settings.baseFontSizePx,appliedTranslation:null}));
    else for(const block of data.blocks){const item=(m.proposal as TranslationProposal).items.find((x)=>x.inputRegionId===block.regionId);if(item){block.translatedText={value:item.targetText,status:'AI_PROPOSED'};block.appliedTranslation={sourceLanguage:input.settings.sourceLanguage,targetLanguage:input.settings.targetLanguage,modelId:input.settings.modelId,reasoningLevel:input.settings.reasoningLevel,modelContract:input.settings.contractVersion,promptContract:'gemini-scoped-material-v1',originExecutionId:input.executionId};}}
    data.renderSpecification={version:1,fontCatalogVersion:m.fonts.catalog.version,blocks:data.blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:input.settings.minFontSizePx,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'}))};
    return {metadata:{data},blobs:out};
  }
  if(job.task==='RENDER_PAGE'){const m=job.metadata as NativeInputs['RENDER_PAGE'];
    const data=m.data as EditData,blocks=data.blocks.map(b=>{const spec=data.renderSpecification?.blocks.find(s=>s.regionId===b.regionId);return {regionId:b.regionId,rendererVersion:'pango-overflow-v2',fontSizePx:b.fontSizePx,minimumFontSizePx:spec?.sizing==='EXACT'?b.fontSizePx:spec?.minimumFontSizePx??m.minimumFontSizePx,fallbackAtMinimum:false,angleDegrees:b.geometry.angleDegrees,glyphBounds:{left:32,top:32,width:192,height:96},glyphPixels:100,glyphPixelsOutsidePolygon:0,glyphPixelsOutsidePage:0,glyphPixelsInsideOtherPolygons:[]};});
    return {metadata:{layout:{rendererVersion:'pango-mixed-v2',qa:fakeNative.smallLayout()?'HOLD':'REVIEW_REQUIRED',holdReasons:fakeNative.smallLayout()?['OVERFLOW_TOLERANCE_UNMEASURED']:[],blocks},bytesBlobId:fakeNative.smallLayout()?null:'render',bytesLength:fakeNative.smallLayout()?null:add('render',syntheticPng()),overlays:blocks.map((b,i)=>({blobId:'overlay-'+i,byteLength:add('overlay-'+i,syntheticPng(192,96)),regionId:b.regionId,bounds:b.glyphBounds}))},blobs:out};
  }
  throw Error('C5_UNEXPECTED_NATIVE_TASK_'+job.task);
}

type ParentEvent={id:string;operationId:string;phase:string;attemptId:string|null;targetId:string|null;kind:string;executionId:string;inputFingerprint:string;quantity:number;detail:unknown};
type ParentGroup={executionId:string;inputFingerprint:string;events:ParentEvent[];pending:number;returned:boolean;engineJoined:boolean;terminationId:string;closed:{digest:string;measurements:{kind:string;operationId:string;eventId:string;memberIds:string[];quantity:number}[]}|null};
type NativeSourceObservation={executionId:string;inputFingerprint:string;outputDigest:string|null};
type NativeSealRequest={task:NativeTask;taskVersion:NativeJob['taskVersion'];profileDigest:string;operationInputDigest:string;target:NativeTarget};
type NativeSealObservation=NativeSealedReceipt&{requested:NativeSealRequest;source:NativeSourceObservation};
type Scope={group:ParentGroup;phase:string;attemptId:string|null;targetId:string|null;source?:NativeSourceObservation};
type EvidenceRow={evidence_id:string;evidence_digest:string;kind:string;protected_observation:{[key:string]:unknown;value?:{phase?:string;value?:{kind?:string};originalClaim?:NativeJobClaim}}};
type AttemptEvents={attempt:CheckpointValidationAttempt;consumer:StageInput;verified?:CheckpointValidationView;operations:Map<string,{operationId:string;semanticId:string;reads:Map<string,{eventId:string;sha256:string;bytesLength:string}>;native:NativeSealedReceipt[];evidenceId:string;wrapper:unknown|null}>};
const calculator={maxInputBytes:262144,maxOutputBytes:262144,maxComponents:16,maxEvidenceRefs:2048,maxStringBytes:512};
const checkpointBounds={maxRecordBytes:262144,maxRecords:512,maxTargets:16,maxJobs:128};
export async function pipelineRuntimeFixture(){
  const control={checkpointFault:null as null|'semantic'|'storage'|'native'|'digest'|'final',costUnknown:false,allocationUnknown:false,loseJournal:false,smallLayout:false,providerFailure:null as string|null,providerReject:null as string|null,rejectFinalOnce:false,beforeNative:null as null|((job:NativeJob)=>Promise<void>),beforeProvider:null as null|((input:StageInput)=>Promise<void>),beforeReturn:null as null|((input:StageInput)=>Promise<void>),beforeCost:null as null|((input:StageInput)=>Promise<void>),ackKind:null as string|null,completionAck:false,acks:[] as string[]};
  let now=new Date();const clock=async()=>{now=new Date(Math.max(now.valueOf(),Date.now()));return now;},admin=await testDatabase(clock);
  const cleanup:(()=>Promise<unknown>)[]=[];const ownDb=(db:Database)=>{const close=db.close.bind(db);let closing:Promise<void>|null=null;Object.defineProperty(db,'close',{configurable:true,writable:true,value:()=>closing??=close()});cleanup.push(()=>db.close());return db;};ownDb(admin);const release=async()=>{const failures:unknown[]=[];for(const action of cleanup.splice(0).reverse())try{await action();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'C5_FIXTURE_CLEANUP_UNCONFIRMED');};
  try{
  const sampled=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;now=sampled;
  const api=ownDb(await provisionLocalService(admin,'trio_web_api',clock)),worker=ownDb(await provisionLocalService(admin,'trio_web_worker',clock));
  const errors:unknown[]=[];const transaction=worker.accountTransaction.bind(worker);vi.spyOn(worker,'accountTransaction').mockImplementation((async(accountId,run,restricted)=>{let lost:string|null=null;try{const result=await transaction(accountId,async tx=>{const before=control.ackKind?new Set((await tx.client.query<{evidence_id:string}>('SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND kind=$2',[accountId,control.ackKind])).rows.map(r=>r.evidence_id)):null;const applications=control.completionAck?(await tx.client.query('SELECT 1 FROM result_applications WHERE account_id=$1',[accountId])).rowCount:null;const value=await run(tx);if(before&&control.ackKind&&(await tx.client.query<{evidence_id:string}>('SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND kind=$2',[accountId,control.ackKind])).rows.some(r=>!before.has(r.evidence_id))){lost=control.ackKind;control.ackKind=null;}if(control.completionAck&&applications===0&&(await tx.client.query('SELECT 1 FROM result_applications WHERE account_id=$1',[accountId])).rowCount){lost='COMPLETION';control.completionAck=false;}return value;},restricted);if(lost){control.acks.push(lost);throw Error('C5_ACK_LOST_AFTER_REAL_COMMIT_'+lost);}return result;}catch(e){errors.push({message:String(e),stack:(e as Error)?.stack});throw e;}}) as Database['accountTransaction']);
  const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now),root=await mkdtemp(path.join(tmpdir(),'trio-c5-fixture-')),fonts=await FontCatalog.load();
  await mkdir(path.join(root,'model'));await mkdir(path.join(root,'deps'));
  const pin=async(name:string)=>{const file=path.join(root,name),bytes=Buffer.from('C5_SYNTHETIC_PIN_'+name);await writeFile(file,bytes);return {path:file,sha256:sha256(bytes),bytesLength:bytes.length};};
  const profile=validateMeasurementProfile({...measurement,version:'c5-owned-v1',state:'MEASURED',evidenceReferences:['c5-synthetic-only'],realProviderEnabled:true,
    limits:{maxFileBytes:16*1024*1024,maxPixelsPerPage:65536,maxFilesPerUpload:2,maxWorkspacePages:4,maxWorkspaceBytes:64*1024*1024,maxArchiveCompressedBytes:64*1024*1024,maxArchiveExpandedBytes:128*1024*1024,maxArchiveEntries:64,maxArchiveRatio:20,maxManifestBytes:262144,maxDecodeMemoryBytes:16*1024*1024,maxStageMilliseconds:30000,maxConcurrentImageStages:1,minReadableFontSizePx:12.5,maxRequestCostUsd:'0.2',maxDailyOperatorSpendUsd:'1'},
    mediaBounds:{maxWidth:256,maxHeight:256,maxTextLength:2048,maxFontSize:64,maxBlocks:16}});
  const media=measuredMediaProfile(profile),config:WorkerRuntimeConfig={version:1,kind:'worker',origin:'https://c5.example.invalid',secretRoot:path.join(root,'unused-secrets'),
    database:{loginRole:(await worker.pool.query<{name:string}>('SELECT session_user AS name')).rows[0].name,connectionStringSecret:'unused.txt'},fonts:{root:fonts.root,catalogVersion:fonts.catalog.version},profile,
    gates:{operationalEnabled:false,realProviderEnabled:true,paidExecutionEnabled:false,purchaseEnabled:false},host:{httpsProxyVerified:false,resourceIsolationVerified:false,evidenceReferences:[]},
    capabilities:{geminiExactModelVerified:false,thinkingMappingVerified:false,lamaRuntimeVerified:false,lamaWeightsLicenseVerified:false,fullCostVerified:false},
    r2:{accountId:'1'.repeat(32),bucket:'c5-owned-memory',enabled:false,credentialsSecret:'unused-r2.json',requestMilliseconds:1000},loop:{tickMilliseconds:100,maintenanceMilliseconds:1000,shutdownMilliseconds:1000},
    pipeline:{geminiApiKeySecret:'unused-gemini.txt',lamaCodeCommit,lamaWeightsSha256:'2'.repeat(64),lamaConfigSha256:'3'.repeat(64)}};
  const limits=operationalLimitFixture(now,{profileVersion:profile.version,mediaProfileDigest:digest(media)});
  const previousLimit=(await admin.pool.query('SELECT current_profile_id,state,halt_reason FROM manga_web.execution_limit_authority WHERE singleton')).rows[0];
  await admin.pool.query("SET ROLE trio_web_operator");
  try{await admin.pool.query("INSERT INTO manga_web.operational_limit_evidence(evidence_id,raw_bytes,sha256,reviewed_by,reviewed_at) VALUES($1,$2,$3,'c5-isolated',clock_timestamp())",[limits.profile.evidence.id,limits.rawBytes,sha256(limits.rawBytes)]);}finally{await admin.pool.query('RESET ROLE');}
  const limitProfileId=randomUUID();
  await admin.pool.query("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[limitProfileId,JSON.stringify(limits.profile),profile.version,1,'0.2','1','0.1',JSON.stringify(limits.profile.stages),JSON.stringify(limits.profile.fullBoundEvidenceRefs),limits.profile.window.kind,limits.profile.window.startAt,limits.profile.window.endAt]);
  await admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[limitProfileId]);
  cleanup.push(()=>admin.pool.query('UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state=$2,halt_reason=$3,revision=revision+1 WHERE singleton AND current_profile_id=$4',[previousLimit.current_profile_id,previousLimit.state,previousLimit.halt_reason,limitProfileId]));
  const controller=new fakeNative.Controller({profile:media}),key=generateKeyPairSync('ed25519'),capacityProfileId=randomUUID();
  const operatorLogin='trio_c5_operator_'+randomUUID().replaceAll('-',''),operatorPassword=randomBytes(24).toString('base64url');
  await admin.pool.query('CREATE ROLE "'+operatorLogin+'" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \''+operatorPassword+'\'');
  await admin.pool.query('GRANT trio_web_operator TO "'+operatorLogin+'"');
  const operatorUrl=new URL(admin.connectionString);operatorUrl.username=operatorLogin;operatorUrl.password=operatorPassword;
  const operatorClient=new pg.Client({connectionString:operatorUrl.toString()});await operatorClient.connect();cleanup.push(()=>operatorClient.end());await operatorClient.query('SET ROLE trio_web_operator');
  const operator=new NativeCapacityOperator(operatorClient,operatorLogin),terminations=new Map<string,{id:string;digest:string;value:import('../../packages/domain/src/native-jobs.js').NativeJobObservation}>();
  const observe=NativeJobStore.prototype.observe;vi.spyOn(NativeJobStore.prototype,'observe').mockImplementation(async function(this:NativeJobStore,id,value){const decision=await observe.call(this,id,value);if(value.event==='TERMINATION'&&decision.observationDigest)terminations.set(value.termination.jobId,{id,digest:decision.observationDigest,value:structuredClone(value)});return decision;});
  fakeNative.afterTermination=async job=>{
    const raw=terminations.get(job.jobId),reservation=(await new NativeCapacityStore(worker,seed.accountId).recover()).find(r=>r.jobId===job.jobId);
    if(!raw||!reservation?.adoptionId)throw Error('C5_ORIGINAL_TERMINATION_MISSING');
    const t=raw.value.termination,proof:NativeCapacityProof={version:1,kind:'OWNED_FIXTURE',accountId:seed.accountId,capacityReservationId:reservation.capacityReservationId,adoptionId:reservation.adoptionId,jobId:job.jobId,inputDigest:job.inputDigest,nativeProfileDigest:job.profileDigest,parentInstanceId:controller.parentInstanceId,controllerId:nativeProfile.controllerId,keyVersion:nativeProfile.keyVersion,environmentDigest:nativeProfile.environmentDigest,terminationObservationId:raw.id,terminationObservationDigest:raw.digest,goAttempted:t.goAttempted,startedComputation:t.startedComputation,operationJoined:true,directChildClosed:t.directChildClosed,subtreeTerminationConfirmed:false,terminationKind:'DIRECT_CHILD_ONLY'};
    const canonical=canonicalize(proof)!,confirmed=await operator.confirm({canonical,signature:sign(null,Buffer.from(canonical),key.privateKey).toString('base64')});
    await operator.release(seed.accountId,reservation.capacityReservationId,confirmed.proofId!);
  };
  const previousCapacity=(await admin.pool.query('SELECT current_profile_id,state FROM manga_web.native_capacity_authority WHERE singleton')).rows[0];
  const nativeProfile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'c5-owned-native-v1',maxSlots:32,nativeProfileDigest:digest(media),kernelDigest:controller.kernelImplementationDigest,controllerId:randomUUID(),keyVersion:'c5-key-v1',environmentDigest:sha256('c5-isolated'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:c5/native']};
  const nativeDigest=(await admin.pool.query<{profile_digest:string}>("INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest",[capacityProfileId,JSON.stringify(nativeProfile),nativeProfile.version,32,nativeProfile.nativeProfileDigest,nativeProfile.kernelDigest,nativeProfile.controllerId,nativeProfile.keyVersion,nativeProfile.environmentDigest,nativeProfile.publicKeySpki])).rows[0].profile_digest;
  const capacity:NativeCapacityConfiguration={reference:{kind:'OWNED_FIXTURE',profileId:capacityProfileId,profileDigest:nativeDigest,profileVersion:nativeProfile.version},profile:nativeProfile};
  await admin.pool.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[capacityProfileId]);
  cleanup.push(()=>admin.pool.query('UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state=$2,revision=revision+1 WHERE singleton AND current_profile_id=$3',[previousCapacity.current_profile_id,previousCapacity.state,capacityProfileId]));
  fakeNative.beforeComputation=async job=>{await control.beforeNative?.(job);};fakeNative.smallLayout=()=>control.smallLayout;
  fakeNative.onError=e=>errors.push({message:String(e),stack:(e as Error)?.stack});
  const scopes=new AsyncLocalStorage<Scope>(),groups=new Map<string,ParentGroup>();
  const group=(input:StageInput)=>{let value=groups.get(input.executionId);if(!value){value={executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),events:[],pending:0,returned:false,engineJoined:false,terminationId:'',closed:null};groups.set(input.executionId,value);}return value;};
  const event=(kind:string,quantity:number,detail:unknown)=>{const scope=scopes.getStore();if(!scope)throw Error('C5_EVENT_WITHOUT_CONSUMER_'+kind);const value:ParentEvent={id:randomUUID(),operationId:randomUUID(),phase:scope.phase,attemptId:scope.attemptId,targetId:scope.targetId,kind,executionId:scope.group.executionId,inputFingerprint:scope.group.inputFingerprint,quantity,detail:structuredClone(detail)};scope.group.events.push(value);return value;};
  fakeNative.observeFile=(name,key,value)=>{if(!scopes.getStore())throw Error('C5_RAW_WITHOUT_CONSUMER');event('STORAGE_FILE_'+name.toUpperCase(),1,{key,sha256:Buffer.isBuffer(value)?sha256(value):null,bytesLength:Buffer.isBuffer(value)?String(value.length):null,receipt:Buffer.isBuffer(value)?null:value});};
  fakeNative.observeNative=(job,phase)=>{const scope=scopes.getStore();if(!scope)throw Error('C5_NATIVE_WITHOUT_CONSUMER');if(phase==='ENTER')scope.group.pending++;else scope.group.pending--;event('NATIVE_'+phase,1,{job,source:scope.source});};
  fakeNative.observeSealed=(record,requested)=>{event('NATIVE_SEAL',1,{...record,requested,source:scopes.getStore()?.source});if(current&&currentTarget){const list=current.operations.get(currentTarget)!.native;if(!list.some(r=>r.candidate.candidateId===record.candidate.candidateId))list.push(structuredClone(record));}};
  const original=syntheticPng(),blobs=new Map<string,Buffer>(),receipts=new Map<string,ObjectReceipt>(),io:{eventId:string;kind:string;key:string;sha256:string;bytesLength:string}[]=[];
  let current:AttemptEvents|null=null,currentTarget:string|null=null;
  const objects:ObjectStore={bucket:config.r2.bucket,
    put:async(k,b)=>{const receipt:ObjectReceipt={key:k,sha256:sha256(b),bytesLength:String(b.length),completedAt:(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),completedAtPrecisionMilliseconds:1};blobs.set(k,Buffer.from(b));receipts.set(k,receipt);const observed=event('STORAGE_PUT',1,{...receipt});io.push({eventId:observed.id,kind:'PUT',key:k,sha256:receipt.sha256,bytesLength:receipt.bytesLength});return structuredClone(receipt);},
    receipt:async k=>{const receipt=structuredClone(receipts.get(k)??null);event('STORAGE_RECEIPT',1,{key:k,receipt});return receipt;},
    read:async k=>{const b=blobs.get(k);if(!b)throw Error('C5_OBJECT_MISSING');const observed=event('STORAGE_GET',1,{key:k,sha256:sha256(b),bytesLength:String(b.length)}),readEvent={eventId:observed.id,kind:'GET',key:k,sha256:sha256(b),bytesLength:String(b.length)};io.push(readEvent);if(current&&currentTarget){const operation=current.operations.get(currentTarget)!;const dep=current.attempt.targets.find(t=>t.checkpointId===currentTarget)?.assets.find(a=>a.objectKey===k);if(dep)operation.reads.set(dep.assetId,{eventId:readEvent.eventId,sha256:readEvent.sha256,bytesLength:readEvent.bytesLength});}return Buffer.from(b);},
    remove:async()=>{throw Error('C5_REMOVE_FORBIDDEN');}};
  const originalId=(await admin.pool.query<{id:string}>('SELECT original_asset_id AS id FROM manga_web.results WHERE account_id=$1',[seed.accountId])).rows[0].id;
  const data:EditData={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',blocks:[]};
  for(const [id,b,type] of [[originalId,original,'image/png'],...fonts.catalog.fonts.map(f=>[f.id,fonts.bytes.get(f.id)!,'font/otf'] as const),[fonts.catalog.license.id,fonts.bytes.get(fonts.catalog.license.id)!,'text/plain']] as const){
    const k=seed.accountId+'/'+id;blobs.set(k,Buffer.from(b));await admin.pool.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,verified_at,deletion_state,related_context_id,object_created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NOT_DUE',$10,$9) ON CONFLICT(account_id,asset_id) DO UPDATE SET bucket_ref=EXCLUDED.bucket_ref,object_key=EXCLUDED.object_key,sha256=EXCLUDED.sha256,bytes_length=EXCLUDED.bytes_length,verified_at=EXCLUDED.verified_at,object_created_at=EXCLUDED.object_created_at",[seed.accountId,id,id===originalId?'LIVE':'FONT',objects.bucket,k,sha256(b),String(b.length),type,now,seed.contextId]);
  }
  await admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE account_id=$1',[seed.accountId,JSON.stringify(data)]);
  await admin.pool.query('UPDATE manga_web.workspace_pages SET image_width=256,image_height=256 WHERE account_id=$1',[seed.accountId]);
  const ocrConfig:Extract<LocalOcrConfig,{version:2}>={version:2,ownedTempRoot:root,python:await pin('python.exe'),worker:await pin('worker.py'),detector:await pin('detector.onnx'),dependencyRoots:[path.join(root,'deps')],dependencyPins:[await pin('deps/module.py')],
    ocr:{directory:path.join(root,'model'),files:await Promise.all(['config.json','preprocessor_config.json','pytorch_model.bin','tokenizer_config.json','special_tokens_map.json','vocab.txt'].map(n=>pin('model/'+n)))},settings:{modelId:'c5-owned-text',contractVersion:'c5-owned-contract-v1'},maxRegions:16,timeoutMilliseconds:10000};
  const submissions:{kind:string;executionId:string}[]=[],joined=new Set<string>();
  const engine:LocalOcrEnginePort={invoke(input,request,onStarted){
    submissions.push({kind:'OCR',executionId:input.executionId});
    const reply=(async()=>{await onStarted(randomUUID());await control.beforeProvider?.(input);if(control.providerFailure==='OCR')throw Error('C5_OCR_FAILURE');const manifest=await saveOcr(request,ocrConfig);
      event('PROVIDER_RETURNED',1,{kind:'OCR',syntheticUsd:'0.006'});
      return {kind:'ACTUAL_LOCAL_OCR_PROCESS',started:true,reply:{version:1,kind:'REPLY',executionId:input.executionId,inputFingerprint:request.inputFingerprint,configDigest:request.configDigest,outcome:'SUCCESS',manifest,detectorCalls:1,recognitionCalls:1,reason:'C5_SYNTHETIC'},valid:true,callbackInvoked:true,callbackConfirmed:true,callbackPending:false,protocolClosed:true,pid:1,closeObserved:true,exitCode:0,signal:null,stdoutEof:true,stderrEof:true,inputClosed:true,timedOut:false,postPinsVerified:true,subtreeTermination:'UNCONFIRMED',rawStdoutBase64:'',rawStderrBase64:'',fullHostCostUsd:null,billingAuthority:false} satisfies LocalOcrProcessReceipt;})();
    const done=reply.then(()=>{joined.add(input.executionId);group(input).engineJoined=true;event('OCR_ENGINE_JOINED',1,{executionId:input.executionId});});return {reply,joined:done};
  }};
  const translations=new Map<string,Observation>(),translation:ProviderAdapter&{idle:()=>Promise<void>}={synthetic:false,async dispatch(input,onStarted,context){
    submissions.push({kind:'TRANSLATE',executionId:input.executionId});await onStarted(randomUUID());await control.beforeProvider?.(input);if(control.providerFailure==='TRANSLATE')throw Error('C5_TRANSLATION_FAILURE');if(control.providerReject===input.stage){const rejected=normalizeObservation(input,{evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:null,usageConfirmed:false,finishReason:'C5_DETERMINATE_TRANSLATION_FAILURE',providerRef:input.executionId,data:null});event('PROVIDER_RETURNED',1,{kind:'TRANSLATE',syntheticUsd:'0.006'});translations.set(input.executionId,rejected);group(input).engineJoined=true;joined.add(input.executionId);return rejected;}const m=await context!.native.prepareScopedMaterial(input,null,fonts,media);
    const proposal={items:m.plan.selectedRegionIds.map((id:string)=>({inputRegionId:id,targetText:'안녕하세요.'}))};
    const output=await context!.native.applyScopedProposal(input,proposal,m.plan,fonts,media);
    const result=normalizeObservation(input,{evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,finishReason:'C5_SYNTHETIC_TRANSLATION',providerRef:input.executionId,data:output});event('PROVIDER_RETURNED',1,{kind:'TRANSLATE',syntheticUsd:'0.006'});translations.set(input.executionId,result);joined.add(input.executionId);group(input).engineJoined=true;await control.beforeReturn?.(input);return structuredClone(result);
  },async lookup(id){return structuredClone(translations.get(id)??null);},async validateObservation(input,value){const copy=structuredClone(value);if(copy.stageOutput)copy.stageOutput.checkpointId=null;if(digest(copy)!==digest(translations.get(input.executionId)))throw Error('C5_TRANSLATION_ORIGINAL_CHANGED');},async idle(){}};
  const journal=new FullStageCostJournal(worker,{maxRecordBytes:262144,maxRecords:512,calculator}),catalog=(['OCR','TRANSLATE','CLEANUP','TYPESET'] as const).map(stage=>({stage,profileDigest:digest(media),snapshot:{version:1,state:'MEASURED',stage,profileDigest:digest(media),basisVersion:'c5-synthetic-prices-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['c5-synthetic-prices-only'],components:['IMAGE','RENDER','STORAGE'].map(kind=>({componentId:kind.toLowerCase(),kind,unit:'event',rateVersion:'c5-zero-price-v1',usdPerUnit:'0',evidenceRefs:['c5-synthetic-zero-rate']}))} as FullStageCostSnapshot}));
  const preparation=new LocalLaMaNativePreparation(worker,{maxRecordBytes:262144,maxRecords:128,maxInFlightBytes:1024*1024*1024,maxConcurrentReads:2,calculator},media,controller.kernelImplementationDigest);
  const gateway=new NativeDatabaseGateway(worker,controller as unknown as NativeController,objects,capacity,preparation);
  const checkpoints=new CheckpointValidationJournal(worker,checkpointBounds),attempts:AttemptEvents[]=[];
  const begin=checkpoints.beginIn.bind(checkpoints);vi.spyOn(checkpoints,'beginIn').mockImplementation(async(tx,input,purpose)=>{const attempt=await begin(tx,input,purpose);current=attempts.find(a=>a.attempt.attemptId===attempt.attemptId)??{attempt,consumer:structuredClone(input),operations:new Map()};if(!attempts.includes(current))attempts.push(current);
    if(control.rejectFinalOnce&&attempt.purpose==='FINAL_COMMIT'){control.rejectFinalOnce=false;const key=seed.accountId+'/'+originalId,corrupt=Buffer.from(blobs.get(key)!);corrupt[corrupt.length-1]^=1;blobs.set(key,corrupt);}
    return attempt;
  });
  const recordValidation=checkpoints.recordIn.bind(checkpoints);vi.spyOn(checkpoints,'recordIn').mockImplementation(async(...args)=>{const value=await recordValidation(...args),observed=attempts.find(a=>a.attempt.attemptId===args[2].attemptId);if(observed&&value.state==='VERIFIED')observed.verified=structuredClone(value);return value;});
  const validate=OperationalPipelineProvider.prototype.validateObservation;
  vi.spyOn(OperationalPipelineProvider.prototype,'validateObservation').mockImplementation(async function(this:OperationalPipelineProvider,input,value,context){
    const target=current?.attempt.targets.find(t=>t.sourceExecutionId===input.executionId&&t.outputDigest===digest(value));
    const prior=currentTarget;currentTarget=target?.checkpointId??null;
    const previous=target?current!.operations.get(target.checkpointId):undefined;if(previous?.semanticId)currentTarget=null;
    if(target&&!previous)current!.operations.set(target.checkpointId,{operationId:randomUUID(),semanticId:'',reads:new Map(),native:[],evidenceId:randomUUID(),wrapper:null});
    const owner=current?.consumer??input,scope:Scope={group:group(owner),phase:'VALIDATION',attemptId:target?current!.attempt.attemptId:null,targetId:target?.checkpointId??null,source:{executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),outputDigest:digest(value)}};
    try{await scopes.run(scope,async()=>{await validate.call(this,input,value,context);const observed=event('SEMANTIC_RETURNED',1,{sourceExecutionId:input.executionId,outputDigest:digest(value)});if(target&&!previous?.semanticId)current!.operations.get(target.checkpointId)!.semanticId=observed.id;});}finally{currentTarget=prior;}
  });
  for(const name of ['validateInput','dispatch','lookup'] as const){
    const originalMethod=OperationalPipelineProvider.prototype[name];
    vi.spyOn(OperationalPipelineProvider.prototype,name).mockImplementation((async function(this:OperationalPipelineProvider,...args:unknown[]){
      const input=(name==='lookup'?args[1]:args[0]) as StageInput;
      const value=group(input),scope:Scope={group:value,phase:name,attemptId:null,targetId:null,source:{executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),outputDigest:null}};
      value.pending++;try{return await scopes.run(scope,async()=>{
        const result=await (originalMethod as (...values:unknown[])=>Promise<unknown>).apply(this,args);
        if(name==='dispatch'){value.returned=true;value.terminationId=event('PIPELINE_RETURNED',1,{executionId:input.executionId,resultDigest:digest(result)}).id;}
        return result;
      });}finally{value.pending--;}
    }) as never);
  }
  const records=async(executionId?:string)=>(await admin.pool.query<EvidenceRow>('SELECT evidence_id,evidence_digest,kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND($2::uuid IS NULL OR execution_id=$2) ORDER BY received_at,evidence_id',[seed.accountId,executionId??null])).rows;
  const missing:{attemptId:string;targetCount:number;missingAssets:string[]}[]=[];
  const reader:OperationalStageCostReader={async checkpointFactsIn(tx,input,attempt){
    if(!current||current.attempt.attemptId!==attempt.attemptId)return null;
    const operations=[];for(const target of attempt.targets){
      const event=current.operations.get(target.checkpointId),absent=target.assets.filter(a=>!event?.reads.has(a.assetId)).map(a=>a.assetId);
      if(!event?.semanticId||absent.length){missing.push({attemptId:attempt.attemptId,targetCount:attempt.targets.length,missingAssets:absent});return null;}
      const value:CheckpointValidationOperation={version:1,operationId:event.operationId,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest,semantic:{eventId:event.semanticId,kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:target.assets.map(a=>({assetId:a.assetId,kind:'OBJECT_READ',outcome:'RETURNED',...event.reads.get(a.assetId)!})),native:event.native};
      if(control.checkpointFault==='semantic')Reflect.deleteProperty(value,'semantic');if(control.checkpointFault==='storage')value.storage.pop();if(control.checkpointFault==='native')value.native=[];
       if(control.checkpointFault==='final'&&attempt.purpose==='FINAL_COMMIT')return null;
       const proposed={version:1,accountId:input.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'CHECKPOINT_VALIDATION_OPERATION',value};
       event.wrapper??=structuredClone(proposed);if(digest(event.wrapper)!==digest(proposed))return null;const wrapper=event.wrapper as typeof proposed,id=event.evidenceId,hash=digest(wrapper);
      await tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT(account_id,evidence_id) DO NOTHING",[input.accountId,id,input.executionId,wrapper.kind,hash,tx.now,JSON.stringify(wrapper)]);const saved=(await tx.client.query<{evidence_digest:string}>('SELECT evidence_digest FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[input.accountId,id])).rows[0];if(saved?.evidence_digest!==hash)return null;operations.push({evidenceId:id,evidenceDigest:control.checkpointFault==='digest'?'f'.repeat(64):hash});
    }return {attemptId:attempt.attemptId,operations};
  },async workSetIn(tx,input,basis){await control.beforeCost?.(input);if(control.costUnknown||control.loseJournal)return null;const value=await workSet(tx,input,basis,groups,attempts);if(value&&control.allocationUnknown)value.facts.allocation={...value.facts.allocation!,state:'UNCONFIRMED',actualUsd:null};return value;}};
  const makeCost=()=>{const cost=new OperationalStageCost({db:worker,preparation:new FullStageCostPreparation(journal,catalog,calculator),journal,reader:{...reader},checkpoints,bounds:{maxRecordBytes:262144,maxRecords:512,maxSources:256,maxExecutions:32,maxInFlight:8}});
  const prepare=cost.prepare.bind(cost);vi.spyOn(cost,'prepare').mockImplementation(async(input,claim)=>{await prepare(input,claim);const value=group(input);if(!value.events.some(e=>e.kind==='ALLOCATION_DECIDED'))scopes.run({group:value,phase:'PREPARE',attemptId:null,targetId:null},()=>event('ALLOCATION_DECIDED',1,{syntheticUsd:'0.004',basisVersion:'c5-synthetic-prices-v1',mode:'FREE',funding:'FREE_OPERATIONS'}));});
  const finish=cost.finishAttempt.bind(cost);vi.spyOn(cost,'finishAttempt').mockImplementation(async input=>{
    const value=groups.get(input.executionId);
    if(value?.returned&&value.engineJoined&&value.pending===0&&!value.closed){
      const measurements=['IMAGE','RENDER','STORAGE'].map(kind=>{const members=value.events.filter(e=>kind==='STORAGE'?e.kind.startsWith('STORAGE_'):e.kind==='NATIVE_ENTER'&&(kind==='RENDER'?(e.detail as {job:NativeJob}).job.task==='RENDER_PAGE':(e.detail as {job:NativeJob}).job.task!=='RENDER_PAGE'));const measured=scopes.run({group:value,phase:'JOIN',attemptId:null,targetId:null},()=>event('MEASUREMENT_'+kind,members.reduce((n,e)=>n+e.quantity,0),{memberIds:members.map(e=>e.id),rateVersion:'c5-zero-price-v1'}));return {kind,operationId:measured.operationId,eventId:measured.id,memberIds:members.map(e=>e.id),quantity:measured.quantity};});
      value.closed={digest:digest(value.events),measurements};
    }
    return finish(input);
  });return cost;};let cost=makeCost();
  const coordinators=new Map<string,LocalLaMaInvocationCoordinator>(),lamaReplies=new Map<string,LocalLaMaExecutorReply>();
  const coordinator=async(value:LocalLaMaExecutionInput)=>{
    const capture=value.capture,prior=coordinators.get(capture.executionId);if(prior)return prior;
    const input=await worker.accountTransaction(seed.accountId,tx=>storedInput(tx,capture.executionId)),basis=(await journal.lookup(input)).basis;
    if(!basis)throw Error('C5_LAMA_BASIS_MISSING');
    const raw=(await records(capture.executionId)).find(r=>r.kind==='LAMA_PREPARATION_CAPTURE')?.protected_observation.value;
    if(!raw)throw Error('C5_LAMA_PREPARATION_MISSING');
    input.claimGeneration=raw.originalClaim!.generation;
    const binding:LocalLaMaInvocationBinding={version:1,accountId:seed.accountId,requestId:input.requestId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,mode:basis.capture.mode};
    const attemptRoot=path.join(root,'lama-'+input.executionId);await mkdir(attemptRoot);
    const stores=new LocalLaMaDomainAttemptStore({db:worker,root:attemptRoot,input,capture,fullStageCapture:basis.capture,claim:raw.originalClaim!,binding,preparation,
      bounds:{raw:{journal:{maxRecordBytes:262144,maxRecords:128,maxInFlightBytes:1024*1024*1024,maxConcurrentReads:2,calculator},maxRawBytes:16384,maxInFlightMetadataBytes:4*1024*1024*1024,maxInFlightRawBytes:64*1024*1024,maxPublications:2,maxAllocations:2,maxPendingPuts:2,maxIo:2,maxMetadataCalls:2},maxConcurrentCalls:2,maxOpenClaims:1,maxInFlightBytes:4*1024*1024*1024}});
    const ports=stores.capabilities();const attempts={...ports,append:async(...args:Parameters<typeof ports.append>)=>{try{await ports.append(...args);}catch(e){errors.push({message:String(e),stack:(e as Error)?.stack});throw e;}}};
    const instance=new LocalLaMaInvocationCoordinator({binding,capture,bounds:{maxEncodedBytes:16384,maxMetadataBytes:262144,maxInFlightBytes:128*1024*1024,maxConcurrentCalls:2,maxRecords:64},attempts,
      engine:{submit(query,onStarted){
        submissions.push({kind:'CLEANUP',executionId:input.executionId});
        const reply=(async()=>{const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:query.original.invocationId,executionId:input.executionId,inputDigest:input.inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)},start={version:1 as const,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime};await onStarted(start);
          const output:LocalLaMaExecutorReply={version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime,state:'SUCCEEDED',providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(value.image),byteLength:value.image.length,bytes:Buffer.from(value.image)}};lamaReplies.set(input.executionId,output);event('PROVIDER_RETURNED',1,{kind:'CLEANUP',syntheticUsd:'0.006'});return output;})();
        const done=reply.then(()=>{joined.add(input.executionId);group(input).engineJoined=true;event('LAMA_ENGINE_JOINED',1,{executionId:input.executionId});});return {reply,joined:done};
      },query(){return {reply:Promise.resolve(structuredClone(lamaReplies.get(input.executionId)??null)),joined:Promise.resolve()};}},costs:{lookup:async()=>null}});
    coordinators.set(input.executionId,instance);return instance;
  };
  const lama=new LocalLaMaAdapter({enabled:true,identity:{codeCommit:lamaCodeCommit,weightsSha256:config.pipeline.lamaWeightsSha256,configSha256:config.pipeline.lamaConfigSha256,weightsLicenseVerified:true,runtimeVerified:true},profile:media,executor:{async dispatch(value,onStarted){try{return await (await coordinator(value)).dispatch(value,onStarted);}catch(e){errors.push({message:String(e),stack:(e as Error)?.stack});throw e;}},async lookup(capture){return coordinators.get(capture.executionId)?.lookup(capture)??null;}},bounds:{maxCapturedExecutions:32,maxInFlightBytes:256*1024*1024}});
  const policy=await createOperationalRequestPolicy(worker,config,fonts,limits.identity),workspace=new WorkspaceService(api,policy),actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=async(operation:WorkspaceCommand['operation'])=>api.accountTransaction(seed.accountId,async tx=>{const c=await contextRow(tx,seed.contextId);return {commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:c.generation,tabId:seed.tabId,expectedOwnerRevision:c.owner_revision,expectedWorkspaceRevision:c.workspace_revision},operation} satisfies WorkspaceCommand;});
  const settings:Settings={settingsVersion:'1',...ocrConfig.settings,sourceLanguage:'ja',targetLanguage:'ko',reasoningLevel:'LOW',fontAssetId:fonts.catalog.fonts[0].id,baseFontSizePx:20,minFontSizePx:13};
  await workspace.handle(actor,await command({kind:'PATCH_SETTINGS',payload:{settings}}));
  const requestId=(await workspace.handle(actor,await command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}))).reply.operationRef.id!;
  const assemble=()=>createPreparedPipelineWorker({worker,objects,fonts,native:gateway,registration:{identity:limits.identity,sourceLanguage:'ja',targetLanguage:'ko',scope:'PAGE',modelId:settings.modelId,contractVersion:settings.contractVersion,reasoningLevels:['LOW']},ocr:{config:ocrConfig,engine},translation:{modelId:settings.modelId,adapter:translation},lama,cost,renderCost:{lookup:async input=>{const value=group(input);if(!value.engineJoined){event('PROVIDER_RETURNED',1,{kind:'TYPESET',syntheticUsd:'0.006'});value.engineJoined=true;joined.add(input.executionId);}return null;}},cleanupPreparation:preparation,bounds:{maxEncodedStageBytes:64*1024*1024,maxMetadataBytes:262144,maxInFlightBytes:300*1024*1024},evidenceBounds:{maxRecordBytes:262144,maxRecords:512}},config,limits.identity);
  let runtime=await assemble();const reassemble=async()=>{runtime.execution.stopClaims();await runtime.idle();cost=makeCost();runtime=await assemble();return runtime;};
  const request=async()=>(await admin.pool.query('SELECT state,hold_reasons,first_start_at FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[seed.accountId,requestId])).rows[0];
  const executions=async()=>(await admin.pool.query('SELECT execution_id,logical_step_id,state,output_envelope FROM manga_web.executions WHERE account_id=$1 ORDER BY execution_id',[seed.accountId])).rows;
  const advance=(ms=1000)=>{now=new Date(now.valueOf()+ms);};
  let closed=false;const readAfterClosure=async(input:StageInput)=>scopes.run({group:group(input),phase:'LATE_READ',attemptId:null,targetId:null},()=>objects.read(input.accountId+'/'+input.originalAssetId));
  const nativeProofIn=(tx:Transaction,input:StageInput)=>{const value=groups.get(input.executionId);return value?originalNativeProof(tx,input,value.events,attempts):Promise.resolve(false);};
  const shutdown=async()=>{runtime.stopClaims();await runtime.idle();await worker.close();};const close=async()=>{if(closed)return;runtime.stopClaims();await runtime.idle();await release();closed=true;};
  return {control,limits,capacity,limitProfileId,capacityProfileId,coordinators,admin,api,worker,seed,root,config,media,fonts,objects,blobs,original,originalId,io,submissions,joined,groups,errors,journal,cost,checkpoints,attempts,missing,reader,get runtime(){return runtime;},get currentCost(){return cost;},reassemble,shutdown,readAfterClosure,nativeProofIn,requestId,request,executions,records,advance,close,workspace,actor,command,controller};
  }catch(error){try{await release();}catch(cleanupError){throw new AggregateError([error,cleanupError],'C5_FIXTURE_SETUP_AND_CLEANUP_UNCONFIRMED');}throw error;}
}
async function workSet(tx:Transaction,input:StageInput,basis:FullStageCostBasis,groups:Map<string,ParentGroup>,attempts:AttemptEvents[]):Promise<OperationalStageCostWorkSet|null>{
  const group=groups.get(input.executionId);if(!group||!group.returned||!group.engineJoined||group.pending||!group.terminationId)return null;
  if(!await originalNativeProof(tx,input,group.events,attempts))return null;
  const rows=(await tx.client.query<EvidenceRow>("SELECT evidence_id,evidence_digest,kind,CASE WHEN octet_length(protected_observation::text)<=262144 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY evidence_id LIMIT 513",[input.accountId,input.executionId])).rows;
  if(rows.length>512||rows.some(r=>!r.protected_observation||digest(r.protected_observation)!==r.evidence_digest))return null;
  const outer=input.stage==='OCR'?'P01C_PIPELINE_V1_':'OPERATIONAL_';
  const usable=rows.filter(r=>((r.kind.startsWith(outer)&&['CANDIDATE','SOURCE','PLAN','HOLD_PLAN','OUTPUT'].includes(r.kind.slice(outer.length)))||r.kind.startsWith('LOCAL_OCR_V1_')||r.kind.startsWith('CHECKPOINT_VALIDATION_')||r.kind.startsWith('LAMA_'))&&r.protected_observation&&digest(r.protected_observation)===r.evidence_digest);
  const one=(kind:string,phase?:string)=>usable.find(r=>r.kind===kind&&(!phase||r.protected_observation.value?.phase===phase));
  const pre=usable.filter(r=>r.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&(r.protected_observation.value as unknown as CheckpointValidationAttempt).purpose==='PRE_DISPATCH');if(pre.length!==1)return null;const preAttempt=pre[0].protected_observation.value as unknown as CheckpointValidationAttempt;
  const termination=one(outer+'OUTPUT'),provider=one(outer+'SOURCE',input.stage==='CLEANUP'?'LAMA_OUTCOME':input.stage==='TYPESET'?'RENDER_OUTCOME':'PROVIDER'),candidate=one(outer+'CANDIDATE'),plan=one(outer+'PLAN')??one(outer+'HOLD_PLAN'),allocation=usable.find(r=>r.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&(r.protected_observation.value as unknown as {attemptId:string;attemptDigest:string}).attemptId===preAttempt.attemptId&&(r.protected_observation.value as unknown as {attemptDigest:string}).attemptDigest===preAttempt.attemptDigest),storage=one(outer+'SOURCE',input.stage==='CLEANUP'?'LAMA_START':input.stage==='TYPESET'?'RENDER_START':'PROVIDER_START');
  if(!termination||!provider||!candidate||!plan||!allocation||!storage)return null;
  const engine=group.events.filter(e=>e.kind==='PROVIDER_RETURNED');if(engine.length!==1||group.events.filter(e=>e.kind==='NATIVE_ENTER').length!==group.events.filter(e=>e.kind==='NATIVE_TERMINATED').length)return null;
  const evidence=usable.filter(r=>r.evidence_id!==termination.evidence_id),ref=(r:EvidenceRow)=>({evidenceId:r.evidence_id,evidenceDigest:r.evidence_digest});
  if(!group.closed||group.closed.digest!==digest(group.events))return null;
  const allocations=group.events.filter(e=>e.kind==='ALLOCATION_DECIDED');if(allocations.length!==1)return null;
  const origins=[engine[0],...group.closed.measurements.map(m=>group.events.find(e=>e.id===m.eventId)!),allocations[0]];if(origins.some(e=>!e))return null;
  const quantities=['IMAGE','RENDER','STORAGE'].map(kind=>group.events.filter(e=>kind==='STORAGE'?e.kind.startsWith('STORAGE_'):e.kind==='NATIVE_ENTER'&&(kind==='RENDER'?(e.detail as {job:NativeJob}).job.task==='RENDER_PAGE':(e.detail as {job:NativeJob}).job.task!=='RENDER_PAGE')).reduce((n,e)=>n+e.quantity,0));
  if(group.closed.measurements.some((m,i)=>m.quantity!==quantities[i]||digest(m.memberIds)!==digest(group.events.filter(e=>m.kind==='STORAGE'?e.kind.startsWith('STORAGE_'):e.kind==='NATIVE_ENTER'&&(m.kind==='RENDER'?(e.detail as {job:NativeJob}).job.task==='RENDER_PAGE':(e.detail as {job:NativeJob}).job.task!=='RENDER_PAGE')).map(e=>e.id))))return null;
  const pointers=[provider,candidate,plan,storage,allocation],targets=['PROVIDER','QUANTITY','QUANTITY','QUANTITY','ALLOCATION'] as const,components=[null,'image','render','storage',null];
  const sources=targets.map((target,i)=>({sourceOperationId:origins[i].operationId,sourceEventId:origins[i].id,target,componentId:components[i],evidence:[ref(pointers[i])]}));
  return {version:1,executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:evidence.map(ref),terminationEvidence:[ref(termination)],sources,facts:{provider:{scope:'ACTUAL_AI_USD',captureDigest:basis.captureDigest,state:'CONFIRMED',actualUsd:(engine[0].detail as {syntheticUsd:string}).syntheticUsd,evidenceRefs:[provider.evidence_id]},quantities:['image','render','storage'].map((componentId,i)=>({componentId,captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:String(quantities[i]),unit:'event',evidenceRefs:[pointers[i+1].evidence_id]})),allocation:{captureDigest:basis.captureDigest,mode:'FREE',funding:'FREE_OPERATIONS',basisVersion:basis.snapshot!.basisVersion,state:'CONFIRMED',actualUsd:(allocations[0].detail as {syntheticUsd:string}).syntheticUsd,evidenceRefs:[allocation.evidence_id]}}};
}
async function saveOcr(r:LocalOcrRequest,c:Extract<LocalOcrConfig,{version:2}>){
  const save=async(name:string,value:unknown)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),p=path.join(r.outputDirectory,name);await writeFile(p,b,{flag:'wx'});return {path:p,sha256:sha256(b),bytesLength:b.length};};
  const box=[32,32,224,128],cropBox=[29,29,227,131],source={...r.source,file:r.source.path};
  const detector=await save('detector.json',{page:r.source.page,source,modelSha256:c.detector.sha256,blocks:[{id:'ctd-00',box,confidence:null}],filtering:{invalidGeometry:[],regionsTruncated:0},humanGroundTruth:false,qualityPass:false});
  const crop=await save('crop.png',syntheticPng(198,102));
  const record=await save('record.json',{modelSha256:c.ocr.files.find(p=>p.path.endsWith('pytorch_model.bin'))!.sha256,page:r.source.page,id:'ctd-00',sourceSha256:r.source.sha256,detectorSha256:detector.sha256,detectorBox:box,cropBox,cropSha256:crop.sha256,readingOrder:0,orientation:'HORIZONTAL',readingOrderAuthority:'DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL',humanGroundTruth:false,qualityPass:false,text:'\u3053\u3093\u306b\u3061\u306f',raw:'\u3053\u3093\u306b\u3061\u306f',status:'AI_PROPOSED',emptyText:false,atTokenLimit:false});
  const placements=await save('placements.json',{version:2,algorithm:'BOX_TOP_THEN_RIGHT_V1',authority:'DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL',source:r.source,detectorSha256:detector.sha256,placements:[{id:'ctd-00',box,readingOrder:0,orientation:'HORIZONTAL'}],reviewSignals:['NAIVE_BOX_ORDER_NO_PANEL_ANALYSIS'],humanGroundTruth:false,qualityPass:false});
  const masks=[await save('mask.png',syntheticPng()),await save('mask-radius1.png',syntheticPng())];
  return save('manifest.json',{version:2,executionId:r.executionId,inputFingerprint:r.inputFingerprint,configDigest:r.configDigest,source:r.source,page:r.source.page,detector,recognitions:[{record,crop}],masks,orderedPlacements:placements,outputs:[detector,record,crop,...masks,placements],detectorCalls:1,recognitionCalls:1,humanGroundTruth:false,qualityPass:false});
}

async function originalNativeProof(tx:Transaction,consumer:StageInput,events:ParentEvent[],attempts:AttemptEvents[]):Promise<boolean>{
  const fingerprint=digest(canonicalInput(consumer)),native=events.filter(e=>e.kind.startsWith('NATIVE_'));
  if(tx.account.account_id!==consumer.accountId||native.some(e=>e.executionId!==consumer.executionId||e.inputFingerprint!==fingerprint)||new Set(native.map(e=>e.id)).size!==native.length)return false;
  const sources=new Map<string,{input:StageInput;ref:NativeSourceInputRef;fingerprint:string}|null>();
  const sourceIn=async(executionId:string)=>{
    if(sources.has(executionId))return sources.get(executionId)!;
    const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_evidence_ref:string}>("SELECT evidence_id,evidence_digest,protected_evidence_ref FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT' LIMIT 2",[consumer.accountId,executionId])).rows;
    if(rows.length!==1||rows[0].protected_evidence_ref!==rows[0].evidence_id){sources.set(executionId,null);return null;}
    const input=await storedInput(tx,executionId),hash=digest(canonicalInput(input));
    const value=input.accountId===consumer.accountId&&input.executionId===executionId&&rows[0].evidence_digest===hash?{input,ref:{executionId,inputEvidenceId:rows[0].evidence_id,stageInputDigest:input.inputDigest},fingerprint:hash}:null;sources.set(executionId,value);return value;
  };
  const own=await sourceIn(consumer.executionId);if(!own||own.fingerprint!==fingerprint)return false;
  const validations=attempts.filter(a=>a.consumer.executionId===consumer.executionId);
  const proofRows=(await tx.client.query<EvidenceRow&{protected_evidence_ref:string}>("SELECT evidence_id,evidence_digest,protected_evidence_ref,kind,CASE WHEN octet_length(protected_observation::text)<=262144 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind LIKE 'CHECKPOINT_VALIDATION_%' ORDER BY evidence_id LIMIT 513",[consumer.accountId,consumer.executionId])).rows;
  if(proofRows.length>512||!validations.length||proofRows.filter(r=>r.kind==='CHECKPOINT_VALIDATION_ATTEMPT').length!==validations.length)return false;
  for(const row of proofRows){const wrapper=row.protected_observation as {version?:number;accountId?:string;executionId?:string;inputDigest?:string;inputFingerprint?:string;kind?:string;value?:unknown}|null;if(!wrapper||row.protected_evidence_ref!==row.evidence_id||digest(wrapper)!==row.evidence_digest||wrapper.version!==1||wrapper.accountId!==consumer.accountId||wrapper.executionId!==consumer.executionId||wrapper.inputDigest!==consumer.inputDigest||wrapper.inputFingerprint!==fingerprint||wrapper.kind!==row.kind)return false;}
  const sameScope=(a:ParentEvent,b:ParentEvent)=>a.phase===b.phase&&a.attemptId===b.attemptId&&a.targetId===b.targetId;
  const sealed=native.filter(e=>e.kind==='NATIVE_SEAL'),enters=native.filter(e=>e.kind==='NATIVE_ENTER'),terminated=native.filter(e=>e.kind==='NATIVE_TERMINATED');
  const original=(value:NativeSealObservation):NativeSealedReceipt=>({candidate:value.candidate,receipt:value.receipt,intent:value.intent,termination:value.termination,origin:value.origin});
  const scopeIn=async(event:ParentEvent,source:NativeSourceObservation|undefined)=>{
    if(!source)return null;const known=await sourceIn(source.executionId);if(!known||source.inputFingerprint!==known.fingerprint)return null;
    if(event.attemptId!==null||event.targetId!==null){
      const observed=validations.find(a=>a.attempt.attemptId===event.attemptId),target=observed?.attempt.targets.find(t=>t.checkpointId===event.targetId);
      if(event.phase!=='VALIDATION'||!observed||!target||source.executionId!==target.sourceExecutionId||source.inputFingerprint!==target.inputFingerprint||source.outputDigest!==target.outputDigest||digest(known.ref)!==digest({executionId:target.sourceExecutionId,inputEvidenceId:target.input.evidenceId,stageInputDigest:target.inputDigest})||target.input.evidenceDigest!==known.fingerprint)return null;
      return {known,observed,targetKind:'REQUEST_CHECKPOINT',targetId:consumer.requestId,semantic:digest({version:1,phase:'CHECKPOINT',currentRequestId:consumer.requestId,originExecutionId:source.executionId,inputFingerprint:source.inputFingerprint,outputDigest:source.outputDigest})};
    }
    const phase=({validateInput:'INPUT',dispatch:'DISPATCH',lookup:'LOOKUP',VALIDATION:'VALIDATION'} as Record<string,string>)[event.phase];
    if(!phase||source.executionId!==consumer.executionId||source.inputFingerprint!==fingerprint||(phase==='VALIDATION'?source.outputDigest===null:source.outputDigest!==null))return null;
    return {known,observed:null,targetKind:'EXECUTION',targetId:consumer.executionId,semantic:digest({version:1,phase,currentRequestId:consumer.requestId,originExecutionId:source.executionId,inputFingerprint:source.inputFingerprint,outputDigest:source.outputDigest})};
  };
  for(const observed of validations){
    const attempt=observed.attempt,view=observed.verified;if(!view||view.state!=='VERIFIED'||digest(view.attempt)!==digest(attempt)||digest(canonicalInput(observed.consumer))!==fingerprint||attempt.consumerExecutionId!==consumer.executionId||attempt.consumerRequestId!==consumer.requestId||attempt.inputFingerprint!==fingerprint||attempt.inputEvidenceId!==own.ref.inputEvidenceId||attempt.inputEvidenceDigest!==fingerprint)return false;
    const begins=proofRows.filter(r=>r.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&digest(r.protected_observation.value)===digest(attempt)),dones=proofRows.filter(r=>r.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&(r.protected_observation.value as unknown as {attemptId:string}).attemptId===attempt.attemptId);
    if(begins.length!==1||dones.length!==1)return false;const refs:{evidenceId:string;evidenceDigest:string}[]=[],jobIds:string[]=[];
    for(const target of attempt.targets){
      const operation=observed.operations.get(target.checkpointId);if(!operation?.wrapper)return false;
      const rows=proofRows.filter(r=>r.evidence_id===operation.evidenceId&&r.kind==='CHECKPOINT_VALIDATION_OPERATION'&&r.evidence_digest===digest(operation.wrapper));if(rows.length!==1)return false;refs.push({evidenceId:rows[0].evidence_id,evidenceDigest:rows[0].evidence_digest});
      const value=rows[0].protected_observation.value as unknown as CheckpointValidationOperation;if(value.attemptId!==attempt.attemptId||value.attemptDigest!==attempt.attemptDigest||value.targetDigest!==digest(target)||value.sourceInputFingerprint!==target.inputFingerprint||value.outputDigest!==target.outputDigest||value.semantic.eventId!==operation.semanticId||digest(value.native)!==digest(operation.native))return false;
      const receipts=sealed.filter(e=>e.attemptId===attempt.attemptId&&e.targetId===target.checkpointId);if(value.native.some(r=>!receipts.some(e=>digest(original(e.detail as NativeSealObservation))===digest(r))))return false;
      jobIds.push(...value.native.map(r=>r.intent.jobId));
      const semantic=digest({version:1,phase:'CHECKPOINT',currentRequestId:consumer.requestId,originExecutionId:target.sourceExecutionId,inputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest});
      const actual=(await tx.client.query<{job_id:string}>("SELECT job_id FROM native_job_intents WHERE account_id=$1 AND target_kind='REQUEST_CHECKPOINT' AND target_id=$2 AND semantic_capture_digest=$3 ORDER BY job_id LIMIT 129",[consumer.accountId,consumer.requestId,semantic])).rows;
      if(actual.length>128||actual.some(r=>!value.native.some(n=>n.intent.jobId===r.job_id)||!receipts.some(e=>(e.detail as NativeSealObservation).intent.jobId===r.job_id)))return false;
    }
    const done=dones[0].protected_observation.value as unknown as {attemptDigest:string;facts:unknown};if(done.attemptDigest!==attempt.attemptDigest||digest(done.facts)!==digest({attemptId:attempt.attemptId,operations:refs})||digest([...new Set(jobIds)].sort())!==digest([...view.jobIds].sort())||digest([...view.evidenceIds].sort())!==digest([begins[0].evidence_id,...refs.map(r=>r.evidenceId),dones[0].evidence_id].sort()))return false;
  }
  const expected=(await tx.client.query<{job_id:string}>("SELECT job_id FROM native_job_intents WHERE account_id=$1 AND target_kind='EXECUTION' AND target_id=$2 ORDER BY job_id LIMIT 129",[consumer.accountId,consumer.executionId])).rows;
  if(expected.length>128||new Set(enters.map(e=>(e.detail as {job:NativeJob}).job.jobId)).size!==enters.length||expected.some(r=>!enters.some(e=>(e.detail as {job:NativeJob}).job.jobId===r.job_id)))return false;
  for(const entered of enters){
    const detail=entered.detail as {job:NativeJob;source:NativeSourceObservation};if(!await scopeIn(entered,detail.source))return false;
    const seals=sealed.filter(e=>sameScope(e,entered)&&(e.detail as NativeSealObservation).origin==='FRESH'&&(e.detail as NativeSealObservation).intent.jobId===detail.job.jobId),ends=terminated.filter(e=>sameScope(e,entered)&&digest(e.detail)===digest(detail));
    if(!seals.length||ends.length!==1||events.indexOf(ends[0])<events.indexOf(entered))return false;
    const {inputDigest:_inputDigest,...raw}=detail.job;if(seals.some(e=>(e.detail as NativeSealObservation).candidate.inputCanonical!==canonicalize(raw)||(e.detail as NativeSealObservation).intent.inputDigest!==detail.job.inputDigest||events.indexOf(e)<events.indexOf(entered)))return false;
  }
  if(terminated.length!==enters.length)return false;
  const candidates=new Map<string,string>();
  for(const event of sealed){
    const observation=event.detail as NativeSealObservation,{requested}=observation,binding=await scopeIn(event,observation.source);if(!binding||!requested)return false;
    const value=original(observation),c=value.candidate,i=value.intent,r=value.receipt,target=requested.target,body=digest({...value,origin:null}),prior=candidates.get(c.candidateId);if(prior&&prior!==body)return false;candidates.set(c.candidateId,body);
    if(!['FRESH','CACHE'].includes(value.origin)||target.accountId!==consumer.accountId||target.targetKind!==binding.targetKind||target.targetId!==binding.targetId||target.semanticCaptureDigest!==binding.semantic||digest(target.sourceInput)!==digest(binding.known.ref)||target.protectedOwnerCapture.contextId!==binding.known.input.contextId||target.protectedOwnerCapture.contextGeneration!==binding.known.input.envelope!.contextGeneration||binding.observed&&digest(target.protectedOwnerCapture)!==digest(binding.observed.attempt.owner))return false;
    if(requested.task!==i.task||requested.taskVersion!==i.taskVersion||requested.profileDigest!==i.profileDigest||requested.operationInputDigest!==i.operationInputDigest||c.operationInputDigest!==requested.operationInputDigest||c.jobId!==i.jobId||c.parentInstanceId!==i.parentInstanceId)return false;
    if(value.origin==='FRESH'&&(i.targetKind!==target.targetKind||i.targetId!==target.targetId||i.semanticCaptureDigest!==target.semanticCaptureDigest||digest(i.protectedOwnerCapture)!==digest(target.protectedOwnerCapture)||digest(i.claim)!==digest(target.claim)||binding.observed&&i.claim.generation!==binding.observed.attempt.claimGeneration||!enters.some(e=>sameScope(e,event)&&(e.detail as {job:NativeJob}).job.jobId===i.jobId)))return false;
    const rows=(await tx.client.query<{source_execution_id:string;source_input_evidence_id:string;input_fingerprint:string;input_digest:string}>(
      "SELECT n.source_execution_id,n.source_input_evidence_id,z.evidence_digest AS input_fingerprint,z.protected_observation->>'inputDigest' AS input_digest FROM native_result_candidates c JOIN native_result_receipts r USING(account_id,candidate_id) JOIN native_job_intents i ON i.account_id=c.account_id AND i.job_id=c.job_id JOIN native_capacity_reservations n ON n.account_id=i.account_id AND n.job_id=i.job_id JOIN execution_evidence z ON z.account_id=n.account_id AND z.evidence_id=n.source_input_evidence_id AND z.execution_id=n.source_execution_id AND z.kind='INPUT' AND z.protected_evidence_ref=z.evidence_id::text JOIN native_job_observations o ON o.account_id=i.account_id AND o.job_id=i.job_id AND o.observation_id=$10 WHERE c.account_id=$1 AND c.candidate_id=$2 AND c.job_id=$3 AND c.candidate_digest=encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex') AND r.receipt_digest=encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex') AND i.protected_intent=$6::jsonb AND o.event='RESULT' AND o.parent_instance_id=i.parent_instance_id AND o.observation_digest=$7 AND o.protected_observation->>'code'='OK' AND o.protected_observation->>'resultDigest'=$8 AND EXISTS(SELECT 1 FROM native_job_go_consumptions g WHERE g.account_id=i.account_id AND g.job_id=i.job_id AND g.parent_instance_id=i.parent_instance_id) AND EXISTS(SELECT 1 FROM native_job_observations t WHERE t.account_id=i.account_id AND t.job_id=i.job_id AND t.parent_instance_id=i.parent_instance_id AND t.event='TERMINATION' AND t.protected_observation->>'code'='OK' AND (t.protected_observation->'termination')-'isolation'=$9::jsonb) AND NOT EXISTS(SELECT 1 FROM native_job_observations e WHERE e.account_id=i.account_id AND e.job_id=i.job_id AND e.event='ERROR') LIMIT 2",
      [tx.account.account_id,c.candidateId,c.jobId,JSON.stringify(c),JSON.stringify(r),JSON.stringify(i),c.resultObservationDigest,c.resultDigest,JSON.stringify(value.termination),c.resultObservationId])).rows;
    if(rows.length!==1)return false;const source=await sourceIn(rows[0].source_execution_id);if(!source||rows[0].source_input_evidence_id!==source.ref.inputEvidenceId||rows[0].input_fingerprint!==source.fingerprint||rows[0].input_digest!==source.input.inputDigest||i.targetKind==='EXECUTION'&&i.targetId!==source.input.executionId)return false;
    if(value.origin==='FRESH'&&digest(source.ref)!==digest(binding.known.ref))return false;
    const raw=JSON.parse(c.inputCanonical) as Omit<NativeJob,'inputDigest'>;if(sha256(c.inputCanonical)!==i.inputDigest||nativeOperationInputDigest({...raw,inputDigest:i.inputDigest})!==requested.operationInputDigest)return false;
  }
  return true;
}
