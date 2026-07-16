import { blueThemePackage } from './blue.js'

export const DEFAULT_THEME_PACKAGE = {
  id: 'default',
  label: '默认主题包',
  description: '保留控制台当前的经典紫色强调色。',
  version: '内置 1.0.0',
  author: 'QQ 控制台',
}

export const THEME_PACKAGES = [DEFAULT_THEME_PACKAGE, blueThemePackage]

export function getThemePackage(id) {
  return THEME_PACKAGES.find((item) => item.id === id) || DEFAULT_THEME_PACKAGE
}
