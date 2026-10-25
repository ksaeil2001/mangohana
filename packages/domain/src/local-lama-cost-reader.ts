import {types} from 'node:util';
import Decimal from 'decimal.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {nativeJsonBytes} from '../../native/src/dto.js';
import type {LocalLaMaCapture} from '../../providers/src/local-lama.js';
import type {LocalLaMaFullCostReader,LocalLaMaInvocationBinding} from '../../providers/src/local-lama-executor.js';
import {canonicalInput,type StageInput} from './provider.js';
import {FullStageCostCalculator,type FullStageExecutionCapture,type FullStageCostFacts} from './full-stage-cost.js';
import type {FullStageCostBasis,FullStageCostJournal,FullStageCostJournalBounds,FullStageCostJournalView} from './full-stage-cost-journal.js';

type Query=Parameters<LocalLaMaFullCostReader['lookup']>[0];
type Reply=Awaited<ReturnType<LocalLaMaFullCostReader['lookup']>>;
export type LocalLaMaWholeStageClosure=Readonly<{version:1;state:'CLOSED';bindingDigest:string;fullStageCaptureDigest:string;localCaptureDigest:string;
  invocationId:string;runtimeDigest:string;workSetDigest:string;calculationEvidenceId:string;calculationEvidenceDigest:string;factsDigest:string;evidenceRef:string}>;
// A capability-bound reader must verify immutable ENGINE/native composite/
// validation/storage lifetime joins and seal the final calculation facts. A
// CLOSED label or UUID supplied by a caller is not physical or cost authority.
// New work after the sealed set is a conflict, never a replacement cost.
export interface LocalLaMaWholeStageClosureReader{lookup(query:Query):Promise<LocalLaMaWholeStageClosure|null>}
export type LocalLaMaJournalCostOptions={input:StageInput;binding:LocalLaMaInvocationBinding;capture:LocalLaMaCapture;
  journal:Pick<FullStageCostJournal,'lookup'>;closure:LocalLaMaWholeStageClosureReader;bounds:FullStageCostJournalBounds};
const invalid='LOCAL_LAMA_COST_READER_UNCONFIRMED',conflict='LOCAL_LAMA_COST_READER_CONFLICT';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
const EqualUsd=Decimal.clone({precision:64,minE:-64,maxE:64,rounding:Decimal.ROUND_HALF_UP});
function must(condition:unknown,code=invalid):asserts condition{requireCondition(condition,code,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):void{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const fields=Object.getOwnPropertyDescriptors(value);must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&'value'in fields[key]));
}
function own<T>(value:T,maximum:number):T{
  const active=new Set<object>();
  const walk=(item:unknown,depth:number):void=>{
    must(!types.isProxy(item)&&depth<=64);if(item===null||typeof item==='boolean')return;
    if(typeof item==='string'){must(Buffer.byteLength(item)<=maximum);return;}
    if(typeof item==='number'){must(Number.isFinite(item)&&Math.abs(item)<=Number.MAX_SAFE_INTEGER);return;}
    must(item!==null&&typeof item==='object'&&!active.has(item));active.add(item);
    if(Array.isArray(item)){
      must(Object.getPrototypeOf(item)===Array.prototype&&item.length<=maximum);const keys=Reflect.ownKeys(item);must(keys.length===item.length+1&&keys.every(key=>typeof key==='string'&&(key==='length'||/^(0|[1-9][0-9]*)$/.test(key))));
      for(let at=0;at<item.length;at++){const field=Object.getOwnPropertyDescriptor(item,String(at));must(field?.enumerable&&'value'in field);walk(field.value,depth+1);}
    }else{
      must(Object.getPrototypeOf(item)===Object.prototype);const keys=Reflect.ownKeys(item);must(keys.length<=maximum&&keys.every(key=>typeof key==='string'));
      for(const key of keys){must(typeof key==='string'&&Buffer.byteLength(key)<=maximum);const field=Object.getOwnPropertyDescriptor(item,key);must(field?.enumerable&&'value'in field);walk(field.value,depth+1);}
    }
    active.delete(item);
  };
  walk(value,0);return JSON.parse(nativeJsonBytes(value,maximum).toString('utf8')) as T;
}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function method<T extends object,K extends keyof T>(port:T,key:K):T[K]{
  must(port!==null&&typeof port==='object'&&!types.isProxy(port));const prototype=Object.getPrototypeOf(port);must(!types.isProxy(prototype));
  const field=Object.getOwnPropertyDescriptor(port,key)??(prototype?Object.getOwnPropertyDescriptor(prototype,key):undefined);must(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value));return Function.prototype.bind.call(field.value,port) as T[K];
}

