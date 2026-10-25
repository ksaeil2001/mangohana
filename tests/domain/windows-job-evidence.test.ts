import {describe,it,expect} from 'vitest';
import {digest} from '../../packages/contracts/src/intent.js';
import {validateWindowsJobEvidence,classifyWindowsJobEvidence} from '../../packages/native/src/windows-job-evidence.js';

const bounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const hash=(s:string)=>digest(s);
type Row=Record<string,unknown>;
type Event={eventId:string;sequence:number;kind:string;qpcTicks:string;previousDigest:string|null;payload:Row;payloadDigest:string};
function fixture(){
  const binding={accountId:id(1),capacityReservationId:id(2),jobId:id(3),parentInstanceId:id(4),inputDigest:hash('native input'),profileDigest:hash('profile'),kernelDigest:hash('kernel')};
  const identity={binding,intentDigest:hash('intent'),sourceInput:{executionId:id(5),inputEvidenceId:id(6),stageInputDigest:hash('stage input')},inputEvidenceDigest:hash('input record'),inputFingerprint:hash('canonical stage input'),basisRef:{evidenceId:id(7),evidenceDigest:hash('basis')}};
  const requested={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'4096',stderrMaxBytes:'1024'};
  const osReadback={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,killOnJobClose:true,breakawayAllowed:false};
  const brokerApplied={wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'4096',stderrMaxBytes:'1024'};
  const authority={attemptId:id(8),controllerInstanceId:id(9),controllerId:'windows-controller',keyVersion:'key-v1',environmentDigest:hash('environment'),hostEpochId:id(10),sessionId:id(11),launchId:id(12),policyDigest:digest(requested),controllerSidDigest:hash('controller sid'),childSidDigest:hash('child sid'),appContainerSidDigest:hash('container sid')};
  const pins={executableDigest:hash('node'),bootstrapDigest:hash('bootstrap'),helperRuntimeDigest:hash('python'),helperScriptDigest:hash('helper'),runtimeFilesDigest:hash('runtime'),nativeLimitsDigest:hash('native limits')};
  const root={pid:42,creationFileTime100ns:'133000000000000000'};
  const goGrantRef={jobId:binding.jobId,rowDigest:hash('original go row')};
  const accounting={userTime100ns:'9007199254740993',kernelTime100ns:'300',peakJobMemoryBytes:'16384',peakProcessMemoryBytes:'8192',readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0',totalProcesses:'2',startQpcTicks:'120',endQpcTicks:'220',qpcFrequency:'10000000',snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS'};
  const events:Event[]=[];
  const add=(kind:string,payload:Row)=>{const event={eventId:id(100+events.length),sequence:events.length+1,kind,qpcTicks:String(100+events.length*10),previousDigest:events.at(-1)?.payloadDigest??null,payload};events.push({...event,payloadDigest:digest(event)});};
  add('PRE_CREATE',{bindingDigest:digest(identity),policyDigest:authority.policyDigest,pinsDigest:digest(pins)});
  add('CREATE_ARMED',{callId:id(20)});
  add('CREATED_SUSPENDED',{...root,assignedBy:'PROC_THREAD_ATTRIBUTE_JOB_LIST'});
  add('PREPARED',{membershipConfirmed:true,tokenDigest:hash('actual token'),osReadbackDigest:digest(osReadback),brokerAppliedDigest:digest(brokerApplied)});
  add('BOOTSTRAP_RESUMED',{resumeReturned:true});
  add('GO_AUTHORIZED',{goGrantRef:{...goGrantRef}});
  add('GO_WRITE_ARMED',{bytesLength:'6'});
  add('GO_WRITE',{result:'RETURNED',bytesLength:'6'});
  add('ROOT_EXIT',{exitCode:0});
  add('TREE_EMPTY',{activeProcesses:0,totalProcesses:'2'});
  add('IO_JOINED',{stdinClosed:true,stdoutEof:true,stderrEof:true,parentIoJoined:true});
  // 최종 query 직후 QPC는 마지막 사건의 실제 관측 시각이다.
  accounting.endQpcTicks='210';
  add('FINAL_ACCOUNTING',{accounting:{...accounting}});
  return {version:1,kind:'WINDOWS_JOB_OBJECT',identity,authority,pins,policy:{requested,osReadback,brokerApplied},lifecycle:{creation:'CREATED',root,goGrantRef,goWrite:'RETURNED',rootExit:{exitCode:0,observedQpcTicks:'180'},events},final:{outcome:'JOB_EMPTY',activeProcesses:0,rootSignaled:true,stdioJoined:true,parentIoJoined:true,recordSealed:true,accounting,failureCode:null as string|null}};
}
type Sample=ReturnType<typeof fixture>;
function reseal(value:Sample){
  for(let n=0;n<value.lifecycle.events.length;n++){
    const event=value.lifecycle.events[n];event.sequence=n+1;event.previousDigest=n?value.lifecycle.events[n-1].payloadDigest:null;
    const {payloadDigest:_old,...body}=event;event.payloadDigest=digest(body);
  }
  return value;
}
function partial(cut:string,creation='CREATED'){
  const value=fixture(),at=value.lifecycle.events.findIndex(event=>event.kind===cut);value.lifecycle.events=value.lifecycle.events.slice(0,at+1);
  Object.assign(value.lifecycle,{creation,root:creation==='CREATED'?value.lifecycle.root:null,rootExit:null,goGrantRef:cut.startsWith('GO_')?value.lifecycle.goGrantRef:null,goWrite:cut==='GO_WRITE'?'RETURNED':cut==='GO_WRITE_ARMED'?'UNCONFIRMED':'NOT_ATTEMPTED'});
  Object.assign(value.final,{outcome:'UNCONFIRMED',activeProcesses:null,rootSignaled:false,stdioJoined:false,parentIoJoined:false,recordSealed:false,accounting:null,failureCode:'WINDOWS_JOB_UNCONFIRMED'});
  return value;
}
function noCreate(mode:'NOT_ATTEMPTED'|'FAILED'){
  const value=partial('PRE_CREATE',mode);
  if(mode==='FAILED'){const original=fixture();value.lifecycle.events.push(structuredClone(original.lifecycle.events[1]),{...structuredClone(original.lifecycle.events[2]),kind:'CREATE_FAILED',payload:{win32Error:5,creationConfirmedAbsent:true}});}
  else value.lifecycle.events.push({...structuredClone(fixture().lifecycle.events[1]),kind:'CREATE_NOT_ATTEMPTED',payload:{code:'POLICY_UNCONFIRMED'}});
  Object.assign(value.final,{outcome:'NO_CHILD_CREATED',parentIoJoined:true,recordSealed:true,failureCode:'POLICY_UNCONFIRMED'});
  return reseal(value);
}
function stoppedAfter(cut:string,writeUnknown=false){
  const source=fixture(),value=partial(cut);
  value.lifecycle.events.push({...structuredClone(source.lifecycle.events[8]),eventId:id(50),kind:'FAILED',payload:{code:'STOPPED_BEFORE_NEXT_PHASE',phase:cut.startsWith('GO_')?'GO':'PREPARE'}});
  value.lifecycle.events.push(...structuredClone(source.lifecycle.events.slice(8)));
  for(let i=0;i<value.lifecycle.events.length;i++)value.lifecycle.events[i].qpcTicks=String(100+i*10);
  const exit=value.lifecycle.events.find(event=>event.kind==='ROOT_EXIT')!,last=value.lifecycle.events.at(-1)!;
  const accounting={...source.final.accounting,endQpcTicks:last.qpcTicks};
  last.payload={accounting:{...accounting}};
  Object.assign(value.final,{...source.final,accounting,failureCode:'STOPPED_BEFORE_NEXT_PHASE'});
  Object.assign(value.lifecycle,{rootExit:{exitCode:0,observedQpcTicks:exit.qpcTicks},goWrite:writeUnknown?'UNCONFIRMED':'NOT_ATTEMPTED'});
  return reseal(value);
}
function checked(value:unknown,custom=bounds){return validateWindowsJobEvidence(value,custom);}
function reject(value:unknown,code='WINDOWS_JOB_EVIDENCE_INVALID'){expect(()=>checked(value)).toThrow(code);}

