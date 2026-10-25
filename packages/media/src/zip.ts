import yauzl from 'yauzl';
import yazl from 'yazl';
import type { Readable } from 'node:stream';
import { requireCondition,DomainError } from '../../contracts/src/errors.js';
import type { MediaProfile } from './profile.js';
import { requireProfile } from './profile.js';

export const safeEntry=(name:string)=>name.length<=160&&/^[A-Za-z0-9._/-]+$/.test(name)&&!name.startsWith('/')&&!name.endsWith('/')&&!name.split('/').some(p=>!p||p==='.'||p==='..');
export async function readZip(bytes:Buffer,profile:MediaProfile):Promise<Map<string,Buffer>> {
  requireProfile(profile);requireCondition(bytes.length<=profile.maxZipBytes,'FILE_INVALID',422);
  return new Promise((resolve,reject)=>{yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{
    if(error||!zip) {reject(new DomainError('FILE_INVALID',422));return;}
    const output=new Map<string,Buffer>();const names=new Set<string>();let expanded=0;let count=0;let ended=false;
    const fail=()=>{if(!ended){ended=true;zip.close();reject(new DomainError('FILE_INVALID',422));}};
    zip.on('error',fail);zip.on('end',()=>{if(!ended){ended=true;resolve(output);}});
    zip.on('entry',(entry)=>{
      const normalized=entry.fileName.normalize('NFC').toLowerCase();count++;
      if(count>profile.maxEntries||!safeEntry(entry.fileName)||names.has(normalized)||(entry.generalPurposeBitFlag&1)||((entry.externalFileAttributes>>>16)&0o170000)===0o120000||!Number.isSafeInteger(entry.uncompressedSize)||!Number.isSafeInteger(entry.compressedSize)||entry.uncompressedSize>profile.maxExpandedBytes||entry.uncompressedSize/Math.max(1,entry.compressedSize)>profile.maxRatio) {fail();return;}
      names.add(normalized);expanded+=entry.uncompressedSize;if(expanded>profile.maxExpandedBytes){fail();return;}
      zip.openReadStream(entry,(streamError,stream)=>{
        if(streamError||!stream){fail();return;}const chunks:Buffer[]=[];let length=0;
        stream.on('error',fail);stream.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>entry.uncompressedSize||length>profile.maxExpandedBytes){stream.destroy();fail();return;}chunks.push(chunk);});
        stream.on('end',()=>{if(ended)return;if(length!==entry.uncompressedSize){fail();return;}output.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
      });
    });zip.readEntry();
  });});
}
export async function writeZip(entries:Map<string,Buffer>,profile:MediaProfile):Promise<Buffer> {
  requireProfile(profile);requireCondition(entries.size<=profile.maxEntries,'INPUT_INVALID',422);let expanded=0;const normalized=new Set<string>();
  const zip=new yazl.ZipFile();for(const [name,bytes] of entries){requireCondition(safeEntry(name)&&!normalized.has(name.normalize('NFC').toLowerCase()),'INPUT_INVALID',422);normalized.add(name.normalize('NFC').toLowerCase());expanded+=bytes.length;requireCondition(expanded<=profile.maxExpandedBytes,'INPUT_INVALID',422);zip.addBuffer(bytes,name,{compressionLevel:6,mtime:new Date('2026-01-01T00:00:00Z'),mode:0o100600});}
  const result=new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];let length=0;zip.outputStream.on('error',reject);zip.outputStream.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>profile.maxZipBytes){(zip.outputStream as Readable).destroy(new DomainError('INPUT_INVALID',422));return;}chunks.push(chunk);});zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));});zip.end();return result;
}
