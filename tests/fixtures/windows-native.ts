import {expect,vi} from 'vitest';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {Writable} from 'node:stream';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {lstat,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import canonicalize from 'canonicalize';
import pg from 'pg';
import {NativeControllerDatabase} from '../../packages/storage/src/native-controller-role.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {FileObjectStore} from '../../packages/storage/src/objects.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import {FullStageCostCalculator,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import type {WindowsJournalMemory} from '../../packages/domain/src/windows-native-journal.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest,type NativeJobIntent} from '../../packages/domain/src/native-jobs.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {ExecutionLimitReference,OwnedExecutionLimitProfile} from '../../packages/domain/src/execution-limits.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {nativeKernelImplementationDigest} from '../../packages/native/src/identity.js';
import {createNativeJob,createNativeResult,type NativeLimits} from '../../packages/native/src/dto.js';
import {validateNativeJob} from '../../packages/native/src/jobs.js';
import type {NativeControllerBinding,NativeRawResultReference} from '../../packages/native/src/controller-protocol.js';
import type {NativeControllerPeer} from '../../packages/native/src/controller-attempts.js';
import {writeNativeFrame,type NativeFrame} from '../../packages/native/src/frame.js';
import type {NativeResult} from '../../packages/native/src/dto.js';
import type {WindowsJobEvidence,WindowsJobPolicy,WindowsJobAccounting} from '../../packages/native/src/windows-job-evidence.js';
import {validateWindowsJobEvidence} from '../../packages/native/src/windows-job-evidence.js';
import type {WindowsPrepareInput,WindowsSource,WindowsFact,JournalEntry,OriginalCapture,OriginalRef,WindowsSealEnvelope,WindowsPreparedAttempt,ParentJoinAck,HostFinalized,WindowsJobOutcome} from '../../packages/native/src/windows-job-backend.js';
import {encodeWindowsControl,decodeWindowsControl,decodeWindowsHostMessage,type WindowsControl,type WindowsHostMessage,type WindowsJobPorts} from '../../packages/native/src/windows-job-backend.js';
import {seedIdentity,seedWorkspace,testDatabase} from './database.js';
import {ownedNativePng} from './native-images.js';

export const windowsNativeLimits:NativeLimits={maxMetadataBytes:4096,maxInputBytes:16384,maxOutputBytes:16384,maxItems:8,childMemoryBytes:16777216,maxProcesses:4,timeoutMs:1000,terminationWaitMs:500,parentInFlightBytes:8*1024*1024};
export const windowsFrameLimits={maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8};
export type WindowsCapacitySpecimen={kind:'WINDOWS_JOB_OBJECT';version:string;maxSlots:number;nativeProfileDigest:string;kernelDigest:string;controllerId:string;keyVersion:string;environmentDigest:string;publicKeySpki:string;evidenceRefs:string[];windows:{hostEpochId:string;policy:WindowsJobPolicy;pins:WindowsJobEvidence['pins'];controllerSidDigest:string;childSidDigest:string;appContainerSidDigest:string}};
export const windowsEvidenceBounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
export type WindowsNativeAccountingOverrides=Partial<Omit<WindowsJobAccounting,'snapshotScope'|'memoryAccounting'>>;

// All OS-shaped values below are fake W2 source/clock/frame specimens. Defaults
// retain t0=120/t1=127; accounting is applied before the original chain is built.
export function windowsNativeScript(input:WindowsPrepareInput,mode:'CREATED'|'NOT_ATTEMPTED'|'UNKNOWN'='CREATED',accountingOverrides:WindowsNativeAccountingOverrides={}){
  const originDigest=digest({identity:input.identity,authority:input.authority,pins:input.pins,policy:input.policy,nativeLimitsDigest:digest(input.limits),frameInputDigest:input.frame.envelope.inputDigest});
  const accounting:WindowsJobAccounting={userTime100ns:'9007199254740993',kernelTime100ns:'300',peakJobMemoryBytes:'16384',peakProcessMemoryBytes:'8192',readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0',totalProcesses:'2',startQpcTicks:'120',endQpcTicks:'210',qpcFrequency:'10000000',snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS',...accountingOverrides};
  const qpc=(ticks:string)=>ticks==='210'?accounting.endQpcTicks:ticks==='209'?(BigInt(accounting.endQpcTicks)-1n).toString():(BigInt(accounting.startQpcTicks)+BigInt(ticks)-120n).toString();
  const entries:JournalEntry[]=[];
  type Event=JournalEntry['event'];
  const add=<K extends Event['kind']>(kind:K,payload:Extract<Event,{kind:K}>['payload'],facts:WindowsFact[]=[])=>{
    const body={eventId:randomUUID(),sequence:entries.length+1,kind,qpcTicks:qpc(String(100+entries.length*10)),previousDigest:entries.at(-1)?.event.payloadDigest??null,payload};
    const event={...body,payloadDigest:digest(body)} as Event;
    const source:WindowsSource={version:1,originDigest,eventId:event.eventId,facts};
    entries.push({event,source,sourceDigest:digest(source)});
  };
  const win=(api:string,value:unknown,qpcTicks:string,callId=randomUUID()):WindowsFact=>({kind:'WIN32',callId,api,qpcTicks:qpc(qpcTicks),status:'RETURNED',win32Error:null,value});
  const io=(lane:'IN'|'OUT'|'ERR',operation:'READ'|'WRITE'|'CLOSE',qpcTicks:string,bytes:Buffer):WindowsFact=>({kind:'IO',callId:randomUUID(),lane,operation,qpcTicks:qpc(qpcTicks),status:'RETURNED',bytesLength:String(bytes.length),sha256:sha256(bytes)});
  const root={pid:42,creationFileTime100ns:'133000000000000000'},createCallId=randomUUID(),processRef=randomUUID(),threadRef=randomUUID();
  const joinAck:ParentJoinAck={joinId:randomUUID(),originDigest,digest:sha256('W3-A fake original parent joined')};
  const osReadback={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,killOnJobClose:true as const,breakawayAllowed:false as const};
  const brokerApplied={wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const tokenValues=[{informationClass:'TOKEN_USER',values:{sidDigest:input.authority.childSidDigest}},{informationClass:'TOKEN_APPCONTAINER_SID',values:{sidDigest:input.authority.appContainerSidDigest}},{informationClass:'TOKEN_IS_APPCONTAINER',values:{isAppContainer:true}},{informationClass:'TOKEN_INTEGRITY_LEVEL',values:{sidDigest:sha256('w3a-fake-low-integrity')}},{informationClass:'TOKEN_SESSION_ID',values:{sessionId:7}}];
  const basic={TotalUserTime:accounting.userTime100ns,TotalKernelTime:accounting.kernelTime100ns,ThisPeriodTotalUserTime:accounting.userTime100ns,ThisPeriodTotalKernelTime:accounting.kernelTime100ns,TotalPageFaultCount:1,TotalProcesses:Number(accounting.totalProcesses),ActiveProcesses:0,TotalTerminatedProcesses:Number(accounting.totalProcesses)};
  const ioValues={ReadOperationCount:accounting.readOperations,WriteOperationCount:accounting.writeOperations,OtherOperationCount:accounting.otherOperations,ReadTransferCount:accounting.readBytes,WriteTransferCount:accounting.writeBytes,OtherTransferCount:accounting.otherBytes};
  const extended={BasicLimitInformation:{PerProcessUserTimeLimit:'0',PerJobUserTimeLimit:'0',LimitFlags:0x2308,MinimumWorkingSetSize:'0',MaximumWorkingSetSize:'0',ActiveProcessLimit:4,Affinity:'0',PriorityClass:0,SchedulingClass:0},IoInfo:ioValues,ProcessMemoryLimit:'524288',JobMemoryLimit:'1048576',PeakProcessMemoryUsed:accounting.peakProcessMemoryBytes,PeakJobMemoryUsed:accounting.peakJobMemoryBytes};
  let goGrantRef:{jobId:string;rowDigest:string}|null=null;
  add('PRE_CREATE',{bindingDigest:digest(input.identity),policyDigest:input.authority.policyDigest,pinsDigest:digest(input.pins)});
  if(mode==='NOT_ATTEMPTED')add('CREATE_NOT_ATTEMPTED',{code:'WINDOWS_POLICY_UNCONFIRMED'});
  else add('CREATE_ARMED',{callId:createCallId});
  if(mode==='CREATED'){
    add('CREATED_SUSPENDED',{...root,assignedBy:'PROC_THREAD_ATTRIBUTE_JOB_LIST'},[win('CreateProcessAsUserW',{processRef,threadRef,pid:42},'120',createCallId),win('GetProcessTimes',{processRef,creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'127')]);
    add('PREPARED',{membershipConfirmed:true,tokenDigest:digest(tokenValues),osReadbackDigest:digest(osReadback),brokerAppliedDigest:digest(brokerApplied)},[win('IsProcessInJob',{isMember:true},'128'),...tokenValues.map(value=>win('GetTokenInformation',value,'128')),win('GetProcessTimes',{processRef,creationFileTime100ns:root.creationFileTime100ns,userTime100ns:'0',kernelTime100ns:'0'},'129'),win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'129'),win('QueryInformationJobObject',{informationClass:'CPU_RATE',values:{ControlFlags:5,CpuRate:2000}},'130')]);
    add('BOOTSTRAP_RESUMED',{resumeReturned:true},[win('ResumeThread',{previousSuspendCount:1},'135'),io('OUT','READ','140',Buffer.from('WAIT_V1\n'))]);
  }
  const prepared:WindowsPreparedAttempt={originDigest,attemptId:input.authority.attemptId,controllerInstanceId:input.authority.controllerInstanceId,sessionId:input.authority.sessionId,launchId:input.authority.launchId,root};
  const complete=(go:{jobId:string;rowDigest:string})=>{
    expect(mode).toBe('CREATED');expect(goGrantRef).toBeNull();goGrantRef=go;
    add('GO_AUTHORIZED',{goGrantRef:go},[{kind:'ORIGINAL_GO',qpcTicks:qpc('150'),goGrantRef:go}]);
    add('GO_WRITE_ARMED',{bytesLength:'6'});
    add('GO_WRITE',{result:'RETURNED',bytesLength:'6'},[io('IN','WRITE','170',Buffer.from('GO_V1\n'))]);
    add('ROOT_EXIT',{exitCode:0},[win('WaitForSingleObject',{waitResult:'SIGNALED'},'180'),win('GetExitCodeProcess',{exitCode:0},'180')]);
    add('TREE_EMPTY',{activeProcesses:0,totalProcesses:accounting.totalProcesses},[win('QueryInformationJobObject',{informationClass:'BASIC_ACCOUNTING',values:basic},'190')]);
    add('IO_JOINED',{stdinClosed:true,stdoutEof:true,stderrEof:true,parentIoJoined:true},[io('IN','CLOSE','198',Buffer.alloc(0)),io('OUT','READ','198',Buffer.alloc(0)),io('ERR','READ','198',Buffer.alloc(0)),io('OUT','READ','175',Buffer.from('READY_V1\n')),{kind:'PARENT_ACK',qpcTicks:qpc('200'),ack:joinAck}]);
    add('FINAL_ACCOUNTING',{accounting},[win('QueryInformationJobObject',{informationClass:'BASIC_AND_IO',values:{BasicInfo:basic,IoInfo:ioValues}},'209'),win('QueryInformationJobObject',{informationClass:'EXTENDED_LIMITS',values:extended},'209'),win('QueryPerformanceFrequency',{frequency:accounting.qpcFrequency},'209'),win('QueryPerformanceCounter',{ticks:accounting.endQpcTicks},'210')]);
  };
  const evidence=():WindowsJobEvidence=>validateWindowsJobEvidence({version:1,kind:'WINDOWS_JOB_OBJECT',identity:input.identity,authority:input.authority,pins:input.pins,policy:{requested:input.policy,osReadback:mode==='CREATED'?osReadback:null,brokerApplied:mode==='CREATED'?brokerApplied:null},lifecycle:{creation:mode==='UNKNOWN'?'UNCONFIRMED':mode,root:mode==='CREATED'?root:null,goGrantRef,goWrite:goGrantRef?'RETURNED':'NOT_ATTEMPTED',rootExit:goGrantRef?{exitCode:0,observedQpcTicks:qpc('180')}:null,events:entries.map(row=>row.event)},final:{outcome:mode==='UNKNOWN'?'UNCONFIRMED':mode==='NOT_ATTEMPTED'?'NO_CHILD_CREATED':goGrantRef?'JOB_EMPTY':'UNCONFIRMED',activeProcesses:goGrantRef?0:null,rootSignaled:goGrantRef!==null,stdioJoined:goGrantRef!==null,parentIoJoined:mode==='NOT_ATTEMPTED'||goGrantRef!==null,recordSealed:mode!=='UNKNOWN',accounting:goGrantRef?accounting:null,failureCode:mode==='UNKNOWN'?'WINDOWS_CREATE_UNCONFIRMED':mode==='NOT_ATTEMPTED'?'WINDOWS_POLICY_UNCONFIRMED':goGrantRef?null:'WINDOWS_INCOMPLETE'}},windowsEvidenceBounds);
  const seal=():WindowsSealEnvelope=>({version:1,originDigest,evidence:evidence(),entries:entries.map(row=>({eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest})),parentJoinAck:mode==='UNKNOWN'?null:joinAck});
  const finalized=(ref:OriginalRef):HostFinalized=>({...ref,handles:'CLOSED',closeCode:null});
  const outcome=(ref:OriginalRef,rawResult:NativeRawResultReference|null):WindowsJobOutcome=>({state:mode==='UNKNOWN'?'WAIT':'JOINED',code:mode==='CREATED'?'OK':mode==='UNKNOWN'?'WINDOWS_CREATE_UNCONFIRMED':'WINDOWS_POLICY_UNCONFIRMED',evidence:evidence(),rawResult,journalRef:ref});
  return {originDigest,entries,prepared,joinAck,complete,evidence,seal,finalized,outcome};
}

// Installed inside Vitest only. The outer approved runner owns PG/Vitest
// processes; no process, native addon, listener or external socket is allowed here.
export function guardWindowsNativeIo(){
  const url=new URL(process.env.TRIO_TEST_DATABASE_URL??'http://invalid');
  if(url.hostname!=='127.0.0.1'||!url.port)throw new Error('WINDOWS_FIXTURE_REQUIRES_ISOLATED_LOOPBACK_PG');
  const denied:string[]=[],restore:(()=>void)[]=[];
  const fail=(operation:string)=>(..._args:unknown[]):never=>{denied.push(operation);throw new Error(`W3A_FORBIDDEN_${operation}`);};
  for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const){const spy=vi.spyOn(childProcess,method).mockImplementation(fail('PROCESS'));restore.push(()=>spy.mockRestore());}
  const addon=vi.spyOn(process,'dlopen').mockImplementation(fail('WIN32_NATIVE_ADDON'));restore.push(()=>addon.mockRestore());
  const connect=net.Socket.prototype.connect;
  const socket=vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(this:net.Socket,...args:unknown[]){
    const normalized=Array.isArray(args[0])?args[0]:args;
    const first=normalized[0],options=first!==null&&typeof first==='object'?first as {host?:unknown;port?:unknown;path?:unknown}:{host:normalized[1],port:first,path:undefined};
    if(options.path||options.host!=='127.0.0.1'||String(options.port)!==url.port)return fail('NETWORK')();
    return Reflect.apply(connect,this,args) as net.Socket;
  });restore.push(()=>socket.mockRestore());
  const listen=vi.spyOn(net.Server.prototype,'listen').mockImplementation(fail('LISTENER'));restore.push(()=>listen.mockRestore());
  for(const module of [http,https])for(const method of ['request','get'] as const){const spy=vi.spyOn(module,method).mockImplementation(fail('HTTP'));restore.push(()=>spy.mockRestore());}
  const secure=vi.spyOn(tls,'connect').mockImplementation(fail('TLS'));restore.push(()=>secure.mockRestore());
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(fail('FETCH'));restore.push(()=>fetch.mockRestore());
  return {denied,restore:()=>{for(const undo of restore.reverse())undo();}};
}

export async function windowsNativeFixture(baseFontSizePx=20,suppliedDatabase?:Database){
  const connections:{close():Promise<void>}[]=[],clients:pg.Client[]=[];
  const resources:{memory:WindowsJournalMemory|null;journals:{close():Promise<void>}[]}={memory:null,journals:[]};
  let closed=false;
  const close=async()=>{
    if(closed)return;closed=true;
    for(const journal of resources.journals.reverse())await journal.close();
    if(resources.memory)expect(resources.memory.available()).toBe(resources.memory.maxBytes);
    for(const client of clients.reverse())await client.end();for(const db of connections.reverse())await db.close();
  };
  try{
    const admin=suppliedDatabase??await testDatabase();connections.push(admin);
    expect((await admin.pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^18\./);
    const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');connections.push(api,worker);
    await api.validateServiceRole();await worker.validateServiceRole();
    async function login(role:'trio_web_controller'|'trio_web_operator'){
      const name='trio_w3a_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('base64url');
      await admin.pool.query(`CREATE ROLE "${name}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await admin.pool.query(`GRANT ${role} TO "${name}"`);
      const url=new URL(admin.connectionString);url.username=name;url.password=password;
      const client=new pg.Client({connectionString:url.toString(),options:'-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp'});await client.connect();clients.push(client);await client.query(`SET ROLE ${role}`);
      return {client,name,connectionString:url.toString()};
    }
    const operator=await login('trio_web_operator'),controller=await login('trio_web_controller');
    const controllerDb=new NativeControllerDatabase(controller.connectionString,controller.name);connections.push(controllerDb);await controllerDb.validate();
    const originalDecision=controllerDb.decision.bind(controllerDb),decisionCalls:string[]=[];let lostAckFunction:string|null=null;
    controllerDb.decision=async(accountId,query,values,check)=>{
      decisionCalls.push(query);const result=await originalDecision(accountId,query,values,check);
      if(lostAckFunction&&query.includes(lostAckFunction)){lostAckFunction=null;throw new Error('W3A_ACK_LOST_AFTER_COMMIT');}
      return result;
    };
    const loseNextDecision=(name:string)=>{expect(lostAckFunction).toBeNull();expect(/^windows_native_[a-z_]+$/.test(name)).toBe(true);lostAckFunction=name;};
    const key=generateKeyPairSync('ed25519'),controllerInstanceId=randomUUID(),peer:NativeControllerPeer={serviceRole:'trio_web_worker',peerId:randomUUID()};
    const objectRoot=await mkdtemp(path.join(tmpdir(),'trio-w3a-native-objects-'));
    expect(path.dirname(path.resolve(objectRoot)).toLowerCase()).toBe(path.resolve(tmpdir()).toLowerCase());expect((await lstat(objectRoot)).isSymbolicLink()).toBe(false);
    const files=new FileObjectStore(objectRoot,windowsFrameLimits.maxBinaryBytes),objectIo={get:0,put:0};
    const policy:WindowsJobPolicy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
    const pins={executableDigest:sha256('w3a-fake-node'),bootstrapDigest:sha256('w3a-fake-bootstrap'),helperRuntimeDigest:sha256('w3a-fake-python'),helperScriptDigest:sha256('w3a-fake-helper'),runtimeFilesDigest:sha256('w3a-fake-runtime'),nativeLimitsDigest:digest(windowsNativeLimits)};
    const profile:WindowsCapacitySpecimen={kind:'WINDOWS_JOB_OBJECT',version:'windows-w3a-synthetic-v1',maxSlots:2,nativeProfileDigest:digest(syntheticProfile),kernelDigest:nativeKernelImplementationDigest(),controllerId:randomUUID(),keyVersion:'windows-w3a-key-v1',environmentDigest:sha256('w3a-synthetic-environment'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['windows-job:w3a/synthetic-originals'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('w3a-fake-controller-sid'),childSidDigest:sha256('w3a-fake-child-sid'),appContainerSidDigest:sha256('w3a-fake-container-sid')}};
    const profileId=randomUUID();
    const registerWindowsProfile=async()=>{
      const row=(await operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
      await operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
      return {reference:{kind:'WINDOWS_JOB_OBJECT' as const,profileId,profileDigest:row.profile_digest,profileVersion:profile.version},profile};
    };
    const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
    const executionProfile:OwnedExecutionLimitProfile={kind:'OWNED_FIXTURE',version:'w3a-execution-limits-v1',maxSlots:2,requestLimitUsd:'10',dailyLimitUsd:'100',fullBoundUsd:'10',stages:{OCR:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:w3a/ocr']},TRANSLATE:{boundUsd:'2',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:w3a/translate']}},fullBoundEvidenceRefs:['owned-fixture:w3a/full-cost'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+23*3600000).toISOString()}};
    const executionProfileId=randomUUID();
    const executionRow=(await operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest`,[executionProfileId,JSON.stringify(executionProfile),executionProfile.version,executionProfile.maxSlots,executionProfile.requestLimitUsd,executionProfile.dailyLimitUsd,executionProfile.fullBoundUsd,JSON.stringify(executionProfile.stages),JSON.stringify(executionProfile.fullBoundEvidenceRefs),executionProfile.window!.kind,executionProfile.window!.startAt,executionProfile.window!.endAt])).rows[0];
    await operator.client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[executionProfileId]);
    const executionLimit:ExecutionLimitReference={kind:'OWNED_FIXTURE',profileId:executionProfileId,profileDigest:executionRow.profile_digest,profileVersion:executionProfile.version};
    const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
    const requestPolicy:RequestPolicy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false,executionLimit,parameterProfileVersion:executionLimit.profileVersion};
    const workspace=new WorkspaceService(api,requestPolicy),provider=new SyntheticProvider(),service=new ExecutionService(worker,provider,requestPolicy);
    const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
    const command=async(operation:import('../../packages/contracts/src/wire.generated.js').WorkspaceCommand['operation'])=>{
      const row=(await admin.pool.query('SELECT generation,owner_revision,workspace_revision FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId])).rows[0];
      return {commandId:randomUUID(),intentVersion:1 as const,target:{contextId:seed.contextId,contextGeneration:row.generation as string,tabId:seed.tabId,expectedOwnerRevision:row.owner_revision as string,expectedWorkspaceRevision:row.workspace_revision as string},operation};
    };
    await workspace.handle(actor,await command({kind:'PATCH_SETTINGS',payload:{settings:{settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx,minFontSizePx:10}}}));
    const request=async()=>(await workspace.handle(actor,await command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}}))).reply.operationRef.id!;
    async function prepareExecution(){
      const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');
      const input=await service.authorize(claim!);expect(input).not.toBeNull();
      return {claim:claim!,input:input!};
    }
    async function seedBasis(input:StageInput,largeSnapshot=false){
      // A synthetic original BASIS is an actual owning-worker DB row. It makes
      // no measurement/rate/cost claim and never starts a provider or native job.
      const basisProfileDigest=sha256('W3-A synthetic basis profile');
      const mode=(await admin.pool.query<{mode:'FREE'|'PAID'}>('SELECT mode FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[seed.accountId,input.requestId])).rows[0].mode;
      const snapshot:FullStageCostSnapshot|null=largeSnapshot?{version:1,state:'UNMEASURED',stage:input.stage as 'OCR'|'TRANSLATE',profileDigest:basisProfileDigest,basisVersion:'w3a-large-unmeasured-snapshot-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:Array.from({length:60},(_value,index)=>`w3a-synthetic-unmeasured-${index}-`.padEnd(1600,'x')),components:[]}:null;
      const calculated=new FullStageCostCalculator(snapshot,{maxInputBytes:131072,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:4096}).calculate({accountId:seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:input.stage as 'OCR'|'TRANSLATE',profileDigest:basisProfileDigest,mode},{provider:null,quantities:null,allocation:null});
      const value={version:1,accountId:seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:calculated.capture,captureDigest:calculated.captureDigest,snapshot:calculated.snapshot,snapshotDigest:calculated.snapshotDigest}};
      expect(Buffer.byteLength(canonicalize(value)!)).toBeLessThanOrEqual(131072);
      const evidenceId=randomUUID(),evidenceDigest=digest(value);
      await worker.accountTransaction(seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,$5,$6)",[seed.accountId,evidenceId,input.executionId,evidenceDigest,tx.now,JSON.stringify(value)]));
      return {evidenceId,evidenceDigest,value};
    }
    async function checkpointRetry(){
      const originalRequestId=await request(),successful=new SyntheticProvider();
      const checkpointProvider=new SyntheticProvider(input=>input.stage==='TRANSLATE'?{evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:'0.02',usageConfirmed:true,finishReason:'W3A_SYNTHETIC_FAILURE',providerRef:input.executionId,data:null}:successful.success(input));
      const checkpointService=new ExecutionService(worker,checkpointProvider,requestPolicy);
      let drained=false;for(let n=0;n<30;n++){if(!await checkpointService.runOnce()){drained=true;break;}}expect(drained).toBe(true);
      expect((await admin.pool.query('SELECT state FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[seed.accountId,originalRequestId])).rows[0].state).toBe('FAILED');
      const source=(await admin.pool.query<{execution_id:string;protected_observation:StageInput}>("SELECT e.execution_id,i.protected_observation FROM manga_web.checkpoints e JOIN manga_web.execution_evidence i USING(account_id,execution_id) WHERE e.account_id=$1 AND i.kind='INPUT'",[seed.accountId])).rows;expect(source).toHaveLength(1);
      const retryId=(await workspace.handle(actor,await command({kind:'RETRY_REQUEST',payload:{requestId:originalRequestId}}))).reply.operationRef.id!;
      let claim:Claim|null=null;
      for(let n=0;n<8;n++){
        const item=await service.claim();expect(item).not.toBeNull();
        if(item!.kind==='SETTLE'){expect(await service.settle(item!.accountId,item!.ref.costItemId)).toBe(true);await service.finish(item!,true);continue;}
        expect(item!.kind).toBe('DISPATCH');claim=item;break;
      }
      expect(claim).not.toBeNull();expect(checkpointProvider.calls).toHaveLength(2);
      return {claim:claim!,input:source[0].protected_observation,originalRequestId,retryId};
    }
    async function originalIntent(prepared:{claim:Claim;input:StageInput},targetKind:'EXECUTION'|'REQUEST_CHECKPOINT'='EXECUTION',requestId=prepared.input.requestId,task:'DECODE_IMAGE'|'POLYGON_MASK'='DECODE_IMAGE'){
      const {input,claim}=prepared;
      const source=(await admin.pool.query<{evidence_id:string;evidence_digest:string;protected_observation:StageInput}>("SELECT evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[seed.accountId,input.executionId])).rows;expect(source).toHaveLength(1);
      const owner=(await admin.pool.query('SELECT generation,owner_revision,workspace_revision,owner_session_id,owner_tab_id FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[seed.accountId,seed.contextId])).rows[0];
      const blobs=task==='POLYGON_MASK'?new Map<string,Buffer>():new Map([['source',Buffer.from(ownedNativePng,'base64')]]);
      const metadata=task==='POLYGON_MASK'?{profile:syntheticProfile,width:4,height:4,polygons:[[{x:0.25,y:0.25},{x:3.75,y:0.25},{x:0.75,y:3.75}]]}:{profile:syntheticProfile,sourceBlobId:'source'};
      const job=createNativeJob(task,profile.nativeProfileDigest,metadata,blobs,windowsFrameLimits);validateNativeJob({envelope:job,blobs});
      const value={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind,targetId:targetKind==='EXECUTION'?input.executionId:requestId,semanticCaptureDigest:digest({phase:targetKind,input:input.inputDigest,requestId}),protectedOwnerCapture:{contextId:seed.contextId,contextGeneration:owner.generation as string,ownerSessionId:owner.owner_session_id as string,ownerTabId:owner.owner_tab_id as string,ownerRevision:owner.owner_revision as string,workspaceRevision:owner.workspace_revision as string},claim:{generation:claim.generation,ownerId:service.workerId,workItemId:claim.workId}};
      const intent:NativeJobIntent={...value,logicalOperationKey:nativeLogicalOperationKey(value)};
      const sourceInput={executionId:input.executionId,inputEvidenceId:source[0].evidence_id,stageInputDigest:input.inputDigest};
      const reserve=async(capacity:Awaited<ReturnType<typeof registerWindowsProfile>>)=>worker.accountTransaction(seed.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string;capacityReservationId?:string}}>('SELECT manga_web.native_capacity_create_intent($1::jsonb,false,$2::jsonb) AS decision',[JSON.stringify(intent),JSON.stringify({...capacity,sourceInput})])).rows[0].decision);
      const binding=(reservationId:string):NativeControllerBinding=>({accountId:seed.accountId,capacityReservationId:reservationId,jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:profile.kernelDigest});
      return {intent,sourceInput,inputRecord:source[0],frame:{envelope:job,blobs},reserve,binding};
    }
    const signer={keyVersion:profile.keyVersion,publicKeySpki:profile.publicKeySpki,sign:async(canonical:string)=>sign(null,Buffer.from(canonical),key.privateKey).toString('base64')};
    return Object.assign(resources,{admin,api,worker,operator,controller,controllerDb,controllerInstanceId,peer,profile,profileId,signer,seed,provider,service,workspace,actor,command,request,prepareExecution,seedBasis,checkpointRetry,originalIntent,registerWindowsProfile,files,objectIo,requestPolicy,loseNextDecision,decisionCalls,close});
  }catch(error){await close();throw error;}
}
export type WindowsNativeFixture=Awaited<ReturnType<typeof windowsNativeFixture>>;

export async function storeWindowsNativeRaw(f:WindowsNativeFixture,capture:OriginalCapture,frame:NativeFrame<NativeResult>):Promise<NativeRawResultReference>{
  const refs=frame.envelope.blobs.map(blob=>({blobId:blob.id,assetId:randomUUID(),sha256:blob.sha256,bytesLength:String(blob.byteLength)}));
  const binding=capture.origin.identity.binding;
  const allocation=await f.controllerDb.decision<{allowed:boolean;created:boolean;allocation:{reference:NativeRawResultReference}}>(binding.accountId,'SELECT manga_web.native_controller_allocate_raw($1::jsonb,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) AS decision',[JSON.stringify(binding),capture.origin.authority.attemptId,f.controllerInstanceId,f.profile.controllerId,f.peer.serviceRole,randomUUID(),canonicalize(frame.envelope),JSON.stringify(refs),f.files.bucket]);
  expect(allocation.created).toBe(true);
  for(const ref of refs){
    const key=`${binding.accountId}/${ref.assetId}`,bytes=frame.blobs.get(ref.blobId);expect(bytes).toBeDefined();
    f.objectIo.put++;const proof=await f.files.put(key,bytes!);f.objectIo.get++;expect(await f.files.read(key)).toEqual(bytes);
    await f.controllerDb.decision(binding.accountId,'SELECT manga_web.native_controller_register_raw_object($1::jsonb,$2,$3,$4,$5,$6::jsonb,$7) AS decision',[JSON.stringify(binding),f.profile.controllerId,f.peer.serviceRole,allocation.allocation.reference.rawResultId,ref.blobId,JSON.stringify(proof),f.files.bucket]);
  }
  return allocation.allocation.reference;
}

function windowsDeferred<T>(){let resolve!:(value:T)=>void;const done=new Promise<T>(accept=>{resolve=accept;});return {done,resolve};}
class WindowsFixtureQueue<T> implements AsyncIterable<T>{
  private values:T[]=[];private waiting:((value:IteratorResult<T>)=>void)[]=[];private ended=false;
  push(value:T){if(this.ended)throw new Error('W3B_QUEUE_ALREADY_ENDED');const next=this.waiting.shift();if(next)next({done:false,value});else this.values.push(value);}
  end(){this.ended=true;for(const next of this.waiting.splice(0))next({done:true,value:undefined});}
  [Symbol.asyncIterator]():AsyncIterator<T>{return {next:async()=>{if(this.values.length)return {done:false,value:this.values.shift()!};if(this.ended)return {done:true,value:undefined};return new Promise(resolve=>this.waiting.push(resolve));}};}
}

// Virtual time has no system timer. Cancellation joins its actual done promise.
export function createWindowsNativeClock(initialMs=0){
  let now=initialMs;const waits=new Set<{at:number;resolve:()=>void}>();
  const clock={nowMs:()=>now,startWait:(at:number)=>{
    const signal=windowsDeferred<void>(),wait={at,resolve:()=>signal.resolve()};
    if(at<=now)signal.resolve();else waits.add(wait);
    return {done:signal.done,cancel:async()=>{waits.delete(wait);signal.resolve();await signal.done;}};
  }};
  return {clock,advance:(milliseconds:number)=>{expect(milliseconds).toBeGreaterThanOrEqual(0);now+=milliseconds;for(const wait of [...waits])if(wait.at<=now){waits.delete(wait);wait.resolve();}},pending:()=>waits.size};
}

// Shared fake host: every event and control uses the real W2 codec. It never
// opens a process, addon, socket or listener. The sealed parent fact is the ACK
// received from the real parent, and FINALIZED/join cannot precede that ACK.
export function createWindowsNativeBroker(input:WindowsPrepareInput|NativeFrame<import('../../packages/native/src/dto.js').NativeJob>,options:{result?:NativeFrame<NativeResult>;brokerEnd?:'EXPECTED'|'LOST';handles?:'CLOSED'|'UNCONFIRMED';parentRelease?:Promise<void>;accounting?:WindowsNativeAccountingOverrides}={}){
  const frame='frame'in input?input.frame:input;
  const blobs=new Map([['output',Buffer.from(ownedNativePng,'base64')]]);
  const result=options.result??{envelope:createNativeResult(frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalBlobId:'output'},blobs},windowsFrameLimits),blobs};
  const controls:WindowsControl[]=[],captures:OriginalCapture[]=[],receivedParentAcks:ParentJoinAck[]=[],inputChunks:Buffer[]=[],failures:unknown[]=[];
  const messages=new WindowsFixtureQueue<WindowsHostMessage>(),output=new WindowsFixtureQueue<Uint8Array>(),errors=new WindowsFixtureQueue<Uint8Array>();
  const acks=new Map<string,ReturnType<typeof windowsDeferred<void>>>(),inputDone=windowsDeferred<void>(),treeDone=windowsDeferred<void>();
  const joined=windowsDeferred<{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}>();
  let script:ReturnType<typeof windowsNativeScript>|undefined,finalized:HostFinalized|null=null,joins=0,stopped=false;
  const nativeInput=new Writable({write:(chunk:Buffer,_encoding,done)=>{inputChunks.push(Buffer.from(chunk));done();},final:done=>{inputDone.resolve();done();}});
  const message=(control:WindowsControl,kind:WindowsHostMessage['message'],payload:unknown)=>{
    if(stopped)return;const value={version:1,requestId:control.requestId,originDigest:control.originDigest,attemptId:control.attemptId,sessionId:control.sessionId,launchId:control.launchId,message:kind,payload};
    const body=Buffer.from(canonicalize(value)!),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);messages.push(decodeWindowsHostMessage(Buffer.concat([prefix,body])));
  };
  const emit=async(control:WindowsControl,index:number)=>{
    if(stopped)return;const row=script!.entries[index],ack=windowsDeferred<void>();acks.set(row.event.eventId,ack);message(control,'EVENT',row);await ack.done;acks.delete(row.event.eventId);
  };
  const work=(operation:()=>Promise<void>)=>{void operation().catch(error=>{failures.push(error);if(stopped)return;stopped=true;messages.end();output.end();errors.end();for(const ack of acks.values())ack.resolve();inputDone.resolve();treeDone.resolve();joined.resolve({end:'LOST',finalized:null});});};
  const broker:WindowsJobPorts['broker']={
    open:async capture=>{
      expect(captures).toHaveLength(0);captures.push(capture);const prepared={...capture.origin,frame};script=windowsNativeScript(prepared,'CREATED',options.accounting);
      expect(script.originDigest).toBe(capture.originDigest);
      return {nativeInput,nativeOutput:output,nativeError:errors,events:messages,join:()=>{joins++;return joined.done;},send:async value=>{
        const control=decodeWindowsControl(encodeWindowsControl(value));controls.push(control);expect(control.originDigest).toBe(capture.originDigest);
        expect(control.attemptId).toBe(capture.origin.authority.attemptId);expect(control.sessionId).toBe(capture.origin.authority.sessionId);expect(control.launchId).toBe(capture.origin.authority.launchId);
        if(control.command==='ACK_EVENT'){const row=script!.entries.find(row=>row.event.eventId===control.payload.eventId);expect(row).toBeDefined();expect(control.payload).toEqual({eventId:row!.event.eventId,payloadDigest:row!.event.payloadDigest,sourceDigest:row!.sourceDigest});acks.get(control.payload.eventId)?.resolve();}
        else if(control.command==='PREPARE')work(async()=>{expect(control.payload.origin).toEqual(capture.origin);for(let n=0;n<5;n++)await emit(control,n);message(control,'PROGRESS',{phase:'PREPARED',bootstrap:'WAIT',bootstrapFact:script!.entries[4].source.facts[1]});});
        else if(control.command==='GRANT_GO')work(async()=>{
          script!.complete(control.payload.goGrantRef);for(let n=5;n<8;n++)await emit(control,n);
          const ready=script!.entries[10].source.facts.find(fact=>fact.kind==='IO'&&fact.bytesLength==='9');expect(ready).toBeDefined();message(control,'PROGRESS',{phase:'GO_GRANTED',bootstrap:'READY',bootstrapFact:ready});
          await inputDone.done;if(stopped)return;
          const writer=new Writable({write:(chunk:Buffer,_encoding,done)=>{output.push(Buffer.from(chunk));done();}});await writeNativeFrame(writer,result,windowsFrameLimits);output.end();errors.end();
          for(let n=8;n<10;n++)await emit(control,n);treeDone.resolve();
        });
        else if(control.command==='PARENT_JOINED')work(async()=>{
          expect(receivedParentAcks).toHaveLength(0);receivedParentAcks.push(control.payload);await options.parentRelease;await treeDone.done;if(stopped)return;
          Object.assign(script!.joinAck,control.payload);const row=script!.entries[10];row.sourceDigest=digest(row.source);
          for(let n=10;n<12;n++)await emit(control,n);message(control,'FINAL_CANDIDATE',{evidence:script!.evidence()});
        });
        else if(control.command==='ACK_FINAL'){
          expect(receivedParentAcks).toHaveLength(1);expect(finalized).toBeNull();finalized={...control.payload,handles:options.handles??'CLOSED',closeCode:options.handles==='UNCONFIRMED'?'W3B_FAKE_CLOSE_UNCONFIRMED':null};
          message(control,'FINALIZED',finalized);messages.end();joined.resolve({end:options.brokerEnd??'EXPECTED',finalized});
        }else if(control.command==='STOP'){
          stopped=true;for(const ack of acks.values())ack.resolve();inputDone.resolve();treeDone.resolve();messages.end();output.end();errors.end();joined.resolve({end:'LOST',finalized});
        }
      }};
    },
    readOriginal:async()=>finalized?{phase:'JOINED',finalized}:null
  };
  return {broker,controls,captures,receivedParentAcks,result,inputChunks,failures,get joins(){return joins;},get script(){return script;},get finalized(){return finalized;}};
}
// W3-C는 실제 codec과 서버 조정기를 사용하고 전송만 메모리로 대체한다.
import {requireCondition} from '../../packages/contracts/src/errors.js';
import {readNativeControllerResponse,writeNativeControllerRequest,type NativeControllerRequestV2,type NativeControllerResponseV2,type NativeControllerWireLimits} from '../../packages/native/src/controller-protocol.js';
import type {NativeRemoteExchangePortV2} from '../../packages/native/src/controller-remote.js';
import type {NativeControllerAttempts,NativeControllerMemoryOwner} from '../../packages/native/src/controller-attempts.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';

export async function prepareWindowsNativeTarget(f:WindowsNativeFixture){
  await f.request();const execution=await f.prepareExecution();await f.seedBasis(execution.input);
  // originalIntent는 원 target과 INPUT만 준비한다. reserve는 호출하지 않는다.
  const original=await f.originalIntent(execution),capacity=await f.registerWindowsProfile();
  const target:NativeTarget={accountId:f.seed.accountId,targetKind:original.intent.targetKind,targetId:original.intent.targetId,
    semanticCaptureDigest:original.intent.semanticCaptureDigest,protectedOwnerCapture:original.intent.protectedOwnerCapture,
    claim:original.intent.claim,sourceInput:original.sourceInput};
  return {execution,original,capacity,target,source:Buffer.from(original.frame.blobs.get('source')!)};
}

export function createWindowsNativeExchange(options:{resolveCoordinator(request:NativeControllerRequestV2):Promise<NativeControllerAttempts>;transport:unknown;bounds:NativeControllerWireLimits;memory:NativeControllerMemoryOwner;io?:{beforeWrite?(direction:'input'|'output'):Promise<void>;beforeSourceEnd?(direction:'input'|'output'):Promise<void>;responseFault?:'PARTIAL'|'BAD_MAGIC'}}){
  let accepting=true;const active=new Set<Promise<unknown>>(),captures:NativeControllerRequestV2[]=[],ioErrors:Error[]=[];
  const maximum=(kind:'input'|'output')=>24+options.bounds.maxControlBytes+options.bounds[kind].maxMetadataBytes+options.bounds[kind].maxBinaryBytes;
  const client:NativeRemoteExchangePortV2={exchange:(request,originalJob)=>{
    const task=(async()=>{
      requireCondition(accepting,'NATIVE_SHUTDOWN_WAIT',409,'WAIT');
      const release=options.memory.hold(3*(maximum('input')+maximum('output')));
      const sources:AsyncGenerator<Uint8Array,void,unknown>[]=[];let primary:unknown,hasPrimary=false;
      try{
        const encoded:Buffer[]=[],returned:Buffer[]=[];let sent=0,received=0;
        const sink=(chunks:Buffer[],direction:'input'|'output')=>{
          const writer=new Writable({write:(chunk:Buffer,_encoding,done)=>{
            void (async()=>{await options.io?.beforeWrite?.(direction);
              if(direction==='input'){sent+=chunk.length;requireCondition(sent<=maximum(direction),'NATIVE_CONTROL_LIMIT',413,'WAIT');}
              else{received+=chunk.length;requireCondition(received<=maximum(direction),'NATIVE_CONTROL_LIMIT',413,'WAIT');}
              chunks.push(Buffer.from(chunk));done();
            })().catch(error=>done(error as Error));
          }});
          // callback의 오류는 실제 codec Promise가 전달하고 중복 stream 오류도 기록한다.
          writer.on('error',error=>ioErrors.push(error));return writer;
        };
        await writeNativeControllerRequest(sink(encoded,'input'),request,options.bounds);captures.push(request);
        const source=(chunks:Buffer[],direction:'input'|'output')=>{const iterator=(async function*(){try{for(const chunk of chunks)for(let n=0;n<chunk.length;n+=37)yield chunk.subarray(n,n+37);}finally{await options.io?.beforeSourceEnd?.(direction);}})();sources.push(iterator);return iterator;};
        const coordinator=await options.resolveCoordinator(request);
        const control=await coordinator.serveFramed(options.transport,source(encoded,'input'),sink(returned,'output'));
        if(options.io?.responseFault){const bytes=Buffer.concat(returned);if(options.io.responseFault==='BAD_MAGIC')bytes[0]^=255;returned.splice(0,returned.length,options.io.responseFault==='PARTIAL'?bytes.subarray(0,bytes.length-1):bytes);}
        const response=await readNativeControllerResponse(source(returned,'output'),options.bounds,request.control,originalJob);
        expect(response.control).toEqual(control);return response;
      }catch(error){hasPrimary=true;primary=error;throw error;}finally{
        try{
          const ended=await Promise.allSettled(sources.map(source=>source.return(undefined))),failures=ended.filter((value):value is PromiseRejectedResult=>value.status==='rejected').map(value=>value.reason);
          if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'W3C_TRANSPORT_SOURCE_CLOSE_FAILED');
        }finally{release();}
      }
    })();active.add(task);void task.then(()=>active.delete(task),()=>active.delete(task));return task;
  },shutdown:async()=>{accepting=false;while(active.size)await Promise.allSettled([...active]);}};
  return {client,captures,pending:()=>active.size,ioErrors};
}


export async function createWindowsRemoteFixture(f:WindowsNativeFixture,options:{metadata?:Record<string,unknown>;parentRelease?:Promise<void>}={}){
  const prepared=await prepareWindowsNativeTarget(f);
  // 실제 PG 검증에는 부모 통신 예산 10초를 사용한다. 가짜 host의 1초 OS 정책은 유지한다.
  // 원 W3-B fixture와 제한은 그대로이며, 새 profile에 달라진 limits digest를 정확히 등록한다.
  const remoteLimits={...windowsNativeLimits,timeoutMs:10000},profile={...prepared.capacity.profile,windows:{...prepared.capacity.profile.windows,pins:{...prepared.capacity.profile.windows.pins,nativeLimitsDigest:digest(remoteLimits)}}},profileId=randomUUID();
  const profileRow=(await f.operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
  await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const capacity={reference:{...prepared.capacity.reference,profileId,profileDigest:profileRow.profile_digest},profile};

  const {createNativeControllerMemory,NativeControllerAttempts}=await import('../../packages/native/src/controller-attempts.js');
  const {createWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js');
  const {createWindowsOriginalController}=await import('../../packages/native/src/controller.js');
  const {NativeRemoteController}=await import('../../packages/native/src/controller-remote.js');
  const {NativeRemoteDatabaseGateway}=await import('../../packages/domain/src/native-remote-gateway.js');
  const memory=createNativeControllerMemory(33554432),exchangeMemory=createNativeControllerMemory(4194304);
  const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('W3C_DELETE_FORBIDDEN');}};
  const transport=Object.freeze({peer:randomUUID()}),peers={authenticate:async(value:unknown)=>{expect(value).toBe(transport);return {...f.peer};}};
  const bounds={maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},virtual=createWindowsNativeClock();
  let controller:ReturnType<typeof createWindowsOriginalController>|undefined,coordinator:NativeControllerAttempts|undefined,host:ReturnType<typeof createWindowsNativeBroker>|undefined;
  const resolveCoordinator=async(request:NativeControllerRequestV2)=>{
    if(coordinator)return coordinator;
    expect(request.control.command).toBe('PREPARE');expect(request.input).toBeDefined();const frame=request.input!;
    const blobs=new Map([['canonical-png',Buffer.from(ownedNativePng,'base64')]]);
    const metadata=options.metadata??{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:blobs.get('canonical-png')!.length};
    const result={envelope:createNativeResult(frame.envelope,{metadata,blobs},windowsFrameLimits),blobs};
    const ports=createWindowsControllerPorts({db:f.controllerDb,configuration:{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:remoteLimits,signer:f.signer},objects,bucketRef:f.files.bucket,memory});f.journals.push(ports.journal);
    host=createWindowsNativeBroker(frame,{result,parentRelease:options.parentRelease});controller=createWindowsOriginalController({...ports,broker:host.broker,clock:virtual.clock});
    coordinator=new NativeControllerAttempts(controller,peers,{maxControlBytes:bounds.maxControlBytes,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});return coordinator;
  };
  type Parent={exchange:ReturnType<typeof createWindowsNativeExchange>;parent:ReturnType<typeof NativeRemoteController.windows>;gateway:ReturnType<typeof NativeRemoteDatabaseGateway.windows>};
  const parents:Parent[]=[];
  function createParent():Parent{
    const exchange=createWindowsNativeExchange({resolveCoordinator,transport,bounds,memory:exchangeMemory});
    const parent=NativeRemoteController.windows({profile:syntheticProfile,limits:remoteLimits,client:exchange.client,windows:{version:2}});
    const gateway=NativeRemoteDatabaseGateway.windows(f.worker,parent,objects,capacity);
    const value={exchange,parent,gateway};parents.push(value);return value;
  }
  const first=createParent();
  return {...prepared,capacity,...first,objects,memory,exchangeMemory,virtual,transport,createParent,get host(){return host;},get controller(){return controller;},get coordinator(){return coordinator;},close:async()=>{
    for(const value of parents){value.gateway.stopClaims();await value.gateway.idle();}if(controller){controller.stopClaims();await controller.idle();}
    expect(exchangeMemory.available()).toBe(exchangeMemory.maxBytes);expect(host?.failures??[]).toEqual([]);
  }};
}

// W4-A: append-only helpers. Existing W3-A/B/C sources and assertions above stay intact.
export async function createWindowsNativeCostRemoteFixture(f:WindowsNativeFixture,semanticFailure=false){
  const remote=await createWindowsRemoteFixture(f,semanticFailure?{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'missing',canonicalPngByteLength:68}}:{});
  try{
    const operation=remote.gateway.forTarget(remote.target).decodeImage(remote.source,syntheticProfile);
    if(semanticFailure)await expect(operation).rejects.toMatchObject({version:2,termination:{kind:'WINDOWS_JOB_EMPTY'}});
    else expect(await operation).toMatchObject({width:1,height:1,mediaType:'image/png'});
    const binding=remote.exchange.captures[0].control.binding;
    const link=(await f.admin.pool.query<{expected:import('../../packages/native/src/dto.js').WindowsEvidenceRef}>(`SELECT jsonb_build_object('recordId',r.record_id,'recordDigest',r.digest,'linkId',l.link_id,'linkDigest',l.digest) AS expected
      FROM manga_web.windows_native_links l JOIN manga_web.windows_native_records r USING(account_id,attempt_id) WHERE l.account_id=$1 AND r.purpose='SEAL'`,[binding.accountId])).rows;
    expect(link).toHaveLength(1);expect(remote.host?.failures).toEqual([]);
    return {...remote,binding,key:{binding,expected:link[0].expected}};
  }catch(error){await remote.close();throw error;}
}

