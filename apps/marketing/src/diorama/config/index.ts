/**
 * Central tuning table for the diorama. World coordinates, timings,
 * probabilities and volumes live here (spec §56) — implementation files
 * must not grow private magic numbers.
 */

export const WORLD = {
  width: 2816,
  height: 1536,
} as const;

export const CAMERA = {
  fitMargin: 0.94,
  maxZoomFactor: 2.4,
  focusZoomFactor: 1.9,
  focusDuration: 1.1,
  idleDriftDelaySec: 25,
  idleDriftSpeed: 2.2, // world px per second, deliberately glacial
  phoneGuidedZoomFactor: 1.6,
  phoneBreakpoint: 720,
} as const;

export const AGENTS = {
  walkSpeed: 88, // world px per second
  runSpeed: 200,
  bodyHeight: 60, // world px, painted sprites are scaled to this (normal class)
  depthScaleMin: 1.0,
  depthScaleMax: 1.06,
  bobHeight: 3,
  bobFrequency: 7.5, // steps per second while walking
  squashLimit: 0.15,
  blinkMinSec: 2.4,
  blinkMaxSec: 6.0,
  /** Scale classes (phase 9): background cast reads smaller, emphasis pops. */
  scaleClass: { background: 0.75, normal: 1.0, emphasis: 1.15 },
  /** Contact shadow (phase 10): soft, wide, shallow; fades as the body rises. */
  // Round 4: raised to the top of the band + widened so the shadow still
  // reads on dark floors (budget/archives/observatory were flagged).
  shadow: {
    alpha: 0.2,
    widthFactor: 0.86,
    heightFactor: 0.25,
    liftScale: 0.85,
    liftAlphaDrop: 0.05,
  },
} as const;

/** Painted prop target sizes in world px (longest axis) — per key, no global texel. */
export const PROPS = {
  "order-crate": 34,
  "rejected-order-crate": 34,
  "stamped-order-crate": 34,
  dossier: 26,
  bell: 34,
  "bell-small": 22,
  "trade-md-sealed": 30,
  "trade-md-drift": 30,
  "reduce-only-tag": 20,
  "ribbon-blue": 18,
  "ribbon-red": 18,
  lever: 30,
  telescope: 32,
  terminal: 26,
  receipt: 18,
  "archive-capsule": 22,
  coffee: 18,
  papers: 18,
  // Procedural FX fallbacks (2x-rendered): texel 0.5.
  cart: 20,
  x: 18,
  check: 18,
} as const;

/** Painted hover-ferry: whole-sprite target height in world px (hull ~30). */
export const FERRY = {
  heightWorld: 88,
} as const;

export const BUBBLES = {
  maxVisible: 3,
  minLifeSec: 0.8,
  maxLifeSec: 2.5,
} as const;

export const AUDIO = {
  groups: { ambient: 0.15, mechanical: 0.22, character: 0.3 },
  cooldowns: { ambient: 0, mechanical: 350, character: 1200, rare: 8000 },
  maxPan: 0.5,
  falloffNear: 900, // world px from camera center before volume decays
  falloffFar: 2400,
  storageKey: "t3-diorama-sound",
} as const;

export const DIRECTOR = {
  reducedMotionFactor: 2.6, // cadences stretch under prefers-reduced-motion
  maxConcurrentEvents: 5,
  bubbleHogSlots: 2, // events that show bubbles may not exceed this concurrently
} as const;

export const ENTRANCE = {
  totalSec: 3.8,
} as const;

export const PROBABILITIES = {
  gauntletReject: 0.22,
  vaultKeylessRefusal: 0.25,
  operatorDemoGagOnFocus: 0.5,
  cryChance: 0.04, // chance a freed wanderer idles into a cry gag
} as const;

export type SoundGroup = "ambient" | "mechanical" | "character" | "rare";

/** Speech-bubble vocabularies: symbols first, never sentences (spec §25). */
export const BUBBLE_WORDS = {
  question: ["?!", "?"],
  confirm: ["✓", "OK"],
  wait: ["...", "WAIT"],
  refuse: ["NOPE", "X"],
  ready: ["READY"],
  alarm: ["!!"],
  love: ["♡"],
  demo: ["DEMO"],
  glyphs: ["{ }", "</>", "?!", "∑", "⌘", "···"],
  translated: ["T3"],
  snacks: ["∗"],
} as const;
