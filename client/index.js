// 图池本地化管家 2.1 - SillyTavern 客户端扩展
const API_BASE = '/api/plugins/st-asset-localizer';

let modalElement = null;
let subModalElement = null;
let currentCards = [];
let currentStats = null;
let activeFilter = 'all'; // 'all' | 'need' | 'localized'
let searchQuery = '';
let isProcessing = false;
let configCache = { autoPromptOnImport: true, ghAccelerator: 'https://gh-proxy.com/' };

const getCtx = () => window.SillyTavern?.getContext?.();

async function apiRequest(endpoint, method = 'GET', body = null) {
    const ctx = getCtx();
    const headers = ctx?.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
    const opts = {
        method,
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        }
    };
    if (body) {
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${endpoint}`, opts);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
    }
    return await res.json();
}

async function refreshStCharacters() {
    const ctx = getCtx();
    if (ctx && typeof ctx.getCharacters === 'function') {
        try {
            await ctx.getCharacters();
            console.log('[图池本地化管家] 已刷新酒馆前端角色内存缓存');
        } catch (e) {
            console.warn('[图池本地化管家] 刷新角色内存失败:', e);
        }
    }
}

async function fetchCardList() {
    try {
        const [cardsRes, statsRes] = await Promise.all([
            apiRequest('/cards'),
            apiRequest('/stats').catch(() => ({ ok: false }))
        ]);

        if (cardsRes.ok && Array.isArray(cardsRes.cards)) {
            currentCards = cardsRes.cards;
        }
        if (statsRes.ok && statsRes.stats) {
            currentStats = statsRes.stats;
            updateStatsBanner();
        }

        renderCardTable();
    } catch (err) {
        console.error('[图池本地化管家] 获取数据失败:', err);
        toastr.error('获取卡片数据失败: ' + err.message);
    }
}

function updateStatsBanner() {
    const codeEl = document.getElementById('st_al_path_text');
    const sizeEl = document.getElementById('st_al_total_size');
    const countEl = document.getElementById('st_al_total_count');
    if (!codeEl || !currentStats) return;

    codeEl.textContent = currentStats.assetsDir || 'data/shared_card_assets';
    if (sizeEl) sizeEl.textContent = `总占用: ${currentStats.totalSizeFormatted || '0 B'}`;
    if (countEl) countEl.textContent = `(${currentStats.totalFiles || 0} 张立绘)`;
}

async function doLocalizeCard(cardFileName, buttonEl) {
    if (isProcessing) return;
    isProcessing = true;
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 处理中...';
    }

    showProgress(`正在本地化 ${cardFileName}...`, 30);

    try {
        const res = await apiRequest('/localize', 'POST', { cardFileName });
        if (res.ok && res.result?.success) {
            showProgress(`本地化完成！`, 100);
            toastr.success(`《${res.result.baseName}》图池本地化成功！已生成原卡备份注册表。`);
            await refreshStCharacters();
            await fetchCardList();
            if (subModalElement) closeSubModal();
        } else {
            toastr.error('本地化处理未成功: ' + (res.error || '未知错误'));
        }
    } catch (err) {
        console.error('[图池本地化管家] 本地化失败:', err);
        toastr.error('本地化失败: ' + err.message);
    } finally {
        isProcessing = false;
        setTimeout(hideProgress, 1500);
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.innerHTML = '<i class="fa-solid fa-bolt"></i> 一键本地化';
        }
    }
}

async function doRevertCard(cardFileName, customBase = null) {
    if (isProcessing) return;
    if (!confirm(`确定要将《${cardFileName}》还原回原作者的原始外链吗？\n\n还原后角色卡将恢复为外部网络引用，便于您将卡片导出并分享给没有本地环境的好友。`)) {
        return;
    }

    isProcessing = true;
    showProgress(`正在还原 ${cardFileName} 为原始外链...`, 50);

    try {
        const res = await apiRequest('/revert', 'POST', { cardFileName, customOriginalBase: customBase });
        if (res.ok && res.result?.success) {
            showProgress(`还原完成！`, 100);
            toastr.success(`《${cardFileName}》已成功还原为原作者原始外链！`);
            await refreshStCharacters();
            await fetchCardList();
            if (subModalElement) closeSubModal();
        } else {
            toastr.error('还原失败: ' + (res.error || '未知错误'));
        }
    } catch (err) {
        console.error('[图池本地化管家] 还原失败:', err);
        toastr.error('还原失败: ' + err.message);
    } finally {
        isProcessing = false;
        setTimeout(hideProgress, 1500);
    }
}

// Batch localize all unlocalized cards
async function doBatchLocalize() {
    if (isProcessing) return;
    const targets = currentCards.filter(c => !c.isFullyLocalized || c.totalExternalCount > 0);
    if (targets.length === 0) {
        toastr.info('所有角色卡均已处于完全本地化状态！');
        return;
    }

    if (!confirm(`确定要批量本地化 ${targets.length} 张角色卡吗？将通过多并发镜像加速下载。`)) {
        return;
    }

    isProcessing = true;
    let done = 0;

    for (const card of targets) {
        const pct = Math.round((done / targets.length) * 100);
        showProgress(`[${done + 1}/${targets.length}] 正在处理 ${card.baseName}...`, pct);
        try {
            await apiRequest('/localize', 'POST', { cardFileName: card.cardFileName });
            done++;
        } catch (err) {
            console.error(`本地化 ${card.cardFileName} 失败:`, err);
        }
    }

    showProgress(`全部批量处理完成！`, 100);
    toastr.success(`批量本地化完成，已处理 ${done} 张卡片！`);
    await refreshStCharacters();
    await fetchCardList();
    isProcessing = false;
    setTimeout(hideProgress, 2000);
}

function showProgress(text, pct) {
    const wrap = document.getElementById('st_al_progress_wrapper');
    const txt = document.getElementById('st_al_progress_text');
    const fill = document.getElementById('st_al_progress_fill');
    if (!wrap || !txt || !fill) return;

    wrap.style.display = 'block';
    txt.textContent = text;
    fill.style.width = `${pct}%`;
}

function hideProgress() {
    const wrap = document.getElementById('st_al_progress_wrapper');
    if (wrap) wrap.style.display = 'none';
}

// Open Card Asset Link Settings Sub-Modal
async function openCardSettingsModal(cardFileName) {
    try {
        const res = await apiRequest(`/card-detail?cardFileName=${encodeURIComponent(cardFileName)}`);
        if (!res.ok || !res.detail) {
            toastr.error('获取卡片详情失败: ' + (res.error || '未知'));
            return;
        }

        const d = res.detail;
        if (subModalElement) subModalElement.remove();

        subModalElement = document.createElement('div');
        subModalElement.className = 'st-al-overlay';
        subModalElement.style.zIndex = '100001';

        const isLocal = d.currentMode === 'local';

        subModalElement.innerHTML = `
            <div class="st-al-submodal">
                <div class="st-al-header">
                    <div class="st-al-header-title">
                        <i class="fa-solid fa-sliders"></i>
                        <span>图池链接设置 - 《${d.baseName}》</span>
                    </div>
                    <button class="st-al-close-btn" id="st_al_sub_close">&times;</button>
                </div>

                <div class="st-al-submodal-body">
                    <!-- Status Box -->
                    <div class="st-al-card-box">
                        <div class="st-al-box-title"><i class="fa-solid fa-signal"></i> 运行状态与存储</div>
                        <div class="st-al-box-row">
                            <span>当前调用模式：</span>
                            <span>${isLocal ? '<span class="st-al-badge st-al-badge-success"><i class="fa-solid fa-bolt"></i> 本地服务器加速 (无梯秒开)</span>' : '<span class="st-al-badge st-al-badge-warning"><i class="fa-solid fa-globe"></i> 原始远程外链 (需梯子)</span>'}</span>
                        </div>
                        <div class="st-al-box-row">
                            <span>本地存储目录：</span>
                            <span class="st-al-path-code" style="font-size:0.78rem;">${d.safeName} (${d.diskCount} 张, ${d.diskSizeFormatted})</span>
                        </div>
                        <div class="st-al-box-row">
                            <span>原始图源识别：</span>
                            <span style="font-size:0.8rem;color:#cbd5e1;max-width:380px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${d.originalPrefix || '未知/已直接本地化'}</span>
                        </div>
                    </div>

                    <!-- Custom Base URL Config Box -->
                    <div class="st-al-card-box">
                        <div class="st-al-box-title"><i class="fa-solid fa-link"></i> 自定义图池外链基地址 (高级)</div>
                        <div style="font-size:0.8rem;color:#94a3b8;margin-bottom:8px;">若还原外链时需要指定特定图床或 GitHub 仓库地址，可在下方调整：</div>
                        <input id="st_al_custom_base" type="text" class="text_pole" style="width:100%;font-size:0.85rem;" value="${d.originalPrefix.startsWith('http') ? d.originalPrefix : ''}" placeholder="例如: https://files.catbox.moe/ 或 GitHub Raw 路径">
                    </div>

                    <!-- URL Mapping Preview Box -->
                    <div class="st-al-card-box">
                        <div class="st-al-box-title" style="justify-content:space-between;cursor:pointer;" id="st_al_toggle_preview">
                            <span><i class="fa-solid fa-table-list"></i> 链接映射预览 (${d.sampleMappings.length}/${d.totalMappingsCount} 张)</span>
                            <span style="color:#38bdf8;font-size:0.75rem;"><i class="fa-solid fa-chevron-down"></i> 点击展开/收起</span>
                        </div>
                        <div id="st_al_preview_content" style="display:none;max-height:180px;overflow-y:auto;">
                            <table class="st-al-sample-table">
                                <thead>
                                    <tr>
                                        <th>立绘文件名</th>
                                        <th>当前本地调用路径</th>
                                        <th>原始外链对应</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${d.sampleMappings.map(m => `
                                        <tr>
                                            <td><b>${m.filename}</b></td>
                                            <td style="color:#4ade80;">${m.localUrl}</td>
                                            <td style="color:#94a3b8;">${m.originalUrl}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="st-al-submodal-footer">
                    <div>
                        ${isLocal ? `
                            <button class="st-al-btn-danger" id="st_al_sub_revert_btn">
                                <i class="fa-solid fa-clock-rotate-left"></i> 还原为原始外链 (导出模式)
                            </button>
                        ` : `
                            <span style="font-size:0.8rem;color:#facc15;"><i class="fa-solid fa-triangle-exclamation"></i> 当前已是原始外链模式</span>
                        `}
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="st-al-btn-primary" id="st_al_sub_localize_btn">
                            <i class="fa-solid fa-bolt"></i> ${isLocal ? '重新同步本地化' : '一键应用本地加速'}
                        </button>
                        <button class="st-al-btn-secondary" id="st_al_sub_cancel_btn">关闭</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(subModalElement);

        document.getElementById('st_al_sub_close').addEventListener('click', closeSubModal);
        document.getElementById('st_al_sub_cancel_btn').addEventListener('click', closeSubModal);
        subModalElement.addEventListener('click', (e) => {
            if (e.target === subModalElement) closeSubModal();
        });

        // Toggle preview
        document.getElementById('st_al_toggle_preview').addEventListener('click', () => {
            const el = document.getElementById('st_al_preview_content');
            if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
        });

        // Revert action
        document.getElementById('st_al_sub_revert_btn')?.addEventListener('click', () => {
            const customVal = document.getElementById('st_al_custom_base')?.value.trim() || null;
            doRevertCard(cardFileName, customVal);
        });

        // Localize action
        document.getElementById('st_al_sub_localize_btn')?.addEventListener('click', () => {
            doLocalizeCard(cardFileName, document.getElementById('st_al_sub_localize_btn'));
        });

    } catch (e) {
        toastr.error('打开卡片配置失败: ' + e.message);
    }
}

function closeSubModal() {
    if (subModalElement) {
        subModalElement.remove();
        subModalElement = null;
    }
}

// Render cards table (Clean, symmetric, uniform)
function renderCardTable() {
    const tbody = document.getElementById('st_al_cards_tbody');
    if (!tbody) return;

    const filtered = currentCards.filter(c => {
        if (activeFilter === 'need' && c.isFullyLocalized) return false;
        if (activeFilter === 'localized' && !c.isFullyLocalized) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return c.cardFileName.toLowerCase().includes(q) || c.baseName.toLowerCase().includes(q) || c.safeName.toLowerCase().includes(q);
        }
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#64748b;">未找到匹配的角色卡</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(c => {
        let badgeHtml = '';
        if (c.isFullyLocalized) {
            badgeHtml = `<span class="st-al-badge st-al-badge-success"><i class="fa-solid fa-check-circle"></i> 已本地化</span>`;
        } else if (c.totalExternalCount > 0) {
            badgeHtml = `<span class="st-al-badge st-al-badge-warning"><i class="fa-solid fa-triangle-exclamation"></i> 含远程外链</span>`;
        } else {
            badgeHtml = `<span class="st-al-badge" style="background:#334155;color:#94a3b8;"><i class="fa-solid fa-circle-info"></i> 本地卡</span>`;
        }

        const externalCount = c.totalExternalCount || 0;

        return `
            <tr data-file="${c.cardFileName}">
                <td>
                    <div class="st-al-card-title">${c.baseName}</div>
                    <div class="st-al-card-file">📁 ${c.safeName}</div>
                </td>
                <td>${badgeHtml}</td>
                <td>
                    <div class="st-al-stat">本地调用: <b>${c.localAssetRefMatches || 0}</b></div>
                    <div class="st-al-stat">远程外链: <b style="color:${externalCount > 0 ? '#facc15' : '#94a3b8'}">${externalCount}</b></div>
                </td>
                <td>
                    <div class="st-al-stat">立绘文件: <b>${c.diskFilesCount || 0} 张</b> (${c.diskSizeFormatted || '0 B'})</div>
                    <div class="st-al-stat">待下载: <b>${c.missingOnDiskCount || 0}</b></div>
                </td>
                <td style="text-align: right; white-space: nowrap;">
                    <div style="display:inline-flex;gap:6px;align-items:center;">
                        <button class="st-al-btn-secondary st-al-localize-btn" data-file="${c.cardFileName}">
                            <i class="fa-solid fa-bolt"></i> ${c.isFullyLocalized ? '重新处理' : '一键本地化'}
                        </button>
                        <button class="st-al-btn-outline st-al-settings-btn" data-file="${c.cardFileName}" title="图池链接设置与外链还原">
                            <i class="fa-solid fa-gear"></i> 图池设置
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Attach click events
    tbody.querySelectorAll('.st-al-localize-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const fn = btn.getAttribute('data-file');
            doLocalizeCard(fn, btn);
        });
    });

    tbody.querySelectorAll('.st-al-settings-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const fn = btn.getAttribute('data-file');
            openCardSettingsModal(fn);
        });
    });
}

