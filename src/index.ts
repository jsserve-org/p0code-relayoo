import { definePlugin } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";

import { DEFAULT_SERVER, RELAYOO_ID, relayooActions } from "./actions.ts";
import { makeRelayoo } from "./relayoo.ts";

export const relayoo = definePlugin({
  manifest: {
    id: RELAYOO_ID,
    name: "Relay",
    description:
      "Signs this machine in to a Relay server and opens HTTP or TCP tunnels to this p0code server or to local dev servers.",
    version: "0.1.0",
    unofficial: false,
    // The default server; a server set in the panel is contacted instead.
    externalServices: [new URL(DEFAULT_SERVER).host],
    capabilities: ["network:outbound", "process:spawn"],
    httpRoutes: [],
  },
  actions: relayooActions,
  start: Effect.gen(function* () {
    return { actions: yield* makeRelayoo() };
  }),
});
