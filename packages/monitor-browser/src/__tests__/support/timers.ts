/** Every timer the page sets, run by hand. */
export function manualTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++
      live.set(id, { fn, ms })
      return id
    },
    clearTimer: (h: unknown): void => {
      live.delete(h as number)
    },
    /** How many timers of `ms` are pending. */
    pending: (ms: number): number => [...live.values()].filter((t) => t.ms === ms).length,
    /** Run every pending timer once, as if the longest of them had passed. */
    runAll(): void {
      for (const [id, t] of [...live]) {
        live.delete(id)
        t.fn()
      }
    },
    /** Run every pending timer of `ms`, as if that long had passed. */
    run(ms: number): void {
      for (const [id, t] of [...live]) {
        if (t.ms !== ms) continue
        live.delete(id)
        t.fn()
      }
    },
  }
}
