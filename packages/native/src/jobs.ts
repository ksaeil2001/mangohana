import pinnedCatalog from '../../../assets/fonts/catalog.json' with {type:'json'};
import {digest,sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {assertWire,validUnicode} from '../../contracts/src/validation.js';
import {validateEditData} from '../../domain/src/scope.js';
import type {EditData} from '../../domain/src/model.js';
import type {StageInput} from '../../domain/src/provider.js';
import type {OcrProposal,TranslationProposal} from '../../contracts/src/wire.generated.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import type {MaterialPlan} from '../../providers/src/gemini-material.js';
import type {NativeJob,NativeTask} from './dto.js';
import type {NativeFrame} from './frame.js';

export type NativeFontBundle={catalog:FontCatalog['catalog'];blobs:{id:string;blobId:string}[]};
type Common={profile:MediaProfile};
export type NativeInputs={
  DECODE_IMAGE:Common&{sourceBlobId:string};
  RENDER_PAGE:Common&{sourceBlobId:string;data:EditData;minimumFontSizePx:number;fonts:NativeFontBundle};
  POLYGON_MASK:Common&{width:number;height:number;polygons:{x:number;y:number}[][]};
  SYNTHETIC_CLEANUP:Common&{sourceBlobId:string;data:EditData;regionIds:string[]};
  COMPOSITE_MASKED:Common&{sourceBlobId:string;maskBlobId:string;proposalBlobId:string};
  GEMINI_PREPARE:Common&{input:StageInput;sourceBlobId:string|null;fonts:NativeFontBundle};
  GEMINI_APPLY:Common&{input:StageInput;proposal:OcrProposal|TranslationProposal;plan:MaterialPlan;fonts:NativeFontBundle;novelRegionIds:string[]};
  ZIP_READ:Common&{archiveBlobId:string};
  ZIP_WRITE:Common&{entries:{name:string;blobId:string}[]};
};
const inputCode='NATIVE_INPUT_INVALID';
export function nativeRecord(value:unknown,code=inputCode):Record<string,unknown>{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),code,422);
  return value as Record<string,unknown>;
}
export function nativeKeys(value:unknown,required:string[],optional:string[]=[],code=inputCode):Record<string,unknown>{
  const record=nativeRecord(value,code),allowed=new Set([...required,...optional]);
  requireCondition(required.every(key=>Object.hasOwn(record,key))&&Object.keys(record).every(key=>allowed.has(key)),code,422);return record;
}
export function nativeInteger(value:unknown,minimum:number,maximum=Number.MAX_SAFE_INTEGER,code=inputCode):asserts value is number{
  requireCondition(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum&&value<=maximum,code,422);
}
export function nativeNumber(value:unknown,minimum:number,maximum=Number.MAX_SAFE_INTEGER,code=inputCode):asserts value is number{
  requireCondition(typeof value==='number'&&Number.isFinite(value)&&value>=minimum&&value<=maximum,code,422);
}
export function nativeString(value:unknown,maximum:number,code=inputCode):asserts value is string{
  requireCondition(typeof value==='string'&&value.length<=maximum&&validUnicode(value)&&!value.includes('\0'),code,422);
}
export function nativeId(value:unknown,code=inputCode):asserts value is string{
  requireCondition(typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),code,422);
}
export function nativeHash(value:unknown,code=inputCode):asserts value is string{
  requireCondition(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),code,422);
}
export function nativeDimensions(width:unknown,height:unknown,profile:MediaProfile,code=inputCode):asserts width is number{
  nativeInteger(width,1,profile.maxWidth,code);nativeInteger(height,1,profile.maxHeight,code);
  requireCondition(width*height<=profile.maxPixels,code,422);
}
export function validateNativeProfile(value:unknown):asserts value is MediaProfile{
  const required=['id','kind','enabled','maxImageBytes','maxWidth','maxHeight','maxPixels','maxFilesPerUpload','maxProjectPages','maxProjectSourceBytes','maxZipBytes','maxEntries','maxExpandedBytes','maxRatio','maxManifestBytes','maxTextLength','maxFontSize','maxBlocks'];
  const profile=nativeKeys(value,required,['minReadableFontSizePx']);nativeString(profile.id,160);requireCondition(profile.id.length>0,inputCode,422);
  requireCondition((profile.kind==='SYNTHETIC'||profile.kind==='MEASURED')&&profile.enabled===true,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  for(const key of required.slice(3))if(key==='maxRatio'||key==='maxFontSize')nativeNumber(profile[key],Number.MIN_VALUE);else nativeInteger(profile[key],1);
  if(Object.hasOwn(profile,'minReadableFontSizePx'))nativeNumber(profile.minReadableFontSizePx,Number.MIN_VALUE,profile.maxFontSize as number);
  requireCondition(Number.isSafeInteger((profile.maxWidth as number)*(profile.maxHeight as number))&&Number.isSafeInteger((profile.maxPixels as number)*4+(profile.maxHeight as number)*4+65536),inputCode,422);
}
function editData(value:unknown,profile:MediaProfile,width=profile.maxWidth,height=profile.maxHeight):asserts value is EditData{
  const data=nativeKeys(value,['blocks','geometryContract','renderContract','cleanupQa'],['renderSpecification']);
  requireCondition(Array.isArray(data.blocks)&&data.blocks.length<=profile.maxBlocks&&['source-pixels-v1','synthetic-v1'].includes(data.geometryContract as string)&&['pango-canonical-v1','synthetic-v1'].includes(data.renderContract as string)&&['NOT_RUN','NEEDS_REVIEW','PASSED','FAILED'].includes(data.cleanupQa as string),inputCode,422);
  validateEditData(value as EditData,width,height);
  for(const block of (value as EditData).blocks){nativeString(block.sourceText.value,profile.maxTextLength);nativeString(block.translatedText.value,profile.maxTextLength);nativeNumber(block.fontSizePx,Number.MIN_VALUE,profile.maxFontSize);}
}
const safeName=(name:unknown):name is string=>typeof name==='string'&&name.length<=160&&/^[A-Za-z0-9._/-]+$/.test(name)&&!name.startsWith('/')&&!name.endsWith('/')&&!name.split('/').some(part=>!part||part==='.'||part==='..');
export const nativeZipEntryName=safeName;
function point(value:unknown,width:number,height:number):void{const item=nativeKeys(value,['x','y']);nativeNumber(item.x,0,width);nativeNumber(item.y,0,height);}
function stageInput(value:unknown,profile:MediaProfile):asserts value is StageInput{
  const input=nativeKeys(value,['executionId','requestId','stage','inputDigest','settings','scope','originalAssetId','initialData','previousData','width','height'],['paintInclusion','paintStrokes','accountId','contextId','claimGeneration','currentCleanedAssetId','currentRenderAssetId','assetDependencies','previousOutputAssetIds','envelope']);
  for(const key of ['executionId','requestId','originalAssetId'])nativeId(input[key]);nativeHash(input.inputDigest);
  requireCondition(input.stage==='OCR'||input.stage==='TRANSLATE',inputCode,422);assertWire('settings',input.settings);
  nativeDimensions(input.width,input.height,profile);const width=input.width as number,height=input.height as number;
  editData(input.initialData,profile,width,height);if(input.previousData!==null)editData(input.previousData,profile,width,height);
  const scope=nativeRecord(input.scope);if(scope.kind==='PAGE')nativeKeys(scope,['kind']);else if(scope.kind==='REGIONS'){
    nativeKeys(scope,['kind','regionIds']);requireCondition(Array.isArray(scope.regionIds)&&scope.regionIds.length>0&&scope.regionIds.length<=profile.maxBlocks,inputCode,422);for(const id of scope.regionIds)nativeId(id);requireCondition(new Set(scope.regionIds).size===scope.regionIds.length,inputCode,422);
  }else{nativeKeys(scope,['kind','selectionId']);requireCondition(scope.kind==='PAINTED',inputCode,422);nativeId(scope.selectionId);requireCondition(input.paintInclusion==='ANY_OVERLAP'||input.paintInclusion==='CENTER',inputCode,422);}
  if(Object.hasOwn(input,'paintInclusion'))requireCondition(input.paintInclusion==='ANY_OVERLAP'||input.paintInclusion==='CENTER',inputCode,422);
  if(Object.hasOwn(input,'paintStrokes')){requireCondition(Array.isArray(input.paintStrokes),inputCode,422);for(const stroke of input.paintStrokes){const item=nativeKeys(stroke,['radiusPx','points']);nativeNumber(item.radiusPx,Number.MIN_VALUE);requireCondition(Array.isArray(item.points)&&item.points.length>0,inputCode,422);for(const itemPoint of item.points)point(itemPoint,width,height);}}
  for(const key of ['accountId','contextId'])if(Object.hasOwn(input,key))nativeId(input[key]);
  for(const key of ['currentCleanedAssetId','currentRenderAssetId'])if(Object.hasOwn(input,key)&&input[key]!==null)nativeId(input[key]);
  if(Object.hasOwn(input,'claimGeneration'))requireCondition(typeof input.claimGeneration==='string'&&/^[1-9]\d{0,18}$/.test(input.claimGeneration),inputCode,422);
  requireCondition(input.envelope&&input.assetDependencies, inputCode,422);assertWire('stageInputEnvelope',input.envelope);
  requireCondition(Array.isArray(input.assetDependencies)&&input.assetDependencies.length<=profile.maxEntries,inputCode,422);
  for(const entry of input.assetDependencies){const dependency=nativeKeys(entry,['assetId','sha256','bytesLength','mediaType']);nativeId(dependency.assetId);nativeHash(dependency.sha256);requireCondition(typeof dependency.bytesLength==='string'&&/^(0|[1-9]\d{0,18})$/.test(dependency.bytesLength),inputCode,422);nativeString(dependency.mediaType,80);}
  if(Object.hasOwn(input,'previousOutputAssetIds')){requireCondition(Array.isArray(input.previousOutputAssetIds)&&input.previousOutputAssetIds.length<=profile.maxEntries,inputCode,422);for(const id of input.previousOutputAssetIds)nativeId(id);}
}
export function validateNativeMaterialPlan(value:unknown,profile:MediaProfile):asserts value is MaterialPlan{
  const plan=nativeKeys(value,['version','coordinateContract','inputFingerprint','scopeDigest','stage','selectedRegionIds','crops','texts','fontCatalogVersion','parameterProfileVersion','maskSampleCount']);
  requireCondition(plan.version===1&&plan.coordinateContract==='PAGE_GLOBAL_SOURCE_PIXELS_V1'&&(plan.stage==='OCR'||plan.stage==='TRANSLATE'),inputCode,422);nativeHash(plan.inputFingerprint);nativeHash(plan.scopeDigest);nativeString(plan.fontCatalogVersion,160);nativeString(plan.parameterProfileVersion,160);nativeInteger(plan.maskSampleCount,0);
  requireCondition(Array.isArray(plan.selectedRegionIds)&&plan.selectedRegionIds.length<=profile.maxBlocks&&new Set(plan.selectedRegionIds).size===plan.selectedRegionIds.length,inputCode,422);for(const id of plan.selectedRegionIds)nativeId(id);
  requireCondition(Array.isArray(plan.crops)&&plan.crops.length<=profile.maxBlocks+1&&Array.isArray(plan.texts)&&plan.texts.length<=profile.maxBlocks,inputCode,422);
  for(const crop of plan.crops){const item=nativeKeys(crop,['inputRegionId','requiredReadingOrder','origin','width','height','pngSha256','maskSha256','allowedPolygon']);if(item.inputRegionId!==null)nativeId(item.inputRegionId);if(item.requiredReadingOrder!==null)nativeInteger(item.requiredReadingOrder,0);point(item.origin,profile.maxWidth,profile.maxHeight);nativeDimensions(item.width,item.height,profile);nativeHash(item.pngSha256);nativeHash(item.maskSha256);if(item.allowedPolygon!==null){requireCondition(Array.isArray(item.allowedPolygon)&&item.allowedPolygon.length>=3,inputCode,422);for(const itemPoint of item.allowedPolygon)point(itemPoint,profile.maxWidth,profile.maxHeight);}}
  for(const text of plan.texts){const item=nativeKeys(text,['regionId','sha256']);nativeId(item.regionId);nativeHash(item.sha256);}
}
export function validateNativeInput<T extends NativeTask>(task:T,metadata:unknown,blobs:Map<string,Buffer>,expectedProfileDigest?:string):NativeInputs[T]{
  const required:Record<NativeTask,string[]>={DECODE_IMAGE:['sourceBlobId'],RENDER_PAGE:['sourceBlobId','data','minimumFontSizePx','fonts'],POLYGON_MASK:['width','height','polygons'],SYNTHETIC_CLEANUP:['sourceBlobId','data','regionIds'],COMPOSITE_MASKED:['sourceBlobId','maskBlobId','proposalBlobId'],GEMINI_PREPARE:['input','sourceBlobId','fonts'],GEMINI_APPLY:['input','proposal','plan','fonts','novelRegionIds'],ZIP_READ:['archiveBlobId'],ZIP_WRITE:['entries']};
  requireCondition(Object.hasOwn(required,task),inputCode,422);const input=nativeKeys(metadata,['profile',...required[task]]);validateNativeProfile(input.profile);const profile=input.profile;
  if(expectedProfileDigest!==undefined)requireCondition(digest(profile)===expectedProfileDigest,inputCode,422);
  requireCondition(blobs instanceof Map,inputCode,422);const consumed=new Set<string>();
  const blob=(id:unknown,maximum:number,minimum=1)=>{requireCondition(typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)&&!consumed.has(id),inputCode,422);const bytes=blobs.get(id);requireCondition(Buffer.isBuffer(bytes)&&bytes.length>=minimum&&bytes.length<=maximum,inputCode,422);consumed.add(id);return bytes;};
  if(Object.hasOwn(input,'fonts')){const fonts=nativeKeys(input.fonts,['catalog','blobs']);requireCondition(digest(fonts.catalog)===digest(pinnedCatalog)&&Array.isArray(fonts.blobs)&&fonts.blobs.length===pinnedCatalog.fonts.length+1,'INPUT_DEPENDENCY_INVALID',409,'WAIT');const dependencies=[...pinnedCatalog.fonts,pinnedCatalog.license],ids=new Set<string>();for(const item of fonts.blobs){const reference=nativeKeys(item,['id','blobId']);requireCondition(typeof reference.id==='string'&&!ids.has(reference.id),'INPUT_DEPENDENCY_INVALID',409,'WAIT');const dependency=dependencies.find(entry=>entry.id===reference.id);requireCondition(dependency,'INPUT_DEPENDENCY_INVALID',409,'WAIT');const bytes=blob(reference.blobId,Number(dependency.bytesLength));requireCondition(String(bytes.length)===dependency.bytesLength&&sha256(bytes)===dependency.sha256,'INPUT_DEPENDENCY_INVALID',409,'WAIT');ids.add(reference.id);}}
  switch(task){
    case 'DECODE_IMAGE':blob(input.sourceBlobId,profile.maxImageBytes);break;
    case 'RENDER_PAGE':blob(input.sourceBlobId,profile.maxImageBytes);editData(input.data,profile);nativeNumber(input.minimumFontSizePx,Number.MIN_VALUE,profile.maxFontSize);break;
    case 'POLYGON_MASK':{nativeDimensions(input.width,input.height,profile);requireCondition(Array.isArray(input.polygons)&&input.polygons.length<=profile.maxBlocks,inputCode,422);for(const polygon of input.polygons){requireCondition(Array.isArray(polygon)&&polygon.length>=3,inputCode,422);for(const item of polygon)point(item,input.width as number,input.height as number);}break;}
    case 'SYNTHETIC_CLEANUP':blob(input.sourceBlobId,profile.maxImageBytes);editData(input.data,profile);requireCondition(Array.isArray(input.regionIds)&&input.regionIds.length<=profile.maxBlocks&&new Set(input.regionIds).size===input.regionIds.length,inputCode,422);for(const id of input.regionIds)nativeId(id);break;
    case 'COMPOSITE_MASKED':blob(input.sourceBlobId,profile.maxImageBytes);blob(input.maskBlobId,profile.maxImageBytes);blob(input.proposalBlobId,profile.maxImageBytes);break;
    case 'GEMINI_PREPARE':stageInput(input.input,profile);if(input.sourceBlobId!==null)blob(input.sourceBlobId,profile.maxImageBytes);requireCondition(input.input.stage==='OCR'?input.sourceBlobId!==null:input.sourceBlobId===null,inputCode,422);break;
    case 'GEMINI_APPLY':{stageInput(input.input,profile);validateNativeMaterialPlan(input.plan,profile);assertWire(input.input.stage==='OCR'?'ocrProposal':'translationProposal',input.proposal);const proposal=input.proposal as OcrProposal|TranslationProposal;if('regions'in proposal){requireCondition(proposal.regions.length<=profile.maxBlocks,inputCode,422);for(const region of proposal.regions)nativeString(region.sourceText,profile.maxTextLength);}else{requireCondition(proposal.items.length<=profile.maxBlocks,inputCode,422);for(const item of proposal.items)nativeString(item.targetText,profile.maxTextLength);}requireCondition(Array.isArray(input.novelRegionIds)&&input.novelRegionIds.length<=profile.maxBlocks,inputCode,422);for(const id of input.novelRegionIds)nativeId(id);const ids=input.novelRegionIds.map(id=>(id as string).toLowerCase());requireCondition(new Set(ids).size===ids.length&&!((input.input.previousData??input.input.initialData).blocks.some(block=>ids.includes(block.regionId.toLowerCase()))),inputCode,422);break;}
    case 'ZIP_READ':blob(input.archiveBlobId,profile.maxZipBytes);break;
    case 'ZIP_WRITE':{requireCondition(Array.isArray(input.entries)&&input.entries.length<=profile.maxEntries,inputCode,422);const names=new Set<string>();let total=0;for(const entry of input.entries){const item=nativeKeys(entry,['name','blobId']);requireCondition(safeName(item.name)&&!names.has(item.name.normalize('NFC').toLowerCase()),inputCode,422);names.add(item.name.normalize('NFC').toLowerCase());const bytes=blob(item.blobId,profile.maxExpandedBytes,0);total+=bytes.length;requireCondition(Number.isSafeInteger(total)&&total<=profile.maxExpandedBytes,inputCode,422);}break;}
  }
  requireCondition(consumed.size===blobs.size,inputCode,422);return input as NativeInputs[T];
}
export function validateNativeJob(frame:NativeFrame<NativeJob>):void{
  requireCondition(frame.blobs.size===frame.envelope.blobs.length,inputCode,422);
  const ids=new Set<string>();for(const descriptor of frame.envelope.blobs){const bytes=frame.blobs.get(descriptor.id);requireCondition(!ids.has(descriptor.id)&&bytes&&descriptor.byteLength===bytes.length&&descriptor.sha256===sha256(bytes),inputCode,422);ids.add(descriptor.id);}
  validateNativeInput(frame.envelope.task,frame.envelope.metadata,frame.blobs,frame.envelope.profileDigest);
}
