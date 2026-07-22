#!/usr/bin/env bun
/**
 * podcast-transcript: Extract transcript from Apple Podcasts local cache
 *
 * Data sources:
 *   DB:   ~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite
 *   TTML: ~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Library/Cache/Assets/TTML/
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
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
    find: { type: "boolean", default: false },
    file: { type: "string" },
    reveal: { type: "string" },
    open: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Read a transcript Apple Podcasts already cached on this Mac. Never controls the app.

Hand a file over yourself (nothing else is read):
  --file <path.ttml>    Parse one TTML file you picked

Help yourself find it:
  --find                List recent cached transcripts with their opening lines
  --reveal <n>          Show result #n from --find in Finder

Look it up automatically (reads the Podcasts library database):
  <apple-podcasts-url>  Find this episode's cached transcript
  --list                List episodes whose transcripts are cached
  --open                If it is not cached yet, open the episode in Podcasts
                        so you are one click from View Transcript

Options:
  -o, --output <path>   Save transcript to file
  --format <fmt>        Output format: text (default), srt, json
  -h, --help            Show this help
`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Episode titles routinely contain "|" ("The Inflation Brief | July 2026"), which
// silently shifts every column when sqlite3 uses its default pipe separator.
// Use ASCII unit separator instead — it cannot occur in this data.
const SEP = "\x1f";

function sqlite(query: string): string {
  try {
    return execSync(`sqlite3 -separator $'\\x1f' "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/bash",
    }).trim();
  } catch {
    return "";
  }
}

function sqliteRows(query: string): string[][] {
  const raw = sqlite(query);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.split(SEP));
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

/** First few words of dialogue inside a TTML file, so a human can recognize the episode. */
function ttmlSnippet(path: string, maxChars = 110): string {
  try {
    const text = readFileSync(path, "utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return "(unreadable)";
  }
}

/**
 * List the most recently cached TTML files so the user can pick theirs by eye.
 * Apple's cache uses hashed directories and opaque filenames, so we show each
 * file's modification time plus its opening line — that is what makes an
 * episode recognizable to a human.
 */
function findRecentTtml(limit = 10) {
  if (!existsSync(TTML_ROOT)) {
    console.error(`No Apple Podcasts transcript cache found at:\n  ${TTML_ROOT}`);
    process.exit(1);
  }
  let paths: string[] = [];
  try {
    paths = execSync(`find "${TTML_ROOT}" -name "*.ttml" -type f`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    /* find returns non-zero when it hits nothing */
  }
  if (paths.length === 0) {
    console.error("No cached transcripts yet.\n");
    console.error("In Apple Podcasts: open the episode, click ⋯ (More) → View Transcript,");
    console.error("let it load, then run this again.");
    process.exit(1);
  }

  const rows = paths
    .map((p) => ({ path: p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  console.log(`Most recently cached Apple Podcasts transcripts:\n`);
  rows.forEach((r, i) => {
    const when = new Date(r.mtime).toLocaleString();
    console.log(`[${i + 1}] ${when}`);
    console.log(`    ${ttmlSnippet(r.path)}`);
    console.log(`    ${r.path}\n`);
  });
  console.log(`Use the one you recognize:`);
  console.log(`  --file "<path above>"     parse it into Markdown`);
  console.log(`  --reveal <number>         show it in Finder`);
  return rows.map((r) => r.path);
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
  const fmtEarly = values.format as string;

  // ── Human-handed file: the only thing we touch is this one path. No DB, no scan.
  if (values.file) {
    const p = values.file.replace(/^~/, process.env.HOME!);
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
    const segments = parseTtml(readFileSync(p, "utf8"));
    if (segments.length === 0) {
      console.error(`No transcript segments found in ${p}. Is it a .ttml transcript?`);
      process.exit(1);
    }
    const body =
      fmtEarly === "srt"
        ? formatSrt(segments)
        : fmtEarly === "json"
          ? formatJson(segments)
          : formatText(segments);
    if (values.output) {
      writeFileSync(values.output, body, "utf8");
      console.error(`Transcript saved to: ${values.output}`);
    } else {
      console.log(body);
    }
    return;
  }

  // ── Browse the cache yourself.
  if (values.find || values.reveal) {
    const paths = findRecentTtml();
    if (values.reveal) {
      const idx = parseInt(values.reveal, 10) - 1;
      if (isNaN(idx) || !paths[idx]) {
        console.error(`\n--reveal expects a number between 1 and ${paths.length}.`);
        process.exit(1);
      }
      spawnSync("open", ["-R", paths[idx]], { stdio: "ignore" });
      console.error(`\nRevealed in Finder: ${paths[idx]}`);
    }
    return;
  }

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
    // 3b. Apple knows about a transcript but has not written it to disk yet.
    // Tell the user how to make Apple cache it — we do not drive the app for them.
    console.error("\nApple Podcasts has a transcript for this episode but has not cached it yet.");
    console.error("\nTo get it (about 15 seconds, all in your own hands):");
    if (storeTrackId && podcastCollectionId) {
      const deepLink = `pcast://podcasts.apple.com/podcast/id${podcastCollectionId}?i=${storeTrackId}`;
      console.error(`  1. Open the episode:  ${deepLink}`);
      console.error(`     (or rerun with --open and this command opens it for you)`);
      if (values.open) {
        spawnSync("open", [deepLink], { stdio: "ignore" });
        console.error(`     → opened in Apple Podcasts`);
      }
    } else {
      console.error("  1. Open this episode in Apple Podcasts");
    }
    console.error("  2. Click ⋯ (More) → View Transcript, and let it finish loading");
    console.error("  3. Re-run this command, or run it with --find and pick your episode");
    process.exit(1);
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
