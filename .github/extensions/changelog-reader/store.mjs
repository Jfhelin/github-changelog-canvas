// Durable, user-scoped state for the changelog reader.
// Stored under $COPILOT_HOME/changelog-reader/, independent of where the
// extension is installed (project or user scope), so the last-read date and
// generated summary persist across all sessions and worktrees.
// The article being discussed is deliberately NOT stored here: it is
// session-local (see context.mjs). A legacy `selectedId` left in state.json by
// older versions is preserved on disk but never read.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { scopeCandidates } from "./summary.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE_PATH = join(COPILOT_HOME, "changelog-reader", "state.json");
// Location used by older user-scoped installs; copied forward on first load.
const LEGACY_STATE_PATH = join(COPILOT_HOME, "extensions", "changelog-reader", "artifacts", "state.json");

const DEFAULT_STATE = { lastReadISO: null, summary: null };

async function readStateFile() {
    try {
        return await readFile(STATE_PATH, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    try {
        const legacy = await readFile(LEGACY_STATE_PATH, "utf8");
        await mkdir(dirname(STATE_PATH), { recursive: true });
        await writeFile(STATE_PATH, legacy, { encoding: "utf8", flag: "wx" }).catch((error) => {
            if (error.code !== "EEXIST") throw error;
        });
        return await readFile(STATE_PATH, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
    }
}

export async function loadState() {
    const raw = await readStateFile();
    return raw === null ? { ...DEFAULT_STATE } : { ...DEFAULT_STATE, ...JSON.parse(raw) };
}

async function saveState(state) {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
    return state;
}

export async function markAllRead(whenISO = new Date().toISOString()) {
    const state = await loadState();
    // Clear the summary: once read, the unread set changes and it no longer applies.
    return saveState({ ...state, lastReadISO: whenISO, summary: null });
}

export async function setSummary(markdown, candidateIds, relevantExternalIds, scope = {}) {
    const state = await loadState();
    return saveState({
        ...state,
        summary: {
            markdown,
            candidateIds: candidateIds || [],
            relevantExternalIds: relevantExternalIds || [],
            scope,
            generatedAtISO: new Date().toISOString(),
        },
    });
}

function sameSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every((x) => sa.has(x));
}

export function isAlwaysIncluded(entry) {
    return entry.source === "github" || entry.source === "github-next";
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
    const scope = state.summary?.scope || {};
    const scopedCandidates = scopeCandidates(summaryCandidates, scope);
    const summaryValid = !!(state.summary && sameSet(storedCandidateIds, scopedCandidates.map((e) => e.id)));
    const storedRelevantIds =
        state.summary && (state.summary.relevantExternalIds || state.summary.relevantDevBlogIds || []);
    const relevantExternalIds = new Set(
        summaryValid && Array.isArray(storedRelevantIds) ? storedRelevantIds : []
    );
    const hasDateScope = !!(scope.after || scope.before);
    const reviewCandidates = hasDateScope ? scopedCandidates : summaryCandidates;
    const unread = reviewCandidates.filter((e) => isAlwaysIncluded(e) || relevantExternalIds.has(e.id));
    const readingEntries = scopeCandidates(annotated, scope).filter((e) => isAlwaysIncluded(e) || relevantExternalIds.has(e.id));
    const waitForInitialSummary = !state.lastReadISO && !summaryValid;
    let navigationEntries;
    if (hasDateScope) {
        navigationEntries = summaryValid
            ? scopedCandidates.filter((e) => isAlwaysIncluded(e) || relevantExternalIds.has(e.id))
            : [];
    } else if (waitForInitialSummary) {
        navigationEntries = [];
    } else {
        navigationEntries = unread.length > 0 ? unread : readingEntries;
    }
    const microsoftCandidates = reviewCandidates.filter((e) => e.source === "microsoft-devblogs");
    return {
        entries: readingEntries,
        unread,
        navigationEntries,
        summaryCandidates,
        candidateIds,
        status: {
            lastReadISO: state.lastReadISO,
            unreadCount: unread.length,
            reviewCount: reviewCandidates.length,
            microsoftCandidateCount: microsoftCandidates.length,
            microsoftRelevantCount: unread.filter((e) => e.source === "microsoft-devblogs").length,
            externalCandidateCount: reviewCandidates.filter((e) => !isAlwaysIncluded(e)).length,
            externalRelevantCount: unread.filter((e) => !isAlwaysIncluded(e)).length,
            summaryReady: summaryValid,
            total: readingEntries.length,
            firstVisit: !state.lastReadISO,
        },
        summary: state.summary
            ? {
                markdown: state.summary.markdown,
                generatedAtISO: state.summary.generatedAtISO,
                valid: summaryValid,
                scope,
                includedCount: scopedCandidates.filter((e) => isAlwaysIncluded(e) || relevantExternalIds.has(e.id)).length,
            }
            : null,
    };
}
