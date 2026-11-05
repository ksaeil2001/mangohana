// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ProductionOcrDetection, ProductionOcrPixelBbox } from "../../src/shared/productionOcr.js";
import type { ProductionOcrDetector } from "../../src/main/ocr/pipeline/productionOcrPipeline.js";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { ProductionOcrDetailDetector } from "../../src/main/ocr/detection/productionOcrDetailDetector.js";
import { groupProductionOcrDetections } from "../../src/main/ocr/grouping/productionRegionGrouping.js";

type Rect = ProductionOcrPixelBbox;
type DetectInput = Parameters<ProductionOcrDetector["detect"]>[0];
type TileHandler = (rect: Rect, input: DetectInput) => readonly ProductionOcrDetection[] | Promise<readonly ProductionOcrDetection[]>;

function detection(id: string, box: Rect, width: number, height: number, score = 0.9): ProductionOcrDetection {
  return parseProductionOcrDetections({ detections: [{
    detectionId: id,
    quad: [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]],
    score
  }] }, width, height)[0]!;
}

function harness(width: number, height: number, fullpage: readonly ProductionOcrDetection[] = [], tile: TileHandler = () => []) {
  const imageBytes = Buffer.from("isolated fake image bytes");
  const crop = vi.fn((rect: Rect) => ({ toPNG: () => Buffer.from(JSON.stringify(rect)) }));
  const decodeImage = vi.fn(() => ({ getSize: () => ({ width, height }), crop }));
  const detect = vi.fn<ProductionOcrDetector["detect"]>(async (input) => {
    if (input.imageBytes === imageBytes) return fullpage;
    return tile(JSON.parse(input.imageBytes.toString()) as Rect, input);
  });
  const adapter = new ProductionOcrDetailDetector({ detector: { detect }, decodeImage });
  return { adapter, imageBytes, detect, crop, decodeImage };
}

