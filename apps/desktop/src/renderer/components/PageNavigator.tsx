type Props = {
  currentPage: number;
  pageCount: number;
  dialogueCount: number;
  completeCount: number;
  reviewCount: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

export function PageNavigator({
  currentPage,
  pageCount,
  dialogueCount,
  completeCount,
  reviewCount,
  onPreviousPage,
  onNextPage
}: Props) {
  return (
    <section className="page-navigator" aria-label="페이지 탐색">
      <button type="button" onClick={onPreviousPage} disabled={currentPage <= 1}>
        이전 페이지
      </button>
      <strong aria-label="현재 페이지">
        {currentPage} / {pageCount}
      </strong>
      <button type="button" onClick={onNextPage} disabled={currentPage >= pageCount}>
        다음 페이지
      </button>
      <div className="page-summary" aria-label="페이지 요약">
        <span>대사 {dialogueCount}</span>
        <span>완료 {completeCount}</span>
        <span>검토필요 {reviewCount}</span>
      </div>
    </section>
  );
}
