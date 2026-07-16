// Глобальные переменные
let slaChartInstance = null;
let incidentChartInstance = null;
let currentReportData = {};
let availableZabbixHosts = [];
let activePeriod = 'current-month';
let customStartTs = null;
let customEndTs = null;
let sortColumn = 'name';
let sortDirection = 'asc';
let selectedIncidentEventIds = new Set();
let analyticsChartInstance = null;
let analyticsReportChartInstance = null;
let currentAnalyticsData = null;

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initTabs();
    initPeriodPicker();
    initSortHeaders();
    initEventHandlers();
    initCustomSearchableSelect();
    initAnalyticsGroupForm();
    
    // По умолчанию загружаем данные
    loadDashboardData();
    loadMappings();
    loadSettings();
    
    // Проверка дефолтного пароля админа
    if (window.currentUser && window.currentUser.isDefaultAdmin) {
        showToast('Внимание! Вы вошли с паролем по умолчанию (admin). Пожалуйста, смените его в настройках!', 'error');
        setTimeout(() => {
            const settingsBtn = document.querySelector('.nav-btn[data-tab="settings"]');
            if (settingsBtn) settingsBtn.click();
            const pwdCard = document.getElementById('submit-change-password-btn').closest('.card');
            if (pwdCard) pwdCard.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.4)';
        }, 1500);
    }
});

// === Вспомогательные функции форматирования ===
function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '-';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Текущий порог "сетевого/VPN сбоя" (сек) — читаем прямо из поля настроек,
// чтобы подписи в UI не расходились со значением, которое реально применяет бэкенд
function getVpnThresholdSec() {
    const input = document.getElementById('vpn_issue_threshold_sec');
    const val = input ? parseInt(input.value, 10) : NaN;
    return (Number.isFinite(val) && val > 0) ? val : 60;
}

function formatVpnThresholdLabel(sec) {
    if (sec >= 60 && sec % 60 === 0) {
        return `${sec / 60} мин`;
    }
    return `${sec} сек`;
}

function formatDateTime(unixTimestamp) {
    if (!unixTimestamp) return '-';
    const date = new Date(unixTimestamp * 1000);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

// === Уведомления (Toasts) ===
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-triangle-exclamation';
    
    toast.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    
    // Удаляем уведомление через 4 секунды
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease-out reverse';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// === Управление вкладками ===
function initTabs() {
    const buttons = document.querySelectorAll('.nav-btn');
    const contents = document.querySelectorAll('.tab-content');
    
    // Показываем кнопки, доступные только администраторам
    if (window.currentUser && window.currentUser.role === 'admin') {
        document.querySelectorAll('.nav-btn.admin-only').forEach(btn => {
            btn.style.display = 'flex';
        });
    }

    function activateTab(targetTab) {
        const btn = document.querySelector(`.nav-btn[data-tab="${targetTab}"]`);
        if (!btn) return;

        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        contents.forEach(c => c.classList.remove('active'));
        document.getElementById(`tab-${targetTab}`).classList.add('active');

        const titleMap = {
            'dashboard': 'Панель мониторинга SLA/SLI',
            'analytics-report': 'Аналитика: популярные проблемы',
            'mappings': 'Сопоставление серверов с клиентами',
            'settings': 'Настройки интеграций и SLA',
            'analytics-settings': 'Настройка аналитики: группы проблем',
            'users': 'Управление пользователями системы'
        };
        document.getElementById('page-title').innerText = titleMap[targetTab];

        if (targetTab === 'mappings') {
            loadZabbixHostsForSelect();
        }
        if (targetTab === 'users') {
            loadUsersList();
        }
        if (targetTab === 'analytics-report') {
            loadAnalyticsReportTab();
        }
        if (targetTab === 'analytics-settings') {
            loadAnalyticsGroups();
        }
    }

    buttons.forEach(btn => {
        btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab')));
    });

    // Ссылка "Полный отчет" на мини-диаграмме дашборда переключает вкладку
    document.querySelectorAll('[data-goto-tab]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            activateTab(link.getAttribute('data-goto-tab'));
        });
    });
}

// === Управление селектором времени ===
function initPeriodPicker() {
    const buttons = document.querySelectorAll('.period-quick-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            activePeriod = btn.getAttribute('data-period');
            loadDashboardData();
            refreshAnalyticsReportIfActive();
        });
    });
    
    document.getElementById('apply-dates').addEventListener('click', () => {
        const startVal = document.getElementById('date-start').value;
        const endVal = document.getElementById('date-end').value;
        
        if (!startVal || !endVal) {
            showToast('Выберите обе даты', 'error');
            return;
        }
        
        buttons.forEach(b => b.classList.remove('active'));
        activePeriod = 'custom';
        
        // Преобразуем локальные даты в Unix timestamps (начало старта и конец финиша)
        const startDate = new Date(startVal);
        startDate.setHours(0, 0, 0, 0);
        customStartTs = Math.floor(startDate.getTime() / 1000);
        
        const endDate = new Date(endVal);
        endDate.setHours(23, 59, 59, 999);
        customEndTs = Math.floor(endDate.getTime() / 1000);

        loadDashboardData();
        refreshAnalyticsReportIfActive();
    });
}

function refreshAnalyticsReportIfActive() {
    const tab = document.getElementById('tab-analytics-report');
    if (tab && tab.classList.contains('active')) {
        loadAnalyticsReportTab();
    }
}

function getPeriodTimestamps() {
    const now = new Date();
    let startTs, endTs;
    
    if (activePeriod === 'current-month') {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        startTs = Math.floor(firstDay.getTime() / 1000);
        endTs = Math.floor(now.getTime() / 1000);
    } else if (activePeriod === 'prev-month') {
        const firstDayPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
        const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        startTs = Math.floor(firstDayPrev.getTime() / 1000);
        endTs = Math.floor(lastDayPrev.getTime() / 1000);
    } else if (activePeriod === 'last-30') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        startTs = Math.floor(thirtyDaysAgo.getTime() / 1000);
        endTs = Math.floor(now.getTime() / 1000);
    } else if (activePeriod === 'custom') {
        startTs = customStartTs;
        endTs = customEndTs;
    }
    
    return { startTs, endTs };
}

// === Дашборд и Аналитика ===
async function loadDashboardData() {
    const { startTs, endTs } = getPeriodTimestamps();
    const listContainer = document.getElementById('clients-accordion-list');
    // Спиннер показываем только при первой загрузке: при обновлении данных
    // (комментарий, категория, синхронизация) список не сбрасывается,
    // renderAccordion сам сохранит раскрытые элементы и скролл
    if (!listContainer.querySelector('.accordion-item')) {
        listContainer.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Вычисление SLI метрик...</div>';
    }

    try {
        const response = await fetch(`/api/report?start_time=${startTs}&end_time=${endTs}`);
        const data = await response.json();
        
        currentReportData = data;
        
        if (Object.keys(data).length === 0) {
            listContainer.innerHTML = '<div class="empty-state">Нет серверов, сопоставленных с клиентами. Перейдите во вкладку "Серверы клиентов" для настройки.</div>';
            updateKPIs({ avgSla: 100, avgMttd: 0, avgMttr: 0, totalIncidents: 0 });
            destroyCharts();
            return;
        }
        
        // Подсчет сводных KPI (средний SLA — по всем серверам, как на ТВ-панели)
        let serverSlaSum = 0;
        let serverCount = 0;
        let totalMttdSum = 0;
        let totalMttdCount = 0;
        let totalMttrSum = 0;
        let totalMttrCount = 0;
        let totalIncidentsCount = 0;
        
        // Статистика сбоев для пай-чарта
        let vpnIssuesCount = 0;
        let serverIssuesCount = 0;
        
        for (const clientName in data) {
            const client = data[clientName];

            if (client.mttd_avg_sec > 0) {
                totalMttdSum += client.mttd_avg_sec;
                totalMttdCount++;
            }
            if (client.mttr_avg_sec > 0) {
                totalMttrSum += client.mttr_avg_sec;
                totalMttrCount++;
            }
            totalIncidentsCount += client.total_incidents_count;
            
            // Суммируем SLA серверов и типы сбоев
            client.servers.forEach(srv => {
                serverSlaSum += srv.sla_percent;
                serverCount++;
                srv.incidents.forEach(inc => {
                    if (inc.is_vpn_issue) {
                        vpnIssuesCount++;
                    } else if (inc.is_maintenance || inc.is_power_issue) {
                        // Обслуживание и электропитание не считаем сбоем сервера
                    } else {
                        serverIssuesCount++;
                    }
                });
            });
        }
        
        const summary = {
            avgSla: serverCount > 0 ? (serverSlaSum / serverCount).toFixed(3) : 100,
            avgMttd: totalMttdCount > 0 ? Math.round(totalMttdSum / totalMttdCount) : 0,
            avgMttr: totalMttrCount > 0 ? Math.round(totalMttrSum / totalMttrCount) : 0,
            totalIncidents: totalIncidentsCount
        };
        
        updateKPIs(summary);
        renderCharts(data, vpnIssuesCount, serverIssuesCount);
        renderAccordion(data);
        updatePrintReport(data, summary);
        loadAnalyticsMiniChart(); // Некритичный виджет BI-аналитики, ошибки не должны ронять дашборд

    } catch (err) {
        showToast('Ошибка при загрузке данных дашборда', 'error');
        listContainer.innerHTML = '<div class="empty-state error"><i class="fa-solid fa-triangle-exclamation"></i> Не удалось загрузить данные отчета.</div>';
    }
}

