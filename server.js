"use strict";

const express = require("express");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

/* ============================================================
   1. SOURCE REGISTRY
   If a source ever shows as "failed" in the UI, check its feed
   URL here first — feeds occasionally move.
   ============================================================ */
const SOURCES = [
  { id: "quanta",       name: "Quanta Magazine",           category: "Interdisciplinary", color: "#7c8cff", type: "rss",  feed: "https://api.quantamagazine.org/feed/" },
  { id: "aeon",         name: "Aeon",                      category: "Interdisciplinary", color: "#c08cff", type: "rss",  feed: "https://aeon.co/feed.rss" },
  { id: "sciencenews",  name: "Science News",              category: "Interdisciplinary", color: "#4fb9ff", type: "rss",  feed: "https://www.sciencenews.org/feed" },
  { id: "conversation", name: "The Conversation",        category: "Interdisciplinary", color: "#ff9d6e", type: "rss",  feed: "https://theconversation.com/us/topics/science-15/articles.atom" }, // May be blocked by Cloudflare
  { id: "eos",          name: "Eos (AGU)",                 category: "Earth Sciences",    color: "#3ddc97", type: "rss",  feed: "https://eos.org/feed" },
  { id: "nasajpl",      name: "NASA News (incl. JPL)",     category: "Astronomy",         color: "#5b8cff", type: "rss",  feed: "https://www.nasa.gov/rss/dyn/breaking_news.rss" },
  { id: "spacecom",     name: "Space.com",                 category: "Astronomy",         color: "#38bdf8", type: "rss",  feed: "https://www.space.com/feeds/all" },
  { id: "physicsworld", name: "Physics World",             category: "Physics",           color: "#ff6b9d", type: "rss",  feed: "https://physicsworld.com/feed/" },
  { id: "bbcsciencefocus", name: "BBC Science Focus",      category: "Interdisciplinary", color: "#9b6bff", type: "rss",  feed: "https://feeds.purplemanager.com/193c804a-a673-47bd-b09b-11baf4822a17/complete-rss-feed-for-science-focus" }, // Fixed!
  { id: "thescientist", name: "The Scientist",             category: "Biology",           color: "#2dd4a7", type: "rss",  feed: "https://www.the-scientist.com/atom/latest" }, // May be blocked by Cloudflare
  { id: "bpsdigest",    name: "Ars Technica",              category: "Tech",              color: "#ffb057", type: "rss",  feed: "https://feeds.arstechnica.com/arstechnica/index" },
  { id: "apamonitor",   name: "APA News & Monitor",        category: "Mind & Brain",      color: "#60a5fa", type: "rss",  feed: "https://www.apa.org/monitor/monitor-rss.xml" },
  { id: "neuronews",    name: "Neuroscience News",         category: "Mind & Brain",      color: "#f472b6", type: "rss",  feed: "https://neurosciencenews.com/feed/" },
  { id: "dailynous",    name: "Daily Nous",                category: "Philosophy",        color: "#facc15", type: "rss",  feed: "https://dailynous.com/feed/" },
  { id: "perspectives", name: "Smithsonian",               category: "Interdisciplinary", color: "#d4a373", type: "rss",  feed: "https://www.smithsonianmag.com/rss/latest_articles/" }, // Replaced AHA
  { id: "hyperallergic",name: "Hyperallergic",             category: "Art",               color: "#ff5f8f", type: "rss",  feed: "https://hyperallergic.com/feed/" },
  { id: "artnet",       name: "Artnet News",               category: "Art",               color: "#34d399", type: "rss",  feed: "https://news.artnet.com/feed" }
];



/* ============================================================
   2. SETTINGS
   ============================================================ */
const CACHE_TTL_MS = 20 * 60 * 1000;   // 20 minutes
const FETCH_TIMEOUT_MS = 12000;        // 12 seconds per source
const MAX_DAYS = 90;

const app = express();
const cache = new Map(); // sourceId -> { ts, items }

