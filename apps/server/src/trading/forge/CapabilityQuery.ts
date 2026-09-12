/**
 * CapabilityQuery — structural validation of a bundle's `query.graphql`.
 *
 * The authored query is not prose the host smiles at: once installed, its
 * EXACT bytes are what the source executes and what the evidence hashes.
 * This module is the single validator both check time (CapabilityBuilder,
 * before anything runs) and evaluation time (ForgeReactor, over the
 * installed bytes) apply. It parses the document with the `graphql` parser
 * and compares it structurally against the pinned reference query
 * (`FORGE_SWAPS_QUERY`), which is itself parsed here — the validator can
 * never drift from the reference it enforces.
 *
 * What "structurally equal" means, deliberately narrow:
 *
 * - exactly one operation, and it is a `query` (anonymous or named both fine);
 * - no fragments (named or inline), no aliases, no directives — the host's
 *   response normalization reads plain field names and nothing else;
 * - at every nesting level the SET of field names is identical to the
 *   reference's (order-insensitive, no extras, none missing, same shape:
 *   a field is a leaf in both or an object selection in both);
 * - the variable definitions are the same set (name + type) as the
 *   reference's, so the host's pagination and block-pinning code can drive
 *   the generated query unchanged;
 * - at every field, the ARGUMENTS are structurally identical to the
 *   reference's: same argument names, identical literal values, and the same
 *   variable references. This is what binds every collection root to the
 *   host-supplied `$block`/`$first`/cursor variables — a generated query
 *   that substitutes its own literal `block:` on the swaps root while
 *   keeping `_meta(block: { number: $block })` would pass metadata pinning
 *   yet read a different block, and GraphQL responses never echo collection
 *   arguments back, so this AST check is the only place the substitution is
 *   caught. Refused here, never at fetch time.
 *
 * @module CapabilityQuery
 */
import { Kind, parse } from "graphql";
import type {
  ArgumentNode,
  DefinitionNode,
  DocumentNode,
  FieldNode,
  ObjectFieldNode,
  OperationDefinitionNode,
  SelectionNode,
  TypeNode,
  ValueNode,
  VariableDefinitionNode,
} from "graphql";

import { FORGE_SWAPS_QUERY } from "./GraphSource.ts";

/** The outcome: a precise reason on refusal, nothing to carry on success. */
export type ForgeCapabilityQueryValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The reference operation, parsed once from the constant the source pins.
 * The constant is host-reviewed; if it ever stopped being one plain query,
 * failing to load this module — loudly, everywhere — is the correct refusal.
 */
const REFERENCE_OPERATION: OperationDefinitionNode = (() => {
  const operation = soleOperation(parse(FORGE_SWAPS_QUERY));
  if (typeof operation === "string") {
    throw new Error(`pinned FORGE_SWAPS_QUERY is not a single query: ${operation}`);
  }
  if (operation.operation !== "query") {
    throw new Error("pinned FORGE_SWAPS_QUERY is not a query");
  }
  return operation;
})();

/**
 * Validate one `query.graphql` source. Pure; the only input is the document
 * text and the only output is the verdict.
 */
