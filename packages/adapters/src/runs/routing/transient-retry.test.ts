import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { routingConfig } from "./routing-config.js";
import { isTransientRunError, transientRetryDelayMs } from "./transient-retry.js";

describe("transient run retry (fork 1.42)", () => {
  it.each([
    new TransientModelError("provider overloaded"),
    new Error('429 {"error":{"message":"rate limited"}}'),
    new Error("anthropic API error (529): overloaded"),
    new Error('503: {"error":"Service Unavailable"}'),
    new Error("The request timed out"),
    new Error("fetch failed: ECONNRESET"),
  ])("retries %s", (error) => {
    expect(isTransientRunError(error)).toBe(true);
  });

  it.each([
    new ModelAccountError("insufficient credits"),
    new ModelOutputError("empty output"),
    new Error('400 {"type":"error","error":{"type":"invalid_request_error"}}'),
    new Error("401 unauthorized"),
    new Error("tool schema invalid"),
    "a string",
  ])("does not retry %s", (error) => {
    expect(isTransientRunError(error)).toBe(false);
  });

  it("backs off exponentially, capped, with jitter in the upper half", () => {
    const config = routingConfig({});
    expect(transientRetryDelayMs(1, config, () => 1)).toBe(5_000);
    expect(transientRetryDelayMs(2, config, () => 1)).toBe(10_000);
    expect(transientRetryDelayMs(3, config, () => 0)).toBe(10_000);
    expect(transientRetryDelayMs(10, config, () => 1)).toBe(120_000);
  });

  it("is on by default with three repeats; RUN_TRANSIENT_RETRY=0 turns it off", () => {
    expect(routingConfig({})).toMatchObject({ transientRetry: true, transientRetryMax: 3 });
    expect(routingConfig({ RUN_TRANSIENT_RETRY: "0" }).transientRetry).toBe(false);
    expect(routingConfig({ RUN_TRANSIENT_RETRY_MAX: "99" }).transientRetryMax).toBe(10);
  });
});
