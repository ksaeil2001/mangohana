import {randomUUID} from 'node:crypto';
import type {Transaction} from '../../storage/src/database.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';
import {type ContextRow,type PageRow,type RequestRow,contextRow,compositionIdle,settingsRow,bumpWorkspace} from './model.js';
import {admitRequest,queueWork,type RequestPolicy} from './requests.js';
type Batch={batch_id:string;context_id:string;context_generation:string;settings_revision:string;captured_target_order:string[];state:string;next_target_index:number;current_request_id:string|null;stop_command_id:string|null;pause_reason:string|null;revision:string};
const finished=(state:string)=>['COMPLETED','STOPPED','FAILED'].includes(state);
export async function admitBatch(tx:Transaction,context:ContextRow,ids:string[],settingsVersion:string,policy:RequestPolicy):Promise<string|null>{
  await compositionIdle(tx,context);requireCondition(context.lifecycle==='OPEN'&&context.current_settings_revision===settingsVersion,'REVISION_CONFLICT');requireCondition(new Set(ids).size===ids.length,'INPUT_INVALID',422);
  const pages=(await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND NOT excluded AND NOT skip ORDER BY display_order',[context.account_id,context.context_id])).rows;
  requireCondition(ids.length===pages.length&&pages.every((p,i)=>p.page_lineage_id===ids[i]),'INPUT_INVALID',422);if(!ids.length)return null;
  const settings=await settingsRow(tx,context);requireCondition(settings.sourceLanguage!==settings.targetLanguage,'SAME_LANGUAGE',422);const id=randomUUID();await tx.client.query(`INSERT INTO batches(account_id,batch_id,context_id,context_generation,settings_revision,captured_target_order,state,revision) VALUES($1,$2,$3,$4,$5,$6,'ACCEPTED',0)`,[context.account_id,id,context.context_id,context.generation,settingsVersion,JSON.stringify(ids)]);await queueWork(tx,'BATCH',{batchId:id});await advanceBatch(tx,id,policy);return id;
}
export async function advanceBatch(tx:Transaction,id:string,policy:RequestPolicy):Promise<boolean>{
  const batch=(await tx.client.query<Batch>('SELECT * FROM batches WHERE account_id=$1 AND batch_id=$2 FOR UPDATE',[tx.account.account_id,id])).rows[0];if(!batch||finished(batch.state))return true;
  const context=await contextRow(tx,batch.context_id);const current=batch.current_request_id?(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[tx.account.account_id,batch.current_request_id])).rows[0]:null;
  if(current&&!finished(current.state))return false;
  if(batch.stop_command_id||batch.state==='STOP_REQUESTED'||context.lifecycle!=='OPEN'||context.generation!==batch.context_generation){await tx.client.query("UPDATE batches SET state='STOPPED',pause_reason=NULL,revision=revision+1 WHERE account_id=$1 AND batch_id=$2",[tx.account.account_id,id]);return true;}
  if(current){
    if(current.state==='COMPLETED'){batch.next_target_index++;batch.current_request_id=null;}
    else if(current.state==='FAILED'&&policy.batchFailureAction==='CONTINUE'){batch.next_target_index++;batch.current_request_id=null;}
    else{await tx.client.query("UPDATE batches SET state='WAITING',pause_reason=$3,revision=revision+1 WHERE account_id=$1 AND batch_id=$2 AND (state<>'WAITING' OR pause_reason IS DISTINCT FROM $3)",[tx.account.account_id,id,current.state==='FAILED'?(policy.batchFailureAction?'CONFIRMED_PAGE_FAILURE':'POLICY_DECISION_REQUIRED'):'PAGE_STOPPED']);return false;}
    await tx.client.query('UPDATE batches SET next_target_index=$3,current_request_id=NULL,revision=revision+1 WHERE account_id=$1 AND batch_id=$2',[tx.account.account_id,id,batch.next_target_index]);
  }
  if(batch.next_target_index>=batch.captured_target_order.length){const normal=(await tx.client.query<{count:string}>("SELECT count(DISTINCT page_lineage_id) AS count FROM processing_requests WHERE account_id=$1 AND batch_id=$2 AND state='COMPLETED'",[tx.account.account_id,id])).rows[0];const allNormal=Number(normal.count)===batch.captured_target_order.length;await tx.client.query("UPDATE batches SET state=$3,pause_reason=NULL,revision=revision+1 WHERE account_id=$1 AND batch_id=$2",[tx.account.account_id,id,allNormal?'COMPLETED':'FAILED']);if(allNormal){await tx.client.query("UPDATE workspace_contexts SET project_status='COMPLETED' WHERE account_id=$1 AND context_id=$2",[tx.account.account_id,context.context_id]);await bumpWorkspace(tx,context);}return true;}
  const page=(await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE',[tx.account.account_id,context.context_id,batch.captured_target_order[batch.next_target_index]])).rows[0];requireCondition(page&&!page.excluded&&!page.skip,'REVISION_CONFLICT');
  const settings=await settingsRow(tx,context,batch.settings_revision);
  // The approved batch wire has no paid-continuation evidence.
  await tx.client.query('SAVEPOINT batch_admission');let requestId:string;
  try{requestId=await admitRequest(tx,context,page,{kind:'PAGE'},settings,{...policy,paidEnabled:false},id);await tx.client.query('RELEASE SAVEPOINT batch_admission');}catch(error){await tx.client.query('ROLLBACK TO SAVEPOINT batch_admission');if(!(error instanceof DomainError)||!['FREE_LIMIT_REACHED','EXECUTION_UNKNOWN','SETTLEMENT_PENDING','PAGE_BUSY','MODEL_UNVERIFIED'].includes(error.code))throw error;await tx.client.query("UPDATE batches SET state='WAITING',pause_reason=$3,revision=revision+1 WHERE account_id=$1 AND batch_id=$2 AND (state<>'WAITING' OR pause_reason IS DISTINCT FROM $3)",[tx.account.account_id,id,error.code]);return false;}
  await tx.client.query("UPDATE batches SET state='ACTIVE',current_request_id=$3,pause_reason=NULL,revision=revision+1 WHERE account_id=$1 AND batch_id=$2",[tx.account.account_id,id,requestId]);return false;
}

// An explicit choice after a confirmed failure. Unknown execution and admission
// holds never qualify, and skipping a failure does not erase its accounting facts.
export async function continueBatch(tx:Transaction,context:ContextRow,payload:{batchId:string;expectedBatchRevision:string;failedRequestId:string},policy:RequestPolicy):Promise<void>{
  requireCondition(context.lifecycle==='OPEN'&&policy.batchFailureAction==='WAIT','REVISION_CONFLICT');
  const batch=(await tx.client.query<Batch>('SELECT * FROM batches WHERE account_id=$1 AND batch_id=$2 FOR UPDATE',[context.account_id,payload.batchId])).rows[0];
  requireCondition(batch&&batch.context_id===context.context_id&&batch.context_generation===context.generation&&batch.revision===payload.expectedBatchRevision,'REVISION_CONFLICT');
  requireCondition(batch.state==='WAITING'&&batch.pause_reason==='CONFIRMED_PAGE_FAILURE'&&!batch.stop_command_id&&batch.current_request_id===payload.failedRequestId,'REVISION_CONFLICT');
  const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[context.account_id,payload.failedRequestId])).rows[0];
  requireCondition(request?.state==='FAILED'&&request.batch_id===batch.batch_id&&request.page_lineage_id===batch.captured_target_order[batch.next_target_index],'REVISION_CONFLICT');
  await tx.client.query("UPDATE batches SET state='ACCEPTED',next_target_index=next_target_index+1,current_request_id=NULL,pause_reason=NULL,revision=revision+1 WHERE account_id=$1 AND batch_id=$2",[context.account_id,batch.batch_id]);
  await queueWork(tx,'BATCH',{batchId:batch.batch_id});
  await advanceBatch(tx,batch.batch_id,policy);
}
