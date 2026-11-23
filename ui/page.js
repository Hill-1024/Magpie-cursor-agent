(() => {
  const ui = globalThis.CursorBridgeUI;
  const titleEl = document.getElementById('page-title');
  const subtitleEl = document.getElementById('page-subtitle');
  const actionPillEl = document.getElementById('page-action-pill');
  const toastEl = document.getElementById('page-toast');
  const rolesGridEl = document.getElementById('page-roles-grid');
  const subtypesSummaryEl = document.getElementById('page-subtypes-summary');
  const subtypesListEl = document.getElementById('page-subtypes-list');
  const bannerTitleEl = document.getElementById('page-banner-title');
  const bannerDescEl = document.getElementById('page-banner-desc');
  const saveBtn = document.getElementById('page-save-btn');
  const resetBtn = document.getElementById('page-reset-btn');
  const openServiceBtn = document.getElementById('page-open-service-btn');
  const addSubtypeBtn = document.getElementById('page-add-subtype-btn');

  let currentLang = 'zh';
  let currentOptions = {};
  let servicePath = '';

  function setToast(text, kind = 'ok') {
    toastEl.textContent = text || '';
    toastEl.dataset.kind = kind;
  }

  function applyCopy(lang) {
    currentLang = lang || 'zh';
    const zh = ui.isZh(currentLang);
    titleEl.textContent = zh ? 'Cursor 角色模型路由' : 'Cursor Role Model Routing';
    subtitleEl.textContent = zh
      ? '为 Cursor 的 Auto 路由控制、子代理、Bugbot、SecurityBot、标题、摘要、记忆整理与提交信息分别指定模型；Auto 控制模型留空时默认用 cursor/auto，其余留空继承主模型。'
      : 'Assign dedicated models for Cursor Auto routing, subagents, Bugbot, SecurityBot, titles, summaries, memory, and commits. Auto router defaults to cursor/auto when empty.';
    bannerTitleEl.textContent = zh
      ? '需要从当前 Magpie 模型目录直接下拉选择并查看桥接状态？'
      : 'Want live dropdowns from Magpie models and bridge status diagnostics?';
    bannerDescEl.textContent = zh
      ? '打开插件本地服务页可直接挑选激活模型、查看 Cursor 认证与端口状态，并热更新 roles.json。'
      : 'Open the local plugin service to pick from active Magpie models, inspect status, and hot-save roles.json.';
    openServiceBtn.textContent = zh ? '打开实时模型选择器' : 'Open Live Picker & Status';
    subtypesSummaryEl.textContent = zh
      ? '子代理细分类型映射 (explore / shell / generalPurpose / browser-use)'
      : 'Subagent type overrides (explore / shell / generalPurpose / browser-use)';
    saveBtn.textContent = zh ? '保存到插件选项' : 'Save to Magpie Options';
    resetBtn.textContent = zh ? '清空角色覆盖' : 'Clear Overrides';
    addSubtypeBtn.textContent = zh ? '+ 添加子代理类型' : '+ Add Subagent Type';
  }

  function renderFromOptions(options) {
    currentOptions = options && typeof options === 'object' ? options : {};
    const state = ui.readOptionsToFormState(currentOptions);
    ui.renderRoleGrid(rolesGridEl, state, { lang: currentLang, includeAll: true });
    ui.renderSubagentTypes(subtypesListEl, state.subagentTypes, { lang: currentLang });
  }

  async function loadOptions() {
    const zh = ui.isZh(currentLang);
    try {
      const latest = await magpie.options.get();
      renderFromOptions(latest);
      setToast('', 'info');
    } catch (error) {
      setToast(`${zh ? '读取选项失败' : 'Failed to load options'}: ${error?.message || error}`, 'error');
    }
  }

  async function saveOptions(formState) {
    const zh = ui.isZh(currentLang);
    saveBtn.disabled = true;
    resetBtn.disabled = true;
    setToast(zh ? '正在写入插件选项...' : 'Saving options...', 'info');
    try {
      const nextOptions = ui.buildOptionsPayload(currentOptions, formState);
      const saved = await magpie.options.set(nextOptions);
      renderFromOptions(saved);
      setToast(zh ? '已保存至 Magpie 插件选项' : 'Saved to Magpie plugin options', 'ok');
    } catch (error) {
      setToast(`${zh ? '保存失败' : 'Save failed'}: ${error?.message || error}`, 'error');
    } finally {
      saveBtn.disabled = false;
      resetBtn.disabled = false;
    }
  }

  openServiceBtn.addEventListener('click', () => {
    const configuredPort = Number(currentOptions?.servicePort);
    const port =
      Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
        ? configuredPort
        : 19381;
    const targetUrl = servicePath || `http://127.0.0.1:${port}/`;
    window.location.href = targetUrl;
  });

  addSubtypeBtn.addEventListener('click', () => {
    const existingKeys = new Set(
      Array.from(subtypesListEl.querySelectorAll('.cb-subtype-key')).map(input => input.value.trim())
    );
    const nextPreset = ui.SUBAGENT_PRESETS.find(preset => !existingKeys.has(preset)) || '';
    ui.appendSubagentTypeRow(subtypesListEl, nextPreset, '', { lang: currentLang });
  });

  saveBtn.addEventListener('click', () => {
    const formState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
    saveOptions(formState);
  });

  resetBtn.addEventListener('click', () => {
    saveOptions({ roles: {}, subagentTypes: {} });
  });

  magpie.onAction(action => {
    if (!action) return;
    const label = action.agent?.name || action.agent?.id || action.id;
    if (label) {
      actionPillEl.textContent = label;
      actionPillEl.hidden = false;
    }
  });

  magpie.onTheme(theme => {
    applyCopy(theme?.lang || currentLang);
    const draftState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
    ui.renderRoleGrid(rolesGridEl, draftState, { lang: currentLang, includeAll: true });
    ui.renderSubagentTypes(subtypesListEl, draftState.subagentTypes, { lang: currentLang });
  });

  magpie.ready.then(async info => {
    servicePath = typeof info?.service === 'string' ? info.service : '';
    applyCopy(info?.lang || magpie.theme?.lang || 'zh');
    await loadOptions();
  });
})();
