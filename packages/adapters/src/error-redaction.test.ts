import { describe, expect, it } from "vitest";
import { redactErrorText } from "./error-redaction.js";

describe("redactErrorText", () => {
  it.each([
    ["Bearer token", "request failed: Authorization: Bearer abcDEF123456.xyz", "abcDEF123456"],
    ["bearer without header", "got Bearer sk_live_abcdef123456", "sk_live_abcdef123456"],
    ["email", "no mailbox for shakil.ahmed@example.com today", "shakil.ahmed@example.com"],
    ["url credentials", "GET https://admin:hunter2@db.internal.example/path failed", "hunter2"],
    [
      "url query secret",
      "fetch https://api.example.com/v1/items?api_key=SECRETVALUE1&x=2 -> 500",
      "SECRETVALUE1",
    ],
    ["key=value", "config password=correct-horse-battery missing", "correct-horse-battery"],
    ["json secret", 'body {"access_token":"abc.def.ghi","ok":false}', "abc.def.ghi"],
    [
      "jwt",
      "bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "eyJhbGciOiJIUzI1NiJ9",
    ],
    ["openai style key", "invalid key sk-proj-AbCdEf1234567890", "sk-proj-AbCdEf1234567890"],
    [
      "github token",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
    [
      "long hex",
      "digest 0123456789abcdef0123456789abcdef0123 mismatch",
      "0123456789abcdef0123456789abcdef0123",
    ],
    [
      "opaque token",
      "session Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo mismatch",
      "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo",
    ],
    [
      "sealed value",
      "stored rkz1:AAAABBBBCCCCdddd1234== unreadable",
      "rkz1:AAAABBBBCCCCdddd1234==",
    ],
  ])("removes %s", (_name, input, secret) => {
    const output = redactErrorText(input);
    expect(output).not.toContain(secret);
    expect(output).toMatch(/\[redacted\]|\[email\]/);
  });

  it("removes the run's known secrets wherever they appear", () => {
    expect(redactErrorText("the value hunter2-is-here failed", ["hunter2-is-here"])).toBe(
      "the value [redacted] failed",
    );
  });

  it("keeps an ordinary message readable", () => {
    expect(redactErrorText("HTTP 503 Service Unavailable from api.example.com")).toBe(
      "HTTP 503 Service Unavailable from api.example.com",
    );
  });

  it("cuts to 200 characters after redacting, never in the middle of a secret", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    const input = `${"x ".repeat(95)}${secret} tail`;
    const output = redactErrorText(input);
    expect(output.length).toBeLessThanOrEqual(200);
    expect(output).not.toContain("sk-abc");
    expect(redactErrorText("y".repeat(500)).length).toBe(200);
  });

  it("collapses control characters and whitespace", () => {
    expect(redactErrorText("line one\n\n\tline   two\u0000")).toBe("line one line two");
  });
});
