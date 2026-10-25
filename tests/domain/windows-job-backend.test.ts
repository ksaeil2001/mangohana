import {beforeAll,afterEach,describe,it,expect,vi} from 'vitest';
import {Writable} from 'node:stream';
import * as childProcess from 'node:child_process';
import * as net from 'node:net';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {writeNativeFrame} from '../../packages/native/src/frame.js';
import {validateWindowsJobEvidence} from '../../packages/native/src/windows-job-evidence.js';
import type {
  WindowsPrepareInput,WindowsJobPorts,WindowsControl,WindowsHostMessage,WindowsSource,JournalEntry,
  OriginalCapture,OriginalRef,ParentJoinAck,WindowsSealEnvelope,HostFinalized,
} from '../../packages/native/src/windows-job-backend.js';

type Api=typeof import('../../packages/native/src/windows-job-backend.js');
let api:Api;
beforeAll(async()=>{
  // 미구현 단계도 실행 가능한 assertion RED로 보존한다.
  const path='../../packages/native/src/windows-job-backend.js';
  try{api=await import(/* @vite-ignore */path) as Api;}catch{/* 아래 행동 검사에서 미구현을 보고한다. */}
});
vi.mock('node:child_process',()=>{
  const fail=()=>{throw new Error('REAL_PROCESS_FORBIDDEN');};
  return {spawn:vi.fn(fail),exec:vi.fn(fail),execFile:vi.fn(fail),fork:vi.fn(fail)};
});
vi.mock('node:net',()=>({connect:vi.fn(()=>{throw new Error('REAL_NETWORK_FORBIDDEN');})}));
afterEach(()=>vi.clearAllMocks());
const id=(n:number)=>('00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0')) as `${string}-${string}-${string}-${string}-${string}`;
const h=(s:string)=>digest(s);
const bounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};
}
class Queue<T> implements AsyncIterable<T>{
  private values:T[]=[];private readers:((item:IteratorResult<T>)=>void)[]=[];private ended=false;
  push(value:T){const next=this.readers.shift();if(next)next({value,done:false});else this.values.push(value);}
  end(){this.ended=true;for(const next of this.readers.splice(0))next({value:undefined,done:true});}
  [Symbol.asyncIterator](){return {next:async():Promise<IteratorResult<T>>=>{
    if(this.values.length)return {value:this.values.shift()!,done:false};
    if(this.ended)return {value:undefined,done:true};
    return new Promise(resolve=>this.readers.push(resolve));
  }};}
}
async function flush(){for(let n=0;n<100;n++)await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));}
async function until(predicate:()=>boolean){for(let n=0;n<30&&!predicate();n++)await flush();expect(predicate(),'가짜 포트의 지정 경계에 도달해야 한다').toBe(true);}
function input():WindowsPrepareInput{
  const limits={maxMetadataBytes:4096,maxInputBytes:16384,maxOutputBytes:16384,maxItems:8,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:131072};
  const blobs=new Map([['source',Buffer.from('synthetic image bytes')]]);
  const job=createNativeJob('DECODE_IMAGE',h('profile'),{title:'한국어 합성 입력'},blobs,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8},id(3));
  const identity={binding:{accountId:id(1),capacityReservationId:id(2),jobId:id(3),parentInstanceId:id(4),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:h('kernel')},intentDigest:h('intent'),sourceInput:{executionId:id(5),inputEvidenceId:id(6),stageInputDigest:h('stage input')},inputEvidenceDigest:h('input record'),inputFingerprint:h('canonical stage input'),basisRef:{evidenceId:id(7),evidenceDigest:h('basis')}};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const authority={attemptId:id(8),controllerInstanceId:id(9),controllerId:'windows-controller',keyVersion:'key-v1',environmentDigest:h('environment'),hostEpochId:id(10),sessionId:id(11),launchId:id(12),policyDigest:digest(policy),controllerSidDigest:h('controller sid'),childSidDigest:h('child sid'),appContainerSidDigest:h('container sid')};
  const pins={executableDigest:h('node'),bootstrapDigest:h('bootstrap'),helperRuntimeDigest:h('python'),helperScriptDigest:h('helper'),runtimeFilesDigest:h('runtime'),nativeLimitsDigest:digest(limits)};
  return {identity,authority,pins,policy,limits,frame:{envelope:job,blobs}};
}
type Event=JournalEntry['event'];
type Fact=WindowsSource['facts'][number];
function fixture(i:WindowsPrepareInput){
  const originDigest=digest({identity:i.identity,authority:i.authority,pins:i.pins,policy:i.policy,nativeLimitsDigest:digest(i.limits),frameInputDigest:i.frame.envelope.inputDigest});
  const osReadback={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,killOnJobClose:true as const,breakawayAllowed:false as const};
  const brokerApplied={wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const root={pid:42,creationFileTime100ns:'133000000000000000'};
  const goGrantRef={jobId:i.identity.binding.jobId,rowDigest:h('original GO')};
  const ack:ParentJoinAck={joinId:id(22),originDigest,digest:h('joined original parent work')};
  const tokenValues=[
    {informationClass:'TOKEN_USER',values:{sidDigest:i.authority.childSidDigest}},
    {informationClass:'TOKEN_APPCONTAINER_SID',values:{sidDigest:i.authority.appContainerSidDigest}},
    {informationClass:'TOKEN_IS_APPCONTAINER',values:{isAppContainer:true}},
    {informationClass:'TOKEN_INTEGRITY_LEVEL',values:{sidDigest:h('low integrity')}},
    {informationClass:'TOKEN_SESSION_ID',values:{sessionId:7}},
  ];
  const basic={TotalUserTime:'9007199254740993',TotalKernelTime:'300',ThisPeriodTotalUserTime:'9007199254740993',ThisPeriodTotalKernelTime:'300',TotalPageFaultCount:1,TotalProcesses:2,ActiveProcesses:0,TotalTerminatedProcesses:2};
  const io={ReadOperationCount:'2',WriteOperationCount:'3',OtherOperationCount:'0',ReadTransferCount:'500',WriteTransferCount:'600',OtherTransferCount:'0'};
  const extended={BasicLimitInformation:{PerProcessUserTimeLimit:'0',PerJobUserTimeLimit:'0',LimitFlags:0x2308,MinimumWorkingSetSize:'0',MaximumWorkingSetSize:'0',ActiveProcessLimit:4,Affinity:'0',PriorityClass:0,SchedulingClass:0},IoInfo:io,ProcessMemoryLimit:'524288',JobMemoryLimit:'1048576',PeakProcessMemoryUsed:'8192',PeakJobMemoryUsed:'16384'};
  const cpu={ControlFlags:5,CpuRate:2000};
  const accounting={userTime100ns:'9007199254740993',kernelTime100ns:'300',peakJobMemoryBytes:'16384',peakProcessMemoryBytes:'8192',readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0',totalProcesses:'2',startQpcTicks:'120',endQpcTicks:'210',qpcFrequency:'10000000',snapshotScope:'FRESH_JOB_LIFETIME' as const,memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS' as const};
  const entries:JournalEntry[]=[];
  let call=1000;
  const win=(api:string,value:unknown,qpcTicks:string,status='RETURNED',callId=id(++call))=>({kind:'WIN32',callId,api,qpcTicks,status,win32Error:status==='RETURNED'?null:5,value} as Fact);
  const ioFact=(lane:string,operation:string,qpcTicks:string,bytes:Buffer)=>({kind:'IO',callId:id(++call),lane,operation,qpcTicks,status:'RETURNED',bytesLength:String(bytes.length),sha256:sha256(bytes)} as Fact);
  const wait=ioFact('OUT','READ','140',Buffer.from('WAIT_V1\n'));
  const ready=ioFact('OUT','READ','175',Buffer.from('READY_V1\n'));
  const add=(kind:string,payload:unknown,facts:Fact[])=>{
    const body={eventId:id(100+entries.length),sequence:entries.length+1,kind,qpcTicks:String(100+entries.length*10),previousDigest:entries.at(-1)?.event.payloadDigest??null,payload};
    const event={...body,payloadDigest:digest(body)} as Event;
    const source={version:1 as const,originDigest,eventId:event.eventId,facts};
    entries.push({event,source,sourceDigest:digest(source)});
  };
  add('PRE_CREATE',{bindingDigest:digest(i.identity),policyDigest:i.authority.policyDigest,pinsDigest:digest(i.pins)},[]);
  add('CREATE_ARMED',{callId:id(20)},[]);
  add('CREATED_SUSPENDED',{...root,assignedBy:'PROC_THREAD_ATTRIBUTE_JOB_LIST'},[
    win('CreateProcessAsUserW',{processRef:id(30),threadRef:id(31),pid:42},'120','RETURNED',id(20)),
    win('GetProcessTimes',{processRef:id(30),creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'120'),
  ]);
  add('PREPARED',{membershipConfirmed:true,tokenDigest:digest(tokenValues),osReadbackDigest:digest(osReadback),brokerAppliedDigest:digest(brokerApplied)},[
    win('IsProcessInJob',{isMember:true},'125'),
    ...tokenValues.map(v=>win('GetTokenInformation',v,'126')),
    win('GetProcessTimes',{processRef:id(30),creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'127'),
    win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'128'),
    win('QueryInformationJobObject',{informationClass:'CPU_RATE',values:cpu},'129'),
  ]);
  add('BOOTSTRAP_RESUMED',{resumeReturned:true},[win('ResumeThread',{previousSuspendCount:1},'135'),wait]);
  add('GO_AUTHORIZED',{goGrantRef},[{kind:'ORIGINAL_GO',qpcTicks:'150',goGrantRef}]);
  add('GO_WRITE_ARMED',{bytesLength:'6'},[]);
  add('GO_WRITE',{result:'RETURNED',bytesLength:'6'},[ioFact('IN','WRITE','170',Buffer.from('GO_V1\n'))]);
  add('ROOT_EXIT',{exitCode:0},[win('WaitForSingleObject',{waitResult:'SIGNALED'},'180'),win('GetExitCodeProcess',{exitCode:0},'180')]);
  add('TREE_EMPTY',{activeProcesses:0,totalProcesses:'2'},[win('QueryInformationJobObject',{informationClass:'BASIC_ACCOUNTING',values:basic},'190')]);
  add('IO_JOINED',{stdinClosed:true,stdoutEof:true,stderrEof:true,parentIoJoined:true},[
    ioFact('IN','CLOSE','198',Buffer.alloc(0)),ioFact('OUT','READ','198',Buffer.alloc(0)),ioFact('ERR','READ','198',Buffer.alloc(0)),
    ready,{kind:'PARENT_ACK',qpcTicks:'200',ack},
  ]);
  add('FINAL_ACCOUNTING',{accounting},[
    win('QueryInformationJobObject',{informationClass:'BASIC_AND_IO',values:{BasicInfo:basic,IoInfo:io}},'209'),
    win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'209'),
    win('QueryPerformanceFrequency',{frequency:'10000000'},'209'),
    win('QueryPerformanceCounter',{ticks:'210'},'210'),
  ]);
  const evidence=()=>({version:1 as const,kind:'WINDOWS_JOB_OBJECT' as const,identity:i.identity,authority:i.authority,pins:i.pins,policy:{requested:i.policy,osReadback,brokerApplied},lifecycle:{creation:'CREATED' as const,root,goGrantRef,goWrite:'RETURNED' as const,rootExit:{exitCode:0,observedQpcTicks:'180'},events:entries.map(e=>e.event)},final:{outcome:'JOB_EMPTY' as const,activeProcesses:0,rootSignaled:true,stdioJoined:true,parentIoJoined:true,recordSealed:true,accounting,failureCode:null}});
  return {originDigest,entries,evidence,goGrantRef,ack,ready,win,ioFact};
}
class Harness{
  readonly i=input();readonly f=fixture(this.i);
  readonly messages=new Queue<WindowsHostMessage>();readonly output=new Queue<Uint8Array>();readonly error=new Queue<Uint8Array>();
  readonly joined=deferred<{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}>();
  readonly controls:WindowsControl[]=[];readonly written:Buffer[]=[];readonly rows:JournalEntry[]=[];
  readonly appendGates=new Map<string,ReturnType<typeof deferred<void>>>();
  readonly rawGate=deferred<void>();readonly sealGate=deferred<void>();readonly parentGate=deferred<void>();
  readonly sentAppend:string[]=[];readonly scanned:string[]=[];
  captureCount=0;openCount=0;grantCount=0;rawCount=0;parentCount=0;sealCount=0;readCount=0;
  fresh=true;confirmed=true;goKnown=false;rawBlocked=false;sealBlocked=false;parentBlocked=false;
  appendLost:string|null=null;extraRow:JournalEntry|null=null;closeConfirmed=true;finalizeLost=false;
  stored: {ref:OriginalRef;envelope:WindowsSealEnvelope}|null=null;
  now=0;private timers:{at:number;resolve:()=>void}[]=[];
  readonly capture:OriginalCapture={origin:{identity:this.i.identity,authority:this.i.authority,pins:this.i.pins,policy:this.i.policy,limits:this.i.limits},originDigest:this.f.originDigest,frameInputDigest:this.i.frame.envelope.inputDigest,launchRef:id(23)};
  readonly writable=new Writable({write:(chunk:Buffer,_encoding,callback)=>{this.written.push(Buffer.from(chunk));callback();}});
  readonly ports:WindowsJobPorts={
    original:{
      captureFresh:async()=>{this.captureCount++;return {created:this.fresh,capture:this.capture};},
      grantOriginal:async()=>{this.grantCount++;this.goKnown=true;return {created:true,goGrantRef:this.f.goGrantRef};},
      readOriginal:async()=>({originDigest:this.f.originDigest,state:this.confirmed?'CONFIRMED':'UNCONFIRMED',goGrantRef:this.goKnown?this.f.goGrantRef:null}),
    },
    broker:{
      open:async()=>{this.openCount++;return {
        send:async control=>{
          this.controls.push(control);
          if(control.command==='ACK_FINAL'&&!this.finalizeLost){
            const finalized={...(control.payload as OriginalRef),handles:this.closeConfirmed?'CLOSED' as const:'UNCONFIRMED' as const,closeCode:this.closeConfirmed?null:'CLOSE_FAILED'};
            this.message('FINALIZED',finalized);
            this.messages.end();this.joined.resolve({end:'EXPECTED',finalized});
          }
        },events:this.messages,nativeInput:this.writable,nativeOutput:this.output,nativeError:this.error,join:()=>this.joined.promise,
      };},
      readOriginal:async()=>({phase:'DRAINING',finalized:this.stored?{...this.stored.ref,handles:this.closeConfirmed?'CLOSED':'UNCONFIRMED',closeCode:this.closeConfirmed?null:'CLOSE_FAILED'}:null}),
    },
    journal:{
      appendOriginal:async(_capture,event,source)=>{
        this.sentAppend.push(event.kind);
        const entry={event,source,sourceDigest:digest(source)};
        this.rows.push(entry);
        const gate=this.appendGates.get(event.kind);if(gate)await gate.promise;
        if(this.appendLost===event.kind)throw new Error('ACK_LOST_AFTER_COMMIT');
        return {eventId:event.eventId,payloadDigest:event.payloadDigest,sourceDigest:entry.sourceDigest};
      },
      lookupEvent:async(_capture,ref)=>{this.readCount++;return this.rows.find(row=>row.event.eventId===ref.eventId)??null;},
      scanOriginal:async function*(this:Harness){for(const row of [...this.rows,...(this.extraRow?[this.extraRow]:[])]){this.scanned.push(row.event.eventId);yield row;}}.bind(this),
      sealOriginal:async(_capture,envelope)=>{
        this.sealCount++;const ref={recordId:id(24),digest:digest(envelope)};this.stored={ref,envelope};
        if(this.sealBlocked)await this.sealGate.promise;return ref;
      },
      readOriginal:async()=>this.stored,
    },
    parent:{
      rawResult:async(_capture,result)=>{this.rawCount++;if(this.rawBlocked)await this.rawGate.promise;return {rawResultId:id(25),resultDigest:digest(result.envelope)};},
      joinOriginal:async()=>{this.parentCount++;if(this.parentBlocked)await this.parentGate.promise;return this.f.ack;},
    },
    clock:{nowMs:()=>this.now,waitUntil:at=>new Promise(resolve=>{if(at<=this.now)resolve();else this.timers.push({at,resolve});})},
  };
  advance(ms:number){this.now+=ms;const due=this.timers.filter(t=>t.at<=this.now);this.timers=this.timers.filter(t=>t.at>this.now);for(const t of due)t.resolve();}
  backend(){expect(api?.createWindowsJobBackend,'W2-A 조정기 factory가 구현되어야 한다').toBeTypeOf('function');return api.createWindowsJobBackend(this.i,this.ports);}
  message(message:string,payload:unknown){this.messages.push({version:1,requestId:this.controls.at(-1)?.requestId??id(40),originDigest:this.f.originDigest,attemptId:this.i.authority.attemptId,sessionId:this.i.authority.sessionId,launchId:this.i.authority.launchId,message,payload} as WindowsHostMessage);}
  has(command:string){return this.controls.some(c=>c.command===command);}
  async emit(n:number){const row=this.f.entries[n];this.message('EVENT',row);await until(()=>this.controls.some(c=>c.command==='ACK_EVENT'&&(c.payload as {eventId:string}).eventId===row.event.eventId));}
  async prepare(b:ReturnType<Harness['backend']>){
    const pending=b.prepare();await until(()=>this.has('PREPARE'));
    for(let n=0;n<5;n++)await this.emit(n);
    this.message('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:this.f.entries[4].source.facts[1]});
    await pending;return pending;
  }
  async go(b:ReturnType<Harness['backend']>){
    const pending=b.grantGo();await until(()=>this.has('GRANT_GO'));
    for(let n=5;n<8;n++)await this.emit(n);
    this.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:this.f.ready});
    await until(()=>this.writable.writableFinished);return {pending};
  }
  async result(){
    const result=createNativeResult(this.i.frame.envelope,{metadata:{ok:true},blobs:new Map([['output',Buffer.from('한국어 합성 결과')]])},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
    const chunks:Buffer[]=[];const w=new Writable({write:(chunk:Buffer,_e,done)=>{chunks.push(Buffer.from(chunk));done();}});
    await writeNativeFrame(w,{envelope:result,blobs:new Map([['output',Buffer.from('한국어 합성 결과')]])},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
    for(const chunk of chunks)this.output.push(chunk);this.output.end();this.error.end();
  }
  async drain(){
    for(let n=8;n<10;n++)await this.emit(n);
    await until(()=>this.has('PARENT_JOINED'));
    for(let n=10;n<12;n++)await this.emit(n);
    this.message('FINAL_CANDIDATE',{evidence:this.f.evidence()});
  }
  async finish(b:ReturnType<Harness['backend']>){await this.prepare(b);const {pending}=await this.go(b);await this.result();await this.drain();return pending;}
}
describe('W2-A 원 Windows 작업의 가짜 호출 포트 조정',()=>{
  it('필수 포트가 없으면 생성이나 GO 없이 WAIT 오류를 반환한다',()=>{
    expect(api?.createWindowsJobBackend).toBeTypeOf('function');
    expect(()=>api.createWindowsJobBackend(input(),{} as WindowsJobPorts)).toThrow(/WINDOWS_/);
  });
  it('생성자에서 실제 프로세스나 네트워크를 열지 않고 포트도 호출하지 않는다',()=>{

    const f=new Harness();const b=f.backend();expect(b).toBeDefined();
    expect([f.captureCount,f.openCount,f.grantCount]).toEqual([0,0,0]); expect(childProcess.spawn).not.toHaveBeenCalled();expect(net.connect).not.toHaveBeenCalled();
  });
  it.each(['job','limits','policy','pin'] as const)('%s가 원 입력과 다르면 I/O 이전에 거부한다',kind=>{
    const f=new Harness();
    if(kind==='job')Object.assign(f.i.identity.binding,{inputDigest:h('other')});
    if(kind==='limits')f.i.limits.maxInputBytes=0;
    if(kind==='policy')Object.assign(f.i.policy,{maxProcesses:0});
    if(kind==='pin')Object.assign(f.i.pins,{nativeLimitsDigest:h('other')});
    expect(api?.createWindowsJobBackend).toBeTypeOf('function');
    expect(()=>api.createWindowsJobBackend(f.i,f.ports)).toThrow();
    expect(f.captureCount+f.openCount+f.grantCount).toBe(0);
  });
  it('fresh=false인 다른 조정기는 원 broker를 새로 만들지 않는다',async()=>{
    const f=new Harness();f.fresh=false;const b=f.backend();await expect(b.prepare()).rejects.toMatchObject({nextAction:'WAIT'});
    expect(f.openCount).toBe(0);expect((await b.query()).outcome?.state).toBe('WAIT');
  });
  it('prepare를 중복 호출해도 한 원 capture·한 broker만 만든다',async()=>{
    const f=new Harness();const b=f.backend();const a=b.prepare(),same=b.prepare();expect(a).toBe(same);
    await until(()=>f.has('PREPARE'));expect(f.captureCount).toBe(1);expect(f.openCount).toBe(1);
    for(let n=0;n<5;n++)await f.emit(n);
    f.message('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:f.f.entries[4].source.facts[1]});
    await a;expect(f.grantCount).toBe(0);
  });
  it('원 이벤트 저장 ACK가 지연되면 ACK_EVENT와 준비 완료를 앞당기지 않는다',async()=>{
    const f=new Harness(),gate=deferred<void>();f.appendGates.set('PRE_CREATE',gate);const b=f.backend();const prepared=b.prepare();
    await until(()=>f.has('PREPARE'));f.message('EVENT',f.f.entries[0]);await until(()=>f.sentAppend.length===1);
    expect(f.has('ACK_EVENT')).toBe(false);expect((await b.query()).prepared).toBeNull();
    gate.resolve();await until(()=>f.has('ACK_EVENT'));for(let n=1;n<5;n++)await f.emit(n);
    f.message('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:f.f.entries[4].source.facts[1]});await prepared;
  });
  it('정상 원 frame·이벤트·저장·최종 close 확인을 모두 합류한다',async()=>{
    const f=new Harness();const b=f.backend();const out=await f.finish(b);
    expect(out.state).toBe('JOINED');expect(out.rawResult?.rawResultId).toBe(id(25));
    expect(out.journalRef).toEqual(f.stored?.ref);expect(out).not.toHaveProperty('blobs');
    expect(f.grantCount).toBe(1);expect(f.rawCount).toBe(1);expect(f.parentCount).toBe(1);expect(f.sealCount).toBe(1);
    expect(Buffer.concat(f.written).subarray(0,8)).toEqual(Buffer.from('TMNATV1\0','ascii'));
    expect(f.stored?.envelope.parentJoinAck).toEqual(f.f.ack);
    expect(f.stored?.envelope.entries).toHaveLength(12);
    expect(validateWindowsJobEvidence(out.evidence,bounds).final.accounting?.userTime100ns).toBe('9007199254740993');
    await b.idle();await b.idle();await b.query();
    expect([f.captureCount,f.openCount,f.grantCount,f.sealCount]).toEqual([1,1,1,1]);
  });
  it('GO 중복과 query는 원 허가나 child frame을 다시 보내지 않는다',async()=>{
    const f=new Harness();const b=f.backend();await f.prepare(b);
    const a=b.grantGo(),same=b.grantGo();expect(a).toBe(same);await until(()=>f.has('GRANT_GO'));
    for(let n=5;n<8;n++)await f.emit(n);
    expect(f.written).toHaveLength(0);
    f.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:f.f.ready});
    await until(()=>f.writable.writableFinished);await f.result();await f.drain();await a;await b.query();
    expect(f.controls.filter(c=>c.command==='GRANT_GO')).toHaveLength(1);
    expect(Buffer.concat(f.written).includes(Buffer.from('GO_V1\n'))).toBe(false);
  });
  it('READY 이전에는 native 입력을 쓰지 않고 허가 전 grant는 WAIT다',async()=>{
    const f=new Harness();const b=f.backend();await expect(b.grantGo()).rejects.toMatchObject({nextAction:'WAIT'});
    expect(f.grantCount).toBe(0);expect(f.written).toHaveLength(0);
  });
  it('원 raw callback이 지연되면 부모 ACK와 최종 봉인을 기다린다',async()=>{
    const f=new Harness();f.rawBlocked=true;const b=f.backend();await f.prepare(b);const {pending}=await f.go(b);await f.result();
    await until(()=>f.rawCount===1);await f.emit(8);await f.emit(9);
    expect(f.has('PARENT_JOINED')).toBe(false);expect(f.sealCount).toBe(0);
    f.rawGate.resolve();await until(()=>f.has('PARENT_JOINED'));await f.emit(10);await f.emit(11);f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});
    expect((await pending).state).toBe('JOINED');
  });
  it('최종 저장 ACK pending에는 FINAL_ACK·완료를 만들지 않는다',async()=>{
    const f=new Harness();f.sealBlocked=true;const b=f.backend();await f.prepare(b);const {pending}=await f.go(b);await f.result();await f.drain();
    await until(()=>f.sealCount===1);expect(f.has('ACK_FINAL')).toBe(false);expect((await b.query()).outcome?.state).not.toBe('JOINED');
    f.sealGate.resolve();expect((await pending).state).toBe('JOINED');
  });
  it('append가 실제 commit 뒤 실패하면 동일 원 ID/digest만 조회해 ACK한다',async()=>{
    const f=new Harness();f.appendLost='PREPARED';const b=f.backend();const out=await f.finish(b);
    expect(out.state).toBe('JOINED');expect(f.readCount).toBeGreaterThanOrEqual(1);
    expect(f.rows.filter(r=>r.event.kind==='PREPARED')).toHaveLength(1);
  });
  it('stdout EOF 전에도 root·tree 이벤트를 처리하며 완료는 기다린다',async()=>{
    const f=new Harness();const b=f.backend();await f.prepare(b);const {pending}=await f.go(b);
    await f.emit(8);await f.emit(9);
    expect(f.sentAppend).toContain('TREE_EMPTY');expect(f.parentCount).toBe(0);expect(f.sealCount).toBe(0);
    await f.result();await until(()=>f.has('PARENT_JOINED'));await f.emit(10);await f.emit(11);
    f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});expect((await pending).state).toBe('JOINED');
  });
  it('실제 close 미확정 응답은 완전 W1이어도 WAIT다',async()=>{
    const f=new Harness();f.closeConfirmed=false;const b=f.backend();const out=await f.finish(b);
    expect(out.state).toBe('WAIT');expect(out.evidence?.final.outcome).toBe('JOB_EMPTY');
  });
  it('원 journal에 추가 이벤트가 있으면 후보 모양이 완전해도 seal하지 않는다',async()=>{
    const f=new Harness();f.extraRow=structuredClone(f.f.entries[0]);Object.assign(f.extraRow.event,{eventId:id(999)});
    const b=f.backend();await f.prepare(b);const {pending}=await f.go(b);await f.result();await f.drain();await flush();
    expect(f.sealCount).toBe(0);f.messages.end();f.joined.resolve({end:'LOST',finalized:null});
    expect((await pending).state).toBe('WAIT');
  });
  it('최종 응답 없는 EOF는 저장된 후보만으로 JOINED가 되지 않는다',async()=>{
    const f=new Harness();f.finalizeLost=true;const b=f.backend();await f.prepare(b);const {pending}=await f.go(b);await f.result();await f.drain();
    await until(()=>f.has('ACK_FINAL'));f.messages.end();f.joined.resolve({end:'LOST',finalized:null});
    expect((await pending).state).toBe('WAIT');
  });
});
describe('W2-A 닫힌 private control codec',()=>{
  function control(){return {version:1,requestId:id(1),originDigest:'a'.repeat(64),attemptId:id(2),sessionId:id(3),launchId:id(4),command:'QUERY',payload:{}} as WindowsControl;}
  it('4byte BE 길이와 독립 JSON literal의 원 QUERY를 왕복한다',()=>{
    expect(api?.encodeWindowsControl).toBeTypeOf('function');
    const body='{"attemptId":"00000000-0000-4000-8000-000000000002","command":"QUERY","launchId":"00000000-0000-4000-8000-000000000004","originDigest":"'+ 'a'.repeat(64)+'","payload":{},"requestId":"00000000-0000-4000-8000-000000000001","sessionId":"00000000-0000-4000-8000-000000000003","version":1}';
    const encoded=api.encodeWindowsControl(control());expect(encoded.readUInt32BE(0)).toBe(Buffer.byteLength(body));
    expect(encoded.subarray(4).toString('utf8')).toBe(body);expect(api.decodeWindowsControl(encoded)).toEqual(control());
  });
  it.each(['extra','command','role','depth','length'] as const)('control %s 변조를 encode 이전에 거부한다',kind=>{
    expect(api?.encodeWindowsControl).toBeTypeOf('function');
    const c=control() as unknown as Record<string,unknown>;
    if(kind==='extra')c.extra=true;
    if(kind==='command')c.command='SPAWN';
    if(kind==='role')c.payload={approved:true};
    if(kind==='depth'){let v:unknown={};for(let n=0;n<30;n++)v={nested:v};c.payload=v;}
    if(kind==='length')c.originDigest='a'.repeat(131073);
    expect(()=>api.encodeWindowsControl(c as WindowsControl)).toThrow();
  });
  it.each([
    '{"version":1,"version":1}',
    '{"version":true}',
    '{"version":NaN}',
    '{"version":1.5}',
  ])('중복 key·잘못된 수량 raw JSON을 거부한다: %s',body=>{
    expect(api?.decodeWindowsControl).toBeTypeOf('function');
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(Buffer.byteLength(body));expect(()=>api.decodeWindowsControl(Buffer.concat([prefix,Buffer.from(body)]))).toThrow();
  });
  it('틀린 UTF-8·초과 길이·trailing bytes를 거부한다',()=>{
    expect(api?.decodeWindowsControl).toBeTypeOf('function');
    for(const bytes of [Buffer.from([0,0,0,1,255]),Buffer.from([0,2,0,1]),Buffer.concat([api.encodeWindowsControl(control()),Buffer.from([0])])])expect(()=>api.decodeWindowsControl(bytes)).toThrow();
  });
});

