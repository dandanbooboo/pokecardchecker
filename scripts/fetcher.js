// Fetches gamenv.net threads via the WordPress REST comments API.
// This returns clean JSON (top-level comments AND replies) ordered newest
// first, with no cookie/redirect dance and no HTML scraping needed.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const API = "https://gamenv.net/tc/wp-json/wp/v2";
const PER_PAGE = 60; // how many recent comments to pull per thread (max 100)

// The three threads we monitor. `postId` is the WordPress post the comment
// thread belongs to (stable; resolvable via ?slug= if it ever changes).
const THREADS = [
  { slug: "yodobashi", postId: 78763, url: "https://gamenv.net/tc/yodobashi/", label: "ヨドバシカメラ" },
  { slug: "biccamera", postId: 78776, url: "https://gamenv.net/tc/biccamera/", label: "ビックカメラ" },
  { slug: "pokesen", postId: 78787, url: "https://gamenv.net/tc/pokesen/", label: "ポケモンセンター" },
];

const headers = { "User-Agent": UA, Accept: "application/json" };

// Resolve a post id from its slug as a fallback if the hard-coded id is wrong.
async function resolvePostId(slug) {
  const res = await fetch(`${API}/posts?slug=${encodeURIComponent(slug)}&_fields=id`, { headers });
  if (!res.ok) throw new Error(`slug lookup HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error(`no post for slug ${slug}`);
  return arr[0].id;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#039": "'", nbsp: " " };

// content.rendered is HTML; turn it into plain display text.
function htmlToText(html) {
  if (!html) return "";
  let hasImg = /<img\b/i.test(html);
  let t = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (hasImg) t = (t ? t + " " : "") + "🖼";
  return t;
}

// "2026-06-24T21:40:59" (site-local JST) -> "6月24日 21:40"
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m) return iso || "";
  return `${+m[2]}月${+m[3]}日 ${m[4]}:${m[5]}`;
}

function commentsUrl(postId) {
  return `${API}/comments?post=${postId}&per_page=${PER_PAGE}&order=desc&orderby=date&_fields=id,parent,author_name,date,content`;
}

async function fetchThread(thread) {
  let res = await fetch(commentsUrl(thread.postId), { headers });

  // Self-heal if the hard-coded post id stopped matching.
  if (res.ok) {
    const peek = await res.clone().json();
    if (!Array.isArray(peek) || peek.length === 0) {
      const pid = await resolvePostId(thread.slug);
      res = await fetch(commentsUrl(pid), { headers });
    }
  }
  if (!res.ok) throw new Error(`comments HTTP ${res.status}`);

  const total = res.headers.get("x-wp-total");
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("unexpected API response");

  const comments = raw
    .map((c) => ({
      id: c.id,
      author: (c.author_name || "").trim() || "匿名",
      date: formatDate(c.date),
      text: htmlToText(c.content && c.content.rendered),
      isReply: (c.parent || 0) > 0,
    }))
    .sort((a, b) => b.id - a.id);

  return {
    slug: thread.slug,
    url: thread.url + "#help",
    label: thread.label,
    totalCommentsText: total ? Number(total).toLocaleString("en-US") : "",
    latestCommentId: comments.length ? comments[0].id : 0,
    recent: comments,
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

module.exports = { THREADS, fetchThread, fetchAll };

if (require.main === module) {
  fetchAll()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
