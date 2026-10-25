import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {manualPageMatches} from '../../apps/web/src/App.js';
import type {Block,PageView,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';

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
  const command:WorkspaceCommand={commandId:randomUUID(),intentVersion:1,target:{contextId:randomUUID(),contextGeneration:'1',tabId:randomUUID(),expectedOwnerRevision:'0',expectedWorkspaceRevision:'0'},operation:{kind:'MANUAL_EDIT',payload:{pageId:before.pageLineageId,regionId:value[0].regionId,expectedResultRevision:'0',patch:{typesetBox:{left:0,top:0,width:80,height:180}}}}};
  const capture:Parameters<typeof manualPageMatches>[0]={before,draft:{pageId:before.pageLineageId,regionId:value[0].regionId,revision:'0',sourceText:value[0].sourceText.value,translatedText:value[0].translatedText.value,fontAssetId:value[0].fontAssetId,fontSizePx:24,orientation:'VERTICAL',typesetBox:{left:0,top:0,width:80,height:180},editedFields:['typesetBox']},pending:{path:'/api/commands',body:command,preauth:false}};
  const next=structuredClone(before);
  next.resultRevision='1';

  next.renderSpecification??={version:1,fontCatalogVersion:'pinned-catalog-v1',blocks:value.map(block=>({regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT'}))};
  next.renderSpecification.blocks[0].rendererVersion='pango-overflow-v2';
  next.renderSpecification.blocks[0].typesetBox={left:0,top:0,width:80,height:180};
  return {before,capture,next,command};
}

describe('manual typeset area result reconciliation without IO',()=>{
  it.each([false,true])('accepts exact box-only save legacy=%s and preserves source data',legacy=>{const f=pageFixture(legacy);expect(f.next.blocks).toEqual(f.before.blocks);expect(manualPageMatches(f.capture,f.next)).toBe(true);});
  it.each(['MISSING','SHIFTED','SOURCE','CLEANUP','SIBLING','RENDERER'] as const)('keeps draft for mismatched %s read',kind=>{const f=pageFixture();if(kind==='MISSING')delete f.next.renderSpecification!.blocks[0].typesetBox;if(kind==='SHIFTED')f.next.renderSpecification!.blocks[0].typesetBox!.left++;if(kind==='SOURCE')f.next.blocks[0].geometry.polygon[0].x++;if(kind==='CLEANUP')f.next.cleanedAssetId=randomUUID();if(kind==='SIBLING')f.next.renderSpecification!.blocks[1].typesetBox={left:1,top:1,width:20,height:20};if(kind==='RENDERER')delete f.next.renderSpecification!.blocks[0].rendererVersion;expect(manualPageMatches(f.capture,f.next)).toBe(false);});
  it('requires removal of the optional field for explicit clear',()=>{const f=pageFixture();f.before.renderSpecification!.blocks[0]={...f.next.renderSpecification!.blocks[0]};if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={typesetBox:null};f.capture.draft.typesetBox=null;delete f.next.renderSpecification!.blocks[0].typesetBox;expect(manualPageMatches(f.capture,f.next)).toBe(true);f.next.renderSpecification!.blocks[0].typesetBox={left:0,top:0,width:80,height:180};expect(manualPageMatches(f.capture,f.next)).toBe(false);});
  it.each([false,true])('does not invent renderer migration for absent box clear legacy=%s',legacy=>{const f=pageFixture(legacy);if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={typesetBox:null};f.capture.draft.typesetBox=null;delete f.next.renderSpecification!.blocks[0].typesetBox;delete f.next.renderSpecification!.blocks[0].rendererVersion;expect(manualPageMatches(f.capture,f.next)).toBe(true);});
});


function targetFixture(legacy=false){
  const f=pageFixture(legacy);if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={targetOrientation:'HORIZONTAL'};f.capture.draft.targetOrientation='HORIZONTAL';f.capture.draft.editedFields=['targetOrientation'];delete f.next.renderSpecification!.blocks[0].typesetBox;f.next.renderSpecification!.blocks[0].targetOrientation='HORIZONTAL';return f;
}
describe('manual target direction result reconciliation without IO',()=>{
  it.each([false,true])('accepts exact target-only save legacy=%s with unchanged source geometry and confirmed values',legacy=>{const f=targetFixture(legacy),saved=structuredClone(f.capture);expect(f.next.blocks).toEqual(f.before.blocks);expect(manualPageMatches(f.capture,f.next)).toBe(true);expect(f.capture).toEqual(saved);});
  it.each(['MISSING','DIRECTION','SOURCE','CLEANUP','SIBLING','RENDERER','SPECIFICATION','STALE'] as const)('keeps original draft after an ACK when %s differs',kind=>{
    const f=targetFixture();if(kind==='MISSING')delete f.next.renderSpecification!.blocks[0].targetOrientation;if(kind==='DIRECTION')f.next.renderSpecification!.blocks[0].targetOrientation='VERTICAL';if(kind==='SOURCE')f.next.blocks[0].geometry.orientation='HORIZONTAL';if(kind==='CLEANUP')f.next.cleanedAssetId=randomUUID();if(kind==='SIBLING')f.next.renderSpecification!.blocks[1].targetOrientation='HORIZONTAL';if(kind==='RENDERER')delete f.next.renderSpecification!.blocks[0].rendererVersion;if(kind==='SPECIFICATION')delete f.next.renderSpecification;if(kind==='STALE')f.next.resultRevision='0';expect(manualPageMatches(f.capture,f.next)).toBe(false);
  });
  it('requires field deletion for clear and never merges an explicit source-equal direction into absence',()=>{
    const f=targetFixture();f.before.renderSpecification!.blocks[0]={...f.next.renderSpecification!.blocks[0]};if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={targetOrientation:null};f.capture.draft.targetOrientation=null;delete f.next.renderSpecification!.blocks[0].targetOrientation;expect(manualPageMatches(f.capture,f.next)).toBe(true);f.next.renderSpecification!.blocks[0].targetOrientation='VERTICAL';expect(manualPageMatches(f.capture,f.next)).toBe(false);f.command.operation.payload.patch={targetOrientation:'VERTICAL'};f.capture.draft.targetOrientation='VERTICAL';expect(manualPageMatches(f.capture,f.next)).toBe(true);delete f.next.renderSpecification!.blocks[0].targetOrientation;expect(manualPageMatches(f.capture,f.next)).toBe(false);
  });
  it.each([false,true])('keeps absent clear without renderer migration legacy=%s',legacy=>{
    const f=targetFixture(legacy);if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={targetOrientation:null};f.capture.draft.targetOrientation=null;delete f.next.renderSpecification!.blocks[0].targetOrientation;delete f.next.renderSpecification!.blocks[0].rendererVersion;expect(manualPageMatches(f.capture,f.next)).toBe(true);
  });
  it('reconciles target and box together independently of a legacy source orientation edit',()=>{
    const f=targetFixture(true),box={left:0,top:0,width:80,height:180};if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={orientation:'HORIZONTAL',targetOrientation:'VERTICAL',typesetBox:box};f.next.blocks[0].geometry.orientation='HORIZONTAL';f.next.renderSpecification!.blocks[0].targetOrientation='VERTICAL';f.next.renderSpecification!.blocks[0].typesetBox=box;expect(manualPageMatches(f.capture,f.next)).toBe(true);
  });
});


it('accepts a text-only manual save with the captured automatic balloon policy intact',()=>{
  const f=pageFixture();f.before.renderSpecification!.blocks[0].rendererVersion='pango-balloon-v3';f.next.renderSpecification!.blocks[0].rendererVersion='pango-balloon-v3';delete f.next.renderSpecification!.blocks[0].typesetBox;
  if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={translatedText:'수정한 한국어 대사'};f.capture.draft.translatedText='수정한 한국어 대사';f.capture.draft.editedFields=['translatedText'];f.next.blocks[0].translatedText={value:'수정한 한국어 대사',status:'USER_MODIFIED'};
  expect(manualPageMatches(f.capture,f.next)).toBe(true);f.next.renderSpecification!.blocks[0].rendererVersion='pango-overflow-v2';expect(manualPageMatches(f.capture,f.next)).toBe(false);
});
it('accepts explicit return to source area only when the automatic policy is removed',()=>{
  const f=pageFixture();f.before.renderSpecification!.blocks[0].rendererVersion='pango-balloon-v3';delete f.next.renderSpecification!.blocks[0].typesetBox;
  if(f.command.operation.kind!=='MANUAL_EDIT')throw Error('fixture');f.command.operation.payload.patch={typesetBox:null};f.capture.draft.typesetBox=null;
  expect(manualPageMatches(f.capture,f.next)).toBe(true);f.next.renderSpecification!.blocks[0].rendererVersion='pango-balloon-v3';expect(manualPageMatches(f.capture,f.next)).toBe(false);
});
