import assert from "node:assert/strict";
import test from "node:test";
import { loadAdapter, parseToolResult } from "./helpers/adapter-harness.js";

const draftHtml = `<!doctype html><html><body>
  <main>
    <h1>ESPN Fantasy Football Draft - Synthetic League</h1>
    <div class="clock__label">RND 3 OF 16</div>
    <div class="clock__content">00:27</div>
    <div class="current-pick-module-container"><div class="on-the-clock">ON THE CLOCK: PICK 20</div>Synthetic Team</div>
    <h3>You are on the clock!</h3>
    <select><option selected>My Test Team</option></select>
    <select class="position-filter">
      <option value="all" selected>All Pos.</option><option value="qb">QB</option><option value="rb">RB</option>
      <option value="wr">WR</option><option value="te">TE</option><option value="flex">FLEX</option>
      <option value="dst">D/ST</option><option value="k">K</option>
    </select>
    <div class="autoPick-toggle"><label><input type="checkbox" checked></label></div>
    <div class="pick-queue"></div>
    <section class="draft-players">
      <div class="public_fixedDataTable_bodyRow">
        <div class="public_fixedDataTableCell_cellContent">26</div>
        <div class="public_fixedDataTableCell_cellContent">
          <span class="playerinfo__playername"><a title="Josh Allen">Josh Allen</a></span>
          <span class="playerinfo__playerteam">BUF</span><span class="playerinfo__playerpos">QB</span>
        </div>
        <div class="public_fixedDataTableCell_cellContent"><button class="Button--queue action-btn" data-player-id="3918298">QUEUE</button></div>
        <div class="public_fixedDataTableCell_cellContent">7</div>
        <div class="public_fixedDataTableCell_cellContent">370.6</div>
      </div>
      <div class="public_fixedDataTable_bodyRow">
        <div class="public_fixedDataTableCell_cellContent">150</div>
        <div class="public_fixedDataTableCell_cellContent">
          <span class="playerinfo__playername"><a title="Steelers D/ST">Steelers D/ST</a></span>
          <span class="playerinfo__playerteam">PIT</span><span class="playerinfo__playerpos">D/ST</span>
        </div>
        <div class="public_fixedDataTableCell_cellContent"><button class="Button--queue action-btn" data-player-id="-16023">QUEUE</button></div>
        <div class="public_fixedDataTableCell_cellContent">5</div>
        <div class="public_fixedDataTableCell_cellContent">120.4</div>
      </div>
    </section>
    <table><tbody><tr><th>POS</th><th>PLAYER</th><th>BYE</th></tr>
      <tr><td>QB</td><td>Empty</td><td>-</td></tr>
      <tr><td>WR</td><td>Ja'Marr Chase</td><td>6</td></tr>
    </tbody></table>
    <div class="pick-history-tables">
      <div class="pick-history-table"><div class="public_fixedDataTable_bodyRow">
        <div class="public_fixedDataTableCell_cellContent">1</div>
        <div class="public_fixedDataTableCell_cellContent">
          <div class="player-headshot"><img src="https://a.espncdn.com/i/headshots/nfl/players/full/4430807.png"></div>
          <span class="playerinfo__playername"><a title="Bijan Robinson">Bijan Robinson</a></span>
          <span class="playerinfo__playerteam">ATL</span><span class="playerinfo__playerpos">RB</span>
        </div>
        <div class="public_fixedDataTableCell_cellContent">Team 1</div>
        <div class="public_fixedDataTableCell_cellContent">370.8</div>
        <div class="public_fixedDataTableCell_cellContent">352.8</div>
        <div class="public_fixedDataTableCell_cellContent">2</div>
      </div>
      <div class="public_fixedDataTable_bodyRow">
        <div class="public_fixedDataTableCell_cellContent">2</div>
        <div class="public_fixedDataTableCell_cellContent">
          <div class="player-headshot"><img src="https://a.espncdn.com/i/teamlogos/nfl/500/pit.png"></div>
          <span class="playerinfo__playername"><a title="Steelers D/ST">Steelers D/ST</a></span>
          <span class="playerinfo__playerteam">PIT</span><span class="playerinfo__playerpos">D/ST</span>
        </div>
        <div class="public_fixedDataTableCell_cellContent">Team 2</div>
        <div class="public_fixedDataTableCell_cellContent">130</div>
        <div class="public_fixedDataTableCell_cellContent">120.4</div>
        <div class="public_fixedDataTableCell_cellContent">150</div>
      </div></div>
    </div>
  </main>
</body></html>`;

