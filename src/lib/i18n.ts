export function i18n(key: string, substitutions?: string | string[]): string {
  const msg = chrome.i18n.getMessage(key, substitutions)
  return msg || key
}