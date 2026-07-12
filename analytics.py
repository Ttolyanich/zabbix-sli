import datetime
import database

def parse_time_str(time_str):
    """Преобразует строку вида 'HH:MM' в часы и минуты."""
    try:
        parts = time_str.split(':')
        return int(parts[0]), int(parts[1])
    except Exception:
        return 9, 0

def get_working_seconds_in_interval(t1, t2, working_days, start_str, end_str):
    """
    Вычисляет количество рабочих секунд в интервале [t1, t2].
    working_days: список целых чисел (1=Пн, ..., 7=Вс)
    start_str: строка начала рабочего дня, например '09:00'
    end_str: строка конца рабочего дня, например '18:00'
    """
    if t1 >= t2:
        return 0
        
    start_hour, start_min = parse_time_str(start_str)
    end_hour, end_min = parse_time_str(end_str)
    
    total_seconds = 0
    
    # Идем по дням от t1 до t2
    dt_start = datetime.datetime.fromtimestamp(t1)
    dt_end = datetime.datetime.fromtimestamp(t2)
    
    # Нормализуем к началу дня для итерации
    current_day = dt_start.date()
    end_day = dt_end.date()
    
    while current_day <= end_day:
        # День недели (1 = Пн, 7 = Вс)
        weekday = current_day.isoweekday()
        
        if weekday in working_days:
            # Границы рабочего времени для текущего дня
            day_work_start = datetime.datetime.combine(current_day, datetime.time(start_hour, start_min))
            day_work_end = datetime.datetime.combine(current_day, datetime.time(end_hour, end_min))
            
            ts_work_start = int(day_work_start.timestamp())
            ts_work_end = int(day_work_end.timestamp())
            
            # Пересечение с интервалом [t1, t2]
            overlap_start = max(t1, ts_work_start)
            overlap_end = min(t2, ts_work_end)
            
            if overlap_start < overlap_end:
                total_seconds += (overlap_end - overlap_start)
                
        current_day += datetime.timedelta(days=1)
        
    return total_seconds