// sourceDigest 유효성만으로 실제 관측의 모순을 성공으로 승격하지 않는다.
async function closeExtraFake(f:Harness,b:ReturnType<Harness['backend']>){
  f.output.end();f.error.end();f.messages.end();f.joined.resolve({end:'LOST',finalized:null});
  const stopped=b.stop('CONTROL_LOST');f.advance(500);await flush();await stopped;await b.idle();
}
function replaceSourceDigest(row:JournalEntry){row.sourceDigest=digest(row.source);return row;}
function eventAcknowledged(f:Harness,row:JournalEntry){
  return f.controls.some(c=>c.command==='ACK_EVENT'&&c.payload.eventId===row.event.eventId);
}
async function beforeFinalAccounting(f:Harness,b:ReturnType<Harness['backend']>){
  await f.prepare(b);const {pending}=await f.go(b);await f.result();
  await f.emit(8);await f.emit(9);await until(()=>f.has('PARENT_JOINED'));await f.emit(10);return {pending};
}

describe('W2-T01 원 생성과 후속 신원 확인 시각',()=>{
  it('생성120과 후속조회123을 그대로 보존하고 비용 시작은120을 사용한다',async()=>{
    const f=new Harness();const row=f.f.entries[2];
    const time=row.source.facts.find(x=>x.kind==='WIN32'&&x.api==='GetProcessTimes')!;
    time.qpcTicks='123';replaceSourceDigest(row);
    const b=f.backend();
    try{
      const out=await f.finish(b);
      expect(out.state).toBe('JOINED');
      expect(out.evidence?.final.accounting?.startQpcTicks).toBe('120');
      expect(out.evidence?.final.accounting?.endQpcTicks).toBe('210');
      const saved=f.rows.find(x=>x.event.kind==='CREATED_SUSPENDED')!;
      expect(saved.event.qpcTicks).toBe('120');expect(saved.source).toEqual(row.source);
      expect(saved.source.facts.find(x=>x.kind==='WIN32'&&x.api==='GetProcessTimes')?.qpcTicks).toBe('123');
      expect([f.captureCount,f.openCount,f.grantCount,f.sealCount]).toEqual([1,1,1,1]);
    }finally{await closeExtraFake(f,b);}
  });
});

