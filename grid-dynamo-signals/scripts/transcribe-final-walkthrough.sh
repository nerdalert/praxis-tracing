#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT=${1:?usage: ./scripts/transcribe-final-walkthrough.sh /path/to/final-recording.mp4 [output-directory]}
OUTPUT_DIR=${2:-${DEMO_CAPTIONS_OUTPUT_DIR:-$ROOT/media/generated/final-walkthrough}}
TOOLKIT=${TRAFFIC_THEATER_DIR:-$ROOT/../../traffic-theater}
MODEL=${WHISPER_MODEL:-whisper-1}

[[ -f "$INPUT" ]] || { echo "recording not found: $INPUT" >&2; exit 1; }
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo 'OPENAI_API_KEY is required in the environment' >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo 'ffmpeg is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v node >/dev/null || { echo 'node is required' >&2; exit 1; }
[[ -f "$TOOLKIT/src/captions/transcription-to-srt.js" ]] || {
  echo 'Traffic Theater checkout not found; set TRAFFIC_THEATER_DIR' >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
TEMP_DIR=$(mktemp -d "$OUTPUT_DIR/.transcribe.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

ffmpeg -nostdin -v error -y -i "$INPUT" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$TEMP_DIR/recording.wav"
mean_volume=$(ffmpeg -nostdin -i "$TEMP_DIR/recording.wav" -af volumedetect -f null /dev/null 2>&1 \
  | awk '/mean_volume:/ {print $5; exit}')
[[ -n "$mean_volume" && "$mean_volume" != '-inf' ]] || {
  echo 'recording audio is silent; refusing to send it for transcription' >&2
  exit 1
}

AUTH_CONFIG="$TEMP_DIR/curl-auth.conf"
printf 'header = "Authorization: Bearer %s"\n' "$OPENAI_API_KEY" > "$AUTH_CONFIG"
chmod 600 "$AUTH_CONFIG"
unset OPENAI_API_KEY

curl --config "$AUTH_CONFIG" --fail --silent --show-error \
  https://api.openai.com/v1/audio/transcriptions \
  -F "file=@$TEMP_DIR/recording.wav" \
  -F "model=$MODEL" \
  -F 'response_format=verbose_json' \
  -o "$OUTPUT_DIR/transcription.json"

node "$TOOLKIT/src/captions/transcription-to-srt.js" \
  "$OUTPUT_DIR/transcription.json" "$OUTPUT_DIR/final-walkthrough.srt"
node "$ROOT/scripts/validate-srt.mjs" \
  "$OUTPUT_DIR/final-walkthrough.srt" --media "$INPUT"
printf 'Saved transcription and SRT under %s\n' "$OUTPUT_DIR"
