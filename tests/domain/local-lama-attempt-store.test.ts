import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {lamaCodeCommit} from '../../packages/providers/src/lama.js';
import type {LocalLaMaCapture} from '../../packages/providers/src/local-lama.js';
import {LocalLaMaInvocationCoordinator,type LocalLaMaOriginalInvocation,type LocalLaMaInvocationBinding,type LocalLaMaEnginePort} from '../../packages/providers/src/local-lama-executor.js';
import type {LocalLaMaDomainAttemptStore,LocalLaMaAttemptStoreBounds,LocalLaMaAttemptStoreOptions} from '../../packages/domain/src/local-lama-attempt-store.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadataView} from '../../packages/domain/src/local-lama-attempt-journal.js';
import {LocalLaMaRawStore,lamaRawAllocationKind,lamaRawReceiptKind,type LocalLaMaRawStoreBounds} from '../../packages/domain/src/local-lama-raw-store.js';
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
afterEach(async()=>{const failures:unknown[]=[],unconfirmedRoots=new Set<string>();for(const {controller,root}of controllers.splice(0)){controller.stopClaims();try{await controller.idle();}catch(error){failures.push(error);unconfirmedRoots.add(root);}}vi.restoreAllMocks();for(const root of roots.splice(0)){if(unconfirmedRoots.has(root))continue;expect(path.dirname(root)).toBe(await realpath(tmpdir()));const stat=await lstat(root);expect(stat.isDirectory()&&!stat.isSymbolicLink()).toBe(true);expect(await realpath(root)).toBe(root);await rm(root,{recursive:true});}if(failures.length)throw new AggregateError(failures,'ATTEMPT_TEST_CHILD_TERMINATION_UNCONFIRMED');});
function deferred<T>(){let resolve:(value:T)=>void=()=>{};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const journalBounds=()=>({maxRecordBytes:65536,maxRecords:32,maxInFlightBytes:64*1024*1024,maxConcurrentReads:4,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}});
const limits=():LocalLaMaRawStoreBounds=>({journal:journalBounds(),maxRawBytes:1024,maxInFlightMetadataBytes:512*1024*1024,maxInFlightRawBytes:64*1024,maxPublications:4,maxAllocations:4,maxPendingPuts:4,maxIo:4,maxMetadataCalls:4});
const nativeLimits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:8,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:1048576};
async function fixture(withPreparation=false){
  const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'trio-lama-attempt-domain-'));roots.push(root);
  const accountId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),executionId=randomUUID(),originalAssetId=randomUUID(),profileId=withPreparation?syntheticProfile.id:'raw-owned-profile',profileDigest=sha256('raw-owned-profile');
  const settings={settingsVersion:'1',contractVersion:'raw-owned-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const nativeSource=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const image={assetId:originalAssetId,sha256:sha256(nativeSource),bytesLength:String(nativeSource.length),mediaType:'image/png'};
  const input:StageInput={accountId,contextId,requestId,executionId,stage:'CLEANUP',inputDigest:sha256('raw-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,claimGeneration:'1',assetDependencies:[image],currentCleanedAssetId:null,currentRenderAssetId:null,previousOutputAssetIds:[],
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest:sha256('raw-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:profileId}};
  let maskBytes=Buffer.from(nativeSource);
  const captureBody:Omit<LocalLaMaCapture,'captureDigest'>={version:1,executionId,inputDigest:input.inputDigest,profileId,profileDigest,identity:{codeCommit:lamaCodeCommit,weightsSha256:sha256('fixture-weights'),configSha256:sha256('fixture-config'),weightsLicenseVerified:true,runtimeVerified:true},imageSha256:image.sha256,imageByteLength:Number(image.bytesLength),maskSha256:sha256(maskBytes),maskByteLength:maskBytes.length};
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
  const control={lossKind:null as string|null,loss:Error('RAW_COMMIT_ACK_LOST') as unknown,gateAt:0,entered:deferred<void>(),gate:deferred<void>()};
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
      maskBytes=Buffer.from(nativeMask.png);Object.assign(mask,{sha256:sha256(nativeMask.png),bytesLength:String(nativeMask.png.length)});const nextBody={...captureBody,maskSha256:mask.sha256,maskByteLength:Number(mask.bytesLength)};Object.assign(capture,{...nextBody,captureDigest:digest(nextBody)});
      Object.assign(assets.get(image.assetId)!,{object_created_at:now});Object.assign(assets.get(mask.assetId)!,{sha256:mask.sha256,bytes_length:mask.bytesLength,object_created_at:now});
      records.push(evidence('OPERATIONAL_CANDIDATE',candidate),evidence('OPERATIONAL_SOURCE',source));
      expect((await facade.compositeMaskedPixels(nativeSource,nativeMask.png,nativeSource,syntheticProfile)).outsideChangedPixels).toBe(0);
      await gateway.idle();expect(nativeEvents.filter(event=>event==='GO')).toHaveLength(3);
    }catch(error){gateway.stopClaims();await gateway.idle();throw error;}
  }
  return {root,input,capture,claim,full:structuredClone(calculation.capture),records,core,fence,account,assets,query,tx,accountTransaction,control,db,bytes,store,preparation,gateway,nativeEvents,txCount:()=>txCount,evidence,imageBytes:Buffer.from(nativeSource),maskBytes};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

type Store=LocalLaMaDomainAttemptStore;
type RawUsage=ReturnType<LocalLaMaRawStore['usage']>;
const rawCalls:{account:string;operation:'PUT'|'CLOSE_PUBLICATION'|'CLOSE_PUT';before:RawUsage;after?:RawUsage;closed?:boolean}[]=[];
const allocationFailures=new Set<string>();
let ownerConstructor:typeof import('../../packages/domain/src/local-lama-attempt-store.js').LocalLaMaDomainAttemptStore|null=null;
async function owningClass(){
  if(ownerConstructor)return ownerConstructor;
  // Test-only observation wrappers delegate to the actual object methods.
  // The single failure seam below can only throw before allocation; it does
  // not synthesize a created ACK, receipt, publication or positive authority.
  const original=Object.getOwnPropertyDescriptors(LocalLaMaRawStore.prototype),accounts=new WeakMap<LocalLaMaRawStore,string>();
  const prepareOriginal=original.prepareOriginal.value,allocate=original.allocate.value,put=original.put.value,closePublication=original.closePublication.value,closePut=original.closePut.value;
  if(typeof prepareOriginal!=='function'||typeof allocate!=='function'||typeof put!=='function'||typeof closePublication!=='function'||typeof closePut!=='function')throw Error('ACTUAL_RAW_METHOD_MISSING');
  const methods:Partial<Record<keyof LocalLaMaRawStore,unknown>>={
    prepareOriginal:function(this:LocalLaMaRawStore,...args:Parameters<LocalLaMaRawStore['prepareOriginal']>){accounts.set(this,args[0].accountId!);return Reflect.apply(prepareOriginal,this,args);},
    allocate:function(this:LocalLaMaRawStore,...args:Parameters<LocalLaMaRawStore['allocate']>){if(allocationFailures.has(accounts.get(this)!))throw new DomainError('LOCAL_LAMA_RAW_CAPACITY',409,'WAIT');return Reflect.apply(allocate,this,args);},
    put:function(this:LocalLaMaRawStore,...args:Parameters<LocalLaMaRawStore['put']>){rawCalls.push({account:accounts.get(this)!,operation:'PUT',before:this.usage()});return Reflect.apply(put,this,args);},
    closePublication:function(this:LocalLaMaRawStore,...args:Parameters<LocalLaMaRawStore['closePublication']>){const before=this.usage(),closed=Reflect.apply(closePublication,this,args);rawCalls.push({account:accounts.get(this)!,operation:'CLOSE_PUBLICATION',before,after:this.usage(),closed});return closed;},
    closePut:function(this:LocalLaMaRawStore,...args:Parameters<LocalLaMaRawStore['closePut']>){const before=this.usage(),closed=Reflect.apply(closePut,this,args);rawCalls.push({account:accounts.get(this)!,operation:'CLOSE_PUT',before,after:this.usage(),closed});return closed;},
  };
  try{
    for(const [key,value]of Object.entries(methods))Object.defineProperty(LocalLaMaRawStore.prototype,key,{...original[key],value});
    ownerConstructor=(await import('../../packages/domain/src/local-lama-attempt-store.js')).LocalLaMaDomainAttemptStore;
  }finally{for(const key of Object.keys(methods))Object.defineProperty(LocalLaMaRawStore.prototype,key,original[key]);}
  return ownerConstructor;
}
const ownerBounds=():LocalLaMaAttemptStoreBounds=>({raw:limits(),maxConcurrentCalls:4,maxOpenClaims:4,maxInFlightBytes:512*1024*1024});
const binding=(f:Fixture):LocalLaMaInvocationBinding=>({version:1,accountId:f.input.accountId!,requestId:f.input.requestId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),fullStageCaptureDigest:f.full.captureDigest,localCaptureDigest:f.capture.captureDigest,mode:f.full.mode});
const options=(f:Fixture):LocalLaMaAttemptStoreOptions=>({db:f.db,root:f.root,input:f.input,capture:f.capture,fullStageCapture:f.full,claim:f.claim,binding:binding(f),bounds:ownerBounds(),...(f.preparation?{preparation:f.preparation}:{})});
async function owner(f:Fixture,delta:Partial<LocalLaMaAttemptStoreOptions>={}){const Constructor=await owningClass();return new Constructor({...options(f),...delta});}
const putCount=(f:Fixture)=>rawCalls.filter(row=>row.account===f.input.accountId&&row.operation==='PUT').length;
const rowsOf=(f:Fixture,kind:string)=>f.records.filter(row=>row.kind===kind);
const recordValue=(row:Evidence)=>(row.protected_observation as {value:Record<string,unknown>}).value;
const ordered=(view:LocalLaMaAttemptMetadataView)=>view.records.map(row=>({ordinal:row.ordinal,previousEnvelopeDigest:row.previousEnvelopeDigest,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest}));
const wait={nextAction:'WAIT'};
function proxy<T extends object>(input:T){let calls=0;const trap=()=>{calls++;throw Error('CALLER_PROXY_TRAP');};return {value:new Proxy(input,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),calls:()=>calls};}
function facts(f:Fixture,original:LocalLaMaOriginalInvocation){
  const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:original.invocationId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,profileDigest:f.capture.profileDigest,identityDigest:digest(f.capture.identity)};
  const start={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime};
  const fullCost={version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:f.capture.captureDigest,runtimeDigest:digest(runtime),actualUsd:'0.125',evidenceRef:'fixture-full-stage-cost',basisVersion:'fixture-cost-basis'};
  const reply={version:1 as const,evidenceId:randomUUID(),captureDigest:f.capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(f.bytes),byteLength:f.bytes.length,bytes:Buffer.from(f.bytes)}};
  return {runtime,start,fullCost,reply};
}
function record<T extends object>(body:T):T&{recordDigest:string}{
  const source=body as {kind?:string;reply?:ReturnType<typeof facts>['reply']};
  const metadata=source.kind==='ENGINE_REPLY'?{...body,reply:{...source.reply!,proposal:source.reply!.proposal?{sha256:source.reply!.proposal.sha256,byteLength:source.reply!.proposal.byteLength}:null}}:body;
  return {...body,recordDigest:digest(metadata)};
}
async function claimed(f:Fixture,store:Store){
  const ports=store.capabilities(),first=await ports.claim(binding(f),f.capture);expect(first.created).toBe(true);expect(first.records).toEqual([]);
  const values=facts(f,first.original);await ports.append(binding(f),first.original,record({version:1 as const,kind:'START' as const,fact:values.start}));
  return {ports,first,values};
}
function coordinator(f:Fixture,store:Store){
  let known:ReturnType<typeof facts>|null=null;
  const submit=vi.fn<LocalLaMaEnginePort['submit']>((value,onStarted)=>{
    const reply=(async()=>{known=facts(f,value.original);await onStarted(known.start);return known.reply;})();
    return {reply,joined:reply.then(()=>undefined)};
  });
  const query=vi.fn<LocalLaMaEnginePort['query']>(()=>{const reply=Promise.resolve(known?.reply??null);return {reply,joined:reply.then(()=>undefined)};});
  const costs=vi.fn(async(value:Parameters<import('../../packages/providers/src/local-lama-executor.js').LocalLaMaFullCostReader['lookup']>[0])=>known?{version:1 as const,bindingDigest:digest(value.binding),fullStageCaptureDigest:f.full.captureDigest,closureEvidenceRef:'fake-whole-stage-closure',fullCost:known.fullCost}:null);
  const executor=new LocalLaMaInvocationCoordinator({binding:binding(f),capture:f.capture,bounds:{maxEncodedBytes:1024,maxMetadataBytes:65536,maxInFlightBytes:16*1024*1024,maxConcurrentCalls:4,maxRecords:32},attempts:store.capabilities(),engine:{submit,query},costs:{lookup:costs}});
  return {executor,submit,query,costs,setKnown:(value:ReturnType<typeof facts>)=>{known=value;}};
}
const dispatch=(f:Fixture,executor:LocalLaMaInvocationCoordinator)=>executor.dispatch({capture:f.capture,image:Buffer.from(f.imageBytes),mask:Buffer.from(f.maskBytes)},async()=>{});
async function journalView(f:Fixture){return new LocalLaMaAttemptJournal(f.db,journalBounds(),f.preparation).lookup(f.input,f.capture,f.full);}

