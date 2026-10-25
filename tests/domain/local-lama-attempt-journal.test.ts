import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {FullStageCostCalculator,type FullStageCostBounds,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {FullStageCostBasis} from '../../packages/domain/src/full-stage-cost-journal.js';
import {LocalLaMaBindingReader,type LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-reader.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView} from '../../packages/domain/src/local-lama-attempt-journal.js';
import type {LocalLaMaOriginalInvocation} from '../../packages/providers/src/local-lama-executor.js';
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
  let queue=Promise.resolve();const journalRows=()=>records.filter(row=>row.kind.startsWith('LAMA_ATTEMPT_'));
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('INSERT INTO execution_evidence')){const args=values!;records.push({evidence_id:args[1] as string,evidence_digest:args[4] as string,protected_evidence_ref:args[1] as string,kind:args[3] as string,protected_observation:JSON.parse(args[6] as string)});return {rows:[{evidence_id:args[1]}],rowCount:1};}
    return {rows:sql.includes('AS clear')?[{clear:true}]:sql.includes('FROM execution_evidence')?structuredClone(records.filter(row=>sql.includes('($3::text[] IS NOT NULL)')||['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_CANDIDATE','OPERATIONAL_SOURCE'].includes(row.kind)).slice(0,(values![4] as number))):sql.includes('FROM work_items w')?[fence]:[core],rowCount:1};
  });
  const tx={account,now,client:{query}} as unknown as Transaction;
  const accountTransaction=vi.fn((_accountId:string,run:(tx:Transaction)=>Promise<unknown>,_restricted?:boolean)=>{const next=queue.then(()=>run(tx));queue=next.then(()=>undefined,()=>undefined);return next;});
  const db={role:'trio_web_worker',accountTransaction} as unknown as Database;
  const expected=()=>({version:1,accountId,requestId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),fullStageCaptureDigest:basis.captureDigest,localCaptureDigest:capture.captureDigest,mode:'FREE'});
  return {input,capture,claim,basis,snapshot,candidate,source,records,journalRows,evidence,core,fence,account,tx,query,accountTransaction,db,expected,full:structuredClone(basis.capture),bounds:limits(),attempts:()=>new LocalLaMaAttemptJournal(db,limits()),reader:()=>new LocalLaMaBindingReader(db,limits())};
}
type Fixture=ReturnType<typeof fixture>;
const uncertain={nextAction:'WAIT'},badChain={code:'LOCAL_LAMA_ATTEMPT_UNCONFIRMED',nextAction:'WAIT'},dispatchHold={code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED',nextAction:'WAIT'},legacyHold={code:'LOCAL_LAMA_ATTEMPT_LEGACY_UNCONFIRMED',nextAction:'WAIT'};
function record<T extends object>(body:T):T&{recordDigest:string}{return {...body,recordDigest:digest(body)};}
function facts(f:Fixture,original:LocalLaMaOriginalInvocation){
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,profileDigest:f.capture.profileDigest,identityDigest:digest(f.capture.identity)};
  const start={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime};
  const cost={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:f.capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.125',evidenceRef:'owned-cost-claim',basisVersion:'owned-full-stage-claim'};
  const reply={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256('owned-proposal-metadata'),byteLength:10}};
  return {runtime,start,cost,reply};
}
const claim=(f:Fixture,journal=f.attempts())=>journal.claim(f.input,f.capture,f.full,f.claim);
const lookup=(f:Fixture,journal=f.attempts())=>journal.lookup(f.input,f.capture,f.full);
const append=(f:Fixture,view:LocalLaMaAttemptMetadataView,metadata:LocalLaMaAttemptMetadata,journal=f.attempts())=>journal.append(f.input,f.capture,f.full,view.original,metadata);
const refresh=(row:Evidence)=>{row.evidence_digest=digest(row.protected_observation);};
const envelope=(row:Evidence)=>(row.protected_observation as {value:Record<string,unknown>}).value;
function proxy<T extends object>(value:T){let calls=0;const trap=()=>{calls++;throw Error('OWNED_JOURNAL_PROXY');};return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}

