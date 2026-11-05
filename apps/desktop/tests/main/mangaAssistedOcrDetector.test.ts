import { describe, expect, it, vi } from "vitest";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { MangaAssistedOcrDetector, mergeMangaOcrDetections } from "../../src/main/ocr/detection/mangaAssistedOcrDetector.js";
import { groupProductionOcrDetections } from "../../src/main/ocr/grouping/productionRegionGrouping.js";

const sourceModel = { modelId: "Kellenok/PP-OCRv6_manga", revision: "c94f4a20677f1ba0c90625bccf42ea980f24e2f4" } as const;
function box(id: string, x: number, y: number, width: number, height: number, score = 0.9, manga = false) {
  const detection = parseProductionOcrDetections({ detections: [{ detectionId: id, quad: [[x,y],[x+width,y],[x+width,y+height],[x,y+height]], score }] }, 2000, 2400)[0]!;
  return manga ? { ...detection, sourceModel } : detection;
}
function support(fullpageDetections = [] as ReturnType<typeof box>[], detailCandidates = [] as { detection: ReturnType<typeof box>; tile: { x: number; y: number; width: number; height: number }; touchesInternalEdge: boolean }[]) {
  return { fullpageDetections, detailCandidates };
}
const tile = { x: 0, y: 0, width: 1200, height: 1200 };

