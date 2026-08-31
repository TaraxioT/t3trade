/**
 * Story timeline invariants for the diorama loop, run in bare node
 * (`node ./src/diorama/story/story.test.ts`). Mirrors src/lib/beats.test.ts:
 * collect failures, print a summary, exit 1 on any failure.
 *
 * Node cannot resolve the extensionless relative imports used by the diorama
 * modules (they are authored for Astro/Vite), so a resolve hook that retries
 * with an explicit ".ts" is registered before the dynamic import below. The
 * test itself stays pure: no THREE, only compileBeats() outputs and the pure
 * evaluators from beats.ts.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, context, nextResolve) {
    try {
      return nextResolve(spec, context);
    } catch (error) {
      if (spec.startsWith(".")) return nextResolve(`${spec}.ts`, context);
      throw error;
    }
  },
});

const { DURATION_MS } = await import("../config.ts");
const beats = await import("./beats.ts");
const types = await import("../types.ts");
const asAid = types.asActorId;
const asPid = types.asPropId;

const failures: string[] = [];
const check = (claim: string, ok: boolean): void => {
  if (!ok) failures.push(claim);
};

let compiled: ReturnType<typeof beats.compileBeats>;
try {
  compiled = beats.compileBeats();
} catch (error) {
  console.error(`FAIL compileBeats threw: ${(error as Error).message}`);
  process.exit(1);
}

/* Structure: compiled tracks are complete and time-sorted. */
{
  check("ten beats compiled", compiled.beats.length === 10);
  let commands = 0;
  for (const beat of compiled.beats) {
    commands += beat.actorCommands.length + beat.propCommands.length;
    check(`beat ${beat.id} ordered`, beat.startMs >= 0 && beat.durationMs > 0);
  }
  for (const [actorId, track] of compiled.actorTracks) {
    for (let i = 1; i < track.starts.length; i += 1) {
      check(
        `actor ${actorId} track sorted`,
        (track.starts[i - 1] as number) <= (track.starts[i] as number),
      );
    }
  }
  for (const [propId, track] of compiled.propTracks) {
    for (let i = 1; i < track.starts.length; i += 1) {
      check(
        `prop ${propId} track sorted`,
        (track.starts[i - 1] as number) <= (track.starts[i] as number),
      );
    }
  }
  console.log(
    `commands: ${commands} across ${compiled.actorTracks.size} actor tracks, ${compiled.propTracks.size} prop tracks, ${compiled.cues.length} cues, ${compiled.ownership.length} grabs`,
  );
}

/* References: every command subject and target is known (compileBeats also
   validates this, but a double check catches evaluator drift). */
{
  for (const actorId of compiled.actorTracks.keys()) {
    check(`actor ${actorId} in cast`, (beats.ACTOR_IDS as readonly string[]).includes(actorId));
  }
  for (const propId of compiled.propTracks.keys()) {
    check(`prop ${propId} known`, (beats.PROP_IDS as readonly string[]).includes(propId));
  }
  for (const cue of compiled.cues) {
    check(
      `cue ${cue.cueId} at ${cue.timeMs} inside loop`,
      cue.timeMs >= 0 && cue.timeMs < DURATION_MS,
    );
  }
}

/* Attachment legality: no double-owner at any sampled instant, none at the
   seam, strict alternation (compileBeats enforces authoring; this samples the
   evaluated state every 100ms as an independent witness). */
{
  let grabs = 0;
  const owners = new Map<string, number>(); // propId -> concurrent owners
  for (let t = 0; t < DURATION_MS; t += 100) {
    owners.clear();
    for (const own of compiled.ownership) {
      if (own.startMs > t) continue;
      const detached = compiled.propTracks
        .get(asPid(own.propId))
        ?.commands.some(
          (c) => c.kind === "detachProp" && c.startMs > own.startMs && c.startMs <= t,
        );
      if (!detached) {
        grabs += 1;
        owners.set(own.propId, (owners.get(own.propId) ?? 0) + 1);
      }
    }
    for (const [propId, count] of owners) {
      check(`prop ${propId} has one owner at ${t}`, count === 1);
    }
  }
  check(
    "every grab released before the seam",
    compiled.ownership.every(
      (own) =>
        compiled.propTracks
          .get(asPid(own.propId))
          ?.commands.some(
            (c) =>
              c.kind === "detachProp" && c.startMs > own.startMs && c.startMs < DURATION_MS - 500,
          ) ?? false,
    ),
  );
  console.log(`attachment samples clean (grabs observed: ${grabs})`);
}