describe('W1 Windows 원 증거의 순수 데이터 계약',()=>{
  it('정상 트리 기록을 정밀한 frozen 사본으로 분류하고 원 입력을 바꾸지 않는다',()=>{
    const input=fixture(),before=structuredClone(input),out=checked(input);
    expect(out).toEqual(before);expect(out).not.toBe(input);expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');
    expect(Object.isFrozen(out)).toBe(true);expect(Object.isFrozen(out.lifecycle.events[0].payload)).toBe(true);
    expect(out.final.accounting?.userTime100ns).toBe('9007199254740993');
    input.final.accounting.userTime100ns='1';expect(out.final.accounting?.userTime100ns).toBe('9007199254740993');
  });
  it.each(['NOT_ATTEMPTED','FAILED'] as const)('확정 %s에는 없는 root와 OS 수량을 만들지 않는다',mode=>{
    const out=checked(noCreate(mode));expect(classifyWindowsJobEvidence(out)).toBe('NO_CREATE_RECORD');expect(out.final.accounting).toBeNull();expect(out.lifecycle.root).toBeNull();
  });
  it('생성 반환 소실은 미생성이나 종료 확정으로 분류하지 않는다',()=>{
    const input=partial('CREATE_ARMED','UNCONFIRMED'),out=checked(input);expect(classifyWindowsJobEvidence(out)).toBe('UNCONFIRMED');
    input.final.outcome='NO_CHILD_CREATED';reject(input);
  });
  it.each(['CREATED_SUSPENDED','PREPARED','BOOTSTRAP_RESUMED','GO_AUTHORIZED'])('%s 뒤 중단은 실제 종료와 join이 있으면 없는 후속 사건 없이 완료한다',cut=>{
    const out=checked(stoppedAfter(cut));expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');
    expect(out.lifecycle.goWrite).toBe('NOT_ATTEMPTED');
  });
  it('GO 전달 시도 반환 소실도 원 허가와 시도 및 종료를 보존한다',()=>{
    const out=checked(stoppedAfter('GO_WRITE_ARMED',true));expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');expect(out.lifecycle.goWrite).toBe('UNCONFIRMED');
  });
  it('실제 종료와 저장이 없는 부분 기록은 미확정 상태로 보존한다',()=>{
    for(const cut of ['CREATED_SUSPENDED','PREPARED','GO_AUTHORIZED','GO_WRITE_ARMED'])expect(classifyWindowsJobEvidence(checked(partial(cut)))).toBe('UNCONFIRMED');
  });
  it('완전한 모양과 유효한 ID는 외부 DB 진위나 실행 권한이 아니다',()=>{
    const input=fixture();input.authority.attemptId=id(999);const out=checked(input);
    expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');expect(out).not.toHaveProperty('verified');expect(out).not.toHaveProperty('release');
  });
  it.each(['version','kind','hidden','identity','authority'])('알 수 없는 버전 종류 필드나 잘못된 %s를 거부한다',key=>{
    const value=fixture() as unknown as Row;value[key]=key==='version'?2:key==='kind'?'OWNED_FIXTURE':true;reject(value);
  });
  it.each(['intentDigest','inputFingerprint','inputEvidenceDigest'])('봉인된 identity의 %s 변조를 거부한다',key=>{
    const value=fixture();(value.identity as unknown as Row)[key]=hash('other');reject(value);
  });
  it.each(['attemptId','controllerInstanceId','sessionId','launchId'])('잘못된 %s 형식을 거부한다',key=>{
    const value=fixture();(value.authority as unknown as Row)[key]='not-a-uuid';reject(value);
  });
  it('다른 원 GO job과 다른 GO digest projection을 거부한다',()=>{
    const value=fixture();value.lifecycle.goGrantRef.jobId=id(999);reject(value);
    const other=fixture();other.lifecycle.goGrantRef.rowDigest=hash('other');reject(other);
  });
  it('같은 PID라도 다른 OS 생성 시각의 종료 투영을 거부한다',()=>{
    const value=fixture();value.lifecycle.root.creationFileTime100ns='133000000000000001';reject(value);
  });
  it.each(['maxProcesses','cpuRatePer10000','jobCommitLimitBytes'])('OS %s readback 변조를 거부한다',key=>{
    const value=fixture();(value.policy.osReadback as unknown as Row)[key]=key==='jobCommitLimitBytes'?'2097152':9;reject(value);
  });
  it('시간과 pipe 한도의 broker 적용 확인을 OS 값과 구분해 대조한다',()=>{
    const value=fixture();value.policy.brokerApplied.joinTimeoutMs=501;reject(value);
    const out=checked(fixture());expect(out.policy.osReadback).not.toHaveProperty('wallTimeoutMs');
  });
  it.each(['goWrite','creation','rootExit'])('원 사건과 모순인 %s 투영을 거부한다',key=>{
    const value=fixture();(value.lifecycle as unknown as Row)[key]=key==='goWrite'?'NOT_ATTEMPTED':key==='creation'?'FAILED':null;reject(value);
  });
  it.each(['rootSignaled','stdioJoined','parentIoJoined','recordSealed'])('완료에 필요한 %s가 없으면 합격하지 않는다',key=>{
    const value=fixture();(value.final as unknown as Row)[key]=false;reject(value);
  });
  it('미확정 생성에 가짜 0 OS 수량이나 active0를 추가할 수 없다',()=>{
    const value=partial('CREATE_ARMED','UNCONFIRMED');value.final.accounting=fixture().final.accounting;reject(value);
    const other=partial('CREATE_ARMED','UNCONFIRMED');other.final.activeProcesses=0;reject(other);
  });
  it.each(['ROOT_EXIT','TREE_EMPTY','IO_JOINED','FINAL_ACCOUNTING'])('완료에서 %s 원 사건을 제거하면 거부한다',kind=>{
    const value=fixture();value.lifecycle.events=value.lifecycle.events.filter(event=>event.kind!==kind);reject(reseal(value));
  });
  it('사건 순서 중복 이전 digest와 payload 변조를 거부한다',()=>{
    const values=[fixture(),fixture(),fixture(),fixture()];
    [values[0].lifecycle.events[3],values[0].lifecycle.events[4]]=[values[0].lifecycle.events[4],values[0].lifecycle.events[3]];reseal(values[0]);
    values[1].lifecycle.events[2].eventId=values[1].lifecycle.events[1].eventId;reseal(values[1]);
    values[2].lifecycle.events[4].previousDigest=hash('other');
    values[3].lifecycle.events[9].payload.activeProcesses=1;
    for(const value of values)reject(value);
  });
  it('GO 허가 없는 write와 생성 전 root 종료를 거부한다',()=>{
    const value=fixture();value.lifecycle.events=value.lifecycle.events.filter(event=>event.kind!=='GO_AUTHORIZED');reject(reseal(value));
    const other=fixture();const exit=other.lifecycle.events.splice(8,1)[0];other.lifecycle.events.splice(1,0,exit);reject(reseal(other));
  });
  it.each(['-1','01','1.0','1e3','18446744073709551616',9007199254740992])('64bit 수량 %s를 반올림하거나 받아들이지 않는다',quantity=>{
    const value=fixture();(value.final.accounting as unknown as Row).userTime100ns=quantity;reject(value);
  });
  it('최종 accounting과 QPC 시작 끝 원 사건을 정확히 대조한다',()=>{
    const value=fixture();value.final.accounting.endQpcTicks='999';reject(value);
    const other=fixture();other.final.accounting.startQpcTicks='100';other.lifecycle.events.at(-1)!.payload.accounting={...other.final.accounting};reject(reseal(other));
  });
  it('필수 한도 0 범위 초과와 다른 메모리 의미를 거부한다',()=>{
    const value=fixture();value.policy.requested.maxProcesses=0;reject(value);
    const other=fixture();other.policy.requested.wallTimeoutMs=2147483648;reject(other);
    const memory=fixture();memory.final.accounting.memoryAccounting='RSS';reject(memory);
  });
  it('diagnostic callback 사본이나 선언된 VERIFIED를 증거로 받지 않는다',()=>{
    reject({version:1,event:'CLOSED',pid:42,observedMonotonicMs:1});const value=fixture() as unknown as Row;value.verified=true;reject(value);
  });
  it('getter와 proxy와 toJSON을 실행하지 않고 거부한다',()=>{
    let called=0;const getter=Object.defineProperty(fixture(),'secret',{enumerable:true,get(){called++;throw new Error('getter called');}});
    const proxy=new Proxy({}, {getPrototypeOf(){called++;throw new Error('proxy called');}});
    const json={...fixture(),toJSON(){called++;return fixture();}};
    for(const value of [getter,proxy,json])reject(value);expect(called).toBe(0);
  });
  it('순환과 지나친 alias 확장을 node 예산 안에서 중단한다',()=>{
    const cycle:Row={};cycle.self=cycle;reject(cycle);
    let aliased:unknown={x:1};for(let n=0;n<12;n++)aliased={a:aliased,b:aliased};
    expect(()=>checked(aliased,{...bounds,maxDepth:16,maxNodes:64})).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
  });
  it('문자열 byte node 깊이 사건 개수 예산을 각각 적용한다',()=>{
    expect(()=>checked(fixture(),{...bounds,maxRecordBytes:100})).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
    expect(()=>checked(fixture(),{...bounds,maxNodes:10})).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
    expect(()=>checked(fixture(),{...bounds,maxDepth:2})).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
    expect(()=>checked(fixture(),{...bounds,maxEvents:2})).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
    expect(()=>checked('가'.repeat(100000))).toThrow('WINDOWS_JOB_EVIDENCE_LIMIT');
  });
  it('미정 bounds와 sparse hidden symbol custom prototype 입력을 거부한다',()=>{
    expect(()=>checked(fixture(),{...bounds,maxNodes:0})).toThrow('WINDOWS_JOB_EVIDENCE_INVALID');
    const hidden=Object.defineProperty(fixture(),'hidden',{value:true}),symbol={...fixture(),[Symbol('hidden')]:true},sparse=fixture();
    delete sparse.lifecycle.events[1];
    for(const value of [hidden,symbol,sparse,Object.create({kind:'WINDOWS_JOB_OBJECT'})])reject(value);
  });
  it('W1 review 생성된 fresh job의 누계 0을 원자료끼리 맞춰도 완료로 인정하지 않는다',()=>{
    const value=fixture();value.final.accounting.totalProcesses='0';
    value.lifecycle.events.find(event=>event.kind==='TREE_EMPTY')!.payload.totalProcesses='0';
    value.lifecycle.events.at(-1)!.payload.accounting={...value.final.accounting};
    reject(reseal(value));
  });
  it.each(['osReadback','brokerApplied'] as const)('W1 review %s 불일치는 준비 전 실패에 보존하고 PREPARED에서는 거부한다',kind=>{
    const stopped=stoppedAfter('CREATED_SUSPENDED');
    if(kind==='osReadback')stopped.policy.osReadback.maxProcesses=3;
    else stopped.policy.brokerApplied.joinTimeoutMs=501;
    const out=checked(stopped);expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');expect(out.policy[kind]).toEqual(stopped.policy[kind]);
    const prepared=fixture();
    if(kind==='osReadback')prepared.policy.osReadback.maxProcesses=3;
    else prepared.policy.brokerApplied.joinTimeoutMs=501;
    const event=prepared.lifecycle.events.find(event=>event.kind==='PREPARED')!;
    event.payload[kind==='osReadback'?'osReadbackDigest':'brokerAppliedDigest']=digest(prepared.policy[kind]);
    reject(reseal(prepared));
  });
  it.each(['osReadback','brokerApplied'] as const)('W1 review 준비 전 실패의 %s도 자료형과 허용 범위는 지켜야 한다',kind=>{
    const value=stoppedAfter('CREATED_SUSPENDED');
    if(kind==='osReadback')value.policy.osReadback.maxProcesses=0;
    else value.policy.brokerApplied.joinTimeoutMs=0;
    reject(value);
  });
  it('W1 review 미호출 원 사유와 최종 사유를 다르게 바꿀 수 없다',()=>{
    const value=noCreate('NOT_ATTEMPTED');value.final.failureCode='OTHER_FAILURE';reject(value);
  });
  it('W1 review FILETIME은 승인 계약의 0 경계값을 그대로 보존한다',()=>{
    const value=fixture();value.lifecycle.root.creationFileTime100ns='0';
    value.lifecycle.events.find(event=>event.kind==='CREATED_SUSPENDED')!.payload.creationFileTime100ns='0';
    const out=checked(reseal(value));expect(classifyWindowsJobEvidence(out)).toBe('COMPLETE_TREE_RECORD');expect(out.lifecycle.root?.creationFileTime100ns).toBe('0');
  });

});
