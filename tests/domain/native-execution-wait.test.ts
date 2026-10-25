import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,canonicalInput,outputEnvelope,type StageInput,type Observation,type ProviderAdapter} from '../../packages/domain/src/provider.js';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {NativeJobError,type NativeTermination} from '../../packages/native/src/dto.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {appendNativeExecutionWait,nativeExecutionCaptureDigest,nativeExecutionHold} from '../../packages/domain/src/native-execution-wait.js';
import {finalizeSafe} from '../../packages/domain/src/liveness.js';
import type {RequestRow,ContextRow} from '../../packages/domain/src/model.js';
import type {NativeGateway,NativeTarget} from '../../packages/native/src/gateway.js';
import type {NativeFacade} from '../../packages/native/src/facade.js';

function fixture(){
  const input:StageInput={executionId:randomUUID(),requestId:randomUUID(),stage:'OCR',inputDigest:sha256('owned-captured-input'),accountId:randomUUID(),contextId:randomUUID(),claimGeneration:'1',originalAssetId:randomUUID(),scope:{kind:'PAGE'},width:100,height:100,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,
    settings:{settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10}};
  input.envelope={executionId:input.executionId,requestId:input.requestId,logicalStepId:input.stage,contextId:input.contextId!,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:input.settings.contractVersion,inputDigest:input.inputDigest,assetIds:[],regionIds:[],capturedSettings:input.settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:'synthetic-fixtures-v1'};
  const provider=new SyntheticProvider() as SyntheticProvider&ProviderAdapter,observation:Observation={...provider.success(input),costUsd:'0.027',providerRef:'owned-provider-ref'};
  const query=vi.fn(async(_text:string,_values?:unknown[])=>({rows:[] as unknown[],rowCount:0}));const tx={client:{query},account:{account_id:input.accountId},now:new Date('2026-10-04T00:00:00Z')} as unknown as Transaction;
  const db={accountTransaction:vi.fn(async(_id:string,run:(tx:Transaction)=>Promise<unknown>)=>run(tx))} as unknown as Database;
  const service=new ExecutionService(db,provider,{stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false});
  const request={account_id:input.accountId,request_id:input.requestId,context_id:input.contextId,context_generation:'1',state:'ACTIVE',hold_reasons:[],first_start_at:null,mode:'FREE',settings_revision:'1',captured_input:{originalAssetId:input.originalAssetId,data:input.initialData,width:100,height:100}} as unknown as RequestRow;
  const claim:Claim={accountId:input.accountId!,workId:randomUUID(),generation:'1',kind:'DISPATCH',ref:{requestId:input.requestId}};
  return {input,observation,provider,service,query,tx,db,request,claim};
}
function fault(code='NATIVE_JOB_TIMEOUT'){
  const termination:NativeTermination={jobId:randomUUID(),inputDigest:sha256('owned-native-input'),profileDigest:sha256('owned-profile'),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'};
  return new NativeJobError(code,409,'WAIT',termination);
}

describe('execution waits preserve independent provider facts',()=>{
  it.each(['NATIVE_JOB_TIMEOUT','NATIVE_GO_WRITE_UNCONFIRMED','NATIVE_EVIDENCE_UNCONFIRMED'])('keeps known provider success and cost when native validation raises %s',async code=>{
    const f=fixture(),error=fault(code),original=structuredClone(f.observation),inputFingerprint=digest(f.input);
    f.provider.validateObservation=vi.fn(async()=>{throw error;});
    const result=await f.service.validated(f.input,f.observation);
    expect(result).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'NATIVE_EXECUTION_UNCONFIRMED',data:null,outputAssetIds:[],assetDependencies:[],nativeFailure:{code,termination:error.termination},stageOutput:{outcome:'UNKNOWN',actualCostUsd:'0.027',usageState:'CONFIRMED',checkpointId:null}});
    expect(result).not.toHaveProperty('renderAssetId');expect(result).not.toHaveProperty('cleanedAssetId');expect(f.observation).toEqual(original);expect(digest(f.input)).toBe(inputFingerprint);
  });
  it('keeps semantic proposal rejection as a confirmed failure with known provider facts',async()=>{
    const f=fixture();f.provider.validateObservation=vi.fn(async()=>{throw new Error('OWNED_SEMANTIC_INVALID');});
    expect(await f.service.validated(f.input,f.observation)).toMatchObject({outcome:'FAILURE',providerOutcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'STAGE_PROPOSAL_INVALID',data:null});
  });
  it('keeps INPUT native failure before preflight, provider start and dispatch with unfinished work',async()=>{
    const f=fixture(),error=fault();vi.spyOn(f.service,'claim').mockResolvedValue(f.claim);vi.spyOn(f.service,'authorize').mockResolvedValue(f.input);const save=vi.spyOn(f.service,'nativeWait').mockResolvedValue();const finish=vi.spyOn(f.service,'finish').mockResolvedValue();
    const preflight=vi.spyOn(f.service,'preflight'),dispatch=vi.spyOn(f.provider,'dispatch'),observe=vi.spyOn(f.service,'observe');f.provider.validateInput=vi.fn(async()=>{throw error;});
    expect(await f.service.runOnce()).toBe(true);expect(save).toHaveBeenCalledWith(f.claim,f.input,'INPUT',error);expect(finish).toHaveBeenCalledWith(f.claim,false,5000);expect(preflight).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
  });
  it('keeps pre-provider DISPATCH native failure separate from fabricated provider outcome or zero cost',async()=>{
    const f=fixture(),error=fault();vi.spyOn(f.service,'claim').mockResolvedValue(f.claim);vi.spyOn(f.service,'authorize').mockResolvedValue(f.input);vi.spyOn(f.service,'preflight').mockResolvedValue(true);const save=vi.spyOn(f.service,'nativeWait').mockResolvedValue(),finish=vi.spyOn(f.service,'finish').mockResolvedValue(),observe=vi.spyOn(f.service,'observe'),started=vi.spyOn(f.service,'started');
    f.provider.dispatch=vi.fn(async()=>{throw error;});await f.service.runOnce();expect(save).toHaveBeenCalledWith(f.claim,f.input,'DISPATCH',error);expect(observe).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();expect(finish).toHaveBeenCalledWith(f.claim,false,5000);
  });
  it('records LOOKUP native failure without dispatching or replacing existing outcome facts',async()=>{
    const f=fixture(),error=fault(),canonical=canonicalInput(f.input);const claim={...f.claim,kind:'RECONCILE',ref:{executionId:f.input.executionId}};
    f.query.mockImplementation(async text=>({rows:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:text.startsWith('SELECT * FROM processing_requests')?[f.request]:[],rowCount:text.startsWith('SELECT * FROM processing_requests')?1:0}));
    vi.spyOn(f.service,'claim').mockResolvedValue(claim);const save=vi.spyOn(f.service,'nativeWait').mockResolvedValue(),finish=vi.spyOn(f.service,'finish').mockResolvedValue(),observe=vi.spyOn(f.service,'observe'),dispatch=vi.spyOn(f.provider,'dispatch');f.provider.lookup=vi.fn(async()=>{throw error;});
    await f.service.runOnce();expect(save).toHaveBeenCalledWith(claim,canonical,'LOOKUP',error);expect(finish).toHaveBeenCalledWith(claim,false,5000);expect(observe).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });
  it('binds checkpoint failure to the current retry request while preserving original INPUT and success',async()=>{
    const f=fixture(),error=fault(),canonical=canonicalInput(f.input),checkpointId=randomUUID(),retryId=randomUUID(),claim={...f.claim,ref:{requestId:retryId}},request={...f.request,request_id:retryId};
    f.observation.stageOutput={...outputEnvelope(f.input,f.observation),checkpointId};const original=structuredClone(f.observation);
    f.query.mockImplementation(async text=>({rows:text.startsWith('SELECT * FROM processing_requests')?[request]:text.includes('SELECT c.checkpoint_id,c.execution_id,c.output_envelope')?[{checkpoint_id:checkpointId,execution_id:f.input.executionId,output_envelope:f.observation}]:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:[],rowCount:0}));
    vi.spyOn(f.service,'claimCurrent').mockResolvedValue(true);const save=vi.spyOn(f.service,'nativeWait').mockResolvedValue();f.provider.validateObservation=vi.fn(async()=>{throw error;});
    expect(await f.service.validateCheckpoints(claim)).toBe(false);expect(save).toHaveBeenCalledWith(claim,canonical,'CHECKPOINT',error,original,retryId);expect(f.observation).toEqual(original);expect(f.query.mock.calls.some(([text])=>text.startsWith('UPDATE executions')||text.startsWith('UPDATE checkpoints')||text.includes("state='RELEASED_CONFIRMED'"))).toBe(false);
  });
  it('allocates fresh parent facade context using the actual work, execution and current checkpoint request',async()=>{
    const f=fixture(),canonical=canonicalInput(f.input),currentRequestId=randomUUID(),inputEvidenceId=randomUUID(),context={account_id:f.input.accountId,context_id:f.input.contextId,generation:'1',owner_session_id:randomUUID(),owner_tab_id:randomUUID(),owner_revision:'7',workspace_revision:'12',lifecycle:'CLOSED'} as unknown as ContextRow;
    const targets:NativeTarget[]=[];const gateway:NativeGateway={forTarget:vi.fn(target=>{targets.push(structuredClone(target));return {} as NativeFacade;}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};const service=new ExecutionService(f.db,f.provider,f.service.policy,{},gateway);
    f.query.mockImplementation(async(text,values)=>({rows:text.startsWith('SELECT * FROM work_items')?[{state:'CLAIMED',claim_owner:service.workerId,claim_generation:f.claim.generation,lease_until:new Date('2026-10-04T00:05:00Z')}]:text.startsWith('SELECT * FROM processing_requests')?[{...f.request,request_id:values?.[1]}]:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:text.startsWith('SELECT evidence_id FROM execution_evidence')?[{evidence_id:inputEvidenceId}]:text.startsWith('SELECT * FROM workspace_contexts')?[context]:[],rowCount:text.startsWith('SELECT 1 FROM request_steps')?1:0}));
    const first=await service.nativeCallContext(f.claim,f.input,'LOOKUP'),second=await service.nativeCallContext(f.claim,f.input,'CHECKPOINT',currentRequestId,f.observation);expect(first!.native).not.toBe(second!.native);
    expect(targets[0]).toMatchObject({accountId:f.input.accountId,targetKind:'EXECUTION',targetId:f.input.executionId,claim:{generation:'1',ownerId:service.workerId,workItemId:f.claim.workId},sourceInput:{executionId:f.input.executionId,inputEvidenceId,stageInputDigest:f.input.inputDigest},protectedOwnerCapture:{contextId:f.input.contextId,contextGeneration:'1',ownerRevision:'7',workspaceRevision:'12'}});
    expect(targets[1]).toMatchObject({targetKind:'REQUEST_CHECKPOINT',targetId:currentRequestId,sourceInput:{executionId:f.input.executionId,inputEvidenceId,stageInputDigest:f.input.inputDigest}});expect(f.input.requestId).not.toBe(currentRequestId);expect(Object.hasOwn(f.input,'native')).toBe(false);expect(Object.hasOwn(f.input.envelope!,'native')).toBe(false);
  });
  it('keeps semantic capture stable across claim generations while distinguishing phase, retry request and output',()=>{
    const f=fixture(),later={...structuredClone(f.input),claimGeneration:'932'},before=structuredClone(f.input),key=nativeExecutionCaptureDigest('INPUT',f.input.requestId,f.input);
    expect(nativeExecutionCaptureDigest('INPUT',later.requestId,later)).toBe(key);expect(nativeExecutionCaptureDigest('DISPATCH',later.requestId,later)).not.toBe(key);expect(nativeExecutionCaptureDigest('INPUT',randomUUID(),later)).not.toBe(key);expect(nativeExecutionCaptureDigest('INPUT',later.requestId,later,f.observation)).not.toBe(key);expect(f.input).toEqual(before);
  });
  it('keeps native wait during safe stop without releasing the active page or held free reservation',async()=>{
    const f=fixture();f.request.hold_reasons=[nativeExecutionHold];expect(await finalizeSafe(f.tx,f.request,'STOPPED','OWNED_STOP')).toBe(false);expect(f.request.state).toBe('STOP_REQUESTED');
    expect(f.query.mock.calls).toHaveLength(1);expect(f.query.mock.calls[0][0]).toContain('hold_reasons=$3');expect(f.query.mock.calls.some(([text])=>text.startsWith('DELETE')||text.includes('free_reservations'))).toBe(false);
  });
  it('stores immutable SOURCE and minimal WAIT separately without publishing known data or assets',async()=>{
    const f=fixture(),error=fault(),original=structuredClone(f.observation);f.observation.renderAssetId=randomUUID();f.observation.outputAssetIds=[f.observation.renderAssetId];const known=structuredClone(f.observation);
    await appendNativeExecutionWait(f.tx,f.request,f.input,'VALIDATION',error,f.observation);
    const source=f.query.mock.calls.find(([text])=>text.includes('INSERT INTO execution_evidence')&&text.includes("'NATIVE_VALIDATION_SOURCE'"))!,wait=f.query.mock.calls.find(([text])=>text.includes('INSERT INTO execution_evidence')&&text.includes("'NATIVE_VALIDATION_WAIT'"))!;
    expect(JSON.parse(source[1]![5] as string)).toEqual(known);expect(source[1]![3]).toBe(digest(known));const snapshot=JSON.parse(wait[1]![5] as string);
    expect(snapshot).toMatchObject({phase:'VALIDATION',currentRequestId:f.input.requestId,originExecutionId:f.input.executionId,inputFingerprint:digest(canonicalInput(f.input)),knownObservationDigest:digest(known),errorCode:error.code,termination:error.termination});
    expect(snapshot).not.toHaveProperty('data');expect(snapshot).not.toHaveProperty('outputAssetIds');expect(snapshot).not.toHaveProperty('costUsd');expect(f.observation.data).toEqual(original.data);expect(f.request.hold_reasons).toContain(nativeExecutionHold);expect(f.query.mock.calls.some(([text])=>text.includes('INSERT INTO checkpoints')||text.includes('UPDATE executions')||text.includes('INSERT INTO cost_items'))).toBe(false);
  });
  it.each(['MARKER','PENDING','NONE'] as const)('fences late successful publication only when the same request has %s',async waiting=>{
    const f=fixture(),canonical=canonicalInput(f.input),original=structuredClone(f.observation);
    if(waiting==='MARKER')f.request.hold_reasons=[nativeExecutionHold];
    f.query.mockImplementation(async text=>{
      const rows=text.startsWith('SELECT * FROM executions')?[{account_id:f.input.accountId,execution_id:f.input.executionId,request_id:f.input.requestId,logical_step_id:f.input.stage,state:'RUNNING',claim_generation:'1',input_digest:f.input.inputDigest}]:text.startsWith('SELECT * FROM processing_requests')?[f.request]:text.startsWith('SELECT current_execution_id')?[{current_execution_id:f.input.executionId}]:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:text.startsWith('SELECT * FROM workspace_contexts')?[{account_id:f.input.accountId,context_id:f.input.contextId}]:text.startsWith('SELECT captured_settings')?[{captured_settings:f.input.settings}]:text.includes('INSERT INTO cost_items')?[{cost_item_id:randomUUID(),state:'CONFIRMED',actual_usd:'0.027',evidence_conflict:false}]:[];
      return {rows,rowCount:text.includes('ON CONFLICT DO NOTHING RETURNING evidence_id')||text.startsWith('INSERT INTO free_starts')||text.startsWith('SELECT 1 FROM native_job_intents')&&waiting==='PENDING'?1:rows.length};
    });
    await f.service.observe(f.input.accountId!,f.input.executionId,f.observation);
    const outcome=f.query.mock.calls.find(([text])=>text.includes('INSERT INTO execution_evidence')&&text.includes('VALUES($1,$2,$3,$4,$5'))!;
    const published=JSON.parse(outcome[1]![6] as string) as Observation;
    expect(published).toMatchObject({outcome:waiting==='NONE'?'SUCCESS':'UNKNOWN',started:true,costUsd:'0.027',usageConfirmed:true});
    const sources=f.query.mock.calls.filter(([text])=>text.includes('INSERT INTO execution_evidence')&&text.includes("'NATIVE_VALIDATION_SOURCE'"));
    expect(sources).toHaveLength(waiting==='NONE'?0:1);
    if(waiting!=='NONE'){expect(JSON.parse(sources[0][1]![5] as string)).toEqual(original);expect(published).toMatchObject({data:null,outputAssetIds:[],assetDependencies:[],providerOutcome:'SUCCESS',finishReason:nativeExecutionHold});expect(published).not.toHaveProperty('nativeFailure');}
    expect(f.query.mock.calls.filter(([text])=>text.includes('INSERT INTO checkpoints'))).toHaveLength(waiting==='NONE'?1:0);expect(f.observation).toEqual(original);
  });
});


