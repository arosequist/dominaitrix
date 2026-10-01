import { EventEmitter } from "node:events";
import { loadAdapter, parseToolResult } from "./adapter-harness.js";

// Synthetic data matching the observed public site model, not a captured puzzle/session.
export async function crossWithFriendsFixture(options = {}) {
  const cell = (number, across, down, value = "") => ({ number, parents: { across, down }, value, black: false, good: false, bad: false, pencil: false, revealed: false });
  const game = {
    pid: "synthetic-puzzle", info: { title: "Synthetic <b>puzzle</b>", author: "Fixture author" },
    grid: [[cell(1, 1, 1, "C"), cell(2, 1, 2), cell(3, 1, 3)], [cell(4, 4, 1), cell(null, 4, 2), cell(null, 4, 3)], [{ black: true }, cell(5, 5, 2), cell(null, 5, 3)]],
    clues: { across: [null, "Pet &amp; companion", null, null, "Opposite of later", "Exist"], down: [null, "First column", "<i>Second</i> column", "Third column"] },
    clock: { totalTime: 12000, paused: true }, solved: false,
    users: { "private-player-id": { displayName: "Synthetic player", color: "blue" }, "other-private-id": { displayName: "Friend", color: "red" } },
    chat: { messages: [{ sender: "Friend", senderId: "other-private-id", text: "Fixture hello", timestamp: 100 }] },
  };
  const solution = [["C", "A", "T"], ["N", "O", "W"], [".", "B", "E"]];
  const history = { ready: true, history: [], optimisticEvents: [] };
  const model = new EventEmitter();
  Object.assign(model, { gid: "synthetic-game", socket: { connected: true }, syncState: null });
  const calls = [];
  let serial = 0;
  const apply = (event) => {
    const { type, params } = event;
    if (type === "updateCell") {
      const target = game.grid[params.cell.r][params.cell.c];
      if (!target.good && !game.solved) Object.assign(target, { value: params.value, bad: false, pencil: params.pencil });
    } else if (["check", "reveal", "reset"].includes(type)) {
      for (const { r, c } of params.scope) {
        const target = game.grid[r][c];
        if (type === "check") Object.assign(target, { good: !!target.value && target.value === solution[r][c], bad: !!target.value && target.value !== solution[r][c], pencil: false });
        if (type === "reveal") Object.assign(target, { value: solution[r][c], good: true, revealed: true, pencil: false });
        if (type === "reset") Object.assign(target, { value: "", good: false, bad: false, revealed: false, pencil: false });
      }
    } else if (type === "chat") game.chat.messages.push({ ...params, timestamp: 200 });
  };
  const emit = (type, params) => {
    const event = { id: `synthetic-event-${++serial}`, type, params };
    calls.push(event);
    history.optimisticEvents.push(event);
    model.emit("wsOptimisticEvent", event);
    if (options.noEcho) return;
    setTimeout(() => {
      history.optimisticEvents = history.optimisticEvents.filter((entry) => entry.id !== event.id);
      if (options.reject) {
        model.emit("eventRejected", { event, reason: "PRIVATE SERVER ERROR" });
        return;
      }
      if (!options.noApply) apply(event);
      history.history.push(event);
      options.afterApply?.({ game, history, event, model, page });
      model.emit("wsEvent", event);
    }, options.delay ?? 1);
  };
  model.check = (scope) => emit("check", { scope });
  model.reveal = (scope) => emit("reveal", { scope });
  model.reset = (scope, force) => emit("reset", { scope, force });
  const player = { state: { selected: { r: 0, c: 0 }, direction: "across" }, setState(update) { this.state = { ...this.state, ...update }; } };
  const component = { player, props: { isOwner: false }, handleUpdateGrid: (r, c, value) => emit("updateCell", { cell: { r, c }, value, pencil: false }) };
  const page = {
    state: { gid: "synthetic-game", restrictions: { check: false, reveal: false, reset: false } },
    game, gameModel: model, historyWrapper: history, gameComponent: component, userId: "private-player-id",
    handleChat: (sender, senderId, text) => emit("chat", { sender, senderId, text }),
  };
  let window;
  const harness = await loadAdapter("../../adapters/cross-with-friends/adapter.js", '<!doctype html><html><body><span class="clock__value">00:12</span></body></html>', {
    url: options.url || "https://www.crosswithfriends.com/beta/game/synthetic-game?private-query=DO-NOT-RETURN#private-fragment",
    fetch: () => { throw new Error("Unexpected network request"); },
    setup({ window: target, document }) {
      window = target;
      target.gameComponent = page;
      options.setup?.({ game, page, history, model, document, window });
    },
  });
  const invoke = async (tool, args = {}, invocation = {}) => parseToolResult(await harness.tools[tool].execute(args, invocation));
  const guards = () => ({ expectedGameId: page.state.gid, expectedRevision: `${history.history.length}:${history.optimisticEvents.length}` });
  return { ...harness, invoke, guards, game, page, model, history, calls, player, window };
}
