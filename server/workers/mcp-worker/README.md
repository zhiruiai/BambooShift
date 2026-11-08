# MCP protocol executor

This process implements protocol execution with the official MCP client SDK. Rust owns connections, account/session authorization, approval records, OAuth transactions, credentials and business storage. This package does not import the old Node application server, read a database or load environment configuration.

The Rust parent sends one bounded JSON operation on stdin: `tools`, `call`, `prepare`, `exchange`, `refresh` or `revoke`. Credentials exist only in the operation's memory. Before each external dispatch the worker emits an `authorize` frame and waits for Rust's affirmative answer. Rust checks the original actor, source grant and connection revision again. A result is returned once; transport failures never replay an operation.

The executor retains HTTPS endpoint validation, DNS address pinning, redirect rejection, bounded JSON/SSE responses, OAuth discovery, PKCE, resource binding, dynamic client registration and token revocation from the official SDK integration. Explicit constructor-only loopback fixture origins exist for local tests; they are never accepted by application HTTP endpoints or read from environment variables.

Rust starts this worker with a cleared environment, a bounded process slot and a separate process group. Cancellation, timeout, account revocation, shutdown and a lost HTTP caller kill and wait for the executor before releasing its slot. Killing a process cannot roll back an external operation, so the approval result remains unknown after an in-flight failure.

Reference protocol: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