describe('nativeCallContext request-time ownership with fake DB and gateway ports',()=>{
  it.each(['LOOKUP','CHECKPOINT'] as const)('preserves captured claim, original INPUT and known observation while the first DB read waits in %s',async phase=>{
    const f=fixture(),canonical=structuredClone(canonicalInput(f.input)),originalClaim=structuredClone(f.claim),known=structuredClone(f.observation),currentRequestId=phase==='CHECKPOINT'?randomUUID():canonical.requestId,inputEvidenceId=randomUUID();
    const context={account_id:canonical.accountId,context_id:canonical.contextId,generation:'1',owner_session_id:randomUUID(),owner_tab_id:randomUUID(),owner_revision:'7',workspace_revision:'12',lifecycle:'CLOSED'} as unknown as ContextRow;
    let release!:(value?:void)=>void,entered!:(value?:void)=>void;
    const gate=new Promise<void>(ok=>{release=ok;}),firstRead=new Promise<void>(ok=>{entered=ok;});
    const targets:NativeTarget[]=[],gateway:NativeGateway={forTarget:vi.fn(target=>{targets.push(structuredClone(target));return {} as NativeFacade;}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})};
    const service=new ExecutionService(f.db,f.provider,f.service.policy,{},gateway),request={...structuredClone(f.request),request_id:currentRequestId};
    f.query.mockImplementation(async(text,values)=>{
      if(text.startsWith('SELECT * FROM work_items')){
        expect(values).toEqual([originalClaim.accountId,originalClaim.workId]);entered();await gate;
        return {rows:[{state:'CLAIMED',claim_owner:service.workerId,claim_generation:originalClaim.generation,lease_until:new Date('2026-10-04T00:05:00Z')}],rowCount:1};
      }
      const rows=text.startsWith('SELECT * FROM processing_requests')?[request]:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:canonical.requestId,logical_step_id:canonical.stage,input_digest:canonical.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:text.startsWith('SELECT evidence_id FROM execution_evidence')?[{evidence_id:inputEvidenceId}]:text.startsWith('SELECT * FROM workspace_contexts')?[context]:[];
      return {rows,rowCount:text.startsWith('SELECT 1 FROM request_steps')?1:rows.length};
    });
    const providerDispatch=vi.spyOn(f.provider,'dispatch'),providerLookup=vi.spyOn(f.provider,'lookup'),pending=service.nativeCallContext(f.claim,f.input,phase,currentRequestId,f.observation);
    try{
      await firstRead;f.claim.accountId=randomUUID();f.claim.workId=randomUUID();f.claim.generation='99';f.claim.ref.requestId=randomUUID();
      f.input.accountId=randomUUID();f.input.executionId=randomUUID();f.input.requestId=randomUUID();f.input.inputDigest='c'.repeat(64);f.input.settings.modelId='changed-after-request';f.input.envelope!.contextGeneration='99';
      f.observation.costUsd='999';f.observation.providerRef='changed-after-request';f.observation.finishReason='changed-after-request';
      release();const result=await pending;expect(result?.native).toBeDefined();expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({accountId:originalClaim.accountId,targetKind:phase==='CHECKPOINT'?'REQUEST_CHECKPOINT':'EXECUTION',targetId:phase==='CHECKPOINT'?currentRequestId:canonical.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,currentRequestId,canonical,known),claim:{generation:originalClaim.generation,ownerId:service.workerId,workItemId:originalClaim.workId},sourceInput:{executionId:canonical.executionId,inputEvidenceId,stageInputDigest:canonical.inputDigest},protectedOwnerCapture:{contextId:canonical.contextId,contextGeneration:'1',ownerRevision:'7',workspaceRevision:'12'}});
      expect(f.db.accountTransaction).toHaveBeenCalledExactlyOnceWith(originalClaim.accountId,expect.any(Function),true);
      expect(f.query.mock.calls.filter(([text])=>text.startsWith('SELECT * FROM processing_requests')).map(([,values])=>values)).toEqual([[originalClaim.accountId,currentRequestId]]);
      expect(providerDispatch).not.toHaveBeenCalled();expect(providerLookup).not.toHaveBeenCalled();expect(gateway.forTarget).toHaveBeenCalledOnce();
    }finally{release();await pending;}
  });
});

