# Site exploration

Use the browser surface named by the user; otherwise use an available browser-control workflow capable of inspecting the target site. Authentication remains with the user. Do not request that credentials be pasted into prompts or source files.

## Discover the state model

Identify the narrow page states in which the requested tools are useful. Inspect semantic DOM, application navigation, and requests produced by read-only interactions. For each candidate operation, record locally in working notes:

- required route and preconditions;
- current-state source;
- operation mechanism: structured request, application function, form, or DOM event;
- stable identifiers and validation rules;
- success postcondition;
- expected failures and whether retry is safe.

Do not commit captured response bodies or copied application bundles. Convert observations into the smallest maintainable adapter logic.

## Choose mechanisms

Prefer a structured same-origin request when its contract is clear and the UI already uses it. Prefer application functions when a request would bypass required in-memory state updates. Prefer real form or DOM interaction when the endpoint requires opaque signing, the application contract is unclear, or reproducing it would be more fragile than the interface.

For live collaborative or auction-like interfaces, assume state can change between read and write. Re-read the current turn or revision immediately before a mutation and verify the authoritative state afterward.

## Verification

Start with read-only tools. Exercise expected empty, loading, signed-out, and wrong-route states. State-changing tools require explicit authorization and should use reversible or test data when available. If the live workflow cannot be safely reproduced, implement fixtures or leave the adapter unpublished with a precise verification note.
