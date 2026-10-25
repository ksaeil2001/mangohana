import type { QueryResultRow } from 'pg';
import type { Transaction } from '../../storage/src/database.js';
import type { Block, CommandReply, OwnedTarget, Settings, WorkspaceCommand,RenderSpecification } from '../../contracts/src/wire.generated.js';
import { requireCondition } from '../../contracts/src/errors.js';
import { counter } from '../../contracts/src/validation.js';
import { sha256 } from '../../contracts/src/intent.js';
import type { ExecutionLimitReference } from './execution-limits.js';

export type Actor = { accountId: string; sessionId: string; tabId: string; ownerCapability: string | null };
export type ContextRow = QueryResultRow & {
  account_id: string; context_id: string; project_lineage_id: string; generation: string; lifecycle: 'OPEN'|'EXITING'|'CLOSED';
  owner_session_id: string | null; owner_tab_id: string | null; owner_revision: string; workspace_revision: string;
  connection_generation: string; heartbeat_seq: string; last_valid_heartbeat_at: Date | null; owner_capability_digest: string | null;
  project_status: 'IN_PROGRESS'|'COMPLETED'; current_settings_revision: string | null; title: string;
};
export type PageRow = QueryResultRow & { account_id: string; context_id: string; project_lineage_id: string; page_lineage_id: string;
  display_order: number; excluded: boolean; skip: boolean; result_revision: string; revision: string; current_result_id: string|null;
  image_width: number; image_height: number; paid_baseline_credit: string; paid_baseline_state: 'CONFIRMED'|'UNCONFIRMED'; baseline_contribution_refs: string[];
  baseline_unsettled_refs: unknown[]; display_name: string;
};
export type EditData = { blocks: Block[]; geometryContract: string; renderContract: string; cleanupQa: 'NOT_RUN'|'NEEDS_REVIEW'|'PASSED'|'FAILED';renderSpecification?:RenderSpecification|null };
export type AssetDependency={assetId:string;sha256:string;bytesLength:string;mediaType:string};
export type SourceResultCapture={version:1;resultId:string;resultRevision:string};
export type ResultRow = QueryResultRow & { result_id: string; account_id: string; context_id: string; page_lineage_id: string; result_revision: string;
  original_asset_id: string; cleaned_asset_id: string|null; render_asset_id: string|null; edit_data: EditData; origin: string };
export type RequestRow = QueryResultRow & { account_id: string; request_id: string; retry_of_request_id: string|null; context_id: string; context_generation: string;
  project_lineage_id: string; page_lineage_id: string; batch_id: string|null; settings_revision: string; captured_scope: Scope; scope_digest: string;
  state: 'ACCEPTED'|'ACTIVE'|'WAITING'|'STOP_REQUESTED'|'COMPLETED'|'STOPPED'|'FAILED'; mode: 'FREE'|'PAID'; first_start_at: Date|null;
  expected_result_revision: string; captured_stage_order: string[]; hold_reasons: string[];
  captured_input: {originalAssetId:string;currentCleanedAssetId?:string|null;currentRenderAssetId?:string|null;assetDependencies?:AssetDependency[];parameterProfileVersion?:string;minReadableFontSizePx?:number;executionLimit?:ExecutionLimitReference;sourceResultCapture?:SourceResultCapture;data:EditData;width:number;height:number;paintInclusion?:'ANY_OVERLAP'|'CENTER';paintStrokes?:{radiusPx:number;points:{x:number;y:number}[]}[]} };
export type Scope = Extract<WorkspaceCommand['operation'],{kind:'REQUEST_TRANSLATION'}>['payload']['scope'];

