import {beforeEach,expect,it,vi} from 'vitest';
import type {EditData} from '../../packages/domain/src/model.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';

const pixels=vi.hoisted(()=>{
  type Frame={width:number;height:number;data:Buffer};
  type Protection='plain'|'strict'|'segment';
  const shapeCalls:{text:string;visibleText:string;width:number|undefined;size:number;protection:Protection;shapedWidth:number;shapedHeight:number}[]=[];
  let mode:'normal'|'shrink'|'fallback'='normal';
  let wordMode:'normal'|'wide-strict-fails'|'segment-only'|'plain-only'|'narrow-strict-fails'|'wide-strict-expands'='normal';
  let wideStrictHeight:number|undefined;
  const encode=(f:Frame)=>Buffer.from(JSON.stringify({mock:'FAKE_RGBA_NOT_PNG',width:f.width,height:f.height,data:f.data.toString('base64')}));
  const decode=(b:Buffer):Frame=>{const f=JSON.parse(b.toString());if(f.mock!=='FAKE_RGBA_NOT_PNG')throw Error('NON_FIXTURE_BYTES');return {width:f.width,height:f.height,data:Buffer.from(f.data,'base64')};};
  const frame=(width:number,height:number,color=[0,0,0,0]):Frame=>{const data=Buffer.alloc(width*height*4);for(let i=0;i<data.length;i+=4)data.set(color,i);return {width,height,data};};
  const shape=(t:{text:string;font:string;width?:number})=>{
    const size=Number(t.font.split(' ').at(-1)),width=t.width;
    const protection:Protection=t.text.includes('allow_breaks="false"')?'strict':t.text.includes('segment="word"')?'segment':'plain';
    // Strip only generated wrappers, then decode entities once: escaped user markup remains text.
    const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    const visibleText=t.text.replace(/<\/?span\b[^>]*>/gu,'').replace(/&(amp|lt|gt|quot|apos);/gu,(_,name:string)=>entities[name]);
    const unit=Math.max(1,Math.ceil(size*.6)),lineHeight=Math.ceil(size*1.2);
    const lineWidths=visibleText.split('\n').flatMap(paragraph=>{
      if(protection!=='strict'){
        const length=Math.max(1,[...paragraph].length*unit),limit=width??length;
        return Array.from({length:Math.max(1,Math.ceil(length/limit))},(_,line)=>Math.min(limit,length-line*limit));
      }
      // Whole Hangul whitespace tokens are atomic in strict mode. Segment mode
      // uses the existing character-wrap approximation and cannot prove this contract.
      const lines:number[]=[];let used=0,pendingSpace=0;
      for(const token of paragraph.split(/(\s+)/u)){
        if(!token)continue;
        if(/^\s+$/u.test(token)){pendingSpace=[...token].length*Math.max(1,Math.ceil(unit*.4));continue;}
        const pieces=/\p{Script=Hangul}/u.test(token)?[token]:[...token];
        for(const piece of pieces){
          const advance=[...piece].length*unit;
          if(used&&width!==undefined&&used+pendingSpace+advance>width){lines.push(used);used=0;pendingSpace=0;}
          used+=(used?pendingSpace:0)+advance;pendingSpace=0;
        }
      }
      lines.push(Math.max(1,used));return lines;
    });
    let w=Math.max(...lineWidths),h=Math.max(1,lineWidths.length*lineHeight);
    // Rasterize a fitting strict rectangle on the requested box's center grid.
    // Round outward by at most one pixel; oversized words stay oversized.
    if(protection==='strict'&&width!==undefined&&w<width&&(width-w)%2!==0)w++;
    if(protection==='strict'&&(wordMode==='segment-only'||wordMode==='plain-only'
      ||(wordMode==='wide-strict-fails'&&width!==undefined&&width>40)
      ||(wordMode==='narrow-strict-fails'&&width!==undefined&&width<=40)))w=(width??w)+1;
    if(protection==='segment'&&wordMode==='plain-only')w=(width??w)+1;
    // Fits the larger box, but exceeds its plain layout's safe vertical footprint.
    if(protection==='strict'&&wordMode==='wide-strict-expands'&&width!==undefined&&width>40){
      const plainLines=visibleText.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].length*unit/width)),0);
      h=(plainLines+1)*lineHeight;
    }
    // Fake ink-height override isolates the final strict candidate's 1px boundary.
    if(protection==='strict'&&width!==undefined&&width>40&&wideStrictHeight!==undefined)h=wideStrictHeight;
    if(width&&width>40&&mode==='shrink'&&size>18)h=100;
    if(width&&width>40&&mode==='fallback')h=100;
    shapeCalls.push({text:t.text,visibleText,width,size,protection,shapedWidth:w,shapedHeight:h});
    return frame(w,h,[0,0,0,255]);
  };
  const sharp=(input:Buffer|{text:{text:string;font:string;width?:number}}|{create:{width:number;height:number;background:string}})=>{
    let f:Frame=Buffer.isBuffer(input)?decode(input):'text' in input?shape(input.text):frame(input.create.width,input.create.height);
    let raw=false;
    const api={
      png:()=>api,ensureAlpha:()=>api,
      raw:()=>{raw=true;return api;},
      rotate:(angle:number)=>{
        if(angle===180||angle===-180){
          const next=frame(f.width,f.height);
          for(let at=0;at<f.data.length;at+=4)f.data.copy(next.data,f.data.length-at-4,at,at+4);
          f=next;
        }else if(angle!==0)throw Error('MOCK_ROTATION_UNSUPPORTED');
        return api;
      },
      extract:(r:{left:number;top:number;width:number;height:number})=>{
        const next=frame(r.width,r.height);
        for(let y=0;y<r.height;y++)f.data.copy(next.data,y*r.width*4,((y+r.top)*f.width+r.left)*4,((y+r.top)*f.width+r.left+r.width)*4);
        f=next;return api;
      },
      composite:(layers:{input:Buffer;left:number;top:number}[])=>{
        const next={...f,data:Buffer.from(f.data)};
        for(const layer of layers){const glyph=decode(layer.input);for(let y=0;y<glyph.height;y++)for(let x=0;x<glyph.width;x++){
          const px=layer.left+x,py=layer.top+y;if(px<0||py<0||px>=f.width||py>=f.height)throw Error('MOCK_COMPOSITE_OUTSIDE_PAGE');
          const at=(y*glyph.width+x)*4;if(glyph.data[at+3])glyph.data.copy(next.data,(py*f.width+px)*4,at,at+4);
        }}f=next;return api;
      },
      toBuffer:async(options?:{resolveWithObject?:boolean})=>{
        const data=raw?Buffer.from(f.data):encode(f);
        return options?.resolveWithObject?{data,info:{width:f.width,height:f.height,channels:4}}:data;
      }
    };return api;
  };
  return {shapeCalls,encode,decode,frame,sharp,setMode:(value:typeof mode)=>{mode=value;},setWordMode:(value:typeof wordMode)=>{wordMode=value;},setWideStrictHeight:(value:number|undefined)=>{wideStrictHeight=value;},reset:()=>{shapeCalls.length=0;mode='normal';wordMode='normal';wideStrictHeight=undefined;}};
});
vi.mock('sharp',()=>({default:pixels.sharp}));
vi.mock('../../packages/media/src/images.js',()=>({decodeImage:async(source:Buffer)=>{const f=pixels.decode(source);return {width:f.width,height:f.height,canonicalPng:source};}}));
vi.mock('../../packages/media/src/legacy-render.js',()=>({legacyRenderPage:()=>{throw Error('UNEXPECTED_LEGACY_RENDER');}}));
import {renderPageDetailed} from '../../packages/media/src/render.js';
import {centeredBalloonBox,findBalloonCandidate} from '../../packages/media/src/balloon-area.js';
import * as balloonArea from '../../packages/media/src/balloon-area.js';

