import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {manualPageMatches} from '../../apps/web/src/App.js';
import {manualCommands} from '../../packages/domain/src/manual.js';
import type {Actor,ContextRow,EditData,PageRow,ResultRow} from '../../packages/domain/src/model.js';
import type {Transaction} from '../../packages/storage/src/database.js';
import type {Block,PageView,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {assertWire} from '../../packages/contracts/src/validation.js';

function blocks():Block[]{
  const fontAssetId=randomUUID();
  return [0,1].map(index=>({
    regionId:randomUUID(),
    geometry:{polygon:[{x:20+index*60,y:10},{x:70+index*60,y:10},{x:70+index*60,y:160},{x:20+index*60,y:160}],readingOrder:index,angleDegrees:0,orientation:'VERTICAL'},
    sourceText:{value:'확정 원문',status:'USER_CONFIRMED'},
    translatedText:{value:'확정 번역\n두 번째 줄',status:'USER_CONFIRMED'},
    fontAssetId,fontSizePx:24,appliedTranslation:null,
  }));
}
function pageFixture(legacy=false){
  const value=blocks();
  const before:PageView={pageLineageId:randomUUID(),originalAssetId:randomUUID(),cleanedAssetId:randomUUID(),renderAssetId:randomUUID(),widthPx:400,heightPx:400,skip:false,resultRevision:'0',blocks:value,paidCumulativeBaselineCredit:'0',baselineContributionIds:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',displayName:'saved-fixture.png',paidCumulativeBaselineState:'UNCONFIRMED',paidCumulativeCurrentCredit:null,paidCumulativeState:'UNCONFIRMED',history:{revision:'0',cursorId:null,canUndo:false,canRedo:false,reasonCode:'NONE'},...(legacy?{}:{renderSpecification:{version:1,fontCatalogVersion:'pinned-catalog-v1',blocks:value.map(block=>({regionId:block.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT'}))}})};
  const command:WorkspaceCommand={commandId:randomUUID(),intentVersion:1,target:{contextId:randomUUID(),contextGeneration:'1',tabId:randomUUID(),expectedOwnerRevision:'0',expectedWorkspaceRevision:'0'},operation:{kind:'MANUAL_EDIT',payload:{pageId:before.pageLineageId,regionId:value[0].regionId,expectedResultRevision:'0',patch:{orientation:'HORIZONTAL'}}}};
  const capture:Parameters<typeof manualPageMatches>[0]={before,draft:{pageId:before.pageLineageId,regionId:value[0].regionId,revision:'0',sourceText:value[0].sourceText.value,translatedText:value[0].translatedText.value,fontAssetId:value[0].fontAssetId,fontSizePx:24,orientation:'HORIZONTAL',editedFields:['orientation']},pending:{path:'/api/commands',body:command,preauth:false}};
  const next=structuredClone(before);
  next.resultRevision='1';
  next.blocks[0].geometry.orientation='HORIZONTAL';
  next.renderSpecification??={version:1,fontCatalogVersion:'pinned-catalog-v1',blocks:value.map(block=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT'}))};
  next.renderSpecification.blocks[0].rendererVersion='pango-overflow-v2';
  return {before,capture,next,command};
}

describe('manual direction result reconciliation without IO',()=>{
  it.each([false,true])('accepts exact orientation and existing renderer capture for legacy=%s',legacy=>{
    const f=pageFixture(legacy),captured=structuredClone(f.capture);
    expect(manualPageMatches(f.capture,f.next)).toBe(true);
    expect(f.capture).toEqual(captured);
    expect(f.next.blocks[0].sourceText.status).toBe('USER_CONFIRMED');
    expect(f.next.blocks[0].translatedText.status).toBe('USER_CONFIRMED');
    expect(f.next.cleanedAssetId).toBe(f.before.cleanedAssetId);
  });
  it.each(['ORIENTATION','POLYGON','ANGLE','ORDER','TEXT_STATUS','CLEANUP','MINIMUM','SIZING','RENDERER'] as const)('keeps the draft when the read result has a different %s',kind=>{
    const f=pageFixture();
    if(kind==='ORIENTATION')f.next.blocks[0].geometry.orientation='VERTICAL';
    if(kind==='POLYGON')f.next.blocks[0].geometry.polygon[0].x++;
    if(kind==='ANGLE')f.next.blocks[0].geometry.angleDegrees=10;
    if(kind==='ORDER')f.next.blocks[0].geometry.readingOrder++;
    if(kind==='TEXT_STATUS')f.next.blocks[0].translatedText.status='USER_MODIFIED';
    if(kind==='CLEANUP')f.next.cleanedAssetId=randomUUID();
    if(kind==='MINIMUM')f.next.renderSpecification!.blocks[0].minimumFontSizePx=1;
    if(kind==='SIZING')f.next.renderSpecification!.blocks[0].sizing='EXACT';
    if(kind==='RENDERER')delete f.next.renderSpecification!.blocks[0].rendererVersion;
    expect(manualPageMatches(f.capture,f.next)).toBe(false);
  });
  it('keeps legacy catalog capture and sibling renderer settings exact',()=>{
    const f=pageFixture(true);f.next.renderSpecification!.blocks[1].rendererVersion='pango-overflow-v2';
    expect(manualPageMatches(f.capture,f.next)).toBe(false);
  });
  it('does not permit direction changes when the command only changes translated text',()=>{
    const f=pageFixture();
    if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('Fixture operation');
    f.command.operation.payload.patch={translatedText:'직접 수정'};
    f.next.blocks[0].translatedText={value:'직접 수정',status:'USER_MODIFIED'};
    expect(manualPageMatches(f.capture,f.next)).toBe(false);
    f.next.blocks[0].geometry.orientation='VERTICAL';
    expect(manualPageMatches(f.capture,f.next)).toBe(true);
  });
  it('combines an explicit size with orientation using the existing EXACT capture',()=>{
    const f=pageFixture();
    if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('Fixture operation');
    f.command.operation.payload.patch.fontSizePx=18;
    f.next.blocks[0].fontSizePx=18;
    f.next.renderSpecification!.blocks[0].sizing='EXACT';
    expect(manualPageMatches(f.capture,f.next)).toBe(true);
  });
});

// SQL bookkeeping is an owned in-memory port. Unexpected SQL is an error.
// No PostgreSQL, provider, native work, credentials or assets are accessed.
function manualFixture(legacy:boolean){
  const view=pageFixture(legacy).before,accountId=randomUUID(),contextId=randomUUID(),projectId=randomUUID();
  const context={account_id:accountId,context_id:contextId,project_lineage_id:projectId,workspace_revision:'0'} as ContextRow;
  const page={account_id:accountId,context_id:contextId,project_lineage_id:projectId,page_lineage_id:view.pageLineageId,excluded:false,current_result_id:randomUUID(),result_revision:'0',revision:'0',image_width:view.widthPx,image_height:view.heightPx} as PageRow;
  const data:EditData={blocks:view.blocks,geometryContract:view.geometryContract,renderContract:view.renderContract,cleanupQa:view.cleanupQa,...(view.renderSpecification?{renderSpecification:view.renderSpecification}:{})};
  const original:ResultRow={result_id:page.current_result_id!,account_id:accountId,context_id:contextId,page_lineage_id:view.pageLineageId,result_revision:'0',original_asset_id:view.originalAssetId,cleaned_asset_id:view.cleanedAssetId,render_asset_id:view.renderAssetId,edit_data:data,origin:'AI_APPLIED'};
  const results=new Map([[original.result_id,structuredClone(original)]]);
  const cursor={revision:'0',cursor_history_id:null as string|null};
  type SavedHistory={history_id:string;parent_history_id:string|null;validity:string;protected_delta:unknown;sequence_no:string;invalid_reason:null};
  const histories:SavedHistory[]=[],work:{kind:string;resultId:string}[]=[];
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>=>{
    let rows:unknown[]=[];
    if(sql.startsWith('SELECT * FROM workspace_pages'))rows=[structuredClone(page)];
    else if(sql.startsWith('SELECT request_id FROM active_page_requests'))rows=[];
    else if(sql.startsWith('SELECT * FROM results'))rows=[structuredClone(results.get(String(values[3])))];
    else if(sql.startsWith('INSERT INTO history_cursors'))rows=[];
    else if(sql.startsWith('SELECT revision,cursor_history_id'))rows=[{...cursor}];
    else if(sql.startsWith('SELECT (coalesce(max(result_revision)'))rows=[{next_revision:String(results.size)}];
    else if(sql.startsWith('INSERT INTO results')){
      const previous=results.get(page.current_result_id!)!;
      const next:ResultRow={...previous,result_id:String(values[1]),result_revision:String(values[4]),original_asset_id:String(values[5]),cleaned_asset_id:values[6] as string|null,edit_data:JSON.parse(String(values[7])) as EditData,origin:'MANUAL_EDIT',render_asset_id:null};
      results.set(next.result_id,next);
    }else if(sql.startsWith('UPDATE workspace_pages')){
      page.current_result_id=String(values[3]);page.result_revision=String(values[4]);page.revision=String(BigInt(page.revision)+1n);
    }else if(sql.startsWith('INSERT INTO work_items')){
      work.push({kind:String(values[2]),resultId:JSON.parse(String(values[5])).resultId as string});
    }else if(sql.startsWith('WITH RECURSIVE branch'))rows=[];
    else if(sql.startsWith('INSERT INTO manual_history')){
      histories.push({history_id:String(values[1]),parent_history_id:values[4] as string|null,validity:'VALID',protected_delta:JSON.parse(String(values[8])) as unknown,sequence_no:String(histories.length+1),invalid_reason:null});
    }else if(sql.startsWith('UPDATE history_cursors')){
      cursor.cursor_history_id=values[3] as string|null;cursor.revision=String(BigInt(cursor.revision)+1n);
    }else if(sql.startsWith('UPDATE workspace_contexts')){
      context.workspace_revision=String(BigInt(context.workspace_revision)+1n);rows=[{workspace_revision:context.workspace_revision}];
    }else if(sql.startsWith('SELECT * FROM manual_history')){
      rows=sql.includes('parent_history_id IS NOT DISTINCT FROM')?histories.filter(history=>history.parent_history_id===values[3]).slice(-1):histories.filter(history=>history.history_id===values[3]);
    }else throw Error('Unexpected manual SQL: '+sql);
    return {rows,rowCount:rows.length};
  });
  const tx={client:{query},account:{account_id:accountId},now:new Date('2026-10-09T00:00:00Z')} as unknown as Transaction;
  const actor:Actor={accountId,sessionId:randomUUID(),tabId:randomUUID(),ownerCapability:null};
  const extension=manualCommands(()=>true,65536,128,{fontCatalogVersion:'pinned-catalog-v1'});
  const run=async(operation:WorkspaceCommand['operation'])=>{
    const command:WorkspaceCommand={commandId:randomUUID(),intentVersion:1,target:{contextId,contextGeneration:'1',tabId:actor.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:context.workspace_revision},operation};
    assertWire('workspaceCommand',command);
    return extension(tx,actor,context,command);
  };
  const current=()=>structuredClone(results.get(page.current_result_id!)!);
  return {original:structuredClone(original),page,cursor,results,histories,work,query,run,current};
}
describe('manual direction history using offline bookkeeping',()=>{
  it.each([false,true])('retains confirmed text and cleanup through direction Undo/Redo for legacy=%s',async legacy=>{
    const f=manualFixture(legacy),before=f.current(),regionId=before.edit_data.blocks[0].regionId;
    await f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId,expectedResultRevision:'0',patch:{orientation:'HORIZONTAL'}}});
    const after=f.current(),expected=structuredClone(before.edit_data);
    expected.blocks[0].geometry.orientation='HORIZONTAL';
    expected.renderSpecification??={version:1,fontCatalogVersion:'pinned-catalog-v1',blocks:expected.blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT'}))};
    expected.renderSpecification.blocks[0].rendererVersion='pango-overflow-v2';
    expect(after.edit_data).toEqual(expected);
    expect(after.original_asset_id).toBe(before.original_asset_id);
    expect(after.cleaned_asset_id).toBe(before.cleaned_asset_id);
    expect(f.histories).toHaveLength(1);
    const id=f.cursor.cursor_history_id;
    await f.run({kind:'UNDO',payload:{pageId:f.page.page_lineage_id,expectedHistoryRevision:f.cursor.revision,cursorId:id}});
    const restored=f.current();
    expect(restored.edit_data.blocks).toEqual(before.edit_data.blocks);
    expect(restored.cleaned_asset_id).toBe(before.cleaned_asset_id);
    expect(restored.edit_data.renderSpecification!.blocks[0].rendererVersion).toBeUndefined();
    await f.run({kind:'REDO',payload:{pageId:f.page.page_lineage_id,expectedHistoryRevision:f.cursor.revision,cursorId:f.cursor.cursor_history_id}});
    expect(f.current().edit_data).toEqual(expected);
    expect(f.current().cleaned_asset_id).toBe(before.cleaned_asset_id);
    expect(f.results.get(before.result_id)).toEqual(before);
    expect(f.work).toHaveLength(3);
    expect(f.work.map(item=>item.kind)).toEqual(['STORE','STORE','STORE']);
    expect(f.histories).toHaveLength(1);
  });
});

