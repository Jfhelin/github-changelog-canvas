import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScope, scopeCandidates, validateSummary } from "./summary.mjs";
import { computeView, isAlwaysIncluded } from "./store.mjs";
import { renderPage } from "./ui.mjs";

const entries = [
    { id: "old", source: "github", sourceName: "GitHub Changelog", date: "2026-01-01T00:00:00Z" },
    { id: "new", source: "github", sourceName: "GitHub Changelog", date: "2026-01-02T07:00:00Z" },
    { id: "next", source: "github-next", sourceName: "GitHub Next", date: "2026-01-03T00:00:00Z" },
    { id: "external:/post", source: "vscode", sourceName: "Visual Studio Code", date: "2026-01-04T00:00:00Z" },
    { id: "end", source: "github", sourceName: "GitHub Changelog", date: "2026-01-05T00:00:00Z" },
];
const scope = normalizeScope({ after: "2026-01-02T09:00:00+02:00", before: "2026-01-05T00:00:00Z" });
const candidates = scopeCandidates(entries, scope);
const ids = candidates.map((entry) => entry.id);
const markdown = "## GitHub Changelog\n- [New](article:new)\n## GitHub Next\n- [Next](article:next)";

async function renderWithState(state) {
    const script = renderPage().match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map(["app", "status", "pos", "btnPrev", "btnSummary", "btnNext", "btnDiscuss", "btnMark", "toast"]
        .map((id) => [id, { innerHTML: "", textContent: "", disabled: false, style: {} }]));
    const document = {
        getElementById: (id) => elements.get(id),
        querySelector: () => ({ scrollTop: 0 }),
        addEventListener: () => {},
    };
    const fetch = async () => ({ ok: true, json: async () => state });
    const run = new Function("document", "fetch", "URL", "setTimeout", "clearTimeout", script);
    run(document, fetch, URL, () => 1, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    return elements;
}

test("normalizes timezone and applies inclusive start, exclusive end", () => {
    assert.equal(scope.after, "2026-01-02T07:00:00.000Z");
    assert.deepEqual(ids, ["new", "next", "external:/post"]);
    assert.deepEqual(scopeCandidates(entries), entries);
    assert.deepEqual(scopeCandidates(entries, normalizeScope({ after: "2026-01-05T00:00:00Z" })).map((e) => e.id), ["end"]);
    assert.deepEqual(scopeCandidates(entries, normalizeScope({ before: "2026-01-02T07:00:00Z" })).map((e) => e.id), ["old"]);
});

test("rejects invalid, ambiguous, and reversed ranges", () => {
    for (const after of ["yesterday", "2026-01-02", "2026-01-02T09:00:00", "2026-99-02T09:00:00Z", "2026-02-30T09:00:00Z", null])
        assert.throws(() => normalizeScope({ after }), /timestamp/);
    assert.throws(() => normalizeScope({ after: scope.before, before: scope.after }), /earlier/);
    assert.throws(() => normalizeScope({ after: scope.after, before: scope.after }), /earlier/);
});

test("requires mandatory articles only within the fetched scope", () => {
    assert.equal(validateSummary(markdown, candidates, ids, [], isAlwaysIncluded).length, 2);
    assert.throws(() => validateSummary(markdown, entries, ids, [], isAlwaysIncluded), /candidates changed/);
    assert.throws(() => validateSummary(markdown.replace("(article:next)", "(article:new)"), candidates, ids, [], isAlwaysIncluded), /next/);
    assert.throws(() => validateSummary(markdown.replace("## GitHub Next", "### GitHub Next"), candidates, ids, [], isAlwaysIncluded), /headings/);
});

test("rejects stale snapshots and links outside selected scope", () => {
    assert.throws(() => validateSummary(markdown, candidates, ["new", "new", "next"], [], isAlwaysIncluded), /candidates changed/);
    assert.throws(() => validateSummary(markdown + "\n- [Old](article:old)", candidates, ids, [], isAlwaysIncluded), /outside/);
    assert.throws(() => validateSummary(markdown, candidates, ids, ["old"], isAlwaysIncluded), /External/);
    assert.throws(() => validateSummary(markdown, candidates, ids, ["external:/post"], isAlwaysIncluded), /headings/);
    const externalMarkdown = markdown + "\n## Visual Studio Code\n- [Post](article:external%3A%2Fpost)";
    assert.equal(validateSummary(externalMarkdown, candidates, ids, ["external:/post"], isAlwaysIncluded).length, 3);
});

test("scoped summary preserves backlog and remains valid when older news arrives", () => {
    const state = { lastReadISO: null, summary: { markdown, candidateIds: ids, relevantExternalIds: [], scope } };
    const view = computeView(entries, state);
    assert.equal(view.status.unreadCount, 4);
    assert.equal(view.summary.includedCount, 2);
    assert.equal(view.summary.valid, true);
    assert.deepEqual(view.summary.scope, scope);
    assert.equal(computeView([...entries, { ...entries[0], id: "older" }], state).summary.valid, true);
    const stale = computeView([...entries, { ...entries[1], id: "newer" }], state);
    assert.equal(stale.summary.valid, false);
    assert.deepEqual(stale.navigationEntries, []);
});

test("all-unread and legacy summaries retain their existing behavior", () => {
    const state = { lastReadISO: null, summary: { markdown, candidateIds: entries.map((e) => e.id), relevantExternalIds: ["external:/post"] } };
    const view = computeView(entries, state);
    assert.equal(view.summary.valid, true);
    assert.equal(view.summary.includedCount, 5);
    assert.deepEqual(view.summary.scope, {});
    assert.equal(computeView(entries, { lastReadISO: "2026-01-05T00:00:00Z" }).status.unreadCount, 0);
});

test("rendered browser script parses and displays scope-specific counts", () => {
    const html = renderPage();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /sum\.includedCount/);
    assert.match(script, /Collection window/);
    assert.match(script, /Items outside this window are not included/);
});

