import {balloonRendererVersion,proposalRendererVersion} from '../../media/src/render-policy.js';
import { randomUUID } from 'node:crypto';
import type { Settings,StageInputEnvelope,StageOutputEnvelope } from '../../contracts/src/wire.generated.js';
import {assertWire} from '../../contracts/src/validation.js';
import {digest} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import type {Transaction} from '../../storage/src/database.js';
import type { EditData, Scope,AssetDependency } from './model.js';
import {painted,mergeScopedData,validateEditData} from './scope.js';
import type {RenderLayout} from '../../media/src/render.js';
import type {ProtectedRenderOverlay} from './render-hold.js';
import type {NativeFacade} from '../../native/src/facade.js';
import type {NativeTermination} from '../../native/src/dto.js';

export type StageInput = { executionId:string;requestId:string;stage:string;inputDigest:string;settings:Settings;scope:Scope;
  originalAssetId:string;initialData:EditData;previousData:EditData|null;width:number;height:number;paintInclusion?:'ANY_OVERLAP'|'CENTER';paintStrokes?:{radiusPx:number;points:{x:number;y:number}[]}[];
  accountId?:string;contextId?:string;claimGeneration?:string;currentCleanedAssetId?:string|null;currentRenderAssetId?:string|null;assetDependencies?:AssetDependency[];previousOutputAssetIds?:string[];envelope?:StageInputEnvelope };
export type CleanupEvidence={method:'SYNTHETIC_WHITE_FILL'|'LOCAL_LAMA';backgroundQa:'NEEDS_REVIEW';previousQa:EditData['cleanupQa'];selectedRegionIds:string[];approval:'UNAPPROVED';maskAssetId:string;outsideChangedPixels:0};
export type Observation = { evidenceId:string;outcome:'SUCCESS'|'NOT_STARTED'|'FAILURE'|'UNKNOWN';started:boolean|null;costUsd:string|null;
  usageConfirmed:boolean;finishReason:string;providerRef:string|null;data:EditData|null;providerOutcome?:'SUCCESS';retryAfterMilliseconds?:number;
  outputAssetIds?:string[];assetDependencies?:AssetDependency[];cleanedAssetId?:string|null;renderAssetId?:string|null;cleanup?:CleanupEvidence;renderLayout?:RenderLayout&{overlays?:ProtectedRenderOverlay[]};costBasis?:'SYNTHETIC_PROVIDER'|'LOCAL_SYNTHETIC';stageOutput?:StageOutputEnvelope;
  nativeFailure?:{code:string;termination:Readonly<NativeTermination>} };
// Parent-only call authority. This context never enters StageInput or wire DTOs.
export type ProviderCallContext={native:NativeFacade};
export interface ProviderAdapter {
  readonly synthetic:boolean;
  dispatch(input:StageInput,started:(evidenceId:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation>;
  lookup(executionId:string,input?:StageInput,context?:ProviderCallContext):Promise<Observation|null>;
  validateInput?(input:StageInput,context?:ProviderCallContext):Promise<void>;
  validateObservation?(input:StageInput,observation:Observation,context?:ProviderCallContext):Promise<void>;
}
export const unknownObservation=():Observation=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'TRANSPORT_UNCONFIRMED',providerRef:null,data:null});