/* Seam equivalence: t = 0 vs t = 90000 must match for every actor, prop, and
   machine channel within 1e-3. */
{
  const machineAt0 = beats.createMachineState();
  const machineAtEnd = beats.createMachineState();
  beats.evaluateMachines(0, machineAt0);
  beats.evaluateMachines(DURATION_MS, machineAtEnd);
  for (const key of Object.keys(machineAt0) as (keyof typeof machineAt0)[]) {
    check(
      `machine ${key} seam (${machineAt0[key]} vs ${machineAtEnd[key]})`,
      Math.abs(machineAt0[key] - machineAtEnd[key]) < 1e-3,
    );
  }
  check("mood seam", beats.moodValue(0) === 1 && Math.abs(beats.moodValue(DURATION_MS) - 1) < 1e-9);

  for (const actorId of beats.ACTOR_IDS) {
    const a = beats.createActorEval(asAid(actorId));
    const b = beats.createActorEval(asAid(actorId));
    beats.evaluateActor(compiled, asAid(actorId), 0, a);
    beats.evaluateActor(compiled, asAid(actorId), DURATION_MS, b);
    const d = Math.max(
      Math.abs(a.position.x - b.position.x),
      Math.abs(a.position.y - b.position.y),
      Math.abs(a.position.z - b.position.z),
    );
    check(`actor ${actorId} seam position (${d.toFixed(5)})`, d < 1e-3);
    check(`actor ${actorId} seam yaw`, Math.abs(a.yaw - b.yaw) < 1e-3);
    check(`actor ${actorId} seam state (${a.state}/${b.state})`, a.state === b.state);
    check(`actor ${actorId} seam unattached`, a.carriedPropId === null && b.carriedPropId === null);
  }
  for (const propId of beats.PROP_IDS) {
    const a = beats.createPropEval(asPid(propId));
    const b = beats.createPropEval(asPid(propId));
    beats.evaluateProp(compiled, asPid(propId), 0, a);
    beats.evaluateProp(compiled, asPid(propId), DURATION_MS, b);
    const d = Math.max(
      Math.abs(a.position.x - b.position.x),
      Math.abs(a.position.y - b.position.y),
      Math.abs(a.position.z - b.position.z),
    );
    check(`prop ${propId} seam position (${d.toFixed(5)})`, d < 1e-3);
    check(`prop ${propId} seam anchor (${a.anchorId}/${b.anchorId})`, a.anchorId === b.anchorId);
    check(`prop ${propId} seam visible`, a.visible === b.visible);
    check(`prop ${propId} seam unowned`, a.ownerActorId === null && b.ownerActorId === null);
  }
  console.log(
    `seam: ${beats.ACTOR_IDS.length} actors, ${beats.PROP_IDS.length} props, ${Object.keys(machineAt0).length} machine channels`,
  );
}

/* Cues: the full multiset fires exactly once per loop under 50ms forward
   stepping (the same window logic the director's collectCrossings uses).
   Parallel fragments may lawfully fire different subjects at the same
   millisecond, so equality is per (timeMs, cueId) MULTISET, not per ms. */
{
  const STEP = 50;
  const fired: string[] = [];
  for (let t = 0; t < DURATION_MS; t += STEP) {
    for (const cue of compiled.cues) {
      if (cue.timeMs >= t && cue.timeMs < t + STEP) fired.push(`${cue.timeMs}:${cue.cueId}`);
    }
  }
  const authored = compiled.cues.map((cue) => `${cue.timeMs}:${cue.cueId}`).sort();
  const observed = fired.slice().sort();
  check(
    `every cue fired exactly once (${observed.length}/${authored.length})`,
    observed.length === authored.length && observed.every((v, i) => v === authored[i]),
  );
  console.log(
    `cues: ${compiled.cues.length} fired exactly once (multiset, parallel same-ms cues legal)`,
  );
}

