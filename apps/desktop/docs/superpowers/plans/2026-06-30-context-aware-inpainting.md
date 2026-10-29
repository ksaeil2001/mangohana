# Context-Aware Inpainting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal-use image inpainting tool that lets the user manually mask source text, choose a context preset, generate one edited image, preserve the original, and replace the current page image metadata with the new result.

**Architecture:** Keep the existing Electron/React project shape. Renderer owns mask drawing and user workflow, shared code owns typed presets and prompt text, Electron main validates paths, calls the OpenAI image edit API, writes a new asset, and returns `PageImage` metadata.

**Tech Stack:** React 19, TypeScript, Electron IPC, Node file APIs, native `fetch`/`FormData`/`Blob`, OpenAI Image API `POST /v1/images/edits`.

---

## Context and API Notes

- Official OpenAI docs describe image edits as modifying existing images, including editing parts of an image by uploading an image and a mask that identifies replacement areas.
- Use `POST https://api.openai.com/v1/images/edits`.
- Use model `gpt-image-2` unless implementation-time docs say otherwise.
- Send multipart form fields:
  - `model=gpt-image-2`
  - `image[]=@source.png`
  - `mask=@mask.png`
  - `prompt=<preset prompt>`
  - `size=auto`
  - `quality=auto`
  - `output_format=png`
- The response data contains base64 image data in `data[0].b64_json` for GPT image models.
- Mask and image must be the same dimensions and the mask PNG must include an alpha channel.

## File Structure

- Create `src/shared/inpainting.ts`
  - Owns `InpaintingMode`, labels, mode prompts, request/result types, and pure validation helpers.
- Modify `src/renderer/electronApi.ts`
  - Adds `inpaintPageImage` to `ElectronProjectApi`.
- Create `src/main/inpaintingAssets.ts`
  - Resolves current page image paths safely.
  - Writes generated inpaint PNGs as new assets.
  - Builds returned `PageImage` metadata.
- Create `src/main/openAiImageEdit.ts`
  - Small no-SDK OpenAI image edit client.
  - Reads `OPENAI_API_KEY` from environment.
- Modify `src/main/ipcHandlers.ts`
  - Registers `project:inpaintPageImage`.
  - Validates IPC payload.
  - Calls path resolver, API client, result asset writer.
- Create `src/renderer/components/InpaintingEditor.tsx`
  - Focused mask editor component.
  - Draws brush strokes onto a source-size canvas.
  - Exports alpha mask PNG.
- Modify `src/renderer/components/PageImagePanel.tsx`
  - Adds `Inpaint` entry point.
  - Shows `InpaintingEditor` in edit mode.
  - Sends completed mask requests upward.
- Modify `src/renderer/App.tsx`
  - Implements `inpaintPageImage`.
  - Replaces current page image metadata on success.
  - Marks project dirty and sets status messages.
- Modify `src/renderer/styles.css`
  - Adds tool layout and canvas overlay styles.
- Modify `tests/main/ipcHandlers.integration.test.ts`
  - Adds main-process IPC tests for missing key and generated asset storage.
- Modify `tests/renderer/App.test.tsx`
  - Adds renderer flow tests for button state, mode selection, cancel, and successful metadata replacement.

## Task 1: Shared Inpainting Types and Prompts

**Files:**
- Create: `src/shared/inpainting.ts`
- Test through later renderer/main tests.

- [ ] **Step 1: Create shared inpainting module**

Create `src/shared/inpainting.ts`:

