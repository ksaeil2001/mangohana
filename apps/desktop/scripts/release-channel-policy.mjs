import { appendFile } from "node:fs/promises";

const stableTagPattern = /^v\d+\.\d+\.\d+$/;
const previewTagPattern = /^v\d+\.\d+\.\d+-(?:preview|dev)\.\d+$/;
const transitionTagPattern = /^v\d+\.\d+\.\d+-transition\.\d+$/;

export function classifyReleaseTag(tag) {
  if (stableTagPattern.test(tag)) {
    return { channel: "stable", tag };
  }

  if (previewTagPattern.test(tag)) {
    return { channel: "preview", tag };
  }

  if (transitionTagPattern.test(tag)) {
    return { channel: "transition", tag };
  }

  throw new Error(
    `Unsupported release tag "${tag}". Use vX.Y.Z for stable, vX.Y.Z-preview.N / vX.Y.Z-dev.N for preview releases, or vX.Y.Z-transition.N for private transition QA.`
  );
}

export function assertReleaseChannelPolicy(tag) {
  const release = classifyReleaseTag(tag);

  if (release.channel === "stable") {
    throw new Error(
      "Stable releases are blocked until the Windows cloud-signing integration signs and verifies the NSIS installer. Use a preview/dev tag for unsigned QA builds."
    );
  }

  return release;
}

async function main() {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;

  if (!tag) {
    throw new Error("Missing required --tag argument.");
  }

  const release = classifyReleaseTag(tag);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `release_channel=${release.channel}\n`);
  }

  console.log(`Release tag ${release.tag} is classified as ${release.channel}.`);
  assertReleaseChannelPolicy(tag);
  console.log("Release channel policy passed.");
}

if (process.argv[1]?.endsWith("release-channel-policy.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
