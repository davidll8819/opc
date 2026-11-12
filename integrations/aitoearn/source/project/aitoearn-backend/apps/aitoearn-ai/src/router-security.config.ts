// Internal router authentication is separate from provider/model configuration.
export function routerApiKey() {
  const value = process.env['OFFICE_CCR_API_KEY']
  if (!value || value.length < 32 || /\s/.test(value))
    throw new Error('OFFICE_CCR_API_KEY must contain at least 32 non-whitespace characters')
  return value
}
