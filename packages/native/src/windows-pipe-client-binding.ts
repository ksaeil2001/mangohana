import path from 'node:path';
import {types,TextDecoder} from 'node:util';
import {DomainError} from '../../contracts/src/errors.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import type {WindowsPipeClientNativeBinding,WindowsPipeClientNativeOperation,WindowsPipeClientChannel,WindowsPipeClientOpenInput} from './windows-pipe-client.js';

export type WindowsPipeClientFile={path:string;bytes:number;sha256:string};
export type WindowsPipeClientPackage={version:1;platform:'win32';arch:'x64';napiVersion:8;node:WindowsPipeClientFile;binary:WindowsPipeClientFile;manifest:WindowsPipeClientFile};
export type WindowsPipeClientLoadLease={path:string;sha256:string;release():void};
export type WindowsPipeClientLoadPorts={read(ref:WindowsPipeClientFile):Promise<Buffer>;authorize(packet:WindowsPipeClientPackage):Promise<WindowsPipeClientLoadLease|null>;load(path:string):Promise<unknown>|unknown};
type Row=Record<string,unknown>;
const HEX=/^[0-9a-f]{64}$/,MAX_FILE=134217728,MAX_BINARY=67108864,MAX_MANIFEST=65536;
function fail(code='WINDOWS_PIPE_CLIENT_PACKAGE_INVALID'):never{throw new DomainError(code,409,'WAIT');}
function must(value:unknown,code?:string):asserts value{if(!value)fail(code);}
function record(value:unknown,keys:readonly string[]):Row{
 must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value));
 must(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
 const own=Reflect.ownKeys(value);must(own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)));
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);must(d?.enumerable&&'value'in d);}
 return value as Row;
}
function snapshot(value:unknown):unknown{
 let nodes=0,size=0;const active=new Set<object>();
 const visit=(v:unknown,depth:number):unknown=>{
  must(++nodes<=65536&&depth<=16,'WINDOWS_PIPE_CLIENT_PACKAGE_LIMIT');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){size+=v.length*4+2;must(size<=4194304,'WINDOWS_PIPE_CLIENT_PACKAGE_LIMIT');return v;}
  if(typeof v==='number'){must(Number.isSafeInteger(v)&&!Object.is(v,-0));return v;}
  must(v!==null&&typeof v==='object'&&!types.isProxy(v)&&!active.has(v));active.add(v);
  try{
   if(Array.isArray(v)){must(Object.getPrototypeOf(v)===Array.prototype&&v.length<=8192&&Reflect.ownKeys(v).length===v.length+1);const out=[];for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));must(d?.enumerable&&'value'in d);out.push(visit(d.value,depth+1));}return Object.freeze(out);}
   must(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);const out:Row=Object.create(null),keys=Reflect.ownKeys(v);must(keys.length<=64);
   for(const k of keys){must(typeof k==='string');size+=k.length*4;must(size<=4194304,'WINDOWS_PIPE_CLIENT_PACKAGE_LIMIT');const d=Object.getOwnPropertyDescriptor(v,k);must(d?.enumerable&&'value'in d);out[k]=visit(d.value,depth+1);}return Object.freeze(out);
  }finally{active.delete(v);}
 };
 return visit(value,0);
}
function localPath(value:unknown):string{
 must(typeof value==='string'&&value.length>=4&&value.length<=2048&&/^[A-Za-z]:[\\/]/.test(value)&&!/[\x00-\x1f<>"|?*]/.test(value));
 const parts=value.slice(3).split(/[\\/]/);must(parts.every(p=>p.length>0&&p!=='.'&&p!=='..'&&!/[. :]+$/.test(p)&&!p.includes(':')&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)));
 must(path.win32.normalize(value).replaceAll('\\','/').toLowerCase()===value.replaceAll('\\','/').toLowerCase());return value;
}
function key(value:string){return path.win32.normalize(value).toLowerCase();}
function hash(value:unknown):asserts value is string{must(typeof value==='string'&&HEX.test(value));}
function file(value:unknown,max=MAX_FILE):WindowsPipeClientFile{
 const f=record(value,['path','bytes','sha256']);localPath(f.path);must(typeof f.bytes==='number'&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=max);hash(f.sha256);return f as WindowsPipeClientFile;
}
async function read(ref:WindowsPipeClientFile,port:WindowsPipeClientLoadPorts['read']):Promise<Buffer>{
 const b=await port(ref);must(!types.isProxy(b)&&Buffer.isBuffer(b)&&b.length===ref.bytes&&sha256(b)===ref.sha256,'WINDOWS_PIPE_CLIENT_FILE_UNCONFIRMED');return b;
}
function parse(buffer:Buffer,max=MAX_MANIFEST):unknown{
 try{return snapshot(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer),max));}catch{fail();}
}
// 같은 닫힌 file/JSON/PE 계약을 빌드 진입점에서도 사용한다. 실제 파일·OS 공급자는 없다.
export const windowsPipeClientPackageTools=Object.freeze({must,record,snapshot,localPath,key,hash:(value:unknown):void=>{hash(value);},file,read,parse});
export type WindowsPipeClientPe={machine:0x8664;dll:boolean;exports:string[];imports:string[];importedFunctions:string[]};
export function inspectWindowsPipeClientPe(b:Buffer):WindowsPipeClientPe{
 must(Buffer.isBuffer(b)&&b.length>=512&&b.length<=MAX_BINARY);
 const fits=(at:number,n:number)=>Number.isSafeInteger(at)&&Number.isSafeInteger(n)&&at>=0&&n>=0&&at<=b.length-n;
 const u16=(at:number)=>{must(fits(at,2));return b.readUInt16LE(at);},u32=(at:number)=>{must(fits(at,4));return b.readUInt32LE(at);},u64=(at:number)=>{must(fits(at,8));return b.readBigUInt64LE(at);};
 must(b.toString('ascii',0,2)==='MZ');const pe=u32(0x3c);must(fits(pe,24)&&b.toString('ascii',pe,pe+4)==='PE\0\0'&&u16(pe+4)===0x8664);
 const count=u16(pe+6),opt=pe+24,optSize=u16(pe+20),table=opt+optSize;must(count>0&&count<=96&&optSize>=240&&fits(opt,optSize)&&u16(opt)===0x20b&&fits(table,count*40));
 const dirCount=u32(opt+108);must(dirCount>=2&&dirCount<=16);
 const sections:{rva:number;raw:number;rawSize:number;executable:boolean}[]=[];
 for(let i=0;i<count;i++){const at=table+i*40,virtualSize=u32(at+8),rva=u32(at+12),rawSize=u32(at+16),raw=u32(at+20);must(fits(raw,rawSize)&&rva+Math.max(virtualSize,rawSize)<=0x100000000);sections.push({rva,raw,rawSize,executable:(u32(at+36)&0x20000000)!==0});}
 const section=(rva:number,n:number)=>{must(Number.isSafeInteger(rva)&&rva>0&&Number.isSafeInteger(n)&&n>0);const found=sections.filter(s=>rva>=s.rva&&rva-s.rva<=s.rawSize-n);must(found.length===1);return found[0];};
 const offset=(rva:number,n:number)=>{const s=section(rva,n),at=s.raw+rva-s.rva;must(fits(at,n));return at;};
 const string=(rva:number,library=false)=>{const at=offset(rva,1);let end=at;while(end<b.length&&end-at<256&&b[end]!==0)end++;must(end<b.length&&end-at>0&&end-at<256&&b[end]===0);offset(rva,end-at+1);const s=b.toString('ascii',at,end);must((library?/^[A-Za-z0-9_.-]+$/:/^[A-Za-z0-9_?$@.-]+$/).test(s));return s;};
 const directory=(n:number)=>n<dirCount?{rva:u32(opt+112+n*8),size:u32(opt+116+n*8)}:{rva:0,size:0};
 // 지연 import와 forwarder는 이 작은 모듈의 승인되지 않은 공급 경로다.
 const delay=directory(13);must(delay.rva===0&&delay.size===0);
 const exports:string[]=[],imports:string[]=[],importedFunctions:string[]=[];const ex=directory(0);
 if(ex.rva||ex.size){
  must(ex.rva!==0&&ex.size>=40);const e=offset(ex.rva,ex.size),functions=u32(e+20),names=u32(e+24),address=u32(e+28),nameTable=u32(e+32),ordinals=u32(e+36);
  must(functions>0&&functions<=1024&&names>0&&names===functions);offset(address,functions*4);offset(nameTable,names*4);offset(ordinals,names*2);const used=new Set<number>();
  for(let i=0;i<names;i++){const ordinal=u16(offset(ordinals+i*2,2));must(ordinal<functions&&!used.has(ordinal));used.add(ordinal);const rva=u32(offset(address+ordinal*4,4));must(rva>0&&!(rva>=ex.rva&&rva-ex.rva<ex.size)&&section(rva,1).executable);offset(rva,1);exports.push(string(u32(offset(nameTable+i*4,4))));}
 }
 const im=directory(1);
 if(im.rva||im.size){
  must(im.rva!==0&&im.size>=20&&im.size<=20*129);const start=offset(im.rva,im.size);let ended=false;
  for(let at=start;at<=start+im.size-20;at+=20){
   if(b.subarray(at,at+20).every(v=>v===0)){ended=true;break;}
   must(imports.length<128);const library=string(u32(at+12),true).toLowerCase(),thunk=u32(at)||u32(at+16);must(thunk>0);imports.push(library);let thunkEnd=false;
   for(let i=0;i<4096;i++){const item=u64(offset(thunk+i*8,8));if(item===0n){thunkEnd=true;break;}must(item<=0xffffffffn&&importedFunctions.length<4096);const nameRva=Number(item);offset(nameRva,3);importedFunctions.push(library+'!'+string(nameRva+2));}
   must(thunkEnd);
  }
  must(ended);
 }
 must(new Set(exports).size===exports.length&&new Set(imports).size===imports.length&&new Set(importedFunctions).size===importedFunctions.length);return {machine:0x8664,dll:(u16(pe+22)&0x2000)!==0,exports:exports.sort(),imports:imports.sort(),importedFunctions:importedFunctions.sort()};
}
function packet(value:unknown):WindowsPipeClientPackage{
 const p=record(snapshot(value),['version','platform','arch','napiVersion','node','binary','manifest']);must(p.version===1&&p.platform==='win32'&&p.arch==='x64'&&p.napiVersion===8);
 file(p.node);const b=file(p.binary,MAX_BINARY),m=file(p.manifest,MAX_MANIFEST);must(/\.node$/i.test(b.path)&&/\.json$/i.test(m.path)&&key((p.node as WindowsPipeClientFile).path)===key(process.execPath)&&new Set([key(b.path),key(m.path),key((p.node as WindowsPipeClientFile).path)]).size===3);return p as WindowsPipeClientPackage;
}
function same(a:unknown,b:unknown){return digest(a)===digest(b);}
function fixedChannel(value:unknown,closed:Promise<void>):WindowsPipeClientChannel{
 const c=record(value,['readInto','write','close','closed']);must(c.closed===closed&&typeof c.readInto==='function'&&typeof c.write==='function'&&typeof c.close==='function','WINDOWS_PIPE_NATIVE_CONTRACT');
 return Object.freeze({readInto:c.readInto.bind(value),write:c.write.bind(value),close:c.close.bind(value),closed}) as WindowsPipeClientChannel;
}
function fixedBinding(value:unknown):WindowsPipeClientNativeBinding{
 const b=record(value,['open']);must(typeof b.open==='function','WINDOWS_PIPE_NATIVE_CONTRACT');const open=b.open.bind(value);
 return Object.freeze({open:(input:WindowsPipeClientOpenInput):WindowsPipeClientNativeOperation=>{
  const op=open(input),o=record(op,['ready','cancel','closed']);must(types.isPromise(o.ready)&&types.isPromise(o.closed)&&typeof o.cancel==='function','WINDOWS_PIPE_NATIVE_CONTRACT');
  const closed=o.closed as Promise<void>;const ready=(o.ready as Promise<unknown>).then(v=>fixedChannel(v,closed));void ready.catch(()=>{});
  return Object.freeze({ready,cancel:o.cancel.bind(op),closed}) as WindowsPipeClientNativeOperation;
 }});
}
export function createWindowsPipeClientBindingLoader(ports:WindowsPipeClientLoadPorts){
 const p=record(ports,['read','authorize','load']);must(typeof p.read==='function'&&typeof p.authorize==='function'&&typeof p.load==='function');
 const readPort=p.read.bind(ports) as WindowsPipeClientLoadPorts['read'],authorize=p.authorize.bind(ports) as WindowsPipeClientLoadPorts['authorize'],load=p.load.bind(ports) as WindowsPipeClientLoadPorts['load'];
 const factories=new WeakMap<object,()=>unknown>();
 return Object.freeze({loadWindowsPipeClientBinding:async(value:unknown):Promise<WindowsPipeClientNativeBinding>=>{
  const a=packet(value);must(process.platform==='win32'&&process.arch==='x64'&&process.versions.node==='24.11.1'&&Number(process.versions.napi)>=8,'WINDOWS_PIPE_CLIENT_RUNTIME_UNCONFIRMED');
  const rawLease=await authorize(a);must(rawLease!==null,'WINDOWS_PIPE_CLIENT_LOAD_AUTHORITY_REQUIRED');const l=record(rawLease,['path','sha256','release']);must(typeof l.release==='function');const release=l.release.bind(rawLease);let primary:unknown,failed=false;
  try{
   must(l.path===a.binary.path&&l.sha256===a.binary.sha256,'WINDOWS_PIPE_CLIENT_LOAD_AUTHORITY_REQUIRED');
   const m=record(parse(await read(a.manifest,readPort)),['version','sourceDigest','toolchainDigest','platform','arch','napiVersion','node','binary','exports','peExports','imports']);
   hash(m.sourceDigest);hash(m.toolchainDigest);must(m.version===1&&m.platform==='win32'&&m.arch==='x64'&&m.napiVersion===8&&same(m.node,a.node)&&same(m.binary,a.binary)&&same(m.exports,['createBinding'])&&same(m.peExports,['napi_register_module_v1','node_api_module_get_api_version_v1']));
   await read(a.node,readPort);const binary=await read(a.binary,readPort),pe=inspectWindowsPipeClientPe(binary);
   must(pe.dll&&same(pe.exports,m.peExports)&&same(pe.imports,m.imports)&&pe.imports.includes('node.exe')&&pe.imports.every(i=>['node.exe','kernel32.dll','advapi32.dll','bcrypt.dll'].includes(i)));
   const module=await load(a.binary.path),mod=record(module,['createBinding']);must(typeof mod.createBinding==='function','WINDOWS_PIPE_NATIVE_CONTRACT');
   let create=factories.get(module as object);if(!create){create=mod.createBinding.bind(module) as ()=>unknown;factories.set(module as object,create);}
   return fixedBinding(create());
  }catch(e){failed=true;primary=e;throw e;}
  finally{try{release();}catch(e){if(failed)throw new AggregateError([primary,e],'WINDOWS_PIPE_CLIENT_LOAD_CLEANUP_UNCONFIRMED');throw e;}}
 }});
}
