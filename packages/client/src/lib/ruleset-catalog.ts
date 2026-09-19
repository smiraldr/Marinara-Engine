// The decidable half of the ruleset catalog picker: which filter options a catalog offers, what a
// filter starts on, what the sheet already holds, what a selection would cost each list, and the
// one-line reading of an entry's mechanics. None of it needs React, so the client-lane regression
// checks it directly.
//
// Nothing here knows a system by name: every word comes from a localization key or from the
// ruleset's own labels, and every value comes from the catalog file.
import {
  catalogRowRef,
  rowsFromCatalogEntry,
  rulesetListRowIssues,
  RULESET_CATALOG_ROW_KEY,
  type RulesetCatalogEntry,
  type RulesetCatalogFilter,
  type RulesetCatalogHeader,
  type RulesetCatalogMechanics,
  type RulesetDefinition,
  type RulesetField,
  type RulesetSheetBuild,
} from "@marinara-engine/shared";
import type { TFunction } from "i18next";

type Scalar = number | string | boolean;
export type CatalogListRow = Record<string, Scalar>;

/** What a filter's select holds while nothing is chosen. A catalog value is never empty, so this
 *  can never collide with one, even when a ruleset offers a literal "Any". */
export const CATALOG_FILTER_ANY = "";

/** How many rows the picker draws before it asks the user to narrow the search instead. A catalog
 *  may hold two thousand entries, and a list that long is neither readable nor cheap to render. */
export const CATALOG_VISIBLE_LIMIT = 200;

function compare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

/** What one entry says for one filter, as the texts the picker shows and matches: every tag of a
 *  tags value, a number as its text, a non-empty string as itself. */
export function catalogEntryFilterTexts(entry: RulesetCatalogEntry, filterId: string): string[] {
  const value = entry.filters?.[filterId];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "number") return [String(value)];
  return typeof value === "string" && value ? [value] : [];
}

/** The distinct values the loaded entries actually carry for one declared filter. Derived from the
 *  entries rather than from the header, so a filter never offers a value nothing has. */
export function catalogFilterOptions(filter: RulesetCatalogFilter, entries: readonly RulesetCatalogEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const text of catalogEntryFilterTexts(entry, filter.id)) seen.add(text);
  }
  const options = [...seen];
  // Numbers sort as numbers: a cost of 10 belongs after 9, not between 1 and 2.
  return filter.type === "number" ? options.sort((left, right) => Number(left) - Number(right)) : options.sort(compare);
}

/** The texts that could name the sheet's own value of a field. A catalog names a value the way a
 *  player reads it, so an enum's display label has to be tried beside the stored value. */
export function sheetFieldMatchTexts(field: RulesetField | undefined, stored: Scalar | undefined): string[] {
  const value = stored === undefined ? field?.default : stored;
  if (value === undefined || value === "") return [];
  const texts = [String(value)];
  if (field?.type === "enum" && typeof value === "string") {
    const shown = field.valueLabels?.[value];
    if (shown) texts.push(shown);
  }
  return texts;
}

/** The option a filter opens on: the sheet's own value when some entry carries it, "Any" otherwise.
 *  The match ignores case because a file and a sheet spell the same word differently often enough. */
