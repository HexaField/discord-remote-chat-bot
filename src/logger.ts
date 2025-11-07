export const DEV_LOG =
  process.env.NODE_ENV === 'development' ||
  process.env.DEV_LOG === '1' ||
  process.env.DEV_LOG === 'true' ||
  !!process.env.TEST

export function debug(...args: unknown[]) {
  if (DEV_LOG) console.debug('[debug]', ...args)
}

export function info(...args: unknown[]) {
  console.info('[info]', ...args)
}

export function warn(...args: unknown[]) {
  console.warn('[warn]', ...args)
}
