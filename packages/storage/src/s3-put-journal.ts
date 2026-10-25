import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from './database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';

export type PutState='RESERVED'|'SENDING'|'ACKNOWLEDGED'|'REJECTED'|'UNKNOWN';
export type StorageProof={attemptId:string;sha256:string;bytesLength:string;uploadedAt:string};
export type PutRecord={attemptId:string;bucket:string;key:string;sha256:string;bytesLength:string;state:PutState;reservedAt:string;transportCompletedAt:string|null;proof:StorageProof|null};
export type PutTicket=Readonly<{accountId:string;attemptId:string;bucket:string;key:string;sha256:string;bytesLength:string}>;
export interface PutJournal {
  reserve(bucket:string,key:string,sha256:string,bytesLength:string):Promise<PutTicket|null>;
  claim(ticket:PutTicket):Promise<boolean>;canSubmit(ticket:PutTicket):Promise<boolean>;
  finish(ticket:PutTicket,state:'ACKNOWLEDGED'|'REJECTED'|'UNKNOWN'):Promise<boolean>;
  current(bucket:string,key:string):Promise<PutRecord|null>;
  confirm(bucket:string,key:string,proof:StorageProof):Promise<boolean>;
  hasUnsettled(bucket:string,key:string):Promise<boolean>;canDelete(bucket:string,key:string):Promise<boolean>;
}
type Row={attempt_id:string;bucket_ref:string;object_key:string;sha256:string;bytes_length:string;transport_state:PutState;reserved_at:Date;transport_completed_at:Date|null;protected_proof:StorageProof|null;evidence_digest:string|null};
const pattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export class PgPutJournal implements PutJournal {
  readonly #reserved=new WeakSet<PutTicket>();readonly #submitted=new WeakSet<PutTicket>();
  constructor(readonly db:Database){}
  private account(key:string):string{requireCondition(pattern.test(key),'INPUT_INVALID',422);return key.split('/')[0];}
  private async row(tx:Transaction,bucket:string,key:string):Promise<Row|undefined>{return (await tx.client.query<Row>('SELECT p.*,c.protected_proof,c.evidence_digest FROM s3_object_puts p LEFT JOIN s3_put_confirmations c USING(account_id,attempt_id) WHERE p.account_id=$1 AND p.bucket_ref=$2 AND p.object_key=$3',[tx.account.account_id,bucket,key])).rows[0];}
  private checkProof(row:Row):void{requireCondition(!row.protected_proof||row.evidence_digest===digest(row.protected_proof)&&row.protected_proof.attemptId===row.attempt_id&&row.protected_proof.sha256===row.sha256&&row.protected_proof.bytesLength===row.bytes_length,'STORAGE_UNCONFIRMED',409,'WAIT');}
  async reserve(bucket:string,key:string,sha256:string,bytesLength:string):Promise<PutTicket|null>{
    const accountId=this.account(key);requireCondition(bucket.length>0&&/^[0-9a-f]{64}$/.test(sha256)&&/^(0|[1-9]\d{0,18})$/.test(bytesLength),'INPUT_INVALID',422);
    const ticket=await this.db.accountTransaction(accountId,async tx=>{const prior=await this.row(tx,bucket,key);if(prior){requireCondition(prior.sha256===sha256&&prior.bytes_length===bytesLength,'INTENT_CONFLICT');return null;}const attemptId=randomUUID();await tx.client.query("INSERT INTO s3_object_puts(account_id,attempt_id,bucket_ref,object_key,sha256,bytes_length,transport_state,reserved_at) VALUES($1,$2,$3,$4,$5,$6,'RESERVED',$7)",[accountId,attemptId,bucket,key,sha256,bytesLength,tx.now]);return Object.freeze({accountId,attemptId,bucket,key,sha256,bytesLength});},true);
    if(ticket)this.#reserved.add(ticket);return ticket;
  }
  async claim(ticket:PutTicket):Promise<boolean>{if(!this.#reserved.delete(ticket))return false;const claimed=await this.db.accountTransaction(ticket.accountId,async tx=>(await tx.client.query("UPDATE s3_object_puts p SET transport_state='SENDING' WHERE p.account_id=$1 AND p.attempt_id=$2 AND p.bucket_ref=$3 AND p.object_key=$4 AND p.sha256=$5 AND p.bytes_length=$6 AND p.transport_state='RESERVED' AND NOT EXISTS(SELECT 1 FROM s3_put_confirmations c WHERE c.account_id=p.account_id AND c.attempt_id=p.attempt_id)",[ticket.accountId,ticket.attemptId,ticket.bucket,ticket.key,ticket.sha256,ticket.bytesLength])).rowCount===1,true);if(claimed)this.#submitted.add(ticket);return claimed;}
  async canSubmit(ticket:PutTicket):Promise<boolean>{if(!this.#submitted.has(ticket))return false;return this.db.accountTransaction(ticket.accountId,async tx=>{const row=await this.row(tx,ticket.bucket,ticket.key);return Boolean(row&&row.attempt_id===ticket.attemptId&&row.transport_state==='SENDING'&&!row.protected_proof);},true);}
  async finish(ticket:PutTicket,state:'ACKNOWLEDGED'|'REJECTED'|'UNKNOWN'):Promise<boolean>{if(!this.#submitted.has(ticket))return false;return this.db.accountTransaction(ticket.accountId,async tx=>(await tx.client.query("UPDATE s3_object_puts SET transport_state=$3,transport_completed_at=$4 WHERE account_id=$1 AND attempt_id=$2 AND transport_state='SENDING' AND transport_completed_at IS NULL",[ticket.accountId,ticket.attemptId,state,tx.now])).rowCount===1,true);}
  async current(bucket:string,key:string):Promise<PutRecord|null>{return this.db.accountTransaction(this.account(key),async tx=>{const row=await this.row(tx,bucket,key);if(!row)return null;this.checkProof(row);return {attemptId:row.attempt_id,bucket:row.bucket_ref,key:row.object_key,sha256:row.sha256,bytesLength:row.bytes_length,state:row.transport_state,reservedAt:row.reserved_at.toISOString(),transportCompletedAt:row.transport_completed_at?.toISOString()??null,proof:row.protected_proof};},true);}
  async confirm(bucket:string,key:string,proof:StorageProof):Promise<boolean>{return this.db.accountTransaction(this.account(key),async tx=>{const row=await this.row(tx,bucket,key);if(!row||['RESERVED','REJECTED'].includes(row.transport_state)||row.attempt_id!==proof.attemptId||row.sha256!==proof.sha256||row.bytes_length!==proof.bytesLength||!Number.isFinite(Date.parse(proof.uploadedAt)))return false;this.checkProof(row);if(row.protected_proof){requireCondition(digest(row.protected_proof)===digest(proof),'STORAGE_UNCONFIRMED',409,'WAIT');return true;}await tx.client.query('INSERT INTO s3_put_confirmations(account_id,attempt_id,sha256,bytes_length,completed_at,evidence_digest,protected_proof,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tx.account.account_id,proof.attemptId,proof.sha256,proof.bytesLength,new Date(proof.uploadedAt),digest(proof),JSON.stringify(proof),tx.now]);return true;},true);}
  async hasUnsettled(bucket:string,key:string):Promise<boolean>{const row=await this.current(bucket,key);return Boolean(row&&['RESERVED','SENDING','UNKNOWN'].includes(row.state));}
  async canDelete(bucket:string,key:string):Promise<boolean>{const row=await this.current(bucket,key);return Boolean(row&&row.state==='ACKNOWLEDGED'&&row.proof);}
}