export async function createWindowsNativeCostOriginalFixture(f:WindowsNativeFixture,options:{mode?:'CREATED'|'NOT_ATTEMPTED'|'CREATED_NO_GO'|'UNKNOWN';basis?:'NORMAL'|'LARGE'|'NONE';checkpoint?:boolean;inputBytes?:number;basisBytes?:number;basisAfterCapture?:boolean;accounting?:WindowsNativeAccountingOverrides}={}){
  const mode=options.mode??'NOT_ATTEMPTED',checkpoint=options.checkpoint?await f.checkpointRetry():null;
  const execution=checkpoint??(await f.request(),await f.prepareExecution());
  if(options.inputBytes!==undefined){
    // Seed a valid large StageInput before its native origin is captured. Sizes
    // below use the original PG value::text contract, independently of JS JSON.
    const input=structuredClone(canonicalInput(execution.input));
    input.initialData.blocks=[{regionId:randomUUID(),geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'x'.repeat(64000),status:'USER_CONFIRMED'},translatedText:{value:'',status:'USER_MODIFIED'},fontAssetId:input.settings.fontAssetId,fontSizePx:input.settings.baseFontSizePx,appliedTranslation:null}];
    const size=(await f.admin.pool.query<{bytes:number}>('SELECT octet_length($1::jsonb::text) bytes',[JSON.stringify(input)])).rows[0].bytes;
    const padding=options.inputBytes-size;expect(padding).toBeGreaterThanOrEqual(0);expect(padding).toBeLessThanOrEqual(65536);input.initialData.blocks[0].translatedText.value='y'.repeat(padding);
    const request=(await f.admin.pool.query('SELECT captured_input,captured_stage_order,captured_scope FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,input.requestId])).rows[0];request.captured_input.data=input.initialData;
    input.inputDigest=digest({stage:input.stage,stageOrder:request.captured_stage_order,scope:request.captured_scope,settings:input.settings,initial:request.captured_input,previous:input.previousData,cleanedAssetId:input.currentCleanedAssetId??null,renderAssetId:input.currentRenderAssetId??null,assetDependencies:input.assetDependencies??[],previousOutputAssetIds:input.previousOutputAssetIds??[]});input.envelope!.inputDigest=input.inputDigest;
    const {validateEditData}=await import('../../packages/domain/src/scope.js');validateEditData(input.initialData,input.width,input.height);
    await f.admin.pool.query('UPDATE manga_web.processing_requests SET captured_input=$3 WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,input.requestId,JSON.stringify(request.captured_input)]);
    await f.admin.pool.query('UPDATE manga_web.executions SET input_digest=$3 WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,input.executionId,input.inputDigest]);
    await f.admin.pool.query("UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[f.seed.accountId,input.executionId,JSON.stringify(input),digest(input)]);execution.input=input;
    expect((await f.admin.pool.query('SELECT octet_length($1::jsonb::text) bytes',[JSON.stringify(input)])).rows[0].bytes).toBe(options.inputBytes);
  }
  let basis=options.basis==='NONE'?null:await f.seedBasis(execution.input,options.basis==='LARGE'||options.basisBytes!==undefined);
  if(options.basisBytes!==undefined){
    expect(basis).not.toBeNull();const snapshot={...structuredClone(basis!.value.value.snapshot!),evidenceRefs:Array.from({length:33},(_value,index)=>`w4a-bounded-source-${index}-`.padEnd(index===32?32:4000,'x'))};basis!.value.value.snapshot=snapshot;basis!.value.value.snapshotDigest=digest(snapshot);
    const size=(await f.admin.pool.query('SELECT octet_length($1::jsonb::text) bytes',[JSON.stringify(basis!.value)])).rows[0].bytes as number;
    const padding=options.basisBytes-size;expect(padding).toBeGreaterThanOrEqual(0);expect(snapshot.evidenceRefs[32].length+padding).toBeLessThanOrEqual(4096);snapshot.evidenceRefs[32]+='x'.repeat(padding);basis!.value.value.snapshotDigest=digest(snapshot);basis!.evidenceDigest=digest(basis!.value);
    await f.admin.pool.query('UPDATE manga_web.execution_evidence SET protected_observation=$3,evidence_digest=$4 WHERE account_id=$1 AND evidence_id=$2',[f.seed.accountId,basis!.evidenceId,JSON.stringify(basis!.value),basis!.evidenceDigest]);
    expect((await f.admin.pool.query('SELECT octet_length($1::jsonb::text) bytes',[JSON.stringify(basis!.value)])).rows[0].bytes).toBe(options.basisBytes);
  }
  const original=await f.originalIntent(execution,checkpoint?'REQUEST_CHECKPOINT':'EXECUTION',checkpoint?.retryId??execution.input.requestId),capacity=await f.registerWindowsProfile();
  const reservation=await original.reserve(capacity);expect(reservation).toMatchObject({allowed:true,reason:'CREATED'});
  const binding=original.binding(reservation.capacityReservationId!);
  const {WindowsNativeJournal,createWindowsJournalMemory}=await import('../../packages/domain/src/windows-native-journal.js');
  f.memory??=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);
  const journal=new WindowsNativeJournal(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:windowsNativeLimits,signer:f.signer},f.memory);f.journals.push(journal);
  const ports=journal.portsFor(f.peer),input=await journal.offerOriginal(f.peer,binding,original.frame),captured=await ports.original.captureFresh(input),capture=captured.capture;
  expect(captured.created).toBe(true);
  if(options.basisAfterCapture){expect(basis).toBeNull();basis=await f.seedBasis(execution.input);}
  const script=windowsNativeScript(input,mode==='CREATED_NO_GO'?'CREATED':mode,options.accounting);
  for(const entry of script.entries)await ports.journal.appendOriginal(capture,entry.event,entry.source);
  let raw:NativeRawResultReference|null=null;
  if(mode==='CREATED'){
    await journal.readyOriginal(capture,script.prepared);const granted=await ports.original.grantOriginal(capture),prefix=script.entries.length;expect(granted.created).toBe(true);script.complete(granted.goGrantRef);
    for(const entry of script.entries.slice(prefix))await ports.journal.appendOriginal(capture,entry.event,entry.source);
    const bytes=Buffer.from(ownedNativePng,'base64'),blobs=new Map([['canonical-png',bytes]]),result=createNativeResult(input.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs},windowsFrameLimits);
    raw=await storeWindowsNativeRaw(f,capture,{envelope:result,blobs});
  }
  let expected:import('../../packages/native/src/dto.js').WindowsEvidenceRef={recordId:randomUUID(),recordDigest:sha256('w4a-unconfirmed-seal'),linkId:randomUUID(),linkDigest:sha256('w4a-unconfirmed-link')};
  if(mode==='CREATED'||mode==='NOT_ATTEMPTED'){
    await journal.parentJoinedOriginal(capture,script.joinAck);const record=await ports.journal.sealOriginal(capture,script.seal()),finalized=script.finalized(record);
    expected=await journal.finishOriginal(capture,{outcome:script.outcome(record,raw),finalized,brokerJoin:{end:'EXPECTED',finalized}});
  }
  return {execution,basis,original,capacity,binding,journal,ports,input,capture,script,key:{binding,expected},close:async()=>{}};
}


import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {validateWindowsCostedIoRequest,validateWindowsCostedIoEvent,type WindowsCostedObjectIo,type WindowsCostedIoRequest,type WindowsCostedIoEvent,type WindowsCostedIoReply} from '../../packages/domain/src/windows-native-cost.js';
export type WindowsCostedIoCompletion=Omit<WindowsCostedIoEvent,'ended'|'state'>&{ended:null;state:'RETURNED'|'THREW'};
// 가짜 source가 실제로 호출된 순서와 결과를 BEGIN/END DB capability에 연결한다.
// 운영 ObjectStore adapter가 아니며 객체 receipt 시각으로 조회 종료를 추정하지 않는다.
export function createWindowsCostedObjectIo(options:{objects:ObjectStore;maxBytes:number;begin(request:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>;end(event:WindowsCostedIoCompletion):Promise<WindowsCostedIoEvent|null>;lookup(request:WindowsCostedIoRequest):Promise<WindowsCostedIoEvent|null>}):WindowsCostedObjectIo{
  const {objects,maxBytes}=options,begin=options.begin.bind(options),end=options.end.bind(options),lookup=options.lookup.bind(options),methods={read:objects.read.bind(objects),put:objects.put.bind(objects),receipt:objects.receipt.bind(objects)};
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new Error('W4B_FAKE_IO_LIMIT_INVALID');
  const active=new Map<string,{digest:string;work:Promise<WindowsCostedIoReply<unknown>>}>();
  const run=(value:WindowsCostedIoRequest,bytes?:Buffer):Promise<WindowsCostedIoReply<unknown>>=>{
    const request=validateWindowsCostedIoRequest(value),captured=bytes===undefined?undefined:Buffer.from(bytes),fingerprint=digest(request),existing=active.get(request.operationId);
    if(existing){if(existing.digest!==fingerprint)throw new DomainError('WINDOWS_NATIVE_COST_IO_CONFLICT',409,'WAIT');return existing.work;}
    const work=(async():Promise<WindowsCostedIoReply<unknown>>=>{
      if(captured&&captured.length>maxBytes)throw new DomainError('WINDOWS_NATIVE_COST_IO_LIMIT',409,'WAIT');
      let start:WindowsCostedIoEvent|null;try{start=await begin(request);}catch(error){if(error instanceof DomainError||/^[0-9A-Z]{5}$/.test(String((error as {code?:unknown})?.code)))throw error;start=await lookup(request);}if(!start)throw new DomainError('WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');const original=validateWindowsCostedIoEvent(start,request);
      if(original.state!=='UNCONFIRMED')throw new DomainError('WINDOWS_NATIVE_COST_IO_REPLAY_UNAVAILABLE',409,'WAIT');
      let result:unknown,state:'RETURNED'|'THREW'='RETURNED',observed:{sha256:string;bytesLength:string}|null=null,code:string|null=null;
      try{
        if(request.kind==='OBJECT_READ'){result=await methods.read(request.key);if(!Buffer.isBuffer(result))throw new DomainError('WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');observed={sha256:sha256(result),bytesLength:String(result.length)};if(result.length>maxBytes)throw new DomainError('WINDOWS_NATIVE_COST_IO_LIMIT',409,'WAIT');}
        else if(request.kind==='OBJECT_RECEIPT'){result=await methods.receipt(request.key);if(result!==null){const receipt=result as ObjectReceipt;observed={sha256:receipt.sha256,bytesLength:receipt.bytesLength};}}
        else{if(!captured)throw new DomainError('WINDOWS_NATIVE_COST_IO_UNCONFIRMED',409,'WAIT');result=await methods.put(request.key,captured);const receipt=result as ObjectReceipt;observed={sha256:receipt.sha256,bytesLength:receipt.bytesLength};}
      }catch(error){state='THREW';code=error instanceof DomainError&&/^[A-Z0-9_]{1,128}$/.test(error.code)?error.code:'STORAGE_UNCONFIRMED';}
      const ending:WindowsCostedIoCompletion={...original,state,ended:null,observed,code};let finished:WindowsCostedIoEvent|null=null;
      try{finished=await end(ending);}catch(error){if(error instanceof DomainError||/^[0-9A-Z]{5}$/.test(String((error as {code?:unknown})?.code)))throw error;finished=await lookup(request);}
      if(!finished||finished.state==='UNCONFIRMED')return {state:'UNCONFIRMED',event:original};
      const event=validateWindowsCostedIoEvent(finished,request);if(event.state!==state||digest(event.started)!==digest(original.started)||digest(event.observed)!==digest(observed)||event.code!==code)throw new DomainError('WINDOWS_NATIVE_COST_IO_CONFLICT',409,'WAIT');
      if(state==='RETURNED')return {state:'RETURNED',event,value:Buffer.isBuffer(result)?Buffer.from(result):structuredClone(result)};return {state:'THREW',event};
    })();active.set(request.operationId,{digest:fingerprint,work});return work;
  };
  return Object.freeze({bucket:objects.bucket,read:(request:WindowsCostedIoRequest)=>run(request) as Promise<WindowsCostedIoReply<Buffer>>,receipt:(request:WindowsCostedIoRequest)=>run(request) as Promise<WindowsCostedIoReply<ObjectReceipt|null>>,put:(request:WindowsCostedIoRequest,bytes:Buffer)=>run(request,bytes) as Promise<WindowsCostedIoReply<ObjectReceipt>>,lookup:async(request:WindowsCostedIoRequest)=>{const captured=validateWindowsCostedIoRequest(request),event=await lookup(captured);return event===null?null:validateWindowsCostedIoEvent(event,captured);}});
}


import {WindowsNativeCostJournal,type WindowsNativeCostOwner} from '../../packages/domain/src/windows-native-cost.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
// B1 합성 부모 경계: 운영 authorizer 변경 없이 최초 INPUT tx 안에서만 등록한다.
export async function prepareWindowsCostedTarget(f:WindowsNativeFixture){
  const costs=new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),transaction=f.worker.transaction.bind(f.worker);let enrolled:unknown=null;
  await f.request();const spy=vi.spyOn(f.worker,'transaction').mockImplementation(async run=>transaction(async client=>{
    const value=await run(client),inputs=(await client.query("SELECT evidence_id,evidence_digest FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' AND xmin::text=pg_current_xact_id()::text",[f.seed.accountId])).rows;
    if(inputs.length){expect(inputs).toHaveLength(1);enrolled=(await client.query('SELECT manga_web.windows_native_cost_enroll_input($1::jsonb) AS value',[JSON.stringify({evidenceId:inputs[0].evidence_id,evidenceDigest:inputs[0].evidence_digest})])).rows[0].value;}return value;
  }));
  let execution:Awaited<ReturnType<typeof f.prepareExecution>>;try{execution=await f.prepareExecution();}finally{spy.mockRestore();}expect(enrolled).not.toBeNull();
  const input=execution.input,original=await f.originalIntent(execution),mode=(await f.admin.pool.query('SELECT mode FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,input.requestId])).rows[0].mode;
  const profileDigest=sha256('W4-B1 fake captured basis'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'w4b1-fake-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:w4b1/basis'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'w4b1-synthetic-rate-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b1/unit']} ]};
  const calculation=new FullStageCostCalculator(snapshot,{maxInputBytes:131072,maxOutputBytes:131072,maxComponents:64,maxEvidenceRefs:128,maxStringBytes:4096}).calculate({accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage:'OCR',profileDigest,mode},{provider:null,quantities:null,allocation:null});
  const wrapper={version:1,accountId:f.seed.accountId,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:calculation.capture,captureDigest:calculation.captureDigest,snapshot:calculation.snapshot,snapshotDigest:calculation.snapshotDigest}},basisRef={evidenceId:randomUUID(),evidenceDigest:digest(wrapper)};
  await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'OPERATIONAL_COST_BASIS',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,basisRef.evidenceId,input.executionId,basisRef.evidenceDigest,tx.now,JSON.stringify(wrapper)]));
  const owner:WindowsNativeCostOwner={executionId:input.executionId,inputEvidenceId:original.sourceInput.inputEvidenceId,inputFingerprint:digest(canonicalInput(input)),basisRef,claim:{generation:execution.claim.generation,ownerId:f.service.workerId,workItemId:execution.claim.workId},validationAttemptRef:null};
  const components=[{task:'DECODE_IMAGE' as const,componentId:'native-image'}],root=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.activateRootIn(tx,owner,components));expect(root).not.toBeNull();
  const capacity=await f.registerWindowsProfile(),target:NativeTarget={accountId:f.seed.accountId,targetKind:'EXECUTION',targetId:input.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest('INPUT',input.requestId,input),protectedOwnerCapture:original.intent.protectedOwnerCapture,claim:owner.claim,sourceInput:original.sourceInput};
  return {costs,execution,original,owner,root,components,capacity,target,source:Buffer.from(ownedNativePng,'base64')};
}


