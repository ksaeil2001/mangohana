import {randomUUID} from 'node:crypto';
import {types,TextDecoder} from 'node:util';
import {Writable} from 'node:stream';
import canonicalize from 'canonicalize';
import {DomainError} from '../../contracts/src/errors.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {validateNativeEnvelope,validateNativeLimits,verifyNativeInput,verifyNativeResult,type NativeJob,type NativeResult,type NativeLimits} from './dto.js';
import {NativeReader,readNativeFrame,writeNativeFrame,type NativeFrame} from './frame.js';
import {validateWindowsJobEvidence,classifyWindowsJobEvidence,type WindowsJobEvidence,type WindowsJobPolicy,type WindowsJobAccounting} from './windows-job-evidence.js';
import type {NativeRawResultReference} from './controller-protocol.js';

export type WindowsPrepareInput={
  identity:WindowsJobEvidence['identity'];authority:WindowsJobEvidence['authority'];pins:WindowsJobEvidence['pins'];
  policy:WindowsJobPolicy;limits:NativeLimits;frame:NativeFrame<NativeJob>;
};
export type OriginalRef={recordId:string;digest:string};
type GoRef={jobId:string;rowDigest:string};
type Origin=Omit<WindowsPrepareInput,'frame'>;
export type OriginalCapture={origin:Origin;originDigest:string;frameInputDigest:string;launchRef:string};
type OriginalStatus={originDigest:string;state:'CONFIRMED'|'UNCONFIRMED';goGrantRef:GoRef|null};
export type ParentJoinAck={joinId:string;originDigest:string;digest:string};
type Phase='NEW'|'PREPARING'|'PREPARED'|'GO_GRANTED'|'DRAINING'|'JOINED'|'UNCONFIRMED';
export type WindowsStopReason='CALLER_ABORT'|'DEADLINE'|'CONTROL_LOST'|'INPUT_LIMIT'|'OUTPUT_LIMIT'|'JOURNAL_UNCONFIRMED'|'HOST_FAILED';
export type WindowsPreparedAttempt=Readonly<{originDigest:string;attemptId:string;controllerInstanceId:string;sessionId:string;launchId:string;root:{pid:number;creationFileTime100ns:string}}>;
export type WindowsJobOutcome=Readonly<{state:'JOINED'|'WAIT';code:string;evidence:WindowsJobEvidence|null;rawResult:NativeRawResultReference|null;journalRef:OriginalRef|null}>;
export type WindowsJobView=Readonly<{phase:Phase;prepared:WindowsPreparedAttempt|null;outcome:WindowsJobOutcome|null}>;
export interface WindowsJobBackend{
  prepare():Promise<WindowsPreparedAttempt>;
  grantGo():Promise<WindowsJobOutcome>;
  stop(reason:WindowsStopReason):Promise<WindowsJobOutcome>;
  query():Promise<WindowsJobView>;
  idle():Promise<void>;
}
type Event=WindowsJobEvidence['lifecycle']['events'][number];
type Kind=Event['kind'];
type Row=Record<string,unknown>;
export type WindowsFact=
  |{kind:'WIN32';callId:string;api:string;qpcTicks:string;status:'RETURNED'|'FAILED'|'UNCONFIRMED';win32Error:number|null;value:unknown}
  |{kind:'IO';callId:string;lane:'IN'|'OUT'|'ERR';operation:'READ'|'WRITE'|'CLOSE';qpcTicks:string;status:'RETURNED'|'FAILED'|'UNCONFIRMED';bytesLength:string|null;sha256:string|null}
  |{kind:'PARENT_ACK';qpcTicks:string;ack:ParentJoinAck}
  |{kind:'ORIGINAL_GO';qpcTicks:string;goGrantRef:GoRef};
