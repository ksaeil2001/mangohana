import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,writeFile,lstat,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {FileObjectStore,type ObjectStore,type ObjectReceipt} from '../../packages/storage/src/objects.js';
import {Assets} from '../../packages/domain/src/assets.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import type {LocalLaMaOriginalInvocation} from '../../packages/providers/src/local-lama-executor.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView} from '../../packages/domain/src/local-lama-attempt-journal.js';
import {LocalLaMaRawStore,lamaRawAllocationKind,lamaRawReceiptKind,type LocalLaMaRawStoreBounds,type LocalLaMaRawReplyRef,type LocalLaMaRawPublication,type LocalLaMaRawPut} from '../../packages/domain/src/local-lama-raw-store.js';
import type {NativeJobClaim,NativeJobIntent,NativeJobObservation} from '../../packages/domain/src/native-jobs.js';
import type {NativeReceiptCandidate} from '../../packages/domain/src/native-receipts.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeLimits} from '../../packages/native/src/dto.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeDatabaseGateway,nativeContextForInput} from '../../packages/domain/src/native-gateway.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {LocalLaMaNativePreparation,lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind} from '../../packages/domain/src/local-lama-native-preparation.js';
import type {PipelineStageCandidate} from '../../packages/domain/src/pipeline-evidence.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';

