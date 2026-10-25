import {balloonRendererVersion,manualRendererVersion} from '../../media/src/render-policy.js';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Transaction } from '../../storage/src/database.js';
import type { Block,RenderSpecification } from '../../contracts/src/wire.generated.js';
import { requireCondition } from '../../contracts/src/errors.js';
import { assertWire } from '../../contracts/src/validation.js';
import { digest } from '../../contracts/src/intent.js';
import { type EditData, type PageRow, type ResultRow, bumpWorkspace, pageIdle, pageRow, reply, resultRow } from './model.js';
import type { CommandExtension } from './workspace.js';
import { queueWork,type RequestPolicy } from './requests.js';

type CapturedRender={version:1;fontCatalogVersion:string;block:RenderSpecification['blocks'][number]|null};
type Delta={regionId:string;before:Block;after:Block;dependencies:string;beforeRender?:CapturedRender|null;afterRender?:CapturedRender|null;beforeDependencies?:string;afterDependencies?:string};
type History=QueryResultRow&{history_id:string;parent_history_id:string|null;validity:string;protected_delta:Delta;sequence_no:string;invalid_reason:string|null};
type Cursor={revision:string;cursor_history_id:string|null};
function capturedRender(data:EditData,block:Block):CapturedRender|null {
  const spec=data.renderSpecification;if(!spec)return null;
  return {version:spec.version,fontCatalogVersion:spec.fontCatalogVersion,block:structuredClone(spec.blocks.find(item=>item.regionId===block.regionId)??null)};
}
const legacyDependencies=(result:ResultRow,block:Block)=>digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,geometryContract:result.edit_data.geometryContract,renderContract:result.edit_data.renderContract,geometry:block.geometry});
export const blockDependencies=(result:ResultRow,block:Block)=>digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,geometryContract:result.edit_data.geometryContract,renderContract:result.edit_data.renderContract,geometry:block.geometry,renderSpecification:capturedRender(result.edit_data,block)});
function matches(delta:Delta,result:ResultRow,block:Block,undo:boolean):boolean {
  if(digest(block)!==digest(undo?delta.after:delta.before))return false;
  if(delta.beforeDependencies===undefined||delta.afterDependencies===undefined)return !result.edit_data.renderSpecification&&legacyDependencies(result,block)===delta.dependencies;
  return blockDependencies(result,block)===(undo?delta.afterDependencies:delta.beforeDependencies)&&digest(capturedRender(result.edit_data,block))===digest(undo?delta.afterRender:delta.beforeRender);
}
function restoreRender(data:EditData,regionId:string,captured:CapturedRender|null):void {
  if(captured===null){requireCondition(!data.renderSpecification,'REVISION_CONFLICT');return;}
  const spec=data.renderSpecification;requireCondition(spec&&spec.version===captured.version&&spec.fontCatalogVersion===captured.fontCatalogVersion&&captured.block,'REVISION_CONFLICT');
  const index=spec.blocks.findIndex(block=>block.regionId===regionId);requireCondition(index>=0,'REVISION_CONFLICT');spec.blocks[index]=structuredClone(captured.block);
}
export async function historyCursor(tx:Transaction,page:PageRow):Promise<Cursor> {
  await tx.client.query('INSERT INTO history_cursors(account_id,context_id,page_lineage_id,revision) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING',[page.account_id,page.context_id,page.page_lineage_id]);
  return (await tx.client.query<Cursor>('SELECT revision,cursor_history_id FROM history_cursors WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 FOR UPDATE',[page.account_id,page.context_id,page.page_lineage_id])).rows[0];
}
async function candidate(tx:Transaction,page:PageRow,cursor:Cursor,undo:boolean):Promise<History|null> {
  let id=cursor.cursor_history_id;const visited=new Set<string>();
  for(let i=0;i<10000;i++) {
    const row=(await tx.client.query<History>(undo?'SELECT * FROM manual_history WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND history_id=$4':"SELECT * FROM manual_history WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND parent_history_id IS NOT DISTINCT FROM $4::uuid AND invalid_reason IS DISTINCT FROM 'REDO_BRANCH_DISCARDED' ORDER BY sequence_no DESC LIMIT 1",[page.account_id,page.context_id,page.page_lineage_id,id])).rows[0];
    if(!row || visited.has(row.history_id)) return null;
    visited.add(row.history_id);if(row.validity==='VALID') return row;id=undo?row.parent_history_id:row.history_id;
  }
  return null;
}
export async function manualAvailability(tx:Transaction,page:PageRow,result:ResultRow):Promise<{revision:string;cursorId:string|null;canUndo:boolean;canRedo:boolean;reasonCode:'NONE'|'ACTIVE_WORK'|'REVISION_CONFLICT'}> {
  const cursor=await historyCursor(tx,page);const locked=!!(await tx.client.query('SELECT 1 FROM active_page_requests WHERE account_id=$1 AND project_lineage_id=$2 AND page_lineage_id=$3',[page.account_id,page.project_lineage_id,page.page_lineage_id])).rowCount;
  const valid=(h:History|null,undo:boolean)=>!!h&&result.edit_data.blocks.some(block=>block.regionId===h.protected_delta.regionId&&matches(h.protected_delta,result,block,undo));
  const undo=await candidate(tx,page,cursor,true);const redo=await candidate(tx,page,cursor,false);
  return {revision:cursor.revision,cursorId:cursor.cursor_history_id,canUndo:!locked&&valid(undo,true),canRedo:!locked&&valid(redo,false),reasonCode:locked?'ACTIVE_WORK':((undo&&!valid(undo,true))||(redo&&!valid(redo,false)))?'REVISION_CONFLICT':'NONE'};
}
export async function insertResult(tx:Transaction,page:PageRow,before:ResultRow,data:EditData):Promise<{id:string;revision:string}> {
  const id=randomUUID();const revision=(await tx.client.query<{next_revision:string}>('SELECT (coalesce(max(result_revision),-1)+1)::text AS next_revision FROM results WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id])).rows[0].next_revision;
  await tx.client.query(`INSERT INTO results(account_id,result_id,context_id,page_lineage_id,result_revision,original_asset_id,cleaned_asset_id,protected_edit_data_ref,origin,edit_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$2::uuid::text,'MANUAL_EDIT',$8)`,[page.account_id,id,page.context_id,page.page_lineage_id,revision,before.original_asset_id,before.cleaned_asset_id,JSON.stringify(data)]);
  await tx.client.query('UPDATE workspace_pages SET current_result_id=$4,result_revision=$5,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id,id,revision]);await queueWork(tx,'STORE',{resultId:id});return {id,revision};
}
export function manualCommands(validateFont:(id:string)=>boolean,maxTextLength:number,maxFontSize:number,options:Pick<RequestPolicy,'manualFontBelowMinimum'>&{fontCatalogVersion?:string}={}):CommandExtension {
  return async(tx,_actor,context,command)=>{
    const op=command.operation;if(!['MANUAL_EDIT','UNDO','REDO'].includes(op.kind)) return null;
    if(op.kind!=='MANUAL_EDIT'&&op.kind!=='UNDO'&&op.kind!=='REDO') return null;
    const page=await pageRow(tx,context,op.payload.pageId);await pageIdle(tx,page);const before=await resultRow(tx,page);const cursor=await historyCursor(tx,page);
    const data=structuredClone(before.edit_data);
    if(op.kind==='MANUAL_EDIT') {
      requireCondition(page.result_revision===op.payload.expectedResultRevision,'REVISION_CONFLICT');
      // Legacy v1 used renderPage's fixed minimum of 1. Capture that existing behavior with the pinned runtime catalog, never future settings.
      if(!data.renderSpecification&&options.fontCatalogVersion)data.renderSpecification={version:1,fontCatalogVersion:options.fontCatalogVersion,blocks:data.blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT'}))};
      const block=data.blocks.find(b=>b.regionId===op.payload.regionId);requireCondition(block,'INPUT_INVALID',422);
      const prior=structuredClone(block);const patch=op.payload.patch;const beforeRender=capturedRender(data,block);const beforeDependencies=blockDependencies({...before,edit_data:data},block);
      if(patch.sourceText!==undefined) {requireCondition(patch.sourceText.length<=maxTextLength,'INPUT_INVALID',422);block.sourceText={value:patch.sourceText,status:'USER_MODIFIED'};}
      if(patch.translatedText!==undefined) {requireCondition(patch.translatedText.length<=maxTextLength,'INPUT_INVALID',422);block.translatedText={value:patch.translatedText,status:'USER_MODIFIED'};}
      if(patch.orientation!==undefined) {
        requireCondition(patch.orientation==='HORIZONTAL'||patch.orientation==='VERTICAL','INPUT_INVALID',422);
        block.geometry.orientation=patch.orientation;
      }
      if(patch.targetOrientation!==undefined) {
        const specification=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);
        if(patch.targetOrientation===null){if(specification)delete specification.targetOrientation;}
        else {
          requireCondition(patch.targetOrientation==='HORIZONTAL'||patch.targetOrientation==='VERTICAL','INPUT_INVALID',422);
          requireCondition(specification,'DEPENDENCY_UNAVAILABLE');specification.targetOrientation=patch.targetOrientation;
        }
      }
      if(patch.typesetBox!==undefined) {
        const specification=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);
        if(patch.typesetBox===null){if(specification){delete specification.typesetBox;if(specification.rendererVersion===balloonRendererVersion)specification.rendererVersion=manualRendererVersion(specification.rendererVersion,true);}}
        else {
          requireCondition(specification,'DEPENDENCY_UNAVAILABLE');assertWire('typesetBox',patch.typesetBox);
          const {left,top,width,height}=patch.typesetBox,right=left+width,bottom=top+height;
          requireCondition(Number.isFinite(right)&&Number.isFinite(bottom)&&right>left&&bottom>top&&right<=page.image_width&&bottom<=page.image_height&&[Math.floor(left),Math.floor(top),Math.ceil(right),Math.ceil(bottom)].every(Number.isSafeInteger)&&Math.ceil(right)>Math.floor(left)&&Math.ceil(bottom)>Math.floor(top),'INPUT_INVALID',422);
          specification.typesetBox=structuredClone(patch.typesetBox);
        }
      }
      if(patch.fontAssetId!==undefined) {requireCondition(validateFont(patch.fontAssetId),'INPUT_INVALID',422);block.fontAssetId=patch.fontAssetId;}
      if(patch.fontSizePx!==undefined) {
        requireCondition(Number.isFinite(patch.fontSizePx)&&patch.fontSizePx>0&&patch.fontSizePx<=maxFontSize,'INPUT_INVALID',422);
        if(patch.fontSizePx!==block.fontSizePx){
          const specification=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);requireCondition(specification,'DEPENDENCY_UNAVAILABLE');
          if(patch.fontSizePx<specification.minimumFontSizePx){requireCondition(options.manualFontBelowMinimum!==undefined,'POLICY_DECISION_REQUIRED',409,'WAIT');requireCondition(options.manualFontBelowMinimum==='ALLOW','INPUT_INVALID',422);}
          specification.sizing='EXACT';block.fontSizePx=patch.fontSizePx;
        }
      }
      if(digest(prior)!==digest(block)||digest(beforeRender)!==digest(capturedRender(data,block))){const specification=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);if(specification)specification.rendererVersion=manualRendererVersion(specification.rendererVersion);}
      const delta:Delta={regionId:block.regionId,before:prior,after:structuredClone(block),dependencies:beforeDependencies,beforeRender,afterRender:capturedRender(data,block),beforeDependencies,afterDependencies:blockDependencies({...before,edit_data:data},block)};
      await tx.client.query(`WITH RECURSIVE branch AS (SELECT history_id FROM manual_history WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND parent_history_id IS NOT DISTINCT FROM $4::uuid
        UNION ALL SELECT h.history_id FROM manual_history h JOIN branch b ON h.parent_history_id=b.history_id WHERE h.account_id=$1 AND h.context_id=$2 AND h.page_lineage_id=$3)
        UPDATE manual_history SET validity='INVALIDATED',invalid_reason='REDO_BRANCH_DISCARDED' WHERE account_id=$1 AND history_id IN (SELECT history_id FROM branch)`,[page.account_id,page.context_id,page.page_lineage_id,cursor.cursor_history_id]);
      const next=await insertResult(tx,page,before,data);const historyId=randomUUID();
      await tx.client.query(`INSERT INTO manual_history(account_id,history_id,context_id,page_lineage_id,parent_history_id,dependency_digest,protected_delta_ref,validity,before_result_id,after_result_id,protected_delta)
        VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text,'VALID',$7,$8,$9)`,[page.account_id,historyId,page.context_id,page.page_lineage_id,cursor.cursor_history_id,delta.dependencies,before.result_id,next.id,JSON.stringify(delta)]);
      await tx.client.query('UPDATE history_cursors SET cursor_history_id=$4,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id,historyId]);
    } else {
      requireCondition(cursor.revision===op.payload.expectedHistoryRevision&&cursor.cursor_history_id===op.payload.cursorId,'REVISION_CONFLICT');
      const undo=op.kind==='UNDO';const history=await candidate(tx,page,cursor,undo);requireCondition(history,'REVISION_CONFLICT');const delta=history.protected_delta;
      const index=data.blocks.findIndex(b=>b.regionId===delta.regionId);requireCondition(index>=0,'REVISION_CONFLICT');const block=data.blocks[index];
      requireCondition(matches(delta,before,block,undo),'REVISION_CONFLICT');
      data.blocks[index]=structuredClone(undo?delta.before:delta.after);const rendering=undo?delta.beforeRender:delta.afterRender;if(rendering!==undefined)restoreRender(data,delta.regionId,rendering);await insertResult(tx,page,before,data);
      await tx.client.query('UPDATE history_cursors SET cursor_history_id=$4,revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id,undo?history.parent_history_id:history.history_id]);
    }
    await bumpWorkspace(tx,context);return reply(command.commandId,tx,context,{kind:'WORKSPACE',id:context.context_id});
  };
}
export async function invalidateChangedHistory(tx:Transaction,page:PageRow,before:ResultRow,after:EditData):Promise<void> {
  const histories=(await tx.client.query<History>("SELECT * FROM manual_history WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3 AND validity='VALID'",[page.account_id,page.context_id,page.page_lineage_id])).rows;
  let changed=false;
  for(const history of histories) {
    const delta=history.protected_delta;const old=before.edit_data.blocks.find(b=>b.regionId===delta.regionId);const next=after.blocks.find(b=>b.regionId===delta.regionId);
    if(!old||!next||digest(old)!==digest(next)||blockDependencies(before,old)!==blockDependencies({...before,edit_data:after},next)) {
      await tx.client.query("UPDATE manual_history SET validity='INVALIDATED',invalid_reason='AI_RESULT_REPLACED' WHERE account_id=$1 AND history_id=$2",[page.account_id,history.history_id]);changed=true;
    }
  }
  if(changed) await tx.client.query('UPDATE history_cursors SET revision=revision+1 WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[page.account_id,page.context_id,page.page_lineage_id]);
}
