import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../storage/src/database.js';
import type { ContextRow, RequestRow } from './model.js';
import {holdNativeExecution,nativeExecutionWaiting} from './native-execution-wait.js';

export async function finalizeSafe(tx: Transaction, request: RequestRow, state: 'COMPLETED'|'STOPPED'|'FAILED', evidence: string): Promise<boolean> {
  if (['COMPLETED','STOPPED','FAILED'].includes(request.state)) return true;
  if (await nativeExecutionWaiting(tx,request)) {await holdNativeExecution(tx,request,true);return false;}
  const uncertain = (await tx.client.query("SELECT 1 FROM executions WHERE account_id=$1 AND request_id=$2 AND state IN ('DISPATCHING','RUNNING','UNKNOWN')", [request.account_id,request.request_id])).rowCount;
  if (uncertain) {
    await tx.client.query("UPDATE processing_requests SET state='STOP_REQUESTED',hold_reasons='[\"EXECUTION_UNKNOWN\"]',revision=revision+1 WHERE account_id=$1 AND request_id=$2", [request.account_id,request.request_id]);
    return false;
  }
  await tx.client.query('UPDATE processing_requests SET state=$3,terminal_at=$4,terminal_evidence_ref=$5,hold_reasons=\'[]\',revision=revision+1 WHERE account_id=$1 AND request_id=$2', [request.account_id,request.request_id,state,tx.now,evidence]);
  await tx.client.query('DELETE FROM active_page_requests WHERE account_id=$1 AND request_id=$2', [request.account_id,request.request_id]);
  await tx.client.query("UPDATE free_reservations SET state='RELEASED_CONFIRMED',revision=revision+1 WHERE account_id=$1 AND request_id=$2 AND state='HELD'", [request.account_id,request.request_id]);
  return true;
}

export async function closeContext(tx: Transaction, context: ContextRow, reason: 'NORMAL_EXIT'|'DISCONNECT_EXPIRED'|'ALL_SESSIONS_LOGOUT'): Promise<void> {
  if (context.lifecycle === 'CLOSED') return;
  await tx.client.query(`UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=$3,close_reason=$4,owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL
    WHERE account_id=$1 AND context_id=$2`, [context.account_id,context.context_id,tx.now,reason]);
  await tx.client.query('DELETE FROM account_live_context_slots WHERE account_id=$1 AND context_id=$2', [context.account_id,context.context_id]);
  await tx.client.query("UPDATE batches SET state='STOP_REQUESTED',revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND state IN ('ACCEPTED','ACTIVE','WAITING')", [context.account_id,context.context_id]);
  const requests = (await tx.client.query<RequestRow>("SELECT * FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND state NOT IN ('COMPLETED','STOPPED','FAILED')", [context.account_id,context.context_id])).rows;
  for (const request of requests) await finalizeSafe(tx,request,'STOPPED',reason);
  context.lifecycle = 'CLOSED';
}

export async function sweepAccount(db: Database, accountId: string): Promise<void> {
  await db.accountTransaction(accountId, async (tx) => {
    const contexts = (await tx.client.query<ContextRow>("SELECT * FROM workspace_contexts WHERE account_id=$1 AND lifecycle<>'CLOSED' FOR UPDATE", [accountId])).rows;
    for (const context of contexts) {
      const session = context.owner_session_id ? (await tx.client.query<{ absolute_expires_at: Date; revoked_at: Date|null; auth_generation: string; binding_state:string }>('SELECT s.absolute_expires_at,s.revoked_at,s.auth_generation,b.state AS binding_state FROM app_sessions s JOIN login_bindings b USING(account_id,binding_id) WHERE s.account_id=$1 AND s.session_id=$2', [accountId,context.owner_session_id])).rows[0] : undefined;
      const ownerInvalid = !session || session.revoked_at !== null || session.binding_state !== 'ACTIVE' || session.auth_generation !== tx.account.auth_generation || tx.now >= session.absolute_expires_at;
      const stale = !context.last_valid_heartbeat_at || tx.now.valueOf()-context.last_valid_heartbeat_at.valueOf() > 45000;
      let round = (await tx.client.query<{ deadline: Date; closed_at: Date|null }>('SELECT deadline,closed_at FROM connection_rounds WHERE account_id=$1 AND context_id=$2 AND context_generation=$3 AND closed_at IS NULL', [accountId,context.context_id,context.generation])).rows[0];
      if (!round && (ownerInvalid || stale)) {
        const lastValid = context.last_valid_heartbeat_at ?? tx.now;
        const deadline = new Date(tx.now.valueOf()+300000);
        await tx.client.query(`INSERT INTO connection_rounds(account_id,connection_round_id,context_id,context_generation,owner_revision,last_valid_at,disconnect_confirmed_at,deadline,reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [accountId,randomUUID(),context.context_id,context.generation,context.owner_revision,lastValid,tx.now,deadline,ownerInvalid?'OWNER_ACCESS_LOST':'HEARTBEAT_STALE']);
        round = { deadline,closed_at:null };
      }
      if (round && tx.now >= round.deadline) await closeContext(tx,context,'DISCONNECT_EXPIRED');
    }
    const waits = (await tx.client.query<{ request_id: string; deadline: Date }>('SELECT request_id,deadline FROM provider_wait_rounds WHERE account_id=$1 AND closed_at IS NULL AND deadline <= $2', [accountId,tx.now])).rows;
    for (const wait of waits) {
      const request = (await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2', [accountId,wait.request_id])).rows[0];
      if (request) await finalizeSafe(tx,request,'STOPPED','PROVIDER_WAIT_EXPIRED');
    }
  }, true);
}
