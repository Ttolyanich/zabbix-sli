import sqlite3
import os
import secrets
import time
from flask import g
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = os.environ.get('DATABASE_PATH', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sli_dashboard.db'))

# Создаем директорию для базы данных, если она не существует
db_dir = os.path.dirname(DB_PATH)
if db_dir and not os.path.exists(db_dir):
    os.makedirs(db_dir, exist_ok=True)

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON;')
    return conn

def init_db():
    conn = get_db_connection()
    conn.execute('PRAGMA journal_mode=WAL;')
    cursor = conn.cursor()
    
    # Таблица настроек
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    
    # Таблица сопоставления хостов Zabbix с клиентами
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS server_mappings (
            zabbix_hostid TEXT PRIMARY KEY,
            host_name TEXT NOT NULL,
            client_name TEXT NOT NULL,
            comment TEXT,
            is_manual INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1
        )
    ''')
    
    # Проверяем, существуют ли колонки в существующей БД
    cursor.execute("PRAGMA table_info(server_mappings)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'is_manual' not in columns:
        cursor.execute("ALTER TABLE server_mappings ADD COLUMN is_manual INTEGER DEFAULT 0")
    if 'is_active' not in columns:
        cursor.execute("ALTER TABLE server_mappings ADD COLUMN is_active INTEGER DEFAULT 1")
    
    # Таблица кэша инцидентов Zabbix
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS incidents (
            eventid TEXT PRIMARY KEY,
            hostid TEXT NOT NULL,
            name TEXT NOT NULL,
            severity INTEGER NOT NULL,
            clock INTEGER NOT NULL,
            r_clock INTEGER,
            duration INTEGER,
            is_vpn_issue INTEGER DEFAULT 0,
            is_maintenance INTEGER DEFAULT 0,
            acknowledged INTEGER DEFAULT 0,
            ack_time INTEGER
        )
    ''')
    # Таблица пользователей
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user'
        )
    ''')
    
    # Создаем администратора по умолчанию (admin / admin), если пользователей нет
    cursor.execute('SELECT COUNT(*) FROM users')
    if cursor.fetchone()[0] == 0:
        admin_hash = generate_password_hash('admin')
        cursor.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ('admin', admin_hash, 'admin'))
        
    # Таблица комментариев к инцидентам
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS incident_comments (
            eventid TEXT PRIMARY KEY,
            comment TEXT NOT NULL,
            username TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Таблица переопределения категорий инцидентов
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS incident_category_overrides (
            eventid TEXT PRIMARY KEY,
            category TEXT NOT NULL
        )
    ''')
    
    # Таблица паттернов/правил исключения инцидентов
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS incident_patterns (
            pattern TEXT PRIMARY KEY,
            is_incident INTEGER NOT NULL DEFAULT 1
        )
    ''')

    # BI-аналитика: группы (типы) инцидентов и паттерны для автоклассификации
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS analytics_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            color TEXT NOT NULL DEFAULT '#3b82f6',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS analytics_group_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES analytics_groups(id) ON DELETE CASCADE,
            pattern TEXT NOT NULL,
            UNIQUE(group_id, pattern)
        )
    ''')

    # Глобальные правила исключения из SLA по подстроке (в отличие от incident_patterns
    # с галочками на каждое полное имя — одно правило рубит совпадения на всех хостах).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sla_exclusion_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Дефолтные настройки
    default_settings = {
        'zabbix_url': '',
        'zabbix_token': '',
        'zabbix_user': '',
        'zabbix_password': '',
        'smtp_host': '',
        'smtp_port': '587',
        'smtp_user': '',
        'smtp_password': '',
        'smtp_from': '',
        'smtp_use_tls': '1',
        'telegram_bot_token': '',
        'telegram_chat_id': '',
        'telegram_enabled': '0',
        'working_hours_enabled': '0',
        'working_hours_start': '09:00',
        'working_hours_end': '18:00',
        'working_days': '1,2,3,4,5', # 1=Mon, ..., 7=Sun
        'exclude_vpn_issues': '0', # Исключать ли короткие инциденты (< порога) из общего SLA
        'vpn_issue_threshold_sec': '60', # Порог длительности (сек), ниже которого инцидент считается сетевым/VPN-сбоем
        'min_severity': '0',
        'mapping_mode': 'name_auto',
        # Токен доступа к ТВ-панели (/tv?token=...) — генерируется один раз при первом запуске
        'tv_access_token': secrets.token_urlsafe(16),
        'ignored_host_groups': 'templates, linux servers, windows servers, zabbix servers, virtual machines, hypervisors, discovered hosts, web servers, database servers, network devices, printers, storage devices, discovered, hypervisor'
    }
    
    for key, val in default_settings.items():
        cursor.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, val))
        
    conn.commit()
    conn.close()

