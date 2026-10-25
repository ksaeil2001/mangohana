import sharp,{type OverlayOptions} from 'sharp';
import {requireCondition} from '../../contracts/src/errors.js';
import {RenderLayoutHold,type BlockLayout,type RenderLayout,type RenderedPage} from './render-contract.js';
export {RenderLayoutHold,type BlockLayout,type RenderLayout,type RenderedPage} from './render-contract.js';
import type {EditData} from '../../domain/src/model.js';
import type {Block} from '../../contracts/src/wire.generated.js';
import type {MediaProfile} from './profile.js';
import {decodeImage} from './images.js';
import type {FontCatalog} from './fonts.js';
import {legacyRenderPage} from './legacy-render.js';
import {balloonRendererVersion,isOverflowRenderer,pageRendererVersion,type RendererVersion} from './render-policy.js';
import {findBalloonCandidate,balloonTypesetBox,tallerBalloonTypesetBox,boxPolygon} from './balloon-area.js';
export {overflowRendererVersion,type RendererVersion} from './render-policy.js';

export const escapeMarkup=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

export function blockRenderer(data:EditData,regionId:string):RendererVersion{return data.renderSpecification?.blocks.find(item=>item.regionId===regionId)?.rendererVersion??'pango-canonical-v1';}
export function canonicalRendererVersion(data:EditData):string{return pageRendererVersion(data.blocks.map(block=>blockRenderer(data,block.regionId)));}
const inside=(x:number,y:number,polygon:Block['geometry']['polygon'])=>{let result=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;};
const withinBounds=(width:number,height:number,profile:MediaProfile)=>width>0&&height>0&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width<=profile.maxWidth&&height<=profile.maxHeight&&width*height<=profile.maxPixels;
const bounded=(width:number,height:number,profile:MediaProfile)=>requireCondition(withinBounds(width,height,profile),'RENDER_FAILED',422);
const polygonBox=(p:Block['geometry']['polygon'])=>{const left=Math.floor(Math.min(...p.map(point=>point.x))),top=Math.floor(Math.min(...p.map(point=>point.y)));return {left,top,width:Math.ceil(Math.max(...p.map(point=>point.x)))-left,height:Math.ceil(Math.max(...p.map(point=>point.y)))-top};};
const koreanWordMarkup=(text:string,mode:'strict'|'segment')=>text.split(/(\s+)/u).map(token=>/\p{Script=Hangul}/u.test(token)?'<span '+(mode==='strict'?'allow_breaks="false"':'segment="word"')+'>'+escapeMarkup(token)+'</span>':escapeMarkup(token)).join('');
async function rotateOverlay(bytes:Buffer,angle:number){if(angle!==0)bytes=await sharp(bytes).rotate(angle,{background:'#00000000'}).png().toBuffer();const raw=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {bytes,raw:raw.data,width:raw.info.width,height:raw.info.height};}
async function trimCenteredOverlay(canvas:Awaited<ReturnType<typeof rotateOverlay>>,box:ReturnType<typeof polygonBox>){
  let x0=canvas.width,y0=canvas.height,x1=-1,y1=-1;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(canvas.raw[(y*canvas.width+x)*4+3]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  if(x1<0)return {overlay:null,bounds:null};const bounds={left:Math.floor(box.left+(box.width-canvas.width)/2)+x0,top:Math.floor(box.top+(box.height-canvas.height)/2)+y0,width:x1-x0+1,height:y1-y0+1};return {overlay:await sharp(canvas.bytes).extract({left:x0,top:y0,width:bounds.width,height:bounds.height}).png().toBuffer(),bounds};
}
type GlyphMetrics=Pick<BlockLayout,'glyphPixels'|'glyphPixelsOutsidePolygon'|'glyphPixelsOutsidePage'|'glyphPixelsInsideOtherPolygons'>;
function measureGlyphPixels(raw:Buffer,bounds:NonNullable<BlockLayout['glyphBounds']>,block:Block,data:EditData,polygon:Block['geometry']['polygon'],layoutPolygons:Map<string,Block['geometry']['polygon']>,page:{width:number;height:number}):GlyphMetrics{
  let glyphPixels=0,glyphPixelsOutsidePolygon=0,glyphPixelsOutsidePage=0;const counts=new Map<string,number>();for(let y=0;y<bounds.height;y++)for(let x=0;x<bounds.width;x++)if(raw[(y*bounds.width+x)*4+3]){glyphPixels++;const px=bounds.left+x,py=bounds.top+y;if(px<0||py<0||px>=page.width||py>=page.height)glyphPixelsOutsidePage++;if(!inside(px+.5,py+.5,polygon))glyphPixelsOutsidePolygon++;for(const other of data.blocks)if(other.regionId!==block.regionId&&(inside(px+.5,py+.5,other.geometry.polygon)||(layoutPolygons.get(other.regionId)!==other.geometry.polygon&&inside(px+.5,py+.5,layoutPolygons.get(other.regionId)!))))counts.set(other.regionId,(counts.get(other.regionId)??0)+1);}
  return {glyphPixels,glyphPixelsOutsidePolygon,glyphPixelsOutsidePage,glyphPixelsInsideOtherPolygons:[...counts].map(([regionId,pixels])=>({regionId,pixels}))};
}
const clearGlyphs=(metric:GlyphMetrics)=>metric.glyphPixels>0&&metric.glyphPixelsOutsidePage===0&&metric.glyphPixelsOutsidePolygon===0&&metric.glyphPixelsInsideOtherPolygons.length===0;


async function layoutBlock(block:Block,data:EditData,fonts:FontCatalog,profile:MediaProfile,minFontSize:number,polygon:Block['geometry']['polygon']){
  const spec=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);const minimum=spec?.sizing==='EXACT'?block.fontSizePx:spec?.minimumFontSizePx??minFontSize;
  const text=block.translatedText.value||block.sourceText.value;requireCondition(text.length<=profile.maxTextLength&&fonts.covers(block.fontAssetId,text)&&Number.isFinite(block.fontSizePx)&&block.fontSizePx>0&&block.fontSizePx<=profile.maxFontSize&&Number.isFinite(minimum)&&minimum>0&&minimum<=block.fontSizePx&&Number.isFinite(block.geometry.angleDegrees)&&Math.abs(block.geometry.angleDegrees)<=180,'RENDER_FAILED',422);
  const box=polygonBox(polygon),{width,height}=box;bounded(width,height,profile);
  const font=fonts.font(block.fontAssetId);const sizes=[block.fontSizePx];if(spec?.sizing!=='EXACT')while(sizes.at(-1)!>minimum)sizes.push(Math.max(minimum,sizes.at(-1)!-1));
  let overlay:Buffer|null=null;let chosen=block.fontSizePx;let fallbackAtMinimum=false;
  for(const size of sizes){
    chosen=size;if(!text.trim())break;
    if((spec?.targetOrientation??block.geometry.orientation)==='HORIZONTAL'){
      const rendered=await sharp({text:{text:escapeMarkup(text),font:`${font.family} ${size}`,fontfile:fonts.file(font.id),width,align:'center',dpi:72,rgba:true,wrap:'word-char'}}).png().toBuffer({resolveWithObject:true});if(!withinBounds(rendered.info.width,rendered.info.height,profile)&&size!==sizes.at(-1))continue;bounded(rendered.info.width,rendered.info.height,profile);
      const fits=rendered.info.width<=width&&rendered.info.height<=height;if(!fits&&size!==sizes.at(-1))continue;fallbackAtMinimum=!fits;overlay=rendered.data;
    }else{
      const cell=Math.max(1,Math.ceil(size*1.15));const rows=Math.max(1,Math.floor(height/cell));const positions:{character:string;column:number;row:number;bytes:Buffer;width:number;height:number}[]=[];let column=0,row=0,maxGlyphWidth=cell,maxGlyphHeight=cell;
      for(const {segment:character}of new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(text)){
        if(character==='\n'){column++;row=0;continue;}if(row>=rows){column++;row=0;}const at=row++;if(/^\s+$/u.test(character))continue;
        const glyph=await sharp({text:{text:escapeMarkup(character),font:`${font.family} ${size}`,fontfile:fonts.file(font.id),rgba:true,dpi:72}}).png().toBuffer({resolveWithObject:true});maxGlyphWidth=Math.max(maxGlyphWidth,glyph.info.width);maxGlyphHeight=Math.max(maxGlyphHeight,glyph.info.height);positions.push({character,column,row:at,bytes:glyph.data,width:glyph.info.width,height:glyph.info.height});
      }
      if(!positions.length)break;const columns=Math.max(...positions.map(item=>item.column))+1,usedRows=Math.max(...positions.map(item=>item.row))+1;const neededWidth=columns*maxGlyphWidth,neededHeight=usedRows*maxGlyphHeight;if(!withinBounds(neededWidth,neededHeight,profile)&&size!==sizes.at(-1))continue;bounded(neededWidth,neededHeight,profile);
      const fits=neededWidth<=width&&neededHeight<=height;if(!fits&&size!==sizes.at(-1))continue;fallbackAtMinimum=!fits;const layers:OverlayOptions[]=positions.map(item=>({input:item.bytes,left:(columns-1-item.column)*maxGlyphWidth+Math.floor((maxGlyphWidth-item.width)/2),top:item.row*maxGlyphHeight+Math.floor((maxGlyphHeight-item.height)/2)}));overlay=await sharp({create:{width:neededWidth,height:neededHeight,channels:4,background:'#00000000'}}).composite(layers).png().toBuffer();
    }
    break;
  }
  if(!overlay)return {overlay:null,size:chosen,minimum,fallbackAtMinimum,bounds:null};
  const canvas=await rotateOverlay(overlay,block.geometry.angleDegrees);bounded(canvas.width,canvas.height,profile);return {...await trimCenteredOverlay(canvas,box),size:chosen,minimum,fallbackAtMinimum};
}

