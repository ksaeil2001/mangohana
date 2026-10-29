import type { NormalizedBbox, PolygonPoint } from "../speechBubbleExtraction.js";

export type ReadingDirection = "rtl" | "ltr";

export type PanelRegion = {
  id: string;
  panelIndex: number;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
};

export type LayoutBubble = {
  id: string;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  readingOrder?: number;
  panelIndex?: number;
};

export type TypesettingSafeAreaOptions = {
  paddingRatio?: number; // e.g. 0.08 (8% inner padding from bubble border)
  minWidthRatio?: number;
  minHeightRatio?: number;
  shape?: "rectangle" | "ellipse" | "rounded_rectangle" | "cloud" | "spiky";
};

/**
 * Checks if a 2D normalized coordinate is inside a normalized bounding box.
 */
export function isPointInsideBbox(point: { x: number; y: number }, bbox: NormalizedBbox): boolean {
  return (
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.width &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.height
  );
}

/**
 * Calculates the center point of a bounding box.
 */
export function getBboxCenter(bbox: NormalizedBbox): { x: number; y: number } {
  return {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2
  };
}

/**
 * Calculates the overlap area between two normalized bounding boxes.
 */
export function calculateBboxOverlapArea(a: NormalizedBbox, b: NormalizedBbox): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

/**
 * Assigns each speech bubble to its containing panel based on center inclusion or largest overlap.
 */
export function assignBubblesToPanels<T extends LayoutBubble>(
  panels: PanelRegion[],
  bubbles: T[]
): Array<T & { panelIndex?: number }> {
  if (!panels.length) {
    return bubbles.map((bubble) => ({ ...bubble }));
  }

  return bubbles.map((bubble) => {
    const center = getBboxCenter(bubble.bbox);

    // 1차: 중심점이 패널 내부에 포함되는지 검사
    const containingPanel = panels.find((panel) => isPointInsideBbox(center, panel.bbox));
    if (containingPanel) {
      return { ...bubble, panelIndex: containingPanel.panelIndex };
    }

    // 2차: 중첩 면적이 가장 큰 패널 검색
    let maxOverlap = 0;
    let bestPanel: PanelRegion | undefined;

    for (const panel of panels) {
      const overlap = calculateBboxOverlapArea(bubble.bbox, panel.bbox);
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestPanel = panel;
      }
    }

    if (bestPanel && maxOverlap > 0) {
      return { ...bubble, panelIndex: bestPanel.panelIndex };
    }

    return { ...bubble };
  });
}

/**
 * Sorts panels according to standard manga layout rules:
 * - RTL (Japanese Manga): Top-to-Bottom, Right-to-Left within similar rows.
 * - LTR (Western Comics / Webtoon): Top-to-Bottom, Left-to-Right.
 */
export function sortPanels(panels: PanelRegion[], direction: ReadingDirection = "rtl"): PanelRegion[] {
  const rowThreshold = 0.08; // 8% vertical tolerance to consider panels in the same row/tier

  return [...panels].sort((a, b) => {
    const verticalDiff = a.bbox.y - b.bbox.y;

    if (Math.abs(verticalDiff) > rowThreshold) {
      return verticalDiff; // Top to bottom first
    }

    // Same row: apply horizontal direction
    if (direction === "rtl") {
      return (b.bbox.x + b.bbox.width) - (a.bbox.x + a.bbox.width); // Rightmost first
    } else {
      return a.bbox.x - b.bbox.x; // Leftmost first
    }
  });
}

/**
 * bubble-detector 원칙 기반 2단계 읽는 순서 정렬 (Panel-first Reading Order):
 * 1. 패널 순서 정렬 (RTL: 우상단 -> 좌하단)
 * 2. 각 패널 내부의 말풍선을 패널 내 위치 기준으로 정렬
 * 3. 패널에 속하지 않은 말풍선은 전역 좌표 기준으로 병합
 */
