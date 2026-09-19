// Pure arithmetic over a ruleset definition and a stored character sheet. Shared so the server's
// check resolver, the GM prompt and the client's sheet editor all compute the same numbers.
//
// Nothing here throws. A sheet is read TOLERANTLY against the ruleset's current schema: a missing
// value takes the declared default, an unknown key is ignored, and a value that is not a finite
// number reads as its default. Definitions are assumed validated (`parseRulesetDefinition`), but a
// dangling reference still reads as 0 instead of failing a turn.

import {
  rulesetSheetEnvelopeSchema,
  type RulesetDefinition,
  type RulesetSheetBuild,
  type RulesetSheetEnvelope,
  type RulesetValueRef,
} from "../../schemas/ruleset.schema.js";

type StepTable = ReadonlyArray<readonly [number, number]>;
type Rounding = "down" | "up" | "nearest";

export function lookupStepTable(table: StepTable, input: number): number {
  let value = table[0]?.[1] ?? 0;
  for (const [threshold, entry] of table) {
    if (input < threshold) break;
    value = entry;
  }
  return value;
}

export function roundRulesetNumber(value: number, mode: Rounding): number {
  if (mode === "up") return Math.ceil(value);
  if (mode === "nearest") return Math.round(value);
  return Math.floor(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A complete, blank starting build: every ability, field and tier at its declared default. */
export function defaultRulesetSheetBuild(definition: RulesetDefinition): RulesetSheetBuild {
  const fields: RulesetSheetBuild["fields"] = {};
  for (const field of definition.sheet.fields) {
    if (field.default !== undefined) fields[field.id] = field.default;
    else if (field.type === "number") fields[field.id] = Math.min(Math.max(0, field.min), field.max);
    else if (field.type === "boolean") fields[field.id] = false;
    else if (field.type === "enum") fields[field.id] = field.values[0]!;
    else fields[field.id] = "";
  }
  return {
    abilities: Object.fromEntries(definition.sheet.abilities.map((ability) => [ability.id, ability.default])),
    skills: {},
    saves: {},
    bonuses: {},
    fields,
    lists: {},
  };
}

export function createRulesetSheetEnvelope(
  definition: RulesetDefinition,
  build: RulesetSheetBuild = defaultRulesetSheetBuild(definition),
): RulesetSheetEnvelope {
  return { v: definition.sheet.version, build };
}

/** The copy a new game takes of a starting build: the stored sheet when it reads as one, else a
 *  blank default, so every party member has a sheet from the first turn. Always a deep copy — a
 *  game edits its own sheet and nothing in a game writes back to the library. */
export function copyRulesetSheetForGame(definition: RulesetDefinition, stored: unknown): RulesetSheetEnvelope {
  const parsed = rulesetSheetEnvelopeSchema.safeParse(stored);
  if (!parsed.success) return createRulesetSheetEnvelope(definition);
  return { v: definition.sheet.version, build: structuredClone(parsed.data.build) };
}

export interface EvaluatedRulesetSheet {
  abilityScores: Record<string, number>;
  abilityMods: Record<string, number>;
  proficiencyBonus: number;
  /** Proficiency tier id per skill and per save, defaulted to the ruleset's first tier. */
  skillTiers: Record<string, string>;
  saveTiers: Record<string, string>;
  skillMods: Record<string, number>;
  saveMods: Record<string, number>;
  derived: Record<string, number>;
  /** Number fields as read (default applied), which value references resolve against. */
  numbers: Record<string, number>;
}

export function rulesetAbilityModifier(definition: RulesetDefinition, score: number): number {
  const op = definition.resolution.abilityModifier;
  if (op.op === "identity") return score;
  if (op.op === "stepTable") return lookupStepTable(op.table, score);
  return Math.floor((score - 10) / 2);
}

/** The tables one value reference reads. Handed in rather than closed over, so the same resolution
 *  serves the evaluation below — where `derived` is still filling up, top to bottom — and a caller
 *  resolving a reference against a finished sheet. */
interface RulesetValueRefTables {
  abilityScores: Record<string, number>;
  abilityMods: Record<string, number>;
  numbers: Record<string, number>;
  derived: Record<string, number>;
  skillMod: (id: string) => number;
  saveMod: (id: string) => number;
}

function resolveValueRef(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  ref: RulesetValueRef,
  tables: RulesetValueRefTables,
): number {
  if (ref.const !== undefined) return ref.const;
  if (ref.field !== undefined) return tables.numbers[ref.field] ?? 0;
  if (ref.derived !== undefined) return tables.derived[ref.derived] ?? 0;
  if (ref.abilityScore !== undefined) return tables.abilityScores[ref.abilityScore] ?? 0;
  if (ref.abilityMod !== undefined) return tables.abilityMods[ref.abilityMod] ?? 0;
  if (ref.abilityModFromField !== undefined) {
    // An unset choice reads as the field's declared default, like every other field. So does a
    // stored choice the ruleset no longer offers, which is also what the sheet editor shows.
    const field = definition.sheet.fields.find((entry) => entry.id === ref.abilityModFromField);
    const stored = build.fields?.[ref.abilityModFromField];
    const offered = typeof stored === "string" && field?.type === "enum" && field.values.includes(stored);
    const chosen = offered ? stored : field?.default;
    return typeof chosen === "string" ? (tables.abilityMods[chosen] ?? 0) : 0;
  }
  if (ref.skillMod !== undefined) return tables.skillMod(ref.skillMod);
  if (ref.saveMod !== undefined) return tables.saveMod(ref.saveMod);
  return 0;
}

/** Every number the sheet yields, computed once, top to bottom. */
export function evaluateRulesetSheet(definition: RulesetDefinition, build: RulesetSheetBuild): EvaluatedRulesetSheet {
  const { sheet, resolution } = definition;
  const abilityScores: Record<string, number> = {};
  const abilityMods: Record<string, number> = {};
  for (const ability of sheet.abilities) {
    const score = finite(build.abilities?.[ability.id]) ?? ability.default;
    abilityScores[ability.id] = score;
    abilityMods[ability.id] = rulesetAbilityModifier(definition, score);
  }

  const numbers: Record<string, number> = {};
  for (const field of sheet.fields) {
    if (field.type !== "number") continue;
    numbers[field.id] =
      finite(build.fields?.[field.id]) ?? field.default ?? Math.min(Math.max(0, field.min), field.max);
  }

  const derived: Record<string, number> = {};
  const skillMods: Record<string, number> = {};
  const saveMods: Record<string, number> = {};
  const tierById = new Map(resolution.proficiencyTiers.map((tier) => [tier.id, tier]));
  const firstTier = resolution.proficiencyTiers[0]!;

  // Validation guarantees the value feeding the proficiency bonus never reads a skill or save
  // modifier, so resolving it lazily, the first time a modifier is asked for, cannot recurse.
  let proficiencyBonus: number | null = null;
  const readProficiencyBonus = (): number => {
    if (proficiencyBonus === null) {
      proficiencyBonus = 0; // a malformed definition that does recurse reads 0 instead of overflowing
      proficiencyBonus = resolution.proficiency ? resolveRef(resolution.proficiency.bonus) : 0;
    }
    return proficiencyBonus;
  };
  const trainedModifier = (
    entry: { id: string; ability?: string },
    tiers: Record<string, string> | undefined,
  ): number => {
    const tier = tierById.get(tiers?.[entry.id] ?? "") ?? firstTier;
    const trained = roundRulesetNumber(tier.multiplier * readProficiencyBonus(), tier.round) + tier.flat;
    return (entry.ability ? (abilityMods[entry.ability] ?? 0) : 0) + trained + (finite(build.bonuses?.[entry.id]) ?? 0);
  };
  function resolveRef(ref: RulesetValueRef): number {
    return resolveValueRef(definition, build, ref, {
      abilityScores,
      abilityMods,
      numbers,
      derived,
      skillMod: (id) => {
        const skill = sheet.skills.find((entry) => entry.id === id);
        return skill ? trainedModifier(skill, build.skills) : 0;
      },
      saveMod: (id) => {
        const save = sheet.saves.find((entry) => entry.id === id);
        return save ? trainedModifier(save, build.saves) : 0;
      },
    });
  }

  for (const entry of sheet.derived) {
    if (entry.op === "sum") derived[entry.id] = entry.of.reduce((total, ref) => total + resolveRef(ref), 0);
    else if (entry.op === "stepTable") derived[entry.id] = lookupStepTable(entry.table, resolveRef(entry.from));
    else if (entry.op === "scale") {
      derived[entry.id] = roundRulesetNumber(resolveRef(entry.of) * entry.multiplier, entry.round);
    } else if (entry.op === "min") derived[entry.id] = Math.min(...entry.of.map(resolveRef));
    else derived[entry.id] = Math.max(...entry.of.map(resolveRef));
  }

  const skillTiers: Record<string, string> = {};
  const saveTiers: Record<string, string> = {};
  for (const skill of sheet.skills) {
    skillTiers[skill.id] = tierById.has(build.skills?.[skill.id] ?? "") ? build.skills[skill.id]! : firstTier.id;
    skillMods[skill.id] = trainedModifier(skill, build.skills);
  }
  for (const save of sheet.saves) {
    saveTiers[save.id] = tierById.has(build.saves?.[save.id] ?? "") ? build.saves[save.id]! : firstTier.id;
    saveMods[save.id] = trainedModifier(save, build.saves);
  }

  return {
    abilityScores,
    abilityMods,
    proficiencyBonus: readProficiencyBonus(),
    skillTiers,
    saveTiers,
    skillMods,
    saveMods,
    derived,
    numbers,
  };
}

/** One value reference resolved against a sheet, for a reader outside the evaluation — a live
 *  pool's maximum is the only one today. Takes an evaluation when the caller already has one, so
 *  resolving a party's worth of pool maximums evaluates each sheet once. */
export function resolveRulesetValueRef(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  ref: RulesetValueRef,
  evaluated: EvaluatedRulesetSheet = evaluateRulesetSheet(definition, build),
): number {
  return resolveValueRef(definition, build, ref, {
    abilityScores: evaluated.abilityScores,
    abilityMods: evaluated.abilityMods,
    numbers: evaluated.numbers,
    derived: evaluated.derived,
    skillMod: (id) => evaluated.skillMods[id] ?? 0,
    saveMod: (id) => evaluated.saveMods[id] ?? 0,
  });
}

/** Whether a field, derived value, list or pool is hidden by its `hideWhen`. */
export function isRulesetItemHidden(
  item: { hideWhen?: { field: string; equals: string | number | boolean } },
  build: RulesetSheetBuild,
  definition: RulesetDefinition,
): boolean {
  if (!item.hideWhen) return false;
  const field = definition.sheet.fields.find((entry) => entry.id === item.hideWhen!.field);
  const value = build.fields?.[item.hideWhen.field] ?? field?.default;
  return value === item.hideWhen.equals;
}

// ── Checks ──

export type RulesetCheckTarget =
  | { type: "skill"; id: string; label: string }
  | { type: "save"; id: string; label: string }
  | { type: "ability"; id: string; label: string };

function normalizeCheckName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** What a requested check name means in this ruleset: a skill, a save, or a raw ability check.
 *  Matches ids and labels, with "check", "save" and "saving throw" suffixes understood, so
 *  "Dexterity save", "dex_save" and "DEX saving throw" are one request. Null when the ruleset has
 *  no such thing; the caller then rolls unmodified dice rather than guessing an ability. */
export function matchRulesetCheckTarget(definition: RulesetDefinition, requested: string): RulesetCheckTarget | null {
  const { sheet } = definition;
  const name = normalizeCheckName(requested);
  if (!name) return null;
  const saveWord = /\s(?:saving throw|save)$/.test(name);
  const base = name.replace(/\s(?:ability check|check|saving throw|save)$/, "").trim();
  const names = (entry: { id: string; label: string; short?: string }) =>
    [
      normalizeCheckName(entry.id),
      normalizeCheckName(entry.label),
      entry.short ? normalizeCheckName(entry.short) : "",
    ].filter(Boolean);

  const save = sheet.saves.find((entry) => names(entry).includes(name));
  if (save) return { type: "save", id: save.id, label: save.label };
  if (saveWord) {
    // "<ability> save": the save that rolls with that ability, when exactly one does.
    const ability = sheet.abilities.find((entry) => names(entry).includes(base));
    const forAbility = ability ? sheet.saves.filter((entry) => entry.ability === ability.id) : [];
    if (forAbility.length === 1) return { type: "save", id: forAbility[0]!.id, label: forAbility[0]!.label };
    const byBase = sheet.saves.find((entry) => names(entry).includes(base));
    if (byBase) return { type: "save", id: byBase.id, label: byBase.label };
    return null;
  }
  const skill = sheet.skills.find((entry) => names(entry).includes(name) || names(entry).includes(base));
  if (skill) return { type: "skill", id: skill.id, label: skill.label };
  const ability = sheet.abilities.find((entry) => names(entry).includes(base));
  if (ability) return { type: "ability", id: ability.id, label: ability.label };
  return null;
}

export function rulesetCheckModifier(evaluated: EvaluatedRulesetSheet, target: RulesetCheckTarget | null): number {
  if (!target) return 0;
  if (target.type === "skill") return evaluated.skillMods[target.id] ?? 0;
  if (target.type === "save") return evaluated.saveMods[target.id] ?? 0;
  return evaluated.abilityMods[target.id] ?? 0;
}

export interface RulesetCheckRoll {
  /** Every die thrown, in order: one set normally, two sets under advantage or disadvantage. */
  rolls: number[];
  /** Sum of the set that was kept. */
  usedRoll: number;
  total: number;
  success: boolean;
  criticalSuccess: boolean;
  criticalFailure: boolean;
  rollMode: "advantage" | "disadvantage" | "normal";
  /** Notation for the dice actually thrown. */
  dice: string;
}

/** Roll a `dice-sum` check. Advantage and disadvantage cancel, and are ignored entirely when the
 *  ruleset does not allow them. `preRolled` stands in for the dice when the player rolled first;
 *  it is honoured only for a single-die ruleset and only within the die's faces. */
export function rollDiceSumCheck(
  definition: RulesetDefinition,
  input: {
    modifier: number;
    dc: number;
    isSave: boolean;
    advantage?: boolean;
    disadvantage?: boolean;
    preRolled?: number;
  },
  rollDie: (sides: number) => number,
): RulesetCheckRoll {
  const { dice, naturals, advantage: allowsAdvantage } = definition.resolution;
  const single = dice.count === 1;
  const preRolled =
    single && Number.isInteger(input.preRolled) && input.preRolled! >= 1 && input.preRolled! <= dice.sides
      ? input.preRolled!
      : null;
  const useAdvantage = preRolled === null && allowsAdvantage && !!input.advantage && !input.disadvantage;
  const useDisadvantage = preRolled === null && allowsAdvantage && !!input.disadvantage && !input.advantage;

  const rollSet = () => Array.from({ length: dice.count }, () => rollDie(dice.sides));
  const sum = (set: number[]) => set.reduce((total, value) => total + value, 0);
  const first = preRolled === null ? rollSet() : [preRolled];
  const second = useAdvantage || useDisadvantage ? rollSet() : null;
  const usedRoll = second
    ? useAdvantage
      ? Math.max(sum(first), sum(second))
      : Math.min(sum(first), sum(second))
    : sum(first);
  const rolls = second ? [...first, ...second] : first;

  const policy = input.isSave ? naturals.save : naturals.check;
  const criticalSuccess = single && usedRoll === dice.sides && (policy === "both" || policy === "max-only");
  const criticalFailure = single && usedRoll === 1 && (policy === "both" || policy === "min-only");
  const total = usedRoll + input.modifier;

  return {
    rolls,
    usedRoll,
    total,
    success: criticalSuccess ? true : criticalFailure ? false : total >= input.dc,
    criticalSuccess,
    criticalFailure,
    rollMode: useAdvantage ? "advantage" : useDisadvantage ? "disadvantage" : "normal",
    dice: `${rolls.length}d${dice.sides}`,
  };
}
