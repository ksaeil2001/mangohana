import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mergeScopedData,painted,selectedCleanupRegions,validateEditData} from '../../packages/domain/src/scope.js';
import type {Block} from '../../packages/contracts/src/wire.generated.js';
import type {EditData} from '../../packages/domain/src/model.js';
const block=(left:number,order:number):Block=>({regionId:randomUUID(),geometry:{polygon:[{x:left,y:10},{x:left+20,y:10},{x:left+20,y:30},{x:left,y:30}],readingOrder:order,orientation:'HORIZONTAL',angleDegrees:0},sourceText:{value:'원문',status:'USER_CONFIRMED'},translatedText:{value:'내 초안',status:'USER_MODIFIED'},fontAssetId:randomUUID(),fontSizePx:20,appliedTranslation:null});
const fixture=()=>{const blocks=[block(10,0),block(60,1)];return {blocks,geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',renderSpecification:{version:1,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:blocks.map(item=>({regionId:item.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT'}))}} as EditData;};
describe('captured partial-processing scope',()=>{
  it('distinguishes whole block overlap from center inclusion, including a stroke segment crossing the polygon',()=>{const b=block(10,0);const touch=[{radiusPx:1,points:[{x:9,y:11}]}];expect(painted(b,touch,'ANY_OVERLAP')).toBe(true);expect(painted(b,touch,'CENTER')).toBe(false);expect(painted(b,[{radiusPx:1,points:[{x:0,y:20},{x:40,y:20}]}],'ANY_OVERLAP')).toBe(true);expect(painted(b,[{radiusPx:1,points:[{x:0,y:0}]}],'ANY_OVERLAP')).toBe(false);});
  it('preserves unselected user values, geometry, provenance and captured render settings even when a provider modifies them',()=>{const initial=fixture();const proposed=structuredClone(initial);for(const b of proposed.blocks){b.translatedText={value:'AI가 제안한 새 번역',status:'AI_PROPOSED'};b.geometry.angleDegrees=30;}proposed.renderSpecification!.blocks[1].minimumFontSizePx=8;const result=mergeScopedData(initial,proposed,{kind:'REGIONS',regionIds:[initial.blocks[0].regionId]});expect(result.blocks[0]).toEqual(proposed.blocks[0]);expect(result.blocks[1]).toEqual(initial.blocks[1]);expect(result.renderSpecification!.blocks[1]).toEqual(initial.renderSpecification!.blocks[1]);expect(initial.blocks[0].translatedText.status).toBe('USER_MODIFIED');});
  it('refuses undecided paint policy, missing selected blocks, unexpected regions and degenerate or out-of-bounds geometry',()=>{const initial=fixture();const strokes=[{radiusPx:5,points:[{x:20,y:20}]}];expect(()=>mergeScopedData(initial,initial,{kind:'PAINTED',selectionId:randomUUID()},strokes)).toThrow('POLICY_DECISION_REQUIRED');const missing=structuredClone(initial);missing.blocks=[];expect(()=>mergeScopedData(initial,missing,{kind:'REGIONS',regionIds:[initial.blocks[0].regionId]})).toThrow('PROPOSAL_INVALID');const outside=structuredClone(initial);outside.blocks.push(block(90,2));expect(()=>mergeScopedData(initial,outside,{kind:'PAINTED',selectionId:randomUUID()},strokes,'ANY_OVERLAP')).toThrow('PROPOSAL_INVALID');validateEditData(initial,100,100);const invalid=structuredClone(initial);invalid.blocks[0].geometry.polygon[1].x=110;expect(()=>validateEditData(invalid,100,100)).toThrow('PROPOSAL_INVALID');invalid.blocks[0].geometry.polygon=[{x:10,y:10},{x:10,y:10},{x:10,y:10}];expect(()=>validateEditData(invalid,100,100)).toThrow('PROPOSAL_INVALID');});
});

describe('captured manual typeset area validation',()=>{
  it('allows zero origin and fractional boxes without expanding source selection or cleanup',()=>{
    const data=fixture(),before=structuredClone(data),spec=data.renderSpecification!.blocks[0];
    spec.rendererVersion='pango-overflow-v2';spec.typesetBox={left:0,top:0,width:100,height:100};validateEditData(data,100,100);
    expect(selectedCleanupRegions(data,{kind:'PAINTED',selectionId:randomUUID()},[{radiusPx:1,points:[{x:50,y:50}]}],'ANY_OVERLAP')).toEqual([]);
    expect(data.blocks).toEqual(before.blocks);spec.typesetBox={left:0.25,top:0.5,width:99.75,height:99.5};validateEditData(data,100,100);
  });
  it('rejects page overflow, rounded-away positive sizes and legacy renderer boxes',()=>{
    const data=fixture(),spec=data.renderSpecification!.blocks[0];spec.rendererVersion='pango-overflow-v2';
    for(const box of [{left:99.75,top:0,width:0.5,height:20},{left:0,top:99.75,width:20,height:0.5},{left:100,top:0,width:Number.MIN_VALUE,height:20}]){spec.typesetBox=box;expect(()=>validateEditData(data,100,100)).toThrow('PROPOSAL_INVALID');}
    spec.typesetBox={left:0,top:0,width:100,height:100};spec.rendererVersion='pango-canonical-v1';expect(()=>validateEditData(data,100,100)).toThrow('PROPOSAL_INVALID');
    delete spec.rendererVersion;expect(()=>validateEditData(data,100,100)).toThrow('PROPOSAL_INVALID');delete spec.typesetBox;expect(()=>validateEditData(data,100,100)).not.toThrow();
  });
});


it('requires an explicit v2 target direction without changing cleanup scope or source geometry',()=>{
  const data=fixture(),before=structuredClone(data),spec=data.renderSpecification!.blocks[0];data.blocks[0].geometry.orientation='VERTICAL';const source=structuredClone(data.blocks);
  spec.targetOrientation='HORIZONTAL';expect(()=>validateEditData(data,100,100)).toThrow('PROPOSAL_INVALID');spec.rendererVersion='pango-canonical-v1';expect(()=>validateEditData(data,100,100)).toThrow('PROPOSAL_INVALID');spec.rendererVersion='pango-overflow-v2';validateEditData(data,100,100);
  expect(data.blocks).toEqual(source);expect(selectedCleanupRegions(data,{kind:'PAINTED',selectionId:randomUUID()},[{radiusPx:1,points:[{x:50,y:50}]}],'ANY_OVERLAP')).toEqual([]);
  const proposed=structuredClone(data);proposed.renderSpecification!.blocks[0].targetOrientation='VERTICAL';const merged=mergeScopedData(data,proposed,{kind:'REGIONS',regionIds:[data.blocks[1].regionId]});expect(merged.renderSpecification!.blocks[0]).toEqual(spec);expect(merged.blocks[0]).toEqual(source[0]);expect(before.renderSpecification!.blocks[0]).not.toHaveProperty('targetOrientation');
});
