# Recorded UI walkthrough narration

This narration follows the supplied 93.766-second screen recording. The UI
recording is from the run shown in its badge: `20261108T214611Z`. Its `LIVE`
labels describe the capture time. They do not describe a current deployment.
The script avoids claims about values or actions that are not visible in the
recording.

## 00:00–00:12 — Baseline

Three Dynamo Frontends are ready: Pool A and Pool B at Hub, Remote Pool at
Site. Hub ranks locally; Site Gateway includes Remote Pool in a separate
snapshot.

## 00:12–00:25 — New requests

The Site Gateway sample is underway. Each card separates its cumulative
request counter from requests attributed to this sample. This is an observed
outcome, not a weighted-share test.

## 00:27–00:30 — Pool B pressure starts

Pool B pressure begins.

## 00:30–00:39 — Pressure appears

Pool B reaches four active requests. Remote pressure begins next; four is the
comparison reference.

## 00:39–01:02 — Route sample under pressure

As the Site Gateway sample advances, requests are attributed to Pool A while
Pool B and Remote Pool remain at zero. The Hub's published and consumed
revisions match.

## 01:02–01:06 — Remote Pool release begins

Remote Pool pressure is active; recovery begins.

## 01:06–01:20 — Release and recovery

Remote Pool returns with a fresh zero-active signal. Scores and counters stay
visible. This remains the historical capture.

## 01:23–01:30 — Final sample in progress

The final sample is still running. Counts follow response attribution.

## 01:30–01:33.766 — Completed sample

Eighteen valid responses; all pools idle.
