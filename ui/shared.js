(() => {
  const ROLE_DEFS = [
    {
      key: 'autoRouter',
      optionKey: 'autoRouterModel',
      aliases: ['autoRouter', 'autoRouterModel', 'auto', 'autoModel', 'router', 'routerModel'],
      zhLabel: 'Auto 路由控制模型 (Auto Router)',
      enLabel: 'Auto Mode Router',
      zhDesc: '仅在 Cursor 中开启原生 Auto 时用于从 Magpie 目录择优（不影响手动选用的 cursor/auto）；留空默认使用 cursor/auto。',
      enDesc: 'Routes Cursor native Auto across all Magpie models (never affects manually selected cursor/auto); defaults to cursor/auto when empty.',
      core: true,
    },
    {
      key: 'subagent',
      optionKey: 'subagentModel',
      aliases: ['subagent', 'subagentModel', 'subagents'],
      zhLabel: '子代理默认模型 (Subagent)',
      enLabel: 'Subagent Default',
      zhDesc: '处理 Cursor 派生的子代理任务（如 Explore / Shell / Task 工具）。',
      enDesc: 'Handles spawned subagent runs (Explore, Shell, Task tool calls).',
      core: true,
    },
    {
      key: 'bugbot',
      optionKey: 'bugbotModel',
      aliases: ['bugbot', 'bugbotModel'],
      zhLabel: 'Bugbot 代码审查',
      enLabel: 'Bugbot Review',
      zhDesc: '负责 Bugbot 自动审阅、StreamBugBot 与 Diff 缺陷排查。',
      enDesc: 'Routes Bugbot automated review, StreamBugBot, and diff inspection.',
      core: true,
    },
    {
      key: 'securitybot',
      optionKey: 'securitybotModel',
      aliases: ['securitybot', 'securitybotModel', 'security'],
      zhLabel: 'SecurityBot 安全审计',
      enLabel: 'SecurityBot Audit',
      zhDesc: '负责 SecurityBot 漏洞扫描与安全专项子代理。',
      enDesc: 'Routes SecurityBot vulnerability review and security subagents.',
      core: true,
    },
    {
      key: 'title',
      optionKey: 'titleModel',
      aliases: ['title', 'titleModel', 'naming', 'namingModel'],
      zhLabel: '对话/分支标题命名',
      enLabel: 'Title & Branch Naming',
      zhDesc: '负责 NameAgent、GetChatTitle 与分支名生成，建议配轻量高速模型。',
      enDesc: 'Handles chat title and branch naming (NameAgent / GetChatTitle).',
      core: true,
    },
    {
      key: 'summarize',
      optionKey: 'summarizeModel',
      aliases: ['summarize', 'summarizeModel', 'summary', 'summaryModel', 'compaction', 'compactionModel'],
      zhLabel: '对话摘要与压缩',
      enLabel: 'Summary & Compaction',
      zhDesc: '负责长对话压缩（SummarizeAction）与 Transcript 概览。',
      enDesc: 'Handles conversation compaction (SummarizeAction) and overviews.',
      core: true,
    },
    {
      key: 'memory',
      optionKey: 'memoryModel',
      aliases: ['memory', 'memoryModel', 'memories', 'memoriesModel'],
      zhLabel: '记忆整理与提取',
      enLabel: 'Memory Consolidation',
      zhDesc: '负责 PotentiallyGenerateMemory 及记忆整理后台任务。',
      enDesc: 'Handles PotentiallyGenerateMemory and memory consolidation.',
      core: true,
    },
    {
      key: 'commit',
      optionKey: 'commitModel',
      aliases: ['commit', 'commitModel'],
      zhLabel: 'Git 提交信息生成',
      enLabel: 'Git Commit Message',
      zhDesc: '负责 WriteGitCommitMessage（留空则沿用主模型）。',
      enDesc: 'Handles WriteGitCommitMessage (falls back to main model if empty).',
      core: false,
    },
  ];

  const EFFORT_OPTIONS = ['', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const SUBAGENT_PRESETS = ['explore', 'shell', 'generalPurpose', 'browser-use'];
  const CUSTOM_MODEL = '__custom__';

  function isZh(lang) {
    return String(lang || '').toLowerCase().startsWith('zh');
  }

  function sanitizeValue(value) {
    if (typeof value !== 'string') return '';
    const clean = value.replace(/[\r\n\0]/g, '').trim();
    if (!clean) return '';
    const lower = clean.toLowerCase();
    if (lower === 'default' || lower === 'inherit' || lower === 'none') return '';
    return clean.slice(0, 256);
  }

  function parseModelRef(rawValue) {
    const clean = sanitizeValue(rawValue);
    if (!clean) return { modelId: '', effort: '' };
    const match = /^(.+?)\[([^\]]+)\]$/.exec(clean);
    if (!match) return { modelId: clean, effort: '' };
    let effort = '';
    for (const pair of match[2].split(',')) {
      const [paramKey, paramVal] = pair.split('=');
      if ((paramKey === 'effort' || paramKey === 'reasoning') && paramVal) {
        effort = paramVal.trim();
      }
    }
    return { modelId: match[1].trim(), effort };
  }

  function formatModelRef(modelId, effort) {
    const cleanId = sanitizeValue(modelId);
    if (!cleanId) return '';
    const cleanEffort = typeof effort === 'string' ? effort.trim() : '';
    if (!cleanEffort || cleanId.includes('[')) return cleanId;
    return `${cleanId}[reasoning=${cleanEffort}]`;
  }

  function readOptionsToFormState(rawOptions) {
    const source = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const merged = source.roles && typeof source.roles === 'object' ? { ...source, ...source.roles } : source;
    const state = { roles: {}, subagentTypes: {} };
    for (const def of ROLE_DEFS) {
      let matched = '';
      for (const alias of def.aliases) {
        const candidate = sanitizeValue(merged[alias]);
        if (candidate) {
          matched = candidate;
          break;
        }
      }
      state.roles[def.key] = matched;
    }
    const rawTypes = merged.subagentTypeModels || merged.subagentTypes;
    if (rawTypes && typeof rawTypes === 'object' && !Array.isArray(rawTypes)) {
      for (const [typeName, modelValue] of Object.entries(rawTypes)) {
        const cleanType = String(typeName || '').replace(/[\r\n\0]/g, '').trim();
        const cleanModel = sanitizeValue(modelValue);
        if (cleanType && cleanModel) {
          state.subagentTypes[cleanType] = cleanModel;
        }
      }
    }
    return state;
  }

  function buildOptionsPayload(existingOptions, formState) {
    const next =
      existingOptions && typeof existingOptions === 'object' && !Array.isArray(existingOptions)
        ? { ...existingOptions }
        : {};
    delete next.roles;
    delete next.subagentTypes;
    for (const def of ROLE_DEFS) {
      for (const alias of def.aliases) {
        delete next[alias];
      }
      next[def.optionKey] = sanitizeValue(formState.roles?.[def.key]);
    }
    const typesObj = {};
    for (const [typeName, modelValue] of Object.entries(formState.subagentTypes || {})) {
      const cleanType = String(typeName || '').replace(/[\r\n\0]/g, '').trim();
      const cleanModel = sanitizeValue(modelValue);
      if (cleanType && cleanModel) typesObj[cleanType] = cleanModel;
    }
    next.subagentTypeModels = typesObj;
    return next;
  }

  function buildServiceRolesPayload(formState) {
    const payload = { subagentTypes: {} };
    for (const def of ROLE_DEFS) {
      payload[def.key] = sanitizeValue(formState.roles?.[def.key]);
    }
    for (const [typeName, modelValue] of Object.entries(formState.subagentTypes || {})) {
      const cleanType = String(typeName || '').replace(/[\r\n\0]/g, '').trim();
      const cleanModel = sanitizeValue(modelValue);
      if (cleanType && cleanModel) payload.subagentTypes[cleanType] = cleanModel;
    }
    return payload;
  }

  function createOptionElement(value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  function populateModelSelect(selectEl, models, currentModelId, zh, emptyLabel = '', { allowCustom = false } = {}) {
    selectEl.replaceChildren();
    selectEl.appendChild(
      createOptionElement('', emptyLabel || (zh ? '继承当前主模型 (默认)' : 'Inherit active main model'))
    );
    const seenIds = new Set();
    for (const entry of models || []) {
      if (!entry || typeof entry.id !== 'string' || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      const label = entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id;
      selectEl.appendChild(createOptionElement(entry.id, label));
    }
    if (allowCustom) {
      selectEl.appendChild(createOptionElement(CUSTOM_MODEL, zh ? '自定义模型 ID…' : 'Custom model ID…'));
    } else if (currentModelId && !seenIds.has(currentModelId)) {
      selectEl.appendChild(createOptionElement(currentModelId, `${currentModelId} (${zh ? '自定义' : 'custom'})`));
    }
    selectEl.value = currentModelId && (seenIds.has(currentModelId) || !allowCustom) ? currentModelId : currentModelId ? CUSTOM_MODEL : '';
  }

  function renderRoleGrid(containerEl, formState, { lang, models = null, includeAll = true } = {}) {
    const zh = isZh(lang);
    const defs = includeAll ? ROLE_DEFS : ROLE_DEFS.filter(def => def.core);
    containerEl.replaceChildren();

    for (const def of defs) {
      const card = document.createElement('div');
      card.className = 'cb-role-item';
      card.dataset.roleKey = def.key;

      const topRow = document.createElement('div');
      topRow.className = 'cb-role-top';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'cb-role-label';
      titleSpan.textContent = zh ? def.zhLabel : def.enLabel;

      const keyTag = document.createElement('span');
      keyTag.className = 'cb-role-tag';
      keyTag.textContent = def.key;
      topRow.append(titleSpan, keyTag);

      const descEl = document.createElement('p');
      descEl.className = 'cb-role-desc';
      descEl.textContent = zh ? def.zhDesc : def.enDesc;

      const inputsRow = document.createElement('div');
      inputsRow.className = 'cb-inputs';

      const parsed = parseModelRef(formState.roles?.[def.key] || '');
      const isAutoRouter = def.key === 'autoRouter';
      const emptyOptionLabel = isAutoRouter
        ? zh
          ? '默认 (优先 cursor/auto，无则回退主模型)'
          : 'Default (cursor/auto if present, else main model)'
        : '';
      const inputPlaceholder = isAutoRouter
        ? zh
          ? '留空默认用 cursor/auto（无则回退主模型）'
          : 'Empty = cursor/auto (fallback main model)'
        : zh
          ? '留空则沿用主模型（如 magpie/claude-haiku-5-5）'
          : 'Empty = inherit active model';

      if (Array.isArray(models) && models.length > 0) {
        const modelSelect = document.createElement('select');
        modelSelect.className = 'cb-model-select';
        populateModelSelect(modelSelect, models, parsed.modelId, zh, emptyOptionLabel, { allowCustom: true });
        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.className = 'cb-model-input';
        customInput.placeholder = isAutoRouter
          ? zh
            ? '留空默认 cursor/auto，或手动输入模型 ID'
            : 'Empty = cursor/auto, or custom model ID'
          : zh
            ? '或手动输入模型 ID'
            : 'Or custom model ID';
        customInput.value = parsed.modelId;
        const knownIds = new Set(models.map(entry => entry?.id).filter(Boolean));
        const showCustom = Boolean(parsed.modelId) && !knownIds.has(parsed.modelId);
        customInput.hidden = !showCustom;
        modelSelect.value = showCustom ? CUSTOM_MODEL : parsed.modelId || '';

        modelSelect.addEventListener('change', () => {
          if (modelSelect.value === CUSTOM_MODEL) {
            customInput.hidden = false;
            customInput.focus();
            return;
          }
          customInput.value = modelSelect.value;
          customInput.hidden = true;
        });
        customInput.addEventListener('input', () => {
          const trimmed = customInput.value.trim();
          const matchingOpt = Array.from(modelSelect.options).find(opt => opt.value === trimmed);
          modelSelect.value = matchingOpt ? trimmed : trimmed ? CUSTOM_MODEL : '';
          customInput.hidden = Boolean(matchingOpt) || !trimmed;
        });
        inputsRow.append(modelSelect, customInput);
      } else {
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'cb-model-input';
        modelInput.placeholder = inputPlaceholder;
        modelInput.value = parsed.modelId;
        inputsRow.appendChild(modelInput);
      }

      const effortSelect = document.createElement('select');
      effortSelect.className = 'cb-effort-select';
      effortSelect.title = zh ? '可选推理强度覆盖' : 'Optional reasoning effort override';
      for (const effortOpt of EFFORT_OPTIONS) {
        const label = effortOpt ? `reasoning=${effortOpt}` : zh ? '默认强度' : 'Default effort';
        effortSelect.appendChild(createOptionElement(effortOpt, label));
      }
      effortSelect.value = parsed.effort || '';
      inputsRow.appendChild(effortSelect);

      card.append(topRow, descEl, inputsRow);
      containerEl.appendChild(card);
    }
  }

  function appendSubagentTypeRow(containerEl, typeName, modelValue, { lang, models = null } = {}) {
    const zh = isZh(lang);
    const row = document.createElement('div');
    row.className = 'cb-subtype-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'cb-subtype-key';
    keyInput.placeholder = 'explore / shell / ...';
    keyInput.value = typeName || '';

    const parsed = parseModelRef(modelValue || '');
    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.className = 'cb-subtype-model';
    modelInput.placeholder = zh ? '指定子代理类型使用的模型 ID' : 'Model ID for this subagent type';
    modelInput.value = parsed.modelId;

    row.appendChild(keyInput);

    if (Array.isArray(models) && models.length > 0) {
      const selectEl = document.createElement('select');
      selectEl.className = 'cb-subtype-select';
      populateModelSelect(selectEl, models, parsed.modelId, zh, '', { allowCustom: true });
      const knownIds = new Set(models.map(entry => entry?.id).filter(Boolean));
      const showCustom = Boolean(parsed.modelId) && !knownIds.has(parsed.modelId);
      modelInput.hidden = !showCustom;
      selectEl.value = showCustom ? CUSTOM_MODEL : parsed.modelId || '';
      selectEl.addEventListener('change', () => {
        if (selectEl.value === CUSTOM_MODEL) {
          modelInput.hidden = false;
          modelInput.focus();
          return;
        }
        modelInput.value = selectEl.value;
        modelInput.hidden = true;
      });
      modelInput.addEventListener('input', () => {
        const trimmed = modelInput.value.trim();
        const matchingOpt = Array.from(selectEl.options).find(opt => opt.value === trimmed);
        selectEl.value = matchingOpt ? trimmed : trimmed ? CUSTOM_MODEL : '';
        modelInput.hidden = Boolean(matchingOpt) || !trimmed;
      });
      row.appendChild(selectEl);
    }

    const effortSelect = document.createElement('select');
    effortSelect.className = 'cb-effort-select';
    for (const effortOpt of EFFORT_OPTIONS) {
      const label = effortOpt ? effortOpt : zh ? '默认' : 'default';
      effortSelect.appendChild(createOptionElement(effortOpt, label));
    }
    effortSelect.value = parsed.effort || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cb-btn cb-btn-ghost';
    removeBtn.textContent = zh ? '删除' : 'Remove';
    removeBtn.addEventListener('click', () => row.remove());

    row.append(modelInput, effortSelect, removeBtn);
    containerEl.appendChild(row);
  }

  function renderSubagentTypes(containerEl, subagentTypes, { lang, models = null } = {}) {
    containerEl.replaceChildren();
    for (const [typeName, modelValue] of Object.entries(subagentTypes || {})) {
      appendSubagentTypeRow(containerEl, typeName, modelValue, { lang, models });
    }
  }

  function readFormStateFromDom(rolesGridEl, subagentListEl, baseRoles = {}) {
    const roles = { ...baseRoles };
    for (const card of rolesGridEl.querySelectorAll('.cb-role-item')) {
      const roleKey = card.dataset.roleKey;
      const inputEl = card.querySelector('.cb-model-input');
      const effortEl = card.querySelector('.cb-effort-select');
      if (!roleKey || !inputEl) continue;
      roles[roleKey] = formatModelRef(inputEl.value, effortEl?.value || '');
    }
    const subagentTypes = {};
    if (subagentListEl) {
      for (const row of subagentListEl.querySelectorAll('.cb-subtype-row')) {
        const typeInput = row.querySelector('.cb-subtype-key');
        const textInput = row.querySelector('.cb-subtype-model');
        const effortEl = row.querySelector('.cb-effort-select');
        const cleanType = String(typeInput?.value || '').replace(/[\r\n\0]/g, '').trim();
        const formatted = formatModelRef(textInput?.value || '', effortEl?.value || '');
        if (cleanType && formatted) {
          subagentTypes[cleanType] = formatted;
        }
      }
    }
    return { roles, subagentTypes };
  }

  globalThis.CursorBridgeUI = {
    ROLE_DEFS,
    SUBAGENT_PRESETS,
    isZh,
    readOptionsToFormState,
    buildOptionsPayload,
    buildServiceRolesPayload,
    renderRoleGrid,
    renderSubagentTypes,
    appendSubagentTypeRow,
    readFormStateFromDom,
  };
})();
