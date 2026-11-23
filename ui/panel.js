(() => {
  const ui = globalThis.CursorBridgeUI;
  const titleEl = document.getElementById('panel-title');
  const subtitleEl = document.getElementById('panel-subtitle');
  const toastEl = document.getElementById('panel-toast');
  const rolesGridEl = document.getElementById('panel-roles-grid');
  const subtypesSummaryEl = document.getElementById('panel-subtypes-summary');
  const subtypesListEl = document.getElementById('panel-subtypes-list');
  const subtypesDetailsEl = document.getElementById('panel-subtypes-details');
  const statePillEl = document.getElementById('panel-state-pill');
  const modelPillEl = document.getElementById('panel-model-pill');
  const countPillEl = document.getElementById('panel-count-pill');
  const detailEl = document.getElementById('panel-detail');
  const routeNoteEl = document.getElementById('panel-route-note');
  const saveBtn = document.getElementById('panel-save-btn');
  const refreshBtn = document.getElementById('panel-refresh-btn');
  const addSubtypeBtn = document.getElementById('panel-add-subtype-btn');

  let currentLang = 'zh';
  let currentOptions = {};
  let catalogSignature = '';
  let runtimeMissing = false;

  function setToast(text, kind = 'ok') {
    toastEl.textContent = text || '';
    toastEl.dataset.kind = kind;
  }

  function readCatalog() {
    const catalog = globalThis.CursorBridgeCatalog;
    return catalog && typeof catalog === 'object'
      ? catalog
      : { enabled: false, defaultModel: '', models: [], roles: {}, sources: {}, status: null };
  }

  function hasRoleOverrides(state) {
    if (!state || typeof state !== 'object') return false;
    if (Object.values(state.roles || {}).some(Boolean)) return true;
    return Object.keys(state.subagentTypes || {}).length > 0;
  }

  function effectiveFormState() {
    const catalogState = ui.readOptionsToFormState(readCatalog().roles || {});
    if (hasRoleOverrides(catalogState)) return catalogState;
    return ui.readOptionsToFormState(currentOptions);
  }

  function signatureOf(catalog) {
    const status = catalog?.status || {};
    return JSON.stringify({
      models: (catalog?.models || []).map(entry => entry?.id).filter(Boolean),
      roles: catalog?.roles || {},
      state: status.state || null,
      port: status.port || null,
      model: status.model || null,
      count: status.modelsCount ?? null,
      detail: status.detail || '',
    });
  }

  function applyCopy(lang) {
    currentLang = lang || 'zh';
    const zh = ui.isZh(currentLang);
    titleEl.textContent = 'Cursor · Magpie Bridge';
    subtitleEl.textContent = zh
      ? '在主模型之外，为 Auto 路由控制、子代理、Bugbot、SecurityBot、标题、摘要、记忆与提交分别指定模型。'
      : 'Set dedicated models for Auto routing, subagents, Bugbot, SecurityBot, titles, summaries, memory, and commits.';
    routeNoteEl.innerHTML = zh
      ? 'Auto 控制模型留空时默认走 <span class="cb-code">cursor/auto</span>（目录只有 <span class="cb-code">cursor/auto-smart</span> 时用它）。这条控制链路只用于 Cursor 原生 Auto，反代出来的 <span class="cb-code">cursor/*</span> 模型照常由 Cursor 自己路由，不会回到本插件。'
      : 'An empty Auto router defaults to <span class="cb-code">cursor/auto</span> (or <span class="cb-code">cursor/auto-smart</span> when that is the catalogue entry). It applies only to Cursor native Auto; proxied <span class="cb-code">cursor/*</span> models keep Cursor’s own routing and never loop back here.';
    subtypesSummaryEl.textContent = zh
      ? '子代理细分类型覆盖 (explore / shell / generalPurpose / browser-use)'
      : 'Subagent type overrides (explore / shell / generalPurpose / browser-use)';
    saveBtn.textContent = zh ? '保存配置' : 'Save';
    refreshBtn.textContent = zh ? '刷新模型目录' : 'Refresh models';
    addSubtypeBtn.textContent = zh ? '+ 添加子代理类型' : '+ Add Subagent Type';
  }

  function renderStatus(catalog) {
    const status = catalog?.status || {};
    const bridgeState = status.state || (catalog?.enabled ? 'connecting' : 'disconnected');
    const portText = status.port ? ` :${status.port}` : '';
    statePillEl.dataset.state = bridgeState;
    statePillEl.textContent = `bridge: ${bridgeState}${portText}`;
    statePillEl.title = status.detail || '';
    const count = status.modelsCount ?? (Array.isArray(catalog?.models) ? catalog.models.length : 0);
    countPillEl.textContent = `models: ${count}`;
    modelPillEl.textContent = `main: ${status.model || catalog?.defaultModel || '-'}`;
    const detail = status.detail || '';
    detailEl.textContent = detail.length > 160 ? `${detail.slice(0, 157)}…` : detail;
    detailEl.title = detail;
    detailEl.hidden = !detail;
    if (!runtimeMissing && count === 0 && bridgeState !== 'connected') {
      detailEl.hidden = false;
      detailEl.textContent = ui.isZh(currentLang)
        ? '接入开关打开后，这里会自动出现 Magpie 模型目录；现在也可以先保存角色。'
        : 'Turn the agent switch on and the Magpie catalogue appears here; roles can be saved now.';
    }
  }

  function render({ preserveDraft = false } = {}) {
    const catalog = readCatalog();
    const draft = preserveDraft ? ui.readFormStateFromDom(rolesGridEl, subtypesListEl) : null;
    const formState = preserveDraft ? draft : effectiveFormState();
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    ui.renderRoleGrid(rolesGridEl, formState, { lang: currentLang, models, includeAll: true });
    ui.renderSubagentTypes(subtypesListEl, formState.subagentTypes, { lang: currentLang, models });
    if (Object.keys(formState.subagentTypes || {}).length > 0) {
      subtypesDetailsEl.open = true;
    }
    renderStatus(catalog);
    catalogSignature = signatureOf(catalog);
  }

  async function loadOptions() {
    const zh = ui.isZh(currentLang);
    try {
      const latest = await magpie.options.get();
      currentOptions = latest && typeof latest === 'object' ? latest : {};
      render();
      setToast('', 'info');
    } catch (error) {
      currentOptions = {};
      render();
      setToast(`${zh ? '读取插件选项失败' : 'Failed to load plugin options'}: ${error?.message || error}`, 'error');
    }
  }

  function loadRuntimeCatalog() {
    return new Promise(resolve => {
      const script = document.createElement('script');
      script.src = `catalog.runtime.js?t=${Date.now()}`;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        script.remove();
        resolve();
      };
      script.onload = finish;
      script.onerror = () => {
        runtimeMissing = true;
        finish();
      };
      document.head.appendChild(script);
      setTimeout(finish, 1800);
    });
  }

  async function refreshCatalog({ announce = false } = {}) {
    const previousSignature = catalogSignature;
    await loadRuntimeCatalog();
    const catalog = readCatalog();
    const nextSignature = signatureOf(catalog);
    if (nextSignature !== previousSignature) {
      render({ preserveDraft: true });
    } else {
      renderStatus(catalog);
    }
    if (announce) {
      const zh = ui.isZh(currentLang);
      const count = catalog.status?.modelsCount ?? (catalog.models || []).length;
      setToast(
        runtimeMissing
          ? zh
            ? '插件宿主尚未写入模型目录；请确认 Cursor · Magpie Bridge 已启用'
            : 'The plugin host has not published a catalogue yet; enable Cursor · Magpie Bridge'
          : zh
            ? `模型目录已刷新（${count} 个）`
            : `Catalogue refreshed (${count})`,
        runtimeMissing ? 'error' : 'ok'
      );
    }
  }

  async function saveOptions() {
    const zh = ui.isZh(currentLang);
    saveBtn.disabled = true;
    refreshBtn.disabled = true;
    setToast(zh ? '正在写入插件选项…' : 'Saving…', 'info');
    try {
      const formState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
      const nextOptions = ui.buildOptionsPayload(currentOptions, formState);
      const saved = await magpie.options.set(nextOptions);
      currentOptions = saved && typeof saved === 'object' ? saved : nextOptions;
      if (globalThis.CursorBridgeCatalog && typeof globalThis.CursorBridgeCatalog === 'object') {
        globalThis.CursorBridgeCatalog.roles = ui.buildServiceRolesPayload(formState);
      }
      render();
      setToast(
        zh
          ? '已保存；桥接约 1 秒内热生效（Magpie 可能重启一次插件宿主）'
          : 'Saved; the bridge picks it up within ~1s (Magpie may restart the plugin host once)',
        'ok'
      );
    } catch (error) {
      setToast(`${zh ? '保存失败' : 'Save failed'}: ${error?.message || error}`, 'error');
    } finally {
      saveBtn.disabled = false;
      refreshBtn.disabled = false;
    }
  }

  addSubtypeBtn.addEventListener('click', () => {
    const catalog = readCatalog();
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const existingKeys = new Set(
      Array.from(subtypesListEl.querySelectorAll('.cb-subtype-key')).map(input => input.value.trim())
    );
    const nextPreset = ui.SUBAGENT_PRESETS.find(preset => !existingKeys.has(preset)) || '';
    ui.appendSubagentTypeRow(subtypesListEl, nextPreset, '', { lang: currentLang, models });
    subtypesDetailsEl.open = true;
  });

  saveBtn.addEventListener('click', () => {
    saveOptions();
  });

  refreshBtn.addEventListener('click', () => {
    refreshCatalog({ announce: true });
  });

  magpie.onTheme(theme => {
    applyCopy(theme?.lang || currentLang);
    render({ preserveDraft: true });
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshCatalog({ announce: false });
    }
  }, 5000);

  magpie.ready.then(async info => {
    applyCopy(info?.lang || magpie.theme?.lang || 'zh');
    await loadOptions();
    await refreshCatalog({ announce: false });
  });
})();
