import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {decodeImage} from '../../packages/media/src/images.js';
import {renderPageDetailed,RenderLayoutHold} from '../../packages/media/src/render.js';
import {binaryPolygonMask} from '../../packages/media/src/mask.js';
import {prepareScopedMaterial,applyScopedProposal} from '../../packages/providers/src/gemini-material.js';
import {geminiModel} from '../../packages/providers/src/gemini.js';
import type {EditData} from '../../packages/domain/src/model.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import type {OcrProposal,TranslationProposal} from '../../packages/contracts/src/wire.generated.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {compute} from '../../packages/native/src/kernel.js';
import {createNativeJob,type NativeComputation,type NativeRunner} from '../../packages/native/src/dto.js';
import {validateNativeInput,type NativeFontBundle} from '../../packages/native/src/jobs.js';

type Timing={phase:string;elapsedMs:number};
const timings=await vi.hoisted(async()=>{const {AsyncLocalStorage}=await import('node:async_hooks');return {context:new AsyncLocalStorage<Timing[]>()};});
vi.mock('node:fs/promises',async importOriginal=>{const original=await importOriginal<typeof import('node:fs/promises')>();return {...original,writeFile:async(...args:Parameters<typeof original.writeFile>)=>{const at=performance.now();try{return await original.writeFile(...args);}finally{timings.context.getStore()?.push({phase:'FONT_FILE_WRITE',elapsedMs:performance.now()-at});}}};});
let fonts:FontCatalog;beforeAll(async()=>{const at=performance.now();fonts=await FontCatalog.load();console.log(JSON.stringify({kind:'OWNED_NATIVE_TIMING',phase:'SHARED_FONT_FIXTURE_LOAD',elapsedMs:performance.now()-at}));const original=FontCatalog.load.bind(FontCatalog);vi.spyOn(FontCatalog,'load').mockImplementation(async root=>{const at=performance.now();try{return await original(root);}finally{timings.context.getStore()?.push({phase:'FONT_CATALOG_LOAD',elapsedMs:performance.now()-at});}});});
afterAll(()=>vi.restoreAllMocks());
const frameLimits={maxMetadataBytes:2*1024*1024,maxBinaryBytes:64*1024*1024,maxItems:205};
function localRunner(change?:(result:NativeComputation)=>void){
  const directories:string[]=[],tasks:string[]=[];
  const runner:NativeRunner={async run(task,metadata,blobs){const trace:Timing[]=[];let at=performance.now();const job=createNativeJob(task,digest(metadata.profile),metadata,blobs,frameLimits);trace.push({phase:'CAPTURE_AND_HASH',elapsedMs:performance.now()-at});at=performance.now();const directory=await mkdtemp(path.join(tmpdir(),'trio-native-kernel-'));trace.push({phase:'OWNED_DIRECTORY_NEW',elapsedMs:performance.now()-at});directories.push(directory);tasks.push(task);at=performance.now();try{const result=await timings.context.run(trace,()=>compute({envelope:job,blobs},directory));change?.(result);return result;}finally{trace.push({phase:'PURE_COMPUTE_TOTAL',elapsedMs:performance.now()-at});console.log(JSON.stringify({kind:'OWNED_NATIVE_TIMING',task,phases:trace}));}}};
  return {runner,facade:new NativeFacade(runner),directories,tasks};
}
function bundle():{fonts:NativeFontBundle;blobs:Map<string,Buffer>}{const blobs=new Map<string,Buffer>();return {fonts:{catalog:fonts.catalog,blobs:[...fonts.catalog.fonts,fonts.catalog.license].map((entry,index)=>{const blobId='font-'+index;blobs.set(blobId,fonts.bytes.get(entry.id)!);return {id:entry.id,blobId};})},blobs};}
async function imageFixture(){const started=performance.now(),width=12,height=10,raw=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4;raw[at]=11+x*17;raw[at+1]=41+y*9;raw[at+2]=190;raw[at+3]=x>=6?0:255;}const source=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer();console.log(JSON.stringify({kind:'OWNED_NATIVE_TIMING',phase:'IMAGE_FIXTURE_CREATE',elapsedMs:performance.now()-started}));return {source,raw,width,height};}
async function geminiFixture(stage:'OCR'|'TRANSLATE'='OCR'){
  const image=await imageFixture(),font=fonts.catalog.fonts[0],selectedId=randomUUID(),outsideId=randomUUID(),originalAssetId=randomUUID();
  const data:EditData={blocks:[{regionId:selectedId,geometry:{polygon:[{x:2,y:1},{x:8,y:1},{x:2,y:7}],angleDegrees:0,readingOrder:5,orientation:'VERTICAL'},sourceText:{value:'SELECTED\n原文',status:'USER_CONFIRMED'},translatedText:{value:'선택 이전',status:'USER_MODIFIED'},fontAssetId:font.id,fontSizePx:20,appliedTranslation:null},{regionId:outsideId,geometry:{polygon:[{x:7,y:3},{x:11,y:3},{x:11,y:8},{x:7,y:8}],angleDegrees:0,readingOrder:9,orientation:'HORIZONTAL'},sourceText:{value:'UNSELECTED_PRIVATE_TEXT',status:'USER_CONFIRMED'},translatedText:{value:'미선택 사용자 값',status:'USER_MODIFIED'},fontAssetId:font.id,fontSizePx:4.25,appliedTranslation:null}],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',renderSpecification:{version:1,fontCatalogVersion:fonts.catalog.version,blocks:[{regionId:selectedId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-canonical-v1'},{regionId:outsideId,minimumFontSizePx:12,sizing:'EXACT'}]}};
  const settings={settingsVersion:'1',contractVersion:'gemini-material-offline-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:geminiModel,reasoningLevel:'LOW',fontAssetId:font.id,baseFontSizePx:20,minFontSizePx:10} as const;
  const input:StageInput={executionId:randomUUID(),requestId:randomUUID(),stage,inputDigest:sha256('owned-native-input'),settings,scope:{kind:'REGIONS',regionIds:[selectedId]},originalAssetId,initialData:data,previousData:null,width:image.width,height:image.height,accountId:randomUUID(),contextId:randomUUID(),claimGeneration:'1',assetDependencies:[{assetId:originalAssetId,sha256:sha256(image.source),bytesLength:String(image.source.length),mediaType:'image/png'},...[font.id,font.licenseId].map(assetId=>({assetId,sha256:sha256(fonts.bytes.get(assetId)!),bytesLength:String(fonts.bytes.get(assetId)!.length),mediaType:assetId===font.id?'font/otf':'text/plain'}))]};
  input.envelope={executionId:input.executionId,requestId:input.requestId,logicalStepId:stage,contextId:input.contextId!,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:input.inputDigest,assetIds:input.assetDependencies!.map(item=>item.assetId),regionIds:[selectedId],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:syntheticProfile.id};return {...image,data,input,selectedId,outsideId};
}
it('runs owned PNG/JPEG decode through raw blobs and preserves the existing canonical image contract',async()=>{
  const f=await imageFixture(),local=localRunner(),before=Buffer.from(f.source);expect(await local.facade.decodeImage(f.source,syntheticProfile)).toEqual(await decodeImage(f.source,syntheticProfile));expect(f.source).toEqual(before);
  const jpeg=await sharp(f.source).jpeg().toBuffer(),decoded=await local.facade.decodeImage(jpeg,syntheticProfile);expect(decoded).toEqual(await decodeImage(jpeg,syntheticProfile));expect(local.tasks).toEqual(['DECODE_IMAGE','DECODE_IMAGE']);await expect(local.facade.decodeImage(Buffer.from('invalid'),syntheticProfile)).rejects.toThrow();
});
it('refuses altered envelopes, extra paths/raw blobs and an unconfirmed profile before native work',async()=>{
  const f=await imageFixture(),blobs=new Map([['source',f.source]]),metadata={profile:syntheticProfile,sourceBlobId:'source'};
  expect(()=>validateNativeInput('DECODE_IMAGE',{...metadata,path:'C:/unowned.png'},blobs)).toThrow('NATIVE_INPUT_INVALID');expect(()=>validateNativeInput('DECODE_IMAGE',metadata,new Map([...blobs,['unused',Buffer.from('x')]]))).toThrow('NATIVE_INPUT_INVALID');expect(()=>validateNativeInput('DECODE_IMAGE',{...metadata,profile:{...syntheticProfile,enabled:false}},blobs)).toThrow('LIMIT_PROFILE_UNCONFIRMED');expect(()=>validateNativeInput('DECODE_IMAGE',metadata,blobs,sha256('other-profile'))).toThrow('NATIVE_INPUT_INVALID');
  const job=createNativeJob('DECODE_IMAGE',digest(syntheticProfile),metadata,blobs,frameLimits),directory=await mkdtemp(path.join(tmpdir(),'trio-native-kernel-'));job.metadata.sourceBlobId='missing';await expect(compute({envelope:job,blobs},directory)).rejects.toThrow('NATIVE_INPUT_MISMATCH');expect(await readdir(directory)).toEqual([]);
});
it('keeps binary masks and every outside cleanup/composite RGBA channel unchanged',async()=>{
  const f=await geminiFixture(),local=localRunner(),polygons=[f.data.blocks[0].geometry.polygon],mask=await local.facade.binaryPolygonMask(polygons,f.width,f.height,syntheticProfile);expect(mask).toEqual(await binaryPolygonMask(polygons,f.width,f.height,syntheticProfile));expect(mask.pixels.every(value=>value===0||value===255)).toBe(true);
  const cleaned=await local.facade.syntheticCleanup(f.source,f.data,[f.selectedId],syntheticProfile),proposal=await sharp({create:{width:f.width,height:f.height,channels:4,background:'#20f07080'}}).png().toBuffer(),composed=await local.facade.compositeMaskedPixels(f.source,cleaned.mask,proposal,syntheticProfile),afterCleanup=await sharp(cleaned.cleaned).ensureAlpha().raw().toBuffer(),afterComposite=await sharp(composed.png).ensureAlpha().raw().toBuffer(),before=await sharp(f.source).ensureAlpha().raw().toBuffer();
  expect(cleaned.outsideChangedPixels).toBe(0);expect(composed).toMatchObject({outsideChangedPixels:0,maskSha256:sha256(cleaned.mask)});for(let at=0;at<mask.pixels.length;at++)if(mask.pixels[at]===0){expect(afterCleanup.subarray(at*4,at*4+4)).toEqual(before.subarray(at*4,at*4+4));expect(afterComposite.subarray(at*4,at*4+4)).toEqual(before.subarray(at*4,at*4+4));}expect(f.data.cleanupQa).toBe('NEEDS_REVIEW');
});
it('round-trips ordered and empty ZIP entries without Buffer JSON and rejects names/count/extra output',async()=>{
  const local=localRunner(),entries=new Map([['manifest.json',Buffer.from('{"owned":true}')],['pages/0001.png',Buffer.from([0,1,2,255])],['empty.txt',Buffer.alloc(0)]]),archive=await local.facade.writeZip(entries,syntheticProfile);expect(await local.facade.readZip(archive,syntheticProfile)).toEqual(entries);
  await expect(local.facade.writeZip(new Map([['../bad.txt',Buffer.from('x')]]),syntheticProfile)).rejects.toThrow('NATIVE_INPUT_INVALID');await expect(local.facade.writeZip(new Map([['A.txt',Buffer.from('a')],['a.txt',Buffer.from('b')]]),syntheticProfile)).rejects.toThrow('NATIVE_INPUT_INVALID');await expect(local.facade.readZip(archive,{...syntheticProfile,maxEntries:2})).rejects.toThrow('FILE_INVALID');
  const bad=localRunner(result=>{result.blobs.set('unexpected',Buffer.from('x'));});await expect(bad.facade.readZip(archive,syntheticProfile)).rejects.toThrow('NATIVE_OUTPUT_INVALID');
});
it('validates the pinned font/license set before writing and uses only a fresh private fonts directory',async()=>{
  const f=await geminiFixture(),inputBundle=bundle(),metadata={profile:syntheticProfile,input:f.input,sourceBlobId:'source',fonts:inputBundle.fonts},blobs=new Map([...inputBundle.blobs,['source',f.source]]);
  const altered=structuredClone(inputBundle.fonts);altered.catalog.fonts[0].file='../unowned.otf';expect(()=>validateNativeInput('GEMINI_PREPARE',{...metadata,fonts:altered},blobs)).toThrow('INPUT_DEPENDENCY_INVALID');const wrongBlobs=new Map(blobs);wrongBlobs.set(inputBundle.fonts.blobs[0].blobId,Buffer.alloc(Number(fonts.catalog.fonts[0].bytesLength)));expect(()=>validateNativeInput('GEMINI_PREPARE',metadata,wrongBlobs)).toThrow('INPUT_DEPENDENCY_INVALID');
  const local=localRunner();await local.facade.prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile);const root=path.join(local.directories[0],'fonts');expect((await readdir(root)).sort()).toEqual(['catalog.json',...fonts.catalog.fonts.map(font=>font.file),fonts.catalog.license.file].sort());for(const entry of [...fonts.catalog.fonts,fonts.catalog.license]){const file=path.join(root,entry.file),stat=await lstat(file);expect(stat.isFile()&&!stat.isSymbolicLink()).toBe(true);expect(sha256(await readFile(file))).toBe(entry.sha256);}const catalogBefore=await readFile(path.join(root,'catalog.json'));
  const job=createNativeJob('GEMINI_PREPARE',digest(syntheticProfile),metadata,blobs,frameLimits);await expect(compute({envelope:job,blobs},local.directories[0])).rejects.toThrow();expect(await readFile(path.join(root,'catalog.json'))).toEqual(catalogBefore);
});
async function renderFixture(mode:'MIXED'|'LEGACY'|'HOLD'){
  const started=performance.now(),source=await sharp({create:{width:400,height:400,channels:4,background:'#ffffffff'}}).png().toBuffer(),font=fonts.catalog.fonts[0],smallId=randomUUID(),legacyId=randomUUID();
  const data:EditData={blocks:[{regionId:smallId,geometry:{polygon:[{x:160,y:150},{x:330,y:150},{x:330,y:210},{x:160,y:210}],angleDegrees:0,readingOrder:1,orientation:'HORIZONTAL'},sourceText:{value:'',status:'USER_CONFIRMED'},translatedText:{value:'작은 수동 글자\n소수 크기',status:'USER_MODIFIED'},fontAssetId:font.id,fontSizePx:8.5,appliedTranslation:null},{regionId:legacyId,geometry:{polygon:[{x:20,y:20},{x:100,y:20},{x:100,y:55},{x:20,y:55}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'',status:'USER_CONFIRMED'},translatedText:{value:'ABC',status:'USER_MODIFIED'},fontAssetId:font.id,fontSizePx:18,appliedTranslation:null}],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',renderSpecification:{version:1,fontCatalogVersion:fonts.catalog.version,blocks:[{regionId:smallId,minimumFontSizePx:12,sizing:'EXACT',rendererVersion:'pango-overflow-v2'},{regionId:legacyId,minimumFontSizePx:12,sizing:'AUTO_FIT'}]}};
  if(mode==='LEGACY')delete data.renderSpecification!.blocks[0].rendererVersion;
  if(mode==='HOLD'){data.blocks[0].fontSizePx=36;data.blocks[0].translatedText.value='日本語\n四行\n保持\n全体';data.blocks[0].geometry.polygon=[{x:0,y:0},{x:100,y:0},{x:100,y:20},{x:0,y:20}];}
  console.log(JSON.stringify({kind:'OWNED_NATIVE_TIMING',phase:'RENDER_FIXTURE_CREATE',elapsedMs:performance.now()-started}));return {source,data};
}
const ocrProposal=(f:Awaited<ReturnType<typeof geminiFixture>>):OcrProposal=>({regions:[{geometry:structuredClone(f.data.blocks[0].geometry),sourceText:'OCR\n選択',confidence:0.9}]});
async function pageFixture(){const f=await geminiFixture();f.input.scope={kind:'PAGE'};f.input.envelope!.regionIds=f.data.blocks.map(block=>block.regionId);return f;}
async function paintFixture(){const f=await geminiFixture();f.input.initialData={...f.data,blocks:[],renderSpecification:null};f.input.scope={kind:'PAINTED',selectionId:randomUUID()};f.input.envelope!.regionIds=[];f.input.paintInclusion='ANY_OVERLAP';f.input.paintStrokes=[{radiusPx:20,points:[{x:3,y:3}]}];return f;}
it.each(['MIXED','LEGACY','HOLD'] as const)('native render %s preserves its complete existing bytes/layout/overlays and exact captured sizes',async mode=>{
  const f=await renderFixture(mode),before=structuredClone(f.data),local=localRunner(),expected=await renderPageDetailed(f.source,f.data,fonts,syntheticProfile,20),actual=await local.facade.renderPageDetailed(f.source,f.data,fonts,syntheticProfile,20);expect(actual).toEqual(expected);expect(f.data).toEqual(before);
  if(mode==='MIXED')expect(actual.layout.blocks[0].fontSizePx).toBe(8.5);if(mode==='LEGACY')expect(actual.layout.blocks).toEqual([]);if(mode==='HOLD'){expect(actual.bytes).toBeNull();expect(actual.layout.qa).toBe('HOLD');expect(actual.overlays[0].bounds.top).toBeLessThan(0);}
});
it('native render HOLD preserves the shared RenderLayoutHold instance and full review result',async()=>{
  const f=await renderFixture('HOLD'),local=localRunner();try{await local.facade.renderPage(f.source,f.data,fonts,syntheticProfile);throw new Error('Expected HOLD');}catch(error){expect(error).toBeInstanceOf(RenderLayoutHold);const result=(error as RenderLayoutHold).result;expect(result.bytes).toBeNull();expect(result.layout.qa).toBe('HOLD');expect(result.overlays[0].bounds.top).toBeLessThan(0);}
});
it('native OCR material preserves the exact selected crop and excludes unselected private text',async()=>{
  const f=await geminiFixture(),local=localRunner(),expected=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),actual=await local.facade.prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile);expect(actual).toEqual(expected);expect(actual.material.images[0]).toMatchObject({coordinateOrigin:{x:2,y:1},width:6,height:6,inputRegionId:f.selectedId});expect(JSON.stringify(actual.material.sourceTexts)).not.toContain('UNSELECTED_PRIVATE_TEXT');
});
it('native OCR apply preserves all unselected user values and captured render settings',async()=>{
  const f=await geminiFixture(),local=localRunner(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),proposal=ocrProposal(f),actual=await local.facade.applyScopedProposal(f.input,proposal,material.plan,fonts,syntheticProfile,[]);expect(actual).toEqual(await applyScopedProposal(f.input,proposal,material.plan,fonts,syntheticProfile,[]));expect(actual.blocks[1]).toEqual(f.data.blocks[1]);expect(actual.renderSpecification!.blocks[1]).toEqual(f.data.renderSpecification!.blocks[1]);
});
it('native TRANSLATE material returns only exact immutable selected text and no images',async()=>{
  const f=await geminiFixture('TRANSLATE'),local=localRunner(),material=await local.facade.prepareScopedMaterial(f.input,null,fonts,syntheticProfile);expect(material.material.images).toEqual([]);expect(material.material.sourceTexts).toEqual([{inputRegionId:f.selectedId,sourceText:'SELECTED\n原文'}]);expect(material).toEqual(await prepareScopedMaterial(f.input,null,fonts,syntheticProfile));
});
it('native TRANSLATE apply retains unselected blocks while setting only the selected AI proposal',async()=>{
  const f=await geminiFixture('TRANSLATE'),local=localRunner(),material=await prepareScopedMaterial(f.input,null,fonts,syntheticProfile),proposal:TranslationProposal={items:[{inputRegionId:f.selectedId,targetText:'번역\n줄바꿈'}]},actual=await local.facade.applyScopedProposal(f.input,proposal,material.plan,fonts,syntheticProfile,[]);expect(actual.blocks[0].translatedText).toEqual({value:'번역\n줄바꿈',status:'AI_PROPOSED'});expect(actual.blocks[1]).toEqual(f.data.blocks[1]);
});
it('native PAGE material captures the explicitly permitted whole source only once',async()=>{
  const f=await pageFixture(),local=localRunner(),material=await local.facade.prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile);expect(material.material.images).toHaveLength(1);expect(material.material.images[0]).toMatchObject({coordinateOrigin:{x:0,y:0},width:f.width,height:f.height,inputRegionId:null});
});
it('native PAGE apply uses the exact parent-allocated novel UUID',async()=>{
  const f=await pageFixture(),local=localRunner(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),allocated=randomUUID(),actual=await local.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[allocated]);expect(actual.blocks.map(block=>block.regionId)).toEqual([allocated]);expect(actual.blocks[0].sourceText.status).toBe('AI_PROPOSED');
});
it('native PAGE apply rejects reused/duplicate pools before native work',async()=>{
  const f=await pageFixture(),local=localRunner(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),allocated=randomUUID();await expect(local.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[f.selectedId])).rejects.toThrow('NATIVE_INPUT_INVALID');await expect(local.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[allocated,allocated])).rejects.toThrow('NATIVE_INPUT_INVALID');expect(local.tasks).toEqual([]);
});
it('native PAGE apply refuses an empty parent pool without allocating a UUID in the kernel',async()=>{
  const f=await pageFixture(),local=localRunner(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile);await expect(local.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[])).rejects.toThrow('STAGE_PROPOSAL_INVALID');
});
it('native PAINT material retains a captured brush radius larger than the page',async()=>{
  const f=await paintFixture(),local=localRunner(),material=await local.facade.prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile);expect(material).toEqual(await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile));expect(f.input.paintStrokes![0].radiusPx).toBe(20);expect(f.input.initialData.blocks).toEqual([]);
});
it('native PAINT apply uses parent IDs and assigns novel reading order after existing blocks',async()=>{
  const f=await paintFixture(),local=localRunner(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),allocated=randomUUID(),actual=await local.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[allocated]);expect(actual.blocks[0].regionId).toBe(allocated);expect(actual.blocks[0].geometry.readingOrder).toBe(0);expect(f.input.initialData.blocks).toEqual([]);
});
it('native malformed decode output rejects incorrect raw length or encoded dimensions',async()=>{
  const f=await imageFixture(),badLength=localRunner(result=>{result.metadata.canonicalPngByteLength=(result.metadata.canonicalPngByteLength as number)+1;});await expect(badLength.facade.decodeImage(f.source,syntheticProfile)).rejects.toThrow('NATIVE_OUTPUT_INVALID');const badDimension=localRunner(result=>{result.metadata.width=13;});await expect(badDimension.facade.decodeImage(f.source,syntheticProfile)).rejects.toThrow('NATIVE_OUTPUT_INVALID');
});
it.each(['STATUS','APPROVAL','ID'] as const)('native child output refuses an unselected %s mutation',async mutation=>{
  const f=await geminiFixture(),material=await prepareScopedMaterial(f.input,f.source,fonts,syntheticProfile),malicious=localRunner(result=>{if(result.metadata.data){const data=result.metadata.data as EditData;if(mutation==='STATUS')data.blocks[1].sourceText.status='AI_PROPOSED';if(mutation==='APPROVAL')data.cleanupQa='PASSED';if(mutation==='ID')data.blocks[1].regionId=randomUUID();}});await expect(malicious.facade.applyScopedProposal(f.input,ocrProposal(f),material.plan,fonts,syntheticProfile,[])).rejects.toThrow('NATIVE_OUTPUT_INVALID');
});