const fonts={covers:()=>true,font:()=>({id:'fixture-font',family:'Fixture'}),file:()=>'/fixture/never-read.ttf'} as unknown as FontCatalog;
const polygon=(left:number,top:number,width:number,height:number)=>[{x:left,y:top},{x:left+width,y:top},{x:left+width,y:top+height},{x:left,y:top+height}] as EditData['blocks'][number]['geometry']['polygon'];
function fixture(offset=0,text='새로운 만화에서 읽어요'){
  const f=pixels.frame(400+offset,300,[31,42,53,255]);
  for(let y=110;y<190;y++)for(let x=150+offset;x<250+offset;x++)f.data.set([255,255,255,255],(y*f.width+x)*4);
  const data:EditData={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',
    blocks:[{regionId:'region-a',geometry:{polygon:polygon(180+offset,138,40,24),angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},
      sourceText:{value:'元の言葉',status:'USER_CONFIRMED'},translatedText:{value:text,status:'USER_MODIFIED'},fontAssetId:'fixture-font',fontSizePx:20,appliedTranslation:null}],
    renderSpecification:{version:1,fontCatalogVersion:'fixture-v1',blocks:[{regionId:'region-a',minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-balloon-v3'}]}};
  return {source:pixels.encode(f),data};
}
function strictCapturedFixture(angle=0){
  const f=fixture(127,'차분히 먼저 읽어'),image=pixels.frame(527,300,[31,42,53,255]);
  // Only the synthetic white area's height changes; the wrap approximation is unchanged.
  for(let y=74;y<194;y++)for(let x=277;x<377;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);
  f.data.blocks[0].geometry={...f.data.blocks[0].geometry,polygon:polygon(302,93,40,72),angleDegrees:angle};
  const protectedRegion=structuredClone(f.data.blocks[0]);protectedRegion.regionId='protected-region';
  protectedRegion.geometry={...protectedRegion.geometry,polygon:polygon(55,219,28,32),angleDegrees:0,readingOrder:1};
  protectedRegion.sourceText.value='';protectedRegion.translatedText.value='';f.data.blocks.push(protectedRegion);
  f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:protectedRegion.regionId,rendererVersion:'pango-overflow-v2'});
  image.data.set([73,84,95,255],(231*image.width+64)*4);f.source=pixels.encode(image);return f;
}
async function previewAutomaticStrict(f:ReturnType<typeof fixture>,captured:{text:string;size:number}){
  const image=pixels.decode(f.source),probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon,otherSourcePolygons:f.data.blocks.slice(1).map(block=>block.geometry.polygon)});
  expect(probe.report.candidate).not.toBeNull();const safe=centeredBalloonBox(probe.report.candidate!,probe.report.sourceBounds)!;
  expect(safe).toEqual({left:280,top:77,width:84,height:104});
  await pixels.sharp({text:{text:captured.text,font:'Fixture '+captured.size,width:safe.width}}).rotate(f.data.blocks[0].geometry.angleDegrees).png().toBuffer();
  const strict=pixels.shapeCalls.at(-1)!;expect(strict.protection).toBe('strict');expect(strict.shapedWidth).toBeLessThanOrEqual(safe.width);expect(strict.shapedHeight).toBeLessThanOrEqual(safe.height);return strict;
}

function tallerCrossFixture(offset=0){
  const f=fixture(offset,'차분히 먼저 읽고 다시 골라'),image=pixels.frame(400+offset,300,[31,42,53,255]);
  for(let y=70;y<210;y++)for(let x=160+offset;x<230+offset;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);
  for(let y=105;y<175;y++)for(let x=120+offset;x<270+offset;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);
  f.data.blocks[0].geometry={...f.data.blocks[0].geometry,polygon:polygon(175+offset,80,40,120)};
  f.source=pixels.encode(image);return f;
}

it.each([0,127])('uses a taller safe alternative after the same-size primary strict height fails (offset %i)',async(offset)=>{
  const f=tallerCrossFixture(offset),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  pixels.shapeCalls.length=0;pixels.setWordMode('wide-strict-expands');const result=await render(f);
  const primary=pixels.shapeCalls.find(call=>call.protection==='strict'&&call.width===144&&call.size===20);
  expect(primary).toBeDefined();expect(primary!.shapedHeight).toBe(72);
  const alternative=pixels.shapeCalls.find(call=>call.protection==='strict'&&call.width===64&&call.size===20);
  expect(alternative).toBeDefined();expect(alternative!.shapedHeight).toBe(96);
  expect(result.layout.blocks[0].fontSizePx).toBe(20);expect(result.overlays[0].bounds.height).toBe(96);
  expect(baseline.overlays[0].bounds.height).toBe(120);expect(result.overlays[0].bytes).not.toEqual(baseline.overlays[0].bytes);
  expect(result.layout.blocks[0].glyphPixelsOutsidePolygon).toBe(0);expect(result.layout.blocks[0].glyphPixelsInsideOtherPolygons).toEqual([]);
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(baseline.bytes!,result.bytes!,{left:163+offset,top:73,width:64,height:134});
});

it('keeps a successful primary strict placement without shaping a taller alternative',async()=>{
  const f=tallerCrossFixture(),before=structuredClone(f.data),source=Buffer.from(f.source),result=await render(f);
  expect(pixels.shapeCalls.some(call=>call.protection==='strict'&&call.width===144)).toBe(true);
  expect(pixels.shapeCalls.some(call=>call.width===64)).toBe(false);expect(result.overlays[0].bounds.height).toBe(48);
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});

it('does not enter the taller path for a primary strict width failure',async()=>{
  const f=tallerCrossFixture(),baseline=await oldResult(f);pixels.shapeCalls.length=0;pixels.setWordMode('wide-strict-fails');
  const result=await render(f),primary=pixels.shapeCalls.find(call=>call.protection==='strict'&&call.width===144)!;
  expect(primary.shapedWidth).toBeGreaterThan(144);expect(primary.shapedHeight).toBeLessThanOrEqual(64);
  expect(pixels.shapeCalls.some(call=>call.width===64)).toBe(false);expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));
});

