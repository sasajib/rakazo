import type { IncomingMessage, ServerResponse } from "node:http";
import { AUTO_RELOAD_HEADER } from "../src/lib/platform/auto-reload-header.js";

/** Fork kill switch: `WEB_AUTO_RELOAD=0` leaves open tabs only the "New version" notice. Default on. */
export function autoReloadEnabled(value: string | undefined): boolean {
  return value?.trim() !== "0";
}

/**
 * Open tabs read `/build-id` before every automatic reload; when the switch is off, that answer
 * says so in a header, so a running tab learns it without a new route or a rebuilt bundle.
 */
export function autoReloadHeaderMiddleware(enabled: boolean) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!enabled && req.url?.split("?", 1)[0] === "/build-id") {
      res.setHeader(AUTO_RELOAD_HEADER, "0");
    }
    next();
  };
}