```ts
export const inpaintingModes = ["speech-bubble", "caption-box", "background-text"] as const;

export type InpaintingMode = (typeof inpaintingModes)[number];

export type InpaintPageImageRequest = {
  projectFilePath: string;
  pageImage: {
    id: string;
    pageNumber: number;
    storedRelativePath: string;
    originalFileName: string;
    sha256: string;
    byteSize: number;
    mimeType: string;
    copiedAt: string;
  };
  maskPngBase64: string;
  mode: InpaintingMode;
  promptOverride?: string;
};

export const inpaintingModeLabels: Record<InpaintingMode, string> = {
  "speech-bubble": "말풍선",
  "caption-box": "캡션 박스",
  "background-text": "배경 글자"
};

export const inpaintingModePrompts: Record<InpaintingMode, string> = {
  "speech-bubble":
    "Remove only the source text inside the speech bubble. Preserve the speech bubble outline, tail, fill color, screentone, shadows, and surrounding artwork. Do not add any new letters, symbols, captions, or decorative marks.",
  "caption-box":
    "Remove only the source text inside the caption or narration box. Preserve the rectangular box edges, fill color, screentone, texture, and surrounding artwork. Do not add any new letters, symbols, captions, or decorative marks.",
  "background-text":
    "Remove the selected source text and reconstruct the underlying background, linework, texture, gradients, clothing, scenery, or character art. Do not add any new letters, symbols, captions, or decorative marks."
};

export function isInpaintingMode(value: unknown): value is InpaintingMode {
  return typeof value === "string" && (inpaintingModes as readonly string[]).includes(value);
}

export function buildInpaintingPrompt(mode: InpaintingMode, promptOverride?: string): string {
  const basePrompt = inpaintingModePrompts[mode];
  const trimmedOverride = promptOverride?.trim();
  return trimmedOverride ? `${basePrompt}\n\nAdditional user instruction: ${trimmedOverride}` : basePrompt;
}
```

- [ ] **Step 2: Run typecheck for the new shared file**

Run from:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add src/shared/inpainting.ts
git commit -m "feat: add shared inpainting presets"
```

## Task 2: Electron API Surface

**Files:**
- Modify: `src/renderer/electronApi.ts`
- Modify: `electron/preload.ts`
- Test through `tests/renderer/App.test.tsx` and `tests/electron/main.test.ts`.

- [ ] **Step 1: Update renderer API type**

In `src/renderer/electronApi.ts`, import the new request type and add `inpaintPageImage`:

```ts
import type { InpaintPageImageRequest } from "../shared/inpainting.js";
```

Add to `ElectronProjectApi`:

```ts
inpaintPageImage?: (args: InpaintPageImageRequest) => Promise<PageImage>;
```

- [ ] **Step 2: Expose IPC in preload**

In `electron/preload.ts`, add the method to the exposed `projectApi` object:

```ts
inpaintPageImage: (args) => ipcRenderer.invoke("project:inpaintPageImage", args),
```

Keep the existing exposed method names unchanged.

- [ ] **Step 3: Update Electron preload test if it asserts API keys**

Open `tests/electron/main.test.ts`. If the test checks the exposed project API members, add `inpaintPageImage` to the expected keys. If it only checks app bootstrap, leave it unchanged.

- [ ] **Step 4: Run focused tests**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/electron/main.test.ts tests/renderer/App.test.tsx
```

Expected: tests either pass or fail only because the renderer has not yet wired UI. Do not continue with unrelated failures.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/electronApi.ts electron/preload.ts tests/electron/main.test.ts
git commit -m "feat: expose inpainting ipc api"
```

## Task 3: Main-Process Asset Helpers

**Files:**
- Create: `src/main/inpaintingAssets.ts`
- Test: `tests/storage/inpaintingAssets.test.ts`

- [ ] **Step 1: Write failing storage tests**

Create `tests/storage/inpaintingAssets.test.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStoredPageImagePath, writeInpaintedPageImageAsset } from "../../src/main/inpaintingAssets";

