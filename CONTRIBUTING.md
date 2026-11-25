# Contributing

This is the Relay (Relayoo) plugin for [p0code](https://github.com/p0code/p0code): it signs a p0code
server in to a Relay instance and opens the tunnels that make the machine reachable.

Contributions are welcome — issues and small, focused PRs. I'm one busy person, so reviews and
replies can take a while. Please be patient and don't ping repeatedly; one bump after a couple of
weeks is fine.

## Setup

This repo is the package root and only builds inside a p0code workspace (it uses `workspace:*` and
`catalog:` dependencies and extends `../../tsconfig.base.json`). Clone both side by side, then from
the p0code root:

```sh
pnpm install
pnpm --filter @t3tools/plugin-relayoo typecheck
pnpm --filter @t3tools/plugin-relayoo test
```

The CLI-output parsing and tunnel logic in `src/cliProtocol.ts` and `src/tunnels.ts` are
dependency-free, so their tests also run with any vitest outside the workspace (alias
`vite-plus/test` to `vitest`).

## What makes a PR easy to land

- One thing per PR, with tests for behaviour changes.
- Conventional-commit-ish messages (`fix: ...`, `feat: ...`, `docs: ...`).
- No drive-by refactors or reformatting.
- Don't log or surface the Relay token, and keep credentials off command lines.

## License

MIT. By contributing you agree that your work is released under the MIT license. See
[LICENSE](LICENSE).
