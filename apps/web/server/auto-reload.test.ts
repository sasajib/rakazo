import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_RELOAD_HEADER } from "../src/lib/platform/auto-reload-header.js";
import { autoReloadEnabled } from "./auto-reload.js";
import { createWebServer } from "./standalone-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function start(env: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-auto-reload-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(root, "dist", "build-id"), "20261022100000\n");
  const web: http.Server = createWebServer(root, {
    API_PROXY_TARGET: "http://127.0.0.1:9",
    RAKAZO_HOST: "app.example.test",
    SCREEN_PROXY_SECRET: "test-screen-proxy-secret-0123456789abcdef",
    ...env,
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => web.close(resolve)));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return (pathname: string) =>
    fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      headers: { host: "app.example.test" },
    });
}

describe("WEB_AUTO_RELOAD", () => {
  it("is on unless it is exactly 0", () => {
    expect(autoReloadEnabled(undefined)).toBe(true);
    expect(autoReloadEnabled("")).toBe(true);
    expect(autoReloadEnabled("1")).toBe(true);
    expect(autoReloadEnabled(" 0 ")).toBe(false);
  });

  it("serves the build id without the switch header by default", async () => {
    const get = await start({});
    const response = await get("/build-id");
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe("20261022100000");
    expect(response.headers.get(AUTO_RELOAD_HEADER)).toBeNull();
    // The app must never read a cached answer.
    expect(response.headers.get("cache-control")).toMatch(/no-cache|no-store/);
  });

  it("tells open tabs on the build id answer when the switch is off, and nowhere else", async () => {
    const get = await start({ WEB_AUTO_RELOAD: "0" });
    const response = await get("/build-id?x=1");
    expect((await response.text()).trim()).toBe("20261022100000");
    expect(response.headers.get(AUTO_RELOAD_HEADER)).toBe("0");
    expect((await get("/")).headers.get(AUTO_RELOAD_HEADER)).toBeNull();
  });
});
