import { getMovementRange } from "../packages/shared/src/index.js";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import type { DirectedCombatView, DirectedCommand } from "../packages/shared/src/features/combat-director.js";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
for (const mode of ["classic", "tactical"] as const) {
  test(`Combat director ${mode}: manual reaction survives reload and spends once`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120000);
    const counter = {
      id: "counter",
      name: "Unweave",
      type: "debuff",
      power: 0,
      mpCost: 6,
      reaction: "counterspell",
      spell: true,
      range: 12,
      slotLevel: 3,
    };
    const hero = {
      movementMode: "fly",
      id: "Hero",
      name: "Hero",
      side: "player",
      hp: 500,
      maxHp: 500,
      mp: 30,
      maxMp: 30,
      attack: 80,
      defense: 5,
      speed: 10000,
      level: 5,
      spellSlots: { "3": 1 },
      skills: [{ id: "fire", name: "Fireball", type: "attack", power: 2, mpCost: 8, spell: true, range: 12 }, counter],
    };
    const boss = {
      id: "Boss",
      name: "Boss",
      side: "enemy",
      hp: 100,
      maxHp: 100,
      mp: 30,
      maxMp: 30,
      attack: 2,
      defense: 5,
      speed: 1,
      level: 5,
      boss: { points: 0, anticipation: false },
      skills: [{ ...counter, slotLevel: undefined }],
    };
    const created = await request.post("/api/game/create", {
      data: {
        name: `Director ${mode}`,
        setupConfig: {
          genre: "Fantasy",
          setting: "Ruins",
          tone: "Adventure",
          difficulty: "normal",
          playerGoals: "Hold",
          gmMode: "standalone",
          rating: "sfw",
          partyCharacterIds: [],
          combatStyle: mode,
          combatDirector: true,
          gmBossControl: true,
          tacticalBattlefield: { seed: 9, size: "small" },
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const chatId = (await created.json()).sessionChat.id;
    try {
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "A mage faces the boss. [state: combat]" },
      });
      const anchor = (await message.json()).id;
      const weatherPatch = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: { gameWeather: { type: "storm", wind: "gale", visibility: "poor" } },
      });
      expect(weatherPatch.ok(), await weatherPatch.text()).toBeTruthy();
      const input = {
        chatId,
        anchor,
        style: mode,
        party: [hero],
        enemies: [boss],
        battlefield: { exposure: "exposed" },
        formation: "surrounded",
      };
      const start = await request.post("/api/game/combat/director/start", { data: input });
      expect(start.ok(), await start.text()).toBeTruthy();
      let s: DirectedCombatView = (await start.json()).session;
      const command = async (command: DirectedCommand) => {
        const result = await request.post("/api/game/combat/director/command", {
          data: {
            chatId,
            anchor,
            id: s.id,
            instanceId: s.instanceId,
            revision: s.revision,
            requestId: crypto.randomUUID(),
            command,
          },
        });
        expect(result.ok(), await result.text()).toBeTruthy();
        s = (await result.json()).session;
      };
      if (mode === "tactical") {
        await command({ type: "begin", unitId: "Hero" });
        const caster = s.tactical!.units.find((u) => u.id === "Hero")!;
        const target = s.tactical!.units.find((u) => u.id === "Boss")!;
        // New encounters have individual seeds. Move beside the boss so this
        // reaction fixture does not depend on random walls blocking the initial ray.
        if (Math.abs(caster.x - target.x) + Math.abs(caster.y - target.y) > 1) {
          const to = getMovementRange(s.tactical!, "Hero").find(
            (tile) => Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) === 1,
          );
          expect(to, "A flying caster can approach the surrounded encounter's nearby boss").toBeDefined();
          await command({ type: "tactical", action: { type: "move", unitId: "Hero", to: to! } });
        }
      }
      await command(
        mode === "classic"
          ? { type: "classic", action: { type: "skill", skillId: "fire", targetId: "Boss" } }
          : { type: "tactical", action: { type: "skill", unitId: "Hero", skillName: "Fireball", targetId: "Boss" } },
      );
      expect(s.window?.actorId).toBe("Boss");
      await command({ type: "fallback" });
      expect(s.window?.controller).toBe("manual");
      expect(s.window?.actorId).toBe("Hero");
      const patch = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameActiveState: "combat",
          gameImageAutoGenerationEnabled: false,
          gameStoryboardAutoIllustrationsEnabled: false,
          gameCombatStyle: mode,
          gameCombatState: {
            party: [hero],
            enemies: [boss],
            itemEffects: [],
            mechanics: [],
            dialogueCues: [],
            startMessageId: anchor,
            combatStyle: mode,
          },
        },
      });
      expect(patch.ok(), await patch.text()).toBeTruthy();
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["game"],
        gameInstantTextReveal: true,
        weatherEffects: false,
        theme: testInfo.project.name.includes("desktop") ? "light" : "dark",
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: chatId, version },
      );
      await page.goto("/");
      const conditions = page.getByLabel("Combat conditions", { exact: true });
      await expect(conditions).toContainText("Storm");
      await expect(conditions).toContainText("Fire damage −15%; lightning damage +15%");
      await expect(conditions).toContainText(
        mode === "tactical" ? "Projectile accuracy −15 points" : "Projectile attack rolls −3",
      );
      const choices = page.getByRole("region", { name: "Combat decisions" });
      await expect(choices).toBeVisible({ timeout: 40000 });
      const react = choices.getByRole("button", { name: /Unweave.*Level 3 slot/ });
      await expect(react).toBeVisible();
      await expect(choices.getByRole("button", { name: "Pass", exact: true })).toBeVisible();
      await page.reload();
      await expect(react).toBeVisible({ timeout: 40000 });
      await expect(react).toBeFocused();
      await expect(conditions).toContainText("Storm");
      // Change a catalog entry to prove saved events are localized at render time after reload.
      await page.evaluate(async () => {
        const { i18n } = (await import("/src/localization/i18n.ts" as string)) as PageI18nModule;
        i18n.addResource(
          "en",
          "translation",
          "game.combat.event.beginSkill",
          "Translated event: {{actor}} begins {{skill}}.",
        );
        await i18n.changeLanguage("en");
      });
      await choices.getByText("Recent combat events", { exact: true }).click();
      await expect(choices.getByText(/^Translated event: .*Fireball\.$/)).toBeVisible();

      await react.click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`${mode}-reaction.png`), fullPage: true });
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/game/combat/director/command") && r.request().postDataJSON().command.type === "choose",
      );
      await react.click();
      const result = await response;
      expect(result.ok(), await result.text()).toBeTruthy();
      const accepted: DirectedCombatView = (await result.json()).session;
      expect(accepted.party[0]!.spellSlots!["3"]).toBe(0);
      expect(accepted.party[0]!.mp).toBe(22);
      // Reload cannot reopen the accepted counter or charge its last spell slot again.
      await page.reload();
      await expect(choices).toBeVisible({ timeout: 40000 });
      await expect(react).toHaveCount(0);
      const persisted = await request.get(`/api/game/combat/director/state?chatId=${chatId}&anchor=${anchor}`);
      expect((await persisted.json()).session.party[0].spellSlots["3"]).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    } finally {
      await request.delete(`/api/chats/${chatId}`);
    }
  });
}
