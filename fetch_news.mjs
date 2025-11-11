// Genera news.json leyendo RSS usando la API pública rss2json.
// Es simple y suficiente para empezar.

import fs from "fs/promises";

const FEEDS_FILE = "feeds.json";
const OUT_FILE   = "news.json";
const MAX_ITEMS  = 200; // límite total (recientes primero)

function clean(txt="") {
  return txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function readFeedsList(){
  const raw = await fs.readFile(FEEDS_FILE, "utf8");
  const cfg = JSON.parse(raw);
  return { feeds: cfg.feeds || [], tags: cfg.tags || [] };
}

async function fetchOneFeed(feed){
  const api = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feed.url);
  const res = await fetch(api);
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if(!data || !data.items) return [];
  return data.items.map(it => ({
    id: (it.guid || it.link || it.title).slice(-20),
    title: clean(it.title || ""),
    link: it.link || it.guid || "",
    date: new Date(it.pubDate || it.pubdate || it.published || Date.now()).toISOString(),
    summary: clean(it.description || it.content || ""),
    image: it.enclosure && it.enclosure.link ? it.enclosure.link : "",
    source: feed.name,
    lang: feed.language || "en",
    tags: [] // (opcional) podrías inferir tags aquí
  })).filter(x => x.title && x.link);
}

function dedup(items){
  const seen = new Set();
  const out = [];
  for(const it of items){
    const k = (it.link || it.title).toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}

(async function main(){
  const { feeds } = await readFeedsList();
  const all = [];
  for(const f of feeds){
    try{
      const items = await fetchOneFeed(f);
      all.push(...items);
      await new Promise(r => setTimeout(r, 300)); // respiro
    }catch(e){
      console.error(`[ERROR] ${f.name}: ${e.message}`);
    }
  }
  all.sort((a,b) => new Date(b.date) - new Date(a.date));
  const sliced = dedup(all).slice(0, MAX_ITEMS);
  const out = { generated_at: new Date().toISOString(), count: sliced.length, items: sliced };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`Listo → ${OUT_FILE} con ${sliced.length} noticias`);
})();
