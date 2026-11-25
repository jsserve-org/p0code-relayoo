import { PluginError } from "@t3tools/plugin-api";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

export interface CliPaths {
  /** The server's `/cli.cjs`, cached in the plugin's data directory. */
  readonly script: string;
  /** The CLI's credentials file, separate from any `~/.config/relay` the person has. */
  readonly config: string;
}

/** Fetches `<server>/cli.cjs` over the cached copy, written atomically. */
export const downloadCli = Effect.fn("relayoo.cli.download")(
  function* (server: string, script: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const source = yield* client.get(`${server}/cli.cjs`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout("1 minute"),
    );
    // A proxy error page is not a CLI.
    if (source.trimStart().startsWith("<") || !source.includes("relay")) {
      return yield* new PluginError({ message: `${server}/cli.cjs is not the Relay CLI.` });
    }
    yield* fs.makeDirectory(path.dirname(script), { recursive: true });
    const staging = `${script}.partial`;
    yield* fs.writeFileString(staging, source);
    yield* fs.rename(staging, script);
  },
  Effect.mapError((cause) =>
    cause instanceof PluginError
      ? cause
      : new PluginError({ message: "Could not download the Relay CLI.", cause }),
  ),
);

// Ambient RELAY_* would override the plugin's own credentials file.
const CHILD_ENV = {
  RELAY_SERVER: undefined,
  RELAY_AGENT: undefined,
  RELAY_TOKEN: undefined,
  RELAY_CONFIG: undefined,
  // The desktop app's server runs on Electron's binary.
  ELECTRON_RUN_AS_NODE: "1",
};

/** Runs the CLI with the server's own Node; a single-file build cannot run scripts, so it uses PATH. */
export const cliCommand = Effect.fn("relayoo.cli.command")(function* (
  paths: CliPaths,
  server: string,
  args: ReadonlyArray<string>,
) {
  const node = (yield* HostProcess.IsExecutable) ? "node" : yield* HostProcess.ExecutablePath;
  // The token stays in the config file, never on argv where a process listing shows it.
  return ChildProcess.make(
    node,
    [paths.script, ...args, "--config", paths.config, "--server", server],
    {
      shell: false,
      detached: false,
      extendEnv: true,
      env: CHILD_ENV,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
});

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const runToCompletion = Effect.fn("relayoo.cli.run")(
  function* (command: ChildProcess.Command) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) } satisfies CliResult;
      }),
    );
  },
  Effect.mapError((cause) => new PluginError({ message: "Could not run the Relay CLI.", cause })),
);

/** Runs a long-lived CLI command, streaming its lines; succeeds with the exit code once output ends. */
export const runStreaming = Effect.fn("relayoo.cli.stream")(
  function* (command: ChildProcess.Command, onLine: (line: string) => Effect.Effect<void>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        const [, exitCode] = yield* Effect.all(
          [
            child.all.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map((line) => line.trim()),
              Stream.filter((line) => line.length > 0),
              Stream.runForEach(onLine),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return Number(exitCode);
      }),
    );
  },
  Effect.mapError((cause) => new PluginError({ message: "Could not run the Relay CLI.", cause })),
);
