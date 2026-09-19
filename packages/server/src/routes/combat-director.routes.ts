import { createGameStateStorage } from "../services/storage/game-state.storage.js";
import { normalizeGameDifficulty, combatWeatherSchema } from "@marinara-engine/shared";
import { resolveCombatWeather } from "../services/game/weather.service.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TERRAIN_DATA,
  combatBossSchema,
  combatInterruptFields,
  combatTacticsSchema,
  combatAiHintsSchema,
  type Combatant,
  type DirectedCommand,
} from "@marinara-engine/shared";
import { createChatsStorage, withChatMetadataPatchQueue } from "../services/storage/chats.storage.js";
import { createGameEngineStateStorage } from "../services/storage/game-engine-state.storage.js";
import {
  createCombatDirector,
  combatDirectorView,
  commandCombatDirector,
  type CombatDirectorState,
} from "../services/game/combat-director.service.js";
import { chooseGmCombatOption } from "../services/game/combat-boss.service.js";
import { resolveTacticalStartPreferences } from "../services/game/tactical-battlefield.service.js";
import { logger } from "../lib/logger.js";

// Host-owned Experience namespace: existing branch/checkpoint/export paths preserve these rows,
// while turn-game readers and resets already exclude the entire experience: prefix.
export const COMBAT_DIRECTOR_NAMESPACE = "experience:marinara-engine.combat";
const key = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const num = z.number().finite().min(0).max(1000000);
const slots = z.record(z.string().regex(/^[1-9]$/), z.number().int().min(0).max(100));
const skill = z.object({
  id: key,
  name: z.string().min(1).max(200),
  type: z.enum(["attack", "heal", "buff", "debuff"]),
  mpCost: num,
  power: num.max(20),
  cooldown: z.number().int().min(0).max(100).optional(),
  description: z.string().max(3000).optional(),
  element: z.string().max(100).optional(),
  statusEffect: z.string().max(200).optional(),
  ...combatInterruptFields,
});
export const directedCombatantSchema = z
  .object({
    id: key,
    name: z.string().min(1).max(200),
    side: z.enum(["player", "enemy"]),
    hp: num,
    maxHp: num.min(1),
    mp: num.optional(),
    maxMp: num.optional(),
    attack: num,
    defense: num,
    speed: num,
    level: num.min(1),
    boss: combatBossSchema.optional(),
    spellSlots: slots.optional(),
    skills: z.array(skill).max(64).optional(),
    tactics: combatTacticsSchema.optional(),
    aiHints: combatAiHintsSchema.optional(),
    controller: z.enum(["manual", "ai"]).optional(),
    skillCooldowns: z.record(z.number().int().min(0).max(100)).optional(),
    statusEffects: z
      .array(
        z.object({
          name: z.string().max(200),
          modifier: z.number().finite().min(-100000).max(100000),
          stat: z.enum(["hp", "attack", "defense", "speed"]),
          turnsLeft: z.number().int().min(0).max(100),
        }),
      )
      .max(64)
      .optional(),
    projectile: z.boolean().optional(),
    requiresSight: z.boolean().optional(),
    combatClass: z.string().max(100).optional(),
    movementMode: z.enum(["walk", "fly", "teleport"]).optional(),
    element: z.string().max(100).optional(),
    sprite: z.string().max(3000).optional(),
  })
  .refine((v) => v.hp <= v.maxHp && (v.mp ?? 0) <= (v.maxMp ?? v.mp ?? 0), "Invalid resource pool.");
