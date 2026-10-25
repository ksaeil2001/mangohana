import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {LocalLaMaBindingReader,type LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-reader.js';
import type {NativeJobClaim} from '../../packages/domain/src/native-jobs.js';
import type {PipelineStageCandidate} from '../../packages/domain/src/pipeline-evidence.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';

// Metadata-only owned records and invented rates. No pixels, actual engine,
// SQL authority, observed measurement, current permit or closure are proved.
type Evidence={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};
const calculator=():FullStageCostBounds=>({maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512});
const limits=():LocalLaMaBindingReaderBounds=>({maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:4,calculator:calculator()});
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function fixture(){
  const accountId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),executionId=randomUUID(),originalAssetId=randomUUID(),profileId='owned-binding-profile',profileDigest=sha256('owned-binding-profile');
  const settings={settingsVersion:'1',contractVersion:'owned-binding-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const image={assetId:originalAssetId,sha256:sha256('owned-image-record'),bytesLength:'16',mediaType:'image/png'};
  const input:StageInput={accountId,contextId,requestId,executionId,stage:'CLEANUP',inputDigest:sha256('owned-binding-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',assetDependencies:[image],currentCleanedAssetId:null,currentRenderAssetId:null,previousOutputAssetIds:[],
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest:sha256('owned-binding-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:profileId}};
  const captureBody:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest:input.inputDigest,profileId,profileDigest,identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('owned-weights'),configSha256:sha256('owned-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:image.sha256,imageByteLength:16,maskSha256:sha256('owned-mask-record'),maskByteLength:8};
  const capture:LocalLaMaCapture={...captureBody,captureDigest:digest(captureBody)},claim:NativeJobClaim={generation:'1',ownerId:randomUUID(),workItemId:randomUUID()};
  const snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'CLEANUP',profileDigest,basisVersion:'owned-binding-basis',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-basis-record'],components:[{componentId:'mask',kind:'IMAGE',unit:'pixel',rateVersion:'owned-rate',usdPerUnit:'0.001',evidenceRefs:['owned-rate-record']}]};
  const calculation=new FullStageCostCalculator(snapshot,calculator()).calculate({accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'CLEANUP',profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
  const basis:FullStageCostBasis={version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:structuredClone(calculation.snapshot) as FullStageCostSnapshot,snapshotDigest:calculation.snapshotDigest};
  const candidate:PipelineStageCandidate={version:1,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'CLEANUP',claimGeneration:'1',evidenceId:randomUUID(),maskAssetId:randomUUID(),cleanedAssetId:randomUUID(),renderAssetId:null};
  const source={version:1,candidate,phase:'LAMA_INPUT',value:{capture,image,mask:{assetId:candidate.maskAssetId,sha256:capture.maskSha256,bytesLength:String(capture.maskByteLength),mediaType:'image/png'}}};
  const evidence=(kind:string,value:unknown):Evidence=>{const protected_observation=structuredClone(kind==='INPUT'?value:{version:1,accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind,value});const evidence_id=randomUUID();return {evidence_id,evidence_digest:digest(protected_observation),protected_evidence_ref:evidence_id,kind,protected_observation};};
  const records:Evidence[]=[evidence('INPUT',canonicalInput(input)),evidence('OPERATIONAL_COST_BASIS',basis),evidence('OPERATIONAL_CANDIDATE',candidate),evidence('OPERATIONAL_SOURCE',source)];
  const core={request_id:requestId,logical_step_id:'CLEANUP',input_digest:input.inputDigest,contract_version:settings.contractVersion,execution_state:'DISPATCHING',claim_generation:'1',dispatch_attempted:true,context_id:contextId,request_generation:'1',page_lineage_id:input.envelope!.pageLineageId,mode:'FREE',request_state:'ACCEPTED',request_terminal:false,request_started:false,context_generation:'1',lifecycle:'OPEN',scope_digest:digest(input.scope),captured_settings:structuredClone(settings),native_hold:false};
  const fence={work_item_id:claim.workItemId,kind:'DISPATCH',state:'CLAIMED',claim_owner:claim.ownerId,claim_generation:'1',lease_live:true,request_matches:true,pointer_matches:true,session_active:true,connected:true,page_current:true,cost_clear:true,wait_clear:true,native_clear:true};
  const account={account_id:accountId,access_state:'ACTIVE',auth_generation:'1'};const now=new Date('2026-10-04T00:00:00Z');
  const query=vi.fn(async(sql:string,_values?:unknown[])=>({rows:sql.includes('FROM execution_evidence')?records:sql.includes('FROM work_items w')?[fence]:[core]}));
  const tx={account,now,client:{query}} as unknown as Transaction;
  const accountTransaction=vi.fn(async(_accountId:string,run:(tx:Transaction)=>Promise<unknown>,_restricted?:boolean)=>run(tx));
  const db={role:'trio_web_worker',accountTransaction} as unknown as Database;
  const expected=()=>({version:1,accountId,requestId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,mode:'FREE'});
  return {input,capture,claim,basis,snapshot,candidate,source,records,evidence,core,fence,account,tx,query,accountTransaction,db,expected,bounds:limits(),reader:()=>new LocalLaMaBindingReader(db,limits())};
}
const hold={code:'LOCAL_LAMA_BINDING_UNCONFIRMED',nextAction:'WAIT'},dispatchHold={code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED',nextAction:'WAIT'},capacityHold={code:'LOCAL_LAMA_BINDING_CAPACITY',nextAction:'WAIT'};
const record=(row:Evidence)=>row.protected_observation as Record<string,unknown>;
const refresh=(row:Evidence)=>{row.evidence_digest=digest(row.protected_observation);};
function proxy<T extends object>(value:T){let calls=0;const trap=()=>{calls++;throw Error('OWNED_PROXY_TRAP');};return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}
function getter<T extends object>(value:T,key:string){let calls=0;Object.defineProperty(value,key,{enumerable:true,configurable:true,get(){calls++;throw Error('OWNED_GETTER');}});return {value,calls:()=>calls};}

describe('private local LaMa original binding reader',()=>{
  it('returns the original distinct local/full-stage capture binding',async()=>{const f=fixture();expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());expect(f.basis.captureDigest).not.toBe(f.capture.captureDigest);});
  it('reads an ACCEPTED request after preflight with the exact live DISPATCH claim',async()=>{const f=fixture();expect(await f.reader().readForDispatch(f.input,f.capture,f.claim)).toEqual(f.expected());expect(f.accountTransaction).toHaveBeenCalledExactlyOnceWith(f.input.accountId,expect.any(Function),true);});
  it('rejects a protected cross-account source rather than returning a binding',async()=>{const f=fixture();const row=f.records[3],record=row.protected_observation as Record<string,unknown>;record.accountId=randomUUID();row.evidence_digest=digest(record);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_BINDING_UNCONFIRMED'});});
  it('holds an orphan LAMA_INPUT even when its basis and candidate are absent',async()=>{const f=fixture();f.records.splice(1,2);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_BINDING_UNCONFIRMED'});});
  it('preserves independently versioned original full-stage and local media profiles',async()=>{
    const f=fixture(),profileDigest=sha256('owned-independent-whole-stage-profile'),snapshot={...f.snapshot,profileDigest};
    const result=new FullStageCostCalculator(snapshot,calculator()).calculate({accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),stage:'CLEANUP',profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
    Object.assign(f.basis,{capture:result.capture,captureDigest:result.captureDigest,snapshot:result.snapshot,snapshotDigest:result.snapshotDigest});f.records[1]=f.evidence('OPERATIONAL_COST_BASIS',f.basis);
    expect(f.basis.capture.profileDigest).not.toBe(f.capture.profileDigest);expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());expect(await f.reader().readForDispatch(f.input,f.capture,f.claim)).toEqual(f.expected());
  });
  it.each([1,2,3])('returns null for a fully verified normal prefix of %i records',async count=>{const f=fixture();f.records.length=count;expect(await f.reader().readOriginal(f.input,f.capture)).toBeNull();expect(f.query.mock.calls.filter(([sql])=>sql.includes('FROM execution_evidence'))).toHaveLength(1);});
  it('validates every trailing record before a missing-prefix return',async()=>{
    for(const missing of [1,2]){const f=fixture();f.records.splice(missing,1);record(f.records.at(-1)!).inputFingerprint=sha256('wrong-original-input');refresh(f.records.at(-1)!);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
    const f=fixture();f.records.length=2;record(f.records[1]).value={version:1,captureDigest:sha256('invalid-basis')};refresh(f.records[1]);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
  });
  it('holds a START without its original prepared input and an unknown phase',async()=>{
    const f=fixture();f.records[3]=f.evidence('OPERATIONAL_SOURCE',{version:1,candidate:f.candidate,phase:'LAMA_START',value:{evidenceId:randomUUID(),captureDigest:f.capture.captureDigest}});await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
    f.records[3]=f.evidence('OPERATIONAL_SOURCE',{...f.source,phase:'OWNED_UNKNOWN_PHASE'});await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
  });
  it.each(['NULL','UNMEASURED'] as const)('preserves the original %s cost basis without claiming complete cost',async state=>{
    const f=fixture(),snapshot=state==='NULL'?null:{...f.snapshot,state:'UNMEASURED' as const,components:[],evidenceRefs:[]};
    const normalized=new FullStageCostCalculator(snapshot,calculator()).calculate({accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),stage:'CLEANUP',profileDigest:f.basis.capture.profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
    Object.assign(f.basis,{capture:normalized.capture,captureDigest:normalized.captureDigest,snapshot:normalized.snapshot,snapshotDigest:normalized.snapshotDigest});f.records[1]=f.evidence('OPERATIONAL_COST_BASIS',f.basis);
    expect(normalized.actualUsd).toBeNull();expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());expect((record(f.records[1]).value as FullStageCostBasis).snapshot).toEqual(snapshot);
  });
  it('reads restricted, terminal, closed-context and expired original facts without renewing a claim',async()=>{
    const f=fixture(),before=structuredClone(f.records);f.account.access_state='RESTRICTED';f.core.request_state='STOPPED';f.core.request_terminal=true;f.core.execution_state='SUCCEEDED';f.core.lifecycle='CLOSED';f.fence.lease_live=false;f.input.claimGeneration='99';
    expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM work_items w'))).toBe(false);expect(f.records).toEqual(before);await expect(f.reader().readForDispatch(f.input,f.capture,f.claim)).rejects.toMatchObject(dispatchHold);
  });
  it('keeps the first candidate generation separate from a later exact current claim',async()=>{
    const f=fixture(),before=structuredClone(f.records);f.input.claimGeneration='2';f.claim.generation='2';f.claim.ownerId=randomUUID();f.core.claim_generation='2';f.fence.claim_generation='2';f.fence.claim_owner=f.claim.ownerId;
    expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());expect(await f.reader().readForDispatch(f.input,f.capture,f.claim)).toEqual(f.expected());expect(f.candidate.claimGeneration).toBe('1');expect(f.records).toEqual(before);
  });
  it.each(['ACCEPTED','ACTIVE','WAITING','STOP_REQUESTED'])('matches current %s request preflight semantics',async state=>{
    const f=fixture();f.core.request_state=state;f.core.request_started=state==='STOP_REQUESTED';expect(await f.reader().readForDispatch(f.input,f.capture,f.claim)).toEqual(f.expected());
  });
  it('rejects every closed/expired/core dispatch fence without losing original lookup',async()=>{
    const changes=[{request_state:'STOP_REQUESTED'},{request_state:'COMPLETED',request_terminal:true},{request_state:'FAILED',request_terminal:true},{execution_state:'PREPARED'},{execution_state:'RUNNING'},{execution_state:'UNKNOWN'},{dispatch_attempted:false},{claim_generation:'2'},{lifecycle:'CLOSED'},{context_generation:'2'},{native_hold:true}];
    for(const change of changes){const f=fixture();Object.assign(f.core,change);expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());await expect(f.reader().readForDispatch(f.input,f.capture,f.claim)).rejects.toMatchObject(dispatchHold);}
    const f=fixture();f.account.access_state='RESTRICTED';await expect(f.reader().readForDispatch(f.input,f.capture,f.claim)).rejects.toMatchObject(dispatchHold);
  });
  it('requires exact work ID, owner, generation, kind, live lease and every current scalar guard',async()=>{
    const changes=[{work_item_id:randomUUID()},{claim_owner:randomUUID()},{claim_owner:null},{claim_generation:'2'},{kind:'RECONCILE'},{state:'READY'},...['lease_live','request_matches','pointer_matches','session_active','connected','page_current','cost_clear','wait_clear','native_clear'].map(key=>({[key]:false}))];
    for(const change of changes){const f=fixture();Object.assign(f.fence,change);await expect(f.reader().readForDispatch(f.input,f.capture,f.claim)).rejects.toMatchObject(dispatchHold);expect(await f.reader().readOriginal(f.input,f.capture)).toEqual(f.expected());}
    const f=fixture();await expect(f.reader().readForDispatch(f.input,f.capture,{...f.claim,workItemId:null})).rejects.toMatchObject(dispatchHold);
  });
  it('rejects malformed current tuple and absent required claim rather than treating it as original lookup',async()=>{
    const f=fixture();for(const claim of [null,{}, {...f.claim,extra:true},{...f.claim,ownerId:'invalid'}])await expect(f.reader().readForDispatch(f.input,f.capture,claim as NativeJobClaim)).rejects.toMatchObject(hold);
    await expect(f.reader().readForDispatch(f.input,f.capture,undefined as unknown as NativeJobClaim)).rejects.toMatchObject(dispatchHold);expect(f.query).not.toHaveBeenCalled();
  });
  it('validates protected row refs, digests, shape, duplicates and original INPUT',async()=>{
    for(const kind of ['ref','digest','extra','wrapper','input','duplicate'] as const){const f=fixture();if(kind==='ref')f.records[3].protected_evidence_ref=randomUUID();if(kind==='digest')f.records[3].evidence_digest=sha256('wrong-digest');if(kind==='extra'){record(f.records[3]).extra=true;refresh(f.records[3]);}if(kind==='wrapper'){record(f.records[3]).executionId=randomUUID();refresh(f.records[3]);}if(kind==='input'){record(f.records[0]).claimGeneration='1';refresh(f.records[0]);}if(kind==='duplicate')f.records.push(structuredClone(f.records[2]));await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
  });
  it('rejects mismatching core INPUT execution/request/context/settings/scalar identities',async()=>{
    for(const change of [{request_id:randomUUID()},{logical_step_id:'OCR'},{input_digest:sha256('crossed-input')},{contract_version:'crossed-contract'},{context_id:randomUUID()},{request_generation:'2'},{page_lineage_id:randomUUID()},{scope_digest:sha256('crossed-scope')},{captured_settings:null},{mode:'PAID'}]){const f=fixture();Object.assign(f.core,change);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
  });
  it('rejects tampered basis capture/snapshot and duplicate basis or candidate',async()=>{
    for(const scenario of ['capture','snapshot','basis','candidate']){const f=fixture();if(scenario==='capture'){const value=record(f.records[1]).value as FullStageCostBasis;value.captureDigest=sha256('wrong-capture');refresh(f.records[1]);}if(scenario==='snapshot'){const value=record(f.records[1]).value as FullStageCostBasis;value.snapshot!.components[0].usdPerUnit='2';refresh(f.records[1]);}if(scenario==='basis')f.records.push(f.evidence('OPERATIONAL_COST_BASIS',{...f.basis,captureDigest:sha256('duplicate-basis')}));if(scenario==='candidate')f.records.push(f.evidence('OPERATIONAL_CANDIDATE',{...f.candidate,evidenceId:randomUUID()}));await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
  });
  it('requires distinct cleanup IDs and the exact original candidate on every source',async()=>{
    for(const change of [{renderAssetId:randomUUID()},{maskAssetId:null},{cleanedAssetId:randomUUID()},{maskAssetId:'not-uuid'},{claimGeneration:'0'},{inputFingerprint:sha256('crossed-candidate')}]){const f=fixture();const candidate={...f.candidate,...change};if(change.cleanedAssetId)candidate.cleanedAssetId=candidate.maskAssetId!;f.records[2]=f.evidence('OPERATIONAL_CANDIDATE',candidate);f.records[3]=f.evidence('OPERATIONAL_SOURCE',{...f.source,candidate});await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
    const f=fixture();f.records[3]=f.evidence('OPERATIONAL_SOURCE',{...f.source,candidate:{...f.candidate,evidenceId:randomUUID()}});await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
  });
  it('compares the current cleaned image dependency and both recorded binary descriptors exactly',async()=>{
    const valid=fixture(),cleaned=randomUUID();valid.input.currentCleanedAssetId=cleaned;valid.input.assetDependencies!.push({...valid.source.value.image,assetId:cleaned});valid.input.envelope!.assetIds.push(cleaned);valid.source.value.image={...valid.source.value.image,assetId:cleaned};
    const normalized=new FullStageCostCalculator(valid.snapshot,calculator()).calculate({accountId:valid.input.accountId!,executionId:valid.input.executionId,inputDigest:valid.input.inputDigest,inputFingerprint:digest(canonicalInput(valid.input)),stage:'CLEANUP',profileDigest:valid.capture.profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});Object.assign(valid.basis,{capture:normalized.capture,captureDigest:normalized.captureDigest});valid.candidate.inputFingerprint=digest(canonicalInput(valid.input));valid.records.splice(0,4,valid.evidence('INPUT',canonicalInput(valid.input)),valid.evidence('OPERATIONAL_COST_BASIS',valid.basis),valid.evidence('OPERATIONAL_CANDIDATE',valid.candidate),valid.evidence('OPERATIONAL_SOURCE',valid.source));expect(await valid.reader().readOriginal(valid.input,valid.capture)).toEqual(valid.expected());
    for(const change of [{image:{assetId:randomUUID()}},{image:{sha256:sha256('wrong-image')}},{image:{bytesLength:'17'}},{image:{mediaType:'image/jpeg'}},{mask:{assetId:randomUUID()}},{mask:{sha256:sha256('wrong-mask')}},{mask:{bytesLength:'9'}},{mask:{mediaType:'image/jpeg'}}]){const f=fixture(),source=structuredClone(f.source);Object.assign(source.value.image,change.image);Object.assign(source.value.mask,change.mask);f.records[3]=f.evidence('OPERATIONAL_SOURCE',source);await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);}
  });
  it('holds duplicate LAMA_INPUT and independently changed local capture or profile ID',async()=>{
    const f=fixture();f.records.push(f.evidence('OPERATIONAL_SOURCE',{...f.source,value:{...f.source.value,mask:{...f.source.value.mask,bytesLength:'9'}}}));await expect(f.reader().readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
    const next=fixture(),{captureDigest:_digest,...body}=next.capture,changed={...body,profileId:'different-profile'},capture={...changed,captureDigest:digest(changed)};await expect(next.reader().readOriginal(next.input,capture)).rejects.toMatchObject(hold);
  });
  it('owns INPUT, local capture, exact claim, bounds and DB method before a query wait',async()=>{
    const f=fixture(),original=structuredClone(f.input),capture=structuredClone(f.capture),claim=structuredClone(f.claim),expected=f.expected(),gate=deferred<Awaited<ReturnType<typeof f.query>>>();f.query.mockReturnValueOnce(gate.promise);
    const reader=new LocalLaMaBindingReader(f.db,f.bounds),pending=reader.readForDispatch(f.input,f.capture,f.claim);f.input.width=900;f.input.settings.baseFontSizePx=99;f.input.claimGeneration='7';Object.assign(f.capture.identity,{weightsSha256:sha256('changed-identity')});f.claim.ownerId=randomUUID();f.claim.workItemId=randomUUID();f.claim.generation='7';f.bounds.maxRecordBytes=1;f.bounds.calculator.maxInputBytes=1;Object.assign(f.db,{accountTransaction:vi.fn(()=>{throw Error('REPLACED_DB_METHOD');})});
    gate.resolve({rows:[f.core]});expect(await pending).toEqual(expected);expect(f.query.mock.calls[0][1]).toEqual([original.accountId,original.executionId,65536]);const dispatchArgs=f.query.mock.calls.find(([sql])=>sql.includes('FROM work_items w'))![1]!;expect(dispatchArgs[4]).toBe(claim.workItemId);expect(dispatchArgs[7]).toBe('1');expect(capture.identity.weightsSha256).not.toBe(f.capture.identity.weightsSha256);
  });
  it('rejects constructor/input/capture/claim Proxy or getter before executing a trap or DB callback',async()=>{
    const f=fixture(),badBounds=proxy(f.bounds),badCalculator=getter(calculator(),'maxInputBytes');expect(()=>new LocalLaMaBindingReader(f.db,badBounds.value)).toThrow();expect(()=>new LocalLaMaBindingReader(f.db,{...limits(),calculator:badCalculator.value})).toThrow();expect(badBounds.calls()).toBe(0);expect(badCalculator.calls()).toBe(0);
    for(const kind of ['input-proxy','input-getter','nested-proxy','array-proxy','capture-proxy','capture-getter','claim-proxy','claim-getter']){const next=fixture();let calls=()=>0;let input=next.input,capture=next.capture,claim=next.claim;
      if(kind==='input-proxy'){const bad=proxy(input);input=bad.value;calls=bad.calls;}if(kind==='input-getter'){const bad=getter(input,'width');input=bad.value;calls=bad.calls;}if(kind==='nested-proxy'){const bad=proxy(input.settings);input.settings=bad.value;calls=bad.calls;}if(kind==='array-proxy'){const bad=proxy(input.assetDependencies!);input.assetDependencies=bad.value;calls=bad.calls;}if(kind==='capture-proxy'){const bad=proxy(capture);capture=bad.value;calls=bad.calls;}if(kind==='capture-getter'){const bad=getter({...capture},'identity');capture=bad.value;calls=bad.calls;}if(kind==='claim-proxy'){const bad=proxy(claim);claim=bad.value;calls=bad.calls;}if(kind==='claim-getter'){const bad=getter(claim,'ownerId');claim=bad.value;calls=bad.calls;}
      await expect(next.reader().readForDispatch(input,capture,claim)).rejects.toMatchObject(hold);expect(calls()).toBe(0);expect(next.accountTransaction).not.toHaveBeenCalled();
    }
  });
  it('reserves concurrent/overlapping encoded capacity before inspecting another caller input',async()=>{
    for(const constrained of ['reads','bytes']){const f=fixture(),gate=deferred<Awaited<ReturnType<typeof f.query>>>();f.query.mockReturnValueOnce(gate.promise);const bounds=limits();if(constrained==='reads')bounds.maxConcurrentReads=1;else bounds.maxInFlightBytes=8*(bounds.maxRecordBytes*(bounds.maxRecords+4)+bounds.calculator.maxInputBytes+bounds.calculator.maxOutputBytes);
      const reader=new LocalLaMaBindingReader(f.db,bounds),pending=reader.readOriginal(f.input,f.capture),bad=proxy(f.input);await expect(reader.readOriginal(bad.value,f.capture)).rejects.toMatchObject(capacityHold);expect(bad.calls()).toBe(0);gate.resolve({rows:[f.core]});expect(await pending).toEqual(f.expected());expect(await reader.readOriginal(f.input,f.capture)).toEqual(f.expected());
    }
  });
  it('releases reservations after owned validation and joined DB failures without retrying unknown I/O',async()=>{
    const f=fixture(),reader=new LocalLaMaBindingReader(f.db,{...limits(),maxConcurrentReads:1}),bad={...f.input,width:-1};await expect(reader.readOriginal(bad,f.capture)).rejects.toMatchObject(hold);expect(f.query).not.toHaveBeenCalled();
    const error=Error('OWNED_DB_UNKNOWN');f.query.mockRejectedValueOnce(error);await expect(reader.readOriginal(f.input,f.capture)).rejects.toBe(error);expect(f.query).toHaveBeenCalledTimes(1);expect(await reader.readOriginal(f.input,f.capture)).toEqual(f.expected());
  });
  it('holds total row overflow, visible NULL rows and oversized metadata without an early return',async()=>{
    const f=fixture();await expect(new LocalLaMaBindingReader(f.db,{...limits(),maxRecords:3}).readOriginal(f.input,f.capture)).rejects.toMatchObject(hold);
    for(const value of [null,{...f.source,value:{payload:'x'.repeat(65536)}}]){const next=fixture();next.records[3].protected_observation=value;next.records[3].evidence_digest=digest(value);await expect(next.reader().readOriginal(next.input,next.capture)).rejects.toMatchObject(hold);}
    const input=fixture(),oversized={...input.input,extra:'x'.repeat(65536)};await expect(input.reader().readOriginal(oversized,input.capture)).rejects.toMatchObject(hold);
  });
  it('requires explicit finite positive closed bounds and sufficient encoded headroom',()=>{
    const f=fixture();for(const bounds of [{...limits(),maxRecordBytes:0},{...limits(),maxRecords:Infinity},{...limits(),maxConcurrentReads:1.5},{...limits(),maxInFlightBytes:1},{...limits(),maxRecords:2147483647},{...limits(),extra:true},{...limits(),calculator:{...calculator(),maxInputBytes:0}}])expect(()=>new LocalLaMaBindingReader(f.db,bounds)).toThrow();expect(()=>new LocalLaMaBindingReader({...f.db,role:'trio_web_api'} as Database,limits())).toThrow();
  });
  it('bounds driver materialization in SQL and only reads business records under account/execution locks',async()=>{
    const f=fixture(),before=structuredClone(f.records);await f.reader().readForDispatch(f.input,f.capture,f.claim);const calls=f.query.mock.calls,core=calls[0],evidence=calls.find(([sql])=>sql.includes('FROM execution_evidence'))!,fence=calls.find(([sql])=>sql.includes('FROM work_items w'))!;
    expect(core[0]).toContain('FOR UPDATE OF e');expect(core[0]).toMatch(/CASE WHEN octet_length\(sr\.captured_settings::text\)/);expect(evidence[0]).toMatch(/CASE WHEN octet_length\(protected_observation::text\)/);expect(evidence[0]).toMatch(/LIMIT \$5/);expect(evidence[1]).toEqual([f.input.accountId,f.input.executionId,['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_CANDIDATE','OPERATIONAL_SOURCE'],65536,33]);expect(fence[0]).toMatch(/CASE WHEN octet_length\(w\.claim_owner\)<=36/);expect(fence[0]).toContain('NOT EXISTS(SELECT 1 FROM native_job_intents');expect(calls.every(([sql])=>sql.trim().startsWith('SELECT'))).toBe(true);expect(f.records).toEqual(before);
  });
});
