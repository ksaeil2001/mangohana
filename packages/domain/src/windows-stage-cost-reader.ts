import {types} from 'node:util';
import type {Database,Transaction} from '../../storage/src/database.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import {nativeJsonBytes,nativeTasks} from '../../native/src/dto.js';
import {canonicalInput,type StageInput} from './provider.js';
import type {FullStageCostBasis} from './full-stage-cost-journal.js';
import type {CheckpointValidationAttempt,CheckpointValidationFacts} from './checkpoint-validation.js';
import type {OperationalStageCostReader,OperationalStageCostWorkSet,CostEvidenceRef} from './pipeline-stage-cost.js';
import {WindowsNativeCostJournal,isWindowsNativeCostJournal,validateWindowsNativeCostOwner,type WindowsNativeCostOwner,type WindowsStageOwnerSelector,type WindowsNativeOriginalKey,type WindowsNativeEvidenceFacts} from './windows-native-cost.js';
import {validateWindowsNativeOriginalKey} from './native-receipts.js';

export interface NonWindowsStageCostReader{
  nonWindowsIn(tx:Transaction,input:StageInput,basis:FullStageCostBasis):Promise<OperationalStageCostWorkSet|null>;
  checkpointFactsIn(tx:Transaction,input:StageInput,attempt:CheckpointValidationAttempt):Promise<CheckpointValidationFacts|null>;
}
export const windowsStageCostBounds=Object.freeze({maxNativeJobs:64,maxScopes:64,maxCalls:256,maxComponents:64,maxIo:1024,maxResultQueries:1024,maxCacheUses:1024,maxSummaryBytes:8388608,maxSourceBytes:16777216,maxRecordBytes:1572864,maxActionBytes:67108864,maxNodes:67108864,maxDepth:64});
export type WindowsStageCostBounds={[K in keyof typeof windowsStageCostBounds]:number};
export type WindowsStageCostReaderOptions={db:Database;windows:WindowsNativeCostJournal;nonWindows:NonWindowsStageCostReader;bounds:WindowsStageCostBounds};
type Ref=CostEvidenceRef;
type Completion={kind:'EXECUTION'|'TERMINAL_PREPARATION';refs:Ref[]};
type RawRow={kind:string;id:string;ref:Ref|null;contentDigest:string;completedAt:string|null};
type Manifest={version:1;chunkSize:256;counts:{kind:string;count:number}[];leaves:{kind:string;chunk:number;count:number;digest:string}[]};
type Original={key:WindowsNativeOriginalKey|null;scopeRef:Ref|null;callRef:Ref|null;componentId:string|null;sourceOperation:Ref|null;sourceTermination:Ref|null;classification:'FRESH'|'CACHE'|'UNCONFIRMED'};
type Census={version:1;mode:'CENSUS';owner:WindowsNativeCostOwner;root:{ref:Ref;components:{task:string;componentId:string}[];componentsDigest:string};inputRef:Ref;basisRef:Ref;rawSetDigest:string;manifest:Manifest;rows:RawRow[];originals:Original[];completion:Completion|null};
type Membership={version:1;rawSetDigest:string;scopeRefs:Ref[];attributionRefs:Ref[];absenceRefs:Ref[];terminationRefs:Ref[];nonWindowsWorkSetDigest:string;componentMappingDigest:string;completion:Completion};
type Candidate={version:1;rawSetDigest:string;membershipDigest:string;nonWindowsWorkSet:OperationalStageCostWorkSet;workSet:OperationalStageCostWorkSet;completion:Completion};
type SealValue=Membership&{executionId:string;inputFingerprint:string;basisRef:Ref;membershipDigest:string};
type Seal={version:1;mode:'SEALED';ref:Ref;value:SealValue;workSet:OperationalStageCostWorkSet};
type RecordRow={evidence_id:string;evidence_digest:string;kind:string;protected_evidence_ref:string;protected_observation:unknown;execution_id:string};
type Budget={bytes:number;nodes:number};
type JsonSize={bytes:number;estimated:number;depth:number};
type SourceCache=Map<string,{ref:Ref;kind:string;value:unknown;bytes:number;estimated:number;depth:number}>;
type Step=<T>(action:(tx:Transaction)=>Promise<T>)=>Promise<T>;
type Projection={version:1;kind:'NATIVE'|'ABSENCE';operation:Ref;termination:Ref;value?:Absence};
type Absence={version:1;componentId:string;rawSetDigest:string;basisRef:Ref;operationId:string;eventId:string;quantity:'0';unit:'windows-job-cpu-second-v1'};
const readers=new WeakMap<object,Database>(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hash=/^[a-f0-9]{64}$/;
const invalid='WINDOWS_STAGE_COST_UNCONFIRMED',unit='windows-job-cpu-second-v1',refKeys=['evidenceId','evidenceDigest'] as const;
const rawKinds=new Set('ENROLLMENT ROOT SCOPE SCOPE_END CALL BINDING IO_START IO_END RESULT_QUERY RESULT_CLAIM RESULT_ACK CACHE_USE INTENT RESERVATION ADOPTION ATTEMPT CONTROLLER_EVENT GO_GRANT GO_CONSUMPTION OBSERVATION ORIGIN WINDOWS_EVENT WINDOWS_RECORD WINDOWS_LINK RAW_RESULT RAW_OBJECT EVIDENCE'.split(' '));
function must(value:unknown):asserts value{requireCondition(value,invalid,409,'WAIT');}
function closed(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
  must(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);const fields=Object.getOwnPropertyDescriptors(value);must(Reflect.ownKeys(value).length===keys.length&&keys.every(k=>fields[k]?.enumerable&&'value'in fields[k]));
}
function same(a:unknown,b:unknown):boolean{return digest(a)===digest(b);}
function ref(value:unknown):Ref{closed(value,refKeys);must(typeof value.evidenceId==='string'&&uuid.test(value.evidenceId)&&typeof value.evidenceDigest==='string'&&hash.test(value.evidenceDigest));return value as Ref;}
function compare(a:string,b:string):number{return a<b?-1:a>b?1:0;}
function sortRefs(values:Ref[]):Ref[]{return [...values].sort((a,b)=>compare(a.evidenceId,b.evidenceId)||compare(a.evidenceDigest,b.evidenceDigest));}
function refs(value:unknown,empty=true):Ref[]{must(Array.isArray(value)&&(empty||value.length>0)&&value.length<=2046);const ids=new Set<string>();for(const item of value){const r=ref(item);must(!ids.has(r.evidenceId));ids.add(r.evidenceId);}return sortRefs(value);}
function method<T extends object,K extends keyof T>(object:T,key:K):T[K]{let at:object|null=object;must(object!==null&&typeof object==='object'&&!types.isProxy(object));for(let depth=0;at&&depth<8;depth++){must(!types.isProxy(at));const field=Object.getOwnPropertyDescriptor(at,key);if(field){must('value'in field&&typeof field.value==='function'&&!types.isProxy(field.value));return Function.prototype.bind.call(field.value,object) as T[K];}at=Object.getPrototypeOf(at);}must(false);}
function cpu(ticks:bigint):string{const integer=ticks/10000000n,fraction=(ticks%10000000n).toString().padStart(7,'0').replace(/0+$/,'');return integer.toString()+(fraction?'.'+fraction:'');}
function accounting(facts:WindowsNativeEvidenceFacts):{ticks:bigint;eventId:string}{if(facts.accounting===null){must(facts.termination.kind==='NO_CHILD_CREATED');return {ticks:0n,eventId:facts.observations.termination.evidenceId};}const {userTime100ns,kernelTime100ns}=facts.accounting.value;return {ticks:BigInt(userTime100ns)+BigInt(kernelTime100ns),eventId:facts.accounting.event.eventId};}
export function isWindowsStageCostReader(value:unknown,db:Database):value is WindowsStageCostReader{return typeof value==='object'&&value!==null&&readers.get(value)===db;}

export class WindowsStageCostReader implements OperationalStageCostReader{
  private readonly bounds:Readonly<WindowsStageCostBounds>;
  private readonly db:Database;
  private readonly transaction:Database['accountTransaction'];
  private readonly lookup:WindowsNativeCostJournal['stageLookupIn'];
  private readonly project:WindowsNativeCostJournal['stageProjectIn'];
  private readonly seal:WindowsNativeCostJournal['stageSealIn'];
  private readonly originalFacts:WindowsNativeCostJournal['stageOriginalFactsIn'];
  private readonly nonWindowsIn:NonWindowsStageCostReader['nonWindowsIn'];
  private readonly checkpoint:NonWindowsStageCostReader['checkpointFactsIn'];
  private readonly candidates=new WeakMap<OperationalStageCostWorkSet,{owner:WindowsNativeCostOwner;candidate:Candidate;digest:string;inputFingerprint:string;basisDigest:string;budget:Budget|null;cache:SourceCache|null}>();
  constructor(options:WindowsStageCostReaderOptions){
    closed(options,['db','windows','nonWindows','bounds']);closed(options.bounds,Object.keys(windowsStageCostBounds));
    for(const [key,maximum] of Object.entries(windowsStageCostBounds)){const v=options.bounds[key as keyof WindowsStageCostBounds];must(Number.isSafeInteger(v)&&v>0&&v<=maximum);}
    must(!types.isProxy(options.db)&&Object.getOwnPropertyDescriptor(options.db,'role')?.value==='trio_web_worker'&&isWindowsNativeCostJournal(options.windows,options.db));
    this.bounds=Object.freeze({...options.bounds});this.db=options.db;this.transaction=method(options.db,'accountTransaction');this.lookup=method(options.windows,'stageLookupIn');this.project=method(options.windows,'stageProjectIn');this.seal=method(options.windows,'stageSealIn');this.originalFacts=method(options.windows,'stageOriginalFactsIn');this.nonWindowsIn=method(options.nonWindows,'nonWindowsIn');this.checkpoint=method(options.nonWindows,'checkpointFactsIn');readers.set(this,options.db);
  }
  private copy<T>(value:T,maximum:number,budget:Budget):T{
    const active=new Set<object>();const walk=(item:unknown,depth:number):void=>{
      must(++budget.nodes<=this.bounds.maxNodes&&depth<=this.bounds.maxDepth&&!types.isProxy(item));
      if(typeof item==='string'){budget.bytes+=Buffer.byteLength(item,'utf8')+2;must(budget.bytes<=this.bounds.maxActionBytes);return;}
      if(item===null||typeof item==='number'||typeof item==='boolean'){must(typeof item!=='number'||Number.isFinite(item));return;}
      must(typeof item==='object'&&!active.has(item));active.add(item);const array=Array.isArray(item),keys=Reflect.ownKeys(item);must(keys.length<=this.bounds.maxNodes&&Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype));
      if(array)must(keys.length===(item as unknown[]).length+1&&keys.every(k=>typeof k==='string'&&(k==='length'||/^(0|[1-9][0-9]*)$/.test(k))));
      for(const k of keys){if(array&&k==='length')continue;must(typeof k==='string');const field=Object.getOwnPropertyDescriptor(item,k);must(field?.enumerable&&'value'in field);budget.bytes+=Buffer.byteLength(k,'utf8')+4;must(budget.bytes<=this.bounds.maxActionBytes);walk(field.value,depth+1);}active.delete(item);
    };
    walk(value,0);const bytes=nativeJsonBytes(value,maximum);budget.bytes+=bytes.length;must(budget.bytes<=this.bounds.maxActionBytes);return JSON.parse(bytes.toString('utf8')) as T;
  }
  private measure(value:unknown,maximum:number,budget:Budget,freeze=false):JsonSize{
    const bytes=nativeJsonBytes(value,maximum).length;let extra=0,maximumDepth=0;
    const quoted=(text:string)=>{for(const character of text)if('\b\t\n\f\r'.includes(character))extra+=4;};
    const walk=(item:unknown,depth:number):void=>{
      must(++budget.nodes<=this.bounds.maxNodes);maximumDepth=Math.max(maximumDepth,depth);
      if(typeof item==='string'){quoted(item);return;}if(item===null||typeof item!=='object')return;
      for(const key of Object.keys(item)){if(!Array.isArray(item))quoted(key);walk((item as Record<string,unknown>)[key],depth+1);}if(freeze)Object.freeze(item);
    };
    walk(value,0);const estimated=bytes+extra;must(Number.isSafeInteger(estimated)&&estimated<=maximum&&maximumDepth<=64);return {bytes,estimated,depth:maximumDepth};
  }
  private async attempt<T>(action:()=>Promise<T>):Promise<T|null>{try{return await action();}catch(error){if(error instanceof DomainError)return null;throw error;}}
  private wrap(input:StageInput,kind:string,value:unknown){return {version:1,accountId:input.accountId!,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),kind,value};}
  private async record(tx:Transaction,executionId:string,value:Ref,budget:Budget,maximum=1048576):Promise<RecordRow>{
    const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,kind,execution_id,protected_evidence_ref,CASE WHEN octet_length(protected_observation::text)<=$4 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND evidence_id=$3 LIMIT 2`,[tx.account.account_id,executionId,value.evidenceId,maximum])).rows;
    must(rows.length===1);const row=rows[0];row.protected_observation=this.copy(row.protected_observation,maximum,budget);must(row.protected_observation!==null&&row.execution_id===executionId&&row.evidence_id===value.evidenceId&&row.protected_evidence_ref===row.evidence_id&&row.evidence_digest===value.evidenceDigest&&digest(row.protected_observation)===value.evidenceDigest);nativeJsonBytes(row.protected_observation,maximum);return row;
  }
  private async selector(tx:Transaction,input:StageInput,basis:FullStageCostBasis,budget:Budget):Promise<WindowsStageOwnerSelector>{
    must(tx.account.account_id===input.accountId&&uuid.test(input.executionId)&&basis.capture.executionId===input.executionId&&basis.capture.inputFingerprint===digest(canonicalInput(input)));
    const rows=(await tx.client.query<RecordRow>(`SELECT evidence_id,evidence_digest,kind,execution_id,protected_evidence_ref,CASE WHEN octet_length(protected_observation::text)<=1048576 THEN protected_observation ELSE NULL END AS protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN('INPUT','OPERATIONAL_COST_BASIS') ORDER BY kind,evidence_id LIMIT 3`,[input.accountId,input.executionId])).rows;
    must(rows.length===2);for(const row of rows)row.protected_observation=this.copy(row.protected_observation,1048576,budget);const i=rows.find(row=>row.kind==='INPUT'),b=rows.find(row=>row.kind==='OPERATIONAL_COST_BASIS');must(i&&b&&i.evidence_digest===digest(canonicalInput(input))&&same(i.protected_observation,canonicalInput(input))&&same(b.protected_observation,this.wrap(input,'OPERATIONAL_COST_BASIS',basis)));
    for(const r of rows)must(r.protected_evidence_ref===r.evidence_id&&digest(r.protected_observation)===r.evidence_digest);
    return {executionId:input.executionId,inputEvidenceId:i.evidence_id,inputFingerprint:i.evidence_digest,basisRef:{evidenceId:b.evidence_id,evidenceDigest:b.evidence_digest}};
  }
  private normal(work:OperationalStageCostWorkSet,input:StageInput,basis:FullStageCostBasis):OperationalStageCostWorkSet{
    closed(work,['version','executionId','inputFingerprint','captureDigest','completion','joinedEvidence','terminationEvidence','sources','facts']);must(work.version===1&&work.executionId===input.executionId&&work.inputFingerprint===digest(canonicalInput(input))&&work.captureDigest===basis.captureDigest&&['EXECUTION','TERMINAL_PREPARATION'].includes(work.completion));
    work.joinedEvidence=refs(work.joinedEvidence,false);work.terminationEvidence=refs(work.terminationEvidence,false);must(work.joinedEvidence.length+work.terminationEvidence.length<=2046);const joined=new Map(work.joinedEvidence.map(r=>[r.evidenceId,r.evidenceDigest]));must(work.terminationEvidence.every(r=>!joined.has(r.evidenceId)));
    must(Array.isArray(work.sources)&&work.sources.length<=2046);const ids=new Set<string>(),assigned=new Set<string>();
    for(const source of work.sources){closed(source,['sourceOperationId','sourceEventId','target','componentId','evidence']);for(const id of [source.sourceOperationId,source.sourceEventId]){must(typeof id==='string'&&id.length>0&&id.length<=128&&!ids.has(id));ids.add(id);}must(['PROVIDER','QUANTITY','ALLOCATION'].includes(source.target)&&(source.target==='QUANTITY'?typeof source.componentId==='string'&&source.componentId.length>0:source.componentId===null));source.evidence=refs(source.evidence,false);for(const r of source.evidence){must(joined.get(r.evidenceId)===r.evidenceDigest&&!assigned.has(r.evidenceId));assigned.add(r.evidenceId);}}
    work.sources.sort((a,b)=>compare(a.sourceOperationId,b.sourceOperationId)||compare(a.sourceEventId,b.sourceEventId));closed(work.facts,['provider','quantities','allocation']);must(work.facts.provider!==null&&work.facts.allocation!==null&&Array.isArray(work.facts.quantities));
    for(const [fact,target,component] of [[work.facts.provider,'PROVIDER',null],[work.facts.allocation,'ALLOCATION',null],...work.facts.quantities.map(q=>[q,'QUANTITY',q.componentId])] as const){must(fact&&typeof fact==='object'&&'evidenceRefs'in fact&&Array.isArray(fact.evidenceRefs));const allowed=new Set(work.sources.filter(s=>s.target===target&&s.componentId===component).flatMap(s=>s.evidence.map(r=>r.evidenceId)));must(allowed.size>0&&fact.evidenceRefs.length===allowed.size&&new Set(fact.evidenceRefs).size===allowed.size&&fact.evidenceRefs.every((id:unknown)=>typeof id==='string'&&allowed.has(id)));fact.evidenceRefs.sort(compare);}
    must(work.sources.every(source=>source.target!=='QUANTITY'||work.facts.quantities!.some(fact=>fact.componentId===source.componentId)));work.facts.quantities.sort((a,b)=>compare(a.componentId,b.componentId));must(new Set(work.facts.quantities.map(q=>q.componentId)).size===work.facts.quantities.length);return work;
  }
  private completion(value:unknown):Completion{
    closed(value,['kind','refs']);must(value.kind==='EXECUTION'||value.kind==='TERMINAL_PREPARATION');return {kind:value.kind,refs:refs(value.refs,false)};
  }
  private census(value:unknown,selector:WindowsStageOwnerSelector):Census{
    closed(value,['version','mode','owner','root','inputRef','basisRef','rawSetDigest','manifest','rows','originals','completion']);const c=value as unknown as Census;
    must(c.version===1&&c.mode==='CENSUS');const owner=validateWindowsNativeCostOwner(c.owner);must(owner.executionId===selector.executionId&&owner.inputEvidenceId===selector.inputEvidenceId&&owner.inputFingerprint===selector.inputFingerprint&&same(owner.basisRef,selector.basisRef)&&same(ref(c.inputRef),{evidenceId:selector.inputEvidenceId,evidenceDigest:selector.inputFingerprint})&&same(ref(c.basisRef),selector.basisRef));
    closed(c.root,['ref','components','componentsDigest']);ref(c.root.ref);must(Array.isArray(c.root.components)&&c.root.components.length>0&&c.root.components.length<=this.bounds.maxComponents&&c.root.componentsDigest===digest(c.root.components));const tasks=new Set<string>();
    for(const component of c.root.components){closed(component,['task','componentId']);must(nativeTasks.includes(component.task as typeof nativeTasks[number])&&!tasks.has(component.task)&&typeof component.componentId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(component.componentId));tasks.add(component.task);}
    must(Array.isArray(c.rows)&&c.rows.length<=16384);const groups=new Map<string,RawRow[]>();let prior='';
    for(const row of c.rows){closed(row,['kind','id','ref','contentDigest','completedAt']);must(rawKinds.has(row.kind)&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(row.id)&&hash.test(row.contentDigest)&&(row.completedAt===null||typeof row.completedAt==='string'&&row.completedAt.length<=128&&Number.isFinite(Date.parse(row.completedAt))));if(row.ref!==null)ref(row.ref);const id=row.kind+'/'+row.id;must(!prior||compare(prior,id)<0);prior=id;const list=groups.get(row.kind)??[];list.push(row);groups.set(row.kind,list);}
    const counts:{kind:string;count:number}[]=[],leaves:Manifest['leaves']=[];
    for(const [kind,rows] of groups){counts.push({kind,count:rows.length});for(let start=0;start<rows.length;start+=256){const chunk=start/256,part=rows.slice(start,start+256),body={version:1,kind,chunk,rows:part};nativeJsonBytes(body,1048576);leaves.push({kind,chunk,count:part.length,digest:digest(body)});}}
    must(same(c.manifest,{version:1,chunkSize:256,counts,leaves})&&hash.test(c.rawSetDigest)&&c.rawSetDigest===digest(c.manifest));
    for(const [kind,cap] of [['ENROLLMENT',1],['ROOT',1],['SCOPE',this.bounds.maxScopes],['SCOPE_END',this.bounds.maxScopes],['CALL',this.bounds.maxCalls],['BINDING',this.bounds.maxNativeJobs],['IO_START',this.bounds.maxIo],['IO_END',this.bounds.maxIo],['RESULT_QUERY',this.bounds.maxResultQueries],['RESULT_CLAIM',this.bounds.maxResultQueries],['RESULT_ACK',this.bounds.maxResultQueries],['CACHE_USE',this.bounds.maxCacheUses]] as const)must((groups.get(kind)?.length??0)<=cap);
    for(const [start,end] of [['SCOPE','SCOPE_END'],['IO_START','IO_END'],['RESULT_QUERY','RESULT_ACK']] as const){const a=groups.get(start)??[],b=groups.get(end)??[];must(a.length===b.length&&a.every(x=>b.some(y=>y.id===x.id&&y.completedAt!==null)));}
    must(Array.isArray(c.originals)&&c.originals.length<=this.bounds.maxNativeJobs);const jobs=new Set<string>();
    for(const item of c.originals){closed(item,['key','scopeRef','callRef','componentId','sourceOperation','sourceTermination','classification']);must(item.classification==='FRESH'||item.classification==='CACHE');must(item.key!==null);const key=validateWindowsNativeOriginalKey(item.key);must(!jobs.has(key.binding.jobId));jobs.add(key.binding.jobId);if(item.scopeRef!==null)ref(item.scopeRef);if(item.callRef!==null)ref(item.callRef);if(item.sourceOperation!==null)ref(item.sourceOperation);if(item.sourceTermination!==null)ref(item.sourceTermination);
      if(item.classification==='FRESH'){must(item.scopeRef&&item.callRef&&item.sourceOperation&&item.sourceTermination&&typeof item.componentId==='string'&&c.root.components.some(x=>x.componentId===item.componentId));must((groups.get('SCOPE')??[]).some(row=>same(row.ref,item.scopeRef))&&(groups.get('CALL')??[]).some(row=>same(row.ref,item.callRef)));}}
    must(c.completion!==null);c.completion=this.completion(c.completion);return c;
  }
  private async original(tx:Transaction,owner:WindowsNativeCostOwner,key:WindowsNativeOriginalKey,bridge:{operation:Ref|null;termination:Ref|null},cache:SourceCache,budget:Budget):Promise<WindowsNativeEvidenceFacts>{
    const response=this.copy(await this.lookup(tx,{version:1,mode:'ORIGINAL',owner,key},this.bounds.maxNativeJobs),1576960,budget);closed(response,['version','mode','key','inputRef','basisRef','bundle']);must(response.version===1&&response.mode==='ORIGINAL'&&same(response.key,key));
    const bundle=response.bundle;closed(bundle,['state','observationDigests','original','job']);must(bundle.state!==null&&typeof bundle.state==='object');const state=bundle.state as {facts:{input:{evidenceId:string;evidenceDigest:string;value:unknown};basis:{evidenceId:string;evidenceDigest:string;value:unknown}|null}};
    const read=async(value:unknown,kind:string):Promise<SourceCache extends Map<string,infer T>?T:never>=>{const r=ref(value);const saved=cache.get(r.evidenceId);if(saved){must(same(saved.ref,r)&&saved.kind===kind);return saved;}
      const raw=this.copy(await this.lookup(tx,{version:1,mode:'SOURCE',owner,ref:r},this.bounds.maxNativeJobs),135168,budget);closed(raw,['version','mode','ref','kind','value']);must(raw.version===1&&raw.mode==='SOURCE'&&raw.kind===kind&&same(raw.ref,r)&&digest(raw.value)===r.evidenceDigest);const size=this.measure(raw.value,131072,budget,true),stored={ref:Object.freeze({...r}),kind,value:raw.value,...size};cache.set(r.evidenceId,stored);let bytes=0;for(const v of cache.values())bytes+=v.bytes;must(bytes<=this.bounds.maxSourceBytes);return stored;};
    const compact=this.measure(bundle,1576960,budget);budget.bytes+=compact.bytes;must(budget.bytes<=this.bounds.maxActionBytes);
    let bytes=compact.bytes,estimated=compact.estimated,depth=compact.depth;
    const hydrate=(source:JsonSize)=>{must(++budget.nodes<=this.bounds.maxNodes);bytes+=source.bytes-4;estimated+=source.estimated-4;depth=Math.max(depth,source.depth+4);must(Number.isSafeInteger(bytes)&&Number.isSafeInteger(estimated));};
    const input=ref(response.inputRef);must(state.facts.input.value===null&&state.facts.input.evidenceId===input.evidenceId&&state.facts.input.evidenceDigest===input.evidenceDigest);const sourceInput=await read(input,'INPUT');hydrate(sourceInput);state.facts.input.value=sourceInput.value;
    if(response.basisRef===null)must(state.facts.basis===null);else{const b=ref(response.basisRef);must(state.facts.basis!==null&&state.facts.basis.value===null&&state.facts.basis.evidenceId===b.evidenceId&&state.facts.basis.evidenceDigest===b.evidenceDigest);const sourceBasis=await read(b,'OPERATIONAL_COST_BASIS');hydrate(sourceBasis);state.facts.basis.value=sourceBasis.value;}
    must(bytes<=this.bounds.maxRecordBytes&&estimated<=this.bounds.maxRecordBytes&&depth<=64);
    const facts=await this.originalFacts(tx,bundle,key,bridge);must(facts!==null);return this.copy(facts,131072,budget);
  }
  private nativeValues(input:StageInput,owner:WindowsNativeCostOwner,original:Original,facts:WindowsNativeEvidenceFacts){
    must(original.scopeRef&&original.callRef&&original.sourceOperation&&original.sourceTermination&&original.componentId);const measured=accounting(facts);
    const operation={version:1,owner,scopeRef:original.scopeRef,callRef:original.callRef,componentId:original.componentId,source:facts.source,jobId:facts.binding.jobId,sourceOperation:original.sourceOperation,sourceTermination:original.sourceTermination,windowsEvidenceRef:facts.windowsEvidenceRef,sourceOperationId:facts.binding.jobId,sourceEventId:measured.eventId,accounting:facts.accounting,quantity:cpu(measured.ticks),unit};
    const termination={version:1,owner,scopeRef:original.scopeRef,callRef:original.callRef,componentId:original.componentId,source:facts.source,jobId:facts.binding.jobId,sourceTermination:original.sourceTermination,windowsEvidenceRef:facts.windowsEvidenceRef,terminationObservation:facts.observations.termination,termination:facts.termination};
    return {operation:this.wrap(input,'WINDOWS_NATIVE_COST_ATTRIBUTION',operation),termination:this.wrap(input,'WINDOWS_NATIVE_COST_TERMINATION',termination),measured};
  }
  private projection(value:unknown,kind:'NATIVE'|'ABSENCE',operation:unknown,termination:unknown):Projection{
    closed(value,kind==='NATIVE'?['version','kind','operation','termination']:['version','kind','operation','termination','value']);const p=value as unknown as Projection;must(p.version===1&&p.kind===kind);ref(p.operation);ref(p.termination);must(p.operation.evidenceId!==p.termination.evidenceId&&p.operation.evidenceDigest===digest(operation)&&p.termination.evidenceDigest===digest(termination));return p;
  }
  private membership(census:Census,nonWindows:OperationalStageCostWorkSet,projections:Projection[]):Membership{
    return {version:1,rawSetDigest:census.rawSetDigest,scopeRefs:sortRefs(census.rows.filter(row=>row.kind==='SCOPE').map(row=>{must(row.ref!==null);return ref(row.ref);})),attributionRefs:sortRefs(projections.filter(p=>p.kind==='NATIVE').map(p=>p.operation)),absenceRefs:sortRefs(projections.filter(p=>p.kind==='ABSENCE').map(p=>p.operation)),terminationRefs:sortRefs(projections.map(p=>p.termination)),nonWindowsWorkSetDigest:digest(nonWindows),componentMappingDigest:census.root.componentsDigest,completion:census.completion!};
  }
  private async verifySeal(tx:Transaction,inputValue:StageInput,basisValue:FullStageCostBasis,raw:unknown,budget:Budget,cache:SourceCache=new Map()):Promise<Seal>{
    const input=this.copy(inputValue,1048576,budget),basis=this.copy(basisValue,1048576,budget),reply=this.copy(raw,2101248,budget);closed(reply,['version','mode','ref','value','workSet']);const seal=reply as unknown as Seal;must(seal.version===1&&seal.mode==='SEALED');ref(seal.ref);
    const value=seal.value;closed(value,['version','executionId','inputFingerprint','basisRef','rawSetDigest','membershipDigest','scopeRefs','attributionRefs','absenceRefs','terminationRefs','nonWindowsWorkSetDigest','componentMappingDigest','completion']);const selector=await this.selector(tx,input,basis,budget);
    must(value.version===1&&value.executionId===input.executionId&&value.inputFingerprint===selector.inputFingerprint&&same(value.basisRef,selector.basisRef)&&hash.test(value.rawSetDigest)&&hash.test(value.membershipDigest)&&hash.test(value.nonWindowsWorkSetDigest)&&hash.test(value.componentMappingDigest));
    for(const list of [value.scopeRefs,value.attributionRefs,value.absenceRefs,value.terminationRefs])refs(list);this.completion(value.completion);
    const membership:Membership={version:1,rawSetDigest:value.rawSetDigest,scopeRefs:value.scopeRefs,attributionRefs:value.attributionRefs,absenceRefs:value.absenceRefs,terminationRefs:value.terminationRefs,nonWindowsWorkSetDigest:value.nonWindowsWorkSetDigest,componentMappingDigest:value.componentMappingDigest,completion:value.completion};must(digest(membership)===value.membershipDigest&&digest(this.wrap(input,'WINDOWS_STAGE_COST_SEAL',value))===seal.ref.evidenceDigest);
    const sealRow=await this.record(tx,input.executionId,seal.ref,budget);must(sealRow.kind==='WINDOWS_STAGE_COST_SEAL'&&same(sealRow.protected_observation,this.wrap(input,'WINDOWS_STAGE_COST_SEAL',value)));
    const work=this.normal(seal.workSet,input,basis);must(work.completion===value.completion.kind&&work.terminationEvidence.some(r=>same(r,seal.ref)));const derived=new Set([...value.attributionRefs,...value.absenceRefs].map(r=>r.evidenceId)),ending=new Set([...value.terminationRefs,seal.ref].map(r=>r.evidenceId));
    const windowsSources=work.sources.filter(source=>source.evidence.some(r=>derived.has(r.evidenceId)));must(windowsSources.length===derived.size&&windowsSources.every(source=>source.target==='QUANTITY'&&source.componentId!==null&&source.evidence.length===1));
    const components=new Set(windowsSources.map(source=>source.componentId)),nonWindows=this.normal({...this.copy(work,1048576,budget),joinedEvidence:work.joinedEvidence.filter(r=>!derived.has(r.evidenceId)),terminationEvidence:work.terminationEvidence.filter(r=>!ending.has(r.evidenceId)),sources:work.sources.filter(source=>!source.evidence.some(r=>derived.has(r.evidenceId))),facts:{...work.facts,quantities:work.facts.quantities!.filter(q=>!components.has(q.componentId))}},input,basis);must(digest(nonWindows)===value.nonWindowsWorkSetDigest);
    const measured=new Map<string,{ticks:bigint;refs:Ref[]}>(),actualTerminations:Ref[]=[];
    for(const opRef of [...value.attributionRefs,...value.absenceRefs]){
      const row=await this.record(tx,input.executionId,opRef,budget,32768),wrapper=row.protected_observation;closed(wrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);must(wrapper.accountId===input.accountId&&wrapper.executionId===input.executionId&&wrapper.inputDigest===input.inputDigest&&wrapper.inputFingerprint===selector.inputFingerprint);
      let componentId:string,ticks:bigint,sourceOperationId:string,sourceEventId:string,termRef:Ref;
      if(row.kind==='WINDOWS_NATIVE_COST_ATTRIBUTION'){
        const op=wrapper.value;closed(op,['version','owner','scopeRef','callRef','componentId','source','jobId','sourceOperation','sourceTermination','windowsEvidenceRef','sourceOperationId','sourceEventId','accounting','quantity','unit']);must(typeof op.componentId==='string');componentId=op.componentId;
        const owner=validateWindowsNativeCostOwner(op.owner),source=op.source as WindowsNativeEvidenceFacts['source'];const originalOperation=await this.record(tx,source.input.executionId,ref(op.sourceOperation),budget,32768),originalWrapper=originalOperation.protected_observation;closed(originalWrapper,['version','accountId','executionId','inputDigest','inputFingerprint','kind','value']);const originalValue=originalWrapper.value as {binding:WindowsNativeOriginalKey['binding']};
        const key=validateWindowsNativeOriginalKey({binding:originalValue.binding,expected:op.windowsEvidenceRef}),original:Original={key,scopeRef:ref(op.scopeRef),callRef:ref(op.callRef),componentId,sourceOperation:ref(op.sourceOperation),sourceTermination:ref(op.sourceTermination),classification:'FRESH'},facts=await this.original(tx,owner,key,{operation:original.sourceOperation,termination:original.sourceTermination},cache,budget),body=this.nativeValues(input,owner,original,facts);must(same(body.operation,wrapper));
        termRef=value.terminationRefs.find(r=>r.evidenceDigest===digest(body.termination))!;must(termRef);const term=await this.record(tx,input.executionId,termRef,budget,32768);must(term.kind==='WINDOWS_NATIVE_COST_TERMINATION'&&same(term.protected_observation,body.termination));ticks=body.measured.ticks;sourceOperationId=facts.binding.jobId;sourceEventId=body.measured.eventId;
      }else{
        must(row.kind==='WINDOWS_NATIVE_COST_ABSENCE');const proof=wrapper.value;closed(proof,['version','componentId','rawSetDigest','basisRef','operationId','eventId','quantity','unit']);must(proof.version===1&&typeof proof.componentId==='string'&&proof.rawSetDigest===value.rawSetDigest&&same(proof.basisRef,value.basisRef)&&typeof proof.operationId==='string'&&uuid.test(proof.operationId)&&typeof proof.eventId==='string'&&uuid.test(proof.eventId)&&proof.quantity==='0'&&proof.unit===unit);componentId=proof.componentId;ticks=0n;sourceOperationId=proof.operationId;sourceEventId=proof.eventId;
        const expected=this.wrap(input,'WINDOWS_NATIVE_COST_CENSUS_TERMINATION',proof);termRef=value.terminationRefs.find(r=>r.evidenceDigest===digest(expected))!;must(termRef);const term=await this.record(tx,input.executionId,termRef,budget,32768);must(term.kind==='WINDOWS_NATIVE_COST_CENSUS_TERMINATION'&&same(term.protected_observation,expected));
      }
      actualTerminations.push(termRef);must(windowsSources.some(s=>s.sourceOperationId===sourceOperationId&&s.sourceEventId===sourceEventId&&s.componentId===componentId&&same(s.evidence,[opRef])));const q=measured.get(componentId)??{ticks:0n,refs:[]};q.ticks+=ticks;q.refs.push(opRef);measured.set(componentId,q);
    }
    must(same(sortRefs(actualTerminations),sortRefs(value.terminationRefs)));
    for(const [componentId,q] of measured){const fact=work.facts.quantities!.find(f=>f.componentId===componentId);must(fact&&fact.captureDigest===basis.captureDigest&&fact.state==='CONFIRMED'&&fact.quantity===cpu(q.ticks)&&fact.unit===unit&&same([...fact.evidenceRefs].sort(compare),sortRefs(q.refs).map(r=>r.evidenceId)));}
    for(const r of [...work.joinedEvidence,...work.terminationEvidence])await this.record(tx,input.executionId,r,budget);return seal;
  }
  private async claimCurrent(tx:Transaction,input:StageInput,owner:WindowsNativeCostOwner):Promise<void>{
    must(tx.account.account_id===input.accountId&&owner.executionId===input.executionId);
    const rows=(await tx.client.query<{current:boolean}>(`SELECT EXISTS(SELECT 1 FROM work_items w JOIN executions e ON e.account_id=w.account_id JOIN accounts a ON a.account_id=w.account_id
      WHERE w.account_id=$1 AND w.work_item_id=$2 AND w.state='CLAIMED' AND w.claim_owner=$3 AND w.claim_generation=$4 AND w.lease_until>clock_timestamp()
      AND e.execution_id=$5 AND e.claim_generation=$4 AND e.request_id=$6 AND e.input_digest=$7 AND a.access_state='ACTIVE') AS current`,
      [input.accountId,owner.claim.workItemId,owner.claim.ownerId,owner.claim.generation,input.executionId,input.requestId,input.inputDigest])).rows;
    must(rows.length===1&&rows[0].current===true);
  }
  private async candidateWork(run:Step,value:StageInput,basisValue:FullStageCostBasis,budget:Budget,split=false):Promise<OperationalStageCostWorkSet>{
    const input=this.copy(value,1048576,budget),basis=this.copy(basisValue,1048576,budget);
    const capture=await run(async tx=>{
      const selector=await this.selector(tx,input,basis,budget);
      if(split){const existing=(await tx.client.query(`SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='WINDOWS_STAGE_COST_SEAL' LIMIT 2`,[input.accountId,input.executionId])).rows;must(existing.length===0);}
      const raw=await this.lookup(tx,{version:1,mode:'CENSUS',owner:selector},this.bounds.maxNativeJobs);must(raw!==null);const census=this.census(this.copy(raw,this.bounds.maxSummaryBytes,budget),selector);
      if(split)await this.claimCurrent(tx,input,census.owner);
      const supplied=await this.nonWindowsIn(tx,this.copy(input,1048576,budget),this.copy(basis,1048576,budget));must(supplied!==null);const nonWindows=this.normal(this.copy(supplied,1048576,budget),input,basis);
      must(nonWindows.completion===census.completion!.kind);
      for(const r of [...nonWindows.joinedEvidence,...nonWindows.terminationEvidence]){const record=await this.record(tx,input.executionId,r,budget);must(!['INPUT','OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE'].includes(record.kind));}
      if(split)await this.claimCurrent(tx,input,census.owner);return {selector,census,nonWindows};
    });
    const {selector,census,nonWindows}=capture,components=[...new Set(census.root.components.map(c=>c.componentId))].sort(compare);
    must(components.length<=this.bounds.maxComponents&&nonWindows.facts.quantities!.every(q=>!components.includes(q.componentId)));
    const step:Step=action=>run(async tx=>{if(split)await this.claimCurrent(tx,input,census.owner);const result=await action(tx);if(split)await this.claimCurrent(tx,input,census.owner);return result;});
    const cache:SourceCache=new Map(),projections:Projection[]=[],sources:OperationalStageCostWorkSet['sources']=[],quantities=new Map<string,{ticks:bigint;refs:Ref[]}>();
    // 현재 bundle·projection 한 개와 상한이 있는 원문 cache를 action이 소유한다.
    for(const original of census.originals){
      const prepared=await step(async tx=>{
        must(original.key!==null);const facts=await this.original(tx,census.owner,original.key,{operation:original.sourceOperation,termination:original.sourceTermination},cache,budget);
        if(original.classification==='CACHE')return null;must(original.componentId!==null);
        const body=this.nativeValues(input,census.owner,original,facts),key={version:1,kind:'NATIVE',originalKey:original.key,scopeRef:original.scopeRef,callRef:original.callRef,componentId:original.componentId,rawSetDigest:census.rawSetDigest};
        const projected=this.projection(this.copy(await this.project(tx,census.owner,key,this.copy(body.operation,32768,budget),this.copy(body.termination,32768,budget)),32768,budget),'NATIVE',body.operation,body.termination);
        return {projected,componentId:original.componentId,ticks:body.measured.ticks,jobId:facts.binding.jobId,eventId:body.measured.eventId};
      });
      // COMMIT이 성공한 callback의 결과만 후보에 한 번 누적한다.
      if(prepared===null)continue;projections.push(prepared.projected);const quantity=quantities.get(prepared.componentId)??{ticks:0n,refs:[]};quantity.ticks+=prepared.ticks;quantity.refs.push(prepared.projected.operation);quantities.set(prepared.componentId,quantity);
      sources.push({sourceOperationId:prepared.jobId,sourceEventId:prepared.eventId,target:'QUANTITY',componentId:prepared.componentId,evidence:[prepared.projected.operation]});
    }
    for(const componentId of components){if(quantities.has(componentId))continue;
      const prepared=await step(async tx=>{
        const key={version:1,kind:'ABSENCE',componentId,rawSetDigest:census.rawSetDigest,basisRef:selector.basisRef},rawReply=this.copy(await this.project(tx,census.owner,key,null,null),32768,budget);closed(rawReply,['version','kind','operation','termination','value']);
        const proof=rawReply.value;closed(proof,['version','componentId','rawSetDigest','basisRef','operationId','eventId','quantity','unit']);must(proof.version===1&&proof.componentId===componentId&&proof.rawSetDigest===census.rawSetDigest&&same(proof.basisRef,selector.basisRef)&&typeof proof.operationId==='string'&&uuid.test(proof.operationId)&&typeof proof.eventId==='string'&&uuid.test(proof.eventId)&&proof.operationId!==proof.eventId&&proof.quantity==='0'&&proof.unit===unit);
        const operation=this.wrap(input,'WINDOWS_NATIVE_COST_ABSENCE',proof),termination=this.wrap(input,'WINDOWS_NATIVE_COST_CENSUS_TERMINATION',proof),projected=this.projection(rawReply,'ABSENCE',operation,termination);return {projected,operationId:proof.operationId,eventId:proof.eventId};
      });
      projections.push(prepared.projected);quantities.set(componentId,{ticks:0n,refs:[prepared.projected.operation]});sources.push({sourceOperationId:prepared.operationId,sourceEventId:prepared.eventId,target:'QUANTITY',componentId,evidence:[prepared.projected.operation]});
    }
    const work=this.normal({...this.copy(nonWindows,1048576,budget),joinedEvidence:[...nonWindows.joinedEvidence,...projections.map(p=>p.operation)],terminationEvidence:[...nonWindows.terminationEvidence,...projections.map(p=>p.termination)],sources:[...nonWindows.sources,...sources],facts:{...nonWindows.facts,quantities:[...nonWindows.facts.quantities!,...components.map(componentId=>{const quantity=quantities.get(componentId)!;return {componentId,captureDigest:basis.captureDigest,state:'CONFIRMED' as const,quantity:cpu(quantity.ticks),unit,evidenceRefs:sortRefs(quantity.refs).map(r=>r.evidenceId)};})]}},input,basis);
    const membership=this.membership(census,nonWindows,projections),candidate:Candidate={version:1,rawSetDigest:census.rawSetDigest,membershipDigest:digest(membership),nonWindowsWorkSet:this.copy(nonWindows,1048576,budget),workSet:this.copy(work,1048576,budget),completion:census.completion!};
    nativeJsonBytes(work,1048576);this.candidates.set(work,{owner:census.owner,candidate,digest:digest(work),inputFingerprint:digest(canonicalInput(input)),basisDigest:digest(basis),budget:split?budget:null,cache:split?cache:null});return work;
  }
  async candidateIn(tx:Transaction,input:StageInput,basis:FullStageCostBasis):Promise<OperationalStageCostWorkSet|null>{return this.attempt(()=>this.candidateWork(action=>action(tx),input,basis,{bytes:0,nodes:0}));}
  async prepareCandidate(inputValue:StageInput,basisValue:FullStageCostBasis):Promise<OperationalStageCostWorkSet|null>{
    return this.attempt(async()=>{const budget={bytes:0,nodes:0},input=this.copy(inputValue,1048576,budget),basis=this.copy(basisValue,1048576,budget);must(input.accountId&&uuid.test(input.accountId));return this.candidateWork(action=>this.transaction(input.accountId!,action,true),input,basis,budget,true);});
  }
  async sealIn(tx:Transaction,inputValue:StageInput,basisValue:FullStageCostBasis,work:OperationalStageCostWorkSet):Promise<OperationalStageCostWorkSet|null>{
    return this.attempt(async()=>{
      const state=this.candidates.get(work);must(state);const budget=state.budget??{bytes:0,nodes:0},input=this.copy(inputValue,1048576,budget),basis=this.copy(basisValue,1048576,budget),owned=this.normal(this.copy(work,1048576,budget),input,basis);
      must(state.digest===digest(owned)&&state.inputFingerprint===digest(canonicalInput(input))&&state.basisDigest===digest(basis));
      must(state.owner.executionId===input.executionId&&state.owner.inputFingerprint===digest(canonicalInput(input)));const selector=await this.selector(tx,input,basis,budget);must(same(selector.basisRef,state.owner.basisRef)&&selector.inputEvidenceId===state.owner.inputEvidenceId);
      if(state.budget)await this.claimCurrent(tx,input,state.owner);
      await tx.client.query('SAVEPOINT windows_stage_cost_seal');
      try{
        const raw=await this.seal(tx,state.owner,state.candidate);must(raw!==null);const verified=await this.verifySeal(tx,input,basis,raw,budget,state.cache??new Map());
        must(same(verified.value.completion,state.candidate.completion)&&verified.value.membershipDigest===state.candidate.membershipDigest);
        await tx.client.query('RELEASE SAVEPOINT windows_stage_cost_seal');return verified.workSet;
      }catch(error){
        try{await tx.client.query('ROLLBACK TO SAVEPOINT windows_stage_cost_seal');await tx.client.query('RELEASE SAVEPOINT windows_stage_cost_seal');}
        catch(rollbackError){throw new AggregateError([error,rollbackError],'WINDOWS_STAGE_COST_ROLLBACK_UNCONFIRMED');}
        throw error;
      }
    });
  }
  private async sealedWork(tx:Transaction,inputValue:StageInput,basisValue:FullStageCostBasis,budget:Budget):Promise<OperationalStageCostWorkSet|null>{
    const input=this.copy(inputValue,1048576,budget),basis=this.copy(basisValue,1048576,budget),selector=await this.selector(tx,input,basis,budget),raw=await this.lookup(tx,{version:1,mode:'SEALED',owner:selector},this.bounds.maxNativeJobs);if(raw===null)return null;return (await this.verifySeal(tx,input,basis,raw,budget)).workSet;
  }
  async workSetIn(tx:Transaction,input:StageInput,basis:FullStageCostBasis):Promise<OperationalStageCostWorkSet|null>{return this.attempt(()=>this.sealedWork(tx,input,basis,{bytes:0,nodes:0}));}
  async sealedCompletionIn(tx:Transaction,input:StageInput,basis:FullStageCostBasis,work:OperationalStageCostWorkSet):Promise<'VERIFIED'|'WAIT'>{
    const result=await this.attempt(async()=>{const budget={bytes:0,nodes:0},owned=this.copy(work,1048576,budget),sealed=await this.sealedWork(tx,input,basis,budget);return sealed!==null&&same(sealed,owned);});return result===true?'VERIFIED':'WAIT';
  }
  async checkpointFactsIn(tx:Transaction,input:StageInput,attempt:CheckpointValidationAttempt):Promise<CheckpointValidationFacts|null>{return this.checkpoint(tx,input,attempt);}
}
