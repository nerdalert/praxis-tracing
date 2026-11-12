# Revised recorded-UI narration and caption wording

Times are relative to the first frame of the **93.766-second original UI
recording** `grid-dynamo-v1.mp4`. They are editorial windows, not final SRT
timestamps. The compiler should keep the recording at natural speed, place
each voice segment inside its visual window without overlap, then align final
captions to the actual audio.

## 00:00–00:12 — Baseline state

All three Dynamo pools are ready and idle. The Hub overlay ranks local pools;
a separate Site Gateway view includes the remote pool.

## 00:12–00:27 — No-pressure request sample

Before pressure, we send a fresh sample. The counters show requests reaching
Pool A, Pool B, and the remote pool. This is observed routing, not an
equal-share claim.

## 00:27–00:39 — Apply pressure to Pool B and remote pool

Now we load Pool B and the remote pool directly through Mocker. Frontend
active-request metrics rise while Pool A stays unpressured.

## 00:39–01:02 — Route after the metrics change

Grid receives fresh metrics and changes its scores. The Hub's published and
consumed overlay revisions match. New Site Gateway requests shift toward
Pool A; attributed counters show the chosen pool. The local overlay and
cross-site snapshot remain distinct.

## 01:02–01:22 — Release pressure

We release direct work. Pool B and the remote Frontend return toward zero
active requests. Grid waits for fresh observations before the routes count
as recovered. Now the recovery sample runs; watch the per-pool counters update
as responses arrive.

## 01:22–01:33.766 — Fresh sample after recovery

A final sample reaches all three pools again. That shows recovery, not a
guaranteed traffic share or GPU benchmark.

## Caption text policy

- Caption the **spoken words above**, not stale wording from the old five
  slides. Keep `Grid`, `Praxis`, `Dynamo`, `Frontend`, `Mocker`, `llm-d`, `EPP`,
  `SWIM`, `Pool A`, `Pool B`, and `remote pool` spelled consistently.
- Break captions at phrase boundaries; aim for at most two readable lines.
- No cue may extend beyond its corresponding narration or into the next
  section. Check the caption-safe area in the actual final render.
- If a statement about the baseline or final all-pool sample cannot be
  confirmed in the source recording, narrow the wording before generating
  voice or captions. Do not change the video to manufacture that claim.
