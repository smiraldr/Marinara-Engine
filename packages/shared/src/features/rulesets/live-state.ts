// Live state of a ruleset character sheet: the part of a sheet that changes during play, on top of
// the static build the sheet editor writes.
//
// It is stored SPARSE and read TOLERANTLY. Only a value somebody changed is stored; everything else
// reads as its declared default, so a pool that starts full follows its maximum when a level-up
// raises it, and junk in the stored blob costs that one entry rather than the whole sheet. Writes
// normalise the other way: a value back at its default drops out of the store again, so it starts
// following the maximum once more.
//
// Nothing here is system-specific. Every pool, track, text field, condition and rest comes from the
// definition, so a 2d6 game whose only pool is an empty-start "stress" track works exactly as well
// as a d20 game with spell slots.

import { z } from "zod";
import type { RulesetDefinition, RulesetSheetBuild } from "../../schemas/ruleset.schema.js";
import { evaluateRulesetSheet, isRulesetItemHidden, resolveRulesetValueRef, roundRulesetNumber } from "./sheet-math.js";

export interface RulesetLivePoolValue {
  value: number;
  temp?: number;
}

export interface RulesetLiveState {
  pools?: Record<string, RulesetLivePoolValue>;
  tracks?: Record<string, number>;
  text?: Record<string, string>;
  conditions?: string[];
}

/** Live state of every card in one game, keyed by normalizeCharacterLookupName(card name). */
export type RulesetLiveStates = Record<string, RulesetLiveState>;

/** A stored live blob is refused above this many serialized bytes, like a stored sheet is. */
export const RULESET_LIVE_MAX_BYTES = 64 * 1024;

/** Bounds for the PATCH boundary. They are deliberately far above any ruleset the format allows
 *  (60 declared pools plus a list's rows), so only a hostile or corrupt blob meets them. */
const MAX_LIVE_CHARACTERS = 64;
const MAX_LIVE_POOLS = 600;
const MAX_LIVE_KEY_LENGTH = 200;
const MAX_LIVE_TRACKS = 30;
const MAX_LIVE_TEXTS = 12;
const MAX_LIVE_TEXT_LENGTH = 500;
const MAX_LIVE_CONDITIONS = 80;
const MAX_LIVE_CONDITION_LENGTH = 80;
/** Every stored number is an integer in this range, so no arithmetic here can reach an unsafe one. */
const MAX_LIVE_NUMBER = 1_000_000;
/** What one command may move at once. A bigger number is a typo or a model inventing damage. */
const MAX_OP_AMOUNT = 100_000;

const liveNumber = z.number().int().min(-MAX_LIVE_NUMBER).max(MAX_LIVE_NUMBER);

export const rulesetLivePoolValueSchema = z.object({ value: liveNumber, temp: liveNumber.min(0).optional() }).strict();

function boundedRecord<T extends z.ZodTypeAny>(values: T, maxEntries: number, what: string) {
  return z.record(values).superRefine((record, ctx) => {
    const keys = Object.keys(record);
    if (keys.length > maxEntries) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${maxEntries} ${what} can be stored` });
    }
    for (const key of keys) {
      if (key.length > MAX_LIVE_KEY_LENGTH) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Key is too long" });
      }
    }
  });
}

/** One character's live state. Unknown top-level keys are stripped rather than refused: a newer
 *  Engine's key must not make the whole game's state unwritable on an older one. */
export const rulesetLiveStateSchema = z
  .object({
    pools: boundedRecord(rulesetLivePoolValueSchema, MAX_LIVE_POOLS, "pools").optional(),
    tracks: boundedRecord(liveNumber, MAX_LIVE_TRACKS, "tracks").optional(),
    text: boundedRecord(z.string().max(MAX_LIVE_TEXT_LENGTH), MAX_LIVE_TEXTS, "text fields").optional(),
    conditions: z.array(z.string().max(MAX_LIVE_CONDITION_LENGTH)).max(MAX_LIVE_CONDITIONS).optional(),
  })
  .strip();

function liveStateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The whole game's live state, as a PATCH route receives it. */
export const rulesetLiveStatesSchema = boundedRecord(
  rulesetLiveStateSchema,
  MAX_LIVE_CHARACTERS,
  "characters",
).superRefine((states, ctx) => {
  // Measured on what would be STORED, so the strip above cannot be worked around with padding.
  const bytes = liveStateBytes(states);
  if (bytes > RULESET_LIVE_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Live sheet state is ${bytes} bytes, over the ${RULESET_LIVE_MAX_BYTES}-byte limit`,
    });
  }
});

