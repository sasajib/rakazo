import { BotSecretAuth } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runLoginKind } from "@rakazo/db";
import type { BotSecretScope } from "./vault-access.js";
import { usableVaultFields } from "./vault-access.js";
import { vaultItemTitle } from "./vault-items.js";

/**
 * Fork: a fill that names a saved login by its title, or with other case or spacing, means the
 * saved login when exactly one matches; and a name nothing matches is answered with the names
 * there are, so the agent can correct itself. Only names, titles and sites are read here, which
 * list_secrets already shows: no value is decrypted.
 */

/** Letters and digits only, lower case: "ZZ vf-other", "zz_vf other" and "zz-vf-other" are one key. */
export function loginNameKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

type SavedLogin = { name: string; title: string; origin: string; alsoOn: string[] };

/** The saved website logins this run may use. */
async function usableLogins(prisma: PrismaClient, scope: BotSecretScope): Promise<SavedLogin[]> {
  const rows = await prisma.vaultCredential.findMany({
    where: await usableVaultFields(prisma, scope),
    select: { name: true, title: true, origin: true, auth: true, alsoOn: true },
    orderBy: { name: "asc" },
  });
  return rows
    .filter((row) => BotSecretAuth.safeParse(row.auth).data?.type === "login")
    .map((row) => ({
      name: row.name,
      title: vaultItemTitle(
        { name: row.name, origin: row.origin, title: row.title ?? "" },
        undefined,
      ),
      origin: row.origin,
      alsoOn: row.alsoOn ?? [],
    }));
}

function matching(logins: readonly SavedLogin[], given: string): SavedLogin[] {
  const key = loginNameKey(given);
  if (!key) return [];
  return logins.filter(
    (login) => loginNameKey(login.name) === key || loginNameKey(login.title) === key,
  );
}

/**
 * The saved name a fill means. An exact name always wins (this run's unsaved login first, as the
 * fill reads it); otherwise the one login whose name or title matches without case, spacing or
 * punctuation. None or several: the name as given, which the fill then refuses.
 */
export async function savedLoginName(
  prisma: PrismaClient,
  scope: BotSecretScope,
  runId: string,
  given: string,
): Promise<string> {
  const name = given.trim();
  if (!name) return given;
  const exact = await prisma.vaultCredential.count({
    where: { ...(await usableVaultFields(prisma, scope)), name },
  });
  if (exact) return given;
  const runLogin = await prisma.secret.count({
    where: { userId: scope.userId, spaceId: scope.spaceId, kind: runLoginKind(runId, name) },
  });
  if (runLogin) return given;
  const matches = matching(await usableLogins(prisma, scope), name);
  return matches.length === 1 ? matches[0]!.name : given;
}

/** The browser_act steps, or vault_fill call, with each login named as it is saved. */
export async function withSavedLoginNames(
  prisma: PrismaClient,
  scope: BotSecretScope,
  runId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resolved = new Map<string, string>();
  const saved = async (given: unknown): Promise<unknown> => {
    if (typeof given !== "string" || !given.trim()) return given;
    if (!resolved.has(given))
      resolved.set(given, await savedLoginName(prisma, scope, runId, given));
    return resolved.get(given);
  };
  let next = args;
  if (typeof args.secret === "string" && Array.isArray(args.fills)) {
    const secret = await saved(args.secret);
    if (secret !== args.secret) next = { ...next, secret };
  }
  if (Array.isArray(args.actions)) {
    let changed = false;
    const actions: unknown[] = [];
    for (const raw of args.actions) {
      const step = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
      if (step && (step.kind === "fill_secret" || step.kind === "fill_code")) {
        const secret = await saved(step.secret);
        if (secret !== step.secret) {
          changed = true;
          actions.push({ ...step, secret });
          continue;
        }
      }
      actions.push(raw);
    }
    if (changed) next = { ...next, actions };
  }
  return next;
}

const LISTED = 20;
const quoted = (login: SavedLogin) =>
  loginNameKey(login.title) === loginNameKey(login.name)
    ? login.name
    : `${login.name} (${JSON.stringify(login.title)})`;

function listed(logins: readonly SavedLogin[]): string {
  const shown = logins.slice(0, LISTED).map(quoted).join(", ");
  return logins.length > LISTED ? `${shown}, and ${logins.length - LISTED} more` : shown;
}

/**
 * What a fill is told when no usable login has the name it gave: the names it could have meant.
 * Those saved for the page's site when the page is known and has any, else every usable login.
 */
export async function unknownLoginError(
  prisma: PrismaClient,
  scope: BotSecretScope,
  given: string,
  pageUrl: string | undefined,
): Promise<string> {
  const none = "Login is unavailable. Use request_secret to save it first.";
  let logins: SavedLogin[];
  try {
    logins = await usableLogins(prisma, scope);
  } catch {
    return none;
  }
  if (!logins.length) return none;
  const several = matching(logins, given);
  if (several.length > 1)
    return `Login is unavailable under that name: ${several.length} saved logins match it. Pass the exact name as secret: ${listed(several)}.`;
  const page = pageUrl && URL.canParse(pageUrl) ? new URL(pageUrl).origin : "";
  const here = page
    ? logins.filter((login) => login.origin === page || login.alsoOn.includes(page))
    : [];
  if (here.length)
    return `Login is unavailable under that name. Saved logins for ${page}: ${listed(here)}. Pass one of these names as secret.`;
  return `Login is unavailable under that name. ${page ? `None is saved for ${page}. ` : ""}Saved logins: ${listed(logins)}. Pass a name as secret, or use request_secret to save a new one.`;
}
