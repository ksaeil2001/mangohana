import assert from 'node:assert/strict';
import {createPublicKey,sign,type KeyObject} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import canonicalize from 'canonicalize';
import {Database} from '../packages/storage/src/database.js';
import {FileObjectStore,type ObjectStore} from '../packages/storage/src/objects.js';
import {FontCatalog} from '../packages/media/src/fonts.js';
import {ProjectSigner} from '../packages/media/src/project-file.js';
import {SyntheticAuthProvider} from '../packages/domain/src/auth-provider.js';
import {validateDatabaseSecret} from '../packages/operations/src/runtime-startup.js';
import {createRuntime,type Runtime} from '../apps/api/src/runtime.js';
import {OperationalPipelineProvider} from '../packages/domain/src/operational-pipeline.js';
import {PipelineEvidence} from '../packages/domain/src/pipeline-evidence.js';
import {Assets} from '../packages/domain/src/assets.js';
import {NativeDatabaseGateway} from '../packages/domain/src/native-gateway.js';
import {NativeCapacityOperator,NativeCapacityStore,validateNativeCapacityConfiguration,type NativeCapacityConfiguration,type NativeCapacityProof} from '../packages/domain/src/native-capacity.js';
import {validateNativeJobObservation,type NativeJobIntent,type NativeJobClaim} from '../packages/domain/src/native-jobs.js';
import {validateExecutionLimitReference,validateOwnedExecutionLimitProfile,type ExecutionLimitReference} from '../packages/domain/src/execution-limits.js';
import {FullStageCostJournal} from '../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostPreparation,type FullStageCostPrepared} from '../packages/domain/src/full-stage-cost-preparation.js';
import {LocalLaMaNativePreparation} from '../packages/domain/src/local-lama-native-preparation.js';
import {LocalLaMaBindingReader} from '../packages/domain/src/local-lama-binding-reader.js';
import {LocalLaMaDomainAttemptStore} from '../packages/domain/src/local-lama-attempt-store.js';
import {LocalLaMaJournalCostReader,type LocalLaMaWholeStageClosureReader} from '../packages/domain/src/local-lama-cost-reader.js';
import {storedInput,canonicalInput,type StageInput,type ProviderAdapter} from '../packages/domain/src/provider.js';
import {syntheticProfile,type MediaProfile} from '../packages/media/src/profile.js';
import {NativeController} from '../packages/native/src/controller.js';
import type {NativeTask,NativeRunHooks,NativeJob,NativeComputation} from '../packages/native/src/dto.js';
import {LocalLaMaAdapter,type LocalLaMaCapture,type LocalLaMaExecutor} from '../packages/providers/src/local-lama.js';
import {LocalLaMaInvocationCoordinator} from '../packages/providers/src/local-lama-executor.js';
import {LocalLaMaExecutorRouter} from '../packages/providers/src/local-lama-executor-router.js';
import {localLaMaSupervisedEngine,type LocalLaMaSupervisorRuntime} from '../packages/providers/src/local-lama-supervised-engine.js';
import {lamaCodeCommit} from '../packages/providers/src/lama.js';
import {digest} from '../packages/contracts/src/intent.js';

export const owned03={profileId:'owned-one-cleanup-03-v1',sourceSha256:'c3bcc8c6d6ddebe71c78b4b0afa2334c33533a9ef8dc8462d1e56a317eee4583',width:663,height:937,selectedRegion:'ffcfa1ad-1da0-4e77-bd21-8e07f67e6ef6',maximumLaMaDispatches:1,maximumLaMaLookups:2,maximumNativeJobs:5,nativeMaximum:{DECODE_IMAGE:1,POLYGON_MASK:1,COMPOSITE_MASKED:2,RENDER_PAGE:1},automaticRetry:false} as const;
const journalBounds={maxRecordBytes:262144,maxRecords:32,maxInFlightBytes:512*1024*1024,maxConcurrentReads:4,calculator:{maxInputBytes:262144,maxOutputBytes:524288,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:8192}};
const calculatorBounds={maxInputBytes:2*1024*1024,maxOutputBytes:2*1024*1024,maxComponents:32,maxEvidenceRefs:32,maxStringBytes:8192};
const costBounds={maxRecordBytes:2*1024*1024,maxRecords:32,calculator:calculatorBounds};
const coordinatorBounds={maxEncodedBytes:4194304,maxMetadataBytes:262144,maxInFlightBytes:768*1024*1024,maxConcurrentCalls:2,maxRecords:32};
// This fixed local development assembly creates no production authority. Actual
// bootstrap/role/operator/native/model execution requires its own approved run.

