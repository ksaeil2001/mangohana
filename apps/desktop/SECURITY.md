# Trio 보안 취약점 신고

> **v0.1.4 상태:** 비공개 신고 채널이 아직 활성화되지 않았습니다.

Trio의 운영 주체는 개인 개발자 **김세일**이며 대한민국에 있습니다. 전용
개인정보·지원 이메일, 공개 delivery 저장소와 GitHub private vulnerability
reporting을 실제로 활성화하기 전까지 이 문서는 신고 채널을 제공하지 않습니다.

## 신고 채널

비공개 신고를 받을 예정인 GitHub 경로는 다음과 같습니다.

<https://github.com/ksaeil2001/trio-releases/security/advisories/new>

`ksaeil2001/trio-releases`가 공개 저장소로 생성되고 private vulnerability
reporting이 켜진 뒤에만 사용할 수 있습니다. 현재 저장소와 기능은 **아직
활성화되지 않았습니다**. 따라서 보안 문제를 공개 GitHub Issue(공개 Issue), 공개 Release,
채팅 또는 문서에 게시하지 마세요. 활성화 전에는 신고 접수 자체를 보장할 수
없으며, release owner가 제공하는 전용 이메일이 생기기 전까지 임시 주소도
사용하지 않습니다.

## 보낼 정보와 금지 정보

가능하면 Trio 버전, 운영체제·아키텍처, 합성 재현 절차, 영향과 민감정보를 제거한
오류 메시지만 보냅니다. 실제 원고·이미지·`.ctp`·`-assets`, API key, password,
token(토큰), private key, 전체 로컬 경로(full path), 원본 stack trace, 요청 header/cookie 또는
가리지 않은 화면 캡처를 첨부하지 않습니다. 취약점 재현이 필요하면 안전한
synthetic fixture를 만드세요.

## 처리 기준

- 채널이 활성화된 뒤 개인정보·보안 문의에는 한국 영업일 기준 **5영업일 이내
  최초 확인**을 목표로 합니다.
- 보안 수정, 공개 여부, 해결·배포 기한 또는 SLA를 보장하지 않습니다.
- 신고자는 문제가 공개적으로 악용되지 않도록 비공개 상태를 유지하고, release
  owner의 조율 없이 취약점 세부 정보를 공개하지 않아야 합니다.

현재 비공개 신고 채널이 없으므로 Gate 8과 v0.1.4 stable은 `BLOCKED`입니다.
실제 저장소·기능·연락처가 활성화되면 이 문서의 상태와 변경일을 갱신합니다.
