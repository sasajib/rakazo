import type { RouteJudgeAnswer, RouteJudgeFailure } from "@rakazo/core";
import { parseRouteJudgeAnswer, ROUTING_JUDGE_INSTRUCTIONS } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { ledgerConfig } from "../../memory-ledger/config.js";
import type { FetchLike } from "../../memory-ledger/embeddings.js";
import type { ModelEndpoint } from "../../memory-ledger/model.js";
import { chatWithBudget, envModelEndpoint } from "../../memory-ledger/model.js";
import type { RoutingConfig } from "./routing-config.js";

/**
 * Fork (FORK.md 1.42): the routing judge's endpoint. Its own model/URL/key when set
 * (`MESSAGE_ROUTING_JUDGE_MODEL`, `_URL`, `_API_KEY`), else the memory ledger's (1.10), which is
 * also what the open-work judge and the skill curator use. Undefined = no model: the safe default.
 */
export function routingJudgeEndpoint(
  config: Pick<RoutingConfig, "judgeModel" | "judgeUrl" | "judgeApiKey">,
  env: Record<string, string | undefined> = process.env,
): ModelEndpoint | undefined {
  const ledger = envModelEndpoint(ledgerConfig(env).model);
  const baseUrl = config.judgeUrl ?? ledger?.baseUrl;
  if (!baseUrl) return undefined;
  const apiKey = config.judgeApiKey ?? (config.judgeUrl ? undefined : ledger?.apiKey);
  const model = config.judgeModel ?? ledger?.model;
  if (!model) return undefined;
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

/**
 * Ask the judge what a message means. Never throws and never takes longer than the timeout:
 * a missing endpoint, an error, an unreadable answer or the timeout is reported as such and the
 * caller falls back to an addition.
 */
export async function judgeMessageRoute(
  judgeInput: string,
  config: Pick<
    RoutingConfig,
    "judge" | "judgeTimeoutMs" | "judgeModel" | "judgeUrl" | "judgeApiKey"
  >,
  options: {
    fetchImpl?: FetchLike;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  } = {},
): Promise<{ answer: RouteJudgeAnswer | RouteJudgeFailure; ms: number; model?: string }> {
  const started = Date.now();
  const done = (answer: RouteJudgeAnswer | RouteJudgeFailure, model?: string) => ({
    answer,
    ms: Date.now() - started,
    ...(model ? { model } : {}),
  });
  if (!config.judge) return done("off");
  const endpoint = routingJudgeEndpoint(config, options.env ?? process.env);
  if (!endpoint) return done("off");
  const deadline = AbortSignal.timeout(config.judgeTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const call = chatWithBudget({
      fetchImpl: options.fetchImpl ?? (fetch as unknown as FetchLike),
      url: `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      endpoint,
      messages: [
        { role: "system", content: ROUTING_JUDGE_INSTRUCTIONS },
        { role: "user", content: judgeInput },
      ],
      maxTokens: 1_500,
      timeoutMs: config.judgeTimeoutMs,
      budgetMs: config.judgeTimeoutMs,
      retries: 0,
      signal,
      retryEvent: "message.route_judge_retry",
    });
    // The deadline also ends a call that ignores its own signal.
    const timedOut = new Promise<"timeout">((resolve) => {
      if (signal.aborted) resolve("timeout");
      signal.addEventListener("abort", () => resolve("timeout"), { once: true });
    });
    const answer = await Promise.race([call, timedOut]);
    if (answer === "timeout") return done(deadline.aborted ? "timeout" : "error", endpoint.model);
    if (!answer.ok) return done("error", endpoint.model);
    return done(parseRouteJudgeAnswer(answer.content) ?? "invalid", endpoint.model);
  } catch (error) {
    if (deadline.aborted) return done("timeout", endpoint.model);
    getLogger().info("message.route_judge_unavailable", { error: String(error).slice(0, 200) });
    return done("error", endpoint.model);
  }
}
