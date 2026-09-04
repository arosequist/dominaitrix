# Adapter contract

## Metadata

`adapter.json` is publisher-reviewed registry metadata. Required fields are `id`, `name`, `version`, `description`, `matches`, `world`, `compatibility`, and `tools`.

- IDs use lowercase words separated by hyphens and match the directory name.
- Every adapter directory whose name does not start with `_` is published. Keep templates and drafts in underscore-prefixed directories.
- Increment the version whenever behavior or compatibility changes.
- Match patterns should cover only required site routes.
- `world` is `USER_SCRIPT` unless access to page JavaScript is essential.
- `compatibility.lastVerified` is the date of an actual check, not the edit date.
- Each tool summary names its risk as `read-only`, `reversible`, or `consequential`.

## Source

`adapter.js` is a self-contained classic script loaded after `extension/runtime/adapter-runtime.js`. It calls:

```js
DOMinAItrix.defineAdapter({
  meta: { id: "site-id", version: "0.1.0", route: () => "stable-route-label" },
  tools: [],
});
```

Tool definitions follow WebMCP's imperative shape: `name`, `description`, `inputSchema`, `annotations`, and `execute`. The execute callback receives `(args, { signal, ctx })`.

Available runtime helpers:

- `ctx.dom.required(selector, root?)` throws `dom/selector_missing` when absent.
- `ctx.dom.all(selector, root?)` returns a plain array.
- `ctx.http.json(url, options?)` includes same-origin credentials and normalizes common HTTP failures.
- `ctx.error(category, code, safeMessage)` constructs an expected adapter error.
- `ctx.report(event)` emits a minimized custom health event when an adapter needs an additional phase measurement.

Use fixed route labels such as `draft-room`, not paths containing user, league, order, or document identifiers.

## Tool results

Return WebMCP structured content. Serialize structured site values into a text content item until richer WebMCP result types are deliberately supported:

```js
return {
  content: [{ type: "text", text: JSON.stringify(result) }],
};
```

Do not return secrets, hidden anti-forgery values, or fields unrelated to the tool's documented purpose.

## Reliability

- Read mutable identifiers and state at invocation time.
- Pass the invocation abort signal into fetches and waits.
- Bound waits and pagination.
- For writes, reject stale or ambiguous state rather than guessing.
- Verify the postcondition from fresh state.
- Prefer stable attributes and accessible semantics over generated CSS classes.
- Report expected site drift with stable codes rather than leaking raw exceptions.
