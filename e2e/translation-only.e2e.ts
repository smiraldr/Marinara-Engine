import { expect, test, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const mode of ["roleplay", "conversation", "game"] as const) {
  test(`${mode}: automatic translation replaces the original only while its source matches`, async ({
    page,
    request,
    isMobile,
  }, info) => {
    page.setDefaultTimeout(10_000);
    const paths: string[] = [];
    const create = async (path: string, data: unknown) => {
      const response = await request.post(path, { data });
      expect(response.ok(), await response.text()).toBeTruthy();
      const value = await response.json();
      paths.unshift(`${path}/${value.id}`);
      return value;
    };
    try {
      const character = await create("/api/characters", { data: { name: "Alice", first_mes: "" } });
      const connection = await create("/api/connections", {
        name: "Translation display fixture",
        provider: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "synthetic-fixture",
        model: "fixture",
        treatAsLocalEndpoint: true,
      });
      const chat = await create("/api/chats", {
        name: "Translation display",
        mode,
        characterIds: [character.id],
        connectionId: connection.id,
      });
      await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: {
          enableAgents: false,
          enableTools: false,
          autoTranslate: true,
          translationDisplayOnly: true,
          translationProvider: "google",
          translationOutputTargetLang: "pl",
          ...(mode === "game"
            ? {
                gameId: chat.id,
                gameSessionStatus: "active",
                gameIntroPresented: true,
                gameImageAutoGenerationEnabled: false,
              }
            : {}),
        },
      });
      const initialSource = 'The archive is quiet.\n\n"Let us begin," Alice says.';
      let source = initialSource;
      let translated = 'W archiwum panuje cisza.\n\n"Zacznijmy", mówi Alice.';
      let saved: { id: string } | undefined;
      let generationCount = 0;
      let holdTranslation = false;
      let pendingTranslation: Route | undefined;
      let holdPersistence = false;
      let pendingPersistence: Route | undefined;
      await page.route(`**/api/chats/${chat.id}/messages/*/extra`, async (route) => {
        if (holdPersistence) pendingPersistence = route;
        else await route.continue();
      });
      await page.route("**/api/generate", async (route) => {
        const regenerateId = route.request().postDataJSON().regenerateMessageId;
        const response = regenerateId
          ? await request.patch(`/api/chats/${chat.id}/messages/${regenerateId}`, { data: { content: source } })
          : await request.post(`/api/chats/${chat.id}/messages`, {
              data: { role: "assistant", characterId: character.id, content: source },
            });
        expect(response.ok(), await response.text()).toBeTruthy();
        const message = await response.json();
        saved = message;
        generationCount += 1;
        await route.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "token", data: source },
            { type: "message_saved", data: message },
            { type: "done", data: {} },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
      });
      await page.route("**/api/translate", async (route) => {
        expect(route.request().postDataJSON().text).toBe(source);
        if (holdTranslation) {
          pendingTranslation = route;
          return;
        }
        await route.fulfill({ json: { translatedText: translated } });
      });
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["roleplay", "conversation", "game"],
        streamingSpeed: 100,
        gameInstantTextReveal: true,
        enterToSendRP: true,
        enterToSendConvo: true,
        theme: info.project.name === "desktop-chromium" ? "light" : "dark",
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: chat.id, version },
      );
      await page.goto("/");
      const composer =
        mode === "game"
          ? page.getByRole("textbox", { name: "What do you do?", exact: true })
          : page.locator("textarea[data-chat-composer]");
      await composer.fill("Begin the scene.");
      if (mode === "game") await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      else await composer.press("Enter");
      await expect.poll(() => saved?.id).toBeTruthy();
      const otherChat = await create("/api/chats", {
        name: "Other conversation",
        mode: "roleplay",
        characterIds: [character.id],
        connectionId: connection.id,
      });
      // Desktop detail navigation unmounts ChatArea. Switching chats through it
      // must reset the shared translation state just like an ordinary chat switch.
      const switchThroughEditor = async (id: string) => {
        await page.evaluate(async (connectionId) => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().openConnectionDetail(connectionId);
        }, connection.id);
        await expect(page.getByPlaceholder("Connection name")).toBeVisible();
        await page.evaluate(async (chatId) => {
          const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
          useChatStore.getState().setActiveChatId(chatId);
        }, id);
        await page.evaluate(async () => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().closeConnectionDetail();
        });
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const { useTranslationStore } = await import("/src/stores/translation.store.ts" as string);
              return useTranslationStore.getState().config.chatId;
            }),
          )
          .toBe(id);
      };
      const row =
        mode === "game"
          ? page.locator('[data-component="GameNarration.ActivePanel"]')
          : page.locator(`[data-message-id="${saved!.id}"]`).first();
      await expect(row).toContainText(mode === "game" ? "W archiwum panuje cisza" : "Zacznijmy");
      await page.screenshot({ path: info.outputPath("translation-only.png") });
      await expect(row).not.toContainText("Let us begin");
      if (mode !== "game") await expect(row).not.toContainText("The archive is quiet");
      const extra = async () => {
        const messages = await (await request.get(`/api/chats/${chat.id}/messages`)).json();
        const value = messages.find((message: { id: string }) => message.id === saved!.id).extra;
        return typeof value === "string" ? JSON.parse(value) : value;
      };
      await expect.poll(async () => (await extra()).translationSource).toBe(source);
      await page.reload();
      await expect(row).toContainText(mode === "game" ? "W archiwum panuje cisza" : "Zacznijmy");
      await expect(row).not.toContainText("Let us begin");
      await expect(row).not.toContainText(initialSource.split("\n")[0]!);
      if (mode !== "game") {
        const regenerate = async () => {
          const action = row.getByRole("button", { name: "Regenerate", exact: true });
          if (isMobile) {
            // Use touch input and keep an already revealed action bar open.
            if (!(await action.isVisible())) await row.tap();
            await action.tap();
            await page.getByRole("dialog").getByRole("button", { name: "Regenerate", exact: true }).tap();
          } else {
            await row.hover();
            await action.click();
          }
        };
        source = "The door opens for a new experiment.";
        translated = "Drzwi otwierają się na nowy eksperyment.";
        holdTranslation = true;
        await regenerate();
        await expect.poll(() => generationCount).toBe(2);
        await expect.poll(() => Boolean(pendingTranslation)).toBe(true);
        await switchThroughEditor(otherChat.id);
        holdPersistence = true;
        await pendingTranslation!.fulfill({ json: { translatedText: translated } });
        await expect.poll(() => Boolean(pendingPersistence)).toBe(true);
        // Return after the background response, before its persisted extras arrive.
        // The old translation is seeded on return and must not mask the new one.
        await switchThroughEditor(chat.id);
        holdPersistence = false;
        await pendingPersistence!.continue();
        await expect.poll(async () => (await extra()).translationSource).toBe(source);
        await expect(row).toContainText(translated);
        await expect(row).not.toContainText(source);
        await expect(row).not.toContainText("Zacznijmy");
        await page.screenshot({ path: info.outputPath("translation-only-background.png") });

        pendingTranslation = undefined;
        source = "The corridor fills with distant footsteps.";
        translated = "Korytarz wypełnia się odległymi krokami.";
        await regenerate();
        await expect.poll(() => generationCount).toBe(3);
        await expect.poll(() => Boolean(pendingTranslation)).toBe(true);
        const pendingText = translated;
        source = "The lantern illuminates a different path.";
        translated = "Latarnia oświetla inną drogę.";
        await regenerate();
        await expect.poll(() => generationCount).toBe(4);
        holdTranslation = false;
        await pendingTranslation!.fulfill({ json: { translatedText: pendingText } });
        await expect.poll(async () => (await extra()).translationSource).toBe(source);
        await expect(row).toContainText(translated);
        await expect(row).not.toContainText(source);
        await expect(row).not.toContainText(initialSource.split("\n")[0]!);
        await expect(row).not.toContainText("Let us begin");
        await expect(row).not.toContainText("Zacznijmy");
        await expect(row).not.toContainText(pendingText);
        await page.screenshot({ path: info.outputPath("translation-only-regenerated.png") });
        await request.patch(`/api/chats/${chat.id}/metadata`, { data: { translationDisplayOnly: false } });
        await page.reload();
        await expect(row).toContainText(translated);
        await expect(row).toContainText(source);
        await request.patch(`/api/chats/${chat.id}/metadata`, {
          data: { translationDisplayOnly: true, autoTranslate: false },
        });
        await request.patch(`/api/chats/${chat.id}/messages/${saved!.id}`, {
          data: { content: "A later manual edit." },
        });
        await page.reload();
        await expect(row).toContainText("A later manual edit.");
      }
    } catch (error) {
      await info
        .attach("failure-ui", { body: await page.screenshot(), contentType: "image/png" })
        .catch(() => undefined);
      await info
        .attach("failure-text", { body: await page.locator("body").innerText(), contentType: "text/plain" })
        .catch(() => undefined);
      throw error;
    } finally {
      await page.close();
      for (const path of paths) await request.delete(path).catch(() => undefined);
    }
  });
}
