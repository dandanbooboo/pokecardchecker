// Fetches gamenv.net threads via the WordPress REST comments API and builds a
// threaded structure (replies nested under their parent, like the real site).
// Clean JSON, no cookie/redirect dance, no HTML scraping.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const API = "https://gamenv.net/tc/wp-json/wp/v2";
const PER_PAGE = 60; // recent comments to pull per thread (max 100)
const FIELDS = "id,parent,author_name,date,content";

const THREADS = [
  { slug: "yodobashi", postId: 78763, url: "https://gamenv.net/tc/yodobashi/", label: "ヨドバシカメラ" },
  { slug: "biccamera", postId: 78776, url: "https://gamenv.net/tc/biccamera/", label: "ビックカメラ" },
  { slug: "pokesen", postId: 78787, url: "https://gamenv.net/tc/pokesen/", label: "ポケモンセンター" },
];

const headers = { "User-Agent": UA, Accept: "application/json" };

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { data: await res.json(), res };
}

async function resolvePostId(slug) {
  const { data } = await getJson(`${API}/posts?slug=${encodeURIComponent(slug)}&_fields=id`);
  if (!Array.isArray(data) || !data.length) throw new Error(`no post for slug ${slug}`);
  return data[0].id;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#039": "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

// Pull user-posted photos. On this site images are posted as <a href> links to
// gamenv uploads (and occasionally direct <img>). Auto-generated link-preview
// thumbnails (s.wordpress.com mshots) are intentionally ignored.
function extractImages(html) {
  if (!html) return [];
  const out = new Set();
  // A real user photo: hosted on gamenv uploads, an image file, and NOT a
  // resized thumbnail (-160x90 etc, which are auto link-preview/banner cards).
  const isPhoto = (u) => {
    try {
      const url = new URL(u);
      return (
        /(^|\.)gamenv\.net$/i.test(url.hostname) &&
        /\/wp-content\/uploads\//i.test(url.pathname) &&
        /\.(?:jpe?g|png|gif|webp)$/i.test(url.pathname) &&
        !/-\d+x\d+\.[a-z]+$/i.test(url.pathname)
      );
    } catch { return false; }
  };
  // Users post photos as a direct link to the image file, and Cocoon also
  // auto-inserts an <img>. Collect both, then keep only genuine photo URLs.
  const reLink = /<a\b[^>]*\bhref="([^"]+)"/gi;
  const reImg = /<img\b[^>]*\bsrc="([^"]+)"/gi;
  let m;
  while ((m = reLink.exec(html))) { const u = decodeEntities(m[1]); if (isPhoto(u)) out.add(u); }
  while ((m = reImg.exec(html))) { const u = decodeEntities(m[1]); if (isPhoto(u)) out.add(u); }
  return [...out];
}

// content.rendered HTML -> plain display text (image links/tags removed, since
// images are surfaced separately).
function htmlToText(html) {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<a\b[^>]*\bhref="[^"]+\.(?:jpe?g|png|gif|webp)"[^>]*>.*?<\/a>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "2026-06-24T21:40:59" (site-local JST) -> "6月24日 21:40"
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  return m ? `${+m[2]}月${+m[3]}日 ${m[4]}:${m[5]}` : iso || "";
}

function commentsUrl(postId) {
  return `${API}/comments?post=${postId}&per_page=${PER_PAGE}&order=desc&orderby=date&_fields=${FIELDS}`;
}

// Fetch recent comments plus any missing ancestor comments, so every reply can
// be nested under its real parent even if the parent is older than the window.
async function fetchRaw(thread) {
  let { data } = await getJson(commentsUrl(thread.postId));
  if (Array.isArray(data) && data.length === 0) {
    const pid = await resolvePostId(thread.slug);
    ({ data } = await getJson(commentsUrl(pid)));
  }
  if (!Array.isArray(data)) throw new Error("unexpected API response");

  // Walk up the full ancestor chain (reply threads here can be 9+ deep). Each
  // iteration climbs one level; keep going until no parent is missing, so every
  // reply roots at its true top-level comment instead of being shown as its own
  // thread. Capped to avoid an unbounded loop.
  const have = new Set(data.map((c) => c.id));
  for (let iter = 0; iter < 15; iter++) {
    const missing = [...new Set(data.filter((c) => c.parent && !have.has(c.parent)).map((c) => c.parent))].slice(0, 100);
    if (!missing.length) break;
    const { data: extra } = await getJson(
      `${API}/comments?include=${missing.join(",")}&per_page=100&_fields=${FIELDS}`
    );
    if (!Array.isArray(extra) || !extra.length) break;
    let added = false;
    for (const c of extra) if (!have.has(c.id)) { data.push(c); have.add(c.id); added = true; }
    if (!added) break;
  }
  return data;
}

