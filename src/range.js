import { AxiError } from "axi-sdk-js";

/** Search Console keeps 16 months of data and nothing older. */
export const RANGES = {
  "7d": 7,
  "28d": 28,
  "90d": 90,
  "6m": 180,
  "12m": 365,
  "16m": 480,
};

// Search Console finalises data on a 2-3 day delay. Ending the window today
// would always show a fake decline in the last two rows.
export const LAG_DAYS = 2;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function shift(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return iso(date);
}

/**
 * Resolve the window. `--start`/`--end` win; otherwise a named range ending at
 * the last day Search Console is likely to have finalised.
 */
export function window(values = {}) {
  if (values.start || values.end) {
    return {
      startDate: values.start ?? shift(RANGES["28d"] + LAG_DAYS),
      endDate: values.end ?? shift(LAG_DAYS),
      label: `${values.start ?? "…"}..${values.end ?? "…"}`,
    };
  }
  const range = values.range ?? "28d";
  const days = RANGES[range];
  if (!days) {
    throw new AxiError(`unknown --range ${range}`, "VALIDATION_ERROR", [
      `valid ranges: ${Object.keys(RANGES).join(", ")}`,
      "Or pass an explicit window with --start <YYYY-MM-DD> --end <YYYY-MM-DD>",
    ]);
  }
  return { startDate: shift(days + LAG_DAYS), endDate: shift(LAG_DAYS), label: range };
}

/** The equally sized window immediately before this one, for comparisons. */
export function previous({ startDate, endDate }) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const span = Math.round((end - start) / 86_400_000);
  const previousEnd = new Date(start);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - span);
  return { startDate: iso(previousStart), endDate: iso(previousEnd) };
}

export const DATE_FLAGS = {
  range: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
};

export function dateFlagHelp() {
  return {
    "--range": `Named window (default 28d): ${Object.keys(RANGES).join(", ")}`,
    "--start": "Window start as YYYY-MM-DD (overrides --range)",
    "--end": "Window end as YYYY-MM-DD",
  };
}
