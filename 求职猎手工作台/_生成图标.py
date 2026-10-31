# -*- coding: utf-8 -*-
"""求职猎手工作台 · 图标生成器（favicon.ico）

与 index.html 里内嵌的 SVG 图标保持一致：蓝底圆角方块（#1d4ed8）+ 白色「猎」字。
打包多个尺寸（16/24/32/48/64/128/256），Windows 会按场景自取（任务栏用 32，
桌面大图标用 256，列表小图标用 16）。

图标是「一次性产物」，已经随仓库提交好了；除非要改配色 / 字形，平时不用运行。

运行（需要 Pillow，用采集器的虚拟环境即可 —— 那里装了 Pillow）：
  "C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\boss-crawler\\Scripts\\python.exe" _生成图标.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "favicon.ico")

SIZES = [16, 24, 32, 48, 64, 128, 256]
BG = (29, 78, 216, 255)      # #1d4ed8（与 index.html 的 SVG 同色）
FG = (255, 255, 255, 255)    # 白字
RADIUS_RATIO = 0.22          # 圆角半径 / 边长（SVG 里是 22/100）
GLYPH_RATIO = 0.62           # 字号 / 边长
SUPERSAMPLE = 4              # 超采样倍数：先画大图再缩，边缘更干净

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",     # 微软雅黑
    r"C:\Windows\Fonts\simhei.ttf",   # 黑体
]
GLYPH = "猎"


def _load_font(size):
    from PIL import ImageFont
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    raise RuntimeError("找不到可用的中文字体，无法绘制「猎」字。候选：%s" % (FONT_CANDIDATES,))


def render(size):
    """画一张 size×size 的图标（内部按 SUPERSAMPLE 倍超采样后再缩）。"""
    from PIL import Image, ImageDraw
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * RADIUS_RATIO), fill=BG)
    font = _load_font(int(s * GLYPH_RATIO))
    d.text((s / 2.0, s / 2.0), GLYPH, font=font, fill=FG, anchor="mm")
    return img.resize((size, size), Image.LANCZOS)


def main():
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "需要 Pillow。请用采集器的虚拟环境运行：\n"
            '  "C:\\Users\\1\\.workbuddy\\binaries\\python\\envs\\boss-crawler\\Scripts\\python.exe" '
            + os.path.basename(__file__) + "\n")
        return 2

    master = render(max(SIZES))
    master.save(OUT, format="ICO", sizes=[(s, s) for s in SIZES])
    print("已生成 %s（%d 字节，尺寸 %s）" % (OUT, os.path.getsize(OUT), SIZES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