test("ESPN Fantasy adapter reads live draft state", async () => {
  const harness = await loadAdapter("../../adapters/espn-fantasy/adapter.js", draftHtml, {
    url: "https://fantasy.espn.com/football/draft?leagueId=123",
  });
  harness.document.querySelector(".autoPick-toggle input").checked = true;
  const output = parseToolResult(await harness.tools.get_espn_fantasy_draft_state.execute({}));
  assert.equal(output.league, "Synthetic League");
  assert.equal(output.currentRound, 3);
  assert.equal(output.totalRounds, 16);
  assert.equal(output.secondsRemaining, 27);
  assert.equal(output.currentPickNumber, 20);
  assert.equal(output.ownTeam, "My Test Team");
  assert.equal(output.draftComplete, false);
  assert.equal(output.onClock, true);
  assert.equal(output.autopick, true);
  assert.equal(output.roster[1].player, "Ja'Marr Chase");
  assert.equal(output.completedPickCount, 2);
});

test("ESPN Fantasy adapter returns stable player IDs and pick history", async () => {
  const harness = await loadAdapter("../../adapters/espn-fantasy/adapter.js", draftHtml, {
    url: "https://fantasy.espn.com/football/draft?leagueId=123",
  });
  const available = parseToolResult(await harness.tools.list_espn_fantasy_available_players.execute({}));
  assert.deepEqual(available.players[0], {
    playerId: "3918298",
    name: "Josh Allen",
    team: "BUF",
    position: "QB",
    rank: 26,
    byeWeek: 7,
    projectedPoints: 370.6,
    queued: false,
  });

  const history = parseToolResult(await harness.tools.list_espn_fantasy_pick_history.execute({}));
  assert.deepEqual(history.picks[0], {
    pickNumber: 1,
    round: 1,
    playerId: "4430807",
    player: "Bijan Robinson",
    nflTeam: "ATL",
    position: "RB",
    team: "Team 1",
    projectedPoints: 352.8,
    rank: 2,
  });
  assert.deepEqual(history.picks[1], {
    pickNumber: 2,
    round: 1,
    playerId: "-16023",
    player: "Steelers D/ST",
    nflTeam: "PIT",
    position: "D/ST",
    team: "Team 2",
    projectedPoints: 120.4,
    rank: 150,
  });
});

test("ESPN Fantasy adapter activates position views and accepts signed D/ST IDs", async () => {
  const harness = await loadAdapter("../../adapters/espn-fantasy/adapter.js", draftHtml, {
    url: "https://fantasy.espn.com/football/draft?leagueId=123",
  });
  const positionSelect = harness.document.querySelector(".position-filter");
  let selectedValue = "all";
  Object.defineProperty(positionSelect, "value", {
    configurable: true,
    get: () => selectedValue,
    set: (value) => { selectedValue = value; },
  });
  const available = parseToolResult(await harness.tools.list_espn_fantasy_available_players.execute({ position: "D/ST" }));
  assert.equal(available.activePositionFilter, "D/ST");
  assert.deepEqual(available.players.map((player) => player.playerId), ["-16023"]);

  await assert.rejects(
    harness.tools.queue_espn_fantasy_player.execute({ playerId: "-16023" }),
    (error) => error.code === "queue_unavailable_on_clock",
  );
});

test("ESPN Fantasy adapter rejects a stale consequential draft", async () => {
  const harness = await loadAdapter("../../adapters/espn-fantasy/adapter.js", draftHtml, {
    url: "https://fantasy.espn.com/football/draft?leagueId=123",
  });
  await assert.rejects(
    harness.tools.draft_espn_fantasy_player.execute({ playerId: "-16023", expectedPickNumber: 19 }),
    (error) => error.code === "stale_pick",
  );
});

test("ESPN Fantasy adapter explains how to render a filtered-out draft target", async () => {
  const harness = await loadAdapter("../../adapters/espn-fantasy/adapter.js", draftHtml, {
    url: "https://fantasy.espn.com/football/draft?leagueId=123",
  });
  await assert.rejects(
    harness.tools.draft_espn_fantasy_player.execute({ playerId: "9999999", expectedPickNumber: 20 }),
    (error) => error.code === "player_not_draftable" && /position/i.test(error.message),
  );
});
