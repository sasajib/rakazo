import type { ModelImageProblem } from "./model-image-guard.js";

/**
 * Fork (1.38): what the model reads where a picture was left out of its input because the
 * provider would have refused the whole request for it.
 */
export function modelImageLeftOutNote(problem: ModelImageProblem): string {
  const why =
    problem.reason === "oversized_dimensions"
      ? `it was ${problem.width}x${problem.height} pixels, over the ${problem.maxSide} pixel limit per side`
      : {
          empty: "it was empty",
          undecodable: "its data was not valid base64",
          unsupported_format: "it was not a readable PNG, JPEG, GIF or WebP",
          truncated: "it was cut off before its end",
          oversized_bytes: "it was over the size limit",
        }[problem.reason];
  return `[image left out: ${why}. To look at it, make a smaller or valid copy and read that.]`;
}