function timeFact(row:JournalEntry){
  const fact=row.source.facts.find((x):x is Extract<Fact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='GetProcessTimes');
  if(!fact)throw new Error('FIXTURE_TIME_MISSING');return fact;
}
function addPreparedTime(f:Harness){
  const row=f.f.entries[3];
  if(!row.source.facts.some(x=>x.kind==='WIN32'&&x.api==='GetProcessTimes')){
    const fact=structuredClone(timeFact(f.f.entries[2]));fact.callId=id(5000);fact.qpcTicks='127';row.source.facts.push(fact);
  }
  replaceSourceDigest(row);return timeFact(row);
}
describe('W2-T02~T05 원 source의 신원과 후속 관측',()=>{
  it.each(['EXTRA_FACT','LEGACY_REF','TIME_BEFORE_CREATE','EVENT_NOT_CREATE','OTHER_REF','OTHER_PID','OTHER_FILETIME','CREATE_CALL','TIME_CALL_REUSED','MISSING_TIME','DUPLICATE_TIME','FAILED_TIME','UNKNOWN_TIME'] as const)('W2-T02 %s는 원 생성의 정상 자료로 ACK하지 않는다',async kind=>{
    const f=new Harness(),row=f.f.entries[2],time=timeFact(row);
    const creation=row.source.facts.find((x):x is Extract<Fact,{kind:'WIN32'}>=>x.kind==='WIN32'&&x.api==='CreateProcessAsUserW')!;
    const value=time.value as Record<string,unknown>;
    if(kind==='EXTRA_FACT')row.source.facts.push(f.f.win('GetNativeSystemInfo',{processorArchitecture:9},'120'));
    if(kind==='LEGACY_REF')delete value.processRef;
    if(kind==='TIME_BEFORE_CREATE')time.qpcTicks='119';
    if(kind==='EVENT_NOT_CREATE'){Object.assign(row.event,{qpcTicks:'121'});const {payloadDigest:_digest,...body}=row.event;Object.assign(row.event,{payloadDigest:digest(body)});}
    if(kind==='OTHER_REF')value.processRef=id(999);
    if(kind==='OTHER_PID')(creation.value as Record<string,unknown>).pid=43;
    if(kind==='OTHER_FILETIME')value.creationFileTime100ns='133000000000000001';
    if(kind==='CREATE_CALL')creation.callId=id(999);
    if(kind==='TIME_CALL_REUSED')time.callId=creation.callId;
    if(kind==='MISSING_TIME')row.source.facts.splice(row.source.facts.indexOf(time),1);
    if(kind==='DUPLICATE_TIME')row.source.facts.push({...structuredClone(time),callId:id(999)});
    if(kind==='FAILED_TIME')Object.assign(time,{status:'FAILED',win32Error:5,value:null});
    if(kind==='UNKNOWN_TIME')Object.assign(time,{status:'UNCONFIRMED',win32Error:null,value:null});
    replaceSourceDigest(row);const b=f.backend();
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));await f.emit(0);await f.emit(1);
      f.message('EVENT',row);await flush();
      expect(eventAcknowledged(f,row)).toBe(false);expect(f.grantCount).toBe(0);expect(f.sealCount).toBe(0);
      expect((await b.query()).prepared).toBeNull();
    }finally{await closeExtraFake(f,b);}
  });
  it.each(['REUSED_QUERY','MISSING_QUERY','OTHER_REF','OTHER_FILETIME','OBSERVATION_BEFORE_FLOOR','LIMIT_BEFORE_FLOOR','EVENT_BEFORE_FLOOR'] as const)('W2-T03 PREPARED %s를 거부한다',async kind=>{
    const f=new Harness();timeFact(f.f.entries[2]).qpcTicks='123';replaceSourceDigest(f.f.entries[2]);
    const time=addPreparedTime(f),row=f.f.entries[3];
    if(kind==='REUSED_QUERY')row.source.facts[row.source.facts.indexOf(time)]=structuredClone(timeFact(f.f.entries[2]));
    if(kind==='MISSING_QUERY')row.source.facts.splice(row.source.facts.indexOf(time),1);
    if(kind==='OTHER_REF')(time.value as Record<string,unknown>).processRef=id(999);
    if(kind==='OTHER_FILETIME')(time.value as Record<string,unknown>).creationFileTime100ns='133000000000000001';
    if(kind==='OBSERVATION_BEFORE_FLOOR')row.source.facts[0].qpcTicks='122';
    if(kind==='LIMIT_BEFORE_FLOOR')row.source.facts.find(x=>x.kind==='WIN32'&&x.api==='QueryInformationJobObject')!.qpcTicks='122';
    if(kind==='EVENT_BEFORE_FLOOR'){
      Object.assign(row.event,{qpcTicks:'122'});for(const fact of row.source.facts)fact.qpcTicks='122';
      const {payloadDigest:_digest,...body}=row.event;Object.assign(row.event,{payloadDigest:digest(body)});
    }
    replaceSourceDigest(row);const b=f.backend();
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));for(let n=0;n<3;n++)await f.emit(n);
      f.message('EVENT',row);await flush();
      expect(eventAcknowledged(f,row)).toBe(false);expect((await b.query()).prepared).toBeNull();
      expect(f.grantCount).toBe(0);expect(f.sealCount).toBe(0);
    }finally{await closeExtraFake(f,b);}
  });
  it('W2-T01 같은 QPC tick의 신규 PREPARED 조회는 허용한다',async()=>{
    const f=new Harness();addPreparedTime(f).qpcTicks='120';replaceSourceDigest(f.f.entries[3]);const b=f.backend();
    try{await f.prepare(b);expect((await b.query()).prepared?.root.pid).toBe(42);}
    finally{await closeExtraFake(f,b);}
  });
  it.each(['CREATED_SUSPENDED','PREPARED'] as const)('W2-T04 %s 저장 지연과 취소 뒤에는 prefix 재개를 승인하지 않는다',async kind=>{
    const f=new Harness(),gate=deferred<void>();timeFact(f.f.entries[2]).qpcTicks='123';replaceSourceDigest(f.f.entries[2]);
    f.appendGates.set(kind,gate);f.appendLost=kind;const index=kind==='CREATED_SUSPENDED'?2:3,b=f.backend();
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));for(let n=0;n<index;n++)await f.emit(n);
      const row=f.f.entries[index];f.message('EVENT',row);await until(()=>f.sentAppend.includes(kind));
      expect(eventAcknowledged(f,row)).toBe(false);expect((await b.query()).prepared).toBeNull();
      void b.stop('CALLER_ABORT');gate.resolve();await until(()=>f.readCount===1);
      f.message('EVENT',row);await flush();
      expect(eventAcknowledged(f,row)).toBe(false);expect(f.sentAppend.filter(x=>x===kind)).toHaveLength(1);
      expect(f.rows.find(x=>x.event.kind===kind)?.source).toEqual(row.source);expect(f.grantCount).toBe(0);
    }finally{gate.resolve();await closeExtraFake(f,b);}
  });
  it('W2-T04 늦은 신원 확인의 저장 응답 유실과 동일 row 재전송은 원 자료만 재확인한다',async()=>{
    const f=new Harness();timeFact(f.f.entries[2]).qpcTicks='123';replaceSourceDigest(f.f.entries[2]);f.appendLost='CREATED_SUSPENDED';const b=f.backend();
    try{
      await f.prepare(b);f.message('EVENT',f.f.entries[2]);await flush();
      expect(f.readCount).toBe(1);expect(f.sentAppend.filter(k=>k==='CREATED_SUSPENDED')).toHaveLength(1);
      const {pending}=await f.go(b);await f.result();await f.drain();const out=await pending;
      expect(out.state).toBe('JOINED');expect(out.evidence?.final.accounting?.startQpcTicks).toBe('120');
      expect(f.rows.find(row=>row.event.kind==='CREATED_SUSPENDED')?.source).toEqual(f.f.entries[2].source);
    }finally{await closeExtraFake(f,b);}
  });
  it('W2-T05 Python과 같은 준비 원자료를 보존해도 기존 부모 byte 한도에서 봉인한다',async()=>{
    const f=new Harness();timeFact(f.f.entries[2]).qpcTicks='123';replaceSourceDigest(f.f.entries[2]);
    f.f.entries[0].source.facts=[
      f.f.win('GetNativeSystemInfo',{processorArchitecture:9},'100'),
      f.f.win('IsWow64Process2',{processMachine:0,nativeMachine:0x8664},'100'),
      f.f.win('ProcessIdToSessionId',{sessionId:7},'100'),
    ];
    const limits=f.f.entries[3].source.facts.filter(x=>x.kind==='WIN32'&&x.api==='QueryInformationJobObject').map((x,index)=>({...structuredClone(x),callId:id(7000+index),qpcTicks:'110'}));
    f.f.entries[1].source.facts=[f.f.win('CreateJobObjectW',{objectRef:id(29)},'110'),f.f.win('SetInformationJobObject',{returned:true},'110'),...limits];
    replaceSourceDigest(f.f.entries[0]);replaceSourceDigest(f.f.entries[1]);const b=f.backend();
    try{
      await f.prepare(b);const {pending}=await f.go(b);await f.result();await f.drain();await flush();
      expect(f.i.limits.parentInFlightBytes).toBe(131072);
      expect(f.sealCount,'완료된 메시지 wrapper는 원 record와 함께 계속 예약하지 않는다').toBe(1);
      expect(f.has('ACK_FINAL')).toBe(true);const out=await pending;expect(out.state).toBe('JOINED');
      expect(f.rows.map(row=>row.source)).toEqual(f.f.entries.map(row=>row.source));
    }finally{await closeExtraFake(f,b);}
  });
});

