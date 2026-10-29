import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResourceBindingV1 } from "../../resourcePreflight.js";
import { PRODUCTION_OCR_CONTRACT } from "../../../shared/productionOcr.js";
import { parseProductionOcrRuntimeManifest } from "../../../shared/productionOcrResource.js";

export type ProductionOcrRuntimeBinding = Readonly<{
  packRoot: string;
  pythonExecutable: string;
  sidecarEntrypoint: string;
}>;

export async function probeProductionOcrResource(
  binding: ResourceBindingV1
): Promise<ProductionOcrRuntimeBinding> {
  if (binding.role !== PRODUCTION_OCR_CONTRACT.resourceRole || process.platform !== "win32") {
    throw new Error("Production OCR resource is incompatible");
  }

  const packRoot = resolve(binding.absolutePath);
  let manifest;
  try {
    const bytes = await readFile(resolve(packRoot, "production-ocr-runtime.json"));
    manifest = parseProductionOcrRuntimeManifest(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("Production OCR resource is incompatible");
  }

  const requiredPaths = [
    manifest.pythonExecutable,
    manifest.sidecarEntrypoint,
    ...PRODUCTION_OCR_CONTRACT.detector.files,
    ...PRODUCTION_OCR_CONTRACT.recognizer.files
  ];
  try {
    await Promise.all(requiredPaths.map((relativePath) => access(resolve(packRoot, ...relativePath.split("/")))));
  } catch {
    throw new Error("Production OCR resource is incomplete");
  }

  return {
    packRoot,
    pythonExecutable: resolve(packRoot, ...manifest.pythonExecutable.split("/")),
    sidecarEntrypoint: resolve(packRoot, ...manifest.sidecarEntrypoint.split("/"))
  };
}
