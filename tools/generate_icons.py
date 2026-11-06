"""生成扩展图标（16/32/48/128 PNG）。

设计：蓝色圆角方块 + 两个对话气泡（白色主气泡 + 浅蓝色译文气泡），
象征「原文 + 译文」。不使用任何字体，保证在 16px 下依然清晰。

用法：
    python tools/generate_icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "icons")
SIZES = (16, 32, 48, 128)

BLUE_TOP = (66, 133, 244)      # #4285f4
BLUE_BOTTOM = (11, 87, 208)    # #0b57d0
WHITE = (255, 255, 255)
LIGHT = (138, 180, 248)        # #8ab4f8


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """生成竖直渐变色块。"""
    image = Image.new("RGB", (size, size), top)
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    """圆角矩形蒙版。"""
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * 4 * radius_ratio)
    draw.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=radius, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def bubble(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], radius: int, fill, tail: str) -> None:
    """画一个带小尾巴的对话气泡。tail 取值 'left' / 'right' / 'none'。"""
    x0, y0, x1, y1 = box
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)
    if tail == "left":
        draw.polygon(
            [(x0 + radius * 0.2, y1 - radius * 0.4), (x0 - radius * 0.9, y1 + radius * 0.9), (x0 + radius * 1.4, y1 - radius * 0.1)],
            fill=fill,
        )
    elif tail == "right":
        draw.polygon(
            [(x1 - radius * 1.4, y1 - radius * 0.1), (x1 + radius * 0.9, y1 + radius * 0.9), (x1 - radius * 0.2, y1 - radius * 0.4)],
            fill=fill,
        )


def render(size: int) -> Image.Image:
    """渲染单个尺寸的图标。"""
    scale = 8  # 先大图绘制再缩小，得到平滑边缘
    big = size * scale

    background = vertical_gradient(big, BLUE_TOP, BLUE_BOTTOM)
    mask = rounded_mask(size, 0.22).resize((big, big), Image.LANCZOS)
    icon = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    icon.paste(background, (0, 0), mask)

    draw = ImageDraw.Draw(icon)

    # 主气泡（白色，左下）
    margin = big * 0.17
    main_h = big * 0.42
    main_w = big * 0.52
    main_box = (margin, big * 0.30, margin + main_w, big * 0.30 + main_h)
    bubble(draw, main_box, radius=int(big * 0.10), fill=WHITE, tail="left")

    # 译文气泡（浅蓝，右上，压在白色气泡之上）
    sub_w = big * 0.42
    sub_h = big * 0.30
    sub_box = (big - margin - sub_w, big * 0.16, big - margin, big * 0.16 + sub_h)
    bubble(draw, sub_box, radius=int(big * 0.08), fill=LIGHT, tail="right")

    # 气管内部两条横线，强化“文字”的意象
    line_color = (11, 87, 208)
    line_h = max(1, int(big * 0.045))
    for index, ratio in enumerate((0.30, 0.58)):
        y = main_box[1] + main_h * ratio
        draw.rounded_rectangle(
            [main_box[0] + main_w * 0.16, y, main_box[0] + main_w * (0.84 if index == 0 else 0.62), y + line_h],
            radius=line_h,
            fill=line_color,
        )

    # 白色小箭头，表示“翻译”方向
    arrow_h = max(1, int(big * 0.07))
    draw.rounded_rectangle(
        [big * 0.36, big * 0.50, big * 0.66, big * 0.50 + arrow_h],
        radius=arrow_h,
        fill=WHITE,
    )
    draw.polygon(
        [
            (big * 0.64, big * 0.50 - arrow_h),
            (big * 0.76, big * 0.50 + arrow_h * 0.5),
            (big * 0.64, big * 0.50 + arrow_h * 2),
        ],
        fill=WHITE,
    )

    return icon.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUTPUT_DIR, f"icon{size}.png")
        render(size).save(path)
        print(f"generated {path}")
    # 商店宣传图（1280x800）不在此生成，避免仓库体积膨胀


if __name__ == "__main__":
    main()