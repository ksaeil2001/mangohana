import {randomBytes} from 'node:crypto';
import {Duplex} from 'node:stream';
import {types} from 'node:util';
import {DomainError} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {encodeWindowsControl,type OriginalCapture} from './windows-job-backend.js';
import type {NativeControllerMemoryOwner} from './controller-attempts.js';
import type {WindowsBrokerBounds,WindowsBrokerConnectOperation,WindowsBrokerPorts,WindowsBrokerProcess,WindowsBrokerRegistration} from './windows-job-broker.js';

type Lane='CONTROL'|'IN'|'OUT'|'ERR';
type Row=Record<string,unknown>;
type Release=()=>void;
export type WindowsPipeClientOpenInput={
 name:string;lane:Lane;hostProcess:WindowsBrokerProcess;controllerProcess:WindowsBrokerProcess;
 hostSidDigest:string;controllerSidDigest:string;pipeAclDigest:string;
 desiredAccess:0x12008b;shareMode:0;creationDisposition:3;flags:0x40110000;inheritHandle:false;
};
export type WindowsPipeClientChannel={
 readInto(buffer:Buffer):Promise<{bytesRead:number;eof:boolean}>;
 write(buffer:Buffer):Promise<number>;close(reason:string):void;closed:Promise<void>;
};
export type WindowsPipeClientNativeOperation={
 ready:Promise<WindowsPipeClientChannel>;cancel(reason:string):void;closed:Promise<void>;
};
export type WindowsPipeClientNativeBinding={open(input:WindowsPipeClientOpenInput):WindowsPipeClientNativeOperation};
export type WindowsPipeClientOptions={
 registration:WindowsBrokerRegistration;bounds:WindowsBrokerBounds;clientBudgetBytes:number;
 memory:NativeControllerMemoryOwner;
 authority:{resolve(name:string):Promise<{capture:OriginalCapture;pipeAclDigest:string}|null>;current(capture:OriginalCapture):Promise<boolean>};
 binding:WindowsPipeClientNativeBinding;
};

