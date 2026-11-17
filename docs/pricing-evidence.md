# Reference USD estimates

Verified on 2026-11-17 against Anthropic's [pricing table](https://platform.claude.com/docs/en/about-claude/pricing).
Amounts are USD per million tokens; columns are ordinary input / output / cache read:

| Exact model IDs | Rates |
| --- | --- |
| `claude-fable-5-2`, `claude-mythos-5-2` | 8 / 40 / 0.20 |
| `claude-fable-5-1`, `claude-mythos-5-1` | 10 / 50 / 0.25 |
| `claude-fable-5`, `claude-mythos-5` | 10 / 50 / 1 |
| `claude-opus-5-5` | 4 / 20 / 0.20 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` | 5 / 25 / 0.50 |
| `claude-sonnet-5-5` | 2 / 10 / 0.10 |
| `claude-sonnet-5` | 2 / 10 / 0.20 |
| `claude-sonnet-4-6` | 3 / 15 / 0.30 |
| `claude-haiku-5-5` | 0.10 / 0.50 / 0.01 |

Haiku 5.5 requests exceeding 100,000 total input tokens use 5x these rates. The threshold includes cache reads/writes.
Other current models retain their listed Standard rates across their context windows.

Historical allowlist entries follow the official model pages:

- [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview):
  `claude-opus-4-5-20251101` and alias `claude-opus-4-5`: 5 / 25 / 0.50.
- [Sonnet 4.5](https://platform.claude.com/docs/en/models/sonnet-4-5/overview):
  `claude-sonnet-4-5-20250929` and alias `claude-sonnet-4-5`: 3 / 15 / 0.30.
- [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview):
  `claude-haiku-4-5-20251001` and alias `claude-haiku-4-5`: 1 / 5 / 0.10.

[Model versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) distinguishes
historical convenience aliases from pinned dateless IDs beginning with generation 4.6. No prefix, arbitrary date,
provider identifier, or informal model-name inference is applied; unlisted IDs remain unpriced.

[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) defines ordinary
`input_tokens` separately from `cache_read_input_tokens` and `cache_creation_input_tokens`.
Total input is their sum. Native `cache_creation.ephemeral_5m_input_tokens` costs 1.25x ordinary input;
`ephemeral_1h_input_tokens` costs 2x. Complete valid splits use these rates without an extra estimation marker.

Daily Usage 0.1.5 uses the `claude-client-estimate` basis dated 2026-11-17. Its cache-write fallback follows
the arithmetic observed in the native Claude 2.1.326 client: reported one-hour writes use the one-hour price;
total writes minus reported one-hour writes use the five-minute price. Missing buckets are treated as unknown,
with zero known one-hour writes when that field is absent. When valid reported buckets do not cover total writes,
the request and visible dollar amounts are marked estimated. For example, Opus 5.5 total writes 4231 with
5m=2706 and 1h=0 produce $0.021155, while complete writes 1000 with 5m=600 and 1h=400 produce $0.0062.
This is a local reference estimate, not evidence of subscription charging or included allowance weights.

Negative, noninteger, nonfinite, malformed or overfilled split values retain token counts while excluding
those writes from USD and flagging incomplete pricing. Invalid TTL metadata survives response merging and raw
cache reuse. The raw cache version remains unchanged; old caches that already reduced invalid TTLs to null
cannot distinguish them from missing TTLs, so those historical unknowns are estimated and labeled accordingly.

This is a dated reference estimate using Standard global API rates, independent of a subscription invoice. It does not infer
actual account billing, negotiated discounts, Fast/Batch/data-residency modifiers, or server-tool fees.
Unknown models, missing usage, conflicting snapshots and invalid cache TTLs are visible coverage gaps;
USD includes only the supported token subtotal. Zero is never evidence that an unpriced request was free.

Snapshots with the prior `standard` basis require both endpoints to update after full structural and size
validation; malformed snapshots stay invalid. Saved dollar summaries are not reused. Raw parsed events remain
cached and are repriced only by the next explicit on-demand query, with no startup scan or background polling.
