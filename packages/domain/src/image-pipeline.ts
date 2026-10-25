import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import type {EditData,AssetDependency} from './model.js';
import {selectedCleanupRegions} from './scope.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {assertWire,money} from '../../contracts/src/validation.js';
import {sha256,digest} from '../../contracts/src/intent.js';
import type {Database} from '../../storage/src/database.js';
import type {Assets} from './assets.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import {renderPageDetailed,RenderLayoutHold} from '../../media/src/render.js';
import {type ProviderAdapter,type ProviderCallContext,type StageInput,type Observation,canonicalInput,normalizeObservation,outputEnvelope,storedInput} from './provider.js';
import {decodeImage} from '../../media/src/images.js';
import {binaryPolygonMask} from '../../media/src/mask.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {overlayAvailability,type ProtectedRenderOverlay,type OverlayAvailability} from './render-hold.js';
import type {NativeFacade} from '../../native/src/facade.js';
import {NativeJobError,type NativeTermination} from '../../native/src/dto.js';

export {selectedCleanupRegions} from './scope.js';

// The local fixture removes pixels inside whole selected text polygons. It makes no quality or approval claim.
export async function syntheticCleanup(base:Buffer,data:EditData,regionIds:string[],profile:MediaProfile):Promise<{mask:Buffer;cleaned:Buffer;outsideChangedPixels:number}> {
  const decoded=await decodeImage(base,profile);const selected=new Set(regionIds);
  requireCondition(regionIds.length===selected.size&&regionIds.every(id=>data.blocks.some(block=>block.regionId===id)),'INPUT_INVALID',422);
  const polygons=data.blocks.filter(block=>selected.has(block.regionId)).map(block=>{
    requireCondition(block.geometry.polygon.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<=decoded.width&&p.y<=decoded.height),'INPUT_INVALID',422);
    return block.geometry.polygon;
  });
  const {png:mask,pixels:maskPixels}=await binaryPolygonMask(polygons,decoded.width,decoded.height,profile);
  const before=await sharp(decoded.canonicalPng).ensureAlpha().raw().toBuffer();const after=Buffer.from(before);
  for(let pixel=0;pixel<maskPixels.length;pixel++)if(maskPixels[pixel]>0)after.fill(255,pixel*4,pixel*4+4);
  const cleaned=await sharp(after,{raw:{width:decoded.width,height:decoded.height,channels:4}}).png({compressionLevel:6}).toBuffer();
  const actual=await sharp(cleaned).ensureAlpha().raw().toBuffer();let outsideChangedPixels=0;
  for(let pixel=0;pixel<maskPixels.length;pixel++)if(maskPixels[pixel]===0&&actual.subarray(pixel*4,pixel*4+4).compare(before.subarray(pixel*4,pixel*4+4))!==0)outsideChangedPixels++;
  requireCondition(outsideChangedPixels===0,'STAGE_PROPOSAL_INVALID',422);
  return {mask,cleaned,outsideChangedPixels};
}

type Candidate={version:1;executionId:string;inputDigest:string;inputFingerprint:string;stage:string;generation:string;maskId:string|null;cleanedId:string|null;renderId:string|null;evidenceId:string};
type ProtectedOutput={version:1;executionId:string;inputDigest:string;inputFingerprint:string;observation:Observation;candidate?:Candidate};
type ProtectedNativeFailure=ProtectedOutput&{stage:string;errorCode:string;termination:Readonly<NativeTermination>};
type Hooks={afterCandidate?:(input:StageInput)=>Promise<void>;afterPut?:(input:StageInput)=>Promise<void>};
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));

