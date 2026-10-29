import { describe, expect, it } from "vitest";
import { assertReleaseChannelPolicy, classifyReleaseTag } from "../../scripts/release-channel-policy.mjs";

describe("release channel policy", () => {
  it("allows versioned preview and dev tags for unsigned QA releases", () => {
    expect(assertReleaseChannelPolicy("v0.1.4-preview.1")).toEqual({
      channel: "preview",
      tag: "v0.1.4-preview.1"
    });
    expect(assertReleaseChannelPolicy("v0.1.4-dev.7")).toEqual({
      channel: "preview",
      tag: "v0.1.4-dev.7"
    });
  });

  it("allows the v0.1.3 transition baseline tag for private QA packaging", () => {
    expect(assertReleaseChannelPolicy("v0.1.3-transition.1")).toEqual({
      channel: "transition",
      tag: "v0.1.3-transition.1"
    });
  });

  it("blocks stable tags until cloud signing is implemented and verified", () => {
    expect(() => assertReleaseChannelPolicy("v0.1.4")).toThrow(
      "Stable releases are blocked until the Windows cloud-signing integration"
    );
  });

  it("rejects ambiguous prerelease tag names", () => {
    expect(() => classifyReleaseTag("v0.1.4-beta.1")).toThrow("Unsupported release tag");
    expect(() => classifyReleaseTag("release-0.1.4")).toThrow("Unsupported release tag");
  });
});
