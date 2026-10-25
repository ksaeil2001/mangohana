import type {Writable} from 'node:stream';
import {TextDecoder,types} from 'node:util';
import {parseStrictJson} from '../../contracts/src/json.js';
import {digest} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {nativeJsonBytes,validateNativeEnvelope,verifyNativeInput,verifyNativeResult,describeNativeBlobs,type NativeJob,type NativeResult,type NativeTermination,type NativeTerminationV2,type WindowsEvidenceRef,type NativeFrameLimits} from './dto.js';
import {validateNativeJob} from './jobs.js';
import {NativeReader,readNativeFrame,writeNativeBytes,writeNativeFrame,type NativeFrame} from './frame.js';

// These frames are private controller messages. An account/parent reference is
// a lookup key, never an authenticated peer or a physical execution grant.
export type NativeControllerBinding={accountId:string;capacityReservationId:string;jobId:string;parentInstanceId:string;inputDigest:string;profileDigest:string;kernelDigest:string};
type RequestBase<V extends 1|2>={version:V;requestId:string;binding:NativeControllerBinding};
type RequestControl<V extends 1|2>=
  |RequestBase<V>&{command:'PREPARE'}
  |RequestBase<V>&{command:'GO';attemptId:string;controllerInstanceId:string}
  |RequestBase<V>&{command:'QUERY';includeRawResult:boolean};
