import {types} from 'node:util';
import {DomainError} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import type {NativeControllerBinding} from './controller-protocol.js';

export type WindowsJobEvidenceBounds=Readonly<{maxRecordBytes:number;maxEvents:number;maxDepth:number;maxNodes:number}>;
export type WindowsJobPolicy=Readonly<{maxProcesses:number;jobCommitLimitBytes:string;processCommitLimitBytes:string;cpuRatePer10000:number;wallTimeoutMs:number;joinTimeoutMs:number;stdoutMaxBytes:string;stderrMaxBytes:string}>;
type EvidenceRef={evidenceId:string;evidenceDigest:string};
type GoRef={jobId:string;rowDigest:string};
type Root={pid:number;creationFileTime100ns:string};
export type WindowsJobAccounting=Readonly<{
  userTime100ns:string;kernelTime100ns:string;peakJobMemoryBytes:string;peakProcessMemoryBytes:string;
  readOperations:string;writeOperations:string;otherOperations:string;readBytes:string;writeBytes:string;otherBytes:string;
  totalProcesses:string;startQpcTicks:string;endQpcTicks:string;qpcFrequency:string;
  snapshotScope:'FRESH_JOB_LIFETIME';memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS';
}>;
type Payloads={
  PRE_CREATE:{bindingDigest:string;policyDigest:string;pinsDigest:string};
  CREATE_NOT_ATTEMPTED:{code:string};CREATE_ARMED:{callId:string};
  CREATE_FAILED:{win32Error:number;creationConfirmedAbsent:true};
  CREATED_SUSPENDED:Root&{assignedBy:'PROC_THREAD_ATTRIBUTE_JOB_LIST'};
  PREPARED:{membershipConfirmed:true;tokenDigest:string;osReadbackDigest:string;brokerAppliedDigest:string};
  BOOTSTRAP_RESUMED:{resumeReturned:true};GO_AUTHORIZED:{goGrantRef:GoRef};
  GO_WRITE_ARMED:{bytesLength:string};GO_WRITE:{result:'RETURNED'|'UNCONFIRMED';bytesLength:string};
  ROOT_EXIT:{exitCode:number};TREE_EMPTY:{activeProcesses:0;totalProcesses:string};
  IO_JOINED:{stdinClosed:true;stdoutEof:true;stderrEof:true;parentIoJoined:true};
  FINAL_ACCOUNTING:{accounting:WindowsJobAccounting};
  FAILED:{code:string;phase:'CREATE'|'PREPARE'|'GO'|'DRAIN'};
};
type Kind=keyof Payloads;
type Event={[K in Kind]:{eventId:string;sequence:number;kind:K;qpcTicks:string;previousDigest:string|null;payload:Payloads[K];payloadDigest:string}}[Kind];
type DeepReadonly<T>=T extends object?{readonly [K in keyof T]:DeepReadonly<T[K]>}:T;
// 순수 record의 완전성만 검사한다. OS·DB·서명·해제 권한을 인증하지 않는다.
export type WindowsJobEvidence=DeepReadonly<{
  version:1;kind:'WINDOWS_JOB_OBJECT';
  identity:{binding:NativeControllerBinding;intentDigest:string;sourceInput:{executionId:string;inputEvidenceId:string;stageInputDigest:string};inputEvidenceDigest:string;inputFingerprint:string;basisRef:EvidenceRef|null};
  authority:{attemptId:string;controllerInstanceId:string;controllerId:string;keyVersion:string;environmentDigest:string;hostEpochId:string;sessionId:string;launchId:string;policyDigest:string;controllerSidDigest:string;childSidDigest:string;appContainerSidDigest:string};
  pins:{executableDigest:string;bootstrapDigest:string;helperRuntimeDigest:string;helperScriptDigest:string;runtimeFilesDigest:string;nativeLimitsDigest:string};
  policy:{requested:WindowsJobPolicy;osReadback:{maxProcesses:number;jobCommitLimitBytes:string;processCommitLimitBytes:string;cpuRatePer10000:number;killOnJobClose:true;breakawayAllowed:false}|null;brokerApplied:{wallTimeoutMs:number;joinTimeoutMs:number;stdoutMaxBytes:string;stderrMaxBytes:string}|null};
  lifecycle:{creation:'NOT_ATTEMPTED'|'FAILED'|'CREATED'|'UNCONFIRMED';root:Root|null;goGrantRef:GoRef|null;goWrite:'NOT_ATTEMPTED'|'RETURNED'|'UNCONFIRMED';rootExit:{exitCode:number;observedQpcTicks:string}|null;events:Event[]};
  final:{outcome:'NO_CHILD_CREATED'|'JOB_EMPTY'|'UNCONFIRMED';activeProcesses:number|null;rootSignaled:boolean;stdioJoined:boolean;parentIoJoined:boolean;recordSealed:boolean;accounting:WindowsJobAccounting|null;failureCode:string|null};
}>;
type Row=Record<string,unknown>;
type RawEvent={eventId:string;sequence:number;kind:Kind;qpcTicks:string;previousDigest:string|null;payload:Row;payloadDigest:string};
const hardBounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096} as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const token=/^[A-Za-z0-9._-]{1,128}$/;
const errorCode=/^[A-Z][A-Z0-9_]{0,127}$/;
const u64=18446744073709551615n;
function fail(limit=false):never{throw new DomainError(limit?'WINDOWS_JOB_EVIDENCE_LIMIT':'WINDOWS_JOB_EVIDENCE_INVALID',limit?413:422,'WAIT');}
function check(condition:unknown):asserts condition{if(!condition)fail();}
function object(value:unknown,keys:readonly string[]):Row{
  check(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value));
  check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const actual=Reflect.ownKeys(value);check(actual.length===keys.length&&actual.every(key=>typeof key==='string'&&keys.includes(key)));
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);check(d&&d.enumerable&&'value'in d);}
  return value as Row;
}
function id(value:unknown){check(typeof value==='string'&&uuid.test(value));}
function hash(value:unknown){check(typeof value==='string'&&hex.test(value));}
function code(value:unknown){check(typeof value==='string'&&errorCode.test(value));}
function integer(value:unknown,min=0,max=0xffffffff){check(typeof value==='number'&&Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=min&&value<=max);}
function decimal(value:unknown,positive=false,max=u64):bigint{
  check(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value));const n=BigInt(value);check(n<=max&&(!positive||n>0n));return n;
}
function same(a:unknown,b:unknown){check(digest(a)===digest(b));}
function ref(value:unknown,go=false){
  const r=object(value,go?['jobId','rowDigest']:['evidenceId','evidenceDigest']);id(r[go?'jobId':'evidenceId']);hash(r[go?'rowDigest':'evidenceDigest']);return r;
}
function freeze(value:unknown):void{
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
}
function copyBounded(input:unknown,bounds:WindowsJobEvidenceBounds):unknown{
  let nodes=0,bytes=0;const ancestors=new Set<object>();
  const add=(n:number)=>{bytes+=n;if(bytes>bounds.maxRecordBytes)fail(true);};
  const quoted=(text:string)=>{
    add(2);if(text.length>bounds.maxRecordBytes)fail(true);
    for(const char of text){const n=char.codePointAt(0)!;check(n<0xd800||n>0xdfff);add(n<32?6:char==='"'||char==='\\'?2:Buffer.byteLength(char,'utf8'));}
  };
  const visit=(value:unknown,depth:number):unknown=>{
    if(++nodes>bounds.maxNodes||depth>bounds.maxDepth)fail(true);
    check(!types.isProxy(value));
    if(value===null){add(4);return null;}
    if(typeof value==='string'){quoted(value);return value;}
    if(typeof value==='boolean'){add(value?4:5);return value;}
    if(typeof value==='number'){check(Number.isSafeInteger(value)&&!Object.is(value,-0));add(String(value).length);return value;}
    check(typeof value==='object'&&value!==null&&!ancestors.has(value));ancestors.add(value);
    try{
      if(Array.isArray(value)){
        check(Object.getPrototypeOf(value)===Array.prototype);
        if(value.length>bounds.maxNodes-nodes)fail(true);
        check(Reflect.ownKeys(value).length===value.length+1);add(2+Math.max(0,value.length-1));const output:unknown[]=[];
        for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));check(d&&d.enumerable&&'value'in d);output.push(visit(d.value,depth+1));}return output;
      }
      check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
      const keys=Reflect.ownKeys(value);if(keys.length>bounds.maxNodes-nodes)fail(true);
      check(keys.every(key=>typeof key==='string'));add(2+Math.max(0,keys.length-1));const output:Row=Object.create(null);
      for(const key of keys as string[]){const d=Object.getOwnPropertyDescriptor(value,key);check(d&&d.enumerable&&'value'in d);quoted(key);add(1);output[key]=visit(d.value,depth+1);}return output;
    }finally{ancestors.delete(value);}
  };
  const result=visit(input,0);
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>bounds.maxRecordBytes)fail(true);
  return result;
}
const accountingKeys=['userTime100ns','kernelTime100ns','peakJobMemoryBytes','peakProcessMemoryBytes','readOperations','writeOperations','otherOperations','readBytes','writeBytes','otherBytes','totalProcesses','startQpcTicks','endQpcTicks','qpcFrequency','snapshotScope','memoryAccounting'] as const;
function accounting(value:unknown):Row{
  const a=object(value,accountingKeys);for(const key of accountingKeys.slice(0,14))decimal(a[key]);
  decimal(a.totalProcesses,true,0xffffffffn);decimal(a.qpcFrequency,true);check(BigInt(a.endQpcTicks as string)>=BigInt(a.startQpcTicks as string));
  check(a.snapshotScope==='FRESH_JOB_LIFETIME'&&a.memoryAccounting==='WIN32_JOB_MEMORY_NOT_RSS');return a;
}
function osLimits(r:Row):void{
  integer(r.maxProcesses,1);decimal(r.jobCommitLimitBytes,true);
  check(decimal(r.processCommitLimitBytes,true)<=decimal(r.jobCommitLimitBytes,true));integer(r.cpuRatePer10000,1,10000);
}
function brokerLimits(r:Row):void{
  integer(r.wallTimeoutMs,1,2147483647);integer(r.joinTimeoutMs,1,2147483647);
  decimal(r.stdoutMaxBytes,true);decimal(r.stderrMaxBytes,true);
}
function policy(value:unknown):Row{
  const p=object(value,['requested','osReadback','brokerApplied']);
  const r=object(p.requested,['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes']);
  osLimits(r);brokerLimits(r);
  if(p.osReadback!==null){
    const o=object(p.osReadback,['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000','killOnJobClose','breakawayAllowed']);
    osLimits(o);check(o.killOnJobClose===true&&o.breakawayAllowed===false);
  }
  if(p.brokerApplied!==null)brokerLimits(object(p.brokerApplied,['wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes']));
  return p;
}