export function sortMangaReadingOrder<T extends LayoutBubble>(
  panels: PanelRegion[],
  bubbles: T[],
  direction: ReadingDirection = "rtl"
): Array<T & { readingOrder: number; panelIndex?: number }> {
  if (!bubbles.length) return [];

  // 패널이 없는 경우: 전체 말풍선에 대해 1단계 전역 정렬 적용
  if (!panels.length) {
    return sortBubblesInRegion(bubbles, direction).map((bubble, index) => ({
      ...bubble,
      readingOrder: index + 1
    }));
  }

  // 1. 패널 정렬 및 인덱스 매핑
  const sortedPanels = sortPanels(panels, direction);
  const panelOrderMap = new Map<number, number>();
  sortedPanels.forEach((p, idx) => {
    panelOrderMap.set(p.panelIndex, idx + 1);
  });

  // 2. 말풍선 패널 할당
  const assignedBubbles = assignBubblesToPanels(sortedPanels, bubbles);

  // 3. 패널별 그룹화
  const panelGroups = new Map<number, Array<T & { panelIndex?: number }>>();
  const unassignedBubbles: Array<T & { panelIndex?: number }> = [];

  for (const bubble of assignedBubbles) {
    if (typeof bubble.panelIndex === "number" && panelOrderMap.has(bubble.panelIndex)) {
      const list = panelGroups.get(bubble.panelIndex) ?? [];
      list.push(bubble);
      panelGroups.set(bubble.panelIndex, list);
    } else {
      unassignedBubbles.push(bubble);
    }
  }

  // 4. 각 패널 내부 말풍선 정렬
  const result: Array<T & { readingOrder: number; panelIndex?: number }> = [];

  for (const panel of sortedPanels) {
    const group = panelGroups.get(panel.panelIndex);
    if (group && group.length > 0) {
      const sortedGroup = sortBubblesInRegion(group, direction);
      for (const item of sortedGroup) {
        result.push({
          ...item,
          readingOrder: result.length + 1
        });
      }
    }
  }

  // 5. 미할당 말풍선 정렬 후 병합 (기존 순서와 전역 Y좌표를 고려해 적절한 위치에 삽입)
  if (unassignedBubbles.length > 0) {
    const sortedUnassigned = sortBubblesInRegion(unassignedBubbles, direction);
    for (const item of sortedUnassigned) {
      result.push({
        ...item,
        readingOrder: result.length + 1
      });
    }
  }

  return result;
}

/**
 * Sorts bubbles within a single region/panel based on reading direction.
 */
export function sortBubblesInRegion<T extends LayoutBubble>(
  bubbles: T[],
  direction: ReadingDirection = "rtl"
): T[] {
  const rowThreshold = 0.05; // 5% vertical tolerance

  return [...bubbles].sort((a, b) => {
    const verticalDiff = a.bbox.y - b.bbox.y;

    if (Math.abs(verticalDiff) > rowThreshold) {
      return verticalDiff;
    }

    if (direction === "rtl") {
      return (b.bbox.x + b.bbox.width) - (a.bbox.x + a.bbox.width); // Rightmost first
    } else {
      return a.bbox.x - b.bbox.x; // Leftmost first
    }
  });
}

/**
 * bubble-detector 기반 안전 식자 영역(Typesetting Safe-Area) 계산:
 * 말풍선 외곽선 및 형태(타원, 구름형 등)에 맞춰 텍스트가 경계선을 침범하지 않도록 내부 안전 박스를 산출합니다.
 */
export function calculateTypesettingSafeArea(
  bubbleBbox: NormalizedBbox,
  options: TypesettingSafeAreaOptions = {}
): NormalizedBbox {
  const paddingRatio = options.paddingRatio ?? 0.08;
  const minWidthRatio = options.minWidthRatio ?? 0.2;
  const minHeightRatio = options.minHeightRatio ?? 0.2;
  const shape = options.shape ?? "ellipse";

  // 형태별 추가 안전 여백 배율 (타원 및 뾰족한 말풍선은 모서리 영역이 좁으므로 여백 추가)
  let shapeFactor = 1.0;
  if (shape === "ellipse" || shape === "cloud") {
    shapeFactor = 1.25;
  } else if (shape === "spiky") {
    shapeFactor = 1.4;
  }

  const horizontalPadding = bubbleBbox.width * paddingRatio * shapeFactor;
  const verticalPadding = bubbleBbox.height * paddingRatio * shapeFactor;

  const safeWidth = Math.max(bubbleBbox.width * minWidthRatio, bubbleBbox.width - horizontalPadding * 2);
  const safeHeight = Math.max(bubbleBbox.height * minHeightRatio, bubbleBbox.height - verticalPadding * 2);

  const safeX = bubbleBbox.x + (bubbleBbox.width - safeWidth) / 2;
  const safeY = bubbleBbox.y + (bubbleBbox.height - safeHeight) / 2;

  return {
    x: Math.max(0, Math.min(1, safeX)),
    y: Math.max(0, Math.min(1, safeY)),
    width: Math.max(0.01, Math.min(1 - safeX, safeWidth)),
    height: Math.max(0.01, Math.min(1 - safeY, safeHeight))
  };
}
