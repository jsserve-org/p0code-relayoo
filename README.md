# p0code Relay plugin

A [p0code](https://github.com/p0code/p0code) server plugin for [Relay](https://relay.yhw.tw)
(Relayoo). It signs this machine in to a Relay server as an agent, keeps the agent connected, and
opens tunnels:

- **Reach this machine via Relay**: one HTTP tunnel to this p0code server, so you can open it from
  anywhere through a Relay URL.
- **Share a local port**: HTTP or TCP tunnels to a loopback port, for dev servers, databases and
  the like.

It is off by default. Nothing is installed globally: the plugin downloads the server's own CLI
(`<server>/cli.cjs`) into its data directory and runs it with the Node that runs p0code.

## How it works

| Piece | What the plugin does |
| --- | --- |
| CLI | Fetches `<server>/cli.cjs` on first use and rechecks it every 12 hours, one cached file per server. If the server is unreachable, the cached copy keeps working. |
| Sign in | Runs `relayoo login --server URL --config <dataDir>/relay/credentials.json` (Relay's OAuth device flow) and shows the approval URL and code in the settings panel. You approve it in Relay; the plugin only waits. |
| Connection | While enabled and signed in, supervises `relayoo connect` and restarts it with backoff. It stops if Relay rejects the credential, or if another connection for the same agent replaces it. |
| Tunnels | Runs `relayoo list` before every create and reuses a tunnel already forwarding the same kind and port. Addresses are always the ones the server assigns. |

The credentials file lives in the plugin's data directory, mode 0600, written by the CLI. It is
separate from any `~/.config/relay` you use yourself. The token never appears on a command line,
in the status line, in action results or in logs, and `RELAY_SERVER`, `RELAY_AGENT`, `RELAY_TOKEN`
and `RELAY_CONFIG` from the server's environment are not passed to the CLI.

### Actions

Schemas are in [`src/actions.ts`](src/actions.ts), exported as `@t3tools/plugin-relayoo/actions`.

| Action | Input | Output |
| --- | --- | --- |
| `status` | `{}` | `RelayStatus` |
| `setServer` | `{ server }` (an HTTPS origin; HTTP only for localhost) | `RelayStatus` |
| `signIn` / `cancelSignIn` / `signOut` / `reconnect` | `{}` | `RelayStatus` |
| `reachThisMachine` | `{}` | `{ tunnel, reused }` |
| `listTunnels` | `{}` | `{ tunnels }` |
| `shareLocalPort` | `{ kind: "http" \| "tcp", localPort, name? }` | `{ tunnel, reused }` |
| `stopTunnel` | `{ tunnelId }` | `{ tunnels }` |

`RelayStatus` is `{ server, signedIn, agentId, pendingSignIn, connection, error }`, where
`connection` is `off`, `starting`, `connected`, `reconnecting` or `failed`. A tunnel is
`{ id, kind, publicAddress, localHost, localPort, name, online }`. Errors from Relay, quota errors
included, are returned as action errors with Relay's own message.

## Security model

A tunnel makes a service on this machine reachable from the internet.

- **Who can reach a tunnel.** Anyone who has its address. HTTP tunnels get a URL with a random
  suffix, and TCP tunnels get a public host and port. Treat the address as the only thing keeping
  strangers out, and stop tunnels you no longer need.
- **Reach this machine.** The tunnel exposes this p0code server's HTTP and WebSocket surface.
  p0code's own sign-in and pairing still apply, but the login page and any unauthenticated route
  become reachable from the internet.
- **Shared ports.** Whatever listens on that port is exposed as-is. Most dev servers have no
  authentication at all.
- **The Relay server sees the traffic.** TLS ends at the Relay server, which forwards requests to
  this machine over the agent's WebSocket. Whoever runs the Relay server can read and change what
  passes through.
- **The Relay server runs code here.** The plugin runs the `cli.cjs` the configured server
  publishes, so it is only as trustworthy as that server. Only HTTPS servers are accepted
  (localhost excepted).
- **Offline tunnels keep their address.** Disabling the plugin or signing out stops the
  connection, so Relay shows an offline page; the reservation remains until you stop it.
- **Signing out deletes the local credential only.** To revoke the agent itself, remove it in the
  Relay panel.

## Enabling it in p0code

Plugins are bundled at build time, one repo each, mounted as a git submodule:

```sh
git submodule add https://github.com/jsserve-org/p0code-relayoo plugins/relayoo
```

Then:

1. Add `"@t3tools/plugin-relayoo": "workspace:*"` to the dependencies of `apps/server` and
   `apps/web`.
2. In `apps/server/src/plugins/registry.ts`, import `relayoo` from `@t3tools/plugin-relayoo` and
   add it to `bundledPlugins`.
3. Copy [`web/RelayooPanel.tsx`](web/RelayooPanel.tsx) to
   `apps/web/src/components/settings/RelayooPanel.tsx` and register it in `PLUGIN_PANELS` in
   `apps/web/src/components/settings/PluginsSettings.tsx`:

   ```tsx
   import { RELAYOO_ID } from "@t3tools/plugin-relayoo/actions";
   import { RelayooDisclosure, RelayooPanel } from "./RelayooPanel";

   [RELAYOO_ID]: { Disclosure: RelayooDisclosure, Panel: RelayooPanel },
   ```

4. Run `pnpm install`, then `pnpm --filter @t3tools/plugin-relayoo typecheck` and
   `pnpm --filter @t3tools/plugin-relayoo test`.

In p0code, open **Settings → Plugins**, turn on **Relay** (needs the administrative
`relay:configure` scope), press **Sign in to Relay**, and approve the code in Relay.

Node: the CLI runs on the server's own Node (`process.execPath`, with `ELECTRON_RUN_AS_NODE=1` for
the desktop app). A single-file executable build cannot run scripts, so there the plugin uses
`node` from `PATH`, which must be Node 22 or later.

## Development

This repo is the package root and only builds inside the p0code workspace (`workspace:*` and
`catalog:` dependencies, `tsconfig` extending `../../tsconfig.base.json`). The CLI-output parsing
and tunnel logic live in dependency-free modules ([`src/cliProtocol.ts`](src/cliProtocol.ts),
[`src/tunnels.ts`](src/tunnels.ts)), so their tests also run outside the workspace with any
vitest, as long as `vite-plus/test` is aliased to `vitest`.

Use `pnpm` for everything in these docs and scripts.
