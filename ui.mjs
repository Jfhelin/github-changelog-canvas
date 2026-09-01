// Light-mode reading UI for the GitHub Changelog reader.
// Layout: a sticky header that acts as the navigator (prev / next / actions),
// and a body that shows ONE thing at a time — page 0 is the LLM summary of
// unread articles, pages 1..N are individual articles.
//
// The client script fetches state from /api/state and drives everything in the
// browser. NOTE: this whole document is an outer template literal, so the
// embedded client JS must avoid backticks and ${...} — we use string
// concatenation, and reference the backtick char via String.fromCharCode(96).

export function renderPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Developer News</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #f6f8fa;
    color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
  }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header.nav {
    position: sticky; top: 0; z-index: 10;
    background: #ffffff;
    border-bottom: 1px solid #d1d9e0;
    box-shadow: 0 1px 0 rgba(27,31,36,0.04);
    padding: 12px 16px 10px;
  }
  .brandrow { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .brand { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
  .status { color: #59636e; font-size: 12.5px; }
  .navrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .pos {
    min-width: 108px; text-align: center; font-size: 12.5px; font-weight: 600;
    color: #424a53; user-select: none;
  }
  .spacer { flex: 1 1 auto; }

  button {
    font: inherit; font-size: 13px; font-weight: 600;
    color: #1f2328; background: #f6f8fa;
    border: 1px solid rgba(27,31,36,0.15); border-radius: 6px;
    padding: 5px 12px; cursor: pointer; white-space: nowrap;
  }
  button:hover:not(:disabled) { background: #eef1f4; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { color: #ffffff; background: #1f883d; border-color: rgba(27,31,36,0.15); }
  button.primary:hover:not(:disabled) { background: #1a7f37; }
  button.accent { color: #ffffff; background: #8250df; border-color: rgba(27,31,36,0.15); }
  button.accent:hover:not(:disabled) { background: #7141d6; }
  button.icon { padding: 5px 9px; }

  main { flex: 1 1 auto; overflow: auto; padding: 20px 16px 48px; }
  .wrap { max-width: 760px; margin: 0 auto; }

  .card {
    background: #ffffff; border: 1px solid #d1d9e0; border-radius: 10px;
    padding: 22px 24px; box-shadow: 0 1px 3px rgba(27,31,36,0.06);
  }

  .meta { color: #59636e; font-size: 12.5px; margin-bottom: 6px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; background: #dafbe1; color: #1a7f37; border: 1px solid rgba(31,136,61,0.25);
           font-size: 10.5px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
           padding: 1px 6px; border-radius: 999px; }
  .cat { background: #ddf4ff; color: #0969da; border: 1px solid rgba(9,105,218,0.2);
         font-size: 11px; padding: 1px 7px; border-radius: 999px; }
  .source { display: inline-block; background: #f6f8fa; color: #424a53; border: 1px solid #d1d9e0;
            font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; }
  .source-ms { background: #fff8c5; color: #633c01; border-color: #d4a72c; }
  .art-title { font-size: 22px; font-weight: 700; line-height: 1.3; margin: 4px 0 14px; letter-spacing: -0.01em; }
  .art-title a { color: #1f2328; }

  /* Rendered article content */
  .article { font-size: 15px; }
  .article p { margin: 0 0 14px; }
  .article h1, .article h2, .article h3, .article h4 { line-height: 1.3; margin: 22px 0 10px; font-weight: 700; }
  .article h1 { font-size: 20px; } .article h2 { font-size: 18px; } .article h3 { font-size: 16px; }
  .article ul, .article ol { margin: 0 0 14px; padding-left: 22px; }
  .article li { margin: 4px 0; }
  .article img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #d1d9e0; margin: 8px 0; }
  .article video { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #d1d9e0; margin: 8px 0; }
  .article pre { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px; padding: 12px; overflow: auto; }
  .article code { background: rgba(129,139,152,0.15); border-radius: 4px; padding: 1px 5px;
                 font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 85%; }
  .article pre code { background: transparent; padding: 0; }
  .article blockquote { margin: 0 0 14px; padding: 4px 14px; color: #59636e; border-left: 3px solid #d1d9e0; }
  .article table { border-collapse: collapse; margin: 0 0 14px; display: block; overflow: auto; }
  .article th, .article td { border: 1px solid #d1d9e0; padding: 6px 12px; }

  /* Summary page */
  .summary-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .summary-head h1 { font-size: 20px; margin: 0; }
  .sub { color: #59636e; font-size: 13px; margin: 2px 0 18px; }
  .md { font-size: 15px; }
  .md h1 { font-size: 19px; } .md h2 { font-size: 17px; margin: 20px 0 8px; }
  .md h3 { font-size: 15px; margin: 16px 0 6px; }
  .md ul { padding-left: 22px; margin: 0 0 12px; } .md li { margin: 4px 0; }
  .md p { margin: 0 0 12px; }
  .md code { background: rgba(129,139,152,0.15); border-radius: 4px; padding: 1px 5px;
            font-family: "SFMono-Regular", Consolas, monospace; font-size: 85%; }
  .center { text-align: center; }
  .empty-ico { font-size: 40px; }
  .rowbtns { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 18px; }
  .footbtns { margin-top: 22px; padding-top: 16px; border-top: 1px solid #eaeef2; display: flex; gap: 10px; flex-wrap: wrap; }
  button.summary-link {
    appearance: none; display: inline; padding: 2px 0; border: 0; background: transparent;
    color: #0969da; font: inherit; font-weight: 600; text-align: left; white-space: normal;
  }
  button.summary-link:hover:not(:disabled) { background: transparent; text-decoration: underline; }

  .spin { display: inline-block; width: 15px; height: 15px; border: 2px solid rgba(130,80,223,0.25);
          border-top-color: #8250df; border-radius: 50%; animation: sp 0.8s linear infinite; vertical-align: -3px; margin-right: 8px; }
  @keyframes sp { to { transform: rotate(360deg); } }

  #toast {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(12px);
    background: #1f2328; color: #fff; font-size: 13px; padding: 9px 16px; border-radius: 8px;
    box-shadow: 0 4px 14px rgba(27,31,36,0.25); opacity: 0; pointer-events: none;
    transition: opacity .18s ease, transform .18s ease; z-index: 50; max-width: 80%;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
  <header class="nav">
    <div class="brandrow">
      <span class="brand">📰 Developer News</span>
      <span class="status" id="status">Loading…</span>
    </div>
    <div class="navrow">
      <button class="icon" data-act="summary" id="btnSummary" title="Back to summary">Summary</button>
      <button class="icon" data-act="prev" id="btnPrev" title="Previous (←)">◀ Prev</button>
      <span class="pos" id="pos">—</span>
      <button class="icon" data-act="next" id="btnNext" title="Next (→)">Next ▶</button>
      <span class="spacer"></span>
      <button class="accent" data-act="discuss" id="btnDiscuss">💬 Discuss with Copilot</button>
      <button data-act="markread" id="btnMark">✓ Mark all read</button>
      <button class="icon" data-act="refresh" title="Refresh feed">⟳</button>
    </div>
  </header>
  <main><div class="wrap" id="app"></div></main>
  <div id="toast"></div>

<script>
(function () {
  var data = { status: {}, summary: null, articles: [] };
  var idx = 0;            // 0 = summary page, 1..N = article pages
  var generating = false;
  var toastTimer = null;

  var app = document.getElementById("app");
  var elStatus = document.getElementById("status");
  var elPos = document.getElementById("pos");
  var btnPrev = document.getElementById("btnPrev");
  var btnSummary = document.getElementById("btnSummary");
  var btnNext = document.getElementById("btnNext");
  var btnDiscuss = document.getElementById("btnDiscuss");
  var btnMark = document.getElementById("btnMark");
  var toastEl = document.getElementById("toast");

  function api(path, opts) {
    return fetch(path, opts || {}).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 3200);
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // ---- tiny markdown -> html (headings, lists, bold, links, inline code) ----
  function inlineMd(s) {
    s = esc(s);
    s = s.replace(/\\[([^\\]]+)\\]\\(article:([^)\\s]+)\\)/g, function (_, text, id) {
      var safeId = id.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      return '<button class="summary-link" data-act="openbyid" data-id="' + safeId + '">' + text + "</button>";
    });
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    var bt = String.fromCharCode(96);
    var codeRe = new RegExp(bt + "([^" + bt + "]+)" + bt, "g");
    s = s.replace(codeRe, "<code>$1</code>");
    return s;
  }
  function mdToHtml(md) {
    var lines = String(md || "").split(/\\r?\\n/);
    var out = "", inList = false;
    function closeList() { if (inList) { out += "</ul>"; inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { closeList(); continue; }
      var h = t.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { closeList(); var lvl = h[1].length; out += "<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">"; continue; }
      var li = t.match(/^[-*]\\s+(.*)$/);
      if (li) { if (!inList) { out += "<ul>"; inList = true; } out += "<li>" + inlineMd(li[1]) + "</li>"; continue; }
      closeList();
      out += "<p>" + inlineMd(t) + "</p>";
    }
    closeList();
    return out;
  }

  function articleCount() { return data.articles.length; }

  function clampIdx() {
    if (idx < 0) idx = 0;
    var max = articleCount();
    if (idx > max) idx = max;
  }

  function renderHeader() {
    var st = data.status || {};
    var txt;
    if (st.firstVisit) txt = "First visit — " + (st.reviewCount || 0) + " updates to review";
    else if ((st.reviewCount || 0) > 0 && !st.summaryReady) txt = (st.reviewCount || 0) + " updates awaiting relevance review";
    else if ((st.reviewCount || 0) > 0) txt = (st.unreadCount || 0) + " relevant updates since " + (fmtDate(st.lastReadISO) || "last visit");
    else txt = "All caught up · last read " + (fmtDate(st.lastReadISO) || "—");
    elStatus.textContent = txt;

    var n = articleCount();
    elPos.textContent = idx === 0 ? "Summary" : ("Article " + idx + " / " + n);
    btnPrev.disabled = idx === 0;
    btnSummary.disabled = idx === 0;
    btnNext.disabled = idx >= n;
    var onArticle = idx > 0 && n > 0;
    btnDiscuss.style.display = onArticle ? "" : "none";
    btnMark.disabled = (st.reviewCount || 0) === 0;
  }

  function currentArticle() {
    if (idx <= 0) return null;
    return data.articles[idx - 1] || null;
  }

  function renderBody() {
    if (idx === 0) { renderSummary(); return; }
    var a = currentArticle();
    if (!a) { renderSummary(); return; }
    var cats = (a.categories || []).slice(0, 3).map(function (c) {
      return '<span class="cat">' + esc(c) + "</span>";
    }).join(" ");
    var badge = a.isNew ? '<span class="badge">New</span>' : "";
    var sourceClass = String(a.source || "").indexOf("microsoft") === 0 ? "source source-ms" : "source";
    var source = '<span class="' + sourceClass + '">Source: ' + esc(a.sourceName || "GitHub Changelog") + "</span>";
    var html =
      '<article class="card">' +
      '<div class="meta">' + badge + source +
        (a.date ? "<span>" + esc(fmtDate(a.date)) + "</span>" : "") +
        (a.author ? "<span>· " + esc(a.author) + "</span>" : "") +
        (cats ? "<span>" + cats + "</span>" : "") +
      "</div>" +
      '<h2 class="art-title"><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title) + "</a></h2>" +
      '<div class="article" id="artbody"></div>' +
      '<div class="footbtns">' +
        '<button class="accent" data-act="discuss">💬 Discuss with Copilot</button>' +
        (idx < articleCount() ? '<button class="primary" data-act="next">Next update ▶</button>' : "") +
      "</div>" +
      "</article>";
    app.innerHTML = html;
    // Inject already-sanitized article HTML directly.
    var body = document.getElementById("artbody");
    if (body) body.innerHTML = a.contentHtml || "<p>(No content.)</p>";
  }

  function renderSummary() {
    var st = data.status || {};
    var unread = st.unreadCount || 0;
    var reviewCount = st.reviewCount || 0;

    if (reviewCount === 0) {
      app.innerHTML =
        '<div class="card center">' +
        '<div class="empty-ico">🎉</div>' +
        "<h1>You're all caught up</h1>" +
        '<p class="sub">No unread GitHub Changelog updates. You can still browse the ' + articleCount() + " most recent below.</p>" +
        '<div class="rowbtns">' +
          (articleCount() > 0 ? '<button class="primary" data-act="goarticles">Browse recent ▶</button>' : "") +
          '<button data-act="refresh">⟳ Refresh</button>' +
        "</div></div>";
      return;
    }

    var sum = data.summary;
    var summaryCount = sum && sum.valid ? unread : reviewCount;
    var head =
      '<div class="summary-head"><h1>✨ Your unread summary</h1></div>' +
      '<p class="sub">' + summaryCount + " update" + (summaryCount === 1 ? "" : "s") +
      (sum && sum.valid ? " relevant to you." : " to review across GitHub and Microsoft Developer Blogs.") + "</p>";

    if (generating) {
      app.innerHTML =
        '<div class="card">' + head +
        '<p><span class="spin"></span>Asking Copilot to summarize your unread updates… this appears here automatically when ready.</p>' +
        "</div>";
      return;
    }

    if (sum && sum.valid && sum.markdown) {
      app.innerHTML =
        '<div class="card">' + head +
        '<div class="md">' + mdToHtml(sum.markdown) + "</div>" +
        '<div class="footbtns">' +
          '<button class="primary" data-act="goarticles">Start reading ▶</button>' +
          '<button data-act="summarize">↻ Regenerate</button>' +
        "</div></div>";
      return;
    }

    var stale = sum && !sum.valid;
    app.innerHTML =
      '<div class="card">' + head +
      "<p>" + (stale
        ? "Your unread set changed since the last summary. Generate a fresh one:"
        : "Get an LLM-generated overview of everything you've missed, grouped by theme — then read the details article by article.") + "</p>" +
      '<div class="rowbtns">' +
        '<button class="accent" data-act="summarize">✨ Generate summary</button>' +
        (articleCount() > 0 ? '<button data-act="goarticles">Skip &amp; read ▶</button>' : "") +
      "</div></div>";
  }

  function render() { clampIdx(); renderHeader(); renderBody(); }

  function setState(s) {
    if (s && s.status) { data = s; }
    render();
  }

  function load(force) {
    return api("/api/state" + (force ? "?force=1" : "")).then(setState);
  }

  function pollSummary() {
    var tries = 0;
    function step() {
      if (!generating) return;
      tries++;
      api("/api/state").then(function (s) {
        if (s && s.status) data = s;
        var ready = data.summary && data.summary.valid && data.summary.markdown;
        if (ready) { generating = false; render(); toast("Summary ready ✨"); return; }
        if (tries >= 30) { generating = false; render(); toast("Still working — check the Copilot chat."); return; }
        render();
        setTimeout(step, 3000);
      });
    }
    setTimeout(step, 3000);
  }

  function doDiscuss() {
    var a = currentArticle();
    var id = a ? a.id : null;
    if (!id) { toast("Open an article first."); return; }
    post("/api/discuss", { id: id }).then(function (r) {
      toast(r && r.ok ? "Sent to Copilot — check the chat panel." : "Couldn't reach Copilot.");
    });
  }
  function doSummarize() {
    generating = true; idx = 0; render();
    post("/api/summarize", {}).then(function (r) {
      if (!r || !r.ok) { generating = false; render(); toast("Couldn't reach Copilot."); return; }
      pollSummary();
    });
  }
  function doMarkRead() {
    post("/api/markread", {}).then(function (s) {
      var n = s && s.markedRead ? s.markedRead : 0;
      idx = 0;
      setState(s);
      toast(n > 0 ? ("Marked " + n + " as read.") : "Already up to date.");
    });
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el) return;
    var act = el.getAttribute("data-act");
    if (act === "prev") { if (idx > 0) { idx--; render(); } }
    else if (act === "next") { if (idx < articleCount()) { idx++; render(); } }
    else if (act === "summary") { idx = 0; render(); }
    else if (act === "openbyid") {
      var targetId = el.getAttribute("data-id") || "";
      try { targetId = decodeURIComponent(targetId); } catch (_) {}
      var targetIndex = data.articles.findIndex(function (article) { return article.id === targetId; });
      if (targetIndex >= 0) { idx = targetIndex + 1; render(); }
    }
    else if (act === "goarticles") { if (articleCount() > 0) { idx = 1; render(); } }
    else if (act === "discuss") { doDiscuss(); }
    else if (act === "summarize") { doSummarize(); }
    else if (act === "markread") { doMarkRead(); }
    else if (act === "refresh") { load(true).then(function () { toast("Feed refreshed."); }); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName || "")) return;
    if (e.key === "ArrowLeft" && idx > 0) { idx--; render(); }
    else if (e.key === "ArrowRight" && idx < articleCount()) { idx++; render(); }
  });

  load(false);
})();
</script>
</body>
</html>`;
}
