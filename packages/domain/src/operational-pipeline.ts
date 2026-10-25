import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {assertWire,money} from '../../contracts/src/validation.js';
import {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import type {RenderedPage} from '../../media/src/render.js';
import {nativeJsonBytes,NativeJobError} from '../../native/src/dto.js';
import {validateNativeProfile} from '../../native/src/jobs.js';
import type {LocalLaMaAdapter,LocalLaMaCapture,LocalLaMaInput,LocalLaMaObservation,OwnedCleanupInput} from '../../providers/src/local-lama.js';
import type {Assets} from './assets.js';
import type {AssetDependency} from './model.js';
import {PipelineEvidence,type PipelineStageCandidate} from './pipeline-evidence.js';
import {canonicalInput,normalizeObservation,type Observation,type ProviderAdapter,type ProviderCallContext,type StageInput} from './provider.js';
import {overlayAvailability,type OverlayAvailability,type ProtectedRenderOverlay} from './render-hold.js';
import {validateEditData,selectedCleanupRegions} from './scope.js';

export type OperationalPipelineBounds={maxEncodedStageBytes:number;maxMetadataBytes:number;maxInFlightBytes:number};
export type OperationalRenderCost={version:1;scope:'FULL_STAGE_PROCESS';executionId:string;inputDigest:string;inputFingerprint:string;profileDigest:string;nativeFactDigest:string;actualUsd:string;evidenceRef:string;basisVersion:string};
// A trusted private reader must verify full processing cost from the original
// native facts. A layout, direct exit, or model-only estimate is insufficient.
export interface OperationalRenderCostReader{lookup(input:StageInput,nativeFactDigest:string):Promise<OperationalRenderCost|null>}
export type OperationalPipelineOptions={enabled:boolean;profile:MediaProfile;fonts:FontCatalog;assets:Assets;journal:PipelineEvidence;provider:ProviderAdapter;lama:LocalLaMaAdapter;renderCost:OperationalRenderCostReader;bounds:OperationalPipelineBounds;ownedCleanupInput?:OwnedCleanupInput};
type Source={version:1;candidate:PipelineStageCandidate;phase:'PROVIDER_START'|'PROVIDER_RESULT'|'PROVIDER'|'LAMA_INPUT'|'LAMA_START'|'LAMA_OUTCOME'|'LAMA_RECONCILIATION'|'RENDER_START'|'RENDER_OUTCOME'|'NATIVE_FAILURE';value:unknown};
type LamaInputPlan={capture:LocalLaMaCapture;image:AssetDependency;mask:AssetDependency};
type Plan={version:1;candidate:PipelineStageCandidate;sourceDigest:string;observation:Observation;assets:AssetDependency[]};
type LamaFacts=Omit<LocalLaMaObservation,'png'>&{png:{sha256:string;bytesLength:string}|null};
type OwnedCall={input:StageInput;context:ProviderCallContext;release:()=>void};
const failureCode='OPERATIONAL_PIPELINE_UNCONFIRMED',fingerprint=(input:StageInput)=>digest(canonicalInput(input));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
function closed(value:unknown,keys:readonly string[]):void{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,failureCode,409,'WAIT');const fields=Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]),failureCode,409,'WAIT');
}

