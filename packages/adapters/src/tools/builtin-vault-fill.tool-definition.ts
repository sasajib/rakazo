import type { ConnectorTool } from "@rakazo/adapter-kit";
import { VAULT_FILL_TOOL } from "../secrets/vault/vault-mcp-fill.js";

/** Fork: offered only to a run that reaches a configured MCP browser (see vault-mcp-fill.ts). */
export const vaultFillToolDefinitions: ConnectorTool[] = [
  {
    name: VAULT_FILL_TOOL,
    description:
      "Type a saved login into a page of the MCP browser you drive; you never see the values. It only types while that page is on the login's own HTTPS site (or one of its alsoOn sites), a password only into a password field. Open the sign-in page in your own tab and take a snapshot first. Fill every field of the form in one call, then press its submit button with the browser's own tools.",
    inputSchema: {
      type: "object",
      properties: {
        secret: {
          type: "string",
          description:
            "The login's name from list_secrets. Leave out only to type the code the user just entered for request_secret oneTimeCode",
        },
        server: {
          type: "string",
          description: "The MCP browser server's name; optional when there is only one",
        },
        page: { type: ["string", "number"], description: "The tab's page id in that browser" },
        fills: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "The field's ref from the browser's snapshot" },
              field: {
                type: "string",
                description: "A field of the login: its label, or username / password",
              },
              code: {
                type: "boolean",
                description: "true types the login's authenticator code instead of a field",
              },
            },
            required: ["ref"],
          },
        },
      },
      required: ["page", "fills"],
    },
  },
];