describe("inpaintingAssets", () => {
  let tempDir: string;
  let projectFilePath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `inpainting-assets-${randomUUID()}`);
    projectFilePath = join(tempDir, "Book.ctp");
    await mkdir(join(tempDir, "Book-assets", "images"), { recursive: true });
    await writeFile(projectFilePath, "{}", "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves stored image paths inside the project directory", () => {
    const resolved = resolveStoredPageImagePath({
      projectFilePath,
      storedRelativePath: "Book-assets/images/page-001.png"
    });

    expect(resolved).toBe(join(tempDir, "Book-assets", "images", "page-001.png"));
  });

  it("rejects stored image paths outside the project directory", () => {
    expect(() =>
      resolveStoredPageImagePath({
        projectFilePath,
        storedRelativePath: "../outside.png"
      })
    ).toThrow(/inside the project folder/i);
  });

  it("writes inpainted image bytes as a new png asset without overwriting originals", async () => {
    const originalPath = join(tempDir, "Book-assets", "images", "page-001.png");
    await writeFile(originalPath, Buffer.from([1, 2, 3, 4]));

    const result = await writeInpaintedPageImageAsset({
      projectFilePath,
      sourcePageImage: {
        id: "page-image-original",
        pageNumber: 1,
        storedRelativePath: "Book-assets/images/page-001.png",
        originalFileName: "scan.png",
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "image/png",
        copiedAt: "2026-06-30T00:00:00.000Z"
      },
      imageBytes: Buffer.from([9, 8, 7, 6]),
      now: new Date("2026-06-30T01:02:03.000Z")
    });

    expect(result.pageImage.pageNumber).toBe(1);
    expect(result.pageImage.mimeType).toBe("image/png");
    expect(result.pageImage.originalFileName).toBe("scan-inpaint-001.png");
    expect(result.pageImage.storedRelativePath).toBe("Book-assets/images/page-001-inpaint-001.png");
    expect(await readFile(result.absoluteStoredPath)).toEqual(Buffer.from([9, 8, 7, 6]));
    expect(await readFile(originalPath)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
```

- [ ] **Step 2: Run failing test**

```powershell
npm test -- tests/storage/inpaintingAssets.test.ts
```

Expected: FAIL because `src/main/inpaintingAssets.ts` does not exist.

- [ ] **Step 3: Implement asset helper**

Create `src/main/inpaintingAssets.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import type { PageImage } from "../shared/projectTypes.js";

type ResolveStoredPageImagePathArgs = {
  projectFilePath: string;
  storedRelativePath: string;
};

type WriteInpaintedPageImageAssetArgs = {
  projectFilePath: string;
  sourcePageImage: PageImage;
  imageBytes: Buffer;
  now?: Date;
};

export function resolveStoredPageImagePath(args: ResolveStoredPageImagePathArgs): string {
  const projectDirectory = dirname(args.projectFilePath);
  const absoluteImagePath = resolve(projectDirectory, args.storedRelativePath);
  const relativeToProject = absoluteImagePath.slice(projectDirectory.length);

  if (!absoluteImagePath.startsWith(projectDirectory + sep) || relativeToProject.includes(`..${sep}`)) {
    throw new Error("Invalid image source request: image must be inside the project folder");
  }

  return absoluteImagePath;
}

export async function writeInpaintedPageImageAsset(args: WriteInpaintedPageImageAssetArgs): Promise<{
  pageImage: PageImage;
  absoluteStoredPath: string;
}> {
  const project = parse(args.projectFilePath);
  const assetRoot = join(project.dir, `${project.name}-assets`, "images");
  await mkdir(assetRoot, { recursive: true });

  const absoluteStoredPath = await nextInpaintedStoredPath(assetRoot, args.sourcePageImage.pageNumber);
  await writeFile(absoluteStoredPath, args.imageBytes);

  const copiedStat = await stat(absoluteStoredPath);
  const copiedHash = sha256Buffer(args.imageBytes);
  const storedRelativePath = relative(dirname(args.projectFilePath), absoluteStoredPath).replaceAll("\\", "/");
  const sourceBaseName = basename(args.sourcePageImage.originalFileName, parse(args.sourcePageImage.originalFileName).ext);

  return {
    absoluteStoredPath,
    pageImage: {
      id: randomUUID(),
      pageNumber: args.sourcePageImage.pageNumber,
      storedRelativePath,
      originalFileName: `${sourceBaseName}-inpaint-${extractInpaintIndex(absoluteStoredPath)}.png`,
      sha256: copiedHash,
      byteSize: copiedStat.size,
      mimeType: "image/png",
      copiedAt: (args.now ?? new Date()).toISOString()
    }
  };
}

async function nextInpaintedStoredPath(assetRoot: string, pageNumber: number): Promise<string> {
  const pageName = `page-${String(pageNumber).padStart(3, "0")}`;
  let attempt = 1;

  while (true) {
    const suffix = String(attempt).padStart(3, "0");
    const candidate = join(assetRoot, `${pageName}-inpaint-${suffix}.png`);
    try {
      await stat(candidate);
      attempt += 1;
    } catch {
      return candidate;
    }
  }
}

function extractInpaintIndex(filePath: string): string {
  return parse(filePath).name.split("-inpaint-")[1] ?? "001";
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
```

- [ ] **Step 4: Run storage test**

```powershell
npm test -- tests/storage/inpaintingAssets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/inpaintingAssets.ts tests/storage/inpaintingAssets.test.ts
git commit -m "feat: store inpainted image assets"
```

## Task 4: OpenAI Image Edit Client

**Files:**
- Create: `src/main/openAiImageEdit.ts`
- Test: `tests/main/openAiImageEdit.test.ts`

- [ ] **Step 1: Write failing client tests**

Create `tests/main/openAiImageEdit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { editImageWithOpenAI } from "../../src/main/openAiImageEdit";

describe("openAiImageEdit", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    vi.restoreAllMocks();
  });

  it("rejects missing OPENAI_API_KEY before making a request", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      editImageWithOpenAI({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        prompt: "remove text"
      })
    ).rejects.toThrow(/OPENAI_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts multipart image edit request and returns decoded png bytes", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const output = Buffer.from([9, 8, 7]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ b64_json: output.toString("base64") }] })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editImageWithOpenAI({
      imageBytes: Buffer.from([1]),
      maskBytes: Buffer.from([2]),
      prompt: "remove text"
    });

    expect(result).toEqual(output);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/edits",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
        body: expect.any(FormData)
      })
    );
  });

  it("throws a useful error when the API returns an error body", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message: "bad mask" } }))
    }) as unknown as typeof fetch;

    await expect(
      editImageWithOpenAI({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        prompt: "remove text"
      })
    ).rejects.toThrow(/bad mask/);
  });
});
```

- [ ] **Step 2: Run failing client tests**

```powershell
npm test -- tests/main/openAiImageEdit.test.ts
```

Expected: FAIL because `src/main/openAiImageEdit.ts` does not exist.

- [ ] **Step 3: Implement no-SDK client**

Create `src/main/openAiImageEdit.ts`:

```ts
type EditImageWithOpenAIArgs = {
  imageBytes: Buffer;
  maskBytes: Buffer;
  prompt: string;
};

