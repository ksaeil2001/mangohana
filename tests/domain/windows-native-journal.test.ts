import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import type {NativeControllerDatabase} from '../../packages/storage/src/native-controller-role.js';
import {windowsNativeScript} from '../fixtures/windows-native.js';
import {digest} from '../../packages/contracts/src/intent.js';
import {createNativeJob,type NativeLimits} from '../../packages/native/src/dto.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {WindowsPrepareInput,OriginalCapture,WindowsSource,JournalEntry} from '../../packages/native/src/windows-job-backend.js';
import type {WindowsNativeJournal as Journal} from '../../packages/domain/src/windows-native-journal.js';

vi.mock('node:child_process',async importOriginal=>{const original=await importOriginal<typeof import('node:child_process')>();const fail=()=>{throw new Error('W3A_REAL_CHILD_FORBIDDEN');};return {...original,default:{...original,spawn:fail,exec:fail},spawn:fail,exec:fail};});
const modulePath='../../packages/domain/src/windows-native-journal.js';
const codecAudit=vi.hoisted(()=>({before:undefined as ((value:unknown)=>void)|undefined}));
vi.mock('canonicalize',async importOriginal=>{const original=await importOriginal<typeof import('canonicalize')>();return {...original,default:(value:unknown)=>{codecAudit.before?.(value);return original.default(value);}};});
async function journalConstructor(){
  const loaded=await import(modulePath).catch(error=>({moduleError:String(error)}));
  expect(loaded,'W3-A 원 DB journal 생성자가 제공되어야 한다').toHaveProperty('WindowsNativeJournal');
  return loaded.WindowsNativeJournal as typeof Journal;
}
function testMemory(maxBytes:number){let held=0;return {maxBytes,available:()=>maxBytes-held,hold:(bytes:number)=>{if(!Number.isSafeInteger(bytes)||bytes<0||held+bytes>maxBytes)throw Error('TEST_SHARED_MEMORY_WAIT');held+=bytes;let live=true;return ()=>{if(live){live=false;held-=bytes;}};}};}
function specimen(){
  const key=generateKeyPairSync('ed25519'),limits:NativeLimits={maxMetadataBytes:4096,maxInputBytes:16384,maxOutputBytes:16384,maxItems:8,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:8*1024*1024};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const pins={executableDigest:digest('node'),bootstrapDigest:digest('bootstrap'),helperRuntimeDigest:digest('python'),helperScriptDigest:digest('helper'),runtimeFilesDigest:digest('runtime'),nativeLimitsDigest:digest(limits)};
  const controllerId=randomUUID(),controllerInstanceId=randomUUID(),profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'w3a-unit-v1',maxSlots:2,nativeProfileDigest:digest(syntheticProfile),kernelDigest:digest('kernel'),controllerId,keyVersion:'key-v1',environmentDigest:digest('environment'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['windows-job:w3a/unit'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:digest('controller SID'),childSidDigest:digest('child SID'),appContainerSidDigest:digest('AppContainer SID')}};
  const capacity={reference:{kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:digest('SQL profile digest'),profileVersion:profile.version},profile};
  const signer={keyVersion:profile.keyVersion,publicKeySpki:profile.publicKeySpki,sign:vi.fn(async(canonical:string)=>sign(null,Buffer.from(canonical),key.privateKey).toString('base64'))};
  const decision=vi.fn<(...args:unknown[])=>Promise<{allowed:boolean;[key:string]:unknown}>>(),db={decision} as unknown as NativeControllerDatabase,peer={serviceRole:'trio_web_worker' as const,peerId:randomUUID()};
  const blobs=new Map([['source',Buffer.from('synthetic original')]]),envelope=createNativeJob('ZIP_WRITE',profile.nativeProfileDigest,{profile:syntheticProfile,entries:[{name:'original.bin',blobId:'source'}]},blobs,{maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems});
  const identity={binding:{accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:envelope.jobId,parentInstanceId:randomUUID(),inputDigest:envelope.inputDigest,profileDigest:profile.nativeProfileDigest,kernelDigest:profile.kernelDigest},intentDigest:digest('original SQL intent'),sourceInput:{executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:digest('stage input')},inputEvidenceDigest:digest('INPUT'),inputFingerprint:digest('INPUT'),basisRef:null};
  const authority={attemptId:randomUUID(),controllerInstanceId,controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const input:WindowsPrepareInput={identity,authority,pins,policy,limits,frame:{envelope,blobs}};
  const {frame:_frame,...origin}=input;void _frame;
  const capture:OriginalCapture={origin,originDigest:digest({identity,authority,pins,policy,nativeLimitsDigest:digest(limits),frameInputDigest:envelope.inputDigest}),frameInputDigest:envelope.inputDigest,launchRef:randomUUID()};
  const configuration={controllerId,controllerInstanceId,capacity,limits,signer};
  const body={eventId:randomUUID(),sequence:1,kind:'PRE_CREATE' as const,qpcTicks:'100',previousDigest:null,payload:{bindingDigest:digest(identity),policyDigest:digest(policy),pinsDigest:digest(pins)}};
  const event={...body,payloadDigest:digest(body)},source:WindowsSource={version:1,originDigest:capture.originDigest,eventId:event.eventId,facts:[]};
  return {db,peer,input,capture,configuration,event,source,decision};
}

describe('W3-A 원 journal의 실행 권위·동일 bytes·한도',()=>{
  it('생성은 I/O·서명·실제 child 없이 고정된 필수 포트만 포착한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),journal=new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes));
    expect(f.decision).not.toHaveBeenCalled();expect(f.configuration.signer.sign).not.toHaveBeenCalled();
    const ports=journal.portsFor(f.peer);expect(Object.keys(ports).sort()).toEqual(['journal','original']);
  });
  it('NativeLimits 원 digest가 pins와 다르면 DB 접근 전에 거부한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();f.configuration.limits.parentInFlightBytes++;
    expect(()=>new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes))).toThrow();expect(f.decision).not.toHaveBeenCalled();
  });
  it('서명키가 등록 profile과 다르면 생성 단계에서 거부한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();f.configuration.signer.keyVersion='foreign-key';
    expect(()=>new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes))).toThrow();expect(f.decision).not.toHaveBeenCalled();
  });
  it('caller getter와 proxy를 평가해 등록 권위를 만들지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();let evaluated=false;
    const config={...f.configuration};Object.defineProperty(config,'limits',{enumerable:true,get(){evaluated=true;return f.configuration.limits;}});
    expect(()=>new Ctor(f.db,config,testMemory(f.configuration.limits.parentInFlightBytes))).toThrow();expect(evaluated).toBe(false);
    expect(()=>new Ctor(f.db,new Proxy(f.configuration,{}),testMemory(f.configuration.limits.parentInFlightBytes))).toThrow();expect(f.decision).not.toHaveBeenCalled();
  });
  it('fresh capture의 원 tuple·W2 digest·launch ref를 정확히 반환한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();f.decision.mockResolvedValueOnce({allowed:true,created:true,capture:f.capture});
    const value=await new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).original.captureFresh(f.input);
    expect(value).toEqual({created:true,capture:f.capture});expect(f.decision).toHaveBeenCalledTimes(1);
    const args=f.decision.mock.calls[0];expect(args[0]).toBe(f.input.identity.binding.accountId);expect(args[1]).toContain('windows_native_capture');
  });
  it('DB가 다른 origin·native digest·launch ref를 ACK해도 권위를 받지 않는다',async()=>{
    const Ctor=await journalConstructor();
    for(const patch of [{originDigest:digest('other')},{frameInputDigest:digest('other')},{launchRef:'invalid'}]){
      const f=specimen();f.decision.mockResolvedValueOnce({allowed:true,created:true,capture:{...f.capture,...patch}});
      await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).original.captureFresh(f.input)).rejects.toThrow();
    }
  });
  it('입력 identity를 frame과 바꾸면 capture SQL을 실행하지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();f.input.identity={...f.input.identity,binding:{...f.input.identity.binding,inputDigest:digest('foreign native input')}};
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).original.captureFresh(f.input)).rejects.toThrow();expect(f.decision).not.toHaveBeenCalled();
  });
  it('원 event/source의 다른 digest ACK를 성공으로 바꾸지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();f.decision.mockResolvedValueOnce({allowed:true,ack:{eventId:f.event.eventId,payloadDigest:digest('forged'),sourceDigest:digest(f.source)}});
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).journal.appendOriginal(f.capture,f.event,f.source)).rejects.toThrow();
  });
  it('같은 원 사건의 정확한 ACK만 반환하고 caller bytes를 바꾸지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),original=digest({event:f.event,source:f.source});const ack={eventId:f.event.eventId,payloadDigest:f.event.payloadDigest,sourceDigest:digest(f.source)};
    f.decision.mockResolvedValueOnce({allowed:true,ack});expect(await new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).journal.appendOriginal(f.capture,f.event,f.source)).toEqual(ack);
    expect(digest({event:f.event,source:f.source})).toBe(original);
  });
  it('다른 capture의 source 및 원 event digest 변조는 SQL 전 거부한다',async()=>{
    const Ctor=await journalConstructor();for(const change of ['SOURCE','EVENT']){const f=specimen();if(change==='SOURCE')f.source.originDigest=digest('foreign');else f.event.payloadDigest=digest('forged');
      await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).journal.appendOriginal(f.capture,f.event,f.source)).rejects.toThrow();expect(f.decision).not.toHaveBeenCalled();}
  });
  it('초과 선언과 alias 확장은 DB 접근 전에 노드/byte 예산으로 중단한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();let expanded:unknown={};for(let n=0;n<20;n++)expanded=[expanded,expanded];
    const source={...f.source,facts:[{kind:'WIN32',callId:randomUUID(),api:'QueryInformationJobObject',qpcTicks:'100',status:'RETURNED',win32Error:null,value:expanded}]} as WindowsSource;
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).journal.appendOriginal(f.capture,f.event,source)).rejects.toThrow();expect(f.decision).not.toHaveBeenCalled();
  });
  it('scan은 같은 sequence를 반복하는 DB 응답을 무한 재생하지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),entry:JournalEntry={event:f.event,source:f.source,sourceDigest:digest(f.source)};
    f.decision.mockResolvedValue({allowed:true,entries:[entry]});const journal=new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)),seen:JournalEntry[]=[];
    await expect((async()=>{for await(const item of journal.portsFor(f.peer).journal.scanOriginal(f.capture))seen.push(item);})()).rejects.toThrow();expect(seen.length).toBeLessThanOrEqual(1);expect(f.decision.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
describe('W3-A 원 source readback과 부모 보유 예산',()=>{
  it.each(['CPU','IDENTITY','RESUME','CLOSE_TIME','BUDGET'] as const)('%s 변조는 seal 원 record 저장 전에 거부한다',async fault=>{
    const Ctor=await journalConstructor(),f=specimen();
    if(fault==='BUDGET'){f.input.limits={...f.input.limits,parentInFlightBytes:32768};f.configuration.limits=f.input.limits;f.input.pins={...f.input.pins,nativeLimitsDigest:digest(f.input.limits)};f.configuration.capacity.profile.windows.pins=f.input.pins;f.capture.origin.pins=f.input.pins;f.capture.origin.limits=f.input.limits;f.capture.originDigest=digest({identity:f.input.identity,authority:f.input.authority,pins:f.input.pins,policy:f.input.policy,nativeLimitsDigest:digest(f.input.limits),frameInputDigest:f.input.frame.envelope.inputDigest});}
    const script=windowsNativeScript(f.input);script.complete({jobId:f.input.frame.envelope.jobId,rowDigest:digest('actual SQL GO row')});
    const first=script.entries.find(r=>r.event.kind==='CREATED_SUSPENDED')!,prepared=script.entries.find(r=>r.event.kind==='PREPARED')!,resumed=script.entries.find(r=>r.event.kind==='BOOTSTRAP_RESUMED')!,final=script.entries.find(r=>r.event.kind==='FINAL_ACCOUNTING')!;
    if(fault==='CPU'){const fact=prepared.source.facts.find(v=>v.kind==='WIN32'&&v.api==='QueryInformationJobObject'&&(v.value as {informationClass:string}).informationClass==='CPU_RATE')!;Object.assign((fact as {value:{values:object}}).value.values,{CpuRate:100});}
    if(fault==='IDENTITY'){const fact=prepared.source.facts.find(v=>v.kind==='WIN32'&&v.api==='GetProcessTimes')!;Object.assign(fact,{callId:(first.source.facts[1] as {callId:string}).callId});}
    if(fault==='RESUME'){const fact=resumed.source.facts.find(v=>v.kind==='WIN32'&&v.api==='ResumeThread')!;Object.assign((fact as {value:object}).value,{previousSuspendCount:2});}
    if(fault==='CLOSE_TIME')for(const fact of final.source.facts)Object.assign(fact,{qpcTicks:'190'});
    for(const row of script.entries)row.sourceDigest=digest(row.source);
    f.decision.mockImplementation(async(_account,query,values)=>{
      if(String(query).includes('windows_native_scan'))return {allowed:true,entries:script.entries.slice(Number((values as unknown[])[1]),Number((values as unknown[])[1])+1)};
      if(String(query).includes('windows_native_record'))return {allowed:true,ref:{recordId:randomUUID(),digest:digest(script.seal())}};
      throw Error('Unexpected fake query');
    });
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).journal.sealOriginal(f.capture,script.seal())).rejects.toThrow();
    expect(f.decision.mock.calls.some(call=>String(call[1]).includes('windows_native_record'))).toBe(false);
  });
});

