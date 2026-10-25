# 선정 DB의 공식 문서 확인

확인일: 2026-10-03. 공개 `/current/` 원문이 표시한 버전은 PostgreSQL 18이었다. 실제 채택 버전/host는 미선정이다. DB 설치·기동·DDL·실험은 하지 않았다.

| 공식 페이지 | 확인한 내용 | 이번 설계의 추론·미검증 |
| --- | --- | --- |
| [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Read Committed에서 각 문장 snapshot, 갱신/잠금 대기 뒤 현재 row/조건 재검사. Serializable의 serialization failure 재시도 | 짧은 DB-only 명령 경계+현재 row/revision·유일성. 구체 DDL/동시성·외부 부수 효과 분리 실행은 NOT RUN |
| [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) | PK·unique·FK의 제약 | 명령/정산·identity/활성 요청의 유일성 후보. 사용자 권한은 FK와 별도 서비스 검사 |
| [SELECT locking](https://www.postgresql.org/docs/current/sql-select.html) | SKIP LOCKED는 잠긴 row 제외·불완전 view, queue 소비 사례에 사용 가능 | claim 후보에만 검토, 잔액/전체 미정산/파일 캡처 권위 조회에는 사용하지 않음 |
| [Date/time](https://www.postgresql.org/docs/current/functions-datetime.html) | CURRENT_TIMESTAMP/now는 transaction 시작 시각, clock_timestamp는 호출 당시 시각 | lock 뒤 현재 시각으로 절대 기한 재판정. 시간 함수가 clock skew/failover·외부 발행 틈을 해결하지는 않음 |
| [INSERT](https://www.postgresql.org/docs/current/sql-insert.html) | ON CONFLICT의 unique 충돌 처리 | 충돌 처리만으로 동일 의도 증명/성공을 반환하지 않음. 원 의도·귀속·결과의 현재 조회 필요 |

설계 초안은 `docs/superpowers/specs/2026-10-03-manga-web-postgres-execution-design.md`다. 공식 기능 설명과 앱 책임/정책·원자적 경계의 설계 추론을 구분했다. 실제 PostgreSQL·PGV·제공자 수행/정산·브라우저·서명 파일 PASS는 기록하지 않는다.
