#!/bin/bash
# asr.sh — rung 5 of the transcript ladder (last resort): audio -> text.
# Engine is the user's choice: Groq Whisper API (fast, free tier, needs a key)
# or local whisper.cpp (slower, nothing leaves the machine).
#
# Usage: bash asr.sh <audio-url-or-file> [-o output.md] [-t "Title"] [-l language] [-e groq|local] [-s source-url]
# Deps:  curl, ffmpeg; whisper-cli for -e local.

set -e

AUDIO="${1:?usage: bash asr.sh <audio-url-or-file> [-o out.md] [-t title] [-l lang] [-e groq|local] [-s source-url]}"
shift
OUTPUT="/tmp/podcast_transcript.md"
TITLE="Podcast transcript"
LANGUAGE=""
ENGINE="groq"
SOURCE=""
while getopts "o:t:l:e:s:" opt; do
  case $opt in
    o) OUTPUT="$OPTARG" ;;
    t) TITLE="$OPTARG" ;;
    l) LANGUAGE="$OPTARG" ;;
    e) ENGINE="$OPTARG" ;;
    s) SOURCE="$OPTARG" ;;
    *) exit 1 ;;
  esac
done

TMPDIR_WORK="$(mktemp -d /tmp/podcast_asr.XXXXXX)"
cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAX_CHUNK_SIZE_MB=20
AUDIO_BITRATE="64k"

# --- fetch ---
if [ -f "$AUDIO" ]; then
  cp "$AUDIO" "$TMPDIR_WORK/original"
else
  echo "downloading audio..."
  curl -sL -A "Mozilla/5.0" -o "$TMPDIR_WORK/original" "$AUDIO"
fi

DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$TMPDIR_WORK/original" 2>/dev/null | cut -d. -f1)
echo "duration: $((DURATION / 60))m$((DURATION % 60))s"

echo "transcoding to mono ${AUDIO_BITRATE} mp3..."
ffmpeg -y -i "$TMPDIR_WORK/original" -b:a "$AUDIO_BITRATE" -ac 1 "$TMPDIR_WORK/mono.mp3" 2>/dev/null
MONO_SIZE=$(stat -f%z "$TMPDIR_WORK/mono.mp3" 2>/dev/null || stat -c%s "$TMPDIR_WORK/mono.mp3")

# --- local engine: whisper.cpp, no chunking needed ---
if [ "$ENGINE" = "local" ]; then
  command -v whisper-cli >/dev/null || {
    echo "whisper-cli not found. Install: brew install whisper-cpp, then download a model (e.g. ggml-large-v3-turbo)."
    exit 1
  }
  MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper/ggml-large-v3-turbo.bin}"
  [ -f "$MODEL" ] || { echo "model not found at $MODEL (set WHISPER_MODEL to override)"; exit 1; }
  echo "transcribing locally (whisper.cpp)..."
  LANG_ARGS=""
  [ -n "$LANGUAGE" ] && LANG_ARGS="-l $LANGUAGE"
  whisper-cli -m "$MODEL" $LANG_ARGS -np -nt -f "$TMPDIR_WORK/mono.mp3" > "$TMPDIR_WORK/transcript_0.txt"
  NUM_CHUNKS=1
