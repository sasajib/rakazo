/**
 * Fork (1.36): a tool that changes files on the computer runs in the order the model wrote it.
 *
 * Pi runs one model step's tool calls at the same moment unless one of them is sequential; then
 * the whole step runs in order. A step such as "shell: make the screenshot" + "read_file: look at
 * it" therefore read the file before the command had made it and failed with "file not found";
 * the same call succeeded one step later. Marking the writers sequential makes such a step run
 * as written. A step of reads only (several read_file, list_files) still runs at once.
 *
 * On unless COMPUTER_WRITES_IN_ORDER is "0" (also "false" / "off"), which restores upstream.
 */
const COMPUTER_WRITING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "write_file",
  "render_plot",
]);

export function computerWritesInOrderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.COMPUTER_WRITES_IN_ORDER ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

export function writesComputerFiles(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return COMPUTER_WRITING_TOOL_NAMES.has(toolName) && computerWritesInOrderEnabled(env);
}
