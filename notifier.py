import smtplib
import os
import requests
import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from io import BytesIO
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

import database
import analytics

def format_duration(seconds):
    """Преобразует секунды в читаемый вид (ЧЧ:ММ:СС)."""
    if seconds is None:
        return "-"
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"

def generate_excel_report(start_time, end_time):
    """
    Генерирует Excel-отчет по доступности серверов и возвращает BytesIO объект.
    """
    report_data = analytics.calculate_sli_report(start_time, end_time)
    
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "SLI-SLA Report"
    
    # Стили
    title_font = Font(name='Segoe UI', size=16, bold=True, color='FFFFFF')
    header_font = Font(name='Segoe UI', size=11, bold=True, color='FFFFFF')
    section_font = Font(name='Segoe UI', size=12, bold=True, color='000000')
    normal_font = Font(name='Segoe UI', size=11)
    bold_font = Font(name='Segoe UI', size=11, bold=True)
    
    blue_fill = PatternFill(start_color='1F4E78', end_color='1F4E78', fill_type='solid')
    gray_fill = PatternFill(start_color='F2F2F2', end_color='F2F2F2', fill_type='solid')
    light_blue_fill = PatternFill(start_color='DDEBF7', end_color='DDEBF7', fill_type='solid')
    
    border_side = Side(border_style="thin", color="D9D9D9")
    thin_border = Border(left=border_side, right=border_side, top=border_side, bottom=border_side)
    double_bottom_border = Border(bottom=Side(style='double'), top=Side(style='thin'))
    
    # Шапка отчета
    ws.merge_cells('A1:G2')
    title_cell = ws['A1']
    title_cell.value = f"Отчет по доступности серверов (SLI/SLA)\nПериод: {datetime.datetime.fromtimestamp(start_time).strftime('%d.%m.%Y')} - {datetime.datetime.fromtimestamp(end_time).strftime('%d.%m.%Y')}"
    title_cell.font = title_font
    title_cell.fill = blue_fill
    title_cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    
    # Заголовки колонок
    headers = [
        "Клиент / Сервер", 
        "Uptime %", 
        "Общее время простоя", 
        "Инцидентов всего", 
        "Ср. время реакции (MTTD)", 
        "Ср. время решения (MTTR)", 
        "Комментарий"
    ]
    
    ws.append([]) # Пустая строка
    ws.append([]) # Пустая строка
    
    row_num = 4
    for col_num, header in enumerate(headers, 1):
        cell = ws.cell(row=row_num, column=col_num)
        cell.value = header
        cell.font = header_font
        cell.fill = blue_fill
        cell.alignment = Alignment(horizontal='center', vertical='center')
        cell.border = thin_border
        
    ws.row_dimensions[row_num].height = 28
    
    for client_name, client_data in report_data.items():
        row_num += 1
        ws.row_dimensions[row_num].height = 22
        
        # Строка клиента
        c_cell = ws.cell(row=row_num, column=1, value=client_name)
        c_cell.font = section_font
        c_cell.fill = light_blue_fill
        c_cell.border = thin_border
        
        sla_cell = ws.cell(row=row_num, column=2, value=f"{client_data['sla_percent']}%")
        sla_cell.font = section_font
        sla_cell.fill = light_blue_fill
        sla_cell.alignment = Alignment(horizontal='right')
        sla_cell.border = thin_border
        
        dt_cell = ws.cell(row=row_num, column=3, value=format_duration(client_data['total_downtime_sec']))
        dt_cell.font = section_font
        dt_cell.fill = light_blue_fill
        dt_cell.alignment = Alignment(horizontal='center')
        dt_cell.border = thin_border
        
        inc_cell = ws.cell(row=row_num, column=4, value=client_data['total_incidents_count'])
        inc_cell.font = section_font
        inc_cell.fill = light_blue_fill
        inc_cell.alignment = Alignment(horizontal='center')
        inc_cell.border = thin_border
        
        mttd_cell = ws.cell(row=row_num, column=5, value=format_duration(client_data['mttd_avg_sec']))
        mttd_cell.font = section_font
        mttd_cell.fill = light_blue_fill
        mttd_cell.alignment = Alignment(horizontal='center')
        mttd_cell.border = thin_border
        
        mttr_cell = ws.cell(row=row_num, column=6, value=format_duration(client_data['mttr_avg_sec']))
        mttr_cell.font = section_font
        mttr_cell.fill = light_blue_fill
        mttr_cell.alignment = Alignment(horizontal='center')
        mttr_cell.border = thin_border
        
        ws.cell(row=row_num, column=7, value="").fill = light_blue_fill
        ws.cell(row=row_num, column=7).border = thin_border
        
        # Строки серверов
        for srv in client_data['servers']:
            row_num += 1
            ws.row_dimensions[row_num].height = 20
            
            s_name = ws.cell(row=row_num, column=1, value=f"  ↳ {srv['name']}")
            s_name.font = normal_font
            s_name.border = thin_border
            
            s_sla = ws.cell(row=row_num, column=2, value=f"{srv['sla_percent']}%")
            s_sla.font = normal_font
            s_sla.alignment = Alignment(horizontal='right')
            s_sla.border = thin_border
            
            s_dt = ws.cell(row=row_num, column=3, value=format_duration(srv['downtime_sec']))
            s_dt.font = normal_font
            s_dt.alignment = Alignment(horizontal='center')
            s_dt.border = thin_border
            
            s_inc = ws.cell(row=row_num, column=4, value=srv['incidents_count'])
            s_inc.font = normal_font
            s_inc.alignment = Alignment(horizontal='center')
            s_inc.border = thin_border
            
            s_mttd = ws.cell(row=row_num, column=5, value=format_duration(srv['mttd_sec']))
            s_mttd.font = normal_font
            s_mttd.alignment = Alignment(horizontal='center')
            s_mttd.border = thin_border
            
            s_mttr = ws.cell(row=row_num, column=6, value=format_duration(srv['mttr_sec']))
            s_mttr.font = normal_font
            s_mttr.alignment = Alignment(horizontal='center')
            s_mttr.border = thin_border
            
            s_comm = ws.cell(row=row_num, column=7, value=srv['comment'] or "")
            s_comm.font = normal_font
            s_comm.border = thin_border
            
    # Автоподбор ширины колонок
    from openpyxl.utils import get_column_letter
    for col in ws.columns:
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            val = str(cell.value or '')
            if '\n' in val:
                lines = val.split('\n')
                max_len = max(max_len, max(len(l) for l in lines))
            else:
                max_len = max(max_len, len(val))
        ws.column_dimensions[col_letter].width = max(max_len + 3, 12)
        
    ws.column_dimensions['A'].width = 30
    ws.column_dimensions['G'].width = 25
    
    file_stream = BytesIO()
    wb.save(file_stream)
    file_stream.seek(0)
    return file_stream

