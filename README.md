# GitHub Changelog Canvas

A light-mode reader for the [GitHub Changelog](https://github.blog/changelog/), built as a [GitHub Copilot CLI](https://github.com/github/copilot-cli) **canvas extension**.

It turns the changelog into a focused reading experience inside Copilot:

- 📰 **Header navigator** — move between updates with Prev / Next (or ← / → arrow keys).
- 📄 **One article at a time** — full content rendered in a clean, forced **light theme** (images and animated `<video>` clips included).
- ✨ **AI summary page** — page 0 is an LLM-generated, theme-grouped overview of everything you *haven't read yet*, generated on demand by Copilot.
- 🗓️ **Last-read tracking** — remembers the date you last caught up, so "unread" actually means unread. One click to **Mark all read**.
- 💬 **Discuss with Copilot** — on any article, start a conversation about it; the article's text is injected as context automatically.

## How it works

The extension declares a canvas to the Copilot runtime via the `@github/copilot-sdk`. Each open canvas instance runs a tiny loopback HTTP server that serves the reading UI and JSON state endpoints. A few agent-callable actions and an `onUserPromptSubmitted` hook connect the reader to the chat:

| File | Responsibility |
|------|----------------|
| `extension.mjs` | Wiring: HTTP server per instance, canvas + actions, `session.send` endpoints (`/api/discuss`, `/api/summarize`), the context hook. |
| `feed.mjs` | Fetch + parse the changelog RSS feed (`https://github.blog/changelog/feed/`), decode entities, sanitize HTML, extract plain text, cache. |
| `store.mjs` | Durable per-user state (last-read date, selection, generated summary) under `$COPILOT_HOME/extensions/changelog-reader/artifacts/`. |
| `ui.mjs` | The light-mode reading pane: header navigator, single-article view, summary page, and a tiny Markdown renderer. |

### Agent actions

- `list_changelog_entries` — recent entries, newest first (optionally only unread).
- `get_changelog_article` — full readable text by id/url (or the selected article).
- `get_selected_article` — the article the user picked via "Discuss with Copilot".
- `get_unread_for_summary` — full text of every unread article, for building the summary.
- `set_unread_summary` — store the Markdown summary shown on page 0.
- `mark_changelog_read` / `changelog_status` — read-state management.

## Install

This is a Copilot CLI canvas extension. Drop the folder into one of the discovered extension locations:

- **User scope** (recommended): `$COPILOT_HOME/extensions/changelog-reader/` (defaults to `~/.copilot/extensions/changelog-reader/`)
- **Project scope**: `<repo>/.github/extensions/changelog-reader/`

```sh
git clone https://github.com/Jfhelin/github-changelog-canvas.git \
  ~/.copilot/extensions/changelog-reader
```

Then reload extensions in Copilot CLI (or restart it) and open the **GitHub Changelog** canvas.

> The `@github/copilot-sdk` import is resolved automatically by the Copilot CLI — no `package.json` or `node_modules` required.

## Notes

- The entry file **must** be named `extension.mjs` and live in an immediate subdirectory of a discovered extensions folder.
- Personal read-state lives in `artifacts/` and is intentionally **not** committed (see `.gitignore`).
- `stdout` is reserved for JSON-RPC; the extension never uses `console.log` (it uses `session.log`).

## License

[MIT](./LICENSE)