it('retains the captured layout when a taller alternative also exceeds its safe height',async()=>{
  const f=tallerCrossFixture(),baseline=await oldResult(f);pixels.shapeCalls.length=0;pixels.setWideStrictHeight(135);
  const result=await render(f);expect(pixels.shapeCalls.some(call=>call.protection==='strict'&&call.width===64)).toBe(true);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));
});

it('keeps the existing 1em protection when a height-failure alternative makes no final ink-height gain',async()=>{
  const f=tallerCrossFixture(),baseline=await oldResult(f);pixels.shapeCalls.length=0;pixels.setWideStrictHeight(120);
  const result=await render(f);expect(pixels.shapeCalls.some(call=>call.protection==='strict'&&call.width===64)).toBe(true);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));
});

it.each(['exact','user-box','captured-v2','rotated','vertical'] as const)('preserves %s without adding taller shaping',async(kind)=>{
  const f=tallerCrossFixture();const spec=f.data.renderSpecification!.blocks[0];
  if(kind==='exact')spec.sizing='EXACT';
  if(kind==='user-box')spec.typesetBox={left:175,top:80,width:40,height:120};
  if(kind==='captured-v2')spec.rendererVersion='pango-overflow-v2';
  if(kind==='rotated')f.data.blocks[0].geometry.angleDegrees=180;
  if(kind==='vertical')spec.targetOrientation='VERTICAL';
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  pixels.shapeCalls.length=0;pixels.setWordMode('wide-strict-expands');const result=await render(f);
  expect(pixels.shapeCalls.some(call=>call.width===64)).toBe(false);expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});

function pairedTallerFixture(){
  const first=tallerCrossFixture(),second=tallerCrossFixture(400),image=pixels.frame(900,300,[31,42,53,255]);
  for(const f of [first,second]){const raw=pixels.decode(f.source);for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++){const at=(y*raw.width+x)*4;if(raw.data[at]===255)image.data.set(raw.data.subarray(at,at+4),(y*image.width+x)*4);}}
  const other=structuredClone(second.data.blocks[0]);other.regionId='region-b';other.geometry.readingOrder=1;
  first.data.blocks.push(other);first.data.renderSpecification!.blocks.push({...second.data.renderSpecification!.blocks[0],regionId:other.regionId});
  first.source=pixels.encode(image);return first;
}

it('keeps a sibling placement when an earlier taller alternative is used or becomes unnecessary',async()=>{
  const f=pairedTallerFixture();f.data.blocks[1].translatedText.value='그럼 먼저 가요';pixels.setWordMode('wide-strict-expands');
  const first=await render(f),updated={source:f.source,data:structuredClone(f.data)};updated.data.blocks[0].translatedText.value='안녕';
  const second=await render(updated);
  expect(first.overlays.find(o=>o.regionId==='region-a')!.bounds.height).toBe(96);
  expect(second.overlays.find(o=>o.regionId==='region-b')).toEqual(first.overlays.find(o=>o.regionId==='region-b'));
  expect(second.layout.blocks.find(b=>b.regionId==='region-b')).toEqual(first.layout.blocks.find(b=>b.regionId==='region-b'));
  expect(first.layout.blocks[0]).not.toHaveProperty('strictHeightOverflow');expect(second.layout.blocks[0]).not.toHaveProperty('strictHeightOverflow');
});

it('rejects a provisional taller box that overlaps another frozen primary without changing either original placement',async()=>{
  const f=pairedTallerFixture();f.data.blocks[1].translatedText.value='조용히';pixels.setWordMode('wide-strict-expands');
  const control=vi.spyOn(balloonArea,'tallerBalloonTypesetBox').mockReturnValue(null);
  const baseline=await render(f);control.mockRestore();pixels.shapeCalls.length=0;
  // Inject a geometry-only conflict with the later primary. The helper's own
  // mask contract is tested separately; this verifies the renderer's freeze gate.
  const proposal=vi.spyOn(balloonArea,'tallerBalloonTypesetBox').mockReturnValueOnce({left:530,top:100,width:64,height:134}).mockReturnValue(null);
  try{const result=await render(f);expect(result).toEqual(baseline);expect(pixels.shapeCalls.some(call=>call.width===64)).toBe(false);}finally{proposal.mockRestore();}
});

it.each([334,374])('reserves allowed taller geometry independently of text at left %i, allowing only positive-area-free boxes',async(left)=>{
  const f=pairedTallerFixture();pixels.setWordMode('wide-strict-expands');
  const proposal=vi.spyOn(balloonArea,'tallerBalloonTypesetBox')
    .mockReturnValueOnce({left:310,top:73,width:64,height:134})
    .mockReturnValueOnce({left,top:73,width:64,height:134});
  try{
    const result=await render(f),first=result.overlays.find(o=>o.regionId==='region-a')!,second=result.overlays.find(o=>o.regionId==='region-b')!;
    expect(first.bounds.height).toBe(96);expect(second.bounds.height).toBe(left===374?96:120);
    expect(result.layout.blocks.every(block=>block.glyphPixelsInsideOtherPolygons.length===0)).toBe(true);
  }finally{proposal.mockRestore();}
});
const render=(f:ReturnType<typeof fixture>)=>renderPageDetailed(f.source,f.data,fonts,syntheticProfile);
async function oldResult(f:ReturnType<typeof fixture>){const old={source:f.source,data:structuredClone(f.data)};old.data.renderSpecification!.blocks[0].rendererVersion='pango-overflow-v2';return render(old);}
const withoutPolicy=(value:Awaited<ReturnType<typeof render>>)=>({bytes:value.bytes,overlays:value.overlays,layout:{...value.layout,rendererVersion:'IGNORED_POLICY',blocks:value.layout.blocks.map(m=>({...m,rendererVersion:'IGNORED_POLICY'}))}});
function expectUnchangedOutside(source:Buffer,output:Buffer,bounds:{left:number;top:number;width:number;height:number}){
  const before=pixels.decode(source),after=pixels.decode(output);expect(after.width).toBe(before.width);expect(after.height).toBe(before.height);
  for(let y=0;y<before.height;y++){
    const start=y*before.width*4,end=start+before.width*4;
    if(y<bounds.top||y>=bounds.top+bounds.height)expect(after.data.subarray(start,end)).toEqual(before.data.subarray(start,end));
    else{
      const left=start+bounds.left*4,right=start+(bounds.left+bounds.width)*4;
      expect(after.data.subarray(start,left)).toEqual(before.data.subarray(start,left));expect(after.data.subarray(right,end)).toEqual(before.data.subarray(right,end));
    }
  }
}
beforeEach(()=>pixels.reset());