const payloadKeys:Record<Kind,readonly string[]>={
  PRE_CREATE:['bindingDigest','policyDigest','pinsDigest'],CREATE_NOT_ATTEMPTED:['code'],CREATE_ARMED:['callId'],CREATE_FAILED:['win32Error','creationConfirmedAbsent'],
  CREATED_SUSPENDED:['pid','creationFileTime100ns','assignedBy'],PREPARED:['membershipConfirmed','tokenDigest','osReadbackDigest','brokerAppliedDigest'],
  BOOTSTRAP_RESUMED:['resumeReturned'],GO_AUTHORIZED:['goGrantRef'],GO_WRITE_ARMED:['bytesLength'],GO_WRITE:['result','bytesLength'],
  ROOT_EXIT:['exitCode'],TREE_EMPTY:['activeProcesses','totalProcesses'],IO_JOINED:['stdinClosed','stdoutEof','stderrEof','parentIoJoined'],
  FINAL_ACCOUNTING:['accounting'],FAILED:['code','phase']
};
function payload(kind:Kind,value:unknown):Row{
  const p=object(value,payloadKeys[kind]);
  switch(kind){
    case 'PRE_CREATE':for(const v of Object.values(p))hash(v);break;
    case 'CREATE_NOT_ATTEMPTED':code(p.code);break;
    case 'CREATE_ARMED':id(p.callId);break;
    case 'CREATE_FAILED':integer(p.win32Error,1);check(p.creationConfirmedAbsent===true);break;
    case 'CREATED_SUSPENDED':integer(p.pid,1);decimal(p.creationFileTime100ns);check(p.assignedBy==='PROC_THREAD_ATTRIBUTE_JOB_LIST');break;
    case 'PREPARED':check(p.membershipConfirmed===true);hash(p.tokenDigest);hash(p.osReadbackDigest);hash(p.brokerAppliedDigest);break;
    case 'BOOTSTRAP_RESUMED':check(p.resumeReturned===true);break;
    case 'GO_AUTHORIZED':ref(p.goGrantRef,true);break;
    case 'GO_WRITE_ARMED':decimal(p.bytesLength,true);break;
    case 'GO_WRITE':decimal(p.bytesLength,true);check(p.result==='RETURNED'||p.result==='UNCONFIRMED');break;
    case 'ROOT_EXIT':integer(p.exitCode);break;
    case 'TREE_EMPTY':check(p.activeProcesses===0);decimal(p.totalProcesses,true,0xffffffffn);break;
    case 'IO_JOINED':check(Object.values(p).every(v=>v===true));break;
    case 'FINAL_ACCOUNTING':accounting(p.accounting);break;
    case 'FAILED':code(p.code);check(['CREATE','PREPARE','GO','DRAIN'].includes(p.phase as string));break;
  }
  return p;
}
function events(value:unknown,bounds:WindowsJobEvidenceBounds):Map<Kind,RawEvent>{
  check(Array.isArray(value));if(value.length>bounds.maxEvents)fail(true);check(value.length>0);
  const seen=new Map<Kind,RawEvent>(),ids=new Set<string>();let previous:string|null=null,qpc=0n,lastRank=-1,failed=false;
  const ranks:Record<Kind,number>={PRE_CREATE:0,CREATE_ARMED:1,CREATE_NOT_ATTEMPTED:2,CREATE_FAILED:2,CREATED_SUSPENDED:2,PREPARED:3,BOOTSTRAP_RESUMED:4,GO_AUTHORIZED:5,GO_WRITE_ARMED:6,GO_WRITE:7,ROOT_EXIT:8,TREE_EMPTY:9,IO_JOINED:10,FINAL_ACCOUNTING:11,FAILED:12};
  const requires:Partial<Record<Kind,Kind>>={CREATE_ARMED:'PRE_CREATE',CREATE_NOT_ATTEMPTED:'PRE_CREATE',CREATE_FAILED:'CREATE_ARMED',CREATED_SUSPENDED:'CREATE_ARMED',PREPARED:'CREATED_SUSPENDED',BOOTSTRAP_RESUMED:'PREPARED',GO_AUTHORIZED:'BOOTSTRAP_RESUMED',GO_WRITE_ARMED:'GO_AUTHORIZED',GO_WRITE:'GO_WRITE_ARMED',ROOT_EXIT:'CREATED_SUSPENDED',TREE_EMPTY:'ROOT_EXIT',IO_JOINED:'TREE_EMPTY',FINAL_ACCOUNTING:'IO_JOINED',FAILED:'PRE_CREATE'};
  for(let i=0;i<value.length;i++){
    const e=object(value[i],['eventId','sequence','kind','qpcTicks','previousDigest','payload','payloadDigest']);
    id(e.eventId);hash(e.payloadDigest);check(typeof e.kind==='string'&&Object.hasOwn(payloadKeys,e.kind));
    const kind=e.kind as Kind;integer(e.sequence,1,hardBounds.maxEvents);const time=decimal(e.qpcTicks);
    check(e.sequence===i+1&&!ids.has(e.eventId as string)&&!seen.has(kind)&&e.previousDigest===previous&&time>=qpc);
    if(i===0)check(kind==='PRE_CREATE');if(i>0)check(kind!=='PRE_CREATE');
    if(requires[kind])check(seen.has(requires[kind]!));
    if(kind==='FAILED')failed=true;else{check(ranks[kind]>lastRank&&(!failed||ranks[kind]>=8));lastRank=ranks[kind];}
    payload(kind,e.payload);const {payloadDigest:_claimed,...body}=e;check(digest(body)===e.payloadDigest);
    seen.set(kind,e as unknown as RawEvent);ids.add(e.eventId as string);previous=e.payloadDigest as string;qpc=time;
  }
  return seen;
}
export function validateWindowsJobEvidence(value:unknown,bounds:WindowsJobEvidenceBounds):WindowsJobEvidence{
  const b=object(bounds,['maxRecordBytes','maxEvents','maxDepth','maxNodes']);
  for(const key of Object.keys(hardBounds) as (keyof WindowsJobEvidenceBounds)[])integer(b[key],1,hardBounds[key]);
  const data=copyBounded(value,bounds);
  const top=object(data,['version','kind','identity','authority','pins','policy','lifecycle','final']);check(top.version===1&&top.kind==='WINDOWS_JOB_OBJECT');
  const identity=object(top.identity,['binding','intentDigest','sourceInput','inputEvidenceDigest','inputFingerprint','basisRef']);
  const binding=object(identity.binding,['accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest']);
  for(const key of ['accountId','capacityReservationId','jobId','parentInstanceId'])id(binding[key]);
  for(const key of ['inputDigest','profileDigest','kernelDigest'])hash(binding[key]);
  for(const key of ['intentDigest','inputEvidenceDigest','inputFingerprint'])hash(identity[key]);
  const source=object(identity.sourceInput,['executionId','inputEvidenceId','stageInputDigest']);id(source.executionId);id(source.inputEvidenceId);hash(source.stageInputDigest);
  if(identity.basisRef!==null)ref(identity.basisRef);
  const a=object(top.authority,['attemptId','controllerInstanceId','controllerId','keyVersion','environmentDigest','hostEpochId','sessionId','launchId','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest']);
  for(const key of ['attemptId','controllerInstanceId','hostEpochId','sessionId','launchId'])id(a[key]);
  for(const key of ['controllerId','keyVersion'])check(typeof a[key]==='string'&&token.test(a[key] as string));
  for(const key of ['environmentDigest','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest'])hash(a[key]);
  const pins=object(top.pins,['executableDigest','bootstrapDigest','helperRuntimeDigest','helperScriptDigest','runtimeFilesDigest','nativeLimitsDigest']);for(const v of Object.values(pins))hash(v);
  const p=policy(top.policy);check(a.policyDigest===digest(p.requested));
  const l=object(top.lifecycle,['creation','root','goGrantRef','goWrite','rootExit','events']);
  check(['NOT_ATTEMPTED','FAILED','CREATED','UNCONFIRMED'].includes(l.creation as string));check(['NOT_ATTEMPTED','RETURNED','UNCONFIRMED'].includes(l.goWrite as string));
  const f=object(top.final,['outcome','activeProcesses','rootSignaled','stdioJoined','parentIoJoined','recordSealed','accounting','failureCode']);
  check(['NO_CHILD_CREATED','JOB_EMPTY','UNCONFIRMED'].includes(f.outcome as string));if(f.activeProcesses!==null)integer(f.activeProcesses);
  for(const key of ['rootSignaled','stdioJoined','parentIoJoined','recordSealed'])check(typeof f[key]==='boolean');
  if(f.failureCode!==null)code(f.failureCode);
  const all=events(l.events,bounds),has=(kind:Kind)=>all.has(kind),get=(kind:Kind)=>all.get(kind)!;
  const first=get('PRE_CREATE').payload;check(first.bindingDigest===digest(identity)&&first.policyDigest===a.policyDigest&&first.pinsDigest===digest(pins));
  check(!(has('CREATE_NOT_ATTEMPTED')&&has('CREATE_ARMED')));
  check(!(has('CREATE_FAILED')&&has('CREATED_SUSPENDED')));
  const creation=has('CREATED_SUSPENDED')?'CREATED':has('CREATE_FAILED')?'FAILED':has('CREATE_NOT_ATTEMPTED')?'NOT_ATTEMPTED':'UNCONFIRMED';check(l.creation===creation);
  if(creation==='CREATED'){
    const root=object(l.root,['pid','creationFileTime100ns']);integer(root.pid,1);decimal(root.creationFileTime100ns);
    const original=get('CREATED_SUSPENDED').payload;check(root.pid===original.pid&&root.creationFileTime100ns===original.creationFileTime100ns);
  }else check(l.root===null);
  if(has('PREPARED')){
    check(p.osReadback!==null&&p.brokerApplied!==null);const prepared=get('PREPARED').payload;
    check(prepared.osReadbackDigest===digest(p.osReadback)&&prepared.brokerAppliedDigest===digest(p.brokerApplied));
    const requested=p.requested as Row;
    for(const key of ['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000'])check((p.osReadback as Row)[key]===requested[key]);
    for(const key of ['wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes'])check((p.brokerApplied as Row)[key]===requested[key]);
  }
  if(has('GO_AUTHORIZED')){
    const go=ref(l.goGrantRef,true);check(go.jobId===binding.jobId);same(go,get('GO_AUTHORIZED').payload.goGrantRef);
  }else check(l.goGrantRef===null);
  const goWrite=has('GO_WRITE')?get('GO_WRITE').payload.result:has('GO_WRITE_ARMED')?'UNCONFIRMED':'NOT_ATTEMPTED';check(l.goWrite===goWrite);
  if(has('GO_WRITE'))check(get('GO_WRITE').payload.bytesLength===get('GO_WRITE_ARMED').payload.bytesLength);
  if(has('ROOT_EXIT')){
    const exit=object(l.rootExit,['exitCode','observedQpcTicks']);integer(exit.exitCode);decimal(exit.observedQpcTicks);
    check(exit.exitCode===get('ROOT_EXIT').payload.exitCode&&exit.observedQpcTicks===get('ROOT_EXIT').qpcTicks);
  }else check(l.rootExit===null);
  check(f.rootSignaled===has('ROOT_EXIT')&&f.stdioJoined===has('IO_JOINED'));
  if(creation==='CREATED')check(f.parentIoJoined===has('IO_JOINED'));
  if(has('TREE_EMPTY'))check(f.activeProcesses===0);else if(f.activeProcesses!==null)check(creation==='CREATED'&&(f.activeProcesses as number)>0);
  if(has('FINAL_ACCOUNTING')){
    const count=accounting(f.accounting);same(count,get('FINAL_ACCOUNTING').payload.accounting);
    check(count.startQpcTicks===get('CREATED_SUSPENDED').qpcTicks&&count.endQpcTicks===get('FINAL_ACCOUNTING').qpcTicks&&count.totalProcesses===get('TREE_EMPTY').payload.totalProcesses);
  }else check(f.accounting===null);
  if(has('FAILED'))check(f.failureCode===get('FAILED').payload.code);
  if(f.outcome==='JOB_EMPTY'){
    check(creation==='CREATED'&&has('ROOT_EXIT')&&has('TREE_EMPTY')&&has('IO_JOINED')&&has('FINAL_ACCOUNTING')&&f.recordSealed===true);
    if(!has('GO_WRITE')||goWrite!=='RETURNED'||f.failureCode!==null)check(has('FAILED')&&f.failureCode!==null);
  }else if(f.outcome==='NO_CHILD_CREATED'){
    if(creation==='NOT_ATTEMPTED')check(f.failureCode===get('CREATE_NOT_ATTEMPTED').payload.code);
    check((creation==='NOT_ATTEMPTED'||creation==='FAILED')&&f.activeProcesses===null&&f.accounting===null&&f.rootSignaled===false&&f.stdioJoined===false&&f.parentIoJoined===true&&f.recordSealed===true&&f.failureCode!==null);
  }else check(f.failureCode!==null);
  freeze(data);return data as WindowsJobEvidence;
}
export function classifyWindowsJobEvidence(value:WindowsJobEvidence):'COMPLETE_TREE_RECORD'|'NO_CREATE_RECORD'|'UNCONFIRMED'{
  // 타입 assertion만으로 parser를 우회하지 못하게 동일 계약을 다시 검사한다.
  const checked=validateWindowsJobEvidence(value,hardBounds);
  return checked.final.outcome==='JOB_EMPTY'?'COMPLETE_TREE_RECORD':checked.final.outcome==='NO_CHILD_CREATED'?'NO_CREATE_RECORD':'UNCONFIRMED';
}
