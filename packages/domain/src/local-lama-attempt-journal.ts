import {randomUUID} from 'node:crypto';
import {CheckpointValidationJournal} from './checkpoint-validation.js';
import type {Database,Transaction} from '../../storage/src/database.js';
import {DomainError} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import type {LocalLaMaCapture,LocalLaMaExecutorReply,LocalLaMaRuntimeFacts,LocalLaMaStartFact,LocalLaMaFullCost} from '../../providers/src/local-lama.js';
import type {LocalLaMaInvocationBinding,LocalLaMaOriginalInvocation,LocalLaMaFullCostEvidence} from '../../providers/src/local-lama-executor.js';
import {FullStageCostCalculator,type CapturedFullStageExecution} from './full-stage-cost.js';
import type {StageInput} from './provider.js';
import {validateNativeJobClaim,type NativeJobClaim} from './native-jobs.js';
import {LocalLaMaBindingVerifier,must,closed,id,hexadecimal,own,localCapture,fingerprint,type LocalLaMaBindingReaderBounds,type LocalLaMaBindingEvidence} from './local-lama-binding-verifier.js';

import {LocalLaMaNativePreparation,lamaPreparationCaptureKind,lamaPreparationJoinKind,lamaPreparationPrecheckKind,validateLaMaPreparationJoins,confirmCurrentLaMaPreparationReceipt,type LocalLaMaPreparationCaptureRecord,type LocalLaMaPreparationJoins,type LocalLaMaPreparationReservation,type LocalLaMaPreparationJoin} from './local-lama-native-preparation.js';
const preparationMethods=Object.getOwnPropertyDescriptors(LocalLaMaNativePreparation.prototype);
const verifierMethods=Object.getOwnPropertyDescriptors(LocalLaMaBindingVerifier.prototype);
type PreparedNative={capture:LocalLaMaPreparationCaptureRecord;joins:LocalLaMaPreparationJoins};

// Intentionally different from the byte-owning invocation record and store.
// These immutable claims cannot restore pixels, prove an original join, or
// authorize an engine submission, native GO, full-stage cost or settlement.
export type LocalLaMaReplyMetadata=Omit<LocalLaMaExecutorReply,'proposal'>&{proposal:{sha256:string;byteLength:number}|null};
export type LocalLaMaAttemptMetadata=({version:1;kind:'START';fact:LocalLaMaStartFact}|{version:1;kind:'ENGINE_REPLY';reply:LocalLaMaReplyMetadata}|{version:1;kind:'FULL_COST';evidence:LocalLaMaFullCostEvidence}|{version:1;kind:'HOLD';code:string;relatedDigest:string|null})&{recordDigest:string};
export type LocalLaMaOrderedMetadata={ordinal:number;previousEnvelopeDigest:string;envelopeDigest:string;record:LocalLaMaAttemptMetadata};
export type LocalLaMaAttemptMetadataView={version:1;kind:'METADATA_ONLY';binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;originalEnvelopeDigest:string;records:LocalLaMaOrderedMetadata[];rawRestoration:'UNCONFIRMED';originalLifetime:'UNCONFIRMED';status:'UNCONFIRMED'|'HOLD';holds:string[]};
export type LocalLaMaAttemptJournalBounds=LocalLaMaBindingReaderBounds;
type Wrapper={version:1;accountId:string;executionId:string;inputDigest:string;inputFingerprint:string;kind:string;value:unknown};
type OriginalEnvelope={version:1;ordinal:0;previousEnvelopeDigest:null;binding:LocalLaMaInvocationBinding;original:LocalLaMaOriginalInvocation;localCapture:LocalLaMaCapture;fullStageCapture:CapturedFullStageExecution};
type MetadataEnvelope={version:1;ordinal:number;previousEnvelopeDigest:string;original:LocalLaMaOriginalInvocation;record:LocalLaMaAttemptMetadata};
type Captured={input:StageInput;capture:LocalLaMaCapture;full:CapturedFullStageExecution};
const originalKind='LAMA_ATTEMPT_ORIGINAL',metadataKind='LAMA_ATTEMPT_METADATA',unconfirmed='LOCAL_LAMA_ATTEMPT_UNCONFIRMED',legacy='LOCAL_LAMA_ATTEMPT_LEGACY_UNCONFIRMED',capacity='LOCAL_LAMA_ATTEMPT_CAPACITY';

