import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeController} from '../../packages/native/src/controller.js';
import {createNativeJob,nativeInputDigest,NativeJobError,type NativeJob,type NativeLimits,type NativeRunHooks,type NativeTermination} from '../../packages/native/src/dto.js';
import {OwnedDirectChildIsolation} from '../../packages/native/src/isolation.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {readZip} from '../../packages/media/src/zip.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024};
const frameLimits={maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems};
const input=()=>{
  const bytes=Buffer.from([0,255,4,0]),blobs=new Map([['entry',bytes]]);
  return {bytes,blobs,job:createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:structuredClone(syntheticProfile),entries:[{name:'owned.bin',blobId:'entry'}]},blobs,frameLimits,randomUUID())};
};
const noopHooks=():NativeRunHooks=>({intent:async()=>{},consumeGo:async()=>{},observation:async()=>{},termination:async()=>{}});
function redigest(job:NativeJob):void{const {inputDigest:_previous,...capture}=job;job.inputDigest=nativeInputDigest(capture);}
const identity=(job:NativeJob)=>({jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest});

describe('trusted owned execution of the original native frame',()=>{
  it('preserves the original identity through the actual child, intent, GO, result and final termination',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-frame-')),item=input(),expected=structuredClone(item.job),events:string[]=[],isolation=new OwnedDirectChildIsolation(),create=vi.spyOn(isolation,'create');
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation}),parentInstanceId=controller.parentInstanceId;
    const hooks:NativeRunHooks={
      intent:async job=>{events.push('intent');expect(job).toEqual(expected);expect(await readdir(root)).toEqual([]);},
      consumeGo:async job=>{events.push('go');expect(job).toEqual(expected);expect(create).toHaveBeenCalledWith(expected.jobId,limits);},
      observation:async(job,evidence,termination,result)=>{events.push('result');expect(job).toEqual(expected);expect(evidence).toMatchObject({...identity(expected),task:expected.task,state:'SUCCEEDED',code:'OK'});expect(termination).toMatchObject({...identity(expected),kind:'DIRECT_CHILD_ONLY',operationJoined:true,directChildClosed:true,subtreeTerminationConfirmed:false});expect(result).toMatchObject({...identity(expected),task:expected.task,taskVersion:expected.taskVersion,metadata:{archiveBlobId:'archive'}});},
      termination:async(job,evidence,termination)=>{events.push('termination');expect(job).toEqual(expected);expect(evidence).toMatchObject({...identity(expected),code:'OK'});expect(termination).toMatchObject({...identity(expected),goAttempted:true,startedComputation:true,kind:'DIRECT_CHILD_ONLY',operationJoined:true,directChildClosed:true,subtreeTerminationConfirmed:false});},
    };
    const result=await controller.runCaptured(item.job,item.blobs,hooks);await controller.idle();
    expect(await readZip(result.blobs.get('archive')!,syntheticProfile)).toEqual(new Map([['owned.bin',item.bytes]]));expect(events).toEqual(['intent','go','result','termination']);expect(create).toHaveBeenCalledTimes(1);expect(controller.parentInstanceId).toBe(parentInstanceId);expect(parentInstanceId).not.toBe(expected.jobId);
    const [directory]=await readdir(root);for(const file of ['evidence.json','termination.json'])expect(JSON.parse(await readFile(path.join(root,directory,file),'utf8'))).toMatchObject(identity(expected));
  });

  it('captures the entire envelope and binary bytes before awaiting a parent callback',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-mutation-')),item=input(),expected=structuredClone(item.job),bytes=Buffer.from(item.bytes),jobs:NativeJob[]=[];let releaseIntent!:()=>void;
    const pending=new Promise<void>(resolve=>{releaseIntent=resolve;}),hooks=noopHooks();hooks.intent=async job=>{jobs.push(structuredClone(job));await pending;};hooks.consumeGo=async job=>{jobs.push(structuredClone(job));};hooks.observation=async job=>{jobs.push(structuredClone(job));};hooks.termination=async job=>{jobs.push(structuredClone(job));};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),running=controller.runCaptured(item.job,item.blobs,hooks);
    try{
      item.job.jobId=randomUUID();item.job.task='ZIP_READ';item.job.taskVersion='changed' as NativeJob['taskVersion'];item.job.profileDigest=sha256('changed profile');item.job.inputDigest=sha256('changed input');
      (item.job.metadata.profile as {id:string}).id='changed';(item.job.metadata.entries as {name:string;blobId:string}[])[0].name='changed.bin';item.job.blobs[0].sha256=sha256('changed blob');item.bytes.fill(42);item.blobs.clear();item.blobs.set('different',Buffer.from('different'));
      releaseIntent();const result=await running;await controller.idle();expect(jobs).toEqual([expected,expected,expected,expected]);expect(await readZip(result.blobs.get('archive')!,syntheticProfile)).toEqual(new Map([['owned.bin',bytes]]));
    }finally{releaseIntent();await running.catch(()=>{});await controller.idle();}
  });

  const invalidCases:{name:string;code:string;mutate:(item:ReturnType<typeof input>)=>void}[]=[
    {name:'a different profile digest',code:'NATIVE_PROFILE_MISMATCH',mutate:({job})=>{job.profileDigest=sha256('different profile');redigest(job);}},
    {name:'different captured profile metadata',code:'NATIVE_PROFILE_MISMATCH',mutate:({job})=>{(job.metadata.profile as {id:string}).id='different';redigest(job);}},
    {name:'metadata changed without a new digest',code:'NATIVE_INPUT_MISMATCH',mutate:({job})=>{(job.metadata.entries as {name:string}[])[0].name='changed.bin';}},
    {name:'invalid metadata with a consistent digest',code:'NATIVE_INPUT_INVALID',mutate:({job})=>{job.metadata.entries=[{name:'../forbidden.bin',blobId:'entry'}];redigest(job);}},
    {name:'an unknown metadata field with a consistent digest',code:'NATIVE_INPUT_INVALID',mutate:({job})=>{job.metadata.unexpected=true;redigest(job);}},
    {name:'a different task with incompatible metadata',code:'NATIVE_INPUT_INVALID',mutate:({job})=>{job.task='ZIP_READ';redigest(job);}},
    {name:'a forged blob SHA with a consistent digest',code:'NATIVE_INPUT_MISMATCH',mutate:({job})=>{job.blobs[0].sha256=sha256('forged binary');redigest(job);}},
    {name:'binary bytes changed after the original capture',code:'NATIVE_INPUT_MISMATCH',mutate:({bytes})=>{bytes[0]^=1;}},
    {name:'a missing binary item',code:'NATIVE_INPUT_MISMATCH',mutate:({blobs})=>{blobs.clear();}},
    {name:'an extra binary item',code:'NATIVE_INPUT_MISMATCH',mutate:({blobs})=>{blobs.set('extra',Buffer.from('extra'));}},
    {name:'an unknown envelope field',code:'NATIVE_PROTOCOL_INVALID',mutate:({job})=>{(job as NativeJob&{unexpected?:boolean}).unexpected=true;}},
    {name:'an unknown blob descriptor field',code:'NATIVE_PROTOCOL_INVALID',mutate:({job})=>{(job.blobs[0] as NativeJob['blobs'][number]&{unexpected?:boolean}).unexpected=true;}},
    {name:'a forged input digest',code:'NATIVE_INPUT_MISMATCH',mutate:({job})=>{job.inputDigest=sha256('forged input');}},
    {name:'an unsupported task version',code:'NATIVE_PROTOCOL_INVALID',mutate:({job})=>{job.taskVersion='changed' as NativeJob['taskVersion'];}},
  ];
  it.each(invalidCases)('rejects $name before setup, child creation or any parent callback',async({code,mutate})=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-refused-')),item=input(),isolation=new OwnedDirectChildIsolation(),create=vi.spyOn(isolation,'create');
    const hooks:NativeRunHooks={intent:vi.fn(async()=>{}),consumeGo:vi.fn(async()=>{}),observation:vi.fn(async()=>{}),termination:vi.fn(async()=>{})},controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation});mutate(item);
    await expect(controller.runCaptured(item.job,item.blobs,hooks)).rejects.toMatchObject({code});await controller.idle();expect(create).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([]);for(const callback of Object.values(hooks))expect(callback).not.toHaveBeenCalled();
  });

  it('keeps GO refusal and termination hooks on the original frame',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-go-refused-')),item=input(),expected=structuredClone(item.job),jobs:NativeJob[]=[],hooks=noopHooks();
    hooks.intent=async job=>{jobs.push(structuredClone(job));};hooks.consumeGo=async job=>{jobs.push(structuredClone(job));throw new DomainError('NATIVE_GO_USED',409,'WAIT');};hooks.observation=async job=>{jobs.push(structuredClone(job));};hooks.termination=async job=>{jobs.push(structuredClone(job));};const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root});
    await expect(controller.runCaptured(item.job,item.blobs,hooks)).rejects.toMatchObject({code:'NATIVE_GO_USED',termination:{...identity(expected),goAttempted:false,startedComputation:false,directChildClosed:true,operationJoined:true,kind:'DIRECT_CHILD_ONLY'}});await controller.idle();expect(jobs).toEqual([expected,expected,expected,expected]);
  });

  it('holds the same captured buffers until a late operation joins after timeout and shutdown',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-late-join-')),item=input(),expected=structuredClone(item.job),snapshots:NativeTermination[]=[];let releaseIntent!:()=>void;
    const pending=new Promise<void>(resolve=>{releaseIntent=resolve;}),hooks=noopHooks();hooks.intent=async job=>{expect(job).toEqual(expected);await pending;};hooks.observation=async(job,_evidence,termination)=>{expect(job).toEqual(expected);snapshots.push(termination);};hooks.termination=async(job,_evidence,termination)=>{expect(job).toEqual(expected);snapshots.push(termination);};const go=vi.fn(async()=>{});hooks.consumeGo=go;
    const held=2*item.bytes.length+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32,controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,timeoutMs:700,terminationWaitMs:100,parentInFlightBytes:held},directoryRoot:root});
    try{
      const error=await controller.runCaptured(item.job,item.blobs,hooks).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error).toMatchObject({code:'NATIVE_JOB_TIMEOUT',termination:{...identity(expected),operationJoined:false,kind:'UNCONFIRMED',goAttempted:false}});
      await expect(controller.runCaptured(item.job,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});controller.stopClaims();expect(()=>controller.runCaptured(item.job,item.blobs)).toThrow('NATIVE_SHUTDOWN_WAIT');expect(()=>controller.run('ZIP_WRITE',item.job.metadata,item.blobs)).toThrow('NATIVE_SHUTDOWN_WAIT');let finished=false;const idle=controller.idle().then(()=>{finished=true;});await delay(30);expect(finished).toBe(false);
      releaseIntent();await idle;expect(go).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([]);expect(snapshots.at(-1)).toMatchObject({...identity(expected),operationJoined:true,kind:'NO_CHILD_CREATED',goAttempted:false,directChildClosed:false});expect(error.termination.kind).toBe('UNCONFIRMED');
    }finally{releaseIntent();await controller.idle();}
  });

  it('retains legacy run job allocation and the closed Linux factory',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-legacy-')),item=input(),hooks=noopHooks();let jobId:string|undefined;hooks.intent=async job=>{jobId=job.jobId;};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root});const result=await controller.run(item.job.task,item.job.metadata,item.blobs,hooks);await controller.idle();expect(jobId).toBeDefined();expect(jobId).not.toBe(item.job.jobId);expect(await readZip(result.blobs.get('archive')!,syntheticProfile)).toEqual(new Map([['owned.bin',item.bytes]]));
    await expect(NativeController.linux({profile:{...syntheticProfile,kind:'MEASURED'},limits,cgroupRoot:'/sys/fs/cgroup/owned-unused',childUid:1000,childGid:1000})).rejects.toMatchObject({code:'NATIVE_RESOURCE_CONTROLLER_UNCONFIRMED'});
  });

  it('retries only an identical captured termination proof without another intent, GO or child',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-original-proof-retry-')),item=input(),hooks=noopHooks(),isolation=new OwnedDirectChildIsolation(),create=vi.spyOn(isolation,'create'),proofs:NativeTermination[]=[];let attempts=0;
    const intent=vi.fn(async()=>{}),go=vi.fn(async()=>{});hooks.intent=intent;hooks.consumeGo=go;hooks.termination=async(job,_evidence,termination)=>{expect(job).toEqual(item.job);proofs.push(structuredClone(termination));if(++attempts===1)throw new Error('owned proof connection lost');};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation});await expect(controller.runCaptured(item.job,item.blobs,hooks)).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});await expect(controller.idle()).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});
    await controller.reconcileTerminations();await controller.idle();expect(intent).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledTimes(1);expect(proofs).toHaveLength(2);expect(proofs[1]).toEqual(proofs[0]);expect(proofs[0]).toMatchObject(identity(item.job));
  });
});
