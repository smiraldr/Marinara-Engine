// Whose sheet is whose, when a battle starts and when it ends.
//
// The arithmetic belongs to the shared combat bridge: it seeds a combatant from a sheet, turns
// catalog-marked rows into the Engine's own combat skills, and works out what a fight has to write
// back. This file only decides which party combatant reads which card, folds the results into the
// party the battle starts with, and merges every member's outcome into the one live object a game
// stores. None of it needs React, so the client-lane regression drives it directly.
//
// A game with no ruleset, or one whose ruleset has no `battle` block, never reaches any of it: the
// party handed in is the party handed back, combatant references included.
import {
  applyCombatResultToLive,
  combatSkillsFromSheet,
  normalizeCharacterLookupName,
  rulesetSheetEnvelopeSchema,
  seedCombatantFromSheet,
  sheetOpsFromCombatResult,
  type Combatant,
  type CombatSkill,
  type CombatSummary,
  type RulesetCatalogEntriesById,
  type RulesetCombatSeed,
  type RulesetDefinition,
  type RulesetLiveStates,
  type RulesetSheetBuild,
  type RulesetSheetOp,
  type RulesetSheetRefusal,
} from "@marinara-engine/shared";

/** What each seeded member started a battle with, keyed the way live state is keyed. */
export type RulesetCombatSeeds = Record<string, RulesetCombatSeed>;

export interface RulesetBattleParty {
  /** The party the battle starts with, or the very array handed in when nothing was seeded. */
  party: Combatant[];
  seeds: RulesetCombatSeeds;
}

export interface RulesetBattleWriteBack {
  /** The whole `rulesetLive` object to store, or null when no member's sheet moved. */
  live: RulesetLiveStates | null;
  /** The members whose sheet the battle changed, in the order the summary lists them. */
  updated: string[];
  refused: Array<{ name: string; op: RulesetSheetOp; reason: RulesetSheetRefusal }>;
}

/** Every game card that holds a sheet this version can read, keyed the way live state is keyed. A
 *  card with no sheet, or one holding a sheet this version cannot read, is absent: a battle has
 *  nothing to read from it and nothing to write back to it, so its combatant is left alone. */
function rulesetSheetBuildsByName(cards: unknown, playerName?: string | null): Map<string, RulesetSheetBuild> {
  const player = typeof playerName === "string" ? playerName.trim() : "";
  const builds = new Map<string, RulesetSheetBuild>();
  for (const card of Array.isArray(cards) ? (cards as Array<Record<string, unknown>>) : []) {
    const name = typeof card?.name === "string" ? card.name.trim() : "";
    const key = name ? normalizeCharacterLookupName(name) : "";
    if (!key) continue;
    const envelope = rulesetSheetEnvelopeSchema.safeParse(card.rulesetSheet);
    if (!envelope.success) continue;
    // Setup keeps ONE sheet per normalized name and lets the persona's win a name it shares with a
    // party member, because the persona is the player. The same order holds here.
    if (builds.has(key) && name !== player) continue;
    builds.set(key, envelope.data.build);
  }
  return builds;
}

/** The catalogs a battle has to fetch: the ones feeding a list `battle.skills` names. A ruleset
 *  that builds no skills from its sheet asks for nothing at all. */
export function rulesetBattleCatalogIds(definition: RulesetDefinition): string[] {
  const lists = new Set((definition.battle?.skills ?? []).map((source) => source.list));
  if (lists.size === 0) return [];
  return (definition.catalogs ?? [])
    .filter((catalog) => catalog.feeds.some((list) => lists.has(list)))
    .map((catalog) => catalog.id);
}

/** Hit points, energy and slots come from the sheet; everything else on the combatant is the
 *  Engine's and stays, `maxHp` included: the sheet sets only what share of that maximum the fight
 *  starts on. The sheet's skills are ADDED to the ones the card already generated, so a battle never
 *  loses an ability it used to offer. */
