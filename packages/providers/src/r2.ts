import type {ObjectStore,ObjectReceipt} from '../../storage/src/objects.js';
import {sha256} from '../../contracts/src/intent.js';
import {requireCondition,DomainError} from '../../contracts/src/errors.js';
export type Head={kind:'PRESENT';bytesLength:string;sha256:string;uploadedAt:string}|{kind:'ABSENT'}|{kind:'UNCONFIRMED'};
export type ObjectInspection={head:Head;bytes:Buffer|null};
export interface S3Transport{
  readonly bucket:string;
  put(key:string,bytes:Buffer,options:{ifNoneMatch:'*';sha256:string}):Promise<'CREATED'|'EXISTS'|'UNKNOWN'>;
  head(key:string):Promise<Head>;get(key:string):Promise<Buffer>;delete(key:string):Promise<'ACK'|'UNKNOWN'>;
  inspect?(key:string):Promise<ObjectInspection>;
  // Supplied by a durable journal; process memory cannot prove that an earlier PUT has finished.
  hasUnsettledPut(key:string):Promise<boolean>;
  canDelete?(key:string):Promise<boolean>;
}
const keyPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export class R2ObjectStore implements ObjectStore{
  readonly bucket:string;
  constructor(private readonly transport:S3Transport,bucket:string,private readonly enabled=false,private readonly maxBytes:number|null=null){requireCondition(bucket===transport.bucket,'STORAGE_ACTIVATION_GATE',409,'WAIT');this.bucket=bucket;}
  private gate(key:string){requireCondition(this.enabled&&Number.isSafeInteger(this.maxBytes)&&Number(this.maxBytes)>0&&this.bucket.length>0&&this.bucket===this.transport.bucket,'STORAGE_ACTIVATION_GATE',409,'WAIT');requireCondition(keyPattern.test(key),'INPUT_INVALID',422);}
  private async inspect(key:string):Promise<{receipt:ObjectReceipt;bytes:Buffer}|null>{
    this.gate(key);
    try{
      let inspection:ObjectInspection;
      if(this.transport.inspect)inspection=await this.transport.inspect(key);
      else{const head=await this.transport.head(key);inspection={head,bytes:head.kind==='PRESENT'?await this.transport.get(key):null};}
      const {head,bytes}=inspection;
      if(head.kind==='ABSENT'){requireCondition(!await this.transport.hasUnsettledPut(key),'STORAGE_UNCONFIRMED',409,'WAIT');return null;}
      requireCondition(head.kind==='PRESENT'&&/^(0|[1-9]\d{0,18})$/.test(head.bytesLength)&&BigInt(head.bytesLength)<=BigInt(this.maxBytes!)&&/^[0-9a-f]{64}$/.test(head.sha256)&&Number.isFinite(Date.parse(head.uploadedAt))&&Date.parse(head.uploadedAt)%1000===0,'STORAGE_UNCONFIRMED',409,'WAIT');
      requireCondition(Buffer.isBuffer(bytes)&&BigInt(bytes.length)===BigInt(head.bytesLength)&&sha256(bytes)===head.sha256,'STORAGE_UNCONFIRMED',409,'WAIT');
      return {receipt:{key,sha256:head.sha256,bytesLength:head.bytesLength,completedAt:head.uploadedAt,completedAtPrecisionMilliseconds:1000},bytes};
    }catch{throw new DomainError('STORAGE_UNCONFIRMED',409,'WAIT');}
  }
  async receipt(key:string):Promise<ObjectReceipt|null>{return (await this.inspect(key))?.receipt??null;}
  async read(key:string):Promise<Buffer>{const observation=await this.inspect(key);requireCondition(observation,'DEPENDENCY_UNAVAILABLE');return observation.bytes;}
  async put(key:string,bytes:Buffer):Promise<ObjectReceipt>{this.gate(key);requireCondition(bytes.length<=this.maxBytes!,'INPUT_INVALID',422);const prior=await this.receipt(key);if(prior){requireCondition(prior.sha256===sha256(bytes)&&BigInt(prior.bytesLength)===BigInt(bytes.length),'INTENT_CONFLICT');return prior;}requireCondition(!await this.transport.hasUnsettledPut(key),'STORAGE_UNCONFIRMED',409,'WAIT');try{await this.transport.put(key,bytes,{ifNoneMatch:'*',sha256:sha256(bytes)});}catch{throw new DomainError('STORAGE_UNCONFIRMED',409,'WAIT');}const result=await this.receipt(key);requireCondition(result,'STORAGE_UNCONFIRMED',409,'WAIT');requireCondition(result.sha256===sha256(bytes)&&BigInt(result.bytesLength)===BigInt(bytes.length),'INTENT_CONFLICT');return result;}
  async presence(key:string):Promise<'ABSENT'|'PRESENT'|'UNCONFIRMED'>{this.gate(key);try{const head=await this.transport.head(key);if(head.kind==='PRESENT')return 'PRESENT';return head.kind==='ABSENT'&&!await this.transport.hasUnsettledPut(key)?'ABSENT':'UNCONFIRMED';}catch{return 'UNCONFIRMED';}}
  async remove(key:string):Promise<boolean>{this.gate(key);try{const canDelete=this.transport.canDelete?.bind(this.transport);if(!canDelete||!await canDelete(key)||await this.transport.hasUnsettledPut(key))return false;if(await this.transport.delete(key)!=='ACK')return false;const head=await this.transport.head(key);return head.kind==='ABSENT'&&!await this.transport.hasUnsettledPut(key)&&await canDelete(key);}catch{return false;}}
}
