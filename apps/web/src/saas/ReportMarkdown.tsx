import { Fragment, type ReactNode } from 'react'
import { safeSourceUrl } from './research-markdown'
import './research-report.css'
type Source = { id: string; url: string }
function inline(text: string, sources: Source[]): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|!?\[[^\]\n]+\]\([^\s)]+\)|\[S\d+\])/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    const source = /^\[(S\d+)\]$/.exec(part)
    const href = safeSourceUrl(link?.[2] || sources.find(s => s.id === source?.[1])?.url || '')
    return href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer">{link?.[1] || part}</a> : <Fragment key={i}>{part}</Fragment>
  })
}
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
// React text nodes escape HTML. No raw HTML, embedded images, scripts or active document content.
export function ReportMarkdown({ text, sources = [] }: { text: string; sources?: Source[] }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), nodes: ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (line.startsWith('```')) {
      const code = []; while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i])
      nodes.push(<pre key={i}><code>{code.join('\n')}</code></pre>); continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '') && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c))) {
      const head = cells(line), rows = []; i++
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]))
      nodes.push(<div className="report-table" key={i} tabIndex={0} role="region" aria-label="报告表格，可横向滚动"><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, sources)}</th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{head.map((_, k) => <td key={k}>{inline(r[k] || '', sources)}</td>)}</tr>)}</tbody></table></div>); continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) { nodes.push(<h3 key={i}>{inline(heading[1], sources)}</h3>); continue }
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line), items = [line]
      while (i + 1 < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i + 1])) items.push(lines[++i])
      const content = items.map((v, j) => <li key={j}>{inline(v.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''), sources)}</li>)
      nodes.push(ordered ? <ol key={i} start={Number(/^\s*(\d+)/.exec(line)?.[1] || 1)}>{content}</ol> : <ul key={i}>{content}</ul>); continue
    }
    nodes.push(<p key={i}>{inline(line, sources)}</p>)
  }
  return <div className="report-markdown">{nodes}</div>
}