function updateKPIs(summary) {
    document.getElementById('avg-sla').innerText = `${summary.avgSla}%`;
    document.getElementById('avg-mttd').innerText = formatDuration(summary.avgMttd);
    document.getElementById('avg-mttr').innerText = formatDuration(summary.avgMttr);
    document.getElementById('total-incidents').innerText = summary.totalIncidents;
    
    // Красим SLA
    const avgSlaEl = document.getElementById('avg-sla');
    avgSlaEl.className = 'kpi-value';
    if (summary.avgSla >= 99.5) {
        avgSlaEl.style.color = 'var(--success)';
    } else if (summary.avgSla >= 98.0) {
        avgSlaEl.style.color = 'var(--warning)';
    } else {
        avgSlaEl.style.color = 'var(--danger)';
    }
}

function destroyCharts() {
    if (slaChartInstance) slaChartInstance.destroy();
    if (incidentChartInstance) incidentChartInstance.destroy();
}

function renderCharts(reportData, vpnCount, serverCount) {
    destroyCharts();
    
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
    const textColor = isLight ? '#475569' : '#9ca3af';
    
    // 1. График сравнения SLA клиентов
    const clients = Object.keys(reportData);
    const slas = clients.map(c => reportData[c].sla_percent);
    
    const ctxSla = document.getElementById('slaChart').getContext('2d');
    slaChartInstance = new Chart(ctxSla, {
        type: 'bar',
        data: {
            labels: clients,
            datasets: [{
                label: 'SLA (%)',
                data: slas,
                backgroundColor: 'rgba(59, 130, 246, 0.6)',
                borderColor: '#3b82f6',
                borderWidth: 1,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    min: Math.max(0, Math.min(...slas) - 0.5), // Автомасштаб
                    max: 100,
                    grid: { color: gridColor },
                    ticks: { color: textColor }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: textColor }
                }
            }
        }
    });
    
    // 2. Диаграмма структуры сбоев
    const ctxInc = document.getElementById('incidentChart').getContext('2d');
    incidentChartInstance = new Chart(ctxInc, {
        type: 'doughnut',
        data: {
            labels: [`Сеть / VPN (< ${formatVpnThresholdLabel(getVpnThresholdSec())})`, 'Сбои ПО/Серверов'],
            datasets: [{
                data: [vpnCount, serverCount],
                backgroundColor: ['rgba(6, 182, 212, 0.7)', 'rgba(239, 68, 68, 0.7)'],
                borderColor: ['#06b6d4', '#ef4444'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: textColor, boxWidth: 12 }
                }
            }
        }
    });
}

// === BI-аналитика: диаграммы и отчет по группам проблем ===

