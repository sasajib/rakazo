import { FLEET_TOOL_NAMES, FLEET_WRITE_TOOL_NAMES, isBuiltinToolName } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  closeSkillNames,
  resolveSkillRefs,
  selectionRowsFor,
  UnknownBotSkillsError,
} from "./bot-skill-assign.js";
import { builtinAgentTools } from "./builtin.tool-definition.js";
import { CORE_BUILTIN_TOOL_NAMES } from "./builtin-tool-bridge.js";
import { isFleetApprovalTool } from "./fleet-tools.js";

const catalog = [
  { id: "builtin:Deep research", name: "Deep research", description: "Research a topic." },
  { id: "builtin:Tidy inbox", name: "Tidy inbox", description: "Sort the inbox." },
  { id: "sk_1", name: "venue-notes", description: "Notes on venues." },
  { id: "sk_2", name: "Invoice Check", description: "Check an invoice." },
];

describe("skill references a bot writes", () => {
  it("takes ids, builtin:<name> and names in any case, once each and in the order given", () => {
    expect(
      resolveSkillRefs(catalog, [
        " Venue-Notes ",
        "sk_2",
        "builtin:tidy inbox",
        "venue-notes",
        "deep research",
        "",
      ]),
    ).toEqual({ ok: true, ids: ["sk_1", "sk_2", "builtin:Tidy inbox", "builtin:Deep research"] });
  });

  it("never reaches a stored skill through builtin:<name>", () => {
    const resolved = resolveSkillRefs(catalog, ["builtin:venue-notes"]);
    expect(resolved.ok).toBe(false);
  });

  it("refuses the whole request on an unknown name and lists the close matches", () => {
    const resolved = resolveSkillRefs(catalog, ["venue-notes", "venue-note", "zzz"]);
    expect(resolved).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^No skill in this space matches "venue-note" \(did you mean venue-notes\?\); "zzz"\. Nothing was changed\./,
      ),
    });
    expect(closeSkillNames(catalog, "invoice")).toEqual(["Invoice Check"]);
    expect(closeSkillNames(catalog, "zzz")).toEqual([]);
  });
});

describe("the stored selection", () => {
  it("keeps the chosen stored skills and switches off the built-ins left out", () => {
    expect(selectionRowsFor(catalog, ["sk_1", "builtin:Tidy inbox", "sk_1"])).toEqual({
      storedIds: ["sk_1"],
      excludedBuiltins: ["Deep research"],
    });
    expect(selectionRowsFor(catalog, [])).toEqual({
      storedIds: [],
      excludedBuiltins: ["Deep research", "Tidy inbox"],
    });
  });

  it("refuses an id outside the space", () => {
    expect(() => selectionRowsFor(catalog, ["sk_1", "sk_other"])).toThrow(UnknownBotSkillsError);
  });
});

describe("bot_skills as a built-in tool", () => {
  const tool = builtinAgentTools.find((entry) => entry.name === "bot_skills");

  it("is a bot management write that needs no card of its own and is always listed", () => {
    expect(isBuiltinToolName("bot_skills")).toBe(true);
    expect((FLEET_TOOL_NAMES as readonly string[]).includes("bot_skills")).toBe(true);
    expect((FLEET_WRITE_TOOL_NAMES as readonly string[]).includes("bot_skills")).toBe(true);
    expect(isFleetApprovalTool("bot_skills")).toBe(false);
    expect(CORE_BUILTIN_TOOL_NAMES.has("bot_skills")).toBe(true);
  });

  it("takes a target, an action and skills", () => {
    expect(tool?.inputSchema).toMatchObject({
      required: ["action"],
      properties: {
        bot_id: { type: "string" },
        bot_name: { type: "string" },
        action: { enum: ["list", "add", "remove", "set", "pin", "unpin", "list_pinned"] },
        skills: { type: "array" },
        all: { type: "boolean" },
      },
    });
  });

  it("spawn_bot takes skills, and both descriptions say a bot attaches skills itself", () => {
    const spawn = builtinAgentTools.find((entry) => entry.name === "spawn_bot")!;
    expect((spawn.inputSchema.properties as Record<string, unknown>).skills).toMatchObject({
      type: "array",
    });
    expect(spawn.description).toContain("Pass skills");
    expect(tool?.description).toContain("instead of asking the owner");
  });
});
