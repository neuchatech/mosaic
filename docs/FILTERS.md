# Filter DSL

A filter is data, never executable code. This makes Codex-generated filters inspectable, editable, and safe to store.

Expressions support:

- clauses on any product path, including `scores.style_match` and `attributes.rise`;
- nested `and` / `or` groups;
- unary `not`;
- equality, containment, membership, bounds, ranges, presence, and absence;
- sorting on any scalar path and a hard result limit.

Canonical fields include `kind`, `source`, `brand`, `name`, `description`, `price`, `originalPrice`, the computed `discountPercent`, `currency`, `category`, `color`, `colorFamily`, `fit`, `materials`, `tags`, `sizes`, `available`, `decision`, timestamps, `scores.*`, and `attributes.*`.

The same schema is used by the HTTP API, Codex bridge, MCP tools, and tests. Deterministic examples live in the filter test suite.
