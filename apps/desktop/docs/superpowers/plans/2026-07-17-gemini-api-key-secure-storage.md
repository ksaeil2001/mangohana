# Gemini API Key Secure Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 입력한 Gemini API 키를 Windows 사용자 계정에 묶인 방식으로 암호화 저장하고, 다음 앱 실행에서 자동 복원하며, 실패 시 평문 저장 없이 안전한 상태를 안내한다.

**Architecture:** Electron 메인 프로세스에 `GeminiApiKeyStore`를 추가해 `safeStorage`와 앱별 `userData` 파일을 독점 관리한다. 앱 시작 시 외부 환경변수를 우선 적용하고, 없을 때만 암호문을 복원한다. IPC는 키를 메인 방향으로만 전달하고 렌더러에는 비밀값이 없는 상태 객체만 반환한다.

**Tech Stack:** Electron 42 `safeStorage`, Node.js `fs/promises`, TypeScript 6, React 19, Vitest 4, Testing Library

## Global Constraints

- Windows/PowerShell 기준이며 모든 명령은 `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\crop-reocr-fail-soft`에서 실행한다.
- 키 평문은 파일, 프로젝트 데이터, `localStorage`, 로그, 오류, 상태 응답에 저장하거나 출력하지 않는다.
- `safeStorage.isEncryptionAvailable()`이 `false`이거나 암호화·복호화가 실패하면 평문 저장으로 우회하지 않는다.
- 앱 시작 시 존재하는 `GEMINI_API_KEY` 환경변수가 암호화 저장 키보다 우선하며, 환경변수 값 자체는 자동 저장하지 않는다.
- 기존 OCR/Gemini 호출부가 `process.env.GEMINI_API_KEY`를 읽는 방식과 기존 키 입력·삭제 IPC 채널 이름은 유지한다.
- 저장된 키는 사용자가 `키 삭제`를 누를 때까지 유지한다.
- 새 패키지, 프로젝트 파일 형식, 데이터베이스, 마이그레이션은 추가하지 않는다.
- 사용자 메시지에 API 키, 암호문, 전체 저장 경로 또는 내부 예외 내용을 포함하지 않는다.

---

## File Structure

- Create `src/shared/geminiApiKey.ts`: 메인·preload·렌더러가 공유하는 비밀값 없는 상태 타입.
- Create `src/main/geminiApiKeyStore.ts`: 암호화, 파일 저장, 시작 복원, 삭제, 런타임 환경변수 반영을 담당하는 메인 전용 저장소.
- Create `tests/main/geminiApiKeyStore.test.ts`: 저장소의 평문 비노출, 재시작 복원, 환경변수 우선, 실패·삭제 동작을 단위 검증.
- Modify `electron/main.ts`: `app.whenReady()` 이후 실제 `safeStorage`와 `userData` 경로로 저장소 초기화.
- Modify `src/main/ipcHandlers.ts`: 기존 키 IPC를 저장소에 위임.
- Modify `tests/main/ipcHandlers.integration.test.ts`: 주입된 저장소로 IPC 계약과 비밀값 비노출 검증.
- Modify `src/renderer/electronApi.ts`: 세 키 IPC의 반환 타입을 공유 상태 타입으로 확장.
- Modify `src/renderer/components/ProjectActionsPanel.tsx`: 암호화 저장, 환경변수, 세션 전용, 재입력 상태 안내.
- Modify `tests/renderer/App.test.tsx`: 상태별 문구, 입력 초기화, 삭제 성공·실패 UI 검증.

---

### Task 1: Main-Only Encrypted Key Store

**Files:**
- Create: `src/shared/geminiApiKey.ts`
- Create: `src/main/geminiApiKeyStore.ts`
- Create: `tests/main/geminiApiKeyStore.test.ts`

**Interfaces:**
- Consumes: Electron과 동일한 `isEncryptionAvailable(): boolean`, `encryptString(plainText: string): Buffer`, `decryptString(encrypted: Buffer): string` 계약; Node `ProcessEnv`; 주입 가능한 파일 연산.
- Produces: `GeminiApiKeyStatus`, `GeminiApiKeyStore`, `createGeminiApiKeyStore(deps)`.

- [ ] **Step 1: 공유 상태 타입을 정의한다**

Create `src/shared/geminiApiKey.ts`:

