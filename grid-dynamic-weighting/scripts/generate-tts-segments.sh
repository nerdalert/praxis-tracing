#!/usr/bin/env bash
set -euo pipefail

# Generate local, reviewable TTS segments. The API key must be supplied by the
# caller; it is deliberately never read from a repository file or written to
# output. Generated audio is ignored by the demo repository.
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY in the invoking process}"

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRT_FILE=${SRT_FILE:-"$ROOT_DIR/media/weighted-routing-intro.srt"}
CLOSING_FILE=${CLOSING_FILE:-"$ROOT_DIR/media/tts/closing.txt"}
OUTPUT_DIR=${OUTPUT_DIR:-"$ROOT_DIR/media/tts/generated"}
MODEL=${TTS_MODEL:-tts-1-hd}
VOICE=${TTS_VOICE:-alloy}

command -v curl >/dev/null
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
mkdir -p "$OUTPUT_DIR"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/grid-weighted-tts.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

python3 - "$SRT_FILE" "$tmp_dir" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text()
target = pathlib.Path(sys.argv[2])
for block in re.split(r"\n\s*\n", source.strip()):
    lines = block.splitlines()
    if len(lines) < 3 or "-->" not in lines[1]:
        continue
    index = int(lines[0])
    text = " ".join(line.strip() for line in lines[2:] if line.strip())
    target.joinpath(f"slide-{index:02d}.txt").write_text(text + "\n")
PY
cp "$CLOSING_FILE" "$tmp_dir/closing.txt"

generate_segment() {
  local name=$1
  local text_file=$2
  local raw_file="$tmp_dir/$name.raw.mp3"
  local output_file="$OUTPUT_DIR/$name.mp3"

  curl --fail --silent --show-error \
    https://api.openai.com/v1/audio/speech \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg model "$MODEL" --arg voice "$VOICE" --arg input "$(<"$text_file")" \
      '{model:$model, voice:$voice, input:$input, response_format:"mp3"}')" \
    --output "$raw_file"

  local duration
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$raw_file")
  jq -n --arg name "$name" --arg duration "$duration" --arg model "$MODEL" --arg voice "$VOICE" \
    '{segment:$name, generated_duration_seconds:($duration|tonumber), model:$model, voice:$voice}' \
    > "$OUTPUT_DIR/$name.metadata.json"

  # The source SRT provides the timing contract. Generated clips are kept as
  # individual files; duration metadata is recorded for a later mux pass.
  mv "$raw_file" "$output_file"
}

for text_file in "$tmp_dir"/slide-*.txt; do
  name=$(basename "$text_file" .txt)
  generate_segment "$name" "$text_file"
done
generate_segment closing "$tmp_dir/closing.txt"

printf 'Generated %s TTS segments in %s\n' "$(find "$OUTPUT_DIR" -name '*.mp3' | wc -l)" "$OUTPUT_DIR"