def get_settings():
    conn = get_db_connection()
    rows = conn.execute('SELECT key, value FROM settings').fetchall()
    conn.close()
    return {row['key']: row['value'] for row in rows}

def save_settings(settings_dict):
    conn = get_db_connection()
    for key, val in settings_dict.items():
        conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, str(val)))
    conn.commit()
    conn.close()

# === Статус синхронизации с Zabbix ===
# Хранится в той же таблице settings (ключи с префиксом sync_), но через
# отдельные функции, а не get_settings()/save_settings() — это не
# пользовательские настройки, а служебный статус последней попытки/успеха.

_SYNC_STATUS_KEYS = ('sync_last_status', 'sync_last_attempt_at', 'sync_last_success_at', 'sync_last_error')

def record_sync_result(status, error_message=None):
    """status: 'ok' | 'error' | 'not_configured'."""
    now = str(int(time.time()))
    conn = get_db_connection()
    conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ('sync_last_status', status))
    conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ('sync_last_attempt_at', now))
    conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ('sync_last_error', error_message or ''))
    if status == 'ok':
        conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ('sync_last_success_at', now))
    conn.commit()
    conn.close()

def get_sync_status():
    conn = get_db_connection()
    placeholders = ','.join('?' for _ in _SYNC_STATUS_KEYS)
    rows = conn.execute(f'SELECT key, value FROM settings WHERE key IN ({placeholders})', _SYNC_STATUS_KEYS).fetchall()
    conn.close()
    values = {row['key']: row['value'] for row in rows}
    return {
        'status': values.get('sync_last_status') or 'never',
        'last_attempt_at': int(values['sync_last_attempt_at']) if values.get('sync_last_attempt_at') else None,
        'last_success_at': int(values['sync_last_success_at']) if values.get('sync_last_success_at') else None,
        'error': values.get('sync_last_error') or None
    }

def get_mappings(only_active=False):
    conn = get_db_connection()
    if only_active:
        rows = conn.execute('SELECT zabbix_hostid, host_name, client_name, comment, is_manual, is_active FROM server_mappings WHERE is_active = 1 ORDER BY client_name, host_name').fetchall()
    else:
        rows = conn.execute('SELECT zabbix_hostid, host_name, client_name, comment, is_manual, is_active FROM server_mappings ORDER BY client_name, host_name').fetchall()
    conn.close()
    return [dict(row) for row in rows]

