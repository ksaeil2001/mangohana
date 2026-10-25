import {mkdtemp,readFile,writeFile,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir,cpus} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {FontCatalog} from '../packages/media/src/fonts.js';
import {decodeImage} from '../packages/media/src/images.js';
import {renderPageDetailed} from '../packages/media/src/render.js';
import {syntheticProfile} from '../packages/media/src/profile.js';
import {syntheticCleanup} from '../packages/domain/src/image-pipeline.js';
import type {EditData} from '../packages/domain/src/model.js';
import type {Block} from '../packages/contracts/src/wire.generated.js';
import {sha256} from '../packages/contracts/src/intent.js';
import {parseStrictJson} from '../packages/contracts/src/json.js';
import {DomainError} from '../packages/contracts/src/errors.js';

type Specimen={id:string;sourceLanguage:'ja'|'en';targetLanguage:'ko';shape:'SIMPLE'|'VERTICAL_MIXED'|'DENSE'};
const plan=parseStrictJson(await readFile('packages/contracts/schemas/quality-specimen-plan.json','utf8')) as Specimen[];
if(!Array.isArray(plan)||plan.length!==6||new Set(plan.map(item=>item.id)).size!==6||plan.some(item=>!/^[a-z][A-Za-z0-9_-]{1,50}$/.test(item.id)||!['ja','en'].includes(item.sourceLanguage)||item.targetLanguage!=='ko'||!['SIMPLE','VERTICAL_MIXED','DENSE'].includes(item.shape)||item.id!==`${item.sourceLanguage}-ko-${item.shape.toLowerCase()}`))throw new Error('SPECIMEN_PLAN_UNCONFIRMED');

