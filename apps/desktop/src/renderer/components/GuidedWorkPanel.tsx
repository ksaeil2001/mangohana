import { useEffect, useRef, type PropsWithChildren } from "react";
import type { GuidedStage, GuidanceDensity } from "../guidedWorkflow";

type Props = PropsWithChildren<{
  stage: GuidedStage;
  density: GuidanceDensity;
  summaries?: Partial<Record<GuidedStage, string>>;
  onDensityChange: (density: GuidanceDensity) => void;
}>;

const stages: Array<{ id: GuidedStage; label: string; description: string }> = [
  { id: "ocr", label: "OCR 확인", description: "적용할 텍스트와 범위를 확인합니다." },
  { id: "speaker", label: "화자 확인", description: "화자 후보와 신뢰도를 확인합니다." },
  { id: "translation", label: "번역 수정", description: "사용자 수정문을 확정합니다." },
  { id: "complete", label: "완료", description: "다음 대사 또는 페이지로 이동합니다." }
];

export function GuidedWorkPanel({ stage, density, summaries = {}, onDensityChange, children }: Props) {
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const compact = density === "compact";
  const contentRef = useRef<HTMLDivElement>(null);
  const previousStageRef = useRef(stage);

  useEffect(() => {
    if (previousStageRef.current !== stage) contentRef.current?.focus();
    previousStageRef.current = stage;
  }, [stage]);

  return (
    <section className={`guided-work-panel ${compact ? "compact" : "guided"}`} aria-label="번역 작업 단계">
      <header className="guided-work-header">
        <div>
          <strong>현재 작업</strong>
          <span>{stages[currentIndex].label}</span>
        </div>
        <button
          type="button"
          aria-pressed={compact}
          aria-label={compact ? "가이드 패널 펼치기" : "가이드 패널 접기"}
          onClick={() => onDensityChange(compact ? "guided" : "compact")}
        >
          {compact ? "펼치기" : "접기"}
        </button>
      </header>

      <div className="guided-stage-progress" role="progressbar" aria-label="번역 작업 순서" aria-valuemin={1} aria-valuemax={stages.length} aria-valuenow={currentIndex + 1}>
        <span>{currentIndex + 1} / {stages.length}</span>
        {!compact ? <small>{summaries[stage] || stages[currentIndex].description}</small> : null}
      </div>
      <ol className="sr-only" aria-label="번역 작업 단계 세부 정보">
        {stages.map((item, index) => <li key={item.id} aria-current={index === currentIndex ? "step" : undefined}><strong>{item.label}</strong><small>{summaries[item.id] || item.description}</small></li>)}
      </ol>

      <div
        ref={contentRef}
        className="guided-work-content"
        data-active-stage={stage}
        role="region"
        aria-label={`${stages[currentIndex].label} 작업`}
        tabIndex={-1}
      >
        {children}
      </div>
    </section>
  );
}
