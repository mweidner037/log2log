# Log2Log

TypeScript library to convert a log of mutations (event sourcing events) into a log of changes to a target key-value store.

## Commands

- Lint with `pnpm lint`.
- Test with `pnpm test`.

## Code rules

### Configuration

- TypeScript is in strict mode, with `any` not allowed. If you are stuck on a TypeScript error or want to define a complex type signature, ask in the chat. Important: Do not add your own uses of ts-ignore or ts-expect-error.
- Do not change any configuration files, including tsconfig.json. If you really think it is necessary, ask for confirmation first.
- Use normal TypeScript imports without file extensions.

### Style

- Prefer complete sentences for comments (ending with a period).
- File and folder names are kebab-case.
- Avoid `Array.forEach`; prefer for-of loops.

### Linting

After finishing a large task, run `pnpm format` to fix prettier errors, then run `pnpm lint` to double-check for TypeScript/Eslint errors. (The VSCode integration should automatically provide you with TypeScript/Eslint errors and format files while you are working, so only do this as a final double-check.)

## Unit Tests

Unit tests use Mocha + Chai and are always written in TypeScript. Prefer Chai's `assert` over `expect`. Test files end in `.test.ts`, and their folder structure should mirror the src/ folder - e.g., tests for `src/foo/bar.ts` are in `test/foo/bar.test.ts`.

If you write unit tests, check that they compile with `pnpm lint:tsc_test`. If you write unit tests or are instructed to ensure existing tests pass, run them with `pnpm test -- -f "test search string"`.
