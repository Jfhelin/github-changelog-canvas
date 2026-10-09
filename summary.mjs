export const summaryRangeProperties = {
    after: {
        type: "string",
        description: "Inclusive publication start as an ISO timestamp with timezone. Preserve the user's requested period.",
    },
    before: {
        type: "string",
        description: "Exclusive publication end as an ISO timestamp with timezone.",
    },
};

export const summaryScopeInstructions =
    "Preserve any date range the user requested earlier in this conversation unless they explicitly change it. " +
    "Resolve relative dates using the current date and user's timezone; pass after/before to get_unread_for_summary. " +
    "Every candidate means every candidate within that range, not the entire unread backlog. " +
    "Pass the returned scope and candidateIds unchanged to set_unread_summary. " +
    "Do not mark older articles read to narrow a summary.";

export function normalizeScope(input = {}) {
    const scope = {};
    for (const key of ["after", "before"]) {
        if (input[key] === undefined) continue;
        const value = input[key];
        if (typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
            !Number.isFinite(Date.parse(value))) {
            throw new Error(`Provide '${key}' as an ISO timestamp with an explicit timezone.`);
        }
        const [year, month, day] = value.slice(0, 10).split("-").map(Number);
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (month < 1 || month > 12 || day < 1 || day > daysInMonth)
            throw new Error(`Provide '${key}' as a valid calendar timestamp.`);
        scope[key] = new Date(value).toISOString();
    }
    if (scope.after && scope.before && scope.after >= scope.before)
        throw new Error("'after' must be earlier than 'before'.");
    return scope;
}

export function scopeCandidates(entries, scope = {}) {
    const after = scope.after ? Date.parse(scope.after) : -Infinity;
    const before = scope.before ? Date.parse(scope.before) : Infinity;
    return entries.filter((entry) => {
        const published = Date.parse(entry.date);
        return published >= after && published < before;
    });
}

export function validateSummary(markdown, candidates, candidateIds, relevantIds, isAlwaysIncluded) {
    if (typeof markdown !== "string" || !markdown.trim())
        throw new Error("Provide a non-empty 'markdown' string.");
    const expectedIds = new Set(candidates.map((entry) => entry.id));
    if (!Array.isArray(candidateIds) || candidateIds.length !== expectedIds.size ||
        new Set(candidateIds).size !== expectedIds.size || candidateIds.some((id) => !expectedIds.has(id)))
        throw new Error("Summary candidates changed or scope does not match. Fetch get_unread_for_summary again with the requested range.");
    if (!Array.isArray(relevantIds))
        throw new Error("Provide 'relevantExternalIds' as an array.");
    const externalIds = new Set(candidates.filter((entry) => !isAlwaysIncluded(entry)).map((entry) => entry.id));
    if (new Set(relevantIds).size !== relevantIds.length || relevantIds.some((id) => !externalIds.has(id)))
        throw new Error("External article IDs must be unique and belong to the fetched scope.");
    const included = candidates.filter((entry) => isAlwaysIncluded(entry) || relevantIds.includes(entry.id));
    const linkedIds = [...markdown.matchAll(/\]\(article:([^)\s]+)\)/g)].map((match) => {
        try {
            return decodeURIComponent(match[1]);
        } catch {
            throw new Error(`Invalid article link: ${match[1]}`);
        }
    });
    const includedIds = new Set(included.map((entry) => entry.id));
    const unexpected = linkedIds.filter((id) => !includedIds.has(id));
    if (unexpected.length) throw new Error(`Article links outside the selected scope: ${unexpected.join(", ")}`);
    const headings = new Set([...markdown.matchAll(/^## ([^\r\n]+)\s*$/gm)].map((match) => match[1].trim()));
    const missingSources = [...new Set(included.map((entry) => entry.sourceName))].filter((name) => !headings.has(name));
    if (missingSources.length) throw new Error(`Add source headings for: ${missingSources.join(", ")}`);
    const missingLinks = included.filter((entry) => !linkedIds.includes(entry.id)).map((entry) => entry.id);
    if (missingLinks.length) throw new Error(`Add internal article links for: ${missingLinks.join(", ")}`);
    return included;
}
