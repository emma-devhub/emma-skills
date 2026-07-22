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

Work through the rungs IN ORDER. Stop at the first rung that yields a transcript.

**Never skip a rung to reach transcription.** Rung 5 downloads the audio, spends the user's API quota or their CPU, and produces the worst transcript of the five. Rungs 1-3 cost nothing, and rung 4 is usually better than anything ASR will give you.

**Hard rule at rung 4:** on macOS, if rungs 0-3 came up empty you must STOP and ask the user before going any further. Do not decide on their behalf that they would rather not be asked, and do not treat "opt-in" as "skip it."

Tell them what to do — not what you tried. Which rungs you climbed is your bookkeeping; they only need to know that something better exists, how to get it, and what happens if they skip it. When 4b reports a transcript that is not cached yet:

> Apple has an official transcript for this episode but hasn't saved it to your Mac.
>
> Opening it in Podcasts sometimes makes it save: open the episode → ⋯ → View Transcript → let it load, then tell me. Worth 15 seconds if you want the better transcript, but it doesn't always work.
>
> Want me to open the episode for you? Or I can just transcribe the audio — a few minutes, rougher result.

Keep it about that short. No rung numbers, no summary of the free paths you already tried, no explanation of what the skill will and will not read — the README covers that, and raising it unprompted invents a worry the user did not have. Mirror the user's language.

**Do not promise that viewing the transcript will make it appear.** Measured behavior: Apple registers the transcript's path in its library database the moment it knows one exists, but writes the TTML to disk on its own schedule — sometimes not within several minutes of viewing it in the app, and independent of whether the episode is downloaded. If a retry comes up empty, say so plainly and move to rung 5 rather than asking the user to wait again.

Wait for their answer. Only run rung 5 if they decline, rung 4 comes up empty, or they are not on macOS.

### Rung 0 — Resolve the link (always run first)

```bash
npx -y bun ${SKILL_DIR}/scripts/resolve.ts "<podcast-link>"
```