// B1 전용 조립은 기존 무비용 fixture 본문을 변경하지 않는다.
export async function createWindowsCostedRemoteFixture(f:WindowsNativeFixture,options:{metadata?:Record<string,unknown>;parentRelease?:Promise<void>;beforeExchange?:(request:NativeControllerRequestV2)=>Promise<void>;afterExchange?:(request:NativeControllerRequestV2,response:NativeControllerResponseV2)=>Promise<void>}={}){
  const prepared=await prepareWindowsCostedTarget(f);
  // 실제 PG 검증에는 부모 통신 예산 10초를 사용한다. 가짜 host의 1초 OS 정책은 유지한다.
  // 원 W3-B fixture와 제한은 그대로이며, 새 profile에 달라진 limits digest를 정확히 등록한다.
  const remoteLimits={...windowsNativeLimits,timeoutMs:10000},profile={...prepared.capacity.profile,windows:{...prepared.capacity.profile.windows,pins:{...prepared.capacity.profile.windows.pins,nativeLimitsDigest:digest(remoteLimits)}}},profileId=randomUUID();
  const profileRow=(await f.operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
  await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const capacity={reference:{...prepared.capacity.reference,profileId,profileDigest:profileRow.profile_digest},profile};

  const {createNativeControllerMemory,NativeControllerAttempts}=await import('../../packages/native/src/controller-attempts.js');
  const {createCostedWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js');
  const {createWindowsOriginalController}=await import('../../packages/native/src/controller.js');
  const {NativeRemoteController}=await import('../../packages/native/src/controller-remote.js');
  const {NativeRemoteDatabaseGateway}=await import('../../packages/domain/src/native-remote-gateway.js');
  const memory=createNativeControllerMemory(33554432),exchangeMemory=createNativeControllerMemory(4194304);
  const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('W3C_DELETE_FORBIDDEN');}};
  const parentIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.beginIoIn(tx,request)),end:event=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.endIoIn(tx,event),true),lookup:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.lookupIoIn(tx,request),true)});
  const diagnostics:unknown[]=[],contexts=new Map<string,unknown[]>(),originalDecision=f.controllerDb.decision.bind(f.controllerDb);
  const originalAccountTransaction=f.worker.accountTransaction.bind(f.worker);
  f.worker.accountTransaction=async(...args)=>{try{return await originalAccountTransaction(...args);}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'WORKER_TX',code:fault.code,message:fault.message});throw error;}};
  f.controllerDb.decision=async(accountId,sql,values,check)=>{
    let result;try{result=await originalDecision(accountId,sql,values,check);}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'CONTROLLER_DB',function:sql.match(/manga_web\.([a-z_]+)/)?.[1],code:fault.code,message:fault.message});throw error;}
    if(sql.includes('windows_native_cost_controller_io_begin(')||sql.includes('windows_native_cost_controller_io_lookup(')){const request=JSON.parse(values[3] as string) as WindowsCostedIoRequest;contexts.set(request.operationId,[values[0],values[1],values[2],values[4]]);}return result;
  };
  const eventCall=async(kind:'lookup'|'end',request:WindowsCostedIoRequest|WindowsCostedIoCompletion):Promise<WindowsCostedIoEvent|null>=>{
    const context=contexts.get(request.operationId);if(!context)throw new Error('W4B_REAL_CONTROLLER_IO_CONTEXT_REQUIRED');
    const decision=await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[context[0],context[1],context[2],JSON.stringify(request),context[3]]);return decision.event;
  };
  const rawIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>eventCall('lookup',request),end:event=>eventCall('end',event),lookup:request=>eventCall('lookup',request)});
  const transport=Object.freeze({peer:randomUUID()}),peers={authenticate:async(value:unknown)=>{expect(value).toBe(transport);return {...f.peer};}};
  const bounds={maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},virtual=createWindowsNativeClock();
  let controller:ReturnType<typeof createWindowsOriginalController>|undefined,coordinator:NativeControllerAttempts|undefined,host:ReturnType<typeof createWindowsNativeBroker>|undefined;
  const resolveCoordinator=async(request:NativeControllerRequestV2)=>{
    if(coordinator)return coordinator;
    expect(request.control.command).toBe('PREPARE');expect(request.input).toBeDefined();const frame=request.input!;
    const blobs=new Map([['canonical-png',Buffer.from(ownedNativePng,'base64')]]);
    const metadata=options.metadata??{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:blobs.get('canonical-png')!.length};
    const result={envelope:createNativeResult(frame.envelope,{metadata,blobs},windowsFrameLimits),blobs};
    const ports=createCostedWindowsControllerPorts({db:f.controllerDb,configuration:{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:remoteLimits,signer:f.signer},rawIo,bucketRef:f.files.bucket,memory});f.journals.push(ports.journal);
    host=createWindowsNativeBroker(frame,{result,parentRelease:options.parentRelease});controller=createWindowsOriginalController({...ports,broker:host.broker,clock:virtual.clock});
    coordinator=new NativeControllerAttempts(controller,peers,{maxControlBytes:bounds.maxControlBytes,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});return coordinator;
  };
  type Parent={exchange:ReturnType<typeof createWindowsNativeExchange>;parent:ReturnType<typeof NativeRemoteController.windows>;gateway:ReturnType<typeof NativeRemoteDatabaseGateway.costed>};
  const parents:Parent[]=[];
  function createParent():Parent{
    const exchange=createWindowsNativeExchange({resolveCoordinator,transport,bounds,memory:exchangeMemory});
    const parent=NativeRemoteController.windows({profile:syntheticProfile,limits:remoteLimits,client:{exchange:async(request,job)=>{try{await options.beforeExchange?.(request);const response=await exchange.client.exchange(request,job);await options.afterExchange?.(request,response);diagnostics.push({boundary:'WIRE',command:request.control.command,includeRaw:request.control.command==='QUERY'?request.control.includeRawResult:false,snapshot:response.control.snapshot});return response;}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'WIRE_ERROR',command:request.control.command,code:fault.code,message:fault.message});throw error;}},shutdown:()=>exchange.client.shutdown()},windows:{version:2}});
    const gateway=NativeRemoteDatabaseGateway.costed({db:f.worker,controller:parent,io:parentIo,capacity,costs:prepared.costs,components:prepared.components});
    const value={exchange,parent,gateway};parents.push(value);return value;
  }
  const first=createParent();
  return {...prepared,capacity,...first,objects,memory,exchangeMemory,virtual,transport,createParent,diagnostics,get host(){return host;},get controller(){return controller;},get coordinator(){return coordinator;},close:async()=>{
    for(const value of parents){value.gateway.stopClaims();await value.gateway.idle();}if(controller){controller.stopClaims();await controller.idle();}
    expect(exchangeMemory.available()).toBe(exchangeMemory.maxBytes);expect(host?.failures??[]).toEqual([]);f.controllerDb.decision=originalDecision;f.worker.accountTransaction=originalAccountTransaction;
  }};
}


// B3 전용 조립은 기존 B1과 B2 본문을 보존한다.
export async function createB3WindowsRemoteFixture(f:WindowsNativeFixture,options:{metadata?:Record<string,unknown>;parentRelease?:Promise<void>;beforeExchange?:(request:NativeControllerRequestV2)=>Promise<void>;afterExchange?:(request:NativeControllerRequestV2,response:NativeControllerResponseV2)=>Promise<void>}={}){
  const prepared={costs:new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),components:[{task:'DECODE_IMAGE' as const,componentId:'native-image'}],capacity:await f.registerWindowsProfile()};
  // 실제 PG 검증에는 부모 통신 예산 10초를 사용한다. 가짜 host의 1초 OS 정책은 유지한다.
  // 원 W3-B fixture와 제한은 그대로이며, 새 profile에 달라진 limits digest를 정확히 등록한다.
  const remoteLimits={...windowsNativeLimits,timeoutMs:10000},profile={...prepared.capacity.profile,windows:{...prepared.capacity.profile.windows,pins:{...prepared.capacity.profile.windows.pins,nativeLimitsDigest:digest(remoteLimits)}}},profileId=randomUUID();
  const profileRow=(await f.operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
  await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const capacity={reference:{...prepared.capacity.reference,profileId,profileDigest:profileRow.profile_digest},profile};

  const {createNativeControllerMemory,NativeControllerAttempts}=await import('../../packages/native/src/controller-attempts.js');
  const {createCostedWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js');
  const {createWindowsOriginalController}=await import('../../packages/native/src/controller.js');
  const {NativeRemoteController}=await import('../../packages/native/src/controller-remote.js');
  const {NativeRemoteDatabaseGateway}=await import('../../packages/domain/src/native-remote-gateway.js');
  const memory=createNativeControllerMemory(33554432),exchangeMemory=createNativeControllerMemory(4194304);
  const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('W3C_DELETE_FORBIDDEN');}};
  const parentIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.beginIoIn(tx,request)),end:event=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.endIoIn(tx,event),true),lookup:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.lookupIoIn(tx,request),true)});
  const diagnostics:unknown[]=[],contexts=new Map<string,unknown[]>(),originalDecision=f.controllerDb.decision.bind(f.controllerDb);
  f.controllerDb.decision=async(accountId,sql,values,check)=>{
    let result;try{result=await originalDecision(accountId,sql,values,check);}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'CONTROLLER_DB',function:sql.match(/manga_web\.([a-z_]+)/)?.[1],code:fault.code,message:fault.message});throw error;}
    if(sql.includes('windows_native_cost_controller_io_begin(')||sql.includes('windows_native_cost_controller_io_lookup(')){const request=JSON.parse(values[3] as string) as WindowsCostedIoRequest;contexts.set(request.operationId,[values[0],values[1],values[2],values[4]]);}return result;
  };
  const eventCall=async(kind:'lookup'|'end',request:WindowsCostedIoRequest|WindowsCostedIoCompletion):Promise<WindowsCostedIoEvent|null>=>{
    const context=contexts.get(request.operationId);if(!context)throw new Error('W4B_REAL_CONTROLLER_IO_CONTEXT_REQUIRED');
    const decision=await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[context[0],context[1],context[2],JSON.stringify(request),context[3]]);return decision.event;
  };
  const rawIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>eventCall('lookup',request),end:event=>eventCall('end',event),lookup:request=>eventCall('lookup',request)});
  const transport=Object.freeze({peer:randomUUID()}),peers={authenticate:async(value:unknown)=>{expect(value).toBe(transport);return {...f.peer};}};
  const bounds={maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},virtual=createWindowsNativeClock();
  let controller:ReturnType<typeof createWindowsOriginalController>|undefined,coordinator:NativeControllerAttempts|undefined,host:ReturnType<typeof createWindowsNativeBroker>|undefined;
  const resolveCoordinator=async(request:NativeControllerRequestV2)=>{
    if(coordinator)return coordinator;
    expect(request.control.command).toBe('PREPARE');expect(request.input).toBeDefined();const frame=request.input!;
    const blobs=new Map([['canonical-png',Buffer.from(ownedNativePng,'base64')]]);
    const metadata=options.metadata??{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:blobs.get('canonical-png')!.length};
    const result={envelope:createNativeResult(frame.envelope,{metadata,blobs},windowsFrameLimits),blobs};
    const ports=createCostedWindowsControllerPorts({db:f.controllerDb,configuration:{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:remoteLimits,signer:f.signer},rawIo,bucketRef:f.files.bucket,memory});f.journals.push(ports.journal);
    host=createWindowsNativeBroker(frame,{result,parentRelease:options.parentRelease});controller=createWindowsOriginalController({...ports,broker:host.broker,clock:virtual.clock});
    coordinator=new NativeControllerAttempts(controller,peers,{maxControlBytes:bounds.maxControlBytes,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});return coordinator;
  };
  type Parent={exchange:ReturnType<typeof createWindowsNativeExchange>;parent:ReturnType<typeof NativeRemoteController.windows>;gateway:ReturnType<typeof NativeRemoteDatabaseGateway.costed>};
  const parents:Parent[]=[];
  function createParent():Parent{
    const exchange=createWindowsNativeExchange({resolveCoordinator,transport,bounds,memory:exchangeMemory});
    const parent=NativeRemoteController.windows({profile:syntheticProfile,limits:remoteLimits,client:{exchange:async(request,job)=>{try{await options.beforeExchange?.(request);const response=await exchange.client.exchange(request,job);await options.afterExchange?.(request,response);diagnostics.push({boundary:'WIRE',command:request.control.command,includeRaw:request.control.command==='QUERY'?request.control.includeRawResult:false,snapshot:response.control.snapshot});return response;}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'WIRE_ERROR',command:request.control.command,code:fault.code,message:fault.message});throw error;}},shutdown:()=>exchange.client.shutdown()},windows:{version:2}});
    const gateway=NativeRemoteDatabaseGateway.costed({db:f.worker,controller:parent,io:parentIo,capacity,costs:prepared.costs,components:prepared.components});
    const value={exchange,parent,gateway};parents.push(value);return value;
  }
  const first=createParent();
  return {...prepared,capacity,...first,objects,memory,exchangeMemory,virtual,transport,createParent,diagnostics,get host(){return host;},get controller(){return controller;},get coordinator(){return coordinator;},close:async()=>{
    for(const value of parents){value.gateway.stopClaims();await value.gateway.idle();}if(controller){controller.stopClaims();await controller.idle();}
    expect(exchangeMemory.available()).toBe(exchangeMemory.maxBytes);expect(host?.failures??[]).toEqual([]);f.controllerDb.decision=originalDecision;
  }};
}