const localInputClosed=new WeakMap<Duplex,Error>();
export function readWindowsPipeClientLocalInputClose(stream:Duplex):Error|null{return localInputClosed.get(stream)??null;}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,HEX=/^[0-9a-f]{64}$/;
const BASE_BYTES=278528,CONTROL_BYTES=65536;
function error(code='WINDOWS_PIPE_CLIENT_INVALID'){return new DomainError(code,409,'WAIT');}
function must(value:unknown,code='WINDOWS_PIPE_CLIENT_INVALID'):asserts value{if(!value)throw error(code);}
function originalError(value:unknown):Error{return value instanceof Error?value:error('WINDOWS_PIPE_CLIENT_FAILURE');}
function object(value:unknown,keys:readonly string[]):Row{
 must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value));
 must(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
 const own=Reflect.ownKeys(value);must(own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)));
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);must(d?.enumerable&&'value'in d);}
 return value as Row;
}
// native channel은 class도 허용하되 getter와 proxy의 실행은 막는다.
function nativeMember(value:unknown,key:string):unknown{
 must(value!==null&&typeof value==='object'&&!types.isProxy(value),'WINDOWS_PIPE_NATIVE_CONTRACT');
 let current:object|null=value;
 for(let depth=0;current&&depth<8;depth++){
  must(!types.isProxy(current),'WINDOWS_PIPE_NATIVE_CONTRACT');
  const d=Object.getOwnPropertyDescriptor(current,key);
  if(d){must('value'in d,'WINDOWS_PIPE_NATIVE_CONTRACT');return d.value;}
  current=Object.getPrototypeOf(current);
 }
 throw error('WINDOWS_PIPE_NATIVE_CONTRACT');
}
function positive(value:unknown,max=Number.MAX_SAFE_INTEGER):asserts value is number{must(typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=max);}
function hash(value:unknown):asserts value is string{must(typeof value==='string'&&HEX.test(value));}
function uuid(value:unknown){must(typeof value==='string'&&UUID.test(value));}
// getter와 proxy를 실행하지 않고 상한 안의 원 데이터만 복사한다.
function snapshot<T>(value:T):T{
 let nodes=0,bytes=0;const active=new Set<object>();
 const visit=(v:unknown,depth:number):unknown=>{
  must(++nodes<=8192&&depth<=20,'WINDOWS_PIPE_CLIENT_LIMIT');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){bytes+=v.length*2+2;must(bytes<=131072&&/^[\x20-\x7e]*$/.test(v),'WINDOWS_PIPE_CLIENT_LIMIT');return v;}
  if(typeof v==='number'){must(Number.isSafeInteger(v)&&!Object.is(v,-0));return v;}
  must(v!==null&&typeof v==='object'&&!types.isProxy(v)&&!active.has(v));active.add(v);
  try{
   if(Array.isArray(v)){
    must(Object.getPrototypeOf(v)===Array.prototype&&v.length<=8192&&Reflect.ownKeys(v).length===v.length+1);
    const copy=[];for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));must(d?.enumerable&&'value'in d);copy.push(visit(d.value,depth+1));}return Object.freeze(copy);
   }
   must(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
   const copy:Row=Object.create(null),keys=Reflect.ownKeys(v);must(keys.length<=8192);
   for(const k of keys){must(typeof k==='string');visit(k,depth+1);const d=Object.getOwnPropertyDescriptor(v,k);must(d?.enumerable&&'value'in d);copy[k]=visit(d.value,depth+1);}
   return Object.freeze(copy);
  }finally{active.delete(v);}
 };
 return visit(value,0) as T;
}
function processIdentity(value:unknown):WindowsBrokerProcess{
 const p=object(value,['pid','creationFileTime100ns','windowsSessionId']);positive(p.pid,0xffffffff);
 must(typeof p.windowsSessionId==='number'&&Number.isSafeInteger(p.windowsSessionId)&&p.windowsSessionId>=0&&p.windowsSessionId<=0xffffffff);
 must(typeof p.creationFileTime100ns==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(p.creationFileTime100ns)&&BigInt(p.creationFileTime100ns)<=18446744073709551615n);
 return snapshot(p) as WindowsBrokerProcess;
}
function captureCopy(value:OriginalCapture,r:WindowsBrokerRegistration):OriginalCapture{
 const c=snapshot(value);object(c,['origin','originDigest','frameInputDigest','launchRef']);hash(c.originDigest);hash(c.frameInputDigest);uuid(c.launchRef);
 encodeWindowsControl({version:1,requestId:r.endpointId,originDigest:c.originDigest,attemptId:c.origin.authority.attemptId,sessionId:c.origin.authority.sessionId,launchId:c.origin.authority.launchId,command:'PREPARE',payload:{origin:c.origin,launchRef:c.launchRef}});
 const o=c.origin,a=o.authority;
 must(c.originDigest===digest({identity:o.identity,authority:o.authority,pins:o.pins,policy:o.policy,nativeLimitsDigest:digest(o.limits),frameInputDigest:c.frameInputDigest})&&c.frameInputDigest===o.identity.binding.inputDigest,'WINDOWS_CAPTURE_MISMATCH');
 must(a.hostEpochId===r.hostEpochId&&a.environmentDigest===r.environmentDigest&&a.controllerInstanceId===r.controllerInstanceId&&a.controllerSidDigest===r.controllerSidDigest,'WINDOWS_REGISTRATION_MISMATCH');
 return c;
}
function pipeBase(r:WindowsBrokerRegistration){return '\\\\.\\pipe\\trio-w5a-'+r.endpointId+'-'+r.hostEpochId;}
function pipeName(r:WindowsBrokerRegistration,c:OriginalCapture,lane:Lane){return pipeBase(r)+(lane==='CONTROL'?'-ctl':'-'+c.origin.authority.sessionId+'-'+c.origin.authority.launchId+'-'+c.originDigest.slice(0,16)+'-'+lane.toLowerCase());}
function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});
 return {promise,resolve,reject};
}
function promise<T>(v:unknown):asserts v is Promise<T>{must(types.isPromise(v),'WINDOWS_PIPE_NATIVE_CONTRACT');}

