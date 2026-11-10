# Five-slide introduction narration

## Slide 1 — Signals change where the next request goes

This presentation uses AI-generated narration. A pool can be ready and still be busy. Dynamo Frontend reports readiness and active requests. Grid uses those signals to change how it ranks serving pools, and a new request shows the route it took.

## Slide 2 — Two sites, three independent pools

The recorded setup has two Kind sites. The Hub site contains Dynamo Pool A and Pool B. The separate Site cluster contains the Remote Pool. Each pool runs an independent Dynamo Frontend with a Mocker worker. Grid chooses a pool or site from its signals; Dynamo Frontend chooses its worker. Mocker returns synthetic inference text, so this setup does not measure GPU performance.

## Slide 3 — Follow each routing boundary

Dynamo Frontend exports real model readiness and active-request metrics. Grid's versioned adapter checks provider and model identity, source time, and freshness before it compares pressure. Four is the configured comparison reference in this demo. It is not a queue limit or measured capacity. The Hub's local overlay ranks Pool A and Pool B. The Site Gateway reads a separate cross-site snapshot that includes the Remote Pool.

## Slide 4 — Pressure changes the observed route

The presenter starts pressure manually from a pool card. The recording shows pressure on Pool B and the Remote Pool while a new Site Gateway sample is running. The screen shows Frontend activity, candidate order, request counts, and the published and consumed Hub overlay revisions. It does not claim a precise weighted share.

## Slide 5 — Keep the proof and its limits together

The recorded screen is from a completed run on November eighth, twenty twenty-six. Its live badges describe that capture; they do not describe a current deployment. Mocker responses are synthetic, while the Frontend signals are real. The recording does not prove GPU saturation, model quality, weighted-share precision, or live SWIM behavior. Frontend stage counts are not llm-d or EPP queues.