type FinalBlockLayout=Awaited<ReturnType<typeof layoutBlock>>&{coverage:GlyphMetrics;wordProtection:'strict'|'segment'|null;strictHeightOverflow:boolean};
async function finishWordLayout(block:Block,data:EditData,fonts:FontCatalog,profile:MediaProfile,rendered:Awaited<ReturnType<typeof layoutBlock>>,polygon:Block['geometry']['polygon'],collisionPolygons:Map<string,Block['geometry']['polygon']>,page:{width:number;height:number},strictVerticalBounds?:{top:number;height:number}):Promise<FinalBlockLayout>{
  if(!rendered.overlay||!rendered.bounds)return {...rendered,coverage:{glyphPixels:0,glyphPixelsOutsidePolygon:0,glyphPixelsOutsidePage:0,glyphPixelsInsideOtherPolygons:[]},wordProtection:null,strictHeightOverflow:false};
  let strictHeightOverflow=false;
  const coverage=measureGlyphPixels(await sharp(rendered.overlay).ensureAlpha().raw().toBuffer(),rendered.bounds,block,data,polygon,collisionPolygons,page);
  const spec=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId),text=block.translatedText.value||block.sourceText.value;
  // Preserve the established size and strict-to-segment order. Only a strict
  // automatic candidate can use the full safe area's vertical space.
  if(!rendered.fallbackAtMinimum&&clearGlyphs(coverage)&&(spec?.targetOrientation??block.geometry.orientation)==='HORIZONTAL'&&/\p{Script=Hangul}/u.test(text)){
    const box=polygonBox(polygon),font=fonts.font(block.fontAssetId);
    for(const mode of ['strict','segment'] as const){
      const candidate=await sharp({text:{text:koreanWordMarkup(text,mode),font:font.family+' '+rendered.size,fontfile:fonts.file(font.id),width:box.width,align:'center',dpi:72,rgba:true,wrap:'word-char'}}).png().toBuffer({resolveWithObject:true});
      if(mode==='strict'&&withinBounds(candidate.info.width,candidate.info.height,profile)&&candidate.info.width<=box.width&&candidate.info.height>box.height)strictHeightOverflow=true;
      if(withinBounds(candidate.info.width,candidate.info.height,profile)&&candidate.info.width<=box.width&&candidate.info.height<=box.height){
        const canvas=await rotateOverlay(candidate.data,block.geometry.angleDegrees);
        if(withinBounds(canvas.width,canvas.height,profile)){
          const candidateCoverage=measureGlyphPixels(canvas.raw,{left:Math.floor(box.left+(box.width-canvas.width)/2),top:Math.floor(box.top+(box.height-canvas.height)/2),width:canvas.width,height:canvas.height},block,data,polygon,collisionPolygons,page);
          if(clearGlyphs(candidateCoverage)){
            const positioned=await trimCenteredOverlay(canvas,box);
            const verticalBounds=mode==='strict'&&strictVerticalBounds?strictVerticalBounds:rendered.bounds;
            if(positioned.overlay&&positioned.bounds&&positioned.bounds.top>=verticalBounds.top&&positioned.bounds.top+positioned.bounds.height<=verticalBounds.top+verticalBounds.height)return {...rendered,overlay:positioned.overlay,bounds:positioned.bounds,coverage:candidateCoverage,wordProtection:mode,strictHeightOverflow};
          }
        }
      }
    }
  }
  return {...rendered,coverage,wordProtection:null,strictHeightOverflow};
}

