import sharp from 'sharp';
import { requireCondition } from '../../contracts/src/errors.js';
import type { MediaProfile } from './profile.js';
import { requireProfile } from './profile.js';

export type DecodedImage={width:number;height:number;mediaType:'image/png'|'image/jpeg';canonicalPng:Buffer};
export async function decodeImage(bytes:Buffer,profile:MediaProfile):Promise<DecodedImage> {
  requireProfile(profile);requireCondition(bytes.length>0&&bytes.length<=profile.maxImageBytes,'INPUT_INVALID',422);
  const image=sharp(bytes,{failOn:'warning',limitInputPixels:profile.maxPixels,animated:false,sequentialRead:true});const metadata=await image.metadata();
  requireCondition(['png','jpeg'].includes(metadata.format??'')&&(!metadata.pages||metadata.pages===1),'INPUT_INVALID',422);
  // APNG is refused even if a particular decoder exposes only its first frame.
  if(metadata.format==='png') {let at=8;while(at+12<=bytes.length){const length=bytes.readUInt32BE(at);requireCondition(length<=bytes.length-at-12,'INPUT_INVALID',422);requireCondition(bytes.toString('ascii',at+4,at+8)!=='acTL','INPUT_INVALID',422);at+=length+12;}}
  const swapped=[5,6,7,8].includes(metadata.orientation??0);const width=swapped?metadata.height:metadata.width;const height=swapped?metadata.width:metadata.height;
  requireCondition(width&&height&&width<=profile.maxWidth&&height<=profile.maxHeight&&width*height<=profile.maxPixels,'INPUT_INVALID',422);
  const {data,info}=await image.autoOrient().toColourspace('srgb').ensureAlpha().png({compressionLevel:6}).toBuffer({resolveWithObject:true});
  requireCondition(info.width===width&&info.height===height,'INPUT_INVALID',422);return {width,height,mediaType:metadata.format==='png'?'image/png':'image/jpeg',canonicalPng:data};
}
