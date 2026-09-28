/**
 * Theme: light, dark, or follow-the-OS.
 *
 * "auto" leaves the `data-theme` attribute off so the `prefers-color-scheme`
 * rules in the stylesheet win; an explicit choice pins the attribute.
 */

import { state } from './state.js';

const THEME_KEY = 'trajectory.theme';

export function applyTheme(theme) {
  state.theme = theme;
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const button = document.getElementById('theme-toggle');
  if (button) {
    const showing = theme === 'auto' ? 'auto' : theme;
    button.textContent = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';
    button.title = `当前：${showing === 'auto' ? '跟随系统' : showing === 'light' ? '浅色' : '深色'} · 点击切换`;
  }
}

export function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch {
    /* storage is optional */
  }
  return 'auto';
}

/** The theme actually on screen, resolving "auto" against the OS preference. */
export function effectiveTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** One click flips light/dark, starting from whatever is currently showing. */
export function toggleTheme() {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage is optional */
  }
}