def save_mapping(zabbix_hostid, host_name, client_name, comment, is_manual=1, is_active=1):
    conn = get_db_connection()
    conn.execute('''
        INSERT OR REPLACE INTO server_mappings (zabbix_hostid, host_name, client_name, comment, is_manual, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (zabbix_hostid, host_name, client_name, comment, is_manual, is_active))
    conn.commit()
    conn.close()

def set_host_active_status(zabbix_hostid, is_active):
    conn = get_db_connection()
    conn.execute('UPDATE server_mappings SET is_active = ? WHERE zabbix_hostid = ?', (int(is_active), zabbix_hostid))
    conn.commit()
    conn.close()

def delete_mapping(zabbix_hostid):
    conn = get_db_connection()
    conn.execute('DELETE FROM server_mappings WHERE zabbix_hostid = ?', (zabbix_hostid,))
    conn.commit()
    conn.close()

def delete_host_data(zabbix_hostid):
    conn = get_db_connection()
    event_ids = [r['eventid'] for r in conn.execute('SELECT eventid FROM incidents WHERE hostid = ?', (zabbix_hostid,)).fetchall()]
    if event_ids:
        placeholders = ','.join('?' for _ in event_ids)
        conn.execute(f'DELETE FROM incident_comments WHERE eventid IN ({placeholders})', event_ids)
        conn.execute(f'DELETE FROM incident_category_overrides WHERE eventid IN ({placeholders})', event_ids)
    conn.execute('DELETE FROM server_mappings WHERE zabbix_hostid = ?', (zabbix_hostid,))
    conn.execute('DELETE FROM incidents WHERE hostid = ?', (zabbix_hostid,))
    conn.commit()
    conn.close()

def cache_incidents(incidents_list):
    conn = get_db_connection()
    for inc in incidents_list:
        # Считаем длительность и определяем, является ли это проблемой сети/VPN (< 60 секунд)
        duration = None
        is_vpn_issue = 0
        if inc.get('r_clock'):
            duration = int(inc['r_clock']) - int(inc['clock'])
            if duration < 60:
                is_vpn_issue = 1
                
        conn.execute('''
            INSERT OR REPLACE INTO incidents (
                eventid, hostid, name, severity, clock, r_clock, duration, is_vpn_issue, is_maintenance, acknowledged, ack_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            inc['eventid'],
            inc['hostid'],
            inc['name'],
            inc['severity'],
            inc['clock'],
            inc.get('r_clock'),
            duration,
            is_vpn_issue,
            inc.get('is_maintenance', 0),
            inc.get('acknowledged', 0),
            inc.get('ack_time')
        ))
    conn.commit()
    conn.close()

def get_incidents(start_time, end_time, hostids=None):
    # Получаем минимальную критичность и порог сетевых/VPN-сбоев из настроек
    settings = get_settings()
    try:
        min_severity = int(settings.get('min_severity', '0'))
    except Exception:
        min_severity = 0
    try:
        vpn_threshold = max(0, int(settings.get('vpn_issue_threshold_sec', '60')))
    except (ValueError, TypeError):
        vpn_threshold = 60

    conn = get_db_connection()
    query = '''
        SELECT i.*, o.category AS overridden_category 
        FROM incidents i
        LEFT JOIN incident_category_overrides o ON i.eventid = o.eventid
        WHERE i.clock <= ? AND (i.r_clock IS NULL OR i.r_clock >= ?) AND i.severity >= ?
    '''
    params = [end_time, start_time, min_severity]
    
    if hostids:
        placeholders = ','.join('?' for _ in hostids)
        query += f' AND i.hostid IN ({placeholders})'
        params.extend(hostids)
        
    query += ' ORDER BY i.clock DESC'
    rows = conn.execute(query, params).fetchall()
    conn.close()
    
    result = []
    for row in rows:
        d = dict(row)
        d['is_power_issue'] = 0
        # Пересчитываем "сетевой/VPN сбой" динамически по текущему порогу настроек,
        # а не по значению, зафиксированному при синхронизации со старым (жестко заданным) порогом
        d['is_vpn_issue'] = 1 if (d.get('duration') is not None and d['duration'] < vpn_threshold) else 0
        override = d.get('overridden_category')
        if override:
            if override == 'network':
                d['is_vpn_issue'] = 1
                d['is_maintenance'] = 0
            elif override == 'maintenance':
                d['is_vpn_issue'] = 0
                d['is_maintenance'] = 1
            elif override == 'power':
                d['is_vpn_issue'] = 0
                d['is_maintenance'] = 0
                d['is_power_issue'] = 1
            elif override == 'server':
                d['is_vpn_issue'] = 0
                d['is_maintenance'] = 0
        result.append(d)
        
    return result

# === Функции управления паттернами и групповых сбоев ===

def auto_discover_patterns():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT name FROM incidents')
    names = [row['name'] for row in cursor.fetchall()]
    
    for name in names:
        cursor.execute('INSERT OR IGNORE INTO incident_patterns (pattern, is_incident) VALUES (?, 1)', (name,))
    conn.commit()
    conn.close()

