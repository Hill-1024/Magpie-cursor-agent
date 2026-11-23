(() => {
  const titleEl = document.getElementById('boot-title');
  const statusEl = document.getElementById('boot-status');
  const fallbackEl = document.getElementById('boot-fallback');
  const hintEl = document.getElementById('boot-hint');
  const urlInputEl = document.getElementById('boot-url');
  const retryBtn = document.getElementById('boot-retry');

  function isZh(lang) {
    return String(lang || '').toLowerCase().startsWith('zh');
  }

  function applyLocale(theme) {
    const zh = isZh(theme?.lang || navigator.language);
    if (titleEl) titleEl.textContent = zh ? 'Cursor 角色模型' : 'Cursor Role Models';
    if (statusEl) statusEl.textContent = zh ? '正在连接本地配置服务…' : 'Connecting to local config service…';
    if (hintEl) {
      hintEl.textContent = zh
        ? '若页面未自动跳转，请确认插件服务已启动或重试：'
        : 'If the page does not redirect automatically, retry or open this local URL:';
    }
    if (retryBtn) retryBtn.textContent = zh ? '重试' : 'Retry';
  }

  function buildTargetUrl(theme) {
    const target = new URL(magpie.service || 'http://127.0.0.1:19381/', window.location.href);
    const pageOrigin = window.location.origin;
    if (pageOrigin && pageOrigin !== 'null') {
      target.searchParams.set('uiOrigin', pageOrigin);
    } else if (target.origin && target.origin !== 'null') {
      target.searchParams.set('uiOrigin', target.origin);
    }
    const lang = theme?.lang || magpie.theme?.lang || navigator.language || 'zh';
    target.searchParams.set('lang', lang);
    if (typeof theme?.dark === 'boolean') {
      target.searchParams.set('theme', theme.dark ? 'dark' : 'light');
    } else if (typeof magpie.theme?.dark === 'boolean') {
      target.searchParams.set('theme', magpie.theme.dark ? 'dark' : 'light');
    }
    return target.href;
  }

  function openLivePicker(theme) {
    applyLocale(theme);
    const href = buildTargetUrl(theme);
    if (urlInputEl) {
      urlInputEl.value = href;
      urlInputEl.onclick = () => urlInputEl.select();
    }
    setTimeout(() => {
      if (fallbackEl) fallbackEl.hidden = false;
    }, 3500);
    if (retryBtn) {
      retryBtn.onclick = () => window.location.replace(href);
    }
    window.location.replace(href);
  }

  applyLocale(magpie.theme);
  magpie.onTheme?.(applyLocale);
  magpie.ready.then(openLivePicker, () => openLivePicker(magpie.theme));
})();