describe('private metadata-only local LaMa attempt journal',()=>{
  it('creates one server identity and returns a metadata view without submit or closure authority',async()=>{
    const f=fixture(),before=structuredClone(f.records),first=await claim(f);expect(first).toMatchObject({created:true,kind:'METADATA_ONLY',rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:'UNCONFIRMED',records:[]});expect(first.original.invocationId).toMatch(/^[a-f0-9-]{36}$/);expect(first.binding).toEqual(f.expected());
    expect(await claim(f)).toEqual({...first,created:false});expect(await lookup(f)).toEqual((({created:_created,...view})=>view)(first));expect(f.journalRows()).toHaveLength(1);expect(f.records.slice(0,4)).toEqual(before);expect(f.accountTransaction).toHaveBeenCalledWith(f.input.accountId,expect.any(Function),true);
  });
  it('serializes two first claims and retains the first creation ACK only',async()=>{
    const f=fixture(),[a,b]=await Promise.all([claim(f),claim(f)]);expect([a.created,b.created].sort()).toEqual([false,true]);expect(a.original).toEqual(b.original);expect(f.journalRows()).toHaveLength(1);
  });
  it('propagates a lost write response and recovers the same original through a new instance',async()=>{
    const f=fixture(),original=f.accountTransaction.bind(f.db);const lost=Error('OWNED_ORIGINAL_ACK_LOST');let once=true;
    Object.assign(f.db,{accountTransaction:async(accountId:string,run:(tx:Transaction)=>Promise<unknown>,restricted:boolean)=>{const result=await original(accountId,run,restricted);if(once){once=false;throw lost;}return result;}});
    await expect(claim(f)).rejects.toBe(lost);expect(f.journalRows()).toHaveLength(1);const recovered=await lookup(f);expect(recovered).not.toBeNull();expect(await claim(f)).toEqual({...recovered!,created:false});expect(f.journalRows()).toHaveLength(1);
  });
  it('rechecks owner, work, generation and lease in a new transaction after reader success',async()=>{
    for(const change of [{claim_owner:randomUUID()},{work_item_id:randomUUID()},{claim_generation:'2'},{lease_live:false}]){const f=fixture();expect(await f.reader().readForDispatch(f.input,f.capture,f.claim)).not.toBeNull();Object.assign(f.fence,change);await expect(claim(f)).rejects.toMatchObject(dispatchHold);expect(f.journalRows()).toHaveLength(0);}
  });
  it('keeps closed, restricted, terminal, expired and superseded claims on the same original',async()=>{
    const f=fixture(),first=await claim(f),before=structuredClone(f.journalRows());f.account.access_state='RESTRICTED';Object.assign(f.core,{lifecycle:'CLOSED',request_state:'STOPPED',request_terminal:true,execution_state:'SUCCEEDED'});f.fence.lease_live=false;f.claim.ownerId=randomUUID();f.input.claimGeneration='99';
    expect(await claim(f)).toEqual({...first,created:false});expect(await lookup(f)).toEqual((({created:_created,...view})=>view)(first));expect(f.journalRows()).toEqual(before);
  });
  it('rejects legacy subsequent LAMA, plan, output, START and unfamiliar original trails',async()=>{
    for(const kind of ['LAMA_START','LAMA_OUTCOME','LAMA_RECONCILIATION','OPERATIONAL_PLAN','OPERATIONAL_OUTPUT','START','OTHER_ORIGINAL']){
      const f=fixture();f.records.push(kind.startsWith('LAMA_')?f.evidence('OPERATIONAL_SOURCE',{version:1,candidate:f.candidate,phase:kind,value:kind==='LAMA_START'?{evidenceId:randomUUID(),captureDigest:f.capture.captureDigest}:{state:'UNKNOWN'}}):f.evidence(kind,{owned:'subsequent-fact'}));const before=structuredClone(f.records);
      await expect(claim(f)).rejects.toMatchObject(legacyHold);await expect(lookup(f)).rejects.toMatchObject(legacyHold);expect(f.records).toEqual(before);
    }
  });
  it('refuses original creation with existing native or start scalar trails',async()=>{
    const f=fixture();f.query.mockImplementationOnce(async()=>({rows:[f.core],rowCount:1}));f.query.mockImplementationOnce(async()=>({rows:f.records,rowCount:4}));f.query.mockImplementationOnce(async()=>({rows:[{clear:false}],rowCount:1}));await expect(claim(f)).rejects.toMatchObject(legacyHold);expect(f.journalRows()).toHaveLength(0);
  });
  it('preserves ordered START, reply metadata, full-cost claims and HOLD across instances',async()=>{
    const f=fixture(),first=await claim(f),value=facts(f,first.original),start=record({version:1 as const,kind:'START' as const,fact:value.start});let view=await append(f,first,start);
    view=await append(f,view,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply}));view=await append(f,view,record({version:1 as const,kind:'FULL_COST' as const,evidence:{version:1 as const,bindingDigest:first.original.bindingDigest,fullStageCaptureDigest:f.full.captureDigest,closureEvidenceRef:'owned-closure-claim',fullCost:value.cost}}));
    view=await append(f,view,record({version:1 as const,kind:'HOLD' as const,code:'OWNED_LIFETIME_HOLD',relatedDigest:null}));expect(view).toMatchObject({kind:'METADATA_ONLY',rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:'HOLD',holds:['OWNED_LIFETIME_HOLD']});expect(view.records.map(item=>item.ordinal)).toEqual([1,2,3,4]);expect(view.records[0].previousEnvelopeDigest).toBe(first.originalEnvelopeDigest);expect(await lookup(f)).toEqual(view);
    const reply=view.records[1].record;expect(reply.kind==='ENGINE_REPLY'&&reply.reply.proposal).toEqual(value.reply.proposal);expect(JSON.stringify(view)).not.toContain('"bytes"');expect(await append(f,view,start)).toEqual(view);expect(f.journalRows()).toHaveLength(5);
  });
  it('retains differing same-engine evidence facts and surfaces conflict instead of deduping',async()=>{
    const f=fixture(),first=await claim(f),value=facts(f,first.original),success=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:value.reply});let view=await append(f,first,success);
    const unknown=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...value.reply,state:'UNKNOWN' as const,providerSuccess:null,start:null,proposal:null}});view=await append(f,view,unknown);expect(view.records).toHaveLength(2);expect(view).toMatchObject({status:'HOLD',holds:expect.arrayContaining(['LOCAL_LAMA_ATTEMPT_ENGINE_EVIDENCE_CONFLICT'])});expect(await lookup(f)).toEqual(view);
  });
  it('preserves invalid-success and engine-cost claims as HOLD without filling null or zero defaults',async()=>{
    const f=fixture(),first=await claim(f),value=facts(f,first.original);const view=await append(f,first,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...value.reply,proposal:null,fullCost:value.cost}}));expect(view.status).toBe('HOLD');expect(view.records[0].record).toMatchObject({reply:{state:'SUCCEEDED',proposal:null,fullCost:{actualUsd:'0.125'}}});expect(view.holds).toContain('LOCAL_LAMA_ATTEMPT_REPLY_CONFLICT');expect(view.holds).toContain('LOCAL_LAMA_ATTEMPT_ENGINE_COST_UNCONFIRMED');
  });
  it.each(['gap','fork','duplicate-ordinal','duplicate-record','other-original','ref','digest','wrapper','original-wrapper','original-duplicate'])('rejects the entire %s history before any idempotent or creation return',async scenario=>{
    const f=fixture(),first=await claim(f),value=facts(f,first.original),view=await append(f,first,record({version:1 as const,kind:'START' as const,fact:value.start}));await append(f,view,record({version:1 as const,kind:'HOLD' as const,code:'OWNED_HOLD',relatedDigest:null}));const rows=f.journalRows(),row=rows[2],body=envelope(row);
    if(scenario==='gap')body.ordinal=3;if(scenario==='fork')body.previousEnvelopeDigest=sha256('wrong-predecessor');if(scenario==='duplicate-ordinal')body.ordinal=1;if(scenario==='duplicate-record')body.record=envelope(rows[1]).record;if(scenario==='other-original')body.original={...first.original,invocationId:randomUUID()};if(scenario==='wrapper')(row.protected_observation as Record<string,unknown>).accountId=randomUUID();if(scenario==='original-wrapper')envelope(rows[0]).binding={...first.binding,mode:'PAID'};
    refresh(row);if(scenario==='original-wrapper')refresh(rows[0]);if(scenario==='ref')row.protected_evidence_ref=randomUUID();if(scenario==='digest')row.evidence_digest=sha256('wrong-envelope');if(scenario==='original-duplicate'){const second=structuredClone(rows[0]);second.evidence_id=randomUUID();second.protected_evidence_ref=second.evidence_id;envelope(second).original={...first.original,invocationId:randomUUID()};refresh(second);f.records.push(second);}
    const before=structuredClone(f.records);await expect(lookup(f)).rejects.toMatchObject(uncertain);await expect(claim(f)).rejects.toMatchObject(uncertain);expect(f.records).toEqual(before);
  });
  it('rejects corrupted recordDigest and crossed runtime/full-cost/original facts',async()=>{
    const f=fixture(),first=await claim(f),value=facts(f,first.original);
    for(const metadata of [record({version:1 as const,kind:'START' as const,fact:{...value.start,runtime:{...value.runtime,invocationId:randomUUID()}}}),{...record({version:1 as const,kind:'START' as const,fact:value.start}),recordDigest:sha256('wrong-record')},record({version:1 as const,kind:'FULL_COST' as const,evidence:{version:1 as const,bindingDigest:sha256('crossed-binding'),fullStageCaptureDigest:f.full.captureDigest,closureEvidenceRef:'owned-claim',fullCost:value.cost}})])await expect(append(f,first,metadata)).rejects.toMatchObject(badChain);
    await expect(f.attempts().append(f.input,f.capture,f.full,{...first.original,invocationId:randomUUID()},record({version:1 as const,kind:'HOLD' as const,code:'OWNED_HOLD',relatedDigest:null}))).rejects.toMatchObject(badChain);expect(f.journalRows()).toHaveLength(1);
  });
  it('checks all caller INPUT and both captures before writing',async()=>{
    const f=fixture();for(const input of [{...f.input,accountId:randomUUID()},{...f.input,width:17}])await expect(f.attempts().claim(input,f.capture,f.full,f.claim)).rejects.toMatchObject(uncertain);
    const {captureDigest:_local,...localBody}=f.capture,local={...localBody,maskSha256:sha256('crossed-mask')};await expect(f.attempts().claim(f.input,{...local,captureDigest:digest(local)},f.full,f.claim)).rejects.toMatchObject(uncertain);
    const {captureDigest:_full,...fullBody}=f.full,full={...fullBody,profileDigest:sha256('crossed-full-stage')};await expect(f.attempts().claim(f.input,f.capture,new FullStageCostCalculator(null,calculator()).capture(full),f.claim)).rejects.toMatchObject(uncertain);expect(f.journalRows()).toHaveLength(0);
  });
  it('owns input, both captures, claim and metadata before an awaited transaction',async()=>{
    const f=fixture(),journal=f.attempts(),expected=f.expected(),gate=deferred<Awaited<ReturnType<typeof f.query>>>();f.query.mockReturnValueOnce(gate.promise);const pending=claim(f,journal);
    f.input.width=999;f.input.settings.baseFontSizePx=99;f.input.claimGeneration='8';Object.assign(f.capture.identity,{weightsSha256:sha256('mutated')});f.claim.ownerId=randomUUID();Object.assign(f.full,{profileDigest:sha256('mutated-full')});Object.assign(f.db,{accountTransaction:()=>{throw Error('REPLACED_METHOD');}});gate.resolve({rows:[f.core],rowCount:1});const first=await pending;expect(first.binding).toEqual(expected);
    const next=fixture(),view=await claim(next),metadata=record({version:1 as const,kind:'HOLD' as const,code:'ORIGINAL_HOLD',relatedDigest:null}),wait=deferred<Awaited<ReturnType<typeof next.query>>>(),store=next.attempts();next.query.mockReturnValueOnce(wait.promise);const appendPending=append(next,view,metadata,store);metadata.code='MUTATED_HOLD';wait.resolve({rows:[next.core],rowCount:1});expect((await appendPending).holds).toEqual(['ORIGINAL_HOLD']);
  });
  it('rejects caller Proxy/getters/raw bytes before a DB callback or trap',async()=>{
    const f=fixture(),bad=proxy(f.capture);await expect(f.attempts().claim(f.input,bad.value,f.full,f.claim)).rejects.toMatchObject(uncertain);expect(bad.calls()).toBe(0);expect(f.accountTransaction).not.toHaveBeenCalled();
    let getters=0;const full={...f.full};Object.defineProperty(full,'profileDigest',{enumerable:true,get(){getters++;return sha256('getter');}});await expect(f.attempts().claim(f.input,f.capture,full,f.claim)).rejects.toMatchObject(uncertain);expect(getters).toBe(0);expect(f.accountTransaction).not.toHaveBeenCalled();
    const first=await claim(f),value=facts(f,first.original),before=f.accountTransaction.mock.calls.length;await expect(append(f,first,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...value.reply,proposal:{...value.reply.proposal,bytes:Buffer.from('raw')}}}))).rejects.toMatchObject(uncertain);expect(f.accountTransaction).toHaveBeenCalledTimes(before);
  });
  it('holds missing original, NULL/oversized rows and total LIMIT+1 overflow',async()=>{
    const f=fixture(),first=await claim(f),metadata=record({version:1 as const,kind:'HOLD' as const,code:'OWNED_HOLD',relatedDigest:null});await append(f,first,metadata);f.records.splice(f.records.findIndex(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL'),1);await expect(lookup(f)).rejects.toMatchObject(badChain);
    for(const observation of [null,{payload:'x'.repeat(65536)}]){const next=fixture(),claimed=await claim(next);const row=next.journalRows()[0];row.protected_observation=observation;refresh(row);await expect(lookup(next)).rejects.toMatchObject(uncertain);expect(claimed.created).toBe(true);}
    const overflow=fixture();await claim(overflow);await expect(lookup(overflow,new LocalLaMaAttemptJournal(overflow.db,{...limits(),maxRecords:4}))).rejects.toMatchObject(uncertain);
  });
  it.each(['calls','bytes'] as const)('reserves %s capacity before inspecting another caller and releases failures',async constrained=>{
    const f=fixture(),bounds=limits(),gate=deferred<Awaited<ReturnType<typeof f.query>>>();if(constrained==='calls')bounds.maxConcurrentReads=1;else bounds.maxInFlightBytes=8*(2*bounds.maxRecordBytes*(bounds.maxRecords+4)+bounds.calculator.maxInputBytes+bounds.calculator.maxOutputBytes);
    const journal=new LocalLaMaAttemptJournal(f.db,bounds);f.query.mockReturnValueOnce(gate.promise);const pending=claim(f,journal),bad=proxy(f.input);await expect(journal.lookup(bad.value,f.capture,f.full)).rejects.toMatchObject({code:'LOCAL_LAMA_ATTEMPT_CAPACITY'});expect(bad.calls()).toBe(0);gate.resolve({rows:[f.core],rowCount:1});const first=await pending;expect(await lookup(f,journal)).not.toBeNull();
    const error=Error('OWNED_DB_UNKNOWN');f.query.mockRejectedValueOnce(error);await expect(lookup(f,journal)).rejects.toBe(error);expect((await lookup(f,journal))!.original).toEqual(first.original);expect(()=>new LocalLaMaAttemptJournal(f.db,{...limits(),maxInFlightBytes:20*1024*1024})).toThrow();expect(()=>new LocalLaMaAttemptJournal({...f.db,role:'trio_web_api'} as Database,limits())).toThrow();
  });
  it('bounds driver rows and writes only immutable execution evidence under the same transaction',async()=>{
    const f=fixture();await claim(f);const calls=f.query.mock.calls;expect(calls[0][0]).toContain('FOR UPDATE OF e,r,c');const read=calls.find(([sql])=>sql.includes('FROM execution_evidence'))!;expect(read[0]).toContain('CASE WHEN octet_length(kind)<=64');expect(read[0]).toContain('CASE WHEN octet_length(protected_observation::text)');expect(read[1]![4]).toBe(33);expect(calls.find(([sql])=>sql.includes('FROM work_items w'))![0]).toContain('FOR UPDATE OF w,s');expect(calls.every(([sql])=>sql.startsWith('SELECT')||sql.startsWith('INSERT INTO execution_evidence'))).toBe(true);
  });
});
