import time
import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import database
from zabbix_api import ZabbixAPI
import notifier

_scheduler = None

import re

SUFFIXES_TO_STRIP = [
    r'1c\d*$', r'bkp$', r'backup$', r'nas$', r'srv\d*$', r'gw$', r'fs$', r'sql$', r'server$', r'db$', r'bd$', 
    r'pbx$', r'host$', r'test$', r'kvm\d*$', r'ad$', r'dc$', r'rdp$', r'term\d*$', r'terminal$', r'share\d*$'
]

def clean_suffix(name):
    for pattern in SUFFIXES_TO_STRIP:
        name = re.sub(pattern, '', name, flags=re.IGNORECASE)
    return name

def auto_detect_client(host_data):
    host_name = host_data.get('name', '')
    if not host_name or host_name.lower() == 'zabbix server':
        return 'не указано'
        
    # 1. Если имя содержит дефис или подчеркивание, разбиваем по первому символу
    # Но проверим, чтобы первый кусок не был техническим обозначением типа 'srv'
    match = re.split(r'[-_]', host_name)
    if match:
        first_part = match[0].strip()
        if first_part.lower() not in ['srv', 'kvm', 'vm', 'host', 'test', 'gate', 'gw', '1c']:
            cleaned = clean_suffix(first_part)
            if len(cleaned) >= 2:
                return cleaned
                
    # 2. Если разделителей нет, пробуем убрать известные суффиксы с конца имени
    cleaned_name = clean_suffix(host_name)
    if cleaned_name != host_name and len(cleaned_name) >= 2:
        return cleaned_name
        
    # 3. Если ничего не подошло, возвращаем исходное имя, если оно длиннее 3 символов
    if len(host_name) >= 3 and host_name.lower() not in ['zabbix', 'localhost', 'server']:
        return host_name
        
    return 'не указано'

def sync_zabbix_data():
    """
    Основная функция синхронизации всех хостов и данных из Zabbix в локальную БД.
    """
    settings = database.get_settings()
    url = settings.get('zabbix_url')
    token = settings.get('zabbix_token')
    user = settings.get('zabbix_user')
    password = settings.get('zabbix_password')
    
    if not url:
        print("[Scheduler] Zabbix URL not configured, skipping sync.")
        return
        
    try:
        print("[Scheduler] Connecting to Zabbix API...")
        api = ZabbixAPI(url, token, user, password)
        api.login()
        
        # 1. Загружаем все monitored хосты из Zabbix (с группами и тегами)
        zbx_hosts = api.get_hosts()
        print(f"[Scheduler] Found {len(zbx_hosts)} monitored hosts in Zabbix.")
        
        # Получаем текущий режим маппинга
        mapping_mode = settings.get('mapping_mode', 'name_auto')
        
        # Системные группы хостов Zabbix для исключения при автогруппировке (подгружаем динамически)
        ignored_groups_str = settings.get('ignored_host_groups', '')
        system_groups = [g.strip().lower() for g in ignored_groups_str.split(',') if g.strip()]
        
        # 2. Сопоставляем и сохраняем хосты в локальной базе данных
        current_mappings = {m['zabbix_hostid']: m for m in database.get_mappings()}
        
        for zh in zbx_hosts:
            h_id = zh['hostid']
            h_name = zh['name']
            
            if mapping_mode == 'group_auto':
                # Маппинг по несистемным Host Groups в Zabbix
                client_name = 'не указано'
                groups = zh.get('groups', [])
                for g in groups:
                    g_name = g.get('name', '')
                    g_name_lower = g_name.lower()
                    
                    is_system = False
                    for sys_g in system_groups:
                        if re.search(rf'\b{re.escape(sys_g)}\b', g_name_lower):
                            is_system = True
                            break
                            
                    if not is_system and g_name:
                        client_name = g_name
                        break
                is_manual = 0
            else:
                # Определение по имени хоста
                client_name = auto_detect_client(zh)
                is_manual = 0
            
            if h_id in current_mappings:
                db_map = current_mappings[h_id]
                if mapping_mode == 'group_auto':
                    # В режиме полного автомата перезаписываем клиента
                    database.save_mapping(h_id, h_name, client_name, db_map['comment'] or '', 0, 1)
                else:
                    # В гибридном режиме ручные правки в приоритете
                    if db_map.get('is_manual', 0) == 0:
                        database.save_mapping(h_id, h_name, client_name, db_map['comment'] or '', 0, 1)
                    else:
                        database.save_mapping(h_id, h_name, db_map['client_name'], db_map['comment'] or '', 1, 1)
            else:
                # Абсолютно новый хост в системе
                database.save_mapping(h_id, h_name, client_name, '', is_manual, 1)
                
        # Автоматическая мягкая очистка хостов, которые были удалены или деактивированы в Zabbix
        active_hostids = {zh['hostid'] for zh in zbx_hosts}
        deleted_hostids = set(current_mappings.keys()) - active_hostids
        if deleted_hostids:
            print(f"[Scheduler] Found {len(deleted_hostids)} deactivated or deleted hosts in Zabbix. Setting active=0...")
            for del_id in deleted_hostids:
                database.set_host_active_status(del_id, 0)
                
        # 3. Загружаем актуальные привязки хостов из БД для сбора инцидентов (только активные)
        mappings = database.get_mappings(only_active=True)
        hostids = [m['zabbix_hostid'] for m in mappings]
        
        if not hostids:
            print("[Scheduler] No hosts to sync incidents for.")
            return
            
        # Синхронизируем инциденты за последние 35 дней
        time_till = int(time.time())
        time_from = time_till - (35 * 24 * 3600)
        
        print(f"[Scheduler] Fetching incidents for {len(hostids)} hosts...")
        incidents = api.fetch_incidents(hostids, time_from, time_till)
        
        # Получаем статус обслуживания для всех хостов пачками по 200
        maintenance_hosts = set()
        for i in range(0, len(hostids), 200):
            chunk = hostids[i:i+200]
            try:
                hosts_detailed = api._request('host.get', {
                    "output": ["hostid", "maintenance_status"],
                    "hostids": chunk
                })
                for h in hosts_detailed:
                    if int(h.get('maintenance_status', 0)) == 1:
                        maintenance_hosts.add(h['hostid'])
            except Exception as e:
                print(f"[Scheduler] Warning: failed to fetch maintenance status for chunk: {str(e)}")
        
        for inc in incidents:
            if inc['hostid'] in maintenance_hosts and not inc['r_clock']:
                inc['is_maintenance'] = 1
                
        database.cache_incidents(incidents)
        print(f"[Scheduler] Successfully synced and cached {len(incidents)} incidents.")
        
    except Exception as e:
        print(f"[Scheduler] Error during Zabbix sync: {str(e)}")