it('reuses closed cleanup space with no smaller size, preserves source/user values, and keeps AI layout reviewable',async()=>{
  const f=fixture(),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f),result=await render(f);
  expect(result.layout.rendererVersion).toBe('pango-mixed-v3');
  expect(result.layout.blocks[0].fontSizePx).toBeGreaterThan(baseline.layout.blocks[0].fontSizePx);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.layout.qa).toBe('REVIEW_REQUIRED');
  expect(result.overlays[0].bounds.width).toBeGreaterThan(40);
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);
  expect(f.data.blocks[0].sourceText.status).toBe('USER_CONFIRMED');expect(f.data.blocks[0].translatedText.status).toBe('USER_MODIFIED');
  expect(f.data.renderSpecification!.blocks[0].typesetBox).toBeUndefined();
  const original=pixels.decode(f.source),output=pixels.decode(result.bytes!),bounds=result.overlays[0].bounds;
  for(let y=0;y<original.height;y++)for(let x=0;x<original.width;x++)if(x<bounds.left||x>=bounds.left+bounds.width||y<bounds.top||y>=bounds.top+bounds.height){
    const at=(y*original.width+x)*4;expect(output.data.subarray(at,at+4)).toEqual(original.data.subarray(at,at+4));
  }
});
it.each(['shrink','fallback'] as const)('preserves the entire captured layout and QA when the automatic candidate causes %s',async(mode)=>{
  const f=fixture(0,'안녕');f.data.blocks[0].geometry.polygon=polygon(180,120,40,60);
  pixels.setMode(mode);const baseline=await oldResult(f),result=await render(f);
  expect(baseline.layout.blocks[0].fontSizePx).toBe(20);expect(pixels.shapeCalls.some(c=>c.width!==undefined&&c.width>40)).toBe(true);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
});
it.each([
  {mode:'wide-strict-fails',baselineProtection:'strict'},
  {mode:'segment-only',baselineProtection:'segment'},
  {mode:'plain-only',baselineProtection:'plain'},
] as const)('preserves the finalized captured layout when the automatic area cannot safely protect whole words: $mode',async({mode,baselineProtection})=>{
  const f=fixture(53,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(233,120,40,60);
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode(mode);
  const baseline=await oldResult(f),baselineCalls=[...pixels.shapeCalls];pixels.shapeCalls.length=0;const result=await render(f);
  const captured=baselineCalls.find(c=>c.protection===baselineProtection&&c.width===40&&c.size===baseline.layout.blocks[0].fontSizePx)!;
  expect(captured).toBeDefined();expect(captured.shapedWidth).toBeLessThanOrEqual(40);expect(captured.shapedHeight).toBeLessThanOrEqual(60);
  expect(baseline.layout.blocks[0].fallbackAtMinimum).toBe(false);
  const widePlain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width!==undefined&&c.width>40&&c.size===20)!;
  const wideStrict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===widePlain.width&&c.size===widePlain.size)!;
  expect(widePlain).toBeDefined();expect(wideStrict).toBeDefined();
  expect(wideStrict.shapedWidth).toBeGreaterThan(wideStrict.width!);
  const wideSegment=pixels.shapeCalls.find(c=>c.protection==='segment'&&c.width===widePlain.width&&c.size===widePlain.size)!;
  expect(wideSegment).toBeDefined();
  if(mode==='plain-only')expect(wideSegment.shapedWidth).toBeGreaterThan(wideSegment.width!);
  else{expect(wideSegment.shapedWidth).toBeLessThanOrEqual(wideSegment.width!);expect(wideSegment.shapedHeight).toBeLessThanOrEqual(widePlain.shapedHeight);}
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
  expect(pixels.shapeCalls.some(c=>c.protection==='strict'&&c.width===40)).toBe(true);
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});
it.each(['centered','off-center'] as const)('uses safe automatic %s space for a taller strict layout without shrinking or changing source geometry',async(kind)=>{
  const f=fixture(47,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(227,120,40,60);
  const image=pixels.decode(f.source),protectedPoint={x:261,y:151};
  // One unknown pixel stays inside the source polygon and leaves >0.95 blank
  // coverage. Its padding excludes the right side of the anchored rectangle.
  if(kind==='off-center')image.data.set([73,84,95,255],(protectedPoint.y*image.width+protectedPoint.x)*4);
  f.source=pixels.encode(image);
  const probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon});
  const safe=probe.report.candidate!;expect(safe).not.toBeNull();expect(probe.report.sourceBlankCoverage).toBeGreaterThanOrEqual(.95);
  if(kind==='off-center')expect(centeredBalloonBox(safe,probe.report.sourceBounds)).toBeNull();
  else expect(centeredBalloonBox(safe,probe.report.sourceBounds)).not.toBeNull();
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode('wide-strict-expands');
  const baseline=await oldResult(f);pixels.shapeCalls.length=0;const result=await render(f);
  expect(result.layout.blocks[0].fontSizePx).toBeGreaterThan(baseline.layout.blocks[0].fontSizePx);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width!==undefined&&c.width>40&&c.size===20)!;
  const plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===strict.width&&c.size===strict.size)!;
  expect(strict.shapedWidth).toBeLessThanOrEqual(strict.width!);expect(strict.shapedHeight).toBeGreaterThan(plain.shapedHeight);
  expect(strict.shapedHeight).toBe(72);expect(strict.shapedHeight).toBeLessThanOrEqual(safe.height);
  expect(strict.text).toBe('<span allow_breaks="false">차분히</span> <span allow_breaks="false">먼저</span> <span allow_breaks="false">읽어</span>');
  const bounds=result.overlays[0].bounds;expect(bounds.height).toBe(strict.shapedHeight);
  expect(bounds.left).toBeGreaterThanOrEqual(safe.left);expect(bounds.top).toBeGreaterThanOrEqual(safe.top);
  expect(bounds.left+bounds.width).toBeLessThanOrEqual(safe.left+safe.width);expect(bounds.top+bounds.height).toBeLessThanOrEqual(safe.top+safe.height);
  expect(bounds.top+bounds.height/2).toBe(150);
  expect(bounds.left+bounds.width/2).toBe(kind==='off-center'?safe.left+safe.width/2:247);
  expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
  expect(f.data.renderSpecification!.blocks[0].typesetBox).toBeUndefined();expectUnchangedOutside(source,result.bytes!,bounds);
  if(kind==='off-center'){
    const at=(protectedPoint.y*image.width+protectedPoint.x)*4;
    expect(pixels.decode(result.bytes!).data.subarray(at,at+4)).toEqual(image.data.subarray(at,at+4));
  }
});
it('isolates the off-center geometry rejection with a strict automatic height no greater than the plain height',async()=>{
  const f=fixture(83,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(263,120,40,60);
  const image=pixels.decode(f.source),protectedPoint={x:297,y:151};image.data.set([73,84,95,255],(protectedPoint.y*image.width+protectedPoint.x)*4);f.source=pixels.encode(image);
  const probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon}),safe=probe.report.candidate!;
  expect(safe).not.toBeNull();expect(probe.report.sourceBlankCoverage).toBeGreaterThanOrEqual(.95);expect(centeredBalloonBox(safe,probe.report.sourceBounds)).toBeNull();
  pixels.setWordMode('narrow-strict-fails');
  const strictText='<span allow_breaks="false">차분히</span> <span allow_breaks="false">먼저</span> <span allow_breaks="false">읽어</span>';
  // A fake-only preview proves that the vertical footprint is already safe;
  // the old renderer never shapes this area because centered clipping rejects it.
  await pixels.sharp({text:{text:strictText,font:'Fixture 20',width:safe.width}}).png().toBuffer();const strictPreview=pixels.shapeCalls.at(-1)!;
  await pixels.sharp({text:{text:f.data.blocks[0].translatedText.value,font:'Fixture 20',width:safe.width}}).png().toBuffer();const plainPreview=pixels.shapeCalls.at(-1)!;
  expect(strictPreview.shapedHeight).toBe(48);expect(strictPreview.shapedHeight).toBeLessThanOrEqual(plainPreview.shapedHeight);expect(strictPreview.shapedWidth).toBeLessThanOrEqual(safe.width);
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);pixels.shapeCalls.length=0;const result=await render(f);
  expect(result.layout.blocks[0].fontSizePx).toBeGreaterThan(baseline.layout.blocks[0].fontSizePx);
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===safe.width&&c.size===20)!;
  expect(strict).toBeDefined();expect(strict.shapedHeight).toBeLessThanOrEqual(pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===safe.width&&c.size===20)!.shapedHeight);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.overlays[0].bounds.height).toBe(48);expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
  expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);const at=(protectedPoint.y*image.width+protectedPoint.x)*4;
  expect(pixels.decode(result.bytes!).data.subarray(at,at+4)).toEqual(image.data.subarray(at,at+4));
});
it.each(['captured-v2','unverified-v3','manual-v3','exact-v3'] as const)('preserves the plain vertical footprint for %s even when a taller strict rectangle fits its box',async(kind)=>{
  const f=fixture(31,'차분히 먼저 읽어'),spec=f.data.renderSpecification!.blocks[0],box={left:184,top:113,width:94,height:74};
  f.data.blocks[0].geometry.polygon=polygon(box.left,box.top,box.width,box.height);
  if(kind==='captured-v2')spec.rendererVersion='pango-overflow-v2';
  if(kind==='unverified-v3')f.data.cleanupQa='NOT_RUN';
  if(kind==='manual-v3'){f.data.blocks[0].geometry.polygon=polygon(211,120,40,60);spec.typesetBox={...box};}
  if(kind==='exact-v3')spec.sizing='EXACT';
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode('wide-strict-expands');const result=await render(f);
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===box.width&&c.size===20)!;
  const plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===box.width&&c.size===20)!;
  expect(strict).toBeDefined();expect(strict.shapedHeight).toBe(72);expect(plain.shapedHeight).toBe(48);expect(strict.shapedHeight).toBeLessThanOrEqual(box.height);
  expect(result.overlays[0].bounds).toEqual({left:184,top:126,width:94,height:48});
  expect(result.overlays[0].bytes).toEqual(pixels.encode(pixels.frame(94,48,[0,0,0,255])));
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.layout.qa).toBe('NOT_RUN');expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it('rejects a taller automatic strict result that exceeds the padded safe box while preserving the captured layout',async()=>{
  const f=fixture(73,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(253,120,40,60);
  const image=pixels.frame(473,300,[31,42,53,255]);for(let y=115;y<185;y++)for(let x=223;x<323;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);f.source=pixels.encode(image);
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode('wide-strict-expands');const baseline=await oldResult(f);pixels.shapeCalls.length=0;const result=await render(f);
  const probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon});
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width!==undefined&&c.width>40&&c.size===20)!;
  const plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===strict.width&&c.size===strict.size)!;
  expect(probe.report.candidate!.height).toBe(64);expect(plain.shapedHeight).toBe(48);expect(strict.shapedHeight).toBe(72);
  expect(strict.shapedHeight).toBeGreaterThan(probe.report.candidate!.height);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});
