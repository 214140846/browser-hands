# Browser Hands — notes for coding agents

Chrome extension (`extension/`) + local MCP server (`server/`).

## Rules
- Behaviour of each module is defined by `specs/<module>.md` and `test/unit/<module>.test.ts`. Change the spec in the same commit when behaviour changes.
- Run `bun run check` before handing in; it must be all green.
- End-to-end tests live in `test/` and need a real Chrome: `bun run test:e2e`.
- Do not copy code from other browser extensions. Contributions must be your own work under the MIT license.
- User-facing text is English.
