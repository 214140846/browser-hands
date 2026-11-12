# Contributing to ThunderMCP

Thanks for helping out. This guide covers the dev setup, how the repo is laid out, and how changes get merged.

## Development setup

You need [Bun](https://bun.sh), Node.js 18+ and Chrome.

```sh
bun install
bun run setup      # registers the native messaging host pointing at your checkout
bun run mcp        # starts the MCP server from source
bun run build      # bundles server/cli.ts into dist/thundermcp.mjs
```

## Repository layout

| Path | What lives there |
|---|---|
| `extension/` | The Chrome extension (Manifest V3): service worker, content scripts, popup/options pages. Plain JS, no build step. |
| `server/` | The local side: `mcp.ts` (MCP server), `host.ts` (native messaging host), `install.ts` (host registration), `cli.ts` (bundle entry). |
| `specs/` | Behavior contract for each module, one file per module (`specs/<module>.md`). |
| `test/unit/` | One test file per module (`test/unit/<module>.test.ts`), plus `fakes/` for the Chrome API. |
| `scripts/` | Helper scripts, including `check.sh`, the test runner. |
| `install.sh` | One-line installer for end users. |

## Specs are the contract

Every module's behavior is defined in `specs/<module>.md`, and `test/unit/<module>.test.ts` checks it. When you change behavior:

1. Update the spec first (or in the same commit).
2. Update or add unit tests to match.
3. Then change the code.

A PR that changes behavior without touching the spec and tests will be sent back. Pure refactors that keep the spec true don't need spec changes. Exported signatures follow the spec, not the other way around.

## Running tests

```sh
bun run check                      # all test files
sh scripts/check.sh test/unit/keys.test.ts   # selected files
```

`check` runs **each test file in its own process**. Some modules attach listeners to the global `chrome` object when they are imported, so running files together in one process makes them interfere with each other. The command prints one `ok` / `FAIL` line per file and exits non-zero if any file fails. Everything must be green before you open a PR.

End-to-end tests (`test/*.test.ts`, drive a real Chrome with the extension loaded) run with `bun run test:e2e`. Tests prefixed `real-jev` need a Jev API key and skip themselves without one.

## Debugging the extension locally

1. Run `bun run setup` once. It prints the extension ID (fixed by the `key` in `manifest.json`) and writes the native host manifest.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
3. After editing extension code, click the reload icon on the extension card. Inspect the service worker via the "service worker" link on the same card.
4. Register the server with your agent, for example:
   `claude mcp add thundermcp -s user -- bun /path/to/checkout/server/mcp.ts`

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `spec:` (optionally with a scope, e.g. `fix(input): ...`).
- Keep PRs focused: one change, with its spec and test updates.
- Fork, branch from `main`, run `bun run check`, then open a PR describing what changed and why. Link related issues.
- A maintainer reviews; please address comments with new commits and we will squash on merge.

## Code of conduct

Be kind and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

ThunderMCP is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the MIT License.
