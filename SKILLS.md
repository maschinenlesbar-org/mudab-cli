# Skills

`mudab-cli` ships **Claude Code Agent Skills** as a plugin marketplace, so Claude can
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
  output. The `measurements` table is hundreds of thousands of rows; page it with `--from`/`--count`
  rather than `--all`.

## Installing the plugin

This repo is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` +
`.claude-plugin/plugin.json` + `skills/`). Add it as a marketplace in Claude Code to
enable the three skills. The `skills/` and `.claude-plugin/` files are **not** shipped
in the npm tarball — the published package is the client/CLI only.

The data these skills surface is the providers' (BfG / UBA and the datenhaltende
Bundesländer/Institutionen), under terms that are **not** stated as open — see
[DATA_LICENSE.md](DATA_LICENSE.md). Cite the source and confirm terms before reuse.
