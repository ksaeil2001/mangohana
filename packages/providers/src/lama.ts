import sharp from 'sharp';
import {decodeImage} from '../../media/src/images.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
export const lamaCodeCommit='786f5936b27fb3dacd2b1ad799e4de968ea697e7';
export type LaMaIdentity={codeCommit:typeof lamaCodeCommit;weightsSha256:string;configSha256:string;weightsLicenseVerified:boolean;runtimeVerified:boolean};
async function checkedMask(image:Buffer,mask:Buffer,profile:MediaProfile){const source=await decodeImage(image,profile);const maskImage=await decodeImage(mask,profile);requireCondition(maskImage.width===source.width&&maskImage.height===source.height&&maskImage.mediaType==='image/png','MASK_INVALID',422);const pixels=await sharp(maskImage.canonicalPng).ensureAlpha().raw().toBuffer();for(let i=0;i<pixels.length;i+=4){const value=pixels[i];requireCondition((value===0||value===255)&&pixels[i+1]===value&&pixels[i+2]===value&&pixels[i+3]===255,'MASK_INVALID',422);}return {source,maskImage,pixels};}
export async function compositeMaskedPixels(original:Buffer,mask:Buffer,proposal:Buffer,profile:MediaProfile):Promise<{png:Buffer;outsideChangedPixels:0;maskSha256:string}>{
  const {source,pixels:selection}=await checkedMask(original,mask,profile);const candidate=await decodeImage(proposal,profile);
  requireCondition(candidate.width===source.width&&candidate.height===source.height,'CLEANUP_OUTPUT_INVALID',422);
  const raw=await sharp(source.canonicalPng).ensureAlpha().raw().toBuffer();const replacement=await sharp(candidate.canonicalPng).ensureAlpha().raw().toBuffer();const composed=Buffer.from(raw);
  for(let i=0;i<raw.length;i+=4){const value=selection[i];requireCondition((value===0||value===255)&&selection[i+1]===value&&selection[i+2]===value&&selection[i+3]===255,'MASK_INVALID',422);if(value===255)replacement.copy(composed,i,i,i+4);}
  const png=await sharp(composed,{raw:{width:source.width,height:source.height,channels:4}}).png().toBuffer();const verified=await sharp(png).ensureAlpha().raw().toBuffer();
  for(let i=0;i<raw.length;i+=4)if(selection[i]===0)requireCondition(verified.subarray(i,i+4).equals(raw.subarray(i,i+4)),'CLEANUP_OUTSIDE_CHANGED',422);
  return {png,outsideChangedPixels:0,maskSha256:sha256(mask)};
}
export class LaMaAdapter{
  constructor(private readonly options:{enabled:boolean;identity:LaMaIdentity;profile:MediaProfile;transport:(input:{image:Buffer;mask:Buffer;identity:LaMaIdentity})=>Promise<Buffer>}){}
  async dispatch(image:Buffer,mask:Buffer){const identity=this.options.identity;if(!this.options.enabled||identity.codeCommit!==lamaCodeCommit||!identity.weightsLicenseVerified||!identity.runtimeVerified||!this.options.profile.enabled||this.options.profile.kind!=='MEASURED'||!/^([0-9a-f]{64})$/.test(identity.weightsSha256)||!/^([0-9a-f]{64})$/.test(identity.configSha256))return {state:'NOT_STARTED' as const,reason:'CLEANUP_ACTIVATION_GATE'};
    try{await checkedMask(image,mask,this.options.profile);}catch{return {state:'NOT_STARTED' as const,reason:'CLEANUP_INPUT_REJECTED'};}let output:Buffer;try{output=await this.options.transport({image,mask,identity});}catch{return {state:'UNKNOWN' as const,reason:'CLEANUP_TRANSPORT_UNCONFIRMED'};}
    try{const result=await compositeMaskedPixels(image,mask,output,this.options.profile);return {state:'SUCCEEDED' as const,providerSuccess:true,backgroundQa:'NEEDS_REVIEW' as const,...result,identity};}catch{return {state:'FAILED' as const,providerSuccess:true,backgroundQa:'FAILED' as const,reason:'CLEANUP_OUTPUT_INVALID'};}}
}
