# YoYoStr project rules for Codex

- Static web app (HTML/CSS/JS) deployed on any static host. For now, files live in `/docs`.
- No frameworks yet. No build steps.
- Nostr is the source of truth for content/config (tracks, tutorials, etc.). `docs/data/tracks.json` is fallback/bootstrap data.
- Keep changes minimal and show diffs before applying.
- Use relative paths so the site works at a domain root or a subpath.
