import {beforeAll,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {RenderLayoutHold} from '../../packages/media/src/render-contract.js';
import {writeZip} from '../../packages/media/src/zip.js';
import {prepareScopedMaterial,applyScopedProposal} from '../../packages/providers/src/gemini-material.js';
import {geminiModel} from '../../packages/providers/src/gemini.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import type {EditData} from '../../packages/domain/src/model.js';
import type {OcrProposal} from '../../packages/contracts/src/wire.generated.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {nativeKernelImplementationDigest} from '../../packages/native/src/identity.js';
import {createNativeJob,createNativeResult,NativeJobError,type NativeComputation,type NativeLimits,type NativeRunHooks,type NativeRunner,type NativeTask,type NativeTermination} from '../../packages/native/src/dto.js';
import {nativeFacadeVerificationVersion,type NativeSemanticCache,type NativeSemanticCacheRead} from '../../packages/native/src/semantic-cache.js';

const frameLimits=Object.freeze({maxMetadataBytes:2*1024*1024,maxBinaryBytes:64*1024*1024,maxItems:205});
const identityTrace=vi.hoisted(()=>({enabled:false,alterKernel:false,missingBootstrap:false,paths:[] as string[]}));
vi.mock('node:fs',async importOriginal=>{const original=await importOriginal<typeof import('node:fs')>();return {...original,readFileSync:(...args:Parameters<typeof original.readFileSync>)=>{
  const value=original.readFileSync(...args);if(identityTrace.enabled&&args[0] instanceof URL){identityTrace.paths.push(args[0].pathname);if(identityTrace.missingBootstrap&&args[0].pathname.endsWith('/native/src/bootstrap.mjs'))throw new Error('owned missing source specimen');if(identityTrace.alterKernel&&args[0].pathname.endsWith('/native/src/kernel.ts')&&Buffer.isBuffer(value))return Buffer.concat([value,Buffer.from('\n// owned changed implementation specimen\n')]);}return value;
}};});
let source:Buffer,fonts:FontCatalog,archive:Buffer;
beforeAll(async()=>{source=await sharp({create:{width:12,height:10,channels:4,background:'#abcdef80'}}).png().toBuffer();fonts=await FontCatalog.load();archive=await writeZip(new Map([['owned.txt',Buffer.from('owned cache')],['empty.txt',Buffer.alloc(0)]]),syntheticProfile);});
afterEach(()=>{identityTrace.enabled=false;identityTrace.alterKernel=false;identityTrace.missingBootstrap=false;identityTrace.paths=[];});
function decoded():NativeComputation{return {metadata:{width:12,height:10,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:source.length},blobs:new Map([['canonical-png',source]])};}
function recordedFor(task:NativeTask,input:Record<string,unknown>,blobs:Map<string,Buffer>,computation:NativeComputation):Extract<NativeSemanticCacheRead,{state:'VERIFIED'}>{
  const job=createNativeJob(task,digest(input.profile),input,blobs,frameLimits);
  return {state:'VERIFIED',result:createNativeResult(job,computation,frameLimits),blobs:computation.blobs,operationInputDigest:nativeOperationInputDigest(job)};
}
function recorded(computation=decoded()){return recordedFor('DECODE_IMAGE',{profile:syntheticProfile,sourceBlobId:'source'},new Map([['source',source]]),computation);}
function cacheFixture(decision:NativeSemanticCacheRead){
  const termination:NativeTermination={jobId:randomUUID(),inputDigest:sha256('original-input'),profileDigest:digest(syntheticProfile),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const read=vi.fn<NativeSemanticCache['read']>().mockResolvedValue(decision),seal=vi.fn<NativeSemanticCache['seal']>().mockResolvedValue(undefined),failure=vi.fn<NativeSemanticCache['onValidationFailure']>().mockImplementation(async()=>{throw new NativeJobError('NATIVE_SEMANTIC_VALIDATION_HOLD',409,'WAIT',termination);});
  const cache:NativeSemanticCache={kernelImplementationDigest:sha256('owned-source-version'),facadeVerificationVersion:nativeFacadeVerificationVersion,frameLimits:()=>frameLimits,read,seal,onValidationFailure:failure};
  return {cache,read,seal,failure,termination};
}
function noRun(){return vi.fn<NativeRunner['run']>().mockRejectedValue(new Error('new native GO refused by fixture'));}
function emptyData():EditData{return {blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',renderSpecification:null};}
async function pageFixture(){
  const font=fonts.catalog.fonts[0],regionId=randomUUID(),originalAssetId=randomUUID(),data=emptyData();
  data.blocks=[{regionId,geometry:{polygon:[{x:1,y:1},{x:7,y:1},{x:7,y:7},{x:1,y:7}],angleDegrees:0,readingOrder:5,orientation:'HORIZONTAL'},sourceText:{value:'原文',status:'USER_CONFIRMED'},translatedText:{value:'사용자 번역',status:'USER_MODIFIED'},fontAssetId:font.id,fontSizePx:20,appliedTranslation:null}];data.renderSpecification={version:1,fontCatalogVersion:fonts.catalog.version,blocks:[{regionId,minimumFontSizePx:10,sizing:'AUTO_FIT',rendererVersion:'pango-canonical-v1'}]};
  const settings={settingsVersion:'1',contractVersion:'gemini-material-offline-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:geminiModel,reasoningLevel:'LOW',fontAssetId:font.id,baseFontSizePx:20,minFontSizePx:10} as const;
  const input:StageInput={executionId:randomUUID(),requestId:randomUUID(),stage:'OCR',inputDigest:sha256('owned-semantic-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:data,previousData:null,width:12,height:10,accountId:randomUUID(),contextId:randomUUID(),claimGeneration:'1',assetDependencies:[{assetId:originalAssetId,sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png'},...[font.id,font.licenseId].map(assetId=>({assetId,sha256:sha256(fonts.bytes.get(assetId)!),bytesLength:String(fonts.bytes.get(assetId)!.length),mediaType:assetId===font.id?'font/otf':'text/plain'}))]};
  input.envelope={executionId:input.executionId,requestId:input.requestId,logicalStepId:'OCR',contextId:input.contextId!,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:input.inputDigest,assetIds:input.assetDependencies!.map(item=>item.assetId),regionIds:[regionId],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:syntheticProfile.id};
  const prepared=await prepareScopedMaterial(input,source,fonts,syntheticProfile),proposal:OcrProposal={regions:[{geometry:structuredClone(data.blocks[0].geometry),sourceText:'OCR 제안',confidence:0.9}]};return {input,data,prepared,proposal};
}
function preparedComputation(prepared:Awaited<ReturnType<typeof prepareScopedMaterial>>):NativeComputation{
  const blobs=new Map<string,Buffer>(),images=prepared.material.images.map(({bytes,...item},index)=>{const blobId='crop-'+index;blobs.set(blobId,bytes);return {...item,blobId,byteLength:bytes.length};});return {metadata:{material:{...prepared.material,images},plan:prepared.plan},blobs};
}
async function held(thunk:()=>Promise<unknown>,termination:NativeTermination){const error=await thunk().catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);if(!(error instanceof NativeJobError))throw new Error('Expected original NativeJobError');expect(error.termination).toEqual(termination);expect(error.nextAction).toBe('WAIT');return error;}
it('valid cached DECODE reads original raw bytes with runner and GO calls zero',async()=>{
  const c=cacheFixture(recorded()),run=vi.fn<NativeRunner['run']>().mockRejectedValue(new Error('new native GO refused by fixture')),facade=new NativeFacade({run},undefined,c.cache);
  expect(await facade.decodeImage(source,syntheticProfile)).toEqual({width:12,height:10,mediaType:'image/png',canonicalPng:source});expect(run).not.toHaveBeenCalled();expect(c.read).toHaveBeenCalledTimes(1);expect(c.seal).toHaveBeenCalledTimes(1);expect(c.failure).not.toHaveBeenCalled();
});
it('malformed fresh output seals zero and preserves the original native termination',async()=>{
  const bad=decoded();bad.metadata.width=13;const c=cacheFixture({state:'MISS'}),run=vi.fn<NativeRunner['run']>().mockResolvedValue(bad),facade=new NativeFacade({run},undefined,c.cache);
  const error=await facade.decodeImage(source,syntheticProfile).catch(error=>error);expect(error).toBeInstanceOf(NativeJobError);expect(error.termination).toEqual(c.termination);expect(c.failure).toHaveBeenCalledTimes(1);expect(c.failure.mock.calls[0][3]).toBe(bad);expect(c.seal).not.toHaveBeenCalled();expect(run).toHaveBeenCalledTimes(1);
});
it('valid cached ZIP reads retain ordered empty entries with runner and GO calls zero',async()=>{
  const computation:NativeComputation={metadata:{entries:[{name:'owned.txt',blobId:'zip-entry-0',byteLength:11},{name:'empty.txt',blobId:'zip-entry-1',byteLength:0}]},blobs:new Map([['zip-entry-0',Buffer.from('owned cache')],['zip-entry-1',Buffer.alloc(0)]])},c=cacheFixture(recordedFor('ZIP_READ',{profile:syntheticProfile,archiveBlobId:'archive'},new Map([['archive',archive]]),computation)),run=noRun();
  expect(await new NativeFacade({run},undefined,c.cache).readZip(archive,syntheticProfile)).toEqual(new Map([['owned.txt',Buffer.from('owned cache')],['empty.txt',Buffer.alloc(0)]]));expect(run).not.toHaveBeenCalled();expect(c.seal).toHaveBeenCalledTimes(1);expect(c.failure).not.toHaveBeenCalled();
});
it.each(['SHA','LENGTH'] as const)('cached raw %s corruption refuses reuse and seals zero',async corruption=>{
  const saved=recorded(),raw=Buffer.from(source);if(corruption==='SHA')raw[raw.length-1]^=1;else raw[raw.length-1]=0;saved.blobs=new Map([['canonical-png',corruption==='LENGTH'?Buffer.concat([raw,Buffer.from([0])]):raw]]);const c=cacheFixture(saved),run=noRun();
  await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.failure).toHaveBeenCalledTimes(1);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it.each(['TASK','TASK_VERSION','PROFILE','OPERATION_DIGEST','EXTRA_KEY'] as const)('cached %s mismatch remains HOLD without a new native GO',async mismatch=>{
  const saved=recorded();if(mismatch==='TASK')saved.result.task='ZIP_READ';if(mismatch==='TASK_VERSION')Object.assign(saved.result,{taskVersion:'native-pure-v0'});if(mismatch==='PROFILE')saved.result.profileDigest=sha256('other-profile');if(mismatch==='OPERATION_DIGEST')saved.operationInputDigest=sha256('other-operation');if(mismatch==='EXTRA_KEY')Object.assign(saved.result,{unexpected:true});const c=cacheFixture(saved),run=noRun();
  await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(run).not.toHaveBeenCalled();expect(c.seal).not.toHaveBeenCalled();expect(c.failure).toHaveBeenCalledTimes(1);
});
it('cached metadata repeats the original decode dimensions check before seal',async()=>{
  const malformed=decoded();malformed.metadata.width=13;const c=cacheFixture(recorded(malformed)),run=noRun();await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('cached output repeats finish and refuses a verified but unused raw blob',async()=>{
  const malformed=decoded();malformed.blobs.set('unused',Buffer.from('owned unexpected'));const c=cacheFixture(recorded(malformed)),run=noRun();await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('an unsupported current facade verification version cannot produce a new native GO',async()=>{
  const c=cacheFixture(recorded());Object.assign(c.cache,{facadeVerificationVersion:'native-facade-verification-v0'});const run=noRun();await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it.each(['PENDING','CONFLICT','KERNEL_VERSION'] as const)('port %s HOLD keeps the exact original NativeJobError and creates no fallback work',async state=>{
  const c=cacheFixture({state:'MISS'}),error=new NativeJobError('NATIVE_'+state+'_HOLD',409,'WAIT',c.termination),run=noRun();c.read.mockRejectedValue(error);expect(await new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile).catch(error=>error)).toBe(error);expect(c.failure).not.toHaveBeenCalled();expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('an unknown cache state cannot act as MISS',async()=>{
  const c=cacheFixture({state:'PENDING'} as unknown as NativeSemanticCacheRead),run=noRun();await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.failure).toHaveBeenCalledTimes(1);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it.each(['RUN','SEAL'] as const)('%s NativeJobError preserves original termination without a second ERROR append or fallback',async phase=>{
  const c=cacheFixture({state:'MISS'}),error=new NativeJobError('NATIVE_RECEIPT_PENDING',409,'WAIT',c.termination),run=vi.fn<NativeRunner['run']>().mockResolvedValue(decoded());if(phase==='RUN')run.mockRejectedValue(error);else c.seal.mockRejectedValue(error);expect(await new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile).catch(error=>error)).toBe(error);expect(run).toHaveBeenCalledTimes(1);expect(c.failure).not.toHaveBeenCalled();expect(c.seal).toHaveBeenCalledTimes(phase==='RUN'?0:1);
});
it('validates input even on a cached hit before read or native runner work',async()=>{
  const c=cacheFixture(recorded()),run=noRun();await expect(new NativeFacade({run},undefined,c.cache).decodeImage(source,{...syntheticProfile,enabled:false})).rejects.toMatchObject({code:'LIMIT_PROFILE_UNCONFIRMED'});expect(c.read).not.toHaveBeenCalled();expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it.each(['INPUT','OUTPUT'] as const)('immutable %s raw limits apply before cache reuse or a new GO',async direction=>{
  const c=cacheFixture(recorded()),run=noRun();c.cache.frameLimits=value=>Object.freeze({...frameLimits,maxBinaryBytes:(value===direction.toLowerCase()?1:frameLimits.maxBinaryBytes)});const facade=new NativeFacade({run},undefined,c.cache);
  if(direction==='INPUT'){await expect(facade.decodeImage(source,syntheticProfile)).rejects.toMatchObject({code:'NATIVE_BINARY_LIMIT'});expect(c.read).not.toHaveBeenCalled();expect(c.failure).not.toHaveBeenCalled();}else await held(()=>facade.decodeImage(source,syntheticProfile),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('refuses extra NativeComputation keys before seal',async()=>{
  const c=cacheFixture({state:'MISS'}),computation=decoded();Object.assign(computation,{result:'not a raw computation'});const run=vi.fn<NativeRunner['run']>().mockResolvedValue(computation);await held(()=>new NativeFacade({run},undefined,c.cache).decodeImage(source,syntheticProfile),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(c.failure).toHaveBeenCalledTimes(1);
});
it('withHooks preserves one bound cache and refuses a different parent binding',async()=>{
  const hooks:NativeRunHooks={intent:async()=>{},consumeGo:async()=>{},observation:async()=>{},termination:async()=>{}},other={...hooks},c=cacheFixture(recorded()),run=noRun(),facade=new NativeFacade({supportsParentHooks:true,run},hooks,c.cache);expect(()=>facade.withHooks(other)).toThrow('NATIVE_SEMANTIC_BINDING_CONFLICT');const same=facade.withHooks(hooks);expect(same.semanticCache).toBe(c.cache);await same.decodeImage(source,syntheticProfile);expect(run).not.toHaveBeenCalled();
});

async function taskCase(task:NativeTask):Promise<{computation:NativeComputation;invoke:(facade:NativeFacade)=>Promise<unknown>}>{
  switch(task){
    case 'DECODE_IMAGE':return {computation:decoded(),invoke:facade=>facade.decodeImage(source,syntheticProfile)};
    case 'RENDER_PAGE':return {computation:{metadata:{layout:{rendererVersion:'pango-canonical-v1',qa:'NOT_RUN',holdReasons:[],blocks:[]},bytesBlobId:'render',bytesLength:source.length,overlays:[]},blobs:new Map([['render',source]])},invoke:facade=>facade.renderPageDetailed(source,emptyData(),fonts,syntheticProfile)};
    case 'POLYGON_MASK':return {computation:{metadata:{width:12,height:10,pngBlobId:'mask-png',pngByteLength:source.length,pixelsBlobId:'mask-pixels',pixelsByteLength:120},blobs:new Map([['mask-png',source],['mask-pixels',Buffer.alloc(120)]])},invoke:facade=>facade.binaryPolygonMask([[{x:1,y:1},{x:7,y:1},{x:1,y:7}]],12,10,syntheticProfile)};
    case 'SYNTHETIC_CLEANUP':return {computation:{metadata:{width:12,height:10,maskBlobId:'mask',maskByteLength:source.length,cleanedBlobId:'cleaned',cleanedByteLength:source.length,outsideChangedPixels:0},blobs:new Map([['mask',source],['cleaned',source]])},invoke:facade=>facade.syntheticCleanup(source,emptyData(),[],syntheticProfile)};
    case 'COMPOSITE_MASKED':return {computation:{metadata:{width:12,height:10,pngBlobId:'composed',pngByteLength:source.length,outsideChangedPixels:0,maskSha256:sha256(source)},blobs:new Map([['composed',source]])},invoke:facade=>facade.compositeMaskedPixels(source,source,source,syntheticProfile)};
    case 'GEMINI_PREPARE':{const f=await pageFixture();return {computation:preparedComputation(f.prepared),invoke:facade=>facade.prepareScopedMaterial(f.input,source,fonts,syntheticProfile)};}
    case 'GEMINI_APPLY':{const f=await pageFixture(),id=randomUUID(),data=await applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,[id]);return {computation:{metadata:{data},blobs:new Map()},invoke:facade=>facade.applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,[id])};}
    case 'ZIP_READ':return {computation:{metadata:{entries:[{name:'owned.txt',blobId:'zip-entry-0',byteLength:11},{name:'empty.txt',blobId:'zip-entry-1',byteLength:0}]},blobs:new Map([['zip-entry-0',Buffer.from('owned cache')],['zip-entry-1',Buffer.alloc(0)]])},invoke:facade=>facade.readZip(archive,syntheticProfile)};
    case 'ZIP_WRITE':return {computation:{metadata:{archiveBlobId:'archive',byteLength:archive.length},blobs:new Map([['archive',archive]])},invoke:facade=>facade.writeZip(new Map([['owned.txt',Buffer.from('owned cache')],['empty.txt',Buffer.alloc(0)]]),syntheticProfile)};
  }
}
it.each(['DECODE_IMAGE','RENDER_PAGE','POLYGON_MASK','SYNTHETIC_CLEANUP','COMPOSITE_MASKED','GEMINI_PREPARE','GEMINI_APPLY','ZIP_READ','ZIP_WRITE'] as const)('%s seals checked raw computation for MISS and VERIFIED with original output checks',async task=>{
  const f=await taskCase(task);
  for(const state of ['MISS','VERIFIED'] as const){const c=cacheFixture({state:'MISS'}),run=vi.fn<NativeRunner['run']>().mockResolvedValue(f.computation);if(state==='VERIFIED')c.read.mockImplementation(async(actual,metadata,blobs)=>recordedFor(actual,metadata,blobs,f.computation));await f.invoke(new NativeFacade({run},undefined,c.cache));expect(run).toHaveBeenCalledTimes(state==='MISS'?1:0);expect(c.seal).toHaveBeenCalledTimes(1);expect(c.seal.mock.calls[0][0]).toBe(task);expect(c.seal.mock.calls[0][3]).toEqual(f.computation);expect(Object.keys(c.seal.mock.calls[0][3]).sort()).toEqual(['blobs','metadata']);expect(c.failure).not.toHaveBeenCalled();}
});
function fontBundle(){const blobs=new Map<string,Buffer>();return {fonts:{catalog:fonts.catalog,blobs:[...fonts.catalog.fonts,fonts.catalog.license].map((item,index)=>{const blobId='font-'+index;blobs.set(blobId,fonts.bytes.get(item.id)!);return {id:item.id,blobId};})},blobs};}
it.each(['OMITTED','SAME','DIFFERENT'] as const)('cached GEMINI_APPLY %s parent IDs preserves original novel IDs or remains conflict HOLD',async supplied=>{
  const f=await pageFixture(),originalId=randomUUID(),data=await applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,[originalId]),bundle=fontBundle(),computation:NativeComputation={metadata:{data},blobs:new Map()},saved=recordedFor('GEMINI_APPLY',{profile:syntheticProfile,input:f.input,proposal:f.proposal,plan:f.prepared.plan,fonts:bundle.fonts,novelRegionIds:[originalId]},bundle.blobs,computation),c=cacheFixture(saved),run=noRun();f.input.claimGeneration='2';const requested=supplied==='OMITTED'?undefined:[supplied==='SAME'?originalId:randomUUID()],facade=new NativeFacade({run},undefined,c.cache);
  if(supplied==='DIFFERENT'){await held(()=>facade.applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,requested),c.termination);expect(c.failure.mock.calls[0][4]).toMatchObject({code:'NATIVE_SEMANTIC_ID_CONFLICT'});expect(c.seal).not.toHaveBeenCalled();}else{const actual=await facade.applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,requested);expect(actual).toEqual(data);expect(actual.blocks.map(block=>block.regionId)).toEqual([originalId]);expect(c.seal).toHaveBeenCalledTimes(1);expect(c.failure).not.toHaveBeenCalled();}expect(run).not.toHaveBeenCalled();expect(data.blocks.map(block=>block.regionId)).toEqual([originalId]);
});
it('GEMINI novel ID count changes the semantic identity and cannot reuse an old output',async()=>{
  const f=await pageFixture(),originalId=randomUUID(),data=await applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,[originalId]),bundle=fontBundle(),saved=recordedFor('GEMINI_APPLY',{profile:syntheticProfile,input:f.input,proposal:f.proposal,plan:f.prepared.plan,fonts:bundle.fonts,novelRegionIds:[originalId]},bundle.blobs,{metadata:{data},blobs:new Map()}),c=cacheFixture(saved),run=noRun();await held(()=>new NativeFacade({run},undefined,c.cache).applyScopedProposal(f.input,f.proposal,f.prepared.plan,fonts,syntheticProfile,[randomUUID(),randomUUID()]),c.termination);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('cached GEMINI_PREPARE uses the existing claim-generation normalization and original crop checks',async()=>{
  const f=await pageFixture(),bundle=fontBundle(),computation=preparedComputation(f.prepared),saved=recordedFor('GEMINI_PREPARE',{profile:syntheticProfile,input:f.input,sourceBlobId:'source',fonts:bundle.fonts},new Map([['source',source],...bundle.blobs]),computation),c=cacheFixture(saved),run=noRun();f.input.claimGeneration='8';expect(await new NativeFacade({run},undefined,c.cache).prepareScopedMaterial(f.input,source,fonts,syntheticProfile)).toEqual(f.prepared);expect(run).not.toHaveBeenCalled();expect(c.seal).toHaveBeenCalledTimes(1);
});
it.each(['SCOPE','PROPOSAL','LAYOUT','BINARY_MASK'] as const)('cached %s validation fails before seal using the existing method checks',async check=>{
  const task=check==='SCOPE'?'GEMINI_PREPARE':check==='PROPOSAL'?'GEMINI_APPLY':check==='LAYOUT'?'RENDER_PAGE':'POLYGON_MASK',f=await taskCase(task),c=cacheFixture({state:'MISS'}),run=noRun();
  if(check==='SCOPE')(f.computation.metadata.material as Record<string,unknown>).scopeDigest=sha256('wrong-scope');
  if(check==='PROPOSAL')(f.computation.metadata.data as EditData).blocks[0].sourceText.value='unproposed change';
  if(check==='LAYOUT')(f.computation.metadata.layout as Record<string,unknown>).qa='HOLD';
  if(check==='BINARY_MASK')f.computation.blobs.get('mask-pixels')![0]=127;
  c.read.mockImplementation(async(actual,metadata,blobs)=>recordedFor(actual,metadata,blobs,f.computation));await held(()=>f.invoke(new NativeFacade({run},undefined,c.cache)),c.termination);expect(c.failure).toHaveBeenCalledTimes(1);expect(c.seal).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('a validated cached render QA HOLD seals the complete result before the existing RenderLayoutHold',async()=>{
  const f=await pageFixture(),block=f.data.blocks[0];f.data.renderSpecification!.blocks[0].rendererVersion='pango-overflow-v2';const computation:NativeComputation={metadata:{layout:{rendererVersion:'pango-mixed-v2',qa:'HOLD',holdReasons:['OVERFLOW_TOLERANCE_UNMEASURED'],blocks:[{regionId:block.regionId,rendererVersion:'pango-overflow-v2',fontSizePx:20,minimumFontSizePx:10,fallbackAtMinimum:false,angleDegrees:0,glyphBounds:null,glyphPixels:0,glyphPixelsOutsidePolygon:0,glyphPixelsOutsidePage:0,glyphPixelsInsideOtherPolygons:[]}]},bytesBlobId:null,bytesLength:null,overlays:[]},blobs:new Map()},c=cacheFixture({state:'MISS'}),run=noRun();c.read.mockImplementation(async(task,metadata,blobs)=>recordedFor(task,metadata,blobs,computation));const error=await new NativeFacade({run},undefined,c.cache).renderPage(source,f.data,fonts,syntheticProfile).catch(error=>error);expect(error).toBeInstanceOf(RenderLayoutHold);expect(error.result).toMatchObject({bytes:null,layout:{qa:'HOLD'},overlays:[]});expect(c.seal).toHaveBeenCalledTimes(1);expect(c.failure).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
const controllerLimits:NativeLimits={maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:2*1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:16*1024*1024};
it('controller captures fixed source/runtime identity separately from verification version and immutable frame bounds',()=>{
  identityTrace.enabled=true;const supplied={...controllerLimits},controller=NativeController.owned({profile:syntheticProfile,limits:supplied}),first=controller.kernelImplementationDigest,input=controller.frameLimits('input'),output=controller.frameLimits('output');expect(first).toMatch(/^[a-f0-9]{64}$/);expect(input).toEqual({maxMetadataBytes:supplied.maxMetadataBytes,maxBinaryBytes:supplied.maxInputBytes,maxItems:supplied.maxItems});expect(output.maxBinaryBytes).toBe(supplied.maxOutputBytes);expect(Object.isFrozen(input)&&Object.isFrozen(output)).toBe(true);supplied.maxInputBytes=1;expect(controller.frameLimits('input')).toEqual(input);expect(()=>Object.assign(input,{maxBinaryBytes:1})).toThrow();
  expect(identityTrace.paths).toHaveLength(29);expect(identityTrace.paths.some(file=>file.endsWith('/package-lock.json'))).toBe(true);expect(identityTrace.paths.some(file=>file.endsWith('/native/src/bootstrap.mjs'))).toBe(true);expect(identityTrace.paths.some(file=>file.endsWith('/native/src/facade.ts'))).toBe(false);identityTrace.alterKernel=true;expect(nativeKernelImplementationDigest()).not.toBe(first);expect(controller.kernelImplementationDigest).toBe(first);expect(nativeFacadeVerificationVersion).toBe('native-facade-verification-v1');expect(()=>controller.frameLimits('other' as 'input')).toThrow('NATIVE_LIMIT_UNCONFIRMED');controller.stopClaims();
});
it('a missing pinned module refuses parent construction instead of accepting an old implementation identity',()=>{
  identityTrace.enabled=true;identityTrace.missingBootstrap=true;expect(()=>NativeController.owned({profile:syntheticProfile,limits:controllerLimits})).toThrow('NATIVE_IMPLEMENTATION_UNCONFIRMED');
});
