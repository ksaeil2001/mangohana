import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeCancelIpc,
  interpretCancelIpcResult
} from "../../src/shared/cancelAcknowledgment.js";

describe("cancelAcknowledgment", () => {
  it("treats canceled: true as a confirmed backend abort", () => {
    expect(interpretCancelIpcResult({ canceled: true })).toEqual({ kind: "confirmed" });
  });

  it("treats canceled: false as already finished or missing the active request", () => {
    expect(interpretCancelIpcResult({ canceled: false })).toEqual({ kind: "not_found_or_already_finished" });
  });

  it("acknowledges resolved cancel IPC without retrying", async () => {
    await expect(acknowledgeCancelIpc(() => Promise.resolve({ canceled: true }))).resolves.toEqual({
      kind: "confirmed"
    });
    await expect(acknowledgeCancelIpc(() => Promise.resolve({ canceled: false }))).resolves.toEqual({
      kind: "not_found_or_already_finished"
    });
  });

  it("treats missing, invalid, or rejected cancel IPC as unconfirmed", async () => {
    expect(interpretCancelIpcResult(undefined)).toEqual({ kind: "unconfirmed" });
    expect(interpretCancelIpcResult({})).toEqual({ kind: "unconfirmed" });
    await expect(acknowledgeCancelIpc(undefined)).resolves.toEqual({ kind: "unconfirmed" });
    await expect(acknowledgeCancelIpc(() => Promise.reject(new Error("transport")))).resolves.toEqual({
      kind: "unconfirmed"
    });
  });

  it("does not retry a rejected cancel IPC", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("transport"));
    await expect(acknowledgeCancelIpc(invoke)).resolves.toEqual({ kind: "unconfirmed" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