function combatantFromSheet(combatant: Combatant, seed: RulesetCombatSeed, skills: CombatSkill[]): Combatant {
  const next: Combatant = { ...combatant, hp: seed.hp };
  if (seed.mp !== undefined) next.mp = seed.mp;
  if (seed.maxMp !== undefined) next.maxMp = seed.maxMp;
  if (seed.spellSlots) next.spellSlots = seed.spellSlots;
  const known = new Set((next.skills ?? []).map((skill) => skill.id));
  const added = skills.filter((skill) => !known.has(skill.id));
  if (added.length > 0) next.skills = [...(next.skills ?? []), ...added];
  return next;
}

/**
 * The party a bridged battle starts with, and what each seeded member started from. A member with
 * no readable sheet, an enemy, and every member of a game whose ruleset has no `battle` block are
 * returned exactly as they came in.
 */
export function seedRulesetBattleParty(
  definition: RulesetDefinition,
  cards: unknown,
  live: RulesetLiveStates | null | undefined,
  catalogs: RulesetCatalogEntriesById,
  party: Combatant[],
  playerName?: string | null,
): RulesetBattleParty {
  const seeds: RulesetCombatSeeds = {};
  if (!definition.battle) return { party, seeds };
  const builds = rulesetSheetBuildsByName(cards, playerName);
  if (builds.size === 0) return { party, seeds };

  let seeded = false;
  const next = party.map((combatant) => {
    // Only the party the player fields is on a ruleset; an enemy has no sheet to read.
    if (combatant.side !== "player") return combatant;
    const key = normalizeCharacterLookupName(combatant.name);
    const build = builds.get(key);
    if (!build) return combatant;
    // The Engine's own maximum is what the sheet's share is measured against, so the fight is
    // fought on the numbers the damage arithmetic was built for.
    const seed = seedCombatantFromSheet(definition, build, live?.[key], combatant.maxHp);
    if (!seed) return combatant;
    seeds[key] = seed;
    seeded = true;
    return combatantFromSheet(combatant, seed, combatSkillsFromSheet(definition, build, catalogs));
  });
  return { party: seeded ? next : party, seeds };
}

/**
 * What the sheets look like once the battle is over: one live object for the whole game, built by
 * running each member's own deltas through the same `applyRulesetSheetOp` the player's sheet
 * buttons go through. A member the battle never seeded is left alone, and so is a member whose
 * numbers did not move.
 */
export function applyRulesetBattleResult(
  definition: RulesetDefinition,
  cards: unknown,
  live: RulesetLiveStates | null | undefined,
  /** What this battle's members started from, or null when this session never seeded the battle (it
   *  was restored after a reload) and what the sheets hold now is what the fight began with. */
  seeds: RulesetCombatSeeds | null,
  party: CombatSummary["party"],
  playerName?: string | null,
): RulesetBattleWriteBack {
  const result: RulesetBattleWriteBack = { live: null, updated: [], refused: [] };
  if (!definition.battle) return result;
  const builds = rulesetSheetBuildsByName(cards, playerName);

  let merged: RulesetLiveStates | null = null;
  for (const member of party) {
    const key = normalizeCharacterLookupName(member.name);
    const build = builds.get(key);
    if (!build) continue;
    const current = merged?.[key] ?? live?.[key];
    // Nothing else moves a pool while a battle is on screen, so a fight this session did not seed
    // started from exactly what the sheet holds now, at the share of the maximum the summary still
    // reports for it. A fight it DID seed is measured against the seed, which is what keeps a sheet
    // edited mid-battle from being counted twice, and keeps a member the battle never seeded out of
    // the write-back entirely.
    const before = seeds ? seeds[key] : seedCombatantFromSheet(definition, build, current, member.maxHp);
    if (!before) continue;
    const ops = sheetOpsFromCombatResult(definition, before, {
      hp: member.hp,
      mp: member.mp,
      spellSlots: member.spellSlots,
    });
    if (ops.length === 0) continue;

    const written = applyCombatResultToLive(definition, build, current, ops);
    for (const refusal of written.refused) result.refused.push({ name: member.name, ...refusal });
    if (!written.live) continue;
    merged = { ...(merged ?? live ?? {}) };
    // The same normalisation the in-game sheet applies: a character back at their defaults drops
    // out of the store instead of keeping an empty entry forever.
    if (Object.keys(written.live).length > 0) merged[key] = written.live;
    else delete merged[key];
    result.updated.push(member.name);
  }
  result.live = merged;
  return result;
}
