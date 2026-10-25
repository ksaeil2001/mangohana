import {proposalRendererVersion} from '../../media/src/render-policy.js';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../storage/src/database.js';
import type {Assets} from '../../domain/src/assets.js';
import type {EditData,RequestRow,SourceResultCapture} from '../../domain/src/model.js';
import {storedInput,canonicalInput,type StageInput} from '../../domain/src/provider.js';
import {painted,validateEditData} from '../../domain/src/scope.js';
import type {FontCatalog} from '../../media/src/fonts.js';
import type {MediaProfile} from '../../media/src/profile.js';
import {decodeImage} from '../../media/src/images.js';
import {binaryPolygonMask} from '../../media/src/mask.js';
import {assertWire} from '../../contracts/src/validation.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';
import type {Block,OcrProposal,TranslationProposal} from '../../contracts/src/wire.generated.js';
import type {ScopedMaterial} from './gemini.js';
import type {NativeFacade} from '../../native/src/facade.js';
import {validateNativeMaterialPlan} from '../../native/src/jobs.js';

type Point={x:number;y:number};
type CropPlan={inputRegionId:string|null;requiredReadingOrder:number|null;origin:Point;width:number;height:number;pngSha256:string;maskSha256:string;allowedPolygon:Point[]|null};
export type MaterialPlan={version:1;coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1';inputFingerprint:string;scopeDigest:string;stage:'OCR'|'TRANSLATE';selectedRegionIds:string[];crops:CropPlan[];texts:{regionId:string;sha256:string}[];fontCatalogVersion:string;parameterProfileVersion:string;maskSampleCount:number};
type ConsumptionCapture={version:1;promptContract:'gemini-scoped-material-v1';inputFingerprint:string;executionId:string;requestId:string;contextId:string;contextGeneration:string;pageLineageId:string;sourceResultCapture:SourceResultCapture|null;dataSource:'INITIAL_DATA'|'PREVIOUS_DATA';initialDataDigest:string;previousDataDigest:string|null;checkpointDependencies:NonNullable<StageInput['envelope']>['checkpointDependencies'];texts:{regionId:string;sourceTextStatus:Block['sourceText']['status'];sha256:string}[]};
type MaterialEvidence=MaterialPlan|{version:2;plan:MaterialPlan;consumptionCapture:ConsumptionCapture};
const distance=(p:Point,a:Point,b:Point)=>{const dx=b.x-a.x,dy=b.y-a.y,t=dx===0&&dy===0?0:Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
const inside=(p:Point,polygon:Point[])=>{let value=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if(distance(p,a,b)<=1e-9)return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)value=!value;}return value;};
const selection=(input:StageInput,data:EditData):Block[]=>{
  if(input.scope.kind==='PAINTED')requireCondition(input.paintInclusion&&input.paintStrokes?.length,'SCOPE_INVALID',422);
  if(input.scope.kind==='REGIONS')requireCondition(input.scope.regionIds.length>0&&new Set(input.scope.regionIds).size===input.scope.regionIds.length&&input.scope.regionIds.every(id=>data.blocks.some(block=>block.regionId===id)),'SCOPE_INVALID',422);
  return data.blocks.filter(block=>input.scope.kind==='PAGE'||(input.scope.kind==='REGIONS'?input.scope.regionIds.includes(block.regionId):painted(block,input.paintStrokes!,input.paintInclusion!)));
};
const fingerprint=(input:StageInput)=>digest(canonicalInput(input));
function validateInput(input:StageInput,fonts:FontCatalog,profile:MediaProfile):{data:EditData;selected:Block[]}{
  requireCondition(input.accountId&&input.contextId&&input.envelope&&['OCR','TRANSLATE'].includes(input.stage)&&profile.enabled,'INPUT_DEPENDENCY_INVALID',409,'WAIT');assertWire('stageInputEnvelope',input.envelope);
  const envelope=input.envelope;
  requireCondition(envelope.executionId===input.executionId&&envelope.requestId===input.requestId&&envelope.contextId===input.contextId&&envelope.logicalStepId===input.stage&&envelope.inputDigest===input.inputDigest&&envelope.stageContract===input.settings.contractVersion&&digest(envelope.capturedSettings)===digest(input.settings)&&envelope.parameterProfileVersion===profile.id,'INPUT_DEPENDENCY_INVALID',409,'WAIT');
  requireCondition(Number.isSafeInteger(input.width)&&Number.isSafeInteger(input.height)&&input.width>0&&input.height>0&&input.width<=profile.maxWidth&&input.height<=profile.maxHeight&&input.width*input.height<=profile.maxPixels,'SCOPE_INVALID',422);
  const data=input.previousData??input.initialData;validateEditData(data,input.width,input.height);requireCondition(data.geometryContract==='source-pixels-v1'&&data.renderContract==='pango-canonical-v1'&&data.blocks.length<=profile.maxBlocks&&(!data.renderSpecification||data.renderSpecification.fontCatalogVersion===fonts.catalog.version),'INPUT_DEPENDENCY_INVALID',409,'WAIT');
  const selected=selection(input,data),ids=selected.map(block=>block.regionId);requireCondition(digest(ids)===digest(envelope.regionIds),'SCOPE_INVALID',422);
  requireCondition(input.assetDependencies&&new Set(input.assetDependencies.map(item=>item.assetId)).size===input.assetDependencies.length&&digest(envelope.assetIds)===digest(input.assetDependencies.map(item=>item.assetId))&&envelope.assetIds.includes(input.originalAssetId),'INPUT_DEPENDENCY_INVALID',409,'WAIT');
  return {data,selected};
}
function checkFont(input:StageInput,fonts:FontCatalog):void{
  const font=fonts.font(input.settings.fontAssetId);for(const id of [font.id,font.licenseId]){const bytes=fonts.bytes.get(id),dependency=input.assetDependencies?.find(item=>item.assetId===id);requireCondition(bytes&&dependency&&sha256(bytes)===dependency.sha256&&String(bytes.length)===dependency.bytesLength,'INPUT_DEPENDENCY_INVALID',409,'WAIT');}
}
export async function prepareScopedMaterial(input:StageInput,source:Buffer|null,fonts:FontCatalog,profile:MediaProfile):Promise<{material:ScopedMaterial;plan:MaterialPlan}>{
  const {selected}=validateInput(input,fonts,profile);checkFont(input,fonts);
  const crops:CropPlan[]=[],images:ScopedMaterial['images']=[],texts:ScopedMaterial['sourceTexts']=[];let maskSampleCount=0;
  if(input.stage==='TRANSLATE'){
    requireCondition(selected.length>0,'SCOPE_INVALID',422);for(const block of selected){requireCondition(block.sourceText.value.length<=profile.maxTextLength,'SCOPE_INVALID',422);texts.push({inputRegionId:block.regionId,sourceText:block.sourceText.value});}
  }else{
    requireCondition(source,'INPUT_DEPENDENCY_INVALID',409,'WAIT');const dependency=input.assetDependencies!.find(item=>item.assetId===input.originalAssetId);requireCondition(dependency&&sha256(source)===dependency.sha256&&String(source.length)===dependency.bytesLength,'INPUT_DEPENDENCY_INVALID',409,'WAIT');
    const decoded=await decodeImage(source,profile);requireCondition(decoded.width===input.width&&decoded.height===input.height&&decoded.mediaType===dependency.mediaType,'INPUT_DEPENDENCY_INVALID',409,'WAIT');const pixels=await sharp(decoded.canonicalPng).ensureAlpha().raw().toBuffer();
    const box=(points:Point[],radius=0)=>({left:Math.max(0,Math.floor(Math.min(...points.map(point=>point.x))-radius)),top:Math.max(0,Math.floor(Math.min(...points.map(point=>point.y))-radius)),right:Math.min(input.width,Math.ceil(Math.max(...points.map(point=>point.x))+radius)),bottom:Math.min(input.height,Math.ceil(Math.max(...points.map(point=>point.y))+radius))});
    const add=async(region:Block|null,bounds:{left:number;top:number;right:number;bottom:number},allowed:(point:Point)=>boolean,emptyAllowed=false)=>{
      const stride=bounds.right-bounds.left,mask=Buffer.alloc(stride*(bounds.bottom-bounds.top));let left=bounds.right,top=bounds.bottom,right=-1,bottom=-1;
      for(let y=bounds.top;y<bounds.bottom;y++)for(let x=bounds.left;x<bounds.right;x++){maskSampleCount++;if(allowed({x:x+0.5,y:y+0.5})){mask[(y-bounds.top)*stride+x-bounds.left]=255;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}}
      if(emptyAllowed&&(right<left||bottom<top))return;requireCondition(right>=left&&bottom>=top,'SCOPE_INVALID',422);const width=right-left+1,height=bottom-top+1,rgba=Buffer.alloc(width*height*4,255),localMask=Buffer.alloc(width*height);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const sourceAt=(top+y)*input.width+left+x,at=y*width+x;if(mask[(top+y-bounds.top)*stride+left+x-bounds.left]){pixels.copy(rgba,at*4,sourceAt*4,sourceAt*4+4);localMask[at]=255;}}
      // All four channels outside the mask are replaced before encoding, including hidden transparent RGB.
      const bytes=await sharp(rgba,{raw:{width,height,channels:4}}).png({compressionLevel:6}).toBuffer();requireCondition(bytes.length<=profile.maxImageBytes,'SCOPE_INVALID',422);
      const crop:CropPlan={inputRegionId:region?.regionId??null,requiredReadingOrder:region?.geometry.readingOrder??null,origin:{x:left,y:top},width,height,pngSha256:sha256(bytes),maskSha256:sha256(localMask),allowedPolygon:region?.geometry.polygon??null};crops.push(crop);images.push({bytes,mediaType:'image/png',scopeDigest:'',coordinateOrigin:crop.origin,width,height,inputRegionId:crop.inputRegionId,requiredReadingOrder:crop.requiredReadingOrder,maskSha256:crop.maskSha256});
    };
    if(input.scope.kind==='PAGE')await add(null,{left:0,top:0,right:input.width,bottom:input.height},()=>true);
    else{
      for(const block of selected)await add(block,box(block.geometry.polygon),point=>inside(point,block.geometry.polygon));
      if(input.scope.kind==='PAINTED'){
        const strokes=input.paintStrokes!;requireCondition(strokes.every(stroke=>Number.isFinite(stroke.radiusPx)&&stroke.radiusPx>0&&stroke.points.length>0&&stroke.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<=input.width&&point.y<=input.height)),'SCOPE_INVALID',422);
        const allowed=(point:Point)=>!selected.some(block=>inside(point,block.geometry.polygon))&&strokes.some(stroke=>stroke.points.some((a,index)=>distance(point,a,stroke.points[index+1]??a)<=stroke.radiusPx));
        const boxes=strokes.map(stroke=>box(stroke.points,stroke.radiusPx));const bounds={left:Math.min(...boxes.map(item=>item.left)),top:Math.min(...boxes.map(item=>item.top)),right:Math.max(...boxes.map(item=>item.right)),bottom:Math.max(...boxes.map(item=>item.bottom))};await add(null,bounds,allowed,true);
      }
      requireCondition(images.length>0,'SCOPE_INVALID',422);
    }
  }
  const scopeDigest=digest({version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint:fingerprint(input),scope:input.scope,paintStrokes:input.paintStrokes??[],paintInclusion:input.paintInclusion??null,crops,texts:texts.map(item=>({regionId:item.inputRegionId,sha256:sha256(item.sourceText)}))});for(const image of images)image.scopeDigest=scopeDigest;
  const plan:MaterialPlan={version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint:fingerprint(input),scopeDigest,stage:input.stage as 'OCR'|'TRANSLATE',selectedRegionIds:selected.map(block=>block.regionId),crops,texts:texts.map(item=>({regionId:item.inputRegionId,sha256:sha256(item.sourceText)})),fontCatalogVersion:fonts.catalog.version,parameterProfileVersion:profile.id,maskSampleCount};
  return {material:{envelope:structuredClone(input.envelope!),stage:plan.stage,images,sourceTexts:texts,scopeDigest},plan};
}
export async function applyScopedProposal(input:StageInput,proposal:OcrProposal|TranslationProposal,plan:MaterialPlan,fonts:FontCatalog,profile:MediaProfile,parentNovelRegionIds?:readonly string[]):Promise<EditData>{
  const {data,selected}=validateInput(input,fonts,profile);checkFont(input,fonts);requireCondition(plan.version===1&&plan.coordinateContract==='PAGE_GLOBAL_SOURCE_PIXELS_V1'&&plan.inputFingerprint===fingerprint(input)&&plan.stage===input.stage&&plan.fontCatalogVersion===fonts.catalog.version&&plan.parameterProfileVersion===profile.id&&digest(plan.selectedRegionIds)===digest(selected.map(block=>block.regionId)),'STAGE_PROPOSAL_INVALID',422);
  const result=structuredClone(data);const ids=new Set(selected.map(block=>block.regionId));let novelIdIndex=0;
  if(parentNovelRegionIds!==undefined){const allocated=parentNovelRegionIds.map(id=>id.toLowerCase());requireCondition(parentNovelRegionIds.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))&&new Set(allocated).size===allocated.length&&!data.blocks.some(block=>allocated.includes(block.regionId.toLowerCase())),'STAGE_PROPOSAL_INVALID',422);}
  if(input.stage==='TRANSLATE'){
    assertWire<TranslationProposal>('translationProposal',proposal);requireCondition(proposal.items.length===selected.length&&new Set(proposal.items.map(item=>item.inputRegionId)).size===selected.length&&proposal.items.every(item=>ids.has(item.inputRegionId))&&digest(plan.texts)===digest(selected.map(block=>({regionId:block.regionId,sha256:sha256(block.sourceText.value)}))),'STAGE_PROPOSAL_INVALID',422);
    for(const item of proposal.items){requireCondition(item.targetText.length<=profile.maxTextLength,'STAGE_PROPOSAL_INVALID',422);const block=result.blocks.find(value=>value.regionId===item.inputRegionId)!;block.translatedText={value:item.targetText,status:'AI_PROPOSED'};block.appliedTranslation={sourceLanguage:input.settings.sourceLanguage,targetLanguage:input.settings.targetLanguage,modelId:input.settings.modelId,reasoningLevel:input.settings.reasoningLevel,modelContract:input.settings.contractVersion,promptContract:'gemini-scoped-material-v1',originExecutionId:input.executionId};}
  }else{
    assertWire<OcrProposal>('ocrProposal',proposal);requireCondition(proposal.regions.length<=profile.maxBlocks&&new Set(proposal.regions.map(region=>region.geometry.readingOrder)).size===proposal.regions.length,'STAGE_PROPOSAL_INVALID',422);
    const known=plan.crops.filter(crop=>crop.inputRegionId!==null),novel=plan.crops.filter(crop=>crop.inputRegionId===null);const consumed=new Set<number>();
    const inCrop=(region:OcrProposal['regions'][number],crop:CropPlan)=>region.geometry.polygon.every(point=>point.x>=crop.origin.x&&point.y>=crop.origin.y&&point.x<=crop.origin.x+crop.width&&point.y<=crop.origin.y+crop.height&&(!crop.allowedPolygon||inside(point,crop.allowedPolygon)));
    for(const crop of known){const matches=proposal.regions.map((region,index)=>({region,index})).filter(({region})=>region.geometry.readingOrder===crop.requiredReadingOrder&&inCrop(region,crop));requireCondition(matches.length===1,'STAGE_PROPOSAL_INVALID',422);const {region,index}=matches[0];consumed.add(index);const block=result.blocks.find(item=>item.regionId===crop.inputRegionId)!;requireCondition(region.sourceText.length<=profile.maxTextLength,'STAGE_PROPOSAL_INVALID',422);block.sourceText={value:region.sourceText,status:'AI_PROPOSED'};}
    if(input.scope.kind==='PAGE')result.blocks=[];
    const novelPolygons:Point[][]=[];
    for(const [index,region]of proposal.regions.entries()){if(consumed.has(index))continue;requireCondition(novel.filter(crop=>inCrop(region,crop)).length===1&&region.sourceText.length<=profile.maxTextLength,'STAGE_PROPOSAL_INVALID',422);const regionId=parentNovelRegionIds===undefined?randomUUID():parentNovelRegionIds[novelIdIndex++];requireCondition(regionId,'STAGE_PROPOSAL_INVALID',422);const block:Block={regionId,geometry:structuredClone(region.geometry),sourceText:{value:region.sourceText,status:'AI_PROPOSED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:input.settings.fontAssetId,fontSizePx:input.settings.baseFontSizePx,appliedTranslation:null};if(input.scope.kind==='PAINTED'){
      requireCondition(painted(block,input.paintStrokes!,input.paintInclusion!),'STAGE_PROPOSAL_INVALID',422);novelPolygons.push(block.geometry.polygon);block.geometry.readingOrder=Math.max(-1,...result.blocks.map(item=>item.geometry.readingOrder))+1;
    }result.blocks.push(block);ids.add(block.regionId);}
    if(novelPolygons.length){
      // One union uses the exact final cleanup rasterization, regardless of the number of novel regions.
      const cleanup=(await binaryPolygonMask(novelPolygons,input.width,input.height,profile)).pixels,forbidden=(await binaryPolygonMask(data.blocks.map(block=>block.geometry.polygon),input.width,input.height,profile)).pixels;let count=0;
      for(let at=0;at<cleanup.length;at++)if(cleanup[at]){count++;const point={x:at%input.width+0.5,y:Math.floor(at/input.width)+0.5};requireCondition(!forbidden[at]&&input.paintStrokes!.some(stroke=>stroke.points.some((a,i)=>distance(point,a,stroke.points[i+1]??a)<=stroke.radiusPx)),'STAGE_PROPOSAL_INVALID',422);}
      requireCondition(count>0,'STAGE_PROPOSAL_INVALID',422);
    }
    requireCondition(input.scope.kind==='PAGE'||known.length>0||result.blocks.length>data.blocks.length,'STAGE_PROPOSAL_INVALID',422);
  }
  requireCondition(parentNovelRegionIds===undefined||novelIdIndex===parentNovelRegionIds.length,'STAGE_PROPOSAL_INVALID',422);
  result.renderSpecification={version:1,fontCatalogVersion:fonts.catalog.version,blocks:result.blocks.map(block=>{const prior=data.renderSpecification?.blocks.find(item=>item.regionId===block.regionId);if(!ids.has(block.regionId)&&prior)return structuredClone(prior);if(!ids.has(block.regionId))return {regionId:block.regionId,minimumFontSizePx:1,sizing:'AUTO_FIT',rendererVersion:'pango-canonical-v1'};const rendererVersion=proposalRendererVersion(prior?.rendererVersion);return prior?{...structuredClone(prior),rendererVersion}:{regionId:block.regionId,minimumFontSizePx:input.settings.minFontSizePx,sizing:'AUTO_FIT',rendererVersion};})};validateEditData(result,input.width,input.height);requireCondition(result.blocks.length<=profile.maxBlocks,'STAGE_PROPOSAL_INVALID',422);return result;
}
export class GeminiMaterialLoader{
  constructor(readonly db:Database,readonly assets:Assets,readonly fonts:FontCatalog,readonly profile:MediaProfile){}
  private async verifiedRequest(tx:Transaction,input:StageInput,checkAssets=false):Promise<RequestRow>{
    const request=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2 FOR SHARE',[input.accountId,input.requestId])).rows[0];
    requireCondition(request,'INPUT_EVIDENCE_INVALID',409,'WAIT');
    const stored=await storedInput(tx,input.executionId);requireCondition(fingerprint(stored)===fingerprint(input),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    if(checkAssets)for(const dependency of input.assetDependencies??[]){const row=await this.assets.row(tx,dependency.assetId);requireCondition(row.sha256===dependency.sha256&&row.bytes_length===dependency.bytesLength&&row.media_type===dependency.mediaType&&['LIVE','FONT'].includes(row.purpose),'INPUT_DEPENDENCY_INVALID',409,'WAIT');}
    requireCondition(request.account_id===input.accountId&&request.request_id===input.requestId&&request.context_id===input.contextId&&request.context_generation===input.envelope!.contextGeneration&&request.page_lineage_id===input.envelope!.pageLineageId&&request.settings_revision===input.settings.settingsVersion&&digest(request.captured_scope)===digest(input.scope)&&digest(request.captured_input.data)===digest(input.initialData),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    // Keep this value identical to ExecutionService.authorize's dependency capture.
    const dependency=digest({stage:input.stage,stageOrder:request.captured_stage_order,scope:request.captured_scope,settings:input.settings,initial:request.captured_input,previous:input.previousData,cleanedAssetId:input.currentCleanedAssetId??null,renderAssetId:input.currentRenderAssetId??null,assetDependencies:input.assetDependencies??[],previousOutputAssetIds:input.previousOutputAssetIds??[]});
    requireCondition(dependency===input.inputDigest,'INPUT_EVIDENCE_INVALID',409,'WAIT');
    if(Object.hasOwn(request.captured_input,'sourceResultCapture')){
      const source=request.captured_input.sourceResultCapture;
      requireCondition(source&&typeof source==='object'&&!Array.isArray(source)&&Object.keys(source).sort().join(',')==='resultId,resultRevision,version'&&source.version===1&&typeof source.resultId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.resultId)&&typeof source.resultRevision==='string'&&/^(0|[1-9]\d*)$/.test(source.resultRevision)&&BigInt(source.resultRevision)<=9223372036854775807n,'INPUT_EVIDENCE_INVALID',409,'WAIT');
    }
    return request;
  }
  private async verify(input:StageInput):Promise<void>{requireCondition(input.accountId,'INPUT_EVIDENCE_INVALID',409,'WAIT');await this.db.accountTransaction(input.accountId,tx=>this.verifiedRequest(tx,input,true),true);}
  private consumption(input:StageInput,request:RequestRow,plan:MaterialPlan,sourceTexts?:ScopedMaterial['sourceTexts']):ConsumptionCapture{
    validateNativeMaterialPlan(plan,this.profile);const {selected}=validateInput(input,this.fonts,this.profile);
    const expected=input.stage==='TRANSLATE'?selected.map(block=>({inputRegionId:block.regionId,sourceText:block.sourceText.value})):[];
    requireCondition(plan.stage===input.stage&&plan.inputFingerprint===fingerprint(input)&&plan.fontCatalogVersion===this.fonts.catalog.version&&plan.parameterProfileVersion===this.profile.id&&digest(plan.selectedRegionIds)===digest(selected.map(block=>block.regionId))&&digest(plan.texts)===digest(expected.map(item=>({regionId:item.inputRegionId,sha256:sha256(item.sourceText)})))&&(sourceTexts===undefined||digest(sourceTexts)===digest(expected)),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    requireCondition(plan.scopeDigest===digest({version:1,coordinateContract:'PAGE_GLOBAL_SOURCE_PIXELS_V1',inputFingerprint:plan.inputFingerprint,scope:input.scope,paintStrokes:input.paintStrokes??[],paintInclusion:input.paintInclusion??null,crops:plan.crops,texts:plan.texts}),'INPUT_EVIDENCE_INVALID',409,'WAIT');
    return {version:1,promptContract:'gemini-scoped-material-v1',inputFingerprint:fingerprint(input),executionId:input.executionId,requestId:input.requestId,contextId:input.contextId!,contextGeneration:input.envelope!.contextGeneration,pageLineageId:input.envelope!.pageLineageId,sourceResultCapture:request.captured_input.sourceResultCapture===undefined?null:structuredClone(request.captured_input.sourceResultCapture),dataSource:input.previousData===null?'INITIAL_DATA':'PREVIOUS_DATA',initialDataDigest:digest(input.initialData),previousDataDigest:input.previousData===null?null:digest(input.previousData),checkpointDependencies:structuredClone(input.envelope!.checkpointDependencies),texts:expected.map(item=>({regionId:item.inputRegionId,sourceTextStatus:selected.find(block=>block.regionId===item.inputRegionId)!.sourceText.status,sha256:sha256(item.sourceText)}))};
  }
  private recordedPlan(record:MaterialEvidence,input:StageInput,request:RequestRow):MaterialPlan{
    if(record.version===2){
      requireCondition(Object.keys(record).sort().join(',')==='consumptionCapture,plan,version','INPUT_EVIDENCE_INVALID',409,'WAIT');
      requireCondition(digest(record.consumptionCapture)===digest(this.consumption(input,request,record.plan)),'INPUT_EVIDENCE_INVALID',409,'WAIT');return record.plan;
    }
    // Original v1 evidence is read as its original plan, never backfilled.
    this.consumption(input,request,record);return record;
  }
  async material(input:StageInput,native?:NativeFacade):Promise<ScopedMaterial>{
    requireCondition(this.profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');
    await this.verify(input);const source=input.stage==='OCR'?await this.assets.bytes(input.accountId!,input.originalAssetId,true):null;const prepared=await (native?native.prepareScopedMaterial(input,source,this.fonts,this.profile):prepareScopedMaterial(input,source,this.fonts,this.profile));
    await this.db.accountTransaction(input.accountId!,async tx=>{const request=await this.verifiedRequest(tx,input),capture:MaterialEvidence={version:2,plan:prepared.plan,consumptionCapture:this.consumption(input,request,prepared.plan,prepared.material.sourceTexts)};const existing=(await tx.client.query<{protected_observation:MaterialEvidence;evidence_digest:string}>("SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='GEMINI_MATERIAL'",[input.accountId,input.executionId])).rows;requireCondition(existing.length<=1,'INPUT_EVIDENCE_INVALID',409,'WAIT');for(const row of existing){requireCondition(row.evidence_digest===digest(row.protected_observation)&&digest(this.recordedPlan(row.protected_observation,input,request))===digest(prepared.plan),'INPUT_EVIDENCE_INVALID',409,'WAIT');}if(!existing.length){const id=randomUUID();await tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'GEMINI_MATERIAL',$4,$2::uuid::text,$5,$6)",[input.accountId,id,input.executionId,digest(capture),tx.now,JSON.stringify(capture)]);}},true);return prepared.material;
  }
  async data(input:StageInput,proposal:OcrProposal|TranslationProposal,native?:NativeFacade):Promise<EditData>{
    requireCondition(this.profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');
    await this.verify(input);const plan=await this.db.accountTransaction(input.accountId!,async tx=>{const request=await this.verifiedRequest(tx,input),rows=(await tx.client.query<{protected_observation:MaterialEvidence;evidence_digest:string}>("SELECT protected_observation,evidence_digest FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='GEMINI_MATERIAL'",[input.accountId,input.executionId])).rows;requireCondition(rows.length===1&&rows[0].evidence_digest===digest(rows[0].protected_observation),'INPUT_EVIDENCE_INVALID',409,'WAIT');return this.recordedPlan(rows[0].protected_observation,input,request);},true);return native?native.applyScopedProposal(input,proposal,plan,this.fonts,this.profile):applyScopedProposal(input,proposal,plan,this.fonts,this.profile);
  }
}