export async function renderPageDetailed(source:Buffer,data:EditData,fonts:FontCatalog,profile:MediaProfile,minFontSize=1):Promise<RenderedPage>{
  requireCondition(data.blocks.length<=profile.maxBlocks&&['source-pixels-v1','synthetic-v1'].includes(data.geometryContract)&&['pango-canonical-v1','synthetic-v1'].includes(data.renderContract),'RENDER_FAILED',422);
  for(const specification of data.renderSpecification?.blocks??[]){
    if(specification.typesetBox!==undefined||specification.targetOrientation!==undefined)requireCondition(isOverflowRenderer(specification.rendererVersion),'RENDER_FAILED',422);
    if(specification.targetOrientation!==undefined)requireCondition(specification.targetOrientation==='HORIZONTAL'||specification.targetOrientation==='VERTICAL','RENDER_FAILED',422);
  }
  if(canonicalRendererVersion(data)==='pango-canonical-v1')return {bytes:await legacyRenderPage(source,data,fonts,profile,minFontSize),layout:{rendererVersion:'pango-canonical-v1',qa:'NOT_RUN',holdReasons:[],blocks:[]},overlays:[]};
  const decoded=await decodeImage(source,profile);let base=decoded.canonicalPng;const metrics:BlockLayout[]=[];const overlays:RenderedPage['overlays']=[];const holds=new Set<string>();let review=false;
  const layoutPolygons=new Map(data.blocks.map((block):[string,Block['geometry']['polygon']]=>{
    const box=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId)?.typesetBox;
    if(box===undefined)return [block.regionId,block.geometry.polygon];
    requireCondition(box&&typeof box==='object','RENDER_FAILED',422);
    const {left,top,width,height}=box,right=left+width,bottom=top+height;
    requireCondition([left,top,width,height,right,bottom].every(Number.isFinite)&&left>=0&&top>=0&&width>0&&height>0&&right>left&&bottom>top&&right<=decoded.width&&bottom<=decoded.height&&[Math.floor(left),Math.floor(top),Math.ceil(right),Math.ceil(bottom)].every(Number.isSafeInteger)&&Math.ceil(right)>Math.floor(left)&&Math.ceil(bottom)>Math.floor(top),'RENDER_FAILED',422);
    return [block.regionId,[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}]];
  }));
  // Reserve geometry before shaping text. A changed translation must not move
  // another block by changing whether an earlier candidate happens to fit.
  const balloonPolygons=new Map<string,Block['geometry']['polygon']>(),adoptedAutomatic=new Set<string>();
  const tallerPolygons=new Map<string,Block['geometry']['polygon']>();
  if((data.cleanupQa==='NEEDS_REVIEW'||data.cleanupQa==='PASSED')&&data.blocks.some(block=>blockRenderer(data,block.regionId)===balloonRendererVersion)){
    const background=await sharp(decoded.canonicalPng).ensureAlpha().raw().toBuffer();
    const userTypesetBoxes=(data.renderSpecification?.blocks??[]).flatMap(spec=>spec.typesetBox?[spec.typesetBox]:[]),reservedBoxes:ReturnType<typeof polygonBox>[]=[];
    const provisionalTallerBoxes=new Map<string,ReturnType<typeof polygonBox>>();
    for(const block of [...data.blocks].sort((a,b)=>a.geometry.readingOrder-b.geometry.readingOrder)){
      const spec=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);
      if(spec?.rendererVersion!==balloonRendererVersion||spec.typesetBox!==undefined||(spec.targetOrientation??block.geometry.orientation)!=='HORIZONTAL')continue;
      const result=findBalloonCandidate({rgba:background,width:decoded.width,height:decoded.height,sourcePolygon:block.geometry.polygon,otherSourcePolygons:data.blocks.filter(other=>other.regionId!==block.regionId).map(other=>other.geometry.polygon),userTypesetBoxes,acceptedAutomaticBoxes:reservedBoxes});
      const candidate=balloonTypesetBox(result);
      if(candidate){balloonPolygons.set(block.regionId,boxPolygon(candidate));reservedBoxes.push(candidate);}
      if(candidate&&spec.sizing==='AUTO_FIT'&&block.geometry.angleDegrees===0){const taller=tallerBalloonTypesetBox(result,candidate);if(taller)provisionalTallerBoxes.set(block.regionId,taller);}
    }
    // Freeze every original primary first. Supplementary reservations cannot
    // change baseline/primary layout or another block's primary geometry.
    const primaries=[...balloonPolygons].map(([regionId,polygon])=>({regionId,box:polygonBox(polygon)})),allowedTallerBoxes:ReturnType<typeof polygonBox>[]=[];
    const overlaps=(a:ReturnType<typeof polygonBox>,b:ReturnType<typeof polygonBox>)=>a.left<b.left+b.width&&b.left<a.left+a.width&&a.top<b.top+b.height&&b.top<a.top+a.height;
    for(const block of [...data.blocks].sort((a,b)=>a.geometry.readingOrder-b.geometry.readingOrder)){
      const taller=provisionalTallerBoxes.get(block.regionId);
      if(taller&&!primaries.some(item=>item.regionId!==block.regionId&&overlaps(taller,item.box))&&!allowedTallerBoxes.some(box=>overlaps(taller,box))){tallerPolygons.set(block.regionId,boxPolygon(taller));allowedTallerBoxes.push(taller);}
    }
  }
  const reservedPolygons=new Map([...layoutPolygons,...balloonPolygons]);
  const selectionPolygons=balloonPolygons.size?reservedPolygons:layoutPolygons;
  for(const block of [...data.blocks].sort((a,b)=>a.geometry.readingOrder-b.geometry.readingOrder)){
    if(blockRenderer(data,block.regionId)==='pango-canonical-v1'){base=await legacyRenderPage(base,{...data,blocks:[block]},fonts,profile,minFontSize);continue;}
    for(const point of block.geometry.polygon)requireCondition(Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<=decoded.width&&point.y<=decoded.height,'RENDER_FAILED',422);
    let polygon=layoutPolygons.get(block.regionId)!;
    // Complete the source/user geometry layout before considering an automatic area.
    let rendered=await finishWordLayout(block,data,fonts,profile,await layoutBlock(block,data,fonts,profile,minFontSize,polygon),polygon,selectionPolygons,decoded);
    const spec=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId),text=block.translatedText.value||block.sourceText.value;
    const automaticPolygon=balloonPolygons.get(block.regionId);
    if(rendered.overlay&&rendered.bounds&&automaticPolygon&&spec?.sizing==='AUTO_FIT'&&spec.typesetBox===undefined&&/\p{Script=Hangul}/u.test(text)){
      const taller=tallerPolygons.get(block.regionId),candidates=taller?[automaticPolygon,taller]:[automaticPolygon];let allowTaller=false;
      for(const [index,candidatePolygon]of candidates.entries()){
        if(index>0&&!allowTaller)break;
        const candidateLayout=await layoutBlock(block,data,fonts,profile,minFontSize,candidatePolygon);
        if(!candidateLayout.overlay||!candidateLayout.bounds||candidateLayout.fallbackAtMinimum||candidateLayout.size<rendered.size)break;
        const candidate=await finishWordLayout(block,data,fonts,profile,candidateLayout,candidatePolygon,reservedPolygons,decoded,polygonBox(candidatePolygon));
        if(index===0)allowTaller=candidateLayout.size===rendered.size&&candidate.strictHeightOverflow&&block.geometry.angleDegrees===0;
        // A wider same-size plain layout may split previously intact Korean words.
        // Only a final strict word-protected overlay can replace the captured result;
        // segment/plain outcomes provide insufficient evidence and keep the baseline.
        if(candidate.overlay&&candidate.bounds&&candidate.wordProtection==='strict'&&clearGlyphs(candidate.coverage)){
          // Compare finalized layouts, not the automatic area's plain probe.
          // Keep an intact same-size placement unless an unrotated strict
          // candidate saves at least one em of glyph height. This is a
          // conservative selection condition, not a visual quality verdict.
          const canReplaceIntactLayout=candidate.size>rendered.size||rendered.wordProtection!=='strict'||(block.geometry.angleDegrees===0&&rendered.bounds.height-candidate.bounds.height>=rendered.size);
          if(canReplaceIntactLayout){polygon=candidatePolygon;rendered=candidate;layoutPolygons.set(block.regionId,polygon);adoptedAutomatic.add(block.regionId);break;}
        }
      }
    }
    const metric:BlockLayout={regionId:block.regionId,rendererVersion:blockRenderer(data,block.regionId),fontSizePx:rendered.size,minimumFontSizePx:rendered.minimum,fallbackAtMinimum:rendered.fallbackAtMinimum,angleDegrees:block.geometry.angleDegrees,glyphBounds:rendered.bounds,...rendered.coverage};
    if(rendered.overlay&&rendered.bounds){
      const overlay=rendered.overlay,bounds=rendered.bounds;
      overlays.push({regionId:block.regionId,bytes:overlay,bounds});if(metric.glyphPixelsOutsidePage)holds.add('GLYPHS_OUTSIDE_PAGE');
      if(metric.glyphPixelsOutsidePolygon||metric.glyphPixelsInsideOtherPolygons.length||rendered.fallbackAtMinimum)review=true;
      if(profile.kind==='MEASURED'&&(metric.glyphPixelsOutsidePolygon||metric.glyphPixelsInsideOtherPolygons.length))holds.add('OVERFLOW_TOLERANCE_UNMEASURED');
      if(!metric.glyphPixelsOutsidePage)base=await sharp(base).composite([{input:overlay,left:bounds.left,top:bounds.top}]).png({compressionLevel:6}).toBuffer();
    }
    metrics.push(metric);
  }
  if(balloonPolygons.size){
    // Report actual chosen areas, rather than unused geometry reservations.
    holds.clear();review=adoptedAutomatic.size>0;
    for(const metric of metrics){const overlay=overlays.find(item=>item.regionId===metric.regionId),block=data.blocks.find(item=>item.regionId===metric.regionId)!;
      if(overlay)Object.assign(metric,measureGlyphPixels(await sharp(overlay.bytes).ensureAlpha().raw().toBuffer(),overlay.bounds,block,data,layoutPolygons.get(block.regionId)!,layoutPolygons,decoded));
      if(metric.glyphPixelsOutsidePage)holds.add('GLYPHS_OUTSIDE_PAGE');
      if(metric.glyphPixelsOutsidePolygon||metric.glyphPixelsInsideOtherPolygons.length||metric.fallbackAtMinimum)review=true;
      if(profile.kind==='MEASURED'&&(metric.glyphPixelsOutsidePolygon||metric.glyphPixelsInsideOtherPolygons.length))holds.add('OVERFLOW_TOLERANCE_UNMEASURED');
    }
  }
  const layout:RenderLayout={rendererVersion:canonicalRendererVersion(data),qa:holds.size?'HOLD':review?'REVIEW_REQUIRED':'NOT_RUN',holdReasons:[...holds],blocks:metrics};return {bytes:holds.size?null:await sharp(base).png({compressionLevel:6}).toBuffer(),layout,overlays};
}
export async function renderPage(source:Buffer,data:EditData,fonts:FontCatalog,profile:MediaProfile,minFontSize=1):Promise<Buffer>{const result=await renderPageDetailed(source,data,fonts,profile,minFontSize);if(!result.bytes)throw new RenderLayoutHold(result);return result.bytes;}