async function sample<T>(run:()=>Promise<T>){
  const start=performance.now();const cpu=process.cpuUsage();let sampledRssBytes=process.memoryUsage().rss;let samples=1;const observe=()=>{samples++;sampledRssBytes=Math.max(sampledRssBytes,process.memoryUsage().rss);};const timer=setInterval(observe,5);
  try{const value=await run();observe();const elapsed=process.cpuUsage(cpu);return {value,measurement:{wallMilliseconds:performance.now()-start,cpuUserMicroseconds:elapsed.user,cpuSystemMicroseconds:elapsed.system,sampledRssBytes,rssSamples:samples,rssSampleIntervalMilliseconds:5,peakMemoryBytes:null,peakMemoryEvidence:'RSS samples can miss native allocation peaks; no hard memory bound inferred'}};}
  finally{clearInterval(timer);}
}
async function specimen(item:Specimen,output:string){
  const fonts=await FontCatalog.load();const font=fonts.catalog.fonts.find(value=>value.language===item.targetLanguage)!;if(!font)throw new Error('FONT_UNAVAILABLE');
  const sourceText={ja:'合成原文',en:'Owned sample'}[item.sourceLanguage];const targetText='합성 대사';
  const make=(left:number,top:number,width:number,height:number,order:number,vertical=false):Block=>({regionId:randomUUID(),geometry:{polygon:[{x:left,y:top},{x:left+width,y:top},{x:left+width,y:top+height},{x:left,y:top+height}],angleDegrees:0,readingOrder:order,orientation:vertical?'VERTICAL':'HORIZONTAL'},sourceText:{value:sourceText,status:'USER_CONFIRMED'},translatedText:{value:vertical?targetText.replaceAll(' ',''):targetText,status:'AI_PROPOSED'},fontAssetId:font.id,fontSizePx:item.shape==='DENSE'?16:24,appliedTranslation:null});
  const blocks=item.shape==='SIMPLE'?[make(90,280,460,120,0)]:item.shape==='VERTICAL_MIXED'?[make(440,80,90,320,0,true),make(70,480,400,110,1)]:Array.from({length:12},(_,index)=>make(35+(index%2)*305,30+Math.floor(index/2)*126,265,95,index));
  const data:EditData={blocks,geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',renderSpecification:{version:1,fontCatalogVersion:fonts.catalog.version,blocks:blocks.map(block=>({regionId:block.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2'}))}};
  const rectangles=blocks.map(block=>{const a=block.geometry.polygon[0];const b=block.geometry.polygon[2];return `<rect x="${a.x}" y="${a.y}" width="${b.x-a.x}" height="${b.y-a.y}" rx="18" fill="#fafafa" stroke="#555" stroke-width="2"/>`;}).join('');
  const background=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800"><rect width="640" height="800" fill="#c6d6e3"/><path d="M0 0L640 800M640 0L0 800" stroke="#93acc1" stroke-width="35"/>${rectangles}</svg>`)).png().toBuffer();
  const sourceFont=fonts.catalog.fonts.find(value=>value.language===(item.sourceLanguage==='en'?'ja':item.sourceLanguage))!;if(!sourceFont)throw new Error('SOURCE_FONT_UNAVAILABLE');
  const sourceData=structuredClone(data);for(const block of sourceData.blocks){block.fontAssetId=sourceFont.id;block.translatedText={value:block.sourceText.value,status:'USER_CONFIRMED'};}
  const sourceRender=await renderPageDetailed(background,sourceData,fonts,syntheticProfile);if(!sourceRender.bytes||sourceRender.layout.blocks.some(block=>block.glyphPixelsOutsidePolygon||block.glyphPixelsOutsidePage))throw new Error('OWNED_SOURCE_LAYOUT_UNCONFIRMED');
  const source=sourceRender.bytes;const sourceHash=sha256(source);
  const decoded=await sample(()=>decodeImage(source,syntheticProfile));const cleanup=await sample(()=>syntheticCleanup(decoded.value.canonicalPng,data,blocks.map(block=>block.regionId),syntheticProfile));const render=await sample(()=>renderPageDetailed(cleanup.value.cleaned,data,fonts,syntheticProfile));
  const metadata=render.value.bytes?await sharp(render.value.bytes).metadata():null;const glyphCoverage=blocks.every(block=>fonts.covers(block.fontAssetId,block.translatedText.value));if(sha256(source)!==sourceHash||metadata&&(metadata.width!==640||metadata.height!==800)||cleanup.value.outsideChangedPixels!==0||!glyphCoverage)throw new Error('OWNED_RASTER_VALIDATION_FAILED');
  // Known vector borders are specimen ground truth, not a new segmentation
  // model or permission to expand the production erase scope.
  const borderShapes=blocks.map(block=>{const a=block.geometry.polygon[0];const b=block.geometry.polygon[2];return `<rect x="${a.x}" y="${a.y}" width="${b.x-a.x}" height="${b.y-a.y}" rx="18" fill="none" stroke="white" stroke-width="2"/>`;}).join('');
  const border=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800">${borderShapes}</svg>`)).ensureAlpha().raw().toBuffer();const backgroundPixels=await sharp(background).ensureAlpha().raw().toBuffer();const before=await sharp(source).ensureAlpha().raw().toBuffer();const after=await sharp(cleanup.value.cleaned).ensureAlpha().raw().toBuffer();const mask=await sharp(cleanup.value.mask).ensureAlpha().raw().toBuffer();let protectedBorderPixels=0,eraseMaskProtectedBorderPixels=0,changedProtectedBorderPixels=0,sourceGlyphPixels=0,sourceGlyphPixelsOutsideEraseMask=0,sourceGlyphPixelsMatchingOriginalAfterCleanup=0,sourceGlyphPixelsInsideEraseMaskMatchingOriginalAfterCleanup=0;
  for(let pixel=0;pixel<640*800;pixel++){
    const original=before.subarray(pixel*4,pixel*4+4),cleaned=after.subarray(pixel*4,pixel*4+4);
    if(border[pixel*4+3]>0){protectedBorderPixels++;if(mask[pixel*4]>0)eraseMaskProtectedBorderPixels++;if(!original.equals(cleaned))changedProtectedBorderPixels++;}
    // Exact known source glyph pixels only. This does not substitute for OCR
    // detection of residual or newly hallucinated text in a real inpaint.
    if(!original.equals(backgroundPixels.subarray(pixel*4,pixel*4+4))){sourceGlyphPixels++;if(mask[pixel*4]===0)sourceGlyphPixelsOutsideEraseMask++;if(original.equals(cleaned)){sourceGlyphPixelsMatchingOriginalAfterCleanup++;if(mask[pixel*4]>0)sourceGlyphPixelsInsideEraseMaskMatchingOriginalAfterCleanup++;}}
  }
  if(sourceGlyphPixels===0)throw new DomainError('OWNED_SOURCE_GLYPHS_UNCONFIRMED',409,'WAIT');
  const failureTypes:string[]=[];if(eraseMaskProtectedBorderPixels||changedProtectedBorderPixels||sourceGlyphPixelsOutsideEraseMask)failureTypes.push('MASK');if(sourceGlyphPixelsInsideEraseMaskMatchingOriginalAfterCleanup)failureTypes.push('INPAINT');if(!render.value.bytes||render.value.layout.blocks.some(block=>block.glyphPixelsOutsidePolygon||block.glyphPixelsOutsidePage||block.glyphPixelsInsideOtherPolygons.length||block.fallbackAtMinimum))failureTypes.push('TYPESETTING');
  const artifacts=[];for(const [kind,bytes]of [['background',background],['source',source],['mask',cleanup.value.mask],['cleaned',cleanup.value.cleaned],['render',render.value.bytes]] as const){if(bytes===null)continue;const file=`${item.id}.${kind}.png`;await writeFile(path.join(output,file),bytes,{flag:'wx'});artifacts.push({kind,file,sha256:sha256(bytes),bytesLength:String(bytes.length)});}
  for(const [index,overlay]of render.value.overlays.entries()){const file=`${item.id}.overlay-${index}.png`;await writeFile(path.join(output,file),overlay.bytes,{flag:'wx'});artifacts.push({kind:'overlay',regionId:overlay.regionId,bounds:overlay.bounds,file,sha256:sha256(overlay.bytes),bytesLength:String(overlay.bytes.length)});}
  await writeFile(path.join(output,`${item.id}.edit.json`),JSON.stringify(data,null,2),{flag:'wx'});
  return {...item,ok:render.value.bytes!==null,okScope:'LOCAL_RASTER_EXECUTION',rights:'OWNED_SYNTHETIC_GENERATED_VECTOR',execution:'LOCAL_RASTER_ONLY',concurrency:1,profile:syntheticProfile.id,font:{id:font.id,version:font.version,catalogVersion:fonts.catalog.version,sha256:font.sha256,licenseId:font.licenseId},sourceFont:{id:sourceFont.id,version:sourceFont.version,sha256:sourceFont.sha256},input:{width:640,height:800,format:'image/png',bytesLength:String(source.length),sha256:sourceHash},output:metadata?{width:metadata.width,height:metadata.height,format:'image/png'}:null,stages:{decode:decoded.measurement,cleanup:cleanup.measurement,typeset:render.measurement},sourceLayout:sourceRender.layout,layout:render.value.layout,checks:{originalBytesPreserved:true,cleanupOutsideChangedPixels:cleanup.value.outsideChangedPixels,glyphCoverage},quality:{status:failureTypes.length?'ISSUES_FOUND':'NO_AUTOMATED_ISSUE_OBSERVED',ocr:null,translationMeaning:null,readingOrder:null,backgroundQa:'NEEDS_REVIEW',glyphLayoutHumanReview:null,protectedBorderPixels,eraseMaskProtectedBorderPixels,changedProtectedBorderPixels,sourceGlyphPixels,sourceGlyphPixelsOutsideEraseMask,sourceGlyphPixelsMatchingOriginalAfterCleanup,sourceGlyphPixelsInsideEraseMaskMatchingOriginalAfterCleanup,failureTypes,automaticFixApplied:false,humanReviewRequired:true},actualProviderCostUsd:null,infrastructureCostUsd:null,actualProviderCalls:0,artifacts};
}

