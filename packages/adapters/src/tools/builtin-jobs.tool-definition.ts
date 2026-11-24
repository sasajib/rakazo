import type { ConnectorTool } from "@rakazo/adapter-kit";

/**
 * Background shell job tools (fork). `shell` starts the jobs; these follow and stop them. Pinned in
 * the core tool list: a bot that would have to find_tool them first sometimes never does.
 */
export const JOB_TOOL_NAMES = ["job_list", "job_status", "job_output", "job_stop"] as const;
export const JOB_TOOL_NAME_SET: ReadonlySet<string> = new Set(JOB_TOOL_NAMES);

const jobId = { type: "string", description: "Job id from shell." } as const;

export const jobTools: ConnectorTool[] = [
  {
    name: "job_list",
    description:
      "List this bot's background shell jobs: running ones and those that ended in the last day.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "job_status",
    description:
      "One background job's status and the end of its output. Results come back by themselves; use this only when the user asks.",
    inputSchema: { type: "object", properties: { job_id: jobId }, required: ["job_id"] },
    readOnly: true,
  },
  {
    name: "job_output",
    description: "Read the end of a background job's stdout and stderr from the computer.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: jobId,
        tail_bytes: { type: "integer", minimum: 1, maximum: 64000, description: "Default 16000." },
      },
      required: ["job_id"],
    },
    readOnly: true,
  },
  {
    name: "job_stop",
    description: "Stop a background job that no longer matters. A stopped job reports nothing.",
    inputSchema: {
      type: "object",
      properties: { job_id: jobId, reason: { type: "string", maxLength: 200 } },
      required: ["job_id"],
    },
  },
];
