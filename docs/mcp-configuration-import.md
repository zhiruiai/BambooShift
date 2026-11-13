# Import remote MCP configuration

Web, desktop and mobile use the same workspace service to preview remote MCP addresses. In **Connect apps → Add connection → Import MCP configuration**, paste a JSON object with `mcpServers` or VS Code `servers`, preview the supported services, and choose one to fill the connection form.

Review its full address and authentication method before saving. A catalog address selects its recommended authentication method only on an exact match. Applying an import clears the previous token and sharing confirmation. Replacing a nonempty form requires confirmation; editing the form invalidates that replacement confirmation.

Importing is not installation or authorization. It does not create a connection, discover tools, start a command, or grant a Bot access. Save each reviewed connection through the existing connection flow.

## Processing and boundaries

1. The client parses at most 65,536 UTF-16 code units and 100 entries. It keeps only names and HTTPS address strings. Entries containing `command` or `args`, unsupported transports, URL credentials, query strings or fragments are excluded. Headers, tokens, environment variables and other configuration fields are not copied.
2. The original pasted JSON is cleared. Only the projected names, addresses and skipped count are sent to the current workspace's preview endpoint.
3. Rust checks the owner and expected account, normalizes addresses using the existing `url` component, filters unsupported host forms, and removes canonical duplicates. This stage does not perform DNS resolution, contact an MCP service, open a workspace store or invoke a worker.
4. Selecting a preview only fills the form. Saving uses the existing connection validation, DNS checks, authentication, persistence and tool-discovery flow. A syntactically acceptable public domain is not proof that its DNS destination or service will be accepted.

Names are limited to 80 UTF-16 code units. Original and canonical addresses are each limited to 2,048 UTF-8 bytes. Only HTTPS on the default port is supported. IP literals, private/local host suffixes, dotless hosts, control/format characters and legacy SSE transport are excluded.

Unicode domains and paths, percent escapes, default ports and path normalization are handled in one place. Flutter's RFC-oriented `Uri` parser is not used to approximate browser IDNA behavior. The feature adds no URL parser dependency or native platform bridge.

## Preview API

`POST /api/workspaces/:workspaceId/apps/import/preview` accepts:

```json
{
  "candidates": [
    { "name": "Documentation", "url": "https://docs.example.com/mcp" }
  ],
  "skipped": 0
}
```

It returns `candidates`, `skipped`, and `error` (`null` or `"empty"`). The total candidate and skipped count cannot exceed 100. Unknown request fields are rejected, including credential fields. This endpoint permits a bounded 256 KiB body so valid multilingual configurations fit; other application endpoints retain their existing limits.

Preview requires the workspace owner and the normal account, membership and request checks. An old server without this endpoint produces an update prompt; manual connection entry remains available. Cancelled previews, unmounted views, account/workspace changes and permission loss cannot apply a late result.

## Verification

The [acceptance record](evidence/mcp-import-20261113.json) separates real backend HTTP checks, browser interaction and Flutter widget coverage from provider sign-in and physical-device testing.

- Shared synthetic inputs: [remote-mcp-import.json](../shared/fixtures/remote-mcp-import.json).
- Rust API authorization, canonicalization, limits and absence of connection creation: [apps_import_preview.rs](../server/api/tests/apps_import_preview.rs).
- Web projection and lifecycle tests: [remoteMcpImport.shared.test.ts](../web/src/remoteMcpImport.shared.test.ts), [remoteMcpImport.interaction.test.ts](../web/src/remoteMcpImport.interaction.test.ts), and [browser flow](../web/src/browserTests/mcp-config-import.browser.test.ts).
- Flutter projection, transport and interaction tests: [remote_mcp_import_test.dart](../mobile/test/remote_mcp_import_test.dart), [mcp_import_preview_test.dart](../mobile/test/mcp_import_preview_test.dart), and [mcp_import_widgets_test.dart](../mobile/test/mcp_import_widgets_test.dart).

The tests use synthetic configuration and credentials. They do not establish compatibility with every provider's sign-in flow. Local command MCP installation and unattended batch connection creation are not part of this importer.