def check_and_send_scheduled_reports():
    """
    Раз в сутки проверяет, нужно ли отправить плановые отчеты.
    """
    now = datetime.datetime.now()
    
    # Отправляем еженедельный отчет в понедельник в 08:00
    if now.weekday() == 0 and now.hour == 8 and now.minute < 30:
        print("[Scheduler] Generating weekly report...")
        end_time = int(time.time())
        start_time = end_time - (7 * 24 * 3600)
        send_periodic_reports("Еженедельный", start_time, end_time)
        
    # Отправляем ежемесячный отчет 1-го числа в 08:00
    if now.day == 1 and now.hour == 8 and now.minute < 30:
        print("[Scheduler] Generating monthly report...")
        # Начало предыдущего месяца
        today = datetime.date.today()
        first_day_current_month = today.replace(day=1)
        last_day_prev_month = first_day_current_month - datetime.timedelta(days=1)
        first_day_prev_month = last_day_prev_month.replace(day=1)
        
        start_time = int(time.mktime(first_day_prev_month.timetuple()))
        end_time = int(time.mktime(first_day_current_month.timetuple()))
        send_periodic_reports("Ежемесячный", start_time, end_time)

def send_periodic_reports(period_name, start_time, end_time):
    settings = database.get_settings()
    
    # 1. Отправка на почту
    smtp_to = settings.get('smtp_user') # Отправляем администратору или по указанному списку
    if smtp_to and settings.get('smtp_host'):
        try:
            subject = f"Мониторинг SLA: {period_name} отчет по клиентам"
            notifier.send_email_report(smtp_to, subject, start_time, end_time)
            print(f"[Scheduler] Sent email report to {smtp_to}")
        except Exception as e:
            print(f"[Scheduler] Failed to send email report: {str(e)}")
            
    # 2. Отправка в Telegram
    if settings.get('telegram_enabled') == '1':
        try:
            notifier.send_telegram_report(start_time, end_time)
            print("[Scheduler] Sent Telegram report")
        except Exception as e:
            print(f"[Scheduler] Failed to send Telegram report: {str(e)}")

def init_scheduler():
    global _scheduler
    if _scheduler is None:
        database.init_db()
        _scheduler = BackgroundScheduler()
        # Синхронизация Zabbix каждые 10 минут
        _scheduler.add_job(sync_zabbix_data, 'interval', minutes=10, id='zabbix_sync')
        # Проверка отчетов каждый час
        _scheduler.add_job(check_and_send_scheduled_reports, 'cron', hour='*', minute='0', id='report_check')
        _scheduler.start()
        print("[Scheduler] Background scheduler started.")
        # Запускаем первоначальную синхронизацию при старте в фоновом режиме
        _scheduler.add_job(sync_zabbix_data, 'date', run_date=datetime.datetime.now() + datetime.timedelta(seconds=5))
