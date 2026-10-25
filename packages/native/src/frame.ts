import type {Writable} from 'node:stream';
import {TextDecoder} from 'node:util';
import {parseStrictJson} from '../../contracts/src/json.js';
import {sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {nativeJsonBytes,validateNativeEnvelope,type NativeFrameLimits,type NativeJob,type NativeResult} from './dto.js';

const magic=Buffer.from('TMNATV1\0','ascii');
export type NativeFrame<T>={envelope:T;blobs:Map<string,Buffer>};
export class NativeReader {
  private readonly iterator:AsyncIterator<Uint8Array>;
  private pending:Uint8Array=new Uint8Array(0);
  private at=0;private received=0;private ended=false;
  constructor(source:AsyncIterable<Uint8Array>,readonly maxReceivedBytes:number){requireCondition(Number.isSafeInteger(maxReceivedBytes)&&maxReceivedBytes>0,'NATIVE_PROTOCOL_INVALID',422);this.iterator=source[Symbol.asyncIterator]();}
  private async next():Promise<boolean>{const item=await this.iterator.next();if(item.done){this.ended=true;return false;}requireCondition(item.value instanceof Uint8Array,'NATIVE_PROTOCOL_INVALID',422);this.received+=item.value.byteLength;requireCondition(Number.isSafeInteger(this.received)&&this.received<=this.maxReceivedBytes,'NATIVE_BINARY_LIMIT',413,'WAIT');this.pending=item.value;this.at=0;return true;}
  async exact(length:number):Promise<Buffer>{requireCondition(Number.isSafeInteger(length)&&length>=0&&length<=this.maxReceivedBytes,'NATIVE_BINARY_LIMIT',413,'WAIT');const output=Buffer.allocUnsafe(length);let filled=0;while(filled<length){if(this.at===this.pending.byteLength){requireCondition(!this.ended&&await this.next(),'NATIVE_PROTOCOL_TRUNCATED',422);if(!this.pending.byteLength)continue;}const count=Math.min(length-filled,this.pending.byteLength-this.at);output.set(this.pending.subarray(this.at,this.at+count),filled);filled+=count;this.at+=count;}return output;}
  async end():Promise<void>{requireCondition(this.at===this.pending.byteLength,'NATIVE_PROTOCOL_TRAILING',422);while(!this.ended){requireCondition(!await this.next()||this.pending.byteLength===0,'NATIVE_PROTOCOL_TRAILING',422);}}
}
export async function readNativeFrame<T extends NativeJob|NativeResult>(reader:NativeReader,limits:NativeFrameLimits):Promise<NativeFrame<T>> {
  const prefix=await reader.exact(12);requireCondition(prefix.subarray(0,8).equals(magic),'NATIVE_PROTOCOL_INVALID',422);const length=prefix.readUInt32BE(8);requireCondition(length>0&&length<=limits.maxMetadataBytes,'NATIVE_METADATA_LIMIT',413,'WAIT');const bytes=await reader.exact(length);
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('NATIVE_PROTOCOL_UTF8');}
  const envelope=parseStrictJson(text,limits.maxMetadataBytes);validateNativeEnvelope(envelope,limits);const blobs=new Map<string,Buffer>();
  // All declarations and their sum were validated before any binary buffer is allocated.
  for(const descriptor of envelope.blobs){const output=await reader.exact(descriptor.byteLength);requireCondition(sha256(output)===descriptor.sha256,'NATIVE_BINARY_MISMATCH',422);blobs.set(descriptor.id,output);}await reader.end();return {envelope:envelope as T,blobs};
}
export async function writeNativeBytes(stream:Writable,bytes:Buffer):Promise<void> {await new Promise<void>((resolve,reject)=>{stream.write(bytes,error=>error?reject(new Error('NATIVE_PROTOCOL_WRITE')):resolve());});}
export async function writeNativeFrame<T extends NativeJob|NativeResult>(stream:Writable,frame:NativeFrame<T>,limits:NativeFrameLimits):Promise<void> {
  validateNativeEnvelope(frame.envelope,limits);requireCondition(frame.blobs.size===frame.envelope.blobs.length,'NATIVE_BINARY_MISMATCH',422);const metadata=nativeJsonBytes(frame.envelope,limits.maxMetadataBytes);const prefix=Buffer.alloc(12);magic.copy(prefix);prefix.writeUInt32BE(metadata.length,8);await writeNativeBytes(stream,prefix);await writeNativeBytes(stream,metadata);
  for(const item of frame.envelope.blobs){const bytes=frame.blobs.get(item.id);requireCondition(bytes&&bytes.length===item.byteLength&&sha256(bytes)===item.sha256,'NATIVE_BINARY_MISMATCH',422);await writeNativeBytes(stream,bytes);}
}
