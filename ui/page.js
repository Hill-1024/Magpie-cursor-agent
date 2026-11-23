(() => {
  function openLivePicker() {
    const target = new URL(magpie.service || 'http://127.0.0.1:19381/', window.location.href);
    if (target.origin && target.origin !== 'null') {
      target.searchParams.set('uiOrigin', target.origin);
    }
    target.searchParams.set('lang', magpie.theme?.lang || navigator.language || 'zh');
    window.location.replace(target.href);
  }

  magpie.ready.then(openLivePicker, openLivePicker);
})();
