import { constants,type Stats } from 'node:fs';
import { mkdir,open,lstat,realpath,unlink,type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../contracts/src/intent.js';
import { requireCondition,DomainError } from '../../contracts/src/errors.js';

// The recorded time is the start of a storage-observed interval of this precision.
export type ObjectReceipt={key:string;sha256:string;bytesLength:string;completedAt:string;completedAtPrecisionMilliseconds:1|1000};
export interface ObjectStore {readonly bucket:string;put(key:string,bytes:Buffer):Promise<ObjectReceipt>;read(key:string):Promise<Buffer>;receipt(key:string):Promise<ObjectReceipt|null>;remove(key:string):Promise<boolean>;presence?(key:string):Promise<'ABSENT'|'PRESENT'|'UNCONFIRMED'>}
const keyPattern=/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
// Current compact writer receipts are below 512 bytes; legacy precision-less
// receipts are smaller. This is a local metadata read bound, not an image cap.
const receiptMaxBytes=4096;
export class FileObjectStore implements ObjectStore {
  readonly bucket='local-private-v1';
  constructor(readonly root:string,readonly maxBytes:number,readonly clock:()=>Date=()=>new Date()) {}
  async file(key:string,create=false):Promise<string> {
    requireCondition(keyPattern.test(key),'INPUT_INVALID',422);
    const root=path.resolve(this.root);if(create) await mkdir(root,{recursive:true});
    const rootStat=await lstat(root);requireCondition(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'DEPENDENCY_UNAVAILABLE');
    const parent=path.join(root,key.split('/')[0]);if(create) await mkdir(parent,{recursive:true});
    const parentStat=await lstat(parent);requireCondition(parentStat.isDirectory()&&!parentStat.isSymbolicLink(),'DEPENDENCY_UNAVAILABLE');
    requireCondition(path.dirname(await realpath(parent))===await realpath(root),'DEPENDENCY_UNAVAILABLE');
    return path.join(parent,key.split('/')[1]);
  }
  async receipt(key:string):Promise<ObjectReceipt|null> {
    let stat:Stats,handle:FileHandle;
    try {const file=await this.file(key);stat=await lstat(file+'.receipt.json');requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=receiptMaxBytes,'DEPENDENCY_UNAVAILABLE');handle=await open(file+'.receipt.json',constants.O_RDONLY);}
    catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}
    try {
      const opened=await handle.stat();requireCondition(opened.isFile()&&opened.size<=receiptMaxBytes&&opened.dev===stat.dev&&opened.ino===stat.ino,'DEPENDENCY_UNAVAILABLE');
      // Read at most limit+1 even if the file grows after stat. Short reads
      // continue until actual EOF; the final extra byte detects overflow.
      const bytes=Buffer.alloc(receiptMaxBytes+1);let length=0;
      while(length<bytes.length){const value=await handle.read(bytes,length,bytes.length-length,length);if(value.bytesRead===0)break;length+=value.bytesRead;}
      requireCondition(length<=receiptMaxBytes,'DEPENDENCY_UNAVAILABLE');
      const finished=await handle.stat();requireCondition(finished.isFile()&&finished.size===length&&finished.dev===opened.dev&&finished.ino===opened.ino,'DEPENDENCY_UNAVAILABLE');
      const receipt=JSON.parse(bytes.subarray(0,length).toString('utf8')) as ObjectReceipt;requireCondition(receipt.key===key&&/^\d+$/.test(receipt.bytesLength)&&/^[0-9a-f]{64}$/.test(receipt.sha256)&&Number.isFinite(Date.parse(receipt.completedAt))&&new Date(receipt.completedAt).toISOString()===receipt.completedAt&&(receipt.completedAtPrecisionMilliseconds===undefined||receipt.completedAtPrecisionMilliseconds===1),'DEPENDENCY_UNAVAILABLE');
      // Older local receipts were written from Date.toISOString(), with the same millisecond precision.
      return {...receipt,completedAtPrecisionMilliseconds:1};
    } finally {await handle.close();}
  }
  async put(key:string,bytes:Buffer):Promise<ObjectReceipt> {
    requireCondition(bytes.length<=this.maxBytes,'INPUT_INVALID',422);const file=await this.file(key,true);const hash=sha256(bytes);
    const existing=await this.receipt(key);if(existing) {requireCondition(existing.sha256===hash&&BigInt(existing.bytesLength)===BigInt(bytes.length),'INTENT_CONFLICT');await this.read(key);return existing;}
    // A crash between intent and the first object byte must not become an absence proof.
    let intent;try{intent=await open(file+'.put-start.json','wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new DomainError('STORAGE_UNCONFIRMED',409,'WAIT');throw error;}
    try{await intent.writeFile(JSON.stringify({key,sha256:hash,bytesLength:String(bytes.length)}));await intent.sync();}finally{await intent.close();}
    let handle;try {handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);}catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST') throw new DomainError('STORAGE_UNCONFIRMED',409,'WAIT');throw error;}
    try {await handle.writeFile(bytes);await handle.sync();}finally {await handle.close();}
    await this.verifiedBytes(file,BigInt(bytes.length),hash,'STORAGE_FAILED',409);
    const receipt:ObjectReceipt={key,sha256:hash,bytesLength:bytes.length.toString(),completedAt:this.clock().toISOString(),completedAtPrecisionMilliseconds:1};
    const proof=await open(file+'.receipt.json','wx',0o600);try {await proof.writeFile(JSON.stringify(receipt));await proof.sync();}finally {await proof.close();}return receipt;
  }
  async presence(key:string):Promise<'ABSENT'|'PRESENT'|'UNCONFIRMED'> {
    try{const file=await this.file(key);let present=false;for(const suffix of ['', '.receipt.json','.put-start.json']){try{const stat=await lstat(file+suffix);if(!stat.isFile()||stat.isSymbolicLink())return 'UNCONFIRMED';if(suffix==='.put-start.json')return 'UNCONFIRMED';present=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return 'UNCONFIRMED';}}return present?'PRESENT':'ABSENT';}
    catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'ABSENT':'UNCONFIRMED';}
  }
  async read(key:string):Promise<Buffer> {
    const receipt=await this.receipt(key);requireCondition(receipt,'DEPENDENCY_UNAVAILABLE');const file=await this.file(key);const stat=await lstat(file);
    requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&Number.isSafeInteger(stat.size)&&stat.size>=0&&stat.size<=this.maxBytes&&BigInt(stat.size)===BigInt(receipt.bytesLength),'FILE_INVALID',422);
    return this.verifiedBytes(file,BigInt(receipt.bytesLength),receipt.sha256,'FILE_INVALID',422,stat);
  }
  private async verifiedBytes(file:string,expectedLength:bigint,expectedSha:string,code:string,status:number,observed?:Stats):Promise<Buffer> {
    const before=observed??await lstat(file);
    requireCondition(before.isFile()&&!before.isSymbolicLink()&&Number.isSafeInteger(before.size)&&before.size>=0&&before.size<=this.maxBytes&&BigInt(before.size)===expectedLength,code,status);
    const handle=await open(file,constants.O_RDONLY);
    try {
      const opened=await handle.stat();requireCondition(opened.isFile()&&Number.isSafeInteger(opened.size)&&opened.size===before.size&&opened.dev===before.dev&&opened.ino===before.ino,code,status);
      // The original receipt/input length owns this allocation. A growing
      // file never determines a larger Buffer; the separate EOF sentinel
      // also preserves valid empty and maximum-length Buffer objects.
      const bytes=Buffer.alloc(before.size);let length=0;
      while(length<bytes.length){const value=await handle.read(bytes,length,bytes.length-length,length);requireCondition(Number.isInteger(value.bytesRead)&&value.bytesRead>0&&value.bytesRead<=bytes.length-length,code,status);length+=value.bytesRead;}
      const eof=await handle.read(Buffer.alloc(1),0,1,length);requireCondition(eof.bytesRead===0,code,status);
      const finished=await handle.stat();requireCondition(finished.isFile()&&finished.size===length&&finished.dev===opened.dev&&finished.ino===opened.ino&&sha256(bytes)===expectedSha,code,status);return bytes;
    } finally {await handle.close();}
  }
  async remove(key:string):Promise<boolean> {
    const file=await this.file(key);for(const target of [file,file+'.receipt.json']) {
      try {const stat=await lstat(target);requireCondition(stat.isFile()&&!stat.isSymbolicLink(),'STORAGE_UNCONFIRMED');await unlink(target);}catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    }
    for(const target of [file,file+'.receipt.json']) {try {await lstat(target);return false;}catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}}return true;
  }
}
