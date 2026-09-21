# API design notes

- **Source:** https://claude.ai/chat/00000000-0000-0000-0000-000000000000
- **Provider:** claude (chat)
- **Exported:** 2026-09-21 07:58:00Z by llm-export v1.2.1
- **Messages:** 4 (2 user / 2 assistant)
- **Tool calls:** 2
- **Thinking blocks:** 1

---

## 1. User  ·  2026-09-21 10:14:02Z

How should the public API handle rate limits?
Keep it simple.

---

## 2. Assistant  ·  2026-09-21 10:14:31Z

### [thinking] Thought process

> The question is about client-facing behaviour rather than server enforcement, so the useful answer covers the response shape and what a caller should do with it. Worth checking what the docs already say before answering.

### [tool] search_docs  _(Used a tool)_

**Request**

```json
{
  "query": "rate limits",
  "limit": 5
}
```

**Response**

```json
{
  "results": 3,
  "top": "429 backoff",
  "sections": ["limits", "retry", "quotas"]
}
```

Return `429` with a `Retry-After` header and let the client back off.

Three things worth deciding up front:

- Whether limits are per key or per endpoint
- What the window is, and whether it slides
- Whether a burst allowance exists

The header is the part clients actually need — without it they guess, and guessing means retry storms.

---

## 3. User  ·  2026-09-21 10:16:45Z

What about a per-endpoint override?

---

## 4. Assistant  ·  2026-09-21 10:17:02Z

### [tool] get_config  _(Used a tool)_

**Request**

```json
{
  "section": "limits"
}
```

**Response**

```json
{
  "default_rpm": 60,
  "overrides": {
    "/export": 10
  }
}
```

Overrides are already supported — `/export` sits at 10 requests a minute against a default of 60.

Document the override in the endpoint's own reference rather than only in the limits page, or nobody finds it until they hit it.

---

## Tool call index

| # | msg | tool | request | result |
| --- | --- | --- | --- | --- |
| 1 | 2 | search_docs | { "query": "rate limits", "limit": 5 } | 87 chars |
| 2 | 4 | get_config | { "section": "limits" } | 63 chars |