type RegisteredOwned03={startup:Omit<import('../apps/api/src/runtime.js').ApiRuntimeOptions&import('../apps/api/src/runtime.js').WorkerRuntimeOptions,'profile'|'policy'|'provider'|'apiNative'|'workerNative'>;capacity:NativeCapacityConfiguration;executionLimit:ExecutionLimitReference;operatorClient:pg.Client;operatorLoginRole:string;nativePrivateKey:import('node:crypto').KeyObject;terminationReadClient:pg.Client;supervisorRuntime:LocalLaMaSupervisorRuntime;stateDirectory:string};
export async function assembleRegisteredOwned03Cleanup(resources:RegisteredOwned03){
  assert.equal(resources.startup.allowedAccounts.size,1,'OWNED_03_REQUIRES_EXACTLY_ONE_ACCOUNT');
  const accountId=[...resources.startup.allowedAccounts][0];
  validateExecutionLimitReference(resources.executionLimit);
  const {api,worker,fonts}=resources.startup,profile:MediaProfile={...syntheticProfile,id:owned03.profileId,minReadableFontSizePx:12};
  assert.equal(api.role,'trio_web_api');assert.equal(worker.role,'trio_web_worker');assert.notEqual(api,worker);
  const ownedCleanupInput={profileDigest:digest(profile),sourceImageSha256:owned03.sourceSha256,widthPx:663,heightPx:937};
  assert.equal(resources.executionLimit.kind,'OWNED_FIXTURE');assert.equal(resources.executionLimit.profileVersion,profile.id);
  const pending=new Set<Promise<unknown>>(),attempts:LocalLaMaDomainAttemptStore[]=[],engines:ReturnType<typeof localLaMaSupervisedEngine>[]=[],nativeRuns={DECODE_IMAGE:0,POLYGON_MASK:0,COMPOSITE_MASKED:0,RENDER_PAGE:0};
  let runtime:Runtime|undefined,currentInput:StageInput|undefined,currentClaim:NativeJobClaim|undefined,preparedFull:FullStageCostPrepared|undefined,currentCapture:LocalLaMaCapture|undefined,dispatches=0,lookups=0,admissionStopped=false,closed=false,closing:Promise<void>|null=null;
  let controller:NativeController|undefined;
  const requireOpen=()=>assert(!admissionStopped,'OWNED_03_ADMISSION_STOPPED');
  let identity:{accountId:string;requestId:string;executionId:string;inputDigest:string}|null=null;
  const ownIdentity=(input:StageInput)=>{assert.equal(input.accountId,accountId,'OWNED_03_ACCOUNT_MISMATCH');const next={accountId,requestId:input.requestId,executionId:input.executionId,inputDigest:input.inputDigest};if(identity)assert.deepEqual(next,identity,'OWNED_03_SECOND_REQUEST_FORBIDDEN');else identity=Object.freeze(next);};
  const close=()=>{admissionStopped=true;return closing??=(async()=>{const failures:unknown[]=[];try{runtime?.stopClaims();}catch(error){failures.push(error);}try{controller?.stopClaims();}catch(error){failures.push(error);}try{await runtime?.idle();}catch(error){failures.push(error);}await Promise.allSettled([...pending]);try{await controller?.idle();}catch(error){failures.push(error);}for(const engine of engines)if(engine.counts.supervisorLaunches>0&&!engine.counts.closed)failures.push(Error('LOCAL_LAMA_LIFETIME_UNCONFIRMED'));for(const attempt of [...attempts].reverse())try{attempt.close();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'OWNED_03_CLOSURE_UNCONFIRMED');closed=true;})();};
  try{
  const operator=new NativeCapacityOperator(resources.operatorClient,resources.operatorLoginRole);
  controller=NativeController.owned({profile,directoryRoot:resources.stateDirectory,limits:{maxMetadataBytes:2*1024*1024,maxInputBytes:64*1024*1024,maxOutputBytes:64*1024*1024,maxItems:64,childMemoryBytes:512*1024*1024,maxProcesses:16,timeoutMs:60000,terminationWaitMs:5000,parentInFlightBytes:512*1024*1024}});
  validateNativeCapacityConfiguration(resources.capacity,controller.profileDigest,controller.kernelImplementationDigest);
  assert.equal(resources.capacity.profile.maxSlots,1);assert.equal(createPublicKey(resources.nativePrivateKey).export({format:'der',type:'spki'}).toString('base64'),resources.capacity.profile.publicKeySpki);
  assert.equal(resources.capacity.profile.kind,'OWNED_FIXTURE');assert.equal(resources.capacity.profile.nativeProfileDigest,controller.profileDigest);assert.equal(resources.capacity.profile.kernelDigest,controller.kernelImplementationDigest);
  const nativeController=controller;
  const execute=Object.getOwnPropertyDescriptor(NativeController.prototype,'execute')!.value;
  Object.defineProperty(controller,'execute',{configurable:false,writable:false,value:async(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:NativeRunHooks,original?:NativeJob,startedAt?:number):Promise<NativeComputation>=>{
    requireOpen();if(task==='RENDER_PAGE')assert(engines.some(value=>value.counts.actualModelCalls===1&&value.counts.closed),'OWNED_03_RENDER_BEFORE_CLEANUP_FORBIDDEN');
    assert(hooks&&typeof hooks.intent==='function'&&typeof hooks.consumeGo==='function'&&typeof hooks.observation==='function'&&typeof hooks.termination==='function','UNBOUND_NATIVE_RUN_FORBIDDEN');
    assert(Object.hasOwn(owned03.nativeMaximum,task),'NATIVE_TASK_OUTSIDE_OWNED_03');assert(nativeRuns[task as keyof typeof nativeRuns]<owned03.nativeMaximum[task as keyof typeof nativeRuns],'OWNED_03_NATIVE_CAP_EXCEEDED');nativeRuns[task as keyof typeof nativeRuns]++;assert(Object.values(nativeRuns).reduce((n,v)=>n+v,0)<=5,'OWNED_03_NATIVE_TOTAL_CAP_EXCEEDED');
    return execute.call(controller,task,metadata,blobs,hooks,original,startedAt) as Promise<NativeComputation>;
  }});
  const track=<T>(promise:Promise<T>):Promise<T>=>{pending.add(promise);void promise.finally(()=>pending.delete(promise)).catch(()=>undefined);return promise;};
  const releaseObservedTerminations=async()=>{
    for(const db of [api,worker])for(const reservation of await new NativeCapacityStore(db,accountId).recover()){
      const rows=(await resources.terminationReadClient.query<{observation_id:string;observation_digest:string;database_digest:string;protected_observation:unknown}>("SELECT observation_id,observation_digest,encode(sha256(convert_to(protected_observation::text,'UTF8')),'hex') AS database_digest,protected_observation FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND event='TERMINATION'",[accountId,reservation.jobId])).rows;
      assert(rows.length<=1);if(!rows.length)continue;const row=rows[0],fact=validateNativeJobObservation(row.protected_observation),termination=fact.termination;assert.equal(row.database_digest,row.observation_digest);assert.equal(fact.code,'OK');assert.equal(fact.event,'TERMINATION');
      assert.equal(termination.kind,'DIRECT_CHILD_ONLY');assert.equal(termination.isolation,'OWNED_FIXTURE');assert.equal(termination.operationJoined,true);assert.equal(termination.directChildClosed,true);assert.equal(termination.subtreeTerminationConfirmed,false);assert.equal(termination.goAttempted,true);assert.equal(termination.startedComputation,true);
      const intent=reservation.protectedIntent as unknown as NativeJobIntent;assert.equal(intent.parentInstanceId,nativeController.parentInstanceId);assert.equal(intent.profileDigest,digest(profile));assert.equal(reservation.reference.profileId,resources.capacity.reference.profileId);assert(reservation.adoptionId);
      const proof:NativeCapacityProof={version:1,kind:'OWNED_FIXTURE',accountId:accountId,capacityReservationId:reservation.capacityReservationId,adoptionId:reservation.adoptionId,jobId:intent.jobId,inputDigest:intent.inputDigest,nativeProfileDigest:intent.profileDigest,parentInstanceId:intent.parentInstanceId,controllerId:resources.capacity.profile.controllerId,keyVersion:resources.capacity.profile.keyVersion,environmentDigest:resources.capacity.profile.environmentDigest,terminationObservationId:row.observation_id,terminationObservationDigest:row.observation_digest,goAttempted:termination.goAttempted,startedComputation:termination.startedComputation,operationJoined:true,directChildClosed:termination.directChildClosed,subtreeTerminationConfirmed:false,terminationKind:'DIRECT_CHILD_ONLY'};
      const canonical=canonicalize(proof);assert(canonical);const checked=await operator.confirm({canonical,signature:sign(null,Buffer.from(canonical),resources.nativePrivateKey).toString('base64')});assert(checked.proofId);await operator.release(proof.accountId,proof.capacityReservationId,checked.proofId);
    }
  };
  const store=resources.startup.objects,objects:ObjectStore={bucket:store.bucket,read:store.read.bind(store),receipt:store.receipt.bind(store),presence:store.presence?.bind(store),remove:async()=>{throw Error('OWNED_03_REMOVE_FORBIDDEN');},put:async(key,bytes)=>{const receipt=await store.put(key,bytes);await releaseObservedTerminations();return receipt;}};
  const nativePreparation=new LocalLaMaNativePreparation(worker,journalBounds,profile,controller.kernelImplementationDigest),bindingReader=new LocalLaMaBindingReader(worker,journalBounds),costJournal=new FullStageCostJournal(worker,costBounds),costPreparation=new FullStageCostPreparation(costJournal,[{stage:'CLEANUP',profileDigest:digest(profile),snapshot:null}],calculatorBounds);
  const router=new LocalLaMaExecutorRouter({maxRoutes:1,maxRetainedCoordinatorBytes:768*1024*1024,maxConcurrentCalls:2,maxInFlightBytes:768*1024*1024,maxEncodedBytes:4194304,maxMetadataBytes:262144});
  // No complete stage closure reader exists in this Product. Its absence keeps
  // full cost unknown; model return/direct exit cannot establish total cost.
  const wholeStageClosureUnavailable:LocalLaMaWholeStageClosureReader={lookup:async()=>null};
  const executor:LocalLaMaExecutor={dispatch:(value,onStarted)=>track((async()=>{
    requireOpen();
    assert(dispatches<1,'OWNED_03_MODEL_DISPATCH_CAP_EXCEEDED');dispatches++;assert(currentInput&&currentClaim&&preparedFull);assert.equal(currentInput.executionId,value.capture.executionId);assert.equal(value.capture.imageSha256,owned03.sourceSha256);assert.equal(value.capture.profileDigest,digest(profile));
    const binding=await bindingReader.readForDispatch(currentInput,value.capture,currentClaim);requireOpen();assert(binding);assert.equal(binding.fullStageCaptureDigest,preparedFull.basis.capture.captureDigest);currentCapture=value.capture;
    const raw={journal:journalBounds,maxRawBytes:4194304,maxInFlightMetadataBytes:1024*1024*1024,maxInFlightRawBytes:32*1024*1024,maxPublications:1,maxAllocations:1,maxPendingPuts:1,maxIo:4,maxMetadataCalls:4};
    const attempt=new LocalLaMaDomainAttemptStore({db:worker,root:path.join(resources.stateDirectory,'lama-raw'),input:currentInput,capture:value.capture,fullStageCapture:preparedFull.basis.capture,claim:currentClaim,binding,bounds:{raw,maxConcurrentCalls:2,maxOpenClaims:1,maxInFlightBytes:3*1024*1024*1024},preparation:nativePreparation});attempts.push(attempt);
    const engine=localLaMaSupervisedEngine({runtime:resources.supervisorRuntime,binding,capture:value.capture,attempts:attempt.capabilities()});engines.push(engine);
    const costs=new LocalLaMaJournalCostReader({input:currentInput,binding,capture:value.capture,journal:costJournal,closure:wholeStageClosureUnavailable,bounds:costBounds});
    const coordinator=new LocalLaMaInvocationCoordinator({binding,capture:value.capture,attempts:attempt.capabilities(),engine:engine.engine,costs,bounds:coordinatorBounds});
    router.register(binding,value.capture,coordinator,coordinatorBounds);return router.dispatch(value,onStarted);
  })()),lookup:capture=>track((async()=>{requireOpen();assert(lookups<2,'OWNED_03_MODEL_LOOKUP_CAP_EXCEEDED');lookups++;assert(currentCapture&&currentCapture.captureDigest===capture.captureDigest,'ORIGINAL_COORDINATOR_MISSING');return router.lookup(capture);})())};
  const lama=new LocalLaMaAdapter({enabled:true,identity:{codeCommit:lamaCodeCommit,weightsSha256:'fccb7adffd53ec0974ee5503c3731c2c2f1e7e07856fd9228cdcc0b46fd5d423',configSha256:'4fdeed49926e13b101c4dd9e193acec9e58677dfdb4ba49dd6a3a8927964e2a7',weightsLicenseVerified:true,runtimeVerified:true},profile,ownedCleanupInput,executor,bounds:{maxCapturedExecutions:1,maxInFlightBytes:768*1024*1024}});
  const unavailableNewText:ProviderAdapter={synthetic:false,dispatch:async()=>{throw Error('OWNED_03_NEW_OCR_TRANSLATION_FORBIDDEN');},lookup:async()=>{throw Error('OWNED_03_NEW_OCR_TRANSLATION_FORBIDDEN');}};
  const provider=new OperationalPipelineProvider({enabled:true,profile,ownedCleanupInput,fonts,assets:new Assets(worker,objects),journal:new PipelineEvidence(worker,{maxRecordBytes:2*1024*1024,maxRecords:32}),provider:unavailableNewText,lama,renderCost:{lookup:async()=>null},bounds:{maxEncodedStageBytes:64*1024*1024,maxMetadataBytes:2*1024*1024,maxInFlightBytes:768*1024*1024}});
  // Guard the concrete provider itself; no replacement provider or synthetic fallback.
  const validateInput=provider.validateInput.bind(provider),dispatch=provider.dispatch.bind(provider),lookup=provider.lookup.bind(provider),validateObservation=provider.validateObservation.bind(provider);
  provider.validateInput=(...args)=>{requireOpen();ownIdentity(args[0]);return track(validateInput(...args));};
  provider.dispatch=(...args)=>{requireOpen();ownIdentity(args[0]);return track(dispatch(...args));};
  provider.lookup=(...args)=>{requireOpen();if(args[1])ownIdentity(args[1]);return track(lookup(...args));};
  provider.validateObservation=(...args)=>{requireOpen();ownIdentity(args[0]);return track(validateObservation(...args));};
  const apiNative=new NativeDatabaseGateway(api,controller,objects,resources.capacity),workerNative=new NativeDatabaseGateway(worker,controller,objects,resources.capacity,nativePreparation);
  const policy={stageOrder:['CLEANUP'],synthetic:false,paidEnabled:false,realProviderEnabled:true,batchFailureAction:'WAIT' as const,paintInclusion:'ANY_OVERLAP' as const,manualFontBelowMinimum:'ALLOW' as const,parameterProfileVersion:profile.id,requiredAssetIds:[...fonts.catalog.fonts.map(font=>font.id),fonts.catalog.license.id],minReadableFontSizePx:12,executionLimit:resources.executionLimit};
  runtime=createRuntime({...resources.startup,objects,profile,policy,provider,apiNative,workerNative,workerExecutionHooks:{leaseMilliseconds:120000,heartbeatMilliseconds:10000,beforeValidateInput:async(input,claim)=>{
    requireOpen();ownIdentity(input);
    const original=await worker.accountTransaction(input.accountId!,tx=>storedInput(tx,input.executionId),true);assert.equal(digest(canonicalInput(input)),digest(canonicalInput(original)));assert.equal(input.stage,'CLEANUP');assert.equal(input.width,663);assert.equal(input.height,937);assert.equal(input.envelope!.parameterProfileVersion,profile.id);assert.equal(input.envelope!.costBoundUsd,'10');assert.equal(input.currentCleanedAssetId??null,null);assert.equal(input.scope.kind,'REGIONS');assert(input.scope.kind==='REGIONS'&&input.scope.regionIds.length===1&&input.scope.regionIds[0]===owned03.selectedRegion);assert.equal(input.assetDependencies?.find(asset=>asset.assetId===input.originalAssetId)?.sha256,owned03.sourceSha256);
    const block=(input.previousData??input.initialData).blocks.find(value=>value.regionId===owned03.selectedRegion);assert(block);assert.deepEqual(block.geometry.polygon,[{x:392,y:18},{x:432,y:18},{x:432,y:171},{x:392,y:171}]);
    preparedFull=await costPreparation.prepare(input,claim);const prepared=await nativePreparation.prepare(input,claim);assert(prepared.capture);assert.equal(prepared.capture.value.fullStageCaptureDigest,preparedFull.basis.capture.captureDigest);assert.equal(prepared.capture.value.profileDigest,digest(profile));currentInput=structuredClone(input);currentClaim=structuredClone(claim);
  }}});
  const originalStopClaims=runtime.stopClaims.bind(runtime);runtime.stopClaims=()=>{admissionStopped=true;originalStopClaims();nativeController.stopClaims();};
  return {runtime,provider,accountId:accountId,close,snapshot:()=>({mode:'OWNED_03_CLEANUP_REGISTERED_RESOURCES',sourceSha256:owned03.sourceSha256,profileKind:profile.kind,providerSynthetic:false,dispatches,lookups,nativeRuns:{...nativeRuns},supervisorLaunches:engines.reduce((n,engine)=>n+engine.counts.supervisorLaunches,0),actualLaMaCalls:engines.reduce((n,engine)=>n+engine.counts.actualModelCalls,0),fullCostVerification:'UNAVAILABLE',lastFullCost:null,fullStageClosureConfirmed:false,closed,fullPipelineEnabled:false})};
  }catch(error){try{await close();}catch(closeError){throw new AggregateError([error,closeError],'OWNED_03_PARTIAL_STARTUP_UNCONFIRMED');}throw error;}
}

