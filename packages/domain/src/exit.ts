import { randomUUID } from 'node:crypto';
import { requireCondition } from '../../contracts/src/errors.js';
import { type RequestRow,reply } from './model.js';
import { closeContext,finalizeSafe } from './liveness.js';
import type { CommandExtension } from './workspace.js';
import type { FileService } from './files.js';
type Exit={exit_operation_id:string;context_id:string;context_generation:string;owner_session_id:string;purpose:string;state:string;latest_export_id:string|null;draft_barrier_id:string|null;captured_owner_revision:string};
export function exitCommands(files:FileService):CommandExtension {
  return async(tx,actor,context,command)=>{
    const op=command.operation;
    if(op.kind==='BEGIN_EXIT') {
      requireCondition(context.lifecycle==='OPEN','CONTEXT_CLOSED');const id=randomUUID();
      await tx.client.query("UPDATE workspace_contexts SET lifecycle='EXITING' WHERE account_id=$1 AND context_id=$2",[context.account_id,context.context_id]);
      await tx.client.query("UPDATE batches SET state='STOP_REQUESTED',revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND state IN ('ACCEPTED','ACTIVE','WAITING')",[context.account_id,context.context_id]);
      const requests=(await tx.client.query<RequestRow>("SELECT * FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND state NOT IN ('COMPLETED','STOPPED','FAILED')",[context.account_id,context.context_id])).rows;
      for(const request of requests){if(!request.first_start_at)await finalizeSafe(tx,request,'STOPPED','NORMAL_EXIT_BEFORE_START');else await tx.client.query("UPDATE processing_requests SET state='STOP_REQUESTED',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[context.account_id,request.request_id]);}
      await tx.client.query(`INSERT INTO exit_operations(account_id,exit_operation_id,context_id,context_generation,owner_session_id,purpose,state,revision,captured_owner_revision) VALUES($1,$2,$3,$4,$5,$6,'WAITING_SAFE',0,$7)`,[context.account_id,id,context.context_id,context.generation,actor.sessionId,op.payload.purpose,context.owner_revision]);return reply(command.commandId,tx,context,{kind:'EXIT',id},true);
    }
    if(op.kind!=='DECLARE_DRAFT_BARRIER'&&op.kind!=='CAPTURE_PROJECT_FILE'&&op.kind!=='ATTEST_PROJECT_FILE'&&op.kind!=='CANCEL_EXIT')return null;
    const exit=(await tx.client.query<Exit>('SELECT * FROM exit_operations WHERE account_id=$1 AND context_id=$2 AND exit_operation_id=$3 FOR UPDATE',[context.account_id,context.context_id,op.payload.exitOperationId])).rows[0];
    requireCondition(exit&&context.lifecycle==='EXITING'&&!['CLOSED','CANCELLED'].includes(exit.state)&&exit.context_generation===context.generation,'CONTEXT_CLOSED');
    if(op.kind==='CANCEL_EXIT'){await tx.client.query("UPDATE workspace_contexts SET lifecycle='OPEN' WHERE account_id=$1 AND context_id=$2",[context.account_id,context.context_id]);await tx.client.query("UPDATE exit_operations SET state='CANCELLED',revision=revision+1 WHERE account_id=$1 AND exit_operation_id=$2",[context.account_id,exit.exit_operation_id]);return reply(command.commandId,tx,context,{kind:'EXIT',id:exit.exit_operation_id});}
    const busy=(await tx.client.query("SELECT 1 FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND state NOT IN ('COMPLETED','STOPPED','FAILED')",[context.account_id,context.context_id])).rowCount;requireCondition(!busy,'EXECUTION_UNKNOWN',409,'WAIT');
    if(op.kind==='DECLARE_DRAFT_BARRIER') {
      const ids=op.payload.acknowledgedMutationIds;requireCondition(new Set(ids).size===ids.length,'DRAFT_UNACKNOWLEDGED');
      for(const id of ids){const receipt=(await tx.client.query<{context_id:string;disposition:string}>('SELECT context_id,disposition FROM command_receipts WHERE account_id=$1 AND command_id=$2',[context.account_id,id])).rows[0];requireCondition(receipt?.context_id===context.context_id&&receipt.disposition==='APPLIED','DRAFT_UNACKNOWLEDGED');}
      const id=randomUUID();await tx.client.query(`INSERT INTO draft_barriers(account_id,draft_barrier_id,context_id,exit_operation_id,owner_revision,workspace_revision,acknowledged_mutation_refs,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[context.account_id,id,context.context_id,exit.exit_operation_id,context.owner_revision,context.workspace_revision,JSON.stringify(ids),tx.now]);
      await tx.client.query("UPDATE exit_operations SET state='BARRIER_READY',draft_barrier_id=$3,captured_owner_revision=$4,revision=revision+1 WHERE account_id=$1 AND exit_operation_id=$2",[context.account_id,exit.exit_operation_id,id,context.owner_revision]);return reply(command.commandId,tx,context,{kind:'EXIT',id});
    }
    const barrier=(await tx.client.query<{owner_revision:string;workspace_revision:string}>('SELECT owner_revision,workspace_revision FROM draft_barriers WHERE account_id=$1 AND exit_operation_id=$2 AND draft_barrier_id=$3',[context.account_id,exit.exit_operation_id,op.payload.draftBarrierId])).rows[0];
    requireCondition(barrier&&exit.draft_barrier_id===op.payload.draftBarrierId&&barrier.owner_revision===context.owner_revision&&barrier.workspace_revision===context.workspace_revision,'SNAPSHOT_STALE',409,'NEW_CAPTURE');
    if(op.kind==='CAPTURE_PROJECT_FILE'){const id=await files.capture(tx,context,'PROJECT_FILE');await tx.client.query("UPDATE exit_operations SET latest_export_id=$3,state='FILE_REQUESTED',revision=revision+1 WHERE account_id=$1 AND exit_operation_id=$2",[context.account_id,exit.exit_operation_id,id]);return reply(command.commandId,tx,context,{kind:'EXPORT',id},true);}
    const capture=await files.exportRow(tx,op.payload.exportId);requireCondition(capture.kind==='PROJECT_FILE'&&capture.context_id===context.context_id&&capture.state==='AVAILABLE'&&capture.delivered_at&&capture.output_asset_id&&capture.snapshot_revision===context.workspace_revision&&capture.snapshot_revision===op.payload.snapshotRevision&&tx.now<capture.retry_deadline&&exit.latest_export_id===capture.export_id,'SNAPSHOT_STALE',409,'NEW_CAPTURE');
    const asset=await files.assets.row(tx,capture.output_asset_id);requireCondition(asset.sha256===op.payload.fileSha256,'FILE_INVALID',422);
    await tx.client.query(`INSERT INTO file_attestations(account_id,attestation_id,context_id,exit_operation_id,export_id,draft_barrier_id,snapshot_revision,owner_revision,file_sha256,attested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[context.account_id,randomUUID(),context.context_id,exit.exit_operation_id,capture.export_id,op.payload.draftBarrierId,context.workspace_revision,context.owner_revision,op.payload.fileSha256,tx.now]);
    await closeContext(tx,context,'NORMAL_EXIT');await tx.client.query("UPDATE exit_operations SET state='CLOSED',revision=revision+1 WHERE account_id=$1 AND exit_operation_id=$2",[context.account_id,exit.exit_operation_id]);
    return reply(command.commandId,tx,context,{kind:'EXIT',id:exit.exit_operation_id});
  };
}