```ts
export type GeminiApiKeySource = "none" | "environment" | "encrypted" | "session";
export type GeminiApiKeyPersistence = "encrypted" | "session-only" | "unavailable";

export type GeminiApiKeyStatus = {
  configured: boolean;
  source: GeminiApiKeySource;
  persistence: GeminiApiKeyPersistence;
  requiresReentry: boolean;
};
```

- [ ] **Step 2: 저장소의 실패 테스트를 먼저 작성한다**

Create `tests/main/geminiApiKeyStore.test.ts` with this setup so every test uses a fresh temporary directory, opaque fake ciphertext, and an isolated `NodeJS.ProcessEnv`:

```ts
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createGeminiApiKeyStore,
  type EncryptionAdapter,
  type KeyFileOps
} from "../../src/main/geminiApiKeyStore.js";

const defaultFileOps: KeyFileOps = { mkdir, readFile, rename, rm, writeFile };
let tempDir: string;
let keyPath: string;
let env: NodeJS.ProcessEnv;
let encryptedPlainText: string;
let encryption: {
  isEncryptionAvailable: ReturnType<typeof vi.fn>;
  encryptString: ReturnType<typeof vi.fn>;
  decryptString: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gemini-key-store-"));
  keyPath = join(tempDir, "settings", "gemini-api-key.enc");
  env = {};
  encryptedPlainText = "";
  encryption = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plainText: string) => {
      encryptedPlainText = plainText;
      return Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    }),
    decryptString: vi.fn(() => encryptedPlainText)
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createStore(fileOpsOverrides: Partial<KeyFileOps> = {}) {
  return createGeminiApiKeyStore({
    encryption: encryption as EncryptionAdapter,
    filePath: keyPath,
    env,
    fileOps: { ...defaultFileOps, ...fileOpsOverrides }
  });
}
```

Add these exact cases after the setup:

```ts
it("writes only encrypted bytes and restores the key in a new store", async () => {
  const first = createStore();
  await first.initialize();
  expect(await first.set("test-secret-key")).toMatchObject({
    source: "encrypted",
    persistence: "encrypted"
  });
  expect((await readFile(keyPath)).includes(Buffer.from("test-secret-key"))).toBe(false);

  delete env.GEMINI_API_KEY;
  const restarted = createStore();
  expect(await restarted.initialize()).toMatchObject({ source: "encrypted" });
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});

it("prefers but never persists an existing environment key", async () => {
  env.GEMINI_API_KEY = "environment-secret";
  const status = await createStore().initialize();
  expect(status).toMatchObject({ configured: true, source: "environment" });
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps an entered key session-only when encryption is unavailable", async () => {
  encryption.isEncryptionAvailable.mockReturnValue(false);
  const store = createStore();
  await store.initialize();
  expect(await store.set("session-secret")).toEqual({
    configured: true,
    source: "session",
    persistence: "unavailable",
    requiresReentry: false
  });
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes corrupt ciphertext and requires re-entry without applying it", async () => {
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, Buffer.from([1, 2, 3]));
  encryption.decryptString.mockImplementation(() => { throw new Error("sensitive internal failure"); });
  const status = await createStore().initialize();
  expect(status).toEqual({
    configured: false,
    source: "none",
    persistence: "encrypted",
    requiresReentry: true
  });
  expect(env.GEMINI_API_KEY).toBeUndefined();
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not report deletion success when removing ciphertext fails", async () => {
  const store = createStore({ rm: vi.fn().mockRejectedValue(new Error("private path")) });
  await store.initialize();
  await store.set("test-secret-key");
  await expect(store.clear()).rejects.toThrow("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요");
  expect(store.getStatus().configured).toBe(true);
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});
```

Add these remaining cases explicitly:

```ts
it("keeps the key session-only when encrypted file writing fails", async () => {
  const store = createStore({
    writeFile: vi.fn().mockRejectedValue(new Error("internal write failure"))
  });
  await store.initialize();
  expect(await store.set("test-secret-key")).toEqual({
    configured: true,
    source: "session",
    persistence: "session-only",
    requiresReentry: false
  });
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});

it("does not restore a successfully cleared encrypted key", async () => {
  const store = createStore();
  await store.initialize();
  await store.set("test-secret-key");
  expect(await store.clear()).toMatchObject({ configured: false, source: "none" });
  const restarted = createStore();
  expect(await restarted.initialize()).toMatchObject({ configured: false, source: "none" });
});

it("does not expose secrets or storage details in status and public errors", async () => {
  const store = createStore({
    rm: vi.fn().mockRejectedValue(new Error(`internal ${keyPath} test-secret-key`))
  });
  await store.initialize();
  await store.set("test-secret-key");
  const serializedStatus = JSON.stringify(store.getStatus());
  expect(serializedStatus).not.toContain("test-secret-key");
  expect(serializedStatus).not.toContain(keyPath);
  await expect(store.clear()).rejects.toThrow(
    "저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요"
  );
});
```

