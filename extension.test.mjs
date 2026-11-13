import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryScopeInstructions } from "./summary.mjs";

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const GENERIC_PROMPT = "Pull new data and give me an updated canvas";

test("actions, HTTP navigation, lookup and discussion share the saved scope without advancing read markers", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "changelog-reader-test-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    let config, canvas, sendError;
    const sent = [];
    const nativeFetch = globalThis.fetch;
    const fetchedPages = [];
    const marker = "2026-01-01T00:00:00.000Z";
    const statePath = join(home, "extensions/changelog-reader/artifacts/state.json");
    const articleText = "Full article content. ".repeat(400);
    await mkdir(join(home, "extensions/changelog-reader/artifacts"), { recursive: true });
    // A stale global selection written by an older version must never activate news context.
    await writeFile(statePath, JSON.stringify({ lastReadISO: marker, selectedId: "page-5", summary: null }));
    globalThis.readerTestSDK = {
        createCanvas: (options) => (canvas = options),
        CanvasError: class extends Error {
            constructor(code, message) { super(message); this.code = code; }
        },
        joinSession: async (options) => {
            config = options;
            return {
                sessionId: SESSION_A,
                log() {},
                send: async (prompt) => { if (sendError) throw sendError; sent.push(prompt); return "message-id"; },
            };
        },
    };
    const hooks = registerHooks({
        resolve(specifier, context, next) {
            if (specifier === "@github/copilot-sdk/extension") {
                return {
                    url: "data:text/javascript,export const {createCanvas,CanvasError,joinSession}=globalThis.readerTestSDK;",
                    shortCircuit: true,
                };
            }
            return next(specifier, context);
        },
    });
    t.after(async () => {
        if (canvas) await canvas.onClose({ instanceId: "test-reader" });
        hooks.deregister();
        delete globalThis.readerTestSDK;
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        await rm(home, { recursive: true });
    });
    t.mock.method(globalThis, "fetch", async (url, options) => {
        if (String(url).startsWith("http://127.0.0.1:")) return nativeFetch(url, options);
        if (url.includes("release-notes.atom")) return new Response("", { status: 404 });
        if (url.startsWith("https://github.blog/changelog/feed/")) {
            const page = Number(new URL(url).searchParams.get("paged") || 1);
            fetchedPages.push(page);
            const day = 7 - page;
            return new Response(`<rss><channel><item><title>Page ${page}</title>
                <link>https://github.blog/changelog/page-${page}</link>
                <pubDate>2026-01-0${day}T12:00:00Z</pubDate>
                <description>${articleText}</description></item></channel></rss>`);
        }
        return new Response("<rss><channel></channel></rss>");
    });
    await import("./extension.mjs");
    const action = (name, input = {}, sessionId = SESSION_A) =>
        canvas.actions.find((entry) => entry.name === name).handler({ input, sessionId });
    const hook = (prompt, sessionId = SESSION_A) => config.hooks.onUserPromptSubmitted({ prompt, sessionId }, { sessionId });

    // Stale global selectedId / no selection: unrelated prompts get no news context.
    assert.equal(await hook(GENERIC_PROMPT), undefined);
    assert.equal(await hook(GENERIC_PROMPT, SESSION_B), undefined);
    await assert.rejects(action("get_selected_article"), (error) => error.code === "no_selection");
    await assert.rejects(action("get_unread_for_summary", { after: "yesterday" }), /timestamp/);
    assert.deepEqual(fetchedPages, []);
    const result = await action("get_unread_for_summary", {
        after: "2026-01-02T00:00:00Z", before: "2026-01-07T00:00:00Z",
    });
    assert.ok(fetchedPages.includes(6));
    assert.equal(result.articles.length, 5);
    assert.equal(result.status, undefined, "scoped results do not expose unread-backlog counts");
    assert.equal(result.feedErrors[0].source, "Azure DevOps Release Notes");
    const saved = await action("set_unread_summary", {
        scope: result.scope, candidateIds: result.candidateIds, relevantExternalIds: [],
        markdown: "## GitHub Changelog\n### Updates\n" +
            result.articles.map((entry) => `- [${entry.title}](article:${entry.id})`).join("\n"),
    });
    assert.equal(saved.includedCount, 5);
    assert.equal(saved.feedErrors.length, 1);
    const opened = await canvas.open({ instanceId: "test-reader", sessionId: SESSION_A });
    const http = async (path, body) => {
        const response = await nativeFetch(opened.url + path, body === undefined ? {} : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    const view = (await http("api/state")).body;
    assert.equal(view.summary.valid, true);
    assert.deepEqual(view.articles.map((entry) => entry.id), result.candidateIds);
    assert.equal((await action("get_changelog_article", { id: "page-5" })).content, articleText.trim());
    assert.equal(await hook(GENERIC_PROMPT), undefined, "an open canvas alone must not inject context");

    // Explicit article discussion: only the reader's own handoff prompt in this session gets the article.
    const discussion = await http("api/discuss", { id: "page-5" });
    assert.equal(discussion.body.ok, true);
    const discussPrompt = sent.at(-1);
    assert.match(discussPrompt, /Page 5/);
    assert.equal(await hook(discussPrompt, SESSION_B), undefined, "another conversation must not consume the handoff");
    await assert.rejects(action("get_selected_article", {}, SESSION_B), (error) => error.code === "no_selection");
    assert.equal((await action("changelog_status", {}, SESSION_B)).selectedId, null);
    const injected = await hook(discussPrompt);
    assert.equal(injected.additionalContext.includes(articleText.trim()), true);
    assert.equal(injected.additionalContext.includes(summaryScopeInstructions), false);
    assert.equal(await hook(discussPrompt), undefined, "handoff context is injected once");
    assert.equal(await hook(GENERIC_PROMPT), undefined, "follow-up prompts are not re-injected");
    assert.equal((await action("get_selected_article")).id, "page-5");
    assert.equal((await action("get_changelog_article")).id, "page-5");
    assert.equal((await action("changelog_status")).selectedId, "page-5");

    // Explicit digest generation: self-contained prompt with scope rules, no article injection.
    const digest = await http("api/summarize", {});
    assert.equal(digest.body.ok, true);
    const digestPrompt = sent.at(-1);
    assert.ok(digestPrompt.includes(summaryScopeInstructions));
    assert.match(digestPrompt, /get_unread_for_summary/);
    assert.equal(await hook(digestPrompt), undefined);
    sendError = new Error("Copilot message rejected");
    for (const path of ["api/discuss", "api/summarize"]) {
        const rejected = await http(path, { id: "page-5" });
        assert.equal(rejected.status, 500);
        assert.match(rejected.body.error, /message rejected/);
    }
    assert.equal(await hook(discussPrompt), undefined, "a failed handoff leaves no pending context");
    sendError = null;

    // A reader opened for another conversation cannot send into this one.
    const foreign = await canvas.open({ instanceId: "foreign-reader", sessionId: SESSION_B });
    const foreignResponse = await nativeFetch(foreign.url + "api/discuss", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "page-4" }),
    });
    assert.equal(foreignResponse.status, 500);
    assert.match((await foreignResponse.json()).error, /different conversation/);
    await canvas.onClose({ instanceId: "foreign-reader" });
    assert.equal((await action("changelog_status", {}, SESSION_B)).selectedId, null);
    assert.equal((await action("changelog_status")).selectedId, "page-5");

    // Private reader data is untouched: read marker kept, legacy selectedId neither read nor rewritten.
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.lastReadISO, marker);
    assert.equal(state.selectedId, "page-5");
    await writeFile(statePath, JSON.stringify({ ...state, selectedId: "page-4" }));
    assert.equal((await action("changelog_status")).selectedId, "page-5");
    assert.equal(await hook(GENERIC_PROMPT), undefined);
    await writeFile(statePath, "invalid state");
    await assert.rejects(action("changelog_status"), SyntaxError);
});
