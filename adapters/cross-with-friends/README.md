# Cross with Friends adapter

Implements [issue #1](https://github.com/arosequist/dominaitrix/issues/1) for loaded, standard games on `/game/:gid` and `/beta/game/:gid`, on the bare and `www` HTTPS hosts. No account credentials or browser storage are read by the adapter.

## Tools and effects

| Tool | Behavior |
| --- | --- |
| `get_game_state` | Reads entered grid cells, puzzle metadata, across/down clues with coordinates/length/pattern/filled status, local selection, current player, known players, displayed timer, status, and latest 30 chat messages. Returns a canonical invite URL without query parameters. |
| `set_answer` | Enters one ASCII letter per cell through the site's existing grid handler, including its pencil/autocheck settings. Updates crossings. Rejects conflicts before writing unless `overwrite: true`. |
| `clear_answer` | Clears editable letters in the clue, including crossings. Does not unlock checked/revealed cells. |
| `focus_clue` | Updates the mounted Player's local selection and direction; no grid, cursor broadcast, or clock event. |
| `check` | Calls the site's Check operation, which changes shared correctness marks, clears pencil marks, and locks correct entries. Supports cell, clue, and puzzle scopes. |
| `reveal` | Calls the site's Reveal operation for cell, clue, or puzzle scope, after explicit confirmation. Returns only the resulting visible grid. |
| `send_chat_message` | Sends up to 1,000 characters through existing multiplayer chat, after explicit confirmation. Cannot unsend. |
| `reset_game` | Calls Reset Puzzle on an unsolved game, after explicit confirmation. Clears entered letters and check/reveal/pencil marks for everyone. Does not request a timer reset. |

Shared operations can advance the site's game clock. All shared mutations require `expectedGameId` and `expectedRevision` from a fresh state read. Revisions count server and pending events, including other players' cursor/chat events; an unrelated event can therefore require a fresh read. They are concurrency guards, not authorization tokens. `reveal`, `reset_game`, and `send_chat_message` also require literal `confirm: true`, supplied only after user authorization. The adapter's confirmation contract replaces the UI dialog when calling the same site action. Tool annotations and registry risks distinguish reads, UI changes, shared edits, and consequential actions.

For example, after reading the state:

```json
{
  "clue": "17A",
  "answer": "ELOPE",
  "expectedGameId": "<gameId from get_game_state>",
  "expectedRevision": "<revision from get_game_state>"
}
```

`check` and `reveal` accept exactly one target: `scope: "cell"` with zero-based `row` and `column`, `scope: "clue"` with a clue identifier, or `scope: "puzzle"` with no coordinates or clue. Reveal additionally requires confirmation. Host restrictions are checked before Check, Reveal, and Reset; contest games cannot Check or Reveal.

## Integration and safety boundary

`MAIN` is necessary to access the application's exposed `window.gameComponent`, its mounted game/Player components, and game model. This avoids replaying socket payloads, discovering private React internals, or reading authentication/storage. The adapter explicitly projects primitive public fields; it never reads the `solution` array, event history contents, or authentication context, and never serializes arbitrary game objects or player session IDs. Black/image cell values are not returned. HTML clue text is converted in an inert template. Unanticipated site exceptions become fixed, sanitized errors.

Writes use the same existing model/handler operations as the UI. The adapter captures the emitted optimistic event ID, waits for the matching server `wsEvent`, and verifies fresh state. It does not treat an optimistic change as success, retry writes, or create its own socket connection. Offline, pending, stale, restricted, archived, and unsupported states fail closed. Listeners are removed on confirmation, rejection, cancellation, or a 12-second timeout.

Answers consist of sequential site events, **not an atomic transaction**. Every target cell is revalidated before each write, including crossing letters and check/reveal flags. A concurrent change stops the remainder; already acknowledged letters remain. A remote edit can still race the server between validation and application because the site does not provide compare-and-swap. Cancellation or a timeout cannot retract an event already sent or placed in the site's offline queue. Read current state before retrying; never automatically resend chat. Answer sequences stop after a 30-second budget plus at most one in-flight confirmation wait.

## Scope and limitations

- No puzzle creation/import, room/embed/replay routes, fencing, hidden-cell variants, or mutations of solved games.
- Read-only state supports visible rebus text (`{TEXT}` in a pattern) and marks image cells (`[image]`); editing rebus or image targets is unsupported. Puzzle-wide Check/Reveal/Reset reject image grids instead of guessing their behavior.
- `completed` means filled, not correct. Patterns use `?` for an empty cell; clue lengths count cells.
- Players are the game's known display names/colors, not a claim that each is currently online. The site uses private identifiers internally; they are not returned.
- `timer.display` is the rendered site clock when mounted; `recordedMilliseconds` is the last accumulated site value, not an independently calculated live elapsed time.
- No reset of the timer, force-reset of a solved game, or automatic retry. Local focus is not broadcast to other players, even though manual site selection normally is.
- The extension's existing match-pattern behavior still applies: when entering a matching game from an unmatched SPA route, a full page load may be needed to install the adapter.

## Verification

On 2026-10-01, inspected the deployed public bundle (`index-Kl6BLeQL.js`) and the site's [public source at `27c781c`](https://github.com/ScaleOvenStove/crosswithfriends/tree/27c781c23fa1bfe0690719afa8cc8e5dcf4fc1ed): `src/pages/Game.js`, `src/components/Game/Game.js`, `src/components/Player/Player.js`, `src/store/game.js`, and `src/lib/reducers/game.js`.

A fresh headless Edge profile created a new isolated game through the site's `new=1` flow. Verified a read-only happy path (5×5 grid, 4 across and 5 down clues, current player, clock), local-only focus with unchanged event revision, and server-confirmed answer entry and clearing. Existing/shared user games and private browser sessions were not accessed. No live chat, reveal, or reset was performed. Check/Reveal/Reset/chat behavior, restrictions, failures, and leakage defenses are verified with synthetic fixtures rather than live multiplayer actions. A shim captured WebMCP registrations for this smoke test; full Chrome extension installation was not exercised.

Run:

```sh
pnpm registry:build
pnpm check
pnpm registry:check
```

The synthetic tests include poison getters for hidden solutions and storage, arbitrary-object serialization guards, sanitized telemetry/errors, route/loading/access failures, confirmation/effect classification, crossing conflicts/races, server echo/postcondition checks, and abort/timeout cleanup. No captured puzzle, chat, bundle, credentials, or session data is checked in.
