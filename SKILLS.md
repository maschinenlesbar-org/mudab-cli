# Skills

`mudab-cli` ships **Claude Code Agent Skills** as a Claude Code plugin, so Claude can
drive the `mudab` CLI for common marine-monitoring tasks. The skills **validate** that
the `mudab` CLI is on your PATH and tell you if it is missing — they never install
anything.

| Skill | Use it when you want to… |
|---|---|
| **mudab-stations** | Find monitoring stations — measurement stations, project stations (region/institute), and HELCOM PLC river stations — and understand the station model and compartment codes. |
| **mudab-parameters** | Discover what is measured — pollutants, nutrients, and biological variables — by compartment (water/sediment/biota/biology), and resolve a substance's `PARAMETER` code. |
| **mudab-measurements** | Pull actual values — per-station measurements and HELCOM PLC river-load figures — with the paging and client-side-filtering caveats. |

They compose: **stations → measurements**, or **parameters → measurements**.

## Requirements

- The `mudab` CLI on PATH: `npm install -g @maschinenlesbar.org/mudab-cli`.
- **No API key** — the MUDAB API is open.
- **Note:** the API does **no server-side filtering or sorting** (its spec's
  `filter`/`orderby` are ignored by the live server) — filter with `jq` on `--compact`
  output. Because of that, selecting from a table means fetching all of it: `measurements`
  is the largest (~187,000 rows, ~42 MB with `--all` on 2026-09-15, under the default
  100 MiB cap), so the skills fetch it once per task rather than paging it.

## Installing the plugin

This repo is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`),
published as `mudab` in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins).
Install it inside Claude Code to enable the three skills:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install mudab@maschinenlesbar
```

The `skills/` and `.claude-plugin/` files are **not** shipped in the npm tarball — the
published package is the client/CLI only.

The data these skills surface is the providers' (BfG / UBA and the datenhaltende
Bundesländer/Institutionen), under terms that are **not** stated as open — see
[DATA_LICENSE.md](DATA_LICENSE.md). Cite the source and confirm terms before reuse.