describe("cross-model local confirmation", () => {
  function detector(weak: ReturnType<typeof box>[], confirmations: ReturnType<typeof parseProductionOcrDetections>, onConfirm?:()=>void) {
    const fineTile={x:400,y:400,width:600,height:600};
    const candidate={detection:box("manga:fine",500,600,50,80,.85,true),tile:fineTile,touchesInternalEdge:false};
    const confirm=vi.fn(async()=>{onConfirm?.();return confirmations;});
    const verify=vi.fn().mockResolvedValue({accepted:true});
    const adapter=new MangaAssistedOcrDetector({
      primary:{detectWithDetails:async()=>({detections:[],fullpageDetections:[],detailCandidates:weak.map(detection=>({detection,tile,touchesInternalEdge:false}))})},
      support:{detectWithDetails:async()=>({detections:[],fullpageDetections:[],detailCandidates:[candidate]})},
      confirmationDetector:{detect:confirm},
      textVerifier:{verify},
      decodeImage:()=>({getSize:()=>({width:2000,height:2400}),crop:rect=>({toPNG:()=>Buffer.from(JSON.stringify(rect))})})
    });
    return {adapter,confirm,verify};
  }
  const local=()=>parseProductionOcrDetections({detections:[{detectionId:"pp:fine",quad:[[95,195],[155,195],[155,285],[95,285]],score:.9}]},600,600);

  it("keeps a weak PP quad and records Manga's confirming role separately", async()=>{
    const weak=box("pp:weak",495,595,60,90,.63);
    const h=detector([weak],[]);
    const result=await h.adapter.detect({imageBytes:Buffer.from("synthetic")});
    expect(h.confirm).not.toHaveBeenCalled();
    expect(result).toEqual([{...weak,supportedBy:sourceModel}]);
    expect(result[0]!.sourceModel).toBeUndefined();
  });

  it("requires independent strong PP confirmation of a tile-only Manga prediction",async()=>{
    const h=detector([],local());
    const result=await h.adapter.detect({imageBytes:Buffer.from("synthetic")});
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(result[0]).toMatchObject({detectionId:"manga-confirm:400,400:pp:fine",sourceBboxPx:{x:495,y:595,width:60,height:90},supportedBy:sourceModel,imageWidth:2000,imageHeight:2400});
    expect(result[0]!.sourceModel).toBeUndefined();
  });

  it("rejects a high-scoring drawing prediction when PP does not corroborate it",async()=>{
    const h=detector([],[]);
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toEqual([]);
    expect(h.confirm).toHaveBeenCalledOnce();
  });

  it("rejects an unstable weak PP candidate even after Manga spatial agreement",async()=>{
    const h=detector([box("pp:weak",495,595,60,90,.63)],[]);
    h.verify.mockResolvedValue({accepted:false});
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.verify).toHaveBeenCalledOnce();
  });

  it("does not spend a PP recheck on an unstable fine-scale guess",async()=>{
    const h=detector([],local());
    h.verify.mockResolvedValue({accepted:false});
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("does not let a strong PP recheck bypass its text evidence gate",async()=>{
    const h=detector([],local());
    h.verify.mockResolvedValueOnce({accepted:true}).mockResolvedValueOnce({accepted:false});
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toEqual([]);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("retains a fine Manga line missed by PP when both CTC views agree exactly with stronger scores",async()=>{
    const h=detector([],[]);
    h.verify.mockResolvedValue({accepted:true,inputs:[{text:"合成",mean:.78},{text:"合成",mean:.94}]});
    const result=await h.adapter.detect({imageBytes:Buffer.from("synthetic")});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({detectionId:"manga:fine",sourceModel});
    expect(result[0]!.supportedBy).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(["prefix-only","weak-score"])("requires PP corroboration when CTC direct evidence is only %s",async(kind)=>{
    const h=detector([],[]);
    h.verify.mockResolvedValue({accepted:true,inputs:[{text:"合",mean:kind==="weak-score"?.69:.9},{text:kind==="prefix-only"?"合成":"合",mean:.95}]});
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toEqual([]);
    expect(h.confirm).toHaveBeenCalledOnce();
  });

  it("rejects mismatched PP crop dimensions",async()=>{
    const h=detector([],local().map(d=>({...d,imageWidth:1200})));
    await expect(h.adapter.detect({imageBytes:Buffer.from("synthetic")})).rejects.toThrow(/dimensions/i);
  });

  it("discards a confirmation after cancellation and does not reuse it on retry",async()=>{
    const controller=new AbortController();
    let cancel=true;
    const h=detector([],local(),()=>{if(cancel)controller.abort();});
    await expect(h.adapter.detect({imageBytes:Buffer.from("synthetic"),signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
    cancel=false;
    expect(await h.adapter.detect({imageBytes:Buffer.from("synthetic")})).toHaveLength(1);
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });
});

describe("manga detection support", () => {
  it("adds a strong independent region and preserves the original object", () => {
    const primary = box("pp", 100,100,40,200);
    const extra = box("manga:new", 500,500,50,160,.86,true);
    expect(mergeMangaOcrDetections([primary],support([extra]))).toEqual([primary,extra]);
    expect(mergeMangaOcrDetections([primary],support([extra]))[0]).toBe(primary);
  });

  it("does not add a weak fullpage guess without local confirmation", () => {
    const extra=box("manga:weak",500,500,50,60,.41,true);
    expect(mergeMangaOcrDetections([],support([extra]))).toEqual([]);
  });

  it("requires text verification even when a weak fullpage guess agrees with a fine prediction", () => {
    const whole=box("manga:weak",500,500,50,60,.41,true);
    const detail=box("detail:character",497,497,56,66,.85,true);
    expect(mergeMangaOcrDetections([],support([whole],[{ detection:detail,tile,touchesInternalEdge:false }]))).toEqual([]);
  });

  it.each(["missing", "weak", "wrong-position", "clipped", "wrong-scale"])("rejects unsupported tile evidence: %s", reason => {
    const whole=box("manga:weak",500,500,50,60,reason==="weak"?.69:.8,true);
    const detail=box("detail:character",reason==="wrong-position"?900:500,500,reason==="wrong-scale"?400:50,60,.85,true);
    expect(mergeMangaOcrDetections([],support(reason==="missing"?[]:[whole],[{ detection:detail,tile,touchesInternalEdge:reason==="clipped" }]))).toEqual(["missing","weak"].includes(reason)?[]:[whole]);
  });

  it("does not add a duplicate support quad that changes no crop input", () => {
    const primary=box("pp",100,100,50,200);
    expect(mergeMangaOcrDetections([primary],support([box("manga:duplicate",99,99,52,202,.95,true)]))).toEqual([primary]);
  });

  it("extends one line to include a prefix without replacing its PP evidence", () => {
    const primary=box("pp",100,200,50,150);
    const expanded=box("manga:complete",98,100,54,250,.91,true);
    const result=mergeMangaOcrDetections([primary],support([expanded]));
    expect(result).toEqual([primary,expanded]);
    expect(groupProductionOcrDetections(result)).toHaveLength(1);
  });

  it("keeps a partial shorter support quad out of a correct printed line", () => {
    const primary=box("pp",100,100,50,400);
    expect(mergeMangaOcrDetections([primary],support([box("manga:partial",99,90,52,100,.95,true)]))).toEqual([primary]);
  });

  it("rejects a separated prefix whose actual eight-percent crop would include another sentence", () => {
    const original=box("pp:vertical",100,200,50,150);
    const other=box("pp:horizontal",110,80,100,10);
    const expanded=box("manga:prefix",100,100,50,250,.91,true);
    expect(mergeMangaOcrDetections([original,other],support([expanded]))).toEqual([original,other]);
  });

  it("rejects an addition that joins two existing sentences", () => {
    const primary=[box("pp:a",100,100,50,200),box("pp:b",190,100,50,200)];
    const bridge=box("manga:bridge",148,100,44,200,.95,true);
    expect(groupProductionOcrDetections(primary)).toHaveLength(2);
    expect(mergeMangaOcrDetections(primary,support([bridge]))).toEqual(primary);
  });

  it("preserves the partition after two individually safe additions", () => {
    const primary=[box("pp:a",100,100,40,200),box("pp:b",220,100,40,200)];
    const result=mergeMangaOcrDetections(primary,support([box("manga:a",150,100,40,200,.9,true),box("manga:b",190,100,40,200,.8,true)]));
    const groups=groupProductionOcrDetections(result);
    expect(groups.find(g=>g.sourceDetectionIds.includes("pp:a"))!.sourceDetectionIds).not.toContain("pp:b");
  });

  it("rejects mismatched source dimensions instead of scaling them silently", () => {
    const original=box("pp",100,100,50,200);
    const wrong={...box("manga:wrong",500,500,50,200,.9,true),imageWidth:1500};
    expect(()=>mergeMangaOcrDetections([original],support([wrong]))).toThrow(/dimensions/i);
  });
});
