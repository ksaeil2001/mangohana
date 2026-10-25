import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import path from 'node:path';
import type {Database,Transaction} from '../../storage/src/database.js';
import {FileObjectStore,type ObjectReceipt} from '../../storage/src/objects.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {Assets} from './assets.js';
import type {StageInput} from './provider.js';
import type {NativeJobClaim} from './native-jobs.js';
import type {LocalLaMaCapture} from '../../providers/src/local-lama.js';
import type {LocalLaMaOriginalInvocation} from '../../providers/src/local-lama-executor.js';
import type {CapturedFullStageExecution} from './full-stage-cost.js';
import {LocalLaMaAttemptJournal,type LocalLaMaAttemptJournalBounds,type LocalLaMaAttemptMetadata,type LocalLaMaAttemptMetadataView,type LocalLaMaOrderedMetadata} from './local-lama-attempt-journal.js';
import type {LocalLaMaNativePreparation} from './local-lama-native-preparation.js';
import {closed,fingerprint,hexadecimal,id,must,own,type LocalLaMaBindingEvidence} from './local-lama-binding-verifier.js';

export const lamaRawAllocationKind='LAMA_ATTEMPT_RAW_ALLOCATION';
export const lamaRawReceiptKind='LAMA_ATTEMPT_RAW_RECEIPT';
const unconfirmed='LOCAL_LAMA_RAW_UNCONFIRMED',capacity='LOCAL_LAMA_RAW_CAPACITY';
const allowedCostHolds=new Set(['LOCAL_LAMA_ATTEMPT_ENGINE_COST_UNCONFIRMED','LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED']);
const journalMethods=Object.getOwnPropertyDescriptors(LocalLaMaAttemptJournal.prototype);
const objectMethods=Object.getOwnPropertyDescriptors(FileObjectStore.prototype);
const assetMethods=Object.getOwnPropertyDescriptors(Assets.prototype);
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
const byteOffsetGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!;
const bufferGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const copyBytes=Uint8Array.prototype.set;

// Handles contain no serialized authority. Only this instance's WeakMaps
// connect a first original/allocation commit ACK to the following operation.
declare const publicationBrand:unique symbol;
declare const putBrand:unique symbol;
export type LocalLaMaRawPublication=object&{readonly [publicationBrand]:true};
export type LocalLaMaRawPut=object&{readonly [putBrand]:true};
export type LocalLaMaRawReplyRef={ordinal:number;envelopeDigest:string;recordDigest:string};
export type LocalLaMaRawStoreBounds={
  journal:LocalLaMaAttemptJournalBounds;maxRawBytes:number;
  maxInFlightMetadataBytes:number;maxInFlightRawBytes:number;
  maxPublications:number;maxAllocations:number;maxPendingPuts:number;maxIo:number;maxMetadataCalls:number;
};
export type LocalLaMaRawAllocation={
  version:1;original:LocalLaMaOriginalInvocation;originalEnvelopeDigest:string;
  replyOrdinal:number;replyEnvelopeDigest:string;replyRecordDigest:string;
  rawId:string;assetId:string;bucketRef:string;key:string;
  purpose:'LIVE';mediaType:'application/octet-stream';contextId:string;
  sha256:string;byteLength:number;
};
export type LocalLaMaRawReceipt={
  version:1;original:LocalLaMaOriginalInvocation;originalEnvelopeDigest:string;
  allocationEnvelopeDigest:string;rawId:string;assetId:string;replyRecordDigest:string;receipt:ObjectReceipt;
};
export type LocalLaMaRawCandidate={
  version:1;kind:'RAW_CANDIDATE';restoration:'BYTES_VERIFIED';
  metadata:LocalLaMaAttemptMetadataView;allocation:LocalLaMaRawAllocation;receipt:ObjectReceipt;bytes:Buffer;
};
type Frame={input:StageInput;capture:LocalLaMaCapture;full:CapturedFullStageExecution;original:LocalLaMaOriginalInvocation};
type Publication={frame:Frame;originalEnvelopeDigest:string;state:'OPEN'|'ALLOCATING'};
type PendingPut={frame:Frame;allocation:LocalLaMaRawAllocation;allocationEnvelopeDigest:string;state:'PENDING'|'ACTIVE'};
type Historical=Awaited<ReturnType<LocalLaMaAttemptJournal['readOriginalIn']>>;
type RawHistory={source:Historical;allocation:{value:LocalLaMaRawAllocation;envelopeDigest:string}|null;receipt:LocalLaMaRawReceipt|null};
type Wrapper={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};
type AssetScalar={
  asset_id:string;purpose:string;bucket_ref:string;object_key:string;sha256:string;bytes_length:string;
  media_type:string;related_context_id:string|null;deletion_state:string;unexpired:boolean;
  object_created_at:string|null;receipt_time_matches:boolean;
};

