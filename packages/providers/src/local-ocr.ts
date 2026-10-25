import {createReadStream} from 'node:fs';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,relative,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {digest,sha256} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {NativeJobError,nativeJsonBytes} from '../../native/src/dto.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {canonicalInput,normalizeObservation,type StageInput,type Observation,type ProviderAdapter,type ProviderCallContext} from '../../domain/src/provider.js';
import type {Assets} from '../../domain/src/assets.js';
import type {PipelineEvidence} from '../../domain/src/pipeline-evidence.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {convertSavedLocalOcrProposal,type LocalOcrProposalInput} from './local-ocr-proposal.js';
import type {FilePin} from './local-translation.js';
import {LocalOcrProcessExecutor,type LocalOcrEnginePort,type LocalOcrRequest as OcrRequest,type LocalOcrReply as Reply} from './local-ocr-executor.js';

type Region={id:string;box:[number,number,number,number];readingOrder:number;orientation:'HORIZONTAL'|'VERTICAL'};
type OcrSource={sha256:string;width:number;height:number;page:string};
type RequestSource=OcrSource&{path:string;pageLineageId?:string;originalAssetId?:string;bytesLength?:string};
export type LocalOcrConfig={
  ownedTempRoot:string;python:FilePin;worker:FilePin;dependencyRoots:string[];dependencyPins:FilePin[];
  detector:FilePin;ocr:{directory:string;files:FilePin[]};
  settings:{modelId:string;contractVersion:string};maxRegions:number;timeoutMilliseconds:number;
}&({version:1;source:OcrSource;expectedRegions:Region[]}|{version:2});
export const localOcrJournalBounds={maxRecordBytes:20*1024*1024,maxRecords:16} as const;
const rawBytesLimit=14*1024*1024;
type Pin={path:string;sha256:string;bytesLength?:number};
type Event={version:1;adapter:'LOCAL_CTD_MANGA_OCR';configDigest:string;phase:'CAPTURE'|'START'|'RAW'|'RESULT';value:unknown};
type Journal=Pick<PipelineEvidence,'candidate'|'existingCandidate'|'record'|'records'>;
type Capture={kind:'ACTUAL_LOCAL_OCR';request:OcrRequest;requestDigest:string;config:LocalOcrConfig;materialPlan:unknown};
const hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function must(value:unknown,code:string):asserts value {if(!value)throw Error(code);}
function under(root:string,file:string):boolean {const r=relative(root,file);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);}
function requestSource(input:StageInput,config:LocalOcrConfig):Omit<RequestSource,'path'>{
  if(config.version===1)return structuredClone(config.source);
  const source=input.assetDependencies!.find(asset=>asset.assetId===input.originalAssetId)!;
  return {sha256:source.sha256,width:input.width,height:input.height,page:input.envelope!.pageLineageId,
    pageLineageId:input.envelope!.pageLineageId,originalAssetId:input.originalAssetId,bytesLength:source.bytesLength};
}
async function pinFile(pin:Pin,maximum=1024*1024*1024):Promise<void>{
  must(isAbsolute(pin.path)&&hash.test(pin.sha256),'LOCAL_OCR_PIN_INVALID');
  const info=await lstat(pin.path);must(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=maximum&&(pin.bytesLength===undefined||info.size===pin.bytesLength),'LOCAL_OCR_PIN_INVALID');
  const h=createHash('sha256');for await(const chunk of createReadStream(pin.path))h.update(chunk);must(h.digest('hex')===pin.sha256,'LOCAL_OCR_PIN_INVALID');
}
function observation(input:StageInput,outcome:Observation['outcome'],started:boolean|null,reason:string):Observation{
  return {evidenceId:randomUUID(),outcome,started,costUsd:null,usageConfirmed:false,finishReason:reason,providerRef:input.executionId,data:null};
}
// A bounded, actual local implementation. It does not infer balloon layout,
// approve masks, discard empty OCR, or claim a confirmed full-stage cost.
// Existing PipelineEvidence owns durable claims and receipts; lookup never runs
// inference or native apply. An interrupted original remains unknown.
export class LocalOcrAdapter implements ProviderAdapter{
  readonly synthetic=false;
  private readonly config:LocalOcrConfig;
  private readonly configDigest:string;
  private readonly engine:LocalOcrEnginePort;
  private readonly pendingJoins=new Set<Promise<void>>();
  private joinFailure:{reason:unknown}|null=null;
  private draining:Promise<void>|null=null;
  private trackJoined(operation:Promise<unknown>):void{
    const pending=operation.then(()=>{this.pendingJoins.delete(pending);},reason=>{this.joinFailure??={reason};this.pendingJoins.delete(pending);});
    this.pendingJoins.add(pending);
  }
  idle():Promise<void>{
    if(this.draining)return this.draining;
    if(!this.pendingJoins.size)return this.joinFailure?Promise.reject(this.joinFailure.reason):Promise.resolve();
    this.draining=(async()=>{
      try{
        while(this.pendingJoins.size)await Promise.all([...this.pendingJoins]);
        if(this.joinFailure)throw this.joinFailure.reason;
      }finally{this.draining=null;}
    })();
    return this.draining;
  }
  constructor(config:LocalOcrConfig,private readonly options:{assets:Pick<Assets,'bytes'>;journal:Journal;fonts:FontCatalog;profile:MediaProfile;engine?:LocalOcrEnginePort}){
    this.config=structuredClone(config);this.configDigest=digest(this.config);
    const engine=options.engine??new LocalOcrProcessExecutor(this.config,{recordStart:(input,value)=>this.record(input,'START',value),verifyConfig:()=>this.verifyConfig()});
    this.engine={invoke:engine.invoke.bind(engine)};
  }
  private checkIdentity(input:StageInput):void{
    const e=input.envelope;
    must(input.stage==='OCR'&&input.scope.kind==='PAGE'&&input.settings.sourceLanguage==='ja'&&e,'LOCAL_OCR_UNSUPPORTED_INPUT');
    assertWire('stageInputEnvelope',e);
    must(input.accountId&&input.contextId&&uuid.test(input.executionId)&&hash.test(input.inputDigest)&&e.executionId===input.executionId&&e.requestId===input.requestId&&e.contextId===input.contextId&&e.inputDigest===input.inputDigest&&e.logicalStepId==='OCR'&&e.stageContract===input.settings.contractVersion&&digest(e.capturedSettings)===digest(input.settings),'LOCAL_OCR_INPUT_EVIDENCE_INVALID');
    // This first actual connection admits an empty page only, never overwrites
    // existing user text or uses an old detector order on another page.
    must(input.initialData.blocks.length===0&&(input.previousData===null||input.previousData.blocks.length===0)&&e.regionIds.length===0,'LOCAL_OCR_EMPTY_PAGE_REQUIRED');
    const sources=input.assetDependencies?.filter(a=>a.assetId===input.originalAssetId);
    must(uuid.test(input.originalAssetId)&&sources?.length===1&&hash.test(sources[0].sha256)&&/^[1-9][0-9]*$/.test(sources[0].bytesLength)&&
      Number.isSafeInteger(Number(sources[0].bytesLength))&&Number(sources[0].bytesLength)<=32*1024*1024&&e.assetIds.includes(input.originalAssetId)&&
      Number.isSafeInteger(input.width)&&input.width>0&&input.width<=8192&&Number.isSafeInteger(input.height)&&input.height>0&&input.height<=8192&&input.width*input.height<=16*1024*1024,'LOCAL_OCR_SOURCE_MISMATCH');
  }
  private check(input:StageInput,config=this.config,checkProfile=true):void{
    this.checkIdentity(input);
    must(input.settings.modelId===config.settings.modelId&&input.settings.contractVersion===config.settings.contractVersion&&
      (!checkProfile||input.envelope!.parameterProfileVersion===this.options.profile.id),'LOCAL_OCR_SETTINGS_MISMATCH');
    if(config.version===1){const source=input.assetDependencies!.find(a=>a.assetId===input.originalAssetId)!;
      must(source.sha256===config.source.sha256&&input.width===config.source.width&&input.height===config.source.height,'LOCAL_OCR_SOURCE_MISMATCH');}
  }
  async validateInput(input:StageInput):Promise<void>{
    this.checkIdentity(input);
    if(await this.options.journal.existingCandidate(input)){await this.events(input);return;}
    this.check(input);await this.verifyConfig();
  }
  private async verifyConfig():Promise<void>{
    const c=this.config;
    must((c.version===1||c.version===2)&&isAbsolute(c.ownedTempRoot)&&Number.isSafeInteger(c.maxRegions)&&c.maxRegions>0&&c.maxRegions<=20&&Number.isSafeInteger(c.timeoutMilliseconds)&&c.timeoutMilliseconds>0&&c.timeoutMilliseconds<=600000,'LOCAL_OCR_CONFIG_INVALID');
    if(c.version===1)must(hash.test(c.source.sha256)&&c.expectedRegions.length>0&&c.expectedRegions.length<=c.maxRegions,'LOCAL_OCR_CONFIG_INVALID');
    else must(!Object.hasOwn(c,'source')&&!Object.hasOwn(c,'expectedRegions'),'LOCAL_OCR_CONFIG_INVALID');
    const root=await realpath(c.ownedTempRoot),temp=await realpath(tmpdir());
    must(under(temp,root),'LOCAL_OCR_TEMP_REQUIRED');
    must(c.dependencyRoots.length>0&&c.dependencyPins.length>0,'LOCAL_OCR_DEPENDENCIES_REQUIRED');
    const roots=await Promise.all(c.dependencyRoots.map(dir=>realpath(dir)));
    for(const dir of roots)must((await lstat(dir)).isDirectory()&&c.dependencyPins.some(p=>under(dir,p.path)),'LOCAL_OCR_DEPENDENCIES_REQUIRED');
    const model=await realpath(c.ocr.directory);
    for(const p of c.ocr.files)must(under(model,await realpath(p.path)),'LOCAL_OCR_MODEL_PATH_INVALID');
    for(const p of c.dependencyPins)must(roots.some(dir=>under(dir,p.path)),'LOCAL_OCR_DEPENDENCY_PATH_INVALID');
    const required=['config.json','preprocessor_config.json','pytorch_model.bin','tokenizer_config.json','special_tokens_map.json','vocab.txt'];
    must(required.every(name=>c.ocr.files.some(p=>relative(model,p.path)===name))&&c.ocr.files.length===required.length,'LOCAL_OCR_MODEL_FILES_INVALID');
    if(c.version===1){
      must(new Set(c.expectedRegions.map(r=>r.id)).size===c.expectedRegions.length&&new Set(c.expectedRegions.map(r=>r.readingOrder)).size===c.expectedRegions.length,'LOCAL_OCR_ORDER_INVALID');
      for(const r of c.expectedRegions)must(/^ctd-[0-9]+$/.test(r.id)&&Number.isSafeInteger(r.readingOrder)&&r.readingOrder>=0&&['HORIZONTAL','VERTICAL'].includes(r.orientation)&&r.box.length===4&&r.box.every(Number.isSafeInteger)&&r.box[0]>=0&&r.box[1]>=0&&r.box[2]>r.box[0]&&r.box[3]>r.box[1]&&r.box[2]<=c.source.width&&r.box[3]<=c.source.height,'LOCAL_OCR_ORDER_INVALID');
    }
    for(const p of [c.python,c.worker,c.detector,...c.ocr.files,...c.dependencyPins])await pinFile(p);
  }
  private async record(input:StageInput,phase:Event['phase'],value:unknown):Promise<void>{
    const event={version:1 as const,adapter:'LOCAL_CTD_MANGA_OCR' as const,configDigest:this.configDigest,phase,value} satisfies Event;
    // Leave space for PipelineEvidence's fixed identity wrapper. The concrete
    // OCR registration must use localOcrJournalBounds, not a text-only 2MiB journal.
    nativeJsonBytes(event,localOcrJournalBounds.maxRecordBytes-1024);
    await this.options.journal.record(input,'OPERATIONAL_SOURCE',event);
  }
  private async events(input:StageInput):Promise<Event[]>{
    const values=await this.options.journal.records<Event>(input,'OPERATIONAL_SOURCE');
    for(const e of values)must(e.version===1&&e.adapter==='LOCAL_CTD_MANGA_OCR'&&hash.test(e.configDigest)&&e.configDigest===values[0].configDigest&&['CAPTURE','START','RAW','RESULT'].includes(e.phase),'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
    const captures=values.filter(e=>e.phase==='CAPTURE');
    must(captures.length<=1&&values.filter(e=>e.phase==='START').length<=1&&values.filter(e=>e.phase==='RESULT').length<=1,'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
    if(captures.length){
      const capture=captures[0].value as Capture,c=capture?.config,r=capture?.request;
      must(capture?.kind==='ACTUAL_LOCAL_OCR'&&c&&r&&(c.version===1||c.version===2)&&r.version===c.version&&
        Number.isSafeInteger(c.maxRegions)&&c.maxRegions>0&&c.maxRegions<=20&&
        digest(c)===captures[0].configDigest&&r.configDigest===captures[0].configDigest&&digest(r)===capture.requestDigest&&
        r.executionId===input.executionId&&r.inputFingerprint===digest(canonicalInput(input)),'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
      this.check(input,c,false);
      const run=join(c.ownedTempRoot,input.executionId);
      const {path:sourcePath,...boundSource}=r.source;
      must(isAbsolute(c.ownedTempRoot)&&r.ownedTempRoot===c.ownedTempRoot&&r.outputDirectory===join(run,'output')&&
        sourcePath===join(run,'source.image')&&digest(boundSource)===digest(requestSource(input,c))&&
        digest(r.detector)===digest(c.detector)&&digest(r.ocr)===digest(c.ocr)&&digest(r.dependencyRoots)===digest(c.dependencyRoots)&&
        r.maxRegions===c.maxRegions&&r.threads===4&&r.maxNewTokens===100&&r.cropPadding===3&&
        (c.version===1?digest(r.expectedRegions)===digest(c.expectedRegions):!Object.hasOwn(r,'expectedRegions')&&!Object.hasOwn(c,'source')&&!Object.hasOwn(c,'expectedRegions')),
        'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
      for(const e of values.filter(value=>value.phase==='START')){
        const start=e.value as {executionId:string;inputFingerprint:string;configDigest:string};
        must(start.executionId===r.executionId&&start.inputFingerprint===r.inputFingerprint&&start.configDigest===r.configDigest,'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
      }
      for(const e of values.filter(value=>value.phase==='RAW')){
        const process=e.value as {kind?:string;reply?:Reply|null};
        if(process.kind==='ACTUAL_LOCAL_OCR_PROCESS'&&process.reply)must(process.reply.executionId===r.executionId&&process.reply.inputFingerprint===r.inputFingerprint&&process.reply.configDigest===r.configDigest,'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
      }
    }else{
      // A claim or START without its original capture cannot authorize inference
      // or a successful proposal, even when the current configuration is usable.
      for(const e of values.filter(value=>value.phase==='RESULT')){
        const result=e.value as Observation;
        must(result.outcome==='UNKNOWN'&&result.data===null&&result.costUsd===null&&result.usageConfirmed===false,'LOCAL_OCR_ORIGINAL_BINDING_INVALID');
      }
    }
    return values;
  }
  async lookup(executionId:string,input?:StageInput):Promise<Observation|null>{
    must(input&&input.executionId===executionId,'LOCAL_OCR_LOOKUP_INPUT_REQUIRED');this.checkIdentity(input);
    if(!await this.options.journal.existingCandidate(input))return null;
    const events=await this.events(input),results=events.filter(e=>e.phase==='RESULT');must(results.length<=1,'LOCAL_OCR_RESULT_CONFLICT');
    if(results.length){const result=structuredClone(results[0].value) as Observation;must(result.providerRef===executionId&&result.costUsd===null&&result.usageConfirmed===false,'LOCAL_OCR_RESULT_CONFLICT');return normalizeObservation(input,result);}
    return observation(input,'UNKNOWN',events.some(e=>e.phase==='START')?true:null,'LOCAL_OCR_ORIGINAL_EXECUTION_UNCONFIRMED');
  }
  async validateObservation(input:StageInput,value:Observation):Promise<void>{
    this.checkIdentity(input);
    const records=(await this.events(input)).filter(e=>e.phase==='RESULT');
    const candidate=structuredClone(value),original=records[0]?.value as Observation|undefined;
    must(original?.stageOutput?.checkpointId===null,'LOCAL_OCR_OBSERVATION_INVALID');
    if(candidate.stageOutput)candidate.stageOutput.checkpointId=null;
    must(records.length===1&&digest(original)===digest(candidate)&&value.costUsd===null&&value.usageConfirmed===false&&value.providerRef===input.executionId,'LOCAL_OCR_OBSERVATION_INVALID');
    const normalized=normalizeObservation(input,value);
    must(digest(normalized)===digest(value),'LOCAL_OCR_OBSERVATION_INVALID');
  }
  async dispatch(value:StageInput,started:(id:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation>{
    const input=structuredClone(value);this.checkIdentity(input);
    if(await this.options.journal.existingCandidate(input))return (await this.lookup(input.executionId,input))!;
    this.check(input);must(context?.native,'NATIVE_GATEWAY_REQUIRED');
    const claimed=await this.options.journal.candidate(input);
    if(!claimed.created)return (await this.lookup(input.executionId,input))!;
    let result:Observation;let phase='PREPARATION';let providerSucceeded=false;
    try{
      await this.verifyConfig();
      const source=await this.options.assets.bytes(input.accountId!,input.originalAssetId,true);
      const sourceBinding=requestSource(input,this.config);
      must(sha256(source)===sourceBinding.sha256&&String(source.length)===input.assetDependencies!.find(a=>a.assetId===input.originalAssetId)!.bytesLength,'LOCAL_OCR_SOURCE_MISMATCH');
      const run=join(this.config.ownedTempRoot,input.executionId);await mkdir(run);
      const sourcePath=join(run,'source.image');await writeFile(sourcePath,source,{flag:'wx'});
      const outputDirectory=join(run,'output');await mkdir(outputDirectory);
      const prepared=await context.native.prepareScopedMaterial(input,source,this.options.fonts,this.options.profile);
      const request:OcrRequest={version:this.config.version,executionId:input.executionId,inputFingerprint:digest(canonicalInput(input)),configDigest:this.configDigest,
        ownedTempRoot:this.config.ownedTempRoot,outputDirectory,source:{...sourceBinding,path:sourcePath},detector:this.config.detector,
        ocr:this.config.ocr,dependencyRoots:this.config.dependencyRoots,maxRegions:this.config.maxRegions,
        ...(this.config.version===1?{expectedRegions:this.config.expectedRegions}:{}),threads:4,maxNewTokens:100,cropPadding:3};
      await this.record(input,'CAPTURE',{kind:'ACTUAL_LOCAL_OCR',request,requestDigest:digest(request),config:this.config,materialPlan:prepared.plan});
      phase='ENGINE';const execution=this.engine.invoke(input,request,started);
      // 원 joined를 즉시 관찰하되 bounded reply와 원 START·RESULT 경계는 유지한다.
      this.trackJoined(execution.joined);const receipt=await execution.reply;
      await this.record(input,'RAW',receipt);
      if(!receipt.valid||!receipt.reply||receipt.reply.outcome!=='SUCCESS'){
        result=observation(input,receipt.valid&&receipt.reply?.outcome==='FAILURE'?'FAILURE':'UNKNOWN',receipt.started?true:null,receipt.valid?'LOCAL_OCR_ENGINE_FAILED':'LOCAL_OCR_EXECUTION_UNCONFIRMED');
      }else{
        providerSucceeded=true;phase='OUTPUT_VALIDATION';const manifestPin=receipt.reply.manifest;must(manifestPin,'LOCAL_OCR_MANIFEST_REQUIRED');
        const raw=await this.consume(outputDirectory,manifestPin,source,request,receipt.reply.recognitionCalls);
        await this.record(input,'RAW',{kind:'ORIGINAL_OUTPUT_FILES',...raw.saved,manifestSha256:manifestPin.sha256});
        const converted=await convertSavedLocalOcrProposal(raw.proposalInput);
        if(this.config.version===1)must(digest(converted.consumption.regions.map(r=>({id:r.id,box:r.detectorBox})))===digest(this.config.expectedRegions.slice().sort((a,b)=>a.readingOrder-b.readingOrder).map(r=>({id:r.id,box:r.box}))),'LOCAL_OCR_DETECTOR_BINDING_CHANGED');
        // Separate image-text localization from editable typeset placement.
        await this.record(input,'RAW',{kind:'VALIDATED_PROPOSAL',...converted});
        phase='NATIVE_APPLY';const data=await context.native.applyScopedProposal(input,converted.proposal,prepared.plan,this.options.fonts,this.options.profile);
        result=normalizeObservation(input,{...observation(input,'SUCCESS',true,converted.proposal.regions.length?'LOCAL_OCR_PROPOSAL_NEEDS_REVIEW':'LOCAL_OCR_ZERO_DETECTIONS_NEEDS_REVIEW'),data});
      }
    }catch(error){
      const events=await this.events(input);
      result=observation(input,'UNKNOWN',events.some(e=>e.phase==='START')?true:null,'LOCAL_OCR_'+phase+'_UNCONFIRMED');
      if(providerSucceeded)result.providerOutcome='SUCCESS';
      if(error instanceof NativeJobError)result.nativeFailure={code:error.code,termination:error.termination};
    }
    result=normalizeObservation(input,result);
    await this.record(input,'RESULT',result);return structuredClone(result);
  }
  private async consume(root:string,pin:Pin,source:Buffer,binding:OcrRequest,recognitionCalls:number){
    let total=0;
    const read=async(p:Pin)=>{
      if(binding.version===2)must(typeof p.bytesLength==='number'&&Number.isSafeInteger(p.bytesLength)&&p.bytesLength>0,'LOCAL_OCR_PIN_INVALID');
      must(under(root,p.path)&&under(await realpath(root),await realpath(p.path)),'LOCAL_OCR_OUTPUT_PATH_INVALID');await pinFile(p,rawBytesLimit);const bytes=await readFile(p.path);total+=bytes.length;must(total<=rawBytesLimit,'LOCAL_OCR_OUTPUT_BYTES_LIMIT');return {bytes,sha256:p.sha256};};
    const manifest=await read(pin),m=parseStrictJson(manifest.bytes.toString('utf8')) as {version:number;executionId:string;inputFingerprint:string;configDigest:string;source:RequestSource;page:string;detector:Pin;recognitions:{record:Pin;crop:Pin}[];masks:Pin[];outputs:Pin[];orderedPlacements?:Pin;detectorCalls?:number;recognitionCalls?:number;humanGroundTruth?:boolean;qualityPass?:boolean};
    must(m.version===binding.version&&m.executionId===binding.executionId&&m.inputFingerprint===binding.inputFingerprint&&m.configDigest===this.configDigest&&Array.isArray(m.recognitions)&&
      (this.config.version===1?m.recognitions.length===this.config.expectedRegions.length:m.recognitions.length<=this.config.maxRegions),'LOCAL_OCR_MANIFEST_INVALID');
    const detector=await read(m.detector),recognitions=[];
    const detectorValue=parseStrictJson(detector.bytes.toString('utf8')) as {page:string;modelSha256:string;source:OcrSource&{file:string;pageLineageId?:string;originalAssetId?:string;bytesLength?:string};blocks:{id:string;box:number[]}[];filtering?:{invalidGeometry:unknown[];regionsTruncated:number};humanGroundTruth?:boolean;qualityPass?:boolean};
    must(detectorValue.page===binding.source.page&&detectorValue.modelSha256===this.config.detector.sha256,'LOCAL_OCR_MODEL_BINDING_INVALID');
    let orderedPlacements:{bytes:Buffer;sha256:string}|undefined;
    let placements:Region[]=this.config.version===1?this.config.expectedRegions:[];
    if(binding.version===2){
      must(m.page===binding.source.page&&digest(m.source)===digest(binding.source)&&m.detectorCalls===1&&m.recognitionCalls===m.recognitions.length&&m.recognitionCalls===recognitionCalls&&m.humanGroundTruth===false&&m.qualityPass===false,'LOCAL_OCR_MANIFEST_INVALID');
      const ds=detectorValue.source,bs=binding.source;
      must(ds&&ds.file===bs.path&&ds.sha256===bs.sha256&&ds.width===bs.width&&ds.height===bs.height&&ds.pageLineageId===bs.pageLineageId&&ds.originalAssetId===bs.originalAssetId&&ds.bytesLength===bs.bytesLength,
        'LOCAL_OCR_SOURCE_MISMATCH');
      must(Array.isArray(detectorValue.blocks)&&detectorValue.blocks.length===m.recognitions.length&&detectorValue.blocks.length<=this.config.maxRegions&&
        detectorValue.filtering&&Array.isArray(detectorValue.filtering.invalidGeometry)&&detectorValue.filtering.invalidGeometry.length===0&&detectorValue.filtering.regionsTruncated===0&&detectorValue.humanGroundTruth===false&&detectorValue.qualityPass===false,
        'LOCAL_OCR_DETECTOR_BINDING_CHANGED');
      must(m.orderedPlacements,'LOCAL_OCR_PLACEMENTS_REQUIRED');orderedPlacements=await read(m.orderedPlacements);
      const order=parseStrictJson(orderedPlacements.bytes.toString('utf8')) as {version:number;algorithm:string;authority:string;source:RequestSource;detectorSha256:string;placements:Region[];reviewSignals:string[];humanGroundTruth:boolean;qualityPass:boolean};
      must(order.version===2&&order.algorithm==='BOX_TOP_THEN_RIGHT_V1'&&order.authority==='DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL'&&
        digest(order.source)===digest(bs)&&order.detectorSha256===detector.sha256&&order.humanGroundTruth===false&&order.qualityPass===false&&
        Array.isArray(order.placements)&&order.placements.length===detectorValue.blocks.length&&Array.isArray(order.reviewSignals)&&order.reviewSignals.includes('NAIVE_BOX_ORDER_NO_PANEL_ANALYSIS'),
        'LOCAL_OCR_PLACEMENTS_INVALID');
      placements=order.placements;const used=new Set<string>();
      for(let index=0;index<placements.length;index++){
        const placement=placements[index],block=detectorValue.blocks.find(value=>value.id===placement.id),box=placement.box;
        must(/^ctd-[0-9]{2,3}$/.test(placement.id)&&!used.has(placement.id)&&placement.readingOrder===index&&['HORIZONTAL','VERTICAL'].includes(placement.orientation)&&
          block&&digest(block.box)===digest(box)&&Array.isArray(box)&&box.length===4&&box.every(Number.isSafeInteger)&&box[0]>=0&&box[1]>=0&&box[2]>box[0]&&box[3]>box[1]&&box[2]<=bs.width&&box[3]<=bs.height,
          'LOCAL_OCR_PLACEMENTS_INVALID');used.add(placement.id);
      }
      must(new Set(detectorValue.blocks.map(value=>value.id)).size===placements.length,'LOCAL_OCR_PLACEMENTS_INVALID');
    }
    const weight=this.config.ocr.files.find(p=>p.path.endsWith('pytorch_model.bin'))!.sha256;
    const recognized=new Set<string>();
    for(const r of m.recognitions){const record=await read(r.record),crop=await read(r.crop);
      const value=parseStrictJson(record.bytes.toString('utf8')) as {modelSha256:string;page:string;id:string;sourceSha256:string;detectorSha256:string;detectorBox:number[];cropBox:number[];cropSha256:string;readingOrder:number;orientation:string;readingOrderAuthority:string;humanGroundTruth:boolean;qualityPass:boolean};
      must(value.modelSha256===weight,'LOCAL_OCR_MODEL_BINDING_INVALID');
      if(binding.version===2){const placement=placements.find(item=>item.id===value.id),box=placement?.box;
        must(placement&&box&&!recognized.has(value.id)&&value.page===binding.source.page&&value.sourceSha256===binding.source.sha256&&value.detectorSha256===detector.sha256&&
          digest(value.detectorBox)===digest(box)&&digest(value.cropBox)===digest([Math.max(0,box[0]-3),Math.max(0,box[1]-3),Math.min(binding.source.width,box[2]+3),Math.min(binding.source.height,box[3]+3)])&&
          value.cropSha256===crop.sha256&&value.readingOrder===placement.readingOrder&&value.orientation===placement.orientation&&value.readingOrderAuthority==='DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL'&&value.humanGroundTruth===false&&value.qualityPass===false,
          'LOCAL_OCR_RECORD_BINDING_INVALID');recognized.add(value.id);}
      recognitions.push({record,crop});}
    must(Array.isArray(m.masks)&&m.masks.length===2,'LOCAL_OCR_MASK_ARTIFACTS_REQUIRED');
    const masks=[];for(const mask of m.masks)masks.push(await read(mask));
    const required=[m.detector,...m.recognitions.flatMap(r=>[r.record,r.crop]),...m.masks,...(m.orderedPlacements?[m.orderedPlacements]:[])];
    must(Array.isArray(m.outputs)&&m.outputs.length<=100&&new Set(m.outputs.map(p=>p.path)).size===m.outputs.length&&required.every(p=>m.outputs.some(q=>q.path===p.path&&q.sha256===p.sha256&&(binding.version===1||q.bytesLength===p.bytesLength))),'LOCAL_OCR_MANIFEST_OUTPUTS_INVALID');
    const additional=[];for(const output of m.outputs)if(!required.some(p=>p.path===output.path))additional.push({path:output.path,...await read(output)});
    const toSaved=(p:{bytes:Buffer;sha256:string})=>({sha256:p.sha256,bytesBase64:p.bytes.toString('base64')});
    const proposalInput:LocalOcrProposalInput={source:{bytes:source,sha256:binding.source.sha256,width:binding.source.width,height:binding.source.height},detector,recognitions,
      readingOrder:placements.map(({id,readingOrder,orientation})=>({id,readingOrder,orientation})),
      origin:{planSha256:this.configDigest,manifestSha256:pin.sha256,modelSha256:this.config.ocr.files.find(p=>p.path.endsWith('pytorch_model.bin'))!.sha256}};
    return {proposalInput,saved:{manifest:toSaved(manifest),detector:toSaved(detector),recognitions:recognitions.map(r=>({record:toSaved(r.record),crop:toSaved(r.crop)})),masks:masks.map(toSaved),
      ...(orderedPlacements?{orderedPlacements:toSaved(orderedPlacements)}:{}),additional:additional.map(p=>({path:p.path,...toSaved(p)}))}};
  }
}
