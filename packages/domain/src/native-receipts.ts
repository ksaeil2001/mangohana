import {randomUUID,createPublicKey,verify} from 'node:crypto';
import {types} from 'node:util';
import canonicalize from 'canonicalize';
import type {Database} from '../../storage/src/database.js';
import type {ObjectStore,ObjectReceipt} from '../../storage/src/objects.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {NativeJobError,verifyNativeInput,createNativeJob,describeNativeBlobs,validateNativeEnvelope,nativeJsonBytes,type NativeComputation,type NativeFrameLimits,type NativeTask,type NativeJob,type NativeResult,type NativeTermination} from '../../native/src/dto.js';
import type {NativeTarget} from '../../native/src/gateway.js';
import {nativeFacadeVerificationVersion,type NativeSemanticCache,type NativeSemanticCacheRead} from '../../native/src/semantic-cache.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest,validateNativeJobIntent,validateNativeJobObservation,type NativeJobIntent} from './native-jobs.js';

import {NativeJobErrorV2} from '../../native/src/controller-remote.js';
import {validateNativeControllerBinding,type NativeControllerBinding,type NativeRawResultReference} from '../../native/src/controller-protocol.js';
import type {NativeTerminationV2,WindowsEvidenceRef} from '../../native/src/dto.js';
import type {NativeSourceInputRef} from '../../native/src/gateway.js';
import {decodeWindowsControl,encodeWindowsControl,type OriginalCapture,type WindowsSealEnvelope} from '../../native/src/windows-job-backend.js';
import {validateWindowsJobEvidence,classifyWindowsJobEvidence,type WindowsJobAccounting} from '../../native/src/windows-job-evidence.js';
import {validateNativeCapacityConfiguration,validateNativeCapacityAdmission,validateNativeSourceInput,type WindowsNativeCapacityConfiguration} from './native-capacity.js';
import {validateNativeJobObservationV2,type NativeJobObservationV2} from './native-jobs.js';
import {assertWire} from '../../contracts/src/validation.js';
import {canonicalInput,type StageInput} from './provider.js';
export type NativeReceiptBlob={blobId:string;assetId:string;sha256:string;bytesLength:string};
export type NativeReceiptCandidate={version:1;candidateId:string;jobId:string;parentInstanceId:string;operationInputDigest:string;kernelImplementationDigest:string;verificationVersion:typeof nativeFacadeVerificationVersion;resultObservationId:string;resultObservationDigest:string;resultDigest:string;inputCanonical:string;resultCanonical:string;blobs:NativeReceiptBlob[]};
export type NativeVerifiedReceipt={version:1;candidateId:string;kernelImplementationDigest:string;verificationVersion:typeof nativeFacadeVerificationVersion;blobs:{blobId:string;receipt:ObjectReceipt}[]};
type Lookup={state:'MISS'|'VERIFIED'|'PENDING_OR_UNCONFIRMED'|'CONFLICT';reason?:string;candidate?:NativeReceiptCandidate;receipt?:NativeVerifiedReceipt|null;intent?:NativeJobIntent;termination?:(NativeTermination&{isolation?:string})|null};
type Decision={allowed:boolean;reason:string;candidate?:NativeReceiptCandidate};
export type NativeReceiptProduced={intent:NativeJobIntent;job:NativeJob;result:NativeResult;resultObservationId:string;resultObservationDigest:string;termination:NativeTermination};
export type NativeReceiptSource=(task:NativeTask,metadata:Record<string,unknown>,inputBlobs:Map<string,Buffer>,computation:NativeComputation)=>NativeReceiptProduced;
export type NativeSealedReceipt={candidate:NativeReceiptCandidate;receipt:NativeVerifiedReceipt;intent:NativeJobIntent;termination:NativeTermination;origin:'FRESH'|'CACHE'};
type CandidateRecord={candidate:NativeReceiptCandidate;result:NativeResult;intent:NativeJobIntent;termination:NativeTermination;proof?:NativeVerifiedReceipt|null;fresh:boolean;putAttempted:Set<string>};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const fail=()=>requireCondition(false,'NATIVE_RECEIPT_INVALID',409,'WAIT');
function keys(value:unknown,expected:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))fail();
  const descriptors=Object.getOwnPropertyDescriptors(value as object);
  if(Reflect.ownKeys(value as object).length!==expected.length||expected.some(key=>!descriptors[key]?.enumerable||!('value'in descriptors[key])))fail();
  return value as Record<string,unknown>;
}
export function validateNativeReceiptBlobs(value:unknown,limits:NativeFrameLimits):NativeReceiptBlob[]{
  if(!Array.isArray(value)||value.length>limits.maxItems)fail();let total=0;const ids=new Set<string>(),assets=new Set<string>();
  for(const entry of value as unknown[]){const ref=keys(entry,['blobId','assetId','sha256','bytesLength']);
    if(typeof ref.blobId!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(ref.blobId)||ids.has(ref.blobId)||typeof ref.assetId!=='string'||!uuid.test(ref.assetId)||assets.has(ref.assetId)||typeof ref.sha256!=='string'||!hash.test(ref.sha256)||typeof ref.bytesLength!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(ref.bytesLength))fail();
    const length=Number(ref.bytesLength);total+=length;if(!Number.isSafeInteger(length)||!Number.isSafeInteger(total)||total>limits.maxBinaryBytes)fail();ids.add(ref.blobId as string);assets.add(ref.assetId as string);
  }
  return structuredClone(value) as NativeReceiptBlob[];
}
export function validateNativeReceiptCandidate(value:unknown,limits:NativeFrameLimits,inputLimits:NativeFrameLimits=limits):{candidate:NativeReceiptCandidate;result:NativeResult}{
  const item=keys(value,['version','candidateId','jobId','parentInstanceId','operationInputDigest','kernelImplementationDigest','verificationVersion','resultObservationId','resultObservationDigest','resultDigest','inputCanonical','resultCanonical','blobs']);
  if(item.version!==1||item.verificationVersion!==nativeFacadeVerificationVersion)fail();
  return receiptCandidateFields<NativeReceiptCandidate>(item,limits,inputLimits);
}
function receiptCandidateFields<T extends NativeReceiptCandidate|NativeReceiptCandidateV2>(item:Record<string,unknown>,limits:NativeFrameLimits,inputLimits:NativeFrameLimits):{candidate:T;result:NativeResult}{
  for(const key of ['candidateId','jobId','parentInstanceId','resultObservationId'])if(typeof item[key]!=='string'||!uuid.test(item[key] as string))fail();
  for(const key of ['operationInputDigest','kernelImplementationDigest','resultObservationDigest','resultDigest'])if(typeof item[key]!=='string'||!hash.test(item[key] as string))fail();
  if(typeof item.resultCanonical!=='string'||Buffer.byteLength(item.resultCanonical)>limits.maxMetadataBytes||sha256(item.resultCanonical)!==item.resultDigest)fail();
  const result=parseStrictJson(item.resultCanonical as string,limits.maxMetadataBytes) as NativeResult;validateNativeEnvelope(result,limits);
  if(result.jobId!==item.jobId||canonicalize(result)!==item.resultCanonical)fail();
  if(typeof item.inputCanonical!=='string'||Buffer.byteLength(item.inputCanonical)>inputLimits.maxMetadataBytes||sha256(item.inputCanonical)!==result.inputDigest)fail();
  const input=keys(parseStrictJson(item.inputCanonical as string,inputLimits.maxMetadataBytes),['version','jobId','task','taskVersion','profileDigest','metadata','blobs']);
  if(canonicalize(input)!==item.inputCanonical)fail();const job={...input,inputDigest:result.inputDigest} as NativeJob;validateNativeEnvelope(job,inputLimits);
  if(job.jobId!==result.jobId||job.task!==result.task||job.taskVersion!==result.taskVersion||job.profileDigest!==result.profileDigest||nativeOperationInputDigest(job)!==item.operationInputDigest)fail();
  const refs=validateNativeReceiptBlobs(item.blobs,limits);
  if(refs.length!==result.blobs.length||refs.some((ref,index)=>ref.blobId!==result.blobs[index].id||ref.sha256!==result.blobs[index].sha256||ref.bytesLength!==String(result.blobs[index].byteLength)))fail();
  return {candidate:structuredClone(item) as T,result};
}
function objectReceipt(value:unknown,key:string,sha:string,length:string):ObjectReceipt{
  const item=keys(value,['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds']);
  if(item.key!==key||item.sha256!==sha||item.bytesLength!==length||typeof item.completedAt!=='string'||!Number.isFinite(Date.parse(item.completedAt))||new Date(item.completedAt).toISOString()!==item.completedAt||![1,1000].includes(item.completedAtPrecisionMilliseconds as number)||(item.completedAtPrecisionMilliseconds===1000&&Date.parse(item.completedAt)%1000!==0))fail();return structuredClone(item) as ObjectReceipt;
}
function physical(value:Lookup['termination'],fallback:NativeJobIntent):NativeTermination{
  // An absent record says nothing about an earlier invocation. Keep it unknown;
  // it is never used as proof for GO, cost or releasing an existing reservation.
  if(!value)return {jobId:fallback.jobId,inputDigest:fallback.inputDigest,profileDigest:fallback.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'};
  try {
    const checked=validateNativeJobObservation({version:1,parentInstanceId:fallback.parentInstanceId,event:'TERMINATION',code:'OK',resultDigest:null,termination:value});
    requireCondition(checked.termination.jobId===fallback.jobId&&checked.termination.inputDigest===fallback.inputDigest&&checked.termination.profileDigest===fallback.profileDigest,'NATIVE_RECEIPT_INVALID',409,'WAIT');
    const {isolation:_isolation,...termination}=checked.termination;return Object.freeze({...termination});
  }catch {return physical(null,fallback);}
}

// A fixed target and role DB own this port. Its cache returns raw original
// frames; the facade still runs every checker before calling seal().
export class NativeReceiptStore implements NativeSemanticCache{
  static windows(db:Database,objects:ObjectStore,target:NativeTarget,kernelImplementationDigest:string,limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>},source:NativeReceiptSourceV2,lookupMaximum?:number):NativeWindowsReceiptStore{return new WindowsReceiptStore(db,objects,target,kernelImplementationDigest,limits,source,lookupMaximum);}
  static windowsCosted(options:WindowsCostedReceiptOptions):NativeWindowsReceiptStore{return createWindowsCostedReceiptStore(options);}
  readonly facadeVerificationVersion=nativeFacadeVerificationVersion;
  private readonly candidates=new Map<string,CandidateRecord>();
  readonly target:NativeTarget;
  #verified=new Map<string,NativeSealedReceipt>();
  #lookupMaximum:number;
  private readonly limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>};
  constructor(readonly db:Database,readonly objects:ObjectStore,target:NativeTarget,readonly kernelImplementationDigest:string,limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>},private readonly source:NativeReceiptSource,private readonly rejected?:(source:NativeReceiptProduced,error:unknown)=>Promise<void>,lookupMaximum?:number){
    requireCondition(hash.test(kernelImplementationDigest)&&uuid.test(target.accountId),'NATIVE_RECEIPT_INVALID',409,'WAIT');
    this.target=Object.freeze({...structuredClone(target),protectedOwnerCapture:Object.freeze(structuredClone(target.protectedOwnerCapture)),claim:Object.freeze(structuredClone(target.claim))});
    const snapshot=(value:Readonly<NativeFrameLimits>)=>{keys(value,['maxMetadataBytes','maxBinaryBytes','maxItems']);requireCondition(Object.values(value).every(number=>Number.isSafeInteger(number)&&number>0),'NATIVE_RECEIPT_INVALID',409,'WAIT');return Object.freeze({...value});};
    this.limits={input:snapshot(limits.input),output:snapshot(limits.output)};
    this.#lookupMaximum=lookupMaximum??Math.min(16777216,4*(this.limits.input.maxMetadataBytes+this.limits.output.maxMetadataBytes)+16384+this.limits.output.maxItems*1024);
    requireCondition(Number.isSafeInteger(this.#lookupMaximum)&&this.#lookupMaximum>0&&this.#lookupMaximum<=16777216,'NATIVE_RECEIPT_INVALID',409,'WAIT');
  }
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>{return this.limits[direction];}
  private sample(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>){const job=createNativeJob(task,digest(metadata.profile),metadata,inputs,this.limits.input),operationInputDigest=nativeOperationInputDigest(job);return {job,operationInputDigest};}
  private query(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>){const sampled=this.sample(task,metadata,inputs);return {...sampled,lookup:{version:1,targetKind:this.target.targetKind,targetId:this.target.targetId,semanticCaptureDigest:this.target.semanticCaptureDigest,protectedOwnerCapture:this.target.protectedOwnerCapture,claim:this.target.claim,task,taskVersion:sampled.job.taskVersion,profileDigest:sampled.job.profileDigest,operationInputDigest:sampled.operationInputDigest,kernelImplementationDigest:this.kernelImplementationDigest}};}
  private unknown(code:string,intent:NativeJobIntent,termination?:Readonly<NativeTermination>):never{throw new NativeJobError(code,409,'WAIT',termination??physical(null,intent));}
  private prospective(sampled:ReturnType<NativeReceiptStore['sample']>):NativeJobIntent{const intent={version:1 as const,jobId:sampled.job.jobId,task:sampled.job.task,taskVersion:sampled.job.taskVersion,profileDigest:sampled.job.profileDigest,inputDigest:sampled.job.inputDigest,operationInputDigest:sampled.operationInputDigest,parentInstanceId:randomUUID(),targetKind:this.target.targetKind,targetId:this.target.targetId,semanticCaptureDigest:this.target.semanticCaptureDigest,protectedOwnerCapture:this.target.protectedOwnerCapture,claim:this.target.claim};return {...intent,logicalOperationKey:nativeLogicalOperationKey(intent)};}
  private async lookup(value:unknown):Promise<Lookup>{
    // MATERIALIZED evaluates the protected JSON function once; CASE bounds it
    // in SQL before pg allocates/deserializes the returned object.
    return this.db.accountTransaction(this.target.accountId,async tx=>{
      const rows=(await tx.client.query<{state:Lookup|null}>(`WITH receipt_lookup AS MATERIALIZED(SELECT manga_web.native_receipt_lookup($1::jsonb) AS value)
        SELECT CASE WHEN octet_length(value::text)<=$2 THEN value ELSE NULL END AS state FROM receipt_lookup`,[JSON.stringify(value),this.#lookupMaximum])).rows;
      requireCondition(rows.length===1&&rows[0].state!==null,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
      const checked=rows[0].state!;nativeJsonBytes(checked,this.#lookupMaximum);return checked;
    });
  }
  sealedRecord(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):NativeSealedReceipt{
    // Read-only data is never a JOIN capability. The owning gateway calls its
    // captured method only after the hidden original facade method has returned.
    const sampled=this.sample(task,metadata,inputs),record=this.#verified.get(sampled.operationInputDigest);
    requireCondition(record,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');
    nativeJsonBytes(record,this.#lookupMaximum);return structuredClone(record);
  }
  async read(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):Promise<NativeSemanticCacheRead>{
    const query=this.query(task,metadata,inputs);let response:Lookup;
    try{response=await this.lookup(query.lookup);}
    catch{this.unknown('NATIVE_RECEIPT_UNCONFIRMED',this.prospective(query));}
    if(response.state==='MISS')return {state:'MISS'};
    let intent=this.prospective(query);
    try{if(response.intent)intent=validateNativeJobIntent(response.intent);}catch{this.unknown('NATIVE_RECEIPT_UNCONFIRMED',intent);}
    if(response.state==='CONFLICT'||!response.candidate)this.unknown(response.reason??'NATIVE_RECEIPT_UNCONFIRMED',intent,physical(response.termination,intent));
    try{
      const {candidate,result}=validateNativeReceiptCandidate(response.candidate,this.limits.output,this.limits.input);
      requireCondition(candidate.operationInputDigest===query.operationInputDigest&&candidate.kernelImplementationDigest===this.kernelImplementationDigest&&intent.operationInputDigest===query.operationInputDigest&&intent.jobId===result.jobId&&intent.task===task&&intent.taskVersion===result.taskVersion&&intent.profileDigest===query.job.profileDigest&&intent.inputDigest===result.inputDigest,'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');
      if(response.receipt){const proof=keys(response.receipt,['version','candidateId','kernelImplementationDigest','verificationVersion','blobs']);requireCondition(proof.version===1&&proof.candidateId===candidate.candidateId&&proof.kernelImplementationDigest===this.kernelImplementationDigest&&proof.verificationVersion===nativeFacadeVerificationVersion&&Array.isArray(proof.blobs)&&proof.blobs.length===candidate.blobs.length,'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');}
      const blobs=new Map<string,Buffer>();
      // Total lengths and count were checked above, before any object read.
      for(const ref of candidate.blobs){const key=`${this.target.accountId}/${ref.assetId}`,proof=await this.objects.receipt(key);requireCondition(proof,'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');objectReceipt(proof,key,ref.sha256,ref.bytesLength);const bytes=await this.objects.read(key);requireCondition(bytes.length.toString()===ref.bytesLength&&sha256(bytes)===ref.sha256,'NATIVE_RECEIPT_OBJECT_CONFLICT',409,'WAIT');blobs.set(ref.blobId,bytes);}
      requireCondition(digest(describeNativeBlobs(blobs,this.limits.output))===digest(result.blobs),'NATIVE_RECEIPT_OBJECT_CONFLICT',409,'WAIT');
      // Repeat the fresh target/retention fence after storage waits. A pending
      // original candidate is recoverable only when every original object has
      // its actual receipt and GET proof. Its final DB seal follows facade checks.
      const checked=await this.lookup(query.lookup);
      requireCondition(checked.state!=='MISS'&&checked.state!=='CONFLICT'&&checked.candidate&&digest(checked.candidate)===digest(candidate),'NATIVE_RECEIPT_FENCE_REJECTED',409,'WAIT');
      this.candidates.set(query.operationInputDigest,{candidate,result,intent,termination:physical(response.termination,intent),proof:response.receipt,fresh:false,putAttempted:new Set()});return {state:'VERIFIED',result,blobs,operationInputDigest:query.operationInputDigest};
    }catch(error){if(error instanceof NativeJobError)throw error;this.unknown(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',intent,physical(response.termination,intent));}
  }
  private async decide(sql:string,params:unknown[],intent:NativeJobIntent,termination:NativeTermination){
    try{const result=await this.db.accountTransaction(this.target.accountId,async tx=>(await tx.client.query<{decision:Decision}>(sql,params)).rows[0].decision);requireCondition(result.allowed,result.reason,409,'WAIT');return result;}
    catch(error){if(error instanceof NativeJobError)throw error;this.unknown(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',intent,termination);}
  }
  async seal(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,computation:NativeComputation):Promise<void>{
    const query=this.query(task,metadata,inputs);let record=this.candidates.get(query.operationInputDigest),produced:NativeReceiptProduced|undefined;
    try{
    if(!record){produced=this.source(task,metadata,inputs,computation);requireCondition(produced.intent.operationInputDigest===query.operationInputDigest,'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');
      const raw=canonicalize(produced.result);requireCondition(raw,'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');
      const {inputDigest:_inputDigest,...originalInput}=produced.job;const inputCanonical=canonicalize(originalInput);requireCondition(inputCanonical,'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');
      const candidate:NativeReceiptCandidate={version:1,candidateId:randomUUID(),jobId:produced.intent.jobId,parentInstanceId:produced.intent.parentInstanceId,operationInputDigest:query.operationInputDigest,kernelImplementationDigest:this.kernelImplementationDigest,verificationVersion:nativeFacadeVerificationVersion,resultObservationId:produced.resultObservationId,resultObservationDigest:produced.resultObservationDigest,resultDigest:digest(produced.result),inputCanonical,resultCanonical:raw,blobs:produced.result.blobs.map(ref=>({blobId:ref.id,assetId:randomUUID(),sha256:ref.sha256,bytesLength:String(ref.byteLength)}))};
      validateNativeReceiptCandidate(candidate,this.limits.output,this.limits.input);nativeJsonBytes(candidate,16777216);
      record={candidate,result:produced.result,intent:produced.intent,termination:produced.termination,fresh:false,putAttempted:new Set()};this.candidates.set(query.operationInputDigest,record);
      const prepared=await this.decide('SELECT manga_web.native_receipt_prepare($1::jsonb,$2::jsonb) AS decision',[JSON.stringify(candidate),JSON.stringify(query.lookup)],produced.intent,produced.termination);
      requireCondition(prepared.candidate&&digest(prepared.candidate)===digest(candidate),'NATIVE_RECEIPT_CANDIDATE_CONFLICT',409,'WAIT');record.fresh=true;
    }
      requireCondition(digest(computation.metadata)===digest(record.result.metadata)&&digest(describeNativeBlobs(computation.blobs,this.limits.output))===digest(record.result.blobs),'NATIVE_RECEIPT_RESULT_CONFLICT',409,'WAIT');
      const proof:NativeVerifiedReceipt={version:1,candidateId:record.candidate.candidateId,kernelImplementationDigest:this.kernelImplementationDigest,verificationVersion:nativeFacadeVerificationVersion,blobs:[]};
      for(const ref of record.candidate.blobs){const key=`${this.target.accountId}/${ref.assetId}`;let receipt=await this.objects.receipt(key);
        // Only this original fresh candidate can PUT. A restart/cache load is
        // allowed to compare existing receipts, never to repeat a missing PUT.
        if(!receipt){requireCondition(record.fresh&&!record.proof&&!record.putAttempted.has(ref.blobId),'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');record.putAttempted.add(ref.blobId);const bytes=computation.blobs.get(ref.blobId)!;receipt=await this.objects.put(key,bytes);}
        const actual=objectReceipt(receipt,key,ref.sha256,ref.bytesLength),bytes=await this.objects.read(key);requireCondition(sha256(bytes)===ref.sha256&&String(bytes.length)===ref.bytesLength,'NATIVE_RECEIPT_OBJECT_CONFLICT',409,'WAIT');
        if(!record.proof)await this.decide('SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,$5::jsonb) AS decision',[record.candidate.candidateId,ref.blobId,JSON.stringify(actual),this.objects.bucket,JSON.stringify(query.lookup)],record.intent,record.termination);
        proof.blobs.push({blobId:ref.blobId,receipt:actual});
      }
      if(record.proof)requireCondition(digest(record.proof)===digest(proof),'NATIVE_RECEIPT_OBJECT_CONFLICT',409,'WAIT');
      await this.decide('SELECT manga_web.native_receipt_verify($1,$2::jsonb,$3::jsonb) AS decision',[record.candidate.candidateId,JSON.stringify(proof),JSON.stringify(query.lookup)],record.intent,record.termination);record.proof=proof;
      const sealed:NativeSealedReceipt={candidate:record.candidate,receipt:proof,intent:record.intent,termination:record.termination,origin:record.fresh?'FRESH':'CACHE'};
      nativeJsonBytes(sealed,this.#lookupMaximum);this.#verified.set(query.operationInputDigest,structuredClone(sealed));
    }catch(error){if(error instanceof NativeJobError)throw error;const origin=record?.intent??produced?.intent??this.prospective(query),termination=record?.termination??produced?.termination;throw new NativeJobError(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT',termination??physical(null,origin));}
  }
  async onValidationFailure(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,computation:NativeComputation,error:unknown):Promise<never>{
    const query=this.query(task,metadata,inputs),cached=this.candidates.get(query.operationInputDigest);let produced:NativeReceiptProduced|undefined;
    if(!cached)try{produced=this.source(task,metadata,inputs,computation);}catch(error){if(error instanceof NativeJobError)throw error;this.unknown('NATIVE_RECEIPT_UNCONFIRMED',this.prospective(query));}
    if(produced&&this.rejected)try{await this.rejected(produced,error);}catch{this.unknown('NATIVE_EVIDENCE_UNCONFIRMED',produced.intent,produced.termination);}
    const intent=cached?.intent??produced!.intent,termination=cached?.termination??produced!.termination;
    this.unknown(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_OUTPUT_INVALID',intent,termination);
  }
}

// Retention follows original refs even when PUT finished before asset registration.
// Missing/unknown receipt is retained; this function never PUTs or deletes it.
export async function reconcileNativeLibraryObjects(db:Database,objects:ObjectStore,accountId:string,limits:Readonly<NativeFrameLimits>):Promise<void>{
  let after:{at:string;id:string}|undefined,through:Date|undefined;
  for(;;){
    const candidates=await db.accountTransaction(accountId,async tx=>{through??=tx.now;return (await tx.client.query<{candidate_id:string;created_at_cursor:string;blobs:NativeReceiptBlob[]}>('SELECT * FROM manga_web.native_receipt_library_candidates($1,$2,$3)',[after?.at??null,after?.id??null,through])).rows;},true);
    for(const candidate of candidates){
      // Advance over every original candidate, including a version/limit HOLD.
      requireCondition(typeof candidate.created_at_cursor==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(candidate.created_at_cursor)&&uuid.test(candidate.candidate_id),'NATIVE_RECEIPT_INVALID',409,'WAIT');
      after={at:candidate.created_at_cursor,id:candidate.candidate_id};
      let refs:NativeReceiptBlob[];try{refs=validateNativeReceiptBlobs(candidate.blobs,limits);}catch{continue;}
      for(const ref of refs){const key=`${accountId}/${ref.assetId}`;try{const proof=await objects.receipt(key);if(!proof)continue;objectReceipt(proof,key,ref.sha256,ref.bytesLength);const bytes=await objects.read(key);if(sha256(bytes)!==ref.sha256||String(bytes.length)!==ref.bytesLength)continue;await db.accountTransaction(accountId,async tx=>{const result=(await tx.client.query<{decision:Decision}>('SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,NULL) AS decision',[candidate.candidate_id,ref.blobId,JSON.stringify(proof),objects.bucket])).rows[0].decision;requireCondition(result.allowed,result.reason,409,'WAIT');},true);}catch{/* Preserve unknown original receipts and references. */}}
    }
    if(candidates.length<16)return;
  }
}

export type NativeReceiptCandidateV2=Omit<NativeReceiptCandidate,'version'>&{version:2;windowsEvidenceRef:WindowsEvidenceRef};
export type NativeVerifiedReceiptV2=Omit<NativeVerifiedReceipt,'version'>&{version:2;windowsEvidenceRef:WindowsEvidenceRef};
export type NativeReceiptProducedV2=Omit<NativeReceiptProduced,'termination'>&{sourceInput:NativeSourceInputRef;windowsEvidenceRef:WindowsEvidenceRef;terminationObservationId:string;terminationObservationDigest:string;termination:NativeTerminationV2};
export type NativeReceiptSourceV2=(task:NativeTask,metadata:Record<string,unknown>,inputBlobs:Map<string,Buffer>,computation:NativeComputation)=>NativeReceiptProducedV2;
export type NativeSealedReceiptV2={candidate:NativeReceiptCandidateV2;receipt:NativeVerifiedReceiptV2;intent:NativeJobIntent;termination:NativeTerminationV2;origin:'FRESH'|'CACHE'};
export interface NativeWindowsReceiptStore extends NativeSemanticCache{sealedWindowsRecord(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):NativeSealedReceiptV2;}
type WindowsObservation={evidenceId:string;evidenceDigest:string;value:NativeJobObservationV2};
export type WindowsNativeOriginalReceiptFacts={intent:NativeJobIntent;sourceInput:NativeSourceInputRef;windowsEvidenceRef:WindowsEvidenceRef;rawResult:NativeRawResultReference|null;resultObservation:WindowsObservation|null;terminationObservation:WindowsObservation;termination:NativeTerminationV2};
const windowsReplyMaximum=12*131072;
const windowsBounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
function windowsMust(condition:unknown,code='NATIVE_RECEIPT_UNCONFIRMED'):asserts condition{requireCondition(condition,code,409,'WAIT');}
function windowsKeys(value:unknown,expected:string[]):Record<string,unknown>{windowsMust(!types.isProxy(value));return keys(value,expected);}
function windowsSame(a:unknown,b:unknown){windowsMust(digest(a)===digest(b),'NATIVE_RECEIPT_RESULT_CONFLICT');}
function windowsRef(value:unknown):WindowsEvidenceRef{
  const ref=windowsKeys(value,['recordId','recordDigest','linkId','linkDigest']);
  for(const k of ['recordId','linkId'])windowsMust(typeof ref[k]==='string'&&uuid.test(ref[k] as string),'NATIVE_RECEIPT_INVALID');
  for(const k of ['recordDigest','linkDigest'])windowsMust(typeof ref[k]==='string'&&hash.test(ref[k] as string),'NATIVE_RECEIPT_INVALID');
  return structuredClone(ref) as WindowsEvidenceRef;
}
export function validateNativeReceiptCandidateV2(value:unknown,limits:NativeFrameLimits,inputLimits:NativeFrameLimits=limits):{candidate:NativeReceiptCandidateV2;result:NativeResult}{
  const item=windowsKeys(value,['version','candidateId','jobId','parentInstanceId','operationInputDigest','kernelImplementationDigest','verificationVersion','resultObservationId','resultObservationDigest','resultDigest','inputCanonical','resultCanonical','blobs','windowsEvidenceRef']);
  if(item.version!==2||item.verificationVersion!==nativeFacadeVerificationVersion)fail();windowsRef(item.windowsEvidenceRef);nativeJsonBytes(item.blobs,16777216);
  return receiptCandidateFields<NativeReceiptCandidateV2>(item,limits,inputLimits);
}
function windowsProof(value:unknown,candidate:NativeReceiptCandidateV2,accountId:string):NativeVerifiedReceiptV2{
  const proof=windowsKeys(value,['version','candidateId','kernelImplementationDigest','verificationVersion','blobs','windowsEvidenceRef']);
  windowsMust(proof.version===2&&proof.candidateId===candidate.candidateId&&proof.kernelImplementationDigest===candidate.kernelImplementationDigest&&proof.verificationVersion===nativeFacadeVerificationVersion&&Array.isArray(proof.blobs)&&proof.blobs.length===candidate.blobs.length,'NATIVE_RECEIPT_RESULT_CONFLICT');
  windowsSame(windowsRef(proof.windowsEvidenceRef),candidate.windowsEvidenceRef);
  for(const [index,value] of (proof.blobs as unknown[]).entries()){
    const entry=windowsKeys(value,['blobId','receipt']),ref=candidate.blobs[index];windowsMust(entry.blobId===ref.blobId,'NATIVE_RECEIPT_OBJECT_CONFLICT');objectReceipt(entry.receipt,`${accountId}/${ref.assetId}`,ref.sha256,ref.bytesLength);
  }
  return structuredClone(proof) as NativeVerifiedReceiptV2;
}
type OriginalIntentRow={reservation_id:string;source_execution_id:string;source_input_evidence_id:string;protected_intent:NativeJobIntent;intent_digest:string;actual_digest:string;owner_service:string;profile_id:string;profile_digest:string;profile_version:string};
// 원 provenance만 확인한다. 현재 lease/owner/retention 허가는 receipt SQL의 별도 책임이다.
export type WindowsNativeCostRef={evidenceId:string;evidenceDigest:string};
export type WindowsNativeOriginalKey={binding:NativeControllerBinding;expected:WindowsEvidenceRef};
export type WindowsNativeEvidenceFacts={
  version:1;binding:NativeControllerBinding;adoptionId:string;ownerService:'trio_web_api'|'trio_web_worker';capacity:WindowsNativeCapacityConfiguration;
  source:{input:NativeSourceInputRef;inputEvidence:WindowsNativeCostRef;inputFingerprint:string;basisRef:WindowsNativeCostRef|null};
  originDigest:string;intentDigest:string;windowsEvidenceRef:WindowsEvidenceRef;goGrantRef:{jobId:string;rowDigest:string}|null;rawResult:NativeRawResultReference|null;
  observations:{result:WindowsNativeCostRef|null;termination:WindowsNativeCostRef};termination:NativeTerminationV2;
  accounting:{event:{eventId:string;payloadDigest:string;sourceDigest:string};value:WindowsJobAccounting}|null;
  records:{parentJoin:{recordId:string;digest:string};finalized:{recordId:string;digest:string}};link:{canonical:string;signature:string};
};
export type WindowsNativeOperationValue={
  version:1;binding:NativeControllerBinding;adoptionId:string;capacityRef:WindowsNativeCapacityConfiguration['reference'];source:WindowsNativeEvidenceFacts['source'];
  originDigest:string;intentDigest:string;windowsEvidenceRef:WindowsEvidenceRef;goGrantRef:WindowsNativeEvidenceFacts['goGrantRef'];rawResult:WindowsNativeEvidenceFacts['rawResult'];
  observations:WindowsNativeEvidenceFacts['observations'];accounting:WindowsNativeEvidenceFacts['accounting'];records:WindowsNativeEvidenceFacts['records'];
};
export type WindowsNativeTerminationValue={
  version:1;jobId:string;parentInstanceId:string;capacityReservationId:string;source:WindowsNativeEvidenceFacts['source'];originDigest:string;
  windowsEvidenceRef:WindowsEvidenceRef;terminationObservation:WindowsNativeCostRef;termination:NativeTerminationV2;records:WindowsNativeEvidenceFacts['records'];
};
export type WindowsNativeProofMetadata={
  version:2;kind:'WINDOWS_JOB_OBJECT';binding:NativeControllerBinding;adoptionId:string;capacityRef:WindowsNativeCapacityConfiguration['reference'];
  source:WindowsNativeEvidenceFacts['source'];originDigest:string;intentDigest:string;windowsEvidenceRef:WindowsEvidenceRef;terminationObservation:WindowsNativeCostRef;accountingDigest:string|null;
};
function windowsFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))windowsFreeze(item);Object.freeze(value);}return value;}
function windowsData(value:unknown,maximum:number):void{
  nativeJsonBytes(value,maximum);
  // nativeJsonBytes rejects accessors/proxies first; also close array-only hidden keys.
  const visit=(item:unknown):void=>{if(item&&typeof item==='object'){if(Array.isArray(item))windowsMust(Object.getPrototypeOf(item)===Array.prototype&&Reflect.ownKeys(item).length===item.length+1);for(const child of Object.values(item))visit(child);}};visit(value);
}
export function validateWindowsNativeOriginalKey(value:unknown):WindowsNativeOriginalKey{
  try{windowsData(value,4096);const key=windowsKeys(value,['binding','expected']);return windowsFreeze({binding:validateNativeControllerBinding(key.binding),expected:windowsRef(key.expected)});}
  catch(error){throw new DomainError(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');}
}
// Same historical checks serve the v1 seven-key reader and both new role wrappers.
// Adoption is required only by the new facts contract; the legacy receipt has no adoption field.
function windowsOriginalCore(stateValue:unknown,observationDigests:unknown,original:unknown,job:NativeJob,key:WindowsNativeOriginalKey,ownerService:'trio_web_api'|'trio_web_worker'):{receipt:WindowsNativeOriginalReceiptFacts;facts:Omit<WindowsNativeEvidenceFacts,'adoptionId'>}{
  // 기존 reader의 state 예산과 별도 조회 자료를 중복 합산하지 않는다. W4 bundle 전체 상한은 공개 wrapper가 검사한다.
  windowsData(stateValue,windowsReplyMaximum);windowsData({observationDigests,original,job},windowsReplyMaximum);const {binding,expected}=key;
  const response=windowsKeys(stateValue,['allowed','view','facts']);windowsMust(response.allowed===true);
  const view=windowsKeys(response.view,['capture','record','windowsEvidenceRef']),facts=windowsKeys(response.facts,['capacity','input','basis','goGrantRef','rawResult','observations','records','link','peer']);
  windowsSame(windowsRef(view.windowsEvidenceRef),expected);
  const capture=windowsKeys(view.capture,['origin','originDigest','frameInputDigest','launchRef']);windowsMust(typeof capture.launchRef==='string'&&uuid.test(capture.launchRef));
  nativeJsonBytes(capture.origin,131072);const o=windowsKeys(capture.origin,['identity','authority','pins','policy','limits']) as unknown as OriginalCapture['origin'];
  const authority=windowsKeys(o.authority,['attemptId','controllerInstanceId','controllerId','keyVersion','environmentDigest','hostEpochId','sessionId','launchId','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest']);
  const calculated=digest({identity:o.identity,authority:o.authority,pins:o.pins,policy:o.policy,nativeLimitsDigest:digest(o.limits),frameInputDigest:binding.inputDigest});
  windowsMust(capture.originDigest===calculated&&capture.frameInputDigest===binding.inputDigest);
  const control=decodeWindowsControl(encodeWindowsControl({version:1,requestId:authority.attemptId as string,originDigest:calculated,attemptId:authority.attemptId as string,sessionId:authority.sessionId as string,launchId:authority.launchId as string,command:'PREPARE',payload:{origin:o,launchRef:capture.launchRef as string}}));windowsMust(control.command==='PREPARE');
  nativeJsonBytes(job,131072);validateNativeEnvelope(job,{maxMetadataBytes:o.limits.maxMetadataBytes,maxBinaryBytes:o.limits.maxInputBytes,maxItems:o.limits.maxItems});verifyNativeInput(job);
  windowsMust(job.jobId===binding.jobId&&job.inputDigest===binding.inputDigest&&job.profileDigest===binding.profileDigest);
  windowsSame(o.identity.binding,binding);const sourceInput=validateNativeSourceInput(o.identity.sourceInput);
  const admission=validateNativeCapacityAdmission(facts.capacity);windowsSame(admission.sourceInput,sourceInput);
  const capacity=validateNativeCapacityConfiguration({reference:admission.reference,profile:admission.profile},binding.profileDigest,binding.kernelDigest);windowsMust(capacity.profile.kind==='WINDOWS_JOB_OBJECT');
  const p=capacity.profile;windowsMust(p.controllerId===o.authority.controllerId&&p.keyVersion===o.authority.keyVersion&&p.environmentDigest===o.authority.environmentDigest&&p.windows.hostEpochId===o.authority.hostEpochId);
  windowsSame(p.windows.policy,o.policy);windowsSame(p.windows.pins,o.pins);windowsMust(o.pins.nativeLimitsDigest===digest(o.limits));
  for(const k of ['controllerSidDigest','childSidDigest','appContainerSidDigest'] as const)windowsMust(p.windows[k]===o.authority[k]);
  const peer=windowsKeys(facts.peer,['serviceRole','peerId']);windowsMust(peer.serviceRole===ownerService&&typeof peer.peerId==='string'&&uuid.test(peer.peerId));
  const row=windowsKeys(original,['reservationId','sourceExecutionId','sourceInputEvidenceId','ownerService','profileId','profileDigest','profileVersion','protectedIntent','intentDigest','actualIntentDigest']),intent=validateNativeJobIntent(row.protectedIntent);
  windowsMust(row.ownerService===ownerService&&row.reservationId===binding.capacityReservationId&&typeof row.intentDigest==='string'&&hash.test(row.intentDigest)&&row.intentDigest===row.actualIntentDigest&&row.intentDigest===o.identity.intentDigest&&row.sourceExecutionId===sourceInput.executionId&&row.sourceInputEvidenceId===sourceInput.inputEvidenceId&&row.profileId===capacity.reference.profileId&&row.profileDigest===capacity.reference.profileDigest&&row.profileVersion===capacity.reference.profileVersion);
  windowsMust(intent.jobId===job.jobId&&intent.parentInstanceId===binding.parentInstanceId&&intent.inputDigest===job.inputDigest&&intent.profileDigest===job.profileDigest&&intent.task===job.task&&intent.taskVersion===job.taskVersion&&intent.operationInputDigest===nativeOperationInputDigest(job));
  const inputRow=windowsKeys(facts.input,['evidenceId','evidenceDigest','value']);nativeJsonBytes(inputRow.value,131072);const input=inputRow.value as StageInput;
  windowsMust(input&&input.envelope&&inputRow.evidenceId===sourceInput.inputEvidenceId&&inputRow.evidenceDigest===o.identity.inputEvidenceDigest&&inputRow.evidenceDigest===o.identity.inputFingerprint&&digest(input)===inputRow.evidenceDigest&&digest(canonicalInput(input))===inputRow.evidenceDigest&&input.accountId===binding.accountId&&input.executionId===sourceInput.executionId&&input.inputDigest===sourceInput.stageInputDigest);
  assertWire('stageInputEnvelope',input.envelope);windowsMust(input.envelope.requestId===input.requestId&&input.envelope.executionId===input.executionId&&input.envelope.logicalStepId===input.stage&&input.envelope.inputDigest===input.inputDigest&&input.envelope.contextId===input.contextId&&input.envelope.stageContract===input.settings.contractVersion);windowsSame(input.envelope.capturedSettings,input.settings);
  let basisRef:{evidenceId:string;evidenceDigest:string}|null=null;
  if(facts.basis!==null){
    const basis=windowsKeys(facts.basis,['evidenceId','evidenceDigest','value']);nativeJsonBytes(basis.value,131072);windowsMust(typeof basis.evidenceId==='string'&&uuid.test(basis.evidenceId)&&typeof basis.evidenceDigest==='string'&&hash.test(basis.evidenceDigest)&&digest(basis.value)===basis.evidenceDigest);
    const wrapper=windowsKeys(basis.value,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);windowsMust(wrapper.version===1&&wrapper.accountId===binding.accountId&&wrapper.executionId===sourceInput.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===inputRow.evidenceDigest&&wrapper.kind==='OPERATIONAL_COST_BASIS');
    const b=windowsKeys(wrapper.value,['version','capture','captureDigest','snapshot','snapshotDigest']),c=windowsKeys(b.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const {captureDigest:claimed,...body}=c;windowsMust(b.version===1&&c.accountId===binding.accountId&&c.executionId===input.executionId&&c.inputDigest===input.inputDigest&&c.inputFingerprint===inputRow.evidenceDigest&&c.stage===input.stage&&typeof c.profileDigest==='string'&&hash.test(c.profileDigest)&&['FREE','PAID'].includes(String(c.mode))&&claimed===digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture:body})&&b.captureDigest===claimed&&b.snapshotDigest===(b.snapshot===null?null:digest(b.snapshot)));
    basisRef={evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest};
  }
  if(o.identity.basisRef!==null)windowsSame(o.identity.basisRef,basisRef);
  const record=windowsKeys(view.record,['ref','envelope']),ref=windowsKeys(record.ref,['recordId','digest']);windowsMust(ref.recordId===expected.recordId&&ref.digest===expected.recordDigest);
  const envelope=windowsKeys(record.envelope,['version','originDigest','evidence','entries','parentJoinAck']) as unknown as WindowsSealEnvelope;
  windowsMust(envelope.version===1&&envelope.originDigest===calculated&&digest(envelope)===expected.recordDigest);
  const evidence=validateWindowsJobEvidence(envelope.evidence,windowsBounds),kind=classifyWindowsJobEvidence(evidence);windowsMust(kind!=='UNCONFIRMED');windowsSame(evidence.identity,o.identity);windowsSame(evidence.authority,o.authority);windowsSame(evidence.pins,o.pins);windowsSame(evidence.policy.requested,o.policy);
  windowsMust(Array.isArray(envelope.entries)&&envelope.entries.length===evidence.lifecycle.events.length&&envelope.entries.length<=64);
  for(const [index,value] of envelope.entries.entries()){const entry=windowsKeys(value,['eventId','payloadDigest','sourceDigest']);windowsMust(entry.eventId===evidence.lifecycle.events[index].eventId&&entry.payloadDigest===evidence.lifecycle.events[index].payloadDigest&&typeof entry.sourceDigest==='string'&&hash.test(entry.sourceDigest));}
  windowsMust(Array.isArray(facts.records)&&facts.records.length>=3&&facts.records.length<=4);const records=new Map<string,{recordId:string;digest:string;value:unknown}>(),ids=new Set<string>();
  for(const value of facts.records as unknown[]){const r=windowsKeys(value,['purpose','recordId','digest','value']);nativeJsonBytes(r.value,65536);windowsMust(typeof r.purpose==='string'&&['READY','PARENT_JOIN','SEAL','FINALIZED'].includes(r.purpose)&&!records.has(r.purpose)&&typeof r.recordId==='string'&&uuid.test(r.recordId)&&!ids.has(r.recordId)&&r.digest===digest(r.value));ids.add(r.recordId);records.set(r.purpose,r as {recordId:string;digest:string;value:unknown});}
  const seal=records.get('SEAL'),parent=records.get('PARENT_JOIN'),final=records.get('FINALIZED');windowsMust(seal&&parent&&final&&seal.recordId===expected.recordId&&seal.digest===expected.recordDigest);windowsSame(seal.value,envelope);windowsSame(parent.value,envelope.parentJoinAck);
  const parentAck=windowsKeys(parent.value,['joinId','originDigest','digest']);windowsMust(parentAck.joinId===parent.recordId&&parentAck.originDigest===calculated&&typeof parentAck.digest==='string'&&hash.test(parentAck.digest));
  const finalValue=windowsKeys(final.value,['version','originDigest','finalized','brokerJoin']);windowsMust(finalValue.version===1&&finalValue.originDigest===calculated);windowsSame(finalValue.finalized,{recordId:expected.recordId,digest:expected.recordDigest,handles:'CLOSED',closeCode:null});windowsSame(finalValue.brokerJoin,{end:'EXPECTED',finalized:finalValue.finalized});
  let rawResult:NativeRawResultReference|null=null;if(facts.rawResult!==null){const raw=windowsKeys(facts.rawResult,['rawResultId','resultDigest']);windowsMust(typeof raw.rawResultId==='string'&&uuid.test(raw.rawResultId)&&typeof raw.resultDigest==='string'&&hash.test(raw.resultDigest));rawResult=raw as NativeRawResultReference;}
  const created=evidence.final.outcome==='JOB_EMPTY';windowsMust(created===(rawResult!==null));windowsSame(evidence.lifecycle.goGrantRef,facts.goGrantRef);
  if(created){const go=windowsKeys(facts.goGrantRef,['jobId','rowDigest']);windowsMust(go.jobId===job.jobId&&typeof go.rowDigest==='string'&&hash.test(go.rowDigest)&&evidence.lifecycle.goWrite==='RETURNED');}else windowsMust(facts.goGrantRef===null);
  const termination:NativeTerminationV2={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:evidence.lifecycle.goWrite!=='NOT_ATTEMPTED',startedComputation:rawResult!==null,directChildClosed:created,subtreeTerminationConfirmed:created,operationJoined:true,kind:created?'WINDOWS_JOB_EMPTY':'NO_CHILD_CREATED'};
  windowsMust(Array.isArray(facts.observations)&&facts.observations.length===(created?2:1)&&Array.isArray(observationDigests)&&observationDigests.length===facts.observations.length);
  const observations:WindowsObservation[]=[],observationIds=new Set<string>();
  for(const [index,value] of (facts.observations as unknown[]).entries()){
    const r=windowsKeys(value,['evidenceId','evidenceDigest','value']);windowsMust(typeof r.evidenceId==='string'&&uuid.test(r.evidenceId)&&!observationIds.has(r.evidenceId)&&typeof r.evidenceDigest==='string'&&hash.test(r.evidenceDigest)&&r.evidenceDigest===observationDigests[index]);observationIds.add(r.evidenceId);
    const observation=validateNativeJobObservationV2(r.value);windowsMust(observation.parentInstanceId===binding.parentInstanceId&&observation.code==='OK'&&observation.event===(created&&index===0?'RESULT':'TERMINATION')&&observation.resultDigest===(created&&index===0?rawResult!.resultDigest:null));windowsSame(observation.termination,{...termination,isolation:'WINDOWS_JOB_OBJECT'});windowsSame(observation.windowsRecordRef,{recordId:expected.recordId,recordDigest:expected.recordDigest});observations.push({evidenceId:r.evidenceId,evidenceDigest:r.evidenceDigest,value:observation});
  }
  const link=windowsKeys(facts.link,['linkId','canonical','digest','signature']);windowsMust(link.linkId===expected.linkId&&link.digest===expected.linkDigest&&typeof link.canonical==='string'&&Buffer.byteLength(link.canonical)<=32768&&sha256(link.canonical)===link.digest);
  const body={version:1,originDigest:calculated,identity:o.identity,basis:basisRef,goGrantRef:facts.goGrantRef,rawResult,record:{recordId:expected.recordId,recordDigest:expected.recordDigest},parentJoin:{recordId:parent.recordId,digest:parent.digest},finalized:{recordId:final.recordId,digest:final.digest},observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))};
  windowsMust(canonicalize(body)===link.canonical&&typeof link.signature==='string'&&/^[A-Za-z0-9+/]{86}==$/.test(link.signature));const signature=Buffer.from(link.signature,'base64');windowsMust(signature.length===64&&signature.toString('base64')===link.signature&&verify(null,Buffer.from(link.canonical),createPublicKey({key:Buffer.from(p.publicKeySpki,'base64'),format:'der',type:'spki'}),signature));

  const observationRef=({evidenceId,evidenceDigest}:WindowsObservation):WindowsNativeCostRef=>({evidenceId,evidenceDigest});
  const accountingIndex=evidence.lifecycle.events.findIndex(event=>event.kind==='FINAL_ACCOUNTING');
  windowsMust(!created||(accountingIndex>=0&&evidence.final.accounting!==null));
  const receipt=structuredClone({intent,sourceInput,windowsEvidenceRef:expected,rawResult,resultObservation:created?observations[0]:null,terminationObservation:observations.at(-1)!,termination});
  const derived:Omit<WindowsNativeEvidenceFacts,'adoptionId'>={version:1,binding,ownerService,capacity:capacity as WindowsNativeCapacityConfiguration,
    source:{input:sourceInput,inputEvidence:{evidenceId:inputRow.evidenceId as string,evidenceDigest:inputRow.evidenceDigest as string},inputFingerprint:o.identity.inputFingerprint,basisRef},originDigest:calculated,intentDigest:row.intentDigest as string,windowsEvidenceRef:expected,
    goGrantRef:facts.goGrantRef as WindowsNativeEvidenceFacts['goGrantRef'],rawResult,observations:{result:created?observationRef(observations[0]):null,termination:observationRef(observations.at(-1)!)},termination,
    accounting:created?{event:{...envelope.entries[accountingIndex]},value:evidence.final.accounting!}:null,records:{parentJoin:{recordId:parent.recordId,digest:parent.digest},finalized:{recordId:final.recordId,digest:final.digest}},link:{canonical:link.canonical as string,signature:link.signature as string}};
  return {receipt,facts:derived};
}
export function validateWindowsNativeEvidenceBundle(value:unknown,keyValue:WindowsNativeOriginalKey,ownerService:'trio_web_api'|'trio_web_worker'):WindowsNativeEvidenceFacts{
  try{
    windowsMust(ownerService==='trio_web_api'||ownerService==='trio_web_worker');const key=validateWindowsNativeOriginalKey(keyValue);windowsData(value,windowsReplyMaximum);
    const bundle=windowsKeys(value,['state','observationDigests','original','job']),original=windowsKeys(bundle.original,['reservationId','adoptionId','sourceExecutionId','sourceInputEvidenceId','ownerService','profileId','profileDigest','profileVersion','protectedIntent','intentDigest','actualIntentDigest']);
    windowsMust(typeof original.adoptionId==='string'&&uuid.test(original.adoptionId));const {adoptionId,...tuple}=original;
    const checked=windowsOriginalCore(bundle.state,bundle.observationDigests,tuple,bundle.job as NativeJob,key,ownerService),facts={...checked.facts,adoptionId:adoptionId as string};
    windowsData(facts,131072);return windowsFreeze(structuredClone(facts));
  }catch(error){if(error instanceof NativeJobErrorV2)throw error;throw new DomainError(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');}
}

export async function readWindowsNativeOriginal(db:Database,job:NativeJob,bindingValue:NativeControllerBinding,expectedValue:WindowsEvidenceRef,limits:{input:NativeFrameLimits;output:NativeFrameLimits}):Promise<WindowsNativeOriginalReceiptFacts>{
  try{
    windowsMust(db.role==='trio_web_api'||db.role==='trio_web_worker');const ownerService=db.role,{binding,expected}=validateWindowsNativeOriginalKey({binding:bindingValue,expected:expectedValue});
    nativeJsonBytes(job,limits.input.maxMetadataBytes);validateNativeEnvelope(job,limits.input);verifyNativeInput(job);
    windowsMust(job.jobId===binding.jobId&&job.inputDigest===binding.inputDigest&&job.profileDigest===binding.profileDigest);
    return await db.accountTransaction(binding.accountId,async tx=>{
      const rows=(await tx.client.query<{state:unknown;observation_digests:string[]}>(`WITH windows_lookup AS MATERIALIZED(SELECT manga_web.windows_native_lookup($1::jsonb) AS value)
        SELECT CASE WHEN octet_length(payload::text)<=$2::integer THEN payload->'state' ELSE NULL END AS state,
          CASE WHEN octet_length(payload::text)<=$2::integer THEN payload->'observation_digests' ELSE NULL END AS observation_digests
        FROM windows_lookup CROSS JOIN LATERAL(
          SELECT jsonb_build_object('state',value,'observation_digests',
            (SELECT COALESCE(jsonb_agg(encode(sha256(convert_to((item->'value')::text,'UTF8')),'hex') ORDER BY ordinal),'[]'::jsonb)
             FROM jsonb_array_elements(CASE WHEN octet_length(value::text)<=$2::integer AND jsonb_typeof(value->'facts'->'observations')='array' THEN value->'facts'->'observations' ELSE '[]'::jsonb END) WITH ORDINALITY AS o(item,ordinal))) AS payload
        ) AS protected_reply`,[JSON.stringify({binding,expected}),windowsReplyMaximum])).rows;
      windowsMust(rows.length===1&&rows[0].state!==null);nativeJsonBytes(rows[0].state,windowsReplyMaximum);
      const owning=(await tx.client.query<OriginalIntentRow>(`SELECT r.reservation_id,r.source_execution_id,r.source_input_evidence_id,r.owner_service,r.profile_id,r.profile_digest,r.profile_version,
        i.protected_intent,i.intent_digest,encode(sha256(convert_to(i.protected_intent::text,'UTF8')),'hex') AS actual_digest
        FROM manga_web.native_job_intents i JOIN manga_web.native_capacity_reservations r USING(account_id,job_id)
        WHERE i.account_id=$1 AND i.job_id=$2 AND i.owner_service=$3 AND r.reservation_id=$4 LIMIT 2`,[binding.accountId,job.jobId,db.role,binding.capacityReservationId])).rows;
      windowsMust(owning.length===1);const row=owning[0];
      const original={reservationId:row.reservation_id,sourceExecutionId:row.source_execution_id,sourceInputEvidenceId:row.source_input_evidence_id,ownerService:row.owner_service,profileId:row.profile_id,profileDigest:row.profile_digest,profileVersion:row.profile_version,protectedIntent:row.protected_intent,intentDigest:row.intent_digest,actualIntentDigest:row.actual_digest};
      return windowsOriginalCore(rows[0].state,rows[0].observation_digests,original,job,{binding,expected},ownerService).receipt;
    },true);
  }catch(error){if(error instanceof NativeJobErrorV2)throw error;throw new DomainError(error instanceof DomainError&&error.code.startsWith('NATIVE_')?error.code:'NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT');}
}

type WindowsLookup={state:'MISS'|'VERIFIED'|'PENDING_OR_UNCONFIRMED'|'CONFLICT';reason?:string;candidate?:unknown;receipt?:unknown;intent?:NativeJobIntent;termination?:unknown};
type WindowsCandidateRecord={candidate:NativeReceiptCandidateV2;result:NativeResult;intent:NativeJobIntent;termination:NativeTerminationV2;proof:NativeVerifiedReceiptV2|null;fresh:boolean;prepared:boolean;putAttempted:Set<string>};
function windowsTermination(value:unknown,intent:NativeJobIntent):NativeTerminationV2{
  if(value===null||value===undefined)return {jobId:intent.jobId,inputDigest:intent.inputDigest,profileDigest:intent.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'};
  const hasIsolation=Object.hasOwn(value as object,'isolation'),item=windowsKeys(value,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind',...(hasIsolation?['isolation']:[])]);
  windowsMust(!hasIsolation||item.isolation==='WINDOWS_JOB_OBJECT');windowsMust(item.jobId===intent.jobId&&item.inputDigest===intent.inputDigest&&item.profileDigest===intent.profileDigest);
  for(const key of ['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'])windowsMust(typeof item[key]==='boolean');windowsMust(!item.startedComputation||item.goAttempted);
  if(item.kind==='NO_CHILD_CREATED')windowsMust(item.operationJoined&&!item.goAttempted&&!item.startedComputation&&!item.directChildClosed&&!item.subtreeTerminationConfirmed);
  else if(item.kind==='WINDOWS_JOB_EMPTY')windowsMust(item.operationJoined&&item.directChildClosed&&item.subtreeTerminationConfirmed);
  else windowsMust(item.kind==='UNCONFIRMED'&&!item.subtreeTerminationConfirmed);
  const {isolation:_isolation,...termination}=item;void _isolation;return structuredClone(termination) as NativeTerminationV2;
}
// 명시적 Windows factory만 이 포트를 만든다. semantic cache 인터페이스는 그대로 유지한다.
class WindowsReceiptStore implements NativeWindowsReceiptStore{
  readonly facadeVerificationVersion=nativeFacadeVerificationVersion;
  readonly target:NativeTarget;
  private readonly limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>};
  private readonly lookupMaximum:number;
  private readonly candidates=new Map<string,WindowsCandidateRecord>();
  private readonly verified=new Map<string,NativeSealedReceiptV2>();
  constructor(readonly db:Database,readonly objects:ObjectStore,target:NativeTarget,readonly kernelImplementationDigest:string,limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>},private readonly source:NativeReceiptSourceV2,lookupMaximum?:number,private readonly costCall?:WindowsNativeCostCall){
    windowsMust((db.role==='trio_web_api'||db.role==='trio_web_worker')&&hash.test(kernelImplementationDigest)&&uuid.test(target.accountId),'NATIVE_RECEIPT_INVALID');
    nativeJsonBytes(target,8192);windowsKeys(target,['accountId','targetKind','targetId','semanticCaptureDigest','protectedOwnerCapture','claim',...(Object.hasOwn(target,'sourceInput')?['sourceInput']:[])]);
    this.target=Object.freeze({...structuredClone(target),protectedOwnerCapture:Object.freeze(structuredClone(target.protectedOwnerCapture)),claim:Object.freeze(structuredClone(target.claim)),...(target.sourceInput?{sourceInput:Object.freeze(validateNativeSourceInput(target.sourceInput))}:{})});
    const snapshot=(value:Readonly<NativeFrameLimits>)=>{windowsKeys(value,['maxMetadataBytes','maxBinaryBytes','maxItems']);windowsMust(Object.values(value).every(number=>Number.isSafeInteger(number)&&number>0),'NATIVE_RECEIPT_INVALID');return Object.freeze({...value});};
    this.limits={input:snapshot(limits.input),output:snapshot(limits.output)};this.lookupMaximum=lookupMaximum??Math.min(16777216,4*(this.limits.input.maxMetadataBytes+this.limits.output.maxMetadataBytes)+16384+this.limits.output.maxItems*1024);
    windowsMust(Number.isSafeInteger(this.lookupMaximum)&&this.lookupMaximum>0&&this.lookupMaximum<=16777216&&typeof source==='function','NATIVE_RECEIPT_INVALID');
  }
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>{return this.limits[direction];}
  private query(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>){
    const job=createNativeJob(task,digest(metadata.profile),metadata,inputs,this.limits.input),operationInputDigest=nativeOperationInputDigest(job);
    const captured={version:1 as const,jobId:job.jobId,task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest,parentInstanceId:randomUUID(),targetKind:this.target.targetKind,targetId:this.target.targetId,semanticCaptureDigest:this.target.semanticCaptureDigest,protectedOwnerCapture:this.target.protectedOwnerCapture,claim:this.target.claim};
    const prospective={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)};
    return {job,operationInputDigest,prospective,lookup:{version:1,targetKind:this.target.targetKind,targetId:this.target.targetId,semanticCaptureDigest:this.target.semanticCaptureDigest,protectedOwnerCapture:this.target.protectedOwnerCapture,claim:this.target.claim,task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,operationInputDigest,kernelImplementationDigest:this.kernelImplementationDigest}};
  }
  private unknown(code:string,intent:NativeJobIntent,termination?:NativeTerminationV2,ref:WindowsEvidenceRef|null=null):never{throw new NativeJobErrorV2(code,409,'WAIT',{version:2,termination:termination??windowsTermination(null,intent),windowsEvidenceRef:ref});}
  private async lookup(value:unknown):Promise<WindowsLookup>{
    return this.db.accountTransaction(this.target.accountId,async tx=>{
      const rows=(await tx.client.query<{state:unknown}>(this.costCall?`WITH receipt_lookup AS MATERIALIZED(SELECT manga_web.windows_native_cost_receipt_lookup($1,$2::jsonb) AS value)
        SELECT CASE WHEN octet_length(value::text)<=$3 THEN value ELSE NULL END AS state FROM receipt_lookup`:`WITH receipt_lookup AS MATERIALIZED(SELECT manga_web.native_receipt_lookup($1::jsonb) AS value)
        SELECT CASE WHEN octet_length(value::text)<=$2 THEN value ELSE NULL END AS state FROM receipt_lookup`,this.costCall?[this.costCall.callId,JSON.stringify(value),this.lookupMaximum]:[JSON.stringify(value),this.lookupMaximum])).rows;
      windowsMust(rows.length===1&&rows[0].state!==null);nativeJsonBytes(rows[0].state,this.lookupMaximum);
      const response=rows[0].state as WindowsLookup;windowsMust(response&&['MISS','VERIFIED','PENDING_OR_UNCONFIRMED','CONFLICT'].includes(response.state));return response;
    });
  }
  sealedWindowsRecord(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):NativeSealedReceiptV2{
    const query=this.query(task,metadata,inputs),record=this.verified.get(query.operationInputDigest);windowsMust(record);nativeJsonBytes(record,this.lookupMaximum);return structuredClone(record);
  }
  async read(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>):Promise<NativeSemanticCacheRead>{
    const query=this.query(task,metadata,inputs);let intent:NativeJobIntent=query.prospective,termination:NativeTerminationV2|undefined,ref:WindowsEvidenceRef|null=null;
    try{
      const response=await this.lookup(query.lookup);if(response.state==='MISS')return {state:'MISS'};
      windowsMust(response.intent);intent=validateNativeJobIntent(response.intent);
      if(response.termination)termination=windowsTermination(response.termination,intent);
      if(response.state==='CONFLICT'||!response.candidate)this.unknown(response.reason??'NATIVE_RECEIPT_UNCONFIRMED',intent,termination);
      const {candidate,result}=validateNativeReceiptCandidateV2(response.candidate,this.limits.output,this.limits.input);ref=candidate.windowsEvidenceRef;

      windowsMust(candidate.operationInputDigest===query.operationInputDigest&&candidate.kernelImplementationDigest===this.kernelImplementationDigest&&candidate.parentInstanceId===intent.parentInstanceId&&intent.operationInputDigest===query.operationInputDigest&&intent.jobId===result.jobId&&intent.task===task&&intent.taskVersion===result.taskVersion&&intent.profileDigest===query.job.profileDigest&&intent.inputDigest===result.inputDigest,'NATIVE_RECEIPT_RESULT_CONFLICT');
      let proof=response.receipt===null||response.receipt===undefined?null:windowsProof(response.receipt,candidate,this.target.accountId);windowsMust(response.state!=='VERIFIED'||proof);
      const originalJob={...parseStrictJson(candidate.inputCanonical,this.limits.input.maxMetadataBytes) as Omit<NativeJob,'inputDigest'>,inputDigest:result.inputDigest};
      const reservations=await this.db.accountTransaction(this.target.accountId,async tx=>(await tx.client.query<{reservation_id:string;source_execution_id:string;source_input_evidence_id:string}>(`SELECT reservation_id,source_execution_id,source_input_evidence_id FROM manga_web.native_capacity_reservations
        WHERE account_id=$1 AND job_id=$2 AND owner_service=$3 LIMIT 2`,[this.target.accountId,candidate.jobId,this.db.role])).rows,true);
      windowsMust(reservations.length===1&&typeof reservations[0].reservation_id==='string'&&uuid.test(reservations[0].reservation_id));
      const binding:NativeControllerBinding={accountId:this.target.accountId,capacityReservationId:reservations[0].reservation_id,jobId:candidate.jobId,parentInstanceId:candidate.parentInstanceId,inputDigest:result.inputDigest,profileDigest:result.profileDigest,kernelDigest:this.kernelImplementationDigest};
      const facts=await readWindowsNativeOriginal(this.db,originalJob,binding,ref,this.limits);
      windowsSame(facts.intent,intent);windowsMust(facts.sourceInput.executionId===reservations[0].source_execution_id&&facts.sourceInput.inputEvidenceId===reservations[0].source_input_evidence_id&&facts.rawResult?.resultDigest===candidate.resultDigest&&facts.resultObservation?.evidenceId===candidate.resultObservationId&&facts.resultObservation.evidenceDigest===candidate.resultObservationDigest,'NATIVE_RECEIPT_RESULT_CONFLICT');termination=facts.termination;
      if(this.costCall){const costs=costedReceiptJournals.get(this);windowsMust(costs&&proof);const used=await this.db.accountTransaction(this.target.accountId,tx=>costs.recordCacheUseIn(tx,this.costCall!,{candidate,receipt:proof,intent,termination:facts.termination,origin:'CACHE'}));windowsMust(used);}
      const blobs=new Map<string,Buffer>();
      for(const entry of candidate.blobs){const key=`${this.target.accountId}/${entry.assetId}`,receipt=await this.objects.receipt(key);windowsMust(receipt);const actual=objectReceipt(receipt,key,entry.sha256,entry.bytesLength);if(proof)windowsSame(proof.blobs.find(item=>item.blobId===entry.blobId)?.receipt,actual);const bytes=await this.objects.read(key);windowsMust(String(bytes.length)===entry.bytesLength&&sha256(bytes)===entry.sha256,'NATIVE_RECEIPT_OBJECT_CONFLICT');blobs.set(entry.blobId,bytes);}
      windowsSame(describeNativeBlobs(blobs,this.limits.output),result.blobs);
      const checked=await this.lookup(query.lookup);windowsMust(checked.state!=='MISS'&&checked.state!=='CONFLICT'&&checked.candidate,'NATIVE_RECEIPT_FENCE_REJECTED');windowsSame(checked.candidate,candidate);windowsSame(checked.intent,intent);
      windowsMust(checked.state!=='VERIFIED'||(checked.receipt!==null&&checked.receipt!==undefined),'NATIVE_RECEIPT_FENCE_REJECTED');
      if(checked.receipt!==null&&checked.receipt!==undefined){const current=windowsProof(checked.receipt,candidate,this.target.accountId);if(proof)windowsSame(current,proof);proof=current;}else windowsMust(proof===null,'NATIVE_RECEIPT_FENCE_REJECTED');
      this.candidates.set(query.operationInputDigest,{candidate,result,intent,termination,proof,fresh:false,prepared:true,putAttempted:new Set()});return {state:'VERIFIED',result,blobs,operationInputDigest:query.operationInputDigest};
    }catch(error){if(error instanceof NativeJobErrorV2)throw error;this.unknown(error instanceof DomainError?error.code:'NATIVE_RECEIPT_UNCONFIRMED',intent,termination,ref);}
  }
  private async decide(sql:string,values:unknown[],record:WindowsCandidateRecord):Promise<{allowed:boolean;reason:string;candidate?:NativeReceiptCandidateV2}>{
    if(this.costCall){
      if(sql.includes('native_receipt_prepare('))sql='SELECT manga_web.windows_native_cost_receipt_prepare($1,$2::jsonb,$3::jsonb) AS decision';
      else if(sql.includes('native_receipt_register_asset('))sql='SELECT manga_web.windows_native_cost_receipt_register_asset($1,$2,$3,$4::jsonb,$5,$6::jsonb) AS decision';
      else if(sql.includes('native_receipt_verify('))sql='SELECT manga_web.windows_native_cost_receipt_verify($1,$2,$3::jsonb,$4::jsonb) AS decision';
      else windowsMust(false);values=[this.costCall.callId,...values];
    }
    try{const rows=await this.db.accountTransaction(this.target.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string;candidate?:NativeReceiptCandidateV2}}>(sql,values)).rows);windowsMust(rows.length===1);const decision=rows[0].decision;nativeJsonBytes(decision,this.lookupMaximum);windowsMust(decision.allowed,decision.reason);return decision;}
    catch(error){if(error instanceof NativeJobErrorV2)throw error;this.unknown(error instanceof DomainError?error.code:'NATIVE_RECEIPT_UNCONFIRMED',record.intent,record.termination,record.candidate.windowsEvidenceRef);}
  }
  private produced(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,computation:NativeComputation,operationInputDigest:string):NativeReceiptProducedV2{
    const value=this.source(task,metadata,inputs,computation);nativeJsonBytes(value,this.lookupMaximum);windowsKeys(value,['intent','job','result','resultObservationId','resultObservationDigest','termination','sourceInput','windowsEvidenceRef','terminationObservationId','terminationObservationDigest']);
    const intent=validateNativeJobIntent(value.intent);validateNativeSourceInput(value.sourceInput);windowsRef(value.windowsEvidenceRef);const term=windowsTermination(value.termination,intent);
    windowsMust(term.kind==='WINDOWS_JOB_EMPTY'&&term.startedComputation&&term.goAttempted&&intent.operationInputDigest===operationInputDigest&&intent.jobId===value.job.jobId&&intent.inputDigest===value.job.inputDigest&&intent.profileDigest===value.job.profileDigest&&intent.task===task&&intent.taskVersion===value.job.taskVersion,'NATIVE_RECEIPT_RESULT_CONFLICT');
    windowsSame(value.job.metadata,metadata);windowsSame(value.job.blobs,describeNativeBlobs(inputs,this.limits.input));windowsSame(value.result.metadata,computation.metadata);windowsSame(value.result.blobs,describeNativeBlobs(computation.blobs,this.limits.output));
    for(const key of ['resultObservationId','terminationObservationId'] as const)windowsMust(uuid.test(value[key]));for(const key of ['resultObservationDigest','terminationObservationDigest'] as const)windowsMust(hash.test(value[key]));windowsMust(value.resultObservationId!==value.terminationObservationId);
    return value;
  }
  async seal(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,computation:NativeComputation):Promise<void>{
    const query=this.query(task,metadata,inputs);let record=this.candidates.get(query.operationInputDigest),produced:NativeReceiptProducedV2|undefined;
    try{
      if(!record){produced=this.produced(task,metadata,inputs,computation,query.operationInputDigest);const input={...produced.job};const {inputDigest:_inputDigest,...body}=input;void _inputDigest;
        const inputCanonical=canonicalize(body),resultCanonical=canonicalize(produced.result);windowsMust(inputCanonical&&resultCanonical,'NATIVE_RECEIPT_RESULT_CONFLICT');
        const candidate:NativeReceiptCandidateV2={version:2,candidateId:randomUUID(),jobId:produced.intent.jobId,parentInstanceId:produced.intent.parentInstanceId,operationInputDigest:query.operationInputDigest,kernelImplementationDigest:this.kernelImplementationDigest,verificationVersion:nativeFacadeVerificationVersion,resultObservationId:produced.resultObservationId,resultObservationDigest:produced.resultObservationDigest,resultDigest:digest(produced.result),inputCanonical,resultCanonical,blobs:produced.result.blobs.map(ref=>({blobId:ref.id,assetId:randomUUID(),sha256:ref.sha256,bytesLength:String(ref.byteLength)})),windowsEvidenceRef:windowsRef(produced.windowsEvidenceRef)};
        validateNativeReceiptCandidateV2(candidate,this.limits.output,this.limits.input);nativeJsonBytes(candidate,16777216);
        record={candidate,result:produced.result,intent:produced.intent,termination:produced.termination,proof:null,fresh:false,prepared:false,putAttempted:new Set()};this.candidates.set(query.operationInputDigest,record);
        const prepared=await this.decide('SELECT manga_web.native_receipt_prepare($1::jsonb,$2::jsonb) AS decision',[JSON.stringify(candidate),JSON.stringify(query.lookup)],record);windowsMust(prepared.candidate,'NATIVE_RECEIPT_CANDIDATE_CONFLICT');windowsSame(prepared.candidate,candidate);record.fresh=true;record.prepared=true;
      }
      windowsMust(record.prepared);windowsSame(computation.metadata,record.result.metadata);windowsSame(describeNativeBlobs(computation.blobs,this.limits.output),record.result.blobs);
      const proof:NativeVerifiedReceiptV2={version:2,candidateId:record.candidate.candidateId,kernelImplementationDigest:this.kernelImplementationDigest,verificationVersion:nativeFacadeVerificationVersion,blobs:[],windowsEvidenceRef:record.candidate.windowsEvidenceRef};
      for(const ref of record.candidate.blobs){const key=`${this.target.accountId}/${ref.assetId}`;let receipt=await this.objects.receipt(key);
        if(!receipt){windowsMust(record.fresh&&!record.proof&&!record.putAttempted.has(ref.blobId));record.putAttempted.add(ref.blobId);receipt=await this.objects.put(key,computation.blobs.get(ref.blobId)!);}
        const actual=objectReceipt(receipt,key,ref.sha256,ref.bytesLength),bytes=await this.objects.read(key);windowsMust(String(bytes.length)===ref.bytesLength&&sha256(bytes)===ref.sha256,'NATIVE_RECEIPT_OBJECT_CONFLICT');
        if(!record.proof)await this.decide('SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,$5::jsonb) AS decision',[record.candidate.candidateId,ref.blobId,JSON.stringify(actual),this.objects.bucket,JSON.stringify(query.lookup)],record);proof.blobs.push({blobId:ref.blobId,receipt:actual});
      }
      if(record.proof)windowsSame(record.proof,proof);await this.decide('SELECT manga_web.native_receipt_verify($1,$2::jsonb,$3::jsonb) AS decision',[record.candidate.candidateId,JSON.stringify(proof),JSON.stringify(query.lookup)],record);record.proof=proof;
      const sealed:NativeSealedReceiptV2={candidate:record.candidate,receipt:proof,intent:record.intent,termination:record.termination,origin:record.fresh?'FRESH':'CACHE'};nativeJsonBytes(sealed,this.lookupMaximum);this.verified.set(query.operationInputDigest,structuredClone(sealed));
    }catch(error){if(error instanceof NativeJobErrorV2)throw error;const intent=record?.intent??produced?.intent??query.prospective;this.unknown(error instanceof DomainError?error.code:'NATIVE_RECEIPT_UNCONFIRMED',intent,record?.termination??produced?.termination,record?.candidate.windowsEvidenceRef??produced?.windowsEvidenceRef??null);}
  }
  async onValidationFailure(task:NativeTask,metadata:Record<string,unknown>,inputs:Map<string,Buffer>,computation:NativeComputation,error:unknown):Promise<never>{
    if(error instanceof NativeJobErrorV2)throw error;const query=this.query(task,metadata,inputs),cached=this.candidates.get(query.operationInputDigest);let produced:NativeReceiptProducedV2|undefined;
    if(!cached)try{produced=this.source(task,metadata,inputs,computation);}catch(sourceError){if(sourceError instanceof NativeJobErrorV2)throw sourceError;this.unknown('NATIVE_RECEIPT_UNCONFIRMED',query.prospective);}
    const intent=cached?.intent??produced!.intent,termination=cached?.termination??produced!.termination,ref=cached?.candidate.windowsEvidenceRef??produced!.windowsEvidenceRef;
    this.unknown(error instanceof DomainError?error.code:'NATIVE_OUTPUT_INVALID',intent,termination,ref);
  }
}
import {WindowsNativeCostJournal,validateWindowsNativeCostCall,validateWindowsCostedIoRequest,validateWindowsCostedIoEvent,type WindowsNativeCostCall,type WindowsCostedObjectIo,type WindowsCostedIoRequest,type WindowsCostedIoReply} from './windows-native-cost.js';
export type WindowsCostedReceiptOptions={db:Database;io:WindowsCostedObjectIo;target:NativeTarget;kernelImplementationDigest:string;limits:{input:Readonly<NativeFrameLimits>;output:Readonly<NativeFrameLimits>};source:NativeReceiptSourceV2;costs:WindowsNativeCostJournal;call:WindowsNativeCostCall;lookupMaximum?:number};
const costedReceiptJournals=new WeakMap<WindowsReceiptStore,WindowsNativeCostJournal>();
export function captureWindowsCostedObjectIo(value:WindowsCostedObjectIo):WindowsCostedObjectIo{
  windowsKeys(value,['bucket','read','receipt','put','lookup']);const fields=Object.getOwnPropertyDescriptors(value);windowsMust(typeof fields.bucket.value==='string'&&fields.bucket.value.length>0&&fields.bucket.value.length<=256);
  const method=<K extends 'read'|'receipt'|'put'|'lookup'>(key:K):WindowsCostedObjectIo[K]=>{windowsMust(typeof fields[key].value==='function');return fields[key].value.bind(value) as WindowsCostedObjectIo[K];};
  return Object.freeze({bucket:fields.bucket.value as string,read:method('read'),receipt:method('receipt'),put:method('put'),lookup:method('lookup')});
}
export async function executeWindowsCostedIo<T>(options:{db:Database;costs:WindowsNativeCostJournal;io:WindowsCostedObjectIo;call:WindowsNativeCostCall;kind:WindowsCostedIoRequest['kind'];key:string;expected:{sha256:string;bytesLength:string}|null;bytes?:Buffer}):Promise<T>{
  const {db,costs,io,kind,key,expected}=options,call=validateWindowsNativeCostCall(options.call);windowsMust(costs instanceof WindowsNativeCostJournal&&costs.isForDatabase(db));
  const request=validateWindowsCostedIoRequest({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind,key,expected});
  let reply:WindowsCostedIoReply<unknown>;if(kind==='OBJECT_READ')reply=await io.read(request);else if(kind==='OBJECT_RECEIPT')reply=await io.receipt(request);else{windowsMust(Buffer.isBuffer(options.bytes));reply=await io.put(request,Buffer.from(options.bytes));}
  windowsMust(reply!==null&&typeof reply==='object'&&!types.isProxy(reply));const replyState=Object.getOwnPropertyDescriptor(reply,'state');windowsMust(replyState?.enumerable&&'value'in replyState);windowsKeys(reply,replyState.value==='RETURNED'?['state','event','value']:['state','event']);const event=validateWindowsCostedIoEvent(reply.event,request);windowsMust(reply.state===event.state&&event.state!=='UNCONFIRMED'&&event.ended!==null);
  const stored=await db.accountTransaction(key.split('/')[0],tx=>costs.lookupIoIn(tx,request),true);windowsMust(stored&&digest(stored)===digest(event),'WINDOWS_NATIVE_COST_IO_UNCONFIRMED');
  if(reply.state!=='RETURNED')throw new DomainError(event.code??'WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');
  if(kind==='OBJECT_READ'){windowsMust(Buffer.isBuffer(reply.value)&&event.observed!==null&&sha256(reply.value)===event.observed.sha256&&String(reply.value.length)===event.observed.bytesLength);return Buffer.from(reply.value) as T;}
  if(reply.value===null){windowsMust(kind==='OBJECT_RECEIPT'&&event.observed===null);return null as T;}
  windowsMust(event.observed!==null);objectReceipt(reply.value,key,event.observed.sha256,event.observed.bytesLength);return structuredClone(reply.value) as T;
}
function createWindowsCostedReceiptStore(options:WindowsCostedReceiptOptions):NativeWindowsReceiptStore{
  windowsMust(options!==null&&typeof options==='object'&&!types.isProxy(options));
  const keys=['db','io','target','kernelImplementationDigest','limits','source','costs','call',...(Object.hasOwn(options,'lookupMaximum')?['lookupMaximum']:[])];windowsKeys(options,keys);
  const {db,costs}=options;windowsMust(costs instanceof WindowsNativeCostJournal&&costs.isForDatabase(db)&&db.role==='trio_web_worker');const call=validateWindowsNativeCostCall(options.call),io=captureWindowsCostedObjectIo(options.io),target=options.target;
  windowsMust(target.sourceInput!==undefined&&['EXECUTION','REQUEST_CHECKPOINT'].includes(target.targetKind)&&call.kernelDigest===options.kernelImplementationDigest);
  const run=<T>(kind:WindowsCostedIoRequest['kind'],key:string,bytes?:Buffer)=>executeWindowsCostedIo<T>({db,costs,io,call,kind,key,expected:bytes?{sha256:sha256(bytes),bytesLength:String(bytes.length)}:null,...(bytes?{bytes}:{})});
  const objects:ObjectStore=Object.freeze({bucket:io.bucket,read:(key:string)=>run<Buffer>('OBJECT_READ',key),receipt:(key:string)=>run<ObjectReceipt|null>('OBJECT_RECEIPT',key),put:(key:string,bytes:Buffer)=>run<ObjectReceipt>('OBJECT_PUT',key,bytes),remove:async()=>{throw new DomainError('WINDOWS_NATIVE_COST_SCOPE_REQUIRED',409,'WAIT');}});
  const cache=new WindowsReceiptStore(db,objects,target,options.kernelImplementationDigest,options.limits,options.source,options.lookupMaximum,call);costedReceiptJournals.set(cache,costs);return cache;
}