test("first visit does not expose the unfiltered unread queue while a summary is pending", async () => {
    const elements = await renderWithState({
        status: { unreadCount: 131, reviewCount: 131, summaryReady: false, firstVisit: true, feedErrors: [] },
        summary: null,
        articles: [],
    });

    assert.equal(elements.get("status").textContent, "Create a summary before browsing");
    assert.match(elements.get("app").innerHTML, /Start with a news summary/);
    assert.doesNotMatch(elements.get("app").innerHTML, /131/);
    assert.doesNotMatch(elements.get("app").innerHTML, /Skip &amp; read/);
});

test("date-scoped summary shows only its range count, not the unread backlog count", async () => {
    const elements = await renderWithState({
        status: { unreadCount: 126, reviewCount: 131, summaryReady: true, firstVisit: true, feedErrors: [] },
        summary: {
            valid: true,
            scope: { after: "2026-11-05T23:00:00.000Z", before: "2026-11-13T08:48:31.000Z" },
            includedCount: 19,
            markdown: "## GitHub Changelog\n- [Update](article:update)",
        },
        articles: Array.from({ length: 19 }, (_, i) => ({ id: String(i), title: "Update" })),
    });

    assert.equal(elements.get("status").textContent, "19 updates in this date range");
    assert.match(elements.get("app").innerHTML, /19 updates in this date range/);
    assert.match(elements.get("app").innerHTML, /Collection window:/);
    assert.doesNotMatch(elements.get("app").innerHTML, /126 relevant updates remain unread overall/);
});

test("navigation includes only the valid summary's scoped and relevant articles", () => {
    const state = { lastReadISO: null, summary: { markdown, candidateIds: ids, relevantExternalIds: ["external:/post"], scope } };
    const view = computeView(entries, state);
    assert.deepEqual(view.navigationEntries.map((e) => e.id), ids);
    assert.equal(view.navigationEntries.length, view.summary.includedCount);
    assert.equal(view.status.unreadCount, 5);
    assert.equal(state.lastReadISO, null);
    const withoutExternal = computeView(entries, { ...state, summary: { ...state.summary, relevantExternalIds: [] } });
    assert.deepEqual(withoutExternal.navigationEntries.map((e) => e.id), ["new", "next"]);
});

test("empty scoped summaries do not fall back to the backlog", () => {
    const view = computeView(entries, { lastReadISO: null, summary: {
        markdown: "No updates", candidateIds: [], relevantExternalIds: [],
        scope: normalizeScope({ after: "2026-01-06T00:00:00Z" }),
    } });
    assert.equal(view.summary.valid, true);
    assert.deepEqual(view.navigationEntries, []);
    assert.equal(view.status.unreadCount, 4);
});

