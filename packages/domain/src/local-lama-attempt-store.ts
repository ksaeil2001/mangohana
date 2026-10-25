import {types} from 'node:util';
import type {Database} from '../../storage/src/database.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import type {LocalLaMaCapture} from '../../providers/src/local-lama.js';
import type {LocalLaMaAttemptStore,LocalLaMaAttemptSnapshot,LocalLaMaFirstClaim,LocalLaMaInvocationBinding,LocalLaMaOriginalInvocation,LocalLaMaInvocationRecord} from '../../providers/src/local-lama-executor.js';
import type {StageInput} from './provider.js';
import {validateNativeJobClaim,type NativeJobClaim} from './native-jobs.js';
import type {CapturedFullStageExecution} from './full-stage-cost.js';
import {LocalLaMaBindingVerifier,closed,fingerprint,hexadecimal,id,localCapture,must,own} from './local-lama-binding-verifier.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView} from './local-lama-attempt-journal.js';
import {LocalLaMaRawStore,type LocalLaMaRawStoreBounds,type LocalLaMaRawPublication,type LocalLaMaRawPut,type LocalLaMaRawCandidate} from './local-lama-raw-store.js';
import type {LocalLaMaNativePreparation} from './local-lama-native-preparation.js';

const unconfirmed='LOCAL_LAMA_STORE_UNCONFIRMED',capacity='LOCAL_LAMA_STORE_CAPACITY';
const journalMethods=Object.getOwnPropertyDescriptors(LocalLaMaAttemptJournal.prototype);
const rawMethods=Object.getOwnPropertyDescriptors(LocalLaMaRawStore.prototype);
const verifierMethods=Object.getOwnPropertyDescriptors(LocalLaMaBindingVerifier.prototype);
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
const byteOffsetGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!;
const bufferGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const copyBytes=Uint8Array.prototype.set;

export type LocalLaMaAttemptStoreBounds={
  raw:LocalLaMaRawStoreBounds;maxConcurrentCalls:number;maxOpenClaims:number;maxInFlightBytes:number;
};
export type LocalLaMaAttemptStoreOptions={
  db:Database;root:string;input:StageInput;capture:LocalLaMaCapture;fullStageCapture:CapturedFullStageExecution;
  claim:NativeJobClaim;binding:LocalLaMaInvocationBinding;bounds:LocalLaMaAttemptStoreBounds;
  preparation?:LocalLaMaNativePreparation;
};
type Publication={handle:LocalLaMaRawPublication;original:LocalLaMaOriginalInvocation;state:'OPEN'|'ALLOCATING'|'PUTTING';held:number};
type OwnedRecord={metadata:LocalLaMaAttemptMetadata;bytes:Buffer|null};

// Narrow domain bridge for the existing coordinator port. It owns its SQL
// readers/raw store; callers supply no mutation/lookup verification callbacks.
// A metadata snapshot never creates a first-claim publication or a PUT token.
export class LocalLaMaDomainAttemptStore{
  readonly #input:StageInput;
  readonly #capture:LocalLaMaCapture;
  readonly #full:CapturedFullStageExecution;
  readonly #claim:NativeJobClaim;
  readonly #binding:LocalLaMaInvocationBinding;
  readonly #bounds:Readonly<LocalLaMaAttemptStoreBounds>;
  readonly #journal:LocalLaMaAttemptJournal;
  readonly #raw:LocalLaMaRawStore;
  readonly #transaction:Database['accountTransaction'];
  readonly #ports:LocalLaMaAttemptStore;
  readonly #callReservation:number;
  readonly #publicationReservation:number;
  #accepting=true;#calls=0;#claims=0;#heldBytes=0;
  #publication:Publication|null=null;
  #pendingPut:LocalLaMaRawPut|null=null;
  #rawInFlight:Promise<void>|null=null;

