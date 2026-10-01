(() => {
  const clueProperty = { type: "string", pattern: "^[1-9][0-9]*[AaDd]$", description: "Clue identifier, e.g. 17A or 3D." };
  const guardProperties = {
    expectedGameId: { type: "string", description: "gameId from a fresh get_game_state result." },
    expectedRevision: { type: "string", description: "revision from that same result; rejects intervening game events." },
  };
  const confirmation = { type: "boolean", const: true, description: "Must be true only after the user explicitly authorizes this action for all players." };
  const scopeProperties = {
    scope: { type: "string", enum: ["cell", "clue", "puzzle"] },
    clue: clueProperty,
    row: { type: "integer", minimum: 0, description: "Zero-based row for cell scope." },
    column: { type: "integer", minimum: 0, description: "Zero-based column for cell scope." },
  };
  let busy = false;

  function schema(properties, required = []) {
    return { type: "object", properties, required, additionalProperties: false };
  }

  function mutation(name, description, properties, required, destructive, execute) {
    return {
      name, description,
      inputSchema: schema({ ...guardProperties, ...properties }, ["expectedGameId", "expectedRevision", ...required]),
      annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, untrustedContentHint: true },
      execute: async (args, invocation) => {
        const { ctx, signal } = invocation;
        if (busy) throw ctx.error("state", "action_in_progress", "Another adapter action is still running");
        busy = true;
        try {
          signal?.throwIfAborted();
          const live = readLive(ctx);
          assertWritable(live, args, ctx);
          return await execute(args, { ...invocation, live });
        } finally {
          busy = false;
        }
      },
    };
  }

  DOMinAItrix.defineAdapter({
    meta: { id: "cross-with-friends", version: "0.1.0", route: () => routeId() ? "game" : "other" },
    tools: [
      {
        name: "get_game_state",
        description: "Read the current Cross with Friends game, entered grid, clues, local selection, players and latest 30 chat messages. Never returns hidden solutions. A completed clue means filled, not necessarily correct.",
        inputSchema: schema({}),
        annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
        execute: async (_, { ctx, signal }) => {
          signal?.throwIfAborted();
          return result(publicState(readLive(ctx), ctx));
        },
      },
      mutation("set_answer", "Enter one ASCII letter per cell for a clue, updating shared crossings. Conflicting letters require overwrite=true. Checked/revealed cells cannot be changed. Uses the site's current pencil/autocheck settings; may advance the game clock.",
        { clue: clueProperty, answer: { type: "string", pattern: "^[A-Za-z]+$" }, overwrite: { type: "boolean", default: false } }, ["clue", "answer"], true,
        async (args, invocation) => editAnswer(args, invocation, false)),
      mutation("clear_answer", "Clear editable letters of a clue and its crossings for all players. Checked/revealed cells require the site's Reset feature instead. May advance the game clock.",
        { clue: clueProperty }, ["clue"], true,
        async (args, invocation) => editAnswer(args, invocation, true)),
      {
        name: "focus_clue",
        description: "Select/highlight a clue locally in the existing UI. Does not broadcast a cursor, change grid contents or start the game clock.",
        inputSchema: schema({ clue: clueProperty }, ["clue"]),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
        execute: async ({ clue }, { ctx, signal }) => {
          signal?.throwIfAborted();
          const live = readLive(ctx);
          const target = findClue(live, clue, ctx);
          const player = live.page.gameComponent?.player;
          if (!player?.setState || player.cursorLocked) throw ctx.error("state", "selection_unavailable", "Open the game grid with an unlocked cursor");
          const first = target.cells.find(({ r, c }) => !live.game.grid[r][c].isImage);
          if (!first) throw ctx.error("state", "unsupported_cells", "This clue has no supported selectable cells");
          // The site's setSelected/selectClue methods emit shared updateCursor events.
          // Only change the Player's local React state to keep this tool UI-only.
          player.setState({ selected: { r: first.r, c: first.c }, direction: target.direction });
          await waitFor(() => {
            const current = sameGame(live, ctx);
            return selectedClue(current) === target.id;
          }, signal, ctx, "selection_unconfirmed");
          return result({ selectedClue: target.id });
        },
      },
      mutation("check", "Use the site's Check behavior on a cell, clue or puzzle. Changes shared correctness marks, locks correct letters and may advance the clock; does not reveal missing letters. Unavailable in contest games or when host-restricted.",
        scopeProperties, ["scope"], false,
        async (args, { live, ctx, signal }) => {
          assertAction(live, "check", ctx);
          const cells = scopeCells(live, args, ctx);
          const before = cells.map(({ r, c }) => live.game.grid[r][c].value || "");
          await confirmedEvent(live, "check", () => live.model.check(cells), signal, ctx);
          const fresh = sameGame(live, ctx);
          if (cells.some(({ r, c }, i) => {
            const cell = fresh.game.grid[r][c];
            return (cell.value || "") !== before[i] || (before[i] && !cell.good && !cell.bad);
          })) throw ctx.error("state", "check_unconfirmed", "The checked cells changed; read the current game before continuing");
          return result(publicState(fresh, ctx));
        }),
      mutation("reveal", "Consequential: reveal answers for all players through the site's Reveal behavior. Requires explicit user authorization and confirm=true. This is the only tool that requests hidden answers. Unavailable in contest games or when host-restricted.",
        { ...scopeProperties, confirm: confirmation }, ["scope", "confirm"], true,
        async (args, { live, ctx, signal }) => {
          requireConfirmation(args, ctx);
          assertAction(live, "reveal", ctx);
          const cells = scopeCells(live, args, ctx);
          await confirmedEvent(live, "reveal", () => live.model.reveal(cells), signal, ctx);
          const fresh = sameGame(live, ctx);
          if (cells.some(({ r, c }) => !fresh.game.grid[r][c].good)) throw ctx.error("state", "reveal_unconfirmed", "The site did not confirm all revealed cells");
          // Read only the now-visible grid, never the solution array.
          return result(publicState(fresh, ctx));
        }),
      mutation("send_chat_message", "Send a message to all players in the existing chat. Requires explicit authorization and confirm=true. Messages cannot be unsent; do not retry automatically after an unconfirmed result.",
        { message: { type: "string", minLength: 1, maxLength: 1000 }, confirm: confirmation }, ["message", "confirm"], true,
        async (args, { live, ctx, signal }) => {
          requireConfirmation(args, ctx);
          if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 1000) throw ctx.error("input", "invalid_message", "Provide a nonempty message of at most 1000 characters");
          const sender = live.game.users?.[live.page.userId]?.displayName;
          if (typeof sender !== "string" || typeof live.page.handleChat !== "function") throw ctx.error("state", "chat_unavailable", "The current player's chat identity is not ready");
          const count = live.game.chat?.messages?.length || 0;
          await confirmedEvent(live, "chat", () => live.page.handleChat(sender, live.page.userId, args.message), signal, ctx);
          const fresh = sameGame(live, ctx);
          if (!fresh.game.chat?.messages?.slice(count).some((message) => message.senderId === live.page.userId && message.text === args.message)) throw ctx.error("state", "chat_unconfirmed", "The site did not confirm the message; do not resend automatically");
          return result({ sent: true, gameId: fresh.id, revision: revision(fresh) });
        }),
      mutation("reset_game", "Destructive: clear the entire unsolved grid and all check/reveal marks for every player using the site's Reset Puzzle behavior. Requires explicit user authorization and confirm=true. The timer is not reset; solved games and Puzzle and Timer are unsupported.",
        { confirm: confirmation }, ["confirm"], true,
        async (args, { live, ctx, signal }) => {
          requireConfirmation(args, ctx);
          assertAction(live, "reset", ctx);
          const cells = scopeCells(live, { scope: "puzzle" }, ctx);
          await confirmedEvent(live, "reset", () => live.model.reset(cells, false), signal, ctx);
          const fresh = sameGame(live, ctx);
          if (cells.some(({ r, c }) => {
            const cell = fresh.game.grid[r][c];
            return cell.value || cell.good || cell.bad || cell.revealed || cell.pencil;
          })) throw ctx.error("state", "reset_unconfirmed", "The grid changed before the reset could be verified");
          return result(publicState(fresh, ctx));
        }),
    ].map((tool) => ({
      ...tool,
      execute: async (args, invocation) => {
        try {
          return await tool.execute(args, invocation);
        } catch (error) {
          if (error instanceof DOMinAItrix.AdapterError || error?.name === "AbortError") throw error;
          throw invocation.ctx.error("state", "site_interface_changed", "The site's game interface changed; read the current game before retrying");
        }
      },
    })),
  });

  function routeId() {
    if (location.protocol !== "https:" || !["www.crosswithfriends.com", "crosswithfriends.com"].includes(location.hostname)) return null;
    return location.pathname.match(/^\/(?:beta\/)?game\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null;
  }

  function readLive(ctx) {
    const id = routeId();
    if (!id) throw ctx.error("state", "unsupported_route", "Open a standard Cross with Friends game page");
    const page = window.gameComponent;
    if (!page || page.state?.gid !== id || page.gameModel?.gid !== id || !page.historyWrapper?.ready) throw ctx.error("state", "game_not_ready", "The current game has not finished loading");
    if (page.state.archived || page.state.gameNotFound || page.state.moderationError) throw ctx.error("state", "game_unavailable", "This game is archived, missing or access-restricted");
    const game = page.game;
    const rows = game?.grid?.length;
    const columns = game?.grid?.[0]?.length;
    if (!rows || !columns || rows > 100 || columns > 100 || !Array.isArray(game.grid) || game.grid.some((row) => !Array.isArray(row) || row.length !== columns || row.some((cell) => !cell || typeof cell !== "object"))) throw ctx.error("state", "grid_unavailable", "The game grid is missing or unsupported");
    if (game.isFencing || game.grid.some((row) => row.some((cell) => cell.isHidden))) throw ctx.error("state", "unsupported_variant", "Hidden-cell and fencing games are unsupported");
    if (!Array.isArray(page.historyWrapper.history) || !Array.isArray(page.historyWrapper.optimisticEvents)) throw ctx.error("state", "history_unavailable", "The game synchronization interface changed");
    return { id, page, model: page.gameModel, game, rows, columns };
  }

  function sameGame(live, ctx) {
    const fresh = readLive(ctx);
    if (fresh.id !== live.id || fresh.page !== live.page || fresh.model !== live.model) throw ctx.error("state", "game_changed", "The active game changed during the action");
    return fresh;
  }

  function revision(live) {
    // Revisions include every server event (including chat/cursors), not wall-clock ticks.
    return `${live.page.historyWrapper.history.length}:${live.page.historyWrapper.optimisticEvents.length}`;
  }

  function assertWritable(live, args, ctx) {
    if (typeof args?.expectedGameId !== "string" || args.expectedGameId !== live.id || typeof args.expectedRevision !== "string" || args.expectedRevision !== revision(live)) throw ctx.error("state", "stale_state", "Read the current game and provide its gameId and revision before changing it");
    if (live.model.socket?.connected !== true || live.model.syncState || live.page.state.syncWarning || live.page.state.connectionFailed || live.page.historyWrapper.optimisticEvents.length) throw ctx.error("state", "sync_pending", "Wait for a connected game with no unconfirmed changes");
    if (live.game.solved) throw ctx.error("state", "game_solved", "Mutations of solved games are unsupported");
  }

  function assertAction(live, action, ctx) {
    const restrictions = live.page.state.restrictions;
    const owner = live.page.gameComponent?.props?.isOwner;
    if (!restrictions || typeof restrictions[action] !== "boolean" || (restrictions[action] && owner !== true)) throw ctx.error("state", "action_restricted", "The host restricted this action or permissions are not ready");
    if (live.game.contest && action !== "reset") throw ctx.error("state", "contest_action_unavailable", "Check and Reveal are unavailable in contest games");
    if (typeof live.model[action] !== "function") throw ctx.error("state", "action_unavailable", "The site's action interface changed");
  }

  function requireConfirmation(args, ctx) {
    if (args.confirm !== true) throw ctx.error("input", "confirmation_required", "Explicit user authorization and confirm=true are required for this shared action");
  }

  function clues(live, ctx) {
    const output = [];
    for (const direction of ["across", "down"]) {
      const texts = live.game.clues?.[direction];
      if (!texts || typeof texts !== "object") throw ctx.error("state", "clues_unavailable", "The game clues are not ready");
      for (const key of Object.keys(texts)) {
        const number = Number(key);
        if (!Number.isInteger(number) || number < 1 || typeof texts[key] !== "string" || !texts[key]) continue;
        const cells = [];
        live.game.grid.forEach((row, r) => row.forEach((cell, c) => {
          if (!cell.black && cell.parents?.[direction] === number) cells.push({ r, c });
        }));
        if (!cells.length) throw ctx.error("state", "clue_cells_missing", "A clue could not be mapped to the grid");
        const values = cells.map(({ r, c }) => live.game.grid[r][c].isImage ? null : safeText(live.game.grid[r][c].value, 100));
        output.push({ id: `${number}${direction === "across" ? "A" : "D"}`, number, direction, text: plainText(texts[key]), length: cells.length,
          pattern: values.map((value) => value === null ? "[image]" : !value ? "?" : value.length === 1 ? value : `{${value}}`).join(""),
          completed: values.every((value) => value === null || value.length > 0), cells });
      }
    }
    return output;
  }

  function findClue(live, id, ctx) {
    if (typeof id !== "string" || !/^[1-9][0-9]*[AD]$/i.test(id)) throw ctx.error("input", "invalid_clue", "Use a clue identifier such as 17A");
    const found = clues(live, ctx).find((clue) => clue.id === id.toUpperCase());
    if (!found) throw ctx.error("input", "clue_not_found", "That clue is not in the current puzzle");
    return found;
  }

  function scopeCells(live, args, ctx) {
    let cells;
    if (args.scope === "clue" && args.row === undefined && args.column === undefined) cells = findClue(live, args.clue, ctx).cells;
    else if (args.scope === "cell" && args.clue === undefined && Number.isInteger(args.row) && Number.isInteger(args.column)) cells = [{ r: args.row, c: args.column }];
    else if (args.scope === "puzzle" && args.clue === undefined && args.row === undefined && args.column === undefined) cells = live.game.grid.flatMap((row, r) => row.flatMap((cell, c) => cell.black ? [] : [{ r, c }]));
    else throw ctx.error("input", "invalid_scope", "Specify cell with row/column, clue with its identifier, or puzzle without a target");
    if (cells.some(({ r, c }) => !live.game.grid[r]?.[c] || live.game.grid[r][c].black || live.game.grid[r][c].isImage)) throw ctx.error("input", "unsupported_cells", "The target contains a blocked, image or out-of-bounds cell");
    return cells;
  }

  async function editAnswer(args, { live, ctx, signal }, clear) {
    const deadline = Date.now() + 30000;
    const target = findClue(live, args.clue, ctx);
    if (!clear && (typeof args.answer !== "string" || !/^[a-z]+$/i.test(args.answer) || args.answer.length !== target.length || (args.overwrite !== undefined && typeof args.overwrite !== "boolean"))) throw ctx.error("input", "invalid_answer", "Provide exactly one ASCII letter per clue cell and a boolean overwrite option");
    const values = target.cells.map((_, i) => clear ? "" : args.answer.toUpperCase()[i]);
    const expected = target.cells.map(({ r, c }) => cellVersion(live.game.grid[r][c]));
    target.cells.forEach(({ r, c }, i) => {
      const cell = live.game.grid[r][c];
      if (cell.isImage || safeText(cell.value, 100).length > 1) throw ctx.error("state", "unsupported_cells", "Editing image or rebus cells is unsupported");
      if ((cell.value || "") === values[i]) return;
      if (cell.good || cell.revealed) throw ctx.error("state", "cell_locked", "A checked or revealed cell cannot be edited; use the site's Reset behavior");
      if (!clear && cell.value && args.overwrite !== true) throw ctx.error("state", "answer_conflict", "Existing letters conflict with the answer; review the grid before explicitly enabling overwrite");
    });
    const component = live.page.gameComponent;
    if (typeof component?.handleUpdateGrid !== "function") throw ctx.error("state", "editing_unavailable", "Open the game grid before editing");
    for (let i = 0; i < target.cells.length; i += 1) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw ctx.error("state", "answer_timeout", "The answer took too long; earlier letters may have been entered. Read the game before retrying");
      const fresh = sameGame(live, ctx);
      // Revalidate every crossing before each write; abort partial operations on races.
      if (target.cells.some(({ r, c }, j) => cellVersion(fresh.game.grid[r][c]) !== expected[j])) throw ctx.error("state", "crossing_changed", "A crossing changed during the answer; earlier letters may have been entered. Read the game before retrying");
      const { r, c } = target.cells[i];
      if ((fresh.game.grid[r][c].value || "") === values[i]) continue;
      assertWritable(fresh, { expectedGameId: live.id, expectedRevision: revision(fresh) }, ctx);
      await confirmedEvent(fresh, "updateCell", () => component.handleUpdateGrid(r, c, values[i]), signal, ctx);
      const after = sameGame(live, ctx);
      if ((after.game.grid[r][c].value || "") !== values[i]) throw ctx.error("state", "answer_unconfirmed", "A letter was not confirmed; earlier letters may have been entered. Read the game before retrying");
      expected[i] = cellVersion(after.game.grid[r][c]);
    }
    const fresh = sameGame(live, ctx);
    if (target.cells.some(({ r, c }, i) => (fresh.game.grid[r][c].value || "") !== values[i])) throw ctx.error("state", "answer_unconfirmed", "The answer changed before it could be verified");
    return result(publicState(fresh, ctx));
  }

  function cellVersion(cell) {
    return JSON.stringify([safeText(cell.value, 100), !!cell.good, !!cell.bad, !!cell.revealed, !!cell.pencil]);
  }

  async function confirmedEvent(live, type, action, signal, ctx) {
    signal?.throwIfAborted();
    const { model } = live;
    if (typeof model.on !== "function" || typeof model.removeListener !== "function") throw ctx.error("state", "confirmation_unavailable", "The site's event confirmation interface changed");
    await new Promise((resolve, reject) => {
      let eventId;
      let issuing = false;
      const finish = (error) => {
        clearTimeout(timer);
        model.removeListener("wsOptimisticEvent", optimistic);
        model.removeListener("wsEvent", confirmed);
        model.removeListener("eventRejected", rejected);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const optimistic = (event) => { if (issuing && event?.type === type && typeof event.id === "string") eventId = event.id; };
      const confirmed = (event) => { if (eventId && event?.id === eventId && event.type === type) finish(); };
      const rejected = ({ event } = {}) => { if (eventId && event?.id === eventId) finish(ctx.error("state", "action_rejected", "The server rejected the action")); };
      const aborted = () => finish(new DOMException("Action cancelled; it may already have reached the server", "AbortError"));
      const timer = setTimeout(() => finish(ctx.error("state", "action_unconfirmed", "No server confirmation arrived. The action may still apply; read the game before retrying")), 12000);
      model.on("wsOptimisticEvent", optimistic);
      model.on("wsEvent", confirmed);
      model.on("eventRejected", rejected);
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        issuing = true;
        action();
        issuing = false;
        if (!eventId) finish(ctx.error("state", "action_unconfirmed", "The site did not emit the expected action; read the game before retrying"));
      } catch {
        finish(ctx.error("state", "action_failed", "The site action failed; read the game before retrying"));
      }
    });
  }

  async function waitFor(predicate, signal, ctx, code) {
    for (let i = 0; i < 40; i += 1) {
      signal?.throwIfAborted();
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw ctx.error("state", code, "The site did not confirm the requested UI state");
  }

  function selectedClue(live) {
    const state = live.page.gameComponent?.player?.state;
    if (!["across", "down"].includes(state?.direction)) return null;
    const number = live.game.grid[state.selected?.r]?.[state.selected?.c]?.parents?.[state.direction];
    return Number.isInteger(number) && number > 0 ? `${number}${state.direction === "across" ? "A" : "D"}` : null;
  }

  function publicState(live, ctx) {
    const { game, page } = live;
    const allClues = clues(live, ctx);
    const players = Object.entries(game.users || {}).slice(0, 100).map(([id, user]) => ({
      name: safeText(user?.displayName, 200), color: safeText(user?.color, 50), current: id === page.userId,
    }));
    // Explicit primitive projection only: never spread/serialize a site object.
    // In particular, do not access solution, events, credentials, storage or React props wholesale.
    return {
      gameId: live.id, puzzleId: typeof game.pid === "number" && Number.isFinite(game.pid) ? String(game.pid) : safeText(game.pid, 100), revision: revision(live),
      title: plainText(game.info?.titleOverride || game.info?.title), author: plainText(game.info?.authorOverride || game.info?.author),
      copyright: plainText(game.info?.copyright), description: plainText(game.info?.description),
      status: game.solved ? "solved" : game.clock?.paused ? "paused" : "playing", contest: !!game.contest,
      timer: { display: safeText(document.querySelector(".clock__value")?.textContent, 30), recordedMilliseconds: Number.isFinite(game.clock?.totalTime) ? game.clock.totalTime : null },
      connected: live.model.socket?.connected === true, pendingChanges: page.historyWrapper.optimisticEvents.length,
      rows: live.rows, columns: live.columns,
      grid: game.grid.map((row) => row.map((cell) => cell.black ? { blocked: true } : {
        blocked: false, number: Number.isInteger(cell.number) ? cell.number : null, image: !!cell.isImage,
        value: cell.isImage ? null : safeText(cell.value, 100), checkedCorrect: !!cell.good, checkedIncorrect: !!cell.bad, revealed: !!cell.revealed, pencil: !!cell.pencil,
      })),
      clues: { across: allClues.filter((clue) => clue.direction === "across"), down: allClues.filter((clue) => clue.direction === "down") },
      selectedClue: selectedClue(live), players, currentPlayer: players.find((player) => player.current) || null,
      chat: (Array.isArray(game.chat?.messages) ? game.chat.messages : []).slice(-30).map((message) => ({
        sender: safeText(message.sender, 200), text: safeText(message.text, 4000), timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
      })),
      inviteUrl: `${location.origin}/beta/game/${live.id}`,
    };
  }

  function safeText(value, limit = 4000) {
    return typeof value === "string" ? value.slice(0, limit) : "";
  }

  function plainText(value) {
    const node = document.createElement("template");
    // Detached text conversion; omit markup and non-content nodes from rich clues.
    node.innerHTML = safeText(value, 8000);
    node.content.querySelectorAll("script, style, template").forEach((child) => child.remove());
    return [...node.content.childNodes].map((child) => safeText(child.textContent)).join("").slice(0, 4000).replace(/\s+/g, " ").trim();
  }

  function result(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }
})();