def send_email_report(recipient, subject, start_time, end_time):
    """
    Отправляет email с HTML-отчетом и вложенным Excel-файлом.
    """
    settings = database.get_settings()
    
    # Проверка настроек SMTP
    smtp_host = settings.get('smtp_host')
    smtp_port = int(settings.get('smtp_port', '587'))
    smtp_user = settings.get('smtp_user')
    smtp_password = settings.get('smtp_password')
    smtp_from = settings.get('smtp_from', smtp_user)
    use_tls = settings.get('smtp_use_tls') == '1'
    
    if not smtp_host or not smtp_user:
        raise Exception("SMTP-сервер не настроен в системе.")
        
    report_data = analytics.calculate_sli_report(start_time, end_time)
    
    # Генерация HTML тела письма
    date_start_str = datetime.datetime.fromtimestamp(start_time).strftime('%d.%m.%Y')
    date_end_str = datetime.datetime.fromtimestamp(end_time).strftime('%d.%m.%Y')
    
    html_body = f"""
    <html>
    <head>
        <style>
            body {{ font-family: 'Segoe UI', Arial, sans-serif; color: #333; }}
            table {{ border-collapse: collapse; width: 100%; margin-top: 15px; }}
            th, td {{ border: 1px solid #ddd; padding: 10px; text-align: left; }}
            th {{ background-color: #1F4E78; color: white; }}
            tr:nth-child(even) {{ background-color: #f9f9f9; }}
            .client-row {{ background-color: #DDEBF7 !important; font-weight: bold; }}
            .sla-good {{ color: green; font-weight: bold; }}
            .sla-bad {{ color: red; font-weight: bold; }}
            .footer {{ margin-top: 20px; font-size: 12px; color: #777; }}
        </style>
    </head>
    <body>
        <h2>Отчет по доступности серверов и уровню обслуживания (SLI/SLA)</h2>
        <p>За период: <b>{date_start_str} - {date_end_str}</b></p>
        
        <table>
            <thead>
                <tr>
                    <th>Клиент / Сервер</th>
                    <th>Uptime %</th>
                    <th>Время простоя</th>
                    <th>Кол-во сбоев</th>
                    <th>MTTD (Реакция)</th>
                    <th>MTTR (Решение)</th>
                </tr>
            </thead>
            <tbody>
    """
    
    for client_name, client_data in report_data.items():
        sla_val = client_data['sla_percent']
        sla_class = "sla-good" if sla_val >= 99.0 else "sla-bad"
        
        html_body += f"""
        <tr class="client-row">
            <td>{client_name}</td>
            <td class="{sla_class}">{sla_val}%</td>
            <td>{format_duration(client_data['total_downtime_sec'])}</td>
            <td>{client_data['total_incidents_count']}</td>
            <td>{format_duration(client_data['mttd_avg_sec'])}</td>
            <td>{format_duration(client_data['mttr_avg_sec'])}</td>
        </tr>
        """
        for srv in client_data['servers']:
            srv_sla_val = srv['sla_percent']
            srv_sla_class = "sla-good" if srv_sla_val >= 99.0 else "sla-bad"
            html_body += f"""
            <tr>
                <td>&nbsp;&nbsp;&nbsp;&nbsp;↳ {srv['name']}</td>
                <td class="{srv_sla_class}">{srv_sla_val}%</td>
                <td>{format_duration(srv['downtime_sec'])}</td>
                <td>{srv['incidents_count']}</td>
                <td>{format_duration(srv['mttd_sec'])}</td>
                <td>{format_duration(srv['mttr_sec'])}</td>
            </tr>
            """
            
    html_body += """
            </tbody>
        </table>
        
        <p class="footer">Детальный отчет по сбоям прикреплен во вложении к данному письму.</p>
        <p class="footer">С уважением,<br>Служба мониторинга ИТ-инфраструктуры</p>
    </body>
    </html>
    """
    
    # Создание письма
    msg = MIMEMultipart()
    msg['From'] = smtp_from
    msg['To'] = recipient
    msg['Subject'] = subject
    
    msg.attach(MIMEText(html_body, 'html'))
    
    # Генерация и прикрепление Excel
    excel_stream = generate_excel_report(start_time, end_time)
    attachment = MIMEBase('application', 'octet-stream')
    attachment.set_payload(excel_stream.read())
    encoders.encode_base64(attachment)
    
    filename = f"SLI_SLA_Report_{date_start_str}_{date_end_str}.xlsx"
    attachment.add_header('Content-Disposition', 'attachment', filename=filename)
    msg.attach(attachment)
    
    # Отправка
    server = smtplib.SMTP(smtp_host, smtp_port)
    if use_tls:
        server.starttls()
    if smtp_user and smtp_password:
        server.login(smtp_user, smtp_password)
    server.sendmail(smtp_from, recipient, msg.as_string())
    server.quit()

