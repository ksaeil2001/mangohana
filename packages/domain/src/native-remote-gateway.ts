import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import type {ObjectStore} from '../../storage/src/objects.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {NativeFacade} from '../../native/src/facade.js';
import {NativeRemoteController,type NativeRemoteOriginalPort} from '../../native/src/controller-remote.js';
import {nativeJsonBytes,describeNativeBlobs,NativeJobError,type NativeJob,type NativeResult,type NativeComputation} from '../../native/src/dto.js';
import type {NativeGateway,NativeTarget} from '../../native/src/gateway.js';
import {validateNativeControllerBinding,type NativeControllerBinding,type NativeControllerSnapshot} from '../../native/src/controller-protocol.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,validateNativeJobClaim,validateNativeOwnerCapture,validateNativeJobObservation,type NativeJobIntent,type NativeJobObservation} from './native-jobs.js';
import {NativeReceiptStore,reconcileNativeLibraryObjects,type NativeReceiptProduced,type NativeReceiptSource} from './native-receipts.js';
import {validateNativeCapacityConfiguration,validateNativeSourceInput,type NativeCapacityConfiguration,type NativeCapacityAdmission} from './native-capacity.js';

type Original={intent:NativeJobIntent;job:NativeJob;binding?:NativeControllerBinding;produced?:NativeReceiptProduced};
type ObservationRow={observation_id:string;observation_digest:string;actual_digest:string;protected_observation:NativeJobObservation};
const hash=/^[a-f0-9]{64}$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sqlDigest="encode(sha256(convert_to(protected_observation::text,'UTF8')),'hex')";

