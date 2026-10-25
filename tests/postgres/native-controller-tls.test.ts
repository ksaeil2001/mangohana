import {describe,expect,it,vi} from 'vitest';
import {randomUUID,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeControllerAttempts} from '../../packages/native/src/controller-attempts.js';
import {NativeControllerStore} from '../../packages/domain/src/native-controller-store.js';
import {createNativeControllerTlsServer,NativeControllerTlsClient,type NativeControllerTlsBounds,type NativeControllerTlsMaterials} from '../../packages/native/src/controller-tls.js';
import {controllerFrameLimits,nativeControllerFixture} from '../fixtures/native-controller.js';

// All certificates and keys are public owned fixtures, never operational trust.
function pem(name:string):Buffer{return readFileSync(new URL(`../fixtures/native-controller-tls-certs/${name}.pem`,import.meta.url));}
function materials(identity:'server'|'api'|'unregistered'):NativeControllerTlsMaterials{return {ca:pem('owned-ca-cert'),certificate:pem(identity+'-cert'),privateKey:pem(identity+'-key')};}
function pin(identity:'server'|'api'):string{return sha256(new X509Certificate(pem(identity+'-cert')).raw);}
const transportBounds:NativeControllerTlsBounds={
  wire:{maxControlBytes:64*1024,input:controllerFrameLimits,output:controllerFrameLimits},
  deadlineMilliseconds:5000,maxConnections:4,maxInFlightBytes:64*1024*1024,streamHighWaterMarkBytes:4096,
  transportAllowanceBytes:256*1024,maxTlsMaterialBytes:64*1024,maxPinnedPeers:4
};
const nativeOptions={profile:syntheticProfile,limits:{maxMetadataBytes:controllerFrameLimits.maxMetadataBytes,maxInputBytes:controllerFrameLimits.maxBinaryBytes,maxOutputBytes:controllerFrameLimits.maxBinaryBytes,maxItems:controllerFrameLimits.maxItems,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024}};

describe('actual owned TLS peer and controller-only PostgreSQL original attempt',()=>{
  it('authenticates before SQL and completes one child then reopens only its original raw facts through TLS',async()=>{
    const began=Date.now(),trace=(stage:string)=>process.stdout.write(JSON.stringify({scope:'owned-tls-pg-child',stage,elapsedMs:Date.now()-began})+'\n');
    trace('FIXTURE_BEGIN');const f=await nativeControllerFixture();trace('FIXTURE_READY');
    const cleanups:(()=>Promise<void>)[]=[];
    const peers=[{certificateSha256:pin('api'),serviceRole:'trio_web_api' as const,peerId:randomUUID()}];
    const create=async(index:number)=>{
      const runner=NativeController.owned(nativeOptions),starts=vi.spyOn(runner,'runCaptured');
      const store=new NativeControllerStore(f.controllers[index].database,{controllerId:f.profile.controllerId,controllerInstanceId:runner.parentInstanceId,input:controllerFrameLimits,output:controllerFrameLimits},f.port.objects,f.files.bucket);
      let coordinator!:NativeControllerAttempts;
      const server=createNativeControllerTlsServer({materials:materials('server'),pinnedPeers:peers,bounds:transportBounds},verifier=>{
        coordinator=new NativeControllerAttempts(runner,verifier,store,store,{maxControlBytes:transportBounds.wire.maxControlBytes,goWaitMilliseconds:5000,maxInFlightBytes:8*1024*1024});return coordinator;
      });
      cleanups.push(()=>server.shutdown());const address=await server.listen({host:'127.0.0.1',port:0});
      const client=(identity:'api'|'unregistered'='api')=>{
        const value=new NativeControllerTlsClient({materials:materials(identity),serverCertificateSha256:pin('server'),host:'127.0.0.1',port:address.port,servername:'server.native-controller.test.invalid',bounds:transportBounds});
        cleanups.push(()=>value.shutdown());return value;
      };
      return {runner,starts,store,coordinator,server,client};
    };
    const count=async(table:string)=>(await f.admin.pool.query<{n:number}>(`SELECT count(*)::integer AS n FROM manga_web.${table} WHERE account_id=$1`,[f.seed.accountId])).rows[0].n;
    const prepare=()=>({control:{version:1 as const,requestId:randomUUID(),binding:f.binding,command:'PREPARE' as const},input:{envelope:f.job,blobs:f.inputs}});
    const query=()=>({control:{version:1 as const,requestId:randomUUID(),binding:f.binding,command:'QUERY' as const,includeRawResult:true}});
    try{
      const first=await create(0),client=first.client();trace('TLS_READY');
      await expect(first.client('unregistered').exchange(prepare())).rejects.toBeInstanceOf(DomainError);
      expect(await count('native_controller_attempts')).toBe(0);expect(first.starts).not.toHaveBeenCalled();expect(f.port.put).not.toHaveBeenCalled();
      const ready=await client.exchange(prepare());trace('PREPARE_ACK');expect(ready.control.snapshot.phase).toBe('READY');
      const granted=await client.exchange({control:{version:1,requestId:randomUUID(),binding:f.binding,command:'GO',attemptId:ready.control.snapshot.attemptId,controllerInstanceId:ready.control.snapshot.controllerInstanceId}});trace('GO_ACK');
      expect(granted.control.snapshot.phase).toBe('GO_GRANTED');await first.coordinator.idle();trace('CHILD_JOINED');
      const result=await client.exchange(query(),f.job);
      expect(result.rawResult).toEqual({envelope:f.result,blobs:f.computation.blobs});
      expect(result.control.snapshot).toMatchObject({attemptId:ready.control.snapshot.attemptId,code:'OK',phase:'GO_GRANTED',termination:{kind:'DIRECT_CHILD_ONLY',operationJoined:true,subtreeTerminationConfirmed:false}});
      expect(first.starts).toHaveBeenCalledTimes(1);expect(f.port.put).toHaveBeenCalledTimes(1);await client.shutdown();await first.server.shutdown();
      const reopened=await create(1),next=reopened.client();trace('REOPENED_TLS_READY');
      const recovered=await next.exchange(query(),f.job);expect(recovered.control.snapshot).toEqual(result.control.snapshot);expect(recovered.rawResult).toEqual(result.rawResult);
      const replay=await next.exchange(prepare());expect(replay.control.snapshot).toEqual(result.control.snapshot);expect(reopened.starts).not.toHaveBeenCalled();
      expect(f.port.put).toHaveBeenCalledTimes(1);expect(await count('native_controller_attempts')).toBe(1);expect(await count('native_job_go_consumptions')).toBe(1);
      expect(await count('native_controller_raw_results')).toBe(1);expect(await count('native_capacity_termination_proofs')).toBe(0);
      expect((await f.admin.pool.query<{state:string}>('SELECT state FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,f.binding.capacityReservationId])).rows[0].state).toBe('HELD');
      trace('ORIGINAL_FACTS_VERIFIED');
    }finally{
      const failures:unknown[]=[];
      for(const cleanup of cleanups.reverse()){try{await cleanup();}catch(error){failures.push(error);}}
      try{await f.close();}catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,'OWNED_TLS_PG_CLOSE_UNCONFIRMED');
      trace('ALL_OWNED_IO_JOINED');
    }
  });
});