/* Cue windows across seams: collectCueCrossings must fire each authored cue
   exactly once per covered loop for the ever-increasing logical clock. */
{
  const director = await import("./director.ts");
  const cuesAt = (from: number, to: number) =>
    director.collectCueCrossings(compiled.cues, from, to);
  const label = (list: readonly { cueId: string; timeMs: number }[]) =>
    list.map((cue) => `${cue.timeMs}:${cue.cueId}`).join(",");

  // Loop-1 seam: only cues authored in [89990, 90000) + [0, 10) - none are.
  check(
    `seam window 89990-90010 (${label(cuesAt(89990, 90010))})`,
    label(cuesAt(89990, 90010)) === "",
  );
  // The latest authored cue (data-driven: the merged table's last entry)
  // fires once in-loop and once per covered loop.
  const lastCue = compiled.cues[compiled.cues.length - 1];
  const lastLabel = `${lastCue.timeMs}:${lastCue.cueId}`;
  check(
    `last cue ${lastLabel} fires in-loop`,
    label(cuesAt(lastCue.timeMs - 10, lastCue.timeMs + 10)) === lastLabel,
  );
  check(
    `last cue ${lastLabel} fires on loop 2`,
    label(cuesAt(DURATION_MS + lastCue.timeMs - 10, DURATION_MS + lastCue.timeMs + 10)) ===
      lastLabel,
  );
  check(
    `loop-2 seam window 179990-180010 is empty as authored`,
    label(cuesAt(179990, 180010)) === "",
  );

  // Whole loops: N copies of the full table, each cue exactly N times.
  for (const loops of [1, 2, 5]) {
    const fired = cuesAt(0, loops * DURATION_MS);
    check(
      `${loops} whole loops fire ${loops * compiled.cues.length} cues`,
      fired.length === loops * compiled.cues.length,
    );
    const perCue = new Map<string, number>();
    for (const cue of fired)
      perCue.set(`${cue.timeMs}:${cue.cueId}`, (perCue.get(`${cue.timeMs}:${cue.cueId}`) ?? 0) + 1);
    // Parallel subjects may share (timeMs, cueId); each such copy fires
    // exactly `loops` times, so every count must be an exact multiple.
    for (const [key, count] of perCue)
      check(`cue ${key} fired a whole number of loops (${count}/${loops})`, count % loops === 0);
  }

  // Multi-loop span = tail of loop 0 + full loop + head of loop 2.
  const span = label(cuesAt(45000, 2 * DURATION_MS + 20000));
  const expected = [...cuesAt(45000, DURATION_MS), ...cuesAt(0, DURATION_MS), ...cuesAt(0, 20000)]
    .map((cue) => `${cue.timeMs}:${cue.cueId}`)
    .join(",");
  check(
    `multi-loop span 45000-${2 * DURATION_MS + 20000} matches decomposition`,
    span === expected,
  );

  // Degenerate/backwards windows emit nothing.
  check("backwards window empty", cuesAt(90010, 89990).length === 0);
  console.log(`cue windows: seam, loop-2 seam, whole-loop copies, multi-loop span all exact`);
}

