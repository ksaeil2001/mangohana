import type { DialogueLine, LineStatus } from "../../shared/projectTypes";
import { getQueueWindow } from "../guidedWorkflow";

type DialogueFilmstripProps = {
  lines: DialogueLine[];
  selectedLineId: string | null;
  onSelectLine: (lineId: string) => void;
  visibleCount?: 3 | 5;
};

export function DialogueFilmstrip({
  lines,
  selectedLineId,
  onSelectLine,
  visibleCount = 5
}: DialogueFilmstripProps) {
  const visibleLines = getQueueWindow(lines, selectedLineId, visibleCount);

  if (visibleLines.length === 0) {
    return <p className="dialogue-filmstrip-empty">대사 목록이 비어 있습니다. 이미지를 OCR하거나 프로젝트를 불러오세요.</p>;
  }

  return (
    <ol className="dialogue-filmstrip" aria-label="대사 작업 큐">
      {visibleLines.map((line) => {
        const hasIssue = (line.parseWarnings?.length ?? 0) > 0 || (line.parseConfidence ?? 1) < 0.7;
        const status = line.lineStatus ?? "untranslated";

        return (
          <li key={line.id}>
            <button
              type="button"
              className="dialogue-filmstrip-item"
              data-status={status}
              aria-current={line.id === selectedLineId ? "true" : undefined}
              title={`[#${line.order}] ${line.speaker ? `${line.speaker}: ` : ""}${line.sourceText}\n→ ${line.userTranslation || line.aiTranslation || "(미번역)"}`}
              onClick={() => onSelectLine(line.id)}
            >
              <span className="dialogue-filmstrip-meta">
                <strong>#{line.order}</strong>
                <span className={`dialogue-filmstrip-status status-${status}`}>
                  {getStatusLabel(status)}
                  {hasIssue && <span style={{ marginLeft: "3px" }} title="파싱 경고/낮은 신뢰도">⚠️</span>}
                </span>
              </span>
              <span className="dialogue-filmstrip-text">{line.userTranslation?.trim() || line.sourceText}</span>
              <span className="dialogue-filmstrip-speaker" title={line.speaker || "화자 없음"}>{line.speaker || "화자 없음"}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function getStatusLabel(status: LineStatus): string {
  if (status === "draft") return "초안";
  if (status === "complete") return "완료";
  if (status === "review") return "검토필요";
  return "미번역";
}
