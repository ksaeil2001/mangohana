import { Button } from "./Ui.js";
import type { CSSProperties } from "react";
import {
  OVERLAY_KIND_ORDER,
  getSemanticOverlayMeta,
  selectVisibleSemanticOverlays,
  type SemanticOverlayDescriptor
} from "../semanticOverlays";
import type { OverlayKind } from "../trioState";

type Props = {
  overlays: readonly SemanticOverlayDescriptor[];
  visibleKinds?: readonly OverlayKind[];
  selectedIds?: readonly string[];
  maxUnselected?: number;
  onToggleKind?: (kind: OverlayKind) => void;
};

export function SemanticOverlayLayer({

  overlays,
  visibleKinds = OVERLAY_KIND_ORDER,
  selectedIds,
  maxUnselected,
  onToggleKind
}: Props) {
  const visibleOverlays = selectVisibleSemanticOverlays(overlays, {
    visibleKinds,
    selectedIds,
    maxUnselected
  });

  return (
    <div
      className="semantic-overlay-layer"
      data-testid="semantic-overlay-layer"
      data-coordinate-space="image"
      aria-label="의미 오버레이"
    >
        {visibleOverlays.map((overlay) => {
          const meta = getSemanticOverlayMeta(overlay.kind);
          const label = overlay.label ?? meta.label;
          const accessibleLabel = overlay.accessibleLabel ?? `${label} (${overlay.kind})`;
          const style = {
            left: `${overlay.bbox.x * 100}%`,
            top: `${overlay.bbox.y * 100}%`,
            width: `${overlay.bbox.width * 100}%`,
            height: `${overlay.bbox.height * 100}%`
          } as CSSProperties;

          return (
            <div
              key={overlay.id}
              className={`semantic-overlay ${meta.className}${overlay.className ? ` ${overlay.className}` : ""}${overlay.selected ? " is-selected" : ""}`}
              data-testid={`semantic-overlay-${overlay.id}`}
              data-overlay-kind={overlay.kind}
              data-overlay-pattern={meta.pattern}
              data-overlay-line-style={meta.lineStyle}
              data-overlay-selected={overlay.selected ? "true" : "false"}
              role="img"
              aria-label={accessibleLabel}
              style={style}
            >
              <span className="semantic-overlay-label">{label}</span>
            </div>
          );
        })}
    </div>
  );
}
type LegendProps = Pick<Props, "visibleKinds" | "onToggleKind"> & {
  onToggleAll?: (enableAll: boolean) => void;
};


export function SemanticOverlayLegend({ visibleKinds = OVERLAY_KIND_ORDER, onToggleKind, onToggleAll }: LegendProps) {
  const allVisible = OVERLAY_KIND_ORDER.every((k) => visibleKinds.includes(k));

  return (
    <div className="semantic-overlay-legend" data-testid="semantic-overlay-legend" aria-label="오버레이 범례">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--trio-space-1)" }}>
        <strong>오버레이 범례</strong>
        {onToggleKind && (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label={allVisible ? "오버레이 전체 끄기" : "오버레이 전체 켜기"}
            onClick={() => {
              if (onToggleAll) {
                onToggleAll(!allVisible);
              } else {
                for (const kind of OVERLAY_KIND_ORDER) {
                  const isVis = visibleKinds.includes(kind);
                  if (allVisible && isVis) onToggleKind(kind);
                  else if (!allVisible && !isVis) onToggleKind(kind);
                }
              }
            }}
          >
            {allVisible ? "전체 끄기" : "전체 켜기"}
          </Button>
        )}
      </div>
      <div className="semantic-overlay-legend-items">
        {OVERLAY_KIND_ORDER.map((kind) => {
          const meta = getSemanticOverlayMeta(kind);
          const isVisible = visibleKinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              className={`semantic-overlay-toggle ${meta.className}`}
              aria-label={kind === "inpainting-mask" ? "inpainting-mask overlay" : `${kind} 오버레이 ${meta.label}`}
              aria-pressed={isVisible}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onToggleKind?.(kind)}
            >
              <span className="semantic-overlay-swatch" data-overlay-pattern={meta.pattern} aria-hidden="true" />
              <span>{meta.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