describe('W2-A 추가: 실제 source 관측의 수량과 시점',()=>{
  it('마지막 BASIC_AND_IO의 ActiveProcesses=1은 유효 sourceDigest로도 ACK·봉인·JOINED가 되지 않는다',async()=>{
    const f=new Harness();const b=f.backend();
    try{
      await beforeFinalAccounting(f,b);
      const row=structuredClone(f.f.entries[11]);
      const query=row.source.facts.find(fact=>fact.kind==='WIN32'&&fact.api==='QueryInformationJobObject'&&(fact.value as {informationClass:string}).informationClass==='BASIC_AND_IO');
      expect(query?.kind).toBe('WIN32');
      if(query?.kind!=='WIN32')throw new Error('FIXTURE_BASIC_AND_IO_MISSING');
      (query.value as {values:{BasicInfo:{ActiveProcesses:number}}}).values.BasicInfo.ActiveProcesses=1;
      replaceSourceDigest(row);expect(row.sourceDigest).toBe(digest(row.source));
      f.message('EVENT',row);await flush();f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});await flush();
      expect.soft(eventAcknowledged(f,row),'마지막 원 OS 수량이 active=1이면 event ACK 금지').toBe(false);
      expect.soft(f.sealCount,'트리 종료를 부정하는 마지막 counter는 seal 금지').toBe(0);
      expect.soft((await b.query()).outcome?.state).not.toBe('JOINED');
    }finally{await closeExtraFake(f,b);}
  });
  it.each(['WAIT_BEFORE_RESUME','GO_WRITE_BEFORE_ARM','FINAL_QUERY_BEFORE_IO_JOIN'] as const)('%s의 실제 관측 시각을 앞당기고 sourceDigest를 재계산해도 ACK·봉인을 거부한다',async kind=>{
    const f=new Harness();const b=f.backend();
    try{
      let row:JournalEntry;
      if(kind==='WAIT_BEFORE_RESUME'){
        void b.prepare();await until(()=>f.has('PREPARE'));for(let n=0;n<4;n++)await f.emit(n);
        row=structuredClone(f.f.entries[4]);row.source.facts[1].qpcTicks='134';
        expect(row.source.facts[0].qpcTicks).toBe('135');
      }else if(kind==='GO_WRITE_BEFORE_ARM'){
        await f.prepare(b);void b.grantGo();await until(()=>f.has('GRANT_GO'));await f.emit(5);await f.emit(6);
        row=structuredClone(f.f.entries[7]);row.source.facts[0].qpcTicks='159';
        expect(f.f.entries[6].event.qpcTicks).toBe('160');
      }else{
        await beforeFinalAccounting(f,b);row=structuredClone(f.f.entries[11]);
        for(const fact of row.source.facts)if(fact.kind==='WIN32'&&fact.api==='QueryInformationJobObject')fact.qpcTicks='199';
        expect(f.f.entries[10].event.qpcTicks).toBe('200');
      }
      replaceSourceDigest(row);f.message('EVENT',row);await flush();
      if(kind==='FINAL_QUERY_BEFORE_IO_JOIN'){f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});await flush();}
      expect.soft(eventAcknowledged(f,row),'실제 관측의 선후관계가 깨진 event는 ACK 금지').toBe(false);
      expect.soft(f.sealCount).toBe(0);expect.soft((await b.query()).outcome?.state).not.toBe('JOINED');
    }finally{await closeExtraFake(f,b);}
  });
  it('GO_WRITE 반환 전 READY 관측은 원 READY hash가 맞아도 frame 쓰기를 시작하지 않는다',async()=>{
    const f=new Harness();const b=f.backend();
    try{
      await f.prepare(b);void b.grantGo();await until(()=>f.has('GRANT_GO'));for(let n=5;n<8;n++)await f.emit(n);
      const ready=structuredClone(f.f.ready);ready.qpcTicks='169';
      expect(f.f.entries[7].source.facts[0].qpcTicks).toBe('170');
      f.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:ready});await flush();
      expect.soft(f.written,'실제 GO_WRITE 전 관측된 READY는 입력 전송 권한이 아니다').toHaveLength(0);
      expect.soft(f.writable.writableFinished).toBe(false);expect(f.sealCount).toBe(0);
    }finally{await closeExtraFake(f,b);}
  });
});
async function holdPrefixAppend(f:Harness,b:ReturnType<Harness['backend']>,kind:'PRE_CREATE'|'CREATE_ARMED'){
  const gate=deferred<void>();f.appendGates.set(kind,gate);void b.prepare();await until(()=>f.has('PREPARE'));
  const index=kind==='PRE_CREATE'?0:1;for(let n=0;n<index;n++)await f.emit(n);
  const row=f.f.entries[index];f.message('EVENT',row);await until(()=>f.sentAppend.includes(kind));
  expect(eventAcknowledged(f,row)).toBe(false);return {gate,row};
}
function unconfirmedCreateArmed(f:Harness):WindowsSealEnvelope['evidence']{
  return {
    version:1,kind:'WINDOWS_JOB_OBJECT',identity:f.i.identity,authority:f.i.authority,pins:f.i.pins,
    policy:{requested:f.i.policy,osReadback:null,brokerApplied:null},
    lifecycle:{creation:'UNCONFIRMED',root:null,rootExit:null,goGrantRef:null,goWrite:'NOT_ATTEMPTED',events:structuredClone(f.f.entries.slice(0,2).map(row=>row.event))},
    final:{outcome:'UNCONFIRMED',activeProcesses:null,rootSignaled:false,stdioJoined:false,parentIoJoined:false,recordSealed:false,accounting:null,failureCode:'WINDOWS_CREATE_UNCONFIRMED'},
  };
}

