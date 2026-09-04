DOMinAItrix.defineAdapter({
  meta: {
    id: "espn-fantasy",
    version: "0.2.1",
    route: () => location.pathname === "/football/draft" ? "football-draft-room" : "unsupported",
  },
  tools: [
    {
      name: "get_espn_fantasy_draft_state",
      description: "Return the current ESPN Fantasy Football live-draft clock, turn, selected team, autopick setting, queue, and roster.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { ctx }) => {
        requireDraftRoom(ctx);
        return result(readDraftState(ctx));
      },
    },
    {
      name: "list_espn_fantasy_available_players",
      description: "Optionally switch ESPN's position filter, then return players currently rendered by its virtualized table. Use playerId for queue or draft operations.",
      inputSchema: {
        type: "object",
        properties: {
          position: {
            type: "string",
            enum: ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"],
            description: "Optional ESPN position view to activate before reading players.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum players to return. Defaults to 40.",
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async ({ position, limit = 40 }, { signal, ctx }) => {
        requireDraftRoom(ctx);
        if (position !== undefined && !["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K"].includes(position)) {
          throw ctx.error("input", "invalid_position", "The position filter is invalid");
        }
        if (position) await applyPositionFilter(position, signal, ctx);
        const boundedLimit = clampInteger(limit, 1, 100, 40);
        const players = readAvailablePlayers()
          .filter((player) => !position || positionMatches(player.position, position))
          .slice(0, boundedLimit);
        if (!players.length && !document.querySelector(".draft-players")) {
          throw ctx.error("dom", "player_table_missing", "The available-player table is not present in this draft room");
        }
        return result({ players, activePositionFilter: position ?? readPositionFilter(), renderedOnly: true });
      },
    },
    {
      name: "list_espn_fantasy_pick_history",
      description: "Return completed draft picks currently loaded in ESPN's pick-history tables.",
      inputSchema: {
        type: "object",
        properties: {
          team: { type: "string", description: "Optional exact team-name filter." },
          limit: { type: "integer", minimum: 1, maximum: 300, description: "Maximum picks to return. Defaults to 200." },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ team, limit = 200 }, { ctx }) => {
        requireDraftRoom(ctx);
        const normalizedTeam = typeof team === "string" ? cleanText(team) : "";
        const boundedLimit = clampInteger(limit, 1, 300, 200);
        const picks = readPickHistory()
          .filter((pick) => !normalizedTeam || pick.team === normalizedTeam)
          .slice(0, boundedLimit);
        return result({ picks });
      },
    },
    {
      name: "queue_espn_fantasy_player",
      description: "Add an available ESPN player to the current draft queue using a playerId returned by list_espn_fantasy_available_players.",
      inputSchema: playerIdSchema(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async ({ playerId }, { signal, ctx }) => {
        requireDraftRoom(ctx);
        const id = validatePlayerId(playerId, ctx);
        const alreadyQueued = findQueueButton(id, true);
        if (alreadyQueued) return result({ playerId: id, queued: true, changed: false });
        if (readDraftState(ctx).onClock) {
          throw ctx.error("state", "queue_unavailable_on_clock", "ESPN replaces queue actions with draft actions while the user is on the clock");
        }
        const button = findPlayerAction(id, "queue");
        if (!button) throw ctx.error("state", "player_not_queueable", "The player is not currently available to queue");
        const player = readPlayer(button);
        button.click();
        await waitFor(() => Boolean(findQueueButton(id, true)), signal, 2500);
        if (!findQueueButton(id, true)) {
          throw ctx.error("state", "queue_change_unconfirmed", "ESPN did not confirm that the player was added to the queue");
        }
        return result({ playerId: id, player: player?.name ?? "", queued: true, changed: true });
      },
    },
    {
      name: "remove_espn_fantasy_queued_player",
      description: "Remove an ESPN player from the current draft queue using the stable playerId.",
      inputSchema: playerIdSchema(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async ({ playerId }, { signal, ctx }) => {
        requireDraftRoom(ctx);
        const id = validatePlayerId(playerId, ctx);
        const button = findQueueButton(id, true);
        if (!button) return result({ playerId: id, queued: false, changed: false });
        button.click();
        await waitFor(() => !findQueueButton(id, true), signal, 2500);
        if (findQueueButton(id, true)) {
          throw ctx.error("state", "queue_change_unconfirmed", "ESPN did not confirm that the player was removed from the queue");
        }
        return result({ playerId: id, queued: false, changed: true });
      },
    },
    {
      name: "set_espn_fantasy_autopick",
      description: "Enable or disable ESPN autopick in the current draft room and confirm the resulting toggle state.",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: "boolean", description: "Whether autopick should be enabled." } },
        required: ["enabled"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async ({ enabled }, { signal, ctx }) => {
        requireDraftRoom(ctx);
        if (typeof enabled !== "boolean") throw ctx.error("input", "invalid_autopick_state", "Autopick state must be a boolean");
        const input = document.querySelector(".autoPick-toggle input[type=checkbox]");
        if (!input) throw ctx.error("dom", "autopick_toggle_missing", "The autopick control is not present in this draft room");
        if (input.checked === enabled) return result({ enabled, changed: false });
        const label = input.closest(".autoPick-toggle")?.querySelector("label");
        if (!label) throw ctx.error("dom", "autopick_toggle_missing", "The autopick control is not present in this draft room");
        label.click();
        await waitFor(() => input.checked === enabled, signal, 2500);
        if (input.checked !== enabled) {
          throw ctx.error("state", "autopick_change_unconfirmed", "ESPN did not confirm the requested autopick state");
        }
        return result({ enabled, changed: true });
      },
    },
    {
      name: "draft_espn_fantasy_player",
      description: "Draft a currently rendered player on the user's turn. If another position view is active, first call list_espn_fantasy_available_players with the player's position. Requires the current pick number so a stale instruction cannot draft on a later turn.",
      inputSchema: {
        type: "object",
        properties: {
          playerId: { type: "string", pattern: "^-?[0-9]+$", description: "Stable ESPN player ID from the available-player list, including signed D/ST IDs." },
          expectedPickNumber: { type: "integer", minimum: 1, description: "Current overall pick number from get_espn_fantasy_draft_state." },
        },
        required: ["playerId", "expectedPickNumber"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, untrustedContentHint: true },
      execute: async ({ playerId, expectedPickNumber }, { signal, ctx }) => {
        requireDraftRoom(ctx);
        const id = validatePlayerId(playerId, ctx);
        if (!Number.isInteger(expectedPickNumber) || expectedPickNumber < 1) {
          throw ctx.error("input", "invalid_pick_number", "The expected pick number is invalid");
        }

        const before = readDraftState(ctx);
        if (!before.onClock) throw ctx.error("state", "not_users_turn", "The user is not currently on the clock");
        if (before.currentPickNumber !== expectedPickNumber) {
          throw ctx.error("state", "stale_pick", "The draft has advanced beyond the expected pick");
        }

        const button = findPlayerAction(id, "draft");
        if (!button) throw ctx.error("state", "player_not_draftable", "The player is not rendered as draftable; activate the player's position with list_espn_fantasy_available_players and retry on the same pick");
        const player = readPlayer(button);

        const immediatelyBefore = readDraftState(ctx);
        if (!immediatelyBefore.onClock || immediatelyBefore.currentPickNumber !== expectedPickNumber) {
          throw ctx.error("state", "stale_pick", "The draft advanced before the selection could be made");
        }
        button.click();
        await waitFor(() => {
          const state = readDraftState(ctx);
          const completedPick = readPickHistory().find((pick) => pick.pickNumber === expectedPickNumber);
          return Boolean(completedPick) || (state.currentPickNumber !== expectedPickNumber && !findPlayerAction(id, "draft"));
        }, signal, 15000);
        const after = readDraftState(ctx);
        const completedPick = readPickHistory().find((pick) => pick.pickNumber === expectedPickNumber);
        if (completedPick && completedPick.playerId !== id) {
          throw ctx.error("state", "draft_selection_mismatch", "ESPN completed the pick with a different player");
        }
        if (!completedPick && (after.currentPickNumber === expectedPickNumber || findPlayerAction(id, "draft"))) {
          throw ctx.error("state", "draft_unconfirmed", "ESPN did not confirm the draft selection");
        }
        return result({ drafted: true, pickNumber: expectedPickNumber, player });
      },
    },
  ],
});

function requireDraftRoom(ctx) {
  if (location.pathname !== "/football/draft") {
    throw ctx.error("state", "wrong_route", "Open an ESPN Fantasy Football live draft room to use this tool");
  }
  const heading = document.querySelector("h1");
  if (!heading || !/ESPN Fantasy Football Draft/i.test(cleanText(heading.textContent))) {
    throw ctx.error("state", "draft_room_not_ready", "The ESPN Fantasy Football draft room is not ready");
  }
}

function readDraftState(ctx) {
  const clockLabel = cleanText(document.querySelector(".clock__label")?.textContent);
  const roundMatch = clockLabel.match(/RND\s+(\d+)\s+OF\s+(\d+)/i);
  const currentPickText = cleanText(document.querySelector(".on-the-clock")?.textContent);
  const currentPickNumber = integerFrom(currentPickText.match(/PICK\s+(\d+)/i)?.[1]);
  const currentTeam = cleanText(document.querySelector(".current-pick-module-container")?.textContent)
    .replace(/^ON THE CLOCK:\s*PICK\s*\d+\s*/i, "");
  const ownTeam = cleanText(document.querySelector("select option:checked")?.textContent);
  const queue = readQueue();
  const draftComplete = [...document.querySelectorAll("h2, h3, h4")]
    .some((heading) => /your draft is complete/i.test(cleanText(heading.textContent)));
  return {
    league: cleanText(document.querySelector("h1")?.textContent).replace(/^ESPN Fantasy Football Draft\s*-\s*/i, ""),
    currentRound: integerFrom(roundMatch?.[1]),
    totalRounds: integerFrom(roundMatch?.[2]),
    secondsRemaining: parseClock(document.querySelector(".clock__content")?.textContent),
    currentPickNumber,
    currentTeam,
    ownTeam,
    draftComplete,
    onClock: [...document.querySelectorAll("h3")].some((heading) => /you are on the clock/i.test(cleanText(heading.textContent)))
      || Boolean(document.querySelector("button.Button--draft.action-btn")),
    autopick: Boolean(document.querySelector(".autoPick-toggle input[type=checkbox]")?.checked),
    queue,
    roster: readRoster(ctx),
    completedPickCount: countCompletedPicks(),
  };
}

function readAvailablePlayers() {
  const rows = document.querySelectorAll(".draft-players .public_fixedDataTable_bodyRow");
  return [...rows].map((row) => readPlayer(row)).filter(Boolean);
}

function readPlayer(root) {
  const row = root.closest?.(".public_fixedDataTable_bodyRow") ?? root;
  const action = row.querySelector?.("button[data-player-id]") ?? (root.matches?.("button[data-player-id]") ? root : null);
  const position = cleanText(row.querySelector?.(".playerinfo__playerpos")?.textContent);
  const nflTeam = cleanText(row.querySelector?.(".playerinfo__playerteam")?.textContent);
  const playerId = action?.getAttribute("data-player-id") ?? playerIdFromImage(row) ?? defensePlayerId(nflTeam, position);
  const name = row.querySelector?.(".playerinfo__playername a")?.getAttribute("title")
    ?? cleanText(row.querySelector?.(".playerinfo__playername")?.textContent);
  if (!playerId || !name) return null;
  const cells = cellTexts(row);
  return {
    playerId,
    name,
    team: nflTeam,
    position,
    rank: integerFrom(cells[0]),
    byeWeek: integerFrom(cells[3]),
    projectedPoints: numberFrom(cells[4]),
    queued: action?.classList.contains("Button--dequeue") ?? false,
  };
}

function readQueue() {
  const buttons = document.querySelectorAll(".pick-queue button.Button--dequeue[data-player-id]");
  return [...buttons].map((button) => {
    const player = readPlayer(button);
    return player ?? { playerId: button.getAttribute("data-player-id"), name: "" };
  });
}

function readPickHistory() {
  const roundTables = document.querySelectorAll(".pick-history-tables .pick-history-table");
  const picks = [];
  [...roundTables].forEach((roundTable, roundIndex) => {
    for (const row of roundTable.querySelectorAll(".public_fixedDataTable_bodyRow")) {
      const cells = cellTexts(row);
      const player = readPlayer(row);
      const pickNumber = integerFrom(cells[0]);
      if (!player || !pickNumber) continue;
      picks.push({
        pickNumber,
        round: roundIndex + 1,
        playerId: player.playerId,
        player: player.name,
        nflTeam: player.team,
        position: player.position,
        team: cells[2] ?? "",
        projectedPoints: numberFrom(cells[4]),
        rank: integerFrom(cells[5]),
      });
    }
  });
  return picks.sort((a, b) => a.pickNumber - b.pickNumber);
}

function readRoster(ctx) {
  const table = [...document.querySelectorAll("table")].find((candidate) => {
    const firstRow = candidate.querySelector("tr");
    const headings = [...(firstRow?.querySelectorAll("th, td") ?? [])].map((cell) => cleanText(cell.textContent).toUpperCase());
    return headings[0] === "POS" && headings[1] === "PLAYER" && headings[2] === "BYE";
  });
  if (!table) {
    if (document.querySelector(".inner-column")) ctx.report({ phase: "roster", code: "table_missing" });
    return [];
  }
  return [...table.querySelectorAll("tr")].map((row) => {
    const cells = [...row.querySelectorAll("th, td")].map((cell) => cleanText(cell.textContent));
    return { slot: cells[0] ?? "", player: cells[1] ?? "", byeWeek: integerFrom(cells[2]) };
  }).filter((entry) => entry.slot && entry.slot.toUpperCase() !== "POS");
}

function countCompletedPicks() {
  return [...document.querySelectorAll(".pick-history-tables .pick-history-table .public_fixedDataTable_bodyRow")]
    .filter((row) => integerFrom(cellTexts(row)[0]) !== null).length;
}

function findPlayerAction(playerId, action) {
  return document.querySelector(`.draft-players button.Button--${action}.action-btn[data-player-id="${playerId}"]`)
    ?? document.querySelector(`button.Button--${action}.action-btn[data-player-id="${playerId}"]`);
}

function findQueueButton(playerId, queuedPanelOnly) {
  const prefix = queuedPanelOnly ? ".pick-queue " : "";
  return document.querySelector(`${prefix}button.Button--dequeue[data-player-id="${playerId}"]`);
}

function playerIdSchema() {
  return {
    type: "object",
    properties: { playerId: { type: "string", pattern: "^-?[0-9]+$", description: "Stable ESPN player ID, including signed D/ST IDs." } },
    required: ["playerId"],
  };
}

function validatePlayerId(value, ctx) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^-?\d+$/.test(id) || id.length > 21) throw ctx.error("input", "invalid_player_id", "The ESPN player ID is invalid");
  return id;
}

function cellTexts(row) {
  return [...row.querySelectorAll(".public_fixedDataTableCell_cellContent")]
    .map((cell) => cleanText(cell.textContent));
}

function playerIdFromImage(root) {
  const source = root.querySelector?.('.player-headshot img[src*="/players/full/"]')?.getAttribute("src") ?? "";
  return source.match(/\/players\/full\/(-?\d+)\.png/i)?.[1] ?? null;
}

function defensePlayerId(team, position) {
  if (position !== "D/ST") return null;
  const proTeamId = NFL_PRO_TEAM_IDS[team];
  return proTeamId ? String(-16000 - proTeamId) : null;
}

function findPositionSelect() {
  return [...document.querySelectorAll("select")].find((select) => {
    const labels = [...select.options].map((option) => cleanText(option.textContent));
    return labels.includes("All Pos.") && labels.includes("D/ST") && labels.includes("K");
  }) ?? null;
}

function readPositionFilter() {
  const select = findPositionSelect();
  const selected = select ? [...select.options].find((option) => option.selected || option.hasAttribute("selected")) : null;
  return cleanText(selected?.textContent ?? select?.selectedOptions?.[0]?.textContent ?? select?.options?.[select.selectedIndex]?.textContent) || null;
}

async function applyPositionFilter(position, signal, ctx) {
  const select = findPositionSelect();
  if (!select) throw ctx.error("dom", "position_filter_missing", "The ESPN player position filter is not present");
  const option = [...select.options].find((candidate) => cleanText(candidate.textContent) === position);
  if (!option) throw ctx.error("dom", "position_filter_option_missing", "The requested ESPN position filter is not present");
  if (isOptionSelected(select, option)) return;
  for (const candidate of select.options) {
    candidate.selected = candidate === option;
    candidate.toggleAttribute("selected", candidate === option);
  }
  select.value = option.value;
  select.dispatchEvent(new window.Event("input", { bubbles: true }));
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => {
    const players = readAvailablePlayers();
    return isOptionSelected(select, option) && (!players.length || players.some((player) => positionMatches(player.position, position)));
  }, signal, 4000);
  if (!isOptionSelected(select, option)) {
    throw ctx.error("state", "position_filter_change_unconfirmed", "ESPN did not confirm the requested position filter");
  }
}

function isOptionSelected(select, option) {
  return option.selected || option.hasAttribute("selected") || select.value === option.value;
}

function positionMatches(playerPosition, filterPosition) {
  return filterPosition === "FLEX" ? ["RB", "WR", "TE"].includes(playerPosition) : playerPosition === filterPosition;
}

const NFL_PRO_TEAM_IDS = Object.freeze({
  ATL: 1, BUF: 2, CHI: 3, CIN: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8,
  GB: 9, TEN: 10, IND: 11, KC: 12, LV: 13, LAR: 14, MIA: 15, MIN: 16,
  NE: 17, NO: 18, NYG: 19, NYJ: 20, PHI: 21, ARI: 22, PIT: 23, LAC: 24,
  SF: 25, SEA: 26, TB: 27, WSH: 28, CAR: 29, JAX: 30, BAL: 33, HOU: 34,
});

function parseClock(value) {
  const match = cleanText(value).match(/(\d+):(\d+)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function integerFrom(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : null;
}

function numberFrom(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function waitFor(predicate, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (predicate() || Date.now() - startedAt >= timeoutMs) return resolve();
      setTimeout(check, 100);
    };
    check();
  });
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
