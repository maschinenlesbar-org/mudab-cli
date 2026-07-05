// Command group for the MUDAB CLI: one list command per endpoint (stations,
// parameters, measurements, and the HELCOM PLC set), plus an offline
// `compartments` code table. Every list command shares the range/filter/orderby
// options and returns the endpoint's row array as JSON.

import { Option, type Command } from "commander";
import type { CliDeps } from "../io.js";
import type { MudabClient, ParameterCompartment } from "../../client/client.js";
import type { FilterRequest } from "../../client/types.js";
import { action, addListOptions, buildFilterRequest, renderJson } from "../shared.js";
import type { ListOptions } from "../shared.js";

type ListFn = (client: MudabClient, req: FilterRequest) => Promise<unknown>;

const LIST_COMMANDS: { name: string; desc: string; run: ListFn }[] = [
  { name: "stations", desc: "List measurement stations (STATION_SMALL)", run: (c, r) => c.stations(r) },
  {
    name: "project-stations",
    desc: "List project stations (PROJECTSTATION_SMALL)",
    run: (c, r) => c.projectStations(r),
  },
  {
    name: "measurements",
    desc: "List individual station measurements (MV_STATION_MSMNT) — a very large table",
    run: (c, r) => c.measurements(r),
  },
  {
    name: "plc-stations",
    desc: "List HELCOM PLC stations (V_PLC_STATION)",
    run: (c, r) => c.plcStations(r),
  },
  {
    name: "plc-parameters",
    desc: "List parameters measured at PLC stations (V_GEMESSENE_PARA_PLC)",
    run: (c, r) => c.plcParameters(r),
  },
  {
    name: "plc-measurements",
    desc: "List measured values at PLC stations (V_MESSWERTE_PLC)",
    run: (c, r) => c.plcMeasurements(r),
  },
];

const PARAMETER_COMPARTMENTS: ParameterCompartment[] = ["biologie", "biota", "wasser", "sediment"];

/**
 * The compartment (COMPT_DS) code table, verified live. NOTE: this is NOT
 * exhaustive — the API also returns codes outside the documented set (e.g. `MM`).
 */
const COMPARTMENTS = [
  { code: "CW", label: "Wasser (water)", parameterCompartment: "wasser" },
  { code: "CS", label: "Sediment", parameterCompartment: "sediment" },
  { code: "CF", label: "Biota", parameterCompartment: "biota" },
  { code: "BL", label: "Biologie (biology)", parameterCompartment: "biologie" },
];

export function registerCommands(program: Command, deps: CliDeps): void {
  for (const sub of LIST_COMMANDS) {
    const cmd = program.command(sub.name).description(sub.desc);
    addListOptions(cmd).action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await sub.run(client, buildFilterRequest(opts as ListOptions)));
      }),
    );
  }

  // `parameters` also offers the compartment-specific endpoints via --compartment.
  const params = program
    .command("parameters")
    .description("List measured parameters (MV_PARAMETER)")
    .addOption(
      new Option("--compartment <c>", "restrict to a compartment's parameter endpoint").choices(
        PARAMETER_COMPARTMENTS,
      ),
    );
  addListOptions(params).action(
    action(deps, async ({ client, global, opts }) => {
      const compartment = opts["compartment"] as ParameterCompartment | undefined;
      const req = buildFilterRequest(opts as ListOptions);
      renderJson(deps, global, await client.parameters(req, compartment));
    }),
  );

  program
    .command("compartments")
    .description("Print the compartment (COMPT_DS) code table — works offline, no request")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, COMPARTMENTS);
      }),
    );
}
