import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {digest} from '../../packages/contracts/src/intent.js';
import {LocalOcrProcessExecutor,type LocalOcrRequest} from '../../packages/providers/src/local-ocr-executor.js';
import type {LocalOcrConfig} from '../../packages/providers/src/local-ocr.js';
import type {StageInput} from '../../packages/domain/src/provider.js';

// 실제 프로세스 대신 원 스트림/종료 이벤트를 제어한다. Python·모델·소켓은 실행하지 않는다.
const state=vi.hoisted(()=>({child:null as unknown,request:null as unknown,command:null as unknown,kills:0}));
vi.mock('node:child_process',()=>({spawn:(...args:unknown[])=>{state.command=args;return childPort();}}));
type Child=EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;stdin:Writable;kill:()=>boolean};
function childPort():Child{
  const child=new EventEmitter() as Child;child.pid=7319;child.stdout=new PassThrough();child.stderr=new PassThrough();
  let body='';child.stdin=new Writable({write(chunk,_encoding,done){body+=chunk.toString();done();},final(done){state.request=JSON.parse(body);done();}});
  child.kill=()=>{state.kills++;return true;};state.child=child;return child;
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function fixture(options:{recordStart?:(input:StageInput,value:unknown)=>Promise<void>;verifyConfig?:()=>Promise<void>}={}){
  const root=join(tmpdir(),'owned-ocr-executor-port'),pin={path:join(root,'python.exe'),sha256:'a'.repeat(64),bytesLength:1};
  const config:LocalOcrConfig={version:2,ownedTempRoot:root,python:pin,worker:{...pin,path:join(root,'worker.py')},detector:pin,
    dependencyRoots:[root],dependencyPins:[pin],ocr:{directory:root,files:[]},settings:{modelId:'owned-ocr',contractVersion:'owned-v1'},maxRegions:20,timeoutMilliseconds:5};
  const input={executionId:'10000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa'} as StageInput;
  const request:LocalOcrRequest={version:2,executionId:input.executionId,inputFingerprint:'b'.repeat(64),configDigest:digest(config),ownedTempRoot:root,outputDirectory:join(root,'out'),
    source:{path:join(root,'source.image'),sha256:'c'.repeat(64),width:10,height:10,page:'fixture'},detector:pin,ocr:config.ocr,dependencyRoots:[root],maxRegions:20,threads:4,maxNewTokens:100,cropPadding:3};
  const records:unknown[]=[],verifyConfig=options.verifyConfig??vi.fn(async()=>{});
  const executor=new LocalOcrProcessExecutor(config,{recordStart:options.recordStart??(async(_input,value)=>{records.push(value);}),verifyConfig});
  const child=()=>state.child as Child;
  const frame=(value:Record<string,unknown>)=>{const original=state.request as LocalOcrRequest;child().stdout.write(JSON.stringify({version:1,executionId:original.executionId,inputFingerprint:original.inputFingerprint,configDigest:original.configDigest,...value})+'\n');};
  const start=()=>frame({kind:'START',pid:7319,source:'DETECTOR_FORWARD_ENTERED'});
  const failure=()=>frame({kind:'REPLY',outcome:'FAILURE',manifest:null,detectorCalls:0,recognitionCalls:0,reason:'FIXTURE_ONLY'});
  const close=async()=>{child().stdout.end();child().stderr.end();await turn();child().emit('close',0,null);await turn();};
  return {config,input,request,records,verifyConfig,executor,child,frame,start,failure,close};
}
afterEach(()=>{vi.useRealTimers();state.child=null;state.request=null;state.command=null;state.kills=0;});
it('returns a timeout receipt while joined remains pending until actual close and I/O end',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=fixture(),started=vi.fn(async()=>{}),run=f.executor.invoke(f.input,f.request,started);
  let joined=false;void run.joined.then(()=>{joined=true;});await vi.advanceTimersByTimeAsync(5005);
  const receipt=await run.reply,saved=structuredClone(receipt);
  expect(receipt).toMatchObject({valid:false,closeObserved:false,timedOut:true,protocolClosed:true,fullHostCostUsd:null,billingAuthority:false,subtreeTermination:'UNCONFIRMED'});
  expect(joined).toBe(false);f.start();expect(f.records).toEqual([]);expect(started).not.toHaveBeenCalled();
  await f.close();await run.joined;expect(joined).toBe(true);expect(receipt).toEqual(saved);expect(state.kills).toBe(1);
});
it('joins the original START callback after close even when the bounded reply has timed out',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const waiting=deferred(),f=fixture(),started=vi.fn(()=>waiting.promise),run=f.executor.invoke(f.input,f.request,started);
  f.start();f.failure();await f.close();let joined=false;void run.joined.then(()=>{joined=true;});
  await vi.advanceTimersByTimeAsync(5005);const receipt=await run.reply;
  expect(receipt).toMatchObject({started:true,closeObserved:true,callbackInvoked:true,callbackConfirmed:false,callbackPending:true,valid:false});
  expect(joined).toBe(false);waiting.resolve();await run.joined;expect(started).toHaveBeenCalledOnce();expect(f.records).toHaveLength(1);expect(receipt.callbackConfirmed).toBe(false);
});
it('does not treat a child close event alone as joined while output streams remain open',async()=>{
  const f=fixture(),run=f.executor.invoke(f.input,f.request,async()=>{});f.failure();await turn();f.child().emit('close',0,null);
  const receipt=await run.reply;let joined=false;void run.joined.then(()=>{joined=true;});await turn();
  expect(receipt.valid).toBe(false);expect(joined).toBe(false);
  f.child().stdout.end();await turn();expect(joined).toBe(false);f.child().stderr.end();await run.joined;expect(joined).toBe(true);
});
it('waits for post-execution pins and retains detached original request and config',async()=>{
  const pins=deferred(),verify=vi.fn(()=>pins.promise),f=fixture({verifyConfig:verify}),run=f.executor.invoke(f.input,f.request,async()=>{});
  f.request.configDigest='d'.repeat(64);f.request.source.sha256='e'.repeat(64);f.config.python={...f.config.python,path:'changed'};
  f.failure();await f.close();let returned=false,joined=false;void run.reply.then(()=>{returned=true;});void run.joined.then(()=>{joined=true;});await turn();
  expect(returned).toBe(false);expect(joined).toBe(false);pins.resolve();const receipt=await run.reply;await run.joined;
  expect(receipt).toMatchObject({valid:true,closeObserved:true,postPinsVerified:true,callbackInvoked:false,reply:{outcome:'FAILURE'}});
  expect((state.request as LocalOcrRequest).source.sha256).toBe('c'.repeat(64));expect(verify).toHaveBeenCalledOnce();
  const command=state.command as [string,string[],{shell:boolean;windowsHide:boolean;env:Record<string,string>}];
  expect(command[0]).toBe(join(tmpdir(),'owned-ocr-executor-port','python.exe'));expect(command[1].slice(0,3)).toEqual(['-I','-S','-B']);
  expect(command[2]).toMatchObject({shell:false,windowsHide:true,env:{HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'4',MKL_NUM_THREADS:'4'}});
  expect(command[2].env).not.toHaveProperty('OPENAI_API_KEY');
});
it('preserves the complete original START frame before notifying ExecutionService',async()=>{
  const ordering:string[]=[],f=fixture({recordStart:async(input,value)=>{ordering.push('record');expect(input.executionId).toBe(f.input.executionId);expect(value).toMatchObject({kind:'START',pid:7319,source:'DETECTOR_FORWARD_ENTERED'});}});
  const run=f.executor.invoke(f.input,f.request,async()=>{ordering.push('notify');});f.start();f.failure();await f.close();const receipt=await run.reply;await run.joined;
  expect(ordering).toEqual(['record','notify']);expect(receipt).toMatchObject({valid:true,started:true,callbackConfirmed:true,callbackPending:false,stdoutEof:true,stderrEof:true,inputClosed:true});
  const raw=JSON.parse(Buffer.from(receipt.rawStdoutBase64,'base64').toString('utf8').split('\n')[0]);expect(raw.kind).toBe('START');
});
it('keeps a failed pin recheck unknown after a real close without inventing host or billing proof',async()=>{
  const f=fixture({verifyConfig:async()=>{throw Error('CHANGED_PIN');}}),run=f.executor.invoke(f.input,f.request,async()=>{});f.failure();await f.close();const receipt=await run.reply;await run.joined;
  expect(receipt).toMatchObject({valid:false,closeObserved:true,postPinsVerified:false,subtreeTermination:'UNCONFIRMED',fullHostCostUsd:null,billingAuthority:false});
});

it('joins a delayed original START record after deadline without issuing a late START notification',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const saved=deferred(),writes:string[]=[],f=fixture({recordStart:async()=>{await saved.promise;writes.push('START');}}),started=vi.fn(async()=>{});
  const run=f.executor.invoke(f.input,f.request,started);f.start();f.failure();await f.close();let joined=false;void run.joined.then(()=>{joined=true;});
  await vi.advanceTimersByTimeAsync(5005);const receipt=await run.reply,original=structuredClone(receipt);
  expect(receipt).toMatchObject({started:true,closeObserved:true,valid:false,callbackInvoked:false,callbackConfirmed:false,callbackPending:true});expect(writes).toEqual([]);expect(joined).toBe(false);
  saved.resolve();await run.joined;expect(writes).toEqual(['START']);expect(started).not.toHaveBeenCalled();expect(receipt).toEqual(original);expect(joined).toBe(true);
});
