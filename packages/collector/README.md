# @moqtap/collector

Renamed to [`@moqtap/monitor-browser`](https://www.npmjs.com/package/@moqtap/monitor-browser).

This last release re-exports `@moqtap/monitor-browser` 0.12.0 under every entry
point the old name had, so existing imports keep working. Replace the package name
in your imports:

```bash
npm uninstall @moqtap/collector
npm install @moqtap/monitor-browser
```

```typescript
import { init } from '@moqtap/monitor-browser'
```

The API, the stored data and the upload format are unchanged.

## License

[FSL-1.1-MIT](./LICENSE)
