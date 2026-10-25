import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {DomainError} from '../../contracts/src/errors.js';
import type {LocalLaMaCapture,LocalLaMaExecutorReply,LocalLaMaRuntimeFacts,LocalLaMaStartFact} from './local-lama.js';
import type {LocalLaMaAttemptStore,LocalLaMaEnginePort,LocalLaMaEngineInvocation,LocalLaMaInvocationBinding,LocalLaMaOriginalInvocation} from './local-lama-executor.js';

export type LocalLaMaSupervisorLimits=Readonly<{processCount:number;processMemoryBytes:number;jobMemoryBytes:number;timeoutMs:number;joinTimeoutMs:number;stdoutBytes:number;stderrBytes:number;observationBytes:number;maxOutputBytes:number}>;
export type LocalLaMaPinnedFile=Readonly<{file:string;bytes:number;sha256:string}>;
// Private server-owned launch configuration. It is never part of HTTP, StageInput or renderer input.
export type LocalLaMaSupervisorRuntime=Readonly<{root:string;modelRoot:string;python:LocalLaMaPinnedFile;bootstrap:LocalLaMaPinnedFile;supervisor:LocalLaMaPinnedFile;weights:LocalLaMaPinnedFile;config:LocalLaMaPinnedFile;dependencyReceipt:LocalLaMaPinnedFile;importEvidence:readonly LocalLaMaPinnedFile[];limits:LocalLaMaSupervisorLimits;systemRoot:string;windowsDirectory:string}>;
type Options={runtime:LocalLaMaSupervisorRuntime;binding:LocalLaMaInvocationBinding;capture:LocalLaMaCapture;attempts:LocalLaMaAttemptStore};
type Counts={submit:number;query:number;supervisorLaunches:number;actualModelCalls:number;closed:boolean;run:string|null};
const SOURCE_SHA='4e40c5eece914d30ea16c3aafc0699f46e07c924c98f3aeecc6dcb8642b53cf8';
const EXECUTABLE_PIN={bytes:103192,sha256:'47942e1f899c5b0ccd23ba0730adbbc979b1488e0f2e5274abf398360877b7ec'};
const BOOTSTRAP_PIN={bytes:20838,sha256:'2be3a0bc64cc6aa0a83d2ddaddd643ffa997283d7c5cf5c0fec15a046901d73b'};
const SUPERVISOR_PIN={bytes:42023,sha256:'b9603cfd26fb5e375fcdfc7b6c2591975763c14c708ef19c566b4f5870df3545'};
const STDOUT_BYTES=65536,MAX_METADATA_BYTES=8*1024*1024,MAX_FILE_BYTES=2*1024*1024*1024;
const lifetime=()=>new DomainError('LOCAL_LAMA_EXECUTOR_LIFETIME_UNCONFIRMED',409,'WAIT');
const object=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const pin=(bytes:Buffer)=>({bytes:bytes.length,sha256:sha256(bytes)});
const fresh=async(file:string,value:Buffer|string,onIoFailure:()=>void)=>{try{await fs.writeFile(file,value,{flag:'wx',mode:0o600});}catch(error){onIoFailure();throw error;}};
async function pinnedFile(expected:LocalLaMaPinnedFile,retain:boolean,onCloseFailure:()=>void):Promise<Buffer|null>{
  assert.ok(Number.isSafeInteger(expected.bytes)&&expected.bytes>0&&expected.bytes<=MAX_FILE_BYTES&&/^[0-9a-f]{64}$/.test(expected.sha256));
  if(retain)assert.ok(expected.bytes<=MAX_METADATA_BYTES);
  const file=path.resolve(expected.file),before=await fs.lstat(file);assert.ok(before.isFile()&&!before.isSymbolicLink());assert.equal(before.size,expected.bytes);assert.equal(path.resolve(await fs.realpath(file)).toLowerCase(),file.toLowerCase());
  const handle=await fs.open(file,'r');
  try{
    const opened=await handle.stat();assert.ok(opened.isFile());assert.equal(opened.size,before.size);assert.equal(opened.dev,before.dev);assert.equal(opened.ino,before.ino);
    // Allocation follows the regular-file, no-reparse and finite length checks.
    const output=retain?Buffer.alloc(expected.bytes):null,chunk=output??Buffer.alloc(Math.min(65536,expected.bytes)),hash=createHash('sha256');let offset=0;
    while(offset<expected.bytes){const size=Math.min(chunk.length,expected.bytes-offset),at=output?offset:0,next=await handle.read(chunk,at,size,offset);assert.ok(next.bytesRead>0);hash.update(chunk.subarray(at,at+next.bytesRead));offset+=next.bytesRead;}
    const extra=Buffer.alloc(1);assert.equal((await handle.read(extra,0,1,offset)).bytesRead,0);assert.equal(hash.digest('hex'),expected.sha256);
    const after=await handle.stat();assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(path.resolve(await fs.realpath(file)).toLowerCase(),file.toLowerCase());return output;
  }finally{try{await handle.close();}catch(error){onCloseFailure();throw error;}}
}
async function boundedReport(file:string,onCloseFailure:()=>void):Promise<Buffer>{
  const resolved=path.resolve(file),before=await fs.lstat(resolved);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=MAX_METADATA_BYTES);assert.equal(path.resolve(await fs.realpath(resolved)).toLowerCase(),resolved.toLowerCase());
  const handle=await fs.open(resolved,'r');try{const opened=await handle.stat();assert.ok(opened.isFile());assert.equal(opened.size,before.size);assert.equal(opened.dev,before.dev);assert.equal(opened.ino,before.ino);const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const next=await handle.read(bytes,offset,bytes.length-offset,offset);assert.ok(next.bytesRead>0);offset+=next.bytesRead;}assert.equal((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead,0);const after=await handle.stat();assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(path.resolve(await fs.realpath(resolved)).toLowerCase(),resolved.toLowerCase());return bytes;}finally{try{await handle.close();}catch(error){onCloseFailure();throw error;}}
}
function sourceObservation(value:unknown,identity:Record<string,unknown>,capture:LocalLaMaCapture):Record<string,unknown>{
  const observation=object(value);assert.deepEqual(Object.keys(observation).sort(),['captureDigest','kind','modelCallLine','nonce','observationLine','originalCommit','originalId','sourceSha256','version']);
  assert.equal(observation.version,1);assert.equal(observation.kind,'INFERENCE_COMPLETED_OBSERVATION');assert.equal(observation.originalCommit,capture.identity.codeCommit);assert.equal(observation.sourceSha256,SOURCE_SHA);assert.equal(observation.modelCallLine,85);assert.equal(observation.observationLine,86);
  for(const key of ['nonce','originalId','captureDigest'])assert.equal(observation[key],identity[key]);assert.equal(observation.captureDigest,capture.captureDigest);return observation;
}
function replyCopy(reply:LocalLaMaExecutorReply):LocalLaMaExecutorReply{return {...reply,runtime:{...reply.runtime},start:reply.start?{...reply.start,runtime:{...reply.start.runtime}}:null,fullCost:reply.fullCost?{...reply.fullCost}:null,proposal:reply.proposal?{...reply.proposal,bytes:Buffer.from(reply.proposal.bytes)}:null};}
export function parseLocalLaMaSupervisorFrames(stdout:Buffer,reportBytes:Buffer,requestBytes:Buffer,capture:LocalLaMaCapture,limits:LocalLaMaSupervisorLimits):{report:Record<string,unknown>;observation:Record<string,unknown>|null}{
  assert.ok(stdout.length>0&&stdout.length<=STDOUT_BYTES&&reportBytes.length>0&&reportBytes.length<=MAX_METADATA_BYTES&&requestBytes.length>0&&requestBytes.length<=MAX_METADATA_BYTES);assert.equal(stdout.at(-1),10);
  const lines=new TextDecoder('utf-8',{fatal:true}).decode(stdout).trimEnd().split('\n');assert.ok(lines.length===1||lines.length===2);const frames=lines.map(line=>object(parseStrictJson(line,STDOUT_BYTES)));
  const last=frames.at(-1)!;assert.deepEqual(Object.keys(last).sort(),['kind','report','version']);assert.equal(last.version,1);assert.equal(last.kind,'RESULT');
  let observation:Record<string,unknown>|null=null;if(frames.length===2){assert.deepEqual(Object.keys(frames[0]).sort(),['kind','observation','version']);assert.equal(frames[0].version,1);assert.equal(frames[0].kind,'OBSERVATION');observation=object(frames[0].observation);}
  const report=object(last.report),request=object(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(requestBytes),MAX_METADATA_BYTES));
  if(observation)sourceObservation(observation,object(request.identity),capture);
  assert.deepEqual(report,parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(reportBytes),MAX_METADATA_BYTES));assert.deepEqual(report.identity,request.identity);assert.equal(report.requestSha256,sha256(requestBytes));assert.deepEqual(report.requestedLimits,limits);assert.deepEqual(request.limits,limits);
  assert.equal(report.version,1);assert.equal(report.originalCommit,capture.identity.codeCommit);assert.equal(report.sourceSha256,SOURCE_SHA);assert.equal(object(report.identity).captureDigest,capture.captureDigest);
  const pipes=object(report.pipes);assert.deepEqual(Object.keys(pipes).sort(),['observation','stderr','stdout']);
  assert.ok(report.physicalJoined===true&&report.lastVerifiedActiveCount===0&&report.workerExitObserved===true&&report.jobHandleClosed===true&&Object.values(pipes).every(value=>{const pipe=object(value);return pipe.eofObserved===true&&pipe.overflow===false&&pipe.readError===null;}));
  return {report,observation};
}
export function localLaMaSupervisedEngine(options:Options):{engine:LocalLaMaEnginePort;counts:Counts}{
  const runtime=structuredClone(options.runtime),binding=structuredClone(options.binding),capture=structuredClone(options.capture),lookup=options.attempts.lookup.bind(options.attempts);
  assert.equal(binding.executionId,capture.executionId);assert.equal(binding.inputDigest,capture.inputDigest);assert.equal(binding.localCaptureDigest,capture.captureDigest);const {captureDigest,...captureBody}=capture;assert.equal(digest(captureBody),captureDigest);
  assert.equal(capture.identity.weightsSha256,runtime.weights.sha256);assert.equal(capture.identity.configSha256,runtime.config.sha256);assert.ok(capture.identity.runtimeVerified&&capture.identity.weightsLicenseVerified);
  // The files whose pins were captured must be the files consumed by the
  // supervisor's modelRoot aliases, not similarly pinned files elsewhere.
  assert.equal(path.resolve(runtime.weights.file).toLowerCase(),path.resolve(runtime.modelRoot,'models/best.ckpt').toLowerCase());assert.equal(path.resolve(runtime.config.file).toLowerCase(),path.resolve(runtime.modelRoot,'config.yaml').toLowerCase());
  // Preserve the exact supervised protocol already qualified in Temp. A caller
  // cannot substitute a command by changing a self-consistent configuration pin.
  for(const [file,expected] of [[runtime.python,EXECUTABLE_PIN],[runtime.bootstrap,BOOTSTRAP_PIN],[runtime.supervisor,SUPERVISOR_PIN]] as const)assert.deepEqual({bytes:file.bytes,sha256:file.sha256},expected);
  assert.equal(path.resolve(runtime.python.file).toLowerCase(),path.resolve('C:/Users/ksaei/AppData/Local/Programs/Python/Python310/python.exe').toLowerCase());
  assert.equal(capture.identity.codeCommit,'786f5936b27fb3dacd2b1ad799e4de968ea697e7');
  assert.ok(path.isAbsolute(runtime.root)&&path.isAbsolute(runtime.modelRoot)&&path.isAbsolute(runtime.systemRoot)&&path.isAbsolute(runtime.windowsDirectory));assert.ok(Object.values(runtime.limits).every(value=>Number.isSafeInteger(value)&&value>0));assert.ok(runtime.importEvidence.length<=32&&runtime.limits.maxOutputBytes<=MAX_METADATA_BYTES&&runtime.limits.stderrBytes<=MAX_METADATA_BYTES);
  const counts:Counts={submit:0,query:0,supervisorLaunches:0,actualModelCalls:0,closed:false,run:null};let submitted=false,owned:LocalLaMaEngineInvocation|null=null,ownedOriginal:LocalLaMaOriginalInvocation|null=null;
  const same=(value:{binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;capture?:LocalLaMaCapture})=>{assert.equal(digest(value.binding),digest(binding));assert.equal(value.original.version,1);assert.equal(value.original.bindingDigest,digest(binding));assert.equal(value.original.localCaptureDigest,capture.captureDigest);assert.match(value.original.invocationId,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);if(value.capture)assert.equal(digest(value.capture),digest(capture));};
  const verifyOriginal=async(original:LocalLaMaOriginalInvocation,first=false)=>{const stored=await lookup(binding,capture);assert.ok(stored);assert.equal(digest(stored.original),digest(original));if(first)assert.equal(stored.records.length,0);};
  const engine:LocalLaMaEnginePort={
    submit(value,onStarted){
      assert.equal(typeof onStarted,'function');
      counts.submit++;same(value);assert.equal(submitted,false);assert.equal(digest(value.input.capture),digest(capture));assert.ok(Buffer.isBuffer(value.input.image)&&Buffer.isBuffer(value.input.mask)&&value.input.image.length<=runtime.limits.maxOutputBytes&&value.input.mask.length<=runtime.limits.maxOutputBytes);assert.deepEqual(pin(value.input.image),{bytes:capture.imageByteLength,sha256:capture.imageSha256});assert.deepEqual(pin(value.input.mask),{bytes:capture.maskByteLength,sha256:capture.maskSha256});submitted=true;
      const original=structuredClone(value.original),image=Buffer.from(value.input.image),mask=Buffer.from(value.input.mask);ownedOriginal=original;assert.ok(image.length>=24&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));const width=image.readUInt32BE(16),height=image.readUInt32BE(20);assert.ok(width>0&&height>0);let physicalClosed=false,parentIoClosed=true,start:LocalLaMaStartFact|null=null,callback:Promise<void>|null=null,callbackRejected=false,verifiedProposal:Buffer|null=null;
      const closeFailure=()=>{parentIoClosed=false;},facts:LocalLaMaRuntimeFacts=Object.freeze({version:1,kind:'LOCAL_LAMA',invocationId:original.invocationId,executionId:capture.executionId,inputDigest:capture.inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)});
      const snapshot=(state:LocalLaMaExecutorReply['state']='UNKNOWN',bytes:Buffer|null=null):LocalLaMaExecutorReply=>({version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime:{...facts},state,providerSuccess:start?true:null,start:start?{...start,runtime:{...facts}}:null,fullCost:null,proposal:bytes?{sha256:sha256(bytes),byteLength:bytes.length,bytes:Buffer.from(bytes)}:null});
      const reply=(async():Promise<LocalLaMaExecutorReply>=>{
        try{
        await verifyOriginal(original,true);const root=path.resolve(runtime.root),rootStat=await fs.lstat(root);assert.ok(rootStat.isDirectory()&&!rootStat.isSymbolicLink());assert.equal(path.resolve(await fs.realpath(root)).toLowerCase(),root.toLowerCase());
        for(const expected of [runtime.dependencyReceipt,...runtime.importEvidence,runtime.weights,runtime.config])await pinnedFile(expected,false,closeFailure);
        const bootstrap=(await pinnedFile(runtime.bootstrap,true,closeFailure))!,supervisor=(await pinnedFile(runtime.supervisor,true,closeFailure))!;await pinnedFile(runtime.python,false,closeFailure);
        const run=path.join(root,'run-'+randomUUID());await fs.mkdir(run);counts.run=run;for(const name of ['input','output','work'])await fs.mkdir(path.join(run,name));
        await fresh(path.join(root,'original_lama_bootstrap.py'),bootstrap,closeFailure);await fresh(path.join(root,'original_lama_supervisor.py'),supervisor,closeFailure);await fresh(path.join(run,'input/image.png'),image,closeFailure);await fresh(path.join(run,'input/image_mask001.png'),mask,closeFailure);
        const identity={nonce:sha256(randomUUID()),originalId:original.invocationId,captureDigest:capture.captureDigest};
        const request={version:1,identity,paths:{runRoot:run,modelRoot:runtime.modelRoot},pins:{python:{bytes:runtime.python.bytes,sha256:runtime.python.sha256},supervisor:pin(supervisor),bootstrap:pin(bootstrap),image:pin(image),mask:pin(mask)},limits:runtime.limits},requestFile=path.join(run,'request.json'),requestBytes=Buffer.from(JSON.stringify(request)+'\n');await fresh(requestFile,requestBytes,closeFailure);
        // Original durable admission was verified above, before process creation. This file is work evidence only.
        await fresh(path.join(root,'component-original.json'),JSON.stringify({version:1,original,binding,capture,requestPin:pin(requestBytes),originalStoredBeforeProcessCreation:true,fullCost:null})+'\n',closeFailure);
        const env:NodeJS.ProcessEnv={SystemRoot:runtime.systemRoot,WINDIR:runtime.windowsDirectory,PATH:path.dirname(runtime.python.file)+';'+path.join(runtime.systemRoot,'System32'),TEMP:path.join(run,'work'),TMP:path.join(run,'work'),APPDATA:path.join(run,'work'),LOCALAPPDATA:path.join(run,'work'),USERPROFILE:path.join(run,'work'),PROCESSOR_ARCHITECTURE:'AMD64',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'};
        let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),pending=Buffer.alloc(0),frames=0,resultSeen=false,protocolFailed=false,overflow=false,stdoutEnded=false,stderrEnded=false,streamError=false,spawnError=false;counts.supervisorLaunches++;
        const consume=(line:Buffer)=>{
          const frame=object(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(line),STDOUT_BYTES));assert.equal(frame.version,1);
          if(frame.kind==='OBSERVATION'){
            assert.deepEqual(Object.keys(frame).sort(),['kind','observation','version']);assert.ok(frames===0&&!resultSeen&&start===null);sourceObservation(frame.observation,identity,capture);
            // This pinned normal model-return observation confirms execution
            // after the fact; it does not identify the first inference time.
            // Retain the fact before calling parent I/O, independently of RESULT.
            start=Object.freeze({version:1,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime:facts});counts.actualModelCalls++;
            const delivered={...start,runtime:{...facts}};callback=(async()=>{try{await onStarted(delivered);}catch{callbackRejected=true;}})();
          }else{assert.deepEqual(Object.keys(frame).sort(),['kind','report','version']);assert.equal(frame.kind,'RESULT');assert.ok(!resultSeen);object(frame.report);resultSeen=true;}
          frames++;assert.ok(frames<=2);
        };
        const child=spawn(runtime.python.file,['-I','-S','-B',path.join(root,'original_lama_supervisor.py'),'--private-request',requestFile],{cwd:run,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        child.stdout.on('data',(part:Buffer)=>{if(stdout.length+part.length>STDOUT_BYTES)overflow=true;const retained=part.subarray(0,Math.max(0,STDOUT_BYTES-stdout.length));stdout=Buffer.concat([stdout,retained]);if(!protocolFailed){pending=Buffer.concat([pending,retained]);try{for(let newline=pending.indexOf(10);newline>=0;newline=pending.indexOf(10)){const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);consume(line);}}catch{protocolFailed=true;pending=Buffer.alloc(0);}}});child.stderr.on('data',(part:Buffer)=>{if(stderr.length+part.length>runtime.limits.stderrBytes)overflow=true;stderr=Buffer.concat([stderr,part.subarray(0,Math.max(0,runtime.limits.stderrBytes-stderr.length))]);});
        child.stdout.once('end',()=>{stdoutEnded=true;});child.stderr.once('end',()=>{stderrEnded=true;});for(const stream of [child.stdout,child.stderr])stream.once('error',()=>{streamError=true;});child.once('error',()=>{spawnError=true;});
        const closed=await new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
        await fresh(path.join(run,'owning-stdout.log'),stdout,closeFailure);await fresh(path.join(run,'owning-stderr.log'),stderr,closeFailure);assert.ok(!overflow&&stdoutEnded&&stderrEnded&&!streamError&&!spawnError&&!protocolFailed&&pending.length===0);
        const reportBytes=await boundedReport(path.join(run,'supervisor-report.json'),closeFailure);
        const {report,observation}=parseLocalLaMaSupervisorFrames(stdout,reportBytes,requestBytes,capture,runtime.limits);assert.deepEqual(report.identity,identity);physicalClosed=true;
        assert.ok(observation);assert.deepEqual(closed,{exitCode:0,signal:null});assert.equal(report.workerExitCode,0);assert.equal(report.processOutcome,'COMPLETED_WITH_MODEL_RETURN_OBSERVATION');
        for(const key of ['timedOut','joinDeadlineExceeded','protocolError','parentPipeError','overflow'])assert.equal(report[key],false);assert.equal(report.errorCount,0);assert.deepEqual(report.observationDelivery,{attempted:true,complete:true,error:null,pending:false});assert.deepEqual(report.observation,observation);
        sourceObservation(observation,identity,capture);assert.ok(start);
        const output=object(report.output),outputFile=path.join(run,'output/image_mask001.png');assert.equal(output.path,outputFile);assert.equal(output.width,width);assert.equal(output.height,height);assert.equal(output.error,null);assert.equal(output.headerVerified,true);assert.equal(output.fullDecodeOrQa,false);assert.ok(Number.isSafeInteger(output.bytes)&&Number(output.bytes)>0&&Number(output.bytes)<=runtime.limits.maxOutputBytes&&typeof output.sha256==='string');
        const bytes=(await pinnedFile({file:outputFile,bytes:Number(output.bytes),sha256:output.sha256},true,closeFailure))!;
        verifiedProposal=bytes;
        if(callback)await callback;assert.equal(callbackRejected,false);const result=snapshot('SUCCEEDED',bytes);
        await fresh(path.join(run,'component-result.json'),JSON.stringify({version:1,original,start:result.start,startConfirmation:'VERIFIED_SOURCE_BOUND_MODEL_RETURN_LATE_CONFIRMATION',inferenceFirstTimestampKnown:false,outputPin:pin(bytes),physicalJoined:true,callbacksJoined:true,fullDecodeOrQa:false,fullCost:null,productActivation:false,paidProviderCalls:0})+'\n',closeFailure);return result;
        }catch(error){if(callback)await callback;if(start)return snapshot('UNKNOWN',verifiedProposal);throw error;}
      })();
      const joined=reply.then(()=>{if(!physicalClosed||!parentIoClosed)throw lifetime();counts.closed=true;},()=>{if(!physicalClosed||!parentIoClosed)throw lifetime();counts.closed=true;});void reply.catch(()=>undefined);void joined.catch(()=>undefined);owned={reply,joined};const exposed=reply.then(replyCopy);void exposed.catch(()=>undefined);return {reply:exposed,joined};
    },
    query(value){
      counts.query++;same(value);if(!owned){const error=lifetime(),reply=Promise.reject<LocalLaMaExecutorReply|null>(error),joined=Promise.reject<void>(error);void reply.catch(()=>undefined);void joined.catch(()=>undefined);return {reply,joined};}
      assert.equal(digest(value.original),digest(ownedOriginal));const handle=owned,verified=verifyOriginal(value.original),reply=Promise.all([handle.reply,verified]).then(([result])=>result===null?null:replyCopy(result)),joined=Promise.all([handle.joined,verified]).then(()=>undefined);void reply.catch(()=>undefined);void joined.catch(()=>undefined);return {reply,joined};
    },
  };
  return {engine,counts};
}
