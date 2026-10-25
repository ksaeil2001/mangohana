import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {canonicalInput,type StageInput,type Observation} from '../../packages/domain/src/provider.js';
import {FullStageCostCalculator} from '../../packages/domain/src/full-stage-cost.js';
import type {CheckpointValidationAttempt,CheckpointValidationOperation} from '../../packages/domain/src/checkpoint-validation.js';

const bounds={maxRecordBytes:65536,maxRecords:64,maxTargets:8,maxJobs:16};
const calculator={maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512};
type Row={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};
let Journal:typeof import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationJournal;
beforeEach(async()=>{const module=await import('../../packages/domain/src/checkpoint-validation.js').catch(()=>null);Journal=module?.CheckpointValidationJournal as typeof Journal;});
function fixture(withTarget=true){
  const accountId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),pageId=randomUUID(),assetId=randomUUID(),sourceId=randomUUID(),consumerId=randomUUID();
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'synthetic-ocr-translation',reasoningLevel:'LOW' as const,fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const asset={assetId,sha256:sha256('owned-checkpoint'),bytesLength:'7',mediaType:'image/png'};
  const input=(executionId:string,stage:string):StageInput=>({accountId,contextId,executionId,requestId,stage,inputDigest:sha256(stage),settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,assetDependencies:[asset],envelope:{executionId,requestId,logicalStepId:stage,contextId,contextGeneration:'1',pageLineageId:pageId,stageContract:'synthetic-v1',inputDigest:sha256(stage),assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.01',parameterProfileVersion:'synthetic-fixtures-v1'}});
  const source=input(sourceId,'OCR'),consumer=input(consumerId,withTarget?'TRANSLATE':'OCR'),checkpointId=randomUUID();
  const output:Observation={evidenceId:randomUUID(),outcome:'SUCCESS',started:true,costUsd:'0',usageConfirmed:true,finishReason:'OWNED',providerRef:null,data:source.initialData,outputAssetIds:[],assetDependencies:[asset],stageOutput:{executionId:sourceId,inputDigest:source.inputDigest,stageContract:'synthetic-v1',outcome:'CONFIRMED_SUCCESS',protectedEvidenceRef:'',outputAssetIds:[],checkpointId,usageState:'CONFIRMED',actualCostUsd:'0',finishReason:'OWNED'}};output.stageOutput!.protectedEvidenceRef=output.evidenceId;
  if(withTarget)consumer.envelope!.checkpointDependencies=[{checkpointId,originRequestId:requestId,originExecutionId:sourceId,logicalStepId:'OCR',stageContract:'synthetic-v1',modelContract:'synthetic-v1',inputDigest:source.inputDigest,dependencyDigest:source.inputDigest,assetIds:[]}];
  const histories=new Map<string,Row[]>(),cores=new Map<string,Record<string,unknown>>(),steps:Record<string,unknown>[]=[],assets:Record<string,unknown>[]=[{asset_id:assetId,sha256:asset.sha256,bytes_length:asset.bytesLength,media_type:asset.mediaType,object_key:accountId+'/'+assetId,purpose:'LIVE',deletion_state:'NOT_DUE',object_created_at:'2026-10-15 00:00:00+00',verified_at:'2026-10-15 00:00:00+00',access_deadline:null}];
  const owner={contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'0',workspaceRevision:'2'};
  const add=(executionId:string,kind:string,value:unknown,wrap=true)=>{const evidence_id=randomUUID(),i=executionId===sourceId?source:consumer,protected_observation=wrap?{version:1,accountId,executionId,inputDigest:i.inputDigest,inputFingerprint:digest(canonicalInput(i)),kind,value}:value,row={evidence_id,evidence_digest:digest(protected_observation),protected_evidence_ref:evidence_id,kind,protected_observation};histories.get(executionId)!.push(row);return row;};
  const order=withTarget?['OCR','TRANSLATE']:['OCR'];
  for(const i of withTarget?[source,consumer]:[consumer]){
    histories.set(i.executionId,[]);add(i.executionId,'INPUT',canonicalInput(i),false);
    const capture=new FullStageCostCalculator(null,calculator).capture({accountId,executionId:i.executionId,inputDigest:i.inputDigest,inputFingerprint:digest(canonicalInput(i)),stage:i.stage as 'OCR',profileDigest:sha256('owned-profile'),mode:'FREE'});
    add(i.executionId,'OPERATIONAL_COST_BASIS',{version:1,capture,captureDigest:capture.captureDigest,snapshot:null,snapshotDigest:null});
    cores.set(i.executionId,{request_id:requestId,logical_step_id:i.stage,input_digest:i.inputDigest,contract_version:'synthetic-v1',state:i===source?'SUCCEEDED':'PREPARED',claim_generation:'1',context_id:contextId,context_generation:'1',page_lineage_id:pageId,expected_result_revision:'0',captured_stage_order:order,captured_settings:settings,owner,current:true});
  }
  if(withTarget)steps.push({ordinal:0,logical_step_id:'OCR',checkpoint_id:checkpointId,execution_id:sourceId,origin_request_id:requestId,dependency_digest:source.inputDigest,stage_contract:'synthetic-v1',verification_state:'VERIFIED',execution_state:'SUCCEEDED',output_envelope:output});
  steps.push({ordinal:withTarget?1:0,logical_step_id:consumer.stage,checkpoint_id:null,execution_id:consumerId,origin_request_id:requestId,dependency_digest:consumer.inputDigest,stage_contract:'synthetic-v1',verification_state:null,execution_state:'PREPARED',output_envelope:null});
  const nativeJobs:Record<string,unknown>[]=[],sql:string[]=[];
  const query=async(text:string,values:unknown[]=[])=>{
    sql.push(text);let rows:unknown[]=[];
    if(text.includes('checkpoint-validation:core'))rows=[cores.get(values[1] as string)].filter(Boolean);
    else if(text.includes('checkpoint-validation:evidence'))rows=histories.get(values[1] as string)??[];
    else if(text.includes('checkpoint-validation:targets'))rows=steps;
    else if(text.includes('checkpoint-validation:assets'))rows=assets.filter(a=>(values[1] as string[]).includes(a.asset_id as string));
    else if(text.includes('checkpoint-validation:windows-set'))rows=[{value:null,overflow:false}];
    else if(text.includes('checkpoint-validation:windows-absence'))rows=nativeJobs;
    else if(text.includes('checkpoint-validation:jobs'))rows=nativeJobs;
    else if(text.includes('INSERT INTO execution_evidence')){const row={evidence_id:values[1],evidence_digest:values[4],protected_evidence_ref:values[1],kind:values[3],protected_observation:JSON.parse(values[6] as string)};histories.get(values[2] as string)!.push(row as Row);rows=[{evidence_id:values[1]}];}
    else throw new Error('UNEXPECTED_QUERY '+text.slice(0,120));
    return {rows:structuredClone(rows),rowCount:rows.length};
  };
  const db={role:'trio_web_worker'} as Database,tx={account:{account_id:accountId,access_state:'ACTIVE'},now:new Date('2026-10-15T00:01:00Z'),client:{query}} as unknown as Transaction;
  const journal=()=>{expect(Journal).toBeTypeOf('function');return new Journal(db,bounds);};
  const operation=(attempt:CheckpointValidationAttempt):CheckpointValidationOperation=>({version:1,operationId:randomUUID(),attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:'checkpoint-validation-v1',targetDigest:digest(attempt.targets[0]),sourceInputFingerprint:digest(canonicalInput(source)),outputDigest:digest(output),semantic:{eventId:randomUUID(),kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage:[{eventId:randomUUID(),kind:'OBJECT_READ',assetId,sha256:asset.sha256,bytesLength:asset.bytesLength,outcome:'RETURNED'}],native:[]});
  return {journal,tx,db,consumer,source,histories,cores,steps,assets,asset,owner,output,add,operation,nativeJobs,sql};
}

describe('bounded DB checkpoint validation journal',()=>{
  it('seals exact DB source INPUT/BASIS/output and accepts only this attempt raw operations',async()=>{
    const f=fixture(),j=f.journal(),attempt=await j.beginIn(f.tx,f.consumer,'PRE_DISPATCH');expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0]).toMatchObject({checkpointId:f.consumer.envelope!.checkpointDependencies[0].checkpointId,sourceExecutionId:f.source.executionId,outputDigest:digest(f.output)});
    expect(await j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH')).toMatchObject({state:'WAIT'});
    const row=f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',f.operation(attempt));
    expect(await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}]})).toMatchObject({state:'VERIFIED',jobIds:[]});
    expect(await j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH')).toMatchObject({state:'VERIFIED'});
  });
  it('verifies an empty pre-dispatch target set without making fake operations',async()=>{const f=fixture(false),j=f.journal(),attempt=await j.beginIn(f.tx,f.consumer,'PRE_DISPATCH');expect(attempt.targets).toEqual([]);expect(await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[]})).toMatchObject({state:'VERIFIED',jobIds:[]});expect(f.histories.get(f.consumer.executionId)!.filter(r=>r.kind==='CHECKPOINT_VALIDATION_OPERATION')).toEqual([]);});
  it('holds caller-only success, absent raw operations and a different attempt',async()=>{
    const f=fixture(),j=f.journal(),attempt=await j.beginIn(f.tx,f.consumer,'PRE_DISPATCH');
    for(const facts of [{attemptId:attempt.attemptId,operations:[]},{attemptId:attempt.attemptId,operations:[{evidenceId:randomUUID(),evidenceDigest:sha256('absent')}]},{attemptId:attempt.attemptId,operations:[],verified:true}])expect(await j.recordIn(f.tx,f.consumer,attempt,facts)).toMatchObject({state:'WAIT'});
    const operation=f.operation(attempt);operation.attemptId=randomUUID();const row=f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',operation);expect(await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}]})).toMatchObject({state:'WAIT'});
  });
  it.each(['storage','semantic','source','digest','owner','asset','deadline','missing-job'] as const)('keeps %s mismatch WAIT without returning a verified prefix',async mode=>{
    const f=fixture(),j=f.journal(),attempt=await j.beginIn(f.tx,f.consumer,'PRE_DISPATCH'),operation=f.operation(attempt);
    if(mode==='storage')operation.storage=[];if(mode==='semantic')operation.semantic.outcome='UNKNOWN' as 'RETURNED';if(mode==='source')operation.sourceInputFingerprint=sha256('wrong-source');if(mode==='digest')operation.outputDigest=sha256('changed-output');
    const row=f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',operation);
    if(mode==='owner')f.owner.ownerRevision='1';if(mode==='asset')f.assets[0].deletion_state='CONFIRMED';if(mode==='deadline')f.assets[0].access_deadline='2026-10-14 00:00:00+00';if(mode==='missing-job')f.nativeJobs.push({job_id:randomUUID()});
    expect(await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}]})).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
  });
  it('requires the final own checkpoint and rejects final metadata without raw storage completion',async()=>{const f=fixture(false),j=f.journal();f.cores.get(f.consumer.executionId)!.state='SUCCEEDED';await expect(j.beginIn(f.tx,f.consumer,'FINAL_COMMIT')).rejects.toMatchObject({nextAction:'WAIT'});expect(await j.finalCommitIn(f.tx,f.consumer)).toBe('WAIT');});
  it('rejects bounded record/target/encoded overflow before any partial acceptance',async()=>{
    const f=fixture(false),j=f.journal();for(let at=0;at<64;at++)f.add(f.consumer.executionId,'OWNED_UNRELATED',{at});await expect(j.beginIn(f.tx,f.consumer,'PRE_DISPATCH')).rejects.toMatchObject({nextAction:'WAIT'});
    const other=fixture(false);other.add(other.consumer.executionId,'OWNED_OVERSIZED',{text:'x'.repeat(65536)});await expect(other.journal().beginIn(other.tx,other.consumer,'PRE_DISPATCH')).rejects.toMatchObject({nextAction:'WAIT'});
  });
});

