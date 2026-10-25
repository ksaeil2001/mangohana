import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,expect,it,vi} from 'vitest';
import type {Settings} from '../../packages/contracts/src/wire.generated.js';
import {digest} from '../../packages/contracts/src/intent.js';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {canonicalInput,normalizeObservation,outputEnvelope,SyntheticProvider,type Observation,type ProviderAdapter,type StageInput} from '../../packages/domain/src/provider.js';
import {mergeScopedData} from '../../packages/domain/src/scope.js';
import type {EditData} from '../../packages/domain/src/model.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import {LocalTranslationAdapter,localTranslationPromptContract,type LocalTranslationConfig} from '../../packages/providers/src/local-translation.js';

// Owned in-memory ports only: no model, fetch, native job, PG or secret reader.
function fixture(stage='TRANSLATE'):StageInput {
  const executionId=randomUUID(),requestId=randomUUID(),contextId=randomUUID(),fontAssetId=randomUUID(),originalAssetId=randomUUID(),inputDigest='b'.repeat(64);
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId,baseFontSizePx:20,minFontSizePx:10};
  const data:EditData={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',blocks:[0,1,2].map(index=>({regionId:randomUUID(),geometry:{polygon:[{x:10,y:10+index*26},{x:90,y:10+index*26},{x:90,y:30+index*26},{x:10,y:30+index*26}],angleDegrees:0,readingOrder:index,orientation:'HORIZONTAL'},sourceText:{value:`原文${index}`,status:index===0?'USER_CONFIRMED':index===1?'USER_MODIFIED':'AI_PROPOSED'},translatedText:{value:`이전 번역${index}`,status:index===0?'USER_CONFIRMED':index===1?'USER_MODIFIED':'AI_PROPOSED'},fontAssetId,fontSizePx:20,appliedTranslation:{sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',modelContract:'synthetic-v1',promptContract:'original-user-reviewed-proposal-v1',originExecutionId:randomUUID()}})),renderSpecification:{version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[]}};
  data.renderSpecification!.blocks=data.blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'}));
  return {executionId,requestId,contextId,accountId:randomUUID(),stage,inputDigest,settings,scope:{kind:'PAGE'},originalAssetId,initialData:data,previousData:null,width:100,height:100,envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:stage,stageContract:settings.contractVersion,inputDigest,capturedSettings:settings,assetIds:[originalAssetId],regionIds:data.blocks.map(block=>block.regionId),checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:'synthetic-fixtures-v1'}};
}
const proposal=(input:StageInput)=>new SyntheticProvider().success(input);
function service(input:StageInput,validateObservation?:ProviderAdapter['validateObservation']) {
  const query=vi.fn(async()=>{throw Error('UNEXPECTED_OWNED_SQL');});
  const accountTransaction=vi.fn(async(accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({account:{account_id:accountId},client:{query},now:new Date('2026-10-07T00:00:00Z')} as unknown as Transaction)) as unknown as Database['accountTransaction'];
  const provider:ProviderAdapter={synthetic:false,dispatch:vi.fn(async()=>{throw Error('OWNED_MODEL_DISPATCH_FORBIDDEN');}),lookup:vi.fn(async()=>null),validateObservation};
  const policy:RequestPolicy={stageOrder:[input.stage],synthetic:false,paidEnabled:false,realProviderEnabled:false};
  return {execution:new ExecutionService({role:'trio_web_worker',accountTransaction} as unknown as Database,provider,policy),provider,query};
}
function checkpointService(input:StageInput,checkpoint:Observation) {
  const checkpointId=checkpoint.stageOutput!.checkpointId!,claim:Claim={accountId:input.accountId!,workId:randomUUID(),generation:'1',kind:'DISPATCH',ref:{requestId:input.requestId}};
  const request={account_id:input.accountId,request_id:input.requestId,state:'ACTIVE',hold_reasons:[]},stored=structuredClone(checkpoint),source=canonicalInput(input),now=new Date('2026-10-07T00:00:00Z');
  const query=vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT * FROM processing_requests'))return {rows:[structuredClone(request)],rowCount:1};
    if(sql.startsWith('SELECT * FROM work_items'))return {rows:[{state:'CLAIMED',claim_owner:execution.workerId,claim_generation:'1',lease_until:new Date(now.valueOf()+30000)}],rowCount:1};
    if(sql.startsWith('SELECT 1 FROM native_job_intents')||sql.startsWith('SELECT 1 FROM executions'))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT c.checkpoint_id'))return {rows:[{checkpoint_id:checkpointId,execution_id:input.executionId,output_envelope:structuredClone(stored)}],rowCount:1};
    if(sql.startsWith('SELECT request_id,logical_step_id,input_digest'))return {rows:[{request_id:input.requestId,logical_step_id:input.stage,input_digest:input.inputDigest}],rowCount:1};
    if(sql.startsWith('SELECT protected_observation,evidence_digest'))return {rows:[{protected_observation:structuredClone(source),evidence_digest:digest(source)}],rowCount:1};
    if(sql.startsWith('UPDATE processing_requests SET state=$3')||sql.startsWith('DELETE FROM active_page_requests')||sql.startsWith('UPDATE free_reservations'))return {rows:[],rowCount:1};
    throw Error('UNEXPECTED_OWNED_CHECKPOINT_SQL');
  });
  const accountTransaction=vi.fn(async(accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({account:{account_id:accountId},client:{query},now} as unknown as Transaction)) as unknown as Database['accountTransaction'];
  const provider:ProviderAdapter={synthetic:true,dispatch:vi.fn(async()=>{throw Error('OWNED_MODEL_DISPATCH_FORBIDDEN');}),lookup:vi.fn(async()=>null)};
  const execution=new ExecutionService({role:'trio_web_worker',accountTransaction} as unknown as Database,provider,{stageOrder:[input.stage],synthetic:true,paidEnabled:false,realProviderEnabled:false});
  return {execution,claim,query,stored,source,provider};
}