type OpenAIImageEditResponse = {
  data?: Array<{ b64_json?: string }>;
};

export async function editImageWithOpenAI(args: EditImageWithOpenAIArgs): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to run inpainting.");
  }

  const formData = new FormData();
  formData.append("model", "gpt-image-2");
  formData.append("image[]", new Blob([new Uint8Array(args.imageBytes)], { type: "image/png" }), "source.png");
  formData.append("mask", new Blob([new Uint8Array(args.maskBytes)], { type: "image/png" }), "mask.png");
  formData.append("prompt", args.prompt);
  formData.append("size", "auto");
  formData.append("quality", "auto");
  formData.append("output_format", "png");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(await readOpenAIError(response));
  }

  const body = (await response.json()) as OpenAIImageEditResponse;
  const b64Json = body.data?.[0]?.b64_json;
  if (!b64Json) {
    throw new Error("OpenAI image edit response did not include image data.");
  }

  return Buffer.from(b64Json, "base64");
}

async function readOpenAIError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? `OpenAI image edit failed with HTTP ${response.status}.`;
  } catch {
    return text || `OpenAI image edit failed with HTTP ${response.status}.`;
  }
}
```

- [ ] **Step 4: Run client tests**

```powershell
npm test -- tests/main/openAiImageEdit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/openAiImageEdit.ts tests/main/openAiImageEdit.test.ts
git commit -m "feat: add openai image edit client"
```

## Task 5: Inpainting IPC Handler

**Files:**
- Modify: `src/main/ipcHandlers.ts`
- Test: `tests/main/ipcHandlers.integration.test.ts`

- [ ] **Step 1: Add failing IPC integration tests**

Append to `tests/main/ipcHandlers.integration.test.ts`:

```ts
it("rejects inpainting when OPENAI_API_KEY is missing", async () => {
  delete process.env.OPENAI_API_KEY;

  await expect(
    invokeHandler("project:inpaintPageImage", {
      projectFilePath,
      pageImage: {
        id: "page-image-1",
        pageNumber: 1,
        storedRelativePath: "Project-assets/images/page-001.png",
        originalFileName: "page-001.png",
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "image/png",
        copiedAt: "2026-06-30T00:00:00.000Z"
      },
      maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
      mode: "speech-bubble"
    })
  ).rejects.toThrow(/OPENAI_API_KEY/);
});
```

If the test file uses a different helper name than `invokeHandler`, adapt the call to the existing helper rather than creating a second harness.

- [ ] **Step 2: Run failing IPC test**

```powershell
npm test -- tests/main/ipcHandlers.integration.test.ts
```

Expected: FAIL because `project:inpaintPageImage` is not registered.

- [ ] **Step 3: Add imports**

In `src/main/ipcHandlers.ts`, add:

```ts
import { readFile } from "node:fs/promises";
import { buildInpaintingPrompt, isInpaintingMode } from "../shared/inpainting.js";
import type { InpaintPageImageRequest } from "../shared/inpainting.js";
import { resolveStoredPageImagePath, writeInpaintedPageImageAsset } from "./inpaintingAssets.js";
import { editImageWithOpenAI } from "./openAiImageEdit.js";
```

If `readFile` is already imported from `node:fs/promises`, merge it into the existing import.

- [ ] **Step 4: Register handler**

Inside `registerIpcHandlers()`, after `project:importPageImages`, add:

```ts
ipcMain.handle("project:inpaintPageImage", async (_event, args) => {
  const inpaintArgs = validateInpaintPageImageArgs(args);
  const imagePath = resolveStoredPageImagePath({
    projectFilePath: inpaintArgs.projectFilePath,
    storedRelativePath: inpaintArgs.pageImage.storedRelativePath
  });
  const [imageBytes, maskBytes] = await Promise.all([
    readFile(imagePath),
    Promise.resolve(Buffer.from(inpaintArgs.maskPngBase64, "base64"))
  ]);
  const editedImageBytes = await editImageWithOpenAI({
    imageBytes,
    maskBytes,
    prompt: buildInpaintingPrompt(inpaintArgs.mode, inpaintArgs.promptOverride)
  });
  const result = await writeInpaintedPageImageAsset({
    projectFilePath: inpaintArgs.projectFilePath,
    sourcePageImage: inpaintArgs.pageImage,
    imageBytes: editedImageBytes
  });
  return result.pageImage;
});
```

- [ ] **Step 5: Add validator**

Near other validators in `src/main/ipcHandlers.ts`, add:

```ts
export function validateInpaintPageImageArgs(args: unknown): InpaintPageImageRequest {
  if (!isRecord(args)) throw new Error("Invalid inpaint request: expected object");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid inpaint request: projectFilePath must be a string");
  }
  assertProjectFilePath(args.projectFilePath);
  if (!isRecord(args.pageImage)) throw new Error("Invalid inpaint request: pageImage must be an object");
  if (typeof args.maskPngBase64 !== "string" || args.maskPngBase64.length === 0) {
    throw new Error("Invalid inpaint request: maskPngBase64 must be a non-empty string");
  }
  if (!isInpaintingMode(args.mode)) {
    throw new Error("Invalid inpaint request: mode is not supported");
  }
  if (args.promptOverride !== undefined && typeof args.promptOverride !== "string") {
    throw new Error("Invalid inpaint request: promptOverride must be a string");
  }

  return {
    projectFilePath: args.projectFilePath,
    pageImage: args.pageImage as InpaintPageImageRequest["pageImage"],
    maskPngBase64: args.maskPngBase64,
    mode: args.mode,
    promptOverride: args.promptOverride
  };
}
```

- [ ] **Step 6: Run IPC tests**

```powershell
npm test -- tests/main/ipcHandlers.integration.test.ts
```

Expected: PASS or fail only where the added test harness needs adjustment. Fix harness mismatch before moving on.

- [ ] **Step 7: Run typecheck**

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/main/ipcHandlers.ts tests/main/ipcHandlers.integration.test.ts
git commit -m "feat: register inpainting ipc handler"
```