describe('W3-A 중첩 origin getter와 Proxy 사전 경계',()=>{
  it.each(['GETTER','PROXY'] as const)('%s는 hash 전에 SQL0·trap0으로 거부한다',async fault=>{
    const Ctor=await journalConstructor(),f=specimen();let calls=0;
    if(fault==='GETTER')Object.defineProperty(f.input.identity.binding,'accountId',{enumerable:true,get(){calls++;throw Error('Getter must not execute');}});
    else f.input.identity=new Proxy(f.input.identity,{get(){calls++;throw Error('Proxy must not execute');},ownKeys(){calls++;throw Error('Proxy must not execute');}});
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).original.captureFresh(f.input)).rejects.toThrow();expect(calls).toBe(0);expect(f.decision).not.toHaveBeenCalled();
  });
});

describe('W3-A 공유 메모리의 실제 pending 수명',()=>{
  it('DB 응답 pending에는 합산 hold를 반환하지 않고 close도 기다린다',async()=>{
    const Ctor=await journalConstructor(),f=specimen();const maxBytes=65536;
    f.configuration.limits={...f.configuration.limits,parentInFlightBytes:maxBytes};f.input.limits=f.configuration.limits;
    f.configuration.capacity.profile.windows.pins={...f.input.pins,nativeLimitsDigest:digest(f.input.limits)};f.input.pins=f.configuration.capacity.profile.windows.pins;
    f.capture.origin={identity:f.input.identity,authority:f.input.authority,pins:f.input.pins,policy:f.input.policy,limits:f.input.limits};f.capture.originDigest=digest({identity:f.input.identity,authority:f.input.authority,pins:f.input.pins,policy:f.input.policy,nativeLimitsDigest:digest(f.input.limits),frameInputDigest:f.input.frame.envelope.inputDigest});f.source.originDigest=f.capture.originDigest;f.event.payload.pinsDigest=digest(f.input.pins);const {payloadDigest:_oldDigest,...eventBody}=f.event;void _oldDigest;f.event.payloadDigest=digest(eventBody);
    const memory=testMemory(maxBytes),journal=new Ctor(f.db,f.configuration,memory),baseline=memory.available(),ports=journal.portsFor(f.peer);
    let resolve:(v:{allowed:boolean;ack:unknown})=>void=()=>{};const originalAck={eventId:f.event.eventId,payloadDigest:f.event.payloadDigest,sourceDigest:digest(f.source)};
    f.decision.mockImplementation(()=>new Promise(yes=>{resolve=yes;}));
    const first=ports.journal.appendOriginal(f.capture,f.event,f.source);for(let n=0;n<8;n++)await Promise.resolve();
    expect(memory.available()).toBeLessThan(baseline);
    await expect(ports.journal.appendOriginal(f.capture,f.event,f.source)).rejects.toThrow();expect(f.decision).toHaveBeenCalledTimes(1);
    let closed=false;const close=journal.close().then(()=>{closed=true;});for(let n=0;n<8;n++)await Promise.resolve();expect(closed).toBe(false);expect(memory.available()).toBeLessThan(baseline);
    resolve({allowed:true,ack:originalAck});await expect(first).resolves.toEqual(originalAck);await close;expect(closed).toBe(true);expect(memory.available()).toBe(maxBytes);
  });
});

