export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

declare const __DEV__: boolean | undefined

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (!isDev() && level === 'debug') return
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  fn(`[${prefix}]`, message, ...args)
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log('debug', 'velo', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log('info', 'velo', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('warn', 'velo', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('error', 'velo', msg, ...args),
}