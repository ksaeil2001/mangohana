import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function expectText(relativePath: string, patterns: Array<string | RegExp>): void {
  const contents = read(relativePath);
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      expect(contents, `${relativePath} must contain ${pattern}`).toContain(pattern);
    } else {
      expect(contents, `${relativePath} must match ${pattern}`).toMatch(pattern);
    }
  }
}

type MarkdownTableRow = {
  cells: string[];
  firstCell: string;
};

type GateRow = MarkdownTableRow & {
  gate: number;
  status: string;
};

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const cells = trimmed.split("|");
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

function parseMarkdownTable(contents: string, headerPattern: RegExp): MarkdownTableRow[] {
  const lines = contents.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.trim()));
  if (headerIndex < 0) {
    throw new Error(`Markdown table header ${headerPattern} was not found`);
  }

  const rows: MarkdownTableRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = splitTableCells(line);
    if (cells.length > 0) {
      rows.push({ cells, firstCell: cells[0] });
    }
  }
  return rows;
}

function parseKeyedTable(
  contents: string,
  headerPattern: RegExp,
  keyPattern: RegExp
): Map<string, MarkdownTableRow> {
  const rows = parseMarkdownTable(contents, headerPattern);
  const parsed = new Map<string, MarkdownTableRow>();
  for (const row of rows) {
    if (!keyPattern.test(row.firstCell)) continue;
    if (parsed.has(row.firstCell)) throw new Error(`Duplicate table row ${row.firstCell}`);
    parsed.set(row.firstCell, row);
  }
  return parsed;
}

function parseGateRows(contents: string): Map<number, GateRow> {
  const rows = parseMarkdownTable(contents, /^\|\s*Gate\s*\|\s*상태\s*\|/);
  const parsed = new Map<number, GateRow>();
  for (const row of rows) {
    const match = row.firstCell.match(/^Gate\s+([1-9])\b/);
    if (!match) continue;
    const gate = Number(match[1]);
    if (parsed.has(gate)) throw new Error(`Duplicate Gate ${gate} row`);
    parsed.set(gate, {
      ...row,
      gate,
      status: (row.cells[1] ?? "").replace(/\*\*/g, ""),
    });
  }
  return parsed;
}

function parsePhysicalQaRows(contents: string): Map<string, MarkdownTableRow> {
  const expectedId = /^(?:P10[1-5]|R101|Q101|U101|DPI-(?:100|125|150)|WU-0[1-8]|MAC-0[1-3]|LINUX-0[1-3])$/;
  const parsed = new Map<string, MarkdownTableRow>();
  for (const line of contents.split(/\r?\n/)) {
    const cells = splitTableCells(line);
    const id = cells[0];
    if (!id || !expectedId.test(id)) continue;
    if (parsed.has(id)) throw new Error(`Duplicate physical QA row ${id}`);
    parsed.set(id, { cells, firstCell: id });
  }
  return parsed;
}

const expectedGateStatuses: Record<number, string> = {
  1: "BLOCKED",
  2: "BLOCKED",
  3: "BLOCKED",
  4: "PASS (code-side) / BLOCKED (live QA)",
  5: "PASS (code-side) / BLOCKED (native)",
  6: "PASS (code-side) / BLOCKED (live signing/delivery)",
  7: "PASS (code-side) / BLOCKED (physical QA)",
  8: "BLOCKED",
  9: "BLOCKED",
};

const expectedGateBlockers: Record<number, Array<RegExp>> = {
  1: [/GitHub|Windows/i, /관리자/, /없음|필수 증거|focused\/full/i],
  2: [/\.p7s/, /publisher allowlist|CMS publisher allowlist/i],
  3: [/QA-P102|P101/, /NOT RUN|실장비|physical|P101~P105/i],
  4: [/설치본|transition|preview/i, /WU-0[1-8]|실장비|network/i],
  5: [/native.*package/i, /external|외부|clean audit evidence/i],
  6: [/SSL\.com|Authenticode/i, /Apple|GitHub App|provenance|live|없음/i],
  7: [/concept 2|user approval|icon 승인|시안/i, /display|실장비/i],
  8: [/전용 이메일|dedicated email/i, /법률 검토|qualified Korean legal review/i],
  9: [/Gate 1~8|all gates/i, /final approval|Go approval/i],
};