import {NativeController} from '../../packages/native/src/controller.js';
import {NativeDatabaseGateway,nativeContextForInput,isLocalLaMaContextReadWait} from '../../packages/domain/src/native-gateway.js';
import {LocalLaMaNativePreparation} from '../../packages/domain/src/local-lama-native-preparation.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import {DomainError} from '../../packages/contracts/src/errors.js';

// Proposal tests NOT EXECUTED. Real owning classification and catch boundary,
// explicit fake SQL/objects: no native job/GO or confirmed cost is inferred.
function readFailureFixture(){
  const f=fixture();f.input.stage='CLEANUP';f.input.envelope!.logicalStepId='CLEANUP';f.observation={...f.provider.success(f.input),costUsd:'0.027',providerRef:'owned-provider-ref'};f.request.captured_input.data=f.input.initialData;
  Object.defineProperty(f.db,'role',{value:'trio_web_worker',enumerable:true});
  const controller=NativeController.owned({profile:syntheticProfile,limits:{maxMetadataBytes:1024,maxInputBytes:1024,maxOutputBytes:1024,maxItems:8,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16384}});
  const bounds={maxRecordBytes:65536,maxRecords:16,maxInFlightBytes:64*1024*1024,maxConcurrentReads:1,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}};
  const objects:ObjectStore={bucket:'never-accessed-classification-fixture',put:async()=>{throw Error('UNEXPECTED_OBJECT_PUT');},read:async()=>{throw Error('UNEXPECTED_OBJECT_READ');},receipt:async()=>{throw Error('UNEXPECTED_OBJECT_RECEIPT');},remove:async()=>{throw Error('DELETE_FORBIDDEN');}};
  const preparation=new LocalLaMaNativePreparation(f.db,bounds,syntheticProfile,controller.kernelImplementationDigest),gateway=new NativeDatabaseGateway(f.db,controller,objects,undefined,preparation),service=new ExecutionService(f.db,f.provider,f.service.policy,{},gateway),canonical=canonicalInput(f.input),inputEvidenceId=randomUUID();
  const target=(phase:'INPUT'|'DISPATCH'|'LOOKUP'|'VALIDATION'):NativeTarget=>({accountId:f.input.accountId!,targetKind:'EXECUTION',targetId:f.input.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,f.input.requestId,f.input,phase==='VALIDATION'?f.observation:undefined),protectedOwnerCapture:{contextId:f.input.contextId!,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'1',workspaceRevision:'1'},claim:{generation:'1',ownerId:service.workerId,workItemId:f.claim.workId},sourceInput:{executionId:f.input.executionId,inputEvidenceId,stageInputDigest:f.input.inputDigest}});
  f.query.mockImplementation(async(text)=>{if(text.includes('AS input_matches'))throw Error('OWNED_CLASSIFICATION_READ_UNKNOWN');return {rows:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:canonical,evidence_digest:digest(canonical)}]:text.startsWith('SELECT * FROM processing_requests')?[f.request]:[],rowCount:0};});
  const context=async(phase:'INPUT'|'DISPATCH'|'LOOKUP'|'VALIDATION')=>({native:await nativeContextForInput(gateway,f.db,target(phase),canonical,phase,canonical.requestId,phase==='VALIDATION'?f.observation:undefined)});
  return {...f,service,gateway,controller,preparation,canonical,context};
}
describe('proposal-only owning classification SOURCE/HOLD boundaries',()=>{
  it.each(['INPUT','DISPATCH','LOOKUP','VALIDATION'] as const)('preserves original facts on current owning builder %s failure without a fake job or provider observation',async phase=>{
    const f=readFailureFixture(),wait=vi.spyOn(f.service,'nativeContextWait').mockResolvedValue(),observe=vi.spyOn(f.service,'observe'),finish=vi.spyOn(f.service,'finish').mockResolvedValue(),nativeWait=vi.spyOn(f.service,'nativeWait'),started=vi.spyOn(f.service,'started');
    vi.spyOn(f.service,'nativeCallContext').mockImplementation(async(_claim,_input,actual)=>f.context(actual as typeof phase));
    vi.spyOn(f.service,'claim').mockResolvedValue(phase==='LOOKUP'?{...f.claim,kind:'RECONCILE',ref:{executionId:f.input.executionId}}:f.claim);vi.spyOn(f.service,'authorize').mockResolvedValue(f.input);vi.spyOn(f.service,'preflight').mockResolvedValue(true);
    f.provider.validateInput=vi.fn(async()=>{});f.provider.dispatch=vi.fn(async()=>f.observation);f.provider.lookup=vi.fn(async()=>f.observation);f.provider.validateObservation=vi.fn(async()=>{});
    if(phase==='DISPATCH')vi.mocked(f.service.nativeCallContext).mockImplementationOnce(async()=>undefined);
    try{
      if(phase==='VALIDATION'){expect(await f.service.validated(f.input,f.observation,f.claim)).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',costUsd:'0.027',usageConfirmed:true,data:null});expect(wait).toHaveBeenCalledWith(f.claim,f.input,f.observation);}
      else {await expect(f.service.runOnce()).rejects.toThrow('LOCAL_LAMA_PREPARATION_UNCONFIRMED');expect(wait).toHaveBeenCalledOnce();}
      expect(nativeWait).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();expect(f.provider.validateObservation).not.toHaveBeenCalled();
      expect(f.query.mock.calls.filter(([sql])=>sql.includes('INSERT')||sql.startsWith('UPDATE'))).toHaveLength(0);
    }finally{f.controller.stopClaims();await f.controller.idle();}
  });
  it.each(['INPUT','DISPATCH','LOOKUP','VALIDATION'] as const)('keeps existing provider %s semantics when that provider rethrows an earlier genuine same-gateway classification error',async phase=>{
    const f=readFailureFixture();let old:unknown;try{await f.context('INPUT');}catch(error){old=error;}expect(isLocalLaMaContextReadWait(old,f.gateway)).toBe(true);
    vi.spyOn(f.service,'nativeCallContext').mockResolvedValue(undefined);const wait=vi.spyOn(f.service,'nativeContextWait'),nativeWait=vi.spyOn(f.service,'nativeWait'),observe=vi.spyOn(f.service,'observe').mockResolvedValue(),finish=vi.spyOn(f.service,'finish').mockResolvedValue();
    vi.spyOn(f.service,'claim').mockResolvedValue(phase==='LOOKUP'?{...f.claim,kind:'RECONCILE',ref:{executionId:f.input.executionId}}:f.claim);vi.spyOn(f.service,'authorize').mockResolvedValue(f.input);vi.spyOn(f.service,'preflight').mockResolvedValue(true);
    f.provider.validateInput=vi.fn(async()=>{if(phase==='INPUT')throw old;});f.provider.dispatch=vi.fn(async()=>{if(phase==='DISPATCH')throw old;return f.observation;});f.provider.lookup=vi.fn(async()=>{throw old;});f.provider.validateObservation=vi.fn(async()=>{throw old;});
    try{
      if(phase==='VALIDATION')expect(await f.service.validated(f.input,f.observation,f.claim)).toMatchObject({outcome:'FAILURE',finishReason:'STAGE_PROPOSAL_INVALID',costUsd:'0.027',providerOutcome:'SUCCESS'});
      else if(phase==='INPUT'){
        vi.spyOn(f.service,'claimCurrent').mockResolvedValue(true);await f.service.runOnce();expect(observe).not.toHaveBeenCalled();
        const finalized=f.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE processing_requests SET state=$3,terminal_at=$4'))!;
        expect(finalized[1]).toEqual([f.claim.accountId,f.input.requestId,'FAILED',f.tx.now,'INPUT_DEPENDENCY_INVALID']);expect(finish).toHaveBeenCalledWith(f.claim,true);
        expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO cost_items')||sql.includes('INSERT INTO execution_evidence'))).toBe(false);
      }
      else {await f.service.runOnce();if(phase==='DISPATCH'){expect(observe).toHaveBeenCalledOnce();expect(observe.mock.calls[0][2]).toMatchObject({outcome:'UNKNOWN',costUsd:null,usageConfirmed:false});}else expect(observe).not.toHaveBeenCalled();}
      expect(wait).not.toHaveBeenCalled();expect(nativeWait).not.toHaveBeenCalled();expect(finish).toHaveBeenCalledTimes(phase==='VALIDATION'?0:1);
    }finally{f.controller.stopClaims();await f.controller.idle();}
  });
  it('stores SOURCE ACK before HOLD and preserves known observation when the current claim expired',async()=>{
    const f=fixture(),original=canonicalInput(f.input),known=structuredClone(f.observation);f.query.mockImplementation(async(text)=>({rows:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:original,evidence_digest:digest(original)}]:text.startsWith('SELECT * FROM processing_requests')?[f.request]:[],rowCount:1}));vi.spyOn(f.service,'claimCurrent').mockResolvedValue(false);
    await f.service.nativeContextWait(f.claim,f.input,known);const source=f.query.mock.calls.find(([sql])=>sql.includes("'NATIVE_VALIDATION_SOURCE'"))!;expect(source).toBeDefined();expect(JSON.parse(source[1]![5] as string)).toEqual(known);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests')||sql.includes('NATIVE_VALIDATION_WAIT')||sql.includes('cost_items')||sql.includes('settlements'))).toBe(false);expect(f.observation).toEqual(known);
  });
  it('stops after unknown SOURCE ACK without observe, completion or request HOLD and keeps retry checkpoint identity',async()=>{
    const f=fixture(),original=canonicalInput(f.input),retryId=randomUUID(),known=structuredClone(f.observation),claim={...f.claim,ref:{requestId:retryId}},request={...f.request,request_id:retryId};f.query.mockImplementation(async(text)=>{if(text.includes("'NATIVE_VALIDATION_SOURCE'"))throw Error('OWNED_SOURCE_ACK_UNKNOWN');return {rows:text.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.input.requestId,logical_step_id:f.input.stage,input_digest:f.input.inputDigest}]:text.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:original,evidence_digest:digest(original)}]:text.startsWith('SELECT * FROM processing_requests')?[request]:[],rowCount:text.startsWith('SELECT 1 FROM request_steps')?1:0};});const current=vi.spyOn(f.service,'claimCurrent'),observe=vi.spyOn(f.service,'observe'),finish=vi.spyOn(f.service,'finish');
    await expect(f.service.nativeContextWait(claim,f.input,known,retryId)).rejects.toThrow('OWNED_SOURCE_ACK_UNKNOWN');expect(current).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.includes('NATIVE_VALIDATION_WAIT')||sql.includes('DELETE'))).toBe(false);expect(f.observation).toEqual(known);
    const foreign={...claim,ref:{requestId:randomUUID()}};await expect(f.service.nativeContextWait(foreign,f.input,known,retryId)).rejects.toBeInstanceOf(DomainError);
  });
});


