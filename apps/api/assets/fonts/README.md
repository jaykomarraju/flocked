# Card fonts

The five static faces the share cards draw with (`docs/design/screens.md` "Cards decisions": "Fonts:
Fredoka 600/700 and Inter 500/600/700 as TTF"), plus `build.mjs`, which embeds them in
`apps/api/src/cards/fonts.gen.ts` as base64 — the one form wrangler's esbuild and Vite (which builds
the Workers tests) bundle the same way, so no module rule in `wrangler.jsonc` is needed.

| File              | Face                         |
| ----------------- | ---------------------------- |
| `Fredoka-600.ttf` | Fredoka SemiBold, `wdth` 100 |
| `Fredoka-700.ttf` | Fredoka Bold, `wdth` 100     |
| `Inter-500.ttf`   | Inter Medium, `opsz` 24      |
| `Inter-600.ttf`   | Inter SemiBold, `opsz` 24    |
| `Inter-700.ttf`   | Inter Bold, `opsz` 24        |

## Where they come from

The same upstream the web self-hosts (`apps/web/src/theme/fonts.ts`): the `@fontsource-variable`
Latin subsets, which ship as woff2 — a compression satori cannot read — so each one is decompressed
and instanced to a static weight with fontTools:

```bash
F=apps/web/node_modules/@fontsource-variable
cp $F/fredoka/files/fredoka-latin-standard-normal.woff2 $F/inter/files/inter-latin-standard-normal.woff2 .
uv tool run --from "fonttools[woff]" fonttools ttLib.woff2 decompress fredoka-latin-standard-normal.woff2
uv tool run --from "fonttools[woff]" fonttools ttLib.woff2 decompress inter-latin-standard-normal.woff2
for w in 600 700; do
  uv tool run --from fonttools fonttools varLib.instancer --static \
    -o Fredoka-$w.ttf fredoka-latin-standard-normal.ttf wght=$w wdth=100
done
for w in 500 600 700; do
  uv tool run --from fonttools fonttools varLib.instancer --static \
    -o Inter-$w.ttf inter-latin-standard-normal.ttf wght=$w opsz=24
done
node apps/api/assets/fonts/build.mjs
```

`opsz` 24 sits in the middle of the Inter sizes the cards set (18–38 px), which is where a browser's
`opsz: auto` — what Paper renders the artboards with — would put it. At `opsz` 14, Inter's text-size
metrics, the refund card's why line came out wide enough to wrap a line the export keeps on one.

Both families are under the SIL Open Font License 1.1, as `OFL-Fredoka.txt` and `OFL-Inter.txt`.
