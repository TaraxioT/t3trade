/**
 * ExternalSourceConnector — the first host connector for external research
 * evidence: the GitHub official releases API.
 *
 * One capture fetches ONE page of releases from a vetted owner/repo, maps
 * each release into an immutable revision in the ExternalSourceStore, and
 * reports per document whether the capture changed anything. Corrections are
 * detected by content hash: new content for a known document is a NEW
 * revision linked through `correctionOf`, identical content is a no-op, and
 * `firstObservedAtMs` is only ever written on the first sighting — re-captures
 * never rewrite it.
 *
 * Safety properties this module is load-bearing for:
 *
 * - The fetch URL is constructed ONLY from the validated owner/repo config
 *   (charset `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`) against the fixed
 *   api.github.com host — never from response bytes or caller input.
 * - Redirects are refused, not followed: the transport surfaces a 3xx and the
 *   connector turns it into a named unavailable state, so a redirect can
 *   never silently aim this connector at another host.
 * - The response must be `application/json` and under a byte cap; anything
 *   else is unavailable, never a partial parse.
 * - The optional token rides the `Authorization` header and nothing else; it
 *   never appears in a URL, log line, or error reason — every reason passes
 *   through `redact`.
 * - Payload bytes are inert: the free-text fields of a release (name, body)
 *   reach the manifest ONLY through the content hash. Nothing from the
 *   payload is ever evaluated, and no returned field is derived from body
 *   text except its digest.
 * - States are named, never faked: every failure is `unavailable` with a
 *   reason. Store failures remain in the error channel — they are genuine
 *   persistence failures, not source availability.
 * - Nothing here can reach a signer, Hyperliquid, or an order.
 *
 * @module ExternalSourceConnector
 */
import { Context, Effect, Layer, Schema } from "effect";
import * as NodeCrypto from "node:crypto";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ExternalSourceManifest } from "@t3tools/trading-contracts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ExternalSourceStore,
  toManifest,
  type ExternalSourceRevision,
} from "./ExternalSourceStore.ts";

/** The source-family kind recorded on every revision this connector writes. */
export const GITHUB_RELEASES_SOURCE_KIND = "github-releases";

/** One page per capture; also the cap on mapped releases, so a misbehaving
 * API cannot flood the store past what one page can honestly hold. */
const RELEASES_PER_CAPTURE = 30;

/** Responses over this many bytes are refused, not truncated or parsed. */
const RESPONSE_BYTE_CAP = 1_048_576;

const GITHUB_RELEASES_ENDPOINT = "https://api.github.com";

// ---------------------------------------------------------------------------
// Host configuration
// ---------------------------------------------------------------------------

/** Resolved external-source settings. `configured: false` carries the named reason. */
export interface ExternalSourceSettings {
  readonly configured: boolean;
  readonly reason?: string;
  /** Present only when configured. Never logged, never in a URL. */
  readonly token?: string;
  readonly releases?: {
    readonly owner: string;
    readonly repo: string;
  };
}

const OWNER_REPO_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/**
 * Read the GitHub releases settings out of an env bag. Exposed for tests.
 *
 *   - `T3_EXTERNAL_GITHUB_RELEASES` — "owner/repo" (required)
 *   - `T3_EXTERNAL_GITHUB_TOKEN` — optional credential; header-only
 *
 * A missing or malformed required variable produces `configured: false` with
 * the variable named in the reason — an honest unavailable state, not a
 * default target with someone else's credentials. The charset also blocks
 * path/host tricks before any URL is ever built from it.
 */
export const resolveExternalSourceSettings = (
  env: Record<string, string | undefined>,
): ExternalSourceSettings => {
  const target = env.T3_EXTERNAL_GITHUB_RELEASES?.trim();
  if (target === undefined || target === "") {
    return {
      configured: false,
      reason:
        "external github releases source not configured (missing T3_EXTERNAL_GITHUB_RELEASES)",
    };
  }
  const match = OWNER_REPO_PATTERN.exec(target);
  if (match === null) {
    return {
      configured: false,
      reason:
        "T3_EXTERNAL_GITHUB_RELEASES must be an owner/repo pair matching ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    };
  }
  const token = env.T3_EXTERNAL_GITHUB_TOKEN?.trim();
  return {
    configured: true,
    ...(token === undefined || token === "" ? {} : { token }),
    releases: { owner: match[1]!, repo: match[2]! },
  };
};

/** Per-call resolution, so a knob changed between reads takes effect without a restart. */
export class ExternalSourceConfig extends Context.Service<
  ExternalSourceConfig,
  { readonly resolve: Effect.Effect<ExternalSourceSettings> }
>()("t3/trading/research/ExternalSourceConnector/ExternalSourceConfig") {}

export const ExternalSourceConfigLive = Layer.succeed(
  ExternalSourceConfig,
  ExternalSourceConfig.of({
    resolve: Effect.sync(() => resolveExternalSourceSettings(process.env)),
  }),
);

// ---------------------------------------------------------------------------
// Transport — the one seam the credential crosses, as a header and nothing else
// ---------------------------------------------------------------------------

export interface ExternalSourceHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes: Uint8Array | null;
}

