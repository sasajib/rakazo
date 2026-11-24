import { MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import {
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  isDeletableMemoryDocument,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import { readHistory, searchHistory } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "../../integrations/connector-safety.js";
import { stampMemoryEntry, userMemoryDate } from "../../memory/memory-expiry.js";
import { editMemory } from "../../memory/memory-tools.js";
import { curateStanding, findingsFor } from "../../memory/standing-curator.js";
import {
  backfillEmbeddings,
  relatedPairs,
  removeEmbedding,
  suggestRelated,
} from "../../memory/standing-embeddings.js";
import {
  normalizeStandingKey,
  parseStandingOrders,
  renderStandingEntry,
  STANDING_ORDERS_PATH,
  setStandingOrder,
} from "../../memory/standing-orders.js";
import { MAX_RECALLED_MEMORIES } from "../../runtime/context/history-compaction.prompt.js";
import { sharedMemorySaveError } from "../../tools/builtin.tool-definition.js";
import { RememberInputSchema } from "../../tools/builtin-conversation.tool-definition.js";
import type { RunContext } from "../assembly/run-context.js";
import { markReadOutsideContent } from "../assembly/run-context.js";
import { argsError } from "../turn/tool-args.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

/**
 * Models often fill optional fields they do not use with "" or null (botId: "", linkedRunId: "").
 * No history field means anything when blank, so a blank field counts as not given.
 */
export function withoutBlankFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([, value]) => value !== null && !(typeof value === "string" && !value.trim()),
    ),
  );
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : typeof args.threadId === "string" &&
        args.threadId !== (ctx.source.conversationThreadId ?? run.threadId);
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    threadId: ctx.source.conversationThreadId ?? run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
    ...(run.trigger === "routine" ? { ownerOnly: run.userId } : {}),
  };
  const given = withoutBlankFields(args);
  let scopeNote: string | undefined;
  if (name === "search_history") {
    // A refused my_chats search used to be an error the model retried; the safe answer is the
    // narrower scope (this chat) with a plain note, so the call still returns something useful.
    if (given.scope === "my_chats" && !allowMyChats) {
      given.scope = "this_chat";
      scopeNote =
        "my_chats is not available in this run, so only this chat was searched. Other chats are out of reach here; do not retry with my_chats.";
    }
    const hasQuery =
      typeof given.query === "string" || (Array.isArray(given.queries) && given.queries.length > 0);
    if (!hasQuery && !(Array.isArray(given.kinds) && given.kinds.length > 0)) {
      return call.finish({
        untrusted: true,
        messages: [],
        note: "Nothing was searched: give `query` (1-500 characters, every word must match one message) or `kinds`. Blank fields count as not given.",
      });
    }
  }
  let response: Awaited<ReturnType<typeof searchHistory | typeof readHistory>>;
  if (name === "search_history") {
    const parsed = HistorySearchInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await searchHistory(deps.prisma, scope, parsed.data);
  } else {
    const parsed = HistoryReadInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await readHistory(deps.prisma, scope, parsed.data);
  }
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  // Files the bot can now see are copied before its next computer tool.
  ctx.computer.copyEarlierFiles(
    response.messages.flatMap((message) =>
      (message.attachments ?? []).map((file) => ({
        kind: "file" as const,
        artifactId: file.artifactId,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      })),
    ),
  );
  return call.finish(
    scopeNote ? { ...(redacted as Record<string, unknown>), note: scopeNote } : redacted,
  );
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async remember(ctx, call) {
    const { deps, runId, bot, thread, context, run } = ctx;
    const { args } = call;
    const parsed = RememberInputSchema.safeParse(args);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    const today = await userMemoryDate(deps.prisma, run.userId, deps.now?.() ?? new Date());
    const operations = parsed.data.operations.map((operation) =>
      operation.action !== "remove" && operation.content?.trim()
        ? { ...operation, content: stampMemoryEntry(operation.content, today, operation.until) }
        : operation,
    );
    // A save may edit any document the bot already has, such as an imported one. A path it
    // does not have means the index: a save never creates a document, so models cannot
    // invent file names to get past the size cap.
    const requested = String(args.path ?? "").trim() || MEMORY_INDEX_PATH;
    const read = (path: string) => deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
    // A concurrent save changes the revision, so re-read and apply the edit again.
    for (let attempt = 1; ; attempt += 1) {
      let snapshot = await read(requested);
      if (!snapshot.documents[0] && requested !== MEMORY_INDEX_PATH)
        snapshot = await read(MEMORY_INDEX_PATH);
      const existing = snapshot.documents[0];
      const path = existing?.path ?? MEMORY_INDEX_PATH;
      const edit = editMemory(existing?.content ?? "", operations);
      if ("error" in edit) return call.finish(edit);
      const { content } = edit;
      if (content === (existing?.content ?? "")) return call.finish({ ok: true });
      try {
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path,
            content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        return call.finish({ ok: true });
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt >= 3) throw error;
      }
    }
  },
  async standing_set(ctx, call) {
    const { deps, runId, thread, run, context } = ctx;
    const { args } = call;
    // Review reads only (the orders are already in every prompt), so any run may ask for it.
    if (args.review === true) {
      const snapshot = await deps.memory.read(
        { scope: "user", path: STANDING_ORDERS_PATH },
        context,
      );
      const entries = parseStandingOrders(snapshot.documents[0]?.content ?? "");
      const findings = curateStanding(entries, new Date().toISOString().slice(0, 10));
      // Meaning-based hints (pgvector): embed what is missing, then list related entries that are not linked yet.
      await backfillEmbeddings(deps.prisma, { spaceId: run.spaceId, entries });
      const related = await relatedPairs(deps.prisma, { spaceId: run.spaceId, entries });
      return call.finish({
        ok: true,
        entries: entries.length,
        ...(related.length
          ? {
              relatedNotLinked: related,
              relatedNote:
                "Close in meaning but not linked. Ask the user whether one is an exception of, wins over, or needs the other.",
            }
          : {}),
        findings: findings.map((f) => ({ kind: f.kind, keys: f.keys, message: f.message })),
        note: findings.length
          ? "Tell the user these points in plain words and let him decide; change nothing yourself."
          : "No problems found.",
      });
    }
    // Standing orders bind every bot, so only the user's own words may change them: not a watch
    // event, a webhook, a mail or another bot (the same trust gate as cross-chat history).
    if (!ctx.source.myChatsAllowed || (await ctx.trust.receivedOutsideMessage())) {
      return call.finish({
        error:
          "Standing orders change only when the user says so himself in a direct chat or call. Tell him what you would change and let him say it.",
      });
    }
    let zone = "UTC";
    try {
      const user = await deps.prisma.user.findUnique({
        where: { id: run.userId },
        select: { timezone: true },
      });
      if (user?.timezone) zone = user.timezone;
    } catch {
      // The date is context only; UTC is a fine fallback.
    }
    const today = (() => {
      try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
          new Date(run.createdAt ?? Date.now()),
        );
      } catch {
        return new Date(run.createdAt ?? Date.now()).toISOString().slice(0, 10);
      }
    })();
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await deps.memory.read(
        { scope: "user", path: STANDING_ORDERS_PATH },
        context,
      );
      const existing = snapshot.documents[0];
      const edit = setStandingOrder(
        existing?.content ?? "",
        {
          kind: String(args.kind ?? "") as "rule" | "decision",
          key: String(args.key ?? ""),
          ...(args.text === undefined || args.text === null ? {} : { text: String(args.text) }),
          ...(args.tier !== undefined && args.tier !== null ? { tier: Number(args.tier) } : {}),
          ...(args.links !== undefined && args.links !== null ? { links: String(args.links) } : {}),
        },
        today,
      );
      if ("error" in edit) return call.finish({ error: edit.error });
      if (edit.action === "unchanged") return call.finish({ ok: true, note: "Already set." });
      try {
        await deps.memory.commit(
          {
            scope: "user",
            path: STANDING_ORDERS_PATH,
            content: edit.content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        getLogger().info("standing.set", {
          "standing.key": String(args.key ?? ""),
          "standing.action": edit.action,
          "standing.run_id": runId,
          ...(edit.previous ? { "standing.replaced_len": edit.previous.length } : {}),
        });
        const key = normalizeStandingKey(String(args.key ?? ""));
        const after = parseStandingOrders(edit.content);
        const saved = after.find((e) => e.key === key);
        let similar: { key: string; similarity: number }[] = [];
        if (edit.action === "removed") {
          await removeEmbedding(deps.prisma, { spaceId: run.spaceId, key }).catch(() => undefined);
        } else if (saved) {
          similar = await suggestRelated(deps.prisma, {
            spaceId: run.spaceId,
            key,
            text: saved.text,
            entries: after,
          });
        }
        const review = findingsFor(
          curateStanding(parseStandingOrders(edit.content), today),
          key,
        ).map((f) => f.message);
        return call.finish({
          ok: true,
          action: edit.action,
          ...(saved ? { now: renderStandingEntry(saved) } : {}),
          ...(edit.previous ? { replaced: edit.previous } : {}),
          ...(similar.length
            ? {
                similarNotLinked: similar,
                similarNote:
                  "Related by meaning but not linked. Tell the user in one line and ask whether to link them (exception of, wins over, needs).",
              }
            : {}),
          ...(review.length
            ? {
                review: review.slice(0, 3),
                note: "Saved. Tell the user the review points in one or two plain sentences and ask whether to adjust; do not change anything on your own.",
              }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt >= 3) throw error;
      }
    }
  },
  async save_shared_memory(ctx, call) {
    const { deps, runId, thread, context } = ctx;
    const { args } = call;
    const invalid = sharedMemorySaveError(args);
    if (invalid) return call.finish({ error: invalid });
    const path = String(args.path ?? "").trim();
    // The save replaces the whole document. Pass the revision just read so a
    // concurrent edit is rejected instead of overwritten.
    const snapshot = await deps.memory.read({ scope: "user", path }, context);
    const expectedRevision = snapshot.documents[0]?.revision ?? 0;
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return call.finish({ ok: true, path: saved.path, revision: saved.revision });
    } catch (error) {
      if (error instanceof MemoryRevisionConflictError)
        return call.finish({ error: error.message });
      throw error;
    }
  },
  async delete_shared_memory(ctx, call) {
    const { deps, context } = ctx;
    const path = String(call.args.path ?? "").trim();
    if (!path) return call.finish({ error: "path is required" });
    // Standing orders bind every bot: they change entry by entry, only through standing_set.
    if (path === STANDING_ORDERS_PATH) {
      return call.finish({
        error: "STANDING.md changes only through standing_set (it replaces by key).",
      });
    }
    if (!isDeletableMemoryDocument(path)) {
      return call.finish({ error: `${path} cannot be deleted; edit its content instead.` });
    }
    const doc = (await deps.memory.read({ scope: "user", path }, context)).documents[0];
    if (!doc) return call.finish({ error: `No shared memory document named ${path}.` });
    // The id pins the document just read, so a newer one saved at the same path stays.
    const { removed } = await deps.memory.remove(
      { id: doc.id, scope: "user", path: doc.path },
      context,
    );
    if (!removed) return call.finish({ error: `${path} was already deleted.` });
    return call.finish({ ok: true, path: doc.path });
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    const response = await ctx.memory.semantic!.recall(
      {
        query: String(args.query ?? ""),
        scope: ctx.memory.scope!,
        botId: bot.id,
        ...(thread.historyCompactedUpToSeq == null
          ? {}
          : { historyGeneration: thread.historyCompactionGeneration }),
        limit: MAX_RECALLED_MEMORIES,
      },
      context,
    );
    // All recalled knowledge is derived data; an omitted provider marker cannot certify it.
    if (response.ok && response.value.length > 0) {
      await markReadOutsideContent(ctx, response.value);
    }
    return response;
  },
  async reflect_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.reflect) {
      return { error: "This memory provider cannot answer questions from memory." };
    }
    const response = await ctx.memory.semantic.reflect(
      { query: String(args.query ?? ""), botId: bot.id },
      context,
    );
    if (!response.ok) return response;
    const text = response.value.trim();
    // Reflection is provider-generated prose; it cannot attest that its answer is clean.
    if (text) await markReadOutsideContent(ctx, text);
    return { ok: true, value: text || "No relevant memories." };
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    return call.finish(
      await ctx.memory.semantic!.save(
        {
          content: String(args.content ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          source: { kind: "durable" },
        },
        context,
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    return call.finish(
      await ctx.memory.semantic.forget(
        {
          id: String(args.id ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          ...(typeof args.entity === "string" && args.entity.trim()
            ? { entity: args.entity.trim() }
            : {}),
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
        },
        context,
      ),
    );
  },
};
