import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFile = promisify(execFileCallback);
const projectRoot = process.cwd();
const verifierPath = join(projectRoot, "scripts", "verify-git-source-integrity.mjs");
const temporaryRepositories = [];

async function git(repo, ...args) {
  const result = await execFile("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  return result.stdout.trim();
}

async function createRepository() {
  const repo = await mkdtemp(join(tmpdir(), "trio-git-integrity-"));
  temporaryRepositories.push(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "integrity@example.invalid");
  await git(repo, "config", "user.name", "Integrity Test");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "core.filemode", "true");
  await writeFile(join(repo, "tracked.txt"), "original\n");
  await writeFile(join(repo, "nested.txt"), "nested\n");
  await git(repo, "add", "tracked.txt", "nested.txt");
  await git(repo, "commit", "-qm", "baseline");
  return { repo, head: await git(repo, "rev-parse", "HEAD") };
}

async function createExecutableRepository() {
  const repo = await mkdtemp(join(tmpdir(), "trio-git-integrity-executable-"));
  temporaryRepositories.push(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "integrity@example.invalid");
  await git(repo, "config", "user.name", "Integrity Test");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "core.filemode", "true");
  const executablePath = join(repo, "tracked.sh");
  await writeFile(executablePath, "#!/bin/sh\nprintf 'ok\\n'\n");
  try {
    await chmod(executablePath, 0o755);
  } catch {
    // Windows can preserve the Git executable mode without exposing POSIX bits.
  }
  await git(repo, "add", "tracked.sh");
  await git(repo, "update-index", "--chmod=+x", "--", "tracked.sh");
  await git(repo, "commit", "-qm", "executable baseline");
  const indexMode = await git(repo, "ls-files", "--stage", "--", "tracked.sh");
  if (!indexMode.startsWith("100755 ")) {
    throw new Error("The executable test fixture did not create a 100755 Git entry.");
  }
  const worktreeStat = await lstat(executablePath);
  if (process.platform !== "win32" && (worktreeStat.mode & 0o777) !== 0o755) {
    throw new Error("The POSIX executable test fixture did not create a 0755 worktree file.");
  }
  return { repo, head: await git(repo, "rev-parse", "HEAD") };
}

async function runVerifier(repo, expectedHead, outputPath = join(repo, "integrity.json")) {
  return execFile("node", [
    verifierPath,
    "--repo",
    repo,
    "--expected-head",
    expectedHead,
    "--output",
    outputPath
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

async function expectRejected(operation, expectedMessage) {
  await expect(operation).rejects.toMatchObject({
    stderr: expect.stringMatching(expectedMessage)
  });
}

afterEach(async () => {
  for (const repo of temporaryRepositories.splice(0)) {
    await execFile("git", ["-C", repo, "clean", "-ffdqx"]).catch(() => undefined);
  }
});

describe("verify-git-source-integrity CLI", () => {
  test("writes sanitized integrity evidence for an unchanged tracked tree", async () => {
    const { repo, head } = await createRepository();
    const outputPath = join(repo, "evidence", "integrity.json");

    await runVerifier(repo, head, outputPath);

    const evidence = JSON.parse(await readFile(outputPath, "utf8"));
    expect(evidence).toEqual({
      schemaVersion: "trio.git-source-integrity.v1",
      headSha: head,
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      trackedFileCount: 2,
      clean: true
    });
    expect(JSON.stringify(evidence)).not.toContain(repo);
  });

  test("accepts a clean tracked 100755 baseline when Windows cannot expose execute bits", async () => {
    const { repo, head } = await createExecutableRepository();
    const outputPath = join(repo, "evidence", "integrity.json");

    await runVerifier(repo, head, outputPath);

    const evidence = JSON.parse(await readFile(outputPath, "utf8"));
    expect(evidence.trackedFileCount).toBe(1);
    expect(evidence.clean).toBe(true);
  });

  test("rejects an ordinary tracked-file edit", async () => {
    const { repo, head } = await createRepository();
    await writeFile(join(repo, "tracked.txt"), "edited\n");

    await expectRejected(runVerifier(repo, head), /tracked file|working tree|modified/i);
  });

  test("rejects a tracked-file deletion", async () => {
    const { repo, head } = await createRepository();
    await import("node:fs/promises").then(({ unlink }) => unlink(join(repo, "tracked.txt")));

    await expectRejected(runVerifier(repo, head), /missing|deleted|tracked file/i);
  });

  test("rejects a staged edit even when the worktree is restored", async () => {
    const { repo, head } = await createRepository();
    await writeFile(join(repo, "tracked.txt"), "staged edit\n");
    await git(repo, "add", "tracked.txt");
    await writeFile(join(repo, "tracked.txt"), "original\n");

    await expectRejected(runVerifier(repo, head), /staged|index|tracked tree/i);
  });

  test("rejects an assume-unchanged edit instead of trusting the index flag", async () => {
    const { repo, head } = await createRepository();
    await git(repo, "update-index", "--assume-unchanged", "tracked.txt");
    await writeFile(join(repo, "tracked.txt"), "assume-unchanged edit\n");

    await expectRejected(runVerifier(repo, head), /assume|working tree|modified|tracked file/i);
  });

  test("rejects a skip-worktree edit instead of trusting the index flag", async () => {
    const { repo, head } = await createRepository();
    await git(repo, "update-index", "--skip-worktree", "tracked.txt");
    await writeFile(join(repo, "tracked.txt"), "skip-worktree edit\n");

    await expectRejected(runVerifier(repo, head), /skip|working tree|modified|tracked file/i);
  });

  test("rejects a tracked mode change where the platform supports executable modes", async () => {
    const { repo, head } = await createRepository();
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(join(repo, "tracked.txt"), 0o755);
    } catch {
      return;
    }

    const { lstat } = await import("node:fs/promises");
    const stat = await lstat(join(repo, "tracked.txt"));
    if ((stat.mode & 0o111) === 0) {
      return;
    }
    const indexMode = await git(repo, "ls-files", "--stage", "--", "tracked.txt");
    if (!indexMode.startsWith("100644 ")) {
      return;
    }
    await expectRejected(runVerifier(repo, head), /mode|permission|tracked file|modified/i);
  });

  test("rejects a symlink substituted for a tracked regular file where supported", async () => {
    const { repo, head } = await createRepository();
    const trackedPath = join(repo, "tracked.txt");
    const targetPath = join(repo, "replacement-target.txt");
    const { unlink } = await import("node:fs/promises");
    await unlink(trackedPath);
    await writeFile(targetPath, "original\n");
    try {
      await symlink(targetPath, trackedPath);
    } catch {
      return;
    }

    await expectRejected(runVerifier(repo, head), /symbolic|symlink|reparse|tracked file/i);
  });

  test("rejects an expected HEAD that does not match the checkout", async () => {
    const { repo, head } = await createRepository();
    await writeFile(join(repo, "new.txt"), "new\n");
    await git(repo, "add", "new.txt");
    await git(repo, "commit", "-qm", "second");

    await expectRejected(runVerifier(repo, head), /expected.*head|HEAD|commit SHA/i);
  });
});