export function validateForgeCapabilityQuery(source: string): ForgeCapabilityQueryValidation {
  if (source.trim() === "") {
    return { ok: false, reason: "query.graphql is empty" };
  }
  let document: DocumentNode;
  try {
    document = parse(source);
  } catch (error) {
    return {
      ok: false,
      reason: `query.graphql is not valid GraphQL: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const operation = soleOperation(document);
  if (typeof operation === "string") return { ok: false, reason: operation };
  if (operation.operation !== "query") {
    return {
      ok: false,
      reason: `query.graphql must define a query, not a ${operation.operation}`,
    };
  }
  if ((operation.directives?.length ?? 0) > 0) {
    return { ok: false, reason: "query.graphql must not use operation directives" };
  }
  const variables = variableSet(operation);
  if (typeof variables === "string") return { ok: false, reason: variables };
  const referenceVariables = variableSet(REFERENCE_OPERATION);
  if (typeof referenceVariables === "string") {
    // The pinned reference itself is malformed — a host bug, refused loudly.
    return { ok: false, reason: `the pinned reference query is invalid: ${referenceVariables}` };
  }
  const missing = [...referenceVariables.keys()].filter((key) => !variables.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `query.graphql must define the variables ${missing.map((name) => `$${name}`).join(", ")} exactly as the pinned query does`,
    };
  }
  const extra = [...variables.keys()].filter((key) => !referenceVariables.has(key));
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `query.graphql defines variables the pinned query does not: ${extra.map((name) => `$${name}`).join(", ")}`,
    };
  }
  for (const [name, type] of variables) {
    const referenceType = referenceVariables.get(name)!;
    if (type !== referenceType) {
      return {
        ok: false,
        reason: `query.graphql must define $${name} as ${referenceType}, not ${type}`,
      };
    }
  }
  return compareSelectionSets(REFERENCE_OPERATION.selectionSet, operation.selectionSet, "");
}

// ---------------------------------------------------------------------------
// Document shape — one plain query, nothing else
// ---------------------------------------------------------------------------

/** The one operation definition, or a refusal naming what else was found. */
function soleOperation(document: DocumentNode): OperationDefinitionNode | string {
  const operations: Array<OperationDefinitionNode> = [];
  const others: Array<string> = [];
  for (const definition of document.definitions as ReadonlyArray<DefinitionNode>) {
    if (definition.kind === Kind.OPERATION_DEFINITION) operations.push(definition);
    else others.push(definitionKindLabel(definition));
  }
  if (others.length > 0) {
    return `query.graphql must not define ${others.join(", ")}`;
  }
  if (operations.length === 0) {
    return "query.graphql defines no operation";
  }
  if (operations.length > 1) {
    return "query.graphql must define exactly one operation";
  }
  return operations[0]!;
}

function definitionKindLabel(definition: DefinitionNode): string {
  if (definition.kind === Kind.FRAGMENT_DEFINITION) return "fragments";
  if (definition.kind === Kind.OPERATION_DEFINITION) return "operations";
  return `${definition.kind} definitions`;
}

// ---------------------------------------------------------------------------
// Variables — the same set of names and types as the reference
// ---------------------------------------------------------------------------

const typeKey = (node: TypeNode): string => {
  switch (node.kind) {
    case Kind.NON_NULL_TYPE:
      return `${typeKey(node.type)}!`;
    case Kind.LIST_TYPE:
      return `[${typeKey(node.type)}]`;
    case Kind.NAMED_TYPE:
      return node.name.value;
  }
};

/** name -> rendered type, or a refusal if a definition is malformed. */
function variableSet(operation: OperationDefinitionNode): Map<string, string> | string {
  const found = new Map<string, string>();
  for (const definition of (operation.variableDefinitions ??
    []) as ReadonlyArray<VariableDefinitionNode>) {
    const name = definition.variable.name.value;
    if (found.has(name)) {
      return `query.graphql defines the variable $${name} more than once`;
    }
    found.set(name, typeKey(definition.type));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Selection sets — recursive field-name-set equality
// ---------------------------------------------------------------------------

function fieldError(path: string, detail: string): string {
  return `query.graphql ${path === "" ? detail : `${detail} (at ${path})`}`;
}

function compareSelectionSets(
  reference: OperationDefinitionNode["selectionSet"],
  candidate: OperationDefinitionNode["selectionSet"],
  path: string,
): ForgeCapabilityQueryValidation {
  const referenceFields = fieldMap(reference, path);
  if (typeof referenceFields === "string") return { ok: false, reason: referenceFields };
  const candidateFields = fieldMap(candidate, path);
  if (typeof candidateFields === "string") return { ok: false, reason: candidateFields };

  for (const name of candidateFields.keys()) {
    if (!referenceFields.has(name)) {
      return {
        ok: false,
        reason: fieldError(path, `selects "${name}", which the pinned query does not select`),
      };
    }
  }
  for (const name of referenceFields.keys()) {
    if (!candidateFields.has(name)) {
      return {
        ok: false,
        reason: fieldError(path, `does not select "${name}", which the pinned query requires`),
      };
    }
  }
  for (const [name, field] of candidateFields) {
    const referenceField = referenceFields.get(name)!;
    const nextPath = path === "" ? name : `${path}.${name}`;
    const argumentsMismatch = compareArguments(referenceField, field, nextPath);
    if (argumentsMismatch !== null) return { ok: false, reason: argumentsMismatch };
    const hasChildren = field.selectionSet !== undefined;
    const referenceHasChildren = referenceField.selectionSet !== undefined;
    if (hasChildren !== referenceHasChildren) {
      return {
        ok: false,
        reason: fieldError(
          nextPath,
          referenceHasChildren
            ? `must select the subfields the pinned query selects`
            : `must be a plain field; the pinned query selects no subfields here`,
        ),
      };
    }
    if (hasChildren) {
      const nested = compareSelectionSets(
        referenceField.selectionSet!,
        field.selectionSet!,
        nextPath,
      );
      if (!nested.ok) return nested;
    }
  }
  return { ok: true };
}

/**
 * One selection set as name -> field node. Only plain fields are legal:
 * fragments and aliases are refused with their own reason, and a duplicate
 * field name at one level is a refusal (a set cannot hold it).
 */
function fieldMap(
  selectionSet: OperationDefinitionNode["selectionSet"],
  path: string,
): Map<string, FieldNode> | string {
  const fields = new Map<string, FieldNode>();
  for (const selection of selectionSet.selections as ReadonlyArray<SelectionNode>) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      return fieldError(path, "must not spread fragments");
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      return fieldError(path, "must not use inline fragments");
    }
    if (selection.alias !== undefined && selection.alias !== null) {
      return fieldError(path, `must not alias "${selection.alias.value}"`);
    }
    if ((selection.directives?.length ?? 0) > 0) {
      return fieldError(path, `must not use directives on "${selection.name.value}"`);
    }
    const name = selection.name.value;
    if (fields.has(name)) {
      return fieldError(path, `selects "${name}" more than once`);
    }
    fields.set(name, selection);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Arguments — structural identity with the reference at every field
// ---------------------------------------------------------------------------

/**
 * Compare one field's arguments against the reference field's. The sets of
 * argument names must be identical, and each value must be structurally
 * equal: literals of the same kind and value, variable references to the
 * same variable, and object/list values equal element-by-element. Returns
 * the refusal reason, or null when the arguments match.
 */
function compareArguments(reference: FieldNode, candidate: FieldNode, path: string): string | null {
  const referenceArgs = (reference.arguments ?? []) as ReadonlyArray<ArgumentNode>;
  const candidateArgs = (candidate.arguments ?? []) as ReadonlyArray<ArgumentNode>;
  const byName = new Map<string, ArgumentNode>();
  for (const argument of candidateArgs) {
    if (byName.has(argument.name.value)) {
      return fieldError(path, `passes argument "${argument.name.value}" more than once`);
    }
    byName.set(argument.name.value, argument);
  }
  for (const referenceArg of referenceArgs) {
    const candidateArg = byName.get(referenceArg.name.value);
    if (candidateArg === undefined) {
      return fieldError(
        path,
        `must pass the argument "${referenceArg.name.value}" exactly as the pinned query does`,
      );
    }
    const mismatch = compareValues(referenceArg.value, candidateArg.value);
    if (mismatch !== null) {
      return fieldError(
        path,
        `must pass "${referenceArg.name.value}" ${mismatch}, like the pinned query does`,
      );
    }
  }
  for (const name of byName.keys()) {
    if (!referenceArgs.some((argument) => argument.name.value === name)) {
      return fieldError(
        path,
        `passes argument "${name}", which the pinned query does not pass here`,
      );
    }
  }
  return null;
}

/** Structural equality of two GraphQL value nodes: null means equal. */
function compareValues(reference: ValueNode, candidate: ValueNode): string | null {
  if (reference.kind !== candidate.kind) {
    return `as a ${reference.kind.replace("Value", " value")}, not a ${candidate.kind.replace("Value", " value")}`;
  }
  switch (reference.kind) {
    case Kind.VARIABLE:
      return reference.name.value === (candidate as typeof reference).name.value
        ? null
        : `as the variable $${reference.name.value}`;
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return reference.value === (candidate as typeof reference).value
        ? null
        : `as the literal ${JSON.stringify(reference.value)}`;
    case Kind.NULL:
      return null;
    case Kind.LIST: {
      const referenceItems = reference.values as ReadonlyArray<ValueNode>;
      const candidateItems = (candidate as typeof reference).values as ReadonlyArray<ValueNode>;
      if (referenceItems.length !== candidateItems.length) {
        return `as a list of ${referenceItems.length} item(s)`;
      }
      for (let index = 0; index < referenceItems.length; index += 1) {
        const mismatch = compareValues(referenceItems[index]!, candidateItems[index]!);
        if (mismatch !== null) return `as a list whose item ${index} is ${mismatch}`;
      }
      return null;
    }
    case Kind.OBJECT: {
      const referenceFields = reference.fields as ReadonlyArray<ObjectFieldNode>;
      const candidateFields = (candidate as typeof reference)
        .fields as ReadonlyArray<ObjectFieldNode>;
      const byName = new Map<string, ObjectFieldNode>();
      for (const field of candidateFields) {
        if (byName.has(field.name.value)) {
          return `as an object without duplicate "${field.name.value}" keys`;
        }
        byName.set(field.name.value, field);
      }
      // Extra keys are reported first so the refusal names exactly what the
      // generated query substituted (e.g. `number_gte` for `number`).
      for (const name of byName.keys()) {
        if (!referenceFields.some((field) => field.name.value === name)) {
          return `as an object without the extra key "${name}"`;
        }
      }
      for (const referenceField of referenceFields) {
        const candidateField = byName.get(referenceField.name.value);
        if (candidateField === undefined) {
          return `as an object carrying the key "${referenceField.name.value}"`;
        }
        const mismatch = compareValues(referenceField.value, candidateField.value);
        if (mismatch !== null)
          return `as an object whose "${referenceField.name.value}" is ${mismatch}`;
      }
      return null;
    }
  }
}
