import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import {vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,createNativeResult,nativeJsonBytes,type NativeTask} from '../../packages/native/src/dto.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {FullStageCostCalculator} from '../../packages/domain/src/full-stage-cost.js';
import type {OperationalStageCostWorkSet,CostEvidenceRef} from '../../packages/domain/src/pipeline-stage-cost.js';
import {windowsNativeScript,windowsNativeLimits} from '../fixtures/windows-native.js';

import {expect,it} from 'vitest';
import {WindowsNativeCostJournal} from '../../packages/domain/src/windows-native-cost.js';
import {OperationalStageCost} from '../../packages/domain/src/pipeline-stage-cost.js';

it('W4-B2 exposes an explicit Windows whole-stage factory before any operational activation',()=>{
  const factory=Object.getOwnPropertyDescriptor(OperationalStageCost,'windows');
  expect(factory?.value,'W4-B2 Windows factory is missing while generic work readers cannot seal the Windows original set').toBeTypeOf('function');
});

it.each(['stageLookupIn','stageProjectIn','stageSealIn'] as const)('W4-B2 exposes the bounded journal capability %s without native IO',method=>{
  expect(Object.getOwnPropertyDescriptor(WindowsNativeCostJournal.prototype,method)?.value).toBeTypeOf('function');
});

function specimen(noChild=false,accounting:Record<string,string>={},source:{accountId?:string;inputBytes?:number;basisBytes?:number;input?:StageInput;inputEvidenceId?:string}={}){
  const signing=generateKeyPairSync('ed25519'),accountId=source.input?.accountId??source.accountId??randomUUID(),executionId=source.input?.executionId??randomUUID(),contextId=source.input?.contextId??randomUUID(),requestId=source.input?.requestId??randomUUID(),inputId=source.inputEvidenceId??randomUUID(),assetId=source.input?.originalAssetId??randomUUID(),kernel=sha256('w4a synthetic kernel');
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'synthetic-ocr-translation',reasoningLevel:'LOW' as const,fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const input:StageInput=source.input?structuredClone(source.input):{accountId,contextId,executionId,requestId,stage:'OCR',inputDigest:sha256('원 StageInput semantic digest'),settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,envelope:{executionId,requestId,logicalStepId:'OCR',contextId,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:sha256('원 StageInput semantic digest'),assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.01',parameterProfileVersion:syntheticProfile.id}};
  if(source.inputBytes){const block={regionId:randomUUID(),geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}] as [{x:number;y:number},{x:number;y:number},{x:number;y:number}],angleDegrees:0,readingOrder:1,orientation:'HORIZONTAL' as const},sourceText:{value:'',status:'AI_PROPOSED' as const},translatedText:{value:'',status:'AI_PROPOSED' as const},fontAssetId:input.settings.fontAssetId,fontSizePx:20,appliedTranslation:null};input.initialData.blocks=[block];block.sourceText.value='x'.repeat(source.inputBytes-Buffer.byteLength(JSON.stringify(input)));}
  const sourceInput={executionId,inputEvidenceId:inputId,stageInputDigest:input.inputDigest},inputs=new Map([['entry',Buffer.from([1,2,3])]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'unit.bin',blobId:'entry'}]},inputs,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  const archive=Buffer.alloc(22);archive.writeUInt32LE(0x06054b50);const result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:22},blobs:new Map([['archive',archive]])},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:'EXECUTION' as const,targetId:executionId,semanticCaptureDigest:sha256('원 semantic capture'),protectedOwnerCapture:{contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:randomUUID()}};
  const intent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},intentDigest=sha256('원 SQL intent jsonb text');
  const binding:NativeControllerBinding={accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:kernel};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'},pins={executableDigest:sha256('node'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('helper'),runtimeFilesDigest:sha256('runtime'),nativeLimitsDigest:digest(windowsNativeLimits)};
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'windows-w4a-domain-v1',maxSlots:2,nativeProfileDigest:job.profileDigest,kernelDigest:kernel,controllerId:randomUUID(),keyVersion:'key-v1',environmentDigest:sha256('environment'),publicKeySpki:signing.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:w4a/domain-fake'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('controller SID'),childSidDigest:sha256('child SID'),appContainerSidDigest:sha256('AppContainer SID')}};
  const reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('원 SQL profile jsonb'),profileVersion:profile.version};
  let basis:{evidenceId:string;evidenceDigest:string;value:unknown}|null=null;
  if(source.basisBytes){
    const snapshot={version:1 as const,state:'MEASURED' as const,stage:'OCR' as const,profileDigest:job.profileDigest,basisVersion:'source-synthetic-rate',usdScale:12 as const,rounding:'HALF_UP' as const,evidenceRefs:['synthetic-source-rate'],components:[{componentId:'cpu',kind:'IMAGE' as const,unit:'windows-job-cpu-second-v1',rateVersion:'source-cpu',usdPerUnit:'0.000000000001',evidenceRefs:['synthetic-source-rate']}]};
    const calc=new FullStageCostCalculator(snapshot,{maxInputBytes:1048576,maxOutputBytes:786432,maxComponents:64,maxEvidenceRefs:8192,maxStringBytes:4096}).calculate({accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),stage:'OCR',profileDigest:job.profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
    const value={version:1,accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:calc.capture,captureDigest:calc.captureDigest,snapshot,snapshotDigest:digest(snapshot)}};
    while(Buffer.byteLength(JSON.stringify(value))+4100<source.basisBytes)snapshot.evidenceRefs.push('ref'+snapshot.evidenceRefs.length+':'+ 'x'.repeat(4000));
    snapshot.evidenceRefs.push('');const remaining=source.basisBytes-Buffer.byteLength(JSON.stringify(value));snapshot.evidenceRefs[snapshot.evidenceRefs.length-1]='x'.repeat(remaining);value.value.snapshotDigest=digest(snapshot);basis={evidenceId:randomUUID(),evidenceDigest:digest(value),value};
  }
  const basisRef=basis?{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest}:null;
  const identity={binding,intentDigest,sourceInput,inputEvidenceDigest:digest(input),inputFingerprint:digest(input),basisRef};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const prepare={identity,authority,pins,policy,limits:windowsNativeLimits,frame:{envelope:job,blobs:inputs}},script=windowsNativeScript(prepare,noChild?'NOT_ATTEMPTED':'CREATED',accounting),goGrantRef=noChild?null:{jobId:job.jobId,rowDigest:sha256('원 SQL GO')};if(goGrantRef)script.complete(goGrantRef);
  const envelope=script.seal(),seal={recordId:randomUUID(),digest:digest(envelope)},finalized=script.finalized(seal),parent={recordId:script.joinAck.joinId,digest:digest(script.joinAck)},finalValue={version:1,originDigest:script.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}},final={recordId:randomUUID(),digest:digest(finalValue)};
  const termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:!noChild,startedComputation:!noChild,directChildClosed:!noChild,subtreeTerminationConfirmed:!noChild,operationJoined:true,kind:noChild?'NO_CHILD_CREATED':'WINDOWS_JOB_EMPTY'};
  const observation=(event:'RESULT'|'TERMINATION')=>({evidenceId:randomUUID(),evidenceDigest:sha256('원 SQL '+event),value:{version:2,parentInstanceId:binding.parentInstanceId,event,code:'OK',resultDigest:event==='RESULT'?digest(result):null,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT'},windowsRecordRef:{recordId:seal.recordId,recordDigest:seal.digest}}});
  const observations=noChild?[observation('TERMINATION')]:[observation('RESULT'),observation('TERMINATION')],rawResult=noChild?null:{rawResultId:randomUUID(),resultDigest:digest(result)};
  const body={version:1,originDigest:script.originDigest,identity,basis:basisRef,goGrantRef,rawResult,record:{recordId:seal.recordId,recordDigest:seal.digest},parentJoin:parent,finalized:final,observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))},canonical=canonicalize(body)!,link={linkId:randomUUID(),canonical,digest:sha256(canonical),signature:sign(null,Buffer.from(canonical),signing.privateKey).toString('base64')};
  const expected={recordId:seal.recordId,recordDigest:seal.digest,linkId:link.linkId,linkDigest:link.digest};
  const {frame:_frame,...origin}=prepare;void _frame;
  const facts={capacity:{reference,profile,sourceInput},input:{evidenceId:inputId,evidenceDigest:digest(input),value:input},basis,goGrantRef,rawResult,observations,records:[{purpose:'PARENT_JOIN',recordId:parent.recordId,digest:parent.digest,value:script.joinAck},{purpose:'SEAL',recordId:seal.recordId,digest:seal.digest,value:envelope},{purpose:'FINALIZED',recordId:final.recordId,digest:final.digest,value:finalValue}],link,peer:{serviceRole:'trio_web_worker',peerId:randomUUID()}};
  const bundle={state:{allowed:true,view:{capture:{origin,originDigest:script.originDigest,frameInputDigest:job.inputDigest,launchRef:randomUUID()},record:{ref:seal,envelope},windowsEvidenceRef:expected},facts},observationDigests:observations.map(x=>x.evidenceDigest),original:{reservationId:binding.capacityReservationId,adoptionId:randomUUID(),sourceExecutionId:executionId,sourceInputEvidenceId:inputId,ownerService:'trio_web_worker',profileId:reference.profileId,profileDigest:reference.profileDigest,profileVersion:reference.profileVersion,protectedIntent:intent,intentDigest,actualIntentDigest:intentDigest},job};
  const calls:{sql:string;values:unknown[]}[]=[],operationId=randomUUID(),terminationId=randomUUID(),proofId=randomUUID();let saved:unknown[]|undefined,released=false,lost=false;
  let gate:Promise<void>|undefined,gateFor='';let sqlError:Error|undefined;
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:unknown[]}>=>{
    calls.push({sql,values});if(gate&&sql.includes(gateFor))await gate;if(sqlError)throw sqlError;
    if(sql.includes('WITH RECURSIVE reachable'))return {rows:[{session_user:'w4a_unit_operator',current_user:'trio_web_operator',roles:[{name:'w4a_unit_operator',login:true,unsafe:false},{name:'trio_web_operator',login:false,unsafe:false}],admin_membership:false,set_roles:['w4a_unit_operator','trio_web_operator'],owns_objects:false}]};
    if(sql.includes('windows_native_evidence_lookup(')||sql.includes('native_capacity_windows_operator_evidence('))return {rows:[{bundle:structuredClone(bundle)}]};
    if(sql.includes('windows_native_evidence_record(')||sql.includes('windows_native_evidence_lookup_bridge(')){
      if(sql.includes('windows_native_evidence_record(')){if(saved)expect(values).toEqual(saved);else saved=structuredClone(values);if(lost){lost=false;throw new Error('W4A_COMMIT_ACK_LOST');}}
      if(!saved)return {rows:[{view:{state:'WAIT',operation:null,termination:null}}]};
      return {rows:[{view:{state:'VERIFIED',operation:{evidenceId:operationId,evidenceDigest:digest(JSON.parse(values[1] as string))},termination:{evidenceId:terminationId,evidenceDigest:digest(JSON.parse(values[2] as string))}}}]};
    }
    if(sql.includes('native_capacity_confirm_windows_proof('))return {rows:[{decision:{allowed:true,reason:'CONFIRMED',capacityReservationId:binding.capacityReservationId,proofId}}]};
    if(sql.includes('native_capacity_release_windows(')){released=true;return {rows:[{decision:{allowed:true,reason:'RELEASED',capacityReservationId:binding.capacityReservationId,proofId}}]};}
    throw new Error('허용되지 않은 fake SQL: '+sql);
  });
  const db={role:'trio_web_worker',accountTransaction:vi.fn(()=>{throw new Error('원 transaction 밖 재조회 금지');})} as unknown as Database;
  const tx={account:{account_id:accountId},client:{query},now:new Date('2026-10-20T00:00:00.000Z')} as unknown as Transaction;
  return {key:structuredClone({binding,expected}),bundle,calls,query,db,tx,profile,script,proofId,client:{query} as unknown as Pick<PoolClient,'query'>,get saved(){return saved;},get released(){return released;},lose:()=>{lost=true;},block:(part:string,pending:Promise<void>)=>{gateFor=part;gate=pending;},failSql:(error:Error)=>{sqlError=error;}};
}