class Budget{
 private base:Release[]=[];private direct=0;private control=0;poisoned=false;queued=0;
 constructor(readonly memory:NativeControllerMemoryOwner,readonly cap:number,readonly maxQueued:number){}
 start(){
  if(this.base.length)return;
  must(this.memory.available()>=BASE_BYTES,'WINDOWS_PIPE_CLIENT_CAPACITY');
  try{for(const n of [16384,65536,196608]){must(this.memory.available()>=n,'WINDOWS_PIPE_CLIENT_CAPACITY');const free=this.memory.hold(n);must(typeof free==='function');this.base.push(free);}}
  catch(e){this.finish();throw e;}
 }
 hold(n:number,control:boolean):Release{
  must(Number.isSafeInteger(n)&&n>0&&!this.poisoned,'WINDOWS_PIPE_CLIENT_CAPACITY');
  const pooled=control?Math.min(n,CONTROL_BYTES-this.control):0,extra=n-pooled;
  must(BASE_BYTES+this.direct+extra<=this.cap&&(!extra||this.memory.available()>=extra),'WINDOWS_PIPE_CLIENT_CAPACITY');
  const free=extra?this.memory.hold(extra):()=>{};must(typeof free==='function');this.control+=pooled;this.direct+=extra;
  let active=true;return ()=>{if(!active)return;try{free();}catch(e){this.poisoned=true;throw e;}active=false;this.control-=pooled;this.direct-=extra;};
 }
 finish(){
  must(!this.poisoned&&this.direct===0&&this.control===0&&this.queued===0,'WINDOWS_PIPE_CLIENT_ACCOUNTING');
  while(this.base.length){const free=this.base.at(-1)!;try{free();}catch(e){this.poisoned=true;throw e;}this.base.pop();}
 }
}
type Ticket={buffer:Buffer;free:Release;nativeDone:boolean;queueDone:boolean};
type ReadLoan={remaining:number;free:Release};

class Manager{
 readonly budget:Budget;readonly contexts=new Set<Connection>();readonly names=new Set<string>();
 private pin:{capture:OriginalCapture;captureDigest:string;pipeAclDigest:string}|null=null;
 private queryTail=Promise.resolve();
 constructor(readonly options:WindowsPipeClientOptions){this.budget=new Budget(options.memory,options.clientBudgetBytes,options.bounds.maxQueuedBytes);}
 connect(name:string,hwm:number):WindowsBrokerConnectOperation{
  const c=new Connection(this,name,hwm);this.contexts.add(c);
  void Promise.resolve().then(()=>c.prepare());
  return Object.freeze({ready:c.ready.promise,closed:c.closed.promise,cancel:(reason:string)=>c.cancel(reason)});
 }
 validateName(name:string,hwm:number):Lane{
  positive(hwm,this.options.bounds.streamHighWaterMarkBytes);must(typeof name==='string'&&name.length<=260&&name.startsWith(pipeBase(this.options.registration)),'WINDOWS_PIPE_NAME');
  const suffix=name.slice(pipeBase(this.options.registration).length);
  const lane=suffix==='-ctl'?'CONTROL':suffix.endsWith('-in')?'IN':suffix.endsWith('-out')?'OUT':suffix.endsWith('-err')?'ERR':null;
  must(lane&&(lane==='CONTROL'||/^-[0-9a-f-]{36}-[0-9a-f-]{36}-[0-9a-f]{16}-(in|out|err)$/.test(suffix)),'WINDOWS_PIPE_NAME');
  must(!this.names.has(name)&&this.names.size<4,'WINDOWS_PIPE_CLIENT_REPLAY');this.names.add(name);return lane;
 }
 async authority(name:string,lane:Lane,cancelled:()=>boolean){
  const v=await this.options.authority.resolve(name);if(cancelled())throw error('WINDOWS_PIPE_CLIENT_CANCELLED');
  const read=()=>{
   const r=object(v,['capture','pipeAclDigest']);hash(r.pipeAclDigest);
   const capture=captureCopy(r.capture as OriginalCapture,this.options.registration);must(name===pipeName(this.options.registration,capture,lane),'WINDOWS_PIPE_NAME');
   const next={capture,captureDigest:digest(capture),pipeAclDigest:r.pipeAclDigest};
   if(this.pin)must(this.pin.captureDigest===next.captureDigest&&this.pin.pipeAclDigest===next.pipeAclDigest,'WINDOWS_PIPE_CAPTURE_PIN');else this.pin=next;
   return next;
  };
  const before=read();must(await this.options.authority.current(before.capture)===true,'WINDOWS_PIPE_AUTHORITY_CURRENT');
  if(cancelled())throw error('WINDOWS_PIPE_CLIENT_CANCELLED');const after=read();must(before.captureDigest===after.captureDigest&&before.pipeAclDigest===after.pipeAclDigest,'WINDOWS_PIPE_CAPTURE_PIN');
  return after;
 }
 async query(){
  const previous=this.queryTail,next=deferred<void>();this.queryTail=next.promise;await previous;return ()=>next.resolve();
 }
 complete(c:Connection){
  if(this.contexts.size===1)this.budget.finish();this.contexts.delete(c);c.closed.resolve();
 }
}

