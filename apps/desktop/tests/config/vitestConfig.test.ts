import { describe, expect, it } from "vitest";

import config from "../../vite.config";

describe("Vitest collection scope", () => {
  it("excludes nested worktrees without discarding Vitest defaults", () => {
    const exclude = config.test?.exclude ?? [];

    expect(exclude).toEqual(
      expect.arrayContaining(["**/.worktrees/**", "**/node_modules/**"])
    );
  });
});
