from flask import Flask, render_template, request, jsonify, send_from_directory, session, redirect, url_for
import os
import time
import secrets
import datetime
from collections import defaultdict, deque
from dotenv import load_dotenv
from functools import wraps

import database
import zabbix_api
import analytics
import scheduler
import notifier

# Загрузка переменных окружения
load_dotenv()

def _load_or_create_secret_key():
    """SECRET_KEY из окружения; иначе персистентный автогенерируемый ключ в data/."""
    env_key = os.environ.get('SECRET_KEY')
    if env_key:
        return env_key
    secret_dir = os.path.dirname(os.environ.get('DATABASE_PATH', './data/sli_dashboard.db')) or '.'
    os.makedirs(secret_dir, exist_ok=True)
    path = os.path.join(secret_dir, '.secret_key')
    try:
        with open(path, 'r') as f:
            value = f.read().strip()
            if value:
                return value
    except FileNotFoundError:
        pass
    value = secrets.token_hex(32)
    with open(path, 'w') as f:
        f.write(value)
    print(f"AUTO-CONFIG: Сгенерирован новый SECRET_KEY и сохранен в {path}")
    return value

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = _load_or_create_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
)

# Простой in-memory ограничитель попыток входа (защита от перебора паролей)
_login_attempts = defaultdict(deque)
LOGIN_MAX_ATTEMPTS = 10
LOGIN_WINDOW_SECONDS = 300

def login_rate_limited(key):
    now = time.time()
    attempts = _login_attempts[key]
    while attempts and attempts[0] < now - LOGIN_WINDOW_SECONDS:
        attempts.popleft()
    return len(attempts) >= LOGIN_MAX_ATTEMPTS

def register_failed_login(key):
    _login_attempts[key].append(time.time())

