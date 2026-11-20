import test from "node:test";
import assert from "node:assert/strict";
import { fetchEntries, getFeedErrors } from "./feed.mjs";

const item = (id, date) => `<item><title>${id}</title><link>https://github.blog/changelog/${id}</link><pubDate>${date}</pubDate><description>Article</description></item>`;
const rss = (items = "") => `<rss><channel>${items}</channel></rss>`;
const learnIndexUrl = "https://learn.microsoft.com/en-us/azure/devops/release-notes/toc.json";
const learnBase = "https://learn.microsoft.com/en-us/azure/devops/release-notes/";
const learnIndex = (sprints) => JSON.stringify({
    items: [{ children: sprints.map((sprint) => ({ href: `2026/sprint-${sprint}-update` })) }],
});
const learnArticle = (sprint, date = "2026-10-01") => `<html><head>
    <meta name="ms.date" content="${date}"><meta name="updated_at" content="2026-11-20">
    </head><body><nav>Navigation noise</nav>
    <div class="content"><h1>Release ${sprint} &amp; improvements</h1></div>
    <div>Page controls</div><div class="content"><p>Full release ${sprint}.</p>
    <div class="NOTE"><p>Nested details.</p></div><h2>Final section</h2>
    <img src="media/screenshot.png"><a href="../features-timeline">Roadmap</a><p>Last detail.</p></div>
    <footer>Feedback noise</footer></body></html>`;
const otherFeed = (url) => new Response(url === learnIndexUrl ? learnIndex([280])
    : url.startsWith(learnBase) ? learnArticle(280) : rss());
const githubEntries = (entries) => entries.filter((entry) => entry.source === "github");

test("one unavailable feed does not prevent reading available feeds", async (t) => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        if (url.endsWith("/release-notes/toc.json")) return new Response("", { status: 404 });
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
        if (!url.startsWith("https://github.blog/changelog/feed/")) return otherFeed(url);
        const page = Number(new URL(url).searchParams.get("paged") || 1);
        pages++;
        const date = page < 5 ? "Wed, 28 Oct 2026 10:00:00 +0000" : "Thu, 22 Oct 2026 10:00:00 +0000";
        return new Response(rss(item(`page-${page}`, date)));
    });
    const entries = await fetchEntries({ minPages: 3, sinceISO: "2026-10-23T07:31:12.652Z", force: true });
    assert.equal(pages, 5);
    assert.equal(githubEntries(entries).length, 5);
    assert.deepEqual(getFeedErrors(), []);
});

test("later-page errors retain available articles and disclose incomplete coverage", async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "https://github.blog/changelog/feed/") {
            return new Response(rss(item("available", "Thu, 29 Oct 2026 10:00:00 +0000")));
        }
        if (url.startsWith("https://github.blog/changelog/feed/")) return new Response("", { status: 503 });
        return otherFeed(url);
    });
    const entries = await fetchEntries({ minPages: 3, force: true });
    assert.equal(githubEntries(entries).length, 1);
    assert.match(getFeedErrors()[0].message, /Page 2.*503/);
    const cached = await fetchEntries({ minPages: 3 });
    assert.deepEqual(cached, entries);
    assert.match(getFeedErrors()[0].message, /Page 2.*503/);
});

test("pagination limits and repeated pages disclose incomplete coverage", async (t) => {
    for (const repeated of [false, true]) {
        const mock = t.mock.method(globalThis, "fetch", async (url) => {
            if (!url.startsWith("https://github.blog/changelog/feed/")) return otherFeed(url);
            const page = Number(new URL(url).searchParams.get("paged") || 1);
            return new Response(rss(item(repeated ? "same" : `page-${page}`, "Thu, 29 Oct 2026 10:00:00 +0000")));
        });
        await fetchEntries({ minPages: 3, sinceISO: "2026-10-23T07:31:12.652Z", force: true });
        assert.match(getFeedErrors()[0].message, repeated ? /repeated articles/ : /50-page limit/);
        mock.mock.restore();
    }
});

