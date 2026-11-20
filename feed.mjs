// Fetches developer news feeds and Microsoft Learn release notes.
// No third-party deps: the feeds are controlled sources, so a focused regex
// parser is sufficient and keeps the extension dependency-free.

const SOURCES = [
    {
        key: "github",
        name: "GitHub Changelog",
        feedUrl: "https://github.blog/changelog/feed/",
        idPrefix: "",
    },
    {
        key: "github-next",
        name: "GitHub Next",
        feedUrl: "https://githubnext.com/rss.xml",
        idPrefix: "github-next:",
        paginated: false,
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
        feedUrl: "https://learn.microsoft.com/en-us/azure/devops/release-notes/toc.json",
        idPrefix: "azure-devops-release-notes:",
        format: "learn-release-notes",
    },
];

// In-memory cache so re-opens / repeated state calls don't hammer the feeds.
let cache = { at: 0, sinceISO: null, minPages: 0, entries: [], errors: [] };
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

function parseEntries(xml, source) {
    return source.format === "atom" ? parseAtomEntries(xml, source) : parseRssItems(xml, source);
}

async function fetchText(url, accept) {
    const res = await fetch(url, {
        headers: { "User-Agent": "copilot-news-reader/1.0", Accept: accept },
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Feed request failed: ${res.status} ${res.statusText}`);
    return res.text();
}

async function fetchPage(source, paged) {
    const separator = source.feedUrl.includes("?") ? "&" : "?";
    const url = paged > 1 ? `${source.feedUrl}${separator}paged=${paged}` : source.feedUrl;
    return fetchText(url, "application/rss+xml, text/xml");
}

function learnContentBlocks(html) {
    const blocks = [];
    let depth = 0, start = 0;
    // Learn separates the title and article into .content divs, with nested
    // divs for notes and code examples. Keep those, but not the page chrome.
    for (const tag of html.matchAll(/<\/?div\b[^>]*>/gi)) {
        if (depth === 0) {
            if (/^<div\b[^>]*\bclass=["']content["']/i.test(tag[0])) {
                start = tag.index + tag[0].length;
                depth = 1;
            }
        } else if (/^<\/div/i.test(tag[0])) {
            if (--depth === 0) blocks.push(html.slice(start, tag.index));
        } else {
            depth++;
        }
    }
    return blocks;
}

async function fetchAdoReleaseNotes(source, { minPages, sinceISO }) {
    const index = JSON.parse(await fetchText(source.feedUrl, "application/json"));
    if (!Array.isArray(index.items)) throw new Error("Invalid Microsoft Learn release-notes index.");
    const releases = new Map();
    function visit(items) {
        for (const item of items) {
            const match = item.href?.match(/^(\d{4})\/sprint-(\d+)-update$/);
            if (match) releases.set(Number(match[2]), new URL(item.href, source.feedUrl).href);
            if (Array.isArray(item.children)) visit(item.children);
        }
    }
    visit(index.items);
    const ordered = [...releases].sort(([a], [b]) => b - a);
    if (!ordered.length) throw new Error("No Azure DevOps sprint release notes found in Microsoft Learn index.");
    const cutoff = sinceISO ? Date.parse(sinceISO) : null;
    const entries = [], errors = [];
    let covered = cutoff === null;
    for (const [sprint, url] of ordered.slice(0, MAX_PAGES)) {
        try {
            const html = await fetchText(url, "text/html");
            const blocks = learnContentBlocks(html);
            const title = htmlToText(firstTag(blocks[0] || "", "h1"));
            const date = toISO(html.match(/<meta\b[^>]*\bname=["']ms\.date["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1]);
            if (!title || !date || !htmlToText(blocks.slice(1).join("\n"))) {
                throw new Error("Microsoft Learn release note is missing its title, publication date, or article content.");
            }
            entries.push(buildEntry(source, {
                id: `sprint-${sprint}`,
                title: `Azure DevOps Sprint ${sprint}: ${title}`,
                link: url,
                author: "Microsoft",
                date,
                categories: ["Azure DevOps", "Release notes"],
                descriptionHtml: firstTag(blocks[1], "p"),
                contentHtml: blocks.join("\n").replace(/\b(href|src)=(["'])(.*?)\2/gi,
                    (_, attribute, quote, value) =>
                        `${attribute}=${quote}${new URL(decodeEntities(value), url).href.replace(/"/g, "&quot;")}${quote}`),
            }));
            if (cutoff !== null && Date.parse(date) <= cutoff) covered = true;
        } catch (error) {
            errors.push({ source: source.name, url, message: error.message });
        }
        if (entries.length >= minPages && covered) break;
    }
    if (!covered && ordered.length > MAX_PAGES) {
        errors.push({
            source: source.name, url: source.feedUrl,
            message: `Reached the ${MAX_PAGES}-release limit before covering the requested range.`,
        });
    }
    return { entries, errors };
}

async function fetchSource(source, { minPages, sinceISO }) {
    if (source.format === "learn-release-notes") return fetchAdoReleaseNotes(source, { minPages, sinceISO });
    const cutoff = sinceISO ? Date.parse(sinceISO) : null;
    const seen = new Set();
    const entries = [];
    const errors = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        let xml;
        try {
            xml = await fetchPage(source, page);
        } catch (err) {
            if (page === 1) throw err;
            errors.push({ source: source.name, url: source.feedUrl, message: `Page ${page}: ${err.message}` });
            break;
        }
        const items = parseEntries(xml, source);
        if (!items.length) break;
        let added = 0;
        for (const item of items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            entries.push(item);
            added++;
        }
        if (source.paginated === false) break;

        const pageDates = items.map((item) => Date.parse(item.date || 0)).filter(Number.isFinite);
        const coveredCutoff = cutoff !== null && pageDates.length > 0 && Math.min(...pageDates) <= cutoff;
        if (page >= minPages && (cutoff === null || coveredCutoff)) break;
        if (!added || page === MAX_PAGES) {
            errors.push({
                source: source.name, url: source.feedUrl,
                message: !added ? `Page ${page}: feed repeated articles before covering the requested range.`
                    : `Reached the ${MAX_PAGES}-page limit before covering the requested range.`,
            });
            break;
        }
    }
    return { entries, errors };
}

export function getFeedErrors() {
    return cache.errors.map((error) => ({ ...error }));
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

    const results = await Promise.allSettled(SOURCES.map((source) => fetchSource(source, { minPages, sinceISO })));
    const perSource = [];
    const errors = [];
    for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
            perSource.push(result.value.entries);
            errors.push(...result.value.errors);
        } else {
            errors.push({ source: SOURCES[index].name, url: SOURCES[index].feedUrl, message: result.reason.message });
        }
    }
    if (!perSource.length) {
        throw new Error(`All news feeds failed: ${errors.map((error) => `${error.source}: ${error.message}`).join("; ")}`);
    }
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
    cache = { at: now, sinceISO, minPages, entries, errors };
    return entries;
}