describe('actual domain attempt adapter with private raw/journal capabilities',()=>{
  it('runs the actual Coordinator first claim and ordered START/reply/cost through one raw PUT and restores through a new owner',async()=>{
    const f=await fixture(),store=await owner(f),ports=store.capabilities(),run=coordinator(f,store),before=structuredClone(f.records);
    expect(Object.keys(ports).sort()).toEqual(['append','claim','lookup']);expect(Object.getPrototypeOf(ports)).toBe(Object.prototype);expect(Object.isFrozen(ports)).toBe(true);
    const result=await dispatch(f,run.executor);expect(result).toMatchObject({state:'SUCCEEDED',providerSuccess:true,proposal:{sha256:sha256(f.bytes),byteLength:f.bytes.length},fullCost:{actualUsd:'0.125'}});expect(result.proposal!.bytes).toEqual(f.bytes);
    expect(run.submit).toHaveBeenCalledTimes(1);expect(run.query).not.toHaveBeenCalled();expect(run.costs).toHaveBeenCalledTimes(1);
    const first=(await journalView(f))!,originalRows=structuredClone(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')),rawRows=structuredClone(f.records.filter(row=>[lamaRawAllocationKind,lamaRawReceiptKind].includes(row.kind)));
    expect(first.records.map(row=>row.record.kind)).toEqual(['START','ENGINE_REPLY','FULL_COST']);expect(first.records.map(row=>row.ordinal)).toEqual([1,2,3]);expect(first.records[0].previousEnvelopeDigest).toBe(first.originalEnvelopeDigest);
    for(let index=1;index<first.records.length;index++)expect(first.records[index].previousEnvelopeDigest).toBe(first.records[index-1].envelopeDigest);
    expect(first.records.find(row=>row.record.kind==='ENGINE_REPLY')!.record).not.toHaveProperty('reply.proposal.bytes');expect(originalRows).toHaveLength(1);expect(rawRows.map(row=>row.kind)).toEqual([lamaRawAllocationKind,lamaRawReceiptKind]);expect(putCount(f)).toBe(1);
    const next=await owner(f),restored=await next.capabilities().lookup(binding(f),f.capture),nextView=(await journalView(f))!;
    expect(restored!.original).toEqual(first.original);expect(restored!.records.map(row=>row.recordDigest)).toEqual(first.records.map(row=>row.record.recordDigest));expect(ordered(nextView)).toEqual(ordered(first));
    const proposal=restored!.records.find(row=>row.kind==='ENGINE_REPLY')!;expect(proposal.kind).toBe('ENGINE_REPLY');if(proposal.kind==='ENGINE_REPLY')expect(proposal.reply.proposal!.bytes).toEqual(f.bytes);
    const again=coordinator(f,next);again.setKnown(facts(f,first.original)); // Query reuses the original record facts below; no new evidence IDs.
    const firstReply=restored!.records.find(row=>row.kind==='ENGINE_REPLY')!;
    if(firstReply.kind==='ENGINE_REPLY'){const known=facts(f,first.original);Object.assign(known,{runtime:firstReply.reply.runtime,start:firstReply.reply.start!,reply:firstReply.reply,fullCost:result.fullCost!});again.setKnown(known);}
    expect((await again.executor.lookup(f.capture))!.state).toBe('SUCCEEDED');expect(again.submit).not.toHaveBeenCalled();expect(again.query).toHaveBeenCalledTimes(1);
    expect(putCount(f)).toBe(1);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toEqual(originalRows);expect(f.records.filter(row=>[lamaRawAllocationKind,lamaRawReceiptKind].includes(row.kind))).toEqual(rawRows);expect(f.records.slice(0,before.length)).toEqual(before);
    const allocation=recordValue(rawRows[0]) as {assetId:string};expect((await readdir(path.join(f.root,f.input.accountId!))).sort()).toEqual([allocation.assetId,allocation.assetId+'.put-start.json',allocation.assetId+'.receipt.json'].sort());
  });
  it('preserves verified preparation refs through actual SYNTHETIC children and rejects the same history when preparation is omitted',async()=>{
    const f=await fixture(true);
    try{
      const preparationRows=structuredClone(f.records.filter(row=>[lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind].includes(row.kind))),goBefore=f.nativeEvents.filter(event=>event==='GO').length,store=await owner(f),run=coordinator(f,store);
      expect(preparationRows.filter(row=>row.kind===lamaPreparationCaptureKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(preparationRows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
      expect((await dispatch(f,run.executor)).state).toBe('SUCCEEDED');const first=(await journalView(f))!,rows=structuredClone(f.records);
      const next=await owner(f),restored=await next.capabilities().lookup(binding(f),f.capture);expect(restored!.records.map(row=>row.recordDigest)).toEqual(first.records.map(row=>row.record.recordDigest));expect(ordered((await journalView(f))!)).toEqual(ordered(first));
      expect(f.records.filter(row=>[lamaPreparationCaptureKind,lamaPreparationPrecheckKind,lamaPreparationJoinKind].includes(row.kind))).toEqual(preparationRows);expect(putCount(f)).toBe(1);expect(f.nativeEvents.filter(event=>event==='GO')).toHaveLength(goBefore);
      const Constructor=await owningClass(),without=new Constructor({db:f.db,root:f.root,input:f.input,capture:f.capture,fullStageCapture:f.full,claim:f.claim,binding:binding(f),bounds:ownerBounds()});
      await expect(without.capabilities().lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect(f.records).toEqual(rows);expect(putCount(f)).toBe(1);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);
    }finally{f.gateway!.stopClaims();await f.gateway!.idle();}
  });
  it('reattaches distinct owned copies to every matching original proposal record and preserves a conflicting descriptor as HOLD',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);
    await first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}));
    const second={...first.values.reply,evidenceId:randomUUID(),proposal:{...first.values.reply.proposal,bytes:Buffer.from(f.bytes)}};
    await first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:second}));
    const view=(await journalView(f))!,snapshot=(await (await owner(f)).capabilities().lookup(binding(f),f.capture))!,replies=snapshot.records.filter(row=>row.kind==='ENGINE_REPLY');
    expect(replies).toHaveLength(2);expect(snapshot.records.map(row=>row.recordDigest)).toEqual(view.records.map(row=>row.record.recordDigest));expect(replies[0].reply.proposal!.bytes).toEqual(f.bytes);expect(replies[1].reply.proposal!.bytes).toEqual(f.bytes);
    expect(replies[0].reply.proposal!.bytes).not.toBe(replies[1].reply.proposal!.bytes);replies[0].reply.proposal!.bytes.fill(0);expect(replies[1].reply.proposal!.bytes).toEqual(f.bytes);
    const restored=(await first.ports.lookup(binding(f),f.capture))!;for(const row of restored.records)if(row.kind==='ENGINE_REPLY')expect(row.reply.proposal!.bytes).toEqual(f.bytes);
    const conflicting=Buffer.from('different original raw'),third={...first.values.reply,evidenceId:randomUUID(),proposal:{sha256:sha256(conflicting),byteLength:conflicting.length,bytes:conflicting}};
    await expect(first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:third}))).rejects.toMatchObject(wait);
    const held=(await journalView(f))!;expect(held.holds).toContain('LOCAL_LAMA_ATTEMPT_PROPOSAL_CONFLICT');expect(held.records).toHaveLength(4);expect(putCount(f)).toBe(1);expect(rowsOf(f,lamaRawAllocationKind)).toHaveLength(1);
    await expect((await owner(f)).capabilities().lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect((await journalView(f))!.records).toEqual(held.records);
  });
  it('restores initial metadata-only history after original ACK loss or a legacy claim without granting another first submit',async()=>{
    for(const mode of ['ACK_LOSS','LEGACY'] as const){
      const f=await fixture(),store=await owner(f);
      if(mode==='ACK_LOSS'){f.control.lossKind='LAMA_ATTEMPT_ORIGINAL';await expect(store.capabilities().claim(binding(f),f.capture)).rejects.toBe(f.control.loss);}
      else await new LocalLaMaAttemptJournal(f.db,journalBounds()).claim(f.input,f.capture,f.full,f.claim);
      const next=await owner(f),first=await next.capabilities().claim(binding(f),f.capture),snapshot=await next.capabilities().lookup(binding(f),f.capture);
      expect(first).toMatchObject({created:false,records:[]});expect(snapshot).toEqual({version:1,original:first.original,records:[]});
      const run=coordinator(f,next);await expect(dispatch(f,run.executor)).rejects.toMatchObject(wait);expect(run.submit).not.toHaveBeenCalled();expect(run.query).toHaveBeenCalledTimes(1);
      expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);expect(rowsOf(f,lamaRawAllocationKind)).toEqual([]);expect(putCount(f)).toBe(0);expect(await readdir(f.root)).toEqual([]);
    }
  });
  it('never reissues allocation or PUT after an allocation commit ACK is lost',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);f.control.lossKind=lamaRawAllocationKind;
    await expect(first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}))).rejects.toBe(f.control.loss);
    const rows=structuredClone(f.records),allocation=recordValue(rowsOf(f,lamaRawAllocationKind)[0]);
    expect(rowsOf(f,lamaRawAllocationKind)).toHaveLength(1);expect(rowsOf(f,lamaRawReceiptKind)).toHaveLength(0);expect(putCount(f)).toBe(0);
    const next=await owner(f);await expect(next.capabilities().lookup(binding(f),f.capture)).rejects.toMatchObject(wait);await expect(next.capabilities().append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}))).rejects.toMatchObject(wait);
    expect(f.records).toEqual(rows);expect(recordValue(rowsOf(f,lamaRawAllocationKind)[0])).toEqual(allocation);expect(putCount(f)).toBe(0);expect(await readdir(f.root)).toEqual([]);
  });
  it('restores the original bytes and key after raw receipt commit ACK loss without another PUT',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);f.control.lossKind=lamaRawReceiptKind;
    await expect(first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}))).rejects.toBe(f.control.loss);
    const rows=structuredClone(f.records),next=await owner(f),restored=await next.capabilities().lookup(binding(f),f.capture),metadata=(await journalView(f))!;
    expect(restored!.records.map(row=>row.recordDigest)).toEqual(metadata.records.map(row=>row.record.recordDigest));const reply=restored!.records.find(row=>row.kind==='ENGINE_REPLY')!;if(reply.kind==='ENGINE_REPLY')expect(reply.reply.proposal!.bytes).toEqual(f.bytes);
    expect(f.records).toEqual(rows);expect(putCount(f)).toBe(1);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);expect(rowsOf(f,lamaRawAllocationKind)).toHaveLength(1);expect(rowsOf(f,lamaRawReceiptKind)).toHaveLength(1);
  });
  it('keeps original Coordinator START/provider/cost facts UNKNOWN after an allocation error and does not remove the durable HOLD',async()=>{
    const f=await fixture(),store=await owner(f),run=coordinator(f,store);f.control.lossKind=lamaRawAllocationKind;
    const result=await dispatch(f,run.executor);expect(result).toMatchObject({state:'UNKNOWN',providerSuccess:true,start:{captureDigest:f.capture.captureDigest},fullCost:{actualUsd:'0.125'},proposal:{sha256:sha256(f.bytes)}});expect(run.submit).toHaveBeenCalledTimes(1);expect(putCount(f)).toBe(0);
    const view=(await journalView(f))!,records=structuredClone(view.records);expect(view.holds.length).toBeGreaterThan(0);expect(view.records.map(row=>row.record.kind)).toEqual(expect.arrayContaining(['START','ENGINE_REPLY','HOLD','FULL_COST']));
    await expect((await owner(f)).capabilities().lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect((await journalView(f))!.records).toEqual(records);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);
  });
  it('owns constructor and call frames before SQL awaits, rejects changed binding, getters and proxies without invoking them',async()=>{
    const f=await fixture(),Constructor=await owningClass(),caller=options(f);caller.input=structuredClone(f.input);caller.capture=structuredClone(f.capture);caller.claim=structuredClone(f.claim);caller.binding=structuredClone(binding(f));caller.fullStageCapture=structuredClone(f.full);
    const store=new Constructor(caller),capturedBinding=structuredClone(caller.binding),capturedCapture=structuredClone(caller.capture);
    Object.assign(caller.input,{accountId:randomUUID(),inputDigest:sha256('changed')});Object.assign(caller.claim,{ownerId:randomUUID()});Object.assign(caller.capture,{imageSha256:sha256('changed')});Object.assign(caller.fullStageCapture,{captureDigest:sha256('changed')});caller.bounds.maxConcurrentCalls=1;
    f.control.gateAt=f.txCount()+1;const pending=store.capabilities().claim(capturedBinding,capturedCapture);await f.control.entered.promise;
    Object.assign(capturedBinding,{requestId:randomUUID()});Object.assign(capturedCapture,{profileId:'changed'});f.control.gate.resolve();const first=await pending;expect(first.created).toBe(true);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')[0].protected_observation).toMatchObject({accountId:f.input.accountId,executionId:f.input.executionId});
    const calls=f.accountTransaction.mock.calls.length;await expect(store.capabilities().lookup(capturedBinding,f.capture)).rejects.toMatchObject(wait);
    let getterCalls=0;const accessor=structuredClone(binding(f));Object.defineProperty(accessor,'inputDigest',{enumerable:true,get:()=>{getterCalls++;return f.input.inputDigest;}});await expect(store.capabilities().lookup(accessor,f.capture)).rejects.toMatchObject(wait);
    const trapped=proxy(binding(f));await expect(store.capabilities().lookup(trapped.value,f.capture)).rejects.toMatchObject(wait);
    const config=options(f);Object.defineProperty(config,'input',{enumerable:true,get:()=>{getterCalls++;return f.input;}});expect(()=>new Constructor(config)).toThrow();const trappedOptions=proxy(options(f));expect(()=>new Constructor(trappedOptions.value)).toThrow();
    expect(getterCalls).toBe(0);expect(trapped.calls()).toBe(0);expect(trappedOptions.calls()).toBe(0);expect(f.accountTransaction).toHaveBeenCalledTimes(calls);store.close();
  });
  it('binds actual readers privately and ignores later public prototype or db-method replacements',async()=>{
    const f=await fixture(),store=await owner(f),ports=store.capabilities(),replaced=vi.fn(()=>{throw Error('REPLACED_PUBLIC_AUTHORITY');}),databaseMethod=Object.getOwnPropertyDescriptor(f.db,'accountTransaction')!;
    const journal=vi.spyOn(LocalLaMaAttemptJournal.prototype,'claim').mockImplementation(replaced),raw=vi.spyOn(LocalLaMaRawStore.prototype,'prepareOriginal').mockImplementation(replaced),Constructor=await owningClass(),prototype=vi.spyOn(Constructor.prototype,'capabilities').mockImplementation(replaced);
    Object.defineProperty(f.db,'accountTransaction',{value:replaced,writable:true,configurable:true});
    try{expect(store.capabilities()).toBe(ports);const first=await ports.claim(binding(f),f.capture);expect(first.created).toBe(true);expect(first.records).toEqual([]);expect(replaced).not.toHaveBeenCalled();}
    finally{Object.defineProperty(f.db,'accountTransaction',databaseMethod);journal.mockRestore();raw.mockRestore();prototype.mockRestore();store.close();}
  });
  it('holds later same-owner lookup and metadata append until the actual PUT finishes, without a temporary HOLD',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);f.control.gateAt=f.txCount()+4;
    const append=first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}));await f.control.entered.promise;expect(putCount(f)).toBe(1);
    let lookupSettled=false,metadataSettled=false;const lookup=first.ports.lookup(binding(f),f.capture).then(value=>{lookupSettled=true;return value;}),cost={version:1 as const,bindingDigest:digest(binding(f)),fullStageCaptureDigest:f.full.captureDigest,closureEvidenceRef:'fake-whole-stage-closure',fullCost:first.values.fullCost};
    const metadata=first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'FULL_COST' as const,evidence:cost})).then(()=>{metadataSettled=true;});
    try{await Promise.resolve();await Promise.resolve();expect(lookupSettled).toBe(false);expect(metadataSettled).toBe(false);expect(rowsOf(f,'LAMA_ATTEMPT_METADATA').map(row=>recordValue(row).record)).not.toEqual(expect.arrayContaining([expect.objectContaining({kind:'HOLD'})]));}
    finally{f.control.gate.resolve();}
    await append;await metadata;const snapshot=await lookup;expect(snapshot!.records.map(row=>row.kind)).toEqual(expect.arrayContaining(['START','ENGINE_REPLY']));expect((await journalView(f))!.holds).toEqual([]);expect(putCount(f)).toBe(1);
  });
  it('keeps an accepted pending I/O reservation across close and rejects another call at the configured quota',async()=>{
    for(const phase of ['METADATA','PUT'] as const){
    const f=await fixture(),bounds=ownerBounds();bounds.maxConcurrentCalls=1;const store=await owner(f,{bounds}),first=await claimed(f,store);f.control.gateAt=f.txCount()+(phase==='METADATA'?1:4);
    const append=first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}));await f.control.entered.promise;
    expect(putCount(f)).toBe(phase==='METADATA'?0:1);
    const calls=f.accountTransaction.mock.calls.length,closeCount=rawCalls.filter(row=>row.account===f.input.accountId&&row.closed).length;
    try{await expect(first.ports.lookup(binding(f),f.capture)).rejects.toMatchObject({code:'LOCAL_LAMA_STORE_CAPACITY',nextAction:'WAIT'});store.close();await expect(first.ports.lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect(f.accountTransaction).toHaveBeenCalledTimes(calls);expect(rawCalls.filter(row=>row.account===f.input.accountId&&row.closed)).toHaveLength(closeCount);}
    finally{f.control.gate.resolve();}
    await append;expect(putCount(f)).toBe(1);expect(rowsOf(f,lamaRawReceiptKind)).toHaveLength(1);expect((await journalView(f))!.holds).toEqual([]);await expect(first.ports.claim(binding(f),f.capture)).rejects.toMatchObject(wait);
    expect((await (await owner(f)).capabilities().lookup(binding(f),f.capture))!.original).toEqual(first.first.original);
    }
  });
  it('retains a concurrent actual full-cost append then propagates the original raw allocation error to both operations',async()=>{
    for(const reason of [Error('RAW_COMMIT_ACK_LOST'),null,undefined]){
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);f.control.gateAt=f.txCount()+2;f.control.lossKind=lamaRawAllocationKind;f.control.loss=reason;
    const observe=(promise:Promise<void>)=>promise.then(()=>({state:'fulfilled' as const}),rejection=>({state:'rejected' as const,reason:rejection}));
    const append=first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply})),appendObserved=observe(append);await f.control.entered.promise;
    const cost={version:1 as const,bindingDigest:digest(binding(f)),fullStageCaptureDigest:f.full.captureDigest,closureEvidenceRef:'fake-whole-stage-closure',fullCost:first.values.fullCost},metadata=first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'FULL_COST' as const,evidence:cost})),metadataObserved=observe(metadata);
    f.control.gate.resolve();for(const outcome of [await appendObserved,await metadataObserved]){expect(outcome.state).toBe('rejected');if(outcome.state==='rejected')expect(outcome.reason).toBe(reason);}
    const view=(await journalView(f))!;expect(view.records.map(row=>row.record.kind)).toEqual(['START','ENGINE_REPLY','FULL_COST']);expect(view.records[2].record).toMatchObject({kind:'FULL_COST',evidence:cost});expect(view.holds).toEqual([]);
    expect(putCount(f)).toBe(0);expect(rowsOf(f,lamaRawAllocationKind)).toHaveLength(1);expect(rowsOf(f,lamaRawReceiptKind)).toHaveLength(0);await expect(first.ports.lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect((await journalView(f))!.records).toEqual(view.records);
    }
  });
  it('copies original engine bytes before metadata waits and rejects forged proposal descriptors without a new PUT',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store),value=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}),originalBytes=Buffer.from(value.reply.proposal.bytes);f.control.gateAt=f.txCount()+1;
    const pending=first.ports.append(binding(f),first.first.original,value);await f.control.entered.promise;value.reply.proposal.bytes.fill(7);Object.assign(value.reply.proposal,{sha256:sha256('changed')});f.control.gate.resolve();await pending;
    const next=await first.ports.lookup(binding(f),f.capture),reply=next!.records.find(row=>row.kind==='ENGINE_REPLY')!;if(reply.kind==='ENGINE_REPLY')expect(reply.reply.proposal!.bytes).toEqual(originalBytes);
    const forged=record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:{...first.values.reply,proposal:{sha256:sha256('forged'),byteLength:f.bytes.length,bytes:Buffer.from(f.bytes)}}}),calls=f.accountTransaction.mock.calls.length;
    await expect(first.ports.append(binding(f),first.first.original,forged)).rejects.toMatchObject(wait);expect(putCount(f)).toBe(1);expect(f.accountTransaction).toHaveBeenCalledTimes(calls);
  });
  it('closes a real unconsumed OPEN raw publication after a pre-allocation capacity failure and never republishes it',async()=>{
    const f=await fixture(),store=await owner(f),first=await claimed(f,store);allocationFailures.add(f.input.accountId!);
    try{await expect(first.ports.append(binding(f),first.first.original,record({version:1 as const,kind:'ENGINE_REPLY' as const,reply:first.values.reply}))).rejects.toMatchObject({code:'LOCAL_LAMA_RAW_CAPACITY',nextAction:'WAIT'});}
    finally{allocationFailures.delete(f.input.accountId!);}
    const closed=rawCalls.filter(row=>row.account===f.input.accountId&&row.operation==='CLOSE_PUBLICATION'&&row.closed);
    expect(closed).toHaveLength(1);expect(closed[0].before).toMatchObject({publications:1,allocations:0,pendingPuts:0,io:0});expect(closed[0].before.metadataBytes).toBeGreaterThan(0);expect(closed[0].after).toMatchObject({publications:0,allocations:0,pendingPuts:0,io:0,metadataBytes:0,rawBytes:0});
    expect(putCount(f)).toBe(0);expect(rowsOf(f,'LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);expect(rowsOf(f,lamaRawAllocationKind)).toHaveLength(0);expect(rowsOf(f,'LAMA_ATTEMPT_METADATA').map(row=>(recordValue(row).record as {kind:string}).kind)).toEqual(['START','ENGINE_REPLY']);
    const rows=structuredClone(f.records);store.close();expect(rawCalls.filter(row=>row.account===f.input.accountId&&row.operation==='CLOSE_PUBLICATION'&&row.closed)).toHaveLength(1);
    await expect((await owner(f)).capabilities().lookup(binding(f),f.capture)).rejects.toMatchObject(wait);expect(f.records).toEqual(rows);expect(await readdir(f.root)).toEqual([]);
  });
});