// B3 전용 경계는 실제 authorize의 INPUT 거래를 그대로 사용한다.
// 등록과 BASIS/root를 대체하는 transaction 가로채기나 선행 저장은 없다.
export async function createB3WindowsExecutionFixture(){
  const f=await windowsNativeFixture(),remote=await createB3WindowsRemoteFixture(f);
  const {FullStageCostPreparation}=await import('../../packages/domain/src/full-stage-cost-preparation.js');
  const {FullStageCostJournal}=await import('../../packages/domain/src/full-stage-cost-journal.js');
  const {OperationalStageCost}=await import('../../packages/domain/src/pipeline-stage-cost.js');
  const {CheckpointValidationJournal}=await import('../../packages/domain/src/checkpoint-validation.js');
  const profileDigest=sha256('w4b3a-owned-profile'),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'OCR',profileDigest,basisVersion:'w4b3a-owned-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:w4b3a/basis'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'w4b3a-owned-rate-v1',usdPerUnit:'0.01',evidenceRefs:['owned-fixture:w4b3a/rate']}]};
  const bounds={maxRecordBytes:262144,maxRecords:64,calculator:{maxInputBytes:131072,maxOutputBytes:131072,maxComponents:64,maxEvidenceRefs:128,maxStringBytes:4096}};
  const journal=new FullStageCostJournal(f.worker,bounds),preparation=new FullStageCostPreparation(journal,[{stage:'OCR',profileDigest,snapshot}],bounds.calculator);
  const checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:262144,maxRecords:64,maxTargets:4,maxJobs:32});
  // 고정 reader는 비Windows 원자료가 아직 없다는 사실만 반환한다.
  // 실제 C2 준비와 Journal을 사용하며 금액 확정이나 운영 수집을 합성하지 않는다.
  const reader:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostReader={workSetIn:vi.fn(async()=>null),checkpointFactsIn:vi.fn(async(_tx,_input,attempt)=>attempt.targets.length?null:{attemptId:attempt.attemptId,operations:[]})};
  const operationalCost=new OperationalStageCost({db:f.worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:262144,maxRecords:64,maxSources:16,maxExecutions:32,maxInFlight:4}});
  const service=new ExecutionService(f.worker,f.provider,f.requestPolicy,{},remote.gateway,operationalCost),requestId=await f.request();
  return {...f,...remote,base:f,remote,service,requestId,journal,preparation,checkpoints,reader,operationalCost,snapshot,close:async()=>{try{await remote.close();await operationalCost.idle();}finally{await f.close();}}};
}


import {nativeFacadeVerificationVersion} from '../../packages/native/src/semantic-cache.js';
import {validateNativeReceiptCandidateV2,validateWindowsNativeEvidenceBundle,type WindowsNativeCostRef,type NativeSealedReceiptV2} from '../../packages/domain/src/native-receipts.js';

// 같은 거래의 domain fake에 넣을 합성 원자료다. DB 전용 observation digest와
// object receipt는 실제 PG/파일 I/O의 증거가 아니다. PG 원자료는 위의
// createWindowsNativeCostOriginalFixture와 W2 journal을 그대로 사용한다.
export function createWindowsNativeSignedReceiptFixture(options:{
  input:StageInput;inputRef:WindowsNativeCostRef;
  basis:{ref:WindowsNativeCostRef;value:unknown}|null;
  target:NativeTarget;frame:NativeFrame<import('../../packages/native/src/dto.js').NativeJob>;
  result:NativeFrame<NativeResult>;kernelDigest?:string;accounting?:WindowsNativeAccountingOverrides;
}){
  const {input,inputRef,basis,target,frame,result}=options,job=frame.envelope;
  const sourceInput={executionId:input.executionId,inputEvidenceId:inputRef.evidenceId,stageInputDigest:input.inputDigest};
  requireCondition(target.accountId===input.accountId&&['EXECUTION','REQUEST_CHECKPOINT'].includes(target.targetKind)&&inputRef.evidenceDigest===digest(canonicalInput(input))&&digest(input)===inputRef.evidenceDigest&&(!target.sourceInput||digest(target.sourceInput)===digest(sourceInput)),'B3_SIGNED_FIXTURE_INPUT_MISMATCH',422);
  requireCondition(digest(createNativeJob(job.task,job.profileDigest,job.metadata,frame.blobs,windowsFrameLimits,job.jobId as ReturnType<typeof randomUUID>))===digest(job)&&digest(createNativeResult(job,{metadata:result.envelope.metadata,blobs:result.blobs},windowsFrameLimits))===digest(result.envelope),'B3_SIGNED_FIXTURE_FRAME_MISMATCH',422);
  const signing=generateKeyPairSync('ed25519'),kernelDigest=options.kernelDigest??sha256('B3-B synthetic Windows kernel');
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:structuredClone(target.protectedOwnerCapture),claim:structuredClone(target.claim)};
  const intent:NativeJobIntent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},intentDigest=sha256('B3-B synthetic intent row '+randomUUID());
  const binding:NativeControllerBinding={accountId:input.accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest};
  const policy:WindowsJobPolicy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'};
  const pins={executableDigest:sha256('B3-B fake executable'),bootstrapDigest:sha256('B3-B fake bootstrap'),helperRuntimeDigest:sha256('B3-B fake runtime'),helperScriptDigest:sha256('B3-B fake helper'),runtimeFilesDigest:sha256('B3-B fake runtime files'),nativeLimitsDigest:digest(windowsNativeLimits)};
  const profile:WindowsCapacitySpecimen={kind:'WINDOWS_JOB_OBJECT',version:'windows-b3b-signed-domain-v1',maxSlots:2,nativeProfileDigest:job.profileDigest,kernelDigest,controllerId:randomUUID(),keyVersion:'b3b-domain-key-v1',environmentDigest:sha256('B3-B fake environment'),publicKeySpki:signing.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:b3b/domain-fake'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('B3-B fake controller SID'),childSidDigest:sha256('B3-B fake child SID'),appContainerSidDigest:sha256('B3-B fake container SID')}};
  const reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('B3-B synthetic profile row '+randomUUID()),profileVersion:profile.version};
  const basisRef=basis?structuredClone(basis.ref):null,identity={binding,intentDigest,sourceInput,inputEvidenceDigest:inputRef.evidenceDigest,inputFingerprint:inputRef.evidenceDigest,basisRef};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const prepare:WindowsPrepareInput={identity,authority,pins,policy,limits:windowsNativeLimits,frame},script=windowsNativeScript(prepare,'CREATED',options.accounting),goGrantRef={jobId:job.jobId,rowDigest:sha256('B3-B synthetic GO row '+randomUUID())};
  script.complete(goGrantRef);
  const envelope=script.seal(),seal={recordId:randomUUID(),digest:digest(envelope)},finalized=script.finalized(seal),parent={recordId:script.joinAck.joinId,digest:digest(script.joinAck)};
  const finalValue={version:1,originDigest:script.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}},final={recordId:randomUUID(),digest:digest(finalValue)};
  const termination:NativeSealedReceiptV2['termination']={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY'};
  const observation=(event:'RESULT'|'TERMINATION')=>{
    const evidenceId=randomUUID();
    return {evidenceId,evidenceDigest:sha256('B3-B synthetic observation row '+evidenceId),value:{version:2 as const,parentInstanceId:binding.parentInstanceId,event,code:'OK',resultDigest:event==='RESULT'?digest(result.envelope):null,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT' as const},windowsRecordRef:{recordId:seal.recordId,recordDigest:seal.digest}}};
  };
  const observations=[observation('RESULT'),observation('TERMINATION')],rawResult={rawResultId:randomUUID(),resultDigest:digest(result.envelope)};
  const body={version:1,originDigest:script.originDigest,identity,basis:basisRef,goGrantRef,rawResult,record:{recordId:seal.recordId,recordDigest:seal.digest},parentJoin:parent,finalized:final,observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))};
  const canonical=canonicalize(body)!,link={linkId:randomUUID(),canonical,digest:sha256(canonical),signature:sign(null,Buffer.from(canonical),signing.privateKey).toString('base64')};
  const expected={recordId:seal.recordId,recordDigest:seal.digest,linkId:link.linkId,linkDigest:link.digest},key={binding,expected};
  const facts={capacity:{reference,profile,sourceInput},input:{...structuredClone(inputRef),value:structuredClone(input)},basis:basis?{...structuredClone(basis.ref),value:structuredClone(basis.value)}:null,goGrantRef,rawResult,observations,records:[{purpose:'PARENT_JOIN',recordId:parent.recordId,digest:parent.digest,value:script.joinAck},{purpose:'SEAL',recordId:seal.recordId,digest:seal.digest,value:envelope},{purpose:'FINALIZED',recordId:final.recordId,digest:final.digest,value:finalValue}],link,peer:{serviceRole:'trio_web_worker' as const,peerId:randomUUID()}};
  const bundle={state:{allowed:true,view:{capture:{origin:{identity,authority,pins,policy,limits:windowsNativeLimits},originDigest:script.originDigest,frameInputDigest:job.inputDigest,launchRef:randomUUID()},record:{ref:seal,envelope},windowsEvidenceRef:expected},facts},observationDigests:observations.map(row=>row.evidenceDigest),original:{reservationId:binding.capacityReservationId,adoptionId:randomUUID(),sourceExecutionId:input.executionId,sourceInputEvidenceId:inputRef.evidenceId,ownerService:'trio_web_worker' as const,profileId:reference.profileId,profileDigest:reference.profileDigest,profileVersion:reference.profileVersion,protectedIntent:intent,intentDigest,actualIntentDigest:intentDigest},job};
  const {inputDigest:_inputDigest,...rawJob}=job;void _inputDigest;
  const candidate:NativeSealedReceiptV2['candidate']={version:2,candidateId:randomUUID(),jobId:job.jobId,parentInstanceId:intent.parentInstanceId,operationInputDigest:intent.operationInputDigest,kernelImplementationDigest:kernelDigest,verificationVersion:nativeFacadeVerificationVersion,resultObservationId:observations[0].evidenceId,resultObservationDigest:observations[0].evidenceDigest,resultDigest:digest(result.envelope),inputCanonical:canonicalize(rawJob)!,resultCanonical:canonicalize(result.envelope)!,blobs:result.envelope.blobs.map(ref=>({blobId:ref.id,assetId:randomUUID(),sha256:ref.sha256,bytesLength:String(ref.byteLength)})),windowsEvidenceRef:expected};
  const receipt:NativeSealedReceiptV2['receipt']={version:2,candidateId:candidate.candidateId,kernelImplementationDigest:kernelDigest,verificationVersion:nativeFacadeVerificationVersion,windowsEvidenceRef:expected,blobs:candidate.blobs.map(ref=>({blobId:ref.blobId,receipt:{key:input.accountId+'/'+ref.assetId,sha256:ref.sha256,bytesLength:ref.bytesLength,completedAt:'2026-10-22T00:00:00.000Z',completedAtPrecisionMilliseconds:1}}))};
  validateNativeReceiptCandidateV2(candidate,windowsFrameLimits,windowsFrameLimits);
  validateWindowsNativeEvidenceBundle(bundle,key,'trio_web_worker');
  const sealed:NativeSealedReceiptV2={candidate,receipt,intent,termination,origin:'FRESH'};
  return {key,bundle,sealed,script,intent,binding,frame,result,profile};
}
export type WindowsNativeSignedReceiptFixture=ReturnType<typeof createWindowsNativeSignedReceiptFixture>;


