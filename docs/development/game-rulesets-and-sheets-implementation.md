# Game Mode rulesets and ruleset character sheets: implementation handoff

Status: in progress. Written September 18, 2026 against `staging` at `459f8b85` (v2.4.6). Slice 1 (the shared schema, the pin, the registry and Capability API 1.20) slice 2 (the `dice-sum` resolver, `who=`, and the Game Master reminder swap) slice 3 (sheets on cards and personas) slice 4 (the Rules choice, the pin at creation, copy-at-setup and setup sharing) slice 5 (the in-game sheet, live state and the `[sheet:]` command) slice 7a (the community lanes) slice 8a (the catalog format, its route and Capability API 1.21) and the combat bridge (the `battle` block, the shared helpers and Capability API 1.22) are implemented; every later slice is still a proposal. § Format decisions records where the implemented format differs from the first draft and why. It complements `game-combat-rulesets-implementation.md` (the combat handoff). Where the two differ, § Relationship to the combat handoff says so and asks for sign-off rather than quietly overriding it.

Companion file: [`ruleset-5e-2014.example.json`](ruleset-5e-2014.example.json), the first ruleset definition, the precise statement of what "the whole sheet" means, and the file the slice 1 regression validates. The authority for the format is the zod schema in `packages/shared/src/schemas/ruleset.schema.ts`.

## Why

