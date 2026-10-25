import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeController,type NativeJobEvidence} from '../../packages/native/src/controller.js';
import {NativeJobError,type NativeLimits} from '../../packages/native/src/dto.js';
import type {OwnedNativeIsolation} from '../../packages/native/src/isolation.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {DomainError} from '../../packages/contracts/src/errors.js';

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:2*1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16*1024*1024};
const input=()=>({task:'DECODE_IMAGE' as const,metadata:{profile:syntheticProfile,sourceBlobId:'source'},blobs:new Map([['source',Buffer.from('not an image')]])});
async function evidence(root:string):Promise<NativeJobEvidence>{const names=await readdir(root);expect(names).toHaveLength(1);return JSON.parse(await readFile(path.join(root,names[0],'evidence.json'),'utf8')) as NativeJobEvidence;}

describe('fixed native child and ownership fences',()=>{
  it('captures the profile and limits so callers cannot activate or enlarge them after construction',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-immutable-options-')),profile={...syntheticProfile},capturedLimits={...limits,parentInFlightBytes:10};
    const runner=NativeController.owned({profile,limits:capturedLimits,directoryRoot:root}),item=input();
    profile.kind='MEASURED';profile.id='changed-after-construction';capturedLimits.parentInFlightBytes=limits.parentInFlightBytes;
    await expect(runner.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});
    await expect(runner.run(item.task,{...item.metadata,profile},item.blobs)).rejects.toMatchObject({code:'NATIVE_PROFILE_MISMATCH'});
    expect(await readdir(root)).toEqual([]);await runner.idle();
  });
  it('refuses measured production through owned isolation, missing bounds and new work after shutdown',()=>{expect(()=>NativeController.owned({profile:{...syntheticProfile,kind:'MEASURED'},limits})).toThrow('NATIVE_HOST_UNCONFIRMED');expect(()=>NativeController.owned({profile:syntheticProfile,limits:{...limits,childMemoryBytes:0}})).toThrow('NATIVE_LIMIT_UNCONFIRMED');const runner=NativeController.owned({profile:syntheticProfile,limits});runner.stopClaims();const item=input();expect(()=>runner.run(item.task,item.metadata,item.blobs)).toThrow('NATIVE_SHUTDOWN_WAIT');});
  it('refuses profile or transfer budget before creating an attempt',async()=>{const root=await mkdtemp(path.join(tmpdir(),'trio-native-refusal-'));const runner=NativeController.owned({profile:syntheticProfile,limits:{...limits,parentInFlightBytes:10},directoryRoot:root});const item=input();await expect(runner.run(item.task,{...item.metadata,profile:{...syntheticProfile,id:'different'}},item.blobs)).rejects.toMatchObject({code:'NATIVE_PROFILE_MISMATCH'});await expect(runner.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});expect(await readdir(root)).toEqual([]);});
  it('keeps the child in WAIT when membership is refused and preserves the termination evidence',async()=>{const root=await mkdtemp(path.join(tmpdir(),'trio-native-membership-'));let attached=0,killed=0;const backend:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>({attach:async()=>{attached++;throw new DomainError('NATIVE_MEMBERSHIP_UNCONFIRMED',409,'WAIT');},killSubtree:async()=>{killed++;},empty:async()=>false,close:async()=>{throw new Error('no subtree proof');}})};const runner=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation:backend});const item=input();await expect(runner.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_MEMBERSHIP_UNCONFIRMED'});await runner.idle();const record=await evidence(root);expect(attached).toBe(1);expect(killed).toBeGreaterThan(0);expect(record.startedComputation).toBe(false);expect(record.directChildClosed).toBe(true);expect(record.subtreeTerminationConfirmed).toBe(false);expect(record.state).toBe('FAILED');});
  it('applies the deadline while attachment is pending and keeps idle waiting until the late operation joins',async()=>{const root=await mkdtemp(path.join(tmpdir(),'trio-native-timeout-'));let attached=false;const backend:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>({attach:async()=>{attached=true;await delay(2000);},killSubtree:async()=>{},empty:async()=>false,close:async()=>{}})};const runner=NativeController.owned({profile:syntheticProfile,limits:{...limits,timeoutMs:1000},directoryRoot:root,isolation:backend});const item=input();const error=await runner.run(item.task,item.metadata,item.blobs).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_JOB_TIMEOUT');expect(error.termination).toMatchObject({operationJoined:false,startedComputation:false,subtreeTerminationConfirmed:false,kind:'UNCONFIRMED'});expect(Object.isFrozen(error.termination)).toBe(true);expect(attached).toBe(true);let idleFinished=false;runner.stopClaims();const idle=runner.idle().then(()=>{idleFinished=true;});await delay(50);expect(idleFinished).toBe(false);await idle;const record=await evidence(root);expect(record.code).toBe('NATIVE_JOB_TIMEOUT');expect(record.startedComputation).toBe(false);expect(record.subtreeTerminationConfirmed).toBe(false);});
  it('retains the parent budget and tracks a boundary created after the timeout before releasing it',async()=>{const root=await mkdtemp(path.join(tmpdir(),'trio-native-create-'));let releaseCreate!:()=>void,entered=false,killed=0,attached=0;const pending=new Promise<void>(resolve=>{releaseCreate=resolve;});const backend:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>{entered=true;await pending;return {attach:async()=>{attached++;},killSubtree:async()=>{killed++;},empty:async()=>false,close:async()=>{}};}};const item=input(),held=2*item.blobs.get('source')!.length+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32;const runner=NativeController.owned({profile:syntheticProfile,limits:{...limits,timeoutMs:1000,parentInFlightBytes:held},directoryRoot:root,isolation:backend});const error=await runner.run(item.task,item.metadata,item.blobs).catch(error=>error);expect(entered).toBe(true);expect(error).toBeInstanceOf(NativeJobError);expect(error.termination.kind).toBe('UNCONFIRMED');await expect(runner.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});let idleFinished=false;runner.stopClaims();const idle=runner.idle().then(()=>{idleFinished=true;});await delay(50);expect(idleFinished).toBe(false);releaseCreate();await idle;expect(attached).toBe(0);expect(killed).toBeGreaterThan(0);const names=await readdir(root);const termination=JSON.parse(await readFile(path.join(root,names[0],'termination.json'),'utf8'));expect(termination).toMatchObject({operationJoined:true,kind:'NO_CHILD_CREATED',startedComputation:false});expect(error.termination.kind).toBe('UNCONFIRMED');});
  it('preserves termination facts and an existing file when writing evidence is refused',async()=>{const root=await mkdtemp(path.join(tmpdir(),'trio-native-audit-'));const backend:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>({attach:async()=>{const names=await readdir(root);await writeFile(path.join(root,names[0],'evidence.json'),'owned prior evidence',{flag:'wx'});throw new DomainError('NATIVE_MEMBERSHIP_UNCONFIRMED',409,'WAIT');},killSubtree:async()=>{},empty:async()=>false,close:async()=>{}})};const runner=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation:backend}),item=input();const error=await runner.run(item.task,item.metadata,item.blobs).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_EVIDENCE_UNCONFIRMED');expect(error.termination).toMatchObject({operationJoined:true,directChildClosed:true,startedComputation:false,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'});await runner.idle();const names=await readdir(root);expect(await readFile(path.join(root,names[0],'evidence.json'),'utf8')).toBe('owned prior evidence');});
  it('withholds Linux production while privileged controller and code/secret ownership are unconfirmed',async()=>{await expect(NativeController.linux({profile:{...syntheticProfile,kind:'MEASURED'},limits,cgroupRoot:'/sys/fs/cgroup/owned-unused',childUid:1000,childGid:1000})).rejects.toMatchObject({code:'NATIVE_RESOURCE_CONTROLLER_UNCONFIRMED'});});
});


