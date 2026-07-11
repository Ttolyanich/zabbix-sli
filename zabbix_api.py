import requests
import json
import urllib3

# Отключаем предупреждения о небезопасном SSL-соединении для самоподписанных сертификатов
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class ZabbixAPI:
    def __init__(self, url, token=None, user=None, password=None):
        self.url = url.rstrip('/') + '/api_jsonrpc.php'
        self.token = token
        self.user = user
        self.password = password
        self.session_id = token
        
    def _request(self, method, params=None):
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": 1
        }
        
        if self.session_id and method != 'apiinfo.version':
            payload["auth"] = self.session_id
            
        headers = {
            'Content-Type': 'application/json-rpc'
        }
        
        try:
            # Используем verify=False для обхода ошибок самоподписанных сертификатов
            response = requests.post(self.url, data=json.dumps(payload), headers=headers, timeout=10, verify=False)
            response.raise_for_status()
            res_json = response.json()
            
            if 'error' in res_json:
                error_msg = res_json['error'].get('data', res_json['error'].get('message', 'Unknown error'))
                raise Exception(f"Zabbix API Error: {error_msg}")
                
            return res_json.get('result')
        except requests.exceptions.RequestException as e:
            raise Exception(f"Connection failed: {str(e)}")

    def login(self):
        if self.token:
            # Если задан токен, используем его напрямую
            self.session_id = self.token
            try:
                # Проверим токен, вызвав метод, требующий авторизации (host.get)
                self._request('host.get', {"output": ["hostid"], "limit": 1})
                return self.token
            except Exception as e:
                # Если проверка не прошла, попробуем авторизоваться через логин-пароль
                if not self.user or not self.password:
                    raise Exception(f"Invalid API token and no credentials provided: {str(e)}")
        
        if self.user and self.password:
            params = {
                "username": self.user,
                "password": self.password
            }
            try:
                # В старых версиях Zabbix метод user.login возвращает sessionid
                result = self._request('user.login', params)
                self.session_id = result
                return result
            except Exception as e:
                raise Exception(f"Zabbix Login failed: {str(e)}")
        else:
            raise Exception("Neither token nor credentials provided for Zabbix authorization.")

    def get_hosts(self):
        params = {
            "output": ["hostid", "name", "status"],
            "selectGroups": ["groupid", "name"],
            "selectTags": ["tag", "value"],
            "filter": {
                "status": "0"  # Только активированные хосты (monitored)
            }
        }
        return self._request('host.get', params)

    def fetch_incidents(self, hostids, time_from, time_till):
        """
        Получаем события (events) триггеров для указанных хостов.
        Используем event.get с value=1 (проблемы) и подгружаем связанные recovery-события.
        """
        if not hostids:
            return []
            
        # Запрашиваем события за расширенный период (например, на 15 дней раньше),
        # чтобы поймать инциденты, начавшиеся до начала отчетного периода, но завершившиеся внутри него
        adjusted_time_from = time_from - (15 * 24 * 3600)
        
        events = []
        # Запрашиваем события пачками по 100 хостов, чтобы избежать перегрузки Zabbix PHP/SQL лимитов
        for i in range(0, len(hostids), 100):
            chunk_hostids = hostids[i:i+100]
            params = {
                "output": ["eventid", "objectid", "name", "severity", "clock", "acknowledged", "r_eventid"],
                "selectHosts": ["hostid", "name"],
                "select_acknowledges": ["clock"],
                "hostids": chunk_hostids,
                "source": 0,  # события триггеров
                "object": 0,  # триггер
                "value": 1,   # состояние "проблема"
                "time_from": adjusted_time_from,
                "time_till": time_till,
                "sortfield": ["clock"],
                "sortorder": "ASC"
            }
            try:
                chunk_events = self._request('event.get', params)
                events.extend(chunk_events)
            except Exception as e:
                print(f"[ZabbixAPI] Error fetching events chunk for hostids {chunk_hostids[:3]}...: {str(e)}")
        
        # 1. Собрать все r_eventid для пакетного запроса времени восстановления
        r_eventids = []
        for ev in events:
            r_id = ev.get('r_eventid')
            if r_id and r_id != '0':
                r_eventids.append(r_id)
                
        # 2. Получить время закрытия для всех r_eventid в один (или несколько) запросов
        r_clocks = {}
        if r_eventids:
            # Запрашиваем пачками по 200 штук
            for i in range(0, len(r_eventids), 200):
                chunk = r_eventids[i:i+200]
                try:
                    r_events = self._request('event.get', {
                        "output": ["eventid", "clock"],
                        "eventids": chunk
                    })
                    for rev in r_events:
                        r_clocks[rev['eventid']] = int(rev['clock'])
                except Exception as e:
                    print(f"[ZabbixAPI] Warning: failed to fetch recovery events chunk: {str(e)}")
        
        incidents = []
        for ev in events:
            # Извлекаем хост
            hosts = ev.get('hosts', [])
            if not hosts:
                continue
            host = hosts[0]
            
            # Извлекаем время закрытия
            r_clock = None
            r_id = ev.get('r_eventid')
            if r_id and r_id != '0' and r_id in r_clocks:
                r_clock = r_clocks[r_id]
                
            # Проверяем, пересекается ли инцидент с нашим отчетным периодом
            event_start = int(ev['clock'])
            event_end = r_clock if r_clock else time_till
            
            if event_start > time_till or event_end < time_from:
                # Событие целиком вне отчетного периода
                continue
                
            # Проверяем подтверждения (acknowledges) для MTTD
            acknowledged = int(ev.get('acknowledged', 0))
            ack_time = None
            acks = ev.get('acknowledges', [])
            if acks:
                # Берем самое первое подтверждение по времени
                ack_clocks = [int(a['clock']) for a in acks if 'clock' in a]
                if ack_clocks:
                    ack_time = min(ack_clocks)
                    
            # Проверка флага обслуживания (maintenance)
            # В Zabbix триггеры/события могут не содержать флага напрямую,
            # но мы можем проверить, находится ли хост в обслуживании, или взять это из Zabbix,
            # однако в Zabbix API событие имеет свойство `suppressed` (начиная с 4.0),
            # указывающее, подавлено ли оно обслуживанием.
            # По умолчанию ставим 0.
            is_maintenance = 0
            
            incidents.append({
                'eventid': ev['eventid'],
                'hostid': host['hostid'],
                'name': ev['name'],
                'severity': int(ev['severity']),
                'clock': event_start,
                'r_clock': r_clock,
                'acknowledged': acknowledged,
                'ack_time': ack_time,
                'is_maintenance': is_maintenance
            })
            
        return incidents
