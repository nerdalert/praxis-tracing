# Audio model and caption status

## Verified from official OpenAI documentation

- **“Whisper-HD” is not listed as an Audio API transcription model ID.** The
  transcription API reference lists whisper-1, gpt-transcribe,
  gpt-4o-transcribe, gpt-4o-mini-transcribe, and diarization variants.
- tts-1-hd is a **text-to-speech generation** model. It is not a Whisper
  transcription model. The speech endpoint also lists tts-1,
  gpt-4o-mini-tts, and a dated gpt-4o-mini-tts snapshot.
- For completed audio files, the current Transcription guide recommends
  gpt-transcribe. Its recommended workflow does not promise native SRT
  output. The guide documents whisper-1 for word timestamps and SRT/VTT
  subtitles.
- OpenAI currently marks whisper-1 and the listed GPT-4o transcription
  models deprecated, with a planned shutdown on **February 26, 2027**.

References:

- [Audio transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [Transcription guide](https://developers.openai.com/api/docs/guides/transcription)
- [TTS-1 HD model](https://developers.openai.com/api/docs/models/tts-1-hd)
- [Audio speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)

## Account verification and selection

The account's `/v1/models` endpoint was queried at
`2026-11-08T23:10:20.290Z`. The filtered model list is preserved in
[`../locks/audio-models.json`](../locks/audio-models.json); it contains model
IDs only and no key. It lists `whisper-1`, `tts-1-hd`, and
`gpt-4o-mini-tts`. It does not list a `Whisper-HD` model ID. The similarly
named `tts-1-hd` is available for voice generation, not transcription. This
is a historical account check; recheck the account after the authorized key
is rotated and before making another API call.

## Media generated for this package

On November 9, 2026, the reviewed narration was generated with
`gpt-4o-mini-tts` and voice `marin`. Word-timed SRT captions were transcribed
from those WAV tracks with `whisper-1`. Both API calls succeeded for this
account. The dated account model list above remains the November 8 query; it is
not represented as a fresh `/v1/models` check.

The five slide WAVs and timestamped UI voice track are published under
`media/audio/`; reviewed SRT source is under `media/captions/`. Narration text
is the source of truth; Whisper supplies word timings. The caption builder maps
source words to those timestamps, logs spelling differences, and requires the
timestamped word count to match. If voiceover changes, regenerate and review
its captions. The preview mix is normalized to -18 LUFS with -4 dBTP headroom
before AAC encoding.

The current TTS guide lists the `gpt-4o-mini-tts` endpoint and built-in voices;
its published shutdown date is January 6, 2027. The speech-to-text guide lists
`whisper-1` word timestamps and SRT/VTT output and gives February 26, 2027 as
its planned shutdown date. Recheck before future generation after either date.

References: [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech),
[speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text).
