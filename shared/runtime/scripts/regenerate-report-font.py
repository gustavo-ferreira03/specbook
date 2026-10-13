#!/usr/bin/env python3
"""Instance and subset the report's original Latin Recursive font."""

import argparse
import hashlib
import io
from pathlib import Path
import subprocess

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SOURCE_BLOB = "b7c971590e8d5d05fd412923373f652fb7f3a109"
SOURCE_SHA256 = "63000af5927b0369735b6b0ff4109fb51fb4493ce57a92a3327c4820310b0427"
RUNTIME = Path(__file__).resolve().parent.parent
UNICODE_RANGES = (
    (0x0020, 0x00FF),  # Basic Latin and Latin-1.
    (0x0100, 0x024F),  # Latin extensions.
    (0x02B0, 0x036F),  # Modifiers and combining accents.
    (0x2000, 0x206F),  # Spaces and punctuation.
    (0x20A0, 0x20CF),  # Currency.
    (0x2100, 0x214F),  # Letterlike symbols.
    (0x2190, 0x21FF),  # Arrows.
    (0x2200, 0x22FF),  # Minus and fraction slash.
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Original WOFF2; otherwise read its immutable Git blob")
    parser.add_argument("--output", type=Path, default=RUNTIME / "src/assets/recursive-latin.woff2")
    args = parser.parse_args()
    source = args.source.read_bytes() if args.source else subprocess.check_output(
        ["git", "-C", str(RUNTIME), "cat-file", "blob", SOURCE_BLOB]
    )
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        parser.error("The source must be the original Recursive Latin WOFF2 documented in README.md")
    font = TTFont(io.BytesIO(source), recalcTimestamp=False)
    codepoints = {0x000D}
    for start, end in UNICODE_RANGES:
        codepoints.update(range(start, end + 1))
    options = subset.Options()
    options.flavor = "woff2"
    options.recalc_timestamp = False
    options.layout_features = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font = instantiateVariableFont(font, {"CASL": 0.35, "wght": (400, 400, 700)}, inplace=True)
    font.flavor = "woff2"
    font.save(args.output)
    print(f"{args.output}: {len(source):,} -> {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