class Connection{
 readonly ready=deferred<Duplex>();readonly closed=deferred<void>();
 private resource=deferred<void>();private resourceDone=false;private prepared=false;
 private native:WindowsPipeClientNativeOperation|null=null;private channel:WindowsPipeClientChannel|null=null;
 private nativeReadyDone=false;private nativeClosedDone=false;private unconfirmed=false;
 private socket:Duplex|null=null;private jsClosed=false;private stopped=false;private failure:Error|null=null;
 private lane:Lane|null=null;private pending=0;private reading=false;private writing=false;private eof=false;
 private finalRequested=false;private finalCallback:((error?:Error|null)=>void)|null=null;
 private closeRequested=false;private cancelRequested=false;private completed=false;
 private tickets=new Set<Ticket>();private ticketByBuffer=new WeakMap<Buffer,Ticket>();
 private loans:ReadLoan[]=[];private retired:Release[]=[];
 constructor(readonly manager:Manager,readonly name:string,readonly hwm:number){}
 async prepare(){
  let releaseQuery:Release|undefined;
  try{
   if(this.stopped)return;this.lane=this.manager.validateName(this.name,this.hwm);
   releaseQuery=await this.manager.query();if(this.stopped)return;
   const approved=await this.manager.authority(this.name,this.lane,()=>this.stopped);if(this.stopped)return;
   this.manager.budget.start();
   const r=this.manager.options.registration,input:WindowsPipeClientOpenInput=Object.freeze({
    name:this.name,lane:this.lane,hostProcess:r.hostProcess,controllerProcess:r.controllerProcess,
    hostSidDigest:r.hostSidDigest,controllerSidDigest:r.controllerSidDigest,
    pipeAclDigest:approved.pipeAclDigest,
    desiredAccess:0x12008b,shareMode:0,creationDisposition:3,flags:0x40110000,inheritHandle:false
   });
   if(this.stopped)return;
   try{this.native=this.manager.options.binding.open(input);}catch(e){this.unconfirmed=true;throw e;}
   const operation=object(this.native,['ready','cancel','closed']);must(typeof operation.cancel==='function','WINDOWS_PIPE_NATIVE_CONTRACT');
   promise<WindowsPipeClientChannel>(operation.ready);promise<void>(operation.closed);
   void this.native.closed.then(()=>{
    this.nativeClosedDone=true;
    if(!this.stopped&&!this.finalRequested&&!this.eof)this.fail(error('WINDOWS_PIPE_NATIVE_CLOSED'));
    this.check();
   },e=>{this.unconfirmed=true;this.fail(e);});
   let channel:WindowsPipeClientChannel;
   try{channel=await this.native.ready;}
   catch(e){this.nativeReadyDone=true;throw e;}
   try{
    const readInto=nativeMember(channel,'readInto'),write=nativeMember(channel,'write'),close=nativeMember(channel,'close'),closed=nativeMember(channel,'closed');
    must(typeof readInto==='function'&&typeof write==='function'&&typeof close==='function'&&closed===this.native.closed,'WINDOWS_PIPE_NATIVE_CONTRACT');
    this.channel=Object.freeze({readInto:readInto.bind(channel),write:write.bind(channel),close:close.bind(channel),closed}) as WindowsPipeClientChannel;
   }catch(e){this.unconfirmed=true;throw e;}
   finally{this.nativeReadyDone=true;}
   if(this.stopped||this.nativeClosedDone){this.requestClose(this.stopped?'CANCELLED':'CLOSED_BEFORE_READY');throw this.failure??error('WINDOWS_PIPE_NATIVE_CLOSED');}
   await this.manager.authority(this.name,this.lane,()=>this.stopped);
   if(this.stopped||this.nativeClosedDone)throw this.failure??error('WINDOWS_PIPE_NATIVE_CLOSED');
   this.socket=this.createStream();this.ready.resolve(this.socket);
  }catch(e){this.fail(e);}
  finally{this.prepared=true;releaseQuery?.();this.check();}
 }
 cancel(reason:string){
  if(this.stopped)return;
  this.stopped=true;this.failure??=error('WINDOWS_PIPE_CLIENT_CANCELLED');this.ready.reject(this.failure);
  this.requestClose(reason);this.socket?.destroy(this.failure);this.check();
 }
 private fail(reason:unknown){
  this.failure??=originalError(reason);this.stopped=true;this.ready.reject(this.failure);
  this.requestClose('CLIENT_FAILURE');this.socket?.destroy(this.failure);this.check();
 }
 private requestClose(reason:string){
  if(this.native&&!this.cancelRequested&&!this.finalRequested){
   this.cancelRequested=true;
   try{this.native.cancel(reason);}catch(e){this.failure??=originalError(e);}
  }
  if(this.channel&&!this.closeRequested){
   this.closeRequested=true;
   try{this.channel.close(reason);}catch(e){this.failure??=originalError(e);this.stopped=true;this.ready.reject(this.failure);}
  }
 }
 private check(){
  if(!this.resourceDone&&this.prepared&&!this.unconfirmed&&this.pending===0&&(!this.native||this.nativeReadyDone&&this.nativeClosedDone)){
   try{
    for(const free of this.retired)free();this.retired=[];
    this.resourceDone=true;
    this.resource.resolve();
   }catch(e){this.unconfirmed=true;this.failure??=originalError(e);}
  }
  if(this.resourceDone&&!this.unconfirmed){
   try{
    if(this.finalCallback)this.finishFinal();
    // 실제 EOF 뒤 남은 bytes는 상위 소비와 end 관측까지 유지한다.
    const drained=this.socket&&this.nativeClosedDone&&this.eof&&this.socket.readableEnded&&this.socket.readableLength===0&&this.loans.length===0&&this.tickets.size===0&&!this.writing;
    if(this.socket&&!this.socket.destroyed&&(this.stopped||drained))this.socket.destroy(this.failure??undefined);
   }catch(e){this.unconfirmed=true;this.failure??=originalError(e);}
  }
  if(this.completed||!this.resourceDone||this.unconfirmed||this.socket&&!this.jsClosed||this.tickets.size||this.loans.length||this.manager.budget.poisoned)return;
  try{this.manager.complete(this);this.completed=true;}catch(e){this.unconfirmed=true;this.failure??=originalError(e);}
 }
 private reconcile(){
  const length=this.socket?.readableLength??0;
  let consumed=this.loans.reduce((n,v)=>n+v.remaining,0)-length;
  while(consumed>0&&this.loans.length){
   const loan=this.loans[0],n=Math.min(consumed,loan.remaining);loan.remaining-=n;consumed-=n;
   if(loan.remaining===0){loan.free();this.loans.shift();}
  }
 }
 private createStream():Duplex{
  const socket=new Duplex({
   highWaterMark:this.hwm,allowHalfOpen:true,autoDestroy:false,
   read:()=>this.read(),
   write:(bytes:Buffer,_encoding,callback)=>this.write(bytes,callback),
   final:callback=>{
    // 실제 EOF를 받은 다른 lane도 원 native close를 합류한다.
    this.finalRequested=true;this.finalCallback=callback;
     if(this.lane!=='IN'&&!this.eof){this.fail(error('WINDOWS_PIPE_CLIENT_FINAL_LANE'));return;}
    if(this.failure||this.loans.length||socket.readableLength||this.tickets.size){this.fail(this.failure??error('WINDOWS_INPUT_REVERSE_BYTES'));return;}
    this.requestClose(this.lane==='IN'?'INPUT_END':'STREAM_END');this.check();
   },
   destroy:(reason,callback)=>{
    if(reason)this.failure??=reason;this.stopped=true;this.requestClose('STREAM_DESTROY');
    void this.resource.promise.then(()=>{
     try{
      socket.pause();while(socket.read()!==null){/* 닫힌 queue의 원 buffer를 회수한다. */}
      this.reconcile();callback(this.failure);
     }catch(e){this.unconfirmed=true;this.failure??=originalError(e);}
    });
    this.check();
   }
  });
  socket.pause();socket.once('end',()=>this.check());socket.once('close',()=>{this.jsClosed=true;this.check();});
  // broker가 listener를 붙이기 전의 늦은 native 실패도 원 오류로 보존한다.
  socket.on('error',()=>{});
  const read=socket.read.bind(socket),write=socket.write.bind(socket),end=socket.end.bind(socket);
  Object.defineProperty(socket,'read',{value:(size?:number)=>{
   const bytes=read(size);this.reconcile();this.check();return bytes;
  }});
  Object.defineProperty(socket,'write',{value:(...args:unknown[])=>{
   must(!this.finalRequested&&!this.stopped&&!this.nativeClosedDone,'WINDOWS_PIPE_CLIENT_CLOSED');
   const source=args[0];must(!types.isProxy(source)&&Buffer.isBuffer(source),'WINDOWS_BINARY_INVALID');
   const n=source.length;must(n<=131076&&this.manager.budget.queued+n<=this.manager.options.bounds.maxQueuedBytes,'WINDOWS_PIPE_CLIENT_QUEUE');
   const cb=typeof args[1]==='function'?args[1]:typeof args[2]==='function'?args[2]:undefined;
   if(n===0)return write(Buffer.alloc(0),cb as ((error?:Error|null)=>void)|undefined);
   const free=this.manager.budget.hold(2*n,this.lane==='CONTROL');
   let own:Buffer;try{own=Buffer.allocUnsafeSlow(n);own.set(source);}catch(e){free();throw e;}
   const ticket:Ticket={buffer:own,free,nativeDone:true,queueDone:false};
   this.tickets.add(ticket);this.ticketByBuffer.set(own,ticket);this.manager.budget.queued+=n;
   const done=(reason?:Error|null)=>{try{if(cb)(cb as (error?:Error|null)=>void)(reason);}finally{ticket.queueDone=true;this.settle(ticket);}};
   try{return write(own,done);}catch(e){ticket.queueDone=true;this.settle(ticket);throw e;}
  }});
  Object.defineProperty(socket,'end',{value:(...args:unknown[])=>{
   const cb=args.find(v=>typeof v==='function') as (()=>void)|undefined;
   if(args[0]!==undefined&&args[0]!==null&&typeof args[0]!=='function')socket.write(args[0]);
   return end(cb);
  }});
  return socket;
 }
 private settle(ticket:Ticket){
  if(!ticket.nativeDone||!ticket.queueDone||!this.tickets.has(ticket))return;
  try{ticket.free();this.manager.budget.queued-=ticket.buffer.length;this.tickets.delete(ticket);this.check();}
  catch(e){this.unconfirmed=true;this.fail(e);}
 }
 private write(bytes:Buffer,callback:(error?:Error|null)=>void){
  if(bytes.length===0){callback();return;}
  const ticket=this.ticketByBuffer.get(bytes);
  if(!ticket||this.writing||!this.channel){callback(error('WINDOWS_PIPE_CLIENT_ACCOUNTING'));return;}
  ticket.nativeDone=false;this.writing=true;
  void (async()=>{
   let offset=0,unknown=false;
   try{
    while(offset<bytes.length){
     if(this.stopped||this.nativeClosedDone)throw this.failure??error(this.nativeClosedDone?'WINDOWS_PIPE_NATIVE_CLOSED':'WINDOWS_PIPE_CLIENT_CANCELLED');
     const part=bytes.subarray(offset,Math.min(bytes.length,offset+this.manager.options.bounds.maxChunkBytes));
     this.pending++;let written:Promise<number>;
     try{written=this.channel!.write(part);promise<number>(written);}
     catch(e){unknown=true;this.unconfirmed=true;throw e;}
     let n:number;try{n=await written;}finally{this.pending--;}
     must(Number.isSafeInteger(n)&&n>0&&n<=part.length,'WINDOWS_PIPE_WRITE_COMPLETION');offset+=n;
    }
    ticket.nativeDone=true;this.writing=false;callback();
   }catch(e){
    this.fail(e);
    if(!unknown){ticket.nativeDone=true;this.writing=false;callback(originalError(e));}
   }finally{if(!unknown){this.settle(ticket);this.check();}}
  })();
 }
 private read(){
  if(this.reading||this.stopped||this.finalRequested||this.eof||!this.channel)return;
  this.reading=true;
  let free:Release,buffer:Buffer;
  try{
   // CONTROL read가 전용 pool을 독점해 작은 STOP을 막지 않는다.
   const n=Math.min(this.hwm,this.manager.options.bounds.maxChunkBytes,this.lane==='CONTROL'?4096:Infinity);
   free=this.manager.budget.hold(2*n,this.lane==='CONTROL');
   try{buffer=Buffer.allocUnsafeSlow(n);}catch(e){free();throw e;}
  }catch(e){this.reading=false;this.fail(e);return;}
  this.pending++;let completion:Promise<{bytesRead:number;eof:boolean}>;
  try{completion=this.channel.readInto(buffer);promise(completion);}
  catch(e){this.unconfirmed=true;this.retired.push(free);this.fail(e);return;}
  void (async()=>{
   let loaned=false;
   try{
    const result=await completion;
    object(result,['bytesRead','eof']);
    must(Number.isSafeInteger(result.bytesRead)&&result.bytesRead>=0&&result.bytesRead<=buffer.length&&typeof result.eof==='boolean','WINDOWS_PIPE_READ_COMPLETION');
    if(this.finalRequested)must(result.bytesRead===0,'WINDOWS_INPUT_REVERSE_BYTES');
    else if(!this.stopped){
     must(result.bytesRead>0||result.eof,'WINDOWS_PIPE_ZERO_READ');
     if(result.bytesRead){
      this.loans.push({remaining:result.bytesRead,free});loaned=true;
      this.socket!.push(buffer.subarray(0,result.bytesRead));this.reconcile();
     }
     if(result.eof){this.eof=true;this.socket!.push(null);}
    }
   }catch(e){this.fail(e);}
   finally{
    if(!loaned){
     // read 실패/취소의 원 backing은 handle close 증거까지 유지한다.
     if(this.stopped||this.finalRequested)this.retired.push(free);else free();
    }
    this.reading=false;this.pending--;this.check();
   }
  })();
 }
 private finishFinal(){
  if(!this.failure&&this.lane!=='IN'&&this.eof&&!this.socket!.readableEnded)return;
  const callback=this.finalCallback!;this.finalCallback=null;
  if(this.failure||!this.finalRequested||this.writing||this.tickets.size||this.loans.length||this.socket!.readableLength||!this.nativeClosedDone){
   callback(this.failure??error('WINDOWS_INPUT_REVERSE_BYTES'));return;
  }
  if(this.lane==='IN')localInputClosed.set(this.socket!,error('WINDOWS_PIPE_LOCAL_INPUT_CLOSED'));
  callback(null);
  this.socket!.destroy();
 }
}

