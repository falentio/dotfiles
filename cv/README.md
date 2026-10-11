# CV

A one-page ATS-friendly CV for Kevin Falentio, built with Typst and driven by a
JSON data file. The content comes from the public GitHub account `falentio`.

## Build

```sh
cd cv
typst compile cv.typ out/kevin-falentio-cv.pdf
```

## Check

```sh
cd cv
node tools/check-ats.mjs
```

The check script rebuilds the PDF and asserts the properties a plain-text
applicant tracking system depends on. It exits non-zero on the first failure.

| Check | Why it matters |
| --- | --- |
| Fits one page | Recruiters skim page one; a spillover page gets dropped |
| Fonts embedded and subset | An unembedded glyph drops or substitutes on the reader's machine |
| Every required token extracts | If the parser cannot find the name or the email, the rest never loads |
| Sections in reading order | A parser that reads columns out of order scrambles the CV |
| Every bullet survives extraction | Wrapped lines must rejoin, not break mid-word |
| Dates parse as text | Decorative date formats do not map to a start or end field |
| Contact line is not mangled | Letter-spacing or small caps can split the email into separate glyphs |
| Page is well filled | A near-empty page usually means a broken layout |
| No raster images | A parser that sees only an image sees nothing |

## Files

| Path | What it holds |
| --- | --- |
| `cv/cv.typ` | The layout. Reads `cv/data/cv.json` and holds no content |
| `cv/data/cv.json` | The content: profile, skills, projects, open source |
| `cv/data/github.json` | Raw snapshot of the public GitHub account, fetched by the lever |
| `cv/data/notes/research.md` | The evidence trail, one source per claim |
| `cv/tools/fetch-github.mjs` | Refetches `github.json` from the GitHub API |
| `cv/tools/check-ats.mjs` | The ATS gate described above |
| `cv/out/` | Build output, not committed |

## Refresh the data

```sh
node cv/tools/fetch-github.mjs
```

The script writes `cv/data/github.json` and prints a digest of the repositories
by language and recent activity. Edit `cv/data/cv.json` by hand: it is the
curated layer between the raw snapshot and the rendered page.

## ATS rules the layout follows

- One column. No tables, no text boxes, no floating elements.
- Real text only. Every glyph is selectable, so no image of a CV.
- Standard section words in order: Summary, Skills, Projects, Open source.
- Dates as `Mon YYYY` on the same line as the project name.
- Liberation Sans, embedded by Typst. No letter-spacing, no small caps, no ligature tricks.
- Links carry their full URL as visible text, so a parser that ignores
  annotations still reads the address.

## What the CV does not claim

No employment history, education, location, or phone number exists in any public
source that was read. The CV is a projects-and-skills CV because that is what the
evidence supports. A recruiter looking for dates of employment will not find
them here, and the honest fix is to add them, not to manufacture them.

Three repositories (`image-storage`, `llm`, `sinnau.com`) were read and left
out: they carry no product description and too little verified substance for a
bullet a reader can check. See `cv/data/notes/research.md` for the cut list and
the reasoning.
