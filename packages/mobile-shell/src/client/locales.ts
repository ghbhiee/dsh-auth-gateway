/** Copy dictionaries for the narrow-viewport shell. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  openNav: '打开导航菜单',
  closeNav: '关闭导航菜单',
} satisfies Record<string, string>

/** Narrow-shell locale key union. */
export type MobileShellLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  openNav: 'Open navigation menu',
  closeNav: 'Close navigation menu',
} satisfies Record<MobileShellLocaleKey, string>