// Future bodies use the actual journal/verifier and FileObjectStore in owned
// OS Temp. SQL/claims/rates/engine observations are a fake transaction model,
// not restricted SQL, engine success, pixels/QA or current dispatch authority.
// The prepared case additionally plans actual SYNTHETIC native children and
// private full checker/receipt/JOIN calls; its SQL/native object ports are fake.
type Evidence={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;kind:string;protected_observation:unknown};
type Asset={account_id:string;asset_id:string;purpose:string;bucket_ref:string;object_key:string;sha256:string;bytes_length:string;media_type:string;related_context_id:string|null;deletion_state:string;access_deadline:Date|null;object_created_at:Date|null};
const roots:string[]=[];
const controllers:{controller:NativeController;root:string}[]=[];
afterEach(async()=>{const failures:unknown[]=[],unconfirmedRoots=new Set<string>();for(const {controller,root}of controllers.splice(0)){controller.stopClaims();try{await controller.idle();}catch(error){failures.push(error);unconfirmedRoots.add(root);}}vi.restoreAllMocks();for(const root of roots.splice(0)){if(unconfirmedRoots.has(root))continue;expect(path.dirname(root)).toBe(await realpath(tmpdir()));const stat=await lstat(root);expect(stat.isDirectory()&&!stat.isSymbolicLink()).toBe(true);expect(await realpath(root)).toBe(root);await rm(root,{recursive:true});}if(failures.length)throw new AggregateError(failures,'RAW_TEST_CHILD_TERMINATION_UNCONFIRMED');});
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const journalBounds=()=>({maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:4,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}});
const limits=():LocalLaMaRawStoreBounds=>({journal:journalBounds(),maxRawBytes:1024,maxInFlightMetadataBytes:512*1024*1024,maxInFlightRawBytes:64*1024,maxPublications:4,maxAllocations:4,maxPendingPuts:4,maxIo:4,maxMetadataCalls:4});
const nativeLimits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:8,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:1048576};
async function fixture(withPreparation=false){
  const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'trio-lama-raw-domain-'));roots.push(root);
  const accountId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),executionId=randomUUID(),originalAssetId=randomUUID(),profileId=withPreparation?syntheticProfile.id:'raw-owned-profile',profileDigest=sha256('raw-owned-profile');
  const settings={settingsVersion:'1',contractVersion:'raw-owned-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const nativeSource=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const image={assetId:originalAssetId,sha256:withPreparation?sha256(nativeSource):sha256('image-metadata'),bytesLength:withPreparation?String(nativeSource.length):'16',mediaType:'image/png'};
  const input:StageInput={accountId,contextId,requestId,executionId,stage:'CLEANUP',inputDigest:sha256('raw-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',assetDependencies:[image],currentCleanedAssetId:null,currentRenderAssetId:null,previousOutputAssetIds:[],
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest:sha256('raw-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:profileId}};
  if(withPreparation){input.width=1;input.height=1;}
  const captureBody:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest:input.inputDigest,profileId,profileDigest,identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('fixture-weights'),configSha256:sha256('fixture-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:image.sha256,imageByteLength:Number(image.bytesLength),maskSha256:sha256('mask-metadata'),maskByteLength:8};
  const capture:LocalLaMaCapture={...captureBody,captureDigest:digest(captureBody)},claim:NativeJobClaim={generation:'1',ownerId:randomUUID(),workItemId:randomUUID()};
  const snapshot:FullStageCostSnapshot={version:1,state:'UNMEASURED',stage:'CLEANUP',profileDigest:sha256('distinct-whole-profile'),basisVersion:'raw-unmeasured-fixture',usdScale:12,rounding:'HALF_UP',evidenceRefs:[],components:[]};
  const calculation=new FullStageCostCalculator(snapshot,journalBounds().calculator).calculate({accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'CLEANUP',profileDigest:snapshot.profileDigest,mode:'FREE'},{provider:null,quantities:null,allocation:null});
  const basis={version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:calculation.snapshot,snapshotDigest:calculation.snapshotDigest};
  const candidate:PipelineStageCandidate={version:1,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'CLEANUP',claimGeneration:'1',evidenceId:randomUUID(),maskAssetId:randomUUID(),cleanedAssetId:randomUUID(),renderAssetId:null};
  const mask={assetId:candidate.maskAssetId!,sha256:capture.maskSha256,bytesLength:String(capture.maskByteLength),mediaType:'image/png'},source={version:1,candidate,phase:'LAMA_INPUT',value:{capture,image,mask}};
  const evidence=(kind:string,value:unknown):Evidence=>{const protected_observation=structuredClone(kind==='INPUT'?value:{version:1,accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind,value}),evidence_id=randomUUID();return {evidence_id,evidence_digest:digest(protected_observation),protected_evidence_ref:evidence_id,kind,protected_observation};};
  const records:Evidence[]=[evidence('INPUT',canonicalInput(input)),evidence('OPERATIONAL_COST_BASIS',basis),...(withPreparation?[]:[evidence('OPERATIONAL_CANDIDATE',candidate),evidence('OPERATIONAL_SOURCE',source)])];
  const core={request_id:requestId,logical_step_id:'CLEANUP',input_digest:input.inputDigest,contract_version:settings.contractVersion,execution_state:'DISPATCHING',claim_generation:'1',dispatch_attempted:true,context_id:contextId,request_generation:'1',page_lineage_id:input.envelope!.pageLineageId,mode:'FREE',request_state:'ACCEPTED',request_terminal:false,request_started:false,context_generation:'1',lifecycle:'OPEN',scope_digest:digest(input.scope),captured_settings:structuredClone(settings),native_hold:false};
  const fence={work_item_id:claim.workItemId,kind:'DISPATCH',state:'CLAIMED',claim_owner:claim.ownerId,claim_generation:'1',lease_live:true,request_matches:true,pointer_matches:true,session_active:true,connected:true,page_current:true,cost_clear:true,wait_clear:true,native_clear:true};
  const account={account_id:accountId,access_state:'ACTIVE',auth_generation:'1'},now=new Date(Date.now()+60_000);
  if(withPreparation){core.execution_state='PREPARED';core.dispatch_attempted=false;}
  const nativeOwner={contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'1',workspaceRevision:'1'},nativeEvents:string[]=[],intents:NativeJobIntent[]=[],observations:{id:string;value:NativeJobObservation;mockSqlDigest:string}[]=[],nativeCandidates:NativeReceiptCandidate[]=[],nativeProofs=new Map<string,unknown>();
  const assets=new Map<string,Asset>([image,mask].map(descriptor=>[descriptor.assetId,{account_id:accountId,asset_id:descriptor.assetId,purpose:'LIVE',bucket_ref:'local-private-v1',object_key:accountId+'/'+descriptor.assetId,sha256:descriptor.sha256,bytes_length:descriptor.bytesLength,media_type:descriptor.mediaType,related_context_id:contextId,deletion_state:'NOT_DUE',access_deadline:null,object_created_at:null}]));
  const control={lossKind:null as string|null,loss:Error('RAW_COMMIT_ACK_LOST'),gateAt:0,entered:deferred<void>(),gate:deferred<void>()};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(withPreparation&&sql.includes('AS input_matches')){const original=records.find(row=>row.kind==='INPUT')!,stored=canonicalInput(input);return {rows:[{request_id:requestId,logical_step_id:input.stage,input_digest:input.inputDigest,evidence_id:original.evidence_id,evidence_digest:original.evidence_digest,protected_evidence_ref:original.evidence_id,input_matches:JSON.stringify(stored)===values![3]&&digest(stored)===values![7],owner:nativeOwner,claim_current:true}],rowCount:1};}
    if(withPreparation&&sql.includes("kind='INPUT'"))return {rows:[{protected_observation:structuredClone(canonicalInput(input))}],rowCount:1};
    if(withPreparation&&/\bAS capture\b/.test(sql))return {rows:[{capture:nativeOwner}],rowCount:1};
    if(withPreparation&&sql.includes('true AS current'))return {rows:[{current:true}],rowCount:1};
    if(withPreparation&&sql.includes('native_receipt_lookup')){const lookup=JSON.parse(values![0] as string),found=nativeCandidates.find(item=>item.operationInputDigest===lookup.operationInputDigest),proof=found?nativeProofs.get(found.candidateId):undefined,intent=found?intents.find(item=>item.jobId===found.jobId):undefined;return {rows:[{state:found?{state:proof?'VERIFIED':'PENDING_OR_UNCONFIRMED',candidate:found,receipt:proof,intent,termination:observations.find(item=>item.value.event==='TERMINATION'&&item.value.termination.jobId===found.jobId)?.value.termination}:{state:'MISS'}}],rowCount:1};}
    if(withPreparation&&sql.includes('native_receipt_create_intent')){intents.push(JSON.parse(values![0] as string));nativeEvents.push('INTENT');return {rows:[{decision:{allowed:true,reason:'RAW_PREPARED_FAKE_SQL_PORT'}}],rowCount:1};}
    if(withPreparation&&sql.includes('native_job_consume_go')){nativeEvents.push('GO');return {rows:[{decision:{allowed:true,reason:'RAW_PREPARED_FAKE_SQL_PORT'}}],rowCount:1};}
    if(withPreparation&&sql.includes('native_job_append_observation')){const value=JSON.parse(values![1] as string),mockSqlDigest=digest({fakeSqlObservation:value});observations.push({id:values![0] as string,value,mockSqlDigest});nativeEvents.push(value.event);return {rows:[{decision:{allowed:true,reason:'RAW_PREPARED_FAKE_SQL_PORT',observationDigest:mockSqlDigest}}],rowCount:1};}
    if(withPreparation&&sql.includes('native_receipt_prepare')){nativeCandidates.push(JSON.parse(values![0] as string));return {rows:[{decision:{allowed:true,reason:'PREPARED',candidate:nativeCandidates.at(-1)}}],rowCount:1};}
    if(withPreparation&&sql.includes('native_receipt_register_asset'))return {rows:[{decision:{allowed:true,reason:'REGISTERED'}}],rowCount:1};
    if(withPreparation&&sql.includes('native_receipt_verify')){const proof=JSON.parse(values![1] as string);nativeProofs.set(proof.candidateId,proof);return {rows:[{decision:{allowed:true,reason:'VERIFIED'}}],rowCount:1};}
    if(withPreparation&&sql.includes('FROM native_result_candidates c')){const found=JSON.parse(values![3] as string) as NativeReceiptCandidate,proof=JSON.parse(values![4] as string),result=observations.find(item=>item.id===found.resultObservationId)!,termination=observations.find(item=>item.value.event==='TERMINATION'&&item.value.termination.jobId===found.jobId)!;return {rows:[{candidate_digest:digest({mockSqlJsonb:found}),receipt_digest:digest({mockSqlJsonb:proof}),result_observation_id:result.id,result_observation_digest:result.mockSqlDigest,termination_observation_id:termination.id,termination_observation_digest:termination.mockSqlDigest}],rowCount:1};}
    if(sql.startsWith('INSERT INTO execution_evidence')){const args=values!;records.push({evidence_id:args[1] as string,evidence_digest:args[4] as string,protected_evidence_ref:args[1] as string,kind:args[3] as string,protected_observation:JSON.parse(args[6] as string)});return {rows:[{evidence_id:args[1]}],rowCount:1};}
    if(sql.startsWith('INSERT INTO assets')){const args=values!,assetId=args[1] as string;if(!assets.has(assetId))assets.set(assetId,{account_id:args[0] as string,asset_id:assetId,purpose:args[2] as string,bucket_ref:args[3] as string,object_key:args[4] as string,sha256:args[5] as string,bytes_length:args[6] as string,media_type:args[7] as string,related_context_id:args[9] as string,deletion_state:'NOT_DUE',object_created_at:args[10] as Date,access_deadline:args[11] as Date|null});return {rows:[],rowCount:1};}
    if(sql.startsWith('SELECT * FROM assets'))return {rows:structuredClone([assets.get(values![1] as string)!]),rowCount:1};
    if(sql.includes('FROM assets')){
      const ids=values![1] as string[],receiptTime=values![3] as string|null;
      if(withPreparation&&sql.includes(' AS value')){const wanted=[values![1],values![2]];return {rows:[...assets.values()].filter(asset=>wanted.includes(asset.asset_id)).sort((a,b)=>a.asset_id.localeCompare(b.asset_id)).map(asset=>({value:{assetId:asset.asset_id,objectKey:asset.object_key,sha256:asset.sha256,bytesLength:asset.bytes_length,mediaType:asset.media_type,purpose:asset.purpose,objectCreatedAt:asset.object_created_at?.toISOString()??null,verifiedAt:asset.object_created_at?.toISOString()??null,accessDeadline:asset.access_deadline?.toISOString()??null},eligible:asset.deletion_state==='NOT_DUE'&&(asset.access_deadline===null||now<asset.access_deadline)})),rowCount:2};}
      const rows=ids.filter(assetId=>assets.has(assetId)).map(assetId=>{
        const asset=assets.get(assetId)!;return {asset_id:assetId,purpose:asset.purpose,bucket_ref:asset.bucket_ref,object_key:asset.object_key,sha256:asset.sha256,bytes_length:asset.bytes_length,media_type:asset.media_type,related_context_id:asset.related_context_id,deletion_state:asset.deletion_state,unexpired:asset.access_deadline===null||now<asset.access_deadline,object_created_at:asset.object_created_at?.toISOString()??null,receipt_time_matches:receiptTime===null||asset.object_created_at?.toISOString()===receiptTime};
      });return {rows,rowCount:rows.length};
    }
    if(sql.includes('FROM execution_evidence')){
      const rows=records.filter(row=>sql.includes('($3::text[] IS NOT NULL)')||['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_CANDIDATE','OPERATIONAL_SOURCE'].includes(row.kind)).slice(0,values![4] as number);return {rows:structuredClone(rows),rowCount:rows.length};
    }
    return {rows:sql.includes('AS clear')?[{clear:true}]:sql.includes('FROM work_items w')?[structuredClone(fence)]:[structuredClone(core)],rowCount:1};
  });
  const tx={account,now,client:{query}} as unknown as Transaction;
  let queue=Promise.resolve(),txCount=0;
  const accountTransaction=vi.fn((target:string,run:(tx:Transaction)=>Promise<unknown>,restricted?:boolean)=>{
    const next=queue.then(async()=>{
      expect(target).toBe(accountId);if(withPreparation)expect(restricted===undefined||typeof restricted==='boolean').toBe(true);else expect(restricted).toBe(true);txCount++;
      if(txCount===control.gateAt){control.entered.resolve();await control.gate.promise;}
      const before=structuredClone(records),beforeAssets=structuredClone(assets);let result:unknown;
      try{result=await run(tx);}catch(error){records.splice(0,records.length,...before);assets.clear();for(const [key,value]of beforeAssets)assets.set(key,value);throw error;}
      if(control.lossKind&&records.slice(before.length).some(row=>row.kind===control.lossKind)){control.lossKind=null;throw control.loss;}return result;
    });queue=next.then(()=>undefined,()=>undefined);return next;
  });
  const db={role:'trio_web_worker',accountTransaction} as unknown as Database,bytes=Buffer.from('owned raw candidate');
  let preparation:LocalLaMaNativePreparation|undefined,gateway:NativeDatabaseGateway|undefined;
  const store=(overrides:Partial<LocalLaMaRawStoreBounds>={})=>new LocalLaMaRawStore(db,root,{...limits(),...overrides},preparation);
  if(withPreparation){
    const nativeBytes=new Map<string,Buffer>(),nativeReceipts=new Map<string,ObjectReceipt>(),objects:ObjectStore={bucket:'raw-prepared-memory',put:async(key,value)=>{const receipt:ObjectReceipt={key,sha256:sha256(value),bytesLength:String(value.length),completedAt:now.toISOString(),completedAtPrecisionMilliseconds:1};nativeBytes.set(key,Buffer.from(value));nativeReceipts.set(key,receipt);return receipt;},receipt:async key=>nativeReceipts.get(key)??null,read:async key=>{const value=nativeBytes.get(key);if(!value)throw Error('RAW_PREPARED_OBJECT_ABSENT');return Buffer.from(value);},remove:async()=>{throw Error('RAW_PREPARED_DELETE_FORBIDDEN');}};
    await mkdir(path.join(root,'native-child'));
    const controller=NativeController.owned({profile:syntheticProfile,limits:nativeLimits,directoryRoot:path.join(root,'native-child')});controllers.push({controller,root});
    preparation=new LocalLaMaNativePreparation(db,journalBounds(),syntheticProfile,controller.kernelImplementationDigest);gateway=new NativeDatabaseGateway(db,controller,objects,undefined,preparation);
    try{
      const prepared=await preparation.prepare(input,claim);expect(prepared.created).toBe(true);expect(prepared.capture).not.toBeNull();
      const target=(phase:'INPUT'|'DISPATCH'):NativeTarget=>({accountId,targetKind:'EXECUTION',targetId:executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,requestId,input),protectedOwnerCapture:prepared.capture!.value.originalOwner,claim,sourceInput:{executionId,inputEvidenceId:prepared.capture!.value.input.evidenceId,stageInputDigest:input.inputDigest}});
      const decoded=await (await nativeContextForInput(gateway,db,target('INPUT'),input,'INPUT',requestId)).decodeImage(nativeSource,syntheticProfile);expect(decoded.width).toBe(1);expect(decoded.height).toBe(1);
      core.execution_state='DISPATCHING';core.dispatch_attempted=true;
      const facade=await nativeContextForInput(gateway,db,target('DISPATCH'),input,'DISPATCH',requestId),nativeMask=await facade.binaryPolygonMask([],1,1,syntheticProfile);
      Object.assign(mask,{sha256:sha256(nativeMask.png),bytesLength:String(nativeMask.png.length)});const nextBody={...captureBody,maskSha256:mask.sha256,maskByteLength:Number(mask.bytesLength)};Object.assign(capture,{...nextBody,captureDigest:digest(nextBody)});
      Object.assign(assets.get(image.assetId)!,{object_created_at:now});Object.assign(assets.get(mask.assetId)!,{sha256:mask.sha256,bytes_length:mask.bytesLength,object_created_at:now});
      records.push(evidence('OPERATIONAL_CANDIDATE',candidate),evidence('OPERATIONAL_SOURCE',source));
      expect((await facade.compositeMaskedPixels(nativeSource,nativeMask.png,nativeSource,syntheticProfile)).outsideChangedPixels).toBe(0);
      await gateway.idle();expect(nativeEvents.filter(event=>event==='GO')).toHaveLength(3);
    }catch(error){gateway.stopClaims();await gateway.idle();throw error;}
  }
  return {root,input,capture,claim,full:structuredClone(calculation.capture),records,core,fence,account,assets,query,tx,accountTransaction,control,db,bytes,store,preparation,gateway,nativeEvents,txCount:()=>txCount,evidence};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function record<T extends object>(body:T):T&{recordDigest:string}{return {...body,recordDigest:digest(body)};}
function facts(f:Fixture,original:LocalLaMaOriginalInvocation){
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,profileDigest:f.capture.profileDigest,identityDigest:digest(f.capture.identity)};
  const start={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime};
  const cost={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:f.capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.125',evidenceRef:'fixture-cost',basisVersion:'fixture-cost-basis'};
  const reply={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(f.bytes),byteLength:f.bytes.length}};return {runtime,start,cost,reply};
}
const prepare=(f:Fixture,store:LocalLaMaRawStore)=>store.prepareOriginal(f.input,f.capture,f.full,f.claim);
const append=(f:Fixture,store:LocalLaMaRawStore,view:LocalLaMaAttemptMetadataView,value:LocalLaMaAttemptMetadata)=>store.appendMetadata(f.input,f.capture,f.full,view.original,value);
const replyRef=(view:LocalLaMaAttemptMetadataView):LocalLaMaRawReplyRef=>{const item=view.records.find(row=>row.record.kind==='ENGINE_REPLY')!;return {ordinal:item.ordinal,envelopeDigest:item.envelopeDigest,recordDigest:item.record.recordDigest};};
const restore=(f:Fixture,store:LocalLaMaRawStore,view:LocalLaMaAttemptMetadataView)=>store.restore(f.input,f.capture,f.full,view.original);
async function published(f:Fixture,store:LocalLaMaRawStore){
  const original=await prepare(f,store);expect(original.publication).not.toBeNull();const values=facts(f,original.metadata.original);
  const view=await append(f,store,original.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:values.reply}));
  return {...original,publication:original.publication!,view,values,ref:replyRef(view)};
}
async function allocated(f:Fixture,store:LocalLaMaRawStore){const publication=await published(f,store),allocation=await store.allocate(publication.publication,publication.ref);expect(allocation.put).not.toBeNull();return {...publication,...allocation,put:allocation.put!};}
const waiting={nextAction:'WAIT'},rawWait={code:'LOCAL_LAMA_RAW_UNCONFIRMED',nextAction:'WAIT'};
const rawRows=(f:Fixture)=>f.records.filter(row=>[lamaRawAllocationKind,lamaRawReceiptKind].includes(row.kind));
const value=(row:Evidence)=>(row.protected_observation as {value:Record<string,unknown>}).value;
const refresh=(row:Evidence)=>{row.evidence_digest=digest(row.protected_observation);};
function proxy<T extends object>(input:T){let calls=0;const trap=()=>{calls++;throw Error('CALLER_PROXY_TRAP');};return {value:new Proxy(input,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}

describe('private original raw owner with actual bounded local storage',()=>{
  it('preserves verified CAPTURE/PRECHECK/JOIN refs and ordered metadata through raw receipt and a new prepared instance without another GO or PUT',async()=>{
    const f=await fixture(true);expect(f.preparation).toBeDefined();expect(f.gateway).toBeDefined();
    try{
      const preparationRows=structuredClone(f.records.filter(row=>[lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind].includes(row.kind)));
      expect(preparationRows.filter(row=>row.kind===lamaPreparationCaptureKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
      const goBefore=f.nativeEvents.filter(event=>event==='GO').length,store=f.store(),original=await prepare(f,store);expect(original.publication).not.toBeNull();
      const values=facts(f,original.metadata.original),startView=await append(f,store,original.metadata,record({version:1 as const,kind:'START' as const,fact:values.start})),view=await append(f,store,startView,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:values.reply}));
      expect(view.records.map(row=>row.record.kind)).toEqual(['START','ENGINE_REPLY']);
      const allocation=await store.allocate(original.publication!,replyRef(view));expect(allocation.put).not.toBeNull();
      const first={...original,...allocation,view,put:allocation.put!},orderedMetadata=structuredClone(view.records.map(row=>({ordinal:row.ordinal,previousEnvelopeDigest:row.previousEnvelopeDigest,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest})));
      expect(orderedMetadata.map(row=>row.ordinal)).toEqual([1,2]);expect(orderedMetadata[0].previousEnvelopeDigest).toBe(original.metadata.originalEnvelopeDigest);expect(orderedMetadata[1].previousEnvelopeDigest).toBe(orderedMetadata[0].envelopeDigest);
      const originalRows=structuredClone(f.records.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')),saved=await store.put(first.put,f.bytes),next=f.store(),restored=await restore(f,next,first.view);
      const journal=new LocalLaMaAttemptJournal(f.db,journalBounds(),f.preparation),read=await f.db.accountTransaction(f.input.accountId!,tx=>journal.readOriginalIn(tx,f.input,f.capture,f.full,first.metadata.original),true);
      expect(restored).toEqual(saved);expect(restored.metadata.original).toEqual(first.metadata.original);expect(restored.metadata.originalEnvelopeDigest).toBe(first.metadata.originalEnvelopeDigest);expect(restored.metadata.records).toEqual(first.view.records);expect(read.metadata.records).toEqual(first.view.records);
      for(const metadata of [restored.metadata,read.metadata])expect(metadata.records.map(row=>({ordinal:row.ordinal,previousEnvelopeDigest:row.previousEnvelopeDigest,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest}))).toEqual(orderedMetadata);
      expect(read.rows.filter(row=>[lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind].includes(row.kind))).toEqual(preparationRows);expect(f.records.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toEqual(originalRows);expect(originalRows).toHaveLength(1);
      expect(rawRows(f).map(row=>row.kind)).toEqual([lamaRawAllocationKind,lamaRawReceiptKind]);expect(store.usage().putCalls).toBe(1);expect(next.usage().putCalls).toBe(0);expect(f.nativeEvents.filter(event=>event==='GO')).toHaveLength(goBefore);expect((await prepare(f,next)).publication).toBeNull();
      const noPreparation=new LocalLaMaRawStore(f.db,f.root,limits()),before=structuredClone(f.records);
      await expect(restore(f,noPreparation,first.view)).rejects.toMatchObject(waiting);expect(noPreparation.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(f.records).toEqual(before);
      const noPreparationJournal=new LocalLaMaAttemptJournal(f.db,journalBounds());await expect(f.db.accountTransaction(f.input.accountId!,tx=>noPreparationJournal.readOriginalIn(tx,f.input,f.capture,f.full,first.metadata.original),true)).rejects.toMatchObject(waiting);
    }finally{f.gateway!.stopClaims();await f.gateway!.idle();}
  });
  it('uses first ACKs and one opaque PUT then restores identical key/receipt through a new instance',async()=>{
    const f=await fixture(),store=f.store(),before=structuredClone(f.records),first=await allocated(f,store),result=await store.put(first.put,f.bytes),next=f.store(),restored=await restore(f,next,first.view);
    expect(result).toMatchObject({kind:'RAW_CANDIDATE',restoration:'BYTES_VERIFIED',metadata:{kind:'METADATA_ONLY',originalLifetime:'UNCONFIRMED',rawRestoration:'UNCONFIRMED',status:'UNCONFIRMED'}});
    expect(result.bytes).toEqual(f.bytes);expect(restored).toEqual(result);expect(result.allocation.key).toBe(f.input.accountId+'/'+result.allocation.assetId);expect(result.allocation.mediaType).toBe('application/octet-stream');
    expect(rawRows(f).map(row=>row.kind)).toEqual([lamaRawAllocationKind,lamaRawReceiptKind]);expect(f.records.slice(0,4)).toEqual(before);expect(store.usage().putCalls).toBe(1);expect(next.usage().putCalls).toBe(0);
    expect((await prepare(f,next)).publication).toBeNull();expect(next.usage().metadataBytes).toBe(0);expect((await readdir(path.join(f.root,f.input.accountId!))).sort()).toEqual([result.allocation.assetId,result.allocation.assetId+'.put-start.json',result.allocation.assetId+'.receipt.json'].sort());
    expect(store.usage()).toMatchObject({publications:0,allocations:0,pendingPuts:0,io:0,metadataBytes:0,rawBytes:0});await expect(store.put(first.put,f.bytes)).rejects.toMatchObject(rawWait);
  });
  it('rejects forged JSON, clones, crossed-instance publications and consumed handles without a DB call',async()=>{
    const f=await fixture(),store=f.store(),first=await published(f,store),calls=f.accountTransaction.mock.calls.length;
    for(const handle of [{created:true,original:first.metadata.original},Object.freeze({...first.publication}),new Proxy(first.publication,{})])await expect(store.allocate(handle as LocalLaMaRawPublication,first.ref)).rejects.toMatchObject(waiting);
    await expect(f.store().allocate(first.publication,first.ref)).rejects.toMatchObject(rawWait);expect(f.accountTransaction).toHaveBeenCalledTimes(calls);
    const allocation=await store.allocate(first.publication,first.ref),after=f.accountTransaction.mock.calls.length;
    await expect(store.allocate(first.publication,first.ref)).rejects.toMatchObject(rawWait);await expect(store.put({} as LocalLaMaRawPut,f.bytes)).rejects.toMatchObject(rawWait);await expect(f.store().put(allocation.put!,f.bytes)).rejects.toMatchObject(rawWait);expect(f.accountTransaction).toHaveBeenCalledTimes(after);expect(store.closePut(allocation.put!)).toBe(true);expect(store.closePut(allocation.put!)).toBe(false);
  });
  it('never reissues publication after original commit ACK loss or a legacy direct journal claim',async()=>{
    for(const mode of ['lost','legacy'] as const){
      const f=await fixture();if(mode==='lost'){f.control.lossKind='LAMA_ATTEMPT_ORIGINAL';await expect(prepare(f,f.store())).rejects.toBe(f.control.loss);}
      else await new LocalLaMaAttemptJournal(f.db,journalBounds()).claim(f.input,f.capture,f.full,f.claim);
      const store=f.store(),recovered=await prepare(f,store);expect(recovered.publication).toBeNull();expect(f.records.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);await expect(restore(f,store,recovered.metadata)).rejects.toMatchObject(rawWait);
      expect(rawRows(f)).toHaveLength(0);expect(store.usage().putCalls).toBe(0);expect(await readdir(f.root)).toEqual([]);
    }
  });
  it('keeps the original allocation after commit ACK loss without minting another PUT or raw ID',async()=>{
    const f=await fixture(),store=f.store(),first=await published(f,store);f.control.lossKind=lamaRawAllocationKind;await expect(store.allocate(first.publication,first.ref)).rejects.toBe(f.control.loss);
    const before=structuredClone(rawRows(f)),next=f.store();expect(before).toHaveLength(1);expect((await prepare(f,next)).publication).toBeNull();await expect(restore(f,next,first.view)).rejects.toMatchObject(waiting);expect(rawRows(f)).toEqual(before);expect(next.usage().putCalls).toBe(0);expect(await readdir(f.root)).toEqual([]);expect(store.usage()).toMatchObject({metadataBytes:0,rawBytes:0,allocations:0,pendingPuts:0});
  });
  it('recovers a committed receipt after response loss with same object time and no additional PUT',async()=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store);f.control.lossKind=lamaRawReceiptKind;await expect(store.put(first.put,f.bytes)).rejects.toBe(f.control.loss);
    const before=structuredClone(rawRows(f)),raw=value(before.find(row=>row.kind===lamaRawReceiptKind)!);expect(before).toHaveLength(2);
    const next=f.store(),restored=await restore(f,next,first.view);expect(restored.receipt).toEqual(raw.receipt);expect(restored.bytes).toEqual(f.bytes);expect(rawRows(f)).toEqual(before);expect(store.usage().putCalls).toBe(1);expect(next.usage().putCalls).toBe(0);expect(f.assets.get(restored.allocation.assetId)!.object_created_at!.toISOString()).toBe(restored.receipt.completedAt);
  });
  it('owns claim, INPUT and captures before waiting and ignores public owner replacements',async()=>{
    const f=await fixture(),store=f.store(),expected=digest(canonicalInput(f.input));f.control.gateAt=1;const pending=prepare(f,store);await f.control.entered.promise;
    Object.assign(f.input,{width:999,accountId:randomUUID()});f.claim.ownerId=randomUUID();expect(Reflect.set(f.capture.identity,'weightsSha256',sha256('changed'))).toBe(true);expect(Reflect.set(f.full,'profileDigest',sha256('changed-full'))).toBe(true);
    const fake=vi.fn(async()=>({created:true}));Object.assign(store,{journal:{claim:fake},objects:{put:fake},assets:{registerReceiptIn:fake}});Object.assign(f.db,{accountTransaction:fake});
    f.control.gate.resolve();const first=await pending;expect(first.metadata.binding.inputFingerprint).toBe(expected);expect(first.publication).not.toBeNull();expect(fake).not.toHaveBeenCalled();expect(store.closePublication(first.publication!)).toBe(true);
  });
  it('owns reply and bytes before storage waits and cannot close active reservations early',async()=>{
    const f=await fixture(),store=f.store(),publication=await published(f,store),expectedRef=structuredClone(publication.ref);
    f.control.gateAt=f.txCount()+1;const allocationPending=store.allocate(publication.publication,publication.ref);await f.control.entered.promise;
    publication.ref.recordDigest=sha256('changed');const held=store.usage();expect(store.closePublication(publication.publication)).toBe(false);expect(store.usage()).toEqual(held);expect(held).toMatchObject({publications:0,allocations:1,pendingPuts:0});f.control.gate.resolve();
    const allocation=await allocationPending;expect(allocation.allocation.replyRecordDigest).toBe(expectedRef.recordDigest);
    f.control.gateAt=f.txCount()+1;f.control.entered=deferred<void>();f.control.gate=deferred<void>();const expectedBytes=Buffer.from(f.bytes),putPending=store.put(allocation.put!,f.bytes);await f.control.entered.promise;f.bytes.fill(0);
    const active=store.usage();expect(store.closePut(allocation.put!)).toBe(false);expect(store.usage()).toEqual(active);expect(active).toMatchObject({allocations:0,pendingPuts:0,io:1});f.control.gate.resolve();expect((await putPending).bytes).toEqual(expectedBytes);expect(store.usage()).toMatchObject({metadataBytes:0,rawBytes:0,io:0});
  });
  it('rejects getter/Proxy caller frames before traps, transactions or a handle',async()=>{
    const f=await fixture(),store=f.store(),bad=proxy(f.input);await expect(store.prepareOriginal(bad.value,f.capture,f.full,f.claim)).rejects.toMatchObject(waiting);expect(bad.calls()).toBe(0);
    let getters=0;const capture={...f.capture};Object.defineProperty(capture,'profileDigest',{enumerable:true,get(){getters++;return f.capture.profileDigest;}});await expect(store.prepareOriginal(f.input,capture,f.full,f.claim)).rejects.toMatchObject(waiting);expect(getters).toBe(0);expect(f.accountTransaction).not.toHaveBeenCalled();expect(store.usage()).toMatchObject({publications:0,metadataBytes:0});
  });
  it('rejects Buffer getters, Proxy/shared bytes and wrong SHA before the first awaited call',async()=>{
    for(const mode of ['getter','proxy','shared','hash'] as const){
      const f=await fixture(),store=f.store(),first=await allocated(f,store),before=f.accountTransaction.mock.calls.length;let getters=0;const bytes=mode==='shared'?Buffer.from(new SharedArrayBuffer(f.bytes.length)):Buffer.from(f.bytes),bad=proxy(bytes);
      if(mode==='getter')Object.defineProperty(bytes,'length',{get(){getters++;return f.bytes.length;}});
      if(mode==='hash')bytes.fill(0);
      await expect(store.put(first.put,mode==='proxy'?bad.value:bytes)).rejects.toMatchObject(waiting);expect(getters).toBe(0);expect(bad.calls()).toBe(0);expect(f.accountTransaction).toHaveBeenCalledTimes(before);expect(store.usage()).toMatchObject({metadataBytes:0,rawBytes:0,putCalls:0});expect(await readdir(f.root)).toEqual([]);
    }
  });
  it('reserves publication/encoded capacity before another caller and pending/IO capacity without gaps',async()=>{
    const f=await fixture(),store=f.store({maxPublications:1,maxPendingPuts:1,maxIo:1});f.control.gateAt=1;const pending=prepare(f,store);await f.control.entered.promise;
    const bad=proxy(f.input);await expect(store.prepareOriginal(bad.value,f.capture,f.full,f.claim)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});expect(bad.calls()).toBe(0);f.control.gate.resolve();const original=await pending;
    const view=await append(f,store,original.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:facts(f,original.metadata.original).reply})),allocation=await store.allocate(original.publication!,replyRef(view));
    expect(store.usage()).toMatchObject({publications:0,allocations:0,pendingPuts:1});const other=await prepare(f,store);expect(other.publication).toBeNull();
    f.control.gateAt=f.txCount()+1;f.control.entered=deferred<void>();f.control.gate=deferred<void>();const active=store.put(allocation.put!,f.bytes);await f.control.entered.promise;
    await expect(store.restore(bad.value,f.capture,f.full,original.metadata.original)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});expect(bad.calls()).toBe(0);expect(store.closePut(allocation.put!)).toBe(false);f.control.gate.resolve();await active;expect(store.usage()).toMatchObject({io:0,metadataBytes:0,rawBytes:0});
    const bytes=f.store({maxInFlightRawBytes:6*limits().maxRawBytes+4});const current=await bytes.restore(f.input,f.capture,f.full,original.metadata.original);expect(current.bytes).toEqual(f.bytes);expect(bytes.usage().rawBytes).toBe(0);
  });
  it.each(['sha','length','media','deleted','expired'] as const)('checks source %s eligibility before allocation or file I/O',async scenario=>{
    const f=await fixture(),store=f.store(),first=await published(f,store),source=f.assets.get(f.input.originalAssetId)!;
    if(scenario==='sha')source.sha256=sha256('wrong');if(scenario==='length')source.bytes_length='1';if(scenario==='media')source.media_type='image/jpeg';if(scenario==='deleted')source.deletion_state='CONFIRMED';if(scenario==='expired')source.access_deadline=new Date(f.tx.now.valueOf()-1);
    const before=structuredClone(f.records);await expect(store.allocate(first.publication,first.ref)).rejects.toMatchObject(rawWait);expect(f.records).toEqual(before);expect(store.usage().putCalls).toBe(0);expect(await readdir(f.root)).toEqual([]);
  });
  it('preserves a stored object when eligibility changes before receipt registration',async()=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store);f.control.gateAt=f.txCount()+2;const pending=store.put(first.put,f.bytes);await f.control.entered.promise;
    f.assets.get(f.input.originalAssetId)!.deletion_state='CONFIRMED';const held=store.usage();expect(store.closePut(first.put)).toBe(false);expect(store.usage()).toEqual(held);f.control.gate.resolve();await expect(pending).rejects.toMatchObject(rawWait);
    expect(await readFile(path.join(f.root,first.allocation.key))).toEqual(f.bytes);expect(rawRows(f).map(row=>row.kind)).toEqual([lamaRawAllocationKind]);await expect(restore(f,f.store(),first.view)).rejects.toMatchObject(rawWait);expect(store.usage().putCalls).toBe(1);
  });
  it.each(['purpose','bucket','key','context','sha','length','time','deleted','expired'] as const)('rejects current raw %s conflict before same-key GET',async scenario=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store),result=await store.put(first.put,f.bytes),row=f.assets.get(first.allocation.assetId)!;
    if(scenario==='purpose')row.purpose='EXPORT';if(scenario==='bucket')row.bucket_ref='other';if(scenario==='key')row.object_key=f.input.accountId+'/'+randomUUID();if(scenario==='context')row.related_context_id=randomUUID();if(scenario==='sha')row.sha256=sha256('other');if(scenario==='length')row.bytes_length='1';if(scenario==='time')row.object_created_at=new Date(Date.parse(result.receipt.completedAt)+1);if(scenario==='deleted')row.deletion_state='CONFIRMED';if(scenario==='expired')row.access_deadline=new Date(f.tx.now.valueOf()-1);
    const before=structuredClone(f.records),next=f.store();await expect(restore(f,next,first.view)).rejects.toMatchObject(rawWait);expect(next.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(f.records).toEqual(before);
  });
  it('allows only both exact cost HOLDs and preserves status/lifetime after BYTES_VERIFIED',async()=>{
    const f=await fixture(),store=f.store(),first=await prepare(f,store),fact=facts(f,first.metadata.original);
    let view=await append(f,store,first.metadata,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...fact.reply,fullCost:fact.cost}}));
    view=await append(f,store,view,record({version:1 as const,kind:'HOLD' as const,code:'LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED',relatedDigest:fact.cost.runtimeDigest}));
    expect(view.holds).toEqual(['LOCAL_LAMA_ATTEMPT_ENGINE_COST_UNCONFIRMED','LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED']);
    const allocation=await store.allocate(first.publication!,replyRef(view)),result=await store.put(allocation.put!,f.bytes);expect(result.metadata).toEqual(view);expect(result.metadata.status).toBe('HOLD');expect(result.metadata.originalLifetime).toBe('UNCONFIRMED');
    const next=await fixture(),owner=next.store(),original=await published(next,owner),unknown=await append(next,owner,original.view,record({version:1 as const,kind:'HOLD' as const,code:'UNKNOWN_COST_ALIAS',relatedDigest:null}));
    expect(unknown.holds).toEqual(['UNKNOWN_COST_ALIAS']);await expect(owner.allocate(original.publication,original.ref)).rejects.toMatchObject(rawWait);expect(rawRows(next)).toHaveLength(0);
  });
  it.each(['ref','digest','wrapper','original','reply','duplicate','oversized','overflow','unverified-preparation'] as const)('holds %s history without an existing allocation shortcut',async scenario=>{
    const f=await fixture(),store=f.store(),first=await allocated(f,store),row=rawRows(f)[0];
    if(scenario==='ref')row.protected_evidence_ref=randomUUID();if(scenario==='digest')row.evidence_digest=sha256('bad-envelope');if(scenario==='wrapper')(row.protected_observation as {accountId:string}).accountId=randomUUID();if(scenario==='original')value(row).original={...first.view.original,invocationId:randomUUID()};if(scenario==='reply')value(row).replyEnvelopeDigest=sha256('crossed-reply');
    if(scenario==='duplicate')f.records.push(f.evidence(lamaRawAllocationKind,{...value(row),assetId:randomUUID()}));
    if(scenario==='oversized')f.records.push(f.evidence('UNCLASSIFIED',{payload:'x'.repeat(journalBounds().maxRecordBytes)}));
    if(scenario==='overflow')for(let at=f.records.length;at<=journalBounds().maxRecords;at++)f.records.push(f.evidence('BOUNDED_EXTRA',{at}));
    if(scenario==='unverified-preparation')f.records.push(f.evidence('LAMA_PREPARATION_CAPTURE',{unverified:true}));
    if(['wrapper','original','reply'].includes(scenario))refresh(row);
    const before=structuredClone(f.records),next=f.store();await expect(restore(f,next,first.view)).rejects.toMatchObject(waiting);expect(f.records).toEqual(before);expect(next.usage()).toMatchObject({putCalls:0,receiptCalls:0,readCalls:0});expect(store.closePut(first.put)).toBe(true);
  });
  it('keeps the first FileObjectStore and journal methods when public prototypes are replaced',async()=>{
    const f=await fixture(),store=f.store(),replacement=vi.fn(async()=>{throw Error('PUBLIC_REPLACEMENT');});
    vi.spyOn(LocalLaMaAttemptJournal.prototype,'claim').mockImplementation(replacement);vi.spyOn(LocalLaMaAttemptJournal.prototype,'readOriginalIn').mockImplementation(replacement);vi.spyOn(FileObjectStore.prototype,'put').mockImplementation(replacement);vi.spyOn(FileObjectStore.prototype,'read').mockImplementation(replacement);vi.spyOn(Assets.prototype,'registerReceiptIn').mockImplementation(replacement);
    const first=await allocated(f,store),result=await store.put(first.put,f.bytes);expect(result.bytes).toEqual(f.bytes);expect(replacement).not.toHaveBeenCalled();expect(rawRows(f)).toHaveLength(2);
  });
  it('allows historical facts after owner/restricted/closed transition but grants no fresh publication',async()=>{
    const f=await fixture(),store=f.store(),first=await published(f,store);f.account.access_state='RESTRICTED';f.fence.lease_live=false;f.fence.claim_owner=null as unknown as string;Object.assign(f.core,{lifecycle:'CLOSED',request_state:'STOPPED',request_terminal:true,execution_state:'SUCCEEDED'});
    const allocation=await store.allocate(first.publication,first.ref),result=await store.put(allocation.put!,f.bytes);expect((await restore(f,f.store(),first.view)).receipt).toEqual(result.receipt);expect((await prepare(f,f.store())).publication).toBeNull();expect(f.records.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);
    const fresh=await fixture();fresh.account.access_state='RESTRICTED';await expect(prepare(fresh,fresh.store())).rejects.toMatchObject({code:'LOCAL_LAMA_DISPATCH_UNCONFIRMED'});expect(rawRows(fresh)).toHaveLength(0);
  });
  it('preserves original key, object and intent when bounded history fills after PUT',async()=>{
    const f=await fixture(),store=f.store({journal:{...journalBounds(),maxRecords:8}}),first=await allocated(f,store);
    await append(f,store,first.view,record({version:1 as const,kind:'HOLD' as const,code:'LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED',relatedDigest:sha256('whole-cost-unknown')}));expect(f.records).toHaveLength(8);
    await expect(store.put(first.put,f.bytes)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});expect(rawRows(f).map(row=>row.kind)).toEqual([lamaRawAllocationKind]);const before=structuredClone(f.records),next=f.store({journal:{...journalBounds(),maxRecords:8}});
    await expect(restore(f,next,first.view)).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY'});expect(f.records).toEqual(before);expect(await readFile(path.join(f.root,first.allocation.key))).toEqual(f.bytes);expect(JSON.parse(await readFile(path.join(f.root,first.allocation.key+'.put-start.json'),'utf8'))).toMatchObject({sha256:sha256(f.bytes),bytesLength:String(f.bytes.length)});expect(next.usage().putCalls).toBe(0);
  });
  it('does not rewrite a missing/corrupt/future receipt and never PUTs during recovery',async()=>{
    for(const mode of ['missing','corrupt','future'] as const){
      const f=await fixture(),store=f.store(),first=await allocated(f,store),result=await store.put(first.put,f.bytes),file=path.join(f.root,first.allocation.key+'.receipt.json');
      if(mode==='missing')await rm(file);else await writeFile(file,JSON.stringify({...result.receipt,...(mode==='corrupt'?{sha256:sha256('other')}:{completedAt:new Date(f.tx.now.valueOf()+10000).toISOString()})}));
      const before=structuredClone(f.records),next=f.store();await expect(restore(f,next,first.view)).rejects.toMatchObject(waiting);expect(next.usage().putCalls).toBe(0);expect(f.records).toEqual(before);expect(await readFile(path.join(f.root,first.allocation.key))).toEqual(f.bytes);
    }
  });
});
