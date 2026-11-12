export function wrapSubtitle(text, columns = 24) {
  let width = 0,
    output = ''
  for (const ch of text) {
    const unit = ch.codePointAt(0) > 255 ? 1 : 0.6
    if (ch === '\n') {
      output += ch
      width = 0
      continue
    }
    if (width + unit > columns) {
      output += '\n'
      width = 0
    }
    output += ch
    width += unit
  }
  return output
}
