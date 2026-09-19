import type { CombatWeather } from "./combat-conditions.js";
import { z } from "zod";
import type { Combatant, CombatPlayerAction, CombatSummary } from "../types/game.js";
import type { TacticalAction, TacticalCombatState } from "./tactical-combat/types.js";

/** Explicit capabilities: names and prose never grant interrupts or boss privileges. */
export const combatBossSchema = z.object({
  points: z.number().int().min(0).max(6),
  anticipation: z.boolean().default(true),
  attackCost: z.number().int().min(1).max(6).optional(),
  defendCost: z.number().int().min(1).max(6).optional(),
  moveCost: z.number().int().min(1).max(6).optional(),
});
export type CombatBoss = z.infer<typeof combatBossSchema>;
export const combatInterruptFields = {
  projectile: z.boolean().optional(),
  requiresSight: z.boolean().optional(),
  spell: z.boolean().optional(),
  areaRadius: z.number().int().min(0).max(3).optional(),
  friendlyFire: z.boolean().optional(),
  targetScope: z.enum(["single", "all-enemies"]).optional(),
  reaction: z.enum(["counterspell", "guard"]).optional(),
  range: z.number().int().min(1).max(12).optional(),
  slotLevel: z.number().int().min(1).max(9).optional(),
  legendaryCost: z.number().int().min(1).max(6).optional(),
};
export type DirectedCommand =
  | { type: "begin"; unitId: string }
  | { type: "classic"; action: CombatPlayerAction }
  | { type: "tactical"; action: TacticalAction }
  | { type: "choose"; candidateId: string }
  | { type: "continue" }
  | { type: "fallback" }
  | { type: "control"; unitId: string; controller: "manual" | "ai" }
  | { type: "flee" };
export interface CombatDecisionOption {
  id: string;
  kind: "attack" | "skill" | "move" | "defend" | "wait" | "pass";
  actorId: string;
  targetId?: string;
  skillName?: string;
  to?: { x: number; y: number };
  mpCost: number;
  slotLevel?: number;
  legendaryCost: number;
}
export interface CombatDecisionWindow {
  id: string;
  kind: "ordinary" | "anticipation" | "legendary" | "reaction";
  actorId: string;
  triggerActorId?: string;
  triggerSkillName?: string;
  controller: "gm" | "manual";
  options: CombatDecisionOption[];
  requestedAt?: number;
}
/** Optional on old snapshots; text remains the fallback and GM narration source. */
export interface CombatLogMessage {
  key: string;
  suffixKey?: string;
  params?: Record<string, string | number>;
}
export interface DirectedCombatView {
  weather?: CombatWeather;
  id: string;
  /** Storage row identity changes when a checkpoint is restored or a battle is branched. */
  instanceId?: string;
  revision: number;
  style: "classic" | "tactical";
  round: number;
  stage: "select" | "action" | "decision" | "finished";
  actorId?: string;
  party: Combatant[];
  enemies: Combatant[];
  inventory: Array<{ name: string; quantity: number; description?: string }>;
  tactical?: TacticalCombatState;
  window?: CombatDecisionWindow;
  budgets: Record<string, { legendary: number; reaction: number }>;
  log: Array<{
    id: number;
    actorId?: string;
    kind: string;
    text: string;
    message?: CombatLogMessage;
    source?: "gm" | "ai" | "manual" | "fallback";
  }>;
  outcome?: "victory" | "defeat" | "flee";
  summary?: CombatSummary;
}
