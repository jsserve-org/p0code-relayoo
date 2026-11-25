// Pure helpers: no imports, so they are tested without the p0code workspace.

export type TunnelKind = "http" | "tcp";

export interface Tunnel {
  readonly id: string;
  readonly kind: TunnelKind;
  /** The server-assigned URL (HTTP) or host:port (TCP). Never built locally. */
  readonly publicAddress: string | null;
  readonly localHost: string;
  readonly localPort: number;
  readonly name: string | null;
  readonly online: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.toLowerCase());

export const isValidPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** The CLI's own check for `stop`. */
export const isTunnelId = (id: string) => /^[a-f0-9]{32}$/.test(id);

/** Relay's URL prefix rule: 1–40 lowercase letters, digits and hyphens. */
export const isValidTunnelName = (name: string) => /^[a-z0-9-]{1,40}$/.test(name);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

/** One tunnel as `relayoo list` / `create` print it; unknown fields are ignored. */
export function parseTunnel(value: unknown): Tunnel | null {
  if (!isRecord(value)) return null;
  const { id, kind, local_host, local_port } = value;
  if (typeof id !== "string" || (kind !== "http" && kind !== "tcp")) return null;
  if (typeof local_port !== "number" || !isValidPort(local_port)) return null;
  return {
    id,
    kind,
    publicAddress: stringOrNull(value.url) ?? stringOrNull(value.address),
    localHost: typeof local_host === "string" ? local_host : "127.0.0.1",
    localPort: local_port,
    name: stringOrNull(value.name),
    online: value.online === true,
  };
}

export function parseTunnelList(value: unknown): ReadonlyArray<Tunnel> | null {
  const rows = isRecord(value) && Array.isArray(value.tunnels) ? value.tunnels : value;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((row) => {
    const tunnel = parseTunnel(row);
    return tunnel === null ? [] : [tunnel];
  });
}

/** An existing tunnel that already forwards this kind and loopback port. */
export function findReusable(
  tunnels: ReadonlyArray<Tunnel>,
  want: { readonly kind: TunnelKind; readonly localPort: number },
): Tunnel | undefined {
  return tunnels.find(
    (tunnel) =>
      tunnel.kind === want.kind &&
      tunnel.localPort === want.localPort &&
      isLoopbackHost(tunnel.localHost),
  );
}

/** The host and port of this p0code server's loopback origin, as Relay's `--local-host` wants it. */
export function parseLocalOrigin(origin: string): { readonly host: string; readonly port: number } {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!isLoopbackHost(host) || !isValidPort(port)) {
    throw new Error(`Not a loopback origin: ${origin}`);
  }
  return { host: host === "localhost" ? "127.0.0.1" : host, port };
}

/**
 * A bare HTTP(S) origin, or null. Like the CLI's device login, plain HTTP is only accepted for
 * localhost, so credentials never cross the network in the clear.
 */
export function normalizeServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

export function createArgs(input: {
  readonly kind: TunnelKind;
  readonly localPort: number;
  readonly localHost?: string;
  readonly name?: string;
}): ReadonlyArray<string> {
  return [
    "create",
    input.kind,
    "--local-port",
    String(input.localPort),
    ...(input.localHost ? ["--local-host", input.localHost] : []),
    ...(input.name ? ["--name", input.name] : []),
  ];
}
