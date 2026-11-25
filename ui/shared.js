(() => {
  const ROLE_DEFS = [
    {
      key: 'autoRouter',
      group: 'routing',
      optionKey: 'autoRouterModel',
      aliases: ['autoRouter', 'autoRouterModel', 'auto', 'autoModel', 'router', 'routerModel'],
      zhLabel: 'Auto 路由控制模型 (Auto Router)',
      enLabel: 'Auto Mode Router',
      zhDesc: '仅作用于 Cursor 原生 Auto 模式择优；留空默认用 cursor/auto（失败时用 cursor/auto-smart 重试）。',
      enDesc: 'Applies only to Cursor native Auto; empty defaults to cursor/auto with cursor/auto-smart fallback.',
      core: true,
    },
    {
      key: 'subagent',
      group: 'routing',
      optionKey: 'subagentModel',
      aliases: ['subagent', 'subagentModel', 'subagents'],
      zhLabel: '子代理默认模型 (Subagent)',
      enLabel: 'Subagent Default',
      zhDesc: '处理 Explore / Shell / Task 等默认派生子代理任务；留空则沿用主模型。',
      enDesc: 'Handles spawned subagent runs (Explore, Shell, Task); empty inherits the active model.',
      core: true,
    },
    {
      key: 'bugbot',
      group: 'specialized',
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
      group: 'specialized',
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
      group: 'specialized',
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
      group: 'specialized',
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
      group: 'specialized',
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
      group: 'specialized',
      optionKey: 'commitModel',
      aliases: ['commit', 'commitModel'],
      zhLabel: 'Git 提交信息生成',
      enLabel: 'Git Commit Message',
      zhDesc: '负责 WriteGitCommitMessage（留空则沿用主模型）。',
      enDesc: 'Handles WriteGitCommitMessage (falls back to main model if empty).',
      core: false,
    },
  ];

  const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const SUBAGENT_PRESETS = ['explore', 'shell', 'generalPurpose', 'browser-use'];
  const SUBAGENT_PRESET_INFO = {
    explore: { zh: '代码库检索只读子代理', en: 'Read-only codebase exploration' },
    shell: { zh: '终端命令执行子代理', en: 'Terminal command execution' },
    generalPurpose: { zh: '通用多步任务子代理', en: 'General multi-step subagent' },
    'browser-use': { zh: '浏览器自动化操作子代理', en: 'Browser automation subagent' },
  };
  const CUSTOM_MODEL = '__custom__';
  const STANDARD_TIER_IDS = new Set(['default', 'standard', 'usual', 'off', 'none', 'inherit']);

  const PROVIDER_COLORS = [
    '#4f46e5',
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#64748b',
  ];

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

  function normalizeTierParam(rawVal, { isFastFlag = false } = {}) {
    if (typeof rawVal === 'boolean') {
      return isFastFlag ? (rawVal ? 'priority' : 'off') : '';
    }
    if (typeof rawVal !== 'string') return '';
    const clean = rawVal.replace(/[\r\n\0]/g, '').trim().toLowerCase();
    if (!clean || clean === 'none' || clean === 'default' || clean === 'inherit') return '';
    if (clean === 'off' || clean === 'false' || clean === '0' || clean === 'standard' || clean === 'usual') {
      return 'off';
    }
    if (clean === 'true' || clean === '1') return 'priority';
    return clean.slice(0, 48);
  }

  function parseModelRef(rawValue) {
    const clean = sanitizeValue(rawValue);
    if (!clean) return { modelId: '', effort: '', serviceTier: '' };
    const match = /^(.+?)\[([^\]]+)\]$/.exec(clean);
    if (!match) return { modelId: clean, effort: '', serviceTier: '' };
    let effort = '';
    let explicitTier = '';
    let fastTier = '';
    for (const pair of match[2].split(',')) {
      const [rawKey, rawVal] = pair.split('=');
      const paramKey = String(rawKey || '').trim().toLowerCase();
      const paramVal = typeof rawVal === 'string' ? rawVal.trim() : '';
      if ((paramKey === 'effort' || paramKey === 'reasoning') && paramVal && paramVal !== 'none') {
        effort = paramVal;
      } else if (paramKey === 'service_tier' || paramKey === 'tier' || paramKey === 'speed') {
        const parsedTier = normalizeTierParam(paramVal);
        if (parsedTier) explicitTier = parsedTier;
      } else if (paramKey === 'fast') {
        const parsedFast = normalizeTierParam(paramVal, { isFastFlag: true });
        if (parsedFast) fastTier = parsedFast;
      }
    }
    return {
      modelId: match[1].trim(),
      effort,
      serviceTier: explicitTier || fastTier,
    };
  }

  function formatModelRef(modelId, effort, serviceTier = '') {
    const cleanId = sanitizeValue(modelId);
    if (!cleanId) return '';
    if (cleanId.includes('[')) return cleanId;
    const cleanEffort = typeof effort === 'string' ? effort.trim() : '';
    const cleanTier = normalizeTierParam(serviceTier);
    const params = [];
    if (cleanEffort) params.push(`reasoning=${cleanEffort}`);
    if (cleanTier) params.push(`service_tier=${cleanTier}`);
    if (params.length === 0) return cleanId;
    return `${cleanId}[${params.join(',')}]`;
  }

  function defaultTierLabel(tierId) {
    const lower = String(tierId || '').toLowerCase();
    if (lower === 'priority' || lower === 'fast') return 'Fast';
    if (lower === 'ultrafast') return 'Ultrafast';
    if (lower === 'flex') return 'Flex';
    return tierId;
  }

  function normalizeModelServiceTiers(entry) {
    if (!entry || typeof entry !== 'object') return [];
    const rawTiers = Array.isArray(entry.serviceTiers)
      ? entry.serviceTiers
      : Array.isArray(entry.service_tiers)
        ? entry.service_tiers
        : null;
    if (rawTiers) {
      const out = [];
      const seen = new Set();
      for (const item of rawTiers) {
        const rawId = typeof item === 'string' ? item : item?.id;
        const cleanId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
        if (!cleanId || STANDARD_TIER_IDS.has(cleanId) || seen.has(cleanId)) continue;
        seen.add(cleanId);
        const rawName = typeof item === 'object' && item && typeof item.name === 'string' ? item.name.trim() : '';
        const rawDesc =
          typeof item === 'object' && item && typeof item.description === 'string' ? item.description.trim() : '';
        out.push({
          id: cleanId,
          name: rawName || defaultTierLabel(cleanId),
          description: rawDesc,
        });
      }
      return out;
    }
    if (entry.fast) {
      return [{ id: 'priority', name: 'Fast', description: '' }];
    }
    return [];
  }

  function getServiceTierChoices(models, modelId, currentTier = '', zh = true) {
    const cleanCurrent = normalizeTierParam(currentTier);
    const entry = getModelEntry(models, modelId);
    const isCustomModel = Boolean(modelId) && !entry;
    const tiers = entry
      ? normalizeModelServiceTiers(entry)
      : isCustomModel
        ? [
            { id: 'priority', name: 'Fast', description: '' },
            { id: 'ultrafast', name: 'Ultrafast', description: '' },
          ]
        : [];
    const supportsFast = tiers.length > 0 || Boolean(cleanCurrent);
    const choices = [
      { value: '', label: zh ? '默认速度' : 'Default speed', unsupported: false },
    ];
    if (tiers.length > 0 || cleanCurrent === 'off') {
      choices.push({
        value: 'off',
        label: zh ? '标准 (关闭)' : 'Standard (Off)',
        unsupported: false,
      });
    }
    const allowed = new Set(['', 'off']);
    for (const tier of tiers) {
      allowed.add(tier.id);
      choices.push({
        value: tier.id,
        label: tier.name || defaultTierLabel(tier.id),
        description: tier.description || '',
        unsupported: false,
      });
    }
    if (cleanCurrent && !allowed.has(cleanCurrent)) {
      choices.push({
        value: cleanCurrent,
        label: zh ? `${defaultTierLabel(cleanCurrent)} (目录未列出)` : `${defaultTierLabel(cleanCurrent)} (unlisted)`,
        unsupported: true,
      });
    }
    return {
      choices,
      tiers,
      supportsFast,
    };
  }

  function splitModelDisplay(entryOrId, zh = true) {
    const id = typeof entryOrId === 'string' ? entryOrId : String(entryOrId?.id || '');
    const rawName = typeof entryOrId === 'object' && entryOrId?.name ? String(entryOrId.name) : '';
    const prefix = id.includes('/') ? id.split('/')[0] : 'custom';
    const sepIndex = rawName.lastIndexOf(' · ');
    if (sepIndex > 0) {
      const shortName = rawName.slice(0, sepIndex).trim();
      const rawProvider = rawName.slice(sepIndex + 3).trim();
      const providerLabel =
        zh && rawProvider.toLowerCase() === 'routing group' ? '路由组' : rawProvider;
      return {
        id,
        shortName: shortName || id,
        providerKey: rawProvider.toLowerCase() || prefix.toLowerCase(),
        providerLabel: providerLabel || prefix,
      };
    }
    return {
      id,
      shortName: rawName || id,
      providerKey: prefix.toLowerCase(),
      providerLabel: prefix,
    };
  }

  function providerColorFor(providerKey) {
    const text = String(providerKey || '');
    if (text === 'routing group' || text === 'auto' || text === 'group') return PROVIDER_COLORS[0];
    if (text === 'cursor') return '#64748b';
    if (text === 'workbuddy') return '#10b981';
    if (text === 'kimi work' || text === 'kimi-work') return '#0ea5e9';
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return PROVIDER_COLORS[hash % PROVIDER_COLORS.length];
  }

  function formatContextLabel(context) {
    const num = Number(context);
    if (!Number.isFinite(num) || num <= 0) return '';
    if (num === 1048576 || num === 1048000 || num === 1000000) return '1M';
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (num === 262144) return '256K';
    if (num >= 1000) return `${Math.round(num / 1000)}K`;
    return String(num);
  }

  function getModelEntry(models, modelId) {
    if (!modelId || !Array.isArray(models)) return null;
    return models.find(entry => entry && entry.id === modelId) || null;
  }

  function getEffortChoices(models, modelId, currentEffort = '', zh = true) {
    const cleanCurrent = typeof currentEffort === 'string' && currentEffort !== 'none' ? currentEffort.trim() : '';
    const entry = getModelEntry(models, modelId);
    const hasKnownCatalogEfforts = entry && Array.isArray(entry.efforts);
    let allowed;
    if (hasKnownCatalogEfforts) {
      const seen = new Set(
        entry.efforts
          .map(v => String(v || '').trim().toLowerCase())
          .filter(v => v && v !== 'none' && v !== 'default')
      );
      const ordered = EFFORT_OPTIONS.slice(1).filter(v => seen.has(v));
      for (const extra of seen) {
        if (!ordered.includes(extra)) ordered.push(extra);
      }
      allowed = ordered;
    } else {
      allowed = EFFORT_OPTIONS.slice(1);
    }
    const choices = [{ value: '', label: zh ? '默认强度' : 'Default', unsupported: false }];
    for (const effort of allowed) {
      choices.push({ value: effort, label: effort, unsupported: false });
    }
    if (cleanCurrent && !allowed.includes(cleanCurrent)) {
      choices.push({
        value: cleanCurrent,
        label: zh ? `${cleanCurrent} (目录未列出)` : `${cleanCurrent} (unlisted)`,
        unsupported: true,
      });
    }
    return {
      choices,
      supportsEffort: !hasKnownCatalogEfforts || allowed.length > 0 || Boolean(cleanCurrent),
    };
  }

  function syncTierSelectElement(selectEl, models, modelId, currentTier, zh) {
    const cleanTier = normalizeTierParam(currentTier);
    const info = getServiceTierChoices(models, modelId, cleanTier, zh);
    selectEl.replaceChildren();
    for (const choice of info.choices) {
      selectEl.appendChild(createOptionElement(choice.value, choice.label));
    }
    selectEl.value = cleanTier;
    selectEl.hidden = !info.supportsFast;
    selectEl.title = zh ? '可选 Fast / 加速档位覆盖' : 'Optional Fast / service tier override';
    return info;
  }

  function filterAndGroupModels(models, { query = '', provider = '', zh = true } = {}) {
    const list = Array.isArray(models) ? models : [];
    const providersMap = new Map();
    const enriched = [];
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) continue;
      const meta = splitModelDisplay(entry, zh);
      enriched.push({ ...entry, ...meta });
      const bucket = providersMap.get(meta.providerKey) || {
        key: meta.providerKey,
        label: meta.providerLabel,
        color: providerColorFor(meta.providerKey),
        count: 0,
      };
      bucket.count += 1;
      providersMap.set(meta.providerKey, bucket);
    }
    const tokens = String(query || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const activeProvider = String(provider || '').trim().toLowerCase();
    const filtered = enriched.filter(item => {
      if (activeProvider && item.providerKey !== activeProvider) return false;
      if (tokens.length === 0) return true;
      const haystack = `${item.id} ${item.name || ''} ${item.shortName} ${item.providerLabel}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
    const groupsMap = new Map();
    for (const item of filtered) {
      let group = groupsMap.get(item.providerKey);
      if (!group) {
        group = {
          key: item.providerKey,
          label: item.providerLabel,
          color: providerColorFor(item.providerKey),
          items: [],
        };
        groupsMap.set(item.providerKey, group);
      }
      group.items.push(item);
    }
    return {
      total: enriched.length,
      providers: [...providersMap.values()],
      filtered,
      groups: [...groupsMap.values()],
    };
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
          ? '默认 (cursor/auto，失败时 cursor/auto-smart)'
          : 'Default (cursor/auto, retry cursor/auto-smart)'
        : '';
      const inputPlaceholder = isAutoRouter
        ? zh
          ? '留空默认用 cursor/auto，失败时用 cursor/auto-smart'
          : 'Empty = cursor/auto, retry cursor/auto-smart'
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
      if (parsed.effort && !EFFORT_OPTIONS.includes(parsed.effort)) {
        effortSelect.appendChild(createOptionElement(parsed.effort, `reasoning=${parsed.effort}`));
      }
      effortSelect.value = parsed.effort || '';
      inputsRow.appendChild(effortSelect);

      const tierSelect = document.createElement('select');
      tierSelect.className = 'cb-tier-select';
      syncTierSelectElement(tierSelect, models, parsed.modelId, parsed.serviceTier, zh);
      inputsRow.appendChild(tierSelect);

      const modelSelectEl = inputsRow.querySelector('.cb-model-select');
      const modelInputEl = inputsRow.querySelector('.cb-model-input');
      const refreshRowTier = () => {
        const nextModel =
          modelSelectEl && modelSelectEl.value !== CUSTOM_MODEL ? modelSelectEl.value : modelInputEl?.value || '';
        syncTierSelectElement(tierSelect, models, nextModel.trim(), tierSelect.value, zh);
      };
      modelSelectEl?.addEventListener('change', refreshRowTier);
      modelInputEl?.addEventListener('input', refreshRowTier);

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
      });
      row.appendChild(selectEl);
    }

    const effortSelect = document.createElement('select');
    effortSelect.className = 'cb-effort-select';
    for (const effortOpt of EFFORT_OPTIONS) {
      const label = effortOpt ? effortOpt : zh ? '默认' : 'default';
      effortSelect.appendChild(createOptionElement(effortOpt, label));
    }
    if (parsed.effort && !EFFORT_OPTIONS.includes(parsed.effort)) {
      effortSelect.appendChild(createOptionElement(parsed.effort, parsed.effort));
    }
    effortSelect.value = parsed.effort || '';

    const tierSelect = document.createElement('select');
    tierSelect.className = 'cb-tier-select';
    syncTierSelectElement(tierSelect, models, parsed.modelId, parsed.serviceTier, zh);
    const subSelectEl = row.querySelector('.cb-subtype-select');
    const refreshSubTier = () => {
      const nextModel = subSelectEl && subSelectEl.value !== CUSTOM_MODEL ? subSelectEl.value : modelInput.value;
      syncTierSelectElement(tierSelect, models, nextModel.trim(), tierSelect.value, zh);
    };
    subSelectEl?.addEventListener('change', refreshSubTier);
    modelInput.addEventListener('input', refreshSubTier);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cb-btn cb-btn-ghost';
    removeBtn.textContent = zh ? '删除' : 'Remove';
    removeBtn.addEventListener('click', () => row.remove());

    row.append(modelInput, effortSelect, tierSelect, removeBtn);
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
      const selectEl = card.querySelector('.cb-model-select');
      const inputEl = card.querySelector('.cb-model-input');
      const effortEl = card.querySelector('.cb-effort-select');
      const tierEl = card.querySelector('.cb-tier-select');
      if (!roleKey || !inputEl) continue;
      const rawModel = selectEl && selectEl.value !== CUSTOM_MODEL ? selectEl.value : inputEl.value;
      roles[roleKey] = formatModelRef(rawModel, effortEl?.value || '', tierEl?.value || '');
    }
    const subagentTypes = {};
    if (subagentListEl) {
      for (const row of subagentListEl.querySelectorAll('.cb-subtype-row')) {
        const typeInput = row.querySelector('.cb-subtype-key');
        const selectEl = row.querySelector('.cb-subtype-select');
        const textInput = row.querySelector('.cb-subtype-model');
        const effortEl = row.querySelector('.cb-effort-select');
        const tierEl = row.querySelector('.cb-tier-select');
        const cleanType = String(typeInput?.value || '').replace(/[\r\n\0]/g, '').trim();
        const rawModel = selectEl && selectEl.value !== CUSTOM_MODEL ? selectEl.value : textInput?.value || '';
        const formatted = formatModelRef(rawModel, effortEl?.value || '', tierEl?.value || '');
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
    SUBAGENT_PRESET_INFO,
    EFFORT_OPTIONS,
    isZh,
    parseModelRef,
    formatModelRef,
    splitModelDisplay,
    providerColorFor,
    formatContextLabel,
    getModelEntry,
    normalizeModelServiceTiers,
    getServiceTierChoices,
    getEffortChoices,
    filterAndGroupModels,
    readOptionsToFormState,
    buildOptionsPayload,
    buildServiceRolesPayload,
    renderRoleGrid,
    renderSubagentTypes,
    appendSubagentTypeRow,
    readFormStateFromDom,
  };
})();