describe('W2-A 추가: stop 뒤 pending 장벽과 frame 쓰기',()=>{
  it.each(['PRE_CREATE','CREATE_ARMED'] as const)('pending %s의 늦은 append ACK만으로는 stop 뒤 준비 장벽을 열지 않는다',async kind=>{
    const f=new Harness();const b=f.backend();const {gate,row}=await holdPrefixAppend(f,b,kind);
    try{
      void b.stop('CALLER_ABORT');expect(f.has('STOP')).toBe(true);gate.resolve();await flush();
      expect(eventAcknowledged(f,row)).toBe(false);expect((await b.query()).prepared).toBeNull();
      expect(f.grantCount).toBe(0);expect(f.has('GRANT_GO')).toBe(false);expect(f.written).toHaveLength(0);
      expect(f.rows.filter(entry=>entry.event.kind===kind)).toHaveLength(1);
    }finally{gate.resolve();await closeExtraFake(f,b);}
  });
  it.each(['PRE_CREATE','CREATE_ARMED'] as const)('stop 뒤 늦은 ACK에 이어 byte-identical %s가 재전송돼도 ACK 장벽을 다시 열지 않는다',async kind=>{
    const f=new Harness();const b=f.backend();const {gate,row}=await holdPrefixAppend(f,b,kind);
    try{
      void b.stop('CALLER_ABORT');gate.resolve();await flush();expect(eventAcknowledged(f,row)).toBe(false);
      const replay=structuredClone(row);expect(replay).toEqual(row);f.message('EVENT',replay);await flush();
      expect.soft(eventAcknowledged(f,row),'stop 뒤 재전송 prefix의 ACK도 새 OS 단계 장벽을 열 수 있다').toBe(false);
      expect(f.rows.filter(entry=>entry.event.kind===kind)).toHaveLength(1);
      expect((await b.query()).prepared).toBeNull();expect(f.grantCount).toBe(0);expect(f.written).toHaveLength(0);expect(f.sealCount).toBe(0);
    }finally{gate.resolve();await closeExtraFake(f,b);}
  });
  it('첫 native prefix 쓰기의 늦은 callback은 stop 뒤 합류하되 metadata·blob 후속 쓰기를 재개하지 않는다',async()=>{
    const f=new Harness(),firstWrite=deferred<void>();let firstReturned=false;
    const heldInput=new Writable({write:(chunk:Buffer,_encoding,done)=>{
      f.written.push(Buffer.from(chunk));
      if(f.written.length===1)void firstWrite.promise.then(()=>{firstReturned=true;done();});else done();
    }});
    const open=f.ports.broker.open;f.ports.broker.open=async capture=>({...await open(capture),nativeInput:heldInput});
    const b=f.backend();
    try{
      await f.prepare(b);void b.grantGo();await until(()=>f.has('GRANT_GO'));for(let n=5;n<8;n++)await f.emit(n);
      f.message('PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:f.f.ready});await until(()=>f.written.length===1);
      expect(f.written[0]).toHaveLength(12);expect(f.written[0].subarray(0,8)).toEqual(Buffer.from('TMNATV1\0','ascii'));
      expect(firstReturned).toBe(false);const stopped=b.stop('CALLER_ABORT');
      f.output.end();f.error.end();f.messages.end();f.joined.resolve({end:'LOST',finalized:null});f.advance(500);await flush();
      expect((await stopped).state).toBe('WAIT');let idled=false;const idle=b.idle().then(()=>{idled=true;});await flush();
      expect(idled,'원 첫 write callback pending 동안 idle은 완료되면 안 된다').toBe(false);
      firstWrite.resolve();await flush();await idle;
      expect(firstReturned).toBe(true);expect(idled).toBe(true);
      expect.soft(f.written,'stop 뒤 첫 write callback은 metadata/blob 전송을 허가하지 않는다').toHaveLength(1);
      expect(f.rawCount).toBe(0);expect(f.sealCount).toBe(0);expect((await b.query()).outcome?.state).toBe('WAIT');
    }finally{firstWrite.resolve();await closeExtraFake(f,b);}
  });
  it('유효한 CREATE_ARMED 미확정 원 후보는 NO_CHILD로 바꾸지 않고 WAIT의 evidence에 보존한다',async()=>{
    const f=new Harness();const b=f.backend();
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));await f.emit(0);await f.emit(1);
      const evidence=unconfirmedCreateArmed(f),checked=validateWindowsJobEvidence(evidence,bounds);
      expect(checked.lifecycle.creation).toBe('UNCONFIRMED');expect(checked.final.outcome).toBe('UNCONFIRMED');
      expect(checked.final.accounting).toBeNull();expect(checked.lifecycle.root).toBeNull();
      f.message('FINAL_CANDIDATE',{evidence});await flush();await closeExtraFake(f,b);const out=(await b.query()).outcome;
      expect(out?.state).toBe('WAIT');expect(f.rawCount).toBe(0);expect(f.parentCount).toBe(0);expect(f.sealCount).toBe(0);
      expect.soft(out?.evidence,'원 prefix와 일치하는 유효한 미확정 candidate를 유실하면 안 된다').toEqual(checked);
      expect(out?.evidence?.final.outcome).not.toBe('NO_CHILD_CREATED');
      expect(f.rows.map(row=>row.event.kind)).toEqual(['PRE_CREATE','CREATE_ARMED']);
    }finally{await closeExtraFake(f,b);}
  });
});
function noCreateSample(f:Harness,mode:'NOT_ATTEMPTED'|'FAILED'){
  const entries=structuredClone(f.f.entries.slice(0,mode==='FAILED'?2:1));
  const failureCode=mode==='FAILED'?'WINDOWS_CREATE_ACCESS_DENIED':'WINDOWS_POLICY_UNCONFIRMED';
  const add=(kind:Event['kind'],payload:unknown,facts:Fact[])=>{
    const body={eventId:id(100+entries.length),sequence:entries.length+1,kind,qpcTicks:String(100+entries.length*10),previousDigest:entries.at(-1)!.event.payloadDigest,payload};
    const event={...body,payloadDigest:digest(body)} as Event;
    const source:WindowsSource={version:1,originDigest:f.f.originDigest,eventId:event.eventId,facts};
    entries.push({event,source,sourceDigest:digest(source)});
  };
  if(mode==='NOT_ATTEMPTED')add('CREATE_NOT_ATTEMPTED',{code:failureCode},[]);
  else{
    add('CREATE_FAILED',{win32Error:5,creationConfirmedAbsent:true},[f.f.win('CreateProcessAsUserW',null,'120','FAILED',id(20))]);
    add('FAILED',{code:failureCode,phase:'CREATE'},[]);
  }
  const evidence:WindowsSealEnvelope['evidence']={
    version:1,kind:'WINDOWS_JOB_OBJECT',identity:f.i.identity,authority:f.i.authority,pins:f.i.pins,
    policy:{requested:f.i.policy,osReadback:null,brokerApplied:null},
    lifecycle:{creation:mode,root:null,rootExit:null,goGrantRef:null,goWrite:'NOT_ATTEMPTED',events:entries.map(row=>row.event)},
    final:{outcome:'NO_CHILD_CREATED',activeProcesses:null,rootSignaled:false,stdioJoined:false,parentIoJoined:true,recordSealed:true,accounting:null,failureCode},
  };
  return {entries,evidence,failureCode};
}
function forbidNoCreateChildRead(f:Harness){
  const read=vi.fn(()=>{throw new Error('NO_CREATE_CHILD_EOF_FORBIDDEN');});
  const open=f.ports.broker.open;
  f.ports.broker.open=async capture=>({...await open(capture),nativeOutput:{[Symbol.asyncIterator]:read},nativeError:{[Symbol.asyncIterator]:read}});
  return read;
}
async function announceNoCreate(f:Harness,b:ReturnType<Harness['backend']>,sample:ReturnType<typeof noCreateSample>){
  const preparing=b.prepare().then(value=>value,error=>error);await until(()=>f.has('PREPARE'));
  for(const row of sample.entries){f.message('EVENT',row);await until(()=>eventAcknowledged(f,row));}
  f.message('FINAL_CANDIDATE',{evidence:sample.evidence});return {preparing};
}

