import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import {digest} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import type {StageInput} from '../../domain/src/provider.js';
import type {LocalOcrConfig} from './local-ocr.js';
import type {FilePin} from './local-translation.js';

type Pin={path:string;sha256:string;bytesLength?:number};
export type LocalOcrRequest={version:1|2;executionId:string;inputFingerprint:string;configDigest:string;ownedTempRoot:string;outputDirectory:string;
  source:{sha256:string;width:number;height:number;page:string;path:string;pageLineageId?:string;originalAssetId?:string;bytesLength?:string};
  detector:FilePin;ocr:LocalOcrConfig['ocr'];dependencyRoots:string[];maxRegions:number;expectedRegions?:Extract<LocalOcrConfig,{version:1}>['expectedRegions'];threads:4;maxNewTokens:100;cropPadding:3};
export type LocalOcrReply={version:1;kind:'REPLY';executionId:string;inputFingerprint:string;configDigest:string;outcome:'SUCCESS'|'FAILURE';manifest:Pin|null;detectorCalls:number;recognitionCalls:number;reason:string};
export type LocalOcrStart={version:1;kind:'START';executionId:string;inputFingerprint:string;configDigest:string;pid:number;source:'DETECTOR_FORWARD_ENTERED'};
export type LocalOcrProcessReceipt={kind:'ACTUAL_LOCAL_OCR_PROCESS';started:boolean;reply:LocalOcrReply|null;valid:boolean;callbackInvoked:boolean;callbackConfirmed:boolean;callbackPending:boolean;protocolClosed:true;
  pid:number|null;closeObserved:boolean;exitCode:number|null;signal:string|null;stdoutEof:boolean;stderrEof:boolean;inputClosed:boolean;timedOut:boolean;postPinsVerified:boolean;subtreeTermination:'UNCONFIRMED';
  rawStdoutBase64:string;rawStderrBase64:string;fullHostCostUsd:null;billingAuthority:false};
export interface LocalOcrEnginePort{
  invoke(input:StageInput,request:LocalOcrRequest,onStarted:(evidenceId:string)=>Promise<void>):{reply:Promise<LocalOcrProcessReceipt>;joined:Promise<void>};
}
type Options={recordStart:(input:StageInput,value:LocalOcrStart)=>Promise<void>;verifyConfig:()=>Promise<void>};
function must(value:unknown,code:string):asserts value{if(!value)throw Error(code);}