const resolvedOpenBlockerPhrases: RegExp[] = [
  /approved v0\.1\.4 [`']?release_tooling_sha[`']? trust anchor/i,
  /post-build source-integrity 재검증 P1\/P2/i,
  /Task 5B2 P1.*anonymous public Release metadata/i,
];

function expectCurrentGateTable(contents: string, label: string): void {
  const rows = parseGateRows(contents);
  expect(rows.size, `${label} must contain exactly nine gate rows`).toBe(9);
  for (let gate = 1; gate <= 9; gate += 1) {
    const row = rows.get(gate);
    expect(row, `${label} must contain Gate ${gate}`).toBeDefined();
    if (!row) continue;
    expect(row.status, `${label} Gate ${gate} status`).toBe(expectedGateStatuses[gate]);
    const rowText = row.cells.join(" ");
    for (const blocker of expectedGateBlockers[gate]) {
      expect(rowText, `${label} Gate ${gate} blocker`).toMatch(blocker);
    }
  }
}

function expectResolvedP1P2RemovedFromOpenBlockers(contents: string, label: string): void {
  const rows = parseGateRows(contents);
  for (const gate of [4, 6]) {
    const row = rows.get(gate);
    expect(row, `${label} must contain Gate ${gate}`).toBeDefined();
    if (!row) continue;
    const openBlockerText = row.cells.slice(3).join(" ");
    for (const phrase of resolvedOpenBlockerPhrases) {
      expect(openBlockerText, `${label} Gate ${gate} open blockers`).not.toMatch(phrase);
    }
  }
}

function expectCurrentNoGoDecision(contents: string, label: string): void {
  expect(contents, `${label} must retain the overall No-Go decision`).toMatch(
    /^> \*\*현재 결정: No-Go\*\*/m
  );
  expect(contents, `${label} must retain the final No-Go decision`).toMatch(
    /^현재는 \*\*No-Go \/ v0\.1\.4 stable 배포 보류\*\*다\./m
  );
}

function expectCurrentBrandSummary(contents: string, label: string): void {
  const rows = parseKeyedTable(
    contents,
    /^\|\s*영역\s*\|\s*상태\s*\|\s*남은 증거\s*\|/,
    /^브랜드·artifact$/
  );
  const row = rows.get("브랜드·artifact");
  expect(row, `${label} must contain a brand summary row`).toBeDefined();
  if (!row) return;
  expect(row.cells[1], `${label} brand summary status`).toBe(
    "PASS (code-side) / BLOCKED (physical QA)"
  );
  const evidence = row.cells.slice(2).join(" ");
  expect(evidence, `${label} brand summary evidence`).toMatch(/concept 2|승인|approved/i);
  expect(evidence, `${label} brand summary evidence`).toMatch(/physical|실장비|display|표시/i);
  expect(evidence, `${label} brand summary evidence`).not.toMatch(
    /approved?.*(?:absent|없음)|(?:approval|icon|asset|brand).*(?:absent|없음)/i
  );
}

function expectCurrentBrandApprovalRecord(contents: string, label: string): void {
  const rows = parseKeyedTable(
    contents,
    /^\|\s*필드\s*\|\s*현재 값\s*\|/,
    /^(?:legal\/support approval|brand approval)$/
  );
  const legal = rows.get("legal/support approval");
  const brand = rows.get("brand approval");
  expect(legal, `${label} must separate legal/support approval`).toBeDefined();
  expect(brand, `${label} must separate brand approval`).toBeDefined();
  if (!legal || !brand) return;
  expect(legal.cells.slice(1).join(" "), `${label} legal/support blocker`).toMatch(
    /BLOCKED|전용 이메일|법률|legal/i
  );
  const brandValue = brand.cells.slice(1).join(" ");
  expect(brandValue, `${label} brand approval status`).toMatch(
    /PASS \(code-side\).*BLOCKED \(physical QA\)/i
  );
  expect(brandValue, `${label} brand approval evidence`).toMatch(/concept 2|approved|승인/i);
  expect(brandValue, `${label} brand approval evidence`).toMatch(/physical|display|실장비|설치/i);
  expect(brandValue, `${label} brand approval evidence`).not.toMatch(
    /(?:explicit icon approval absent|approved icon(?:\/assets)? absent|(?:brand|icon) approval absent|승인\s*없음)/i
  );
}

function getSection(contents: string, heading: RegExp, nextHeading: RegExp): string {
  const start = contents.search(heading);
  expect(start, `section ${heading} must exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return "";
  const remainder = contents.slice(start);
  const end = remainder.search(nextHeading);
  return end >= 0 ? remainder.slice(0, end) : remainder;
}

function expectCurrentPromotionImplementationTruth(contents: string): void {
  const section = getSection(contents, /^## 4\. workflow 파일과 job 흐름/m, /^## 5\./m);
  expect(section).toMatch(/promote-stable\.yml|promotion workflow/i);
  expect(section).toMatch(/implemented|구현/);
  expect(section).toMatch(/not be enabled|활성화하지|실행하지|enable.*execute/);
  expect(section).toMatch(/approval|승인/);
  expect(section).toMatch(/live prerequisites|실제.*전제|live.*prerequisite/i);
  expect(section).not.toMatch(/별도 구현.*(?:전|until)|separate implementation/i);
}

function expectCurrentReleaseTitleContract(contents: string): void {
  const section = getSection(contents, /^## 8\. v0\.1\.4 digest-bound promotion workflow/m, /^## 9\./m);
  expect(section).toContain("name: Trio v0.1.4");
  expect(section).toContain("tag_name: v0.1.4");
  expect(section).toContain("candidate-assets/RELEASE_NOTES.md");
  const conflictingLines = contents
    .split(/\r?\n/)
    .filter((line) => /(?:public|Release)\s+title/i.test(line) && /Windows x64/i.test(line));
  expect(conflictingLines, "public-delivery must not define a Windows-only current title").toEqual([]);
}

function replaceGateStatusInRow(contents: string, gate: number, replacement: string): string {
  const row = contents.match(new RegExp(`^\\| Gate ${gate}[^\\r\\n]*$`, "m"));
  expect(row, `Gate ${gate} row must exist for mutation`).toBeDefined();
  if (!row) return contents;
  const expectedStatus = expectedGateStatuses[gate];
  const mutatedRow = row[0].replace(expectedStatus, replacement);
  expect(mutatedRow, `Gate ${gate} status must be present for mutation`).not.toBe(row[0]);
  return contents.replace(row[0], mutatedRow);
}

const expectedPhysicalQaIds = [
  "P101",
  "P102",
  "P103",
  "P104",
  "P105",
  "R101",
  "Q101",
  "U101",
  "WU-01",
  "WU-02",
  "WU-03",
  "WU-04",
  "WU-05",
  "WU-06",
  "WU-07",
  "WU-08",
  "DPI-100",
  "DPI-125",
  "DPI-150",
  "MAC-01",
  "MAC-02",
  "MAC-03",
  "LINUX-01",
  "LINUX-02",
  "LINUX-03",
];

function expectCurrentPhysicalQaMatrix(matrix: string): void {
  const rows = parsePhysicalQaRows(matrix);
  expect(rows.size, "QA matrix must contain only the expected scenario rows").toBe(
    expectedPhysicalQaIds.length
  );
  for (const id of expectedPhysicalQaIds) {
    expect(rows.has(id), `QA matrix must include ${id}`).toBe(true);
  }
  for (const [id, row] of rows) {
    const status = row.cells[2] ?? "";
    const rowText = row.cells.join(" ");
    if (id === "P102") {
      expect(status, "P102 is the only permitted partial physical evidence").toBe(
        "PASS (기존 부분 증거만)"
      );
      expect(rowText).toMatch(/부분 증거/);
      expect(rowText).toMatch(/Gate 3 전체 승격 금지/);
    } else {
      expect(["NOT RUN", "BLOCKED"], `${id} must not be marked PASS`).toContain(status);
    }
  }
}

function parseP101ResultRows(contents: string): Map<number, MarkdownTableRow> {
  const rows = parseMarkdownTable(contents, /^\|\s*시나리오\s*\|\s*결과\s*\|/);
  const parsed = new Map<number, MarkdownTableRow>();
  for (const row of rows) {
    const match = row.firstCell.match(/^QA-P10([1-5])\b/);
    if (!match) continue;
    const scenario = Number(match[1]);
    if (parsed.has(scenario)) throw new Error(`Duplicate QA-P10${scenario} result row`);
    parsed.set(scenario, {
      ...row,
      cells: [row.cells[0], (row.cells[1] ?? "").replace(/\*\*/g, ""), ...row.cells.slice(2)],
    });
  }
  return parsed;
}

function expectCurrentP101ResultTable(contents: string): void {
  const rows = parseP101ResultRows(contents);
  expect(rows.size, "P1-01 result table must contain exactly five scenario rows").toBe(5);
  const expectedStatuses: Record<number, string> = {
    1: "NOT RUN",
    2: "PASS (기존 부분 증거만)",
    3: "NOT RUN",
    4: "NOT RUN",
    5: "NOT RUN",
  };
  for (let scenario = 1; scenario <= 5; scenario += 1) {
    const row = rows.get(scenario);
    expect(row, `P1-01 result table must contain QA-P10${scenario}`).toBeDefined();
    if (!row) continue;
    expect(row.cells[1], `QA-P10${scenario} status`).toBe(expectedStatuses[scenario]);
  }
  const p102 = rows.get(2);
  expect(p102?.cells.join(" "), "P102 must not promote Gate 3").toContain(
    "Gate 3 전체 승격 금지"
  );
  expect(contents).toContain("P1-01 전체 판정은 **BLOCKED**");
}

describe("v0.1.4 release documentation gate", () => {
  it("publishes truthful support and security channel contracts", () => {
    expectText("SUPPORT.md", [
      "김세일",
      "대한민국",
      "https://github.com/ksaeil2001/trio-releases/issues",
      "아직 생성되지 않았",
      "best-effort",
      "5영업일",
      "해결 기한",
      "원고",
      "API key",
    ]);
    expectText("SECURITY.md", [
      "https://github.com/ksaeil2001/trio-releases/security/advisories/new",
      "아직 활성화되지 않았",
      "공개 Issue",
      "5영업일",
      "토큰",
      "full path",
    ]);
    expect(read("SUPPORT.md")).not.toMatch(/(?:example|placeholder|your[-_ ]?email|@example\.com)/i);
    expect(read("SECURITY.md")).not.toMatch(/(?:example|placeholder|your[-_ ]?email|@example\.com)/i);
    expect(read("SUPPORT.md")).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(read("SECURITY.md")).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  it("keeps privacy and legal documents explicitly blocked pending review and contact", () => {
    expectText("docs/legal/PRIVACY_POLICY_DRAFT.md", [
      "초안",
      "법률 검토",
      "전용 이메일",
      "로컬",
      ".ctp",
      "-assets",
      "recovery",
      "safeStorage",
      "세션",
      "환경 변수",
      "Gemini",
      "OpenAI",
      "전체 이미지",
      "Crop",
      "prompt",
      "보관",
      "학습",
      "국외 이전",
    ]);
    expectText("docs/legal/v0.1.4-legal-review-checklist.md", [
      "BLOCKED",
      "자격 있는 대한민국 법률 전문가",
      "LICENSE",
      "EULA",
      "개인정보 처리 방침",
      "전용 이메일",
    ]);
  });

  it("keeps physical QA records in a status vocabulary with no fabricated passes", () => {
    const matrix = read("docs/operations/v0.1.4-physical-qa-matrix.md");
    expect(matrix).toMatch(/PASS\s*\|\s*FAIL\s*\|\s*BLOCKED\s*\|\s*NOT RUN/);
    expectCurrentPhysicalQaMatrix(matrix);
    expect(matrix).toContain("NOT RUN");
    expect(matrix).toContain("실제 장비");
    expectText("docs/operations/windows-update-transition-qa.md", [
      "0.1.3-transition.1",
      "0.1.4-preview.1",
      "transition baseline",
      "미리보기",
      "WU-08",
    ]);
    expectText("docs/operations/windows-p1-01-physical-qa.md", [
      "P101",
      "P105",
      "관리자",
      "DPI",
      "NOT RUN",
    ]);
    expectText("docs/operations/p1-01-qa-results.md", [
      "PASS",
      "NOT RUN",
      "BLOCKED",
      "QA-P102",
    ]);
  });

  it("records every release gate and the live promotion blockers in the Go/No-Go record", () => {
    const goNoGo = read("docs/release/v0.1.4-go-no-go.md");
    expectCurrentGateTable(goNoGo, "Go/No-Go");
    expectCurrentNoGoDecision(goNoGo, "Go/No-Go");
    expect(goNoGo).toContain("anonymous");
    expect(goNoGo).toContain("Task 5B2");
    expect(goNoGo).toContain("candidate");
    expect(goNoGo).toContain("evidence");
    expect(goNoGo).toContain("김세일");
    expect(goNoGo).toContain("higher version");
    expect(goNoGo).toContain("appId");
    expect(goNoGo).toContain(".ctp");
    expect(goNoGo).not.toMatch(/tag\s+(?:생성|created|published)|stable\s+(?:공개|published)/i);
  });

  it("records code-side closure while keeping live evidence in the blocker column", () => {
    const goNoGo = read("docs/release/v0.1.4-go-no-go.md");
    const readiness = read("docs/release/v0.1.4-readiness.md");
    expectCurrentGateTable(goNoGo, "Go/No-Go");
    expectCurrentGateTable(readiness, "readiness");
    expectResolvedP1P2RemovedFromOpenBlockers(goNoGo, "Go/No-Go");
    expectResolvedP1P2RemovedFromOpenBlockers(readiness, "readiness");
    expectCurrentNoGoDecision(goNoGo, "Go/No-Go");
  });

  it("documents exact transition inputs, private evidence and no-latest policy", () => {
    expectText("docs/operations/windows-update-transition-qa.md", [
      "preview_candidate_run_id",
      "preview_evidence_sha256",
      "release_tooling_sha",
      "TRIO_APPROVED_RELEASE_TOOLING_SHA",
      "trio-preview-transition-candidate-<sourceSha>-<runId>",
      "trio.transition-candidate-evidence.v1",
      "trio.git-source-integrity.v1",
      "latest workflow run",
      "public feed",
    ]);
    expectText("docs/operations/public-delivery-workflow.md", [
      "preview_candidate_run_id",
      "preview_evidence_sha256",
      "release_tooling_sha",
      "TRIO_APPROVED_RELEASE_TOOLING_SHA",
      "Trio v0.1.4",
      "candidate-assets/RELEASE_NOTES.md",
      "draft: true",
      "prerelease: false",
      "PROMOTION_OK=1",
      "trio-release-published",
    ]);
    expectText("docs/operations/update-delivery-architecture.md", [
      "preview_candidate_run_id",
      "preview_evidence_sha256",
      "release_tooling_sha",
      "TRIO_APPROVED_RELEASE_TOOLING_SHA",
      "latest workflow run",
      "stable update pointer",
    ]);
  });

  it("keeps release summaries aligned with Gate 7 code-side approval", () => {
    const readiness = read("docs/release/v0.1.4-readiness.md");
    const goNoGo = read("docs/release/v0.1.4-go-no-go.md");
    expectCurrentBrandSummary(readiness, "readiness");
    expectCurrentBrandApprovalRecord(goNoGo, "Go/No-Go");
  });

  it("rejects contradictory Gate 7 approval mutations within their scoped rows", () => {
    const readiness = read("docs/release/v0.1.4-readiness.md");
    const mutatedReadiness = readiness.replace(
      /\| 브랜드·artifact \|[^\n]+/,
      "| 브랜드·artifact | PASS (code-side) / BLOCKED (physical QA) | approved icon/assets absent; physical display QA remains blocked |"
    );
    expect(mutatedReadiness).not.toBe(readiness);
    expect(() => expectCurrentBrandSummary(mutatedReadiness, "mutated readiness")).toThrow(
      /brand summary evidence/
    );

    const goNoGo = read("docs/release/v0.1.4-go-no-go.md");
    const mutatedGoNoGo = goNoGo.replace(
      /\| brand approval \|[^\n]+/,
      "| brand approval | BLOCKED — explicit icon approval absent; physical display QA remains blocked |"
    );
    expect(mutatedGoNoGo).not.toBe(goNoGo);
    expect(() => expectCurrentBrandApprovalRecord(mutatedGoNoGo, "mutated Go/No-Go")).toThrow(
      /brand approval status/
    );
  });

  it("keeps the implemented promotion workflow disabled only by live prerequisites", () => {
    const publicDelivery = read("docs/operations/public-delivery-workflow.md");
    expectCurrentPromotionImplementationTruth(publicDelivery);
    expectCurrentReleaseTitleContract(publicDelivery);
  });

  it("rejects contradictory promotion implementation and title mutations", () => {
    const publicDelivery = read("docs/operations/public-delivery-workflow.md");
    const mutatedImplementation = publicDelivery.replace(
      "기존 주석 포함 예시는",
      "public promotion 단계는 별도 구현 전까지 실행하지 않는다. 기존 주석 포함 예시는"
    );
    expect(mutatedImplementation).not.toBe(publicDelivery);
    expect(() => expectCurrentPromotionImplementationTruth(mutatedImplementation)).toThrow(
      /separate implementation|별도 구현/
    );

    const mutatedTitle = publicDelivery.replace(
      "The Release metadata contract is also exact.",
      "The public release title is Windows x64.\n\nThe Release metadata contract is also exact."
    );
    expect(mutatedTitle).not.toBe(publicDelivery);
    expect(() => expectCurrentReleaseTitleContract(mutatedTitle)).toThrow(
      /Windows-only current title/
    );
  });

  it("keeps the readiness document aligned with the current implementation truth", () => {
    const readiness = read("docs/release/v0.1.4-readiness.md");
    expectCurrentGateTable(readiness, "readiness");
    expect(readiness).toContain("Task 5B2");
    expect(readiness).toContain("BLOCKED");
    expect(readiness).toContain("appId");
    expect(readiness).toContain(".ctp");
    expect(readiness).toMatch(/\| runtime audit \| PASS \(code-side\) \|.*(?:vulnerability|audit).*0/);
    expect(readiness).toMatch(/\| 전체 audit \| PASS \(code-side\) \|.*(?:full audit|audit).*0/);
    expect(readiness).not.toMatch(/13 vulnerabilities|high 6|moderate 7/i);
    expect(readiness).not.toMatch(/아직\s*packaging에 연결/);
    expect(readiness).toContain("production `.p7s`");
    expect(readiness).toContain("publisher allowlist");
    expect(readiness).not.toContain("v0.1.4 stable 공개 완료");
  });

  it("parses the Go/No-Go table instead of trusting gate keywords", () => {
    const gates = parseGateRows(read("docs/release/v0.1.4-go-no-go.md"));
    expect(gates.get(2)?.status).toBe("BLOCKED");
    expect(gates.get(6)?.status).toBe(expectedGateStatuses[6]);
  });

  it("rejects mutation-style PASS edits to protected gate and QA rows", () => {
    const goNoGo = read("docs/release/v0.1.4-go-no-go.md");
    const mutatedGoNoGo = goNoGo.replace(
      "| Gate 2 — Pretendard production resource | BLOCKED |",
      "| Gate 2 — Pretendard production resource | PASS |"
    );
    expect(mutatedGoNoGo).not.toBe(goNoGo);
    expect(() => expectCurrentGateTable(mutatedGoNoGo, "mutated Go/No-Go")).toThrow(
      /Gate 2 status/
    );

    const matrix = read("docs/operations/v0.1.4-physical-qa-matrix.md");
    const mutatedMatrix = matrix.replace(
      /\| P101 \|([^\n]*\| )NOT RUN( \|)/,
      "| P101 |$1PASS$2"
    );
    expect(mutatedMatrix).not.toBe(matrix);
    expect(() => expectCurrentPhysicalQaMatrix(mutatedMatrix)).toThrow(
      /P101 must not be marked PASS/
    );

    const p101Results = read("docs/operations/p1-01-qa-results.md");
    const mutatedP102Results = p101Results.replace(
      /(^\| QA-P102[^\n]*\| )\*\*PASS \(기존 부분 증거만\)\*\*( \|)/m,
      "$1**PASS**$2"
    );
    expect(mutatedP102Results).not.toBe(p101Results);
    expect(() => expectCurrentP101ResultTable(mutatedP102Results)).toThrow(
      /QA-P102 status/
    );

    const gateDocuments = [
      ["Go/No-Go", goNoGo],
      ["readiness", read("docs/release/v0.1.4-readiness.md")],
    ] as const;
    for (const [label, document] of gateDocuments) {
      for (const gate of [4, 6, 7]) {
        const expectedStatus = expectedGateStatuses[gate];
        const mutatedSplitStatus = replaceGateStatusInRow(document, gate, "PASS");
        expect(mutatedSplitStatus).not.toBe(document);
        expect(() => {
          const mutatedRow = parseGateRows(mutatedSplitStatus).get(gate);
          expect(mutatedRow?.status, `${label} Gate ${gate} status`).toBe(expectedStatus);
        }).toThrow(new RegExp(`Gate ${gate} status`));
      }
    }

    const mutatedDecision = goNoGo.replace(
      /^> \*\*현재 결정: No-Go\*\*/m,
      "> **현재 결정: Go**"
    );
    expect(mutatedDecision).not.toBe(goNoGo);
    expect(() => expectCurrentNoGoDecision(mutatedDecision, "mutated overall decision")).toThrow(
      /overall No-Go decision/
    );
  });

  it("parses the legacy P1-01 result table with scoped P102 evidence", () => {
    expectCurrentP101ResultTable(read("docs/operations/p1-01-qa-results.md"));
  });
});
