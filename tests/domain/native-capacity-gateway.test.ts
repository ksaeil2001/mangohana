import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import type {NativeCapacityConfiguration,OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';

const limits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16*1024*1024};
type Call={accountId:string;sql:string;values:unknown[]};
async function fixture(refused=false){
  const root=await mkdtemp(path.join(tmpdir(),'trio-native-capacity-gateway-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),key=generateKeyPairSync('ed25519');
  const profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'owned-native-capacity-v1',maxSlots:1,nativeProfileDigest:controller.profileDigest,kernelDigest:controller.kernelImplementationDigest,controllerId:randomUUID(),keyVersion:'owned-key-v1',environmentDigest:sha256('owned fixture process'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:gateway/captured-admission']};
  const capacity:NativeCapacityConfiguration={reference:{kind:'OWNED_FIXTURE',profileId:randomUUID(),profileDigest:sha256('fake SQL profile digest'),profileVersion:profile.version},profile};
  const target:NativeTarget={accountId:randomUUID(),targetKind:'UPLOAD',targetId:randomUUID(),semanticCaptureDigest:digest({owned:'ZIP gateway specimen'}),protectedOwnerCapture:{contextId:randomUUID(),contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'0',workspaceRevision:'0'},claim:{generation:'0',ownerId:randomUUID(),workItemId:null}};
  const calls:Call[]=[],reservationId=randomUUID();
  const db={accountTransaction:async(accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async(sql:string,values:unknown[])=>{
    calls.push({accountId,sql,values});if(refused&&sql.includes('native_capacity_create_intent'))return {rows:[{decision:{allowed:false,reason:'NATIVE_CAPACITY_WAIT'}}]};return {rows:[{decision:{allowed:true,reason:'OWNED_FAKE_DATABASE',capacityReservationId:reservationId,observationDigest:sha256(JSON.stringify(values))}}]};
  }}} as unknown as Transaction)} as unknown as Database;
  return {root,controller,capacity,target,calls,gateway:new NativeDatabaseGateway(db,controller,undefined,capacity)};
}

describe('owned child with a private captured capacity gateway',()=>{
  it('sends a captured original INPUT only in the capacity capsule with the existing fourteen-field intent',async()=>{
    const f=await fixture(),source={executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('original INPUT')},target:NativeTarget={...f.target,targetKind:'EXECUTION',targetId:source.executionId,claim:{...f.target.claim,generation:'1',workItemId:randomUUID()},sourceInput:source};
    const facade=f.gateway.forTarget(target),original=structuredClone(source);source.inputEvidenceId=randomUUID();source.stageInputDigest=sha256('caller mutated');
    try{await facade.writeZip(new Map([['owned.bin',Buffer.from([3,4,5])]]),syntheticProfile);await f.gateway.idle();
      const intent=f.calls.find(call=>call.sql.includes('native_capacity_create_intent'))!,go=f.calls.find(call=>call.sql.includes('native_capacity_consume_go'))!;
      expect(JSON.parse(intent.values[2] as string).sourceInput).toEqual(original);expect(JSON.parse(go.values[4] as string).sourceInput).toEqual(original);
      const legacy=JSON.parse(intent.values[0] as string);expect(Object.keys(legacy)).toHaveLength(14);expect(legacy.sourceInput).toBeUndefined();expect(legacy.inputDigest).not.toBe(original.stageInputDigest);
      expect(f.calls.some(call=>/confirm_proof|native_capacity_release/.test(call.sql))).toBe(false);
    }finally{await f.gateway.idle();}
  });
  it('sends the original exact profile payload before intent and GO without any proof or release authority',async()=>{
    const f=await fixture(),original=structuredClone(f.capacity);f.capacity.profile.maxSlots=99;f.capacity.profile.environmentDigest=sha256('mutated caller');f.capacity.reference.profileVersion='caller-mutation';
    try{
      const zip=await f.gateway.forTarget(f.target).writeZip(new Map([['owned.bin',Buffer.from('owned fixture bytes')]]),syntheticProfile);await f.gateway.idle();expect(zip.readUInt32LE(0)).toBe(0x04034b50);
      const intent=f.calls.find(call=>call.sql.includes('native_capacity_create_intent'))!,go=f.calls.find(call=>call.sql.includes('native_capacity_consume_go'))!;expect(JSON.parse(intent.values[2] as string)).toEqual(original);expect(JSON.parse(go.values[4] as string)).toEqual(original);expect(intent.values[1]).toBe(false);
      expect(f.calls.filter(call=>call.sql.includes('native_capacity_create_intent'))).toHaveLength(1);expect(f.calls.filter(call=>call.sql.includes('native_capacity_consume_go'))).toHaveLength(1);expect(f.calls.filter(call=>call.sql.includes('native_job_append_observation'))).toHaveLength(2);
      expect(f.calls.some(call=>/confirm_proof|native_capacity_release|operator_profile/.test(call.sql))).toBe(false);
    }finally{await f.gateway.idle();}
  });
  it('creates no child and emits no observation or GO for a definite capacity refusal',async()=>{
    const f=await fixture(true);await expect(f.gateway.forTarget(f.target).writeZip(new Map([['owned.bin',Buffer.from([7])]]),syntheticProfile)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT',termination:{goAttempted:false,startedComputation:false,operationJoined:true,kind:'NO_CHILD_CREATED'}});await f.gateway.idle();
    expect(f.calls).toHaveLength(1);expect(f.calls[0].sql).toContain('native_capacity_create_intent');expect(await readdir(f.root)).toEqual([]);
  });
});
