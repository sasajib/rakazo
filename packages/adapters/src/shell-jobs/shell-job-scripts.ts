/**
 * The bash the background shell jobs run on a Linux computer (fork). Each is passed as `bash -c
 * <script> <name> <args...>`: nothing the model wrote is ever pasted into script text, it only
 * arrives as a positional argument.
 *
 * Layout of one job, under the exec user's home: `~/.rakazo/jobs/<id>/` with `out`, `err`, `pid`
 * and, once the command ended, `exit` (written atomically through `exit.tmp`). The wrapper holds fd
 * 9 on the same `/tmp/rakazo-background-<computerId>-job_<id>-<uuid>` marker the shell tool already
 * uses, so the idle probe keeps the computer awake while the job runs and never suspends it under
 * the job.
 */

const MARKER_PREFIX = "/tmp/rakazo-background-";

/** Where a job's folder is, resolved on the computer from the job id ($1). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
const JOB_DIR = 'dir="${HOME:-/tmp}/.rakazo/jobs/$1"';

/**
 * Runs as the job's session leader (setsid). $1 computer id, $2 marker id (job_<id>), $3 uuid,
 * $4 job folder, $5 limit in seconds, $6 the command.
 */
export const SHELL_JOB_WRAPPER = [
  'dir="$4"',
  `printf '%s' "$$" > "$dir/pid.tmp" && mv -f "$dir/pid.tmp" "$dir/pid"`,
  `marker="${MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  `exec 9>"$marker" || { printf '90' > "$dir/exit.tmp"; mv -f "$dir/exit.tmp" "$dir/exit"; exit 90; }`,
  "set +o noclobber",
  "if command -v timeout >/dev/null 2>&1; then",
  '  timeout --signal=TERM --kill-after=10 "$5" bash -lc "$6" > "$dir/out" 2> "$dir/err" < /dev/null',
  "else",
  '  bash -lc "$6" > "$dir/out" 2> "$dir/err" < /dev/null',
  "fi",
  "code=$?",
  `printf '%s' "$code" > "$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"`,
  'exit "$code"',
].join("\n");

/**
 * Starts the job detached, then streams its output for at most $8 tenths of a second or until it
 * ended: stdout carries `out`, stderr carries `err`, each byte once. $1 computer id, $2 marker id,
 * $3 uuid, $4 job id, $5 limit in seconds, $6 the command, $7 the wrapper script. Exits 0 once the
 * job started (its own status is read by the probe), 91/92 when it could not start. Job folders
 * older than 7 days are swept on the way.
 */
export const SHELL_JOB_START = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'root="${HOME:-/tmp}/.rakazo/jobs"',
  'dir="$root/$4"',
  'mkdir -p "$dir" || exit 91',
  'find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true',
  ': > "$dir/out"; : > "$dir/err"; rm -f "$dir/exit" "$dir/exit.tmp" "$dir/pid"',
  'setsid bash -c "$7" rakazo-job "$1" "$2" "$3" "$dir" "$5" "$6" < /dev/null > /dev/null 2>&1 &',
  "i=0",
  'while [ ! -s "$dir/pid" ] && [ "$i" -lt 50 ]; do sleep 0.05; i=$((i + 1)); done',
  '[ -s "$dir/pid" ] || exit 92',
  'ticks="$8"; o=0; e=0; i=0',
  'size() { stat -c %s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null || echo 0; }',
  "emit() {",
  '  s="$(size "$dir/out")"',
  '  if [ "$s" -gt "$o" ]; then tail -c +"$((o + 1))" "$dir/out" | head -c "$((s - o))"; o="$s"; fi',
  '  s="$(size "$dir/err")"',
  '  if [ "$s" -gt "$e" ]; then tail -c +"$((e + 1))" "$dir/err" | head -c "$((s - e))" >&2; e="$s"; fi',
  "}",
  "while :; do",
  '  ended=0; [ -e "$dir/exit" ] && ended=1',
  "  emit",
  '  [ "$ended" = 1 ] && break',
  '  [ "$i" -ge "$ticks" ] && break',
  "  sleep 0.1; i=$((i + 1))",
  "done",
  "exit 0",
].join("\n");

/**
 * One read-only look at a job: the first stdout line is `present=0|1 alive=0|1 exit=<code or
 * empty>`, the rest of stdout is the last $2 bytes of `out`, stderr the last $3 bytes of `err`.
 * $1 job id. "alive" means the wrapper (its cmdline names rakazo-job) still runs under its pid.
 */
export const SHELL_JOB_PROBE = [
  JOB_DIR,
  'if [ ! -d "$dir" ]; then echo "present=0 alive=0 exit="; exit 0; fi',
  'code=""; [ -e "$dir/exit" ] && code="$(cat "$dir/exit" 2>/dev/null)"',
  'pid="$(cat "$dir/pid" 2>/dev/null)"',
  "alive=0",
  'if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q "rakazo-job"; then alive=1; fi',
  'echo "present=1 alive=$alive exit=$code"',
  '[ "$2" -gt 0 ] && tail -c "$2" "$dir/out" 2>/dev/null',
  '[ "$3" -gt 0 ] && tail -c "$3" "$dir/err" >&2 2>/dev/null',
  "exit 0",
].join("\n");

/**
 * Stops a job: TERM, then KILL after up to 5 s, to every process that holds this job's marker on
 * fd 9, plus the rest of its session while the wrapper is verified alive. A pid alone is never
 * trusted: after a reboot it may belong to something else. $1 job id, $2 marker prefix
 * (`/tmp/rakazo-background-<computerId>-job_<id>-`).
 */
export const SHELL_JOB_KILL = [
  JOB_DIR,
  'prefix="$2"',
  'pid="$(cat "$dir/pid" 2>/dev/null)"',
  "leader=0",
  'if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q "rakazo-job"; then leader=1; fi',
  "members() {",
  "  for p in /proc/[0-9]*; do",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  '    n="${p#/proc/}"',
  '    target="$(readlink "$p/fd/9" 2>/dev/null)" || target=""',
  '    case "$target" in "$prefix"*) echo "$n"; continue ;; esac',
  '    if [ "$leader" = 1 ]; then',
  '      { read -r line < "$p/stat"; } 2>/dev/null || continue',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  '      rest="${line##*) }"',
  "      set -- $rest",
  '      [ "$4" = "$pid" ] && echo "$n"',
  "    fi",
  "  done",
  "}",
  'for n in $(members); do kill -TERM "$n" 2>/dev/null; done',
  "i=0",
  'while [ "$i" -lt 20 ] && [ -n "$(members)" ]; do sleep 0.25; i=$((i + 1)); done',
  'for n in $(members); do kill -KILL "$n" 2>/dev/null; done',
  "exit 0",
].join("\n");

export function shellJobMarkerPrefix(computerId: string, markerId: string): string {
  return `${MARKER_PREFIX}${computerId}-${markerId}-`;
}

/** How the job's folder is shown to the model; the computer resolves it under its home. */
export function shellJobDisplayDir(jobId: string): string {
  return `~/.rakazo/jobs/${jobId}`;
}

export function startArgv(input: {
  computerId: string;
  markerId: string;
  uuid: string;
  jobId: string;
  limitSeconds: number;
  command: string;
  waitMs: number;
}): string[] {
  return [
    "bash",
    "-c",
    SHELL_JOB_START,
    "rakazo-job-start",
    input.computerId,
    input.markerId,
    input.uuid,
    input.jobId,
    String(Math.max(1, Math.ceil(input.limitSeconds))),
    input.command,
    SHELL_JOB_WRAPPER,
    String(Math.max(0, Math.ceil(input.waitMs / 100))),
  ];
}

export function probeArgv(jobId: string, outBytes: number, errBytes: number): string[] {
  return [
    "bash",
    "-c",
    SHELL_JOB_PROBE,
    "rakazo-job-probe",
    jobId,
    String(Math.max(0, Math.floor(outBytes))),
    String(Math.max(0, Math.floor(errBytes))),
  ];
}

export function killArgv(jobId: string, markerPrefix: string): string[] {
  return ["bash", "-c", SHELL_JOB_KILL, "rakazo-job-kill", jobId, markerPrefix];
}

export interface ParsedShellJobProbe {
  present: boolean;
  alive: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Parses SHELL_JOB_PROBE's output. Null when the first line is not the status line. */
export function parseProbeOutput(stdout: string, stderr: string): ParsedShellJobProbe | null {
  const newline = stdout.indexOf("\n");
  const head = newline < 0 ? stdout : stdout.slice(0, newline);
  const match = /^present=([01]) alive=([01]) exit=(-?\d*)\s*$/.exec(head);
  if (!match) return null;
  const code = match[3] ?? "";
  return {
    present: match[1] === "1",
    alive: match[2] === "1",
    exitCode: code === "" ? null : Number(code),
    stdout: newline < 0 ? "" : stdout.slice(newline + 1),
    stderr,
  };
}
