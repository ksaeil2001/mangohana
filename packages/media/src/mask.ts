import sharp from 'sharp';
import type {MediaProfile} from './profile.js';
import {requireCondition} from '../../contracts/src/errors.js';
export async function binaryPolygonMask(polygons:{x:number;y:number}[][],width:number,height:number,profile:MediaProfile):Promise<{png:Buffer;pixels:Buffer}>{
  requireCondition(profile.enabled&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=profile.maxWidth&&height<=profile.maxHeight&&width*height<=profile.maxPixels&&polygons.length<=profile.maxBlocks,'SCOPE_INVALID',422);
  const shapes=polygons.map(polygon=>{requireCondition(polygon.length>=3&&polygon.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<=width&&point.y<=height),'SCOPE_INVALID',422);return `<polygon points="${polygon.map(point=>`${point.x},${point.y}`).join(' ')}" fill="white"/>`;}).join('');
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${shapes}</svg>`);
  const png=await sharp(svg).greyscale().threshold(1).png().toBuffer();return {png,pixels:await sharp(png).removeAlpha().greyscale().raw().toBuffer()};
}
