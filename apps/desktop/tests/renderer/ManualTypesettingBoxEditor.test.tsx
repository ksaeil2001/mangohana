import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedBbox } from "../../src/shared/speechBubbleExtraction";
import { ManualTypesettingBoxEditor } from "../../src/renderer/components/ManualTypesettingBoxEditor";

const initialBox: NormalizedBbox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const imageRect = { left: 100, top: 50, width: 400, height: 500 };

function ControlledEditor({ initialDraft = null, disabled = false, onApply = vi.fn(), onDraftChange = vi.fn() }: {
  initialDraft?: NormalizedBbox | null;
  disabled?: boolean;
  onApply?: (bbox: NormalizedBbox) => void;
  onDraftChange?: (bbox: NormalizedBbox | null) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  return <ManualTypesettingBoxEditor draft={draft} onDraftChange={(next) => { setDraft(next); onDraftChange(next); }} onApply={onApply} disabled={disabled} />;
}

function measureSurface(rect = imageRect) {
  const surface = screen.getByRole("region", { name: "이미지에서 수동 식자 영역 지정" });
  vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => ({
    ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {}
  }));
  Object.defineProperty(surface, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(surface, "hasPointerCapture", { configurable: true, value: () => true });
  Object.defineProperty(surface, "releasePointerCapture", { configurable: true, value: vi.fn() });
  return surface;
}

function drag(surface: HTMLElement, from: [number, number], to: [number, number], pointerId = 1, target = surface) {
  fireEvent.pointerDown(target, { pointerId, button: 0, isPrimary: true, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(surface, { pointerId, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(surface, { pointerId, clientX: to[0], clientY: to[1] });
}

function expectBox(actual: NormalizedBbox, expected: NormalizedBbox) {
  for (const key of ["x", "y", "width", "height"] as const) expect(actual[key]).toBeCloseTo(expected[key], 10);
}

function openPrecision() {
  const summary = screen.getByText("숫자로 정밀 조정");
  if (!summary.closest("details")?.open) fireEvent.click(summary);
}

afterEach(() => vi.restoreAllMocks());

describe("ManualTypesettingBoxEditor", () => {
  it("기본 화면은 마우스 배치에 집중하고 숫자 조정은 필요할 때 펼친다", () => {
    render(<ControlledEditor initialDraft={initialBox} />);
    expect(screen.getByText("숫자로 정밀 조정").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("spinbutton", { name: "X (%)", hidden: true })).not.toBeVisible();
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeEnabled();
    openPrecision();
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(10);
  });

  it("상자 내부를 잡아 옮기면 크기를 유지하고 적용을 눌러야 저장 콜백에 전달한다", () => {
    const onApply = vi.fn();
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} onDraftChange={onDraftChange} />);
    const surface = measureSurface();
    drag(surface, [180, 250], [260, 300], 1, screen.getByTestId("manual-typesetting-box-preview"));
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
    expect(onApply).not.toHaveBeenCalled();
    openPrecision();
    expect(screen.getByRole("spinbutton", { name: "너비 (%)" })).toHaveValue(30);
    expect(screen.getByRole("spinbutton", { name: "높이 (%)" })).toHaveValue(40);
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expectBox(onApply.mock.calls[0][0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
    expect(initialBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it.each([
    { to: [-300, -200], expected: { x: 0, y: 0, width: 0.3, height: 0.4 } },
    { to: [900, 900], expected: { x: 0.7, y: 0.6, width: 0.3, height: 0.4 } }
  ])("상자를 이미지 밖으로 옮겨도 크기를 줄이지 않고 경계에 멈춘다: $to", ({ to, expected }) => {
    const onApply = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} />);
    drag(measureSurface(), [180, 250], to as [number, number], 1, screen.getByTestId("manual-typesetting-box-preview"));
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expectBox(onApply.mock.calls[0][0], expected);
  });

  it.each([
    { corner: "nw", from: [140, 150], to: [120, 100], expected: { x: 0.05, y: 0.1, width: 0.35, height: 0.5 } },
    { corner: "ne", from: [260, 150], to: [340, 100], expected: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
    { corner: "sw", from: [140, 350], to: [120, 450], expected: { x: 0.05, y: 0.2, width: 0.35, height: 0.6 } },
    { corner: "se", from: [260, 350], to: [340, 450], expected: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } }
  ])("$corner 모서리를 드래그하면 반대 모서리를 유지하며 크기를 조절한다", ({ corner, from, to, expected }) => {
    const onApply = vi.fn();
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} onDraftChange={onDraftChange} />);
    drag(measureSurface(), from as [number, number], to as [number, number], 1, screen.getByTestId(`manual-typesetting-box-handle-${corner}`));
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], expected);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expectBox(onApply.mock.calls[0][0], expected);
  });

  it.each([
    { corner: "nw", from: [140, 150], to: [900, 900], expected: { x: 0.38, y: 0.58, width: 0.02, height: 0.02 } },
    { corner: "se", from: [260, 350], to: [-100, -200], expected: { x: 0.1, y: 0.2, width: 0.02, height: 0.02 } },
    { corner: "nw", from: [140, 150], to: [-100, -200], expected: { x: 0, y: 0, width: 0.4, height: 0.6 } },
    { corner: "se", from: [260, 350], to: [900, 900], expected: { x: 0.1, y: 0.2, width: 0.9, height: 0.8 } }
  ])("$corner 크기 조절은 이미지 경계와 공유 최소 크기 2%를 지킨다: $to", ({ corner, from, to, expected }) => {
    const onApply = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} />);
    drag(measureSurface(), from as [number, number], to as [number, number], 1, screen.getByTestId(`manual-typesetting-box-handle-${corner}`));
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expectBox(onApply.mock.calls[0][0], expected);
  });

  it("기존 상자 밖의 빈 곳을 드래그하면 이전 크기와 관계없이 새 영역을 지정한다", () => {
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onDraftChange={onDraftChange} />);
    drag(measureSurface(), [340, 100], [460, 200]);
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.6, y: 0.1, width: 0.3, height: 0.2 });
  });

  it("이동 도중 확대·이동하면 현재 이미지 좌표를 사용하고 상자와 잡은 지점의 간격을 유지한다", () => {
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onDraftChange={onDraftChange} />);
    const surface = measureSurface();
    fireEvent.pointerDown(screen.getByTestId("manual-typesetting-box-preview"), { pointerId: 1, button: 0, isPrimary: true, clientX: 180, clientY: 250 });
    vi.mocked(surface.getBoundingClientRect).mockReturnValue({ left: -120, top: -80, width: 800, height: 1000, right: 680, bottom: 920, x: -120, y: -80, toJSON() {} });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 200, clientY: 420 });
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
  });

  it("contain 여백을 제외한 표면에서 상자 이동과 크기 조절을 계산한다", () => {
    const onDraftChange = vi.fn();
    render(<div style={{ position: "relative" }}>
      <img alt="격리 테스트 이미지" style={{ objectFit: "contain" }} />
      <ControlledEditor initialDraft={initialBox} onDraftChange={onDraftChange} />
    </div>);
    const surface = measureSurface();
    const image = screen.getByRole("img");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 400 });
    vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => surface.getBoundingClientRect());
    fireEvent.load(image);
    drag(surface, [225, 250], [275, 300], 1, screen.getByTestId("manual-typesetting-box-preview"));
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
    drag(surface, [325, 400], [375, 450], 2, screen.getByTestId("manual-typesetting-box-handle-se"));
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.3, y: 0.3, width: 0.5, height: 0.5 });
  });

  it.each(["pointerCancel", "lostPointerCapture", "blur"] as const)("이동 중 %s 이후에는 마지막 미적용 초안을 보존하고 늦은 이벤트를 무시한다", (event) => {
    const onApply = vi.fn();
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} onDraftChange={onDraftChange} />);
    const surface = measureSurface();
    fireEvent.pointerDown(screen.getByTestId("manual-typesetting-box-preview"), { pointerId: 1, button: 0, isPrimary: true, clientX: 180, clientY: 250 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 260, clientY: 300 });
    if (event === "blur") fireEvent.blur(window);
    else fireEvent[event](surface, { pointerId: 1 });
    onDraftChange.mockClear();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 460, clientY: 500 });
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expectBox(onApply.mock.calls[0][0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
  });

  it("페이지가 바뀌면 이전 모서리 드래그의 늦은 이벤트가 새 페이지 초안을 덮어쓰지 않는다", () => {
    const oldChange = vi.fn();
    const nextChange = vi.fn();
    const { rerender } = render(<ManualTypesettingBoxEditor key="page-1" draft={initialBox} onDraftChange={oldChange} onApply={vi.fn()} />);
    const oldSurface = measureSurface();
    fireEvent.pointerDown(screen.getByTestId("manual-typesetting-box-handle-se"), { pointerId: 1, button: 0, isPrimary: true, clientX: 260, clientY: 350 });
    const nextBox = { x: 0.5, y: 0.1, width: 0.2, height: 0.2 };
    rerender(<ManualTypesettingBoxEditor key="page-2" draft={nextBox} onDraftChange={nextChange} onApply={vi.fn()} />);
    const nextSurface = measureSurface();
    fireEvent.pointerUp(oldSurface, { pointerId: 1, clientX: 460, clientY: 500 });
    fireEvent.pointerMove(nextSurface, { pointerId: 1, clientX: 460, clientY: 500 });
    fireEvent.pointerUp(nextSurface, { pointerId: 1, clientX: 460, clientY: 500 });
    expect(oldChange).not.toHaveBeenCalled();
    expect(nextChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("manual-typesetting-box-preview")).toHaveStyle({ left: "50%", top: "10%", width: "20%", height: "20%" });
  });

  it("비활성 상태에는 상자 내부와 모서리 드래그가 초안을 변경하지 않는다", () => {
    const onDraftChange = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} disabled onDraftChange={onDraftChange} />);
    const surface = measureSurface();
    drag(surface, [180, 250], [260, 300], 1, screen.getByTestId("manual-typesetting-box-preview"));
    drag(surface, [260, 350], [340, 450], 2, screen.getByTestId("manual-typesetting-box-handle-se"));
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("숫자로 정밀 조정하면 진행 중이던 이동의 늦은 이벤트가 입력값을 되돌리지 않는다", () => {
    const onApply = vi.fn();
    render(<ControlledEditor initialDraft={initialBox} onApply={onApply} />);
    const surface = measureSurface();
    fireEvent.pointerDown(screen.getByTestId("manual-typesetting-box-preview"), { pointerId: 1, button: 0, isPrimary: true, clientX: 180, clientY: 250 });
    openPrecision();
    fireEvent.change(screen.getByRole("spinbutton", { name: "X (%)" }), { target: { value: "25" } });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 460, clientY: 500 });
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expectBox(onApply.mock.calls[0][0], { x: 0.25, y: 0.2, width: 0.3, height: 0.4 });
  });

  it("사용자 번역을 배치 미리보기로 표시하며 글자를 잡아도 상자 전체를 이동한다", () => {
    const onApply = vi.fn();
    const onDraftChange = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState<NormalizedBbox | null>(initialBox);
      return <ManualTypesettingBoxEditor draft={draft} previewText="선택한 사용자 번역문" onDraftChange={(next) => { setDraft(next); onDraftChange(next); }} onApply={onApply} />;
    }
    render(<Editor />);
    const surface = measureSurface();
    expect(screen.getByTestId("manual-typesetting-box-preview")).toHaveTextContent("배치 미리보기");
    expect(onDraftChange).not.toHaveBeenCalled();
    drag(surface, [180, 250], [260, 300], 1, screen.getByText("선택한 사용자 번역문"));
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.3, y: 0.3, width: 0.3, height: 0.4 });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps coordinate controls in a separate inspector when a target is supplied", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const { container, unmount } = render(<ManualTypesettingBoxEditor draft={null} onDraftChange={vi.fn()} onApply={vi.fn()} controlsTarget={target} />);
    expect(target.querySelector("fieldset")).not.toBeNull();
    expect(container.querySelector("fieldset")).toBeNull();
    unmount();
    target.remove();
  });
  it("keeps areas below the shared output minimum as drafts rather than applying them", () => {
    const tiny = { x: 0.2, y: 0.3, width: 0.01, height: 0.1 };
    const onApply = vi.fn();
    render(<ManualTypesettingBoxEditor draft={tiny} onDraftChange={vi.fn()} onApply={onApply} />);
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("2% 이상");
  });
  it("사용자 입력 전에는 좌표를 만들지 않고 적용할 수 없는 이유를 안내한다", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} />);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    openPrecision();
    for (const input of screen.getAllByRole("spinbutton")) expect(input).toHaveValue(null);
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "영역 적용" })).toHaveAccessibleDescription(/끌어|끌기/);
    expect(screen.queryByTestId("manual-typesetting-box-preview")).not.toBeInTheDocument();
  });

  it.each([
    { name: "좌상에서 우하", from: [140, 150], to: [380, 450] },
    { name: "우하에서 좌상", from: [380, 450], to: [140, 150] },
    { name: "우상에서 좌하", from: [380, 150], to: [140, 450] },
    { name: "좌하에서 우상", from: [140, 450], to: [380, 150] }
  ])("$name 드래그를 이미지 정규화 좌표로 바꾸며 자동 확정하지 않는다", ({ from, to }) => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} />);
    const surface = measureSurface();
    drag(surface, from as [number, number], to as [number, number]);
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.1, y: 0.2, width: 0.6, height: 0.6 });
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each([
    { from: [-100, -200], to: [900, 900] },
    { from: [900, 900], to: [-100, -200] }
  ])("이미지 밖으로 드래그하면 실제 경계에서 자른다: $from → $to", ({ from, to }) => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    drag(measureSurface(), from as [number, number], to as [number, number]);
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0, y: 0, width: 1, height: 1 });
  });

  it.each([[140, 150], [140, 450], [380, 150]])("크기가 0인 드래그는 유효한 초안을 만들지 않는다: %s, %s", (x, y) => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    drag(measureSurface(), [140, 150], [x, y]);
    expect(onDraftChange.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
  });

  it("드래그가 다시 크기 0으로 돌아오면 이전 중간 영역을 적용하지 않는다", () => {
    render(<ControlledEditor />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeEnabled();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 140, clientY: 150 });
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
  });

  it("이동 이벤트 없이 놓아도 마지막 포인터 위치를 사용한다", () => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.1, y: 0.2, width: 0.6, height: 0.6 });
  });

  it("확대와 이동 뒤 변경된 이미지 rect로 같은 좌표를 계산한다", () => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface({ left: -120, top: -80, width: 800, height: 1000 });
    drag(surface, [-40, 120], [440, 720]);
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.1, y: 0.2, width: 0.6, height: 0.6 });
  });

  it("드래그 도중 확대·이동해도 이미지에 고정된 시작점과 현재 rect를 사용한다", () => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    vi.mocked(surface.getBoundingClientRect).mockReturnValue({ left: -120, top: -80, width: 800, height: 1000, right: 680, bottom: 920, x: -120, y: -80, toJSON() {} });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 440, clientY: 720 });
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.1, y: 0.2, width: 0.6, height: 0.6 });
  });

  it("드래그 초안은 부모가 소유하며 버튼으로 적용한 경우에만 확정 콜백을 호출한다", () => {
    const onApply = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState<NormalizedBbox | null>(initialBox);
      return <ManualTypesettingBoxEditor draft={draft} onDraftChange={setDraft} onApply={onApply} />;
    }
    render(<Editor />);
    drag(measureSurface(), [140, 150], [380, 450]);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId("manual-typesetting-box-preview")).toHaveStyle({ left: "10%", top: "20%" });
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expectBox(onApply.mock.calls[0][0], { x: 0.1, y: 0.2, width: 0.6, height: 0.6 });
    expect(initialBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it("소수 좌표가 길어지는 이미지에서도 드래그한 영역을 그대로 적용할 수 있다", () => {
    const onApply = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState<NormalizedBbox | null>(null);
      return <ManualTypesettingBoxEditor draft={draft} onDraftChange={setDraft} onApply={onApply} />;
    }
    render(<Editor />);
    drag(measureSurface({ left: 100, top: 50, width: 397, height: 613 }), [110, 81], [453, 501]);
    const apply = screen.getByRole("button", { name: "영역 적용" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expectBox(onApply.mock.calls[0][0], { x: 10 / 397, y: 31 / 613, width: 343 / 397, height: 420 / 613 });
  });

  it.each([
    { width: 450, fromX: 220, toX: 550, x: 4 / 15, boxWidth: 11 / 15 },
    { width: 480, fromX: 120, toX: 580, x: 1 / 24, boxWidth: 23 / 24 }
  ])("이미지 끝까지 그린 영역의 부동소수점 오차로 적용을 막지 않는다: $width", ({ width, fromX, toX, x, boxWidth }) => {
    const onApply = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState<NormalizedBbox | null>(null);
      return <ManualTypesettingBoxEditor draft={draft} onDraftChange={setDraft} onApply={onApply} />;
    }
    render(<Editor />);
    drag(measureSurface({ ...imageRect, width }), [fromX, 150], [toX, 550]);
    const apply = screen.getByRole("button", { name: "영역 적용" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expectBox(onApply.mock.calls[0][0], { x, y: 0.2, width: boxWidth, height: 0.8 });
  });

  it("contain 여백을 제외한 이미지 표면을 측정하고 미리보기도 그 표면에 맞춘다", () => {
    const onDraftChange = vi.fn();
    const { container } = render(<div style={{ position: "relative" }}>
      <img alt="격리 테스트 이미지" style={{ objectFit: "contain" }} />
      <ManualTypesettingBoxEditor draft={initialBox} onDraftChange={onDraftChange} onApply={vi.fn()} />
    </div>);
    const surface = measureSurface();
    const image = screen.getByRole("img");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 400 });
    vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => surface.getBoundingClientRect());
    fireEvent.load(image);
    expect(screen.getByTestId("manual-typesetting-box-preview")).toHaveStyle({ left: "25%", top: "20%", width: "18.75%", height: "40%" });
    drag(surface, [200, 100], [400, 500]);
    expectBox(onDraftChange.mock.calls.at(-1)?.[0], { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    expect(container.querySelector(".manual-typesetting-box-editor")).toBeInTheDocument();
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])("이미지 치수가 유효하지 않으면 초안을 만들지 않는다: %s", (width) => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    drag(measureSurface({ ...imageRect, width }), [140, 150], [380, 450]);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("키보드로 네 값을 입력한 뒤 명시적으로 적용하며 전역 단축키로 전파하지 않는다", () => {
    const onApply = vi.fn();
    const onKeyDown = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState<NormalizedBbox | null>(null);
      return <ManualTypesettingBoxEditor draft={draft} onDraftChange={setDraft} onApply={onApply} />;
    }
    render(<div onKeyDown={onKeyDown}><Editor /></div>);
    openPrecision();
    for (const [label, value] of [["X (%)", "10"], ["Y (%)", "20"], ["너비 (%)", "30"], ["높이 (%)", "40"]]) {
      const input = screen.getByRole("spinbutton", { name: label });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveValue(Number(value));
    }
    expect(onApply).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(initialBox);
  });

  it.each([
    { label: "X (%)", value: "-1" },
    { label: "Y (%)", value: "101" },
    { label: "너비 (%)", value: "0" },
    { label: "높이 (%)", value: "-5" },
    { label: "너비 (%)", value: "95" },
    { label: "높이 (%)", value: "90" },
    { label: "X (%)", value: "" }
  ])("잘못된 숫자는 적용을 차단하고 이유를 연결한다: $label=$value", ({ label, value }) => {
    render(<ControlledEditor initialDraft={initialBox} />);
    openPrecision();
    const input = screen.getByRole("spinbutton", { name: label });
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/입력|초과|커야|범위|사이/);
    // 잘못된 입력을 부모가 null로 되돌려도 다른 입력값은 조용히 사라지지 않는다.
    if (label !== "Y (%)") expect(screen.getByRole("spinbutton", { name: "Y (%)" })).toHaveValue(20);
  });

  it("부모의 초안 교체와 숨김 후 재표시를 따르고 mount에서 콜백을 호출하지 않는다", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(<ManualTypesettingBoxEditor draft={initialBox} onDraftChange={onDraftChange} onApply={onApply} />);
    openPrecision();
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(10);
    const next = { x: 0.25, y: 0.1, width: 0.25, height: 0.5 };
    rerender(<ManualTypesettingBoxEditor draft={next} onDraftChange={onDraftChange} onApply={onApply} />);
    expect(screen.getByTestId("manual-typesetting-box-preview")).toHaveStyle({ left: "25%", top: "10%", width: "25%", height: "50%" });
    rerender(<></>);
    rerender(<ManualTypesettingBoxEditor draft={next} onDraftChange={onDraftChange} onApply={onApply} />);
    openPrecision();
    expect(screen.getByRole("spinbutton", { name: "너비 (%)" })).toHaveValue(25);
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(next);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it.each([
    { ...initialBox, x: Number.NaN },
    { ...initialBox, height: Number.POSITIVE_INFINITY },
    { ...initialBox, width: 0 },
    { ...initialBox, x: 0.9 }
  ])("부모가 잘못된 좌표를 넘겨도 미리보기나 적용에 사용하지 않는다: $x, $width, $height", (draft) => {
    const onApply = vi.fn();
    render(<ManualTypesettingBoxEditor draft={draft} onDraftChange={vi.fn()} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByTestId("manual-typesetting-box-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
  });

  it("비활성 상태에는 포인터와 숫자 변경 및 적용을 차단하고 이유를 표시한다", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    render(<ManualTypesettingBoxEditor draft={initialBox} onDraftChange={onDraftChange} onApply={onApply} disabled disabledReason="이미지를 불러오는 중입니다." />);
    const surface = measureSurface();
    drag(surface, [140, 150], [380, 450]);
    openPrecision();
    const input = screen.getByRole("spinbutton", { name: "X (%)" });
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(input).toBeDisabled();
    expect(input).toHaveValue(10);
    expect(surface).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "영역 적용" })).toHaveAccessibleDescription(/이미지를 불러오는 중/);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("비활성 전환 뒤 이전 포인터 작업이 다시 초안을 쓰지 못한다", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    rerender(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} disabled />);
    rerender(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} />);
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("드래그 도중 부모가 다른 초안을 선택하면 이전 작업을 중단한다", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={onApply} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    rerender(<ManualTypesettingBoxEditor draft={initialBox} onDraftChange={onDraftChange} onApply={onApply} />);
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledExactlyOnceWith(initialBox);
  });

  it("창 포커스를 잃으면 포인터 작업을 중단한다", () => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent.blur(window);
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)("%s 뒤의 포인터 결과를 무시한다", (event) => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent[event](surface, { pointerId: 1 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("다른 포인터와 보조 버튼 및 숫자 컨트롤 클릭은 드래그를 시작하지 않는다", () => {
    const onDraftChange = vi.fn();
    render(<ManualTypesettingBoxEditor draft={null} onDraftChange={onDraftChange} onApply={vi.fn()} />);
    const surface = measureSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 2, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    openPrecision();
    fireEvent.pointerDown(screen.getByRole("spinbutton", { name: "X (%)" }), { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 380, clientY: 450 });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, isPrimary: true, clientX: 140, clientY: 150 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 380, clientY: 450 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 380, clientY: 450 });
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});