Feature request from the author of [Marinara-RPG-Extension](https://github.com/Kenhito/Marinara-RPG-Extension), which ships sixteen tabletop systems as an overlay: Game Mode checks are locked to d20 plus Engine modifiers, the sheet is six attributes, and running another system today takes four or five per-turn agents per ruleset. They would rather run natively. Their `docs/ENGINE-CONSTRAINTS.md` is a useful requirements list; their overlay architecture is not the target.

First-party scope is **5e, pinned to SRD 5.1 (`5e-2014`)**. V20 and other systems are left to community authors through the same data format (slice 7), which is why the format must not be 5e-shaped.

## Product contract

1. A ruleset is chosen when a game is created and pinned for that game's lifetime. It is independent of Experience, combat presentation, participation and controller.
2. No ruleset pinned means `engine-legacy`: today's behaviour, byte for byte, including prompts.
3. **A ruleset never adds a model call.** Checks ride the existing dice flows. Sheet changes ride tags in the GM's own narration. Prompt context is string assembly from the sheet and the ruleset data. No ruleset uses `api.registerTool`, and none ships a per-turn agent.
4. The Engine owns rolls, modifiers, resource arithmetic and legality. The GM chooses what to check and how hard, and narrates the real result.
5. A sheet on a character card or persona is that character's **starting build** for that ruleset. A game takes a copy. Nothing in a game writes back to the library.
6. A ruleset declares its coverage and the UI shows it before the game starts. Until the combat handoff's adapter exists for a ruleset, its battles run on `engine-legacy` combat and the UI says so in plain words.

## Verified current behaviour

Read from source, not inferred from docs.

| Fact                                                                                                                                                                                                                                                                                                                                            | Where                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Checks are d20 + skill modifier + attribute modifier against a DC; natural 20 and 1 auto-resolve; skills map to attributes through a hardcoded table that falls back to INT                                                                                                                                                                     | `services/game/skill-check.service.ts`                                                                                     |
| Only the player's card is ever read for modifiers, found by persona name with a first-card fallback                                                                                                                                                                                                                                             | `skill-check-resolution.service.ts` `findPlayerCharacterCard`                                                              |
| `[skill_check:]` accepts `dice=` and `resolution="successes" threshold=`, but those paths take no sheet input and are "never audited and never rewritten"                                                                                                                                                                                       | same file; `docs/game/dice-and-skill-checks.md`                                                                            |
| At setup, party cards' `extensions.rpgStats` and the persona's `personaStats.rpgStats` are copied into `chat.metadata.gameCharacterCards[].rpgStats` with HP reset to max                                                                                                                                                                       | `routes/game.routes.ts` `loadSetupRpgContext`, `applyGameSetupPayload`                                                     |
| Edit Sheet saves to that chat-metadata copy. No write-back to the library card was found in `game.routes.ts`                                                                                                                                                                                                                                    | `GameSurface.tsx` `handleSaveCharacterSheet`                                                                               |
| `playerStats` (player only: skills, attributes, inventory) lives in the per-message game-state snapshot and follows swipes. `playerStats.attributes` is never seeded                                                                                                                                                                            | `types/game-state.ts`; comment in `skill-check-resolution.service.ts`                                                      |
| No GM tag changes sheet values. The reminder says stats and party HP "remain in their own canonical systems"                                                                                                                                                                                                                                    | `services/game/gm-prompts.ts`                                                                                              |
| Combat spell slots exist (`spellSlots`, `slotLevel`) but are supplied by encounter generation "ONLY when established"                                                                                                                                                                                                                           | `routes/encounter.routes.ts`, `combat-director.service.ts`                                                                 |
| All of combat has one model call site: the boss picks a `candidateId` from an Engine-enumerated menu                                                                                                                                                                                                                                            | `combat-boss.service.ts`                                                                                                   |
| Client slots are `conversation-surface`, `conversation-toolbar`, `chat-settings`, `spatial-workspace`, `chat-runtime`, `game-world-map`, `home-browser-tab`, `game-surface`, `roleplay-tracker`, `tracker-panel`. None reaches the character or persona editor                                                                                  | `schemas/capability-package.schema.ts`                                                                                     |
| Character `extensions` and persona stats schemas are `.passthrough()`; both importers spread `extensions` wholesale                                                                                                                                                                                                                             | `character.schema.ts`, `persona.schema.ts`, `persona-normalization.ts`, `marinara.importer.ts`, `st-character.importer.ts` |
| A community lane for declarative content already exists: a GitHub repository with one top-level `agents.json`, fetched as an archive from `github.com` or `codeload.github.com`, size-capped, previewed as a change list, digest-tracked for updates, and gated by **Allow custom Agent imports**. Single-file and folder import share the gate | `services/agents/custom-agent-repositories.service.ts`; `docs/agents/custom-agents.md` § Importing and exporting           |
| `gm-verbs.json` is the precedent for a reserved-filename declarative asset the Engine reads, validates and acts on with no package code                                                                                                                                                                                                         | `optional-agent-packages.md` § 1.16; `capability-gm-verb-runtime.service.ts`                                               |

## Relationship to the combat handoff

The combat handoff says: "Start with a closed registry of built-in, pure TypeScript adapters. Do not add a scripting language or arbitrary executable rules packages."

Proposed reading. Slice 1 is built on it, and the issue asks the maintainer to sign off on it and on the widened `RulesetRef`:

- The **closed registry** is the set of _resolution kinds_ and _derivation ops_, in Engine TypeScript. Adding a kind is an Engine PR with regressions.
- A **ruleset definition** is validated data that parameterises a kind and declares a sheet. It contains no expression strings, is never evaluated, and brings no package code.
- **Combat adapters stay Engine TypeScript**, keyed by the same ruleset id, exactly as the combat handoff describes. Data cannot sensibly express declaration order, action economy or reaction windows, and this document does not try.
- Both documents share one `RulesetRef`. This document pins it on the game; the combat handoff snapshots it onto each encounter.

This keeps the base distribution free of optional rules content, consistent with the agent-package objective, without opening an executable lane.

**The combat bridge and this boundary.** The bridge (§ What the combat bridge settled) sits underneath that reading rather than beside it. It adds no resolution: it moves numbers across the seam between the sheet and the Engine's existing combat model, in both directions, for a ruleset that opts in with a `battle` block. It applies no attack roll, no saving throw and no concentration, and it changes no damage arithmetic, so it makes no claim to implement any system's combat. It is generic, so it serves a community 2d6 system on the day it lands and not only 5e. It is also explicitly superseded per ruleset: the day a real combat adapter for a ruleset exists, that adapter owns the fight and the bridge steps aside for it. The PR asks the maintainer to sign this off, because the boundary it comes closest to is the combat handoff's, not this document's.

## Format decisions

The format must serve rulesets nobody has written yet, many of which will be drafted by an AI agent reading the 5e file as its example. Anything the 5e file happened to need became a named, general primitive, so an author never concludes that a thing "can only be done the 5e way".

- **No id is special.** The Engine never looks for `level`, `dex`, `slots` or `hp`. The proficiency bonus is whatever value `resolution.proficiency.bonus` references; it may be omitted, and tiers then use a `flat` bonus. Level tables are an ordinary `stepTable` derived value reading an ordinary field.
- **The dice are a parameter** of `dice-sum` (`{ count, sides }`), and natural results are refused unless the ruleset rolls a single die.
- **Ability modifiers are a closed op**: `floorHalfMinusTen`, `identity` (the score is the modifier) or a `stepTable`.
- **Saves are a list like skills**, not "one per ability", so a three-save system is expressible. Skills and saves may omit their ability.
- **Every skill and save may carry a free numeric bonus** on the sheet (`bonuses`), which covers rank-based systems and item bonuses without a new primitive.
- **Passive scores are not an op.** They are `sum` over `{ "const": 10 }` and `{ "skillMod": "perception" }`.
- **A list whose rows are resources declares `pools`** (name, maximum and optional recharge columns), and a rest restores them with `listPools` filtered by `recharge`. Nothing knows the word "counters".
- **Rest amounts are closed shapes**: `to` (`"max"`, `"min"` or a number) or `by` (a constant, or a fraction of the maximum with rounding and a floor). 5e's "half your hit dice, at least one" is `{ "fractionOfMax": 0.5, "round": "down", "min": 1 }`.
- **Pools may start empty** (`start: "empty"`) for stress, corruption and similar rising tracks.
- **`gm.sheetSummary`** names which fields, derived values and lists the compact prompt block shows, so the Engine does not hardcode "AC, passive Perception, prepared spells".
- **`$comment` is allowed on any object** and `$schema` at the root; both are dropped before validation. Everything else is strict: a ruleset the Engine only partly understands would silently change a game's arithmetic, so an unknown key refuses the whole file, and the refusal lists `path: message` lines an author can act on.
- **A section is declared before an item names it**, so every group in the editor has a label.
- **Derived values read only values declared above them**, which makes a cycle unrepresentable. The value that feeds the proficiency bonus, and everything above it, may not read a skill or save modifier.
- **Every label and guidance string follows the gm-verbs prompt hygiene**: one line, no control characters, no square brackets, no macro braces.
- **A package declares kind `ruleset`**, needs no permission and no entrypoint, and must declare Capability API 1.20 when it lists `ruleset.json`.

## What slice 2 settled

- **The resolver sits behind the existing context.** `SkillCheckModifierContext` gains an optional `ruleset`. Every caller already goes through `resolveSkillCheckWithContext`, so the endpoint, generation post-processing, one-request dice and the sighted pool all reach the ruleset without new call sites.
- **Finished-looking tags are audited against the sheet.** Under `engine-legacy` a complete tag with tidy arithmetic is accepted as it stands: no context is loaded for it, it is not audited against any sheet, and it is not rolled again. In a ruleset game the generate route passes a `rulesetPinned` hint, the context is loaded for those tags too, and a modifier, die count or natural result the ruleset would not have produced sends the tag back to be rolled. The hint exists so a legacy game still never loads the context for a finished tag.
- **A pin the install cannot honour fails closed.** Loading the context throws, and the tag driver's existing failure path saves the checks sparse, still owing a roll.
- **`who=` rides the result.** `SkillCheckResult.who` is set only by the ruleset resolver, and the serializer writes it, so legacy records keep their bytes.
- **A stranger rolls unmodified dice.** A `who=` that matches no party card, or that two cards share, gets no modifier at all, because a ruleset's defaults are not neutral in every system. A party member (or the player) without a sheet rolls on the ruleset's blank default build, which is what setup copies for them. A skill name the ruleset does not know adds nothing either. Nothing falls back to a guessed ability. The player's own card keeps a name it shares with a party member.
- **The injected d20 and a player's pre-rolled d20 are honoured only where a single d20 is what the ruleset rolls.** Other dice come from the Engine's fair die.
- **The endpoint's difficulty cap stays at 40** (marked `ponytail:`); generation post-processing honours a wider ladder.
- **The sheet block and the sheet command are slice 5**, with live state. Slice 2 swaps only the check lines of the reminder, and drops the line that teaches other dice notations, because a ruleset game has one rules system.

## What slice 3 settled

- **The storage boundary is bounded, never shape-checked.** `rulesetSheets` is declared on the character extensions and persona stats schemas as a record whose keys must be ruleset ids and whose values must be objects of at most 64 KB, at most 32 of them. The sheet's shape is not validated there, because the ruleset may not be installed. An update that breaks a bound is refused with a message.
- **Importers cap, they do not refuse.** `capImportedRulesetSheets` drops only a sheet the boundary would refuse, so one bad sheet never costs an import the card. It runs in the native character importer, the SillyTavern importer, and inside `normalizePersonaStats`, which is also the persona read path.
- **The editor is one generic component** (`RulesetSheetEditor`) rendered from the definition, mounted by `RulesetSheetsSection` in both **Stats** tabs. Installed rulesets come from `GET /api/capability-packages/rulesets`, keyed under the capability package query keys so an install or removal refreshes it.
- **Values are clamped when edited, never when read**, and a stored proficiency tier the ruleset no longer offers still shows as what it is.
- **Nothing is called dormant until the installed list has loaded**, so a slow request never shows a live sheet as missing.

## What slice 4 settled

- **The server builds the pin.** The wizard sends a `ruleset` in `GameSetupConfig`, but only its `id` is trusted: `POST /game/create` rebuilds the `RulesetRef` from its own registry and writes it to both `gameSetupConfig.ruleset` and `chat.metadata.gameRuleset`. A ruleset that is not installed is refused with `ruleset_not_installed`, never swapped for other rules.
- **A game with no ruleset gains no key.** `gameRuleset` is written only when a ruleset was chosen, so legacy metadata keeps its bytes.
- **Copy-at-setup lives in one place.** `applyGameSetupPayload` loads the party's and the persona's stored sheets itself, so both setup entry points (`/game/setup` and `/game/setup/apply-json`) copy the same way. Cards are matched by normalized name, as `rpgStats` already is, and the persona wins a name it shares with a party member. A member with no stored sheet gets a blank default build.
- **Setup sharing follows the Experience rule.** A shared ruleset is restored for a new game when this install has it at the shared version or newer, and dropped otherwise; the wizard then names the missing ruleset from the file's `rulesetName` label. The pin inside a shared file is untrusted input and is read through `rulesetRefSchema`.
- **The Rules block is its own component** (`GameSetupRulesChooser`), placed beside Combat Preference, rendered only for a new game with at least one ruleset installed.

## What slice 5 settled

- **Live state is its own snapshot column.** `game_state_snapshots.ruleset_live` holds `RulesetLiveStates`, keyed by normalized card name. A new column on the file-backed store needs no `STORAGE_VERSION` bump: an old row reads the column as null, and null means every pool at its default. It is not a key inside `playerStats`, because several trackers rebuild that object from the fields they know.
- **Live state is sparse.** Only values that were set are stored, and a value back at its default is dropped again. An untouched "full" pool therefore follows its maximum when a level-up raises it, and a character with nothing spent has no entry at all.
- **A turn is measured against the state it started with.** `[sheet:]` commands are applied after every rewrite of the reply and before it is saved, on top of the live state of the row the turn follows (for a continuation, the row the continued message already has). A regenerated turn resolves its base from the messages before it, so it cannot spend twice, and each swipe keeps the state it ended with.
- **Every saved turn of a ruleset game writes its row**, changed or not, so the next turn, a swipe and a new session always have a row to start from. A tracker that later rebuilds the same message and swipe keeps the live state: `create` carries it over from the row it replaces unless the caller passes one.
- **The command is the Engine's, the names are the ruleset's.** The grammar (`spend`, `restore`, `damage`, `temp`, `track`, `condition`, `note`, `rest`, with `heal` read as `restore`) is the same for every ruleset. `concentrate` from the first proposal became the general `note`, because "concentration" is one system's word. Pool, track, condition, note and rest names come from the ruleset and are matched by id or label.
- **The saved reply is the record.** Each command is rewritten in place with `result="ok" now="…"` or `result="refused" reason="…"`. A result the model writes itself is ignored. A refused command changes nothing and is logged; the client says so once per turn.
- **Sheets reach the Game Master late in the prompt.** The sheet blocks and the command lines are part of the per-turn format reminder, never the system prompt, because live state changes every turn and the system prompt is what a provider caches. With no ruleset the reminder is byte-identical.
- **The player edits through the same rules.** The in-game sheet applies `applyRulesetSheetOp` for every button and saves through `PATCH /chats/:id/game-state`, which bounds live state (`rulesetLiveStatesSchema`) and judges nothing else: it is the player's own game.
- **`sheet` is reserved.** A package verb with that name is refused, and the verb-name sweep finds the taught tag in the reminder.
- **Not done here:** party members' own turns (`/party-turn`) do not apply sheet commands; only the Game Master's reply does.

## What slice 7a settled

- **Storage.** Community rulesets live in a new file-backed table, `game_rulesets`, one row per namespaced id and version, holding the exact imported text and its sha256. No storage format bump. The table has no owner and no cascade: removing the repository that supplied a ruleset only clears `repositoryId`.
- **Ids.** The file always carries its bare id. The Engine files it as `local/<id>` for a picked file and `<owner>/<id>` (GitHub owner, lower-cased) for a repository, and the registry rewrites `definition.id` to that namespaced id, so sheets, pins and the wizard all key on it. A GitHub account named `local` is refused, so nobody can file rulesets among the user's own.
- **Versions.** A stored version is never rewritten. The same bytes are a no-op, different bytes under an existing version are refused (`RulesetVersionConflictError`) with a message telling the author to raise the version. A community pin resolves the exact version it names (`version-missing` when it is gone); official packages keep the "installed is at least the pinned version" rule.
- **Gating.** Single-file import needs privileged access and **Allow custom Agent imports**. The repository lane keeps its own env flag on top. With imports off, `/game/create` refuses a community ruleset (`ruleset_imports_disabled`) and the wizard leaves them out, but resolution never consults the policy, so existing games keep working. Removal needs privileged access only, so it still works with imports off.
- **Removal.** `DELETE /api/game-rulesets?rulesetId=` removes every stored version. When games pin the ruleset it answers 409 `ruleset_in_use` with the count, and the client asks again before retrying with `force=true`.
- **Review.** No capability checkboxes, because a ruleset has none. The review shows identity, license, coverage, how checks roll, and the Game Master text verbatim, and says that text is sent to the model.
- **Repository lane.** `<top>/rulesets/*.json`, direct children only, at most 32 files of `RULESET_MAX_BYTES`. A repository may carry agents, rulesets, or both. One unusable file is a preview row with its reasons, never a failed repository. A ruleset withdrawn upstream stays installed.
- **Authoring.** `docs/extending/writing-rulesets.md` leads with the ceiling. `docs/extending/ruleset.schema.json` is generated from the zod schema by `pnpm ruleset:schema`, and a regression fails when it is stale. The guide's example ruleset rolls 2d6 on purpose and is validated by a regression.

## What slice 8a settled

- **The header is in the ruleset, the entries may not be.** `ruleset.json` gains an optional `catalogs` array (at most 12). Each header carries `id`, `label`, the sheet lists it `feeds` (1 to 8), declared `filters`, optional `units`, and exactly one of `entries` (inline) or `asset`. The key is absent rather than empty when a ruleset ships none, so a file written before catalogs existed still parses to the same bytes.
- **The asset path is derived, never chosen.** `asset` must equal `catalogs/<the catalog's id>.json`, so the route finds the file from the ruleset alone and no catalog can name another one's file.
- **One helper decides what a list can hold.** `rulesetListRowIssues(list, values)` is exported from the shared package and is the single answer to "could this row be stored": the schema runs it over every inline entry, `parseRulesetCatalogFile` runs it over an asset's entries at read time, and the client runs it again over the rows a player picked. A catalog therefore cannot write something the editor would then refuse. `rulesetCatalogEntryIssues(definition, catalog, entries)` is the shared wrapper both validation paths call.
- **Copy at pick, like copy at setup.** `rowsFromCatalogEntry` returns the rows with one reserved key, `RULESET_CATALOG_ROW_KEY = "_catalog"`, holding `<catalogId>/<entryId>`. Column ids must start with a letter, so it can never collide with one. The rows are copies: the player edits them, the sheet stays readable while its ruleset is uninstalled, and a new ruleset version never rewrites a character.
- **Caps.** 12 catalogs per ruleset, 8 feeds and 8 filters per catalog, 2000 entries per catalog inline or asset, 6 rows per entry, and `RULESET_CATALOG_MAX_BYTES = 1 MB` per asset, checked against the manifest's declared `files[].bytes` before the file is read.
- **The list stays small.** `GET /api/capability-packages/rulesets` strips inline `entries` and reports `entryCount` instead, because the list is read whenever a sheet editor opens. A ruleset without catalogs is listed byte for byte as before. `GET /api/capability-packages/rulesets/catalog?rulesetId=&catalogId=&version=` serves one catalog: inline entries, or the parsed and validated asset. It has no privileged gate, for the same reason `/rulesets` has none, and it is registered ahead of the `/:id/...` routes so a package id cannot shadow it. An unknown ruleset, version or catalog is a 404 with a code; an asset the Engine will not read is a 422 with the author's own issue lines.
- **Capability API 1.21, with two halves.** Declaring a `catalogs/<id>.json` asset requires 1.21 and the `ruleset.json` beside it. Catalogs also live INSIDE the ruleset file, which the manifest cannot show, so install reads the verified bytes and refuses a `catalogs` key under a lower declaration. An unparseable ruleset does not fail the install: that stays the registry's report, with a log line.
- **`mechanics` is validated, and partly consumed.** The optional block (kind, range, area, targets, friendly fire, amount, damage type, attack roll, save, cost, per-cost step, concentration, reaction) is a closed strict vocabulary so a typo surfaces now rather than when something finally reads it. Slice 8a only validated it and showed one compact line in the picker. The combat bridge consumes kind, range, area, friendly fire, amount, damage type, cost and reaction (to leave reaction entries out). Attack roll, save, concentration and per-cost step are still read by nothing.
- **Known ceiling: community catalogs are inline only.** A ruleset imported as a single file, or received from a GitHub repository, carries its catalogs inside the one file, and therefore inside the existing 256 KB cap. Separate catalog files for community rulesets (`rulesets/<id>/catalogs/*.json`) were left out on purpose: the repository lane reads direct children of `rulesets/` only, and the single-file lane has one file by definition. A community author with a list too long for 256 KB publishes a package instead. If that becomes a real limit, it is its own slice.
- **The proof is a second non-d20 ruleset.** `docs/examples/rulesets/ember-roads.json` grew a `knacks` list, a `tricks` list whose rows are pools, and a catalog feeding both, with an entry that writes two rows and entries carrying `mechanics`. Nothing in the format is 5e-shaped, and the regressions read that file rather than the 5e one.

## What the combat bridge settled

- **A ruleset opts in, and silence changes nothing.** `ruleset.json` gains an optional `battle` block: `health` (required, the live pool that is hit points), optional `energy` (the pool that becomes MP), optional `slots` (pools with a level from 1 to 9), and optional `skills` (up to eight sheet lists, each with an optional `onlyWhen` boolean column and an optional `alwaysWhen: { column, equals }` exception). With no block, a battle is byte for byte the battle it was before. Capability API 1.22, gated at install the way `catalogs` is, because the block lives inside the ruleset file and not in the manifest.
- **Every name points at a declared live pool.** A list whose rows are pools cannot be hit points: a row pool is keyed by the row's name and comes and goes as the sheet is edited. Health and energy differ, slot pools are unique, levels are unique, lists exist, `onlyWhen` is a boolean column and `alwaysWhen.column` is a column of the same list.
- **The bridge is three pure shared helpers**, in `packages/shared/src/features/rulesets/combat-bridge.ts`: `seedCombatantFromSheet`, `combatSkillsFromSheet` and `sheetOpsFromCombatResult` plus `applyCombatResultToLive`, over the one conversion `carryHealthShare` that both directions of health go through. No I/O, no throwing, no server route. The client calls them either side of the one seam all three battle UIs share.
- **Hit points are carried as a SHARE of the maximum, both ways.** Found by the first browser pass: the Engine builds a level 1 combatant with around 60 hit points and deals 11 to 15 damage a hit, while an Ember Roads character has 9 Grit and a level 1 5e wizard has 8 hit points. The damage arithmetic is the Engine's and stays the Engine's, so lending raw sheet numbers killed a bridged character with the first blow of every fight. The combatant keeps the Engine's own `maxHp` and starts at the same share of it the sheet's health pool is at; the write-back reads the final share back onto the sheet's scale and writes the difference. Energy and slots stay absolute: they are small counts, their costs come off the same sheet, and the Engine spends them one at a time. The toast, `docs/game/combat.md` and the ruleset guide all say that the numbers in battle are Marinara's.
- **A share never moves a sheet by itself.** A fight that did not move the combatant's hit points writes no health operation at all, so the two roundings cannot drift a sheet by a point. Above zero never converts to below one in either direction, so nobody is rounded out of a fight or off a sheet.
- **Zero hit points is the real number.** A member whose health pool is empty starts the fight down, which is the state a member knocked out inside a fight is already in. Clamping to 1 would invent health the sheet does not have. A party that is entirely down ends the fight in an immediate defeat, which is the honest outcome. The same holds in reverse: a combatant at zero writes the sheet to zero.
- **Only catalog-marked rows become skills.** A row typed by hand has no `mechanics` behind it, so there is nothing to turn into numbers. A cost on a pool the Engine cannot spend (hit points, a pool group, a class resource) takes the skill away rather than making it free. `utility` and reaction entries are left out.
- **`power` is calibrated, not computed.** It is a multiplier on the fighter's attack, so the bridge divides the average amount by 7 and clamps to 0.5 to 3: a basic weapon then lands where the Engine's own basic skills sit (1.35 for an attack, 1.15 for a heal) and a third-level area spell reaches the ceiling a generated skill is already clamped to. A bigger die pool never yields a smaller multiplier.
- **Write-back goes through the sheet's own rules.** Each delta becomes a `damage`, `restore` or `spend` operation applied with `applyRulesetSheetOp`, so a battle can never write something the sheet would refuse from the Game Master or from the player. The write-back is not all or nothing: a refused operation is skipped and returned to the caller, and the operations that were accepted stay applied. An abandoned battle writes nothing: the fight did not happen.
- **The summary carries what the sheet needs.** `buildTacticalSummary` now reports `mp`, `maxMp` and `spellSlots` like the director's summary already did.
- **What the bridge deliberately does not read.** `attackRoll`, `save`, `concentration` and `perCostStep` stay validated and unused, and `coverage.combat` keeps its own meaning. Applying them would be a claim to implement a system's combat, which is the combat handoff's work.

## Architecture

### The pin

```ts
type RulesetRef = {
  id: string; // bare for an official ruleset, "<owner>/<id>" or "local/<id>" for a community one
  version: number;
  packageId: string | null;
  source?: string; // where a community ruleset came from
  options: Record<string, boolean | number | string>;
};
// chat.metadata.gameRuleset?: RulesetRef   — absent means engine-legacy
```

Written once by game creation, like `gameExperienceId`. `gameRuleset` is declared on the `ChatMetadata` interface, so the GM-verb namespace derivation sees it as Engine-owned. An unknown id, or a pinned `version` newer than the installed definition, makes the game read-only-recoverable with a clear message, never silently reinterpreted. An installed definition newer than the pin is accepted, because sheets are read tolerantly against the current schema. The combat handoff's `RulesetRef` closes `id` to four built-in names; this one widens it to a string so community rulesets can exist, which is part of the sign-off asked for above.

### `ruleset.json` (Capability API 1.20)

A package lists `ruleset.json` in `contributions.assets.paths`, hash-pinned in `files[]`. Discovery is by that reserved filename, as with `gm-verbs.json`. The Engine refuses it on declared bytes above 256 KB before reading, validates it with a strict shared zod schema, and drops it with one log line if unusable. A ruleset package is useless without the seam, so it declares 1.20 and older Engines refuse the install cleanly.

Top-level shape (see the draft file): `id`, `version`, `name`, `edition`, `license`, `coverage`, `resolution`, `sheet`, `rests`, `gm`.

### Resolution kinds

`resolution.kind` is a discriminated union. Slice 2 ships one kind:

- **`dice-sum`**: roll the ruleset's dice (1d20 by default), add the ability modifier, the proficiency tier's bonus and any free bonus on the sheet, and meet or beat a DC. It supports advantage and disadvantage, and a per-roll-type policy for the extreme faces of a single die. For `5e-2014` that policy is `none` for checks and saves, which is a deliberate difference from `engine-legacy`. The first draft called this kind `d20-sum`; the dice became a parameter so a 2d6-plus-stat system does not need a kind of its own.

A second kind, **`dice-pool`** (pool size from two sheet ratings, target number, 1s cancelling, botch, exploding or doubled tens, specialties), is slice 7 and should be specified with a community author who runs those systems.

The resolver keeps every invariant the current service documents: it never throws, a roll that cannot happen writes the tag back sparse, numbers the GM invented are replaced, and the record in **Logs** is the Engine's.

### Sheet schema primitives

Closed set: `abilities`, `skills` and `saves` (each optionally naming its ability), typed `fields` (`number`, `text`, `longtext`, `boolean`, `enum`, `dice`), `derived` values (closed ops `sum`, `stepTable`, `scale`, `min`, `max` over value references), `lists` of typed columns with `maxItems`, and `live` state (`pools`, `tracks`, `text`, `conditions`). A value reference is an object with exactly one of `const`, `field`, `derived`, `abilityScore`, `abilityMod`, `abilityModFromField`, `skillMod`, `saveMod`; there are no expression strings. The editor and the in-game sheet are rendered generically from this. No package client code is needed, and no editor slot.

Equipment is deliberately not a list: Game Mode already owns inventory. The sheet carries `attacks` and an entered `ac`.

### Storage: build versus live

| Part           | Contents                                                                                                      | Home                                                                                               | Rewinds with swipes          |
| -------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| Starting build | Everything the author enters                                                                                  | Card: `data.extensions.rulesetSheets[rulesetId]`. Persona: `personaStats.rulesetSheets[rulesetId]` | n/a                          |
| Game build     | Copy taken at setup; edited by Edit Sheet and level-ups                                                       | `chat.metadata.gameCharacterCards[].rulesetSheet`                                                  | No, same as `rpgStats` today |
| Live state     | Current HP, temp HP, slots left, hit dice, class counters, conditions, concentration, exhaustion, death saves | Game-state snapshot, keyed by card name                                                            | Yes                          |

Live state belongs in the snapshot because sheet commands are relative ("spend one 3rd-level slot"), and a regenerated turn must not spend twice. It is its own column, `game_state_snapshots.ruleset_live`, which needed no `STORAGE_VERSION` bump. See § What slice 5 settled for how a turn reads and writes it.

Each stored sheet is `{ v, build }` and is refused above 64 KB serialized.

### GM surface

When the game's ruleset resolves, the per-turn format reminder (`buildGmFormatReminder`, never the system prompt):

1. replaces the built-in skill-check paragraph with `gm.checkGuidance` and the difficulty ladder;
2. adds a compact sheet block per party member inside `<character_sheets>`: ability modifiers, trained skills and saves, the `gm.sheetSummary` fields, remaining resources, tracks away from their default, notes, active conditions, and the summary lists;
3. teaches one Engine-owned command, `[sheet: who="Name" op="…" …]`, with a closed operation set: `spend`, `restore` (`heal` is read as `restore`), `damage`, `temp`, `track`, `condition`, `note`, `rest`. The first proposal's `concentrate` became the general `note`.

The Engine validates every operation against the live sheet. A cast with no slot left is refused, logged, written back into the reply as refused, and surfaced once per turn, never applied as a negative pool. `sheet` is in the reserved GM tag set, and the verb-name regression finds the taught tag in the reminder. With no ruleset pinned, the prompt is byte-identical; `game-ruleset-checks.regression.ts` and `one-request-dice-prompt.regression.ts` pin that, and `pnpm regression:prompt` covers the rest of the prompt.

`[skill_check:]` gains an optional `who=`. Without it the player is checked, as today. Saves are requested as `skill="Dexterity save"`, which the existing normaliser already recognises.

One-request dice placeholders gain `PROF` (when the ruleset has a proficiency bonus) and the ruleset's skills, saves and abilities, by id or label, as resolvable names, under the existing rule that an unresolvable name is refused rather than treated as zero.

### Setup, editor and in-game UI

- **Setup wizard**: a localized **Rules** choice beside, not inside, combat presentation. Default is Marinara's own rules. Each installed ruleset shows its `coverage.summary`. Party members and the persona show whether they have a sheet for the chosen ruleset; a missing sheet offers the editor or a blank default build. Generation never invents authoritative scores.
- **Setup sharing** (`game-setup-share.ts`): restore the ruleset when installed and compatible; otherwise report it and fall back to default rules, as Experience import does.
- **Character and persona editors**: under **Stats**, one collapsible subsection per installed ruleset, rendered from the schema. Sheets stored for rulesets that are not installed show as a single line with a **Remove** button.
- **In-game sheet** (`GameCharacterSheet.tsx`): when the game has a ruleset, render the ruleset sheet with live pools, a rest control, and hit-dice spending. Level-up is manual in v1: the player edits the build and derived values recompute.

### Import and export

Nothing needs to be added for sheets to travel: `extensions` and persona stats already pass through every importer and schema. The rule is **keep dormant, never drop**: a sheet for a ruleset the importer lacks is kept under its key, hidden from prompts, shown as one removable line, size-capped at import, and validated against the ruleset's schema only when that ruleset is first installed and used. Dropping would silently destroy the sheet for anyone who installs the ruleset later and for everyone downstream of a re-export.

Not yet verified: that the Compatible JSON and PNG exporters leave unknown extension keys alone. Check before documenting the behaviour.

## What the `5e-2014` sheet covers

| Tier                             | Meaning                                      | Contents                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Engine computes with it       | Authoritative arithmetic                     | Six ability scores, level, proficiency bonus, skill proficiency tier (none, half, proficient, expertise), save proficiencies, spellcasting ability, spell save DC, spell attack bonus, passive Perception, initiative |
| B. Engine tracks the number      | Enforced bookkeeping, no fiction adjudicated | HP and temp HP, hit dice, spell slots 1st–9th, Pact Magic slots, named class counters with short or long recharge, death saves, exhaustion, the fourteen SRD conditions, concentration, short and long rests          |
| C. Engine stores it, GM reads it | Structured lists                             | Spells (level, prepared, ritual, concentration, notes), attacks, features and traits, other proficiencies and languages, class, subclass, race, background, alignment, XP                                             |

Deliberately out of v1: class and subclass tables (slot maxima and HP are entered, not derived), multiclass slot calculation, a structured spell compendium, armour-derived AC, automated level-up, enemy and NPC sheets, attack rolls and critical hits (combat adapter), tool checks.

Spells are tier C on purpose. Out of combat the GM adjudicates the effect; the Engine guarantees the spell is on the sheet and the slot is really spent. The combat adapter later gives a small supported spell list mechanical definitions, and at that point battle slots come from the sheet instead of from encounter generation.

## The package

`packages/ruleset-5e-2014/` in Marinara-Agents: `manifest.json` (schema 2, API 1.20, `contributions.assets.paths: ["ruleset.json"]`), `ruleset.json`, `locales/en.json`, `README.md`, `CHANGELOG.md`, and the SRD attribution. No server entrypoint, no client entrypoint, no LLM agent. Slice 1 confirmed that `capabilityPackageManifestSchema` accepts a package with empty `entrypoints`, so no Engine schema change and no dummy agent is needed. The Marinara-Agents catalog validator still requires `entrypoints.agents` for every catalogued package, which slice 6 has to relax for kind `ruleset`.

Display name "5e (SRD 5.1)". Do not use Wizards of the Coast trademarks in the name, description or artwork. Copy the attribution statement verbatim from the SRD 5.1 PDF. List the id in `INCOMPLETE_PACKAGE_IDS`, then `STAGING_ONLY_PACKAGE_IDS`.

No rules lorebook in v1. The guidance block plus the sheet block is enough for capable models, and a CC-BY SRD lorebook already exists in the community for anyone who wants one attached.

## Authoring and sharing a community ruleset

**Authoring.** An author writes one `ruleset.json`, starting from the 5e file. They choose a resolution kind the Engine supports, declare the sheet, the rests and the GM guidance, and validate against a JSON Schema generated from the shared zod schema and published with the docs, plus a small validator script. A sheet hand-entered through **Edit Spoilers** is enough to test a check before any editor UI exists.

**The ceiling.** Data can only parameterise a kind that exists. A mechanic no kind expresses (exploding dice, roll-under percentile, degrees of success, a Fate ladder) is an Engine PR adding a kind with regressions, not something a ruleset file can do. That is the cost of having no scripting language, and the authoring docs must say it first, not last. Community authors who already implement these mechanics are the right people to contribute the kinds, and their existing cases are ready-made regressions.

**Sharing, three lanes.**

| Lane              | How                                                                                                                                                                            | Fits                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Official catalog  | PR a package to Marinara-Agents; one-click install from **Download Agents**                                                                                                    | Widely played systems with clean licensing                                             |
| Custom repository | The existing custom agent repository lane also reads `rulesets/*.json`. A user adds the author's GitHub URL once, reviews the preview, and receives later updates the same way | An author with several systems; the requester's repository is already shaped like this |
| Single file       | **Import ruleset** accepts one `ruleset.json`                                                                                                                                  | Iterating locally, or handing a file to a friend                                       |

All community lanes sit behind **Allow custom Agent imports**. Nothing executes, but `gm.*` text reaches the GM prompt, so the import review says so and treats a ruleset with the same trust as an imported agent prompt or lorebook.

**Rules that make sharing safe.**

- Official ids are bare (`5e-2014`). Community ids are namespaced by source (`<owner>/<id>` for a repository, `local/<id>` for a file), so two authors' `v20` never collide and nothing can shadow an official ruleset.
- Definitions are stored by id and version. An update adds a version and never rewrites one. A game keeps resolving the version it pinned; the same version arriving with different bytes is refused with a message telling the author to bump it.
- A sheet is read tolerantly against its ruleset's current schema: unknown fields are kept, missing fields take defaults, out-of-range values are clamped on edit, never on read. There are no migration scripts.
- A community `RulesetRef` carries its source URL. A shared setup file or a dormant sheet can therefore tell the recipient where the missing ruleset came from, instead of only that it is missing.

Characters travel on their own. A card exported with a community sheet keeps it, a recipient without that ruleset keeps it dormant, and it becomes live the moment they add the author's repository.

## Proposed: the rest of catalogs

Status: the format, the route, Capability API 1.21 and the sheet editor's picker are built (§ What slice 8a settled). The first-party SRD content shipped as the `ruleset-5e-2014` package 0.2.0, and the combat bridge is built (§ What the combat bridge settled). Level-scaled maximums, Refresh from ruleset and the cast helper are still ahead. Raised by the first hands-on use of the 5e sheet: entering spells, attacks and class features row by row is miserable, and a community author will want to ship their system's content the same way.

**The picker.** The sheet editor gains an **Add from catalog** button on every list a catalog feeds. It opens a searchable picker with the catalog's declared filters, multi-select, and a mark on entries the sheet already has, read from the `_catalog` key the picked rows carry. It reads the entries from the catalog route when it opens, never before. A later **Refresh from ruleset** action can use the same mark to offer the newer text of an entry the author has changed.

**Catalog entries and combat.** A sheet and its catalogs do not make a battle follow the ruleset. Tactical and Classic battles run on the Engine's own combat model today (`CombatSkill`: a range, an area radius, a slot level, a power multiplier against the attack stat), and the Engine resolves nothing by the ruleset's own rules. A ruleset without a `battle` block is not read by a battle at all; one with the block lends the fight its health, energy, slots and catalog-picked rows through the combat bridge (§ What the combat bridge settled), still on the Engine's math. Rules-accurate resolution (a save for half damage, upcasting, action economy, which metamagic may touch which spell) is code, and it belongs to the combat handoff's per-ruleset adapters (`game-combat-rulesets-implementation.md`, its slice 5 for `5e-2014`), not to a data file. What a catalog CAN carry is the facts such an adapter needs, which is why an entry already has the optional typed `mechanics` block slice 8a shipped: range, area shape and size, attack roll or save (a save the sheet declares, and what a success does), damage dice and type, what one step of a higher cost adds, targets, concentration. Entering the SRD once is the point. The smaller step that was possible before any adapter exists is now built (§ What the combat bridge settled): a ruleset opts in with a `battle` block, a combatant is seeded from the sheet at the start of a battle (health as a share of the Engine's own maximum, an energy pool, slots), catalog-marked rows become Engine skills (range in cells, area, slot cost, element), and health, energy and slots are written back afterwards. The sheet matters in a battle while the damage math stays the Engine's, and the docs and the UI say so.

**Later, not in the first cut.** Maximums that grow with level (Ki points equal to level, Rage uses from a table): the entry would carry a `stepTable` or a value reference for that column and the editor would recompute it when the level changes, on edit and never on read. A cast helper (`[sheet: op="cast" spell="Fireball"]` that finds the slot) also belongs here.

**Cheaper helps that need no format change**, worth doing alongside: paste a list of names into a list to create the rows, and the already-listed open decision 1 ("suggest a sheet from this card", reviewed and accepted by the user).

**First-party content for `5e-2014`** once the format exists: SRD 5.1 spells, the SRD class features with their resource counters (Second Wind, Action Surge, Rage, Ki, Channel Divinity, Bardic Inspiration, Sorcery Points, Wild Shape, Lay on Hands, Arcane Recovery), and the SRD weapon table as ready-made attack rows. SRD 5.1 is CC-BY-4.0, so the text may ship with the attribution the package already carries. It must be built from an authoritative machine-readable copy of the SRD, never typed from memory.

**Slices.** 8a, Engine: the catalog format, the asset loader and the route, and the sheet editor's **Add from catalog** picker, with regressions on a second non-5e ruleset. Built. 8b, Agents: `ruleset-5e-2014` 0.2.0 with the SRD catalogs. Shipped. 8c, Engine: level-scaled maximums, Refresh from ruleset, the cast helper. Community catalogs in files of their own (§ What slice 8a settled records why they are not here) would be another.

## Slices and exit evidence

Each slice is one PR against `staging`, with a draft PR opened when work starts, a `CHANGELOG.md` `[Unreleased]` entry, localized copy, docs, a `[docs-i18n]` follow-up, and unchecked manual-verification boxes. Proofs are `*.regression.ts`; no `.test.ts` stays in the tree.

| #   | Repo            | Work                                                                                                                                                                | Smallest useful proof                                                                                                                                                                                                                                                                                     |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | —               | Open the issue (Appendix) and get sign-off on § Relationship                                                                                                        | Maintainer reply on the issue                                                                                                                                                                                                                                                                             |
| 1   | Engine + Agents | Shared zod schema and types, `RulesetRef`, ruleset registry reading `ruleset.json` from installed packages, package skeleton marked incomplete. No behaviour change | Draft file validates; unknown kind, unknown key, oversized file and duplicate id are refused with a log line; a game with no pin resolves `engine-legacy`                                                                                                                                                 |
| 2   | Engine          | `dice-sum` resolver wired into `skill-check-resolution.service.ts`; GM reminder swap; `who=`                                                                        | Proficiency, expertise, half proficiency, save proficiency, level boundaries 4→5 and 16→17, advantage, natural 20 below DC fails and natural 1 above DC passes; legacy chat byte-identical in prompt and result. Manual: hand-enter a sheet through **Edit Spoilers** JSON and watch a real banner        |
| 3   | Engine          | Sheets on cards and personas: storage, generic Stats subsection, dormant handling, size cap                                                                         | Round-trip through Marinara Native export and import with and without the package installed; persona normalization keeps the key; light, dark and 400 px screenshots                                                                                                                                      |
| 4   | Engine          | Rules choice in the setup wizard, missing-sheet handling, copy-at-setup, setup sharing                                                                              | New game copies the build; library card unchanged after in-game edits; setup import without the package falls back with an explanation                                                                                                                                                                    |
| 5   | Engine          | In-game ruleset sheet, live state, `[sheet:]` command, rests, reserved-tag sweep                                                                                    | Spend then swipe restores the slot; regenerate does not double-spend; cast with no slot is refused with a visible notice; long rest restores half hit dice with a minimum of one; verb named `sheet` is refused                                                                                           |
| 6   | Agents          | Finish and stage the package                                                                                                                                        | `validate-catalog.mjs` green; install, update and uninstall on a staging Engine; a game whose package was uninstalled opens read-only-recoverable                                                                                                                                                         |
| 7a  | Engine          | Community lanes: **Import ruleset** for one file, and `rulesets/*.json` read by the existing custom agent repository lane                                           | A namespaced id cannot shadow an official one; the preview lists added, changed and removed rulesets; same version with different bytes is refused; a game keeps its pinned version after an update; turning the import toggle off hides community rulesets from new games without breaking existing ones |
| 7b  | Engine          | `dice-pool` resolution kind                                                                                                                                         | Specified with, and ideally contributed by, a community author who already runs pool systems; their existing cases become the regressions                                                                                                                                                                 |
| —   | Engine          | `5e-2014` combat adapter                                                                                                                                            | Combat handoff slice 5, after its slices 1–4                                                                                                                                                                                                                                                              |

Slices 1 and 2 come first because they are testable end to end with no UI at all, which is the cheapest way to find out the schema is wrong.

Slice 7a depends only on slice 1, and 7b only on slice 2. Neither should wait for 3–6: the request came from a community author, and under a strictly numbered order they would be the last person served. Run 7a and 7b in parallel with the sheet UI once slice 2 has merged.

## Open decisions, with defaults

1. **Companions without a sheet.** Default: blank build plus manual entry. An optional "suggest a sheet from this card" action that the user reviews and accepts is a reasonable later addition and stays consistent with "generation does not manufacture authoritative stats", because acceptance is the user's act.
2. **XP or milestones.** Default: the sheet stores XP, nothing awards it automatically, and level is edited by hand.
3. **Command tag name.** `[sheet:]` is a proposal; any name works provided it joins the reserved set.
4. **Who builds `dice-pool`.** Default: invite the requester to specify it on the issue, and to contribute it if they want to. They have a working implementation and the systems knowledge; the Engine side supplies the seam and review.

5. **Layers on top of a ruleset (for example Low Magic on 5e).** Not designed yet; revisit when slice 7a (community lanes) starts, because both are about content that someone other than the ruleset's author ships. What is already settled: a game pins exactly one base ruleset, so two systems can never mix and base rulesets never need to declare each other incompatible. A layer is different: it would be data that names the ruleset id (and lowest version) it applies to, because a base ruleset cannot know every future homebrew. A ruleset may ship its own layers, and a package may ship one for someone else's ruleset without forking it. The wizard would offer them as toggles under the chosen ruleset, and the choice would be frozen into the pin, whose `options` record exists for this and is empty today. Effects would be a closed set like everything else in the format, with no added model calls: extra Game Master guidance (including a world-generation guidance slot, which base rulesets lack too), restrictions on sheet fields (for example removing classes from an enum), and changes to the difficulty ladder or a declared extra check (spell failure is an ordinary check at a stated difficulty). Nothing shipped so far blocks this: the pin keeps unknown keys. Revisited when slice 7a was built: it stays its own later slice, after catalogs and the combat bridge. Slice 7a changed nothing that a layer would need: a community pin has the same `options` record, and a layer shipped through a community lane would be stored and versioned the way a community ruleset is.

## Not verified for this document

`game-state.storage.ts` and whether a snapshot field needs a storage-version bump; the Compatible JSON and PNG export paths; `GameSetupWizard.tsx` and where the Experiences block writes `gameExperienceId`; `game-setup-share.ts`; how the custom agent repository lane surfaces in the client, and whether its archive reader tolerates extra top-level folders; the sighted dice pool's interaction with a ruleset resolver; `game-combat-ai-design.md`.

## Appendix: issue draft

> **Game Mode: selectable rulesets and ruleset character sheets (5e first)**
>
> Requested by the author of Marinara-RPG-Extension, who currently needs four or five per-turn agents per system to work around d20-only checks and the six-attribute sheet. Proposal: a ruleset is validated data (`ruleset.json`, a reserved-filename package asset like `gm-verbs.json`) that parameterises a closed, Engine-owned set of resolution kinds and declares a full character sheet. No package code, no expression strings, and no added model calls. Sheets live on cards and personas as starting builds and are copied into each game.
>
> This reads the combat handoff's "closed registry of built-in adapters" as applying to resolution kinds and combat adapters, with ruleset definitions as data. Is that acceptable, and is anyone working on something adjacent? First-party scope is `5e-2014` on SRD 5.1. Combat is unchanged and stays with the combat handoff. Full plan: `docs/development/game-rulesets-and-sheets-implementation.md`.
