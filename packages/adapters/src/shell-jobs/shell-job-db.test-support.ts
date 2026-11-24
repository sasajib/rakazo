/**
 * A small in-memory stand-in for the Prisma delegates the background shell job code uses, so its
 * state machine, claim-once delivery, limits and stop paths run without a database. Supports the
 * `where` shapes that code writes: equality, null, `in`, `notIn`, `lt/lte/gt/gte`, `startsWith`,
 * `not`, `OR`, and `{ increment }` updates. The real SQL is covered by shell-jobs.postgres.test.ts.
 */
type Row = Record<string, unknown> & { id: string };

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date)
    return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition === "object" && !Array.isArray(condition)) {
    const c = condition as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("notIn" in c) return !(c.notIn as unknown[]).includes(value);
    if ("startsWith" in c)
      return typeof value === "string" && value.startsWith(String(c.startsWith));
    if ("not" in c) return !matchesValue(value, c.not);
    const cmp = (op: string, fn: (a: number, b: number) => boolean) =>
      !(op in c) ||
      (value instanceof Date &&
        c[op] instanceof Date &&
        fn(value.getTime(), (c[op] as Date).getTime()));
    return (
      cmp("lt", (a, b) => a < b) &&
      cmp("lte", (a, b) => a <= b) &&
      cmp("gt", (a, b) => a > b) &&
      cmp("gte", (a, b) => a >= b)
    );
  }
  return value === condition;
}

export function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((w) => matches(row, w));
    return matchesValue(row[key], condition);
  });
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else row[key] = value;
  }
  if ("updatedAt" in row) row.updatedAt = new Date();
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${(++counter).toString().padStart(6, "0")}`;

function delegate(
  rows: Row[],
  prefix: string,
  defaults: () => Record<string, unknown> = () => ({}),
) {
  const sorted = (list: Row[], orderBy: unknown) => {
    const order = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<
      string,
      string
    >[];
    return [...list].sort((a, b) => {
      for (const entry of order) {
        const [key, dir] = Object.entries(entry)[0] ?? [];
        if (!key) continue;
        const av =
          a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number | string);
        const bv =
          b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number | string);
        if (av === bv) continue;
        const less = (av ?? 0) < (bv ?? 0);
        return (less ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  return {
    rows,
    async create({ data }: { data: Record<string, unknown> }) {
      const row = {
        id: nextId(prefix),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults(),
        ...data,
      } as Row;
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }: { where: Record<string, unknown> }) {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    async findUniqueOrThrow({ where }: { where: Record<string, unknown> }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      return { ...row };
    },
    async findFirst({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) {
      const row = sorted(
        rows.filter((r) => matches(r, where)),
        orderBy,
      )[0];
      return row ? { ...row } : null;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    } = {}) {
      return sorted(
        rows.filter((r) => matches(r, where)),
        orderBy,
      )
        .slice(0, take ?? Number.POSITIVE_INFINITY)
        .map((r) => ({ ...r }));
    },
    async count({ where }: { where?: Record<string, unknown> } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      applyData(row, data);
      return { ...row };
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) applyData(row, data);
      return { count: hit.length };
    },
  };
}

export function createShellJobTestDb() {
  const tables = {
    shellJob: delegate([], "job", () => ({
      status: "running",
      exitCode: null,
      pid: null,
      startedAt: new Date(),
      finishedAt: null,
      pollErrors: 0,
      cancelRequested: false,
      returnedAt: null,
      deliveredAs: null,
      wakeRunId: null,
      cwd: null,
    })),
    bot: delegate([], "bot", () => ({ archivedAt: null })),
    computer: delegate([], "cmp"),
    thread: delegate([], "thr"),
    spaceMember: delegate([], "mem"),
    run: delegate([], "run", () => ({ lane: null })),
    task: delegate([], "tsk"),
    message: delegate([], "msg"),
  };
  // spaceMember is read by its compound key.
  const spaceMember = {
    ...tables.spaceMember,
    async findUnique({
      where,
    }: {
      where: { spaceId_userId: { spaceId: string; userId: string } };
    }) {
      const key = where.spaceId_userId;
      const row = tables.spaceMember.rows.find(
        (r) => r.spaceId === key.spaceId && r.userId === key.userId,
      );
      return row ? { ...row } : null;
    },
  };
  const client = {
    ...tables,
    spaceMember,
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?");
      if (sql.includes("FROM runs") && sql.includes("status = 'queued'")) {
        const run = tables.run.rows.find((r) => r.id === values[0] && r.status === "queued");
        return run ? [{ id: run.id }] : [];
      }
      return [{ id: values[0] }];
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
      // Serialised like the thread lock: one transaction at a time.
      const previous = client.lock;
      let release!: () => void;
      client.lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(client);
      } finally {
        release();
      }
    },
    lock: Promise.resolve() as Promise<void>,
  };
  return client;
}

export type ShellJobTestDb = ReturnType<typeof createShellJobTestDb>;

/** Space, owner, bot, thread and computer rows the job code reads. */
export function seedShellJobWorld(db: ShellJobTestDb, computerId: string) {
  const ids = {
    spaceId: "space1",
    userId: "user1",
    botId: "bot1",
    threadId: "thread1",
    computerId,
  };
  db.bot.rows.push({ id: ids.botId, spaceId: ids.spaceId, archivedAt: null });
  db.thread.rows.push({ id: ids.threadId, spaceId: ids.spaceId });
  db.spaceMember.rows.push({ id: "member1", spaceId: ids.spaceId, userId: ids.userId });
  db.computer.rows.push({
    id: computerId,
    homeKey: "home",
    kind: "docker",
    providerRef: "local",
    state: "running",
  });
  db.message.rows.push({
    id: "owner-message",
    threadId: ids.threadId,
    role: "user",
    seq: 1,
    createdAt: new Date(Date.now() - 60_000),
    clientNonce: null,
  });
  return ids;
}