// ── What a sheet's live pools are ──

export interface RulesetLivePoolSpec {
  key: string;
  label: string;
  max: number;
  allowTemp: boolean;
  group?: string;
  start: "full" | "empty";
  recharge?: string;
  listId?: string;
}

/** A sheet id can never contain ":", so a list row's pool key can never collide with a declared one. */
const LIST_POOL_SEPARATOR = ":";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Every pool this sheet currently has: the declared ones a `hideWhen` does not hide and whose
 *  maximum is above zero, then one pool per row of every list that declares `pools`. A row is keyed
 *  by its name, so renaming a row starts its pool over — that is the format's own rule. */
export function listRulesetLivePools(definition: RulesetDefinition, build: RulesetSheetBuild): RulesetLivePoolSpec[] {
  const evaluated = evaluateRulesetSheet(definition, build);
  const pools: RulesetLivePoolSpec[] = [];
  const seen = new Set<string>();

  for (const pool of definition.sheet.live.pools) {
    if (isRulesetItemHidden(pool, build, definition)) continue;
    const max = Math.min(MAX_LIVE_NUMBER, Math.floor(resolveRulesetValueRef(definition, build, pool.max, evaluated)));
    // A pool with no maximum is not a resource the character has; a caster's 9th-level slots at 0
    // must read as "you have no such thing", never as "you have none left".
    if (!(max > 0)) continue;
    seen.add(pool.id);
    pools.push({
      key: pool.id,
      label: pool.label,
      max,
      allowTemp: pool.allowTemp,
      start: pool.start,
      ...(pool.group ? { group: pool.group } : {}),
    });
  }

  for (const list of definition.sheet.lists) {
    // A hidden list is not on the sheet, so neither are its rows' pools.
    if (!list.pools || isRulesetItemHidden(list, build, definition)) continue;
    const rows = build.lists?.[list.id];
    if (!Array.isArray(rows)) continue;
    const { nameColumn, maxColumn, rechargeColumn } = list.pools;
    for (const row of rows) {
      if (pools.length >= MAX_LIVE_POOLS) break;
      if (!row || typeof row !== "object") continue;
      const rawName = own(row as Record<string, unknown>, nameColumn);
      const name = typeof rawName === "string" ? rawName.trim() : "";
      const rawMax = own(row as Record<string, unknown>, maxColumn);
      const max = typeof rawMax === "number" && Number.isFinite(rawMax) ? Math.floor(rawMax) : 0;
      if (!name || !(max > 0)) continue;
      const key = `${list.id}${LIST_POOL_SEPARATOR}${name.toLowerCase()}`;
      // Two rows under one name are one pool; the first row wins, as the key already decided.
      if (seen.has(key)) continue;
      seen.add(key);
      const recharge = rechargeColumn ? own(row as Record<string, unknown>, rechargeColumn) : undefined;
      pools.push({
        key,
        label: name,
        max: Math.min(MAX_LIVE_NUMBER, max),
        allowTemp: false,
        start: "full",
        listId: list.id,
        ...(typeof recharge === "string" && recharge ? { recharge } : {}),
      });
    }
  }
  return pools;
}

// ── Reading stored state ──

export interface ResolvedRulesetLive {
  pools: Array<RulesetLivePoolSpec & { value: number; temp: number }>;
  tracks: Array<{ id: string; label: string; min: number; max: number; value: number }>;
  text: Array<{ id: string; label: string; maxLength: number; value: string }>;
  conditions: Array<{ id: string; label: string; active: boolean }>;
}

function keepValid<T>(value: unknown, schema: z.ZodType<T>, maxEntries: number): Record<string, T> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entries.length >= maxEntries || key.length > MAX_LIVE_KEY_LENGTH) continue;
    const parsed = schema.safeParse(entry);
    if (parsed.success) entries.push([key, parsed.data]);
  }
  // `Object.fromEntries` defines each key, so a stored `__proto__` stays an ordinary key instead of
  // becoming the copy's prototype.
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Everything usable in a stored blob, as a fresh object: every key that still validates on its
 *  own, whether or not the definition still declares it. A pool the sheet hides today may be back
 *  tomorrow, and dropping its value here would silently refill it. */