## Task 6: Renderer Mask Editor Component

**Files:**
- Create: `src/renderer/components/InpaintingEditor.tsx`
- Modify: `src/renderer/styles.css`
- Test through `tests/renderer/App.test.tsx`.

- [ ] **Step 1: Create focused component**

Create `src/renderer/components/InpaintingEditor.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { inpaintingModeLabels, inpaintingModes } from "../../shared/inpainting";
import type { InpaintingMode } from "../../shared/inpainting";

type Props = {
  imageSrc: string;
  currentPage: number;
  disabled?: boolean;
  onCancel: () => void;
  onRun: (args: { maskPngBase64: string; mode: InpaintingMode; promptOverride?: string }) => Promise<void>;
};

export function InpaintingEditor({ imageSrc, currentPage, disabled, onCancel, onRun }: Props) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<InpaintingMode>("speech-bubble");
  const [brushSize, setBrushSize] = useState(24);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [hasMask, setHasMask] = useState(false);
  const [promptOverride, setPromptOverride] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    setHasMask(false);
    setTool("brush");
  }, [imageSrc]);

  function syncCanvasToImage() {
    const image = imageRef.current;
    const canvas = maskCanvasRef.current;
    if (!image || !canvas || image.naturalWidth === 0 || image.naturalHeight === 0) return;
    if (canvas.width === image.naturalWidth && canvas.height === image.naturalHeight) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
  }

  function paint(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || isRunning) return;
    const image = imageRef.current;
    const canvas = maskCanvasRef.current;
    if (!image || !canvas) return;
    syncCanvasToImage();
    const rect = image.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(255, 0, 0, 1)";
    context.beginPath();
    context.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    setHasMask(hasNonTransparentPixels(canvas));
  }

  function clearMask() {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasMask(false);
  }

  async function runInpainting() {
    const canvas = maskCanvasRef.current;
    if (!canvas || !hasMask) return;
    setIsRunning(true);
    try {
      const dataUrl = canvas.toDataURL("image/png");
      await onRun({
        maskPngBase64: dataUrl.replace(/^data:image\/png;base64,/, ""),
        mode,
        promptOverride: promptOverride.trim() || undefined
      });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="inpainting-editor" aria-label={`${currentPage}페이지 인페인팅 편집기`}>
      <div className="inpainting-toolbar">
        <div className="inpainting-mode-tabs" aria-label="인페인팅 모드">
          {inpaintingModes.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              onClick={() => setMode(candidate)}
              disabled={disabled || isRunning}
            >
              {inpaintingModeLabels[candidate]}
            </button>
          ))}
        </div>
        <label>
          브러시
          <input
            aria-label="브러시 크기"
            type="range"
            min="8"
            max="96"
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            disabled={disabled || isRunning}
          />
        </label>
        <button type="button" aria-pressed={tool === "brush"} onClick={() => setTool("brush")} disabled={disabled || isRunning}>
          칠하기
        </button>
        <button type="button" aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")} disabled={disabled || isRunning}>
          지우개
        </button>
        <button type="button" onClick={clearMask} disabled={!hasMask || disabled || isRunning}>
          마스크 지우기
        </button>
      </div>
      <label className="inpainting-prompt">
        추가 지시
        <input
          value={promptOverride}
          onChange={(event) => setPromptOverride(event.target.value)}
          placeholder="선택 사항"
          disabled={disabled || isRunning}
        />
      </label>
      <div className="inpainting-canvas-wrap" onPointerDown={paint} onPointerMove={(event) => event.buttons === 1 && paint(event)}>
        <img ref={imageRef} alt={`${currentPage}페이지 인페인팅 대상`} src={imageSrc} onLoad={syncCanvasToImage} draggable={false} />
        <canvas ref={maskCanvasRef} aria-label="인페인팅 마스크" />
      </div>
      <div className="inpainting-actions">
        <button type="button" onClick={onCancel} disabled={isRunning}>
          취소
        </button>
        <button type="button" className="primary-button" onClick={runInpainting} disabled={!hasMask || disabled || isRunning}>
          {isRunning ? "실행 중" : "인페인팅 실행"}
        </button>
      </div>
    </div>
  );
}

function hasNonTransparentPixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}
```

