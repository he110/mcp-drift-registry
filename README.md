# MCP Drift Registry

A deterministic record of how public MCP servers change their tool contracts.

**→ [he110.github.io/mcp-drift-registry](https://he110.github.io/mcp-drift-registry)**

MCP servers publish a tool contract over `tools/list` and change it whenever they like.
There are no versions, no deprecation policy and no changelog feed. An agent that passed
`limit` yesterday and gets an "unknown argument" error today has no artifact to consult:
the old schema is simply gone.

This registry keeps the old schema. Every few hours it reads `tools/list` from a list of
public servers, canonicalises each schema, fingerprints it, and records the difference
against the previous snapshot.

## What it catches that a changelog cannot

**Silent drift** — the input schema moved while the human-readable description stayed
byte-identical. The tool still says it does the same thing; the arguments it accepts are
different. Nothing announces this, because from the vendor's side nothing was announced.

Severity is structural, not editorial:

| | |
|---|---|
| `breaking` | a parameter or enum value disappeared, a type changed, or a field became required |
| `additive` | something was added that existing callers can ignore |
| `cosmetic` | wording, titles, examples — no change to the wire contract |

## Reading it by machine

Everything is static, CORS-open, and needs no key or account.

```
GET /api/registry.json          all servers, tool counts, fingerprints
GET /api/events.json            the change stream, newest first
GET /api/servers/<id>.json      one server: full contract + its history
GET /events.atom                the same stream as Atom
```

## How it works

```
cron ─► tools/list ─► canonicalise ─► fingerprint ─► structural diff ─► state/ ─► site/
```

- **No model in the loop.** Classification is a function of the JSON, not a judgement call.
  A registry that hallucinates a breaking change is worse than no registry.
- **Idempotent against the last committed snapshot.** GitHub's cron is best-effort; a
  skipped run costs latency and nothing else, because the baseline lives in `state/`,
  not in the runner.
- **A heartbeat canary runs every pulse.** "Nothing drifted" and "the collector has been
  throwing since Tuesday" produce identical output, so a reference source guaranteed to
  move is checked through the same code path. If it stops moving, the page says so.
- **Zero dependencies.** Node's standard library, nothing else in `package.json`.

## Running it

```sh
node bin/pulse.js --dry-run   # collect and diff, write nothing
node bin/pulse.js             # collect, diff, write state/, build site/
node bin/pulse.js --publish-only
node --test test/
```

## Adding a server

Open an issue with the endpoint URL. The only requirement is that it answers `tools/list`
without credentials. A server that later starts demanding auth is recorded as such rather
than removed — losing anonymous access is itself a contract change.

## Scope

This publishes a record. It does not notify anyone, and nothing here should be treated as
a guarantee that a change will be detected within any particular window.

MIT.
