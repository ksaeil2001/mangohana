import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSecretProtection,
  rekeySecretProtection,
  securityFromArtifactKey,
  zeroizeProtection
} from "../../src/main/projectProtection";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage";
import { createEmptyProject } from "../../src/shared/projectValidation";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-protection-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("project protection", () => {
  it("creates a 32-byte artifact key and preserves it across container rekey", () => {
    const protection = createSecretProtection("old password", Buffer.alloc(32, 7));
    const rekeyed = rekeySecretProtection(protection, "new password");

    expect(protection.containerKey).toHaveLength(32);
    expect(rekeyed.containerKey).toHaveLength(32);
    expect(rekeyed.containerKey.equals(protection.containerKey)).toBe(false);
    expect(rekeyed.artifactMasterKey.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(securityFromArtifactKey(rekeyed.artifactMasterKey)).toEqual({
      artifactKeyVersion: 1,
      artifactMasterKeyB64: Buffer.alloc(32, 7).toString("base64")
    });
  });

  it("zeroizes container, salt, artifact key, and password buffers on close", () => {
    const protection = createSecretProtection("close me", Buffer.alloc(32, 9));
    const buffers = [
      protection.containerKey,
      protection.containerSalt,
      protection.artifactMasterKey,
      protection.passwordBytes
    ];

    zeroizeProtection(protection);

    for (const buffer of buffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("upgrades the checked-in secret v1 fixture and preserves its artifact key across Save As and rekey", async () => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "projects", "secret-v1.ctp");
    const fixtureBefore = await readFile(fixturePath, "utf8");
    const loaded = await loadProjectFile({ filePath: fixturePath, password: "fixture-password" });
    expect(loaded).toMatchObject({
      encrypted: true,
      artifactKeyPersisted: false,
      project: {
        schemaVersion: 2,
        metadata: { id: "fixture-secret-v1", secret: true },
        dialogueLines: [{ id: "legacy-secret-line", origin: { kind: "manual" } }]
      }
    });
    expect(loaded.security).toBeUndefined();
    expect(loaded.protection).toBeDefined();

    const artifactKey = Buffer.from(loaded.protection!.artifactMasterKey);
    const manager = createProjectSessionManager();
    const opened = manager.createProjectSession({
      project: loaded.project,
      filePath: fixturePath,
      protection: loaded.protection,
      security: loaded.security,
      artifactKeyPersisted: loaded.artifactKeyPersisted
    });
    const saveAsPath = join(tempDir, "secret-upgraded.ctp");

    await manager.saveProjectAs({
      projectSessionId: opened.projectSessionId,
      filePath: saveAsPath
    });
    const upgraded = await loadProjectFile({ filePath: saveAsPath, password: "fixture-password" });
    expect(upgraded.artifactKeyPersisted).toBe(true);
    expect(upgraded.protection?.artifactMasterKey.equals(artifactKey)).toBe(true);
    expect(await readFile(saveAsPath, "utf8")).not.toContain("Secret v1 fixture");
    zeroizeProtection(upgraded.protection!);

    await manager.rekeyProject({
      projectSessionId: opened.projectSessionId,
      newPassword: "fixture-password-rekeyed"
    });
    await expect(loadProjectFile({ filePath: saveAsPath, password: "fixture-password" })).rejects.toThrow(
      /password/i
    );
    const rekeyed = await loadProjectFile({
      filePath: saveAsPath,
      password: "fixture-password-rekeyed"
    });
    expect(rekeyed.protection?.artifactMasterKey.equals(artifactKey)).toBe(true);
    zeroizeProtection(rekeyed.protection!);

    await manager.closeProject({ projectSessionId: opened.projectSessionId });
    artifactKey.fill(0);
    expect(await readFile(fixturePath, "utf8")).toBe(fixtureBefore);
  });

  it("keeps the existing ctp valid when user Save persistence is injected to fail", async () => {
    const filePath = join(tempDir, "save-failure.ctp");
    const persisted = createEmptyProject("Persisted", false);
    await saveProjectFile({ filePath, project: persisted });
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        throw new Error("injected Save failure");
      }
    });
    const session = manager.createProjectSession({ project: persisted, filePath });
    await manager.applyProjectMutation({
      projectSessionId: session.projectSessionId,
      baseRevision: 0,
      mutation: { type: "set_project_title", title: "Unsaved" }
    });

    await expect(manager.saveProject({
      projectSessionId: session.projectSessionId
    })).rejects.toThrow(/injected Save failure/);
    await expect(loadProjectFile({ filePath })).resolves.toMatchObject({
      project: { metadata: { title: "Persisted" } }
    });
  });

  it("keeps an existing Save As target valid when persistence is injected to fail", async () => {
    const targetPath = join(tempDir, "save-as-failure.ctp");
    await saveProjectFile({
      filePath: targetPath,
      project: createEmptyProject("Existing target", false)
    });
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        throw new Error("injected Save As failure");
      }
    });
    const session = manager.createProjectSession({
      project: createEmptyProject("Replacement", false)
    });

    await expect(manager.saveProjectAs({
      projectSessionId: session.projectSessionId,
      filePath: targetPath
    })).rejects.toThrow(/injected Save As failure/);
    await expect(loadProjectFile({ filePath: targetPath })).resolves.toMatchObject({
      project: { metadata: { title: "Existing target" } }
    });
  });

  it("keeps the old secret container valid when rekey persistence is injected to fail", async () => {
    const filePath = join(tempDir, "rekey-failure.ctp");
    await saveProjectFile({
      filePath,
      project: createEmptyProject("Existing secret", true),
      password: "old container password"
    });
    const loaded = await loadProjectFile({
      filePath,
      password: "old container password"
    });
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        throw new Error("injected Rekey failure");
      }
    });
    const session = manager.createProjectSession({
      project: loaded.project,
      filePath,
      protection: loaded.protection,
      security: loaded.security,
      artifactKeyPersisted: loaded.artifactKeyPersisted
    });

    await expect(manager.rekeyProject({
      projectSessionId: session.projectSessionId,
      newPassword: "new container password"
    })).rejects.toThrow(/injected Rekey failure/);
    const reopened = await loadProjectFile({
      filePath,
      password: "old container password"
    });
    expect(reopened.project.metadata.title).toBe("Existing secret");
    zeroizeProtection(reopened.protection!);
    await expect(loadProjectFile({
      filePath,
      password: "new container password"
    })).rejects.toThrow(/password/i);
    await manager.closeProject({ projectSessionId: session.projectSessionId });
  });
});