// Parent-only, read-only join of verified ports. It neither creates a basis nor
// proves rates/measurement, original INPUT/claim authority, stage START, debit,
// engine admission, process memory or activation. Constructor calls no port.
export class LocalLaMaJournalCostReader implements LocalLaMaFullCostReader{
  private readonly input:StageInput;
  private readonly binding:LocalLaMaInvocationBinding;
  private readonly capture:LocalLaMaCapture;
  private readonly bounds:FullStageCostJournalBounds;
  private readonly journal:LocalLaMaJournalCostOptions['journal']['lookup'];
  private readonly closure:LocalLaMaWholeStageClosureReader['lookup'];
  private originalDigest:string|null=null;
  private sealedClosure:string|null=null;
  constructor(options:LocalLaMaJournalCostOptions){
    closed(options,['input','binding','capture','journal','closure','bounds']);closed(options.bounds,['maxRecordBytes','maxRecords','calculator']);
    const b=options.bounds;must(Number.isSafeInteger(b.maxRecordBytes)&&b.maxRecordBytes>0&&b.maxRecordBytes<=2147483647&&Number.isSafeInteger(b.maxRecords)&&b.maxRecords>0&&b.maxRecords<2147483647&&Number.isSafeInteger(b.maxRecordBytes*(b.maxRecords+1))&&b.maxRecordBytes*(b.maxRecords+1)<=2147483647);new FullStageCostCalculator(null,b.calculator);this.bounds=freeze(own(b,b.maxRecordBytes));
    this.journal=method(options.journal,'lookup');this.closure=method(options.closure,'lookup');
    const captured=own({input:options.input,binding:options.binding,capture:options.capture},b.maxRecordBytes);this.input=freeze(captured.input);this.binding=freeze(captured.binding);this.capture=freeze(captured.capture);
    const input=this.input,binding=this.binding,capture=this.capture;closed(binding,['version','accountId','requestId','executionId','inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest','mode']);
    must(binding.version===1&&['FREE','PAID'].includes(binding.mode)&&input.stage==='CLEANUP'&&input.envelope&&input.accountId===binding.accountId&&input.requestId===binding.requestId&&input.executionId===binding.executionId&&input.inputDigest===binding.inputDigest&&digest(canonicalInput(input))===binding.inputFingerprint);
    for(const key of ['accountId','requestId','executionId'] as const)must(typeof binding[key]==='string'&&uuid.test(binding[key]));for(const key of ['inputDigest','inputFingerprint','fullStageCaptureDigest','localCaptureDigest'] as const)must(typeof binding[key]==='string'&&hash.test(binding[key]));
    assertWire('stageInputEnvelope',input.envelope);must(input.envelope.executionId===input.executionId&&input.envelope.requestId===input.requestId&&input.envelope.contextId===input.contextId&&input.envelope.logicalStepId==='CLEANUP'&&input.envelope.inputDigest===input.inputDigest&&input.envelope.stageContract===input.settings.contractVersion&&digest(input.envelope.capturedSettings)===digest(input.settings));
    closed(capture,['version','executionId','inputDigest','profileId','profileDigest','identity','imageSha256','imageByteLength','maskSha256','maskByteLength','captureDigest']);closed(capture.identity,['codeCommit','weightsSha256','configSha256','weightsLicenseVerified','runtimeVerified']);
    const {captureDigest,...body}=capture;must(capture.version===1&&capture.executionId===input.executionId&&capture.inputDigest===input.inputDigest&&capture.captureDigest===binding.localCaptureDigest&&digest(body)===captureDigest&&capture.profileId===input.envelope.parameterProfileVersion);
    for(const key of ['profileDigest','imageSha256','maskSha256','captureDigest'] as const)must(typeof capture[key]==='string'&&hash.test(capture[key]));
    for(const key of ['weightsSha256','configSha256'] as const)must(typeof capture.identity[key]==='string'&&hash.test(capture.identity[key]));must(typeof capture.identity.codeCommit==='string'&&/^[a-f0-9]{40}$/.test(capture.identity.codeCommit)&&typeof capture.identity.weightsLicenseVerified==='boolean'&&typeof capture.identity.runtimeVerified==='boolean');
    for(const key of ['imageByteLength','maskByteLength'] as const)must(Number.isSafeInteger(capture[key])&&capture[key]>0);
  }
  private query(value:Query):Query{
    const query=own(value,this.bounds.maxRecordBytes);closed(query,['binding','original','capture','runtime']);closed(query.original,['version','bindingDigest','localCaptureDigest','invocationId']);closed(query.runtime,['version','kind','invocationId','executionId','inputDigest','profileDigest','identityDigest']);
    must(digest(query.binding)===digest(this.binding)&&digest(query.capture)===digest(this.capture));const runtime=query.runtime,original=query.original;
    must(original.version===1&&original.bindingDigest===digest(this.binding)&&original.localCaptureDigest===this.capture.captureDigest&&typeof original.invocationId==='string'&&uuid.test(original.invocationId)&&runtime.version===1&&runtime.kind==='LOCAL_LAMA'&&runtime.invocationId===original.invocationId&&runtime.executionId===this.binding.executionId&&runtime.inputDigest===this.binding.inputDigest&&runtime.profileDigest===this.capture.profileDigest&&runtime.identityDigest===digest(this.capture.identity));
    const originalDigest=digest(original);must(this.originalDigest===null||this.originalDigest===originalDigest,conflict);this.originalDigest??=originalDigest;return query;
  }
  private seal(query:Query,value:LocalLaMaWholeStageClosure):LocalLaMaWholeStageClosure{
    const proof=own(value,this.bounds.maxRecordBytes);closed(proof,['version','state','bindingDigest','fullStageCaptureDigest','localCaptureDigest','invocationId','runtimeDigest','workSetDigest','calculationEvidenceId','calculationEvidenceDigest','factsDigest','evidenceRef']);
    must(proof.version===1&&proof.state==='CLOSED'&&proof.bindingDigest===digest(query.binding)&&proof.fullStageCaptureDigest===this.binding.fullStageCaptureDigest&&proof.localCaptureDigest===this.binding.localCaptureDigest&&proof.invocationId===query.original.invocationId&&proof.runtimeDigest===digest(query.runtime));
    for(const key of ['workSetDigest','calculationEvidenceDigest','factsDigest'] as const)must(typeof proof[key]==='string'&&hash.test(proof[key]));must(typeof proof.calculationEvidenceId==='string'&&uuid.test(proof.calculationEvidenceId)&&typeof proof.evidenceRef==='string'&&proof.evidenceRef.trim().length>0&&proof.evidenceRef.length<=160);
    const seal=digest(proof);must(this.sealedClosure===null||this.sealedClosure===seal,conflict);this.sealedClosure??=seal;return proof;
  }
  private view(value:FullStageCostJournalView):FullStageCostJournalView{
    const view=own(value,this.bounds.maxRecordBytes*(this.bounds.maxRecords+1));closed(view,['basis','state','costUsd','conflicts','calculations']);must(Array.isArray(view.conflicts)&&Array.isArray(view.calculations)&&view.calculations.length<=this.bounds.maxRecords);
    if(view.basis===null){must(view.state==='UNCONFIRMED'&&view.costUsd===null&&view.conflicts.length===0&&view.calculations.length===0);return view;}
    const basis:FullStageCostBasis=view.basis;closed(basis,['version','capture','captureDigest','snapshot','snapshotDigest']);closed(basis.capture,['accountId','executionId','inputDigest','inputFingerprint','stage','profileDigest','mode','captureDigest']);
    const raw:FullStageExecutionCapture={accountId:this.binding.accountId,executionId:this.binding.executionId,inputDigest:this.binding.inputDigest,inputFingerprint:this.binding.inputFingerprint,stage:'CLEANUP',profileDigest:basis.capture.profileDigest,mode:this.binding.mode};
    const calculator=new FullStageCostCalculator(basis.snapshot,this.bounds.calculator),initial=calculator.calculate(raw,{provider:null,quantities:null,allocation:null});
    must(basis.version===1&&basis.captureDigest===this.binding.fullStageCaptureDigest&&digest(basis.capture)===digest(initial.capture)&&basis.captureDigest===initial.captureDigest&&basis.snapshotDigest===initial.snapshotDigest&&digest(basis.snapshot)===digest(initial.snapshot));
    const conflicts=new Set<string>(),known=new Map<string,string>(),ids=new Set<string>(),facts=new Set<string>();
    const observe=(key:string,amount:string|null)=>{if(amount===null)return;const prior=known.get(key);if(prior!==undefined&&!new EqualUsd(prior).equals(amount))conflicts.add(key);else known.set(key,amount);};
    for(const record of view.calculations){
      closed(record,['evidenceId','evidenceDigest','result']);must(typeof record.evidenceId==='string'&&uuid.test(record.evidenceId)&&typeof record.evidenceDigest==='string'&&hash.test(record.evidenceDigest)&&!ids.has(record.evidenceId));ids.add(record.evidenceId);
      const supplied=own(record.result,this.bounds.calculator.maxOutputBytes),result=calculator.calculate(raw,structuredClone(supplied.facts) as FullStageCostFacts);must(digest(supplied)===digest(result)&&result.captureDigest===basis.captureDigest&&result.snapshotDigest===basis.snapshotDigest&&!facts.has(result.factsDigest));facts.add(result.factsDigest);
      const wrapped={version:1,accountId:this.binding.accountId,executionId:this.binding.executionId,inputDigest:this.binding.inputDigest,inputFingerprint:this.binding.inputFingerprint,kind:'OPERATIONAL_COST_CALCULATION',value:result};must(digest(wrapped)===record.evidenceDigest);
      if(result.breakdown.provider.confirmed)observe('PROVIDER_COST_CONFLICT',result.facts.provider?.actualUsd??null);
      const allocation=result.facts.allocation;if(allocation?.state==='CONFIRMED'&&allocation.evidenceRefs.length)observe('ALLOCATION_COST_CONFLICT',allocation.actualUsd);
      for(const quantity of result.facts.quantities??[])if(quantity.state==='CONFIRMED'&&quantity.evidenceRefs.length)observe('QUANTITY_CONFLICT:'+quantity.componentId,quantity.quantity);
      if(result.state==='CONFIRMED')observe('TOTAL_COST_CONFLICT',result.actualUsd);
    }
    const first=view.calculations.find(record=>record.result.state==='CONFIRMED'),expectedState=conflicts.size?'CONFLICT':first?'CONFIRMED':'UNCONFIRMED',expectedCost=conflicts.size?null:first?.result.actualUsd??null;
    must(view.state===expectedState&&view.costUsd===expectedCost&&digest(view.conflicts)===digest([...conflicts].sort()));must(conflicts.size===0,conflict);return view;
  }
  async lookup(value:Query):Promise<Reply>{
    // Each port gets a detached argument. No claim, prepare, append, model or
    // native work is available through this reader, including after ACK loss.
    const query=this.query(value),closedWork=await this.closure(structuredClone(query));if(closedWork===null){must(this.sealedClosure===null,conflict);return null;}
    const proof=this.seal(query,closedWork),view=this.view(await this.journal(structuredClone(this.input)));if(view.state!=='CONFIRMED')return null;
    const selected=view.calculations.filter(record=>record.evidenceId===proof.calculationEvidenceId);if(selected.length===0)return null;must(selected.length===1);const record=selected[0];
    must(record.evidenceDigest===proof.calculationEvidenceDigest&&record.result.factsDigest===proof.factsDigest,conflict);if(record.result.state!=='CONFIRMED')return null;must(record.result.actualUsd===view.costUsd&&record.result.basisVersion!==null);
    const evidenceRef=`execution-evidence:${record.evidenceId}:${record.evidenceDigest}`;must(evidenceRef.length<=160&&record.result.basisVersion.length<=160);
    return {version:1,bindingDigest:digest(this.binding),fullStageCaptureDigest:this.binding.fullStageCaptureDigest,closureEvidenceRef:proof.evidenceRef,
      fullCost:{version:1,scope:'FULL_STAGE_PROCESS',captureDigest:this.capture.captureDigest,runtimeDigest:digest(query.runtime),actualUsd:record.result.actualUsd!,evidenceRef,basisVersion:record.result.basisVersion}};
  }
}