async function readerApi(){
  const path='../../packages/domain/src/windows-stage-cost-reader.js';
  const loaded=await import(path).catch((error:unknown)=>{if(error instanceof Error&&/Cannot find|Failed to load|failed to resolve/i.test(error.message))return {};throw error;});
  expect(loaded,'W4-B2 reader API가 필요하다').toHaveProperty('WindowsStageCostReader',expect.any(Function));
  return loaded as typeof import('../../packages/domain/src/windows-stage-cost-reader.js');
}
function manifest(rows:{kind:string;id:string}[]){
  const sorted=[...rows].sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:a.id>b.id?1:0),counts:{kind:string;count:number}[]=[],leaves:{kind:string;chunk:number;count:number;digest:string}[]=[];
  for(const kind of [...new Set(sorted.map(row=>row.kind))]){const group=sorted.filter(row=>row.kind===kind);counts.push({kind,count:group.length});for(let start=0;start<group.length;start+=256){const chunk=start/256,part=group.slice(start,start+256);leaves.push({kind,chunk,count:part.length,digest:digest({version:1,kind,chunk,rows:part})});}}
  return {version:1 as const,chunkSize:256 as const,counts,leaves};
}
async function stageFixture(mode:'FRESH'|'CACHE'|'NONE'|'NO_CHILD'='NONE',accounting:Record<string,string>={}){
  const api=await readerApi(),f=specimen(mode==='NO_CHILD',accounting),input=f.bundle.state.facts.input.value,inputFingerprint=digest(canonicalInput(input));
  const journal=new WindowsNativeCostJournal(f.db,{maxRecordBytes:32768,maxRecords:4});
  const source=mode==='NONE'?null:await journal.recordIn(f.tx,f.key);
  const rows:{evidence_id:string;evidence_digest:string;kind:string;execution_id:string;protected_evidence_ref:string;protected_observation:unknown}[]=[];
  const wrap=(kind:string,value:unknown)=>({version:1,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint,kind,value});
  const put=(kind:string,value:unknown,raw=false):CostEvidenceRef=>{const id=randomUUID(),record=raw?value:wrap(kind,value),hash=digest(record);rows.push({evidence_id:id,evidence_digest:hash,kind,execution_id:input.executionId,protected_evidence_ref:id,protected_observation:record});return {evidenceId:id,evidenceDigest:hash};};
  rows.push({evidence_id:f.bundle.state.facts.input.evidenceId,evidence_digest:inputFingerprint,kind:'INPUT',execution_id:input.executionId,protected_evidence_ref:f.bundle.state.facts.input.evidenceId,protected_observation:input});
  const snapshot={version:1 as const,state:'MEASURED' as const,stage:'OCR' as const,profileDigest:f.key.binding.profileDigest,basisVersion:'w4b2-synthetic-rates',usdScale:12 as const,rounding:'HALF_UP' as const,evidenceRefs:['synthetic-rate'],components:[{componentId:'cpu',kind:'IMAGE' as const,unit:'windows-job-cpu-second-v1',rateVersion:'synthetic-cpu-v1',usdPerUnit:'0.000000000001',evidenceRefs:['synthetic-rate']}]};
  const capture={accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint,stage:'OCR' as const,profileDigest:snapshot.profileDigest,mode:'FREE' as const};
  const calc=new FullStageCostCalculator(snapshot,{maxInputBytes:1048576,maxOutputBytes:786432,maxComponents:64,maxEvidenceRefs:8192,maxStringBytes:4096}).calculate(capture,{provider:null,quantities:null,allocation:null});
  const basis={version:1 as const,capture:calc.capture,captureDigest:calc.captureDigest,snapshot,snapshotDigest:calc.snapshotDigest},basisRef=put('OPERATIONAL_COST_BASIS',basis);
  if(source&&f.saved){for(const [r,index] of [[source.operation,1],[source.termination,2]] as const){const raw=JSON.parse(f.saved[index] as string);rows.push({evidence_id:r!.evidenceId,evidence_digest:r!.evidenceDigest,kind:raw.kind,execution_id:input.executionId,protected_evidence_ref:r!.evidenceId,protected_observation:raw});}}
  const owner={executionId:input.executionId,inputEvidenceId:f.bundle.state.facts.input.evidenceId,inputFingerprint,basisRef,claim:f.bundle.original.protectedIntent.claim,validationAttemptRef:null};
  const provider=put('OPERATIONAL_SOURCE',{kind:'PROVIDER',operationId:randomUUID(),eventId:randomUUID()}),allocation=put('OPERATIONAL_SOURCE',{kind:'ALLOCATION',operationId:randomUUID(),eventId:randomUUID()}),ending=put('OPERATIONAL_TERMINATION',{eventId:randomUUID()}),completionRef=put('OUTCOME',{state:'SUCCEEDED',executionId:input.executionId});
  const sources=(['PROVIDER','ALLOCATION'] as const).map((target,index)=>({sourceOperationId:randomUUID(),sourceEventId:randomUUID(),target,componentId:null,evidence:[index===0?provider:allocation]}));
  const nonWindows:OperationalStageCostWorkSet={version:1,executionId:input.executionId,inputFingerprint,captureDigest:calc.captureDigest,completion:'EXECUTION',joinedEvidence:[provider,allocation,completionRef],terminationEvidence:[ending],sources,facts:{provider:{scope:'ACTUAL_AI_USD',captureDigest:calc.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:[provider.evidenceId]},quantities:[],allocation:{captureDigest:calc.captureDigest,mode:'FREE',funding:'FREE_OPERATIONS',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.004',evidenceRefs:[allocation.evidenceId]}}};
  const ref=()=>({evidenceId:randomUUID(),evidenceDigest:sha256(randomUUID())}),scopeRef=ref(),callRef=ref(),components:{task:NativeTask;componentId:string}[]=[{task:'ZIP_WRITE',componentId:'cpu'}];
  const rawRows=rows.map(row=>({kind:'EVIDENCE',id:row.evidence_id,ref:{evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest},contentDigest:row.evidence_digest,completedAt:null as string|null}));
  if(mode!=='NONE')rawRows.push({kind:'SCOPE',id:scopeRef.evidenceId,ref:scopeRef,contentDigest:scopeRef.evidenceDigest,completedAt:null},{kind:'SCOPE_END',id:scopeRef.evidenceId,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('joined'),completedAt:'2026-10-21T00:00:00Z'},{kind:'CALL',id:callRef.evidenceId,ref:callRef,contentDigest:callRef.evidenceDigest,completedAt:null});
  rawRows.sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:a.id>b.id?1:0);
  const census={version:1,mode:'CENSUS',owner,root:{ref:ref(),components,componentsDigest:digest(components)},inputRef:{evidenceId:owner.inputEvidenceId,evidenceDigest:inputFingerprint},basisRef,rawSetDigest:'',manifest:manifest(rawRows),rows:rawRows,originals:mode==='NONE'?[]:[{key:f.key,scopeRef,callRef,componentId:'cpu',sourceOperation:source!.operation,sourceTermination:source!.termination,classification:mode==='CACHE'?'CACHE':'FRESH'}],completion:{kind:'EXECUTION',refs:[completionRef]}};census.rawSetDigest=digest(census.manifest);
  let sealed:unknown=null;const savepoints:{sealed:unknown;rows:typeof rows}[]=[];const projections=new Map<string,unknown>(),lookupModes:string[]=[];const nonWindowsIn=vi.fn(async()=>structuredClone(nonWindows)),checkpointFactsIn=vi.fn(async()=>null);
  const oldQuery=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
    if(sql.startsWith('SAVEPOINT ')){savepoints.push({sealed:structuredClone(sealed),rows:[...rows]});return {rows:[]};}
    if(sql.startsWith('ROLLBACK TO SAVEPOINT ')){const point=savepoints.at(-1)!;sealed=structuredClone(point.sealed);rows.splice(0,rows.length,...point.rows);return {rows:[]};}
    if(sql.startsWith('RELEASE SAVEPOINT ')){savepoints.pop();return {rows:[]};}
    if(sql.includes('windows_stage_cost_lookup(')){
      const request=JSON.parse(parameters[0] as string);lookupModes.push(request.mode);
      if(request.mode==='CENSUS')return {rows:[{value:structuredClone(census)}]};
      if(request.mode==='SEALED')return {rows:[{value:structuredClone(sealed)}]};
      if(request.mode==='SOURCE'){const source=f.bundle.state.facts.input;return {rows:[{value:{version:1,mode:'SOURCE',ref:request.ref,kind:'INPUT',value:source.value}}]};}
      if(request.mode==='ORIGINAL'){const bundle=structuredClone(f.bundle);bundle.state.facts.input.value=null as unknown as StageInput;return {rows:[{value:{version:1,mode:'ORIGINAL',key:f.key,inputRef:{evidenceId:f.bundle.state.facts.input.evidenceId,evidenceDigest:f.bundle.state.facts.input.evidenceDigest},basisRef:null,bundle}}]};}
    }
    if(sql.includes('windows_stage_cost_project(')){
      const key=JSON.parse(parameters[1] as string),identity=JSON.stringify(key);let result=projections.get(identity);
      if(!result){if(key.kind==='NATIVE'){const op=JSON.parse(parameters[2] as string),term=JSON.parse(parameters[3] as string);result={version:1,kind:'NATIVE',operation:put(op.kind,op,true),termination:put(term.kind,term,true)};}
        else{const value={version:1,componentId:key.componentId,rawSetDigest:key.rawSetDigest,basisRef:key.basisRef,operationId:randomUUID(),eventId:randomUUID(),quantity:'0',unit:'windows-job-cpu-second-v1'};result={version:1,kind:'ABSENCE',operation:put('WINDOWS_NATIVE_COST_ABSENCE',value),termination:put('WINDOWS_NATIVE_COST_CENSUS_TERMINATION',value),value};}projections.set(identity,result);}
      return {rows:[{value:structuredClone(result)}]};
    }
    if(sql.includes('windows_stage_cost_seal(')){
      const candidate=JSON.parse(parameters[1] as string),native=[...projections.values()] as {kind:string;operation:CostEvidenceRef;termination:CostEvidenceRef}[];
      const sort=(refs:CostEvidenceRef[])=>refs.sort((a,b)=>a.evidenceId<b.evidenceId?-1:a.evidenceId>b.evidenceId?1:a.evidenceDigest<b.evidenceDigest?-1:a.evidenceDigest>b.evidenceDigest?1:0);
      const value={version:1,executionId:input.executionId,inputFingerprint,basisRef,rawSetDigest:candidate.rawSetDigest,membershipDigest:candidate.membershipDigest,scopeRefs:sort(census.rows.filter(row=>row.kind==='SCOPE').map(row=>row.ref!)),attributionRefs:sort(native.filter(x=>x.kind==='NATIVE').map(x=>x.operation)),absenceRefs:sort(native.filter(x=>x.kind==='ABSENCE').map(x=>x.operation)),terminationRefs:sort(native.map(x=>x.termination)),nonWindowsWorkSetDigest:digest(candidate.nonWindowsWorkSet),componentMappingDigest:digest(components),completion:candidate.completion};
      const sealRef=put('WINDOWS_STAGE_COST_SEAL',value),workSet=structuredClone(candidate.workSet);workSet.terminationEvidence=sort([...workSet.terminationEvidence,sealRef]);sealed={version:1,mode:'SEALED',ref:sealRef,value,workSet};return {rows:[{value:structuredClone(sealed)}]};
    }
    if(sql.includes('FROM execution_evidence')){const id=parameters[2];return {rows:rows.filter(row=>{if(row.execution_id!==parameters[1])return false;if(sql.includes("kind='WINDOWS_NATIVE_OPERATION'")){const record=row.protected_observation as {accountId?:string;value:{binding?:{jobId:string};jobId?:string}};return record.accountId===parameters[0]&&(row.kind==='WINDOWS_NATIVE_OPERATION'&&record.value.binding?.jobId===id||row.kind==='WINDOWS_NATIVE_TERMINATION'&&record.value.jobId===id);}return Array.isArray(id)?id.includes(row.evidence_id):sql.includes('evidence_id=$3')?row.evidence_id===id:['INPUT','OPERATIONAL_COST_BASIS'].includes(row.kind);}).slice(0,sql.includes('LIMIT 3')?3:rows.length)};}
    return oldQuery(sql,parameters);
  });
  const reader=new api.WindowsStageCostReader({db:f.db,windows:journal,nonWindows:{nonWindowsIn,checkpointFactsIn},bounds:{...api.windowsStageCostBounds}});
  return {...f,reader,journal,input,basis,basisRef,owner,census,rows,nonWindows,nonWindowsIn,checkpointFactsIn,lookupModes,projections,get sealed(){return sealed;}};
}

