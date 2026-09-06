/**
 * Stable command identities for provider skills (10B).
 *
 * A provider can legitimately expose two different skills under the same NAME
 * from different paths (a user copy and a workspace copy, say), and a
 * provider's own list can repeat the same skill record. React keys and the
 * menu's highlight/select plumbing key off `item.id`, so an id derived from
 * the name alone collides: duplicate-key rendering faults, and a highlight on
 * one row selecting another's payload.
 *
 * Identity is therefore provider + name + normalized path. Only records that
 * agree on ALL three are duplicates; different-path records stay separate
 * items with their own payloads, distinguishable by their path context.
 *
 * @module composerSkillIdentity
 */
import type { ProviderDriverKind, ServerProviderSkill } from "@t3tools/contracts";

/** Normalize path separators so `a\b` and `a/b` are one skill, not two. */
export function normalizeSkillPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface ComposerSkillIdentityInput {
  readonly provider: ProviderDriverKind;
  readonly skill: Pick<ServerProviderSkill, "name" | "path">;
}

/**
 * The stable item id for a provider skill: provider + name + normalized path.
 * Survives search reordering (it never depends on position) and never
 * collides across same-name skills from different paths.
 */
export function composerSkillItemId(input: ComposerSkillIdentityInput): string {
  return `skill:${input.provider}:${input.skill.name}:${normalizeSkillPath(input.skill.path)}`;
}

/** True when two records are the SAME skill: provider, name and path all agree. */
export function isSameComposerSkill(
  a: ComposerSkillIdentityInput,
  b: ComposerSkillIdentityInput,
): boolean {
  return (
    a.provider === b.provider &&
    a.skill.name === b.skill.name &&
    normalizeSkillPath(a.skill.path) === normalizeSkillPath(b.skill.path)
  );
}

/**
 * Path context short enough for a menu row: the last segments that
 * distinguish a same-name collision, without the whole filesystem prefix.
 */
export function skillPathContext(path: string, segments = 2): string {
  const parts = normalizeSkillPath(path)
    .split("/")
    .filter((part) => part.length > 0);
  return parts.slice(-segments).join("/");
}
