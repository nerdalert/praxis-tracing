# Narration, captions, and local preview

The five slide voiceovers and nine timecoded UI voiceover sections come from
the editable scripts in `media/narration/`. Narration is generated with the
`gpt-4o-mini-tts` API and voice `marin`; captions use `whisper-1` word timing.
Slide one discloses AI-generated narration.

Generate, transcribe, review, and assemble the local preview with the supplied
historical UI recording:

```bash
OPENAI_API_KEY=... npm run generate:narration:intro
OPENAI_API_KEY=... npm run generate:narration:ui
OPENAI_API_KEY=... npm run generate:captions:intro
OPENAI_API_KEY=... npm run generate:captions:ui
npm run build:preview -- --ui /path/to/grid-dynamo-v1.mp4 --output /local/preview
npm run export:media -- --ui /path/to/grid-dynamo-v1.mp4
npm run validate:srt -- /local/preview/grid-dynamo-signals-preview.srt \
  --media /local/preview/grid-dynamo-signals-preview.mp4
```

Whisper supplies word timings; the exact narration script supplies caption
text and punctuation. The timing script maps the source words onto Whisper's
ordered timestamps, reports recognition spelling differences, and fails if
the timestamped word count differs from the script. To rebuild captions from
a saved Whisper response without another API request, pass `--reuse-json` to
the transcription script.

The MP4 contains an English soft-caption track, and the SRT remains available
beside it. The builder aligns UI speech and captions to the source timecodes,
preserves video and speech speed, and fails if a spoken section exceeds its
window. It normalizes the full preview mix to -18 LUFS with -4 dBTP headroom
before AAC encoding and adds two seconds of silent black at the beginning and
end. `npm run export:media` extracts the reviewed WAV tracks
from that normalized mix and writes SRT source assets into `media/audio/` and
`media/captions/`. Keep the source recording, generated intermediates, and
preview MP4 outside Git.
