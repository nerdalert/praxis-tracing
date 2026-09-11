#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MEDIA_DIR="$ROOT_DIR/media"
SLIDES_DIR="$MEDIA_DIR/rendered-slides"
FITTED_DIR="$MEDIA_DIR/tts/fitted"
SOURCE_VIDEO=${SOURCE_VIDEO:-/home/ubuntu/praxxis/ai-grid/ai-files/grid-weighted-routing-sept11.mp4}
OUTPUT_DIR=${OUTPUT_DIR:-"$MEDIA_DIR/final"}
OUTPUT_VIDEO=${OUTPUT_VIDEO:-"$OUTPUT_DIR/grid-weighted-routing-demo-under-100mb.mp4"}
mkdir -p "$OUTPUT_DIR"
[[ -f "$SOURCE_VIDEO" ]] || { echo "missing source recording: $SOURCE_VIDEO" >&2; exit 1; }
[[ -f "$FITTED_DIR/closing.mp3" ]] || { echo "run fit-tts-segments.sh first" >&2; exit 1; }
"$ROOT_DIR/scripts/render-intro-slides.sh"

for index in 1 2 3 4 5 6; do
  clip="$SLIDES_DIR/slide-0${index}.mp4"
  [[ -s "$clip" ]] || { echo "missing slide clip: $clip" >&2; exit 1; }
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate \
    -of csv=p=0 "$clip" >/dev/null || { echo "invalid slide clip: $clip" >&2; exit 1; }
done

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/grid-weighted-video.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

make_silent_clip() {
  local name=$1
  local duration=$2
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0xf4f7f8:s=1920x1080:r=30" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -t "$duration" -map 0:v -map 1:a -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -ar 44100 -ac 2 "$tmp_dir/$name.mp4"
}

make_silent_clip lead-in 1
make_silent_clip gap-01 0.5
make_silent_clip gap-02 0.5
make_silent_clip gap-03 0.5
make_silent_clip gap-04 0.5
make_silent_clip gap-05 0.5
make_silent_clip demo-gap 1
make_silent_clip ending 1

# Normalize the recorded demonstration to the same stream parameters as the
# generated segments before concatenation.
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$SOURCE_VIDEO" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 44100 -ac 2 "$tmp_dir/recorded-demo.mp4"

{
  printf "file '%s'\n" "$tmp_dir/lead-in.mp4"
  for index in 1 2 3 4 5 6; do
    printf "file '%s'\n" "$SLIDES_DIR/slide-0${index}.mp4"
    if [[ "$index" -lt 6 ]]; then printf "file '%s'\n" "$tmp_dir/gap-0${index}.mp4"; fi
  done
  printf "file '%s'\n" "$tmp_dir/demo-gap.mp4"
  printf "file '%s'\n" "$tmp_dir/recorded-demo.mp4"
  printf "file '%s'\n" "$tmp_dir/closing.mp4"
  printf "file '%s'\n" "$tmp_dir/ending.mp4"
} > "$tmp_dir/concat.txt"

# Render the closing slide with its fitted narration.
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -loop 1 -framerate 30 -i "$SLIDES_DIR/slide-07.png" \
  -i "$FITTED_DIR/closing.mp3" \
  -map 0:v -map 1:a -t 30 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 44100 -ac 2 -shortest "$tmp_dir/closing.mp4"

ffmpeg -nostdin -hide_banner -loglevel error -y -f concat -safe 0 -i "$tmp_dir/concat.txt" \
  -c copy "$tmp_dir/assembled.mp4"

# Encode the assembled picture in two passes using its measured duration. Use
# constrained CBR filler so static slide sections still consume the allocated
# bitrate and dashboard text receives the available quality budget.
assembled_duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp_dir/assembled.mp4")
if ! awk -v duration="$assembled_duration" 'BEGIN { exit !(duration > 435 && duration < 437) }'; then
  echo "assembled duration is not the expected complete presentation: $assembled_duration seconds" >&2
  exit 1
fi
target_bytes=96000000
audio_bps=128000
video_bps=$(awk -v bytes="$target_bytes" -v duration="$assembled_duration" -v audio="$audio_bps" 'BEGIN { reserve=2000000; bps=((bytes-reserve)*8/duration)-audio; printf "%d", bps }')
[[ "$video_bps" -gt 500000 ]] || { echo "calculated video bitrate is too low: $video_bps" >&2; exit 1; }
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp_dir/assembled.mp4" \
  -map 0:v -c:v libx264 -b:v "${video_bps}" -minrate "${video_bps}" -maxrate "${video_bps}" \
  -bufsize "$((video_bps * 2))" -x264-params "nal-hrd=cbr:filler=1" \
  -preset slow -r 30 -pix_fmt yuv420p \
  -pass 1 -passlogfile "$tmp_dir/grid-pass" -an -f mp4 /dev/null
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp_dir/assembled.mp4" \
  -map 0:v -map 0:a -c:v libx264 -b:v "${video_bps}" -minrate "${video_bps}" -maxrate "${video_bps}" \
  -bufsize "$((video_bps * 2))" -x264-params "nal-hrd=cbr:filler=1" \
  -preset slow -r 30 -pix_fmt yuv420p \
  -pass 2 -passlogfile "$tmp_dir/grid-pass" -c:a aac -b:a "${audio_bps}" -ar 44100 -ac 2 \
  "$tmp_dir/encoded.mp4"

# Attach the complete subtitle track without burning it into the picture.
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp_dir/encoded.mp4" \
  -i "$MEDIA_DIR/weighted-routing-final.srt" -map 0 -map 1:0 \
  -c copy -c:s mov_text -metadata:s:s:0 language=eng -metadata:s:s:0 title="English narration" \
  -movflags +faststart \
  "$OUTPUT_VIDEO"

printf 'Built final video: %s (%s bytes, %s bps video target, %s sec assembled)\n' \
  "$OUTPUT_VIDEO" "$(stat -c %s "$OUTPUT_VIDEO")" "$video_bps" "$assembled_duration"
