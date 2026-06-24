// Runs the fetcher and writes public/data.json (consumed by the dashboard).
const fs = require("fs");
const path = require("path");
const { fetchAll } = require("./fetcher");

(async () => {
  const threads = await fetchAll();
  const out = { generatedAt: new Date().toISOString(), threads };
  const dest = path.join(__dirname, "..", "public", "data.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  const ok = threads.filter((t) => t.ok).length;
  console.log(`Wrote ${dest} — ${ok}/${threads.length} threads OK`);
  for (const t of threads) {
    console.log(`  ${t.slug}: ${t.ok ? "latestId " + t.latestCommentId : "FAILED " + t.error}`);
  }
  // Fail the CI job only if every thread failed (transient single failures are tolerated).
  if (ok === 0) process.exit(1);
})();
