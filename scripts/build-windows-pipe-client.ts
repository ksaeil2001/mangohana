import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {DomainError} from '../packages/contracts/src/errors.js';
import {digest,sha256} from '../packages/contracts/src/intent.js';
import {windowsPipeClientPackageTools as data,inspectWindowsPipeClientPe,type WindowsPipeClientFile as FileRef} from '../packages/native/src/windows-pipe-client-binding.js';

type Mode='verify'|'fake-build'|'fake-test'|'real-build';
type Limits={toolWallMs:number;totalWallMs:number;fakeWallMs:number;stdoutBytes:number;stderrBytes:number;logBytes:number;outputBytes:number};
type Source={root:string;files:FileRef[];digest:string};
type Toolchain={platform:'win32';arch:'x64';msvcVersion:string;sdkVersion:string;compiler:FileRef;linker:FileRef;inspector:FileRef;files:FileRef[];includePaths:string[];libPaths:string[];notices:FileRef[];digest:string};
type NodeApi={version:'24.11.1';napiVersion:8;executable:FileRef;headers:FileRef[];nodeLib:FileRef;notices:FileRef[]};
type Execution={runRoot:string;systemRoot:string;limits:Limits;artifacts?:FileRef[]};
export type WindowsPipeClientBuildInput={version:1;mode:Mode;source:Source;toolchain:Toolchain;nodeApi:NodeApi;execution:Execution};
export type WindowsPipeClientToolRequest={packageDigest:string;mode:Exclude<Mode,'verify'>;executable:FileRef;args:string[];cwd:string;env:Record<string,string>;limits:{wallMs:number;stdoutBytes:number;stderrBytes:number;outputBytes:number};outputRoot:string};
export type WindowsPipeClientBuildExecutor={inspect(execution:Execution):Promise<unknown>;run(request:WindowsPipeClientToolRequest):Promise<unknown>};
export type WindowsPipeClientBuildPorts={read(ref:FileRef):Promise<Buffer>;write(ref:FileRef,bytes:Buffer):Promise<void>;executor:WindowsPipeClientBuildExecutor|null};
type Command={executable:FileRef;args:string[];output:string};
export type WindowsPipeClientBuildResult={state:'VERIFIED'|'BUILT'|'FAKE_TESTED';packageDigest:string;commands:Command[];plans:{fake:Command[];real:Command[]};outputs:FileRef[];executionReady:boolean};
const sourcePaths=Object.freeze(['packages/native/src/windows-pipe-client-binding.ts','packages/native/windows-pipe-client/client-core.h','packages/native/windows-pipe-client/client-core.cc','packages/native/windows-pipe-client/client-win32.cc','scripts/build-windows-pipe-client.ts','packages/native/src/windows-pipe-client.ts','tests/native/windows_pipe_client_test.cc','tests/domain/windows-pipe-client-binding.test.ts','tests/domain/windows-pipe-client.test.ts']);
const requiredExports=['napi_register_module_v1','node_api_module_get_api_version_v1'];
function fail(code='WINDOWS_PIPE_CLIENT_BUILD_INPUT_INVALID'):never{throw new DomainError(code,409,'WAIT');}
function must(v:unknown,code?:string):asserts v{if(!v)fail(code);}
function refs(v:unknown,minimum=1):FileRef[]{must(Array.isArray(v)&&v.length>=minimum&&v.length<=4096);return v.map(f=>data.file(f));}
function paths(v:unknown):string[]{must(Array.isArray(v)&&v.length>0&&v.length<=32);const p=v.map(v=>data.localPath(v));must(new Set(p.map(data.key)).size===p.length);return p;}
function under(root:string,p:string){return data.key(p).startsWith(data.key(root)+'\\');}
function validate(value:unknown):WindowsPipeClientBuildInput{
 const v=data.record(data.snapshot(value),['version','mode','source','toolchain','nodeApi','execution']);must(v.version===1&&['verify','fake-build','fake-test','real-build'].includes(v.mode as string));
 const s=data.record(v.source,['root','files','digest']);data.localPath(s.root);const sourceFiles=refs(s.files);data.hash(s.digest);must(sourceFiles.length===sourcePaths.length&&digest(sourceFiles)===s.digest);
 const expected=new Set(sourcePaths.map(p=>data.key(path.win32.join(s.root as string,p))));must(sourceFiles.every(f=>expected.delete(data.key(f.path)))&&expected.size===0);
 const t=data.record(v.toolchain,['platform','arch','msvcVersion','sdkVersion','compiler','linker','inspector','files','includePaths','libPaths','notices','digest']);must(t.platform==='win32'&&t.arch==='x64'&&t.msvcVersion==='14.50.35717'&&t.sdkVersion==='10.0.26100.0');
 for(const [key,name] of [['compiler','cl.exe'],['linker','link.exe'],['inspector','dumpbin.exe']] as const){const f=data.file(t[key]);must(path.win32.basename(f.path).toLowerCase()===name);}
 refs(t.files);refs(t.notices);paths(t.includePaths);paths(t.libPaths);data.hash(t.digest);must(digest({...t,digest:undefined})===t.digest);
 for(const name of ['kernel32.lib','advapi32.lib','bcrypt.lib'])must((t.files as FileRef[]).filter(f=>path.win32.basename(f.path).toLowerCase()===name).length===1);
 const n=data.record(v.nodeApi,['version','napiVersion','executable','headers','nodeLib','notices']);must(n.version==='24.11.1'&&n.napiVersion===8);const node=data.file(n.executable);must(data.key(node.path)===data.key(process.execPath)&&process.versions.node==='24.11.1'&&process.platform==='win32'&&process.arch==='x64'&&Number(process.versions.napi)>=8);
 const headers=refs(n.headers);must(headers.length===5);const names=new Set(headers.map(f=>path.win32.basename(f.path)));must(['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h','node_version.h'].every(name=>names.has(name)));const lib=data.file(n.nodeLib);must(path.win32.basename(lib.path)==='node.lib');refs(n.notices);
 const nodeDirectory=path.win32.dirname(headers[0].path);must(headers.every(f=>data.key(path.win32.dirname(f.path))===data.key(nodeDirectory))&&data.key((t.includePaths as string[])[0])===data.key(nodeDirectory));
 const includeFiles=[...headers,...t.files as FileRef[]];must((t.includePaths as string[]).every(root=>includeFiles.some(f=>under(root,f.path)))&&(t.libPaths as string[]).every(root=>(t.files as FileRef[]).some(f=>f.path.toLowerCase().endsWith('.lib')&&under(root,f.path))));
 const e=data.record(v.execution,['runRoot','systemRoot','limits',...(Object.hasOwn(v.execution as object,'artifacts')?['artifacts']:[])]);data.localPath(e.runRoot);data.localPath(e.systemRoot);must(typeof e.runRoot==='string'&&/\\AppData\\Local\\Temp\\trio-[^\\]+$/i.test(data.key(e.runRoot))&&!under(s.root as string,e.runRoot)&&!under(e.runRoot,s.root as string));must(data.key(e.systemRoot as string)==='c:\\windows');
 const l=data.record(e.limits,['toolWallMs','totalWallMs','fakeWallMs','stdoutBytes','stderrBytes','logBytes','outputBytes']);const max={toolWallMs:120000,totalWallMs:360000,fakeWallMs:30000,stdoutBytes:1048576,stderrBytes:1048576,logBytes:4194304,outputBytes:67108864};for(const k of Object.keys(max) as (keyof Limits)[]){must(typeof l[k]==='number'&&Number.isSafeInteger(l[k])&&(l[k] as number)>0&&(l[k] as number)<=max[k]);}must((l.toolWallMs as number)<=(l.totalWallMs as number)&&(l.fakeWallMs as number)<=(l.totalWallMs as number));
 if(e.artifacts!==undefined){must(Array.isArray(e.artifacts)&&e.artifacts.length<=32);for(const ref of e.artifacts)outputRef(ref,67108864);must((e.artifacts as FileRef[]).every(f=>under(e.runRoot as string,f.path)));}
 return v as unknown as WindowsPipeClientBuildInput;
}
function allFiles(p:WindowsPipeClientBuildInput){return [...p.source.files,p.toolchain.compiler,p.toolchain.linker,p.toolchain.inspector,...p.toolchain.files,...p.toolchain.notices,p.nodeApi.executable,...p.nodeApi.headers,p.nodeApi.nodeLib,...p.nodeApi.notices];}
function plan(p:WindowsPipeClientBuildInput){
 const {source:s,toolchain:t,nodeApi:n,execution:e}=p;const base=['/nologo','/c','/std:c++20','/W4','/WX','/permissive-','/EHsc','/utf-8','/MT','/GS','/guard:cf','/DWIN32_LEAN_AND_MEAN','/DNOMINMAX','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0A00',...t.includePaths.map(p=>'/I'+p)];
 const compile=(file:string,out:string,real:boolean):Command=>({executable:t.compiler,args:[...base,...(real?['/DNAPI_VERSION=8','/DBUILDING_NODE_EXTENSION']:['/DTRIO_PIPE_CLIENT_FAKE=1']),path.win32.join(s.root,file),'/Fo'+path.win32.join(e.runRoot,out)],output:path.win32.join(e.runRoot,out)});
 const link=(real:boolean):Command=>{const output=path.win32.join(e.runRoot,real?'windows-pipe-client.node':'windows_pipe_client_test.exe');return {executable:t.linker,args:['/NOLOGO','/MACHINE:X64','/INCREMENTAL:NO','/DYNAMICBASE','/NXCOMPAT','/GUARD:CF',...t.libPaths.map(p=>'/LIBPATH:'+p),'/MAP:'+output+'.map','/OUT:'+output,...(real?['/DLL','/IMPLIB:'+path.win32.join(e.runRoot,'windows-pipe-client.lib')]:[]),path.win32.join(e.runRoot,real?'real-core.obj':'fake-core.obj'),path.win32.join(e.runRoot,real?'client-win32.obj':'windows_pipe_client_test.obj'),...(real?[n.nodeLib.path,...t.files.filter(f=>['kernel32.lib','advapi32.lib','bcrypt.lib'].includes(path.win32.basename(f.path).toLowerCase())).map(f=>f.path)]:[])],output};};
 return {fake:[compile('packages/native/windows-pipe-client/client-core.cc','fake-core.obj',false),compile('tests/native/windows_pipe_client_test.cc','windows_pipe_client_test.obj',false),link(false)],real:[compile('packages/native/windows-pipe-client/client-core.cc','real-core.obj',true),compile('packages/native/windows-pipe-client/client-win32.cc','client-win32.obj',true),link(true)]};
}
function fakeImports(pe:ReturnType<typeof inspectWindowsPipeClientPe>){return pe.importedFunctions.every(name=>!/(?:^|!)(?:CreateNamedPipe[A-W]?|ConnectNamedPipe|CallNamedPipe[A-W]?|CreateProcess[A-W]?|CreateProcessAsUser[A-W]?|CreateProcessWithTokenW|CreateProcessWithLogonW|ShellExecute[A-W]?|ShellExecuteEx[A-W]?|TerminateProcess|TerminateJobObject|CreateJobObject[A-W]?|WinHttpSendRequest|WSAStartup|socket|connect)$/i.test(name));}
function outputRef(v:unknown,max:number):FileRef{const r=data.record(v,['path','bytes','sha256']);data.localPath(r.path);data.hash(r.sha256);must(typeof r.bytes==='number'&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=max);return r as FileRef;}
async function observedRead(ref:FileRef,read:WindowsPipeClientBuildPorts['read']){const b=await read(ref);must(Buffer.isBuffer(b)&&b.length===ref.bytes&&sha256(b)===ref.sha256,'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_UNCONFIRMED');return b;}
function identity(v:unknown){const i=data.record(v,['pid','creationFileTime']);must(typeof i.pid==='number'&&Number.isSafeInteger(i.pid)&&i.pid>0&&i.pid<=0xffffffff&&typeof i.creationFileTime==='string'&&/^[1-9][0-9]{0,19}$/.test(i.creationFileTime)&&BigInt(i.creationFileTime)<=18446744073709551615n);return i;}
function result(value:unknown,e:Execution){
 const v=data.record(data.snapshot(value),['state','exitCode','stdout','stderr','outputs','ownership','termination']);must(v.state==='RETURNED'&&v.exitCode===0,'WINDOWS_PIPE_CLIENT_BUILD_TOOL_UNCONFIRMED');
 const own=data.record(v.ownership,['runId','root','descendants']);must(typeof own.runId==='string'&&own.runId.length>0&&own.runId.length<=128&&Array.isArray(own.descendants)&&own.descendants.length<=64);const ids=[identity(own.root),...own.descendants.map(identity)];must(new Set(ids.map(i=>String(i.pid)+':'+i.creationFileTime)).size===ids.length);
 const term=data.record(v.termination,['rootExited','descendantsEmpty','stdioClosed','confirmedAt']);must(term.rootExited===true&&term.descendantsEmpty===true&&term.stdioClosed===true&&typeof term.confirmedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(term.confirmedAt)&&Number.isFinite(Date.parse(term.confirmedAt)),'WINDOWS_PIPE_CLIENT_BUILD_CLEANUP_UNCONFIRMED');
 const stdout=outputRef(v.stdout,e.limits.stdoutBytes),stderr=outputRef(v.stderr,e.limits.stderrBytes);must(Array.isArray(v.outputs)&&v.outputs.length<=32);const outputs=v.outputs.map(o=>outputRef(o,e.limits.outputBytes)),all=[stdout,stderr,...outputs];must(all.every(f=>under(e.runRoot,f.path))&&new Set(all.map(f=>data.key(f.path))).size===all.length&&all.reduce((a,f)=>a+f.bytes,0)<=e.limits.outputBytes&&stdout.bytes+stderr.bytes<=e.limits.logBytes);return {stdout,stderr,outputs,ownership:own,termination:term};
}
type InputLease={filesDigest:string;includePathsDigest:string;libPathsDigest:string;current():Promise<boolean>;release():void};
type BuildRecord={request:WindowsPipeClientToolRequest;result:unknown};
const retainedExecutors=new WeakMap<object,InputLease>();
function envFor(p:WindowsPipeClientBuildInput){return {SystemRoot:p.execution.systemRoot,TEMP:p.execution.runRoot,TMP:p.execution.runRoot,PATH:path.win32.dirname(p.toolchain.compiler.path)+';'+path.win32.join(p.execution.systemRoot,'System32')};}
function protection(p:WindowsPipeClientBuildInput,files:FileRef[]){return {filesDigest:digest(files),includePathsDigest:digest(p.toolchain.includePaths),libPathsDigest:digest(p.toolchain.libPaths)};}
function closed(value:unknown){try{const v=data.record(value,['state','exitCode','stdout','stderr','outputs','ownership','termination']);const t=data.record(v.termination,['rootExited','descendantsEmpty','stdioClosed','confirmedAt']);return t.rootExited===true&&t.descendantsEmpty===true&&t.stdioClosed===true;}catch{return false;}}
function exactOutput(c:Command,files:FileRef[]){
 const wanted=[data.key(c.output)];if(c.args.some(a=>a.startsWith('/OUT:'))){wanted.push(data.key(c.output+'.map'));if(c.output.endsWith('.node'))wanted.push(data.key(path.win32.join(path.win32.dirname(c.output),'windows-pipe-client.lib')),data.key(path.win32.join(path.win32.dirname(c.output),'windows-pipe-client.exp')));}
 must(files.every(f=>wanted.includes(data.key(f.path)))&&files.some(f=>data.key(f.path)===data.key(c.output))&&(!c.args.some(a=>a.startsWith('/OUT:'))||files.some(f=>data.key(f.path)===data.key(c.output+'.map'))),'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_UNCONFIRMED');
}
async function previousBuild(p:WindowsPipeClientBuildInput,read:WindowsPipeClientBuildPorts['read'],cap:Record<string,unknown>){
 const artifacts=p.execution.artifacts??[],manifest=artifacts.find(f=>path.win32.basename(f.path)==='fake-build-manifest.json');must(manifest&&artifacts.length>=3,'WINDOWS_PIPE_CLIENT_BUILD_ARTIFACT_REQUIRED');
 const m=data.record(data.parse(await observedRead(manifest,read),4194304),['version','mode','sourceDigest','toolchainDigest','nodeDigest','packageDigest','input','executor','protection','sourceBefore','sourceAfter','records','inputs','outputs','summary']);
 const original=validate(m.input);must(m.version===1&&m.mode==='fake-build'&&original.mode==='fake-build'&&m.packageDigest===digest(original)&&m.sourceDigest===original.source.digest&&m.toolchainDigest===original.toolchain.digest&&m.nodeDigest===digest(original.nodeApi)&&m.summary===null&&digest(m.sourceBefore)===digest(original.source.files)&&digest(m.sourceAfter)===digest(original.source.files));
 const expected={...original,mode:'fake-test',execution:{...original.execution,artifacts}};must(digest(expected)===digest(p),'WINDOWS_PIPE_CLIENT_BUILD_ORIGINAL_MISMATCH');
 const ex=data.record(m.executor,['id','version']);must(ex.id===cap.id&&ex.version===cap.version);const proof=data.record(m.protection,['filesDigest','includePathsDigest','libPathsDigest','released']);must(proof.released===true&&proof.filesDigest===digest([...allFiles(original),...(original.execution.artifacts??[])])&&proof.includePathsDigest===digest(original.toolchain.includePaths)&&proof.libPathsDigest===digest(original.toolchain.libPaths));
 must(Array.isArray(m.records)&&m.records.length===3&&Array.isArray(m.outputs)&&Array.isArray(m.inputs)&&m.inputs.length===0);const all=new Map<string,FileRef>(),commands=plan(original).fake;
 for(let i=0;i<m.records.length;i++){
  const r=data.record(m.records[i],['request','result']),q=data.record(r.request,['packageDigest','mode','executable','args','cwd','env','limits','outputRoot']);
  const limit=data.record(q.limits,['wallMs','stdoutBytes','stderrBytes','outputBytes']);must(q.packageDigest===m.packageDigest&&q.mode==='fake-build'&&digest(q.executable)===digest(commands[i].executable)&&digest(q.args)===digest(commands[i].args)&&q.cwd===original.execution.runRoot&&q.outputRoot===original.execution.runRoot&&digest(q.env)===digest(envFor(original))&&typeof limit.wallMs==='number'&&limit.wallMs>0&&limit.wallMs<=original.execution.limits.toolWallMs&&limit.stdoutBytes===original.execution.limits.stdoutBytes&&limit.stderrBytes===original.execution.limits.stderrBytes&&limit.outputBytes===original.execution.limits.outputBytes);
  const observed=result(r.result,original.execution);exactOutput(commands[i],observed.outputs);for(const f of [observed.stdout,observed.stderr,...observed.outputs]){const old=all.get(data.key(f.path));must(!old||digest(old)===digest(f));all.set(data.key(f.path),f);}
 }
 const outputs=[...all.values()];must(digest(outputs)===digest(m.outputs)&&digest([...outputs,manifest])===digest(artifacts),'WINDOWS_PIPE_CLIENT_BUILD_ARTIFACT_MISMATCH');
 for(const f of artifacts)await observedRead(f,read);
 const exe=outputs.find(f=>path.win32.basename(f.path)==='windows_pipe_client_test.exe'),map=exe&&outputs.find(f=>data.key(f.path)===data.key(exe.path+'.map'));must(exe&&map);const pe=inspectWindowsPipeClientPe(await observedRead(exe,read)),text=(await observedRead(map,read)).toString('utf8');must(!pe.dll&&pe.exports.length===0&&fakeImports(pe)&&!pe.imports.some(i=>/^(?:node\.exe|ws2_32\.dll|winhttp\.dll|wininet\.dll|shell32\.dll|urlmon\.dll)$/.test(i))&&!/client-win32|node\.lib|napi_/i.test(text)&&/fake-core|client-core/i.test(text)&&/windows_pipe_client_test/.test(text));
 return {exe,manifest};
}
export async function runWindowsPipeClientBuild(value:unknown,ports:WindowsPipeClientBuildPorts):Promise<WindowsPipeClientBuildResult>{
 const p=validate(value),raw=data.record(ports,['read','write','executor']);must(typeof raw.read==='function'&&typeof raw.write==='function');const read=raw.read.bind(ports) as WindowsPipeClientBuildPorts['read'],write=raw.write.bind(ports) as WindowsPipeClientBuildPorts['write'];
 let executor:WindowsPipeClientBuildExecutor|null=null;if(raw.executor!==null){const x=data.record(raw.executor,['inspect','run']);must(typeof x.inspect==='function'&&typeof x.run==='function');executor={inspect:x.inspect.bind(raw.executor),run:x.run.bind(raw.executor)} as WindowsPipeClientBuildExecutor;}
 const files=[...allFiles(p),...(p.execution.artifacts??[])];must(files.length<=4096&&new Set(files.map(f=>data.key(f.path))).size===files.length&&files.reduce((sum,f)=>sum+f.bytes,0)<=2147483648);for(const ref of files)await observedRead(ref,read);
 const packageDigest=digest(p),plans=plan(p),commands:Command[]=[],records:BuildRecord[]=[],allSeen=new Map<string,FileRef>(),fingerprint=protection(p,files);
 if(p.mode==='verify')return {state:'VERIFIED',packageDigest,commands,plans,outputs:[],executionReady:false};
 must(executor,'WINDOWS_PIPE_CLIENT_BUILD_EXECUTOR_REQUIRED');must(!retainedExecutors.has(raw.executor as object),'WINDOWS_PIPE_CLIENT_BUILD_CLEANUP_UNCONFIRMED');
 const cap=data.record(await executor.inspect(p.execution),['id','version','packageDigest','wallMs','stdoutBytes','stderrBytes','outputBytes','ownedTree','inputLease']);
 const leaseRaw=data.record(cap.inputLease,['filesDigest','includePathsDigest','libPathsDigest','current','release']);must(typeof leaseRaw.current==='function'&&typeof leaseRaw.release==='function');const lease={filesDigest:leaseRaw.filesDigest,includePathsDigest:leaseRaw.includePathsDigest,libPathsDigest:leaseRaw.libPathsDigest,current:leaseRaw.current.bind(cap.inputLease),release:leaseRaw.release.bind(cap.inputLease)} as InputLease;
 let releaseAttempted=false,releaseSucceeded=false,retained=false;
 const release=()=>{if(releaseAttempted)return;releaseAttempted=true;must(lease.release()===undefined,'WINDOWS_PIPE_CLIENT_BUILD_LEASE_RELEASE_UNCONFIRMED');releaseSucceeded=true;};
 const current=async()=>must(await lease.current()===true,'WINDOWS_PIPE_CLIENT_BUILD_INPUT_LEASE_LOST');
 const save=async(name:string,body:unknown)=>{const bytes=Buffer.from(JSON.stringify(body));must(bytes.length<=4194304&&bytes.length+[...allSeen.values()].reduce((sum,f)=>sum+f.bytes,0)<=p.execution.limits.outputBytes,'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_LIMIT');const ref={path:path.win32.join(p.execution.runRoot,name),bytes:bytes.length,sha256:sha256(bytes)};await write(ref,bytes);return ref;};
 try{
  must(typeof cap.id==='string'&&cap.id.length>0&&cap.id.length<=128&&typeof cap.version==='string'&&cap.version.length>0&&cap.version.length<=64&&cap.packageDigest===packageDigest&&cap.ownedTree===true&&typeof cap.wallMs==='number'&&Number.isSafeInteger(cap.wallMs)&&cap.wallMs>=p.execution.limits.totalWallMs&&typeof cap.stdoutBytes==='number'&&cap.stdoutBytes>=p.execution.limits.stdoutBytes&&typeof cap.stderrBytes==='number'&&cap.stderrBytes>=p.execution.limits.stderrBytes&&typeof cap.outputBytes==='number'&&cap.outputBytes>=p.execution.limits.outputBytes&&lease.filesDigest===fingerprint.filesDigest&&lease.includePathsDigest===fingerprint.includePathsDigest&&lease.libPathsDigest===fingerprint.libPathsDigest,'WINDOWS_PIPE_CLIENT_BUILD_EXECUTOR_UNCONFIRMED');
  await current();for(const ref of files)await observedRead(ref,read);await current();
  const original=p.mode==='fake-test'?await previousBuild(p,read,cap):null;
  const selected=original?[{executable:original.exe,args:[],output:''}]:p.mode==='real-build'?plans.real:plans.fake,env=Object.freeze(envFor(p));let summary:unknown=null,logBytes=0;const start=performance.now();
  for(const c of selected){
   await current();const left=Math.floor(p.execution.limits.totalWallMs-(performance.now()-start));must(left>0,'WINDOWS_PIPE_CLIENT_BUILD_TIMEOUT');
   const request:WindowsPipeClientToolRequest=Object.freeze({packageDigest,mode:p.mode,executable:c.executable,args:Object.freeze([...c.args]) as unknown as string[],cwd:p.execution.runRoot,env,limits:Object.freeze({wallMs:Math.min(left,p.mode==='fake-test'?p.execution.limits.fakeWallMs:p.execution.limits.toolWallMs),stdoutBytes:p.execution.limits.stdoutBytes,stderrBytes:p.execution.limits.stderrBytes,outputBytes:p.execution.limits.outputBytes}),outputRoot:p.execution.runRoot});
   const record:BuildRecord={request,result:null};records.push(record);record.result=data.snapshot(await executor.run(request));const observed=result(record.result,p.execution);await current();must(performance.now()-start<=p.execution.limits.totalWallMs,'WINDOWS_PIPE_CLIENT_BUILD_TIMEOUT');commands.push(c);
   logBytes+=observed.stdout.bytes+observed.stderr.bytes;must(logBytes<=p.execution.limits.logBytes,'WINDOWS_PIPE_CLIENT_BUILD_LOG_LIMIT');
   if(c.output)exactOutput(c,observed.outputs);
   for(const f of [observed.stdout,observed.stderr,...observed.outputs]){await observedRead(f,read);const old=allSeen.get(data.key(f.path));must(!old||digest(old)===digest(f),'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_CONFLICT');allSeen.set(data.key(f.path),f);}
   must([...allSeen.values()].reduce((sum,f)=>sum+f.bytes,0)<=p.execution.limits.outputBytes,'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_LIMIT');
   if(original){summary=data.record(data.parse(await observedRead(observed.stdout,read)),['version','passed','failed','retained']);const s=summary as Record<string,unknown>;must(s.version===1&&typeof s.passed==='number'&&Number.isSafeInteger(s.passed)&&s.passed>0&&s.failed===0&&s.retained===0,'WINDOWS_PIPE_CLIENT_BUILD_FAKE_FAILED');}
  }
  const outputs=[...allSeen.values()];
  if(p.mode!=='fake-test'){
   const binary=outputs.find(f=>f.path.endsWith(p.mode==='real-build'?'.node':'.exe')),map=binary&&outputs.find(f=>data.key(f.path)===data.key(binary.path+'.map'));must(binary&&map,'WINDOWS_PIPE_CLIENT_BUILD_OUTPUT_UNCONFIRMED');const pe=inspectWindowsPipeClientPe(await observedRead(binary,read)),mapText=(await observedRead(map,read)).toString('utf8');
   if(p.mode==='real-build')must(pe.dll&&digest(pe.exports)===digest(requiredExports)&&pe.imports.includes('node.exe')&&pe.imports.every(n=>['node.exe','kernel32.dll','advapi32.dll','bcrypt.dll'].includes(n))&&/client-win32/.test(mapText));
   else must(!pe.dll&&fakeImports(pe)&&pe.exports.length===0&&!pe.imports.some(i=>/^(?:node\.exe|ws2_32\.dll|winhttp\.dll|wininet\.dll|shell32\.dll|urlmon\.dll)$/.test(i))&&!/client-win32|node\.lib|napi_/i.test(mapText)&&/fake-core|client-core/i.test(mapText)&&/windows_pipe_client_test/.test(mapText));
  }
  for(const ref of files)await observedRead(ref,read);await current();release();
  const manifest=await save(p.mode+'-manifest.json',{version:1,mode:p.mode,sourceDigest:p.source.digest,toolchainDigest:p.toolchain.digest,nodeDigest:digest(p.nodeApi),packageDigest,input:p,executor:{id:cap.id,version:cap.version},protection:{...fingerprint,released:true},sourceBefore:p.source.files,sourceAfter:p.source.files,records,inputs:p.execution.artifacts??[],outputs,summary});
  return {state:p.mode==='fake-test'?'FAKE_TESTED':'BUILT',packageDigest,commands,plans,outputs:[...outputs,manifest],executionReady:false};
 }catch(error){
  const errors:unknown[]=[error];
  if((releaseAttempted&&!releaseSucceeded)||records.some(r=>!closed(r.result))){retained=true;retainedExecutors.set(raw.executor as object,lease);}else try{release();}catch(e){retained=true;retainedExecutors.set(raw.executor as object,lease);errors.push(e);}
  if(records.length)try{await save(p.mode+'-failure.json',{version:1,state:'UNCONFIRMED',mode:p.mode,packageDigest,input:p,executor:{id:cap.id,version:cap.version},records,retainedInputLease:retained,code:error instanceof DomainError?error.code:'WINDOWS_PIPE_CLIENT_BUILD_UNCONFIRMED'});}catch(e){errors.push(e);}
  if(errors.length>1)throw new AggregateError(errors,'WINDOWS_PIPE_CLIENT_BUILD_UNCONFIRMED');throw error;
 }
}

// 실제 경로 보호/동일 handle의 bounded reader는 아직 공급되지 않았다.
// 기본 CLI는 junction·크기 변경을 검사했다고 가장하지 않고 읽기 전 차단한다.
async function cli(){must(process.argv.length===3,'WINDOWS_PIPE_CLIENT_BUILD_ARGUMENT_INVALID');data.localPath(process.argv[2]);fail('WINDOWS_PIPE_CLIENT_BUILD_FILE_AUTHORITY_REQUIRED');}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){void cli().catch(error=>{console.error(JSON.stringify({code:error instanceof DomainError?error.code:'WINDOWS_PIPE_CLIENT_BUILD_UNCONFIRMED',ready:false}));process.exitCode=1;});}