def get_incident_patterns():
    auto_discover_patterns()
    conn = get_db_connection()
    rows = conn.execute('SELECT pattern, is_incident FROM incident_patterns ORDER BY pattern ASC').fetchall()
    conn.close()
    return [{'pattern': row['pattern'], 'is_incident': row['is_incident']} for row in rows]

def save_incident_pattern(pattern, is_incident):
    conn = get_db_connection()
    conn.execute('INSERT OR REPLACE INTO incident_patterns (pattern, is_incident) VALUES (?, ?)', (pattern, int(is_incident)))
    conn.commit()
    conn.close()

def delete_incident_pattern(pattern):
    conn = get_db_connection()
    conn.execute('DELETE FROM incident_patterns WHERE pattern = ?', (pattern,))
    conn.commit()
    conn.close()

# --- Глобальные правила исключения из SLA по подстроке ---

def get_sla_exclusion_rules():
    """Список правил-подстрок, исключающих совпадающие инциденты из SLA на всех хостах."""
    conn = get_db_connection()
    rows = conn.execute('SELECT id, pattern FROM sla_exclusion_rules ORDER BY pattern ASC').fetchall()
    conn.close()
    return [{'id': row['id'], 'pattern': row['pattern']} for row in rows]

def add_sla_exclusion_rule(pattern):
    """Добавляет правило. Возвращает id нового правила или None, если такое уже есть."""
    conn = get_db_connection()
    try:
        cursor = conn.execute('INSERT INTO sla_exclusion_rules (pattern) VALUES (?)', (pattern.strip(),))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()

def delete_sla_exclusion_rule(rule_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM sla_exclusion_rules WHERE id = ?', (rule_id,))
    conn.commit()
    conn.close()

def bulk_save_incident_overrides(eventids, category, comment, username):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        for ev_id in eventids:
            # Сохраняем категорию
            cursor.execute('INSERT OR REPLACE INTO incident_category_overrides (eventid, category) VALUES (?, ?)', (ev_id, category))
            
            # Сохраняем комментарий (если передан)
            if comment is not None:
                cursor.execute('INSERT OR REPLACE INTO incident_comments (eventid, comment, username) VALUES (?, ?, ?)', (ev_id, comment, username))
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

# === Функции авторизации и пользователей ===

def create_user(username, password, role='user'):
    conn = get_db_connection()
    try:
        password_hash = generate_password_hash(password)
        conn.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', (username.strip(), password_hash, role))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

def authenticate_user(username, password):
    conn = get_db_connection()
    row = conn.execute('SELECT id, username, password_hash, role FROM users WHERE username = ?', (username.strip(),)).fetchone()
    conn.close()
    if row and check_password_hash(row['password_hash'], password):
        return dict(row)
    return None

def change_password(user_id, old_password, new_password):
    conn = get_db_connection()
    row = conn.execute('SELECT password_hash FROM users WHERE id = ?', (user_id,)).fetchone()
    if not row:
        conn.close()
        return False, "Пользователь не найден"
        
    if not check_password_hash(row['password_hash'], old_password):
        conn.close()
        return False, "Неверный текущий пароль"
        
    password_hash = generate_password_hash(new_password)
    conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (password_hash, user_id))
    conn.commit()
    conn.close()
    return True, "Пароль успешно изменен"

def change_password_by_admin(user_id, new_password):
    conn = get_db_connection()
    password_hash = generate_password_hash(new_password)
    conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (password_hash, user_id))
    conn.commit()
    conn.close()
    return True

def get_all_users():
    conn = get_db_connection()
    rows = conn.execute('SELECT id, username, role FROM users ORDER BY username').fetchall()
    conn.close()
    return [dict(row) for row in rows]

def delete_user(user_id):
    conn = get_db_connection()
    # Запрещаем удалять последнего администратора
    row = conn.execute('SELECT role FROM users WHERE id = ?', (user_id,)).fetchone()
    if row and row['role'] == 'admin':
        admins_count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
        if admins_count <= 1:
            conn.close()
            return False, "Нельзя удалить единственного администратора"
            
    conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
    conn.commit()
    conn.close()
    return True, "Пользователь успешно удален"

