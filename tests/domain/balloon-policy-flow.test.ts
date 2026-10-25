import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import type {Block, Settings, WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import type {ProjectManifest} from '../../packages/contracts/src/manifest.generated.js';
import {assertManifest, assertWire} from '../../packages/contracts/src/validation.js';
import {balloonRendererVersion, overflowRendererVersion, proposalRendererVersion, manualRendererVersion,
  pageRendererVersion, isOverflowRenderer, type RendererVersion} from '../../packages/media/src/render-policy.js';
import {normalizeObservation, type Observation, type StageInput} from '../../packages/domain/src/provider.js';
import {validateEditData} from '../../packages/domain/src/scope.js';
import {manualCommands} from '../../packages/domain/src/manual.js';
import type {Actor, ContextRow, EditData, PageRow, ResultRow} from '../../packages/domain/src/model.js';
import type {Transaction} from '../../packages/storage/src/database.js';
import {applyScopedProposal, type MaterialPlan} from '../../packages/providers/src/gemini-material.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {canonicalInput} from '../../packages/domain/src/provider.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';

// Only policy functions, JSON schemas and in-memory SQL bookkeeping are exercised.
// Image calls and any runtime database import must fail. The real pure proposal
// producer is imported below, but every image operation remains guarded.
const nativeImageGuard=vi.hoisted(()=>vi.fn(()=>{throw new Error('PURE_BALLOON_POLICY_FORBIDS_SHARP_CALL');}));
vi.mock('sharp', () => ({default:nativeImageGuard}));
vi.mock('pg', () => {throw new Error('PURE_BALLOON_POLICY_FORBIDS_PG');});

function fixture(stage = 'TRANSLATE', version: RendererVersion | undefined = balloonRendererVersion, empty = false): StageInput {
  const executionId=randomUUID(), requestId=randomUUID(), contextId=randomUUID(), fontAssetId=randomUUID();
  const originalAssetId=randomUUID(), inputDigest='b'.repeat(64);
  const settings: Settings={settingsVersion:'1', contractVersion:'synthetic-v1', sourceLanguage:'ja',
    targetLanguage:'ko', modelId:'synthetic-policy-test', reasoningLevel:'LOW', fontAssetId,
    baseFontSizePx:20, minFontSizePx:10};
  const data: EditData={geometryContract:'source-pixels-v1', renderContract:'pango-canonical-v1',
    cleanupQa:'NEEDS_REVIEW', blocks:empty?[]:[0,1,2].map(index=>({
      regionId:randomUUID(), geometry:{polygon:[{x:10,y:10+index*26},{x:90,y:10+index*26},
        {x:90,y:30+index*26},{x:10,y:30+index*26}], angleDegrees:0, readingOrder:index, orientation:'HORIZONTAL'},
      sourceText:{value:`原文${index}`, status:index===0?'USER_CONFIRMED':index===1?'USER_MODIFIED':'AI_PROPOSED'},
      translatedText:{value:`이전 번역${index}`, status:index===0?'USER_CONFIRMED':index===1?'USER_MODIFIED':'AI_PROPOSED'},
      fontAssetId, fontSizePx:20, appliedTranslation:{sourceLanguage:'ja', targetLanguage:'ko',
        modelId:'synthetic-policy-test', reasoningLevel:'LOW', modelContract:'synthetic-v1',
        promptContract:'captured-user-reviewed-v1', originExecutionId:randomUUID()},
    })), renderSpecification:{version:1, fontCatalogVersion:'pinned-catalog-v1', blocks:[]}};
  data.renderSpecification!.blocks=data.blocks.map(block=>({regionId:block.regionId,
    minimumFontSizePx:10, sizing:'AUTO_FIT', ...(version===undefined?{}:{rendererVersion:version})}));
  return {executionId, requestId, contextId, accountId:randomUUID(), stage, inputDigest, settings,
    scope:{kind:'PAGE'}, originalAssetId, initialData:data, previousData:null, width:100, height:100,
    envelope:{executionId, requestId, contextId, contextGeneration:'1', pageLineageId:randomUUID(),
      logicalStepId:stage, stageContract:settings.contractVersion, inputDigest, capturedSettings:settings,
      assetIds:[originalAssetId], regionIds:data.blocks.map(block=>block.regionId), checkpointDependencies:[],
      costBoundUsd:null, parameterProfileVersion:'synthetic-policy-test-v1'}};
}
function raw(input: StageInput, data = structuredClone(input.previousData??input.initialData)): Observation {
  return {evidenceId:randomUUID(), outcome:'SUCCESS', started:true, costUsd:null, usageConfirmed:false,
    finishReason:'OWNED_FAKE_SUCCESS', providerRef:null, data};
}
function newBlock(input: StageInput): Block {
  return {regionId:randomUUID(), geometry:{polygon:[{x:15,y:20},{x:85,y:20},{x:85,y:40},{x:15,y:40}],
    angleDegrees:0, readingOrder:0, orientation:'HORIZONTAL'}, sourceText:{value:'新しい原文',status:'AI_PROPOSED'},
    translatedText:{value:'',status:'AI_PROPOSED'}, fontAssetId:input.settings.fontAssetId,
    fontSizePx:input.settings.baseFontSizePx, appliedTranslation:null};
}
function freshOcrProposal(input: StageInput): Observation {
  const data=structuredClone(input.previousData??input.initialData), block=newBlock(input);
  data.blocks=[block];
  data.renderSpecification={version:1,fontCatalogVersion:'pinned-catalog-v1',blocks:[{
    regionId:block.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:balloonRendererVersion,
  }]};
  return raw(input,data);
}

describe('captured automatic balloon policy without image execution',()=>{
  it('keeps new empty PAGE OCR on v2 with user layout fields absent and costs unconfirmed',()=>{
    const input=fixture('OCR',undefined,true), proposal=freshOcrProposal(input);
    proposal.data!.renderSpecification!.blocks[0].rendererVersion=overflowRendererVersion;
    const beforeInput=structuredClone(input), beforeRaw=structuredClone(proposal);
    const normalized=normalizeObservation(input,proposal);
    expect(normalized.data).toEqual(proposal.data);
    expect(normalized.data!.renderSpecification!.blocks[0]).toMatchObject({rendererVersion:overflowRendererVersion});
    expect(normalized.data!.renderSpecification!.blocks[0]).not.toHaveProperty('typesetBox');
    expect(normalized.data!.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');
    expect(normalized.stageOutput).toMatchObject({usageState:'UNCONFIRMED',actualCostUsd:null});
    expect(normalized.costUsd).toBeNull();
    expect(normalizeObservation(input,normalized)).toEqual(normalized);
    expect(input).toEqual(beforeInput);expect(proposal).toEqual(beforeRaw);
  });
  it.each(['OCR','TRANSLATE','CLEANUP','TYPESET'])('rejects an unrequested v2-to-v3 upgrade in existing %s data',stage=>{
    const input=fixture(stage,overflowRendererVersion), proposal=raw(input), before=structuredClone(proposal);
    proposal.data!.renderSpecification!.blocks[1].rendererVersion=balloonRendererVersion;
    const changed=structuredClone(proposal);
    expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');
    expect(proposal).toEqual(changed);
    expect(input.initialData.renderSpecification!.blocks[1]).toEqual(before.data!.renderSpecification!.blocks[1]);
  });
  it.each(['TRANSLATE','CLEANUP','TYPESET'])('does not use an empty PAGE as permission for v3 in %s',stage=>{
    const input=fixture(stage,undefined,true), proposal=freshOcrProposal(input);
    expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');
  });
  it('does not introduce v3 for new painted OCR regions',()=>{
    const input=fixture('OCR',undefined,true);input.scope={kind:'PAINTED',selectionId:randomUUID()};
    input.paintInclusion='ANY_OVERLAP';input.paintStrokes=[{radiusPx:10,points:[{x:50,y:30}]}];
    const proposal=freshOcrProposal(input);
    expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');
  });
  it('uses previous-stage captured v2 for upgrade rejection even when the initial PAGE was empty',()=>{
    const input=fixture('OCR',undefined,true);input.previousData=fixture('OCR',overflowRendererVersion).initialData;
    expect(()=>normalizeObservation(input,freshOcrProposal(input))).toThrow('STAGE_PROPOSAL_INVALID');
  });
  it.each(['PAGE','REGIONS','PAINTED'] as const)('preserves captured v3, manual layout and confirmed text in %s scope',kind=>{
    const input=fixture(), spec=input.initialData.renderSpecification!.blocks[1];
    spec.typesetBox={left:5,top:35,width:90,height:24};spec.targetOrientation='HORIZONTAL';
    if(kind==='REGIONS')input.scope={kind,regionIds:[input.initialData.blocks[0].regionId,input.initialData.blocks[1].regionId]};
    if(kind==='PAINTED'){
      input.scope={kind,selectionId:randomUUID()};input.paintInclusion='ANY_OVERLAP';
      input.paintStrokes=[{radiusPx:1,points:[{x:40,y:20},{x:40,y:46}]}];
    }
    if(kind!=='PAGE')input.envelope!.regionIds=input.initialData.blocks.slice(0,2).map(block=>block.regionId);
    const proposal=raw(input);
    proposal.data!.blocks[0].sourceText={value:'provider source replacement',status:'AI_PROPOSED'};
    proposal.data!.blocks[0].translatedText={value:'provider translation replacement',status:'AI_PROPOSED'};
    proposal.data!.blocks[0].appliedTranslation=null;
    proposal.data!.renderSpecification!.blocks[1].typesetBox={left:20,top:30,width:70,height:30};
    proposal.data!.renderSpecification!.blocks[1].targetOrientation='VERTICAL';
    for(const block of proposal.data!.renderSpecification!.blocks)block.rendererVersion=overflowRendererVersion;
    const captured=structuredClone(input), beforeRaw=structuredClone(proposal);
    const normalized=normalizeObservation(input,proposal);
    expect(normalized.data!.blocks[0]).toEqual(input.initialData.blocks[0]);
    expect(normalized.data!.blocks[1].sourceText).toEqual(input.initialData.blocks[1].sourceText);
    expect(normalized.data!.blocks[1].translatedText).toEqual(input.initialData.blocks[1].translatedText);
    expect(normalized.data!.renderSpecification!.blocks[1]).toEqual(spec);
    expect(normalized.data!.renderSpecification!.blocks.every(block=>block.rendererVersion===balloonRendererVersion)).toBe(true);
    if(kind!=='PAGE')expect(normalized.data!.blocks[2]).toEqual(input.initialData.blocks[2]);
    expect(normalizeObservation(input,normalized)).toEqual(normalized);
    expect(normalized.stageOutput).toMatchObject({usageState:'UNCONFIRMED',actualCostUsd:null});
    expect(proposal).toEqual(beforeRaw);expect(input).toEqual(captured);
  });
  it('retains strict TYPESET equality for captured v3 instead of allowing new layout or policy changes',()=>{
    const input=fixture('TYPESET'), proposal=raw(input), captured=structuredClone(input.initialData);
    expect(normalizeObservation(input,proposal).data).toEqual(captured);
    proposal.data!.renderSpecification!.blocks[0].rendererVersion=overflowRendererVersion;
    expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');
    proposal.data=structuredClone(captured);proposal.data.blocks[1].translatedText={value:'different raster text',status:'AI_PROPOSED'};
    expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');
    expect(input.initialData).toEqual(captured);
  });
  it('keeps captured and legacy policy choices explicit in the shared policy helpers',()=>{
    expect(isOverflowRenderer(balloonRendererVersion)).toBe(true);expect(isOverflowRenderer('unknown')).toBe(false);
    expect(proposalRendererVersion('pango-canonical-v1')).toBe(overflowRendererVersion);
    expect(proposalRendererVersion(balloonRendererVersion)).toBe(balloonRendererVersion);
    expect(proposalRendererVersion(overflowRendererVersion)).toBe(overflowRendererVersion);
    expect(proposalRendererVersion(undefined)).toBe(overflowRendererVersion);
    expect(manualRendererVersion(balloonRendererVersion)).toBe(balloonRendererVersion);
    expect(manualRendererVersion(balloonRendererVersion,true)).toBe(overflowRendererVersion);
    expect(pageRendererVersion([undefined,balloonRendererVersion])).toBe('pango-mixed-v3');
    expect(pageRendererVersion([undefined,overflowRendererVersion])).toBe('pango-mixed-v2');
    expect(pageRendererVersion([undefined,'pango-canonical-v1'])).toBe('pango-canonical-v1');
  });
});

function manifest(input: StageInput): ProjectManifest {
  return {format:'trio.manga-project',schemaVersion:1,issuer:'pure-policy-test',keyId:'synthetic-policy-key',
    algorithm:'Ed25519',exportId:randomUUID(),createdAt:'2026-10-12T00:00:00Z',creatorAccountId:input.accountId!,
    projectLineageId:randomUUID(),snapshotRevision:'0',projectStatus:'IN_PROGRESS',settings:input.settings,
    pages:[{pageLineageId:input.envelope!.pageLineageId,originalAssetId:input.originalAssetId,
      widthPx:input.width,heightPx:input.height,skip:false,resultRevision:'0',cleanedAssetId:randomUUID(),
      renderAssetId:null,blocks:structuredClone(input.initialData.blocks),paidCumulativeBaselineCredit:'0',
      baselineContributionIds:[],geometryContract:input.initialData.geometryContract,
      renderContract:input.initialData.renderContract,cleanupQa:input.initialData.cleanupQa,
      displayName:'synthetic-policy-fixture.png',paidCumulativeBaselineState:'UNCONFIRMED',
      renderSpecification:structuredClone(input.initialData.renderSpecification)}],
    assets:[],unsettledReferences:[],optionalCheckpoints:[],fonts:[]};
}
describe('stored JSON schema accepts only the known balloon renderer policy',()=>{
  it('accepts v3 in wire edit data and manifest JSON with user layout without changing the serialized capture',()=>{
    const input=fixture(), spec=input.initialData.renderSpecification!.blocks[1];
    spec.typesetBox={left:5,top:35,width:90,height:24};spec.targetOrientation='HORIZONTAL';
    const saved=manifest(input), before=structuredClone(saved), roundTrip:unknown=JSON.parse(JSON.stringify(saved));
    expect(()=>assertWire('renderSpecification',input.initialData.renderSpecification)).not.toThrow();
    expect(()=>validateEditData(input.initialData,100,100)).not.toThrow();
    expect(()=>assertManifest(roundTrip)).not.toThrow();
    expect(roundTrip).toEqual(before);expect(saved).toEqual(before);
    expect(saved.pages[0].paidCumulativeBaselineState).toBe('UNCONFIRMED');
  });
  it('rejects unknown renderer versions in wire and stored manifest instead of treating them as v3',()=>{
    const input=fixture(), saved=manifest(input);
    Object.assign(input.initialData.renderSpecification!.blocks[0],{rendererVersion:'pango-unknown-v9'});
    Object.assign(saved.pages[0].renderSpecification!.blocks[0],{rendererVersion:'pango-unknown-v9'});
    expect(()=>assertWire('renderSpecification',input.initialData.renderSpecification)).toThrow('INPUT_INVALID');
    expect(()=>validateEditData(input.initialData,100,100)).toThrow('INPUT_INVALID');
    expect(()=>assertManifest(saved)).toThrow('FILE_INVALID');
  });
});

// Reuse the existing offline manual-orientation fixture pattern. Unexpected SQL
// is a test failure; it is never delegated to a real database or rendering port.
function manualFixture(version: RendererVersion | undefined, withBox=false) {
  const input=fixture('TRANSLATE',version), accountId=input.accountId!, contextId=input.contextId!;
  if(version===undefined)for(const specification of input.initialData.renderSpecification!.blocks)delete specification.rendererVersion;
  const projectId=randomUUID();
  if(withBox)input.initialData.renderSpecification!.blocks[0].typesetBox={left:5,top:5,width:90,height:40};
  const context={account_id:accountId,context_id:contextId,project_lineage_id:projectId,workspace_revision:'0'} as ContextRow;
  const page={account_id:accountId,context_id:contextId,project_lineage_id:projectId,
    page_lineage_id:input.envelope!.pageLineageId,excluded:false,current_result_id:randomUUID(),
    result_revision:'0',revision:'0',image_width:100,image_height:100} as PageRow;
  const original: ResultRow={result_id:page.current_result_id!,account_id:accountId,context_id:contextId,
    page_lineage_id:page.page_lineage_id,result_revision:'0',original_asset_id:input.originalAssetId,
    cleaned_asset_id:randomUUID(),render_asset_id:randomUUID(),edit_data:input.initialData,origin:'AI_APPLIED'};
  const results=new Map([[original.result_id,structuredClone(original)]]), cursor={revision:'0',cursor_history_id:null as string|null};
  const histories:{id:string;delta:unknown}[]=[], work:{kind:string;resultId:string}[]=[];
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>=>{
    expect(values[0]).toBe(accountId);
    let rows:unknown[]=[];
    if(sql.startsWith('SELECT * FROM workspace_pages'))rows=[structuredClone(page)];
    else if(sql.startsWith('SELECT request_id FROM active_page_requests'))rows=[];
    else if(sql.startsWith('SELECT * FROM results'))rows=[structuredClone(results.get(String(values[3])))];
    else if(sql.startsWith('INSERT INTO history_cursors'))rows=[];
    else if(sql.startsWith('SELECT revision,cursor_history_id'))rows=[{...cursor}];
    else if(sql.startsWith('SELECT (coalesce(max(result_revision)'))rows=[{next_revision:String(results.size)}];
    else if(sql.startsWith('INSERT INTO results')){
      const previous=results.get(page.current_result_id!)!;
      const next:ResultRow={...previous,result_id:String(values[1]),result_revision:String(values[4]),
        original_asset_id:String(values[5]),cleaned_asset_id:values[6] as string|null,
        edit_data:JSON.parse(String(values[7])) as EditData,origin:'MANUAL_EDIT',render_asset_id:null};
      results.set(next.result_id,next);
    }else if(sql.startsWith('UPDATE workspace_pages')){
      page.current_result_id=String(values[3]);page.result_revision=String(values[4]);page.revision=String(BigInt(page.revision)+1n);
    }else if(sql.startsWith('INSERT INTO work_items')){
      work.push({kind:String(values[2]),resultId:JSON.parse(String(values[5])).resultId as string});
    }else if(sql.startsWith('WITH RECURSIVE branch'))rows=[];
    else if(sql.startsWith('INSERT INTO manual_history'))histories.push({id:String(values[1]),delta:JSON.parse(String(values[8])) as unknown});
    else if(sql.startsWith('UPDATE history_cursors')){
      cursor.cursor_history_id=values[3] as string|null;cursor.revision=String(BigInt(cursor.revision)+1n);
    }else if(sql.startsWith('UPDATE workspace_contexts')){
      context.workspace_revision=String(BigInt(context.workspace_revision)+1n);rows=[{workspace_revision:context.workspace_revision}];
    }else throw new Error('Unexpected pure policy manual SQL: '+sql);
    return {rows,rowCount:rows.length};
  });
  const tx={client:{query},account:{account_id:accountId},now:new Date('2026-10-12T00:00:00Z')} as unknown as Transaction;
  const actor:Actor={accountId,sessionId:randomUUID(),tabId:randomUUID(),ownerCapability:null};
  const extension=manualCommands(()=>true,65536,128,{fontCatalogVersion:'pinned-catalog-v1',manualFontBelowMinimum:'ALLOW'});
  const run=async(patch: Extract<WorkspaceCommand['operation'],{kind:'MANUAL_EDIT'}>['payload']['patch'])=>{
    const command:WorkspaceCommand={commandId:randomUUID(),intentVersion:1,
      target:{contextId,contextGeneration:'1',tabId:actor.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:context.workspace_revision},
      operation:{kind:'MANUAL_EDIT',payload:{pageId:page.page_lineage_id,regionId:original.edit_data.blocks[0].regionId,
        expectedResultRevision:page.result_revision,patch}}};
    assertWire('workspaceCommand',command);
    return extension(tx,actor,context,command);
  };
  const current=()=>structuredClone(results.get(page.current_result_id!)!);
  return {original:structuredClone(original),results,page,histories,work,query,run,current};
}
describe('manual policy changes with fake Transaction bookkeeping',()=>{
  it.each(['TEXT','ORIENTATION','FONT_SIZE','USER_BOX'] as const)('keeps captured v3 through an explicit %s edit',async kind=>{
    const f=manualFixture(balloonRendererVersion), before=f.current();
    const patch=kind==='TEXT'?{translatedText:'사용자가 직접 수정'}:kind==='ORIENTATION'?{orientation:'VERTICAL' as const}:
      kind==='FONT_SIZE'?{fontSizePx:8.5}:{typesetBox:{left:5,top:5,width:90,height:40}};
    await f.run(patch);const after=f.current(), spec=after.edit_data.renderSpecification!.blocks[0];
    expect(spec.rendererVersion).toBe(balloonRendererVersion);
    if(kind==='TEXT')expect(after.edit_data.blocks[0].translatedText).toEqual({value:'사용자가 직접 수정',status:'USER_MODIFIED'});
    if(kind==='ORIENTATION')expect(after.edit_data.blocks[0].geometry.orientation).toBe('VERTICAL');
    if(kind==='FONT_SIZE'){expect(after.edit_data.blocks[0].fontSizePx).toBe(8.5);expect(spec.sizing).toBe('EXACT');}
    if(kind==='USER_BOX')expect(spec.typesetBox).toEqual({left:5,top:5,width:90,height:40});
    expect(after.edit_data.blocks.slice(1)).toEqual(before.edit_data.blocks.slice(1));
    expect(after.original_asset_id).toBe(before.original_asset_id);expect(after.cleaned_asset_id).toBe(before.cleaned_asset_id);
    expect(f.results.get(before.result_id)).toEqual(before);expect(f.histories).toHaveLength(1);
    expect(f.work).toEqual([{kind:'STORE',resultId:after.result_id}]);
  });
  it.each([false,true])('explicitly returns v3 to source-area v2 with typesetBox:null (had box=%s)',async withBox=>{
    const f=manualFixture(balloonRendererVersion,withBox), before=f.current();
    await f.run({typesetBox:null});const after=f.current(), expected=structuredClone(before.edit_data);
    delete expected.renderSpecification!.blocks[0].typesetBox;expected.renderSpecification!.blocks[0].rendererVersion=overflowRendererVersion;
    expect(after.edit_data).toEqual(expected);expect(after.edit_data.blocks).toEqual(before.edit_data.blocks);
    expect(after.cleaned_asset_id).toBe(before.cleaned_asset_id);expect(after.original_asset_id).toBe(before.original_asset_id);
    expect(f.results.get(before.result_id)).toEqual(before);expect(f.work).toEqual([{kind:'STORE',resultId:after.result_id}]);
  });
  it.each([undefined,'pango-canonical-v1',overflowRendererVersion] as const)('does not alter old no-box render data on null reset for %s',async version=>{
    const f=manualFixture(version), before=f.current();await f.run({typesetBox:null});
    const after=f.current();expect(after.edit_data).toEqual(before.edit_data);
    expect(after.original_asset_id).toBe(before.original_asset_id);expect(after.cleaned_asset_id).toBe(before.cleaned_asset_id);
    expect(f.results.get(before.result_id)).toEqual(before);
  });
  it('clears an old user box while preserving the existing v2 manual behavior',async()=>{
    const f=manualFixture(overflowRendererVersion,true), before=f.current();await f.run({typesetBox:null});
    const expected=structuredClone(before.edit_data);delete expected.renderSpecification!.blocks[0].typesetBox;
    expect(f.current().edit_data).toEqual(expected);expect(f.results.get(before.result_id)).toEqual(before);
  });
});


it('rejects unverified automatic policy activation even on fresh empty PAGE OCR',()=>{
  const input=fixture('OCR',undefined,true),proposal=freshOcrProposal(input),before=structuredClone(proposal);
  expect(()=>normalizeObservation(input,proposal)).toThrow('STAGE_PROPOSAL_INVALID');expect(proposal).toEqual(before);
});

function proposalProducerFixture(stage:'OCR'|'TRANSLATE',version?:RendererVersion,empty=false){
  const input=fixture(stage,version,empty);input.envelope!.parameterProfileVersion=syntheticProfile.id;
  const fontBytes=Buffer.from('OWNED_FAKE_FONT_BYTES_NOT_A_FONT'),licenseBytes=Buffer.from('OWNED_FAKE_LICENSE_BYTES');
  const licenseId=randomUUID(),originalBytes=Buffer.from('OWNED_FAKE_SOURCE_NOT_PNG');
  input.assetDependencies=[{assetId:input.originalAssetId,sha256:sha256(originalBytes),bytesLength:String(originalBytes.length),mediaType:'image/png'},
    {assetId:input.settings.fontAssetId,sha256:sha256(fontBytes),bytesLength:String(fontBytes.length),mediaType:'application/octet-stream'},
    {assetId:licenseId,sha256:sha256(licenseBytes),bytesLength:String(licenseBytes.length),mediaType:'text/plain'}];
  input.envelope!.assetIds=input.assetDependencies.map(item=>item.assetId);
  const fonts={catalog:{version:'pinned-catalog-v1'},bytes:new Map([[input.settings.fontAssetId,fontBytes],[licenseId,licenseBytes]]),
    font:(id:string)=>{if(id!==input.settings.fontAssetId)throw new Error('UNEXPECTED_FAKE_FONT');return {id,licenseId};}} as unknown as FontCatalog;
  const plan:MaterialPlan={version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint:digest(canonicalInput(input)),
    scopeDigest:'a'.repeat(64),stage,selectedRegionIds:[...input.envelope!.regionIds],crops:stage==='OCR'?[{inputRegionId:null,
      requiredReadingOrder:null,origin:{x:0,y:0},width:input.width,height:input.height,pngSha256:sha256(originalBytes),maskSha256:'c'.repeat(64),allowedPolygon:null}]:[],
    texts:stage==='TRANSLATE'?input.initialData.blocks.map(block=>({regionId:block.regionId,sha256:sha256(block.sourceText.value)})):[],
    fontCatalogVersion:fonts.catalog.version,parameterProfileVersion:syntheticProfile.id,maskSampleCount:0};
  return {input,fonts,plan};
}
describe('real pure proposal producer keeps the activation boundary',()=>{
  it('produces v2 for a fresh empty PAGE OCR without decoding images or calling models',async()=>{
    const {input,fonts,plan}=proposalProducerFixture('OCR',undefined,true),before=structuredClone(input),block=newBlock(input);
    const next=await applyScopedProposal(input,{regions:[{geometry:block.geometry,sourceText:block.sourceText.value,confidence:null}]},plan,fonts,syntheticProfile);
    expect(next.renderSpecification!.blocks[0].rendererVersion).toBe(overflowRendererVersion);
    expect(next.renderSpecification!.blocks[0]).not.toHaveProperty('typesetBox');
    expect(next.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');
    expect(normalizeObservation(input,raw(input,next)).data).toEqual(next);
    expect(input).toEqual(before);expect(nativeImageGuard).not.toHaveBeenCalled();
  });
  it.each([balloonRendererVersion,overflowRendererVersion,'pango-canonical-v1'] as const)('preserves the captured policy boundary for %s translation proposals',async version=>{
    const {input,fonts,plan}=proposalProducerFixture('TRANSLATE',version);
    // Explicit retranslation retains the existing scope contract: only the requested
    // first and third regions are selected. The modified middle region is protected.
    const selected:[string,string]=[input.initialData.blocks[0].regionId,input.initialData.blocks[2].regionId];
    input.scope={kind:'REGIONS',regionIds:selected};input.envelope!.regionIds=selected;
    plan.selectedRegionIds=selected;plan.texts=plan.texts.filter(text=>selected.includes(text.regionId));
    plan.inputFingerprint=digest(canonicalInput(input));const before=structuredClone(input);
    const next=await applyScopedProposal(input,{items:input.initialData.blocks.filter(block=>plan.selectedRegionIds.includes(block.regionId)).map(block=>({inputRegionId:block.regionId,targetText:'보호 검증용 제안'}))},plan,fonts,syntheticProfile);
    for(const spec of next.renderSpecification!.blocks){
      if(selected.includes(spec.regionId))expect(spec.rendererVersion).toBe(version===balloonRendererVersion?balloonRendererVersion:overflowRendererVersion);
      else expect(spec).toEqual(input.initialData.renderSpecification!.blocks.find(prior=>prior.regionId===spec.regionId));
    }
    const normalized=normalizeObservation(input,raw(input,next));
    expect(normalized.data!.blocks[0]).toEqual(input.initialData.blocks[0]);
    expect(normalized.data!.blocks[1].translatedText).toEqual(input.initialData.blocks[1].translatedText);
    expect(normalized.costUsd).toBeNull();expect(input).toEqual(before);expect(nativeImageGuard).not.toHaveBeenCalled();
  });
});
