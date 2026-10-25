import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition,type NextAction} from '../../contracts/src/errors.js';

export const nativeTaskVersion='native-pure-v1' as const;
export const nativeTasks=['DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE'] as const;
export type NativeTask=typeof nativeTasks[number];
export type NativeBlob={id:string;byteLength:number;sha256:string};
export type WindowsRecordRef={recordId:string;recordDigest:string};
export type WindowsEvidenceRef=WindowsRecordRef&{linkId:string;linkDigest:string};
export type NativeJob={version:1;jobId:string;task:NativeTask;taskVersion:typeof nativeTaskVersion;profileDigest:string;inputDigest:string;metadata:Record<string,unknown>;blobs:NativeBlob[]};
export type NativeComputation={metadata:Record<string,unknown>;blobs:Map<string,Buffer>};
export type NativeResult={version:1;jobId:string;task:NativeTask;taskVersion:typeof nativeTaskVersion;profileDigest:string;inputDigest:string;metadata:Record<string,unknown>;blobs:NativeBlob[]};
export type NativeFrameLimits={maxMetadataBytes:number;maxBinaryBytes:number;maxItems:number};
export type NativeLimits={maxMetadataBytes:number;maxInputBytes:number;maxOutputBytes:number;maxItems:number;childMemoryBytes:number;maxProcesses:number;timeoutMs:number;terminationWaitMs:number;parentInFlightBytes:number};
export type NativeJobEvidence={version:1;jobId:string;task:NativeTask;inputDigest:string;profileDigest:string;isolation:'OWNED_FIXTURE'|'LINUX_CGROUP_V2';state:'SUCCEEDED'|'FAILED'|'UNKNOWN';code:string;goAttempted:boolean;startedComputation:boolean;directChildClosed:boolean;subtreeTerminationConfirmed:boolean;operationJoined:boolean;elapsedMs:number;inputBytes:number;outputBytes:number};
export type NativeJobEvidenceV2=Omit<NativeJobEvidence,'version'|'isolation'>&{version:2;isolation:'WINDOWS_JOB_OBJECT';windowsRecordRef:WindowsRecordRef};
export type NativeJobEvidenceAny=NativeJobEvidence|NativeJobEvidenceV2;
// Hooks stay in the trusted parent and never enter the child DTO or environment.
// A durable binding must provide every phase; a fixture can omit the binding.
export interface NativeRunHooks {
  intent(job:NativeJob):Promise<void>;
  consumeGo(job:NativeJob):Promise<void>;
  // A controller-owned raw candidate is captured after EOF/exit, before the
  // final audit. It is not facade verification, publication or release proof.
  rawResult?(job:NativeJob,result:NativeResult,blobs:Map<string,Buffer>):Promise<void>;
  observation(job:NativeJob,evidence:NativeJobEvidence,termination:NativeTermination,result:NativeResult|null):Promise<void>;
  termination(job:NativeJob,evidence:NativeJobEvidence,termination:NativeTermination):Promise<void>;
}
export interface NativeRunner {readonly supportsParentHooks?:true;run(task:NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:NativeRunHooks):Promise<NativeComputation>}
// A failed GO write can still have reached the child. Only goAttempted:false
// (or NO_CHILD_CREATED) can establish that this attempt never enabled compute.
export type NativeTermination={jobId:string;inputDigest:string;profileDigest:string;goAttempted:boolean;startedComputation:boolean;directChildClosed:boolean;subtreeTerminationConfirmed:boolean;operationJoined:boolean;kind:'NO_CHILD_CREATED'|'DIRECT_CHILD_ONLY'|'CGROUP_EMPTY'|'UNCONFIRMED'};
export type NativeTerminationV2=Omit<NativeTermination,'kind'>&{kind:'NO_CHILD_CREATED'|'WINDOWS_JOB_EMPTY'|'UNCONFIRMED'};
export type NativeTerminationAny=NativeTermination|NativeTerminationV2;
export class NativeJobError extends DomainError {
  readonly termination:Readonly<NativeTermination>;
  constructor(code:string,status:number,nextAction:NextAction,termination:NativeTermination){super(code,status,nextAction);this.termination=Object.freeze({...termination});}
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[0-9a-f]{64}$/;
export function validateNativeLimits(limits:NativeLimits):void {
  const keys=['maxMetadataBytes','maxInputBytes','maxOutputBytes','maxItems','childMemoryBytes','maxProcesses','timeoutMs','terminationWaitMs','parentInFlightBytes'];
  requireCondition(limits&&Object.keys(limits).length===keys.length&&keys.every(key=>Object.hasOwn(limits,key)&&Number.isSafeInteger(limits[key as keyof NativeLimits])&&limits[key as keyof NativeLimits]>0),'NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');
  requireCondition(limits.timeoutMs<=2_147_483_647&&limits.terminationWaitMs<=2_147_483_647&&limits.maxMetadataBytes<=0xffffffff,'NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');
}
// Walk only plain data before JSON serialization. Proxies, getters, Buffers, custom toJSON and lone surrogates are refused.
export function nativeJsonBytes(value:unknown,maxBytes:number):Buffer {
  requireCondition(Number.isSafeInteger(maxBytes)&&maxBytes>0,'NATIVE_PROTOCOL_INVALID',422);
  let estimated=0;const seen=new Set<object>();
  const add=(count:number)=>{estimated+=count;requireCondition(estimated<=maxBytes,'NATIVE_METADATA_LIMIT',413,'WAIT');};
  const quoted=(text:string)=>{add(2);for(const ch of text){const code=ch.codePointAt(0)!;requireCondition(code<0xd800||code>0xdfff,'NATIVE_PROTOCOL_INVALID',422);add(code<0x20?6:ch==='"'||ch==='\\'?2:Buffer.byteLength(ch));}};
  const walk=(item:unknown,depth:number):void=>{
    requireCondition(!types.isProxy(item),'NATIVE_PROTOCOL_INVALID',422);
    requireCondition(depth<=64,'NATIVE_PROTOCOL_INVALID',422);
    if(item===null){add(4);return;}if(typeof item==='string'){quoted(item);return;}
    if(typeof item==='boolean'){add(item?4:5);return;}if(typeof item==='number'){requireCondition(Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER,'NATIVE_PROTOCOL_INVALID',422);add(String(item).length);return;}
    requireCondition(typeof item==='object'&&item!==null&&!seen.has(item),'NATIVE_PROTOCOL_INVALID',422);seen.add(item);
    if(Array.isArray(item)){requireCondition(Object.keys(item).length===item.length,'NATIVE_PROTOCOL_INVALID',422);add(2+Math.max(0,item.length-1));for(let i=0;i<item.length;i++){const descriptor=Object.getOwnPropertyDescriptor(item,String(i));requireCondition(descriptor&&'value'in descriptor,'NATIVE_PROTOCOL_INVALID',422);walk(descriptor.value,depth+1);}}
    else {requireCondition(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null,'NATIVE_PROTOCOL_INVALID',422);const keys=Reflect.ownKeys(item);requireCondition(keys.every(key=>typeof key==='string'),'NATIVE_PROTOCOL_INVALID',422);add(2+Math.max(0,keys.length-1));for(const key of keys as string[]){const descriptor=Object.getOwnPropertyDescriptor(item,key);requireCondition(descriptor&&descriptor.enumerable&&'value'in descriptor,'NATIVE_PROTOCOL_INVALID',422);quoted(key);add(1);walk(descriptor.value,depth+1);}}
    seen.delete(item);
  };
  walk(value,0);const encoded=Buffer.from(JSON.stringify(value),'utf8');requireCondition(encoded.length<=maxBytes,'NATIVE_METADATA_LIMIT',413,'WAIT');return encoded;
}
export function describeNativeBlobs(blobs:Map<string,Buffer>,limits:NativeFrameLimits):NativeBlob[] {
  requireCondition(blobs instanceof Map&&blobs.size<=limits.maxItems,'NATIVE_BINARY_LIMIT',413,'WAIT');let total=0;const descriptors:NativeBlob[]=[];
  for(const [id,bytes]of blobs){requireCondition(/^[A-Za-z0-9._-]{1,100}$/.test(id)&&Buffer.isBuffer(bytes),'NATIVE_PROTOCOL_INVALID',422);total+=bytes.length;requireCondition(Number.isSafeInteger(total)&&total<=limits.maxBinaryBytes,'NATIVE_BINARY_LIMIT',413,'WAIT');descriptors.push({id,byteLength:bytes.length,sha256:sha256(bytes)});}return descriptors;
}
export function validateNativeEnvelope(value:unknown,limits:NativeFrameLimits):asserts value is NativeJob|NativeResult {
  requireCondition(value&&typeof value==='object'&&!Array.isArray(value),'NATIVE_PROTOCOL_INVALID',422);const item=value as NativeJob;
  const keys=['version','jobId','task','taskVersion','profileDigest','inputDigest','metadata','blobs'];
  requireCondition(Object.keys(item).length===keys.length&&keys.every(key=>Object.hasOwn(item,key))&&item.version===1&&uuid.test(item.jobId)&&nativeTasks.includes(item.task)&&item.taskVersion===nativeTaskVersion&&hash.test(item.profileDigest)&&hash.test(item.inputDigest)&&item.metadata&&typeof item.metadata==='object'&&!Array.isArray(item.metadata)&&Array.isArray(item.blobs)&&item.blobs.length<=limits.maxItems,'NATIVE_PROTOCOL_INVALID',422);
  let total=0;const ids=new Set<string>();for(const blob of item.blobs){requireCondition(blob&&typeof blob==='object'&&Object.keys(blob).length===3&&Object.hasOwn(blob,'id')&&Object.hasOwn(blob,'byteLength')&&Object.hasOwn(blob,'sha256')&&typeof blob.id==='string'&&/^[A-Za-z0-9._-]{1,100}$/.test(blob.id)&&!ids.has(blob.id)&&Number.isSafeInteger(blob.byteLength)&&blob.byteLength>=0&&hash.test(blob.sha256),'NATIVE_PROTOCOL_INVALID',422);ids.add(blob.id);total+=blob.byteLength;requireCondition(Number.isSafeInteger(total)&&total<=limits.maxBinaryBytes,'NATIVE_BINARY_LIMIT',413,'WAIT');}
  nativeJsonBytes(item,limits.maxMetadataBytes);
}
export function nativeInputDigest(job:Omit<NativeJob,'inputDigest'>):string {return digest(job);}
export function createNativeJob(task:NativeTask,profileDigest:string,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,limits:NativeFrameLimits,jobId=randomUUID()):NativeJob {
  const metadataBytes=nativeJsonBytes(metadata,limits.maxMetadataBytes);const captured=JSON.parse(metadataBytes.toString('utf8')) as Record<string,unknown>;
  const input={version:1 as const,jobId,task,taskVersion:nativeTaskVersion,profileDigest,metadata:captured,blobs:describeNativeBlobs(blobs,limits)};const result={...input,inputDigest:nativeInputDigest(input)};validateNativeEnvelope(result,limits);return result;
}
export function verifyNativeInput(job:NativeJob):void {const {inputDigest,...input}=job;requireCondition(inputDigest===nativeInputDigest(input),'NATIVE_INPUT_MISMATCH',422);}
export function createNativeResult(job:NativeJob,result:NativeComputation,limits:NativeFrameLimits):NativeResult {
  const envelope:NativeResult={version:1,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,metadata:result.metadata,blobs:describeNativeBlobs(result.blobs,limits)};validateNativeEnvelope(envelope,limits);return envelope;
}
export function verifyNativeResult(job:NativeJob,result:NativeResult):void {requireCondition(result.jobId===job.jobId&&result.task===job.task&&result.taskVersion===job.taskVersion&&result.profileDigest===job.profileDigest&&result.inputDigest===job.inputDigest,'NATIVE_OUTPUT_MISMATCH',409,'WAIT');}
