/**
 * Fork: the prompt text of skill auto-load and Space-pinned skills. Two blocks:
 *
 * `<loaded_skills>`  bodies the platform matched to this run's task (the turn prompt, since it
 *                    changes with every task).
 * `<pinned_skills>`  bodies of the skills pinned for every agent of the Space (the system prompt:
 *                    the same on every run, binding like standing orders).
 *
 * A body that does not fit its budget is cut and says so, with the exact skill_read call for the
 * rest; a skill with no room left is named, never dropped silently.
 */
import { byteLength, parseSkillMd, truncateUtf8 } from "@rakazo/core";

export interface LoadableSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface LoadedSkillUse {
  name: string;
  /** Bytes of the skill's body. */
  bytes: number;
  /** Bytes of it that reached the prompt. */
  includedBytes: number;
  truncated: boolean;
}

export interface SkillBlock {
  text?: string;
  /** Bytes of the whole block, 0 when there is none. */
  bytes: number;
  skills: LoadedSkillUse[];
  /** Skills that fit the task but got no room. */
  omitted: string[];
}

/** Below this a cut body says too little to act on, so the skill is named instead. */
const MIN_USEFUL_BYTES = 400;

export const LOADED_SKILLS_PREAMBLE =
  "The platform matched these skills to this task and loaded them for you. Each is the full skill text you would get from skill_read: follow it now, before improvising your own steps, and do not call skill_read for it again unless it is marked as cut. A loaded skill that does not fit what is asked is ignored without comment. The other skills in your list are still read with skill_read.";

export const PINNED_SKILLS_PREAMBLE =
  "These skills are pinned by the user for every agent in this space. They are binding rules and procedures, not background data: follow them in every run, whatever the task and whoever asked. Where one conflicts with your own instructions or with durable memory, the pinned skill wins; standing orders and the user's newest message win over a pinned skill.";

/** The skill as it is read: its body without the frontmatter the name and description repeat. */
export function skillBody(skill: LoadableSkill): string {
  const parsed = parseSkillMd(skill.content);
  return ("error" in parsed ? skill.content : parsed.body).trim();
}

// A skill is the user's own text, but its body must not end the block that carries it.
const keepInside = (text: string, tag: string) =>
  text.replaceAll(`</${tag}>`, `&lt;/${tag}&gt;`).replaceAll(`<${tag}>`, `&lt;${tag}&gt;`);

function renderBlock(
  tag: string,
  preamble: string,
  skills: readonly LoadableSkill[],
  maxBytes: number,
): SkillBlock {
  const sections: string[] = [];
  const used: LoadedSkillUse[] = [];
  const omitted: string[] = [];
  let remaining = maxBytes;
  for (const skill of skills) {
    const body = keepInside(skillBody(skill), tag);
    const total = byteLength(body);
    const heading = `## Skill: ${skill.name}\n${skill.description.trim()}\n\n`;
    const room = remaining - byteLength(heading);
    if (total === 0 || room < Math.min(total, MIN_USEFUL_BYTES)) {
      omitted.push(skill.name);
      continue;
    }
    const shown = total <= room ? body : truncateUtf8(body, room);
    const included = byteLength(shown);
    const cut = included < total;
    sections.push(
      `${heading}${shown}${
        cut
          ? `\n[Cut here: ${included} of ${total} bytes shown. Before you rely on this skill, read the rest with skill_read {"name": ${JSON.stringify(skill.name)}}.]`
          : ""
      }`,
    );
    used.push({ name: skill.name, bytes: total, includedBytes: included, truncated: cut });
    remaining -= byteLength(heading) + included;
  }
  if (sections.length === 0 && omitted.length === 0) return { bytes: 0, skills: [], omitted: [] };
  const note = omitted.length
    ? `\n\n[Not shown for lack of room: ${omitted.map((name) => JSON.stringify(name)).join(", ")}. They apply as well: read each with skill_read before you start.]`
    : "";
  const text = `${preamble}\n\n<${tag}>\n${sections.join("\n\n")}${note}\n</${tag}>`;
  return { text, bytes: byteLength(text), skills: used, omitted };
}

export function renderLoadedSkills(skills: readonly LoadableSkill[], maxBytes: number): SkillBlock {
  if (skills.length === 0) return { bytes: 0, skills: [], omitted: [] };
  return renderBlock("loaded_skills", LOADED_SKILLS_PREAMBLE, skills, maxBytes);
}

export function renderPinnedSkills(skills: readonly LoadableSkill[], maxBytes: number): SkillBlock {
  if (skills.length === 0) return { bytes: 0, skills: [], omitted: [] };
  return renderBlock("pinned_skills", PINNED_SKILLS_PREAMBLE, skills, maxBytes);
}