export async function currentSession(tx: Transaction, actor: Actor): Promise<{ absolute_expires_at: Date; binding_id: string }> {
  const session = (await tx.client.query<{ absolute_expires_at: Date; binding_id: string; state: string }>(
    `SELECT s.absolute_expires_at,s.binding_id,b.state FROM app_sessions s JOIN login_bindings b USING(account_id,binding_id)
     WHERE s.account_id=$1 AND s.session_id=$2 AND s.revoked_at IS NULL AND s.auth_generation=$3`, [actor.accountId,actor.sessionId,tx.account.auth_generation])).rows[0];
  requireCondition(session && session.state === 'ACTIVE' && tx.now < session.absolute_expires_at, 'SESSION_REQUIRED', 401, 'LOGIN');
  return session;
}
export async function contextRow(tx: Transaction, contextId: string, lock = true): Promise<ContextRow> {
  const row = (await tx.client.query<ContextRow>(`SELECT * FROM workspace_contexts WHERE account_id=$1 AND context_id=$2 ${lock?'FOR UPDATE':''}`, [tx.account.account_id,contextId])).rows[0];
  requireCondition(row, 'ACCOUNT_ACCESS_DENIED', 403); return row;
}
export async function owner(tx: Transaction, actor: Actor, target: OwnedTarget, context: ContextRow, needsRevision = true): Promise<void> {
  requireCondition(context.lifecycle !== 'CLOSED', 'CONTEXT_CLOSED');
  requireCondition(counter(target.contextGeneration) === BigInt(context.generation), 'CONTEXT_CLOSED');
  requireCondition(actor.tabId === target.tabId && context.owner_session_id === actor.sessionId && context.owner_tab_id === actor.tabId && actor.ownerCapability && sha256(actor.ownerCapability) === context.owner_capability_digest, 'OWNER_REQUIRED', 409, 'USE_OWNER_TAB');
  requireCondition(target.expectedOwnerRevision === context.owner_revision, 'OWNER_REQUIRED', 409, 'USE_OWNER_TAB');
  if (needsRevision) requireCondition(target.expectedWorkspaceRevision === context.workspace_revision, 'REVISION_CONFLICT');
}
export async function pageRow(tx: Transaction, context: ContextRow, pageId: string): Promise<PageRow> {
  const row = (await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE', [context.account_id,context.context_id,pageId])).rows[0];
  requireCondition(row && !row.excluded, 'INPUT_INVALID', 422); return row;
}
export async function resultRow(tx: Transaction, page: PageRow): Promise<ResultRow> {
  requireCondition(page.current_result_id, 'INPUT_INVALID', 422);
  const row = (await tx.client.query<ResultRow>('SELECT * FROM results WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND result_id=$4', [page.account_id,page.context_id,page.page_lineage_id,page.current_result_id])).rows[0];
  requireCondition(row, 'DEPENDENCY_UNAVAILABLE', 409, 'WAIT'); return row;
}
export async function settingsRow(tx: Transaction, context: ContextRow, revision = context.current_settings_revision): Promise<Settings> {
  requireCondition(revision !== null, 'SETTINGS_REQUIRED', 422);
  const row = (await tx.client.query<{ captured_settings: Settings }>('SELECT captured_settings FROM settings_revisions WHERE account_id=$1 AND context_id=$2 AND settings_revision=$3', [context.account_id,context.context_id,revision])).rows[0];
  requireCondition(row, 'SETTINGS_REQUIRED', 422); return row.captured_settings;
}
export async function pageIdle(tx: Transaction, page: PageRow): Promise<void> {
  const rows = await tx.client.query('SELECT request_id FROM active_page_requests WHERE account_id=$1 AND project_lineage_id=$2 AND page_lineage_id=$3', [page.account_id,page.project_lineage_id,page.page_lineage_id]);
  requireCondition(!rows.rowCount, 'PAGE_BUSY', 409, 'WAIT');
}
export async function compositionIdle(tx: Transaction, context: ContextRow): Promise<void> {
  const row = await tx.client.query("SELECT 1 FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND state NOT IN ('COMPLETED','STOPPED','FAILED') UNION ALL SELECT 1 FROM batches WHERE account_id=$1 AND context_id=$2 AND state IN ('ACTIVE','ACCEPTED','WAITING','STOP_REQUESTED')", [context.account_id,context.context_id]);
  requireCondition(!row.rowCount, 'WORKSPACE_BUSY', 409, 'WAIT');
}
export async function bumpWorkspace(tx: Transaction, context: ContextRow): Promise<string> {
  const row = (await tx.client.query<{ workspace_revision: string }>('UPDATE workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2 RETURNING workspace_revision', [context.account_id,context.context_id])).rows[0];
  context.workspace_revision = row.workspace_revision; return row.workspace_revision;
}
export function reply(commandId: string, tx: Transaction, context: ContextRow|null, operationRef: CommandReply['operationRef'], accepted = false): CommandReply {
  return { commandId,disposition: accepted?'ACCEPTED':'APPLIED',operationRef,observedRevision: context?.workspace_revision??null,reasonCode:'NONE',nextAction:'NONE',serverTime:tx.now.toISOString() };
}
