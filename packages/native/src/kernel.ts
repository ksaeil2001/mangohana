import {mkdir,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {requireCondition} from '../../contracts/src/errors.js';
import {decodeImage} from '../../media/src/images.js';
import {FontCatalog} from '../../media/src/fonts.js';
import {renderPageDetailed} from '../../media/src/render.js';
import {binaryPolygonMask} from '../../media/src/mask.js';
import {readZip,writeZip} from '../../media/src/zip.js';
import {syntheticCleanup} from '../../domain/src/image-pipeline.js';
import {compositeMaskedPixels} from '../../providers/src/lama.js';
import {prepareScopedMaterial,applyScopedProposal} from '../../providers/src/gemini-material.js';
import type {NativeComputation,NativeJob} from './dto.js';
import {verifyNativeInput} from './dto.js';
import type {NativeFrame} from './frame.js';
import {validateNativeInput,validateNativeJob,type NativeFontBundle} from './jobs.js';

async function privateFonts(bundle:NativeFontBundle,blobs:Map<string,Buffer>,privateJobDirectory:string):Promise<FontCatalog>{
  const parent=await lstat(privateJobDirectory);requireCondition(parent.isDirectory()&&!parent.isSymbolicLink(),'INPUT_DEPENDENCY_INVALID',409,'WAIT');
  const root=path.join(privateJobDirectory,'fonts');await mkdir(root,{mode:0o700});
  await writeFile(path.join(root,'catalog.json'),JSON.stringify(bundle.catalog),{flag:'wx',mode:0o600});
  for(const dependency of [...bundle.catalog.fonts,bundle.catalog.license]){
    const reference=bundle.blobs.find(item=>item.id===dependency.id)!;
    // The closed, pinned catalog was validated before any job-directory write.
    await writeFile(path.join(root,dependency.file),blobs.get(reference.blobId)!,{flag:'wx',mode:0o600});
  }
  return FontCatalog.load(root);
}
function pngDimensions(bytes:Buffer):{width:number;height:number}{
  requireCondition(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR','NATIVE_OUTPUT_INVALID',409,'WAIT');
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
// This module is imported by the fixed child only after its controller's GO.
// It never owns storage publication, credentials, stage dispatch, approval or account state.
export async function compute(job:NativeFrame<NativeJob>,privateJobDirectory:string):Promise<NativeComputation>{
  verifyNativeInput(job.envelope);validateNativeJob(job);const output=new Map<string,Buffer>();
  const add=(id:string,bytes:Buffer)=>{output.set(id,bytes);return {blobId:id,byteLength:bytes.length};};
  switch(job.envelope.task){
    case 'DECODE_IMAGE':{const input=validateNativeInput('DECODE_IMAGE',job.envelope.metadata,job.blobs,job.envelope.profileDigest),decoded=await decodeImage(job.blobs.get(input.sourceBlobId)!,input.profile),png=add('canonical-png',decoded.canonicalPng);return {metadata:{width:decoded.width,height:decoded.height,mediaType:decoded.mediaType,canonicalPngBlobId:png.blobId,canonicalPngByteLength:png.byteLength},blobs:output};}
    case 'RENDER_PAGE':{const input=validateNativeInput('RENDER_PAGE',job.envelope.metadata,job.blobs,job.envelope.profileDigest),fonts=await privateFonts(input.fonts,job.blobs,privateJobDirectory),result=await renderPageDetailed(job.blobs.get(input.sourceBlobId)!,input.data,fonts,input.profile,input.minimumFontSizePx),render=result.bytes?add('render',result.bytes):null;
      const overlays=result.overlays.map((item,index)=>({...add('overlay-'+index,item.bytes),regionId:item.regionId,bounds:item.bounds}));return {metadata:{layout:result.layout,bytesBlobId:render?.blobId??null,bytesLength:render?.byteLength??null,overlays},blobs:output};}
    case 'POLYGON_MASK':{const input=validateNativeInput('POLYGON_MASK',job.envelope.metadata,job.blobs,job.envelope.profileDigest),result=await binaryPolygonMask(input.polygons,input.width,input.height,input.profile),png=add('mask-png',result.png),pixels=add('mask-pixels',result.pixels);return {metadata:{width:input.width,height:input.height,pngBlobId:png.blobId,pngByteLength:png.byteLength,pixelsBlobId:pixels.blobId,pixelsByteLength:pixels.byteLength},blobs:output};}
    case 'SYNTHETIC_CLEANUP':{const input=validateNativeInput('SYNTHETIC_CLEANUP',job.envelope.metadata,job.blobs,job.envelope.profileDigest),result=await syntheticCleanup(job.blobs.get(input.sourceBlobId)!,input.data,input.regionIds,input.profile),mask=add('mask',result.mask),cleaned=add('cleaned',result.cleaned);return {metadata:{...pngDimensions(result.cleaned),maskBlobId:mask.blobId,maskByteLength:mask.byteLength,cleanedBlobId:cleaned.blobId,cleanedByteLength:cleaned.byteLength,outsideChangedPixels:result.outsideChangedPixels},blobs:output};}
    case 'COMPOSITE_MASKED':{const input=validateNativeInput('COMPOSITE_MASKED',job.envelope.metadata,job.blobs,job.envelope.profileDigest),result=await compositeMaskedPixels(job.blobs.get(input.sourceBlobId)!,job.blobs.get(input.maskBlobId)!,job.blobs.get(input.proposalBlobId)!,input.profile),png=add('composed',result.png);return {metadata:{...pngDimensions(result.png),pngBlobId:png.blobId,pngByteLength:png.byteLength,outsideChangedPixels:result.outsideChangedPixels,maskSha256:result.maskSha256},blobs:output};}
    case 'GEMINI_PREPARE':{const input=validateNativeInput('GEMINI_PREPARE',job.envelope.metadata,job.blobs,job.envelope.profileDigest),fonts=await privateFonts(input.fonts,job.blobs,privateJobDirectory),prepared=await prepareScopedMaterial(input.input,input.sourceBlobId===null?null:job.blobs.get(input.sourceBlobId)!,fonts,input.profile);
      const images=prepared.material.images.map(({bytes,...metadata},index)=>({...metadata,...add('crop-'+index,bytes)}));return {metadata:{material:{...prepared.material,images},plan:prepared.plan},blobs:output};}
    case 'GEMINI_APPLY':{const input=validateNativeInput('GEMINI_APPLY',job.envelope.metadata,job.blobs,job.envelope.profileDigest),fonts=await privateFonts(input.fonts,job.blobs,privateJobDirectory),data=await applyScopedProposal(input.input,input.proposal,input.plan,fonts,input.profile,input.novelRegionIds);return {metadata:{data},blobs:output};}
    case 'ZIP_READ':{const input=validateNativeInput('ZIP_READ',job.envelope.metadata,job.blobs,job.envelope.profileDigest),entries=await readZip(job.blobs.get(input.archiveBlobId)!,input.profile);return {metadata:{entries:[...entries].map(([name,bytes],index)=>({name,...add('zip-entry-'+index,bytes)}))},blobs:output};}
    case 'ZIP_WRITE':{const input=validateNativeInput('ZIP_WRITE',job.envelope.metadata,job.blobs,job.envelope.profileDigest),archive=await writeZip(new Map(input.entries.map(item=>[item.name,job.blobs.get(item.blobId)!])),input.profile),result=add('archive',archive);return {metadata:{archiveBlobId:result.blobId,byteLength:result.byteLength},blobs:output};}
  }
}
