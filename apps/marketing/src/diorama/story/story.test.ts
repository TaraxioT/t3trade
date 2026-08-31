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

/* Cues: each fires exactly once per loop under 50ms forward stepping (the
   same window logic the director's collectCrossings uses). */
{
  const STEP = 50;
  const fired = new Map<number, number>();
  for (let t = 0; t < DURATION_MS; t += STEP) {
    for (const cue of compiled.cues) {
      if (cue.timeMs >= t && cue.timeMs < t + STEP) {
        fired.set(cue.timeMs, (fired.get(cue.timeMs) ?? 0) + 1);
      }
    }
  }
  check(
    `every cue fired once (${fired.size}/${compiled.cues.length})`,
    fired.size === compiled.cues.length,
  );
  for (const [at, count] of fired) {
    check(`cue at ${at} fired exactly once (${count})`, count === 1);
  }
  const ids = compiled.cues.map((cue) => cue.cueId).join(" ");
  console.log(`cues: ${compiled.cues.length} fired exactly once [${ids}]`);
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
  // The authored clack at 87800 crossing the same seam relative to loop 1/2.
  check(
    `clack at 87800 fires in-loop (87790-87810)`,
    label(cuesAt(87790, 87810)) === "87800:clack",
  );
  check(
    `clack at 87800 fires on loop 2 (177790-177810)`,
    label(cuesAt(177790, 177810)) === "87800:clack",
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
    for (const [key, count] of perCue)
      check(`cue ${key} fired ${loops}x (${count})`, count === loops);
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

/* Report. */
if (failures.length > 0) {
  console.error(`FAIL (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS story: compile, references, attachments, seam, cues all green");
