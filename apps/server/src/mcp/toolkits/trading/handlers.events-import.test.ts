/**
 * Direct handler test for the `trading_events` import_external action.
 *
 * Two things are pinned: the handler refuses BY NAME when the import service
 * is not wired into the runtime (research mode keeps every non-signing path
 * alive), and a wired import comes back as one sentence the model can relay —
 * counts, skips, capture honesty, and the availability line that keeps a
 * publication time from masquerading as an availability time.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { runMigrations } from "../../../persistence/Migrations.ts";
import {
  TradingEventService,
  TradingEventServiceLive,
} from "../../../trading/TradingEventService.ts";
import {
  makeTradingMarketArchive,
  TradingMarketArchive,
} from "../../../trading/TradingMarketArchive.ts";
import { TradingThreadMarketService } from "../../../trading/TradingThreadMarketService.ts";
import {
  ExternalSourceConfig,
  ExternalSourceConnector,
  ExternalSourceTransport,
  makeExternalSourceConnector,
  resolveExternalSourceSettings,
  type ExternalSourceHttpResponse,
} from "../../../trading/research/ExternalSourceConnector.ts";
import {
  ExternalSourceStore,
  makeExternalSourceStore,
} from "../../../trading/research/ExternalSourceStore.ts";
import {
  ExternalEventImportService,
  makeExternalEventImportService,
} from "../../../trading/research/ExternalEventImportService.ts";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const ENV = { T3_EXTERNAL_GITHUB_RELEASES: "o/r" };

const toJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const releaseFixture = (overrides?: Record<string, unknown>) => ({
  id: 1,
  tag_name: "v1.0.0",
  name: "First",
  body: "initial notes",
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/o/r/releases/tag/v1.0.0",
  ...overrides,
});

const jsonResponse = (body: unknown): ExternalSourceHttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  bodyBytes: new TextEncoder().encode(toJsonText(body)),
});

const invocationScopeFor = (suffix: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make(`env-import-${suffix}`),
  threadId: ThreadId.make(`thread-import-${suffix}`),
  providerSessionId: `session-import-${suffix}`,
  providerInstanceId: ProviderInstanceId.make(`instance-import-${suffix}`),
  capabilities: new Set<McpInvocationContext.McpCapability>(["trading"]),
  issuedAt: 0,
});

/**
 * The `trading_events` handler's TYPE carries the study path's services even
 * though import_external never touches them; two inert stubs satisfy the
 * context so the import tests can run without the archive engine — the same
 * pattern the study test's replay stubs use.
 */
const typeOnlyStubs = Layer.mergeAll(
  Layer.succeed(
    TradingMarketArchive,
    makeTradingMarketArchive("/unused/import-test.sqlite", "hyperliquid", "/unused/queue.json"),
  ),
  Layer.succeed(TradingThreadMarketService, {
    record: () => Effect.die("the thread-market service is not used by this test"),
    read: () => Effect.die("the thread-market service is not used by this test"),
  }),
);

it.live("refuses by name when the import service is not wired into the runtime", () => {
  const memory = NodeSqliteClient.layerMemory();
  return Effect.gen(function* () {
    yield* runMigrations({});
    const rejection = yield* Effect.flip(
      handlers.trading_events({ action: "import_external", name: "Unwired releases" }),
    );
    assert.instanceOf(rejection, TradingToolRejectedError);
    assert.include(
      (rejection as TradingToolRejectedError).detail,
      "the external event import service is not wired into this runtime",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("unwired")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(memory),
          Layer.provideMerge(NodeServices.layer),
        ),
        typeOnlyStubs,
      ),
    ),
  );
});

it.live("imports retained releases and sentences the result with the availability honesty", () => {
  const page = [
    releaseFixture({ id: 1, body: "one" }),
    releaseFixture({
      id: 2,
      tag_name: "v1.1.0",
      body: "two",
      published_at: "2026-02-03T04:05:06Z",
      html_url: "https://github.com/o/r/releases/tag/v1.1.0",
    }),
    releaseFixture({ id: 3, tag_name: null, published_at: null, body: "three" }),
  ];
  const memory = NodeSqliteClient.layerMemory();

  // The real service stack over the same memory database the handler's event
  // service uses: real store, real connector (fake transport at its seam),
  // real import service, real authored record path.
  const eventsLayer = TradingEventServiceLive.pipe(
    Layer.provideMerge(memory),
    Layer.provideMerge(NodeServices.layer),
  );
  const wired = Effect.gen(function* () {
    yield* runMigrations({});
    const store = yield* makeExternalSourceStore;
    const connector = yield* makeExternalSourceConnector.pipe(
      Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(store)),
      Effect.provideService(
        ExternalSourceConfig,
        ExternalSourceConfig.of({
          resolve: Effect.succeed(resolveExternalSourceSettings(ENV)),
        }),
      ),
      Effect.provideService(
        ExternalSourceTransport,
        ExternalSourceTransport.of({ get: () => Effect.succeed(jsonResponse(page)) }),
      ),
    );
    const events = yield* TradingEventService;
    const importer = yield* makeExternalEventImportService.pipe(
      Effect.provideService(ExternalSourceConnector, ExternalSourceConnector.of(connector)),
      Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(store)),
      Effect.provideService(TradingEventService, TradingEventService.of(events)),
    );
    return ExternalEventImportService.of({ importExternalSource: importer.importExternalSource });
  });

  return Effect.gen(function* () {
    const result = yield* handlers.trading_events({
      action: "import_external",
      name: "Handler releases",
    });
    const eventSet = "eventSet" in result ? result.eventSet : undefined;
    assert.isDefined(eventSet);
    assert.equal(eventSet?.occurrences.length, 2);
    assert.equal(eventSet?.occurrences[0]?.label, "v1.0.0");
    const outcome = "outcome" in result ? result.outcome : undefined;
    assert.include(
      outcome ?? "",
      `"Handler releases" now holds 2 occurrence(s) imported from github-releases`,
    );
    // The skip the projection made is named, not dropped.
    assert.include(outcome ?? "", "Skipped 1 document(s) without a publication time");
    // The honesty line rides every import outcome.
    assert.include(
      outcome ?? "",
      "publication times are the source's claims, not availability times",
    );
    assert.include(outcome ?? "", "Re-import the name to replace the list");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("wired")),
        eventsLayer,
        Layer.effect(ExternalEventImportService, wired).pipe(Layer.provide(eventsLayer)),
        typeOnlyStubs,
      ),
    ),
  );
});
