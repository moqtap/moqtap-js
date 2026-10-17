/**
 * The theme from the frame's URL, applied before the page first paints.
 *
 * A separate, classic (blocking) script in `<head>` rather than a line in
 * `main.js`: a module script runs only after the document is parsed, and a
 * dark parent framing a viewer that paints light first shows a white flash.
 */

import { applyTheme, themeFromQuery } from './theme'

const theme = themeFromQuery(location.search)
if (theme !== null) applyTheme(document.documentElement, theme)
