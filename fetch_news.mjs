// Genera news.json leyendo RSS mediante la API pública de rss2json.
// Sin dependencias externas. Node 20 trae fetch nativo.

import fs from "fs/promises";

const FEEDS_FILE   = "feeds.json";
const OUT_FILE     = "news.json";
const MAX_PER_FEED = 80;    // seguridad por fuente
const MAX_GLOBAL   = 1200;  // tope global
const PAUSE_MS     = 300;   // respiro entre feeds

// Si en el futuro quieres activar traducción real, pon un secret en GitHub
// (por ejemplo DEEPL_API_KEY) y usa TRANSLATE_ENABLED dentro de translateToEn.
const TRANSLATE_ENABLED = !!process.env.DEEPL_API_KEY;

function clean(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function readConfig() {
  const raw = await fs.readFile(FEEDS_FILE, "utf8");
  const cfg = JSON.parse(raw);
  return { feeds: cfg.feeds || [], tags: cfg.tags || [] };
}

// Extrae la primera imagen de un fragmento HTML.
function extractImageFromHtml(html = "") {
  const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : "";
}

// Selecciona la mejor URL de imagen posible para un ítem RSS.
function bestImage(it) {
  // 1) rss2json: enclosure.link (muy común)
  if (it.enclosure && it.enclosure.link) return it.enclosure.link;

  // 2) rss2json: thumbnail (p.ej. Google News)
  if (it.thumbnail) return it.thumbnail;

  // 3) Buscar <img src="..."> dentro del HTML de description/content
  const html = it.description || it.content || "";
  const fromHtml = extractImageFromHtml(html);
  if (fromHtml) return fromHtml;

  // 4) Nada
  return "";
}

/**
 * Stub de traducción a inglés.
 * De momento solo devuelve el texto original, para no romper nada.
 * Cuando tengas API (DeepL, Google, etc.), mete aquí la llamada.
 */
async function translateToEn(text, sourceLang) {
  if (!text) return text;

  if (!TRANSLATE_ENABLED) {
    // Traducción desactivada → devolvemos tal cual
    return text;
  }

  // === EJEMPLO (comentado) usando DeepL ===
  // const res = await fetch("https://api-free.deepl.com/v2/translate", {
  //   method: "POST",
  //   headers: {
  //     "Authorization": "DeepL-Auth-Key " + process.env.DEEPL_API_KEY,
  //     "Content-Type": "application/x-www-form-urlencoded"
  //   },
  //   body: new URLSearchParams({
  //     text,
  //     target_lang: "EN"
  //   })
  // });
  // const data = await res.json();
  // return (data.translations && data.translations[0].text) || text;

  return text;
}

async function fetchOne(feed) {
  const api = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feed.url);
  const res = await fetch(api);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.items) return [];

  const lang = feed.language || "en";
  const out = [];

  // Usamos for...of para poder hacer await a la traducción
  for (const it of data.items.slice(0, MAX_PER_FEED)) {
    const link = it.link || it.guid || "";
    const titleOriginal = clean(it.title || "");
    const summaryOriginal = clean(it.description || it.content || "");
    const date = new Date(it.pubDate || it.pubdate || it.published || Date.now()).toISOString();
    const image = bestImage(it);

    if (!titleOriginal || !link) continue;

    // Traducir solo si el feed no es inglés
    const titleEn = (lang !== "en")
      ? await translateToEn(titleOriginal, lang)
      : titleOriginal;

    const summaryEn = (lang !== "en")
      ? await translateToEn(summaryOriginal, lang)
      : summaryOriginal;

    out.push({
      id: (link || titleOriginal).slice(-40),
      title: titleEn,
      original_title: titleOriginal,
      link,
      date,
      summary: summaryEn,
      original_summary: summaryOriginal,
      image,
      source: feed.name,
      lang,
      tags: [] // aquí podrías inferir tags a partir de title+summary
    });
  }

  return out;
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
