export type Theme = 'light' | 'dark';

const KEY = 'narrative-studio.theme';

export function preferredTheme(): Theme {
  const stored = window.localStorage.getItem(KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(KEY, theme);
}
