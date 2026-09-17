// Applies the saved or system color theme before the first paint. Loaded without defer on purpose so there is no flash.
(function () {
  const root = document.documentElement, query = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    let saved = null; try { saved = localStorage.getItem('mesh-theme'); } catch {}
    if (saved === 'dark' || saved === 'light') root.dataset.theme = saved; else delete root.dataset.theme;
    const dark = saved === 'dark' || (!saved && query.matches);
    root.dataset.mode = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = dark ? '#14181d' : '#f4f5f7';
    const button = document.getElementById('theme-toggle');
    if (button) { button.textContent = dark ? '☀' : '☾'; button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); }
  }
  window.meshTheme = { apply, toggle() { const next = root.dataset.mode === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('mesh-theme', next); } catch {} apply(); } };
  query.addEventListener('change', apply);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  apply();
})();
