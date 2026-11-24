/**
 * Whether this deployment's host computer ("Use this computer") serves its whole display, so its
 * computers show a live screen and offer the desktop tools like a Docker computer. The host
 * server knows it (see HostDisplay); the API and worker read it from SANDBOX_HOST_SCREEN, set
 * beside SANDBOX_HOST_URL. Off by default: the desktop app's own host has no screen driver here.
 */
export function hostComputerServesScreen(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SANDBOX_HOST_SCREEN?.trim() ?? "");
}

/** Whether a computer of this kind shows a live screen although it runs on the user's machine. */
export function userMachineServesScreen(
  kind: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return kind === "desktop" && hostComputerServesScreen(env);
}
