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

// Photos uploaded via wpDiscuz's media addon are NOT in the REST comment content.
// But every such upload IS a WordPress media item, and its filename carries the
// upload Unix timestamp (e.g. "DSC_0091-1782276814.7006-scaled.jpg"). A wmu photo
// is uploaded at the same instant its comment is posted, so we match each media
// item to the comment whose timestamp it's within a few seconds of. This catches
// every photo (newest, oldest, replies) with no scraping/pagination/per-comment
// calls. Validated against the rendered page: matches are exact (~1s apart).

const ts = (s) => Date.parse(s + "+09:00"); // site dates are JST-local, naive

// Only wmu comment attachments have a "-<10+ digit unix ts>.<frac>" in the name;
// plain-named media are article/blog images, not user photos.
const WMU_NAME = /-\d{10,}\.\d+/;

async function fetchMedia(oldestMs) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    let data;
    try {
      ({ data } = await getJson(
        `${API}/media?per_page=100&page=${page}&orderby=date&order=desc&_fields=id,date,source_url`
      ));
    } catch (_) { break; }
    if (!Array.isArray(data) || !data.length) break;
    for (const m of data) {
      if (m.source_url && WMU_NAME.test(m.source_url)) out.push({ ms: ts(m.date), url: m.source_url });
    }
    const last = data[data.length - 1];
    if (last && ts(last.date) < oldestMs) break; // covered the window's time range
  }
  return out;
}

// Assign each photo to the comment it's closest to in time (≤8s), so each image
// lands on exactly one comment.
function matchMedia(media, comments) {
  const map = {};
  for (const m of media) {
    let best = null, bd = 8001;
    for (const c of comments) {
      const d = Math.abs(c.ms - m.ms);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) (map[best.id] = map[best.id] || []).push(m.url);
  }
  return map;
}

async function fetchThread(thread) {
  const { res } = await getJson(commentsUrl(thread.postId));
  const total = res.headers.get("x-wp-total");
  const raw = await fetchRaw(thread);
  return { thread, total, raw };
}

function assembleThread({ thread, total, raw }, imgByComment) {
  const groups = buildGroups(raw);
  for (const g of groups) {
    for (const c of g.comments) {
      const extra = imgByComment[c.id];
      if (extra) c.images = [...new Set([...c.images, ...extra])];
    }
  }
  const allIds = groups.flatMap((g) => g.comments.map((c) => c.id));
  return {
    slug: thread.slug,
    url: thread.url + "#help",
    label: thread.label,
    totalCommentsText: total ? Number(total).toLocaleString("en-US") : "",
    latestCommentId: allIds.length ? Math.max(...allIds) : 0,
    groups,
    checkedAt: new Date().toISOString(),
    ok: true,
  };
}

async function fetchAll() {
  // 1) Fetch each thread's comments (keep the raw rows for global photo matching).
  const fetched = [];
  for (const t of THREADS) {
    try {
      fetched.push({ ok: true, data: await fetchThread(t) });
    } catch (err) {
      fetched.push({ ok: false, thread: t, error: String(err.message || err) });
    }
  }

  // 2) Match wmu photos to comments by upload timestamp (global, across threads).
  const allComments = [];
  for (const f of fetched) if (f.ok) for (const c of f.data.raw) allComments.push({ id: c.id, ms: ts(c.date) });
  let imgByComment = {};
  if (allComments.length) {
    const oldest = Math.min(...allComments.map((c) => c.ms));
    try {
      imgByComment = matchMedia(await fetchMedia(oldest), allComments);
    } catch (_) { /* photos are a bonus; comment data still stands */ }
  }

  // 3) Assemble each thread with its photos merged in.
  return fetched.map((f) =>
    f.ok
      ? assembleThread(f.data, imgByComment)
      : {
          slug: f.thread.slug,
          url: f.thread.url + "#help",
          label: f.thread.label,
          ok: false,
          error: f.error,
          checkedAt: new Date().toISOString(),
        }
  );
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
