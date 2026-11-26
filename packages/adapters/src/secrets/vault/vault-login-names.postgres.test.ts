import { randomUUID } from "node:crypto";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relabelVaultItem, resolveLoginFill, storeBotSecret } from "../bot-secrets.js";
import { EncryptedSecretStore } from "../secrets.js";
import { savedLoginName, unknownLoginError, withSavedLoginNames } from "./vault-login-names.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** Fork: the name lookups of vault-login-names.ts against the real schema and row security. */
describePostgres("saved login names", () => {
  const address = `login-names-${randomUUID()}@example.test`;
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const site = "https://login.example.test";
  let db: ReturnType<typeof createDb>;
  let scope: { userId: string; spaceId: string };

  beforeAll(async () => {
    db = createDb(url!);
    scope = await runAsSystem("login names fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const save = (name: string, origin: string, password: string) =>
      runAsTenant(scope, () =>
        storeBotSecret({
          prisma: db.prisma,
          secretStore,
          scope,
          destination: { name, origin, auth: { type: "login" } } as BotSecretDestination,
          plaintext: JSON.stringify({
            fields: [{ label: "Password", value: password, hidden: true }],
          }),
        }),
      );
    await save("zz-vf-other", site, "fake-password-one");
    await save("elsewhere", "https://other.example.test", "fake-password-two");
    await runAsTenant(scope, () =>
      relabelVaultItem(db.prisma, scope, "zz-vf-other", { title: "ZZ vf-other" }),
    );
  });

  afterAll(async () => {
    if (scope) {
      const system = asSystem(db.prisma);
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: scope.spaceId } });
      await system.user.deleteMany({ where: { id: scope.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("finds the saved name behind a title, and fills with it", async () => {
    await runAsTenant(scope, async () => {
      for (const given of ["ZZ vf-other", "zz vf other", "ZZ-VF-OTHER", "zz-vf-other"]) {
        expect(await savedLoginName(db.prisma, scope, "run-1", given)).toBe("zz-vf-other");
      }
      expect(await savedLoginName(db.prisma, scope, "run-1", "nothing")).toBe("nothing");
      const args = await withSavedLoginNames(db.prisma, scope, "run-1", {
        secret: "ZZ vf-other",
        page: 1,
        fills: [{ ref: "e1", field: "password" }],
      });
      expect(args.secret).toBe("zz-vf-other");
      expect(
        await resolveLoginFill({
          prisma: db.prisma,
          secretStore,
          scope,
          runId: "run-1",
          name: String(args.secret),
          field: "password",
        }),
      ).toMatchObject({ text: "fake-password-one", origin: site });
    });
  });

  it("answers an unknown name with the site's names and no value", async () => {
    await runAsTenant(scope, async () => {
      const refused = await resolveLoginFill({
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "nothing",
        field: "password",
        pageUrl: `${site}/login`,
      });
      expect(refused).toEqual({
        error: `Login is unavailable under that name. Saved logins for ${site}: zz-vf-other. Pass one of these names as secret.`,
      });
      const anywhere = await unknownLoginError(db.prisma, scope, "nothing", undefined);
      expect(anywhere).toContain('Saved logins: elsewhere ("other.example.test"), zz-vf-other');
      expect(anywhere).not.toContain("fake-password");
    });
  });
});
