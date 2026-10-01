import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { crossWithFriendsFixture as fixture } from "./helpers/cross-with-friends-fixture.js";

const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("game state projects entered data and maps clues to crossings without solution or session leakage", async () => {
  const secret = "HIDDEN-SOLUTION-AND-PRIVATE-DATA";
  const poison = (object, key) => Object.defineProperty(object, key, { enumerable: true, get() { throw new Error(secret); } });
  const h = await fixture({ setup({ game, page, window }) {
    poison(game, "solution"); poison(game, "secret"); poison(game.info, "solution");
    poison(game.grid[0][0], "solution"); poison(game.grid[2][0], "value");
    poison(game.users["private-player-id"], "token"); poison(game.chat.messages[0], "token");
    poison(page, "context"); poison(window, "localStorage"); poison(window, "sessionStorage");
    game.clues.across[1] = "Pet &amp; companion<script>HIDDEN MARKUP</script>";
  } });
  const state = await h.invoke("get_game_state");
  assert.equal(state.title, "Synthetic puzzle");
  assert.deepEqual([state.rows, state.columns], [3, 3]);
  assert.equal(state.clues.across[0].pattern, "C??");
  assert.equal(state.clues.across[0].text, "Pet & companion");
  assert.equal(state.clues.across[0].completed, false);
  assert.equal(state.clues.down[0].pattern, "C?");
  assert.deepEqual(state.clues.across[0].cells, [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }]);
  assert.equal(state.selectedClue, "1A");
  assert.equal(state.currentPlayer.name, "Synthetic player");
  assert.equal(state.timer.display, "00:12");
  assert.equal(state.timer.recordedMilliseconds, 12000);
  assert.equal(state.inviteUrl, "https://www.crosswithfriends.com/beta/game/synthetic-game");
  for (const forbidden of [secret, "solution", "private-player-id", "other-private-id", "DO-NOT-RETURN", "private-fragment", "HIDDEN MARKUP"]) {
    assert.equal(JSON.stringify(state).includes(forbidden), false);
    assert.equal(JSON.stringify(h.messages).includes(forbidden), false);
  }
  assert.equal(h.calls.length, 0);
});

test("state refreshes on invocation and bounds chat; image values and object serializers never escape", async () => {
  const h = await fixture();
  h.game.grid[0][1].value = "AR";
  h.game.grid[1][1].isImage = true;
  Object.defineProperty(h.game.grid[1][1], "value", { get() { throw new Error("hidden image value"); } });
  h.game.info.description = { toJSON() { throw new Error("Do not serialize arbitrary site objects"); } };
  h.game.chat.messages = Array.from({ length: 35 }, (_, index) => ({ sender: "Fixture", text: String(index), timestamp: index }));
  const state = await h.invoke("get_game_state");
  assert.equal(state.clues.across[0].pattern, "C{AR}?");
  assert.equal(state.grid[1][1].value, null);
  assert.equal(state.description, "");
  assert.equal(state.chat.length, 30);
  assert.equal(state.chat[0].text, "5");
});

test("unexpected site exceptions cannot expose raw hidden data through errors or telemetry", async () => {
  const h = await fixture();
  Object.defineProperty(h.page, "game", { get() { throw new Error("PRIVATE-SOLUTION-IN-EXCEPTION"); } });
  await rejectsCode(h.invoke("get_game_state"), "site_interface_changed");
  assert.equal(JSON.stringify(h.messages).includes("PRIVATE-SOLUTION-IN-EXCEPTION"), false);
});

for (const url of ["https://www.crosswithfriends.com/", "https://www.crosswithfriends.com/fencing/synthetic-game", "https://www.crosswithfriends.com/beta/replay/synthetic-game", "https://evil.example/game/synthetic-game", "https://www.crosswithfriends.com/game/synthetic-game/extra"]) {
  test(`rejects unsupported route ${url}`, async () => {
    const h = await fixture({ url });
    await rejectsCode(h.invoke("get_game_state"), "unsupported_route");
  });
}

test("supports the bare host and legacy game route", async () => {
  const h = await fixture({ url: "https://crosswithfriends.com/game/synthetic-game" });
  assert.equal((await h.invoke("get_game_state")).gameId, "synthetic-game");
});

