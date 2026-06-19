# Log2Log

Convert a log of mutations into a log of key-value store changes.

In the language of [this article](https://mattweidner.com/2024/06/04/server-architectures.html), Log2Log is designed to help implement a collaboration system that sends _mutations_ (high-level operations, like event sourcing events) from client->server but _state changes_ (low-level operations, like SQL row updates) from server->client.

Log2Log assumes a specific key-value store structure: values are keyed by a model type and an id, with all models defined in a `typeToModel` const satisfying `BaseTypeToModel`. Various classes and interfaces then input `typeof typeToModel` as a generic type parameter `TTM` (usually inferred). The model definitions include various types and method needed by the key-value store; see `defineModel`.

The Log2Log class is designed for use on a central collaboration server. Clients connected to that server should use ReconciliationClient, a key-value store replica that accept changes from the server **and** supports optimistic client operations using [server reconciliation](https://mattweidner.com/2024/06/04/server-architectures.html#1-server-reconciliation).

## Commands

- Lint with `pnpm lint`.
- Test with `pnpm test`. Use `pnpm coverage` for code coverage (opens in browser).
- Build with `pnpm build`.
- Preview typedoc with `pnpm run docs`. (Open `docs/index.html` in a browser.)
- Publish with `pnpm publish`.
