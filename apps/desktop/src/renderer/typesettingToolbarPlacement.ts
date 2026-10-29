export type ToolbarRect = { left: number; top: number; right: number; bottom: number };

/** Screen coordinates only: never changes the image-space typesetting draft. */
export function placeTypesettingToolbar(anchor: ToolbarRect, size: { width: number; height: number }, bounds: ToolbarRect, obstacles: ToolbarRect[], gap = 8) {
  const { width, height } = size;
  if (width > bounds.right - bounds.left || height > bounds.bottom - bounds.top) return null;
  const clampX = (x: number) => Math.max(bounds.left, Math.min(x, bounds.right - width));
  const clampY = (y: number) => Math.max(bounds.top, Math.min(y, bounds.bottom - height));
  const centerX = (anchor.left + anchor.right - width) / 2;
  const centerY = (anchor.top + anchor.bottom - height) / 2;
  const candidates = [
    { left: centerX, top: anchor.top - height - gap },
    { left: centerX, top: anchor.bottom + gap },
    { left: anchor.right + gap, top: centerY },
    { left: anchor.left - width - gap, top: centerY }
  ];
  // Clamped anchors and obstacle edges also cover a partially offscreen selection.
  const xs = [clampX(centerX), bounds.left, bounds.right - width, ...obstacles.flatMap((r) => [r.left - width - gap, r.right + gap])];
  const ys = [clampY(anchor.top - height - gap), bounds.top, bounds.bottom - height, ...obstacles.flatMap((r) => [r.top - height - gap, r.bottom + gap])];
  const overlaps = (a: ToolbarRect, b: ToolbarRect) => a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
  const inside = (r: ToolbarRect) => r.left >= bounds.left && r.top >= bounds.top && r.right <= bounds.right && r.bottom <= bounds.bottom;
  const rect = (p: { left: number; top: number }) => ({ ...p, right: p.left + width, bottom: p.top + height });
  const clear = (r: ToolbarRect) => inside(r) && obstacles.every((o) => !overlaps(r, o));
  const attached = candidates.map((p) => rect({ left: clampX(p.left), top: p.top })).find((r) => clear(r) && !overlaps(r, anchor));
  if (attached) return attached;
  return xs.flatMap((left) => ys.map((top) => rect({ left, top }))).filter(clear)
    .sort((a, b) => Math.hypot(a.left - centerX, a.top - centerY) - Math.hypot(b.left - centerX, b.top - centerY))[0] ?? null;
}