// Create and show Main Modal
function showModal(initialFocusCard = null) {
    if (modalElement) {
        modalElement.style.display = 'flex';
        if (initialFocusCard) {
            searchQuery = initialFocusCard;
            const input = document.getElementById('st_al_search_input');
            if (input) input.value = searchQuery;
        }
        fetchCardList();
        return;
    }

    modalElement = document.createElement('div');
    modalElement.className = 'st-al-overlay';
    modalElement.innerHTML = `
        <div class="st-al-modal">
            <div class="st-al-header">
                <div class="st-al-header-title">
                    <i class="fa-solid fa-images"></i>
                    <span>图池本地化管家</span>
                    <span style="font-size:0.75rem;padding:2px 8px;background:#0369a1;border-radius:12px;color:#fff;">v2.1 全平台版</span>
                </div>
                <button class="st-al-close-btn" id="st_al_close_btn">&times;</button>
            </div>

            <div class="st-al-path-banner">
                <div class="st-al-path-left">
                    <i class="fa-solid fa-hard-drive" style="color:#38bdf8;"></i>
                    <span>存储目录：</span>
                    <code class="st-al-path-code" id="st_al_path_text">加载中...</code>
                    <button class="st-al-filter-btn" id="st_al_copy_path_btn" title="复制完整路径" style="padding:2px 8px;font-size:0.75rem;">
                        <i class="fa-solid fa-copy"></i> 复制
                    </button>
                </div>
                <div class="st-al-path-right">
                    <span id="st_al_total_size" style="font-weight:500;color:#e2e8f0;">总占用: 计算中...</span>
                    <span id="st_al_total_count" style="color:#64748b;font-size:0.8rem;"></span>
                    <button class="st-al-btn-danger" id="st_al_clean_orphans_btn" style="padding:3px 8px;font-size:0.75rem;" title="清理已被删除卡片的无主残留图片">
                        <i class="fa-solid fa-broom"></i> 清理孤儿图
                    </button>
                </div>
            </div>

            <div class="st-al-toolbar">
                <div class="st-al-search-box">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" id="st_al_search_input" placeholder="搜索角色卡名称或安全目录名...">
                </div>

                <div class="st-al-filters">
                    <button class="st-al-filter-btn active" data-filter="all">全部</button>
                    <button class="st-al-filter-btn" data-filter="need">待本地化</button>
                    <button class="st-al-filter-btn" data-filter="localized">已本地化</button>
                </div>

                <div style="display:flex;gap:8px;">
                    <button class="st-al-btn-secondary" id="st_al_refresh_btn">
                        <i class="fa-solid fa-rotate"></i> 扫描刷新
                    </button>
                    <button class="st-al-btn-primary" id="st_al_batch_btn">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 批量全部本地化
                    </button>
                </div>
            </div>

            <div class="st-al-content">
                <table class="st-al-table">
                    <thead>
                        <tr>
                            <th>角色卡 / 目录</th>
                            <th>状态</th>
                            <th>调用统计</th>
                            <th>文件与磁盘占用</th>
                            <th style="text-align: right;">操作</th>
                        </tr>
                    </thead>
                    <tbody id="st_al_cards_tbody">
                        <tr><td colspan="5" style="text-align:center;padding:30px;color:#64748b;"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描角色卡与统计磁盘占用...</td></tr>
                    </tbody>
                </table>
            </div>

            <div class="st-al-progress-wrapper" id="st_al_progress_wrapper" style="display: none;">
                <div class="st-al-progress-header">
                    <span id="st_al_progress_text">准备就绪</span>
                </div>
                <div class="st-al-progress-bar-bg">
                    <div class="st-al-progress-bar-fill" id="st_al_progress_fill"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modalElement);

    document.getElementById('st_al_close_btn').addEventListener('click', () => {
        modalElement.style.display = 'none';
        closeSubModal();
    });
    modalElement.addEventListener('click', (e) => {
        if (e.target === modalElement) {
            modalElement.style.display = 'none';
            closeSubModal();
        }
    });

    const searchInput = document.getElementById('st_al_search_input');
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderCardTable();
    });

    modalElement.querySelectorAll('.st-al-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            modalElement.querySelectorAll('.st-al-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.getAttribute('data-filter');
            renderCardTable();
        });
    });

    document.getElementById('st_al_refresh_btn').addEventListener('click', fetchCardList);
    document.getElementById('st_al_batch_btn').addEventListener('click', doBatchLocalize);

    document.getElementById('st_al_copy_path_btn').addEventListener('click', () => {
        const pathText = document.getElementById('st_al_path_text')?.textContent;
        if (pathText) {
            navigator.clipboard.writeText(pathText);
            toastr.success('存储目录路径已复制到剪贴板！');
        }
    });

    document.getElementById('st_al_clean_orphans_btn').addEventListener('click', async () => {
        if (!confirm('确定扫描并删除没有关联角色卡的无主图池文件夹吗？')) return;
        try {
            const res = await apiRequest('/clean-orphans', 'POST');
            if (res.ok) {
                toastr.success(`清理完成，已清理 ${res.result?.count || 0} 个无用文件夹！`);
                fetchCardList();
            }
        } catch (e) {
            toastr.error('清理失败: ' + e.message);
        }
    });

    if (initialFocusCard) {
        searchQuery = initialFocusCard;
        searchInput.value = searchQuery;
    }

    fetchCardList();
}

function setupCharacterDrawerButton() {
    const parent = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
    if (!parent) return;

    if (document.getElementById('st_asset_localizer_btn')) return;

    const btn = document.createElement('div');
    btn.id = 'st_asset_localizer_btn';
    btn.className = 'menu_button fa-solid fa-cloud-arrow-down st-al-btn-char';
    btn.title = '图池本地化管家 (一键检测并本地化当前角色图池)';
    btn.addEventListener('click', () => {
        const ctx = getCtx();
        const activeChar = ctx?.characters?.[ctx?.this_chid];
        const cardName = activeChar?.avatar ? activeChar.avatar.replace(/\.[^/.]+$/, '') : '';
        showModal(cardName);
    });

    const delBtn = parent.querySelector('#delete_button');
    if (delBtn) {
        parent.insertBefore(btn, delBtn);
    } else {
        parent.appendChild(btn);
    }
}

function setupSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('st_asset_localizer_settings')) return;

    const drawer = document.createElement('div');
    drawer.className = 'extension_container';
    drawer.id = 'st_asset_localizer_settings';
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-images"></i> 图池本地化管家</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="st-al-ext-row">
                    <span style="font-size:0.85rem;">GitHub 加速镜像：</span>
                    <input id="st_al_cfg_gh" type="text" class="text_pole" placeholder="https://gh-proxy.com/" value="https://gh-proxy.com/">
                    <button id="st_al_cfg_save" class="menu_button">保存</button>
                </div>
                <div class="st-al-ext-tip">为国内服务器提供 GitHub Raw 图片镜像加速</div>

                <div style="margin-top: 10px;">
                    <label class="checkbox_label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input id="st_al_cfg_prompt" type="checkbox" checked>
                        <span style="font-size:0.85rem;">导入新卡时若含外链自动弹窗提醒</span>
                    </label>
                </div>

                <div style="margin-top: 12px;">
                    <button id="st_al_open_panel_btn" class="menu_button" style="width:100%;text-align:center;">
                        <i class="fa-solid fa-table-list"></i> 打开图池本地化控制台
                    </button>
                </div>
            </div>
        </div>
    `;

    host.appendChild(drawer);

    apiRequest('/config').then(res => {
        if (res.ok && res.config) {
            configCache = { ...configCache, ...res.config };
            const input = document.getElementById('st_al_cfg_gh');
            const promptChk = document.getElementById('st_al_cfg_prompt');
            if (input && configCache.ghAccelerator) input.value = configCache.ghAccelerator;
            if (promptChk) promptChk.checked = configCache.autoPromptOnImport !== false;
        }
    }).catch(() => {});

    document.getElementById('st_al_cfg_save')?.addEventListener('click', async () => {
        const val = document.getElementById('st_al_cfg_gh')?.value.trim();
        const promptVal = document.getElementById('st_al_cfg_prompt')?.checked;
        try {
            await apiRequest('/config', 'POST', { ghAccelerator: val, autoPromptOnImport: promptVal });
            configCache.ghAccelerator = val;
            configCache.autoPromptOnImport = promptVal;
            toastr.success('配置已保存！');
        } catch (e) {
            toastr.error('保存失败: ' + e.message);
        }
    });

    document.getElementById('st_al_cfg_prompt')?.addEventListener('change', async (e) => {
        configCache.autoPromptOnImport = e.target.checked;
        await apiRequest('/config', 'POST', { ...configCache, autoPromptOnImport: e.target.checked }).catch(() => {});
    });

    document.getElementById('st_al_open_panel_btn')?.addEventListener('click', () => {
        showModal();
    });
}