/* v2 channels: express/glyph/beam compile validation + pure evaluation. */
{
  const t = types;
  const mkBeat = (
    cmds: readonly { actorId: string; command: unknown }[],
  ): ReturnType<typeof beats.compileStory>["beats"] => [
    {
      id: t.asBeatId("synthetic"),
      startMs: 0,
      durationMs: DURATION_MS,
      actorCommands: cmds.map((c) => ({
        actorId: t.asActorId(c.actorId),
        command: c.command as import("../types.ts").ActorCommand,
      })),
      propCommands: [],
    },
  ];
  const express = (actorId: string, expression: string, startMs: number, endMs: number) => ({
    kind: "express",
    actorId: t.asActorId(actorId),
    expression,
    startMs,
    endMs,
  });
  const glyph = (actorId: string, g: string, startMs: number, durationMs: number) => ({
    kind: "glyph",
    actorId: t.asActorId(actorId),
    glyph: g,
    startMs,
    durationMs,
  });
  const beam = (
    actorId: string,
    from: string,
    to: string,
    startMs: number,
    durationMs: number,
  ) => ({
    kind: "beam",
    actorId: t.asActorId(actorId),
    from: t.asWaypointId(from),
    to: t.asWaypointId(to),
    startMs,
    durationMs,
  });
  const mustThrow = (
    name: string,
    cmds: readonly { actorId: string; command: unknown }[],
  ): void => {
    try {
      beats.compileStory(mkBeat(cmds));
      check(`${name} rejected`, false);
    } catch {
      check(`${name} rejected`, true);
    }
  };

  // Valid table: all three kinds compile (beam wrapper id differs from the
  // command's own actorId - both placements accepted, own id wins).
  const valid = beats.compileStory(
    mkBeat([
      { actorId: "analyst", command: express("analyst", "angry", 1000, 5000) },
      { actorId: "analyst", command: glyph("analyst", "anger", 1000, 2000) },
      { actorId: "guard-1", command: beam("guard-1", "stampDesk", "vaultDoor", 10000, 1000) },
    ]),
  );
  check("valid v2 table compiles", valid.warnings.length === 0);

  // Rejecting cases.
  mustThrow("express overlap", [
    { actorId: "analyst", command: express("analyst", "angry", 1000, 3000) },
    { actorId: "analyst", command: express("analyst", "panic", 2000, 4000) },
  ]);
  mustThrow("glyph overlap", [
    { actorId: "analyst", command: glyph("analyst", "alarm", 1000, 2000) },
    { actorId: "analyst", command: glyph("analyst", "star", 2500, 1000) },
  ]);
  mustThrow("beam overlaps hold (motion exclusivity)", [
    {
      actorId: "guard-1",
      command: {
        kind: "hold",
        startMs: 9000,
        durationMs: 4000,
        waypointId: t.asWaypointId("stampDesk"),
        state: "idle",
      },
    },
    { actorId: "guard-1", command: beam("guard-1", "stampDesk", "vaultDoor", 10000, 1000) },
  ]);
  mustThrow("beam unknown waypoint", [
    { actorId: "guard-1", command: beam("guard-1", "stampDesk", "atlantis", 10000, 1000) },
  ]);
  mustThrow("beam empty duration", [
    { actorId: "guard-1", command: beam("guard-1", "stampDesk", "vaultDoor", 10000, 0) },
  ]);
  mustThrow("unknown own actorId", [
    { actorId: "analyst", command: express("ghost-9", "angry", 1000, 2000) },
  ]);

  // Seam-crossing beam is a warning, not an error.
  const seamBeam = beats.compileStory(
    mkBeat([
      { actorId: "guard-1", command: beam("guard-1", "stampDesk", "vaultDoor", 89500, 2000) },
    ]),
  );
  check("seam-crossing beam warns once", seamBeam.warnings.length === 1);

  // Glyph window seek correctness: visible at start/middle, hidden after end.
  {
    const g = beats.compileStory(
      mkBeat([{ actorId: "analyst", command: glyph("analyst", "question", 10000, 2000) }]),
    );
    const e = beats.createActorEval(asAid("analyst"));
    beats.evaluateActor(g, asAid("analyst"), 10000, e);
    check(
      `glyph at window start (${e.glyph}/${e.glyphPhase.toFixed(2)})`,
      e.glyph === "question" && e.glyphPhase === 0,
    );
    beats.evaluateActor(g, asAid("analyst"), 11000, e);
    check(
      `glyph mid-window (${e.glyph}/${e.glyphPhase.toFixed(2)})`,
      e.glyph === "question" && Math.abs(e.glyphPhase - 0.5) < 1e-9,
    );
    beats.evaluateActor(g, asAid("analyst"), 12500, e);
    check("glyph after window hidden", e.glyph === null);
    // Cold seek straight past the window leaves it hidden.
    beats.evaluateActor(g, asAid("analyst"), 13000, e);
    check("glyph cold-seek hidden", e.glyph === null);
  }

  // Beam channel: the four boundary phases + idempotent re-evaluation.
  {
    const b = beats.compileStory(
      mkBeat([
        { actorId: "guard-1", command: beam("guard-1", "stampDesk", "vaultDoor", 10000, 1000) },
      ]),
    );
    const e = beats.createActorEval(asAid("guard-1"));
    const snap = () =>
      `${e.position.x.toFixed(1)},${e.position.z.toFixed(1)}|${e.beamScale === null ? "n" : e.beamScale.toFixed(2)}|${e.hidden}`;
    beats.evaluateActor(b, asAid("guard-1"), 10000, e); // start: source, scale 1
    const startSnap = snap();
    check(
      `beam at start = source full scale (${startSnap})`,
      startSnap === "0.5,-1.2|1.00|false" || startSnap === "0.5,-1.2|1.00|false",
    );
    beats.evaluateActor(b, asAid("guard-1"), 10400, e); // cut: dest, shrunk, hidden
    const cutSnap = snap();
    check(`beam at cut = destination shrunk hidden (${cutSnap})`, cutSnap === "-5.5,0.0|0.20|true");
    beats.evaluateActor(b, asAid("guard-1"), 10700, e); // reappear: visible, pop begins
    const reSnap = snap();
    check(
      `beam at reappear = destination visible (${reSnap})`,
      reSnap.startsWith("-5.5,0.0|0.2") && reSnap.endsWith("false"),
    );
    beats.evaluateActor(b, asAid("guard-1"), 11000, e); // end: rest at dest, no override
    const endSnap = snap();
    check(`beam at end = resting at destination (${endSnap})`, endSnap === "-5.5,0.0|n|false");
    // Non-monotonic re-evaluation is idempotent.
    const again = snap();
    beats.evaluateActor(b, asAid("guard-1"), 10500, e);
    const mid = snap();
    beats.evaluateActor(b, asAid("guard-1"), 11000, e);
    check(
      "beam re-evaluation idempotent",
      snap() === endSnap && again === endSnap && mid !== endSnap,
    );
  }

  // Seam: no v2 channel may be active at 0 or 90000 in the CURRENT data.
  for (const actorId of beats.ACTOR_IDS) {
    const a = beats.createActorEval(asAid(actorId));
    const b2 = beats.createActorEval(asAid(actorId));
    beats.evaluateActor(compiled, asAid(actorId), 0, a);
    beats.evaluateActor(compiled, asAid(actorId), DURATION_MS, b2);
    check(
      `seam idle v2 channels for ${actorId}`,
      a.expression === null &&
        b2.expression === null &&
        a.glyph === null &&
        b2.glyph === null &&
        a.beamScale === null &&
        b2.beamScale === null &&
        !a.hidden &&
        !b2.hidden,
    );
  }
  console.log(`v2 channels: compile validation, glyph seek, beam boundaries, seam idle all green`);
}