it('W4-B2 certifies an actual zero-job census without a fake native job',async()=>{
  const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();expect(candidate!.facts.quantities).toEqual([expect.objectContaining({componentId:'cpu',quantity:'0',unit:'windows-job-cpu-second-v1',state:'CONFIRMED'})]);expect(f.projections.size).toBe(1);expect(f.lookupModes).not.toContain('ORIGINAL');expect(f.census.originals).toHaveLength(0);
});
it.each([['9007199254740995','0','900719925.4740995'],['18446744073709551615','18446744073709551615','3689348814741.910323'],['0','0','0']])('W4-B2 exactly sums original user %s and kernel %s',async(userTime100ns,kernelTime100ns,expected)=>{
  const f=await stageFixture('FRESH',{userTime100ns,kernelTime100ns}),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();expect(candidate!.facts.quantities![0].quantity).toBe(expected);expect(f.lookupModes.filter(x=>x==='SOURCE')).toHaveLength(1);expect(f.lookupModes.filter(x=>x==='ORIGINAL')).toHaveLength(1);
});
it('W4-B2 retains NO_CHILD original TERM identity as measured zero',async()=>{const f=await stageFixture('NO_CHILD'),work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work?.facts.quantities?.[0].quantity).toBe('0');expect(work?.sources.find(source=>source.componentId==='cpu')?.sourceEventId).toBe(f.bundle.state.facts.observations.at(-1)!.evidenceId);});
it('W4-B2 keeps CACHE producer CPU out of this consumer and records absence',async()=>{const f=await stageFixture('CACHE'),work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work?.facts.quantities?.[0].quantity).toBe('0');expect([...f.projections.values()]).toEqual([expect.objectContaining({kind:'ABSENCE'})]);});
it('W4-B2 never replaces missing nonWindows facts with a native zero',async()=>{const f=await stageFixture();f.nonWindowsIn.mockResolvedValue(null as never);expect(await f.reader.candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);});
it('W4-B2 refuses incomplete raw identity without inventing a Windows key',async()=>{const f=await stageFixture('FRESH');Object.assign(f.census.originals[0],{key:null,classification:'UNCONFIRMED'});expect(await f.reader.candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.lookupModes).not.toContain('ORIGINAL');expect(f.projections.size).toBe(0);});
it('W4-B2 rejects altered manifest, duplicate raw identity and wrong owner',async()=>{
  for(const fault of ['manifest','duplicate','owner']){const f=await stageFixture();if(fault==='manifest')f.census.rawSetDigest=sha256('changed');if(fault==='duplicate')f.census.rows.push(f.census.rows[0]);if(fault==='owner')f.census.owner.inputEvidenceId=randomUUID();expect(await f.reader.candidateIn(f.tx,f.input,f.basis),fault).toBeNull();expect(f.projections.size).toBe(0);}
});
it('W4-B2 refuses overlapping nonWindows and Windows quantity components',async()=>{const f=await stageFixture();f.nonWindows.facts.quantities!.push({componentId:'cpu',captureDigest:f.basis.captureDigest,state:'CONFIRMED',quantity:'1',unit:'windows-job-cpu-second-v1',evidenceRefs:[]});expect(await f.reader.candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);});
it('W4-B2 only reads existing sealed history and never creates a seal during a read',async()=>{const f=await stageFixture();expect(await f.reader.workSetIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);expect(f.lookupModes).toEqual(['SEALED']);});
it('W4-B2 seals one exact membership and recovers from immutable history without current census',async()=>{
  const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();const work=await f.reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(work).not.toBeNull();expect(work!.terminationEvidence).toHaveLength(candidate!.terminationEvidence.length+1);const calls=f.projections.size;f.census.owner.claim.ownerId=randomUUID();f.lookupModes.length=0;expect(await f.reader.workSetIn(f.tx,f.input,f.basis)).toEqual(work);expect(await f.reader.sealedCompletionIn(f.tx,f.input,f.basis,work!)).toBe('VERIFIED');expect(f.projections.size).toBe(calls);expect(f.lookupModes.every(mode=>mode==='SEALED')).toBe(true);
});
it('W4-B2 refuses a caller-mutated candidate before a private seal',async()=>{const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();candidate!.facts.provider!.actualUsd='9';expect(await f.reader.sealIn(f.tx,f.input,f.basis,candidate!)).toBeNull();expect(f.sealed).toBeNull();});
it('W4-B2 propagates SQL privilege errors instead of reinterpreting them as WAIT',async()=>{const f=await stageFixture();f.query.mockRejectedValue(Object.assign(Error('denied'),{code:'42501'}));await expect(f.reader.candidateIn(f.tx,f.input,f.basis)).rejects.toMatchObject({code:'42501'});});