async function checkCharacterOnLoad() {
    if (!configCache.autoPromptOnImport) return;
    const ctx = getCtx();
    const activeChar = ctx?.characters?.[ctx?.this_chid];
    if (!activeChar?.avatar) return;

    const cardFileName = activeChar.avatar;
    try {
        const res = await apiRequest('/scan', 'POST', { cardFileName });
        if (res.ok && res.result && !res.result.isFullyLocalized && res.result.totalExternalCount > 0) {
            toastr.warning(
                `<div style="margin-bottom:6px;">检测到当前角色卡《${res.result.baseName}》包含 <b>${res.result.totalExternalCount}</b> 处外部图池链接，国内可能无法直接加载。</div>` +
                `<button id="st_al_toast_localize_btn" style="background:#2563eb;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;">一键本地化</button>`,
                '图池本地化管家',
                {
                    timeOut: 12000,
                    extendedTimeOut: 6000,
                    onclick: () => {
                        showModal(res.result.baseName);
                    }
                }
            );
        }
    } catch {}
}

function registerSlashCommand() {
    const ctx = getCtx();
    if (!ctx?.SlashCommandParser || !ctx?.SlashCommand) return;

    try {
        ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
            name: 'localize',
            aliases: ['asset-localize'],
            helpString: '打开图池本地化管家控制台，或本地化指定角色卡',
            callback: (args, value) => {
                const target = String(value || '').trim();
                showModal(target || null);
                return '已打开图池本地化管家';
            }
        }));
    } catch (e) {
        console.warn('[图池本地化管家] 注册斜杠指令失败:', e);
    }
}

jQuery(async () => {
    console.log('[图池本地化管家] 客户端插件 2.1 正在加载...');

    setupSettingsDrawer();
    setupCharacterDrawerButton();
    registerSlashCommand();

    const ctx = getCtx();
    if (ctx?.eventSource && ctx?.event_types) {
        ctx.eventSource.on(ctx.event_types.CHARACTER_PAGE_LOADED, () => {
            setupCharacterDrawerButton();
            checkCharacterOnLoad();
        });
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            setupCharacterDrawerButton();
        });
    }

    setInterval(() => {
        setupCharacterDrawerButton();
        setupSettingsDrawer();
    }, 2500);

    console.log('[图池本地化管家] 客户端插件 2.1 加载完成');
});