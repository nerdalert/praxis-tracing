#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INPUT_DIR=${INPUT_DIR:-"$ROOT_DIR/media/tts/generated"}
OUTPUT_DIR=${OUTPUT_DIR:-"$ROOT_DIR/media/tts/fitted"}
mkdir -p "$OUTPUT_DIR"
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/grid-weighted-tts-fit.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

python3 - "$ROOT_DIR/media/weighted-routing-intro.srt" "$tmp_dir/targets.tsv" <<'PY'
import pathlib
import re
import sys

def seconds(value):
    hours, minutes, rest = value.split(":")
    secs, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(secs) + int(millis) / 1000

source = pathlib.Path(sys.argv[1]).read_text()
target = pathlib.Path(sys.argv[2])
rows = []
for block in re.split(r"\n\s*\n", source.strip()):
    lines = block.splitlines()
    if len(lines) >= 2 and "-->" in lines[1]:
        index = int(lines[0])
        start, end = (part.strip() for part in lines[1].split("-->"))
        rows.append((f"slide-{index:02d}", seconds(end) - seconds(start)))
rows.append(("closing", 30.0))
target.write_text("\n".join(f"{name}\t{duration:.3f}" for name, duration in rows) + "\n")
PY

while IFS=$'\t' read -r name target_seconds; do
  input="$INPUT_DIR/$name.mp3"
  output="$OUTPUT_DIR/$name.mp3"
  [[ -f "$input" ]] || { echo "missing generated segment: $input" >&2; exit 1; }
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$input")
  if awk "BEGIN { exit !($duration > $target_seconds + 0.05) }"; then
    echo "$name is longer than its SRT interval ($duration > $target_seconds)" >&2
    exit 1
  fi
  ffmpeg -nostdin -hide_banner -loglevel error -y -i "$input" \
    -af "apad=pad_dur=$target_seconds" -t "$target_seconds" \
    -c:a libmp3lame -q:a 2 "$output"
done < "$tmp_dir/targets.tsv"

# Explicit one-second lead-in and ending silence for the assembled narration.
ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=44100:cl=mono \
  -t 1 -c:a libmp3lame -q:a 2 "$OUTPUT_DIR/lead-in-silence.mp3"
ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=44100:cl=mono \
  -t 1 -c:a libmp3lame -q:a 2 "$OUTPUT_DIR/ending-silence.mp3"

printf 'Fitted narration segments in %s\n' "$OUTPUT_DIR"
