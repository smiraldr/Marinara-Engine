import { CombatWeatherSummary } from "./CombatWeatherSummary";
import { useEffect, useRef, type ComponentProps } from "react";
import type { CombatDecisionOption, TacticalBattlefieldBrief } from "@marinara-engine/shared";
import { useTranslation } from "react-i18next";
import { useDirectedCombat } from "../../hooks/use-directed-combat";
import { GameCombatUI } from "./GameCombatUI";
import { TacticalCombatUI } from "./TacticalCombatUI";

type Props = ComponentProps<typeof GameCombatUI> & {
  anchor: string;
  style: "classic" | "tactical";
  environment?: string;
  formation?: string;
  battlefield?: TacticalBattlefieldBrief;
};
export function DirectedCombatUI(props: Props) {
  const { t } = useTranslation();
  const {
    session: s,
    error,
    loading,
    busy,
    send,
    refresh,
  } = useDirectedCombat({
    chatId: props.chatId,
    anchor: props.anchor,
    style: props.style,
    party: props.party,
    enemies: props.enemies,
    environment: props.environment,
    formation: props.formation,
    battlefield: props.battlefield,
    mechanics: props.combatMechanics,
    inventory: props.inventoryItems,
    itemEffects: props.combatItemEffects,
  });
  const firstChoice = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (s?.window?.controller === "manual") firstChoice.current?.focus();
  }, [s?.window?.id, s?.window?.controller]);
  if (loading || !s)
    return (
      <div className="flex h-full items-center justify-center p-4 text-[var(--foreground)]" role="status">
        {error ? t("game.combat.director.error") : t("game.combat.director.loading")}
        {error && (
          <button onClick={() => void refresh()} className="ml-3 min-h-11 px-3">
            {t("game.combat.director.retry")}
          </button>
        )}
      </div>
    );
  const name = (id?: string) => [...s.party, ...s.enemies].find((u) => u.id === id)?.name ?? "";
  const label = (c: CombatDecisionOption) =>
    t(`game.combat.director.option.${c.kind}`, {
      skill: c.skillName ?? "",
      target: name(c.targetId),
      x: c.to?.x ?? 0,
      y: c.to?.y ?? 0,
    });
  const finish = () => {
    if (s.summary) props.onCombatEnd(s.summary.outcome, s.summary);
    else send({ type: "flee" });
  };
  const canAct = s.stage === "action" && !s.window && !busy;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {s.style === "tactical" && s.tactical ? (
          <TacticalCombatUI
            chatId={props.chatId}
            party={s.party}
            enemies={s.enemies}
            initialState={s.tactical}
            onCombatEnd={finish}
            directed={{
              state: s.tactical,
              items: s.inventory.flatMap((item) => {
                const effect = props.combatItemEffects?.find((effect) => effect.name === item.name);
                return effect && item.quantity > 0 ? [{ ...item, effect }] : [];
              }),
              actorId: s.actorId,
              canAct,
              busy: busy || !!s.window,
              onAction: (action) =>
                send(
                  action.type === "flee"
                    ? { type: "flee" }
                    : action.type === "control"
                      ? { type: "control", unitId: action.unitId, controller: action.controller }
                      : { type: "tactical", action },
                ),
            }}
          />
        ) : (
          <GameCombatUI
            {...props}
            party={s.party}
            enemies={s.enemies}
            inventoryItems={s.inventory}
            onCombatEnd={finish}
            directed={{
              actorId: s.actorId,
              canAct,
              round: s.round,
              outcome: s.outcome,
              onAction: (action) => send(action.type === "flee" ? { type: "flee" } : { type: "classic", action }),
              onControl: (unitId, controller) => send({ type: "control", unitId, controller }),
            }}
          />
        )}
      </div>
      <CombatWeatherSummary weather={s.weather} tactical={s.style === "tactical"} />
      <section
        aria-label={t("game.combat.director.title")}
        className="max-h-[42svh] shrink-0 overflow-y-auto border-t border-[var(--border)] bg-[var(--background)] p-3 text-sm text-[var(--foreground)]"
      >
        {error && (
          <div role="alert" className="mb-2 text-[var(--destructive)]">
            {t("game.combat.director.error")}{" "}
            <button className="min-h-11 px-3 underline" onClick={() => void refresh()}>
              {t("game.combat.director.retry")}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--muted-foreground)]">
          {s.enemies
            .filter((u) => u.boss)
            .map((u) => (
              <span key={u.id}>
                {t("game.combat.director.budget", {
                  name: u.name,
                  points: s.budgets[u.id]?.legendary ?? 0,
                  max: u.boss!.points,
                })}
              </span>
            ))}
          {s.party
            .filter((u) => u.hp > 0 && u.skills?.some((k) => k.reaction))
            .map((u) => (
              <span key={u.id}>
                {t("game.combat.director.reactions", { name: u.name, count: s.budgets[u.id]?.reaction ?? 0 })}
              </span>
            ))}
          {s.actorId && <span>{t("game.combat.director.active", { name: name(s.actorId) })}</span>}
        </div>
        {s.stage === "select" && s.style === "classic" && (
          <button
            disabled={busy}
            className="mt-2 min-h-11 rounded-md bg-[var(--secondary)] px-3"
            onClick={() => send({ type: "continue" })}
          >
            {t("game.combat.director.waitRound")}
          </button>
        )}
        {s.stage === "select" && s.style === "tactical" && !busy && (
          <div className="mt-2 flex flex-wrap gap-2">
            <p className="w-full text-xs text-[var(--muted-foreground)]">{t("game.combat.director.beginHint")}</p>
            {s.party
              .filter(
                (u) =>
                  u.hp > 0 &&
                  !s.tactical?.units.find((tu) => tu.id === u.id)?.hasActed &&
                  u.speed +
                    (u.statusEffects ?? [])
                      .filter((e) => e.stat === "speed" && e.turnsLeft > 0)
                      .reduce((n, e) => n + e.modifier, 0) >
                    0 &&
                  !(u.statusEffects ?? []).some(
                    (e) =>
                      e.turnsLeft > 0 &&
                      /^(frozen|stun|stunned|imprisoned|paralyzed|incapacitated|sleep|asleep)$/i.test(e.name.trim()),
                  ),
              )
              .map((u) => (
                <button
                  key={u.id}
                  className="min-h-11 rounded-md bg-[var(--secondary)] px-3 focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                  onClick={() => send({ type: "begin", unitId: u.id })}
                >
                  {t("game.combat.director.begin", { name: u.name })}
                </button>
              ))}
          </div>
        )}
        {s.window && (
          <div className="mt-2" aria-live="polite">
            <p className="font-medium">
              {t(`game.combat.director.window.${s.window.kind}`, {
                name: name(s.window.actorId),
                trigger: name(s.window.triggerActorId),
                skill: s.window.triggerSkillName ?? "",
              })}
            </p>
            {s.window.controller === "gm" ? (
              <div className="mt-2 flex items-center gap-3">
                <span role="status">{t("game.combat.director.thinking")}</span>
                <button
                  className="min-h-11 rounded-md border border-[var(--border)] px-3"
                  onClick={() => send({ type: "fallback" })}
                >
                  {t("game.combat.director.fallback")}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {s.window.options.map((c, i) => (
                  <button
                    ref={i === 0 ? firstChoice : undefined}
                    key={c.id}
                    disabled={busy}
                    onClick={() => send({ type: "choose", candidateId: c.id })}
                    className="min-h-11 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-left disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                  >
                    <span>{label(c)}</span>
                    {c.kind !== "pass" && (
                      <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                        {c.slotLevel
                          ? t("game.combat.director.slotCost", { level: c.slotLevel })
                          : t("game.combat.director.mpCost", { amount: c.mpCost })}{" "}
                        · {t("game.combat.director.reactionCost")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {s.log.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer py-1">{t("game.combat.director.events")}</summary>
            <ol className="mt-1 space-y-1 text-xs text-[var(--muted-foreground)]">
              {s.log.slice(-12).map((e) => (
                <li key={e.id}>
                  {e.message ? t(e.message.key, { ...e.message.params, defaultValue: e.text }) : e.text}
                  {e.message?.suffixKey && ` ${t(e.message.suffixKey)}`}
                  {e.source === "fallback" && ` (${t("game.combat.director.fallbackUsed")})`}
                </li>
              ))}
            </ol>
          </details>
        )}
        {s.outcome && (
          <button
            className="mt-2 min-h-11 rounded-md bg-[var(--primary)] px-4 text-[var(--primary-foreground)]"
            onClick={finish}
          >
            {t("game.combat.director.finish")}
          </button>
        )}
      </section>
    </div>
  );
}