- [ ] **Step 2: Add styles**

Append to `src/renderer/styles.css`:

```css
.inpainting-editor {
  display: grid;
  gap: 10px;
}

.inpainting-toolbar,
.inpainting-actions,
.inpainting-mode-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.inpainting-prompt {
  display: grid;
  gap: 4px;
}

.inpainting-canvas-wrap {
  position: relative;
  overflow: auto;
  max-height: min(620px, calc(100vh - 320px));
  background: var(--image-stage);
  touch-action: none;
}

.inpainting-canvas-wrap img {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
}

.inpainting-canvas-wrap canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0.38;
  mix-blend-mode: multiply;
  cursor: crosshair;
}
```

- [ ] **Step 3: Run typecheck**

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add src/renderer/components/InpaintingEditor.tsx src/renderer/styles.css
git commit -m "feat: add inpainting mask editor"
```

## Task 7: Wire Page Image Panel and App State

**Files:**
- Modify: `src/renderer/components/PageImagePanel.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Add tests to `tests/renderer/App.test.tsx`:

```tsx
it("disables inpainting when the current page has no image", () => {
  render(<App />);

  expect(screen.getByRole("button", { name: "인페인팅" })).toBeDisabled();
});

it("opens inpainting mode for a connected page image and cancels without replacing metadata", async () => {
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn().mockResolvedValue({
      filePath: "C:\\projects\\Book.ctp",
      encrypted: false,
      project: {
        schemaVersion: 1,
        metadata: {
          id: "project-inpaint",
          title: "Inpaint Project",
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
          secret: false
        },
        characters: [],
        dictionaryTerms: [],
        dialogueLines: [],
        pageImages: [
          {
            id: "page-image-1",
            pageNumber: 1,
            storedRelativePath: "Book-assets/images/page-001.png",
            originalFileName: "page-001.png",
            sha256: "a".repeat(64),
            byteSize: 4,
            mimeType: "image/png",
            copiedAt: "2026-06-30T00:00:00.000Z"
          }
        ],
        settings: { defaultSourceLanguage: "unknown" }
      }
    }),
    saveProject: vi.fn(),
    importPageImages: vi.fn(),
    resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://asset/page-image-token"),
    inpaintPageImage: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
  expect(screen.getByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(screen.queryByLabelText("1페이지 인페인팅 편집기")).not.toBeInTheDocument();
  expect(window.projectApi.inpaintPageImage).not.toHaveBeenCalled();
});
```