async function fetchAnalyticsReport() {
    const { startTs, endTs } = getPeriodTimestamps();
    const response = await fetch(`/api/analytics/report?start_time=${startTs}&end_time=${endTs}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

function renderAnalyticsMiniChart(data) {
    const canvas = document.getElementById('analyticsChart');
    if (!canvas) return;
    if (analyticsChartInstance) analyticsChartInstance.destroy();

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const textColor = isLight ? '#475569' : '#9ca3af';

    const groups = data.groups.filter(g => g.count > 0).sort((a, b) => b.count - a.count);
    const topGroups = groups.slice(0, 6);
    const restCount = groups.slice(6).reduce((s, g) => s + g.count, 0) + (data.uncategorized.count || 0);

    const labels = topGroups.map(g => g.name);
    const values = topGroups.map(g => g.count);
    const colors = topGroups.map(g => g.color);

    if (restCount > 0) {
        labels.push('Прочее / не классифицировано');
        values.push(restCount);
        colors.push('#6b7280');
    }

    if (values.length === 0) {
        labels.push('Нет инцидентов за период');
        values.push(1);
        colors.push('rgba(107, 114, 128, 0.3)');
    }

    analyticsChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: colors, borderWidth: 1 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: textColor, boxWidth: 10, font: { size: 11 } } }
            }
        }
    });
}

async function loadAnalyticsMiniChart() {
    try {
        const data = await fetchAnalyticsReport();
        currentAnalyticsData = data;
        renderAnalyticsMiniChart(data);
    } catch (e) {
        // Виджет на дашборде не критичен — молча пропускаем ошибку
    }
}

function renderAnalyticsReportKPIs(data) {
    document.getElementById('an-total-incidents').innerText = data.total_incidents;

    const classifiedCount = data.groups.reduce((s, g) => s + g.count, 0);
    const classifiedPercent = data.total_incidents > 0 ? Math.round(classifiedCount / data.total_incidents * 100) : 0;
    document.getElementById('an-classified-percent').innerText = `${classifiedPercent}%`;

    const topGroup = [...data.groups].sort((a, b) => b.count - a.count)[0];
    document.getElementById('an-top-group').innerText = (topGroup && topGroup.count > 0) ? topGroup.name : '—';

    document.getElementById('an-groups-count').innerText = data.groups.length;
}

function renderAnalyticsReportChart(data) {
    const canvas = document.getElementById('analyticsReportChart');
    if (!canvas) return;
    if (analyticsReportChartInstance) analyticsReportChartInstance.destroy();

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
    const textColor = isLight ? '#475569' : '#9ca3af';

    const all = [...data.groups, data.uncategorized].filter(g => g.count > 0).sort((a, b) => b.count - a.count);

    analyticsReportChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: all.map(g => g.name),
            datasets: [{
                label: 'Инцидентов',
                data: all.map(g => g.count),
                backgroundColor: all.map(g => g.color),
                borderColor: all.map(g => g.color),
                borderWidth: 1,
                borderRadius: 6
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, precision: 0 } },
                y: { grid: { display: false }, ticks: { color: textColor } }
            }
        }
    });
}

function renderAnalyticsIncidentsTable(incidents) {
    if (!incidents || incidents.length === 0) {
        return '<div class="an-empty-note" style="padding: 8px 0;">Инцидентов не найдено</div>';
    }

    const rows = incidents.map(inc => `
        <tr>
            <td>${inc.name}</td>
            <td><span class="client-tag">${inc.client}</span></td>
            <td>${inc.server}</td>
            <td>${formatDateTime(inc.clock)}</td>
            <td>${inc.r_clock ? formatDateTime(inc.r_clock) : '<span class="status-badge server-issue">Активен</span>'}</td>
            <td style="text-align: right;">${formatDuration(inc.downtime_sec)}</td>
        </tr>
    `).join('');

    return `
        <table class="incidents-table">
            <thead>
                <tr>
                    <th>Инцидент</th>
                    <th>Клиент</th>
                    <th>Сервер</th>
                    <th>Начало</th>
                    <th>Окончание</th>
                    <th style="text-align: right;">Простой</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderAnalyticsGroupContent(group, container, openPatterns) {
    container.dataset.rendered = '1';

    // "Не классифицировано" не имеет паттернов — сразу список инцидентов
    if (group.id === null) {
        container.innerHTML = `<div class="an-incidents-wrapper">${renderAnalyticsIncidentsTable(group.incidents)}</div>`;
        return;
    }

    const patterns = group.patterns.filter(p => p.count > 0);
    if (patterns.length === 0) {
        container.innerHTML = '<div class="an-empty-note">Ни один паттерн этой группы не совпал с инцидентами за период</div>';
        return;
    }

    container.innerHTML = patterns.map(p => `
        <div class="an-pattern-item" data-key="pattern-${p.id}">
            <div class="an-pattern-trigger">
                <div class="an-col-expand"><i class="fa-solid fa-chevron-right"></i></div>
                <code>${p.pattern}</code>
                <span class="an-pattern-meta">${p.count} инц. &middot; ${formatDuration(p.downtime_sec)}</span>
            </div>
            <div class="an-pattern-content"></div>
        </div>
    `).join('');

    container.querySelectorAll('.an-pattern-item').forEach(patternItem => {
        const key = patternItem.getAttribute('data-key');
        const patternId = key.replace('pattern-', '');
        const pattern = patterns.find(p => String(p.id) === patternId);
        const trigger = patternItem.querySelector('.an-pattern-trigger');
        const pContent = patternItem.querySelector('.an-pattern-content');

        const renderIncidents = () => {
            pContent.dataset.rendered = '1';
            pContent.innerHTML = `<div class="an-incidents-wrapper">${renderAnalyticsIncidentsTable(pattern.incidents)}</div>`;
        };

        trigger.addEventListener('click', () => {
            const isOpen = patternItem.classList.contains('open');
            patternItem.classList.toggle('open');
            if (!isOpen && !pContent.dataset.rendered) {
                renderIncidents();
            }
        });

        if (openPatterns.has(key)) {
            patternItem.classList.add('open');
            renderIncidents();
        }
    });
}

function renderAnalyticsReportList(data) {
    const container = document.getElementById('analytics-report-list');
    if (!container) return;

    // Запоминаем раскрытые группы/паттерны, чтобы обновление периода не сворачивало аккордеон
    const openGroups = new Set([...container.querySelectorAll('.an-group-item.open')].map(el => el.getAttribute('data-key')));
    const openPatterns = new Set([...container.querySelectorAll('.an-pattern-item.open')].map(el => el.getAttribute('data-key')));

    const all = [...data.groups, data.uncategorized].filter(g => g.count > 0).sort((a, b) => b.count - a.count);

    if (all.length === 0) {
        container.innerHTML = '<div class="an-empty-note">За выбранный период инцидентов не зафиксировано</div>';
        return;
    }

    container.innerHTML = '';
    all.forEach(g => {
        const groupKey = g.id === null ? 'group-uncategorized' : `group-${g.id}`;
        const item = document.createElement('div');
        item.className = 'an-group-item';
        item.setAttribute('data-key', groupKey);

        const clientsHtml = g.top_clients.length
            ? g.top_clients.map(c => `<span class="client-tag">${c.client} (${c.count})</span>`).join(' ')
            : '<span style="color: var(--text-muted);">—</span>';

        item.innerHTML = `
            <div class="an-group-trigger">
                <div class="an-col-expand"><i class="fa-solid fa-chevron-right"></i></div>
                <div class="an-col-name">
                    <span class="analytics-group-swatch" style="background: ${g.color};"></span>
                    <b>${g.name}</b>
                </div>
                <div class="an-col-count">${g.count}</div>
                <div class="an-col-percent">${g.percent}%</div>
                <div class="an-col-downtime">${formatDuration(g.downtime_sec)}</div>
                <div class="an-col-clients">${clientsHtml}</div>
            </div>
            <div class="an-group-content"></div>
        `;

        const trigger = item.querySelector('.an-group-trigger');
        const content = item.querySelector('.an-group-content');

        trigger.addEventListener('click', () => {
            const isOpen = item.classList.contains('open');
            item.classList.toggle('open');
            if (!isOpen && !content.dataset.rendered) {
                renderAnalyticsGroupContent(g, content, openPatterns);
            }
        });

        if (openGroups.has(groupKey)) {
            item.classList.add('open');
            renderAnalyticsGroupContent(g, content, openPatterns);
        }

        container.appendChild(item);
    });
}

async function loadAnalyticsReportTab() {
    const container = document.getElementById('analytics-report-list');
    try {
        const data = await fetchAnalyticsReport();
        currentAnalyticsData = data;
        renderAnalyticsMiniChart(data);
        renderAnalyticsReportKPIs(data);
        renderAnalyticsReportChart(data);
        renderAnalyticsReportList(data);
    } catch (e) {
        showToast('Ошибка при загрузке отчета аналитики', 'error');
        if (container) container.innerHTML = '<div class="an-empty-note" style="color: var(--danger);">Не удалось загрузить отчет аналитики</div>';
    }
}

// === BI-аналитика: управление группами и паттернами (администратор) ===

async function loadAnalyticsGroups() {
    const container = document.getElementById('analytics-groups-list');
    if (!container) return;

    try {
        const response = await fetch('/api/analytics/groups');
        const groups = await response.json();
        renderAnalyticsGroups(groups);
    } catch (e) {
        container.innerHTML = '<div class="empty-state error"><i class="fa-solid fa-triangle-exclamation"></i> Не удалось загрузить группы аналитики</div>';
    }
}

function renderAnalyticsGroups(groups) {
    const container = document.getElementById('analytics-groups-list');
    if (!container) return;

    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-state">Групп пока нет. Создайте первую группу слева.</div>';
        return;
    }

    container.innerHTML = groups.map(g => `
        <div class="analytics-group-block" data-group-id="${g.id}">
            <div class="analytics-group-header">
                <span class="analytics-group-swatch" style="background: ${g.color};"></span>
                <b>${g.name}</b>
                <button type="button" class="pattern-delete-btn analytics-group-delete-btn" data-group-id="${g.id}" data-group-name="${g.name}" title="Удалить группу" style="margin-left: auto;">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            <div class="analytics-pattern-tags">
                ${g.patterns.length ? g.patterns.map(p => `
                    <span class="pattern-tag">
                        ${p.pattern}
                        <i class="fa-solid fa-xmark pattern-tag-remove" data-pattern-id="${p.id}" title="Удалить паттерн"></i>
                    </span>
                `).join('') : '<span style="color: var(--text-muted); font-size: 12px;">Паттернов нет — инциденты не будут попадать в эту группу</span>'}
            </div>
            <div class="analytics-pattern-add-row">
                <input type="text" class="analytics-pattern-input" placeholder="Добавить паттерн (подстрока в имени триггера)...">
                <button type="button" class="analytics-pattern-add-btn" data-group-id="${g.id}"><i class="fa-solid fa-plus"></i></button>
            </div>
        </div>
    `).join('');

    // Удаление группы целиком
    container.querySelectorAll('.analytics-group-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const groupId = btn.getAttribute('data-group-id');
            const groupName = btn.getAttribute('data-group-name');
            if (!confirm(`Удалить группу "${groupName}" вместе со всеми её паттернами?`)) return;

            try {
                const res = await fetch(`/api/analytics/groups/${groupId}`, { method: 'DELETE' });
                if (res.ok) {
                    showToast('Группа удалена');
                    loadAnalyticsGroups();
                    loadAnalyticsMiniChart();
                } else {
                    showToast('Не удалось удалить группу', 'error');
                }
            } catch (e) {
                showToast('Ошибка соединения', 'error');
            }
        });
    });

    // Удаление отдельного паттерна
    container.querySelectorAll('.pattern-tag-remove').forEach(icon => {
        icon.addEventListener('click', async () => {
            const patternId = icon.getAttribute('data-pattern-id');
            try {
                const res = await fetch(`/api/analytics/patterns/${patternId}`, { method: 'DELETE' });
                if (res.ok) {
                    loadAnalyticsGroups();
                    loadAnalyticsMiniChart();
                } else {
                    showToast('Не удалось удалить паттерн', 'error');
                }
            } catch (e) {
                showToast('Ошибка соединения', 'error');
            }
        });
    });

    // Добавление паттерна в группу
    container.querySelectorAll('.analytics-group-block').forEach(block => {
        const groupId = block.getAttribute('data-group-id');
        const input = block.querySelector('.analytics-pattern-input');
        const addBtn = block.querySelector('.analytics-pattern-add-btn');

        const submitPattern = async () => {
            const pattern = input.value.trim();
            if (!pattern) return;

            try {
                const res = await fetch(`/api/analytics/groups/${groupId}/patterns`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pattern })
                });
                if (res.ok) {
                    input.value = '';
                    loadAnalyticsGroups();
                    loadAnalyticsMiniChart();
                } else {
                    const result = await res.json();
                    showToast(result.message || 'Не удалось добавить паттерн', 'error');
                }
            } catch (e) {
                showToast('Ошибка соединения', 'error');
            }
        };

        addBtn.addEventListener('click', submitPattern);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitPattern();
            }
        });
    });
}

function initAnalyticsGroupForm() {
    const form = document.getElementById('analytics-group-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('analytics-group-name');
        const colorInput = document.getElementById('analytics-group-color');
        const name = nameInput.value.trim();

        if (!name) {
            showToast('Введите название группы', 'error');
            return;
        }

        try {
            const res = await fetch('/api/analytics/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color: colorInput.value })
            });
            const result = await res.json();

            if (res.ok) {
                showToast('Группа успешно создана');
                nameInput.value = '';
                colorInput.value = '#3b82f6';
                loadAnalyticsGroups();
                loadAnalyticsMiniChart();
            } else {
                showToast(result.message || 'Не удалось создать группу', 'error');
            }
        } catch (e) {
            showToast('Ошибка соединения', 'error');
        }
    });
}

function getSlaClass(sla) {
    if (sla >= 99.5) return 'good';
    if (sla >= 98.0) return 'warn';
    return 'poor';
}

function initSortHeaders() {
    const headers = document.querySelectorAll('.table-header-row .sortable');
    headers.forEach(h => {
        h.addEventListener('click', () => {
            const col = h.getAttribute('data-sort');
            if (sortColumn === col) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = col;
                sortDirection = 'asc';
            }
            
            headers.forEach(hdr => {
                hdr.classList.remove('active');
                const icon = hdr.querySelector('.sort-icon i');
                if (icon) icon.className = 'fa-solid fa-sort';
            });
            
            h.classList.add('active');
            const currentIcon = h.querySelector('.sort-icon i');
            if (currentIcon) {
                if (sortDirection === 'asc') {
                    currentIcon.className = 'fa-solid fa-sort-up';
                } else {
                    currentIcon.className = 'fa-solid fa-sort-down';
                }
            }
            
            if (currentReportData && Object.keys(currentReportData).length > 0) {
                renderAccordion(currentReportData);
            }
        });
    });
}

let _restoreOpenServers = null;

