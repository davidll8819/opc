export function downloadWorkflow(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name.replace(/[^\p{L}\p{N}_.-]/gu, '_') + '.json'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