describe('W3-A 소수 좌표의 NativeJob 원 계약 보존',()=>{
  it('정수 Windows 기록과 소수 NativeJob metadata의 원 digest를 구분한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),envelope=createNativeJob('POLYGON_MASK',f.configuration.capacity.profile.nativeProfileDigest,{profile:syntheticProfile,width:4,height:4,polygons:[[{x:0.25,y:0.5},{x:3.5,y:0.25},{x:3.75,y:3.5}]]},new Map(),{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
    f.input.frame={envelope,blobs:new Map()};f.input.identity={...f.input.identity,binding:{...f.input.identity.binding,jobId:envelope.jobId,inputDigest:envelope.inputDigest}};
    f.capture.origin={identity:f.input.identity,authority:f.input.authority,pins:f.input.pins,policy:f.input.policy,limits:f.input.limits};f.capture.frameInputDigest=envelope.inputDigest;f.capture.originDigest=digest({identity:f.input.identity,authority:f.input.authority,pins:f.input.pins,policy:f.input.policy,nativeLimitsDigest:digest(f.input.limits),frameInputDigest:envelope.inputDigest});
    f.decision.mockResolvedValueOnce({allowed:true,created:true,capture:f.capture});
    await expect(new Ctor(f.db,f.configuration,testMemory(f.configuration.limits.parentInFlightBytes)).portsFor(f.peer).original.captureFresh(f.input)).resolves.toEqual({created:true,capture:f.capture});
    const inputCanonical=(f.decision.mock.calls[0][2] as string[])[2];expect(inputCanonical).toContain('0.25');expect(inputCanonical).toContain('3.75');
  });
});

