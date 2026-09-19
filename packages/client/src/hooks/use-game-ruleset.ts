// The ruleset a game pinned at creation, resolved against what is installed here.
//
// The match is the server's (`resolveGameRuleset`): same id AND same supplying package, and an
// installed definition at least as new as the pin. An id another package now claims is another
// ruleset, and resolving to it would silently change the game's arithmetic — which is the one
// thing the pin exists to prevent. A game with no pin resolves to nothing at all, so it keeps
// today's behaviour byte for byte.
//
// An IMPORTED ruleset keeps every version it was imported at, and the server resolves the exact
// one the game pinned. The installed list only carries the newest, so when the pin names an older
// stored version that definition is fetched on its own: the sheet on screen has to be the one the
// server does its arithmetic with.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  rulesetRefSchema,
  type InstalledRuleset,
  type RulesetDefinition,
  type RulesetRef,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { capabilityPackageKeys, useInstalledRulesets } from "./use-capability-packages";

export type ResolvedGameRulesetClient =
  | { status: "none" }
  | { status: "loading"; ref: RulesetRef }
  | { status: "ok"; ref: RulesetRef; definition: RulesetDefinition }
  /** The pin cannot be honoured here: unreadable, not installed, another package's, or older. */
  | { status: "unavailable"; ref: RulesetRef | null };

/** Resolve `chat.metadata.gameRuleset`. The installed list is only queried when a pin exists. */
export function useGameRuleset(chatMeta: Record<string, unknown> | null | undefined): ResolvedGameRulesetClient {
  const pin = chatMeta?.gameRuleset;
  const hasPin = pin !== undefined && pin !== null;
  const ref = useMemo(() => {
    if (!hasPin) return null;
    const parsed = rulesetRefSchema.safeParse(pin);
    return parsed.success ? parsed.data : null;
  }, [hasPin, pin]);

  const installed = useInstalledRulesets(hasPin);
  const rulesets = installed.data;
  const isSuccess = installed.isSuccess;
  const isError = installed.isError;

  const match = ref
    ? (rulesets ?? []).find((entry) => entry.definition.id === ref.id && entry.packageId === ref.packageId)
    : undefined;
  // Only an imported ruleset lists `versions`. The newest one is already in hand; any other stored
  // version is asked for, and a version that is not stored is simply unavailable.
  const needsExactVersion = Boolean(
    ref && match?.versions && match.definition.version !== ref.version && match.versions.includes(ref.version),
  );
  const exact = useQuery({
    queryKey: [...capabilityPackageKeys.rulesets(), "version", ref?.id, ref?.version],
    queryFn: () =>
      api.get<InstalledRuleset>(
        `/capability-packages/rulesets/version?rulesetId=${encodeURIComponent(ref!.id)}&version=${ref!.version}`,
      ),
    enabled: needsExactVersion,
  });
  const exactDefinition = exact.data?.definition;
  const exactFailed = exact.isError;

  return useMemo<ResolvedGameRulesetClient>(() => {
    if (!hasPin) return { status: "none" };
    if (!ref) return { status: "unavailable", ref: null };
    // A failed lookup says nothing about what is installed, but the consequence for this game is
    // the same one `unavailable` describes: nothing here can read the ruleset, so the sheet stays
    // read-only rather than pretending the game has no rules.
    if (isError) return { status: "unavailable", ref };
    if (!isSuccess) return { status: "loading", ref };
    if (!match) return { status: "unavailable", ref };
    if (match.versions) {
      // Imported: the exact pinned version or nothing, like the server.
      if (match.definition.version === ref.version) return { status: "ok", ref, definition: match.definition };
      if (!match.versions.includes(ref.version) || exactFailed) return { status: "unavailable", ref };
      return exactDefinition ? { status: "ok", ref, definition: exactDefinition } : { status: "loading", ref };
    }
    // A NEWER installed package definition is fine — sheets are read tolerantly against the current
    // schema. An OLDER one is not: the game may depend on something it does not declare.
    if (match.definition.version < ref.version) return { status: "unavailable", ref };
    return { status: "ok", ref, definition: match.definition };
  }, [exactDefinition, exactFailed, hasPin, isError, isSuccess, match, ref]);
}