/* ============================================================
   3. HELPERS
   ============================================================ */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,   // dc:date -> date, media:content -> content, ...
  trimValues: true
});

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cleanText(html, maxLen = 220) {
  let t = decodeEntities(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
  return t;
}

const val = (x) => (x && typeof x === "object" ? (x["#text"] ?? "") : x ?? "");

// Realistic browser headers to bypass basic Cloudflare/Akamai bot protection
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1"
};

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: BROWSER_HEADERS // <--- Using the new stealth headers here
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}


/* ============================================================
   4. PARSING
   ============================================================ */
function linkOf(item) {
  let l = item.link;
  if (Array.isArray(l)) {
    l = l.find((x) => x && x["@_rel"] === "alternate") || l.find((x) => x && x["@_href"]) || l[0];
  }
  if (l && typeof l === "object") return l["@_href"] || "";
  return typeof l === "string" ? l.trim() : "";
}

function dateOf(item) {
  const raw = item.pubDate || item.published || item.updated || item.date || item.created || null;
  if (!raw) return null;
  const d = new Date(val(raw));
  return isNaN(d) ? null : d;
}

function summaryOf(item) {
  const s = val(item.description) || val(item.encoded) || val(item.summary) || val(item.content) || "";
  return cleanText(s);
}

function imageOf(item) {
  const enc = item.enclosure && item.enclosure["@_url"];
  const mc = item.media && item.media["@_url"];          // media:content
  const th = item.thumbnail && item.thumbnail["@_url"];  // media:thumbnail
  return enc || mc || th || null;
}

function itemsFromXml(xmlText) {
  const doc = parser.parse(xmlText);
  if (doc.rss && doc.rss.channel && doc.rss.channel.item) return asArray(doc.rss.channel.item);
  if (doc.feed && doc.feed.entry) return asArray(doc.feed.entry);
  if (doc.RDF && doc.RDF.item) return asArray(doc.RDF.item); // RDF/RSS 1.0
  return [];
}

/* Best-effort scraper for sources without a feed (APA Monitor).
   Items get today's date since the listing page has no per-item dates. */

function itemsFromRss(xmlText) {
  return itemsFromXml(xmlText).map((it) => ({
    title: cleanText(val(it.title), 180),
    link: linkOf(it),
    summary: summaryOf(it),
    date: dateOf(it),
    image: imageOf(it)
  })).filter((it) => it.title && it.link);
}

/* ============================================================
   5. FETCH WITH CACHE
   ============================================================ */
async function getSource(source) {
  const hit = cache.get(source.id);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.items;

  const text = await fetchText(source.feed);
  const items = source.type === "html" ? await scrapeHtmlListing(source) : itemsFromRss(text);
  if (!items.length) throw new Error("Feed parsed but contained no items");

  cache.set(source.id, { ts: Date.now(), items });
  return items;
}

/* ============================================================
   6. API
   ============================================================ */
app.get("/api/articles", async (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, MAX_DAYS));
  const since = Date.now() - days * 86400000;

  const results = await Promise.allSettled(SOURCES.map((s) => getSource(s)));

  const articles = [];
  const failed = [];
  results.forEach((r, i) => {
    const s = SOURCES[i];
    if (r.status !== "fulfilled") {
      failed.push({ name: s.name, error: String((r.reason && r.reason.message) || r.reason) });
      return;
    }
    for (const it of r.value) {
      const t = it.date ? it.date.getTime() : null;
      if (t !== null && t < since) continue; // outside the chosen window
      articles.push({
        id: hash(s.id + "|" + it.link),
        title: it.title,
        summary: it.summary || null,
        url: it.link,
        source: s.name,
        category: s.category,
        color: s.color,
        publishedAt: it.date ? it.date.toISOString() : null,
        image: it.image || null
      });
    }
  });

  articles.sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0));

  res.json({ generatedAt: new Date().toISOString(), windowDays: days, articles, failed });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Athenaeum Feed running on port " + PORT));