import {vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {createNativeJob,createNativeResult,type NativeJob} from '../../packages/native/src/dto.js';
import {digest} from '../../packages/contracts/src/intent.js';
import {writeNativeFrame} from '../../packages/native/src/frame.js';
import type {NativeChildLifecycleObservation} from '../../packages/native/src/controller.js';

type P01DChild=EventEmitter&{pid:number|undefined;stdin:Writable;stdout:PassThrough;stderr:PassThrough;kill:(signal?:NodeJS.Signals)=>boolean};
type P01DControl={mode?:'SYNC_ERROR'|'ASYNC_ERROR'|'CLOSE_ONLY';pid?:number|null;observer?:boolean;observe?:(value:NativeChildLifecycleObservation)=>void;goRefused?:boolean;lateClose?:boolean;duplicateEvents?:boolean;changedPid?:number;exit?:{code:number|null;signal:NodeJS.Signals|null};fixedClock?:boolean;capacity?:number};

async function p01dFakeChild(control:P01DControl,check:(context:{
  runner:NativeController;events:NativeChildLifecycleObservation[];jobs:NativeJob[];children:P01DChild[];root:string;
  run:(original?:NativeJob)=>Promise<{metadata:Record<string,unknown>;blobs:Map<string,Buffer>}>;
  attached:Promise<void>;releaseAttachment:()=>void;close:(child:P01DChild,code:number|null,signal:NodeJS.Signals|null)=>void;
  goCalls:()=>number;spawnCalls:()=>number;
})=>Promise<void>){
  // 새 검사 안에서만 실제 포트를 거부하고 종료 시 원래 상태로 복원한다.
  const builtin=process.getBuiltinModule('child_process') as unknown as Record<string,unknown>;
  const processMethods=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
  const descriptors=new Map(processMethods.map(key=>[key,Object.getOwnPropertyDescriptor(builtin,key)!]));
  const forbidden:string[]=[],events:NativeChildLifecycleObservation[]=[],jobs:NativeJob[]=[],children:P01DChild[]=[];
  const rejectReal=(port:string)=>(..._args:unknown[])=>{forbidden.push(port);throw new Error('P01D_REAL_PORT_FORBIDDEN:'+port);};
  let runner:NativeController|undefined,goCalls=0,spawnCalls=0,mockLoads=0;
  let releaseAttachment!:()=>void,markAttached!:()=>void;
  const gate=new Promise<void>(resolve=>{releaseAttachment=resolve;}),attached=new Promise<void>(resolve=>{markAttached=resolve;});
  const closed=new WeakSet<P01DChild>();
  const close=(child:P01DChild,code:number|null,signal:NodeJS.Signals|null)=>{
    if(closed.has(child))return;closed.add(child);child.stdout.end();child.stderr.end();
    child.emit('close',code,signal);if(control.duplicateEvents)child.emit('close',code,signal);
  };
  const fakeSpawn=()=>{
    spawnCalls++;if(control.mode==='SYNC_ERROR')throw new Error('P01D_FAKE_SYNC_SPAWN_FAILURE');
    const child=Object.assign(new EventEmitter(),{
      pid:control.pid===null?undefined:control.pid??63001,stdout:new PassThrough(),stderr:new PassThrough(),
      stdin:undefined as unknown as Writable,
      kill:(_signal?:NodeJS.Signals)=>{if(!control.lateClose)queueMicrotask(()=>close(child,null,'SIGKILL'));return !closed.has(child);},
    }) as P01DChild;
    children.push(child);
    child.stdin=new Writable({
      write(chunk:Buffer,_encoding,done){
        if(chunk.equals(Buffer.from('GO_V1\n'))){if(control.changedPid!==undefined)child.pid=control.changedPid;child.stdout.write(Buffer.from('READY_V1\n'));}
        done();
      },
      final(done){
        void (async()=>{
          const chunks:Buffer[]=[],sink=new Writable({write(chunk:Buffer,_encoding,accepted){chunks.push(Buffer.from(chunk));accepted();}});
          const job=jobs[jobs.length-1],bounds={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxOutputBytes,maxItems:limits.maxItems};
          const result=createNativeResult(job,{metadata:{p01dFakeReply:true},blobs:new Map()},bounds);
          await writeNativeFrame(sink,{envelope:result,blobs:new Map()},bounds);sink.end();child.stdout.end(Buffer.concat(chunks));
          const exit=control.exit??{code:0,signal:null};queueMicrotask(()=>close(child,exit.code,exit.signal));
        })().then(()=>done(),error=>done(error instanceof Error?error:new Error('P01D_FAKE_FRAME')));
      },
    });
    queueMicrotask(()=>{
      if(control.mode==='ASYNC_ERROR'){child.emit('error',new Error('P01D_FAKE_ASYNC_SPAWN_FAILURE'));close(child,-2,null);return;}
      if(control.mode==='CLOSE_ONLY'){close(child,0,null);return;}
      child.emit('spawn');if(control.duplicateEvents)child.emit('spawn');child.stdout.write(Buffer.from('WAIT_V1\n'));
    });
    return child;
  };
  try{
    for(const key of processMethods)Object.defineProperty(builtin,key,{...descriptors.get(key),value:rejectReal(key)});
    syncBuiltinESMExports();
    vi.spyOn(globalThis,'fetch').mockImplementation(rejectReal('fetch'));
    if(control.fixedClock)vi.spyOn(performance,'now').mockReturnValue(100);
    vi.resetModules();
    vi.doMock('node:child_process',()=>{mockLoads++;return {...builtin,spawn:fakeSpawn};});
    const scoped=await import('../../packages/native/src/controller.js');
    const errors=await import('../../packages/contracts/src/errors.js');
    expect(scoped.NativeController).not.toBe(NativeController);
    expect((await import('node:child_process')).spawn).toBe(fakeSpawn);expect(mockLoads).toBe(1);
    const root=await mkdtemp(path.join(tmpdir(),'trio-p01d-child-fake-'));
    const selected={...limits,...(control.lateClose?{timeoutMs:50,terminationWaitMs:15}:{}),...(control.capacity===undefined?{}:{parentInFlightBytes:control.capacity})};
    const options={profile:syntheticProfile,limits:selected,directoryRoot:root,
      observeChild:control.observer===false?undefined:(value:NativeChildLifecycleObservation)=>{events.push(value);control.observe?.(value);},
      isolation:{kind:'OWNED_FIXTURE' as const,create:async()=>({
        attach:async()=>{markAttached();if(control.lateClose)await gate;},killSubtree:async()=>{},empty:async()=>false,close:async()=>{},
      })},
    };
    runner=scoped.NativeController.owned(options);
    const hooks={intent:async(job:NativeJob)=>{jobs.push(structuredClone(job));},consumeGo:async()=>{goCalls++;if(control.goRefused)throw new errors.DomainError('P01D_FAKE_GO_REFUSED',409,'WAIT');},
      observation:async()=>{},termination:async()=>{}};
    const run=(original?:NativeJob)=>{const value=input();return original?runner!.runCaptured(original,value.blobs,hooks):runner!.run(value.task,value.metadata,value.blobs,hooks);};
    await check({runner,events,jobs,children,root,run,attached,releaseAttachment,close,goCalls:()=>goCalls,spawnCalls:()=>spawnCalls});
  }finally{
    releaseAttachment();for(const child of children)close(child,null,'SIGKILL');
    try{runner?.stopClaims();await runner?.idle();}
    finally{
      vi.doUnmock('node:child_process');vi.resetModules();vi.restoreAllMocks();
      for(const [key,descriptor]of descriptors)Object.defineProperty(builtin,key,descriptor);syncBuiltinESMExports();
      for(const [key,descriptor]of descriptors)expect(Object.getOwnPropertyDescriptor(builtin,key)).toEqual(descriptor);
      expect(forbidden).toEqual([]);
    }
  }
}

describe.sequential('P01D child observation',()=>{
  it('원 captured job과 부모·PID를 생성 및 종료 사건에 정확히 연결한다',async()=>{
    const value=input(),original=createNativeJob(value.task,digest(syntheticProfile),value.metadata,value.blobs,{maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems});
    await p01dFakeChild({},async context=>{
      const before=performance.now();await expect(context.run(original)).resolves.toEqual({metadata:{p01dFakeReply:true},blobs:new Map()});const after=performance.now();
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);
      const fields=['version','event','eventId','jobId','inputDigest','profileDigest','parentInstanceId','pid','observedMonotonicMs','exitCode','signal'].sort();
      for(const item of context.events){
        expect(Object.keys(item).sort()).toEqual(fields);expect(Object.isFrozen(item)).toBe(true);
        expect(item).toMatchObject({version:1,jobId:original.jobId,inputDigest:original.inputDigest,profileDigest:original.profileDigest,parentInstanceId:context.runner.parentInstanceId,pid:63001});
        expect(item.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(item.observedMonotonicMs).toBeGreaterThanOrEqual(before);expect(item.observedMonotonicMs).toBeLessThanOrEqual(after);
      }
      expect(context.events[0]).toMatchObject({exitCode:null,signal:null});expect(context.events[1]).toMatchObject({exitCode:0,signal:null});
      expect(context.events[1].observedMonotonicMs).toBeGreaterThanOrEqual(context.events[0].observedMonotonicMs);
      expect(new Set(context.events.map(item=>item.eventId)).size).toBe(2);expect(context.spawnCalls()).toBe(1);expect(context.goCalls()).toBe(1);
      expect(await evidence(context.root)).toMatchObject({state:'SUCCEEDED',goAttempted:true,startedComputation:true,subtreeTerminationConfirmed:false});
    });
  });
  it('spawn 반환만으로 사건을 만들지 않고 성공 이벤트를 기다린다',async()=>{
    await p01dFakeChild({mode:'CLOSE_ONLY'},async context=>{
      await expect(context.run()).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRUNCATED'});expect(context.events).toEqual([]);expect(context.goCalls()).toBe(0);
    });
  });
  it.each(['SYNC_ERROR','ASYNC_ERROR'] as const)('%s 생성 실패에는 수명주기 사건을 만들지 않는다',async mode=>{
    await p01dFakeChild({mode,pid:null},async context=>{
      await expect(context.run()).rejects.toMatchObject({code:mode==='SYNC_ERROR'?'NATIVE_JOB_FAILED':'NATIVE_PROTOCOL_TRUNCATED'});
      expect(context.events).toEqual([]);expect(context.spawnCalls()).toBe(1);expect(context.goCalls()).toBe(0);
    });
  });
  it.each([null,0,-1,1.5,Number.NaN])('유효하지 않은 PID %s를 관측하지 않는다',async pid=>{
    await p01dFakeChild({pid},async context=>{
      if(pid===null||pid===0||Number.isNaN(pid))await expect(context.run()).rejects.toMatchObject({code:'NATIVE_BOOTSTRAP_INVALID'});else await context.run();
      expect(context.events).toEqual([]);expect(context.spawnCalls()).toBe(1);
    });
  });
  it('GO 거부 뒤 생성·종료 진단이 계산 시작이나 종료 권위가 되지 않는다',async()=>{
    await p01dFakeChild({goRefused:true},async context=>{
      await expect(context.run()).rejects.toMatchObject({code:'P01D_FAKE_GO_REFUSED',termination:{goAttempted:false,startedComputation:false,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'}});
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);expect(context.events[1]).toMatchObject({exitCode:null,signal:'SIGKILL'});
    });
  });
  it.each([{code:7,signal:null},{code:null,signal:'SIGTERM' as const}])('원 close 값 $code/$signal을 실패 판정과 함께 보존한다',async exit=>{
    await p01dFakeChild({exit},async context=>{
      await expect(context.run()).rejects.toMatchObject({code:'NATIVE_JOB_FAILED'});
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);expect(context.events[1]).toMatchObject({exitCode:exit.code,signal:exit.signal});
    });
  });
  it('중복 이벤트·종료 재대조에서 새 사건을 재생성하지 않는다',async()=>{
    await p01dFakeChild({duplicateEvents:true},async context=>{
      await context.run();const ids=context.events.map(item=>item.eventId);await context.runner.reconcileTerminations();await context.runner.reconcileTerminations();
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);expect(context.events.map(item=>item.eventId)).toEqual(ids);expect(context.spawnCalls()).toBe(1);
    });
  });
  it('생성 뒤 child 객체 PID가 바뀌어도 원 PID와 job을 보존한다',async()=>{
    await p01dFakeChild({changedPid:73001},async context=>{
      await context.run();expect(context.children[0].pid).toBe(73001);expect(context.events.map(item=>item.pid)).toEqual([63001,63001]);
      expect(context.events[0].jobId).toBe(context.jobs[0].jobId);expect(context.events[1].jobId).toBe(context.jobs[0].jobId);
    });
  });
  it('같은 PID를 재사용한 다음 작업의 원 job·사건을 섞지 않는다',async()=>{
    await p01dFakeChild({},async context=>{
      await context.run();await context.run();expect(context.events).toHaveLength(4);
      expect(context.events.map(item=>item.jobId)).toEqual([context.jobs[0].jobId,context.jobs[0].jobId,context.jobs[1].jobId,context.jobs[1].jobId]);
      expect(context.jobs[0].jobId).not.toBe(context.jobs[1].jobId);expect(new Set(context.events.map(item=>item.eventId)).size).toBe(4);expect(context.spawnCalls()).toBe(2);
    });
  });
  it('observer의 변조 시도와 동기 예외가 원 결과·관측·종료를 바꾸지 않는다',async()=>{
    const mutationResults:boolean[]=[];
    await p01dFakeChild({observe:value=>{mutationResults.push(Reflect.set(value,'jobId','untrusted'));throw new Error('P01D_FAKE_OBSERVER_FAILURE');}},async context=>{
      await expect(context.run()).resolves.toMatchObject({metadata:{p01dFakeReply:true}});expect(mutationResults).toEqual([false,false]);
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);
      expect(context.events.every(item=>item.jobId===context.jobs[0].jobId)).toBe(true);
      expect(await evidence(context.root)).toMatchObject({state:'SUCCEEDED',code:'OK',subtreeTerminationConfirmed:false});
    });
  });
  it('observer가 없을 때 동일 원 job의 기존 반환·증거 파일을 보존한다',async()=>{
    const value=input(),original=createNativeJob(value.task,digest(syntheticProfile),value.metadata,value.blobs,{maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems});
    const run=async(observer:boolean)=>{
      let result:unknown;await p01dFakeChild({observer,fixedClock:true},async context=>{
        const output=await context.run(original);await context.runner.idle();const names=await readdir(context.root);
        result={output,evidence:await readFile(path.join(context.root,names[0],'evidence.json'),'utf8'),termination:await readFile(path.join(context.root,names[0],'termination.json'),'utf8')};
        expect(context.events).toHaveLength(observer?2:0);
      });return result;
    };
    expect(await run(true)).toEqual(await run(false));
  });
  it('실행 전 용량 거부는 실제·가짜 spawn과 사건을 모두 만들지 않는다',async()=>{
    await p01dFakeChild({capacity:10},async context=>{
      await expect(context.run()).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});
      expect(context.spawnCalls()).toBe(0);expect(context.events).toEqual([]);expect(await readdir(context.root)).toEqual([]);
    });
  });
  it('timeout 뒤 늦은 close를 원 작업에 한 번 연결하고 idle·보류 사실을 보존한다',async()=>{
    await p01dFakeChild({lateClose:true},async context=>{
      const pending=context.run().catch(error=>error);await context.attached;const failure=await pending;
      expect(failure).toMatchObject({code:'NATIVE_JOB_TIMEOUT',termination:{operationJoined:false,kind:'UNCONFIRMED',subtreeTerminationConfirmed:false}});
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED']);
      let idleFinished=false;context.runner.stopClaims();const idle=context.runner.idle().then(()=>{idleFinished=true;});await delay(0);expect(idleFinished).toBe(false);
      context.releaseAttachment();context.close(context.children[0],null,'SIGKILL');await idle;
      expect(context.events.map(item=>item.event)).toEqual(['SPAWNED','CLOSED']);expect(context.events[1]).toMatchObject({jobId:context.jobs[0].jobId,pid:63001,exitCode:null,signal:'SIGKILL'});
      const ids=context.events.map(item=>item.eventId);await context.runner.reconcileTerminations();expect(context.events.map(item=>item.eventId)).toEqual(ids);
      expect(failure.termination).toMatchObject({operationJoined:false,kind:'UNCONFIRMED'});expect(context.goCalls()).toBe(0);
      expect(await evidence(context.root)).toMatchObject({code:'NATIVE_JOB_TIMEOUT',startedComputation:false,subtreeTerminationConfirmed:false});
    });
  });
});

