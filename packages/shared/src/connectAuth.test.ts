import { describe, expect, it } from "vite-plus/test";

import { normalizeSecureRelayUrl } from "./relayUrl.ts";
import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  connectLoopbackRedirectUri,
  DEFAULT_HOSTED_APP_URL,
  DEFAULT_RELAY_URL,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

describe("fork deployment defaults", () => {
  it("points the hosted app and relay defaults at this fork's own deployment", () => {
    // Byte-pinned on purpose: an upstream sync that reverts the fork patch
    // should fail here rather than silently send fresh builds upstream.
    expect(DEFAULT_HOSTED_APP_URL).toBe("https://app.athelstan.xyz");
    expect(DEFAULT_RELAY_URL).toBe("https://relay.athelstan.xyz");
  });

  it("ships a relay default that survives the secure-origin normalization", () => {
    // Both public configs run the default through normalizeSecureRelayUrl;
    // if that ever rejects it, every fallback silently yields null.
    expect(normalizeSecureRelayUrl(DEFAULT_RELAY_URL)).toBe(DEFAULT_RELAY_URL);
  });
});

describe("connectAuth", () => {
  it("round-trips state, challenge, and loopback port through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.t3.codes",
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://app.t3.codes");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("rejects authorize requests missing state, challenge, or port", () => {
    expect(readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect"))).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#state=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#challenge=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.t3.codes/connect#state=abc&challenge=abc")),
    ).toBeNull();
  });

  it("rejects authorize requests whose loopback port is corrupted", () => {
    for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
      const url = new URL(
        `https://app.t3.codes/connect#state=state-1&challenge=challenge-1&port=${encodeURIComponent(port)}`,
      );
      expect(readConnectAuthorizeRequest(url), port).toBeNull();
    }
  });

  it("builds a PKCE authorize URL against the Clerk endpoint", () => {
    const url = new URL(
      buildConnectClerkAuthorizeUrl({
        authorizationEndpoint: "https://clerk.t3.codes/oauth/authorize",
        clientId: "oauthapp_123",
        redirectUri: connectLoopbackRedirectUri(34338),
        scopes: ["openid", "profile", "email", "offline_access"],
        state: "state-1",
        challenge: "challenge-1",
      }),
    );

    expect(url.origin).toBe("https://clerk.t3.codes");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("oauthapp_123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
