import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,type NativeJob} from '../../packages/native/src/dto.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,validateNativeJobIntent,validateNativeJobObservation,validateNativeJobObservationV2,type NativeJobIntent,type NativeJobObservation,type NativeOwnerCapture,type NativeJobState,type NativeJobObservationV2,type NativeJobStateV2} from '../../packages/domain/src/native-jobs.js';
import type {Database,Transaction} from '../../packages/storage/src/database.js';

const capture:NativeOwnerCapture={contextId:null,contextGeneration:null,ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:null,workspaceRevision:null};
function job(task:'DECODE_IMAGE'|'GEMINI_PREPARE'|'GEMINI_APPLY'='GEMINI_APPLY'):NativeJob{
  const metadata:Record<string,unknown>=task==='DECODE_IMAGE'?{sourceBlobId:'source'}:{input:{executionId:randomUUID(),inputDigest:sha256('owned-capture'),claimGeneration:'1'},proposal:{owned:'proposal'},novelRegionIds:[randomUUID(),randomUUID()]};
  return createNativeJob(task,sha256('owned-profile'),metadata,new Map([['source',Buffer.from('owned-input')]]),{maxMetadataBytes:8192,maxBinaryBytes:8192,maxItems:3});
}
function intent(input:NativeJob=job()):NativeJobIntent{
  const fields={version:1 as const,jobId:input.jobId,task:input.task,taskVersion:input.taskVersion,profileDigest:input.profileDigest,inputDigest:input.inputDigest,operationInputDigest:nativeOperationInputDigest(input),parentInstanceId:randomUUID(),targetKind:'UPLOAD' as const,targetId:randomUUID(),semanticCaptureDigest:sha256('owned-semantic-capture'),protectedOwnerCapture:structuredClone(capture),claim:{generation:'0',ownerId:randomUUID(),workItemId:null}};
  return {...fields,logicalOperationKey:nativeLogicalOperationKey(fields)};
}
function observation(i=intent()):NativeJobObservation{return {version:1,parentInstanceId:i.parentInstanceId,event:'ERROR',code:'NATIVE_JOB_TIMEOUT',resultDigest:null,termination:{jobId:i.jobId,inputDigest:i.inputDigest,profileDigest:i.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED',isolation:'OWNED_FIXTURE'}};}
function store(decision:unknown={allowed:true,reason:'CREATED'},role?:Database['role']){
  const query=vi.fn(async()=>({rows:[{decision}]}));const accountTransaction=vi.fn(async(_accountId:string,run:(tx:Transaction)=>Promise<unknown>,_allowRestricted?:boolean)=>run({client:{query}} as unknown as Transaction));
  return {store:new NativeJobStore({accountTransaction,role} as unknown as Database,randomUUID()),query,accountTransaction};
}

describe('parent-only native intent and stable logical identity',()=>{
  it.each(['GEMINI_PREPARE','GEMINI_APPLY'] as const)('excludes a new job UUID and %s claim generation without changing the original frame',task=>{
    const original=job(task),before=structuredClone(original);const changed=structuredClone(original);changed.jobId=randomUUID();(changed.metadata.input as Record<string,unknown>).claimGeneration='923';changed.inputDigest=sha256('new-transport-frame');
    expect(nativeOperationInputDigest(changed)).toBe(nativeOperationInputDigest(original));expect(changed.inputDigest).not.toBe(original.inputDigest);expect(original).toEqual(before);
    const first=intent(original);const later={...first,jobId:changed.jobId,inputDigest:changed.inputDigest,parentInstanceId:randomUUID(),operationInputDigest:nativeOperationInputDigest(changed),claim:{...first.claim,generation:'923'}};
    expect(nativeLogicalOperationKey(later)).toBe(first.logicalOperationKey);expect(validateNativeJobIntent(later).inputDigest).toBe(changed.inputDigest);
  });
  it('keeps new novel output IDs in the same logical operation while retaining their original frame authority',()=>{
    const original=job(),changed=structuredClone(original);changed.jobId=randomUUID();changed.metadata.novelRegionIds=[randomUUID(),randomUUID()];changed.inputDigest=sha256('different-owned-output-ID-pool');
    expect(nativeOperationInputDigest(changed)).toBe(nativeOperationInputDigest(original));expect(original.metadata.novelRegionIds).not.toEqual(changed.metadata.novelRegionIds);
    const first=intent(original);expect(nativeLogicalOperationKey({...first,operationInputDigest:nativeOperationInputDigest(changed)})).toBe(first.logicalOperationKey);
    const differentCount=structuredClone(original);(differentCount.metadata.novelRegionIds as string[]).push(randomUUID());expect(nativeOperationInputDigest(differentCount)).not.toBe(first.operationInputDigest);
  });
  it('changes semantic identity for actual proposal, blob dependency and profile changes',()=>{
    const original=job(),before=nativeOperationInputDigest(original);
    const proposal=structuredClone(original);proposal.metadata.proposal={owned:'different'};expect(nativeOperationInputDigest(proposal)).not.toBe(before);
    const blob=structuredClone(original);blob.blobs[0].sha256=sha256('different-owned-bytes');expect(nativeOperationInputDigest(blob)).not.toBe(before);
    const profile=structuredClone(original);profile.profileDigest=sha256('different-profile');expect(nativeOperationInputDigest(profile)).not.toBe(before);
    const first=intent(original);expect(nativeLogicalOperationKey({...first,semanticCaptureDigest:sha256('different-capture')})).not.toBe(first.logicalOperationKey);
  });
  it('does not strip claim generation from unrelated task metadata',()=>{
    const original=job('DECODE_IMAGE');original.metadata.input={claimGeneration:'1'};const later=structuredClone(original);(later.metadata.input as Record<string,unknown>).claimGeneration='2';expect(nativeOperationInputDigest(later)).not.toBe(nativeOperationInputDigest(original));
  });
  it('refuses accessor-backed metadata and intent fields without invoking them',()=>{
    const original=job('DECODE_IMAGE');const getter=vi.fn(()=> 'owned');Object.defineProperty(original.metadata,'sourceBlobId',{get:getter,enumerable:true});expect(()=>nativeOperationInputDigest(original)).toThrow('NATIVE_PROTOCOL_INVALID');expect(getter).not.toHaveBeenCalled();
    const value=intent();Object.defineProperty(value,'task',{get:getter,enumerable:true});expect(()=>validateNativeJobIntent(value)).toThrow('NATIVE_JOB_RECORD_INVALID');expect(getter).not.toHaveBeenCalled();
  });
  it('keeps only closed opaque identity and rejects paths, raw payload, secret or mismatched logical keys',()=>{
    const first=intent();expect(validateNativeJobIntent(first)).toEqual(first);expect(JSON.stringify(first)).not.toContain('owned-input');
    for(const value of [{...first,path:'owned-path'},{...first,metadata:{raw:'owned-payload'}},{...first,secret:'owned-fake-secret'},{...first,logicalOperationKey:sha256('different-key')},{...first,task:'ARBITRARY_TASK'},{...first,targetKind:'ARBITRARY_TARGET'}])expect(()=>validateNativeJobIntent(value)).toThrow('NATIVE_JOB_RECORD_INVALID');
  });
  it('validates nullable capture pairs and exact nonnegative bigint claims before any DB hook',()=>{
    const first=intent();for(const value of [{...first,claim:{...first.claim,generation:'9223372036854775808'}},{...first,claim:{...first.claim,generation:'-1'}},{...first,claim:{...first.claim,generation:1}},{...first,protectedOwnerCapture:{...capture,contextId:randomUUID()}},{...first,protectedOwnerCapture:{...capture,contextGeneration:'1'}}])expect(()=>validateNativeJobIntent(value)).toThrow('NATIVE_JOB_RECORD_INVALID');
    expect(validateNativeJobIntent({...first,claim:{...first.claim,generation:'9223372036854775807'}}).claim.generation).toBe('9223372036854775807');
  });
  it('clones the original ERROR snapshot without replacing it with a later termination',()=>{
    const original=observation(),copy=validateNativeJobObservation(original);copy.termination.operationJoined=true;expect(original.termination.operationJoined).toBe(false);expect(copy.termination.goAttempted).toBe(true);
    expect(()=>validateNativeJobObservation({...original,resultDigest:sha256('output')})).toThrow('NATIVE_JOB_RECORD_INVALID');
  });
  it('refuses physical termination contradictions and preserves uncertain joined and GO facts',()=>{
    const first=observation();expect(validateNativeJobObservation(first).termination.kind).toBe('UNCONFIRMED');
    for(const t of [{...first.termination,startedComputation:true,goAttempted:false},{...first.termination,subtreeTerminationConfirmed:true},{...first.termination,kind:'NO_CHILD_CREATED'},{...first.termination,kind:'DIRECT_CHILD_ONLY'},{...first.termination,kind:'CGROUP_EMPTY',operationJoined:true,subtreeTerminationConfirmed:true}])expect(()=>validateNativeJobObservation({...first,termination:t})).toThrow('NATIVE_JOB_RECORD_INVALID');
    const candidate={...first,termination:{...first.termination,goAttempted:false,startedComputation:false,directChildClosed:false,operationJoined:true,kind:'NO_CHILD_CREATED' as const}};expect(validateNativeJobObservation(candidate).termination.kind).toBe('NO_CHILD_CREATED');
  });
  it('persists intent through one owning function and retains an explicit refusal without retrying',async()=>{
    const f=store({allowed:false,reason:'NATIVE_JOB_UNRESOLVED'});const first=intent();await expect(f.store.beforeIntent(first)).rejects.toThrow('NATIVE_JOB_UNRESOLVED');expect(f.query).toHaveBeenCalledOnce();expect(f.query.mock.calls[0]).toEqual(['SELECT manga_web.native_job_create_intent($1::jsonb) AS decision',[JSON.stringify(first)]]);
  });
  it('passes the original parent, claim and protected capture into the single GO consumption',async()=>{
    const f=store({allowed:true,reason:'GO_CONSUMED'}),first=intent();await f.store.beforeGo(first.jobId,first.parentInstanceId,first.claim,first.protectedOwnerCapture);expect(f.query.mock.calls[0]).toEqual(['SELECT manga_web.native_job_consume_go($1,$2,$3::jsonb,$4::jsonb) AS decision',[first.jobId,first.parentInstanceId,JSON.stringify(first.claim),JSON.stringify(first.protectedOwnerCapture)]]);
  });
  it('keeps new native GO admission separate from retaining raw observations after restriction',async()=>{
    const first=intent();for(const role of ['trio_web_worker','trio_web_api'] as const){
      const f=store({allowed:true,reason:'CREATED'},role);await f.store.beforeIntent(first);await f.store.beforeGo(first.jobId,first.parentInstanceId,first.claim,first.protectedOwnerCapture);await f.store.observe(randomUUID(),observation(first));
      expect(f.accountTransaction.mock.calls[0][2]).toBeUndefined();expect(f.accountTransaction.mock.calls[1][2]).toBeUndefined();expect(f.accountTransaction.mock.calls[2][2]).toBe(true);
    }
  });
  it('keeps candidate termination unresolved with cost and application independent',async()=>{
    const value:NativeJobState={jobId:randomUUID(),parentInstanceId:randomUUID(),logicalOperationKey:sha256('owned-key'),go:'UNCONSUMED',result:'OBSERVED',termination:'NO_CHILD_CANDIDATE',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true,firstError:null};
    const f=store();f.query.mockResolvedValueOnce({rows:[{state:value}]} as never);expect(await f.store.unresolved(value.logicalOperationKey)).toEqual([value]);expect(f.query).toHaveBeenCalledOnce();
  });
});


function windowsObservation(i=intent()):NativeJobObservationV2{
  return {version:2,parentInstanceId:i.parentInstanceId,event:'TERMINATION',code:'OK',resultDigest:null,windowsRecordRef:{recordId:randomUUID(),recordDigest:sha256('original-seal')},termination:{jobId:i.jobId,inputDigest:i.inputDigest,profileDigest:i.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY',isolation:'WINDOWS_JOB_OBJECT'}};
}
function windowsState():NativeJobStateV2{
  return {jobId:randomUUID(),parentInstanceId:randomUUID(),logicalOperationKey:sha256('windows-logical-key'),go:'CONSUMED',result:'OBSERVED',termination:'UNTRUSTED_WINDOWS_CANDIDATE',cost:'UNCONFIRMED',application:'UNCONFIRMED',unresolved:true,firstError:null,windowsEvidenceRef:{recordId:randomUUID(),recordDigest:sha256('original-seal'),linkId:randomUUID(),linkDigest:sha256('original-link')}};
}
describe('W3-B original Windows observation and unresolved reading',()=>{
  it('validates and clones exactly seven v2 observation keys and ten termination keys',()=>{
    const value=windowsObservation(),checked=validateNativeJobObservation(value);
    expect(checked).toEqual(value);expect(Object.keys(checked)).toHaveLength(7);expect(Object.keys(checked.termination)).toHaveLength(10);
    checked.termination.directChildClosed=false;expect(value.termination.directChildClosed).toBe(true);
    if(checked.version===2)checked.windowsRecordRef.recordDigest=sha256('mutated');
    expect(value.windowsRecordRef.recordDigest).toBe(sha256('original-seal'));
    const result={...value,event:'RESULT' as const,resultDigest:sha256('original-result')};expect(validateNativeJobObservation(result)).toEqual(result);
  });
  it('requires an original record even for uncertainty and preserves confirmed no-child facts',()=>{
    const value=windowsObservation(),uncertain={...value,event:'ERROR' as const,code:'WINDOWS_UNCONFIRMED',termination:{...value.termination,kind:'UNCONFIRMED' as const,subtreeTerminationConfirmed:false,operationJoined:false}};
    expect(validateNativeJobObservation(uncertain)).toEqual(uncertain);
    const noChild={...value,termination:{...value.termination,kind:'NO_CHILD_CREATED' as const,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false}};
    expect(validateNativeJobObservation(noChild)).toEqual(noChild);
    const {windowsRecordRef:_ref,...missing}=uncertain;expect(()=>validateNativeJobObservation(missing)).toThrow();
  });
  it('rejects version/isolation crossings, missing original refs, hidden data and termination contradictions',()=>{
    const value=windowsObservation(),{windowsRecordRef:_ref,...legacy}=value;
    const terms=[{...value.termination,goAttempted:false},{...value.termination,directChildClosed:false},{...value.termination,operationJoined:false},{...value.termination,subtreeTerminationConfirmed:false},{...value.termination,kind:'UNCONFIRMED'},{...value.termination,kind:'NO_CHILD_CREATED'},{...value.termination,kind:'DIRECT_CHILD_ONLY'},{...value.termination,kind:'CGROUP_EMPTY'},{...value.termination,isolation:'LINUX_CGROUP_V2'},{...value.termination,isolation:'OWNED_FIXTURE'},{...value.termination,windowsRecordRef:value.windowsRecordRef}];
    for(const termination of terms)expect(()=>validateNativeJobObservation({...value,termination})).toThrow('NATIVE_JOB_RECORD_INVALID');
    for(const changed of [{...legacy,version:1},{...value,version:1},{...value,windowsRecordRef:null},{...value,windowsRecordRef:{...value.windowsRecordRef,linkId:randomUUID()}},{...value,windowsRecordRef:{...value.windowsRecordRef,recordId:'path'}},{...value,windowsRecordRef:{...value.windowsRecordRef,recordDigest:'A'.repeat(64)}},{...value,windowsEvidenceRef:{}},{...value,event:'RESULT'},{...value,resultDigest:sha256('unsolicited')}])expect(()=>validateNativeJobObservation(changed)).toThrow('NATIVE_JOB_RECORD_INVALID');
    const getter=vi.fn(()=>value.windowsRecordRef),accessor=Object.defineProperty({...value},'windowsRecordRef',{get:getter,enumerable:true});
    expect(()=>validateNativeJobObservation(accessor)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>validateNativeJobObservation(Object.defineProperty({...value},'secret',{value:'hidden'}))).toThrow();
  });
  it('refuses generic append for a v2 observation before any DB access',async()=>{
    const f=store();await expect(f.store.observe(randomUUID(),windowsObservation() as unknown as NativeJobObservation)).rejects.toThrow('NATIVE_JOB_RECORD_INVALID');expect(f.accountTransaction).not.toHaveBeenCalled();
  });
  it('reads linked Windows candidates without confirming cost application or release',async()=>{
    const value=windowsState(),f=store();f.query.mockResolvedValueOnce({rows:[{state:value}]} as never);
    const actual=await f.store.unresolved(value.logicalOperationKey);expect(actual).toEqual([value]);
    if('windowsEvidenceRef'in actual[0])actual[0].windowsEvidenceRef.recordDigest=sha256('changed');
    expect(value.windowsEvidenceRef.recordDigest).toBe(sha256('original-seal'));
    const noChild={...value,go:'UNCONSUMED',result:'UNOBSERVED',termination:'NO_CHILD_CANDIDATE'};f.query.mockResolvedValueOnce({rows:[{state:noChild}]} as never);expect(await f.store.unresolved(value.logicalOperationKey)).toEqual([noChild]);
  });
  it.each(['cost','application','unresolved','termination','jobId','parentInstanceId','logicalOperationKey','windowsEvidenceRef','firstError'] as const)('rejects an invalid unresolved Windows %s from the DB',async key=>{
    const value=windowsState(),f=store();const malformed:Record<string,unknown>={...value};
    if(key==='cost'||key==='application')malformed[key]='CONFIRMED';
    else if(key==='unresolved')malformed[key]=false;
    else if(key==='termination')malformed[key]='WINDOWS_JOB_EMPTY';
    else if(key==='logicalOperationKey')malformed[key]=sha256('different-query');
    else if(key==='jobId'||key==='parentInstanceId')malformed[key]='invalid';
    else if(key==='firstError')malformed[key]={observationId:randomUUID(),digest:sha256('error'),receivedAt:'2026-10-18T00:00:00.000Z',snapshot:windowsObservation()};
    else malformed[key]={recordId:value.windowsEvidenceRef.recordId,recordDigest:value.windowsEvidenceRef.recordDigest};
    f.query.mockResolvedValueOnce({rows:[{state:malformed}]} as never);await expect(f.store.unresolved(value.logicalOperationKey)).rejects.toThrow('NATIVE_JOB_RECORD_INVALID');
  });
  it('rejects legacy values through the explicit v2 observation validator',()=>{
    const value=windowsObservation();expect(validateNativeJobObservationV2(value)).toEqual(value);
    expect(()=>validateNativeJobObservationV2(observation())).toThrow('NATIVE_JOB_RECORD_INVALID');
  });
  it.each(['recordId','recordDigest','jobId','parentInstanceId'] as const)('retains only the original first-error %s in a Windows unresolved read',async key=>{
    const state=windowsState(),error=windowsObservation();error.event='ERROR';error.parentInstanceId=state.parentInstanceId;error.termination.jobId=state.jobId;
    error.windowsRecordRef={recordId:state.windowsEvidenceRef.recordId,recordDigest:state.windowsEvidenceRef.recordDigest};
    state.firstError={observationId:randomUUID(),digest:sha256('stored-original-error'),receivedAt:'2026-10-18T00:00:00.000Z',snapshot:error};
    const f=store();f.query.mockResolvedValueOnce({rows:[{state}]} as never);expect(await f.store.unresolved(state.logicalOperationKey)).toEqual([state]);
    if(key==='parentInstanceId')error.parentInstanceId=randomUUID();
    else if(key==='jobId')error.termination.jobId=randomUUID();
    else error.windowsRecordRef[key]=key==='recordId'?randomUUID():sha256('other-original-record');
    f.query.mockResolvedValueOnce({rows:[{state}]} as never);await expect(f.store.unresolved(state.logicalOperationKey)).rejects.toThrow('NATIVE_JOB_RECORD_INVALID');
  });

});