function readStoredLiveState(stored: unknown): RulesetLiveState {
  const source =
    stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const state: RulesetLiveState = {};
  const pools = keepValid(source.pools, rulesetLivePoolValueSchema, MAX_LIVE_POOLS);
  if (pools) state.pools = pools;
  const tracks = keepValid(source.tracks, liveNumber, MAX_LIVE_TRACKS);
  if (tracks) state.tracks = tracks;
  const text = keepValid(source.text, z.string().max(MAX_LIVE_TEXT_LENGTH), MAX_LIVE_TEXTS);
  if (text) state.text = text;
  if (Array.isArray(source.conditions)) {
    const conditions = [
      ...new Set(
        source.conditions.filter(
          (entry): entry is string => typeof entry === "string" && entry.length <= MAX_LIVE_CONDITION_LENGTH,
        ),
      ),
    ].slice(0, MAX_LIVE_CONDITIONS);
    if (conditions.length > 0) state.conditions = conditions;
  }
  return state;
}

/** Drop what is back at its default, so the stored blob stays sparse and an empty one is absent. */
function normalizeLiveState(state: RulesetLiveState): RulesetLiveState {
  const normalized: RulesetLiveState = {};
  if (state.pools && Object.keys(state.pools).length > 0) normalized.pools = state.pools;
  if (state.tracks && Object.keys(state.tracks).length > 0) normalized.tracks = state.tracks;
  if (state.text && Object.keys(state.text).length > 0) normalized.text = state.text;
  if (state.conditions && state.conditions.length > 0) normalized.conditions = state.conditions;
  return normalized;
}

function resolveLive(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  state: RulesetLiveState,
): ResolvedRulesetLive {
  const active = new Set(state.conditions ?? []);
  return {
    pools: listRulesetLivePools(definition, build).map((spec) => {
      const entry = own(state.pools, spec.key);
      const fallback = spec.start === "full" ? spec.max : 0;
      return {
        ...spec,
        value: clamp(entry?.value ?? fallback, 0, spec.max),
        // A pool that carries no buffer can never show one, however the blob got written.
        temp: spec.allowTemp ? Math.max(0, entry?.temp ?? 0) : 0,
      };
    }),
    tracks: definition.sheet.live.tracks.map((track) => {
      const fallback = clamp(track.default ?? track.min, track.min, track.max);
      return {
        id: track.id,
        label: track.label,
        min: track.min,
        max: track.max,
        value: clamp(own(state.tracks, track.id) ?? fallback, track.min, track.max),
      };
    }),
    text: definition.sheet.live.text.map((entry) => ({
      id: entry.id,
      label: entry.label,
      maxLength: entry.maxLength,
      value: (own(state.text, entry.id) ?? "").slice(0, entry.maxLength),
    })),
    // A condition the definition no longer declares is not shown; its id stays stored in case it
    // comes back, exactly like a hidden pool's value.
    conditions: definition.sheet.live.conditions.map((condition) => ({
      id: condition.id,
      label: condition.label,
      active: active.has(condition.id),
    })),
  };
}

/** The sheet's live state as it reads right now. Never throws: junk reads as defaults. */
export function readRulesetLive(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  stored: unknown,
): ResolvedRulesetLive {
  return resolveLive(definition, build, readStoredLiveState(stored));
}

// ── Commands ──

export type RulesetSheetOp =
  | { op: "spend"; pool: string; amount: number }
  | { op: "restore"; pool: string; amount: number }
  | { op: "damage"; pool: string; amount: number }
  | { op: "temp"; pool: string; amount: number }
  | { op: "track"; track: string; to?: number; by?: number }
  | { op: "condition"; condition: string; active: boolean }
  | { op: "note"; field: string; value: string }
  | { op: "rest"; rest: string };

export type RulesetSheetRefusal =
  | "unknown-pool"
  | "ambiguous-pool"
  | "insufficient"
  | "bad-amount"
  | "no-temp"
  | "unknown-track"
  | "unknown-condition"
  | "unknown-field"
  | "unknown-rest"
  | "malformed";

export type RulesetSheetOpResult =
  | { ok: true; live: RulesetLiveState; now: string }
  | { ok: false; reason: RulesetSheetRefusal };

/** The op names a tag may spell. `heal` is an alias the tag layer folds into `restore`. */
export const RULESET_SHEET_OP_NAMES = Object.freeze([
  "spend",
  "restore",
  "damage",
  "temp",
  "track",
  "condition",
  "note",
  "rest",
] as const);

/** How long a `now` summary may get before the tag layer would cut it anyway. */
const MAX_NOW_LENGTH = 120;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