describe('manual typeset area history using offline bookkeeping',()=>{
  it.each([false,true])('sets and clears only the render box through Undo/Redo for legacy=%s',async legacy=>{
    const f=manualFixture(legacy),before=f.current(),regionId=before.edit_data.blocks[0].regionId,box={left:0,top:0,width:200,height:200};
    const edit=async(typesetBox:typeof box|null)=>f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId,expectedResultRevision:f.page.result_revision,patch:{typesetBox}}});
    const history=async(kind:'UNDO'|'REDO')=>f.run({kind,payload:{pageId:f.page.page_lineage_id,expectedHistoryRevision:f.cursor.revision,cursorId:f.cursor.cursor_history_id}});
    await edit(box);const boxed=f.current();
    expect(boxed.edit_data.blocks).toEqual(before.edit_data.blocks);expect(boxed.edit_data.renderSpecification!.blocks[0]).toMatchObject({typesetBox:box,rendererVersion:'pango-overflow-v2',sizing:'AUTO_FIT',minimumFontSizePx:legacy?1:12});expect(boxed.cleaned_asset_id).toBe(before.cleaned_asset_id);expect(boxed.original_asset_id).toBe(before.original_asset_id);
    await edit(null);const cleared=f.current();expect(cleared.edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('typesetBox');expect(cleared.edit_data.blocks).toEqual(before.edit_data.blocks);
    await history('UNDO');expect(f.current().edit_data).toEqual(boxed.edit_data);await history('UNDO');expect(f.current().edit_data.blocks).toEqual(before.edit_data.blocks);expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('rendererVersion');
    await history('REDO');expect(f.current().edit_data).toEqual(boxed.edit_data);await history('REDO');expect(f.current().edit_data).toEqual(cleared.edit_data);
    expect(f.results.get(before.result_id)).toEqual(before);expect(f.work).toHaveLength(6);expect(f.work.every(item=>item.kind==='STORE')).toBe(true);
    expect(f.histories[0].protected_delta).toMatchObject({before:before.edit_data.blocks[0],after:before.edit_data.blocks[0],afterRender:{block:{typesetBox:box,rendererVersion:'pango-overflow-v2'}}});
  });
  it.each([false,true])('keeps the renderer when clearing an absent box for legacy=%s',async legacy=>{
    const f=manualFixture(legacy),before=f.current();
    await f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId:before.edit_data.blocks[0].regionId,expectedResultRevision:'0',patch:{typesetBox:null}}});
    expect(f.current().edit_data.blocks).toEqual(before.edit_data.blocks);expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('rendererVersion');expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('typesetBox');
  });
  it('rejects invalid boxes before result/history/store publication',async()=>{
    const f=manualFixture(false),before=f.current();
    for(const typesetBox of [{left:399,top:0,width:2,height:20},{left:0,top:399,width:20,height:2},{left:400,top:0,width:Number.MIN_VALUE,height:20}])await expect(f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId:before.edit_data.blocks[0].regionId,expectedResultRevision:'0',patch:{typesetBox}}})).rejects.toMatchObject({code:'INPUT_INVALID'});
    expect(f.current()).toEqual(before);expect(f.results.size).toBe(1);expect(f.histories).toHaveLength(0);expect(f.work).toHaveLength(0);
  });
});


