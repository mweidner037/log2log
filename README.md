# log2log

Convert a log of mutations into a log of key-value store changes.

In the language of [this article](https://mattweidner.com/2024/06/04/server-architectures.html), the library is designed to help implement server reconciliation in a system that sends client->erver mutations and server->client state changes.

## Commands

- Build with `npm run build`.
- Test, lint, etc. with `npm run test`. Use `npm run coverage` for code coverage (opens in browser).
- Preview typedoc with `npm run docs`. (Open `docs/index.html` in a browser.)
- Publish with `npm publish`.
