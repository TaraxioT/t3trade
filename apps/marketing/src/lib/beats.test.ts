/**
 * Beat-ordering invariants, run as part of `pnpm --filter @t3tools/marketing
 * build` (Node 24 executes TypeScript directly). The story only makes sense
 * if dependent beats land at or after their prerequisites: the Long status
 * cannot print before the entry fills, the stop mark cannot draw before the
 * stop is placed, and the settled P&L cannot land before the target prints.
 */
import { BEATS, beatStart, STORY, type BeatName } from "./beats.ts";

const failures: string[] = [];
const check = (claim: string, ok: boolean) => {
  if (!ok) failures.push(claim);
};

/* Structure: the table itself must be a well-formed timeline. */
{
  const names = BEATS.map((beat) => beat.name);
  check(`beat names are unique (${names.length} beats)`, new Set(names).size === names.length);
  check("all weights are positive", BEATS.every((beat) => beat.weight > 0));
  let at = 0;
  for (const beat of BEATS) at += beat.weight;
  check(`weights sum to 100 (got ${at})`, at === 100);
  for (let i = 1; i < BEATS.length; i += 1) {
    const earlier = BEATS[i - 1]!;
    const later = BEATS[i]!;
    check(
      `${later.name} starts at or after ${earlier.name} ends`,
      beatStart(later.name) >= beatStart(earlier.name),
    );
  }
}

/* Story prerequisites: dependent state before its cause is a rejected
   retime, not a valid alternative telling. */
{
  const assertAfter = (dependent: string, prerequisite: string) => {
    check(
      `${dependent} (${beatStart(dependent as BeatName)}) cannot start before ${prerequisite} (${beatStart(prerequisite as BeatName)})`,
      beatStart(dependent as BeatName) >= beatStart(prerequisite as BeatName),
    );
  };

  /* The Long status pill reads the entry beat. */
  assertAfter(STORY.statusLong, STORY.statusArmed);
  assertAfter(STORY.statusLong, "trigger-hit");
  /* The stop mark reads the stop-placed beat, which needs the fill first. */
  assertAfter(STORY.stopMark, STORY.statusLong);
  /* The run and its P&L reel need a position to count. */
  assertAfter("run", STORY.statusLong);
  /* The drawdown can only test a stop that exists. */
  assertAfter("drawdown", "wedge-open");
  assertAfter("drawdown", STORY.stopMark);
  /* The settled P&L lands at the settle beat, after the target prints. */
  assertAfter(STORY.settledPnl, STORY.targetPrints);
  assertAfter(STORY.settledPnl, "drawdown");
}

if (failures.length > 0) {
  console.error("beat timeline invariants failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`beat timeline invariants ok (${BEATS.length} beats, order holds)`);
