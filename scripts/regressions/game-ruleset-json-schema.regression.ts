/**
 * The published JSON Schema for ruleset authors (`docs/extending/ruleset.schema.json`) is generated
 * from the shared zod schema. This pins that the committed file is current, so an editor never
 * flags a key the Engine accepts or misses one it refuses. Needs the shared package built, which
 * `pnpm regression:node` does first.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../generate-ruleset-schema.mjs", import.meta.url));
const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
assert.equal(
  result.status,
  0,
  `${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}\nRun: pnpm ruleset:schema`,
);

console.info("game ruleset JSON Schema regression passed.");