export interface ExternalSourceTransportShape {
  readonly get: (input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }) => Effect.Effect<ExternalSourceHttpResponse, string>;
}

export class ExternalSourceTransport extends Context.Service<
  ExternalSourceTransport,
  ExternalSourceTransportShape
>()("t3/trading/research/ExternalSourceConnector/ExternalSourceTransport") {}

/**
 * HttpClient-backed transport. The token crosses as the `Authorization`
 * header here and only here — never the URL, never a log line. Redirects are
 * NOT followed (`redirect: "manual"`): a 3xx is returned as-is so the
 * connector can name it, and no second request ever happens. Tests inject a
 * fake at this seam; production composes the shared node-backed HTTP layer.
 */
export const ExternalSourceTransportLive = Layer.effect(
  ExternalSourceTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return ExternalSourceTransport.of({
      get: ({ url, headers }) =>
        Effect.gen(function* () {
          const request = Object.entries(headers).reduce(
            (acc, [name, value]) => HttpClientRequest.setHeader(acc, name, value),
            HttpClientRequest.get(url),
          );
          const response = yield* client.execute(request);
          const body = yield* response.arrayBuffer;
          const bodyBytes = new Uint8Array(body);
          return {
            status: response.status,
            headers: { ...response.headers },
            bodyBytes: bodyBytes.byteLength === 0 ? null : bodyBytes,
          };
        }).pipe(
          Effect.mapError((cause): string => `external source transport failed: ${String(cause)}`),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        ),
    });
  }),
);

/** Remove the token from any string before it can become a reason. */
const redact = (message: string, token: string | undefined): string =>
  token === undefined || token === "" ? message : message.split(token).join("[redacted]");

// ---------------------------------------------------------------------------
// Response guardrails and release parsing (pure)
// ---------------------------------------------------------------------------

const responseContentType = (headers: Readonly<Record<string, string>>): string | null => {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value;
  }
  return null;
};

const isJsonContentType = (contentType: string | null): boolean =>
  contentType !== null && contentType.split(";")[0]!.trim().toLowerCase() === "application/json";

/** A parsed release: the claim fields this family hashes over, plus the raw entry. */
interface GithubRelease {
  readonly id: number;
  readonly tag_name: string | null;
  readonly name: string | null;
  readonly body: string | null;
  readonly published_at: string | null;
  readonly html_url: string;
  /** The release exactly as the API returned it, retained verbatim as inert bytes. */
  readonly raw: Record<string, unknown>;
}

const RELEASE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const stringOrNull = (value: unknown): string | null | undefined =>
  typeof value === "string" || value === null ? value : undefined;

/** Parse one release entry, or return the reason it cannot be trusted. */
const parseRelease = (value: unknown): GithubRelease | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "entry is not a JSON object";
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    return "entry has no safe-integer id";
  }
  const htmlUrl = record["html_url"];
  if (typeof htmlUrl !== "string" || !/^https?:\/\//.test(htmlUrl)) {
    return "entry has no http(s) html_url";
  }
  const tagName = stringOrNull(record["tag_name"]);
  const name = stringOrNull(record["name"]);
  const body = stringOrNull(record["body"]);
  if (tagName === undefined || name === undefined || body === undefined) {
    return "entry has a non-string, non-null tag_name/name/body";
  }
  const publishedAt = stringOrNull(record["published_at"]);
  if (publishedAt === undefined) {
    return "entry has a non-string, non-null published_at";
  }
  if (publishedAt !== null && !RELEASE_TIMESTAMP_PATTERN.test(publishedAt)) {
    return "entry published_at is not a second-precision UTC ISO timestamp";
  }
  return {
    id,
    tag_name: tagName,
    name,
    body,
    published_at: publishedAt,
    html_url: htmlUrl,
    raw: record,
  };
};