const coord = z.object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) });
const itemEffect = z.object({
  name: key,
  target: z.enum(["self", "ally", "enemy", "any"]),
  type: z.enum(["heal", "damage", "buff", "debuff", "status", "utility"]),
  description: z.string().max(3000),
  power: num.max(100).optional(),
  element: z.string().max(100).optional(),
  consumes: z.boolean().optional(),
  status: z
    .object({
      name: key,
      emoji: z.string().max(30),
      duration: z.number().int().min(1).max(100),
      modifier: z.number().finite().min(-100000).max(100000).optional(),
      stat: z.enum(["hp", "attack", "defense", "speed"]).optional(),
    })
    .optional(),
});
const classicAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item"), itemId: key, targetId: key.optional() }),
  z.object({ type: z.literal("attack"), targetId: key }),
  z.object({ type: z.literal("skill"), skillId: key, targetId: key }),
  z.object({ type: z.literal("defend") }),
  z.object({ type: z.literal("flee") }),
]);
const tacticalAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attack"), unitId: key, targetId: key, to: coord.optional() }),
  z.object({
    type: z.literal("skill"),
    unitId: key,
    skillName: z.string().max(200),
    targetId: key,
    to: coord.optional(),
  }),
  z.object({ type: z.literal("item"), unitId: key, itemName: key, targetId: key, to: coord.optional() }),
  z.object({ type: z.literal("move"), unitId: key, to: coord }),
  z.object({ type: z.literal("defend"), unitId: key, to: coord.optional() }),
  z.object({ type: z.literal("wait"), unitId: key, to: coord.optional() }),
  z.object({ type: z.literal("endTurn") }),
  z.object({ type: z.literal("flee") }),
]);
const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("begin"), unitId: key }),
  z.object({ type: z.literal("classic"), action: classicAction }),
  z.object({ type: z.literal("tactical"), action: tacticalAction }),
  z.object({ type: z.literal("choose"), candidateId: key }),
  z.object({ type: z.literal("continue") }),
  z.object({ type: z.literal("fallback") }),
  z.object({ type: z.literal("flee") }),
  z.object({ type: z.literal("control"), unitId: key, controller: z.enum(["manual", "ai"]) }),
]);
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}
export async function combatDirectorRoutes(
  app: FastifyInstance,
  options: { chooseBoss?: typeof chooseGmCombatOption } = {},
) {
  const chats = createChatsStorage(app.db),
    store = createGameEngineStateStorage(app.db);
  const load = async (chatId: string, anchor: string) => {
    const row = await store.getByChatAndMessage(chatId, anchor, 0, COMBAT_DIRECTOR_NAMESPACE);
    if (!row) return null;
    let state: CombatDirectorState;
    try {
      state = JSON.parse(row.state) as CombatDirectorState;
    } catch {
      throw new Error("Unsupported combat save.");
    }
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.requests))
      throw new Error("Unsupported combat save.");
    // Saved blobs can arrive through imports as well as this route. Bound structural data before resuming.
    z.object({
      id: key,
      revision: z.number().int().min(0),
      style: z.enum(["classic", "tactical"]),
      weather: combatWeatherSchema.optional(),
      round: z.number().int().min(1),
      party: z.array(directedCombatantSchema).min(1).max(20),
      enemies: z.array(directedCombatantSchema).min(1).max(20),
      budgets: z.record(
        key,
        z.object({ legendary: z.number().int().min(0).max(6), reaction: z.number().int().min(0).max(1) }),
      ),
      pending: z.record(key, z.unknown()).refine((v) => Object.keys(v).length <= 41),
      choices: z
        .array(
          z
            .object({
              id: key,
              actorId: key,
              kind: z.enum(["attack", "skill", "move", "defend", "wait", "pass"]),
              mpCost: num,
              legendaryCost: z.number().int().min(0).max(6),
              action: z
                .object({ unitId: key, classic: classicAction.optional(), tactical: tacticalAction.optional() })
                .optional(),
            })
            .passthrough(),
        )
        .max(256),
      tasks: z.array(z.unknown()).max(4000),
      requests: z.array(key).max(256),
      inventory: z.array(z.object({ name: key, quantity: z.number().int().min(0).max(10000) })).max(200),
      itemSpends: z.record(key, z.number().int().min(0).max(10000)),
      gmCalls: z.number().int().min(0).max(12),
    }).parse(state);
    if ((state.style === "tactical") !== !!state.tactical) throw new Error("Invalid combat mode in save.");
    if (state.tactical) {
      combatWeatherSchema.optional().parse(state.tactical.weather);
      if (
        JSON.stringify(combatWeatherSchema.optional().parse(state.weather)) !==
        JSON.stringify(combatWeatherSchema.optional().parse(state.tactical.weather))
      )
        throw new Error("Inconsistent weather in combat save.");
      const grid = state.tactical.grid;
      if (
        !grid ||
        !Number.isInteger(grid.width) ||
        !Number.isInteger(grid.height) ||
        grid.width < 1 ||
        grid.height < 1 ||
        grid.width > 64 ||
        grid.height > 64 ||
        grid.tiles.length !== grid.height ||
        grid.tiles.some(
          (row) =>
            !Array.isArray(row) || row.length !== grid.width || row.some((tile) => !Object.hasOwn(TERRAIN_DATA, tile)),
        )
      )
        throw new Error("Invalid battlefield in save.");
      if (!Array.isArray(state.tactical.units) || state.tactical.units.length > 40)
        throw new Error("Invalid saved units.");
      for (const u of state.tactical.units) {
        directedCombatantSchema.parse({ ...u, side: u.side === "party" ? "player" : u.side });
        if (
          !Number.isInteger(u.x) ||
          !Number.isInteger(u.y) ||
          u.x < 0 ||
          u.y < 0 ||
          u.x >= grid.width ||
          u.y >= grid.height
        )
          throw new Error("Invalid saved position.");
      }
    }
    state.anchor = anchor;
    state.instanceId = row.id;
    return { row, state };
  };
  const save = async (rowId: string, chatId: string, s: CombatDirectorState) => {
    s.revision++;
    combatDirectorView(s);
    await withChatMetadataPatchQueue(chatId, () =>
      app.db.transaction(async () => {
        const previous = await load(chatId, s.anchor);
        if (!previous || previous.row.id !== rowId) throw new Error("Battle changed while saving.");
        const deltas = Object.entries(s.itemSpends)
          .map(([name, count]) => ({ name, count: count - (previous.state.itemSpends[name] ?? 0) }))
          .filter((d) => d.count > 0);
        if (deltas.length)
          await chats.patchMetadata(
            chatId,
            (meta) => {
              const inventory = Array.isArray(meta.gameInventory)
                ? (structuredClone(meta.gameInventory) as Array<{ name: string; quantity: number }>)
                : [];
              for (const d of deltas) {
                const item = inventory.find((i) => i.name === d.name);
                if (!item || item.quantity < d.count) throw new Error("Inventory changed. Reload the battle.");
                item.quantity -= d.count;
              }
              return { gameInventory: inventory };
            },
            { metadataQueueHeld: true },
          );
        await store.updateStateById(rowId, JSON.stringify(s), true, chatId);
      }),
    );
    return combatDirectorView(s);
  };
  app.post("/start", async (req, reply) => {
    const parsed = z
      .object({
        chatId: key,
        anchor: key,
        style: z.enum(["classic", "tactical"]),
        party: z.array(directedCombatantSchema).min(1).max(20),
        enemies: z.array(directedCombatantSchema).min(1).max(20),
        environment: z.string().max(80).optional(),
        formation: z.string().max(80).optional(),
        battlefield: z.unknown().optional(),
        mechanics: z
          .array(
            z.object({
              name: key,
              description: z.string().max(3000),
              ownerName: z.string().max(200).optional(),
              trigger: z.enum(["round_interval", "hp_threshold", "on_hit", "on_attack", "passive"]),
              interval: z.number().int().min(1).max(100).optional(),
              hpThreshold: z.number().min(0).max(100).optional(),
              counterplay: z.string().max(3000).optional(),
              effectType: z
                .enum(["damage_all", "damage_one", "buff_self", "debuff_party", "status_party", "status_enemy"])
                .optional(),
              power: num.max(20).optional(),
              element: z.string().max(100).optional(),
              status: itemEffect.shape.status,
            }),
          )
          .max(32)
          .default([]),
        itemEffects: z.array(itemEffect).max(200).default([]),
        inventory: z
          .array(
            z.object({
              name: z.string().max(200),
              quantity: z.number().int().min(0).max(10000),
              description: z.string().max(2000).optional(),
            }),
          )
          .max(200)
          .default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const input = parsed.data;
    try {
      return await serialized(input.chatId, async () => {
        const chat = await chats.getById(input.chatId);
        if (!chat) return reply.code(404).send({ error: "Chat not found." });
        const anchor = await chats.getMessage(input.anchor);
        if (!anchor || anchor.chatId !== input.chatId)
          return reply.code(400).send({ error: "Battle anchor is not in this chat." });
        const existing = await load(input.chatId, input.anchor);
        if (existing) return { session: combatDirectorView(existing.state) };
        const meta = JSON.parse(chat.metadata || "{}"),
          setup = meta.gameSetupConfig ?? {};
        if (setup.combatDirector !== true)
          return reply.code(400).send({ error: "Directed combat is not enabled for this game." });
        const all = [...input.party, ...input.enemies];
        if (
          new Set(all.map((u) => u.id)).size !== all.length ||
          input.party.some((u) => u.side !== "player") ||
          input.enemies.some((u) => u.side !== "enemy")
        )
          return reply.code(400).send({ error: "Invalid combat sides or duplicate units." });
        const battlefield = resolveTacticalStartPreferences({
          setup: setup.tacticalBattlefield,
          requestSeed: undefined,
          requestBattlefield: input.battlefield,
          randomSeed: () => Math.floor(Math.random() * 0x100000000),
        });
        if (!battlefield.ok) throw new Error(battlefield.error);
        let checkpointRestore = false;
        try {
          checkpointRestore =
            anchor.role === "system" && JSON.parse(anchor.extra || "{}")?.gameStateAnchor === "checkpoint_restore";
        } catch {
          // Legacy malformed extras do not identify a checkpoint restore.
        }
        const committedWeather = (await createGameStateStorage(app.db).getLatestCommitted(input.chatId))?.weather;
        // Restores rewind the committed scene without rewinding campaign metadata.
        // Fresh starts still prefer metadata, which may be newer than the accepted scene.
        const weatherSource = checkpointRestore
          ? (committedWeather ?? meta.gameWeather)
          : (meta.gameWeather ?? committedWeather);
        const state = createCombatDirector({
          ...input,
          inventory: Array.isArray(meta.gameInventory) ? meta.gameInventory : [],
          party: input.party as Combatant[],
          enemies: input.enemies as Combatant[],
          id: randomUUID(),
          gm: setup.gmBossControl === true,
          difficulty: normalizeGameDifficulty(setup.difficulty),
          weather: resolveCombatWeather(weatherSource, input.environment, battlefield.battlefield?.exposure),
          seed: battlefield.seed,
          battlefield: battlefield.battlefield,
        });
        const rowId = await store.create({
          chatId: input.chatId,
          messageId: input.anchor,
          swipeIndex: 0,
          gameType: COMBAT_DIRECTOR_NAMESPACE,
          schemaVersion: 1,
          state: JSON.stringify(state),
          committed: true,
        });
        state.instanceId = rowId;
        return { session: combatDirectorView(state) };
      });
    } catch (err) {
      logger.warn(err, "Unable to start directed combat");
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid combat request." });
    }
  });
  app.get("/state", async (req, reply) => {
    const parsed = z.object({ chatId: key, anchor: key }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { chatId, anchor } = parsed.data;
    try {
      const found = await load(chatId, anchor);
      return found
        ? { session: combatDirectorView(found.state) }
        : reply.code(404).send({ error: "Battle not found." });
    } catch (err) {
      logger.warn(err, "Unable to load directed combat");
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid combat save." });
    }
  });
  app.post("/command", async (req, reply) => {
    const parsed = z
      .object({
        chatId: key,
        anchor: key,
        id: key,
        instanceId: key,
        revision: z.number().int().min(0),
        requestId: key,
        command,
        debugMode: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const input = parsed.data;
    try {
      const result = await serialized(input.chatId, async () => {
        const found = await load(input.chatId, input.anchor);
        if (!found) throw new Error("Battle not found.");
        const { row, state } = found;
        if (state.id !== input.id) throw new Error("Battle changed. Reload its current state.");
        if (state.instanceId !== input.instanceId) return { session: combatDirectorView(state) };
        if (state.requests.includes(input.requestId)) return { session: combatDirectorView(state) };
        if (state.revision !== input.revision) return { session: combatDirectorView(state) };
        const w = state.window;
        if (input.command.type === "continue" && w?.controller === "gm") {
          if (w.requestedAt && Date.now() - w.requestedAt < 12000) return { session: combatDirectorView(state) };
          if (w.requestedAt || state.gmCalls >= 12) {
            commandCombatDirector(state, { type: "fallback" });
            state.requests = [...state.requests, input.requestId].slice(-256);
            return { session: await save(row.id, input.chatId, state) };
          }
          w.requestedAt = Date.now();
          state.gmCalls++;
          await save(row.id, input.chatId, state);
          return { job: { rowId: row.id, state: structuredClone(state), windowId: w.id, revision: state.revision } };
        }
        if (input.command.type === "fallback" && w?.controller !== "gm")
          throw new Error("Only GM decisions use the fallback controller.");
        if (input.command.type === "choose" && w?.controller !== "manual")
          throw new Error("This decision belongs to the boss controller.");
        commandCombatDirector(state, input.command as DirectedCommand);
        state.requests = [...state.requests, input.requestId].slice(-256);
        return { session: await save(row.id, input.chatId, state) };
      });
      if ("session" in result) return result;
      const job = result.job;
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let candidateId: string | undefined;
      try {
        candidateId = await Promise.race([
          (options.chooseBoss ?? chooseGmCombatOption)(
            app.db,
            input.chatId,
            job.state,
            input.debugMode === true,
            abort.signal,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error("Boss decision timed out."));
            }, 10000);
          }),
        ]);
      } catch (err) {
        logger.warn(err, "Boss decision uses local fallback for chat %s", input.chatId);
      } finally {
        if (timer) clearTimeout(timer);
        abort.abort();
      }
      return await serialized(input.chatId, async () => {
        const current = await load(input.chatId, input.anchor);
        if (!current) throw new Error("Battle no longer exists.");
        // Row identity changes on checkpoint restore/branch; never apply a response from the old lineage.
        if (
          current.row.id !== job.rowId ||
          current.state.revision !== job.revision ||
          current.state.window?.id !== job.windowId
        )
          return { session: combatDirectorView(current.state) };
        commandCombatDirector(
          current.state,
          candidateId ? { type: "choose", candidateId } : { type: "fallback" },
          candidateId ? "gm" : "fallback",
        );
        current.state.requests = [...current.state.requests, input.requestId].slice(-256);
        return { session: await save(current.row.id, input.chatId, current.state) };
      });
    } catch (err) {
      logger.warn(err, "Directed combat command rejected");
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid combat action." });
    }
  });
}
