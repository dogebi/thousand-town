#!/usr/bin/env python3
"""Generate the 大连town favicon set (flat, no gradients).

Draws at 1024 px with PIL, then downsamples with LANCZOS so every exported size
gets real antialiasing instead of a nearest-neighbour shrink. The three strokes
are the character 大 — the first character of 大连 — which stays legible at 16 px,
where a wave or skyline collapses into noise.
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SIZE = 1024
UNIT = SIZE / 64.0  # geometry is authored in a 64-unit box

TILE = (14, 76, 99)        # deep sea blue
GLYPH = (246, 241, 226)    # warm paper white
SUN = (255, 208, 138)      # low coastal sun


def build(with_sun: bool) -> Image.Image:
    ss = 2  # supersample the stroke joins on top of the final LANCZOS pass
    img = Image.new("RGBA", (SIZE * 1, SIZE * 1), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def pts(*pairs):
        return [(x * UNIT, y * UNIT) for x, y in pairs]

    # rounded tile
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(14 * UNIT), fill=TILE + (255,))

    if with_sun:
        cx, cy, r = 52.0 * UNIT, 12.0 * UNIT, 4.6 * UNIT
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SUN + (255,))

    # 大: the horizontal bar is what tells 大 apart from 人/个 at small sizes.
    w = int(7.8 * UNIT)
    strokes = [
        pts((18.0, 22.5), (44.0, 22.5)),          # horizontal
        pts((31.0, 12.0), (31.0, 30.0)),          # vertical
        pts((31.0, 24.0), (14.5, 51.5)),          # left leg
        pts((31.0, 24.0), (47.5, 51.5)),          # right leg
    ]
    for line in strokes:
        d.line(line, fill=GLYPH + (255,), width=w, joint="curve")
        # round caps, which ImageDraw.line does not draw itself
        for x, y in (line[0], line[-1]):
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=GLYPH + (255,))

    del ss
    return img


def save_set(img: Image.Image, prefix: str):
    def resize(px):
        return img.resize((px, px), Image.LANCZOS)

    # iOS composites transparency onto black and masks the corners itself, so the
    # touch icon ships opaque and square instead of reusing the rounded tile.
    touch = Image.new("RGBA", img.size, TILE + (255,))
    touch.alpha_composite(img)
    touch.resize((180, 180), Image.LANCZOS).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    resize(192).save(os.path.join(OUT, "icon-192.png"))
    resize(512).save(os.path.join(OUT, "icon-512.png"))
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)]
    resize(256).save(os.path.join(OUT, "favicon.ico"), format="ICO", sizes=ico_sizes)
    for px in (16, 32, 48):
        resize(px).save(os.path.join(OUT, f"favicon-{px}.png"))
    print("wrote", prefix, "set to", os.path.abspath(OUT))


if __name__ == "__main__":
    import sys

    variant = "sun" if "--sun" in sys.argv else "plain"
    save_set(build(variant == "sun"), variant)
    # preview sheet for the 16 px eyeball test
    sheet = Image.new("RGBA", (64 * 8 * 2 + 24, 64 * 8), (255, 255, 255, 255))
    sheet.alpha_composite(build(False).resize((64 * 8, 64 * 8), Image.LANCZOS), (0, 0))
    sheet.alpha_composite(build(True).resize((64 * 8, 64 * 8), Image.LANCZOS), (64 * 8 + 24, 0))
    sheet.save("/tmp/icon-preview.png")
    small = Image.new("RGBA", (16 * 8 * 2 + 24, 16 * 8), (255, 255, 255, 255))
    small.alpha_composite(build(False).resize((16, 16), Image.LANCZOS).resize((16 * 8, 16 * 8), Image.NEAREST), (0, 0))
    small.alpha_composite(build(True).resize((16, 16), Image.LANCZOS).resize((16 * 8, 16 * 8), Image.NEAREST), (16 * 8 + 24, 0))
    small.save("/tmp/icon-preview-16.png")
    print("previews: /tmp/icon-preview.png /tmp/icon-preview-16.png")