for (const [label, update, code] of [
  ["loading", (h) => { h.history.ready = false; }, "game_not_ready"],
  ["stale SPA instance", (h) => { h.page.state.gid = "different"; }, "game_not_ready"],
  ["archived", (h) => { h.page.state.archived = true; }, "game_unavailable"],
  ["kicked", (h) => { h.page.state.moderationError = "kicked"; }, "game_unavailable"],
  ["ragged grid", (h) => { h.game.grid[0].pop(); }, "grid_unavailable"],
  ["hidden cells", (h) => { h.game.grid[0][0].isHidden = true; }, "unsupported_variant"],
  ["fencing", (h) => { h.game.isFencing = true; }, "unsupported_variant"],
  ["missing clue mapping", (h) => { h.game.clues.across[99] = "Missing"; }, "clue_cells_missing"],
]) {
  test(`fails closed for ${label}`, async () => {
    const h = await fixture(); update(h);
    await rejectsCode(h.invoke("get_game_state"), code);
    assert.equal(h.calls.length, 0);
  });
}

test("set_answer updates crossings using confirmed site events, then clear_answer clears them", async () => {
  const h = await fixture();
  const written = await h.invoke("set_answer", { ...h.guards(), clue: "1a", answer: "cat" });
  assert.equal(written.clues.across[0].pattern, "CAT");
  assert.equal(written.clues.across[0].completed, true);
  assert.equal(written.clues.down[1].pattern, "A??");
  assert.equal(written.pendingChanges, 0);
  assert.equal(h.calls.length, 2); // Matching C is not rewritten.
  const cleared = await h.invoke("clear_answer", { ...h.guards(), clue: "1A" });
  assert.equal(cleared.clues.across[0].pattern, "???");
  assert.equal(cleared.clues.down[0].pattern, "??");
});

test("conflicts are rejected before any write, and explicit overwrite is honored", async () => {
  const h = await fixture();
  await rejectsCode(h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "DOG" }), "answer_conflict");
  assert.equal(h.calls.length, 0);
  const state = await h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "DOG", overwrite: true });
  assert.equal(state.clues.across[0].pattern, "DOG");
});

test("validates complete answers, clue IDs, locked/rebus/image cells before writing", async () => {
  const h = await fixture();
  for (const answer of ["CA", "CATS", "C T", "C?T", 123, "CÅT"]) await rejectsCode(h.invoke("set_answer", { ...h.guards(), clue: "1A", answer }), "invalid_answer");
  await rejectsCode(h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "CAT", overwrite: "true" }), "invalid_answer");
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A<script>" }), "invalid_clue");
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "99A" }), "clue_not_found");
  h.game.grid[0][0].good = true;
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }), "cell_locked");
  h.game.grid[0][0].good = false;
  h.game.grid[0][2].value = "REBUS";
  await rejectsCode(h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "CAT" }), "unsupported_cells");
  h.game.grid[0][2].value = ""; h.game.grid[0][2].isImage = true;
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }), "unsupported_cells");
  assert.equal(h.calls.length, 0);
});

test("all shared mutations require a fresh game and revision and a synchronized connection", async () => {
  const h = await fixture();
  const args = { clue: "1A", answer: "CAT", scope: "puzzle", confirm: true, message: "Fixture" };
  for (const name of ["set_answer", "clear_answer", "check", "reveal", "send_chat_message", "reset_game"]) {
    await rejectsCode(h.invoke(name, args), "stale_state");
    await rejectsCode(h.invoke(name, { ...args, ...h.guards(), expectedGameId: "other-game" }), "stale_state");
    await rejectsCode(h.invoke(name, { ...args, ...h.guards(), expectedRevision: "old" }), "stale_state");
  }
  h.model.socket.connected = false;
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }), "sync_pending");
  h.model.socket.connected = true; h.history.optimisticEvents.push({});
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }), "sync_pending");
  h.history.optimisticEvents = []; h.game.solved = true;
  await rejectsCode(h.invoke("reset_game", { ...h.guards(), confirm: true }), "game_solved");
  assert.equal(h.calls.length, 0);
});

test("a changed crossing stops a partial answer without overwriting the remote letter", async () => {
  const h = await fixture({ afterApply({ game }) { game.grid[0][2].value = "X"; } });
  await rejectsCode(h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "CAT" }), "crossing_changed");
  assert.equal(h.calls.length, 1);
  assert.equal(h.game.grid[0][2].value, "X");
});