it.each(['centered','off-center'] as const)('keeps an already strict captured layout at the same font size despite available %s expansion',async(kind)=>{
  const f=fixture(61,'한 말');f.data.blocks[0].geometry.polygon=polygon(241,120,40,60);
  const image=pixels.decode(f.source);if(kind==='off-center')image.data.set([73,84,95,255],(151*image.width+275)*4);f.source=pixels.encode(image);
  const probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon});
  expect(probe.report.candidate).not.toBeNull();expect(probe.report.sourceBlankCoverage).toBeGreaterThanOrEqual(.95);
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode('wide-strict-expands');const baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;
  expect(captured).toBeDefined();expect(captured.shapedWidth).toBeLessThanOrEqual(40);expect(captured.shapedHeight).toBe(24);
  expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false});
  const result=await render(f);expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});
it('adopts an intact two-line strict candidate at the captured size when ordinary Hangul previously occupied three strict lines',async()=>{
  const f=strictCapturedFixture(),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;
  expect(captured).toBeDefined();expect(captured.shapedHeight).toBe(72);expect(captured.shapedHeight/24).toBe(3);
  expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphBounds:{height:72},glyphPixelsOutsidePolygon:0});
  pixels.shapeCalls.length=0;const result=await render(f);
  expect(result.overlays[0].bounds.height).toBe(48);const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===84&&c.size===20)!;
  expect(strict).toBeDefined();expect(strict.shapedHeight/24).toBe(2);expect(captured.shapedHeight-strict.shapedHeight).toBeGreaterThanOrEqual(20);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.overlays[0].bounds).toEqual({left:289,top:105,width:66,height:48});expect(result.layout.qa).toBe('REVIEW_REQUIRED');
  expect(result.overlays.some(overlay=>overlay.regionId==='protected-region')).toBe(false);
  const protectedAt=(231*527+64)*4;expect(pixels.decode(result.bytes!).data.subarray(protectedAt,protectedAt+4)).toEqual(Buffer.from([73,84,95,255]));
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expect(f.data.blocks[0].sourceText.status).toBe('USER_CONFIRMED');expect(f.data.blocks[0].translatedText.status).toBe('USER_MODIFIED');
  expect(f.data.renderSpecification!.blocks[0].typesetBox).toBeUndefined();expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it.each([72,96])('retains captured overlay, position and QA when the final same-size strict ink height is %ipx despite a shorter plain preview',async(height)=>{
  const f=strictCapturedFixture(),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;expect(captured.shapedHeight).toBe(72);
  pixels.setWideStrictHeight(height);const strict=await previewAutomaticStrict(f,captured);expect(strict.shapedHeight).toBeGreaterThanOrEqual(captured.shapedHeight);
  pixels.shapeCalls.length=0;const result=await render(f),plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===84&&c.size===20)!;
  expect(plain).toBeDefined();expect(plain.shapedHeight).toBe(48);expect(plain.shapedHeight).toBeLessThan(captured.shapedHeight);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it.each([24,23])('keeps an ordinary strict caption in place when the same-size final ink height is %ipx',async(height)=>{
  const f=fixture(113,'한 말');f.data.blocks[0].geometry.polygon=polygon(293,120,40,60);
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;expect(captured.shapedHeight).toBe(24);
  const image=pixels.decode(source),probe=findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,sourcePolygon:f.data.blocks[0].geometry.polygon});
  expect(probe.report.candidate).not.toBeNull();const safe=centeredBalloonBox(probe.report.candidate!,probe.report.sourceBounds)!;expect(safe).not.toBeNull();
  pixels.setWideStrictHeight(height);await pixels.sharp({text:{text:captured.text,font:'Fixture 20',width:safe.width}}).png().toBuffer();
  const strict=pixels.shapeCalls.at(-1)!;expect(strict.shapedHeight).toBe(height);expect(captured.shapedHeight-strict.shapedHeight).toBeLessThan(20);
  pixels.shapeCalls.length=0;const result=await render(f),plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===safe.width&&c.size===20)!;
  expect(plain).toBeDefined();expect(plain.shapedHeight).toBe(24);expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphBounds:{height:24}});
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it.each([
  {height:53,difference:19,adopted:false},
  {height:52,difference:20,adopted:true},
  {height:51,difference:21,adopted:true},
])('uses final strict ink height at the 1em boundary: $difference px shorter, adopted=$adopted',async({height,difference,adopted})=>{
  const f=strictCapturedFixture(),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;expect(captured.shapedHeight).toBe(72);
  // These are fake ink-height boundaries, not an actual line-count or quality measure.
  pixels.setWideStrictHeight(height);const strict=await previewAutomaticStrict(f,captured);expect(captured.shapedHeight-strict.shapedHeight).toBe(difference);
  pixels.shapeCalls.length=0;const result=await render(f),plain=pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===84&&c.size===20)!;
  expect(plain).toBeDefined();expect(plain.shapedHeight).toBe(48);expect(captured.shapedHeight-plain.shapedHeight).toBeGreaterThan(20);expect(strict.shapedHeight).toBeGreaterThan(plain.shapedHeight);
  if(adopted){
    expect(result.overlays[0].bounds.height).toBe(height);expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(result.overlays[0]).not.toEqual(baseline.overlays[0]);
    const finalStrict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===84&&c.size===20)!;expect(finalStrict).toBeDefined();expect(finalStrict.shapedHeight).toBe(height);
    expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  }else{expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');}
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it.each([180,-180])('retains a strict same-size captured layout at %i degrees even when final strict ink is more than 1em shorter',async(angle)=>{
  // The fake only reverses RGBA pixel tuples at +/-180; no native Sharp is used.
  const rotation=pixels.frame(2,1);rotation.data.set([11,22,33,255,44,55,66,128]);
  const reversed=pixels.decode(await pixels.sharp(pixels.encode(rotation)).rotate(angle).png().toBuffer() as Buffer);
  expect(reversed).toEqual({width:2,height:1,data:Buffer.from([44,55,66,128,11,22,33,255])});
  expect(()=>pixels.sharp(pixels.encode(rotation)).rotate(90)).toThrow('MOCK_ROTATION_UNSUPPORTED');
  const f=strictCapturedFixture(angle),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;
  expect(captured).toBeDefined();expect(captured.shapedHeight).toBe(72);expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,angleDegrees:angle,glyphBounds:{height:72},glyphPixelsOutsidePolygon:0});
  const strict=await previewAutomaticStrict(f,captured);expect(strict.shapedHeight).toBe(48);expect(captured.shapedHeight-strict.shapedHeight).toBeGreaterThan(20);
  const result=await render(f);expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it('still adopts a same-size automatic strict layout when an ordinary long token cannot fit the captured width',async()=>{
  const f=fixture(37,'차분하게');f.data.blocks[0].geometry.polygon=polygon(217,120,40,60);
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  const captured=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40&&c.size===20)!;expect(captured.shapedWidth).toBeGreaterThan(40);
  expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false});pixels.shapeCalls.length=0;const result=await render(f);
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width!==undefined&&c.width>40&&c.size===20)!;expect(strict).toBeDefined();
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.overlays[0].bounds.height).toBe(strict.shapedHeight);expect(result.overlays[0].bytes).not.toEqual(baseline.overlays[0].bytes);
  expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it('adopts the finalized strict automatic layout when captured strict protection fails, while preserving inputs',async()=>{
  const f=fixture(89,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(269,120,40,60);
  const before=structuredClone(f.data),source=Buffer.from(f.source);pixels.setWordMode('narrow-strict-fails');
  const baseline=await oldResult(f);pixels.shapeCalls.length=0;const result=await render(f);
  const narrowStrict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===40)!;
  const wideStrict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width!==undefined&&c.width>40&&c.size===20)!;
  expect(narrowStrict).toBeDefined();expect(narrowStrict.shapedWidth).toBeGreaterThan(40);
  expect(wideStrict).toBeDefined();expect(wideStrict.shapedWidth).toBeLessThanOrEqual(wideStrict.width!);
  expect(result.layout.blocks[0].fontSizePx).toBeGreaterThan(baseline.layout.blocks[0].fontSizePx);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.overlays[0].bounds.height).toBe(wideStrict.shapedHeight);
  expect(result.overlays[0].bounds.height).toBeLessThan(pixels.shapeCalls.find(c=>c.protection==='plain'&&c.width===wideStrict.width&&c.size===wideStrict.size)!.shapedHeight);
  expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});
