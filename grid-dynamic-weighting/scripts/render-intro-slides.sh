#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT_DIR=${OUTPUT_DIR:-"$ROOT_DIR/media/rendered-slides"}
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$OUTPUT_DIR" node "$ROOT_DIR/scripts/render-slide-images.mjs"

for duration in 27 31 30.5 32 34.5 29.5; do :; done
durations=(27 31 30.5 32 34.5 29.5)
for index in 1 2 3 4 5 6; do
  image_file="$OUTPUT_DIR/slide-0${index}.png"
  output="$OUTPUT_DIR/slide-0${index}.mp4"
  duration=${durations[$((index - 1))]}
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -loop 1 -framerate 30 -i "$image_file" \
    -i "$ROOT_DIR/media/tts/fitted/slide-0${index}.mp3" \
    -map 0:v -map 1:a -t "$duration" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -ar 44100 -ac 2 -shortest "$output"
done
