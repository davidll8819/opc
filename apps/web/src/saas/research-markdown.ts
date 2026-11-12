export function safeSourceUrl(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
export function legacyReportSections(text: string) {
  const names = ['summary', 'findings', 'analysis', 'recommendations', 'limitations'] as const
  const result: Partial<Record<typeof names[number], string>> = {}
  // Historical reports may use level-two headings inside findings; keep those subsections.
  const boundaries = [...text.matchAll(/^## [^\n]*\/ (Summary|Findings|Analysis|Recommendations|Limitations|Sources)\s*$/gm)]
  boundaries.forEach((match, index) => {
    const key = match[1].toLowerCase() as typeof names[number]
    if (names.includes(key)) result[key] = text.slice(match.index! + match[0].length, boundaries[index + 1]?.index ?? text.length).trim()
  })
  return result
}
