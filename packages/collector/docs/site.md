---
title: "@moqtap/collector"
description: Renamed to @moqtap/monitor-browser.
version: 0.12.0
---

**`@moqtap/collector` is now [`@moqtap/monitor-browser`](/npm-packages/moqtap-monitor-browser/).**

[npm](https://www.npmjs.com/package/@moqtap/monitor-browser) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/monitor-browser)

Its last release, 0.12.0, re-exports `@moqtap/monitor-browser` 0.12.0 under every entry
point the old name had, so existing imports keep working. Replace the package name in your
imports:

```bash
npm uninstall @moqtap/collector
npm install @moqtap/monitor-browser
```

```typescript
import { init } from '@moqtap/monitor-browser'
```

The API, the stored data and the upload format are unchanged.
