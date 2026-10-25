import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import type {ObjectStore} from '../../storage/src/objects.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {NativeFacade} from '../../native/src/facade.js';
import {NativeController} from '../../native/src/controller.js';
import type {NativeGateway,NativeTarget} from '../../native/src/gateway.js';
import {NativeJobError,nativeJsonBytes,nativeTaskVersion,describeNativeBlobs,type NativeJob,type NativeRunHooks,type NativeJobEvidence,type NativeTermination,type NativeResult,type NativeTask,type NativeComputation,type NativeFrameLimits} from '../../native/src/dto.js';
import {NativeJobStore,nativeLogicalOperationKey,nativeOperationInputDigest,validateNativeJobClaim,validateNativeOwnerCapture,type NativeJobIntent,type NativeJobObservation} from './native-jobs.js';
import {NativeReceiptStore,reconcileNativeLibraryObjects,type NativeReceiptSource} from './native-receipts.js';
import {validateNativeCapacityConfiguration,validateNativeSourceInput,type NativeCapacityConfiguration,type NativeCapacityAdmission} from './native-capacity.js';

import {validateNativeInput} from '../../native/src/jobs.js';
import type {NativeSemanticCache} from '../../native/src/semantic-cache.js';
import {LocalLaMaNativePreparation,lamaPreparationJoinKind,confirmCurrentLaMaPreparationReceipt,verifyLaMaPreparationReceipt,type LocalLaMaPreparationJoin} from './local-lama-native-preparation.js';
import {closed,fingerprint,hexadecimal,id,own} from './local-lama-binding-verifier.js';
import {LocalLaMaAttemptJournal} from './local-lama-attempt-journal.js';
import {canonicalInput,type StageInput,type Observation} from './provider.js';
import {assertWire} from '../../contracts/src/validation.js';
import type {NativeExecutionPhase} from './native-execution-wait.js';

