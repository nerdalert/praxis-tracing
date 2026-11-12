# Narration, captions, and local preview

The editable sources define six introduction slides, six timed UI narration
sections, one exit narration, and reviewed caption wording:

- media/slides/deck.html
- media/narration/intro-script.md
- media/narration/ui-walkthrough-script.md
- media/narration/outro-script.md
- media/captions/caption-copy.md

One gpt-4o-mini-tts voice (marin) narrates all sections. whisper-1 supplies
word timestamps from the generated audio; caption text and punctuation come
from caption-copy.md. The model check queries the account's available models
and reports only whether the configured speech and transcription model IDs
are available.

Set OPENAI_API_KEY in the local environment without putting its value in a
command, file, or log. Render and build with the historical 93.766-second
source UI capture:

    npm run verify:audio-models
    npm run render:slides -- --output media/generated/slides/1920x1080
    npm run generate:narration:intro
    npm run generate:narration:ui
    npm run generate:narration:outro
    npm run generate:captions:intro
    npm run generate:captions:ui
    npm run generate:captions:outro
    npm run build:preview -- \
      --ui /path/to/grid-dynamo-v1.mp4 \
      --output /path/to/local-output
    npm run validate:srt -- \
      /path/to/local-output/grid-dynamo-signals-final.srt \
      --media /path/to/local-output/grid-dynamo-signals-final.mp4
    npm run export:media -- --preview-dir \
      /path/to/local-output

The builder checks that approved caption words match the narration, aligns
cues to Whisper's word times, and fails if a cue crosses a slide or UI section
boundary. It places each voice clip exactly once in visual order; it does not
mix tracks, add music, or add a second narration. UI speech stays inside the
six editorial windows and the recording stays at its native speed. The video
has one voice stream, one English soft-caption stream, and a matching sidecar
SRT. A caption-safe band is reserved on the slides and in the UI letterbox.
The first frame shows slide one. Its narration starts after a one-second pause;
the cut ends with two seconds of black.

media/generated is ignored and holds local intermediate audio, transcripts,
and rendered frames. The final video, WAV, SRT, preview manifest, source
recording copy, and exported editable sources are written outside the
checkout. The tracked media/audio files are legacy assets and are not inputs
to this revised build.
