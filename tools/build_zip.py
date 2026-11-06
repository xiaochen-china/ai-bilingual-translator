#!/usr/bin/env python3
"""把扩展打包成可分发 ZIP。

要求：ZIP 根目录下必须直接包含 manifest.json，解压后即可「加载解压缩的扩展」。

用法：
    python tools/build_zip.py
输出：
    dist/ai-bilingual-translator-v<version>.zip
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# 打进 ZIP 的顶层条目（相对仓库根目录）
INCLUDE = ["manifest.json", "src", "docs", "README.md"]
# 任何层级命中这些名字都跳过
EXCLUDE_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db", "node_modules", ".git"}
EXCLUDE_SUFFIXES = {".pyc", ".zip"}


def iter_files(entry: Path):
    if entry.is_file():
        yield entry
        return
    for path in sorted(entry.rglob("*")):
        if not path.is_file():
            continue
        if any(part in EXCLUDE_NAMES for part in path.parts):
            continue
        if path.suffix.lower() in EXCLUDE_SUFFIXES:
            continue
        yield path


def main() -> int:
    manifest_path = ROOT / "manifest.json"
    if not manifest_path.exists():
        print("找不到 manifest.json，请在仓库根目录运行。", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest.get("version", "0.0.0")

    missing = [name for name in INCLUDE if not (ROOT / name).exists()]
    if missing:
        print(f"缺少待打包内容：{', '.join(missing)}", file=sys.stderr)
        return 1

    DIST.mkdir(exist_ok=True)
    target = DIST / f"ai-bilingual-translator-v{version}.zip"

    count = 0
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in INCLUDE:
            for path in iter_files(ROOT / name):
                arcname = path.relative_to(ROOT).as_posix()
                zf.write(path, arcname)
                count += 1

    size_kb = target.stat().st_size / 1024
    print(f"已生成 {target.relative_to(ROOT).as_posix()}")
    print(f"  版本 {version}，文件 {count} 个，大小 {size_kb:.1f} KB")

    # 自检：manifest.json 必须在 ZIP 根目录
    with zipfile.ZipFile(target) as zf:
        names = zf.namelist()
        if "manifest.json" not in names:
            print("打包结果缺少根目录 manifest.json！", file=sys.stderr)
            return 1
        if any(name.startswith("/") for name in names):
            print("打包结果包含绝对路径条目！", file=sys.stderr)
            return 1
    print("  自检通过：根目录含 manifest.json，全部为相对路径")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())