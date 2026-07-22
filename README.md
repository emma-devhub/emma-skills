# emma-skills

Agent Skills for Claude Code / Codex, built for daily real-world use. Zero-permission paths first: no skill here requires local app access, accounts, or API keys unless you explicitly opt in.

| Skill | What it does |
|---|---|
| [emma-podcast-transcript](skills/emma-podcast-transcript/) | Any podcast link (Apple Podcasts, 小宇宙/Xiaoyuzhou, RSS, YouTube) → clean Markdown transcript, via a 5-rung source ladder that tries published transcripts, show notes, and YouTube captions before ever touching your files or an API key. |

## Install

```bash
npx skills add emma-devhub/emma-skills
```

Or copy a skill folder into `~/.claude/skills/`.

## License

MIT
