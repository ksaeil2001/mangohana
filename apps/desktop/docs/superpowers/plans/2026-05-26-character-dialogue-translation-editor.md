# Character Dialogue Translation Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP Electron + React desktop app for importing messy txt dialogue, normalizing it into editable rows, editing source/AI/user translation columns, and saving normal or encrypted local projects.

**Architecture:** Use Electron main process as the trusted local boundary for filesystem, txt import, project validation, and encryption. Use a Vite React renderer for the editor, with a preload bridge exposing a narrow typed project API. Keep parser, project schema, and crypto logic in focused modules with unit tests before wiring them into UI.

**Tech Stack:** Electron, React, TypeScript, Vite, Vitest, Testing Library, Node `crypto`, Node `fs/promises`.

---

## File Structure

- Create `package.json`: project scripts and dependencies.
- Create `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`: TypeScript and Vite configuration.
- Create `index.html`: renderer mount point.
- Create `electron/main.ts`: app lifecycle, window creation, IPC registration.
- Create `electron/preload.ts`: safe `contextBridge` API.
- Create `src/shared/projectTypes.ts`: project, dialogue, character, and dictionary types.
- Create `src/shared/projectValidation.ts`: runtime validation and defaults.
- Create `src/main/dialogueParser.ts`: deterministic txt normalization.
- Create `src/main/projectStorage.ts`: normal and secret project save/load.
- Create `src/main/ipcHandlers.ts`: IPC methods for import, save, load.
- Create `src/renderer/App.tsx`: application shell and state orchestration.
- Create `src/renderer/components/ImportPanel.tsx`: txt import and paste/import controls.
- Create `src/renderer/components/DialogueTable.tsx`: three-column editor table.
- Create `src/renderer/components/LineDetailPanel.tsx`: selected row field editor.
- Create `src/renderer/components/CharacterDictionaryPanel.tsx`: project character and dictionary editing.
- Create `src/renderer/electronApi.ts`: renderer-side API typing.
- Create `src/renderer/styles.css`: dense desktop UI styling.
- Create `tests/parser/dialogueParser.test.ts`: parser unit tests.
- Create `tests/storage/projectStorage.test.ts`: storage and encryption tests.
- Create `tests/renderer/App.test.tsx`: renderer workflow smoke tests.
- Modify `.gitignore`: add Node/Electron build outputs.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Modify: `.gitignore`

- [ ] **Step 1: Create package manifest**

Add `package.json`:

```json
{
  "name": "character-dialogue-translation-editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "dev:electron": "concurrently -k \"npm:dev\" \"wait-on http://127.0.0.1:5173 && electron .\"",
    "build": "tsc -p tsconfig.node.json && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.node.json --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "electron": "latest",
    "react": "latest",
    "react-dom": "latest",
    "uuid": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@types/uuid": "latest",
    "concurrently": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "wait-on": "latest"
  }
}
```

- [ ] **Step 2: Create TypeScript configs**

Add `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

Add `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist-electron",
    "rootDir": ".",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["electron", "src/main", "src/shared"]
}
```

- [ ] **Step 3: Create Vite config and HTML shell**

Add `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"]
  },
  build: {
    outDir: "dist-renderer"
  }
});
```

Add `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Character Dialogue Translation Editor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/App.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Extend `.gitignore`**

Append:

```gitignore
node_modules/
dist-renderer/
dist-electron/
coverage/
*.log
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` is created and install exits successfully.

- [ ] **Step 6: Run typecheck to confirm scaffold state**

Run: `npm run typecheck`

Expected: FAIL because source files are not created yet. The failure should reference missing included source or no inputs, not package installation errors.

- [ ] **Step 7: Commit scaffold**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts index.html .gitignore
git commit -m "chore: scaffold electron react app"
```

---

### Task 2: Shared Project Types And Validation

**Files:**
- Create: `src/shared/projectTypes.ts`
- Create: `src/shared/projectValidation.ts`
- Create: `tests/shared/projectValidation.test.ts`

- [ ] **Step 1: Write validation tests**

Add `tests/shared/projectValidation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