/* R5 fragments: expansion, booking, borrowing, parallel cues. */
{
  await import("./fragments/types.ts");
  type Frag = import("./fragments/types.ts").Fragment;
  const mkFrag = (over: Partial<Frag> & Pick<Frag, "id" | "reservedActors">): Frag => ({
    actors: [],
    props: [],
    ...over,
  });
  const actorEntry = (actorId: string, command: unknown) => ({
    actorId: asAid(actorId),
    command: command as never,
  });
  const mustThrowFrag = (name: string, frags: readonly Frag[]): void => {
    try {
      beats.compileFragments(frags);
      check(`${name} rejected`, false);
    } catch {
      check(`${name} rejected`, true);
    }
  };

  // Parallel fragments may fire cues at the same millisecond.
  {
    const twoCues = beats.compileFragments([
      mkFrag({
        id: "a",
        reservedActors: [],
        actors: [actorEntry("analyst", beats.cue("tick", 5000))],
      }),
      mkFrag({
        id: "b",
        reservedActors: [],
        actors: [actorEntry("guard-1", beats.cue("pop", 5000))],
      }),
    ]);
    const sameMs = twoCues.story.cues.filter((cue) => cue.timeMs === 5000);
    check(`parallel cues at the same ms compile (got ${sameMs.length})`, sameMs.length === 2);
  }
  // ...but one subject cannot double-fire at the same ms.
  mustThrowFrag("same-subject duplicate cue", [
    mkFrag({
      id: "a",
      reservedActors: [],
      actors: [
        actorEntry("analyst", beats.cue("tick", 5000)),
        actorEntry("analyst", beats.cue("pop", 5000)),
      ],
    }),
  ]);

  // Zone loop: cycle 10000, phase 3000 expands to 9 correctly placed windows.
  {
    const zoned = beats.compileFragments([
      mkFrag({
        id: "z",
        zone: "greenhouse",
        cycleMs: 10000,
        phaseMs: 3000,
        reservedActors: [asAid("researcher-1")],
        actors: [actorEntry("researcher-1", beats.holdAt("deskRow", 500, 100, "work"))],
      }),
    ]);
    const track = zoned.story.actorTracks.get(asAid("researcher-1"));
    const starts = track?.starts.filter((t0) => t0 >= 0) ?? [];
    check(`zone loop expands to 9 windows (got ${starts.length})`, starts.length === 9);
    const expected = [3500, 13500, 23500, 33500, 43500, 53500, 63500, 73500, 83500];
    check(
      "zone loop windows at phase+k*cycle",
      expected.every((want, i) => starts[i] === want),
    );
  }

  // Seam-straddling relative window is dropped with a warning.
  {
    const straddling = beats.compileFragments([
      mkFrag({
        id: "z",
        zone: "watch",
        cycleMs: 10000,
        phaseMs: 3000,
        reservedActors: [asAid("ambient-6")],
        // Window fits inside the cycle, but its last expansion at
        // 3000 + 80000 + 6200 = 89200 would end at 90100 -> seam straddle.
        actors: [actorEntry("ambient-6", beats.holdAt("roofStair", 6200, 900, "idle"))],
      }),
    ]);
    const track = straddling.story.actorTracks.get(asAid("ambient-6"));
    check(
      `straddling instance dropped (kept ${track?.starts.length ?? 0} of 9)`,
      track?.starts.length === 8,
    );
    check(
      "straddle warned",
      straddling.warnings.some((w) => w.includes("straddles")),
    );
  }

  // Reserved actors cannot be double-booked; bad cycle math rejected.
  mustThrowFrag("double reservation", [
    mkFrag({
      id: "z1",
      zone: "watch",
      cycleMs: 10000,
      reservedActors: [asAid("analyst")],
      actors: [],
    }),
    mkFrag({
      id: "z2",
      zone: "mint",
      cycleMs: 10000,
      reservedActors: [asAid("analyst")],
      actors: [],
    }),
  ]);
  mustThrowFrag("cycle does not divide 90000", [
    mkFrag({ id: "z", zone: "watch", cycleMs: 7000, reservedActors: [], actors: [] }),
  ]);
  mustThrowFrag("zone fragment without cycleMs", [
    mkFrag({ id: "z", zone: "watch", reservedActors: [], actors: [] }),
  ]);

  // Interruption windows: in-window borrowing passes, out-of-window fails.
  const zone = mkFrag({
    id: "z",
    zone: "watch",
    cycleMs: 10000,
    reservedActors: [asAid("analyst")],
    interruptionWindows: [{ actorId: asAid("analyst"), fromMs: 10000, toMs: 20000 }],
    actors: [actorEntry("analyst", beats.holdAt("tickerBoard", 500, 100, "idle"))],
  });
  {
    const okBorrow = beats.compileFragments([
      zone,
      mkFrag({
        id: "c",
        reservedActors: [],
        actors: [actorEntry("analyst", beats.holdAt("tickerBoard", 15000, 500, "idle"))],
      }),
    ]);
    check("in-window borrowing compiles", okBorrow.story.beats.length === 10);
  }
  mustThrowFrag("out-of-window borrowing", [
    zone,
    mkFrag({
      id: "c",
      reservedActors: [],
      actors: [actorEntry("analyst", beats.holdAt("tickerBoard", 30000, 500, "idle"))],
    }),
  ]);

  // Facade: the canonical table is the R5 merge (zones + gags + plot).
  check(
    `canonical facade is the R5 merge (${beats.CANONICAL_FRAGMENTS.map((f) => f.id).join(",")})`,
    beats.CANONICAL_FRAGMENTS.map((f) => f.id).join(",") ===
      "zone-docks,zone-greenhouse,zone-plan,zone-gauntlet,zone-launch,zone-backoffice,gag-backoffice-capsule,zone-oilbar,gag-oilbar-pour,central-plot-v2,kernel-seam-homing,global-alarm,global-pause",
  );
  console.log(`fragments: expansion, booking, borrowing, parallel cues, R5 facade green`);
}

