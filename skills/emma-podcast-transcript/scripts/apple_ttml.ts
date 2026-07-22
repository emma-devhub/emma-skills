#!/usr/bin/env bun
/**
 * podcast-transcript: Extract transcript from Apple Podcasts local cache
 *
 * Data sources:
 *   DB:   ~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite
 *   TTML: ~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Library/Cache/Assets/TTML/
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

// ── Paths ────────────────────────────────────────────────────────────────────

const PODCASTS_ROOT = join(
  process.env.HOME!,
  "Library/Group Containers/243LU875E5.groups.com.apple.podcasts"
);
const DB_PATH = join(PODCASTS_ROOT, "Documents/MTLibrary.sqlite");
const TTML_ROOT = join(PODCASTS_ROOT, "Library/Cache/Assets/TTML");

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    output: { type: "string", short: "o" },
    format: { type: "string", default: "text" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Usage: podcast-transcript <url> [options]

Options:
  -o, --output <path>   Save transcript to file
  --format <fmt>        Output format: text (default), srt, json
  --list                List all episodes with cached transcripts
  -h, --help            Show this help
`);
  process.exit(0);
}

// ── Paths to compiled Swift tools ────────────────────────────────────────────

const SKILL_DIR = join(import.meta.dir, "..");
const PODCASTS_CONTROL = join(SKILL_DIR, "scripts/podcasts_control");

// ── Helpers ───────────────────────────────────────────────────────────────────

function sqlite(query: string): string {
  try {
    return execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function sqliteRows(query: string): string[][] {
  const raw = sqlite(query);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.split("|"));
}

/** Extract Apple Podcasts episode ID from a URL.
 *  Apple Podcasts URLs have ?i=<episodeId> or end in /id<podcastId>?i=<episodeId>
 */
function extractEpisodeId(url: string): string | null {
  // ?i=1000674538674
  const match = url.match(/[?&]i=(\d+)/);
  if (match) return match[1];
  return null;
}

/** Find episode in DB by store track ID (= Apple episode ID from URL) */
function findEpisodeByStoreId(episodeId: string) {
  const rows = sqliteRows(
    `SELECT e.ZTITLE, p.ZTITLE, e.ZTRANSCRIPTIDENTIFIER, e.ZSTORETRACKID, e.ZGUID, e.ZWEBPAGEURL, p.ZSTORECOLLECTIONID
     FROM ZMTEPISODE e
     LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
     WHERE e.ZSTORETRACKID = ${episodeId}
     LIMIT 1`
  );
  return rows[0] ?? null;
}

