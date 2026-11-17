import { createHash } from "node:crypto";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { buildAgentMemoryPrompt } from "./memory-context.prompt.js";
import {
  COMPUTER_USE_INSTRUCTION,
  PRIVATE_WORKSPACE_INSTRUCTION,
  RAKAZO_PLATFORM_INSTRUCTION,
  VOICE_CALL_INSTRUCTION,
} from "./run-instructions.prompt.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { renderStandingOrdersBlock } from "./standing-orders.js";
import {
  EVIDENCE_INSTRUCTION,
  PLAN_FIRST_INSTRUCTION,
  TALK_RUN_INSTRUCTION,
} from "./talk-run.prompt.js";

/**
 * Prompt surface: everything the model is told on every run (tool definitions and fixed prompt text),
 * rendered into committed files under __prompt_surface__/. An upstream merge or an edit that changes
 * the surface fails here until the diff is reviewed and the files are regenerated:
 *   npx vitest run packages/adapters/src/prompt-surface.test.ts -u
 * Why: the first upstream sync silently broke our queue gate, and the prompt text is where such changes hide.
 * Idea taken from Hermes Agent's prompt-surface snapshot (MIT), written fresh for this codebase.
 */
const base = {
  graphicalToolsAllowed: false,
  groupId: null,
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
  fleetManagement: true,
} as const;

const SCENARIOS = {
  "owner-chat": { ...base, trigger: "user", followUpFromUser: true },
  "unattended-bot-message": { ...base, trigger: "bot_message", followUpFromUser: false },
  "routine-run": { ...base, trigger: "routine", followUpFromUser: false },
  "messaging-channel": {
    ...base,
    trigger: "user",
    messagingChannelRun: true,
    followUpFromUser: true,
  },
} as const;

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

function renderTools(name: keyof typeof SCENARIOS): string {
  const tools = selectBuiltinToolsForRun(SCENARIOS[name] as never);
  const bytes = Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );
  const body = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (t) =>
        `## ${t.name}\n${t.description}\nschema ${sha(t.inputSchema)} (${Buffer.byteLength(JSON.stringify(t.inputSchema))} bytes)`,
    )
    .join("\n\n");
  return `# Tool surface: ${name}\n${tools.length} tools, ${bytes} bytes of definitions\n\n${body}\n`;
}

describe("prompt surface", () => {
  for (const name of Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]) {
    it(`tool definitions: ${name}`, async () => {
      await expect(renderTools(name)).toMatchFileSnapshot(`./__prompt_surface__/tools.${name}.md`);
    });
  }

  it("fixed prompt text", async () => {
    const standing = [
      "# Standing orders",
      "",
      "- [rule r1-example] 2026-11-17: Be brief.",
      "- [decision rate] 2026-11-17: 50K USD per year.",
      "",
    ].join("\n");
    const memory = buildAgentMemoryPrompt([
      { scope: "user", path: "STANDING.md", revision: 1, content: standing },
      {
        scope: "bot",
        path: "MEMORY.md",
        revision: 1,
        updatedAt: "2026-11-17T00:00:00Z",
        content: "Likes short answers.",
      },
    ]).text;
    const text = [
      ["VOICE_CALL_INSTRUCTION", VOICE_CALL_INSTRUCTION],
      ["COMPUTER_USE_INSTRUCTION", COMPUTER_USE_INSTRUCTION],
      ["PRIVATE_WORKSPACE_INSTRUCTION", PRIVATE_WORKSPACE_INSTRUCTION],
      ["RAKAZO_PLATFORM_INSTRUCTION", RAKAZO_PLATFORM_INSTRUCTION],
      ["TALK_RUN_INSTRUCTION", TALK_RUN_INSTRUCTION],
      ["EVIDENCE_INSTRUCTION", EVIDENCE_INSTRUCTION],
      ["PLAN_FIRST_INSTRUCTION", PLAN_FIRST_INSTRUCTION],
      [
        "skills catalog (sample)",
        formatSkillsCatalogInstruction([
          { name: "Sample", description: "A sample skill", source: "user", readOnly: false },
        ]),
      ],
      ["standing orders block (sample)", renderStandingOrdersBlock(standing)],
      ["memory prompt (sample)", memory],
    ]
      .map(([title, body]) => `## ${title}\n\n${String(body)}`)
      .join("\n\n");
    await expect(`# Fixed prompt text\n\n${text}\n`).toMatchFileSnapshot(
      "./__prompt_surface__/prompts.md",
    );
  });

  it("every scenario still offers the queue and standing tools it should", () => {
    const owner = selectBuiltinToolsForRun(SCENARIOS["owner-chat"] as never).map((t) => t.name);
    for (const tool of [
      "standing_set",
      "bot_queue",
      "message_bot",
      "search_history",
      "skill_create",
    ]) {
      expect(owner).toContain(tool);
    }
  });
});
