import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,sep} from 'node:path';
import type {Observation,ProviderAdapter,StageInput} from '../../domain/src/provider.js';
import type {Settings} from '../../contracts/src/wire.generated.js';
import {digest} from '../../contracts/src/intent.js';
import {assertWire} from '../../contracts/src/validation.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {painted,validateEditData} from '../../domain/src/scope.js';

export const localTranslationPromptContract='local-m2m100-independent-lines-v1';
export const localTranslationBlockPromptContract='local-m2m100-whole-block-v2';
export const localTranslationCt2PromptContract='local-helsinki-jpn-kor-whole-block-ct2-v1';
export const localTranslationCt2ModelId='Helsinki-NLP/Tatoeba-jpn-kor/opusTCv20210807-sepvoc_transformer-big_2022-09-15';
const ct2Revision='9d12c483567e3242a004a932b4a39b688725ee27deacefb91d5f570611032394';
const preprocessSha='b07987a34cc3fc3b2addbd82aa90a5b4fdbee37c80065ddb20fbdd0fb4fa7754',postprocessSha='039cec87f6d037fa216e918f3b0a7d4fd46517e54f4d422e73e0b4d6fc27ac0d';
const normalizationContract='helsinki-opus-preprocess-20220915-v1';
type LocalPromptContract=typeof localTranslationPromptContract|typeof localTranslationBlockPromptContract|typeof localTranslationCt2PromptContract;
const inputBytesLimit=131072,stdoutBytesLimit=262144,stderrBytesLimit=65536;
const maxInputTokens=256,maxNewTokens=128,timeoutMs=600000;
const modelId='facebook/m2m100_418M';
export type FilePin=Readonly<{path:string;sha256:string;bytesLength:number}>;
type Ct2Resources=Readonly<{sourceSentencePiece:FilePin;targetSentencePiece:FilePin;preprocess:FilePin;postprocess:FilePin}>;
export type LocalTranslationConfig=Readonly<{
  version:1;ownedTempRoot:string;python:FilePin;worker:FilePin;
  dependencyRoots:readonly string[];dependencyPins:readonly FilePin[];
  model:Readonly<{path:string;revision:string;files:readonly FilePin[]}&({id:'facebook/m2m100_418M'}|{id:typeof localTranslationCt2ModelId;ct2Resources:Ct2Resources})>;
  settings:Readonly<{modelId:string;contractVersion:string;reasoningLevel:Settings['reasoningLevel']}>;
  threads:2;promptContract?:LocalPromptContract;
}>;
export type LocalTranslationCapture={
  version:1;promptContract:LocalPromptContract;inputFingerprint:string;
  capturedInput:StageInput;capturedInputDigest:string;
  consumption:{version:1|2;sourceLanguage:'ja';targetLanguage:'ko';dataSource:'INITIAL_DATA'|'PREVIOUS_DATA';
    promptContract?:typeof localTranslationBlockPromptContract|typeof localTranslationCt2PromptContract;translationUnit?:'BLOCK';
    normalization?:{contract:typeof normalizationContract;preprocessSha256:string;postprocessSha256:string};
    items:{regionId:string;sourceText:string;sourceTextStatus:string;readingOrder:number;normalizedSourceText?:string}[];
    surroundingContextConsumed:false;terminologyConsumed:false;reasoningLevelConsumed:false};
  consumptionDigest:string;
};
type WorkerItem={regionId:string;targetText:string;inputTokenCount:number;outputTokenCount:number;eosCompleted:true};
type WorkerStart={kind:'START';version:1;executionId:string;inputFingerprint:string;consumptionDigest:string;pid:number;source:'MODEL_FORWARD_ENTERED'|'DECODE_STEP_OBSERVED'};
type WorkerReply={kind:'REPLY';version:1;executionId:string;inputFingerprint:string;consumptionDigest:string;
  outcome:'SUCCESS'|'FAILURE';started:boolean;reason:string;items:WorkerItem[];generationCount?:number};