function renderAccordion(reportData) {
    const listContainer = document.getElementById('clients-accordion-list');

    // Запоминаем раскрытые элементы и скролл, чтобы обновление данных не "передергивало" страницу
    const openClients = new Set(
        [...listContainer.querySelectorAll('.accordion-item.open > .accordion-trigger .col-name')].map(el => el.textContent)
    );
    _restoreOpenServers = new Set(
        [...listContainer.querySelectorAll('.server-accordion.open .server-row')].map(el => el.getAttribute('data-hostid'))
    );
    const scrollTops = [
        [document.scrollingElement, document.scrollingElement ? document.scrollingElement.scrollTop : 0],
        [document.querySelector('.main-content'), document.querySelector('.main-content')?.scrollTop || 0]
    ];

    listContainer.innerHTML = '';

    // Преобразуем объект в массив для сортировки
    const clients = Object.keys(reportData).map(name => ({
        name: name,
        ...reportData[name]
    }));
    
    // Выполняем сортировку
    clients.sort((a, b) => {
        let valA, valB;
        if (sortColumn === 'name') {
            valA = a.name.toLowerCase();
            valB = b.name.toLowerCase();
        } else if (sortColumn === 'sla') {
            valA = a.sla_percent;
            valB = b.sla_percent;
        } else if (sortColumn === 'downtime') {
            valA = a.total_downtime_sec;
            valB = b.total_downtime_sec;
        } else if (sortColumn === 'incidents') {
            valA = a.total_incidents_count;
            valB = b.total_incidents_count;
        } else if (sortColumn === 'mttd') {
            valA = a.mttd_avg_sec;
            valB = b.mttd_avg_sec;
        } else if (sortColumn === 'mttr') {
            valA = a.mttr_avg_sec;
            valB = b.mttr_avg_sec;
        }
        
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
    
    clients.forEach(client => {
        const clientName = client.name;
        const clientItem = document.createElement('div');
        clientItem.className = 'accordion-item';
        
        const slaClass = getSlaClass(client.sla_percent);
        
        clientItem.innerHTML = `
            <div class="accordion-trigger">
                <div class="col-expand"><i class="fa-solid fa-chevron-right"></i></div>
                <div class="col-name">${clientName}</div>
                <div class="col-sla"><span class="sla-badge ${slaClass}">${client.sla_percent.toFixed(3)}%</span></div>
                <div class="col-downtime">${formatDuration(client.total_downtime_sec)}</div>
                <div class="col-incidents">${client.total_incidents_count}</div>
                <div class="col-mttd">${formatDuration(client.mttd_avg_sec)}</div>
                <div class="col-mttr">${formatDuration(client.mttr_avg_sec)}</div>
            </div>
            <div class="accordion-content">
                <div class="servers-list">
                    <!-- Будет заполнено при первом открытии клиента -->
                </div>
            </div>
        `;
        
        const trigger = clientItem.querySelector('.accordion-trigger');
        trigger.addEventListener('click', () => {
            const isOpen = clientItem.classList.contains('open');
            clientItem.classList.toggle('open');

            if (!isOpen) {
                renderClientServers(client, clientItem.querySelector('.servers-list'));
            }
        });

        // Восстанавливаем раскрытое состояние после перерисовки
        if (openClients.has(clientName)) {
            clientItem.classList.add('open');
            renderClientServers(client, clientItem.querySelector('.servers-list'));
        }

        listContainer.appendChild(clientItem);
    });

    _restoreOpenServers = null;
    applyDashboardFilter();
    scrollTops.forEach(([el, top]) => { if (el) el.scrollTop = top; });
}

function applyDashboardFilter() {
    const input = document.getElementById('dashboard-search');
    const q = (input ? input.value : '').trim().toLowerCase();

    document.querySelectorAll('#clients-accordion-list .accordion-item').forEach(item => {
        const clientName = item.querySelector('.accordion-trigger .col-name').textContent;
        let match = !q || clientName.toLowerCase().includes(q);

        // Ищем и по именам серверов клиента
        if (!match && currentReportData && currentReportData[clientName]) {
            match = currentReportData[clientName].servers.some(s => s.name.toLowerCase().includes(q));
        }

        item.style.display = match ? '' : 'none';
    });
}

function renderClientServers(client, container) {
    container.innerHTML = '';
    
    client.servers.forEach(srv => {
        const serverItem = document.createElement('div');
        serverItem.className = 'server-accordion';
        
        const srvSlaClass = getSlaClass(srv.sla_percent);
        
        serverItem.innerHTML = `
            <div class="server-row" data-hostid="${srv.hostid}">
                <div class="col-expand"><i class="fa-solid fa-chevron-right"></i></div>
                <div class="col-name">
                    <div class="server-name-container">
                        <span>${srv.name}</span>
                        <span class="server-comment">${srv.comment || 'Без комментария'}</span>
                    </div>
                </div>
                <div class="col-sla"><span class="sla-badge ${srvSlaClass}">${srv.sla_percent.toFixed(3)}%</span></div>
                <div class="col-downtime">${formatDuration(srv.downtime_sec)}</div>
                <div class="col-incidents">${srv.incidents_count}</div>
                <div class="col-mttd">${formatDuration(srv.mttd_sec)}</div>
                <div class="col-mttr">${formatDuration(srv.mttr_sec)}</div>
            </div>
            <div class="accordion-content incident-content-wrapper" style="background-color: rgba(0,0,0,0.4);">
                <div class="incidents-container">
                    <h4>Журнал инцидентов сервера</h4>
                    <div class="incidents-table-wrapper">
                        <table class="incidents-table">
                            <thead>
                                <tr>
                                    <th style="width: 30px; text-align: center;"><input type="checkbox" class="select-all-incidents-checkbox"></th>
                                    <th>Инцидент</th>
                                    <th>Критичность</th>
                                    <th>Начало</th>
                                    <th>Конец / Статус</th>
                                    <th>Длительность</th>
                                    <th>Категория сбоя</th>
                                    <th>Реакция</th>
                                    <th>Решение</th>
                                    <th>Комментарий / Причина</th>
                                </tr>
                            </thead>
                            <tbody>
                                <!-- Заполняется инцидентами -->
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        
        const expandServer = () => {
                const tbodyEl = serverItem.querySelector('.incidents-table tbody');
                renderServerIncidents(srv, tbodyEl);

                // Обработчик "Выбрать все" для конкретной таблицы сервера
                const selectAllCheckbox = serverItem.querySelector('.select-all-incidents-checkbox');
                if (selectAllCheckbox) {
                    selectAllCheckbox.checked = false;
                    selectAllCheckbox.addEventListener('change', (evt) => {
                        const checkboxes = tbodyEl.querySelectorAll('.incident-select-checkbox');
                        checkboxes.forEach(cb => {
                            cb.checked = evt.target.checked;
                            const evId = cb.getAttribute('data-eventid');
                            if (evt.target.checked) {
                                selectedIncidentEventIds.add(evId);
                            } else {
                                selectedIncidentEventIds.delete(evId);
                            }
                        });
                        updateBulkActionsPanel();
                    });
                }
        };

        const srvRow = serverItem.querySelector('.server-row');
        srvRow.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = serverItem.classList.contains('open');
            serverItem.classList.toggle('open');

            if (!isOpen) {
                expandServer();
            }
        });

        // Восстанавливаем раскрытый журнал сервера после перерисовки
        if (_restoreOpenServers && _restoreOpenServers.has(String(srv.hostid))) {
            serverItem.classList.add('open');
            expandServer();
        }

        container.appendChild(serverItem);
    });
}

function renderServerIncidents(srv, tbody) {
    tbody.innerHTML = '';
    
    if (srv.incidents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="color: var(--text-muted);">За выбранный период инцидентов не зафиксировано</td></tr>`;
        return;
    }
    
    const severityNames = ['Info', 'Warning', 'Average', 'High', 'Disaster'];
    
    srv.incidents.forEach(inc => {
        // Категория
        let categoryHtml = '';
        if (inc.is_vpn_issue) {
            categoryHtml = `<span class="status-badge vpn-issue"><i class="fa-solid fa-wifi"></i> Сеть / VPN (&lt;${formatVpnThresholdLabel(getVpnThresholdSec())})</span>`;
        } else if (inc.is_maintenance) {
            categoryHtml = `<span class="status-badge maintenance"><i class="fa-solid fa-screwdriver-wrench"></i> Обслуживание</span>`;
        } else if (inc.is_power_issue) {
            categoryHtml = `<span class="status-badge power-issue"><i class="fa-solid fa-plug-circle-bolt"></i> Электропитание</span>`;
        } else {
            categoryHtml = `<span class="status-badge server-issue"><i class="fa-solid fa-triangle-exclamation"></i> Сбой ПО/Сервера</span>`;
        }
        
        // Статус решенности
        const endStr = inc.r_clock ? formatDateTime(inc.r_clock) : '<span class="status-badge server-issue">Активен</span>';
        
        // Форматирование даты комментария
        let commentDateStr = '';
        if (inc.comment_date) {
            try {
                // Преобразуем строку даты вида "2026-07-12 01:52:26" в дату
                const d = new Date(inc.comment_date.replace(' ', 'T'));
                const day = d.getDate().toString().padStart(2, '0');
                const month = (d.getMonth() + 1).toString().padStart(2, '0');
                commentDateStr = `${day}.${month}`;
            } catch (err) {
                commentDateStr = '';
            }
        }
        
        // Рендеринг ячейки комментария
        const commentCellHtml = `
            <div class="comment-cell">
                ${inc.comment_text ? `
                    <div class="comment-bubble" title="Комментарий добавил: ${inc.comment_user} (${inc.comment_date})">
                        ${inc.comment_text}
                        <span class="comment-author-info">${inc.comment_user}, ${commentDateStr}</span>
                    </div>
                ` : '<span style="color: var(--text-muted); font-style: italic; font-size: 11px;">Нет</span>'}
                <button class="edit-comment-btn" data-eventid="${inc.eventid}" data-name="${inc.name}" data-time="${inc.clock}" title="Добавить/Редактировать комментарий">
                     <i class="fa-solid fa-comment-medical"></i>
                </button>
            </div>
        `;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align: center;">
                <input type="checkbox" class="incident-select-checkbox" data-eventid="${inc.eventid}">
            </td>
            <td>
                <b>${inc.name}</b>
                ${inc.is_ignored_by_pattern ? `<span class="ignored-label-badge" title="Исключен из SLA по правилу фильтрации"><i class="fa-solid fa-filter"></i> Исключен</span>` : ''}
            </td>
            <td>
                <span class="severity-indicator">
                    <span class="severity-dot sev-${inc.severity}"></span>
                    <span>${severityNames[inc.severity - 1] || 'Unknown'}</span>
                </span>
            </td>
            <td>${formatDateTime(inc.clock)}</td>
            <td>${endStr}</td>
            <td>${formatDuration(inc.duration)}</td>
            <td>${categoryHtml}</td>
            <td>${formatDuration(inc.mttd_sec)}</td>
            <td>${formatDuration(inc.mttr_sec)}</td>
            <td>${commentCellHtml}</td>
        `;
        
        // Восстанавливаем состояние чекбокса, если событие уже выбрано в глобальном списке
        const checkbox = tr.querySelector('.incident-select-checkbox');
        if (selectedIncidentEventIds.has(inc.eventid)) {
            checkbox.checked = true;
        }
        
        // Слушаем изменение чекбокса
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedIncidentEventIds.add(inc.eventid);
            } else {
                selectedIncidentEventIds.delete(inc.eventid);
                // Снимаем галочку "выбрать все" в шапке этой таблицы
                const selectAll = tbody.closest('.incidents-table').querySelector('.select-all-incidents-checkbox');
                if (selectAll) selectAll.checked = false;
            }
            updateBulkActionsPanel();
        });
        
        // Навешиваем событие клика на кнопку комментария
        const editBtn = tr.querySelector('.edit-comment-btn');
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const eventid = editBtn.getAttribute('data-eventid');
            const name = editBtn.getAttribute('data-name');
            const time = editBtn.getAttribute('data-time');
            openCommentModal(eventid, name, time);
        });
        
        tbody.appendChild(tr);
    });
}

// === Сопоставление серверов (Mappings) ===
async function loadMappings() {
    try {
        const response = await fetch('/api/mappings');
        const mappings = await response.json();
        
        const tbody = document.getElementById('mappings-table-body');
        tbody.innerHTML = '';
        
        document.querySelector('.mappings-list-card h3').innerText = `Все серверы и привязки (${mappings.length})`;
        
        // Обновим datalist существующих клиентов
        const datalist = document.getElementById('existing-clients');
        datalist.innerHTML = '';
        const uniqueClients = [...new Set(mappings.map(m => m.client_name))];
        uniqueClients.forEach(c => {
            datalist.innerHTML += `<option value="${c}">`;
        });
        
        if (mappings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">Нет привязанных серверов. Выполните синхронизацию Zabbix.</td></tr>';
            return;
        }
        
        mappings.forEach(m => {
            const tr = document.createElement('tr');
            
            // Если привязка сделана вручную (is_manual=1), даем возможность сбросить её к автоматической.
            // Если автоматическая, показываем иконку робота (автоопределение)
            const actionHtml = m.is_manual ? 
                `<button class="delete-row-btn" data-id="${m.zabbix_hostid}" title="Сбросить к автоопределению Zabbix" style="color: var(--warning); margin-left: 8px; background: none; border: none; cursor: pointer;"><i class="fa-solid fa-arrow-rotate-left"></i></button>` : 
                `<span style="color: var(--text-muted); font-size: 11px; margin-left: 8px;" title="Определено автоматически"><i class="fa-solid fa-robot"></i> Авто</span>`;
            
            tr.innerHTML = `
                <td><b>${m.host_name}</b> <small style="color: var(--text-muted); display: block;">${m.zabbix_hostid}</small></td>
                <td><span style="background-color: rgba(255,255,255,0.06); padding: 4px 8px; border-radius: 6px; font-weight:600;">${m.client_name}</span></td>
                <td>${m.comment || '-'}</td>
                <td class="text-center" style="display: flex; align-items: center; justify-content: center; gap: 8px; height: 100%;">
                    <button class="edit-row-btn" data-id="${m.zabbix_hostid}" data-name="${m.host_name}" data-client="${m.client_name}" data-comment="${m.comment || ''}" title="Редактировать" style="background:none; border:none; color:var(--text-secondary); cursor:pointer;"><i class="fa-solid fa-pen-to-square"></i></button>
                    ${actionHtml}
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Вешаем обработчики удаления (сброса)
        tbody.querySelectorAll('.delete-row-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const hostid = btn.getAttribute('data-id');
                if (confirm('Сбросить привязку к значению автоопределения Zabbix? Пользовательский комментарий и имя клиента будут удалены.')) {
                    try {
                        const delRes = await fetch(`/api/mappings/${hostid}`, { method: 'DELETE' });
                        const res = await delRes.json();
                        if (res.status === 'success') {
                            showToast('Пользовательская привязка удалена. Восстановлено автоопределение.');
                            loadMappings();
                            loadDashboardData();
                        }
                    } catch (e) {
                        showToast('Не удалось сбросить привязку', 'error');
                    }
                }
            });
        });
        
        // Вешаем обработчики редактирования
        tbody.querySelectorAll('.edit-row-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const hostid = btn.getAttribute('data-id');
                const hostName = btn.getAttribute('data-name');
                const client = btn.getAttribute('data-client');
                const comment = btn.getAttribute('data-comment');
                
                // Заполняем форму слева
                const hiddenInput = document.getElementById('zabbix-host-select');
                hiddenInput.value = hostid;
                
                const customSelect = document.getElementById('zabbix-host-custom-select');
                if (customSelect) {
                    customSelect.querySelector('.custom-select-value').innerText = hostName;
                    
                    // Выделяем выбранную опцию в списке
                    const optionsContainer = customSelect.querySelector('.custom-select-options');
                    optionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
                        if (opt.getAttribute('data-value') === hostid) {
                            opt.classList.add('selected');
                        } else {
                            opt.classList.remove('selected');
                        }
                    });
                }
                
                document.getElementById('client-name-input').value = client;
                document.getElementById('comment-input').value = comment;
                
                // Скроллим к форме на мобильных
                document.getElementById('mapping-form').scrollIntoView({ behavior: 'smooth' });
                
                showToast('Сервер выбран для редактирования');
            });
        });
        
    } catch (e) {
        showToast('Не удалось загрузить маппинги', 'error');
    }
}