test("first visit waits for a summary before exposing article navigation", () => {
    for (const state of [
        { lastReadISO: null },
        { lastReadISO: null, summary: { markdown, candidateIds: [], scope } },
    ]) {
        assert.deepEqual(computeView(entries, state).navigationEntries, []);
    }
    const activeBacklog = computeView(entries, { lastReadISO: "2026-01-01T00:00:00Z" });
    assert.deepEqual(activeBacklog.navigationEntries, activeBacklog.unread);
    const caughtUp = computeView(entries, { lastReadISO: "2026-01-05T00:00:00Z" });
    assert.deepEqual(caughtUp.navigationEntries, caughtUp.entries);
    const legacy = computeView(entries, { lastReadISO: null, summary: {
        markdown, candidateIds: entries.map((e) => e.id), relevantExternalIds: ["external:/post"],
    } });
    assert.deepEqual(legacy.navigationEntries, legacy.unread);
    const emptyLegacy = computeView(entries, { lastReadISO: "2026-01-05T00:00:00Z", summary: {
        markdown: "Caught up", candidateIds: [], relevantExternalIds: [], scope: {},
    } });
    assert.deepEqual(emptyLegacy.navigationEntries, emptyLegacy.entries);
});

test("header shows the exact article position and summary count", () => {
    const script = renderPage().match(/<script>([\s\S]*?)<\/script>/)[1];
    const header = script.match(/  function renderHeader\(\) \{([\s\S]*?)\n  \}/)[1];
    const elements = Object.fromEntries(["elStatus", "elPos", "btnPrev", "btnSummary", "btnNext", "btnDiscuss", "btnMark"]
        .map((name) => [name, { style: {} }]));
    const render = new Function("data", "idx", "articleCount", "fmtDate", ...Object.keys(elements), header);
    const data = { status: { firstVisit: true, reviewCount: 279 }, summary: { valid: true } };
    for (const idx of [0, 1, 23]) {
        render(data, idx, () => 23, () => "", ...Object.values(elements));
        assert.equal(elements.elStatus.textContent, "23 updates in this summary");
        assert.equal(elements.elPos.textContent, idx === 0 ? "Summary" : `${idx}/23`);
        assert.equal(elements.btnNext.disabled, idx === 23);
    }
});

test("HTTP status and error payloads reject failed client actions", async () => {
    const script = renderPage().match(/<script>([\s\S]*?)<\/script>/)[1];
    const source = script.match(/  function api\(path, opts\) \{[\s\S]*?\n  \}/)[0];
    for (const response of [
        new Response('{"error":"Unavailable"}', { status: 503 }),
        new Response('{"error":"Unavailable"}'),
        new Response("Unavailable", { status: 503 }),
    ]) {
        const api = new Function("fetch", `${source}; return api;`)(async () => response);
        await assert.rejects(api("/api/state"), /Unavailable|503/);
    }
});

test("load failures show an error instead of reporting a successful refresh", async () => {
    const script = renderPage().match(/<script>([\s\S]*?)<\/script>/)[1];
    const source = script.match(/  function load\(force\) \{[\s\S]*?\n  \}/)[0];
    const notifications = [];
    const load = new Function("api", "setState", "render", "toast",
        `var loadError; ${source}; return load;`)(
        async () => { throw new Error("All news feeds failed"); },
        () => assert.fail("Failed feeds must not update state"),
        () => notifications.push("render error"),
        (value) => notifications.push(value),
    );
    assert.equal(await load(true), false);
    assert.deepEqual(notifications, ["render error", "All news feeds failed"]);
    assert.match(script, /if \(loaded\) toast\("Feed refreshed\."\)/);
    assert.match(script, /if \(loadError\) return/);
});

test("partial coverage warnings retain the interactive reader controls", () => {
    const html = renderPage();
    assert.match(html, /Coverage incomplete/);
    assert.match(html, /data-act="goarticles"/);
    assert.match(html, /data-act="next"/);
    assert.match(html, /data-act="discuss"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /Retry/);
});
