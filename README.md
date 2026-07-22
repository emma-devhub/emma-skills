# emma-skills

Agent Skills for Claude Code / Codex, built for daily real-world use. Zero-permission paths first: no skill here requires local app access, accounts, or API keys unless you explicitly opt in.

| Skill | What it does |
|---|---|
| [emma-podcast-transcript](skills/emma-podcast-transcript/) | Any podcast link (Apple Podcasts, 小宇宙/Xiaoyuzhou, RSS, YouTube) → clean Markdown transcript, via a 5-rung source ladder that tries published transcripts, show notes, and YouTube captions before ever touching your files or an API key. |

### What the ladder actually hits

Honest expectations, measured on real episodes rather than assumed:

1. **`podcast:transcript` tag in the RSS feed** — free and instant, but only about 1% of shows publish one.
2. **Transcript pasted into the show notes** — no tag, whole transcript in the episode description. Common for institutional shows (banks, consultancies, research desks), and it is the publisher's own transcript with real speaker names.
3. **YouTube captions** — high hit rate, since most shows cross-post. Usually auto-generated, so quality is ASR-grade and the rolling-window duplication has to be undone.
4. **Apple Podcasts' local transcript (macOS)** — excellent when Apple has already written the file to your Mac. **Opportunistic:** Apple decides when to save it, viewing the transcript in the app does not reliably trigger a save, and this skill will not drive the app to force one. Never required, always your choice how much access to give.
5. **Transcribing the audio** — always works, costs the most, reads the worst.

## Install

```bash
npx skills add emma-devhub/emma-skills
```

Or copy a skill folder into `~/.claude/skills/`.

## License

MIT