async function loadZabbixHostsForSelect() {
    const customSelect = document.getElementById('zabbix-host-custom-select');
    if (!customSelect) return;
    
    const triggerValue = customSelect.querySelector('.custom-select-value');
    const optionsContainer = customSelect.querySelector('.custom-select-options');
    const hiddenInput = document.getElementById('zabbix-host-select');
    
    triggerValue.innerText = 'Загрузка хостов...';
    optionsContainer.innerHTML = '';
    
    try {
        const response = await fetch('/api/zabbix-hosts');
        const hosts = await response.json();
        
        if (hosts.status === 'error') {
            triggerValue.innerText = `Ошибка: ${hosts.message}`;
            return;
        }
        
        availableZabbixHosts = hosts;
        triggerValue.innerText = 'Выберите хост...';
        hiddenInput.value = '';
        
        hosts.forEach(h => {
            const opt = document.createElement('div');
            opt.className = 'custom-select-option';
            opt.setAttribute('data-value', h.hostid);
            opt.innerText = h.name;
            
            opt.addEventListener('click', () => {
                hiddenInput.value = h.hostid;
                triggerValue.innerText = h.name;
                customSelect.classList.remove('open');
                
                // Снимаем выделение с других опций и ставим на текущую
                optionsContainer.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            });
            
            optionsContainer.appendChild(opt);
        });
        
    } catch (e) {
        triggerValue.innerText = 'Ошибка загрузки хостов из Zabbix';
    }
}

// Поиск по привязкам
document.getElementById('mappings-search').addEventListener('input', (e) => {
    const searchVal = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#mappings-table-body tr');
    
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        if (text.includes(searchVal) || row.innerHTML.includes('colspan')) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
});

// Форма маппингов
document.getElementById('mapping-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const zabbix_hostid = document.getElementById('zabbix-host-select').value;
    let host_name = availableZabbixHosts.find(h => h.hostid === zabbix_hostid)?.name;
    if (!host_name) {
        const customSelect = document.getElementById('zabbix-host-custom-select');
        host_name = customSelect ? customSelect.querySelector('.custom-select-value').innerText : '';
    }
    const client_name = document.getElementById('client-name-input').value.trim();
    const comment = document.getElementById('comment-input').value.trim();
    
    if (!zabbix_hostid || !client_name) {
        showToast('Пожалуйста, заполните все обязательные поля', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/mappings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zabbix_hostid, host_name, client_name, comment })
        });
        const res = await response.json();
        
        if (res.status === 'success') {
            showToast('Сервер клиента успешно добавлен!');
            document.getElementById('mapping-form').reset();
            const customSelect = document.getElementById('zabbix-host-custom-select');
            if (customSelect) {
                customSelect.querySelector('.custom-select-value').innerText = 'Выберите хост...';
                customSelect.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
            }
            loadMappings();
            loadZabbixHostsForSelect();
            loadDashboardData();
        } else {
            showToast(res.message, 'error');
        }
    } catch (err) {
        showToast('Не удалось сохранить привязку', 'error');
    }
});

