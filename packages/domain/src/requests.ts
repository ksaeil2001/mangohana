import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../storage/src/database.js';
import { requireCondition } from '../../contracts/src/errors.js';
import { digest } from '../../contracts/src/intent.js';
import type { Settings } from '../../contracts/src/wire.generated.js';
import { captureExecutionLimitReference, type ExecutionLimitReference } from './execution-limits.js';
import { type ContextRow, type PageRow, type RequestRow, type Scope, pageIdle, resultRow, settingsRow } from './model.js';

export type RequestPolicy = { stageOrder: string[]; synthetic: boolean; paidEnabled: boolean; realProviderEnabled: boolean;batchFailureAction?:'WAIT'|'CONTINUE';paintInclusion?:'ANY_OVERLAP'|'CENTER';manualFontBelowMinimum?:'ALLOW'|'REJECT';parameterProfileVersion?:string;requiredAssetIds?:string[];minReadableFontSizePx?:number;executionLimit?:ExecutionLimitReference };
export function captureReadableFontMinimum(settings:Settings,policy:Pick<RequestPolicy,'synthetic'|'minReadableFontSizePx'>,retryOf:Pick<RequestRow,'captured_input'>|null=null):number|undefined {
  const floor=retryOf?retryOf.captured_input.minReadableFontSizePx:policy.minReadableFontSizePx;
  // An old retry uses its original capture. A newer operational profile does not rewrite it.
  if(floor===undefined){requireCondition(!!retryOf||policy.synthetic,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');return undefined;}
  requireCondition(Number.isFinite(floor)&&floor>0&&floor<=Number.MAX_SAFE_INTEGER,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  requireCondition(settings.minFontSizePx>=floor&&settings.baseFontSizePx>=floor,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  return floor;
}
export async function queueWork(tx: Transaction, kind: string, ref: Record<string, string>, delayMilliseconds = 0): Promise<void> {
  const operationDigest = digest({ kind,...ref });
  await tx.client.query(`INSERT INTO work_items(account_id,work_item_id,kind,operation_digest,due_at,claim_generation,state,revision,target_ref)
    VALUES($1,$2,$3,$4,$5,0,'READY',0,$6) ON CONFLICT(account_id,kind,operation_digest) DO UPDATE
    SET state=CASE WHEN work_items.state IN ('DONE','CLAIMED') THEN work_items.state ELSE 'READY' END,
        due_at=LEAST(work_items.due_at,EXCLUDED.due_at)`, [tx.account.account_id,randomUUID(),kind,operationDigest,new Date(tx.now.valueOf()+delayMilliseconds),JSON.stringify(ref)]);
}
export async function admitRequest(tx: Transaction, context: ContextRow, page: PageRow, scope: Scope, settings: Settings, policy: RequestPolicy,
  batchId: string|null = null, retryOf: RequestRow|null = null): Promise<string> {
  await pageIdle(tx,page);
  requireCondition(context.lifecycle === 'OPEN' || (context.lifecycle === 'EXITING' && retryOf?.first_start_at), 'CONTEXT_CLOSED');
  requireCondition(settings.sourceLanguage !== settings.targetLanguage, 'SAME_LANGUAGE', 422);
  requireCondition(settings.minFontSizePx <= settings.baseFontSizePx, 'INPUT_INVALID', 422);
  const minReadableFontSizePx=captureReadableFontMinimum(settings,policy,retryOf);
  // Retries preserve an old missing bound as well as an old explicit reference.
  const executionLimit=captureExecutionLimitReference(policy.executionLimit,retryOf?.captured_input);
  requireCondition(policy.synthetic || policy.realProviderEnabled, 'MODEL_UNVERIFIED', 409, 'WAIT');
  const unknown = (await tx.client.query("SELECT 1 FROM executions WHERE account_id=$1 AND state IN ('DISPATCHING','RUNNING','UNKNOWN')", [context.account_id])).rowCount;
  requireCondition(!unknown, 'EXECUTION_UNKNOWN', 409, 'WAIT');
  const reserved = Number((await tx.client.query<{ count: string }>("SELECT count(*) FROM free_reservations WHERE account_id=$1 AND state='HELD'", [context.account_id])).rows[0].count);
  const hasFree = tx.account.free_started_count + reserved < 10;
  requireCondition(hasFree || policy.paidEnabled, 'FREE_LIMIT_REACHED', 409, 'WAIT');
  if (!hasFree) {
    const pendingCost = (await tx.client.query(`SELECT 1 FROM cost_items c LEFT JOIN settlements s USING(account_id,cost_item_id)
      WHERE c.account_id=$1 AND (c.state='UNCONFIRMED' OR s.cost_item_id IS NULL)`, [context.account_id])).rowCount;
    requireCondition(!pendingCost, 'SETTLEMENT_PENDING', 409, 'WAIT');
  }
  if (scope.kind === 'REGIONS') {
    requireCondition(new Set(scope.regionIds).size === scope.regionIds.length, 'INPUT_INVALID', 422);
    const data = (await tx.client.query<{ edit_data: { blocks: { regionId: string }[] } }>('SELECT edit_data FROM results WHERE account_id=$1 AND result_id=$2', [page.account_id,page.current_result_id])).rows[0]?.edit_data;
    requireCondition(data && scope.regionIds.every((id) => data.blocks.some((block) => block.regionId===id)), 'INPUT_INVALID', 422);
  }
  if (scope.kind === 'PAINTED') {
    requireCondition(policy.paintInclusion,'POLICY_DECISION_REQUIRED',409,'WAIT');
    const selection = (await tx.client.query('SELECT 1 FROM paint_selections WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND selection_id=$4 AND result_revision=$5', [page.account_id,page.context_id,page.page_lineage_id,scope.selectionId,page.result_revision])).rowCount;
    requireCondition(selection, 'REVISION_CONFLICT');
  }
  const originalResult=await resultRow(tx,page);
  // A retry keeps the original provenance, including an older missing capture.
  const sourceResultCapture=retryOf?retryOf.captured_input.sourceResultCapture:{version:1 as const,resultId:originalResult.result_id,resultRevision:originalResult.result_revision};
  const requiredAssetIds=[...new Set([originalResult.original_asset_id,originalResult.cleaned_asset_id,originalResult.render_asset_id,...(policy.requiredAssetIds??[])].filter((id):id is string=>!!id))];
  const dependencies=(await tx.client.query<{asset_id:string;sha256:string;bytes_length:string;media_type:string;purpose:string;deletion_state:string}>('SELECT asset_id,sha256,bytes_length,media_type,purpose,deletion_state FROM assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[])',[context.account_id,requiredAssetIds])).rows;
  requireCondition(dependencies.length===requiredAssetIds.length&&dependencies.every(asset=>['LIVE','FONT'].includes(asset.purpose)&&asset.deletion_state!=='CONFIRMED'),'DEPENDENCY_UNAVAILABLE',409,'WAIT');
  const capturedInput={originalAssetId:originalResult.original_asset_id,currentCleanedAssetId:originalResult.cleaned_asset_id,currentRenderAssetId:originalResult.render_asset_id,
    assetDependencies:requiredAssetIds.map(id=>{const asset=dependencies.find(a=>a.asset_id===id)!;return {assetId:id,sha256:asset.sha256,bytesLength:asset.bytes_length,mediaType:asset.media_type};}),parameterProfileVersion:retryOf?.captured_input.parameterProfileVersion??policy.parameterProfileVersion??'synthetic-fixtures-v1',data:originalResult.edit_data,width:page.image_width,height:page.image_height,
    ...(minReadableFontSizePx===undefined?{}:{minReadableFontSizePx}),
    ...(executionLimit===undefined?{}:{executionLimit}),
    ...(sourceResultCapture===undefined?{}:{sourceResultCapture:structuredClone(sourceResultCapture)}),
    ...(scope.kind==='PAINTED'?{paintInclusion:policy.paintInclusion,paintStrokes:(await tx.client.query<{captured_strokes:{radiusPx:number;points:{x:number;y:number}[]}[]}>('SELECT captured_strokes FROM paint_selections WHERE account_id=$1 AND selection_id=$2',[context.account_id,scope.selectionId])).rows[0].captured_strokes}:{})};
  if(retryOf) requireCondition(digest(capturedInput)===digest(retryOf.captured_input),'DEPENDENCY_UNAVAILABLE',409,'NEW_TRANSLATION');
  const requestId = randomUUID();
  await tx.client.query(`INSERT INTO processing_requests(account_id,request_id,retry_of_request_id,context_id,context_generation,project_lineage_id,page_lineage_id,batch_id,
      settings_revision,scope_digest,captured_scope,state,hold_reasons,mode,revision,expected_result_revision,captured_stage_order,captured_input,accepted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACCEPTED','[]',$12,0,$13,$14,$15,$16)`,
    [context.account_id,requestId,retryOf?.request_id??null,context.context_id,context.generation,context.project_lineage_id,page.page_lineage_id,batchId,
      settings.settingsVersion,digest(scope),JSON.stringify(scope),hasFree?'FREE':'PAID',page.result_revision,JSON.stringify(policy.stageOrder),JSON.stringify(capturedInput),tx.now]);
  await tx.client.query('INSERT INTO active_page_requests(account_id,project_lineage_id,page_lineage_id,request_id,revision) VALUES($1,$2,$3,$4,0)', [context.account_id,context.project_lineage_id,page.page_lineage_id,requestId]);
  if (hasFree) await tx.client.query("INSERT INTO free_reservations(account_id,request_id,state,revision) VALUES($1,$2,'HELD',0)", [context.account_id,requestId]);
  for (const [ordinal, stage] of policy.stageOrder.entries()) {
    await tx.client.query('INSERT INTO request_steps(account_id,request_id,logical_step_id,execution_generation,revision,ordinal) VALUES($1,$2,$3,0,0,$4)', [context.account_id,requestId,stage,ordinal]);
    if (retryOf) {
      const prior = (await tx.client.query<{ checkpoint_id: string; dependency_digest: string }>(`SELECT c.checkpoint_id,c.dependency_digest FROM request_steps s JOIN executions e ON e.account_id=s.account_id AND e.execution_id=s.current_execution_id
        JOIN checkpoints c ON c.account_id=e.account_id AND c.execution_id=e.execution_id WHERE s.account_id=$1 AND s.request_id=$2 AND s.logical_step_id=$3 AND e.state='SUCCEEDED' AND c.verification_state='VERIFIED'`, [context.account_id,retryOf.request_id,stage])).rows[0];
      if (prior) await tx.client.query('UPDATE request_steps SET reuse_checkpoint_id=$4 WHERE account_id=$1 AND request_id=$2 AND logical_step_id=$3', [context.account_id,requestId,stage,prior.checkpoint_id]);
    }
  }
  await queueWork(tx,'DISPATCH',{ requestId });
  return requestId;
}
export async function retryRequest(tx: Transaction, context: ContextRow, requestId: string, policy: RequestPolicy): Promise<string> {
  const previous = (await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND context_id=$2 AND request_id=$3', [context.account_id,context.context_id,requestId])).rows[0];
  requireCondition(previous && previous.state==='FAILED', 'INPUT_INVALID', 422);
  const page = (await tx.client.query<PageRow>('SELECT * FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE', [context.account_id,context.context_id,previous.page_lineage_id])).rows[0];
  requireCondition(page && !page.excluded, 'INPUT_INVALID', 422);
  const settings = await settingsRow(tx,context,previous.settings_revision);
  if(previous.batch_id){const batch=(await tx.client.query<{current_request_id:string|null;state:string}>('SELECT current_request_id,state FROM batches WHERE account_id=$1 AND batch_id=$2 FOR UPDATE',[context.account_id,previous.batch_id])).rows[0];requireCondition(batch?.state==='WAITING'&&batch.current_request_id===previous.request_id,'REVISION_CONFLICT');const id=await admitRequest(tx,context,page,previous.captured_scope,settings,{...policy,paidEnabled:false},previous.batch_id,previous);await tx.client.query("UPDATE batches SET state='ACTIVE',pause_reason=NULL,current_request_id=$3,revision=revision+1 WHERE account_id=$1 AND batch_id=$2",[context.account_id,previous.batch_id,id]);return id;}
  return admitRequest(tx,context,page,previous.captured_scope,settings,policy,null,previous);
}
