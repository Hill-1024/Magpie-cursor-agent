(() => {
  const ui = globalThis.CursorBridgeUI;
  const hostBridge = globalThis.CursorBridgeHost;

  const titleEl = document.getElementById('svc-title');
  const subtitleEl = document.getElementById('svc-subtitle');
  const metaLineEl = document.getElementById('svc-meta-line');
  const syncPillEl = document.getElementById('svc-sync-pill');
  const syncTextEl = document.getElementById('svc-sync-text');
  const retryBtn = document.getElementById('svc-retry-btn');
  const noticeEl = document.getElementById('svc-notice');
  const noticeTextEl = document.getElementById('svc-notice-text');
  const secRoutingLabelEl = document.getElementById('svc-sec-routing-label');
  const secTasksLabelEl = document.getElementById('svc-sec-tasks-label');
  const routingListEl = document.getElementById('svc-routing-list');
  const tasksListEl = document.getElementById('svc-tasks-list');
  const footerNoteEl = document.getElementById('svc-footer-note');
  const resetAllBtn = document.getElementById('svc-reset-all-btn');

  const pickerEl = document.getElementById('svc-picker');
  const pickerSearchEl = document.getElementById('svc-picker-search');
  const pickerClearQEl = document.getElementById('svc-picker-clear-q');
  const pickerProvidersEl = document.getElementById('svc-picker-providers');
  const pickerListEl = document.getElementById('svc-picker-list');
  const pickerCustomInputEl = document.getElementById('svc-picker-custom-input');
  const pickerCustomApplyBtn = document.getElementById('svc-picker-custom-apply');

  const queryLang = new URLSearchParams(window.location.search).get('lang');
  let currentLang = hostBridge?.getTheme?.().lang || queryLang || navigator.language || 'zh-CN';
  let serverState = null;
  let catalogModels = [];
  let formRoles = {};
  let subtypeRows = [];
  let subtypeSeq = 0;
  let activeInputUid = null;
  let lastServerRolesSig = '';
  let lastSavedPayloadSig = '';
  let lastModelsSig = '';
  let syncStatus = { kind: 'connecting', text: '', error: false };
  let saveTimer = null;
  let saveInFlight = false;
  let saveQueued = false;
  let resetConfirmTimer = null;
  let resetConfirmArmed = false;
  let eventSource = null;
  let fallbackPollTimer = null;

  const pickerState = {
    open: false,
    target: null,
    anchorEl: null,
    query: '',
    provider: '',
    focusedIndex: -1,
    optionValues: [],
  };

  function isZh() {
    return ui.isZh(currentLang);
  }

  function nextSubtypeUid() {
    subtypeSeq += 1;
    return `sub-${subtypeSeq}`;
  }

  function formStateSnapshot() {
    const subagentTypes = {};
    for (const row of subtypeRows) {
      const cleanType = String(row.typeName || '').replace(/[\r\n\0]/g, '').trim();
      const cleanModel = String(row.modelRef || '').trim();
      if (cleanType && cleanModel) {
        subagentTypes[cleanType] = cleanModel;
      }
    }
    return { roles: { ...formRoles }, subagentTypes };
  }

  function normalizePayloadSignature(payload) {
    const clean = { subagentTypes: {} };
    for (const def of ui.ROLE_DEFS) {
      clean[def.key] = String(payload?.[def.key] || '');
    }
    const rawTypes = payload?.subagentTypes || {};
    for (const key of Object.keys(rawTypes).sort()) {
      const val = String(rawTypes[key] || '').trim();
      if (val) clean.subagentTypes[key] = val;
    }
    return JSON.stringify(clean);
  }

  function currentPayloadSignature() {
    return normalizePayloadSignature(ui.buildServiceRolesPayload(formStateSnapshot()));
  }

  function countOverrides() {
    let count = 0;
    for (const def of ui.ROLE_DEFS) {
      if (formRoles[def.key]) count += 1;
    }
    for (const row of subtypeRows) {
      if (row.typeName.trim() && row.modelRef.trim()) count += 1;
    }
    return count;
  }

  function hasAnyDraftOrOverride() {
    if (Object.values(formRoles).some(Boolean)) return true;
    return subtypeRows.length > 0;
  }

  function setSyncPill(kind, text, showRetry = false) {
    syncStatus = { kind, text, error: showRetry };
    syncPillEl.dataset.kind = kind;
    syncTextEl.textContent = text;
    retryBtn.hidden = !showRetry;
  }

  function updateSyncStatusFromBridge() {
    const zh = isZh();
    if (syncStatus.error || saveInFlight || saveQueued || saveTimer) return;
    const bridgeState = serverState?.status?.state || (serverState?.enabled ? 'connecting' : 'disconnected');
    const liveRolesSig = serverState?.status?.roles
      ? normalizePayloadSignature(serverState.status.roles)
      : '';
    const desiredSig = lastSavedPayloadSig || currentPayloadSignature();

    if (lastSavedPayloadSig) {
      if (bridgeState === 'connected' && liveRolesSig === desiredSig) {
        setSyncPill('ok', zh ? '已热生效' : 'Live');
        return;
      }
      if (bridgeState === 'connected') {
        setSyncPill('pending', zh ? '已保存 · 等待热生效' : 'Saved · applying…');
        return;
      }
      setSyncPill('ok', zh ? '已保存至 roles.json' : 'Saved to roles.json');
      return;
    }

    if (bridgeState === 'connected') {
      setSyncPill('ok', zh ? '实时同步中' : 'Synced live');
    } else if (bridgeState === 'connecting' || bridgeState === 'starting') {
      setSyncPill('connecting', zh ? '桥接启动中…' : 'Connecting…');
    } else if (bridgeState === 'error' || bridgeState === 'paused') {
      setSyncPill('error', zh ? '桥接异常' : 'Bridge issue');
    } else {
      setSyncPill('idle', zh ? '等待接入' : 'Standby');
    }
  }

  function applyStaticCopy() {
    const zh = isZh();
    document.title = zh ? 'Cursor 角色模型' : 'Cursor Role Models';
    titleEl.textContent = zh ? 'Cursor 角色模型' : 'Cursor Role Models';
    subtitleEl.textContent = zh
      ? '按职责覆盖默认主模型；更改即自动保存，约 1 秒内热生效。'
      : 'Override the active model by role; edits save automatically and hot-reload in ~1s.';
    secRoutingLabelEl.textContent = zh ? '路由与子代理' : 'Routing & Subagents';
    secTasksLabelEl.textContent = zh ? '专项与后台' : 'Specialized Tasks';
    footerNoteEl.textContent = zh
      ? '配置实时写入 roles.json，无需重启 Cursor'
      : 'Saved live to roles.json; no Cursor restart needed';
    retryBtn.textContent = zh ? '重试' : 'Retry';
    pickerSearchEl.placeholder = zh ? '搜索模型名称、ID 或供应商…' : 'Search model name, ID, or provider…';
    pickerClearQEl.setAttribute('aria-label', zh ? '清除搜索' : 'Clear search');
    pickerCustomInputEl.placeholder = zh ? '输入自定义模型 ID 后按 Enter' : 'Custom model ID, then Enter';
    pickerCustomApplyBtn.textContent = zh ? '使用' : 'Apply';
    updateResetAllButton();
  }

  function updateResetAllButton() {
    const zh = isZh();
    resetAllBtn.hidden = !hasAnyDraftOrOverride();
    resetAllBtn.classList.toggle('is-confirm', resetConfirmArmed);
    resetAllBtn.textContent = resetConfirmArmed
      ? zh
        ? '再次点击确认清空全部覆盖'
        : 'Click again to clear all'
      : zh
        ? '恢复全部为默认'
        : 'Reset all to default';
  }

  function renderHeaderMeta() {
    const zh = isZh();
    const status = serverState?.status || {};
    const bridgeState = status.state || (serverState?.enabled ? 'connecting' : 'disconnected');
    const portText = status.port ? ` :${status.port}` : '';
    const count = status.modelsCount ?? catalogModels.length;
    const activeMain = status.model || serverState?.defaultModel || '-';
    const overrideCount = countOverrides();

    metaLineEl.replaceChildren();

    const dot = document.createElement('span');
    dot.className = 'cb-meta-dot';
    if (bridgeState === 'connected') dot.classList.add('is-connected');
    else if (bridgeState === 'error') dot.classList.add('is-error');
    else if (bridgeState === 'paused' || bridgeState === 'connecting' || bridgeState === 'starting') {
      dot.classList.add('is-warning');
    }

    const stateText =
      bridgeState === 'connected'
        ? `${zh ? '已连接' : 'Connected'}${portText}`
        : bridgeState === 'paused'
          ? zh
            ? '已暂停'
            : 'Paused'
          : bridgeState === 'error'
            ? zh
              ? '连接异常'
              : 'Error'
            : bridgeState === 'connecting' || bridgeState === 'starting'
              ? zh
                ? '连接中'
                : 'Connecting'
              : zh
                ? '未接入'
                : 'Disconnected';

    const stateSpan = document.createElement('span');
    stateSpan.textContent = stateText;

    const sep1 = document.createElement('span');
    sep1.textContent = '·';
    const countSpan = document.createElement('span');
    countSpan.textContent = zh ? `${count} 个模型` : `${count} models`;

    const sep2 = document.createElement('span');
    sep2.textContent = '·';
    const mainLabel = document.createElement('span');
    mainLabel.textContent = zh ? '主模型' : 'Main';
    const mainCode = document.createElement('code');
    mainCode.textContent = activeMain;

    metaLineEl.append(dot, stateSpan, sep1, countSpan, sep2, mainLabel, mainCode);

    if (overrideCount > 0) {
      const sep3 = document.createElement('span');
      sep3.textContent = '·';
      const overSpan = document.createElement('span');
      overSpan.textContent = zh ? `已覆盖 ${overrideCount} 项` : `${overrideCount} custom`;
      metaLineEl.append(sep3, overSpan);
    }

    const detail = status.detail || '';
    if (bridgeState === 'error' || bridgeState === 'paused') {
      noticeEl.hidden = false;
      noticeEl.dataset.kind = bridgeState === 'error' ? 'error' : 'warning';
      noticeTextEl.textContent =
        detail ||
        (zh
          ? '后台桥接暂时不可用，请检查 Magpie Agents 状态；当前修改仍会保存在 roles.json。'
          : 'Bridge requires attention; check Magpie Agents. Edits still save to roles.json.');
    } else if (catalogModels.length === 0) {
      noticeEl.hidden = false;
      noticeEl.dataset.kind = 'warning';
      noticeTextEl.textContent = zh
        ? '未检测到同步模型目录。请在 Magpie 的 Agents 页开启 Cursor · Magpie Bridge（打开后页面会自动同步，当前也可手动输入模型 ID）。'
        : 'No synced model catalogue yet. Enable Cursor · Magpie Bridge in Magpie Agents (this page updates automatically; custom IDs also work).';
    } else {
      noticeEl.hidden = true;
    }
  }

  function createChevronSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cb-chevron');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4.5 6.25L8 9.75L11.5 6.25');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.45');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function buildModelTrigger(modelId, { roleKey = '', uid = '', target }) {
    const zh = isZh();
    const isAutoRouter = roleKey === 'autoRouter';
    const entry = ui.getModelEntry(catalogModels, modelId);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cb-model-pill';
    const isExpanded =
      pickerState.open &&
      pickerState.target &&
      pickerState.target.kind === target.kind &&
      (target.kind === 'role' ? pickerState.target.key === roleKey : pickerState.target.uid === uid);
    btn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    btn.setAttribute('aria-haspopup', 'listbox');

    if (modelId) {
      btn.classList.add('is-set');
      const display = ui.splitModelDisplay(entry || modelId, zh);
      const dot = document.createElement('span');
      dot.className = 'cb-provider-dot';
      dot.style.background = ui.providerColorFor(display.providerKey);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'cb-model-pill-label';
      labelSpan.textContent = display.shortName;

      btn.append(dot, labelSpan);

      if (display.providerLabel && display.providerLabel !== display.shortName) {
        const subSpan = document.createElement('span');
        subSpan.className = 'cb-model-pill-sub';
        subSpan.textContent = `· ${display.providerLabel}`;
        btn.appendChild(subSpan);
      }

      const ctxLabel = entry ? ui.formatContextLabel(entry.context) : '';
      if (ctxLabel) {
        const ctxSpan = document.createElement('span');
        ctxSpan.className = 'cb-pill-ctx';
        ctxSpan.textContent = ctxLabel;
        btn.appendChild(ctxSpan);
      }

      btn.title = entry
        ? `${entry.name || entry.id} (${entry.id})`
        : `${modelId}${zh ? '（自定义模型 ID）' : ' (custom model ID)'}`;
    } else {
      const labelSpan = document.createElement('span');
      labelSpan.className = 'cb-model-pill-label';
      labelSpan.textContent = isAutoRouter
        ? zh
          ? '默认 cursor/auto'
          : 'Default cursor/auto'
        : zh
          ? '沿用主模型'
          : 'Inherit main';
      btn.appendChild(labelSpan);
      btn.title = isAutoRouter
        ? zh
          ? '默认 cursor/auto，失败时用 cursor/auto-smart 重试'
          : 'Default cursor/auto, retrying cursor/auto-smart'
        : zh
          ? '未覆盖，沿用 Magpie 当前选中的主模型'
          : 'Inherits the active model selected in Magpie';
    }

    btn.appendChild(createChevronSvg());
    btn.addEventListener('click', event => {
      event.stopPropagation();
      togglePicker(target, btn);
    });
    return btn;
  }

  function buildEffortSelect(modelId, currentEffort, onChange) {
    const zh = isZh();
    const { choices, supportsEffort } = ui.getEffortChoices(catalogModels, modelId, currentEffort, zh);
    const selectEl = document.createElement('select');
    selectEl.className = 'cb-effort-pill';
    selectEl.setAttribute('aria-label', zh ? '推理强度' : 'Reasoning effort');

    for (const choice of choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.label;
      selectEl.appendChild(opt);
    }
    selectEl.value = currentEffort || '';

    if (!modelId) {
      selectEl.disabled = true;
      selectEl.title = zh ? '请先选定模型后再设置推理强度' : 'Pick a model before overriding effort';
    } else if (!supportsEffort) {
      selectEl.disabled = true;
      selectEl.title = zh ? '该模型未声明可调推理强度' : 'This model exposes no effort levels';
    } else {
      selectEl.title = zh ? '可选推理强度覆盖' : 'Optional reasoning effort override';
    }
    if (currentEffort) {
      selectEl.classList.add('is-set');
    }

    selectEl.addEventListener('change', () => {
      onChange(selectEl.value);
    });
    return selectEl;
  }

  function buildServiceTierSelect(modelId, currentTier, onChange) {
    const zh = isZh();
    const { choices, tiers, supportsFast } = ui.getServiceTierChoices(
      catalogModels,
      modelId,
      currentTier,
      zh
    );
    const selectEl = document.createElement('select');
    selectEl.className = 'cb-tier-pill';
    selectEl.setAttribute('aria-label', zh ? '加速档位' : 'Fast tier');

    for (const choice of choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.label;
      selectEl.appendChild(opt);
    }
    selectEl.value = currentTier || '';
    selectEl.hidden = !supportsFast;

    if (currentTier === 'off') {
      selectEl.classList.add('is-off');
      selectEl.title = zh ? '已显式关闭 Fast，按标准速度请求' : 'Fast explicitly disabled; uses standard speed';
    } else if (currentTier === 'ultrafast') {
      selectEl.classList.add('is-ultra');
      selectEl.title = zh ? '已启用 Ultrafast 极速档位' : 'Ultrafast tier enabled';
    } else if (currentTier) {
      selectEl.classList.add('is-fast');
      selectEl.title = zh ? `已启用加速档位：${currentTier}` : `Fast tier enabled: ${currentTier}`;
    } else if (tiers.length > 0) {
      const names = tiers.map(tier => tier.name || tier.id).join(' / ');
      selectEl.title = zh ? `可选加速档位：${names}` : `Available fast tiers: ${names}`;
    }

    selectEl.addEventListener('change', () => {
      onChange(selectEl.value);
    });
    return selectEl;
  }

  function createRoleRow(def) {
    const zh = isZh();
    const rawRef = formRoles[def.key] || '';
    const parsed = ui.parseModelRef(rawRef);

    const row = document.createElement('div');
    row.className = 'cb-row';
    row.dataset.roleKey = def.key;

    const main = document.createElement('div');
    main.className = 'cb-row-main';
    const title = document.createElement('div');
    title.className = 'cb-row-title';
    title.textContent = zh ? def.zhLabel : def.enLabel;
    const desc = document.createElement('p');
    desc.className = 'cb-row-desc';
    desc.textContent = zh ? def.zhDesc : def.enDesc;
    main.append(title, desc);

    const controls = document.createElement('div');
    controls.className = 'cb-row-controls';

    const trigger = buildModelTrigger(parsed.modelId, {
      roleKey: def.key,
      target: { kind: 'role', key: def.key },
    });
    const effortEl = buildEffortSelect(parsed.modelId, parsed.effort, nextEffort => {
      const latestParsed = ui.parseModelRef(formRoles[def.key] || '');
      formRoles[def.key] = ui.formatModelRef(latestParsed.modelId, nextEffort, latestParsed.serviceTier);
      renderLists();
      scheduleSave({ immediate: true });
    });
    const tierEl = buildServiceTierSelect(parsed.modelId, parsed.serviceTier, nextTier => {
      const latestParsed = ui.parseModelRef(formRoles[def.key] || '');
      formRoles[def.key] = ui.formatModelRef(latestParsed.modelId, latestParsed.effort, nextTier);
      renderLists();
      scheduleSave({ immediate: true });
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cb-icon-clear';
    clearBtn.textContent = '×';
    clearBtn.title = zh ? '清除覆盖，恢复默认' : 'Reset to default';
    clearBtn.setAttribute('aria-label', clearBtn.title);
    if (!rawRef) {
      clearBtn.classList.add('is-placeholder');
      clearBtn.tabIndex = -1;
    }
    clearBtn.addEventListener('click', () => {
      formRoles[def.key] = '';
      renderLists();
      scheduleSave({ immediate: true });
    });

    controls.append(trigger, effortEl, tierEl, clearBtn);
    row.append(main, controls);
    return row;
  }

  function createSubtypeRow(subRow) {
    const zh = isZh();
    const parsed = ui.parseModelRef(subRow.modelRef || '');
    const presetMeta = ui.SUBAGENT_PRESET_INFO[subRow.typeName];

    const row = document.createElement('div');
    row.className = 'cb-row cb-row-sub';
    row.dataset.subtypeUid = subRow.uid;

    const main = document.createElement('div');
    main.className = 'cb-row-main';
    const title = document.createElement('div');
    title.className = 'cb-row-title';

    if (presetMeta && !subRow.editableName) {
      const badge = document.createElement('span');
      badge.className = 'cb-subtype-badge';
      badge.textContent = subRow.typeName;
      title.appendChild(badge);
    } else {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'cb-subtype-name-input';
      nameInput.value = subRow.typeName;
      nameInput.placeholder = zh ? '子代理类型名' : 'subagent type';
      nameInput.setAttribute('aria-label', zh ? '子代理类型名' : 'Subagent type name');
      nameInput.addEventListener('focus', () => {
        activeInputUid = subRow.uid;
      });
      nameInput.addEventListener('input', () => {
        subRow.typeName = nameInput.value;
        updateResetAllButton();
        if (subRow.modelRef.trim()) {
          scheduleSave({ debounceMs: 350 });
        }
      });
      nameInput.addEventListener('blur', () => {
        if (activeInputUid === subRow.uid) activeInputUid = null;
        if ((subRow.typeName.trim() && subRow.modelRef.trim()) || currentPayloadSignature() !== lastServerRolesSig) {
          scheduleSave({ immediate: true });
        }
      });
      nameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          nameInput.blur();
        }
      });
      title.appendChild(nameInput);
    }

    const desc = document.createElement('p');
    desc.className = 'cb-row-desc';
    desc.textContent = presetMeta
      ? zh
        ? presetMeta.zh
        : presetMeta.en
      : zh
        ? '自定义子代理细分类型覆盖'
        : 'Custom subagent type override';
    main.append(title, desc);

    const controls = document.createElement('div');
    controls.className = 'cb-row-controls';

    const trigger = buildModelTrigger(parsed.modelId, {
      uid: subRow.uid,
      target: { kind: 'subtype', uid: subRow.uid },
    });
    const effortEl = buildEffortSelect(parsed.modelId, parsed.effort, nextEffort => {
      const latestParsed = ui.parseModelRef(subRow.modelRef || '');
      subRow.modelRef = ui.formatModelRef(latestParsed.modelId, nextEffort, latestParsed.serviceTier);
      renderLists();
      if (subRow.typeName.trim()) {
        scheduleSave({ immediate: true });
      }
    });
    const tierEl = buildServiceTierSelect(parsed.modelId, parsed.serviceTier, nextTier => {
      const latestParsed = ui.parseModelRef(subRow.modelRef || '');
      subRow.modelRef = ui.formatModelRef(latestParsed.modelId, latestParsed.effort, nextTier);
      renderLists();
      if (subRow.typeName.trim()) {
        scheduleSave({ immediate: true });
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cb-icon-clear';
    removeBtn.textContent = '×';
    removeBtn.title = zh ? '移除该类型覆盖' : 'Remove subagent override';
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => {
      subtypeRows = subtypeRows.filter(item => item.uid !== subRow.uid);
      if (pickerState.open && pickerState.target?.kind === 'subtype' && pickerState.target.uid === subRow.uid) {
        closePicker({ restoreFocus: false });
      }
      renderLists();
      scheduleSave({ immediate: true });
    });

    controls.append(trigger, effortEl, tierEl, removeBtn);
    row.append(main, controls);
    return row;
  }

  function createSubtypesBar() {
    const zh = isZh();
    const bar = document.createElement('div');
    bar.className = 'cb-subtypes-bar';

    const label = document.createElement('span');
    label.className = 'cb-subtypes-bar-label';
    label.textContent = zh
      ? '按子代理类型覆盖（可选）：'
      : 'Subagent type overrides (optional):';

    const chips = document.createElement('div');
    chips.className = 'cb-preset-chips';

    const existingLower = new Set(subtypeRows.map(row => row.typeName.trim().toLowerCase()).filter(Boolean));
    for (const preset of ui.SUBAGENT_PRESETS) {
      if (existingLower.has(preset.toLowerCase())) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cb-chip-add';
      chip.textContent = `+ ${preset}`;
      chip.title = zh ? ui.SUBAGENT_PRESET_INFO[preset]?.zh || preset : ui.SUBAGENT_PRESET_INFO[preset]?.en || preset;
      chip.addEventListener('click', event => {
        event.stopPropagation();
        const newRow = { uid: nextSubtypeUid(), typeName: preset, modelRef: '', editableName: false };
        subtypeRows.push(newRow);
        renderLists();
        const trigger = routingListEl.querySelector(`[data-subtype-uid="${newRow.uid}"] .cb-model-pill`);
        if (trigger) openPicker({ kind: 'subtype', uid: newRow.uid }, trigger);
      });
      chips.appendChild(chip);
    }

    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'cb-chip-add is-custom';
    customBtn.textContent = zh ? '+ 自定义类型' : '+ Custom type';
    customBtn.addEventListener('click', event => {
      event.stopPropagation();
      closePicker({ restoreFocus: false });
      const newRow = { uid: nextSubtypeUid(), typeName: '', modelRef: '', editableName: true };
      subtypeRows.push(newRow);
      renderLists();
      const input = routingListEl.querySelector(`[data-subtype-uid="${newRow.uid}"] .cb-subtype-name-input`);
      input?.focus();
    });
    chips.appendChild(customBtn);

    bar.append(label, chips);
    return bar;
  }

  function renderLists() {
    const routingDefs = ui.ROLE_DEFS.filter(def => def.group === 'routing');
    const taskDefs = ui.ROLE_DEFS.filter(def => def.group !== 'routing');

    routingListEl.replaceChildren();
    for (const def of routingDefs) {
      routingListEl.appendChild(createRoleRow(def));
    }
    for (const subRow of subtypeRows) {
      routingListEl.appendChild(createSubtypeRow(subRow));
    }
    routingListEl.appendChild(createSubtypesBar());

    tasksListEl.replaceChildren();
    for (const def of taskDefs) {
      tasksListEl.appendChild(createRoleRow(def));
    }

    if (pickerState.open && pickerState.target) {
      const selector =
        pickerState.target.kind === 'role'
          ? `[data-role-key="${pickerState.target.key}"] .cb-model-pill`
          : `[data-subtype-uid="${pickerState.target.uid}"] .cb-model-pill`;
      const refreshedAnchor = document.querySelector(selector);
      if (refreshedAnchor) {
        pickerState.anchorEl = refreshedAnchor;
      }
    }

    updateResetAllButton();
    renderHeaderMeta();
  }

  function currentTargetModelRef(target) {
    if (!target) return '';
    if (target.kind === 'role') return formRoles[target.key] || '';
    const found = subtypeRows.find(row => row.uid === target.uid);
    return found ? found.modelRef || '' : '';
  }

  function applyModelSelection(target, nextModelId) {
    const currentRef = currentTargetModelRef(target);
    const parsed = ui.parseModelRef(currentRef);
    const incomingParsed = ui.parseModelRef(String(nextModelId || '').trim());
    const cleanModelId = incomingParsed.modelId;

    let nextEffort = incomingParsed.effort || parsed.effort || '';
    let nextTier = incomingParsed.serviceTier || parsed.serviceTier || '';
    if (!cleanModelId) {
      nextEffort = '';
      nextTier = '';
    } else {
      const entry = ui.getModelEntry(catalogModels, cleanModelId);
      if (nextEffort && entry && Array.isArray(entry.efforts)) {
        const supported = new Set(entry.efforts.map(v => String(v || '').toLowerCase()));
        if (!supported.has(nextEffort.toLowerCase())) {
          nextEffort = '';
        }
      }
      if (nextTier && entry) {
        const tiers = ui.normalizeModelServiceTiers(entry);
        if (tiers.length === 0) {
          nextTier = '';
        } else if (nextTier !== 'off' && !tiers.some(t => t.id === nextTier)) {
          if (nextTier === 'priority' && tiers.some(t => t.id === 'fast')) {
            nextTier = 'fast';
          } else if (nextTier === 'fast' && tiers.some(t => t.id === 'priority')) {
            nextTier = 'priority';
          } else if (nextTier === 'ultrafast') {
            const fallback = tiers.find(t => t.id === 'priority' || t.id === 'fast');
            nextTier = fallback ? fallback.id : '';
          } else {
            nextTier = '';
          }
        }
      }
    }
    const nextRef = ui.formatModelRef(cleanModelId, nextEffort, nextTier);

    if (target.kind === 'role') {
      formRoles[target.key] = nextRef;
      renderLists();
      scheduleSave({ immediate: true });
    } else {
      const found = subtypeRows.find(row => row.uid === target.uid);
      if (found) {
        found.modelRef = nextRef;
        renderLists();
        if (found.typeName.trim()) {
          scheduleSave({ immediate: true });
        }
      }
    }
  }

  function renderPickerContent() {
    const zh = isZh();
    const currentRef = currentTargetModelRef(pickerState.target);
    const activeModelId = ui.parseModelRef(currentRef).modelId;
    const isAutoRouter = pickerState.target?.kind === 'role' && pickerState.target.key === 'autoRouter';
    const result = ui.filterAndGroupModels(catalogModels, {
      query: pickerState.query,
      provider: pickerState.provider,
      zh,
    });

    pickerClearQEl.hidden = !pickerState.query;

    pickerProvidersEl.replaceChildren();
    if (result.providers.length > 1) {
      pickerProvidersEl.hidden = false;
      const allTab = document.createElement('button');
      allTab.type = 'button';
      allTab.className = 'cb-provider-tab';
      allTab.setAttribute('role', 'tab');
      allTab.setAttribute('aria-selected', pickerState.provider === '' ? 'true' : 'false');
      const allCount = document.createElement('span');
      allCount.className = 'cb-provider-count';
      allCount.textContent = String(result.total);
      allTab.append(document.createTextNode(zh ? '全部 ' : 'All '), allCount);
      allTab.addEventListener('click', event => {
        event.stopPropagation();
        pickerState.provider = '';
        pickerState.focusedIndex = -1;
        renderPickerContent();
        pickerSearchEl.focus();
      });
      pickerProvidersEl.appendChild(allTab);

      for (const prov of result.providers) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'cb-provider-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', pickerState.provider === prov.key ? 'true' : 'false');
        const dot = document.createElement('span');
        dot.className = 'cb-provider-dot';
        dot.style.background = prov.color;
        const count = document.createElement('span');
        count.className = 'cb-provider-count';
        count.textContent = String(prov.count);
        tab.append(dot, document.createTextNode(`${prov.label} `), count);
        tab.addEventListener('click', event => {
          event.stopPropagation();
          pickerState.provider = pickerState.provider === prov.key ? '' : prov.key;
          pickerState.focusedIndex = -1;
          renderPickerContent();
          pickerSearchEl.focus();
        });
        pickerProvidersEl.appendChild(tab);
      }
    } else {
      pickerProvidersEl.hidden = true;
    }

    pickerListEl.replaceChildren();
    pickerState.optionValues = [];

    const queryLower = pickerState.query.trim().toLowerCase();
    const showDefaultOption =
      !pickerState.provider &&
      (!queryLower ||
        'default inherit auto cursor/auto 默认 沿用主模型'.includes(queryLower));

    const appendOption = ({ value, titleText, subText, ctxLabel = '', serviceTiers = [], color = '' }) => {
      const optIndex = pickerState.optionValues.length;
      pickerState.optionValues.push(value);

      const optBtn = document.createElement('button');
      optBtn.type = 'button';
      optBtn.className = 'cb-picker-option';
      optBtn.setAttribute('role', 'option');
      optBtn.dataset.modelId = value;
      const selected = activeModelId === value;
      optBtn.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (optIndex === pickerState.focusedIndex) {
        optBtn.classList.add('is-focused');
      }

      const optMain = document.createElement('div');
      optMain.className = 'cb-picker-opt-main';
      const optTop = document.createElement('div');
      optTop.className = 'cb-picker-opt-top';
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'cb-provider-dot';
        dot.style.background = color;
        optTop.appendChild(dot);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'cb-picker-opt-name';
      nameSpan.textContent = titleText;
      optTop.appendChild(nameSpan);
      optMain.appendChild(optTop);

      if (subText) {
        const idSpan = document.createElement('div');
        idSpan.className = 'cb-picker-opt-id';
        idSpan.textContent = subText;
        optMain.appendChild(idSpan);
      }

      const optMeta = document.createElement('div');
      optMeta.className = 'cb-picker-opt-meta';
      if (Array.isArray(serviceTiers) && serviceTiers.length > 0) {
        const fastBadge = document.createElement('span');
        const hasUltra = serviceTiers.some(tier => tier.id === 'ultrafast');
        fastBadge.className = hasUltra ? 'cb-badge-fast is-ultra' : 'cb-badge-fast';
        fastBadge.textContent = serviceTiers.map(tier => tier.name || tier.id).join(' / ');
        optMeta.appendChild(fastBadge);
      }
      if (ctxLabel) {
        const ctxBadge = document.createElement('span');
        ctxBadge.className = 'cb-badge-ctx';
        ctxBadge.textContent = ctxLabel;
        optMeta.appendChild(ctxBadge);
      }
      if (selected) {
        const check = document.createElement('span');
        check.className = 'cb-check-mark';
        check.textContent = '✓';
        optMeta.appendChild(check);
      }

      optBtn.append(optMain, optMeta);
      optBtn.addEventListener('click', () => {
        const target = pickerState.target;
        closePicker({ restoreFocus: false });
        applyModelSelection(target, value);
      });
      pickerListEl.appendChild(optBtn);
    };

    if (showDefaultOption) {
      const mainModel = serverState?.status?.model || serverState?.defaultModel || '';
      appendOption({
        value: '',
        titleText: isAutoRouter
          ? zh
            ? '默认 · cursor/auto'
            : 'Default · cursor/auto'
          : zh
            ? '沿用主模型（默认）'
            : 'Inherit main model (default)',
        subText: isAutoRouter
          ? zh
            ? '仅作用于原生 Auto，失败时自动重试 cursor/auto-smart'
            : 'Native Auto only; retries cursor/auto-smart on failure'
          : mainModel
            ? `${zh ? '当前主模型：' : 'Active: '}${mainModel}`
            : zh
              ? '随 Magpie 当前选定的主模型切换'
              : 'Follows active model selected in Magpie',
      });
    }

    for (const group of result.groups) {
      const groupHeader = document.createElement('div');
      groupHeader.className = 'cb-picker-group-label';
      const dot = document.createElement('span');
      dot.className = 'cb-provider-dot';
      dot.style.background = group.color;
      groupHeader.append(dot, document.createTextNode(group.label));
      pickerListEl.appendChild(groupHeader);

      for (const item of group.items) {
        appendOption({
          value: item.id,
          titleText: item.shortName,
          subText: item.id,
          ctxLabel: ui.formatContextLabel(item.context),
          serviceTiers: ui.normalizeModelServiceTiers(item),
          color: group.color,
        });
      }
    }

    const trimmedQuery = pickerState.query.trim();
    const exactHit = trimmedQuery && result.filtered.some(item => item.id === trimmedQuery);
    if (trimmedQuery && !exactHit && !pickerState.provider) {
      appendOption({
        value: trimmedQuery,
        titleText: zh ? '使用自定义模型 ID' : 'Use custom model ID',
        subText: trimmedQuery,
      });
    }

    if (pickerState.optionValues.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cb-picker-empty';
      empty.textContent =
        catalogModels.length === 0
          ? zh
            ? '暂无同步目录，可在下方直接输入模型 ID'
            : 'No synced models yet; enter a custom model ID below'
          : zh
            ? '没有匹配的模型，可清除筛选或直接输入 ID'
            : 'No matching models; clear filter or enter a custom ID';
      pickerListEl.appendChild(empty);
    }

    if (activeModelId && !ui.getModelEntry(catalogModels, activeModelId)) {
      pickerCustomInputEl.value = activeModelId;
    } else if (!pickerCustomInputEl.matches(':focus')) {
      pickerCustomInputEl.value = '';
    }
  }

  function positionPicker() {
    if (!pickerState.open || !pickerState.anchorEl || !document.body.contains(pickerState.anchorEl)) return;
    const rect = pickerState.anchorEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const pickerWidth = Math.min(420, viewportW - 20);
    pickerEl.style.width = `${pickerWidth}px`;

    let left = rect.right - pickerWidth;
    if (left < 10) left = Math.max(10, Math.min(rect.left, viewportW - pickerWidth - 10));
    pickerEl.style.left = `${Math.round(left)}px`;

    const spaceBelow = viewportH - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const maxHeight = Math.min(460, Math.max(220, Math.max(spaceBelow, spaceAbove)));
    pickerEl.style.maxHeight = `${Math.round(maxHeight)}px`;

    const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    if (placeAbove) {
      pickerEl.style.top = 'auto';
      pickerEl.style.bottom = `${Math.round(viewportH - rect.top + 6)}px`;
    } else {
      pickerEl.style.bottom = 'auto';
      pickerEl.style.top = `${Math.round(Math.min(rect.bottom + 6, viewportH - 120))}px`;
    }
  }

  function openPicker(target, anchorEl) {
    pickerState.open = true;
    pickerState.target = target;
    pickerState.anchorEl = anchorEl;
    pickerState.query = '';
    pickerState.provider = '';
    pickerState.focusedIndex = -1;
    pickerSearchEl.value = '';
    pickerEl.hidden = false;
    renderLists();
    renderPickerContent();
    positionPicker();
    pickerSearchEl.focus();
  }

  function closePicker({ restoreFocus = true } = {}) {
    if (!pickerState.open) return;
    const previousTarget = pickerState.target;
    pickerState.open = false;
    pickerEl.hidden = true;
    pickerState.target = null;
    pickerState.anchorEl = null;
    renderLists();
    if (restoreFocus && previousTarget) {
      const selector =
        previousTarget.kind === 'role'
          ? `[data-role-key="${previousTarget.key}"] .cb-model-pill`
          : `[data-subtype-uid="${previousTarget.uid}"] .cb-model-pill`;
      document.querySelector(selector)?.focus();
    }
  }

  function togglePicker(target, anchorEl) {
    const sameTarget =
      pickerState.open &&
      pickerState.target &&
      pickerState.target.kind === target.kind &&
      (target.kind === 'role' ? pickerState.target.key === target.key : pickerState.target.uid === target.uid);
    if (sameTarget) {
      closePicker({ restoreFocus: true });
    } else {
      openPicker(target, anchorEl);
    }
  }

  function updateFocusedOption(delta) {
    const total = pickerState.optionValues.length;
    if (total === 0) return;
    if (pickerState.focusedIndex < 0) {
      pickerState.focusedIndex = delta > 0 ? 0 : total - 1;
    } else {
      pickerState.focusedIndex = (pickerState.focusedIndex + delta + total) % total;
    }
    const options = pickerListEl.querySelectorAll('.cb-picker-option');
    options.forEach((opt, idx) => {
      const active = idx === pickerState.focusedIndex;
      opt.classList.toggle('is-focused', active);
      if (active) opt.scrollIntoView({ block: 'nearest' });
    });
  }

  async function persistRolesNow() {
    if (saveInFlight) {
      saveQueued = true;
      return;
    }
    const zh = isZh();
    saveInFlight = true;
    setSyncPill('saving', zh ? '保存中…' : 'Saving…', false);
    try {
      const payload = ui.buildServiceRolesPayload(formStateSnapshot());
      const sentSig = normalizePayloadSignature(payload);
      const response = await fetch('./api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      lastSavedPayloadSig = sentSig;
      lastServerRolesSig = sentSig;
      syncStatus = { kind: 'ok', text: '', error: false };
    } catch (error) {
      setSyncPill('error', `${zh ? '保存失败' : 'Save failed'}: ${error?.message || error}`, true);
    } finally {
      saveInFlight = false;
      if (saveQueued) {
        saveQueued = false;
        persistRolesNow();
      } else {
        updateSyncStatusFromBridge();
      }
    }
  }

  function scheduleSave({ immediate = false, debounceMs = 300 } = {}) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    resetConfirmArmed = false;
    if (immediate) {
      persistRolesNow();
      return;
    }
    const zh = isZh();
    setSyncPill('pending', zh ? '等待保存…' : 'Pending save…', false);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistRolesNow();
    }, debounceMs);
  }

  function hydrateRolesFromServer(rawRoles) {
    const parsed = ui.readOptionsToFormState(rawRoles || {});
    formRoles = { ...parsed.roles };
    subtypeRows = Object.entries(parsed.subagentTypes || {}).map(([typeName, modelRef]) => ({
      uid: nextSubtypeUid(),
      typeName,
      modelRef,
      editableName: !ui.SUBAGENT_PRESET_INFO[typeName],
    }));
  }

  function applyServerState(data) {
    if (!data || typeof data !== 'object') return;
    serverState = data;
    catalogModels = Array.isArray(data.models) ? data.models : [];
    const incomingModelsSig = JSON.stringify(catalogModels);
    const modelsChanged = incomingModelsSig !== lastModelsSig;
    lastModelsSig = incomingModelsSig;
    const incomingSig = normalizePayloadSignature(data.roles || {});
    const dirtyOrEditing =
      Boolean(saveTimer) ||
      saveInFlight ||
      saveQueued ||
      Boolean(activeInputUid) ||
      pickerState.open ||
      currentPayloadSignature() !== lastServerRolesSig;

    const rolesHydrated = !lastServerRolesSig || (!dirtyOrEditing && incomingSig !== lastServerRolesSig);
    if (rolesHydrated) {
      hydrateRolesFromServer(data.roles || {});
      lastServerRolesSig = incomingSig;
      if (lastSavedPayloadSig && incomingSig !== lastSavedPayloadSig) {
        lastSavedPayloadSig = '';
      }
    }

    if (activeInputUid || (!rolesHydrated && !modelsChanged)) {
      renderHeaderMeta();
      updateResetAllButton();
    } else {
      renderLists();
      if (pickerState.open) {
        renderPickerContent();
        positionPicker();
      }
    }
    updateSyncStatusFromBridge();
  }

  async function fetchStateSnapshot() {
    try {
      const response = await fetch('./api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      applyServerState(data);
    } catch {
      if (!serverState) {
        const zh = isZh();
        setSyncPill('connecting', zh ? '正在连接本地配置服务…' : 'Connecting to local service…');
      }
    }
  }

  function startFallbackPolling() {
    if (fallbackPollTimer) return;
    fallbackPollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchStateSnapshot();
      }
    }, 3000);
  }

  function stopFallbackPolling() {
    if (fallbackPollTimer) {
      clearInterval(fallbackPollTimer);
      fallbackPollTimer = null;
    }
  }

  function connectLiveEvents() {
    if (typeof EventSource !== 'function') {
      fetchStateSnapshot();
      startFallbackPolling();
      return;
    }
    try {
      eventSource?.close();
      eventSource = new EventSource('./api/events');
      eventSource.addEventListener('state', event => {
        stopFallbackPolling();
        try {
          applyServerState(JSON.parse(event.data));
        } catch {
          // Ignore malformed event frame.
        }
      });
      eventSource.onopen = () => {
        stopFallbackPolling();
      };
      eventSource.onerror = () => {
        startFallbackPolling();
      };
    } catch {
      fetchStateSnapshot();
      startFallbackPolling();
    }
  }

  pickerSearchEl.addEventListener('input', () => {
    pickerState.query = pickerSearchEl.value;
    pickerState.focusedIndex = -1;
    renderPickerContent();
  });

  pickerClearQEl.addEventListener('click', () => {
    pickerState.query = '';
    pickerSearchEl.value = '';
    pickerState.focusedIndex = -1;
    renderPickerContent();
    pickerSearchEl.focus();
  });

  pickerSearchEl.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateFocusedOption(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateFocusedOption(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = pickerState.target;
      if (!target) return;
      if (pickerState.focusedIndex >= 0 && pickerState.focusedIndex < pickerState.optionValues.length) {
        const chosen = pickerState.optionValues[pickerState.focusedIndex];
        closePicker({ restoreFocus: false });
        applyModelSelection(target, chosen);
        return;
      }
      if (pickerState.optionValues.length === 1) {
        const chosen = pickerState.optionValues[0];
        closePicker({ restoreFocus: false });
        applyModelSelection(target, chosen);
        return;
      }
      const trimmed = pickerSearchEl.value.trim();
      if (trimmed) {
        closePicker({ restoreFocus: false });
        applyModelSelection(target, trimmed);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePicker({ restoreFocus: true });
    }
  });

  const commitCustomModelInput = () => {
    const val = pickerCustomInputEl.value.trim();
    const target = pickerState.target;
    if (!target || !val) return;
    closePicker({ restoreFocus: false });
    applyModelSelection(target, val);
  };

  pickerCustomApplyBtn.addEventListener('click', commitCustomModelInput);
  pickerEl.addEventListener('click', event => {
    event.stopPropagation();
  });
  pickerCustomInputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitCustomModelInput();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePicker({ restoreFocus: true });
    }
  });

  document.addEventListener('click', event => {
    if (!pickerState.open) return;
    if (pickerEl.contains(event.target)) return;
    if (pickerState.anchorEl && pickerState.anchorEl.contains(event.target)) return;
    closePicker({ restoreFocus: false });
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && pickerState.open) {
      event.preventDefault();
      closePicker({ restoreFocus: true });
    }
  });

  window.addEventListener('resize', () => {
    if (pickerState.open) positionPicker();
  });
  window.addEventListener('scroll', () => {
    if (pickerState.open) positionPicker();
  }, true);

  window.addEventListener('focus', () => {
    fetchStateSnapshot();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fetchStateSnapshot();
    }
  });

  retryBtn.addEventListener('click', () => {
    syncStatus.error = false;
    persistRolesNow();
  });

  resetAllBtn.addEventListener('click', () => {
    if (!resetConfirmArmed) {
      resetConfirmArmed = true;
      updateResetAllButton();
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(() => {
        resetConfirmArmed = false;
        updateResetAllButton();
      }, 3500);
      return;
    }
    clearTimeout(resetConfirmTimer);
    resetConfirmArmed = false;
    for (const def of ui.ROLE_DEFS) {
      formRoles[def.key] = '';
    }
    subtypeRows = [];
    closePicker({ restoreFocus: false });
    renderLists();
    scheduleSave({ immediate: true });
  });

  hostBridge?.onTheme?.(theme => {
    if (theme?.lang && theme.lang !== currentLang) {
      currentLang = theme.lang;
      applyStaticCopy();
      renderLists();
      if (pickerState.open) renderPickerContent();
      updateSyncStatusFromBridge();
    }
  });

  applyStaticCopy();
  renderLists();
  connectLiveEvents();
})();
