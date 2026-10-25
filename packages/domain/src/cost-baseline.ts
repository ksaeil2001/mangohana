import Decimal from 'decimal.js';
import type {Transaction} from '../../storage/src/database.js';
import type {ProjectManifest} from '../../contracts/src/manifest.generated.js';
import type {ContextRow,PageRow} from './model.js';
import {money} from '../../contracts/src/validation.js';
export async function costProjection(tx:Transaction,context:ContextRow,page:PageRow):Promise<{credit:string;confirmed:boolean;contributions:string[];unsettled:ProjectManifest['unsettledReferences']}>{
  type Cost={cost_item_id:string;execution_id:string;request_id:string;debit_credit:string|null;state:string;evidence_conflict:boolean};
  const sql=`SELECT c.cost_item_id,c.execution_id,c.state,c.evidence_conflict,r.request_id,s.debit_credit FROM cost_items c JOIN executions e USING(account_id,execution_id) JOIN processing_requests r ON r.account_id=e.account_id AND r.request_id=e.request_id LEFT JOIN settlements s ON s.account_id=c.account_id AND s.cost_item_id=c.cost_item_id WHERE c.account_id=$1 AND r.page_lineage_id=$2 AND r.mode='PAID' AND r.state='COMPLETED'`;
  const costs=(await tx.client.query<Cost>(`${sql} AND r.context_id=$3`,[context.account_id,page.page_lineage_id,context.context_id])).rows;
  let total=new Decimal(page.paid_baseline_credit);const contributions=new Set(page.baseline_contribution_refs);const pending=new Map<string,ProjectManifest['unsettledReferences'][number]>();let confirmed=page.paid_baseline_state==='CONFIRMED'||page.baseline_unsettled_refs.length>0;
  const consume=(cost:Cost)=>{if(cost.debit_credit!==null&&!cost.evidence_conflict){if(!contributions.has(cost.cost_item_id)){contributions.add(cost.cost_item_id);total=total.plus(cost.debit_credit);}}else{confirmed=false;pending.set(cost.cost_item_id,{executionId:cost.execution_id,costItemId:cost.cost_item_id,pageLineageId:page.page_lineage_id,originRequestId:cost.request_id,completionKind:'NORMAL_COMPLETED'});}};
  for(const ref of page.baseline_unsettled_refs as ProjectManifest['unsettledReferences']){const matching=(await tx.client.query<Cost>(`${sql} AND r.request_id=$3 AND e.execution_id=$4 AND ($5::uuid IS NULL OR c.cost_item_id=$5)`,[context.account_id,page.page_lineage_id,ref.originRequestId,ref.executionId,ref.costItemId])).rows;const complete=ref.costItemId!==null||(await tx.client.query("SELECT 1 FROM executions WHERE account_id=$1 AND execution_id=$2 AND state='SUCCEEDED' AND output_envelope->>'usageConfirmed'='true' AND output_envelope->>'costUsd' IS NOT NULL",[context.account_id,ref.executionId])).rowCount===1;
    if(ref.pageLineageId!==page.page_lineage_id||ref.completionKind!=='NORMAL_COMPLETED'||!matching.length){confirmed=false;pending.set(`ref:${ref.executionId}:${ref.costItemId??''}`,ref);}else{for(const cost of matching)consume(cost);if(!complete){confirmed=false;pending.set(`ref:${ref.executionId}:`,ref);}}
  }
  for(const cost of costs)consume(cost);return {credit:money(total.toFixed(12)),confirmed,contributions:[...contributions],unsettled:[...pending.values()]};
}
