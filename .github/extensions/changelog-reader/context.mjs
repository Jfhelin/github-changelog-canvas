// Session-local reader context.
//
// Feed caches, read markers, and saved summaries are shared across sessions
// (store.mjs). The article being discussed and any pending chat handoff are
// not: they live in memory, keyed by the runtime session ID supplied by the
// SDK (canvas request `sessionId`, hook `invocation.sessionId`). Nothing here
// is persisted, so a selection in one conversation can never surface in
// another, and a restarted extension starts with no active article.

const HANDOFF_TTL_MS = 10 * 60 * 1000;

function normalizePrompt(prompt) {
    return typeof prompt === "string" ? prompt.trim() : "";
}

export function createReaderContext({ now = () => Date.now() } = {}) {
    const selections = new Map(); // sessionId -> article id
    const handoffs = new Map(); // sessionId -> [{ prompt, kind, articleId, expiresAt }]

    function pending(sessionId) {
        const live = (handoffs.get(sessionId) || []).filter((h) => h.expiresAt > now());
        if (live.length) handoffs.set(sessionId, live);
        else handoffs.delete(sessionId);
        return live;
    }

    return {
        select(sessionId, articleId) {
            if (!sessionId) throw new Error("A session ID is required to select an article.");
            if (articleId) selections.set(sessionId, articleId);
            else selections.delete(sessionId);
        },
        selectedId(sessionId) {
            return (sessionId && selections.get(sessionId)) || null;
        },
        // Record a prompt the reader is about to send to this session so the
        // prompt hook can recognise it as an explicit reader handoff.
        queueHandoff(sessionId, { prompt, kind, articleId = null }) {
            if (!sessionId) throw new Error("A session ID is required for a reader handoff.");
            const handoff = { prompt: normalizePrompt(prompt), kind, articleId, expiresAt: now() + HANDOFF_TTL_MS };
            handoffs.set(sessionId, [...pending(sessionId), handoff]);
            return handoff;
        },
        cancelHandoff(sessionId, handoff) {
            const remaining = pending(sessionId).filter((h) => h !== handoff);
            if (remaining.length) handoffs.set(sessionId, remaining);
            else handoffs.delete(sessionId);
        },
        // Returns and consumes the handoff only when this exact prompt was sent
        // by the reader to this session; every other prompt gets null.
        consumeHandoff(sessionId, prompt) {
            if (!sessionId) return null;
            const text = normalizePrompt(prompt);
            const live = pending(sessionId);
            const index = live.findIndex((h) => h.prompt === text);
            if (index === -1) return null;
            const [handoff] = live.splice(index, 1);
            if (live.length) handoffs.set(sessionId, live);
            else handoffs.delete(sessionId);
            return handoff;
        },
        clearSession(sessionId) {
            selections.delete(sessionId);
            handoffs.delete(sessionId);
        },
    };
}