/* R5 MERGE invariants: variant splices, alarm interruption drops, the
   gunner/intern ruling, per-zone loop continuity, and an independent
   cross-fragment exclusivity witness over the merged table. */
{
  const w = beats.MACHINE_WINDOWS; // only to keep freeze checks above honest
  void w;
  const track = (actorId: string) => compiled.actorTracks.get(asAid(actorId));
  const startsOf = (actorId: string, kinds: readonly string[]) =>
    (track(actorId)?.commands ?? []).filter((c) => kinds.includes(c.kind)).map((c) => c.startMs);

  // Plan clipboard variant (applies at instance 4, 60000-75000): the base
  // windows in [61000,70000) are replaced by the gag's own, one for one.
  const foremanMotion = startsOf("foreman", ["hold", "moveAlong", "beam"]);
  check(
    `plan gag replaces the 61000 base hold (starts: ${foremanMotion.filter((t0) => t0 >= 60000 && t0 < 62000)})`,
    foremanMotion.filter((t0) => t0 === 61000).length === 1,
  );
  const foremanCues = (track("foreman")?.commands ?? [])
    .filter((c) => c.kind === "fireCue")
    .map((c) => c.startMs);
  check(
    `plan gag bonk cue at 63000 exactly once (${foremanCues.filter((t0) => t0 === 63000)})`,
    foremanCues.filter((t0) => t0 === 63000).length === 1,
  );
  check("plan base tick still fires on a non-gag cycle (48000)", foremanCues.includes(48000));

  // Gauntlet reject variant (instances 3 and 6): gag hold at 33400 splices
  // in, the base 35200 hold is dropped, and the rejectMark cue rides.
  const runnerAMotion = startsOf("runner-a", ["hold", "moveAlong", "beam"]);
  check("reject gag hold at 33400 present", runnerAMotion.includes(33400));
  check("reject gag drops base hold at 35200", !runnerAMotion.includes(35200));
  check(
    "reject gag also at instance 6 (63400)",
    runnerAMotion.includes(63400) && !runnerAMotion.includes(65200),
  );
  const runnerACues = (track("runner-a")?.commands ?? [])
    .filter((c) => c.kind === "fireCue")
    .map((c) => c.startMs);
  check("rejectMark cue at 32000", runnerACues.includes(32000));

  // Gauntlet queue-jump variant (instances 2, 4, 6, 8): runner-d's beam hop
  // and guard-2's replacement holds appear exactly on the even instances.
  const runnerDBeams = startsOf("runner-d", ["beam"]);
  check(
    `queue-jump beam hops at 24700/44700/64700/84700 (${runnerDBeams})`,
    [24700, 44700, 64700, 84700].every((t0) => runnerDBeams.includes(t0)) &&
      runnerDBeams.length === 4,
  );
  const guard2Motion = startsOf("guard-2", ["hold", "moveAlong", "beam"]);
  check("queue-jump guard-2 hold at 24100", guard2Motion.includes(24100));

  // ALARM interruption: the greenhouse full-cycle hold at 40000 is dropped
  // for every researcher; the alarm beams are the live motion there.
  for (const id of ["researcher-1", "researcher-4", "analyst"]) {
    check(
      `alarm drops ${id} zone hold at 40000`,
      !startsOf(id, ["hold", "moveAlong", "beam"]).includes(40000),
    );
  }
  // Ruling: gunner and intern are NOT in the alarm scramble — they keep the
  // plot's crank motion through 46000-52000 and get one glance each.
  const gunnerMotion = startsOf("gunner", ["hold", "moveAlong", "beam"]);
  check("gunner keeps the plot crank hold at 42100", gunnerMotion.includes(42100));
  const gunnerGlances = (track("gunner")?.commands ?? []).filter(
    (c) => c.kind === "pose" && c.startMs === 48000,
  );
  const internGlances = (track("intern")?.commands ?? []).filter(
    (c) => c.kind === "pose" && c.startMs === 48300,
  );
  check("gunner mid-crank glance at 48000", gunnerGlances.length === 1);
  check("intern mid-crank glance at 48300", internGlances.length === 1);
  const alarmBeamActors = new Set(
    beats.CANONICAL_FRAGMENTS.flatMap((f) =>
      f.id === "global-alarm" ? f.actors.map((a) => a.actorId) : [],
    ),
  );
  check("alarm excludes gunner", !alarmBeamActors.has(asAid("gunner")));
  check("alarm excludes intern", !alarmBeamActors.has(asAid("intern")));
  check("alarm scrambles 18 actors", alarmBeamActors.size === 18);

  // Per-zone loop continuity: each zone fragment, compiled ALONE, rests
  // every reserved actor where its cycle started (per cycle instance).
  for (const frag of beats.CANONICAL_FRAGMENTS) {
    if (frag.zone === undefined || frag.cycleMs === undefined) continue;
    const solo = beats.compileFragments([frag]);
    const phase = frag.phaseMs ?? 0;
    const cycles = DURATION_MS / frag.cycleMs;
    for (const actorId of frag.reservedActors) {
      const e = beats.createActorEval(actorId);
      for (let k = 0; k < cycles; k += 1) {
        const s = phase + k * frag.cycleMs;
        // Clamp the end sample inside the loop; the last cycle's wrap-around
        // equality is the global seam suite's job (0 vs 90000).
        const sEnd = Math.min(s + frag.cycleMs - 1, DURATION_MS - 1);
        beats.evaluateActor(solo.story, actorId, s, e);
        const startPos = { x: e.position.x, y: e.position.y, z: e.position.z };
        beats.evaluateActor(solo.story, actorId, sEnd, e);
        const d = Math.max(
          Math.abs(startPos.x - e.position.x),
          Math.abs(startPos.y - e.position.y),
          Math.abs(startPos.z - e.position.z),
        );
        check(
          `zone ${frag.zone} ${actorId} cycle ${k} rest == start (d=${d.toFixed(3)})`,
          d < 1e-3,
        );
      }
    }
  }

  // Cross-fragment exclusivity witness: in the MERGED table no actor has
  // overlapping motion / express / glyph windows and no actor fires two
  // cues at the same millisecond (compileStory enforces both; this is the
  // independent read-back).
  for (const [actorId, actorTrack] of compiled.actorTracks) {
    const groups: readonly string[][] = [["hold", "moveAlong", "beam"], ["express"], ["glyph"]];
    for (const group of groups) {
      const windows = actorTrack.commands
        .filter((c) => group.includes(c.kind))
        .map((c) => {
          const w = c as { startMs: number; endMs?: number; durationMs?: number };
          return { start: c.startMs, end: w.endMs ?? c.startMs + (w.durationMs ?? 0) };
        })
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < windows.length; i += 1) {
        check(
          `merged exclusivity ${actorId} ${group[0]} at ${windows[i].start}`,
          windows[i - 1].end <= windows[i].start,
        );
      }
    }
    const cueStarts = actorTrack.commands.filter((c) => c.kind === "fireCue").map((c) => c.startMs);
    check(`merged cue uniqueness for ${actorId}`, new Set(cueStarts).size === cueStarts.length);
  }

  console.log(
    `R5 merge: variants, alarm drops, ruling, zone continuity, exclusivity green (${compiled.beats.length} beats)`,
  );
}

