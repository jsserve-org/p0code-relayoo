import { describe, expect, it } from "vite-plus/test";

import {
  classifyConnectLine,
  cliErrorMessage,
  cliFileName,
  isAuthFailure,
  needsCliRefresh,
  nextBackoffMs,
  parseCredentials,
  parseLoginPrompt,
  redact,
} from "./cliProtocol.ts";

describe("parseLoginPrompt", () => {
  const printed =
    "Open https://relay.yhw.tw/device?user_code=ABCD-EFGH\nCheck this code in your browser: ABCD-EFGH\nWaiting for approval…\n";

  it("reads the approval URL and code the CLI prints", () => {
    expect(parseLoginPrompt(printed)).toEqual({
      verificationUrl: "https://relay.yhw.tw/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
    });
  });

  it("waits until both lines arrived and refuses non-web URLs", () => {
    expect(parseLoginPrompt("Open https://relay.yhw.tw/device\n")).toBeNull();
    expect(
      parseLoginPrompt("Open javascript:alert(1)\nCheck this code in your browser: X\n"),
    ).toBeNull();
  });
});

describe("connect output", () => {
  it("classifies the CLI's connection lines", () => {
    expect(classifyConnectLine("Agent connected. Tunnel links are active.")).toBe("connected");
    expect(classifyConnectLine("Connection lost. Reconnecting in 2s…")).toBe("reconnecting");
    expect(classifyConnectLine("fetch failed")).toBe("other");
  });

  it("backs off and resets after a healthy run", () => {
    expect(nextBackoffMs(1_000, 5_000)).toBe(2_000);
    expect(nextBackoffMs(40_000, 5_000)).toBe(60_000);
    expect(nextBackoffMs(60_000, 120_000)).toBe(1_000);
  });
});

describe("credentials", () => {
  it("reads the CLI's credentials file", () => {
    const json = JSON.stringify({ server: "https://relay.yhw.tw/", agent: "ag1", token: "t".repeat(40) });
    expect(parseCredentials(json)).toEqual({
      server: "https://relay.yhw.tw",
      agentId: "ag1",
      token: "t".repeat(40),
    });
    expect(parseCredentials("{}")).toBeNull();
    expect(parseCredentials("not json")).toBeNull();
  });

  it("redacts tokens from CLI output", () => {
    const token = "secret-token-123";
    expect(redact(`Bearer ${token} failed`, [token])).toBe("Bearer <redacted> failed");
    expect(redact("short x", ["x"])).toBe("short x");
  });
});

describe("errors", () => {
  it("uses the CLI's last error line", () => {
    expect(cliErrorMessage("warning\nTunnel limit reached.\n", 1)).toBe("Tunnel limit reached.");
    expect(cliErrorMessage("", 3)).toBe("The Relay CLI exited with code 3.");
  });

  it("spots sign-in failures but not quota errors", () => {
    expect(isAuthFailure("Authentication required.")).toBe(true);
    expect(isAuthFailure("Set RELAY_SERVER and RELAY_TOKEN, or pass --server and --token.")).toBe(
      true,
    );
    expect(isAuthFailure("Tunnel limit reached.")).toBe(false);
  });
});

describe("CLI cache", () => {
  it("refreshes for a new server or when due", () => {
    const cached = { server: "https://relay.yhw.tw", refreshAt: 1_000 };
    expect(needsCliRefresh(null, "https://relay.yhw.tw", 0)).toBe(true);
    expect(needsCliRefresh(cached, "https://relay.yhw.tw", 999)).toBe(false);
    expect(needsCliRefresh(cached, "https://relay.yhw.tw", 1_000)).toBe(true);
    expect(needsCliRefresh(cached, "https://other.example", 0)).toBe(true);
  });

  it("names the cache per server", () => {
    expect(cliFileName("https://relay.yhw.tw")).toBe("relay.yhw.tw.cjs");
    expect(cliFileName("http://localhost:8787")).toBe("localhost_8787.cjs");
  });
});
