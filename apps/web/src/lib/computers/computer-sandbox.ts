import { t } from "@lingui/core/macro";
import type { ComputerStatus, Me } from "@rakazo/contracts";
import { rpc } from "../query/rpc";
import { errorText } from "../query/user-error";

/**
 * Whether the computer is the user's own machine. A server from before `runsOnUserMachine` says
 * so only by its kind; drop that reading once such servers are no longer supported.
 */
export function runsOnUserMachine(
  computer: Pick<ComputerStatus, "kind" | "runsOnUserMachine"> | null | undefined,
): boolean {
  return computer?.runsOnUserMachine ?? computer?.kind === "desktop";
}

/**
 * Whether the computer is the user's own machine with no screen to show here. A host that serves
 * its display (`userMachineScreen`) shows it like any computer.
 */
export function screenlessUserMachine(
  computer:
    | Pick<ComputerStatus, "kind" | "runsOnUserMachine" | "userMachineScreen">
    | null
    | undefined,
): boolean {
  return runsOnUserMachine(computer) && computer?.userMachineScreen !== true;
}

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

/** Whether an account may run its computers on its own provider on this deployment. */
export function canChooseOwnComputer(sandboxProvider: string | null | undefined): boolean {
  // Those deployments run every computer on the server's own provider.
  return (
    !!sandboxProvider &&
    !computersAreUnavailable(sandboxProvider) &&
    sandboxProvider !== "desktop" &&
    sandboxProvider !== "fake"
  );
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
