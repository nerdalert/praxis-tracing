# Recording and narration assets

`weighted-routing-intro.srt` contains the six introductory slide cues supplied
for the demo. The first cue starts at one second, leaving the required lead-in;
the last cue ends at `00:03:08,000`, leaving the final pause before the live
recording.

The requested source recording is available at:

```text
/home/ubuntu/praxxis/ai-grid/ai-files/grid-weighted-routing-sept11.mp4
```

The recording metadata is 1920x1080 H.264 video with AAC audio, 30 fps, and a
duration of 215.800 seconds. Both streams start at 0.000 seconds. The scene
inventory was reviewed at 15-second intervals: the recording opens on the
dashboard guide, shows the routing sampler and baseline distribution, shows
metric changes and updated effective weights, and returns to the idle baseline.
The dashboard visibly contains three pools; narration must describe the
observed screen rather than claim an unshown ingress path.

Capture or re-check metadata with:

```console
ffprobe -v error -show_entries \
  format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,start_time,duration \
  -of json grid-weighted-routing-sept11.mp4
```


Then add a recording-specific SRT and a closing-slide cue. The combined video
must include the one-second lead-in, introductory slides, recording, closing
slide, and one-second ending pause. Validate cue ordering and duration before
TTS or muxing.