function refreshCensus(census:{rows:{kind:string;id:string}[];manifest:ReturnType<typeof manifest>;rawSetDigest:string}){census.rows.sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:a.id>b.id?1:0);census.manifest=manifest(census.rows);census.rawSetDigest=digest(census.manifest);}
async function boundedReader(f:Awaited<ReturnType<typeof stageFixture>>,bounds:Partial<import('../../packages/domain/src/windows-stage-cost-reader.js').WindowsStageCostBounds>){const api=await readerApi();return new api.WindowsStageCostReader({db:f.db,windows:f.journal,nonWindows:{nonWindowsIn:f.nonWindowsIn,checkpointFactsIn:f.checkpointFactsIn},bounds:{...api.windowsStageCostBounds,...bounds}});}
it('W4-B2 includes raw joined evidence expansion in the one-action byte budget',async()=>{
  const f=await stageFixture(),r=f.nonWindows.joinedEvidence[0],row=f.rows.find(row=>row.evidence_id===r.evidenceId)!;(row.protected_observation as {value:Record<string,unknown>}).value.padding='x'.repeat(20000);row.evidence_digest=digest(row.protected_observation);r.evidenceDigest=row.evidence_digest;f.nonWindows.sources[0].evidence[0].evidenceDigest=row.evidence_digest;
  const raw=f.census.rows.find(row=>row.id===r.evidenceId)!;raw.contentDigest=r.evidenceDigest;raw.ref=r;refreshCensus(f.census);
  expect(await (await boundedReader(f,{maxActionBytes:30000})).candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);
});


async function manyOriginals(count:number,options:{large?:boolean;shared?:boolean;inputBytes?:number;basisBytes?:number}={}){
  const f=await stageFixture(),items:ReturnType<typeof specimen>[]=[],sources=new Map<string,{kind:string;value:unknown;ref:CostEvidenceRef}>(),originals=new Map<string,ReturnType<typeof specimen>>();
  const addRow=(executionId:string,r:CostEvidenceRef,kind:string,raw:unknown)=>{if(!f.rows.some(x=>x.evidence_id===r.evidenceId))f.rows.push({evidence_id:r.evidenceId,evidence_digest:r.evidenceDigest,kind,execution_id:executionId,protected_evidence_ref:r.evidenceId,protected_observation:raw});};
  for(let n=0;n<count;n++){
    const shared=options.shared&&items[0]?{input:items[0].bundle.state.facts.input.value,inputEvidenceId:items[0].bundle.state.facts.input.evidenceId}:{},original=specimen(false,{userTime100ns:'18446744073709551615',kernelTime100ns:'18446744073709551615'},{accountId:f.input.accountId,...(options.large?{inputBytes:130000,basisBytes:130000}:{}),...(options.inputBytes?{inputBytes:options.inputBytes}:{}),...(options.basisBytes?{basisBytes:options.basisBytes}:{}),...shared});items.push(original);originals.set(original.key.binding.jobId,original);
    const view=await new WindowsNativeCostJournal(original.db,{maxRecordBytes:32768,maxRecords:4}).recordIn(original.tx,original.key);expect(view.state).toBe('VERIFIED');
    for(const [ref,index] of [[view.operation!,1],[view.termination!,2]] as const){const raw=JSON.parse(original.saved![index] as string);addRow(original.bundle.state.facts.input.value.executionId,ref,raw.kind,raw);}
    for(const [source,kind] of [[original.bundle.state.facts.input,'INPUT'],[original.bundle.state.facts.basis,'OPERATIONAL_COST_BASIS']] as const){if(!source)continue;const r={evidenceId:source.evidenceId,evidenceDigest:source.evidenceDigest};sources.set(r.evidenceId,{kind,value:source.value,ref:r});addRow(original.bundle.state.facts.input.value.executionId,r,kind,source.value);}
    const scopeRef={evidenceId:randomUUID(),evidenceDigest:sha256('scope'+n)},callRef={evidenceId:randomUUID(),evidenceDigest:sha256('call'+n)};
    f.census.originals.push({key:original.key,scopeRef,callRef,componentId:'cpu',sourceOperation:view.operation,sourceTermination:view.termination,classification:'FRESH'});
    f.census.rows.push({kind:'SCOPE',id:scopeRef.evidenceId,ref:scopeRef,contentDigest:scopeRef.evidenceDigest,completedAt:null},{kind:'SCOPE_END',id:scopeRef.evidenceId,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('end'+n),completedAt:'2026-10-21T00:00:00Z'},{kind:'CALL',id:callRef.evidenceId,ref:callRef,contentDigest:callRef.evidenceDigest,completedAt:null},{kind:'BINDING',id:original.key.binding.jobId,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('binding'+n),completedAt:null});
  }
  refreshCensus(f.census);const baseQuery=f.query.getMockImplementation()!,reads={source:0,original:0};
  f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
    if(sql.includes('windows_stage_cost_lookup(')){
      const q=JSON.parse(parameters[0] as string);
      if(q.mode==='SOURCE'){reads.source++;const source=sources.get(q.ref.evidenceId)!;return {rows:[{value:{version:1,mode:'SOURCE',kind:source.kind,ref:source.ref,value:source.value}}]};}
      if(q.mode==='ORIGINAL'){reads.original++;const original=originals.get(q.key.binding.jobId)!,bundle=structuredClone(original.bundle),input=bundle.state.facts.input,basis=bundle.state.facts.basis;const inputRef={evidenceId:input.evidenceId,evidenceDigest:input.evidenceDigest},basisRef=basis?{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest}:null;input.value=null as unknown as StageInput;if(basis)basis.value=null;return {rows:[{value:{version:1,mode:'ORIGINAL',key:original.key,inputRef,basisRef,bundle}}]};}
    }
    return baseQuery(sql,parameters);
  });
  return {...f,items,sources,reads};
}
it.each([63,64])('W4-B2 sequentially validates and exactly sums %s signed original CPU records',async count=>{
  const f=await manyOriginals(count),work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work).not.toBeNull();expect(work!.facts.quantities![0].quantity).toBe(count===64?'236118324143482.260672':'232428975328740.350349');expect(f.projections.size).toBe(count);expect(f.reads).toEqual({source:count,original:count});
},30000);
it('W4-B2 refuses a 65th original without reading or projecting a prefix',async()=>{const f=await manyOriginals(65);expect(await f.reader.candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.reads).toEqual({source:0,original:0});expect(f.projections.size).toBe(0);},30000);
it('W4-B2 shares one original INPUT cache entry across 64 distinct signed jobs',async()=>{const f=await manyOriginals(64,{shared:true}),work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work?.facts.quantities?.[0].quantity).toBe('236118324143482.260672');expect(f.reads).toEqual({source:1,original:64});},30000);
it('W4-B2 accepts 64 distinct large signed INPUT and BASIS pairs within the separate cache and action bounds',async()=>{
  const start=performance.now(),f=await manyOriginals(64,{large:true}),prepared=performance.now(),work=await f.reader.candidateIn(f.tx,f.input,f.basis);console.info(JSON.stringify({fixtureMs:prepared-start,readerMs:performance.now()-prepared}));expect(work?.facts.quantities?.[0].quantity).toBe('236118324143482.260672');expect(f.reads).toEqual({source:128,original:64});const bytes=[...f.sources.values()].reduce((sum,s)=>sum+Buffer.byteLength(JSON.stringify(s.value)),0);expect(bytes).toBe(16640000);
},60000);
it.each([['SCOPE','SCOPE_END',64],['CALL',null,256],['BINDING',null,64],['IO_START','IO_END',1024],['RESULT_QUERY','RESULT_ACK',1024],['CACHE_USE',null,1024]] as const)('W4-B2 independently bounds raw %s at N-1 N N+1',async(kind,end,maximum)=>{
  for(const count of [maximum-1,maximum,maximum+1]){const f=await stageFixture();for(let n=0;n<count;n++){const id=randomUUID(),r={evidenceId:id,evidenceDigest:sha256(kind+n)};f.census.rows.push({kind,id,ref:r,contentDigest:r.evidenceDigest,completedAt:null});if(end)f.census.rows.push({kind:end,id,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('end'+n),completedAt:'2026-10-21T00:00:00Z'});}refreshCensus(f.census);const work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work===null,kind+' '+count).toBe(count>maximum);expect(f.projections.size).toBe(count>maximum?0:1);}
},30000);
it('W4-B2 applies the exact compact summary byte boundary without a prefix',async()=>{
  for(const delta of [-1,0,1]){const f=await stageFixture(),bytes=Buffer.byteLength(JSON.stringify(f.census)),reader=await boundedReader(f,{maxSummaryBytes:bytes+delta});expect((await reader.candidateIn(f.tx,f.input,f.basis))===null).toBe(delta<0);expect(f.projections.size).toBe(delta<0?0:1);}
});
it('W4-B2 rejects input accessors and nonWindows alias expansion before getters or project calls',async()=>{
  const f=await stageFixture(),get=vi.fn(()=>1),bad=Object.defineProperty(structuredClone(f.input),'width',{get,enumerable:true});expect(await f.reader.candidateIn(f.tx,bad,f.basis)).toBeNull();expect(get).not.toHaveBeenCalled();expect(f.query.mock.calls.some(c=>c[0].includes('windows_stage_cost_'))).toBe(false);
  let alias:unknown={v:'value'};for(let n=0;n<12;n++)alias=[alias,alias];f.nonWindowsIn.mockResolvedValue(alias as never);expect(await (await boundedReader(f,{maxNodes:1024})).candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);
});