  constructor(options:LocalLaMaAttemptStoreOptions){
    closed(options,['db','root','input','capture','fullStageCapture','claim','binding','bounds'],['preparation']);
    const bounds=own(options.bounds,8192).value;
    closed(bounds,['raw','maxConcurrentCalls','maxOpenClaims','maxInFlightBytes']);
    must([bounds.maxConcurrentCalls,bounds.maxOpenClaims,bounds.maxInFlightBytes].every(value=>Number.isSafeInteger(value)&&value>0),capacity);
    // RawStore and both journal/readers receive the exact same owned bounds,
    // DB instance and optional preparation owner. No role-only DB substitute
    // or externally replaceable journal/store is accepted as a constructor port.
    this.#raw=new LocalLaMaRawStore(options.db,options.root,bounds.raw,options.preparation);
    this.#journal=new LocalLaMaAttemptJournal(options.db,bounds.raw.journal,options.preparation);
    const verifier=new LocalLaMaBindingVerifier(options.db,bounds.raw.journal);
    for(const [instance,methods]of [[this.#raw,rawMethods],[this.#journal,journalMethods],[verifier,verifierMethods]] as const){
      for(const [name,descriptor]of Object.entries(methods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(instance,name,{value:descriptor.value,writable:false,configurable:false});
    }
    Object.freeze(verifier);Object.freeze(this.#raw);
    this.#transaction=verifier.transaction;
    const maximum=bounds.raw.journal.maxRecordBytes;
    this.#input=verifier.input(own(options.input,maximum).value);
    this.#capture=localCapture(own(options.capture,maximum).value);
    this.#full=own(options.fullStageCapture,maximum).value;
    this.#claim=validateNativeJobClaim(own(options.claim,maximum).value);
    this.#binding=own(options.binding,maximum).value;
    closed(this.#binding,['version','accountId','requestId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode']);
    closed(this.#full,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    for(const value of [this.#binding.accountId,this.#binding.requestId,this.#binding.executionId])id(value);
    for(const value of [this.#binding.inputDigest,this.#binding.inputFingerprint,this.#binding.fullStageCaptureDigest,this.#binding.localCaptureDigest,this.#full.captureDigest])hexadecimal(value);
    must(this.#binding.version===1&&this.#binding.accountId===this.#input.accountId&&this.#binding.requestId===this.#input.requestId&&this.#binding.executionId===this.#input.executionId&&this.#binding.inputDigest===this.#input.inputDigest&&this.#binding.inputFingerprint===fingerprint(this.#input)&&this.#binding.localCaptureDigest===this.#capture.captureDigest&&this.#binding.fullStageCaptureDigest===this.#full.captureDigest&&this.#binding.mode===this.#full.mode,unconfirmed);
    must(this.#capture.executionId===this.#input.executionId&&this.#capture.inputDigest===this.#input.inputDigest&&this.#capture.profileId===this.#input.envelope!.parameterProfileVersion&&this.#capture.captureDigest!==this.#full.captureDigest,unconfirmed);
    this.#bounds=Object.freeze({...bounds,raw:Object.freeze({...bounds.raw,journal:Object.freeze({...bounds.raw.journal,calculator:Object.freeze({...bounds.raw.journal.calculator})})})});
    // Includes row/view/metadata copies, per-record outbound buffers and
    // retained first-ACK frames. Encoded per-instance capacity, not RSS,
    // external retained buffers, decoded tensors or original engine lifetime.
    this.#callReservation=16*(bounds.raw.journal.maxRecordBytes*(bounds.raw.journal.maxRecords+16)+bounds.raw.journal.calculator.maxInputBytes+bounds.raw.journal.calculator.maxOutputBytes)+12*bounds.raw.maxRawBytes*(bounds.raw.journal.maxRecords+4);
    this.#publicationReservation=8*(bounds.raw.journal.maxRecordBytes*8+bounds.raw.journal.calculator.maxInputBytes+bounds.raw.journal.calculator.maxOutputBytes);
    must(Number.isSafeInteger(this.#callReservation)&&Number.isSafeInteger(this.#publicationReservation)&&this.#callReservation+this.#publicationReservation<=bounds.maxInFlightBytes,capacity);
    this.#ports=Object.freeze({
      claim:(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture)=>this.#claimOriginal(binding,capture),
      lookup:(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture)=>this.#lookup(binding,capture),
      append:(binding:LocalLaMaInvocationBinding,original:LocalLaMaOriginalInvocation,record:LocalLaMaInvocationRecord)=>this.#append(binding,original,record),
    });
    // Resolve public accessors from lexical private code rather than a
    // mutable public prototype/getter, even before the capability is read.
    Object.defineProperty(this,'capabilities',{value:()=>this.#ports,writable:false,configurable:false});
    Object.defineProperty(this,'close',{value:()=>this.#close(),writable:false,configurable:false});
    Object.freeze(this);
  }

  capabilities():LocalLaMaAttemptStore{return this.#ports;}
  close():void{
    this.#close();
  }
  #close():void{
    this.#accepting=false;
    const publication=this.#publication;
    if(this.#rawInFlight===null&&publication?.state==='OPEN'&&this.#raw.closePublication(publication.handle)){
      this.#publication=null;this.#claims--;this.#heldBytes-=publication.held;
    }
    // ACTIVE raw I/O cannot be cancelled/freed by this diagnostic close.
    // Its actual promise/finally remains the owner of the held reservation.
    if(this.#pendingPut)this.#raw.closePut(this.#pendingPut);
  }
  #take():()=>void{
    must(this.#accepting,unconfirmed);
    must(this.#calls<this.#bounds.maxConcurrentCalls&&this.#heldBytes<=this.#bounds.maxInFlightBytes-this.#callReservation,capacity);
    this.#calls++;this.#heldBytes+=this.#callReservation;let released=false;
    return ()=>{if(!released){released=true;this.#calls--;this.#heldBytes-=this.#callReservation;}};
  }
  #arguments(bindingValue:LocalLaMaInvocationBinding,captureValue:LocalLaMaCapture):void{
    const binding=own(bindingValue,this.#bounds.raw.journal.maxRecordBytes).value,capture=localCapture(own(captureValue,this.#bounds.raw.journal.maxRecordBytes).value);
    closed(binding,['version','accountId','requestId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode']);
    must(digest(binding)===digest(this.#binding)&&digest(capture)===digest(this.#capture),unconfirmed);
  }
  #original(value:LocalLaMaOriginalInvocation):LocalLaMaOriginalInvocation{
    const original=own(value,this.#bounds.raw.journal.maxRecordBytes).value;
    closed(original,['version','bindingDigest','localCaptureDigest','invocationId']);id(original.invocationId);
    must(original.version===1&&original.bindingDigest===digest(this.#binding)&&original.localCaptureDigest===this.#capture.captureDigest,unconfirmed);
    return original;
  }
  #view(value:LocalLaMaAttemptMetadataView,original?:LocalLaMaOriginalInvocation):LocalLaMaAttemptMetadataView{
    const view=own(value,this.#bounds.raw.journal.maxRecordBytes*(this.#bounds.raw.journal.maxRecords+4)).value;
    closed(view,['version','kind','binding','original','originalEnvelopeDigest','records','rawRestoration','originalLifetime','status','holds']);
    must(view.version===1&&view.kind==='METADATA_ONLY'&&digest(view.binding)===digest(this.#binding)&&view.rawRestoration==='UNCONFIRMED'&&view.originalLifetime==='UNCONFIRMED'&&view.status==='UNCONFIRMED'&&Array.isArray(view.holds)&&view.holds.length===0,unconfirmed);
    const ownedOriginal=this.#original(view.original);
    if(original)must(digest(ownedOriginal)===digest(original),unconfirmed);
    hexadecimal(view.originalEnvelopeDigest);must(Array.isArray(view.records)&&view.records.length<=this.#bounds.raw.journal.maxRecords,capacity);
    let previous=view.originalEnvelopeDigest;
    for(let index=0;index<view.records.length;index++){
      const row=view.records[index];closed(row,['ordinal','previousEnvelopeDigest','envelopeDigest','record']);hexadecimal(row.envelopeDigest);
      must(row.ordinal===index+1&&row.previousEnvelopeDigest===previous,unconfirmed);previous=row.envelopeDigest;
      const {recordDigest,...body}=row.record;hexadecimal(recordDigest);must(digest(body)===recordDigest,unconfirmed);
    }
    return view;
  }
  #prefix(before:LocalLaMaAttemptMetadataView,after:LocalLaMaAttemptMetadataView):void{
    must(after.originalEnvelopeDigest===before.originalEnvelopeDigest&&digest(after.original)===digest(before.original)&&after.records.length>=before.records.length,unconfirmed);
    for(let index=0;index<before.records.length;index++)must(digest(after.records[index])===digest(before.records[index]),unconfirmed);
  }
  #bytes(value:Buffer,descriptor:{sha256:string;byteLength:number}):Buffer{
    must(!types.isProxy(value)&&Buffer.isBuffer(value)&&Object.getPrototypeOf(value)===Buffer.prototype,unconfirmed);
    for(const name of ['length','byteLength','byteOffset','buffer','constructor','toJSON'])must(Object.getOwnPropertyDescriptor(value,name)===undefined,unconfirmed);
    const length=Reflect.apply(byteLengthGetter,value,[]) as number,offset=Reflect.apply(byteOffsetGetter,value,[]) as number,buffer=Reflect.apply(bufferGetter,value,[]) as ArrayBuffer;
    must(Number.isSafeInteger(length)&&length>0&&length===descriptor.byteLength&&length<=this.#bounds.raw.maxRawBytes&&!types.isSharedArrayBuffer(buffer),capacity);
    hexadecimal(descriptor.sha256);const owned=Buffer.alloc(length);Reflect.apply(copyBytes,owned,[new Uint8Array(buffer,offset,length)]);
    must(sha256(owned)===descriptor.sha256,unconfirmed);return owned;
  }
  #record(value:LocalLaMaInvocationRecord):OwnedRecord{
    must(value!==null&&typeof value==='object'&&!types.isProxy(value),unconfirmed);
    const kind=Object.getOwnPropertyDescriptor(value,'kind');must(kind&&kind.enumerable&&'value'in kind,unconfirmed);
    if(kind.value!=='ENGINE_REPLY'){
      must(value.kind!=='ENGINE_REPLY',unconfirmed);
      const metadata=own(value,this.#bounds.raw.journal.maxRecordBytes).value;
      const {recordDigest,...body}=metadata;hexadecimal(recordDigest);must(digest(body)===recordDigest,unconfirmed);
      return {metadata,bytes:null};
    }
    closed(value,['version','kind','reply','recordDigest']);
    must(value.kind==='ENGINE_REPLY',unconfirmed);
    const reply=value.reply;closed(reply,['version','evidenceId','captureDigest','runtime','state','providerSuccess','start','fullCost','proposal']);
    let descriptor:{sha256:string;byteLength:number}|null=null,bytes:Buffer|null=null;
    if(reply.proposal!==null){
      closed(reply.proposal,['sha256','byteLength','bytes']);
      descriptor=own({sha256:reply.proposal.sha256,byteLength:reply.proposal.byteLength},this.#bounds.raw.journal.maxRecordBytes).value;
      bytes=this.#bytes(reply.proposal.bytes,descriptor);
    }
    const metadata=own({version:value.version,kind:'ENGINE_REPLY' as const,recordDigest:value.recordDigest,reply:{...reply,proposal:descriptor}},this.#bounds.raw.journal.maxRecordBytes).value;
    const {recordDigest,...body}=metadata;hexadecimal(recordDigest);must(digest(body)===recordDigest,unconfirmed);
    return {metadata,bytes};
  }
  #descriptor(view:LocalLaMaAttemptMetadataView):{sha256:string;byteLength:number}|null{
    let descriptor:{sha256:string;byteLength:number}|null=null;
    for(const row of view.records)if(row.record.kind==='ENGINE_REPLY'&&row.record.reply.proposal!==null){
      const proposal=row.record.reply.proposal;hexadecimal(proposal.sha256);
      must(Number.isSafeInteger(proposal.byteLength)&&proposal.byteLength>0&&proposal.byteLength<=this.#bounds.raw.maxRawBytes,capacity);
      if(descriptor)must(digest(descriptor)===digest(proposal),unconfirmed);else descriptor={sha256:proposal.sha256,byteLength:proposal.byteLength};
    }
    return descriptor;
  }
  #restored(before:LocalLaMaAttemptMetadataView,candidate:LocalLaMaRawCandidate):{metadata:LocalLaMaAttemptMetadataView;bytes:Buffer}{
    must(candidate.version===1&&candidate.kind==='RAW_CANDIDATE'&&candidate.restoration==='BYTES_VERIFIED',unconfirmed);
    const metadata=this.#view(candidate.metadata,before.original);this.#prefix(before,metadata);
    const allocation=own(candidate.allocation,this.#bounds.raw.journal.maxRecordBytes).value,selected=metadata.records.find(row=>row.ordinal===allocation.replyOrdinal);
    must(selected&&selected.record.kind==='ENGINE_REPLY'&&selected.record.reply.proposal!==null&&selected.envelopeDigest===allocation.replyEnvelopeDigest&&selected.record.recordDigest===allocation.replyRecordDigest&&allocation.originalEnvelopeDigest===metadata.originalEnvelopeDigest&&digest(allocation.original)===digest(metadata.original),unconfirmed);
    const descriptor=this.#descriptor(metadata);must(descriptor&&allocation.sha256===descriptor.sha256&&allocation.byteLength===descriptor.byteLength&&digest(selected.record.reply.proposal)===digest(descriptor),unconfirmed);
    return {metadata,bytes:this.#bytes(candidate.bytes,descriptor)};
  }
  #snapshot(view:LocalLaMaAttemptMetadataView,bytes:Buffer|null):LocalLaMaAttemptSnapshot{
    const descriptor=this.#descriptor(view);must((descriptor===null)===(bytes===null),unconfirmed);
    const records:LocalLaMaInvocationRecord[]=view.records.map(row=>{
      const record=own(row.record,this.#bounds.raw.journal.maxRecordBytes).value;
      if(record.kind==='ENGINE_REPLY'){
        const proposal=record.reply.proposal;
        return {version:1,kind:'ENGINE_REPLY',recordDigest:record.recordDigest,reply:{...record.reply,proposal:proposal?{sha256:proposal.sha256,byteLength:proposal.byteLength,bytes:this.#bytes(bytes!,proposal)}:null}};
      }
      if(record.kind==='START')return {version:1,kind:'START',recordDigest:record.recordDigest,fact:record.fact};
      if(record.kind==='FULL_COST')return {version:1,kind:'FULL_COST',recordDigest:record.recordDigest,evidence:record.evidence};
      return {version:1,kind:'HOLD',recordDigest:record.recordDigest,code:record.code,relatedDigest:record.relatedDigest};
    });
    return {version:1,original:this.#original(view.original),records};
  }
  async #lookupFrame():Promise<LocalLaMaAttemptSnapshot|null>{
    // Within this owner, a committed proposal's allocation/PUT must finish
    // before lookup can turn its temporary absence into a coordinator HOLD.
    // This private promise is never returned to callers as a mutable port.
    const pending=this.#rawInFlight;if(pending)await pending;
    const first=await this.#journal.lookup(this.#input,this.#capture,this.#full);if(first===null)return null;
    const before=this.#view(first);
    // The bound actual readOriginalIn reuses all bounded original/binding/chain
    // checks and explicitly rejects any preparation kind without current.prepared.
    const read=await this.#transaction(this.#input.accountId!,tx=>this.#journal.readOriginalIn(tx,this.#input,this.#capture,this.#full,before.original),true);
    must(fingerprint(read.input)===fingerprint(this.#input),unconfirmed);
    const view=this.#view(read.metadata,before.original);this.#prefix(before,view);
    if(this.#descriptor(view)===null)return this.#snapshot(view,null);
    const restored=this.#restored(view,await this.#raw.restore(this.#input,this.#capture,this.#full,view.original));
    return this.#snapshot(restored.metadata,restored.bytes);
  }
  async #lookup(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture):Promise<LocalLaMaAttemptSnapshot|null>{
    const release=this.#take();try{this.#arguments(binding,capture);return await this.#lookupFrame();}finally{release();}
  }
  async #claimOriginal(binding:LocalLaMaInvocationBinding,capture:LocalLaMaCapture):Promise<LocalLaMaFirstClaim>{
    const release=this.#take();let reserved=false,retained=false,publication:LocalLaMaRawPublication|null=null;
    try{
      this.#arguments(binding,capture);
      if(this.#publication){const current=await this.#lookupFrame();must(current,unconfirmed);return {...current,created:false};}
      must(this.#claims<this.#bounds.maxOpenClaims&&this.#heldBytes<=this.#bounds.maxInFlightBytes-this.#publicationReservation,capacity);
      this.#claims++;this.#heldBytes+=this.#publicationReservation;reserved=true;
      const claimed=await this.#raw.prepareOriginal(this.#input,this.#capture,this.#full,this.#claim);
      publication=claimed.publication;const view=this.#view(claimed.metadata);
      if(publication===null){const current=await this.#lookupFrame();must(current&&digest(current.original)===digest(view.original),unconfirmed);return {...current,created:false};}
      must(view.records.length===0&&this.#publication===null&&this.#accepting,unconfirmed);
      this.#publication={handle:publication,original:this.#original(view.original),state:'OPEN',held:this.#publicationReservation};retained=true;
      return {...this.#snapshot(view,null),created:true};
    }finally{
      if(!retained&&publication)this.#raw.closePublication(publication);
      if(reserved&&!retained){this.#claims--;this.#heldBytes-=this.#publicationReservation;}release();
    }
  }
  async #append(bindingValue:LocalLaMaInvocationBinding,originalValue:LocalLaMaOriginalInvocation,recordValue:LocalLaMaInvocationRecord):Promise<void>{
    const release=this.#take();let operation:Promise<void>|null=null,writeAttempted=false,original:LocalLaMaOriginalInvocation|null=null;
    try{
      this.#arguments(bindingValue,this.#capture);original=this.#original(originalValue);const capturedOriginal=original,record=this.#record(recordValue),preceding=this.#rawInFlight;
      operation=(async()=>{
        let previousFailure:unknown,previousFailed=false;
        if(preceding)try{await preceding;}catch(error){previousFailure=error;previousFailed=true;}
        // Even after a prior raw error, retain a subsequent actual START,
        // cost or HOLD write. Propagate that error rather than acknowledging
        // a healthy continuation or erasing its original uncertainty.
        writeAttempted=true;await this.#appendOwned(capturedOriginal,record);
        if(previousFailed)throw previousFailure;
      })();
      if(record.bytes!==null)this.#rawInFlight=operation;
      await operation;
    }catch(error){
      const publication=this.#publication;
      if(writeAttempted&&original&&publication?.state==='OPEN'&&digest(publication.original)===digest(original)&&this.#raw.closePublication(publication.handle)){
        this.#publication=null;this.#claims--;this.#heldBytes-=publication.held;
      }
      throw error;
    }finally{
      if(operation&&this.#rawInFlight===operation)this.#rawInFlight=null;
      release();
    }
  }
  async #appendOwned(original:LocalLaMaOriginalInvocation,record:OwnedRecord):Promise<void>{
      const view=this.#view(await this.#raw.appendMetadata(this.#input,this.#capture,this.#full,original,record.metadata),original);
      if(record.bytes===null)return;
      const descriptor=this.#descriptor(view),row=view.records.find(item=>item.record.recordDigest===record.metadata.recordDigest);
      must(descriptor&&row&&row.record.kind==='ENGINE_REPLY'&&row.record.reply.proposal!==null&&digest(row.record.reply.proposal)===digest(descriptor),unconfirmed);
      const publication=this.#publication;
      if(!publication||publication.state!=='OPEN'){
        this.#restored(view,await this.#raw.restore(this.#input,this.#capture,this.#full,original));return;
      }
      must(digest(publication.original)===digest(original),unconfirmed);publication.state='ALLOCATING';
      try{
        const allocation=await this.#raw.allocate(publication.handle,{ordinal:row.ordinal,envelopeDigest:row.envelopeDigest,recordDigest:row.record.recordDigest});
        if(allocation.put===null){this.#restored(view,await this.#raw.restore(this.#input,this.#capture,this.#full,original));return;}
        this.#pendingPut=allocation.put;publication.state='PUTTING';
        this.#restored(view,await this.#raw.put(allocation.put,record.bytes));
      }finally{
        // Allocation can fail before its raw owner consumes the publication.
        // Close only that inactive handle; actual pending I/O stays reserved.
        this.#raw.closePublication(publication.handle);
        if(this.#pendingPut)this.#raw.closePut(this.#pendingPut);
        this.#pendingPut=null;if(this.#publication===publication)this.#publication=null;
        this.#claims--;this.#heldBytes-=publication.held;
      }
  }
}
