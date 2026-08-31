/**
 * Zone map, named places, waypoint routes and cast roster for the diorama
 * world (2816x1536, origin top-left). Percent bboxes come from the master
 * contract §5 / canonical analysis; px conversion happens once here.
 */
import { WORLD } from "./index";

export type ZoneId =
  | "registrar"
  | "scribe"
  | "gauntlet"
  | "watchtower"
  | "operator"
  | "interpreters"
  | "vault"
  | "tribunal"
  | "observatory"
  | "archives"
  | "budget"
  | "bridge"
  | "bazaar";

export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** (x, y, w, h) percentages of the reference image. */
  bbox: [number, number, number, number];
  copy: string;
}

export const ZONES: readonly ZoneDef[] = [
  {
    id: "registrar",
    name: "Mission Registrar",
    bbox: [39, 9, 9, 18],
    copy: "Wakes and missions are logged here before any work starts.",
  },
  {
    id: "scribe",
    name: "Scribe's Office",
    bbox: [52, 9, 10, 18],
    copy: "Every decision, order and fill is journalled to the archive.",
  },
  {
    id: "gauntlet",
    name: "Preview Gauntlet",
    bbox: [19, 28, 20, 26],
    copy: "Orders ride the scanner line; anything that fails a check is diverted before signing.",
  },
  {
    id: "watchtower",
    name: "Watchtower",
    bbox: [42, 28, 19, 24],
    copy: "Configured conditions ring the bell and wake the agent with a dossier.",
  },
  {
    id: "operator",
    name: "The Operator's House",
    bbox: [62, 20, 16, 25],
    copy: "Pause, cancel, reduce, close, revoke — oversized controls only the human may touch.",
  },
  {
    id: "interpreters",
    name: "Interpreters' Row",
    bbox: [63, 40, 16, 17],
    copy: "Codex, Claude, Cursor, Grok and OpenCode each speak here; one typed contract leaves.",
  },
  {
    id: "vault",
    name: "Signer's Vault",
    bbox: [25, 54, 9, 28],
    copy: "Keys never leave the vault. Signing is local, sealed, deterministic.",
  },
  {
    id: "tribunal",
    name: "Tribunal",
    bbox: [42, 56, 18, 26],
    copy: "No verdict before 30 trades — backtests earn the right to argue.",
  },
  {
    id: "observatory",
    name: "Observatory",
    bbox: [57, 51, 15, 23],
    copy: "Telescopes and charts. Market research works with no signer at all.",
  },
  {
    id: "archives",
    name: "Archives",
    bbox: [31, 48, 12, 22],
    copy: "Every event stays replayable; the exchange remains authoritative.",
  },
  {
    id: "budget",
    name: "Budget Desk",
    bbox: [0, 38, 25, 20],
    copy: "Loss budgets gate new exposure. Existing protection never disappears.",
  },
  {
    id: "bridge",
    name: "Testnet Bridge",
    bbox: [71, 68, 14, 8],
    copy: "The only route out of the Bureau. Everything crossing it is already signed.",
  },
  {
    id: "bazaar",
    name: "Hyperliquid Bazaar",
    bbox: [78, 65, 21, 33],
    copy: "Testnet only. Positions, orders and fills live here — authoritatively.",
  },
];

const PX = { x: WORLD.width / 100, y: WORLD.height / 100 };

/**
 * BAKED-STATIC KEEP-OUTS (phase 20). The actor-cleared plate still bakes
 * these populations (vision-mapped rects, % of world, padded ~0.5%):
 * animated actors' feet must never fall inside them, and posts/lanes are
 * authored clear of them. The observatory/control/trading interiors are
 * avoided outright; the scribe and reception desks have staff posts moved
 * to a standing position BESIDE the baked seated figure instead of on it.
 */