/** Fuzzy search by GUID or web page URL */
function findEpisodeByUrl(url: string) {
  const escaped = url.replace(/'/g, "''");
  const rows = sqliteRows(
    `SELECT e.ZTITLE, p.ZTITLE, e.ZTRANSCRIPTIDENTIFIER, e.ZSTORETRACKID, e.ZGUID, e.ZWEBPAGEURL, p.ZSTORECOLLECTIONID
     FROM ZMTEPISODE e
     LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
     WHERE e.ZWEBPAGEURL = '${escaped}' OR e.ZGUID = '${escaped}'
     LIMIT 1`
  );
  return rows[0] ?? null;
}

/**
 * Trigger transcript fetch by opening the episode in Apple Podcasts and clicking
 * More → "View Transcript", then read the text directly from the AX UI.
 * This avoids waiting for the TTML file to be written to disk (which is async
 * and unpredictable — can take anywhere from seconds to 30+ minutes).
 * Returns the plain text transcript, or null on failure.
 */
async function fetchTranscriptViaAX(
  episodeId: string,
  podcastCollectionId: string
): Promise<string | null> {
  if (!existsSync(PODCASTS_CONTROL)) {
    console.error("Note: podcasts_control binary not found, cannot auto-fetch.");
    return null;
  }

  console.error("Transcript not cached locally. Opening episode in Apple Podcasts...");

  // Open the episode via pcast:// URL scheme
  const pcastUrl = `pcast://podcasts.apple.com/podcast/id${podcastCollectionId}?i=${episodeId}`;
  spawnSync("open", [pcastUrl], { stdio: "ignore" });

  // Wait for Podcasts to navigate to the episode detail page
  // 8s is needed: pcast:// takes time to switch episode and render the detail view
  console.error("Waiting for Apple Podcasts to load episode...");
  await sleep(8000);

  // Click More → "View Transcript" to open the transcript panel
  console.error("Clicking More → View Transcript...");
  const clickResult = spawnSync(PODCASTS_CONTROL, ["view-transcript"], { encoding: "utf8" });
  if (clickResult.status !== 0) {
    console.error("Failed to click View Transcript:", clickResult.stderr);
    return null;
  }

  // Read transcript text directly from the AXTextArea in Podcasts UI.
  // Podcasts renders transcript in memory immediately — no need to wait for disk.
  // Wait 3s for Podcasts to fully render transcript (disclaimer + full text).
  await sleep(3000);
  console.error("Reading transcript from Apple Podcasts UI...");
  const readResult = spawnSync(PODCASTS_CONTROL, ["read-transcript"], { encoding: "utf8" });
  if (readResult.status !== 0 || !readResult.stdout.trim()) {
    console.error("Failed to read transcript from UI:", readResult.stderr);
    return null;
  }

  return readResult.stdout.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve TTML relative path → absolute path */
function resolveTtmlPath(relPath: string): string {
  // relPath is like: PodcastContent221/v4/67/8f/7a/.../transcript_1000749483018.ttml
  // The actual filename has an extra suffix: transcript_ID.ttml-ID.ttml
  // But the DB stores the path without the suffix duplication.
  // Let's check both:
  const direct = join(TTML_ROOT, relPath);
  if (existsSync(direct)) return direct;

  // Sometimes stored without the trailing "-ID.ttml" deduplication
  // Try glob approach: find any file matching the transcript ID
  const idMatch = relPath.match(/transcript_(\d+)\.ttml$/);
  if (idMatch) {
    const id = idMatch[1];
    try {
      const found = execSync(
        `find "${TTML_ROOT}" -name "transcript_${id}.ttml*" 2>/dev/null | head -1`,
        { encoding: "utf8" }
      ).trim();
      if (found) return found;
    } catch {}
  }
  return direct; // return original even if not found (caller will check)
}

// ── TTML Parser ───────────────────────────────────────────────────────────────

interface Segment {
  begin: number;
  end: number;
  speaker: string;
  text: string;
}

function timeToSeconds(t: string): number {
  // Formats: "0.980", "1:10.000", "24:24.066"
  const parts = t.split(":");
  if (parts.length === 1) return parseFloat(parts[0]);
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  return (
    parseInt(parts[0]) * 3600 +
    parseInt(parts[1]) * 60 +
    parseFloat(parts[2])
  );
}

function secondsToSrt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`.replace(".", ",");
}

function parseTtml(content: string): Segment[] {
  const segments: Segment[] = [];

  // Extract all <p> elements with their speaker and timing
  const pRegex = /<p\s([^>]*)>([\s\S]*?)<\/p>/g;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(content)) !== null) {
    const attrs = pMatch[1];
    const inner = pMatch[2];

    const beginMatch = attrs.match(/begin="([^"]+)"/);
    const endMatch = attrs.match(/end="([^"]+)"/);
    const agentMatch = attrs.match(/ttm:agent="([^"]+)"/);

    if (!beginMatch || !endMatch) continue;

    const begin = timeToSeconds(beginMatch[1]);
    const end = timeToSeconds(endMatch[1]);
    const speaker = agentMatch ? agentMatch[1] : "";

    // Extract text from spans, stripping all tags
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (text) {
      segments.push({ begin, end, speaker, text });
    }
  }

  return segments;
}

function formatText(segments: Segment[]): string {
  // Group consecutive segments by speaker
  const lines: string[] = [];
  let currentSpeaker = "";
  let currentParts: string[] = [];

  const flush = () => {
    if (currentParts.length) {
      const prefix = currentSpeaker ? `[${currentSpeaker}] ` : "";
      lines.push(prefix + currentParts.join(" "));
      currentParts = [];
    }
  };

  for (const seg of segments) {
    if (seg.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = seg.speaker;
    }
    currentParts.push(seg.text);
  }
  flush();

  return lines.join("\n\n");
}

function formatSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      return `${i + 1}\n${secondsToSrt(seg.begin)} --> ${secondsToSrt(seg.end)}\n${seg.text}`;
    })
    .join("\n\n");
}

function formatJson(segments: Segment[]): string {
  return JSON.stringify(segments, null, 2);
}

// ── List mode ─────────────────────────────────────────────────────────────────

function listCachedTranscripts() {
  const rows = sqliteRows(
    `SELECT e.ZTITLE, p.ZTITLE, e.ZTRANSCRIPTIDENTIFIER, e.ZSTORETRACKID
     FROM ZMTEPISODE e
     LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
     WHERE e.ZTRANSCRIPTIDENTIFIER IS NOT NULL
     ORDER BY e.ZPUBDATE DESC
     LIMIT 100`
  );

  // Filter to only locally cached ones
  const cached = rows.filter(([, , relPath]) => {
    if (!relPath) return false;
    const full = resolveTtmlPath(relPath);
    return existsSync(full);
  });

  if (cached.length === 0) {
    console.log("No locally cached transcripts found.");
    console.log(
      "Open episodes in Apple Podcasts and play them to cache transcripts."
    );
    return;
  }

  console.log(`Found ${cached.length} locally cached transcripts:\n`);
  for (const [epTitle, podTitle, , storeId] of cached) {
    const appleUrl = storeId
      ? `https://podcasts.apple.com/podcast/id?i=${storeId}`
      : "(no URL)";
    console.log(`• ${podTitle || "Unknown Podcast"} — ${epTitle || "Unknown Episode"}`);
    console.log(`  Episode ID: ${storeId}   URL: ${appleUrl}`);
    console.log();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Check DB exists
  if (!existsSync(DB_PATH)) {
    console.error("Apple Podcasts database not found.");
    console.error(`Expected: ${DB_PATH}`);
    console.error("Make sure Apple Podcasts app is installed and has been opened.");
    process.exit(1);
  }

  if (values.list) {
    listCachedTranscripts();
    return;
  }

  const url = positionals[0];
  if (!url) {
    console.error("Usage: podcast-transcript <url> [options]");
    console.error("       podcast-transcript --list");
    process.exit(1);
  }

  // 1. Find episode in DB
  let episode: string[] | null = null;

  const episodeId = extractEpisodeId(url);
  if (episodeId) {
    episode = findEpisodeByStoreId(episodeId);
  }

  if (!episode) {
    // Try by URL/GUID
    episode = findEpisodeByUrl(url);
  }

  if (!episode) {
    console.error(`Episode not found in Apple Podcasts database.`);
    console.error(`URL: ${url}`);
    if (episodeId) console.error(`Episode ID tried: ${episodeId}`);
    console.error(
      "\nMake sure you've subscribed to this podcast in Apple Podcasts and the episode appears in your library."
    );
    process.exit(1);
  }

  const [epTitle, podTitle, ttmlRelPath, storeTrackId, , webUrl, podcastCollectionId] = episode;

  console.error(`Found: ${podTitle} — ${epTitle}`);
  if (webUrl) console.error(`Web URL: ${webUrl}`);

  // 2. Find TTML file
  if (!ttmlRelPath) {
    console.error(
      "\nNo transcript available for this episode in Apple Podcasts."
    );
    console.error(
      "Not all episodes have transcripts — this is determined by the podcast publisher."
    );
    process.exit(1);
  }

  const ttmlPath = resolveTtmlPath(ttmlRelPath);
  const fmt = values.format as string;
  let output: string;

  if (existsSync(ttmlPath) && fmt !== "ax") {
    // 3a. TTML already cached — parse it (fast path, gives timestamps + speaker labels)
    const content = readFileSync(ttmlPath, "utf8");
    const segments = parseTtml(content);
    if (segments.length === 0) {
      console.error("Warning: No transcript segments found in TTML file.");
      process.exit(1);
    }
    console.error(`Parsed ${segments.length} segments from transcript.\n`);
    if (fmt === "srt") {
      output = formatSrt(segments);
    } else if (fmt === "json") {
      output = formatJson(segments);
    } else {
      output = `# ${podTitle} — ${epTitle}\n\n${formatText(segments)}`;
    }
  } else {
    // 3b. TTML not cached — fetch via AX (open Podcasts, click View Transcript, read UI text)
    // This is reliable because Podcasts renders transcript in memory immediately,
    // while TTML disk write is async and can take seconds to 30+ minutes.
    if (!storeTrackId || !podcastCollectionId) {
      console.error("\nCould not determine episode/podcast ID to open in Apple Podcasts.");
      process.exit(1);
    }
    const axText = await fetchTranscriptViaAX(storeTrackId, podcastCollectionId);
    if (!axText) {
      console.error("\nCould not fetch transcript from Apple Podcasts UI.");
      console.error("Make sure Apple Podcasts is running and this episode has a transcript.");
      process.exit(1);
    }
    console.error(`Fetched transcript from Apple Podcasts UI (${axText.length} chars).\n`);
    // AX text is plain text — wrap in heading
    output = `# ${podTitle} — ${epTitle}\n\n${axText}`;
  }

  // 5. Write or print
  if (values.output) {
    writeFileSync(values.output, output, "utf8");
    console.error(`Transcript saved to: ${values.output}`);
  } else if (fmt === "text") {
    // Auto-save as .md to /tmp so output isn't truncated
    const safeTitle = `${podTitle} — ${epTitle}`
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s\-–—]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
    const autoPath = `${process.env.HOME}/Downloads/podcast-${safeTitle}.md`;
    writeFileSync(autoPath, output, "utf8");
    console.log(output);
    console.error(`\nTranscript also saved to: ${autoPath}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
