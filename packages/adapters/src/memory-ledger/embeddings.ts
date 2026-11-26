import type { LedgerConfig } from "./config.js";

export const EMBEDDING_DIMENSIONS = 1024;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status?: number;
  /** Present on a real fetch response; the model call reads `retry-after` from it. */
  headers?: { get(name: string): string | null } | undefined;
  json: () => Promise<unknown>;
}>;

export interface Embedder {
  /** The text's vector, or undefined when the service is slow, down or answers oddly. Never throws. */
  embed(text: string, signal?: AbortSignal): Promise<number[] | undefined>;
}

const isVector = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === EMBEDDING_DIMENSIONS &&
  value.every((item) => typeof item === "number" && Number.isFinite(item));

/**
 * bge-m3 (1024 dimensions) behind either an OpenAI-compatible `/v1/embeddings` endpoint or
 * Ollama's `/api/embeddings` (the endpoint the fork's STANDING embeddings use). A URL that ends
 * in `/v1` is treated as OpenAI-compatible.
 */
export function createEmbedder(
  config: LedgerConfig["embeddings"],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Embedder | undefined {
  if (!config.url) return undefined;
  const base = config.url.replace(/\/+$/, "");
  const openAi = /\/v\d+$/.test(base);
  return {
    async embed(text, signal) {
      if (!text.trim()) return undefined;
      try {
        const timeout = AbortSignal.timeout(config.timeoutMs);
        const response = await fetchImpl(openAi ? `${base}/embeddings` : `${base}/api/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify(
            openAi
              ? { model: config.model, input: text.slice(0, 4000) }
              : { model: config.model, prompt: text.slice(0, 4000) },
          ),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as {
          embedding?: unknown;
          data?: Array<{ embedding?: unknown }>;
        };
        const vector = openAi ? body.data?.[0]?.embedding : body.embedding;
        return isVector(vector) ? vector : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
