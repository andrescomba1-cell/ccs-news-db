// Genera news.json leyendo RSS mediante la API pública de rss2json.
// Sin dependencias externas. Node 20 trae fetch nativo.

import fs from "fs/promises";

const FEEDS_FILE   = "feeds.json";
const OUT_FILE     = "news.json";
const MAX_PER_FEED = 80;    // seguridad por fuente
const MAX_GLOBAL   = 1200;  // tope global
const PAUSE_MS     = 300;   // respiro entre feeds

function clean(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function readConfig() {
  const raw = await fs.readFile(FEEDS_FILE, "utf8");
  const cfg = JSON.parse(raw);
  return { feeds: cfg.feeds || [], tags: cfg.tags || [] };
}

function bestImage(it) {
  // rss2json suele entregar:
  // - it.enclosure?.link
  // - it.thumbnail
  // - a veces nada; devolveremos vacío y el embed pone placeholder
  if (it.enclosure && it.enclosure.link) return it.enclosure.link;
  if (it.thumbnail) return it.thumbnail;   // útil para Google News / RSS.app
  return "";
}

async function fetchOne(feed) {
  const api = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feed.url);
  const res = await fetch(api);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.items) return [];

  return data.items.slice(0, MAX_PER_FEED).map(it => {
    const link = it.link || it.guid || "";
    const title = clean(it.title || "");
    const summary = clean(it.description || it.content || "");
    const date = new Date(it.pubDate || it.pubdate || it.published || Date.now()).toISOString();
    const image = bestImage(it);

    return {
      id: (link || title).slice(-40),
      title,
      link,
      date,
      summary,
      image,
      source: feed.name,
      lang: feed.language || "en",
      tags: [] // si quisieras, aquí puedes inferir tags a partir de title+summary
    };
  }).filter(x => x.title && x.link);
}

function dedup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it.link || it.title).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async function main() {
  const { feeds } = await readConfig();
  const all = [];

  for (const f of feeds) {
    try {
      const items = await fetchOne(f);
      all.push(...items);
      await sleep(PAUSE_MS);
    } catch (e) {
      console.error(`[ERROR] ${f.name}: ${e.message}`);
    }
  }

  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  const sliced = dedup(all).slice(0, MAX_GLOBAL);

  const out = {
    generated_at: new Date().toISOString(),
    count: sliced.length,
    items: sliced
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`Listo → ${OUT_FILE} con ${sliced.length} noticias`);
})().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});
