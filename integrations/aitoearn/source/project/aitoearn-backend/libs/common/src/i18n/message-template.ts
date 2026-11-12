// Catalog messages need named substitution, not an HTML code generator/minifier.
export function compileMessage(message: string) {
  return (values: unknown = {}): string => {
    const data = values && typeof values === 'object' ? values as Record<string, unknown> : {}
    return message.replace(/{{([a-zA-Z_][a-zA-Z0-9_]*)}}/g, (_match, name: string) => {
      const value = Object.hasOwn(data, name) ? data[name] : undefined
      const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value) ?? ''
      return text.replace(/["&'<>]/g, character => `&#${character.charCodeAt(0)};`)
    })
  }
}