function toggleIgnoredGroupsField() {
    const mappingModeEl = document.getElementById('mapping_mode');
    const container = document.getElementById('ignored_host_groups_container');
    if (mappingModeEl && container) {
        if (mappingModeEl.value === 'group_auto') {
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }
    }
}

// === Настройки (Settings) ===
async function loadSettings() {
    try {
        const response = await fetch('/api/settings');
        const settings = await response.json();
        
        // Заполняем поля формы
        for (const key in settings) {
            const input = document.getElementById(key);
            if (input) {
                if (input.type === 'checkbox') {
                    input.checked = settings[key] === '1';
                } else {
                    input.value = settings[key];
                }
            }
        }
        
        // Управляем видимостью списка исключаемых групп
        toggleIgnoredGroupsField();
        
        // Загружаем правила фильтрации
        loadIncidentPatterns();
    } catch (e) {
        showToast('Ошибка при загрузке настроек', 'error');
    }
}

// Поиск по клиентам и серверам на дашборде
const _dashboardSearchInput = document.getElementById('dashboard-search');
if (_dashboardSearchInput) {
    _dashboardSearchInput.addEventListener('input', applyDashboardFilter);
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const settingsData = {};
    const inputs = document.querySelectorAll('#settings-form input, #settings-form select, #settings-form textarea');
    
    inputs.forEach(input => {
        if (input.id) {
            if (input.type === 'checkbox') {
                settingsData[input.id] = input.checked ? '1' : '0';
            } else {
                settingsData[input.id] = input.value;
            }
        }
    });
    
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settingsData)
        });
        const res = await response.json();
        
        if (res.status === 'success') {
            showToast('Настройки сохранены успешно!');
            loadSettings();
            loadDashboardData();
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        showToast('Не удалось сохранить настройки', 'error');
    }
});

