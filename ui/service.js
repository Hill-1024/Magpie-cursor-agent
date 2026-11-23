(() => {
  const ui = globalThis.CursorBridgeUI;
  const titleEl = document.getElementById('svc-title');
  const subtitleEl = document.getElementById('svc-subtitle');
  const refreshBtn = document.getElementById('svc-refresh-btn');
  const saveBtn = document.getElementById('svc-save-btn');
  const addSubtypeBtn = document.getElementById('svc-add-subtype-btn');
  const statePillEl = document.getElementById('svc-state-pill');
  const authPillEl = document.getElementById('svc-auth-pill');
  const modelPillEl = document.getElementById('svc-model-pill');
  const toastEl = document.getElementById('svc-toast');
  const rolesGridEl = document.getElementById('svc-roles-grid');
  const subtypesSummaryEl = document.getElementById('svc-subtypes-summary');
  const subtypesListEl = document.getElementById('svc-subtypes-list');

  const queryLang = new URLSearchParams(window.location.search).get('lang');
  const lang = queryLang || navigator.language || 'zh-CN';
  const zh = ui.isZh(lang);
  let catalogModels = [];

  function setToast(text, kind = 'ok') {
    toastEl.textContent = text || '';
    toastEl.dataset.kind = kind;
  }

  function applyCopy() {
    titleEl.textContent = zh ? 'Cursor 角色模型' : 'Cursor Role Models';
    subtitleEl.textContent = zh
      ? '从 Magpie 模型目录选取各角色专用模型；保存后写入 roles.json，桥接将在 1 秒内热生效。'
      : 'Select dedicated models from the Magpie catalog; saves hot-reload into roles.json within ~1s.';
    refreshBtn.textContent = zh ? '刷新状态' : 'Refresh';
    saveBtn.textContent = zh ? '保存热更新' : 'Save & Hot-Reload';
    subtypesSummaryEl.textContent = zh
      ? '子代理细分类型映射 (explore / shell / generalPurpose / browser-use)'
      : 'Subagent type overrides (explore / shell / generalPurpose / browser-use)';
    addSubtypeBtn.textContent = zh ? '+ 添加子代理类型' : '+ Add Subagent Type';
  }

  function renderStatusStrip(state) {
    const bridgeState = state?.status?.state || (state?.enabled ? 'connecting' : 'disconnected');
    statePillEl.dataset.state = bridgeState;
    const portText = state?.status?.port ? ` :${state.status.port}` : '';
    statePillEl.textContent = `bridge: ${bridgeState}${portText}`;
    statePillEl.title = state?.status?.detail || '';
    const count = state?.status?.modelsCount ?? catalogModels.length;
    authPillEl.textContent = zh ? `目录模型: ${count}` : `models: ${count}`;
    const activeMain = state?.status?.model || state?.defaultModel || '-';
    modelPillEl.textContent = `main: ${activeMain}`;
  }

  async function loadState() {
    setToast(zh ? '加载中...' : 'Loading...', 'info');
    try {
      const response = await fetch('./api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      catalogModels = Array.isArray(data.models) ? data.models : [];
      renderStatusStrip(data);
      const formState = ui.readOptionsToFormState(data.roles || {});
      ui.renderRoleGrid(rolesGridEl, formState, {
        lang,
        models: catalogModels,
        includeAll: true,
      });
      ui.renderSubagentTypes(subtypesListEl, formState.subagentTypes, {
        lang,
        models: catalogModels,
      });
      setToast(
        data?.status?.detail && (data?.status?.state === 'error' || data?.status?.state === 'paused')
          ? data.status.detail
          : catalogModels.length > 0
            ? ''
            : zh
              ? '未发现 Magpie 同步模型，请先在 Agents 列表连接 Cursor · Magpie Bridge（也可直接手动填写模型 ID）'
              : 'No synced models found yet; connect the agent first or type custom IDs.',
        data?.status?.detail && (data?.status?.state === 'error' || data?.status?.state === 'paused') ? 'error' : 'info'
      );
    } catch (error) {
      setToast(`${zh ? '加载失败' : 'Load failed'}: ${error?.message || error}`, 'error');
    }
  }

  async function saveRoles() {
    saveBtn.disabled = true;
    setToast(zh ? '正在写入 roles.json...' : 'Writing roles.json...', 'info');
    try {
      const formState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
      const payload = ui.buildServiceRolesPayload(formState);
      const response = await fetch('./api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setToast(zh ? '已保存并触发热更新' : 'Saved to roles.json (hot-reloading)', 'ok');
      await loadState();
      setToast(zh ? '已保存并触发热更新' : 'Saved to roles.json (hot-reloading)', 'ok');
    } catch (error) {
      setToast(`${zh ? '保存失败' : 'Save failed'}: ${error?.message || error}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => {
    loadState();
  });
  saveBtn.addEventListener('click', () => {
    saveRoles();
  });
  addSubtypeBtn.addEventListener('click', () => {
    const existingKeys = new Set(
      Array.from(subtypesListEl.querySelectorAll('.cb-subtype-key')).map(input => input.value.trim())
    );
    const nextPreset = ui.SUBAGENT_PRESETS.find(preset => !existingKeys.has(preset)) || '';
    ui.appendSubagentTypeRow(subtypesListEl, nextPreset, '', {
      lang,
      models: catalogModels,
    });
  });

  applyCopy();
  loadState();
})();
