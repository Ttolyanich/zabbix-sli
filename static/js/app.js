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

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initTabs();
    initPeriodPicker();
    initSortHeaders();
    initEventHandlers();
    initCustomSearchableSelect();
    
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
    
    // Показываем кнопку администрирования пользователей только для администраторов
    if (window.currentUser && window.currentUser.role === 'admin') {
        const adminBtn = document.querySelector('.nav-btn.admin-only');
        if (adminBtn) {
            adminBtn.style.display = 'flex';
        }
    }
    
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            
            // Активная кнопка
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Активный контент
            contents.forEach(c => c.classList.remove('active'));
            document.getElementById(`tab-${targetTab}`).classList.add('active');
            
            // Меняем заголовок
            const titleMap = {
                'dashboard': 'Панель мониторинга SLA/SLI',
                'mappings': 'Сопоставление серверов с клиентами',
                'settings': 'Настройки интеграций и SLA',
                'users': 'Управление пользователями системы'
            };
            document.getElementById('page-title').innerText = titleMap[targetTab];
            
            // Если перешли в маппинги, перезагрузим Zabbix хосты для дропдауна
            if (targetTab === 'mappings') {
                loadZabbixHostsForSelect();
            }
            // Если перешли в пользователи, загрузим список пользователей
            if (targetTab === 'users') {
                loadUsersList();
            }
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
    });
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
    listContainer.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Вычисление SLI метрик...</div>';
    
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
        
        // Подсчет сводных KPI
        let totalSla = 0;
        let clientCount = 0;
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
            totalSla += client.sla_percent;
            clientCount++;
            
            if (client.mttd_avg_sec > 0) {
                totalMttdSum += client.mttd_avg_sec;
                totalMttdCount++;
            }
            if (client.mttr_avg_sec > 0) {
                totalMttrSum += client.mttr_avg_sec;
                totalMttrCount++;
            }
            totalIncidentsCount += client.total_incidents_count;
            
            // Суммируем типы сбоев
            client.servers.forEach(srv => {
                srv.incidents.forEach(inc => {
                    if (inc.is_vpn_issue) {
                        vpnIssuesCount++;
                    } else if (inc.is_maintenance) {
                        // Не считаем сбоем сервера
                    } else {
                        serverIssuesCount++;
                    }
                });
            });
        }
        
        const summary = {
            avgSla: clientCount > 0 ? (totalSla / clientCount).toFixed(3) : 100,
            avgMttd: totalMttdCount > 0 ? Math.round(totalMttdSum / totalMttdCount) : 0,
            avgMttr: totalMttrCount > 0 ? Math.round(totalMttrSum / totalMttrCount) : 0,
            totalIncidents: totalIncidentsCount
        };
        
        updateKPIs(summary);
        renderCharts(data, vpnIssuesCount, serverIssuesCount);
        renderAccordion(data);
        updatePrintReport(data, summary);
        
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
            labels: ['Сеть / VPN (< 1 мин)', 'Сбои ПО/Серверов'],
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

function renderAccordion(reportData) {
    const listContainer = document.getElementById('clients-accordion-list');
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
        
        listContainer.appendChild(clientItem);
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
        
        const srvRow = serverItem.querySelector('.server-row');
        srvRow.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = serverItem.classList.contains('open');
            serverItem.classList.toggle('open');
            
            if (!isOpen) {
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
            }
        });
        
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
            categoryHtml = `<span class="status-badge vpn-issue"><i class="fa-solid fa-wifi"></i> Сеть / VPN (&lt;1м)</span>`;
        } else if (inc.is_maintenance) {
            categoryHtml = `<span class="status-badge maintenance"><i class="fa-solid fa-screwdriver-wrench"></i> Обслуживание</span>`;
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
        
        <div class="print-section-title" style="margin-top: 0;">Сводная таблица SLA по всем клиентам</div>
        <table class="print-table">
            <thead>
                <tr>
                    <th>Клиент / Сервер</th>
                    <th style="width: 100px; text-align: right;">Uptime %</th>
                    <th style="width: 100px; text-align: center;">Время простоя</th>
                    <th style="width: 70px; text-align: center;">Сбоев</th>
                    <th style="width: 100px; text-align: center;">MTTD (Реакция)</th>
                    <th style="width: 100px; text-align: center;">MTTR (Решение)</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    const clients = Object.keys(reportData).map(name => ({ name, ...reportData[name] }));
    clients.sort((a, b) => a.name.localeCompare(b.name));
    
    clients.forEach(client => {
        const clientSlaClass = client.sla_percent >= 99.5 ? 'good' : (client.sla_percent >= 98.0 ? 'warn' : 'poor');
        html += `
            <tr class="client-group-row">
                <td><b>${client.name}</b></td>
                <td style="text-align: right;" class="print-sla-badge ${clientSlaClass}">${client.sla_percent.toFixed(3)}%</td>
                <td style="text-align: center;">${formatDuration(client.total_downtime_sec)}</td>
                <td style="text-align: center;">${client.total_incidents_count}</td>
                <td style="text-align: center;">${formatDuration(client.mttd_avg_sec)}</td>
                <td style="text-align: center;">${formatDuration(client.mttr_avg_sec)}</td>
            </tr>
        `;
        
        client.servers.forEach(srv => {
            const srvSlaClass = srv.sla_percent >= 99.5 ? 'good' : (srv.sla_percent >= 98.0 ? 'warn' : 'poor');
            html += `
                <tr>
                    <td style="padding-left: 20px;">↳ ${srv.name}</td>
                    <td style="text-align: right;" class="print-sla-badge ${srvSlaClass}">${srv.sla_percent.toFixed(3)}%</td>
                    <td style="text-align: center;">${formatDuration(srv.downtime_sec)}</td>
                    <td style="text-align: center;">${srv.incidents_count}</td>
                    <td style="text-align: center;">${formatDuration(srv.mttd_sec)}</td>
                    <td style="text-align: center;">${formatDuration(srv.mttr_sec)}</td>
                </tr>
            `;
        });
    });
    
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