Accepts Apple Podcasts episode links, Xiaoyuzhou episode links, RSS feed URLs, YouTube links. Outputs JSON: show/episode title, audio enclosure URL, episode webpage, feed URL, any published transcript URLs (rung 1), and a ready-made `youtubeQuery`. Uses only public endpoints (iTunes Lookup API, the show's own RSS). Read the `notes` field — it flags what to expect downstream.

### Rung 1 — Published transcript in the RSS feed (zero permission)

Two shapes, both surfaced in `publishedTranscripts`:

**1a — `podcast:transcript` tag.** Entries with a `url`. Fetch the best format (prefer text/vtt/srt over json) with `curl` and convert to clean Markdown. Coverage is low (~1% of shows) but free when present.

**1b — transcript pasted into the show notes.** Entries whose `source` says *inline transcript in show notes*. Many corporate and institutional podcasts (Morgan Stanley's Thoughts on the Market, bank and consultancy shows) put the entire transcript in the episode description with a `----- Transcript -----` marker, and publish no tag at all. Print it directly:

```bash
npx -y bun ${SKILL_DIR}/scripts/resolve.ts "<link>" --transcript
```

These are publisher-written transcripts with real speaker names, so they beat anything ASR would produce. When `source` warns *no marker; verify*, skim the output before trusting it — it may be a long description rather than a transcript.

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

Then convert the .srt with `readable.ts` (see *Formatting the result* below) — auto-captions repeat themselves and need de-duplication, not a plain timestamp strip. If YouTube blocks caption downloads (bot checks), note it and move on — do not retry endlessly.

### Rung 4 — Apple Podcasts local transcript (macOS, opt-in)

Apple writes its own transcripts to a cache folder on the user's Mac. They are high quality (speaker labels, real punctuation), so this beats ASR whenever it is available. **This skill never controls the Podcasts app** — no clicking, no accessibility permissions, no screen access.

First, the user makes Apple cache the transcript, in their own hands: open the episode in Apple Podcasts → **⋯ (More) → View Transcript** → let it load. That is the only manual step, and it takes about 15 seconds.

Then pick the level of access the user is comfortable with:

**4a — user hands over one file (least access; prefer this if they hesitate).** They locate the file and give you the path; nothing else on disk is touched:

```bash
npx -y bun ${SKILL_DIR}/scripts/apple_ttml.ts --file "<path/to/file.ttml>"
```

Apple's cache uses hashed folders and opaque filenames, so finding it unaided is genuinely unpleasant. Offer `--find`, which lists the recently cached transcripts with **the opening line of each** — that is what makes an episode recognizable:

```bash
npx -y bun ${SKILL_DIR}/scripts/apple_ttml.ts --find      # list recent, with snippets
npx -y bun ${SKILL_DIR}/scripts/apple_ttml.ts --reveal 2  # show #2 in Finder
```

`--find` reads only the transcript cache folder. The user can also browse it themselves — the path is printed with every result.

**4b — automatic lookup (convenience).** Reads the Podcasts library database to map an episode URL straight to its cached file. Offer it when the user would rather not hunt for files:

```bash
npx -y bun ${SKILL_DIR}/scripts/apple_ttml.ts "<apple-podcasts-episode-url>" [--open]
```

This also answers a question no other rung can: **whether Apple has a transcript for this episode at all.** If it reports one exists but is not cached, say so and offer the steps above (with `--open` if they want the episode opened for them) — but see the warning about not over-promising. Rung 4 is opportunistic: it is excellent when Apple has already written the file, and there is no way to force the write without driving the app, which this skill does not do.

Shared options: `-o <path>`, `--format text|srt|json`, `--list`.

### Rung 5 — Transcribe the audio (opt-in, needs a key OR local compute)

Only after the rung-4 conversation above. This is the last resort: it works for every episode (and is currently the only option for Xiaoyuzhou), but it costs the most and reads the worst. **Ask the user to choose an engine:**

- `groq` — fast, free tier (~2h audio/day), needs a free API key; audio is sent to Groq.
- `local` — whisper.cpp on their machine, slower, nothing leaves the machine.

```bash
bash ${SKILL_DIR}/scripts/asr.sh "<audioUrl-from-rung-0>" -o /tmp/transcript.md \
  -t "<episode title>" -s "<episode link>" -e groq -l "<language-from-rung-0>"
```

**Take `-l` from rung 0's `language` field — never from your own impression of the show.** That field comes from the feed's declared `<language>`, or from CJK characters in the titles.

**If `language` is absent, ask the user which language the episode is in.** You are in a conversation with them; a one-line question is cheaper than a bad transcript, and they know the show. Only fall back to omitting `-l` (Whisper auto-detects) if they are not sure either. A wrong language flag is worse than no flag.

For Chinese, the script also passes a punctuation style prompt, because Whisper otherwise returns Chinese with no punctuation at all — leaving a wall of text that nothing downstream can paragraph.

Handles download, transcode, 20MB chunking, rate-limit retry, merge.

### Formatting the result

ASR output arrives as one unbroken block, and YouTube auto-captions arrive as a rolling window that repeats itself. Run either through:

```bash
npx -y bun ${SKILL_DIR}/scripts/readable.ts <file.srt|file.txt|file.md> \
  -t "<title>" -s "<source url>" -o <out.md>
```

It detects captions vs plain text, de-duplicates the rolling window, and breaks the text into paragraphs.

## Output

Always deliver a single Markdown file: `# <episode title>`, source link, duration, then the transcript as readable paragraphs (no timestamps unless the user asks). Tell the user which rung produced it.

## Privacy stance (also the README pitch)

- Rungs 0-3 touch only public endpoints. No accounts, no keys, no local file access.
- Rung 4 never controls the Podcasts app — no accessibility or screen permissions. It reads a transcript Apple already wrote to disk, and the user chooses whether to hand over a single file or allow a lookup.
- Rung 5 lets the user pick between a cloud key and fully-local compute.