describe('checkpoint completion and historical source boundaries',()=>{
  it('returns exact completed empty-predecessor IDs at the LaMa fence',async()=>{
    const f=fixture(false),j=f.journal(),attempt=await j.beginIn(f.tx,f.consumer,'PRE_DISPATCH'),view=await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[]});
    expect(view.state).toBe('VERIFIED');expect(await j.verifiedPredecessorsIn(f.tx,f.consumer)).toEqual({evidenceIds:view.evidenceIds,jobIds:[]});
  });
  it('rejects a self-cycle instead of treating the current INPUT as a predecessor',async()=>{const f=fixture(),j=f.journal();f.consumer.envelope!.checkpointDependencies[0].originExecutionId=f.consumer.executionId;await expect(j.verifiedPredecessorsIn(f.tx,f.consumer)).rejects.toMatchObject({nextAction:'WAIT'});});
  it('allows only the identical sealed final commit and observes asset/owner/output changes',async()=>{
    const f=fixture(false),j=f.journal(),checkpointId=randomUUID();f.cores.get(f.consumer.executionId)!.state='SUCCEEDED';
    const output={...structuredClone(f.output),stageOutput:{...f.output.stageOutput!,executionId:f.consumer.executionId,inputDigest:f.consumer.inputDigest,checkpointId}};f.steps[0]={...f.steps[0],checkpoint_id:checkpointId,verification_state:'VERIFIED',execution_state:'SUCCEEDED',output_envelope:output};
    const attempt=await j.beginIn(f.tx,f.consumer,'FINAL_COMMIT');expect(attempt.targets).toHaveLength(1);expect(attempt.targets[0].sourceExecutionId).toBe(f.consumer.executionId);
    const operation=f.operation(attempt);operation.sourceInputFingerprint=digest(canonicalInput(f.consumer));operation.outputDigest=digest(output);const row=f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',operation);
    expect(await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}]})).toMatchObject({state:'VERIFIED'});expect(await j.finalCommitIn(f.tx,f.consumer)).toBe('ELIGIBLE');
    f.assets[0].deletion_state='DUE';expect(await j.finalCommitIn(f.tx,f.consumer)).toBe('WAIT');f.assets[0].deletion_state='NOT_DUE';f.owner.ownerRevision='2';expect(await j.finalCommitIn(f.tx,f.consumer)).toBe('WAIT');
  });
});

