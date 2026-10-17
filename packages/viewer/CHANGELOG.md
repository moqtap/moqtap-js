# Changelog

## [0.2.0]

Breaking for a deployment:

- Serve all of `dist/view/`, not a fixed list of files: it adds
  `theme-boot.js`, `tokens.css`, `bundle.css`, `fonts/`, `licenses/` and
  `LICENSE-lucide-static.txt`. The release tarball and `SHA256SUMS` cover
  every file.
- The CSP must allow `font-src 'self'`; the fonts ship in the bundle.

Also:

- Light, dark and system themes, set by the parent through `?theme=` and a
  `{ type: 'moqtap:theme', theme }` message.
- Control messages as a log with a detail pane (fields, raw bytes as hex, a
  `§` spec citation), and a Streams and objects view.

## [0.1.0]

First release.
