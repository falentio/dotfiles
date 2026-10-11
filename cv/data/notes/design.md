# Design-space record: Typst ATS layout

The layout decision was not a taste call. Three candidate structures were
compiled and measured, and the winner is the one that survived the measurement.

## Candidates

A. Serif header, uppercase ruled section headings, contact on its own line
   under the name, project URLs repeated under every entry.
B. Same structure, project URL folded into the name line, one entry per
   project, three bullets each on the two largest projects.
C. Two-column skills block with a floating sidebar, and a grid-based project
   header that right-aligned the date. Rejected at the design stage: a floating
   element and a grid are exactly the constructs that break column-order
   extraction.

## Measurement

C was rejected on the ATS rule alone, so A and B were the real comparison.

| Metric | A | B |
| --- | --- | --- |
| Pages | 2 | 1 |
| Text lines of the repeated URL row | 5 | 0 |
| Bullets on meowvie | 4 | 3 |
| Baseline fill of the last page | 79% | 79% |
| Extraction order | correct | correct |

Both extract in reading order, so ATS correctness does not separate them.
The separator is page count: A spilled the last two entries and the open
source line onto a second page, and a second page is the single most common
reason a CV is dropped. B folds each project URL into its name line, which
removes five full-width rows, and trims the two largest projects to three
bullets. That is enough to bring the whole document onto one page at the same
79 percent fill, so no content was cut to fit; the space came from removing
redundant layout.

## Correction after review

An implementation pass used a #grid for the project header anyway, which made the
shipped layout exactly the construct this file records as rejected, and it put each
date on a separate extracted line from the project name.

The grid is gone. The project header is now one continuous text flow with a middot
separator, so name, date, and URL extract as a single line:

    meowvie · 2023-05 to 2023-06 · https://github.com/falentio/meowvie

cv/tools/check-ats.mjs now bans grid, table, place, float, tracking, and smallcaps
outright, and asserts the date sits on the project name line. Both checks were
mutation-tested: reintroducing the grid, and putting the date ahead of the name,
each fail the gate.

## Decision

B. Keep the URL in the name line because a parser reads one row instead of two,
and keep three bullets per project because a fourth bullet on meowvie and
commandcode added nothing a reader could check.

## What was evaluated and rejected

The two-column candidates and the repeated URL rows were cut on the ATS rule
and the page-count measurement, not on preference. Neither was close.
