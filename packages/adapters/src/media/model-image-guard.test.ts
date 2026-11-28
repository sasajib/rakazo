import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitMcpResultImages } from "../mcp/mcp-result-images.js";
import {
  guardImageParts,
  guardModelImages,
  modelImageProblem,
  modelImageSize,
  unusableImageNote,
} from "./model-image-guard.js";

/** Fork (1.38): an image a provider would refuse never reaches a model request. */
async function png(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
  return bytes.toString("base64");
}
const image = (data: string, mimeType: "image/png" | "image/jpeg" = "image/png") => ({
  type: "image" as const,
  data,
  mimeType,
});
const text = (value: string) => ({ type: "text" as const, text: value });

let sink: ReturnType<typeof createTestSink>;
let previous: string | undefined;
beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
  previous = process.env.MODEL_IMAGE_GUARD;
  delete process.env.MODEL_IMAGE_GUARD;
});
afterEach(() => {
  if (previous === undefined) delete process.env.MODEL_IMAGE_GUARD;
  else process.env.MODEL_IMAGE_GUARD = previous;
});
const warnings = () => sink.events.filter((event) => event.message === "model_image.left_out");

describe("what a provider would refuse", () => {
  it("names an empty, an undecodable, a corrupt, a cut-off and an oversized image", async () => {
    const good = await png(40, 30);
    expect(modelImageProblem({ data: good })).toBeUndefined();
    expect(modelImageSize(good)).toEqual({ width: 40, height: 30 });
    expect(modelImageProblem({ data: "" })).toEqual({ reason: "empty" });
    expect(modelImageProblem({ data: "   " })).toEqual({ reason: "empty" });
    expect(modelImageProblem({})).toEqual({ reason: "empty" });
    expect(modelImageProblem({ data: "not base64 !!" })).toEqual({ reason: "undecodable" });
    // Valid base64 of bytes that are no picture.
    expect(
      modelImageProblem({ data: Buffer.from("corrupt bytes, no image").toString("base64") }),
    ).toEqual({ reason: "unsupported_format" });
    // A PNG with a good header that stops before its end.
    const cut = Buffer.from(good, "base64").subarray(0, 60).toString("base64");
    expect(modelImageProblem({ data: cut })).toEqual({ reason: "truncated" });
    // The live case: a page export taller than a provider takes.
    const tall = await png(1200, 9000);
    expect(modelImageProblem({ data: tall })).toEqual({
      reason: "oversized_dimensions",
      width: 1200,
      height: 9000,
      maxSide: 8000,
    });
    expect(modelImageProblem({ data: await png(1200, 3000) })).toBeUndefined();
    expect(modelImageProblem({ data: await png(1200, 3000) }, 2000)).toMatchObject({
      reason: "oversized_dimensions",
    });
    expect(modelImageProblem({ data: "A".repeat(5 * 1024 * 1024 + 4) })).toEqual({
      reason: "oversized_bytes",
    });
  });
});

