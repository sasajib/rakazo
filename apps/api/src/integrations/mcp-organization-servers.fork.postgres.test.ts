import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

// FORK.md 1.29 (upstream bug carried as a local patch). On upstream 50de80b1f an organization's
// server has no Space, so its `availability.spaceIds` was empty, which the reply schema refuses:
// `mcp/servers/createForOrganization` stored the row and answered 500, and from then on
// `mcp/servers/list` answered 500 for every member of that organization.
describe.skipIf(!enabled)("an organization's MCP server over the API (PostgreSQL, fork)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `orgapi-org-${suffix}`;
  const spaceId = `orgapi-space-${suffix}`;
  const adminId = `orgapi-admin-${suffix}`;
  const memberId = `orgapi-member-${suffix}`;
  const secrets = new EncryptedSecretStore("fake-org-mcp-api-test-encryption-key");
  const actorOf = (userId: string): Actor => ({
    spaceId,
    userId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  });
  const admin = actorOf(adminId);
  const member = actorOf(memberId);
  const client = (actor: Actor) =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        remoteConnectors: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        },
        events: { notify: vi.fn() },
        env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
        dataDir: "/tmp/mcp-organization-db-test",
      } as unknown as RouterDeps),
      { context: { actor } },
    );
  const as = <T>(actor: Actor, fn: (rpc: ReturnType<typeof client>) => Promise<T>) =>
    runAsTenant(actor, () => fn(client(actor)));
  const remote = (name: string, host: string) => ({
    transport: "streamable_http" as const,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    name,
    endpoint: `https://${host}/mcp`,
    headers: {},
    enabled: true,
  });

  beforeAll(() =>
    runAsSystem("organization MCP API fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = withSecretPersistence(db.prisma, secrets);
      await prisma.organization.create({
        data: { id: organizationId, name: "Org API", slug: organizationId, createdAt: new Date() },
      });
      for (const [userId, role] of [
        [adminId, "owner"],
        [memberId, "member"],
      ] as const) {
        await prisma.user.create({
          data: { id: userId, name: userId, email: `${userId}@example.test` },
        });
        await prisma.member.create({
          data: { id: `${userId}-m`, organizationId, userId, role, createdAt: new Date() },
        });
      }
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId,
          name: "Team",
          isDefault: true,
          createdByUserId: adminId,
        },
      });
      for (const userId of [adminId, memberId])
        await prisma.spaceMember.create({
          data: {
            id: `${userId}-sm`,
            spaceId,
            organizationId,
            userId,
            role: userId === adminId ? "owner" : "member",
            createdAt: new Date(),
          },
        });
    }),
  );
  afterAll(() =>
    runAsSystem("organization MCP API fixture", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
        await prisma.$disconnect();
        await db.pool.end();
      }
      await secrets.close();
    }),
  );

  it("creates it for an admin and lists it for every member", async () => {
    const own = await as(admin, (rpc) => rpc.mcp.servers.create(remote("Own Tools", "own.test")));
    expect(own.availability?.spaceIds).toEqual([spaceId]);

    const created = await as(admin, (rpc) =>
      rpc.mcp.servers.createForOrganization(remote("Team Tools", "team.test")),
    );
    expect(created).toMatchObject({ name: "Team Tools", organization: true, manageable: true });
    // It is in no one Space: it reads as in the viewer's, and names no Space list of its own.
    expect(created.spaceId).toBe(spaceId);
    expect(created.availability).toBeUndefined();
    const stored = await runAsSystem("organization MCP API check", () =>
      prisma.mcpServer.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(stored).toMatchObject({ organizationId, userId: null, spaceId: null, allBots: true });

    const forAdmin = await as(admin, (rpc) => rpc.mcp.servers.list());
    expect(forAdmin.map((row) => row.name).sort()).toEqual(["Own Tools", "Team Tools"]);
    const forMember = await as(member, (rpc) => rpc.mcp.servers.list());
    expect(forMember).toHaveLength(1);
    expect(forMember[0]).toMatchObject({
      id: created.id,
      organization: true,
      manageable: false,
      allBots: true,
    });

    // The owner's "where is it available" list holds only what he owns, and still answers.
    const items = await as(admin, (rpc) => rpc.availability.items());
    expect(items.map((item) => item.id)).toContain(own.id);
    expect(items.map((item) => item.id)).not.toContain(created.id);

    // Editing answers too (the same reply shape).
    const renamed = await as(admin, (rpc) =>
      rpc.mcp.servers.update({
        id: created.id,
        config: { ...remote("Team Tools", "team.test"), description: "shared" },
      }),
    );
    expect(renamed).toMatchObject({ organization: true, description: "shared" });
  });

  it("lists the other servers when one row cannot be read", async () => {
    // A row no reply can carry (a revision is positive): written by an older or newer build.
    const broken = await runAsSystem("organization MCP API broken row", () =>
      prisma.mcpServer.create({
        data: {
          spaceId,
          userId: adminId,
          slug: "broken",
          name: "Broken",
          description: "",
          transport: "streamable_http",
          endpoint: "https://broken.test/mcp",
          revision: 0,
        },
      }),
    );
    try {
      const listed = await as(admin, (rpc) => rpc.mcp.servers.list());
      expect(listed.map((row) => row.name).sort()).toEqual(["Own Tools", "Team Tools"]);
    } finally {
      await runAsSystem("organization MCP API broken row", () =>
        prisma.mcpServer.delete({ where: { id: broken.id } }),
      );
    }
  });
});