it.each([-1,0,1])('W4-B2 preserves the original whole INPUT and BASIS 131072 byte boundary at delta %s',async delta=>{
  if(delta>0){const source=specimen(false,{},{inputBytes:131072+delta,basisBytes:131072+delta}),journal=new WindowsNativeCostJournal(source.db,{maxRecordBytes:32768,maxRecords:4});expect(await journal.recordIn(source.tx,source.key)).toEqual({state:'WAIT',operation:null,termination:null});expect(source.saved).toBeUndefined();return;}
  const f=await manyOriginals(1,{inputBytes:131072+delta,basisBytes:131072+delta}),work=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(work).not.toBeNull();expect(f.projections.size).toBe(1);
},30000);
it.each([-1,0,1])('W4-B2 accounts actual original wrapper bytes in the body-cache boundary at delta %s',async delta=>{
  const f=await manyOriginals(1,{large:true}),reader=await boundedReader(f,{maxSourceBytes:260000+delta}),work=await reader.candidateIn(f.tx,f.input,f.basis);expect(work===null).toBe(delta<0);expect(f.projections.size).toBe(delta<0?0:1);
},30000);

it('W4-B2 fits the complete 64-original 1024-IO 256-semantic set through the approved calculator and wrapper caps',async()=>{
  const f=await manyOriginals(64),componentId='io'+'x'.repeat(126),unit='u'.repeat(128),rateVersion='r'.repeat(128);
  f.basis.snapshot.components.push({componentId,kind:'IMAGE',unit,rateVersion,usdPerUnit:'0.000000000001',evidenceRefs:['synthetic-rate']});f.basis.snapshotDigest=digest(f.basis.snapshot);
  const basisRow=f.rows.find(row=>row.evidence_id===f.basisRef.evidenceId)!;basisRow.evidence_digest=digest(basisRow.protected_observation);f.basisRef.evidenceDigest=basisRow.evidence_digest;const rawBasis=f.census.rows.find(row=>row.id===f.basisRef.evidenceId)!;rawBasis.contentDigest=f.basisRef.evidenceDigest;rawBasis.ref=f.basisRef;
  const evidenceRefs:string[]=[];
  for(let n=0;n<1280;n++){
    const sourceOperationId=randomUUID(),sourceEventId=randomUUID(),evidenceId=randomUUID(),fact={componentId,captureDigest:f.basis.captureDigest,state:'CONFIRMED',quantity:'1280',unit},kind=n<1024?'WINDOWS_COSTED_IO':'SEMANTIC_VALIDATION_SOURCE',value={version:1,accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),kind,value:{operationId:sourceOperationId,eventId:sourceEventId,fact}},r={evidenceId,evidenceDigest:digest(value)};
    f.rows.push({evidence_id:evidenceId,evidence_digest:r.evidenceDigest,kind,execution_id:f.input.executionId,protected_evidence_ref:evidenceId,protected_observation:value});f.nonWindows.joinedEvidence.push(r);f.nonWindows.sources.push({sourceOperationId,sourceEventId,target:'QUANTITY',componentId,evidence:[r]});evidenceRefs.push(evidenceId);
    f.census.rows.push({kind:'EVIDENCE',id:evidenceId,ref:r,contentDigest:r.evidenceDigest,completedAt:null});
    if(n<1024){f.census.rows.push({kind:'IO_START',id:sourceOperationId,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('start'+sourceOperationId),completedAt:null},{kind:'IO_END',id:sourceOperationId,ref:null as unknown as CostEvidenceRef,contentDigest:sha256('end'+sourceOperationId),completedAt:'2026-10-21T00:00:00Z'});}
  }
  f.nonWindows.facts.quantities!.push({componentId,captureDigest:f.basis.captureDigest,state:'CONFIRMED',quantity:'1280',unit,evidenceRefs});refreshCensus(f.census);
  const candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();const work=await f.reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(work).not.toBeNull();expect(work!.sources).toHaveLength(1346);
  const calculator=new FullStageCostCalculator(f.basis.snapshot,{maxInputBytes:1048576,maxOutputBytes:786432,maxComponents:64,maxEvidenceRefs:8192,maxStringBytes:4096}),{captureDigest:_captureDigest,...capture}=f.basis.capture;void _captureDigest;const result=calculator.calculate(capture,work!.facts);expect(result.state).toBe('CONFIRMED');expect(result.actualUsd).toBe('236.132324144762');
  const wrap=(kind:string,value:unknown)=>({version:1,accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),kind,value}),calculation=wrap('OPERATIONAL_COST_CALCULATION',result),closure=wrap('OPERATIONAL_COST_CLOSURE',{version:1,basisEvidenceId:f.basisRef.evidenceId,basisEvidenceDigest:f.basisRef.evidenceDigest,workSetDigest:digest(work),workSet:work,calculationEvidenceId:randomUUID(),calculationEvidenceDigest:digest(calculation),factsDigest:digest(work!.facts)}),bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
  const metrics={originals:64,io:1024,semantic:256,sources:work!.sources.length,joined:work!.joinedEvidence.length,termination:work!.terminationEvidence.length,workBytes:bytes(work),resultBytes:bytes(result),wrapperBytes:bytes(calculation),closureBytes:bytes(closure),summaryBytes:bytes(f.census)};console.info(JSON.stringify(metrics));expect(work!.joinedEvidence.length+work!.terminationEvidence.length).toBeLessThanOrEqual(2046);expect(metrics.workBytes).toBeLessThanOrEqual(1048576);expect(metrics.resultBytes).toBeLessThanOrEqual(786432);expect(metrics.wrapperBytes).toBeLessThanOrEqual(1048576);expect(metrics.closureBytes).toBeLessThanOrEqual(1048576);expect(metrics.summaryBytes).toBeLessThanOrEqual(8388608);
},120000);

it('W4-B2 creates distinct census events for every unused component and enforces the component cap independently',async()=>{
  const {nativeTasks}=await import('../../packages/native/src/dto.js');for(const count of [2,3,4]){const f=await stageFixture();f.census.root.components=nativeTasks.slice(0,count).map((task,n)=>({task,componentId:'cpu'+n}));f.census.root.componentsDigest=digest(f.census.root.components);const reader=await boundedReader(f,{maxComponents:3}),work=await reader.candidateIn(f.tx,f.input,f.basis);
    if(count>3){expect(work).toBeNull();expect(f.projections.size).toBe(0);continue;}expect(work!.facts.quantities).toHaveLength(count);const identities=work!.sources.filter(source=>source.target==='QUANTITY').flatMap(source=>[source.sourceOperationId,source.sourceEventId,...source.evidence.map(ref=>ref.evidenceId)]);expect(new Set(identities).size).toBe(count*3);expect(work!.facts.quantities!.every(fact=>fact.quantity==='0')).toBe(true);expect(f.census.originals).toHaveLength(0);
  }
});