export const BAKED_KEEP_OUT: readonly [number, number, number, number][] = [
  [52.5, 19.5, 7, 5.5], // scribe seated at the paper desk (top Bureau)
  [5.5, 61.5, 6, 5.5], // reception clerk at the laptop (lower-left)
  [76.5, 7.5, 15, 10.5], // trading room: 8 baked operators (top-right)
  // Round 4: observatory population core + the glass-partition NPC tile,
  // shaped so the booth-approach lane (y<=52.5) stays walkable.
  [58.5, 54, 8.5, 4.5], // round-5: reshaped clear of the audited booth apron (y53.4)
  [73, 54.8, 2, 2.8],
  [56.5, 62.5, 12, 8.5], // lower control room: 4 baked + 2
  // Round 4: MEASURED from the plate (vision boxes converted to world %):
  // archives cabinets x32.5-38.4 y52-63.8 + desk cluster x30.4-41.4 y57.7-71.3.
  [30.5, 55, 11, 16.5],
  // Round 4: measured vault monolith+basin x27.1-32.9 y57.5-72.5; round 5
  // found water at the south rim too (x to ~34, y to ~75).
  [26.8, 57.5, 8, 18.3],
  // Round 5 surface audit: standing structure zones with no verified floor.
  [7.5, 54.5, 6.5, 5], // budget desk block (tabletop + desk front)
  [63.5, 49, 14.5, 3.5], // interpreter booth facades + windows
  [64.5, 46, 9, 4], // operator house front wall / sign band
  [48.5, 52, 5, 5], // bell tower platform + railings
  [66, 59.5, 7, 5.5], // observatory telescope pier bank + consoles
  [31.8, 54.2, 7.5, 4.2], // gauntlet south racks/cabinets below the belt
  [41.8, 46.4, 4, 6], // chute / scanner machine block
  [70.8, 70.2, 5, 3.5], // bridge base railing
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pctRect(bbox: [number, number, number, number]): Rect {
  return { x: bbox[0] * PX.x, y: bbox[1] * PX.y, w: bbox[2] * PX.x, h: bbox[3] * PX.y };
}

export const ZONE_RECTS: Readonly<Record<ZoneId, Rect>> = Object.fromEntries(
  ZONES.map((z) => [z.id, pctRect(z.bbox)]),
) as Readonly<Record<ZoneId, Rect>>;

export function zoneCenter(id: ZoneId): { x: number; y: number } {
  const r = ZONE_RECTS[id];
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** pct helper for authored points: pctPoint(51, 22) -> world px. */
export function pctPoint(xPct: number, yPct: number): { x: number; y: number } {
  return { x: xPct * PX.x, y: yPct * PX.y };
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Named open lanes and posts. Bots only walk between these — architecture
 * occlusion is baked into the plate, so authored lanes stay in front of
 * furniture and on deck centers (contract §4 occlusion strategy).
 */
export const PLACES: Readonly<Record<string, Pt>> = Object.fromEntries([
  ["mezzCenter", pctPoint(51, 22)],
  ["registrarDesk", pctPoint(42.3, 23.6)],
  ["scribeDesk", pctPoint(57, 22)],
  ["gauntletIn", pctPoint(23, 49)],
  ["gauntletMid", pctPoint(28.5, 52.3)],
  ["gauntletOut", pctPoint(37, 49)],
  ["centralFloor", pctPoint(50.6, 66.2)],
  ["tribunalEdge", pctPoint(53.5, 67)],
  ["tribunalDais", pctPoint(48.6, 68.6)],
  ["watchtowerBase", pctPoint(50.8, 53.2)],
  // Floor placements only — never on counters, chassis or roofs:
  // chute exit steps back onto the deck below/left of the NO VERDICT panel
  // (panel starts x46, y56); operatorFront is the flat walkway between the
  // lever console (ends ~y38) and the interpreter booths (y51), not the
  // angled chassis; bazaarStall is the island ground in front of the
  // merchant counter (~y80).
  ["chute", pctPoint(43.2, 47.5)],
  ["operatorFront", pctPoint(70.5, 47.5)],
  ["operatorLever", pctPoint(70, 33)],
  // Round 4: moved south-west, clear of the glass-partition baked NPC
  // (x73.4-74.3, y55.3-57.1) now covered by the observatory keep-out.
  ["interpretersFront", pctPoint(66.5, 59.6)],
  ["boothCodex", pctPoint(65.5, 53.4)],
  ["boothClaude", pctPoint(68.5, 53.4)],
  ["boothCursor", pctPoint(71.5, 51)],
  ["boothGrok", pctPoint(74.5, 51)],
  ["boothOpenCode", pctPoint(77, 55.6)],
  // Rounds 3-4: the vault is a sealed monolith in a water basin; the
  // service window, guard and approach all stand on the measured south-rim
  // floor (basin ends y72.5, archives desk cluster begins x~30.5).
  ["vaultWindow", pctPoint(40.5, 74.8)],
  ["vaultApproach", pctPoint(40.5, 74.8)],
  ["vaultLanding", pctPoint(37.7, 74.5)],
  // archivesFront is one step DOWN from the counter (desk tile is a keep-out
  // since round 2: the baked seated archives clerk sits at y~61-63).
  ["archivesFront", pctPoint(37, 72.6)],
  ["archivesSlot", pctPoint(36, 56)],
  ["observatoryFloor", pctPoint(54.2, 66.6)],
  ["rightLowerLane", pctPoint(63, 73.8)],
  // Round 4: measured pier bank (three floor telescopes x67.6-73.3); the
  // watcher stands on the platform SOUTH of the piers, not on a scope.
  ["telescope", pctPoint(68.3, 61.7)],
  ["budgetFront", pctPoint(11.5, 62)], // round-5 audited floor
  ["budgetDesk", pctPoint(10.8, 55.8)],
  ["bridgeStart", pctPoint(72.5, 71)],
  ["bridgeEnd", pctPoint(84.5, 71)],
  ["bazaarDeck", pctPoint(88.6, 76.2)],
  ["bazaarStall", pctPoint(85.6, 86.6)],
  ["leftCatwalk", pctPoint(7, 44)],
  ["leftLowerDeck", pctPoint(10, 55)],
  ["rightDeck", pctPoint(80, 22)],
  ["pipeDeck", pctPoint(81.5, 38)],
  ["bazaarWater", pctPoint(84, 84)],
  // Painted-cast posts (cleared zones; see CAST docblock):
  // scanner clerk stands at the conveyor's scanner notch (up-slope of the
  // mid line), divert pair below the last station; tribunal podium/desk on
  // the cleared ring; reception visitor at the lower-left cleared desk;
  // registrar railing observer behind the desk rail; interpreters' staff
  // BEHIND the booth counters (customers stay at the booth* fronts);
  // bazaar watcher on the island lawn's cleared edge.
  // Gauntlet actor posts stand on the floor BELOW the belt (belt + crate
  // path occupies roughly y 47-52.5% between x 19-37%): the scanner clerk
  // and divert pair stay adjacent to, never inside, the crate corridor.
  // (Verification round 2 fix: carry runner / scanner clerk previously
  // posted ON the belt's lower curve and read as standing on a crate.)
  ["gauntletScanner", pctPoint(24.6, 55.8)],
  ["gauntletDivert", pctPoint(33.5, 55)],
  ["gauntletStart", pctPoint(22.5, 55)],
  ["gauntletLane", pctPoint(29, 54.8)],
  ["gauntletFront", pctPoint(35.5, 54.5)],
  ["tribunalPodium", pctPoint(50.5, 66.5)],
  ["tribunalDesk", pctPoint(46.5, 70.5)],
  // Verification round 2: visitors/staff stand BESIDE the baked seated
  // figures (reception laptop desk, scribe paper desk, archives desk),
  // never on the NPC's tile — see BAKED_KEEP_OUT above.
  ["receptionVisitor", pctPoint(14.8, 66.2)],
  ["scribeSide", pctPoint(50, 24.5)],
  ["archivesSide", pctPoint(40.8, 73.4)],
  ["registrarRailing", pctPoint(49.8, 23.8)],
  ["boothStaffMid", pctPoint(79.5, 53.8)],
  // East-side approach lane to the booths (keeps customer paths out of
  // the observatory population core).
  ["boothLane", pctPoint(78.5, 52.5)],
  ["bazaarWatch", pctPoint(86.5, 80.5)],
]);

export type RouteName =
  | "registrar>gauntlet"
  | "gauntlet>vault"
  | "vault>bridge"
  | "watchtower>central"
  | "observatory>central"
  | "interpreters>central"
  | "tagging>orders"
  | "central>tribunal"
  | "central>archives"
  | "budget>central"
  | "bazaar>stall";

export const ROUTES: Readonly<Record<RouteName, Pt[]>> = {
  "registrar>gauntlet": [
    PLACES.registrarDesk,
    PLACES.mezzCenter,
    PLACES.gauntletStart,
    PLACES.gauntletLane,
  ],
  "gauntlet>vault": [PLACES.gauntletOut, PLACES.centralFloor, PLACES.vaultApproach],
  "vault>bridge": [
    PLACES.vaultWindow,
    PLACES.centralFloor,
    PLACES.observatoryFloor,
    PLACES.rightLowerLane,
    PLACES.bridgeStart,
    PLACES.bridgeEnd,
  ],
  "watchtower>central": [PLACES.mezzCenter, PLACES.centralFloor],
  "observatory>central": [PLACES.observatoryFloor, PLACES.centralFloor],
  "interpreters>central": [PLACES.boothClaude, PLACES.centralFloor],
  "tagging>orders": [PLACES.archivesFront, PLACES.gauntletOut, PLACES.gauntletLane],
  "central>tribunal": [PLACES.centralFloor, PLACES.tribunalDais],
  "central>archives": [PLACES.centralFloor, PLACES.archivesFront],
  "budget>central": [PLACES.budgetFront, PLACES.centralFloor],
  "bazaar>stall": [PLACES.bazaarDeck, PLACES.bazaarStall],
};

export type AgentRole = "analyst" | "clerk" | "worker" | "guard" | "interpreter" | "watcher";
export type CastKind = "frequent" | "occasional" | "stationary";
/** Scale classes (phase 9): validated against desks/conveyor at 2.4x zoom. */
export type ScaleClass = "background" | "normal" | "emphasis";

export interface CastEntry {
  id: string;
  /** Painted family (bots.json `family-state` keys). */
  role: AgentRole;
  kind: CastKind;
  /** Home post (spawn point; stationary clerks never leave it). */
  post: string;
  /** Initial pose state suffix; defaults to the family neutral. */
  pose?: string;
  scaleClass?: ScaleClass;
}

/**
 * Painted cast on the actor-cleared plate (12-generated-art-contract cast
 * plan, coordinates in this file's verified zone space — see impl2.md D0).
 * Deep-background rooms (observatory, control room, trading room) keep
 * their baked statics: no actor posts inside them. Interpreters stand
 * BEHIND the booth counters; customers approach from the front.
 */
export const CAST: readonly CastEntry[] = [
  // Preview Gauntlet (cleared line): runner, approver, divert reactions.
  { id: "w1", role: "worker", kind: "frequent", post: "gauntletStart", pose: "crate" },
  { id: "w2", role: "worker", kind: "frequent", post: "gauntletOut" },
  {
    id: "c3",
    role: "clerk",
    kind: "stationary",
    post: "gauntletScanner",
    pose: "stamp",
    scaleClass: "emphasis",
  },
  { id: "o3", role: "clerk", kind: "occasional", post: "gauntletLane", pose: "reject" },
  // Central floor + tribunal ring (cleared): arguers, podium, celebrant.
  { id: "w3", role: "analyst", kind: "frequent", post: "centralFloor", pose: "tablet" },
  { id: "w4", role: "analyst", kind: "frequent", post: "tribunalEdge", pose: "tablet" },
  {
    id: "o4",
    role: "analyst",
    kind: "occasional",
    post: "tribunalDais",
    pose: "point",
    scaleClass: "emphasis",
  },
  { id: "t1", role: "clerk", kind: "stationary", post: "tribunalPodium" },
  { id: "t2", role: "guard", kind: "stationary", post: "tribunalDesk", scaleClass: "background" },
  // Watchtower ringer (bell tower cleared spot).
  { id: "o8", role: "worker", kind: "occasional", post: "registrarRailing" },
  // Reception / archives (cleared desk trio).
  { id: "c6", role: "clerk", kind: "stationary", post: "archivesFront", pose: "papers" },
  { id: "w5", role: "worker", kind: "frequent", post: "archivesSide" },
  {
    id: "r1",
    role: "analyst",
    kind: "occasional",
    post: "vaultApproach",
    pose: "tablet",
    scaleClass: "background",
  },
  // Registrar (cleared): seated clerk + railing analyst.
  { id: "c1", role: "clerk", kind: "stationary", post: "registrarDesk" },
  {
    id: "r2",
    role: "analyst",
    kind: "stationary",
    post: "registrarRailing",
    scaleClass: "background",
  },
  // Scribe + budget + vault (stationary staff).
  { id: "c2", role: "clerk", kind: "stationary", post: "scribeSide", pose: "papers" },
  { id: "c5", role: "clerk", kind: "stationary", post: "budgetFront", pose: "stamp" },
  {
    id: "c4",
    role: "guard",
    kind: "stationary",
    post: "vaultLanding",
    pose: "alert",
    scaleClass: "background",
  },
  // Operator house + interpreters (staff behind the counters).
  { id: "o2", role: "interpreter", kind: "occasional", post: "boothStaffMid", pose: "tablet" },
  {
    id: "i1",
    role: "interpreter",
    kind: "stationary",
    post: "boothOpenCode",
    pose: "tablet",
    scaleClass: "background",
  },
  { id: "o6", role: "analyst", kind: "occasional", post: "boothClaude" },
  // Observatory railing (outside the baked interior) + bridge cart.
  { id: "s4", role: "watcher", kind: "stationary", post: "observatoryFloor", pose: "telescope" },
  { id: "w6", role: "worker", kind: "frequent", post: "rightLowerLane", pose: "crate" },
  // Bazaar island (cleared): merchant, customers, watcher.
  {
    id: "s3",
    role: "interpreter",
    kind: "stationary",
    post: "bazaarStall",
    pose: "tablet",
    scaleClass: "emphasis",
  },
  { id: "o7", role: "analyst", kind: "occasional", post: "bazaarDeck" },
  {
    id: "b1",
    role: "watcher",
    kind: "stationary",
    post: "bazaarWatch",
    pose: "binoculars",
    scaleClass: "background",
  },
];