export type WindowsSource={version:1;originDigest:string;eventId:string;facts:WindowsFact[]};
export type JournalEntry={event:Event;source:WindowsSource;sourceDigest:string};
export type EventAck={eventId:string;payloadDigest:string;sourceDigest:string};
export type WindowsSealEnvelope={version:1;originDigest:string;evidence:WindowsJobEvidence;entries:EventAck[];parentJoinAck:ParentJoinAck|null};
export type HostFinalized={recordId:string;digest:string;handles:'CLOSED'|'UNCONFIRMED';closeCode:string|null};
type Common={version:1;requestId:string;originDigest:string;attemptId:string;sessionId:string;launchId:string};
type Commands={
  PREPARE:{origin:Origin;launchRef:string};ACK_EVENT:EventAck;GRANT_GO:{goGrantRef:GoRef};
  PARENT_JOINED:ParentJoinAck;STOP:{reason:WindowsStopReason};QUERY:Record<string,never>;ACK_FINAL:OriginalRef;
};
export type WindowsControl={[K in keyof Commands]:Common&{command:K;payload:Commands[K]}}[keyof Commands];
type HostPayloads={
  EVENT:JournalEntry;PROGRESS:{phase:Phase;bootstrap:'NONE'|'WAIT'|'READY';bootstrapFact:WindowsFact|null};
  FINAL_CANDIDATE:{evidence:WindowsJobEvidence};FINALIZED:HostFinalized;ERROR:{code:string};
};
export type WindowsHostMessage={[K in keyof HostPayloads]:Common&{message:K;payload:HostPayloads[K]}}[keyof HostPayloads];
export interface BrokerSession{
  send(control:WindowsControl):Promise<void>;
  events:AsyncIterable<WindowsHostMessage>;nativeInput:Writable;
  nativeOutput:AsyncIterable<Uint8Array>;nativeError:AsyncIterable<Uint8Array>;
  join():Promise<{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}>;
}
type HostStoredView={phase:Phase;finalized:HostFinalized|null};
export interface WindowsJobPorts{
  original:{
    captureFresh(input:WindowsPrepareInput):Promise<{created:boolean;capture:OriginalCapture}>;
    grantOriginal(capture:OriginalCapture):Promise<{created:boolean;goGrantRef:GoRef}>;
    readOriginal(capture:OriginalCapture):Promise<OriginalStatus>;
  };
  broker:{open(capture:OriginalCapture):Promise<BrokerSession>;readOriginal(capture:OriginalCapture):Promise<HostStoredView|null>};
  journal:{
    appendOriginal(capture:OriginalCapture,event:Event,source:WindowsSource):Promise<EventAck>;
    lookupEvent(capture:OriginalCapture,ref:EventAck):Promise<JournalEntry|null>;
    scanOriginal(capture:OriginalCapture):AsyncIterable<JournalEntry>;
    sealOriginal(capture:OriginalCapture,envelope:WindowsSealEnvelope):Promise<OriginalRef>;
    readOriginal(capture:OriginalCapture):Promise<{ref:OriginalRef;envelope:WindowsSealEnvelope}|null>;
  };
  parent:{rawResult(capture:OriginalCapture,result:NativeFrame<NativeResult>):Promise<NativeRawResultReference>;joinOriginal(capture:OriginalCapture):Promise<ParentJoinAck>};
  clock:{nowMs():number;waitUntil(deadlineMs:number):Promise<void>};
}
const bounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
const controlMax=131072;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const token=/^[A-Za-z0-9._-]{1,128}$/;
const codePattern=/^[A-Z][A-Z0-9_]{0,127}$/;
const phases:Phase[]=['NEW','PREPARING','PREPARED','GO_GRANTED','DRAINING','JOINED','UNCONFIRMED'];
const reasons:WindowsStopReason[]=['CALLER_ABORT','DEADLINE','CONTROL_LOST','INPUT_LIMIT','OUTPUT_LIMIT','JOURNAL_UNCONFIRMED','HOST_FAILED'];
const u64=18446744073709551615n;
function fail(code='WINDOWS_BACKEND_INVALID',status=422):never{throw new DomainError(code,status,'WAIT');}
function check(value:unknown,code='WINDOWS_BACKEND_INVALID'):asserts value{if(!value)fail(code);}
function object(value:unknown,keys:readonly string[]):Row{
  check(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value));
  check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const actual=Reflect.ownKeys(value);check(actual.length===keys.length&&actual.every(k=>typeof k==='string'&&keys.includes(k)));
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);check(d?.enumerable&&'value'in d);}return value as Row;
}
function id(value:unknown){check(typeof value==='string'&&uuid.test(value));}
function hash(value:unknown){check(typeof value==='string'&&hex.test(value));}
function code(value:unknown){check(typeof value==='string'&&codePattern.test(value));}
function integer(value:unknown,min=0,max=0xffffffff){check(typeof value==='number'&&Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=min&&value<=max);}
function decimal(value:unknown,positive=false,max=u64):bigint{
  check(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value));const n=BigInt(value);check(n<=max&&(!positive||n>0n));return n;
}
function same(a:unknown,b:unknown){check(digest(a)===digest(b),'WINDOWS_ORIGINAL_MISMATCH');}
function frozen<T>(value:T):T{
  if(value&&typeof value==='object'){for(const v of Object.values(value))frozen(v);Object.freeze(value);}return value;
}
// 사용자 getter/proxy/alias 폭발을 읽거나 stringify하기 전에 node·byte 예산을 검사한다.
function data(value:unknown,maxBytes=controlMax,ascii=true,maxDepth=20,maxNodes=8192,lease?:(bytes:number)=>void,copy=true):unknown{
  let nodes=0,bytes=0;const ancestors=new Set<object>();
  const add=(n:number)=>{bytes+=n;if(bytes>maxBytes)fail('WINDOWS_CONTROL_LIMIT',413);};
  const quoted=(s:string)=>{
    if(s.length>maxBytes)fail('WINDOWS_CONTROL_LIMIT',413);add(2);
    for(const ch of s){const n=ch.codePointAt(0)!;check((n<0xd800||n>0xdfff)&&(!ascii||n>=32&&n<=126));add(n<32?6:ch==='"'||ch==='\\'?2:Buffer.byteLength(ch));}
  };
  const visit=(v:unknown,depth:number):void=>{
    if(++nodes>maxNodes||depth>maxDepth)fail('WINDOWS_CONTROL_LIMIT',413);
    check(!types.isProxy(v));if(v===null){add(4);return;}
    if(typeof v==='string'){quoted(v);return;}if(typeof v==='boolean'){add(v?4:5);return;}
    if(typeof v==='number'){check(Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER&&!Object.is(v,-0)&&(!ascii||Number.isSafeInteger(v)));add(String(v).length);return;}
    check(typeof v==='object'&&v!==null&&!ancestors.has(v));ancestors.add(v);
    try{
      if(Array.isArray(v)){
        check(Object.getPrototypeOf(v)===Array.prototype);if(v.length>maxNodes-nodes)fail('WINDOWS_CONTROL_LIMIT',413);
        check(Reflect.ownKeys(v).length===v.length+1);add(2+Math.max(0,v.length-1));
        for(let n=0;n<v.length;n++){const d=Object.getOwnPropertyDescriptor(v,String(n));check(d?.enumerable&&'value'in d);visit(d.value,depth+1);}return;
      }
      check(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
      const keys=Reflect.ownKeys(v);if(keys.length>maxNodes-nodes)fail('WINDOWS_CONTROL_LIMIT',413);add(2+Math.max(0,keys.length-1));
      for(const k of keys){check(typeof k==='string');const d=Object.getOwnPropertyDescriptor(v,k);check(d?.enumerable&&'value'in d);quoted(k);add(1);visit(d.value,depth+1);}
    }finally{ancestors.delete(v);}
  };
  visit(value,0);lease?.(bytes);
  if(!copy)return value;
  const clone=(v:unknown):unknown=>{
    if(v===null||typeof v!=='object')return v;
    if(Array.isArray(v)){const result:unknown[]=[];for(let n=0;n<v.length;n++)result.push(clone(Object.getOwnPropertyDescriptor(v,String(n))!.value));return result;}
    const result:Row=Object.create(null);
    for(const k of Reflect.ownKeys(v) as string[])result[k]=clone(Object.getOwnPropertyDescriptor(v,k)!.value);
    return result;
  };
  // 두 순회 사이에는 await나 사용자 코드를 실행하지 않는다.
  return clone(value);
}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const viewBuffer=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const viewOffset=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!;
const viewLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
function binaryView(value:unknown):Uint8Array{
  check(!types.isProxy(value)&&types.isUint8Array(value),'WINDOWS_BINARY_INVALID');
  try{return new Uint8Array(viewBuffer.call(value) as ArrayBufferLike,viewOffset.call(value) as number,viewLength.call(value) as number);}
  catch{fail('WINDOWS_BINARY_INVALID');}
}
function goRef(v:unknown):GoRef{const r=object(v,['jobId','rowDigest']);id(r.jobId);hash(r.rowDigest);return r as GoRef;}
function originalRef(v:unknown):OriginalRef{const r=object(v,['recordId','digest']);id(r.recordId);hash(r.digest);return r as OriginalRef;}
function parentAck(v:unknown):ParentJoinAck{const r=object(v,['joinId','originDigest','digest']);id(r.joinId);hash(r.originDigest);hash(r.digest);return r as ParentJoinAck;}
function eventAck(v:unknown):EventAck{const r=object(v,['eventId','payloadDigest','sourceDigest']);id(r.eventId);hash(r.payloadDigest);hash(r.sourceDigest);return r as EventAck;}
function finalized(v:unknown):HostFinalized{
  const r=object(v,['recordId','digest','handles','closeCode']);originalRef({recordId:r.recordId,digest:r.digest});
  check(r.handles==='CLOSED'||r.handles==='UNCONFIRMED');if(r.handles==='CLOSED')check(r.closeCode===null);else code(r.closeCode);return r as HostFinalized;
}
function origin(value:unknown):Origin{
  const r=object(value,['identity','authority','pins','policy','limits']);
  const i=object(r.identity,['binding','intentDigest','sourceInput','inputEvidenceDigest','inputFingerprint','basisRef']);
  const b=object(i.binding,['accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest']);
  for(const k of ['accountId','capacityReservationId','jobId','parentInstanceId'])id(b[k]);
  for(const k of ['inputDigest','profileDigest','kernelDigest'])hash(b[k]);
  for(const k of ['intentDigest','inputEvidenceDigest','inputFingerprint'])hash(i[k]);
  const source=object(i.sourceInput,['executionId','inputEvidenceId','stageInputDigest']);id(source.executionId);id(source.inputEvidenceId);hash(source.stageInputDigest);
  if(i.basisRef!==null){const e=object(i.basisRef,['evidenceId','evidenceDigest']);id(e.evidenceId);hash(e.evidenceDigest);}
  const a=object(r.authority,['attemptId','controllerInstanceId','controllerId','keyVersion','environmentDigest','hostEpochId','sessionId','launchId','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest']);
  for(const k of ['attemptId','controllerInstanceId','hostEpochId','sessionId','launchId'])id(a[k]);
  for(const k of ['controllerId','keyVersion'])check(typeof a[k]==='string'&&token.test(a[k] as string));
  for(const k of ['environmentDigest','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest'])hash(a[k]);
  const pins=object(r.pins,['executableDigest','bootstrapDigest','helperRuntimeDigest','helperScriptDigest','runtimeFilesDigest','nativeLimitsDigest']);for(const v of Object.values(pins))hash(v);
  const p=object(r.policy,['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes']);
  integer(p.maxProcesses,1);check(decimal(p.processCommitLimitBytes,true)<=decimal(p.jobCommitLimitBytes,true));
  integer(p.cpuRatePer10000,1,10000);integer(p.wallTimeoutMs,1,2147483647);integer(p.joinTimeoutMs,1,2147483647);decimal(p.stdoutMaxBytes,true);decimal(p.stderrMaxBytes,true);
  const l=object(r.limits,['maxMetadataBytes','maxInputBytes','maxOutputBytes','maxItems','childMemoryBytes','maxProcesses','timeoutMs','terminationWaitMs','parentInFlightBytes']);
  validateNativeLimits(l as NativeLimits);check(Number.isSafeInteger((l.maxOutputBytes as number)+(l.maxMetadataBytes as number)+12),'WINDOWS_FRAME_LIMIT');same(a.policyDigest,digest(p));same(pins.nativeLimitsDigest,digest(l));
  check((p.maxProcesses as number)<=(l.maxProcesses as number)&&(p.wallTimeoutMs as number)<=(l.timeoutMs as number)&&(p.joinTimeoutMs as number)<=(l.terminationWaitMs as number));
  return r as unknown as Origin;
}
function common(r:Row){
  check(r.version===1);id(r.requestId);hash(r.originDigest);id(r.attemptId);id(r.sessionId);id(r.launchId);
}
function validateControl(value:unknown,lease?:(bytes:number)=>void):WindowsControl{
  const r=object(data(value,controlMax,true,20,8192,lease),['version','requestId','originDigest','attemptId','sessionId','launchId','command','payload']);common(r);
  switch(r.command){
    case 'PREPARE':{const p=object(r.payload,['origin','launchRef']);origin(p.origin);id(p.launchRef);break;}
    case 'ACK_EVENT':eventAck(r.payload);break;
    case 'GRANT_GO':goRef(object(r.payload,['goGrantRef']).goGrantRef);break;
    case 'PARENT_JOINED':parentAck(r.payload);break;
    case 'STOP':check(reasons.includes(object(r.payload,['reason']).reason as WindowsStopReason));break;
    case 'QUERY':object(r.payload,[]);break;
    case 'ACK_FINAL':originalRef(r.payload);break;
    default:fail();
  }
  return frozen(r as unknown as WindowsControl);
}
function decodeFrame(bytes:Uint8Array):unknown{
  const view=binaryView(bytes);check(view.byteLength>=4&&view.byteLength<=controlMax+4);
  const b=Buffer.from(view.buffer,view.byteOffset,view.byteLength),n=b.readUInt32BE(0);check(n>0&&n<=controlMax&&b.length===n+4);
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(4));}catch{fail();}
  return parseStrictJson(text,controlMax);
}
export function encodeWindowsControl(value:WindowsControl):Buffer{
  const c=validateControl(value),body=Buffer.from(canonicalize(c)!,'ascii');check(body.length<=controlMax);
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);return Buffer.concat([prefix,body]);
}
export function decodeWindowsControl(bytes:Uint8Array):WindowsControl{return validateControl(decodeFrame(bytes));}

