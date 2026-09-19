// The compact sheet block one party member contributes to the Game Master prompt.
//
// It is a summary, not the sheet: what the Game Master needs to narrate honestly and to write a
// sheet command that will not be refused. Everything in it is named by the ruleset — the abilities,
// what counts as trained, which fields and lists are worth showing — so a system with no abilities
// and one pool renders one short line rather than an empty 5e skeleton.
//
// Every value that comes off the sheet is user-authored text on its way into a prompt, so it is
// flattened to one line, stripped of the characters that shape a tag or a macro, and capped.

import type { RulesetDefinition, RulesetField, RulesetSheetBuild } from "../../schemas/ruleset.schema.js";
import { readRulesetLive } from "./live-state.js";
import { evaluateRulesetSheet, isRulesetItemHidden } from "./sheet-math.js";

/** How much of one sheet value reaches the prompt. */
const MAX_VALUE_LENGTH = 80;
/** How many rows of one list are named. A longer list is a spellbook, not a summary. */
const MAX_LIST_NAMES = 40;

/** Sheet values are written by players and, through the note command, by the model itself, and
 *  the block they land in is wrapped in a tag in the prompt. Brackets and braces could forge a
 *  command or a macro; angle brackets could close that tag and speak as the Engine. */
function safeValue(value: string): string {
  return (
    value
      // Control characters AND the Unicode line and paragraph separators: either kind would start a
      // new logical line inside the sheet block, and a sheet value is one line.
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
      .replace(/[{}[\]<>]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, MAX_VALUE_LENGTH)
  );
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function own(row: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return safeValue(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "";
}

function fieldText(field: RulesetField, build: RulesetSheetBuild): string {
  const stored = build.fields?.[field.id];
  const value = stored === undefined ? field.default : stored;
  if (field.type === "enum" && typeof value === "string") return safeValue(field.valueLabels?.[value] ?? value);
  return cellText(value);
}

/** One party member's sheet, as the Game Master reads it. Deterministic and pure. */
export function renderRulesetSheetBlock(
  definition: RulesetDefinition,
  card: { name: string; build: RulesetSheetBuild },
  stored: unknown,
): string {
  const { sheet, gm } = definition;
  const build = card.build;
  const evaluated = evaluateRulesetSheet(definition, build);
  const live = readRulesetLive(definition, build, stored);
  const lines: string[] = [];
  const push = (line: string) => {
    if (line) lines.push(line);
  };

  push(safeValue(card.name));

  // A score is only ever shown through the ruleset's own modifier rule, so an `identity` system
  // shows its one number and a 3d6 system shows what it adds.
  push(
    sheet.abilities
      .map((ability) => `${ability.short ?? ability.label} ${signed(evaluated.abilityMods[ability.id] ?? 0)}`)
      .join(", "),
  );

  // "Trained" is whatever the ruleset's first tier is not: the first tier is the untrained default
  // every unmentioned skill takes, so listing it would list the whole sheet.
  const firstTier = definition.resolution.proficiencyTiers[0]!.id;
  const trained = [
    ...sheet.skills
      .filter((skill) => (evaluated.skillTiers[skill.id] ?? firstTier) !== firstTier)
      .map((skill) => `${skill.label} ${signed(evaluated.skillMods[skill.id] ?? 0)}`),
    ...sheet.saves
      .filter((save) => (evaluated.saveTiers[save.id] ?? firstTier) !== firstTier)
      .map((save) => `${save.label} ${signed(evaluated.saveMods[save.id] ?? 0)}`),
  ];
  if (trained.length > 0) push(`Trained: ${trained.join(", ")}`);

  const summary: string[] = [];
  for (const id of gm.sheetSummary.fields) {
    const field = sheet.fields.find((entry) => entry.id === id);
    if (!field || isRulesetItemHidden(field, build, definition)) continue;
    const value = fieldText(field, build);
    if (value) summary.push(`${field.label} ${value}`);
  }
  for (const id of gm.sheetSummary.derived) {
    const derived = sheet.derived.find((entry) => entry.id === id);
    if (!derived || isRulesetItemHidden(derived, build, definition)) continue;
    summary.push(`${derived.label} ${evaluated.derived[id] ?? 0}`);
  }
  push(summary.join(", "));

  push(
    live.pools
      .map((pool) => `${pool.label} ${pool.value}/${pool.max}${pool.temp > 0 ? ` +${pool.temp} temp` : ""}`)
      .join(", "),
  );

  // A track at its default says nothing: three death saves at zero are the absence of a fact.
  const trackValues = new Map(live.tracks.map((track) => [track.id, track.value]));
  push(
    sheet.live.tracks
      .flatMap((track) => {
        const value = trackValues.get(track.id);
        const fallback = Math.min(Math.max(track.default ?? track.min, track.min), track.max);
        return value === undefined || value === fallback ? [] : [`${track.label} ${value}`];
      })
      .join(", "),
  );

  push(
    live.text.flatMap((entry) => (entry.value.trim() ? [`${entry.label}: ${safeValue(entry.value)}`] : [])).join(", "),
  );

  const conditions = live.conditions.flatMap((condition) => (condition.active ? [condition.label] : []));
  if (conditions.length > 0) push(`Conditions: ${conditions.join(", ")}`);

  for (const entry of gm.sheetSummary.lists) {
    const list = sheet.lists.find((candidate) => candidate.id === entry.list);
    if (!list || isRulesetItemHidden(list, build, definition)) continue;
    const rows = build.lists?.[list.id];
    if (!Array.isArray(rows)) continue;
    const groups = new Map<string, string[]>();
    let named = 0;
    for (const row of rows) {
      if (named >= MAX_LIST_NAMES) break;
      if (!row || typeof row !== "object") continue;
      if (entry.onlyWhen !== undefined) {
        const column = list.columns.find((candidate) => candidate.id === entry.onlyWhen);
        const flag = own(row as Record<string, unknown>, entry.onlyWhen);
        const on = typeof flag === "boolean" ? flag : column?.type === "boolean" && (column.default ?? false);
        if (!on) continue;
      }
      const name = cellText(own(row as Record<string, unknown>, entry.nameColumn));
      if (!name) continue;
      const group = entry.groupBy === undefined ? "" : cellText(own(row as Record<string, unknown>, entry.groupBy));
      const bucket = groups.get(group);
      if (bucket) bucket.push(name);
      else groups.set(group, [name]);
      named += 1;
    }
    if (groups.size === 0) continue;
    push(
      entry.groupBy === undefined
        ? `${list.label}: ${[...groups.values()].flat().join(", ")}`
        : `${list.label} ${[...groups].map(([group, names]) => `(${group || "-"}): ${names.join(", ")}`).join("; ")}`,
    );
  }

  return lines.join("\n");
}
