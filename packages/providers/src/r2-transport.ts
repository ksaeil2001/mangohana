import type {S3Transport,Head,ObjectInspection} from './r2.js';
import type {PutJournal,StorageProof} from '../../storage/src/s3-put-journal.js';
import {signS3Request,type SigningCredentials} from './sigv4.js';
import {sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';

type Options={accountId:string;bucket:string;enabled?:boolean;maxBytes:number|null;requestMilliseconds:number|null;credentials:()=>Promise<SigningCredentials>;fetch?:typeof globalThis.fetch;clock?:()=>Date};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const keyPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export class R2S3Transport implements S3Transport {
  private readonly options:Readonly<Options>;
  constructor(readonly journal:PutJournal,options:Options){this.options=Object.freeze({...options});}
  get bucket():string{return this.options.bucket;}
  private gate(key:string):void{const o=this.options;requireCondition(o.enabled===true&&/^[0-9a-f]{32}$/.test(o.accountId)&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(o.bucket)&&Number.isSafeInteger(o.maxBytes)&&Number(o.maxBytes)>0&&Number.isSafeInteger(o.requestMilliseconds)&&Number(o.requestMilliseconds)>0,'STORAGE_ACTIVATION_GATE',409,'WAIT');requireCondition(keyPattern.test(key),'INPUT_INVALID',422);}
  private async body(response:Response):Promise<Buffer>{
    const max=this.options.maxBytes!;const declared=response.headers.get('content-length');if(declared!==null)requireCondition(/^(0|[1-9]\d{0,18})$/.test(declared)&&BigInt(declared)<=BigInt(max),'STORAGE_UNCONFIRMED',409,'WAIT');
    if(!response.body)return Buffer.alloc(0);const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;
    try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;requireCondition(length<=max,'STORAGE_UNCONFIRMED',409,'WAIT');chunks.push(Buffer.from(next.value));}return Buffer.concat(chunks,length);}
    finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  }
  private async response<T>(method:'GET'|'HEAD'|'PUT'|'DELETE',key:string,consume:(response:Response)=>Promise<T>,bytes?:Buffer,extraHeaders?:Record<string,string>,beforeSend?:()=>Promise<boolean>):Promise<T>{
    this.gate(key);const o=this.options,controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const expired=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DomainError('STORAGE_UNCONFIRMED',409,'WAIT'));},o.requestMilliseconds!);});
    const request=(async()=>{const credentials=await o.credentials();requireCondition(!controller.signal.aborted,'STORAGE_UNCONFIRMED',409,'WAIT');const host=`${o.accountId}.r2.cloudflarestorage.com`;const signed=signS3Request({method,host,path:`/${o.bucket}/${key}`,region:'auto',now:(o.clock??(()=>new Date()))(),credentials,body:bytes,headers:extraHeaders});if(beforeSend)requireCondition(await beforeSend(),'STORAGE_UNCONFIRMED',409,'WAIT');requireCondition(!controller.signal.aborted,'STORAGE_UNCONFIRMED',409,'WAIT');const result=await (o.fetch??globalThis.fetch)(`https://${host}${signed.pathAndQuery}`,{method,headers:signed.headers,body:bytes?new Uint8Array(bytes):undefined,redirect:'error',signal:controller.signal});try{return await consume(result);}finally{await result.body?.cancel().catch(()=>undefined);}})();
    try{return await Promise.race([request,expired]);}finally{if(timer)clearTimeout(timer);}
  }
  async put(key:string,bytes:Buffer,options:{ifNoneMatch:'*';sha256:string}):Promise<'CREATED'|'EXISTS'|'UNKNOWN'>{
    this.gate(key);const body=Buffer.from(bytes);requireCondition(options.ifNoneMatch==='*'&&body.length<=this.options.maxBytes!&&sha256(body)===options.sha256,'INPUT_INVALID',422);
    const ticket=await this.journal.reserve(this.options.bucket,key,options.sha256,String(body.length));if(!ticket||!await this.journal.claim(ticket)||!await this.journal.canSubmit(ticket))return 'UNKNOWN';
    try{const status=await this.response('PUT',key,async response=>{await this.body(response);return response.status;},body,{'if-none-match':'*','content-type':'application/octet-stream','x-amz-meta-trio-put-id':ticket.attemptId,'x-amz-meta-trio-sha256':ticket.sha256},()=>this.journal.canSubmit(ticket));const state=status===200?'ACKNOWLEDGED':status===412?'REJECTED':'UNKNOWN';await this.journal.finish(ticket,state);return state==='ACKNOWLEDGED'?'CREATED':state==='REJECTED'?'EXISTS':'UNKNOWN';}
    catch{await this.journal.finish(ticket,'UNKNOWN').catch(()=>undefined);return 'UNKNOWN';}
  }
  async get(key:string):Promise<Buffer>{this.gate(key);return this.response('GET',key,async response=>{if(response.status!==200){await this.body(response);throw new DomainError('STORAGE_UNCONFIRMED',409,'WAIT');}return this.body(response);});}
  async head(key:string):Promise<Head>{return (await this.inspect(key)).head;}
  async inspect(key:string):Promise<ObjectInspection>{
    this.gate(key);
    try{
      const observed=await this.response('HEAD',key,async response=>{if(response.status===404){await response.body?.cancel();return {kind:'ABSENT' as const};}if(response.status!==200){await this.body(response);return {kind:'UNCONFIRMED' as const};}
        const bytesLength=response.headers.get('content-length'),hash=response.headers.get('x-amz-meta-trio-sha256'),attemptId=response.headers.get('x-amz-meta-trio-put-id'),modified=response.headers.get('last-modified');
        if(!bytesLength||!/^(0|[1-9]\d{0,18})$/.test(bytesLength)||BigInt(bytesLength)>BigInt(this.options.maxBytes!)||!hash||!/^[0-9a-f]{64}$/.test(hash)||!attemptId||!uuid.test(attemptId)||!modified||!Number.isFinite(Date.parse(modified)))return {kind:'UNCONFIRMED' as const};return {kind:'PROOF' as const,proof:{attemptId,sha256:hash,bytesLength,uploadedAt:new Date(modified).toISOString()} satisfies StorageProof};
      });
      if(observed.kind!=='PROOF')return {head:observed,bytes:null};const proof=observed.proof,record=await this.journal.current(this.options.bucket,key);
      if(!record||record.attemptId!==proof.attemptId||record.sha256!==proof.sha256||record.bytesLength!==proof.bytesLength||['RESERVED','REJECTED'].includes(record.state))return {head:{kind:'UNCONFIRMED'},bytes:null};
      const bytes=await this.get(key);if(String(bytes.length)!==proof.bytesLength||sha256(bytes)!==proof.sha256||!await this.journal.confirm(this.options.bucket,key,proof))return {head:{kind:'UNCONFIRMED'},bytes:null};
      return {head:{kind:'PRESENT',bytesLength:proof.bytesLength,sha256:proof.sha256,uploadedAt:record.proof?.uploadedAt??proof.uploadedAt},bytes};
    }catch{return {head:{kind:'UNCONFIRMED'},bytes:null};}
  }
  async hasUnsettledPut(key:string):Promise<boolean>{this.gate(key);return this.journal.hasUnsettled(this.options.bucket,key);}
  async canDelete(key:string):Promise<boolean>{this.gate(key);return this.journal.canDelete(this.options.bucket,key);}
  async delete(key:string):Promise<'ACK'|'UNKNOWN'>{
    this.gate(key);try{if(!await this.canDelete(key)||await this.hasUnsettledPut(key))return 'UNKNOWN';const present=await this.head(key);if(present.kind==='UNCONFIRMED'||!await this.canDelete(key)||await this.hasUnsettledPut(key))return 'UNKNOWN';return await this.response('DELETE',key,async response=>{await this.body(response);return response.status===204?'ACK':'UNKNOWN';});}catch{return 'UNKNOWN';}
  }
}
