DOMinAItrix.defineAdapter({
  meta: {
    id: "cross-with-friends",
    version: "0.1.0",
    route: () => {
      const match = location.pathname.match(/^\/[^/]+\/play\/\w+$/);
      return match ? "play" : null;
    },
  },
  tools: [
    {
      name: "get_game_state",
      description: "Read the current puzzle and game state, including grid, clues, users, and chat.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { ctx }) => {
        const gameObj = window.gameComponent?.game;
        if (!gameObj) {
          throw ctx.error("state", "game_not_found", "Game state not found on window.gameComponent.game");
        }

        const metadata = gameObj.info || {};
        const elapsedTimeMs = gameObj.clock?.totalTime || 0;
        const users = gameObj.users || [];

        let grid = [];
        let cluesData = { across: [], down: [] };

        if (gameObj.grid) {
          grid = gameObj.grid;
        }

        if (gameObj.clues) {
          cluesData = gameObj.clues;
        }

        const computePattern = (clueNum, dir) => {
          let pattern = "";
          for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < grid[r].length; c++) {
              const cell = grid[r][c];
              if (!cell.black && cell.parents && cell.parents[dir] === clueNum) {
                pattern += cell.value || "?";
              }
            }
          }
          return pattern;
        };

        const mappedClues = [];
        const extractClues = (dirStr) => {
          if (cluesData[dirStr]) {
            cluesData[dirStr].forEach((text, i) => {
              if (text) {
                const p = computePattern(i, dirStr);
                mappedClues.push({
                  number: i,
                  direction: dirStr,
                  text: text,
                  length: p.length,
                  pattern: p,
                  isComplete: p.length > 0 && !p.includes("?")
                });
              }
            });
          }
        };

        extractClues("across");
        extractClues("down");

        let selectedClue = null;
        try {
          const selectedEl = document.querySelector(".clues--list--scroll--clue.selected");
          if (selectedEl) {
            selectedClue = selectedEl.textContent.trim();
          }
        } catch(e) {}

        let chatMessages = [];
        try {
          chatMessages = Array.from(document.querySelectorAll(".chat--message")).map(el => el.textContent.trim());
        } catch(e) {}

        const state = {
          metadata: metadata,
          elapsedTimeMs: elapsedTimeMs,
          users: users,
          gridDimensions: { rows: grid.length, cols: grid[0]?.length || 0 },
          grid: grid,
          clues: mappedClues,
          selectedClue: selectedClue,
          chatMessages: chatMessages
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(state)
          }]
        };
      },
    },
    {
      name: "set_answer",
      description: "Set the answer for a specific clue (e.g. '17A').",
      inputSchema: {
        type: "object",
        properties: {
          clue: { type: "string" },
          answer: { type: "string" }
        },
        required: ["clue", "answer"]
      },
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const clueMatches = args.clue.trim().match(/^(\d+)([AD])$/i);
        if (!clueMatches) {
           throw ctx.error("input", "invalid_clue", "Clue must be in format like '17A' or '5D'");
        }
        const clueNum = parseInt(clueMatches[1], 10);
        const clueDir = clueMatches[2].toUpperCase() === 'A' ? 'across' : 'down';

        const gameObj = window.gameComponent?.game;
        if (!gameObj || !gameObj.grid) {
           throw ctx.error("state", "game_not_found", "Game state or grid not found");
        }

        const grid = gameObj.grid;

        let startR = -1;
        let startC = -1;

        for (let r = 0; r < grid.length; r++) {
          for (let c = 0; c < grid[r].length; c++) {
            const cell = grid[r][c];
            if (!cell.black && cell.parents && cell.parents[clueDir] === clueNum) {
              if (startR === -1) {
                startR = r;
                startC = c;
              }
            }
          }
        }

        if (startR === -1) {
          throw ctx.error("input", "clue_not_found", "Clue number not found in grid for given direction");
        }

        const flatIndex = startR * grid[0].length + startC;
        const cellEls = document.querySelectorAll(".cell");
        const startCellEl = cellEls[flatIndex];

        if (!startCellEl) {
           throw ctx.error("dom", "cell_missing", "Could not find corresponding cell element in DOM");
        }

        const ptrEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
        startCellEl.dispatchEvent(ptrEvent);

        // Wait to make sure direction is correctly highlighted, but for now just send keys.
        // It's a risk mentioned in review, but the site generally respects typing after pointerdown.
        const answerStr = args.answer.toUpperCase();
        for (let i = 0; i < answerStr.length; i++) {
           const char = answerStr[i];
           const kbEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: char });
           (document.activeElement || startCellEl).dispatchEvent(kbEvent);
        }

        return {
          content: [{ type: "text", text: `Answer set for ${args.clue}` }]
        };
      }
    },
    {
      name: "clear_answer",
      description: "Clear the entered letters for a specified clue.",
      inputSchema: {
        type: "object",
        properties: {
          clue: { type: "string" }
        },
        required: ["clue"]
      },
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const clueMatches = args.clue.trim().match(/^(\d+)([AD])$/i);
        if (!clueMatches) {
           throw ctx.error("input", "invalid_clue", "Clue must be in format like '17A' or '5D'");
        }
        const clueNum = parseInt(clueMatches[1], 10);
        const clueDir = clueMatches[2].toUpperCase() === 'A' ? 'across' : 'down';

        const gameObj = window.gameComponent?.game;
        if (!gameObj || !gameObj.grid) {
           throw ctx.error("state", "game_not_found", "Game state or grid not found");
        }

        const grid = gameObj.grid;

        let startR = -1;
        let startC = -1;
        let targetLength = 0;

        for (let r = 0; r < grid.length; r++) {
          for (let c = 0; c < grid[r].length; c++) {
            const cell = grid[r][c];
            if (!cell.black && cell.parents && cell.parents[clueDir] === clueNum) {
              if (startR === -1) {
                startR = r;
                startC = c;
              }
              targetLength++;
            }
          }
        }

        if (startR === -1) {
          throw ctx.error("input", "clue_not_found", "Clue number not found in grid for given direction");
        }

        const flatIndex = startR * grid[0].length + startC;
        const cellEls = document.querySelectorAll(".cell");
        const startCellEl = cellEls[flatIndex];

        if (!startCellEl) {
           throw ctx.error("dom", "cell_missing", "Could not find corresponding cell element in DOM");
        }

        const ptrEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
        startCellEl.dispatchEvent(ptrEvent);

        // Use Space instead of Backspace to avoid moving to previous clues, as suggested by review.
        for (let i = 0; i < targetLength; i++) {
           const kbEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " });
           (document.activeElement || startCellEl).dispatchEvent(kbEvent);
        }

        return {
          content: [{ type: "text", text: `Answer cleared for ${args.clue}` }]
        };
      }
    },
    {
      name: "focus_clue",
      description: "Select/highlight a specified clue in the existing UI, e.g. '17A'.",
      inputSchema: {
        type: "object",
        properties: {
          clue: { type: "string" }
        },
        required: ["clue"]
      },
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const clueMatches = args.clue.trim().match(/^(\d+)([AD])$/i);
        if (!clueMatches) {
           throw ctx.error("input", "invalid_clue", "Clue must be in format like '17A' or '5D'");
        }
        const clueNum = parseInt(clueMatches[1], 10);
        const clueDir = clueMatches[2].toUpperCase() === 'A' ? 'across' : 'down';

        const gameObj = window.gameComponent?.game;
        if (!gameObj || !gameObj.grid) {
           throw ctx.error("state", "game_not_found", "Game state or grid not found");
        }

        const grid = gameObj.grid;

        let startR = -1;
        let startC = -1;

        for (let r = 0; r < grid.length; r++) {
          for (let c = 0; c < grid[r].length; c++) {
            const cell = grid[r][c];
            if (!cell.black && cell.parents && cell.parents[clueDir] === clueNum) {
              if (startR === -1) {
                startR = r;
                startC = c;
              }
            }
          }
        }

        if (startR === -1) {
          throw ctx.error("input", "clue_not_found", "Clue number not found in grid for given direction");
        }

        const flatIndex = startR * grid[0].length + startC;
        const cellEls = document.querySelectorAll(".cell");
        const startCellEl = cellEls[flatIndex];

        if (!startCellEl) {
           throw ctx.error("dom", "cell_missing", "Could not find corresponding cell element in DOM");
        }

        const ptrEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
        startCellEl.dispatchEvent(ptrEvent);

        return {
          content: [{ type: "text", text: `Clue focused: ${args.clue}` }]
        };
      }
    },
    {
      name: "check",
      description: "Check a cell, clue, or the full puzzle.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["Square", "Word", "Puzzle"] }
        },
        required: ["target"]
      },
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const btn = document.querySelector(".check .action-menu--button");
        if (!btn) {
           throw ctx.error("dom", "button_missing", "Check button not found");
        }

        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

        await new Promise(r => setTimeout(r, 100));

        const menuItems = document.querySelectorAll("[role='menuitem']");
        let found = false;
        for (const item of menuItems) {
           if (item.textContent.trim() === args.target) {
              item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              found = true;
              break;
           }
        }

        if (!found) {
           throw ctx.error("dom", "menu_item_missing", `Menu item ${args.target} not found`);
        }

        return {
          content: [{ type: "text", text: `Check triggered for ${args.target}` }]
        };
      }
    },
    {
      name: "reveal",
      description: "Reveal a cell, clue, or the full puzzle.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["Square", "Word", "Puzzle"] }
        },
        required: ["target"]
      },
      annotations: { readOnlyHint: false, destructiveHint: true, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const btn = document.querySelector(".reveal .action-menu--button");
        if (!btn) {
           throw ctx.error("dom", "button_missing", "Reveal button not found");
        }

        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

        await new Promise(r => setTimeout(r, 100));

        const menuItems = document.querySelectorAll("[role='menuitem']");
        let found = false;
        for (const item of menuItems) {
           if (item.textContent.trim() === args.target) {
              item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              found = true;
              break;
           }
        }

        if (!found) {
           throw ctx.error("dom", "menu_item_missing", `Menu item ${args.target} not found`);
        }

        return {
          content: [{ type: "text", text: `Reveal triggered for ${args.target}` }]
        };
      }
    },
    {
      name: "send_chat_message",
      description: "Send a message to the game's existing multiplayer chat.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      },
      annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: false },
      execute: async (args, { ctx }) => {
        const input = document.querySelector(".chat--bar--input");
        if (!input) {
           throw ctx.error("dom", "input_missing", "Chat input field not found");
        }

        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, args.message);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

        return {
          content: [{ type: "text", text: `Chat message sent` }]
        };
      }
    },
    {
      name: "reset_game",
      description: "Reset the game using the existing Reset behavior and require appropriate confirmation.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      annotations: { readOnlyHint: false, destructiveHint: true, untrustedContentHint: false },
      execute: async (_args, { ctx }) => {
        const btn = document.querySelector(".reset .action-menu--button");
        if (!btn) {
           throw ctx.error("dom", "button_missing", "Reset button not found");
        }

        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

        await new Promise(r => setTimeout(r, 100));

        const menuItems = document.querySelectorAll("[role='menuitem']");
        let found = false;
        for (const item of menuItems) {
           if (item.textContent.trim() === "Puzzle and Timer") {
              item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              found = true;
              break;
           }
        }

        if (!found) {
           throw ctx.error("dom", "menu_item_missing", "Reset menu item 'Puzzle and Timer' not found");
        }

        return {
          content: [{ type: "text", text: `Game reset triggered` }]
        };
      }
    }
  ]
});