export type LocalTranslationReceipt={
  version:1;capture:LocalTranslationCapture;configDigest:string;runtimeModel:{id:string;revision:string;threads:2;device:'cpu';maxInputTokens:256;maxNewTokens:128};
  child:{pid:number|null;spawnObserved:boolean;closeObserved:boolean;exitCode:number|null;signal:string|null;stdoutEof:boolean;stderrEof:boolean;inputClosed:boolean};
  start:WorkerStart|null;startEvidenceId:string|null;callbackInvoked:boolean;callbackConfirmed:boolean;callbackFailed:boolean;
  rawReply:WorkerReply|null;rawStdoutBase64:string;rawStderrBase64:string;stdoutOverflow:boolean;stderrOverflow:boolean;
  protocolFailure:boolean;resultFailure:boolean;rejectedReply:unknown|null;timedOut:boolean;sourcePinsVerifiedAfterClose:boolean;externalApiFeeUsd:'0';fullHostCostUsd:null;billingAuthority:false;
};
type Entry={fingerprint:string;capture:LocalTranslationCapture;promise:Promise<Observation>;receipt:LocalTranslationReceipt|null};

function must(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  must(value!==null&&typeof value==='object'&&!Array.isArray(value),'LOCAL_TRANSLATION_PROTOCOL_INVALID');
  const object=value as Record<string,unknown>;must(Object.keys(object).length===keys.length&&keys.every(key=>Object.hasOwn(object,key)),'LOCAL_TRANSLATION_PROTOCOL_INVALID');return object;
}
function deepFreeze<T>(value:T):T {if(value!==null&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;}
function underneath(root:string,file:string):boolean {const part=relative(root,file);return part!==''&&!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part);}
export function normalizeCt2Source(source:string):string {
  // Exact archive sed/Perl order, including the upstream fullwidth 1 -> quote.
  const replacements:[string,string][]=[['，',','],['。','. '],['、',','],['”','"'],['“','"'],['∶',':'],['：',':'],['？','?'],['《','"'],['》','"'],['）',')'],['！','!'],['（','('],['；',';'],['１','"'],['」','"'],['「','"'],['０','0'],['３','3'],['２','2'],['５','5'],['６','6'],['９','9'],['７','7'],['８','8'],['４','4'],['．','. '],['～','~'],['’',"'"],['…','...'],['━','-'],['〈','<'],['〉','>'],['【','['],['】',']'],['％','%']];
  let normalized=source;
  for(const [from,to] of replacements)normalized=from==='。'?normalized.replace(/。 */g,to):from==='．'?normalized.replace(/． */g,to):normalized.split(from).join(to);
  normalized=normalized.replace(/(?!\n)\p{C}/gu,' ').replace(/[\u2060\u200b\ufeff]/g,'');
  return normalized.replace(/ +/g,' ').split('\n').map(line=>line.replace(/^ +| +$/g,'')).join('\n');
}
function inputCapture(input:StageInput,config:LocalTranslationConfig):LocalTranslationCapture {
  const promptContract=config.promptContract===undefined?localTranslationPromptContract:config.promptContract;
  must(config.model.id===modelId?(promptContract===localTranslationPromptContract||promptContract===localTranslationBlockPromptContract):config.model.id===localTranslationCt2ModelId&&promptContract===localTranslationCt2PromptContract,'LOCAL_TRANSLATION_PROMPT_CONTRACT_INVALID');
  const capturedInput=structuredClone(input);delete capturedInput.claimGeneration;
  must(capturedInput.stage==='TRANSLATE'&&capturedInput.settings.sourceLanguage==='ja'&&capturedInput.settings.targetLanguage==='ko','LOCAL_TRANSLATION_UNSUPPORTED_INPUT');
  assertWire('settings',capturedInput.settings);
  must(capturedInput.settings.modelId===config.settings.modelId&&capturedInput.settings.contractVersion===config.settings.contractVersion&&capturedInput.settings.reasoningLevel===config.settings.reasoningLevel,'LOCAL_TRANSLATION_SETTINGS_MISMATCH');
  const envelope=capturedInput.envelope;must(envelope,'LOCAL_TRANSLATION_INPUT_EVIDENCE_REQUIRED');assertWire('stageInputEnvelope',envelope);
  must(envelope.executionId===capturedInput.executionId&&envelope.requestId===capturedInput.requestId&&envelope.logicalStepId==='TRANSLATE'&&envelope.inputDigest===capturedInput.inputDigest&&envelope.stageContract===capturedInput.settings.contractVersion&&digest(envelope.capturedSettings)===digest(capturedInput.settings),'LOCAL_TRANSLATION_INPUT_EVIDENCE_INVALID');
  must(Number.isSafeInteger(capturedInput.width)&&capturedInput.width>0&&Number.isSafeInteger(capturedInput.height)&&capturedInput.height>0,'LOCAL_TRANSLATION_DIMENSIONS_INVALID');
  const data=capturedInput.previousData??capturedInput.initialData;validateEditData(capturedInput.initialData,capturedInput.width,capturedInput.height);validateEditData(data,capturedInput.width,capturedInput.height);
  if(capturedInput.scope.kind==='PAINTED')must(capturedInput.paintInclusion,'LOCAL_TRANSLATION_PAINT_POLICY_REQUIRED');
  if(capturedInput.scope.kind==='REGIONS')must(new Set(capturedInput.scope.regionIds).size===capturedInput.scope.regionIds.length&&capturedInput.scope.regionIds.every(id=>data.blocks.some(block=>block.regionId===id)),'LOCAL_TRANSLATION_REGION_CAPTURE_MISMATCH');
  const selected=data.blocks.filter(block=>capturedInput.scope.kind==='PAGE'||(capturedInput.scope.kind==='REGIONS'?capturedInput.scope.regionIds.includes(block.regionId):painted(block,capturedInput.paintStrokes??[],capturedInput.paintInclusion!)));
  must(selected.length>0&&selected.length<=32&&selected.every(block=>block.sourceText.value.trim().length>0),'LOCAL_TRANSLATION_EMPTY_OR_OVERSIZED_SELECTION');
  must(new Set(envelope.regionIds).size===selected.length&&envelope.regionIds.length===selected.length&&selected.every(block=>envelope.regionIds.includes(block.regionId)),'LOCAL_TRANSLATION_REGION_CAPTURE_MISMATCH');
  const consumption:LocalTranslationCapture['consumption']={version:1,sourceLanguage:'ja',targetLanguage:'ko',dataSource:capturedInput.previousData===null?'INITIAL_DATA':'PREVIOUS_DATA',
    items:selected.map(block=>({regionId:block.regionId,sourceText:block.sourceText.value,sourceTextStatus:block.sourceText.status,readingOrder:block.geometry.readingOrder})),
    surroundingContextConsumed:false,terminologyConsumed:false,reasoningLevelConsumed:false};
  if(promptContract===localTranslationBlockPromptContract){consumption.version=2;consumption.promptContract=promptContract;consumption.translationUnit='BLOCK';}
  if(promptContract===localTranslationCt2PromptContract){
    consumption.version=2;consumption.promptContract=promptContract;consumption.translationUnit='BLOCK';
    consumption.normalization={contract:normalizationContract,preprocessSha256:preprocessSha,postprocessSha256:postprocessSha};
    for(const item of consumption.items)item.normalizedSourceText=normalizeCt2Source(item.sourceText);
  }
  const inputFingerprint=digest(capturedInput);return {version:1,promptContract,inputFingerprint,capturedInput,capturedInputDigest:inputFingerprint,consumption,consumptionDigest:digest(consumption)};
}
async function verifyPin(pin:FilePin):Promise<void>{
  must(isAbsolute(pin.path)&&/^[0-9a-f]{64}$/.test(pin.sha256)&&Number.isSafeInteger(pin.bytesLength)&&pin.bytesLength>0,'LOCAL_TRANSLATION_FILE_PIN_INVALID');
  const info=await lstat(pin.path);must(info.isFile()&&!info.isSymbolicLink()&&info.size===pin.bytesLength,'LOCAL_TRANSLATION_FILE_PIN_INVALID');
  const hash=createHash('sha256');for await(const chunk of createReadStream(pin.path))hash.update(chunk);must(hash.digest('hex')===pin.sha256,'LOCAL_TRANSLATION_FILE_PIN_INVALID');
}
async function validateConfig(config:LocalTranslationConfig):Promise<void>{
  const ct2=config.model.id===localTranslationCt2ModelId;
  must(config.version===1&&(ct2?config.model.revision===ct2Revision&&config.promptContract===localTranslationCt2PromptContract:config.model.id===modelId&&!Object.hasOwn(config.model,'ct2Resources')&&/^[0-9a-f]{40}$/.test(config.model.revision))&&config.threads===2,'LOCAL_TRANSLATION_CONFIGURATION_INVALID');
  must(isAbsolute(config.ownedTempRoot)&&isAbsolute(config.model.path)&&config.dependencyRoots.length>0&&config.dependencyPins.length>0,'LOCAL_TRANSLATION_CONFIGURATION_INVALID');
  const root=await realpath(config.ownedTempRoot);must((await stat(root)).isDirectory(),'LOCAL_TRANSLATION_CONFIGURATION_INVALID');
  const modelRoot=await realpath(config.model.path);must(underneath(root,modelRoot)&&(await stat(modelRoot)).isDirectory(),'LOCAL_TRANSLATION_PATH_INVALID');
  const worker=await realpath(config.worker.path);must(underneath(root,worker),'LOCAL_TRANSLATION_PATH_INVALID');
  for(const dependencyRoot of config.dependencyRoots){const actual=await realpath(dependencyRoot);must(underneath(root,actual)&&(await stat(actual)).isDirectory(),'LOCAL_TRANSLATION_PATH_INVALID');must(config.dependencyPins.some(pin=>underneath(actual,pin.path)),'LOCAL_TRANSLATION_DEPENDENCY_PIN_REQUIRED');}
  const required=ct2?['model.bin','config.json','source_vocabulary.json','target_vocabulary.json']:['model.safetensors','config.json','vocab.json','sentencepiece.bpe.model'];
  must(required.every(name=>config.model.files.some(pin=>relative(modelRoot,pin.path)===name)),ct2?'LOCAL_TRANSLATION_CONVERTED_FILES_REQUIRED':'LOCAL_TRANSLATION_SAFETENSORS_REQUIRED');
  for(const pin of config.model.files){const actual=await realpath(pin.path);must(underneath(modelRoot,actual)&&!/^pytorch_model.*\.bin$/i.test(relative(modelRoot,actual)),'LOCAL_TRANSLATION_MODEL_FILE_INVALID');}
  for(const pin of config.dependencyPins){const actual=await realpath(pin.path);must(config.dependencyRoots.some(dir=>underneath(dir,actual)),'LOCAL_TRANSLATION_PATH_INVALID');}
  const resources=config.model.id===localTranslationCt2ModelId?config.model.ct2Resources:null;
  if(ct2){
    closed(resources,['sourceSentencePiece','targetSentencePiece','preprocess','postprocess']);
    must(resources&&resources.preprocess.sha256===preprocessSha&&resources.postprocess.sha256===postprocessSha,'LOCAL_TRANSLATION_NORMALIZER_PIN_REQUIRED');
    const resourcePins=Object.values(resources);must(new Set(resourcePins.map(pin=>pin.path)).size===4,'LOCAL_TRANSLATION_TOKENIZER_FILES_REQUIRED');
    for(const pin of resourcePins)must(underneath(root,await realpath(pin.path)),'LOCAL_TRANSLATION_PATH_INVALID');
  }
  for(const pin of [config.python,config.worker,...config.model.files,...config.dependencyPins,...(resources?Object.values(resources):[])])await verifyPin(pin);
}
function preservedLines(source:string,target:string):boolean {
  const sourceParts=source.split(/(\r\n|\r|\n)/),targetParts=target.split(/(\r\n|\r|\n)/);
  return sourceParts.length===targetParts.length&&sourceParts.every((part,index)=>index%2===1?targetParts[index]===part:part.trim().length===0?targetParts[index]===part:targetParts[index].trim().length>0);
}
function workerMessage(value:unknown,capture:LocalTranslationCapture,pid:number|undefined):WorkerStart|WorkerReply{
  const base=value as Record<string,unknown>;const isStart=base?.kind==='START';
  const block=capture.consumption.translationUnit==='BLOCK';
  const object=closed(value,isStart?['kind','version','executionId','inputFingerprint','consumptionDigest','pid','source']:['kind','version','executionId','inputFingerprint','consumptionDigest','outcome','started','reason','items',...(block?['generationCount']:[])]);
  must(object.version===1&&object.executionId===capture.capturedInput.executionId&&object.inputFingerprint===capture.inputFingerprint&&object.consumptionDigest===capture.consumptionDigest,'LOCAL_TRANSLATION_REPLY_BINDING_INVALID');
  if(isStart){must(Number.isSafeInteger(object.pid)&&object.pid===pid&&object.source===(capture.promptContract===localTranslationCt2PromptContract?'DECODE_STEP_OBSERVED':'MODEL_FORWARD_ENTERED'),'LOCAL_TRANSLATION_START_INVALID');return object as WorkerStart;}
  must(object.kind==='REPLY'&&['SUCCESS','FAILURE'].includes(String(object.outcome))&&typeof object.started==='boolean'&&typeof object.reason==='string'&&/^[A-Z0-9_]{1,100}$/.test(object.reason)&&Array.isArray(object.items),'LOCAL_TRANSLATION_REPLY_INVALID');
  if(block)must(Number.isSafeInteger(object.generationCount)&&Number(object.generationCount)>=0&&Number(object.generationCount)<=capture.consumption.items.length&&(object.outcome!=='SUCCESS'||object.generationCount===capture.consumption.items.length),'LOCAL_TRANSLATION_GENERATION_COUNT_INVALID');
  for(const item of object.items){const next=closed(item,['regionId','targetText','inputTokenCount','outputTokenCount','eosCompleted']);const source=capture.consumption.items.find(item=>item.regionId===next.regionId);
    must(typeof next.regionId==='string'&&typeof next.targetText==='string'&&next.targetText.trim().length>0&&(object.outcome!=='SUCCESS'||!next.targetText.includes('<unk>'))&&Number.isSafeInteger(next.inputTokenCount)&&Number(next.inputTokenCount)>0&&Number(next.inputTokenCount)<=maxInputTokens&&Number.isSafeInteger(next.outputTokenCount)&&Number(next.outputTokenCount)>0&&Number(next.outputTokenCount)<maxNewTokens&&next.eosCompleted===true&&(!source||block||preservedLines(source.sourceText,next.targetText)),'LOCAL_TRANSLATION_TOKEN_OR_RESULT_INVALID');}
  if(object.outcome==='SUCCESS')must(object.started===true&&object.reason==='EOS_COMPLETE'&&object.items.length===capture.consumption.items.length&&object.items.every((item,index)=>(item as WorkerItem).regionId===capture.consumption.items[index].regionId),'LOCAL_TRANSLATION_RESULT_ID_OR_COUNT_INVALID');
  else must(object.items.length<=capture.consumption.items.length&&object.items.every((item,index)=>(item as WorkerItem).regionId===capture.consumption.items[index].regionId),'LOCAL_TRANSLATION_PARTIAL_RESULT_INVALID');
  return object as WorkerReply;
}
function observation(input:StageInput,outcome:Observation['outcome'],started:boolean|null,finishReason:string,data:Observation['data']=null):Observation{
  return {evidenceId:randomUUID(),outcome,started,costUsd:null,usageConfirmed:false,finishReason,providerRef:input.executionId,data};
}

