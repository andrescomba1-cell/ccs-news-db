// Automated RSS aggregator for CCSolutions
import fs from "node:fs/promises";
import path from "node:path";
import Parser from "rss-parser";
import crypto from "node:crypto";

const parser = new Parser({ timeout: 15000 });
const conf = JSON.parse(await fs.readFile("feeds.json", "utf8"));
const OUT_DIR = "public";
await fs.mkdir(OUT_DIR, { recursive: true });

function hash(s){ return crypto.createHash("sha1").update(s).digest("hex"); }
function toISO(d){ try { return new Date(d).toISOString(); } catch { return new Date().toISOString(); } }
function host(u){ try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } }

function tagger(title, src, tags){
  const t = (title + " " + src).toLowerCase();
  return tags.filter(x => t.includes(x.toLowerCase()));
}

async function readFeed(url){
  try {
    const feed = await parser.parseURL(url);
    const src = feed.title || host(url);
    return (feed.items || []).map(i => {
      const link = i.link || i.guid || "";
      return {
        id: hash(link || i.title || ""),
        title: (i.title || "").trim(),
        link,
        date: toISO(i.isoDate || i.pubDate || i.updated || Date.now()),
        source: src,
        summary: (i.contentSnippet || i.content || "").replace(/\s+/g," ").trim().slice(0,300),
        image: (i.enclosure?.url || i.enclosure?.link || i.thumbnail || ""),
      };
    });
  } catch (e) {
    console.error("Feed error:", url);
    return [];
  }
}

function dedup(items){
  const seen = new Set();
  return items.filter(it => {
    const key = (it.link || it.title).toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async function main(){
  const prevPath = path.join(OUT_DIR, "news.json");
  let prev = [];
  try { prev = JSON.parse(await fs.readFile(prevPath, "utf8")).items || []; } catch {}
  
  const batches = await Promise.all(conf.feeds.map(readFeed));
  let all = [...prev, ...batches.flat()];
  
  const byId = new Map();
  for(const it of all){ byId.set(it.id, it); }
  all = Array.from(byId.values());

  all = all.map(it => ({
    ...it,
    tags: tagger(it.title, it.source, conf.tags)
  }));

  all.sort((a,b)=> new Date(b.date) - new Date(a.date));
  const db = {
    generated_at: new Date().toISOString(),
    count: all.length,
    items: all
  };

  await fs.writeFile(prevPath, JSON.stringify(db,null,2),"utf8");
  console.log("✅ Saved", db.count, "articles");
})();

