import {describe,it,expect,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createNativeJob,createNativeResult,nativeJsonBytes,verifyNativeInput,verifyNativeResult,type NativeJob} from '../../packages/native/src/dto.js';
import {NativeReader,readNativeFrame,writeNativeFrame} from '../../packages/native/src/frame.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';

const limits={maxMetadataBytes:4096,maxBinaryBytes:1024,maxItems:4};
async function* chunks(bytes:Buffer,size=7){for(let at=0;at<bytes.length;at+=size)yield bytes.subarray(at,at+size);}
async function encoded(job:NativeJob,blobs:Map<string,Buffer>){const output=new PassThrough();const reading=(async()=>{const parts:Buffer[]=[];for await(const part of output)parts.push(part as Buffer);return Buffer.concat(parts);})();await writeNativeFrame(output,{envelope:job,blobs},limits);output.end();return reading;}
function rawFrame(metadata:Buffer,payload=Buffer.alloc(0)){const prefix=Buffer.alloc(12);prefix.write('TMNATV1\0',0,'ascii');prefix.writeUInt32BE(metadata.length,8);return Buffer.concat([prefix,metadata,payload]);}
function job(){const blobs=new Map([['source',Buffer.from([0,255,0,123])]]);return {envelope:createNativeJob('DECODE_IMAGE',digest(syntheticProfile),{profile:syntheticProfile,sourceId:'source'},blobs,limits),blobs};}

describe('bounded native binary frames',()=>{
  it('round trips segmented raw binary without JSON/base64 conversion',async()=>{const input=job(),bytes=await encoded(input.envelope,input.blobs);const read=await readNativeFrame<NativeJob>(new NativeReader(chunks(bytes,1),bytes.length),limits);expect(read.envelope).toEqual(input.envelope);expect(read.blobs.get('source')).toEqual(input.blobs.get('source'));verifyNativeInput(read.envelope);});
  it('rejects an oversized metadata declaration before allocation or payload consumption',async()=>{const prefix=Buffer.alloc(12);prefix.write('TMNATV1\0',0,'ascii');prefix.writeUInt32BE(0xffffffff,8);let extraRead=false;async function* malicious(){yield prefix;extraRead=true;yield Buffer.alloc(1);}const allocator=vi.spyOn(Buffer,'allocUnsafe');try{await expect(readNativeFrame(new NativeReader(malicious(),5000),limits)).rejects.toMatchObject({code:'NATIVE_METADATA_LIMIT'});expect(extraRead).toBe(false);expect(allocator.mock.calls.every(([size])=>size<=limits.maxMetadataBytes)).toBe(true);}finally{allocator.mockRestore();}});
  it('rejects the summed binary declaration before allocating any declared payload',async()=>{const item=job().envelope;item.blobs=[{id:'a',byteLength:600,sha256:sha256('a')},{id:'b',byteLength:600,sha256:sha256('b')}];const metadata=Buffer.from(JSON.stringify(item));let payloadRead=false;async function* malicious(){yield rawFrame(metadata);payloadRead=true;yield Buffer.alloc(1200);}await expect(readNativeFrame(new NativeReader(malicious(),6000),limits)).rejects.toMatchObject({code:'NATIVE_BINARY_LIMIT'});expect(payloadRead).toBe(false);});
  it('rejects duplicate metadata keys and invalid UTF-8 before binary input',async()=>{const input=job().envelope;const text=JSON.stringify(input).replace('"version":1','"version":1,"version":1');await expect(readNativeFrame(new NativeReader(chunks(rawFrame(Buffer.from(text))),6000),limits)).rejects.toMatchObject({code:'INPUT_INVALID'});await expect(readNativeFrame(new NativeReader(chunks(rawFrame(Buffer.from([0xc3,0x28]))),6000),limits)).rejects.toThrow('NATIVE_PROTOCOL_UTF8');});
  it('rejects forged binary SHA, truncation and trailing bytes',async()=>{const input=job(),bytes=await encoded(input.envelope,input.blobs);const forged=Buffer.from(bytes);forged[forged.length-1]^=1;await expect(readNativeFrame(new NativeReader(chunks(forged),6000),limits)).rejects.toMatchObject({code:'NATIVE_BINARY_MISMATCH'});await expect(readNativeFrame(new NativeReader(chunks(bytes.subarray(0,bytes.length-1)),6000),limits)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRUNCATED'});await expect(readNativeFrame(new NativeReader(chunks(Buffer.concat([bytes,Buffer.from([1])])),6000),limits)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRAILING'});});
  it('captures immutable metadata and fences result job/profile/task/input identity',()=>{const input=job(),metadata={profile:structuredClone(syntheticProfile),sourceId:'source'};const captured=createNativeJob('DECODE_IMAGE',digest(syntheticProfile),metadata,input.blobs,limits);metadata.sourceId='changed';expect(captured.metadata.sourceId).toBe('source');const result=createNativeResult(captured,{metadata:{width:1},blobs:new Map()},limits);verifyNativeResult(captured,result);for(const mutation of [{jobId:randomUUID()},{task:'ZIP_READ' as const},{inputDigest:sha256('different')},{profileDigest:sha256('different-profile')}])expect(()=>verifyNativeResult(captured,{...result,...mutation})).toThrow('NATIVE_OUTPUT_MISMATCH');expect(()=>verifyNativeInput({...captured,metadata:{...captured.metadata,sourceId:'changed'}})).toThrow('NATIVE_INPUT_MISMATCH');});
  it('refuses getters, Buffer metadata, custom objects, cycles and lone surrogates',()=>{let evaluated=0;const getter=Object.defineProperty({},'secret',{enumerable:true,get(){evaluated++;return 'hidden';}});expect(()=>nativeJsonBytes(getter,4096)).toThrow('NATIVE_PROTOCOL_INVALID');expect(evaluated).toBe(0);const cyclic:Record<string,unknown>={};cyclic.self=cyclic;for(const item of [{bytes:Buffer.from('private')},{date:new Date()},cyclic,{text:'\ud800'}])expect(()=>nativeJsonBytes(item,4096)).toThrow('NATIVE_PROTOCOL_INVALID');});
  it.each(['root object','nested object','root array','nested array'])('refuses %s Proxy metadata before reflection or serialization traps',(placement)=>{
    const traps={
      get:vi.fn((target:object,key:PropertyKey,receiver:unknown)=>Reflect.get(target,key,receiver)),
      ownKeys:vi.fn((target:object)=>Reflect.ownKeys(target)),
      getPrototypeOf:vi.fn((target:object)=>Reflect.getPrototypeOf(target)),
      getOwnPropertyDescriptor:vi.fn((target:object,key:PropertyKey)=>Reflect.getOwnPropertyDescriptor(target,key)),
    };
    const proxy=new Proxy<object>(placement.includes('array')?[1,{owned:true}]:{owned:true},traps);
    const metadata=placement.startsWith('root')?proxy:{owned:proxy};let error:unknown;
    try{nativeJsonBytes(metadata,4096);}catch(caught){error=caught;}
    expect({code:error instanceof Error?error.message:null,get:traps.get.mock.calls.length,ownKeys:traps.ownKeys.mock.calls.length,getPrototypeOf:traps.getPrototypeOf.mock.calls.length,getOwnPropertyDescriptor:traps.getOwnPropertyDescriptor.mock.calls.length})
      .toEqual({code:'NATIVE_PROTOCOL_INVALID',get:0,ownKeys:0,getPrototypeOf:0,getOwnPropertyDescriptor:0});
  });
});
