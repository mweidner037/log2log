# Log2Log

Convert a log of mutations into a log of key-value store changes.

In the language of [this article](https://mattweidner.com/2024/06/04/server-architectures.html), Log2Log is designed to help implement a collaboration system that sends _mutations_ (high-level operations, like event sourcing events) from client->server but _state changes_ (low-level operations, like SQL row updates) from server->client.

## Commands

- Lint with `pnpm lint`.
- Test with `pnpm test`. Use `pnpm coverage` for code coverage (opens in browser).
- Build with `pnpm build`.
- Preview typedoc with `pnpm run docs`. (Open `docs/index.html` in a browser.)
- Publish with `pnpm publish`.