type PoolMatch = { pool: ResolvedRulesetLive["pools"][number] } | { refusal: "unknown-pool" | "ambiguous-pool" };

/** What a written pool name means: its key, then a declared pool's id or label, then a list row's
 *  name on its own — which is how a Game Master writes "Ki" without knowing the list it lives in. */
function findPool(pools: ResolvedRulesetLive["pools"], requested: string): PoolMatch {
  const wanted = requested.trim();
  if (!wanted) return { refusal: "unknown-pool" };
  const exact = pools.find((pool) => pool.key === wanted);
  if (exact) return { pool: exact };
  const declared = pools.find((pool) => !pool.listId && (sameName(pool.key, wanted) || sameName(pool.label, wanted)));
  if (declared) return { pool: declared };
  const rows = pools.filter((pool) => pool.listId && (sameName(pool.key, wanted) || sameName(pool.label, wanted)));
  if (rows.length === 1) return { pool: rows[0]! };
  return { refusal: rows.length > 1 ? "ambiguous-pool" : "unknown-pool" };
}

function poolNow(pool: { max: number }, value: number, temp: number): string {
  return `${value}/${pool.max}${temp > 0 ? ` +${temp} temp` : ""}`;
}

function isAmount(amount: number, allowZero = false): boolean {
  return Number.isInteger(amount) && amount >= (allowZero ? 0 : 1) && amount <= MAX_OP_AMOUNT;
}

/** Apply one command to one character's live state. Pure: the input blob is never touched, and the
 *  result is a new sparse state. A refusal changes nothing, which is what lets the Game Master's
 *  fiction be corrected rather than silently accepted. */
