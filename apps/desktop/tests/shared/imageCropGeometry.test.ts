import { describe, expect, it } from "vitest";
import { baseProductionOcrCrop, buildOcrRecognitionCrop } from "../../src/shared/imageCropGeometry.js";
import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT, type ProductionOcrGroup } from "../../src/shared/productionOcr.js";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { groupProductionOcrDetections } from "../../src/main/ocr/grouping/productionRegionGrouping.js";

function group(id:string,x:number,y:number,width:number,height:number,supported=true): ProductionOcrGroup {
  const detection=parseProductionOcrDetections({detections:[{detectionId:id,quad:[[x,y],[x+width,y],[x+width,y+height],[x,y+height]],score:.63}]},1000,1000)[0]!;
  return groupProductionOcrDetections([{...detection,...(supported?{supportedBy:MANGA_OCR_MODELS.detector}:{})}])[0]!;
}
const base=(g:ProductionOcrGroup)=>baseProductionOcrCrop(g.groupBboxPx,g.imageWidth,g.imageHeight);

describe("new weak text recognition context",()=>{
  it("uses total forty-percent cross padding for a narrow vertical singleton",()=>{
    const g={...group("narrow",300,300,30,150),orientation:"vertical" as const};
    expect(buildOcrRecognitionCrop(g,[g])).toEqual({cropBboxPx:{x:288,y:288,width:54,height:174},additionalPaddingPx:{left:9,top:0,right:9,bottom:0}});
  });

  it("extends only the trailing side of a short region and preserves its unknown orientation",()=>{
    const g={...group("short",300,300,60,80),orientation:"unknown" as const};
    const result=buildOcrRecognitionCrop(g,[g]);
    expect(result.additionalPaddingPx).toEqual({left:0,top:0,right:0,bottom:60});
    expect(result.cropBboxPx).toEqual({...base(g),height:base(g).height+60});
    expect(g.orientation).toBe("unknown");
  });

  it("protects the source area of a neighboring sentence while allowing safe space",()=>{
    const g=group("short",300,300,60,80),neighbor=group("other",300,410,70,60,false);
    const result=buildOcrRecognitionCrop(g,[g,neighbor]);
    expect(result.cropBboxPx.y+result.cropBboxPx.height).toBe(410);
    expect(result.additionalPaddingPx!.bottom).toBeLessThan(60);
  });

  it("does not increase an intrusion that already exists in the base crop",()=>{
    const g=group("short",300,300,60,80),neighbor=group("other",300,383,70,90,false);
    expect(buildOcrRecognitionCrop(g,[g,neighbor])).toEqual({cropBboxPx:base(g)});
  });

  it.each(["legacy","mixed","manga-source","medium"])("keeps the base crop for ineligible group %s",kind=>{
    let g=group("target",300,300,60,80,kind!=="legacy");
    if(kind==="mixed")g={...g,sourceDetectionIds:[...g.sourceDetectionIds,"existing-source"],memberModels:[...g.memberModels!,{modelId:PRODUCTION_OCR_CONTRACT.detector.modelId,revision:PRODUCTION_OCR_CONTRACT.detector.revision}]};
    if(kind==="manga-source")g={...g,memberModels:[MANGA_OCR_MODELS.detector]};
    if(kind==="medium")g={...group("middle",300,300,60,120),orientation:"vertical"};
    expect(buildOcrRecognitionCrop(g,[g])).toEqual({cropBboxPx:base(g)});
  });

  it("records the actual clamped amount at the source image boundary",()=>{
    const g=group("short",300,880,60,80);
    const result=buildOcrRecognitionCrop(g,[g]);
    expect(result.cropBboxPx.y+result.cropBboxPx.height).toBe(1000);
    expect(result.additionalPaddingPx!.bottom).toBe(1000-base(g).y-base(g).height);
  });
});