// The API/worker owns its existing native intent and receipt permissions. It
// never uses controller SQL functions/LOGIN, consumes another GO, or grants an
// observation physical termination, settlement, publication or release power.
export class NativeRemoteDatabaseGateway implements NativeGateway{
  static costed(options:NativeCostedWindowsGatewayOptions):NativeCostedWindowsGateway{return new NativeCostedWindowsGateway(options);}
  static windows(db:Database,controller:NativeRemoteControllerV2,objects:ObjectStore,capacity:WindowsNativeCapacityConfiguration):NativeRemoteDatabaseGatewayV2{return new NativeRemoteDatabaseGatewayV2(db,controller,objects,capacity);}
  private readonly capacity:NativeCapacityConfiguration;
  private accepting=true;
  constructor(readonly db:Database,readonly controller:NativeRemoteController,readonly objects:ObjectStore,capacity:NativeCapacityConfiguration){
    requireCondition(typeof db.role==='string'&&['trio_web_api','trio_web_worker'].includes(db.role),'NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
    this.capacity=validateNativeCapacityConfiguration(capacity,controller.profileDigest,controller.kernelImplementationDigest);
  }
  private target(value:NativeTarget):NativeTarget{
    nativeJsonBytes(value,8192);const keys=['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim'];if(Object.hasOwn(value,'sourceInput'))keys.push('sourceInput');
    requireCondition(Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))&&uuid.test(value.accountId),'NATIVE_JOB_RECORD_INVALID',422,'WAIT');
    const target={...structuredClone(value),protectedOwnerCapture:validateNativeOwnerCapture(value.protectedOwnerCapture),claim:validateNativeJobClaim(value.claim),...(keys.length===7?{sourceInput:validateNativeSourceInput(value.sourceInput)}:{})};
    requireCondition(!target.sourceInput||['EXECUTION','REQUEST_CHECKPOINT'].includes(target.targetKind),'NATIVE_CAPACITY_INPUT_MISMATCH',409,'WAIT');
    nativeLogicalOperationKey({...target,task:'ZIP_WRITE',taskVersion:'native-pure-v1',profileDigest:this.controller.profileDigest,operationInputDigest:'0'.repeat(64)});return target;
  }
  private original(target:NativeTarget,job:NativeJob,parentInstanceId:string):Original{
    const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId,
      targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:target.protectedOwnerCapture,claim:target.claim};
    return {intent:{...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},job:structuredClone(job)};
  }
  private async owningIntent(accountId:string,original:Original):Promise<void>{
    await this.db.accountTransaction(accountId,async tx=>{
      const rows=(await tx.client.query<{intent_digest:string;actual_digest:string}>(`SELECT intent_digest,encode(sha256(convert_to(protected_intent::text,'UTF8')),'hex') AS actual_digest
        FROM manga_web.native_job_intents WHERE account_id=$1 AND job_id=$2 AND owner_service=$3 AND protected_intent=$4::jsonb`,[accountId,original.job.jobId,this.db.role,JSON.stringify(original.intent)])).rows;
      requireCondition(rows.length===1&&hash.test(rows[0].intent_digest)&&rows[0].intent_digest===rows[0].actual_digest,'NATIVE_INTENT_UNCONFIRMED',409,'WAIT');
    },true);
  }
  private async attest(accountId:string,original:Original,binding:NativeControllerBinding,result:NativeResult,snapshot:NativeControllerSnapshot):Promise<void>{
    requireCondition(original.binding&&digest(original.binding)===digest(binding)&&snapshot.rawResult?.resultDigest===digest(result)&&snapshot.termination,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
    await this.owningIntent(accountId,original);
    const produced=await this.db.accountTransaction(accountId,async tx=>{
      const go=(await tx.client.query('SELECT job_id FROM manga_web.native_job_go_consumptions WHERE account_id=$1 AND job_id=$2 AND parent_instance_id=$3',[accountId,original.job.jobId,original.intent.parentInstanceId])).rows;
      requireCondition(go.length===1,'NATIVE_GO_UNCONFIRMED',409,'WAIT');
      const resultRows=(await tx.client.query<ObservationRow>(`SELECT observation_id,observation_digest,${sqlDigest} AS actual_digest,protected_observation
        FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND parent_instance_id=$3 AND event='RESULT'
        AND protected_observation->>'code'='OK' AND protected_observation->>'resultDigest'=$4 ORDER BY received_at,observation_id LIMIT 2`,[accountId,original.job.jobId,original.intent.parentInstanceId,digest(result)])).rows;
      const termRows=(await tx.client.query<ObservationRow>(`SELECT observation_id,observation_digest,${sqlDigest} AS actual_digest,protected_observation
        FROM manga_web.native_job_observations WHERE account_id=$1 AND job_id=$2 AND parent_instance_id=$3 AND event='TERMINATION'
        AND protected_observation->>'code'='OK' AND (protected_observation->'termination')-'isolation'=$4::jsonb
        ORDER BY received_at,observation_id LIMIT 2`,[accountId,original.job.jobId,original.intent.parentInstanceId,JSON.stringify(snapshot.termination)])).rows;
      requireCondition(resultRows.length===1&&termRows.length===1,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
      for(const row of [...resultRows,...termRows]){
        const observation=validateNativeJobObservation(row.protected_observation),term=observation.termination;
        requireCondition(uuid.test(row.observation_id)&&hash.test(row.observation_digest)&&row.observation_digest===row.actual_digest&&observation.parentInstanceId===original.intent.parentInstanceId&&term.jobId===original.job.jobId&&term.inputDigest===original.job.inputDigest&&term.profileDigest===original.job.profileDigest&&term.isolation===this.controller.observationIsolation,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
      }
      const {isolation:_isolation,...termination}=termRows[0].protected_observation.termination;
      return {intent:structuredClone(original.intent),job:structuredClone(original.job),result:structuredClone(result),resultObservationId:resultRows[0].observation_id,resultObservationDigest:resultRows[0].observation_digest,termination};
    },true);
    original.produced=produced;
  }
  forTarget(value:NativeTarget):NativeFacade{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const target=this.target(value),jobs=new NativeJobStore(this.db,target.accountId),originals=new Map<string,Original>();
    const capacity:NativeCapacityAdmission={...this.capacity,...(target.sourceInput?{sourceInput:target.sourceInput}:{})};
    const port:NativeRemoteOriginalPort={accountId:target.accountId,admit:async job=>{
      const original=this.original(target,job,this.controller.parentInstanceId);originals.set(job.jobId,original);
      const decision=await jobs.beforeIntent(original.intent,true,capacity);
      requireCondition(typeof decision.capacityReservationId==='string'&&uuid.test(decision.capacityReservationId),'NATIVE_CAPACITY_RESERVATION_UNCONFIRMED',409,'WAIT');
      original.binding={accountId:target.accountId,capacityReservationId:decision.capacityReservationId,jobId:job.jobId,parentInstanceId:original.intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:this.controller.kernelImplementationDigest};return structuredClone(original.binding);
    },attest:async(job,binding,result,snapshot)=>{const original=originals.get(job.jobId);requireCondition(original&&digest(original.job)===digest(job),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');await this.attest(target.accountId,original,binding,result,snapshot);}};
    const source:NativeReceiptSource=(task,metadata,inputs)=>{
      const refs=describeNativeBlobs(inputs,this.controller.frameLimits('input')),original=[...originals.values()].find(item=>item.job.task===task&&digest(item.job.metadata)===digest(metadata)&&digest(item.job.blobs)===digest(refs));
      if(!original)throw new DomainError('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
      if(!original.produced)throw new NativeJobError('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT',{jobId:original.job.jobId,inputDigest:original.job.inputDigest,profileDigest:this.controller.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'});
      return structuredClone(original.produced);
    };
    const cache=new NativeReceiptStore(this.db,this.objects,target,this.controller.kernelImplementationDigest,{input:this.controller.frameLimits('input'),output:this.controller.frameLimits('output')},source,async(produced,error)=>{
      await jobs.observe(randomUUID(),{version:1,parentInstanceId:produced.intent.parentInstanceId,event:'ERROR',code:error instanceof NativeJobError?error.code:'NATIVE_OUTPUT_INVALID',resultDigest:null,termination:{...produced.termination,isolation:this.controller.observationIsolation}});
    });
    return new NativeFacade(this.controller.forPort(port),undefined,cache);
  }
  // Explicit raw recovery requires the complete original frame and owning
  // target. It verifies DB facts and never admits, PREPAREs or sends another GO.
  // Callers still owe facade semantic checks/publication fences for these bytes.
  async queryOriginal(value:NativeTarget,job:NativeJob,bindingValue:NativeControllerBinding):Promise<{computation:NativeComputation;produced:NativeReceiptProduced}>{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const target=this.target(value),binding=validateNativeControllerBinding(bindingValue),original=this.original(target,job,binding.parentInstanceId);original.binding=binding;
    requireCondition(binding.accountId===target.accountId&&binding.jobId===job.jobId,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');await this.owningIntent(target.accountId,original);
    const port:NativeRemoteOriginalPort={accountId:target.accountId,admit:async()=>{throw new Error('Original QUERY has no admission authority');},attest:async(captured,reference,result,snapshot)=>{
      requireCondition(digest(captured)===digest(original.job),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');await this.attest(target.accountId,original,reference,result,snapshot);
    }};
    const computation=await this.controller.queryOriginal(port,job,binding);requireCondition(original.produced,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');return {computation,produced:structuredClone(original.produced)};
  }
  stopClaims():void{this.accepting=false;this.controller.stopClaims();}
  async idle():Promise<void>{await this.controller.idle();if(!this.accepting)await this.controller.shutdown();}
  async maintenance(accountId:string):Promise<void>{await reconcileNativeLibraryObjects(this.db,this.objects,accountId,this.controller.frameLimits('output'));}
}


import {AsyncLocalStorage} from 'node:async_hooks';
import {type NativeRemoteControllerV2,type NativeRemoteOriginalPortV2} from '../../native/src/controller-remote.js';
import type {NativeControllerSnapshotV2} from '../../native/src/controller-protocol.js';
import type {WindowsNativeCapacityConfiguration} from './native-capacity.js';
import {readWindowsNativeOriginal,type NativeReceiptProducedV2,type NativeReceiptSourceV2} from './native-receipts.js';

type OriginalV2={intent:NativeJobIntent;job:NativeJob;binding?:NativeControllerBinding;produced?:NativeReceiptProducedV2};
type GatewayScope={open:boolean;children:Set<Promise<unknown>>};
const facadeCalls=['decodeImage','renderPageDetailed','renderPage','binaryPolygonMask','syntheticCleanup','compositeMaskedPixels','prepareScopedMaterial','applyScopedProposal','readZip','writeZip'] as const;

// Windows 원격 결과는 원 공개 DB 기록과 대조한 뒤 부모 검사를 거쳐 저장한다.
export class NativeRemoteDatabaseGatewayV2 implements NativeGateway{
  private readonly capacity:WindowsNativeCapacityConfiguration;
  private accepting=true;
  private readonly active=new Set<Promise<unknown>>();
  private readonly scopes=new AsyncLocalStorage<GatewayScope>();
  constructor(readonly db:Database,readonly controller:NativeRemoteControllerV2,readonly objects:ObjectStore,capacity:WindowsNativeCapacityConfiguration){
    requireCondition(typeof db.role==='string'&&['trio_web_api','trio_web_worker'].includes(db.role),'NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
    const captured=validateNativeCapacityConfiguration(capacity,controller.profileDigest,controller.kernelImplementationDigest);
    requireCondition(controller.protocolVersion===2&&controller.observationIsolation==='WINDOWS_JOB_OBJECT'&&captured.profile.kind==='WINDOWS_JOB_OBJECT'&&captured.reference.kind==='WINDOWS_JOB_OBJECT','NATIVE_CAPACITY_PROFILE_MISMATCH',409,'WAIT');
    requireCondition(captured.profile.windows.pins.nativeLimitsDigest===controller.nativeLimitsDigest,'NATIVE_CAPACITY_PROFILE_MISMATCH',409,'WAIT');
    this.capacity=captured as WindowsNativeCapacityConfiguration;
  }
  protected target(value:NativeTarget):NativeTarget{
    nativeJsonBytes(value,8192);const keys=['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim'];if(Object.hasOwn(value,'sourceInput'))keys.push('sourceInput');
    const descriptors=Object.getOwnPropertyDescriptors(value);
    requireCondition(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key])&&uuid.test(value.accountId),'NATIVE_JOB_RECORD_INVALID',422,'WAIT');
    const target={...structuredClone(value),protectedOwnerCapture:validateNativeOwnerCapture(value.protectedOwnerCapture),claim:validateNativeJobClaim(value.claim),...(keys.length===7?{sourceInput:validateNativeSourceInput(value.sourceInput)}:{})};
    requireCondition(target.sourceInput!==undefined&&['EXECUTION','REQUEST_CHECKPOINT'].includes(target.targetKind),'NATIVE_CAPACITY_INPUT_MISMATCH',409,'WAIT');
    nativeLogicalOperationKey({...target,task:'ZIP_WRITE',taskVersion:'native-pure-v1',profileDigest:this.controller.profileDigest,operationInputDigest:'0'.repeat(64)});return target;
  }
  protected original(target:NativeTarget,job:NativeJob,parentInstanceId:string):OriginalV2{
    const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId,
      targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:target.protectedOwnerCapture,claim:target.claim};
    return {intent:{...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},job:structuredClone(job)};
  }
  protected async owningIntent(accountId:string,original:OriginalV2):Promise<void>{
    await this.db.accountTransaction(accountId,async tx=>{
      const rows=(await tx.client.query<{intent_digest:string;actual_digest:string}>(`SELECT intent_digest,encode(sha256(convert_to(protected_intent::text,'UTF8')),'hex') AS actual_digest
        FROM manga_web.native_job_intents WHERE account_id=$1 AND job_id=$2 AND owner_service=$3 AND protected_intent=$4::jsonb LIMIT 2`,[accountId,original.job.jobId,this.db.role,JSON.stringify(original.intent)])).rows;
      requireCondition(rows.length===1&&hash.test(rows[0].intent_digest)&&rows[0].intent_digest===rows[0].actual_digest,'NATIVE_INTENT_UNCONFIRMED',409,'WAIT');
    },true);
  }
  protected async attest(target:NativeTarget,original:OriginalV2,binding:NativeControllerBinding,result:NativeResult,snapshot:NativeControllerSnapshotV2):Promise<void>{
    requireCondition(original.binding&&digest(original.binding)===digest(binding)&&snapshot.windowsEvidenceRef&&snapshot.termination&&snapshot.rawResult?.resultDigest===digest(result),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
    const facts=await readWindowsNativeOriginal(this.db,original.job,binding,snapshot.windowsEvidenceRef,{input:this.controller.frameLimits('input'),output:this.controller.frameLimits('output')});
    requireCondition(digest(facts.intent)===digest(original.intent)&&digest(facts.sourceInput)===digest(target.sourceInput)&&digest(facts.rawResult)===digest(snapshot.rawResult)&&digest(facts.termination)===digest(snapshot.termination)&&facts.resultObservation?.value.resultDigest===digest(result),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
    original.produced={intent:structuredClone(facts.intent),job:structuredClone(original.job),result:structuredClone(result),sourceInput:structuredClone(facts.sourceInput),windowsEvidenceRef:structuredClone(facts.windowsEvidenceRef),
      resultObservationId:facts.resultObservation.evidenceId,resultObservationDigest:facts.resultObservation.evidenceDigest,terminationObservationId:facts.terminationObservation.evidenceId,terminationObservationDigest:facts.terminationObservation.evidenceDigest,termination:structuredClone(facts.termination)};
  }
  private track<T>(operation:()=>Promise<T>):Promise<T>{
    const scope=this.scopes.getStore();
    if(scope?.open){const child=Promise.resolve().then(operation);scope.children.add(child);void child.then(()=>scope.children.delete(child),()=>scope.children.delete(child));return child;}
    if(!this.accepting)return Promise.reject(new DomainError('NATIVE_SHUTDOWN_WAIT',409,'WAIT'));
    const root:GatewayScope={open:true,children:new Set()};
    const work=Promise.resolve().then(()=>this.scopes.run(root,async()=>{try{return await operation();}finally{while(root.children.size)await Promise.allSettled([...root.children]);root.open=false;}}));
    this.active.add(work);void work.then(()=>this.active.delete(work),()=>this.active.delete(work));return work;
  }
  private wrapAsync(value:object,names:readonly string[]):void{
    for(const name of names){const original=Reflect.get(value,name);requireCondition(typeof original==='function','NATIVE_REMOTE_PORT_UNCONFIRMED',409,'WAIT');
      Object.defineProperty(value,name,{configurable:true,value:(...args:unknown[])=>this.track(()=>Reflect.apply(original,value,args) as Promise<unknown>)});
    }
  }
  private wrapFacade(facade:NativeFacade):NativeFacade{
    this.wrapAsync(facade,facadeCalls);const withHooks=facade.withHooks;
    Object.defineProperty(facade,'withHooks',{value:(hooks:Parameters<NativeFacade['withHooks']>[0])=>this.wrapFacade(withHooks.call(facade,hooks))});return facade;
  }

  forTarget(value:NativeTarget):NativeFacade{
    requireCondition(this.accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');const target=this.target(value),jobs=new NativeJobStore(this.db,target.accountId),originals=new Map<string,OriginalV2>();
    const capacity:NativeCapacityAdmission={...this.capacity,sourceInput:target.sourceInput};
    const port:NativeRemoteOriginalPortV2={accountId:target.accountId,admit:async job=>{
      const original=this.original(target,job,this.controller.parentInstanceId);
      const decision=await jobs.beforeIntent(original.intent,true,capacity);
      requireCondition(typeof decision.capacityReservationId==='string'&&uuid.test(decision.capacityReservationId),'NATIVE_CAPACITY_RESERVATION_UNCONFIRMED',409,'WAIT');
      original.binding={accountId:target.accountId,capacityReservationId:decision.capacityReservationId,jobId:job.jobId,parentInstanceId:original.intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:this.controller.kernelImplementationDigest};originals.set(job.jobId,original);return structuredClone(original.binding);
    },attest:async(job,binding,result,snapshot)=>{const original=originals.get(job.jobId);requireCondition(original&&digest(original.job)===digest(job),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');await this.attest(target,original,binding,result,snapshot);}};
    const source:NativeReceiptSourceV2=(task,metadata,inputs,computation)=>{
      const refs=describeNativeBlobs(inputs,this.controller.frameLimits('input')),output=describeNativeBlobs(computation.blobs,this.controller.frameLimits('output'));
      const matches=[...originals.values()].filter(item=>item.produced&&item.job.task===task&&digest(item.job.metadata)===digest(metadata)&&digest(item.job.blobs)===digest(refs)&&digest(item.produced.result.metadata)===digest(computation.metadata)&&digest(item.produced.result.blobs)===digest(output));
      requireCondition(matches.length===1&&matches[0].produced,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');return structuredClone(matches[0].produced);
    };
    const cache=NativeReceiptStore.windows(this.db,this.objects,target,this.controller.kernelImplementationDigest,{input:this.controller.frameLimits('input'),output:this.controller.frameLimits('output')},source);
    const capturedRunner=this.controller.forPort(port);
    const runner:import('../../native/src/dto.js').NativeRunner={...(capturedRunner.supportsParentHooks?{supportsParentHooks:capturedRunner.supportsParentHooks}:{}),run:(task,metadata,blobs,hooks)=>this.track(()=>capturedRunner.run(task,metadata,blobs,hooks))};
    this.wrapAsync(cache,['read','seal','onValidationFailure']);
    return this.wrapFacade(new NativeFacade(runner,undefined,cache));
  }
  queryOriginal(value:NativeTarget,job:NativeJob,bindingValue:NativeControllerBinding):Promise<{computation:NativeComputation;produced:NativeReceiptProducedV2}>{
    return this.track(async()=>{
      const target=this.target(value),binding=validateNativeControllerBinding(bindingValue),original=this.original(target,job,binding.parentInstanceId);original.binding=binding;
      requireCondition(binding.accountId===target.accountId&&binding.jobId===job.jobId,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');await this.owningIntent(target.accountId,original);
      const port:NativeRemoteOriginalPortV2={accountId:target.accountId,admit:async()=>{throw new DomainError('NATIVE_INTENT_UNCONFIRMED',409,'WAIT');},attest:async(captured,reference,result,snapshot)=>{
        requireCondition(digest(captured)===digest(original.job),'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');await this.attest(target,original,reference,result,snapshot);
      }};
      const computation=await this.controller.queryOriginal(port,job,binding);requireCondition(original.produced,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');return {computation,produced:structuredClone(original.produced)};
    });
  }
  readOriginalMetadata(value:NativeTarget,job:NativeJob,bindingValue:NativeControllerBinding):Promise<NativeControllerSnapshotV2>{
    return this.track(async()=>{
      const target=this.target(value),binding=validateNativeControllerBinding(bindingValue),original=this.original(target,job,binding.parentInstanceId);original.binding=binding;
      requireCondition(binding.accountId===target.accountId&&binding.jobId===job.jobId,'NATIVE_CONTROL_BINDING_MISMATCH',409,'WAIT');await this.owningIntent(target.accountId,original);
      const port:NativeRemoteOriginalPortV2={accountId:target.accountId,admit:async()=>{throw new DomainError('NATIVE_INTENT_UNCONFIRMED',409,'WAIT');},attest:async()=>{throw new DomainError('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');}};
      const snapshot=await this.controller.readOriginalMetadata(port,job,binding);
      if(snapshot.windowsEvidenceRef){
        const facts=await readWindowsNativeOriginal(this.db,job,binding,snapshot.windowsEvidenceRef,{input:this.controller.frameLimits('input'),output:this.controller.frameLimits('output')});
        requireCondition(digest(facts.intent)===digest(original.intent)&&digest(facts.sourceInput)===digest(target.sourceInput)&&digest(facts.rawResult)===digest(snapshot.rawResult)&&digest(facts.termination)===digest(snapshot.termination),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
      }
      return structuredClone(snapshot);
    });
  }
  stopClaims():void{this.accepting=false;this.controller.stopClaims();}
  async idle():Promise<void>{while(this.active.size)await Promise.allSettled([...this.active]);await this.controller.idle();if(!this.accepting)await this.controller.shutdown();}
}


import {types as costTypes} from 'node:util';
import {createCostedRemoteOriginalPortV2} from '../../native/src/controller-remote.js';
import {createNativeJob,type NativeTask,type NativeRunner,type NativeRunHooks} from '../../native/src/dto.js';
import {captureWindowsCostedObjectIo} from './native-receipts.js';
import {WindowsNativeCostJournal,isWindowsNativeCostJournal,validateWindowsNativeCostOwner,validateWindowsNativeCostCall,type WindowsNativeCostOwner,type WindowsNativeCostScope,type WindowsNativeCostCall,type WindowsNativeCostComponent,type WindowsCostedObjectIo,type WindowsNativeCostRef} from './windows-native-cost.js';
import type {NativeExecutionPhase} from './native-execution-wait.js';
export type NativeCostedWindowsGatewayOptions={db:Database;controller:NativeRemoteControllerV2;io:WindowsCostedObjectIo;capacity:WindowsNativeCapacityConfiguration;costs:WindowsNativeCostJournal;components:WindowsNativeCostComponent[]};
export type WindowsExecutionCostPorts=Readonly<{
  enrollInputIn(tx:Transaction,input:WindowsNativeCostRef):Promise<WindowsNativeCostRef|null>;
  activateRootIn(tx:Transaction,owner:WindowsNativeCostOwner):Promise<WindowsNativeCostRef|null>;
  forCostOwner(target:NativeTarget,owner:WindowsNativeCostOwner,phase:NativeExecutionPhase,validationTargetDigest:string|null):NativeFacade;
  unconfirmed(cause?:unknown):never;
}>;
const executionCostGateways=new WeakMap<NativeGateway,{db:Database;ports:WindowsExecutionCostPorts}>();
const executionContextWaits=new WeakMap<object,NativeGateway>();
const executionInfrastructureErrors=new WeakMap<object,WeakSet<NativeGateway>>();
// 원 DB·영수증 포트의 오류 신원만 보존하며 의미 검증 오류는 승격하지 않는다.
async function originalCostData<T>(gateway:NativeGateway,operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch(error){
    if(error!==null&&typeof error==='object'&&!(error instanceof DomainError)&&executionCostGateways.has(gateway)){
      let owners=executionInfrastructureErrors.get(error);if(!owners){owners=new WeakSet();executionInfrastructureErrors.set(error,owners);}owners.add(gateway);
    }
    throw error;
  }
}
export function isWindowsExecutionInfrastructureError(value:unknown,gateway:NativeGateway|undefined):boolean{
  return gateway!==undefined&&executionCostGateways.has(gateway)&&value!==null&&typeof value==='object'&&executionInfrastructureErrors.get(value)?.has(gateway)===true;
}
// 교체 가능한 공개 메서드 대신 원 journal 구현을 고정한다.
const executionJournalMethods=Object.freeze({enrollInputIn:WindowsNativeCostJournal.prototype.enrollInputIn,activateRootIn:WindowsNativeCostJournal.prototype.activateRootIn,
  beginScopeIn:WindowsNativeCostJournal.prototype.beginScopeIn,registerCallIn:WindowsNativeCostJournal.prototype.registerCallIn,admitIn:WindowsNativeCostJournal.prototype.admitIn,joinScopeIn:WindowsNativeCostJournal.prototype.joinScopeIn,
  recordIn:WindowsNativeCostJournal.prototype.recordIn,lookupScopeIn:WindowsNativeCostJournal.prototype.lookupScopeIn,authorizeResultQueryIn:WindowsNativeCostJournal.prototype.authorizeResultQueryIn,finishResultQueryIn:WindowsNativeCostJournal.prototype.finishResultQueryIn});
class WindowsExecutionContextWait extends DomainError{
  constructor(gateway:NativeGateway,cause?:unknown){
    super('WINDOWS_EXECUTION_CONTEXT_UNCONFIRMED',409,'WAIT');
    if(cause!==undefined)Object.defineProperty(this,'cause',{value:cause});executionContextWaits.set(this,gateway);Object.freeze(this);
  }
}
function costContextMust(gateway:NativeGateway,value:unknown):asserts value{if(!value)throw new WindowsExecutionContextWait(gateway);}
export function windowsExecutionCostPorts(gateway:NativeGateway,db:Database):WindowsExecutionCostPorts|null{
  const owned=executionCostGateways.get(gateway);return owned?.db===db?owned.ports:null;
}
export function isWindowsExecutionContextWait(value:unknown,gateway:NativeGateway|undefined):boolean{
  return gateway!==undefined&&typeof value==='object'&&value!==null&&executionContextWaits.get(value)===gateway;
}
type CostedCallState={call:WindowsNativeCostCall;cache:ReturnType<typeof NativeReceiptStore.windowsCosted>;original?:OriginalV2};
type CostedScopeState={scope:WindowsNativeCostScope;open:boolean;children:Set<Promise<unknown>>;calls:Map<string,CostedCallState>;terminalEvidence:WindowsNativeCostRef[]};
function costedMust(value:unknown):asserts value{requireCondition(value,'WINDOWS_NATIVE_COST_OWNER_UNCONFIRMED',409,'WAIT');}
function costAckUncertain(error:unknown):boolean{return !(error instanceof DomainError)&&!(typeof (error as {code?:unknown})?.code==='string'&&/^[0-9A-Z]{5}$/.test((error as {code:string}).code));}
async function sameCostRecordAck<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(!costAckUncertain(error))throw error;return await operation();}}
// Runtime-owned cost ports are explicit. No operational factory enables them.
export class NativeCostedWindowsGateway extends NativeRemoteDatabaseGatewayV2{
  private readonly costIo:WindowsCostedObjectIo;
  private readonly costs:WindowsNativeCostJournal;
  private readonly components:ReadonlyMap<NativeTask,string>;
  private readonly costScopes=new AsyncLocalStorage<CostedScopeState>();
  private readonly costActive=new Set<Promise<unknown>>();
  private costAccepting=true;
  private readonly costPorts:Pick<WindowsNativeCostJournal,'beginScopeIn'|'registerCallIn'|'admitIn'|'joinScopeIn'|'recordIn'|'lookupScopeIn'|'authorizeResultQueryIn'|'finishResultQueryIn'>;
  constructor(options:NativeCostedWindowsGatewayOptions){
    costedMust(options!==null&&typeof options==='object'&&!costTypes.isProxy(options));const descriptors=Object.getOwnPropertyDescriptors(options),keys=['db','controller','io','capacity','costs','components'];costedMust(Reflect.ownKeys(options).length===keys.length&&keys.every(k=>descriptors[k]?.enumerable&&'value'in descriptors[k]));
    const io=captureWindowsCostedObjectIo(options.io),fail=async():Promise<never>=>{throw new DomainError('WINDOWS_NATIVE_COST_SCOPE_REQUIRED',409,'WAIT');};
    super(options.db,options.controller,{bucket:io.bucket,read:fail,put:fail,receipt:fail,remove:fail},options.capacity);
    costedMust(options.db.role==='trio_web_worker'&&isWindowsNativeCostJournal(options.costs,options.db));
    nativeJsonBytes(options.components,16384);costedMust(Array.isArray(options.components)&&options.components.length>0&&options.components.length<=64);
    const components=new Map<NativeTask,string>();for(const value of options.components){const fields=Object.getOwnPropertyDescriptors(value);costedMust(Reflect.ownKeys(value).length===2&&fields.task?.enumerable&&'value'in fields.task&&fields.componentId?.enumerable&&'value'in fields.componentId&&typeof value.componentId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.componentId)&&!components.has(value.task));components.set(value.task,value.componentId);}
    this.costIo=io;this.costs=options.costs;this.components=components;this.capacityConfiguration=structuredClone(options.capacity);
    this.costPorts=Object.freeze({beginScopeIn:executionJournalMethods.beginScopeIn.bind(this.costs),registerCallIn:executionJournalMethods.registerCallIn.bind(this.costs),admitIn:executionJournalMethods.admitIn.bind(this.costs),joinScopeIn:executionJournalMethods.joinScopeIn.bind(this.costs),recordIn:executionJournalMethods.recordIn.bind(this.costs),lookupScopeIn:executionJournalMethods.lookupScopeIn.bind(this.costs),authorizeResultQueryIn:executionJournalMethods.authorizeResultQueryIn.bind(this.costs),finishResultQueryIn:executionJournalMethods.finishResultQueryIn.bind(this.costs)});
    const mapping=[...components].map(([task,componentId])=>Object.freeze({task,componentId}));Object.freeze(mapping);
    const enrollInputIn=Object.freeze(executionJournalMethods.enrollInputIn.bind(this.costs)),activateRootIn=executionJournalMethods.activateRootIn.bind(this.costs);
    const ports:WindowsExecutionCostPorts=Object.freeze({enrollInputIn,activateRootIn:Object.freeze((tx:Transaction,owner:WindowsNativeCostOwner)=>activateRootIn(tx,owner,mapping)),forCostOwner:Object.freeze(executionForCostOwner.bind(this)),unconfirmed:Object.freeze((cause?:unknown):never=>{throw new WindowsExecutionContextWait(this,cause);})});
    executionCostGateways.set(this,{db:options.db,ports});
  }
  override forTarget(_target:NativeTarget):NativeFacade{throw new DomainError('WINDOWS_NATIVE_COST_SCOPE_REQUIRED',409,'WAIT');}
  override async queryOriginal(_target:NativeTarget,_job:NativeJob,_binding:NativeControllerBinding):Promise<never>{throw new DomainError('WINDOWS_NATIVE_COST_SCOPE_REQUIRED',409,'WAIT');}
  private async costCall(target:NativeTarget,task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):Promise<CostedCallState>{
    const root=this.costScopes.getStore();costedMust(root?.open);const inputLimits=this.controller.frameLimits('input'),job=createNativeJob(task,digest(metadata.profile),metadata,inputs,inputLimits),operationInputDigest=nativeOperationInputDigest(job),key=digest({task,operationInputDigest});
    costedMust(!root.calls.has(key));const componentId=this.components.get(task);costedMust(componentId);
    const body={version:1 as const,callId:randomUUID(),scopeId:root.scope.scopeId,scopeDigest:root.scope.scopeDigest,task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,kernelDigest:this.controller.kernelImplementationDigest,operationInputDigest,componentId};
    const call=validateWindowsNativeCostCall({...body,callDigest:digest(body)});const registered=await sameCostRecordAck(()=>originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.registerCallIn(tx,root.scope,call))));costContextMust(this,registered&&digest(registered)===digest(call));
    const source:NativeReceiptSourceV2=(actualTask,actualMetadata,actualInputs,computation)=>{const actual=this.findCostCall(actualTask,actualMetadata,actualInputs).original;costedMust(actual?.produced&&actual.job.task===task&&digest(actual.produced.result.metadata)===digest(computation.metadata)&&digest(actual.produced.result.blobs)===digest(describeNativeBlobs(computation.blobs,this.controller.frameLimits('output'))));return structuredClone(actual.produced);};
    const cache=NativeReceiptStore.windowsCosted({db:this.db,io:this.costIo,target,kernelImplementationDigest:this.controller.kernelImplementationDigest,limits:{input:inputLimits,output:this.controller.frameLimits('output')},source,costs:this.costs,call});const state={call,cache};root.calls.set(key,state);return state;
  }
  private findCostCall(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):CostedCallState{
    const root=this.costScopes.getStore();costedMust(root?.open);const job=createNativeJob(task,digest(metadata.profile),metadata,inputs,this.controller.frameLimits('input')),state=root.calls.get(digest({task,operationInputDigest:nativeOperationInputDigest(job)}));costedMust(state);return state;
  }
  forCostOwner(targetValue:NativeTarget,ownerValue:WindowsNativeCostOwner,phase:NativeExecutionPhase,validationTargetDigest:string|null):NativeFacade{
    costedMust(this.costAccepting);const target=this.target(targetValue),owner=validateWindowsNativeCostOwner(ownerValue);
    const cache:import('../../native/src/semantic-cache.js').NativeSemanticCache={facadeVerificationVersion:importedFacadeVersion,kernelImplementationDigest:this.controller.kernelImplementationDigest,frameLimits:direction=>this.controller.frameLimits(direction),
      read:async(task,metadata,inputs)=>{const state=await this.costCall(target,task,metadata,inputs),decision=await originalCostData(this,()=>state.cache.read(task,metadata,inputs));if(phase==='LOOKUP'&&decision.state==='MISS')throw new WindowsExecutionContextWait(this);return decision;},
      seal:async(task,metadata,inputs,computation)=>{const state=this.findCostCall(task,metadata,inputs);return originalCostData(this,()=>state.cache.seal(task,metadata,inputs,computation));},
      onValidationFailure:async(task,metadata,inputs,computation,error)=>{const state=this.findCostCall(task,metadata,inputs);return originalCostData(this,()=>state.cache.onValidationFailure(task,metadata,inputs,computation,error));}};
    const runner:NativeRunner={supportsParentHooks:true,run:async(task,metadata,inputs,hooks)=>{
      if(phase==='LOOKUP')throw new WindowsExecutionContextWait(this);
      const root=this.costScopes.getStore(),state=this.findCostCall(task,metadata,inputs);costedMust(root?.open);
      const port=createCostedRemoteOriginalPortV2({accountId:target.accountId,admit:async job=>{
        const original=this.original(target,job,this.controller.parentInstanceId);state.original=original;
        const capacity={reference:this.capacityConfiguration.reference,profile:this.capacityConfiguration.profile,sourceInput:target.sourceInput};
        const decision=await sameCostRecordAck(()=>originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.admitIn(tx,root.scope,state.call,original.intent,capacity,state.call.componentId))));costedMust(decision.allowed&&decision.capacityReservationId);
        original.binding={accountId:target.accountId,capacityReservationId:decision.capacityReservationId,jobId:job.jobId,parentInstanceId:original.intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:this.controller.kernelImplementationDigest};return structuredClone(original.binding);
      },attest:async(job,binding,result,snapshot)=>{
        const original=state.original;costedMust(original&&digest(original.job)===digest(job));await originalCostData(this,()=>this.attest(target,original,binding,result,snapshot));costedMust(snapshot.windowsEvidenceRef);
        const bridge=await originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.recordIn(tx,{binding,expected:snapshot.windowsEvidenceRef!}),true));costedMust(bridge.state==='VERIFIED'&&bridge.operation&&bridge.termination);root.terminalEvidence.push(bridge.operation,bridge.termination);
      },authorizeResultQuery:request=>sameCostRecordAck(()=>originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.authorizeResultQueryIn(tx,state.call,request)))),finishResultQuery:(request,responseRef)=>sameCostRecordAck(()=>originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.finishResultQueryIn(tx,state.call,request,responseRef))))});
      return this.controller.forCostedPort(port).run(task,metadata,inputs,hooks);
    }};
    const wrap=(facade:NativeFacade):NativeFacade=>{
      for(const name of facadeCalls){const original=Reflect.get(facade,name) as (...args:unknown[])=>Promise<unknown>;Object.defineProperty(facade,name,{configurable:true,value:(...args:unknown[])=>this.trackCost(owner,target,phase,validationTargetDigest,()=>Reflect.apply(original,facade,args) as Promise<unknown>)});}
      const original=facade.withHooks;Object.defineProperty(facade,'withHooks',{value:(hooks:NativeRunHooks)=>wrap(original.call(facade,hooks))});return facade;
    };
    return wrap(new NativeFacade(runner,undefined,cache));
  }
  private readonly capacityConfiguration:WindowsNativeCapacityConfiguration;
  private trackCost<T>(owner:WindowsNativeCostOwner,target:NativeTarget,phase:NativeExecutionPhase,targetDigest:string|null,operation:()=>Promise<T>):Promise<T>{
    const inherited=this.costScopes.getStore();if(inherited?.open){const work=Promise.resolve().then(operation);inherited.children.add(work);void work.then(()=>inherited.children.delete(work),()=>inherited.children.delete(work));return work;}
    if(!this.costAccepting)return Promise.reject(new DomainError('NATIVE_SHUTDOWN_WAIT',409,'WAIT'));
    const work=(async()=>{
      const scopeId=randomUUID();let scope:WindowsNativeCostScope|null;
      try{scope=await originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.beginScopeIn(tx,owner,target,phase,targetDigest,scopeId)));}
      catch(error){if(!costAckUncertain(error))throw error;scope=await originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.lookupScopeIn(tx,scopeId),true));if(!scope)throw error;}
      costContextMust(this,scope&&scope.scopeId===scopeId&&digest(scope.owner)===digest(owner)&&digest(scope.target)===digest(target)&&scope.phase===phase&&scope.validationTargetDigest===targetDigest);
      const root:CostedScopeState={scope,open:true,children:new Set(),calls:new Map(),terminalEvidence:[]};
      return this.costScopes.run(root,async()=>{let failed=false;try{return await operation();}catch(error){failed=true;throw error;}finally{
        while(root.children.size)await Promise.allSettled([...root.children]);root.open=false;
        const ending={version:1 as const,scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,eventId:randomUUID(),outcome:failed?'THREW' as const:'RETURNED' as const,terminalEvidence:root.terminalEvidence};
        const joined=await sameCostRecordAck(()=>originalCostData(this,()=>this.db.accountTransaction(target.accountId,tx=>this.costPorts.joinScopeIn(tx,scope,ending),true)));if(!failed)costContextMust(this,joined==='JOINED');
      }});
    })();this.costActive.add(work);void work.then(()=>this.costActive.delete(work),()=>this.costActive.delete(work));return work;
  }
  override stopClaims():void{this.costAccepting=false;super.stopClaims();}
  override async idle():Promise<void>{while(this.costActive.size)await Promise.allSettled([...this.costActive]);await super.idle();}
}
const executionForCostOwner=NativeCostedWindowsGateway.prototype.forCostOwner;
import {nativeFacadeVerificationVersion as importedFacadeVersion} from '../../native/src/semantic-cache.js';