test("solving on the last changed cell permits trailing already matching cells", async () => {
  const h = await fixture({ afterApply({ game }) { game.solved = true; } });
  h.game.grid[0][2].value = "T";
  const state = await h.invoke("set_answer", { ...h.guards(), clue: "1A", answer: "CAT" });
  assert.equal(state.clues.across[0].pattern, "CAT");
  assert.equal(h.calls.length, 1);
});

test("focus_clue is local UI state only, including no cursor or clock events", async () => {
  const h = await fixture();
  const before = JSON.stringify(h.game);
  const result = await h.invoke("focus_clue", { clue: "5A" });
  assert.equal(result.selectedClue, "5A");
  assert.equal((await h.invoke("get_game_state")).selectedClue, "5A");
  assert.equal(JSON.stringify(h.game), before);
  assert.equal(h.calls.length, 0);
});

test("check changes marks through the existing site action without revealing blank letters", async () => {
  const h = await fixture();
  h.game.grid[0][1].value = "X";
  Object.defineProperty(h.game, "solution", { get() { throw new Error("Adapter must not inspect solutions"); } });
  const state = await h.invoke("check", { ...h.guards(), scope: "clue", clue: "1A" });
  assert.equal(h.calls[0].type, "check");
  assert.equal(state.grid[0][0].checkedCorrect, true);
  assert.equal(state.grid[0][1].checkedIncorrect, true);
  assert.equal(state.grid[0][2].value, "");
});

test("reveal, reset and chat require literal true confirmation before any action", async () => {
  const h = await fixture();
  for (const name of ["reveal", "reset_game", "send_chat_message"]) {
    for (const confirm of [undefined, false, "true", 1]) await rejectsCode(h.invoke(name, { ...h.guards(), scope: "puzzle", message: "Fixture", confirm }), "confirmation_required");
  }
  assert.equal(h.calls.length, 0);
});

test("reveal returns only the now-visible target and reset uses the site's puzzle-only behavior", async () => {
  const h = await fixture();
  Object.defineProperty(h.game, "solution", { get() { throw new Error("Never read solutions, even on reveal"); } });
  const revealed = await h.invoke("reveal", { ...h.guards(), scope: "cell", row: 0, column: 1, confirm: true });
  assert.equal(revealed.grid[0][1].value, "A");
  assert.equal(revealed.grid[0][1].revealed, true);
  assert.equal(revealed.grid[0][2].value, "");
  const reset = await h.invoke("reset_game", { ...h.guards(), confirm: true });
  assert.equal(reset.clues.across[0].pattern, "???");
  assert.equal(reset.grid[0][1].revealed, false);
  assert.equal(reset.timer.recordedMilliseconds, 12000);
  assert.equal(h.calls[1].type, "reset");
  assert.equal(h.calls[1].params.force, false);
  assert.equal(h.calls[1].params.scope.length, 8);
});

test("host restrictions, unknown permissions and contests cannot be bypassed", async () => {
  const h = await fixture();
  for (const [name, action] of [["check", "check"], ["reveal", "reveal"], ["reset_game", "reset"]]) {
    h.page.state.restrictions[action] = true;
    await rejectsCode(h.invoke(name, { ...h.guards(), scope: "puzzle", confirm: true }), "action_restricted");
    delete h.page.state.restrictions[action];
    await rejectsCode(h.invoke(name, { ...h.guards(), scope: "puzzle", confirm: true }), "action_restricted");
    h.page.state.restrictions[action] = false;
  }
  h.game.contest = true;
  for (const name of ["check", "reveal"]) await rejectsCode(h.invoke(name, { ...h.guards(), scope: "puzzle", confirm: true }), "contest_action_unavailable");
  assert.equal(h.calls.length, 0);
  h.game.contest = false; h.page.state.restrictions.check = true; h.page.gameComponent.props.isOwner = true;
  await h.invoke("check", { ...h.guards(), scope: "cell", row: 0, column: 0 });
  assert.equal(h.calls.length, 1);
});

test("ambiguous scopes, blocked cells and out-of-range cells are rejected", async () => {
  const h = await fixture();
  for (const args of [{ scope: "all" }, { scope: "puzzle", clue: "1A" }, { scope: "clue", clue: "1A", row: 0 }, { scope: "cell", row: 0.5, column: 0 }]) await rejectsCode(h.invoke("check", { ...h.guards(), ...args }), "invalid_scope");
  for (const [row, column] of [[2, 0], [-1, 0], [3, 0]]) await rejectsCode(h.invoke("check", { ...h.guards(), scope: "cell", row, column }), "unsupported_cells");
  assert.equal(h.calls.length, 0);
});

