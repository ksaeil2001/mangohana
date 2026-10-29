import { createLinkedAbortController, isAbortError } from "./abortSignals.js";

export type LocalInpaintingProvider = "local-lama" | "local-aot" | "sd-webui" | "comfyui";

export type LocalInpaintingArgs = {
  imageBytes: Buffer;
  maskBytes: Buffer;
  provider: LocalInpaintingProvider;
  prompt?: string;
  endpoint?: string;
  signal?: AbortSignal;
};

const DEFAULT_ENDPOINTS: Record<LocalInpaintingProvider, string> = {
  "local-lama": "http://localhost:8080/inpaint",
  "local-aot": "http://localhost:8080/inpaint",
  "sd-webui": "http://localhost:7860/sdapi/v1/img2img",
  "comfyui": "http://localhost:8188/prompt"
};

function normalizeLocalInpaintingUrl(endpoint: string | undefined, provider: LocalInpaintingProvider): string {
  const trimmed = endpoint?.trim();
  if (!trimmed) return DEFAULT_ENDPOINTS[provider];
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export async function editImageWithLocalInpainting(
  args: LocalInpaintingArgs
): Promise<Buffer> {
  const url = normalizeLocalInpaintingUrl(args.endpoint, args.provider);
  const linked = createLinkedAbortController(args.signal, 60000);

  const imageBase64 = args.imageBytes.toString("base64");
  const maskBase64 = args.maskBytes.toString("base64");

  try {
    if (args.provider === "sd-webui") {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: linked.signal,
        body: JSON.stringify({
          init_images: [`data:image/png;base64,${imageBase64}`],
          mask: `data:image/png;base64,${maskBase64}`,
          prompt: args.prompt || "clean background, masterpiece, best quality",
          negative_prompt: "text, watermark, low quality, artifacts",
          sampler_name: "Euler a",
          steps: 20,
          cfg_scale: 7,
          inpainting_fill: 1, // Original fill
          inpaint_full_res: false,
          inpaint_full_res_padding: 32,
          mask_blur: 4
        })
      });

      if (!response.ok) {
        const err = typeof response.text === "function" ? await response.text().catch(() => "") : "";
        throw new Error(`SD WebUI 응답 실패 (HTTP ${response.status}): ${err || response.statusText}`);
      }

      const data = (await response.json()) as { images?: string[] };
      if (!data.images || data.images.length === 0 || !data.images[0]) {
        throw new Error("SD WebUI에서 인페인팅 결과 이미지를 반환하지 않았습니다.");
      }

      const cleanBase64 = data.images[0].replace(/^data:image\/\w+;base64,/, "");
      return Buffer.from(cleanBase64, "base64");
    } else {
      // Local LaMa / Generic Local Inpainting API
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: linked.signal,
        body: JSON.stringify({
          image: imageBase64,
          mask: maskBase64
        })
      });

      if (!response.ok) {
        const err = typeof response.text === "function" ? await response.text().catch(() => "") : "";
        throw new Error(`로컬 인페인팅 서버 오류 (HTTP ${response.status}): ${err || response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("image/")) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      const data = (await response.json()) as { result?: string; image?: string };
      const rawBase64 = data.result || data.image;
      if (!rawBase64) {
        throw new Error("로컬 인페인팅 응답에 이미지 데이터가 없습니다.");
      }
      return Buffer.from(rawBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    }
  } catch (error) {
    if (isAbortError(error) && args.signal?.aborted) throw args.signal.reason ?? error;
    if (isAbortError(error) && linked.didTimeOut()) {
      throw new Error("로컬 인페인팅 생성 요청 시간이 초과되었습니다 (60초).");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`로컬 인페인팅 실패: ${message}`);
  } finally {
    linked.dispose();
  }
}
