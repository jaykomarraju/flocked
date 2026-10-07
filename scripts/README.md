# scripts

## `spec-section.mjs` (`pnpm spec`)

Prints one part of `Product_Spec.md` so sessions never load the whole spec.

```bash
pnpm spec --list                                  # every `## ` heading
pnpm spec "Round lifecycle"                       # one `## ` section, `###` subsections included
pnpm spec "Smart contract" --sub "Constants"      # one bold-labelled block inside it
```

- Headings and labels match case-insensitively, ignoring backticks, `*`, `_` and a trailing `:`.
- `--sub` finds `**Label**` at the start of a line or list item. A paragraph-level label runs to
  the next paragraph-level label or heading; a list-item label runs to its next sibling item.
- Unknown heading or label: exits 1 and prints the closest matches to stderr. Usage error: exit 2.
- `--file <path>` reads another markdown file. Works from any directory.

Tests: `scripts/spec-section.test.mjs` (`node:test`, fixture in `scripts/fixtures/`), run by the
root `pnpm test`.