Add a success test after the component is wired. For canvas drawing in jsdom, mock `HTMLCanvasElement.prototype.toDataURL` and enough context methods to mark a mask. Keep this success test focused on `App` calling `inpaintPageImage` and replacing metadata.

- [ ] **Step 2: Run failing renderer tests**

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: FAIL because `인페인팅` button and editor are not wired.

- [ ] **Step 3: Update `PageImagePanel` props**

Add imports:

```tsx
import { InpaintingEditor } from "./InpaintingEditor";
import type { InpaintingMode } from "../../shared/inpainting";
```

Extend props:

```ts
onInpaintImage: (args: { maskPngBase64: string; mode: InpaintingMode; promptOverride?: string }) => Promise<void>;
isInpainting?: boolean;
```

Add local edit state:

```ts
const [isInpaintingOpen, setIsInpaintingOpen] = useState(false);
```

Add an `Inpaint` button in `.page-image-tools`:

```tsx
<button type="button" onClick={() => setIsInpaintingOpen(true)} disabled={!image || imageLoadFailed || !currentFilePath}>
  인페인팅
</button>
```

Replace image stage content when `isInpaintingOpen && image && resolvedImageSrc`:

```tsx
<InpaintingEditor
  imageSrc={resolvedImageSrc ?? image.storedRelativePath}
  currentPage={currentPage}
  disabled={isInpainting}
  onCancel={() => setIsInpaintingOpen(false)}
  onRun={async (args) => {
    await onInpaintImage(args);
    setIsInpaintingOpen(false);
  }}
/>
```

- [ ] **Step 4: Update `App` handler**

In `src/renderer/App.tsx`, import:

