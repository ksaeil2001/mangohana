import { Button } from "./Ui.js";
import type { Ref } from "react";

type WorkspaceStartPanelProps = {
  apiReady: boolean;
  isStartingImageProject: boolean;
  isImportingTxt: boolean;
  statusMessage: string;
  onStartImageProject: () => void;
  onImportTxt: () => void;
  onOpenProject: () => void;
  primaryActionRef?: Ref<HTMLButtonElement>;
};

export function WorkspaceStartPanel(props: WorkspaceStartPanelProps) {
  const isBusy = props.isStartingImageProject || props.isImportingTxt;

  return (
    <section className="workspace-start-panel" aria-labelledby="workspace-start-heading">
      <p className="workspace-start-eyebrow">이미지 불러오기 → 말풍선 OCR → 번역 검토</p>
      <h2 id="workspace-start-heading">이미지로 번역 프로젝트 시작</h2>
      <p className="workspace-start-description">
        페이지 이미지를 선택하면 프로젝트 저장 위치를 정한 뒤 OCR 작업 화면으로 이동합니다.
      </p>
      <button
        ref={props.primaryActionRef}
        type="button"
        className="primary-button workspace-start-primary"
        aria-label={props.isStartingImageProject ? "이미지 프로젝트 시작: 이미지 불러오는 중" : "이미지 프로젝트 시작: 이미지 불러오기"}
        aria-busy={props.isStartingImageProject}
        onClick={props.onStartImageProject}
        disabled={!props.apiReady || isBusy}
      >
        {props.isStartingImageProject ? "이미지 불러오는 중" : "이미지 불러오기"}
      </button>
      <div className="workspace-start-secondary" aria-label="다른 시작 방법">
        <Button type="button" variant="secondary" onClick={props.onOpenProject} disabled={!props.apiReady || isBusy}>
          기존 프로젝트 열기
        </Button>
        <Button type="button" variant="secondary" onClick={props.onImportTxt} disabled={!props.apiReady || isBusy}>
          {props.isImportingTxt ? "TXT 불러오는 중" : "TXT로 시작"}
        </Button>
      </div>
      <p className="workspace-start-status">{props.statusMessage}</p>
    </section>
  );
}
