// Extension: changelog-reader
// A light-mode GitHub Changelog reader. The header is a navigator; the body
// shows one article at a time. Page 0 is an LLM-generated summary of the
// articles you haven't read yet. You can jump into Copilot to discuss any
// article (or the whole unread batch) with one click.
//
// Pieces:
//   feed.mjs  — fetch + parse the changelog RSS feed
//   store.mjs — durable last-read date + selection + generated summary
//   ui.mjs    — the light-mode reading pane (header nav + single article)
// This file wires an HTTP server per canvas instance, the agent-callable
// actions, and endpoints the iframe POSTs to (which drive the agent via
// session.send).

import { createServer } from "node:http";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { fetchEntries } from "./feed.mjs";
import { loadState, markAllRead, setSelected, setSummary, computeView } from "./store.mjs";

const PAGES = 3; // ~30 recent entries; enough history for occasional readers.
const servers = new Map(); // instanceId -> { server, url }

// Hoisted so HTTP handlers created before joinSession resolves can still reach
// the live session at request time.
let session = null;

async function getView({ force = false } = {}) {
    const entries = await fetchEntries({ pages: PAGES, force });
    const state = await loadState();
    return computeView(entries, state);
}

// The reading/navigation set: unread articles if any, else the full recent feed
// (so the reader is still useful once you're caught up).
function navArticles(view) {
    const base = view.status.unreadCount > 0 ? view.unread : view.entries;
    return base.map((e) => ({
        id: e.id,
        title: e.title,
        url: e.link,
        author: e.author,
        date: e.date,
        categories: e.categories,
        isNew: e.isNew,
        contentHtml: e.contentHtml,
    }));
}

async function findEntry({ id, url } = {}) {
    const entries = await fetchEntries({ pages: PAGES });
    if (id) {
        const byId = entries.find((e) => e.id === id);
        if (byId) return byId;
    }
    if (url) {
        const slug = url.replace(/.*\/changelog\//, "").replace(/\/$/, "");
        const byUrl = entries.find((e) => e.link === url || e.id === slug);
        if (byUrl) return byUrl;
    }
    return null;
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                resolve({});
            }
        });
    });
}

function json(res, code, payload) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

async function sendToCopilot(prompt) {
    if (!session) return false;
    try {
        // Fire-and-forget: injects a user turn into this session so the agent runs.
        session.send(prompt);
        return true;
    } catch {
        return false;
    }
}

