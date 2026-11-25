import * as Schema from "effect/Schema";

export const RELAYOO_ID = "relayoo";
export const DEFAULT_SERVER = "https://relay.yhw.tw";

export const RelayConnection = Schema.Literals([
  "off",
  "starting",
  "connected",
  "reconnecting",
  "failed",
]);
export type RelayConnection = typeof RelayConnection.Type;

export const RelayStatus = Schema.Struct({
  server: Schema.String,
  signedIn: Schema.Boolean,
  agentId: Schema.NullOr(Schema.String),
  /** A device code waiting for the person to approve it in the Relay panel. */
  pendingSignIn: Schema.NullOr(
    Schema.Struct({ verificationUrl: Schema.String, userCode: Schema.String }),
  ),
  /** The supervised `relayoo connect` process that carries tunnel traffic. */
  connection: RelayConnection,
  error: Schema.NullOr(Schema.String),
});
export type RelayStatus = typeof RelayStatus.Type;

export const TunnelKind = Schema.Literals(["http", "tcp"]);
export type TunnelKind = typeof TunnelKind.Type;

export const RelayTunnel = Schema.Struct({
  id: Schema.String,
  kind: TunnelKind,
  /** Exactly what the server assigned: a URL for HTTP, host:port for TCP. */
  publicAddress: Schema.NullOr(Schema.String),
  localHost: Schema.String,
  localPort: Schema.Number,
  name: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
});
export type RelayTunnel = typeof RelayTunnel.Type;

export const TunnelList = Schema.Struct({ tunnels: Schema.Array(RelayTunnel) });
export type TunnelList = typeof TunnelList.Type;

export const TunnelResult = Schema.Struct({ tunnel: RelayTunnel, reused: Schema.Boolean });
export type TunnelResult = typeof TunnelResult.Type;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const ShareLocalPortInput = Schema.Struct({
  kind: TunnelKind,
  localPort: Port,
  /** A URL prefix suggestion; the server decides the final address. */
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/))),
});
export type ShareLocalPortInput = typeof ShareLocalPortInput.Type;

export const StopTunnelInput = Schema.Struct({
  tunnelId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
});
export type StopTunnelInput = typeof StopTunnelInput.Type;

export const SetServerInput = Schema.Struct({ server: Schema.String });
export type SetServerInput = typeof SetServerInput.Type;

const NoInput = Schema.Struct({});

/** The actions the settings panel calls through `plugins.invoke`. */
export const relayooActions = {
  status: { input: NoInput, output: RelayStatus },
  setServer: { input: SetServerInput, output: RelayStatus },
  signIn: { input: NoInput, output: RelayStatus },
  cancelSignIn: { input: NoInput, output: RelayStatus },
  signOut: { input: NoInput, output: RelayStatus },
  reconnect: { input: NoInput, output: RelayStatus },
  /** An HTTP tunnel to this p0code server, reused when one exists. */
  reachThisMachine: { input: NoInput, output: TunnelResult },
  listTunnels: { input: NoInput, output: TunnelList },
  shareLocalPort: { input: ShareLocalPortInput, output: TunnelResult },
  stopTunnel: { input: StopTunnelInput, output: TunnelList },
} as const;
export type RelayooAction = keyof typeof relayooActions;
