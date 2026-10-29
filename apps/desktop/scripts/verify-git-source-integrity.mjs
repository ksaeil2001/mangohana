import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const GIT_SOURCE_INTEGRITY_SCHEMA_VERSION = "trio.git-source-integrity.v1";

const SHA1_HEX_PATTERN = /^[0-9a-f]{40}$/iu;
const TREE_MODE_PATTERN = /^(?:100644|100755|120000)$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected argument: ${argument}.`);
    }
    const name = argument.slice(2);
    if (!["repo", "expected-head", "output"].includes(name)) {
      fail(`Unsupported argument: --${name}.`);
    }
    if (Object.hasOwn(result, name)) {
      fail(`Duplicate argument: --${name}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${name}.`);
    }
    result[name] = value;
    index += 1;
  }

  for (const required of ["repo", "expected-head", "output"]) {
    if (!result[required]) {
      fail(`Required argument is missing: --${required}.`);
    }
  }
  if (!SHA1_HEX_PATTERN.test(result["expected-head"])) {
    fail("Expected HEAD must be exactly 40 hexadecimal characters.");
  }
  return result;
}

async function runGit(repo, args) {
  try {
    return await execFile("git", ["-C", repo, ...args], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
  } catch {
    fail("Git source integrity inspection failed.");
  }
}

function decode(output) {
  return output.stdout.toString("utf8");
}

async function runGitText(repo, args) {
  const result = await runGit(repo, args);
  return decode(result).trim();
}

function parseTreeEntries(buffer) {
  const entries = new Map();
  for (const record of buffer.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex <= 0) {
      fail("Git tree contains an invalid tracked entry.");
    }
    const header = record.slice(0, separatorIndex).split(" ");
    const path = record.slice(separatorIndex + 1);
    if (header.length !== 3 || path.length === 0) {
      fail("Git tree contains an invalid tracked entry.");
    }
    const [mode, type, objectId] = header;
    if (!TREE_MODE_PATTERN.test(mode) || type !== "blob" || !SHA1_HEX_PATTERN.test(objectId)) {
      fail("Git tree contains an unsupported tracked entry.");
    }
    if (entries.has(path)) {
      fail("Git tree contains duplicate tracked paths.");
    }
    entries.set(path, { mode, objectId });
  }
  return entries;
}

function parseIndexEntries(buffer) {
  const entries = new Map();
  for (const record of buffer.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const separatorIndex = record.indexOf("\t");
    if (separatorIndex <= 0) {
      fail("Git index contains an invalid tracked entry.");
    }
    const header = record.slice(0, separatorIndex).split(" ");
    const path = record.slice(separatorIndex + 1);
    if (header.length !== 3 || path.length === 0) {
      fail("Git index contains an invalid tracked entry.");
    }
    const [mode, objectId, stage] = header;
    if (!TREE_MODE_PATTERN.test(mode) || !SHA1_HEX_PATTERN.test(objectId) || stage !== "0") {
      fail("Git index contains staged or unsupported tracked changes.");
    }
    if (entries.has(path)) {
      fail("Git index contains duplicate tracked paths.");
    }
    entries.set(path, { mode, objectId });
  }
  return entries;
}

function parseIndexStatuses(buffer) {
  const statuses = new Map();
  for (const record of buffer.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    if (record.length < 3 || record[1] !== " ") {
      fail("Git index status output is invalid.");
    }
    const status = record[0];
    const path = record.slice(2);
    if (path.length === 0) {
      fail("Git index status output contains an empty path.");
    }
    if (statuses.has(path)) {
      fail("Git index status output contains duplicate tracked paths.");
    }
    statuses.set(path, status);
  }
  return statuses;
}

function compareEntrySets(treeEntries, indexEntries) {
  if (treeEntries.size !== indexEntries.size) {
    fail("The Git index has staged tracked changes.");
  }
  for (const [path, treeEntry] of treeEntries) {
    const indexEntry = indexEntries.get(path);
    if (!indexEntry || indexEntry.mode !== treeEntry.mode || indexEntry.objectId !== treeEntry.objectId) {
      fail("The Git index has staged tracked changes.");
    }
  }
  for (const path of indexEntries.keys()) {
    if (!treeEntries.has(path)) {
      fail("The Git index has staged tracked changes.");
    }
  }
}

function ensureWithinRepository(repo, path) {
  const fullPath = resolve(repo, path.replaceAll("/", sep));
  const relativePath = relative(resolve(repo), fullPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    fail("Git tree contains a path outside the repository.");
  }
  return fullPath;
}

function expectedModeForStat(stat) {
  if (!stat.isFile()) {
    return null;
  }
  return (stat.mode & 0o111) === 0 ? "100644" : "100755";
}

function gitBlobHash(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

async function verifyWorktreeEntry(repo, path, expected) {
  const fullPath = ensureWithinRepository(repo, path);
  let stat;
  try {
    stat = await lstat(fullPath);
  } catch {
    fail("A tracked file is missing from the working tree.");
  }

  if (expected.mode === "120000") {
    if (!stat.isSymbolicLink()) {
      fail("A tracked symbolic link is missing from the working tree.");
    }
    let linkTarget;
    try {
      linkTarget = await readlink(fullPath, "utf8");
    } catch {
      fail("A tracked symbolic link could not be read.");
    }
    if (gitBlobHash(Buffer.from(linkTarget, "utf8")) !== expected.objectId) {
      fail("A tracked symbolic link target changed in the working tree.");
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    fail("A tracked file was replaced with a symbolic link.");
  }
  if (stat.isDirectory()) {
    fail("A tracked file was replaced with a directory.");
  }
  if (!stat.isFile()) {
    fail("A tracked entry is not a regular file.");
  }

  const executeBitsObservable = process.platform !== "win32" || (stat.mode & 0o111) !== 0;
  if (executeBitsObservable && expectedModeForStat(stat) !== expected.mode) {
    fail("A tracked file mode changed in the working tree.");
  }

  const hash = await runGitText(repo, ["hash-object", `--path=${path}`, "--", path]);
  if (hash !== expected.objectId) {
    fail("A tracked file content changed in the working tree.");
  }
}

async function verifyRepository({ repo, expectedHead }) {
  const normalizedExpectedHead = expectedHead.toLowerCase();
  const headSha = await runGitText(repo, ["rev-parse", "HEAD"]);
  if (!SHA1_HEX_PATTERN.test(headSha) || headSha.toLowerCase() !== normalizedExpectedHead) {
    fail("The checked-out HEAD does not match expected-head.");
  }

  const treeSha = await runGitText(repo, ["rev-parse", "HEAD^{tree}"]);
  if (!SHA1_HEX_PATTERN.test(treeSha)) {
    fail("The checked-out HEAD tree is invalid.");
  }

  const treeEntries = parseTreeEntries(
    (await runGit(repo, ["ls-tree", "-r", "-z", "--full-tree", headSha])).stdout
  );
  const indexEntries = parseIndexEntries(
    (await runGit(repo, ["ls-files", "--stage", "-z"])).stdout
  );
  const indexStatuses = parseIndexStatuses(
    (await runGit(repo, ["ls-files", "-v", "-z"])).stdout
  );
  compareEntrySets(treeEntries, indexEntries);

  if (indexStatuses.size !== treeEntries.size) {
    fail("The Git index status does not cover every tracked path.");
  }
  for (const [path, status] of indexStatuses) {
    if (status !== "H") {
      fail("Tracked files must not use assume-unchanged, skip-worktree, or other index flags.");
    }
    if (!treeEntries.has(path)) {
      fail("The Git index contains an untracked status entry.");
    }
  }

  for (const [path, entry] of treeEntries) {
    await verifyWorktreeEntry(repo, path, entry);
  }

  return {
    schemaVersion: GIT_SOURCE_INTEGRITY_SCHEMA_VERSION,
    headSha: headSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
    trackedFileCount: treeEntries.size,
    clean: true
  };
}

export async function verifyGitSourceIntegrity({ repo, expectedHead, output }) {
  if (typeof repo !== "string" || repo.length === 0 || typeof output !== "string" || output.length === 0) {
    fail("Repository and output paths are required.");
  }
  const evidence = await verifyRepository({
    repo: resolve(repo),
    expectedHead
  });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(evidence)}\n`, "utf8");
  return evidence;
}

async function main() {
  const argumentsObject = parseArguments(process.argv.slice(2));
  const evidence = await verifyGitSourceIntegrity({
    repo: argumentsObject.repo,
    expectedHead: argumentsObject["expected-head"],
    output: argumentsObject.output
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1]?.endsWith("verify-git-source-integrity.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