export function canonicalInput(input:StageInput):StageInput {const copy=structuredClone(input);delete copy.claimGeneration;return copy;}
export async function storedInput(tx:Transaction,executionId:string):Promise<StageInput> {
  const execution=(await tx.client.query<{request_id:string;logical_step_id:string;input_digest:string}>('SELECT request_id,logical_step_id,input_digest FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[tx.account.account_id,executionId])).rows[0];
  const records=(await tx.client.query<{protected_observation:StageInput;evidence_digest:string}>('SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'INPUT\'',[tx.account.account_id,executionId])).rows;
  requireCondition(execution&&records.length===1&&digest(records[0].protected_observation)===records[0].evidence_digest,'INPUT_EVIDENCE_INVALID',409,'WAIT');
  const input=records[0].protected_observation;requireCondition(input.envelope&&input.accountId===tx.account.account_id&&input.executionId===executionId&&input.requestId===execution.request_id&&input.stage===execution.logical_step_id&&input.inputDigest===execution.input_digest,'INPUT_EVIDENCE_INVALID',409,'WAIT');assertWire('stageInputEnvelope',input.envelope);
  requireCondition(input.envelope.executionId===executionId&&input.envelope.requestId===input.requestId&&input.envelope.logicalStepId===input.stage&&input.envelope.inputDigest===input.inputDigest&&input.envelope.contextId===input.contextId&&input.envelope.stageContract===input.settings.contractVersion&&digest(input.envelope.capturedSettings)===digest(input.settings),'INPUT_EVIDENCE_INVALID',409,'WAIT');
  return input;
}
export async function persistInput(tx:Transaction,input:StageInput):Promise<void> {
  await tx.client.query('SELECT execution_id FROM executions WHERE account_id=$1 AND execution_id=$2 FOR UPDATE',[tx.account.account_id,input.executionId]);const canonical=canonicalInput(input);
  const existing=(await tx.client.query<{protected_observation:StageInput;evidence_digest:string}>('SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=\'INPUT\'',[tx.account.account_id,input.executionId])).rows;
  if(existing.length){requireCondition(existing.length===1&&existing[0].evidence_digest===digest(canonical)&&digest(existing[0].protected_observation)===digest(canonical),'INPUT_EVIDENCE_INVALID',409,'WAIT');return;}
  const evidenceId=randomUUID();await tx.client.query(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'INPUT',$4,$2::uuid::text,$5,$6)`,[tx.account.account_id,evidenceId,input.executionId,digest(canonical),tx.now,JSON.stringify(canonical)]);
}

export function outputEnvelope(input:StageInput,observation:Observation):StageOutputEnvelope {
  const result:StageOutputEnvelope={executionId:input.executionId,inputDigest:input.inputDigest,stageContract:input.settings.contractVersion,
    outcome:{SUCCESS:'CONFIRMED_SUCCESS',NOT_STARTED:'CONFIRMED_NOT_STARTED',FAILURE:'CONFIRMED_FAILURE',UNKNOWN:'UNKNOWN'}[observation.outcome] as StageOutputEnvelope['outcome'],
    protectedEvidenceRef:observation.evidenceId,outputAssetIds:observation.outputAssetIds??[],checkpointId:observation.stageOutput?.checkpointId??null,
    usageState:observation.usageConfirmed&&observation.costUsd!==null?'CONFIRMED':'UNCONFIRMED',actualCostUsd:observation.usageConfirmed?observation.costUsd:null,finishReason:observation.finishReason};
  assertWire('stageOutputEnvelope',result);return result;
}
// Dispatch, reconciliation and checkpoint reuse share this contract and scope validation.
export function normalizeObservation(input:StageInput,observation:Observation):Observation {
  requireCondition(input.envelope,'INPUT_INVALID',422);assertWire('stageInputEnvelope',input.envelope);
  requireCondition(input.envelope.executionId===input.executionId&&input.envelope.requestId===input.requestId&&input.envelope.logicalStepId===input.stage&&input.envelope.inputDigest===input.inputDigest&&digest(input.envelope.capturedSettings)===digest(input.settings),'INPUT_INVALID',422);
  const expected=outputEnvelope(input,observation);
  if(observation.stageOutput){assertWire('stageOutputEnvelope',observation.stageOutput);requireCondition(digest(observation.stageOutput)===digest(expected),'STAGE_PROPOSAL_INVALID',422);}
  if(observation.outcome!=='SUCCESS')return {...observation,stageOutput:expected};
  requireCondition(observation.data,'STAGE_PROPOSAL_INVALID',422);validateEditData(observation.data,input.width,input.height);
  const prior=input.previousData??input.initialData;

  for(const specification of observation.data.renderSpecification?.blocks??[]){
    if(specification.rendererVersion===balloonRendererVersion)requireCondition(prior.renderSpecification?.blocks.some(captured=>captured.regionId===specification.regionId&&captured.rendererVersion===balloonRendererVersion),'STAGE_PROPOSAL_INVALID',422);
    if(specification.typesetBox!==undefined)requireCondition(prior.renderSpecification?.blocks.some(captured=>captured.regionId===specification.regionId&&captured.typesetBox!==undefined),'STAGE_PROPOSAL_INVALID',422);
    if(specification.targetOrientation!==undefined)requireCondition(prior.renderSpecification?.blocks.some(captured=>captured.regionId===specification.regionId&&captured.targetOrientation!==undefined),'STAGE_PROPOSAL_INVALID',422);
  }
  const data=mergeScopedData(prior,observation.data,input.scope,input.paintStrokes,input.paintInclusion);
  // Manual layout belongs to the captured request, independently of text confirmation.
  for(const specification of prior.renderSpecification?.blocks??[])if(specification.typesetBox!==undefined||specification.targetOrientation!==undefined){
    const next=data.renderSpecification?.blocks.find(item=>item.regionId===specification.regionId);
    requireCondition(data.blocks.some(block=>block.regionId===specification.regionId)&&next,'STAGE_PROPOSAL_INVALID',422);
    if(specification.typesetBox!==undefined)next.typesetBox=structuredClone(specification.typesetBox);
    if(specification.targetOrientation!==undefined)next.targetOrientation=specification.targetOrientation;
    next.rendererVersion=proposalRendererVersion(specification.rendererVersion);
  }
  for(const specification of prior.renderSpecification?.blocks??[])if(specification.rendererVersion===balloonRendererVersion){
    const next=data.renderSpecification?.blocks.find(item=>item.regionId===specification.regionId);
    requireCondition(next,'STAGE_PROPOSAL_INVALID',422);next.rendererVersion=balloonRendererVersion;
  }
  // Protect captured confirmed text on detached consumed data, never on the raw proposal.
  for(const block of prior.blocks){
    if(block.sourceText.status!=='USER_CONFIRMED'&&block.translatedText.status!=='USER_CONFIRMED')continue;
    const next=data.blocks.find(value=>value.regionId===block.regionId);requireCondition(next,'STAGE_PROPOSAL_INVALID',422);
    if(block.sourceText.status==='USER_CONFIRMED')next.sourceText=structuredClone(block.sourceText);
    if(block.translatedText.status==='USER_CONFIRMED'){next.translatedText=structuredClone(block.translatedText);next.appliedTranslation=structuredClone(block.appliedTranslation);}
  }
  if(observation.cleanup){requireCondition(input.stage==='CLEANUP'&&observation.cleanup.backgroundQa==='NEEDS_REVIEW'&&observation.cleanup.approval==='UNAPPROVED'&&observation.cleanup.previousQa===prior.cleanupQa&&observation.cleanup.outsideChangedPixels===0,'STAGE_PROPOSAL_INVALID',422);data.cleanupQa=observation.cleanup.selectedRegionIds.length?(prior.cleanupQa==='FAILED'?'FAILED':'NEEDS_REVIEW'):prior.cleanupQa;}
  else if(input.stage==='TYPESET')data.cleanupQa=prior.cleanupQa;
  if(input.stage==='TYPESET')requireCondition(digest(data)===digest(prior)&&digest(data)===digest(observation.data),'STAGE_PROPOSAL_INVALID',422);
  validateEditData(data,input.width,input.height);return {...observation,data,stageOutput:expected};
}

// A test provider with explicit submission counts and non-cost-incurring status lookup.
export class SyntheticProvider implements ProviderAdapter {
  readonly synthetic=true;
  readonly calls:StageInput[]=[];
  readonly lookups:string[]=[];
  readonly observations=new Map<string,Observation>();
  constructor(private readonly behavior?:(input:StageInput)=>Promise<Observation>|Observation) {}
  async dispatch(input:StageInput,started:(evidenceId:string)=>Promise<void>):Promise<Observation> {
    this.calls.push(structuredClone(input));
    const observation=this.behavior?await this.behavior(input):this.success(input);
    this.observations.set(input.executionId,observation);
    if(observation.started) await started(randomUUID());
    return observation;
  }
  async lookup(executionId:string):Promise<Observation|null> { this.lookups.push(executionId); return this.observations.get(executionId)??null; }
  success(input:StageInput):Observation {
    const data=structuredClone(input.previousData??input.initialData);
    if(input.stage==='OCR' && data.blocks.length===0) {
      let left=input.width*0.15;let top=input.height*0.075;let right=input.width*0.85;let bottom=input.height*0.20;
      if(input.paintStrokes?.length) {
        const points=input.paintStrokes.flatMap((stroke)=>stroke.points.map((point)=>({point,radius:stroke.radiusPx})));
        left=Math.max(0,Math.min(...points.map(({point,radius})=>point.x-radius)));top=Math.max(0,Math.min(...points.map(({point,radius})=>point.y-radius)));
        right=Math.min(input.width,Math.max(...points.map(({point,radius})=>point.x+radius)));bottom=Math.min(input.height,Math.max(...points.map(({point,radius})=>point.y+radius)));
      }
      data.blocks.push({regionId:randomUUID(),geometry:{polygon:[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},
        sourceText:{value:({ja:'合成入力','zh-Hans':'合成输入',en:'Synthetic input'} as const)[input.settings.sourceLanguage],status:'AI_PROPOSED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:input.settings.fontAssetId,fontSizePx:input.settings.baseFontSizePx,appliedTranslation:null});
    }
    if(input.stage==='TRANSLATE') for(const block of data.blocks) {
      if(input.scope.kind==='REGIONS' && !input.scope.regionIds.includes(block.regionId)) continue;
      if(input.scope.kind==='PAINTED'&&(!input.paintInclusion||!painted(block,input.paintStrokes??[],input.paintInclusion)))continue;
      block.translatedText={value:({ko:'합성 번역',en:'Synthetic translation',ja:'合成翻訳'} as const)[input.settings.targetLanguage],status:'AI_PROPOSED'};
      block.appliedTranslation={sourceLanguage:input.settings.sourceLanguage,targetLanguage:input.settings.targetLanguage,modelId:input.settings.modelId,reasoningLevel:input.settings.reasoningLevel,
        modelContract:input.settings.contractVersion,promptContract:'synthetic-v1',originExecutionId:input.executionId};
    }
    data.renderSpecification??={version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[]};
    for(const block of data.blocks){
      let specification=data.renderSpecification.blocks.find(item=>item.regionId===block.regionId);
      if(!specification){specification={regionId:block.regionId,minimumFontSizePx:input.settings.minFontSizePx,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'};data.renderSpecification.blocks.push(specification);}
      if(input.stage==='TRANSLATE'&&(input.scope.kind==='PAGE'||input.scope.kind==='REGIONS'&&input.scope.regionIds.includes(block.regionId)||input.scope.kind==='PAINTED'&&input.paintInclusion&&painted(block,input.paintStrokes??[],input.paintInclusion)))specification.rendererVersion=proposalRendererVersion(specification.rendererVersion);
    }
    return {evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:'0.01',usageConfirmed:true,finishReason:'SYNTHETIC_SUCCESS',providerRef:input.executionId,data};
  }
}
