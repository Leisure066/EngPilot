"""从一张方形头像/插画生成 EngPilot 用到的全部图标。

用法：
    python scripts/make-icon.py <源图片> [工作区根目录]

会生成：
    desktop/Zhanci.App/Assets/engpilot.ico      exe / 任务栏 / 托盘（多尺寸）
    desktop/Zhanci.App/Assets/engpilot-96.png   标题栏头像（圆角，WPF Resource）
    public/favicon.png                          网页图标 512
    public/icon-192.png                         apple-touch-icon
    public/favicon-32.png                       备用小图标

依赖 Pillow。原图不是正方形时会居中裁成正方形。
"""
import os
import sys

from PIL import Image, ImageDraw

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def square_crop(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def rounded(image: Image.Image, size: int, radius_ratio: float = 0.22) -> Image.Image:
    scale = 4
    big = image.resize((size * scale, size * scale), Image.LANCZOS)
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=int(size * scale * radius_ratio),
        fill=255,
    )
    big.putalpha(mask)
    return big.resize((size, size), Image.LANCZOS)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    source = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    image = Image.open(source).convert("RGBA")
    square = square_crop(image)
    print(f"source {image.size} -> square {square.size}")

    assets = os.path.join(root, "desktop", "Zhanci.App", "Assets")
    public = os.path.join(root, "public")
    os.makedirs(assets, exist_ok=True)
    os.makedirs(public, exist_ok=True)

    icon_256 = square.resize((256, 256), Image.LANCZOS)
    ico_path = os.path.join(assets, "engpilot.ico")
    icon_256.save(ico_path, format="ICO", sizes=ICO_SIZES)
    print(f"ico      {ico_path}  {os.path.getsize(ico_path)} bytes")

    rounded(square, 96).save(os.path.join(assets, "engpilot-96.png"))
    square.resize((512, 512), Image.LANCZOS).save(os.path.join(public, "favicon.png"))
    square.resize((192, 192), Image.LANCZOS).save(os.path.join(public, "icon-192.png"))
    square.resize((32, 32), Image.LANCZOS).save(os.path.join(public, "favicon-32.png"))
    print("web icons written to public/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())