export function createWindowsPipeClientPorts(options:WindowsPipeClientOptions):WindowsBrokerPorts{
 const o=object(options,['registration','bounds','clientBudgetBytes','memory','authority','binding']);
 const r=object(o.registration,['version','hostEpochId','environmentDigest','controllerInstanceId','endpointId','hostProcess','controllerProcess','hostSidDigest','controllerSidDigest','key']);
 must(r.version===1);uuid(r.hostEpochId);uuid(r.controllerInstanceId);uuid(r.endpointId);hash(r.environmentDigest);hash(r.hostSidDigest);hash(r.controllerSidDigest);
 const hostProcess=processIdentity(r.hostProcess),controllerProcess=processIdentity(r.controllerProcess);
 must(!types.isProxy(r.key)&&Buffer.isBuffer(r.key)&&r.key.length===32);
 const registration=Object.freeze({version:1 as const,hostEpochId:r.hostEpochId,environmentDigest:r.environmentDigest,controllerInstanceId:r.controllerInstanceId,endpointId:r.endpointId,hostProcess,controllerProcess,hostSidDigest:r.hostSidDigest,controllerSidDigest:r.controllerSidDigest,key:Buffer.from(r.key)}) as WindowsBrokerRegistration;
 const b=object(o.bounds,['maxControlBytes','maxChunkBytes','streamHighWaterMarkBytes','maxQueuedBytes','maxInFlightBytes','maxRetainedRecords','handshakeMilliseconds','closeMilliseconds','maxPendingOperations']);
 must(b.maxControlBytes===131072&&b.maxPendingOperations===32);for(const v of Object.values(b))positive(v);
 positive(b.maxChunkBytes,65536);positive(b.streamHighWaterMarkBytes,b.maxChunkBytes);positive(b.maxRetainedRecords,64);positive(b.handshakeMilliseconds,2147483647);positive(b.closeMilliseconds,2147483647);
 const bounds=snapshot(b) as WindowsBrokerBounds;
 const m=object(o.memory,['maxBytes','available','hold']);positive(m.maxBytes);must(typeof m.available==='function'&&typeof m.hold==='function');
 const memory=Object.freeze({maxBytes:m.maxBytes,available:m.available.bind(o.memory),hold:m.hold.bind(o.memory)}) as NativeControllerMemoryOwner;
 positive(o.clientBudgetBytes);must(o.clientBudgetBytes>=BASE_BYTES&&bounds.maxInFlightBytes+o.clientBudgetBytes<=memory.maxBytes,'WINDOWS_PIPE_CLIENT_CAPACITY');
 const a=object(o.authority,['resolve','current']),n=object(o.binding,['open']);
 must(typeof a.resolve==='function'&&typeof a.current==='function'&&typeof n.open==='function');
 const fixed={registration,bounds,clientBudgetBytes:o.clientBudgetBytes,memory,authority:Object.freeze({resolve:a.resolve.bind(o.authority),current:a.current.bind(o.authority)}),binding:Object.freeze({open:n.open.bind(o.binding)})} as WindowsPipeClientOptions;
 const manager=new Manager(Object.freeze(fixed)),nowMs=()=>Number(process.hrtime.bigint()/1000000n);
 return Object.freeze({
  connect:manager.connect.bind(manager),nowMs,nonce:()=>randomBytes(32),
  startWait(deadlineMs:number){
   const wait=deferred<void>();let timer:ReturnType<typeof setTimeout>|null=setTimeout(()=>{timer=null;wait.resolve();},Math.max(0,deadlineMs-nowMs()));
   return Object.freeze({done:wait.promise,cancel:()=>{if(timer!==null){clearTimeout(timer);timer=null;}}});
  }
 });
}
