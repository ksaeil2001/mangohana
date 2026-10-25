import type { Database,Transaction } from '../../storage/src/database.js';
import type { ObjectStore,ObjectReceipt } from '../../storage/src/objects.js';
import { requireCondition } from '../../contracts/src/errors.js';
export type AssetRow={account_id:string;asset_id:string;purpose:string;object_key:string;sha256:string;bytes_length:string;media_type:string;access_deadline:Date|null;deletion_state:string;object_created_at:Date|null};
export class Assets {
  constructor(readonly db:Database,readonly store:ObjectStore) {}
  async put(accountId:string,id:string,bytes:Buffer,purpose:string,mediaType:string,contextId:string|null=null):Promise<AssetRow> {
    const proof=await this.store.put(`${accountId}/${id}`,bytes);
    return this.registerReceipt(accountId,id,proof,purpose,mediaType,contextId);
  }
  async registerReceipt(accountId:string,id:string,proof:ObjectReceipt,purpose:string,mediaType:string,contextId:string|null=null):Promise<AssetRow> {
    return this.db.accountTransaction(accountId,tx=>this.registerReceiptIn(tx,id,proof,purpose,mediaType,contextId),purpose==='LIBRARY');
  }
  async registerReceiptIn(tx:Transaction,id:string,proof:ObjectReceipt,purpose:string,mediaType:string,contextId:string|null=null):Promise<AssetRow> {
    const accountId=tx.account.account_id;
    requireCondition(proof.key===`${accountId}/${id}`,'INTENT_CONFLICT');const completed=new Date(proof.completedAt);const deadline=purpose==='LIBRARY'?new Date(completed.valueOf()+30*86400000):null;
      await tx.client.query(`INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,verified_at,deletion_state,related_context_id,object_created_at,access_deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NOT_DUE',$10,$11,$12) ON CONFLICT(account_id,asset_id) DO NOTHING`,[accountId,id,purpose,this.store.bucket,proof.key,proof.sha256,proof.bytesLength,mediaType,tx.now,contextId,completed,deadline]);
      const row=(await tx.client.query<AssetRow>('SELECT * FROM assets WHERE account_id=$1 AND asset_id=$2',[accountId,id])).rows[0];requireCondition(row.sha256===proof.sha256&&row.bytes_length===proof.bytesLength&&row.media_type===mediaType&&row.object_created_at?.valueOf()===completed.valueOf()&&(!deadline||row.access_deadline?.valueOf()===deadline.valueOf()),'INTENT_CONFLICT');return row;
  }
  async row(tx:Transaction,id:string):Promise<AssetRow> {const row=(await tx.client.query<AssetRow>('SELECT * FROM assets WHERE account_id=$1 AND asset_id=$2',[tx.account.account_id,id])).rows[0];requireCondition(row&&row.deletion_state!=='CONFIRMED'&&(!row.access_deadline||tx.now<row.access_deadline),'DEPENDENCY_UNAVAILABLE');return row;}
  async bytes(accountId:string,id:string,allowClosed=false):Promise<Buffer> {
    const row=await this.db.accountTransaction(accountId,tx=>this.row(tx,id),allowClosed);return this.store.read(row.object_key);
  }
}