it('keeps explicit newlines and escaped user markup inside whole Hangul tokens without mutating text',async()=>{
  const f=fixture(69,"가&\n나<'\">");f.data.cleanupQa='NOT_RUN';f.data.blocks[0].geometry.polygon=polygon(239,124,60,52);
  const before=structuredClone(f.data),source=Buffer.from(f.source),result=await render(f);
  const strict=pixels.shapeCalls.find(c=>c.protection==='strict')!;
  expect(strict).toBeDefined();expect(strict.text).toBe('<span allow_breaks="false">가&amp;</span>\n<span allow_breaks="false">나&lt;&apos;&quot;&gt;</span>');
  expect(strict.visibleText).toBe(f.data.blocks[0].translatedText.value);
  expect(strict.shapedHeight).toBe(48);expect(result.overlays[0].bounds.height).toBe(48);
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.layout.qa).toBe('NOT_RUN');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});
it.each(['NOT_RUN','FAILED'] as const)('does not infer unverified cleanup space when cleanup QA is %s',async(qa)=>{
  const f=fixture();f.data.cleanupQa=qa;const baseline=await oldResult(f);pixels.shapeCalls.length=0;const result=await render(f);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(pixels.shapeCalls.filter(c=>!c.text.includes('<span')).every(c=>c.width===40)).toBe(true);
});
it.each(['exact','user-box','vertical','no-hangul'] as const)('keeps the existing %s rendering policy and user geometry',async(kind)=>{
  const f=fixture(),spec=f.data.renderSpecification!.blocks[0];
  if(kind==='exact')spec.sizing='EXACT';
  if(kind==='user-box')spec.typesetBox={left:175,top:125,width:50,height:50};
  if(kind==='vertical')f.data.blocks[0].geometry.orientation='VERTICAL';
  if(kind==='no-hangul')f.data.blocks[0].translatedText.value='普通の日本語';
  const before=structuredClone(f.data),baseline=await oldResult(f),result=await render(f);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(f.data).toEqual(before);
});
it.each(['open','dark','shared'] as const)('retains captured glyphs for unsafe %s cleanup space',async(kind)=>{
  const f=fixture();if(kind==='open'||kind==='dark'){
    const image=pixels.decode(f.source);image.data.fill(kind==='open'?255:30);f.source=pixels.encode(image);
  }else{
    const other=structuredClone(f.data.blocks[0]);other.regionId='region-b';other.geometry={...other.geometry,polygon:polygon(158,138,12,24),readingOrder:1};other.sourceText.value='';other.translatedText.value='';
    f.data.blocks.push(other);f.data.renderSpecification!.blocks.push({regionId:other.regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-balloon-v3'});
  }
  const old={source:f.source,data:structuredClone(f.data)};for(const s of old.data.renderSpecification!.blocks)s.rendererVersion='pango-overflow-v2';
  expect(withoutPolicy(await render(f))).toEqual(withoutPolicy(await render(old)));
});
it('replays the same persisted policy after edit/save/recovery and leaves other glyphs unchanged when one text changes',async()=>{
  const f=fixture(),image=pixels.decode(f.source);for(let y=205;y<280;y++)for(let x=150;x<250;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);f.source=pixels.encode(image);
  const other=structuredClone(f.data.blocks[0]);other.regionId='region-b';other.geometry={...other.geometry,polygon:polygon(180,230,40,24),readingOrder:1};other.translatedText.value='다른 대사를 보존합니다';
  f.data.blocks.push(other);f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:other.regionId});
  const first=await render(f),restored={source:Buffer.from(f.source),data:JSON.parse(JSON.stringify(f.data)) as EditData};
  expect(await render(restored)).toEqual(first);
  f.data.blocks[0].translatedText.value='안녕';const edited=await render(f);
  expect(edited.overlays.find(o=>o.regionId==='region-b')).toEqual(first.overlays.find(o=>o.regionId==='region-b'));
  expect(edited.layout.blocks.find(b=>b.regionId==='region-b')).toEqual(first.layout.blocks.find(b=>b.regionId==='region-b'));
  expect(f.data.renderSpecification!.blocks[0].rendererVersion).toBe('pango-balloon-v3');
});
it.each([7,21,37])('uses geometry and cleanup pixels rather than a sample name/hash at a new source offset %i',async(offset)=>{
  const f=fixture(offset),result=await render(f);expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(result.layout.blocks[0].fontSizePx).toBe(20);
  expect(result.overlays[0].bounds.left+result.overlays[0].bounds.width/2).toBeCloseTo(200+offset,0);
});


