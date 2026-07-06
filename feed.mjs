// Fetches and parses the GitHub Changelog RSS feed.
// No third-party deps: the feed is a controlled, trusted source (github.blog),
// so a focused regex parser is sufficient and keeps the extension dependency-free.

const FEED_BASE = "https://github.blog/changelog/feed/";

// In-memory cache so re-opens / repeated /api/entries calls don't hammer the feed.
let cache = { at: 0, pages: 0, entries: [] };
const CACHE_MS = 5 * 60 * 1000;

function decodeEntities(str) {
    if (!str) return "";
    return str
        .replace(/&#8217;/g, "\u2019")
        .replace(/&#8216;/g, "\u2018")
        .replace(/&#8220;/g, "\u201c")
        .replace(/&#8221;/g, "\u201d")
        .replace(/&#8211;/g, "\u2013")
        .replace(/&#8212;/g, "\u2014")
        .replace(/&#8230;|&hellip;/g, "\u2026")
        .replace(/&ldquo;/g, "\u201c")
        .replace(/&rdquo;/g, "\u201d")
        .replace(/&lsquo;/g, "\u2018")
        .replace(/&rsquo;/g, "\u2019")
        .replace(/&ndash;/g, "\u2013")
        .replace(/&mdash;/g, "\u2014")
        .replace(/&#038;|&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ");
}

function stripCdata(str) {
    if (!str) return "";
    const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return m ? m[1] : str;
}

function firstTag(block, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
    const m = block.match(re);
    return m ? m[1] : "";
}

function allTags(block, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
    const out = [];
    let m;
    while ((m = re.exec(block)) !== null) out.push(stripCdata(m[1]));
    return out;
}

// Reduce a full HTML post to clean, readable, isolated markup for the reading pane.
// Rendered inside a sandboxed <iframe srcdoc> so its own doc structure is fine;
// we only need to strip anything unsafe or noisy.
function sanitizeHtml(html) {
    if (!html) return "";
    let out = html;
    // Extract body if it's a full document.
    const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) out = bodyMatch[1];
    out = out
        .replace(/<!DOCTYPE[^>]*>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<link[^>]*>/gi, "")
        .replace(/<meta[^>]*>/gi, "")
        .replace(/ on[a-z]+="[^"]*"/gi, "")
        .replace(/ on[a-z]+='[^']*'/gi, "");
    // Drop the trailing "The post ... appeared first on ..." WP boilerplate.
    out = out.replace(/<p>\s*The post\s*<a[\s\S]*?appeared first on[\s\S]*?<\/p>/gi, "");
    return out.trim();
}

function htmlToText(html) {
    if (!html) return "";
    return decodeEntities(
        sanitizeHtml(html)
            .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
    )
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function slugFromLink(link) {
    try {
        const u = new URL(link);
        return u.pathname.replace(/^\/changelog\//, "").replace(/\/$/, "") || link;
    } catch {
        return link;
    }
}

function parseItems(xml) {
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const block = m[1];
        const link = decodeEntities(stripCdata(firstTag(block, "link")).trim());
        const title = decodeEntities(stripCdata(firstTag(block, "title")).trim());
        const author = decodeEntities(stripCdata(firstTag(block, "dc:creator")).trim());
        const pubDateRaw = stripCdata(firstTag(block, "pubDate")).trim();
        const categories = allTags(block, "category").map((c) => decodeEntities(c.trim()));
        const descriptionHtml = stripCdata(firstTag(block, "description"));
        const contentRaw = stripCdata(firstTag(block, "content:encoded"));
        const dateISO = pubDateRaw ? new Date(pubDateRaw).toISOString() : null;
        items.push({
            id: slugFromLink(link),
            title,
            link,
            author,
            date: dateISO,
            categories,
            excerpt: htmlToText(descriptionHtml).replace(/\s*Read more\s*$/i, "").slice(0, 400),
            contentHtml: sanitizeHtml(contentRaw || descriptionHtml),
            contentText: htmlToText(contentRaw || descriptionHtml),
        });
    }
    return items;
}

async function fetchPage(paged) {
    const url = paged > 1 ? `${FEED_BASE}?paged=${paged}` : FEED_BASE;
    const res = await fetch(url, {
        headers: { "User-Agent": "copilot-changelog-reader/1.0", Accept: "application/rss+xml, text/xml" },
    });
    if (!res.ok) throw new Error(`Feed request failed: ${res.status} ${res.statusText}`);
    return res.text();
}

export async function fetchEntries({ pages = 3, force = false } = {}) {
    const now = Date.now();
    if (!force && cache.entries.length && cache.pages >= pages && now - cache.at < CACHE_MS) {
        return cache.entries;
    }
    const seen = new Set();
    const entries = [];
    for (let p = 1; p <= pages; p++) {
        let xml;
        try {
            xml = await fetchPage(p);
        } catch (err) {
            if (p === 1) throw err; // first page must succeed
            break; // later pages may 404 when history is short
        }
        const items = parseItems(xml);
        if (!items.length) break;
        for (const it of items) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            entries.push(it);
        }
    }
    entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    cache = { at: now, pages, entries };
    return entries;
}
