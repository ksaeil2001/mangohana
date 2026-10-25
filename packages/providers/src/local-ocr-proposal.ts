import type {Geometry,OcrProposal} from '../../contracts/src/wire.generated.js';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {assertWire} from '../../contracts/src/validation.js';

export type PinnedOcrBytes=Readonly<{bytes:Uint8Array;sha256:string}>;
export type LocalOcrProposalInput=Readonly<{
  source:PinnedOcrBytes&Readonly<{width:number;height:number}>;
  detector:PinnedOcrBytes;
  recognitions:readonly Readonly<{record:PinnedOcrBytes;crop:PinnedOcrBytes}>[];
  readingOrder:readonly Readonly<{id:string;readingOrder:number;orientation:Geometry['orientation']}>[];
  // Links to the caller's existing, verified capture; this converter does not run or revalidate a model.
  origin:Readonly<{planSha256:string;manifestSha256:string;modelSha256:string}>;
}>;
type PixelBox=readonly [number,number,number,number];
export type LocalOcrConsumption={
  kind:'SAVED_LOCAL_OCR_PROPOSAL_CONVERSION';
  verification:'BYTE_PINS_AND_CAPTURE_BINDINGS';
  page:string;
  source:{sha256:string;width:number;height:number};
  detectorSha256:string;
  detectorModelSha256:string;
  origin:LocalOcrProposalInput['origin'];
  readingOrderDigest:string;
  proposalAuthority:'AI_PROPOSED';
  humanGroundTruth:false;
  regions:{
    id:string;readingOrder:number;orientation:Geometry['orientation'];
    detectorBox:PixelBox;cropBox:PixelBox;
    recordSha256:string;cropSha256:string;detectorConfidence:number|null;ocrConfidence:null;
    reviewSignals:{emptyText:boolean;atTokenLimit:boolean};
  }[];
};

function must(condition:unknown,code:string):asserts condition {if(!condition)throw new Error(code);}
function hashLink(value:unknown,code:string):asserts value is string {must(typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),code);}
function object(value:unknown,code:string):Record<string,unknown> {
  must(value!==null&&typeof value==='object'&&!Array.isArray(value),code);return value as Record<string,unknown>;
}
function pinned(value:PinnedOcrBytes):PinnedOcrBytes {
  must(value&&value.bytes instanceof Uint8Array&&value.bytes.length>0,'LOCAL_OCR_PIN_INVALID');hashLink(value.sha256,'LOCAL_OCR_PIN_INVALID');
  const bytes=Buffer.from(value.bytes);must(sha256(bytes)===value.sha256,'LOCAL_OCR_PIN_INVALID');return {bytes,sha256:value.sha256};
}
function json(value:PinnedOcrBytes):Record<string,unknown> {
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value.bytes);}catch{throw new Error('LOCAL_OCR_JSON_INVALID');}
  return object(parseStrictJson(text),'LOCAL_OCR_JSON_INVALID');
}
function pixelBox(value:unknown,width:number,height:number,crop=false):PixelBox {
  const code=crop?'LOCAL_OCR_CROP_MISMATCH':'LOCAL_OCR_DETECTOR_INVALID';
  must(Array.isArray(value)&&value.length===4&&value.every(point=>typeof point==='number'&&Number.isFinite(point)&&Math.abs(point)<=Number.MAX_SAFE_INTEGER&&(!crop||Number.isSafeInteger(point))),code);
  const [left,top,right,bottom]=value as number[];
  must(left>=0&&top>=0&&right>left&&bottom>top&&right<=width&&bottom<=height,code);
  return [left,top,right,bottom];
}
function sameBox(first:PixelBox,second:PixelBox):boolean {return first.every((value,index)=>value===second[index]);}

