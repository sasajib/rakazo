import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import type { MemoryPromptBudget } from "@rakazo/contracts";
import type { MemoryPromptDocument } from "./memory-context.prompt.js";
import { AGENT_MEMORY_MAX_BYTES, buildAgentMemoryPrompt } from "./memory-context.prompt.js";

export async function loadAgentMemoryContext(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
  maxBytes = AGENT_MEMORY_MAX_BYTES,
  /** Told what reached the block (see `memory.prompt.built`); never changes the block. */
  onPlan?: (plan: MemoryPromptBudget) => void,
): Promise<string | undefined> {
  const documents = await readAgentMemory(memory, botId, context);
  const built = buildAgentMemoryPrompt(documents, maxBytes);
  onPlan?.(built.plan);
  return built.text;
}

/** The bot's own memory plus the user's, in the shape the prompt builder reads. */
export async function readAgentMemory(
  memory: MemoryStore,
  botId: string,
  context: AdapterContext,
): Promise<MemoryPromptDocument[]> {
  const [botMemory, userMemory] = await Promise.all([
    memory.read({ scope: "bot", botId }, context),
    memory.read({ scope: "user" }, context),
  ]);
  return [
    ...botMemory.documents.map((document) => ({ ...document, scope: "bot" as const })),
    ...userMemory.documents.map((document) => ({ ...document, scope: "user" as const })),
  ];
}