# Middleware-декораторы для проверки прав доступа
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({"status": "error", "message": "Требуется авторизация"}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def _tv_token_valid():
    """Проверяет токен доступа к ТВ-панели (?token=...)."""
    provided = request.args.get('token', '')
    expected = database.get_settings().get('tv_access_token', '')
    return bool(expected) and bool(provided) and secrets.compare_digest(provided, expected)

def tv_access_required(f):
    """Доступ по сессии ИЛИ по токену ТВ-панели (для телевизора без логина)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' in session or _tv_token_valid():
            return f(*args, **kwargs)
        if request.path.startswith('/api/'):
            return jsonify({"status": "error", "message": "Требуется авторизация или токен ТВ-панели"}), 401
        return redirect(url_for('login'))
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({"status": "error", "message": "Требуется авторизация"}), 401
            return redirect(url_for('login'))
        if session.get('role') != 'admin':
            return jsonify({"status": "error", "message": "Доступ запрещен (требуются права администратора)"}), 403
        return f(*args, **kwargs)
    return decorated_function

# Инициализация БД и планировщика
database.init_db()
scheduler.init_scheduler()

@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('index'))
        
    if request.method == 'POST':
        if request.is_json:
            data = request.json
            username = data.get('username')
            password = data.get('password')
        else:
            username = request.form.get('username')
            password = request.form.get('password')

        if login_rate_limited(request.remote_addr):
            msg = "Слишком много неудачных попыток входа. Попробуйте позже."
            if request.is_json:
                return jsonify({"status": "error", "message": msg}), 429
            return render_template('login.html', error=msg)

        user = database.authenticate_user(username, password)
        if user:
            session['user_id'] = user['id']
            session['username'] = user['username']
            session['role'] = user['role']
            
            is_default_admin = (user['username'] == 'admin' and password == 'admin')
            session['is_default_admin'] = is_default_admin
            
            if request.is_json:
                return jsonify({
                    "status": "success", 
                    "user": {
                        "username": user['username'], 
                        "role": user['role'],
                        "is_default_admin": is_default_admin
                    }
                })
            return redirect(url_for('index'))

        register_failed_login(request.remote_addr)
        if request.is_json:
            return jsonify({"status": "error", "message": "Неверный логин или пароль"}), 400
        return render_template('login.html', error="Неверный логин или пароль")
        
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/api/settings', methods=['GET', 'POST'])
@login_required
def handle_settings():
    if request.method == 'GET':
        settings = database.get_settings()
        # Удаляем пароли из выгрузки в целях безопасности (или маскируем)
        masked_settings = dict(settings)
        if masked_settings.get('smtp_password'):
            masked_settings['smtp_password'] = '********'
        if masked_settings.get('zabbix_password'):
            masked_settings['zabbix_password'] = '********'
        return jsonify(masked_settings)
        
    elif request.method == 'POST':
        data = request.json
        # Считываем текущие настройки, чтобы не стереть пароли, если их прислали в виде '********'
        current_settings = database.get_settings()
        new_settings = {}
        
        for k, v in data.items():
            if k in ['smtp_password', 'zabbix_password'] and v == '********':
                # Оставляем старое значение
                new_settings[k] = current_settings.get(k, '')
            else:
                new_settings[k] = v
                
        database.save_settings(new_settings)
        return jsonify({"status": "success", "message": "Настройки успешно сохранены"})

@app.route('/api/mappings', methods=['GET', 'POST'])
@login_required
def handle_mappings():
    if request.method == 'GET':
        mappings = database.get_mappings(only_active=True)
        return jsonify(mappings)
        
    elif request.method == 'POST':
        data = request.json
        zabbix_hostid = data.get('zabbix_hostid')
        host_name = data.get('host_name')
        client_name = data.get('client_name')
        comment = data.get('comment', '')
        
        if not zabbix_hostid or not host_name or not client_name:
            return jsonify({"status": "error", "message": "Не все обязательные поля заполнены"}), 400
            
        database.save_mapping(zabbix_hostid, host_name, client_name, comment, is_manual=1)
        
        # Запускаем фоновую синхронизацию Zabbix, чтобы подтянуть данные по новому хосту
        scheduler._scheduler.add_job(scheduler.sync_zabbix_data, 'date', run_date=datetime.datetime.now())
        
        return jsonify({"status": "success", "message": "Сопоставление успешно сохранено"})

@app.route('/api/mappings/<hostid>', methods=['DELETE'])
@login_required
def delete_mapping(hostid):
    database.delete_mapping(hostid)
    # Запускаем синхронизацию для восстановления автоопределения клиента
    scheduler.sync_zabbix_data()
    return jsonify({"status": "success", "message": "Привязка сброшена к автоопределению Zabbix"})

@app.route('/api/zabbix-hosts', methods=['GET'])
@login_required
def get_zabbix_hosts():
    settings = database.get_settings()
    url = settings.get('zabbix_url')
    token = settings.get('zabbix_token')
    user = settings.get('zabbix_user')
    password = settings.get('zabbix_password')
    
    if not url:
        return jsonify({"status": "error", "message": "Zabbix не настроен"}), 400
        
    try:
        api = zabbix_api.ZabbixAPI(url, token, user, password)
        api.login()
        hosts = api.get_hosts()
        return jsonify(hosts)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка Zabbix: {str(e)}"}), 500

@app.route('/api/report', methods=['GET'])
@login_required
def get_report():
    # По умолчанию берем текущий месяц
    now = datetime.datetime.now()
    first_day_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    start_ts = request.args.get('start_time', type=int)
    end_ts = request.args.get('end_time', type=int)
    
    if not start_ts:
        start_ts = int(first_day_of_month.timestamp())
    if not end_ts:
        end_ts = int(time.time())
        
    report = analytics.calculate_sli_report(start_ts, end_ts)
    
    # Подмешиваем комментарии по сбоям из локальной БД
    comments = database.get_incident_comments()
    for client_name, client in report.items():
        for srv in client.get('servers', []):
            for inc in srv.get('incidents', []):
                ev_id = inc.get('eventid')
                if ev_id in comments:
                    inc['comment_text'] = comments[ev_id]['comment']
                    inc['comment_user'] = comments[ev_id]['username']
                    inc['comment_date'] = comments[ev_id]['created_at']
                    
    return jsonify(report)

# === ТВ-панель (NOC-дашборд для телевизора) ===

def _resolve_tv_period(period_key):
    """Возвращает (start_ts, end_ts, label) для периода ТВ-панели."""
    now = datetime.datetime.now()
    end_ts = int(time.time())
    if period_key == 'today':
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return int(start.timestamp()), end_ts, 'Сегодня'
    if period_key == '7d':
        return end_ts - 7 * 86400, end_ts, 'Последние 7 дней'
    if period_key == '30d':
        return end_ts - 30 * 86400, end_ts, 'Последние 30 дней'
    # По умолчанию — текущий месяц (как на основном дашборде)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp()), end_ts, 'Текущий месяц'

@app.route('/tv')
@tv_access_required
def tv_panel():
    return render_template('tv.html')

@app.route('/api/tv-data', methods=['GET'])
@tv_access_required
def tv_data():
    period_key = request.args.get('period', 'month')
    top_limit = min(request.args.get('top', 20, type=int), 50)
    start_ts, end_ts, period_label = _resolve_tv_period(period_key)

    report = analytics.calculate_sli_report(start_ts, end_ts)
    exclude_vpn = database.get_settings().get('exclude_vpn_issues') == '1'

    hosts = []
    clients = []
    active_incidents_total = 0

    for c_name, c_data in report.items():
        client_active_hosts = 0
        for srv in c_data['servers']:
            # Активная проблема = нерешённый инцидент, кроме обслуживания, электропитания
            # и (при включённом исключении) инцидентов категории "Сеть/VPN"
            active_incidents = [
                inc for inc in srv['incidents']
                if not inc['r_clock'] and not inc['is_maintenance']
                and not inc.get('is_power_issue')
                and not (exclude_vpn and inc['is_vpn_issue'])
            ]
            active_incidents_total += len(active_incidents)
            if active_incidents:
                client_active_hosts += 1
            hosts.append({
                'hostid': srv['hostid'],
                'name': srv['name'],
                'client_name': c_name,
                'sla_percent': srv['sla_percent'],
                'downtime_sec': srv['downtime_sec'],
                'incidents_count': srv['incidents_count'],
                'is_down_now': bool(active_incidents),
                'current_problem': active_incidents[0]['name'] if active_incidents else None
            })
        clients.append({
            'client_name': c_name,
            'sla_percent': c_data['sla_percent'],
            'total_downtime_sec': c_data['total_downtime_sec'],
            'servers_count': len(c_data['servers']),
            'active_problem_hosts': client_active_hosts,
            'incidents_count': c_data['total_incidents_count']
        })

    # Общая доступность = средний SLA по всем серверам парка
    overall_sla = round(sum(h['sla_percent'] for h in hosts) / len(hosts), 3) if hosts else 100.0

    # Топ проблемных хостов: сначала по суммарному простою, затем по числу инцидентов
    hosts.sort(key=lambda h: (-h['downtime_sec'], -h['incidents_count'], h['name']))
    # Топ проблемных клиентов по суммарному простою
    clients.sort(key=lambda c: (-c['total_downtime_sec'], -c['incidents_count'], c['client_name']))

    return jsonify({
        'period': {'key': period_key, 'label': period_label, 'start': start_ts, 'end': end_ts},
        'overall': {
            'sla_percent': overall_sla,
            'servers_total': len(hosts),
            'clients_total': len(clients),
            'hosts_down_now': sum(1 for h in hosts if h['is_down_now']),
            'active_incidents': active_incidents_total,
            'total_downtime_sec': sum(h['downtime_sec'] for h in hosts)
        },
        'top_hosts': hosts[:top_limit],
        'top_clients': [c for c in clients if c['total_downtime_sec'] > 0 or c['active_problem_hosts'] > 0][:10],
        'generated_at': int(time.time())
    })

@app.route('/api/sync', methods=['POST'])
@login_required
def manual_sync():
    try:
        result = scheduler.sync_zabbix_data()
        if result and result.get('status') == 'error':
            return jsonify({"status": "error", "message": f"Ошибка синхронизации: {result['message']}"}), 502
        if result and result.get('status') == 'not_configured':
            return jsonify({"status": "error", "message": result['message']}), 400
        message = result['message'] if result else "Синхронизация успешно завершена"
        return jsonify({"status": "success", "message": message})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка синхронизации: {str(e)}"}), 500

@app.route('/api/sync-status', methods=['GET'])
@login_required
def get_sync_status():
    return jsonify(database.get_sync_status())

@app.route('/api/send-email', methods=['POST'])
@login_required
def send_email_report():
    data = request.json or {}
    recipient = data.get('recipient')
    start_ts = data.get('start_time')
    end_ts = data.get('end_time')
    
    if start_ts is not None:
        try:
            start_ts = int(start_ts)
        except (ValueError, TypeError):
            start_ts = None
            
    if end_ts is not None:
        try:
            end_ts = int(end_ts)
        except (ValueError, TypeError):
            end_ts = None
    
    if not recipient:
        return jsonify({"status": "error", "message": "Укажите адрес получателя"}), 400
        
    now = datetime.datetime.now()
    first_day_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    if not start_ts:
        start_ts = int(first_day_of_month.timestamp())
    if not end_ts:
        end_ts = int(time.time())
        
    try:
        date_start_str = datetime.datetime.fromtimestamp(start_ts).strftime('%d.%m.%Y')
        date_end_str = datetime.datetime.fromtimestamp(end_ts).strftime('%d.%m.%Y')
        subject = f"Ручной отчет SLA/SLI за {date_start_str} - {date_end_str}"
        
        notifier.send_email_report(recipient, subject, start_ts, end_ts)
        return jsonify({"status": "success", "message": f"Отчет отправлен на {recipient}"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка отправки почты: {str(e)}"}), 500

@app.route('/api/send-telegram', methods=['POST'])
@login_required
def send_telegram_report():
    data = request.json or {}
    start_ts = data.get('start_time')
    end_ts = data.get('end_time')
    
    if start_ts is not None:
        try:
            start_ts = int(start_ts)
        except (ValueError, TypeError):
            start_ts = None
            
    if end_ts is not None:
        try:
            end_ts = int(end_ts)
        except (ValueError, TypeError):
            end_ts = None
    
    now = datetime.datetime.now()
    first_day_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    if not start_ts:
        start_ts = int(first_day_of_month.timestamp())
    if not end_ts:
        end_ts = int(time.time())
        
    try:
        success = notifier.send_telegram_report(start_ts, end_ts)
        if success:
            return jsonify({"status": "success", "message": "Отчет успешно отправлен в Telegram"})
        else:
            return jsonify({"status": "error", "message": "Не удалось отправить отчет (проверьте настройки Telegram)"}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка отправки в Telegram: {str(e)}"}), 500

# === API для комментариев и профиля ===

@app.route('/api/incidents/<eventid>/comment', methods=['POST'])
@login_required
def add_incident_comment(eventid):
    data = request.json
    comment = data.get('comment', '')
    
    if not comment:
        return jsonify({"status": "error", "message": "Комментарий не может быть пустым"}), 400
        
    database.save_incident_comment(eventid, comment, session['username'])
    return jsonify({"status": "success", "message": "Комментарий успешно сохранен"})

@app.route('/api/incidents/<eventid>/category', methods=['POST'])
@login_required
def override_incident_category(eventid):
    data = request.json
    category = data.get('category', 'auto')
    
    if category not in ['auto', 'server', 'network', 'maintenance', 'power']:
        return jsonify({"status": "error", "message": "Неверная категория"}), 400
        
    database.save_category_override(eventid, category)
    return jsonify({"status": "success", "message": "Категория сбоя успешно изменена"})

@app.route('/api/incidents/bulk-override', methods=['POST'])
@login_required
def bulk_override_incidents():
    data = request.json
    eventids = data.get('eventids', [])
    category = data.get('category', 'auto')
    comment = data.get('comment')
    
    if not eventids:
        return jsonify({"status": "error", "message": "Список инцидентов пуст"}), 400
        
    if category not in ['auto', 'server', 'network', 'maintenance', 'power']:
        return jsonify({"status": "error", "message": "Неверная категория"}), 400
        
    try:
        # Если передан пустой комментарий, не сохраняем его в базу
        if comment is not None:
            comment = comment.strip()
            if not comment:
                comment = None
                
        database.bulk_save_incident_overrides(eventids, category, comment, session['username'])
        return jsonify({"status": "success", "message": f"Массовое изменение применено к {len(eventids)} инцидентам"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка сохранения: {str(e)}"}), 500

@app.route('/api/incidents/patterns', methods=['GET'])
@login_required
def api_get_incident_patterns():
    try:
        patterns = database.get_incident_patterns()
        return jsonify(patterns)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка получения правил: {str(e)}"}), 500

@app.route('/api/incidents/patterns', methods=['POST'])
@login_required
def api_update_incident_pattern():
    data = request.json
    pattern = data.get('pattern', '').strip()
    is_incident = data.get('is_incident', 1)
    
    if not pattern:
        return jsonify({"status": "error", "message": "Паттерн не может быть пустым"}), 400
        
    try:
        database.save_incident_pattern(pattern, is_incident)
        return jsonify({"status": "success", "message": "Правило фильтрации успешно сохранено"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка сохранения правила: {str(e)}"}), 500

@app.route('/api/incidents/patterns/delete', methods=['POST'])
@login_required
def api_delete_incident_pattern():
    data = request.json
    pattern = data.get('pattern', '').strip()
    
    if not pattern:
        return jsonify({"status": "error", "message": "Паттерн не может быть пустым"}), 400
        
    try:
        database.delete_incident_pattern(pattern)
        return jsonify({"status": "success", "message": "Правило фильтрации успешно удалено"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Ошибка удаления правила: {str(e)}"}), 500

# === BI-аналитика: группы инцидентов и отчет ===

@app.route('/api/analytics/groups', methods=['GET', 'POST'])
@login_required
def handle_analytics_groups():
    if request.method == 'GET':
        return jsonify(database.get_analytics_groups())

    if session.get('role') != 'admin':
        return jsonify({"status": "error", "message": "Доступ запрещен (требуются права администратора)"}), 403

    data = request.json or {}
    name = (data.get('name') or '').strip()
    color = (data.get('color') or '#3b82f6').strip()

    if not name:
        return jsonify({"status": "error", "message": "Название группы не может быть пустым"}), 400

    group_id = database.create_analytics_group(name, color)
    if group_id is None:
        return jsonify({"status": "error", "message": "Группа с таким названием уже существует"}), 400

    return jsonify({"status": "success", "message": "Группа успешно создана", "id": group_id})

@app.route('/api/analytics/groups/<int:group_id>', methods=['DELETE'])
@admin_required
def delete_analytics_group(group_id):
    database.delete_analytics_group(group_id)
    return jsonify({"status": "success", "message": "Группа удалена"})

@app.route('/api/analytics/groups/<int:group_id>/patterns', methods=['POST'])
@admin_required
def add_analytics_group_pattern(group_id):
    data = request.json or {}
    pattern = (data.get('pattern') or '').strip()

    if not pattern:
        return jsonify({"status": "error", "message": "Паттерн не может быть пустым"}), 400

    database.add_analytics_pattern(group_id, pattern)
    return jsonify({"status": "success", "message": "Паттерн добавлен"})

@app.route('/api/analytics/patterns/<int:pattern_id>', methods=['DELETE'])
@admin_required
def delete_analytics_group_pattern(pattern_id):
    database.delete_analytics_pattern(pattern_id)
    return jsonify({"status": "success", "message": "Паттерн удален"})

@app.route('/api/analytics/report', methods=['GET'])
@login_required
def get_analytics_report():
    now = datetime.datetime.now()
    first_day_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    start_ts = request.args.get('start_time', type=int)
    end_ts = request.args.get('end_time', type=int)

    if not start_ts:
        start_ts = int(first_day_of_month.timestamp())
    if not end_ts:
        end_ts = int(time.time())

    groups = database.get_analytics_groups()
    report = analytics.calculate_sli_report(start_ts, end_ts)

    # stats[group_id] = {count, downtime_sec, clients: {client_name: count}, patterns: {pattern_id: {...}}}
    stats = {
        g['id']: {
            'count': 0,
            'downtime_sec': 0,
            'clients': {},
            'patterns': {p['id']: {'pattern': p, 'count': 0, 'downtime_sec': 0, 'incidents': []} for p in g['patterns']}
        }
        for g in groups
    }
    uncategorized = {'count': 0, 'downtime_sec': 0, 'clients': {}, 'incidents': []}
    total_incidents = 0

    for client_name, client_data in report.items():
        for srv in client_data['servers']:
            for inc in srv['incidents']:
                total_incidents += 1
                downtime = inc.get('downtime_in_period_sec', 0) or 0
                match_group, match_pattern = database.classify_analytics_group(inc['name'], groups)

                inc_summary = {
                    'eventid': inc['eventid'],
                    'client': client_name,
                    'server': srv['name'],
                    'name': inc['name'],
                    'clock': inc['clock'],
                    'r_clock': inc.get('r_clock'),
                    'downtime_sec': downtime
                }

                if match_group:
                    bucket = stats[match_group['id']]
                    bucket['count'] += 1
                    bucket['downtime_sec'] += downtime
                    bucket['clients'][client_name] = bucket['clients'].get(client_name, 0) + 1

                    p_bucket = bucket['patterns'][match_pattern['id']]
                    p_bucket['count'] += 1
                    p_bucket['downtime_sec'] += downtime
                    p_bucket['incidents'].append(inc_summary)
                else:
                    uncategorized['count'] += 1
                    uncategorized['downtime_sec'] += downtime
                    uncategorized['clients'][client_name] = uncategorized['clients'].get(client_name, 0) + 1
                    uncategorized['incidents'].append(inc_summary)

    def _top_clients(clients_dict):
        return [{'client': c, 'count': n} for c, n in sorted(clients_dict.items(), key=lambda x: -x[1])[:5]]

    def _percent(count):
        return round(count / total_incidents * 100, 1) if total_incidents else 0

    groups_result = []
    for g in groups:
        bucket = stats[g['id']]
        patterns_result = []
        for p in g['patterns']:
            pb = bucket['patterns'][p['id']]
            pb['incidents'].sort(key=lambda i: -i['clock'])
            patterns_result.append({
                'id': p['id'],
                'pattern': p['pattern'],
                'count': pb['count'],
                'downtime_sec': pb['downtime_sec'],
                'incidents': pb['incidents']
            })
        patterns_result.sort(key=lambda p: -p['count'])

        groups_result.append({
            'id': g['id'],
            'name': g['name'],
            'color': g['color'],
            'count': bucket['count'],
            'percent': _percent(bucket['count']),
            'downtime_sec': bucket['downtime_sec'],
            'top_clients': _top_clients(bucket['clients']),
            'patterns': patterns_result
        })
    groups_result.sort(key=lambda g: -g['count'])

    uncategorized['incidents'].sort(key=lambda i: -i['clock'])

    return jsonify({
        'period': {'start': start_ts, 'end': end_ts},
        'total_incidents': total_incidents,
        'groups': groups_result,
        'uncategorized': {
            'id': None,
            'name': 'Не классифицировано',
            'color': '#6b7280',
            'count': uncategorized['count'],
            'percent': _percent(uncategorized['count']),
            'downtime_sec': uncategorized['downtime_sec'],
            'top_clients': _top_clients(uncategorized['clients']),
            'incidents': uncategorized['incidents']
        }
    })

@app.route('/api/profile/change-password', methods=['POST'])
@login_required
def change_password():
    data = request.json
    old_password = data.get('old_password')
    new_password = data.get('new_password')
    
    if not old_password or not new_password:
        return jsonify({"status": "error", "message": "Заполните все поля"}), 400
        
    success, msg = database.change_password(session['user_id'], old_password, new_password)
    if success:
        if session.get('is_default_admin'):
            session['is_default_admin'] = False
        return jsonify({"status": "success", "message": msg})
    return jsonify({"status": "error", "message": msg}), 400

# === API для управления пользователями ===

@app.route('/api/users', methods=['GET', 'POST'])
@admin_required
def manage_users():
    if request.method == 'GET':
        users = database.get_all_users()
        return jsonify(users)
        
    elif request.method == 'POST':
        data = request.json
        username = data.get('username')
        password = data.get('password')
        role = data.get('role', 'user')
        
        if not username or not password:
            return jsonify({"status": "error", "message": "Имя пользователя и пароль обязательны"}), 400
            
        success = database.create_user(username, password, role)
        if success:
            return jsonify({"status": "success", "message": f"Пользователь {username} успешно создан"})
        return jsonify({"status": "error", "message": "Пользователь с таким именем уже существует"}), 400

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_user(user_id):
    success, msg = database.delete_user(user_id)
    if success:
        return jsonify({"status": "success", "message": msg})
    return jsonify({"status": "error", "message": msg}), 400

@app.route('/api/users/<int:user_id>/role', methods=['POST'])
@admin_required
def change_user_role_route(user_id):
    if user_id == session.get('user_id'):
        return jsonify({"status": "error", "message": "Нельзя изменить роль собственной учетной записи"}), 400

    data = request.json or {}
    new_role = data.get('role')

    success, msg = database.change_user_role(user_id, new_role)
    if success:
        return jsonify({"status": "success", "message": msg})
    return jsonify({"status": "error", "message": msg}), 400

if __name__ == '__main__':
    port = int(os.environ.get('BIND_PORT', os.environ.get('PORT', 5000)))
    # Включаем прослушивание на всех интерфейсах для развертывания
    app.run(host='0.0.0.0', port=port, debug=False)
