# @moqtap/inspect

Make decoded MoQT (Media over QUIC Transport) control messages readable:
setup versions as `draft-NN`, byte strings as text where they are printable,
large integers in full, the implementation each end names, and track aliases
joined to the namespace and name the control plane gave them. Works on the
messages `@moqtap/codec` decodes, for drafts 07-22.

## Install

```bash
npm install @moqtap/inspect
```

## Usage

```typescript
import {
  displayFields,
  setupImplementation,
  type TrackFields,
  TrackRegistry,
  trackDisplayName,
} from '@moqtap/inspect'

displayFields('client_setup', msg)
// { supported_versions: [{ $shown: 'version', text: 'draft-14', raw: '0xff00000e' }], ... }

setupImplementation('client_setup', msg)
// { side: 'client', implementation: 'moxygen 0.4' }

const tracks = new Map<string, TrackFields>()
const registry = new TrackRegistry(tracks, (fields) => ({ ...fields }))
registry.apply('subscribe_ok', msg, { direction: 'rx' })
const track = registry.byAlias('3')
if (track) trackDisplayName(track) // 'live/ch4 / video/1080p'
```

## API

| Export                                 | What it does                                                    |
| -------------------------------------- | --------------------------------------------------------------- |
| `displayFields(name, fields)`          | A message's fields made readable, setup versions as drafts      |
| `displayValue(value)`                  | One value made readable                                         |
| `displayBytes(bytes)`                  | Text when printable ASCII, otherwise a hex preview              |
| `setupImplementation(name, fields)`    | The `moqt_implementation` a setup message names, and which end  |
| `setupVersionLabel(version)`           | `0xff00000e` as `draft-14`                                      |
| `draftOfProtocol(protocol)`            | The draft a negotiated protocol (`moqt-16`) or label names      |
| `TrackRegistry`                        | Joins track aliases to namespace and name from control messages |
| `trackDisplayName(track)`              | `namespace / name` for a registered track                       |

A value that needs both a shown form and the recorded one is a `Displayed`
record (`{ $shown, text, raw }`), so the result survives `postMessage` and
`JSON.stringify`.

`TrackRegistry.apply(name, fields, context)` takes the message name in either
case and follows each draft's join: the alias in SUBSCRIBE (drafts 07-11), in
SUBSCRIBE_OK or PUBLISH (12+), and the request stream where responses carry no
request id (17+).

## License

MIT
