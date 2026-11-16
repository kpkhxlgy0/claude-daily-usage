# Third-party notices

This MIT-licensed Claude++ tweak adapts the settings surface, lazy worker lifecycle, aggregate validation and
Windows atomic-publication handling from [Daily Usage for Codex++](https://github.com/kpkhxlgy0/daily-usage),
version0.1.3, commit b1497a01106747d5bacd20d8014815659b47be6a (Copyright2026 kpkhxlgy0, MIT).

Renderer bundling and Windows install/disable scripts follow
[Session Stats for Claude++](https://github.com/kpkhxlgy0/claude-session-stats) (Copyright2026 kpkhxlgy0, MIT).
Its read-only Desktop/CLI identity and process-start validators are vendored under `src/vendor/session-stats/`
with their MIT license. They are bundled source, not a dependency on an installed Session Stats tweak.
Claude data parsing and pricing are separately adapted; no upstream Claude application bundle is distributed.

jsdom is a development-only MIT dependency. Runtime has no npm dependencies. Node.js and the host Claude++ runtime
retain their own licenses; they are not included in this tweak's archive.
