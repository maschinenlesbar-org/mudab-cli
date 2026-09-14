# mudab-cli

**Website:** [English](https://maschinenlesbar-org.github.io/mudab-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/mudab-cli/de/) — command reference, guides and API docs

A tiny, dependency-light **TypeScript client + CLI** for the **MUDAB**
(Meeresumweltdatenbank — the German marine environment database) REST API:
marine-monitoring data from the coastal Bundesländer and research institutions,
hosted by the Bundesanstalt für Gewässerkunde (BfG) and surfaced by the
Umweltbundesamt (UBA). A [bund.dev](https://bund.dev) API.

- **No API key.** The API is open — no auth, no account.
- **Zero runtime HTTP dependencies.** Built on `node:http`/`https`; the CLI's only
  runtime dependency is `commander`.
- **Library + CLI.** Use the typed `MudabClient` in code, or the `mudab` command.

> **We provide the tool, not the data.** The data is © its providers (see
> [DATA_LICENSE.md](DATA_LICENSE.md)); its terms are **not** stated as open — check
> before redistributing.

## Install

```bash
npm install -g @maschinenlesbar.org/mudab-cli   # the `mudab` command
# or as a library:
npm install @maschinenlesbar.org/mudab-cli
```

## CLI

Every command lists one dataset. Results are paged with `--from`/`--count`
(default **100** rows); `--all` fetches the whole table.

```bash
mudab stations --count 5                      # measurement stations
mudab project-stations                        # monitoring projects (region, institute)
mudab parameters --compartment wasser         # water parameters
mudab measurements --from 0 --count 200       # station measurements (page it — huge)
mudab plc-stations                            # HELCOM PLC river-load stations
mudab plc-measurements --all                  # river pollutant loads
mudab compartments                            # compartment code table (offline)
```

> **The API does no server-side filtering or sorting.** Its OpenAPI spec advertises
> `filter`/`orderby` on every endpoint, but the live server **ignores** them, so the
> CLI does not offer filter flags. Fetch a page and filter with `jq`:
>
> ```bash
> mudab parameters --all --compact | jq '[.[] | select(.COMPT_DS=="CW")]'
> ```

Global flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--compact`. See [Usage.md](Usage.md) for the full reference.

## Library

```ts
import { MudabClient } from "@maschinenlesbar.org/mudab-cli";

const mudab = new MudabClient();
const stations = await mudab.stations({ range: { from: 0, count: 10 } });
const waterParams = await mudab.parameters({ range: { from: 0, count: 50 } }, "wasser");
```

Each method returns a typed row array (the client extracts it from the API's
single-key wrapper object). Only `range` is honoured by the server — see the note in
`FilterRequest`.

## Documentation

- [Usage.md](Usage.md) — full command reference and exit codes
- [DEVELOPING.md](DEVELOPING.md) — architecture, testing, the live-API quirks
- [GLOSSARY.md](GLOSSARY.md) — MUDAB domain terms (stations, compartments, PLC)
- [DATA_LICENSE.md](DATA_LICENSE.md) — upstream data terms (distinct from the code license)
- [SKILLS.md](SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
