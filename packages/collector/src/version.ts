/**
 * The package version, in a leaf module of its own.
 *
 * It lives here rather than in `api/session.ts` because the dormant path
 * (`api/dormant.ts` → `transport/presence.ts`) needs it at module-eval time,
 * and importing it from `session.ts` would pull the entire live session into a
 * graph whose whole point is to be small until `init()` is called.
 */
export const COLLECTOR_VERSION = '0.1.0'
