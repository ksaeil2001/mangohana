import { useEffect, useRef, useState } from "react";

export type PageStripItem = {
  pageNumber: number;
  hasImage: boolean;
  lineCount: number;
  issueCount: number;
  storedRelativePath?: string;
  imageRevision?: string;
};

type PageStripProps = {
  pages: PageStripItem[];
  currentPage: number;
  onSelectPage: (pageNumber: number) => void;
  currentFilePath?: string | null;
};

export function PageStrip({ pages, currentPage, onSelectPage, currentFilePath }: PageStripProps) {
  const [reviewOnly, setReviewOnly] = useState(false);
  const currentRow = useRef<HTMLButtonElement>(null);
  const reviewCount = pages.filter((page) => page.issueCount > 0).length;
  // Keep the current page visible even when a filter is active.
  const visiblePages = reviewOnly ? pages.filter((page) => page.issueCount > 0 || page.pageNumber === currentPage) : pages;

  useEffect(() => {
    currentRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [currentPage, reviewOnly]);

  return (
    <section className="panel-section page-strip-panel">
      <div className="page-strip-heading"><h2>페이지 목록</h2><span>{pages.length}p</span></div>
      <div className="page-strip-filters" aria-label="페이지 필터">
        <button type="button" aria-pressed={!reviewOnly} onClick={() => setReviewOnly(false)}>전체 {pages.length}</button>
        <button type="button" aria-pressed={reviewOnly} onClick={() => setReviewOnly(true)}>검수 대상 {reviewCount}</button>
      </div>
      <ul className="page-strip" aria-label="페이지 목록">
        {visiblePages.map((page) => (
          <li key={page.pageNumber}>
            <button
              type="button"
              ref={page.pageNumber === currentPage ? currentRow : undefined}
              className={page.pageNumber === currentPage ? "page-strip-row selected" : "page-strip-row"}
              aria-label={`페이지 ${page.pageNumber} 선택`}
              aria-describedby={`page-strip-info-${page.pageNumber}`}
              aria-current={page.pageNumber === currentPage ? "page" : undefined}
              onClick={() => onSelectPage(page.pageNumber)}
            >
              <PageThumbnail path={page.storedRelativePath} revision={page.imageRevision} scope={currentFilePath} pageNumber={page.pageNumber} />
              <span className="page-strip-info" id={`page-strip-info-${page.pageNumber}`}>
                <strong>{page.pageNumber}페이지</strong>
                <span className="page-strip-image-state">{page.hasImage ? "이미지 있음" : "이미지 없음"}</span>
                <span>라인 {page.lineCount}</span>
                <span className="page-strip-status" data-needs-review={page.issueCount > 0}>{page.issueCount > 0 ? `문제 ${page.issueCount}` : "문제 0"}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Only visible rows resolve images. Leaving the viewport releases the source;
 * late results from a previous project or image are ignored. */
function PageThumbnail({ path, revision, scope, pageNumber }: { path?: string; revision?: string; scope?: string | null; pageNumber: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<{ key: string; src: string } | null>(null);
  const key = `${scope ?? ""}\0${path ?? ""}\0${revision ?? ""}`;

  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setImage(null);
    if (!visible || !path) return;
    let canceled = false;
    const resolve = scope && window.projectApi?.resolvePageImageSrc
      ? window.projectApi.resolvePageImageSrc({
        ...(scope.startsWith("session:") ? { projectSessionId: scope.slice(8) } : { projectFilePath: scope }),
        storedRelativePath: path
      })
      : Promise.resolve(path);
    void resolve.then((src) => { if (!canceled) setImage({ key, src }); }).catch(() => {});
    return () => { canceled = true; };
  }, [visible, path, scope, key]);

  return <span ref={ref} className="page-strip-thumbnail" aria-hidden="true">
    {image?.key === key ? <img src={image.src} alt="" loading="lazy" onError={() => setImage(null)} /> : <span>{String(pageNumber).padStart(2, "0")}</span>}
  </span>;
}