describe("project validation", () => {
  it("creates an empty editable project", () => {
    const project = createEmptyProject("Sample", false);

    expect(project.schemaVersion).toBe(1);
    expect(project.metadata.title).toBe("Sample");
    expect(project.metadata.secret).toBe(false);
    expect(project.characters).toEqual([]);
    expect(project.dictionaryTerms).toEqual([]);
    expect(project.dialogueLines).toEqual([]);
  });

  it("rejects malformed project data", () => {
    expect(() => normalizeProject({ schemaVersion: 1, dialogueLines: "bad" })).toThrow(
      /Invalid project/
    );
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/shared/projectValidation.test.ts`

Expected: FAIL with missing module `src/shared/projectValidation`.

- [ ] **Step 3: Add shared types**

Add `src/shared/projectTypes.ts`:

```ts
export type DialogueType = "speech" | "thought" | "narration" | "unknown";
export type SourceLanguage = "ja" | "en" | "mixed" | "unknown";

export type DialogueLine = {
  id: string;
  order: number;
  speaker?: string;
  position?: string;
  dialogueType: DialogueType;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  referenceTranslation?: string;
  aiTranslation?: string;
  userTranslation?: string;
  notes?: string;
  parseConfidence: number;
  parseWarnings: string[];
};

export type CharacterProfile = {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
};

export type DictionaryTerm = {
  id: string;
  source: string;
  target: string;
  note?: string;
};

export type TranslationProject = {
  schemaVersion: number;
  metadata: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    secret: boolean;
  };
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  dialogueLines: DialogueLine[];
  settings: {
    defaultSourceLanguage: SourceLanguage;
  };
};
```

- [ ] **Step 4: Add validation helpers**

Add `src/shared/projectValidation.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { TranslationProject } from "./projectTypes";

export function createEmptyProject(title: string, secret: boolean): TranslationProject {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    metadata: {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      secret
    },
    characters: [],
    dictionaryTerms: [],
    dialogueLines: [],
    settings: {
      defaultSourceLanguage: "unknown"
    }
  };
}

export function normalizeProject(input: unknown): TranslationProject {
  if (!isRecord(input)) throw new Error("Invalid project: expected object");
  if (input.schemaVersion !== 1) throw new Error("Invalid project: unsupported schema version");
  if (!isRecord(input.metadata)) throw new Error("Invalid project: missing metadata");
  if (!Array.isArray(input.characters)) throw new Error("Invalid project: missing characters");
  if (!Array.isArray(input.dictionaryTerms)) throw new Error("Invalid project: missing dictionaryTerms");
  if (!Array.isArray(input.dialogueLines)) throw new Error("Invalid project: missing dialogueLines");
  if (!isRecord(input.settings)) throw new Error("Invalid project: missing settings");

  return input as TranslationProject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/shared/projectValidation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit types and validation**

```bash
git add src/shared tests/shared
git commit -m "feat: add project schema validation"
```

---

### Task 3: Deterministic Txt Parser

**Files:**
- Create: `src/main/dialogueParser.ts`
- Create: `tests/parser/dialogueParser.test.ts`

- [ ] **Step 1: Write parser tests**

Add `tests/parser/dialogueParser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDialogueText } from "../../src/main/dialogueParser";

describe("parseDialogueText", () => {
  it("parses speaker labels and reference translations", () => {
    const result = parseDialogueText(`
Akira: Don't look away.
KR: 눈 돌리지 마.

Mika - I said wait.
reference: 기다리라고 했잖아.
`);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      order: 1,
      speaker: "Akira",
      sourceText: "Don't look away.",
      referenceTranslation: "눈 돌리지 마.",
      dialogueType: "speech"
    });
    expect(result[1].speaker).toBe("Mika");
    expect(result[1].referenceTranslation).toBe("기다리라고 했잖아.");
  });

  it("marks thought and position hints with warnings when ambiguous", () => {
    const result = parseDialogueText(`
[thought] (top left)
Maybe this is a bad idea.

unlabeled continuation
still the same line
`);

    expect(result[0].dialogueType).toBe("thought");
    expect(result[0].position).toBe("top left");
    expect(result[1].parseWarnings).toContain("No speaker detected");
    expect(result.map((line) => line.sourceText).join(" ")).toContain("unlabeled continuation");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/parser/dialogueParser.test.ts`

Expected: FAIL with missing module `src/main/dialogueParser`.

- [ ] **Step 3: Implement parser**

Add `src/main/dialogueParser.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DialogueLine, DialogueType, SourceLanguage } from "../shared/projectTypes";

type MutableLine = Omit<DialogueLine, "id" | "order" | "parseConfidence" | "parseWarnings"> & {
  parseWarnings: string[];
};

const REFERENCE_PREFIX = /^(KR|KOR|REFERENCE|REF|참고)\s*:\s*(.+)$/i;
const SPEAKER_PREFIX = /^([^:\-\n]{1,40})\s*[:\-]\s*(.+)$/;
const MARKER_ONLY = /^\s*\[([^\]]+)]\s*(?:\(([^)]+)\))?\s*$/;

export function parseDialogueText(input: string): DialogueLine[] {
  const blocks = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => finalizeLine(parseBlock(block), index + 1));
}

function parseBlock(block: string): MutableLine {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed: MutableLine = {
    dialogueType: "speech",
    sourceLanguage: "unknown",
    sourceText: "",
    parseWarnings: []
  };

  const sourceParts: string[] = [];

  for (const rawLine of lines) {
    const marker = rawLine.match(MARKER_ONLY);
    if (marker) {
      parsed.dialogueType = parseDialogueType(marker[1]);
      if (marker[2]) parsed.position = marker[2].trim();
      continue;
    }

    const reference = rawLine.match(REFERENCE_PREFIX);
    if (reference) {
      parsed.referenceTranslation = reference[2].trim();
      continue;
    }

    const speaker = rawLine.match(SPEAKER_PREFIX);
    if (speaker && !parsed.speaker) {
      parsed.speaker = speaker[1].trim();
      sourceParts.push(speaker[2].trim());
      continue;
    }

    sourceParts.push(rawLine);
  }

  parsed.sourceText = sourceParts.join(" ").trim();
  parsed.sourceLanguage = detectSourceLanguage(parsed.sourceText);

  if (!parsed.speaker) parsed.parseWarnings.push("No speaker detected");
  if (!parsed.sourceText) parsed.parseWarnings.push("No source text detected");

  return parsed;
}

function finalizeLine(line: MutableLine, order: number): DialogueLine {
  const confidencePenalty = line.parseWarnings.length * 0.2;

  return {
    id: randomUUID(),
    order,
    ...line,
    parseConfidence: Math.max(0.2, 1 - confidencePenalty)
  };
}

function parseDialogueType(label: string): DialogueType {
  const normalized = label.toLowerCase();
  if (normalized.includes("thought") || normalized.includes("monologue") || normalized.includes("독백")) return "thought";
  if (normalized.includes("narration") || normalized.includes("narrator")) return "narration";
  return "unknown";
}

function detectSourceLanguage(text: string): SourceLanguage {
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  const hasEnglish = /[A-Za-z]/.test(text);
  if (hasJapanese && hasEnglish) return "mixed";
  if (hasJapanese) return "ja";
  if (hasEnglish) return "en";
  return "unknown";
}
```

- [ ] **Step 4: Run parser tests**

Run: `npm test -- tests/parser/dialogueParser.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit parser**

```bash
git add src/main/dialogueParser.ts tests/parser/dialogueParser.test.ts
git commit -m "feat: add deterministic dialogue parser"
```

---

### Task 4: Project Storage And Secret Encryption

**Files:**
- Create: `src/main/projectStorage.ts`
- Create: `tests/storage/projectStorage.test.ts`

- [ ] **Step 1: Write storage tests**

Add `tests/storage/projectStorage.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../../src/shared/projectValidation";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dialogue-editor-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("projectStorage", () => {
  it("saves and loads normal projects", async () => {
    const project = createEmptyProject("Normal", false);
    const filePath = join(tempDir, "normal.ctp");

    await saveProjectFile({ filePath, project });
    const loaded = await loadProjectFile({ filePath });

    expect(loaded.project.metadata.title).toBe("Normal");
    expect(loaded.encrypted).toBe(false);
  });

  it("encrypts secret projects and rejects wrong passwords", async () => {
    const project = createEmptyProject("Secret", true);
    const filePath = join(tempDir, "secret.ctp");

    await saveProjectFile({ filePath, project, password: "correct horse" });
    const raw = await readFile(filePath, "utf8");

    expect(raw).not.toContain("Secret");
    await expect(loadProjectFile({ filePath, password: "wrong" })).rejects.toThrow(/password/i);

    const loaded = await loadProjectFile({ filePath, password: "correct horse" });
    expect(loaded.project.metadata.title).toBe("Secret");
    expect(loaded.encrypted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/storage/projectStorage.test.ts`

Expected: FAIL with missing module `src/main/projectStorage`.

- [ ] **Step 3: Implement storage**

Add `src/main/projectStorage.ts`:

```ts
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TranslationProject } from "../shared/projectTypes";
import { normalizeProject } from "../shared/projectValidation";

type SaveArgs = {
  filePath: string;
  project: TranslationProject;
  password?: string;
};

type LoadArgs = {
  filePath: string;
  password?: string;
};

type StoredProjectFile =
  | { format: "ctp-json"; schemaVersion: 1; encrypted: false; payload: TranslationProject }
  | {
      format: "ctp-json";
      schemaVersion: 1;
      encrypted: true;
      kdf: "scrypt";
      salt: string;
      iv: string;
      authTag: string;
      payload: string;
    };

export async function saveProjectFile(args: SaveArgs): Promise<void> {
  const file: StoredProjectFile = args.project.metadata.secret
    ? encryptProject(args.project, requirePassword(args.password))
    : { format: "ctp-json", schemaVersion: 1, encrypted: false, payload: args.project };

  const tempPath = `${args.filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(file, null, 2), "utf8");
  await rename(tempPath, args.filePath);
}

export async function loadProjectFile(args: LoadArgs): Promise<{ project: TranslationProject; encrypted: boolean }> {
  const raw = await readFile(args.filePath, "utf8");
  const parsed = JSON.parse(raw) as StoredProjectFile;

  if (parsed.format !== "ctp-json" || parsed.schemaVersion !== 1) {
    throw new Error("Invalid project file");
  }

  if (!parsed.encrypted) {
    return { project: normalizeProject(parsed.payload), encrypted: false };
  }

  const password = requirePassword(args.password);
  const project = decryptProject(parsed, password);
  return { project: normalizeProject(project), encrypted: true };
}

function encryptProject(project: TranslationProject, password: string): StoredProjectFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(project), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: "ctp-json",
    schemaVersion: 1,
    encrypted: true,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    payload: encrypted.toString("base64")
  };
}

function decryptProject(file: Extract<StoredProjectFile, { encrypted: true }>, password: string): unknown {
  try {
    const salt = Buffer.from(file.salt, "base64");
    const iv = Buffer.from(file.iv, "base64");
    const authTag = Buffer.from(file.authTag, "base64");
    const payload = Buffer.from(file.payload, "base64");
    const key = scryptSync(password, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new Error("Unable to decrypt project. Check the password or project file.");
  }
}

function requirePassword(password: string | undefined): string {
  if (!password) throw new Error("A password is required for secret projects");
  return password;
}
```

- [ ] **Step 4: Run storage tests**

Run: `npm test -- tests/storage/projectStorage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit storage**

```bash
git add src/main/projectStorage.ts tests/storage/projectStorage.test.ts
git commit -m "feat: add encrypted project storage"
```

---

### Task 5: Electron Main, Preload, And IPC

**Files:**
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `src/main/ipcHandlers.ts`
- Create: `src/renderer/electronApi.ts`

- [ ] **Step 1: Add renderer API types**

Add `src/renderer/electronApi.ts`:

```ts
import type { DialogueLine, TranslationProject } from "../shared/projectTypes";

export type ProjectFileResult = {
  filePath: string;
  project: TranslationProject;
  encrypted: boolean;
};

export type ElectronProjectApi = {
  importTxtFile: () => Promise<{ filePath: string; lines: DialogueLine[] } | null>;
  saveProject: (args: { filePath: string; project: TranslationProject; password?: string }) => Promise<void>;
  openProject: (args: { filePath?: string; password?: string }) => Promise<ProjectFileResult | null>;
};

declare global {
  interface Window {
    projectApi: ElectronProjectApi;
  }
}
```

- [ ] **Step 2: Add IPC handlers**

Add `src/main/ipcHandlers.ts`:

```ts
import { dialog, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { parseDialogueText } from "./dialogueParser";
import { loadProjectFile, saveProjectFile } from "./projectStorage";

export function registerIpcHandlers(): void {
  ipcMain.handle("project:importTxtFile", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Import dialogue txt",
      properties: ["openFile"],
      filters: [{ name: "Text files", extensions: ["txt"] }]
    });

    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    const content = await readFile(filePath, "utf8");
    return { filePath, lines: parseDialogueText(content) };
  });

  ipcMain.handle("project:save", async (_event, args) => {
    await saveProjectFile(args);
  });

  ipcMain.handle("project:open", async (_event, args) => {
    const filePath = args.filePath ?? (await chooseProjectFile());
    if (!filePath) return null;
    const loaded = await loadProjectFile({ filePath, password: args.password });
    return { filePath, ...loaded };
  });
}

async function chooseProjectFile(): Promise<string | null> {
  const selection = await dialog.showOpenDialog({
    title: "Open translation project",
    properties: ["openFile"],
    filters: [{ name: "Character Translation Project", extensions: ["ctp"] }]
  });

  if (selection.canceled || !selection.filePaths[0]) return null;
  return selection.filePaths[0];
}
```

- [ ] **Step 3: Add preload bridge**

Add `electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { ElectronProjectApi } from "../src/renderer/electronApi";

const projectApi: ElectronProjectApi = {
  importTxtFile: () => ipcRenderer.invoke("project:importTxtFile"),
  saveProject: (args) => ipcRenderer.invoke("project:save", args),
  openProject: (args) => ipcRenderer.invoke("project:open", args)
};

contextBridge.exposeInMainWorld("projectApi", projectApi);
```

- [ ] **Step 4: Add main process**

Add `electron/main.ts`:

```ts
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerIpcHandlers } from "../src/main/ipcHandlers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(join(__dirname, "../dist-renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Electron bridge**

```bash
git add electron src/main/ipcHandlers.ts src/renderer/electronApi.ts
git commit -m "feat: wire electron project ipc"
```

---

### Task 6: Renderer Editor UI

**Files:**
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/components/ImportPanel.tsx`
- Create: `src/renderer/components/DialogueTable.tsx`
- Create: `src/renderer/components/LineDetailPanel.tsx`
- Create: `src/renderer/components/CharacterDictionaryPanel.tsx`
- Create: `src/renderer/styles.css`
- Create: `tests/setup.ts`
- Create: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write renderer smoke test**

Add `tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Add `tests/renderer/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../../src/renderer/App";

describe("App", () => {
  it("renders the editor shell", () => {
    render(<App />);

    expect(screen.getByText("Dialogue Editor")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("AI Draft")).toBeInTheDocument();
    expect(screen.getByText("User Edit")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/renderer/App.test.tsx`

Expected: FAIL with missing `src/renderer/App`.

- [ ] **Step 3: Add App shell**

Add `src/renderer/App.tsx`:

```tsx
import { useMemo, useState } from "react";
import { createEmptyProject } from "../shared/projectValidation";
import type { DialogueLine } from "../shared/projectTypes";
import { ImportPanel } from "./components/ImportPanel";
import { DialogueTable } from "./components/DialogueTable";
import { LineDetailPanel } from "./components/LineDetailPanel";
import { CharacterDictionaryPanel } from "./components/CharacterDictionaryPanel";
import "./styles.css";

export default function App() {
  const [project, setProject] = useState(() => createEmptyProject("Untitled Project", false));
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  const selectedLine = useMemo(
    () => project.dialogueLines.find((line) => line.id === selectedLineId) ?? null,
    [project.dialogueLines, selectedLineId]
  );

  function replaceLines(lines: DialogueLine[]) {
    setProject((current) => ({
      ...current,
      dialogueLines: lines,
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
    setSelectedLineId(lines[0]?.id ?? null);
  }

  function updateLine(updated: DialogueLine) {
    setProject((current) => ({
      ...current,
      dialogueLines: current.dialogueLines.map((line) => (line.id === updated.id ? updated : line)),
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
  }

  return (
    <main className="app-shell">
      <aside className="left-panel">
        <h1>Dialogue Editor</h1>
        <ImportPanel onImported={replaceLines} />
      </aside>
      <section className="table-panel">
        <DialogueTable
          lines={project.dialogueLines}
          selectedLineId={selectedLineId}
          onSelectLine={setSelectedLineId}
          onUpdateLine={updateLine}
        />
      </section>
      <aside className="right-panel">
        <LineDetailPanel line={selectedLine} onUpdateLine={updateLine} />
        <CharacterDictionaryPanel project={project} onProjectChange={setProject} />
      </aside>
    </main>
  );
}
```

- [ ] **Step 4: Add import panel**

Add `src/renderer/components/ImportPanel.tsx`:

```tsx
import type { DialogueLine } from "../../shared/projectTypes";

type Props = {
  onImported: (lines: DialogueLine[]) => void;
};

export function ImportPanel({ onImported }: Props) {
  async function importTxtFile() {
    const result = await window.projectApi?.importTxtFile();
    if (result) onImported(result.lines);
  }

  return (
    <section className="panel-section">
      <button type="button" onClick={importTxtFile}>Import txt</button>
      <p>{window.projectApi ? "Ready for local txt import." : "Running in browser test mode."}</p>
    </section>
  );
}
```

- [ ] **Step 5: Add dialogue table**

Add `src/renderer/components/DialogueTable.tsx`:

```tsx
import type { DialogueLine } from "../../shared/projectTypes";

type Props = {
  lines: DialogueLine[];
  selectedLineId: string | null;
  onSelectLine: (id: string) => void;
  onUpdateLine: (line: DialogueLine) => void;
};

export function DialogueTable({ lines, selectedLineId, onSelectLine, onUpdateLine }: Props) {
  return (
    <div className="dialogue-table">
      <div className="table-header">
        <span>Source</span>
        <span>AI Draft</span>
        <span>User Edit</span>
      </div>
      {lines.length === 0 ? (
        <div className="empty-state">Import a txt file to start editing.</div>
      ) : (
        lines.map((line) => (
          <button
            className={`table-row ${line.id === selectedLineId ? "selected" : ""}`}
            key={line.id}
            type="button"
            onClick={() => onSelectLine(line.id)}
          >
            <textarea
              value={line.sourceText}
              onChange={(event) => onUpdateLine({ ...line, sourceText: event.target.value })}
              aria-label={`Source ${line.order}`}
            />
            <textarea
              value={line.aiTranslation ?? ""}
              onChange={(event) => onUpdateLine({ ...line, aiTranslation: event.target.value })}
              aria-label={`AI Draft ${line.order}`}
              placeholder="AI translation unavailable"
            />
            <textarea
              value={line.userTranslation ?? ""}
              onChange={(event) => onUpdateLine({ ...line, userTranslation: event.target.value })}
              aria-label={`User Edit ${line.order}`}
            />
          </button>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add detail panel**

Add `src/renderer/components/LineDetailPanel.tsx`:

```tsx
import type { DialogueLine, DialogueType, SourceLanguage } from "../../shared/projectTypes";

type Props = {
  line: DialogueLine | null;
  onUpdateLine: (line: DialogueLine) => void;
};

export function LineDetailPanel({ line, onUpdateLine }: Props) {
  if (!line) return <section className="panel-section">No line selected.</section>;

  return (
    <section className="panel-section">
      <h2>Line Details</h2>
      <label>Speaker<input value={line.speaker ?? ""} onChange={(event) => onUpdateLine({ ...line, speaker: event.target.value })} /></label>
      <label>Position<input value={line.position ?? ""} onChange={(event) => onUpdateLine({ ...line, position: event.target.value })} /></label>
      <label>Type<select value={line.dialogueType} onChange={(event) => onUpdateLine({ ...line, dialogueType: event.target.value as DialogueType })}>
        <option value="speech">Speech</option>
        <option value="thought">Thought</option>
        <option value="narration">Narration</option>
        <option value="unknown">Unknown</option>
      </select></label>
      <label>Language<select value={line.sourceLanguage} onChange={(event) => onUpdateLine({ ...line, sourceLanguage: event.target.value as SourceLanguage })}>
        <option value="ja">Japanese</option>
        <option value="en">English</option>
        <option value="mixed">Mixed</option>
        <option value="unknown">Unknown</option>
      </select></label>
      <label>Reference<textarea value={line.referenceTranslation ?? ""} onChange={(event) => onUpdateLine({ ...line, referenceTranslation: event.target.value })} /></label>
      <label>Notes<textarea value={line.notes ?? ""} onChange={(event) => onUpdateLine({ ...line, notes: event.target.value })} /></label>
      <div className="warnings">{line.parseWarnings.join(", ") || "No parser warnings"}</div>
    </section>
  );
}
```

- [ ] **Step 7: Add character and dictionary panel**

Add `src/renderer/components/CharacterDictionaryPanel.tsx`:

```tsx
import type { TranslationProject } from "../../shared/projectTypes";

type Props = {
  project: TranslationProject;
  onProjectChange: (project: TranslationProject) => void;
};

export function CharacterDictionaryPanel({ project }: Props) {
  return (
    <section className="panel-section">
      <h2>Project Context</h2>
      <p>{project.characters.length} characters</p>
      <p>{project.dictionaryTerms.length} dictionary terms</p>
    </section>
  );
}
```

- [ ] **Step 8: Add styles**

Add `src/renderer/styles.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: Segoe UI, system-ui, sans-serif; background: #f3f4f6; color: #20242a; }
button, input, select, textarea { font: inherit; }
.app-shell { display: grid; grid-template-columns: 260px minmax(520px, 1fr) 340px; height: 100vh; }
.left-panel, .right-panel { padding: 16px; background: #ffffff; border-right: 1px solid #d7dce2; overflow: auto; }
.right-panel { border-right: 0; border-left: 1px solid #d7dce2; }
h1 { font-size: 20px; margin: 0 0 16px; }
h2 { font-size: 15px; margin: 0 0 10px; }
.panel-section { display: grid; gap: 10px; margin-bottom: 18px; }
.panel-section label { display: grid; gap: 4px; font-size: 12px; color: #4c5560; }
.panel-section input, .panel-section select, .panel-section textarea { width: 100%; border: 1px solid #c9d0d8; border-radius: 6px; padding: 8px; background: #fff; }
.panel-section button { border: 1px solid #1f6feb; border-radius: 6px; background: #1f6feb; color: #fff; padding: 9px 12px; cursor: pointer; }
.table-panel { overflow: auto; padding: 16px; }
.dialogue-table { min-width: 760px; border: 1px solid #d7dce2; background: #fff; }
.table-header, .table-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; }
.table-header { position: sticky; top: 0; z-index: 1; background: #e8edf3; font-weight: 600; }
.table-header span { padding: 10px; border-right: 1px solid #d7dce2; }
.table-row { width: 100%; border: 0; border-top: 1px solid #d7dce2; padding: 0; background: transparent; text-align: left; cursor: pointer; }
.table-row.selected { outline: 2px solid #1f6feb; outline-offset: -2px; }
.table-row textarea { min-height: 82px; resize: vertical; border: 0; border-right: 1px solid #d7dce2; padding: 10px; background: transparent; }
.empty-state { padding: 32px; color: #65707d; }
.warnings { font-size: 12px; color: #9a3412; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 8px; }
```

- [ ] **Step 9: Run renderer test**

Run: `npm test -- tests/renderer/App.test.tsx`

Expected: PASS.

- [ ] **Step 10: Commit renderer shell**

```bash
git add src/renderer tests/setup.ts tests/renderer/App.test.tsx
git commit -m "feat: add dialogue editor shell"
```

---

### Task 7: Verification Pass

**Files:**
- Modify only files required by failing checks.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: PASS for parser, storage, shared validation, and renderer tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Build app**

Run: `npm run build`

Expected: Vite renderer build and Electron TypeScript build complete successfully.

- [ ] **Step 4: Start development app**

Run: `npm run dev:electron`

Expected: Electron opens the editor. The first screen shows `Dialogue Editor`, an `Import txt` button, empty source/AI/user columns, and a right-side details panel.

- [ ] **Step 5: Manual smoke test**

Create a local txt sample outside the repo:

```txt
Akira: Don't look away.
KR: 눈 돌리지 마.

[thought] (top left)
Maybe this is a bad idea.
```

Import it in the app. Expected:

- Two dialogue rows appear.
- First row speaker is `Akira`.
- First row reference translation is populated.
- Second row type is `thought`.
- User edit text can be typed into the third column.

- [ ] **Step 6: Commit any verification fixes**

If fixes were needed:

```bash
git add package.json tsconfig.json tsconfig.node.json vite.config.ts electron src tests
git commit -m "fix: stabilize mvp verification"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers Electron + React, deterministic txt normalization, three-column editing, manual row correction, project schema, local normal storage, encrypted secret storage, error handling through parser warnings and atomic save, and parser/storage/UI tests.
- Explicitly deferred: OCR, speech recognition, subtitles, image typesetting, account/server/cloud features, and AI translation implementation.
- Type consistency: `TranslationProject`, `DialogueLine`, `CharacterProfile`, and `DictionaryTerm` match the approved design spec.
- Known implementation risk: `npm install` uses `latest` versions. If dependency APIs differ, keep the design boundaries and update the exact code in the corresponding task before committing that task.
