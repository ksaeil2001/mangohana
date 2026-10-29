type Props = {
  disabled: boolean;
  disabledReason?: string;
  hasPageImages: boolean;
  onImportImages: () => Promise<void>;
};

export function ImageImportPanel({ disabled, disabledReason, hasPageImages, onImportImages }: Props) {
  const guidance = getImageImportGuidance(disabled, disabledReason, hasPageImages);

  return (
    <section className="panel-section image-import-panel">
      <button
        type="button"
        className={!disabled && !hasPageImages ? "primary-button" : "secondary-button"}
        title={guidance}
        onClick={onImportImages}
        disabled={disabled}
      >
        이미지 업로드
      </button>
      <p>{guidance}</p>
    </section>
  );
}

function getImageImportGuidance(disabled: boolean, disabledReason: string | undefined, hasPageImages: boolean) {
  if (!disabled) {
    return hasPageImages
      ? "현재 페이지부터 선택한 이미지가 순서대로 다시 연결됩니다."
      : "현재 페이지부터 선택한 이미지가 순서대로 연결됩니다.";
  }
  if (disabledReason?.includes("저장")) {
    return "먼저 프로젝트를 저장해야 이미지 업로드를 사용할 수 있습니다.";
  }
  return disabledReason ?? "이미지 업로드를 사용할 수 없습니다.";
}
