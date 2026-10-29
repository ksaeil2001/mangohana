import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ProductionOcrRuntimeBinding } from "./productionOcrResource.js";

type DataListener = (chunk: Buffer | string) => void;
type ErrorListener = (error: Error) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

type SidecarProcess = {
  stdin: { write: (chunk: string) => boolean };
  stdout: { on: (event: "data", listener: DataListener) => unknown };
  stderr: { on: (event: "data", listener: DataListener) => unknown };
  once: {
    (event: "error", listener: ErrorListener): unknown;
    (event: "exit", listener: ExitListener): unknown;
  };
  kill: () => boolean;
};

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    shell: false;
    windowsHide: true;
    stdio: ["pipe", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
  }
) => SidecarProcess;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanupAbort: () => void;
};

const MAX_RESPONSE_BUFFER_BYTES = 16 * 1024 * 1024;

export class ProductionOcrSidecarTransport {
  private readonly binding: ProductionOcrRuntimeBinding;
  private readonly spawnProcess: SpawnProcess;
  private child: SidecarProcess | undefined;
  private stdoutBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrTail = "";
  private stderrDecoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();

  constructor(binding: ProductionOcrRuntimeBinding, options?: { spawnProcess?: SpawnProcess }) {
    this.binding = { ...binding };
    this.spawnProcess = options?.spawnProcess ?? (spawn as unknown as SpawnProcess);
  }

  async invoke(request: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!isRecord(request)) throw new Error("Invalid Production OCR sidecar request");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const requestId = randomUUID();
    const child = this.ensureStarted();

    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.stopWorker(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        cleanupAbort: () => signal?.removeEventListener("abort", onAbort)
      });
      try {
        child.stdin.write(`${JSON.stringify({ ...request, requestId })}\n`);
      } catch (error) {
        this.rejectRequest(requestId, error);
      }
    });
  }

  close(): void {
    this.stopWorker(new Error("Production OCR sidecar was closed"));
  }

  private ensureStarted(): SidecarProcess {
    if (this.child) return this.child;
    const child = this.spawnProcess(
      this.binding.pythonExecutable,
      ["-I", "-X", "utf8", "-B", this.binding.sidecarEntrypoint, "--pack-root", this.binding.packRoot],
      {
        cwd: this.binding.packRoot,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: sidecarEnvironment(this.binding.pythonExecutable)
      }
    );
    child.stdout.on("data", (chunk) => {
      if (this.child === child) this.consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      const text = typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4_096);
    });
    child.once("error", (error) => {
      if (this.child === child) this.handleWorkerFailure(error);
    });
    child.once("exit", (code, exitSignal) => {
      if (this.child !== child) return;
      this.handleWorkerFailure(new Error(
        `Production OCR sidecar exited (${code ?? "signal"}:${exitSignal ?? "none"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`
      ));
    });
    this.child = child;
    return child;
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RESPONSE_BUFFER_BYTES) {
      this.stopWorker(new Error("Production OCR sidecar response exceeded the size limit"));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        this.stopWorker(new Error("Production OCR sidecar emitted invalid JSON"));
        return;
      }
      if (!isRecord(response) || typeof response.requestId !== "string") {
        this.stopWorker(new Error("Production OCR sidecar response omitted request identity"));
        return;
      }
      const requestId = response.requestId;
      const pending = this.pending.get(requestId);
      if (!pending) continue;
      this.pending.delete(requestId);
      pending.cleanupAbort();
      const { requestId: _requestId, ...payload } = response;
      pending.resolve(payload);
    }
  }

  private rejectRequest(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.cleanupAbort();
    pending.reject(error);
  }

  private handleWorkerFailure(error: unknown): void {
    this.child = undefined;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrTail = "";
    this.stderrDecoder = new StringDecoder("utf8");
    for (const [requestId] of this.pending) this.rejectRequest(requestId, error);
  }

  private stopWorker(error: unknown): void {
    const child = this.child;
    this.child = undefined;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrTail = "";
    this.stderrDecoder = new StringDecoder("utf8");
    if (child) child.kill();
    for (const [requestId] of this.pending) this.rejectRequest(requestId, error);
  }
}

function sidecarEnvironment(pythonExecutable: string): NodeJS.ProcessEnv {
  return {
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: dirname(pythonExecutable),
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
