/**
 * CapabilityQuery — the structural query contract, held to itself.
 *
 * The reference query must validate (it is the identity every generated
 * query is compared against). Byte-different but structurally identical
 * variants must pass — the contract is shape, not text. Everything else
 * (mutations, fragments, aliases, directives, wrong fields, wrong
 * variables, garbage) must refuse with a reason that names the defect.
 */
import { assert, describe, it } from "@effect/vitest";

import { FORGE_SWAPS_QUERY } from "./GraphSource.ts";
import { validateForgeCapabilityQuery } from "./CapabilityQuery.ts";

const expectOk = (source: string): void => {
  const result = validateForgeCapabilityQuery(source);
  assert.equal(result.ok, true, `expected ok, refused with: ${result.ok ? "" : result.reason}`);
};

const expectRefusal = (source: string, ...fragments: Array<string>): void => {
  const result = validateForgeCapabilityQuery(source);
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) return;
  for (const fragment of fragments) {
    assert.include(result.reason, fragment);
  }
};

// ---------------------------------------------------------------------------
// Honest variants: hand-written, structurally identical to the reference
// ---------------------------------------------------------------------------

/** Same shape, different operation name and reordered variable definitions. */
const RENAMED_REORDERED_VARIABLES = `query GeneratedSwaps($to: BigInt!, $from: BigInt!, $block: Int!, $cursor: ID!, $first: Int!, $pool: String!) {
  swaps(
    first: $first
    where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }
    block: { number: $block }
    orderBy: id
    orderDirection: asc
  ) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

/** Anonymous operation, both nesting levels' fields reordered. */
const REORDERED_FIELDS = `query ($block: Int!, $cursor: ID!, $first: Int!, $from: BigInt!, $pool: String!, $to: BigInt!) {
  _meta(block: { number: $block }) { block { hash number } deployment }
  swaps(
    first: $first
    where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }
    block: { number: $block }
    orderBy: id
    orderDirection: asc
  ) {
    logIndex
    tick
    sqrtPriceX96
    amount1
    amount0
    recipient
    sender
    timestamp
    id
    transaction { id }
  }
}`;

/** One line, minimal whitespace — bytes differ everywhere, structure is identical. */
const SINGLE_LINE = `query Q($pool:String!,$first:Int!,$cursor:ID!,$block:Int!,$from:BigInt!,$to:BigInt!){swaps(first:$first,where:{pool:$pool,id_gt:$cursor,timestamp_gte:$from,timestamp_lte:$to},block:{number:$block},orderBy:id,orderDirection:asc){id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction{id}} _meta(block:{number:$block}){deployment block{number hash}}}`;

// ---------------------------------------------------------------------------
// Rejections, each tampered in exactly one way from the reference shape
// ---------------------------------------------------------------------------

const MISSING_FIELD = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(
    first: $first
    where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }
    block: { number: $block }
    orderBy: id
    orderDirection: asc
  ) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    logIndex
    transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const EXTRA_FIELD = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(
    first: $first
    where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }
    block: { number: $block }
    orderBy: id
    orderDirection: asc
  ) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    gasUsed
    transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const MISSING_VARIABLE = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: 1 }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: 1 }) { deployment block { number hash } }
}`;

const EXTRA_VARIABLE = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!, $limit: Int!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const WRONG_VARIABLE_TYPE = `query ForgeSwaps($pool: ID!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const ALIASED_FIELD = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    transaction { txId: id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const FRAGMENT = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    ...swapFields
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}

fragment swapFields on Swap {
  id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
}`;

const INLINE_FRAGMENT = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    ... on Swap { id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id } }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const FIELD_DIRECTIVE = `query ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id @include(if: true)
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

describe("validateForgeCapabilityQuery", () => {
  it("accepts the pinned reference query itself", () => {
    expectOk(FORGE_SWAPS_QUERY);
  });

  it("accepts a renamed operation with reordered variable definitions", () => {
    expectOk(RENAMED_REORDERED_VARIABLES);
  });

  it("accepts an anonymous query with reordered variables and every nesting level's fields reordered", () => {
    expectOk(REORDERED_FIELDS);
  });

  it("accepts a single-line, differently spaced rendering of the same shape", () => {
    expectOk(SINGLE_LINE);
  });

  it("refuses mutations and subscriptions", () => {
    expectRefusal(
      `mutation ForgeSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) { swaps(first: $first) { id } }`,
      "not a mutation",
    );
    expectRefusal(`subscription ForgeSwaps($pool: String!) { swaps { id } }`, "not a subscription");
  });

  it("refuses a missing field with the field named", () => {
    expectRefusal(MISSING_FIELD, '"tick"', "requires");
  });

  it("refuses an extra field with the field named", () => {
    expectRefusal(EXTRA_FIELD, '"gasUsed"');
  });

  it("refuses aliased fields", () => {
    expectRefusal(ALIASED_FIELD, "alias", "txId");
  });

  it("refuses fragments, named and inline", () => {
    expectRefusal(FRAGMENT, "fragment");
    expectRefusal(INLINE_FRAGMENT, "inline fragment");
  });

  it("refuses field directives", () => {
    expectRefusal(FIELD_DIRECTIVE, "directive");
  });

  it("refuses a wrong variable set: missing, extra, wrong type", () => {
    expectRefusal(MISSING_VARIABLE, "$block");
    expectRefusal(EXTRA_VARIABLE, "$limit");
    expectRefusal(WRONG_VARIABLE_TYPE, "$pool");
  });

  it("refuses non-GraphQL garbage and empty input", () => {
    expectRefusal("this is not graphql {", "not valid GraphQL");
    expectRefusal("", "empty");
  });

  it("refuses multiple operations and leaf/object shape mismatches", () => {
    expectRefusal(`query A { swaps { id } } query B { swaps { id } }`, "exactly one operation");
    // `transaction` must stay an object selection; making it a leaf changes shape.
    expectRefusal(
      `query Q($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) { swaps(first: $first) { id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction } _meta(block: { number: $block }) { deployment block { number hash } } }`,
      "transaction",
      "subfields",
    );
  });
});
