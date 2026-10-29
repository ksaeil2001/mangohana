import { useEffect, useRef, type ReactNode } from "react";
import type { DrawerDestination } from "../focusDeck";

const labels: Record<DrawerDestination, string> = {
  pages: "페이지",
  context: "문맥",
  settings: "설정"
};

interface ToolDrawerProps {
  destination: DrawerDestination;
  onClose: () => void;
  children: ReactNode;
}

export function ToolDrawer({ destination, onClose, children }: ToolDrawerProps) {
  const label = labels[destination];
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = closeRef.current?.closest(".focus-deck-shell");
    const backgroundRegions = Array.from(shell?.querySelectorAll<HTMLElement>(
      ".focus-deck-top-bar, .focus-deck-rail, .resizable-workspace, .focus-deck-filmstrip"
    ) ?? []);
    const newlyInertRegions = backgroundRegions.filter((region) => !region.hasAttribute("inert"));
    newlyInertRegions.forEach((region) => region.setAttribute("inert", ""));
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      newlyInertRegions.forEach((region) => region.removeAttribute("inert"));
      invoker?.focus();
    };
  }, []);

  return (
    <div className="tool-drawer-overlay">
      <div
        className="tool-drawer-backdrop"
        data-testid="tool-drawer-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside className="tool-drawer" role="dialog" aria-modal="false" aria-label={`${label} 도구 서랍`}>
        <div className="tool-drawer-header">
          <strong>{label}</strong>
          <button ref={closeRef} type="button" aria-label={`${label} 도구 서랍 닫기`} onClick={onClose}>
            닫기
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}