describe('W2-A 추가: 미생성 원 기록과 실제 ParentJoinAck wrapper',()=>{
  it.each(['NOT_ATTEMPTED','FAILED'] as const)('%s는 child EOF·raw·IO_JOINED 없이 실제 부모 ACK를 봉인하고 닫힌 broker에 STOP을 더 보내지 않는다',async mode=>{
    const f=new Harness(),sample=noCreateSample(f,mode),childRead=forbidNoCreateChildRead(f);
    const actualAck:ParentJoinAck={joinId:id(77),originDigest:f.f.originDigest,digest:h('actual no-child parent join')};
    f.ports.parent.joinOriginal=async()=>{f.parentCount++;return actualAck;};const b=f.backend();
    try{
      const checked=validateWindowsJobEvidence(sample.evidence,bounds);const {preparing}=await announceNoCreate(f,b,sample);
      await until(()=>f.has('ACK_FINAL')||f.has('STOP'));expect(f.has('ACK_FINAL')).toBe(true);
      expect(await preparing).toMatchObject({nextAction:'WAIT'});await flush();const out=(await b.query()).outcome;
      expect(out?.state).toBe('JOINED');expect(out?.evidence).toEqual(checked);expect(out?.rawResult).toBeNull();
      expect([f.rawCount,f.parentCount,f.sealCount]).toEqual([0,1,1]);expect(childRead).not.toHaveBeenCalled();expect(f.written).toHaveLength(0);
      expect(f.rows.map(row=>row.event.kind)).toEqual(sample.entries.map(row=>row.event.kind));
      expect(f.sentAppend).not.toContain('IO_JOINED');expect(f.sentAppend).not.toContain('FINAL_ACCOUNTING');
      const expected:WindowsSealEnvelope={version:1,originDigest:f.f.originDigest,evidence:checked,entries:sample.entries.map(row=>({eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest})),parentJoinAck:actualAck};
      expect(f.stored?.envelope).toEqual(expected);expect(out?.journalRef).toEqual({recordId:id(24),digest:digest(expected)});
      expect.soft(f.controls.filter(control=>control.command==='STOP'),'원 미생성 봉인과 close 완료 뒤 STOP을 새로 보내면 안 된다').toHaveLength(0);
      const counts=[f.captureCount,f.openCount,f.grantCount,f.rows.length,f.sealCount,f.controls.length];
      await b.idle();await b.idle();await b.query();
      expect([f.captureCount,f.openCount,f.grantCount,f.rows.length,f.sealCount,f.controls.length]).toEqual(counts);
      expect(out?.evidence?.final.failureCode).toBe(sample.failureCode);
    }finally{await closeExtraFake(f,b);}
  });
  it.each(['ACK_MISSING','ACK_OTHER_ORIGIN','WRAPPER_ACK_MISSING','WRAPPER_ACK_CHANGED'] as const)('미생성 %s는 유효 W1과 재계산 wrapper digest만으로 FINAL ACK·JOINED가 되지 않는다',async kind=>{
    const f=new Harness(),sample=noCreateSample(f,'NOT_ATTEMPTED'),childRead=forbidNoCreateChildRead(f);
    if(kind==='ACK_MISSING')f.ports.parent.joinOriginal=async()=>{f.parentCount++;return null as unknown as ParentJoinAck;};
    if(kind==='ACK_OTHER_ORIGIN')f.ports.parent.joinOriginal=async()=>{f.parentCount++;return {...f.f.ack,originDigest:h('other original')};};
    if(kind.startsWith('WRAPPER_'))f.ports.journal.sealOriginal=async(_capture,envelope)=>{
      f.sealCount++;
      const changed:WindowsSealEnvelope={...envelope,parentJoinAck:kind==='WRAPPER_ACK_MISSING'?null:{...f.f.ack,digest:h('other joined parent work')}};
      const ref={recordId:id(24),digest:digest(changed)};f.stored={ref,envelope:changed};return ref;
    };
    const b=f.backend();
    try{
      expect(validateWindowsJobEvidence(sample.evidence,bounds).final.outcome).toBe('NO_CHILD_CREATED');
      await announceNoCreate(f,b,sample);await flush();await closeExtraFake(f,b);
      expect((await b.query()).outcome?.state).toBe('WAIT');expect(f.has('ACK_FINAL')).toBe(false);expect(f.parentCount).toBe(1);
      expect(f.sealCount).toBe(kind.startsWith('WRAPPER_')?1:0);expect(f.rawCount).toBe(0);expect(childRead).not.toHaveBeenCalled();
    }finally{await closeExtraFake(f,b);}
  });
});
describe('W2-A 추가: 실패한 local clock과 안전 정수 한도',()=>{
  it.each(['NOW_THROW','NOW_NAN','WAIT_THROW','WAIT_NOT_PROMISE'] as const)('%s에서도 prepare는 동기 예외 없이 DomainError WAIT와 조회 상태를 남기고 I/O를 시작하지 않는다',async kind=>{
    const f=new Harness();const nowMs=f.ports.clock.nowMs,waitUntil=f.ports.clock.waitUntil;
    if(kind==='NOW_THROW')f.ports.clock.nowMs=()=>{throw new Error('FAKE_CLOCK_NOW_THROW');};
    if(kind==='NOW_NAN')f.ports.clock.nowMs=()=>Number.NaN;
    if(kind==='WAIT_THROW')f.ports.clock.waitUntil=()=>{throw new Error('FAKE_CLOCK_WAIT_THROW');};
    if(kind==='WAIT_NOT_PROMISE')f.ports.clock.waitUntil=()=>1 as unknown as Promise<void>;
    const b=f.backend();
    try{
      let pending:ReturnType<typeof b.prepare>|undefined,synchronousError:unknown=null;
      try{pending=b.prepare();}catch(error){synchronousError=error;}
      expect.soft(synchronousError,'clock 실패는 prepare 호출 밖으로 동기 throw하면 안 된다').toBeNull();
      expect.soft(pending,'clock 실패도 호출자가 await할 원 prepare Promise를 반환해야 한다').toBeInstanceOf(Promise);
      if(pending)await expect(pending).rejects.toMatchObject({code:expect.stringMatching(/^WINDOWS_/),nextAction:'WAIT'});
      await flush();expect.soft((await b.query()).outcome).toMatchObject({state:'WAIT',evidence:null,rawResult:null,journalRef:null});
      expect([f.captureCount,f.openCount,f.grantCount,f.rawCount,f.parentCount,f.sealCount]).toEqual([0,0,0,0,0,0]);
      expect(f.controls).toHaveLength(0);expect(f.rows).toHaveLength(0);expect(f.written).toHaveLength(0);
    }finally{f.ports.clock.nowMs=nowMs;f.ports.clock.waitUntil=waitUntil;await closeExtraFake(f,b);}
  });
  it('maxOutputBytes가 개별 안전 정수여도 metadata·header와의 합이 안전 정수를 넘으면 생성 전에 거부한다',()=>{
    const f=new Harness();f.i.limits.maxOutputBytes=Number.MAX_SAFE_INTEGER;Object.assign(f.i.pins,{nativeLimitsDigest:digest(f.i.limits)});
    expect(Number.isSafeInteger(f.i.limits.maxOutputBytes)).toBe(true);
    expect(Number.isSafeInteger(f.i.limits.maxOutputBytes+f.i.limits.maxMetadataBytes+12)).toBe(false);
    expect(()=>f.backend()).toThrow();expect([f.captureCount,f.openCount,f.grantCount]).toEqual([0,0,0]);expect(f.written).toHaveLength(0);
  });
});
function pausePreparePort(f:Harness,kind:'CAPTURE'|'INITIAL_READ'|'BROKER_OPEN'|'SEND_PREPARE'){
  const gate=deferred<void>();let entered=false;
  if(kind==='CAPTURE'){
    const original=f.ports.original.captureFresh;f.ports.original.captureFresh=async offered=>{const value=await original(offered);entered=true;await gate.promise;return value;};
  }else if(kind==='INITIAL_READ'){
    const original=f.ports.original.readOriginal;f.ports.original.readOriginal=async capture=>{const value=await original(capture);entered=true;await gate.promise;return value;};
  }else{
    const open=f.ports.broker.open;f.ports.broker.open=async capture=>{
      const session=await open(capture);
      if(kind==='BROKER_OPEN'){entered=true;await gate.promise;return session;}
      return {...session,send:async control=>{await session.send(control);if(control.command==='PREPARE'){entered=true;await gate.promise;}}};
    };
  }
  return {gate,entered:()=>entered};
}
function endExtraTransport(f:Harness){
  f.output.end();f.error.end();f.messages.end();f.joined.resolve({end:'LOST',finalized:null});
}
async function expireExtraDeadline(f:Harness){f.advance(1000);await flush();f.advance(500);await flush();}

describe('W2-A 추가 A: timeout 반환과 실제 pending port 합류',()=>{
  it.each(['CAPTURE','INITIAL_READ','BROKER_OPEN','SEND_PREPARE'] as const)('prepare %s pending 중 deadline은 WAIT를 먼저 반환하고 idle은 원 pending이 끝날 때까지 기다린다',async kind=>{
    const f=new Harness(),pause=pausePreparePort(f,kind);const b=f.backend();
    const observed:{settled:boolean;error:unknown}={settled:false,error:null};
    const preparing=b.prepare().then(()=>{observed.settled=true;},error=>{observed.settled=true;observed.error=error;});
    try{
      await until(pause.entered);const prepareCount=f.controls.filter(control=>control.command==='PREPARE').length;
      await expireExtraDeadline(f);expect((await b.query()).outcome?.state).toBe('WAIT');
      expect.soft(observed.settled,'호출자 prepare는 원 port pending과 독립적으로 deadline WAIT를 받아야 한다').toBe(true);
      expect.soft(observed.error).toMatchObject({nextAction:'WAIT'});
      endExtraTransport(f);let idled=false;const idle=b.idle().then(()=>{idled=true;});await flush();expect(idled).toBe(false);
      pause.gate.resolve();await preparing;await flush();await idle;expect(idled).toBe(true);
      expect(f.controls.filter(control=>control.command==='PREPARE')).toHaveLength(prepareCount);
      expect(f.has('GRANT_GO')).toBe(false);expect(f.grantCount).toBe(0);expect(f.written).toHaveLength(0);expect(f.sealCount).toBe(0);
      expect((await b.query()).outcome?.state).toBe('WAIT');
    }finally{pause.gate.resolve();await closeExtraFake(f,b);}
  });
  it.each(['GRANT_ORIGINAL','READ_BEFORE_GRANT','READ_AFTER_GRANT','SEND_GRANT_GO'] as const)('grantGo %s pending 중 terminal WAIT를 먼저 반환하고 늦은 성공은 추가 GO를 만들지 않는다',async kind=>{
    const f=new Harness(),gate=deferred<void>();let entered=false;
    if(kind==='SEND_GRANT_GO'){
      const open=f.ports.broker.open;f.ports.broker.open=async capture=>{
        const session=await open(capture);
        return {...session,send:async control=>{await session.send(control);if(control.command==='GRANT_GO'){entered=true;await gate.promise;}}};
      };
    }
    const b=f.backend();
    try{
      await f.prepare(b);
      if(kind==='GRANT_ORIGINAL'){
        const grant=f.ports.original.grantOriginal;f.ports.original.grantOriginal=async capture=>{const value=await grant(capture);entered=true;await gate.promise;return value;};
      }else if(kind==='READ_BEFORE_GRANT'||kind==='READ_AFTER_GRANT'){
        const read=f.ports.original.readOriginal;f.ports.original.readOriginal=async capture=>{
          const value=await read(capture);if(kind==='READ_BEFORE_GRANT'&&!f.goKnown||kind==='READ_AFTER_GRANT'&&f.goKnown){entered=true;await gate.promise;}return value;
        };
      }

      const observed:{settled:boolean;outcome:unknown}={settled:false,outcome:null};
      const pending=b.grantGo().then(value=>{observed.settled=true;observed.outcome=value;});
      await until(()=>entered);const goCount=f.controls.filter(control=>control.command==='GRANT_GO').length;
      await expireExtraDeadline(f);expect((await b.query()).outcome?.state).toBe('WAIT');
      expect.soft(observed.settled,'호출자 grantGo는 원 허가/전송 pending과 독립적으로 terminal WAIT를 받아야 한다').toBe(true);
      expect.soft(observed.outcome).toMatchObject({state:'WAIT'});
      endExtraTransport(f);let idled=false;const idle=b.idle().then(()=>{idled=true;});await flush();
      expect(idled).toBe(false);
      gate.resolve();await pending;await flush();await idle;
      expect(f.controls.filter(control=>control.command==='GRANT_GO')).toHaveLength(goCount);
      expect(f.controls.filter(control=>control.command==='PREPARE')).toHaveLength(1);expect(f.written).toHaveLength(0);expect(f.sealCount).toBe(0);
    }finally{gate.resolve();await closeExtraFake(f,b);}
  });
});

describe('W2-A 추가 B: OS 한도를 활성화하는 원 LimitFlags',()=>{
  it.each([0x8,0x100,0x200,0x308])('PREPARED에서 필수 LimitFlags mask=%s가 빠지면 숫자와 sourceDigest가 유효해도 준비 ACK와 GO를 거부한다',async missing=>{
    const f=new Harness();const b=f.backend();void b.prepare();
    try{
      await until(()=>f.has('PREPARE'));for(let n=0;n<3;n++)await f.emit(n);
      const row=structuredClone(f.f.entries[3]);const sample=row.source.facts.find(fact=>fact.kind==='WIN32'&&fact.api==='QueryInformationJobObject'&&(fact.value as {informationClass:string}).informationClass==='EXTENDED_LIMITS');
      if(sample?.kind!=='WIN32')throw new Error('FIXTURE_PREPARED_LIMITS_MISSING');
      const limits=(sample.value as {values:{BasicLimitInformation:{LimitFlags:number};ProcessMemoryLimit:string;JobMemoryLimit:string}}).values;
      expect(limits.BasicLimitInformation.LimitFlags).toBe(0x2308);limits.BasicLimitInformation.LimitFlags&=~missing;
      expect(limits.ProcessMemoryLimit).toBe('524288');expect(limits.JobMemoryLimit).toBe('1048576');replaceSourceDigest(row);
      f.message('EVENT',row);await flush();
      f.message('EVENT',f.f.entries[4]);f.message('PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:f.f.entries[4].source.facts[1]});await flush();
      const go=b.grantGo().then(value=>value,error=>error);await flush();
      expect.soft(eventAcknowledged(f,row),'활성화 비트 없는 숫자는 실제 OS 한도 적용의 증거가 아니다').toBe(false);
      expect.soft((await b.query()).prepared).toBeNull();expect.soft(f.grantCount).toBe(0);expect.soft(f.has('GRANT_GO')).toBe(false);
      await closeExtraFake(f,b);await go;expect(f.sealCount).toBe(0);expect(f.written).toHaveLength(0);
    }finally{await closeExtraFake(f,b);}
  });
});

describe('W2-A 추가 D: 원 journal 순회 iterator의 정리 합류',()=>{
  it.each(['EXTRA_ENTRY','SOURCE_REPLACED','RETURN_FAILURE'] as const)('%s에서 generator finally를 실행하고 pending cleanup을 idle에 합류하며 봉인을 거부한다',async kind=>{
    const f=new Harness(),cleanupGate=deferred<void>();let cleanupEntered=false,cleanupFinished=false;
    const scan=(async function*(){
      try{
        for(let n=0;n<f.rows.length;n++){
          if(kind!=='EXTRA_ENTRY'&&n===0){
            const replaced=structuredClone(f.rows[n]);replaced.source.facts.push(f.f.win('QueryPerformanceCounter',{ticks:'99'},'99'));replaceSourceDigest(replaced);yield replaced;
          }else yield f.rows[n];
        }
        if(kind==='EXTRA_ENTRY')yield structuredClone(f.rows[0]);
      }finally{
        cleanupEntered=true;await cleanupGate.promise;cleanupFinished=true;
        if(kind==='RETURN_FAILURE')throw new Error('FAKE_SCAN_RETURN_FAILED');
      }
    })();f.ports.journal.scanOriginal=()=>scan;const b=f.backend();
    try{
      await beforeFinalAccounting(f,b);await f.emit(11);f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});await flush();
      expect.soft(cleanupEntered,'순회 거부 뒤 iterator.return으로 원 generator finally를 시작해야 한다').toBe(true);
      endExtraTransport(f);const stopped=b.stop('CONTROL_LOST');await expireExtraDeadline(f);expect((await stopped).state).toBe('WAIT');
      let idled=false;const idle=b.idle().then(()=>{idled=true;});await flush();
      expect.soft(idled,'원 scan 정리 finally가 pending이면 idle은 끝나면 안 된다').toBe(false);
      expect(cleanupFinished).toBe(false);expect(f.sealCount).toBe(0);expect(f.has('ACK_FINAL')).toBe(false);
      cleanupGate.resolve();await flush();await idle;expect.soft(cleanupFinished).toBe(true);
      expect((await b.query()).outcome?.state).toBe('WAIT');expect(f.sealCount).toBe(0);
    }finally{
      cleanupGate.resolve();await closeExtraFake(f,b);
      // 검증이 끝난 뒤 fake generator만 직접 회수한다. 제품의 누락된 return을 성공으로 세지 않는다.
      await scan.return(undefined).catch(()=>{});
    }
  });
});
function refreshExtraCapture(f:Harness){
  Object.assign(f.i.authority,{policyDigest:digest(f.i.policy)});Object.assign(f.i.pins,{nativeLimitsDigest:digest(f.i.limits)});
  Object.assign(f.f,fixture(f.i));Object.assign(f.capture,{originDigest:f.f.originDigest});
}
function fixtureInputHold(f:Harness){
  return [...f.i.frame.blobs.values()].reduce((sum,bytes)=>sum+bytes.length,0)+3*Buffer.byteLength(JSON.stringify(f.i.frame.envelope))+12;
}
function deferredNativeLanes(f:Harness){
  const out=deferred<IteratorResult<Uint8Array>>(),err=deferred<IteratorResult<Uint8Array>>();const calls={out:0,err:0};
  const lane=(name:'out'|'err',gate:typeof out):AsyncIterable<Uint8Array>=>({[Symbol.asyncIterator]:()=>({next:()=>++calls[name]===1?gate.promise:Promise.resolve({done:true,value:undefined})})});
  const open=f.ports.broker.open;f.ports.broker.open=async capture=>({...await open(capture),nativeOutput:lane('out',out),nativeError:lane('err',err)});
  const release=()=>{out.resolve({done:true,value:undefined});err.resolve({done:true,value:undefined});};return {out,err,calls,release};
}