test("chat validates text and waits for an exact server-confirmed message", async () => {
  const h = await fixture();
  for (const message of ["", "   ", "x".repeat(1001), 1]) await rejectsCode(h.invoke("send_chat_message", { ...h.guards(), message, confirm: true }), "invalid_message");
  const sent = await h.invoke("send_chat_message", { ...h.guards(), message: "Synthetic message", confirm: true });
  assert.equal(sent.sent, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.game.chat.messages.at(-1).text, "Synthetic message");
});

test("server rejection is sanitized and confirmation listeners are cleaned up", async () => {
  const h = await fixture({ reject: true });
  await rejectsCode(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }), "action_rejected");
  assert.equal(h.model.listenerCount("wsEvent"), 0);
  assert.equal(h.model.listenerCount("wsOptimisticEvent"), 0);
  assert.equal(h.model.listenerCount("eventRejected"), 0);
  assert.equal(JSON.stringify(h.messages).includes("PRIVATE SERVER ERROR"), false);
});

test("server echo alone is insufficient when the mutation postcondition fails", async () => {
  for (const [name, args, code] of [
    ["clear_answer", { clue: "1A" }, "answer_unconfirmed"],
    ["check", { scope: "clue", clue: "1A" }, "check_unconfirmed"],
    ["reveal", { scope: "puzzle", confirm: true }, "reveal_unconfirmed"],
    ["reset_game", { confirm: true }, "reset_unconfirmed"],
    ["send_chat_message", { message: "Fixture", confirm: true }, "chat_unconfirmed"],
  ]) {
    const h = await fixture({ noApply: true });
    await rejectsCode(h.invoke(name, { ...h.guards(), ...args }), code);
  }
});

test("abort before execution does not write; in-flight abort warns of uncertain outcome and cleans listeners", async () => {
  const h = await fixture({ noEcho: true });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(h.invoke("clear_answer", { ...h.guards(), clue: "1A" }, { signal: cancelled.signal }), { name: "AbortError" });
  assert.equal(h.calls.length, 0);
  const controller = new AbortController();
  const pending = h.invoke("clear_answer", { ...h.guards(), clue: "1A" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.model.listenerCount("wsEvent"), 0);
  assert.equal(h.calls.length, 1);
});

test("unrelated server events cannot confirm a write; timeout is bounded and never retries", async () => {
  const h = await fixture({ noEcho: true });
  const pending = h.invoke("clear_answer", { ...h.guards(), clue: "1A" });
  h.model.emit("wsEvent", { id: "unrelated-event", type: "updateCell" });
  await rejectsCode(pending, "action_unconfirmed");
  assert.equal(h.calls.length, 1);
  assert.equal(h.model.listenerCount("wsEvent"), 0);
});

test("concurrent adapter writes are serialized by rejection and navigation invalidates a pending result", async () => {
  const h = await fixture({ delay: 10, afterApply({ page }) { page.state.gid = "other-game"; } });
  const pending = h.invoke("clear_answer", { ...h.guards(), clue: "1A" });
  await rejectsCode(h.invoke("reset_game", { ...h.guards(), confirm: true }), "action_in_progress");
  await rejectsCode(pending, "game_not_ready");
  assert.equal(h.calls.length, 1);
});

test("metadata and registered tools accurately classify effects and confirmation requirements", async () => {
  const metadata = JSON.parse(await readFile(new URL("../adapters/cross-with-friends/adapter.json", import.meta.url), "utf8"));
  const h = await fixture();
  assert.equal(metadata.world, "MAIN");
  assert.deepEqual(metadata.tools.map((tool) => tool.name), Object.keys(h.tools));
  for (const tool of metadata.tools) assert.equal(h.tools[tool.name].annotations.readOnlyHint, tool.name === "get_game_state");
  for (const name of ["reveal", "reset_game", "send_chat_message"]) {
    assert.equal(metadata.tools.find((tool) => tool.name === name).risk, "consequential");
    assert.equal(h.tools[name].annotations.destructiveHint, true);
    assert.equal(h.tools[name].inputSchema.properties.confirm.const, true);
    assert.ok(h.tools[name].inputSchema.required.includes("confirm"));
  }
  assert.equal(h.tools.focus_clue.annotations.destructiveHint, false);
  assert.equal(h.tools.check.annotations.readOnlyHint, false);
  assert.equal(h.tools.clear_answer.annotations.destructiveHint, true);
});