- [ ] **Step 3: 단위 테스트가 구현 부재로 실패하는지 확인한다**

Run:

```powershell
npm test -- tests/main/geminiApiKeyStore.test.ts
```

Expected: FAIL because `src/main/geminiApiKeyStore.ts` and the exported factory do not exist.

- [ ] **Step 4: 저장소를 최소 구현한다**

Create `src/main/geminiApiKeyStore.ts` with these public contracts:

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GeminiApiKeyStatus } from "../shared/geminiApiKey.js";

export type EncryptionAdapter = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type KeyFileOps = {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

export type GeminiApiKeyStore = {
  initialize(): Promise<GeminiApiKeyStatus>;
  getStatus(): GeminiApiKeyStatus;
  set(apiKey: string): Promise<GeminiApiKeyStatus>;
  clear(): Promise<GeminiApiKeyStatus>;
};

export function createGeminiApiKeyStore(deps: {
  encryption: EncryptionAdapter;
  filePath: string;
  env: NodeJS.ProcessEnv;
  fileOps?: KeyFileOps;
}): GeminiApiKeyStore;
```

Implement the factory with private `status` and a captured, trimmed `startupEnvironmentKey`:

1. `initialize()` returns `source: "environment"` without reading or writing the encrypted file when the captured startup key exists.
2. With no startup key, it checks `isEncryptionAvailable()`. If unavailable, it returns an unconfigured `persistence: "unavailable"` status and does not read or write a file.
3. It reads the ciphertext and decrypts it. `ENOENT` means a normal unconfigured state. Any decrypt/read corruption removes the ciphertext with `rm(filePath, { force: true })`, never applies a value, and sets `requiresReentry: true`.
4. `set(apiKey)` updates `env.GEMINI_API_KEY` immediately. When encryption is unavailable it returns `session/unavailable`. When encrypt/write fails it returns `session/session-only`. A successful save returns `encrypted/encrypted`.
5. Save ciphertext atomically: create the parent directory, write to `${filePath}.${randomUUID()}.tmp`, rename it to `filePath`, and best-effort remove the temporary file in `finally`. Never serialize the plaintext.
6. `clear()` removes the encrypted file first. If removal fails, throw only `new Error("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요")` and retain the existing environment/status. On success, restore the captured startup environment key and `environment` status if one existed; otherwise delete `env.GEMINI_API_KEY` and return `none`.
7. `getStatus()` returns a fresh object so callers cannot mutate internal state.

- [ ] **Step 5: 저장소 테스트와 타입 검사를 실행한다**

Run:

```powershell
npm test -- tests/main/geminiApiKeyStore.test.ts
npm run typecheck
```

Expected: all new storage tests PASS; both renderer and Node TypeScript checks PASS.

- [ ] **Step 6: 저장소 작업을 커밋한다**

```powershell
git add src/shared/geminiApiKey.ts src/main/geminiApiKeyStore.ts tests/main/geminiApiKeyStore.test.ts
git commit -m "feat: add encrypted Gemini key store"
```

---

### Task 2: App Startup and IPC Integration

**Files:**
- Modify: `electron/main.ts:1-67`
- Modify: `src/main/ipcHandlers.ts:1-50`
- Modify: `tests/main/ipcHandlers.integration.test.ts:1-66` and the Gemini key IPC cases

**Interfaces:**
- Consumes: Task 1 `createGeminiApiKeyStore()`, `GeminiApiKeyStore`, and `GeminiApiKeyStatus`.
- Produces: `registerIpcHandlers({ geminiApiKeyStore }): void`; startup restoration before the first BrowserWindow is created.

- [ ] **Step 1: IPC 계약 실패 테스트를 작성한다**

In `tests/main/ipcHandlers.integration.test.ts`, import `GeminiApiKeyStore`, declare the mock, and replace the existing parameterless registration in `beforeEach`:

```ts
import type { GeminiApiKeyStore } from "../../src/main/geminiApiKeyStore.js";

let geminiApiKeyStore: {
  initialize: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

geminiApiKeyStore = {
  initialize: vi.fn(),
  getStatus: vi.fn(() => ({
    configured: false,
    source: "none",
    persistence: "encrypted",
    requiresReentry: false
  })),
  set: vi.fn(),
  clear: vi.fn()
};
registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore });
```

Place the mock assignment immediately after the existing Electron mock resets in `beforeEach`, replacing only its final `registerIpcHandlers()` call. Then add these cases:

```ts
it("returns only the Gemini key status through IPC", async () => {
  geminiApiKeyStore.getStatus.mockReturnValue({
    configured: true,
    source: "encrypted",
    persistence: "encrypted",
    requiresReentry: false
  });
  const result = await invoke("project:getGeminiApiKeyStatus");
  expect(result).toEqual(geminiApiKeyStore.getStatus());
  expect(JSON.stringify(result)).not.toContain("test-secret-key");
});