// === Тесты и Синхронизация ===
function initEventHandlers() {
    // Отслеживание смены режима сопоставления клиентов
    const mappingModeEl = document.getElementById('mapping_mode');
    if (mappingModeEl) {
        mappingModeEl.addEventListener('change', toggleIgnoredGroupsField);
    }

    // Кнопка ручной синхронизации в сайдбаре
    const manualSyncBtn = document.getElementById('manual-sync-btn');
    const syncStatusEl = document.getElementById('sync-status');
    
    manualSyncBtn.addEventListener('click', async () => {
        manualSyncBtn.disabled = true;
        syncStatusEl.classList.add('syncing');
        syncStatusEl.querySelector('span').innerText = 'Синхронизация...';
        
        try {
            const response = await fetch('/api/sync', { method: 'POST' });
            const res = await response.json();
            
            if (res.status === 'success') {
                showToast('Данные Zabbix успешно синхронизированы!');
                loadDashboardData();
            } else {
                showToast(res.message, 'error');
            }
        } catch (e) {
            showToast('Сбой синхронизации', 'error');
        } finally {
            manualSyncBtn.disabled = false;
            syncStatusEl.classList.remove('syncing');
            syncStatusEl.querySelector('span').innerText = 'Данные обновлены';
        }
    });
    
    // Проверка SMTP
    document.getElementById('test-smtp-btn').addEventListener('click', () => {
        openEmailModal();
    });
    
    // Проверка Telegram
    document.getElementById('test-tg-btn').addEventListener('click', async () => {
        const btn = document.getElementById('test-tg-btn');
        btn.disabled = true;
        showToast('Отправка тестового сообщения...', 'info');
        
        try {
            const response = await fetch('/api/send-telegram', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(getPeriodTimestamps())
            });
            const res = await response.json();
            
            if (res.status === 'success') {
                showToast('Тестовый отчет отправлен в Telegram!');
            } else {
                showToast(res.message, 'error');
            }
        } catch (e) {
            showToast('Не удалось отправить сообщение Telegram', 'error');
        } finally {
            btn.disabled = false;
        }
    });
    
    // Отправка отчета в Telegram с Дашборда
    document.getElementById('tg-report-btn').addEventListener('click', async () => {
        const btn = document.getElementById('tg-report-btn');
        btn.disabled = true;
        showToast('Отправка отчета в Telegram...', 'info');
        
        try {
            const response = await fetch('/api/send-telegram', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(getPeriodTimestamps())
            });
            const res = await response.json();
            
            if (res.status === 'success') {
                showToast('Отчет отправлен в Telegram!');
            } else {
                showToast(res.message, 'error');
            }
        } catch (e) {
            showToast('Не удалось отправить отчет в Telegram', 'error');
        } finally {
            btn.disabled = false;
        }
    });
    
    // Модальное окно email
    const modal = document.getElementById('email-modal');
    const closeBtn = document.querySelector('.close-modal');
    
    document.getElementById('email-report-btn').addEventListener('click', () => {
        openEmailModal();
    });
    
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
    
    document.getElementById('modal-send-btn').addEventListener('click', async () => {
        const email = document.getElementById('modal-email-input').value.trim();
        if (!email) {
            showToast('Введите корректный email', 'error');
            return;
        }
        
        modal.style.display = 'none';
        showToast('Подготовка и отправка отчета по почте...', 'info');
        
        const { startTs, endTs } = getPeriodTimestamps();
        
        try {
            const response = await fetch('/api/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient: email, start_time: startTs, end_time: endTs })
            });
            const res = await response.json();
            
            if (res.status === 'success') {
                showToast(`Отчет успешно отправлен на ${email}`);
            } else {
                showToast(res.message, 'error');
            }
        } catch (e) {
            showToast('Не удалось отправить отчет на почту', 'error');
        }
    });
    // Смена собственного пароля
    const changePasswordBtn = document.getElementById('submit-change-password-btn');
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', async () => {
            const old_password = document.getElementById('change_old_password').value;
            const new_password = document.getElementById('change_new_password').value;
            const confirm_password = document.getElementById('change_confirm_password').value;
            
            if (!old_password || !new_password || !confirm_password) {
                showToast('Заполните все поля для смены пароля', 'error');
                return;
            }
            if (new_password.length < 5) {
                showToast('Новый пароль должен быть не менее 5 символов', 'error');
                return;
            }
            if (new_password !== confirm_password) {
                showToast('Новые пароли не совпадают', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/profile/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ old_password, new_password })
                });
                const result = await response.json();
                
                if (response.ok) {
                    showToast('Пароль успешно изменен');
                    document.getElementById('change_old_password').value = '';
                    document.getElementById('change_new_password').value = '';
                    document.getElementById('change_confirm_password').value = '';
                    
                    const pwdCard = changePasswordBtn.closest('.card');
                    if (pwdCard) pwdCard.style.boxShadow = '';
                } else {
                    showToast(result.message || 'Ошибка смены пароля', 'error');
                }
            } catch (err) {
                showToast('Ошибка соединения при смене пароля', 'error');
            }
        });
    }

    // Обработчик закрытия модала комментариев
    const commentModal = document.getElementById('comment-modal');
    const closeCommentModal = document.getElementById('close-comment-modal');
    if (closeCommentModal) {
        closeCommentModal.addEventListener('click', () => {
            commentModal.style.display = 'none';
        });
    }
    window.addEventListener('click', (e) => {
        if (e.target === commentModal) {
            commentModal.style.display = 'none';
        }
    });

    // Обработчик сохранения комментария и категории к инциденту
    const saveCommentBtn = document.getElementById('modal-save-comment-btn');
    if (saveCommentBtn) {
        saveCommentBtn.addEventListener('click', async () => {
            const textarea = document.getElementById('modal-comment-textarea');
            const categorySelect = document.getElementById('modal-comment-category');
            
            const comment = textarea.value.trim();
            const category = categorySelect.value;
            
            if (!comment) {
                showToast('Введите текст комментария', 'error');
                return;
            }
            
            try {
                // Отправляем комментарий и категорию параллельно
                const commentPromise = fetch(`/api/incidents/${currentEditingEventId}/comment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ comment })
                });
                
                const categoryPromise = fetch(`/api/incidents/${currentEditingEventId}/category`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ category })
                });
                
                const [commentRes, categoryRes] = await Promise.all([commentPromise, categoryPromise]);
                
                if (commentRes.ok && categoryRes.ok) {
                    showToast('Изменения успешно сохранены');
                    commentModal.style.display = 'none';
                    loadDashboardData(); // Обновляем дашборд
                } else {
                    showToast('Ошибка при сохранении изменений', 'error');
                }
            } catch (err) {
                showToast('Ошибка сети при сохранении изменений', 'error');
            }
        });
    }

    // Создание пользователя администратором
    const createUserForm = document.getElementById('create-user-form');
    if (createUserForm) {
        createUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('new_user_username').value.trim();
            const password = document.getElementById('new_user_password').value;
            const role = document.getElementById('new_user_role').value;
            
            if (!username || !password) {
                showToast('Введите имя пользователя и пароль', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, role })
                });
                const result = await response.json();
                
                if (response.ok) {
                    showToast(result.message);
                    createUserForm.reset();
                    loadUsersList();
                } else {
                    showToast(result.message || 'Ошибка при создании пользователя', 'error');
                }
            } catch (err) {
                showToast('Ошибка соединения', 'error');
            }
        });
    }
    
    // Инициализация групповых сбоев и паттернов исключений
    initBulkActionsAndPatterns();
}

function initTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        const currentTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        updateThemeIcon(themeToggleBtn, currentTheme);

        themeToggleBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateThemeIcon(themeToggleBtn, newTheme);
            
            // Перерисовываем графики
            if (currentReportData && Object.keys(currentReportData).length > 0) {
                loadDashboardData();
            }
        });
    }
}

function updateThemeIcon(btn, theme) {
    const icon = btn.querySelector('i');
    if (theme === 'light') {
        icon.className = 'fa-solid fa-sun';
    } else {
        icon.className = 'fa-solid fa-moon';
    }
}

function openEmailModal() {
    const modal = document.getElementById('email-modal');
    modal.style.display = 'flex';
    document.getElementById('modal-email-input').focus();
}

// === Управление комментариями и пользователями ===

let currentEditingEventId = null;

function openCommentModal(eventid, name, time) {
    currentEditingEventId = eventid;
    const modal = document.getElementById('comment-modal');
    const details = document.getElementById('comment-modal-incident-details');
    const textarea = document.getElementById('modal-comment-textarea');
    const categorySelect = document.getElementById('modal-comment-category');
    
    details.innerHTML = `<strong>Сбой:</strong> ${name}<br><strong>Начало:</strong> ${formatDateTime(parseInt(time))}`;
    
    let existingComment = '';
    let existingCategory = 'auto';
    
    for (const clientName in currentReportData) {
        for (const srv of currentReportData[clientName].servers) {
            const inc = srv.incidents.find(i => i.eventid === eventid);
            if (inc) {
                if (inc.comment_text) {
                    existingComment = inc.comment_text;
                }
                existingCategory = inc.overridden_category || 'auto';
                break;
            }
        }
    }
    
    textarea.value = existingComment;
    categorySelect.value = existingCategory;
    modal.style.display = 'flex';
    textarea.focus();
}

async function loadUsersList() {
    if (window.currentUser && window.currentUser.role !== 'admin') return;
    
    try {
        const response = await fetch('/api/users');
        const users = await response.json();
        
        const tbody = document.querySelector('#users-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        users.forEach(user => {
            const tr = document.createElement('tr');
            const roleClass = user.role === 'admin' ? 'admin' : 'user';
            const roleName = user.role === 'admin' ? 'Администратор' : 'Пользователь';
            
            const isSelf = user.username === window.currentUser.username;
            const deleteBtnHtml = isSelf 
                ? '<span style="color: var(--text-muted); font-size: 12px; font-style: italic;">Это вы</span>'
                : `<button class="delete-user-btn" data-userid="${user.id}" data-username="${user.username}" title="Удалить пользователя">
                       <i class="fa-solid fa-trash-can"></i> Удалить
                   </button>`;
            
            tr.innerHTML = `
                <td>${user.id}</td>
                <td><b>${user.username}</b></td>
                <td><span class="user-role-badge ${roleClass}">${roleName}</span></td>
                <td style="text-align: right;">${deleteBtnHtml}</td>
            `;
            tbody.appendChild(tr);
        });
        
        tbody.querySelectorAll('.delete-user-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const userId = btn.getAttribute('data-userid');
                const username = btn.getAttribute('data-username');
                
                if (confirm(`Вы уверены, что хотите удалить пользователя ${username}?`)) {
                    try {
                        const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
                        const result = await res.json();
                        if (res.ok) {
                            showToast(result.message);
                            loadUsersList();
                        } else {
                            showToast(result.message || 'Ошибка при удалении', 'error');
                        }
                    } catch (err) {
                        showToast('Ошибка соединения', 'error');
                    }
                }
            });
        });
    } catch (err) {
        showToast('Не удалось загрузить список пользователей', 'error');
    }
}

// Инициализация кастомного выпадающего списка с поиском
function initCustomSearchableSelect() {
    const selectContainer = document.getElementById('zabbix-host-custom-select');
    if (!selectContainer) return;
    
    const trigger = selectContainer.querySelector('.custom-select-trigger');
    const dropdown = selectContainer.querySelector('.custom-select-dropdown');
    const searchInput = selectContainer.querySelector('.custom-select-search input');
    const optionsContainer = selectContainer.querySelector('.custom-select-options');
    const hiddenInput = document.getElementById('zabbix-host-select');
    
    // Переключение открытости списка
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = selectContainer.classList.contains('open');
        
        if (!isOpen) {
            selectContainer.classList.add('open');
            searchInput.focus();
            searchInput.value = '';
            filterCustomOptions('');
        } else {
            selectContainer.classList.remove('open');
        }
    });
    
    // Закрытие списка при клике мимо него
    document.addEventListener('click', () => {
        selectContainer.classList.remove('open');
    });
    
    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // Логика фильтрации при вводе
    searchInput.addEventListener('input', (e) => {
        filterCustomOptions(e.target.value);
    });
    
    function filterCustomOptions(query) {
        const lowerQuery = query.toLowerCase();
        const options = optionsContainer.querySelectorAll('.custom-select-option');
        options.forEach(opt => {
            const text = opt.innerText.toLowerCase();
            if (text.includes(lowerQuery)) {
                opt.style.display = 'block';
            } else {
                opt.style.display = 'none';
            }
        });
    }
}

// Генерация структурированного PDF/печатного отчета
function updatePrintReport(reportData, summary) {
    const container = document.getElementById('print-report-container');
    if (!container) return;
    
    const { startTs, endTs } = getPeriodTimestamps();
    const dateStartStr = formatPrintDate(startTs);
    const dateEndStr = formatPrintDate(endTs);
    const generatedStr = new Date().toLocaleString('ru-RU');
    
    // 1. Собираем топ-20 проблемных серверов (по возрастанию SLA)
    const allServers = [];
    for (const clientName in reportData) {
        const client = reportData[clientName];
        client.servers.forEach(srv => {
            allServers.push({
                clientName: clientName,
                name: srv.name,
                sla_percent: srv.sla_percent,
                downtime_sec: srv.downtime_sec,
                incidents_count: srv.incidents_count,
                comment: srv.comment || ''
            });
        });
    }
    
    // Сортируем: сначала те, у кого SLA ниже
    allServers.sort((a, b) => a.sla_percent - b.sla_percent);
    const top20 = allServers.slice(0, 20);
    
    // 2. Строим HTML печатной страницы
    let html = `
        <div class="print-header">
            <h1>Отчет по доступности ИТ-сервисов (SLA/SLI)</h1>
            <div class="print-meta">
                <span>Период: <b>${dateStartStr} — ${dateEndStr}</b></span>
                <span>Сформирован: ${generatedStr}</span>
            </div>
        </div>
        
        <div class="print-stats-grid">
            <div class="print-stat-card">
                <div class="print-stat-label">Средний SLA</div>
                <div class="print-stat-value" style="color: ${summary.avgSla >= 99.5 ? '#166534' : (summary.avgSla >= 98.0 ? '#9a3412' : '#991b1b')}">${summary.avgSla}%</div>
            </div>
            <div class="print-stat-card">
                <div class="print-stat-label">Всего инцидентов</div>
                <div class="print-stat-value">${summary.totalIncidents}</div>
            </div>
            <div class="print-stat-card">
                <div class="print-stat-label">Ср. время реакции (MTTD)</div>
                <div class="print-stat-value">${formatDuration(summary.avgMttd)}</div>
            </div>
            <div class="print-stat-card">
                <div class="print-stat-label">Ср. время решения (MTTR)</div>
                <div class="print-stat-value">${formatDuration(summary.avgMttr)}</div>
            </div>
        </div>
        
        <div class="print-section-title">Топ-20 проблемных серверов (по SLA)</div>
        <table class="print-table">
            <thead>
                <tr>
                    <th style="width: 40px; text-align: center;">№</th>
                    <th>Клиент</th>
                    <th>Сервер</th>
                    <th style="width: 100px; text-align: right;">Uptime %</th>
                    <th style="width: 100px; text-align: center;">Время простоя</th>
                    <th style="width: 70px; text-align: center;">Сбоев</th>
                    <th>Комментарий</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    if (top20.length === 0) {
        html += `<tr><td colspan="7" style="text-align: center;">Нет данных</td></tr>`;
    } else {
        top20.forEach((srv, index) => {
            const slaClass = srv.sla_percent >= 99.5 ? 'good' : (srv.sla_percent >= 98.0 ? 'warn' : 'poor');
            html += `
                <tr>
                    <td style="text-align: center;">${index + 1}</td>
                    <td><b>${srv.clientName}</b></td>
                    <td>${srv.name}</td>
                    <td style="text-align: right;" class="print-sla-badge ${slaClass}">${srv.sla_percent.toFixed(3)}%</td>
                    <td style="text-align: center;">${formatDuration(srv.downtime_sec)}</td>
                    <td style="text-align: center;">${srv.incidents_count}</td>
                    <td style="font-size: 11px; color: #555;">${srv.comment || '-'}</td>
                </tr>
            `;
        });
    }
    
    html += `
            </tbody>
        </table>

        <div class="page-break"></div>

        <div class="print-section-title" style="margin-top: 0;">Все проблемы по серверам за период</div>
        <table class="print-table">
            <thead>
                <tr>
                    <th>Клиент</th>
                    <th>Сервер</th>
                    <th>Инцидент</th>
                    <th>Комментарий</th>
                    <th style="width: 100px; text-align: center;">Время простоя</th>
                </tr>
            </thead>
            <tbody>
    `;

    // Собираем все инциденты всех серверов за период
    const allIncidents = [];
    for (const clientName in reportData) {
        reportData[clientName].servers.forEach(srv => {
            srv.incidents.forEach(inc => {
                let excludedLabel = '';
                if (inc.is_maintenance) excludedLabel = 'обслуживание';
                else if (inc.is_power_issue) excludedLabel = 'электропитание';
                else if (inc.is_vpn_issue) excludedLabel = 'сеть/VPN';
                allIncidents.push({
                    clientName: clientName,
                    serverName: srv.name,
                    name: inc.name,
                    clock: inc.clock,
                    comment: inc.comment_text || '',
                    downtime: inc.downtime_in_period_sec || 0,
                    excludedLabel: excludedLabel
                });
            });
        });
    }
    allIncidents.sort((a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.serverName.localeCompare(b.serverName) ||
        b.clock - a.clock
    );

    if (allIncidents.length === 0) {
        html += `<tr><td colspan="5" style="text-align: center;">За выбранный период проблем не зафиксировано</td></tr>`;
    } else {
        allIncidents.forEach(inc => {
            html += `
                <tr>
                    <td><b>${inc.clientName}</b></td>
                    <td>${inc.serverName}</td>
                    <td>
                        ${inc.name}
                        <div style="font-size: 10px; color: #777;">${formatDateTime(inc.clock)}${inc.excludedLabel ? ` · ${inc.excludedLabel}` : ''}</div>
                    </td>
                    <td style="font-size: 11px; color: #555;">${inc.comment || '-'}</td>
                    <td style="text-align: center;">${formatDuration(inc.downtime)}</td>
                </tr>
            `;
        });
    }

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;
}

function formatPrintDate(unixTimestamp) {
    const d = new Date(unixTimestamp * 1000);
    return d.toLocaleDateString('ru-RU');
}

// === Логика групповых сбоев и паттернов ===

function initBulkActionsAndPatterns() {
    // 1. Кнопка сброса выбора в плавающей панели
    const clearBtn = document.getElementById('bulk-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            selectedIncidentEventIds.clear();
            document.querySelectorAll('.incident-select-checkbox').forEach(cb => cb.checked = false);
            document.querySelectorAll('.select-all-incidents-checkbox').forEach(cb => cb.checked = false);
            updateBulkActionsPanel();
        });
    }

    // 2. Кнопка "Изменить выбранные" в плавающей панели
    const editBtn = document.getElementById('bulk-edit-btn');
    const bulkModal = document.getElementById('bulk-comment-modal');
    if (editBtn && bulkModal) {
        editBtn.addEventListener('click', () => {
            const count = selectedIncidentEventIds.size;
            document.getElementById('bulk-comment-modal-details').innerText = 
                `Будет изменено сбоев: ${count}. Вы можете переопределить их категорию и/или задать общий комментарий.`;
            
            document.getElementById('modal-bulk-category').value = 'auto';
            document.getElementById('modal-bulk-textarea').value = '';
            bulkModal.style.display = 'flex';
        });
    }

    // 3. Закрытие модального окна массового редактирования
    const closeBulkModal = document.getElementById('close-bulk-comment-modal');
    if (closeBulkModal && bulkModal) {
        closeBulkModal.addEventListener('click', () => {
            bulkModal.style.display = 'none';
        });
    }
    window.addEventListener('click', (e) => {
        if (e.target === bulkModal) {
            bulkModal.style.display = 'none';
        }
    });

    // 4. Кнопка сохранения в модальном окне массового редактирования
    const saveBulkBtn = document.getElementById('modal-save-bulk-btn');
    if (saveBulkBtn && bulkModal) {
        saveBulkBtn.addEventListener('click', async () => {
            const category = document.getElementById('modal-bulk-category').value;
            const comment = document.getElementById('modal-bulk-textarea').value.trim();
            const eventids = Array.from(selectedIncidentEventIds);

            if (eventids.length === 0) {
                showToast('Нет выбранных инцидентов', 'error');
                return;
            }

            try {
                const response = await fetch('/api/incidents/bulk-override', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eventids, category, comment })
                });
                const result = await response.json();

                if (response.ok) {
                    showToast(result.message || 'Массовые изменения успешно применены');
                    bulkModal.style.display = 'none';
                    selectedIncidentEventIds.clear();
                    updateBulkActionsPanel();
                    loadDashboardData(); // Обновляем дашборд
                } else {
                    showToast(result.message || 'Ошибка сохранения', 'error');
                }
            } catch (err) {
                showToast('Ошибка сети при сохранении изменений', 'error');
            }
        });
    }

    // 5. Поиск по правилам фильтрации паттернов
    const searchInput = document.getElementById('patterns-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#patterns-table-body tr');
            rows.forEach(row => {
                const text = row.innerText.toLowerCase();
                if (text.includes(query)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }

    // 6. Добавление пользовательского паттерна в настройках
    const addPatternBtn = document.getElementById('add-pattern-btn');
    if (addPatternBtn) {
        addPatternBtn.addEventListener('click', async () => {
            const input = document.getElementById('new-pattern-input');
            const pattern = input.value.trim();

            if (!pattern) {
                showToast('Введите подстроку правила', 'error');
                return;
            }

            try {
                const response = await fetch('/api/incidents/patterns', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pattern, is_incident: 1 })
                });
                const result = await response.json();

                if (response.ok) {
                    showToast('Правило успешно добавлено!');
                    input.value = '';
                    loadIncidentPatterns();
                    loadDashboardData(); // Сразу пересчитываем SLA на дашборде
                } else {
                    showToast(result.message || 'Ошибка добавления правила', 'error');
                }
            } catch (err) {
                showToast('Ошибка соединения', 'error');
            }
        });
    }
}