export function catalogFilterStartValue(options: readonly string[], texts: readonly string[]): string {
  const wanted = texts.map((text) => text.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return CATALOG_FILTER_ANY;
  return options.find((option) => wanted.includes(option.trim().toLowerCase())) ?? CATALOG_FILTER_ANY;
}

export type CatalogFilterView = {
  filter: RulesetCatalogFilter;
  options: string[];
  /** What the picker selects when it opens. The user can always change it. */
  start: string;
};

/** Every filter worth drawing, with its options and its starting value. A filter no loaded entry
 *  carries is dropped: a select whose only choice is "Any" filters nothing. */
export function catalogFilterViews(
  catalog: Pick<RulesetCatalogHeader, "filters">,
  entries: readonly RulesetCatalogEntry[],
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
): CatalogFilterView[] {
  const views: CatalogFilterView[] = [];
  for (const filter of catalog.filters ?? []) {
    const options = catalogFilterOptions(filter, entries);
    if (options.length === 0) continue;
    const fieldId = filter.startFrom?.field;
    const field = fieldId ? definition.sheet.fields.find((entry) => entry.id === fieldId) : undefined;
    const texts = fieldId ? sheetFieldMatchTexts(field, build.fields[fieldId]) : [];
    views.push({ filter, options, start: catalogFilterStartValue(options, texts) });
  }
  return views;
}

/** Whether one entry passes one filter's current choice. An entry that carries no value for the
 *  filter is out once a value is chosen: it is not what the user asked for. */
export function catalogEntryMatchesFilter(
  entry: RulesetCatalogEntry,
  filter: RulesetCatalogFilter,
  chosen: string,
): boolean {
  if (chosen === CATALOG_FILTER_ANY) return true;
  const value = entry.filters?.[filter.id];
  if (value === undefined) return false;
  return Array.isArray(value) ? value.includes(chosen) : String(value) === chosen;
}

/** Search runs over what the picker shows: the entry's label and its one-line summary. */
export function catalogEntryMatchesSearch(entry: RulesetCatalogEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${entry.label} ${entry.summary ?? ""}`.toLowerCase().includes(needle);
}

export function filterCatalogEntries(
  entries: readonly RulesetCatalogEntry[],
  views: readonly CatalogFilterView[],
  search: string,
  chosen: Readonly<Record<string, string>>,
): RulesetCatalogEntry[] {
  return entries.filter(
    (entry) =>
      catalogEntryMatchesSearch(entry, search) &&
      views.every((view) =>
        catalogEntryMatchesFilter(entry, view.filter, chosen[view.filter.id] ?? CATALOG_FILTER_ANY),
      ),
  );
}

/** A stored sheet is read tolerantly, so a list the file holds as something other than rows reads
 *  as having none instead of throwing in the middle of the picker. */
function storedRows(lists: RulesetSheetBuild["lists"], listId: string): CatalogListRow[] {
  const rows: unknown = lists[listId];
  return Array.isArray(rows) ? (rows as CatalogListRow[]) : [];
}

/** Whether the sheet already holds a row this entry wrote, in any list the catalog feeds. Picking it
 *  again is allowed and adds another copy, so this only marks, it never blocks. */
export function catalogEntryAlreadyAdded(
  catalogId: string,
  entry: RulesetCatalogEntry,
  feeds: readonly string[],
  lists: RulesetSheetBuild["lists"],
): boolean {
  const ref = catalogRowRef(catalogId, entry.id);
  return feeds.some((listId) => storedRows(lists, listId).some((row) => row[RULESET_CATALOG_ROW_KEY] === ref));
}

export type CatalogAdditionTarget = {
  listId: string;
  label: string;
  /** Rows the list holds now. */
  current: number;
  /** Rows this selection would add. */
  adding: number;
  /** Rows the list could still take. */
  room: number;
};

export type CatalogAdditionPlan = {
  /** Only the lists that change, each with its full new rows, ready for one `commit({ lists })`. */
  lists: Record<string, CatalogListRow[]>;
  targets: CatalogAdditionTarget[];
  /** Entries left out because one of their rows does not fit the list it is meant for. */
  dropped: number;
  /** Labels of the lists this selection would push past `maxItems`. */
  full: string[];
};

/** What picking these entries would do to the sheet. The rows come from the shared
 *  `rowsFromCatalogEntry`, so the reserved mark is set exactly once and in one place, and each is
 *  checked with the shared `rulesetListRowIssues` against the list it would land in: the row editor
 *  must never be handed a value the ruleset itself would refuse. */
export function planCatalogAddition(
  definition: RulesetDefinition,
  catalogId: string,
  selected: readonly RulesetCatalogEntry[],
  lists: RulesetSheetBuild["lists"],
  /** Lists `hideWhen` hides on THIS sheet. They do not exist for this character, so a row meant for
   *  one is not written where nobody could see or remove it. */
  skipLists: ReadonlySet<string> = new Set(),
): CatalogAdditionPlan {
  const listById = new Map(definition.sheet.lists.map((list) => [list.id, list]));
  const next: Record<string, CatalogListRow[]> = {};
  let dropped = 0;

  for (const entry of selected) {
    // Built and declared rows run in step: `rowsFromCatalogEntry` maps one to one over `entry.rows`,
    // and the declared values are what the list's columns are checked against. An entry is added
    // whole or not at all: a knack without the limited-use row that belongs to it is half a knack.
    const all = rowsFromCatalogEntry(catalogId, entry);
    const fits = all.every((row, index) => {
      if (skipLists.has(row.list)) return true;
      const list = listById.get(row.list);
      const values = entry.rows[index]?.values;
      return Boolean(list && values && rulesetListRowIssues(list, values).length === 0);
    });
    const built = all.filter((row) => !skipLists.has(row.list));
    // An entry whose every row belongs to a hidden list would add nothing, which is left out too.
    if (!fits || built.length === 0) {
      dropped += 1;
      continue;
    }
    for (const row of built) {
      const rows = next[row.list] ?? [...storedRows(lists, row.list)];
      rows.push(row.row);
      next[row.list] = rows;
    }
  }

  const targets: CatalogAdditionTarget[] = [];
  const full: string[] = [];
  // The sheet's own list order, so the footer reads the way the editor does.
  for (const list of definition.sheet.lists) {
    const rows = next[list.id];
    if (!rows) continue;
    const current = storedRows(lists, list.id).length;
    const target = {
      listId: list.id,
      label: list.label,
      current,
      adding: rows.length - current,
      room: Math.max(0, list.maxItems - current),
    };
    targets.push(target);
    if (target.adding > target.room) full.push(list.label);
  }
  return { lists: next, targets, dropped, full };
}

// ── The mechanics line ──

const KIND_KEYS: Readonly<Record<RulesetCatalogMechanics["kind"], string>> = Object.freeze({
  attack: "game.ruleset.catalog.kind.attack",
  heal: "game.ruleset.catalog.kind.heal",
  buff: "game.ruleset.catalog.kind.buff",
  debuff: "game.ruleset.catalog.kind.debuff",
  utility: "game.ruleset.catalog.kind.utility",
});

const SHAPE_KEYS: Readonly<Record<"burst" | "cone" | "line", string>> = Object.freeze({
  burst: "game.ruleset.catalog.shape.burst",
  cone: "game.ruleset.catalog.shape.cone",
  line: "game.ruleset.catalog.shape.line",
});

const TARGET_KEYS: Readonly<Record<"self" | "ally" | "enemy" | "any", string>> = Object.freeze({
  self: "game.ruleset.catalog.targets.self",
  ally: "game.ruleset.catalog.targets.ally",
  enemy: "game.ruleset.catalog.targets.enemy",
  any: "game.ruleset.catalog.targets.any",
});

const SAVE_KEYS: Readonly<Record<"none" | "half" | "negates", string>> = Object.freeze({
  none: "game.ruleset.catalog.mechanics.saveNone",
  half: "game.ruleset.catalog.mechanics.saveHalf",
  negates: "game.ruleset.catalog.mechanics.saveNegates",
});

export type CatalogMechanicsLabels = {
  /** What a range or an area size is measured in, from the catalog header. */
  units: RulesetCatalogHeader["units"];
  /** Save id to the name the ruleset gives it. */
  saves: Readonly<Record<string, string>>;
  /** Live pool id, or pool group id, to the name the sheet shows. */
  pools: Readonly<Record<string, string>>;
};

/** The ruleset's own names for everything a mechanics block can point at. A pool group has no label
 *  of its own, so it reads as its id, exactly as the in-game sheet heads its group with. */
export function catalogMechanicsLabels(
  definition: RulesetDefinition,
  catalog: Pick<RulesetCatalogHeader, "units">,
): CatalogMechanicsLabels {
  const saves: Record<string, string> = {};
  for (const save of definition.sheet.saves) saves[save.id] = save.label;
  const pools: Record<string, string> = {};
  for (const pool of definition.sheet.live.pools) {
    pools[pool.id] = pool.label;
    if (pool.group && !(pool.group in pools)) pools[pool.group] = pool.group;
  }
  return { units: catalog.units, saves, pools };
}

/** Dice and a flat adjustment read as one die expression (`1d8+3`), which every system writes the
 *  same way, so there is nothing here to translate. */
function formatAmount(amount: { dice?: string; flat?: number } | undefined): string {
  if (!amount) return "";
  const { dice, flat } = amount;
  if (dice && flat !== undefined && flat !== 0) return `${dice}${flat > 0 ? "+" : "-"}${Math.abs(flat)}`;
  if (dice) return dice;
  return flat === undefined ? "" : String(flat);
}

/** One compact line saying what an entry does. Every word is a localization key or a label the
 *  ruleset itself wrote; the Engine does not act on any of it yet. */
export function formatCatalogMechanics(
  mechanics: RulesetCatalogMechanics,
  labels: CatalogMechanicsLabels,
  t: TFunction,
): string {
  const distance = (value: number) => {
    const unit = labels.units?.distance?.label;
    return unit ? t("game.ruleset.catalog.mechanics.distance", { value, unit }) : String(value);
  };
  const parts: string[] = [t(KIND_KEYS[mechanics.kind])];

  if (mechanics.range !== undefined) {
    parts.push(
      mechanics.range === 0
        ? t("game.ruleset.catalog.mechanics.selfOrTouch")
        : t("game.ruleset.catalog.mechanics.range", { distance: distance(mechanics.range) }),
    );
  }
  if (mechanics.area) {
    parts.push(
      t("game.ruleset.catalog.mechanics.area", {
        shape: t(SHAPE_KEYS[mechanics.area.shape]),
        distance: distance(mechanics.area.size),
      }),
    );
  }
  if (mechanics.targets) parts.push(t(TARGET_KEYS[mechanics.targets]));
  if (mechanics.friendlyFire) parts.push(t("game.ruleset.catalog.mechanics.friendlyFire"));
  if (mechanics.attackRoll) parts.push(t("game.ruleset.catalog.mechanics.attackRoll"));

  const amount = formatAmount(mechanics.amount);
  if (amount) {
    parts.push(
      mechanics.damageType
        ? t("game.ruleset.catalog.mechanics.amountOfType", { amount, type: mechanics.damageType })
        : amount,
    );
  }
  const perStep = formatAmount(mechanics.perCostStep);
  if (perStep) parts.push(t("game.ruleset.catalog.mechanics.perStep", { amount: perStep }));

  if (mechanics.save) {
    const save = labels.saves[mechanics.save.save] ?? mechanics.save.save;
    parts.push(t(SAVE_KEYS[mechanics.save.onSuccess], { save }));
  }
  for (const cost of mechanics.cost ?? []) {
    parts.push(
      t("game.ruleset.catalog.mechanics.cost", { count: cost.amount, pool: labels.pools[cost.pool] ?? cost.pool }),
    );
  }
  if (mechanics.concentration) parts.push(t("game.ruleset.catalog.mechanics.concentration"));
  if (mechanics.reaction) parts.push(t("game.ruleset.catalog.mechanics.reaction"));
  return parts.join(" · ");
}