/** Parse the whole response body into validated releases, or the named reason it cannot be. */
const parseReleasesBody = (
  bodyBytes: Uint8Array,
):
  | { readonly ok: true; readonly releases: ReadonlyArray<GithubRelease> }
  | {
      readonly ok: false;
      readonly reason: string;
    } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { ok: false, reason: "github releases response body is not valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "github releases response was not a JSON array" };
  }
  const releases: Array<GithubRelease> = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const release = parseRelease(parsed[index]);
    if (typeof release === "string") {
      return { ok: false, reason: `github releases response releases[${index}] ${release}` };
    }
    releases.push(release);
  }
  return { ok: true, releases };
};

/**
 * The fields that define a release's claim, serialized in a fixed key order
 * so the digest is reproducible. The free-text fields (name, body) appear
 * ONLY here — downstream surfaces see them solely through this hash.
 */
const canonicalReleaseClaim = (release: GithubRelease): string =>
  JSON.stringify({
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    published_at: release.published_at,
    html_url: release.html_url,
  });

const sha256Hex = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

// encodeSync stays inside this module-level (non-generator) helper.
const encodeRawRelease = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

/**
 * Revision ids are content-derived: environment + document identity +
 * content sha + first observed. The environment is part of the derivation so
 * two environments sighting the same document each own their revision —
 * without it, one environment's first sighting could silently no-op onto
 * another's row (revision ids are a global primary key) and every later
 * capture would mis-detect a change. Different bytes under the same id is a
 * collision the store fails loudly on.
 */
const deriveRevisionId = (input: {
  readonly environmentId: string;
  readonly documentIdentity: string;
  readonly contentSha256: string;
  readonly firstObservedAtMs: number;
}): string =>
  `extrev_${sha256Hex(
    `${input.environmentId}\n${input.documentIdentity}\n${input.contentSha256}\n${input.firstObservedAtMs}`,
  )}`;

// ---------------------------------------------------------------------------
// The connector service
// ---------------------------------------------------------------------------

export interface ExternalSourceCapturedDocument {
  readonly documentIdentity: string;
  readonly revisionId: string;
  /** False when this capture matched the retained revision's content hash. */
  readonly changed: boolean;
  /** Literal: the GitHub family never produces retractions itself. */
  readonly retracted: false;
  readonly manifest: ExternalSourceManifest;
}

