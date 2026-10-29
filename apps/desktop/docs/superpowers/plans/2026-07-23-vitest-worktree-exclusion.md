# Vitest Worktree Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm.cmd test` run only the current checkout so nested `.worktrees` tests cannot create duplicate or false failures.

**Architecture:** Extend Vitest's built-in exclusion list instead of replacing it. Add one configuration contract test that proves the current checkout's `tests` directory is collected while nested `.worktrees` paths are excluded.

**Tech Stack:** Vite 8, Vitest 4, TypeScript 6, PowerShell on Windows

## Global Constraints

- Work from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기`.
- Do not add packages or modify `package-lock.json`.
- Do not edit or delete anything under `.worktrees`.
- Preserve Vitest's built-in exclusions for `node_modules`, `dist`, coverage, and cache directories.
- Do not modify generated `dist-electron` or `dist-renderer` output.

---

### Task 1: Lock Vitest collection to the current checkout

**Files:**
- Modify: `vite.config.ts`
- Create: `tests/config/vitestConfig.test.ts`

**Interfaces:**
- Consumes: Vitest's exported `configDefaults.exclude: string[]`.
- Produces: `test.exclude` containing all defaults plus `**/.worktrees/**`.

- [ ] **Step 1: Write the failing configuration test**

Create `tests/config/vitestConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import config from "../../vite.config";

describe("Vitest collection scope", () => {
  it("excludes nested worktrees without discarding Vitest defaults", () => {
    const testConfig = config.test;
    expect(testConfig?.exclude).toEqual(
      expect.arrayContaining(["**/.worktrees/**", "**/node_modules/**"])
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the missing exclusion**

From the project folder:

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test -- tests/config/vitestConfig.test.ts
```

Expected: FAIL because `vite.config.ts` has no `test.exclude` value.

- [ ] **Step 3: Extend the default exclusion list**

Change the Vitest import and `test` block in `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    strictPort: true
  },
  test: {
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"]
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
```

- [ ] **Step 4: Run the focused test**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test -- tests/config/vitestConfig.test.ts
```

Expected: the configuration test passes.

- [ ] **Step 5: Run the complete verification suite**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git status --short
```

Expected:

- no test path begins with `.worktrees/`;
- all current-checkout tests pass;
- renderer and Electron typechecks pass;
- build succeeds;
- no generated output, lock file, API key, or user project file is staged.

- [ ] **Step 6: Commit the isolated maintenance change**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
git add vite.config.ts tests/config/vitestConfig.test.ts
git status --short
git commit -m "test: exclude nested worktrees from vitest"
```

Expected: one small commit containing only the config and its test.

---

## Acceptance Checklist

- [ ] `npm.cmd test` collects no `.worktrees/**` file.
- [ ] Current-checkout test count is stable and every test passes.
- [ ] Vitest default exclusions remain present.
- [ ] Typecheck and build pass.
- [ ] No worktree, package, lock, generated, secret, or user-data file changes.
