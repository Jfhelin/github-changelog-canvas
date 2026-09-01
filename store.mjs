// Durable, user-scoped state for the changelog reader.
// Stored under the extension's own artifacts dir so it follows the user across
// all sessions (last-read date + the generated summary must persist).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE_PATH = join(COPILOT_HOME, "extensions", "changelog-reader", "artifacts", "state.json");

const DEFAULT_STATE = { lastReadISO: null, selectedId: null, summary: null };

let memo = null;

export async function loadState() {
    if (memo) return memo;
    try {
        const raw = await readFile(STATE_PATH, "utf8");
        memo = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
        memo = { ...DEFAULT_STATE };
    }
    return memo;
}

async function saveState(state) {
    memo = state;
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    return state;
}

export async function markAllRead(whenISO = new Date().toISOString()) {
    const state = await loadState();
    // Clear the summary: once read, the unread set changes and it no longer applies.
    return saveState({ ...state, lastReadISO: whenISO, summary: null });
}

export async function setSelected(id) {
    const state = await loadState();
    return saveState({ ...state, selectedId: id || null });
}

export async function setSummary(markdown, candidateIds, relevantExternalIds) {
    const state = await loadState();
    return saveState({
        ...state,
        summary: {
            markdown,
            candidateIds: candidateIds || [],
            relevantExternalIds: relevantExternalIds || [],
            generatedAtISO: new Date().toISOString(),
        },
    });
}

function sameSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every((x) => sa.has(x));
}

// Annotate entries with `isNew` (unread) and build the reading view.
// Unread rule: first visit (no last-read) => everything is unread; otherwise
// anything published after the last-read timestamp.
export function computeView(entries, state) {
    const lastRead = state.lastReadISO ? Date.parse(state.lastReadISO) : 0;
    const now = Date.now();
    const annotated = entries.map((e) => {
        const publishedAt = Date.parse(e.date || 0);
        const isNew = Number.isFinite(publishedAt) && publishedAt <= now && (lastRead === 0 || publishedAt > lastRead);
        return { ...e, isNew };
    });
    const summaryCandidates = annotated.filter((e) => e.isNew);
    const candidateIds = summaryCandidates.map((e) => e.id);
    const storedCandidateIds = state.summary && (state.summary.candidateIds || state.summary.unreadIds || []);
    const summaryValid = !!(state.summary && sameSet(storedCandidateIds, candidateIds));
    const storedRelevantIds =
        state.summary && (state.summary.relevantExternalIds || state.summary.relevantDevBlogIds || []);
    const relevantExternalIds = new Set(
        summaryValid && Array.isArray(storedRelevantIds) ? storedRelevantIds : []
    );
    const unread = summaryCandidates.filter((e) => e.source === "github" || relevantExternalIds.has(e.id));
    const readingEntries = annotated.filter((e) => e.source === "github" || relevantExternalIds.has(e.id));
    const microsoftCandidates = summaryCandidates.filter((e) => e.source === "microsoft-devblogs");
    return {
        entries: readingEntries,
        unread,
        summaryCandidates,
        candidateIds,
        status: {
            lastReadISO: state.lastReadISO,
            selectedId: state.selectedId,
            unreadCount: unread.length,
            reviewCount: summaryCandidates.length,
            microsoftCandidateCount: microsoftCandidates.length,
            microsoftRelevantCount: unread.filter((e) => e.source === "microsoft-devblogs").length,
            externalCandidateCount: summaryCandidates.filter((e) => e.source !== "github").length,
            externalRelevantCount: unread.filter((e) => e.source !== "github").length,
            summaryReady: summaryValid,
            total: readingEntries.length,
            firstVisit: !state.lastReadISO,
        },
        summary: state.summary
            ? { markdown: state.summary.markdown, generatedAtISO: state.summary.generatedAtISO, valid: summaryValid }
            : null,
    };
}
