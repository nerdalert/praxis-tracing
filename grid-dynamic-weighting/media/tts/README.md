# TTS narration

Narration uses the OpenAI Speech API with model `tts-1-hd` and voice `alloy`.
The generator creates one segment for each introductory slide and one closing
segment. The fitter pads each segment to its SRT interval and creates explicit
one-second lead-in and ending silence files.

The API key is supplied only by the invoking process:

```console
export OPENAI_API_KEY="$(< ~/rhoai/oai-key)"
./scripts/generate-tts-segments.sh
unset OPENAI_API_KEY
./scripts/fit-tts-segments.sh
```

Generated audio and duration metadata are ignored. The narration source is
the checked-in SRT and `closing.txt`; no key, request header, or shell trace
containing the key belongs in the repository or evidence. Review segment
durations with `ffprobe` before assembling the final video.
