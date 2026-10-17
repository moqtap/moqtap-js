/**
 * Light, dark, or whatever the system says.
 *
 * The viewer has no theme control of its own. Framed, it takes the theme of
 * the page around it, so the two never disagree: the parent puts
 * `?theme=light|dark|system` on the frame's URL for the first paint and posts
 * `{ type: 'moqtap:theme', theme }` when the choice changes (read in
 * `parents.ts`, admitted by the same gate as a trace). On its own it follows
 * the system.
 *
 * The stylesheets carry both palettes. `data-theme` on `<html>` picks one, and
 * no attribute means "follow the system", so "system" is applied by removing
 * it rather than by working out which the system prefers.
 *
 * Kept free of the DOM, like the gate, so it can be tested as functions.
 */

export type Theme = 'light' | 'dark' | 'system'

export function asTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null
}

/** The `theme` a parent put on this frame's URL, or `null` for none or nonsense. */
export function themeFromQuery(search: string): Theme | null {
  return asTheme(new URLSearchParams(search).get('theme'))
}

/** The parts of `document.documentElement` a theme touches. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyTheme(root: ThemeRoot, theme: Theme): void {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}