it("validates and delegates Gemini key storage without returning the key", async () => {
  geminiApiKeyStore.set.mockResolvedValue({
    configured: true,
    source: "encrypted",
    persistence: "encrypted",
    requiresReentry: false
  });
  const result = await invoke("project:setGeminiApiKey", { apiKey: "  test-secret-key  " });
  expect(geminiApiKeyStore.set).toHaveBeenCalledWith("test-secret-key");
  expect(JSON.stringify(result)).not.toContain("test-secret-key");
});

it("keeps configured status when encrypted key deletion fails", async () => {
  geminiApiKeyStore.clear.mockRejectedValue(
    new Error("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요")
  );
  await expect(invoke("project:clearGeminiApiKey")).rejects.toThrow("저장된 키를 삭제하지 못했습니다");
  expect(geminiApiKeyStore.clear).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: IPC 테스트가 기존 세션 전용 구현 때문에 실패하는지 확인한다**

Run:

```powershell
npm test -- tests/main/ipcHandlers.integration.test.ts
```

Expected: FAIL because `registerIpcHandlers` does not accept or call `geminiApiKeyStore` and returns only `{ configured }`.

- [ ] **Step 3: 기존 IPC를 저장소에 연결한다**

In `src/main/ipcHandlers.ts`, import the type and change the registration signature:

```ts
import type { GeminiApiKeyStore } from "./geminiApiKeyStore.js";

export function registerIpcHandlers({
  geminiApiKeyStore
}: {
  geminiApiKeyStore: GeminiApiKeyStore;
}): void {
  registerPageImageProtocol();

  ipcMain.handle("project:getGeminiApiKeyStatus", () => geminiApiKeyStore.getStatus());

  ipcMain.handle("project:setGeminiApiKey", async (_event, args) => {
    const apiKey = validateGeminiApiKeyArgs(args).apiKey;
    return geminiApiKeyStore.set(apiKey);
  });

  ipcMain.handle("project:clearGeminiApiKey", () => geminiApiKeyStore.clear());
```

This block replaces only the current function signature and three Gemini key handlers at lines 34-50. Leave the following `project:importTxtFile` handler and every later handler inside the same function unchanged. Do not change `hasGeminiApiKey()` or the OCR provider-selection code; the store maintains the same runtime environment variable they already use.

- [ ] **Step 4: 앱 준비 후 저장소를 초기화하고 창보다 먼저 복원한다**

In `electron/main.ts`, add `safeStorage`, `createGeminiApiKeyStore`, and this bootstrap sequence:

```ts
import { app, BrowserWindow, protocol, safeStorage } from "electron";
import { createGeminiApiKeyStore } from "../src/main/geminiApiKeyStore.js";

app.whenReady().then(async () => {
  const geminiApiKeyStore = createGeminiApiKeyStore({
    encryption: safeStorage,
    filePath: join(app.getPath("userData"), "settings", "gemini-api-key.enc"),
    env: process.env
  });
  await geminiApiKeyStore.initialize();
  registerIpcHandlers({ geminiApiKeyStore });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

Keep protocol registration and all window security settings unchanged.

- [ ] **Step 5: IPC, 타입, Electron 빌드를 검증한다**

Run:

```powershell
npm test -- tests/main/ipcHandlers.test.ts tests/main/ipcHandlers.integration.test.ts
npm run typecheck
npm run build:electron
```

Expected: IPC unit/integration suites PASS; TypeScript checks PASS; Electron main/preload compilation exits 0.

- [ ] **Step 6: 앱·IPC 연결을 커밋한다**

```powershell
git add electron/main.ts src/main/ipcHandlers.ts tests/main/ipcHandlers.integration.test.ts
git commit -m "feat: restore encrypted Gemini key on startup"
```

---

### Task 3: Renderer Status and Safe User Feedback

**Files:**
- Modify: `src/renderer/electronApi.ts:1-45`
- Modify: `src/renderer/components/ProjectActionsPanel.tsx:38-100,177-203`
- Modify: `tests/renderer/App.test.tsx:1415-1452`

**Interfaces:**
- Consumes: Task 1 `GeminiApiKeyStatus` and Task 2 IPC responses.
- Produces: status-aware settings UI that never receives or redisplays the saved key.

- [ ] **Step 1: 렌더러 상태별 실패 테스트를 작성한다**

Replace the existing current-session-only renderer test with status-complete tests using these fixtures:

```ts
const noKeyStatus = {
  configured: false,
  source: "none" as const,
  persistence: "encrypted" as const,
  requiresReentry: false
};
const encryptedStatus = {
  configured: true,
  source: "encrypted" as const,
  persistence: "encrypted" as const,
  requiresReentry: false
};
const environmentStatus = {
  configured: true,
  source: "environment" as const,
  persistence: "session-only" as const,
  requiresReentry: false
};
const unavailableStatus = {
  configured: true,
  source: "session" as const,
  persistence: "unavailable" as const,
  requiresReentry: false
};
```

Assert all of the following:

```ts
expect(await screen.findByText("Gemini API 키 미설정")).toBeInTheDocument();
expect(await screen.findByText("Gemini API 키 암호화 저장됨")).toBeInTheDocument();
expect(await screen.findByText("환경변수의 Gemini API 키 사용 중")).toBeInTheDocument();
expect(await screen.findByText("암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다")).toBeInTheDocument();
expect(await screen.findByText("저장된 키를 복원하지 못했습니다. Gemini API 키를 다시 입력해 주세요")).toBeInTheDocument();
```

For save, retain the assertion that `setGeminiApiKey` receives a trimmed key and add `expect(input).toHaveValue("")`. For clear failure, mock rejection, assert the failure message, and assert the configured label remains. At no point mock or expect a getter response containing an API key.

- [ ] **Step 2: 렌더러 테스트가 구형 불리언 상태 UI 때문에 실패하는지 확인한다**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: the new status-copy tests FAIL because the component only stores `configured` and still displays current-session wording.

- [ ] **Step 3: preload 계약 타입을 확장한다**

In `src/renderer/electronApi.ts` import `GeminiApiKeyStatus` and replace the three return types:

```ts
import type { GeminiApiKeyStatus } from "../shared/geminiApiKey.js";

getGeminiApiKeyStatus?: () => Promise<GeminiApiKeyStatus>;
setGeminiApiKey?: (args: { apiKey: string }) => Promise<GeminiApiKeyStatus>;
clearGeminiApiKey?: () => Promise<GeminiApiKeyStatus>;
```

No preload runtime change is needed because the existing bridge already forwards these IPC results without inspecting them.

- [ ] **Step 4: 전체 상태를 저장하고 상태 기반 문구를 표시한다**

In `ProjectActionsPanel.tsx`, replace the boolean state with:

```ts
const [geminiApiKeyStatus, setGeminiApiKeyStatus] = useState<GeminiApiKeyStatus | null>(null);
```

Import `GeminiApiKeyStatus`, store every get/set/clear response with `setGeminiApiKeyStatus(status)`, and use these pure mappings:

```ts
function getGeminiApiKeyStatusLabel(status: GeminiApiKeyStatus | null): string {
  if (!status) return "Gemini API 키 상태를 확인할 수 없습니다.";
  if (status.requiresReentry) {
    return "저장된 키를 복원하지 못했습니다. Gemini API 키를 다시 입력해 주세요";
  }
  if (status.source === "environment") return "환경변수의 Gemini API 키 사용 중";
  if (status.source === "encrypted") return "Gemini API 키 암호화 저장됨";
  if (status.source === "session" && status.persistence === "unavailable") {
    return "암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다";
  }
  if (status.source === "session") return "Gemini API 키가 이번 실행에만 적용됨";
  return "Gemini API 키 미설정";
}

function getGeminiApiKeySaveMessage(status: GeminiApiKeyStatus): string {
  if (status.source === "encrypted") return "Gemini API 키 암호화 저장됨";
  if (status.source === "environment") return "환경변수의 Gemini API 키 사용 중";
  return status.persistence === "unavailable"
    ? "암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다"
    : "Gemini API 키를 저장하지 못해 이번 실행에만 적용했습니다.";
}
```

After every successful set request, clear `geminiApiKeyInput` and show `getGeminiApiKeySaveMessage(status)`. After clear, show `환경변수의 Gemini API 키 사용 중` when the returned source is `environment`; otherwise show `저장된 Gemini API 키를 삭제했습니다.`. On rejection, keep the previous status and show only the sanitized IPC error or the fixed fallback `Gemini API 키를 삭제하지 못했습니다.`.

Change the input placeholder from `현재 앱 세션에만 적용` to `암호화하여 이 기기에 저장` and render `getGeminiApiKeyStatusLabel(geminiApiKeyStatus)` in the status paragraph. Continue using `type="password"`, `autoComplete="off"`, and never populate the input from status.

- [ ] **Step 5: 렌더러 테스트와 타입 검사를 실행한다**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
npm run typecheck
```

Expected: renderer suite PASS; both TypeScript checks PASS.

- [ ] **Step 6: 렌더러 작업을 커밋한다**

```powershell
git add src/renderer/electronApi.ts src/renderer/components/ProjectActionsPanel.tsx tests/renderer/App.test.tsx
git commit -m "feat: show encrypted Gemini key status"
```

---

### Task 4: Full Verification and Windows Restart Check

**Files:**
- Verify only; modify a file only if a failing check identifies a defect within this feature.

**Interfaces:**
- Consumes: Tasks 1-3 complete feature.
- Produces: test/build evidence and a manually verified Windows restart/delete flow.

- [ ] **Step 1: 전체 자동 검증을 실행한다**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: typecheck exits 0; all Vitest suites PASS; renderer and Electron production build exit 0.

- [ ] **Step 2: 추적 파일에 비밀값 또는 평문 저장 코드가 없는지 정적 확인한다**

Run:

```powershell
rg -n "localStorage|sessionStorage|console\.(log|error).*apiKey|writeFile.*apiKey" electron src tests
git diff --check
git status --short
```

Expected: no API-key persistence in renderer storage and no logging/write of a plaintext key; `git diff --check` exits 0; only intended feature files are changed.

- [ ] **Step 3: Electron에서 저장·재시작·삭제를 수동 확인한다**

Run:

```powershell
npm start
```

Verify without exposing the key in screenshots or terminal output:

1. 설정에서 Gemini API 키를 입력하고 `Gemini API 키 암호화 저장됨`을 확인한다.
2. 앱을 완전히 종료한 뒤 같은 명령으로 재실행하고 재입력 없이 `Gemini API 키 암호화 저장됨`이 표시되는지 확인한다.
3. OCR을 한 번 실행해 복원된 키가 실제 Gemini 호출에 사용되는지 확인한다.
4. `키 삭제`를 누르고 앱을 재실행해 `Gemini API 키 미설정`인지 확인한다.
5. 테스트 키나 암호문을 프로젝트 파일, 화면 입력값, 콘솔에 출력하지 않는다.

- [ ] **Step 4: 최종 상태를 확인한다**

Run:

```powershell
git status --short --branch
git log -4 --oneline
```

Expected: implementation commits are present and the worktree is clean. If verification required a code fix, rerun Steps 1-3 and commit only that verified fix with a narrowly scoped message.

---

## Review Gates

Each implementation task is independently reviewable:

1. Task 1 reviewer checks storage semantics, absence of plaintext fallback, sanitized failure paths, and unit-test completeness.
2. Task 2 reviewer checks Electron readiness ordering, environment-variable priority, IPC secrecy, and preservation of unrelated handlers.
3. Task 3 reviewer checks that no key returns to the renderer, every approved Korean status is reachable, and failure does not display false success.
4. Final reviewer checks the design spec against all tests, full build output, Windows restart behavior, and deletion persistence.

No task may proceed past its review gate with an unresolved security or spec-compliance finding.
