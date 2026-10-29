import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

type PackageJson = {
  productName?: string;
  version?: string;
  build?: {
    appId?: string;
    artifactName?: string;
    publish?: Array<{ provider?: string; owner?: string; repo?: string }>;
    extraResources?: unknown[];
    win?: {
      artifactName?: string;
      icon?: string;
      signtoolOptions?: {
        signingHashAlgorithms?: string[];
        rfc3161TimeStampServer?: string;
      };
    };
    mac?: {
      icon?: string;
      hardenedRuntime?: boolean;
      gatekeeperAssess?: boolean;
      entitlements?: string;
      entitlementsInherit?: string;
      notarize?: boolean;
    };
    linux?: {
      icon?: string;
    };
  };
};

async function readPackage(): Promise<PackageJson> {
  return JSON.parse(
    await readFile(resolve(process.cwd(), "package.json"), "utf8")
  ) as PackageJson;
}

describe("stable packaging signing configuration", () => {
  test("preserves update identity and delivery destination", async () => {
    const packageJson = await readPackage();
    expect(packageJson.version).toBe("0.1.4");
    expect(packageJson.build?.appId).toBe(
      "com.local.character-dialogue-translation-editor"
    );
    expect(packageJson.build?.publish).toEqual([
      {
        provider: "github",
        owner: "ksaeil2001",
        repo: "trio-releases",
        releaseType: "release"
      }
    ]);
    expect(packageJson.build?.extraResources).toEqual(expect.any(Array));
  });

  test("requires Windows signing and retains strict macOS settings only for future scope", async () => {
    const packageJson = await readPackage();
    expect(packageJson.build?.win?.signtoolOptions).toEqual({
      signingHashAlgorithms: ["sha256"],
      rfc3161TimeStampServer: "http://ts.ssl.com"
    });
    expect(packageJson.build?.mac).toEqual({
      icon: "build/icon.icns",
      hardenedRuntime: true,
      gatekeeperAssess: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true
    });
  });

  test("uses the Mangohana Windows icon without changing product identity", async () => {
    const packageJson = await readPackage();
    expect(packageJson.productName).toBe("Trio");
    expect(packageJson.build?.appId).toBe(
      "com.local.character-dialogue-translation-editor"
    );
    expect(packageJson.build?.artifactName).toBe("Trio-${version}.${ext}");
    expect(packageJson.build?.win?.artifactName).toBe(
      "Trio-Setup-${version}.${ext}"
    );
    const windowsIconPath = "build/mangohana-icon.ico";
    expect(packageJson.build?.win?.icon).toBe(windowsIconPath);
    const windowsIcon = await readFile(resolve(process.cwd(), windowsIconPath));
    expect(windowsIcon.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(windowsIcon.readUInt16LE(4)).toBeGreaterThan(0);
    expect(packageJson.build?.mac?.icon).toBe("build/icon.icns");
    expect(packageJson.build?.linux?.icon).toBe("build/icons");
  });
});
