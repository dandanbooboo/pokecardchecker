// Fetches gamenv.net wpDiscuz threads and extracts the latest comments.
// The site (WordPress) sets cookies then 302-redirects to the same URL.
// Native fetch follows redirects but drops Set-Cookie, causing an infinite
// loop, so we follow redirects manually and carry the cookie jar forward.

const cheerio = require("cheerio");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// The three threads we monitor. `slug` is also the Firestore document id.
const THREADS = [
  { slug: "yodobashi", url: "https://gamenv.net/tc/yodobashi/", label: "ヨドバシカメラ" },
  { slug: "biccamera", url: "https://gamenv.net/tc/biccamera/", label: "ビックカメラ" },
  { slug: "pokesen", url: "https://gamenv.net/tc/pokesen/", label: "ポケモンセンター" },
];

// GET a URL, manually following redirects while accumulating cookies.
async function fetchWithCookies(startUrl, maxRedirects = 10) {
  const jar = new Map(); // name -> value
  let url = startUrl;

  for (let i = 0; i <= maxRedirects; i++) {
    const cookieHeader = [...jar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const res = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.9",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });

    // Collect any cookies the server set.
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect with no Location from ${url}`);
      url = new URL(loc, url).toString();
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }
  throw new Error(`Too many redirects for ${startUrl}`);
}

// Parse the wpDiscuz comment markup out of a thread page.
function parseThread(html) {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();

  // Total comment count, e.g. the "37.6K" shown in the thread head.
  let totalCommentsText = $(".wpd-thread-info .wpdtc, .wpd-thread-info [class*='wpdtc']")
    .first()
    .text()
    .trim();

  const comments = [];
  // Every comment (top-level and replies) has an inner element id="comment-N".
  $("[id^='comment-']").each((_, el) => {
    const node = $(el);
    const idAttr = node.attr("id") || "";
    const m = idAttr.match(/^comment-(\d+)$/);
    if (!m) return;
    const id = parseInt(m[1], 10);

    // The author/date/text live inside the wpd-comment wrapper.
    const wrap = node.closest(".wpd-comment");
    const author = wrap.find(".wpd-comment-author").first().text().trim();
    const date = wrap.find(".wpd-comment-date").first().attr("title") || "";
    const text = wrap
      .find(".wpd-comment-text")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const isReply = wrap.parents(".wpd-reply").length > 0;

    comments.push({ id, author, date, text, isReply });
  });

  // De-dup by id (closest() can match the same wrapper twice in odd markup).
  const byId = new Map();
  for (const c of comments) if (!byId.has(c.id)) byId.set(c.id, c);
  const all = [...byId.values()].sort((a, b) => b.id - a.id);

  const latestCommentId = all.length ? all[0].id : 0;

  return {
    title,
    totalCommentsText,
    latestCommentId,
    recent: all.slice(0, 15), // newest 15 for the dashboard feed
  };
}

async function fetchThread(thread) {
  const html = await fetchWithCookies(thread.url);
  const parsed = parseThread(html);
  return {
    slug: thread.slug,
    url: thread.url + "#help",
    label: thread.label,
    title: parsed.title,
    totalCommentsText: parsed.totalCommentsText,
    latestCommentId: parsed.latestCommentId,
    recent: parsed.recent,
    checkedAt: new Date().toISOString(),
    ok: true,
  };
}

async function fetchAll() {
  const results = [];
  for (const t of THREADS) {
    try {
      results.push(await fetchThread(t));
    } catch (err) {
      results.push({
        slug: t.slug,
        url: t.url + "#help",
        label: t.label,
        ok: false,
        error: String(err.message || err),
        checkedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

module.exports = { THREADS, fetchThread, fetchAll, parseThread, fetchWithCookies };

// Run directly: `node scripts/fetcher.js` prints JSON for all threads.
if (require.main === module) {
  fetchAll()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