type Binding={intent:NativeJobIntent;job:NativeJob;disposition:'PENDING'|'ACKNOWLEDGED'|'REFUSED'|'UNCONFIRMED';capacityReservationId?:string;acknowledgement?:Promise<void>;result?:NativeResult;observation?:{id:string;value:NativeJobObservation;digest?:string};termination?:{id:string;value:NativeJobObservation;digest?:string}};
// Internal read/ACK uncertainty, with no invented native job or termination.
// Only an installed owning gateway's CLEANUP classification can create it.
class LocalLaMaContextReadWait extends Error{
  #gateway:NativeGateway;
  constructor(cause:unknown,gateway:NativeGateway){super('LOCAL_LAMA_PREPARATION_UNCONFIRMED',{cause});this.#gateway=gateway;}
  static belongsTo(value:unknown,gateway:NativeGateway|undefined):boolean{return typeof value==='object'&&value!==null&&#gateway in value&&value.#gateway===gateway;}
}
const contextWaitBelongsTo=LocalLaMaContextReadWait.belongsTo;
export function isLocalLaMaContextReadWait(value:unknown,gateway:NativeGateway|undefined):boolean{return contextWaitBelongsTo(value,gateway);}
const refused=new Set(['NATIVE_JOB_RECORD_INVALID','NATIVE_JOB_LOGICAL_KEY_INVALID','NATIVE_INTENT_EXISTS','NATIVE_INTENT_CONFLICT','NATIVE_JOB_UNRESOLVED','NATIVE_TARGET_FENCE_REJECTED','ACCOUNT_ACCESS_DENIED','NATIVE_CAPACITY_WAIT','NATIVE_CAPACITY_EXECUTION_OCCUPIED','NATIVE_CAPACITY_AUTHORITY_UNCONFIRMED','NATIVE_CAPACITY_PROFILE_MISMATCH','NATIVE_CAPACITY_INPUT_MISMATCH','NATIVE_CAPACITY_REFERENCE_REQUIRED','LIMIT_AUTHORITY_UNCONFIRMED','LIMIT_PROFILE_MISMATCH','GLOBAL_CLOCK_UNCONFIRMED']);


const facadeMethods=Object.getOwnPropertyDescriptors(NativeFacade.prototype);
const receiptMethods=Object.getOwnPropertyDescriptors(NativeReceiptStore.prototype);
const preparationMethods=Object.getOwnPropertyDescriptors(LocalLaMaNativePreparation.prototype);
const journalMethods=Object.getOwnPropertyDescriptors(LocalLaMaAttemptJournal.prototype);
const controllerRun=NativeController.prototype.run;
const controllerFrameLimits=NativeController.prototype.frameLimits;
const preparedCreationToken=Object.freeze({});
type LaMaPostComposite=NativeFacade['compositeMaskedPixels'];
// The token and resolver are never fields on a public facade. Neither its
// constructor, prototype, hooks clone nor a proxy can create the private brand.
class PreparedLaMaFacade extends NativeFacade{
  #post:()=>Promise<LaMaPostComposite>;
  constructor(token:object,runner:ConstructorParameters<typeof NativeFacade>[0],hooks:NativeRunHooks,cache:NativeSemanticCache,post:()=>Promise<LaMaPostComposite>){
    requireCondition(token===preparedCreationToken,'LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED',409,'WAIT');super(runner,hooks,cache);this.#post=post;
  }
  static resolver(value:unknown):(()=>Promise<LaMaPostComposite>)|undefined{
    if(typeof value!=='object'||value===null||types.isProxy(value)||!(#post in value))return undefined;
    const post=value.#post;return ()=>post();
  }
}
const preparedPostResolver=PreparedLaMaFacade.resolver;
// No caller buffers, metadata, flag or callback can enter this lookup.
export function localLaMaPostCompositeResolver(facade:NativeFacade):(()=>Promise<LaMaPostComposite>)|undefined{return preparedPostResolver(facade);}
type Checked=(this:NativeFacade,task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,check:(computation:NativeComputation,cached:boolean)=>unknown)=>Promise<unknown>;
const originalChecked=facadeMethods.checked.value as Checked;
const originalSealedRecord=receiptMethods.sealedRecord.value as NativeReceiptStore['sealedRecord'];
function pinnedMethods(value:object,methods:PropertyDescriptorMap):void{
  for(const [name,descriptor]of Object.entries(methods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(value,name,{value:descriptor.value,enumerable:false,writable:false,configurable:false});
}
function privateArguments(values:unknown[],limits:Readonly<NativeFrameLimits>):unknown[]{
  let binary=0,metadata=0;const visiting=new Set<object>();
  const walk=(value:unknown,depth:number,copy:boolean):unknown=>{
    requireCondition(!types.isProxy(value)&&depth<=64,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
    if(Buffer.isBuffer(value)){if(!copy){binary+=value.length;requireCondition(binary<=limits.maxBinaryBytes,'LOCAL_LAMA_PREPARATION_CAPACITY',409,'WAIT');}return copy?Buffer.from(value):value;}
    if(value===undefined||value===null||['string','number','boolean'].includes(typeof value)){if(!copy){metadata+=typeof value==='string'?Buffer.byteLength(value)*6+2:24;requireCondition(metadata<=limits.maxMetadataBytes,'LOCAL_LAMA_PREPARATION_CAPACITY',409,'WAIT');}return value;}
    requireCondition(typeof value==='object'&&value!==null&&!visiting.has(value),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');visiting.add(value);
    let result:unknown;
    if(value instanceof Map){
      requireCondition(Object.getPrototypeOf(value)===Map.prototype&&Object.keys(value).length===0&&value.size<=limits.maxItems,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
      const output=new Map<string,unknown>();for(const [key,item]of value){requireCondition(typeof key==='string','LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');if(!copy)walk(key,depth+1,false);const captured=walk(item,depth+1,copy);if(copy)output.set(key,captured);}result=copy?output:value;
    }else if(Array.isArray(value)){
      requireCondition(Object.getPrototypeOf(value)===Array.prototype&&Reflect.ownKeys(value).length===value.length+1,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');const output:unknown[]=[];
      for(let at=0;at<value.length;at++){const entry=Object.getOwnPropertyDescriptor(value,String(at));requireCondition(entry&&entry.enumerable&&'value'in entry,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');const captured=walk(entry.value,depth+1,copy);if(copy)output.push(captured);}result=copy?output:value;
    }else{
      requireCondition(Object.getPrototypeOf(value)===Object.prototype,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');const output:Record<string,unknown>={};
      for(const key of Reflect.ownKeys(value)){const entry=Object.getOwnPropertyDescriptor(value,key);requireCondition(typeof key==='string'&&entry?.enumerable&&'value'in entry,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');if(!copy)walk(key,depth+1,false);const captured=walk(entry.value,depth+1,copy);if(copy)Object.defineProperty(output,key,{value:captured,enumerable:true,writable:true,configurable:true});}result=copy?output:value;
    }
    visiting.delete(value);return result;
  };
  walk(values,0,false);return walk(values,0,true) as unknown[];
}

// The actual facade/cache/hooks are local, never returned. Public clones expose
// inert ports, not a writer. Original full checkers and receipt methods are own
// immutable methods on private instances; no global prototype is frozen.
function preparationFacade(controller:NativeController,hooksForReservation:(hold:ReturnType<LocalLaMaNativePreparation['acquire']>)=>NativeRunHooks,cache:NativeReceiptStore,target:NativeTarget,preparation:LocalLaMaNativePreparation,transaction:Database['accountTransaction'],selected:NonNullable<import('./local-lama-native-preparation.js').LocalLaMaPreparationView['capture']>,track:<T>(promise:Promise<T>)=>Promise<T>,post:()=>Promise<LaMaPostComposite>):NativeFacade{
  const acquire=(preparationMethods.acquire.value as LocalLaMaNativePreparation['acquire']).bind(preparation) as LocalLaMaNativePreparation['acquire'];
  const forOperation=(preparationMethods.forOperation.value as LocalLaMaNativePreparation['forOperation']).bind(preparation) as LocalLaMaNativePreparation['forOperation'];
  const readIn=(preparationMethods.readIn.value as LocalLaMaNativePreparation['readIn']).bind(preparation);
  const forOperationIn=(preparationMethods.forOperationIn.value as LocalLaMaNativePreparation['forOperationIn']).bind(preparation);
  const inputLimits=Object.freeze({...controllerFrameLimits.call(controller,'input')}),outputLimits=Object.freeze({...controllerFrameLimits.call(controller,'output')});
  const runner=Object.freeze({supportsParentHooks:true as const,run:(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,bound?:NativeRunHooks)=>controllerRun.call(controller,task,metadata,blobs,bound)});
  pinnedMethods(cache,receiptMethods);Object.freeze(cache);
  const locks=new Map<string,Promise<void>>();
  const enter=async(key:string):Promise<()=>void>=>{
    const previous=locks.get(key);let finish!:()=>void;const current=new Promise<void>(resolve=>{finish=resolve;});locks.set(key,current);
    if(previous)await previous;
    return ()=>{finish();if(locks.get(key)===current)locks.delete(key);};
  };
  const makeHidden=(hold:ReturnType<LocalLaMaNativePreparation['acquire']>):NativeFacade=>{
  const hidden=new NativeFacade(runner,hooksForReservation(hold),cache);
  for(const [name,descriptor]of Object.entries(facadeMethods))if(!['constructor','checked','withHooks'].includes(name)&&typeof descriptor.value==='function')Object.defineProperty(hidden,name,{value:descriptor.value,writable:false,configurable:false});
  Object.defineProperty(hidden,'checked',{value:async(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,check:(computation:NativeComputation,cached:boolean)=>unknown)=>{
    validateNativeInput(task,metadata,blobs);
    const described=describeNativeBlobs(blobs,inputLimits),key=nativeOperationInputDigest({version:1,jobId:'00000000-0000-4000-8000-000000000001',task,taskVersion:nativeTaskVersion,profileDigest:digest(metadata.profile),metadata,blobs:described,inputDigest:'0'.repeat(64)});
    let leave:(()=>void)|undefined,sealed:ReturnType<NativeReceiptStore['sealedRecord']>|undefined;
    try{
      leave=await enter(key);
      const prepared=await forOperation(target,task,metadata,described,hold);
      requireCondition(prepared&&digest(prepared.capture)===digest(selected),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
      const result=await originalChecked.call(hidden,task,metadata,blobs,check);
      if(prepared){
        sealed=originalSealedRecord.call(cache,task,metadata,blobs);
        await transaction(prepared.input.accountId!,async tx=>{
          const current=await forOperationIn(tx,target,task,metadata,described,hold);
          requireCondition(digest(current.capture)===digest(selected),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
          const {state,capture}=await readIn(tx,prepared.input,hold);
          requireCondition(capture&&digest(capture)===digest(prepared.capture),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
          await confirmCurrentLaMaPreparationReceipt(tx,target,capture,prepared.expected,sealed!,preparation.bounds.maxRecordBytes);
          const sqlReceipt=await verifyLaMaPreparationReceipt(tx,state.input,capture,prepared.expected,sealed!,preparation.bounds);
          const existing=state.rows.filter(row=>row.kind===lamaPreparationJoinKind).filter(row=>(row.protected_observation as {value?:{expected?:{logicalOperationKey?:string}}}).value?.expected?.logicalOperationKey===prepared.expected.logicalOperationKey);
          requireCondition(existing.length<=1,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
          if(existing.length){
            const wrapper=own(existing[0].protected_observation,preparation.bounds.maxRecordBytes).value as {version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:LocalLaMaPreparationJoin};
            closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
            const prior=wrapper.value;closed(prior,['version','joinId','preparationId','preparationDigest','capture','input','basis','inputFingerprint','fullStageCaptureDigest','expected','sealed','sqlReceipt','joinDigest']);id(prior.joinId);hexadecimal(prior.joinDigest);
            const {origin:_oldOrigin,...oldSealed}=prior.sealed,{origin:_newOrigin,...currentSealed}=sealed!;
            const {joinDigest,...priorBody}=prior;
            requireCondition(wrapper.version===1&&wrapper.accountId===state.input.accountId&&wrapper.executionId===state.input.executionId&&wrapper.inputDigest===state.input.inputDigest&&wrapper.inputFingerprint===fingerprint(state.input)&&wrapper.kind===lamaPreparationJoinKind&&digest(wrapper)===existing[0].evidence_digest&&existing[0].protected_evidence_ref===existing[0].evidence_id&&prior.version===1&&prior.preparationId===capture.value.preparationId&&prior.preparationDigest===capture.value.preparationDigest&&digest(prior.capture)===digest({evidenceId:capture.evidenceId,evidenceDigest:capture.evidenceDigest})&&digest(prior.input)===digest(capture.value.input)&&digest(prior.basis)===digest(capture.value.basis)&&prior.inputFingerprint===capture.value.inputFingerprint&&prior.fullStageCaptureDigest===capture.value.fullStageCaptureDigest&&digest(priorBody)===joinDigest&&digest(prior.expected)===digest(prepared.expected)&&digest(prior.sqlReceipt)===digest(sqlReceipt)&&digest(oldSealed)===digest(currentSealed),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');return;
          }
          requireCondition(state.rows.length<preparation.bounds.maxRecords,'LOCAL_LAMA_PREPARATION_CAPACITY',409,'WAIT');
          const body={version:1 as const,joinId:randomUUID(),preparationId:capture.value.preparationId,preparationDigest:capture.value.preparationDigest,capture:{evidenceId:capture.evidenceId,evidenceDigest:capture.evidenceDigest},input:capture.value.input,basis:capture.value.basis,inputFingerprint:capture.value.inputFingerprint,fullStageCaptureDigest:capture.value.fullStageCaptureDigest,expected:prepared.expected,sealed:sealed!,sqlReceipt};
          const value:LocalLaMaPreparationJoin={...body,joinDigest:digest(body)},wrapper=own({version:1 as const,accountId:state.input.accountId!,executionId:state.input.executionId,inputDigest:state.input.inputDigest,inputFingerprint:fingerprint(state.input),kind:lamaPreparationJoinKind,value},preparation.bounds.maxRecordBytes).value,evidenceId=randomUUID();
          const inserted=await tx.client.query<{evidence_id:string}>(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
            VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id`,[state.input.accountId,evidenceId,state.input.executionId,lamaPreparationJoinKind,digest(wrapper),tx.now,JSON.stringify(wrapper)]);
          requireCondition(inserted.rowCount===1&&inserted.rows.length===1&&inserted.rows[0].evidence_id===evidenceId,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        },true);
      }
      return result;
    }catch(error){if(error instanceof NativeJobError||!sealed)throw error;throw new NativeJobError(error instanceof DomainError?error.code:'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT',sealed.termination);}
    finally{leave?.();}
  },writable:false,configurable:false});
  Object.defineProperty(hidden,'withHooks',{value:()=>{throw new DomainError('NATIVE_SEMANTIC_BINDING_CONFLICT',409,'WAIT');},writable:false,configurable:false});Object.freeze(hidden);return hidden;
  };
  // This facade is already classified as a first-original CLEANUP context.
  // Ordinary FontCatalog/cache contracts never enter this task wrapper.
  const preparationMethodNames=new Set(['decodeImage','binaryPolygonMask','compositeMaskedPixels']);
  const inaccessible=()=>{throw new DomainError('LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED',409,'WAIT');};
  const publicHooks:object=Object.freeze({intent:inaccessible,consumeGo:inaccessible,observation:inaccessible,termination:inaccessible});
  const publicCache:NativeSemanticCache=Object.freeze({kernelImplementationDigest:cache.kernelImplementationDigest,facadeVerificationVersion:cache.facadeVerificationVersion,frameLimits:(direction:'input'|'output')=>direction==='input'?inputLimits:outputLimits,read:async()=>inaccessible(),seal:async()=>inaccessible(),onValidationFailure:async()=>inaccessible()});
  const makePublic=(branded=false):NativeFacade=>{
    const inert=Object.freeze({supportsParentHooks:true as const,run:async()=>inaccessible()});
    const facade=branded?new PreparedLaMaFacade(preparedCreationToken,inert,publicHooks as NativeRunHooks,publicCache,post):new NativeFacade(inert,publicHooks as NativeRunHooks,publicCache);
    for(const [name,descriptor]of Object.entries(facadeMethods))if(!['constructor','checked','withHooks'].includes(name)&&typeof descriptor.value==='function')Object.defineProperty(facade,name,{value:(...args:unknown[])=>{
      // One reservation precedes caller copies and waits, and stays held through
      // all original checks, receipt I/O, and the final JOIN COMMIT ACK.
      if(!preparationMethodNames.has(name))return Promise.reject(new DomainError('LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT'));
      const hold=acquire(inputLimits.maxBinaryBytes+outputLimits.maxBinaryBytes*2);let captured:unknown[];
      try{captured=privateArguments(args,inputLimits);}catch(error){hold.release();throw error;}
      const promise=(async()=>{try{return await Reflect.apply(descriptor.value,makeHidden(hold),captured);}finally{hold.release();}})();return track(promise);
    },writable:false,configurable:false});
    Object.defineProperty(facade,'checked',{value:inaccessible,writable:false,configurable:false});
    Object.defineProperty(facade,'withHooks',{value:(value:NativeRunHooks)=>{requireCondition(value===publicHooks,'NATIVE_SEMANTIC_BINDING_CONFLICT',409,'WAIT');return makePublic();},writable:false,configurable:false});
    return facade;
  };
  return makePublic(true);
}

// Each owning service passes a captured target. The database then compares its
// current ownership/claim before both admission and the single GO grant. No
// account, database handle, credentials or callbacks enter the child frame.
export class NativeDatabaseGateway implements NativeGateway{
  #preparation:LocalLaMaNativePreparation|undefined;#preparationTransaction:Database['accountTransaction']|undefined;#preparationActive=new Set<Promise<unknown>>();
  #db:Database;#controller:NativeController;#objects:ObjectStore|undefined;#contextJournal:LocalLaMaAttemptJournal|undefined;
  private readonly capacity:NativeCapacityConfiguration|undefined;
  constructor(readonly db:Database,readonly controller:NativeController,readonly objects?:ObjectStore,capacity?:NativeCapacityConfiguration,preparation?:LocalLaMaNativePreparation){this.#db=db;this.#controller=controller;this.#objects=objects;if(preparation){const matches=(preparationMethods.sameDatabase.value as LocalLaMaNativePreparation['sameDatabase']).call(preparation,db);requireCondition(matches&&objects,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');const prototype=Object.getPrototypeOf(db),method=Object.getOwnPropertyDescriptor(db,'accountTransaction')??Object.getOwnPropertyDescriptor(prototype,'accountTransaction');requireCondition(method&&'value'in method&&typeof method.value==='function'&&!types.isProxy(method.value),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');this.#preparationTransaction=method.value.bind(db) as Database['accountTransaction'];this.#contextJournal=new LocalLaMaAttemptJournal(db,preparation.bounds);pinnedMethods(this.#contextJournal,journalMethods);}this.#preparation=preparation;this.capacity=capacity===undefined?undefined:validateNativeCapacityConfiguration(capacity,controller.profileDigest,controller.kernelImplementationDigest);}
  // Nominal runtime private fields distinguish this owning implementation from
  // fake/custom ports. No optional callback or caller "verified" flag is read.
  static executionContext(gateway:NativeGateway,db:Database,target:NativeTarget,input:StageInput,phase:NativeExecutionPhase,currentRequestId:string,observation?:Observation):Promise<NativeFacade>{
    if(!types.isProxy(gateway)&&#db in gateway)return gateway.#executionContext(db,target,input,phase,currentRequestId,observation);
    return Promise.resolve(gateway.forTarget(target));
  }
  async #executionContext(db:Database,targetValue:NativeTarget,inputValue:StageInput,phase:NativeExecutionPhase,currentRequestId:string,observationValue?:Observation,requireOriginal=false):Promise<NativeFacade>{
    if(!this.#preparation||targetValue.targetKind!=='EXECUTION')return this.#facade(targetValue);
    // The known DB original has already been owned by ExecutionService before
    // its transaction ACK. Own it again without consulting caller data later.
    const cleanup=inputValue.stage==='CLEANUP';
    try{
      // The parent already owns the DB original. Revalidation uses SQL jsonb
      // equality plus its independent JS evidence digest, returning only bounded
      // scalar refs. Native task frame limits do not size ordinary parent INPUT.
      const target=own(targetValue,8192).value,input=canonicalInput(inputValue),inputFingerprint=digest(input),inputJson=JSON.stringify(input),observation=observationValue?structuredClone(observationValue):undefined,outputDigest=observation?digest(observation):null;
      requireCondition(db===this.#db&&target.sourceInput&&input.accountId===target.accountId&&input.executionId===target.targetId&&target.sourceInput.executionId===input.executionId&&target.sourceInput.stageInputDigest===input.inputDigest&&currentRequestId===input.requestId&&phase!=='CHECKPOINT','LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
      validateNativeOwnerCapture(target.protectedOwnerCapture);validateNativeJobClaim(target.claim);validateNativeSourceInput(target.sourceInput);
      const selected=await this.#preparationTransaction!(target.accountId,async tx=>{
        const rows=(await tx.client.query<{request_id:string;logical_step_id:string;input_digest:string;evidence_id:string;evidence_digest:string;protected_evidence_ref:string;input_matches:boolean;owner:NativeTarget['protectedOwnerCapture'];claim_current:boolean}>(`SELECT e.request_id,
          CASE WHEN octet_length(e.logical_step_id)<=9 THEN e.logical_step_id ELSE NULL END AS logical_step_id,
          CASE WHEN octet_length(e.input_digest)<=64 THEN e.input_digest ELSE NULL END AS input_digest,
          z.evidence_id,CASE WHEN octet_length(z.evidence_digest)<=64 THEN z.evidence_digest ELSE NULL END AS evidence_digest,
          CASE WHEN octet_length(z.protected_evidence_ref)<=36 THEN z.protected_evidence_ref ELSE NULL END AS protected_evidence_ref,
          (z.protected_observation=$4::jsonb AND z.evidence_digest=$8) AS input_matches,
          jsonb_build_object('contextId',c.context_id,'contextGeneration',c.generation::text,'ownerSessionId',c.owner_session_id,'ownerTabId',c.owner_tab_id,'ownerRevision',c.owner_revision::text,'workspaceRevision',c.workspace_revision::text) AS owner,
          (w.state='CLAIMED' AND w.claim_generation=$5 AND w.claim_owner=$6 AND w.lease_until>$7
            AND (w.target_ref->>'requestId'=r.request_id::text OR w.target_ref->>'executionId'=e.execution_id::text)) AS claim_current
          FROM executions e JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
          JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
          JOIN execution_evidence z ON z.account_id=e.account_id AND z.execution_id=e.execution_id AND z.kind='INPUT'
          JOIN work_items w ON w.account_id=e.account_id AND w.work_item_id=$3
          WHERE e.account_id=$1 AND e.execution_id=$2 LIMIT 2 FOR UPDATE OF e,r,c,w`,[target.accountId,target.targetId,target.claim.workItemId,inputJson,target.claim.generation,target.claim.ownerId,tx.now,inputFingerprint])).rows;
        requireCondition(tx.account.account_id===target.accountId&&Array.isArray(rows)&&rows.length===1,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        const row=own(rows[0],8192).value,stored=input;
        requireCondition(stored.envelope&&!Object.hasOwn(stored,'claimGeneration')&&row.input_matches===true&&row.evidence_id===target.sourceInput!.inputEvidenceId&&row.protected_evidence_ref===row.evidence_id&&inputFingerprint===row.evidence_digest&&stored.accountId===target.accountId&&stored.executionId===target.targetId&&stored.requestId===row.request_id&&stored.stage===row.logical_step_id&&stored.inputDigest===row.input_digest&&row.claim_current===true,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        assertWire('stageInputEnvelope',stored.envelope);
        requireCondition(stored.envelope.executionId===stored.executionId&&stored.envelope.requestId===stored.requestId&&stored.envelope.logicalStepId===stored.stage&&stored.envelope.contextId===stored.contextId&&stored.envelope.inputDigest===stored.inputDigest&&digest(stored.envelope.capturedSettings)===digest(stored.settings)&&digest(validateNativeOwnerCapture(row.owner))===digest(target.protectedOwnerCapture)&&target.semanticCaptureDigest===digest({version:1,phase,currentRequestId,originExecutionId:stored.executionId,inputFingerprint,outputDigest}),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        if(stored.stage!=='CLEANUP')return null;
        const state=await (journalMethods.contextIn.value as LocalLaMaAttemptJournal['contextIn']).call(this.#contextJournal!,tx,stored,this.#preparation!);
        if(state.original){
          if(requireOriginal){
            const current=(await tx.client.query<{current:boolean}>(`SELECT true AS current FROM executions e
              JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id
              JOIN workspace_contexts c ON c.account_id=r.account_id AND c.context_id=r.context_id
              JOIN request_steps s ON s.account_id=e.account_id AND s.request_id=e.request_id AND s.logical_step_id=e.logical_step_id
              JOIN work_items w ON w.account_id=e.account_id AND w.work_item_id=$3
              WHERE e.account_id=$1 AND e.execution_id=$2 AND e.claim_generation=$4 AND s.current_execution_id=e.execution_id
              AND w.state='CLAIMED' AND w.claim_generation=$4 AND w.claim_owner=$5 AND w.lease_until>$6
              AND (w.target_ref->>'requestId'=r.request_id::text OR w.target_ref->>'executionId'=e.execution_id::text)
              AND r.terminal_at IS NULL AND NOT r.hold_reasons @> '["NATIVE_EXECUTION_UNCONFIRMED"]'::jsonb
              AND c.lifecycle<>'CLOSED' AND c.generation=r.context_generation LIMIT 2 FOR UPDATE OF e,r,c,s,w`,[target.accountId,target.targetId,target.claim.workItemId,target.claim.generation,target.claim.ownerId,tx.now])).rows;
            requireCondition(current.length===1&&current[0].current===true,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
          }
          return null;
        }
        requireCondition(!requireOriginal,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        requireCondition(state.capture&&state.capture.value.kernelImplementationDigest===this.#controller.kernelImplementationDigest&&state.capture.value.profileDigest===this.#controller.profileDigest,'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        return state.capture;
      },true);
      const post=async():Promise<LaMaPostComposite>=>{
        const ordinary=await this.#executionContext(this.#db,target,input,phase,currentRequestId,observation,true);
        return (facadeMethods.compositeMaskedPixels.value as LaMaPostComposite).bind(ordinary);
      };
      return this.#facade(target,selected??undefined,selected?post:undefined,requireOriginal);
    }catch(error){if(cleanup)throw new LocalLaMaContextReadWait(error,this);throw error;}
  }
  forTarget(value:NativeTarget):NativeFacade{
    return this.#facade(value);
  }
  #facade(value:NativeTarget,selected?:NonNullable<import('./local-lama-native-preparation.js').LocalLaMaPreparationView['capture']>,post?:()=>Promise<LaMaPostComposite>,privateOrdinary=false):NativeFacade{
    nativeJsonBytes(value,8192);
    const keys=['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim'];
    if(Object.hasOwn(value,'sourceInput'))keys.push('sourceInput');
    requireCondition(value&&typeof value.accountId==='string'&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'NATIVE_JOB_RECORD_INVALID',422);
    const target:NativeTarget={...structuredClone(value),protectedOwnerCapture:validateNativeOwnerCapture(value.protectedOwnerCapture),claim:validateNativeJobClaim(value.claim),...(keys.length===7?{sourceInput:validateNativeSourceInput(value.sourceInput)}:{})};
    requireCondition(!target.sourceInput||['EXECUTION','REQUEST_CHECKPOINT'].includes(target.targetKind),'NATIVE_CAPACITY_INPUT_MISMATCH',409,'WAIT');
    const capacity:NativeCapacityAdmission|undefined=this.capacity?{...this.capacity,...(target.sourceInput?{sourceInput:target.sourceInput}:{})}:undefined;
    const store=new NativeJobStore(this.#db,target.accountId),bindings=new Map<string,Binding>();
    // Check target grammar before reserving any parent buffer or attempting an
    // intent. This is validation only; the actual key is sealed per native job.
    nativeLogicalOperationKey({...target,task:'ZIP_WRITE',taskVersion:nativeTaskVersion,profileDigest:this.#controller.profileDigest,operationInputDigest:'0'.repeat(64)});
    const binding=(job:NativeJob):Binding=>{
      const current=bindings.get(job.jobId);requireCondition(current&&current.intent.inputDigest===job.inputDigest&&current.intent.profileDigest===job.profileDigest,'NATIVE_INTENT_UNCONFIRMED',409,'WAIT');return current;
    };
    const observation=(evidence:NativeJobEvidence,termination:NativeTermination,result:NativeResult|null,event:'OBSERVATION'|'TERMINATION'):NativeJobObservation=>({
      version:1,parentInstanceId:this.#controller.parentInstanceId,event:event==='TERMINATION'?'TERMINATION':evidence.code==='OK'&&result?'RESULT':'ERROR',code:evidence.code,
      resultDigest:event==='OBSERVATION'&&evidence.code==='OK'&&result?digest(result):null,
      termination:{...termination,isolation:evidence.isolation}
    });
    const append=async(job:NativeJob,evidence:NativeJobEvidence,termination:NativeTermination,result:NativeResult|null,event:'OBSERVATION'|'TERMINATION')=>{
      const current=binding(job);
      // The audit can run while a timed-out admission is still waiting for its
      // commit response. Keep the original snapshot, then append after that
      // acknowledgement has joined rather than racing an uncommitted intent.
      if(current.disposition==='PENDING')await current.acknowledgement?.catch(()=>undefined);
      // An acknowledged refusal did not create this new job. Recording it as
      // a fact of an earlier logical invocation would corrupt that invocation.
      if(current.disposition==='REFUSED')return;
      const member=event==='OBSERVATION'?'observation':'termination';
      current[member]??={id:randomUUID(),value:observation(evidence,termination,result,event)};
      const sealed=current[member],decision=await store.observe(sealed.id,sealed.value);sealed.digest=decision.observationDigest;
      if(event==='OBSERVATION'&&sealed.value.event==='RESULT'&&result)current.result=structuredClone(result);
    };
    const guardedStore=(job:NativeJob,hold:ReturnType<LocalLaMaNativePreparation['acquire']>):NativeJobStore=>{
      // The adapter never escapes this owning closure. NativeJobStore's exact
      // admission/GO SQL runs in the actual account transaction after the
      // preparation/current fence check, keeping both under the same lock.
      const accountTransaction:Database['accountTransaction']=<T>(accountId:string,run:(tx:Transaction)=>Promise<T>,allowRestricted=false)=>this.#preparationTransaction!(accountId,async tx=>{
        const current=await (preparationMethods.forOperationIn.value as LocalLaMaNativePreparation['forOperationIn']).call(this.#preparation!,tx,target,job.task,job.metadata,job.blobs,hold);
        requireCondition(selected&&digest(current.capture)===digest(selected),'LOCAL_LAMA_PREPARATION_UNCONFIRMED',409,'WAIT');
        return run(tx);
      },allowRestricted);
      return new NativeJobStore({accountTransaction} as Database,target.accountId);
    };
    const hooksForReservation=(hold?:ReturnType<LocalLaMaNativePreparation['acquire']>):NativeRunHooks=>({
      intent:async job=>{
        requireCondition(job.profileDigest===this.#controller.profileDigest,'NATIVE_PROFILE_MISMATCH',409,'WAIT');
        const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:this.#controller.parentInstanceId,targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:target.protectedOwnerCapture,claim:target.claim};
        const current:Binding={intent:{...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},job:structuredClone(job),disposition:'PENDING'};bindings.set(job.jobId,current);
        current.acknowledgement=(async()=>{try{const decision=await (hold?guardedStore(job,hold):store).beforeIntent(current.intent,Boolean(this.#objects),capacity);if(capacity)requireCondition(typeof decision.capacityReservationId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(decision.capacityReservationId),'NATIVE_CAPACITY_RESERVATION_UNCONFIRMED',409,'WAIT');current.capacityReservationId=decision.capacityReservationId;current.disposition='ACKNOWLEDGED';}catch(error){current.disposition=error instanceof DomainError&&refused.has(error.code)?'REFUSED':'UNCONFIRMED';throw error;}})();
        await current.acknowledgement;
      },
      consumeGo:async job=>{const current=binding(job);requireCondition(current.disposition==='ACKNOWLEDGED','NATIVE_INTENT_UNCONFIRMED',409,'WAIT');await (hold?guardedStore(current.job,hold):store).beforeGo(job.jobId,this.#controller.parentInstanceId,target.claim,target.protectedOwnerCapture,capacity);},
      observation:async(job,evidence,termination,result)=>append(job,evidence,termination,result,'OBSERVATION'),
      termination:async(job,evidence,termination)=>append(job,evidence,termination,null,'TERMINATION')
    });
    const hooks=hooksForReservation();
    let cache:NativeReceiptStore|undefined,preparedCache:NativeReceiptStore|undefined;
    if(this.#objects){
      const source:NativeReceiptSource=(task,metadata,inputBlobs)=>{
        const sampled={...metadata},inputRefs=describeNativeBlobs(inputBlobs,this.#controller.frameLimits('input'));
        // The controller captured the actual input/result frame. Normalizing
        // lease/novel IDs identifies only this pure operation; the returned
        // original job/result authority is never rebound to another target.
        const current=[...bindings.values()].find(item=>item.disposition==='ACKNOWLEDGED'&&item.job.task===task&&digest(item.job.metadata)===digest(sampled)&&digest(item.job.blobs)===digest(inputRefs));
        try{requireCondition(current?.result&&current.observation?.value.event==='RESULT'&&current.observation.digest&&/^[a-f0-9]{64}$/.test(current.observation.digest)&&current.termination?.value.code==='OK'&&current.termination.digest&&current.termination.value.termination.operationJoined&&current.termination.value.termination.directChildClosed,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');}
        catch(error){
          // A missing storage acknowledgement does not erase the controller's
          // observation of this original job or establish a new computation.
          const observed=current?.termination?.value.termination??current?.observation?.value.termination;
          if(observed){const {isolation:_isolation,...termination}=observed;throw new NativeJobError('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT',termination);}
          throw error;
        }
        const {isolation:_isolation,...termination}=current.termination.value.termination;
        return {intent:current.intent,job:current.job,result:current.result,resultObservationId:current.observation.id,resultObservationDigest:current.observation.digest,termination};
      };
      const rejected:NonNullable<ConstructorParameters<typeof NativeReceiptStore>[6]>=async(produced,error)=>{
        const current=bindings.get(produced.intent.jobId);requireCondition(current?.termination,'NATIVE_EVIDENCE_UNCONFIRMED',409,'WAIT');
        const code=error instanceof DomainError&&/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)?error.code:'NATIVE_OUTPUT_INVALID';
        await store.observe(randomUUID(),{version:1,parentInstanceId:this.#controller.parentInstanceId,event:'ERROR',code,resultDigest:null,termination:current.termination.value.termination});
      };
      const cacheLimits={input:this.#controller.frameLimits('input'),output:this.#controller.frameLimits('output')};
      cache=new NativeReceiptStore(this.#db,this.#objects,target,this.#controller.kernelImplementationDigest,cacheLimits,source,rejected);
      if(selected&&this.#preparation)preparedCache=new NativeReceiptStore(this.#db,this.#objects,target,this.#controller.kernelImplementationDigest,cacheLimits,source,rejected,this.#preparation.bounds.maxRecordBytes);
    }
    if(selected&&this.#preparation&&preparedCache&&post)return preparationFacade(this.#controller,hold=>hooksForReservation(hold),preparedCache,target,this.#preparation,this.#preparationTransaction!,selected,promise=>{this.#preparationActive.add(promise);void promise.finally(()=>this.#preparationActive.delete(promise)).catch(()=>undefined);return promise;},post);
    if(privateOrdinary){
      // The post resolver returns only the captured original method, keeping
      // its default receipt store, runner and full checker inside this closure.
      if(cache){pinnedMethods(cache,receiptMethods);Object.freeze(cache);}
      const runner=Object.freeze({supportsParentHooks:true as const,run:(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,bound?:NativeRunHooks)=>controllerRun.call(this.#controller,task,metadata,blobs,bound)}),facade=new NativeFacade(runner,Object.freeze(hooks),cache);
      pinnedMethods(facade,facadeMethods);Object.freeze(facade);return facade;
    }
    return new NativeFacade(this.#controller,hooks,cache);
  }
  stopClaims():void{this.#controller.stopClaims();}
  async idle():Promise<void>{await this.#controller.idle();while(this.#preparationActive.size)await Promise.allSettled([...this.#preparationActive]);}
  async reconcileTerminations():Promise<void>{await this.#controller.reconcileTerminations();}
  async maintenance(accountId:string):Promise<void>{if(this.#objects)await reconcileNativeLibraryObjects(this.#db,this.#objects,accountId,this.#controller.frameLimits('output'));}
}
// Pin the nominal builder once. Replacing public prototype/static methods on a
// gateway does not install a new classifier or a completion authority.
const owningExecutionContext=NativeDatabaseGateway.executionContext;
export function nativeContextForInput(gateway:NativeGateway,db:Database,target:NativeTarget,input:StageInput,phase:NativeExecutionPhase,currentRequestId:string,observation?:Observation):Promise<NativeFacade>{
  return owningExecutionContext(gateway,db,target,input,phase,currentRequestId,observation);
}
