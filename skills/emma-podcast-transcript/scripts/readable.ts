#!/usr/bin/env bun
// readable.ts — turn raw transcript material into a readable Markdown transcript.
//
// Two inputs, detected automatically:
//   • Captions (.srt/.vtt). YouTube auto-captions arrive as a rolling window —
//     each cue repeats the tail of the previous one and adds a few new words, so
//     naive concatenation triples the text. We merge by finding the longest
//     overlap between what we have and each incoming cue, appending only the
//     remainder. Paragraphs break on pauses.
//   • Plain text (ASR output). Whisper returns one unbroken wall of text.
//     We group it into paragraphs by sentence.
//
// Usage: bun readable.ts <file> [-t "Title"] [-s <source-url>] [-o out.md]
//        [--paragraph-gap <seconds>]   captions: new paragraph after a pause (default 2.5)
//        [--sentences <n>]             plain text: sentences per paragraph (default 5)

import { readFileSync, writeFileSync } from "fs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("-"));
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!file) {
  console.error(`usage: bun readable.ts <file.srt|file.vtt|file.txt> [-t "Title"] [-s <url>] [-o out.md]`);
  console.error(`       [--paragraph-gap <sec>]  captions: paragraph break after a pause (default 2.5)`);
  console.error(`       [--sentences <n>]        plain text: sentences per paragraph (default 5)`);
  process.exit(1);
}

const title = flag("-t");
const source = flag("-s");
const out = flag("-o");
const gapSec = parseFloat(flag("--paragraph-gap") ?? "2.5");
const perPara = parseInt(flag("--sentences") ?? "5", 10);

type Cue = { start: number; end: number; text: string };

function toSeconds(ts: string): number {
  const m = ts.trim().replace(",", ".").match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0", 10) * 3600) + (parseInt(m[2], 10) * 60) + parseFloat(m[3]);
}

function parseCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  // Works for both SRT blocks and WebVTT cues.
  const blocks = raw.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/, "").split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx === -1) continue;
    const [from, to] = lines[tIdx].split("-->");
    const text = lines
      .slice(tIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")          // inline karaoke timing tags
      .replace(/\[[^\]]*\]/g, " ")      // [Music], [Applause]
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start: toSeconds(from), end: toSeconds(to), text });
  }
  return cues;
}

/** Longest suffix of `acc` that is also a prefix of `next`, measured in words. */
function overlapWords(acc: string[], next: string[]): number {
  const max = Math.min(acc.length, next.length, 40);
  for (let n = max; n > 0; n--) {
    let same = true;
    for (let i = 0; i < n; i++) {
      if (acc[acc.length - n + i].toLowerCase() !== next[i].toLowerCase()) {
        same = false;
        break;
      }
    }
    if (same) return n;
  }
  return 0;
}

/** Group an unbroken block of ASR text into paragraphs, N sentences each. */
function paragraphsFromText(raw: string, n: number): string[] {
  // Drop a header we (or asr.sh) previously wrote, so this is safe to re-run.
  const afterRule = raw.split(/\n---\n/);
  let body = (afterRule.length > 1 ? afterRule.slice(1).join("\n---\n") : raw).trim();
  body = body.replace(/\s+/g, " ").trim();

  // Split only where a sentence really ends: punctuation, then whitespace, then
  // something that starts a new sentence. This leaves decimals ("0.02%", no
  // space) and CJK text alone. Abbreviations like "U.S. Economist" are stitched
  // back together afterwards.
  const ABBREV = /(?:\b[A-Z]|\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|Inc|Ltd|Co|Jr|Sr|No|Fig|approx))\.$/;
  const parts = body.split(/(?<=[.!?。！？]["'”’)]*)\s+(?=["'“(]?[A-Z一-鿿])/);
  const sentences: string[] = [];
  for (const part of parts) {
    const prev = sentences[sentences.length - 1];
    if (prev && ABBREV.test(prev.trim())) sentences[sentences.length - 1] = `${prev} ${part}`;
    else sentences.push(part);
  }
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += n) {
    const p = sentences.slice(i, i + n).join(" ").replace(/\s+/g, " ").trim();
    if (p) paras.push(p);
  }
  return paras;
}

const rawInput = readFileSync(file, "utf8");
const isCaptions = rawInput.includes("-->");

let paragraphs: string[] = [];

if (isCaptions) {
  const cues = parseCues(rawInput);
  if (cues.length === 0) {
    console.error(`No caption cues found in ${file}.`);
    process.exit(1);
  }
  let words: string[] = [];
  let prevEnd = cues[0].start;
  for (const cue of cues) {
    const incoming = cue.text.split(/\s+/).filter(Boolean);
    if (incoming.length === 0) continue;
    // A pause long enough to read as a beat starts a new paragraph.
    if (words.length > 0 && cue.start - prevEnd > gapSec) {
      paragraphs.push(words.join(" "));
      words = [];
    }
    const skip = overlapWords(words, incoming);
    words.push(...incoming.slice(skip));
    prevEnd = cue.end;
  }
  if (words.length) paragraphs.push(words.join(" "));
} else {
  paragraphs = paragraphsFromText(rawInput, perPara);
  if (paragraphs.length === 0) {
    console.error(`Nothing to format in ${file}.`);
    process.exit(1);
  }
}

// Auto-captions have no sentence punctuation; keep paragraphs from becoming walls.
const MAX_WORDS = isCaptions ? 160 : Infinity;
const wrapped = paragraphs.flatMap((p) => {
  const w = p.split(" ");
  if (w.length <= MAX_WORDS) return [p];
  const chunks: string[] = [];
  for (let i = 0; i < w.length; i += MAX_WORDS) chunks.push(w.slice(i, i + MAX_WORDS).join(" "));
  return chunks;
});

const head: string[] = [];
if (title) head.push(`# ${title}`, "");
if (source) head.push(`Source: ${source}`);
head.push(`${isCaptions ? "Captions" : "Source file"}: ${file.split("/").pop()}`, "", "---", "");

const md = head.join("\n") + wrapped.join("\n\n") + "\n";

if (out) {
  writeFileSync(out, md, "utf8");
  console.error(`Wrote ${out} — ${wrapped.length} paragraphs, ${md.length} chars.`);
} else {
  console.log(md);
}