// 원 프로세스 응답과 실제 종료 대기를 분리한다. joined는 host/subtree 종료 증거가 아니다.
export class LocalOcrProcessExecutor implements LocalOcrEnginePort{
  private readonly config:LocalOcrConfig;
  private readonly configDigest:string;
  private readonly recordStart:Options['recordStart'];
  private readonly verifyConfig:Options['verifyConfig'];
  constructor(config:LocalOcrConfig,options:Options){
    this.config=structuredClone(config);this.configDigest=digest(this.config);
    this.recordStart=options.recordStart.bind(options);this.verifyConfig=options.verifyConfig.bind(options);
  }
  invoke(inputValue:StageInput,requestValue:LocalOcrRequest,started:(id:string)=>Promise<void>){
    const input=structuredClone(inputValue),request=structuredClone(requestValue),c=this.config,systemRoot=process.env.SystemRoot??process.env.SYSTEMROOT;
    must(systemRoot&&isAbsolute(systemRoot),'LOCAL_OCR_SYSTEM_ROOT_REQUIRED');
    const child=spawn(c.python.path,['-I','-S','-B',c.worker.path],{cwd:c.ownedTempRoot,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:dirname(c.python.path)+';'+join(systemRoot,'System32'),TEMP:c.ownedTempRoot,TMP:c.ownedTempRoot,
        HF_HOME:join(c.ownedTempRoot,'offline-hf-cache'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',TOKENIZERS_PARALLELISM:'false',CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'4',MKL_NUM_THREADS:'4'}});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),pending=Buffer.alloc(0),rawReply:LocalOcrReply|null=null,sawStart=false,invalid=false,timedOut=false,closed=false,exitCode:number|null=null,signal:string|null=null,outEof=false,errEof=false,inputClosed=false;
    let acceptingProtocol=true,callbackInvoked=false,callbackConfirmed=false;let callback=Promise.resolve();
    let expire:()=>void=()=>undefined;const deadline=new Promise<void>(resolve=>{expire=resolve;});
    const stop=()=>{if(!closed){try{child.kill();}catch{invalid=true;}}};
    const actualClose=new Promise<void>(resolve=>{child.once('error',()=>{invalid=true;});child.once('close',(code,sig)=>{closed=true;exitCode=code;signal=sig;resolve();});});
    const ioEnd=(stream:Readable|Writable,end:'end'|'finish')=>new Promise<void>(resolve=>{
      stream.once(end,resolve);stream.once('close',resolve);stream.once('error',()=>{invalid=true;stop();resolve();});
    });
    const io=Promise.all([ioEnd(child.stdout,'end'),ioEnd(child.stderr,'end'),ioEnd(child.stdin,'finish')]);
    child.stdout.once('end',()=>{outEof=true;});child.stderr.once('end',()=>{errEof=true;});
    child.stdin.once('finish',()=>{inputClosed=true;});
    child.stdout.on('data',(chunk:Buffer)=>{
      if(!acceptingProtocol)return;
      if(stdout.length+chunk.length>1024*1024){invalid=true;stop();return;}
      stdout=Buffer.concat([stdout,chunk]);pending=Buffer.concat([pending,chunk]);
      for(;;){const end=pending.indexOf(10);if(end<0)break;const line=pending.subarray(0,end);pending=pending.subarray(end+1);
        try{
          const m=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(line)) as LocalOcrReply&{pid?:number;source?:string};
          must(!rawReply&&m.version===1&&m.executionId===input.executionId&&m.inputFingerprint===request.inputFingerprint&&m.configDigest===this.configDigest,'LOCAL_OCR_PROTOCOL_INVALID');
          if((m.kind as string)==='START'){
            must(!sawStart&&m.pid===child.pid&&m.source==='DETECTOR_FORWARD_ENTERED','LOCAL_OCR_START_INVALID');sawStart=true;
            callback=this.recordStart(input,m as unknown as LocalOcrStart).then(async()=>{if(!acceptingProtocol)return;callbackInvoked=true;await started(randomUUID());callbackConfirmed=true;}).catch(()=>{invalid=true;stop();});
          }else{
            must(m.kind==='REPLY'&&['SUCCESS','FAILURE'].includes(m.outcome)&&Number.isSafeInteger(m.detectorCalls)&&m.detectorCalls>=0&&m.detectorCalls<=1&&Number.isSafeInteger(m.recognitionCalls)&&m.recognitionCalls>=0&&m.recognitionCalls<=c.maxRegions,'LOCAL_OCR_REPLY_INVALID');
            if(m.outcome==='SUCCESS')must(sawStart&&m.detectorCalls===1&&(c.version===2||m.recognitionCalls===c.expectedRegions.length)&&m.manifest,'LOCAL_OCR_REPLY_INVALID');
            rawReply=m;
          }
        }catch{invalid=true;stop();}
      }
    });
    child.stderr.on('data',(chunk:Buffer)=>{if(stderr.length+chunk.length>1024*1024){invalid=true;stop();return;}stderr=Buffer.concat([stderr,chunk]);});
    let grace:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{timedOut=true;stop();grace=setTimeout(()=>{invalid=true;acceptingProtocol=false;expire();},5000);},c.timeoutMilliseconds);
    child.stdin.end(JSON.stringify(request)+'\n');
    const reply=(async():Promise<LocalOcrProcessReceipt>=>{
      try{await Promise.race([actualClose.then(()=>callback),deadline]);}finally{acceptingProtocol=false;clearTimeout(timer);if(grace)clearTimeout(grace);}
      let postPins=false;try{await this.verifyConfig();postPins=true;}catch{invalid=true;}
      return {kind:'ACTUAL_LOCAL_OCR_PROCESS',started:sawStart,reply:rawReply,valid:!invalid&&!timedOut&&pending.length===0&&closed&&exitCode===0&&signal===null&&outEof&&errEof&&inputClosed&&postPins&&(!sawStart||callbackConfirmed),
        callbackInvoked,callbackConfirmed,callbackPending:sawStart&&!callbackConfirmed,protocolClosed:true,pid:child.pid??null,closeObserved:closed,exitCode,signal,stdoutEof:outEof,stderrEof:errEof,inputClosed,timedOut,postPinsVerified:postPins,subtreeTermination:'UNCONFIRMED',
        rawStdoutBase64:stdout.toString('base64'),rawStderrBase64:stderr.toString('base64'),fullHostCostUsd:null,billingAuthority:false};
    })();
    // 응답 deadline은 actualClose나 I/O·원 callback Promise를 대신 해결하지 않는다.
    const joined=Promise.all([actualClose,io]).then(async()=>{await callback;await reply;});
    return {reply,joined};
  }
}
