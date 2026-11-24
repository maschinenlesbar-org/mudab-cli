# mudab-mcp

An [MCP](https://modelcontextprotocol.io/) server for [MUDAB](https://www.umweltbundesamt.de/portale/meeresumweltdatenbank-mudab)
(Meeresumweltdatenbank), the German marine environment database of the North and Baltic Sea,
hosted by the Bundesanstalt für Gewässerkunde (BfG) and surfaced by the Umweltbundesamt (UBA):
monitoring stations, the parameters measured, station measurements and the HELCOM loads that
rivers carry into the Baltic, as tools for AI agents. Read-only, no API key. The data has no open
licence: every result says whose it is and how to cite it (see Licence).

It is the MCP side of [mudab-cli](https://github.com/maschinenlesbar-org/mudab-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/mudab-mcp
```

This installs the **`mudab-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/mudab-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add mudab -- mudab-mcp
# or with the image:
claude mcp add mudab -- docker run -i --rm ghcr.io/maschinenlesbar-org/mudab-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "mudab": { "command": "mudab-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "mudab": { "type": "stdio", "command": "mudab-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
mudab-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http mudab http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/mudab-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/mudab-cli/releases) instead of
`latest`: `…/mudab-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/mudab-mcp:<version> --repo maschinenlesbar-org/mudab-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findStations` | Measurement stations (by name, compartment, type, and the region and institute of their project station), project stations or HELCOM PLC stations (by river, Land, monitoring type); each station once, with every region or institute the data gives it. |
| `findParameters` | The parameters recorded (English names and codes), by group and compartment, with every compartment whose own list measures them; or the PLC parameters with their stations and values. |
| `getMeasurements` | Station measurements (weather and sea observations): a station's series per parameter and unit and its values, the stations that measured a parameter, or what the table holds. |
| `getRiverLoads` | HELCOM PLC loads into the Baltic (nitrogen, phosphorus, metals, flow) of monitored rivers, treatment plants or unmonitored areas, ranked or totalled per station, year, kind or Land. |
| `listRows` | The raw rows of any MUDAB table: a page, or the rows whose field equals a value. |

MUDAB filters nothing on the server, so each tool reads its table (in pages of at most ~7 MB)
and selects there. The station measurement table is ~42 MB: the first call that needs it takes
about 20 s, and the table is then kept in memory for 15 minutes. Stations are counted by name,
not by table row, and the measurement table's exact copies of a row (it repeats most rows) once; units are kept apart (a wave height in metres is never compared with one on a
scale); null values are dropped and counted.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://geoportal.bafg.de/mudab/rest/BaseController/FilterElements)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline.
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/LICENSING.md)).
Data: MUDAB's data comes from the coastal Länder and research institutions, hosted by the BfG
and surfaced by the UBA. It has no open licence: its metadata gives the use constraint
"otherRestrictions" with no terms, so treat it as all rights reserved. Cite it ("Datenquelle:
Meeresumweltdatenbank (MUDAB), BfG/UBA und die datenhaltenden Bundesländer/Institutionen");
redistributing, republishing or commercial use needs the data holder's permission (BfG,
geoportal@bafg.de, or the [UBA's MUDAB portal](https://www.umweltbundesamt.de/portale/meeresumweltdatenbank-mudab);
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/mudab-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field. We provide the tool, not the data:
running the server as a service for others may need the provider's permission.