it('keeps a tiny legal source region from blocking the normal region on the same page',async()=>{
  const f=fixture(),tiny=structuredClone(f.data.blocks[0]);tiny.regionId='tiny-region';tiny.geometry={...tiny.geometry,polygon:polygon(10.1,10.1,.1,.1),readingOrder:-1};tiny.sourceText.value='';tiny.translatedText.value='';
  f.data.blocks.push(tiny);f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:tiny.regionId});
  const before=structuredClone(f.data),result=await render(f);expect(result.bytes).not.toBeNull();expect(result.overlays).toHaveLength(1);expect(result.overlays[0].regionId).toBe('region-a');expect(f.data).toEqual(before);
});
it('preserves a v2 sibling overlay when the preceding v3 candidate changes from adoption to rejection',async()=>{
  // This ordinary token needs character wrapping in the 40px captured area,
  // so a same-size strict automatic candidate provides an actual improvement.
  const f=fixture(0,'차분하게');f.data.blocks[0].geometry.polygon=polygon(180,120,40,60);const image=pixels.decode(f.source);
  for(let y=205;y<280;y++)for(let x=150;x<250;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);f.source=pixels.encode(image);
  const sibling=structuredClone(f.data.blocks[0]);sibling.regionId='v2-sibling';sibling.geometry={...sibling.geometry,polygon:polygon(180,215,40,60),readingOrder:1};sibling.translatedText.value='다른 대사';f.data.blocks.push(sibling);
  f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:sibling.regionId,rendererVersion:'pango-overflow-v2'});
  const adopted=await render(f);expect(adopted.layout.qa).toBe('REVIEW_REQUIRED');pixels.setMode('shrink');const rejected=await render(f);
  expect(rejected.overlays.find(o=>o.regionId==='v2-sibling')).toEqual(adopted.overlays.find(o=>o.regionId==='v2-sibling'));
  expect(rejected.layout.blocks.find(b=>b.regionId==='v2-sibling')).toEqual(adopted.layout.blocks.find(b=>b.regionId==='v2-sibling'));expect(rejected.layout.qa).toBe('NOT_RUN');
});
it.each(['pango-overflow-v2','pango-balloon-v3'] as const)('preserves a %s sibling when the preceding automatic layout loses strict word protection',async(rendererVersion)=>{
  const f=fixture(53,'차분히 먼저 읽어');f.data.blocks[0].geometry.polygon=polygon(233,120,40,60);
  const image=pixels.decode(f.source);for(let y=205;y<280;y++)for(let x=203;x<303;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);f.source=pixels.encode(image);
  const sibling=structuredClone(f.data.blocks[0]);sibling.regionId='untouched-sibling';sibling.geometry={...sibling.geometry,polygon:polygon(233,215,40,60),readingOrder:1};sibling.translatedText.value='이 말';f.data.blocks.push(sibling);
  f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:sibling.regionId,rendererVersion});
  const adopted=await render(f);expect(adopted.layout.blocks[0].fontSizePx).toBe(20);
  // A longer ordinary token is still accepted by plain/segment shaping at 20px,
  // but its strict glyph width exceeds the inferred cleanup area.
  f.data.blocks[0].translatedText.value='아주긴어절을포함하여 여기 적어';
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f),rejected=await render(f);
  expect(rejected.overlays.find(o=>o.regionId==='region-a')).toEqual(baseline.overlays.find(o=>o.regionId==='region-a'));
  expect({...rejected.layout.blocks[0],rendererVersion:'IGNORED_POLICY'}).toEqual({...baseline.layout.blocks[0],rendererVersion:'IGNORED_POLICY'});
  expect(rejected.overlays.find(o=>o.regionId===sibling.regionId)).toEqual(adopted.overlays.find(o=>o.regionId===sibling.regionId));
  expect(rejected.layout.blocks.find(b=>b.regionId===sibling.regionId)).toEqual(adopted.layout.blocks.find(b=>b.regionId===sibling.regionId));
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);
});

