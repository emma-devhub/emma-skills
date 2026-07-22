#!/usr/bin/env bun
// resolve.ts — rungs 0+1 of the transcript ladder.
// Input: a podcast link (Apple Podcasts episode / Xiaoyuzhou episode / RSS feed).
// Output: JSON — normalized episode metadata, audio enclosure, episode webpage,
// and any transcript already published in the RSS feed (Podcasting 2.0
// <podcast:transcript> tag). Zero permissions, zero API keys.

type Transcript = { url?: string; type?: string; source: string; text?: string };
type Resolved = {
  platform: string;
  showTitle?: string;
  episodeTitle?: string;
  audioUrl?: string;
  feedUrl?: string;
  episodeGuid?: string;
  webpage?: string;
  publishedTranscripts: Transcript[];
  youtubeQuery?: string;
  notes: string[];
};

const argv = process.argv.slice(2);
const wantTranscript = argv.includes("--transcript");
const input = argv.find((a) => !a.startsWith("--"));
if (!input) {
  console.error("usage: bun resolve.ts <podcast-episode-link> [--transcript]");
  console.error("  --transcript  print the show-notes transcript as Markdown, if one exists");
  process.exit(1);
}

const UA = "Mozilla/5.0 (compatible; emma-podcast-transcript)";

async function get(u: string): Promise<string> {
  const r = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${u}`);
  return await r.text();
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])) : undefined;
}

function items(rss: string): string[] {
  return rss.split(/<item[\s>]/).slice(1).map((s) => s.split("</item>")[0]);
}

function transcriptTags(item: string): Transcript[] {
  const out: Transcript[] = [];
  for (const m of item.matchAll(/<podcast:transcript\b[^>]*/gi)) {
    const url = m[0].match(/url="([^"]+)"/i)?.[1];
    const type = m[0].match(/type="([^"]+)"/i)?.[1];
    if (url) out.push({ url: decodeEntities(url), type, source: "rss podcast:transcript tag" });
  }
  return out;
}

/**
 * Some shows (Morgan Stanley's Thoughts on the Market, many corporate podcasts)
 * paste the whole transcript into the episode's show notes rather than
 * publishing a podcast:transcript tag. Look for a transcript marker in the
 * description and return everything after it.
 */
function inlineTranscript(item: string): Transcript | undefined {
  const raw =
    item.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1] ??
    item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1];
  if (!raw) return undefined;

  let txt = stripCdata(raw);
  txt = decodeEntities(decodeEntities(txt))
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // "----- Transcript -----", "Transcript:", "Full transcript" ...
  const marker = txt.match(/^[-\s*]*(?:full\s+)?transcript[-\s*:]*$/im);
  let body = marker ? txt.slice(marker.index! + marker[0].length).trim() : txt;

  // Without a marker, only trust it if it is long enough to be a real transcript
  // rather than a blurb.
  if (!marker && body.length < 2500) return undefined;
  if (body.length < 800) return undefined;

  return {
    source: marker ? "inline transcript in show notes" : "show notes body (no marker; verify)",
    text: body,
  };
}

function enclosureUrl(item: string): string | undefined {
  const u = item.match(/<enclosure\b[^>]*url="([^"]+)"/i)?.[1];
  return u ? decodeEntities(u) : undefined;
}

// Match a feed <item> to an episode by guid first, then normalized title.
function findItem(rss: string, guid?: string, title?: string): string | undefined {
  const all = items(rss);
  if (guid) {
    const hit = all.find((it) => (tag(it, "guid") ?? "").includes(guid));
    if (hit) return hit;
  }
  if (title) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const t = norm(title);
    return all.find((it) => {
      const it2 = tag(it, "title");
      return it2 && (norm(it2) === t || norm(it2).includes(t) || t.includes(norm(it2)));
    });
  }
  return undefined;
}

async function resolveApple(url: string): Promise<Resolved> {
  const showId = url.match(/\/id(\d+)/)?.[1];
  const episodeId = url.match(/[?&]i=(\d+)/)?.[1];
  const notes: string[] = [];
  if (!showId) throw new Error("Could not find a show id (idXXXX) in the Apple Podcasts URL.");
  if (!episodeId)
    throw new Error(
      "This looks like a show page, not an episode. Open the episode and copy its link (it contains ?i=...)."
    );

  // iTunes Lookup API: public, no auth. Returns the show (with feedUrl) followed by episodes.
  const lookup = JSON.parse(
    await get(`https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=300`)
  );
  const show = lookup.results?.find((r: any) => r.kind === "podcast");
  const ep = lookup.results?.find((r: any) => String(r.trackId) === episodeId);
  let pageTitle: string | undefined;
  if (!ep) {
    notes.push("Episode not in the show's latest 300 episodes via iTunes lookup; matching inside the RSS feed by page title instead.");
    try {
      const page = await get(input);
      pageTitle = page.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    } catch {
      notes.push("Could not fetch the Apple episode page for a title either.");
    }
  }

  const res: Resolved = {
    platform: "apple-podcasts",
    showTitle: show?.collectionName ?? ep?.collectionName,
    episodeTitle: ep?.trackName ?? pageTitle,
    audioUrl: ep?.episodeUrl,
    feedUrl: show?.feedUrl ?? ep?.feedUrl,
    episodeGuid: ep?.episodeGuid,
    webpage: undefined,
    publishedTranscripts: [],
    notes,
  };

  if (res.feedUrl) {
    try {
      const rss = await get(res.feedUrl);
      const item = findItem(rss, res.episodeGuid, res.episodeTitle);
      if (item) {
        res.publishedTranscripts = transcriptTags(item);
        const inline = inlineTranscript(item);
        if (inline) res.publishedTranscripts.push(inline);
        res.webpage = tag(item, "link");
        res.audioUrl = res.audioUrl ?? enclosureUrl(item);
        res.episodeTitle = res.episodeTitle ?? tag(item, "title");
      } else {
        notes.push("Could not match the episode inside the RSS feed (old episode or retitled).");
      }
    } catch (e: any) {
      notes.push(`RSS fetch failed: ${e.message}`);
    }
  } else {
    notes.push("No feedUrl from iTunes lookup (some shows hide their feed).");
  }
  return res;
}

async function resolveXiaoyuzhou(url: string): Promise<Resolved> {
  const page = await get(url);
  const audioUrl = page.match(/https:\/\/media\.xyzcdn\.net\/[^"]*\.(?:m4a|mp3)/)?.[0];
  const episodeTitle =
    page.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
    page.match(/"title":"([^"]+)"/)?.[1];
  const showTitle = page.match(/<meta property="og:site_name" content="([^"]+)"/)?.[1];
  const notes: string[] = [];
  if (!audioUrl) notes.push("Could not extract the audio URL from the Xiaoyuzhou page.");
  notes.push("Xiaoyuzhou publishes no transcripts; expect to land on the YouTube or ASR rung.");
  return {
    platform: "xiaoyuzhou",
    showTitle,
    episodeTitle,
    audioUrl,
    webpage: url,
    publishedTranscripts: [],
    notes,
  };
}

async function resolveFeed(url: string): Promise<Resolved> {
  const rss = await get(url);
  const first = items(rss)[0];
  return {
    platform: "rss",
    showTitle: tag(rss.split("<item")[0], "title"),
    episodeTitle: first ? tag(first, "title") : undefined,
    audioUrl: first ? enclosureUrl(first) : undefined,
    feedUrl: url,
    webpage: first ? tag(first, "link") : undefined,
    publishedTranscripts: first
      ? [...transcriptTags(first), ...(inlineTranscript(first) ? [inlineTranscript(first)!] : [])]
      : [],
    notes: ["Direct RSS input: resolved the LATEST episode. Pass an episode page link to target a specific one."],
  };
}

async function main() {
  let res: Resolved;
  if (/podcasts\.apple\.com|^podcast:\/\//.test(input)) res = await resolveApple(input);
  else if (/xiaoyuzhoufm\.com\/episode\//.test(input)) res = await resolveXiaoyuzhou(input);
  else if (/youtube\.com|youtu\.be/.test(input))
    res = {
      platform: "youtube",
      publishedTranscripts: [],
      notes: ["Already a YouTube link — skip straight to the caption rung (yt-dlp)."],
    };
  else res = await resolveFeed(input);

  if (res.showTitle && res.episodeTitle) res.youtubeQuery = `${res.showTitle} ${res.episodeTitle}`;

  const inline = res.publishedTranscripts.find((t) => t.text);

  if (wantTranscript) {
    if (!inline?.text) {
      console.error("No inline transcript in this feed's show notes. Continue down the ladder.");
      process.exit(1);
    }
    const head = [`# ${res.episodeTitle ?? "Transcript"}`, ""];
    if (res.showTitle) head.push(`Show: ${res.showTitle}`);
    head.push(`Source: ${input}`, `Via: ${inline.source}`, "", "---", "");
    console.log(head.join("\n") + inline.text);
    return;
  }

  // Keep the JSON scannable: report that inline text exists, don't inline it.
  const json = {
    ...res,
    publishedTranscripts: res.publishedTranscripts.map(({ text, ...rest }) =>
      text ? { ...rest, chars: text.length, hint: "rerun with --transcript to print it" } : rest
    ),
  };
  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error(`resolve failed: ${e.message}`);
  process.exit(1);
});
