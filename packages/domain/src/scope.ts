import {isOverflowRenderer} from '../../media/src/render-policy.js';
import type {Block} from '../../contracts/src/wire.generated.js';
import {assertWire} from '../../contracts/src/validation.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {digest} from '../../contracts/src/intent.js';
import type {EditData,Scope} from './model.js';

type Point={x:number;y:number};
export type PaintStroke={radiusPx:number;points:Point[]};
export type PaintInclusion='ANY_OVERLAP'|'CENTER';
const distance=(point:Point,a:Point,b:Point)=>{const dx=b.x-a.x,dy=b.y-a.y;const ratio=dx===0&&dy===0?0:Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy)));return Math.hypot(point.x-a.x-ratio*dx,point.y-a.y-ratio*dy);};
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const intersects=(a:Point,b:Point,c:Point,d:Point)=>Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))&&cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0;
const inside=(point:Point,polygon:Point[])=>{let value=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if(distance(point,a,b)<=1e-9)return true;if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)value=!value;}return value;};
export function painted(block:Block,strokes:PaintStroke[],policy:PaintInclusion):boolean {
  const polygon=block.geometry.polygon;
  if(policy==='CENTER'){const center={x:(Math.min(...polygon.map(p=>p.x))+Math.max(...polygon.map(p=>p.x)))/2,y:(Math.min(...polygon.map(p=>p.y))+Math.max(...polygon.map(p=>p.y)))/2};return strokes.some(stroke=>stroke.points.some((a,i)=>distance(center,a,stroke.points[i+1]??a)<=stroke.radiusPx));}
  return strokes.some(stroke=>stroke.points.some((a,i)=>{const b=stroke.points[i+1]??a;if(inside(a,polygon)||inside(b,polygon))return true;return polygon.some((c,j)=>{const d=polygon[(j+1)%polygon.length];return intersects(a,b,c,d)||Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b))<=stroke.radiusPx;});}));
}
export function selectedCleanupRegions(data:EditData,scope:Scope,strokes:PaintStroke[]=[],inclusion?:PaintInclusion):string[]{
  if(scope.kind==='PAINTED')requireCondition(inclusion,'POLICY_DECISION_REQUIRED',409,'WAIT');
  return data.blocks.filter(block=>scope.kind==='PAGE'||(scope.kind==='REGIONS'?scope.regionIds.includes(block.regionId):painted(block,strokes,inclusion!))).map(block=>block.regionId);
}
export function validateEditData(data:EditData,width:number,height:number):void {
  requireCondition(Array.isArray(data.blocks)&&new Set(data.blocks.map(block=>block.regionId)).size===data.blocks.length,'PROPOSAL_INVALID',422);
  requireCondition(new Set(data.blocks.map(block=>block.geometry.readingOrder)).size===data.blocks.length,'PROPOSAL_INVALID',422);
  for(const block of data.blocks){assertWire<Block>('block',block);const points=block.geometry.polygon;for(const point of points)requireCondition(point.x>=0&&point.y>=0&&point.x<=width&&point.y<=height,'PROPOSAL_INVALID',422);let area=0;for(let i=0;i<points.length;i++)area+=points[i].x*points[(i+1)%points.length].y-points[(i+1)%points.length].x*points[i].y;requireCondition(Math.abs(area)>1e-9,'PROPOSAL_INVALID',422);}
  if(data.renderSpecification){
    assertWire('renderSpecification',data.renderSpecification);requireCondition(new Set(data.renderSpecification.blocks.map(item=>item.regionId)).size===data.blocks.length&&data.renderSpecification.blocks.length===data.blocks.length&&data.renderSpecification.blocks.every(item=>data.blocks.some(block=>block.regionId===item.regionId)),'PROPOSAL_INVALID',422);
    for(const specification of data.renderSpecification.blocks){
      if(specification.targetOrientation!==undefined)requireCondition(isOverflowRenderer(specification.rendererVersion),'PROPOSAL_INVALID',422);
      if(specification.typesetBox!==undefined){
      const {left,top,width:boxWidth,height:boxHeight}=specification.typesetBox,right=left+boxWidth,bottom=top+boxHeight;
      requireCondition(isOverflowRenderer(specification.rendererVersion)&&Number.isFinite(right)&&Number.isFinite(bottom)&&right>left&&bottom>top&&right<=width&&bottom<=height&&[Math.floor(left),Math.floor(top),Math.ceil(right),Math.ceil(bottom)].every(Number.isSafeInteger)&&Math.ceil(right)>Math.floor(left)&&Math.ceil(bottom)>Math.floor(top),'PROPOSAL_INVALID',422);
      }
    }
  }
}
export function mergeScopedData(initial:EditData,proposal:EditData,scope:Scope,strokes:PaintStroke[]=[],inclusion?:PaintInclusion):EditData {
  if(scope.kind==='PAGE')return structuredClone(proposal);
  if(scope.kind==='PAINTED')requireCondition(inclusion,'POLICY_DECISION_REQUIRED',409,'WAIT');
  const selected=new Set(scope.kind==='REGIONS'?scope.regionIds:initial.blocks.filter(block=>painted(block,strokes,inclusion!)).map(block=>block.regionId));
  const proposed=new Map(proposal.blocks.map(block=>[block.regionId,block]));const result=structuredClone(initial);
  for(let i=0;i<result.blocks.length;i++){const prior=result.blocks[i];if(!selected.has(prior.regionId))continue;const next=proposed.get(prior.regionId);requireCondition(next,'PROPOSAL_INVALID',422);result.blocks[i]=structuredClone(next);}
  if(scope.kind==='PAINTED')for(const block of proposal.blocks)if(!initial.blocks.some(prior=>prior.regionId===block.regionId)){requireCondition(painted(block,strokes,inclusion!),'PROPOSAL_INVALID',422);result.blocks.push(structuredClone(block));selected.add(block.regionId);}
  if(initial.renderSpecification||proposal.renderSpecification){const catalog=initial.renderSpecification?.fontCatalogVersion??proposal.renderSpecification!.fontCatalogVersion;requireCondition(!initial.renderSpecification||!proposal.renderSpecification||catalog===proposal.renderSpecification.fontCatalogVersion,'PROPOSAL_INVALID',422);result.renderSpecification={version:1,fontCatalogVersion:catalog,blocks:result.blocks.map(block=>{const chosen=selected.has(block.regionId);const source=chosen?proposal.renderSpecification:initial.renderSpecification;const spec=source?.blocks.find(item=>item.regionId===block.regionId);if(!spec&&!chosen&&!initial.renderSpecification)return {regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT' as const};requireCondition(spec,'PROPOSAL_INVALID',422);return structuredClone(spec);})};}
  // Unselected blocks, including their provenance and captured render settings, stay byte-identical.
  for(const block of initial.blocks)if(!selected.has(block.regionId))requireCondition(digest(result.blocks.find(item=>item.regionId===block.regionId))===digest(block),'PROPOSAL_INVALID',422);
  return result;
}
