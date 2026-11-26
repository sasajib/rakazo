/**
 * Fork. Response header on `/build-id`: `0` when the deployment switched automatic reloads off
 * (`WEB_AUTO_RELOAD=0`). No imports: the web server loads this file too.
 */
export const AUTO_RELOAD_HEADER = "x-rakazo-auto-reload";
