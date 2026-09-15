// Canned MUDAB response bodies for the unit suite, shaped like the live API.
// NOTE: the `stations` wrapper key is `V_STATION_SMALL` (not `STATION_SMALL`) —
// this deliberate spec/path mismatch is what the client's defensive row
// extraction has to cope with, so the tests keep it.

export const stations = {
  V_STATION_SMALL: [
    { metadataid: 32, STATNAME_ST: "TF0360", NAME_PS: "OMBMPN3", STATIONTYPE_ST: "Normal", COMPT_DS: "BL" },
    { metadataid: 32, STATNAME_ST: "TF0022", NAME_PS: "OMO22", STATIONTYPE_ST: "Normal", COMPT_DS: "BL" },
  ],
};

export const projectStations = {
  V_MUDAB_PROJECTSTATION: [
    { metadataid: 31, PROJECTSTATIONID: 374, NAME_PS: "WB1", REGION: "Nordsee", INSTITUT: "BSH" },
  ],
};

export const parameters = {
  MV_PARAMETER: [
    {
      metadataid: 33,
      COMPT_DS: "CW",
      PARAMETER: "24DP",
      PARAMETERGRUPPE: "O-GPT",
      PARAM_NAME: "Dichloroprop",
      PARGROUP: "O-GPT",
      PARAMGROUP_NAME: "Pesticides (general)",
    },
  ],
};

export const parametersWasser = {
  MV_PARAMETER_WASSER: [
    { metadataid: 33, COMPT_DS: "CW", PARAMETER: "OCTADEC", PARAM_NAME: "Octadecane" },
  ],
};

export const plcStations = {
  V_PLC_STATION: [
    {
      metadataid: 112,
      LAND_CD: "MV",
      STATION_NAME: "KÖRKWITZ",
      ST_LAT: 54.25,
      ST_LON: 12.4,
      STATION_CODE: "CDE0005",
      MON_TYPE: "MON_RIVER_LOAD",
    },
  ],
};

/** An empty (but valid) result — a filter that matched nothing. */
export const empty = { MV_PARAMETER: [] };

/** A station measurement as the live API returns it: `VALUE_MS` is a JSON number. */
export const measurements = {
  MV_STATION_MSMNT: [
    {
      metadataid: 39,
      STATNAME_ST: "OMMVZBA15",
      PARAMETERID_PM: "APSurTemp THRNFNON degC IFAG",
      STATNAME_DATE_TIME: "OMMVZBA15 20111019 0849",
      PARAMCODE_PM: "SurTemp",
      DATE_STM: "20111019",
      TIME_STM: "0849",
      VALUE_MS: 11.8,
    },
  ],
};
