import {randomUUID,createPublicKey,verify} from 'node:crypto';
import {types} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import canonicalize from 'canonicalize';
import type {NativeControllerDatabase} from '../../storage/src/native-controller-role.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {assertWire} from '../../contracts/src/validation.js';
import {validateNativeEnvelope,validateNativeLimits,verifyNativeInput,describeNativeBlobs,type NativeLimits,type NativeFrameLimits,type NativeJob,type WindowsEvidenceRef} from '../../native/src/dto.js';
import {validateNativeJob} from '../../native/src/jobs.js';
import type {NativeFrame} from '../../native/src/frame.js';
import {validateNativeControllerBinding,type NativeControllerBinding,type NativeRawResultReference} from '../../native/src/controller-protocol.js';
import type {NativeControllerPeer} from '../../native/src/controller-attempts.js';
import {encodeWindowsControl,decodeWindowsControl,decodeWindowsHostMessage,type WindowsPrepareInput,type WindowsJobPorts,type OriginalCapture,type OriginalRef,type JournalEntry,type WindowsSource,type EventAck,type WindowsSealEnvelope,type WindowsPreparedAttempt,type ParentJoinAck,type WindowsJobOutcome,type HostFinalized,type WindowsFact} from '../../native/src/windows-job-backend.js';
import {validateWindowsJobEvidence,classifyWindowsJobEvidence} from '../../native/src/windows-job-evidence.js';
import {validateNativeCapacityConfiguration,validateNativeCapacityAdmission,type WindowsNativeCapacityConfiguration} from './native-capacity.js';
import {canonicalInput,type StageInput} from './provider.js';

