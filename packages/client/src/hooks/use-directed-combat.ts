import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Combatant,
  CombatItemEffect,
  CombatMechanic,
  TacticalBattlefieldBrief,
  DirectedCommand,
  DirectedCombatView,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { chatKeys } from "./use-chats";
import { useUIStore } from "../stores/ui.store";

export function useDirectedCombat(input: {
  chatId: string;
  anchor: string;
  style: "classic" | "tactical";
  party: Combatant[];
  enemies: Combatant[];
  environment?: string;
  formation?: string;
  battlefield?: TacticalBattlefieldBrief;
  mechanics?: CombatMechanic[];
  inventory?: Array<{ name: string; quantity: number }>;
  itemEffects?: CombatItemEffect[];
}) {
  const qc = useQueryClient();
  const initial = useRef(input);
  initial.current = input;
  const key = ["directed-combat", input.chatId, input.anchor];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await api.post<{ session: DirectedCombatView }>("/game/combat/director/start", initial.current);
      return result.session;
    },
    staleTime: 0,
    retry: false,
  });
  const mutate = useMutation({
    mutationFn: async (command: DirectedCommand) => {
      const current = qc.getQueryData<DirectedCombatView>(key);
      if (!current) throw new Error("Battle has not loaded.");
      const result = await api.post<{ session: DirectedCombatView }>("/game/combat/director/command", {
        chatId: input.chatId,
        anchor: input.anchor,
        id: current.id,
        instanceId: current.instanceId,
        revision: current.revision,
        requestId: crypto.randomUUID(),
        command,
        debugMode: useUIStore.getState().debugMode,
      });
      return result.session;
    },
    onSuccess: (session) => {
      void qc.invalidateQueries({ queryKey: chatKeys.detail(input.chatId) });
      qc.setQueryData<DirectedCombatView>(key, (current) =>
        !current ||
        current.id !== session.id ||
        current.instanceId !== session.instanceId ||
        session.revision >= current.revision
          ? session
          : current,
      );
    },
  });
  const send = mutate.mutate;
  useEffect(() => {
    if (!query.data?.window || query.data.window.controller !== "gm" || mutate.isPending || mutate.isError) return;
    const timer = setTimeout(() => send({ type: "continue" }), query.data.window.requestedAt ? 1200 : 0);
    return () => clearTimeout(timer);
  }, [query.data, mutate.isPending, mutate.isError, send]);
  return {
    session: query.data,
    error: query.error ?? mutate.error,
    loading: query.isPending,
    busy: mutate.isPending,
    send,
    refresh: () => {
      mutate.reset();
      return query.refetch();
    },
  };
}
