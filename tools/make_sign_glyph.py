#!/usr/bin/env python3
"""Rasterise CJK characters into the 24x24 1-bit glyphs the facade LED signs use.

city-scene.js stores each sign row as 24 rows of six hex digits (MSB = leftmost
column). This prints rows ready to paste into `facadeGlyphs`, plus an ASCII
preview so a misshapen glyph is obvious before it reaches the building.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
BIG = 256
OUT = 24
INSET = 2  # dot-matrix signs look cramped when ink touches the cell edge


def glyph(ch: str, threshold: float = 0.42) -> list[str]:
    font = ImageFont.truetype(FONT, BIG, index=2)  # 2 = SC
    img = Image.new("L", (BIG * 2, BIG * 2), 0)
    d = ImageDraw.Draw(img)
    d.text((BIG // 2, BIG // 2), ch, font=font, fill=255)
    box = img.getbbox()
    if box is None:
        raise SystemExit(f"no ink for {ch!r}")
    ink = img.crop(box)
    inner = OUT - INSET * 2
    ink = ink.resize((inner, inner), Image.LANCZOS)
    cell = Image.new("L", (OUT, OUT), 0)
    cell.paste(ink, (INSET, INSET))
    px = cell.load()
    rows = []
    for y in range(OUT):
        bits = 0
        for x in range(OUT):
            if px[x, y] / 255.0 >= threshold:
                bits |= 1 << (23 - x)
        rows.append("%06x" % bits)
    return rows


def preview(rows: list[str]) -> str:
    return "\n".join(
        "".join("#" if int(r, 16) & (1 << (23 - c)) else "." for c in range(24)) for r in rows
    )


if __name__ == "__main__":
    for ch in sys.argv[1:] or ["大", "英", "博", "连"]:
        rows = glyph(ch)
        print(f"--- {ch} ---")
        print(preview(rows))
        print(f"'{ch}':'" + "".join(rows) + "',")