const basicKeys=['TotalUserTime','TotalKernelTime','ThisPeriodTotalUserTime','ThisPeriodTotalKernelTime','TotalPageFaultCount','TotalProcesses','ActiveProcesses','TotalTerminatedProcesses'];
const ioKeys=['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount'];
const limitKeys=['PerProcessUserTimeLimit','PerJobUserTimeLimit','LimitFlags','MinimumWorkingSetSize','MaximumWorkingSetSize','ActiveProcessLimit','Affinity','PriorityClass','SchedulingClass'];
function basicInfo(v:unknown):Row{const r=object(v,basicKeys);for(const k of basicKeys.slice(0,4))decimal(r[k]);for(const k of basicKeys.slice(4))integer(r[k]);return r;}
function ioInfo(v:unknown):Row{const r=object(v,ioKeys);for(const k of ioKeys)decimal(r[k]);return r;}
function extendedInfo(v:unknown):Row{
  const r=object(v,['BasicLimitInformation','IoInfo','ProcessMemoryLimit','JobMemoryLimit','PeakProcessMemoryUsed','PeakJobMemoryUsed']);
  const b=object(r.BasicLimitInformation,limitKeys);for(const k of ['LimitFlags','ActiveProcessLimit','PriorityClass','SchedulingClass'])integer(b[k]);
  for(const k of limitKeys.filter(k=>!['LimitFlags','ActiveProcessLimit','PriorityClass','SchedulingClass'].includes(k)))decimal(b[k]);
  ioInfo(r.IoInfo);for(const k of ['ProcessMemoryLimit','JobMemoryLimit','PeakProcessMemoryUsed','PeakJobMemoryUsed'])decimal(r[k]);return r;
}
function queryValue(value:unknown):void{
  const r=object(value,['informationClass','values']);
  switch(r.informationClass){
    case 'EXTENDED_LIMITS':extendedInfo(r.values);break;
    case 'CPU_RATE':{const v=object(r.values,['ControlFlags','CpuRate']);integer(v.ControlFlags);integer(v.CpuRate);break;}
    case 'BASIC_ACCOUNTING':basicInfo(r.values);break;
    case 'BASIC_AND_IO':{const v=object(r.values,['BasicInfo','IoInfo']);basicInfo(v.BasicInfo);ioInfo(v.IoInfo);break;}
    default:fail();
  }
}
function tokenValue(value:unknown):void{
  const r=object(value,['informationClass','values']);
  switch(r.informationClass){
    case 'TOKEN_USER':case 'TOKEN_APPCONTAINER_SID':case 'TOKEN_INTEGRITY_LEVEL':hash(object(r.values,['sidDigest']).sidDigest);break;
    case 'TOKEN_IS_APPCONTAINER':check(typeof object(r.values,['isAppContainer']).isAppContainer==='boolean');break;
    case 'TOKEN_SESSION_ID':integer(object(r.values,['sessionId']).sessionId);break;
    default:fail();
  }
}
function winValue(api:string,value:unknown):void{
  switch(api){
    case 'CreateJobObjectW':case 'OpenProcessToken':id(object(value,['objectRef']).objectRef);break;
    case 'CreateProcessAsUserW':{const v=object(value,['processRef','threadRef','pid']);id(v.processRef);id(v.threadRef);integer(v.pid,1);break;}
    case 'GetProcessTimes':{const v=object(value,['processRef','creationFileTime100ns','userTime100ns','kernelTime100ns']);id(v.processRef);for(const k of ['creationFileTime100ns','userTime100ns','kernelTime100ns'])decimal(v[k]);break;}
    case 'IsProcessInJob':check(typeof object(value,['isMember']).isMember==='boolean');break;
    case 'ResumeThread':integer(object(value,['previousSuspendCount']).previousSuspendCount);break;
    case 'WaitForSingleObject':check(['SIGNALED','TIMEOUT','FAILED'].includes(object(value,['waitResult']).waitResult as string));break;
    case 'GetExitCodeProcess':integer(object(value,['exitCode']).exitCode);break;
    case 'QueryInformationJobObject':queryValue(value);break;
    case 'GetTokenInformation':tokenValue(value);break;
    case 'QueryPerformanceCounter':decimal(object(value,['ticks']).ticks);break;
    case 'QueryPerformanceFrequency':decimal(object(value,['frequency']).frequency,true);break;
    case 'GetNativeSystemInfo':integer(object(value,['processorArchitecture']).processorArchitecture,0,65535);break;
    case 'IsWow64Process2':{const v=object(value,['processMachine','nativeMachine']);integer(v.processMachine,0,65535);integer(v.nativeMachine,0,65535);break;}
    case 'ProcessIdToSessionId':integer(object(value,['sessionId']).sessionId);break;
    case 'SetInformationJobObject':case 'TerminateJobObject':case 'CloseHandle':check(typeof object(value,['returned']).returned==='boolean');break;
    default:fail();
  }
}
const winApis=['GetNativeSystemInfo','IsWow64Process2','ProcessIdToSessionId','CreateJobObjectW','SetInformationJobObject','QueryInformationJobObject','CreateProcessAsUserW','IsProcessInJob','GetProcessTimes','OpenProcessToken','GetTokenInformation','ResumeThread','WaitForSingleObject','GetExitCodeProcess','TerminateJobObject','CloseHandle','QueryPerformanceCounter','QueryPerformanceFrequency'];
function fact(value:unknown):WindowsFact{
  check(value!==null&&typeof value==='object');const r=value as Row;
  if(r.kind==='WIN32'){
    object(r,['kind','callId','api','qpcTicks','status','win32Error','value']);id(r.callId);decimal(r.qpcTicks);check(winApis.includes(r.api as string));
    check(['RETURNED','FAILED','UNCONFIRMED'].includes(r.status as string));
    if(r.status==='RETURNED')check(r.win32Error===null&&r.value!==null);
    else if(r.status==='FAILED')integer(r.win32Error,1);
    else check(r.win32Error===null&&r.value===null);
    if(r.value!==null)winValue(r.api as string,r.value);
  }else if(r.kind==='IO'){
    object(r,['kind','callId','lane','operation','qpcTicks','status','bytesLength','sha256']);id(r.callId);decimal(r.qpcTicks);
    check(['IN','OUT','ERR'].includes(r.lane as string)&&['READ','WRITE','CLOSE'].includes(r.operation as string)&&['RETURNED','FAILED','UNCONFIRMED'].includes(r.status as string));
    if(r.bytesLength!==null){decimal(r.bytesLength);hash(r.sha256);}else check(r.sha256===null&&r.status!=='RETURNED');
    if(r.status==='UNCONFIRMED')check(r.bytesLength===null&&r.sha256===null);
  }else if(r.kind==='PARENT_ACK'){
    object(r,['kind','qpcTicks','ack']);decimal(r.qpcTicks);parentAck(r.ack);
  }else if(r.kind==='ORIGINAL_GO'){
    object(r,['kind','qpcTicks','goGrantRef']);decimal(r.qpcTicks);goRef(r.goGrantRef);
  }else fail();
  return r as unknown as WindowsFact;
}
const eventKeys:Record<Kind,readonly string[]>={
  PRE_CREATE:['bindingDigest','policyDigest','pinsDigest'],CREATE_NOT_ATTEMPTED:['code'],CREATE_ARMED:['callId'],CREATE_FAILED:['win32Error','creationConfirmedAbsent'],
  CREATED_SUSPENDED:['pid','creationFileTime100ns','assignedBy'],PREPARED:['membershipConfirmed','tokenDigest','osReadbackDigest','brokerAppliedDigest'],
  BOOTSTRAP_RESUMED:['resumeReturned'],GO_AUTHORIZED:['goGrantRef'],GO_WRITE_ARMED:['bytesLength'],GO_WRITE:['result','bytesLength'],
  ROOT_EXIT:['exitCode'],TREE_EMPTY:['activeProcesses','totalProcesses'],IO_JOINED:['stdinClosed','stdoutEof','stderrEof','parentIoJoined'],
  FINAL_ACCOUNTING:['accounting'],FAILED:['code','phase'],
};
function entry(value:unknown):JournalEntry{
  const r=object(value,['event','source','sourceDigest']);
  const e=object(r.event,['eventId','sequence','kind','qpcTicks','previousDigest','payload','payloadDigest']);
  id(e.eventId);integer(e.sequence,1,64);decimal(e.qpcTicks);hash(e.payloadDigest);if(e.previousDigest!==null)hash(e.previousDigest);
  check(typeof e.kind==='string'&&Object.hasOwn(eventKeys,e.kind));object(e.payload,eventKeys[e.kind as Kind]);
  const {payloadDigest:_digest,...body}=e;same(e.payloadDigest,digest(body));
  const s=object(r.source,['version','originDigest','eventId','facts']);check(s.version===1);hash(s.originDigest);id(s.eventId);
  check(s.eventId===e.eventId&&Array.isArray(s.facts));for(const f of s.facts)fact(f);
  hash(r.sourceDigest);same(r.sourceDigest,digest(s));return r as unknown as JournalEntry;
}
function hostMessage(value:unknown,lease?:(bytes:number)=>void):WindowsHostMessage{
  const r=object(data(value,controlMax,true,20,8192,lease),['version','requestId','originDigest','attemptId','sessionId','launchId','message','payload']);common(r);
  switch(r.message){
    case 'EVENT':entry(r.payload);break;
    case 'PROGRESS':{
      const p=object(r.payload,['phase','bootstrap','bootstrapFact']);check(phases.includes(p.phase as Phase)&&['NONE','WAIT','READY'].includes(p.bootstrap as string));
      if(p.bootstrapFact!==null)fact(p.bootstrapFact);if(p.bootstrap==='NONE')check(p.bootstrapFact===null);else check(p.bootstrapFact!==null);break;
    }
    case 'FINAL_CANDIDATE':validateWindowsJobEvidence(object(r.payload,['evidence']).evidence,bounds);break;
    case 'FINALIZED':finalized(r.payload);break;
    case 'ERROR':code(object(r.payload,['code']).code);break;
    default:fail();
  }
  return frozen(r as unknown as WindowsHostMessage);
}
export function decodeWindowsHostMessage(bytes:Uint8Array):WindowsHostMessage{return hostMessage(decodeFrame(bytes));}
const ranks:Record<Kind,number>={PRE_CREATE:0,CREATE_ARMED:1,CREATE_NOT_ATTEMPTED:2,CREATE_FAILED:2,CREATED_SUSPENDED:2,PREPARED:3,BOOTSTRAP_RESUMED:4,GO_AUTHORIZED:5,GO_WRITE_ARMED:6,GO_WRITE:7,ROOT_EXIT:8,TREE_EMPTY:9,IO_JOINED:10,FINAL_ACCOUNTING:11,FAILED:12};
const predecessors:Partial<Record<Kind,Kind>>={CREATE_ARMED:'PRE_CREATE',CREATE_NOT_ATTEMPTED:'PRE_CREATE',CREATE_FAILED:'CREATE_ARMED',CREATED_SUSPENDED:'CREATE_ARMED',PREPARED:'CREATED_SUSPENDED',BOOTSTRAP_RESUMED:'PREPARED',GO_AUTHORIZED:'BOOTSTRAP_RESUMED',GO_WRITE_ARMED:'GO_AUTHORIZED',GO_WRITE:'GO_WRITE_ARMED',ROOT_EXIT:'CREATED_SUSPENDED',TREE_EMPTY:'ROOT_EXIT',IO_JOINED:'TREE_EMPTY',FINAL_ACCOUNTING:'IO_JOINED',FAILED:'PRE_CREATE'};
const waitHash='b9e6d54a9694eb1ddba925555cbf67d3bee05d4d9c38507347ae43802557269b';
const goHash='dd534169003916274ed5ead59b2ed78b931a1fffdee3b41e44999ce8dcc624ca';
const readyHash='ba68decf5e8f845bf12cc7b54043cfc0d0ea5a625b9657df28334bccb7d67c4d';
function ioMatches(f:WindowsFact,lane:string,operation:string,length:string,hash:string){
  return f.kind==='IO'&&f.status==='RETURNED'&&f.lane===lane&&f.operation===operation&&f.bytesLength===length&&f.sha256===hash;
}
function winFacts(facts:readonly WindowsFact[],api:string):Row[]{
  return facts.filter((f):f is Extract<WindowsFact,{kind:'WIN32'}>=>f.kind==='WIN32'&&f.api===api&&f.status==='RETURNED').map(f=>f.value as Row);
}
function one<T>(values:readonly T[]):T{check(values.length===1,'WINDOWS_SOURCE_MISMATCH');return values[0];}
function query(facts:readonly WindowsFact[],kind:string):Row{
  return one(winFacts(facts,'QueryInformationJobObject').filter(v=>v.informationClass===kind)).values as Row;
}
function osPolicy(facts:readonly WindowsFact[]):WindowsJobEvidence['policy']['osReadback']{
  const v=query(facts,'EXTENDED_LIMITS'),b=v.BasicLimitInformation as Row,c=query(facts,'CPU_RATE');
  const flags=b.LimitFlags as number;check(((c.ControlFlags as number)&5)===5);
  return {maxProcesses:b.ActiveProcessLimit as number,jobCommitLimitBytes:v.JobMemoryLimit as string,processCommitLimitBytes:v.ProcessMemoryLimit as string,cpuRatePer10000:c.CpuRate as number,killOnJobClose:((flags&0x2000)!==0) as true,breakawayAllowed:((flags&0x1800)!==0) as false};
}
function accountingFrom(facts:readonly WindowsFact[],created:string,end:string):WindowsJobAccounting{
  const value=query(facts,'BASIC_AND_IO'),b=value.BasicInfo as Row,i=value.IoInfo as Row,x=query(facts,'EXTENDED_LIMITS');
  check(b.ActiveProcesses===0&&(b.TotalProcesses as number)>=1,'WINDOWS_ACCOUNTING_LIVE');
  const freq=one(winFacts(facts,'QueryPerformanceFrequency')).frequency as string;
  check(one(winFacts(facts,'QueryPerformanceCounter')).ticks===end);
  return {userTime100ns:b.TotalUserTime as string,kernelTime100ns:b.TotalKernelTime as string,peakJobMemoryBytes:x.PeakJobMemoryUsed as string,peakProcessMemoryBytes:x.PeakProcessMemoryUsed as string,
    readOperations:i.ReadOperationCount as string,writeOperations:i.WriteOperationCount as string,otherOperations:i.OtherOperationCount as string,readBytes:i.ReadTransferCount as string,writeBytes:i.WriteTransferCount as string,otherBytes:i.OtherTransferCount as string,
    totalProcesses:String(b.TotalProcesses),startQpcTicks:created,endQpcTicks:end,qpcFrequency:freq,snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS'};
}
function signal<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});
  return {promise,resolve,reject};
}
function errorCode(error:unknown,fallback='WINDOWS_BACKEND_UNCONFIRMED'){return error instanceof DomainError&&codePattern.test(error.code)?error.code:fallback;}

