# Grid × Dynamo revised introduction: spoken text

Use each numbered section as one slide voice segment. The compiler must time
the slide to its **actual** generated narration and then derive SRT timestamps
from the final audio. These words are the intended caption text; punctuation
may be adjusted for short readable cues, but technical terms must remain.

## Slide 1 — What Grid does

Grid connects one model endpoint to serving pools across sites. It tracks
which providers are usable, evaluates routing policy and current signals, and
publishes a versioned routing view. The Gateway uses that view to choose the
next destination; it does not scrape a model on every request.

## Slide 2 — Operators, peers, and SWIM

Grid operators reconcile provider inventory, trust, signals, and routing
state. SWIM is one way sites can discover and exchange membership. In this
recording, the two sites instead use declared peers and secure signal polling.
The recording does not demonstrate live SWIM. The Gateway serves requests
from the latest accepted routing state.

## Slide 3 — Praxis and the decision inputs

Praxis is the request-serving Gateway. Grid supplies candidate state for its
routing filters. Think of the inputs in three buckets: eligibility, such as
readiness, health, trust, and freshness; pressure, such as queue depth,
KV-cache use, or active requests; and policy, such as region, locality,
affinity, and configured capacity. Different serving frameworks expose
different measurements. Only configured, comparable inputs influence a given
decision.

## Slide 4 — llm-d as one serving framework

With llm-d, an Endpoint Picker, or EPP, chooses a worker within a pool. Its
signals can include waiting requests, KV-cache utilization, and endpoint
readiness. Grid can use those pool observations to choose between sites or
pools. This slide explains another supported integration; the recording that
follows uses Dynamo, not llm-d.

## Slide 5 — Dynamo: ready is not idle

A Dynamo pool can be ready to serve and still be busy. In this demo, each pool
has a dedicated Frontend and Mocker. The Frontend reports model readiness and
its active request count. Grid checks freshness and compares active work with
a configured reference of four. The stage gauges give more detail, but they
are not llm-d queues or GPU utilization. Mocker returns synthetic responses.

## Slide 6 — What you are about to see

First, we send a request sample with no pool under pressure and observe
requests reaching all three pools. Then we load Pool B and the remote pool.
Their Dynamo Frontend active-request metrics rise; Grid updates its routing
view, and the next sample favors unpressured Pool A. Finally, we release the
load and send another sample. All three pools appear again. The recording
shows a routing shift, not an equal-share guarantee.

## Voice direction

- Clear, conversational technical narration. Leave a short pause after each
  slide's first sentence and before switching to the recorded UI.
- Pronounce “llm-d” as “L-L-M-D”, “EPP” as “E-P-P”, “SWIM” as “swim”, and
  “Praxis” as “PRAK-sis”.
- Keep the same voice and loudness across introduction, UI walkthrough, and
  outro. Do not add overlapping voice tracks or music under technical speech.
- The on-screen slide content is a visual aid, not a transcript. Use the text
  above as the voice and caption source.
