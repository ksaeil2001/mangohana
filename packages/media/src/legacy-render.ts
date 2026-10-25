import sharp, { type OverlayOptions } from 'sharp';
import { requireCondition } from '../../contracts/src/errors.js';
import type { EditData } from '../../domain/src/model.js';
import type { MediaProfile } from './profile.js';
import { decodeImage } from './images.js';
import type { FontCatalog } from './fonts.js';

export const escapeMarkup=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export async function legacyRenderPage(source:Buffer,data:EditData,fonts:FontCatalog,profile:MediaProfile,minFontSize=1):Promise<Buffer> {
  const decoded=await decodeImage(source,profile);let base=decoded.canonicalPng;
  requireCondition(data.blocks.length<=profile.maxBlocks&&['source-pixels-v1','synthetic-v1'].includes(data.geometryContract)&&['pango-canonical-v1','synthetic-v1'].includes(data.renderContract),'RENDER_FAILED',422);
  for(const block of [...data.blocks].sort((a,b)=>a.geometry.readingOrder-b.geometry.readingOrder)) {
    const specification=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);
    const minimum=specification?.sizing==='EXACT'?block.fontSizePx:specification?.minimumFontSizePx??minFontSize;
    const text=block.translatedText.value||block.sourceText.value;if(!text)continue;
    requireCondition(text.length<=profile.maxTextLength&&fonts.covers(block.fontAssetId,text),'RENDER_FAILED',422);
    const polygon=block.geometry.polygon;for(const p of polygon)requireCondition(Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<=decoded.width&&p.y<=decoded.height,'RENDER_FAILED',422);
    const left=Math.floor(Math.min(...polygon.map(p=>p.x)));const top=Math.floor(Math.min(...polygon.map(p=>p.y)));const width=Math.ceil(Math.max(...polygon.map(p=>p.x)))-left;const height=Math.ceil(Math.max(...polygon.map(p=>p.y)))-top;
    requireCondition(width>0&&height>0&&Number.isFinite(block.fontSizePx)&&block.fontSizePx>0&&block.fontSizePx<=profile.maxFontSize&&Number.isFinite(minimum)&&minimum>0&&minimum<=block.fontSizePx,'RENDER_FAILED',422);
    const font=fonts.font(block.fontAssetId);let overlay:Buffer|null=null;
    const sizes:number[]=[block.fontSizePx];
    if(specification?.sizing!=='EXACT')while(sizes.at(-1)! > minimum)sizes.push(Math.max(minimum,sizes.at(-1)!-1));
    for(const size of sizes) {
      if(block.geometry.orientation==='HORIZONTAL') {
        const rendered=await sharp({text:{text:escapeMarkup(text),font:`${font.family} ${size}`,fontfile:fonts.file(font.id),width,align:'center',dpi:72,rgba:true,wrap:'word-char'}}).png().toBuffer({resolveWithObject:true});
        if(rendered.info.height>height||rendered.info.width>width)continue;
        overlay=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite([{input:rendered.data,left:Math.floor((width-rendered.info.width)/2),top:Math.floor((height-rendered.info.height)/2)}]).png().toBuffer();
      } else {
        const rows=Math.floor(height/(size*1.15));const columns=Math.floor(width/(size*1.15));if(rows<1||columns<1)continue;
        const segments=Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(text)).map(s=>s.segment);let column=0;let row=0;const positions:{char:string;x:number;y:number}[]=[];
        for(const char of segments){if(char==='\n'){column++;row=0;continue;}if(row>=rows){column++;row=0;}positions.push({char,x:width-Math.ceil((column+1)*size*1.15),y:Math.floor(row++*size*1.15)});}
        if(column>=columns)continue;
        const layers:OverlayOptions[]=[];for(const position of positions){const glyph=await sharp({text:{text:escapeMarkup(position.char),font:`${font.family} ${size}`,fontfile:fonts.file(font.id),rgba:true,dpi:72}}).png().toBuffer({resolveWithObject:true});if(glyph.info.width>size*1.15||glyph.info.height>size*1.15){layers.length=0;break;}layers.push({input:glyph.data,left:position.x,top:position.y});}
        if(!layers.length&&positions.length)continue;overlay=await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(layers).png().toBuffer();
      }
      break;
    }
    requireCondition(overlay,'RENDER_FAILED',422);
    if(block.geometry.angleDegrees!==0){requireCondition(Number.isFinite(block.geometry.angleDegrees)&&Math.abs(block.geometry.angleDegrees)<=180,'RENDER_FAILED',422);overlay=await sharp(overlay).rotate(block.geometry.angleDegrees,{background:'#00000000'}).resize(width,height,{fit:'contain',background:'#00000000'}).png().toBuffer();}
    const points=polygon.map(p=>`${p.x-left},${p.y-top}`).join(' ');const mask=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polygon points="${points}" fill="white"/></svg>`);
    overlay=await sharp(overlay).composite([{input:mask,blend:'dest-in'}]).png().toBuffer();base=await sharp(base).composite([{input:overlay,left,top}]).png({compressionLevel:6}).toBuffer();
  }
  return sharp(base).png({compressionLevel:6}).toBuffer();
}