// Separate from ImagePipelineProvider: fixtures retain their synthetic method,
// cost basis and gates. This source is not an operational startup factory and
// confers no model, SQL GO, publication, release, billing or activation authority.
export class OperationalPipelineProvider implements ProviderAdapter{
  readonly synthetic=false;
  private readonly enabled:boolean;private readonly profile:Readonly<MediaProfile>;private readonly bounds:Readonly<OperationalPipelineBounds>;private readonly reservation:number;
  private readonly ownedCleanupInput:OwnedCleanupInput|null;
  private heldBytes=0;private readonly providerDispatch:ProviderAdapter['dispatch'];private readonly providerLookup:ProviderAdapter['lookup'];private readonly providerValidation:ProviderAdapter['validateObservation'];
  constructor(private readonly options:OperationalPipelineOptions){
    closed(options.bounds,['maxEncodedStageBytes','maxMetadataBytes','maxInFlightBytes']);
    requireCondition(typeof options.enabled==='boolean'&&options.provider.synthetic===false&&options.assets.db===options.journal.db&&options.journal.db.role==='trio_web_worker'&&Object.values(options.bounds).every(value=>Number.isSafeInteger(value)&&value>0),failureCode,409,'WAIT');
    validateNativeProfile(options.profile);this.enabled=options.enabled;this.profile=Object.freeze(structuredClone(options.profile));this.bounds=Object.freeze({...options.bounds});
    const admission=Object.getOwnPropertyDescriptor(options,'ownedCleanupInput');this.ownedCleanupInput=null;
    if(admission){
      requireCondition(admission.enumerable&&'value'in admission,failureCode,409,'WAIT');closed(admission.value,['profileDigest','sourceImageSha256','widthPx','heightPx']);const pinned=admission.value as OwnedCleanupInput;
      requireCondition(this.profile.kind==='SYNTHETIC'&&pinned.profileDigest===digest(this.profile)&&hash.test(pinned.sourceImageSha256)&&Number.isSafeInteger(pinned.widthPx)&&Number.isSafeInteger(pinned.heightPx)&&pinned.widthPx>0&&pinned.heightPx>0&&pinned.widthPx<=this.profile.maxWidth&&pinned.heightPx<=this.profile.maxHeight&&pinned.widthPx*pinned.heightPx<=this.profile.maxPixels,failureCode,409,'WAIT');this.ownedCleanupInput=Object.freeze({...pinned});
    }
    requireCondition(options.lama.matchesOwnedCleanupInput(this.ownedCleanupInput),failureCode,409,'WAIT');
    this.reservation=4*this.bounds.maxEncodedStageBytes+3*this.bounds.maxMetadataBytes;requireCondition(Number.isSafeInteger(this.reservation)&&this.reservation<=this.bounds.maxInFlightBytes,failureCode,409,'WAIT');
    this.providerDispatch=options.provider.dispatch.bind(options.provider);this.providerLookup=options.provider.lookup.bind(options.provider);this.providerValidation=options.provider.validateObservation?.bind(options.provider);
    nativeJsonBytes(options.fonts.catalog,this.bounds.maxMetadataBytes);const catalog=structuredClone(options.fonts.catalog),references=[...catalog.fonts,catalog.license];
    requireCondition(new Set(references.map(item=>item.id)).size===references.length&&options.fonts.bytes instanceof Map&&options.fonts.bytes.size===references.length,failureCode,409,'WAIT');let fontBytes=0;
    for(const item of references){const raw=options.fonts.bytes.get(item.id);requireCondition(Buffer.isBuffer(raw)&&String(raw.length)===item.bytesLength&&sha256(raw)===item.sha256,failureCode,409,'WAIT');fontBytes+=raw.length;}requireCondition(Number.isSafeInteger(fontBytes)&&fontBytes<=this.bounds.maxEncodedStageBytes,failureCode,409,'WAIT');
    // The owning configuration is copied before the first asynchronous call.
    // Prototype methods operate on this private catalog and byte map only.
    const fonts=Object.assign(Object.create(FontCatalog.prototype),{root:options.fonts.root,catalog,bytes:new Map(references.map(item=>[item.id,Buffer.from(options.fonts.bytes.get(item.id)!)]))}) as FontCatalog;
    this.options=Object.freeze({...options,profile:this.profile,bounds:this.bounds,fonts:Object.freeze(fonts),...(this.ownedCleanupInput?{ownedCleanupInput:this.ownedCleanupInput}:{})});
  }
  private own(value:StageInput,context?:ProviderCallContext,readOnly=false):OwnedCall{
    requireCondition((readOnly||(this.enabled&&this.profile.enabled))&&context?.native&&this.heldBytes<=this.bounds.maxInFlightBytes-this.reservation,failureCode,409,'WAIT');
    this.heldBytes+=this.reservation;let released=false;const release=()=>{if(!released){released=true;this.heldBytes-=this.reservation;}};
    try{nativeJsonBytes(value,this.bounds.maxMetadataBytes);const input=structuredClone(value);this.checkInput(input);return {input,context:{native:context.native},release};}catch(error){release();throw error;}
  }
  private checkInput(input:StageInput):void{
    requireCondition(input.accountId&&uuid.test(input.accountId)&&input.contextId&&uuid.test(input.contextId)&&uuid.test(input.executionId)&&hash.test(input.inputDigest)&&input.envelope&&['OCR','TRANSLATE','CLEANUP','TYPESET'].includes(input.stage),failureCode,409,'WAIT');assertWire('stageInputEnvelope',input.envelope);
    // Owned bounds admit TYPESET and only the server-pinned CLEANUP source.
    // The private input tuple makes no measured-host or cost claim.
    requireCondition(this.profile.kind!=='SYNTHETIC'||input.stage==='TYPESET'||(input.stage==='CLEANUP'&&this.ownedCleanupInput!==null),failureCode,409,'WAIT');
    const envelope=input.envelope;requireCondition(envelope.executionId===input.executionId&&envelope.requestId===input.requestId&&envelope.logicalStepId===input.stage&&envelope.inputDigest===input.inputDigest&&envelope.contextId===input.contextId&&digest(envelope.capturedSettings)===digest(input.settings)&&envelope.parameterProfileVersion===this.profile.id&&envelope.costBoundUsd!==null,failureCode,409,'WAIT');money(envelope.costBoundUsd);
    requireCondition(Number.isSafeInteger(input.width)&&Number.isSafeInteger(input.height)&&input.width>0&&input.height>0&&input.width<=this.profile.maxWidth&&input.height<=this.profile.maxHeight&&input.width*input.height<=this.profile.maxPixels,failureCode,409,'WAIT');
    const data=input.previousData??input.initialData;validateEditData(data,input.width,input.height);requireCondition(data.blocks.length<=this.profile.maxBlocks&&(!data.renderSpecification||data.renderSpecification.fontCatalogVersion===this.options.fonts.catalog.version),failureCode,409,'WAIT');
    if(input.scope.kind==='REGIONS')requireCondition(input.scope.regionIds.length>0&&new Set(input.scope.regionIds).size===input.scope.regionIds.length&&input.scope.regionIds.every(id=>data.blocks.some(block=>block.regionId===id)),failureCode,409,'WAIT');
    if(input.scope.kind==='PAINTED')requireCondition(input.paintStrokes?.length&&['ANY_OVERLAP','CENTER'].includes(input.paintInclusion??'')&&input.paintStrokes.every(stroke=>Number.isFinite(stroke.radiusPx)&&stroke.radiusPx>0&&stroke.points.length>0&&stroke.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<=input.width&&point.y<=input.height)),failureCode,409,'WAIT');
    const selected=selectedCleanupRegions(data,input.scope,input.paintStrokes,input.paintInclusion);requireCondition(digest(selected)===digest(envelope.regionIds)&&input.assetDependencies&&new Set(input.assetDependencies.map(item=>item.assetId)).size===input.assetDependencies.length&&digest(envelope.assetIds)===digest(input.assetDependencies.map(item=>item.assetId))&&envelope.assetIds.includes(input.originalAssetId),failureCode,409,'WAIT');
    let bytes=0;for(const dependency of input.assetDependencies){requireCondition(uuid.test(dependency.assetId)&&hash.test(dependency.sha256)&&/^[1-9][0-9]{0,18}$/.test(dependency.bytesLength)&&BigInt(dependency.bytesLength)<=BigInt(this.bounds.maxEncodedStageBytes),failureCode,409,'WAIT');bytes+=Number(dependency.bytesLength);}requireCondition(Number.isSafeInteger(bytes)&&bytes<=this.bounds.maxEncodedStageBytes,failureCode,409,'WAIT');
    if(this.ownedCleanupInput&&input.stage==='CLEANUP'){const pinned=this.ownedCleanupInput,source=this.dependency(input,input.currentCleanedAssetId??input.originalAssetId);requireCondition(input.width===pinned.widthPx&&input.height===pinned.heightPx&&source.mediaType==='image/png'&&source.sha256===pinned.sourceImageSha256,failureCode,409,'WAIT');}
    const fontIds=input.stage==='TYPESET'?data.blocks.map(block=>block.fontAssetId):[input.settings.fontAssetId];for(const id of new Set(fontIds)){const font=this.options.fonts.font(id);for(const assetId of [font.id,font.licenseId]){const raw=this.options.fonts.bytes.get(assetId),dependency=input.assetDependencies.find(item=>item.assetId===assetId);requireCondition(raw&&dependency&&dependency.sha256===sha256(raw)&&dependency.bytesLength===String(raw.length),failureCode,409,'WAIT');}}
  }
  private async read(input:StageInput,dependency:AssetDependency):Promise<Buffer>{
    const raw=await this.options.assets.bytes(input.accountId!,dependency.assetId,true);requireCondition(Buffer.isBuffer(raw)&&raw.length<=this.bounds.maxEncodedStageBytes&&sha256(raw)===dependency.sha256&&String(raw.length)===dependency.bytesLength,failureCode,409,'WAIT');return Buffer.from(raw);
  }
  private async ownedCleanupSource(input:StageInput):Promise<Buffer|null>{
    if(!this.ownedCleanupInput||input.stage!=='CLEANUP')return null;
    const image=await this.read(input,this.dependency(input,input.currentCleanedAssetId??input.originalAssetId));this.options.lama.validateOwnedCleanupImage(image);return image;
  }
  private dependency(input:StageInput,id:string):AssetDependency{const result=input.assetDependencies?.find(item=>item.assetId===id);requireCondition(result,failureCode,409,'WAIT');return structuredClone(result);}
  private binary(id:string,bytes:Buffer):AssetDependency{requireCondition(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=this.bounds.maxEncodedStageBytes,failureCode,409,'WAIT');return {assetId:id,sha256:sha256(bytes),bytesLength:String(bytes.length),mediaType:'image/png'};}
  private source(candidate:PipelineStageCandidate,phase:Source['phase'],value:unknown):Source{const source={version:1 as const,candidate,phase,value};nativeJsonBytes(source,this.bounds.maxMetadataBytes);return structuredClone(source);}
  private checkSource(candidate:PipelineStageCandidate,value:Source):void{closed(value,['version','candidate','phase','value']);requireCondition(value.version===1&&digest(value.candidate)===digest(candidate)&&['PROVIDER_START','PROVIDER_RESULT','PROVIDER','LAMA_INPUT','LAMA_START','LAMA_OUTCOME','LAMA_RECONCILIATION','RENDER_START','RENDER_OUTCOME','NATIVE_FAILURE'].includes(value.phase),failureCode,409,'WAIT');}
  private async sources(input:StageInput,candidate:PipelineStageCandidate):Promise<Source[]>{const values=await this.options.journal.records<Source>(input,'OPERATIONAL_SOURCE');for(const source of values){this.checkSource(candidate,source);if(this.ownedCleanupInput&&input.stage==='CLEANUP'&&source.phase==='LAMA_INPUT'){closed(source.value,['capture','image','mask']);const original=source.value as LamaInputPlan;requireCondition(original.capture?.profileDigest===this.ownedCleanupInput.profileDigest&&original.capture.imageSha256===this.ownedCleanupInput.sourceImageSha256&&digest(original.image)===digest(this.dependency(input,input.currentCleanedAssetId??input.originalAssetId)),failureCode,409,'WAIT');}}return values;}
  private async recordSource(input:StageInput,source:Source):Promise<void>{await this.options.journal.record(input,'OPERATIONAL_SOURCE',source);}
  private observation(candidate:PipelineStageCandidate,facts:Partial<Observation>={}):Observation{return {evidenceId:candidate.evidenceId,outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:failureCode,providerRef:null,data:null,...facts};}
  private eventId(candidate:PipelineStageCandidate,source:Source):string{
    // Identity for this immutable fact, never execution/GO/approval authority.
    // A later original status or cost fact must not reuse the UNKNOWN evidence
    // ID, otherwise ExecutionService's idempotent insert cannot advance it.
    const value=digest({version:1,kind:'OPERATIONAL_OBSERVATION',candidateId:candidate.evidenceId,sourceDigest:digest(source)}),variant=((parseInt(value[16],16)&3)|8).toString(16);
    return `${value.slice(0,8)}-${value.slice(8,12)}-8${value.slice(13,16)}-${variant}${value.slice(17,20)}-${value.slice(20,32)}`;
  }
  private identified(input:StageInput,observation:Observation,id:string):Observation{const captured=normalizeObservation(input,observation);delete captured.stageOutput;return normalizeObservation(input,{...captured,evidenceId:id});}
  private lamaFacts(value:LocalLaMaObservation):LamaFacts{const {png,...facts}=value;const result={...facts,png:png?{sha256:sha256(png),bytesLength:String(png.length)}:null};nativeJsonBytes(result,this.bounds.maxMetadataBytes);return structuredClone(result);}
  private ownRendered(value:RenderedPage):RenderedPage{
    nativeJsonBytes({layout:value.layout,overlays:value.overlays.map(item=>({regionId:item.regionId,bounds:item.bounds}))},this.bounds.maxMetadataBytes);
    requireCondition(value.bytes===null||Buffer.isBuffer(value.bytes),failureCode,409,'WAIT');const total=(value.bytes?.length??0)+value.overlays.reduce((sum,item)=>{requireCondition(Buffer.isBuffer(item.bytes),failureCode,409,'WAIT');return sum+item.bytes.length;},0);requireCondition(Number.isSafeInteger(total)&&total<=this.bounds.maxEncodedStageBytes,failureCode,409,'WAIT');
    return {layout:structuredClone(value.layout),bytes:value.bytes?Buffer.from(value.bytes):null,overlays:value.overlays.map(item=>({regionId:item.regionId,bounds:structuredClone(item.bounds),bytes:Buffer.from(item.bytes)}))};
  }
  private async fullRenderCost(input:StageInput,nativeFactDigest:string):Promise<OperationalRenderCost|null>{
    const value=await this.options.renderCost.lookup(structuredClone(input),nativeFactDigest);if(value===null)return null;nativeJsonBytes(value,this.bounds.maxMetadataBytes);closed(value,['version','scope','executionId','inputDigest','inputFingerprint','profileDigest','nativeFactDigest','actualUsd','evidenceRef','basisVersion']);
    const fact=structuredClone(value);requireCondition(fact.version===1&&fact.scope==='FULL_STAGE_PROCESS'&&fact.executionId===input.executionId&&fact.inputDigest===input.inputDigest&&fact.inputFingerprint===fingerprint(input)&&fact.profileDigest===digest(this.profile)&&fact.nativeFactDigest===nativeFactDigest&&typeof fact.evidenceRef==='string'&&fact.evidenceRef.length>0&&typeof fact.basisVersion==='string'&&fact.basisVersion.length>0,failureCode,409,'WAIT');money(fact.actualUsd);return fact;
  }
  private async publish(input:StageInput,dependency:AssetDependency,bytes?:Buffer):Promise<boolean>{
    const key=`${input.accountId}/${dependency.assetId}`;let receipt=await this.options.assets.store.receipt(key);if(!receipt&&bytes){requireCondition(sha256(bytes)===dependency.sha256&&String(bytes.length)===dependency.bytesLength,failureCode,409,'WAIT');receipt=await this.options.assets.store.put(key,bytes);}if(!receipt)return false;
    requireCondition(receipt.key===key&&receipt.sha256===dependency.sha256&&receipt.bytesLength===dependency.bytesLength,failureCode,409,'WAIT');const actual=await this.options.assets.store.read(key);requireCondition(Buffer.isBuffer(actual)&&actual.length<=this.bounds.maxEncodedStageBytes&&sha256(actual)===dependency.sha256&&String(actual.length)===dependency.bytesLength,failureCode,409,'WAIT');
    await this.options.assets.db.accountTransaction(input.accountId!,tx=>this.options.assets.registerReceiptIn(tx,dependency.assetId,receipt!, 'LIVE','image/png',input.contextId),true);return true;
  }
  private async planned(input:StageInput,candidate:PipelineStageCandidate,source:Source,observation:Observation,buffers:{dependency:AssetDependency;bytes?:Buffer}[],hold=false):Promise<Observation>{
    const assets=buffers.map(item=>item.dependency);requireCondition(assets.reduce((sum,item)=>sum+Number(item.bytesLength),0)<=this.bounds.maxEncodedStageBytes&&new Set(assets.map(item=>item.assetId)).size===assets.length,failureCode,409,'WAIT');
    // Validate any delegated envelope against its original observation before
    // assigning this private journal's independent observation identity.
    const plan:Plan={version:1,candidate,sourceDigest:digest(source),observation:this.identified(input,observation,this.eventId(candidate,source)),assets};nativeJsonBytes(plan,this.bounds.maxMetadataBytes);
    await this.options.journal.record(input,hold?'OPERATIONAL_HOLD_PLAN':'OPERATIONAL_PLAN',plan);for(const item of buffers)await this.publish(input,item.dependency,item.bytes);await this.options.journal.record(input,'OPERATIONAL_OUTPUT',plan);return structuredClone(plan.observation);
  }
  private async nativeFailure(input:StageInput,candidate:PipelineStageCandidate,error:NativeJobError,started:boolean|null,known:Partial<Observation>={}):Promise<Observation>{
    const observation=this.observation(candidate,{...known,outcome:'UNKNOWN',started,costUsd:known.costUsd??null,usageConfirmed:known.usageConfirmed??false,data:null,finishReason:'NATIVE_EXECUTION_UNCONFIRMED',nativeFailure:{code:error.code,termination:Object.freeze({...error.termination})}}),source=this.source(candidate,'NATIVE_FAILURE',observation);
    await this.recordSource(input,source);await this.options.journal.record(input,'OPERATIONAL_NATIVE_FAILURE',source);return await this.planned(input,candidate,source,observation,[]);
  }
  async validateInput(value:StageInput,context?:ProviderCallContext):Promise<void>{const owned=this.own(value,context);try{await this.ownedCleanupSource(owned.input);await this.options.journal.records(owned.input,'OPERATIONAL_SOURCE');for(const dependency of owned.input.assetDependencies!){const bytes=await this.read(owned.input,dependency);if(dependency.mediaType==='image/png'){const image=await owned.context.native.decodeImage(bytes,this.profile);requireCondition(image.width===owned.input.width&&image.height===owned.input.height,failureCode,409,'WAIT');}}}finally{owned.release();}}
  async dispatch(value:StageInput,started:(evidenceId:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation>{
    const owned=this.own(value,context),{input}=owned;try{const admittedImage=await this.ownedCleanupSource(input);const claimed=await this.options.journal.candidate(input);if(!claimed.created)return await this.lookupOwned(input,claimed.candidate,owned.context)??this.observation(claimed.candidate);const candidate=claimed.candidate;
      if(input.stage==='OCR'||input.stage==='TRANSLATE'){
        let didStart=false;let result:Observation;
        try{result=await this.providerDispatch(input,async id=>{requireCondition(uuid.test(id)&&id!==candidate.evidenceId,failureCode,409,'WAIT');didStart=true;await this.recordSource(input,this.source(candidate,'PROVIDER_START',{evidenceId:id}));await started(id);},owned.context);}catch(error){if(error instanceof NativeJobError)return await this.nativeFailure(input,candidate,error,didStart?true:null);result=this.observation(candidate,{started:didStart?true:null,finishReason:'PROVIDER_TRANSPORT_UNCONFIRMED'});}
        nativeJsonBytes(result,this.bounds.maxMetadataBytes);result=structuredClone(result);
        if(didStart&&result.started!==true){
          // Preserve the reported cost/result before recording the conflicting
          // original START. A contradiction cannot erase a known bill or
          // authorize a fresh dispatch.
          await this.recordSource(input,this.source(candidate,'PROVIDER_RESULT',result));result={...result,outcome:'UNKNOWN',started:true,data:null,finishReason:'PROVIDER_START_CONFLICT',...(result.outcome==='SUCCESS'?{providerOutcome:'SUCCESS' as const}:{})};delete result.stageOutput;
        }
        const source=this.source(candidate,'PROVIDER',result);await this.recordSource(input,source);requireCondition(!(result.outputAssetIds?.length)&&!result.cleanup&&!result.cleanedAssetId&&!result.renderAssetId,failureCode,409,'WAIT');return await this.planned(input,candidate,source,result,[]);
      }
      const image=this.dependency(input,input.currentCleanedAssetId??input.originalAssetId),sourceBytes=admittedImage??await this.read(input,image),data=structuredClone(input.previousData??input.initialData);
      if(input.stage==='CLEANUP'){
        const selected=selectedCleanupRegions(data,input.scope,input.paintStrokes,input.paintInclusion);let mask:Buffer;try{mask=(await owned.context.native.binaryPolygonMask(data.blocks.filter(block=>selected.includes(block.regionId)).map(block=>block.geometry.polygon),input.width,input.height,this.profile)).png;}catch(error){if(error instanceof NativeJobError)return await this.nativeFailure(input,candidate,error,null);throw error;}
        const maskDependency=this.binary(candidate.maskAssetId!,mask),lamaInput:LocalLaMaInput={executionId:input.executionId,inputDigest:input.inputDigest,image:sourceBytes,mask},capture=this.options.lama.capture(lamaInput),prepared=this.source(candidate,'LAMA_INPUT',{capture,image,mask:maskDependency} satisfies LamaInputPlan);await this.recordSource(input,prepared);await this.publish(input,maskDependency,mask);
        const result=await this.options.lama.dispatch(lamaInput,async evidenceId=>{requireCondition(uuid.test(evidenceId)&&evidenceId!==candidate.evidenceId,failureCode,409,'WAIT');await this.recordSource(input,this.source(candidate,'LAMA_START',{evidenceId,captureDigest:capture.captureDigest}));await started(evidenceId);},owned.context);return await this.cleanupOutput(input,candidate,image,maskDependency,result);
      }
      let rendered:RenderedPage;let didStart=false;
      try{rendered=this.ownRendered(await owned.context.native.renderPageDetailed(sourceBytes,data,this.options.fonts,this.profile));didStart=true;const id=randomUUID();await this.recordSource(input,this.source(candidate,'RENDER_START',{evidenceId:id}));await started(id);}catch(error){if(error instanceof NativeJobError){if(error.termination.startedComputation===true){const id=randomUUID();await this.recordSource(input,this.source(candidate,'RENDER_START',{evidenceId:id}));await started(id);didStart=true;}return await this.nativeFailure(input,candidate,error,didStart?true:null);}throw error;}
      const nativeFact={layout:rendered.layout,render:rendered.bytes?this.binary(candidate.renderAssetId!,rendered.bytes):null,overlays:rendered.overlays.map(item=>({regionId:item.regionId,bounds:item.bounds,sha256:sha256(item.bytes),bytesLength:String(item.bytes.length)}))},factDigest=digest(nativeFact);let fullCost:OperationalRenderCost|null=null,costState='UNCONFIRMED';
      try{fullCost=await this.fullRenderCost(input,factDigest);costState=fullCost?'CONFIRMED':'UNCONFIRMED';}catch{costState='UNCONFIRMED_COST_FACT';}
      const source=this.source(candidate,'RENDER_OUTCOME',{nativeFact,fullCost,costState});await this.recordSource(input,source);
      const overlays=rendered.overlays.map(item=>({item,dependency:this.binary(randomUUID(),item.bytes)})),protectedOverlays:ProtectedRenderOverlay[]=overlays.map(({item,dependency})=>({regionId:item.regionId,bounds:item.bounds,dependency,storage:'PLANNED'}));
      const observation=this.observation(candidate,{outcome:rendered.bytes?'SUCCESS':'FAILURE',started:true,costUsd:fullCost?.actualUsd??null,usageConfirmed:fullCost!==null,finishReason:rendered.bytes?'OPERATIONAL_CANONICAL_TYPESET':'OPERATIONAL_LAYOUT_QA_HOLD',providerRef:input.executionId,data:rendered.bytes?data:null,...(rendered.bytes?{outputAssetIds:[candidate.renderAssetId!],assetDependencies:[nativeFact.render!,...(input.currentCleanedAssetId?[this.dependency(input,input.currentCleanedAssetId)]:[])],cleanedAssetId:input.currentCleanedAssetId??null,renderAssetId:candidate.renderAssetId}:{}),renderLayout:{...rendered.layout,...(rendered.bytes?{}:{overlays:protectedOverlays})}});
      return await this.planned(input,candidate,source,observation,rendered.bytes?[{dependency:nativeFact.render!,bytes:rendered.bytes}]:overlays.map(({item,dependency})=>({dependency,bytes:item.bytes})),rendered.bytes===null);
    }finally{owned.release();}
  }
  private async cleanupOutput(input:StageInput,candidate:PipelineStageCandidate,image:AssetDependency,mask:AssetDependency,result:LocalLaMaObservation,material?:Plan):Promise<Observation>{
    const {png,...metadata}=result;nativeJsonBytes(metadata,this.bounds.maxMetadataBytes);requireCondition(png===null||(Buffer.isBuffer(png)&&png.length<=this.bounds.maxEncodedStageBytes),failureCode,409,'WAIT');result={...structuredClone(metadata),png:png?Buffer.from(png):null};
    const originals=(await this.sources(input,candidate)).filter(source=>source.phase==='LAMA_OUTCOME').map(source=>source.value as LamaFacts);
    for(const original of originals){
      if(original.runtime&&result.runtime)requireCondition(digest(original.runtime)===digest(result.runtime),failureCode,409,'WAIT');
      if(original.fullCost&&result.fullCost)requireCondition(digest(original.fullCost)===digest(result.fullCost),failureCode,409,'WAIT');
      if(original.start&&result.start)requireCondition(digest(original.start)===digest(result.start),failureCode,409,'WAIT');
      if(original.start){requireCondition(result.state!=='NOT_STARTED',failureCode,409,'WAIT');result.start??=structuredClone(original.start);result.started=true;}
      if(original.fullCost){result.fullCost??=structuredClone(original.fullCost);result.costUsd=original.costUsd;result.usageConfirmed=original.usageConfirmed;}
      result.runtime??=original.runtime?structuredClone(original.runtime):null;if(original.providerSuccess===true)result.providerSuccess=true;
    }
    const facts=this.lamaFacts(result),source=this.source(candidate,'LAMA_OUTCOME',facts);await this.recordSource(input,source);const basis={started:result.started,costUsd:result.costUsd,usageConfirmed:result.usageConfirmed,providerRef:result.runtime?.invocationId??null,...(result.providerSuccess===true?{providerOutcome:'SUCCESS' as const}:{}),...(result.nativeFailure?{nativeFailure:result.nativeFailure}:{})};
    if(material){
      requireCondition(material.observation.outcome==='SUCCESS'&&result.reason!=='LOCAL_LAMA_REPLY_UNCONFIRMED',failureCode,409,'WAIT');const history=await this.sources(input,candidate),original=history.find(value=>digest(value)===material.sourceDigest);requireCondition(original,failureCode,409,'WAIT');
      const materialSourceDigest=original.phase==='LAMA_RECONCILIATION'?(original.value as {materialSourceDigest:string}).materialSourceDigest:material.sourceDigest;
      const cleaned=material.assets.find(asset=>asset.assetId===candidate.cleanedAssetId);requireCondition(cleaned&&(!facts.png||(facts.png.sha256===cleaned.sha256&&facts.png.bytesLength===cleaned.bytesLength)),failureCode,409,'WAIT');
      if(digest(source)===materialSourceDigest)return structuredClone(material.observation);
      const reconciliation=this.source(candidate,'LAMA_RECONCILIATION',{materialSourceDigest,querySourceDigest:digest(source)});await this.recordSource(input,reconciliation);
      const observation={...material.observation,...basis};delete observation.stageOutput;const planAssets=material.assets.map(dependency=>({dependency}));
      return await this.planned(input,candidate,reconciliation,observation,planAssets);
    }
    if(result.state!=='SUCCEEDED'||!result.png){const outcome:Observation['outcome']=result.state==='FAILED'?'FAILURE':result.state==='NOT_STARTED'?'NOT_STARTED':'UNKNOWN';return await this.planned(input,candidate,source,this.observation(candidate,{...basis,outcome,finishReason:result.reason}),[]);}
    requireCondition(result.capture&&result.capture.executionId===input.executionId&&result.capture.inputDigest===input.inputDigest&&result.capture.profileDigest===digest(this.profile)&&result.capture.imageSha256===image.sha256&&result.capture.maskSha256===mask.sha256&&result.outsideChangedPixels===0&&result.backgroundQa==='NEEDS_REVIEW'&&result.approval==='UNAPPROVED',failureCode,409,'WAIT');
    const cleaned=this.binary(candidate.cleanedAssetId!,result.png),data=structuredClone(input.previousData??input.initialData),selected=selectedCleanupRegions(data,input.scope,input.paintStrokes,input.paintInclusion),previousQa=data.cleanupQa;data.cleanupQa=selected.length?(previousQa==='FAILED'?'FAILED':'NEEDS_REVIEW'):previousQa;
    const observation=this.observation(candidate,{...basis,outcome:'SUCCESS',finishReason:'LOCAL_LAMA_CLEANUP_NEEDS_REVIEW',data,outputAssetIds:[mask.assetId,cleaned.assetId],assetDependencies:[mask,cleaned],cleanedAssetId:cleaned.assetId,renderAssetId:null,cleanup:{method:'LOCAL_LAMA',backgroundQa:'NEEDS_REVIEW',previousQa,selectedRegionIds:selected,approval:'UNAPPROVED',maskAssetId:mask.assetId,outsideChangedPixels:0}});
    return await this.planned(input,candidate,source,observation,[{dependency:mask},{dependency:cleaned,bytes:result.png}]);
  }
  private checkPlan(input:StageInput,candidate:PipelineStageCandidate,plan:Plan,sources:Source[]):void{
    closed(plan,['version','candidate','sourceDigest','observation','assets']);const source=sources.find(value=>digest(value)===plan.sourceDigest);
    requireCondition(plan.version===1&&digest(plan.candidate)===digest(candidate)&&hash.test(plan.sourceDigest)&&source&&Array.isArray(plan.assets)&&new Set(plan.assets.map(item=>item.assetId)).size===plan.assets.length&&plan.observation.evidenceId===this.eventId(candidate,source), failureCode,409,'WAIT');nativeJsonBytes(plan,this.bounds.maxMetadataBytes);requireCondition(digest(normalizeObservation(input,plan.observation))===digest(plan.observation),failureCode,409,'WAIT');
    const ids=new Set([candidate.maskAssetId,candidate.cleanedAssetId,candidate.renderAssetId].filter((id):id is string=>id!==null));for(const asset of plan.assets)requireCondition(uuid.test(asset.assetId)&&hash.test(asset.sha256)&&/^[1-9][0-9]{0,18}$/.test(asset.bytesLength)&&BigInt(asset.bytesLength)<=BigInt(this.bounds.maxEncodedStageBytes)&&asset.mediaType==='image/png'&&(ids.has(asset.assetId)||plan.observation.renderLayout?.overlays?.some(item=>digest(item.dependency)===digest(asset))),failureCode,409,'WAIT');
    const observation=plan.observation;
    if(source.phase==='PROVIDER'){
      requireCondition(['OCR','TRANSLATE'].includes(input.stage)&&plan.assets.length===0&&!observation.outputAssetIds?.length&&!observation.cleanup&&!observation.cleanedAssetId&&!observation.renderAssetId&&digest(this.identified(input,source.value as Observation,this.eventId(candidate,source)))===digest(observation),failureCode,409,'WAIT');return;
    }
    if(source.phase==='NATIVE_FAILURE'){requireCondition(observation.outcome==='UNKNOWN'&&plan.assets.length===0&&digest(this.identified(input,source.value as Observation,this.eventId(candidate,source)))===digest(observation),failureCode,409,'WAIT');return;}
    if(source.phase==='LAMA_RECONCILIATION'){
      closed(source.value,['materialSourceDigest','querySourceDigest']);const reference=source.value as {materialSourceDigest:string;querySourceDigest:string};
      const material=sources.find(value=>digest(value)===reference.materialSourceDigest),query=sources.find(value=>digest(value)===reference.querySourceDigest);requireCondition(material?.phase==='LAMA_OUTCOME'&&query?.phase==='LAMA_OUTCOME'&&material!==query,failureCode,409,'WAIT');
      const original=material.value as LamaFacts,facts=query.value as LamaFacts;requireCondition(original.state==='SUCCEEDED'&&original.png&&facts.capture&&digest(facts.capture)===digest(original.capture)&&(!facts.png||digest(facts.png)===digest(original.png))&&facts.state!=='NOT_STARTED'&&observation.outcome==='SUCCESS'&&facts.started===observation.started&&facts.costUsd===observation.costUsd&&facts.usageConfirmed===observation.usageConfirmed&&observation.providerRef===(facts.runtime?.invocationId??null)&&digest(observation.nativeFailure??null)===digest(facts.nativeFailure),failureCode,409,'WAIT');
      if(original.runtime&&facts.runtime)requireCondition(digest(original.runtime)===digest(facts.runtime),failureCode,409,'WAIT');if(original.fullCost)requireCondition(digest(original.fullCost)===digest(facts.fullCost),failureCode,409,'WAIT');if(original.start)requireCondition(facts.start&&digest(original.start)===digest(facts.start),failureCode,409,'WAIT');requireCondition(original.started!==true||facts.started===true,failureCode,409,'WAIT');
      const prior:Observation={...observation,evidenceId:this.eventId(candidate,material),started:original.started,costUsd:original.costUsd,usageConfirmed:original.usageConfirmed,providerRef:original.runtime?.invocationId??null};delete prior.stageOutput;delete prior.nativeFailure;delete prior.providerOutcome;if(original.nativeFailure)prior.nativeFailure=original.nativeFailure;if(original.providerSuccess===true)prior.providerOutcome='SUCCESS';
      this.checkPlan(input,candidate,{...plan,sourceDigest:reference.materialSourceDigest,observation:normalizeObservation(input,prior)},sources);return;
    }
    if(source.phase==='LAMA_OUTCOME'){
      const facts=source.value as LamaFacts;requireCondition(input.stage==='CLEANUP'&&facts.started===observation.started&&facts.costUsd===observation.costUsd&&facts.usageConfirmed===observation.usageConfirmed&&observation.providerRef===(facts.runtime?.invocationId??null)&&digest(observation.nativeFailure??null)===digest(facts.nativeFailure),failureCode,409,'WAIT');
      if(observation.outcome!=='SUCCESS'){const outcome=facts.state==='FAILED'?'FAILURE':facts.state==='NOT_STARTED'?'NOT_STARTED':'UNKNOWN';requireCondition(observation.outcome===outcome&&observation.finishReason===facts.reason&&plan.assets.length===0&&observation.data===null,failureCode,409,'WAIT');return;}
      const prepared=sources.filter(value=>value.phase==='LAMA_INPUT');requireCondition(prepared.length===1&&facts.state==='SUCCEEDED'&&facts.capture&&facts.png&&facts.outsideChangedPixels===0&&facts.backgroundQa==='NEEDS_REVIEW'&&facts.approval==='UNAPPROVED',failureCode,409,'WAIT');const original=prepared[0].value as LamaInputPlan;closed(original,['capture','image','mask']);requireCondition(digest(facts.capture)===digest(original.capture)&&original.mask.assetId===candidate.maskAssetId&&facts.capture.executionId===input.executionId&&facts.capture.inputDigest===input.inputDigest&&facts.capture.profileDigest===digest(this.profile)&&facts.capture.maskSha256===original.mask.sha256,failureCode,409,'WAIT');
      const cleaned=plan.assets.find(asset=>asset.assetId===candidate.cleanedAssetId),mask=plan.assets.find(asset=>asset.assetId===candidate.maskAssetId);requireCondition(plan.assets.length===2&&mask&&cleaned&&digest(mask)===digest(original.mask)&&cleaned.sha256===facts.png.sha256&&cleaned.bytesLength===facts.png.bytesLength&&digest(observation.outputAssetIds)===digest([mask.assetId,cleaned.assetId])&&digest(observation.assetDependencies)===digest([mask,cleaned])&&observation.cleanedAssetId===cleaned.assetId&&observation.renderAssetId===null,failureCode,409,'WAIT');
      const data=structuredClone(input.previousData??input.initialData),selected=selectedCleanupRegions(data,input.scope,input.paintStrokes,input.paintInclusion),previousQa=data.cleanupQa;data.cleanupQa=selected.length?(previousQa==='FAILED'?'FAILED':'NEEDS_REVIEW'):previousQa;
      requireCondition(digest(observation.data)===digest(data)&&digest(observation.cleanup)===digest({method:'LOCAL_LAMA',backgroundQa:'NEEDS_REVIEW',previousQa,selectedRegionIds:selected,approval:'UNAPPROVED',maskAssetId:mask.assetId,outsideChangedPixels:0}),failureCode,409,'WAIT');return;
    }
    requireCondition(source.phase==='RENDER_OUTCOME'&&input.stage==='TYPESET'&&observation.started===true&&sources.some(value=>value.phase==='RENDER_START'),failureCode,409,'WAIT');const facts=source.value as {nativeFact:{layout:RenderedPage['layout'];render:AssetDependency|null;overlays:{regionId:string;bounds:RenderedPage['overlays'][number]['bounds'];sha256:string;bytesLength:string}[]};fullCost:OperationalRenderCost|null;costState:string};closed(facts,['nativeFact','fullCost','costState']);closed(facts.nativeFact,['layout','render','overlays']);
    requireCondition(observation.costUsd===(facts.fullCost?.actualUsd??null)&&observation.usageConfirmed===(facts.fullCost!==null)&&!observation.cleanup&&observation.providerRef===input.executionId,failureCode,409,'WAIT');
    if(facts.fullCost){closed(facts.fullCost,['version','scope','executionId','inputDigest','inputFingerprint','profileDigest','nativeFactDigest','actualUsd','evidenceRef','basisVersion']);requireCondition(facts.fullCost.version===1&&facts.fullCost.scope==='FULL_STAGE_PROCESS'&&facts.fullCost.executionId===input.executionId&&facts.fullCost.inputDigest===input.inputDigest&&facts.fullCost.inputFingerprint===fingerprint(input)&&facts.fullCost.profileDigest===digest(this.profile)&&facts.fullCost.nativeFactDigest===digest(facts.nativeFact)&&typeof facts.fullCost.evidenceRef==='string'&&facts.fullCost.evidenceRef.length>0&&typeof facts.fullCost.basisVersion==='string'&&facts.fullCost.basisVersion.length>0&&facts.costState==='CONFIRMED',failureCode,409,'WAIT');money(facts.fullCost.actualUsd);}else requireCondition(['UNCONFIRMED','UNCONFIRMED_COST_FACT'].includes(facts.costState),failureCode,409,'WAIT');
    if(facts.nativeFact.render){const render=facts.nativeFact.render;requireCondition(observation.outcome==='SUCCESS'&&plan.assets.length===1&&digest(plan.assets[0])===digest(render)&&render.assetId===candidate.renderAssetId&&observation.renderAssetId===render.assetId&&digest(observation.outputAssetIds)===digest([render.assetId])&&digest(observation.renderLayout)===digest(facts.nativeFact.layout)&&digest(observation.data)===digest(input.previousData??input.initialData),failureCode,409,'WAIT');}
    else{const overlays=observation.renderLayout?.overlays;requireCondition(observation.outcome==='FAILURE'&&observation.data===null&&observation.renderLayout?.qa==='HOLD'&&overlays&&overlays.length===facts.nativeFact.overlays.length&&plan.assets.length===overlays.length&&digest({...observation.renderLayout,overlays:undefined})===digest({...facts.nativeFact.layout,overlays:undefined}),failureCode,409,'WAIT');for(const [index,overlay]of overlays.entries()){const expected=facts.nativeFact.overlays[index];requireCondition(overlay.regionId===expected.regionId&&digest(overlay.bounds)===digest(expected.bounds)&&overlay.dependency.sha256===expected.sha256&&overlay.dependency.bytesLength===expected.bytesLength&&digest(plan.assets[index])===digest(overlay.dependency),failureCode,409,'WAIT');}}
  }
  private async reconcileRenderCost(input:StageInput,candidate:PipelineStageCandidate,plan:Plan,sources:Source[]):Promise<Observation>{
    const original=sources.find(source=>digest(source)===plan.sourceDigest);requireCondition(original,failureCode,409,'WAIT');if(original.phase!=='RENDER_OUTCOME')return structuredClone(plan.observation);
    const facts=original.value as {nativeFact:unknown;fullCost:OperationalRenderCost|null;costState:string};if(facts.fullCost)return structuredClone(plan.observation);
    let fullCost:OperationalRenderCost|null;try{fullCost=await this.fullRenderCost(input,digest(facts.nativeFact));}catch{return structuredClone(plan.observation);}if(fullCost===null)return structuredClone(plan.observation);
    // The original raster/QA facts and object identities remain immutable.
    // Only the trusted cost reader is queried; no new render or PUT is issued.
    const source=this.source(candidate,'RENDER_OUTCOME',{nativeFact:facts.nativeFact,fullCost,costState:'CONFIRMED'});await this.recordSource(input,source);
    const observation={...plan.observation,costUsd:fullCost.actualUsd,usageConfirmed:true};delete observation.stageOutput;
    return await this.planned(input,candidate,source,observation,plan.assets.map(dependency=>({dependency})),plan.observation.renderLayout?.qa==='HOLD');
  }
  private async lookupOwned(input:StageInput,candidate:PipelineStageCandidate,context:ProviderCallContext):Promise<Observation|null>{
    // Records are append-only, written SOURCE -> PLAN/HOLD -> OUTPUT. Read in
    // reverse dependency order so an overlapping writer cannot expose a plan
    // while this reader still holds an older snapshot of its required source.
    const outputs=await this.options.journal.records<Plan>(input,'OPERATIONAL_OUTPUT'),plans=await this.options.journal.records<Plan>(input,'OPERATIONAL_PLAN'),holds=await this.options.journal.records<Plan>(input,'OPERATIONAL_HOLD_PLAN'),sources=await this.sources(input,candidate);
    const history=[...plans,...holds];requireCondition(new Set(history.map(plan=>plan.observation.evidenceId)).size===history.length&&new Set(outputs.map(plan=>plan.observation.evidenceId)).size===outputs.length,failureCode,409,'WAIT');
    for(const plan of [...history,...outputs])this.checkPlan(input,candidate,plan,sources);for(const output of outputs)requireCondition(history.some(plan=>digest(plan)===digest(output)),failureCode,409,'WAIT');
    const successes=history.filter(plan=>plan.observation.outcome==='SUCCESS');for(const plan of successes)requireCondition(digest({data:plan.observation.data,assets:plan.assets,cleanup:plan.observation.cleanup??null,layout:plan.observation.renderLayout??null})===digest({data:successes[0].observation.data,assets:successes[0].assets,cleanup:successes[0].observation.cleanup??null,layout:successes[0].observation.renderLayout??null}),failureCode,409,'WAIT');
    const confirmed=history.filter(plan=>plan.observation.usageConfirmed&&plan.observation.costUsd!==null);for(const plan of confirmed)requireCondition(new Decimal(plan.observation.costUsd!).equals(confirmed[0].observation.costUsd!),failureCode,409,'WAIT');
    const ordered=history.sort((a,b)=>sources.findIndex(source=>digest(source)===a.sourceDigest)-sources.findIndex(source=>digest(source)===b.sourceDigest)),material=ordered.filter(value=>value.observation.outcome==='SUCCESS'),preferred=material.length?material:ordered;
    // received_at ties can order immutable SOURCE rows by random evidence ID.
    // Confirmed facts dominate unknown cost independently of arrival order.
    const plan=preferred.filter(value=>value.observation.usageConfirmed&&value.observation.costUsd!==null).at(-1)??preferred.at(-1);let existing:Observation|null=null;
    if(plan){let complete=true;for(const dependency of plan.assets)if(!await this.publish(input,dependency))complete=false;
      if(!complete&&plan.observation.outcome==='SUCCESS')return null;if(complete&&!outputs.some(output=>digest(output)===digest(plan)))await this.options.journal.record(input,'OPERATIONAL_OUTPUT',plan);existing=structuredClone(plan.observation);
      if(existing.costUsd!==null&&existing.usageConfirmed&&existing.outcome!=='UNKNOWN')return existing;
      if(input.stage==='TYPESET')return await this.reconcileRenderCost(input,candidate,plan,sources);
      if(input.stage!=='CLEANUP')return existing;
    }
    if(input.stage==='OCR'||input.stage==='TRANSLATE'){
      const original=sources.filter(source=>source.phase==='PROVIDER');requireCondition(original.length<=1,failureCode,409,'WAIT');const result=original[0]?.value as Observation|undefined;
      // Gemini has no documented authoritative execution lookup. The injected
      // original lookup must stay costless and may return null, never dispatch.
      if(result)return await this.planned(input,candidate,original[0],result,[]);
      const queried=await this.providerLookup(input.executionId,input,context);if(queried===null)return null;nativeJsonBytes(queried,this.bounds.maxMetadataBytes);const source=this.source(candidate,'PROVIDER',queried);await this.recordSource(input,source);requireCondition(!(queried.outputAssetIds?.length)&&!queried.cleanup&&!queried.cleanedAssetId&&!queried.renderAssetId,failureCode,409,'WAIT');return await this.planned(input,candidate,source,structuredClone(queried),[]);
    }
    if(input.stage==='CLEANUP'){
      const originals=sources.filter(source=>source.phase==='LAMA_INPUT');requireCondition(originals.length<=1,failureCode,409,'WAIT');if(!originals[0])return existing;const prepared=originals[0].value as LamaInputPlan;closed(prepared,['capture','image','mask']);
      requireCondition(prepared.mask.assetId===candidate.maskAssetId&&digest(prepared.image)===digest(this.dependency(input,input.currentCleanedAssetId??input.originalAssetId)),failureCode,409,'WAIT');
      if(plan?.observation.outcome==='SUCCESS'){
        const result=await this.options.lama.lookupFacts(prepared.capture);return await this.cleanupOutput(input,candidate,prepared.image,prepared.mask,result,plan);
      }
      if(!await this.publish(input,prepared.mask))return existing;
      const image=await this.read(input,prepared.image),rawMask=await this.options.assets.bytes(input.accountId!,prepared.mask.assetId,true);requireCondition(Buffer.isBuffer(rawMask)&&rawMask.length<=this.bounds.maxEncodedStageBytes&&sha256(rawMask)===prepared.mask.sha256&&String(rawMask.length)===prepared.mask.bytesLength,failureCode,409,'WAIT');const mask=Buffer.from(rawMask),result=await this.options.lama.lookup({executionId:input.executionId,inputDigest:input.inputDigest,image,mask},context,prepared.capture);return await this.cleanupOutput(input,candidate,prepared.image,prepared.mask,result);
    }
    // Preparation or a native START proves no encoded render. This branch
    // does not regenerate a mask/render, submit a provider or PUT a new object.
    return null;
  }
  async lookup(executionId:string,value?:StageInput,context?:ProviderCallContext):Promise<Observation|null>{requireCondition(value&&value.executionId===executionId,failureCode,409,'WAIT');const owned=this.own(value,context,true);try{await this.ownedCleanupSource(owned.input);const candidate=await this.options.journal.existingCandidate(owned.input);return candidate?await this.lookupOwned(owned.input,candidate,owned.context):null;}finally{owned.release();}}
  async validateObservation(value:StageInput,observation:Observation,context?:ProviderCallContext):Promise<void>{
    const owned=this.own(value,context,true);try{
      nativeJsonBytes(observation,this.bounds.maxMetadataBytes);const existingCheckpoint=observation.outcome==='SUCCESS'&&observation.stageOutput!==undefined&&observation.stageOutput.checkpointId!==null;if(!existingCheckpoint)await this.ownedCleanupSource(owned.input);const candidate=await this.options.journal.existingCandidate(owned.input);requireCondition(candidate,failureCode,409,'WAIT');const sources=await this.sources(owned.input,candidate),outputs=await this.options.journal.records<Plan>(owned.input,'OPERATIONAL_OUTPUT'),plans=[...await this.options.journal.records<Plan>(owned.input,'OPERATIONAL_PLAN'),...await this.options.journal.records<Plan>(owned.input,'OPERATIONAL_HOLD_PLAN')];
      const original=outputs.filter(plan=>plan.observation.evidenceId===observation.evidenceId);requireCondition(original.length===1&&plans.some(plan=>digest(plan)===digest(original[0])),failureCode,409,'WAIT');this.checkPlan(owned.input,candidate,original[0],sources);
      const compared=normalizeObservation(owned.input,observation);requireCondition(digest(compared)===digest(observation),failureCode,409,'WAIT');
      // ExecutionService owns the successful checkpoint ID; the provider journal owns every other result field.
      if(compared.outcome==='SUCCESS'&&compared.stageOutput&&compared.stageOutput.checkpointId!==null){requireCondition(original[0].observation.stageOutput?.checkpointId===null,failureCode,409,'WAIT');compared.stageOutput.checkpointId=null;}
      requireCondition(digest(original[0].observation)===digest(compared),failureCode,409,'WAIT');
      const dependencies=new Map<string,AssetDependency>();
      if(existingCheckpoint){
        // 전체 tuple을 먼저 확인한 뒤 기존 제한 안에서 실제 bytes를 읽는다.
        for(const dependency of [...owned.input.assetDependencies??[],...original[0].observation.assetDependencies??[]]){
          closed(dependency,['assetId','sha256','bytesLength','mediaType']);requireCondition(uuid.test(dependency.assetId)&&hash.test(dependency.sha256)&&/^[1-9][0-9]{0,18}$/.test(dependency.bytesLength)&&BigInt(dependency.bytesLength)<=BigInt(this.bounds.maxEncodedStageBytes)&&typeof dependency.mediaType==='string'&&dependency.mediaType.length>0,failureCode,409,'WAIT');
          const previous=dependencies.get(dependency.assetId);requireCondition(!previous||digest(previous)===digest(dependency),failureCode,409,'WAIT');dependencies.set(dependency.assetId,dependency);
        }
        nativeJsonBytes([...dependencies.values()],this.bounds.maxMetadataBytes);
      }
      const source=sources.find(value=>digest(value)===original[0].sourceDigest);if(source?.phase==='PROVIDER'&&observation.outcome==='SUCCESS'&&this.providerValidation)await this.providerValidation(structuredClone(owned.input),structuredClone(source.value as Observation),owned.context);
      if(existingCheckpoint){
        const admitted=await this.ownedCleanupSource(owned.input),admittedId=admitted?(owned.input.currentCleanedAssetId??owned.input.originalAssetId):null,published=new Set(original[0].assets.map(dependency=>dependency.assetId));
        // 원본 guard와 기존 publish가 읽는 자산은 다시 읽지 않는다.
        for(const dependency of dependencies.values())if(dependency.assetId!==admittedId&&!published.has(dependency.assetId))await this.read(owned.input,dependency);
      }
      for(const dependency of original[0].assets)requireCondition(await this.publish(owned.input,dependency),failureCode,409,'WAIT');
    }finally{owned.release();}
  }
  async holdAvailability(value:StageInput,context?:ProviderCallContext):Promise<OverlayAvailability[]>{const observation=await this.lookup(value.executionId,value,context);return overlayAvailability(this.options.assets.store,value.accountId!,observation?.renderLayout?.overlays??[]);}
}
