#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const USER_AGENT = "walk-image-downloader/1.0 (local script)";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const IMAGE_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif"
};

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with",
  "de", "du", "des", "le", "la", "les", "d", "l", "et", "sur", "au", "aux"
]);

const QUERY_OVERRIDES = {
  paris_start: ["Paris skyline", "Paris cityscape"],
  shakespeare_co: ["Shakespeare and Company Paris bookstore"],
  pantheon: ["Pantheon Paris"],
  hotel_des_invalides: ["Les Invalides Paris"],
  la_madeleine: ["La Madeleine church Paris"],
  orangerie: ["Musee de l Orangerie Paris"],
  water_lilies: ["Water Lilies Claude Monet"],
  orangerie_renoir: ["Renoir painting Musee de l Orangerie"],
  louvre_venue: ["Louvre Museum"],
  wedding_feast_cana: ["The Wedding at Cana painting"],
  winged_victory: ["Winged Victory of Samothrace"],
  liberty_leading: ["Liberty Leading the People"],
  raft_of_medusa: ["The Raft of the Medusa"],
  psyche_revived: ["Psyche Revived by Cupid's Kiss"],
  code_of_hammurabi: ["Code of Hammurabi stele"],
  great_sphinx_tanis: ["Great Sphinx of Tanis"],
  the_thinker: ["The Thinker Rodin"],
  the_kiss_rodin: ["The Kiss Rodin sculpture"],
  bal_du_moulin: ["Bal du moulin de la Galette"],
  olympia_manet: ["Olympia Manet"],
  little_dancer_degas: ["Little Dancer of Fourteen Years"],
  luncheon_grass: ["Le Dejeuner sur l herbe"],
  chagall_ceiling: ["Marc Chagall ceiling Palais Garnier"],
  duchamp_fountain: ["Fountain Marcel Duchamp"],
  matisse_dance: ["The Dance Matisse"],
  persistence_memory: ["The Persistence of Memory"],
  arc_tomb_soldier: ["Tomb of the Unknown Soldier Paris"],
  arc_roof_terrace: ["Arc de Triomphe rooftop view"],
  pont_neuf_sunset: ["Pont Neuf sunset Paris"],
  louvre_by_night: ["Louvre at night"],
  paris_finish: ["Seine River Paris night"]
};

function parseArgs(argv) {
  const scriptDir = __dirname;
  const args = {
    cityFile: path.resolve(scriptDir, "../../firebase/seed-data/paris.json"),
    outDir: path.resolve(scriptDir, "../incoming"),
    limit: 0,
    overwrite: false,
    retryManifest: ""
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--city-file") args.cityFile = path.resolve(argv[++i]);
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i] || 0);
    else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--retry-manifest") args.retryManifest = path.resolve(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Usage:
  node scripts/download_wikipedia_images.js [--city-file <path>] [--out-dir <path>] [--limit N] [--overwrite]
  node scripts/download_wikipedia_images.js --retry-manifest <path> [--out-dir <path>] [--overwrite]

Defaults:
  --city-file ../../firebase/seed-data/paris.json
  --out-dir   ../incoming
