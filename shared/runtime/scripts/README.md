# Report font

The report uses Recursive at weights 400, 500, 600 and 700, with `CASL=0.35`.
Its original Latin font already fixes `MONO=0`, `slnt=0` and `CRSV=0.5`; only
`CASL` and `wght` are variable. Report paths, times and code use system
monospace fonts. The wordmark's Geist bold asset stays unchanged.

`regenerate-report-font.py` pins CASL and keeps only the weight range 400–700.
It retains Latin and Latin-1 letters, the original accents, punctuation, spaces,
currency, arrows and symbols, along with their layout features and hinting.
The generated WOFF2 replaces `src/assets/recursive-latin.woff2`; Python is only
needed to regenerate this committed asset, not to build or run Specbook.

From the repository root:

```sh
python3 -m venv /tmp/specbook-report-font-venv
/tmp/specbook-report-font-venv/bin/python -m pip install --no-cache-dir -r shared/runtime/scripts/report-font-requirements.txt
/tmp/specbook-report-font-venv/bin/python shared/runtime/scripts/regenerate-report-font.py
```

The default source is the original font's immutable Git blob
`b7c971590e8d5d05fd412923373f652fb7f3a109`, verified with SHA-256
`63000af5927b0369735b6b0ff4109fb51fb4493ce57a92a3327c4820310b0427`.
A full clone contains it. With a shallow clone, obtain the original
`shared/runtime/src/assets/recursive-latin.woff2` from commit `f811c41` and pass
its path with `--source /tmp/recursive-original.woff2`. `--output` can write a
comparison font without replacing the report asset.

When changing report typography, update the axis limits and font-face weight
range together, then compare the same report with both fonts in Chromium at
desktop and mobile widths. Check all four weights, tooltips and line wrapping.
