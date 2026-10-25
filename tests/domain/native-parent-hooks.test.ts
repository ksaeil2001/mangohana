import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError,type NativeJob,type NativeJobEvidence,type NativeLimits,type NativeRunHooks,type NativeTermination} from '../../packages/native/src/dto.js';
import type {OwnedNativeIsolation} from '../../packages/native/src/isolation.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {digest} from '../../packages/contracts/src/intent.js';

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024};
const input=()=>({task:'ZIP_WRITE' as const,metadata:{profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'entry'}]},blobs:new Map([['entry',Buffer.from([0,255,4,0])]])});
const noopHooks=():NativeRunHooks=>({intent:async()=>{},consumeGo:async()=>{},observation:async()=>{},termination:async()=>{}});

describe('trusted parent native lifecycle',()=>{
  it('retries only the identical final termination record after a callback failure, without another intent or GO',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-proof-retry-')),hooks=noopHooks(),item=input(),proofs:NativeTermination[]=[],intent=vi.fn(async()=>{}),go=vi.fn(async()=>{});let attempts=0;
    hooks.intent=intent;hooks.consumeGo=go;hooks.termination=async(_job,_evidence,termination)=>{proofs.push(structuredClone(termination));if(++attempts===1)throw new Error('owned observation connection lost');};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root});
    await expect(controller.run(item.task,item.metadata,item.blobs,hooks)).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});
    await expect(controller.idle()).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});
    await controller.reconcileTerminations();await controller.idle();expect(intent).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledTimes(1);expect(proofs).toHaveLength(2);expect(proofs[1]).toEqual(proofs[0]);expect(await readdir(root)).toHaveLength(1);
  });
  it('records the intent before setup and consumes GO only after membership, then preserves result and termination separately',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-parent-order-')),events:string[]=[],jobs:NativeJob[]=[],terminations:NativeTermination[]=[],observations:NativeJobEvidence[]=[];
    const isolation:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>{events.push('setup');return {attach:async()=>{events.push('membership');},killSubtree:async()=>{},empty:async()=>false,close:async()=>{}};}};
    const hooks:NativeRunHooks={intent:async job=>{events.push('intent');jobs.push(job);expect(await readdir(root)).toEqual([]);},consumeGo:async job=>{events.push('go');expect(job.jobId).toBe(jobs[0].jobId);},observation:async(job,evidence,termination,result)=>{events.push('result');observations.push(evidence);terminations.push(termination);expect(result?.jobId).toBe(job.jobId);expect(result?.inputDigest).toBe(job.inputDigest);expect(result?.metadata.archiveBlobId).toBe('archive');expect(digest(result!)).toMatch(/^[a-f0-9]{64}$/);},termination:async(job,evidence,termination)=>{events.push('termination');expect(job.jobId).toBe(jobs[0].jobId);expect(evidence.code).toBe('OK');terminations.push(termination);}};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation}),facade=new NativeFacade(controller).withHooks(hooks);
    expect((await facade.writeZip(new Map([['owned.bin',Buffer.from([0,255,4,0])]]),syntheticProfile)).readUInt32LE(0)).toBe(0x04034b50);
    await controller.idle();expect(events).toEqual(['intent','setup','membership','go','result','termination']);expect(observations[0]).toMatchObject({state:'SUCCEEDED',goAttempted:true,operationJoined:true,subtreeTerminationConfirmed:false});expect(terminations).toHaveLength(2);expect(terminations.every(item=>item.kind==='DIRECT_CHILD_ONLY'&&!item.subtreeTerminationConfirmed)).toBe(true);
  });
  it('leaves the child in WAIT when the one-time GO authority refuses this parent',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-go-used-')),hooks=noopHooks();let snapshot:NativeTermination|undefined;
    hooks.consumeGo=async()=>{throw new DomainError('NATIVE_GO_USED',409,'WAIT');};hooks.observation=async(_job,_evidence,termination)=>{snapshot=termination;};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),item=input();
    await expect(controller.run(item.task,item.metadata,item.blobs,hooks)).rejects.toMatchObject({code:'NATIVE_GO_USED',termination:{goAttempted:false,startedComputation:false,directChildClosed:true,operationJoined:true}});
    await controller.idle();expect(snapshot).toMatchObject({goAttempted:false,startedComputation:false,subtreeTerminationConfirmed:false});
  });
  it('tracks a late intent acknowledgement without creating a child or losing its final no-child observation',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-late-intent-')),item=input(),snapshots:NativeTermination[]=[];let releaseIntent!:()=>void;
    const pending=new Promise<void>(resolve=>{releaseIntent=resolve;}),hooks=noopHooks();hooks.intent=async()=>pending;hooks.observation=async(_job,_evidence,termination)=>{snapshots.push(termination);};hooks.termination=async(_job,_evidence,termination)=>{snapshots.push(termination);};const go=vi.fn(async()=>{});hooks.consumeGo=go;
    const held=2*item.blobs.get('entry')!.length+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32,controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,timeoutMs:700,terminationWaitMs:100,parentInFlightBytes:held},directoryRoot:root});
    try{
      const error=await controller.run(item.task,item.metadata,item.blobs,hooks).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error.termination).toMatchObject({operationJoined:false,kind:'UNCONFIRMED',goAttempted:false});
      await expect(controller.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});let finished=false;const idle=controller.idle().then(()=>{finished=true;});await delay(30);expect(finished).toBe(false);
      releaseIntent();await idle;expect(go).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([]);expect(snapshots[0]).toMatchObject({operationJoined:false,kind:'UNCONFIRMED'});expect(snapshots.at(-1)).toMatchObject({operationJoined:true,kind:'NO_CHILD_CREATED',goAttempted:false,directChildClosed:false});expect(error.termination.kind).toBe('UNCONFIRMED');
    }finally{releaseIntent();await controller.idle();}
  });
  it('refuses binding a facade to a runner that cannot enforce the parent lifecycle',()=>{
    const run=vi.fn(async()=>({metadata:{},blobs:new Map<string,Buffer>()}));expect(()=>new NativeFacade({run}).withHooks(noopHooks())).toThrow('NATIVE_PARENT_HOOKS_UNCONFIRMED');expect(run).not.toHaveBeenCalled();
  });
  it('does not publish successful output while a termination observation is still pending',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-late-termination-')),hooks=noopHooks(),item=input();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});hooks.termination=async()=>pending;
    const controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,terminationWaitMs:100},directoryRoot:root});
    try{const error=await controller.run(item.task,item.metadata,item.blobs,hooks).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_TERMINATION_UNCONFIRMED');let finished=false;const idle=controller.idle().then(()=>{finished=true;});await delay(30);expect(finished).toBe(false);release();await idle;expect(error.code).toBe('NATIVE_TERMINATION_UNCONFIRMED');}finally{release();await controller.idle();}
  });
});