// B3-C 전용 조립은 호출 전 초기화나 전역 상태를 추가하지 않는다.
type B3CRef={evidenceId:string;evidenceDigest:string};
type B3CAttempt=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationAttempt;
type B3CTarget=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationTarget;
type B3COperation=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationOperation;
type B3CView=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationView;
export type B3CValidationContext={consumer:StageInput;claim:Claim;attempt:B3CAttempt;target:B3CTarget;input:StageInput;observation:import('../../packages/domain/src/provider.js').Observation;native:import('../../packages/native/src/facade.js').NativeFacade};
export type B3CFixtureOptions={
  mode:'PRE_FAULT'|'PRE_BOUNDARY'|'E2_FINAL';useRuntime?:boolean;cacheProducer?:'EXECUTION'|'REQUEST_CHECKPOINT';
  prepared?:(input:StageInput,claim:Claim)=>Promise<void>;
  beforeValidation?:(context:B3CValidationContext)=>Promise<void>;
  alterOperation?:(operation:B3COperation,context:B3CValidationContext)=>B3COperation;
  afterOperation?:(ref:B3CRef,context:B3CValidationContext)=>Promise<void>;
  checkpointFacts?:(facts:import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts,attempt:B3CAttempt)=>import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts|null;
  beforeCost?:(input:StageInput)=>Promise<void>;
};
export async function createB3CWindowsExecutionFixture(options:B3CFixtureOptions,suppliedDatabase?:Database){
  const f=await windowsNativeFixture(20,suppliedDatabase),restores:(()=>void)[]=[],events:string[]=[];
  let remote:Awaited<ReturnType<typeof createB3WindowsRemoteFixture>>|undefined;
  let cost:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCost|undefined;
  try{
    const {normalizeObservation}=await import('../../packages/domain/src/provider.js');
    const {FullStageCostPreparation}=await import('../../packages/domain/src/full-stage-cost-preparation.js');
    const {FullStageCostJournal}=await import('../../packages/domain/src/full-stage-cost-journal.js');
    const {CheckpointValidationJournal,checkpointValidationVersion}=await import('../../packages/domain/src/checkpoint-validation.js');
    const {OperationalStageCost}=await import('../../packages/domain/src/pipeline-stage-cost.js');
    const {WindowsStageCostReader,windowsStageCostBounds}=await import('../../packages/domain/src/windows-stage-cost-reader.js');
    const {nativeExecutionCaptureDigest}=await import('../../packages/domain/src/native-execution-wait.js');
    const {nativeTaskVersion}=await import('../../packages/native/src/dto.js');
    const now=(await f.admin.pool.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0].now;
    const profile:OwnedExecutionLimitProfile={kind:'OWNED_FIXTURE',version:syntheticProfile.id,maxSlots:2,requestLimitUsd:'10',dailyLimitUsd:'100',fullBoundUsd:'10',stages:{OCR:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:b3c/ocr']},TYPESET:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:b3c/typeset']}},fullBoundEvidenceRefs:['owned-fixture:b3c/full'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+23*3600000).toISOString()}};
    const profileId=randomUUID(),registered=(await f.operator.client.query<{profile_digest:string}>("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest",[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),profile.window!.kind,profile.window!.startAt,profile.window!.endAt])).rows[0];
    await f.operator.client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[profileId]);
    Object.assign(f.requestPolicy,{stageOrder:['OCR','TYPESET'],parameterProfileVersion:profile.version,executionLimit:{kind:'OWNED_FIXTURE',profileId,profileDigest:registered.profile_digest,profileVersion:profile.version}});
    const bytes=Buffer.from(ownedNativePng,'base64');
    const assets=(await f.admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1',[f.seed.accountId])).rows;
    for(const asset of assets)await f.files.put(f.seed.accountId+'/'+asset.asset_id,bytes);
    await f.admin.pool.query("UPDATE manga_web.assets SET bucket_ref=$2,object_key=account_id::text||'/'||asset_id::text,sha256=$3,bytes_length=$4,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1",[f.seed.accountId,f.files.bucket,sha256(bytes),String(bytes.length)]);
    await f.admin.pool.query("UPDATE manga_web.workspace_pages SET image_width=1,image_height=1 WHERE account_id=$1",[f.seed.accountId]);
    await f.admin.pool.query("UPDATE manga_web.results SET edit_data=jsonb_set(edit_data,'{renderSpecification}',$2::jsonb) WHERE account_id=$1",[f.seed.accountId,JSON.stringify({version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[]})]);
    let preparingSource=true,producerReady=false;const producerBoundary=Error('B3C_PRODUCER_E2_BOUNDARY');
    remote=await createB3WindowsRemoteFixture(f);const ownedRemote=remote,costs=remote.costs;
    const costProfile=digest({fixture:'b3c',version:1}),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'TYPESET',profileDigest:costProfile,basisVersion:'b3c-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:b3c/basis'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'b3c-native-v1',usdPerUnit:'0.000000000001',evidenceRefs:['owned-fixture:b3c/native-rate']},{componentId:'semantic',kind:'RENDER',unit:'event',rateVersion:'b3c-semantic-v1',usdPerUnit:'0.001',evidenceRefs:['owned-fixture:b3c/semantic-rate']}]};
    const calculator={maxInputBytes:131072,maxOutputBytes:1048576,maxComponents:64,maxEvidenceRefs:2046,maxStringBytes:4096},journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator});
    const preparation=new FullStageCostPreparation(journal,[{stage:'OCR',profileDigest:costProfile,snapshot:{...snapshot,stage:'OCR',components:snapshot.components.filter(c=>c.componentId==='native-image')}},{stage:'TYPESET',profileDigest:costProfile,snapshot}],calculator);
    const checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:512,maxTargets:64,maxJobs:64});
    let consumer:StageInput|null=null,claim:Claim|null=null,preView:B3CView={state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]},finalView:B3CView={state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]},finalEligible:'ELIGIBLE'|'WAIT'='WAIT';
    const record=checkpoints.recordIn.bind(checkpoints),recordSpy=vi.spyOn(checkpoints,'recordIn').mockImplementation(async(...args)=>{const view=await record(...args);if(args[2].purpose==='PRE_DISPATCH')preView=structuredClone(view);else finalView=structuredClone(view);events.push(args[2].purpose+'_'+view.state);return view;});restores.push(()=>recordSpy.mockRestore());
    const input=()=>{expect(consumer).not.toBeNull();return consumer!;},originalClaim=()=>{expect(claim).not.toBeNull();return claim!;};
    async function putOriginal(kind:string,value:unknown):Promise<B3CRef>{
      const current=input(),body={version:1,accountId:f.seed.accountId,executionId:current.executionId,inputDigest:current.inputDigest,inputFingerprint:digest(canonicalInput(current)),kind,value},evidenceId=randomUUID(),evidenceDigest=digest(body);
      await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)",[f.seed.accountId,evidenceId,current.executionId,kind,evidenceDigest,JSON.stringify(body),tx.now]),true);return {evidenceId,evidenceDigest};
    }

    type Saved={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:{version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};received_at:Date};
    async function records(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,kinds:string[]):Promise<Saved[]>{
      const rows=(await tx.client.query<Saved>("SELECT evidence_id,evidence_digest,protected_evidence_ref,protected_observation,received_at FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=ANY($3::text[]) ORDER BY received_at,evidence_id LIMIT 2047",[f.seed.accountId,current.executionId,kinds])).rows;expect(rows.length).toBeLessThanOrEqual(2046);
      for(const row of rows){const body=row.protected_observation;expect(row.protected_evidence_ref).toBe(row.evidence_id);expect(digest(body)).toBe(row.evidence_digest);expect(body).toMatchObject({version:1,accountId:f.seed.accountId,executionId:current.executionId,inputDigest:current.inputDigest,inputFingerprint:digest(canonicalInput(current))});expect(Object.keys(body)).toHaveLength(7);}return rows;
    }
    const ref=(row:Saved):B3CRef=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest});
    async function checkpointFactsIn(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,attempt:B3CAttempt){
      const rows=await records(tx,current,['CHECKPOINT_VALIDATION_OPERATION']);
      const operations=rows.filter(row=>(row.protected_observation.value as B3COperation).attemptId===attempt.attemptId).map(ref);
      const facts={attemptId:attempt.attemptId,operations};
      return !preparingSource&&options.checkpointFacts?options.checkpointFacts(facts,attempt):facts;
    }
    async function validateObservation(sourceInput:StageInput,observation:import('../../packages/domain/src/provider.js').Observation,context?:import('../../packages/domain/src/provider.js').ProviderCallContext){
      const current=input(),currentClaim=originalClaim();expect(context?.native).toBeDefined();
      const attemptRows=await f.worker.accountTransaction(f.seed.accountId,async tx=>{
        const rows=await records(tx,current,['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED']);
        const dones=new Set(rows.filter(r=>r.protected_observation.kind==='CHECKPOINT_VALIDATION_VERIFIED').map(r=>(r.protected_observation.value as {attemptId:string}).attemptId));
        return rows.filter(r=>r.protected_observation.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&!dones.has((r.protected_observation.value as B3CAttempt).attemptId));
      },true);
      if(preparingSource&&attemptRows.length===0){normalizeObservation(sourceInput,observation);if(options.cacheProducer==='EXECUTION'&&sourceInput.stage==='OCR')expect(await context!.native.decodeImage(bytes,syntheticProfile)).toMatchObject({width:1,height:1});return;}
      expect(attemptRows).toHaveLength(1);const attempt=attemptRows[0].protected_observation.value as B3CAttempt;
      const targets=attempt.targets.filter(t=>t.sourceExecutionId===sourceInput.executionId&&t.outputDigest===digest(observation));expect(targets).toHaveLength(1);const target=targets[0];
      const captured:B3CValidationContext={consumer:current,claim:currentClaim,attempt,target,input:sourceInput,observation,native:context!.native};
      events.push(attempt.purpose+':'+sourceInput.executionId);if(!preparingSource)await options.beforeValidation?.(captured);
      expect(digest(normalizeObservation(sourceInput,observation))).toBe(target.outputDigest);
      let native:NativeSealedReceiptV2[]=[];
      const needsNative=preparingSource?options.cacheProducer==='REQUEST_CHECKPOINT':attempt.purpose==='PRE_DISPATCH'?options.mode!=='E2_FINAL':options.cacheProducer?target.sourceExecutionId!==current.executionId:target.sourceExecutionId===current.executionId;
      if(needsNative){
        if(preparingSource)expect(await service.preflight(currentClaim,current)).toBe(true);
        expect(await context!.native.decodeImage(bytes,syntheticProfile)).toMatchObject({width:1,height:1});
        const cached=(await f.admin.pool.query("SELECT cu.protected_source FROM manga_web.windows_native_cost_cache_uses cu JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id) JOIN manga_web.windows_native_cost_scopes sc USING(account_id,scope_id) WHERE cu.account_id=$1 AND cc.execution_id=$2 AND sc.protected_scope->'owner'->'validationAttemptRef'=$3::jsonb AND sc.protected_scope->>'validationTargetDigest'=$4",[f.seed.accountId,current.executionId,JSON.stringify(ref(attemptRows[0])),digest(target)])).rows;
        if(cached.length){expect(cached).toHaveLength(1);native=[cached[0].protected_source as NativeSealedReceiptV2];}
        else{
          const rows=(await f.admin.pool.query("SELECT c.protected_candidate candidate,r.protected_receipt receipt,i.protected_intent intent,o.protected_observation->'termination' termination FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.native_job_observations o ON o.account_id=c.account_id AND o.job_id=c.job_id AND o.event='TERMINATION' WHERE c.account_id=$1",[f.seed.accountId])).rows;expect(rows).toHaveLength(1);
          const {isolation:_isolation,...termination}=rows[0].termination;native=[{candidate:rows[0].candidate,receipt:rows[0].receipt,intent:rows[0].intent,termination,origin:'FRESH'}];
        }
      }
      const root=(await f.admin.pool.query("SELECT owner_identity FROM manga_web.windows_native_cost_roots WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,current.executionId])).rows;expect(root).toHaveLength(1);
      const owner:WindowsNativeCostOwner={...root[0].owner_identity,claim:{generation:currentClaim.generation,ownerId:service.workerId,workItemId:currentClaim.workId},validationAttemptRef:ref(attemptRows[0])};
      const sourceTarget={accountId:f.seed.accountId,targetKind:'REQUEST_CHECKPOINT' as const,targetId:current.requestId,semanticCaptureDigest:nativeExecutionCaptureDigest('CHECKPOINT',current.requestId,sourceInput,observation),protectedOwnerCapture:attempt.owner,claim:owner.claim,sourceInput:{executionId:sourceInput.executionId,inputEvidenceId:target.input.evidenceId,stageInputDigest:sourceInput.inputDigest}};
      const operationId=randomUUID(),eventId=randomUUID(),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginScopeIn(tx,owner,sourceTarget,'CHECKPOINT',digest(target),randomUUID()),true);expect(scope).not.toBeNull();
      const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('B3C dependency read '+operationId),componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
      const io=createWindowsCostedObjectIo({objects:f.files,maxBytes:1048576,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.lookupIoIn(tx,r),true)});
      const storage:B3COperation['storage']=[],ends:B3CRef[]=[];
      for(const asset of target.assets){
        const observed=await io.read({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ',key:asset.objectKey,expected:{sha256:asset.sha256,bytesLength:asset.bytesLength}});
        expect(observed.state).toBe('RETURNED');if(observed.state!=='RETURNED')throw Error('B3C_ACTUAL_READ_REQUIRED');
        expect(sha256(observed.value)).toBe(asset.sha256);expect(String(observed.value.length)).toBe(asset.bytesLength);ends.push(observed.event.ended!);
        storage.push({eventId:observed.event.eventId,kind:'OBJECT_READ',assetId:asset.assetId,sha256:sha256(observed.value),bytesLength:String(observed.value.length),outcome:'RETURNED'});
      }
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:ends}),true)).toBe('JOINED');
      const operation:B3COperation={version:1,operationId,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target.inputFingerprint,outputDigest:target.outputDigest,semantic:{eventId,kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage,native};
      const operationRef=await putOriginal('CHECKPOINT_VALIDATION_OPERATION',!preparingSource&&options.alterOperation?options.alterOperation(operation,captured):operation);
      if(!preparingSource)await options.afterOperation?.(operationRef,captured);
    }
    async function prepareSources(providerUsd='0.01',validationState:'VERIFIED_FINAL'|'INCOMPLETE_FINAL'='VERIFIED_FINAL'){
      const current=input(),basis=(await journal.lookup(current)).basis;expect(basis).not.toBeNull();
      const operations=(await f.worker.accountTransaction(f.seed.accountId,tx=>records(tx,current,['CHECKPOINT_VALIDATION_OPERATION']),true));
      const extra=await f.worker.accountTransaction(f.seed.accountId,tx=>records(tx,current,['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED']),true);
      // 결손 검사는 원 PRE 성공과 FINAL 시도만 준비하며 검증 성공 기록을 합성하지 않는다.
      if(validationState==='INCOMPLETE_FINAL'){
        expect(preparingSource).toBe(false);expect(extra).toHaveLength(3);
        const attempts=extra.filter(row=>row.protected_observation.kind==='CHECKPOINT_VALIDATION_ATTEMPT').map(row=>row.protected_observation.value as B3CAttempt);
        expect(attempts.filter(attempt=>attempt.purpose==='PRE_DISPATCH')).toHaveLength(1);
        expect(attempts.filter(attempt=>attempt.purpose==='FINAL_COMMIT')).toHaveLength(1);
        const verified=extra.filter(row=>row.protected_observation.kind==='CHECKPOINT_VALIDATION_VERIFIED').map(row=>(row.protected_observation.value as {attemptId:string}).attemptId);
        expect(verified).toEqual([attempts.find(attempt=>attempt.purpose==='PRE_DISPATCH')!.attemptId]);
      }else expect(extra.length).toBe(preparingSource?2:4);
      const io=(await f.admin.pool.query<{protected_event:WindowsCostedIoEvent}>('SELECT en.protected_event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 ORDER BY st.operation_id',[f.seed.accountId,current.executionId])).rows;
      const provider={scope:'ACTUAL_AI_USD' as const,captureDigest:basis!.captureDigest,state:'CONFIRMED' as const,actualUsd:providerUsd},allocation={captureDigest:basis!.captureDigest,mode:basis!.capture.mode,funding:'FREE_OPERATIONS' as const,basisVersion:basis!.snapshot!.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'},semantic={componentId:'semantic',captureDigest:basis!.captureDigest,state:'CONFIRMED' as const,quantity:String(operations.length),unit:'event'};
      const entries=[{operationId:randomUUID(),eventId:randomUUID(),fact:provider},{operationId:randomUUID(),eventId:randomUUID(),fact:allocation},...io.map(({protected_event:v})=>({operationId:v.operationId,eventId:v.eventId,fact:provider,io:v})),...operations.map(row=>{const op=row.protected_observation.value as B3COperation;return {operationId:op.operationId,eventId:op.semantic.eventId,fact:semantic};})];
      for(const entry of entries){await putOriginal('WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,...entry});await putOriginal('WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId:entry.operationId,eventId:entry.eventId,outcome:'RETURNED'}]});}
      events.push('ORIGINAL_SOURCES_READY');
    }

    async function nonWindowsIn(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,basis:import('../../packages/domain/src/full-stage-cost-journal.js').FullStageCostBasis):Promise<import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet|null>{
      const saved=await records(tx,current,['WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE','WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED']);
      const rawSources=saved.filter(r=>r.protected_observation.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE');if(!rawSources.length)return null;
      type Facts=import('../../packages/domain/src/full-stage-cost.js').FullStageCostFacts;
      type Provider=Omit<NonNullable<Facts['provider']>,'evidenceRefs'>;type Allocation=Omit<NonNullable<Facts['allocation']>,'evidenceRefs'>;type Quantity=Omit<NonNullable<Facts['quantities']>[number],'evidenceRefs'>;
      let provider:Provider|undefined,allocation:Allocation|undefined,semantic:Quantity|undefined,firstSemantic=true;
      const sources:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet['sources']=[],terminationEvidence:B3CRef[]=[];
      const extra=saved.filter(r=>['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED'].includes(r.protected_observation.kind)).map(ref);
      for(const row of rawSources){
        const v=row.protected_observation.value as {operationId:string;eventId:string;fact:Provider|Allocation|Quantity;io?:WindowsCostedIoEvent};
        let target:'PROVIDER'|'ALLOCATION'|'QUANTITY',componentId:string|null=null;const evidence=[ref(row)];
        if('scope' in v.fact){target='PROVIDER';if(provider)expect(digest(provider)).toBe(digest(v.fact));provider=v.fact;}
        else if('funding' in v.fact){target='ALLOCATION';if(allocation)expect(digest(allocation)).toBe(digest(v.fact));allocation=v.fact;}
        else{target='QUANTITY';componentId=v.fact.componentId;if(semantic)expect(digest(semantic)).toBe(digest(v.fact));semantic=v.fact;
          const op=saved.filter(r=>r.protected_observation.kind==='CHECKPOINT_VALIDATION_OPERATION'&&(r.protected_observation.value as B3COperation).operationId===v.operationId&&(r.protected_observation.value as B3COperation).semantic.eventId===v.eventId);expect(op).toHaveLength(1);evidence.push(ref(op[0]));if(firstSemantic){evidence.push(...extra);firstSemantic=false;}
        }
        sources.push({sourceOperationId:v.operationId,sourceEventId:v.eventId,target,componentId,evidence});
        const ends=saved.filter(r=>r.protected_observation.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION'&&(r.protected_observation.value as {operations:{operationId:string;eventId:string;outcome:string}[]}).operations.some(o=>o.operationId===v.operationId&&o.eventId===v.eventId&&o.outcome==='RETURNED'));expect(ends).toHaveLength(1);terminationEvidence.push(ref(ends[0]));
      }
      if(!provider||!allocation||basis.snapshot?.components.some(c=>c.componentId==='semantic')&&!semantic)return null;
      const outcomes=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_observation:unknown}>("SELECT evidence_id,evidence_digest,protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME' ORDER BY evidence_id LIMIT 2",[f.seed.accountId,current.executionId])).rows;expect(outcomes).toHaveLength(1);expect(digest(outcomes[0].protected_observation)).toBe(outcomes[0].evidence_digest);terminationEvidence.push({evidenceId:outcomes[0].evidence_id,evidenceDigest:outcomes[0].evidence_digest});
      const refs=(target:string)=>sources.filter(s=>s.target===target).flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();
      expect(provider.captureDigest).toBe(basis.captureDigest);
      return {version:1,executionId:current.executionId,inputFingerprint:digest(canonicalInput(current)),captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(s=>s.evidence),terminationEvidence,sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER')},allocation:{...allocation,evidenceRefs:refs('ALLOCATION')},quantities:semantic?[{...semantic,evidenceRefs:refs('QUANTITY')}]:[]}};
    }
    const nonWindows=Object.freeze({nonWindowsIn,checkpointFactsIn}),reader=new WindowsStageCostReader({db:f.worker,windows:costs,nonWindows,bounds:{...windowsStageCostBounds}});
    cost=OperationalStageCost.windows({db:f.worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});const operationalCost=cost;
    const good=new SyntheticProvider(),sourceProvider=new SyntheticProvider(value=>value.stage==='TYPESET'?{evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:'0.02',usageConfirmed:true,finishReason:'B3C_SOURCE_PREPARATION_FAILURE',providerRef:value.executionId,data:null}:good.success(value));
    const provider:import('../../packages/domain/src/provider.js').ProviderAdapter={synthetic:true,validateObservation,validateInput:async()=>{events.push('VALIDATE_INPUT');},dispatch:async(current,started)=>{events.push('DISPATCH');return (preparingSource?sourceProvider:f.provider).dispatch(current,started);},lookup:(executionId)=>f.provider.lookup(executionId)};
    type InternalCheckpoint={validateOperationalCheckpoints(claim:Claim,input:StageInput,purpose:'PRE_DISPATCH'|'FINAL_COMMIT'):Promise<boolean>};
    const drive=(purpose:'PRE_DISPATCH'|'FINAL_COMMIT')=>(service as unknown as InternalCheckpoint).validateOperationalCheckpoints(originalClaim(),input(),purpose);
    async function successSetup(){
      const current=input(),raw=f.provider.success(current),checkpointId=randomUUID(),observation=normalizeObservation(current,{...raw,stageOutput:{executionId:current.executionId,inputDigest:current.inputDigest,stageContract:current.settings.contractVersion,outcome:'CONFIRMED_SUCCESS',protectedEvidenceRef:raw.evidenceId,outputAssetIds:[],checkpointId,usageState:'CONFIRMED',actualCostUsd:raw.costUsd,finishReason:raw.finishReason}});
      const evidenceId=randomUUID(),evidenceDigest=digest(observation);
      await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at) VALUES($1,$2,$3,'OUTCOME',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,evidenceId,current.executionId,evidenceDigest,JSON.stringify(observation),tx.now]),true);
      await f.admin.pool.query("UPDATE manga_web.executions SET state='SUCCEEDED',output_envelope=$3,finished_confirmed_at=clock_timestamp(),start_confirmed_at=COALESCE(start_confirmed_at,clock_timestamp()) WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,current.executionId,JSON.stringify(observation)]);
      await f.admin.pool.query("INSERT INTO manga_web.checkpoints(account_id,checkpoint_id,execution_id,stage_contract,dependency_digest,protected_manifest_ref,verification_state,output_envelope) VALUES($1,$2,$3,$4,$5,$3::uuid::text,'VERIFIED',$6)",[f.seed.accountId,checkpointId,current.executionId,current.settings.contractVersion,current.inputDigest,JSON.stringify(observation)]);
      events.push('E2_SUCCESS_FIXTURE');
    }
    async function terminalProducerSetup(){
      const current=input(),observation=normalizeObservation(current,{evidenceId:randomUUID(),outcome:'NOT_STARTED',started:false,costUsd:'0',usageConfirmed:true,finishReason:'B3C_PRODUCER_PREPARATION_ONLY',providerRef:current.executionId,data:null}),evidenceId=randomUUID();
      await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at) VALUES($1,$2,$3,'OUTCOME',$4,$2::uuid::text,$5,$6)",[f.seed.accountId,evidenceId,current.executionId,digest(observation),JSON.stringify(observation),tx.now]),true);
      await f.admin.pool.query("UPDATE manga_web.executions SET state='REJECTED',output_envelope=$3,finished_confirmed_at=clock_timestamp() WHERE account_id=$1 AND execution_id=$2",[f.seed.accountId,current.executionId,JSON.stringify(observation)]);
      events.push('CACHE_PRODUCER_E2_NOT_STARTED');
    }
    let finalResult:boolean|null=null;
    const boundary=Error('B3-C 검사 소유 경계');
    let boundaryEntered:(()=>void)|undefined,boundaryRelease:Promise<void>|undefined,driving=false;
    const hooks:ConstructorParameters<typeof ExecutionService>[3]={heartbeatMilliseconds:25,beforeValidateInput:async value=>{
      consumer=structuredClone(value);expect(claim).not.toBeNull();events.push('ROOT_ACK');if(preparingSource){if(options.cacheProducer==='REQUEST_CHECKPOINT'&&value.stage==='TYPESET'){expect(await drive('PRE_DISPATCH')).toBe(true);await terminalProducerSetup();await prepareSources('0');producerReady=true;}return;}await options.prepared?.(value,originalClaim());
      if(options.mode==='E2_FINAL'){expect(driving).toBe(true);boundaryEntered!();await boundaryRelease;throw boundary;}
    },afterPrepare:async()=>{if(!preparingSource&&options.mode==='PRE_BOUNDARY'){expect(preView.state).toBe('VERIFIED');events.push('PRE_BOUNDARY');throw boundary;}},afterDispatch:async()=>{if(preparingSource){if(options.cacheProducer==='EXECUTION'&&input().stage==='OCR'){await successSetup();await prepareSources();producerReady=true;throw producerBoundary;}await prepareSources(input().stage==='TYPESET'?'0.02':'0.01');}}};
    let runtime:ReturnType<typeof import('../../apps/api/src/runtime.js').createWorkerRuntime>|undefined;
    let service:ExecutionService;
    if(options.useRuntime){
      const {createWorkerRuntime}=await import('../../apps/api/src/runtime.js');
      runtime=createWorkerRuntime({worker:f.worker,objects:f.files,fonts:{catalog:{version:'b3c-fixed-font',fonts:[]},bytes:new Map()} as unknown as import('../../packages/media/src/fonts.js').FontCatalog,profile:syntheticProfile,policy:f.requestPolicy,provider,workerNative:remote.gateway,workerOperationalCost:cost,workerExecutionHooks:hooks});service=runtime.execution;
      // 원 runtime을 사용하되 합성 media adapter의 제공자 4포트는 이 검사의 고정 포트로 명시 교체한다.
      // 등록·claim·PRE/FINAL·native context·비용·tick/idle은 원 구현이며 media 품질 경로의 증거는 아니다.
      const runtimeProvider=runtime.execution.provider;
      const validateInput=vi.spyOn(runtimeProvider,'validateInput').mockImplementation(provider.validateInput!.bind(provider));restores.push(()=>validateInput.mockRestore());
      const validateObservation=vi.spyOn(runtimeProvider,'validateObservation').mockImplementation(provider.validateObservation!.bind(provider));restores.push(()=>validateObservation.mockRestore());
      const dispatch=vi.spyOn(runtimeProvider,'dispatch').mockImplementation(provider.dispatch.bind(provider));restores.push(()=>dispatch.mockRestore());
      const lookup=vi.spyOn(runtimeProvider,'lookup').mockImplementation(provider.lookup.bind(provider));restores.push(()=>lookup.mockRestore());
    }else service=new ExecutionService(f.worker,provider,f.requestPolicy,hooks,remote.gateway,cost);
    const boundaryClaimSelections:(Claim|null)[]=[];
    const originalClaimMethod=service.claim.bind(service),claimSpy=vi.spyOn(service,'claim').mockImplementation(async()=>{const result=await originalClaimMethod();if(!preparingSource&&options.mode==='PRE_BOUNDARY')boundaryClaimSelections.push(result===null?null:structuredClone(result));if(result?.kind==='DISPATCH')claim=result;return result;});restores.push(()=>claimSpy.mockRestore());
    if(options.beforeCost){const finishCost=cost.finishAttempt.bind(cost),spy=vi.spyOn(cost,'finishAttempt').mockImplementation(async current=>{if(!preparingSource)await options.beforeCost!(current);await finishCost(current);});restores.push(()=>spy.mockRestore());}
    // 정상 tick과 구별하며 자기 중단 객체의 단독 전달만 인정한다.
    async function runBoundary():Promise<void>{
      expect(preparingSource).toBe(false);expect(options.mode==='PRE_BOUNDARY'||options.mode==='E2_FINAL').toBe(true);expect(driving).toBe(false);
      if(options.mode==='PRE_BOUNDARY'){
        // drain의 noWork는 미래 due_at 작업의 DONE을 증명하지 않는다. 같은 원 OCR 한 건만 추가로 허용한다.
        expect(source.stage).toBe('OCR');expect(source.requestId).toBe(originalRequestId);expect(consumer).toBeNull();
        type BoundaryWork={account_id:string;work_item_id:string;kind:string;state:string;claim_generation:string;claim_owner:string|null;lease_until:Date|null;target_ref:Record<string,string>};
        const queue=(await f.admin.pool.query<BoundaryWork>("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND((kind='RECONCILE' AND target_ref=$2::jsonb)OR(kind='DISPATCH' AND target_ref=$3::jsonb)) ORDER BY kind,work_item_id",[f.seed.accountId,JSON.stringify({executionId:source.executionId}),JSON.stringify({requestId})])).rows;
        const reconciles=queue.filter(row=>row.kind==='RECONCILE'),dispatches=queue.filter(row=>row.kind==='DISPATCH');expect(reconciles).toHaveLength(1);expect(dispatches).toHaveLength(1);
        const reconcile=reconciles[0],dispatch=dispatches[0];expect(['READY','DONE']).toContain(reconcile.state);expect(reconcile).toMatchObject({account_id:f.seed.accountId,claim_owner:null,lease_until:null});expect(dispatch).toMatchObject({account_id:f.seed.accountId,state:'READY',claim_owner:null,lease_until:null});
        async function sourceEffects(){
          const params=[f.seed.accountId,source.executionId];
          const evidence=(await f.admin.pool.query('SELECT * FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY evidence_id',params)).rows;
          const checkpoint=(await f.admin.pool.query('SELECT * FROM manga_web.checkpoints WHERE account_id=$1 AND execution_id=$2 ORDER BY checkpoint_id',params)).rows;
          const money=(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',params)).rows,expenses=(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',params)).rows;
          const native=(await f.admin.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows,go=(await f.admin.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows,observations=(await f.admin.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY job_id,event,observation_id',[f.seed.accountId])).rows;
          const counts=(await f.admin.pool.query('SELECT (SELECT count(*) FROM manga_web.windows_native_cost_scopes WHERE account_id=$1) scopes,(SELECT count(*) FROM manga_web.windows_native_cost_calls WHERE account_id=$1) calls,(SELECT count(*) FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) starts,(SELECT count(*) FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) ends,(SELECT count(*) FROM manga_web.windows_native_cost_cache_uses WHERE account_id=$1) cache',[f.seed.accountId])).rows;
          return {evidence,checkpoint,money,expenses,native,go,observations,counts,objectIo:{...f.objectIo},providerCalls:structuredClone(f.provider.calls),providerLookups:structuredClone(f.provider.lookups)};
        }
        const before=await sourceEffects(),offset=boundaryClaimSelections.length;
        const step=()=>service.runOnce().then(value=>({stopped:false as const,value}),error=>{if(error!==boundary)throw error;return {stopped:true as const};});
        function selected(index:number){expect(boundaryClaimSelections).toHaveLength(index+1);const value=boundaryClaimSelections[index];expect(value).not.toBeNull();expect(value!.accountId).toBe(f.seed.accountId);return value!;}
        function reached(value:Awaited<ReturnType<typeof step>>,selectedClaim:Claim){
          expect(value.stopped).toBe(true);expect(selectedClaim).toEqual({accountId:f.seed.accountId,workId:dispatch.work_item_id,generation:(BigInt(dispatch.claim_generation)+1n).toString(),kind:'DISPATCH',ref:{requestId}});
          expect(preView.state).toBe('VERIFIED');expect(preView.attempt).not.toBeNull();const checkpointDigests=Object.fromEntries(preView.attempt!.targets.map(target=>[target.checkpointId,target.outputDigest]));
          expect(originalClaim()).toEqual({...selectedClaim,checkpointDigests});expect(input()).toMatchObject({requestId,stage:'TYPESET',claimGeneration:selectedClaim.generation});expect(events.filter(value=>value==='PRE_BOUNDARY')).toHaveLength(1);
        }
        const first=await step(),chosen=selected(offset);
        if(first.stopped){reached(first,chosen);return;}
        expect(first.value).toBe(true);expect(reconcile.state).toBe('READY');expect(chosen).toEqual({accountId:f.seed.accountId,workId:reconcile.work_item_id,generation:(BigInt(reconcile.claim_generation)+1n).toString(),kind:'RECONCILE',ref:{executionId:source.executionId}});
        expect(consumer).toBeNull();expect(await sourceEffects()).toEqual(before);
        const completed=(await f.admin.pool.query<BoundaryWork>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,reconcile.work_item_id])).rows;expect(completed).toHaveLength(1);expect(completed[0]).toMatchObject({account_id:f.seed.accountId,kind:'RECONCILE',state:'DONE',claim_generation:chosen.generation,claim_owner:null,lease_until:null,target_ref:{executionId:source.executionId}});
        expect((await f.admin.pool.query<BoundaryWork>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,dispatch.work_item_id])).rows).toEqual([dispatch]);events.push('PRE_BOUNDARY_SOURCE_RECONCILE_QUEUE_TICK');
        const second=await step();reached(second,selected(offset+1));return;
      }
      let notify!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{notify=resolve;});boundaryRelease=new Promise<void>(resolve=>{release=resolve;});boundaryEntered=notify;driving=true;
      const pending=service.runOnce().then(value=>({state:'RETURNED' as const,value}),error=>({state:'THREW' as const,error}));
      const failures:unknown[]=[];let early:Awaited<typeof pending>|undefined;
      try{
        const reached=await Promise.race([entered.then(()=>null),pending]);
        if(reached!==null){early=reached;if(reached.state==='THREW')throw reached.error;expect(consumer).toBeNull();expect(reached.value).toBe(true);events.push('E2_QUEUE_TICK');return;}
        expect(await drive('PRE_DISPATCH')).toBe(true);expect(await service.preflight(originalClaim(),input())).toBe(true);
        await successSetup();finalResult=await drive('FINAL_COMMIT');
        if(finalResult){finalEligible=await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.finalCommitIn(tx,input()),true);await prepareSources();}
      }catch(error){failures.push(error);}
      finally{
        release();const stopped=await pending;
        if(stopped.state==='RETURNED'){if(!early)failures.push(Error('E2 검사 소유 중단 누락'));}
        else if(stopped.error!==boundary&&!failures.includes(stopped.error))failures.push(stopped.error);
        driving=false;boundaryEntered=undefined;boundaryRelease=undefined;
      }
      if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E2 driver와 원 finally 오류');
    }
    // 선행 요청도 원 Windows 비용 경로로 끝내 이전 미확정 비용을 남기지 않는다.
    const originalRequestId=await f.request();
    let drained=false,producerClosed=false;for(let n=0;n<30;n++){
      let worked:boolean;try{worked=await service.runOnce();}catch(error){if(error!==producerBoundary)throw error;worked=true;}
      if(producerReady&&!producerClosed){producerClosed=true;await f.admin.accountTransaction(f.seed.accountId,async tx=>{await tx.client.query("UPDATE processing_requests SET state='FAILED',terminal_at=$3,terminal_evidence_ref='B3C_CACHE_PRODUCER_E2',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[f.seed.accountId,originalRequestId,tx.now]);await tx.client.query('DELETE FROM active_page_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,originalRequestId]);await tx.client.query("UPDATE work_items SET due_at=clock_timestamp() WHERE account_id=$1 AND state='READY'",[f.seed.accountId]);});}
      if(!worked){drained=true;break;}
    }expect(drained).toBe(true);
    expect((await f.admin.pool.query('SELECT state FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,originalRequestId])).rows[0].state).toBe('FAILED');
    console.info(JSON.stringify({b3cSourceSetup:{events,executions:(await f.admin.pool.query('SELECT logical_step_id,state,safe_error_code FROM manga_web.executions WHERE account_id=$1 ORDER BY logical_step_id',[f.seed.accountId])).rows,outcomes:(await f.admin.pool.query("SELECT kind,protected_observation->>'finishReason' reason FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('OUTCOME','STALE_OUTCOME')",[f.seed.accountId])).rows}}));
    const sourcePending=await f.worker.accountTransaction(f.seed.accountId,tx=>operationalCost.hasPendingOtherIn(tx,null),true);
    if(sourcePending){const sourceInputs=(await f.admin.pool.query("SELECT protected_observation input FROM manga_web.execution_evidence WHERE account_id=$1 AND kind='INPUT' ORDER BY received_at",[f.seed.accountId])).rows;
      const diagnostic=[];for(const {input:sourceInput} of sourceInputs){const view=await f.worker.accountTransaction(f.seed.accountId,tx=>operationalCost.readIn(tx,sourceInput),true);diagnostic.push({executionId:sourceInput.executionId,stage:sourceInput.stage,state:view.state,costUsd:view.costUsd,conflicts:view.conflicts,sealedCalculation:view.sealedCalculation});}
      console.info(JSON.stringify({b3cSourcePending:{diagnostic,costs:(await f.admin.pool.query("SELECT execution_id,component,state,actual_usd::text,usage_ref,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 ORDER BY execution_id,component",[f.seed.accountId])).rows,evidence:(await f.admin.pool.query("SELECT execution_id,kind,count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') GROUP BY execution_id,kind",[f.seed.accountId])).rows}}));}
    expect(sourcePending).toBe(false);
    const producerBefore={go:(await f.admin.pool.query('SELECT * FROM manga_web.native_job_go_consumptions WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows,intents:(await f.admin.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows,observations:(await f.admin.pool.query('SELECT * FROM manga_web.native_job_observations WHERE account_id=$1 ORDER BY job_id,event,observation_id',[f.seed.accountId])).rows,financial:(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at FROM manga_web.execution_evidence WHERE account_id=$1 AND kind IN('OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY evidence_id",[f.seed.accountId])).rows};
    const sourceRows=(await f.admin.pool.query<{input:StageInput}>("SELECT i.protected_observation input FROM manga_web.checkpoints c JOIN manga_web.execution_evidence i USING(account_id,execution_id) WHERE c.account_id=$1 AND i.kind='INPUT'",[f.seed.accountId])).rows;expect(sourceRows).toHaveLength(1);const source=sourceRows[0].input;
    const requestId=(await f.workspace.handle(f.actor,await f.command({kind:'RETRY_REQUEST',payload:{requestId:originalRequestId}}))).reply.operationRef.id!;
    preparingSource=false;consumer=null;claim=null;preView={state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]};finalView={state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]};events.length=0;
    async function inspect(){
      const current=input(),id=current.executionId,params=[f.seed.accountId,id];
      const inputs=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",params)).rows;
      const bases=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OPERATIONAL_COST_BASIS'",params)).rows;
      const enrollments=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_enrollments WHERE account_id=$1 AND execution_id=$2',params)).rows,roots=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_roots WHERE account_id=$1 AND execution_id=$2',params)).rows;
      const count=async(table:string,where='execution_id=$2')=>(await f.admin.pool.query<{n:number}>('SELECT count(*)::integer n FROM manga_web.'+table+' WHERE account_id=$1 AND '+where,params)).rows[0].n;
      const evidence=async(kind:string)=>(await f.admin.pool.query<{n:number}>('SELECT count(*)::integer n FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=$3',[...params,kind])).rows[0].n;
      const counts={go:await count('native_job_go_consumptions','true AND $2::uuid IS NOT NULL'),intents:await count('native_job_intents','true AND $2::uuid IS NOT NULL'),bindings:await count('windows_native_cost_bindings'),cacheUses:await count('windows_native_cost_cache_uses','call_id IN(SELECT call_id FROM manga_web.windows_native_cost_calls WHERE account_id=$1 AND execution_id=$2)'),starts:await count('windows_native_cost_io_starts'),ends:await count('windows_native_cost_io_ends','operation_id IN(SELECT operation_id FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2)'),calculation:await evidence('OPERATIONAL_COST_CALCULATION'),closure:await evidence('OPERATIONAL_COST_CLOSURE'),seal:await evidence('WINDOWS_STAGE_COST_SEAL'),expense:(await f.admin.pool.query<{n:number}>('SELECT count(*)::integer n FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2',params)).rows[0].n};
      const costView=await f.worker.accountTransaction(f.seed.accountId,tx=>operationalCost.readIn(tx,current),true),request=(await f.admin.pool.query('SELECT * FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,requestId])).rows[0];
      const totals=(await f.admin.pool.query("SELECT c.actual_usd::text stage_usd,x.actual_usd::text expense_usd,c.usage_ref,x.evidence_id,x.evidence_digest,c.confirmed_at FROM manga_web.cost_items c LEFT JOIN manga_web.execution_limit_expenses x USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 AND c.component='STAGE_TOTAL' ORDER BY c.ordinal",params)).rows;
      const permits=(await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',params)).rows,budgets=(await f.admin.pool.query('SELECT * FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,requestId])).rows;
      const financialRefs=(await f.admin.pool.query("SELECT evidence_id,evidence_digest,received_at,kind,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('WINDOWS_STAGE_COST_SEAL','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE') ORDER BY kind,evidence_id",params)).rows;
      return {inputs,bases,enrollments,roots,pre:structuredClone(preView),final:structuredClone(finalView),counts,cost:costView,request,totals,permits,budgets,financialRefs};
    }
    function reopenCost(){
      const historyReader=new WindowsStageCostReader({db:f.worker,windows:costs,nonWindows:{nonWindowsIn:async()=>{throw Error('B3C_HISTORY_NO_NEW_WORK');},checkpointFactsIn:async()=>{throw Error('B3C_HISTORY_NO_CHECKPOINT_CALLBACK');}},bounds:{...windowsStageCostBounds}});
      return OperationalStageCost.windows({db:f.worker,preparation,journal:new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator}),reader:historyReader,checkpoints:new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:512,maxTargets:64,maxJobs:64}),bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});
    }
    return {...f,remote,provider,service,runtime,mode:options.mode,runBoundary,cost:operationalCost,journal,preparation,checkpoints,reader,snapshot,source,requestId,events,drive,successSetup,prepareSources,inspect,reopenCost,producerBefore,get consumer(){return consumer;},get claim(){return claim;},get finalResult(){return finalResult;},get finalEligible(){return finalEligible;},close:async()=>{
      try{if(runtime){runtime.stopClaims();await runtime.idle();}await operationalCost.idle();await ownedRemote.close();}
      finally{for(const restore of restores.reverse())restore();await f.close();}
    }};
  }catch(error){try{await cost?.idle();await remote?.close();}finally{for(const restore of restores.reverse())restore();await f.close();}throw error;}
}


