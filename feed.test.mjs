import test from "node:test";
import assert from "node:assert/strict";
import { fetchEntries, getFeedErrors } from "./feed.mjs";

const item = (id, date) => `<item><title>${id}</title><link>https://github.blog/changelog/${id}</link><pubDate>${date}</pubDate><description>Article</description></item>`;
const rss = (items = "") => `<rss><channel>${items}</channel></rss>`;

test("one unavailable feed does not prevent reading available feeds", async (t) => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        if (url.includes("release-notes.atom")) return new Response("", { status: 404 });
        return new Response(rss(url === "https://github.blog/changelog/feed/"
            ? item("available", "Thu, 29 Oct 2026 10:00:00 +0000") : ""));
    });
    const entries = await fetchEntries({ minPages: 1, force: true });
    assert.deepEqual(entries.map((entry) => entry.id), ["available"]);
    assert.equal(getFeedErrors().length, 1);
    assert.equal(getFeedErrors()[0].source, "Azure DevOps Release Notes");
    assert.match(getFeedErrors()[0].message, /404/);
});

test("all failed feeds produce an explicit error", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
    await assert.rejects(fetchEntries({ force: true }), /All news feeds failed.*503/);
});

test("pagination follows the requested start beyond the minimum page count", async (t) => {
    let pages = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
        if (!url.startsWith("https://github.blog/changelog/feed/")) return new Response(rss());
        const page = Number(new URL(url).searchParams.get("paged") || 1);
        pages++;
        const date = page < 5 ? "Wed, 28 Oct 2026 10:00:00 +0000" : "Thu, 22 Oct 2026 10:00:00 +0000";
        return new Response(rss(item(`page-${page}`, date)));
    });
    const entries = await fetchEntries({ minPages: 3, sinceISO: "2026-10-23T07:31:12.652Z", force: true });
    assert.equal(pages, 5);
    assert.equal(entries.length, 5);
    assert.deepEqual(getFeedErrors(), []);
});

test("later-page errors retain available articles and disclose incomplete coverage", async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "https://github.blog/changelog/feed/") {
            return new Response(rss(item("available", "Thu, 29 Oct 2026 10:00:00 +0000")));
        }
        if (url.startsWith("https://github.blog/changelog/feed/")) return new Response("", { status: 503 });
        return new Response(rss());
    });
    const entries = await fetchEntries({ minPages: 3, force: true });
    assert.equal(entries.length, 1);
    assert.match(getFeedErrors()[0].message, /Page 2.*503/);
    const cached = await fetchEntries({ minPages: 3 });
    assert.deepEqual(cached, entries);
    assert.match(getFeedErrors()[0].message, /Page 2.*503/);
});

test("pagination limits and repeated pages disclose incomplete coverage", async (t) => {
    for (const repeated of [false, true]) {
        const mock = t.mock.method(globalThis, "fetch", async (url) => {
            if (!url.startsWith("https://github.blog/changelog/feed/")) return new Response(rss());
            const page = Number(new URL(url).searchParams.get("paged") || 1);
            return new Response(rss(item(repeated ? "same" : `page-${page}`, "Thu, 29 Oct 2026 10:00:00 +0000")));
        });
        await fetchEntries({ minPages: 3, sinceISO: "2026-10-23T07:31:12.652Z", force: true });
        assert.match(getFeedErrors()[0].message, repeated ? /repeated articles/ : /50-page limit/);
        mock.mock.restore();
    }
});