describe('checkpoint caller graph bound before encoding',()=>{
  it('stops repeated alias expansion within the per-record node budget',async()=>{
    const f=fixture(false),j=new Journal(f.db,{...bounds,maxRecordBytes:256});let graph:unknown={leaf:'x'};for(let at=0;at<17;at++)graph={left:graph,right:graph};
    const original=Object.getPrototypeOf;let visits=0;const watched=vi.spyOn(Object,'getPrototypeOf').mockImplementation(value=>{visits++;return original(value);});
    try{await expect(j.beginIn(f.tx,graph as StageInput,'PRE_DISPATCH')).rejects.toMatchObject({nextAction:'WAIT'});}finally{watched.mockRestore();}
    expect(visits).toBeLessThanOrEqual(512);expect(f.sql).toEqual([]);
  });
});
describe('sealed final cost history is separate from publication authority',()=>{
  async function sealed(){
    const f=fixture(false),j=f.journal(),checkpointId=randomUUID();f.cores.get(f.consumer.executionId)!.state='SUCCEEDED';const output={...structuredClone(f.output),stageOutput:{...f.output.stageOutput!,executionId:f.consumer.executionId,inputDigest:f.consumer.inputDigest,checkpointId}};f.steps[0]={...f.steps[0],checkpoint_id:checkpointId,verification_state:'VERIFIED',execution_state:'SUCCEEDED',output_envelope:output};
    const attempt=await j.beginIn(f.tx,f.consumer,'FINAL_COMMIT'),operation=f.operation(attempt);operation.sourceInputFingerprint=digest(canonicalInput(f.consumer));operation.outputDigest=digest(output);const raw=f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',operation),view=await j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:raw.evidence_id,evidenceDigest:raw.evidence_digest}]});expect(view.state).toBe('VERIFIED');const joined=f.histories.get(f.consumer.executionId)!.filter(row=>view.evidenceIds.includes(row.evidence_id)).map(row=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}));return {...f,j,view,joined};
  }
  it('keeps historical final cost VERIFIED after request/context/owner/retention changes with no new asset read',async()=>{
    const f=await sealed();expect(f.j.sealedFinalCostIn).toBeTypeOf('function');f.cores.get(f.consumer.executionId)!.current=false;f.owner.ownerRevision='9';f.assets[0].deletion_state='CONFIRMED';f.assets[0].access_deadline='2026-10-14 00:00:00+00';f.assets.splice(0);const before=f.sql.length;
    expect(await f.j.sealedFinalCostIn(f.tx,f.consumer,f.joined)).toBe('VERIFIED');expect(f.sql.slice(before).some(sql=>sql.includes('checkpoint-validation:assets'))).toBe(false);expect(await f.j.finalCommitIn(f.tx,f.consumer)).toBe('WAIT');
  });
  it.each(['operation','verified','attempt','target','joined-digest','joined-missing'] as const)('keeps missing or changed %s cost history WAIT',async mode=>{
    const f=await sealed();expect(f.j.sealedFinalCostIn).toBeTypeOf('function');const rows=f.histories.get(f.consumer.executionId)!;
    if(mode==='operation')rows.splice(rows.findIndex(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION'),1);
    if(mode==='verified')rows.splice(rows.findIndex(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED'),1);
    if(mode==='attempt')rows.push(structuredClone(rows.find(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')!));
    if(mode==='target'){const row=rows.find(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')!;(row.protected_observation as {value:{targets:{outputDigest:string}[]}}).value.targets[0].outputDigest=sha256('changed-target');}
    if(mode==='joined-digest')f.joined[0].evidenceDigest=sha256('changed-join');if(mode==='joined-missing')f.joined.pop();expect(await f.j.sealedFinalCostIn(f.tx,f.consumer,f.joined)).toBe('WAIT');
  });
});


import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {createWindowsNativeSignedReceiptFixture,windowsFrameLimits} from '../fixtures/windows-native.js';
import type {NativeSealedReceiptV2} from '../../packages/domain/src/native-receipts.js';
import type {WindowsNativeCostScope} from '../../packages/domain/src/windows-native-cost.js';

async function b3Checkpoint(purpose:'PRE_DISPATCH'|'FINAL_COMMIT'='PRE_DISPATCH',cacheTarget?:'EXECUTION'|'REQUEST_CHECKPOINT',cpuFresh=false){
  const f=fixture(purpose==='PRE_DISPATCH'),j=f.journal();
  if(purpose==='FINAL_COMMIT'){
    const checkpointId=randomUUID();f.cores.get(f.consumer.executionId)!.state='SUCCEEDED';
    const output={...structuredClone(f.output),stageOutput:{...f.output.stageOutput!,executionId:f.consumer.executionId,inputDigest:f.consumer.inputDigest,checkpointId}};
    f.steps[0]={...f.steps[0],checkpoint_id:checkpointId,verification_state:'VERIFIED',execution_state:'SUCCEEDED',output_envelope:output};
  }
  const attempt=await j.beginIn(f.tx,f.consumer,purpose),target=attempt.targets[0],source=target.sourceExecutionId===f.consumer.executionId?f.consumer:f.source;
  const begin=f.histories.get(f.consumer.executionId)!.find(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT')!,basis=f.histories.get(source.executionId)!.find(row=>row.kind==='OPERATIONAL_COST_BASIS')!;
  const claim={generation:attempt.claimGeneration,ownerId:randomUUID(),workItemId:randomUUID()},rootOwner={executionId:f.consumer.executionId,inputEvidenceId:attempt.inputEvidenceId,inputFingerprint:attempt.inputFingerprint,basisRef:{evidenceId:attempt.basisEvidenceId,evidenceDigest:attempt.basisEvidenceDigest},claim,validationAttemptRef:null},owner={...rootOwner,validationAttemptRef:{evidenceId:begin.evidence_id,evidenceDigest:begin.evidence_digest}};
  const output=f.steps.find(row=>row.checkpoint_id===target.checkpointId)!.output_envelope as Observation;
  const nativeTarget={accountId:source.accountId!,targetKind:'REQUEST_CHECKPOINT' as const,targetId:f.consumer.requestId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',f.consumer.requestId,source,output),protectedOwnerCapture:structuredClone(attempt.owner),claim,sourceInput:{executionId:source.executionId,inputEvidenceId:target.input.evidenceId,stageInputDigest:source.inputDigest}};
  const inputs=new Map<string,Buffer>(),job=createNativeJob('POLYGON_MASK',digest(syntheticProfile),{profile:syntheticProfile,width:source.width,height:source.height,polygons:[]},inputs,windowsFrameLimits),blobs=new Map([['mask',Buffer.from([0])]]),result=createNativeResult(job,{metadata:{maskBlobId:'mask',width:1,height:1},blobs},windowsFrameLimits);
  const producerTarget=cacheTarget?{...nativeTarget,targetKind:cacheTarget,targetId:cacheTarget==='EXECUTION'?source.executionId:f.consumer.requestId,semanticCaptureDigest:nativeExecutionCaptureDigest(cacheTarget==='EXECUTION'?'INPUT':'CHECKPOINT',f.consumer.requestId,source,cacheTarget==='EXECUTION'?undefined:output),claim:{...claim,ownerId:randomUUID(),workItemId:randomUUID()}}:nativeTarget;
  const signed=createWindowsNativeSignedReceiptFixture({input:canonicalInput(source),inputRef:target.input,basis:{ref:target.basis,value:basis.protected_observation},target:producerTarget,frame:{envelope:job,blobs:inputs},result:{envelope:result,blobs}});
  if(cacheTarget)signed.sealed.origin='CACHE';
  const scopeBody={version:1 as const,scopeId:randomUUID(),owner,target:nativeTarget,phase:'CHECKPOINT' as const,validationTargetDigest:digest(target)},scope:WindowsNativeCostScope={...scopeBody,scopeDigest:digest(scopeBody)};
  const callBody={version:1 as const,callId:randomUUID(),scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,kernelDigest:signed.binding.kernelDigest,operationInputDigest:signed.intent.operationInputDigest,componentId:'native-mask'},call={...callBody,callDigest:digest(callBody)};
  const scopeRef={evidenceId:scope.scopeId,evidenceDigest:scope.scopeDigest},callRef={evidenceId:call.callId,evidenceDigest:call.callDigest};
  const identity={key:signed.key,scopeRef,callRef,componentId:'native-mask',sourceOperation:{evidenceId:randomUUID(),evidenceDigest:sha256('원 작업')},sourceTermination:{evidenceId:randomUUID(),evidenceDigest:sha256('원 종료')},classification:'FRESH' as const};
  const row=(kind:string,id:string,ref:{evidenceId:string;evidenceDigest:string}|null,contentDigest:string)=>({kind,id,ref,contentDigest,completedAt:null});
  const windows={overflow:false,value:{owner:rootOwner,components:[{task:job.task,componentId:'native-mask'}],scopes:[scope],rows:[row('SCOPE',scope.scopeId,scopeRef,scope.scopeDigest),row('CALL',call.callId,callRef,call.callDigest),row('BINDING',job.jobId,{evidenceId:randomUUID(),evidenceDigest:sha256('원 귀속')},sha256('원 귀속 본문')),row('INTENT',job.jobId,null,signed.bundle.original.intentDigest)],originals:[identity]},metadata:[{job_id:job.jobId,intent:signed.intent,kernel_digest:signed.binding.kernelDigest}],live:true,sqlFailure:null as Error|null,bundle:signed.bundle,proof:true};

  if(cacheTarget){
    windows.value.rows=windows.value.rows.filter(item=>item.kind!=='BINDING');
    windows.value.rows.push(row('CACHE_USE',call.callId+'/'+job.jobId,{evidenceId:randomUUID(),evidenceDigest:digest({callId:call.callId,source:signed.sealed})},digest(signed.sealed)));
    if(cpuFresh){
      const oldBody={...scopeBody,scopeId:randomUUID(),owner:{...owner,claim:producerTarget.claim,validationAttemptRef:{evidenceId:randomUUID(),evidenceDigest:sha256('원 PRE 시도')}},target:producerTarget},oldScope={...oldBody,scopeDigest:digest(oldBody)};
      const oldCallBody={...callBody,callId:randomUUID(),scopeId:oldScope.scopeId,scopeDigest:oldScope.scopeDigest},oldCall={...oldCallBody,callDigest:digest(oldCallBody)};
      identity.scopeRef={evidenceId:oldScope.scopeId,evidenceDigest:oldScope.scopeDigest};identity.callRef={evidenceId:oldCall.callId,evidenceDigest:oldCall.callDigest};windows.value.scopes.push(oldScope);
      windows.value.rows.push(row('SCOPE',oldScope.scopeId,identity.scopeRef,oldScope.scopeDigest),row('CALL',oldCall.callId,identity.callRef,oldCall.callDigest),row('BINDING',job.jobId,{evidenceId:randomUUID(),evidenceDigest:sha256('원 PRE 귀속')},sha256('원 PRE 귀속 본문')));
    }else{identity.classification='CACHE' as typeof identity.classification;identity.scopeRef=null as unknown as typeof identity.scopeRef;identity.callRef=null as unknown as typeof identity.callRef;}
  }

  f.nativeJobs.push({job_id:job.jobId,native_kind:'WINDOWS'});
  const originalQuery=f.tx.client.query.bind(f.tx.client);
  f.tx.client.query=(async(text:string,values:unknown[]=[])=>{
    if(text.includes('checkpoint-validation:windows-')){
      f.sql.push(text);if(windows.sqlFailure)throw windows.sqlFailure;
      if(text.includes('windows-set'))return {rows:[{value:structuredClone(windows.value),overflow:windows.overflow}],rowCount:1};
      if(text.includes('windows-absence'))return {rows:structuredClone(f.nativeJobs),rowCount:f.nativeJobs.length};
      if(text.includes('windows-meta'))return {rows:structuredClone(windows.metadata),rowCount:windows.metadata.length};
      if(text.includes('windows-bundle'))return {rows:[{bundle:structuredClone(windows.bundle)}],rowCount:1};
      if(text.includes('windows-current'))return {rows:windows.live?[{work_item_id:claim.workItemId}]:[],rowCount:windows.live?1:0};
      if(text.includes('windows-receipt'))return {rows:windows.proof?[{candidate_digest:sha256('SQL 후보'),receipt_digest:sha256('SQL 영수증'),result_observation_id:signed.sealed.candidate.resultObservationId,termination_observation_id:signed.bundle.state.facts.observations[1].evidenceId}]:[],rowCount:windows.proof?1:0};
    }
    return originalQuery(text,values);
  }) as typeof f.tx.client.query;
  const operation=f.operation(attempt);operation.sourceInputFingerprint=target.inputFingerprint;operation.outputDigest=target.outputDigest;
  operation.native=[signed.sealed] as unknown as CheckpointValidationOperation['native'];
  const put=()=>f.add(f.consumer.executionId,'CHECKPOINT_VALIDATION_OPERATION',operation);
  const record=async()=>{const op=put();return j.recordIn(f.tx,f.consumer,attempt,{attemptId:attempt.attemptId,operations:[{evidenceId:op.evidence_id,evidenceDigest:op.evidence_digest}]});};
  return {...f,j,attempt,target,source,signed,scope,call,identity,windows,operation,record,put,rootOwner};
}

describe('B3-B 비어 있지 않은 v2 체크포인트',()=>{
  it.each(['PRE_DISPATCH','FINAL_COMMIT'] as const)('%s 원 서명과 현재 시도 집합을 검증한다',async purpose=>{
    const f=await b3Checkpoint(purpose);expect(f.operation.native).toHaveLength(1);
    expect(await f.record()).toMatchObject({state:'VERIFIED',jobIds:[f.signed.binding.jobId]});
    expect(f.sql.some(sql=>sql.includes('windows_native_evidence_lookup('))).toBe(true);
    expect(await f.j.lookupIn(f.tx,f.consumer,purpose)).toMatchObject({state:'VERIFIED',jobIds:[f.signed.binding.jobId]});
    if(purpose==='FINAL_COMMIT')expect(await f.j.finalCommitIn(f.tx,f.consumer)).toBe('ELIGIBLE');
  });
});


describe('B3-B v2 원자료와 집합 거부',()=>{
  it.each(['candidate-version','proof-version','proof-ref','extra-proof','termination','signature','sql-observation-digest','source-input','basis','missing-proof','missing-bundle','missing-current-job','foreign-attempt','foreign-target','foreign-consumer','unknown-origin','storage','semantic','expired-claim'] as const)('%s를 성공으로 바꾸지 않는다',async fault=>{
    const f=await b3Checkpoint(),sealed=f.operation.native[0] as NativeSealedReceiptV2;
    if(fault==='candidate-version')Reflect.set(sealed.candidate,'version',1);
    if(fault==='proof-version')Reflect.set(sealed.receipt,'version',1);
    if(fault==='proof-ref')sealed.receipt.windowsEvidenceRef.linkDigest=sha256('다른 LINK');
    if(fault==='extra-proof')Reflect.set(sealed.receipt,'extra',true);
    if(fault==='termination')sealed.termination.kind='NO_CHILD_CREATED';
    if(fault==='signature')f.windows.bundle.state.facts.link.signature='A'.repeat(86)+'==';
    if(fault==='sql-observation-digest')f.windows.bundle.observationDigests[0]=digest(f.windows.bundle.state.facts.observations[0].value);
    if(fault==='source-input')f.windows.bundle.original.sourceInputEvidenceId=randomUUID();
    if(fault==='basis')f.windows.bundle.state.facts.basis!.evidenceDigest=sha256('다른 BASIS');
    if(fault==='missing-proof')f.windows.proof=false;
    if(fault==='missing-bundle')Reflect.set(f.windows,'bundle',null);
    if(fault==='missing-current-job')f.operation.native=[];
    if(fault==='foreign-attempt')f.scope.owner.validationAttemptRef!.evidenceId=randomUUID();
    if(fault==='foreign-target')f.scope.validationTargetDigest=sha256('다른 target');
    if(fault==='foreign-consumer')f.scope.owner.executionId=randomUUID();
    if(fault==='unknown-origin')Reflect.set(sealed,'origin','MISSING');
    if(fault==='storage')f.operation.storage=[];
    if(fault==='semantic')Reflect.set(f.operation.semantic,'outcome','THREW');
    if(fault==='expired-claim')f.windows.live=false;
    expect(await f.record()).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
    expect(f.histories.get(f.consumer.executionId)!.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED')).toHaveLength(0);
  });
  it.each(['42501','40001','40P01','ACK'] as const)('원 SQL 또는 %s 오류를 WAIT로 숨기지 않는다',async sqlCode=>{
    const f=await b3Checkpoint(),error=Object.assign(new Error('원 인프라 오류'),{code:sqlCode});f.windows.sqlFailure=error;await expect(f.record()).rejects.toBe(error);
  });
  it('같은 작업 중복과 혼합 버전 위장을 거부한다',async()=>{const f=await b3Checkpoint();f.operation.native.push(structuredClone(f.operation.native[0]));expect(await f.record()).toMatchObject({state:'WAIT'});});
});

describe('B3-B CACHE 현재 사용처와 원 CPU 분리',()=>{
  it.each(['EXECUTION','REQUEST_CHECKPOINT'] as const)('원 %s receipt와 현재 CACHE_USE를 각각 확인한다',async origin=>{
    const f=await b3Checkpoint('PRE_DISPATCH',origin),before=structuredClone({sealed:f.signed.sealed,bundle:f.signed.bundle,key:f.signed.key});
    expect(await f.record()).toMatchObject({state:'VERIFIED',jobIds:[f.signed.binding.jobId]});
    expect({sealed:f.signed.sealed,bundle:f.signed.bundle,key:f.signed.key}).toEqual(before);expect(f.sql.some(sql=>/admit|GRANT_GO|INSERT INTO native/.test(sql))).toBe(false);
  });
  it('같은 실행의 과거 PRE CPU는 FRESH이고 현재 FINAL 사용은 CACHE일 수 있다',async()=>{
    const f=await b3Checkpoint('FINAL_COMMIT','REQUEST_CHECKPOINT',true);expect(f.identity.classification).toBe('FRESH');expect(f.operation.native[0].origin).toBe('CACHE');
    expect(await f.record()).toMatchObject({state:'VERIFIED',jobIds:[f.signed.binding.jobId]});
  });
  it.each(['missing-native','missing-use','use-content','use-reference','call-digest','metadata-missing','false-fresh','different-attempt'] as const)('%s를 현재 CACHE 검증으로 인정하지 않는다',async fault=>{
    const f=await b3Checkpoint('FINAL_COMMIT','REQUEST_CHECKPOINT',true),use=f.windows.value.rows.find(row=>row.kind==='CACHE_USE')!;
    if(fault==='missing-native')f.operation.native=[];
    if(fault==='missing-use')f.windows.value.rows=f.windows.value.rows.filter(row=>row.kind!=='CACHE_USE');
    if(fault==='use-content')use.contentDigest=digest({callId:f.call.callId,source:f.signed.sealed});
    if(fault==='use-reference')use.ref!.evidenceDigest=digest(f.signed.sealed);
    if(fault==='call-digest')f.windows.value.rows.find(row=>row.kind==='CALL'&&row.id===f.call.callId)!.contentDigest=digest(f.call);
    if(fault==='metadata-missing')f.windows.metadata=[];
    if(fault==='false-fresh')f.operation.native[0].origin='FRESH';
    if(fault==='different-attempt')f.scope.owner.validationAttemptRef!.evidenceId=randomUUID();
    expect(await f.record()).toMatchObject({state:'WAIT',jobIds:[]});
  });
});

describe('B3-B v2 역사 비용과 예산',()=>{
  it('역사 FINAL은 현재 claim과 자산을 다시 허가하지 않고 원 ref만 확인한다',async()=>{
    const f=await b3Checkpoint('FINAL_COMMIT');expect((await f.record()).state).toBe('VERIFIED');
    const view=await f.j.lookupIn(f.tx,f.consumer,'FINAL_COMMIT'),joined=f.histories.get(f.consumer.executionId)!.filter(row=>view.evidenceIds.includes(row.evidence_id)).map(row=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}));
    f.windows.live=false;f.cores.get(f.consumer.executionId)!.current=false;f.owner.ownerRevision='9';f.assets.splice(0);const before=f.sql.length;
    expect(await f.j.sealedFinalCostIn(f.tx,f.consumer,joined)).toBe('VERIFIED');
    expect(f.sql.slice(before).some(sql=>sql.includes('windows-current')||sql.includes('checkpoint-validation:assets'))).toBe(false);
    expect(await f.j.finalCommitIn(f.tx,f.consumer)).toBe('WAIT');
    joined[0].evidenceDigest=sha256('다른 ref');expect(await f.j.sealedFinalCostIn(f.tx,f.consumer,joined)).toBe('WAIT');
  });
  it('정상 job 상한1을 허용하고 동일 상한의 2개 목록은 일부도 봉인하지 않는다',async()=>{
    const f=await b3Checkpoint(),j=new Journal(f.db,{...bounds,maxJobs:1}),raw=f.put(),facts={attemptId:f.attempt.attemptId,operations:[{evidenceId:raw.evidence_id,evidenceDigest:raw.evidence_digest}]};
    expect(await j.recordIn(f.tx,f.consumer,f.attempt,facts)).toMatchObject({state:'VERIFIED'});
    const other=await b3Checkpoint();other.operation.native.push(structuredClone(other.operation.native[0]));const row=other.put();expect(await new Journal(other.db,{...bounds,maxJobs:1}).recordIn(other.tx,other.consumer,other.attempt,{attemptId:other.attempt.attemptId,operations:[{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}]})).toMatchObject({state:'WAIT'});
  });
  it('과대한 bundle과 반복 alias를 누적 예산 전에 거부한다',async()=>{
    const f=await b3Checkpoint();Reflect.set(f.windows.bundle,'unexpected','x'.repeat(bounds.maxRecordBytes));expect(await f.record()).toMatchObject({state:'WAIT'});
    const other=await b3Checkpoint();let aliases:unknown={leaf:'x'};for(let at=0;at<17;at++)aliases={left:aliases,right:aliases};Reflect.set(other.windows,'bundle',aliases);expect(await other.record()).toMatchObject({state:'WAIT'});
  });
});


describe('B3-B 원 집합 조회 미확정을 빈 목록으로 바꾸지 않는다',()=>{
  it('CENSUS null과 실제 Windows footprint에서 native 누락을 거부한다',async()=>{const f=await b3Checkpoint();f.operation.native=[];Reflect.set(f.windows,'value',null);expect(await f.record()).toMatchObject({state:'WAIT',jobIds:[]});});
  it('투영 byte 초과는 빈 native와 metadata0에서도 WAIT다',async()=>{const f=await b3Checkpoint();f.operation.native=[];f.nativeJobs.splice(0);f.windows.overflow=true;Reflect.set(f.windows,'value',null);expect(await f.record()).toMatchObject({state:'WAIT',jobIds:[]});});
});

import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {NativeReceiptStore,type NativeReceiptCandidate,type NativeReceiptProduced,type NativeVerifiedReceipt} from '../../packages/domain/src/native-receipts.js';

type B3CheckpointFixture=Awaited<ReturnType<typeof b3Checkpoint>>;

// DB와 객체 저장소는 명시적인 메모리 fake다. v1 candidate와 receipt는
// NativeReceiptStore가 원 v1 job/result에서 생성하며 v2 자료를 변환하지 않는다.
async function b3AddLegacyReceipt(f:B3CheckpointFixture){
  const target=f.scope.target,metadata={profile:syntheticProfile,width:f.source.width,height:f.source.height,polygons:[]};
  const inputs=new Map<string,Buffer>(),computation={metadata:{maskBlobId:'mask',width:1,height:1},blobs:new Map([['mask',Buffer.from([0])]])};
  const job=createNativeJob('POLYGON_MASK',digest(syntheticProfile),metadata,inputs,windowsFrameLimits),result=createNativeResult(job,computation,windowsFrameLimits);
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:structuredClone(target.protectedOwnerCapture),claim:structuredClone(target.claim)};
  const intent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)};
  const termination:NativeReceiptProduced['termination']={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const resultObservationId=randomUUID(),terminationObservationId=randomUUID(),resultObservationDigest=digest({version:1,parentInstanceId:intent.parentInstanceId,event:'RESULT',code:'OK',resultDigest:digest(result),termination:{...termination,isolation:'OWNED_FIXTURE'}});
  const produced:NativeReceiptProduced={intent,job,result,resultObservationId,resultObservationDigest,termination};
  let prepared:NativeReceiptCandidate|undefined,verified:NativeVerifiedReceipt|undefined;
  const db={accountTransaction:async(accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>{
    expect(accountId).toBe(f.consumer.accountId);
    return run({...f.tx,client:{query:async(text:string,values:unknown[]=[])=>{
      if(text.includes('native_receipt_prepare(')){prepared=JSON.parse(values[0] as string) as NativeReceiptCandidate;return {rows:[{decision:{allowed:true,reason:'FAKE_PREPARED',candidate:structuredClone(prepared)}}]};}
      if(text.includes('native_receipt_register_asset('))return {rows:[{decision:{allowed:true,reason:'FAKE_REGISTERED'}}]};
      if(text.includes('native_receipt_verify(')){verified=JSON.parse(values[1] as string) as NativeVerifiedReceipt;return {rows:[{decision:{allowed:true,reason:'FAKE_VERIFIED'}}]};}
      throw new Error('예상하지 않은 v1 fake DB 호출');
    }}} as unknown as Transaction);
  }} as unknown as Database;
  const bytes=new Map<string,Buffer>(),receipts=new Map<string,ObjectReceipt>();
  const objects:ObjectStore={bucket:'b3b-domain-fake',put:vi.fn(async(key,data)=>{
    const receipt:ObjectReceipt={key,sha256:sha256(data),bytesLength:String(data.length),completedAt:f.tx.now.toISOString(),completedAtPrecisionMilliseconds:1};
    bytes.set(key,Buffer.from(data));receipts.set(key,receipt);return structuredClone(receipt);
  }),receipt:vi.fn(async key=>structuredClone(receipts.get(key)??null)),read:vi.fn(async key=>{
    const value=bytes.get(key);if(!value)throw new Error('v1 fake 객체 없음');return Buffer.from(value);
  }),remove:vi.fn(async()=>{throw new Error('v1 fake 객체 삭제 금지');})};
  const store=new NativeReceiptStore(db,objects,target,sha256('B3-B 원 v1 합성 kernel'),{input:windowsFrameLimits,output:windowsFrameLimits},()=>produced);
  await store.seal('POLYGON_MASK',metadata,inputs,computation);
  const sealed=store.sealedRecord('POLYGON_MASK',metadata,inputs);
  expect(sealed.candidate).toEqual(prepared);expect(sealed.receipt).toEqual(verified);
  const proof={candidate_digest:digest(prepared),receipt_digest:digest(verified),result_observation_id:resultObservationId,termination_observation_id:terminationObservationId};
  // 필수 job은 호출자의 native 배열과 독립적으로 DB fake에 먼저 등록한다.
  f.nativeJobs.push({job_id:job.jobId,native_kind:'V1'});
  const originalQuery=f.tx.client.query.bind(f.tx.client);
  f.tx.client.query=(async(text:string,values:unknown[]=[])=>{
    if(text.includes('checkpoint-validation:receipt')&&values[2]===job.jobId){f.sql.push(text);return {rows:[structuredClone(proof)],rowCount:1};}
    return originalQuery(text,values);
  }) as typeof f.tx.client.query;
  f.operation.native.push(sealed);
  return {sealed,objects,job,prepared,verified};
}

async function b3TwoCachedJobs(){
  const f=await b3Checkpoint('PRE_DISPATCH','EXECUTION'),first=f.signed;
  const inputs=first.frame.blobs,job=createNativeJob(first.frame.envelope.task,first.frame.envelope.profileDigest,first.frame.envelope.metadata,inputs,windowsFrameLimits);
  const result=createNativeResult(job,{metadata:first.result.envelope.metadata,blobs:first.result.blobs},windowsFrameLimits);
  const basis=f.histories.get(f.source.executionId)!.find(row=>row.kind==='OPERATIONAL_COST_BASIS')!;
  const target={accountId:f.source.accountId!,targetKind:first.intent.targetKind,targetId:first.intent.targetId,semanticCaptureDigest:first.intent.semanticCaptureDigest,protectedOwnerCapture:structuredClone(first.intent.protectedOwnerCapture),claim:structuredClone(first.intent.claim),sourceInput:f.scope.target.sourceInput};
  const second=createWindowsNativeSignedReceiptFixture({input:canonicalInput(f.source),inputRef:f.target.input,basis:{ref:f.target.basis,value:basis.protected_observation},target,frame:{envelope:job,blobs:inputs},result:{envelope:result,blobs:first.result.blobs},kernelDigest:first.binding.kernelDigest});
  second.sealed.origin='CACHE';
  f.windows.value.originals.push({...structuredClone(f.identity),key:second.key,sourceOperation:{evidenceId:randomUUID(),evidenceDigest:sha256('두 번째 원 작업')},sourceTermination:{evidenceId:randomUUID(),evidenceDigest:sha256('두 번째 원 종료')}});
  f.windows.value.rows.push({kind:'INTENT',id:job.jobId,ref:null,contentDigest:second.bundle.original.intentDigest,completedAt:null},{kind:'CACHE_USE',id:f.call.callId+'/'+job.jobId,ref:{evidenceId:randomUUID(),evidenceDigest:digest({callId:f.call.callId,source:second.sealed})},contentDigest:digest(second.sealed),completedAt:null});
  f.windows.metadata.push({job_id:job.jobId,intent:second.intent,kernel_digest:second.binding.kernelDigest});
  f.nativeJobs.push({job_id:job.jobId,native_kind:'WINDOWS'});
  const originalQuery=f.tx.client.query.bind(f.tx.client);
  f.tx.client.query=(async(text:string,values:unknown[]=[])=>{
    if(text.includes('checkpoint-validation:windows-bundle')&&(JSON.parse(values[0] as string) as {binding:{jobId:string}}).binding.jobId===job.jobId){f.sql.push(text);return {rows:[{bundle:structuredClone(second.bundle)}],rowCount:1};}
    if(text.includes('checkpoint-validation:windows-receipt')&&values[2]===job.jobId){
      f.sql.push(text);return {rows:[{candidate_digest:digest(second.sealed.candidate),receipt_digest:digest(second.sealed.receipt),result_observation_id:second.sealed.candidate.resultObservationId,termination_observation_id:second.bundle.state.facts.observations[1].evidenceId}],rowCount:1};
    }
    return originalQuery(text,values);
  }) as typeof f.tx.client.query;
  f.operation.native.push(second.sealed);
  return {...f,second,requiredJobIds:[first.binding.jobId,second.binding.jobId]};
}

// 기존 두 단계 fixture에 합성 CLEANUP 입력을 추가하며 검증 처리는 복제하지 않는다.
async function b3Successor(f:B3CheckpointFixture){
  const checkpointId=randomUUID(),evidenceId=randomUUID();
  const output:Observation={...structuredClone(f.output),evidenceId,stageOutput:{...f.output.stageOutput!,executionId:f.consumer.executionId,inputDigest:f.consumer.inputDigest,checkpointId,protectedEvidenceRef:evidenceId}};
  f.cores.get(f.consumer.executionId)!.state='SUCCEEDED';
  f.steps[1]={...f.steps[1],checkpoint_id:checkpointId,verification_state:'VERIFIED',execution_state:'SUCCEEDED',output_envelope:output};
  const next=structuredClone(f.consumer);next.executionId=randomUUID();next.stage='CLEANUP';next.inputDigest=sha256('B3-B 다음 CLEANUP 입력');
  Object.assign(next.envelope!,{executionId:next.executionId,logicalStepId:next.stage,inputDigest:next.inputDigest});
  next.envelope!.checkpointDependencies.push({checkpointId,originRequestId:f.consumer.requestId,originExecutionId:f.consumer.executionId,logicalStepId:f.consumer.stage,stageContract:'synthetic-v1',modelContract:'synthetic-v1',inputDigest:f.consumer.inputDigest,dependencyDigest:f.consumer.inputDigest,assetIds:[]});
  for(const core of f.cores.values())core.captured_stage_order=['OCR','TRANSLATE','CLEANUP'];
  f.cores.set(next.executionId,{...structuredClone(f.cores.get(f.consumer.executionId)!),logical_step_id:next.stage,input_digest:next.inputDigest,state:'PREPARED'});
  const row=(kind:string,value:unknown):Row=>{const id=randomUUID();return {evidence_id:id,evidence_digest:digest(value),protected_evidence_ref:id,kind,protected_observation:value};};
  const capture=new FullStageCostCalculator(null,calculator).capture({accountId:next.accountId!,executionId:next.executionId,inputDigest:next.inputDigest,inputFingerprint:digest(canonicalInput(next)),stage:'CLEANUP',profileDigest:sha256('owned-profile'),mode:'FREE'});
  const basis={version:1,accountId:next.accountId,executionId:next.executionId,inputDigest:next.inputDigest,inputFingerprint:digest(canonicalInput(next)),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture,captureDigest:capture.captureDigest,snapshot:null,snapshotDigest:null}};
  f.histories.set(next.executionId,[row('INPUT',canonicalInput(next)),row('OPERATIONAL_COST_BASIS',basis)]);
  f.steps.push({...f.steps[1],ordinal:2,logical_step_id:next.stage,checkpoint_id:null,execution_id:next.executionId,dependency_digest:next.inputDigest,verification_state:null,execution_state:'PREPARED',output_envelope:null});
  const empty=await f.j.beginIn(f.tx,f.source,'PRE_DISPATCH'),sourceView=await f.j.recordIn(f.tx,f.source,empty,{attemptId:empty.attemptId,operations:[]});
  expect(sourceView.state).toBe('VERIFIED');
  return {next,sourceView};
}

describe('B3-B 추가 domain 호환성',()=>{
  it('원 v1 저장소가 만든 영수증을 Windows 원자료 없이 검증한다',async()=>{
    const f=await b3Checkpoint();f.operation.native=[];f.nativeJobs.splice(0);Reflect.set(f.windows,'value',null);
    const legacy=await b3AddLegacyReceipt(f);
    expect(legacy.sealed).toMatchObject({candidate:{version:1},receipt:{version:1},origin:'FRESH'});
    expect(legacy.objects.put).toHaveBeenCalledTimes(1);expect(legacy.objects.read).toHaveBeenCalledTimes(1);
    const view=await f.record();expect(view).toMatchObject({state:'VERIFIED',jobIds:[legacy.job.jobId]});
    expect(await f.j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH')).toMatchObject({state:'VERIFIED',jobIds:view.jobIds});
  });

  it.each(['v1 먼저','v2 먼저'] as const)('%s 혼합 배열의 서로 다른 필수 job을 모두 봉인한다',async order=>{
    const f=await b3Checkpoint(),legacy=await b3AddLegacyReceipt(f);if(order==='v1 먼저')f.operation.native.reverse();
    const expected=[f.signed.binding.jobId,legacy.job.jobId].sort();expect(new Set(expected).size).toBe(2);
    const view=await f.record();expect(view.state).toBe('VERIFIED');expect(view.jobIds.slice().sort()).toEqual(expected);
    const lookup=await f.j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH');expect(lookup.state).toBe('VERIFIED');expect(lookup.jobIds.slice().sort()).toEqual(expected);
  });

  it.each([1,2] as const)('혼합 배열에서 DB에 남은 v%s 한 항목이 빠지면 일부도 봉인하지 않는다',async version=>{
    const f=await b3Checkpoint();await b3AddLegacyReceipt(f);
    f.operation.native=f.operation.native.filter(item=>item.candidate.version!==version);
    expect(f.nativeJobs).toHaveLength(2);expect(f.operation.native).toHaveLength(1);
    expect(await f.record()).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
    expect(f.histories.get(f.consumer.executionId)!.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED')).toHaveLength(0);
  });

  it.each([1,2] as const)('혼합 배열의 v%s proof 버전이 뒤바뀌면 정상 항목까지 승인하지 않는다',async version=>{
    const f=await b3Checkpoint();await b3AddLegacyReceipt(f);
    const item=f.operation.native.find(item=>item.candidate.version===version)!;Reflect.set(item.receipt,'version',version===1?2:1);
    expect(await f.record()).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
    expect(f.histories.get(f.consumer.executionId)!.filter(row=>row.kind==='CHECKPOINT_VALIDATION_VERIFIED')).toHaveLength(0);
  });

  it('종료된 과거 claim은 PREDECESSOR에서 읽고 같은 CURRENT lease는 거부한다',async()=>{
    const f=await b3Checkpoint(),view=await f.record();expect(view.state).toBe('VERIFIED');
    const {next,sourceView}=await b3Successor(f),expected={evidenceIds:[...sourceView.evidenceIds,...view.evidenceIds],jobIds:[f.signed.binding.jobId]};
    expect(await f.j.verifiedPredecessorsIn(f.tx,next)).toEqual(expected);
    f.windows.live=false;
    expect(await f.j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH')).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
    expect(await f.j.verifiedPredecessorsIn(f.tx,next)).toEqual(expected);
    f.cores.get(f.consumer.executionId)!.claim_generation='2';
    expect(await f.j.verifiedPredecessorsIn(f.tx,next)).toEqual(expected);
    f.windows.proof=false;
    await expect(f.j.verifiedPredecessorsIn(f.tx,next)).rejects.toMatchObject({nextAction:'WAIT'});
  });

  it('하나의 CALL metadata를 공유하는 별도 CACHE job 둘을 독립 DB 목록과 검증한다',async()=>{
    const f=await b3TwoCachedJobs();expect(new Set(f.requiredJobIds).size).toBe(2);
    expect(f.second.intent.operationInputDigest).toBe(f.signed.intent.operationInputDigest);
    expect(f.windows.value.rows.filter(row=>row.kind==='CALL')).toHaveLength(1);
    const raw=f.put(),j=new Journal(f.db,{...bounds,maxJobs:2}),view=await j.recordIn(f.tx,f.consumer,f.attempt,{attemptId:f.attempt.attemptId,operations:[{evidenceId:raw.evidence_id,evidenceDigest:raw.evidence_digest}]});
    expect(view.state).toBe('VERIFIED');expect(view.jobIds.slice().sort()).toEqual(f.requiredJobIds.slice().sort());
    const lookup=await j.lookupIn(f.tx,f.consumer,'PRE_DISPATCH');expect(lookup.state).toBe('VERIFIED');expect(lookup.jobIds.slice().sort()).toEqual(f.requiredJobIds.slice().sort());
  });

  it.each([0,1] as const)('같은 CALL의 CACHE job %s만 빠져도 독립 DB 목록 때문에 거부한다',async index=>{
    const f=await b3TwoCachedJobs();f.operation.native.splice(index,1);
    expect(f.windows.metadata).toHaveLength(2);expect(f.nativeJobs).toHaveLength(2);
    expect(await f.record()).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
  });

  it('서로 다른 두 CACHE job은 maxJobs 1에서 중복 검사와 독립적으로 거부한다',async()=>{
    const f=await b3TwoCachedJobs(),raw=f.put();expect(new Set(f.requiredJobIds).size).toBe(2);
    expect(await new Journal(f.db,{...bounds,maxJobs:1}).recordIn(f.tx,f.consumer,f.attempt,{attemptId:f.attempt.attemptId,operations:[{evidenceId:raw.evidence_id,evidenceDigest:raw.evidence_digest}]})).toMatchObject({state:'WAIT',evidenceIds:[],jobIds:[]});
  });
});