it('W4-B2 preserves SQL NULL for the nullable absence operation and termination parameters',async()=>{
  const f=await stageFixture();await f.journal.stageProjectIn(f.tx,f.owner,{version:1,kind:'ABSENCE',componentId:'cpu',rawSetDigest:f.census.rawSetDigest,basisRef:f.basisRef},null,null);const call=f.query.mock.calls.find(call=>call[0].includes('windows_stage_cost_project('))!;expect(call[1]![2]).toBeNull();expect(call[1]![3]).toBeNull();
});
it.each(['getter','proxy','alias'] as const)('W4-B2 rejects historical %s input before SQL and capability execution',async fault=>{
  const f=await stageFixture(),get=vi.fn(()=>f.input.accountId);let input:StageInput=structuredClone(f.input);if(fault==='getter')input=Object.defineProperty(input,'accountId',{get,enumerable:true});if(fault==='proxy')input=new Proxy(input,{get(target,key,receiver){get();return Reflect.get(target,key,receiver);}});if(fault==='alias'){let alias:unknown=Object.defineProperty({},'v',{get,enumerable:true});for(let n=0;n<12;n++)alias=[alias,alias];(input as unknown as {alias:unknown}).alias=alias;}
  const reader=await boundedReader(f,{maxNodes:1024});expect(await reader.workSetIn(f.tx,input,f.basis)).toBeNull();expect(get).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
it('W4-B2 rejects accessor sealed-completion work before any historical SQL read',async()=>{
  const f=await stageFixture(),get=vi.fn(()=>f.input.executionId),work=Object.defineProperty(structuredClone(f.nonWindows),'executionId',{get,enumerable:true});expect(await f.reader.sealedCompletionIn(f.tx,f.input,f.basis,work)).toBe('WAIT');expect(get).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
it('W4-B2 rejects accessor first-seal input before creating a protected seal',async()=>{
  const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();const count=f.query.mock.calls.length,get=vi.fn(()=>f.input.accountId),input=Object.defineProperty(structuredClone(f.input),'accountId',{get,enumerable:true});expect(await f.reader.sealIn(f.tx,input,f.basis,candidate!)).toBeNull();expect(get).not.toHaveBeenCalled();expect(f.query).toHaveBeenCalledTimes(count);expect(f.sealed).toBeNull();
});
it('W4-B2 binds a first-seal candidate to its captured INPUT and BASIS before any write',async()=>{
  const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();const count=f.query.mock.calls.length,input={...f.input,executionId:randomUUID()};expect(await f.reader.sealIn(f.tx,input,f.basis,candidate!)).toBeNull();expect(f.query).toHaveBeenCalledTimes(count);expect(f.sealed).toBeNull();
});

it('W4-B2 refuses a candidate with a different captured BASIS before writing the seal',async()=>{
  const f=await stageFixture(),candidate=await f.reader.candidateIn(f.tx,f.input,f.basis);expect(candidate).not.toBeNull();const basis=structuredClone(f.basis);basis.snapshot.evidenceRefs.push('caller-replaced-rate');basis.snapshotDigest=digest(basis.snapshot);const before=f.query.mock.calls.filter(call=>call[0].includes('windows_stage_cost_seal(')).length;expect(await f.reader.sealIn(f.tx,f.input,basis,candidate!)).toBeNull();expect(f.query.mock.calls.filter(call=>call[0].includes('windows_stage_cost_seal('))).toHaveLength(before);expect(f.sealed).toBeNull();
});

it.each(['missing','duplicate','orphan'] as const)('W4-B2 refuses incomplete nonWindows source-to-fact coverage: %s',async fault=>{
  const f=await stageFixture();if(fault==='missing')f.nonWindows.facts.provider!.evidenceRefs=[];if(fault==='duplicate')f.nonWindows.facts.provider!.evidenceRefs.push(f.nonWindows.facts.provider!.evidenceRefs[0]);if(fault==='orphan')f.nonWindows.sources.push({sourceOperationId:randomUUID(),sourceEventId:randomUUID(),target:'QUANTITY',componentId:'unaccounted-component',evidence:[f.nonWindows.joinedEvidence[2]]});
  expect(await f.reader.candidateIn(f.tx,f.input,f.basis)).toBeNull();expect(f.projections.size).toBe(0);
});

it.each([-1,0,1])('W4-B2 재결합한 원 bundle byte 상한을 보존한다: delta %s',async delta=>{
  const f=await stageFixture('FRESH'),bundleBytes=Buffer.byteLength(JSON.stringify(f.bundle)),reader=await boundedReader(f,{maxRecordBytes:bundleBytes+delta}),work=await reader.candidateIn(f.tx,f.input,f.basis);
  expect(work===null).toBe(delta<0);expect(f.projections.size).toBe(delta<0?0:1);expect(f.lookupModes.filter(mode=>mode==='ORIGINAL')).toHaveLength(1);
},30000);

it.each(['WINDOWS_NATIVE_OPERATION','WINDOWS_NATIVE_TERMINATION'] as const)('W4-B2 original facts refuse an extra same-source job bridge: %s',async kind=>{
  const f=await stageFixture('FRESH'),refs=f.census.originals[0],source={operation:refs.sourceOperation,termination:refs.sourceTermination};
  expect(await f.journal.stageOriginalFactsIn(f.tx,JSON.parse(JSON.stringify(f.bundle)),f.key,source)).not.toBeNull();
  const original=f.rows.find(row=>row.kind===kind)!,extra=structuredClone(original),id=randomUUID(),raw=extra.protected_observation as {value:{windowsEvidenceRef:{recordId:string}}};
  raw.value.windowsEvidenceRef.recordId=randomUUID();extra.evidence_id=id;extra.protected_evidence_ref=id;extra.evidence_digest=digest(raw);f.rows.push(extra);
  expect(await f.journal.stageOriginalFactsIn(f.tx,JSON.parse(JSON.stringify(f.bundle)),f.key,source)).toBeNull();
});
it.each(['account','execution','job'] as const)('W4-B2 original facts ignore an unrelated bridge in another %s',async different=>{
  const f=await stageFixture('FRESH'),refs=f.census.originals[0],extra=structuredClone(f.rows.find(row=>row.kind==='WINDOWS_NATIVE_OPERATION')!),id=randomUUID(),raw=extra.protected_observation as {accountId:string;executionId:string;value:{binding:{jobId:string}}};
  if(different==='account')raw.accountId=randomUUID();if(different==='execution'){raw.executionId=randomUUID();extra.execution_id=raw.executionId;}if(different==='job')raw.value.binding.jobId=randomUUID();
  extra.evidence_id=id;extra.protected_evidence_ref=id;extra.evidence_digest=digest(raw);f.rows.push(extra);
  expect(await f.journal.stageOriginalFactsIn(f.tx,JSON.parse(JSON.stringify(f.bundle)),f.key,{operation:refs.sourceOperation,termination:refs.sourceTermination})).not.toBeNull();
});

// 승인된 명시 action의 가짜 transaction 포트. 실제 DB/시계/작업 실행은 없다.
async function splitPreparationFixture(mode:'NONE'|'FRESH'='NONE',bounds:Partial<import('../../packages/domain/src/windows-stage-cost-reader.js').WindowsStageCostBounds>={}){
  const f=await stageFixture(mode),api=await readerApi(),prior=f.query.getMockImplementation()!;
  let active:Transaction|null=null,current=true,commits=0,afterCommit=(_count:number)=>{};
  const events:{kind:string;transaction:Transaction|null}[]=[];
  f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('FROM work_items w JOIN executions e'))return {rows:[{current}]};
    if(sql.includes("kind='WINDOWS_STAGE_COST_SEAL'"))return {rows:f.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')};
    if(sql.includes('windows_stage_cost_lookup(')){const query=JSON.parse(values[0] as string);events.push({kind:query.mode,transaction:active});}
    if(sql.includes('windows_stage_cost_project('))events.push({kind:'PROJECT',transaction:active});
    if(sql.includes('windows_stage_cost_seal(')&&JSON.parse(values[1] as string).rawSetDigest!==f.census.rawSetDigest)return {rows:[{value:null}]};
    return prior(sql,values);
  });
  const transaction=vi.fn(async(account:string,run:(tx:Transaction)=>Promise<unknown>,allow:boolean)=>{
    expect(account).toBe(f.input.accountId);expect(allow).toBe(true);expect(active).toBeNull();
    const tx={...f.tx};active=tx;try{return await run(tx);}finally{active=null;afterCommit(++commits);}
  });
  Object.assign(f.db,{accountTransaction:transaction});
  const reader=new api.WindowsStageCostReader({db:f.db,windows:f.journal,nonWindows:{nonWindowsIn:f.nonWindowsIn,checkpointFactsIn:f.checkpointFactsIn},bounds:{...api.windowsStageCostBounds,...bounds}});
  const prepare=async(input=f.input,basis=f.basis):Promise<OperationalStageCostWorkSet|null>=>{
    const action=Reflect.get(reader,'prepareCandidate');expect(action,'명시 prepareCandidate action이 필요하다').toBeTypeOf('function');return Reflect.apply(action,reader,[input,basis]);
  };
  return {...f,reader,prepare,transaction,events,get sealed(){return f.sealed;},setCurrent:(value:boolean)=>{current=value;},afterCommit:(run:(count:number)=>void)=>{afterCommit=run;}};
}

it('W4-B2 split preparation commits capture before a separate projection transaction',async()=>{
  const f=await splitPreparationFixture('FRESH'),work=await f.prepare();expect(work).not.toBeNull();
  const census=f.events.find(event=>event.kind==='CENSUS'),project=f.events.find(event=>event.kind==='PROJECT');
  expect(census?.transaction).not.toBeNull();expect(project?.transaction).not.toBeNull();expect(census?.transaction).not.toBe(project?.transaction);
  expect(f.transaction.mock.calls.length).toBeGreaterThanOrEqual(2);expect(f.sealed).toBeNull();
  const sealed=await f.reader.sealIn(f.tx,f.input,f.basis,work!);expect(sealed).not.toBeNull();
});
it('W4-B2 split preparation stops at original claim loss between committed transactions',async()=>{
  const f=await splitPreparationFixture();f.afterCommit(count=>{if(count===1)f.setCurrent(false);});
  expect(await f.prepare()).toBeNull();expect(f.projections.size).toBe(0);expect(f.sealed).toBeNull();
});
it('W4-B2 split preparation never restarts an existing conflicting seal',async()=>{
  const f=await splitPreparationFixture();f.rows.push({evidence_id:randomUUID(),evidence_digest:sha256('conflicting seal'),kind:'WINDOWS_STAGE_COST_SEAL',execution_id:f.input.executionId,protected_evidence_ref:randomUUID(),protected_observation:null});
  expect(await f.prepare()).toBeNull();expect(f.projections.size).toBe(0);expect(f.events.some(event=>event.kind==='CENSUS')).toBe(false);
});
it('W4-B2 split preparation owns input before awaiting and refuses a transported private candidate',async()=>{
  const f=await splitPreparationFixture(),input=structuredClone(f.input),basis=structuredClone(f.basis),pending=f.prepare(input,basis);
  input.width=999;Object.assign(basis.capture,{inputFingerprint:sha256('caller changed after invocation')});
  const work=await pending;expect(work).not.toBeNull();expect(work?.inputFingerprint).toBe(f.owner.inputFingerprint);
  const copied=structuredClone(work!);expect(await f.reader.sealIn(f.tx,f.input,f.basis,copied)).toBeNull();expect(f.sealed).toBeNull();
  expect(await f.reader.sealIn(f.tx,f.input,f.basis,work!)).not.toBeNull();
});

it('W4-B2 split preparation preserves partial committed projection refs after lost ACK without automatic retry',async()=>{
  const f=await splitPreparationFixture();f.afterCommit(count=>{if(count===2)throw new Error('SPLIT_PROJECTION_COMMIT_ACK_LOST');});
  await expect(f.prepare()).rejects.toThrow('SPLIT_PROJECTION_COMMIT_ACK_LOST');expect(f.transaction).toHaveBeenCalledTimes(2);expect(f.projections.size).toBe(1);expect(f.sealed).toBeNull();
  const original=[...f.projections.values()];f.afterCommit(()=>{});const candidate=await f.prepare();expect(candidate).not.toBeNull();expect([...f.projections.values()]).toEqual(original);expect(f.sealed).toBeNull();
});
it('W4-B2 split preparation holds the old candidate after raw drift and claim loss before final seal',async()=>{
  for(const defect of ['raw','claim'] as const){const f=await splitPreparationFixture(),work=await f.prepare();expect(work).not.toBeNull();if(defect==='raw'){f.census.rows.push({kind:'EVIDENCE',id:randomUUID(),ref:null as unknown as CostEvidenceRef,contentDigest:sha256('new original'),completedAt:null});refreshCensus(f.census);}else f.setCurrent(false);
    expect(await f.reader.sealIn(f.tx,f.input,f.basis,work!),defect).toBeNull();expect(f.sealed).toBeNull();}
});
it('W4-B2 split preparation propagates a real SQL privilege failure without producing a seal',async()=>{
  const f=await splitPreparationFixture(),prior=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{if(sql.includes('FROM work_items w JOIN executions e'))throw Object.assign(new Error('claim SQL denied'),{code:'42501'});return prior(sql,values);});
  await expect(f.prepare()).rejects.toMatchObject({code:'42501'});expect(f.projections.size).toBe(0);expect(f.sealed).toBeNull();
});
it('W4-B2 split preparation carries one exact action byte budget into the private final seal',async()=>{
  let lower=1,upper=262144;
  while(lower<upper){const middle=Math.floor((lower+upper)/2),probe=await splitPreparationFixture('NONE',{maxActionBytes:middle});if(await probe.prepare()===null)lower=middle+1;else upper=middle;}
  const below=await splitPreparationFixture('NONE',{maxActionBytes:lower-1});expect(await below.prepare()).toBeNull();expect(below.sealed).toBeNull();
  const exact=await splitPreparationFixture('NONE',{maxActionBytes:lower}),work=await exact.prepare();expect(work).not.toBeNull();expect(exact.transaction.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(await exact.reader.sealIn(exact.tx,exact.input,exact.basis,work!)).toBeNull();expect(exact.sealed).toBeNull();expect(exact.query.mock.calls.some(call=>call[0].includes('windows_stage_cost_seal('))).toBe(false);
  const complete=await splitPreparationFixture('NONE',{maxActionBytes:lower*8}),candidate=await complete.prepare();expect(candidate).not.toBeNull();expect(await complete.reader.sealIn(complete.tx,complete.input,complete.basis,candidate!)).not.toBeNull();
});

it('W4-B2 split seal rolls back its write when only post-seal verification exhausts the action budget',async()=>{
  let low=1,high=262144;
  while(low<high){const middle=Math.floor((low+high)/2),probe=await splitPreparationFixture('NONE',{maxActionBytes:middle}),candidate=await probe.prepare();if(candidate===null||await probe.reader.sealIn(probe.tx,probe.input,probe.basis,candidate)===null)low=middle+1;else high=middle;}
  const f=await splitPreparationFixture('NONE',{maxActionBytes:low-1}),candidate=await f.prepare();expect(candidate).not.toBeNull();
  expect(await f.reader.sealIn(f.tx,f.input,f.basis,candidate!)).toBeNull();
  expect(f.query.mock.calls.some(call=>call[0].includes('windows_stage_cost_seal('))).toBe(true);
  expect(f.sealed,'거부된 봉인 쓰기는 transaction 안에서 되돌아가야 한다').toBeNull();expect(f.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')).toHaveLength(0);
});
it('W4-B2 split preparation accumulates a projection and CPU only after COMMIT retries succeed',async()=>{
  const f=await splitPreparationFixture('FRESH'),transaction=f.transaction.getMockImplementation()!,rolledRefs:string[]=[];let retried=false;
  f.transaction.mockImplementation(async(account:string,run:(tx:Transaction)=>Promise<unknown>,allow:boolean)=>{
    const beforeRows=[...f.rows],beforeProjections=new Map(f.projections);
    try{return await transaction(account,async tx=>{const value=await run(tx);if(!retried&&f.projections.size>beforeProjections.size){retried=true;for(const p of f.projections.values())rolledRefs.push((p as {operation:CostEvidenceRef}).operation.evidenceId);f.rows.splice(0,f.rows.length,...beforeRows);f.projections.clear();for(const [k,v] of beforeProjections)f.projections.set(k,v);throw Object.assign(new Error('first COMMIT serialization failure'),{code:'40001'});}return value;},allow);}
    catch(error){if((error as {code?:string}).code!=='40001')throw error;return transaction(account,run,allow);}
  });
  const work=await f.prepare();expect(retried).toBe(true);expect(work).not.toBeNull();expect(f.projections.size).toBe(1);
  expect(work!.facts.quantities).toEqual([expect.objectContaining({componentId:'cpu',quantity:'900719925.4741293'})]);expect(work!.sources.filter(source=>source.componentId==='cpu')).toHaveLength(1);expect(work!.joinedEvidence.every(ref=>!rolledRefs.includes(ref.evidenceId))).toBe(true);expect(f.sealed).toBeNull();
});

it('W4-B2 split final seal keeps its private candidate valid after an outer transaction rollback and retry',async()=>{
  const f=await splitPreparationFixture(),candidate=await f.prepare();expect(candidate).not.toBeNull();
  await f.query('SAVEPOINT simulated_outer_transaction');const first=await f.reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(first).not.toBeNull();
  const rolled=first!.terminationEvidence.find(ref=>!candidate!.terminationEvidence.some(original=>original.evidenceId===ref.evidenceId))!;
  await f.query('ROLLBACK TO SAVEPOINT simulated_outer_transaction');await f.query('RELEASE SAVEPOINT simulated_outer_transaction');expect(f.sealed).toBeNull();
  const retried=await f.reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(retried).not.toBeNull();expect(retried!.terminationEvidence.every(ref=>ref.evidenceId!==rolled.evidenceId)).toBe(true);expect(f.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')).toHaveLength(1);expect(f.projections.size).toBe(1);
});

it('W4-B2 split large SOURCE pairs preserve action bounds through the first seal',async()=>{
  const f=await manyOriginals(64,{large:true}),api=await readerApi(),query=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('FROM work_items w JOIN executions e'))return {rows:[{current:true}]};
    if(sql.includes("kind='WINDOWS_STAGE_COST_SEAL'"))return {rows:f.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_SEAL'&&row.execution_id===f.input.executionId)};
    return query(sql,values);
  });
  const transaction=vi.fn(async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({...f.tx}));Object.assign(f.db,{accountTransaction:transaction});
  const reader=new api.WindowsStageCostReader({db:f.db,windows:f.journal,nonWindows:{nonWindowsIn:f.nonWindowsIn,checkpointFactsIn:f.checkpointFactsIn},bounds:{...api.windowsStageCostBounds}});
  const candidate=await reader.prepareCandidate(f.input,f.basis);expect(candidate,'큰 64쌍 준비가 원 예산을 만족해야 한다').not.toBeNull();
  const sealed=await reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(sealed,'큰 64쌍의 최종 봉인도 누적 action 예산을 만족해야 한다').not.toBeNull();
  expect(f.reads.source).toBe(128);expect(sealed!.facts.quantities![0].quantity).toBe('236118324143482.260672');expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(65);
  console.info(JSON.stringify({splitLargeSources:{bytes:[...f.sources.values()].reduce((sum,s)=>sum+Buffer.byteLength(JSON.stringify(s.value)),0),reads:f.reads,transactions:transaction.mock.calls.length}}));
},30000);

// 이 fixture는 직렬화 경계만 검사한다. 의미·서명 검증은 기존 실제 journal 회귀가 맡는다.
async function sourceSizingFixture(){
  const f=await stageFixture('FRESH'),o=f.census.originals[0],facts=await f.journal.stageOriginalFactsIn(f.tx,structuredClone(f.bundle),f.key,{operation:o.sourceOperation,termination:o.sourceTermination});expect(facts).not.toBeNull();
  const accepted:unknown[]=[],port=vi.spyOn(f.journal,'stageOriginalFactsIn').mockImplementation(async(_tx,bundle)=>{accepted.push(bundle);return facts;});
  return {...f,accepted,port};
}
function sourceBundle(values:unknown[]){
  const bodies=values.map(value=>({evidenceId:randomUUID(),evidenceDigest:digest(value),value}));
  const input=bodies[0],basis=bodies[1]??null;
  const bundle={state:{facts:{input:{...input,value:null},basis:basis?{...basis,value:null}:null}},observationDigests:[],original:{},job:{}};
  const hydrated=structuredClone(bundle);hydrated.state.facts.input.value=input.value as null;if(basis)hydrated.state.facts.basis!.value=basis.value as null;
  return {bodies,bundle,hydrated,inputRef:{evidenceId:input.evidenceId,evidenceDigest:input.evidenceDigest},basisRef:basis?{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest}:null};
}
async function sizeOriginal(f:Awaited<ReturnType<typeof sourceSizingFixture>>,values:unknown[],maximum:number,cache=new Map()){
  const spec=sourceBundle(values);const originalReads=f.accepted.length;
  f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
    expect(sql).toContain('windows_stage_cost_lookup(');const q=JSON.parse(parameters[0] as string);
    if(q.mode==='ORIGINAL')return {rows:[{value:{version:1,mode:'ORIGINAL',key:f.key,inputRef:spec.inputRef,basisRef:spec.basisRef,bundle:structuredClone(spec.bundle)}}]};
    expect(q.mode).toBe('SOURCE');const n=spec.bodies.findIndex(source=>source.evidenceId===q.ref.evidenceId);expect(n).toBeGreaterThanOrEqual(0);const source=spec.bodies[n];return {rows:[{value:{version:1,mode:'SOURCE',kind:n===0?'INPUT':'OPERATIONAL_COST_BASIS',ref:{evidenceId:source.evidenceId,evidenceDigest:source.evidenceDigest},value:source.value}}]};
  });
  const reader=await boundedReader(f,{maxRecordBytes:maximum}),invoke=Reflect.get(reader,'original');
  let result:unknown=null;try{result=await Reflect.apply(invoke,reader,[f.tx,f.owner,f.key,{operation:null,termination:null},cache,{bytes:0,nodes:0}]);}catch(error){expect(error).toHaveProperty('nextAction','WAIT');}
  return {result,spec,accepted:f.accepted.length-originalReads};
}
it('W4-B2 split SOURCE preserves the native JSON oracle for escaped strings and both hydrated slots',async()=>{
  const f=await sourceSizingFixture(),samples:unknown[]=[null,'','quote" and slash\\', '\b\t\n\f\r\u0000', '한국어🙂',{'key\n"\\':'value\r\t',array:[true,0,-0,1e-8,null,'\b']},['repeat','repeat']];
  let cases=0;try{
  for(const value of samples){for(const values of [[value],[value,value]]){
    const sample=sourceBundle(values),encoded=Buffer.byteLength(JSON.stringify(sample.hydrated));let minimum=encoded;
    while(true){try{nativeJsonBytes(sample.hydrated,minimum);break;}catch(error){expect(error).toHaveProperty('code','NATIVE_METADATA_LIMIT');minimum++;}}
    for(const maximum of new Set([encoded-1,encoded,encoded+1,minimum-1,minimum,minimum+1])){
      let permitted=true;try{nativeJsonBytes(sample.hydrated,maximum);}catch{permitted=false;}
      const checked=await sizeOriginal(f,values,maximum);expect(checked.result!==null,JSON.stringify({values,maximum,minimum})).toBe(permitted);expect(checked.accepted).toBe(permitted?1:0);cases++;
    }
  }}
  expect(cases).toBeGreaterThanOrEqual(42);
  }finally{f.port.mockRestore();}
});
it('W4-B2 split SOURCE preserves hydrated depth 64 and refuses depth 65',async()=>{
  const f=await sourceSizingFixture();try{for(const depth of [60,61]){let body:unknown='leaf';for(let n=0;n<depth;n++)body={next:body};
    const check=await sizeOriginal(f,[body],1572864);let permitted=true;try{nativeJsonBytes(check.spec.hydrated,1572864);}catch{permitted=false;}
    expect(check.result!==null).toBe(permitted);expect(permitted).toBe(depth===60);expect(check.accepted).toBe(permitted?1:0);
  }}finally{f.port.mockRestore();}
});
it.each(['missing','digest','input-id','basis'] as const)('W4-B2 split SOURCE never substitutes its cache for a fresh ORIGINAL authority: %s',async defect=>{
  const f=await splitPreparationFixture('FRESH'),candidate=await f.prepare();expect(candidate).not.toBeNull();const query=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
    const reply=await query(sql,parameters);if(!sql.includes('windows_stage_cost_lookup(')||JSON.parse(parameters[0] as string).mode!=='ORIGINAL')return reply;
    if(defect==='missing')return {rows:[{value:null}]};const value=(reply.rows[0] as {value:unknown}).value as {inputRef:CostEvidenceRef;basisRef:CostEvidenceRef|null;bundle:{state:{facts:{input:{evidenceId:string;evidenceDigest:string};basis:unknown}}}};
    if(defect==='digest'){value.inputRef.evidenceDigest=sha256('다른 원 INPUT');value.bundle.state.facts.input.evidenceDigest=value.inputRef.evidenceDigest;}
    if(defect==='input-id'){value.inputRef.evidenceId=randomUUID();value.bundle.state.facts.input.evidenceId=value.inputRef.evidenceId;}
    if(defect==='basis')value.basisRef=value.inputRef;
    return reply;
  });
  expect(await f.reader.sealIn(f.tx,f.input,f.basis,candidate!)).toBeNull();expect(f.rows.filter(row=>row.kind==='WINDOWS_STAGE_COST_SEAL')).toHaveLength(0);expect(f.lookupModes.filter(mode=>mode==='SOURCE')).toHaveLength(defect==='input-id'?2:1);
});

