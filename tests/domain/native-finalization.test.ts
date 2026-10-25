import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeJobError,type NativeLimits} from '../../packages/native/src/dto.js';
import type {OwnedNativeIsolation} from '../../packages/native/src/isolation.js';
import {writeNativeBytes} from '../../packages/native/src/frame.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {DomainError} from '../../packages/contracts/src/errors.js';

vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,writeFile:vi.fn(actual.writeFile)};});
vi.mock('../../packages/native/src/frame.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../packages/native/src/frame.js')>();return {...actual,writeNativeBytes:vi.fn(actual.writeNativeBytes)};});
const originalFs=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const originalFrame=await vi.importActual<typeof import('../../packages/native/src/frame.js')>('../../packages/native/src/frame.js');
afterEach(()=>{vi.mocked(writeFile).mockImplementation(originalFs.writeFile);vi.mocked(writeNativeBytes).mockImplementation(originalFrame.writeNativeBytes);});

const limits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024};
const input=()=>({task:'ZIP_WRITE' as const,metadata:{profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'entry'}]},blobs:new Map([['entry',Buffer.from([0,255,4,0])]])});

describe('native GO ambiguity and audit finalization',()=>{
  it('preserves possible start when the GO write fails after delivering its bytes',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-go-error-'));
    vi.mocked(writeNativeBytes).mockImplementation(async(stream,bytes)=>{await originalFrame.writeNativeBytes(stream,bytes);if(bytes.equals(Buffer.from('GO_V1\n')))throw new DomainError('NATIVE_PROTOCOL_CLOSED',409,'WAIT');});
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),item=input();
    const error=await controller.run(item.task,item.metadata,item.blobs).catch(error=>error);
    expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_PROTOCOL_CLOSED');
    expect(error.termination).toMatchObject({goAttempted:true,startedComputation:false,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'});
    await controller.idle();
  });
  it('classifies an audit collision after successful computation as unconfirmed evidence',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-success-audit-'));
    const isolation:OwnedNativeIsolation={kind:'OWNED_FIXTURE',create:async()=>({attach:async()=>{const [directory]=await readdir(root);await writeFile(path.join(root,directory,'evidence.json'),'owned prior evidence',{flag:'wx'});},killSubtree:async()=>{},empty:async()=>false,close:async()=>{}})};
    const controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root,isolation}),item=input();
    const error=await controller.run(item.task,item.metadata,item.blobs).catch(error=>error);
    expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_EVIDENCE_UNCONFIRMED');
    expect(error.termination).toMatchObject({goAttempted:true,startedComputation:true,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false});
    await controller.idle();const [directory]=await readdir(root);expect(await readFile(path.join(root,directory,'evidence.json'),'utf8')).toBe('owned prior evidence');
  });
  it('keeps the parent budget and idle pending until a timed-out audit write finishes',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-native-late-audit-'));
    let releaseWrite!:()=>void,writing=false;const pending=new Promise<void>(resolve=>{releaseWrite=resolve;});
    vi.mocked(writeFile).mockImplementation(async(...args)=>{if(typeof args[0]==='string'&&path.basename(args[0])==='evidence.json'){writing=true;await pending;}return originalFs.writeFile(...args);});
    const item=input(),held=2*item.blobs.get('entry')!.length+2*limits.maxOutputBytes+2*limits.maxMetadataBytes+32;
    const controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,terminationWaitMs:100,parentInFlightBytes:held},directoryRoot:root});
    try{
      const error=await controller.run(item.task,item.metadata,item.blobs).catch(error=>error);
      expect(writing).toBe(true);expect(error).toBeInstanceOf(NativeJobError);expect(error.code).toBe('NATIVE_EVIDENCE_UNCONFIRMED');
      expect(error.termination).toMatchObject({goAttempted:true,startedComputation:true,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false});
      await expect(controller.run(item.task,item.metadata,item.blobs)).rejects.toMatchObject({code:'NATIVE_CAPACITY_WAIT'});
      let idleFinished=false;const idle=controller.idle().then(()=>{idleFinished=true;});await delay(30);expect(idleFinished).toBe(false);
      releaseWrite();await idle;expect(error.code).toBe('NATIVE_EVIDENCE_UNCONFIRMED');expect(Object.isFrozen(error.termination)).toBe(true);
      const result=await controller.run(item.task,item.metadata,item.blobs);expect(result.blobs.get('archive')!.readUInt32LE(0)).toBe(0x04034b50);await controller.idle();
    }finally{releaseWrite();await controller.idle();}
  });
});
