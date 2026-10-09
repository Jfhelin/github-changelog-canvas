// Extension: changelog-reader
// A light-mode developer news reader. The header is a navigator; the body
// shows one article at a time. Page 0 is an LLM-generated summary of the
// GitHub Changelog, GitHub Next, and relevant external articles you haven't read
// yet. You can jump into Copilot to discuss any article with one click.
//
// Pieces:
//   feed.mjs  — fetch + parse the GitHub and Microsoft RSS feeds
//   store.mjs — durable last-read date + selection + generated summary
//   ui.mjs    — the light-mode reading pane (header nav + single article)
// This file wires an HTTP server per canvas instance, the agent-callable
// actions, and endpoints the iframe POSTs to (which drive the agent via
// session.send).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { fetchEntries } from "./feed.mjs";
import { normalizeScope, scopeCandidates, summaryRangeProperties, summaryScopeInstructions, validateSummary } from "./summary.mjs";
import {
    loadState,
    markAllRead,
    setSelected,
    setSummary,
    computeView,
    isAlwaysIncluded,
} from "./store.mjs";

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

function normalizeExternalUrl(value) {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function openExternalUrl(url) {
    const command =
        process.platform === "darwin"
            ? { file: "open", args: [url] }
            : process.platform === "win32"
              ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
              : { file: "xdg-open", args: [url] };

    return new Promise((resolve, reject) => {
        const child = spawn(command.file, command.args, {
            detached: true,
            stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
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
        if (req.method === "POST" && url.pathname === "/api/open-external") {
            const body = await readBody(req);
            const externalUrl = normalizeExternalUrl(body.url);
            if (!externalUrl) {
                json(res, 400, { ok: false, error: "Only HTTP and HTTPS links can be opened." });
                return;
            }
            await openExternalUrl(externalUrl);
            json(res, 200, { ok: true });
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
                    "). For your first reply, give a concise, plain-language explanation for someone unfamiliar with the topic. " +
                    "Explain what changed, who would use it, when they would use it, and why they should care. " +
                    "Do not ask a follow-up question or present multiple-choice options or a menu of topics in that first reply."
            );
            json(res, 200, { ok, selectedId: entry.id });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/summarize") {
            const view = await getView();
            const ok = await sendToCopilot(
                "Please generate my unread developer news summary. " + summaryScopeInstructions +
                    " Call get_unread_for_summary to fetch every candidate within the requested scope. " +
                    "Include every GitHub Changelog and GitHub Next entry. Review every other entry, but include only articles " +
                    "matching the relevanceProfile returned by the action. Group entries under a ## heading matching each article's " +
                    "sourceName, then use short topic subheadings. Do not repeat source names in individual bullets. Keep " +
                    "it concise and skimmable. In every bullet, make a short descriptive phrase an internal Markdown link " +
                    "using the exact article ID as the target, for example [descriptive phrase](article:EXACT_ID). Do not " +
                    "use external URLs in summary links. Then call set_unread_summary with the Markdown and the exact IDs " +
                    "of every included article whose source is neither GitHub Changelog nor GitHub Next."
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
        "Personalized reader for GitHub Changelog, GitHub Next, and relevant developer news.",
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
                "Return unread candidates within the user's requested publication range. Preserve prior date constraints. Include all GitHub Changelog and GitHub Next entries within this scope, then apply relevanceProfile to other sources.",
            inputSchema: {
                type: "object",
                properties: summaryRangeProperties,
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const view = await getView();
                let scope;
                try {
                    scope = normalizeScope(ctx.input || {});
                } catch (error) {
                    throw new CanvasError("invalid_input", error.message);
                }
                const candidates = scopeCandidates(view.summaryCandidates, scope);
                return {
                    status: view.status,
                    scope,
                    candidateIds: candidates.map((e) => e.id),
                    relevanceProfile:
                        "Within the returned scope, always include every GitHub Changelog and GitHub Next entry. From all other sources within that scope, include: GitHub or GitHub Copilot news not duplicated in those sources; all official Azure DevOps product updates, sprint notes, release announcements, and service changes; significant VS Code updates involving agents, AI, developer workflows, or broad developer impact; AI development; agentic changes for developers; code security; SDLC security; and major updates relevant to most developers. Exclude duplicate coverage and narrow product updates outside these areas.",
                    candidateCount: candidates.length,
                    articles: candidates.map((e) => ({
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
                "Save a summary for exactly the scope and candidateIds returned by get_unread_for_summary. Completeness is checked only within that range; older unread articles remain unread.",
            inputSchema: {
                type: "object",
                properties: {
                    scope: { type: "object", properties: summaryRangeProperties, additionalProperties: false },
                    candidateIds: { type: "array", items: { type: "string" }, description: "Exact candidateIds returned by get_unread_for_summary." },
                    markdown: { type: "string", description: "The Markdown summary to display on the summary page." },
                    relevantExternalIds: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Exact IDs of included articles that are not automatically included GitHub Changelog or GitHub Next entries. Use [] when none qualify.",
                    },
                },
                required: ["markdown", "relevantExternalIds", "scope", "candidateIds"],
            },
            handler: async (ctx) => {
                const markdown = ctx.input && ctx.input.markdown;
                const view = await getView();
                const relevantIds = ctx.input && ctx.input.relevantExternalIds;
                let scope, candidates, included;
                try {
                    scope = normalizeScope(ctx.input.scope);
                    candidates = scopeCandidates(view.summaryCandidates, scope);
                    included = validateSummary(markdown, candidates, ctx.input.candidateIds, relevantIds, isAlwaysIncluded);
                } catch (error) {
                    throw new CanvasError("invalid_input", error.message);
                }
                await setSummary(markdown, candidates.map((e) => e.id), relevantIds, scope);
                return { ok: true, scope, includedCount: included.length, relevantExternalCount: relevantIds.length };
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
            description: "Return reading status for GitHub Changelog, GitHub Next, and relevant developer news.",
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
                if (!state.selectedId) return { additionalContext: summaryScopeInstructions };
                const entry = await findEntry({ id: state.selectedId });
                if (!entry) return;
                const text = (entry.contentText || "").slice(0, 6000);
                return {
                    additionalContext:
                        summaryScopeInstructions + "\nThe user is reading a developer news article in the reader canvas and may be asking about it.\n" +
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
