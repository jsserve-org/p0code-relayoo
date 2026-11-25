import { PluginContext, PluginError, type PluginServices } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  DEFAULT_SERVER,
  type RelayStatus,
  type RelayTunnel,
  type SetServerInput,
  type ShareLocalPortInput,
  type StopTunnelInput,
  type TunnelResult,
} from "./actions.ts";
import { type CliPaths, cliCommand, downloadCli, runStreaming, runToCompletion } from "./cli.ts";
import {
  classifyConnectLine,
  cliErrorMessage,
  cliFileName,
  isAuthFailure,
  type LoginPrompt,
  needsCliRefresh,
  nextBackoffMs,
  parseCredentials,
  parseLoginPrompt,
  redact,
} from "./cliProtocol.ts";
import {
  createArgs,
  findReusable,
  normalizeServerUrl,
  parseLocalOrigin,
  parseTunnel,
  parseTunnelList,
  type TunnelKind,
} from "./tunnels.ts";

const SERVER_KEY = "server";
const CLI_MAX_AGE = Duration.hours(12);
const CLI_RETRY_AFTER_FAILURE = Duration.minutes(10);
const SIGNED_OUT = "Sign in to Relay first.";

interface RuntimeState {
  readonly pendingSignIn: LoginPrompt | null;
  readonly connection: RelayStatus["connection"];
  readonly error: string | null;
}

