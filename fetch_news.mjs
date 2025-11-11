// fetch_news.mjs
// Genera news.json a partir de feeds RSS/Atom definidos en feeds.json (formato extendido).
// Robusto: cada feed falla de forma aislada (no interrumpe el build).

import fs from "fs/promises";
import crypto from "node:crypto";

// ========= CONFIG =========
const FEEDS_FILE = "feeds.json";
const OUT_FILE   = "news.json";
const MAX_PER_FEED = 60;     // cuántos artículos máximo por fuente
const MAX_GLOBAL   = 600;    // límite total global
const FETCH_TIMEOUT_MS = 20000;
const UA = "ccs-news-bot/1.0 (+https://ccsolutions.tech)";

// ========= HELPERS =========
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function timeoutFetch(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function hashId(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);
}

// Extrae texto simple entre <tag>...</tag>
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? strip(m[1]) : "";
}
function strip(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Devuelve array de bloques <item>…</item> (RSS) o <entry>…</entry> (Atom)
function splitEntries(xml) {
  let items = xml.match(/<item[\s\S]*?<\/item>/gi);
  if (items && items.length) return items;
  items = xml.match(/<entry[\s\S]*?<\/entry>/gi);
  return items || [];
}

// Intenta sacar enlace en Atom (<link href="…">)
function getAtomLink(block) {
  const m = block.match(/<link[^>]*?href=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : "";
}

// Intenta extraer imagen de enclosure/media:content/og:image dentro del bloque
function extractImage(block) {
  // <media:content url="...">
  let m = block.match(/<media:content[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  // <enclosure url="...">
  m = block.match(/<enclosure[^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  // <img src="..."> en contenido
  m = block.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (m) return m[1];
  return "";
}

function parseDateSafe(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Etiquetado básico por palabra clave (en castellano/inglés, puedes ampliar)
function inferTags(text, configuredTags) {
  const t = (text || "").toLowerCase();
  const found = [];
  for (const tag of configuredTags || []) {
    const needle = tag.toLowerCase();
    if (t.includes(needle)) found.push(tag);
  }
  // compacta
  return Array.from(new Set(found)).slice(0, 8);
}

// ========= PARSE RSS/ATOM SIN DEPENDENCIAS =========
function parseFeedXML(xml, feedMeta, configuredTags) {
  const entries = splitEntries(xml);
  const out = [];

  for (const block of entries.slice(0, MAX_PER_FEED)) {
    // RSS
    let title = getTag(block, "title");
    let link  = getTag(block, "link");
    let date  = getTag(block, "pubDate") || getTag(block, "dc:date") || getTag(block, "date");
    let sum   = getTag(block, "description") || getTag(block, "summary") || getTag(block, "content");
    let img   = extractImage(block);

    // ATOM: si link vacío, busca <link href="…">
    if (!link) link = getAtomLink(block);
    // ATOM: fecha
    if (!date) date = getTag(block, "updated") || getTag(block, "published");

    const dt = parseDateSafe(date) || new Date(0);
    const id = hashId(link || (title + date));

    // Construye objeto
    const item = {
      id,
      title,
      link,
      date: new Date(dt).toISOString(),
      summary: sum,
      image: img,
      source: feedMeta.name,
      lang: feedMeta.language || "en"
    };

    // Tags: a partir de texto title+summary
    item.tags = inferTags(`${title} ${sum}`, configuredTags);

    // Si faltan título/enlace, descarta
    if (!item.title || !item.link) continue;
    out.push(item);
  }

  return out;
}

// ========= MAIN =========
(async function main(){
  let feeds, tags;
  try {
    const raw = await fs.readFile(FEEDS_FILE, "utf8");
    const cfg = JSON.parse(raw);
    feeds = cfg.feeds || [];
    tags  = cfg.tags  || [];
  } catch (e) {
    console.error(`[FATAL] No se pudo leer/parsear ${FEEDS_FILE}: ${e.message}`);
    process.exit(1);
  }

  const all = [];

  for (const f of feeds) {
    const meta = typeof f === "string" ? { name: f, url: f, language: "en" } : f;
    if (!meta?.url) continue;

    try {
      const res = await timeoutFetch(meta.url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();

      // Sólo procesamos si parece XML de feed
      if (!/(<rss\b|<feed\b)/i.test(txt)) {
        console.warn(`[SKIP] No es RSS/Atom: ${meta.name} (${meta.url})`);
        continue;
      }

      const items = parseFeedXML(txt, meta, tags);
      all.push(...items);
      console.log(`[OK] ${meta.name}: ${items.length} artículos`);
    } catch (e) {
      console.error(`[ERROR] ${meta.name} (${meta.url}) -> ${e.message}`);
    }

    // Respiro mínimo para no pegarle tan rápido a todos
    await sleep(300);
  }

  // Ordena por fecha desc y recorta
  all.sort((a,b) => new Date(b.date) - new Date(a.date));
  const sliced = all.slice(0, MAX_GLOBAL);

  const out = {
    generated_at: new Date().toISOString(),
    count: sliced.length,
    items: sliced
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nListo: ${sliced.length} artículos → ${OUT_FILE}`);
})().catch(err => {
  console.error("[UNCAUGHT]", err);
  process.exit(1);
});