describe("ProductionOcrDetailDetector", () => {
  it("does not let a new independent PP tile bridge two original sentences",async()=>{
    const originals=[detection("left",{x:100,y:100,width:40,height:200},1400,1200),detection("right",{x:220,y:100,width:40,height:200},1400,1200)];
    const h=harness(1400,1200,originals,rect=>rect.x===0?[detection("bridge",{x:160,y:100,width:40,height:200},1200,1200,.85)]:[]);
    expect(await h.adapter.detect({imageBytes:h.imageBytes})).toEqual(originals);
  });

  it("rejects a new independent PP region whose actual crop would cover another sentence",async()=>{
    const originals=[detection("horizontal",{x:110,y:80,width:100,height:10},1400,1200)];
    const h=harness(1400,1200,originals,rect=>rect.x===0?[detection("vertical",{x:100,y:100,width:50,height:250},1200,1200,.85)]:[]);
    expect(await h.adapter.detect({imageBytes:h.imageBytes})).toEqual(originals);
  });

  it("checks cumulative independent PP additions against the existing partition",async()=>{
    const originals=[detection("left",{x:100,y:100,width:40,height:200},1400,1200),detection("right",{x:260,y:100,width:40,height:200},1400,1200)];
    const h=harness(1400,1200,originals,rect=>rect.x===0?[
      detection("first",{x:160,y:100,width:40,height:200},1200,1200,.9),detection("second",{x:220,y:100,width:40,height:200},1200,1200,.8)
    ]:[]);
    expect((await h.adapter.detect({imageBytes:h.imageBytes})).map(d=>d.detectionId)).toEqual(["left","right","detail-tile:0,0:first"]);
  });
  it("collects restored weak and clipped evidence before the legacy filters without changing their result", async () => {
    const h = harness(1400, 1200, [], (rect) => rect.x === 200 ? [
      detection("weak", { x: 100, y: 200, width: 40, height: 80 },1200,1200,.45),
      detection("edge", { x: 0, y: 300, width: 40, height: 80 },1200,1200,.9)
    ] : []);
    const result = await h.adapter.detectWithDetails({imageBytes:h.imageBytes});
    expect(result.detections).toEqual([]);
    expect(result.fullpageDetections).toEqual([]);
    expect(result.detailCandidates.map(c=>({x:c.detection.sourceBboxPx.x,score:c.detection.score,clipped:c.touchesInternalEdge})))
      .toEqual([{x:300,score:.45,clipped:false},{x:200,score:.9,clipped:true}]);
    expect(await h.adapter.detect({imageBytes:h.imageBytes})).toEqual([]);
  });

  it("keeps detail evidence local to concurrent and subsequent requests", async () => {
    const h = harness(1400, 1200, [], (rect) => [detection(`raw-${rect.x}`,{x:100,y:100,width:40,height:80},1200,1200,.49)]);
    const [first, second] = await Promise.all([h.adapter.detectWithDetails({imageBytes:h.imageBytes}),h.adapter.detectWithDetails({imageBytes:h.imageBytes})]);
    expect(first.detailCandidates).toHaveLength(2);
    expect(second.detailCandidates).toHaveLength(2);
    expect(first.detailCandidates).not.toBe(second.detailCandidates);
    expect((await h.adapter.detectWithDetails({imageBytes:h.imageBytes})).detailCandidates).toHaveLength(2);
  });

  it("covers the source with the fixed finer Manga scale while leaving the default scale unchanged", async () => {
    const crop = vi.fn((rect: Rect)=>({toPNG:()=>Buffer.from(JSON.stringify(rect))}));
    const adapter = new ProductionOcrDetailDetector({detector:{detect:async()=>[]},decodeImage:()=>({getSize:()=>({width:1000,height:1400}),crop}),tileSize:600});
    await adapter.detectWithDetails({imageBytes:Buffer.from("fine-scale")});
    expect(crop.mock.calls.map(([rect])=>rect)).toEqual([0,400,800].flatMap(y=>[0,400].map(x=>({x,y,width:600,height:600}))));
  });
  it.each([
    [0.4951, false], [0.5366, false], [0.5684, false], [0.5795, false],
    [0.6106, false], [0.6308, false], [0.6398, false], [0.6625, false],
    [0.6999, false], [0.7, true], [0.7001, true], [0.7421, true], [0.8035, true], [0.8053, true]
  ] as const)("requires stronger evidence for added detail score %s, without filtering fullpage text", async (score, keep) => {
    // Cropped decorations and drawing strokes produced weak text candidates.
    // Keep the original detector's text, and gate only supplementary regions.
    const full = detection("full-low-score", { x: 100, y: 100, width: 40, height: 80 }, 1300, 1200, 0.4);
    const h = harness(1300, 1200, [full], (rect) => rect.x === 0
      ? [detection("detail", { x: 300, y: 300, width: 40, height: 80 }, 1200, 1200, score)] : []);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toHaveLength(keep ? 2 : 1);
    expect(result[0]).toBe(full);
  });

  it("covers the entire large page and restores a missed tile detection's coordinates and original ID", async () => {
    const full = detection("full-original", { x: 1600, y: 200, width: 80, height: 200 }, 2598, 3626);
    const originalFull = Object.freeze([Object.freeze(full)]);
    const detail = detection("raw-det-7", { x: 132, y: 72, width: 112, height: 220 }, 1200, 1200, 0.8035);
    const originalDetail = structuredClone(detail);
    const h = harness(2598, 3626, originalFull, (rect) => rect.x === 0 && rect.y === 1000 ? [detail] : []);
    const originalBytes = Buffer.from(h.imageBytes);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result[0]).toBe(full);
    expect(result[1]).toEqual({
      ...detail,
      detectionId: "detail-tile:0,1000:raw-det-7",
      sourceQuadPx: [{ x: 132, y: 1072 }, { x: 244, y: 1072 }, { x: 244, y: 1292 }, { x: 132, y: 1292 }],
      sourceBboxPx: { x: 132, y: 1072, width: 112, height: 220 },
      bbox: { x: 132 / 2598, y: 1072 / 3626, width: 112 / 2598, height: 220 / 3626 },
      polygon: [{ x: 132 / 2598, y: 1072 / 3626 }, { x: 244 / 2598, y: 1072 / 3626 }, { x: 244 / 2598, y: 1292 / 3626 }, { x: 132 / 2598, y: 1292 / 3626 }],
      imageWidth: 2598,
      imageHeight: 3626
    });
    expect(h.detect.mock.calls[0]![0].imageBytes).toBe(h.imageBytes);
    expect(h.detect).toHaveBeenCalledTimes(13);
    expect(h.decodeImage).toHaveBeenCalledExactlyOnceWith(h.imageBytes);
    expect(h.crop.mock.calls.map(([rect]) => rect)).toEqual(
      [0, 1000, 2000, 2426].flatMap((y) => [0, 1000, 1398].map((x) => ({ x, y, width: 1200, height: 1200 })))
    );
    expect(h.imageBytes).toEqual(originalBytes);
    expect(detail).toEqual(originalDetail);
    expect(originalFull).toEqual([full]);
  });

  it("supplements even when fullpage found no anchors", async () => {
    const h = harness(1300, 600, [], (rect) => rect.x === 100
      ? [detection("no-anchor", { x: 100, y: 100, width: 40, height: 80 }, rect.width, rect.height)] : []);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result.map((item) => item.sourceBboxPx)).toEqual([{ x: 200, y: 100, width: 40, height: 80 }]);
    expect(h.crop).toHaveBeenCalledTimes(2);
  });

  it.each([[1200, 1200], [1200, 600], [600, 1200], [1, 1]])("returns the same fullpage array with one detector call for %ix%i", async (width, height) => {
    const full = Object.freeze([detection("unchanged", { x: 0, y: 0, width: 1, height: 1 }, width, height)]);
    const h = harness(width, height, full);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toBe(full);
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.crop).not.toHaveBeenCalled();
  });

  it.each([[2598, 500], [500, 2598]])("uses actual crop dimensions along the shorter side of a %ix%i page", async (width, height) => {
    const h = harness(width, height, [], (rect) => [detection("short-side", { x: 50, y: 50, width: 80, height: 40 }, rect.width, rect.height)]);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(h.crop.mock.calls.map(([rect]) => rect)).toEqual(width > height
      ? [0, 1000, 1398].map((x) => ({ x, y: 0, width: 1200, height: 500 }))
      : [0, 1000, 1398].map((y) => ({ x: 0, y, width: 500, height: 1200 })));
    expect(result).toHaveLength(3);
    expect(result.every((item) => item.imageWidth === width && item.imageHeight === height)).toBe(true);
  });

  it("keeps fullpage objects and removes duplicate and contained detail boxes while retaining adjacent text", async () => {
    const full = detection("full", { x: 300, y: 300, width: 300, height: 80 }, 1300, 1200, 0.4);
    const existingDuplicate = { ...full, detectionId: "already-full" };
    const h = harness(1300, 1200, [full, existingDuplicate], (rect) => [
      detection("duplicate", { x: 300 - rect.x, y: 300, width: 300, height: 80 }, 1200, 1200, 0.99),
      detection("contained-part", { x: 350 - rect.x, y: 310, width: 40, height: 20 }, 1200, 1200),
      // Separate adjacent text leaves enough space for its real 8% crop.
      detection("adjacent", { x: 625 - rect.x, y: 300, width: 80, height: 80 }, 1200, 1200)
    ]);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(full);
    expect(result[1]).toBe(existingDuplicate);
    expect(result[2]!.detectionId).toContain(":adjacent");
    expect(result[2]!.sourceBboxPx).toEqual({ x: 625, y: 300, width: 80, height: 80 });
  });

  it.each([{ overlap: 49, kept: true }, { overlap: 50, kept: false }, { overlap: 51, kept: false }])("uses intersection/min-area at the 0.5 boundary: $overlap percent", async ({ overlap, kept }) => {
    const full = detection("full", { x: 200, y: 200, width: 100, height: 100 }, 1300, 1200);
    const h = harness(1300, 1200, [full], (rect) => rect.x === 0
      ? [detection("overlap", { x: 300 - overlap, y: 200, width: 100, height: 100 }, 1200, 1200)] : []);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toHaveLength(kept ? 2 : 1);
    expect(result[0]).toBe(full);
  });

  it("preserves a partial fullpage detection when only one tile reports an enclosing detail", async () => {
    const full = Object.freeze([detection("partial-full", { x: 300, y: 300, width: 40, height: 40 }, 1300, 1200)]);
    const h = harness(1300, 1200, full, (rect) => rect.x === 0
      ? [detection("more-complete-detail", { x: 300, y: 300, width: 120, height: 40 }, 1200, 1200, 0.99)] : []);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toBe(full);
    expect(result[0]!.sourceBboxPx.width).toBe(40);
  });

  describe("agreed extensions of existing groups", () => {
    const fullBox = { x: 300, y: 300, width: 20, height: 100 };
    const extendedBox = { ...fullBox, height: 150 };

    function extendingHarness(options: {
      fullpage?: readonly ProductionOcrDetection[];
      box?: Rect;
      scores?: readonly [number, number];
      orientation?: ProductionOcrDetection["orientation"];
    } = {}) {
      const fullpage = options.fullpage ?? [detection("full", fullBox, 1300, 1200, 0.525)];
      const box = options.box ?? extendedBox;
      return harness(1300, 1200, fullpage, (rect) => [{
        ...detection("extension", { ...box, x: box.x - rect.x }, rect.width, rect.height,
          options.scores?.[rect.x === 0 ? 0 : 1] ?? 0.6),
        ...(options.orientation ? { orientation: options.orientation } : {})
      }]);
    }

    it("appends both raw tile detections to extend 20x100 to 20x150 without changing fullpage or tile objects", async () => {
      const full = Object.freeze(detection("full", fullBox, 1300, 1200, 0.525));
      const originalQuad = full.sourceQuadPx;
      const fullpage = Object.freeze([full]);
      const raw = [0, 100].map((x) => Object.freeze(detection("extension", { ...extendedBox, x: 300 - x }, 1200, 1200, 0.6)));
      const before = structuredClone({ fullpage, raw });
      const h = harness(1300, 1200, fullpage, (rect) => [raw[rect.x === 0 ? 0 : 1]!]);
      const bytesBefore = Buffer.from(h.imageBytes);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual(["full", "detail-tile:0,0:extension", "detail-tile:100,0:extension"]);
      expect(result[0]).toBe(full);
      expect(result[0]!.sourceQuadPx).toBe(originalQuad);
      expect(result.slice(1).map((item) => item.sourceBboxPx)).toEqual([extendedBox, extendedBox]);
      expect(groupProductionOcrDetections(result)).toMatchObject([{
        groupBboxPx: extendedBox,
        sourceDetectionIds: ["detail-tile:0,0:extension", "detail-tile:100,0:extension", "full"]
      }]);
      expect({ fullpage, raw }).toEqual(before);
      expect(h.imageBytes).toEqual(bytesBefore);
    });

    it("recovers the 013 extent from its two measured raw tile geometries", async () => {
      const full = detection("full-013", { x: 1658, y: 281, width: 99, height: 235 }, 2598, 3626, 0.525);
      const h = harness(2598, 3626, [full], (rect) => {
        if (rect.y !== 0) return [];
        if (rect.x === 1000) return [detection("raw-a", { x: 649, y: 279, width: 149, height: 331 }, 1200, 1200, 0.634)];
        if (rect.x === 1398) return [detection("raw-b", { x: 250, y: 276, width: 152, height: 339 }, 1200, 1200, 0.627)];
        return [];
      });

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual(["full-013", "detail-tile:1000,0:raw-a", "detail-tile:1398,0:raw-b"]);
      expect(result[0]).toBe(full);
      expect(result.slice(1).map((item) => item.sourceBboxPx)).toEqual([
        { x: 1649, y: 279, width: 149, height: 331 }, { x: 1648, y: 276, width: 152, height: 339 }
      ]);
      expect(result.slice(1).map((item) => item.score)).toEqual([0.634, 0.627]);
      expect(groupProductionOcrDetections(result)).toMatchObject([{
        groupBboxPx: { x: 1648, y: 276, width: 152, height: 339 },
        memberQuadsPx: expect.arrayContaining([full.sourceQuadPx]),
        confidence: 0.525
      }]);
    });

    it.each([0.5, 1, 2])("keeps extension selection deterministic at character scale %s with reversed tile responses", async (scale) => {
      const box = { x: 1050, y: 300, width: 20 * scale, height: 100 * scale };
      const extended = { ...box, height: 150 * scale };
      const full = detection("full", box, 2598, 1200, 0.525);
      const run = async (reverse: boolean) => {
        const h = harness(2598, 1200, [full], (rect) => {
          if (rect.x === 1398) return [];
          const items = ["z", "a"].map((id) => detection(id, { ...extended, x: extended.x - rect.x }, 1200, 1200, 0.6));
          return reverse ? items.reverse() : items;
        });
        return h.adapter.detect({ imageBytes: h.imageBytes });
      };

      const forward = await run(false);
      const reversed = await run(true);

      expect(reversed).toEqual(forward);
      expect(forward.map((item) => item.detectionId)).toEqual(["full", "detail-tile:0,0:a", "detail-tile:1000,0:a"]);
      expect(groupProductionOcrDetections(forward)).toMatchObject([{ groupBboxPx: extended }]);
    });

    it.each([
      { label: "identical", box: fullBox },
      { label: "contained", box: { ...fullBox, y: 305, height: 90 } },
      { label: "one pixel longer", box: { ...fullBox, height: 101 } },
      { label: "inside original eight percent padding", box: { ...fullBox, height: 108 } },
      { label: "one pixel past original padding", box: { ...fullBox, height: 109 } },
      { label: "less than a quarter thickness past padding", box: { ...fullBox, height: 112 } },
      { label: "less than ninety percent fullpage coverage", box: { ...extendedBox, x: 302.01 } },
      { label: "more than twice the character thickness", box: { ...extendedBox, width: 40.01 } },
      { label: "less than half the character thickness", box: { ...extendedBox, width: 9.99 } }
    ])("rejects two agreed candidates when $label", async ({ box }) => {
      const fullpage = Object.freeze([detection("full", fullBox, 1300, 1200)]);
      const h = extendingHarness({ fullpage, box });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it.each([
      { label: "ninety percent fullpage coverage", box: { ...extendedBox, x: 302 } },
      { label: "twice the character thickness", box: { ...extendedBox, width: 40 } },
      { label: "a quarter thickness beyond padding", box: { ...fullBox, height: 113 } }
    ])("accepts agreed extensions at the $label boundary", async ({ box }) => {
      const h = extendingHarness({ box });

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result).toHaveLength(3);
      expect(groupProductionOcrDetections(result)).toHaveLength(1);
    });

    it.each([
      { fullOrientation: "unknown", orientation: "vertical" },
      { fullOrientation: "vertical", orientation: "unknown" },
      { fullOrientation: "vertical", orientation: "horizontal" }
    ] as const)("rejects ambiguous or different directions: $fullOrientation / $orientation", async ({ fullOrientation, orientation }) => {
      const fullpage = [{ ...detection("full", fullBox, 1300, 1200), orientation: fullOrientation }];
      const h = extendingHarness({ fullpage, orientation });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it.each([[0.49, 0.49], [0.5999, 0.5999], [0.6, 0.5999], [0.99, 0.5999]] as const)("requires both extension scores to reach 0.6: %s / %s", async (first, second) => {
      const fullpage = [detection("full", fullBox, 1300, 1200)];
      const h = extendingHarness({ fullpage, scores: [first, second] });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it.each([0.6, 0.99])("rejects a single extension even at score %s", async (score) => {
      const fullpage = [detection("full", fullBox, 1300, 1200)];
      const h = harness(1300, 1200, fullpage, (rect) => rect.x === 0
        ? [detection("single", extendedBox, 1200, 1200, score)] : []);

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it("does not count different IDs from one tile as independent agreement", async () => {
      const fullpage = [detection("full", fullBox, 1300, 1200)];
      const h = harness(1300, 1200, fullpage, (rect) => rect.x === 0
        ? ["a", "b"].map((id) => detection(id, extendedBox, 1200, 1200, 0.9)) : []);

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it.each([{ height: 187.5, accepted: true }, { height: 187.6, accepted: false }])("requires extension IoU >= 0.8, second height $height", async ({ height, accepted }) => {
      const fullpage = [detection("full", fullBox, 1300, 1200)];
      const h = harness(1300, 1200, fullpage, (rect) => [detection("extension", {
        ...extendedBox, x: 300 - rect.x, height: rect.x === 0 ? 150 : height
      }, 1200, 1200, 0.6)]);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result).toHaveLength(accepted ? 3 : 1);
      if (!accepted) expect(result).toBe(fullpage);
    });

    it.each(["left", "right", "top", "bottom"] as const)("rejects agreement when one raw candidate touches an internal %s edge", async (side) => {
      const box = {
        x: side === "left" ? 116 : side === "right" ? 1164 : 300,
        y: side === "top" ? 116 : side === "bottom" ? 1034 : 300,
        width: 20, height: 100
      };
      const fullpage = [detection("full", box, 1300, 1300)];
      const extended = { ...box, height: 150 };
      const h = harness(1300, 1300, fullpage, (rect) => {
        // Only the two origins along the affected axis produce evidence.
        if ((side === "left" || side === "right") ? rect.y !== 0 : rect.x !== 0) return [];
        return [detection("extension", { ...extended, x: extended.x - rect.x, y: extended.y - rect.y }, 1200, 1200, 0.6)];
      });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it("accepts agreement from different vertical tile origins", async () => {
      const full = detection("full", fullBox, 1200, 1300);
      const h = harness(1200, 1300, [full], (rect) => [detection("extension", {
        ...extendedBox, y: extendedBox.y - rect.y
      }, 1200, 1200, 0.6)]);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual(["full", "detail-tile:0,0:extension", "detail-tile:0,100:extension"]);
      expect(groupProductionOcrDetections(result)).toMatchObject([{ groupBboxPx: extendedBox }]);
    });

    it("compares extension against the original group crop rather than only the covered fullpage member", async () => {
      const fullpage = [
        detection("full", fullBox, 1300, 1200),
        detection("same-group", { x: 325, y: 350, width: 20, height: 100 }, 1300, 1200)
      ];
      expect(groupProductionOcrDetections(fullpage)).toHaveLength(1);
      const h = extendingHarness({ fullpage });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it("preserves all original source IDs when extending a group with multiple members", async () => {
      const fullpage = [
        detection("full", fullBox, 1300, 1200),
        detection("same-group", { ...fullBox, x: 325 }, 1300, 1200)
      ];
      const h = extendingHarness({ fullpage });

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result[0]).toBe(fullpage[0]);
      expect(result[1]).toBe(fullpage[1]);
      expect(groupProductionOcrDetections(result)).toMatchObject([{
        groupBboxPx: { ...extendedBox, width: 45 },
        sourceDetectionIds: ["detail-tile:0,0:extension", "detail-tile:100,0:extension", "full", "same-group"]
      }]);
    });

    it.each([
      { label: "invasion without a grouping bridge", box: { ...fullBox, y: 440 } },
      { label: "a grouping bridge without bbox intersection", box: { ...fullBox, x: 329, y: 365 } }
    ])("blocks $label into another original group", async ({ box }) => {
      const fullpage = [detection("full", fullBox, 1300, 1200), detection("other", box, 1300, 1200)];
      expect(groupProductionOcrDetections(fullpage)).toHaveLength(2);
      const h = extendingHarness({ fullpage });

      expect(await h.adapter.detect({ imageBytes: h.imageBytes })).toBe(fullpage);
    });

    it("does not merge a newly added high-score region through an extension", async () => {
      const full = detection("full", fullBox, 1300, 1200);
      const h = harness(1300, 1200, [full], (rect) => [
        detection("extension", { ...extendedBox, x: 300 - rect.x }, 1200, 1200, 0.6),
        detection("new-region", { x: 329 - rect.x, y: 390, width: 20, height: 100 }, 1200, 1200, 0.9)
      ]);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual(["full", "detail-tile:0,0:new-region"]);
      expect(groupProductionOcrDetections(result)).toHaveLength(2);
    });

    it("checks accumulated extensions so two separately safe pairs cannot bridge original groups", async () => {
      const fullpage = [
        detection("full", fullBox, 1300, 1200),
        detection("other", { ...fullBox, x: 329, y: 425 }, 1300, 1200)
      ];
      const h = harness(1300, 1200, fullpage, (rect) => [
        detection("first", { ...extendedBox, x: 300 - rect.x }, 1200, 1200, 0.65),
        detection("second", { x: 329 - rect.x, y: 365, width: 20, height: 160 }, 1200, 1200, 0.64)
      ]);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual(["full", "other", "detail-tile:0,0:first", "detail-tile:100,0:first"]);
      expect(groupProductionOcrDetections(result).map((group) => group.sourceDetectionIds.filter((id) => id === "full" || id === "other")))
        .toEqual([["other"], ["full"]]);
    });

    it.each(["vertical", "horizontal"] as const)("blocks bbox and padded-crop invasion when %s has the higher score", async (first) => {
      const fullpage = [
        detection("vertical", fullBox, 1300, 1200),
        detection("horizontal", { x: 310, y: 510, width: 100, height: 20 }, 1300, 1200)
      ];
      const h = harness(1300, 1200, fullpage, (rect) => [
        detection("vertical-extension", { ...fullBox, x: 300 - rect.x, height: 200 }, 1200, 1200, first === "vertical" ? 0.65 : 0.64),
        detection("horizontal-extension", { x: 310 - rect.x, y: 490, width: 100, height: 40 }, 1200, 1200, first === "horizontal" ? 0.65 : 0.64)
      ]);

      const result = await h.adapter.detect({ imageBytes: h.imageBytes });

      expect(result.map((item) => item.detectionId)).toEqual([
        // The vertical bbox stops short of the other line, but its actual 8%
        // crop enters that line. Only the horizontal extension is safe.
        "vertical", "horizontal", "detail-tile:0,0:horizontal-extension", "detail-tile:100,0:horizontal-extension"
      ]);
      expect(groupProductionOcrDetections(result)).toHaveLength(2);
    });

    it("discards recorded extension evidence if cancellation arrives with the second tile", async () => {
      const controller = new AbortController();
      const reason = new DOMException("cancelled before extension agreement", "AbortError");
      const fullpage = [detection("full", fullBox, 1300, 1200)];
      const before = structuredClone(fullpage);
      const h = harness(1300, 1200, fullpage, (rect) => {
        if (rect.x === 100) controller.abort(reason);
        return [detection("extension", { ...extendedBox, x: 300 - rect.x }, 1200, 1200, 0.6)];
      });

      await expect(h.adapter.detect({ imageBytes: h.imageBytes, signal: controller.signal })).rejects.toBe(reason);

      expect(h.detect).toHaveBeenCalledTimes(3);
      expect(fullpage).toEqual(before);
    });

    it("propagates grouping dimension errors while checking extension safety", async () => {
      const fullpage = [
        detection("full", fullBox, 1300, 1200),
        detection("invalid-source", { x: 800, y: 800, width: 20, height: 100 }, 1301, 1200)
      ];
      const h = extendingHarness({ fullpage });

      await expect(h.adapter.detect({ imageBytes: h.imageBytes })).rejects.toThrow("must share one source image");
    });
  });

  it.each([
    { side: "internal left at 16", x: 100, y: 0, box: { x: 16, y: 200, width: 60, height: 60 }, kept: false },
    { side: "internal left at 17", x: 100, y: 0, box: { x: 17, y: 200, width: 60, height: 60 }, kept: true },
    { side: "internal right at 16", x: 0, y: 0, box: { x: 1124, y: 200, width: 60, height: 60 }, kept: false },
    { side: "internal right at 17", x: 0, y: 0, box: { x: 1123, y: 200, width: 60, height: 60 }, kept: true },
    { side: "internal top at 16", x: 0, y: 100, box: { x: 200, y: 16, width: 60, height: 60 }, kept: false },
    { side: "internal top at 17", x: 0, y: 100, box: { x: 200, y: 17, width: 60, height: 60 }, kept: true },
    { side: "internal bottom at 16", x: 0, y: 0, box: { x: 200, y: 1124, width: 60, height: 60 }, kept: false },
    { side: "internal bottom at 17", x: 0, y: 0, box: { x: 200, y: 1123, width: 60, height: 60 }, kept: true },
    { side: "source left", x: 0, y: 0, box: { x: 0, y: 200, width: 60, height: 60 }, kept: true },
    { side: "source right", x: 100, y: 0, box: { x: 1140, y: 200, width: 60, height: 60 }, kept: true },
    { side: "source top", x: 0, y: 0, box: { x: 200, y: 0, width: 60, height: 60 }, kept: true },
    { side: "source bottom", x: 0, y: 100, box: { x: 200, y: 1140, width: 60, height: 60 }, kept: true }
  ])("filters clipped candidates only at $side", async ({ x, y, box, kept }) => {
    const h = harness(1300, 1300, [], (rect) => rect.x === x && rect.y === y ? [detection("edge", box, 1200, 1200)] : []);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result).toHaveLength(kept ? 1 : 0);
    if (kept) expect(result[0]!.sourceBboxPx).toEqual({ ...box, x: box.x + x, y: box.y + y });
  });

  it("namespaces repeated tile IDs without colliding with reserved-looking fullpage IDs", async () => {
    const full = [
      detection("detail-tile:0,0:repeat", { x: 2000, y: 900, width: 20, height: 20 }, 2598, 1200),
      detection("_detail-tile:0,0:repeat", { x: 2100, y: 900, width: 20, height: 20 }, 2598, 1200)
    ];
    const h = harness(2598, 1200, full, () => [detection("repeat", { x: 100, y: 100, width: 40, height: 80 }, 1200, 1200)]);

    const result = await h.adapter.detect({ imageBytes: h.imageBytes });

    expect(result.map((item) => item.detectionId)).toEqual([
      ...full.map((item) => item.detectionId),
      "__detail-tile:0,0:repeat", "__detail-tile:1000,0:repeat", "__detail-tile:1398,0:repeat"
    ]);
    expect(new Set(result.map((item) => item.detectionId)).size).toBe(5);
    expect(result[0]).toBe(full[0]);
    expect(result[1]).toBe(full[1]);
  });

  it("deduplicates tile results deterministically by score, completeness, coordinates, and ID despite reversed responses", async () => {
    const run = async (reverse: boolean) => {
      const h = harness(1300, 1200, [], (rect) => {
        const items = rect.x === 0 ? [
          detection("part", { x: 250, y: 250, width: 30, height: 60 }, 1200, 1200),
          detection("whole-z", { x: 250, y: 250, width: 100, height: 60 }, 1200, 1200),
          detection("whole-a", { x: 250, y: 250, width: 100, height: 60 }, 1200, 1200),
          detection("score-winner", { x: 500, y: 400, width: 80, height: 40 }, 1200, 1200, 0.95),
          detection("coord-right", { x: 400, y: 600, width: 40, height: 40 }, 1200, 1200, 0.85),
          detection("coord-left", { x: 300, y: 600, width: 40, height: 40 }, 1200, 1200, 0.85)
        ] : [
          detection("lower-score", { x: 400, y: 400, width: 100, height: 40 }, 1200, 1200, 0.94),
          detection("other-tile-whole", { x: 150, y: 250, width: 100, height: 60 }, 1200, 1200)
        ];
        return reverse ? items.reverse() : items;
      });
      return h.adapter.detect({ imageBytes: h.imageBytes });
    };

    const forward = await run(false);
    const reversed = await run(true);

    expect(reversed).toEqual(forward);
    expect(forward.map((item) => item.detectionId)).toEqual([
      "detail-tile:0,0:score-winner", "detail-tile:0,0:whole-a", "detail-tile:0,0:coord-left", "detail-tile:0,0:coord-right"
    ]);
  });

  it("forwards fullpage warnings unchanged and preserves tile warnings with location context", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: string) => warnings.push(warning);
    const controller = new AbortController();
    const h = harness(2200, 600, [], (rect, input) => {
      expect(input.signal).toBe(controller.signal);
      input.onWarning?.(`tile-warning-${rect.x}`);
      return [];
    });
    h.detect.mockImplementationOnce(async (input) => {
      expect(input.onWarning).toBe(onWarning);
      input.onWarning?.("fullpage-warning");
      return [];
    });

    await h.adapter.detect({ imageBytes: h.imageBytes, signal: controller.signal, onWarning });

    expect(warnings[0]).toBe("fullpage-warning");
    expect(warnings).toHaveLength(3);
    expect(warnings[1]).toContain("tile-warning-0");
    expect(warnings[2]).toContain("tile-warning-1000");
    expect(warnings[2]).toContain("1000,0");
  });

  it("waits for each tile before creating or detecting the next one", async () => {
    let started!: () => void;
    let release!: (value: readonly ProductionOcrDetection[]) => void;
    const tileStarted = new Promise<void>((resolve) => { started = resolve; });
    const tileResult = new Promise<readonly ProductionOcrDetection[]>((resolve) => { release = resolve; });
    const h = harness(2598, 600, [], (rect) => {
      if (rect.x !== 0) return [];
      started();
      return tileResult;
    });

    const pending = h.adapter.detect({ imageBytes: h.imageBytes });
    await tileStarted;

    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(h.crop).toHaveBeenCalledTimes(1);
    release([]);
    expect(await pending).toEqual([]);
    expect(h.detect).toHaveBeenCalledTimes(4);
  });

  it.each(["before", "fullpage", "decode", "crop"] as const)("makes no further detector calls after cancellation at %s", async (stage) => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const h = harness(2598, 600);
    if (stage === "before") controller.abort(reason);
    if (stage === "fullpage") h.detect.mockImplementationOnce(async () => { controller.abort(reason); return []; });
    if (stage === "decode") h.decodeImage.mockImplementationOnce(() => {
      controller.abort(reason);
      return { getSize: () => ({ width: 2598, height: 600 }), crop: h.crop };
    });
    if (stage === "crop") h.crop.mockImplementationOnce((rect) => {
      controller.abort(reason);
      return { toPNG: () => Buffer.from(JSON.stringify(rect)) };
    });

    await expect(h.adapter.detect({ imageBytes: h.imageBytes, signal: controller.signal })).rejects.toBe(reason);

    expect(h.detect).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    if (stage === "before" || stage === "fullpage") expect(h.decodeImage).not.toHaveBeenCalled();
  });

  it("discards an in-flight tile result after cancellation without starting another tile", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled while detecting", "AbortError");
    let started!: () => void;
    let release!: (value: readonly ProductionOcrDetection[]) => void;
    const tileStarted = new Promise<void>((resolve) => { started = resolve; });
    const tileResult = new Promise<readonly ProductionOcrDetection[]>((resolve) => { release = resolve; });
    const h = harness(2598, 600, [], () => { started(); return tileResult; });

    const pending = h.adapter.detect({ imageBytes: h.imageBytes, signal: controller.signal });
    await tileStarted;
    controller.abort(reason);
    release([detection("late", { x: 100, y: 100, width: 40, height: 80 }, 1200, 600)]);

    await expect(pending).rejects.toBe(reason);
    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(h.crop).toHaveBeenCalledTimes(1);
  });

  it.each(["fullpage", "decode", "crop", "png", "tile"] as const)("propagates the original %s error and stops processing", async (stage) => {
    const error = new Error(`isolated ${stage} failure`);
    const h = harness(2598, 600, [], () => { throw error; });
    if (stage === "fullpage") h.detect.mockRejectedValueOnce(error);
    if (stage === "decode") h.decodeImage.mockImplementationOnce(() => { throw error; });
    if (stage === "crop") h.crop.mockImplementationOnce(() => { throw error; });
    if (stage === "png") h.crop.mockImplementationOnce(() => ({ toPNG: () => { throw error; } }));

    await expect(h.adapter.detect({ imageBytes: h.imageBytes })).rejects.toBe(error);

    expect(h.detect).toHaveBeenCalledTimes(stage === "tile" ? 2 : 1);
    expect(h.crop.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([{ width: 1199, height: 600 }, { width: 1200, height: 599 }])("rejects tile dimension mismatch $width x $height even for a clipped candidate", async ({ width, height }) => {
    const h = harness(2598, 600, [], () => [detection("bad-dimensions", { x: 1180, y: 100, width: 5, height: 40 }, width, height)]);

    await expect(h.adapter.detect({ imageBytes: h.imageBytes })).rejects.toThrow("dimensions mismatch");

    expect(h.detect).toHaveBeenCalledTimes(2);
    expect(h.crop).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tile dimensions even when the candidate score is below the detail threshold", async () => {
    const h = harness(2598, 600, [], () => [detection("invalid-weak", { x: 100, y: 100, width: 40, height: 80 }, 1199, 600, 0.4)]);
    await expect(h.adapter.detect({ imageBytes: h.imageBytes })).rejects.toThrow("dimensions mismatch");
    expect(h.detect).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])("rejects invalid decoded image width %s before tiling", async (width) => {
    const h = harness(width, 2598);

    await expect(h.adapter.detect({ imageBytes: h.imageBytes })).rejects.toThrow("image dimensions");

    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.crop).not.toHaveBeenCalled();
  });
});
