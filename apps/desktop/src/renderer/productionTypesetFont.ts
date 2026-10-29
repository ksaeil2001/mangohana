import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_URL
} from "../shared/productionTypesetFontResource.js";

type ProductionFontFace = {
  load: () => Promise<ProductionFontFace>;
  status?: string;
};

type ProductionFontFaceConstructor = new (
  family: string,
  source: string
) => ProductionFontFace;

type ProductionFontSet = {
  add?: (font: ProductionFontFace) => void;
  check?: (font: string, text?: string) => boolean;
};

/**
 * Renderer-only dependency seam. Production callers do not pass this value;
 * tests use it to provide deterministic FontFace and FontFaceSet doubles.
 */
export type ProductionTypesetFontDependencies = {
  document?: Document;
  FontFace?: ProductionFontFaceConstructor;
};

let defaultLoadPromise: Promise<boolean> | null = null;
let injectedLoaders = new WeakMap<object, () => Promise<boolean>>();

/**
 * Creates a cached loader for the fixed Main-owned production font resource.
 * A failed load is not cached so a later export can retry after a transient
 * resource or document-fonts failure.
 */
export function createProductionTypesetFontLoader(
  dependencies: ProductionTypesetFontDependencies = {}
): () => Promise<boolean> {
  let loadPromise: Promise<boolean> | null = null;

  return () => {
    if (loadPromise) return loadPromise;

    const load = loadProductionTypesetFont(dependencies).then((loaded) => {
      if (!loaded) loadPromise = null;
      return loaded;
    });
    loadPromise = load;
    return load;
  };
}

/**
 * Loads the packaged Pretendard resource through the fixed Main-owned
 * protocol URL. Renderer code cannot select a path, publisher or resource
 * root. The optional dependency seam is intentionally only for unit tests.
 */
export function ensureProductionTypesetFontLoaded(
  dependencies?: ProductionTypesetFontDependencies
): Promise<boolean> {
  if (dependencies) {
    const cacheKey = dependencies as object;
    let loader = injectedLoaders.get(cacheKey);
    if (!loader) {
      loader = createProductionTypesetFontLoader(dependencies);
      injectedLoaders.set(cacheKey, loader);
    }
    return loader();
  }
  if (!defaultLoadPromise) {
    defaultLoadPromise = loadProductionTypesetFont({}).then((loaded) => {
      if (!loaded) defaultLoadPromise = null;
      return loaded;
    });
  }
  return defaultLoadPromise;
}

/**
 * Test-only reset for the module-level production cache. It is not used by
 * production application code; the real app keeps the successful face for
 * the lifetime of the renderer session.
 */
export function resetProductionTypesetFontLoaderForTests(): void {
  defaultLoadPromise = null;
  injectedLoaders = new WeakMap<object, () => Promise<boolean>>();
}

async function loadProductionTypesetFont(
  dependencies: ProductionTypesetFontDependencies
): Promise<boolean> {
  try {
    const targetDocument = dependencies.document ?? getGlobalDocument();
    const FontFaceConstructor = dependencies.FontFace ?? getGlobalFontFaceConstructor();
    if (!targetDocument || !FontFaceConstructor) return false;

    const fontSet = targetDocument.fonts as unknown as ProductionFontSet | undefined;
    if (!fontSet?.add || !fontSet.check) return false;

    const face = new FontFaceConstructor(
      PRODUCTION_TYPESET_FONT_CSS_FAMILY,
      `url(${PRODUCTION_TYPESET_FONT_URL})`
    );
    const loadedFace = await face.load();
    if (!loadedFace || loadedFace.status !== "loaded") return false;

    fontSet.add(loadedFace);
    return fontSet.check(
      `16px "${PRODUCTION_TYPESET_FONT_CSS_FAMILY}"`,
      "한"
    );
  } catch {
    return false;
  }
}

function getGlobalDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function getGlobalFontFaceConstructor(): ProductionFontFaceConstructor | undefined {
  return typeof FontFace === "undefined"
    ? undefined
    : FontFace as unknown as ProductionFontFaceConstructor;
}
