import { getLogger } from "@rakazo/logging";
import { imageHeaderDimensions } from "./image-dimensions.js";
import { detectImageMimeType } from "./image-mime-type.js";
import { modelImageLeftOutNote } from "./model-image-guard.prompt.js";
import { MODEL_IMAGE_MAX_BASE64_BYTES } from "./tool-result-image.js";

/**
 * Fork (1.38): no picture a provider would refuse reaches a model request.
 *
 * One bad image block fails the whole request with a 400 ("image dimensions exceed max allowed
 * size", "image cannot be empty", "could not process image"), and because the block stays in the
 * conversation, every later step of the run fails the same way. Pictures enter from four places
 * (attachments, screenshots, tool results including MCP servers', replayed history); this checks
 * every image block of the request itself, just before it is sent, whatever its origin, and
 * replaces a bad one with a short note so the run goes on.
 *
 * Checks are by header and length only (no pixel decode), so they are cheap enough for every
 * step and are remembered per block. On unless MODEL_IMAGE_GUARD is "0" (also "false" / "off").
 */
export function modelImageGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.MODEL_IMAGE_GUARD ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/** The longest side every provider in use accepts (Anthropic: 8000 pixels). */
export const MODEL_IMAGE_MAX_SIDE = 8000;
/** A request with more images than this is held to the smaller side limit (Anthropic: 20, 2000). */
export const MODEL_IMAGE_MANY = 20;
export const MODEL_IMAGE_MAX_SIDE_WHEN_MANY = 2000;
/** A side over this is scaled down where a picture enters, which keeps it under both limits. */
export const MODEL_IMAGE_SCALE_ABOVE_SIDE = MODEL_IMAGE_MAX_SIDE_WHEN_MANY;

export type ModelImageProblem =
  | { reason: "empty" | "undecodable" | "unsupported_format" | "truncated" | "oversized_bytes" }
  | { reason: "oversized_dimensions"; width: number; height: number; maxSide: number };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Width and height from the header, whatever the label says; undefined when not readable. */
export function modelImageSize(data: string): { width: number; height: number } | undefined {
  const format = detectImageMimeType(Buffer.from(data.slice(0, 64), "base64"));
  const dimensions = format ? imageHeaderDimensions(data, format) : undefined;
  return dimensions ? { width: dimensions[0], height: dimensions[1] } : undefined;
}

/** Why a provider would refuse this image, or undefined when it can be sent. */
export function modelImageProblem(
  image: { data?: unknown },
  maxSide: number = MODEL_IMAGE_MAX_SIDE,
): ModelImageProblem | undefined {
  const data = typeof image.data === "string" ? image.data.trim() : "";
  if (!data) return { reason: "empty" };
  if (data.length % 4 === 1 || !BASE64.test(data)) return { reason: "undecodable" };
  if (data.length > MODEL_IMAGE_MAX_BASE64_BYTES) return { reason: "oversized_bytes" };
  const format = detectImageMimeType(Buffer.from(data.slice(0, 64), "base64"));
  if (!format) return { reason: "unsupported_format" };
  // A PNG ends with its IEND chunk; one cut off in transfer has a valid header and no end.
  if (format === "image/png" && !Buffer.from(data.slice(-64), "base64").includes("IEND"))
    return { reason: "truncated" };
  const dimensions = imageHeaderDimensions(data, format);
  // A header this code cannot size is left to the provider: it may still be a good picture.
  if (!dimensions) return undefined;
  const [width, height] = dimensions;
  return width > maxSide || height > maxSide
    ? { reason: "oversized_dimensions", width, height, maxSide }
    : undefined;
}

function isImageBlock(part: unknown): part is { type: "image"; data?: unknown } {
  return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "image";
}

type Verdict = { problem: ModelImageProblem | undefined };
/** Blocks already reported, so a picture that stays in the conversation is logged once. */
const reported = new WeakSet<object>();
const strict = new WeakMap<object, Verdict>();
const relaxed = new WeakMap<object, Verdict>();

function verdict(block: { data?: unknown }, many: boolean): ModelImageProblem | undefined {
  const cache = many ? strict : relaxed;
  const known = cache.get(block);
  if (known) return known.problem;
  const problem = modelImageProblem(
    block,
    many ? MODEL_IMAGE_MAX_SIDE_WHEN_MANY : MODEL_IMAGE_MAX_SIDE,
  );
  cache.set(block, { problem });
  return problem;
}

/**
 * The same content parts with every image a provider would refuse replaced by a text note.
 * `many` applies the smaller side limit of a request that carries many images. The input is not
 * changed; an array with nothing to replace comes back as it is.
 */
export function guardImageParts<T>(
  parts: readonly T[],
  many = false,
  count?: (problem: ModelImageProblem, first: boolean) => void,
): readonly T[] {
  let changed = false;
  const out = parts.map((part) => {
    if (!isImageBlock(part)) return part;
    const problem = verdict(part, many);
    if (!problem) return part;
    changed = true;
    count?.(problem, !reported.has(part));
    reported.add(part);
    return { type: "text", text: modelImageLeftOutNote(problem) } as unknown as T;
  });
  return changed ? out : parts;
}

/**
 * A model request's context with every unusable image block replaced by a note, and one warn
 * line saying how many and why (never the image). A context with nothing to replace comes back
 * as the same object.
 */
export function guardModelImages<C extends { messages: readonly unknown[] }>(
  context: C,
  log: Record<string, unknown> = {},
): C {
  if (!modelImageGuardEnabled()) return context;
  const contents = context.messages.map((message) => (message as { content?: unknown })?.content);
  let images = 0;
  for (const content of contents)
    if (Array.isArray(content)) for (const part of content) if (isImageBlock(part)) images += 1;
  if (images === 0) return context;
  const many = images > MODEL_IMAGE_MANY;
  const reasons: Record<string, number> = {};
  let dropped = 0;
  let fresh = 0;
  const messages = context.messages.map((message, index) => {
    const content = contents[index];
    if (!Array.isArray(content)) return message;
    const guarded = guardImageParts(content, many, (problem, first) => {
      dropped += 1;
      if (first) fresh += 1;
      reasons[problem.reason] = (reasons[problem.reason] ?? 0) + 1;
    });
    return guarded === content ? message : { ...(message as object), content: guarded };
  });
  if (dropped === 0) return context;
  // Once per picture: the same block is checked again at every later step of the run.
  if (fresh > 0)
    getLogger().warn("model_image.left_out", {
      ...log,
      "images.left_out": dropped,
      "images.new": fresh,
      "images.total": images,
      "images.reasons": reasons,
    });
  return { ...context, messages };
}

/**
 * For a runtime that hands pictures to another agent one by one: the note to send instead of
 * this image, or undefined when the image can be sent. Logs one warn line when it is left out.
 */
export function unusableImageNote(image: { data?: unknown }, origin: string): string | undefined {
  if (!modelImageGuardEnabled()) return undefined;
  const problem = modelImageProblem(image);
  if (!problem) return undefined;
  getLogger().warn("model_image.left_out", {
    "images.left_out": 1,
    "images.new": 1,
    "images.reasons": { [problem.reason]: 1 },
    "images.origin": origin,
  });
  return modelImageLeftOutNote(problem);
}