def send_telegram_alert(text):
    """
    Отправляет мгновенное текстовое оповещение в Telegram-канал/чат.
    """
    settings = database.get_settings()
    enabled = settings.get('telegram_enabled') == '1'
    token = settings.get('telegram_bot_token')
    chat_id = settings.get('telegram_chat_id')
    
    if not enabled or not token or not chat_id:
        return False
        
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML"
    }
    try:
        response = requests.post(url, json=payload, timeout=5)
        return response.status_code == 200
    except Exception:
        return False

def send_telegram_report(start_time, end_time):
    """
    Формирует сводный отчет и отправляет его в Telegram.
    """
    settings = database.get_settings()
    enabled = settings.get('telegram_enabled') == '1'
    token = settings.get('telegram_bot_token')
    chat_id = settings.get('telegram_chat_id')
    
    if not enabled or not token or not chat_id:
        return False
        
    report_data = analytics.calculate_sli_report(start_time, end_time)
    
    date_start_str = datetime.datetime.fromtimestamp(start_time).strftime('%d.%m.%Y')
    date_end_str = datetime.datetime.fromtimestamp(end_time).strftime('%d.%m.%Y')
    
    message = f"📊 <b>Отчет SLI/SLA за {date_start_str} - {date_end_str}</b>\n\n"
    
    for client_name, client_data in report_data.items():
        sla = client_data['sla_percent']
        status_emoji = "🟢" if sla >= 99.0 else "🔴"
        message += f"{status_emoji} <b>{client_name}</b>: SLA = <b>{sla}%</b>\n"
        message += f" ├ Простой: <code>{format_duration(client_data['total_downtime_sec'])}</code>\n"
        message += f" ├ Сбоев: <code>{client_data['total_incidents_count']}</code>\n"
        message += f" ├ Реакция (MTTD): <code>{format_duration(client_data['mttd_avg_sec'])}</code>\n"
        message += f" └ Решение (MTTR): <code>{format_duration(client_data['mttr_avg_sec'])}</code>\n\n"
        
    # Отправляем сообщение
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML"
    }
    
    try:
        requests.post(url, json=payload, timeout=5)
        
        # Так же сгенерируем и отправим Excel-отчет
        excel_stream = generate_excel_report(start_time, end_time)
        doc_url = f"https://api.telegram.org/bot{token}/sendDocument"
        files = {
            'document': (f"SLI_SLA_Report_{date_start_str}_{date_end_str}.xlsx", excel_stream, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        }
        data = {
            'chat_id': chat_id,
            'caption': f"Документ: Отчет SLI/SLA ({date_start_str} - {date_end_str})"
        }
        requests.post(doc_url, data=data, files=files, timeout=10)
        return True
    except Exception:
        return False