else
  # --- Groq engine ---
  # Key precedence: env var > skill config file. Never committed anywhere.
  CONFIG_FILE="$SKILL_DIR/config/groq_api_key"
  if [ -z "$GROQ_API_KEY" ] && [ -f "$CONFIG_FILE" ]; then
    GROQ_API_KEY=$(tr -d '[:space:]' < "$CONFIG_FILE")
  fi
  GROQ_API_KEY="${GROQ_API_KEY:?Set GROQ_API_KEY (free key: https://console.groq.com/keys) or write it to $CONFIG_FILE. For a no-key path, rerun with -e local.}"

  MAX_BYTES=$((MAX_CHUNK_SIZE_MB * 1024 * 1024))
  if [ "$MONO_SIZE" -le "$MAX_BYTES" ]; then
    cp "$TMPDIR_WORK/mono.mp3" "$TMPDIR_WORK/chunk_0.mp3"
    NUM_CHUNKS=1
  else
    NUM_CHUNKS=$(( (MONO_SIZE / MAX_BYTES) + 1 ))
    CHUNK_DURATION=$(( DURATION / NUM_CHUNKS + 10 ))
    echo "splitting into $NUM_CHUNKS chunks..."
    for i in $(seq 0 $((NUM_CHUNKS - 1))); do
      ffmpeg -y -i "$TMPDIR_WORK/mono.mp3" -ss $((i * CHUNK_DURATION)) -t "$CHUNK_DURATION" -c copy "$TMPDIR_WORK/chunk_${i}.mp3" 2>/dev/null
    done
  fi

  # Whisper drops punctuation entirely for Chinese unless the prompt shows it
  # what punctuated output looks like. Without this the transcript is one
  # unbroken wall of characters that nothing downstream can paragraph.
  STYLE_PROMPT=""
  case "$LANGUAGE" in
    zh*) STYLE_PROMPT="以下是一段普通话播客的转录，请使用标准中文标点符号。例如：今天我们聊一聊宏观经济、利率走势，以及市场的反应。" ;;
  esac

  transcribe_chunk() {
    local chunk_file="$1" response http_code body
    local lang_form=()
    [ -n "$LANGUAGE" ] && lang_form=(-F "language=$LANGUAGE")
    [ -n "$STYLE_PROMPT" ] && lang_form+=(-F "prompt=$STYLE_PROMPT")
    response=$(curl -s -w "\n%{http_code}" \
      https://api.groq.com/openai/v1/audio/transcriptions \
      -H "Authorization: Bearer $GROQ_API_KEY" \
      -F "file=@$chunk_file" \
      -F "model=whisper-large-v3" \
      "${lang_form[@]}" \
      -F "response_format=text")
    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')
    if [ "$http_code" = "429" ]; then
      WAIT_MIN=$(echo "$body" | grep -oE 'in [0-9]+m' | grep -oE '[0-9]+' | head -1)
      WAIT_SEC=$(( ${WAIT_MIN:-2} * 60 + 30 ))
      echo "   rate limited, retrying in ${WAIT_SEC}s..." >&2
      sleep "$WAIT_SEC"
      response=$(curl -s -w "\n%{http_code}" \
        https://api.groq.com/openai/v1/audio/transcriptions \
        -H "Authorization: Bearer $GROQ_API_KEY" \
        -F "file=@$chunk_file" \
        -F "model=whisper-large-v3" \
        "${lang_form[@]}" \
        -F "response_format=text")
      http_code=$(echo "$response" | tail -1)
      body=$(echo "$response" | sed '$d')
    fi
    [ "$http_code" != "200" ] && { echo "Groq API error (HTTP $http_code): $body" >&2; exit 1; }
    echo "$body"
  }

  echo "transcribing (Groq whisper-large-v3)..."
  for i in $(seq 0 $((NUM_CHUNKS - 1))); do
    echo "   chunk $((i+1))/$NUM_CHUNKS..."
    transcribe_chunk "$TMPDIR_WORK/chunk_${i}.mp3" > "$TMPDIR_WORK/transcript_${i}.txt"
  done
fi

# --- merge ---
{
  echo "# $TITLE"
  echo ""
  [ -n "$SOURCE" ] && echo "Source: $SOURCE"
  echo "Duration: $((DURATION / 60))m$((DURATION % 60))s"
  echo "Transcribed: $(date '+%Y-%m-%d %H:%M') (engine: $ENGINE)"
  echo ""
  echo "---"
  echo ""
  for i in $(seq 0 $((NUM_CHUNKS - 1))); do
    cat "$TMPDIR_WORK/transcript_${i}.txt"
    echo ""
  done
} > "$OUTPUT"

echo "done: $OUTPUT ($(wc -m < "$OUTPUT") chars)"
