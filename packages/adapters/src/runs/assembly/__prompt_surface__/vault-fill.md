# vault_fill surface (run with a configured MCP browser, page browser off)

## tool
Type a saved login into a page of the MCP browser you drive; you never see the values. It only types while that page is on the login's own HTTPS site (or one of its alsoOn sites), a password only into a password field. Open the sign-in page in your own tab and take a snapshot first. Fill every field of the form in one call, then press its submit button with the browser's own tools.

```json
{
  "type": "object",
  "properties": {
    "secret": {
      "type": "string",
      "description": "The login's name from list_secrets. Leave out only to type the code the user just entered for request_secret oneTimeCode"
    },
    "server": {
      "type": "string",
      "description": "The MCP browser server's name; optional when there is only one"
    },
    "page": {
      "type": [
        "string",
        "number"
      ],
      "description": "The tab's page id in that browser"
    },
    "fills": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "ref": {
            "type": "string",
            "description": "The field's ref from the browser's snapshot"
          },
          "field": {
            "type": "string",
            "description": "A field of the login: its label, or username / password"
          },
          "code": {
            "type": "boolean",
            "description": "true types the login's authenticator code instead of a field"
          }
        },
        "required": [
          "ref"
        ]
      }
    }
  },
  "required": [
    "page",
    "fills"
  ]
}
```

## sign-in guidance in the tool usage line
- Use request_secret with a credential destination to save reusable API credentials, or with auth type login when the user wants a website login saved; fill it with vault_fill, which only works on its site and its alsoOn sites. When your shell commands need a secret value, use request_secret with auth type command; it is exported as the environment variable that request_secret and list_secrets report.
- To sign in to a website in the browser you drive through its MCP tools: check list_secrets for a login saved for it, open the site's sign-in page in your own tab, take a snapshot, call vault_fill with the page id and each field's ref (code: true types the authenticator code when list_secrets shows authenticatorCode), then press the submit button with the browser's own tools. You never see or type the values yourself. For a code the site sends the user, use request_secret oneTimeCode, then vault_fill with code: true and no secret, never chat. Use request_takeover only after that, for a captcha or a step the saved login cannot answer. When no login is saved for the site, offer to save one with request_secret (auth type login) instead of asking for the password.
- When you need a new password or key, such as for a website sign-up or a database you set up, use generate_secret instead of choosing one.
- Use list_secrets to discover saved names, secret_request to make authenticated requests without reading credentials, and forget_secret to revoke access.
- Never ask for a raw credential in chat or inject it into shell commands.
