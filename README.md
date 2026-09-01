# GitHub Changelog Canvas

A light-mode reader for the [GitHub Changelog](https://github.blog/changelog/) and selected
developer news from Microsoft, GitHub, Azure DevOps, and VS Code, built as a
[GitHub Copilot CLI](https://github.com/github/copilot-cli) **canvas extension**.

It turns the changelog into a focused reading experience inside Copilot:

- 📰 **Header navigator** — move between updates with Prev / Next (or ← / → arrow keys) and return directly to the summary.
- 📄 **One article at a time** — full content rendered in a clean, forced **light theme**, with its source clearly labeled.
- ✨ **AI summary page** — page 0 includes every unread GitHub Changelog update, all official Azure DevOps product updates, and relevant news about GitHub, Copilot, AI and agentic development, VS Code, and code/SDLC security. Each summary bullet links directly to its article page inside the canvas.
- 🗓️ **Last-read tracking** — remembers the date you last caught up, so "unread" actually means unread. One click to **Mark all read**.
- 💬 **Discuss with Copilot** — on any article, start a conversation about it; the article's text is injected as context automatically.

## How it works

The extension declares a canvas to the Copilot runtime via the `@github/copilot-sdk`. Each open canvas instance runs a tiny loopback HTTP server that serves the reading UI and JSON state endpoints. A few agent-callable actions and an `onUserPromptSubmitted` hook connect the reader to the chat:

| File | Responsibility |
|------|----------------|
| `extension.mjs` | Wiring: HTTP server per instance, canvas + actions, `session.send` endpoints (`/api/discuss`, `/api/summarize`), the context hook. |
| `feed.mjs` | Fetch + parse RSS and Atom sources for GitHub, Microsoft Developer Blogs, Azure DevOps, and VS Code; deduplicate, sanitize HTML, extract plain text, and cache. |
| `store.mjs` | Durable per-user state (last-read date, selection, generated summary, relevant external article IDs) under `$COPILOT_HOME/extensions/changelog-reader/artifacts/`. |
| `ui.mjs` | The light-mode reading pane: header navigator, single-article view, summary page, and a tiny Markdown renderer. |

### Agent actions

- `list_changelog_entries` — recent entries, newest first (optionally only unread).
- `get_changelog_article` — full readable text by id/url (or the selected article).
- `get_selected_article` — the article the user picked via "Discuss with Copilot".
- `get_unread_for_summary` — full text of every unread candidate plus the relevance profile.
- `set_unread_summary` — store the Markdown summary and selected relevant external article IDs.
- `mark_changelog_read` / `changelog_status` — read-state management.

## Install

This is a Copilot CLI canvas extension. Drop the folder into one of the discovered extension locations:

- **User scope** (recommended): `$COPILOT_HOME/extensions/changelog-reader/` (defaults to `~/.copilot/extensions/changelog-reader/`)
- **Project scope**: `<repo>/.github/extensions/changelog-reader/`

```sh
git clone https://github.com/Jfhelin/github-changelog-canvas.git \
  ~/.copilot/extensions/changelog-reader
```

Then reload extensions in Copilot CLI (or restart it) and open the **Developer News** canvas.

> The `@github/copilot-sdk` import is resolved automatically by the Copilot CLI — no `package.json` or `node_modules` required.

## Notes

- The entry file **must** be named `extension.mjs` and live in an immediate subdirectory of a discovered extensions folder.
- Personal read-state lives in `artifacts/` and is intentionally **not** committed (see `.gitignore`).
- `stdout` is reserved for JSON-RPC; the extension never uses `console.log` (it uses `session.log`).

## License

[MIT](./LICENSE)
