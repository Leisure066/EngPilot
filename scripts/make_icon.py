"""Generate the Zhanci application icon (multi-size .ico + 1024 png)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "desktop" / "Zhanci.App" / "Assets"
ASSETS.mkdir(parents=True, exist_ok=True)

SIZE = 1024
BLUE = (43, 70, 232, 255)
BLUE_DARK = (29, 51, 194, 255)
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded square with a soft vertical gradient.
radius = int(SIZE * 0.235)
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(int(BLUE[i] * (1 - t) + BLUE_DARK[i] * t) for i in range(3)) + (255,)
    draw.line([(0, y), (SIZE, y)], fill=color)

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.putalpha(mask)

# White "斩" glyph, optically centred.
glyph = "斩"
font = None
for candidate in (
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
):
    try:
        font = ImageFont.truetype(candidate, int(SIZE * 0.60))
        break
    except OSError:
        continue

if font is not None:
    bbox = draw.textbbox((0, 0), glyph, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # Optical lift: CJK glyphs look low when centred on the bounding box.
    x = (SIZE - w) / 2 - bbox[0]
    y = (SIZE - h) / 2 - bbox[1] - SIZE * 0.015
    draw.text((x, y), glyph, font=font, fill=WHITE)

img.save(ASSETS / "zhanci.png")
img.save(
    ASSETS / "zhanci.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote", ASSETS / "zhanci.ico")