class Coordinator implements WindowsJobBackend{
  private readonly origin:Origin;private frame:NativeFrame<NativeJob>|null;private readonly originDigest:string;
  private phase:Phase='NEW';private prepared:WindowsPreparedAttempt|null=null;private outcome:WindowsJobOutcome|null=null;
  private capture:OriginalCapture|null=null;private session:BrokerSession|null=null;
  private prepareWork:Promise<WindowsPreparedAttempt>|null=null;private goWork:Promise<WindowsJobOutcome>|null=null;
  private prepareTask:Promise<void>|null=null;private grantTask:Promise<void>|null=null;
  private readonly preparedSignal=signal<WindowsPreparedAttempt>();private readonly terminal=signal<WindowsJobOutcome>();
  private readonly inputDecision=signal<void>();
  private terminalResolved=false;private stopped:WindowsStopReason|null=null;private localCode:string|null=null;private invalid=false;
  private readonly pending=new Set<Promise<unknown>>();private controlWork:Promise<void>|null=null;private nativeWork:Promise<void>|null=null;
  private writeWork:Promise<void>|null=null;private parentWork:Promise<void>|null=null;private eventsEnded=false;private transportDone=false;
  private hostJoin:{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}|null=null;private finalMessage:HostFinalized|null=null;
  private readonly events:JournalEntry[]=[];private readonly kinds=new Map<Kind,JournalEntry>();private readonly calls=new Map<string,string>();
  private finalRequestId:string|null=null;private readonly requests=new Set<string>();private stopSent=false;private ready:WindowsFact|null=null;
  private go:GoRef|null=null;private waitObserved=false;private nativeEnded=false;private parent:ParentJoinAck|null=null;
  private raw:NativeRawResultReference|null=null;private candidate:WindowsJobEvidence|null=null;private record:OriginalRef|null=null;
  private completing=false;private appendCount=0;private held=0;private outputBytes=0;
  private startedAt:number|null=null;private deadline=0;private preparedOs:WindowsJobEvidence['policy']['osReadback']=null;
  private preparedBroker:WindowsJobEvidence['policy']['brokerApplied']=null;
  constructor(input:WindowsPrepareInput,private readonly ports:WindowsJobPorts){
    object(ports,['original','broker','journal','parent','clock']);
    for(const [name,methods]of Object.entries({original:['captureFresh','grantOriginal','readOriginal'],broker:['open','readOriginal'],journal:['appendOriginal','lookupEvent','scanOriginal','sealOriginal','readOriginal'],parent:['rawResult','joinOriginal'],clock:['nowMs','waitUntil']})){
      const port=object(ports[name as keyof WindowsJobPorts],methods);for(const method of methods)check(typeof port[method]==='function','WINDOWS_PORT_REQUIRED');
    }
    object(input,['identity','authority','pins','policy','limits','frame']);
    const initial=object(input.limits,['maxMetadataBytes','maxInputBytes','maxOutputBytes','maxItems','childMemoryBytes','maxProcesses','timeoutMs','terminationWaitMs','parentInFlightBytes']);
    validateNativeLimits(initial as NativeLimits);const capacity=initial.parentInFlightBytes as number;let originBytes=0,frameBytes=0;
    this.origin=frozen(origin(data({identity:input.identity,authority:input.authority,pins:input.pins,policy:input.policy,limits:input.limits},controlMax,true,20,8192,bytes=>{
      const n=bytes*3;check(this.held+n<=capacity,'WINDOWS_PARENT_LIMIT');this.held+=n;originBytes=bytes;
    })));
    object(input.frame,['envelope','blobs']);check(!types.isProxy(input.frame.blobs)&&types.isMap(input.frame.blobs),'WINDOWS_FRAME_INVALID');
    const limits=this.origin.limits;
    const envelope=data(input.frame.envelope,limits.maxMetadataBytes,false,64,8192,bytes=>{this.reserve(bytes*3);frameBytes=bytes;}) as NativeJob;
    validateNativeEnvelope(envelope,{maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems});verifyNativeInput(envelope);
    const binding=this.origin.identity.binding;
    check(binding.jobId===envelope.jobId&&binding.profileDigest===envelope.profileDigest&&binding.inputDigest===envelope.inputDigest,'WINDOWS_INPUT_MISMATCH');
    const blobs=new Map<string,Buffer>();let binary=0;
    for(const [key,bytes]of Map.prototype.entries.call(input.frame.blobs) as MapIterator<[string,Buffer]>){
      check(typeof key==='string'&&!types.isProxy(bytes)&&Buffer.isBuffer(bytes),'WINDOWS_FRAME_INVALID');
      const view=binaryView(bytes),length=view.byteLength;
      binary+=length;check(Number.isSafeInteger(binary)&&binary<=limits.maxInputBytes,'WINDOWS_INPUT_LIMIT');
      const descriptor=envelope.blobs.find(b=>b.id===key);check(descriptor&&descriptor.byteLength===length,'WINDOWS_FRAME_INVALID');
      this.reserve(length);const captured=Buffer.alloc(length);Uint8Array.prototype.set.call(captured,view);
      check(descriptor.sha256===sha256(captured),'WINDOWS_FRAME_INVALID');blobs.set(key,captured);
    }
    check(blobs.size===envelope.blobs.length,'WINDOWS_FRAME_INVALID');
    this.reserve(12);
    this.frame={envelope:frozen(envelope),blobs};
    // originDigest에는 limits 전체 대신 그 정확한 digest만 들어간다.
    this.originDigest=digest({identity:this.origin.identity,authority:this.origin.authority,pins:this.origin.pins,policy:this.origin.policy,nativeLimitsDigest:digest(limits),frameInputDigest:envelope.inputDigest});
    // 검증·해시 계산의 임시 사본은 끝났다. 불변 입력 snapshot 한 벌의 예산만 보유한다.
    this.release(2*(originBytes+frameBytes));
  }
  private captureValue(value:unknown):unknown{
    let credit=0;
    try{return data(value,controlMax,true,20,8192,bytes=>{const n=bytes*3;this.reserve(n);credit=n;});}
    catch(error){if(credit)this.release(credit);throw error;}
  }
  private inspectValue<T>(value:unknown,read:(value:unknown)=>T):T{
    let credit=0;
    try{const raw=data(value,controlMax,true,20,8192,bytes=>{const n=bytes*2;this.reserve(n);credit=n;},false);return read(raw);}
    finally{if(credit)this.release(credit);}
  }
  private reserve(bytes:number){
    check(Number.isSafeInteger(bytes)&&bytes>=0&&this.held+bytes<=this.origin.limits.parentInFlightBytes,'WINDOWS_PARENT_LIMIT');this.held+=bytes;
  }
  private release(bytes:number){this.held-=bytes;check(this.held>=0);}
  private track<T>(work:()=>Promise<T>):Promise<T>{
    let promise:Promise<T>;try{promise=Promise.resolve(work());}catch(error){promise=Promise.reject(error);}
    this.pending.add(promise);void promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));return promise;
  }
  private currentTime():number{
    const value=this.ports.clock.nowMs();check(Number.isFinite(value)&&value>=0,'WINDOWS_CLOCK_UNCONFIRMED');return value;
  }
  private fence(){check(!this.stopped&&!this.invalid&&this.currentTime()<this.deadline,'WINDOWS_ATTEMPT_STOPPED');}
  private requestStop(reason:WindowsStopReason,codeValue:string){
    if(this.phase==='JOINED')return;
    if(!this.stopped)this.stopped=reason;if(!this.localCode)this.localCode=codeValue;
    this.phase='DRAINING';
    this.preparedSignal.reject(new DomainError(codeValue,409,'WAIT'));this.inputDecision.resolve();
    if(this.session&&!this.stopSent){
      this.stopSent=true;void this.send('STOP',{reason:this.stopped}).catch(()=>{this.localCode??='WINDOWS_CONTROL_UNCONFIRMED';});
    }
    this.armJoinDeadline();
  }
  private armJoinDeadline(){
    if(this.joinDeadlineArmed)return;this.joinDeadlineArmed=true;
    try{
      const now=this.currentTime(),until=now+this.origin.policy.joinTimeoutMs;check(Number.isFinite(until)&&until>now,'WINDOWS_CLOCK_UNCONFIRMED');
      const waiting=this.ports.clock.waitUntil(until);check(types.isPromise(waiting),'WINDOWS_CLOCK_UNCONFIRMED');
      // 시계 관측 waiter는 원 native I/O가 아니며 실제 timer의 소유자는 주입된 clock이다.
      void waiting.then(()=>{if(this.phase!=='JOINED')this.finishWait(this.localCode??'WINDOWS_JOIN_UNCONFIRMED');},()=>this.finishWait('WINDOWS_CLOCK_UNCONFIRMED'));
    }catch{this.finishWait('WINDOWS_CLOCK_UNCONFIRMED');}
  }
  private joinDeadlineArmed=false;
  private finishWait(reason:string){
    if(this.phase==='JOINED')return;
    this.phase='UNCONFIRMED';this.localCode??=reason;
    this.outcome=frozen({state:'WAIT',code:this.localCode,evidence:this.candidate,rawResult:this.raw,journalRef:this.record});
    this.preparedSignal.reject(new DomainError(this.localCode,409,'WAIT'));
    if(!this.terminalResolved){this.terminalResolved=true;this.terminal.resolve(this.outcome);}
  }
  private async send<K extends keyof Commands>(command:K,payload:Commands[K]):Promise<void>{
    check(this.session&&this.capture,'WINDOWS_BROKER_UNCONFIRMED');
    let credit=0;
    try{
      const control=validateControl({version:1,requestId:randomUUID(),originDigest:this.originDigest,attemptId:this.origin.authority.attemptId,sessionId:this.origin.authority.sessionId,launchId:this.origin.authority.launchId,command,payload},bytes=>{
        const n=bytes*3+8;this.reserve(n);credit=n;
      });
      check(this.requests.size<128,'WINDOWS_CONTROL_LIMIT');this.requests.add(control.requestId);this.sentKinds.add(command);if(command==='ACK_FINAL')this.finalRequestId=control.requestId;
      await this.track(()=>this.session!.send(control));
    }finally{if(credit)this.release(credit);}
  }
  prepare():Promise<WindowsPreparedAttempt>{
    if(this.prepareWork)return this.prepareWork;
    if(this.stopped)return Promise.reject(new DomainError('WINDOWS_ATTEMPT_STOPPED',409,'WAIT'));
    try{
      this.phase='PREPARING';this.startedAt=this.currentTime();this.deadline=this.startedAt+this.origin.policy.wallTimeoutMs;
      check(Number.isFinite(this.deadline)&&this.deadline>this.startedAt,'WINDOWS_CLOCK_UNCONFIRMED');
      const waiting=this.ports.clock.waitUntil(this.deadline);check(types.isPromise(waiting),'WINDOWS_CLOCK_UNCONFIRMED');
      void waiting.then(()=>{if(this.phase!=='JOINED')this.requestStop('DEADLINE','WINDOWS_DEADLINE');},()=>this.requestStop('HOST_FAILED','WINDOWS_CLOCK_UNCONFIRMED'));
      this.prepareWork=this.preparedSignal.promise;
      this.prepareTask=this.begin().catch(error=>{
        this.requestStop(this.stopped??'HOST_FAILED',errorCode(error));if(!this.session)this.finishWait(errorCode(error));
      });
    }catch(error){
      const reason=errorCode(error,'WINDOWS_CLOCK_UNCONFIRMED');this.stopped='HOST_FAILED';this.finishWait(reason);
      this.prepareWork=Promise.reject(new DomainError(reason,409,'WAIT'));
    }
    void this.prepareWork.catch(()=>{});return this.prepareWork;
  }
  private async begin():Promise<void>{
    check(this.frame,'WINDOWS_FRAME_INVALID');
    const offered:WindowsPrepareInput={...this.origin,frame:this.frame};
    const created=await this.track(()=>this.ports.original.captureFresh(offered));
    const captured=this.inspectValue(created,value=>{
      const r=object(value,['created','capture']);check(typeof r.created==='boolean');
      const c=object(r.capture,['origin','originDigest','frameInputDigest','launchRef']);origin(c.origin);hash(c.originDigest);hash(c.frameInputDigest);id(c.launchRef);
      same(c.origin,this.origin);check(c.originDigest===this.originDigest&&c.frameInputDigest===this.origin.identity.binding.inputDigest,'WINDOWS_CAPTURE_MISMATCH');
      const flat=this.captureValue({originDigest:c.originDigest,frameInputDigest:c.frameInputDigest,launchRef:c.launchRef}) as Omit<OriginalCapture,'origin'>;
      return {fresh:r.created,flat};
    });
    // 정확히 대조한 원 tuple은 이미 소유한 불변 사본을 공유한다.
    this.capture=frozen({origin:this.origin,...captured.flat});
    this.fence();check(captured.fresh,'WINDOWS_FRESH_REQUIRED');
    await this.authority(false);this.fence();
    const session=await this.track(()=>this.ports.broker.open(this.capture!));
    check(session&&typeof session.send==='function'&&typeof session.join==='function'&&session.events?.[Symbol.asyncIterator]&&session.nativeOutput?.[Symbol.asyncIterator]&&session.nativeError?.[Symbol.asyncIterator]&&session.nativeInput instanceof Writable,'WINDOWS_BROKER_UNCONFIRMED');
    this.session=session;
    this.controlWork=this.pump();
    const joined=this.track(()=>session.join());
    void joined.then(value=>{
      const v=object(this.captureValue(value),['end','finalized']);check(v.end==='EXPECTED'||v.end==='LOST');
      if(v.finalized!==null)finalized(v.finalized);this.hostJoin=v as typeof this.hostJoin;this.transportDone=true;void this.tryComplete();
    }).catch(error=>{this.transportDone=true;this.requestStop('CONTROL_LOST',errorCode(error));void this.tryComplete();});
    if(this.stopped){this.requestStop(this.stopped,this.localCode??'WINDOWS_ATTEMPT_STOPPED');return;}
    this.fence();await this.send('PREPARE',{origin:this.origin,launchRef:this.capture.launchRef});
  }
  private async authority(requireGo:boolean):Promise<void>{
    check(this.capture);const value=await this.track(()=>this.ports.original.readOriginal(this.capture!));
    this.inspectValue(value,raw=>{
      const s=object(raw,['originDigest','state','goGrantRef']);
      check(s.originDigest===this.originDigest&&s.state==='CONFIRMED','WINDOWS_AUTHORITY_UNCONFIRMED');
      if(s.goGrantRef!==null)goRef(s.goGrantRef);
      if(requireGo){check(this.go&&s.goGrantRef,'WINDOWS_GO_UNCONFIRMED');same(s.goGrantRef,this.go);}
      else if(!this.go)check(s.goGrantRef===null,'WINDOWS_GO_ALREADY_USED');
    });
  }
  grantGo():Promise<WindowsJobOutcome>{
    if(this.goWork)return this.goWork;
    if(!this.prepared||this.stopped||this.invalid)return Promise.reject(new DomainError('WINDOWS_NOT_PREPARED',409,'WAIT'));
    this.goWork=this.terminal.promise;
    this.grantTask=this.grant().catch(error=>{this.requestStop('HOST_FAILED',errorCode(error));});
    return this.goWork;
  }
  private async grant(){
    this.fence();await this.authority(false);this.fence();
    const r=object(this.captureValue(await this.track(()=>this.ports.original.grantOriginal(this.capture!))),['created','goGrantRef']);
    check(typeof r.created==='boolean');const ref=goRef(r.goGrantRef);check(ref.jobId===this.origin.identity.binding.jobId,'WINDOWS_GO_MISMATCH');
    this.go=frozen(ref);this.fence();check(r.created,'WINDOWS_GO_UNCONFIRMED');await this.authority(true);this.fence();
    this.phase='GO_GRANTED';await this.send('GRANT_GO',{goGrantRef:this.go});
  }
  stop(reason:WindowsStopReason):Promise<WindowsJobOutcome>{
    if(!reasons.includes(reason))return Promise.reject(new DomainError('WINDOWS_STOP_INVALID',422,'WAIT'));
    if(this.phase==='JOINED')return Promise.resolve(this.outcome!);
    this.requestStop(reason,'WINDOWS_'+reason);
    if(!this.prepareWork&&!this.session)this.finishWait('WINDOWS_'+reason);
    return this.terminal.promise;
  }
  query():Promise<WindowsJobView>{return Promise.resolve(frozen({phase:this.phase,prepared:this.prepared,outcome:this.outcome}));}
  async idle():Promise<void>{
    for(;;){
      const work=[...this.pending,...[this.prepareWork,this.goWork,this.prepareTask,this.grantTask,this.controlWork,this.nativeWork,this.parentWork,this.writeWork].filter((p):p is Promise<never>=>p!==null)];
      if(!work.length)break;await Promise.allSettled(work);
      if(this.pending.size===0)break;
    }
  }
  private async pump(){
    try{
      for await(const value of this.session!.events){
        let credit=0;let message:WindowsHostMessage|null=null;const oldCandidate=this.candidate;
        try{
          message=hostMessage(value,bytes=>{const n=bytes*3;this.reserve(n);credit=n;});
          check(message.originDigest===this.originDigest&&message.attemptId===this.origin.authority.attemptId&&message.sessionId===this.origin.authority.sessionId&&message.launchId===this.origin.authority.launchId,'WINDOWS_HOST_MISMATCH');
          // requestId는 correlation이며 transport peer의 권위를 대신하지 않는다.
          check(this.requests.has(message.requestId),'WINDOWS_CORRELATION_MISMATCH');
          if(message.message==='EVENT')await this.onEvent(message.payload);
          else if(message.message==='PROGRESS')this.progress(message.payload);
          else if(message.message==='FINAL_CANDIDATE')await this.seal(message.payload.evidence);
          else if(message.message==='FINALIZED'){
            check(message.requestId===this.finalRequestId,'WINDOWS_FINAL_CORRELATION');
            check(this.record,'WINDOWS_FINAL_UNCONFIRMED');same({recordId:message.payload.recordId,digest:message.payload.digest},this.record);
            if(this.finalMessage)same(this.finalMessage,message.payload);else this.finalMessage=message.payload;
          }else this.requestStop('HOST_FAILED',message.payload.code);
        }finally{
          const retained=message&&(message.message==='EVENT'&&this.events.some(r=>r===message!.payload)||
            message.message==='PROGRESS'&&message.payload.bootstrapFact===this.ready&&this.ready!==null||
            message.message==='FINAL_CANDIDATE'&&this.candidate!==oldCandidate||
            message.message==='FINALIZED'&&message.payload===this.finalMessage);
          if(credit&&retained&&message?.message==='EVENT'){
            // 보존하는 것은 원 row뿐이다. 처리 완료된 Common wrapper는 다음 읽기 전에 해제한다.
            let rowCredit=0;data(message.payload,controlMax,true,20,8192,bytes=>{rowCredit=bytes*3;},false);
            this.release(credit-rowCredit);
          }else if(credit&&!retained)this.release(credit);
        }
      }
    }catch(error){
      this.invalid=true;this.requestStop('CONTROL_LOST',errorCode(error));
    }finally{
      this.eventsEnded=true;if(!this.finalMessage)this.requestStop('CONTROL_LOST',this.localCode??'WINDOWS_FINAL_UNCONFIRMED');
      void this.tryComplete();
    }
  }

  private async onEvent(row:JournalEntry){
    check(!this.record&&!this.invalid,'WINDOWS_EVENT_AFTER_SEAL');
    const e=row.event,old=this.kinds.get(e.kind);
    const noChildCleanup=e.kind==='CREATE_NOT_ATTEMPTED'||e.kind==='CREATE_FAILED';
    if(old){
      same(row,old);
      if(!this.stopped||ranks[e.kind]>=8||noChildCleanup){
        await this.send('ACK_EVENT',{eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest});
        if(noChildCleanup)await this.joinParent();
      }return;
    }
    check(row.source.originDigest===this.originDigest,'WINDOWS_SOURCE_MISMATCH');
    check(e.sequence===this.events.length+1&&e.previousDigest===(this.events.at(-1)?.event.payloadDigest??null),'WINDOWS_EVENT_ORDER');
    check(!this.events.some(r=>r.event.eventId===e.eventId)&&this.events.length<64,'WINDOWS_EVENT_ORDER');
    if(this.events.length)check(BigInt(e.qpcTicks)>=BigInt(this.events.at(-1)!.event.qpcTicks),'WINDOWS_EVENT_ORDER');
    if(!this.events.length)check(e.kind==='PRE_CREATE','WINDOWS_EVENT_ORDER');
    const prior=predecessors[e.kind];if(prior)check(this.kinds.has(prior),'WINDOWS_EVENT_ORDER');
    if(e.kind!=='FAILED'){
      const previous=this.events.filter(r=>r.event.kind!=='FAILED').at(-1);
      if(previous)check(ranks[e.kind]>ranks[previous.event.kind],'WINDOWS_EVENT_ORDER');
      if(this.kinds.has('FAILED'))check(ranks[e.kind]>=8,'WINDOWS_EVENT_ORDER');
    }
    const created=this.kinds.get('CREATED_SUSPENDED');
    if(created){
      const identity=one(created.source.facts.filter(x=>x.kind==='WIN32'&&x.api==='GetProcessTimes'));
      check(BigInt(e.qpcTicks)>=BigInt(identity.qpcTicks),'WINDOWS_SOURCE_TIME');
    }
    for(const f of row.source.facts){
      // 생성 source의 정확 pair는 projection에서 대조한다. 사건 시각은 원 생성 t0다.
      const identityConfirmation=e.kind==='CREATED_SUSPENDED'&&f.kind==='WIN32'&&f.api==='GetProcessTimes'&&f.status==='RETURNED';
      check(BigInt(f.qpcTicks)<=BigInt(e.qpcTicks)||identityConfirmation,'WINDOWS_SOURCE_TIME');
      this.rememberFact(f);
    }
    this.projection(row);
    this.events.push(row);this.kinds.set(e.kind,row);
    if(e.kind==='CREATED_SUSPENDED')this.startNative();
    const ref={eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest};
    this.appendCount++;
    try{
      let ack:EventAck;
      try{const value=await this.track(()=>this.ports.journal.appendOriginal(this.capture!,e,row.source));this.inspectValue(value,v=>same(eventAck(v),ref));ack=ref;}
      catch{
        const stored=await this.track(()=>this.ports.journal.lookupEvent(this.capture!,ref));
        check(stored,'WINDOWS_JOURNAL_UNCONFIRMED');this.inspectValue(stored,v=>same(entry(v),row));ack=ref;
      }
      same(ack,ref);
    }finally{this.appendCount--;}
    // ACK 응답을 새 생성·resume·GO 장벽으로 사용하는 prefix는 stop 뒤 재개하지 않는다.
    if(!this.stopped||ranks[e.kind]>=8||noChildCleanup){
      await this.send('ACK_EVENT',ref);
      if(noChildCleanup)await this.joinParent();
    }
  }
  private rememberFact(f:WindowsFact){
    if('callId'in f){
      const value=digest(f),old=this.calls.get(f.callId);check(!old||old===value,'WINDOWS_SOURCE_ID_REUSED');this.calls.set(f.callId,value);
    }
  }
  private projection(row:JournalEntry){
    const e=row.event,p=e.payload as unknown as Row,f=row.source.facts;
    switch(e.kind){
      case 'PRE_CREATE':
        same(p,{bindingDigest:digest(this.origin.identity),policyDigest:this.origin.authority.policyDigest,pinsDigest:digest(this.origin.pins)});break;
      case 'CREATE_ARMED':id(p.callId);check(!this.kinds.has('CREATE_NOT_ATTEMPTED'));break;
      case 'CREATE_NOT_ATTEMPTED':code(p.code);check(!this.kinds.has('CREATE_ARMED'));break;
      case 'CREATE_FAILED':{
        integer(p.win32Error,1);check(p.creationConfirmedAbsent===true);
        const call=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='CreateProcessAsUserW'&&x.status==='FAILED'));
        check(call.callId===(this.kinds.get('CREATE_ARMED')!.event.payload as {callId:string}).callId&&call.win32Error===p.win32Error);break;
      }
      case 'CREATED_SUSPENDED':{
        integer(p.pid,1);decimal(p.creationFileTime100ns);check(p.assignedBy==='PROC_THREAD_ATTRIBUTE_JOB_LIST'&&!this.kinds.has('CREATE_FAILED'));
        check(f.length===2&&f.every(x=>x.kind==='WIN32'&&x.status==='RETURNED'),'WINDOWS_SOURCE_MISMATCH');
        const call=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='CreateProcessAsUserW'&&x.status==='RETURNED'));
        const time=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='GetProcessTimes'&&x.status==='RETURNED'));
        const value=time.value as Row,armed=this.kinds.get('CREATE_ARMED')!;
        check(call.callId===(armed.event.payload as {callId:string}).callId&&call.callId!==time.callId&&(call.value as Row).pid===p.pid&&value.processRef===(call.value as Row).processRef&&value.creationFileTime100ns===p.creationFileTime100ns&&call.qpcTicks===e.qpcTicks,'WINDOWS_SOURCE_MISMATCH');
        check(BigInt(call.qpcTicks)>=BigInt(armed.event.qpcTicks)&&BigInt(time.qpcTicks)>=BigInt(call.qpcTicks),'WINDOWS_SOURCE_TIME');break;
      }
      case 'PREPARED':{
        const created=this.kinds.get('CREATED_SUSPENDED')!;
        const first=one(created.source.facts.filter(x=>x.kind==='WIN32'&&x.api==='GetProcessTimes'));
        const time=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='GetProcessTimes'));
        check(time.status==='RETURNED','WINDOWS_ROOT_MISMATCH');
        const identity=time.value as Row,root=created.event.payload as {creationFileTime100ns:string};
        check(identity.processRef===(one(winFacts(created.source.facts,'CreateProcessAsUserW'))).processRef&&identity.creationFileTime100ns===root.creationFileTime100ns,'WINDOWS_ROOT_MISMATCH');
        check(!this.events.some(row=>row.source.facts.some(x=>'callId'in x&&x.callId===time.callId)),'WINDOWS_SOURCE_ID_REUSED');
        check(f.every(x=>BigInt(x.qpcTicks)>=BigInt(first.qpcTicks)),'WINDOWS_SOURCE_TIME');
        check(p.membershipConfirmed===true&&one(winFacts(f,'IsProcessInJob')).isMember===true);
        const classes=['TOKEN_USER','TOKEN_APPCONTAINER_SID','TOKEN_IS_APPCONTAINER','TOKEN_INTEGRITY_LEVEL','TOKEN_SESSION_ID'];
        const all=winFacts(f,'GetTokenInformation'),tokens=classes.map(c=>one(all.filter(v=>v.informationClass===c)));
        check((tokens[0].values as Row).sidDigest===this.origin.authority.childSidDigest&&(tokens[1].values as Row).sidDigest===this.origin.authority.appContainerSidDigest&&(tokens[2].values as Row).isAppContainer===true,'WINDOWS_TOKEN_MISMATCH');
        const limits=query(f,'EXTENDED_LIMITS').BasicLimitInformation as Row;
        check(((limits.LimitFlags as number)&0x308)===0x308,'WINDOWS_LIMITS_NOT_APPLIED');
        same(p.tokenDigest,digest(tokens));const actual=osPolicy(f),requested=this.origin.policy;
        const expected={maxProcesses:requested.maxProcesses,jobCommitLimitBytes:requested.jobCommitLimitBytes,processCommitLimitBytes:requested.processCommitLimitBytes,cpuRatePer10000:requested.cpuRatePer10000,killOnJobClose:true,breakawayAllowed:false};
        same(actual,expected);
        const broker={wallTimeoutMs:requested.wallTimeoutMs,joinTimeoutMs:requested.joinTimeoutMs,stdoutMaxBytes:requested.stdoutMaxBytes,stderrMaxBytes:requested.stderrMaxBytes};
        same(p.osReadbackDigest,digest(actual));same(p.brokerAppliedDigest,digest(broker));this.preparedOs=actual;this.preparedBroker=broker;break;
      }
      case 'BOOTSTRAP_RESUMED':{
        const resume=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='ResumeThread'&&x.status==='RETURNED'));
        const wait=one(f.filter(x=>ioMatches(x,'OUT','READ','8',waitHash)));
        check(p.resumeReturned===true&&(resume.value as Row).previousSuspendCount===1,'WINDOWS_RESUME_UNCONFIRMED');
        check(BigInt(resume.qpcTicks)>=BigInt(this.kinds.get('PREPARED')!.event.qpcTicks)&&BigInt(wait.qpcTicks)>=BigInt(resume.qpcTicks)&&wait.qpcTicks===e.qpcTicks,'WINDOWS_SOURCE_TIME');break;
      }
      case 'GO_AUTHORIZED':check(this.go&&this.hasControl('GRANT_GO'),'WINDOWS_GO_UNCONFIRMED');same(p.goGrantRef,this.go);same(one(f.filter(x=>x.kind==='ORIGINAL_GO')), {kind:'ORIGINAL_GO',qpcTicks:e.qpcTicks,goGrantRef:this.go});break;
      case 'GO_WRITE_ARMED':check(p.bytesLength==='6'&&this.go,'WINDOWS_GO_UNCONFIRMED');break;
      case 'GO_WRITE':
        check(p.bytesLength==='6'&&(p.result==='RETURNED'||p.result==='UNCONFIRMED'));
        {
          const write=one(f.filter(x=>p.result==='RETURNED'?ioMatches(x,'IN','WRITE','6',goHash):x.kind==='IO'&&x.lane==='IN'&&x.operation==='WRITE'&&x.status==='UNCONFIRMED'));
          check(BigInt(write.qpcTicks)>=BigInt(this.kinds.get('GO_WRITE_ARMED')!.event.qpcTicks)&&write.qpcTicks===e.qpcTicks,'WINDOWS_SOURCE_TIME');
        }
        break;
      case 'ROOT_EXIT':{
        integer(p.exitCode);check(one(winFacts(f,'WaitForSingleObject')).waitResult==='SIGNALED'&&one(winFacts(f,'GetExitCodeProcess')).exitCode===p.exitCode,'WINDOWS_ROOT_UNCONFIRMED');break;
      }
      case 'TREE_EMPTY':{
        check(p.activeProcesses===0);decimal(p.totalProcesses,true,0xffffffffn);
        const sample=one(f.filter((x):x is Extract<WindowsFact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='QueryInformationJobObject'&&x.status==='RETURNED'&&(x.value as Row).informationClass==='BASIC_ACCOUNTING'));
        check(BigInt(sample.qpcTicks)>=BigInt(this.kinds.get('ROOT_EXIT')!.event.qpcTicks),'WINDOWS_SOURCE_TIME');
        const b=query(f,'BASIC_ACCOUNTING');check(b.ActiveProcesses===0&&String(b.TotalProcesses)===p.totalProcesses,'WINDOWS_TREE_UNCONFIRMED');break;
      }
      case 'IO_JOINED':{
        check(Object.values(p).every(v=>v===true)&&this.nativeEnded&&this.parent,'WINDOWS_IO_UNCONFIRMED');
        const empty=sha256(Buffer.alloc(0));
        check(f.some(x=>ioMatches(x,'IN','CLOSE','0',empty))&&f.some(x=>ioMatches(x,'OUT','READ','0',empty))&&f.some(x=>ioMatches(x,'ERR','READ','0',empty)),'WINDOWS_IO_UNCONFIRMED');
        const ack=one(f.filter((x):x is Extract<WindowsFact,{kind:'PARENT_ACK'}>=>x.kind==='PARENT_ACK'));same(ack.ack,this.parent);
        if(this.ready)check(f.some(x=>digest(x)===digest(this.ready)),'WINDOWS_READY_MISMATCH');break;
      }
      case 'FINAL_ACCOUNTING':{
        const joinedAt=BigInt(this.kinds.get('IO_JOINED')!.event.qpcTicks);
        for(const sample of f){
          if(sample.kind==='WIN32'&&sample.api==='QueryInformationJobObject'&&sample.status==='RETURNED'&&['BASIC_AND_IO','EXTENDED_LIMITS'].includes((sample.value as Row).informationClass as string))check(BigInt(sample.qpcTicks)>=joinedAt,'WINDOWS_SOURCE_TIME');
        }
        const actual=accountingFrom(f,this.kinds.get('CREATED_SUSPENDED')!.event.qpcTicks,e.qpcTicks);
        same(p.accounting,actual);check(actual.totalProcesses===(this.kinds.get('TREE_EMPTY')!.event.payload as {totalProcesses:string}).totalProcesses,'WINDOWS_ACCOUNTING_MISMATCH');break;
      }
      case 'FAILED':code(p.code);check(['CREATE','PREPARE','GO','DRAIN'].includes(p.phase as string));break;
    }
  }
  private readonly sentKinds=new Set<keyof Commands>();
  private hasControl(command:keyof Commands){return this.sentKinds.has(command);}
  private progress(p:HostPayloads['PROGRESS']){
    if(p.bootstrap==='NONE')return;
    const f=p.bootstrapFact!;this.rememberFact(f);
    if(p.bootstrap==='WAIT'){
      const original=this.kinds.get('BOOTSTRAP_RESUMED');
      check(original&&ioMatches(f,'OUT','READ','8',waitHash)&&original.source.facts.some(x=>digest(x)===digest(f)),'WINDOWS_WAIT_UNCONFIRMED');
      check(p.phase==='PREPARED'&&!this.waitObserved,'WINDOWS_WAIT_UNCONFIRMED');this.waitObserved=true;
      if(this.stopped)return;
      this.fence();check(this.kinds.has('PREPARED'),'WINDOWS_NOT_PREPARED');
      const r=this.kinds.get('CREATED_SUSPENDED')!.event.payload as {pid:number;creationFileTime100ns:string};
      this.prepared=frozen({originDigest:this.originDigest,attemptId:this.origin.authority.attemptId,controllerInstanceId:this.origin.authority.controllerInstanceId,sessionId:this.origin.authority.sessionId,launchId:this.origin.authority.launchId,root:{pid:r.pid,creationFileTime100ns:r.creationFileTime100ns}});
      this.phase='PREPARED';this.preparedSignal.resolve(this.prepared);
    }else{
      check(this.go&&this.kinds.has('GO_WRITE')&&(this.kinds.get('GO_WRITE')!.event.payload as {result:string}).result==='RETURNED'&&ioMatches(f,'OUT','READ','9',readyHash),'WINDOWS_READY_UNCONFIRMED');
      check(BigInt(f.qpcTicks)>=BigInt(this.kinds.get('GO_WRITE')!.event.qpcTicks),'WINDOWS_SOURCE_TIME');
      check(!this.ready,'WINDOWS_READY_DUPLICATE');this.ready=f;
      check(BigInt(this.origin.policy.stdoutMaxBytes)>=17n,'WINDOWS_STDOUT_LIMIT');
      if(this.stopped){this.inputDecision.resolve();return;}
      this.fence();this.writeWork=this.writeInput();this.inputDecision.resolve();
    }
  }
  private async writeInput(){
    const stream=this.session!.nativeInput;const guard=()=>{};stream.on('error',guard);
    const bridge=new Writable({write:(chunk:Buffer,_encoding,done)=>{
      try{this.fence();stream.write(chunk,error=>done(error));}catch(error){done(error instanceof Error?error:new Error('WINDOWS_INPUT_UNCONFIRMED'));}
    }});
    bridge.on('error',guard);
    try{
      check(this.frame);this.reserve(12+this.origin.limits.maxMetadataBytes);
      try{
        await writeNativeFrame(bridge,this.frame,{maxMetadataBytes:this.origin.limits.maxMetadataBytes,maxBinaryBytes:this.origin.limits.maxInputBytes,maxItems:this.origin.limits.maxItems});
        bridge.end();
        await new Promise<void>((resolve,reject)=>{
          const error=(e:Error)=>reject(e);stream.once('error',error);
          stream.end(()=>{stream.off('error',error);resolve();});
        });
      }finally{this.release(12+this.origin.limits.maxMetadataBytes);}
    }catch(error){this.requestStop('INPUT_LIMIT',errorCode(error,'WINDOWS_INPUT_UNCONFIRMED'));}
    finally{stream.off('error',guard);}
  }
  private async readChunk(iterator:AsyncIterator<Uint8Array>,lane:'OUT'|'ERR'):Promise<{item:IteratorResult<Uint8Array>;held:number}>{
    const maximum=BigInt(lane==='OUT'?this.origin.policy.stdoutMaxBytes:this.origin.policy.stderrMaxBytes);
    const credit=Number(maximum<65536n?maximum:65536n);
    this.reserve(credit);
    try{
      const item=await this.track(()=>iterator.next());
      if(item.done){this.release(credit);return {item,held:0};}
      const view=binaryView(item.value);check(view.byteLength<=credit,'WINDOWS_CHUNK_LIMIT');
      const held=view.byteLength;this.release(credit-held);return {item:{value:view,done:false},held};
    }catch(error){this.release(credit);throw error;}
  }
  private startNative(){
    if(this.nativeWork)return;
    const output=this.session!.nativeOutput[Symbol.asyncIterator]();
    const error=this.session!.nativeError[Symbol.asyncIterator]();
    const reserve=(bytes:number)=>this.reserve(bytes);let chunkHeld=0,previousHeld=0,outputCopies=0;
    const releaseChunks=()=>{if(previousHeld)this.release(previousHeld);if(chunkHeld)this.release(chunkHeld);previousHeld=0;chunkHeld=0;};
    const source:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>({next:async()=>{
      if(previousHeld){this.release(previousHeld);previousHeld=0;}
      const received=await this.readChunk(output,'OUT'),next=received.item;
      previousHeld=chunkHeld;chunkHeld=received.held;
      if(!next.done){
        this.outputBytes+=next.value.byteLength;check(Number.isSafeInteger(this.outputBytes),'WINDOWS_STDOUT_LIMIT');
        const banners=(this.waitObserved?8:0)+(this.ready?9:0);
        check(BigInt(this.outputBytes+banners)<=BigInt(this.origin.policy.stdoutMaxBytes),'WINDOWS_STDOUT_LIMIT');
      }
      return next;
    }})};
    class BudgetReader extends NativeReader{
      private reads=0;
      override async exact(length:number):Promise<Buffer>{
        const bytes=length*(++this.reads===2?3:1);reserve(bytes);outputCopies+=bytes;return super.exact(length);
      }
    }
    const outputWork=(async()=>{
      try{
        const result=await readNativeFrame<NativeResult>(new BudgetReader(source,this.origin.limits.maxOutputBytes+this.origin.limits.maxMetadataBytes+12),{maxMetadataBytes:this.origin.limits.maxMetadataBytes,maxBinaryBytes:this.origin.limits.maxOutputBytes,maxItems:this.origin.limits.maxItems});
        releaseChunks();
        check(this.ready&&this.writeWork,'WINDOWS_RESULT_BEFORE_INPUT');
        await this.writeWork;
        check(this.frame);verifyNativeResult(this.frame.envelope,result.envelope);frozen(result.envelope);
        const validate=()=>{
          check(result.blobs.size===result.envelope.blobs.length);
          for(const d of result.envelope.blobs){const bytes=result.blobs.get(d.id);check(bytes&&bytes.length===d.byteLength&&sha256(bytes)===d.sha256,'WINDOWS_RAW_MISMATCH');}
        };
        validate();
        const raw=object(this.captureValue(await this.track(()=>this.ports.parent.rawResult(this.capture!,result))),['rawResultId','resultDigest']);
        id(raw.rawResultId);hash(raw.resultDigest);check(raw.resultDigest===digest(result.envelope),'WINDOWS_RAW_MISMATCH');validate();
        this.raw=frozen(raw as NativeRawResultReference);
      }catch(error){
        releaseChunks();this.requestStop('OUTPUT_LIMIT',errorCode(error,'WINDOWS_OUTPUT_UNCONFIRMED'));
        // 실패한 frame reader를 다시 만들지 않는다. drain도 원 read credit과 callback 합류를 지킨다.
        try{for(;;){const received=await this.readChunk(output,'OUT');if(received.held)this.release(received.held);if(received.item.done)break;}}
        catch{this.invalid=true;}
      }finally{releaseChunks();if(outputCopies){this.release(outputCopies);outputCopies=0;}}
    })();
    const errorWork=(async()=>{
      let bytes=0;
      try{
        for(;;){
          const received=await this.readChunk(error,'ERR'),next=received.item;if(next.done)break;
          try{
            bytes+=next.value.byteLength;check(Number.isSafeInteger(bytes),'WINDOWS_STDERR_LIMIT');
            if(BigInt(bytes)>BigInt(this.origin.policy.stderrMaxBytes))this.requestStop('OUTPUT_LIMIT','WINDOWS_STDERR_LIMIT');
          }finally{if(received.held)this.release(received.held);}
        }
      }catch(err){this.invalid=true;this.requestStop('OUTPUT_LIMIT',errorCode(err));}
    })();
    this.nativeWork=(async()=>{
      await Promise.all([outputWork,errorWork]);await this.inputDecision.promise;if(this.writeWork)await this.writeWork;
      this.nativeEnded=true;await this.joinParent();
    })().catch(error=>{this.invalid=true;this.requestStop('HOST_FAILED',errorCode(error));});
  }
  private joinParent():Promise<void>{
    if(this.parentWork)return this.parentWork;
    this.parentWork=(async()=>{
      const ack=parentAck(this.captureValue(await this.track(()=>this.ports.parent.joinOriginal(this.capture!))));
      check(ack.originDigest===this.originDigest,'WINDOWS_PARENT_MISMATCH');this.parent=frozen(ack);
      await this.send('PARENT_JOINED',ack);
    })();
    void this.parentWork.catch(error=>{this.invalid=true;this.requestStop('HOST_FAILED',errorCode(error));});
    return this.parentWork;
  }

  private async seal(value:WindowsJobEvidence){
    check(!this.invalid&&!this.record&&this.appendCount===0,'WINDOWS_SEAL_UNCONFIRMED');
    const checked=validateWindowsJobEvidence(value,bounds);
    same(checked.identity,this.origin.identity);same(checked.authority,this.origin.authority);same(checked.pins,this.origin.pins);same(checked.policy.requested,this.origin.policy);
    check(checked.lifecycle.events.length===this.events.length,'WINDOWS_EVENT_SET_MISMATCH');
    for(let n=0;n<this.events.length;n++)same(checked.lifecycle.events[n],this.events[n].event);
    this.candidate=checked;
    if(classifyWindowsJobEvidence(checked)==='UNCONFIRMED'){
      this.requestStop('HOST_FAILED',checked.final.failureCode??'WINDOWS_RECORD_UNCONFIRMED');return;
    }
    if(checked.lifecycle.creation==='CREATED'){
      check(this.nativeEnded&&this.parent,'WINDOWS_IO_UNCONFIRMED');
      if(this.preparedOs)same(checked.policy.osReadback,this.preparedOs);
      else if(checked.policy.osReadback!==null){
        const facts=this.events.flatMap(r=>r.source.facts),last:WindowsFact[]=[];
        for(const cls of ['EXTENDED_LIMITS','CPU_RATE']){
          const found=facts.filter((f):f is Extract<WindowsFact,{kind:'WIN32'}>=>f.kind==='WIN32'&&f.api==='QueryInformationJobObject'&&f.status==='RETURNED'&&(f.value as Row).informationClass===cls).at(-1);
          check(found,'WINDOWS_POLICY_UNCONFIRMED');last.push(found);
        }
        same(checked.policy.osReadback,osPolicy(last));
      }
      if(this.preparedBroker)same(checked.policy.brokerApplied,this.preparedBroker);
      else if(checked.policy.brokerApplied!==null){
        const p=this.origin.policy;same(checked.policy.brokerApplied,{wallTimeoutMs:p.wallTimeoutMs,joinTimeoutMs:p.joinTimeoutMs,stdoutMaxBytes:p.stdoutMaxBytes,stderrMaxBytes:p.stderrMaxBytes});
      }
      if(checked.final.failureCode===null)check(this.raw,'WINDOWS_RESULT_UNCONFIRMED');
    }else if(checked.lifecycle.creation==='NOT_ATTEMPTED'||checked.lifecycle.creation==='FAILED'){
      check(!this.nativeWork&&!this.raw,'WINDOWS_NO_CREATE_MISMATCH');this.inputDecision.resolve();await this.joinParent();
    }
    check(this.parent&&checked.final.parentIoJoined,'WINDOWS_PARENT_UNCONFIRMED');
    this.candidate=checked;
    const iterator=this.ports.journal.scanOriginal(this.capture!)[Symbol.asyncIterator]();let n=0,exhausted=false,rejected=false;
    try{
      for(;;){
        const next=await this.track(()=>iterator.next());if(next.done){exhausted=true;break;}
        check(n<this.events.length&&n<64,'WINDOWS_EVENT_SET_MISMATCH');
        this.inspectValue(next.value,v=>same(entry(v),this.events[n]));n++;
      }
    }catch(error){
      rejected=true;this.invalid=true;this.requestStop('JOURNAL_UNCONFIRMED',errorCode(error));throw error;
    }finally{
      if(!exhausted&&iterator.return){
        const close=iterator.return.bind(iterator);
        try{await this.track(()=>close());}
        catch(error){this.invalid=true;if(!rejected)throw error;}
      }
    }
    check(n===this.events.length&&this.appendCount===0,'WINDOWS_EVENT_SET_MISMATCH');
    // ref의 UUID/hex 폭은 이미 확인했다. 새 manifest를 만들기 전에 정확한 ASCII 길이를 확보한다.
    const itemBytes='{"eventId":"","payloadDigest":"","sourceDigest":""}'.length+36+64+64;
    const manifestBytes=2+itemBytes*this.events.length+Math.max(0,this.events.length-1);
    this.reserve(manifestBytes);
    try{
      const manifest=this.events.map(r=>({eventId:r.event.eventId,payloadDigest:r.event.payloadDigest,sourceDigest:r.sourceDigest}));
      const envelope=frozen({version:1 as const,originDigest:this.originDigest,evidence:checked,entries:manifest,parentJoinAck:this.parent});
      let encoding=0,expectedDigest='',ref:OriginalRef|null=null;
      data(envelope,controlMax,true,20,8192,bytes=>{this.reserve(bytes*3);encoding=bytes*3;},false);
      try{
        expectedDigest=digest(envelope);
        try{ref=originalRef(this.captureValue(await this.track(()=>this.ports.journal.sealOriginal(this.capture!,envelope))));}
        catch{/* commit ACK 유실은 같은 원 wrapper만 재조회한다. */}
      }finally{this.release(encoding);}
      if(!ref){
        const saved=await this.track(()=>this.ports.journal.readOriginal(this.capture!));check(saved,'WINDOWS_SEAL_UNCONFIRMED');
        this.inspectValue(saved,v=>{const s=object(v,['ref','envelope']);same(s.envelope,envelope);});ref=originalRef(this.captureValue(saved.ref));
      }
      check(ref.digest===expectedDigest,'WINDOWS_SEAL_MISMATCH');
      const stored=await this.track(()=>this.ports.journal.readOriginal(this.capture!));check(stored,'WINDOWS_SEAL_UNCONFIRMED');
      this.inspectValue(stored,v=>{const s=object(v,['ref','envelope']);same(s.ref,ref);same(s.envelope,envelope);});
      this.record=frozen(ref);await this.send('ACK_FINAL',ref);
    }finally{this.release(manifestBytes);}
  }
  private async tryComplete(){
    if(this.completing||this.phase==='JOINED'||!this.eventsEnded||!this.transportDone)return;
    this.completing=true;
    try{
      const f=this.finalMessage,j=this.hostJoin;
      if(this.invalid||!this.record||!this.candidate||!f||f.handles!=='CLOSED'||j?.end!=='EXPECTED'||!j.finalized||j.finalized.handles!=='CLOSED'){
        this.finishWait(this.localCode??'WINDOWS_FINAL_UNCONFIRMED');return;
      }
      same(f,j.finalized);same({recordId:f.recordId,digest:f.digest},this.record);
      check(classifyWindowsJobEvidence(this.candidate)!=='UNCONFIRMED','WINDOWS_RECORD_UNCONFIRMED');
      check(this.parent&&this.appendCount===0&&this.pending.size===0,'WINDOWS_PENDING_UNCONFIRMED');
      if(this.candidate.lifecycle.creation==='CREATED')check(this.nativeEnded,'WINDOWS_IO_UNCONFIRMED');
      if(this.go)same(this.candidate.lifecycle.goGrantRef,this.go);
      await this.authority(this.go!==null);
      check(this.pending.size===0,'WINDOWS_PENDING_UNCONFIRMED');
      this.phase='JOINED';
      this.outcome=frozen({state:'JOINED',code:this.localCode??this.candidate.final.failureCode??'WINDOWS_JOB_JOINED',evidence:this.candidate,rawResult:this.raw,journalRef:this.record});
      this.frame=null;this.events.length=0;this.kinds.clear();this.calls.clear();this.requests.clear();this.ready=null;
      this.preparedSignal.reject(new DomainError(this.outcome.code,409,'WAIT'));
      if(!this.terminalResolved){this.terminalResolved=true;this.terminal.resolve(this.outcome);}
    }catch(error){this.finishWait(errorCode(error));}
    finally{this.completing=false;}
  }
}
export function createWindowsJobBackend(input:WindowsPrepareInput,ports:WindowsJobPorts):WindowsJobBackend{
  try{return new Coordinator(input,ports);}
  catch(error){if(error instanceof DomainError&&error.nextAction==='WAIT')throw error;throw new DomainError('WINDOWS_BACKEND_INVALID',422,'WAIT');}
}
