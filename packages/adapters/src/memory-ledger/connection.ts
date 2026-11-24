import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { parseModelSecret } from "../models/model-secret.js";
import type { LedgerConfig } from "./config.js";
import type { ModelEndpoint } from "./model.js";
import { envModelEndpoint } from "./model.js";

type Deps = {
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">;
  secretStore: Pick<SecretStore, "load">;
};

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; endpoint: ModelEndpoint | undefined }>();

/**
 * Where the memory model is reached: the env-configured endpoint, else the run owner's own
 * OpenAI-compatible connection (the instance's configured provider, e.g. OmniRoute) that lists
 * the memory model or is named by MEMORY_LEDGER_MODEL_CONNECTION. Undefined means "no model":
 * the ledger then learns only explicit "remember …" sentences.
 */
export async function resolveModelEndpoint(
  deps: Deps,
  userId: string,
  config: LedgerConfig["model"],
  now = Date.now(),
): Promise<ModelEndpoint | undefined> {
  if (config.disabled) return undefined;
  const fromEnv = envModelEndpoint(config);
  if (fromEnv) return fromEnv;
  const key = `${userId}|${config.model}|${config.connection ?? ""}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.endpoint;
  let endpoint: ModelEndpoint | undefined;
  try {
    endpoint = await connectionEndpoint(deps, userId, config);
  } catch (error) {
    getLogger().warn("memory.ledger.connection_unreadable", {
      "error.type": error instanceof Error ? error.name : "unknown",
    });
  }
  cache.set(key, { at: now, endpoint });
  return endpoint;
}

async function connectionEndpoint(
  deps: Deps,
  userId: string,
  config: LedgerConfig["model"],
): Promise<ModelEndpoint | undefined> {
  const connections = await deps.prisma.userModelCredential.findMany({
    where: { userId },
    select: { id: true, provider: true, label: true, secretId: true },
    orderBy: { createdAt: "desc" },
  });
  const wanted = config.connection?.toLowerCase();
  for (const connection of connections) {
    if (
      wanted &&
      connection.provider.toLowerCase() !== wanted &&
      connection.label.toLowerCase() !== wanted
    )
      continue;
    const row = await deps.prisma.secret.findFirst({
      where: { id: connection.secretId, userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (!row) continue;
    let secret: ReturnType<typeof parseModelSecret>;
    try {
      secret = parseModelSecret(await deps.secretStore.load(row.ciphertext, row.id));
    } catch {
      continue;
    }
    if (secret.kind !== "openai_compatible") continue;
    const listed = [...(secret.enabledModelIds ?? []), ...Object.keys(secret.models ?? {})];
    if (!wanted && !listed.includes(config.model)) continue;
    return {
      baseUrl: secret.baseUrl,
      apiKey: secret.apiKey,
      headers: secret.headers,
      model: config.model,
    };
  }
  return undefined;
}

/** Tests only. */
export function clearModelEndpointCache(): void {
  cache.clear();
}