import type {Database} from '../../packages/storage/src/database.js';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';

// 원 1..25와 실행기 bytes를 보존한 검사 전용 세대다. Temp 사본은 기록용으로 남긴다.
export async function createWindowsNativeMigrationEpoch(){
  const sourceDirectory=fileURLToPath(new URL('../../',import.meta.url)),sourceMigrations=path.join(sourceDirectory,'db','migrations');
  const names=(await readdir(sourceMigrations)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)&&Number(name.slice(0,4))<=25).sort();
  expect(names.map(name=>Number(name.slice(0,4)))).toEqual(Array.from({length:25},(_,index)=>index+1));
  const directory=await mkdtemp(path.join(tmpdir(),'trio-windows-native-migration-epoch-'));
  expect(path.dirname(path.resolve(directory)).toLowerCase()).toBe(path.resolve(tmpdir()).toLowerCase());expect((await lstat(directory)).isSymbolicLink()).toBe(false);
  const migrationDirectory=path.join(directory,'db','migrations'),runner=path.join(directory,'packages','storage','src','migrations.ts');
  const files=['packages/storage/src/migrations.ts',...names.map(name=>'db/migrations/'+name)],manifest:{path:string;bytesLength:number;sha256:string;copiedSha256:string}[]=[];
  for(const relative of files){
    const source=path.join(sourceDirectory,relative),destination=path.join(directory,relative),bytes=await readFile(source),sourceSha256=sha256(bytes);
    await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);
    const copied=await readFile(destination),copiedSha256=sha256(copied);expect(copied).toEqual(bytes);expect(copiedSha256).toBe(sourceSha256);expect(sha256(await readFile(source))).toBe(sourceSha256);
    manifest.push({path:relative,bytesLength:bytes.length,sha256:sourceSha256,copiedSha256});
  }
  await writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'})+'\n');
  await writeFile(path.join(directory,'source-sha256.json'),JSON.stringify({maximumMigration:25,files:manifest},null,2)+'\n');
  const module=await import(pathToFileURL(runner).href) as typeof import('../../packages/storage/src/migrations.js');expect(typeof module.migrate).toBe('function');
  return {directory,migrationDirectory,migrate:module.migrate};
}

function w4cDiagnosticFault(error:unknown):unknown{
  const value=error as {name?:unknown;code?:unknown;status?:unknown;termination?:{kind?:unknown};evidence?:{termination?:{kind?:unknown}};stack?:unknown}|null;
  const code=typeof value?.code==='string'&&/^[A-Z0-9_]+$/.test(value.code)?value.code:null;
  const result={이름:typeof value?.name==='string'?value.name:typeof error,코드:code,상태:typeof value?.status==='number'?value.status:null,종료:value?.termination?.kind??value?.evidence?.termination?.kind??null,stack:typeof value?.stack==='string'?value.stack.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,7):[]};
  return error instanceof AggregateError?{...result,원인:[...error.errors].map(w4cDiagnosticFault)}:result;
}

// E3 정상 조립은 최초 요청 하나를 실제 runOnce로 실행한다.
async function createW4CWindowsRemoteFixture(f:WindowsNativeFixture,options:{metadata?:Record<string,unknown>;parentRelease?:Promise<void>;beforeExchange?:(request:NativeControllerRequestV2)=>Promise<void>;afterExchange?:(request:NativeControllerRequestV2,response:NativeControllerResponseV2)=>Promise<void>}={}){
  const prepared={costs:new WindowsNativeCostJournal(f.worker,{maxRecordBytes:32768,maxRecords:256}),components:[{task:'DECODE_IMAGE' as const,componentId:'native-image'}],capacity:await f.registerWindowsProfile()};
  // 실제 PG 검증에는 부모 통신 예산 10초를 사용한다. 가짜 host의 1초 OS 정책은 유지한다.
  // 원 W3-B fixture와 제한은 그대로이며, 새 profile에 달라진 limits digest를 정확히 등록한다.
  const remoteLimits={...windowsNativeLimits,timeoutMs:10000},profile={...prepared.capacity.profile,windows:{...prepared.capacity.profile.windows,pins:{...prepared.capacity.profile.windows.pins,nativeLimitsDigest:digest(remoteLimits)}}},profileId=randomUUID();
  const profileRow=(await f.operator.client.query<{profile_digest:string}>(`INSERT INTO manga_web.native_capacity_profiles(profile_id,profile_payload,profile_version,max_slots,native_profile_digest,kernel_digest,controller_id,key_version,environment_digest,public_key_spki)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING profile_digest`,[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.nativeProfileDigest,profile.kernelDigest,profile.controllerId,profile.keyVersion,profile.environmentDigest,profile.publicKeySpki])).rows[0];
  await f.operator.client.query("UPDATE manga_web.native_capacity_authority SET current_profile_id=$1,state='OPEN',revision=revision+1 WHERE singleton",[profileId]);
  const capacity={reference:{...prepared.capacity.reference,profileId,profileDigest:profileRow.profile_digest},profile};

  const {createNativeControllerMemory,NativeControllerAttempts}=await import('../../packages/native/src/controller-attempts.js');
  const {createCostedWindowsControllerPorts}=await import('../../packages/domain/src/native-controller-store.js');
  const {createWindowsOriginalController}=await import('../../packages/native/src/controller.js');
  const {NativeRemoteController}=await import('../../packages/native/src/controller-remote.js');
  const {NativeRemoteDatabaseGateway}=await import('../../packages/domain/src/native-remote-gateway.js');
  const memory=createNativeControllerMemory(33554432),exchangeMemory=createNativeControllerMemory(4194304);
  const objects={bucket:f.files.bucket,put:async(key:string,bytes:Buffer)=>{f.objectIo.put++;return f.files.put(key,bytes);},read:async(key:string)=>{f.objectIo.get++;return f.files.read(key);},receipt:f.files.receipt.bind(f.files),remove:async()=>{throw new Error('W3C_DELETE_FORBIDDEN');}};
  const parentIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.beginIoIn(tx,request)),end:event=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.endIoIn(tx,event),true),lookup:request=>f.worker.accountTransaction(f.seed.accountId,tx=>prepared.costs.lookupIoIn(tx,request),true)});
  const diagnostics:unknown[]=[],contexts=new Map<string,unknown[]>(),originalDecision=f.controllerDb.decision.bind(f.controllerDb);
  f.controllerDb.decision=async(accountId,sql,values,check)=>{
    let result;try{result=await originalDecision(accountId,sql,values,check);}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'CONTROLLER_DB',function:sql.match(/manga_web\.([a-z_]+)/)?.[1],code:fault.code,message:fault.message});throw error;}
    const decision=result as {allowed?:unknown;reason?:unknown};diagnostics.push({boundary:'CONTROLLER_DECISION',function:sql.match(/manga_web\.([a-z_]+)/)?.[1],allowed:typeof decision.allowed==='boolean'?decision.allowed:null,reason:typeof decision.reason==='string'&&/^[A-Z0-9_]+$/.test(decision.reason)?decision.reason:null});
    if(sql.includes('windows_native_cost_controller_io_begin(')||sql.includes('windows_native_cost_controller_io_lookup(')){const request=JSON.parse(values[3] as string) as WindowsCostedIoRequest;contexts.set(request.operationId,[values[0],values[1],values[2],values[4]]);}return result;
  };
  const eventCall=async(kind:'lookup'|'end',request:WindowsCostedIoRequest|WindowsCostedIoCompletion):Promise<WindowsCostedIoEvent|null>=>{
    const context=contexts.get(request.operationId);if(!context)throw new Error('W4B_REAL_CONTROLLER_IO_CONTEXT_REQUIRED');
    const decision=await f.controllerDb.decision<{allowed:boolean;event:WindowsCostedIoEvent|null}>(f.seed.accountId,`SELECT jsonb_build_object('allowed',true,'event',manga_web.windows_native_cost_controller_io_${kind}($1::jsonb,$2,$3,$4::jsonb,$5::jsonb)) AS decision`,[context[0],context[1],context[2],JSON.stringify(request),context[3]]);return decision.event;
  };
  const rawIo=createWindowsCostedObjectIo({objects,maxBytes:remoteLimits.maxOutputBytes,begin:request=>eventCall('lookup',request),end:event=>eventCall('end',event),lookup:request=>eventCall('lookup',request)});
  const transport=Object.freeze({peer:randomUUID()}),peers={authenticate:async(value:unknown)=>{expect(value).toBe(transport);return {...f.peer};}};
  const bounds={maxControlBytes:8192,input:windowsFrameLimits,output:windowsFrameLimits},virtual=createWindowsNativeClock();
  let controller:ReturnType<typeof createWindowsOriginalController>|undefined,coordinator:NativeControllerAttempts|undefined,ownedJournal:ReturnType<typeof createCostedWindowsControllerPorts>['journal']|undefined;
  const frames=new Map<string,NativeFrame<import('../../packages/native/src/dto.js').NativeJob>>(),hosts=new Map<string,ReturnType<typeof createWindowsNativeBroker>>();
  const broker:WindowsJobPorts['broker']={
    open:async capture=>{
      const jobId=capture.origin.identity.binding.jobId,frame=frames.get(jobId);expect(frame).toBeDefined();expect(hosts.has(jobId)).toBe(false);
      const bytes=frame!.blobs.get('source');expect(bytes).toBeDefined();
      const blobs=new Map([['canonical-png',Buffer.from(bytes!)]]),metadata={width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes!.length};
      const result={envelope:createNativeResult(frame!.envelope,{metadata,blobs},windowsFrameLimits),blobs};
      const host=createWindowsNativeBroker(frame!,{result,accounting:{userTime100ns:'10000000',kernelTime100ns:'0'}});hosts.set(jobId,host);
      return host.broker.open(capture);
    },
    readOriginal:async capture=>{const host=hosts.get(capture.origin.identity.binding.jobId);expect(host).toBeDefined();return host!.broker.readOriginal(capture);}
  };
  const resolveCoordinator=async(request:NativeControllerRequestV2)=>{
    if(request.input){const prior=frames.get(request.input.envelope.jobId);if(prior)expect(prior).toEqual(request.input);else frames.set(request.input.envelope.jobId,request.input);}
    if(coordinator)return coordinator;
    expect(request.control.command).toBe('PREPARE');expect(request.input).toBeDefined();
    const ports=createCostedWindowsControllerPorts({db:f.controllerDb,configuration:{controllerId:f.profile.controllerId,controllerInstanceId:f.controllerInstanceId,capacity,limits:remoteLimits,signer:f.signer},rawIo,bucketRef:f.files.bucket,memory});f.journals.push(ports.journal);ownedJournal=ports.journal;
    controller=createWindowsOriginalController({...ports,broker,clock:virtual.clock});
    coordinator=new NativeControllerAttempts(controller,peers,{maxControlBytes:bounds.maxControlBytes,goWaitMilliseconds:100,maxInFlightBytes:memory.maxBytes});return coordinator;
  };
  type Parent={exchange:ReturnType<typeof createWindowsNativeExchange>;parent:ReturnType<typeof NativeRemoteController.windows>;gateway:ReturnType<typeof NativeRemoteDatabaseGateway.costed>};
  const parents:Parent[]=[];
  function createParent():Parent{
    const exchange=createWindowsNativeExchange({resolveCoordinator,transport,bounds,memory:exchangeMemory});
    const parent=NativeRemoteController.windows({profile:syntheticProfile,limits:remoteLimits,client:{exchange:async(request,job)=>{try{await options.beforeExchange?.(request);const response=await exchange.client.exchange(request,job);await options.afterExchange?.(request,response);diagnostics.push({boundary:'WIRE',command:request.control.command,includeRaw:request.control.command==='QUERY'?request.control.includeRawResult:false,snapshot:response.control.snapshot});return response;}catch(error){const fault=error as {code?:string;message?:string};diagnostics.push({boundary:'WIRE_ERROR',command:request.control.command,code:fault.code,message:fault.message});throw error;}},shutdown:()=>exchange.client.shutdown()},windows:{version:2}});
    const gateway=NativeRemoteDatabaseGateway.costed({db:f.worker,controller:parent,io:parentIo,capacity,costs:prepared.costs,components:prepared.components});
    const value={exchange,parent,gateway};parents.push(value);return value;
  }
  const first=createParent();
  return {...prepared,capacity,...first,objects,memory,exchangeMemory,virtual,transport,createParent,diagnostics,get hosts(){return [...hosts.values()];},get controller(){return controller;},get coordinator(){return coordinator;},close:async()=>{
    for(const value of parents){value.gateway.stopClaims();await value.gateway.idle();}if(coordinator){coordinator.stopClaims();await coordinator.idle();}else if(controller){controller.stopClaims();await controller.idle();}diagnostics.push({boundary:'JOURNAL_CLOSE',beforeAvailable:memory.available(),maximum:memory.maxBytes});await ownedJournal?.close();diagnostics.push({boundary:'JOURNAL_CLOSED',afterAvailable:memory.available(),maximum:memory.maxBytes});
    expect(exchangeMemory.available()).toBe(exchangeMemory.maxBytes);for(const host of hosts.values()){expect(host.failures).toEqual([]);expect(host.captures).toHaveLength(1);expect(host.joins).toBe(1);expect(host.receivedParentAcks).toHaveLength(1);expect(host.finalized?.handles).toBe('CLOSED');}f.controllerDb.decision=originalDecision;
  }};
}

