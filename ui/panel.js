(() => {
  const ui = globalThis.CursorBridgeUI;
  const titleEl = document.getElementById('panel-title');
  const subtitleEl = document.getElementById('panel-subtitle');
  const toastEl = document.getElementById('panel-toast');
  const rolesGridEl = document.getElementById('panel-roles-grid');
  const subtypesSummaryEl = document.getElementById('panel-subtypes-summary');
  const subtypesListEl = document.getElementById('panel-subtypes-list');
  const subtypesDetailsEl = document.getElementById('panel-subtypes-details');
  const saveBtn = document.getElementById('panel-save-btn');
  const reloadBtn = document.getElementById('panel-reload-btn');
  const addSubtypeBtn = document.getElementById('panel-add-subtype-btn');

  let currentLang = 'zh';
  let currentOptions = {};

  function setToast(text, kind = 'ok') {
    toastEl.textContent = text || '';
    toastEl.dataset.kind = kind;
  }

  function applyCopy(lang) {
    currentLang = lang || 'zh';
    const zh = ui.isZh(currentLang);
    titleEl.textContent = zh ? 'Cursor 分角色模型配置' : 'Cursor Per-Role Model Routing';
    subtitleEl.textContent = zh
      ? '留空则沿用主模型；支持 modelId 或附加 [reasoning=high]。可在侧栏或行菜单打开插件页使用实时下拉目录。'
      : 'Leave empty to inherit the active main model. Supports optional reasoning override; open the plugin page for live model dropdowns.';
    subtypesSummaryEl.textContent = zh
      ? '按子代理类型覆盖 (explore / shell / generalPurpose / browser-use)'
      : 'Subagent type overrides (explore / shell / generalPurpose / browser-use)';
    saveBtn.textContent = zh ? '保存配置' : 'Save Options';
    reloadBtn.textContent = zh ? '重新加载' : 'Reload';
    addSubtypeBtn.textContent = zh ? '+ 添加子代理类型' : '+ Add Subagent Type';
  }

  function renderFromOptions(options) {
    currentOptions = options && typeof options === 'object' ? options : {};
    const state = ui.readOptionsToFormState(currentOptions);
    ui.renderRoleGrid(rolesGridEl, state, { lang: currentLang, includeAll: true });
    ui.renderSubagentTypes(subtypesListEl, state.subagentTypes, { lang: currentLang });
    if (Object.keys(state.subagentTypes).length > 0) {
      subtypesDetailsEl.open = true;
    }
  }

  async function loadOptions() {
    const zh = ui.isZh(currentLang);
    try {
      const latest = await magpie.options.get();
      renderFromOptions(latest);
      setToast('', 'info');
    } catch (error) {
      setToast(`${zh ? '读取失败' : 'Load failed'}: ${error?.message || error}`, 'error');
    }
  }

  async function saveOptions() {
    const zh = ui.isZh(currentLang);
    saveBtn.disabled = true;
    setToast(zh ? '正在保存...' : 'Saving...', 'info');
    try {
      const formState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
      const nextOptions = ui.buildOptionsPayload(currentOptions, formState);
      const saved = await magpie.options.set(nextOptions);
      renderFromOptions(saved);
      setToast(zh ? '已保存（约 1 秒内热生效）' : 'Saved (active within ~1s)', 'ok');
    } catch (error) {
      setToast(`${zh ? '保存失败' : 'Save failed'}: ${error?.message || error}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  addSubtypeBtn.addEventListener('click', () => {
    const existingKeys = new Set(
      Array.from(subtypesListEl.querySelectorAll('.cb-subtype-key')).map(input => input.value.trim())
    );
    const nextPreset = ui.SUBAGENT_PRESETS.find(preset => !existingKeys.has(preset)) || '';
    ui.appendSubagentTypeRow(subtypesListEl, nextPreset, '', { lang: currentLang });
    subtypesDetailsEl.open = true;
  });

  saveBtn.addEventListener('click', () => {
    saveOptions();
  });

  reloadBtn.addEventListener('click', () => {
    loadOptions();
  });

  magpie.onTheme(theme => {
    applyCopy(theme?.lang || currentLang);
    const draftState = ui.readFormStateFromDom(rolesGridEl, subtypesListEl);
    ui.renderRoleGrid(rolesGridEl, draftState, { lang: currentLang, includeAll: true });
    ui.renderSubagentTypes(subtypesListEl, draftState.subagentTypes, { lang: currentLang });
  });

  magpie.ready.then(async info => {
    applyCopy(info?.lang || magpie.theme?.lang || 'zh');
    await loadOptions();
  });
})();