test("Microsoft Learn discovers sprint articles, preserves IDs, and reads publication dates and full content", async (t) => {
    const requested = [];
    t.mock.method(globalThis, "fetch", async (url) => {
        requested.push(url);
        if (url === learnIndexUrl) return new Response(JSON.stringify({ items: [
            { href: "2026/sprint-280-update" },
            { children: [
                { href: "2026/sprint-282-update" }, { href: "2026/sprint-281-update" },
                { href: "2026/sprint-282-update" }, { href: "2026/repos/sprint-282-update" },
                { href: "roadmap/2026/future" }, { href: "https://example.com/untrusted" },
            ] },
        ] }));
        const sprint = url.match(/\/sprint-(\d+)-update$/)?.[1];
        if (sprint) return new Response(learnArticle(sprint, sprint === "282" ? "2026-11-17" : "2026-10-27"));
        return new Response(rss());
    });
    const entries = await fetchEntries({ minPages: 1, sinceISO: "2026-11-13T00:00:00Z", force: true });
    assert.deepEqual(entries.map((entry) => entry.id), [
        "azure-devops-release-notes:sprint-282", "azure-devops-release-notes:sprint-281",
    ]);
    assert.equal(entries[0].date, "2026-11-17T00:00:00.000Z");
    assert.equal(entries[0].link, `${learnBase}2026/sprint-282-update`);
    assert.match(entries[0].title, /Sprint 282: Release 282 & improvements/);
    assert.match(entries[0].contentText, /Nested details\.[\s\S]*Last detail\./);
    assert.ok(entries[0].contentHtml.includes(`src="${learnBase}2026/media/screenshot.png"`));
    assert.ok(entries[0].contentHtml.includes(`href="${learnBase}features-timeline"`));
    assert.doesNotMatch(entries[0].contentText, /Navigation noise|Page controls|Feedback noise/);
    assert.equal(requested.filter((url) => url.endsWith("/sprint-282-update")).length, 1);
    assert.ok(!requested.some((url) => /sprint-280|\/repos\/|\/roadmap\/|example\.com|release-notes\.atom/.test(url)));
    assert.deepEqual(getFeedErrors(), []);
});

test("Microsoft Learn article failures retain healthy releases and disclose missing coverage", async (t) => {
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === learnIndexUrl) return new Response(learnIndex([282, 281, 280]));
        if (url.endsWith("/sprint-282-update")) return new Response("", { status: 503 });
        if (url.endsWith("/sprint-281-update")) return new Response(learnArticle(281, "not-a-date"));
        return otherFeed(url);
    });
    const entries = await fetchEntries({ minPages: 3, force: true });
    assert.deepEqual(entries.map((entry) => entry.id), ["azure-devops-release-notes:sprint-280"]);
    assert.equal(getFeedErrors().length, 2);
    assert.match(getFeedErrors()[0].url, /sprint-282/);
    assert.match(getFeedErrors()[0].message, /503/);
    assert.match(getFeedErrors()[1].message, /publication date/);
});

test("Microsoft Learn rejects empty or malformed indexes instead of claiming complete coverage", async (t) => {
    for (const index of ["not json", "{}", '{"items":[]}']) {
        const mock = t.mock.method(globalThis, "fetch", async (url) =>
            new Response(url === learnIndexUrl ? index : rss()));
        await fetchEntries({ minPages: 1, force: true });
        assert.equal(getFeedErrors().length, 1);
        assert.equal(getFeedErrors()[0].source, "Azure DevOps Release Notes");
        mock.mock.restore();
    }
});

test("Microsoft Learn discloses the historical release limit", async (t) => {
    let articles = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
        if (url === learnIndexUrl) return new Response(learnIndex(Array.from({ length: 51 }, (_, i) => 282 - i)));
        if (url.startsWith(learnBase)) {
            articles++;
            return new Response(learnArticle(282));
        }
        return new Response(rss());
    });
    await fetchEntries({ minPages: 1, sinceISO: "2020-01-01T00:00:00Z", force: true });
    assert.equal(articles, 50);
    assert.match(getFeedErrors()[0].message, /50-release limit/);
});
