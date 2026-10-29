import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadProjectFile, saveProjectFile } from "../dist-electron/src/main/projectStorage.js";
import { createEmptyProject } from "../dist-electron/src/shared/projectValidation.js";

const tempDir = await mkdtemp(join(tmpdir(), "dialogue-editor-smoke-"));

try {
  const normalProject = createEmptyProject("Smoke Normal", false);
  normalProject.characters.push({
    id: "character-smoke",
    name: "Mika",
    aliases: ["Mi"],
    description: "Smoke test character",
    speechStyle: "direct"
  });
  normalProject.dictionaryTerms.push({
    id: "term-smoke",
    source: "senpai",
    target: "senior",
    note: "relationship term"
  });
  normalProject.dialogueLines.push({
    id: "line-smoke",
    order: 1,
    speaker: "Mika",
    position: "Panel 1",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "Original line",
    referenceTranslation: "Reference line",
    userTranslation: "Edited line",
    parseConfidence: 0.9,
    parseWarnings: []
  });

  const normalPath = join(tempDir, "normal.ctp");
  await saveProjectFile({ filePath: normalPath, project: normalProject });
  const normalLoaded = await loadProjectFile({ filePath: normalPath });
  assert.equal(normalLoaded.encrypted, false);
  assert.equal(normalLoaded.project.metadata.title, "Smoke Normal");
  assert.equal(normalLoaded.project.characters[0]?.name, "Mika");
  assert.equal(normalLoaded.project.dictionaryTerms[0]?.target, "senior");
  assert.equal(normalLoaded.project.dialogueLines[0]?.userTranslation, "Edited line");

  const secretProject = createEmptyProject("Smoke Secret", true);
  secretProject.dialogueLines.push({
    id: "line-secret",
    order: 1,
    dialogueType: "speech",
    sourceLanguage: "en",
    sourceText: "Sensitive source text",
    userTranslation: "Sensitive edited text",
    parseConfidence: 1,
    parseWarnings: []
  });

  const secretPath = join(tempDir, "secret.ctp");
  await saveProjectFile({ filePath: secretPath, project: secretProject, password: "smoke password" });
  const rawSecret = await readFile(secretPath, "utf8");
  assert.equal(JSON.parse(rawSecret).encrypted, true);
  assert.equal(rawSecret.includes("Smoke Secret"), false);
  assert.equal(rawSecret.includes("Sensitive source text"), false);
  await assert.rejects(() => loadProjectFile({ filePath: secretPath, password: "wrong password" }), /password/i);

  const secretLoaded = await loadProjectFile({ filePath: secretPath, password: "smoke password" });
  assert.equal(secretLoaded.encrypted, true);
  assert.equal(secretLoaded.project.metadata.title, "Smoke Secret");
  assert.equal(secretLoaded.project.dialogueLines[0]?.sourceText, "Sensitive source text");

  console.log("storage smoke passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
