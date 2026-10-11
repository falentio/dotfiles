// ATS CV for Kevin Falentio. Data lives in cv/data/cv.json.
//
// ATS rules this file obeys:
//   - one column, no tables for layout, no text boxes, no floating elements
//   - real text only; every glyph is selectable and copyable
//   - standard section words in order: Summary, Skills, Projects, Open source
//   - dates as Mon YYYY on the same line as the entry name
//   - Liberation Sans, embedded by typst, no letter-spacing, no ligature tricks

#set page(paper: "a4", margin: (x: 15mm, y: 12mm))
#set text(font: "Liberation Sans", size: 9pt, lang: "en")
#set par(justify: false, leading: 0.58em)
#set list(indent: 3.5mm, body-indent: 3.5mm, marker: [--])

#let cv = json("data/cv.json")
#let rule = line(length: 100%, stroke: 0.5pt + luma(130))

#let section-heading(title) = block(width: 100%, above: 8pt, below: 4pt)[
  #strong(upper(title))
  #v(-0.6em)
  #rule
]

#let dates(start, end) = start + if end == none { " to present" } else { " to " + end }

#let links-for(project) = {
  let parts = ()
  if project.homepage != none and project.homepage != "" {
    parts.push(link(project.homepage)[#project.homepage])
  }
  if project.url != none and project.url != "" {
    parts.push(link(project.url)[#project.url])
  }
  parts.join("  ")
}

#let contact-line(profile) = {
  let parts = ()
  if profile.email != none {
    parts.push(link("mailto:" + profile.email)[#profile.email])
  }
  for u in profile.urls {
    parts.push(link(u.url)[#u.value])
  }
  parts.join("  |  ")
}

#align(left)[
  #text(size: 19pt, weight: "bold")[#cv.profile.name]
  #h(1fr)
  #text(size: 10.5pt, fill: luma(70))[#cv.profile.headline]
]
#v(1mm)
#text(size: 8.5pt)[#contact-line(cv.profile)]
#v(1mm)
#rule

#section-heading("Summary")
#cv.profile.summary

#section-heading("Skills")
#for group in cv.sections.at(0).groups {
  par()[*#group.label:* #group.items.join(", ")]
}

#section-heading("Projects")
#for project in cv.sections.at(1).projects {
  block(width: 100%, above: 5pt, below: 1pt)[
    #strong(project.name) · #text(size: 8.5pt, fill: luma(70))[#dates(project.start, project.end)] · #text(size: 8pt, fill: luma(110))[#links-for(project)]
  ]
  if project.stack != none and project.stack.len() > 0 {
    text(size: 8pt, fill: luma(110))[#project.stack.join(" · ")]
  }
  v(0.5mm)
  for bullet in project.bullets {
    list([#bullet])
  }
}

#section-heading("Open source")
#for item in cv.sections.at(2).items {
  par()[*#item.label:* #item.value #h(2mm) #link(item.url)[#item.url]]
}