describe('W2-A 추가 C: 읽기와 control 사본 이전 parent credit',()=>{
  it('parent65536에서 OUT·ERR의 각 chunk credit65536보다 잔여 예산이 작으면 CREATED 도달 뒤에도 next를 호출하지 않는다',async()=>{
    const f=new Harness(),lanes=deferredNativeLanes(f);
    f.i.limits.parentInFlightBytes=65536;Object.assign(f.i.policy,{stdoutMaxBytes:'131072',stderrMaxBytes:'65536'});refreshExtraCapture(f);
    const b=f.backend();expect(b).toBeDefined();expect(f.i.frame.blobs.get('source')!.length).toBeGreaterThan(0);
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));expect(f.controls.filter(control=>control.command==='PREPARE')).toHaveLength(1);
      await f.emit(0);await f.emit(1);f.message('EVENT',f.f.entries[2]);await flush();
      expect([f.captureCount,f.openCount]).toEqual([1,1]);expect(f.sentAppend).toContain('CREATED_SUSPENDED');
      expect(f.rows.find(row=>row.event.kind==='CREATED_SUSPENDED')?.source).toEqual(f.f.entries[2].source);
      expect.soft(lanes.calls.out,'input 사본을 보유한 parent65536은 OUT credit65536을 먼저 확보할 수 없다').toBe(0);
      expect.soft(lanes.calls.err,'ERR credit65536도 읽기 전에 독립적으로 확보해야 한다').toBe(0);
      expect(f.rawCount).toBe(0);expect(f.sealCount).toBe(0);expect(f.written).toHaveLength(0);
    }finally{lanes.release();await closeExtraFake(f,b);}
  });
  it('동시에 pending인 OUT·ERR의 늦은 반환 둘을 합류하기 전에는 timeout 뒤에도 idle이 끝나지 않는다',async()=>{
    const f=new Harness(),lanes=deferredNativeLanes(f);const b=f.backend();
    try{
      void b.prepare();await until(()=>f.has('PREPARE'));for(let n=0;n<3;n++)await f.emit(n);await flush();expect(lanes.calls).toEqual({out:1,err:1});
      endExtraTransport(f);const stopped=b.stop('CALLER_ABORT');await expireExtraDeadline(f);expect((await stopped).state).toBe('WAIT');
      let idled=false;const idle=b.idle().then(()=>{idled=true;});await flush();expect(idled).toBe(false);
      lanes.out.resolve({done:true,value:undefined});await flush();expect(idled,'ERR pending 하나만 남아도 원 합류는 미완료다').toBe(false);
      lanes.err.resolve({done:true,value:undefined});await idle;expect(idled).toBe(true);expect(f.rawCount).toBe(0);expect(f.sealCount).toBe(0);
    }finally{lanes.release();await closeExtraFake(f,b);}
  });
  it('PREPARE send budget이 부족하면 길이 계산을 위한 command Buffer.from 사본도 먼저 만들지 않는다',async()=>{
    const f=new Harness();Object.assign(f.i.policy,{stdoutMaxBytes:'32',stderrMaxBytes:'32'});
    for(let n=0;n<3;n++){
      refreshExtraCapture(f);
      const offered:WindowsControl={version:1,requestId:id(3000),originDigest:f.f.originDigest,attemptId:f.i.authority.attemptId,sessionId:f.i.authority.sessionId,launchId:f.i.authority.launchId,command:'PREPARE',payload:{origin:f.capture.origin,launchRef:f.capture.launchRef}};
      f.i.limits.parentInFlightBytes=fixtureInputHold(f)+Buffer.byteLength(JSON.stringify(offered))+4-1;
    }
    refreshExtraCapture(f);let commandCopies=0;const originalFrom=Buffer.from;
    const from=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{
      if(typeof args[0]==='string'&&args[0].includes('"command":"PREPARE"'))commandCopies++;
      return Reflect.apply(originalFrom,Buffer,args);
    }) as typeof Buffer.from);
    let b:ReturnType<Harness['backend']>|null=null;
    try{
      try{b=f.backend();}catch(error){expect(error).toMatchObject({code:'WINDOWS_PARENT_LIMIT',nextAction:'WAIT'});}
      if(b){
        const preparing=b.prepare().then(value=>value,error=>error);await flush();endExtraTransport(f);await expireExtraDeadline(f);await preparing;
        expect((await b.query()).outcome?.state).toBe('WAIT');
      }
      expect.soft(commandCopies,'control buffer를 만들기 전에 retained byte 예산을 선차감해야 한다').toBe(0);
      expect(f.has('PREPARE')).toBe(false);expect(f.grantCount).toBe(0);expect(f.written).toHaveLength(0);
    }finally{from.mockRestore();if(b)await closeExtraFake(f,b);}
  });
});

function rechainExtraEntries(entries:JournalEntry[]){
  for(let n=0;n<entries.length;n++){
    const row=entries[n];Object.assign(row.event,{sequence:n+1,previousDigest:n?entries[n-1].event.payloadDigest:null});
    const {payloadDigest:_old,...body}=row.event;Object.assign(row.event,{payloadDigest:digest(body)});
    row.source.eventId=row.event.eventId;replaceSourceDigest(row);
  }
  return entries;
}

