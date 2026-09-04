# Local adapter health events

Dominaitrix records a small local event for adapter initialization, registration, and tool execution. The popup summarizes recent failures and lets the user export the history for a bug report.

An event may contain:

- adapter ID and version;
- tool name;
- phase and success or failure outcome;
- normalized error category and code;
- duration bucket;
- browser version and UTC timestamp; and
- page origin and an adapter-supplied route label.

Events must not contain tool arguments, DOM text, response bodies, cookies, headers, tokens, full URLs, query strings, user IDs, league IDs, or stack traces. They are retained only in `chrome.storage.local`, up to the configured cap, and are never uploaded by the extension.
