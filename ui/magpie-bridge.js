(() => {
  const params = new URLSearchParams(window.location.search);
  const queryTheme = params.get('theme');
  const queryLang = params.get('lang');
  const embedded = Boolean(window.parent && window.parent !== window);
  const listeners = new Set();
  const pending = new Map();
  let seq = 0;

  function detectInitialDark() {
    if (queryTheme === 'dark') return true;
    if (queryTheme === 'light') return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  const currentTheme = {
    dark: detectInitialDark(),
    lang: queryLang || navigator.language || 'zh-CN',
    tokens: {},
    embedded,
  };

  function applyThemePayload(payload) {
    if (!payload || typeof payload !== 'object') return currentTheme;
    if (typeof payload.dark === 'boolean') currentTheme.dark = payload.dark;
    if (typeof payload.lang === 'string' && payload.lang) currentTheme.lang = payload.lang;
    if (payload.tokens && typeof payload.tokens === 'object') {
      currentTheme.tokens = { ...payload.tokens };
    }
    const root = document.documentElement;
    root.dataset.theme = currentTheme.dark ? 'dark' : 'light';
    root.style.colorScheme = currentTheme.dark ? 'dark' : 'light';
    if (currentTheme.lang) {
      root.lang = currentTheme.lang;
    }
    for (const [key, value] of Object.entries(currentTheme.tokens)) {
      if (typeof key === 'string' && typeof value === 'string') {
        root.style.setProperty(`--magpie-${key}`, value);
      }
    }
    return currentTheme;
  }

  applyThemePayload(currentTheme);

  function notifyListeners() {
    for (const listener of listeners) {
      try {
        listener({ ...currentTheme });
      } catch {
        // Never let a listener failure break host theme propagation.
      }
    }
  }

  let readyResolve;
  const ready = new Promise(resolve => {
    readyResolve = resolve;
  });

  if (embedded) {
    window.addEventListener('message', event => {
      if (event.source !== window.parent) return;
      const msg = event.data;
      if (!msg || msg.magpie !== 1) return;
      if (msg.event === 'theme' && msg.data) {
        applyThemePayload(msg.data);
        notifyListeners();
        return;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });

    const callHost = (method, paramsPayload) => {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ magpie: 1, id, method, params: paramsPayload }, '*');
      });
    };

    const fallbackTimer = setTimeout(() => {
      readyResolve({ ...currentTheme });
    }, 1200);

    callHost('hello')
      .then(result => {
        clearTimeout(fallbackTimer);
        if (result && typeof result === 'object') {
          applyThemePayload(result);
        }
        readyResolve({ ...currentTheme });
        notifyListeners();
      })
      .catch(() => {
        clearTimeout(fallbackTimer);
        readyResolve({ ...currentTheme });
      });

    let lastHeight = -1;
    const reportHeight = () => {
      const nextHeight = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (nextHeight > 0 && nextHeight !== lastHeight) {
        lastHeight = nextHeight;
        window.parent.postMessage({ magpie: 1, method: 'size', params: { height: nextHeight } }, '*');
      }
    };
    const startObserver = () => {
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(reportHeight).observe(document.documentElement);
      }
      reportHeight();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
      startObserver();
    }
  } else {
    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onMediaChange = event => {
        if (!queryTheme) {
          applyThemePayload({ dark: event.matches });
          notifyListeners();
        }
      };
      media.addEventListener?.('change', onMediaChange);
    }
    readyResolve({ ...currentTheme });
  }

  globalThis.CursorBridgeHost = {
    embedded,
    ready,
    getTheme: () => ({ ...currentTheme }),
    onTheme: listener => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