/* R5 machine channels + PAUSE freeze remap. */
{
  const w = beats.MACHINE_WINDOWS;
  const m = beats.createMachineState();
  // Scanner: one pass per 10000ms; glow boosted only in the peak window.
  beats.evaluateMachines(12000, m);
  check(
    `scanner pass mid-cycle (${m.scannerSweep.toFixed(2)})`,
    Math.abs(m.scannerSweep - 0.2) < 1e-9,
  );
  check("scanner glow boosted in peak", m.scannerGlow > 1.2);
  beats.evaluateMachines(40000, m);
  check("scanner glow base outside peak", m.scannerGlow === 1);
  // Carousel: 6 steps per 30000ms; double-slam only in the burst window.
  beats.evaluateMachines(35000, m);
  check(`carousel step in burst (${m.carouselStep})`, m.carouselStep === 1);
  beats.evaluateMachines(46000, m);
  check(`carousel step outside burst (${m.carouselStep})`, m.carouselStep === 3);
  // Capsules: 2 drops per 18000ms -> 9000ms each.
  beats.evaluateMachines(4500, m);
  check(
    `capsule drop mid-slot (${m.capsuleDrop.toFixed(2)})`,
    Math.abs(m.capsuleDrop - 0.5) < 1e-9,
  );
  // Tower: idle outside 46000-52000, active inside.
  beats.evaluateMachines(40000, m);
  check("tower idle outside window", m.bellSwing === 0 && m.beaconPulse === 0);
  beats.evaluateMachines(49000, m);
  check("tower active inside window", m.bellSwing !== 0 && m.beaconPulse > 0);
  // Cable: pulse only inside 42000-56000.
  beats.evaluateMachines(60000, m);
  check("cable idle outside window", m.cablePulse === 0);
  beats.evaluateMachines(49000, m);
  check("cable pulsing inside window", m.cablePulse > 0);
  // Launch board: single flip at FIRE.
  beats.evaluateMachines(55300, m);
  check(`flip board mid-flip (${m.flipBoard.toFixed(2)})`, m.flipBoard > 0);
  beats.evaluateMachines(57000, m);
  check("flip board settled", m.flipBoard === 0);
  // Ferry: continuous bob, livelier inside 68000-82000.
  beats.evaluateMachines(3000, m);
  const calmBob = Math.abs(m.boatBob);
  beats.evaluateMachines(75000, m);
  check(
    `boat livelier during crossing (${m.boatBob.toFixed(2)})`,
    Math.abs(m.boatBob) > calmBob || Math.abs(m.boatBob) > 0.08,
  );
  // PAUSE hand: windowed phase only.
  beats.evaluateMachines(76000, m);
  check(`pause hand mid-window (${m.pauseHand.toFixed(2)})`, Math.abs(m.pauseHand - 0.5) < 1e-9);
  beats.evaluateMachines(80000, m);
  check("pause hand idle outside window", m.pauseHand === 0);

  // Freeze remap: clamp at the press, shift after; loop-phase local and
  // monotonic on the absolute clock.
  const director = await import("./director.ts");
  const wt = director.worldTime;
  check("worldTime identity before freeze", wt(74199) === 74199);
  check(
    "worldTime clamped during freeze",
    wt(75000) === w.freezeStart && wt(76399) === w.freezeStart,
  );
  check(
    "worldTime shifted after freeze",
    wt(76400) === w.freezeStart && wt(80000) === 80000 - w.freezeDur,
  );
  check(
    "worldTime monotonic across freeze",
    wt(76400) === wt(76399) && wt(76401) === w.freezeStart + 1,
  );
  check("worldTime loop-local on loop 1", wt(90000 + 1000) === 90000 + 1000);
  check("worldTime loop 1 freeze clamps to loop base", wt(90000 + 75000) === 90000 + w.freezeStart);
  console.log(`R5 machines + freeze remap green (freeze ${w.freezeStart}+${w.freezeDur}ms)`);
}

/* Report. */
if (failures.length > 0) {
  console.error(`FAIL (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS story: compile, references, attachments, seam, cues all green");