// A qualification component using the existing port. PG remains the owner of durable provider output.
export class LocalTranslationAdapter implements ProviderAdapter {
  readonly synthetic=false;
  private readonly config:LocalTranslationConfig;
  private readonly entries=new Map<string,Entry>();
  private activeExecutionId:string|null=null;
  private readonly pendingExecutions=new Set<Promise<void>>();
  private joinFailure:{reason:unknown}|null=null;
  private draining:Promise<void>|null=null;
  private trackExecution(operation:Promise<unknown>):void{
    const pending=operation.then(()=>{this.pendingExecutions.delete(pending);},reason=>{this.joinFailure??={reason};this.pendingExecutions.delete(pending);});
    this.pendingExecutions.add(pending);
  }
  idle():Promise<void>{
    if(this.draining)return this.draining;
    if(!this.pendingExecutions.size)return this.joinFailure?Promise.reject(this.joinFailure.reason):Promise.resolve();
    this.draining=(async()=>{
      try{
        while(this.pendingExecutions.size)await Promise.all([...this.pendingExecutions]);
        if(this.joinFailure)throw this.joinFailure.reason;
      }finally{this.draining=null;}
    })();
    return this.draining;
  }
  constructor(config:LocalTranslationConfig){this.config=deepFreeze(structuredClone(config));}
  capture(input:StageInput):LocalTranslationCapture {return structuredClone(inputCapture(input,this.config));}
  receipt(executionId:string,input:StageInput):LocalTranslationReceipt|null {
    const entry=this.entries.get(executionId);if(!entry||input.executionId!==executionId||inputCapture(input,this.config).inputFingerprint!==entry.fingerprint)return null;
    return entry.receipt===null?null:structuredClone(entry.receipt);
  }
  async validateInput(input:StageInput):Promise<void>{inputCapture(input,this.config);await validateConfig(this.config);}
  async validateObservation(input:StageInput,value:Observation):Promise<void>{
    const capture=inputCapture(input,this.config);must(value.costUsd===null&&value.usageConfirmed===false,'LOCAL_TRANSLATION_BILLING_AUTHORITY_INVALID');
    if(value.outcome!=='SUCCESS')return;
    must(value.started===true&&value.finishReason==='EOS_COMPLETE'&&value.data!==null,'LOCAL_TRANSLATION_OBSERVATION_INVALID');
    const expected=structuredClone(input.previousData??input.initialData);
    for(const item of capture.consumption.items){const proposed=value.data.blocks.find(block=>block.regionId===item.regionId);const block=expected.blocks.find(value=>value.regionId===item.regionId)!;
      must(proposed&&proposed.translatedText.status==='AI_PROPOSED'&&proposed.translatedText.value.trim().length>0&&(capture.consumption.translationUnit==='BLOCK'||preservedLines(item.sourceText,proposed.translatedText.value)),'LOCAL_TRANSLATION_OBSERVATION_INVALID');
      block.translatedText=structuredClone(proposed.translatedText);block.appliedTranslation={sourceLanguage:input.settings.sourceLanguage,targetLanguage:input.settings.targetLanguage,modelId:input.settings.modelId,reasoningLevel:input.settings.reasoningLevel,modelContract:input.settings.contractVersion,promptContract:capture.promptContract,originExecutionId:input.executionId};}
    must(digest(value.data)===digest(expected),'LOCAL_TRANSLATION_SCOPE_OR_PROVENANCE_INVALID');validateEditData(value.data,input.width,input.height);
  }
  async dispatch(input:StageInput,started:(evidenceId:string)=>Promise<void>):Promise<Observation>{
    const prior=this.entries.get(input.executionId);
    let capture:LocalTranslationCapture;try{capture=inputCapture(input,this.config);}catch{must(!prior,'LOCAL_TRANSLATION_EXECUTION_INPUT_CONFLICT');return observation(input,'NOT_STARTED',false,'LOCAL_TRANSLATION_INPUT_REJECTED');}
    if(prior){must(prior.fingerprint===capture.inputFingerprint,'LOCAL_TRANSLATION_EXECUTION_INPUT_CONFLICT');return structuredClone(await prior.promise);}
    if(this.activeExecutionId!==null){const result=observation(input,'NOT_STARTED',false,'LOCAL_TRANSLATION_BUSY');this.entries.set(input.executionId,{fingerprint:capture.inputFingerprint,capture,promise:Promise.resolve(result),receipt:null});return structuredClone(result);}
    this.activeExecutionId=input.executionId;
    const entry:Entry={fingerprint:capture.inputFingerprint,capture,promise:Promise.resolve(observation(input,'UNKNOWN',null,'LOCAL_TRANSLATION_PENDING')),receipt:null};
    this.entries.set(input.executionId,entry);
    entry.promise=this.execute(entry,started).finally(()=>{this.activeExecutionId=null;});
    // 원 close와 START callback을 기다리는 기존 Promise만 합류 대상으로 둔다.
    this.trackExecution(entry.promise);
    return structuredClone(await entry.promise);
  }
  async lookup(executionId:string,input?:StageInput):Promise<Observation|null>{
    if(!input||input.executionId!==executionId)return null;
    const entry=this.entries.get(executionId);if(!entry)return null;
    if(inputCapture(input,this.config).inputFingerprint!==entry.fingerprint)return null;
    // Await the original close; neither lookup nor a new instance can create another inference.
    return structuredClone(await entry.promise);
  }
  private async execute(entry:Entry,started:(evidenceId:string)=>Promise<void>):Promise<Observation>{
    const input=entry.capture.capturedInput;
    try{await validateConfig(this.config);}catch{return observation(input,'NOT_STARTED',false,'LOCAL_TRANSLATION_CONFIGURATION_REJECTED');}
    const request={version:1,executionId:input.executionId,inputFingerprint:entry.fingerprint,consumptionDigest:entry.capture.consumptionDigest,
      modelPath:this.config.model.path,modelFiles:this.config.model.files,dependencyRoots:this.config.dependencyRoots,threads:this.config.threads,
      sourceLanguage:'ja',targetLanguage:'ko',maxInputTokens,maxNewTokens,items:entry.capture.consumption.items.map(({regionId,sourceText,normalizedSourceText})=>({regionId,sourceText,...(normalizedSourceText===undefined?{}:{normalizedSourceText})})),
      ...(entry.capture.consumption.translationUnit==='BLOCK'?{version:2,promptContract:entry.capture.promptContract,translationUnit:'BLOCK'}:{}),
      ...(this.config.model.id===localTranslationCt2ModelId?{ownedTempRoot:this.config.ownedTempRoot,ct2Resources:this.config.model.ct2Resources,normalization:entry.capture.consumption.normalization}:{})};
    const body=Buffer.from(`${JSON.stringify(request)}\n`,'utf8');if(body.length>inputBytesLimit)return observation(input,'NOT_STARTED',false,'LOCAL_TRANSLATION_INPUT_BYTES_LIMIT');
    const systemRoot=process.env.SystemRoot??process.env.SYSTEMROOT;must(systemRoot&&isAbsolute(systemRoot),'LOCAL_TRANSLATION_SYSTEM_ROOT_REQUIRED');
    const environment:NodeJS.ProcessEnv={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:`${dirname(this.config.python.path)}${sep==='\\'?';':':'}${join(systemRoot,'System32')}`,
      TEMP:this.config.ownedTempRoot,TMP:this.config.ownedTempRoot,HF_HOME:join(this.config.ownedTempRoot,'offline-hf-cache'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',
      HF_HUB_DISABLE_TELEMETRY:'1',TOKENIZERS_PARALLELISM:'false',CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2',...(this.config.model.id===localTranslationCt2ModelId?{OPENBLAS_NUM_THREADS:'2'}:{})};
    const child=spawn(this.config.python.path,['-I','-S','-B',this.config.worker.path],{cwd:this.config.ownedTempRoot,env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    const receipt:LocalTranslationReceipt={version:1,capture:structuredClone(entry.capture),configDigest:digest(this.config),runtimeModel:{id:this.config.model.id,revision:this.config.model.revision,threads:2,device:'cpu',maxInputTokens,maxNewTokens},
      child:{pid:child.pid??null,spawnObserved:false,closeObserved:false,exitCode:null,signal:null,stdoutEof:false,stderrEof:false,inputClosed:false},
      start:null,startEvidenceId:null,callbackInvoked:false,callbackConfirmed:false,callbackFailed:false,rawReply:null,rawStdoutBase64:'',rawStderrBase64:'',stdoutOverflow:false,stderrOverflow:false,
      protocolFailure:false,resultFailure:false,rejectedReply:null,timedOut:false,sourcePinsVerifiedAfterClose:false,externalApiFeeUsd:'0',fullHostCostUsd:null,billingAuthority:false};
    entry.receipt=receipt;
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),pendingLine=Buffer.alloc(0),callback:Promise<void>|null=null,spawnError=false,replySeen=false;
    const stop=()=>{if(!receipt.child.closeObserved)child.kill();};
    const close=new Promise<void>(resolve=>{
      child.once('spawn',()=>{receipt.child.spawnObserved=true;});
      child.once('error',()=>{spawnError=true;});
      child.once('close',(code,signal)=>{receipt.child.closeObserved=true;receipt.child.exitCode=code;receipt.child.signal=signal;resolve();});
    });
    child.stdout.once('end',()=>{receipt.child.stdoutEof=true;});child.stderr.once('end',()=>{receipt.child.stderrEof=true;});
    child.stdin.once('finish',()=>{receipt.child.inputClosed=true;});child.stdin.on('error',()=>{receipt.protocolFailure=true;stop();});
    const acceptLine=(line:Buffer)=>{
      let parsed:unknown=null;
      try{
        must(line.length>0&&!replySeen,'LOCAL_TRANSLATION_PROTOCOL_ORDER_INVALID');
        parsed=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(line),stdoutBytesLimit);const message=workerMessage(parsed,entry.capture,child.pid);
        if(message.kind==='START'){
          must(receipt.start===null,'LOCAL_TRANSLATION_DUPLICATE_START');receipt.start=structuredClone(message);receipt.startEvidenceId=randomUUID();receipt.callbackInvoked=true;
          callback=Promise.resolve().then(()=>started(receipt.startEvidenceId!)).then(()=>{receipt.callbackConfirmed=true;},()=>{receipt.callbackFailed=true;});
        }else{replySeen=true;receipt.rawReply=structuredClone(message);must(message.started===(receipt.start!==null),'LOCAL_TRANSLATION_START_REPLY_MISMATCH');}
      }catch(error){receipt.rejectedReply=structuredClone(parsed);if(error instanceof Error&&['LOCAL_TRANSLATION_TOKEN_OR_RESULT_INVALID','LOCAL_TRANSLATION_RESULT_ID_OR_COUNT_INVALID','LOCAL_TRANSLATION_PARTIAL_RESULT_INVALID'].includes(error.message)&&receipt.start!==null){receipt.resultFailure=true;replySeen=true;}else{receipt.protocolFailure=true;stop();}}
    };
    child.stdout.on('data',(chunk:Buffer)=>{
      const next=Buffer.from(chunk);const capacity=stdoutBytesLimit-stdout.length;stdout=Buffer.concat([stdout,next.subarray(0,Math.max(0,capacity))]);
      if(next.length>capacity){receipt.stdoutOverflow=true;receipt.protocolFailure=true;stop();return;}
      pendingLine=Buffer.concat([pendingLine,next]);for(;;){const end=pendingLine.indexOf(10);if(end<0)break;const line=pendingLine.subarray(0,end);pendingLine=pendingLine.subarray(end+1);acceptLine(line);}
    });
    child.stderr.on('data',(chunk:Buffer)=>{const next=Buffer.from(chunk);const capacity=stderrBytesLimit-stderr.length;stderr=Buffer.concat([stderr,next.subarray(0,Math.max(0,capacity))]);if(next.length>capacity){receipt.stderrOverflow=true;receipt.protocolFailure=true;stop();}});
    const timer=setTimeout(()=>{receipt.timedOut=true;stop();},timeoutMs);
    try{child.stdin.end(body);await close;}finally{clearTimeout(timer);await close;if(callback!==null)await callback;receipt.rawStdoutBase64=stdout.toString('base64');receipt.rawStderrBase64=stderr.toString('base64');}
    if(pendingLine.length>0)receipt.protocolFailure=true;
    try{await validateConfig(this.config);receipt.sourcePinsVerifiedAfterClose=true;}catch{receipt.protocolFailure=true;}
    const startedFact=receipt.start!==null?true:spawnError&&!receipt.child.spawnObserved?false:null;
    if(spawnError&&!receipt.child.spawnObserved)return observation(input,'NOT_STARTED',false,'LOCAL_TRANSLATION_SPAWN_FAILED');
    if(receipt.callbackFailed||receipt.protocolFailure||receipt.timedOut||!receipt.child.closeObserved||!receipt.child.stdoutEof||!receipt.child.stderrEof||!receipt.child.inputClosed||receipt.child.exitCode!==0||receipt.child.signal!==null||receipt.rawReply===null&&!receipt.resultFailure)
      return observation(input,'UNKNOWN',startedFact,receipt.callbackFailed?'LOCAL_TRANSLATION_START_CALLBACK_UNCONFIRMED':receipt.timedOut?'LOCAL_TRANSLATION_TERMINATION_UNCONFIRMED':'LOCAL_TRANSLATION_OUTPUT_UNCONFIRMED');
    if(receipt.resultFailure)return observation(input,'FAILURE',true,'LOCAL_TRANSLATION_PROPOSAL_INVALID');
    const reply=receipt.rawReply!;
    if(reply.outcome==='FAILURE')return observation(input,'FAILURE',reply.started,reply.reason);
    const data=structuredClone(input.previousData??input.initialData);
    for(const item of reply.items){const block=data.blocks.find(value=>value.regionId===item.regionId)!;block.translatedText={value:item.targetText,status:'AI_PROPOSED'};
      block.appliedTranslation={sourceLanguage:input.settings.sourceLanguage,targetLanguage:input.settings.targetLanguage,modelId:input.settings.modelId,reasoningLevel:input.settings.reasoningLevel,modelContract:input.settings.contractVersion,promptContract:entry.capture.promptContract,originExecutionId:input.executionId};}
    validateEditData(data,input.width,input.height);return observation(input,'SUCCESS',true,'EOS_COMPLETE',data);
  }
}