export class LocalLaMaAttemptJournal{
  #preparation:LocalLaMaNativePreparation|undefined;
  #checkpoints:CheckpointValidationJournal;
  private readonly verifier:LocalLaMaBindingVerifier;
  private readonly reservation:number;
  private calls=0;private heldBytes=0;
  constructor(db:Database,bounds:LocalLaMaAttemptJournalBounds,preparation?:LocalLaMaNativePreparation){
    if(preparation)must((preparationMethods.sameDatabase.value as LocalLaMaNativePreparation['sameDatabase']).call(preparation,db)&&digest(preparation.bounds)===digest(bounds),unconfirmed);this.#preparation=preparation;
    this.verifier=new LocalLaMaBindingVerifier(db,bounds);
    this.#checkpoints=new CheckpointValidationJournal(db,{maxRecordBytes:bounds.maxRecordBytes,maxRecords:bounds.maxRecords,maxTargets:bounds.maxRecords,maxJobs:bounds.maxRecords});
    for(const [name,descriptor]of Object.entries(verifierMethods))if(name!=='constructor'&&typeof descriptor.value==='function')Object.defineProperty(this.verifier,name,{value:descriptor.value,writable:false,configurable:false});
    Object.freeze(this.verifier);Object.defineProperty(this,'verifier',{value:this.verifier,writable:false,configurable:false});
    // Covers verifier rows, both captures, metadata, envelopes and view copies.
    // Per-instance encoded capacity only; never a native/RSS/lifetime cap.
    this.reservation=this.verifier.reservation+8*this.verifier.bounds.maxRecordBytes*(this.verifier.bounds.maxRecords+4);
    must(Number.isSafeInteger(this.reservation)&&this.reservation<=this.verifier.bounds.maxInFlightBytes,capacity);
  }
  private take():()=>void{
    const bounds=this.verifier.bounds;must(this.calls<bounds.maxConcurrentReads&&this.heldBytes<=bounds.maxInFlightBytes-this.reservation,capacity);this.calls++;this.heldBytes+=this.reservation;
    let released=false;return ()=>{if(!released){released=true;this.calls--;this.heldBytes-=this.reservation;}};
  }
  private fullCapture(value:CapturedFullStageExecution,input:StageInput):CapturedFullStageExecution{
    closed(value,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const {captureDigest,...body}=value;hexadecimal(captureDigest);hexadecimal(value.profileDigest);
    must(value.accountId===input.accountId&&value.executionId===input.executionId&&value.inputDigest===input.inputDigest&&value.inputFingerprint===fingerprint(input)&&value.stage==='CLEANUP'&&['FREE','PAID'].includes(value.mode),unconfirmed);
    const normalized=new FullStageCostCalculator(null,this.verifier.bounds.calculator).capture(body);must(digest(value)===digest(normalized),unconfirmed);return value;
  }
  private capture(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution):Captured{
    const limit=this.verifier.bounds.maxRecordBytes,owned=this.verifier.input(own(input,limit).value),local=localCapture(own(capture,limit).value),whole=this.fullCapture(own(full,limit).value,owned);
    must(local.executionId===owned.executionId&&local.inputDigest===owned.inputDigest&&local.profileId===owned.envelope!.parameterProfileVersion&&local.captureDigest!==whole.captureDigest,unconfirmed);return {input:owned,capture:local,full:whole};
  }
  private original(value:LocalLaMaOriginalInvocation):LocalLaMaOriginalInvocation{
    closed(value,['version','bindingDigest','localCaptureDigest','invocationId']);must(value.version===1,unconfirmed);hexadecimal(value.bindingDigest);hexadecimal(value.localCaptureDigest);id(value.invocationId);return value;
  }
  private text(value:unknown):asserts value is string{must(typeof value==='string'&&value.trim().length>0&&!value.includes('\0')&&Buffer.byteLength(value)<=this.verifier.bounds.calculator.maxStringBytes,unconfirmed);}
  private runtime(value:LocalLaMaRuntimeFacts,original:LocalLaMaOriginalInvocation,capture:LocalLaMaCapture):void{
    closed(value,['version','kind','invocationId','executionId','inputDigest','profileDigest','identityDigest']);
    must(value.version===1&&value.kind==='LOCAL_LAMA'&&value.invocationId===original.invocationId&&value.executionId===capture.executionId&&value.inputDigest===capture.inputDigest&&value.profileDigest===capture.profileDigest&&value.identityDigest===digest(capture.identity),unconfirmed);
  }
  private start(value:LocalLaMaStartFact,original:LocalLaMaOriginalInvocation,capture:LocalLaMaCapture):void{
    closed(value,['version','evidenceId','captureDigest','runtime']);id(value.evidenceId);must(value.version===1&&value.captureDigest===capture.captureDigest,unconfirmed);this.runtime(value.runtime,original,capture);
  }
  private cost(value:LocalLaMaFullCost,capture:LocalLaMaCapture):void{
    closed(value,['version','scope','captureDigest','runtimeDigest','actualUsd','evidenceRef','basisVersion']);hexadecimal(value.runtimeDigest);
    must(value.version===1&&value.scope==='FULL_STAGE_PROCESS'&&value.captureDigest===capture.captureDigest&&typeof value.actualUsd==='string'&&/^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(value.actualUsd),unconfirmed);this.text(value.evidenceRef);this.text(value.basisVersion);
  }
  private metadata(value:LocalLaMaAttemptMetadata,original:LocalLaMaOriginalInvocation,captured:Captured):LocalLaMaAttemptMetadata{
    must(value!==null&&typeof value==='object',unconfirmed);hexadecimal(value.recordDigest);must(value.version===1,unconfirmed);
    if(value.kind==='START'){closed(value,['version','kind','fact','recordDigest']);this.start(value.fact,original,captured.capture);}
    else if(value.kind==='ENGINE_REPLY'){
      closed(value,['version','kind','reply','recordDigest']);const reply=value.reply;closed(reply,['version','evidenceId','captureDigest','runtime','state','providerSuccess','start','fullCost','proposal']);id(reply.evidenceId);
      must(reply.version===1&&reply.captureDigest===captured.capture.captureDigest&&['SUCCEEDED','FAILED','NOT_STARTED','UNKNOWN'].includes(reply.state)&&(reply.providerSuccess===null||typeof reply.providerSuccess==='boolean'),unconfirmed);this.runtime(reply.runtime,original,captured.capture);
      if(reply.start!==null)this.start(reply.start,original,captured.capture);if(reply.fullCost!==null)this.cost(reply.fullCost,captured.capture);
      if(reply.proposal!==null){closed(reply.proposal,['sha256','byteLength']);hexadecimal(reply.proposal.sha256);must(Number.isSafeInteger(reply.proposal.byteLength)&&reply.proposal.byteLength>0&&reply.proposal.byteLength<=2147483647,unconfirmed);}
    }else if(value.kind==='FULL_COST'){
      closed(value,['version','kind','evidence','recordDigest']);const evidence=value.evidence;closed(evidence,['version','bindingDigest','fullStageCaptureDigest','closureEvidenceRef','fullCost']);
      must(evidence.version===1&&evidence.bindingDigest===original.bindingDigest&&evidence.fullStageCaptureDigest===captured.full.captureDigest,unconfirmed);this.text(evidence.closureEvidenceRef);this.cost(evidence.fullCost,captured.capture);
    }else{closed(value,['version','kind','code','relatedDigest','recordDigest']);must(value.kind==='HOLD',unconfirmed);this.text(value.code);if(value.relatedDigest!==null)hexadecimal(value.relatedDigest);}
    const {recordDigest,...body}=value;must(digest(body)===recordDigest,unconfirmed);return value;
  }
  private wrapper(input:StageInput,kind:string,value:unknown):Wrapper{
    return own({version:1 as const,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:fingerprint(input),kind,value},this.verifier.bounds.maxRecordBytes).value;
  }
  private value(row:LocalLaMaBindingEvidence,input:StageInput):unknown{
    const wrapper=row.protected_observation as Wrapper;closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);
    must(wrapper.version===1&&wrapper.accountId===input.accountId&&wrapper.executionId===input.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===fingerprint(input)&&wrapper.kind===row.kind,unconfirmed);return wrapper.value;
  }
  private chain(captured:Captured,binding:LocalLaMaInvocationBinding|null,rows:LocalLaMaBindingEvidence[]):LocalLaMaAttemptMetadataView|null{
    const originals=rows.filter(row=>row.kind===originalKind),records=rows.filter(row=>row.kind===metadataKind);must(originals.length<=1&&(!records.length||originals.length===1),unconfirmed);
    if(!originals.length)return null;must(binding!==null,unconfirmed);
    const row=originals[0],envelope=this.value(row,captured.input) as OriginalEnvelope;closed(envelope,['version','ordinal','previousEnvelopeDigest','binding','original','localCapture','fullStageCapture']);
    const original=this.original(envelope.original);must(envelope.version===1&&envelope.ordinal===0&&envelope.previousEnvelopeDigest===null&&digest(envelope.binding)===digest(binding)&&original.bindingDigest===digest(binding)&&original.localCaptureDigest===captured.capture.captureDigest&&digest(envelope.localCapture)===digest(captured.capture)&&digest(envelope.fullStageCapture)===digest(captured.full),unconfirmed);
    const ordered=records.map(item=>{
      const value=this.value(item,captured.input) as MetadataEnvelope;closed(value,['version','ordinal','previousEnvelopeDigest','original','record']);
      must(value.version===1&&Number.isSafeInteger(value.ordinal)&&value.ordinal>0&&value.ordinal<=this.verifier.bounds.maxRecords&&digest(this.original(value.original))===digest(original),unconfirmed);hexadecimal(value.previousEnvelopeDigest);
      return {ordinal:value.ordinal,previousEnvelopeDigest:value.previousEnvelopeDigest,envelopeDigest:item.evidence_digest,record:this.metadata(value.record,original,captured)};
    }).sort((a,b)=>a.ordinal-b.ordinal);
    const digests=new Set<string>();let previous=row.evidence_digest;
    for(let at=0;at<ordered.length;at++){const item=ordered[at];must(item.ordinal===at+1&&item.previousEnvelopeDigest===previous&&!digests.has(item.record.recordDigest),unconfirmed);previous=item.envelopeDigest;digests.add(item.record.recordDigest);}
    const holds=this.conflicts(ordered.map(item=>item.record));
    return {version:1,kind:'METADATA_ONLY',binding:structuredClone(binding),original:structuredClone(original),originalEnvelopeDigest:row.evidence_digest,records:ordered,rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:holds.length?'HOLD':'UNCONFIRMED',holds};
  }
  private conflicts(records:LocalLaMaAttemptMetadata[]):string[]{
    const holds=new Set<string>(),engine=new Map<string,string>();let start:LocalLaMaStartFact|null=null,runtime:LocalLaMaRuntimeFacts|null=null,provider:boolean|null=null,proposal:string|null=null,cost:string|null=null;
    const keepStart=(fact:LocalLaMaStartFact)=>{if(start&&digest(start)!==digest(fact))holds.add('LOCAL_LAMA_ATTEMPT_START_CONFLICT');start??=fact;runtime??=fact.runtime;};
    for(const record of records){
      if(record.kind==='HOLD')holds.add(record.code);
      else if(record.kind==='START')keepStart(record.fact);
      else if(record.kind==='ENGINE_REPLY'){
        const reply=record.reply,sha=digest(reply),known=engine.get(reply.evidenceId.toLowerCase());if(known&&known!==sha)holds.add('LOCAL_LAMA_ATTEMPT_ENGINE_EVIDENCE_CONFLICT');engine.set(reply.evidenceId.toLowerCase(),sha);runtime??=reply.runtime;if(reply.start)keepStart(reply.start);
        if(reply.fullCost!==null)holds.add('LOCAL_LAMA_ATTEMPT_ENGINE_COST_UNCONFIRMED');
        if(reply.providerSuccess!==null){if(provider!==null&&provider!==reply.providerSuccess)holds.add('LOCAL_LAMA_ATTEMPT_PROVIDER_CONFLICT');provider??=reply.providerSuccess;}
        if(reply.proposal){if(proposal&&proposal!==digest(reply.proposal))holds.add('LOCAL_LAMA_ATTEMPT_PROPOSAL_CONFLICT');proposal??=digest(reply.proposal);}
        if(reply.state==='SUCCEEDED'&&(reply.providerSuccess!==true||reply.proposal===null)||reply.proposal!==null&&reply.providerSuccess!==true||reply.state==='NOT_STARTED'&&(reply.start!==null||reply.providerSuccess!==null||reply.proposal!==null))holds.add('LOCAL_LAMA_ATTEMPT_REPLY_CONFLICT');
      }
    }
    for(const record of records){
      if(record.kind==='ENGINE_REPLY'&&record.reply.state==='NOT_STARTED'&&start)holds.add('LOCAL_LAMA_ATTEMPT_START_CONFLICT');
      if(record.kind==='FULL_COST'){const fact=record.evidence;if(!runtime||fact.fullCost.runtimeDigest!==digest(runtime)||cost!==null&&cost!==digest(fact))holds.add('LOCAL_LAMA_ATTEMPT_COST_UNCONFIRMED');cost??=digest(fact);}
    }
    return [...holds];
  }
  private hasLater(rows:LocalLaMaBindingEvidence[]):boolean{
    return rows.some(row=>!['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_CANDIDATE',originalKind,metadataKind,'OPERATIONAL_SOURCE'].includes(row.kind)||row.kind==='OPERATIONAL_SOURCE'&&(row.protected_observation as Wrapper&{value:{phase:string}}).value.phase!=='LAMA_INPUT');
  }
  private async noLater(tx:Transaction,captured:Captured,rows:LocalLaMaBindingEvidence[],prepared:PreparedNative|null=null,claim?:NativeJobClaim):Promise<void>{
    const checkpoint=captured.input.envelope!.checkpointDependencies.length||rows.some(row=>row.kind.startsWith('CHECKPOINT_VALIDATION_'))?await this.#checkpoints.verifiedPredecessorsIn(tx,captured.input):{evidenceIds:[],jobIds:[]};
    const verifiedIds=new Set([...(prepared?[prepared.capture.evidenceId,...prepared.joins.rows.map(row=>row.evidence_id),...(prepared.joins.precheck?[prepared.joins.precheck.evidence_id]:[])]:[]),...checkpoint.evidenceIds]);
    must(!this.hasLater(rows.filter(row=>!verifiedIds.has(row.evidence_id))),legacy);
    if(prepared&&claim){
      await validateLaMaPreparationJoins(tx,captured.input,prepared.capture,rows,this.verifier.bounds,true,true);
      const owners=(await tx.client.query<{capture:import('../../native/src/gateway.js').NativeOwnerCapture}>(`SELECT jsonb_build_object('contextId',context_id,'contextGeneration',generation::text,'ownerSessionId',owner_session_id,'ownerTabId',owner_tab_id,'ownerRevision',owner_revision::text,'workspaceRevision',workspace_revision::text) AS capture
        FROM workspace_contexts WHERE account_id=$1 AND context_id=$2 LIMIT 2`,[captured.input.accountId,captured.input.contextId])).rows;
      must(owners.length===1,legacy);const owner=own(owners[0],this.verifier.bounds.maxRecordBytes).value.capture;
      for(const row of prepared.joins.rows){const join=(row.protected_observation as Wrapper&{value:LocalLaMaPreparationJoin}).value;
        await confirmCurrentLaMaPreparationReceipt(tx,{accountId:captured.input.accountId!,targetKind:'EXECUTION',targetId:captured.input.executionId,semanticCaptureDigest:join.expected.semanticCaptureDigest,protectedOwnerCapture:owner,claim},prepared.capture,join.expected,join.sealed,this.verifier.bounds.maxRecordBytes);
      }
    }

    const result=(await tx.client.query<{clear:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM executions e WHERE e.account_id=$1 AND e.execution_id=$2 AND e.start_confirmed_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM native_job_intents i WHERE i.account_id=$1 AND ((i.target_kind='EXECUTION' AND i.target_id=$2) OR(i.target_kind='REQUEST_CHECKPOINT' AND i.target_id=$3)) AND NOT(i.job_id=ANY($4::uuid[]))) AS clear`,[captured.input.accountId,captured.input.executionId,captured.input.requestId,[...(prepared?.joins.jobIds??[]),...checkpoint.jobIds]])).rows;
    must(Array.isArray(result)&&result.length===1&&own(result[0],this.verifier.bounds.maxRecordBytes).value.clear===true,legacy);
  }
  private async read(tx:Transaction,captured:Captured,lockCurrent=false,hold?:LocalLaMaPreparationReservation){
    const core=await this.verifier.core(tx,captured.input,lockCurrent),rows=await this.verifier.records(tx,captured.input,true);let prepared:PreparedNative|null=null;
    if(this.#preparation){must(hold,capacity);const read=await (preparationMethods.readIn.value as LocalLaMaNativePreparation['readIn']).call(this.#preparation,tx,captured.input,hold);must(digest(read.state.rows)===digest(rows),unconfirmed);if(read.capture)prepared={capture:read.capture,joins:await validateLaMaPreparationJoins(tx,captured.input,read.capture,rows,this.verifier.bounds)};}
    const binding=this.verifier.original(captured.input,captured.capture,core,rows,prepared?.joins.mask);
    if(binding)must(binding.fullStageCaptureDigest===captured.full.captureDigest&&binding.mode===captured.full.mode,unconfirmed);
    return {core,rows,binding,prepared,view:this.chain(captured,binding,rows)};
  }
  // Historical raw reconciliation reads the already captured ORIGINAL only.
  // This method grants no publication, dispatch, START, native GO or PUT.
  // The caller owns this transaction and must reserve its returned copies.
  async readOriginalIn(tx:Transaction,inputValue:StageInput,captureValue:LocalLaMaCapture,fullValue:CapturedFullStageExecution,originalValue:LocalLaMaOriginalInvocation):Promise<{input:StageInput;metadata:LocalLaMaAttemptMetadataView;rows:LocalLaMaBindingEvidence[];image:import('./model.js').AssetDependency;mask:import('./model.js').AssetDependency}>{
    const release=this.take();let hold:LocalLaMaPreparationReservation|undefined;try{
      if(this.#preparation)hold=(preparationMethods.acquire.value as LocalLaMaNativePreparation['acquire']).call(this.#preparation);
      const captured=this.capture(inputValue,captureValue,fullValue),original=this.original(own(originalValue,this.verifier.bounds.maxRecordBytes).value);
      const current=await this.read(tx,captured,false,hold),view=current.view;
      must(!current.rows.some(row=>[lamaPreparationCaptureKind,lamaPreparationJoinKind,lamaPreparationPrecheckKind].includes(row.kind))||current.prepared!==null,unconfirmed);
      must(view&&digest(view.original)===digest(original),unconfirmed);
      // read has checked the LAMA_INPUT source, full binding and complete
      // bounded metadata chain, including preparation joins when present.
      // Preserve every HOLD; the raw owner applies its narrow cost allowlist.
      const sources=current.rows.filter(row=>row.kind==='OPERATIONAL_SOURCE').map(row=>(row.protected_observation as Wrapper&{value:{phase:string;value:{image:import('./model.js').AssetDependency;mask:import('./model.js').AssetDependency}}}).value).filter(source=>source.phase==='LAMA_INPUT');
      must(sources.length===1,unconfirmed);
      return {input:structuredClone(captured.input),metadata:structuredClone(view),rows:structuredClone(current.rows),image:structuredClone(sources[0].value.image),mask:structuredClone(sources[0].value.mask)};
    }finally{hold?.release();release();}
  }
  // Context classification uses the original journal's bounded read resources,
  // identity and complete metadata chain; it reserves no preparation task I/O.
  async contextIn(tx:Transaction,inputValue:StageInput,preparation:LocalLaMaNativePreparation):Promise<{input:StageInput;capture:LocalLaMaPreparationCaptureRecord|null;original:LocalLaMaAttemptMetadataView|null}>{
    const release=this.take();try{
      const input=this.verifier.input(own(inputValue,this.verifier.bounds.maxRecordBytes).value);
      const core=await this.verifier.core(tx,input),rows=await this.verifier.records(tx,input,true);
      const state=await (preparationMethods.readContextIn.value as LocalLaMaNativePreparation['readContextIn']).call(preparation,tx,input);
      must(digest(state.state.rows)===digest(rows)&&digest(state.state.core)===digest(core),unconfirmed);
      const originals=rows.filter(row=>row.kind===originalKind),metadata=rows.filter(row=>row.kind===metadataKind);
      must(originals.length<=1&&(!metadata.length||originals.length===1),unconfirmed);
      if(!originals.length)return {input:state.state.input,capture:state.capture,original:null};
      const envelope=this.value(originals[0],input) as OriginalEnvelope;
      closed(envelope,['version','ordinal','previousEnvelopeDigest','binding','original','localCapture','fullStageCapture']);
      const captured=this.capture(input,envelope.localCapture,envelope.fullStageCapture);
      const joins=state.capture?await validateLaMaPreparationJoins(tx,input,state.capture,rows,this.verifier.bounds):null;
      const binding=this.verifier.original(captured.input,captured.capture,core,rows,joins?.mask);
      if(binding)must(binding.fullStageCaptureDigest===captured.full.captureDigest&&binding.mode===captured.full.mode,unconfirmed);
      const view=this.chain(captured,binding,rows);must(view&&view.holds.length===0,unconfirmed);
      return {input:state.state.input,capture:state.capture,original:view};
    }finally{release();}
  }
  private async insert(tx:Transaction,wrapper:Wrapper):Promise<string>{
    const evidenceId=randomUUID(),sha=digest(wrapper),result=await tx.client.query<{evidence_id:string}>(`INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation)
      VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,$7) RETURNING evidence_id`,[wrapper.accountId,evidenceId,wrapper.executionId,wrapper.kind,sha,tx.now,JSON.stringify(wrapper)]);
    must(result.rowCount===1&&result.rows.length===1&&result.rows[0].evidence_id===evidenceId,unconfirmed);return sha;
  }
  async claim(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution,claimValue:NativeJobClaim):Promise<LocalLaMaAttemptMetadataView&{created:boolean}>{
    const release=this.take();let hold:LocalLaMaPreparationReservation|undefined;try{
      if(this.#preparation)hold=(preparationMethods.acquire.value as LocalLaMaNativePreparation['acquire']).call(this.#preparation);
      const captured=this.capture(input,capture,full);let claim:NativeJobClaim;
      try{claim=validateNativeJobClaim(own(claimValue,this.verifier.bounds.maxRecordBytes).value);}catch{throw new DomainError(unconfirmed,409,'WAIT');}
      return await this.verifier.transaction(captured.input.accountId!,async tx=>{
        const current=await this.read(tx,captured,true,hold);if(current.view)return {...current.view,created:false};
        must(current.binding!==null,unconfirmed);await this.noLater(tx,captured,current.rows,current.prepared,claim);await this.verifier.dispatchFence(tx,captured.input,claim,current.core,true);must(current.rows.length<this.verifier.bounds.maxRecords,capacity);
        const original:LocalLaMaOriginalInvocation={version:1,bindingDigest:digest(current.binding),localCaptureDigest:captured.capture.captureDigest,invocationId:randomUUID()};
        const envelope:OriginalEnvelope={version:1,ordinal:0,previousEnvelopeDigest:null,binding:current.binding,original,localCapture:captured.capture,fullStageCapture:captured.full},sha=await this.insert(tx,this.wrapper(captured.input,originalKind,envelope));
        return {version:1,kind:'METADATA_ONLY',binding:current.binding,original,originalEnvelopeDigest:sha,records:[],rawRestoration:'UNCONFIRMED',originalLifetime:'UNCONFIRMED',status:'UNCONFIRMED',holds:[],created:true};
      },true);
    }finally{hold?.release();release();}
  }
  async lookup(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution):Promise<LocalLaMaAttemptMetadataView|null>{
    const release=this.take();let hold:LocalLaMaPreparationReservation|undefined;try{
      if(this.#preparation)hold=(preparationMethods.acquire.value as LocalLaMaNativePreparation['acquire']).call(this.#preparation);const captured=this.capture(input,capture,full);return await this.verifier.transaction(captured.input.accountId!,async tx=>{const current=await this.read(tx,captured,false,hold);if(!current.view)await this.noLater(tx,captured,current.rows,current.prepared);return current.view;},true);}finally{hold?.release();release();}
  }
  async append(input:StageInput,capture:LocalLaMaCapture,full:CapturedFullStageExecution,originalValue:LocalLaMaOriginalInvocation,value:LocalLaMaAttemptMetadata):Promise<LocalLaMaAttemptMetadataView>{
    const release=this.take();let hold:LocalLaMaPreparationReservation|undefined;try{
      if(this.#preparation)hold=(preparationMethods.acquire.value as LocalLaMaNativePreparation['acquire']).call(this.#preparation);
      const captured=this.capture(input,capture,full),original=this.original(own(originalValue,this.verifier.bounds.maxRecordBytes).value),record=this.metadata(own(value,this.verifier.bounds.maxRecordBytes).value,original,captured);
      return await this.verifier.transaction(captured.input.accountId!,async tx=>{
        const current=await this.read(tx,captured,false,hold),view=current.view;must(view&&digest(view.original)===digest(original),unconfirmed);if(view.records.some(item=>item.record.recordDigest===record.recordDigest))return view;must(current.rows.length<this.verifier.bounds.maxRecords,capacity);
        const previous=view.records.at(-1)?.envelopeDigest??view.originalEnvelopeDigest,envelope:MetadataEnvelope={version:1,ordinal:view.records.length+1,previousEnvelopeDigest:previous,original,record},sha=await this.insert(tx,this.wrapper(captured.input,metadataKind,envelope));
        const records=[...view.records,{ordinal:envelope.ordinal,previousEnvelopeDigest:previous,envelopeDigest:sha,record}],holds=this.conflicts(records.map(item=>item.record));return {...view,records,status:holds.length?'HOLD':'UNCONFIRMED',holds};
      },true);
    }finally{hold?.release();release();}
  }
}