// A prepared resource description is private caller input, never browser config.
// This candidate intentionally supplies no CREATE ROLE/GRANT, fixture creation,
// auth-session import, capacity registration or production activation CLI.
export type Owned03RegisteredConfiguration={
  sourceLabel:'STORED_GEMINI_OCR_REPLAY';stateDirectory:string;fontsDirectory:string;
  postgres:{directory:string;version:'18';api:{connectionString:string;loginRole:string};worker:{connectionString:string;loginRole:string};operator:{connectionString:string;loginRole:string};terminationReader:{connectionString:string;loginRole:string}};
  fixture:{accountId:string;bindingId:string;keyId:string;privateKey:KeyObject;limiterSecret:Buffer};
  capacity:NativeCapacityConfiguration;nativePrivateKey:KeyObject;executionLimit:ExecutionLimitReference;
  supervisorRuntime:LocalLaMaSupervisorRuntime;https:{key:Buffer;cert:Buffer};
};
export async function openRegisteredOwned03Cleanup(config:Owned03RegisteredConfiguration){
  assert.equal(config.sourceLabel,'STORED_GEMINI_OCR_REPLAY');assert.equal(config.postgres.version,'18');
  const tempRoot=path.resolve(tmpdir());
  for(const directory of [config.stateDirectory,config.postgres.directory,config.fontsDirectory,config.supervisorRuntime.root,config.supervisorRuntime.modelRoot]){
    const resolved=path.resolve(directory),relative=path.relative(tempRoot,resolved);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'OWNED_03_REQUIRES_TEMP_RESOURCES');const info=await lstat(resolved);assert(info.isDirectory()&&!info.isSymbolicLink());assert.equal((await realpath(resolved)).toLowerCase(),resolved.toLowerCase());
  }
  assert.match(config.fixture.accountId,/^[0-9a-f-]{36}$/);assert.match(config.fixture.bindingId,/^[0-9a-f-]{36}$/);assert.equal(config.fixture.privateKey.asymmetricKeyType,'ed25519');assert.equal(config.nativePrivateKey.asymmetricKeyType,'ed25519');assert.equal(config.fixture.limiterSecret.length,32);assert(config.https.key.length>0&&config.https.cert.length>0);
  const connections=Object.values({api:config.postgres.api,worker:config.postgres.worker,operator:config.postgres.operator,terminationReader:config.postgres.terminationReader}).map(value=>{const text=validateDatabaseSecret(value.connectionString,value.loginRole),url=new URL(text);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'OWNED_03_LOOPBACK_ONLY');return {text,url};});
  assert.equal(new Set(connections.map(value=>value.url.host+value.url.pathname)).size,1,'OWNED_03_DATABASE_IDENTITY_MISMATCH');assert.equal(new Set([config.postgres.api.loginRole,config.postgres.worker.loginRole,config.postgres.operator.loginRole,config.postgres.terminationReader.loginRole]).size,4);
  const ownedClosers:Array<()=>Promise<void>>=[];let assembly:Awaited<ReturnType<typeof assembleRegisteredOwned03Cleanup>>|undefined,closing:Promise<void>|null=null;
  const close=()=>closing??=(async()=>{const failures:unknown[]=[];try{await assembly?.close();}catch(error){failures.push(error);}for(const closer of [...ownedClosers].reverse())try{await closer();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'OWNED_03_OWNED_RESOURCES_CLOSE_UNCONFIRMED');})();
  try{
    const api=new Database(connections[0].text,undefined,'trio_web_api');ownedClosers.push(()=>api.close());
    const worker=new Database(connections[1].text,undefined,'trio_web_worker');ownedClosers.push(()=>worker.close());
    await api.validateServiceRole({serviceRole:'trio_web_api',loginRole:config.postgres.api.loginRole});await worker.validateServiceRole({serviceRole:'trio_web_worker',loginRole:config.postgres.worker.loginRole});
    const operatorClient=new pg.Client({connectionString:connections[2].text,application_name:'trio-owned-03-cleanup',connectionTimeoutMillis:5000});ownedClosers.push(()=>operatorClient.end());await operatorClient.connect();await operatorClient.query('SET ROLE trio_web_operator');
    const terminationReadClient=new pg.Client({connectionString:connections[3].text,application_name:'trio-owned-03-cleanup-read',connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on'});ownedClosers.push(()=>terminationReadClient.end());await terminationReadClient.connect();
    const operatorIdentity=(await operatorClient.query<{session_user:string;current_user:string}>('SELECT session_user,current_user')).rows[0];assert.equal(operatorIdentity.session_user,config.postgres.operator.loginRole);assert.equal(operatorIdentity.current_user,'trio_web_operator');
    const capacity=(await operatorClient.query<{profile_payload:unknown;profile_digest:string;profile_version:string;state:string}>('SELECT p.profile_payload,p.profile_digest,p.profile_version,a.state FROM manga_web.native_capacity_profiles p JOIN manga_web.native_capacity_authority a ON a.current_profile_id=p.profile_id WHERE p.profile_id=$1 AND a.singleton',[config.capacity.reference.profileId])).rows[0];assert(capacity);assert.equal(capacity.state,'OPEN');assert.equal(capacity.profile_digest,config.capacity.reference.profileDigest);assert.equal(capacity.profile_version,config.capacity.reference.profileVersion);assert.deepEqual(capacity.profile_payload,config.capacity.profile);
    const limit=(await operatorClient.query<{profile_payload:unknown;profile_digest:string;profile_version:string;state:string}>('SELECT p.profile_payload,p.profile_digest,p.profile_version,a.state FROM manga_web.execution_limit_profiles p JOIN manga_web.execution_limit_authority a ON a.current_profile_id=p.profile_id WHERE p.profile_id=$1 AND a.singleton',[config.executionLimit.profileId])).rows[0];assert(limit);assert.equal(limit.state,'OPEN');assert.equal(limit.profile_digest,config.executionLimit.profileDigest);assert.equal(limit.profile_version,owned03.profileId);
    const limitProfile=validateOwnedExecutionLimitProfile(limit.profile_payload);assert.equal(limitProfile.maxSlots,1);assert.deepEqual(Object.keys(limitProfile.stages),['CLEANUP']);assert.equal(limitProfile.fullBoundUsd,'10');assert.equal(limitProfile.stages.CLEANUP.boundUsd,'10');assert.equal(limitProfile.stages.CLEANUP.component,'STAGE_TOTAL');
    const fonts=await FontCatalog.load(config.fontsDirectory),objects=new FileObjectStore(path.join(config.stateDirectory,'private-objects'),syntheticProfile.maxZipBytes),signer=new ProjectSigner(api,'trio-local-synthetic',config.fixture.keyId,config.fixture.privateKey);
    const client=await api.pool.connect();
    try{
      await client.query('BEGIN READ ONLY');await client.query("SELECT set_config('trio.account_id',$1,true)",[config.fixture.accountId]);
      const account=(await client.query<{access_state:string}>('SELECT access_state FROM manga_web.accounts WHERE account_id=$1',[config.fixture.accountId])).rows[0];assert.equal(account?.access_state,'ACTIVE');
      const binding=(await client.query<{issuer:string;subject:string;method:string;state:string}>('SELECT issuer,subject,method,state FROM manga_web.login_bindings WHERE account_id=$1 AND binding_id=$2',[config.fixture.accountId,config.fixture.bindingId])).rows[0];assert.deepEqual(binding,{issuer:'https://synthetic.invalid',subject:'synthetic|EMAIL_OTP|local@example.invalid',method:'EMAIL_OTP',state:'ACTIVE'});
      const verifier=(await client.query<{issuer:string;algorithm:string;state:string;catalog_version:string;public_key:Buffer}>('SELECT issuer,algorithm,state,catalog_version,public_key FROM manga_web.signing_verifiers WHERE key_id=$1',[config.fixture.keyId])).rows[0];assert(verifier);assert.equal(verifier.issuer,'trio-local-synthetic');assert.equal(verifier.algorithm,'Ed25519');assert.equal(verifier.state,'ISSUING');assert.equal(verifier.catalog_version,'synthetic-v1');assert(verifier.public_key.equals(createPublicKey(config.fixture.privateKey).export({format:'der',type:'spki'}).subarray(-32)));
      const expected=[...fonts.catalog.fonts,fonts.catalog.license],assets=(await client.query<{asset_id:string;sha256:string;bytes_length:string;purpose:string;bucket_ref:string;object_key:string;verified_at:Date|null;deletion_state:string}>('SELECT asset_id,sha256,bytes_length,purpose,bucket_ref,object_key,verified_at,deletion_state FROM manga_web.assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[])',[config.fixture.accountId,expected.map(value=>value.id)])).rows;assert.equal(assets.length,expected.length);for(const font of expected){const asset=assets.find(value=>value.asset_id===font.id);assert(asset&&asset.sha256===font.sha256&&asset.bytes_length===font.bytesLength&&asset.purpose==='FONT'&&asset.bucket_ref===objects.bucket&&asset.object_key===config.fixture.accountId+'/'+font.id&&asset.verified_at!==null&&asset.deletion_state==='NOT_DUE');}
      await client.query('COMMIT');
    }catch(error){try{await client.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'OWNED_03_FACT_READ_UNCONFIRMED');}throw error;}finally{client.release();}
    // Supervisor re-verifies the immutable runtime/model file pins before its
    // first process creation. This startup does not run imports or inference.
    assembly=await assembleRegisteredOwned03Cleanup({startup:{api,worker,fonts,objects,signer,authProvider:new SyntheticAuthProvider(),allowedAccounts:new Set([config.fixture.accountId]),limiterSecret:Buffer.from(config.fixture.limiterSecret)},capacity:config.capacity,executionLimit:config.executionLimit,operatorClient,operatorLoginRole:config.postgres.operator.loginRole,nativePrivateKey:config.nativePrivateKey,terminationReadClient,supervisorRuntime:config.supervisorRuntime,stateDirectory:config.stateDirectory});
    return {...assembly,close,https:config.https,stateDirectory:config.stateDirectory};
  }catch(error){try{await close();}catch(closeError){throw new AggregateError([error,closeError],'OWNED_03_RESOURCE_STARTUP_UNCONFIRMED');}throw error;}
}

export async function verifyOwned03DevelopmentPaths(stateDirectory:string):Promise<string>{
  const resolved=path.resolve(stateDirectory),relative=path.relative(path.resolve(tmpdir()),resolved);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'OWNED_03_REQUIRES_TEMP_RESOURCES');
  const info=await lstat(resolved);assert(info.isDirectory()&&!info.isSymbolicLink());assert.equal((await realpath(resolved)).toLowerCase(),resolved.toLowerCase());
  const webRoot=path.join(resolved,'web');try{const web=await lstat(webRoot);assert(web.isDirectory()&&!web.isSymbolicLink());assert.equal((await realpath(webRoot)).toLowerCase(),webRoot.toLowerCase());}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  return webRoot;
}