// Only the owned synthetic environment uses this adapter. CPU output and fake AI submissions remain separate facts.
export class ImagePipelineProvider implements ProviderAdapter {
  readonly synthetic=true;
  constructor(readonly db:Database,readonly assets:Assets,readonly fonts:FontCatalog,readonly profile:MediaProfile,readonly provider:ProviderAdapter,readonly hooks:Hooks={},readonly native?:NativeFacade) {
    requireCondition(provider.synthetic&&profile.kind==='SYNTHETIC'&&profile.enabled,'MODEL_UNVERIFIED',409,'WAIT');
  }
  async validateInput(input:StageInput,context?:ProviderCallContext):Promise<void> {
    const native=context?.native??this.native;
    requireCondition(input.accountId&&input.contextId&&input.envelope,'INPUT_INVALID',422);assertWire('stageInputEnvelope',input.envelope);
    requireCondition(input.envelope.parameterProfileVersion===this.profile.id&&digest(input.envelope.assetIds)===digest((input.assetDependencies??[]).map(d=>d.assetId))&&input.envelope.assetIds.includes(input.originalAssetId),'INPUT_DEPENDENCY_INVALID',409,'WAIT');
    // Admission owns a measured bound. Preserve both a captured finite bound
    // and the legacy unmeasured null instead of changing either at validation.
    if(input.envelope.costBoundUsd!==null)money(input.envelope.costBoundUsd);
    const data=input.previousData??input.initialData;
    if(data.renderSpecification)requireCondition(data.renderSpecification.fontCatalogVersion===this.fonts.catalog.version,'INPUT_DEPENDENCY_INVALID',409,'WAIT');
    for(const dependency of input.assetDependencies??[]) {
      const bytes=await this.assets.bytes(input.accountId,dependency.assetId,true);requireCondition(sha256(bytes)===dependency.sha256&&bytes.length.toString()===dependency.bytesLength,'INPUT_DEPENDENCY_INVALID',409,'WAIT');
      if(dependency.mediaType==='image/png'||dependency.mediaType==='image/jpeg'){const decoded=await (native?native.decodeImage(bytes,this.profile):decodeImage(bytes,this.profile));requireCondition(decoded.mediaType===dependency.mediaType&&decoded.width===input.width&&decoded.height===input.height,'INPUT_DEPENDENCY_INVALID',409,'WAIT');}
      else requireCondition(this.fonts.bytes.has(dependency.assetId)&&sha256(this.fonts.bytes.get(dependency.assetId)!)===dependency.sha256,'INPUT_DEPENDENCY_INVALID',409,'WAIT');
    }
    if(input.stage==='TYPESET')for(const block of data.blocks){const font=this.fonts.font(block.fontAssetId);requireCondition(input.envelope.assetIds.includes(font.id)&&input.envelope.assetIds.includes(font.licenseId),'INPUT_DEPENDENCY_INVALID',409,'WAIT');}
  }
  async record(input:StageInput,kind:string,payload:unknown):Promise<void> {
    await this.db.accountTransaction(input.accountId!,async tx=>{
      const persisted=await storedInput(tx,input.executionId);requireCondition(fingerprint(persisted)===fingerprint(input),'INPUT_EVIDENCE_INVALID',409,'WAIT');
      const id=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) ON CONFLICT DO NOTHING`,[input.accountId,id,input.executionId,kind,digest(payload),tx.now,JSON.stringify(payload)]);
    },true);
  }
  async records<T>(input:StageInput,kind:string):Promise<T[]> {
    return this.db.accountTransaction(input.accountId!,async tx=>{const persisted=await storedInput(tx,input.executionId);requireCondition(fingerprint(persisted)===fingerprint(input),'INPUT_EVIDENCE_INVALID',409,'WAIT');const records=(await tx.client.query<{protected_observation:T;evidence_digest:string}>('SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3 ORDER BY received_at,evidence_id',[input.accountId,input.executionId,kind])).rows;requireCondition(records.every(r=>digest(r.protected_observation)===r.evidence_digest),'STAGE_PROPOSAL_INVALID',422);return records.map(r=>r.protected_observation);},true);
  }
  protectedOutput(input:StageInput,observation:Observation,candidate?:Candidate):ProtectedOutput {
    return {version:1,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),observation:{...observation,stageOutput:outputEnvelope(input,observation)},...(candidate?{candidate}:{})};
  }
  checkProtected(input:StageInput,output:ProtectedOutput):void {
    requireCondition(output.version===1&&output.executionId===input.executionId&&output.inputDigest===input.inputDigest&&output.inputFingerprint===fingerprint(input),'STAGE_PROPOSAL_INVALID',422);
    if(output.candidate){const candidate=output.candidate;requireCondition(candidate.version===1&&candidate.executionId===input.executionId&&candidate.inputDigest===input.inputDigest&&candidate.stage===input.stage&&candidate.inputFingerprint===fingerprint(input),'STAGE_PROPOSAL_INVALID',422);}
  }
  async candidate(input:StageInput):Promise<Candidate> {
    return this.db.accountTransaction(input.accountId!,async tx=>{
      const persisted=await storedInput(tx,input.executionId);requireCondition(fingerprint(persisted)===fingerprint(input)&&input.claimGeneration,'INPUT_EVIDENCE_INVALID',409,'WAIT');
      const existing=(await tx.client.query<{protected_observation:Candidate;evidence_digest:string}>('SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'LOCAL_CANDIDATE\'',[input.accountId,input.executionId])).rows.filter(r=>r.protected_observation.generation===input.claimGeneration);
      requireCondition(existing.length<=1&&existing.every(r=>r.evidence_digest===digest(r.protected_observation)),'STAGE_PROPOSAL_INVALID',422);if(existing[0])return existing[0].protected_observation;
      const candidate:Candidate={version:1,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),stage:input.stage,generation:input.claimGeneration,maskId:input.stage==='CLEANUP'?randomUUID():null,cleanedId:input.stage==='CLEANUP'?randomUUID():null,renderId:input.stage==='TYPESET'?randomUUID():null,evidenceId:randomUUID()};const id=randomUUID();
      await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'LOCAL_CANDIDATE',$4,$2::uuid::text,$5,$6)`,[input.accountId,id,input.executionId,digest(candidate),tx.now,JSON.stringify(candidate)]);return candidate;
    },true);
  }
  async material(input:StageInput,candidate:Candidate,context?:ProviderCallContext):Promise<{data:EditData;buffers:{assetId:string;bytes:Buffer}[];cleanup?:Observation['cleanup'];renderLayout?:Observation['renderLayout']}> {
    const native=context?.native??this.native;
    const data=structuredClone(input.previousData??input.initialData);const source=await this.assets.bytes(input.accountId!,input.currentCleanedAssetId??input.originalAssetId,true);
    if(input.stage==='CLEANUP') {
      const selected=selectedCleanupRegions(data,input.scope,input.paintStrokes,input.paintInclusion);const output=await (native?native.syntheticCleanup(source,data,selected,this.profile):syntheticCleanup(source,data,selected,this.profile));const previousQa=data.cleanupQa;data.cleanupQa=selected.length?(previousQa==='FAILED'?'FAILED':'NEEDS_REVIEW'):previousQa;
      return {data,buffers:[{assetId:candidate.maskId!,bytes:output.mask},{assetId:candidate.cleanedId!,bytes:output.cleaned}],cleanup:{method:'SYNTHETIC_WHITE_FILL',backgroundQa:'NEEDS_REVIEW',previousQa,selectedRegionIds:selected,approval:'UNAPPROVED',maskAssetId:candidate.maskId!,outsideChangedPixels:0}};
    }
    requireCondition(input.stage==='TYPESET','INPUT_INVALID',422);const rendered=await (native?native.renderPageDetailed(source,data,this.fonts,this.profile):renderPageDetailed(source,data,this.fonts,this.profile));if(!rendered.bytes)throw new RenderLayoutHold(rendered);return {data,buffers:[{assetId:candidate.renderId!,bytes:rendered.bytes}],renderLayout:rendered.layout};
  }
  async dispatch(input:StageInput,started:(evidenceId:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation> {
    if(!['CLEANUP','TYPESET'].includes(input.stage)) {
      const observation=await this.provider.dispatch(input,started,context);await this.record(input,'PROVIDER_OUTPUT',this.protectedOutput(input,observation));return observation;
    }
    const candidate=await this.candidate(input);if(this.hooks.afterCandidate)await this.hooks.afterCandidate(input);await started(randomUUID());
    let material:Awaited<ReturnType<ImagePipelineProvider['material']>>;
    try{material=await this.material(input,candidate,context);}catch(error){
      if(error instanceof NativeJobError){
        // START is already durable. A direct child exit never proves full termination or zero cost.
        const unknown:Observation={evidenceId:candidate.evidenceId,outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,finishReason:'NATIVE_EXECUTION_UNCONFIRMED',providerRef:input.executionId,data:null,costBasis:'LOCAL_SYNTHETIC',nativeFailure:{code:error.code,termination:Object.freeze({...error.termination})}};
        const output=this.protectedOutput(input,unknown,candidate);const failure:ProtectedNativeFailure={...output,stage:input.stage,errorCode:error.code,termination:Object.freeze({...error.termination})};
        await this.record(input,'LOCAL_NATIVE_FAILURE',failure);await this.record(input,'LOCAL_OUTPUT',output);return unknown;
      }
      const overlays=error instanceof RenderLayoutHold?error.result.overlays.map(item=>({...item,assetId:randomUUID()})):[];const protectedOverlays:ProtectedRenderOverlay[]=overlays.map(item=>({regionId:item.regionId,bounds:item.bounds,dependency:{assetId:item.assetId,sha256:sha256(item.bytes),bytesLength:String(item.bytes.length),mediaType:'image/png'},storage:'PLANNED'}));
      const failure:Observation={evidenceId:candidate.evidenceId,outcome:'FAILURE',started:true,costUsd:'0',usageConfirmed:true,finishReason:error instanceof RenderLayoutHold?'SYNTHETIC_LAYOUT_QA_HOLD':'SYNTHETIC_LOCAL_COMPUTATION_FAILED',providerRef:input.executionId,data:null,costBasis:'LOCAL_SYNTHETIC',...(error instanceof RenderLayoutHold?{renderLayout:{...error.result.layout,overlays:protectedOverlays}}:{})};
      if(error instanceof RenderLayoutHold){await this.record(input,'LOCAL_HOLD_PLAN',this.protectedOutput(input,failure,candidate));for(const item of overlays){const receipt=await this.assets.store.put(`${input.accountId}/${item.assetId}`,item.bytes);await this.db.accountTransaction(input.accountId!,tx=>this.assets.registerReceiptIn(tx,item.assetId,receipt,'LIVE','image/png',input.contextId),true);}}
      await this.record(input,'LOCAL_OUTPUT',this.protectedOutput(input,failure,candidate));return failure;
    }
    const outputs:AssetDependency[]=material.buffers.map(item=>({assetId:item.assetId,sha256:sha256(item.bytes),bytesLength:item.bytes.length.toString(),mediaType:'image/png'}));
    const cleanedId=candidate.cleanedId??input.currentCleanedAssetId??null;const carried=cleanedId&&!outputs.some(d=>d.assetId===cleanedId)?input.assetDependencies?.filter(d=>d.assetId===cleanedId)??[]:[];
    const observation:Observation={evidenceId:candidate.evidenceId,outcome:'SUCCESS',started:true,costUsd:'0',usageConfirmed:true,finishReason:input.stage==='CLEANUP'?'SYNTHETIC_LOCAL_CLEANUP_NEEDS_REVIEW':'SYNTHETIC_LOCAL_CANONICAL_TYPESET',providerRef:input.executionId,data:material.data,costBasis:'LOCAL_SYNTHETIC',outputAssetIds:outputs.map(d=>d.assetId),assetDependencies:[...outputs,...carried],cleanedAssetId:cleanedId,renderAssetId:candidate.renderId,...(material.cleanup?{cleanup:material.cleanup}:{}),...(material.renderLayout?{renderLayout:material.renderLayout}:{})};
    const protectedOutput=this.protectedOutput(input,observation,candidate);await this.record(input,'LOCAL_PLAN',protectedOutput);
    for(const item of material.buffers){const receipt=await this.assets.store.put(`${input.accountId}/${item.assetId}`,item.bytes);await this.db.accountTransaction(input.accountId!,tx=>this.assets.registerReceiptIn(tx,item.assetId,receipt,'LIVE','image/png',input.contextId),true);}
    if(this.hooks.afterPut)await this.hooks.afterPut(input);
    await this.record(input,'LOCAL_OUTPUT',protectedOutput);return observation;
  }
  async lookup(executionId:string,input?:StageInput,context?:ProviderCallContext):Promise<Observation|null> {
    requireCondition(input&&input.executionId===executionId,'INPUT_EVIDENCE_INVALID',409,'WAIT');
    const local=['CLEANUP','TYPESET'].includes(input.stage);const outputs=await this.records<ProtectedOutput>(input,local?'LOCAL_OUTPUT':'PROVIDER_OUTPUT');
    requireCondition(outputs.length<=1,'STAGE_PROPOSAL_INVALID',422);if(outputs[0]){this.checkProtected(input,outputs[0]);return outputs[0].observation;}
    if(local){const failures=await this.records<ProtectedNativeFailure>(input,'LOCAL_NATIVE_FAILURE');requireCondition(failures.length<=1,'STAGE_PROPOSAL_INVALID',422);if(failures[0]){const failure=failures[0];this.checkProtected(input,failure);requireCondition(failure.stage===input.stage&&failure.observation.outcome==='UNKNOWN'&&failure.observation.started===true&&failure.observation.costUsd===null&&!failure.observation.usageConfirmed&&failure.observation.data===null,'STAGE_PROPOSAL_INVALID',422);return failure.observation;}}
    if(local){const holds=await this.records<ProtectedOutput>(input,'LOCAL_HOLD_PLAN');requireCondition(holds.length<=1,'STAGE_PROPOSAL_INVALID',422);if(holds[0]){this.checkProtected(input,holds[0]);requireCondition(holds[0].observation.outcome==='FAILURE'&&holds[0].observation.renderLayout?.qa==='HOLD','STAGE_PROPOSAL_INVALID',422);return holds[0].observation;}}
    if(!local)return this.provider.lookup(executionId,input,context);
    const plans=await this.records<ProtectedOutput>(input,'LOCAL_PLAN');const candidates=await this.records<Candidate>(input,'LOCAL_CANDIDATE');
    for(const plan of plans){this.checkProtected(input,plan);requireCondition(plan.candidate&&candidates.some(c=>digest(c)===digest(plan.candidate)),'STAGE_PROPOSAL_INVALID',422);let complete=true;
      for(const assetId of plan.observation.outputAssetIds??[]){const expected=plan.observation.assetDependencies?.find(d=>d.assetId===assetId);const receipt=await this.assets.store.receipt(`${input.accountId}/${assetId}`);if(!receipt){complete=false;break;}requireCondition(expected&&receipt.sha256===expected.sha256&&receipt.bytesLength===expected.bytesLength,'STAGE_PROPOSAL_INVALID',422);await this.assets.store.read(receipt.key);await this.db.accountTransaction(input.accountId!,tx=>this.assets.registerReceiptIn(tx,assetId,receipt,'LIVE','image/png',input.contextId),true);}
      if(!complete)continue;const normalized=normalizeObservation(input,plan.observation);await this.validateObservation(input,normalized,context);await this.record(input,'LOCAL_OUTPUT',plan);return plan.observation;
    }
    // INPUT and an incomplete candidate prove preparation, never completion. No external or CPU dispatch is repeated here.
    return null;
  }
  async holdAvailability(input:StageInput):Promise<OverlayAvailability[]> {
    const observation=await this.lookup(input.executionId,input);return overlayAvailability(this.assets.store,input.accountId!,observation?.renderLayout?.overlays??[]);
  }
  async validateObservation(input:StageInput,observation:Observation,context?:ProviderCallContext):Promise<void> {
    if(observation.outcome!=='SUCCESS')return;
    if(!['CLEANUP','TYPESET'].includes(input.stage)){requireCondition(!(observation.outputAssetIds?.length)&&!observation.cleanedAssetId&&!observation.renderAssetId&&!observation.cleanup,'STAGE_PROPOSAL_INVALID',422);return;}
    requireCondition(observation.costBasis==='LOCAL_SYNTHETIC'&&observation.costUsd==='0'&&observation.usageConfirmed&&observation.started&&observation.data,'STAGE_PROPOSAL_INVALID',422);
    const plans=await this.records<ProtectedOutput>(input,'LOCAL_PLAN');const plan=plans.find(p=>p.observation.evidenceId===observation.evidenceId);requireCondition(plan?.candidate,'STAGE_PROPOSAL_INVALID',422);this.checkProtected(input,plan);
    requireCondition(digest(observation.data)===digest(plan.observation.data)&&digest(observation.outputAssetIds)===digest(plan.observation.outputAssetIds)&&digest(observation.assetDependencies)===digest(plan.observation.assetDependencies)&&observation.cleanedAssetId===plan.observation.cleanedAssetId&&observation.renderAssetId===plan.observation.renderAssetId&&digest(observation.cleanup??null)===digest(plan.observation.cleanup??null),'STAGE_PROPOSAL_INVALID',422);
    const material=await this.material(input,plan.candidate,context);requireCondition(digest(material.data)===digest(observation.data)&&digest(material.cleanup??null)===digest(observation.cleanup??null)&&digest(material.renderLayout??null)===digest(observation.renderLayout??null),'STAGE_PROPOSAL_INVALID',422);
    for(const item of material.buffers){const bytes=await this.assets.bytes(input.accountId!,item.assetId,true);requireCondition(sha256(bytes)===sha256(item.bytes),'STAGE_PROPOSAL_INVALID',422);}
  }
}