// Group flat comments into threads: each group is a root comment followed by its
// descendants (depth-tagged), ordered chronologically. Groups are sorted by most
// recent activity so threads with new replies surface first.
function buildGroups(raw) {
  const map = new Map();
  for (const c of raw) {
    map.set(c.id, {
      id: c.id,
      parentId: c.parent || 0,
      author: (c.author_name || "").trim() || "匿名",
      date: formatDate(c.date),
      text: htmlToText(c.content && c.content.rendered),
      images: extractImages(c.content && c.content.rendered),
    });
  }
  const rootOf = (node) => {
    let cur = node, g = 0;
    while (cur.parentId && map.has(cur.parentId) && g++ < 30) cur = map.get(cur.parentId);
    return cur;
  };
  const depthOf = (node) => {
    let d = 0, cur = node, g = 0;
    while (cur.parentId && map.has(cur.parentId) && g++ < 30) { cur = map.get(cur.parentId); d++; }
    return d;
  };

  const groups = new Map();
  for (const node of map.values()) {
    const root = rootOf(node);
    if (!groups.has(root.id)) groups.set(root.id, []);
    groups.get(root.id).push(node);
  }

  const result = [];
  for (const [rootId, nodes] of groups) {
    // Match wpDiscuz: the root, then all replies FLATTENED to one level (not
    // cascading), each tagged with the author it replied to ("返信 <name>").
    const comments = nodes
      .map((n) => ({
        id: n.id,
        author: n.author,
        date: n.date,
        text: n.text,
        images: n.images,
        depth: n.id === rootId ? 0 : 1,
        replyTo: n.id !== rootId && map.has(n.parentId) ? map.get(n.parentId).author : null,
      }))
      .sort((a, b) => a.id - b.id); // parent ids are always < child ids (chronological)
    result.push({
      rootId,
      latestId: Math.max(...comments.map((c) => c.id)),
      comments,
    });
  }
  // Order threads by the BASE (root) comment time — newest base first — like the
  // site, rather than by latest reply activity.
  result.sort((a, b) => b.rootId - a.rootId);
  return result;
}

// Photos uploaded via wpDiscuz's media addon are NOT in the REST content; they
// only appear in the rendered HTML page. Fetch it (the WordPress page sets a
// cookie then 302-redirects to itself, so follow redirects manually carrying the
// cookie jar) and map each comment id to its attached full-size image URLs.
async function fetchHtml(url) {
  const jar = new Map();
  let cur = url;
  for (let i = 0; i < 8; i++) {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(cur, {
      redirect: "manual",
      headers: { ...headers, Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    if (res.status >= 300 && res.status < 400) {
      cur = new URL(res.headers.get("location"), cur).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTML HTTP ${res.status}`);
    return res.text();
  }
  throw new Error("too many redirects");
}

function parseAttachments(html) {
  const map = {};
  const re = /data-comment-id='(\d+)'/g;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ id: m[1], pos: m.index });
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].pos : Math.min(html.length, marks[k].pos + 8000);
    const seg = html.slice(marks[k].pos, end);
    const reA = /<a\s+href='([^']+)'[^>]*class='[^']*wmu-attached-image-link/g;
    let a;
    const urls = [];
    while ((a = reA.exec(seg))) urls.push(a[1].replace(/&#0?38;/g, "&"));
    if (urls.length) map[marks[k].id] = (map[marks[k].id] || []).concat(urls);
  }
  return map;
}

async function fetchThread(thread) {
  const raw = await fetchRaw(thread);
  const groups = buildGroups(raw);

  // Merge in wpDiscuz attachment photos (best-effort; ignore HTML failures).
  try {
    const attach = parseAttachments(await fetchHtml(thread.url));
    for (const g of groups) {
      for (const c of g.comments) {
        const extra = attach[c.id];
        if (extra) c.images = [...new Set([...c.images, ...extra])];
      }
    }
  } catch (_) { /* attachments are a bonus; REST data still stands */ }

  const allIds = groups.flatMap((g) => g.comments.map((c) => c.id));
  return {
    slug: thread.slug,
    url: thread.url + "#help",
    label: thread.label,
    totalCommentsText: "", // filled below from the X-WP-Total header
    latestCommentId: allIds.length ? Math.max(...allIds) : 0,
    groups,
    checkedAt: new Date().toISOString(),
    ok: true,
  };
}

async function fetchAll() {
  const results = [];
  for (const t of THREADS) {
    try {
      // grab the total-count header alongside the main fetch
      const { res } = await getJson(commentsUrl(t.postId));
      const total = res.headers.get("x-wp-total");
      const out = await fetchThread(t);
      out.totalCommentsText = total ? Number(total).toLocaleString("en-US") : "";
      results.push(out);
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

module.exports = { THREADS, fetchThread, fetchAll, buildGroups };

if (require.main === module) {
  fetchAll()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
