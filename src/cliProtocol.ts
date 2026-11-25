// Pure helpers for the Relay CLI's text output. Written against the server's /cli.cjs;
// the CLI prints plain lines, so every parser here tolerates extra or missing lines.

export interface LoginPrompt {
  readonly verificationUrl: string;
  readonly userCode: string;
}

/** `relayoo login` prints "Open <url>" and "Check this code in your browser: <code>". */
export function parseLoginPrompt(output: string): LoginPrompt | null {
  const url = /^Open (\S+)\s*$/m.exec(output)?.[1];
  const code = /^Check this code in your browser: (\S+)\s*$/m.exec(output)?.[1];
  if (url === undefined || code === undefined) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { verificationUrl: url, userCode: code };
}

export type ConnectLine = "connected" | "reconnecting" | "other";

export function classifyConnectLine(line: string): ConnectLine {
  if (/^Agent connected\b/.test(line)) return "connected";
  if (/^Connection lost\b/.test(line)) return "reconnecting";
  return "other";
}

export interface StoredCredentials {
  readonly server: string;
  readonly agentId: string;
  /** Kept only to redact it from CLI output; never returned to callers. */
  readonly token: string;
}

/** The CLI's credentials file: `{ server, agent, token }`. */
export function parseCredentials(json: string): StoredCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { server, agent, token } = value as Record<string, unknown>;
  if (typeof server !== "string" || typeof agent !== "string" || typeof token !== "string") {
    return null;
  }
  if (!server || !agent || !token) return null;
  return { server: server.replace(/\/$/, ""), agentId: agent, token };
}

export function redact(text: string, secrets: ReadonlyArray<string>): string {
  return secrets.reduce(
    (current, secret) => (secret.length >= 8 ? current.replaceAll(secret, "<redacted>") : current),
    text,
  );
}

/** The CLI prints one error line to stderr and exits 1; fall back to the exit code. */
export function cliErrorMessage(stderr: string, exitCode: number): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? `The Relay CLI exited with code ${exitCode}.`;
}

/** Errors that mean the agent's session is gone and sign-in is needed again. */
export function isAuthFailure(message: string): boolean {
  return /authentication required|unauthori[sz]ed|forbidden|expired|revoked|invalid token|RELAY_TOKEN/i.test(
    message,
  );
}

/** Restart delay for `relayoo connect`: reset after a healthy run, double otherwise. */
export function nextBackoffMs(previousMs: number, uptimeMs: number): number {
  return uptimeMs > 60_000 ? 1_000 : Math.min(Math.max(previousMs, 500) * 2, 60_000);
}

/** Refetch `/cli.cjs` when the server changed or the cached copy is due for a check. */
export function needsCliRefresh(
  cached: { readonly server: string; readonly refreshAt: number } | null,
  server: string,
  nowMs: number,
): boolean {
  return cached === null || cached.server !== server || nowMs >= cached.refreshAt;
}

/** A file name for the cached CLI of one server, so switching servers never runs the other's. */
export function cliFileName(server: string): string {
  return `${new URL(server).host.replace(/[^a-z0-9.-]/gi, "_")}.cjs`;
}
