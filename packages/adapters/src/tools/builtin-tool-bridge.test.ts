import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  selectBuiltinToolsForRun,
} from "../runs/tools/run-tool-selection.js";
import { describeToolActivity } from "../runtime/pi/tools/pi-runtime-tools.js";
import { FIND_TOOL, USE_TOOL } from "./builtin.tool-definition.js";
import { CORE_BUILTIN_TOOL_NAMES, findTools, partitionTools } from "./builtin-tool-bridge.js";

const ownerChat = selectBuiltinToolsForRun({
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
  fleetManagement: true,
  followUpFromUser: true,
});

const definitionBytes = (tools: typeof ownerChat) =>
  Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

describe("built-in tool bridge", () => {
  it("lists a pinned tool set within a byte budget on an owner chat run", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
      "attach_file",
      "bot_queue",
      "bot_skills",
      "connect_app",
      "find_tool",
      "job_list",
      "job_output",
      "job_status",
      "job_stop",
      "list_files",
      "message_bot",
      "message_user",
      "plan_propose",
      "read_file",
      "read_history",
      "remember",
      "request_secret",
      "request_takeover",
      "run_subagent",
      "schedule_cancel",
      "schedule_create",
      "schedule_list",
      "schedule_update",
      "scratchpad_add",
      "scratchpad_complete",
      "scratchpad_list",
      "scratchpad_remove",
      "scratchpad_update",
      "search_history",
      "shell",
      "skill_read",
      "standing_set",
      "update_bot",
      "update_preferences",
      "use_tool",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    // request_secret carries the card and contact kinds; update_bot carries instructions paging;
    // the history tools point at files from earlier messages; a watch says it takes no other timing;
    // read_file takes a line range; ask_user carries the content being decided about, and says
    // the person can still type their own answer;
    // search_history lists earlier tool work by kind without a keyword; message_bot is the
    // most used deferred tool, and a lookup before each message cost a step; schedule_create says
    // whether a routine runs in its chat, and takes the events (webhook, Git, chat, email) a
    // routine can start on, saying a Git event needs no connected app; schedule_list reaches a
    // managed bot's routines; update_bot carries the settings its owner can change;
    // update_preferences includes the chat model picker and reply streaming; remember takes a
    // list of operations so one call can make room and add, each with an optional end, and edits
    // the Space's shared memory too, and says what stays out of memory and how to make room
    // without abbreviating; shell says to open the bot's screen when a graphical program
    // finds no display; schedule_create takes an end date for a repeat or watch, so a limited
    // stretch is one routine. (Upstream's own cap here: 38_322.)
    // Fork: standing_set, bot_queue, call_user, schedule_cancel, schedule_update and the five
    // scratchpad tools are listed on every run, message_bot takes lane, force and replaces,
    // shell carries the background-job wording and flag, the four job tools and plan_propose are
    // pinned (measured 48_173). Fork: bot_skills is listed for a bot with bot management on, and
    // update_bot points at it (measured 49_047). Fork 1126 merge: message_bot's replaces wording
    // (+55) and plan_propose's notify wording (-21) land beside bot_skills (measured 49_081).
    // vault_fill is pinned too but only offered with a configured MCP browser, so it is not in
    // this owner chat (its own test caps it at 1_400 bytes).
    expect(definitionBytes(listed)).toBeLessThanOrEqual(49_140);
    expect(deferred.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["render_plot", "create_space", "generate_secret"]),
    );
  });

  it("keeps the tools a bot needs without searching for them in the core set", () => {
    // call_user is offered per run (one-to-one chats that may ring) but must never be hidden behind find_tool when it is
    for (const name of [
      "call_user",
      "schedule_cancel",
      "schedule_update",
      "message_bot",
      "scratchpad_list",
    ]) {
      expect(CORE_BUILTIN_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("names only real built-ins as core", () => {
    for (const name of CORE_BUILTIN_TOOL_NAMES) expect(BUILTIN_AGENT_TOOL_NAMES).toContain(name);
  });

  it("lists every tool when none is deferred", () => {
    const core = ownerChat.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
    expect(partitionTools(core)).toEqual({ listed: core, deferred: [] });
  });

  it("names deferred tools by area in find_tool, without schemas", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const tool of deferred) expect(description).toContain(tool.name);
    expect(description).toContain("secrets:\n");
    expect(description).not.toContain("inputSchema");
    expect(listed.some((tool) => tool.name === USE_TOOL)).toBe(true);
  });

  it("finds exact names and ranks a query over names, descriptions and parameters", () => {
    const { deferred } = partitionTools(ownerChat);
    const plot = findTools(deferred, { names: ["render_plot", "shell", "nope"] });
    expect(plot.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(plot.tools[0]!.inputSchema).toEqual(
      deferred.find((tool) => tool.name === "render_plot")!.inputSchema,
    );
    expect(plot.unknown).toEqual(["shell", "nope"]);

    const names = (query: string) => findTools(deferred, { query }).tools.map((tool) => tool.name);
    expect(names("chart")).toContain("render_plot");
    expect(names("new space")[0]).toBe("create_space");
    expect(names("generate password")[0]).toBe("generate_secret");
    // the scratchpad is always listed (fork), so find_tool no longer has to be asked for it
    expect(names("scratchpad")).toEqual([]);
    expect(findTools(deferred, { query: "zzzz" })).toMatchObject({
      tools: [],
      hint: expect.any(String),
    });
  });

  it("never finds a tool the bot turned off", () => {
    const { listed, deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        disabledBuiltinTools: ["render_plot"],
      }),
    );
    expect(findTools(deferred, { names: ["render_plot"] })).toMatchObject({
      tools: [],
      unknown: ["render_plot"],
    });
    expect(listed.find((tool) => tool.name === FIND_TOOL)!.description).not.toContain(
      "render_plot",
    );
  });

  it("reports unavailable built-in reasons in find_tool without leaking prototype keys", () => {
    const { deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "routine",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
      }),
    );
    const reason = "schedule_update is not available in routine runs.";
    const reasons = { schedule_update: reason, render_plot: "stale reason" };

    const onlyUnavailable = findTools(deferred, { names: ["schedule_update"] }, reasons);
    expect(onlyUnavailable).toEqual({
      tools: [],
      unavailable: { schedule_update: reason },
    });

    const mixed = findTools(
      deferred,
      { names: ["render_plot", "schedule_update", "nope", "toString"] },
      reasons,
    );
    expect(mixed.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(mixed.unavailable).toEqual({ schedule_update: reason });
    expect(mixed.unknown).toEqual(["nope", "toString"]);
    expect(mixed).not.toHaveProperty("hint");

    const byQuery = findTools(deferred, { query: "SCHEDULE_UPDATE" }, reasons);
    expect(byQuery.unavailable).toEqual({ schedule_update: reason });
  });

  it("shows the real tool as activity", () => {
    expect(
      describeToolActivity(USE_TOOL, { name: "create_space", arguments: { name: "Finance" } }),
    ).toBe("Creating space: Finance");
  });
});

describe("bridge tool definitions", () => {
  it("renders find_tool with the deferred names by area, and use_tool", () => {
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
    const { listed } = partitionTools([tool("shell"), tool("list_secrets"), tool("render_plot")]);
    expect(listed.slice(1)).toEqual([
      {
        name: "find_tool",
        description:
          "Find deferred tool parameters by name or query before calling use_tool.\nmedia:\n  render_plot\nsecrets:\n  list_secrets",
        inputSchema: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string" }, maxItems: 5 },
            query: { type: "string", maxLength: 200, description: "Words describing the task" },
          },
        },
        readOnly: true,
      },
      {
        name: "use_tool",
        description: "Run a tool returned by find_tool this turn.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object", description: "Arguments matching its parameters" },
          },
          required: ["name", "arguments"],
        },
      },
    ]);
  });
});