function statusLine(status: RelayStatus): string {
  if (status.error) return status.error;
  if (status.pendingSignIn) return "Waiting for approval in Relay";
  if (!status.signedIn) return "Not signed in";
  const host = new URL(status.server).host;
  switch (status.connection) {
    case "connected":
      return `Connected to ${host}`;
    case "starting":
      return `Connecting to ${host}…`;
    case "reconnecting":
      return `Reconnecting to ${host}…`;
    case "failed":
      return "Disconnected";
    case "off":
      return "Signed in";
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const makeRelayoo = Effect.fn("relayoo.make")(function* () {
  const ctx = yield* PluginContext;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<PluginServices>();
  const provided = <A, E>(effect: Effect.Effect<A, E, PluginServices>) =>
    effect.pipe(Effect.provideContext(services));
  const pluginScope = yield* Effect.scope;
  const state = yield* Ref.make<RuntimeState>({
    pendingSignIn: null,
    connection: "off",
    error: null,
  });
  // List-then-create must not race another create.
  const tunnelLock = yield* Semaphore.make(1);
  const configPath = path.join(ctx.dataDir, "relay", "credentials.json");
  let cliCache: { readonly server: string; readonly refreshAt: number } | null = null;
  let connectScope: Scope.Closeable | null = null;
  let signInScope: Scope.Closeable | null = null;

  const readServer = ctx.storage
    .get(SERVER_KEY)
    .pipe(Effect.map(Option.getOrElse(() => DEFAULT_SERVER)));

  /** Credentials for the configured server; a file for another server counts as signed out. */
  const readCredentials = Effect.gen(function* () {
    const server = yield* readServer;
    const stored = yield* fs.readFileString(configPath).pipe(
      Effect.map(parseCredentials),
      Effect.orElseSucceed(() => null),
    );
    return stored !== null && stored.server === server ? stored : null;
  });

  const status = Effect.gen(function* () {
    const [server, credentials, runtime] = yield* Effect.all([
      readServer,
      readCredentials,
      Ref.get(state),
    ]);
    return {
      server,
      signedIn: credentials !== null,
      agentId: credentials?.agentId ?? null,
      pendingSignIn: runtime.pendingSignIn,
      connection: runtime.connection,
      error: runtime.error,
    } satisfies RelayStatus;
  });

  const publishStatus: Effect.Effect<void> = status.pipe(
    Effect.flatMap((current) => ctx.reportStatus(statusLine(current))),
    Effect.ignore,
  );

  const setState = (update: Partial<RuntimeState>) =>
    Ref.update(state, (current) => ({ ...current, ...update })).pipe(Effect.andThen(publishStatus));

  /** The server's own CLI: fetched on first use, then rechecked every 12 hours. */
  const ensureCli = Effect.gen(function* () {
    const server = yield* readServer;
    const script = path.join(ctx.dataDir, "cli", cliFileName(server));
    const now = yield* Clock.currentTimeMillis;
    if (!needsCliRefresh(cliCache, server, now)) return { server, script };
    const downloaded = yield* downloadCli(server, script).pipe(Effect.exit);
    if (Exit.isSuccess(downloaded)) {
      cliCache = { server, refreshAt: now + Duration.toMillis(CLI_MAX_AGE) };
      return { server, script };
    }
    if (!(yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* Effect.failCause(downloaded.cause);
    }
    yield* Effect.logWarning("Could not refresh the Relay CLI; using the cached copy", {
      cause: downloaded.cause,
    });
    cliCache = { server, refreshAt: now + Duration.toMillis(CLI_RETRY_AFTER_FAILURE) };
    return { server, script };
  });

  const command = (args: ReadonlyArray<string>) =>
    ensureCli.pipe(
      Effect.flatMap(({ server, script }) =>
        cliCommand({ script, config: configPath } satisfies CliPaths, server, args),
      ),
    );

  /** A one-shot CLI command for a signed-in agent; its error line becomes the action's error. */
  const runChecked = Effect.fn("relayoo.runChecked")(function* (args: ReadonlyArray<string>) {
    const credentials = yield* readCredentials;
    if (credentials === null) return yield* new PluginError({ message: SIGNED_OUT });
    const result = yield* runToCompletion(yield* command(args)).pipe(
      Effect.timeout("90 seconds"),
      Effect.mapError((error) =>
        error instanceof PluginError
          ? error
          : new PluginError({ message: "The Relay CLI did not answer in time." }),
      ),
    );
    if (result.exitCode === 0) return result.stdout;
    const message = redact(cliErrorMessage(result.stderr, result.exitCode), [credentials.token]);
    if (isAuthFailure(message)) yield* setState({ error: message });
    return yield* new PluginError({ message });
  });

  // `relayoo connect` reconnects by itself; this restarts it when the process itself ends.
  const superviseConnect = Effect.gen(function* () {
    let backoffMs = 1_000;
    while (true) {
      const credentials = yield* readCredentials;
      if (credentials === null) return yield* setState({ connection: "off" });
      yield* setState({ connection: "starting" });
      const startedAt = yield* Clock.currentTimeMillis;
      let lastLine = "";
      const exitCode = yield* runStreaming(yield* command(["connect"]), (raw) => {
        const line = redact(raw, [credentials.token]);
        lastLine = line;
        switch (classifyConnectLine(line)) {
          case "connected":
            return setState({ connection: "connected", error: null });
          case "reconnecting":
            return setState({ connection: "reconnecting" });
          case "other":
            return Effect.logDebug("relayoo connect", { line });
        }
      });
      // The CLI exits cleanly only when another connection for this agent replaced it.
      if (exitCode === 0) {
        return yield* setState({
          connection: "failed",
          error: lastLine || "Another Relay connection replaced this one.",
        });
      }
      if (isAuthFailure(lastLine)) {
        return yield* setState({
          connection: "failed",
          error: `${lastLine} Sign in to Relay again.`,
        });
      }
      const uptime = (yield* Clock.currentTimeMillis) - startedAt;
      backoffMs = nextBackoffMs(backoffMs, uptime);
      yield* Effect.logWarning("relayoo connect exited; restarting", { exitCode, backoffMs });
      yield* setState({ connection: "reconnecting" });
      yield* Effect.sleep(Duration.millis(backoffMs));
    }
  }).pipe(Effect.catch((error) => setState({ connection: "failed", error: error.message })));

  const stopConnect = Effect.gen(function* () {
    const scope = connectScope;
    connectScope = null;
    if (scope !== null) yield* Scope.close(scope, Exit.void);
    yield* Ref.update(state, (current) => ({ ...current, connection: "off" as const }));
  });

  const startConnect = Effect.gen(function* () {
    yield* stopConnect;
    if ((yield* readCredentials) === null) return;
    const scope = yield* Scope.fork(pluginScope);
    connectScope = scope;
    yield* superviseConnect.pipe(Effect.forkIn(scope));
  });

  const cancelSignIn = Effect.gen(function* () {
    const scope = signInScope;
    signInScope = null;
    if (scope !== null) yield* Scope.close(scope, Exit.void);
    yield* Ref.update(state, (current) => ({ ...current, pendingSignIn: null }));
  });

  /** Device login: the person approves the code in Relay; this only waits for it. */
  const signIn = Effect.gen(function* () {
    if ((yield* Ref.get(state)).pendingSignIn !== null) return;
    yield* cancelSignIn;
    yield* setState({ error: null });
    const login = yield* command(["login"]);
    const prompted = yield* Deferred.make<void>();
    const scope = yield* Scope.fork(pluginScope);
    signInScope = scope;
    let output = "";
    let shown = false;
    const showPrompt = (prompt: LoginPrompt) => {
      shown = true;
      return setState({ pendingSignIn: prompt }).pipe(
        Effect.andThen(Deferred.succeed(prompted, undefined)),
      );
    };
    const forget = Effect.sync(() => {
      if (signInScope === scope) signInScope = null;
    });
    yield* runStreaming(login, (line) => {
      output += `${line}\n`;
      const prompt = shown ? null : parseLoginPrompt(output);
      return prompt === null ? Effect.void : showPrompt(prompt);
    }).pipe(
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? setState({ pendingSignIn: null, error: null }).pipe(Effect.andThen(startConnect))
          : setState({ pendingSignIn: null, error: cliErrorMessage(output, exitCode) }),
      ),
      Effect.catch((error) => setState({ pendingSignIn: null, error: error.message })),
      Effect.ensuring(Deferred.succeed(prompted, undefined).pipe(Effect.andThen(forget))),
      Effect.forkIn(scope),
    );
    // Return once the code is on screen, or the login already ended.
    yield* Deferred.await(prompted).pipe(Effect.timeout("30 seconds"), Effect.ignore);
  });

  const signOut = Effect.gen(function* () {
    yield* cancelSignIn;
    yield* stopConnect;
    yield* fs.remove(configPath).pipe(Effect.ignore);
    yield* setState({ error: null });
  });

  const setServer = Effect.fn("relayoo.setServer")(function* (input: SetServerInput) {
    const server = normalizeServerUrl(input.server);
    if (server === null) {
      return yield* new PluginError({
        message: "Use an HTTPS origin, such as https://relay.yhw.tw.",
      });
    }
    if (server === (yield* readServer)) return;
    yield* cancelSignIn;
    yield* stopConnect;
    yield* ctx.storage.set(SERVER_KEY, server);
    yield* setState({ error: null });
    yield* startConnect;
  });

  const reconnect = Effect.gen(function* () {
    if ((yield* readCredentials) === null) return yield* new PluginError({ message: SIGNED_OUT });
    yield* setState({ error: null });
    yield* startConnect;
  });

  const listTunnels = Effect.gen(function* () {
    const tunnels = parseTunnelList(parseJson(yield* runChecked(["list"])));
    if (tunnels === null) {
      return yield* new PluginError({ message: "Relay returned an unexpected tunnel list." });
    }
    return tunnels;
  });

  /** Lists first and reuses a tunnel already forwarding this port; Relay assigns the address. */
  const shareTunnel = (want: {
    readonly kind: TunnelKind;
    readonly localPort: number;
    readonly localHost?: string;
    readonly name?: string;
  }) =>
    tunnelLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = findReusable(yield* listTunnels, want);
        if (existing !== undefined) return { tunnel: existing, reused: true };
        const created = parseTunnel(parseJson(yield* runChecked(createArgs(want))));
        // Fall back to the list if `create` printed a shape this plugin does not know.
        const tunnel = created ?? findReusable(yield* listTunnels, want);
        if (tunnel === undefined) {
          return yield* new PluginError({ message: "Relay did not return the new tunnel." });
        }
        return { tunnel, reused: false };
      }),
    ) satisfies Effect.Effect<TunnelResult, PluginError, PluginServices>;

  const reachThisMachine = Effect.gen(function* () {
    const origin = yield* ctx.environment.localOrigin;
    const local = yield* Effect.try({
      try: () => parseLocalOrigin(origin),
      catch: () => new PluginError({ message: "This server is not listening on loopback." }),
    });
    return yield* shareTunnel({
      kind: "http",
      localPort: local.port,
      localHost: local.host,
      name: "p0code",
    });
  });

  const stopTunnel = (input: StopTunnelInput) =>
    tunnelLock.withPermits(1)(runChecked(["stop", input.tunnelId])).pipe(
      Effect.andThen(listTunnels),
    );

  yield* publishStatus;
  yield* startConnect.pipe(Effect.forkIn(pluginScope));

  const withStatus = <E>(effect: Effect.Effect<void, E, PluginServices>) =>
    provided(effect.pipe(Effect.andThen(publishStatus), Effect.andThen(status)));
  const tunnelsOf = (tunnels: ReadonlyArray<RelayTunnel>) => ({ tunnels });

  return {
    status: () => provided(status),
    setServer: (input: SetServerInput) => withStatus(setServer(input)),
    signIn: () => withStatus(signIn),
    cancelSignIn: () => withStatus(cancelSignIn),
    signOut: () => withStatus(signOut),
    reconnect: () => withStatus(reconnect),
    reachThisMachine: () => provided(reachThisMachine),
    listTunnels: () => provided(listTunnels.pipe(Effect.map(tunnelsOf))),
    shareLocalPort: (input: ShareLocalPortInput) => provided(shareTunnel(input)),
    stopTunnel: (input: StopTunnelInput) => provided(stopTunnel(input).pipe(Effect.map(tunnelsOf))),
  };
});
