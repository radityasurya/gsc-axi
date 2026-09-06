import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.js";

const BIN = fileURLToPath(new URL("../bin/gsc-axi.js", import.meta.url));
const RUNS = 7;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(args) {
  return median(
    Array.from({ length: RUNS }, () => {
      const started = process.hrtime.bigint();
      execFileSync("node", args, { stdio: "ignore" });
      return Number(process.hrtime.bigint() - started) / 1e6;
    }),
  );
}

test("-v, -V and --version all print the bare version", () => {
  for (const flag of ["-v", "-V", "--version"]) {
    assert.equal(execFileSync("node", [BIN, flag], { encoding: "utf8" }).trim(), VERSION);
  }
});

/**
 * AXI §10: the version probe must answer before the command graph loads, and
 * the guard is measured against the interpreter floor **in this same process**
 * rather than an absolute millisecond budget that goes flaky across machines.
 * A static import of `src/cli.js` in `bin/` would push this to ~1.8x.
 */
test("--version answers before the command graph loads", () => {
  const floor = measure(["-e", "console.log(1)"]);
  const version = measure([BIN, "--version"]);
  assert.ok(
    version < floor * 1.5,
    `--version took ${version.toFixed(1)}ms against a ${floor.toFixed(1)}ms interpreter floor; the fast path is not being taken`,
  );
});
