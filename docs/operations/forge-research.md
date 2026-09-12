# Graph research and detector setup

Run the normal development environment with a separate `--home-dir`; see the
repository development instructions. Set these variables on that server process:

```sh
T3_FORGE_GRAPH_ENDPOINT=https://gateway.thegraph.com/api/subgraphs/id/<subgraph-id>
T3_FORGE_GRAPH_API_KEY=<key>
T3_FORGE_GRAPH_DEPLOYMENT=<deployment-returned-by-_meta>
T3_FORGE_CHAIN_HEAD_RPC=<https-ethereum-mainnet-rpc>
T3_EXTERNAL_GITHUB_RELEASES=ethereum/go-ethereum
```

The Graph key is sent in an authorization header. `GRAPH_KEY` alone is not a
server setting; map an existing key to `T3_FORGE_GRAPH_API_KEY` when launching.
Verify the deployment and token metadata before choosing a provider. The built-in
adapter supports the reviewed mainnet WETH/USDC v3 pools in
[GraphSource.ts](../../apps/server/src/trading/forge/GraphSource.ts).

The optional chain-head RPC supports providers whose indexing-status endpoint is
unavailable. It receives no Graph credentials. The server verifies Ethereum
mainnet, the Graph deployment and indexing-error flag, then measures indexed lag
against the independently read chain head. Without verifiable freshness the data
remains stale; do not disable that refusal for a demo.

Build and pin the generated-code runner using
[the runner instructions](../../infra/forge-runner/README.md). Run `--smoke`
before launching with the printed image reference. Existing images do not acquire
new detector or policy entrypoints when the source checkout changes.

An external release's publication date and the time T3 first observed it are
different. Historical research is explicitly replay evidence, including when it
was downloaded from a live provider today. It cannot authorize a live trade.

Uniswap swap drafts currently end at `broadcaster-missing`. Configuring a route or
approving an envelope does not enable submission. A future broadcaster requires
protected calldata, dedicated approved authority, atomic reservation, durable
submission and receipt reconciliation; the fee-hook signer is not that authority.
