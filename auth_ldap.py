import os

try:
    from ldap3 import Server as LdapServer, Connection as LdapConnection, ALL, SUBTREE
    from ldap3.utils.conv import escape_filter_chars
    LDAP_AVAILABLE = True
except ImportError:
    LDAP_AVAILABLE = False


def _env_bool(name, fallback_name=None, default=False):
    val = os.environ.get(name)
    if val is None and fallback_name:
        val = os.environ.get(fallback_name)
    if val is None:
        return default
    return val.strip().lower() in ('true', '1', 'yes')


def get_ldap_config():
    return {
        'enabled': _env_bool('LDAP_ENABLED', 'AD_ENABLED', False),
        'server': (os.environ.get('LDAP_SERVER') or os.environ.get('AD_SERVER') or '').strip(),
        'port': int(os.environ.get('LDAP_PORT') or os.environ.get('AD_PORT') or 389),
        'use_ssl': _env_bool('LDAP_USE_SSL', 'AD_USE_SSL', False),
        'domain': (os.environ.get('LDAP_DOMAIN') or os.environ.get('AD_DOMAIN') or '').strip(),
        'base_dn': (os.environ.get('LDAP_BASE_DN') or os.environ.get('AD_BASE_DN') or '').strip(),
        'bind_user': (os.environ.get('LDAP_BIND_USER') or os.environ.get('AD_BIND_USER') or '').strip(),
        'bind_password': os.environ.get('LDAP_BIND_PASSWORD') or os.environ.get('AD_BIND_PASSWORD') or '',
        'required_group': (os.environ.get('LDAP_REQUIRED_GROUP') or os.environ.get('AD_REQUIRED_GROUP') or '').strip(),
        'admin_group': (os.environ.get('LDAP_ADMIN_GROUP') or os.environ.get('AD_ADMIN_GROUP') or '').strip(),
        'admin_users': [u.strip().strip('"').strip("'").lower() for u in (os.environ.get('LDAP_ADMIN_USERS') or os.environ.get('AD_ADMIN_USERS') or '').split(',') if u.strip()],
        'nested_groups': _env_bool('LDAP_NESTED_GROUPS', 'AD_NESTED_GROUPS', True),
    }


def build_admin_users_set(admin_users_list):
    """
    Нормализует список администраторов из конфигурации (LDAP_ADMIN_USERS).
    Для записей вида 146@itsupport.kz или DOMAIN\\146 также добавляет короткий логин 146.
    """
    admin_set = set()
    for u in admin_users_list:
        clean = str(u).strip().strip('"').strip("'").lower()
        if not clean:
            continue
        admin_set.add(clean)
        if "@" in clean:
            admin_set.add(clean.split("@")[0].strip())
        if "\\" in clean:
            admin_set.add(clean.split("\\")[-1].strip())
        if "/" in clean:
            admin_set.add(clean.split("/")[-1].strip())
    return admin_set


def normalize_username_candidates(identifier, user_entry=None, ldap_domain=None):
    """
    Формирует множество всех возможных представлений пользователя:
    логин, почта, UPN, sAMAccountName, DOMAIN\\user и т.д.
    """
    candidates = set()
    if identifier:
        raw = str(identifier).strip().strip('"').strip("'").lower()
        if raw:
            candidates.add(raw)
            if "@" in raw:
                candidates.add(raw.split("@")[0].strip())
            if "\\" in raw:
                candidates.add(raw.split("\\")[-1].strip())
            if "/" in raw:
                candidates.add(raw.split("/")[-1].strip())
            if ldap_domain and "@" not in raw and "\\" not in raw:
                candidates.add(f"{raw}@{ldap_domain.lower()}")

    if user_entry:
        if hasattr(user_entry, 'sAMAccountName') and user_entry.sAMAccountName:
            sam = str(user_entry.sAMAccountName).strip().lower()
            if sam:
                candidates.add(sam)
                if ldap_domain and "@" not in sam:
                    candidates.add(f"{sam}@{ldap_domain.lower()}")
        if hasattr(user_entry, 'mail') and user_entry.mail:
            mail = str(user_entry.mail).strip().lower()
            if mail:
                candidates.add(mail)
                if "@" in mail:
                    candidates.add(mail.split("@")[0].strip())
        if hasattr(user_entry, 'userPrincipalName') and user_entry.userPrincipalName:
            upn = str(user_entry.userPrincipalName).strip().lower()
            if upn:
                candidates.add(upn)
                if "@" in upn:
                    candidates.add(upn.split("@")[0].strip())

    return {c for c in candidates if c}


def _clean_ldap_host(server_str):
    if not server_str:
        return "", None, None
    cleaned = server_str.strip().strip('"').strip("'")
    use_ssl = None
    if cleaned.lower().startswith("ldaps://"):
        use_ssl = True
        cleaned = cleaned[8:]
    elif cleaned.lower().startswith("ldap://"):
        use_ssl = False
        cleaned = cleaned[7:]
    cleaned = cleaned.rstrip("/").strip()
    port = None
    if ":" in cleaned:
        host_part, port_part = cleaned.rsplit(":", 1)
        if port_part.isdigit():
            cleaned = host_part
            port = int(port_part)
    return cleaned, port, use_ssl