export class LocalLaMaRawStore{
  readonly #bounds:Readonly<LocalLaMaRawStoreBounds>;
  readonly #journal:LocalLaMaAttemptJournal;
  readonly #objects:FileObjectStore;
  readonly #assets:Assets;
  readonly #transaction:Database['accountTransaction'];
  readonly #metadataReservation:number;
  readonly #rawReservation:number;
  readonly #publications=new WeakMap<object,Publication>();
  readonly #puts=new WeakMap<object,PendingPut>();
  #publicationCount=0;#allocationCount=0;#pendingCount=0;#ioCount=0;#metadataCalls=0;
  #metadataBytes=0;#rawBytes=0;#putCalls=0;#receiptCalls=0;#readCalls=0;
  constructor(db:Database,root:string,boundsValue:LocalLaMaRawStoreBounds,preparation?:LocalLaMaNativePreparation){
    const bounds=own(boundsValue,4096).value;
    closed(bounds,['journal','maxRawBytes','maxInFlightMetadataBytes','maxInFlightRawBytes','maxPublications','maxAllocations','maxPendingPuts','maxIo','maxMetadataCalls']);
    must(typeof root==='string'&&root.length>0&&root.length<=32767&&!root.includes('\0')&&path.isAbsolute(root),unconfirmed);
    must([bounds.maxRawBytes,bounds.maxInFlightMetadataBytes,bounds.maxInFlightRawBytes,bounds.maxPublications,bounds.maxAllocations,bounds.maxPendingPuts,bounds.maxIo,bounds.maxMetadataCalls].every(value=>Number.isSafeInteger(value)&&value>0),capacity);
    must(bounds.maxRawBytes<=2147483647,capacity);
    this.#journal=new LocalLaMaAttemptJournal(db,bounds.journal,preparation);
    // Do not freeze the journal's counters. Its methods and hidden owner
    // remain fixed, and the instance is never returned to callers.
    for(const [name,descriptor]of Object.entries(journalMethods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(this.#journal,name,{value:descriptor.value,writable:false,configurable:false});
    this.#bounds=Object.freeze({...bounds,journal:Object.freeze({...bounds.journal,calculator:Object.freeze({...bounds.journal.calculator})})});
    this.#metadataReservation=32*(bounds.journal.maxRecordBytes*(bounds.journal.maxRecords+16)+bounds.journal.calculator.maxInputBytes+bounds.journal.calculator.maxOutputBytes);
    this.#rawReservation=6*bounds.maxRawBytes+4;
    must(Number.isSafeInteger(this.#metadataReservation)&&this.#metadataReservation<=bounds.maxInFlightMetadataBytes&&Number.isSafeInteger(this.#rawReservation)&&this.#rawReservation<=bounds.maxInFlightRawBytes,capacity);
    must(db!==null&&typeof db==='object'&&!types.isProxy(db),unconfirmed);
    const role=Object.getOwnPropertyDescriptor(db,'role'),prototype=Object.getPrototypeOf(db);
    must(role&&'value'in role&&role.value==='trio_web_worker'&&!types.isProxy(prototype),unconfirmed);
    const method=Object.getOwnPropertyDescriptor(db,'accountTransaction')??(prototype?Object.getOwnPropertyDescriptor(prototype,'accountTransaction'):undefined);
    must(method&&'value'in method&&typeof method.value==='function'&&!types.isProxy(method.value),unconfirmed);
    this.#transaction=Function.prototype.bind.call(method.value,db) as Database['accountTransaction'];
    this.#objects=new FileObjectStore(root,bounds.maxRawBytes);
    for(const [name,descriptor]of Object.entries(objectMethods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(this.#objects,name,{value:descriptor.value,writable:false,configurable:false});
    Object.freeze(this.#objects);
    this.#assets=new Assets(db,this.#objects);
    for(const [name,descriptor]of Object.entries(assetMethods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(this.#assets,name,{value:descriptor.value,writable:false,configurable:false});
    Object.freeze(this.#assets);
  }
  usage():Readonly<{publications:number;allocations:number;pendingPuts:number;io:number;metadataCalls:number;metadataBytes:number;rawBytes:number;putCalls:number;receiptCalls:number;readCalls:number}>{
    // Diagnostics are counts, never publication, lifetime or engine authority.
    return Object.freeze({publications:this.#publicationCount,allocations:this.#allocationCount,pendingPuts:this.#pendingCount,io:this.#ioCount,metadataCalls:this.#metadataCalls,metadataBytes:this.#metadataBytes,rawBytes:this.#rawBytes,putCalls:this.#putCalls,receiptCalls:this.#receiptCalls,readCalls:this.#readCalls});
  }
  #reserveMetadata():void{must(this.#metadataBytes<=this.#bounds.maxInFlightMetadataBytes-this.#metadataReservation,capacity);this.#metadataBytes+=this.#metadataReservation;}
  #reserveRaw():void{must(this.#rawBytes<=this.#bounds.maxInFlightRawBytes-this.#rawReservation,capacity);this.#rawBytes+=this.#rawReservation;}
  #frame(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution,original:LocalLaMaOriginalInvocation):Frame{
    const limit=this.#bounds.journal.maxRecordBytes;
    return {input:own(input,limit).value,capture:own(capture,limit).value,full:own(full,limit).value,original:own(original,limit).value};
  }
  #handle(value:unknown):asserts value is object{must(value!==null&&typeof value==='object'&&!types.isProxy(value),unconfirmed);}
  async prepareOriginal(inputValue:StageInput,captureValue:LocalLaMaCapture,fullValue:CapturedFullStageExecution,claimValue:NativeJobClaim):Promise<{metadata:LocalLaMaAttemptMetadataView;publication:LocalLaMaRawPublication|null}>{
    must(this.#publicationCount<this.#bounds.maxPublications,capacity);this.#reserveMetadata();this.#publicationCount++;let retained=false;
    try{
      const limit=this.#bounds.journal.maxRecordBytes,input=own(inputValue,limit).value,capture=own(captureValue,limit).value,full=own(fullValue,limit).value,claim=own(claimValue,limit).value;
      const result=own(await this.#journal.claim(input,capture,full,claim),limit*(this.#bounds.journal.maxRecords+4)).value;
      const {created,...metadata}=result;must(typeof created==='boolean',unconfirmed);
      if(!created)return {metadata,publication:null};
      const frame=this.#frame(input,capture,full,metadata.original),publication=Object.freeze({}) as LocalLaMaRawPublication;
      this.#publications.set(publication,{frame,originalEnvelopeDigest:metadata.originalEnvelopeDigest,state:'OPEN'});retained=true;
      return {metadata,publication};
    }finally{if(!retained){this.#publicationCount--;this.#metadataBytes-=this.#metadataReservation;}}
  }
  async appendMetadata(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution,original:LocalLaMaOriginalInvocation,recordValue:LocalLaMaAttemptMetadata):Promise<LocalLaMaAttemptMetadataView>{
    must(this.#metadataCalls<this.#bounds.maxMetadataCalls,capacity);this.#reserveMetadata();this.#metadataCalls++;
    try{
      const frame=this.#frame(input,capture,full,original),record=own(recordValue,this.#bounds.journal.maxRecordBytes).value;
      return await this.#journal.append(frame.input,frame.capture,frame.full,frame.original,record);
    }finally{this.#metadataCalls--;this.#metadataBytes-=this.#metadataReservation;}
  }
  closePublication(handle:LocalLaMaRawPublication):boolean{
    this.#handle(handle);const state=this.#publications.get(handle);if(!state||state.state!=='OPEN')return false;
    this.#publications.delete(handle);this.#publicationCount--;this.#metadataBytes-=this.#metadataReservation;return true;
  }
  closePut(handle:LocalLaMaRawPut):boolean{
    this.#handle(handle);const state=this.#puts.get(handle);if(!state||state.state!=='PENDING')return false;
    this.#puts.delete(handle);this.#pendingCount--;this.#metadataBytes-=this.#metadataReservation;this.#rawBytes-=this.#rawReservation;return true;
  }
  #selected(view:LocalLaMaAttemptMetadataView,refValue:LocalLaMaRawReplyRef):LocalLaMaOrderedMetadata&{record:Extract<LocalLaMaAttemptMetadata,{kind:'ENGINE_REPLY'}>}{
    closed(refValue,['ordinal','envelopeDigest','recordDigest']);hexadecimal(refValue.envelopeDigest);hexadecimal(refValue.recordDigest);
    must(Number.isSafeInteger(refValue.ordinal)&&refValue.ordinal>0,unconfirmed);
    const selected=view.records.find(item=>item.ordinal===refValue.ordinal);
    must(selected&&selected.envelopeDigest===refValue.envelopeDigest&&selected.record.recordDigest===refValue.recordDigest&&selected.record.kind==='ENGINE_REPLY'&&selected.record.reply.proposal!==null,unconfirmed);
    must(selected.record.reply.proposal.byteLength<=this.#bounds.maxRawBytes,capacity);
    return selected as LocalLaMaOrderedMetadata&{record:Extract<LocalLaMaAttemptMetadata,{kind:'ENGINE_REPLY'}>};
  }
  #value(row:LocalLaMaBindingEvidence,frame:Frame):unknown{
    const wrapper=row.protected_observation as Wrapper;closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
    must(wrapper.version===1&&wrapper.accountId===frame.input.accountId&&wrapper.executionId===frame.input.executionId&&wrapper.inputDigest===frame.input.inputDigest&&wrapper.inputFingerprint===fingerprint(frame.input)&&wrapper.kind===row.kind,unconfirmed);
    return wrapper.value;
  }
  #allocation(value:LocalLaMaRawAllocation,source:Historical,frame:Frame):void{
    closed(value,['version','original','originalEnvelopeDigest','replyOrdinal','replyEnvelopeDigest','replyRecordDigest','rawId','assetId','bucketRef','key','purpose','mediaType','contextId','sha256','byteLength']);
    const selected=this.#selected(source.metadata,{ordinal:value.replyOrdinal,envelopeDigest:value.replyEnvelopeDigest,recordDigest:value.replyRecordDigest}),proposal=selected.record.reply.proposal!;
    id(value.rawId);id(value.assetId);id(value.contextId);hexadecimal(value.sha256);
    must(value.version===1&&digest(value.original)===digest(frame.original)&&value.originalEnvelopeDigest===source.metadata.originalEnvelopeDigest&&value.rawId!==value.assetId,unconfirmed);
    must(value.bucketRef===this.#objects.bucket&&value.key===frame.input.accountId+'/'+value.assetId&&value.purpose==='LIVE'&&value.mediaType==='application/octet-stream'&&value.contextId===frame.input.contextId&&value.sha256===proposal.sha256&&value.byteLength===proposal.byteLength,unconfirmed);
    const candidate=source.rows.find(row=>row.kind==='OPERATIONAL_CANDIDATE')!.protected_observation as Wrapper&{value:{evidenceId:string;cleanedAssetId:string|null}};
    const forbidden=[frame.original.invocationId,source.image.assetId,source.mask.assetId,candidate.value.evidenceId,candidate.value.cleanedAssetId,...frame.input.assetDependencies!.map(item=>item.assetId),frame.input.currentCleanedAssetId,frame.input.currentRenderAssetId,...(frame.input.previousOutputAssetIds??[])].filter((item):item is string=>typeof item==='string').map(item=>item.toLowerCase());
    must(!forbidden.includes(value.rawId.toLowerCase())&&!forbidden.includes(value.assetId.toLowerCase()),unconfirmed);
  }
  #proof(value:ObjectReceipt,allocation:LocalLaMaRawAllocation):ObjectReceipt{
    const receipt=own(value,this.#bounds.journal.maxRecordBytes).value;closed(receipt,['key','sha256','bytesLength','completedAt','completedAtPrecisionMilliseconds']);
    must(receipt.key===allocation.key&&receipt.sha256===allocation.sha256&&receipt.bytesLength===String(allocation.byteLength)&&typeof receipt.completedAt==='string'&&Number.isFinite(Date.parse(receipt.completedAt))&&new Date(receipt.completedAt).toISOString()===receipt.completedAt&&receipt.completedAtPrecisionMilliseconds===1,unconfirmed);return receipt;
  }
  async #read(tx:Transaction,frame:Frame):Promise<RawHistory>{
    const source=await this.#journal.readOriginalIn(tx,frame.input,frame.capture,frame.full,frame.original);
    must(source.metadata.holds.every(code=>allowedCostHolds.has(code)),unconfirmed);
    const allocations=source.rows.filter(row=>row.kind===lamaRawAllocationKind),receipts=source.rows.filter(row=>row.kind===lamaRawReceiptKind);
    must(allocations.length<=1&&receipts.length<=1&&(!receipts.length||allocations.length===1),unconfirmed);
    const allocation=allocations.length?{value:this.#value(allocations[0],frame) as LocalLaMaRawAllocation,envelopeDigest:allocations[0].evidence_digest}:null;
    if(allocation)this.#allocation(allocation.value,source,frame);
    const receipt=receipts.length?this.#value(receipts[0],frame) as LocalLaMaRawReceipt:null;
    if(receipt){
      closed(receipt,['version','original','originalEnvelopeDigest','allocationEnvelopeDigest','rawId','assetId','replyRecordDigest','receipt']);
      must(allocation&&receipt.version===1&&digest(receipt.original)===digest(frame.original)&&receipt.originalEnvelopeDigest===source.metadata.originalEnvelopeDigest&&receipt.allocationEnvelopeDigest===allocation.envelopeDigest&&receipt.rawId===allocation.value.rawId&&receipt.assetId===allocation.value.assetId&&receipt.replyRecordDigest===allocation.value.replyRecordDigest,unconfirmed);this.#proof(receipt.receipt,allocation.value);
    }
    return {source,allocation,receipt};
  }
  async #assetRows(tx:Transaction,ids:string[],receiptTime:string|null=null):Promise<AssetScalar[]>{
    must(ids.length>0&&new Set(ids.map(value=>value.toLowerCase())).size===ids.length,unconfirmed);
    for(const value of ids)id(value);
    // Each potentially variable string is bounded before it reaches the
    // driver. NULL/limit+1 are errors, never evidence of an absent asset.
    const sql=[
      'SELECT asset_id,CASE WHEN octet_length(purpose)<=32 THEN purpose ELSE NULL END AS purpose,',
      'CASE WHEN octet_length(bucket_ref)<=128 THEN bucket_ref ELSE NULL END AS bucket_ref,',
      'CASE WHEN octet_length(object_key)<=73 THEN object_key ELSE NULL END AS object_key,',
      'CASE WHEN octet_length(sha256)<=64 THEN sha256 ELSE NULL END AS sha256,bytes_length::text AS bytes_length,',
      'CASE WHEN octet_length(media_type)<=128 THEN media_type ELSE NULL END AS media_type,related_context_id,',
      'CASE WHEN octet_length(deletion_state)<=16 THEN deletion_state ELSE NULL END AS deletion_state,',
      'access_deadline IS NULL OR $3::timestamptz<access_deadline AS unexpired,',
      'CASE WHEN object_created_at IS NULL THEN NULL ELSE to_char(object_created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') END AS object_created_at,',
      '$4::timestamptz IS NULL OR object_created_at=$4::timestamptz AS receipt_time_matches',
      'FROM assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[]) LIMIT $5'
    ].join(' ');
    const rows=(await tx.client.query<AssetScalar>(sql,[tx.account.account_id,ids,tx.now,receiptTime,ids.length+1])).rows;
    must(Array.isArray(rows)&&!types.isProxy(rows)&&rows.length<=ids.length,unconfirmed);const seen=new Set<string>();
    return rows.map(value=>{
      const row=own(value,this.#bounds.journal.maxRecordBytes).value;closed(row,['asset_id','purpose','bucket_ref','object_key','sha256','bytes_length','media_type','related_context_id','deletion_state','unexpired','object_created_at','receipt_time_matches']);
      id(row.asset_id);hexadecimal(row.sha256);must(!seen.has(row.asset_id.toLowerCase())&&ids.some(value=>value.toLowerCase()===row.asset_id.toLowerCase()),unconfirmed);seen.add(row.asset_id.toLowerCase());
      for(const field of ['purpose','bucket_ref','object_key','media_type','deletion_state'] as const)must(typeof row[field]==='string'&&row[field].length>0,unconfirmed);
      must(typeof row.bytes_length==='string'&&/^[1-9][0-9]{0,18}$/.test(row.bytes_length)&&BigInt(row.bytes_length)<=9223372036854775807n&&(row.related_context_id===null||typeof row.related_context_id==='string')&&typeof row.unexpired==='boolean'&&typeof row.receipt_time_matches==='boolean',unconfirmed);
      if(row.related_context_id!==null)id(row.related_context_id);
      must(row.object_created_at===null||typeof row.object_created_at==='string'&&Number.isFinite(Date.parse(row.object_created_at))&&new Date(row.object_created_at).toISOString()===row.object_created_at,unconfirmed);
      must(row.deletion_state!=='CONFIRMED'&&row.unexpired,unconfirmed);return row;
    });
  }
  async #sources(tx:Transaction,history:RawHistory):Promise<void>{
    const expected=[history.source.image,history.source.mask],rows=await this.#assetRows(tx,expected.map(item=>item.assetId));
    must(rows.length===expected.length,unconfirmed);
    for(const descriptor of expected){const row=rows.find(item=>item.asset_id===descriptor.assetId);must(row&&row.sha256===descriptor.sha256&&row.bytes_length===descriptor.bytesLength&&row.media_type===descriptor.mediaType,unconfirmed);}
  }
  async #rawAsset(tx:Transaction,allocation:LocalLaMaRawAllocation,proof:ObjectReceipt|null,required=false):Promise<void>{
    const rows=await this.#assetRows(tx,[allocation.assetId],proof?.completedAt??null);must(!required||rows.length===1,unconfirmed);
    if(!rows.length)return;const row=rows[0];
    must(row.purpose===allocation.purpose&&row.bucket_ref===allocation.bucketRef&&row.object_key===allocation.key&&row.sha256===allocation.sha256&&row.bytes_length===String(allocation.byteLength)&&row.media_type===allocation.mediaType&&row.related_context_id===allocation.contextId,unconfirmed);
    if(proof)must(row.object_created_at===proof.completedAt&&row.receipt_time_matches,unconfirmed);
  }
  async #insert(tx:Transaction,frame:Frame,rows:LocalLaMaBindingEvidence[],kind:string,value:unknown,evidenceId:string):Promise<string>{
    must(rows.length<this.#bounds.journal.maxRecords,capacity);
    const limit=this.#bounds.journal.maxRecordBytes,wrapper=own({version:1 as const,accountId:frame.input.accountId!,executionId:frame.input.executionId,inputDigest:frame.input.inputDigest,inputFingerprint:fingerprint(frame.input),kind,value},limit).value;
    const envelopeDigest=digest(wrapper),added=own({evidence_id:evidenceId,evidence_digest:envelopeDigest,protected_evidence_ref:evidenceId,kind,protected_observation:wrapper},limit);
    const encoded=rows.reduce((sum,row)=>sum+own(row,limit).bytes,0);must(encoded<=limit*this.#bounds.journal.maxRecords-added.bytes,capacity);
    const result=await tx.client.query<{evidence_id:string}>('INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id',[frame.input.accountId,evidenceId,frame.input.executionId,kind,envelopeDigest,tx.now,JSON.stringify(wrapper)]);
    must(result.rowCount===1&&result.rows.length===1&&own(result.rows[0],limit).value.evidence_id===evidenceId,unconfirmed);return envelopeDigest;
  }
  async allocate(publicationValue:LocalLaMaRawPublication,replyValue:LocalLaMaRawReplyRef):Promise<{allocation:LocalLaMaRawAllocation;put:LocalLaMaRawPut|null}>{
    this.#handle(publicationValue);const publication=this.#publications.get(publicationValue);must(publication&&publication.state==='OPEN',unconfirmed);
    must(this.#allocationCount<this.#bounds.maxAllocations&&this.#pendingCount+this.#allocationCount<this.#bounds.maxPendingPuts,capacity);this.#reserveRaw();this.#allocationCount++;this.#publicationCount--;publication.state='ALLOCATING';let retained=false;
    try{
      const frame=publication.frame,reply=own(replyValue,this.#bounds.journal.maxRecordBytes).value;
      const rawId=randomUUID(),assetId=randomUUID(),evidenceId=randomUUID();
      const outcome=await this.#transaction(frame.input.accountId!,async tx=>{
        const current=await this.#read(tx,frame);must(current.source.metadata.originalEnvelopeDigest===publication.originalEnvelopeDigest,unconfirmed);const chosen=this.#selected(current.source.metadata,reply);await this.#sources(tx,current);
        if(current.allocation){must(current.allocation.value.replyOrdinal===reply.ordinal&&current.allocation.value.replyEnvelopeDigest===reply.envelopeDigest&&current.allocation.value.replyRecordDigest===reply.recordDigest,unconfirmed);await this.#rawAsset(tx,current.allocation.value,current.receipt?.receipt??null,current.receipt!==null);return {value:current.allocation.value,envelopeDigest:current.allocation.envelopeDigest,created:false};}
        const descriptor=chosen.record.reply.proposal!;
        const value:LocalLaMaRawAllocation={version:1,original:frame.original,originalEnvelopeDigest:current.source.metadata.originalEnvelopeDigest,replyOrdinal:reply.ordinal,replyEnvelopeDigest:reply.envelopeDigest,replyRecordDigest:reply.recordDigest,rawId,assetId,bucketRef:this.#objects.bucket,key:frame.input.accountId+'/'+assetId,purpose:'LIVE',mediaType:'application/octet-stream',contextId:frame.input.contextId!,sha256:descriptor.sha256,byteLength:descriptor.byteLength};
        this.#allocation(value,current.source,frame);await this.#rawAsset(tx,value,null);
        const envelopeDigest=await this.#insert(tx,frame,current.source.rows,lamaRawAllocationKind,value,evidenceId),after=await this.#read(tx,frame);
        must(after.allocation&&after.allocation.envelopeDigest===envelopeDigest&&digest(after.allocation.value)===digest(value),unconfirmed);await this.#sources(tx,after);await this.#rawAsset(tx,value,null);
        return {value,envelopeDigest,created:true};
      },true);
      const allocation=own(outcome.value,this.#bounds.journal.maxRecordBytes).value;
      if(!outcome.created)return {allocation,put:null};
      const put=Object.freeze({}) as LocalLaMaRawPut;
      this.#puts.set(put,{frame,allocation:own(allocation,this.#bounds.journal.maxRecordBytes).value,allocationEnvelopeDigest:outcome.envelopeDigest,state:'PENDING'});this.#pendingCount++;retained=true;return {allocation,put};
    }finally{
      this.#publications.delete(publicationValue);this.#allocationCount--;
      if(!retained){this.#metadataBytes-=this.#metadataReservation;this.#rawBytes-=this.#rawReservation;}
    }
  }
  #ownedBytes(bytes:Buffer,allocation:LocalLaMaRawAllocation):Buffer{
    must(!types.isProxy(bytes)&&Buffer.isBuffer(bytes)&&Object.getPrototypeOf(bytes)===Buffer.prototype,unconfirmed);
    for(const field of ['length','byteLength','byteOffset','buffer','constructor','toJSON'])must(Object.getOwnPropertyDescriptor(bytes,field)===undefined,unconfirmed);
    const length=Reflect.apply(byteLengthGetter,bytes,[]) as number,offset=Reflect.apply(byteOffsetGetter,bytes,[]) as number,buffer=Reflect.apply(bufferGetter,bytes,[]) as ArrayBuffer;
    must(Number.isSafeInteger(length)&&length===allocation.byteLength&&length<=this.#bounds.maxRawBytes&&!types.isSharedArrayBuffer(buffer),unconfirmed);
    const owned=Buffer.alloc(length);Reflect.apply(copyBytes,owned,[new Uint8Array(buffer,offset,length)]);must(sha256(owned)===allocation.sha256,unconfirmed);return owned;
  }
  async #observe(frame:Frame,allocation:LocalLaMaRawAllocation,allocationEnvelopeDigest:string,returned:ObjectReceipt|null):Promise<LocalLaMaRawCandidate>{
    this.#receiptCalls++;const stored=await this.#objects.receipt(allocation.key);must(stored,unconfirmed);const proof=this.#proof(stored,allocation);
    if(returned)must(digest(this.#proof(returned,allocation))===digest(proof),unconfirmed);
    this.#readCalls++;const bytes=await this.#objects.read(allocation.key);must(bytes.length===allocation.byteLength&&sha256(bytes)===allocation.sha256,unconfirmed);
    const returnedBytes=Buffer.from(bytes),receiptId=randomUUID();
    const metadata=await this.#transaction(frame.input.accountId!,async tx=>{
      const current=await this.#read(tx,frame);must(current.allocation&&current.allocation.envelopeDigest===allocationEnvelopeDigest&&digest(current.allocation.value)===digest(allocation),unconfirmed);
      await this.#sources(tx,current);await this.#rawAsset(tx,allocation,proof,current.receipt!==null);
      must(new Date(proof.completedAt).valueOf()<=tx.now.valueOf()+proof.completedAtPrecisionMilliseconds,unconfirmed);
      if(current.receipt)must(digest(current.receipt.receipt)===digest(proof),unconfirmed);
      await this.#assets.registerReceiptIn(tx,allocation.assetId,proof,allocation.purpose,allocation.mediaType,allocation.contextId);
      await this.#rawAsset(tx,allocation,proof,true);
      if(!current.receipt){
        const receipt:LocalLaMaRawReceipt={version:1,original:frame.original,originalEnvelopeDigest:current.source.metadata.originalEnvelopeDigest,allocationEnvelopeDigest,rawId:allocation.rawId,assetId:allocation.assetId,replyRecordDigest:allocation.replyRecordDigest,receipt:proof};
        await this.#insert(tx,frame,current.source.rows,lamaRawReceiptKind,receipt,receiptId);
      }
      const after=await this.#read(tx,frame);must(after.receipt&&digest(after.receipt.receipt)===digest(proof),unconfirmed);await this.#sources(tx,after);await this.#rawAsset(tx,allocation,proof,true);return after.source.metadata;
    },true);
    return {version:1,kind:'RAW_CANDIDATE',restoration:'BYTES_VERIFIED',metadata,allocation:own(allocation,this.#bounds.journal.maxRecordBytes).value,receipt:proof,bytes:returnedBytes};
  }
  async put(putValue:LocalLaMaRawPut,bytesValue:Buffer):Promise<LocalLaMaRawCandidate>{
    this.#handle(putValue);const pending=this.#puts.get(putValue);must(pending&&pending.state==='PENDING',unconfirmed);
    must(this.#ioCount<this.#bounds.maxIo,capacity);this.#ioCount++;this.#pendingCount--;pending.state='ACTIVE';
    try{
      const bytes=this.#ownedBytes(bytesValue,pending.allocation);
      await this.#transaction(pending.frame.input.accountId!,async tx=>{
        const current=await this.#read(tx,pending.frame);must(current.allocation&&current.allocation.envelopeDigest===pending.allocationEnvelopeDigest&&digest(current.allocation.value)===digest(pending.allocation),unconfirmed);
        await this.#sources(tx,current);await this.#rawAsset(tx,pending.allocation,current.receipt?.receipt??null,current.receipt!==null);
      },true);
      this.#putCalls++;const proof=await this.#objects.put(pending.allocation.key,bytes);
      return await this.#observe(pending.frame,pending.allocation,pending.allocationEnvelopeDigest,proof);
    }finally{this.#puts.delete(putValue);this.#ioCount--;this.#metadataBytes-=this.#metadataReservation;this.#rawBytes-=this.#rawReservation;}
  }
  async restore(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution,original:LocalLaMaOriginalInvocation):Promise<LocalLaMaRawCandidate>{
    must(this.#ioCount<this.#bounds.maxIo,capacity);this.#reserveMetadata();let rawReserved=false,active=false;
    try{
      this.#reserveRaw();rawReserved=true;this.#ioCount++;active=true;const frame=this.#frame(input,capture,full,original);
      const allocation=await this.#transaction(frame.input.accountId!,async tx=>{
        const current=await this.#read(tx,frame);must(current.allocation,unconfirmed);await this.#sources(tx,current);await this.#rawAsset(tx,current.allocation.value,current.receipt?.receipt??null,current.receipt!==null);return current.allocation;
      },true);
      return await this.#observe(frame,allocation.value,allocation.envelopeDigest,null);
    }finally{this.#metadataBytes-=this.#metadataReservation;if(rawReserved)this.#rawBytes-=this.#rawReservation;if(active)this.#ioCount--;}
  }
}
