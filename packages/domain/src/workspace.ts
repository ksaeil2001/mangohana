import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../storage/src/database.js';
import type { CommandReply, CreateWorkspace, OwnerHeartbeat, OwnerHeartbeatReply, Settings, WorkspaceCommand } from '../../contracts/src/wire.generated.js';
import { requireCondition, DomainError } from '../../contracts/src/errors.js';
import { assertWire, counter } from '../../contracts/src/validation.js';
import { digest, intentDigest, sha256 } from '../../contracts/src/intent.js';
import { type Actor, type ContextRow, type RequestRow, bumpWorkspace, compositionIdle, contextRow, currentSession, owner, pageIdle, pageRow, reply, settingsRow } from './model.js';
import { admitRequest, retryRequest, type RequestPolicy } from './requests.js';
import { finalizeSafe, sweepAccount } from './liveness.js';
import {admitBatch,continueBatch} from './batch.js';

type CommandOutcome = { reply: CommandReply; ownerCapability?: string };
export type CommandExtension = (tx: Transaction, actor: Actor, context: ContextRow, command: WorkspaceCommand) => Promise<CommandReply|null>;

export class WorkspaceService {
  readonly extensions: CommandExtension[] = [];
  constructor(readonly db: Database, readonly policy: RequestPolicy) {}
  async create(actor: Actor, input: unknown): Promise<CommandOutcome> {
    assertWire<CreateWorkspace>('createWorkspace',input);
    await sweepAccount(this.db,actor.accountId);
    return this.db.accountTransaction(actor.accountId,async (tx) => {
      await currentSession(tx,actor);
      const prior = await this.existing(tx,input); if (prior) return this.recoverOwnerChannel(tx,actor,prior);
      requireCondition(actor.tabId===input.tabId,'INPUT_INVALID',422);
      requireCondition(!(await tx.client.query('SELECT 1 FROM account_live_context_slots WHERE account_id=$1',[actor.accountId])).rowCount,'SLOT_OCCUPIED');
      const contextId=randomUUID(); const projectId=randomUUID(); const capability=randomBytes(32).toString('base64url');
      await tx.client.query('INSERT INTO project_lineages(account_id,project_lineage_id) VALUES($1,$2)',[actor.accountId,projectId]);
      await tx.client.query(`INSERT INTO workspace_contexts(account_id,context_id,project_lineage_id,generation,lifecycle,owner_session_id,owner_tab_id,owner_revision,workspace_revision,
        connection_generation,heartbeat_seq,last_valid_heartbeat_at,owner_capability_digest,project_status,title)
        VALUES($1,$2,$3,1,'OPEN',$4,$5,0,0,1,0,$6,$7,'IN_PROGRESS','새 프로젝트')`,[actor.accountId,contextId,projectId,actor.sessionId,actor.tabId,tx.now,sha256(capability)]);
      await tx.client.query('INSERT INTO account_live_context_slots(account_id,context_id,generation,revision) VALUES($1,$2,1,0)',[actor.accountId,contextId]);
      const context=await contextRow(tx,contextId); const response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:contextId});
      await this.record(tx,input,response,'CREATE_WORKSPACE',contextId); return {reply:response,ownerCapability:capability};
    });
  }
  async recoverOwnerChannel(tx:Transaction,actor:Actor,response:CommandReply):Promise<CommandOutcome> {
    if(response.operationRef.kind!=='WORKSPACE' || !response.operationRef.id) return {reply:response};
    const row=(await tx.client.query<ContextRow>('SELECT * FROM workspace_contexts WHERE account_id=$1 AND context_id=$2 FOR UPDATE',[actor.accountId,response.operationRef.id])).rows[0];
    if(!row || row.lifecycle==='CLOSED' || row.owner_session_id!==actor.sessionId || row.owner_tab_id!==actor.tabId) return {reply:response};
    const capability=randomBytes(32).toString('base64url');
    await tx.client.query('UPDATE workspace_contexts SET owner_capability_digest=$3 WHERE account_id=$1 AND context_id=$2',[actor.accountId,row.context_id,sha256(capability)]);
    return {reply:response,ownerCapability:capability};
  }
  async existing(tx: Transaction, input: {commandId:string;intentVersion:1}): Promise<CommandReply|null> {
    const prior=(await tx.client.query<{intent_digest:string;response:CommandReply}>('SELECT intent_digest,response FROM command_receipts WHERE account_id=$1 AND command_id=$2',[tx.account.account_id,input.commandId])).rows[0];
    if (!prior) return null;
    requireCondition(prior.intent_digest===intentDigest({...input}),'INTENT_CONFLICT');
    return {...prior.response,disposition:'EXISTING',serverTime:tx.now.toISOString()};
  }
  async record(tx:Transaction,input:{commandId:string;intentVersion:1},response:CommandReply,kind:string,contextId:string|null):Promise<void> {
    await tx.client.query(`INSERT INTO command_receipts(account_id,command_id,intent_version,intent_digest,operation_kind,context_id,disposition,operation_ref,observed_revision,reason_code,response)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)`,[tx.account.account_id,input.commandId,intentDigest({...input}),kind,contextId,response.disposition,JSON.stringify(response.operationRef),response.observedRevision,response.reasonCode,JSON.stringify(response)]);
  }
  async handle(actor:Actor,input:unknown):Promise<CommandOutcome> {
    assertWire<WorkspaceCommand>('workspaceCommand',input);
    await sweepAccount(this.db,actor.accountId);
    return this.db.accountTransaction(actor.accountId,async(tx)=>{
      await currentSession(tx,actor);
      const prior=await this.existing(tx,input); if(prior) return input.operation.kind==='HANDOFF'?this.recoverOwnerChannel(tx,actor,prior):{reply:prior};
      const context=await contextRow(tx,input.target.contextId);
      let capability:string|undefined;
      let response:CommandReply;
      const operation=input.operation;
      if(operation.kind==='HANDOFF') {
        requireCondition(context.lifecycle!=='CLOSED' && context.generation===input.target.contextGeneration,'CONTEXT_CLOSED');
        requireCondition(context.owner_revision===input.target.expectedOwnerRevision && context.workspace_revision===input.target.expectedWorkspaceRevision,'REVISION_CONFLICT');
        requireCondition(actor.tabId===operation.payload.newTabId && actor.tabId===input.target.tabId,'INPUT_INVALID',422);
        capability=randomBytes(32).toString('base64url');
        await tx.client.query(`UPDATE workspace_contexts SET owner_session_id=$3,owner_tab_id=$4,owner_revision=owner_revision+1,connection_generation=connection_generation+1,
          heartbeat_seq=0,last_valid_heartbeat_at=$5,owner_capability_digest=$6 WHERE account_id=$1 AND context_id=$2`,[context.account_id,context.context_id,actor.sessionId,actor.tabId,tx.now,sha256(capability)]);
        await tx.client.query('UPDATE connection_rounds SET closed_at=$3 WHERE account_id=$1 AND context_id=$2 AND closed_at IS NULL',[context.account_id,context.context_id,tx.now]);
        response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
      } else {
        await owner(tx,actor,input.target,context,operation.kind!=='RECONNECT');
        if(operation.kind==='RECONNECT') {
          requireCondition(operation.payload.priorConnectionGeneration===context.connection_generation,'OWNER_REQUIRED');
          const round=(await tx.client.query<{deadline:Date}>('SELECT deadline FROM connection_rounds WHERE account_id=$1 AND context_id=$2 AND closed_at IS NULL',[context.account_id,context.context_id])).rows[0];
          requireCondition(!round || tx.now<round.deadline,'DISCONNECT_EXPIRED');
          await tx.client.query('UPDATE connection_rounds SET closed_at=$3 WHERE account_id=$1 AND context_id=$2 AND closed_at IS NULL',[context.account_id,context.context_id,tx.now]);
          await tx.client.query('UPDATE workspace_contexts SET connection_generation=connection_generation+1,heartbeat_seq=0,last_valid_heartbeat_at=$3 WHERE account_id=$1 AND context_id=$2',[context.account_id,context.context_id,tx.now]);
          response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
        } else if(operation.kind==='PATCH_SETTINGS') {
          const settings:Settings=operation.payload.settings;
          requireCondition(context.lifecycle==='OPEN','CONTEXT_CLOSED');
          const current=context.current_settings_revision===null?0n:BigInt(context.current_settings_revision);
          requireCondition(counter(settings.settingsVersion)===current+1n && settings.minFontSizePx<=settings.baseFontSizePx,'REVISION_CONFLICT');
          await tx.client.query('INSERT INTO settings_revisions(account_id,context_id,settings_revision,contract_version,captured_settings) VALUES($1,$2,$3,$4,$5)',[context.account_id,context.context_id,settings.settingsVersion,settings.contractVersion,JSON.stringify(settings)]);
          await tx.client.query('UPDATE workspace_contexts SET current_settings_revision=$3 WHERE account_id=$1 AND context_id=$2',[context.account_id,context.context_id,settings.settingsVersion]);
          await bumpWorkspace(tx,context); response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
        } else if(operation.kind==='REQUEST_TRANSLATION' || operation.kind==='RETRANSLATE') {
          const page=await pageRow(tx,context,operation.payload.pageId);
          requireCondition(page.result_revision===operation.payload.expectedResultRevision,'REVISION_CONFLICT');
          requireCondition(context.current_settings_revision===operation.payload.settingsVersion,'REVISION_CONFLICT');
          const settings=await settingsRow(tx,context);
          const requestId=await admitRequest(tx,context,page,operation.payload.scope,settings,this.policy);
          response=reply(input.commandId,tx,context,{kind:'REQUEST',id:requestId},true);
        } else if(operation.kind==='BATCH_TRANSLATION') {
          const id=await admitBatch(tx,context,operation.payload.pageIdsInOrder,operation.payload.settingsVersion,this.policy);response=reply(input.commandId,tx,context,{kind:id?'BATCH':'NONE',id},Boolean(id));
        } else if(operation.kind==='CONTINUE_BATCH') {
          await continueBatch(tx,context,operation.payload,this.policy);response=reply(input.commandId,tx,context,{kind:'BATCH',id:operation.payload.batchId},true);
        } else if(operation.kind==='RETRY_REQUEST') {
          const requestId=await retryRequest(tx,context,operation.payload.requestId,this.policy);
          response=reply(input.commandId,tx,context,{kind:'REQUEST',id:requestId},true);
        } else if(operation.kind==='REQUEST_STOP') {
          const {operationKind,operationId}=operation.payload;
          if(operationKind==='BATCH') {
            const batch=await tx.client.query("UPDATE batches SET state='STOP_REQUESTED',stop_command_id=$4,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND batch_id=$3 AND state IN ('ACCEPTED','ACTIVE','WAITING') RETURNING batch_id",[context.account_id,context.context_id,operationId,input.commandId]);
            requireCondition(batch.rowCount,'INPUT_INVALID',422);
          }
          const requests=(await tx.client.query<RequestRow>(`SELECT * FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND ${operationKind==='REQUEST'?'request_id':'batch_id'}=$3 AND state NOT IN ('COMPLETED','STOPPED','FAILED')`,[context.account_id,context.context_id,operationId])).rows;
          requireCondition(operationKind==='BATCH' || requests.length,'INPUT_INVALID',422);
          for(const request of requests) {
            if(!request.first_start_at) await finalizeSafe(tx,request,'STOPPED','USER_STOP_CONFIRMED_NOT_STARTED');
            else await tx.client.query("UPDATE processing_requests SET state='STOP_REQUESTED',revision=revision+1 WHERE account_id=$1 AND request_id=$2",[context.account_id,request.request_id]);
          }
          response=reply(input.commandId,tx,context,{kind:operationKind,id:operationId},true);
        } else if(operation.kind==='CAPTURE_PAINT_SELECTION') {
          requireCondition(this.policy.paintInclusion,'POLICY_DECISION_REQUIRED',409,'WAIT');
          const page=await pageRow(tx,context,operation.payload.pageId); await pageIdle(tx,page);
          requireCondition(page.result_revision===operation.payload.expectedResultRevision,'REVISION_CONFLICT');
          for(const stroke of operation.payload.strokes) {
            requireCondition(stroke.radiusPx>0 && stroke.radiusPx<=Math.max(page.image_width,page.image_height),'INPUT_INVALID',422);
            for(const point of stroke.points) requireCondition(point.x>=0 && point.y>=0 && point.x<=page.image_width && point.y<=page.image_height,'INPUT_INVALID',422);
          }
          const selectionId=randomUUID();
          await tx.client.query('INSERT INTO paint_selections(account_id,selection_id,context_id,page_lineage_id,result_revision,captured_strokes,selection_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[context.account_id,selectionId,context.context_id,page.page_lineage_id,page.result_revision,JSON.stringify(operation.payload.strokes),digest(operation.payload.strokes),tx.now]);
          response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:selectionId});
        } else if(operation.kind==='SET_PROJECT_STATUS') {
          await tx.client.query('UPDATE workspace_contexts SET project_status=$3 WHERE account_id=$1 AND context_id=$2',[context.account_id,context.context_id,operation.payload.status]);
          await bumpWorkspace(tx,context); response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
        } else if(operation.kind==='EXCLUDE_PAGES' || operation.kind==='SET_SKIP' || operation.kind==='REORDER_PAGES') {
          await compositionIdle(tx,context);
          const ids=operation.kind==='REORDER_PAGES'?operation.payload.pageIdsInOrder:operation.payload.pageIds;
          requireCondition(new Set(ids).size===ids.length,'INPUT_INVALID',422);
          for(const id of ids) await pageRow(tx,context,id);
          if(operation.kind==='REORDER_PAGES') {
            const count=Number((await tx.client.query<{count:string}>('SELECT count(*) FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND excluded=false',[context.account_id,context.context_id])).rows[0].count);
            requireCondition(count===ids.length,'INPUT_INVALID',422);
            await tx.client.query('SET CONSTRAINTS ALL DEFERRED');
            const excluded=(await tx.client.query<{page_lineage_id:string}>('SELECT page_lineage_id FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND excluded=true ORDER BY display_order',[context.account_id,context.context_id])).rows.map((page)=>page.page_lineage_id);
            for(const [order,id] of [...ids,...excluded].entries()) await tx.client.query('UPDATE workspace_pages SET display_order=$4,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[context.account_id,context.context_id,id,order]);
          } else for(const id of ids) await tx.client.query(`UPDATE workspace_pages SET ${operation.kind==='EXCLUDE_PAGES'?'excluded=true':'skip=$4'},revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3`,operation.kind==='EXCLUDE_PAGES'?[context.account_id,context.context_id,id]:[context.account_id,context.context_id,id,operation.payload.skip]);
          await bumpWorkspace(tx,context); response=reply(input.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
        } else {
          let handled:CommandReply|null=null;
          for(const extension of this.extensions) { handled=await extension(tx,actor,context,input); if(handled) break; }
          if(!handled) throw new DomainError('DEPENDENCY_UNAVAILABLE',409,'WAIT');
          response=handled;
        }
      }
      await this.record(tx,input,response,operation.kind,context.context_id); return {reply:response,...(capability?{ownerCapability:capability}:{})};
    });
  }
  async heartbeat(actor:Actor,input:unknown):Promise<OwnerHeartbeatReply> {
    assertWire<OwnerHeartbeat>('ownerHeartbeat',input); await sweepAccount(this.db,actor.accountId);
    return this.db.accountTransaction(actor.accountId,async(tx)=>{
      await currentSession(tx,actor); const context=await contextRow(tx,input.contextId);
      await owner(tx,actor,{...input,expectedWorkspaceRevision:context.workspace_revision},context,false);
      requireCondition(context.connection_generation===input.connectionGeneration,'OWNER_REQUIRED');
      const round=(await tx.client.query<{deadline:Date}>('SELECT deadline FROM connection_rounds WHERE account_id=$1 AND context_id=$2 AND closed_at IS NULL',[actor.accountId,context.context_id])).rows[0];
      if(!round && counter(input.heartbeatSeq)>BigInt(context.heartbeat_seq)) {
        await tx.client.query('UPDATE workspace_contexts SET heartbeat_seq=$3,last_valid_heartbeat_at=$4 WHERE account_id=$1 AND context_id=$2',[actor.accountId,context.context_id,input.heartbeatSeq,tx.now]);
        context.heartbeat_seq=input.heartbeatSeq; context.last_valid_heartbeat_at=tx.now;
      }
      return {connectionGeneration:context.connection_generation,lastAcceptedSeq:context.heartbeat_seq,lastValidAt:context.last_valid_heartbeat_at?.toISOString()??null,
        reconnectUntil:round?.deadline.toISOString()??null,ownerRevision:context.owner_revision,reasonCode:round?'ACTIVE_WORK':'NONE',serverTime:tx.now.toISOString()};
    });
  }
}
