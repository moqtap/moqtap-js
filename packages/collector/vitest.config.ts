import { defineConfig } from 'vitest/config'

/**
 * Two projects, so the one file that measures *time* never shares a core with
 * the 28 that measure behaviour.
 *
 * `non-interference.test.ts` compares latency distributions between arms that
 * run seconds apart, and its tolerances are measured on this runner. Scheduled
 * alongside everything else, those arms are measured against whatever vitest
 * happens to be running on the other cores: run alone, the two identical
 * healthy arms disagree by 0.023 ms on `arrival` p95; run inside the whole
 * suite, by 0.930 ms — 62% of the tolerance that statistic is asserted against,
 * spent on nothing but the other test files.
 *
 * `sequence.groupOrder` is the narrow instrument: groups run lowest first, so
 * `unit` finishes before `non-interference` begins and the timing file has the
 * machine to itself for its ~43 s.
 *
 * | scheduling                 |  suite | the timing file |
 * | -------------------------- | -----: | --------------- |
 * | one project, all parallel  |   47 s | contended       |
 * | two projects, `groupOrder` |   74 s | alone           |
 * | `fileParallelism: false`   |   85 s | alone           |
 *
 * The 27 s is paid by the suite, not by the other files — they keep full
 * concurrency. `fileParallelism: false` buys the same isolation for 11 s more
 * and could not have been scoped to the harness anyway: vitest lists it among
 * the options a project config may not carry, so it would be quietly ignored
 * whenever this package runs from the workspace root.
 *
 * `bundle-size.test.ts` stays in `unit`: it spawns `bun build`, the heaviest
 * thing in the package, and the point is to keep that away from the timing file.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: ['src/__tests__/harness/non-interference.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'non-interference',
          include: ['src/__tests__/harness/non-interference.test.ts'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