def authenticate_ldap(identifier, password):
    """
    Проверяет учетные данные пользователя (по корпоративной почте mail, UPN или логину sAMAccountName)
    в домене Active Directory / LDAP.
    Возвращает: (success: bool, resolved_username: str, role: str, display_name: str, error_msg: str|None)
    """
    config = get_ldap_config()

    if not config['enabled']:
        return False, None, None, None, "Авторизация через Active Directory отключена"

    if not LDAP_AVAILABLE:
        return False, None, None, None, "Модуль ldap3 не установлен на сервере"

    if not identifier or not password:
        return False, None, None, None, "Укажите имя пользователя и пароль"

    host, parsed_port, parsed_ssl = _clean_ldap_host(config['server'])
    port = parsed_port or config['port']
    use_ssl = parsed_ssl if parsed_ssl is not None else config['use_ssl']
    ldap_domain = config['domain']
    base_dn = config['base_dn']
    bind_user = config['bind_user']
    bind_password = config['bind_password']
    req_group = config['required_group']
    admin_group = config['admin_group']
    admin_users = config['admin_users']

    if not host or not base_dn:
        return False, None, None, None, "Не настроены LDAP_SERVER или LDAP_BASE_DN в конфигурации (.env)"

    clean_id = identifier.strip()
    clean_user = clean_id
    if "@" in clean_user:
        clean_user = clean_user.split("@")[0].strip()
    elif "\\" in clean_user:
        clean_user = clean_user.split("\\")[-1].strip()

    domain_short = ldap_domain.split(".")[0].upper() if ldap_domain else ""

    try:
        server = LdapServer(host, port=port, use_ssl=use_ssl, get_info=ALL, connect_timeout=5)
        user_entry = None
        user_dn = None
        user_conn = None

        # Шаг 1: Поиск пользователя через сервисную учетную запись (Search-then-Bind)
        if bind_user and bind_password:
            bind_candidates = [bind_user]
            if domain_short and "\\" not in bind_user and "@" not in bind_user:
                bind_candidates.append(f"{domain_short}\\{bind_user}")
            if ldap_domain and "@" not in bind_user and "\\" not in bind_user:
                bind_candidates.append(f"{bind_user}@{ldap_domain}")

            svc_conn = None
            for b_cand in dict.fromkeys(bind_candidates):
                try:
                    tc = LdapConnection(server, user=b_cand, password=bind_password, auto_bind=True)
                    if tc.bound:
                        svc_conn = tc
                        break
                except Exception:
                    continue

            if svc_conn and svc_conn.bound:
                safe_id = escape_filter_chars(clean_id)
                safe_user = escape_filter_chars(clean_user)
                upn_cand = escape_filter_chars(f"{clean_user}@{ldap_domain}") if ldap_domain else safe_id
                search_filter = (
                    f"(&(objectCategory=person)(objectClass=user)"
                    f"(|(mail={safe_id})(userPrincipalName={safe_id})(userPrincipalName={upn_cand})"
                    f"(sAMAccountName={safe_id})(sAMAccountName={safe_user})))"
                )
                svc_conn.search(
                    search_base=base_dn,
                    search_filter=search_filter,
                    search_scope=SUBTREE,
                    attributes=['distinguishedName', 'sAMAccountName', 'userPrincipalName', 'displayName', 'mail', 'memberOf']
                )
                if not svc_conn.entries:
                    svc_conn.unbind()
                    return False, None, None, None, f"Пользователь «{clean_id}» не найден в Active Directory"

                user_entry = svc_conn.entries[0]
                user_dn = str(user_entry.entry_dn) if hasattr(user_entry, 'entry_dn') else str(user_entry.distinguishedName)
                user_upn = str(user_entry.userPrincipalName) if hasattr(user_entry, 'userPrincipalName') and user_entry.userPrincipalName else None
                user_sam = str(user_entry.sAMAccountName) if hasattr(user_entry, 'sAMAccountName') and user_entry.sAMAccountName else clean_user
                svc_conn.unbind()

                # Шаг 2: Проверяем пароль найденного пользователя
                verify_candidates = [user_dn, user_upn]
                if domain_short:
                    verify_candidates.append(f"{domain_short}\\{user_sam}")
                if ldap_domain:
                    verify_candidates.append(f"{user_sam}@{ldap_domain}")
                verify_candidates.append(user_sam)

                for cand in dict.fromkeys([c for c in verify_candidates if c]):
                    try:
                        tc = LdapConnection(server, user=cand, password=password, auto_bind=True)
                        if tc.bound:
                            user_conn = tc
                            break
                    except Exception:
                        continue

                if not user_conn or not user_conn.bound:
                    return False, None, None, None, "Неверный пароль доменной учетной записи Active Directory"
                user_conn.unbind()

        # Шаг 2 (Fallback): Прямой Bind, если сервисная учетная запись не задана
        if not user_entry:
            direct_candidates = [clean_id]
            if domain_short:
                direct_candidates.append(f"{domain_short}\\{clean_user}")
            if ldap_domain:
                direct_candidates.append(f"{clean_user}@{ldap_domain}")
            direct_candidates.append(clean_user)

            for cand in dict.fromkeys([c for c in direct_candidates if c]):
                try:
                    tc = LdapConnection(server, user=cand, password=password, auto_bind=True)
                    if tc.bound:
                        user_conn = tc
                        break
                except Exception:
                    continue

            if not user_conn or not user_conn.bound:
                return False, None, None, None, "Неверный логин или пароль Active Directory"

            # Читаем атрибуты пользователя под его собственным подключением
            safe_id = escape_filter_chars(clean_id)
            safe_user = escape_filter_chars(clean_user)
            upn_cand = escape_filter_chars(f"{clean_user}@{ldap_domain}") if ldap_domain else safe_id
            search_filter = (
                f"(&(objectCategory=person)(objectClass=user)"
                f"(|(mail={safe_id})(userPrincipalName={safe_id})(userPrincipalName={upn_cand})"
                f"(sAMAccountName={safe_id})(sAMAccountName={safe_user})))"
            )
            user_conn.search(
                search_base=base_dn,
                search_filter=search_filter,
                search_scope=SUBTREE,
                attributes=['distinguishedName', 'sAMAccountName', 'userPrincipalName', 'displayName', 'mail', 'memberOf']
            )
            if user_conn.entries:
                user_entry = user_conn.entries[0]
                user_dn = str(user_entry.entry_dn) if hasattr(user_entry, 'entry_dn') else str(user_entry.distinguishedName)
            user_conn.unbind()

        # Определяем имя пользователя, логин/почту и группы
        display_name = clean_user
        resolved_username = clean_user.lower()
        user_groups = []

        if user_entry:
            if hasattr(user_entry, 'displayName') and user_entry.displayName:
                display_name = str(user_entry.displayName).strip()
            if hasattr(user_entry, 'sAMAccountName') and user_entry.sAMAccountName:
                resolved_username = str(user_entry.sAMAccountName).strip().lower()
            elif hasattr(user_entry, 'mail') and user_entry.mail:
                resolved_username = str(user_entry.mail).strip().lower()
            if hasattr(user_entry, 'memberOf') and user_entry.memberOf:
                user_groups = [str(g).lower() for g in user_entry.memberOf]

        # Шаг 3: Проверка членства в группах AD (включая рекурсивные вложенные группы)
        def is_member_of_group(target_group):
            if not target_group:
                return False
            target_lower = target_group.lower().strip()
            for g in user_groups:
                if target_lower == g or f"cn={target_lower}," in g:
                    return True
            if config['nested_groups'] and user_dn and bind_user and bind_password:
                try:
                    s_conn = LdapConnection(server, user=bind_user, password=bind_password, auto_bind=True)
                    safe_grp = escape_filter_chars(target_group)
                    grp_filter = f"(&(objectCategory=group)(|(cn={safe_grp})(distinguishedName={safe_grp})))"
                    s_conn.search(search_base=base_dn, search_filter=grp_filter, search_scope=SUBTREE, attributes=['distinguishedName'])
                    if s_conn.entries:
                        group_dn = escape_filter_chars(str(s_conn.entries[0].entry_dn if hasattr(s_conn.entries[0], 'entry_dn') else s_conn.entries[0].distinguishedName))
                        safe_user_dn = escape_filter_chars(user_dn)
                        nested_filter = f"(&(objectCategory=person)(objectClass=user)(distinguishedName={safe_user_dn})(memberOf:1.2.840.113556.1.4.1941:={group_dn}))"
                        s_conn.search(search_base=base_dn, search_filter=nested_filter, search_scope=SUBTREE, attributes=['distinguishedName'])
                        is_member = len(s_conn.entries) > 0
                        s_conn.unbind()
                        return is_member
                    s_conn.unbind()
                except Exception:
                    pass
            return False

        # Определение прав администратора
        admin_users_set = build_admin_users_set(admin_users)
        user_candidates = normalize_username_candidates(clean_id, user_entry=user_entry, ldap_domain=ldap_domain)
        user_candidates.add(clean_user.lower())
        user_candidates.add(resolved_username.lower())

        is_admin = bool(user_candidates & admin_users_set)
        if not is_admin and admin_group and is_member_of_group(admin_group):
            is_admin = True

        # Проверка обязательной группы доступа (если настроена)
        if req_group and not is_admin:
            if not is_member_of_group(req_group):
                return False, None, None, None, f"Доступ запрещен: учетная запись не состоит в группе «{req_group}»"

        role = 'admin' if is_admin else 'user'
        return True, resolved_username, role, display_name, None

    except Exception as e:
        return False, None, None, None, f"Ошибка подключения к контроллеру домена LDAP: {str(e)}"