`);
}

function normalizeText(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
}

function overlapScore(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  let common = 0;
  for (const token of a) {
    if (b.has(token)) common += 1;
  }
  return common / Math.max(a.size, b.size);
}

function dedupe(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function buildQueries(item) {
  const baseFromId = item.id.replace(/_/g, " ");
  return dedupe([
    ...(QUERY_OVERRIDES[item.id] || []),
    item.title,
    item.subtitle ? `${item.title} ${item.subtitle}` : "",
    item.parentTitle ? `${item.title} ${item.parentTitle}` : "",
    item.type === "artwork"
      ? `${item.title} ${item.parentTitle || ""}`.trim()
      : `${item.title} Paris`,
    baseFromId,
    `${baseFromId} Paris`
  ]).slice(0, 6);
}

function scoreCommonsCandidate(item, query, page, imageInfo, rank) {
  const fileTitle = (page.title || "").replace(/^File:/i, "");
  const fileTokens = tokenize(fileTitle);
  const itemTokens = tokenize([item.title, item.subtitle, item.parentTitle, item.id.replace(/_/g, " ")].join(" "));
  const queryTokens = tokenize(query);

  const width = Number(imageInfo.width || imageInfo.thumbwidth || 0);
  const height = Number(imageInfo.height || imageInfo.thumbheight || 0);
  const mime = (imageInfo.mime || "").toLowerCase();

  let score = 0;
  score += 110 - rank * 8;
  score += overlapScore(fileTokens, itemTokens) * 120;
  score += overlapScore(fileTokens, queryTokens) * 90;
  score += Math.min(Math.sqrt(Math.max(width, 1) * Math.max(height, 1)) / 60, 45);

  if (mime === "image/jpeg") score += 15;
  if (mime === "image/webp") score += 12;
  if (mime === "image/png") score += 3;
  if (mime === "image/gif" || mime === "image/svg+xml") score -= 220;

  if (width < 700 || height < 450) score -= 40;

  if (/(logo|icon|map|plan|flag|seal|coat of arms|poster|affiche|ticket)/i.test(fileTitle)) {
    score -= 90;
  }

  if (item.type !== "artwork" && /\bparis\b/i.test(fileTitle)) {
    score += 10;
  }

  return score;
}

async function fetchJson(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

async function searchCommons(query, cache) {
  if (cache.has(query)) return cache.get(query);

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "12",
    gsrsearch: query,
    prop: "imageinfo",
    iiprop: "url|size|mime",
    iiurlwidth: "2200"
  });
  const url = `${COMMONS_API}?${params.toString()}`;
  const data = await fetchJson(url);

  const pages = Object.values(data.query?.pages || {}).sort(
    (a, b) => Number(a.index || 9999) - Number(b.index || 9999)
  );
  cache.set(query, pages);
  return pages;
}

async function resolveBestImage(item, searchCache) {
  const queries = buildQueries(item);
  let best = null;

  for (const query of queries) {
    const pages = await searchCommons(query, searchCache);
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      const info = page.imageinfo?.[0];
      if (!info) continue;

      const candidateUrl = info.thumburl || info.url;
      if (!candidateUrl) continue;

      const score = scoreCommonsCandidate(item, query, page, info, i);
      if (!best || score > best.score) {
        best = {
          score,
          query,
          title: page.title,
          url: candidateUrl,
          originalUrl: info.url || candidateUrl,
          pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
          mime: info.mime || "",
          width: Number(info.thumbwidth || info.width || 0),
          height: Number(info.thumbheight || info.height || 0)
        };
      }
    }

    if (best && best.score >= 185) {
      break;
    }
  }

  return best;
}

function extFromMimeOrUrl(mime, url) {
  const byMime = IMAGE_EXT_BY_MIME[(mime || "").toLowerCase()];
  if (byMime) return byMime;

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.(jpg|jpeg|png|webp|avif|heic|heif)$/i);
    if (match) return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  } catch (_) {
    // ignore
  }
  return "jpg";
}

async function downloadToFile(url, destination) {
  let lastError = null;

  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "image/*,*/*;q=0.8"
      }
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(destination, buffer);
      return;
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1500 * attempt;
      lastError = new Error(`Failed download: HTTP ${response.status} (${url})`);
      await sleep(waitMs + Math.floor(Math.random() * 500));
      continue;
    }

    throw new Error(`Failed download: HTTP ${response.status} (${url})`);
  }

  throw lastError || new Error(`Failed download after retries (${url})`);
}

async function downloadCandidate(candidate, destination) {
  const sources = dedupe([candidate.url || "", candidate.originalUrl || ""]);
  let lastError = null;

  for (const source of sources) {
    if (!source) continue;
    try {
      await downloadToFile(source, destination);
      return source;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No valid image source URL");
}

async function retryFromManifest(args) {
  if (!fs.existsSync(args.retryManifest)) {
    throw new Error(`Manifest not found: ${args.retryManifest}`);
  }

  await fsp.mkdir(args.outDir, { recursive: true });

  const manifest = JSON.parse(await fsp.readFile(args.retryManifest, "utf8"));
  const targets = manifest.filter((entry) => entry.status === "download_error" && (entry.url || entry.originalUrl));

  console.log(`Retry mode: ${targets.length} failed image(s) from manifest`);

  let retriedOk = 0;
  let retriedFail = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const entry = targets[i];
    const indexLabel = String(i + 1).padStart(3, "0");
    const destination = path.join(args.outDir, entry.fileName || `${entry.id}.jpg`);

    if (!args.overwrite && fs.existsSync(destination)) {
      entry.status = "skipped_exists";
      entry.retryNote = "already exists";
      continue;
    }

    console.log(`[${indexLabel}/${String(targets.length).padStart(3, "0")}] Retrying: ${entry.fileName || entry.id}`);
    try {
      const usedSource = await downloadCandidate(
        { url: entry.url, originalUrl: entry.originalUrl, mime: entry.mime },
        destination
      );
      entry.status = "downloaded";
      entry.retryUsedSource = usedSource;
      delete entry.error;
      retriedOk += 1;
      console.log(`  Downloaded`);
    } catch (error) {
      entry.status = "download_error";
      entry.error = String(error.message || error);
      retriedFail += 1;
      console.log(`  Still failing`);
    }

    await sleep(1700);
  }

  const retryOutputPath = path.join(args.outDir, "wikimedia_manifest_paris_retry.json");
  await fsp.writeFile(retryOutputPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log("");
  console.log(`Retry done. downloaded=${retriedOk} failed=${retriedFail}`);
  console.log(`Retry manifest: ${retryOutputPath}`);
}

function buildItems(data) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const items = [];

  for (const node of nodes) {
    const assetId = node.assets?.photoAssetId;
    if (!assetId) continue;
    items.push({
      id: node.id,
      assetId,
      title: node.title || node.id,
      subtitle: node.subtitle || "",
      type: node.type || "node",
      parentTitle: node.parentId ? nodeById.get(node.parentId)?.title || "" : ""
    });
  }

  const cityCoverAssetId = data.city?.coverAssetId;
  if (cityCoverAssetId) {
    items.unshift({
      id: "city_cover",
      assetId: cityCoverAssetId,
      title: data.city?.title || "Paris",
      subtitle: "city cover",
      type: "cover",
      parentTitle: ""
    });
  }

  return items;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.retryManifest) {
    await retryFromManifest(args);
    return;
  }

  if (!fs.existsSync(args.cityFile)) {
    throw new Error(`City file not found: ${args.cityFile}`);
  }

  await fsp.mkdir(args.outDir, { recursive: true });

  const data = JSON.parse(await fsp.readFile(args.cityFile, "utf8"));
  const items = buildItems(data);
  const searchCache = new Map();
  const manifest = [];
  const unresolved = [];

  const limit = args.limit > 0 ? Math.min(args.limit, items.length) : items.length;

  console.log(`Preparing ${limit} image(s) -> ${args.outDir}`);

  for (let i = 0; i < limit; i += 1) {
    const item = items[i];
    const indexLabel = String(i + 1).padStart(3, "0");
    console.log(`[${indexLabel}/${String(limit).padStart(3, "0")}] Searching: ${item.id} (${item.title})`);

    let candidate = null;
    try {
      candidate = await resolveBestImage(item, searchCache);
    } catch (error) {
      manifest.push({
        id: item.id,
        assetId: item.assetId,
        title: item.title,
        status: "search_error",
        error: String(error.message || error)
      });
      unresolved.push(item.id);
      continue;
    }

    if (!candidate) {
      manifest.push({
        id: item.id,
        assetId: item.assetId,
        title: item.title,
        status: "not_found"
      });
      unresolved.push(item.id);
      continue;
    }

    const ext = extFromMimeOrUrl(candidate.mime, candidate.url);
    const fileName = `${indexLabel}_${item.id}.${ext}`;
    const destination = path.join(args.outDir, fileName);

    if (!args.overwrite && fs.existsSync(destination)) {
      manifest.push({
        id: item.id,
        assetId: item.assetId,
        title: item.title,
        status: "skipped_exists",
        fileName,
        ...candidate
      });
      console.log(`  Skipped (exists): ${fileName}`);
      continue;
    }

    try {
      const usedSource = await downloadCandidate(candidate, destination);
      manifest.push({
        id: item.id,
        assetId: item.assetId,
        title: item.title,
        status: "downloaded",
        fileName,
        usedSource,
        ...candidate
      });
      console.log(`  Downloaded: ${fileName} (score=${candidate.score.toFixed(1)})`);
    } catch (error) {
      manifest.push({
        id: item.id,
        assetId: item.assetId,
        title: item.title,
        status: "download_error",
        fileName,
        ...candidate,
        error: String(error.message || error)
      });
      unresolved.push(item.id);
      console.log(`  Download failed: ${fileName}`);
    }

    await sleep(700);
  }

  const manifestPath = path.join(args.outDir, "wikimedia_manifest_paris.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const downloadedCount = manifest.filter((entry) => entry.status === "downloaded").length;
  const skippedCount = manifest.filter((entry) => entry.status === "skipped_exists").length;
  const failedCount = manifest.length - downloadedCount - skippedCount;

  console.log("");
  console.log(`Done. downloaded=${downloadedCount} skipped=${skippedCount} failed=${failedCount}`);
  console.log(`Manifest: ${manifestPath}`);
  if (unresolved.length) {
    console.log(`Unresolved IDs (${unresolved.length}): ${unresolved.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
