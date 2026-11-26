import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Fork: settings the web server reads. The web container has its own short environment list, which
 * `compose-env.test.ts` (api and worker) does not cover.
 */
const WEB_KEYS = ["WEB_AUTO_RELOAD"];
const composeDir = path.resolve(import.meta.dirname, "../../compose");

describe("web container environment", () => {
  it("reads each key by its literal name in the web server", () => {
    const source = readFileSync(
      path.resolve(composeDir, "../../apps/web/server/preview-middleware.ts"),
      "utf8",
    );
    for (const key of WEB_KEYS) expect(source).toContain(`read("${key}")`);
  });

  it.each([
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose.images.yml",
    "docker-compose.standalone.yml",
  ])("%s passes the fork's web settings to the web service", (file) => {
    const compose = parse(readFileSync(path.join(composeDir, file), "utf8"), { merge: true }) as {
      services: Record<string, { environment?: Record<string, unknown> }>;
    };
    const environment = Object.keys(compose.services.web?.environment ?? {});
    for (const key of WEB_KEYS) expect(environment).toContain(key);
  });
});
