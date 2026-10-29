import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProductionOcrSidecarTransport } from "../../src/main/ocr/runtime/productionOcrSidecarTransport.js";

describe("Production OCR persistent sidecar transport", () => {
  it("starts the pinned local runtime with no shell and resolves a split NDJSON response", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn().mockReturnValue(child);
    const transport = new ProductionOcrSidecarTransport({
      packRoot: "C:\\trusted\\ocr-pack",
      pythonExecutable: "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      sidecarEntrypoint: "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py"
    }, { spawnProcess });

    child.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8"));
      expect(request).toMatchObject({ protocolVersion: 1, operation: "recognize", imageBase64: "Y3JvcA==" });
      const response = `${JSON.stringify({ requestId: request.requestId, operation: "recognize", text: "HELLO" })}\n`;
      child.stdout.write(response.slice(0, 12));
      child.stdout.write(response.slice(12));
    });

    await expect(transport.invoke({
      protocolVersion: 1,
      operation: "recognize",
      imageBase64: "Y3JvcA=="
    })).resolves.toEqual({ operation: "recognize", text: "HELLO" });

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      ["-I", "-X", "utf8", "-B", "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py", "--pack-root", "C:\\trusted\\ocr-pack"],
      expect.objectContaining({
        cwd: "C:\\trusted\\ocr-pack",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: expect.objectContaining({
          PYTHONDONTWRITEBYTECODE: "1"
        })
      })
    );
    transport.close();
  });

  it.each(["HELLO WORLD", "안녕하세요", "こんにちは", "日本語 English 한국어", "😀𠮷"])(
    "preserves UTF-8 response %s across single-byte chunks", async (text) => {
    const child = fakeChild();
    const transport = new ProductionOcrSidecarTransport({
      packRoot: "C:\\trusted\\ocr-pack",
      pythonExecutable: "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      sidecarEntrypoint: "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py"
    }, { spawnProcess: vi.fn().mockReturnValue(child) });

    child.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8"));
      const response = Buffer.from(`${JSON.stringify({
        requestId: request.requestId,
        operation: "recognize",
        text
      })}\n`, "utf8");
      for (const byte of response) child.stdout.write(Buffer.from([byte]));
    });

    await expect(transport.invoke({
      protocolVersion: 1,
      operation: "recognize",
      imageBase64: "Y3JvcA=="
    })).resolves.toEqual({ operation: "recognize", text });
    transport.close();
  });

  it("preserves split UTF-8 stderr in worker failure diagnostics", async () => {
    const child = fakeChild();
    const transport = new ProductionOcrSidecarTransport({
      packRoot: "C:\\trusted\\ocr-pack",
      pythonExecutable: "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      sidecarEntrypoint: "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py"
    }, { spawnProcess: vi.fn().mockReturnValue(child) });
    const pending = transport.invoke({ operation: "recognize" });
    const diagnostic = "日本語 오류 😀";
    for (const byte of Buffer.from(diagnostic, "utf8")) child.stderr.write(Buffer.from([byte]));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(diagnostic);
    transport.close();
  });

  it("discards incomplete Unicode and late events from a stopped worker before reuse", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const transport = new ProductionOcrSidecarTransport({
      packRoot: "C:\\trusted\\ocr-pack",
      pythonExecutable: "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      sidecarEntrypoint: "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py"
    }, { spawnProcess: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    const controller = new AbortController();
    const abandoned = transport.invoke({ operation: "recognize" }, controller.signal);
    first.stdout.write(Buffer.from("こ").subarray(0, 1));
    first.stderr.write(Buffer.from("古い診断こ").subarray(0, -1));
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    const pending = transport.invoke({ operation: "recognize" });
    first.stdout.write(Buffer.from("こ").subarray(1));
    first.stderr.write("stale diagnostic");
    first.emit("error", new Error("late worker error"));
    first.emit("exit", 1, null);
    second.stderr.write("current diagnostic");
    second.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("none): current diagnostic");
    transport.close();
  });

  it("kills the worker and rejects instead of returning stale output when aborted", async () => {
    const child = fakeChild();
    const transport = new ProductionOcrSidecarTransport({
      packRoot: "C:\\trusted\\ocr-pack",
      pythonExecutable: "C:\\trusted\\ocr-pack\\runtime\\python.exe",
      sidecarEntrypoint: "C:\\trusted\\ocr-pack\\sidecar\\trio_ocr_sidecar.py"
    }, { spawnProcess: vi.fn().mockReturnValue(child) });
    const controller = new AbortController();

    const pending = transport.invoke({ protocolVersion: 1, operation: "detect", imageBase64: "aW1hZ2U=" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn().mockReturnValue(true);
  return child;
}