export type NativeControllerRequestControl=RequestControl<1>;
export type NativeControllerRequestControlV2=RequestControl<2>;
export type NativeControllerRequestControlAny=NativeControllerRequestControl|NativeControllerRequestControlV2;
export type NativeControllerRequest={control:NativeControllerRequestControl;input?:NativeFrame<NativeJob>};
export type NativeRawResultReference={rawResultId:string;resultDigest:string};
export type NativeControllerSnapshot={attemptId:string;controllerInstanceId:string;phase:'PREPARING'|'READY'|'GO_GRANTED'|'UNKNOWN';rawResult:NativeRawResultReference|null;termination:NativeTermination|null;code:string};
export type NativeControllerResponseControl={version:1;requestId:string;command:NativeControllerRequestControl['command'];binding:NativeControllerBinding;snapshot:NativeControllerSnapshot};
export type NativeControllerResponse={control:NativeControllerResponseControl;rawResult?:NativeFrame<NativeResult>};
export type NativeControllerRequestV2={control:NativeControllerRequestControlV2;input?:NativeFrame<NativeJob>};
export type NativeControllerRequestAny=NativeControllerRequest|NativeControllerRequestV2;
export type NativeControllerSnapshotV2=Omit<NativeControllerSnapshot,'termination'>&{version:2;termination:NativeTerminationV2|null;windowsEvidenceRef:WindowsEvidenceRef|null};
export type NativeControllerSnapshotAny=NativeControllerSnapshot|NativeControllerSnapshotV2;
export type NativeControllerResponseControlV2={version:2;requestId:string;command:NativeControllerRequestControlV2['command'];binding:NativeControllerBinding;snapshot:NativeControllerSnapshotV2};
export type NativeControllerResponseControlAny=NativeControllerResponseControl|NativeControllerResponseControlV2;
export type NativeControllerResponseV2={control:NativeControllerResponseControlV2;rawResult?:NativeFrame<NativeResult>};
export type NativeControllerResponseAny=NativeControllerResponse|NativeControllerResponseV2;
export type NativeControllerWireLimits={maxControlBytes:number;input:NativeFrameLimits;output:NativeFrameLimits};
const magic=Buffer.from('TMCTRV1\0','ascii');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=/^[a-f0-9]{64}$/;
function invalid(code='NATIVE_CONTROL_INVALID'):never{requireCondition(false,code,422,'WAIT');throw new Error(code);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length||!keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]))invalid();
  return value as Record<string,unknown>;
}
function id(value:unknown):void{if(typeof value!=='string'||!uuid.test(value))invalid();}
function hex(value:unknown):void{if(typeof value!=='string'||!hash.test(value))invalid();}
export function validateNativeControllerBinding(value:unknown):NativeControllerBinding{
  const item=object(value,['accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest']);
  for(const key of ['accountId','capacityReservationId','jobId','parentInstanceId'])id(item[key]);
  for(const key of ['inputDigest','profileDigest','kernelDigest'])hex(item[key]);
  return structuredClone(item) as NativeControllerBinding;
}
function requestControl(value:unknown,maxBytes:number,version?:1|2):NativeControllerRequestControlAny{
  nativeJsonBytes(value,maxBytes);
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();const kind=object(value,Object.keys(value)).command;
  const keys=kind==='PREPARE'?['version','requestId','binding','command']:kind==='GO'?['version','requestId','binding','command','attemptId','controllerInstanceId']:kind==='QUERY'?['version','requestId','binding','command','includeRawResult']:[];
  if(!keys.length)invalid();const item=object(value,keys);if((item.version!==1&&item.version!==2)||(version!==undefined&&item.version!==version))invalid();id(item.requestId);const binding=validateNativeControllerBinding(item.binding);
  if(kind==='GO'){id(item.attemptId);id(item.controllerInstanceId);}
  if(kind==='QUERY'&&typeof item.includeRawResult!=='boolean')invalid();
  return {...structuredClone(item),binding} as NativeControllerRequestControlAny;
}
export function validateNativeControllerRequest(value:unknown,maxBytes:number):NativeControllerRequestControl{return requestControl(value,maxBytes,1) as NativeControllerRequestControl;}
export function validateNativeControllerRequestV2(value:unknown,maxBytes:number):NativeControllerRequestControlV2{return requestControl(value,maxBytes,2) as NativeControllerRequestControlV2;}
export function validateNativeControllerSnapshot(value:unknown,binding:NativeControllerBinding):NativeControllerSnapshot{
  const item=object(value,['attemptId','controllerInstanceId','phase','rawResult','termination','code']);id(item.attemptId);id(item.controllerInstanceId);
  if(!['PREPARING','READY','GO_GRANTED','UNKNOWN'].includes(String(item.phase))||typeof item.code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(item.code))invalid();
  if(item.rawResult!==null){const raw=object(item.rawResult,['rawResultId','resultDigest']);id(raw.rawResultId);hex(raw.resultDigest);}
  if(item.termination!==null){
    const term=object(item.termination,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind']);
    if(term.jobId!==binding.jobId||term.inputDigest!==binding.inputDigest||term.profileDigest!==binding.profileDigest)invalid('NATIVE_CONTROL_BINDING_MISMATCH');
    for(const key of ['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'])if(typeof term[key]!=='boolean')invalid();
    if(term.startedComputation&&!term.goAttempted)invalid();
    if(term.kind==='NO_CHILD_CREATED'){if(!term.operationJoined||term.goAttempted||term.startedComputation||term.directChildClosed||term.subtreeTerminationConfirmed)invalid();}
    else if(term.kind==='DIRECT_CHILD_ONLY'){if(!term.operationJoined||!term.directChildClosed||term.subtreeTerminationConfirmed)invalid();}
    else if(term.kind==='CGROUP_EMPTY'){if(!term.operationJoined||!term.directChildClosed||!term.subtreeTerminationConfirmed)invalid();}
    else if(term.kind!=='UNCONFIRMED')invalid();
  }
  return structuredClone(item) as NativeControllerSnapshot;
}
export function validateNativeControllerSnapshotV2(value:unknown,binding:NativeControllerBinding):NativeControllerSnapshotV2{
  const item=object(value,['attemptId','controllerInstanceId','phase','rawResult','termination','code','version','windowsEvidenceRef']);id(item.attemptId);id(item.controllerInstanceId);
  if(item.version!==2||typeof item.phase!=='string'||!['PREPARING','READY','GO_GRANTED','UNKNOWN'].includes(item.phase)||typeof item.code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(item.code))invalid();
  if(item.windowsEvidenceRef===null){if(item.rawResult!==null||item.termination!==null)invalid();}
  else {const ref=object(item.windowsEvidenceRef,['recordId','recordDigest','linkId','linkDigest']);id(ref.recordId);hex(ref.recordDigest);id(ref.linkId);hex(ref.linkDigest);}
  if(item.rawResult!==null){const raw=object(item.rawResult,['rawResultId','resultDigest']);id(raw.rawResultId);hex(raw.resultDigest);}
  if(item.termination!==null){
    const term=object(item.termination,['jobId','inputDigest','profileDigest','goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined','kind']);
    if(term.jobId!==binding.jobId||term.inputDigest!==binding.inputDigest||term.profileDigest!==binding.profileDigest)invalid('NATIVE_CONTROL_BINDING_MISMATCH');
    for(const key of ['goAttempted','startedComputation','directChildClosed','subtreeTerminationConfirmed','operationJoined'])if(typeof term[key]!=='boolean')invalid();
    if(term.startedComputation&&!term.goAttempted)invalid();
    if(term.kind==='NO_CHILD_CREATED'){if(!term.operationJoined||term.goAttempted||term.startedComputation||term.directChildClosed||term.subtreeTerminationConfirmed||item.rawResult!==null||item.phase==='GO_GRANTED')invalid();}
    else if(term.kind==='WINDOWS_JOB_EMPTY'){if(!term.operationJoined||!term.directChildClosed||!term.subtreeTerminationConfirmed)invalid();}
    else if(term.kind!=='UNCONFIRMED'||term.subtreeTerminationConfirmed)invalid();
  }
  return structuredClone(item) as NativeControllerSnapshotV2;
}
export function validateNativeControllerResponse(value:unknown,maxBytes:number,expected:NativeControllerRequestControl):NativeControllerResponseControl;
export function validateNativeControllerResponse(value:unknown,maxBytes:number,expected:NativeControllerRequestControlV2):NativeControllerResponseControlV2;
export function validateNativeControllerResponse(value:unknown,maxBytes:number,expected:NativeControllerRequestControlAny):NativeControllerResponseControlAny;
export function validateNativeControllerResponse(value:unknown,maxBytes:number,expected:NativeControllerRequestControlAny):NativeControllerResponseControlAny{
  const captured=requestControl(expected,maxBytes);
  nativeJsonBytes(value,maxBytes);const item=object(value,['version','requestId','command','binding','snapshot']);
  const binding=validateNativeControllerBinding(item.binding);
  if(item.version!==captured.version||item.requestId!==captured.requestId||item.command!==captured.command||digest(binding)!==digest(captured.binding))invalid('NATIVE_CONTROL_BINDING_MISMATCH');
  const snapshot=captured.version===2?validateNativeControllerSnapshotV2(item.snapshot,binding):validateNativeControllerSnapshot(item.snapshot,binding);
  if(captured.command==='GO'&&(snapshot.attemptId!==captured.attemptId||snapshot.controllerInstanceId!==captured.controllerInstanceId))invalid('NATIVE_CONTROL_BINDING_MISMATCH');
  return {...structuredClone(item),binding,snapshot} as NativeControllerResponseControlAny;
}
export function validateNativeControllerResponseV2(value:unknown,maxBytes:number,expected:NativeControllerRequestControlV2):NativeControllerResponseControlV2{
  return validateNativeControllerResponse(value,maxBytes,validateNativeControllerRequestV2(expected,maxBytes));
}
function frameLimits(value:NativeFrameLimits):number{
  object(value,['maxMetadataBytes','maxBinaryBytes','maxItems']);
  if(![value.maxMetadataBytes,value.maxBinaryBytes,value.maxItems].every(number=>Number.isSafeInteger(number)&&number>0)||value.maxMetadataBytes>0xffffffff)invalid();
  const total=12+value.maxMetadataBytes+value.maxBinaryBytes;if(!Number.isSafeInteger(total))invalid();return total;
}
function maximum(limits:NativeControllerWireLimits,direction:'input'|'output'):number{
  object(limits,['maxControlBytes','input','output']);if(!Number.isSafeInteger(limits.maxControlBytes)||limits.maxControlBytes<=0||limits.maxControlBytes>0xffffffff)invalid();
  const input=frameLimits(limits.input),output=frameLimits(limits.output),total=12+limits.maxControlBytes+(direction==='input'?input:output);if(!Number.isSafeInteger(total))invalid();return total;
}
async function readControl(reader:NativeReader,maxBytes:number):Promise<unknown>{
  const prefix=await reader.exact(12);if(!prefix.subarray(0,8).equals(magic))invalid();const length=prefix.readUInt32BE(8);
  requireCondition(length>0&&length<=maxBytes,'NATIVE_CONTROL_LIMIT',413,'WAIT');
  const bytes=await reader.exact(length);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{invalid('NATIVE_CONTROL_UTF8');}
  return parseStrictJson(text,maxBytes);
}
async function writeControl(stream:Writable,control:unknown,maxBytes:number):Promise<void>{
  const bytes=nativeJsonBytes(control,maxBytes),prefix=Buffer.alloc(12);magic.copy(prefix);prefix.writeUInt32BE(bytes.length,8);await writeNativeBytes(stream,prefix);await writeNativeBytes(stream,bytes);
}
function bindJob(binding:NativeControllerBinding,job:NativeJob|NativeResult):void{
  if(binding.jobId!==job.jobId||binding.inputDigest!==job.inputDigest||binding.profileDigest!==job.profileDigest)invalid('NATIVE_CONTROL_BINDING_MISMATCH');
}
function validateRaw(frame:NativeFrame<NativeResult>,binding:NativeControllerBinding,reference:NativeRawResultReference,limits:NativeFrameLimits):void{
  validateNativeEnvelope(frame.envelope,limits);bindJob(binding,frame.envelope);
  if(digest(frame.envelope)!==reference.resultDigest||digest(describeNativeBlobs(frame.blobs,limits))!==digest(frame.envelope.blobs))invalid('NATIVE_CONTROL_RAW_MISMATCH');
}
export function readNativeControllerRequest(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,version?:1):Promise<NativeControllerRequest>;
export function readNativeControllerRequest(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,version:2):Promise<NativeControllerRequestV2>;
export function readNativeControllerRequest(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,version:1|2):Promise<NativeControllerRequestAny>;
export async function readNativeControllerRequest(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,version:1|2=1):Promise<NativeControllerRequestAny>{
  if(version!==1&&version!==2)invalid();
  const reader=new NativeReader(source,maximum(limits,'input')),control=requestControl(await readControl(reader,limits.maxControlBytes),limits.maxControlBytes,version);
  if(control.command!=='PREPARE'){await reader.end();return control.version===1?{control}:{control};}
  const input=await readNativeFrame<NativeJob>(reader,limits.input);validateNativeJob(input);bindJob(control.binding,input.envelope);return control.version===1?{control,input}:{control,input};
}
export async function writeNativeControllerRequest(stream:Writable,request:NativeControllerRequestAny,limits:NativeControllerWireLimits):Promise<void>{
  maximum(limits,'input');object(request,request&&typeof request==='object'&&Object.hasOwn(request,'input')?['control','input']:['control']);
  const control=requestControl(request.control,limits.maxControlBytes);
  object(request,control.command==='PREPARE'?['control','input']:['control']);
  if(control.command==='PREPARE'){if(!request.input)invalid();validateNativeEnvelope(request.input.envelope,limits.input);validateNativeJob(request.input);bindJob(control.binding,request.input.envelope);}
  await writeControl(stream,control,limits.maxControlBytes);if(request.input)await writeNativeFrame(stream,request.input,limits.input);
}
export function readNativeControllerResponse(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,expected:NativeControllerRequestControl,originalJob?:NativeJob):Promise<NativeControllerResponse>;
export function readNativeControllerResponse(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,expected:NativeControllerRequestControlV2,originalJob?:NativeJob):Promise<NativeControllerResponseV2>;
export function readNativeControllerResponse(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,expected:NativeControllerRequestControlAny,originalJob?:NativeJob):Promise<NativeControllerResponseAny>;
export async function readNativeControllerResponse(source:AsyncIterable<Uint8Array>,limits:NativeControllerWireLimits,expected:NativeControllerRequestControlAny,originalJob?:NativeJob):Promise<NativeControllerResponseAny>{
  maximum(limits,'output');const captured=requestControl(expected,limits.maxControlBytes);
  let original:NativeJob|undefined;if(originalJob){validateNativeEnvelope(originalJob,limits.input);verifyNativeInput(originalJob);original=structuredClone(originalJob);bindJob(captured.binding,original);}
  const reader=new NativeReader(source,maximum(limits,'output')),control=validateNativeControllerResponse(await readControl(reader,limits.maxControlBytes),limits.maxControlBytes,captured);
  if(captured.command!=='QUERY'||!captured.includeRawResult||!control.snapshot.rawResult){await reader.end();return control.version===1?{control}:{control};}
  if(!original)invalid('NATIVE_CONTROL_ORIGINAL_JOB_REQUIRED');
  const rawResult=await readNativeFrame<NativeResult>(reader,limits.output);validateRaw(rawResult,control.binding,control.snapshot.rawResult,limits.output);verifyNativeResult(original,rawResult.envelope);return control.version===1?{control,rawResult}:{control,rawResult};
}
export async function writeNativeControllerResponse(stream:Writable,response:NativeControllerResponseAny,limits:NativeControllerWireLimits,expected:NativeControllerRequestControlAny):Promise<void>{
  maximum(limits,'output');object(response,response&&typeof response==='object'&&Object.hasOwn(response,'rawResult')?['control','rawResult']:['control']);
  const captured=requestControl(expected,limits.maxControlBytes),control=validateNativeControllerResponse(response.control,limits.maxControlBytes,captured);
  const hasRaw=captured.command==='QUERY'&&captured.includeRawResult&&control.snapshot.rawResult!==null;object(response,hasRaw?['control','rawResult']:['control']);
  if(hasRaw){if(!response.rawResult||!control.snapshot.rawResult)invalid();validateRaw(response.rawResult,control.binding,control.snapshot.rawResult,limits.output);}
  await writeControl(stream,control,limits.maxControlBytes);if(response.rawResult)await writeNativeFrame(stream,response.rawResult,limits.output);
}
