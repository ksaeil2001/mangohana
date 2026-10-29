# Issue tracker: GitHub

작업 항목은 `ksaeil2001/trio`의 GitHub Issues에서 관리한다. 설계 원문과 검증 문서는 현재 저장소의 기존 위치를 유지하고, 필요하면 이슈에서 해당 문서를 참조한다.

## 명령

`gh` CLI를 사용하며 저장소를 명확하게 지정한다.

- 조회: `gh issue view <number> --repo ksaeil2001/trio --json number,title,body,labels,comments`.
- 목록: `gh issue list --repo ksaeil2001/trio --state open --json number,title,body,labels`.
- 생성: `gh issue create --repo ksaeil2001/trio --title <title> --body-file <path>`.
- 본문 수정: `gh issue edit <number> --repo ksaeil2001/trio --body-file <path>`.
- 댓글: `gh issue comment <number> --repo ksaeil2001/trio --body-file <path>`.
- 라벨 조회: `gh label list --repo ksaeil2001/trio --json name --limit 100`.

여러 줄 본문은 UTF-8 파일에 정확한 내용을 작성한 뒤 `--body-file`로 전달한다. 조회에서 인증·권한 오류가 나면 원인과 필요한 사용자 조치를 보고한다. 자격 증명을 탐색·노출하거나 전역 인증을 임의로 변경하지 않는다.

## 게시와 권한

스킬이 이슈 게시를 요구할 때의 목적지는 이 저장소의 GitHub Issues다. 이 설정만으로 이슈 게시·댓글·라벨 변경·close·commit·push·릴리스·배포의 실행 권한이 생기지는 않는다. 현재 요청과 사용자가 승인한 범위를 따른다.

## Pull requests as a triage surface

**PRs as a request surface: no.**
