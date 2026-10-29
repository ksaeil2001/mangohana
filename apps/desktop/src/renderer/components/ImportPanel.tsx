import type { DialogueLine } from "../../shared/projectTypes";

type Props = {
  hasProjectLines: boolean;
  importing: boolean;
  disabled?: boolean;
  onImport: () => Promise<void>;
};

export async function importTxtLines(args: {
  onImported: (lines: DialogueLine[]) => void;
  onCanceled: () => void;
}) {
  const result = await window.projectApi?.importTxtFile();
  if (!result) {
    args.onCanceled();
    return;
  }
  args.onImported(result.lines);
}

export function ImportPanel({ hasProjectLines, importing, disabled = false, onImport }: Props) {
  return (
    <section className="panel-section import-panel">
      <button
        type="button"
        className={hasProjectLines ? "secondary-button" : undefined}
        onClick={() => void onImport()}
        disabled={importing || disabled}
      >
        {importing ? "TXT 불러오는 중" : "TXT 불러오기"}
      </button>
      <p>{window.projectApi ? "로컬 TXT를 불러올 수 있습니다." : "브라우저 테스트 모드입니다."}</p>
    </section>
  );
}
