// Extension: changelog-reader
// A light-mode developer news reader. The header is a navigator; the body
// shows one article at a time. Page 0 is an LLM-generated summary of the
// GitHub Changelog and relevant Microsoft Developer Blogs articles you haven't
// read yet. You can jump into Copilot to discuss any article with one click.
//
// Pieces:
//   feed.mjs  — fetch + parse the GitHub and Microsoft RSS feeds
//   store.mjs — durable last-read date + selection + generated summary
//   ui.mjs    — the light-mode reading pane (header nav + single article)
// This file wires an HTTP server per canvas instance, the agent-callable
// actions, and endpoints the iframe POSTs to (which drive the agent via
// session.send).

import { createServer } from "node:http";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { fetchEntries } from "./feed.mjs";
import { loadState, markAllRead, setSelected, setSummary, computeView } from "./store.mjs";

const MIN_PAGES = 3;
const servers = new Map(); // instanceId -> { server, url }

// Hoisted so HTTP handlers created before joinSession resolves can still reach
// the live session at request time.
let session = null;

async function getView({ force = false } = {}) {
    const state = await loadState();
    const entries = await fetchEntries({ minPages: MIN_PAGES, sinceISO: state.lastReadISO, force });
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
        source: e.source,
        sourceName: e.sourceName,
        isNew: e.isNew,
        contentHtml: e.contentHtml,
    }));
}

async function findEntry({ id, url } = {}) {
    const state = await loadState();
    const entries = await fetchEntries({ minPages: MIN_PAGES, sinceISO: state.lastReadISO });
    if (id) {
        const byId = entries.find((e) => e.id === id);
        if (byId) return byId;
    }
    if (url) {
        const byUrl = entries.find((e) => e.link === url);
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
                markedRead: before.status.reviewCount,
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
                "I'd like to discuss this developer news article from " +
                    entry.sourceName +
                    ': "' +
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
                "Please generate my unread developer news summary. Call get_unread_for_summary to fetch every candidate. " +
                    "Include every GitHub Changelog entry. Review every other entry, but include only articles matching the " +
                    "relevanceProfile returned by the action. Group entries under a ## heading matching each article's " +
                    "sourceName, then use short topic subheadings. Do not repeat source names in individual bullets. Keep " +
                    "it concise and skimmable. In every bullet, make a short descriptive phrase an internal Markdown link " +
                    "using the exact article ID as the target, for example [descriptive phrase](article:EXACT_ID). Do not " +
                    "use external URLs in summary links. Then call set_unread_summary with the Markdown and the exact IDs " +
                    "of every included article whose source is not GitHub Changelog."
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
    displayName: "Developer News",
    description:
        "Personalized reader for GitHub Changelog and relevant Microsoft Developer Blogs updates.",
    actions: [
        {
            name: "list_changelog_entries",
            description:
                "List recent entries in the personalized developer news reading queue, newest first.",
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
                        source: e.source,
                        sourceName: e.sourceName,
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
                    source: entry.source,
                    sourceName: entry.sourceName,
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
                    source: entry.source,
                    sourceName: entry.sourceName,
                    content: entry.contentText,
                };
            },
        },
        {
            name: "get_unread_for_summary",
            description:
                "Return every unread developer-news candidate. Include all GitHub Changelog entries and select relevant entries from every other source using relevanceProfile.",
            handler: async () => {
                const view = await getView();
                return {
                    status: view.status,
                    relevanceProfile:
                        "Always include every GitHub Changelog entry. From all other sources, include: GitHub or GitHub Copilot news not duplicated in the Changelog; all official Azure DevOps product updates, sprint notes, release announcements, and service changes; significant VS Code updates involving agents, AI, developer workflows, or broad developer impact; AI development; agentic changes for developers; code security; SDLC security; and major updates relevant to most developers. Exclude duplicate coverage and narrow product updates outside these areas.",
                    candidateCount: view.status.reviewCount,
                    articles: view.summaryCandidates.map((e) => ({
                        id: e.id,
                        title: e.title,
                        url: e.link,
                        author: e.author,
                        date: e.date,
                        categories: e.categories,
                        source: e.source,
                        sourceName: e.sourceName,
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
                    relevantExternalIds: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Exact IDs of included articles whose source is not GitHub Changelog. Use [] when none qualify.",
                    },
                },
                required: ["markdown", "relevantExternalIds"],
            },
            handler: async (ctx) => {
                const markdown = ctx.input && ctx.input.markdown;
                if (!markdown || typeof markdown !== "string")
                    throw new CanvasError("invalid_input", "Provide a non-empty 'markdown' string.");
                const view = await getView();
                const relevantIds = ctx.input && ctx.input.relevantExternalIds;
                if (!Array.isArray(relevantIds))
                    throw new CanvasError("invalid_input", "Provide 'relevantExternalIds' as an array.");
                const validExternalIds = new Set(
                    view.summaryCandidates.filter((e) => e.source !== "github").map((e) => e.id)
                );
                const invalidIds = relevantIds.filter((id) => !validExternalIds.has(id));
                if (invalidIds.length)
                    throw new CanvasError("invalid_input", `Unknown external article ids: ${invalidIds.join(", ")}`);
                const includedIds = new Set([
                    ...view.summaryCandidates.filter((e) => e.source === "github").map((e) => e.id),
                    ...relevantIds,
                ]);
                const requiredSources = new Set(
                    view.summaryCandidates.filter((e) => includedIds.has(e.id)).map((e) => e.sourceName)
                );
                const missingSources = [...requiredSources].filter((sourceName) => !markdown.includes(`## ${sourceName}`));
                if (missingSources.length)
                    throw new CanvasError(
                        "invalid_input",
                        `Add source headings for: ${missingSources.join(", ")}`
                    );
                const missingLinks = view.summaryCandidates
                    .filter((e) => includedIds.has(e.id))
                    .filter(
                        (e) =>
                            !markdown.includes(`(article:${e.id})`) &&
                            !markdown.includes(`(article:${encodeURIComponent(e.id)})`)
                    )
                    .map((e) => e.id);
                if (missingLinks.length)
                    throw new CanvasError(
                        "invalid_input",
                        `Add internal article links for: ${missingLinks.join(", ")}`
                    );
                await setSummary(markdown, view.candidateIds, relevantIds);
                return { ok: true, relevantExternalCount: relevantIds.length };
            },
        },
        {
            name: "mark_changelog_read",
            description: "Mark all reviewed developer news entries as read as of now.",
            handler: async () => {
                const before = await getView();
                await markAllRead();
                return { ok: true, markedRead: before.status.reviewCount, lastReadISO: (await loadState()).lastReadISO };
            },
        },
        {
            name: "changelog_status",
            description: "Return reading status for GitHub Changelog and relevant Microsoft Developer Blogs entries.",
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
        let title = "Developer News";
        try {
            const { status } = await getView();
            if (status.unreadCount > 0) title = `Developer News (${status.unreadCount} unread)`;
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
                        "Source: " + entry.sourceName + "\n" +
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

session.log("Developer news reader ready. Open the 'Developer News' canvas to start reading.", {
    level: "info",
    ephemeral: true,
});
