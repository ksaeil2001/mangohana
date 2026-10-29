/**
 * Keyboard shortcuts map and helpers for Trio desktop workbench.
 */

export interface ShortcutDefinition {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  label: string;
  description: string;
  category: "navigation" | "editing" | "view" | "project";
}

export const SHORTCUTS: Record<string, ShortcutDefinition> = {
  PREV_PAGE: {
    key: "ArrowLeft",
    label: "←",
    description: "이전 페이지",
    category: "navigation"
  },
  NEXT_PAGE: {
    key: "ArrowRight",
    label: "→",
    description: "다음 페이지",
    category: "navigation"
  },
  PREV_ISSUE: {
    key: "[",
    label: "[",
    description: "이전 문제 라인",
    category: "navigation"
  },
  NEXT_ISSUE: {
    key: "]",
    label: "]",
    description: "다음 문제 라인",
    category: "navigation"
  },
  CONFIRM_NEXT: {
    key: "Enter",
    ctrlKey: true,
    label: "Ctrl+Enter",
    description: "완료하고 다음 대사",
    category: "editing"
  },
  ESCAPE: {
    key: "Escape",
    label: "Esc",
    description: "선택 해제 / 포커스 모드 해제",
    category: "navigation"
  },
  TOGGLE_FOCUS: {
    key: " ",
    label: "Space",
    description: "집중 모드 토글",
    category: "view"
  },
  SAVE: {
    key: "s",
    ctrlKey: true,
    label: "Ctrl+S",
    description: "프로젝트 저장",
    category: "project"
  },
  ZOOM_IN: {
    key: "=",
    ctrlKey: true,
    label: "Ctrl++",
    description: "확대",
    category: "view"
  },
  ZOOM_OUT: {
    key: "-",
    ctrlKey: true,
    label: "Ctrl+-",
    description: "축소",
    category: "view"
  },
  ZOOM_FIT: {
    key: "0",
    ctrlKey: true,
    label: "Ctrl+0",
    description: "화면에 맞춤",
    category: "view"
  },
  HOLD_ORIGINAL: {
    key: "\\",
    label: "\\ (누른 채 유지)",
    description: "원본 이미지 보기",
    category: "view"
  },
  TOGGLE_SIDEBAR: {
    key: "b",
    ctrlKey: true,
    label: "Ctrl+B",
    description: "사이드바 토글",
    category: "view"
  }
};

export function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}