export type WindowsJournalConfiguration={controllerId:string;controllerInstanceId:string;capacity:WindowsNativeCapacityConfiguration;limits:NativeLimits;signer:{keyVersion:string;publicKeySpki:string;sign(canonical:string):Promise<string>}};
export type WindowsJournalMemory={maxBytes:number;available():number;hold(bytes:number):()=>void};
// A resolved value transfers to the caller's existing parent Hold. Temporary
// DB/codec copies remain charged until their actual nested operation joins.
type MemoryLease={owner:WindowsNativeJournal;retain(bytes:number):void;dispose():void};
const memoryScope=new AsyncLocalStorage<MemoryLease>();
// The caller supplies the same owner to all journals sharing a parent budget.
// W3-B must supply its parent Hold adapter; no runtime is constructed here.
export function createWindowsJournalMemory(maxBytes:number):WindowsJournalMemory{
  must(Number.isSafeInteger(maxBytes)&&maxBytes>0);let held=0;
  return Object.freeze({maxBytes,available:()=>maxBytes-held,hold:(bytes:number)=>{
    must(Number.isSafeInteger(bytes)&&bytes>=0&&held+bytes<=maxBytes,'WINDOWS_JOURNAL_CAPACITY_WAIT');held+=bytes;let active=true;
    return ()=>{if(active){active=false;held-=bytes;}};
  }});
}
export type WindowsStoredView={capture:OriginalCapture;record:{ref:OriginalRef;envelope:WindowsSealEnvelope}|null;windowsEvidenceRef:WindowsEvidenceRef|null};
export type WindowsNativeCompletion={outcome:WindowsJobOutcome;finalized:HostFinalized;brokerJoin:{end:'EXPECTED'|'LOST';finalized:HostFinalized|null}};
type EvidenceRow={evidenceId:string;evidenceDigest:string;value:unknown};
type RecordRow={purpose:'READY'|'PARENT_JOIN'|'SEAL'|'FINALIZED';recordId:string;digest:string;value:unknown};
type Facts={capacity:WindowsNativeCapacityConfiguration;input:EvidenceRow;basis:EvidenceRow|null;goGrantRef:{jobId:string;rowDigest:string}|null;rawResult:NativeRawResultReference|null;observations:EvidenceRow[];records:RecordRow[];link:{linkId:string;canonical:string;digest:string;signature:string}|null;peer:NativeControllerPeer};
type Decision={allowed:boolean;reason?:string;[key:string]:unknown};
type Row=Record<string,unknown>;
type Event=JournalEntry['event'];
const bytesLimit=131072,replyLimit=12*131072,linkLimit=32768,bounds={maxRecordBytes:65536,maxEvents:64,maxDepth:16,maxNodes:4096};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,hex=/^[a-f0-9]{64}$/;
function must(value:unknown,code='WINDOWS_JOURNAL_UNCONFIRMED'):asserts value{requireCondition(value,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):Row{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value));
  const proto=Object.getPrototypeOf(value);must(proto===Object.prototype||proto===null);
  const actual=Reflect.ownKeys(value);must(actual.length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable&&'value'in d;}));return value as Row;
}
function id(value:unknown):asserts value is string{must(typeof value==='string'&&uuid.test(value));}
function hash(value:unknown):asserts value is string{must(typeof value==='string'&&hex.test(value));}
function same(a:unknown,b:unknown){must(digest(a)===digest(b),'WINDOWS_JOURNAL_BINDING_MISMATCH');}
function measure(value:unknown,max=bytesLimit):number{
  let nodes=0,estimated=0;const visiting=new Set<object>();
  const scale=Math.max(1,Math.ceil(max/bytesLimit));
  const add=(n:number)=>{estimated+=n;must(estimated<=max,'WINDOWS_JOURNAL_LIMIT');};
  const walk=(item:unknown,depth:number):void=>{
    must(++nodes<=8192*scale&&depth<=(scale===1?20:32),'WINDOWS_JOURNAL_LIMIT');must(!types.isProxy(item));
    if(item===null||typeof item==='boolean'){add(5);return;}
    if(typeof item==='number'){must(Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER&&!Object.is(item,-0));add(String(item).length);return;}
    if(typeof item==='string'){must(item.length<=max,'WINDOWS_JOURNAL_LIMIT');add(2);for(const ch of item){const c=ch.codePointAt(0)!;must(c<0xd800||c>0xdfff);add(c<32?6:ch==='"'||ch==='\\'?2:Buffer.byteLength(ch));}return;}
    must(item!==null&&typeof item==='object'&&!visiting.has(item));visiting.add(item);
    try{
      if(Array.isArray(item)){must(Object.getPrototypeOf(item)===Array.prototype&&item.length<=8192*scale-nodes,'WINDOWS_JOURNAL_LIMIT');must(Reflect.ownKeys(item).length===item.length+1);add(2+Math.max(0,item.length-1));for(let i=0;i<item.length;i++){const d=Object.getOwnPropertyDescriptor(item,String(i));must(d&&'value'in d);walk(d.value,depth+1);}}
      else{must(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null);const keys=Reflect.ownKeys(item);must(keys.length<=8192*scale-nodes,'WINDOWS_JOURNAL_LIMIT');add(2+keys.length+Math.max(0,keys.length-1));for(const key of keys){must(typeof key==='string');walk(key,depth+1);const d=Object.getOwnPropertyDescriptor(item,key);must(d?.enumerable&&'value'in d);walk(d.value,depth+1);}}
    }finally{visiting.delete(item);}
  };
  walk(value,0);return estimated;
}
function bounded(value:unknown,max=bytesLimit,charge=true):unknown{
  const size=measure(value,max);if(charge)memoryScope.getStore()?.retain(size*3);const text=canonicalize(value);must(typeof text==='string'&&Buffer.byteLength(text)<=max,'WINDOWS_JOURNAL_LIMIT');return parseStrictJson(text,max);
}
function text(value:unknown,max=bytesLimit):string{const item=bounded(value,max);memoryScope.getStore()?.retain(measure(item,max)*2);const result=canonicalize(item);must(result);return result;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function peer(value:unknown):NativeControllerPeer{const p=closed(value,['serviceRole','peerId']);must(p.serviceRole==='trio_web_api'||p.serviceRole==='trio_web_worker');id(p.peerId);return {serviceRole:p.serviceRole,peerId:p.peerId};}
function originalRef(value:unknown):OriginalRef{const r=closed(value,['recordId','digest']);id(r.recordId);hash(r.digest);return {recordId:r.recordId,digest:r.digest};}
function evidenceRef(value:unknown):WindowsEvidenceRef{const r=closed(value,['recordId','recordDigest','linkId','linkDigest']);id(r.recordId);id(r.linkId);hash(r.recordDigest);hash(r.linkDigest);return r as WindowsEvidenceRef;}
function ack(value:unknown):EventAck{const a=closed(value,['eventId','payloadDigest','sourceDigest']);id(a.eventId);hash(a.payloadDigest);hash(a.sourceDigest);return a as EventAck;}
function parentAck(value:unknown):ParentJoinAck{const a=closed(value,['joinId','originDigest','digest']);id(a.joinId);hash(a.originDigest);hash(a.digest);return a as ParentJoinAck;}
function rawRef(value:unknown):NativeRawResultReference|null{if(value===null)return null;const r=closed(value,['rawResultId','resultDigest']);id(r.rawResultId);hash(r.resultDigest);return r as NativeRawResultReference;}
function originDigest(origin:OriginalCapture['origin']):string{return digest({identity:origin.identity,authority:origin.authority,pins:origin.pins,policy:origin.policy,nativeLimitsDigest:digest(origin.limits),frameInputDigest:origin.identity.binding.inputDigest});}
function origin(value:unknown,launchRef:string):OriginalCapture['origin']{
  const o=bounded(value),a=closed(o,['identity','authority','pins','policy','limits']);
  const auth=closed(a.authority,['attemptId','controllerInstanceId','controllerId','keyVersion','environmentDigest','hostEpochId','sessionId','launchId','policyDigest','controllerSidDigest','childSidDigest','appContainerSidDigest']);
  const control={version:1 as const,requestId:auth.attemptId as string,originDigest:originDigest(o as OriginalCapture['origin']),attemptId:auth.attemptId as string,sessionId:auth.sessionId as string,launchId:auth.launchId as string,command:'PREPARE' as const,payload:{origin:o as OriginalCapture['origin'],launchRef}};
  const checked=decodeWindowsControl(encodeWindowsControl(control));must(checked.command==='PREPARE');return checked.payload.origin;
}
function capture(value:unknown):OriginalCapture{
  const c=closed(bounded(value),['origin','originDigest','frameInputDigest','launchRef']);id(c.launchRef);hash(c.originDigest);hash(c.frameInputDigest);const o=origin(c.origin,c.launchRef);
  must(originDigest(o)===c.originDigest&&o.identity.binding.inputDigest===c.frameInputDigest);return freeze({origin:o,originDigest:c.originDigest,frameInputDigest:c.frameInputDigest,launchRef:c.launchRef});
}
function entry(cap:OriginalCapture,value:unknown):JournalEntry{
  const row=bounded(value),event=closed(closed(row,['event','source','sourceDigest']).event,['eventId','sequence','kind','qpcTicks','previousDigest','payload','payloadDigest']);id(event.eventId);
  const message={version:1,requestId:event.eventId,originDigest:cap.originDigest,attemptId:cap.origin.authority.attemptId,sessionId:cap.origin.authority.sessionId,launchId:cap.origin.authority.launchId,message:'EVENT',payload:row};
  const body=Buffer.from(text(message),'utf8'),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);const checked=decodeWindowsHostMessage(Buffer.concat([prefix,body]));must(checked.message==='EVENT');must(checked.payload.source.originDigest===cap.originDigest);return checked.payload;
}
function inputRow(value:unknown,identity:OriginalCapture['origin']['identity']):StageInput{
  const r=closed(value,['evidenceId','evidenceDigest','value']);id(r.evidenceId);hash(r.evidenceDigest);const input=bounded(r.value) as StageInput;
  must(input&&input.envelope&&input.accountId===identity.binding.accountId&&input.executionId===identity.sourceInput.executionId&&input.inputDigest===identity.sourceInput.stageInputDigest&&r.evidenceId===identity.sourceInput.inputEvidenceId);
  assertWire('stageInputEnvelope',input.envelope);must(input.requestId===input.envelope.requestId&&input.executionId===input.envelope.executionId&&input.stage===input.envelope.logicalStepId&&input.inputDigest===input.envelope.inputDigest&&input.contextId===input.envelope.contextId);
  same(input.settings,input.envelope.capturedSettings);must(digest(input)===r.evidenceDigest&&digest(canonicalInput(input))===r.evidenceDigest&&r.evidenceDigest===identity.inputEvidenceDigest&&r.evidenceDigest===identity.inputFingerprint);return input;
}
function basisRow(value:unknown,input:StageInput):EvidenceRow|null{
  if(value===null)return null;const row=closed(value,['evidenceId','evidenceDigest','value']);id(row.evidenceId);hash(row.evidenceDigest);
  const wrapper=closed(bounded(row.value),['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
  must(wrapper.version===1&&wrapper.accountId===input.accountId&&wrapper.executionId===input.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===digest(canonicalInput(input))&&wrapper.kind==='OPERATIONAL_COST_BASIS'&&digest(wrapper)===row.evidenceDigest);
  const b=closed(wrapper.value,['version','capture','captureDigest','snapshot','snapshotDigest']),c=closed(b.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
  const {captureDigest:claimed,...body}=c;hash(c.profileDigest);hash(claimed);must(b.version===1&&c.accountId===input.accountId&&c.executionId===input.executionId&&c.inputDigest===input.inputDigest&&c.inputFingerprint===wrapper.inputFingerprint&&c.stage===input.stage&&['FREE','PAID'].includes(String(c.mode))&&claimed===digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture:body})&&b.captureDigest===claimed&&b.snapshotDigest===(b.snapshot===null?null:digest(b.snapshot)));
  return row as EvidenceRow;
}

// Controller-only database port. A well-shaped W1 record is not OS authority,
// capacity release, semantic approval or a full-stage cost confirmation.
export class WindowsNativeJournal{
  private config:Readonly<WindowsJournalConfiguration>|null=null;
  private get configuration(){must(this.config);return this.config;}
  private readonly decision:NativeControllerDatabase['decision'];
  private readonly pending=new Set<Promise<unknown>>();private closed=false;private readonly releaseConfiguration:()=>void;
  constructor(db:NativeControllerDatabase,configuration:WindowsJournalConfiguration,private readonly memory:WindowsJournalMemory){
    must(db&&!types.isProxy(db)&&typeof db.decision==='function');closed(configuration,['controllerId','controllerInstanceId','capacity','limits','signer']);
    closed(memory,['maxBytes','available','hold']);must(Number.isSafeInteger(memory.maxBytes)&&memory.maxBytes>0&&typeof memory.available==='function'&&typeof memory.hold==='function');
    const raw={controllerId:configuration.controllerId,controllerInstanceId:configuration.controllerInstanceId,capacity:configuration.capacity,limits:configuration.limits};
    this.releaseConfiguration=memory.hold(measure(raw)*6);must(typeof this.releaseConfiguration==='function');
    try{
    const config=bounded(raw,bytesLimit,false) as Omit<WindowsJournalConfiguration,'signer'>;
    id(config.controllerId);id(config.controllerInstanceId);validateNativeLimits(config.limits);
    const capacity=validateNativeCapacityConfiguration(config.capacity,config.capacity.profile.nativeProfileDigest,config.capacity.profile.kernelDigest);must(capacity.profile.kind==='WINDOWS_JOB_OBJECT'&&capacity.reference.kind==='WINDOWS_JOB_OBJECT');
    const signer=closed(configuration.signer,['keyVersion','publicKeySpki','sign']);must(typeof signer.sign==='function'&&signer.keyVersion===capacity.profile.keyVersion&&signer.publicKeySpki===capacity.profile.publicKeySpki&&config.controllerId===capacity.profile.controllerId);
    must(capacity.profile.windows.pins.nativeLimitsDigest===digest(config.limits));const p=capacity.profile.windows.policy;must(p.maxProcesses<=config.limits.maxProcesses&&p.wallTimeoutMs<=config.limits.timeoutMs&&p.joinTimeoutMs<=config.limits.terminationWaitMs);
    must(memory.maxBytes===config.limits.parentInFlightBytes);
    this.config=freeze({...config,capacity:capacity as WindowsNativeCapacityConfiguration,signer:Object.freeze({keyVersion:signer.keyVersion as string,publicKeySpki:signer.publicKeySpki as string,sign:signer.sign.bind(configuration.signer) as WindowsJournalConfiguration['signer']['sign']})});this.decision=db.decision.bind(db);
    }catch(error){this.releaseConfiguration();throw error;}
  }
  private lease():MemoryLease{const releases:(()=>void)[]=[];return {owner:this,retain:(bytes)=>{const release=this.memory.hold(bytes);must(typeof release==='function');releases.push(release);},dispose:()=>{for(const release of releases.splice(0).reverse())release();}};}
  private async part<T>(fn:()=>Promise<T>):Promise<T>{
    const parent=memoryScope.getStore();must(parent?.owner===this);const lease=this.lease();
    try{const value=await memoryScope.run(lease,fn);const size=value===undefined?0:measure(value,replyLimit)*3;
      // Reserve the surviving returned value before releasing scratch copies.
      // No await or new I/O occurs during this ownership transfer.
      parent.retain(size);lease.dispose();return value;
    }finally{lease.dispose();}
  }
  private work<T>(fn:()=>Promise<T>):Promise<T>{
    if(memoryScope.getStore()?.owner===this)return fn();must(!this.closed,'WINDOWS_JOURNAL_CLOSED');const lease=this.lease();
    const operation=memoryScope.run(lease,async()=>fn()).finally(()=>{lease.dispose();this.pending.delete(operation);});this.pending.add(operation);return operation;
  }
  private async *stream(fn:()=>AsyncIterable<JournalEntry>):AsyncIterable<JournalEntry>{
    if(memoryScope.getStore()?.owner===this){yield* fn();return;}must(!this.closed,'WINDOWS_JOURNAL_CLOSED');
    const lease=this.lease();let finish:()=>void=()=>{};const lifetime=new Promise<void>(resolve=>{finish=resolve;});this.pending.add(lifetime);
    let iterator:AsyncIterator<JournalEntry>|undefined;
    try{iterator=memoryScope.run(lease,()=>fn()[Symbol.asyncIterator]());for(;;){const next=await memoryScope.run(lease,()=>iterator!.next());if(next.done)return;yield next.value;}}
    finally{try{await memoryScope.run(lease,()=>iterator?.return?.());}finally{lease.dispose();this.pending.delete(lifetime);finish();}}
  }
  async close():Promise<void>{this.closed=true;while(this.pending.size)await Promise.allSettled([...this.pending]);if(this.config){this.config=null;this.releaseConfiguration();}}
  private async sql<T extends Decision>(binding:NativeControllerBinding,name:string,args:unknown[],check:(value:T)=>void):Promise<T>{return this.part(()=>this.sqlIn(binding,name,args,check));}
  private async sqlIn<T extends Decision>(binding:NativeControllerBinding,name:string,args:unknown[],check:(value:T)=>void):Promise<T>{
    must(/^[a-z_]+$/.test(name));const lease=memoryScope.getStore();must(lease?.owner===this);
    const argumentBytes=args.reduce<number>((sum,item)=>sum+measure(item,replyLimit),0)*3;lease.retain(argumentBytes);
    const values=args.map(item=>typeof item==='string'||typeof item==='number'?item:JSON.stringify(item));
    const available=this.memory.available();must(Number.isSafeInteger(available)&&available>=0&&available<=this.memory.maxBytes);const wireBytes=Math.min(replyLimit,Math.floor(available/3));must(wireBytes>0,'WINDOWS_JOURNAL_CAPACITY_WAIT');
    const releaseWire=this.memory.hold(wireBytes*3);let wireActive=true,marker:string|undefined;
    const checked=(value:T)=>{const size=measure(value,wireBytes),releaseScratch=wireActive?undefined:this.memory.hold(size*3);
      try{const safe=bounded(value,wireBytes,false),encoded=canonicalize(safe)!;
      if(wireActive){releaseWire();wireActive=false;lease.retain(size*3);}const current=sha256(encoded);
      if(marker!==undefined){must(marker===current,'WINDOWS_JOURNAL_REPLY_CONFLICT');return;}check(value);marker=current;
      }finally{releaseScratch?.();}
    };
    try{const parameters=values.map((_,n)=>`$${n+1}`).join(',');const query=`WITH windows_reply AS MATERIALIZED(SELECT manga_web.${name}(${parameters}) AS payload) SELECT CASE WHEN octet_length(payload::text)<=$${values.length+1}::integer THEN payload ELSE jsonb_build_object('allowed',false,'reason','WINDOWS_JOURNAL_CAPACITY_WAIT') END AS decision FROM windows_reply`;
      const value=await this.decision<T>(binding.accountId,query,[...values,wireBytes],checked);checked(value);return value;
    }finally{if(wireActive)releaseWire();}
  }
  private owned(capValue:OriginalCapture,current=true):OriginalCapture{
    const cap=capture(capValue),a=cap.origin.authority,c=this.configuration,p=c.capacity.profile;
    must(a.controllerId===c.controllerId&&(!current||a.controllerInstanceId===c.controllerInstanceId));
    if(current){must(a.keyVersion===p.keyVersion&&a.environmentDigest===p.environmentDigest&&a.hostEpochId===p.windows.hostEpochId);same(cap.origin.pins,p.windows.pins);same(cap.origin.policy,p.windows.policy);same(cap.origin.limits,c.limits);for(const k of ['controllerSidDigest','childSidDigest','appContainerSidDigest'] as const)must(a[k]===p.windows[k]);}
    return cap;
  }
  private ctx(cap:OriginalCapture,who:NativeControllerPeer){return {binding:cap.origin.identity.binding,attemptId:cap.origin.authority.attemptId,controllerInstanceId:cap.origin.authority.controllerInstanceId,controllerId:this.configuration.controllerId,ownerService:who.serviceRole,peerId:who.peerId};}
  private frame(value:NativeFrame<NativeJob>):NativeFrame<NativeJob>{
    closed(value,['envelope','blobs']);must(!types.isProxy(value.blobs)&&value.blobs instanceof Map&&Object.getPrototypeOf(value.blobs)===Map.prototype&&Reflect.ownKeys(value.blobs).length===0);
    const l=this.configuration.limits,limits:NativeFrameLimits={maxMetadataBytes:l.maxMetadataBytes,maxBinaryBytes:l.maxInputBytes,maxItems:l.maxItems},job=bounded(value.envelope,l.maxMetadataBytes) as NativeJob;
    validateNativeEnvelope(job,limits);verifyNativeInput(job);same(job.blobs,describeNativeBlobs(value.blobs,limits));validateNativeJob({envelope:job,blobs:value.blobs});return {envelope:job,blobs:value.blobs};
  }
  private async offerOriginalIn(whoValue:NativeControllerPeer,bindingValue:NativeControllerBinding,frameValue:NativeFrame<NativeJob>):Promise<WindowsPrepareInput>{
    const who=peer(whoValue),binding=validateNativeControllerBinding(bounded(bindingValue)),frame=this.frame(frameValue),p=this.configuration.capacity.profile;
    must(binding.jobId===frame.envelope.jobId&&binding.inputDigest===frame.envelope.inputDigest&&binding.profileDigest===p.nativeProfileDigest&&frame.envelope.profileDigest===p.nativeProfileDigest&&binding.kernelDigest===p.kernelDigest);
    const context={binding,attemptId:randomUUID(),controllerInstanceId:this.configuration.controllerInstanceId,controllerId:this.configuration.controllerId,ownerService:who.serviceRole,peerId:who.peerId};
    const result=await this.sql<Decision>(binding,'windows_native_offer',[context],r=>{must(r.allowed);closed(r.facts,['binding','intentDigest','sourceInput','input','basis','capacity']);bounded(r.facts,replyLimit);});
    const facts=result.facts as Row;same(facts.binding,binding);const cap=validateNativeCapacityConfiguration({reference:(facts.capacity as Row).reference,profile:(facts.capacity as Row).profile},p.nativeProfileDigest,p.kernelDigest);same(cap,this.configuration.capacity);hash(facts.intentDigest);
    const inputRecord=closed(facts.input,['evidenceId','evidenceDigest','value']);id(inputRecord.evidenceId);hash(inputRecord.evidenceDigest);
    const identity={binding,intentDigest:facts.intentDigest,sourceInput:facts.sourceInput as WindowsPrepareInput['identity']['sourceInput'],inputEvidenceDigest:inputRecord.evidenceDigest,inputFingerprint:inputRecord.evidenceDigest,basisRef:facts.basis===null?null:{evidenceId:(facts.basis as EvidenceRow).evidenceId,evidenceDigest:(facts.basis as EvidenceRow).evidenceDigest}};
    const input=inputRow(inputRecord,identity);basisRow(facts.basis,input);
    const authority={attemptId:context.attemptId,controllerInstanceId:context.controllerInstanceId,controllerId:context.controllerId,keyVersion:p.keyVersion,environmentDigest:p.environmentDigest,hostEpochId:p.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(p.windows.policy),controllerSidDigest:p.windows.controllerSidDigest,childSidDigest:p.windows.childSidDigest,appContainerSidDigest:p.windows.appContainerSidDigest};
    const o=origin({identity,authority,pins:p.windows.pins,policy:p.windows.policy,limits:this.configuration.limits},randomUUID());return {...o,frame};
  }
  portsFor(whoValue:NativeControllerPeer):Pick<WindowsJobPorts,'original'|'journal'>{
    const who=freeze(peer(whoValue));
    const ports:Pick<WindowsJobPorts,'original'|'journal'>=Object.freeze({original:Object.freeze({
      captureFresh:async(input:WindowsPrepareInput)=>{
        closed(input,['identity','authority','pins','policy','limits','frame']);const frame=this.frame(input.frame),{frame:_frame,...rawOrigin}=input;void _frame;const o=bounded(rawOrigin) as OriginalCapture['origin'];const cap=this.owned({origin:o,originDigest:originDigest(o),frameInputDigest:frame.envelope.inputDigest,launchRef:randomUUID()});
        must(cap.origin.identity.binding.jobId===frame.envelope.jobId&&cap.origin.identity.binding.profileDigest===frame.envelope.profileDigest);
        const {inputDigest:_ignored,...job}=frame.envelope;void _ignored;
        const r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_capture',[this.ctx(cap,who),text(cap.origin),text(job,this.configuration.limits.maxMetadataBytes)],v=>{must(v.allowed&&typeof v.created==='boolean');const c=this.owned(v.capture as OriginalCapture);same(c.origin,cap.origin);must(c.originDigest===cap.originDigest&&c.frameInputDigest===cap.frameInputDigest);});
        return {created:r.created===true,capture:this.owned(r.capture as OriginalCapture)};
      },
      grantOriginal:async(capValue:OriginalCapture)=>{
        const cap=this.owned(capValue),r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_grant_go',[this.ctx(cap,who)],v=>{must(v.allowed&&typeof v.created==='boolean');const g=closed(v.goGrantRef,['jobId','rowDigest']);must(g.jobId===cap.origin.identity.binding.jobId);hash(g.rowDigest);});
        return {created:r.created===true,goGrantRef:bounded(r.goGrantRef) as {jobId:string;rowDigest:string}};
      },
      readOriginal:async(capValue:OriginalCapture)=>{
        const cap=this.owned(capValue),r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_current',[this.ctx(cap,who)],v=>{must(v.allowed);const s=closed(v.status,['originDigest','state','goGrantRef']);must(s.originDigest===cap.originDigest&&(s.state==='CONFIRMED'||s.state==='UNCONFIRMED'));if(s.goGrantRef!==null){const g=closed(s.goGrantRef,['jobId','rowDigest']);must(g.jobId===cap.origin.identity.binding.jobId);hash(g.rowDigest);}});
        return bounded(r.status) as {originDigest:string;state:'CONFIRMED'|'UNCONFIRMED';goGrantRef:{jobId:string;rowDigest:string}|null};
      }
    }),journal:Object.freeze({
      appendOriginal:async(capValue:OriginalCapture,event:Event,source:WindowsSource)=>{
        const cap=this.owned(capValue),row=entry(cap,{event,source,sourceDigest:digest(bounded(source))}),expected={eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest};
        const r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_append',[this.ctx(cap,who),text(row.event),text(row.source)],v=>{must(v.allowed);same(ack(v.ack),expected);});return ack(r.ack);
      },
      lookupEvent:async(capValue:OriginalCapture,refValue:EventAck)=>{
        const cap=this.owned(capValue),ref=ack(bounded(refValue)),r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_event',[this.ctx(cap,who),ref.eventId],v=>{must(v.allowed);if(v.entry!==null){const e=entry(cap,v.entry);same({eventId:e.event.eventId,payloadDigest:e.event.payloadDigest,sourceDigest:e.sourceDigest},ref);}});return r.entry===null?null:entry(cap,r.entry);
      },
      scanOriginal:(capValue:OriginalCapture)=>this.scan(this.owned(capValue),who),
      sealOriginal:async(capValue:OriginalCapture,envelope:WindowsSealEnvelope)=>{
        const cap=this.owned(capValue),sealed=this.envelope(cap,envelope),rows=await this.collect(cap,who,sealed);this.verifyRows(cap,rows,sealed);
        return this.record(cap,who,'SEAL',randomUUID(),sealed);
      },
      readOriginal:async(capValue:OriginalCapture)=>{const cap=this.owned(capValue),bundle=await this.read(cap.origin.identity.binding,null);same(bundle.view.capture,cap);return bundle.view.record;}
    })});
    return Object.freeze({original:Object.freeze({
      captureFresh:async(input:WindowsPrepareInput)=>this.work(()=>ports.original.captureFresh(input)),
      grantOriginal:async(cap:OriginalCapture)=>this.work(()=>ports.original.grantOriginal(cap)),
      readOriginal:async(cap:OriginalCapture)=>this.work(()=>ports.original.readOriginal(cap))
    }),journal:Object.freeze({
      appendOriginal:async(cap:OriginalCapture,event:Event,source:WindowsSource)=>this.work(()=>ports.journal.appendOriginal(cap,event,source)),
      lookupEvent:async(cap:OriginalCapture,ref:EventAck)=>this.work(()=>ports.journal.lookupEvent(cap,ref)),
      scanOriginal:(cap:OriginalCapture)=>this.stream(()=>ports.journal.scanOriginal(cap)),
      sealOriginal:async(cap:OriginalCapture,envelope:WindowsSealEnvelope)=>this.work(()=>ports.journal.sealOriginal(cap,envelope)),
      readOriginal:async(cap:OriginalCapture)=>this.work(()=>ports.journal.readOriginal(cap))
    })});
  }
  async offerOriginal(who:NativeControllerPeer,binding:NativeControllerBinding,frame:NativeFrame<NativeJob>):Promise<WindowsPrepareInput>{return this.work(()=>this.offerOriginalIn(who,binding,frame));}
  async readOriginal(binding:NativeControllerBinding,expected:WindowsEvidenceRef|null):Promise<WindowsStoredView>{return this.work(()=>this.part(()=>this.readOriginalIn(binding,expected)));}
  async readyOriginal(cap:OriginalCapture,prepared:WindowsPreparedAttempt):Promise<void>{return this.work(()=>this.readyOriginalIn(cap,prepared));}
  async parentJoinedOriginal(cap:OriginalCapture,ack:ParentJoinAck):Promise<ParentJoinAck>{return this.work(()=>this.parentJoinedOriginalIn(cap,ack));}
  async finishOriginal(cap:OriginalCapture,completion:WindowsNativeCompletion):Promise<WindowsEvidenceRef>{return this.work(()=>this.finishOriginalIn(cap,completion));}
  private async *scan(cap:OriginalCapture,who:NativeControllerPeer):AsyncIterable<JournalEntry>{
    let after=0,total=0;for(;;){const r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_scan',[this.ctx(cap,who),after],v=>{must(v.allowed&&Array.isArray(v.entries)&&v.entries.length<=1);});const rows=r.entries as unknown[];if(!rows.length)return;
      const e=entry(cap,rows[0]);must(e.event.sequence===after+1&&e.event.sequence<=64,'WINDOWS_JOURNAL_ORDER');total+=Buffer.byteLength(text(e));must(total<=64*bytesLimit,'WINDOWS_JOURNAL_LIMIT');after=e.event.sequence;yield e;
    }
  }
  private async collect(cap:OriginalCapture,who:NativeControllerPeer,envelope?:WindowsSealEnvelope):Promise<JournalEntry[]>{
    const rows:JournalEntry[]=[];let held=envelope?Buffer.byteLength(text(envelope))*3:0;
    must(held<=cap.origin.limits.parentInFlightBytes,'WINDOWS_JOURNAL_LIMIT');
    for await(const row of this.scan(cap,who)){held+=Buffer.byteLength(text(row))*3;must(held<=cap.origin.limits.parentInFlightBytes,'WINDOWS_JOURNAL_LIMIT');rows.push(row);}return rows;
  }
  private envelope(cap:OriginalCapture,value:unknown):WindowsSealEnvelope{
    const r=closed(bounded(value),['version','originDigest','evidence','entries','parentJoinAck']);must(r.version===1&&r.originDigest===cap.originDigest&&Array.isArray(r.entries)&&r.entries.length<=64);
    const evidence=validateWindowsJobEvidence(r.evidence,bounds);same(evidence.identity,cap.origin.identity);same(evidence.authority,cap.origin.authority);same(evidence.pins,cap.origin.pins);same(evidence.policy.requested,cap.origin.policy);
    const entries=r.entries.map(ack);const parent=r.parentJoinAck===null?null:parentAck(r.parentJoinAck);must(!parent||parent.originDigest===cap.originDigest);return {version:1,originDigest:cap.originDigest,evidence,entries,parentJoinAck:parent};
  }
  private async record(cap:OriginalCapture,who:NativeControllerPeer,purpose:RecordRow['purpose'],recordId:string,value:unknown):Promise<OriginalRef>{
    id(recordId);const canonical=text(value),expected=digest(value),r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_record',[this.ctx(cap,who),purpose,recordId,canonical],v=>{must(v.allowed);const ref=originalRef(v.ref);must(ref.digest===expected);});return originalRef(r.ref);
  }
  private async read(binding:NativeControllerBinding,expected:WindowsEvidenceRef|null):Promise<{view:WindowsStoredView;facts:Facts}>{return this.part(()=>this.readIn(binding,expected));}
  private async readIn(bindingValue:NativeControllerBinding,expected:WindowsEvidenceRef|null):Promise<{view:WindowsStoredView;facts:Facts}>{
    const binding=validateNativeControllerBinding(bounded(bindingValue));if(expected)evidenceRef(bounded(expected));
    const r=await this.sql<Decision>(binding,'windows_native_read',[{binding,controllerId:this.configuration.controllerId,expected}],v=>{must(v.allowed);closed(v.view,['capture','record','windowsEvidenceRef']);bounded(v.view,replyLimit);bounded(v.facts,replyLimit);});
    const view=bounded(r.view,replyLimit) as WindowsStoredView,facts=bounded(r.facts,replyLimit) as Facts,cap=this.owned(view.capture,false);view.capture=cap;same(cap.origin.identity.binding,binding);
    closed(facts,['capacity','input','basis','goGrantRef','rawResult','observations','records','link','peer']);peer(facts.peer);
    const admission=validateNativeCapacityAdmission(facts.capacity);same(admission.sourceInput,cap.origin.identity.sourceInput);
    const profile=validateNativeCapacityConfiguration({reference:admission.reference,profile:admission.profile},binding.profileDigest,binding.kernelDigest);must(profile.profile.kind==='WINDOWS_JOB_OBJECT');const p=profile.profile;must(p.controllerId===cap.origin.authority.controllerId&&p.keyVersion===cap.origin.authority.keyVersion&&p.environmentDigest===cap.origin.authority.environmentDigest&&p.windows.hostEpochId===cap.origin.authority.hostEpochId);same(p.windows.pins,cap.origin.pins);same(p.windows.policy,cap.origin.policy);for(const k of ['controllerSidDigest','childSidDigest','appContainerSidDigest'] as const)must(p.windows[k]===cap.origin.authority[k]);
    const input=inputRow(facts.input,cap.origin.identity);basisRow(facts.basis,input);if(cap.origin.identity.basisRef!==null){must(facts.basis);same(cap.origin.identity.basisRef,{evidenceId:facts.basis.evidenceId,evidenceDigest:facts.basis.evidenceDigest});}
    must(Array.isArray(facts.records)&&facts.records.length<=4&&Array.isArray(facts.observations)&&facts.observations.length<=2);const purposes=new Set<string>();for(const record of facts.records){closed(record,['purpose','recordId','digest','value']);id(record.recordId);hash(record.digest);record.value=bounded(record.value);must(['READY','PARENT_JOIN','SEAL','FINALIZED'].includes(record.purpose)&&!purposes.has(record.purpose)&&digest(record.value)===record.digest);purposes.add(record.purpose);}
    facts.rawResult=rawRef(facts.rawResult);if(facts.goGrantRef){closed(facts.goGrantRef,['jobId','rowDigest']);must(facts.goGrantRef.jobId===binding.jobId);hash(facts.goGrantRef.rowDigest);}
    if(view.record){closed(view.record,['ref','envelope']);view.record={ref:originalRef(view.record.ref),envelope:this.envelope(cap,view.record.envelope)};must(view.record.ref.digest===digest(view.record.envelope));const stored=facts.records.find(item=>item.purpose==='SEAL');must(stored&&stored.recordId===view.record.ref.recordId&&stored.digest===view.record.ref.digest);same(stored.value,view.record.envelope);}
    if(view.windowsEvidenceRef){view.windowsEvidenceRef=evidenceRef(view.windowsEvidenceRef);must(view.record&&facts.link&&facts.link.linkId===view.windowsEvidenceRef.linkId&&facts.link.digest===view.windowsEvidenceRef.linkDigest&&sha256(facts.link.canonical)===facts.link.digest);must(view.windowsEvidenceRef.recordId===view.record.ref.recordId&&view.windowsEvidenceRef.recordDigest===view.record.ref.digest);const body=this.linkBody(cap,view.record.ref,facts);must(text(body,linkLimit)===facts.link.canonical);this.signature(facts.link.canonical,facts.link.signature,p.publicKeySpki);}
    else must(facts.link===null);
    if(expected)same(expected,view.windowsEvidenceRef);return {view,facts};
  }
  private async readOriginalIn(binding:NativeControllerBinding,expected:WindowsEvidenceRef|null):Promise<WindowsStoredView>{
    const bundle=await this.read(binding,expected);if(bundle.view.record){const rows=await this.collect(bundle.view.capture,bundle.facts.peer,bundle.view.record.envelope);this.verifyRows(bundle.view.capture,rows,bundle.view.record.envelope);}return freeze(bundle.view);
  }
  private async readyOriginalIn(capValue:OriginalCapture,prepared:WindowsPreparedAttempt):Promise<void>{
    const cap=this.owned(capValue),bundle=await this.read(cap.origin.identity.binding,null);same(bundle.view.capture,cap);const p=closed(bounded(prepared),['originDigest','attemptId','controllerInstanceId','sessionId','launchId','root']);must(p.originDigest===cap.originDigest&&p.attemptId===cap.origin.authority.attemptId&&p.controllerInstanceId===cap.origin.authority.controllerInstanceId&&p.sessionId===cap.origin.authority.sessionId&&p.launchId===cap.origin.authority.launchId);
    const rows=await this.collect(cap,bundle.facts.peer);must(rows.some(r=>r.event.kind==='PREPARED'));this.verifyRows(cap,rows);same(p.root,rows.find(r=>r.event.kind==='CREATED_SUSPENDED')?.event.payload&&{pid:(rows.find(r=>r.event.kind==='CREATED_SUSPENDED')!.event.payload as Row).pid,creationFileTime100ns:(rows.find(r=>r.event.kind==='CREATED_SUSPENDED')!.event.payload as Row).creationFileTime100ns});
    await this.sql<Decision>(cap.origin.identity.binding,'windows_native_ready',[this.ctx(cap,bundle.facts.peer),text(prepared)],v=>must(v.allowed));
  }
  private async parentJoinedOriginalIn(capValue:OriginalCapture,value:ParentJoinAck):Promise<ParentJoinAck>{const cap=this.owned(capValue),ack=parentAck(bounded(value));must(ack.originDigest===cap.originDigest);const bundle=await this.read(cap.origin.identity.binding,null);same(bundle.view.capture,cap);await this.record(cap,bundle.facts.peer,'PARENT_JOIN',ack.joinId,ack);return freeze(ack);}
  private async finishOriginalIn(capValue:OriginalCapture,completionValue:WindowsNativeCompletion):Promise<WindowsEvidenceRef>{
    const cap=this.owned(capValue),completion=closed(bounded(completionValue),['outcome','finalized','brokerJoin']) as unknown as WindowsNativeCompletion;
    closed(completion.outcome,['state','code','evidence','rawResult','journalRef']);must(completion.outcome.state==='JOINED'&&completion.outcome.evidence&&completion.outcome.journalRef);
    const stored=await this.readOriginal(cap.origin.identity.binding,null);same(stored.capture,cap);must(stored.record);same(completion.outcome.evidence,stored.record.envelope.evidence);same(completion.outcome.journalRef,stored.record.ref);must(classifyWindowsJobEvidence(stored.record.envelope.evidence)!=='UNCONFIRMED');
    const finalized=closed(completion.finalized,['recordId','digest','handles','closeCode']);must(finalized.handles==='CLOSED'&&finalized.closeCode===null);same({recordId:finalized.recordId,digest:finalized.digest},stored.record.ref);
    closed(completion.brokerJoin,['end','finalized']);must(completion.brokerJoin.end==='EXPECTED');same(completion.brokerJoin.finalized,completion.finalized);
    let bundle=await this.read(cap.origin.identity.binding,null);same(bundle.facts.rawResult,rawRef(completion.outcome.rawResult));
    await this.record(cap,bundle.facts.peer,'FINALIZED',randomUUID(),{version:1,originDigest:cap.originDigest,finalized:completion.finalized,brokerJoin:completion.brokerJoin});
    bundle=await this.read(cap.origin.identity.binding,null);const final=bundle.facts.records.find(r=>r.purpose==='FINALIZED');must(final);
    await this.sql<Decision>(cap.origin.identity.binding,'windows_native_finish',[this.ctx(cap,bundle.facts.peer),text({version:1,originDigest:cap.originDigest,record:stored.record.ref,rawResult:bundle.facts.rawResult,finalized:{recordId:final.recordId,digest:final.digest}})],v=>{must(v.allowed&&Array.isArray(v.observations)&&v.observations.length>=1&&v.observations.length<=2);});
    bundle=await this.read(cap.origin.identity.binding,null);if(bundle.view.windowsEvidenceRef)return (await this.readOriginal(cap.origin.identity.binding,bundle.view.windowsEvidenceRef)).windowsEvidenceRef!;
    const body=this.linkBody(cap,stored.record.ref,bundle.facts),canonical=text(body,linkLimit),signature=await this.configuration.signer.sign(canonical);this.signature(canonical,signature,this.configuration.signer.publicKeySpki);
    let saved:WindowsEvidenceRef|null=null;
    try{const r=await this.sql<Decision>(cap.origin.identity.binding,'windows_native_link',[this.ctx(cap,bundle.facts.peer),randomUUID(),canonical,signature],v=>{must(v.allowed);const ref=evidenceRef(v.reference);must(ref.linkDigest===sha256(canonical)&&ref.recordId===stored.record!.ref.recordId&&ref.recordDigest===stored.record!.ref.digest);});saved=evidenceRef(r.reference);}
    catch(error){const found=await this.readOriginal(cap.origin.identity.binding,null);if(!found.windowsEvidenceRef)throw error;saved=found.windowsEvidenceRef;}
    must(saved);return (await this.readOriginal(cap.origin.identity.binding,saved)).windowsEvidenceRef!;
  }
  private signature(canonical:string,signature:unknown,spki:string){must(typeof signature==='string'&&/^[A-Za-z0-9+/]{86}==$/.test(signature));const bytes=Buffer.from(signature,'base64');must(bytes.length===64&&bytes.toString('base64')===signature&&verify(null,Buffer.from(canonical),createPublicKey({key:Buffer.from(spki,'base64'),format:'der',type:'spki'}),bytes),'WINDOWS_JOURNAL_SIGNATURE_UNCONFIRMED');}
  private linkBody(cap:OriginalCapture,record:OriginalRef,facts:Facts):unknown{
    must(facts.observations.length===(facts.rawResult?2:1));const parent=facts.records.find(r=>r.purpose==='PARENT_JOIN'),finalized=facts.records.find(r=>r.purpose==='FINALIZED');must(parent&&finalized);
    const sealed=facts.records.find(r=>r.purpose==='SEAL');must(sealed&&sealed.recordId===record.recordId&&sealed.digest===record.digest);const envelope=this.envelope(cap,sealed.value),e=envelope.evidence;must(classifyWindowsJobEvidence(e)!=='UNCONFIRMED');
    same(parentAck(parent.value),envelope.parentJoinAck);const final=closed(finalized.value,['version','originDigest','finalized','brokerJoin']);must(final.version===1&&final.originDigest===cap.originDigest);same(final.finalized,{...record,handles:'CLOSED',closeCode:null});same(final.brokerJoin,{end:'EXPECTED',finalized:final.finalized});
    const created=e.final.outcome==='JOB_EMPTY';must(created===(facts.rawResult!==null));same(e.lifecycle.goGrantRef,facts.goGrantRef);must(!created||facts.goGrantRef&&e.lifecycle.goWrite==='RETURNED');
    const termination={jobId:cap.origin.identity.binding.jobId,inputDigest:cap.frameInputDigest,profileDigest:cap.origin.identity.binding.profileDigest,goAttempted:e.lifecycle.goWrite!=='NOT_ATTEMPTED',startedComputation:facts.rawResult!==null,directChildClosed:created,subtreeTerminationConfirmed:created,operationJoined:true,kind:created?'WINDOWS_JOB_EMPTY':'NO_CHILD_CREATED',isolation:'WINDOWS_JOB_OBJECT'};
    const refs=facts.observations.map((row,index)=>{closed(row,['evidenceId','evidenceDigest','value']);id(row.evidenceId);hash(row.evidenceDigest);const o=closed(row.value,['version','parentInstanceId','event','code','resultDigest','termination','windowsRecordRef']);must(o.version===2&&o.parentInstanceId===cap.origin.identity.binding.parentInstanceId&&o.code==='OK'&&o.event===(facts.rawResult&&index===0?'RESULT':'TERMINATION')&&o.resultDigest===(facts.rawResult&&index===0?facts.rawResult.resultDigest:null));same(o.termination,termination);same(o.windowsRecordRef,{recordId:record.recordId,recordDigest:record.digest});return {evidenceId:row.evidenceId,evidenceDigest:row.evidenceDigest};});
    must(new Set(refs.map(r=>r.evidenceId)).size===refs.length);const basis=facts.basis?{evidenceId:facts.basis.evidenceId,evidenceDigest:facts.basis.evidenceDigest}:null;
    return {version:1,originDigest:cap.originDigest,identity:cap.origin.identity,basis,goGrantRef:facts.goGrantRef,rawResult:facts.rawResult,record:{recordId:record.recordId,recordDigest:record.digest},parentJoin:{recordId:parent.recordId,digest:parent.digest},finalized:{recordId:finalized.recordId,digest:finalized.digest},observations:refs};
  }
  private verifyRows(cap:OriginalCapture,rows:JournalEntry[],envelope?:WindowsSealEnvelope):void{
    must(rows.length<=64);if(envelope)must(rows.length===envelope.entries.length&&rows.length===envelope.evidence.lifecycle.events.length);let previous:string|null=null,time=0n;const kinds=new Set<string>(),calls=new Map<string,string>();
    for(let n=0;n<rows.length;n++){const row=rows[n],e=row.event;must(e.sequence===n+1&&e.previousDigest===previous&&BigInt(e.qpcTicks)>=time&&!kinds.has(e.kind));if(envelope){same(e,envelope.evidence.lifecycle.events[n]);same({eventId:e.eventId,payloadDigest:e.payloadDigest,sourceDigest:row.sourceDigest},envelope.entries[n]);}previous=e.payloadDigest;time=BigInt(e.qpcTicks);kinds.add(e.kind);
      for(const f of row.source.facts){must(BigInt(f.qpcTicks)<=time||(e.kind==='CREATED_SUSPENDED'&&f.kind==='WIN32'&&f.api==='GetProcessTimes'&&f.status==='RETURNED'));if('callId'in f){const old=calls.get(f.callId),value=digest(f);must(!old||old===value);calls.set(f.callId,value);}}
    }
    const get=(kind:Event['kind'])=>{const row=rows.find(r=>r.event.kind===kind);must(row);return row;};
    const win=(row:JournalEntry,api:string)=>row.source.facts.filter((f):f is Extract<WindowsFact,{kind:'WIN32'}>=>f.kind==='WIN32'&&f.api===api&&f.status==='RETURNED');
    const one=<T>(values:T[]):T=>{must(values.length===1);return values[0];};
    same(get('PRE_CREATE').event.payload,{bindingDigest:digest(cap.origin.identity),policyDigest:cap.origin.authority.policyDigest,pinsDigest:digest(cap.origin.pins)});
    if(rows.some(r=>r.event.kind==='CREATED_SUSPENDED')){
      const created=get('CREATED_SUSPENDED'),c=one(win(created,'CreateProcessAsUserW')),t=one(win(created,'GetProcessTimes')),root=created.event.payload as {pid:number;creationFileTime100ns:string};must(created.source.facts.length===2&&c.callId!==t.callId&&c.qpcTicks===created.event.qpcTicks&&BigInt(t.qpcTicks)>=BigInt(c.qpcTicks));
      must(c.callId===(get('CREATE_ARMED').event.payload as {callId:string}).callId&&(c.value as Row).pid===root.pid&&(t.value as Row).processRef===(c.value as Row).processRef&&(t.value as Row).creationFileTime100ns===root.creationFileTime100ns);
      for(const row of rows.slice(rows.indexOf(created)+1))must(BigInt(row.event.qpcTicks)>=BigInt(t.qpcTicks));
      const prepared=rows.find(r=>r.event.kind==='PREPARED');if(prepared){const p=one(win(prepared,'GetProcessTimes'));must(!rows.slice(0,rows.indexOf(prepared)).some(r=>r.source.facts.some(f=>'callId'in f&&f.callId===p.callId))&&(p.value as Row).processRef===(c.value as Row).processRef&&(p.value as Row).creationFileTime100ns===root.creationFileTime100ns&&prepared.source.facts.every(f=>BigInt(f.qpcTicks)>=BigInt(t.qpcTicks)));must(one(win(prepared,'IsProcessInJob')).value&&((one(win(prepared,'IsProcessInJob')).value as Row).isMember===true));
        const tokens=win(prepared,'GetTokenInformation').map(v=>v.value as Row),classes=['TOKEN_USER','TOKEN_APPCONTAINER_SID','TOKEN_IS_APPCONTAINER','TOKEN_INTEGRITY_LEVEL','TOKEN_SESSION_ID'],ordered=classes.map(k=>one(tokens.filter(t=>t.informationClass===k)));must((ordered[0].values as Row).sidDigest===cap.origin.authority.childSidDigest&&(ordered[1].values as Row).sidDigest===cap.origin.authority.appContainerSidDigest&&(ordered[2].values as Row).isAppContainer===true);must((prepared.event.payload as Row).tokenDigest===digest(ordered));
      }
    }
    const failed=rows.find(r=>r.event.kind==='CREATE_FAILED');if(failed){const f=one(failed.source.facts.filter((f):f is Extract<WindowsFact,{kind:'WIN32'}>=>f.kind==='WIN32'&&f.api==='CreateProcessAsUserW'&&f.status==='FAILED'));must(f.callId===(get('CREATE_ARMED').event.payload as Row).callId&&f.win32Error===(failed.event.payload as Row).win32Error);}
    const authorized=rows.find(r=>r.event.kind==='GO_AUTHORIZED');if(authorized){const facts=authorized.source.facts.filter(f=>f.kind==='ORIGINAL_GO');same(one(facts),{kind:'ORIGINAL_GO',qpcTicks:authorized.event.qpcTicks,goGrantRef:(authorized.event.payload as {goGrantRef:unknown}).goGrantRef});if(envelope)same((authorized.event.payload as {goGrantRef:unknown}).goGrantRef,envelope.evidence.lifecycle.goGrantRef);}
    const write=rows.find(r=>r.event.kind==='GO_WRITE');if(write){const result=(write.event.payload as {result:string}).result;must(write.source.facts.some(f=>f.kind==='IO'&&f.lane==='IN'&&f.operation==='WRITE'&&f.status===result&&(result==='UNCONFIRMED'||f.bytesLength==='6'&&f.sha256===sha256('GO_V1\n'))));}
    const exited=rows.find(r=>r.event.kind==='ROOT_EXIT');if(exited){must((one(win(exited,'WaitForSingleObject')).value as Row).waitResult==='SIGNALED'&&(one(win(exited,'GetExitCodeProcess')).value as Row).exitCode===(exited.event.payload as {exitCode:number}).exitCode);}
    const query=(row:JournalEntry,kind:string)=>one(win(row,'QueryInformationJobObject').filter(f=>(f.value as Row).informationClass===kind)).value as {informationClass:string;values:Row};
    const prepared=rows.find(r=>r.event.kind==='PREPARED');if(prepared){const ext=query(prepared,'EXTENDED_LIMITS').values,b=ext.BasicLimitInformation as Row,cpu=query(prepared,'CPU_RATE').values,flags=b.LimitFlags as number;must((flags&0x308)===0x308&&((cpu.ControlFlags as number)&5)===5);const actual={maxProcesses:b.ActiveProcessLimit,jobCommitLimitBytes:ext.JobMemoryLimit,processCommitLimitBytes:ext.ProcessMemoryLimit,cpuRatePer10000:cpu.CpuRate,killOnJobClose:(flags&0x2000)!==0,breakawayAllowed:(flags&0x1800)!==0},p=cap.origin.policy;const expected={maxProcesses:p.maxProcesses,jobCommitLimitBytes:p.jobCommitLimitBytes,processCommitLimitBytes:p.processCommitLimitBytes,cpuRatePer10000:p.cpuRatePer10000,killOnJobClose:true,breakawayAllowed:false},broker={wallTimeoutMs:p.wallTimeoutMs,joinTimeoutMs:p.joinTimeoutMs,stdoutMaxBytes:p.stdoutMaxBytes,stderrMaxBytes:p.stderrMaxBytes};same(actual,expected);must((prepared.event.payload as Row).osReadbackDigest===digest(actual)&&(prepared.event.payload as Row).brokerAppliedDigest===digest(broker));if(envelope){same(envelope.evidence.policy.osReadback,actual);same(envelope.evidence.policy.brokerApplied,broker);}}
    const resumed=rows.find(r=>r.event.kind==='BOOTSTRAP_RESUMED');if(resumed){const resume=one(win(resumed,'ResumeThread')),wait=one(resumed.source.facts.filter(f=>f.kind==='IO'&&f.lane==='OUT'&&f.operation==='READ'&&f.status==='RETURNED'&&f.bytesLength==='8'&&f.sha256===sha256('WAIT_V1\n')));must((resume.value as Row).previousSuspendCount===1&&BigInt(resume.qpcTicks)>=BigInt(get('PREPARED').event.qpcTicks)&&BigInt(wait.qpcTicks)>=BigInt(resume.qpcTicks)&&wait.qpcTicks===resumed.event.qpcTicks);}
    const empty=rows.find(r=>r.event.kind==='TREE_EMPTY');if(empty){const values=query(empty,'BASIC_ACCOUNTING').values;must(values.ActiveProcesses===0&&String(values.TotalProcesses)===(empty.event.payload as {totalProcesses:string}).totalProcesses);}
    const io=rows.find(r=>r.event.kind==='IO_JOINED');if(io){must(envelope?.parentJoinAck);same(one(io.source.facts.filter(f=>f.kind==='PARENT_ACK')),{kind:'PARENT_ACK',qpcTicks:one(io.source.facts.filter(f=>f.kind==='PARENT_ACK')).qpcTicks,ack:envelope.parentJoinAck});const emptyHash=sha256(Buffer.alloc(0));for(const [lane,operation]of [['IN','CLOSE'],['OUT','READ'],['ERR','READ']])must(io.source.facts.some(f=>f.kind==='IO'&&f.lane===lane&&f.operation===operation&&f.status==='RETURNED'&&f.bytesLength==='0'&&f.sha256===emptyHash));}
    const final=rows.find(r=>r.event.kind==='FINAL_ACCOUNTING');if(final){const base=query(final,'BASIC_AND_IO').values,info=base.BasicInfo as Row,io=base.IoInfo as Row,ext=query(final,'EXTENDED_LIMITS').values,freq=one(win(final,'QueryPerformanceFrequency')).value as Row;must((one(win(final,'QueryPerformanceCounter')).value as Row).ticks===final.event.qpcTicks);const actual={userTime100ns:info.TotalUserTime,kernelTime100ns:info.TotalKernelTime,peakJobMemoryBytes:ext.PeakJobMemoryUsed,peakProcessMemoryBytes:ext.PeakProcessMemoryUsed,readOperations:io.ReadOperationCount,writeOperations:io.WriteOperationCount,otherOperations:io.OtherOperationCount,readBytes:io.ReadTransferCount,writeBytes:io.WriteTransferCount,otherBytes:io.OtherTransferCount,totalProcesses:String(info.TotalProcesses),startQpcTicks:get('CREATED_SUSPENDED').event.qpcTicks,endQpcTicks:final.event.qpcTicks,qpcFrequency:freq.frequency,snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS'};must(info.ActiveProcesses===0&&final.source.facts.every(f=>BigInt(f.qpcTicks)>=BigInt(get('IO_JOINED').event.qpcTicks)));same(actual,(final.event.payload as {accounting:unknown}).accounting);if(envelope)same(actual,envelope.evidence.final.accounting);}
  }
}