describe('confirmed text stays owned by the request capture during automatic proposals',()=>{
  it('protects PAGE confirmed text and prior translation provenance without changing raw AI or request input',async()=>{
    const input=fixture(),before=structuredClone(input),provider=new SyntheticProvider(),started=vi.fn(),raw=await provider.dispatch(input,started),rawBefore=structuredClone(raw),result=normalizeObservation(input,raw);
    expect(result.data!.blocks[0].translatedText).toEqual(before.initialData.blocks[0].translatedText);expect(result.data!.blocks[0].appliedTranslation).toEqual(before.initialData.blocks[0].appliedTranslation);
    expect(result.data!.blocks[1].translatedText).toEqual(raw.data!.blocks[1].translatedText);expect(result.data!.blocks[1].translatedText.status).toBe('AI_PROPOSED');expect(result.data!.blocks[1].appliedTranslation?.originExecutionId).toBe(input.executionId);
    expect(raw.data!.blocks[0].translatedText.status).toBe('AI_PROPOSED');expect(raw).toEqual(rawBefore);expect(input).toEqual(before);expect(provider.calls).toHaveLength(1);expect(started).toHaveBeenCalledOnce();
  });
  it('uses the captured previous-stage values rather than stale initial text',()=>{
    const input=fixture();input.previousData=structuredClone(input.initialData);input.previousData.blocks[0].translatedText.value='직전 단계의 확정 번역';input.previousData.blocks[0].appliedTranslation=null;
    const result=normalizeObservation(input,proposal(input));expect(result.data!.blocks[0].translatedText).toEqual(input.previousData.blocks[0].translatedText);expect(result.data!.blocks[0].appliedTranslation).toBeNull();
  });
  it('preserves selected confirmed REGIONS and byte-identical unselected blocks and render settings',()=>{
    const input=fixture();input.scope={kind:'REGIONS',regionIds:[input.initialData.blocks[0].regionId]};input.envelope!.regionIds=input.scope.regionIds;
    const raw=proposal(input);raw.data!.blocks[1].translatedText={value:'foreign automatic change',status:'AI_PROPOSED'};raw.data!.blocks[1].geometry.angleDegrees=30;raw.data!.renderSpecification!.blocks[1].minimumFontSizePx=8;
    const result=normalizeObservation(input,raw);expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(result.data!.blocks[0].appliedTranslation).toEqual(input.initialData.blocks[0].appliedTranslation);expect(result.data!.blocks.slice(1)).toEqual(input.initialData.blocks.slice(1));expect(result.data!.renderSpecification!.blocks.slice(1)).toEqual(input.initialData.renderSpecification!.blocks.slice(1));
  });
  it('protects the confirmed PAINTED block with the existing overlap policy',()=>{
    const input=fixture();input.scope={kind:'PAINTED',selectionId:randomUUID()};input.paintInclusion='ANY_OVERLAP';input.paintStrokes=[{radiusPx:1,points:[{x:10,y:20}]}];input.envelope!.regionIds=[input.initialData.blocks[0].regionId];
    const raw=proposal(input),result=normalizeObservation(input,raw);expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(result.data!.blocks.slice(1)).toEqual(input.initialData.blocks.slice(1));
  });
  it('protects same-ID confirmed OCR source and translation while retaining a new AI proposal separately',()=>{
    const input=fixture('OCR'),raw=proposal(input);raw.data!.blocks[0].sourceText={value:'AI認識',status:'AI_PROPOSED'};raw.data!.blocks[0].translatedText={value:'새 AI',status:'AI_PROPOSED'};raw.data!.blocks[0].appliedTranslation=null;
    raw.data!.blocks[1].sourceText={value:'明示的な再認識',status:'AI_PROPOSED'};const saved=structuredClone(raw),result=normalizeObservation(input,raw);
    expect(result.data!.blocks[0].sourceText).toEqual(input.initialData.blocks[0].sourceText);expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(result.data!.blocks[0].appliedTranslation).toEqual(input.initialData.blocks[0].appliedTranslation);expect(result.data!.blocks[1].sourceText).toEqual(raw.data!.blocks[1].sourceText);expect(raw).toEqual(saved);
  });
  it('rejects PAGE OCR that loses a confirmed ID instead of guessing from matching geometry',()=>{
    const input=fixture('OCR'),raw=proposal(input);raw.data!.blocks[0].regionId=randomUUID();raw.data!.renderSpecification!.blocks[0].regionId=raw.data!.blocks[0].regionId;const saved=structuredClone(raw);
    expect(()=>normalizeObservation(input,raw)).toThrow('STAGE_PROPOSAL_INVALID');expect(raw).toEqual(saved);
  });
  it('protects source-only confirmation while allowing explicit USER_MODIFIED retranslation and new provenance',()=>{
    const input=fixture();input.initialData.blocks[0].translatedText.status='USER_MODIFIED';const raw=proposal(input);raw.data!.blocks[0].sourceText={value:'AI source overwrite',status:'AI_PROPOSED'};
    const result=normalizeObservation(input,raw);expect(result.data!.blocks[0].sourceText).toEqual(input.initialData.blocks[0].sourceText);expect(result.data!.blocks[0].translatedText).toEqual(raw.data!.blocks[0].translatedText);expect(result.data!.blocks[0].appliedTranslation).toEqual(raw.data!.blocks[0].appliedTranslation);
  });
  it('leaves the existing manual merge able to explicitly edit confirmed text',()=>{
    const input=fixture(),edited=structuredClone(input.initialData);edited.blocks[0].translatedText={value:'사용자가 명시적으로 수정',status:'USER_MODIFIED'};edited.blocks[0].appliedTranslation=null;
    expect(mergeScopedData(input.initialData,edited,{kind:'PAGE'})).toEqual(edited);expect(mergeScopedData(input.initialData,edited,{kind:'REGIONS',regionIds:[edited.blocks[0].regionId]}).blocks[0]).toEqual(edited.blocks[0]);
  });
  it('passes protected values to CLEANUP and preserves strict TYPESET raw/prior digest equality',()=>{
    const input=fixture(),protectedData=normalizeObservation(input,proposal(input)).data!;const cleanup=fixture('CLEANUP');cleanup.initialData=protectedData;cleanup.envelope!.regionIds=protectedData.blocks.map(block=>block.regionId);
    const cleanupRaw:Observation={...proposal(cleanup),data:structuredClone(protectedData)},clean=normalizeObservation(cleanup,cleanupRaw);expect(clean.data).toEqual(protectedData);
    const typeset={...cleanup,stage:'TYPESET',previousData:clean.data,envelope:{...cleanup.envelope!,logicalStepId:'TYPESET'}},render:Observation={...cleanupRaw,data:structuredClone(clean.data)};expect(normalizeObservation(typeset,render).data).toEqual(clean.data);
    render.data!.blocks[0].translatedText={value:'silent wrong raster text',status:'AI_PROPOSED'};expect(()=>normalizeObservation(typeset,render)).toThrow('STAGE_PROPOSAL_INVALID');
  });
  it('keeps a normalized protected observation a fixed point including cost and evidence identity',()=>{
    const input=fixture(),raw=proposal(input),first=normalizeObservation(input,raw),second=normalizeObservation(input,first);expect(second).toEqual(first);expect(first.evidenceId).toBe(raw.evidenceId);expect(first.costUsd).toBe(raw.costUsd);expect(first.providerRef).toBe(raw.providerRef);expect(first.stageOutput!.protectedEvidenceRef).toBe(raw.evidenceId);
  });
});