describe('W3-A 사본 생성 전 공유 예산 확보',()=>{
  it('공유 예산이 소진된 생성자는 configuration 사본을 만들지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),memory=testMemory(f.configuration.limits.parentInFlightBytes),release=memory.hold(memory.maxBytes);let copies=0;
    codecAudit.before=()=>{copies++;};
    try{expect(()=>new Ctor(f.db,f.configuration,memory)).toThrow();expect(copies).toBe(0);expect(f.decision).not.toHaveBeenCalled();}
    finally{codecAudit.before=undefined;release();}
  });
  it('원 event의 추가 문자열을 만들기 전에 남은 예산을 확보한다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),memory=testMemory(f.configuration.limits.parentInFlightBytes),journal=new Ctor(f.db,f.configuration,memory);let copies=0,release:(()=>void)|undefined;
    codecAudit.before=value=>{if(value&&typeof value==='object'&&(value as {eventId?:string}).eventId===f.event.eventId&&'payloadDigest'in value){copies++;if(copies===1)release=memory.hold(memory.available());}};
    try{await expect(journal.portsFor(f.peer).journal.appendOriginal(f.capture,f.event,f.source)).rejects.toThrow();expect(copies).toBe(1);expect(f.decision).not.toHaveBeenCalled();}
    finally{codecAudit.before=undefined;release?.();await journal.close();expect(memory.available()).toBe(memory.maxBytes);}
  });
  it('COMMIT 뒤 예산 소진 시 원 응답을 다시 복제하거나 부모로 인계하지 않는다',async()=>{
    const Ctor=await journalConstructor(),f=specimen(),memory=testMemory(f.configuration.limits.parentInFlightBytes),journal=new Ctor(f.db,f.configuration,memory);let copies=0,release:(()=>void)|undefined;
    const response={allowed:true,ack:{eventId:f.event.eventId,payloadDigest:f.event.payloadDigest,sourceDigest:digest(f.source)}};
    f.decision.mockImplementation(async(_account,_query,_values,check)=>{if(typeof check==='function')check(response);release=memory.hold(memory.available());codecAudit.before=()=>{copies++;};return response;});
    try{await expect(journal.portsFor(f.peer).journal.appendOriginal(f.capture,f.event,f.source)).rejects.toThrow();expect(copies).toBe(0);expect(f.decision).toHaveBeenCalledTimes(1);}
    finally{codecAudit.before=undefined;release?.();await journal.close();expect(memory.available()).toBe(memory.maxBytes);}
  });
});
