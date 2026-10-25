import {afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {FileObjectStore} from '../../packages/storage/src/objects.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {createNativeJob,verifyNativeResult,type NativeJob,type NativeResult,type NativeRunHooks,type NativeLimits,type NativeTermination} from '../../packages/native/src/dto.js';

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024};
const controllers:NativeController[]=[];
afterAll(async()=>{for(const controller of controllers){controller.stopClaims();await controller.idle();}});
function input(){const blobs=new Map([['entry',Buffer.from([40,120,240,255])]]);return {job:createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'entry'}]},blobs,{maxMetadataBytes:limits.maxMetadataBytes,maxBinaryBytes:limits.maxInputBytes,maxItems:limits.maxItems}),blobs};}
async function controller(options:Partial<NativeLimits>={}){const directoryRoot=await mkdtemp(path.join(tmpdir(),'trio-native-raw-hook-'));const value=NativeController.owned({profile:syntheticProfile,limits:{...limits,...options},directoryRoot});controllers.push(value);return {value,directoryRoot};}
const hooks=():NativeRunHooks=>({intent:async()=>{},consumeGo:async()=>{},observation:async()=>{},termination:async()=>{}});
function capture(job:NativeJob,result:NativeResult,blobs:Map<string,Buffer>){verifyNativeResult(job,result);return {job:structuredClone(job),result:structuredClone(result),blobs:new Map([...blobs].map(([id,bytes])=>[id,Buffer.from(bytes)]))};}

describe('controller-owned raw result before final audit',()=>{
  it('captures original frame and bytes after child exit and before RESULT and TERMINATION audit',async()=>{
    const owned=await controller(),item=input(),events:string[]=[],callbacks=hooks();let raw:ReturnType<typeof capture>|undefined;
    callbacks.rawResult=async(job,result,blobs)=>{events.push('RAW');raw=capture(job,result,blobs);};callbacks.observation=async(_job,evidence)=>{events.push(evidence.code);};callbacks.termination=async(_job,_evidence,termination)=>{events.push(termination.kind);};
    const result=await owned.value.runCaptured(item.job,item.blobs,callbacks);await owned.value.idle();expect(events).toEqual(['RAW','OK','DIRECT_CHILD_ONLY']);expect(raw?.job).toEqual(item.job);expect(raw?.result.metadata).toEqual(result.metadata);expect(raw?.blobs).toEqual(result.blobs);expect((await readdir(owned.directoryRoot)).filter(name=>name.startsWith('trio-native-'))).toHaveLength(1);
  });
  it('retains a raw candidate when final RESULT audit ACK is lost without turning it into a receipt',async()=>{
    const owned=await controller(),item=input(),callbacks=hooks();let raw:ReturnType<typeof capture>|undefined,termination:NativeTermination|undefined,go=0;
    callbacks.consumeGo=async()=>{go++;};callbacks.rawResult=async(job,result,blobs)=>{raw=capture(job,result,blobs);};callbacks.observation=async()=>{throw new Error('OWNED_SQL_RESULT_ACK_LOST');};callbacks.termination=async(_job,_evidence,fact)=>{termination=structuredClone(fact);};
    await expect(owned.value.runCaptured(item.job,item.blobs,callbacks)).rejects.toMatchObject({code:'NATIVE_EVIDENCE_UNCONFIRMED',termination:{jobId:item.job.jobId,inputDigest:item.job.inputDigest,profileDigest:item.job.profileDigest,kind:'DIRECT_CHILD_ONLY',operationJoined:true}});await owned.value.idle();
    expect(raw).toBeDefined();verifyNativeResult(item.job,raw!.result);for(const ref of raw!.result.blobs)expect(sha256(raw!.blobs.get(ref.id)!)).toBe(ref.sha256);expect(termination?.kind).toBe('DIRECT_CHILD_ONLY');expect(go).toBe(1);expect(raw).not.toHaveProperty('receipt');expect(raw).not.toHaveProperty('approved');
  });
  it('records an opaque raw object identity before one PUT and reconciles actual bytes after PUT ACK loss',async()=>{
    const owned=await controller(),item=input(),objects=new FileObjectStore(path.join(owned.directoryRoot,'objects'),limits.maxOutputBytes),callbacks=hooks();let candidate:{id:string;key:string;frame:ReturnType<typeof capture>}|undefined,putCount=0;
    callbacks.rawResult=async(job,result,blobs)=>{const id=randomUUID(),key=`${randomUUID()}/${id}`;candidate={id,key,frame:capture(job,result,blobs)};const bytes=blobs.get(result.blobs[0].id)!;putCount++;await objects.put(key,bytes);throw new DomainError('NATIVE_RAW_RESULT_UNCONFIRMED',409,'WAIT');};
    await expect(owned.value.runCaptured(item.job,item.blobs,callbacks)).rejects.toMatchObject({code:'NATIVE_RAW_RESULT_UNCONFIRMED',termination:{kind:'DIRECT_CHILD_ONLY',operationJoined:true}});await owned.value.idle();
    expect(candidate).toBeDefined();expect(putCount).toBe(1);const fact=await objects.receipt(candidate!.key),existing=await objects.read(candidate!.key);expect(fact?.sha256).toBe(candidate!.frame.result.blobs[0].sha256);expect(existing).toEqual(candidate!.frame.blobs.get(candidate!.frame.result.blobs[0].id));verifyNativeResult(item.job,candidate!.frame.result);expect((await readdir(owned.directoryRoot)).filter(name=>name.startsWith('trio-native-'))).toHaveLength(1);
  });
  it('refuses raw callback metadata or byte mutations before any success audit',async()=>{
    for(const mutation of ['metadata','bytes'] as const){const owned=await controller(),item=input(),callbacks=hooks();let success=false;
      callbacks.rawResult=async(_job,result,blobs)=>{if(mutation==='metadata')result.metadata.mutated=true;else blobs.get(result.blobs[0].id)![0]^=1;};callbacks.observation=async(_job,evidence)=>{if(evidence.code==='OK')success=true;};
      await expect(owned.value.runCaptured(item.job,item.blobs,callbacks)).rejects.toMatchObject({code:'NATIVE_OUTPUT_MISMATCH',termination:{kind:'DIRECT_CHILD_ONLY',operationJoined:true}});await owned.value.idle();expect(success).toBe(false);
    }
  });
  it('holds parent capacity and late raw I/O after timeout until the original operation and audit join',async()=>{
    const held=2*4+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32,owned=await controller({timeoutMs:3000,parentInFlightBytes:held}),item=input(),callbacks=hooks();let release:()=>void=()=>{},started:()=>void=()=>{},termination:NativeTermination|undefined;
    const pending=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});callbacks.rawResult=async()=>{started();await pending;};callbacks.termination=async(_job,_evidence,fact)=>{termination=structuredClone(fact);};
    const running=owned.value.runCaptured(item.job,item.blobs,callbacks);const rejected=expect(running).rejects.toMatchObject({code:'NATIVE_JOB_TIMEOUT',termination:{directChildClosed:true,operationJoined:false,kind:'UNCONFIRMED'}});
    try{await Promise.race([entered,running]);await rejected;await expect(owned.value.runCaptured(input().job,item.blobs,hooks())).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});expect(termination).toBeUndefined();}
    finally{release();await owned.value.reconcileTerminations();await owned.value.idle();}
    expect(termination).toMatchObject({jobId:item.job.jobId,inputDigest:item.job.inputDigest,operationJoined:true,kind:'DIRECT_CHILD_ONLY'});expect((await readdir(owned.directoryRoot)).filter(name=>name.startsWith('trio-native-'))).toHaveLength(1);
  });
});
