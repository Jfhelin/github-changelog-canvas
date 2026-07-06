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

export async function setSummary(markdown, unreadIds) {
    const state = await loadState();
    return saveState({
        ...state,
        summary: { markdown, unreadIds: unreadIds || [], generatedAtISO: new Date().toISOString() },
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
    const annotated = entries.map((e) => {
        const isNew = lastRead === 0 ? true : Date.parse(e.date || 0) > lastRead;
        return { ...e, isNew };
    });
    const unread = annotated.filter((e) => e.isNew);
    const unreadIds = unread.map((e) => e.id);
    const summaryValid = !!(state.summary && sameSet(state.summary.unreadIds || [], unreadIds));
    return {
        entries: annotated,
        unread,
        unreadIds,
        status: {
            lastReadISO: state.lastReadISO,
            selectedId: state.selectedId,
            unreadCount: unread.length,
            total: entries.length,
            firstVisit: !state.lastReadISO,
        },
        summary: state.summary
            ? { markdown: state.summary.markdown, generatedAtISO: state.summary.generatedAtISO, valid: summaryValid }
            : null,
    };
}
