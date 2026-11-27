import test from "node:test";
import assert from "node:assert/strict";
import { createReaderContext } from "./context.mjs";

test("two simultaneous conversations keep selections and handoffs isolated", () => {
    const context = createReaderContext();
    context.select("a", "article-1");
    context.select("b", "article-2");
    assert.equal(context.selectedId("a"), "article-1");
    assert.equal(context.selectedId("b"), "article-2");
    assert.equal(context.selectedId("c"), null);
    assert.equal(context.selectedId(null), null);

    const prompt = "I'd like to discuss this developer news article";
    context.queueHandoff("a", { prompt, kind: "article", articleId: "article-1" });
    assert.equal(context.consumeHandoff("b", prompt), null);
    assert.equal(context.consumeHandoff(undefined, prompt), null);
    assert.equal(context.consumeHandoff("a", "Pull new data and give me an updated canvas"), null);
    assert.equal(context.consumeHandoff("a", `  ${prompt}\n`).articleId, "article-1");
    assert.equal(context.consumeHandoff("a", prompt), null);

    context.select("a", null);
    assert.equal(context.selectedId("a"), null);
    assert.equal(context.selectedId("b"), "article-2");
    context.clearSession("b");
    assert.equal(context.selectedId("b"), null);
});

test("handoffs expire, can be cancelled, and require a session", () => {
    let now = 0;
    const context = createReaderContext({ now: () => now });
    const expired = context.queueHandoff("a", { prompt: "discuss", kind: "article", articleId: "x" });
    now = expired.expiresAt;
    assert.equal(context.consumeHandoff("a", "discuss"), null);

    const cancelled = context.queueHandoff("a", { prompt: "discuss", kind: "article", articleId: "x" });
    context.cancelHandoff("a", cancelled);
    assert.equal(context.consumeHandoff("a", "discuss"), null);

    assert.throws(() => context.queueHandoff(null, { prompt: "discuss", kind: "article" }), /session/);
    assert.throws(() => context.select("", "x"), /session/);
});