export function applyRulesetSheetOp(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  stored: unknown,
  op: RulesetSheetOp,
): RulesetSheetOpResult {
  const next = readStoredLiveState(stored);
  const resolved = resolveLive(definition, build, next);

  const setPool = (spec: RulesetLivePoolSpec, value: number, temp: number): void => {
    const pools = next.pools ?? {};
    // Back at its default, with no buffer, the entry goes away again: that is what lets an
    // untouched pool follow its maximum when a level-up raises it.
    if (value === (spec.start === "full" ? spec.max : 0) && temp === 0) delete pools[spec.key];
    else pools[spec.key] = temp > 0 ? { value, temp } : { value };
    next.pools = pools;
  };
  const setTrack = (track: ResolvedRulesetLive["tracks"][number], value: number): void => {
    const tracks = next.tracks ?? {};
    if (value === clamp(definitionTrackDefault(definition, track.id) ?? track.min, track.min, track.max)) {
      delete tracks[track.id];
    } else tracks[track.id] = value;
    next.tracks = tracks;
  };
  const setText = (id: string, value: string): void => {
    const text = next.text ?? {};
    if (value) text[id] = value;
    else delete text[id];
    next.text = text;
  };
  const done = (now: string): RulesetSheetOpResult => ({
    ok: true,
    live: normalizeLiveState(next),
    now: now.slice(0, MAX_NOW_LENGTH),
  });

  if (op.op === "spend" || op.op === "restore" || op.op === "damage" || op.op === "temp") {
    const match = findPool(resolved.pools, op.pool);
    if ("refusal" in match) return { ok: false, reason: match.refusal };
    const pool = match.pool;
    if (!isAmount(op.amount, op.op === "temp")) return { ok: false, reason: "bad-amount" };

    if (op.op === "temp") {
      if (!pool.allowTemp) return { ok: false, reason: "no-temp" };
      const temp = Math.min(op.amount, MAX_LIVE_NUMBER);
      setPool(pool, pool.value, temp);
      return done(poolNow(pool, pool.value, temp));
    }
    if (op.op === "spend") {
      // Refused rather than floored: "you are out" is a fact the narration has to hear.
      if (pool.value < op.amount) return { ok: false, reason: "insufficient" };
      const value = pool.value - op.amount;
      setPool(pool, value, pool.temp);
      return done(poolNow(pool, value, pool.temp));
    }
    if (op.op === "restore") {
      const value = Math.min(pool.max, pool.value + op.amount);
      setPool(pool, value, pool.temp);
      return done(poolNow(pool, value, pool.temp));
    }
    // Damage drains the temporary buffer first and then the pool, and is never refused for being
    // bigger than what is left: a killing blow is still a killing blow.
    const fromTemp = Math.min(pool.temp, op.amount);
    const temp = pool.temp - fromTemp;
    const value = Math.max(0, pool.value - (op.amount - fromTemp));
    setPool(pool, value, temp);
    return done(poolNow(pool, value, temp));
  }

  if (op.op === "track") {
    const track = resolved.tracks.find((entry) => sameName(entry.id, op.track) || sameName(entry.label, op.track));
    if (!track) return { ok: false, reason: "unknown-track" };
    if ((op.to === undefined) === (op.by === undefined)) return { ok: false, reason: "malformed" };
    const moved = op.to ?? track.value + op.by!;
    if (!Number.isInteger(op.to ?? op.by) || Math.abs(op.to ?? op.by!) > MAX_LIVE_NUMBER) {
      return { ok: false, reason: "bad-amount" };
    }
    const value = clamp(moved, track.min, track.max);
    setTrack(track, value);
    return done(`${track.label} ${value}`);
  }

  if (op.op === "condition") {
    const condition = resolved.conditions.find(
      (entry) => sameName(entry.id, op.condition) || sameName(entry.label, op.condition),
    );
    if (!condition) return { ok: false, reason: "unknown-condition" };
    const active = new Set(next.conditions ?? []);
    if (op.active) active.add(condition.id);
    else active.delete(condition.id);
    next.conditions = [...active].slice(0, MAX_LIVE_CONDITIONS);
    return done(`${condition.label} ${op.active ? "on" : "off"}`);
  }

  if (op.op === "note") {
    const field = resolved.text.find((entry) => sameName(entry.id, op.field) || sameName(entry.label, op.field));
    if (!field) return { ok: false, reason: "unknown-field" };
    const value = typeof op.value === "string" ? op.value.slice(0, field.maxLength) : "";
    setText(field.id, value);
    return done(value ? `${field.label}: ${value}` : `${field.label} cleared`);
  }

  const rest = definition.rests.find((entry) => sameName(entry.id, op.rest) || sameName(entry.label, op.rest));
  if (!rest) return { ok: false, reason: "unknown-rest" };

  // A rest does exactly what the definition says and nothing else — no implied healing, and no
  // temporary buffers dropped, because no ruleset asked for that here.
  const values = new Map(resolved.pools.map((pool) => [pool.key, { pool, value: pool.value, temp: pool.temp }]));
  const trackValues = new Map(resolved.tracks.map((track) => [track.id, { track, value: track.value }]));
  const changes: string[] = [];

  for (const step of rest.restore) {
    const moved = (current: number, max: number, min: number): number => {
      if (step.to !== undefined) return step.to === "max" ? max : step.to === "min" ? min : step.to;
      const by = step.by!;
      if ("const" in by) return current + by.const;
      return current + Math.max(by.min, roundRulesetNumber(max * by.fractionOfMax, by.round));
    };
    if (step.track !== undefined) {
      const entry = trackValues.get(step.track);
      if (!entry) continue;
      const value = clamp(moved(entry.value, entry.track.max, entry.track.min), entry.track.min, entry.track.max);
      if (value !== entry.value) changes.push(`${entry.track.label} ${value}`);
      entry.value = value;
      setTrack(entry.track, value);
      continue;
    }
    const targets = [...values.values()].filter(({ pool }) => {
      if (step.pool !== undefined) return pool.key === step.pool;
      if (step.poolGroup !== undefined) return pool.group === step.poolGroup;
      if (step.listPools === undefined) return false;
      if (pool.listId !== step.listPools) return false;
      return !step.recharge || (pool.recharge !== undefined && step.recharge.includes(pool.recharge));
    });
    for (const target of targets) {
      const value = clamp(moved(target.value, target.pool.max, 0), 0, target.pool.max);
      if (value !== target.value) changes.push(`${target.pool.label} ${value}/${target.pool.max}`);
      target.value = value;
      setPool(target.pool, value, target.temp);
    }
  }
  for (const id of rest.clear.text) setText(id, "");
  if (rest.clear.conditions === "all") next.conditions = [];
  else if (rest.clear.conditions.length > 0) {
    const cleared = new Set<string>(rest.clear.conditions);
    next.conditions = (next.conditions ?? []).filter((id) => !cleared.has(id));
  }

  return done(changes.length > 0 ? `${rest.label}: ${changes.join(", ")}` : rest.label);
}

function definitionTrackDefault(definition: RulesetDefinition, id: string): number | undefined {
  return definition.sheet.live.tracks.find((track) => track.id === id)?.default;
}