// The caller verifies origin links against its protected capture before calling.
// Consumes saved results only. No image decoding, model/native execution, billing, persistence or EditData application.
export async function convertSavedLocalOcrProposal(input:LocalOcrProposalInput):Promise<{proposal:OcrProposal;consumption:LocalOcrConsumption;consumptionDigest:string}> {
  const source=pinned(input.source),detector=pinned(input.detector),width=input.source.width,height=input.source.height;
  must(Number.isSafeInteger(width)&&width>0&&Number.isSafeInteger(height)&&height>0,'LOCAL_OCR_SOURCE_MISMATCH');
  const origin=structuredClone(input.origin);must(origin&&typeof origin==='object','LOCAL_OCR_ORIGIN_LINK_INVALID');
  for(const value of [origin.planSha256,origin.manifestSha256,origin.modelSha256])hashLink(value,'LOCAL_OCR_ORIGIN_LINK_INVALID');
  must(Array.isArray(input.recognitions)&&Array.isArray(input.readingOrder),'LOCAL_OCR_REGION_BINDING_INVALID');
  const records=input.recognitions.map(item=>({record:pinned(item.record),crop:pinned(item.crop)})),order=structuredClone(input.readingOrder);
  const detected=json(detector),capturedSource=object(detected.source,'LOCAL_OCR_SOURCE_MISMATCH');
  must(typeof detected.page==='string'&&detected.page.length>0&&capturedSource.sha256===source.sha256&&capturedSource.width===width&&capturedSource.height===height,'LOCAL_OCR_SOURCE_MISMATCH');
  hashLink(detected.modelSha256,'LOCAL_OCR_DETECTOR_INVALID');must(Array.isArray(detected.blocks),'LOCAL_OCR_DETECTOR_INVALID');
  const blocks=new Map<string,{box:PixelBox;confidence:number|null}>();
  for(const value of detected.blocks){
    const block=object(value,'LOCAL_OCR_DETECTOR_INVALID');
    must(typeof block.id==='string'&&block.id.length>0&&!blocks.has(block.id),'LOCAL_OCR_REGION_BINDING_INVALID');
    must(block.confidence===null||(typeof block.confidence==='number'&&Number.isFinite(block.confidence)&&block.confidence>=0&&block.confidence<=1),'LOCAL_OCR_DETECTOR_INVALID');
    blocks.set(block.id,{box:pixelBox(block.box,width,height),confidence:block.confidence});
  }
  must(records.length===blocks.size&&order.length===blocks.size,'LOCAL_OCR_REGION_BINDING_INVALID');
  const orderById=new Map<string,LocalOcrProposalInput['readingOrder'][number]>(),usedOrder=new Set<number>();
  for(const value of order){
    must(value&&typeof value.id==='string'&&blocks.has(value.id)&&!orderById.has(value.id)&&Number.isSafeInteger(value.readingOrder)&&value.readingOrder>=0&&!usedOrder.has(value.readingOrder)&&(value.orientation==='HORIZONTAL'||value.orientation==='VERTICAL'),'LOCAL_OCR_ORDER_INVALID');
    orderById.set(value.id,value);usedOrder.add(value.readingOrder);
  }
  const recognized=new Map<string,{text:string;evidence:LocalOcrConsumption['regions'][number]}>();
  for(const {record,crop} of records){
    const result=json(record);
    must(typeof result.id==='string'&&blocks.has(result.id)&&!recognized.has(result.id)&&result.page===detected.page,'LOCAL_OCR_REGION_BINDING_INVALID');
    const block=blocks.get(result.id)!,placement=orderById.get(result.id)!;
    const detectorBox=pixelBox(result.detectorBox,width,height),cropBox=pixelBox(result.cropBox,width,height,true);
    must(sameBox(detectorBox,block.box)&&cropBox[0]<=detectorBox[0]&&cropBox[1]<=detectorBox[1]&&cropBox[2]>=detectorBox[2]&&cropBox[3]>=detectorBox[3]&&result.cropSha256===crop.sha256,'LOCAL_OCR_CROP_MISMATCH');
    must(typeof result.text==='string'&&typeof result.raw==='string'&&result.status==='AI_PROPOSED'&&result.humanGroundTruth===false&&typeof result.emptyText==='boolean'&&result.emptyText===(result.text.length===0)&&typeof result.atTokenLimit==='boolean'&&(result.readingOrder===null||result.readingOrder===placement.readingOrder),'LOCAL_OCR_RECORD_INVALID');
    recognized.set(result.id,{text:result.text,evidence:{id:result.id,readingOrder:placement.readingOrder,orientation:placement.orientation,detectorBox,cropBox,recordSha256:record.sha256,cropSha256:crop.sha256,detectorConfidence:block.confidence,ocrConfidence:null,reviewSignals:{emptyText:result.emptyText,atTokenLimit:result.atTokenLimit}}});
  }
  const ordered=[...order].sort((first,second)=>first.readingOrder-second.readingOrder);
  const proposal:OcrProposal={regions:ordered.map(placement=>{
    const result=recognized.get(placement.id)!,[left,top,right,bottom]=result.evidence.detectorBox;
    return {geometry:{polygon:[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}],angleDegrees:0,readingOrder:placement.readingOrder,orientation:placement.orientation},sourceText:result.text,confidence:null};
  })};
  assertWire<OcrProposal>('ocrProposal',proposal);
  const consumption:LocalOcrConsumption={kind:'SAVED_LOCAL_OCR_PROPOSAL_CONVERSION',verification:'BYTE_PINS_AND_CAPTURE_BINDINGS',page:detected.page,source:{sha256:source.sha256,width,height},detectorSha256:detector.sha256,detectorModelSha256:detected.modelSha256,origin,readingOrderDigest:digest(order),proposalAuthority:'AI_PROPOSED',humanGroundTruth:false,regions:ordered.map(placement=>recognized.get(placement.id)!.evidence)};
  return {proposal,consumption,consumptionDigest:digest(consumption)};
}