const args=process.argv.slice(2);
if(args.length===4&&args[0]==='--case'&&args[2]==='--output'){
  const item=plan.find(value=>value.id===args[1]);const output=path.resolve(args[3]);const relative=path.relative(path.resolve(tmpdir()),output);const info=await lstat(output);if(!item||relative.startsWith('..')||path.isAbsolute(relative)||!/^trio-manga-web-measure-[A-Za-z0-9]+$/.test(relative)||!info.isDirectory()||info.isSymbolicLink())throw new Error('OWNED_OUTPUT_UNCONFIRMED');
  try{const result=await specimen(item,output);await writeFile(path.join(output,`${item.id}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});if(!result.ok)process.exitCode=1;}
  catch(error){await writeFile(path.join(output,`${item.id}.json`),JSON.stringify({ok:false,specimenId:item.id,code:error instanceof DomainError?error.code:'LOCAL_MEASUREMENT_FAILED',actualProviderCalls:0,productionLimitPromotion:false})+'\n',{flag:'wx'});process.exitCode=1;}
}else if(args.length===0){
  const output=await mkdtemp(path.join(tmpdir(),'trio-manga-web-measure-'));const results:unknown[]=[];let failed=0;for(const item of plan){
    const code=await new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/measure-owned.ts','--case',item.id,'--output',output],{stdio:['ignore','ignore','inherit'],windowsHide:true});child.once('error',reject);child.once('exit',status=>resolve(status??1));});if(code!==0)failed++;results.push(parseStrictJson(await readFile(path.join(output,`${item.id}.json`),'utf8')));
  }
  const qualityIssueCases=results.flatMap(value=>{const result=value as Partial<Awaited<ReturnType<typeof specimen>>>;return result.quality?.failureTypes.length?[{id:result.id,failureTypes:result.quality.failureTypes}]:[];});
  const report={schemaVersion:1,measuredAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,architecture:process.arch,cpuCount:cpus().length,sharp:sharp.versions},method:'Each owned specimen runs in a fresh process, serially. Decode/cleanup/canonical render wall and CPU time plus 5ms RSS samples are observed.',specimens:results,passed:plan.length-failed,failed,passedScope:'LOCAL_RASTER_EXECUTION',qualityIssueCases,qualityFailuresByType:Object.fromEntries(['MASK','INPAINT','TYPESETTING'].map(type=>[type,qualityIssueCases.filter(value=>value.failureTypes.includes(type)).length])),humanQualityVerified:false,originalQualityPlanUpdated:false,productionProfileState:'UNMEASURED',productionLimitPromotion:false,effectiveGates:{realProviderEnabled:false,paidExecutionEnabled:false,purchaseEnabled:false},actualProviderCalls:0,externalProviderQuality:'NOT RUN',physicalDeviceQuality:'NOT RUN'};
  const file=path.join(output,'report.json');await writeFile(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({report:file,passed:report.passed,failed,actualProviderCalls:0,productionLimitPromotion:false}));if(failed)process.exitCode=1;
}else throw new Error('MEASUREMENT_ARGUMENT_INVALID');