def change_user_role(user_id, new_role):
    if new_role not in ('admin', 'user'):
        return False, "Недопустимая роль"

    conn = get_db_connection()
    row = conn.execute('SELECT role FROM users WHERE id = ?', (user_id,)).fetchone()
    if not row:
        conn.close()
        return False, "Пользователь не найден"

    # Запрещаем разжаловать последнего администратора
    if row['role'] == 'admin' and new_role != 'admin':
        admins_count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
        if admins_count <= 1:
            conn.close()
            return False, "Нельзя понизить роль единственного администратора"

    conn.execute('UPDATE users SET role = ? WHERE id = ?', (new_role, user_id))
    conn.commit()
    conn.close()
    return True, "Роль пользователя обновлена"

# === Функции комментариев к инцидентам ===

def save_incident_comment(eventid, comment, username):
    conn = get_db_connection()
    conn.execute('''
        INSERT OR REPLACE INTO incident_comments (eventid, comment, username)
        VALUES (?, ?, ?)
    ''', (eventid, comment.strip(), username))
    conn.commit()
    conn.close()

def get_incident_comments():
    conn = get_db_connection()
    rows = conn.execute('SELECT eventid, comment, username, created_at FROM incident_comments').fetchall()
    conn.close()
    return {row['eventid']: dict(row) for row in rows}

def save_category_override(eventid, category):
    conn = get_db_connection()
    if category == 'auto':
        conn.execute('DELETE FROM incident_category_overrides WHERE eventid = ?', (eventid,))
    else:
        conn.execute('''
            INSERT OR REPLACE INTO incident_category_overrides (eventid, category)
            VALUES (?, ?)
        ''', (eventid, category))
    conn.commit()
    conn.close()

# === BI-аналитика: группы (типы) инцидентов и автоклассификация по паттернам ===

def get_analytics_groups():
    """Возвращает список групп с их паттернами: [{id, name, color, patterns: [str, ...]}, ...]."""
    conn = get_db_connection()
    groups = conn.execute(
        'SELECT id, name, color FROM analytics_groups ORDER BY sort_order ASC, name ASC'
    ).fetchall()
    patterns = conn.execute(
        'SELECT id, group_id, pattern FROM analytics_group_patterns ORDER BY pattern ASC'
    ).fetchall()
    conn.close()

    patterns_by_group = {}
    for p in patterns:
        patterns_by_group.setdefault(p['group_id'], []).append({'id': p['id'], 'pattern': p['pattern']})

    return [
        {
            'id': g['id'],
            'name': g['name'],
            'color': g['color'],
            'patterns': patterns_by_group.get(g['id'], [])
        }
        for g in groups
    ]

def create_analytics_group(name, color='#3b82f6'):
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            'INSERT INTO analytics_groups (name, color, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM analytics_groups))',
            (name.strip(), color)
        )
        conn.commit()
        return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()

def delete_analytics_group(group_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM analytics_groups WHERE id = ?', (group_id,))
    conn.commit()
    conn.close()

def add_analytics_pattern(group_id, pattern):
    conn = get_db_connection()
    try:
        conn.execute(
            'INSERT OR IGNORE INTO analytics_group_patterns (group_id, pattern) VALUES (?, ?)',
            (group_id, pattern.strip())
        )
        conn.commit()
    finally:
        conn.close()

def delete_analytics_pattern(pattern_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM analytics_group_patterns WHERE id = ?', (pattern_id,))
    conn.commit()
    conn.close()

def classify_analytics_group(incident_name, groups):
    """
    Находит первую группу и конкретный паттерн, совпадающий с именем инцидента
    (подстрока, без учета регистра). Возвращает (group, pattern) или (None, None).
    """
    name_lower = incident_name.lower()
    for g in groups:
        for p in g['patterns']:
            if p['pattern'].lower() in name_lower:
                return g, p
    return None, None