describe('manual target direction using existing history bookkeeping',()=>{
  it.each([false,true])('sets and clears output direction with source and cleanup intact for legacy=%s',async legacy=>{
    const f=manualFixture(legacy),before=f.current(),regionId=before.edit_data.blocks[0].regionId;
    const edit=async(targetOrientation:'HORIZONTAL'|'VERTICAL'|null)=>f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId,expectedResultRevision:f.page.result_revision,patch:{targetOrientation}}});
    const history=async(kind:'UNDO'|'REDO')=>f.run({kind,payload:{pageId:f.page.page_lineage_id,expectedHistoryRevision:f.cursor.revision,cursorId:f.cursor.cursor_history_id}});
    await edit('HORIZONTAL');const horizontal=f.current();expect(horizontal.edit_data.blocks).toEqual(before.edit_data.blocks);expect(horizontal.edit_data.renderSpecification!.blocks[0]).toMatchObject({targetOrientation:'HORIZONTAL',rendererVersion:'pango-overflow-v2',sizing:'AUTO_FIT'});expect(horizontal.cleaned_asset_id).toBe(before.cleaned_asset_id);expect(horizontal.original_asset_id).toBe(before.original_asset_id);
    await edit(null);const cleared=f.current();expect(cleared.edit_data.blocks).toEqual(before.edit_data.blocks);expect(cleared.edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');
    await history('UNDO');expect(f.current().edit_data).toEqual(horizontal.edit_data);await history('UNDO');expect(f.current().edit_data.blocks).toEqual(before.edit_data.blocks);expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('rendererVersion');
    await history('REDO');expect(f.current().edit_data).toEqual(horizontal.edit_data);await history('REDO');expect(f.current().edit_data).toEqual(cleared.edit_data);
    expect(f.histories[0].protected_delta).toMatchObject({before:before.edit_data.blocks[0],after:before.edit_data.blocks[0],afterRender:{block:{targetOrientation:'HORIZONTAL'}}});expect(f.results.get(before.result_id)).toEqual(before);expect(f.work.every(item=>item.kind==='STORE')).toBe(true);
  });
  it('stores an explicit direction equal to source and combines it with box and legacy orientation',async()=>{
    const f=manualFixture(false),before=f.current(),regionId=before.edit_data.blocks[0].regionId,box={left:0,top:0,width:200,height:100};
    await f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId,expectedResultRevision:f.page.result_revision,patch:{targetOrientation:'VERTICAL'}}});expect(f.current().edit_data.renderSpecification!.blocks[0]).toHaveProperty('targetOrientation','VERTICAL');expect(f.current().edit_data.blocks).toEqual(before.edit_data.blocks);
    await f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId,expectedResultRevision:f.page.result_revision,patch:{orientation:'HORIZONTAL',targetOrientation:'VERTICAL',typesetBox:box}}});const after=f.current();expect(after.edit_data.blocks[0].geometry.orientation).toBe('HORIZONTAL');expect(after.edit_data.renderSpecification!.blocks[0]).toMatchObject({targetOrientation:'VERTICAL',typesetBox:box});expect(after.edit_data.blocks[0].sourceText).toEqual(before.edit_data.blocks[0].sourceText);expect(after.edit_data.blocks[0].translatedText).toEqual(before.edit_data.blocks[0].translatedText);expect(after.edit_data.blocks[1]).toEqual(before.edit_data.blocks[1]);
  });
  it.each([false,true])('leaves the legacy renderer on an absent clear for legacy=%s',async legacy=>{
    const f=manualFixture(legacy),before=f.current();await f.run({kind:'MANUAL_EDIT',payload:{pageId:f.page.page_lineage_id,regionId:before.edit_data.blocks[0].regionId,expectedResultRevision:'0',patch:{targetOrientation:null}}});expect(f.current().edit_data.blocks).toEqual(before.edit_data.blocks);expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');expect(f.current().edit_data.renderSpecification!.blocks[0]).not.toHaveProperty('rendererVersion');
  });
});