it('W4-B2 split SOURCE owns frozen bodies only for its candidate and reads historical SOURCE independently',async()=>{
  const f=await splitPreparationFixture('FRESH'),api=await readerApi(),facts=vi.spyOn(f.journal,'stageOriginalFactsIn');
  try{
    const reader=new api.WindowsStageCostReader({db:f.db,windows:f.journal,nonWindows:{nonWindowsIn:f.nonWindowsIn,checkpointFactsIn:f.checkpointFactsIn},bounds:{...api.windowsStageCostBounds}});
    const candidate=await reader.prepareCandidate(f.input,f.basis);expect(candidate).not.toBeNull();
    const bundle=facts.mock.calls[0][1] as {state:{facts:{input:{value:StageInput}}}},body=bundle.state.facts.input.value;
    expect(body).not.toBe(f.bundle.state.facts.input.value);expect(Object.isFrozen(body)).toBe(true);expect(Object.isFrozen(body.settings)).toBe(true);expect(Object.isFrozen(body.initialData.blocks)).toBe(true);
    const sealed=await reader.sealIn(f.tx,f.input,f.basis,candidate!);expect(sealed).not.toBeNull();expect(f.lookupModes.filter(mode=>mode==='SOURCE')).toHaveLength(1);
    expect(await reader.workSetIn(f.tx,f.input,f.basis)).toEqual(sealed);expect(f.lookupModes.filter(mode=>mode==='SOURCE')).toHaveLength(2);
  }finally{facts.mockRestore();}
});
