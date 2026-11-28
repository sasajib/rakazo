import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { observedPiStream } from "./pi-usage.js";

/**
 * Fork (1.38): the request each provider adapter really sends carries no image the provider
 * would refuse. The request body is read from the fetch the real Pi adapters make.
 */
const models: Array<Model<Api>> = (
  [
    ["anthropic", "anthropic-messages", "https://anthropic.example.test"],
    ["openrouter", "openai-completions", "https://openrouter.example.test/v1"],
    ["openai", "openai-responses", "https://openai.example.test/v1"],
  ] as const
).map(([provider, api, baseUrl]) => ({
  provider,
  id: "fixture-vision",
  api,
  name: "fixture",
  baseUrl,
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 256,
}));

async function png(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return bytes.toString("base64");
}

async function sentBody(model: Model<Api>, context: Context): Promise<string> {
  let body = "";
  const stream = await observedPiStream(
    builtinModels(),
    model,
    context,
    {
      apiKey: "test-key",
      fetch: async (_input: unknown, init?: { body?: unknown }) => {
        body = String(init?.body ?? "");
        // The reply does not matter: the request is what is under test.
        return new Response(JSON.stringify({ error: { message: "stop here" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    } as never,
    () => undefined,
  );
  for await (const _event of stream) {
    /* drain */
  }
  await stream.result().catch(() => undefined);
  return body;
}

const previous = process.env.MODEL_IMAGE_GUARD;
afterEach(() => {
  if (previous === undefined) delete process.env.MODEL_IMAGE_GUARD;
  else process.env.MODEL_IMAGE_GUARD = previous;
});

describe.each(models)("a model request through $api", (model) => {
  it("leaves out an empty, a corrupt and an oversized image and keeps the good one", async () => {
    delete process.env.MODEL_IMAGE_GUARD;
    const good = await png(48, 32);
    const tall = await png(900, 8600);
    const corrupt = Buffer.from("these bytes are not a picture").toString("base64");
    const context = {
      systemPrompt: "Fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at these" },
            { type: "image", data: "", mimeType: "image/png" },
            { type: "image", data: corrupt, mimeType: "image/jpeg" },
            { type: "image", data: tall, mimeType: "image/png" },
            { type: "image", data: good, mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    } as unknown as Context;

    const body = await sentBody(model, context);
    expect(body).toContain("look at these");
    expect(body).toContain(good);
    expect(body).not.toContain(tall);
    expect(body).not.toContain(corrupt);
    expect(body).toContain("image left out: it was empty");
    expect(body).toContain("image left out: it was not a readable PNG, JPEG, GIF or WebP");
    expect(body).toContain("image left out: it was 900x8600 pixels");
    // No image entry with empty data, in either wire shape.
    expect(body).not.toMatch(/"data":""/);
    expect(body).not.toMatch(/base64,"/);
  });

  it("MODEL_IMAGE_GUARD=0 sends what it was given (the old behaviour)", async () => {
    process.env.MODEL_IMAGE_GUARD = "0";
    const tall = await png(900, 8600);
    const context = {
      systemPrompt: "Fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: tall, mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    } as unknown as Context;
    const body = await sentBody(model, context);
    expect(body).toContain(tall);
    expect(body).not.toContain("image left out");
  });
});