function updateBulkActionsPanel() {
    const panel = document.getElementById('bulk-actions-panel');
    const counter = document.getElementById('bulk-selected-counter');
    if (!panel || !counter) return;

    const count = selectedIncidentEventIds.size;
    if (count > 0) {
        counter.innerText = count;
        panel.classList.add('show');
    } else {
        panel.classList.remove('show');
    }
}

// Загрузка и вывод правил фильтрации паттернов
async function loadIncidentPatterns() {
    const tbody = document.getElementById('patterns-table-body');
    if (!tbody) return;

    try {
        const response = await fetch('/api/incidents/patterns');
        const patterns = await response.json();

        tbody.innerHTML = '';
        if (patterns.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="color: var(--text-muted);">Правил фильтрации нет. Список заполнится автоматически при появлении инцидентов.</td></tr>';
            return;
        }

        patterns.forEach(p => {
            const tr = document.createElement('tr');
            
            const isChecked = p.is_incident === 1 ? 'checked' : '';

            tr.innerHTML = `
                <td style="text-align: center;">
                    <label class="checkbox-container" style="margin: 0; display: inline-block;">
                        <input type="checkbox" class="pattern-status-checkbox" data-pattern="${p.pattern}" ${isChecked}>
                        <span class="checkmark"></span>
                    </label>
                </td>
                <td><code style="font-family: monospace; font-size: 13px; font-weight: 600; color: var(--text-primary);">${p.pattern}</code></td>
                <td style="text-align: center;">
                    <button type="button" class="pattern-delete-btn" data-pattern="${p.pattern}" title="Удалить правило">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            `;

            // Обработчик переключения галочки "учитывать в SLA"
            const checkbox = tr.querySelector('.pattern-status-checkbox');
            checkbox.addEventListener('change', async (e) => {
                const is_incident = e.target.checked ? 1 : 0;
                try {
                    const res = await fetch('/api/incidents/patterns', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pattern: p.pattern, is_incident })
                    });
                    if (res.ok) {
                        showToast('Правило фильтрации обновлено');
                        loadDashboardData(); // Обновляем Uptime на дашборде
                    } else {
                        showToast('Не удалось обновить правило', 'error');
                        e.target.checked = !e.target.checked; // откат
                    }
                } catch (err) {
                    showToast('Ошибка сети', 'error');
                    e.target.checked = !e.target.checked;
                }
            });

            // Обработчик удаления правила
            const deleteBtn = tr.querySelector('.pattern-delete-btn');
            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Вы уверены, что хотите удалить правило "${p.pattern}"?`)) {
                    try {
                        const res = await fetch('/api/incidents/patterns/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pattern: p.pattern })
                        });
                        if (res.ok) {
                            showToast('Правило удалено');
                            loadIncidentPatterns();
                            loadDashboardData(); // Обновляем Uptime на дашборде
                        } else {
                            showToast('Не удалось удалить правило', 'error');
                        }
                    } catch (err) {
                        showToast('Ошибка соединения', 'error');
                    }
                }
            });

            tbody.appendChild(tr);
        });

        // Применяем фильтр поиска (если в строке поиска что-то введено)
        const searchInput = document.getElementById('patterns-search');
        if (searchInput && searchInput.value) {
            const query = searchInput.value.toLowerCase();
            tbody.querySelectorAll('tr').forEach(row => {
                const text = row.innerText.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
            });
        }

    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-danger">Не удалось загрузить список правил фильтрации</td></tr>';
    }
}