describe('W2-A 추가: 마지막 ACK·정확한 원 집합·native 소유 사본',()=>{
  it('마지막 accounting append가 commit돼도 ACK pending 동안 후보를 seal하지 않고 원 ACK 뒤에만 완료한다',async()=>{
    const f=new Harness(),gate=deferred<void>();f.appendGates.set('FINAL_ACCOUNTING',gate);const b=f.backend();
    try{
      const {pending}=await beforeFinalAccounting(f,b);const row=f.f.entries[11];f.message('EVENT',row);await until(()=>f.sentAppend.includes('FINAL_ACCOUNTING'));
      const committed=await f.ports.journal.lookupEvent(f.capture,{eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest});expect(committed).toEqual(row);
      f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});await flush();expect(eventAcknowledged(f,row)).toBe(false);expect(f.sealCount).toBe(0);expect(f.has('ACK_FINAL')).toBe(false);
      gate.resolve();expect((await pending).state).toBe('JOINED');expect(f.sealCount).toBe(1);
    }finally{gate.resolve();await closeExtraFake(f,b);}
  });
  it('실제 ParentJoinAck pending 동안 PARENT_JOINED·IO_JOINED 승인·seal을 앞당기지 않는다',async()=>{
    const f=new Harness();f.parentBlocked=true;const b=f.backend();
    try{
      await f.prepare(b);const {pending}=await f.go(b);await f.result();await until(()=>f.parentCount===1);await f.emit(8);await f.emit(9);await flush();
      expect(f.has('PARENT_JOINED')).toBe(false);expect(f.sentAppend).not.toContain('IO_JOINED');expect(f.sealCount).toBe(0);expect((await b.query()).outcome?.state).not.toBe('JOINED');
      f.parentGate.resolve();await until(()=>f.has('PARENT_JOINED'));await f.emit(10);await f.emit(11);f.message('FINAL_CANDIDATE',{evidence:f.f.evidence()});
      expect((await pending).state).toBe('JOINED');expect(f.stored?.envelope.parentJoinAck).toEqual(f.f.ack);
    }finally{f.parentGate.resolve();await closeExtraFake(f,b);}
  });
  it.each(['MISSING_ENTRY','OTHER_VALID_CHAIN'] as const)('scanOriginal %s는 같은 원 identity의 완전 W1 후보라도 봉인하지 않는다',async kind=>{
    const f=new Harness();f.ports.journal.scanOriginal=async function*(){
      if(kind==='MISSING_ENTRY'){yield* f.rows.slice(0,-1);return;}
      const alternate=structuredClone(f.rows);for(let n=0;n<alternate.length;n++)Object.assign(alternate[n].event,{eventId:id(900+n)});rechainExtraEntries(alternate);
      const evidence=f.f.evidence();expect(validateWindowsJobEvidence({...evidence,lifecycle:{...evidence.lifecycle,events:alternate.map(row=>row.event)}},bounds).final.outcome).toBe('JOB_EMPTY');
      yield* alternate;
    };const b=f.backend();
    try{
      await f.prepare(b);await f.go(b);await f.result();await f.drain();await flush();await closeExtraFake(f,b);
      expect(f.sealCount).toBe(0);expect(f.has('ACK_FINAL')).toBe(false);expect((await b.query()).outcome?.state).toBe('WAIT');
    }finally{await closeExtraFake(f,b);}
  });
  it('raw-result ref의 digest가 실제 원 envelope와 다르면 완전 W1 후보로도 ACK_FINAL·JOINED가 되지 않는다',async()=>{
    const f=new Harness();f.ports.parent.rawResult=async()=>{f.rawCount++;return {rawResultId:id(25),resultDigest:'0'.repeat(64)};};const b=f.backend();
    try{
      await f.prepare(b);await f.go(b);await f.result();await until(()=>f.rawCount===1);await f.drain();await flush();await closeExtraFake(f,b);
      const out=(await b.query()).outcome;expect(out?.state).toBe('WAIT');expect(out?.rawResult).toBeNull();expect(f.sealCount).toBe(0);expect(f.has('ACK_FINAL')).toBe(false);
    }finally{await closeExtraFake(f,b);}
  });
  it('factory 뒤 caller blob과 Map을 바꿔도 원 hash를 검증한 input 사본만 전송한다',async()=>{
    const f=new Harness(),original=Buffer.from(f.i.frame.blobs.get('source')!);const b=f.backend();
    f.i.frame.blobs.get('source')!.fill(0);f.i.frame.blobs.clear();f.i.frame.blobs.set('source',Buffer.from('caller replacement'));
    try{
      const out=await f.finish(b);expect(out.state).toBe('JOINED');expect(Buffer.concat(f.written).subarray(-original.length)).toEqual(original);
      expect(out.evidence?.identity.binding.inputDigest).toBe(f.i.frame.envelope.inputDigest);
    }finally{await closeExtraFake(f,b);}
  });
  it.each(['INPUT_BYTES','PARENT_BYTES'] as const)('%s의 실제 한도를 넘는 원 input 사본은 생성 전에 I/O0으로 거부한다',kind=>{
    const f=new Harness();if(kind==='INPUT_BYTES')f.i.limits.maxInputBytes=f.i.frame.blobs.get('source')!.length-1;else f.i.limits.parentInFlightBytes=1;
    Object.assign(f.i.pins,{nativeLimitsDigest:digest(f.i.limits)});expect(()=>f.backend()).toThrow();expect([f.captureCount,f.openCount,f.grantCount,f.rawCount]).toEqual([0,0,0,0]);expect(f.written).toHaveLength(0);
  });
  it('CREATED_SUSPENDED 뒤 PREPARE 실패는 GO 없이 원 root/tree·IO·마지막 수량을 합류해 실패 기록을 봉인한다',async()=>{
    const f=new Harness(),base=f.f.evidence(),failureCode='WINDOWS_PREPARE_FAILED';
    const body={eventId:id(600),sequence:4,kind:'FAILED',qpcTicks:'130',previousDigest:f.f.entries[2].event.payloadDigest,payload:{code:failureCode,phase:'PREPARE'}};
    const event={...body,payloadDigest:digest(body)} as Event;const source:WindowsSource={version:1,originDigest:f.f.originDigest,eventId:event.eventId,facts:[]};
    const entries=rechainExtraEntries([...structuredClone(f.f.entries.slice(0,3)),{event,source,sourceDigest:digest(source)},...structuredClone(f.f.entries.slice(8))]);
    const io=entries.find(row=>row.event.kind==='IO_JOINED')!;io.source.facts=io.source.facts.filter(fact=>!(fact.kind==='IO'&&fact.bytesLength==='9'));replaceSourceDigest(io);
    const evidence:WindowsSealEnvelope['evidence']={...base,policy:{requested:f.i.policy,osReadback:null,brokerApplied:null},lifecycle:{...base.lifecycle,goGrantRef:null,goWrite:'NOT_ATTEMPTED',events:entries.map(row=>row.event)},final:{...base.final,failureCode}};
    expect(validateWindowsJobEvidence(evidence,bounds).final.outcome).toBe('JOB_EMPTY');const b=f.backend();
    try{
      const preparing=b.prepare().then(value=>value,error=>error);await until(()=>f.has('PREPARE'));
      for(let n=0;n<4;n++){f.message('EVENT',entries[n]);await until(()=>eventAcknowledged(f,entries[n]));}
      const stopped=b.stop('HOST_FAILED');f.output.end();f.error.end();await until(()=>f.has('PARENT_JOINED'));
      for(let n=4;n<entries.length;n++){f.message('EVENT',entries[n]);await until(()=>eventAcknowledged(f,entries[n]));}
      f.message('FINAL_CANDIDATE',{evidence});const out=await stopped;expect(out.state).toBe('JOINED');expect(out.evidence).toEqual(evidence);expect(await preparing).toMatchObject({nextAction:'WAIT'});
      expect([f.grantCount,f.rawCount,f.parentCount,f.sealCount]).toEqual([0,0,1,1]);expect(f.has('GRANT_GO')).toBe(false);expect(f.written).toHaveLength(0);
      expect(f.rows.some(row=>['PREPARED','BOOTSTRAP_RESUMED','GO_AUTHORIZED','GO_WRITE'].includes(row.event.kind))).toBe(false);await b.idle();
    }finally{await closeExtraFake(f,b);}
  });
});
describe('W2-A 추가 C: 정상 typed control send의 사본 경계',()=>{
  it('command 포함 Buffer.from 사본 없이 실제 typed sends와 원 전체 경로 JOINED를 완료한다',async()=>{
    const f=new Harness();const b=f.backend();let commandCopies=0;const originalFrom=Buffer.from;
    const from=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{
      if(typeof args[0]==='string'&&args[0].includes('"command":'))commandCopies++;
      return Reflect.apply(originalFrom,Buffer,args);
    }) as typeof Buffer.from);
    try{
      const out=await f.finish(b);expect(out.state).toBe('JOINED');expect(out.journalRef).toEqual(f.stored?.ref);
      expect(f.controls.map(control=>control.command)).toEqual(expect.arrayContaining(['PREPARE','ACK_EVENT','GRANT_GO','PARENT_JOINED','ACK_FINAL']));
      expect(f.controls.filter(control=>control.command==='ACK_EVENT')).toHaveLength(12);
      expect([f.captureCount,f.openCount,f.grantCount,f.rawCount,f.parentCount,f.sealCount]).toEqual([1,1,1,1,1,1]);
      expect.soft(commandCopies,'typed BrokerSession.send 경로는 사용하지 않는 command encode buffer를 만들 필요가 없다').toBe(0);
      await b.idle();
    }finally{from.mockRestore();await closeExtraFake(f,b);}
  });
});
function guardQuery():WindowsControl{
  return {version:1,requestId:id(1),originDigest:'a'.repeat(64),attemptId:id(2),sessionId:id(3),launchId:id(4),command:'QUERY',payload:{}};
}

describe('W2-A 최종 guard: 사용자 코드·실제 byte 크기·최종 요청 결합',()=>{
  it.each(['GETTER','PROXY'] as const)('%s control payload·입력 metadata는 사용자 getter/trap 호출 없이 거부하고 factory I/O0을 유지한다',kind=>{
    const f=new Harness();let calls=0;const trap=()=>{calls++;throw new Error('USER_CODE_MUST_NOT_RUN');};
    const hostile=(target:Record<string,unknown>)=>kind==='GETTER'?Object.defineProperty(target,'hostile',{enumerable:true,get:trap}):new Proxy(target,{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap});
    const control={...guardQuery(),payload:hostile({})} as unknown as WindowsControl;
    expect(()=>api.encodeWindowsControl(control)).toThrow();expect(calls).toBe(0);
    f.i.frame.envelope.metadata=hostile(f.i.frame.envelope.metadata);
    expect(()=>f.backend()).toThrow();expect(calls).toBe(0);
    expect([f.captureCount,f.openCount,f.grantCount,f.rawCount,f.parentCount,f.sealCount]).toEqual([0,0,0,0,0,0]);expect(f.written).toHaveLength(0);
  });
  it('byte·depth 한도 내 alias payload라도 펼친 node8192 초과는 clone 전에 WINDOWS_CONTROL_LIMIT로 거부한다',()=>{
    let branch:unknown=0;for(let n=0;n<13;n++)branch=[branch,branch];
    const control={...guardQuery(),payload:{branches:branch}} as unknown as WindowsControl;
    expect((branch as unknown[])[0]).toBe((branch as unknown[])[1]);
    expect(Buffer.byteLength(JSON.stringify(control))).toBeLessThanOrEqual(131072);expect(2+13).toBeLessThanOrEqual(20);expect(2**14-1).toBeGreaterThan(8192);
    expect(()=>api.encodeWindowsControl(control)).toThrow('WINDOWS_CONTROL_LIMIT');
  });
  it('raw control Buffer의 own byteLength·buffer·byteOffset getter를 실행하지 않고 안전하게 읽거나 거부한다',()=>{
    const expected=guardQuery(),body=Buffer.from(JSON.stringify(expected),'utf8'),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);
    const bytes=Buffer.concat([prefix,body]);const originals={byteLength:bytes.byteLength,buffer:bytes.buffer,byteOffset:bytes.byteOffset};
    const calls={byteLength:0,buffer:0,byteOffset:0};
    for(const key of ['byteLength','buffer','byteOffset'] as const)Object.defineProperty(bytes,key,{configurable:true,get:()=>{calls[key]++;return originals[key];}});
    let decoded:WindowsControl|undefined,error:unknown=null;
    try{decoded=api.decodeWindowsControl(bytes);}catch(caught){error=caught;}
    try{
      expect.soft(calls,'검증되지 않은 Buffer own accessor는 내부 byte view의 권위가 아니다').toEqual({byteLength:0,buffer:0,byteOffset:0});
      if(decoded)expect(decoded).toEqual(expected);else expect(error).toMatchObject({nextAction:'WAIT'});
    }finally{for(const key of ['byteLength','buffer','byteOffset'])Reflect.deleteProperty(bytes,key);}
  });
  it('실제16385byte source의 own length=0 getter와 정합한 metadata는 실제 input한도를 우회하지 못하고 getter0·I/O0으로 거부된다',()=>{
    const f=new Harness(),source=Buffer.alloc(16385,0x61),sourceHash=sha256(source),job=f.i.frame.envelope;
    job.blobs[0]={id:'source',byteLength:0,sha256:sourceHash};const {inputDigest:_old,...body}=job;job.inputDigest=digest(body);
    Object.assign(f.i.identity.binding,{inputDigest:job.inputDigest});f.i.frame.blobs.set('source',source);
    expect(source.length).toBe(16385);expect(f.i.limits.maxInputBytes).toBe(16384);expect(job.inputDigest).toBe(digest(body));
    expect(f.i.identity.binding.inputDigest).toBe(job.inputDigest);expect(job.blobs[0]).toEqual({id:'source',byteLength:0,sha256:sourceHash});
    let calls=0;Object.defineProperty(source,'length',{configurable:true,get:()=>{calls++;return 0;}});calls=0;
    let error:unknown=null;
    try{
      try{f.backend();}catch(caught){error=caught;}
      expect.soft(error,'실제 source bytes가 원 maxInputBytes를 넘으면 constructor가 거부해야 한다').toMatchObject({nextAction:'WAIT'});
      expect.soft(calls,'입력 크기·복사는 사용자 length getter를 실행하면 안 된다').toBe(0);
      expect([f.captureCount,f.openCount,f.grantCount,f.rawCount,f.parentCount,f.sealCount]).toEqual([0,0,0,0,0,0]);expect(f.written).toHaveLength(0);
    }finally{Reflect.deleteProperty(source,'length');}
  });
  it('원 ref·tuple이 같아도 이전 PREPARE requestId의 FINALIZED는 ACK_FINAL pending 요청과 달라 WAIT이며 추가 GO0이다',async()=>{
    const f=new Harness();f.finalizeLost=true;const b=f.backend();
    try{
      await f.prepare(b);const {pending}=await f.go(b);await f.result();await f.drain();await until(()=>f.has('ACK_FINAL'));
      const prepare=f.controls.find(control=>control.command==='PREPARE')!,ackFinal=f.controls.find(control=>control.command==='ACK_FINAL')!;
      expect(prepare.requestId).not.toBe(ackFinal.requestId);expect(f.stored).not.toBeNull();expect((await b.query()).outcome?.state).not.toBe('JOINED');
      const finalized:HostFinalized={...f.stored!.ref,handles:'CLOSED',closeCode:null};
      const wrong:WindowsHostMessage={version:1,requestId:prepare.requestId,originDigest:f.f.originDigest,attemptId:f.i.authority.attemptId,sessionId:f.i.authority.sessionId,launchId:f.i.authority.launchId,message:'FINALIZED',payload:finalized};
      f.messages.push(wrong);f.messages.end();f.joined.resolve({end:'EXPECTED',finalized});const out=await pending;
      expect.soft(out.state,'발급된 requestId라는 사실만으로 최종 close ACK correlation을 대신할 수 없다').toBe('WAIT');
      expect(out.journalRef).toEqual(f.stored!.ref);expect(f.sealCount).toBe(1);await b.idle();await b.query();
      expect(f.grantCount).toBe(1);expect(f.controls.filter(control=>control.command==='GRANT_GO')).toHaveLength(1);expect(f.openCount).toBe(1);
    }finally{await closeExtraFake(f,b);}
  });
});