function shorterWideFixture(offset=19){
  const f=fixture(offset,'차분히 먼저 읽어');
  // The closed white component covers this tall source, but its existing 3px
  // padding makes the safe area shorter. No page-specific correction is used.
  f.data.blocks[0].geometry.polygon=polygon(180+offset,110,40,80);
  return f;
}
function shorterWideProbe(f:ReturnType<typeof fixture>){
  const image=pixels.decode(f.source);
  return findBalloonCandidate({rgba:image.data,width:image.width,height:image.height,
    sourcePolygon:f.data.blocks[0].geometry.polygon,
    otherSourcePolygons:f.data.blocks.slice(1).map(block=>block.geometry.polygon),
    userTypesetBoxes:f.data.renderSpecification!.blocks.flatMap(spec=>spec.typesetBox?[spec.typesetBox]:[])});
}
it.each([19,43])('uses wider shorter safe space at offset %i without reducing the captured font or editing source/user values',async(offset)=>{
  const f=shorterWideFixture(offset),before=structuredClone(f.data),source=Buffer.from(f.source),probe=shorterWideProbe(f);
  expect(probe.report).toMatchObject({sourceBlankCoverage:1,candidate:{width:94,height:74,collisionPixels:0}});
  expect(centeredBalloonBox(probe.report.candidate!,probe.report.sourceBounds)).toBeNull();
  const baseline=await oldResult(f);expect(baseline.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphBounds:{height:72}});
  pixels.shapeCalls.length=0;const result=await render(f),strict=pixels.shapeCalls.find(c=>c.protection==='strict'&&c.width===94&&c.size===20)!;
  expect(strict).toBeDefined();expect(strict.shapedWidth).toBe(94);expect(strict.shapedHeight).toBe(24);
  expect(result.overlays[0].bounds).toEqual({left:153+offset,top:138,width:94,height:24});
  expect(result.layout.blocks[0]).toMatchObject({fontSizePx:20,fallbackAtMinimum:false,glyphPixelsOutsidePage:0,glyphPixelsOutsidePolygon:0,glyphPixelsInsideOtherPolygons:[]});
  expect(result.layout.qa).toBe('REVIEW_REQUIRED');expect(f.data).toEqual(before);expect(f.source).toEqual(source);
  expect(f.data.blocks[0].sourceText.status).toBe('USER_CONFIRMED');expect(f.data.blocks[0].translatedText.status).toBe('USER_MODIFIED');
  expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it.each(['shrink','fallback','strict-failure','strict-overflow'] as const)('keeps the captured result when a wider shorter candidate causes %s',async(mode)=>{
  const f=shorterWideFixture(),before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  if(mode==='shrink'||mode==='fallback')pixels.setMode(mode);
  if(mode==='strict-failure')pixels.setWordMode('wide-strict-fails');
  if(mode==='strict-overflow')pixels.setWideStrictHeight(75);
  pixels.shapeCalls.length=0;const result=await render(f);
  expect(pixels.shapeCalls.some(c=>c.width===94)).toBe(true);
  if(mode==='shrink')expect(pixels.shapeCalls.some(c=>c.width===94&&c.size<20)).toBe(true);
  if(mode==='fallback')expect(pixels.shapeCalls.some(c=>c.width===94&&c.size===10)).toBe(true);
  if(mode==='strict-failure'||mode==='strict-overflow')expect(pixels.shapeCalls.some(c=>c.width===94&&c.protection==='strict')).toBe(true);
  expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
  expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
});
it('keeps the captured overlay when a fault-injected automatic box would collide with another source polygon',async()=>{
  const f=shorterWideFixture(0),other=structuredClone(f.data.blocks[0]);other.regionId='collision-obstacle';
  other.geometry={...other.geometry,polygon:polygon(240,130,20,40),readingOrder:1};other.sourceText.value='';other.translatedText.value='';
  f.data.blocks.push(other);f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:other.regionId,rendererVersion:'pango-overflow-v2'});
  const before=structuredClone(f.data),source=Buffer.from(f.source),baseline=await oldResult(f);
  // Inject unsafe geometry only to test the renderer's independent glyph check;
  // this is not a claim that the real padded candidate overlaps obstacles.
  const spy=vi.spyOn(balloonArea,'balloonTypesetBox').mockReturnValue({left:153,top:113,width:94,height:74});
  try{
    pixels.shapeCalls.length=0;const result=await render(f);
    expect(pixels.shapeCalls.some(c=>c.protection==='plain'&&c.width===94&&c.size===20)).toBe(true);
    expect(pixels.shapeCalls.some(c=>c.protection==='strict'&&c.width===94)).toBe(false);
    expect(withoutPolicy(result)).toEqual(withoutPolicy(baseline));expect(result.layout.qa).toBe('NOT_RUN');
    expect(f.data).toEqual(before);expect(f.source).toEqual(source);expectUnchangedOutside(source,result.bytes!,result.overlays[0].bounds);
  }finally{spy.mockRestore();}
});
it.each((['v2','v3','exact','user-box'] as const).flatMap(kind=>
  (['shrink','fallback','strict-failure','strict-overflow'] as const).map(mode=>({kind,mode}))))('preserves an adjacent $kind sibling when the new shorter safe candidate is reserved but rejected for $mode',async({kind,mode})=>{
  const f=shorterWideFixture(0),image=pixels.decode(f.source),sibling=structuredClone(f.data.blocks[0]);
  for(let y=113;y<189;y++)for(let x=260;x<354;x++)image.data.set([255,255,255,255],(y*image.width+x)*4);
  sibling.regionId='adjacent-sibling';sibling.geometry={...sibling.geometry,polygon:polygon(270,121,40,60),readingOrder:1};sibling.translatedText.value='정상 대사';
  f.data.blocks.push(sibling);f.data.renderSpecification!.blocks.push({...f.data.renderSpecification!.blocks[0],regionId:sibling.regionId,
    rendererVersion:kind==='v2'?'pango-overflow-v2':'pango-balloon-v3',
    ...(kind==='exact'?{sizing:'EXACT' as const}:{}),...(kind==='user-box'?{typesetBox:{left:268,top:121,width:40,height:60}}:{})});
  f.source=pixels.encode(image);const before=structuredClone(f.data),source=Buffer.from(f.source),probe=shorterWideProbe(f);
  expect(probe.report.candidate).not.toBeNull();expect(probe.report.candidate!.height).toBeLessThan(probe.report.sourceBounds.height);
  const control={source:f.source,data:structuredClone(f.data)};control.data.renderSpecification!.blocks[0].rendererVersion='pango-overflow-v2';
  if(mode==='shrink'||mode==='fallback')pixels.setMode(mode);
  if(mode==='strict-failure')pixels.setWordMode('wide-strict-fails');
  if(mode==='strict-overflow')pixels.setWideStrictHeight(75);
  const baseline=await render(control);pixels.shapeCalls.length=0;const rejected=await render(f);
  expect(pixels.shapeCalls.some(c=>c.width===94)).toBe(true);
  expect(rejected.overlays.find(o=>o.regionId==='region-a')).toEqual(baseline.overlays.find(o=>o.regionId==='region-a'));
  expect(rejected.overlays.find(o=>o.regionId===sibling.regionId)).toEqual(baseline.overlays.find(o=>o.regionId===sibling.regionId));
  expect(rejected.layout.blocks.find(b=>b.regionId===sibling.regionId)).toEqual(baseline.layout.blocks.find(b=>b.regionId===sibling.regionId));
  expect(withoutPolicy(rejected)).toEqual(withoutPolicy(baseline));expect(f.data).toEqual(before);expect(f.source).toEqual(source);
  for(const overlay of rejected.overlays)expectUnchangedOutside(baseline.bytes!,rejected.bytes!,overlay.bounds);
});
