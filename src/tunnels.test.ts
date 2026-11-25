import { describe, expect, it } from "vite-plus/test";

import {
  createArgs,
  findReusable,
  normalizeServerUrl,
  parseLocalOrigin,
  parseTunnel,
  parseTunnelList,
} from "./tunnels.ts";

const http3000 = {
  id: "a".repeat(32),
  kind: "http",
  url: "https://demo-x1y2z3w4.relay.yhw.tw",
  local_host: "127.0.0.1",
  local_port: 3000,
  name: "demo",
  online: true,
  agent_id: "agent-1",
};
const tcp5432 = {
  id: "b".repeat(32),
  kind: "tcp",
  address: "tcp.relay.yhw.tw:40001",
  local_host: "::1",
  local_port: 5432,
  online: false,
};

describe("parseTunnel", () => {
  it("keeps the server-assigned URL or TCP address", () => {
    expect(parseTunnel(http3000)?.publicAddress).toBe(http3000.url);
    expect(parseTunnel(tcp5432)).toEqual({
      id: tcp5432.id,
      kind: "tcp",
      publicAddress: "tcp.relay.yhw.tw:40001",
      localHost: "::1",
      localPort: 5432,
      name: null,
      online: false,
    });
  });

  it("rejects rows it cannot trust", () => {
    expect(parseTunnel({ ...http3000, kind: "udp" })).toBeNull();
    expect(parseTunnel({ ...http3000, local_port: 70000 })).toBeNull();
    expect(parseTunnel("nope")).toBeNull();
  });

  it("reads a bare array or a { tunnels } object and skips bad rows", () => {
    expect(parseTunnelList([http3000, { id: 1 }, tcp5432])).toHaveLength(2);
    expect(parseTunnelList({ tunnels: [http3000] })).toHaveLength(1);
    expect(parseTunnelList({ error: "x" })).toBeNull();
  });
});

describe("findReusable", () => {
  const tunnels = parseTunnelList([http3000, tcp5432]) ?? [];

  it("matches kind and loopback port", () => {
    expect(findReusable(tunnels, { kind: "http", localPort: 3000 })?.id).toBe(http3000.id);
    expect(findReusable(tunnels, { kind: "tcp", localPort: 5432 })?.id).toBe(tcp5432.id);
  });

  it("does not reuse another kind or port", () => {
    expect(findReusable(tunnels, { kind: "tcp", localPort: 3000 })).toBeUndefined();
    expect(findReusable(tunnels, { kind: "http", localPort: 3001 })).toBeUndefined();
  });
});

describe("parseLocalOrigin", () => {
  it("reads IPv4 and IPv6 loopback origins", () => {
    expect(parseLocalOrigin("http://127.0.0.1:3773")).toEqual({ host: "127.0.0.1", port: 3773 });
    expect(parseLocalOrigin("http://[::1]:3773")).toEqual({ host: "::1", port: 3773 });
    expect(parseLocalOrigin("http://localhost:3773")).toEqual({ host: "127.0.0.1", port: 3773 });
  });

  it("refuses anything that is not loopback", () => {
    expect(() => parseLocalOrigin("http://192.168.1.2:3773")).toThrow();
  });
});

describe("normalizeServerUrl", () => {
  it("accepts HTTPS origins and HTTP only on localhost", () => {
    expect(normalizeServerUrl(" https://relay.yhw.tw/ ")).toBe("https://relay.yhw.tw");
    expect(normalizeServerUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeServerUrl("http://relay.yhw.tw")).toBeNull();
    expect(normalizeServerUrl("https://relay.yhw.tw/api")).toBeNull();
    expect(normalizeServerUrl("https://user:pw@relay.yhw.tw")).toBeNull();
    expect(normalizeServerUrl("not a url")).toBeNull();
  });
});

describe("createArgs", () => {
  it("builds the CLI's create command", () => {
    expect(createArgs({ kind: "tcp", localPort: 443 })).toEqual([
      "create",
      "tcp",
      "--local-port",
      "443",
    ]);
    expect(createArgs({ kind: "http", localPort: 3773, localHost: "::1", name: "p0code" })).toEqual(
      ["create", "http", "--local-port", "3773", "--local-host", "::1", "--name", "p0code"],
    );
  });
});
