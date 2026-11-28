/**
 * Fork (FORK.md 1.42): evaluation of the routing judge against a real model endpoint.
 *
 *   MESSAGE_ROUTING_JUDGE_URL=… MESSAGE_ROUTING_JUDGE_API_KEY=… MESSAGE_ROUTING_JUDGE_MODEL=… \
 *     npx tsx packages/adapters/src/runs/routing/eval/routing-eval.ts [--repeat N] [--json out.json]
 *
 * Read-only model calls; nothing in the product is touched. Prints accuracy per class, the
 * dangerous errors (a non-override routed as an override = work aborted on a guess; an override
 * routed as a new task = the old task keeps going wrongly) and latency.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteIntent, RouteTask } from "@rakazo/core";
import { decideMessageRoute, routingJudgeInput, taskKeys } from "@rakazo/core";
import { routingConfig } from "../routing-config.js";
import { judgeMessageRoute } from "../routing-judge.js";

type EvalTask = {
  key: string;
  state: RouteTask["state"];
  request: string;
  progress?: string;
  question?: { text: string; options: string[] };
};
type EvalSet = {
  contexts: Record<
    string,
    { tasks: EvalTask[]; recent: Array<{ role: "person" | "agent"; text: string }> }
  >;
  cases: Array<{
    ctx: string;
    text: string;
    expect?: RouteIntent;
    accept?: RouteIntent[];
    task?: string;
    /** For an override: the action that is right; a replace where a redirect was meant is a miss. */
    kind?: "redirect" | "replace";
    /** Not used to write the prompt's examples. */
    heldout?: boolean;
  }>;
};

const here = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(readFileSync(join(here, "routing-eval-set.json"), "utf8")) as EvalSet;
const args = process.argv.slice(2);
const repeat = Number(args[args.indexOf("--repeat") + 1]) || 1;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;

function tasksOf(ctx: EvalSet["contexts"][string]): RouteTask[] {
  const base = Date.parse("2026-11-28T08:00:00Z");
  return ctx.tasks.map((task, index) => ({
    runId: `run-${task.key}`,
    taskId: `task-${task.key}`,
    state: task.state,
    title: task.request.slice(0, 80),
    request: task.request,
    progress: task.progress,
    question: task.question
      ? { messageId: `q-${task.key}`, text: task.question.text, options: task.question.options }
      : undefined,
    steerable: true,
    createdAt: new Date(base + index * 60_000),
  }));
}

const say = (line: string) => process.stdout.write(`${line}\n`);
const config = routingConfig();
const rows: Array<Record<string, unknown>> = [];
for (let round = 0; round < repeat; round += 1) {
  for (const item of set.cases) {
    const ctx = set.contexts[item.ctx];
    if (!ctx) throw new Error(`unknown context ${item.ctx}`);
    const tasks = tasksOf(ctx);
    const input = routingJudgeInput({ message: item.text, tasks, recentTurns: ctx.recent });
    const judged = await judgeMessageRoute(input, config);
    const decision = decideMessageRoute({
      tasks,
      judged: judged.answer,
      minConfidence: config.minConfidence,
      overrideMinConfidence: config.overrideMinConfidence,
      replaceMinConfidence: config.replaceMinConfidence,
    });
    const accept = item.accept ?? (item.expect ? [item.expect] : []);
    const expectedRun = item.task ? taskKeys(tasks).get(item.task)?.runId : undefined;
    const intentOk =
      accept.includes(decision.intent) &&
      !(
        decision.intent === "override" &&
        item.kind === "redirect" &&
        decision.action === "replace"
      );
    const targetOk =
      decision.intent === "new_task" || !expectedRun || decision.targetRunId === expectedRun;
    rows.push({
      ctx: item.ctx,
      text: item.text,
      expected: accept.join("|"),
      kind: item.kind,
      raw: typeof judged.answer === "string" ? judged.answer : judged.answer.intent,
      confidence: typeof judged.answer === "string" ? null : judged.answer.confidence,
      decided: decision.intent === "override" ? `override/${decision.action}` : decision.intent,
      heldout: item.heldout === true,
      basis: decision.basis,
      ok: intentOk && targetOk,
      intentOk,
      targetOk,
      ms: judged.ms,
      model: judged.model,
      reason: decision.reason,
    });
    process.stdout.write(intentOk && targetOk ? "." : "x");
  }
}
process.stdout.write("\n");

const classes = ["override", "addition", "answer", "new_task", "ambiguous"] as const;
const classOf = (row: Record<string, unknown>) =>
  String(row.expected).includes("|") ? "ambiguous" : String(row.expected);
for (const cls of classes) {
  const of = rows.filter((row) => classOf(row) === cls);
  if (!of.length) continue;
  const ok = of.filter((row) => row.ok).length;
  say(`${cls.padEnd(10)} ${ok}/${of.length}  ${((100 * ok) / of.length).toFixed(0)}%`);
}
const total = rows.filter((row) => row.ok).length;
say(`ALL        ${total}/${rows.length}  ${((100 * total) / rows.length).toFixed(1)}%`);
const dangerous = rows.filter(
  (row) =>
    (row.decided === "override/replace" && !String(row.expected).includes("override")) ||
    (row.decided === "override/replace" && row.kind === "redirect") ||
    (String(row.expected) === "override" && row.decided === "new_task"),
);
say(
  `dangerous  ${dangerous.length} (work stopped on a non-override or a redirect; override -> new_task)`,
);
const mild = rows.filter(
  (row) => row.decided === "override/redirect" && !String(row.expected).includes("override"),
);
say(`mild       ${mild.length} (non-override steered as a redirect: nothing stopped)`);
const held = rows.filter((row) => row.heldout);
if (held.length) say(`held-out   ${held.filter((row) => row.ok).length}/${held.length}`);
const ms = rows.map((row) => Number(row.ms)).sort((a, b) => a - b);
const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
say(`latency ms p50 ${pct(50)} p90 ${pct(90)} max ${ms[ms.length - 1]}`);
const fallbacks = rows.filter((row) => String(row.basis) !== "judge").length;
say(`fallbacks (timeout/error/low confidence) ${fallbacks}`);
for (const row of rows.filter((row) => !row.ok))
  say(
    `  MISS [${row.ctx}] "${row.text}" expected ${row.expected} got ${row.decided} (${row.raw} ${row.confidence}, ${row.basis}, ${row.ms} ms) ${row.reason ?? ""}`,
  );
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
