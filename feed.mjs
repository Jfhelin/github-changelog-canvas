// Fetches and parses the GitHub Changelog and Microsoft Developer Blogs feeds.
// No third-party deps: both feeds are controlled sources, so a focused regex
// parser is sufficient and keeps the extension dependency-free.

const SOURCES = [
    {
        key: "github",
        name: "GitHub Changelog",
        feedUrl: "https://github.blog/changelog/feed/",
        idPrefix: "",
    },
    {
        key: "microsoft-devblogs",
        name: "Microsoft Developer Blogs",
        feedUrl: "https://devblogs.microsoft.com/feed/",
        idPrefix: "microsoft-devblogs:",
    },
    {
        key: "microsoft-devblogs",
        name: "Microsoft Developer Blogs (Azure DevOps Blog)",
        feedUrl: "https://devblogs.microsoft.com/devops/feed/",
        idPrefix: "microsoft-devblogs:",
    },
    {
        key: "github-ai-ml",
        name: "GitHub AI & ML",
        feedUrl: "https://github.blog/ai-and-ml/feed/",
        idPrefix: "github-ai-ml:",
    },
    {
        key: "github-security",
        name: "GitHub Security",
        feedUrl: "https://github.blog/security/feed/",
        idPrefix: "github-security:",
    },
    {
        key: "vscode",
        name: "Visual Studio Code",
        feedUrl: "https://code.visualstudio.com/feed.xml",
        idPrefix: "vscode:",
        format: "atom",
        paginated: false,
    },
    {
        key: "azure-devops-release-notes",
        name: "Azure DevOps Release Notes",
        feedUrl: "https://github.com/MicrosoftDocs/azure-devops-docs/commits/main/release-notes.atom",
        idPrefix: "azure-devops-release-notes:",
        format: "atom",
        paginated: false,
        transform: transformAdoReleaseEntry,
    },
];

// In-memory cache so re-opens / repeated state calls don't hammer the feeds.
let cache = { at: 0, sinceISO: null, minPages: 0, entries: [] };
const CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 50;

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

function toISO(raw) {
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildEntry(source, { id, title, link, author, date, categories, descriptionHtml, contentHtml }) {
    return {
        id: source.idPrefix + id,
        title,
        link,
        author,
        date,
        categories,
        source: source.key,
        sourceName: source.name,
        excerpt: htmlToText(descriptionHtml).replace(/\s*Read more\s*$/i, "").slice(0, 400),
        contentHtml: sanitizeHtml(contentHtml || descriptionHtml),
        contentText: htmlToText(contentHtml || descriptionHtml),
    };
}

function parseRssItems(xml, source) {
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
        const slug = slugFromLink(link);
        items.push(buildEntry(source, {
            id: slug,
            title,
            link,
            author,
            date: toISO(pubDateRaw),
            categories,
            descriptionHtml,
            contentHtml: contentRaw,
        }));
    }
    return items;
}

function atomCategories(block) {
    const categories = [];
    const re = /<category\b[^>]*\bterm=["']([^"']+)["'][^>]*\/?>/gi;
    let match;
    while ((match = re.exec(block)) !== null) categories.push(decodeEntities(match[1]));
    return categories;
}

function parseAtomEntries(xml, source) {
    const entries = [];
    const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    let match;
    while ((match = re.exec(xml)) !== null) {
        const block = match[1];
        const linkMatch =
            block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i) ||
            block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
        const link = decodeEntities(linkMatch ? linkMatch[1] : stripCdata(firstTag(block, "id")).trim());
        const title = decodeEntities(stripCdata(firstTag(block, "title")).trim());
        const authorBlock = firstTag(block, "author");
        const author = decodeEntities(stripCdata(firstTag(authorBlock, "name")).trim());
        const dateRaw = stripCdata(firstTag(block, "published") || firstTag(block, "updated")).trim();
        const summaryRaw = decodeEntities(stripCdata(firstTag(block, "summary")));
        const contentRaw = decodeEntities(stripCdata(firstTag(block, "content")));
        entries.push(buildEntry(source, {
            id: slugFromLink(link),
            title,
            link,
            author,
            date: toISO(dateRaw),
            categories: atomCategories(block),
            descriptionHtml: summaryRaw,
            contentHtml: contentRaw,
        }));
    }
    return entries;
}

function transformAdoReleaseEntry(entry) {
    const match = entry.title.match(/Azure DevOps Sprint\s+(\d+)\s+Release Notes/i);
    if (!match) return null;
    return {
        ...entry,
        id: `azure-devops-release-notes:sprint-${match[1]}`,
        title: `Azure DevOps Sprint ${match[1]} Update`,
        categories: ["Azure DevOps", "Release notes"],
    };
}

function parseEntries(xml, source) {
    const parsed = source.format === "atom" ? parseAtomEntries(xml, source) : parseRssItems(xml, source);
    if (!source.transform) return parsed;
    return parsed.map((entry) => source.transform(entry)).filter(Boolean);
}

async function fetchPage(source, paged) {
    const separator = source.feedUrl.includes("?") ? "&" : "?";
    const url = paged > 1 ? `${source.feedUrl}${separator}paged=${paged}` : source.feedUrl;
    const res = await fetch(url, {
        headers: { "User-Agent": "copilot-news-reader/1.0", Accept: "application/rss+xml, text/xml" },
    });
    if (!res.ok) throw new Error(`Feed request failed: ${res.status} ${res.statusText}`);
    return res.text();
}

async function fetchSource(source, { minPages, sinceISO }) {
    const cutoff = sinceISO ? Date.parse(sinceISO) : null;
    const seen = new Set();
    const entries = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        let xml;
        try {
            xml = await fetchPage(source, page);
        } catch (err) {
            if (page === 1) throw err;
            break;
        }
        const items = parseEntries(xml, source);
        if (!items.length) break;
        for (const item of items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            entries.push(item);
        }
        if (source.paginated === false) break;

        const pageDates = items.map((item) => Date.parse(item.date || 0)).filter(Number.isFinite);
        const coveredCutoff = cutoff !== null && pageDates.length > 0 && Math.min(...pageDates) <= cutoff;
        if (page >= minPages && (cutoff === null || coveredCutoff)) break;
    }
    return entries;
}

export async function fetchEntries({ minPages = 3, sinceISO = null, force = false } = {}) {
    const now = Date.now();
    if (
        !force &&
        cache.entries.length &&
        cache.minPages >= minPages &&
        cache.sinceISO === sinceISO &&
        now - cache.at < CACHE_MS
    ) {
        return cache.entries;
    }

    const perSource = await Promise.all(SOURCES.map((source) => fetchSource(source, { minPages, sinceISO })));
    const seenIds = new Set();
    const seenLinks = new Set();
    const entries = perSource.flat().filter((entry) => {
        const normalizedLink = entry.link.replace(/\/$/, "");
        if (seenIds.has(entry.id) || seenLinks.has(normalizedLink)) return false;
        seenIds.add(entry.id);
        seenLinks.add(normalizedLink);
        return true;
    });
    entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    cache = { at: now, sinceISO, minPages, entries };
    return entries;
}