describe('provider validation and checkpoint preservation use different observations',()=>{
  it('uses the actual local translation semantic validator on raw data while protected data remains a separate consumer result',async()=>{
    const input=fixture(),raw=proposal(input),root=join(tmpdir(),'trio-confirmed-semantic-validation-only');
    // Deliberately unactivated paths: this semantic check reads no file and
    // cannot qualify configuration, import a model or perform a dispatch.
    const config:LocalTranslationConfig={version:1,ownedTempRoot:root,python:{path:join(root,'never-run-python.exe'),sha256:'0'.repeat(64),bytesLength:1},worker:{path:join(root,'never-run-worker.py'),sha256:'0'.repeat(64),bytesLength:1},dependencyRoots:[join(root,'unused-deps')],dependencyPins:[],model:{path:join(root,'unused-model'),id:'facebook/m2m100_418M',revision:'5'.repeat(40),files:[]},settings:{modelId:input.settings.modelId,contractVersion:input.settings.contractVersion,reasoningLevel:input.settings.reasoningLevel},threads:2};
    const adapter=new LocalTranslationAdapter(config),dispatch=vi.spyOn(adapter,'dispatch').mockRejectedValue(Error('OWNED_ACTUAL_MODEL_FORBIDDEN')),lookup=vi.spyOn(adapter,'lookup').mockRejectedValue(Error('OWNED_ACTUAL_LOOKUP_FORBIDDEN'));
    raw.costUsd=null;raw.usageConfirmed=false;raw.finishReason='EOS_COMPLETE';for(const block of raw.data!.blocks)block.appliedTranslation!.promptContract=localTranslationPromptContract;
    await expect(adapter.validateObservation(input,raw)).resolves.toBeUndefined();await expect(adapter.validateObservation(input,normalizeObservation(input,raw))).rejects.toThrow('LOCAL_TRANSLATION_OBSERVATION_INVALID');
    const validate=vi.fn(adapter.validateObservation.bind(adapter)),f=service(input,validate),saved=structuredClone(raw),result=await f.execution.validated(input,raw);
    expect(result).toMatchObject({outcome:'SUCCESS',costUsd:null,usageConfirmed:false});expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(validate).toHaveBeenCalledOnce();expect(validate.mock.calls[0][1]).toEqual(saved);expect(raw).toEqual(saved);expect(dispatch).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('validates raw AI_PROPOSED data before handing protected text to stage consumers',async()=>{
    const input=fixture(),raw=proposal(input),saved=structuredClone(raw),validate=vi.fn<NonNullable<ProviderAdapter['validateObservation']>>(async(_input,value)=>{expect(value.data).toEqual(saved.data);expect(value.data!.blocks[0].translatedText.status).toBe('AI_PROPOSED');}),f=service(input,validate),result=await f.execution.validated(input,raw);
    expect(result.outcome).toBe('SUCCESS');expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(validate).toHaveBeenCalledOnce();expect(raw).toEqual(saved);expect(f.query).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
  it('does not hide a provider validation failure behind protected text or discard reported cost',async()=>{
    const input=fixture(),raw=proposal(input),saved=structuredClone(raw),validate=vi.fn<NonNullable<ProviderAdapter['validateObservation']>>(async()=>{throw Error('OWNED_RAW_PROPOSAL_INVALID');}),f=service(input,validate),result=await f.execution.validated(input,raw);
    expect(result).toMatchObject({outcome:'FAILURE',providerOutcome:'SUCCESS',data:null,finishReason:'STAGE_PROPOSAL_INVALID',costUsd:raw.costUsd,started:true});expect(validate).toHaveBeenCalledOnce();expect(raw).toEqual(saved);expect(f.provider.dispatch).not.toHaveBeenCalled();
  });
  it('reuses a protected fixed-point checkpoint without changing its bytes or issuing a provider call',async()=>{
    const input=fixture(),checkpoint=normalizeObservation(input,proposal(input));checkpoint.stageOutput!.checkpointId=randomUUID();const f=checkpointService(input,checkpoint),saved=structuredClone(f.stored);
    expect(await f.execution.validateCheckpoints(f.claim)).toBe(true);expect(f.claim.checkpointDigests).toEqual({[checkpoint.stageOutput!.checkpointId!]:digest(checkpoint)});expect(f.stored).toEqual(saved);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });
  it('rejects a legacy checkpoint that overwrote confirmed values without rewriting its protected evidence',async()=>{
    const input=fixture(),legacy=proposal(input);legacy.stageOutput={...outputEnvelope(input,legacy),checkpointId:randomUUID()};const f=checkpointService(input,legacy),saved=structuredClone(f.stored);
    expect(await f.execution.validateCheckpoints(f.claim)).toBe(false);expect(f.stored).toEqual(saved);expect(f.claim.checkpointDigests).toBeUndefined();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE processing_requests SET state=$3'))).toBe(true);expect(f.query.mock.calls.some(([sql])=>/^(INSERT|UPDATE|DELETE).*(execution_evidence|checkpoints)/.test(sql))).toBe(false);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
});

describe('manual typeset boxes stay owned by the captured request',()=>{
  it.each(['PAGE','REGIONS','PAINTED'] as const)('restores an existing box independently of confirmed text in %s scope',scope=>{
    const input=fixture(),spec=input.initialData.renderSpecification!.blocks[1],box={left:5,top:35,width:90,height:24};spec.typesetBox=box;
    if(scope==='REGIONS')input.scope={kind:'REGIONS',regionIds:[spec.regionId]};
    if(scope==='PAINTED'){input.scope={kind:'PAINTED',selectionId:randomUUID()};input.paintInclusion='ANY_OVERLAP';input.paintStrokes=[{radiusPx:1,points:[{x:10,y:45}]}];}
    if(scope!=='PAGE')input.envelope!.regionIds=[spec.regionId];
    const raw=proposal(input);raw.costUsd=null;raw.usageConfirmed=false;raw.data!.renderSpecification!.blocks[1].typesetBox={left:20,top:30,width:70,height:30};
    const saved=structuredClone(raw),captured=structuredClone(input),result=normalizeObservation(input,raw);
    expect(result.data!.renderSpecification!.blocks[1].typesetBox).toEqual(box);expect(result.data!.blocks[1].translatedText).toEqual(raw.data!.blocks[1].translatedText);
    expect(result.data!.blocks[0]).toEqual(input.initialData.blocks[0]);expect(result.data!.blocks[0].appliedTranslation).toEqual(input.initialData.blocks[0].appliedTranslation);
    expect(normalizeObservation(input,result)).toEqual(result);expect(result).toMatchObject({costUsd:null,usageConfirmed:false});expect(raw).toEqual(saved);expect(input).toEqual(captured);
  });
  it('restores an omitted same-ID box from previous-stage capture and preserves its reusable checkpoint',async()=>{
    const input=fixture();input.previousData=structuredClone(input.initialData);const spec=input.previousData.renderSpecification!.blocks[1];spec.typesetBox={left:0,top:30,width:100,height:28};
    const raw=proposal(input);delete raw.data!.renderSpecification!.blocks[1].typesetBox;const saved=structuredClone(raw),result=normalizeObservation(input,raw);
    expect(result.data!.renderSpecification!.blocks[1].typesetBox).toEqual(spec.typesetBox);expect(raw).toEqual(saved);
    result.stageOutput!.checkpointId=randomUUID();const f=checkpointService(input,result),stored=structuredClone(f.stored);
    expect(await f.execution.validateCheckpoints(f.claim)).toBe(true);expect(f.stored).toEqual(stored);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
  it.each(['EXISTING','UNSELECTED','NOVEL'] as const)('rejects a raw proposal injecting a user box into %s',kind=>{
    const input=fixture(),raw=proposal(input);let spec=raw.data!.renderSpecification!.blocks[0];
    if(kind==='UNSELECTED'){input.scope={kind:'REGIONS',regionIds:[input.initialData.blocks[0].regionId]};input.envelope!.regionIds=input.scope.regionIds;spec=raw.data!.renderSpecification!.blocks[2];}
    if(kind==='NOVEL'){const block=structuredClone(raw.data!.blocks[2]);block.regionId=randomUUID();block.geometry.readingOrder=3;raw.data!.blocks.push(block);spec={regionId:block.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'};raw.data!.renderSpecification!.blocks.push(spec);}
    spec.typesetBox={left:0,top:0,width:100,height:100};const saved=structuredClone(raw);expect(()=>normalizeObservation(input,raw)).toThrow('STAGE_PROPOSAL_INVALID');expect(raw).toEqual(saved);
  });
  it('maps lost manual-box identity to FAILURE with provider success and original reported cost',async()=>{
    const input=fixture('OCR');input.initialData.renderSpecification!.blocks[1].typesetBox={left:0,top:30,width:100,height:28};
    const raw=proposal(input);delete raw.data!.renderSpecification!.blocks[1].typesetBox;raw.data!.blocks[1].regionId=randomUUID();raw.data!.renderSpecification!.blocks[1].regionId=raw.data!.blocks[1].regionId;
    raw.costUsd='0.027';raw.usageConfirmed=true;const saved=structuredClone(raw),f=service(input),result=await f.execution.validated(input,raw);
    expect(result).toMatchObject({outcome:'FAILURE',providerOutcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'STAGE_PROPOSAL_INVALID',data:null});expect(raw).toEqual(saved);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('permits unconfirmed OCR ID replacement without a box and keeps strict TYPESET equality',()=>{
    const input=fixture('OCR');input.initialData.renderSpecification!.blocks[2].typesetBox={left:0,top:60,width:100,height:30};
    const raw=proposal(input);raw.data!.blocks[1].regionId=randomUUID();raw.data!.renderSpecification!.blocks[1].regionId=raw.data!.blocks[1].regionId;
    expect(normalizeObservation(input,raw).data!.blocks[1].regionId).toBe(raw.data!.blocks[1].regionId);
    const typeset={...input,stage:'TYPESET',envelope:{...input.envelope!,logicalStepId:'TYPESET'}},render=proposal(typeset);render.data!.renderSpecification!.blocks[2].typesetBox!.left=1;render.data!.renderSpecification!.blocks[2].typesetBox!.width=99;
    expect(()=>normalizeObservation(typeset,render)).toThrow('STAGE_PROPOSAL_INVALID');
  });
});


describe('manual target directions stay owned independently of boxes and text confirmation',()=>{
  it.each(['PAGE','REGIONS','PAINTED'] as const)('restores a captured target-only override from a raw changed proposal in %s',scope=>{
    const input=fixture(),spec=input.initialData.renderSpecification!.blocks[1];spec.targetOrientation='VERTICAL';
    if(scope==='REGIONS')input.scope={kind:'REGIONS',regionIds:[spec.regionId]};if(scope==='PAINTED'){input.scope={kind:'PAINTED',selectionId:randomUUID()};input.paintInclusion='ANY_OVERLAP';input.paintStrokes=[{radiusPx:1,points:[{x:10,y:45}]}];}if(scope!=='PAGE')input.envelope!.regionIds=[spec.regionId];
    const raw=proposal(input);raw.data!.renderSpecification!.blocks[1].targetOrientation='HORIZONTAL';raw.costUsd=null;raw.usageConfirmed=false;const saved=structuredClone(raw),captured=structuredClone(input),result=normalizeObservation(input,raw);
    expect(result.data!.renderSpecification!.blocks[1].targetOrientation).toBe('VERTICAL');expect(result.data!.renderSpecification!.blocks[1]).not.toHaveProperty('typesetBox');expect(result.data!.blocks[1].geometry).toEqual(input.initialData.blocks[1].geometry);expect(result.data!.blocks[1].translatedText).toEqual(raw.data!.blocks[1].translatedText);expect(result.data!.blocks[0].translatedText).toEqual(input.initialData.blocks[0].translatedText);expect(normalizeObservation(input,result)).toEqual(result);expect(result).toMatchObject({costUsd:null,usageConfirmed:false});expect(raw).toEqual(saved);expect(input).toEqual(captured);
  });
  it('restores an omitted equal-to-source override from previous-stage capture and reuses its checkpoint without a call',async()=>{
    const input=fixture();input.previousData=structuredClone(input.initialData);const spec=input.previousData.renderSpecification!.blocks[1];spec.targetOrientation='HORIZONTAL';const raw=proposal(input);delete raw.data!.renderSpecification!.blocks[1].targetOrientation;const saved=structuredClone(raw),result=normalizeObservation(input,raw);
    expect(result.data!.renderSpecification!.blocks[1]).toHaveProperty('targetOrientation','HORIZONTAL');expect(raw).toEqual(saved);result.stageOutput!.checkpointId=randomUUID();const f=checkpointService(input,result),stored=structuredClone(f.stored);expect(await f.execution.validateCheckpoints(f.claim)).toBe(true);expect(f.stored).toEqual(stored);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
  it.each(['EXISTING','UNSELECTED','NOVEL'] as const)('rejects an injected target-only user override for %s',kind=>{
    const input=fixture(),raw=proposal(input);let spec=raw.data!.renderSpecification!.blocks[0];if(kind==='UNSELECTED'){input.scope={kind:'REGIONS',regionIds:[input.initialData.blocks[0].regionId]};input.envelope!.regionIds=input.scope.regionIds;spec=raw.data!.renderSpecification!.blocks[2];}if(kind==='NOVEL'){const block=structuredClone(raw.data!.blocks[2]);block.regionId=randomUUID();block.geometry.readingOrder=3;raw.data!.blocks.push(block);spec={regionId:block.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'};raw.data!.renderSpecification!.blocks.push(spec);}spec.targetOrientation='VERTICAL';const saved=structuredClone(raw);expect(()=>normalizeObservation(input,raw)).toThrow('STAGE_PROPOSAL_INVALID');expect(raw).toEqual(saved);
  });
  it.each(['REGION','SPECIFICATION'] as const)('fails lost target-only %s identity while retaining provider success and cost',async loss=>{
    const input=fixture('OCR');input.initialData.renderSpecification!.blocks[1].targetOrientation='VERTICAL';const raw=proposal(input);if(loss==='REGION'){delete raw.data!.renderSpecification!.blocks[1].targetOrientation;raw.data!.blocks[1].regionId=randomUUID();raw.data!.renderSpecification!.blocks[1].regionId=raw.data!.blocks[1].regionId;}else delete raw.data!.renderSpecification;
    raw.costUsd='0.027';raw.usageConfirmed=true;const saved=structuredClone(raw),f=service(input),result=await f.execution.validated(input,raw);expect(result).toMatchObject({outcome:'FAILURE',providerOutcome:'SUCCESS',started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'STAGE_PROPOSAL_INVALID',data:null});expect(raw).toEqual(saved);expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('restores target and box together but rejects TYPESET raw mutation and omission',()=>{
    const input=fixture(),spec=input.initialData.renderSpecification!.blocks[1];spec.targetOrientation='VERTICAL';spec.typesetBox={left:0,top:30,width:100,height:28};const raw=proposal(input);delete raw.data!.renderSpecification!.blocks[1].targetOrientation;delete raw.data!.renderSpecification!.blocks[1].typesetBox;const result=normalizeObservation(input,raw);expect(result.data!.renderSpecification!.blocks[1]).toEqual(spec);
    const typeset={...input,stage:'TYPESET',envelope:{...input.envelope!,logicalStepId:'TYPESET'}};for(const mutate of [true,false]){const render=proposal(typeset);if(mutate)render.data!.renderSpecification!.blocks[1].targetOrientation='HORIZONTAL';else delete render.data!.renderSpecification!.blocks[1].targetOrientation;expect(()=>normalizeObservation(typeset,render)).toThrow('STAGE_PROPOSAL_INVALID');}
  });
});
