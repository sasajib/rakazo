import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { shellJobMarkerId } from "./shell-job-rules.js";
import type { ParsedShellJobProbe } from "./shell-job-scripts.js";
import {
  killArgv,
  parseProbeOutput,
  probeArgv,
  shellJobMarkerPrefix,
} from "./shell-job-scripts.js";

/** Output the poller keeps for the result: the end of each stream, where failures print. */
export const RESULT_STDOUT_BYTES = 12_000;
export const RESULT_STDERR_BYTES = 4_000;

export async function collectProcess(
  events: AsyncIterable<ProcessEvent>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}

export class ShellJobProbeError extends Error {
  override readonly name = "ShellJobProbeError";
}

/** One read-only exec on the computer: the job's state and the end of its output. */
export async function probeShellJob(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  jobId: string,
  context: AdapterContext,
  bytes: { stdout: number; stderr: number } = {
    stdout: RESULT_STDOUT_BYTES,
    stderr: RESULT_STDERR_BYTES,
  },
): Promise<ParsedShellJobProbe> {
  const read = await collectProcess(
    sandbox.execute(
      computer,
      { argv: probeArgv(jobId, bytes.stdout, bytes.stderr), timeoutMs: 20_000 },
      context,
    ),
  );
  const parsed = read.code === 0 ? parseProbeOutput(read.stdout, read.stderr) : null;
  if (!parsed) throw new ShellJobProbeError(`job probe returned code ${read.code ?? "none"}`);
  return parsed;
}

/** Stops the job's processes on the computer. Best effort: a computer that is gone has no job left. */
export async function killShellJobProcesses(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  jobId: string,
  context: AdapterContext,
): Promise<boolean> {
  try {
    const result = await collectProcess(
      sandbox.execute(
        computer,
        {
          argv: killArgv(jobId, shellJobMarkerPrefix(computerId, shellJobMarkerId(jobId))),
          timeoutMs: 20_000,
        },
        context,
      ),
    );
    return result.code === 0;
  } catch {
    return false;
  }
}