def calculate_sli_report(start_time, end_time):
    """
    Рассчитывает метрики доступности и времени реакции по всем клиентам и их серверам.
    """
    settings = database.get_settings()
    mappings = database.get_mappings()
    
    # Чтение настроек рабочих часов
    working_hours_enabled = settings.get('working_hours_enabled') == '1'
    start_str = settings.get('working_hours_start', '09:00')
    end_str = settings.get('working_hours_end', '18:00')
    try:
        working_days = [int(x) for x in settings.get('working_days', '1,2,3,4,5').split(',') if x.strip()]
    except Exception:
        working_days = [1, 2, 3, 4, 5]
        
    exclude_vpn = settings.get('exclude_vpn_issues') == '1'
    
    # Загружаем неактивные паттерны для исключения из SLA
    ignored_patterns = []
    try:
        patterns = database.get_incident_patterns()
        ignored_patterns = [p['pattern'].lower() for p in patterns if p['is_incident'] == 0]
    except Exception as e:
        print(f"[Analytics] Error loading incident patterns: {str(e)}")
        
    # Группируем хосты по клиентам
    clients = {}
    host_to_client = {}
    host_details = {}
    
    for m in mappings:
        c_name = m['client_name']
        h_id = m['zabbix_hostid']
        if c_name not in clients:
            clients[c_name] = []
        clients[c_name].append(h_id)
        host_to_client[h_id] = c_name
        host_details[h_id] = {
            'name': m['host_name'],
            'comment': m['comment']
        }
        
    all_host_ids = list(host_to_client.keys())
    if not all_host_ids:
        return {}
        
    # Получаем инциденты из кэша
    incidents = database.get_incidents(start_time, end_time, all_host_ids)
    
    # Рассчитываем общее доступное время для периода
    if working_hours_enabled:
        total_period_seconds = get_working_seconds_in_interval(start_time, end_time, working_days, start_str, end_str)
    else:
        total_period_seconds = end_time - start_time
        
    if total_period_seconds <= 0:
        total_period_seconds = 1  # Защита от деления на ноль
        
    # Инициализируем структуру результатов
    results = {}
    for c_name, h_ids in clients.items():
        results[c_name] = {
            'client_name': c_name,
            'sla_percent': 100.0,
            'total_downtime_sec': 0,
            'servers': {},
            'mttr_avg_sec': 0,
            'mttd_avg_sec': 0,
            'total_incidents_count': 0
        }
        for h_id in h_ids:
            results[c_name]['servers'][h_id] = {
                'hostid': h_id,
                'name': host_details[h_id]['name'],
                'comment': host_details[h_id]['comment'],
                'sla_percent': 100.0,
                'downtime_sec': 0,
                'incidents': [],
                'mttr_sec': 0,
                'mttd_sec': 0,
                'incidents_count': 0
            }
            
    # Распределяем инциденты по серверам и считаем простои
    for inc in incidents:
        h_id = inc['hostid']
        c_name = host_to_client.get(h_id)
        if not c_name:
            continue
            
        # Проверяем, совпадает ли имя инцидента с одним из отключенных паттернов
        inc_name_lower = inc['name'].lower()
        is_ignored_by_pattern = False
        for pat in ignored_patterns:
            if pat in inc_name_lower:
                is_ignored_by_pattern = True
                break
                
        if is_ignored_by_pattern:
            continue
            
        # Проверяем фильтры исключений
        if exclude_vpn and inc['is_vpn_issue'] == 1:
            # Помечаем в списке, но не считаем простоем
            inc_downtime = 0
        elif inc['is_maintenance'] == 1:
            # Обслуживание исключаем из простоев
            inc_downtime = 0
        else:
            # Вычисляем пересечение инцидента с отчетным периодом
            inc_start = max(start_time, inc['clock'])
            inc_end = min(end_time, inc['r_clock']) if inc['r_clock'] else end_time
            
            if inc_start < inc_end:
                if working_hours_enabled:
                    inc_downtime = get_working_seconds_in_interval(inc_start, inc_end, working_days, start_str, end_str)
                else:
                    inc_downtime = inc_end - inc_start
            else:
                inc_downtime = 0
                
        # Добавляем в инциденты сервера
        srv_data = results[c_name]['servers'][h_id]
        srv_data['downtime_sec'] += inc_downtime
        srv_data['incidents_count'] += 1
        
        # Добавляем MTTR / MTTD для инцидента
        # MTTD (Reaction) = ack_time - clock (если есть ack)
        # MTTR (Resolution) = r_clock - clock (если решен)
        mttd = None
        mttr = None
        if inc['ack_time'] and inc['ack_time'] > inc['clock']:
            mttd = inc['ack_time'] - inc['clock']
        if inc['r_clock'] and inc['r_clock'] > inc['clock']:
            mttr = inc['r_clock'] - inc['clock']
            
        # Создаем копию для отчета
        inc_report = dict(inc)
        inc_report['downtime_in_period_sec'] = inc_downtime
        inc_report['mttd_sec'] = mttd
        inc_report['mttr_sec'] = mttr
        srv_data['incidents'].append(inc_report)
        
    # Рассчитываем итоговые проценты по серверам и клиентам
    for c_name, client_data in results.items():
        client_downtimes = []
        client_mttr_sums = 0
        client_mttd_sums = 0
        client_mttr_count = 0
        client_mttd_count = 0
        client_total_incidents = 0
        
        for h_id, srv_data in client_data['servers'].items():
            # Расчет SLA сервера
            srv_sla = ((total_period_seconds - srv_data['downtime_sec']) / total_period_seconds) * 100.0
            srv_data['sla_percent'] = max(0.0, min(100.0, round(srv_sla, 3)))
            client_downtimes.append(srv_data['sla_percent'])
            
            # Средние метрики по серверу
            srv_mttr_sum = 0
            srv_mttr_cnt = 0
            srv_mttd_sum = 0
            srv_mttd_cnt = 0
            for inc in srv_data['incidents']:
                if inc['mttr_sec'] is not None:
                    srv_mttr_sum += inc['mttr_sec']
                    srv_mttr_cnt += 1
                if inc['mttd_sec'] is not None:
                    srv_mttd_sum += inc['mttd_sec']
                    srv_mttd_cnt += 1
                    
            srv_data['mttr_sec'] = int(srv_mttr_sum / srv_mttr_cnt) if srv_mttr_cnt > 0 else 0
            srv_data['mttd_sec'] = int(srv_mttd_sum / srv_mttd_cnt) if srv_mttd_cnt > 0 else 0
            
            client_mttr_sums += srv_mttr_sum
            client_mttr_count += srv_mttr_cnt
            client_mttd_sums += srv_mttd_sum
            client_mttd_count += srv_mttd_cnt
            client_total_incidents += srv_data['incidents_count']
            
            # Сортируем инциденты сервера по времени начала (новые сверху)
            srv_data['incidents'].sort(key=lambda x: x['clock'], reverse=True)
            
        # Средний SLA по всем серверам клиента
        if client_downtimes:
            client_data['sla_percent'] = round(sum(client_downtimes) / len(client_downtimes), 3)
        else:
            client_data['sla_percent'] = 100.0
            
        client_data['total_downtime_sec'] = sum(s['downtime_sec'] for s in client_data['servers'].values())
        client_data['mttr_avg_sec'] = int(client_mttr_sums / client_mttr_count) if client_mttr_count > 0 else 0
        client_data['mttd_avg_sec'] = int(client_mttd_sums / client_mttd_count) if client_mttd_count > 0 else 0
        client_data['total_incidents_count'] = client_total_incidents
        
        # Превращаем dict серверов в список для удобства на фронте
        client_data['servers'] = list(client_data['servers'].values())
        client_data['servers'].sort(key=lambda x: x['name'])
        
    return results
