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

**Read the row count with its caveat first:**
[79 servers is not 79 observations](https://he110.github.io/mcp-drift-registry/notes/one-template.html)
— 65% of the tracked endpoints are one hosted template, and the whole sample resolves to
22 contract families, which is a ceiling and not a floor. Every figure on that page is
regenerated from state each pulse, and every command on it is runnable.

**Then look up the endpoint you actually call:**
[51 tenants, four contracts](https://he110.github.io/mcp-drift-registry/notes/fleet.html)
— the endpoints on that hosted template do not all serve the same `search_*` schema. One row
per endpoint, with the parameters it accepts, published as `/api/fleet.json` and printable
locally with `node bin/fleet.js`.

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
GET /api/fleet.json             the fleet census: endpoint -> schema variant
GET /events.atom                the same stream as Atom
```

Every record also carries its own provenance — the URL that actually answered, whether that
is the URL we declared, any redirect in between, and which of the two contract paths read it.
A row obtained over a path we will not vouch for is published as such rather than dropped.

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
node bin/fleet.js             # the fleet census from committed state, no network
node --test test/
```

## Adding a server

Open an issue with the endpoint URL. The only requirement is that it answers `tools/list`
without credentials. A server that later starts demanding auth is recorded as such rather
than removed — losing anonymous access is itself a contract change.

Answering once buys a place in `candidates`, not a row. A candidate is probed by every
pulse through the same collector as the registry, and is admitted only after **8
consecutive successful probes spanning at least 48 hours**. A single failure resets both
the count and the clock. At a six-hour cadence that is a little over two days.

The bar exists because the headline this registry publishes is *how many contract families
actually moved*, and one endpoint admitted on a single lucky response is enough to move it
by going down. Candidates have no snapshot, no events, no page and no place in any count
until they clear the gate; the trial itself is on the record in `state/candidates.json`.

## Scope

This publishes a record. It does not notify anyone, and nothing here should be treated as
a guarantee that a change will be detected within any particular window.

MIT.