import {randomUUID} from 'node:crypto';
import {NativeControllerAttempts,createNativeControllerMemory,type NativeOriginalAttemptV2} from '../../packages/native/src/controller-attempts.js';
import {createWindowsOriginalController,type WindowsControllerJournalPort} from '../../packages/native/src/controller.js';
import {writeNativeControllerRequest,type NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
it('W4-B1 원 QUERY requestId와 전체 control digest를 framed 서버에서 raw store까지 보존한다',async()=>{
  const frameLimits={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems};
  const blobs=new Map([['source',Buffer.from('가짜 원 입력')]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'a.bin',blobId:'source'}]},blobs,frameLimits);
  const binding:NativeControllerBinding={accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:'c'.repeat(64)};
  const result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:1},blobs:new Map([['archive',Buffer.from([1])]])},frameLimits);
  const attempt:NativeOriginalAttemptV2={binding,job,snapshot:{version:2,attemptId:randomUUID(),controllerInstanceId:randomUUID(),phase:'GO_GRANTED',rawResult:{rawResultId:randomUUID(),resultDigest:digest(result)},termination:{jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY'},windowsEvidenceRef:{recordId:randomUUID(),recordDigest:'a'.repeat(64),linkId:randomUUID(),linkDigest:'b'.repeat(64)},code:'OK'}};
  const memory=createNativeControllerMemory(64*1024*1024),readExisting=vi.fn(async()=>null),forbidden=async()=>{throw new Error('W4B1_NEW_NATIVE_WORK_FORBIDDEN');};
  const journal:WindowsControllerJournalPort={controllerInstanceId:attempt.snapshot.controllerInstanceId,profileDigest:job.profileDigest,kernelImplementationDigest:binding.kernelDigest,limits,memory,loadOriginal:async()=>attempt,offerOriginal:forbidden,portsFor:()=>{throw new Error('W4B1_NEW_NATIVE_WORK_FORBIDDEN');},readyOriginal:forbidden,parentJoinedOriginal:forbidden,finishOriginal:forbidden,readOriginal:forbidden,close:async()=>{}};
  const controller=createWindowsOriginalController({journal,raw:{allocate:forbidden,putOriginal:forbidden,readExisting},broker:{open:forbidden,readOriginal:forbidden},clock:{nowMs:()=>0,startWait:()=>{throw new Error('W4B1_NATIVE_WAIT_FORBIDDEN');}}});
  const who={serviceRole:'trio_web_worker' as const,peerId:randomUUID()},attempts=new NativeControllerAttempts(controller,{authenticate:async()=>who},{maxControlBytes:8192,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});
  const control={version:2 as const,requestId:randomUUID(),binding,command:'QUERY' as const,includeRawResult:true},wire={maxControlBytes:8192,input:controller.frameLimits('input'),output:controller.frameLimits('output')},encoded:Buffer[]=[];
  const sink=(write:(bytes:Buffer)=>void)=>new Writable({write:(chunk:Buffer,_encoding,done)=>{write(chunk);done();}});
  await writeNativeControllerRequest(sink(chunk=>encoded.push(Buffer.from(chunk))),{control},wire);
  try{await attempts.serveFramed({},(async function*(){for(const bytes of encoded)yield bytes;})(),sink(()=>{}));
    expect(readExisting.mock.calls).toEqual([[who,attempt,{purpose:'PARENT_QUERY',requestId:control.requestId,requestDigest:digest(control)}]]);
  }finally{await attempts.idle();expect(memory.available()).toBe(memory.maxBytes);}
});

import {generateKeyPairSync} from 'node:crypto';
import * as w4bControllerStore from '../../packages/domain/src/native-controller-store.js';
import type {WindowsJournalConfiguration} from '../../packages/domain/src/windows-native-journal.js';
import type {NativeControllerDatabase} from '../../packages/storage/src/native-controller-role.js';
import type {WindowsCostedObjectIo,WindowsCostedIoRequest,WindowsCostedIoEvent} from '../../packages/domain/src/windows-native-cost.js';
function w4bRawSpecimen(){
  const key=generateKeyPairSync('ed25519'),nativeLimits={...limits,maxMetadataBytes:4096,maxInputBytes:16384,maxOutputBytes:16384,maxItems:8,parentInFlightBytes:8*1024*1024};
  const controllerId=randomUUID(),controllerInstanceId=randomUUID(),policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const pins={executableDigest:digest('node'),bootstrapDigest:digest('bootstrap'),helperRuntimeDigest:digest('fake-runtime'),helperScriptDigest:digest('fake-helper'),runtimeFilesDigest:digest('fake-files'),nativeLimitsDigest:digest(nativeLimits)};
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'w4b1-domain-v1',maxSlots:2,nativeProfileDigest:digest(syntheticProfile),kernelDigest:digest('kernel'),controllerId,keyVersion:'w4b1-key',environmentDigest:digest('env'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['windows-job:w4b1/domain'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:digest('controller'),childSidDigest:digest('child'),appContainerSidDigest:digest('container')}};
  const configuration:WindowsJournalConfiguration={controllerId,controllerInstanceId,capacity:{reference:{kind:'WINDOWS_JOB_OBJECT',profileId:randomUUID(),profileDigest:digest('SQL-profile'),profileVersion:profile.version},profile},limits:nativeLimits,signer:{keyVersion:profile.keyVersion,publicKeySpki:profile.publicKeySpki,sign:async()=>{throw new Error('W4B1_SIGN_FORBIDDEN');}}};
  const frame={maxMetadataBytes:nativeLimits.maxMetadataBytes,maxBinaryBytes:nativeLimits.maxOutputBytes,maxItems:nativeLimits.maxItems},job=createNativeJob('ZIP_WRITE',profile.nativeProfileDigest,{profile:syntheticProfile,entries:[{name:'a.bin',blobId:'source'}]},new Map([['source',Buffer.from([1])]]),frame);
  const binding:NativeControllerBinding={accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:profile.kernelDigest};
  const rawBytes=Buffer.from([2,3]),result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:2},blobs:new Map([['archive',rawBytes]])},frame),reference={rawResultId:randomUUID(),resultDigest:digest(result)};
  const attempt:NativeOriginalAttemptV2={binding,job,snapshot:{version:2,attemptId:randomUUID(),controllerInstanceId,phase:'GO_GRANTED',rawResult:reference,termination:{jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY'},windowsEvidenceRef:{recordId:randomUUID(),recordDigest:digest('record'),linkId:randomUUID(),linkDigest:digest('link')},code:'OK'}};
  const assetId=randomUUID(),blobRefs=[{assetId,blobId:'archive',sha256:result.blobs[0].sha256,bytesLength:'2'}],allocation={attemptId:attempt.snapshot.attemptId,reference,result},objectKey=binding.accountId+'/'+assetId;
  const receipt={key:objectKey,sha256:result.blobs[0].sha256,bytesLength:'2',completedAt:'2026-10-21T00:00:00.000Z',completedAtPrecisionMilliseconds:1 as const},callRef={callId:randomUUID(),callDigest:digest('call')};
  const control={available:true,joined:false,grant:true,start:true,source:'RETURNED' as 'RETURNED'|'THREW'|'UNCONFIRMED',missingEnd:false,beginAckLost:false},claims=new Map<string,string>();
  const events=new Map<string,WindowsCostedIoEvent>(),requests:WindowsCostedIoRequest[]=[],memory=createNativeControllerMemory(nativeLimits.parentInFlightBytes),who={serviceRole:'trio_web_worker' as const,peerId:randomUUID()};
  const start=(request:WindowsCostedIoRequest):WindowsCostedIoEvent=>{
    let value=events.get(request.operationId);if(!value){const {expected:_expected,...body}=request;void _expected;value={...body,started:{evidenceId:randomUUID(),evidenceDigest:digest('start:'+request.operationId)},ended:null,state:'UNCONFIRMED',observed:null,code:null};events.set(request.operationId,value);}return value;
  };
  const event=(request:WindowsCostedIoRequest):WindowsCostedIoEvent=>{
    const source=start(request),value:WindowsCostedIoEvent={...source,ended:control.source==='UNCONFIRMED'?null:{evidenceId:randomUUID(),evidenceDigest:digest('end:'+request.operationId)},state:control.source,observed:control.source==='RETURNED'?{sha256:receipt.sha256,bytesLength:'2'}:null,code:control.source==='THREW'?'W4B1_OBJECT_THREW':null};events.set(request.operationId,value);return value;
  };
  const reply=<T>(request:WindowsCostedIoRequest,value:T)=>{requests.push(request);const actual=event(request);return actual.state==='RETURNED'?{state:'RETURNED' as const,event:actual,value}:{state:actual.state,event:actual};};
  const ioRead=vi.fn(async(request:WindowsCostedIoRequest)=>reply(request,Buffer.from(rawBytes))),ioReceipt=vi.fn(async(request:WindowsCostedIoRequest)=>reply(request,{...receipt})),ioPut=vi.fn(async(request:WindowsCostedIoRequest,_bytes:Buffer)=>reply(request,{...receipt}));
  const rawIo:WindowsCostedObjectIo={bucket:'w4b1-domain-private',read:ioRead,receipt:ioReceipt,put:ioPut,lookup:async(request)=>events.get(request.operationId)??null};
  const objects={bucket:rawIo.bucket,read:vi.fn(async()=>Buffer.from(rawBytes)),receipt:vi.fn(async()=>({...receipt})),put:vi.fn(async()=>({...receipt})),remove:async()=>{throw new Error('W4B1_DELETE_FORBIDDEN');}};
  const decision=vi.fn(async(_accountId:string,query:string,values:unknown[])=>{
    if(query.includes('claim_result_query')){
      const context=JSON.parse(values[3] as string) as {requestId:string;requestDigest:string;deliveryClaimId:string};
      const previous=claims.get(context.requestId);if(!control.grant||control.joined||previous&&previous!==context.deliveryClaimId)return {allowed:true,authority:null};claims.set(context.requestId,context.deliveryClaimId);
      return {allowed:true,authority:{version:1,requestId:context.requestId,requestDigest:context.requestDigest,deliveryClaimId:context.deliveryClaimId,callRef,binding,attemptId:attempt.snapshot.attemptId,controllerInstanceId,peerService:who.serviceRole,peerId:who.peerId}};
    }
    if(query.includes('raw_lookup'))return {allowed:true,available:control.available&&!control.joined,allocation,blobRefs,callRef};
    if(query.includes('controller_io_begin')){const request=JSON.parse(values[3] as string) as WindowsCostedIoRequest;if(!control.start||control.joined)return {allowed:true,event:null};const value=start(request);if(control.beginAckLost){control.beginAckLost=false;throw new Error('W4B1_START_COMMIT_ACK_LOST');}return {allowed:true,event:value};}
    if(query.includes('controller_io_lookup')){const request=JSON.parse(values[3] as string) as WindowsCostedIoRequest;return {allowed:true,event:control.missingEnd?null:events.get(request.operationId)??null};}
    if(query.includes('allocate_raw'))return {allowed:true,created:true,allocation,blobRefs};
    if(query.includes('register_raw_object'))return {allowed:true};
    throw new Error('W4B1_UNEXPECTED_SQL:'+query);
  });
  const db={decision} as unknown as NativeControllerDatabase;
  const open=()=>w4bControllerStore.createCostedWindowsControllerPorts({db,configuration,rawIo,bucketRef:rawIo.bucket,memory});
  return {open,rawIo,objects,decision,ioRead,ioReceipt,ioPut,who,attempt,configuration,db,memory,events,requests,allocation,blobRefs,receipt,callRef,objectKey,event,control,start};
}
it('W4-B1 비용형 raw context 누락은 원 객체가 존재해도 GET0으로 거부한다',async()=>{
  const f=w4bRawSpecimen(),ports=f.open();
  try{expect(await ports.raw.readExisting(f.who,f.attempt)).toBeNull();expect(f.ioRead).not.toHaveBeenCalled();expect(f.objects.read).not.toHaveBeenCalled();expect(f.decision).not.toHaveBeenCalled();}
  finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});

const w4bQueryContext=()=>({purpose:'PARENT_QUERY' as const,requestId:randomUUID(),requestDigest:digest('원 QUERY control')});
it('W4-B1 원 raw QUERY는 한 delivery claim으로 START 후 receipt/read END를 확인하고 재전송 GET0이다',async()=>{
  const f=w4bRawSpecimen(),ports=f.open(),context=w4bQueryContext();
  try{
    const result=await ports.raw.readExisting(f.who,f.attempt,context);expect(result?.blobs.get('archive')).toEqual(Buffer.from([2,3]));expect(f.requests.map(r=>r.kind)).toEqual(['OBJECT_RECEIPT','OBJECT_READ']);expect(new Set(f.requests.map(r=>r.operationId)).size).toBe(2);
    const queries=f.decision.mock.calls,claim=JSON.parse(queries.find(q=>q[1].includes('claim_result_query'))![2][3] as string);
    expect(claim).toMatchObject({...context,authenticatedPeerId:f.who.peerId});expect(Object.keys(claim).sort()).toEqual(['purpose','requestId','requestDigest','deliveryClaimId','authenticatedPeerId'].sort());expect(claim.deliveryClaimId).toMatch(/^[a-f0-9-]{36}$/);
    const rawChecks=queries.filter(q=>q[1].includes('cost_raw_lookup'));expect(rawChecks).toHaveLength(2);expect(rawChecks.every(q=>JSON.parse(q[2][4] as string).deliveryClaimId===claim.deliveryClaimId)).toBe(true);
    for(const request of f.requests){const event=f.events.get(request.operationId)!;expect(event).toMatchObject({state:'RETURNED',call:f.callRef});expect(event.started.evidenceId).not.toBe(event.ended!.evidenceId);}
    expect(await ports.raw.readExisting(f.who,f.attempt,context)).toBeNull();expect(f.ioRead).toHaveBeenCalledTimes(1);expect(f.ioReceipt).toHaveBeenCalledTimes(1);expect(f.objects.read).not.toHaveBeenCalled();
  }finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});
it.each(['GRANT','JOINED','START'] as const)('W4-B1 %s 거부는 등록된 원 ref가 있어도 rawIo 시작0이다',async reason=>{
  const f=w4bRawSpecimen(),ports=f.open();if(reason==='GRANT')f.control.grant=false;else if(reason==='JOINED')f.control.joined=true;else f.control.start=false;
  try{const run=ports.raw.readExisting(f.who,f.attempt,w4bQueryContext());if(reason==='START')await expect(run).rejects.toMatchObject({nextAction:'WAIT'});else expect(await run).toBeNull();expect(f.ioRead).not.toHaveBeenCalled();expect(f.ioReceipt).not.toHaveBeenCalled();}
  finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});
it.each(['THREW','UNCONFIRMED','END_MISSING'] as const)('W4-B1 객체 %s는 존재 receipt를 종료 근거로 대신하지 않고 WAIT한다',async state=>{
  const f=w4bRawSpecimen(),ports=f.open();if(state==='END_MISSING')f.control.missingEnd=true;else f.control.source=state;
  try{await expect(ports.raw.readExisting(f.who,f.attempt,w4bQueryContext())).rejects.toMatchObject({nextAction:'WAIT'});expect(f.ioReceipt).toHaveBeenCalledTimes(1);expect(f.ioRead).not.toHaveBeenCalled();expect(f.ioPut).not.toHaveBeenCalled();}
  finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});
it('W4-B1 controller START COMMIT ACK 유실은 같은 operationId의 DB lookup 뒤에만 I/O 하나를 시작한다',async()=>{
  const f=w4bRawSpecimen(),ports=f.open();f.control.beginAckLost=true;
  try{expect((await ports.raw.readExisting(f.who,f.attempt,w4bQueryContext()))?.blobs.size).toBe(1);expect(f.ioRead).toHaveBeenCalledTimes(1);expect(f.ioReceipt).toHaveBeenCalledTimes(1);
    const queries=f.decision.mock.calls,begin=queries.find(q=>q[1].includes('controller_io_begin'))!,lookup=queries.find(q=>q[1].includes('controller_io_lookup'))!;expect(lookup[2]).toEqual(begin[2]);
  }finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});
it('W4-B1 원 RUN PUT/readback은 각 원 I/O 사건을 기록하고 원 fresh PUT token을 다시 쓰지 못한다',async()=>{
  const f=w4bRawSpecimen(),ports=f.open();
  try{const allocation=await ports.raw.allocate(f.who,f.attempt,f.allocation.result);await ports.raw.putOriginal(f.who,allocation,new Map([['archive',Buffer.from([2,3])]]));
    expect(f.requests.map(r=>r.kind)).toEqual(['OBJECT_PUT','OBJECT_READ']);expect(f.decision.mock.calls.filter(q=>q[1].includes('controller_io_begin')).every(q=>JSON.parse(q[2][4] as string).purpose==='RUN_RECOVERY')).toBe(true);
    await expect(ports.raw.putOriginal(f.who,allocation,new Map([['archive',Buffer.from([2,3])]]))).rejects.toMatchObject({nextAction:'WAIT'});expect(f.ioPut).toHaveBeenCalledTimes(1);expect(f.ioRead).toHaveBeenCalledTimes(1);expect(f.objects.put).not.toHaveBeenCalled();
  }finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});


it.each(['authenticatedPeerId','deliveryClaimId'] as const)('W4-B1 공개 context의 %s 위조는 인증값을 대신하지 못하고 DB0이다',async key=>{
 const f=w4bRawSpecimen(),ports=f.open();try{await expect(ports.raw.readExisting(f.who,f.attempt,{...w4bQueryContext(),[key]:randomUUID()})).rejects.toMatchObject({nextAction:'WAIT'});expect(f.decision).not.toHaveBeenCalled();expect(f.ioRead).not.toHaveBeenCalled();}finally{await ports.journal.close();expect(f.memory.available()).toBe(f.memory.maxBytes);}
});