describe('proposal-only checkpoint ordinary context and provider error ownership',()=>{
  it('skips prepared classification and quotas for a retry checkpoint and preserves the existing failure meaning of a provider rethrow',async()=>{
    const f=readFailureFixture();let old:unknown;try{await f.context('INPUT');}catch(error){old=error;}
    expect(isLocalLaMaContextReadWait(old,f.gateway)).toBe(true);
    const retryId=randomUUID(),checkpointId=randomUUID(),known={...structuredClone(f.observation),stageOutput:{...outputEnvelope(f.input,f.observation),checkpointId}},
      target:NativeTarget={accountId:f.input.accountId!,targetKind:'REQUEST_CHECKPOINT',targetId:retryId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',retryId,f.canonical,known),protectedOwnerCapture:{contextId:f.input.contextId!,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'1',workspaceRevision:'1'},claim:{generation:'1',ownerId:f.service.workerId,workItemId:f.claim.workId},sourceInput:{executionId:f.input.executionId,inputEvidenceId:randomUUID(),stageInputDigest:f.input.inputDigest}},
      beforeQueries=f.query.mock.calls.length,quota=f.preparation.acquire();
    try{
      const native=await nativeContextForInput(f.gateway,f.db,target,f.canonical,'CHECKPOINT',retryId,known);
      expect(f.query.mock.calls).toHaveLength(beforeQueries);expect(native).toBeDefined();expect(native.semanticCache!.frameLimits('input').maxMetadataBytes).toBe(1024);
      const claim={...f.claim,ref:{requestId:retryId}},request={...f.request,request_id:retryId},original=structuredClone(known);
      f.query.mockImplementation(async sql=>({rows:sql.startsWith('SELECT * FROM processing_requests')?[request]:sql.includes('SELECT c.checkpoint_id,c.execution_id,c.output_envelope')?[{checkpoint_id:checkpointId,execution_id:f.input.executionId,output_envelope:known}]:sql.startsWith('SELECT request_id,logical_step_id,input_digest')?[{request_id:f.canonical.requestId,logical_step_id:f.canonical.stage,input_digest:f.canonical.inputDigest}]:sql.startsWith('SELECT protected_observation,evidence_digest')?[{protected_observation:f.canonical,evidence_digest:digest(f.canonical)}]:[],rowCount:0}));
      vi.spyOn(f.service,'claimCurrent').mockResolvedValue(true);vi.spyOn(f.service,'nativeCallContext').mockResolvedValue({native});
      const wait=vi.spyOn(f.service,'nativeContextWait'),nativeWait=vi.spyOn(f.service,'nativeWait'),observe=vi.spyOn(f.service,'observe');
      f.provider.validateObservation=vi.fn(async()=>{throw old;});
      expect(await f.service.validateCheckpoints(claim)).toBe(false);expect(f.provider.validateObservation).toHaveBeenCalledOnce();
      const checkpointQueries=f.query.mock.calls.slice(beforeQueries);
      const finalized=checkpointQueries.find(([sql])=>sql.startsWith('UPDATE processing_requests SET state=$3,terminal_at=$4'))!;
      expect(finalized[1]).toEqual([claim.accountId,retryId,'FAILED',f.tx.now,'CHECKPOINT_DEPENDENCY_INVALID']);
      expect(wait).not.toHaveBeenCalled();expect(nativeWait).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();expect(known).toEqual(original);
      expect(checkpointQueries.some(([sql])=>sql.includes('AS input_matches')||sql.includes('INSERT INTO execution_evidence')||sql.startsWith('UPDATE checkpoints')||sql.startsWith('UPDATE executions'))).toBe(false);
    }finally{quota.release();f.controller.stopClaims();await f.controller.idle();}
  });
});