export type ExternalSourceCapture =
  | {
      readonly status: "ok";
      readonly documents: ReadonlyArray<ExternalSourceCapturedDocument>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ExternalSourceConnectorShape {
  /**
   * Capture the latest release page. Never throws: source-side failures are
   * named `unavailable` states; only persistence failures (a revision-id
   * collision, a SQL error) remain in the error channel, because they are
   * genuine failures rather than source availability.
   */
  readonly captureLatest: (input: {
    readonly environmentId: string;
    /** The capture instant, supplied by the caller so tests are deterministic. */
    readonly now: number;
  }) => Effect.Effect<ExternalSourceCapture, PersistenceSqlError>;
}

export class ExternalSourceConnector extends Context.Service<
  ExternalSourceConnector,
  ExternalSourceConnectorShape
>()("t3/trading/research/ExternalSourceConnector") {}

export const makeExternalSourceConnector = Effect.gen(function* () {
  const config = yield* ExternalSourceConfig;
  const transport = yield* ExternalSourceTransport;
  const store = yield* ExternalSourceStore;

  const unavailable = (reason: string): ExternalSourceCapture => ({
    status: "unavailable",
    reason,
  });

  const captureLatest: ExternalSourceConnectorShape["captureLatest"] = ({ environmentId, now }) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.releases === undefined) {
        return unavailable(
          redact(
            settings.reason ?? "external github releases source not configured",
            settings.token,
          ),
        );
      }
      const { owner, repo } = settings.releases;
      // SSRF containment: the URL is assembled from the charset-validated
      // owner/repo against the fixed api.github.com host. It never comes from
      // a response, a redirect, or caller input.
      const url = `${GITHUB_RELEASES_ENDPOINT}/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_CAPTURE}`;
      const headers: Record<string, string> = { accept: "application/vnd.github+json" };
      if (settings.token !== undefined) {
        headers["authorization"] = `Bearer ${settings.token}`;
      }

      const fetched = yield* transport.get({ url, headers }).pipe(
        Effect.map(
          (response): { readonly ok: true; readonly response: ExternalSourceHttpResponse } => ({
            ok: true,
            response,
          }),
        ),
        // A transport failure is a named unavailable state, never a thrown
        // error; the reason is redacted because driver messages repeat what
        // was sent.
        Effect.catch(
          (
            cause,
          ): Effect.Effect<{
            readonly ok: false;
            readonly capture: ExternalSourceCapture;
          }> =>
            Effect.succeed({
              ok: false,
              capture: unavailable(
                redact(`github releases fetch failed: ${cause}`, settings.token),
              ),
            }),
        ),
      );
      if (!fetched.ok) return fetched.capture;
      const response = fetched.response;

      if (response.status >= 300 && response.status < 400) {
        return unavailable(
          `github releases endpoint answered HTTP ${response.status}; redirects are refused, never followed`,
        );
      }
      if (response.status !== 200) {
        return unavailable(`github releases endpoint answered HTTP ${response.status}`);
      }
      const contentType = responseContentType(response.headers);
      if (!isJsonContentType(contentType)) {
        return unavailable(
          `github releases response content type is not application/json (${contentType ?? "none"})`,
        );
      }
      if (response.bodyBytes === null) {
        return unavailable("github releases response had an empty body");
      }
      if (response.bodyBytes.byteLength > RESPONSE_BYTE_CAP) {
        return unavailable(
          `github releases response is ${response.bodyBytes.byteLength} bytes, over the ${RESPONSE_BYTE_CAP}-byte cap`,
        );
      }
      const parsed = parseReleasesBody(response.bodyBytes);
      if (!parsed.ok) return unavailable(parsed.reason);
      // One bounded page: the request asked for per_page = the mapping cap, so
      // mapping more than the cap can only mean the API changed shape.
      const releases = parsed.releases.slice(0, RELEASES_PER_CAPTURE);

      const documents: Array<ExternalSourceCapturedDocument> = [];
      for (const release of releases) {
        const identityKey =
          release.tag_name !== null && release.tag_name !== ""
            ? release.tag_name
            : String(release.id);
        const documentIdentity = `github-release:${owner}/${repo}:${identityKey}`;
        const contentSha256 = sha256Hex(canonicalReleaseClaim(release));
        const latest = yield* store.latestRevision({
          environmentId,
          sourceKind: GITHUB_RELEASES_SOURCE_KIND,
          documentIdentity,
        });
        if (latest !== null && latest.revision.contentSha256 === contentSha256) {
          // Identical content: a no-op. firstObservedAtMs stays what the
          // first sighting wrote — rows are immutable, so nothing moved.
          documents.push({
            documentIdentity,
            revisionId: latest.revision.revisionId,
            changed: false,
            retracted: false,
            manifest: toManifest(latest.revision),
          });
          continue;
        }
        const revision: ExternalSourceRevision = {
          revisionId: deriveRevisionId({
            environmentId,
            documentIdentity,
            contentSha256,
            firstObservedAtMs: now,
          }),
          environmentId,
          sourceKind: GITHUB_RELEASES_SOURCE_KIND,
          documentIdentity,
          sourceUrl: release.html_url,
          contentSha256,
          publishedAtMs: release.published_at === null ? null : Date.parse(release.published_at),
          // GitHub's published_at is a second-precision ISO instant.
          timePrecision: "instant",
          firstObservedAtMs: now,
          captureMs: now,
          correctionOf: latest === null ? null : latest.revision.revisionId,
          retracted: false,
        };
        yield* store.insert({
          revision,
          // The retained bytes are the raw entry, serialized verbatim.
          payloadJson: encodeRawRelease(release.raw),
        });
        documents.push({
          documentIdentity,
          revisionId: revision.revisionId,
          changed: true,
          retracted: false,
          manifest: toManifest(revision),
        });
      }
      return { status: "ok", documents };
    });

  return { captureLatest } satisfies ExternalSourceConnectorShape;
});

export const ExternalSourceConnectorLive = Layer.effect(
  ExternalSourceConnector,
  makeExternalSourceConnector,
);
