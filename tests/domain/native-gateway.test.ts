import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeLimits} from '../../packages/native/src/dto.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import type {NativeJobIntent,NativeJobObservation} from '../../packages/domain/src/native-jobs.js';

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16*1024*1024};
type Call={accountId:string;sql:string;values:unknown[]};
function database(handler?:(call:Call)=>unknown){
  const calls:Call[]=[];
  const db={accountTransaction:async(accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async(sql:string,values:unknown[])=>{const call={accountId,sql,values};calls.push(call);const decision=(await handler?.(call))??{allowed:true,reason:'OWNED_FIXTURE'};return {rows:[{decision}]};}}} as unknown as Transaction)} as unknown as Database;
  return {db,calls};
}
function target(accountId=randomUUID()):NativeTarget{return {accountId,targetKind:'UPLOAD',targetId:randomUUID(),semanticCaptureDigest:digest({meaning:'owned ZIP specimen'}),protectedOwnerCapture:{contextId:randomUUID(),contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:null}};}
function intent(call:Call):NativeJobIntent{return JSON.parse(call.values[0] as string) as NativeJobIntent;}
function observed(call:Call):NativeJobObservation{return JSON.parse(call.values[1] as string) as NativeJobObservation;}

describe('database-bound parent native gateway',()=>{
  it('rejects a malformed target before DB admission or parent reservation',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-target-shape-')),recorded=database(),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller);
    expect(()=>gateway.forTarget({...target(),targetId:'not-an-id'})).toThrow('NATIVE_JOB_RECORD_INVALID');expect(()=>gateway.forTarget({...target(),semanticCaptureDigest:'unsealed'})).toThrow('NATIVE_JOB_RECORD_INVALID');expect(recorded.calls).toEqual([]);expect(await readdir(root)).toEqual([]);await gateway.idle();
  });
  it('appends the original timeout snapshot after a late intent acknowledgement joins, with no GO or child creation',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-late-intent-'));let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
    const recorded=database(async call=>{if(call.sql.includes('native_job_create_intent'))await pending;}),controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,timeoutMs:700,terminationWaitMs:100},directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller);
    try{
      const error=await gateway.forTarget(target()).writeZip(new Map([['owned.bin',Buffer.from([4])]]),syntheticProfile).catch(error=>error);expect(error).toMatchObject({code:'NATIVE_JOB_TIMEOUT',termination:{goAttempted:false,operationJoined:false,kind:'UNCONFIRMED'}});expect(recorded.calls).toHaveLength(1);
      let joined=false;const idle=gateway.idle().then(()=>{joined=true;});await delay(30);expect(joined).toBe(false);release();await idle;
      const observations=recorded.calls.filter(call=>call.sql.includes('native_job_append_observation')).map(observed);expect(observations).toHaveLength(2);expect(observations[0]).toMatchObject({event:'ERROR',termination:{operationJoined:false,kind:'UNCONFIRMED'}});expect(observations[1]).toMatchObject({event:'TERMINATION',termination:{operationJoined:true,kind:'NO_CHILD_CREATED'}});expect(recorded.calls.filter(call=>call.sql.includes('native_job_consume_go'))).toEqual([]);expect(await readdir(root)).toEqual([]);expect(error.termination.operationJoined).toBe(false);
    }finally{release();await gateway.idle();}
  });
  it('keeps concurrent account targets captured independently and records only digests and physical observations',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-')),recorded=database(),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller),first=target(),second=target(),captured=structuredClone(first),a=gateway.forTarget(first),b=gateway.forTarget(second);
    first.accountId=second.accountId;first.claim.generation='999';first.protectedOwnerCapture.contextGeneration='999';
    const outputs=await Promise.all([a.writeZip(new Map([['first.bin',Buffer.from('owned first payload')]]),syntheticProfile),b.writeZip(new Map([['second.bin',Buffer.from('owned second payload')]]),syntheticProfile)]);await gateway.idle();
    expect(outputs.every(bytes=>bytes.readUInt32LE(0)===0x04034b50)).toBe(true);
    const intents=recorded.calls.filter(call=>call.sql.includes('native_job_create_intent'));expect(intents).toHaveLength(2);expect(intents.find(call=>call.accountId===captured.accountId)&&intent(intents.find(call=>call.accountId===captured.accountId)!)).toMatchObject({targetId:captured.targetId,protectedOwnerCapture:captured.protectedOwnerCapture,claim:captured.claim,parentInstanceId:controller.parentInstanceId});
    for(const call of intents){expect(intent(call).profileDigest).toBe(controller.profileDigest);expect(intent(call).logicalOperationKey).toMatch(/^[a-f0-9]{64}$/);}
    const go=recorded.calls.filter(call=>call.sql.includes('native_job_consume_go'));expect(go).toHaveLength(2);expect(new Set(go.map(call=>call.accountId))).toEqual(new Set([captured.accountId,second.accountId]));
    const observations=recorded.calls.filter(call=>call.sql.includes('native_job_append_observation'));expect(observations).toHaveLength(4);expect(observations.map(observed).filter(item=>item.event==='RESULT')).toHaveLength(2);expect(observations.map(observed).filter(item=>item.event==='TERMINATION')).toHaveLength(2);
    const serialized=JSON.stringify(recorded.calls);expect(serialized).not.toContain('owned first payload');expect(serialized).not.toContain('owned second payload');expect(serialized).not.toContain(root);expect(observations.every(call=>observed(call).termination.subtreeTerminationConfirmed===false)).toBe(true);
  });
  it('creates no child and does not append a refused new intent to an earlier logical job',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-refused-')),recorded=database(call=>call.sql.includes('native_job_create_intent')?{allowed:false,reason:'NATIVE_JOB_UNRESOLVED'}:undefined),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller);
    await expect(gateway.forTarget(target()).writeZip(new Map([['owned.bin',Buffer.from([1])]]),syntheticProfile)).rejects.toMatchObject({code:'NATIVE_JOB_UNRESOLVED',termination:{kind:'NO_CHILD_CREATED',goAttempted:false,operationJoined:true}});
    await gateway.idle();expect(recorded.calls).toHaveLength(1);expect(await readdir(root)).toEqual([]);
  });
  it('keeps an ambiguous intent acknowledgement as its own unknown job with a separate joined no-child observation',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-ambiguous-')),recorded=database(call=>{if(call.sql.includes('native_job_create_intent'))throw new Error('owned acknowledgement lost after commit');}),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller);
    await expect(gateway.forTarget(target()).writeZip(new Map([['owned.bin',Buffer.from([2])]]),syntheticProfile)).rejects.toMatchObject({code:'NATIVE_JOB_FAILED',termination:{goAttempted:false,operationJoined:true}});
    await gateway.idle();expect(recorded.calls.filter(call=>call.sql.includes('native_job_consume_go'))).toHaveLength(0);const current=intent(recorded.calls[0]),observations=recorded.calls.filter(call=>call.sql.includes('native_job_append_observation')).map(observed);expect(observations).toHaveLength(2);expect(observations[0].event).toBe('ERROR');expect(observations[1]).toMatchObject({event:'TERMINATION',termination:{jobId:current.jobId,kind:'NO_CHILD_CREATED',operationJoined:true,goAttempted:false}});expect(await readdir(root)).toEqual([]);
  });
  it('replays only the same immutable termination observation ID after a lost acknowledgement',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-proof-'));let lost=false;
    const recorded=database(call=>{if(call.sql.includes('native_job_append_observation')&&observed(call).event==='TERMINATION'&&!lost){lost=true;throw new Error('owned termination acknowledgement lost');}}),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(recorded.db,controller);
    await expect(gateway.forTarget(target()).writeZip(new Map([['owned.bin',Buffer.from([3])]]),syntheticProfile)).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});
    await expect(gateway.idle()).rejects.toMatchObject({code:'NATIVE_TERMINATION_UNCONFIRMED'});await gateway.reconcileTerminations();await gateway.idle();
    expect(recorded.calls.filter(call=>call.sql.includes('native_job_create_intent'))).toHaveLength(1);expect(recorded.calls.filter(call=>call.sql.includes('native_job_consume_go'))).toHaveLength(1);
    const proofs=recorded.calls.filter(call=>call.sql.includes('native_job_append_observation')&&observed(call).event==='TERMINATION');expect(proofs).toHaveLength(2);expect(proofs[1]).toEqual(proofs[0]);expect(await readdir(root)).toHaveLength(1);
  });
});
