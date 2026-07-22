---
name: emma-podcast-transcript
description: Get a transcript for any podcast episode from any link — Apple Podcasts, Xiaoyuzhou (小宇宙), RSS, or YouTube. Tries zero-permission sources first (published RSS transcripts, show notes, YouTube captions) and only falls back to local-file access or audio transcription with the user's explicit consent. Use when the user shares a podcast link and wants the transcript, text version, 文字稿, or 转录.
---

# emma-podcast-transcript

Turn any podcast link into a clean Markdown transcript, climbing a ladder of sources from least to most invasive. **Zero-permission paths first; local access and API keys are always opt-in, never a prerequisite.**

## Script directory

1. Determine this SKILL.md file's directory as `SKILL_DIR`.
2. Scripts live in `${SKILL_DIR}/scripts/`.
3. Dependencies: `bun` (or `npx -y bun`) for the .ts scripts; `curl`/`ffmpeg` for ASR; `yt-dlp` for YouTube captions.

## The ladder

Work through the rungs IN ORDER. Stop at the first rung that yields a transcript. Before rungs 4 and 5, tell the user what the rung requires and get their OK.

### Rung 0 — Resolve the link (always run first)

```bash
npx -y bun ${SKILL_DIR}/scripts/resolve.ts "<podcast-link>"
```

Accepts Apple Podcasts episode links, Xiaoyuzhou episode links, RSS feed URLs, YouTube links. Outputs JSON: show/episode title, audio enclosure URL, episode webpage, feed URL, any published transcript URLs (rung 1), and a ready-made `youtubeQuery`. Uses only public endpoints (iTunes Lookup API, the show's own RSS). Read the `notes` field — it flags what to expect downstream.

### Rung 1 — Published transcript in the RSS feed (zero permission)

If `publishedTranscripts` is non-empty, fetch the best format (prefer text/vtt/srt over json) with `curl`, convert to clean Markdown, done. Coverage is low (~1% of shows) but it is a free win when present.

### Rung 2 — Show notes / episode webpage (zero permission)

Fetch the `webpage` URL from rung 0 and look for a transcript: a "Transcript" section or heading, or a link containing "transcript". Many professional shows (NPR, NYT, a16z, Lex Fridman, etc.) publish transcripts on their sites. If found, extract and clean it. This rung is judgment-based — use your web-fetch ability rather than a script.

### Rung 3 — YouTube captions (zero permission)

Most shows cross-post to YouTube. Search with the `youtubeQuery` from rung 0:

```bash
yt-dlp "ytsearch3:<youtubeQuery>" --print "%(id)s | %(title)s | %(duration)s" --no-download
```

Verify the match (title AND duration within ~2 minutes of the episode). Then pull captions, preferring human-made over auto-generated:

```bash
yt-dlp --write-subs --write-auto-subs --sub-langs "en.*,zh.*" --skip-download --convert-subs srt -o "/tmp/%(id)s" "https://youtube.com/watch?v=<id>"
```

Convert the .srt to Markdown (strip timestamps, merge lines into paragraphs). If YouTube blocks caption downloads (bot checks), note it and move on — do not retry endlessly.

### Rung 4 — Apple Podcasts local cache (macOS, opt-in)

Only offer this when the user is on macOS with the Podcasts app. **Ask first**, explaining: this reads transcript files Apple already cached on their machine (`~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/`) — it reads two files, it does not control the app. Apple's own transcripts are high quality, so this beats ASR when available.

```bash
npx -y bun ${SKILL_DIR}/scripts/apple_ttml.ts "<apple-podcasts-episode-url>"
```

If the transcript is not cached yet, tell the user: open the episode in Podcasts, play a few seconds, then retry. Options: `-o <path>`, `--format text|srt|json`, `--list`.

### Rung 5 — Transcribe the audio (opt-in, needs a key OR local compute)

Last resort; the only rung that works for every episode (and currently the only one for Xiaoyuzhou). **Ask the user to choose an engine:**

- `groq` — fast, free tier (~2h audio/day), needs a free API key; audio is sent to Groq.
- `local` — whisper.cpp on their machine, slower, nothing leaves the machine.

```bash
bash ${SKILL_DIR}/scripts/asr.sh "<audioUrl-from-rung-0>" -o /tmp/transcript.md -t "<episode title>" -s "<episode link>" -e groq
# add -l zh / -l en to pin the language; omit to auto-detect
```

Handles download, transcode, 20MB chunking, rate-limit retry, merge.

## Output

Always deliver a single Markdown file: `# <episode title>`, source link, duration, then the transcript as readable paragraphs (no timestamps unless the user asks). Tell the user which rung produced it.

## Privacy stance (also the README pitch)

- Rungs 0-3 touch only public endpoints. No accounts, no keys, no local file access.
- Rung 4 reads two local files and only runs after the user says yes.
- Rung 5 lets the user pick between a cloud key and fully-local compute.