```ts
import type { InpaintingMode } from "../shared/inpainting";
```

Add state:

```ts
const [isInpainting, setIsInpainting] = useState(false);
```

Add handler:

```ts
async function inpaintPageImage(args: { maskPngBase64: string; mode: InpaintingMode; promptOverride?: string }) {
  if (!window.projectApi?.inpaintPageImage || !currentFilePath || !currentPageImage) return;
  setIsInpainting(true);
  try {
    const nextPageImage = await window.projectApi.inpaintPageImage({
      projectFilePath: currentFilePath,
      pageImage: currentPageImage,
      maskPngBase64: args.maskPngBase64,
      mode: args.mode,
      promptOverride: args.promptOverride
    });
    setProject((current) => ({
      ...current,
      pageImages: [
        ...(current.pageImages ?? []).filter((image) => image.pageNumber !== nextPageImage.pageNumber),
        nextPageImage
      ],
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
    setIsDirty(true);
    setStatusMessage("인페인팅 결과를 현재 페이지 이미지로 적용했습니다.");
  } catch (error) {
    setStatusMessage(error instanceof Error ? error.message : "인페인팅을 실행하지 못했습니다.");
  } finally {
    setIsInpainting(false);
  }
}
```

Pass props to `PageImagePanel`:

```tsx
isInpainting={isInpainting}
onInpaintImage={inpaintPageImage}
```

- [ ] **Step 5: Run renderer tests**

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: PASS after fixing test harness details.

- [ ] **Step 6: Run typecheck**

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/App.tsx src/renderer/components/PageImagePanel.tsx tests/renderer/App.test.tsx
git commit -m "feat: wire inpainting workflow"
```

## Task 8: Final Verification and Manual QA Notes

**Files:**
- Modify only if a small fix is required by verification.

- [ ] **Step 1: Run full checks**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
npm test
npm run build
```

Expected:

- typecheck PASS.
- tests PASS.
- build PASS.

- [ ] **Step 2: Launch app for manual QA**

Use a real API key only in the current PowerShell session:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
$env:OPENAI_API_KEY="sk-your-key-here"
npm run start
```

Expected: Electron app opens.

- [ ] **Step 3: Manual QA cases**

Run these in the app:

- Open a saved project with a connected page image.
- Click `인페인팅`.
- Paint a small speech-bubble text area.
- Select `말풍선`.
- Click `인페인팅 실행`.
- Verify a new image appears and dirty state is shown.
- Save project.
- Reopen project.
- Verify the inpainted image persists.
- Repeat once for `캡션 박스`.
- Repeat once for `배경 글자`.
- Run once with `OPENAI_API_KEY` missing and verify the app shows a clear missing-key message without changing the current image.

- [ ] **Step 4: Commit final fixes if needed**

If verification required fixes:

```powershell
git add src/shared/inpainting.ts src/main/inpaintingAssets.ts src/main/openAiImageEdit.ts src/main/ipcHandlers.ts src/renderer/electronApi.ts src/renderer/App.tsx src/renderer/components/InpaintingEditor.tsx src/renderer/components/PageImagePanel.tsx src/renderer/styles.css electron/preload.ts tests/main/openAiImageEdit.test.ts tests/main/ipcHandlers.integration.test.ts tests/storage/inpaintingAssets.test.ts tests/renderer/App.test.tsx tests/electron/main.test.ts
git commit -m "fix: stabilize inpainting workflow"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

- Spec coverage:
  - Manual mask editing: Task 6.
  - Mode presets: Tasks 1 and 6.
  - Original preservation and new image asset: Task 3.
  - One generated result: Task 4 uses `data[0]` only.
  - Current page metadata replacement and dirty state: Task 7.
  - Missing key and failure handling: Tasks 4, 5, and 8.
- Placeholder scan:
  - The plan contains concrete tasks, file paths, commands, and code snippets for the first-version implementation.
  - The only excluded items are explicitly out of first-version scope.
- Type consistency:
  - `InpaintingMode`, `InpaintPageImageRequest`, `inpaintPageImage`, `maskPngBase64`, and `pageImage` are named consistently across shared, renderer, and main-process tasks.
