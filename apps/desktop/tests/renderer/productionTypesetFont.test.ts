import { describe, expect, it, vi } from "vitest";
import {
  createProductionTypesetFontLoader,
  ensureProductionTypesetFontLoaded,
  resetProductionTypesetFontLoaderForTests,
  type ProductionTypesetFontDependencies
} from "../../src/renderer/productionTypesetFont";
import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_URL
} from "../../src/shared/productionTypesetFontResource";

type FakeFont = {
  family: string;
  source: string;
  status: "unloaded" | "loaded";
  load: () => Promise<FakeFont>;
};

function createEnvironment(options: { check?: boolean; load?: () => Promise<FakeFont> } = {}) {
  const addedFonts: FakeFont[] = [];
  const fonts = {
    add: vi.fn((font: FakeFont) => {
      addedFonts.push(font);
    }),
    check: vi.fn(() => options.check ?? true)
  };
  const FontFace = vi.fn(function FakeFontFace(this: FakeFont, family: string, source: string) {
    this.family = family;
    this.source = source;
    this.status = "unloaded";
    this.load = options.load ?? (async () => {
      this.status = "loaded";
      return this;
    });
  });
  const dependencies: ProductionTypesetFontDependencies = {
    FontFace: FontFace as unknown as NonNullable<ProductionTypesetFontDependencies["FontFace"]>,
    document: { fonts } as unknown as Document
  };
  return { dependencies, FontFace, fonts, addedFonts };
}

describe("production typeset font loader", () => {
  it("loads the fixed Main-owned URL and adds only the loaded face", async () => {
    const environment = createEnvironment();
    const loader = createProductionTypesetFontLoader(environment.dependencies);

    await expect(loader()).resolves.toBe(true);

    expect(environment.FontFace).toHaveBeenCalledWith(
      PRODUCTION_TYPESET_FONT_CSS_FAMILY,
      `url(${PRODUCTION_TYPESET_FONT_URL})`
    );
    expect(environment.fonts.add).toHaveBeenCalledOnce();
    expect(environment.addedFonts[0]?.status).toBe("loaded");
    expect(environment.fonts.check).toHaveBeenCalledWith(
      `16px "${PRODUCTION_TYPESET_FONT_CSS_FAMILY}"`,
      "한"
    );
  });

  it("caches successful in-flight and completed work", async () => {
    const environment = createEnvironment();
    const loader = createProductionTypesetFontLoader(environment.dependencies);

    const first = loader();
    const second = loader();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    await expect(loader()).resolves.toBe(true);
    expect(environment.FontFace).toHaveBeenCalledOnce();
    expect(environment.fonts.add).toHaveBeenCalledOnce();
  });

  it("returns false without throwing when the face cannot load", async () => {
    const environment = createEnvironment({
      load: async () => {
        throw new Error("font load failed");
      }
    });
    const loader = createProductionTypesetFontLoader(environment.dependencies);

    await expect(loader()).resolves.toBe(false);
    expect(environment.fonts.add).not.toHaveBeenCalled();
  });

  it("returns false when the post-load font check fails", async () => {
    const environment = createEnvironment({ check: false });
    const loader = createProductionTypesetFontLoader(environment.dependencies);

    await expect(loader()).resolves.toBe(false);
    expect(environment.fonts.add).toHaveBeenCalledOnce();
  });

  it("returns false when FontFace or document fonts are unavailable", async () => {
    await expect(createProductionTypesetFontLoader({ document: { fonts: {} } as unknown as Document })()).resolves.toBe(false);
    await expect(createProductionTypesetFontLoader({ FontFace: undefined, document: { fonts: {} } as unknown as Document })()).resolves.toBe(false);
  });

  it("returns false when accessing the document font set throws", async () => {
    const environment = createEnvironment();
    const throwingDocument = {} as Document;
    Object.defineProperty(throwingDocument, "fonts", {
      configurable: true,
      get: () => {
        throw new Error("font set unavailable");
      }
    });

    await expect(createProductionTypesetFontLoader({
      FontFace: environment.dependencies.FontFace,
      document: throwingDocument
    })()).resolves.toBe(false);
  });

  it("returns false when global FontFace discovery throws", async () => {
    const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      get: () => {
        throw new Error("FontFace unavailable");
      }
    });
    resetProductionTypesetFontLoaderForTests();

    try {
      await expect(ensureProductionTypesetFontLoaded()).resolves.toBe(false);
    } finally {
      if (originalFontFace) Object.defineProperty(globalThis, "FontFace", originalFontFace);
      else Reflect.deleteProperty(globalThis, "FontFace");
      resetProductionTypesetFontLoaderForTests();
    }
  });

  it("returns false when global document discovery throws", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      get: () => {
        throw new Error("document unavailable");
      }
    });
    resetProductionTypesetFontLoaderForTests();

    try {
      await expect(ensureProductionTypesetFontLoaded()).resolves.toBe(false);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      resetProductionTypesetFontLoaderForTests();
    }
  });
});