async function handleRequest(req, res, renderPage) {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderPage());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/state") {
            const force = url.searchParams.get("force") === "1";
            const view = await getView({ force });
            json(res, 200, { status: view.status, summary: view.summary, articles: navArticles(view) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/markread") {
            const before = await getView();
            await markAllRead();
            const after = await getView();
            json(res, 200, {
                status: after.status,
                summary: after.summary,
                articles: navArticles(after),
                markedRead: before.status.unreadCount,
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/select") {
            const body = await readBody(req);
            await setSelected(body.id || null);
            json(res, 200, { ok: true, selectedId: body.id || null });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/discuss") {
            const body = await readBody(req);
            const entry = await findEntry({ id: body.id, url: body.url });
            if (!entry) {
                json(res, 404, { ok: false, error: "Article not found." });
                return;
            }
            await setSelected(entry.id);
            const ok = await sendToCopilot(
                "I'd like to discuss this GitHub Changelog article: \"" +
                    entry.title +
                    "\" (" +
                    entry.link +
                    "). Please give me a short take on what it means and why it matters, then ask what I want to dig into."
            );
            json(res, 200, { ok, selectedId: entry.id });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/summarize") {
            const view = await getView();
            const ok = await sendToCopilot(
                "Please generate a summary of the GitHub Changelog updates I haven't read yet. " +
                    "Call the get_unread_for_summary action to fetch them, write a concise, well-grouped Markdown summary " +
                    "(group related items under short headings, use bullet points, keep it skimmable), then call " +
                    "set_unread_summary with that Markdown so it appears on the summary page of my Changelog reader."
            );
            json(res, 200, { ok, generating: ok, unreadCount: view.status.unreadCount });
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    } catch (err) {
        json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
}

async function startServer() {
    const { renderPage } = await import("./ui.mjs");
    const server = createServer((req, res) => handleRequest(req, res, renderPage));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const canvas = createCanvas({
    id: "changelog-reader",
    displayName: "GitHub Changelog",
    description:
        "Light-mode reader for the GitHub Changelog that tracks your last-read date and lets you chat about articles.",
    actions: [
        {
            name: "list_changelog_entries",
            description:
                "List recent GitHub Changelog entries, newest first. Set onlyNew to return only entries the user hasn't read yet.",
            inputSchema: {
                type: "object",
                properties: {
                    onlyNew: { type: "boolean", description: "Only entries the user hasn't read yet." },
                    limit: { type: "integer", description: "Max entries to return (default 30)." },
                },
            },
            handler: async (ctx) => {
                const { entries, status } = await getView();
                const onlyNew = ctx.input && ctx.input.onlyNew;
                const limit = (ctx.input && ctx.input.limit) || 30;
                const filtered = (onlyNew ? entries.filter((e) => e.isNew) : entries).slice(0, limit);
                return {
                    status,
                    entries: filtered.map((e) => ({
                        id: e.id,
                        title: e.title,
                        url: e.link,
                        author: e.author,
                        date: e.date,
                        categories: e.categories,
                        isNew: e.isNew,
                        excerpt: e.excerpt,
                    })),
                };
            },
        },
        {
            name: "get_changelog_article",
            description:
                "Get the full readable text of a changelog article by id or url. If neither is given, returns the article the user selected via 'Discuss with Copilot'.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Article id (slug), e.g. from list_changelog_entries." },
                    url: { type: "string", description: "Full article URL." },
                },
            },
            handler: async (ctx) => {
                let entry = await findEntry(ctx.input || {});
                if (!entry && !(ctx.input && (ctx.input.id || ctx.input.url))) {
                    const state = await loadState();
                    if (state.selectedId) entry = await findEntry({ id: state.selectedId });
                }
                if (!entry)
                    throw new CanvasError(
                        "not_found",
                        "No matching changelog article. Call list_changelog_entries to see available ids."
                    );
                return {
                    id: entry.id,
                    title: entry.title,
                    url: entry.link,
                    author: entry.author,
                    date: entry.date,
                    categories: entry.categories,
                    content: entry.contentText,
                };
            },
        },
        {
            name: "get_selected_article",
            description:
                "Return the changelog article the user selected in the reader via 'Discuss with Copilot', with full readable text. Errors if nothing is selected.",
            handler: async () => {
                const state = await loadState();
                if (!state.selectedId)
                    throw new CanvasError(
                        "no_selection",
                        "No article is selected. Ask the user to click 'Discuss with Copilot' on an entry."
                    );
                const entry = await findEntry({ id: state.selectedId });
                if (!entry)
                    throw new CanvasError("not_found", "The selected article is no longer in the recent feed window.");
                return {
                    id: entry.id,
                    title: entry.title,
                    url: entry.link,
                    author: entry.author,
                    date: entry.date,
                    categories: entry.categories,
                    content: entry.contentText,
                };
            },
        },
        {
            name: "get_unread_for_summary",
            description:
                "Return the full readable text of every changelog article the user hasn't read yet, for generating the summary page. Newest first.",
            handler: async () => {
                const view = await getView();
                return {
                    status: view.status,
                    unreadCount: view.status.unreadCount,
                    articles: view.unread.map((e) => ({
                        id: e.id,
                        title: e.title,
                        url: e.link,
                        author: e.author,
                        date: e.date,
                        categories: e.categories,
                        content: e.contentText,
                    })),
                };
            },
        },
        {
            name: "set_unread_summary",
            description:
                "Store a Markdown summary of the user's unread changelog articles. It is shown on the summary page (page 0) of the Changelog reader. The unread set it applies to is captured automatically.",
            inputSchema: {
                type: "object",
                properties: {
                    markdown: { type: "string", description: "The Markdown summary to display on the summary page." },
                },
                required: ["markdown"],
            },
            handler: async (ctx) => {
                const markdown = ctx.input && ctx.input.markdown;
                if (!markdown || typeof markdown !== "string")
                    throw new CanvasError("invalid_input", "Provide a non-empty 'markdown' string.");
                const view = await getView();
                await setSummary(markdown, view.unreadIds);
                return { ok: true, unreadCount: view.status.unreadCount };
            },
        },
        {
            name: "mark_changelog_read",
            description: "Mark all changelog entries as read as of now. Returns how many were newly marked read.",
            handler: async () => {
                const before = await getView();
                await markAllRead();
                return { ok: true, markedRead: before.status.unreadCount, lastReadISO: (await loadState()).lastReadISO };
            },
        },
        {
            name: "changelog_status",
            description: "Return reading status: last-read date, count of unread entries, and total loaded.",
            handler: async () => {
                const { status } = await getView();
                return status;
            },
        },
    ],
    open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer();
            servers.set(ctx.instanceId, entry);
        }
        let title = "GitHub Changelog";
        try {
            const { status } = await getView();
            if (status.unreadCount > 0) title = `GitHub Changelog (${status.unreadCount} unread)`;
        } catch {
            /* keep default title if feed fetch fails on open */
        }
        return { title, url: entry.url };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await new Promise((resolve) => entry.server.close(() => resolve()));
        }
    },
});

session = await joinSession({
    canvases: [canvas],
    hooks: {
        // When the user has selected an article ("Discuss with Copilot"), silently
        // give the agent that article's text so chatting about it just works.
        onUserPromptSubmitted: async () => {
            try {
                const state = await loadState();
                if (!state.selectedId) return;
                const entry = await findEntry({ id: state.selectedId });
                if (!entry) return;
                const text = (entry.contentText || "").slice(0, 6000);
                return {
                    additionalContext:
                        "The user is reading a GitHub Changelog article in the Changelog reader canvas and may be asking about it.\n" +
                        "Selected article:\n" +
                        "Title: " + entry.title + "\n" +
                        "Date: " + (entry.date || "unknown") + "\n" +
                        "URL: " + entry.link + "\n" +
                        (entry.categories && entry.categories.length
                            ? "Categories: " + entry.categories.join(", ") + "\n"
                            : "") +
                        "\nArticle content:\n" + text,
                };
            } catch {
                return;
            }
        },
    },
});

session.log("Changelog reader ready. Open the 'GitHub Changelog' canvas to start reading.", {
    level: "info",
    ephemeral: true,
});
