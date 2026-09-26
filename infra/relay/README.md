# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Connections.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture note](../../docs/internals/t3-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter t3code-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk, APNs, and optional FCM credentials. Set
`APNS_ENABLED=false` for an Android-only development deployment without Apple credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The database is provisioned separately in Neon. Production uses project `t3trade-relay`
(`blue-river-77981900`, AWS Singapore), branch `main`, and database `t3coderelay`.
Alchemy owns Hyperdrive, which connects to the **direct, unpooled** Neon endpoint on port 5432
with verified TLS and query caching disabled. The deploy wrapper applies the checked-in SQL
migrations before updating the stack. No database tunnel or Cloudflare Access token is needed.

Set `RELAY_DB_HOST`, runtime credentials (`RELAY_DB_USER` / `RELAY_DB_PASSWORD`), and separate
migration-owner credentials (`RELAY_DB_ADMIN_USER` / `RELAY_DB_ADMIN_PASSWORD`) in the ignored
`infra/relay/.env`. Never use a Neon Console/API-created role for runtime access: those roles
inherit `neon_superuser`. Create the runtime login with SQL and grant only database `CONNECT`,
schema `USAGE`, table `SELECT/INSERT/UPDATE/DELETE`, and sequence `USAGE/SELECT`. Set matching
owner default privileges for future tables and sequences; revoke public schema `CREATE`.

Personal stages require their own database named `t3coderelay_<stage-slug>` and restricted runtime
role, provisioned before deploying. They may use a separate Neon branch or project; select its
credentials using `--env-file`. Alchemy does not create Neon projects, branches, roles, or databases.
Both migrations and deployment read the selected environment file.

```sh
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --stage dev_george --env-file .env.local
# Apply migrations without deploying the Worker (safe to repeat):
vp run --filter t3code-relay migrate -- --stage prod
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment credentials

Deployment requires Cloudflare and Axiom provider credentials, the database settings above,
and the existing Clerk configuration. APNs and FCM remain optional inherited integrations.
Database owner credentials belong only on the deployment host. Runtime database credentials
are stored in Hyperdrive, not shipped to clients. The fork has no automatic relay deployment
workflow; deploy the production stage explicitly after focused verification.

### Verify a database move

1. Run `curl --fail https://relay.athelstan.xyz/health`; expect
   `{"ok":true,"service":"relay"}`. This endpoint executes a database query.
2. In T3 Trade, open **Settings > Connections**, sign in, and link the local environment.
   After a database reset, remove the old local link if necessary and link again.
3. From another client signed into the same account, refresh the environment list and connect.
   Open a thread, then reconnect to check that discovery and credential issuance work.
4. Unlink the test environment, refresh the other client, and confirm it is no longer available.
   Relink it if you want to keep using it.

A reset removes relay environment links and connection credentials, not local application data
or Clerk accounts. A successful health response checks database connectivity; the linking and
connection steps also check schema access, writes, authentication, and managed endpoints.

See:

- [T3 Connect setup](../../docs/operations/connect-setup.md) for Clerk keys, JWT templates, and sign-up restrictions.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [T3 Connect architecture](../../docs/internals/t3-connect.md) for environment linking and trust boundaries.
