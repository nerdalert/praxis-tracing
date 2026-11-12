# Recording handoff

## Current state

The UI source and recording script are present, but this checkout does not
currently contain a provisioned two-site runtime. The earlier run-owned Kind
clusters were removed. A loopback URL by itself is not proof that the API is
serving current signals.

`./scripts/start-ui.sh` builds the frontend and starts the run-owned UI only
after private kubeconfigs and `state/private/demo-config.json` exist. In this
checkout the provisioning script it names, `scripts/provision-live.sh`, is not
included. The live UI startup path is therefore incomplete here. Do not record
until a fresh run-owned setup exists and `./scripts/check-live-readiness.sh`
passes.

The intended local URL is **http://127.0.0.1:4177** after a verified startup.
The supplied source clip `grid-dynamo-v1.mp4` is a silent 93.766-second
1920×1080 historical recording; it is not a current deployment. The revised
local preview combines six narrated introduction slides, a time-aligned UI
voiceover, a narrated exit slide, and reviewed captions. Keep the source clip
and preview MP4 outside Git. The user will handle any later edit or upload.

## Dashboard and claims

The Dynamo page adapts the familiar static/weighted demo presentation while
using a Dynamo-specific component and backend. It shows actual Frontend
`model_ready` and `active_requests`, operator candidate score and rank, local
overlay revisions, Gateway-consumed revisions, and the attribution the route
actually emits. Pressure begins only when a presenter clicks a pool's
**Generate pressure** control. The page itself does not start pressure in the
background.

Pool A and Pool B are independent Frontend + Mocker Pods in the Hub Kind site.
The Remote Pool is in the separate Site Kind site. The Hub local Gateway
consumes the A/B overlay. The Site Gateway uses a separate cross-site snapshot
that includes the Remote Pool. Dynamo Frontend chooses its Mocker worker; Grid
chooses a pool or site from the signals it receives.

The observed active-request gauge is a plain count. Four is the demo's
configured comparison reference and pressure-test concurrency; it is not a
Dynamo queue limit, Mocker replica count, or measured serving capacity. Mocker
responses are synthetic. The demo does not prove GPU saturation, model
quality, weighted-share precision, or live SWIM behavior. The optional failure
control is a **signal endpoint interruption**, not a network ACL test.

The Hub local route may omit attribution headers. Identify its selected pool
only from the unique Gateway request-counter delta. For the Site Gateway,
show site, provider-site, or backend only when those headers are actually
present on the response.

## Historical qualification

The saved full Playwright run is historical. It used Grid commit
`0fc905dfae058e5c54ddebdc384e345fbfecc1a4`, Grid source-state SHA-256
`c7bc7a45c371ea7503dda53ef39cee65700d359921f3f9dbafaed9840ff91df2`, and
the Dynamo planner image
`nvcr.io/nvidia/ai-dynamo/dynamo-planner@sha256:f69ac8f2165289e0f9d06aa125fac8bda3a401b42f640235fca28b0c852b9875`
(`linux/amd64`). The saved qualification recorded three passing Playwright
tests, pressure and recovery, candidate-scope checks at 1440×900 and 900×768,
and signal endpoint interruption and restoration. The exact source lock and
result live in the task evidence bundle; they are not a current deployment.

The currently packaged `app/server.mjs` SHA-256 is
`588abe451cf46058197165b74548de8f61c367244e87ad6b6f44f54afad845c5`, which
differs from the server file hash in that historical Playwright lock. No live
E2E result is claimed for this exact packaged backend source. The UI build and
static asset checks are separate gates.

## Local preview captions

The revised preview's SRT wording comes from the approved copy in
`media/captions/caption-copy.md`; its cue timestamps are aligned to word-level
transcription of each generated voice section. The editable narration and
caption copy are in `media/narration/` and `media/captions/`. To rebuild the
local preview from generated narration and the source UI file, run the steps in
`media/captions/README.md`.

If narration changes during the user's edit, regenerate captions from the
final audio track rather than reusing timings from the earlier voiceover. The
existing final-audio helper accepts a path to the edited recording:

```sh
./scripts/transcribe-final-walkthrough.sh /path/to/final-recording.mp4
```

The script extracts audio locally and sends only the WAV audio to the
transcription endpoint. It preserves the transcription JSON and SRT locally
and validates cue ordering and duration. It never uploads the video. Review
technical terms against the recording without adding words that were not
spoken. `whisper-1` creates captions; it does not generate narration audio.

The narration and caption pipeline is documented in
[`AUDIO-MODEL-STATUS.md`](AUDIO-MODEL-STATUS.md) and the companion
Traffic Theater example. The current historical-run qualification remains
explicitly dated and is not a gate for source-asset or local-preview handoff.