export async function createW4CWindowsExecutionFixture(options:{useRuntime?:boolean;expectFinalSelfOperationMissing?:boolean}={}){
  const f=await windowsNativeFixture(),restores:(()=>void)[]=[],events:string[]=[];
  let remote:Awaited<ReturnType<typeof createW4CWindowsRemoteFixture>>|undefined,cost:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCost|undefined;
  let runtime:ReturnType<typeof import('../../apps/api/src/runtime.js').createWorkerRuntime>|undefined;
  async function closeOwned(){
    const failures:unknown[]=[];let ownerClosed=false;
    try{runtime?.stopClaims();}catch(error){failures.push(error);}
    try{await runtime?.idle();}catch(error){failures.push(error);}
    try{await cost?.idle();}catch(error){failures.push(error);}
    try{await remote?.close();}catch(error){failures.push(error);}
    for(const restore of restores.reverse()){try{restore();}catch(error){failures.push(error);}}
    try{await f.close();ownerClosed=true;}catch(error){failures.push(error);}
    if(remote){
      console.info(JSON.stringify({w4cE3메모리종료:{ownerClosed,available:remote.memory.available(),maximum:remote.memory.maxBytes}}));
      try{expect(ownerClosed).toBe(true);expect(remote.memory.available()).toBe(remote.memory.maxBytes);}catch(error){failures.push(error);}
    }
    if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'E3 owner 종료와 메모리 확인 오류');
  }
  try{
    const {normalizeObservation}=await import('../../packages/domain/src/provider.js');
    const {validateEditData}=await import('../../packages/domain/src/scope.js');
    const {nativeExecutionCaptureDigest}=await import('../../packages/domain/src/native-execution-wait.js');
    const {FullStageCostPreparation}=await import('../../packages/domain/src/full-stage-cost-preparation.js');
    const {FullStageCostJournal}=await import('../../packages/domain/src/full-stage-cost-journal.js');
    const {CheckpointValidationJournal,checkpointValidationVersion}=await import('../../packages/domain/src/checkpoint-validation.js');
    const {OperationalStageCost}=await import('../../packages/domain/src/pipeline-stage-cost.js');
    const {WindowsStageCostReader,windowsStageCostBounds}=await import('../../packages/domain/src/windows-stage-cost-reader.js');
    const {nativeTaskVersion}=await import('../../packages/native/src/dto.js');
    const now=(await f.admin.pool.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0].now;
    const profile:OwnedExecutionLimitProfile={kind:'OWNED_FIXTURE',version:syntheticProfile.id,maxSlots:2,requestLimitUsd:'10',dailyLimitUsd:'100',fullBoundUsd:'10',stages:{OCR:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:w4c/ocr']},TYPESET:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:w4c/typeset']}},fullBoundEvidenceRefs:['owned-fixture:w4c/full'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-3600000).toISOString(),endAt:new Date(now.valueOf()+23*3600000).toISOString()}};
    const profileId=randomUUID(),registered=(await f.operator.client.query<{profile_digest:string}>("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest",[profileId,JSON.stringify(profile),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),profile.window!.kind,profile.window!.startAt,profile.window!.endAt])).rows[0];
    await f.operator.client.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[profileId]);
    Object.assign(f.requestPolicy,{stageOrder:['OCR','TYPESET'],parameterProfileVersion:profile.version,executionLimit:{kind:'OWNED_FIXTURE',profileId,profileDigest:registered.profile_digest,profileVersion:profile.version}});
    const originalBytes=Buffer.from(ownedNativePng,'base64');
    expect(originalBytes.readUInt32BE(33)).toBe(9);expect(originalBytes.toString('ascii',37,41)).toBe('pHYs');
    // 보조 청크만 제거하므로 같은 픽셀의 유효한 다른 PNG 인코딩이다.
    const renderBytes=Buffer.concat([originalBytes.subarray(0,33),originalBytes.subarray(54)]);expect(sha256(renderBytes)).not.toBe(sha256(originalBytes));
    const initial=(await f.admin.pool.query<{original_asset_id:string;result_id:string}>('SELECT original_asset_id,result_id FROM manga_web.results WHERE account_id=$1',[f.seed.accountId])).rows;expect(initial).toHaveLength(1);
    const originalAssetId=initial[0].original_asset_id,renderAssetId=randomUUID();
    for(const [assetId,bytes] of [[originalAssetId,originalBytes],[renderAssetId,renderBytes]] as const){
      const key=f.seed.accountId+'/'+assetId;await f.files.put(key,bytes);expect(await f.files.read(key)).toEqual(bytes);
      if(assetId===originalAssetId)await f.admin.pool.query("UPDATE manga_web.assets SET bucket_ref=$3,object_key=$4,sha256=$5,bytes_length=$6,object_created_at=clock_timestamp(),verified_at=clock_timestamp() WHERE account_id=$1 AND asset_id=$2",[f.seed.accountId,assetId,f.files.bucket,key,sha256(bytes),String(bytes.length)]);
      else await f.admin.pool.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,verified_at) VALUES($1,$2,'LIVE',$3,$4,$5,$6,'image/png','NOT_DUE',$7,clock_timestamp(),clock_timestamp())",[f.seed.accountId,assetId,f.files.bucket,key,sha256(bytes),String(bytes.length),f.seed.contextId]);
    }
    await f.admin.pool.query('UPDATE manga_web.workspace_pages SET image_width=1,image_height=1 WHERE account_id=$1',[f.seed.accountId]);
    await f.admin.pool.query("UPDATE manga_web.results SET render_asset_id=$2,edit_data=jsonb_set(edit_data,'{renderSpecification}',$3::jsonb) WHERE account_id=$1 AND result_id=$4",[f.seed.accountId,renderAssetId,JSON.stringify({version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[]}),initial[0].result_id]);
    const initialData=(await f.admin.pool.query<{edit_data:StageInput['initialData']}>('SELECT edit_data FROM manga_web.results WHERE account_id=$1 AND result_id=$2',[f.seed.accountId,initial[0].result_id])).rows[0].edit_data;
    try{validateEditData(initialData,1,1);console.info(JSON.stringify({w4cE3초기계약:{state:'VALID',blocks:initialData.blocks.length,renderBlocks:initialData.renderSpecification?.blocks.length??null}}));}catch(error){console.info(JSON.stringify({w4cE3원오류:{phase:'INITIAL_EDIT_DATA',fault:w4cDiagnosticFault(error)}}));throw error;}
    remote=await createW4CWindowsRemoteFixture(f);const ownedRemote=remote,costs=remote.costs;
    const costProfile=digest({fixture:'w4c',version:1}),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'TYPESET',profileDigest:costProfile,basisVersion:'w4c-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-fixture:w4c/basis'],components:[{componentId:'native-image',kind:'IMAGE',unit:'windows-job-cpu-second-v1',rateVersion:'w4c-native-v1',usdPerUnit:'0.001',evidenceRefs:['owned-fixture:w4c/native-rate']},{componentId:'semantic',kind:'RENDER',unit:'event',rateVersion:'w4c-semantic-v1',usdPerUnit:'0.001',evidenceRefs:['owned-fixture:w4c/semantic-rate']}]};
    const calculator={maxInputBytes:131072,maxOutputBytes:1048576,maxComponents:64,maxEvidenceRefs:2046,maxStringBytes:4096},journal=new FullStageCostJournal(f.worker,{maxRecordBytes:1048576,maxRecords:64,calculator});
    const preparation=new FullStageCostPreparation(journal,[{stage:'OCR',profileDigest:costProfile,snapshot:{...snapshot,stage:'OCR',components:snapshot.components.filter(c=>c.componentId==='native-image')}},{stage:'TYPESET',profileDigest:costProfile,snapshot}],calculator);
    const checkpoints=new CheckpointValidationJournal(f.worker,{maxRecordBytes:1048576,maxRecords:512,maxTargets:64,maxJobs:64});
    type Saved={evidence_id:string;execution_id:string;kind:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:{version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};received_at:Date};
    const ref=(row:Saved):B3CRef=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest});
    async function records(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,kinds:string[]):Promise<Saved[]>{
      const rows=(await tx.client.query<Saved>('SELECT evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind=ANY($3::text[]) ORDER BY received_at,evidence_id LIMIT 2047',[f.seed.accountId,current.executionId,kinds])).rows;expect(rows.length).toBeLessThanOrEqual(2046);
      for(const row of rows){expect(row.protected_evidence_ref).toBe(row.evidence_id);expect(digest(row.protected_observation)).toBe(row.evidence_digest);expect(row.protected_observation).toMatchObject({version:1,accountId:f.seed.accountId,executionId:current.executionId,inputDigest:current.inputDigest,inputFingerprint:digest(canonicalInput(current))});expect(Object.keys(row.protected_observation)).toHaveLength(7);}return rows;
    }
    async function putOriginal(current:StageInput,kind:string,value:unknown):Promise<B3CRef>{
      const body={version:1,accountId:f.seed.accountId,executionId:current.executionId,inputDigest:current.inputDigest,inputFingerprint:digest(canonicalInput(current)),kind,value},evidenceId=randomUUID(),evidenceDigest=digest(body);
      await f.worker.accountTransaction(f.seed.accountId,tx=>tx.client.query('INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,protected_observation,received_at) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7)',[f.seed.accountId,evidenceId,current.executionId,kind,evidenceDigest,JSON.stringify(body),tx.now]),true);return {evidenceId,evidenceDigest};
    }
    const inputs:StageInput[]=[],claims=new Map<string,Claim>(),observed=new Map<string,import('../../packages/domain/src/provider.js').Observation>(),views:{input:StageInput;view:B3CView}[]=[],operations:{input:StageInput;operation:B3COperation;ref:B3CRef}[]=[],preSnapshots:Saved[][]=[];
    const contexts=new WeakMap<import('../../packages/native/src/facade.js').NativeFacade,{target:NativeTarget;owner:WindowsNativeCostOwner;phase:import('../../packages/domain/src/native-execution-wait.js').NativeExecutionPhase;targetDigest:string|null}>();
    let forOwnerSpyHits=0,contextSeamHits=0;const forOwner=ownedRemote.gateway.forCostOwner.bind(ownedRemote.gateway),contextSpy=vi.spyOn(ownedRemote.gateway,'forCostOwner').mockImplementation((target,owner,phase,targetDigest)=>{forOwnerSpyHits++;const native=forOwner(target,owner,phase,targetDigest);contexts.set(native,{target,owner,phase,targetDigest});return native;});restores.push(()=>contextSpy.mockRestore());
    async function checkpointFactsIn(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,attempt:B3CAttempt){return {attemptId:attempt.attemptId,operations:(await records(tx,current,['CHECKPOINT_VALIDATION_OPERATION'])).filter(row=>(row.protected_observation.value as B3COperation).attemptId===attempt.attemptId).map(ref)};}
    const validationDiagnostics:Record<string,unknown>[]=[];
    async function validateObservation(sourceInput:StageInput,observation:import('../../packages/domain/src/provider.js').Observation,context?:import('../../packages/domain/src/provider.js').ProviderCallContext){
      const captured=context?.native?contexts.get(context.native):undefined;
      const diagnostic:Record<string,unknown>={단계:sourceInput.stage,phase:captured?.phase??null,nativePresent:!!context?.native,contextMapHas:!!captured,forOwnerSpyHits,contextSeamHits,rawOutcome:observation.outcome,rawFinishReason:observation.finishReason,rawStageOutput:!!observation.stageOutput};validationDiagnostics.push(diagnostic);
      expect(context?.native).toBeDefined();expect(captured).toBeDefined();
      let normalized:import('../../packages/domain/src/provider.js').Observation;
      try{normalized=normalizeObservation(sourceInput,observation);}catch(error){diagnostic.정규화오류=w4cDiagnosticFault(error);throw error;}
      diagnostic.normalizedOutcome=normalized.outcome;diagnostic.normalizedFinishReason=normalized.finishReason;diagnostic.proposalGuard={dataPresent:normalized.data!==null,stageOutputPresent:!!normalized.stageOutput,envelopeExecutionMatches:normalized.stageOutput?.executionId===sourceInput.executionId,envelopeInputMatches:normalized.stageOutput?.inputDigest===sourceInput.inputDigest,renderAssetDeclared:normalized.assetDependencies?.some(value=>value.assetId===normalized.renderAssetId)??false,renderSpecificationPresent:normalized.data?.renderSpecification?.version===1,fullRawDigestMatches:digest(normalized)===digest(observation)};
      if(captured!.phase==='VALIDATION'){
        events.push('VALIDATION:'+sourceInput.stage);
        expect(normalized).toMatchObject({outcome:'SUCCESS',started:true,costUsd:'0.01',usageConfirmed:true,finishReason:'SYNTHETIC_SUCCESS',renderAssetId});expect(normalized.data).not.toBeNull();expect(normalized.data!.blocks.length).toBeGreaterThan(0);expect(normalized.assetDependencies).toEqual(sourceInput.assetDependencies);
        expect(normalized.stageOutput).toMatchObject({executionId:sourceInput.executionId,inputDigest:sourceInput.inputDigest,stageContract:sourceInput.settings.contractVersion,outcome:'CONFIRMED_SUCCESS'});
        if(sourceInput.stage==='TYPESET')expect(normalized.data).toEqual(sourceInput.previousData??sourceInput.initialData);
        diagnostic.상태='일반 검증 반환';events.push('VALIDATION_RETURNED:'+sourceInput.stage);return;
      }
      expect(captured!.phase).toBe('CHECKPOINT');expect(digest(normalized)).toBe(digest(observation));const current=inputs.find(value=>value.executionId===captured!.owner.executionId);expect(current).toBeDefined();
      const attemptRows=await f.worker.accountTransaction(f.seed.accountId,tx=>records(tx,current!,['CHECKPOINT_VALIDATION_ATTEMPT']),true),saved=attemptRows.filter(row=>row.evidence_id===captured!.owner.validationAttemptRef?.evidenceId);expect(saved).toHaveLength(1);
      expect(ref(saved[0])).toEqual(captured!.owner.validationAttemptRef);const attempt=saved[0].protected_observation.value as B3CAttempt,target=attempt.targets.find(value=>digest(value)===captured!.targetDigest);expect(target).toBeDefined();
      expect(target!.sourceExecutionId).toBe(sourceInput.executionId);expect(target!.outputDigest).toBe(digest(observation));events.push(attempt.purpose+':'+sourceInput.stage);
      let native:NativeSealedReceiptV2[]=[];
      if(sourceInput.executionId!==current!.executionId){
        expect(await context!.native.decodeImage(renderBytes,syntheticProfile)).toMatchObject({width:1,height:1});
        const cache=(await f.admin.pool.query("SELECT cu.protected_source FROM manga_web.windows_native_cost_cache_uses cu JOIN manga_web.windows_native_cost_calls cc USING(account_id,call_id) JOIN manga_web.windows_native_cost_scopes sc USING(account_id,scope_id) WHERE cu.account_id=$1 AND cc.execution_id=$2 AND sc.protected_scope->'owner'->'validationAttemptRef'=$3::jsonb AND sc.protected_scope->>'validationTargetDigest'=$4",[f.seed.accountId,current!.executionId,JSON.stringify(ref(saved[0])),digest(target)])).rows;
        if(attempt.purpose==='FINAL_COMMIT'){expect(cache).toHaveLength(1);native=[cache[0].protected_source as NativeSealedReceiptV2];}
        else{
          expect(cache).toEqual([]);const fresh=(await f.admin.pool.query("SELECT c.protected_candidate candidate,r.protected_receipt receipt,i.protected_intent intent,o.protected_observation->'termination' termination FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id) JOIN manga_web.native_job_intents i USING(account_id,job_id) JOIN manga_web.native_job_observations o ON o.account_id=c.account_id AND o.job_id=c.job_id AND o.event='TERMINATION' WHERE c.account_id=$1 AND i.protected_intent->>'targetId'=$2",[f.seed.accountId,current!.requestId])).rows;expect(fresh).toHaveLength(1);
          const {isolation:_isolation,...termination}=fresh[0].termination;native=[{candidate:fresh[0].candidate,receipt:fresh[0].receipt,intent:fresh[0].intent,termination,origin:'FRESH'}];
        }
      }
      const owner=captured!.owner,operationId=randomUUID(),eventId=randomUUID(),scope=await f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginScopeIn(tx,owner,captured!.target,'CHECKPOINT',digest(target),randomUUID()),true);expect(scope).not.toBeNull();
      const callBody={version:1 as const,callId:randomUUID(),scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:nativeTaskVersion,profileDigest:f.profile.nativeProfileDigest,kernelDigest:f.profile.kernelDigest,operationInputDigest:sha256('W4C 실제 의존 자산 읽기 '+operationId),componentId:'native-image'},call={...callBody,callDigest:digest(callBody)};
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.registerCallIn(tx,scope!,call),true)).toEqual(call);
      const io=createWindowsCostedObjectIo({objects:ownedRemote.objects,maxBytes:1048576,begin:r=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.beginIoIn(tx,r),true),end:e=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.endIoIn(tx,e),true),lookup:r=>f.worker.accountTransaction(f.seed.accountId,tx=>costs.lookupIoIn(tx,r),true)});
      const storage:B3COperation['storage']=[],ends:B3CRef[]=[];
      for(const asset of target!.assets){const read=await io.read({version:1,operationId:randomUUID(),eventId:randomUUID(),call:{callId:call.callId,callDigest:call.callDigest},kind:'OBJECT_READ',key:asset.objectKey,expected:{sha256:asset.sha256,bytesLength:asset.bytesLength}});expect(read.state).toBe('RETURNED');if(read.state!=='RETURNED')throw Error('W4C 실제 자산 읽기 미완료');expect(sha256(read.value)).toBe(asset.sha256);expect(String(read.value.length)).toBe(asset.bytesLength);expect(read.event.ended).not.toBeNull();ends.push(read.event.ended!);storage.push({eventId:read.event.eventId,kind:'OBJECT_READ',assetId:asset.assetId,sha256:sha256(read.value),bytesLength:String(read.value.length),outcome:'RETURNED'});}
      expect(await f.worker.accountTransaction(f.seed.accountId,tx=>costs.joinScopeIn(tx,scope!,{version:1,scopeId:scope!.scopeId,scopeDigest:scope!.scopeDigest,eventId:randomUUID(),outcome:'RETURNED',terminalEvidence:ends}),true)).toBe('JOINED');
      const operation:B3COperation={version:1,operationId,attemptId:attempt.attemptId,attemptDigest:attempt.attemptDigest,validationVersion:checkpointValidationVersion,targetDigest:digest(target),sourceInputFingerprint:target!.inputFingerprint,outputDigest:target!.outputDigest,semantic:{eventId,kind:'SEMANTIC_VALIDATION',outcome:'RETURNED'},storage,native};
      const operationRef=await putOriginal(current!,'CHECKPOINT_VALIDATION_OPERATION',operation);operations.push({input:structuredClone(current!),operation:structuredClone(operation),ref:operationRef});
    }
    const record=checkpoints.recordIn.bind(checkpoints),recordSpy=vi.spyOn(checkpoints,'recordIn').mockImplementation(async(...args)=>{const view=await record(...args);views.push({input:structuredClone(args[1]),view:structuredClone(view)});events.push(args[1].stage+':'+args[2].purpose+'_'+view.state);if(args[1].stage==='TYPESET'&&view.state==='VERIFIED'){const pre=await records(args[0],args[1],['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_VERIFIED']),preAttempt=pre.find(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&(row.protected_observation.value as B3CAttempt).purpose==='PRE_DISPATCH');expect(preAttempt).toBeDefined();const id=(preAttempt!.protected_observation.value as B3CAttempt).attemptId;preSnapshots.push(structuredClone(pre.filter(row=>(row.protected_observation.value as {attemptId:string}).attemptId===id)));}return view;});restores.push(()=>recordSpy.mockRestore());
    const sourcePrepared=new Set<string>();
    async function prepareSources(current:StageInput){
      if(sourcePrepared.has(current.executionId))return;
      const emitted=observed.get(current.executionId);if(!emitted)return;
      const outcomes=(await f.admin.pool.query<{protected_observation:import('../../packages/domain/src/provider.js').Observation}>("SELECT protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME'",[f.seed.accountId,current.executionId])).rows;
      if(outcomes.length!==1||outcomes[0].protected_observation.outcome!=='SUCCESS')return;
      const actual=outcomes[0].protected_observation;expect(actual.evidenceId).toBe(emitted.evidenceId);expect(actual.costUsd).toBe('0.01');expect(actual.usageConfirmed).toBe(true);expect(actual.started).toBe(true);
      const basis=(await journal.lookup(current)).basis;expect(basis).not.toBeNull();const saved=await f.worker.accountTransaction(f.seed.accountId,tx=>records(tx,current,['CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED']),true),ops=saved.filter(row=>row.kind==='CHECKPOINT_VALIDATION_OPERATION');
      if(current.stage==='TYPESET'&&options.expectFinalSelfOperationMissing){
        const final=saved.filter(row=>row.kind==='CHECKPOINT_VALIDATION_ATTEMPT'&&(row.protected_observation.value as B3CAttempt).purpose==='FINAL_COMMIT');expect(final).toHaveLength(1);
        const attempt=final[0].protected_observation.value as B3CAttempt;expect(attempt.targets).toHaveLength(2);expect(attempt.targets.at(-1)?.sourceExecutionId).toBe(current.executionId);
        expect(ops).toHaveLength(3);expect(ops.filter(row=>(row.protected_observation.value as B3COperation).attemptId===attempt.attemptId)).toHaveLength(1);
        expect(views.filter(item=>item.input.executionId===current.executionId&&item.view.attempt?.purpose==='PRE_DISPATCH').at(-1)?.view.state).toBe('VERIFIED');
        expect(await f.worker.accountTransaction(f.seed.accountId,tx=>checkpoints.lookupIn(tx,current,'FINAL_COMMIT'),true)).toMatchObject({state:'WAIT'});
      }else if(current.stage==='TYPESET')expect(views.filter(item=>item.input.executionId===current.executionId&&item.view.attempt?.purpose==='FINAL_COMMIT').at(-1)?.view.state).toBe('VERIFIED');
      const io=(await f.admin.pool.query<{protected_event:WindowsCostedIoEvent}>('SELECT en.protected_event FROM manga_web.windows_native_cost_io_starts st JOIN manga_web.windows_native_cost_io_ends en USING(account_id,operation_id) WHERE st.account_id=$1 AND st.execution_id=$2 ORDER BY st.operation_id',[f.seed.accountId,current.executionId])).rows;
      const starts=(await f.admin.pool.query<{n:number}>('SELECT count(*)::integer n FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,current.executionId])).rows[0].n;expect(io).toHaveLength(starts);for(const {protected_event:event} of io){expect(event.ended).not.toBeNull();expect(event.state).toBe('RETURNED');}
      const provider={scope:'ACTUAL_AI_USD' as const,captureDigest:basis!.captureDigest,state:'CONFIRMED' as const,actualUsd:actual.costUsd},allocation={captureDigest:basis!.captureDigest,mode:basis!.capture.mode,funding:'FREE_OPERATIONS' as const,basisVersion:basis!.snapshot!.basisVersion,state:'CONFIRMED' as const,actualUsd:'0'},semantic={componentId:'semantic',captureDigest:basis!.captureDigest,state:'CONFIRMED' as const,quantity:String(ops.length),unit:'event'};
      const entries=[{operationId:current.executionId,eventId:actual.evidenceId,fact:provider},{operationId:randomUUID(),eventId:randomUUID(),fact:allocation},...io.map(({protected_event:v})=>({operationId:v.operationId,eventId:v.eventId,fact:provider,io:v})),...ops.map(row=>{const op=row.protected_observation.value as B3COperation;return {operationId:op.operationId,eventId:op.semantic.eventId,fact:semantic};})];
      for(const entry of entries){await putOriginal(current,'WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE',{version:1,...entry});await putOriginal(current,'WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION',{version:1,operations:[{operationId:entry.operationId,eventId:entry.eventId,outcome:'RETURNED'}]});}
      sourcePrepared.add(current.executionId);events.push(current.stage+':ORIGINAL_SOURCES_READY');
    }
    async function nonWindowsIn(tx:import('../../packages/storage/src/database.js').Transaction,current:StageInput,basis:import('../../packages/domain/src/full-stage-cost-journal.js').FullStageCostBasis):Promise<import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet|null>{
      const saved=await records(tx,current,['WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE','WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION','CHECKPOINT_VALIDATION_OPERATION','CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED']);
      const rawSources=saved.filter(r=>r.protected_observation.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_SOURCE');if(!rawSources.length)return null;
      type Facts=import('../../packages/domain/src/full-stage-cost.js').FullStageCostFacts;
      type Provider=Omit<NonNullable<Facts['provider']>,'evidenceRefs'>;type Allocation=Omit<NonNullable<Facts['allocation']>,'evidenceRefs'>;type Quantity=Omit<NonNullable<Facts['quantities']>[number],'evidenceRefs'>;
      let provider:Provider|undefined,allocation:Allocation|undefined,semantic:Quantity|undefined,firstSemantic=true;
      const sources:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet['sources']=[],terminationEvidence:B3CRef[]=[];
      const extra=saved.filter(r=>['CHECKPOINT_VALIDATION_ATTEMPT','CHECKPOINT_VALIDATION_VERIFIED'].includes(r.protected_observation.kind)).map(ref);
      for(const row of rawSources){
        const v=row.protected_observation.value as {operationId:string;eventId:string;fact:Provider|Allocation|Quantity;io?:WindowsCostedIoEvent};
        let target:'PROVIDER'|'ALLOCATION'|'QUANTITY',componentId:string|null=null;const evidence=[ref(row)];
        if('scope' in v.fact){target='PROVIDER';if(provider)expect(digest(provider)).toBe(digest(v.fact));provider=v.fact;}
        else if('funding' in v.fact){target='ALLOCATION';if(allocation)expect(digest(allocation)).toBe(digest(v.fact));allocation=v.fact;}
        else{target='QUANTITY';componentId=v.fact.componentId;if(semantic)expect(digest(semantic)).toBe(digest(v.fact));semantic=v.fact;
          const op=saved.filter(r=>r.protected_observation.kind==='CHECKPOINT_VALIDATION_OPERATION'&&(r.protected_observation.value as B3COperation).operationId===v.operationId&&(r.protected_observation.value as B3COperation).semantic.eventId===v.eventId);expect(op).toHaveLength(1);evidence.push(ref(op[0]));if(firstSemantic){evidence.push(...extra);firstSemantic=false;}
        }
        sources.push({sourceOperationId:v.operationId,sourceEventId:v.eventId,target,componentId,evidence});
        const ends=saved.filter(r=>r.protected_observation.kind==='WINDOWS_STAGE_COST_NON_WINDOWS_TERMINATION'&&(r.protected_observation.value as {operations:{operationId:string;eventId:string;outcome:string}[]}).operations.some(o=>o.operationId===v.operationId&&o.eventId===v.eventId&&o.outcome==='RETURNED'));expect(ends).toHaveLength(1);terminationEvidence.push(ref(ends[0]));
      }
      if(!provider||!allocation||basis.snapshot?.components.some(c=>c.componentId==='semantic')&&!semantic)return null;
      const outcomes=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_observation:unknown}>("SELECT evidence_id,evidence_digest,protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='OUTCOME' ORDER BY evidence_id LIMIT 2",[f.seed.accountId,current.executionId])).rows;expect(outcomes).toHaveLength(1);expect(digest(outcomes[0].protected_observation)).toBe(outcomes[0].evidence_digest);terminationEvidence.push({evidenceId:outcomes[0].evidence_id,evidenceDigest:outcomes[0].evidence_digest});
      const refs=(target:string)=>sources.filter(s=>s.target===target).flatMap(s=>s.evidence.map(r=>r.evidenceId)).sort();
      expect(provider.captureDigest).toBe(basis.captureDigest);
      return {version:1,executionId:current.executionId,inputFingerprint:digest(canonicalInput(current)),captureDigest:basis.captureDigest,completion:'EXECUTION',joinedEvidence:sources.flatMap(s=>s.evidence),terminationEvidence,sources,facts:{provider:{...provider,evidenceRefs:refs('PROVIDER')},allocation:{...allocation,evidenceRefs:refs('ALLOCATION')},quantities:semantic?[{...semantic,evidenceRefs:refs('QUANTITY')}]:[]}};
    }
    const reader=new WindowsStageCostReader({db:f.worker,windows:costs,nonWindows:{nonWindowsIn,checkpointFactsIn},bounds:{...windowsStageCostBounds}});
    cost=OperationalStageCost.windows({db:f.worker,preparation,journal,reader,checkpoints,bounds:{maxRecordBytes:1048576,maxRecords:2046,maxSources:2046,maxExecutions:64,maxInFlight:4}});const operationalCost=cost;
    const good=new SyntheticProvider(),synthetic=new SyntheticProvider(current=>{const raw=good.success(current);if(current.stage==='TYPESET')raw.data=structuredClone(current.previousData??current.initialData);return {...raw,renderAssetId,assetDependencies:structuredClone(current.assetDependencies??[])};});
    const provider:import('../../packages/domain/src/provider.js').ProviderAdapter={synthetic:true,validateObservation,validateInput:async(current,context)=>{events.push('VALIDATE_INPUT:'+current.stage);expect(context?.native).toBeDefined();if(current.stage==='OCR'){events.push('INPUT_NATIVE_BEGIN:'+current.stage);try{expect(await context!.native.decodeImage(originalBytes,syntheticProfile)).toMatchObject({width:1,height:1});events.push('INPUT_NATIVE_RETURNED:'+current.stage);}catch(error){events.push('INPUT_NATIVE_THROW:'+current.stage);throw error;}}events.push('VALIDATE_INPUT_RETURNED:'+current.stage);},dispatch:async(current,started)=>{events.push('DISPATCH:'+current.stage);const result=await synthetic.dispatch(current,async id=>{await started(id);events.push('START:'+current.stage);});try{const normalized=normalizeObservation(current,result);events.push('RAW_NORMALIZE_RETURNED:'+current.stage);console.info(JSON.stringify({w4cE3원정규화:{stage:current.stage,rawOutcome:result.outcome,rawFinishReason:result.finishReason,rawStageOutput:!!result.stageOutput,outcome:normalized.outcome,finishReason:normalized.finishReason}}));}catch(error){console.info(JSON.stringify({w4cE3원오류:{phase:'DISPATCH_RAW_NORMALIZE',stage:current.stage,fault:w4cDiagnosticFault(error)}}));throw error;}observed.set(current.executionId,structuredClone(result));return result;},lookup:id=>synthetic.lookup(id)};
    // 합성 검사의 별도 operator 연결만 원 proof를 등록한다. 물리 slot은 해제하지 않는다.
    const {WindowsNativeCapacityOperator,validateWindowsNativeCostOwner}=await import('../../packages/domain/src/windows-native-cost.js');
    const operator=new WindowsNativeCapacityOperator(f.operator.client,f.operator.name);
    const confirmedProofs:{input:StageInput;key:import('../../packages/domain/src/native-receipts.js').WindowsNativeOriginalKey;proofId:string}[]=[];
    async function confirmPreparedWindows(current:StageInput){
      events.push('AFTER_PREPARE:'+current.stage);
      const keys=(await f.admin.pool.query<{binding:NativeControllerBinding;expected:import('../../packages/native/src/dto.js').WindowsEvidenceRef}>("SELECT a.protected_binding binding,jsonb_build_object('recordId',r.record_id,'recordDigest',r.digest,'linkId',l.link_id,'linkDigest',l.digest) expected FROM manga_web.windows_native_cost_bindings b JOIN manga_web.native_controller_attempts a USING(account_id,job_id) JOIN manga_web.windows_native_records r ON r.account_id=a.account_id AND r.attempt_id=a.attempt_id AND r.purpose='SEAL' JOIN manga_web.windows_native_links l ON l.account_id=a.account_id AND l.attempt_id=a.attempt_id WHERE b.account_id=$1 AND b.execution_id=$2 ORDER BY a.job_id",[f.seed.accountId,current.executionId])).rows;
      expect(keys).toHaveLength(1);const key=keys[0];
      const before=(await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,key.binding.capacityReservationId])).rows;expect(before).toEqual([{state:'HELD',released_at:null,release_proof_id:null,windows_release_proof_id:null}]);
      const proof=await operator.confirmWindows(key);expect(proof).toMatchObject({allowed:true,reason:'PROOF_CONFIRMED',capacityReservationId:key.binding.capacityReservationId});expect(proof.proofId).toBeDefined();
      const saved=(await f.admin.pool.query('SELECT proof_id,reservation_id,proof_metadata FROM manga_web.windows_native_termination_proofs WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,key.binding.capacityReservationId])).rows;expect(saved).toHaveLength(1);expect(saved[0].proof_id).toBe(proof.proofId);expect(saved[0].proof_metadata).toMatchObject({binding:key.binding,windowsEvidenceRef:key.expected});
      expect((await f.admin.pool.query('SELECT state,released_at,release_proof_id,windows_release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,key.binding.capacityReservationId])).rows).toEqual(before);
      expect((await f.admin.pool.query('SELECT * FROM manga_web.native_capacity_adoptions WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,key.binding.capacityReservationId])).rows).toEqual([]);
      expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,current.executionId])).rows).toEqual([]);
      confirmedProofs.push({input:structuredClone(current),key:structuredClone(key),proofId:proof.proofId!});events.push('OPERATOR_PROOF_ACK:'+current.stage);
    }
    let activeClaim:Claim|null=null;
    const hooks:ConstructorParameters<typeof ExecutionService>[3]={heartbeatMilliseconds:25,afterPrepare:confirmPreparedWindows,beforeValidateInput:async(current,claim)=>{expect(activeClaim).not.toBeNull();expect(claim).toEqual({generation:activeClaim!.generation,ownerId:service.workerId,workItemId:activeClaim!.workId});inputs.push(structuredClone(current));claims.set(current.executionId,activeClaim!);events.push('ROOT_ACK:'+current.stage);}};
    let service:ExecutionService;
    if(options.useRuntime){
      const {createWorkerRuntime}=await import('../../apps/api/src/runtime.js');
      runtime=createWorkerRuntime({worker:f.worker,objects:f.files,fonts:{catalog:{version:'w4c-fixed-font',fonts:[]},bytes:new Map()} as unknown as import('../../packages/media/src/fonts.js').FontCatalog,profile:syntheticProfile,policy:f.requestPolicy,provider,workerNative:ownedRemote.gateway,workerOperationalCost:cost,workerExecutionHooks:hooks});service=runtime.execution;expect(runtime.execution).toBe(service);
      // 원 runtime의 합성 media 포트는 같은 검사 adapter로 전달한다. 원 반환값은 유지한다.
      const runtimeProvider=service.provider;
      const validateInput=vi.spyOn(runtimeProvider,'validateInput').mockImplementation((...args)=>provider.validateInput!(...args));restores.push(()=>validateInput.mockRestore());
      const validateObservation=vi.spyOn(runtimeProvider,'validateObservation').mockImplementation((...args)=>provider.validateObservation!(...args));restores.push(()=>validateObservation.mockRestore());
      const dispatch=vi.spyOn(runtimeProvider,'dispatch').mockImplementation((...args)=>provider.dispatch(...args));restores.push(()=>dispatch.mockRestore());
      const lookup=vi.spyOn(runtimeProvider,'lookup').mockImplementation((...args)=>provider.lookup(...args));restores.push(()=>lookup.mockRestore());
    }else service=new ExecutionService(f.worker,provider,f.requestPolicy,hooks,ownedRemote.gateway,cost);
    // 제품의 고정 gateway 포트는 보존하고 실제 context 반환에 관측 정보만 연결한다.
    const nativeContext=service.nativeCallContext.bind(service),nativeContextSpy=vi.spyOn(service,'nativeCallContext').mockImplementation(async(...args)=>{
      const context=await nativeContext(...args);if(!context)return context;
      const [claim,sourceInput,phase,requestIdValue,observation,validation]=args,currentRequestId=requestIdValue??sourceInput.requestId,consumer=validation?.consumer??sourceInput;
      const rootRows=(await f.admin.pool.query<{owner_identity:Omit<WindowsNativeCostOwner,'claim'|'validationAttemptRef'>}>('SELECT owner_identity FROM manga_web.windows_native_cost_roots WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,consumer.executionId])).rows;expect(rootRows).toHaveLength(1);expect(Object.keys(rootRows[0].owner_identity)).toHaveLength(4);
      const inputRows=(await f.admin.pool.query<{evidence_id:string}>("SELECT evidence_id FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='INPUT'",[f.seed.accountId,sourceInput.executionId])).rows;expect(inputRows).toHaveLength(1);
      const ownerRows=(await f.admin.pool.query<{owner_body:unknown}>('SELECT owner_body FROM manga_web.windows_stage_cost_owners WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,consumer.executionId])).rows;expect(ownerRows).toHaveLength(1);
      const owner=structuredClone(validateWindowsNativeCostOwner(ownerRows[0].owner_body)),{claim:originalClaim,validationAttemptRef:originalAttempt,...rootIdentity}=owner;
      expect(rootIdentity).toEqual(rootRows[0].owner_identity);expect(originalClaim).toEqual({generation:claim.generation,ownerId:service.workerId,workItemId:claim.workId});expect(originalAttempt).toBeNull();expect(owner.executionId).toBe(consumer.executionId);expect(owner.inputFingerprint).toBe(digest(canonicalInput(consumer)));
      const originalRows=(await f.admin.pool.query<{kind:string;evidence_id:string;evidence_digest:string;protected_observation:unknown}>("SELECT kind,evidence_id,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind",[f.seed.accountId,consumer.executionId])).rows;expect(originalRows).toHaveLength(2);
      const originalInput=originalRows.find(row=>row.kind==='INPUT')!,originalBasis=originalRows.find(row=>row.kind==='OPERATIONAL_COST_BASIS')!;expect(originalInput.evidence_id).toBe(owner.inputEvidenceId);expect(originalInput.evidence_digest).toBe(owner.inputFingerprint);expect(originalInput.protected_observation).toEqual(canonicalInput(consumer));expect(digest(originalInput.protected_observation)).toBe(originalInput.evidence_digest);expect({evidenceId:originalBasis.evidence_id,evidenceDigest:originalBasis.evidence_digest}).toEqual(owner.basisRef);expect(digest(originalBasis.protected_observation)).toBe(originalBasis.evidence_digest);

      let targetDigest:string|null=null,protectedOwner:NativeTarget['protectedOwnerCapture'];
      if(validation){
        const rows=await f.worker.accountTransaction(f.seed.accountId,tx=>records(tx,consumer,['CHECKPOINT_VALIDATION_ATTEMPT']),true),saved=rows.filter(row=>(row.protected_observation.value as B3CAttempt).attemptId===validation.attempt.attemptId);expect(saved).toHaveLength(1);expect(saved[0].protected_observation.value).toEqual(validation.attempt);owner.validationAttemptRef=ref(saved[0]);targetDigest=digest(validation.target);protectedOwner=validation.attempt.owner;
      }else{
        const state=(await f.admin.pool.query('SELECT c.generation,c.owner_session_id,c.owner_tab_id,c.owner_revision,c.workspace_revision FROM manga_web.processing_requests r JOIN manga_web.workspace_contexts c USING(account_id,context_id) WHERE r.account_id=$1 AND r.request_id=$2',[f.seed.accountId,currentRequestId])).rows;expect(state).toHaveLength(1);const captured=state[0];protectedOwner={contextId:sourceInput.contextId!,contextGeneration:captured.generation,ownerSessionId:captured.owner_session_id,ownerTabId:captured.owner_tab_id,ownerRevision:captured.owner_revision,workspaceRevision:captured.workspace_revision};
      }
      const target:NativeTarget={accountId:f.seed.accountId,targetKind:phase==='CHECKPOINT'?'REQUEST_CHECKPOINT':'EXECUTION',targetId:phase==='CHECKPOINT'?currentRequestId:sourceInput.executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,currentRequestId,sourceInput,phase==='CHECKPOINT'?observation:undefined),protectedOwnerCapture:protectedOwner,claim:owner.claim,sourceInput:{executionId:sourceInput.executionId,inputEvidenceId:inputRows[0].evidence_id,stageInputDigest:sourceInput.inputDigest}};
      contexts.set(context.native,{target,owner,phase,targetDigest});contextSeamHits++;return context;
    });restores.push(()=>nativeContextSpy.mockRestore());
    const assetDiagnostics:Record<string,unknown>[]=[],verifyAssets=service.verifyAssets.bind(service),verifyAssetsSpy=vi.spyOn(service,'verifyAssets').mockImplementation(async(...args)=>{
      const diagnostic:Record<string,unknown>={stage:inputs.at(-1)?.stage??'AUTHORIZE',dependencies:args[1].length,required:args[2]?.length??0};assetDiagnostics.push(diagnostic);
      try{await verifyAssets(...args);diagnostic.state='RETURNED';}catch(error){diagnostic.state='THREW';diagnostic.fault=w4cDiagnosticFault(error);console.info(JSON.stringify({w4cE3원오류:{phase:'VERIFY_ASSETS',...diagnostic}}));throw error;}
    });restores.push(()=>verifyAssetsSpy.mockRestore());
    const claimSelections:(Claim|null)[]=[];
    const originalClaim=service.claim.bind(service),claimSpy=vi.spyOn(service,'claim').mockImplementation(async()=>{const claimed=await originalClaim();claimSelections.push(claimed===null?null:structuredClone(claimed));if(claimed?.kind==='DISPATCH')activeClaim=claimed;return claimed;});restores.push(()=>claimSpy.mockRestore());
    const preflight=service.preflight.bind(service),preflightSpy=vi.spyOn(service,'preflight').mockImplementation(async(...args)=>{events.push('PREFLIGHT_BEGIN:'+args[1].stage);try{const result=await preflight(...args);events.push('PREFLIGHT_'+String(result)+':'+args[1].stage);if(result){const current=args[1],proofs=confirmedProofs.filter(value=>value.input.executionId===current.executionId);expect(proofs).toHaveLength(1);const rows=(await f.admin.pool.query('SELECT mode,execution_id,work_item_id,claim_generation,worker_id FROM manga_web.native_capacity_adoptions WHERE account_id=$1 AND reservation_id=$2',[f.seed.accountId,proofs[0].key.binding.capacityReservationId])).rows;expect(rows).toEqual([{mode:'PROMOTE',execution_id:current.executionId,work_item_id:args[0].workId,claim_generation:args[0].generation,worker_id:service.workerId}]);expect((await f.admin.pool.query('SELECT execution_id FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,current.executionId])).rows).toEqual([{execution_id:current.executionId}]);events.push('PERMIT_PROMOTE:'+current.stage);}return result;}catch(error){events.push('PREFLIGHT_THROW:'+args[1].stage);throw error;}});restores.push(()=>preflightSpy.mockRestore());
    const observe=service.observe.bind(service),observeSpy=vi.spyOn(service,'observe').mockImplementation(async(...args)=>{const phase=args[3]?'START':'OUTCOME';events.push('OBSERVE_BEGIN:'+phase);try{await observe(...args);events.push('OBSERVE_RETURNED:'+phase);}catch(error){events.push('OBSERVE_THROW:'+phase);throw error;}});restores.push(()=>observeSpy.mockRestore());

    const finish=operationalCost.finishAttempt.bind(operationalCost),finishSpy=vi.spyOn(operationalCost,'finishAttempt').mockImplementation(async current=>{await prepareSources(current);await finish(current);events.push('COST_ACK:'+current.stage);});restores.push(()=>finishSpy.mockRestore());
    const before=(await f.admin.pool.query<{result_id:string}>('SELECT result_id FROM manga_web.results WHERE account_id=$1 ORDER BY result_id',[f.seed.accountId])).rows;
    const requestId=await f.request();
    async function inspect(){
      const params=[f.seed.accountId,requestId],request=(await f.admin.pool.query('SELECT * FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',params)).rows[0];
      const executions=(await f.admin.pool.query('SELECT * FROM manga_web.executions WHERE account_id=$1 AND request_id=$2 ORDER BY logical_step_id',params)).rows;
      const evidence=(await f.admin.pool.query("SELECT e.* FROM manga_web.execution_evidence e JOIN manga_web.executions x USING(account_id,execution_id) WHERE e.account_id=$1 AND x.request_id=$2 ORDER BY e.received_at,e.evidence_id",params)).rows;
      const checkpointsRows=(await f.admin.pool.query('SELECT c.* FROM manga_web.checkpoints c JOIN manga_web.executions x USING(account_id,execution_id) WHERE c.account_id=$1 AND x.request_id=$2 ORDER BY c.checkpoint_id',params)).rows;
      const financial=(await f.admin.pool.query("SELECT c.execution_id,c.state,c.actual_usd::text stage_usd,c.usage_ref,c.confirmed_at,x.actual_usd::text expense_usd,x.evidence_id,x.evidence_digest FROM manga_web.cost_items c JOIN manga_web.executions e USING(account_id,execution_id) LEFT JOIN manga_web.execution_limit_expenses x USING(account_id,cost_item_id) WHERE c.account_id=$1 AND e.request_id=$2 AND c.component='STAGE_TOTAL' ORDER BY e.logical_step_id",params)).rows;
      const applications=(await f.admin.pool.query('SELECT * FROM manga_web.result_applications WHERE account_id=$1 AND request_id=$2',params)).rows;
      const results=(await f.admin.pool.query('SELECT * FROM manga_web.results WHERE account_id=$1 AND NOT(result_id=ANY($2::uuid[])) ORDER BY result_id',[f.seed.accountId,before.map(row=>row.result_id)])).rows;
      const store=(await f.admin.pool.query("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND kind='STORE' AND target_ref->>'resultId'=ANY($2::text[])",[f.seed.accountId,results.map(row=>row.result_id)])).rows;
      const native=(await f.admin.pool.query('SELECT * FROM manga_web.native_job_intents WHERE account_id=$1 ORDER BY job_id',[f.seed.accountId])).rows;
      const cache=(await f.admin.pool.query('SELECT * FROM manga_web.windows_native_cost_cache_uses WHERE account_id=$1 ORDER BY call_id',[f.seed.accountId])).rows;
      return {request,executions,evidence,checkpoints:checkpointsRows,financial,applications,results,store,native,cache,views:structuredClone(views),operations:structuredClone(operations)};
    }
    // 같은 OCR의 원 RECONCILE 한 건만 허용한다. 원 tick 오류는 그대로 전달한다.
    async function runTypeset():Promise<boolean>;
    async function runTypeset(tick:()=>Promise<void>):Promise<void>;
    async function runTypeset(tick?:()=>Promise<void>):Promise<boolean|void>{
      expect(inputs).toHaveLength(1);const ocr=inputs[0];expect(ocr.stage).toBe('OCR');expect(ocr.requestId).toBe(requestId);
      type QueueWork={work_item_id:string;kind:string;state:string;claim_generation:string;claim_owner:string|null;lease_until:Date|null;target_ref:Record<string,string>};
      const queue=(await f.admin.pool.query<QueueWork>("SELECT * FROM manga_web.work_items WHERE account_id=$1 AND((kind='RECONCILE' AND target_ref=$2::jsonb)OR(kind='DISPATCH' AND target_ref=$3::jsonb)) ORDER BY kind,work_item_id",[f.seed.accountId,JSON.stringify({executionId:ocr.executionId}),JSON.stringify({requestId})])).rows;
      const reconciles=queue.filter(row=>row.kind==='RECONCILE'),dispatches=queue.filter(row=>row.kind==='DISPATCH');expect(reconciles).toHaveLength(1);expect(dispatches).toHaveLength(1);
      const reconcile=reconciles[0],dispatch=dispatches[0];expect(reconcile).toMatchObject({state:'READY',claim_owner:null,lease_until:null});expect(dispatch).toMatchObject({state:'READY',claim_owner:null,lease_until:null});
      async function sourceEffects(){
        const state=await inspect(),params=[f.seed.accountId,ocr.executionId];
        const counts=(await f.admin.pool.query('SELECT (SELECT count(*) FROM manga_web.native_job_observations WHERE account_id=$1) observations,(SELECT count(*) FROM manga_web.native_job_go_consumptions WHERE account_id=$1) go,(SELECT count(*) FROM manga_web.windows_native_cost_scopes WHERE account_id=$1) scopes,(SELECT count(*) FROM manga_web.windows_native_cost_calls WHERE account_id=$1) calls,(SELECT count(*) FROM manga_web.windows_native_cost_io_starts WHERE account_id=$1) starts,(SELECT count(*) FROM manga_web.windows_native_cost_io_ends WHERE account_id=$1) ends',[f.seed.accountId])).rows;
        const money=(await f.admin.pool.query('SELECT * FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',params)).rows,expenses=(await f.admin.pool.query('SELECT x.* FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) WHERE c.account_id=$1 AND c.execution_id=$2 ORDER BY x.cost_item_id',params)).rows;
        const owners=(await f.admin.pool.query('SELECT owner_body,owner_capture FROM manga_web.windows_stage_cost_owners WHERE account_id=$1 AND execution_id=$2',params)).rows;
        return {financial:state.financial,evidence:state.evidence.filter(row=>row.execution_id===ocr.executionId),native:state.native,cache:state.cache,counts,money,expenses,owners,objectIo:{...f.objectIo},dispatch:structuredClone(synthetic.calls),lookup:structuredClone(synthetic.lookups),inputs:structuredClone(inputs),claims:structuredClone([...claims]),applications:state.applications,results:state.results,store:state.store};
      }
      const before=await sourceEffects(),offset=claimSelections.length;expect(offset).toBe(1);
      const step=()=>tick?tick():service.runOnce();
      function selected(index:number){expect(claimSelections).toHaveLength(index+1);const claim=claimSelections[index];expect(claim).not.toBeNull();expect(claim!.accountId).toBe(f.seed.accountId);return claim!;}
      async function dispatched(claim:Claim,value:boolean|void){
        if(!tick)expect(value).toBe(true);
        expect(claim).toEqual({accountId:f.seed.accountId,workId:dispatch.work_item_id,generation:(BigInt(dispatch.claim_generation)+1n).toString(),kind:'DISPATCH',ref:{requestId}});
        expect(inputs).toHaveLength(2);const typeset=inputs[1];expect(typeset).toMatchObject({stage:'TYPESET',requestId,claimGeneration:claim.generation});expect(claims.get(typeset.executionId)).toMatchObject(claim);
        const state=await inspect();expect(state.executions.map(row=>[row.logical_step_id,row.state])).toEqual([['OCR','SUCCEEDED'],['TYPESET','SUCCEEDED']]);expect(synthetic.calls.map(value=>value.stage)).toEqual(['OCR','TYPESET']);
      }
      const first=await step(),chosen=selected(offset);
      if(chosen.kind==='DISPATCH'){await dispatched(chosen,first);return first;}
      if(!tick)expect(first).toBe(true);
      expect(chosen).toEqual({accountId:f.seed.accountId,workId:reconcile.work_item_id,generation:(BigInt(reconcile.claim_generation)+1n).toString(),kind:'RECONCILE',ref:{executionId:ocr.executionId}});
      expect(await sourceEffects()).toEqual(before);
      const completed=(await f.admin.pool.query<QueueWork>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,chosen.workId])).rows;expect(completed).toHaveLength(1);expect(completed[0]).toMatchObject({kind:'RECONCILE',state:'DONE',claim_generation:chosen.generation,claim_owner:null,lease_until:null,target_ref:{executionId:ocr.executionId}});
      expect((await f.admin.pool.query<QueueWork>('SELECT * FROM manga_web.work_items WHERE account_id=$1 AND work_item_id=$2',[f.seed.accountId,dispatch.work_item_id])).rows).toEqual([dispatch]);
      events.push('OCR_RECONCILE_QUEUE_TICK');
      const second=await step();await dispatched(selected(offset+1),second);return second;
    }

    async function diagnose(phase:string){
      const params=[f.seed.accountId,requestId],state=(await f.admin.pool.query('SELECT request_id,state,hold_reasons,captured_stage_order FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',params)).rows;
      const stages=(await f.admin.pool.query('SELECT execution_id,logical_step_id,state,claim_generation,input_digest,safe_error_code,start_confirmed_at,finished_confirmed_at FROM manga_web.executions WHERE account_id=$1 AND request_id=$2 ORDER BY logical_step_id',params)).rows;
      const work=(await f.admin.pool.query("SELECT work_item_id,kind,state,claim_owner,claim_generation,lease_until,(lease_until>clock_timestamp()) AS lease_live FROM manga_web.work_items WHERE account_id=$1 AND (target_ref->>'requestId'=$2 OR target_ref->>'executionId'=ANY($3::text[])) ORDER BY work_item_id",[...params,stages.map(row=>row.execution_id)])).rows;
      const evidence=(await f.admin.pool.query("SELECT e.execution_id,e.kind,count(*)::integer n FROM manga_web.execution_evidence e JOIN manga_web.executions x USING(account_id,execution_id) WHERE e.account_id=$1 AND x.request_id=$2 GROUP BY e.execution_id,e.kind ORDER BY e.execution_id,e.kind",params)).rows;
      const ownership=(await f.admin.pool.query("SELECT x.execution_id,(SELECT count(*)::integer FROM manga_web.windows_native_cost_enrollments e WHERE e.account_id=x.account_id AND e.execution_id=x.execution_id) enrollments,(SELECT count(*)::integer FROM manga_web.windows_native_cost_roots r WHERE r.account_id=x.account_id AND r.execution_id=x.execution_id) roots FROM manga_web.executions x WHERE x.account_id=$1 AND x.request_id=$2 ORDER BY x.execution_id",params)).rows;
      const observations=(await f.admin.pool.query("SELECT i.job_id,i.target_kind,i.target_id,i.protected_intent->>'operationInputDigest' operation_input_digest,o.event,o.protected_observation->>'version' version,o.protected_observation->>'code' code,o.protected_observation->'termination'->>'kind' termination_kind,o.protected_observation->'termination'->>'operationJoined' operation_joined FROM manga_web.native_job_intents i LEFT JOIN manga_web.native_job_observations o USING(account_id,job_id) WHERE i.account_id=$1 ORDER BY i.job_id,o.event",[f.seed.accountId])).rows;
      type Wire={boundary?:string;command?:string;function?:string;code?:string;allowed?:boolean;reason?:string;snapshot?:{phase?:string;code?:string;termination?:{kind?:string;operationJoined?:boolean}|null;windowsEvidenceRef?:unknown;rawResult?:unknown};beforeAvailable?:number;afterAvailable?:number;maximum?:number};
      const wire=(ownedRemote.diagnostics as Wire[]).map(item=>({경계:item.boundary,명령:item.command,함수:item.function,코드:item.code,허용:item.allowed,이유:item.reason,단계:item.snapshot?.phase,응답코드:item.snapshot?.code,종료:item.snapshot?.termination?.kind,합류:item.snapshot?.termination?.operationJoined,서명연결:!!item.snapshot?.windowsEvidenceRef,원결과:!!item.snapshot?.rawResult,종료전가용:item.beforeAvailable,종료후가용:item.afterAvailable,최대:item.maximum}));
      const hosts=ownedRemote.hosts.map(host=>({jobId:host.captures[0]?.origin.identity.binding.jobId,open:host.captures.length,join:host.joins,ACK:host.receivedParentAcks.length,finalized:host.finalized?.handles??null,controls:host.controls.map(value=>value.command),events:host.script?.entries.map(row=>row.event.kind)??[],failures:host.failures.map(w4cDiagnosticFault)}));
      return {단계:phase,events:[...events],관측검증:structuredClone(validationDiagnostics),자산검증:structuredClone(assetDiagnostics),contextTracking:{forOwnerSpyHits,contextSeamHits},claimSelections:structuredClone(claimSelections),입력:inputs.map(value=>({단계:value.stage,executionId:value.executionId,requestId:value.requestId,width:value.width,height:value.height,원본:value.originalAssetId,기존렌더:value.currentRenderAssetId,자산:value.assetDependencies})),원claim:[...claims.values()],request:state,stages,work,evidence,ownership,observations,wire,hosts,교환:{pending:ownedRemote.exchange.pending(),errors:ownedRemote.exchange.ioErrors.map(w4cDiagnosticFault)},부모:ownedRemote.parent.usage(),메모리:{가용:ownedRemote.memory.available(),최대:ownedRemote.memory.maxBytes,교환가용:ownedRemote.exchangeMemory.available(),교환최대:ownedRemote.exchangeMemory.maxBytes}};
    }
    return {...f,remote:ownedRemote,cost:operationalCost,service,runtime,provider,synthetic,requestId,inputs,claims,get claimSelections():readonly (Readonly<Claim>|null)[]{return Object.freeze(structuredClone(claimSelections));},views,operations,preSnapshots,events,confirmedProofs,originalAssetId,renderAssetId,originalBytes,renderBytes,checkpoints,reader,journal,inspect,runTypeset,diagnose,close:async()=>{service.stopClaims();await closeOwned();}};
  }catch(error){try{await closeOwned();}catch(cleanup){throw new AggregateError([error,cleanup],'E3 조립과 owner 종료 오류');}throw error;}
}
