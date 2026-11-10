"""Generate the five-slide Grid × Dynamo introduction deck.

Run with: .venv/bin/python build_slides.py
The deck uses editable PowerPoint shapes and contains no external images.
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt


OUT = Path(__file__).with_name("grid-dynamo-intro.pptx")
P = Presentation()
P.slide_width = Inches(13.333)
P.slide_height = Inches(7.5)
BLANK = P.slide_layouts[6]

BG = "0A1424"
PANEL = "12233A"
PANEL2 = "182C45"
EDGE = "37516A"
WHITE = "F5F9FC"
MUTED = "AFC2D0"
CYAN = "50D5E8"
GREEN = "71E0AD"
GOLD = "F2CA72"
RED = "EC6672"


def rgb(value):
    return RGBColor.from_string(value)


def rect(slide, x, y, w, h, fill=PANEL, line=None, radius=True):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE,
        Inches(x), Inches(y), Inches(w), Inches(h),
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = rgb(fill)
    shape.line.fill.background() if line is None else None
    if line is not None:
        shape.line.color.rgb = rgb(line)
        shape.line.width = Pt(1.2)
    if radius:
        shape.adjustments[0] = 0.13
    return shape


def txt(slide, value, x, y, w, h, size=18, color=WHITE, bold=False,
        align=PP_ALIGN.LEFT, font="Aptos", valign=MSO_ANCHOR.MIDDLE):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.02)
    tf.margin_top = tf.margin_bottom = Inches(0.01)
    tf.vertical_anchor = valign
    for i, line in enumerate(value.split("\n")):
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.text = line
        para.alignment = align
        para.space_after = Pt(0)
        para.font.name = font
        para.font.size = Pt(size)
        para.font.bold = bold
        para.font.color.rgb = rgb(color)
    return box


def line(slide, x1, y1, x2, y2, color=CYAN, width=2.3):
    shape = slide.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT,
        Inches(x1), Inches(y1), Inches(x2), Inches(y2),
    )
    shape.line.color.rgb = rgb(color)
    shape.line.width = Pt(width)
    return shape


def arrow(slide, x1, y, x2, color=CYAN):
    line(slide, x1, y, x2 - 0.12, y, color)
    line(slide, x2 - 0.23, y - 0.105, x2, y, color)
    line(slide, x2 - 0.23, y + 0.105, x2, y, color)


def pill(slide, label, x, y, w, color=CYAN):
    rect(slide, x, y, w, 0.35, fill=PANEL2, line=color)
    txt(slide, label, x + 0.08, y + 0.01, w - 0.16, 0.31, 10.5, color, True)


def base(number, kicker, title, subtitle=None):
    s = P.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = rgb(BG)
    rect(s, 0, 0, 0.12, 7.5, fill=RED, radius=False)
    txt(s, "GRID  /  DYNAMO", 0.55, 0.34, 4.0, 0.3, 12, CYAN, True)
    txt(s, kicker.upper(), 0.55, 0.78, 8.0, 0.3, 11, GREEN, True)
    txt(s, title, 0.55, 1.15, 12.2, 0.66, 31, WHITE, True)
    if subtitle:
        txt(s, subtitle, 0.58, 1.91, 11.9, 0.48, 15.5, MUTED)
    line(s, 0.55, 7.16, 12.78, 7.16, EDGE, 1)
    txt(s, "Grid × Dynamo  ·  Frontend signals, Grid routing", 0.55, 7.21, 9, 0.2, 9.5, MUTED)
    txt(s, f"{number:02d} / 05", 12.0, 7.21, 0.8, 0.2, 9.5, MUTED, align=PP_ALIGN.RIGHT)
    return s


def card(slide, x, y, w, h, label, detail, accent=CYAN):
    rect(slide, x, y, w, h, PANEL, EDGE)
    rect(slide, x, y, 0.07, h, accent, radius=False)
    txt(slide, label, x + 0.22, y + 0.18, w - 0.4, 0.42, 18, WHITE, True)
    txt(slide, detail, x + 0.22, y + 0.68, w - 0.4, h - 0.79, 12.7, MUTED)


# 1 — promise and high-level loop.
s = base(1, "The idea", "Signals change where the next request goes",
         "Dynamo observes live work. Grid turns fresh observations into routing decisions.")
card(s, 0.55, 2.75, 3.55, 2.28, "Observe", "Dynamo Frontend reports model readiness and active requests.", CYAN)
card(s, 4.89, 2.75, 3.55, 2.28, "Decide", "Grid compares eligible pools and updates routing state.", GREEN)
card(s, 9.22, 2.75, 3.55, 2.28, "Verify", "A new Gateway request and its available route evidence identify the selection.", GOLD)
arrow(s, 4.17, 3.87, 4.78)
arrow(s, 8.51, 3.87, 9.11)
rect(s, 0.55, 5.55, 12.22, 0.96, PANEL2, EDGE)
txt(s, "Live signals  →  fresh score  →  current route  →  backend receipt",
    0.85, 5.74, 11.6, 0.37, 20, WHITE, True, PP_ALIGN.CENTER)

# 2 — two-site, three-pool topology.
s = base(2, "The topology", "Three independent pools across two sites",
         "The Hub Gateway uses a local A/B overlay; the Site Gateway uses a separate peer-fed snapshot that includes the remote pool.")
rect(s, 0.55, 2.57, 7.6, 3.52, PANEL, EDGE)
pill(s, "LOCAL KIND SITE", 0.84, 2.81, 1.71, CYAN)
card(s, 0.84, 3.38, 3.27, 1.89, "Pool A", "Frontend + Mocker\nDedicated model scope", CYAN)
card(s, 4.26, 3.38, 3.27, 1.89, "Pool B", "Frontend + Mocker\nIndependent Pod and metrics", CYAN)
rect(s, 8.42, 2.57, 4.35, 3.52, PANEL, EDGE)
pill(s, "REMOTE KIND SITE", 8.73, 2.81, 1.95, GREEN)
card(s, 8.73, 3.38, 3.73, 1.89, "Remote pool", "Frontend + Mocker\nSecure peer signal relay", GREEN)
rect(s, 2.79, 6.32, 7.77, 0.55, PANEL2, EDGE)
txt(s, "Hub local Gateway consumes the A/B overlay  ·  Site Gateway uses the separate cross-site snapshot",
    3.05, 6.38, 7.28, 0.41, 14, WHITE, True, PP_ALIGN.CENTER)
line(s, 4.35, 6.09, 4.35, 6.3, CYAN)
line(s, 10.54, 6.09, 10.54, 6.58, GREEN)

# 3 — separate local and remote state paths.
s = base(3, "The control path", "A metric is evidence, not a route",
         "Grid binds source identity and freshness before a signal can influence selection.")
card(s, 0.55, 2.67, 2.53, 2.12, "Frontend /metrics", "model_ready\nactive_requests\nFrontend stage counters", CYAN)
arrow(s, 3.15, 3.73, 3.57)
card(s, 3.64, 2.67, 2.53, 2.12, "Grid adapter", "Per-model observation\nidentity + freshness\ncomparison profile", GREEN)
arrow(s, 6.24, 3.73, 6.63)
card(s, 6.71, 2.67, 2.53, 2.12, "Grid scoring", "Eligibility\npressure ratio\nscore and rank", GOLD)
arrow(s, 9.31, 3.73, 9.70)
card(s, 9.78, 2.67, 2.99, 2.12, "Gateway", "Selects from a current, accepted routing snapshot", RED)
rect(s, 0.55, 5.32, 5.95, 0.94, PANEL2, EDGE)
txt(s, "LOCAL: A/B overlay  →  Hub Gateway consumed revision", 0.82, 5.52, 5.43, 0.4, 14.2, CYAN, True)
rect(s, 6.82, 5.32, 5.95, 0.94, PANEL2, EDGE)
txt(s, "SITE: secure peer signals  →  Site Gateway snapshot", 7.09, 5.52, 5.43, 0.4, 14.2, GREEN, True)

# 4 — what a pressure probe changes.
s = base(4, "The pressure probe", "Real Frontend load changes the ranking",
         "The controlled workload creates active requests; the dashboard reads Dynamo’s actual gauges.")
rect(s, 0.55, 2.56, 5.85, 3.6, PANEL, EDGE)
pill(s, "BASELINE", 0.84, 2.84, 1.30, GREEN)
txt(s, "0 ACTIVE", 0.88, 3.42, 4.8, 0.82, 42, WHITE, True)
txt(s, "actual Frontend gauge · comparison reference 4", 0.88, 4.30, 4.8, 0.49, 14, MUTED)
rect(s, 0.88, 5.13, 5.15, 0.17, EDGE, radius=False)
rect(s, 0.88, 5.13, 0.07, 0.17, GREEN, radius=False)
rect(s, 6.91, 2.56, 5.85, 3.6, PANEL, EDGE)
pill(s, "UNDER LOAD", 7.20, 2.84, 1.65, GOLD)
txt(s, "4 ACTIVE", 7.24, 3.42, 4.8, 0.82, 42, WHITE, True)
txt(s, "actual Frontend gauge · comparison reference 4", 7.24, 4.30, 4.9, 0.49, 14, MUTED)
rect(s, 7.24, 5.13, 5.15, 0.17, EDGE, radius=False)
rect(s, 7.24, 5.13, 5.15, 0.17, GOLD, radius=False)
txt(s, "Four is a demo comparison reference, not GPU utilization, a Mocker replica count, a queue limit, or token throughput.",
    0.66, 6.46, 12.0, 0.37, 15, MUTED, align=PP_ALIGN.CENTER)

# 5 — handoff to the recorded UI.
s = base(5, "Watch the evidence", "Follow the signal all the way to a request",
         "The recording separates local overlay decisions from the cross-site Gateway snapshot.")
steps = [
    ("01", "Baseline", "Three ready pools; live scrapes and matching local revisions."),
    ("02", "Pressure", "Direct Mocker work changes Frontend active_requests."),
    ("03", "Route", "Inspect the request ID and the route attribution actually emitted."),
    ("04", "Recovery", "Load clears, fresh zero returns, and selection is restored."),
]
for i, (num, label, detail) in enumerate(steps):
    x = 0.55 + i * 3.11
    rect(s, x, 2.65, 2.87, 2.89, PANEL, EDGE)
    txt(s, num, x + 0.18, 2.88, 0.55, 0.44, 21, CYAN, True)
    txt(s, label, x + 0.18, 3.45, 2.5, 0.42, 21, WHITE, True)
    txt(s, detail, x + 0.18, 4.04, 2.49, 1.10, 13, MUTED)
rect(s, 0.55, 5.86, 12.22, 0.65, PANEL2, EDGE)
txt(s, "Mocker responses are synthetic · no GPU, weighted-share precision, or live SWIM claim · local route headers may be absent",
    0.8, 5.98, 11.75, 0.39, 13.7, GOLD, True, PP_ALIGN.CENTER)

P.save(OUT)
print(OUT)