describe("the request guard", () => {
  it("replaces each bad image by a note, in a user message and in a tool result, and keeps the good ones", async () => {
    const good = image(await png(40, 30));
    const tall = image(await png(1200, 9000));
    const context = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: [text("look"), image(""), good] },
        { role: "assistant", content: [text("ok")] },
        { role: "toolResult", toolCallId: "t1", content: [text("{}"), tall] },
        { role: "user", content: "plain text" },
        {
          role: "toolResult",
          toolCallId: "t2",
          content: [image(Buffer.from("garbage").toString("base64"), "image/jpeg")],
        },
      ],
    };
    const before = JSON.stringify(context);
    const guarded = guardModelImages(context, { "run.id": "run-1" });

    expect(JSON.stringify(context)).toBe(before);
    expect(guarded.systemPrompt).toBe("s");
    const [user, assistant, tool, plain, corrupt] = guarded.messages as Array<{ content: unknown }>;
    expect(user!.content).toEqual([
      text("look"),
      text(
        "[image left out: it was empty. To look at it, make a smaller or valid copy and read that.]",
      ),
      good,
    ]);
    expect(assistant).toBe(context.messages[1]);
    expect(plain).toBe(context.messages[3]);
    expect((tool!.content as unknown[])[1]).toEqual(
      text(
        "[image left out: it was 1200x9000 pixels, over the 8000 pixel limit per side. To look at it, make a smaller or valid copy and read that.]",
      ),
    );
    expect((corrupt!.content as Array<{ type: string }>)[0]!.type).toBe("text");
    expect(JSON.stringify(guarded)).not.toContain('"type":"image","data":""');

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      "run.id": "run-1",
      "images.left_out": 3,
      "images.new": 3,
      "images.total": 4,
      "images.reasons": { empty: 1, oversized_dimensions: 1, unsupported_format: 1 },
    });
    // The same blocks at the next step of the run: replaced again, not logged again.
    const again = guardModelImages(context, { "run.id": "run-1" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(guarded));
    expect(warnings()).toHaveLength(1);
  });

  it("returns the same object when every image is fine or there is none", async () => {
    const fine = { messages: [{ role: "user", content: [text("x"), image(await png(10, 10))] }] };
    expect(guardModelImages(fine)).toBe(fine);
    const none = { messages: [{ role: "user", content: "hello" }] };
    expect(guardModelImages(none)).toBe(none);
    expect(warnings()).toHaveLength(0);
  });

  it("holds a request with many images to the smaller side limit", async () => {
    const wide = await png(2500, 100);
    const few = { messages: [{ role: "user", content: [image(wide)] }] };
    expect(guardModelImages(few)).toBe(few);
    const small = await png(10, 10);
    const many = {
      messages: [
        { role: "user", content: [image(wide), ...Array.from({ length: 20 }, () => image(small))] },
      ],
    };
    const guarded = guardModelImages(many);
    const parts = (guarded.messages[0] as { content: Array<{ type: string }> }).content;
    expect(parts[0]!.type).toBe("text");
    expect(parts.filter((part) => part.type === "image")).toHaveLength(20);
  });

  it("MODEL_IMAGE_GUARD=0 sends the request as it is", () => {
    process.env.MODEL_IMAGE_GUARD = "0";
    const context = { messages: [{ role: "user", content: [image("")] }] };
    expect(guardModelImages(context)).toBe(context);
    expect(unusableImageNote({ data: "" }, "test")).toBeUndefined();
  });

  it("gives a runtime that passes pictures one by one the note to send instead", async () => {
    expect(unusableImageNote({ data: await png(10, 10) }, "acp_turn")).toBeUndefined();
    expect(unusableImageNote({ data: "" }, "acp_turn")).toContain("image left out: it was empty");
    expect(warnings()[0]).toMatchObject({ "images.origin": "acp_turn", "images.left_out": 1 });
    expect(guardImageParts([text("a")])).toHaveLength(1);
  });
});

describe("an MCP server's picture over the limits", () => {
  it("is scaled down where it enters, so the model still sees it", async () => {
    const tall = image(await png(1200, 9000));
    const small = image(await png(300, 200));
    const [scaled, kept] = await fitMcpResultImages([tall, small]);
    expect(kept).toBe(small);
    expect(scaled).not.toBe(tall);
    const size = modelImageSize(scaled!.data)!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1568);
    expect(modelImageProblem(scaled!, 2000)).toBeUndefined();
  });

  it("leaves one it cannot decode to the request guard", async () => {
    const good = await png(1200, 9000);
    const cut = image(Buffer.from(good, "base64").subarray(0, 200).toString("base64"));
    const [left] = await fitMcpResultImages([cut]);
    expect(left).toBe(cut);
    expect(modelImageProblem(left!)).toBeDefined();
  });
});
