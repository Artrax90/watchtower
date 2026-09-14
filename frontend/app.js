// Watchtower Frontend Application
(function () {
  const API_BASE = '/api';
  let authToken = localStorage.getItem('watchtower_token') || '';
  let authState = { needsSetup: false, authenticated: false, user: null };
  let monitorsList = [];
  let currentFilter = 'all';
  let searchQuery = '';
  let pollInterval = null;
  let pollIntervalMs = parseInt(localStorage.getItem('watchtower_poll_interval') || '6000', 10);

  // Floating Action Menu state
  let currentActionMonitorId = null;
  let currentActionMonitorPaused = false;

  // DOM Elements
  const body = document.body;
  const themeToggle = document.getElementById('themeToggle');
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  const monitorsTbody = document.getElementById('monitorsTbody');
  const searchInput = document.getElementById('searchInput');
  const floatingActionMenu = document.getElementById('floatingActionMenu');

  // Modals
  const setupModal = document.getElementById('setupModal');
  const loginModal = document.getElementById('loginModal');
  const monitorModal = document.getElementById('monitorModal');
  const diagnosticModal = document.getElementById('diagnosticModal');

  // --- Helpers ---
  function showToast(msg, isSuccess = true) {
    toastMsg.textContent = msg;
    toast.querySelector('svg')?.setAttribute('data-lucide', isSuccess ? 'check' : 'alert-circle');
    toast.classList.add('show');
    lucide.createIcons();
    setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('open');
    closeFloatingMenu();
    lucide.createIcons();
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    const err = modal.querySelector('.alert-box.error');
    if (err) {
      err.textContent = '';
      err.style.display = 'none';
    }
  }

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-backdrop');
      if (modal) closeModal(modal);
    });
  });

  // Modal Backdrop Click (close ONLY if both mousedown and mouseup originated directly on backdrop)
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    let isMouseDownOnBackdrop = false;

    backdrop.addEventListener('mousedown', (e) => {
      isMouseDownOnBackdrop = (e.target === backdrop);
    });

    backdrop.addEventListener('mouseup', (e) => {
      if (isMouseDownOnBackdrop && e.target === backdrop) {
        if (!authState.authenticated && (backdrop.id === 'loginModal' || backdrop.id === 'setupModal')) {
          isMouseDownOnBackdrop = false;
          return;
        }
        closeModal(backdrop);
      }
      isMouseDownOnBackdrop = false;
    });
  });

  // Escape key closes open modals
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.open').forEach((modal) => {
        if (!authState.authenticated && (modal.id === 'loginModal' || modal.id === 'setupModal')) {
          return;
        }
        closeModal(modal);
      });
      closeFloatingMenu();
    }
  });

  // --- Modern Confirmation Modal Helper ---
  let pendingConfirmAction = null;

  function openConfirmModal({
    title = 'Подтверждение удаления',
    bannerTitle = 'Подтвердите удаление',
    bannerSub = 'Это действие нельзя будет отменить.',
    label1 = 'Объект:',
    val1 = '—',
    label2 = '',
    val2 = '',
    btnText = 'Удалить',
    onConfirm
  }) {
    const modal = document.getElementById('confirmModal');
    if (!modal) {
      if (confirm(`${bannerTitle}\n${bannerSub}`)) {
        onConfirm();
      }
      return;
    }

    const titleEl = document.getElementById('confirmModalTitle')?.querySelector('span');
    if (titleEl) titleEl.textContent = title;
    const bTitle = document.getElementById('confirmBannerTitle');
    if (bTitle) bTitle.textContent = bannerTitle;
    const bSub = document.getElementById('confirmBannerSub');
    if (bSub) bSub.textContent = bannerSub;
    const l1 = document.getElementById('confirmLabel1');
    if (l1) l1.textContent = label1;
    const v1 = document.getElementById('confirmVal1');
    if (v1) v1.textContent = val1;

    const row2 = document.getElementById('confirmRow2');
    if (val2 && row2) {
      const l2 = document.getElementById('confirmLabel2');
      if (l2) l2.textContent = label2;
      const v2 = document.getElementById('confirmVal2');
      if (v2) v2.textContent = val2;
      row2.style.display = 'flex';
    } else if (row2) {
      row2.style.display = 'none';
    }

    const btnTextEl = document.getElementById('confirmActionBtnText');
    if (btnTextEl) btnTextEl.textContent = btnText;
    pendingConfirmAction = onConfirm;

    openModal(modal);
    lucide.createIcons();
  }

  document.getElementById('confirmActionBtn')?.addEventListener('click', async () => {
    if (typeof pendingConfirmAction === 'function') {
      const action = pendingConfirmAction;
      pendingConfirmAction = null;
      closeModal(document.getElementById('confirmModal'));
      await action();
    }
  });

  // Theme Management
  if (
    localStorage.getItem('watchtower-theme') === 'dark' ||
    (!localStorage.getItem('watchtower-theme') && matchMedia('(prefers-color-scheme:dark)').matches)
  ) {
    body.classList.add('dark');
  }

  function paintTheme() {
    if (themeToggle) {
      themeToggle.innerHTML = `<i data-lucide="${body.classList.contains('dark') ? 'sun' : 'moon'}"></i>`;
      lucide.createIcons();
    }
  }
  paintTheme();

  themeToggle?.addEventListener('click', () => {
    body.classList.toggle('dark');
    localStorage.setItem('watchtower-theme', body.classList.contains('dark') ? 'dark' : 'light');
    paintTheme();
  });

  document.getElementById('setThemeDark')?.addEventListener('click', () => {
    body.classList.add('dark');
    localStorage.setItem('watchtower-theme', 'dark');
    paintTheme();
    showToast('Тёмная тема включена');
  });

  document.getElementById('setThemeLight')?.addEventListener('click', () => {
    body.classList.remove('dark');
    localStorage.setItem('watchtower-theme', 'light');
    paintTheme();
    showToast('Светлая тема включена');
  });

  // --- API Client ---
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  // --- Authentication Flow & Role-Based Permissions ---
  function applyRolePermissions() {
    const isAuth = authState.authenticated;
    const isAdmin = isAuth && authState.user?.role === 'admin';
    const isViewer = isAuth && authState.user?.role === 'viewer';

    // Add Monitor buttons (in monitors view and modals)
    document.querySelectorAll('.add-monitor-btn, #addMonitor').forEach((btn) => {
      btn.style.display = isAdmin ? 'inline-flex' : 'none';
    });

    // Notifications button in header
    const notificationsBtn = document.getElementById('notificationsBtn');
    if (notificationsBtn) {
      notificationsBtn.style.display = isAdmin ? 'grid' : 'none';
    }

    // Sidebar links
    const navAlerts = document.getElementById('navAlerts');
    if (navAlerts) {
      navAlerts.style.display = isAdmin ? 'flex' : 'none';
    }

    const navAdmin = document.getElementById('navAdmin');
    if (navAdmin) {
      if (isAdmin) {
        navAdmin.style.display = 'flex';
        navAdmin.innerHTML = `<i data-lucide="shield"></i>Администрирование`;
      } else if (isViewer) {
        navAdmin.style.display = 'none';
      } else {
        navAdmin.style.display = 'flex';
        navAdmin.innerHTML = `<i data-lucide="shield"></i>Администрирование`;
      }
    }

    // Admin Modal layout based on role
    const adminSection = document.getElementById('adminManagementSection');
    const viewerSection = document.getElementById('viewerInfoSection');
    const admRoleBadge = document.getElementById('admRoleBadge');

    if (adminSection && viewerSection && admRoleBadge) {
      if (isAdmin) {
        adminSection.style.display = 'block';
        viewerSection.style.display = 'none';
        admRoleBadge.className = 'role-badge admin';
        admRoleBadge.innerHTML = `<i data-lucide="shield-check"></i> Администратор`;
      } else {
        adminSection.style.display = 'none';
        viewerSection.style.display = 'block';
        admRoleBadge.className = 'role-badge viewer';
        admRoleBadge.innerHTML = `<i data-lucide="eye"></i> Наблюдатель`;
      }
    }

    // Bottom user button
    const userName = document.getElementById('userName');
    const userAvatar = document.getElementById('userAvatar');
    const userIcon = document.getElementById('userIcon');

    if (isAuth && authState.user) {
      userName.innerHTML = `${escapeHtml(authState.user.username)} <small style="display:block;font-size:8.5px;color:var(--muted);font-weight:normal">${isAdmin ? 'Администратор' : 'Наблюдатель'}</small>`;
      userAvatar.textContent = authState.user.username.slice(0, 2).toUpperCase();
      userIcon.setAttribute('data-lucide', isAdmin ? 'shield-check' : 'eye');

      document.getElementById('admUsername').textContent = authState.user.username;
      document.getElementById('admAvatar').textContent = authState.user.username.slice(0, 2).toUpperCase();
      document.getElementById('admUserSub').textContent = isAdmin ? 'Права: Полный доступ' : 'Права: Только просмотр';
    } else {
      userName.textContent = 'Вход в систему';
      userAvatar.textContent = 'A';
      userIcon.setAttribute('data-lucide', 'log-in');
    }

    lucide.createIcons();
  }

  async function checkAuthStatus() {
    try {
      const status = await api('/auth/status');
      authState = status;

      if (status.needsSetup) {
        body.classList.add('not-authenticated');
        closeModal(loginModal);
        openModal(setupModal);
        document.getElementById('userName').textContent = 'Первый запуск';
      } else if (!status.authenticated) {
        body.classList.add('not-authenticated');
        closeModal(setupModal);
        openModal(loginModal);
      } else {
        body.classList.remove('not-authenticated');
        closeModal(loginModal);
        closeModal(setupModal);
        applyRolePermissions();
      }
    } catch (err) {
      console.error('Failed to fetch auth status:', err);
      body.classList.add('not-authenticated');
      openModal(loginModal);
    }
  }

  document.getElementById('userBtn')?.addEventListener('click', () => {
    if (authState.authenticated) {
      navigateTo('/admin');
    } else {
      openModal(loginModal);
    }
  });

  // Setup Form
  document.getElementById('setupForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('setupUsername').value.trim();
    const p = document.getElementById('setupPassword').value;
    const pc = document.getElementById('setupPasswordConfirm').value;
    const errBox = document.getElementById('setupError');

    if (p !== pc) {
      errBox.textContent = 'Пароли не совпадают!';
      errBox.style.display = 'block';
      return;
    }

    try {
      const res = await api('/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ username: u, password: p })
      });
      authToken = res.token;
      localStorage.setItem('watchtower_token', res.token);
      body.classList.remove('not-authenticated');
      closeModal(setupModal);
      showToast('Администратор создан и авторизован!');
      await checkAuthStatus();
      await loadAllData();
      navigateTo(window.location.pathname || '/overview');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  // Login Form
  document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;
    const errBox = document.getElementById('loginError');

    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: u, password: p })
      });
      authToken = res.token;
      localStorage.setItem('watchtower_token', res.token);
      body.classList.remove('not-authenticated');
      closeModal(loginModal);
      showToast(`Добро пожаловать, ${res.user.username}!`);
      await checkAuthStatus();
      await loadAllData();
      navigateTo(window.location.pathname || '/overview');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  // User Management Functions
  async function loadAdminUsers() {
    const container = document.getElementById('usersListContainer');
    if (!container || authState.user?.role !== 'admin') return;

    try {
      const res = await api('/auth/users');
      const users = res.users || [];
      const adminCount = users.filter((u) => u.role === 'admin').length;

      if (users.length === 0) {
        container.innerHTML = `<div style="padding:12px;text-align:center;color:var(--muted);font-size:11px">Нет пользователей</div>`;
        return;
      }

      container.innerHTML = users
        .map((u) => {
          const isSelf = u.id === authState.user?.id;
          const isLastAdmin = u.role === 'admin' && adminCount <= 1;
          const canDelete = !isSelf && !isLastAdmin;
          const disableTitle = isSelf ? 'Текущая учетная запись' : isLastAdmin ? 'Единственный администратор' : '';

          const roleBadge =
            u.role === 'admin'
              ? `<span class="role-badge admin"><i data-lucide="shield-check"></i> Администратор</span>`
              : `<span class="role-badge viewer"><i data-lucide="eye"></i> Наблюдатель</span>`;

          const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';

          return `
            <div class="user-row">
              <div class="user-row-info">
                <span style="width:28px;height:28px;border-radius:50%;background:var(--soft);color:var(--primary);display:grid;place-items:center;font-weight:700;font-size:11px">
                  ${escapeHtml(u.username.slice(0, 2).toUpperCase())}
                </span>
                <div>
                  <div style="display:flex;align-items:center;gap:6px">
                    <b>${escapeHtml(u.username)}</b>
                    ${roleBadge}
                  </div>
                  <small>Добавлен: ${dateStr}</small>
                </div>
              </div>
              <div>
                <button class="btn-icon-del" ${canDelete ? `onclick="window.deleteUser('${u.id}', '${escapeHtml(u.username)}')"` : `disabled title="${disableTitle}"`}>
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      lucide.createIcons();
    } catch (err) {
      container.innerHTML = `<div class="alert-box error" style="display:block">${err.message}</div>`;
    }
  }

  window.deleteUser = function (id, username) {
    openConfirmModal({
      title: 'Удаление пользователя',
      bannerTitle: `Удалить пользователя «${username}»?`,
      bannerSub: 'Пользователь больше не сможет входить в систему Watchtower.',
      label1: 'Пользователь:',
      val1: username,
      val2: '',
      btnText: 'Удалить пользователя',
      onConfirm: async () => {
        try {
          await api(`/auth/users/${id}`, { method: 'DELETE' });
          showToast(`Пользователь «${username}» удалён`);
          await loadAdminUsers();
        } catch (err) {
          showToast(`Ошибка: ${err.message}`, false);
        }
      }
    });
  };

  // Create User Form inside Admin Modal
  document.getElementById('createUserForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newUserRole').value;
    const errBox = document.getElementById('newUserError');
    const succBox = document.getElementById('newUserSuccess');

    try {
      await api('/auth/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role })
      });
      succBox.textContent = `Пользователь "${username}" успешно создан!`;
      succBox.style.display = 'block';
      errBox.style.display = 'none';
      document.getElementById('createUserForm').reset();
      setTimeout(() => (succBox.style.display = 'none'), 3500);
      showToast(`Пользователь "${username}" добавлен`);
      await loadAdminUsers();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      succBox.style.display = 'none';
    }
  });

  // Admin Logout Button
  document.getElementById('admLogoutBtn')?.addEventListener('click', async () => {
    if (confirm('Выйти из учетной записи?')) {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      authToken = '';
      localStorage.removeItem('watchtower_token');
      closeModal(adminModal);
      showToast('Вы вышли из системы');
      await checkAuthStatus();
      loadAllData();
    }
  });

  // --- Multi-check Checkbox Card Interactions ---
  function updateCheckCardStates() {
    const checks = [
      { id: 'checkOptHttp', cardId: 'cardOptHttp' },
      { id: 'checkOptSsl', cardId: 'cardOptSsl' },
      { id: 'checkOptPing', cardId: 'cardOptPing' },
      { id: 'checkOptPort', cardId: 'cardOptPort' },
      { id: 'checkOptDns', cardId: 'cardOptDns' }
    ];

    checks.forEach(({ id, cardId }) => {
      const el = document.getElementById(id);
      const card = document.getElementById(cardId);
      if (el && card) {
        if (el.checked) card.classList.add('checked');
        else card.classList.remove('checked');
      }
    });

    const isHttp = document.getElementById('checkOptHttp')?.checked;
    const isSsl = document.getElementById('checkOptSsl')?.checked;
    const isPort = document.getElementById('checkOptPort')?.checked;

    document.getElementById('sslGroup').style.display = isSsl ? 'block' : 'none';
    document.getElementById('portGroup').style.display = isPort ? 'block' : 'none';
    document.getElementById('keywordGroup').style.display = isHttp ? 'block' : 'none';
  }

  ['checkOptHttp', 'checkOptSsl', 'checkOptPing', 'checkOptPort', 'checkOptDns'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updateCheckCardStates);
  });

  // Add Monitor Button Handler
  document.getElementById('addMonitor')?.addEventListener('click', () => {
    if (!authState.authenticated) {
      showToast('Требуется авторизация администратора', false);
      openModal(loginModal);
      return;
    }
    document.getElementById('monitorForm').reset();
    document.getElementById('editMonitorId').value = '';
    document.getElementById('monitorModalTitle').textContent = 'Добавить монитор';

    // Defaults: HTTP + SSL checked
    document.getElementById('checkOptHttp').checked = true;
    document.getElementById('checkOptSsl').checked = true;
    document.getElementById('checkOptPing').checked = false;
    document.getElementById('checkOptPort').checked = false;
    document.getElementById('checkOptDns').checked = false;
    updateCheckCardStates();

    openModal(monitorModal);
  });

  // Save Monitor Form
  document.getElementById('monitorForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editMonitorId').value;
    const name = document.getElementById('monitorName').value.trim();
    const target = document.getElementById('monitorTarget').value.trim();
    const port = document.getElementById('monitorPort').value;
    const interval = document.getElementById('monitorInterval').value;
    const timeout = document.getElementById('monitorTimeout').value;
    const sslAlertDays = document.getElementById('monitorSSLAlertDays').value;
    const keyword = document.getElementById('monitorKeyword').value.trim();
    const errBox = document.getElementById('monitorError');

    // Collect selected check types
    const selectedTypes = [];
    if (document.getElementById('checkOptHttp').checked) selectedTypes.push('http');
    if (document.getElementById('checkOptSsl').checked) selectedTypes.push('ssl');
    if (document.getElementById('checkOptPing').checked) selectedTypes.push('ping');
    if (document.getElementById('checkOptPort').checked) selectedTypes.push('port');
    if (document.getElementById('checkOptDns').checked) selectedTypes.push('dns');

    if (selectedTypes.length === 0) {
      errBox.textContent = 'Пожалуйста, выберите хотя бы один параметр проверки!';
      errBox.style.display = 'block';
      return;
    }

    const hasSsl = selectedTypes.includes('ssl');
    const payload = {
      name,
      type: selectedTypes.join(','),
      target,
      port: port ? parseInt(port, 10) : null,
      interval: parseInt(interval, 10),
      timeout: parseInt(timeout, 10),
      check_ssl: hasSsl ? 1 : 0,
      ssl_alert_days: parseInt(sslAlertDays, 10),
      keyword: keyword || null
    };

    try {
      if (id) {
        await api(`/monitors/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Монитор обновлён');
      } else {
        await api('/monitors', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Монитор добавлен и запущен');
      }
      closeModal(monitorModal);
      await loadMonitors();
      await loadStats();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });

  // --- SPA Router & View Management ---
  function navigateTo(path, pushState = true) {
    let route = (path || '/overview').toLowerCase().trim();
    if (route === '/' || route === '#dashboard' || route === '#overview') route = '/overview';
    else if (route === '#monitors' || route === '/monitor') route = '/monitors';
    else if (route === '#incidents' || route === '/incident') route = '/incidents';
    else if (route === '#alerts' || route === '/alert') route = '/alerts';
    else if (route === '#admin') route = '/admin';
    else if (route === '#settings') route = '/settings';
    else if (route.startsWith('#')) route = '/' + route.slice(1);

    // Allowed routes
    const validRoutes = ['/overview', '/monitors', '/incidents', '/alerts', '/admin', '/settings'];
    if (!validRoutes.includes(route)) {
      route = '/overview';
    }

    // Update body route class
    document.body.className = document.body.className
      .split(' ')
      .filter((c) => !c.startsWith('route-'))
      .join(' ')
      .trim();
    document.body.classList.add(`route-${route.slice(1)}`);

    // Hide all intros
    const intros = ['introOverview', 'introMonitors', 'introIncidents', 'introAlerts', 'introAdmin', 'introSettings'];
    intros.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Hide all view sections
    const sections = ['sectionSummary', 'sectionMonitors', 'sectionBottomGrid', 'sectionAlerts', 'sectionAdmin', 'sectionSettings'];
    sections.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Reset active nav links
    document.querySelectorAll('aside nav a').forEach((a) => a.classList.remove('active'));

    const crumbTitle = document.getElementById('crumbTitle');
    const crumbWorkspace = document.getElementById('crumbWorkspace');

    if (route === '/overview') {
      const intro = document.getElementById('introOverview');
      if (intro) intro.style.display = 'flex';
      const sum = document.getElementById('sectionSummary');
      if (sum) sum.style.display = 'grid';
      const mon = document.getElementById('sectionMonitors');
      if (mon) mon.style.display = 'block';
      const bg = document.getElementById('sectionBottomGrid');
      if (bg) bg.style.display = 'grid';
      document.getElementById('navOverview')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Обзор';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Production';
    } else if (route === '/monitors') {
      const intro = document.getElementById('introMonitors');
      if (intro) intro.style.display = 'flex';
      const mon = document.getElementById('sectionMonitors');
      if (mon) mon.style.display = 'block';
      document.getElementById('navMonitors')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Мониторы';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Все сервисы';
    } else if (route === '/incidents') {
      const intro = document.getElementById('introIncidents');
      if (intro) intro.style.display = 'flex';
      const bg = document.getElementById('sectionBottomGrid');
      if (bg) bg.style.display = 'grid';
      document.getElementById('navIncidents')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Инциденты';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Журнал сбоев';
      if (authState.authenticated) {
        loadIncidents();
      }
    } else if (route === '/alerts') {
      const intro = document.getElementById('introAlerts');
      if (intro) intro.style.display = 'flex';
      const al = document.getElementById('sectionAlerts');
      if (al) al.style.display = 'block';
      document.getElementById('navAlerts')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Настройки';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Оповещения';
      if (authState.authenticated) {
        loadNotificationsConfig();
      }
    } else if (route === '/admin') {
      const intro = document.getElementById('introAdmin');
      if (intro) intro.style.display = 'flex';
      const adm = document.getElementById('sectionAdmin');
      if (adm) adm.style.display = 'block';
      document.getElementById('navAdmin')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Администрирование';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Пользователи';
      if (authState.authenticated && authState.user?.role === 'admin') {
        loadAdminUsers();
      }
    } else if (route === '/settings') {
      const intro = document.getElementById('introSettings');
      if (intro) intro.style.display = 'flex';
      const set = document.getElementById('sectionSettings');
      if (set) set.style.display = 'block';
      document.getElementById('navSettings')?.classList.add('active');
      if (crumbTitle) crumbTitle.textContent = 'Настройки';
      if (crumbWorkspace) crumbWorkspace.textContent = 'Параметры';
    }

    if (pushState && window.location.pathname !== route) {
      window.history.pushState({ route }, '', route);
    }

    applyRolePermissions();
    lucide.createIcons();
  }

  // Bind all sidebar and brand navigation links
  document.querySelectorAll('aside nav a, aside .brand').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href) {
        navigateTo(href);
      }
    });
  });

  window.addEventListener('popstate', () => {
    navigateTo(window.location.pathname, false);
  });

  // Header quick alerts button
  document.getElementById('notificationsBtn')?.addEventListener('click', () => {
    navigateTo('/alerts');
  });

  // Tab switching in Notifications View
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => (c.style.display = 'none'));
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.style.display = 'block';
    });
  });

  // Logout Button in Admin View
  document.getElementById('admLogoutBtn')?.addEventListener('click', () => {
    authToken = '';
    localStorage.removeItem('watchtower_token');
    authState = { needsSetup: false, authenticated: false, user: null };
    body.classList.add('not-authenticated');
    openModal(loginModal);
    showToast('Вы вышли из учетной записи');
  });

  document.getElementById('workspaceBtn')?.addEventListener('click', () => {
    showToast('Текущее рабочее пространство: Production');
  });

  // Settings Poll interval
  document.getElementById('setPollInterval')?.addEventListener('change', (e) => {
    pollIntervalMs = parseInt(e.target.value, 10);
    localStorage.setItem('watchtower_poll_interval', pollIntervalMs.toString());
    clearInterval(pollInterval);
    pollInterval = setInterval(loadAllData, pollIntervalMs);
    showToast(`Интервал автообновления: ${pollIntervalMs / 1000} сек`);
  });

  // --- Floating Action Menu (Decoupled, zero table scrollbars) ---
  function closeFloatingMenu() {
    floatingActionMenu.classList.remove('show');
    currentActionMonitorId = null;
  }

  window.openActionMenu = function (e, monitorId) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const monitor = monitorsList.find((m) => m.id === monitorId);
    if (!monitor) return;

    currentActionMonitorId = monitorId;
    currentActionMonitorPaused = monitor.is_paused === 1;

    document.getElementById('famPauseText').textContent = currentActionMonitorPaused ? 'Возобновить' : 'На паузу';
    document.querySelector('#famPauseBtn svg')?.setAttribute('data-lucide', currentActionMonitorPaused ? 'play' : 'pause');

    // Calculate fixed viewport coordinates
    const rect = btn.getBoundingClientRect();
    const menuWidth = 155;
    const menuHeight = 145;

    let top = rect.bottom + 4;
    let left = rect.right - menuWidth;

    // Boundary check: if opening near bottom, flip upwards
    if (top + menuHeight > window.innerHeight) {
      top = Math.max(10, rect.top - menuHeight - 4);
    }
    // Boundary check left
    if (left < 10) left = 10;

    floatingActionMenu.style.top = `${top}px`;
    floatingActionMenu.style.left = `${left}px`;
    floatingActionMenu.classList.add('show');
    lucide.createIcons();
  };

  document.addEventListener('click', (e) => {
    if (!floatingActionMenu.contains(e.target)) {
      closeFloatingMenu();
    }
  });

  window.addEventListener('scroll', closeFloatingMenu, true);
  window.addEventListener('resize', closeFloatingMenu);

  document.getElementById('famCheckBtn')?.addEventListener('click', async () => {
    const id = currentActionMonitorId;
    closeFloatingMenu();
    if (!authState.authenticated) {
      showToast('Требуется авторизация', false);
      openModal(loginModal);
      return;
    }
    showToast('Проверка запущена...');
    try {
      await api(`/monitors/${id}/check`, { method: 'POST' });
      await loadMonitors();
      await loadStats();
      showToast('Проверка завершена');
    } catch (err) {
      showToast(`Ошибка: ${err.message}`, false);
    }
  });

  document.getElementById('famPauseBtn')?.addEventListener('click', async () => {
    const id = currentActionMonitorId;
    closeFloatingMenu();
    if (!authState.authenticated) {
      showToast('Требуется авторизация', false);
      openModal(loginModal);
      return;
    }
    try {
      const res = await api(`/monitors/${id}/pause`, { method: 'POST' });
      showToast(res.is_paused ? 'Монитор на паузе' : 'Монитор возобновлен');
      await loadMonitors();
      await loadStats();
    } catch (err) {
      showToast(`Ошибка: ${err.message}`, false);
    }
  });

  document.getElementById('famEditBtn')?.addEventListener('click', () => {
    const id = currentActionMonitorId;
    closeFloatingMenu();
    if (!authState.authenticated) {
      showToast('Требуется авторизация', false);
      openModal(loginModal);
      return;
    }
    const monitor = monitorsList.find((m) => m.id === id);
    if (!monitor) return;

    document.getElementById('editMonitorId').value = monitor.id;
    document.getElementById('monitorName').value = monitor.name;
    document.getElementById('monitorTarget').value = monitor.target;
    document.getElementById('monitorPort').value = monitor.port || '';
    document.getElementById('monitorInterval').value = monitor.interval;
    document.getElementById('monitorTimeout').value = monitor.timeout;
    document.getElementById('monitorSSLAlertDays').value = monitor.ssl_alert_days || 14;
    document.getElementById('monitorKeyword').value = monitor.keyword || '';

    // Parse multi-types
    const types = (monitor.type || 'http').toLowerCase().split(',');
    document.getElementById('checkOptHttp').checked = types.includes('http') || types.includes('https');
    document.getElementById('checkOptSsl').checked = types.includes('ssl') || monitor.check_ssl === 1;
    document.getElementById('checkOptPing').checked = types.includes('ping');
    document.getElementById('checkOptPort').checked = types.includes('port') || types.includes('tcp');
    document.getElementById('checkOptDns').checked = types.includes('dns');

    updateCheckCardStates();
    document.getElementById('monitorModalTitle').textContent = 'Редактировать монитор';
    openModal(monitorModal);
  });

  document.getElementById('famDeleteBtn')?.addEventListener('click', () => {
    const id = currentActionMonitorId;
    closeFloatingMenu();
    if (!authState.authenticated) {
      showToast('Требуется авторизация', false);
      openModal(loginModal);
      return;
    }
    const monitor = monitorsList.find((m) => m.id === id);
    if (!monitor) return;

    openConfirmModal({
      title: 'Удаление монитора',
      bannerTitle: `Удалить монитор «${monitor.name}»?`,
      bannerSub: 'Все накопленные проверки, история аптайма и статистика будут безвозвратно удалены.',
      label1: 'Монитор:',
      val1: monitor.name,
      label2: 'Адрес цели:',
      val2: monitor.target + (monitor.port ? `:${monitor.port}` : ''),
      btnText: 'Удалить навсегда',
      onConfirm: async () => {
        try {
          await api(`/monitors/${id}`, { method: 'DELETE' });
          showToast(`Монитор «${monitor.name}» удалён`);
          await loadMonitors();
          await loadStats();
        } catch (err) {
          showToast(`Ошибка удаления: ${err.message}`, false);
        }
      }
    });
  });

  // --- Telegram Proxy Form Management ---
  function updateTgProxyFieldsVisibility() {
    const pType = document.getElementById('tgProxyType')?.value || 'none';
    const portGroup = document.getElementById('tgProxyPortGroup');
    const fieldsBox = document.getElementById('tgProxyFields');
    const portInput = document.getElementById('tgProxyPort');

    if (pType === 'none') {
      if (portGroup) portGroup.style.display = 'none';
      if (fieldsBox) fieldsBox.style.display = 'none';
    } else {
      if (portGroup) portGroup.style.display = 'block';
      if (fieldsBox) fieldsBox.style.display = 'block';
      if (portInput && !portInput.value) {
        portInput.placeholder = pType.startsWith('socks') ? '1080' : '8080';
      }
    }
  }

  document.getElementById('tgProxyType')?.addEventListener('change', updateTgProxyFieldsVisibility);

  function getTgProxyConfig() {
    const proxyType = document.getElementById('tgProxyType')?.value || 'none';
    if (proxyType === 'none') {
      return { proxyType: 'none', proxyUrl: undefined };
    }

    let host = (document.getElementById('tgProxyHost')?.value || '').trim();
    let port = (document.getElementById('tgProxyPort')?.value || '').trim();
    const user = (document.getElementById('tgProxyUser')?.value || '').trim();
    const pass = (document.getElementById('tgProxyPass')?.value || '').trim();

    if (!host) {
      return { proxyType: 'none', proxyUrl: undefined };
    }

    // Strip leading protocol if pasted by user (e.g. "socks5://1.2.3.4:1080")
    host = host.replace(/^(socks5h?|socks4a?|https?):\/\//i, '');
    // If user entered user:pass@host
    if (host.includes('@')) {
      const parts = host.split('@');
      host = parts[1];
    }
    // If user entered host:port
    if (host.includes(':')) {
      const [h, p] = host.split(':');
      host = h;
      if (!port && p) {
        port = p;
      }
    }

    if (!port) {
      port = proxyType.startsWith('socks') ? '1080' : '8080';
    }

    let auth = '';
    if (user || pass) {
      auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    }
    // Use socks5h or socks4a protocol to ensure remote DNS resolution
    const actualProtocol = proxyType === 'socks5' ? 'socks5h' : proxyType === 'socks4' ? 'socks4a' : proxyType;
    const proxyUrl = `${actualProtocol}://${auth}${host}:${port}`;
    return {
      proxyType,
      proxyHost: host,
      proxyPort: port,
      proxyUser: user,
      proxyPass: pass,
      proxyUrl
    };
  }

  // --- Notification settings ---
  async function loadNotificationsConfig() {
    try {
      const res = await api('/notifications');
      const tg = res.channels?.find((c) => c.type === 'telegram');
      const max = res.channels?.find((c) => c.type === 'max');

      if (tg) {
        document.getElementById('tgEnabled').checked = tg.is_enabled === 1;
        document.getElementById('tgBotToken').value = tg.config.botToken || '';
        document.getElementById('tgChatId').value = tg.config.chatId || '';

        const typeEl = document.getElementById('tgProxyType');
        const hostEl = document.getElementById('tgProxyHost');
        const portEl = document.getElementById('tgProxyPort');
        const userEl = document.getElementById('tgProxyUser');
        const passEl = document.getElementById('tgProxyPass');

        if (tg.config.proxyType && tg.config.proxyType !== 'none') {
          if (typeEl) typeEl.value = tg.config.proxyType;
          if (hostEl) hostEl.value = tg.config.proxyHost || '';
          if (portEl) portEl.value = tg.config.proxyPort || '';
          if (userEl) userEl.value = tg.config.proxyUser || '';
          if (passEl) passEl.value = tg.config.proxyPass || '';
        } else if (tg.config.proxyUrl) {
          try {
            const url = new URL(tg.config.proxyUrl);
            const proto = url.protocol.replace(':', '');
            if (typeEl) typeEl.value = proto;
            if (hostEl) hostEl.value = url.hostname || '';
            if (portEl) portEl.value = url.port || '';
            if (userEl) userEl.value = decodeURIComponent(url.username || '');
            if (passEl) passEl.value = decodeURIComponent(url.password || '');
          } catch {
            if (typeEl) typeEl.value = 'socks5';
            if (hostEl) hostEl.value = tg.config.proxyUrl;
          }
        } else {
          if (typeEl) typeEl.value = 'none';
        }
        updateTgProxyFieldsVisibility();
      }
      if (max) {
        document.getElementById('maxEnabled').checked = max.is_enabled === 1;
        document.getElementById('maxBotToken').value = max.config.botToken || '';
        document.getElementById('maxChatId').value = max.config.chatId || '';
      }
    } catch (err) {
      console.error('Error loading notification channels:', err);
    }
  }

  document.getElementById('tgForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('tgBotToken').value.trim();
    const chatId = document.getElementById('tgChatId').value.trim();
    const enabled = document.getElementById('tgEnabled').checked ? 1 : 0;
    const proxyCfg = getTgProxyConfig();
    const notifError = document.getElementById('notifError');
    const notifSuccess = document.getElementById('notifSuccess');

    try {
      await api('/notifications', {
        method: 'POST',
        body: JSON.stringify({
          id: 'telegram-default',
          type: 'telegram',
          name: 'Telegram Alerts',
          is_enabled: enabled,
          config: { botToken: token, chatId, ...proxyCfg }
        })
      });
      notifSuccess.textContent = 'Настройки Telegram успешно сохранены!';
      notifSuccess.style.display = 'block';
      notifError.style.display = 'none';
      setTimeout(() => (notifSuccess.style.display = 'none'), 3000);
      showToast('Telegram канал сохранен');
    } catch (err) {
      notifError.textContent = err.message;
      notifError.style.display = 'block';
      notifSuccess.style.display = 'none';
    }
  });

  document.getElementById('testProxyBtn')?.addEventListener('click', async () => {
    const proxyCfg = getTgProxyConfig();
    const notifError = document.getElementById('notifError');
    const notifSuccess = document.getElementById('notifSuccess');

    if (proxyCfg.proxyType === 'none' || !proxyCfg.proxyUrl) {
      alert('Сначала выберите тип прокси и заполните адрес сервера (хост)');
      return;
    }

    try {
      showToast('Проверка прокси...');
      const res = await api('/notifications/test-proxy', {
        method: 'POST',
        body: JSON.stringify({ proxyUrl: proxyCfg.proxyUrl })
      });

      if (res.success) {
        notifSuccess.textContent = `✅ Прокси работает! Соединение с Telegram (api.telegram.org) установлено за ${res.latency} мс.`;
        notifSuccess.style.display = 'block';
        notifError.style.display = 'none';
        showToast(`Прокси работает (${res.latency} мс)`);
        setTimeout(() => (notifSuccess.style.display = 'none'), 4500);
      } else {
        notifError.textContent = `❌ Ошибка прокси: ${res.error}`;
        notifError.style.display = 'block';
        notifSuccess.style.display = 'none';
      }
    } catch (err) {
      notifError.textContent = `❌ Ошибка проверки: ${err.message}`;
      notifError.style.display = 'block';
      notifSuccess.style.display = 'none';
    }
  });

  document.getElementById('testTgBtn')?.addEventListener('click', async () => {
    const token = document.getElementById('tgBotToken').value.trim();
    const chatId = document.getElementById('tgChatId').value.trim();
    const proxyCfg = getTgProxyConfig();
    const notifError = document.getElementById('notifError');
    const notifSuccess = document.getElementById('notifSuccess');

    if (!token || !chatId) {
      alert('Заполните Bot Token и Chat ID перед отправкой теста!');
      return;
    }

    try {
      showToast('Отправка теста в Telegram...');
      const res = await api('/notifications/test', {
        method: 'POST',
        body: JSON.stringify({
          type: 'telegram',
          config: { botToken: token, chatId, ...proxyCfg }
        })
      });
      if (res.success) {
        notifSuccess.textContent = '✅ Тестовое сообщение доставлено в Telegram!';
        notifSuccess.style.display = 'block';
        notifError.style.display = 'none';
        setTimeout(() => (notifSuccess.style.display = 'none'), 4500);
      } else {
        notifError.textContent = `Ошибка Telegram: ${res.error}`;
        notifError.style.display = 'block';
        notifSuccess.style.display = 'none';
      }
    } catch (err) {
      notifError.textContent = err.message;
      notifError.style.display = 'block';
    }
  });

  document.getElementById('maxForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('maxBotToken').value.trim();
    const chatId = document.getElementById('maxChatId').value.trim();
    const enabled = document.getElementById('maxEnabled').checked ? 1 : 0;
    const notifError = document.getElementById('notifError');
    const notifSuccess = document.getElementById('notifSuccess');

    try {
      await api('/notifications', {
        method: 'POST',
        body: JSON.stringify({
          id: 'max-default',
          type: 'max',
          name: 'MAX Messenger Alerts',
          is_enabled: enabled,
          config: { botToken: token, chatId }
        })
      });
      notifSuccess.textContent = 'Настройки MAX Messenger успешно сохранены!';
      notifSuccess.style.display = 'block';
      notifError.style.display = 'none';
      setTimeout(() => (notifSuccess.style.display = 'none'), 3000);
      showToast('MAX Messenger канал сохранен');
    } catch (err) {
      notifError.textContent = err.message;
      notifError.style.display = 'block';
      notifSuccess.style.display = 'none';
    }
  });

  document.getElementById('testMaxBtn')?.addEventListener('click', async () => {
    const token = document.getElementById('maxBotToken').value.trim();
    const chatId = document.getElementById('maxChatId').value.trim();
    const notifError = document.getElementById('notifError');
    const notifSuccess = document.getElementById('notifSuccess');

    if (!token || !chatId) {
      alert('Заполните MAX Bot Token и Chat ID перед отправкой теста!');
      return;
    }

    try {
      showToast('Отправка теста в MAX Messenger...');
      const res = await api('/notifications/test', {
        method: 'POST',
        body: JSON.stringify({
          type: 'max',
          config: { botToken: token, chatId }
        })
      });
      if (res.success) {
        notifSuccess.textContent = '✅ Тестовое сообщение доставлено в MAX Messenger!';
        notifSuccess.style.display = 'block';
        notifError.style.display = 'none';
      } else {
        notifError.textContent = `Ошибка MAX Messenger: ${res.error}`;
        notifError.style.display = 'block';
        notifSuccess.style.display = 'none';
      }
    } catch (err) {
      notifError.textContent = err.message;
      notifError.style.display = 'block';
    }
  });

  // --- Rendering Monitors Table ---
  async function loadMonitors() {
    try {
      const res = await api('/monitors');
      monitorsList = res.monitors || [];
      renderMonitorsTable();
      updateGroupCounts();
    } catch (err) {
      console.error('Error fetching monitors:', err);
    }
  }

  function getIconForTypes(typeStr) {
    const types = (typeStr || 'http').toLowerCase();
    if (types.includes('http')) return { icon: 'globe-2', cls: 'api' };
    if (types.includes('port') || types.includes('tcp')) return { icon: 'database', cls: 'db' };
    if (types.includes('ping')) return { icon: 'activity', cls: 'cdn' };
    if (types.includes('dns')) return { icon: 'network', cls: 'auth' };
    return { icon: 'globe-2', cls: 'api' };
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp || timestamp === 0) return 'ещё не проверялся';
    const sec = Math.round((Date.now() - timestamp) / 1000);
    if (sec < 10) return 'только что';
    if (sec < 60) return `${sec} сек назад`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} мин назад`;
    const hours = Math.round(min / 60);
    return `${hours} ч назад`;
  }

  // --- Diagnostic Badge Check ---
  let currentDiagMonitorId = null;
  let currentDiagType = null;

  window.runBadgeCheck = async function (e, monitorId, type) {
    if (e) e.stopPropagation();
    const monitor = monitorsList.find((m) => m.id === monitorId);
    if (!monitor) return;

    currentDiagMonitorId = monitorId;
    currentDiagType = type;

    const modal = document.getElementById('diagnosticModal');
    const loading = document.getElementById('diagLoadingState');
    const result = document.getElementById('diagResultState');
    const title = document.getElementById('diagModalTitle');

    title.textContent = `🔍 Экспресс-проверка: ${type.toUpperCase()}`;
    loading.style.display = 'block';
    result.style.display = 'none';
    openModal(modal);

    try {
      const res = await api(`/monitors/${monitorId}/test-check`, {
        method: 'POST',
        body: JSON.stringify({ type })
      });

      const check = res.result;
      document.getElementById('diagMonitorName').textContent = monitor.name;
      document.getElementById('diagMonitorTarget').textContent = monitor.target + (monitor.port ? `:${monitor.port}` : '');
      document.getElementById('diagCheckType').textContent = check.type;
      const diagTextEl = document.getElementById('diagDetailsText');
      const detailsVal = check.details || (check.status === 'online' ? 'Проверка успешно завершена' : check.error || 'Ошибка');
      const errForHelp = check.error || (check.status !== 'online' ? detailsVal : '');
      diagTextEl.innerHTML = escapeHtml(detailsVal) + (errForHelp ? ` ${renderErrorHelpBtn(errForHelp)}` : '');

      const ipRow = document.getElementById('diagIpRow');
      const ipVal = document.getElementById('diagIpValue');
      if (check.ip) {
        ipVal.textContent = check.ip;
        ipRow.style.display = 'block';
      } else {
        ipRow.style.display = 'none';
      }

      const banner = document.getElementById('diagBanner');
      const bannerTitle = document.getElementById('diagBannerTitle');
      const bannerSub = document.getElementById('diagBannerSubtitle');
      const bannerIcon = document.getElementById('diagBannerIcon');

      if (check.status === 'online') {
        banner.className = 'status-banner operational';
        bannerTitle.textContent = 'Сервис доступен (Онлайн)';
        bannerSub.textContent = `Время отклика: ${check.latency} мс`;
        bannerIcon.setAttribute('data-lucide', 'check-circle');
      } else if (check.status === 'degraded') {
        banner.className = 'status-banner degraded';
        bannerTitle.textContent = 'Замечена деградация / Предупреждение';
        bannerSub.textContent = `Задержка: ${check.latency} мс${check.error ? ` · ${check.error}` : ''}`;
        bannerIcon.setAttribute('data-lucide', 'alert-triangle');
      } else {
        banner.className = 'status-banner outage';
        bannerTitle.textContent = 'Сбой проверки (Недоступен)';
        bannerSub.textContent = check.error || 'Ошибка подключения';
        bannerIcon.setAttribute('data-lucide', 'alert-octagon');
      }

      loading.style.display = 'none';
      result.style.display = 'block';
      lucide.createIcons();

      // Refresh monitor data in table
      loadMonitors();
    } catch (err) {
      loading.style.display = 'none';
      result.style.display = 'block';
      const banner = document.getElementById('diagBanner');
      banner.className = 'status-banner outage';
      document.getElementById('diagBannerTitle').textContent = 'Ошибка проверки';
      document.getElementById('diagBannerSubtitle').textContent = err.message;
      document.getElementById('diagDetailsText').innerHTML = escapeHtml(err.message) + ` ${renderErrorHelpBtn(err.message)}`;
      lucide.createIcons();
    }
  };

  document.getElementById('diagRerunBtn')?.addEventListener('click', () => {
    if (currentDiagMonitorId && currentDiagType) {
      window.runBadgeCheck(null, currentDiagMonitorId, currentDiagType);
    }
  });

  // --- Heartbeat Tick Detailed Modal ---
  window.openHeartbeatDetails = function (e, monitorId, hbIndexOrObj) {
    if (e) e.stopPropagation();
    const monitor = monitorsList.find((m) => m.id === monitorId);
    if (!monitor) return;

    let hb = null;
    if (typeof hbIndexOrObj === 'object' && hbIndexOrObj !== null) {
      hb = hbIndexOrObj;
    } else if (typeof hbIndexOrObj === 'number') {
      hb = monitor.heartbeats && monitor.heartbeats[hbIndexOrObj];
    }
    if (!hb) return;

    const modal = document.getElementById('heartbeatModal');
    if (!modal) return;

    document.getElementById('hbModalTitle').textContent = `📊 Результат проверки: ${monitor.name}`;
    document.getElementById('hbMonitorName').textContent = monitor.name;
    document.getElementById('hbTarget').textContent = monitor.target + (monitor.port ? `:${monitor.port}` : '');
    document.getElementById('hbTime').textContent = `${new Date(hb.created_at).toLocaleDateString()} ${new Date(hb.created_at).toLocaleTimeString()} (${formatRelativeTime(hb.created_at)})`;
    document.getElementById('hbLatency').textContent = `${hb.latency} мс`;

    const codeRow = document.getElementById('hbStatusCodeRow');
    if (hb.status_code) {
      document.getElementById('hbStatusCode').textContent = hb.status_code;
      codeRow.style.display = 'flex';
    } else {
      codeRow.style.display = 'none';
    }

    const sslRow = document.getElementById('hbSslRow');
    if (hb.ssl_days_remaining !== null && hb.ssl_days_remaining !== undefined) {
      document.getElementById('hbSslDays').textContent = `${hb.ssl_days_remaining} дн. до истечения`;
      sslRow.style.display = 'flex';
    } else {
      sslRow.style.display = 'none';
    }

    const banner = document.getElementById('hbBanner');
    const bTitle = document.getElementById('hbBannerTitle');
    const bSub = document.getElementById('hbBannerSubtitle');
    const bIcon = document.getElementById('hbBannerIcon');
    const rText = document.getElementById('hbReasonText');

    if (hb.status === 'down') {
      banner.className = 'status-banner outage';
      bTitle.textContent = 'Сбой проверки (Сервис недоступен)';
      bSub.textContent = hb.error || 'Ошибка подключения или таймаут';
      bIcon.setAttribute('data-lucide', 'alert-octagon');
      rText.innerHTML = `<span style="color:var(--red);font-weight:600">Ошибка:</span> ${escapeHtml(hb.error || 'Сервис не ответил за установленный таймаут')} ${renderErrorHelpBtn(hb.error || 'Сервис не ответил за установленный таймаут')}`;
    } else if (hb.status === 'degraded') {
      banner.className = 'status-banner degraded';
      bTitle.textContent = 'Замечена деградация / Предупреждение';
      bSub.textContent = `Задержка: ${hb.latency} мс (превышен нормальный порог отклика)`;
      bIcon.setAttribute('data-lucide', 'alert-triangle');
      rText.innerHTML = `<span style="color:var(--amber);font-weight:600">Причина:</span> ${escapeHtml(hb.error || `Время ответа составило ${hb.latency} мс, что указывает на высокую задержку сети или сервера`)} ${renderErrorHelpBtn(hb.error || `Задержка отклика ${hb.latency} мс`)}`;
    } else {
      banner.className = 'status-banner operational';
      bTitle.textContent = 'Сервис полностью доступен (Онлайн)';
      bSub.textContent = `Время отклика: ${hb.latency} мс — всё отлично`;
      bIcon.setAttribute('data-lucide', 'check-circle');
      rText.innerHTML = `<span style="color:var(--green);font-weight:600">Результат:</span> Запрос выполнен успешно, задержка ${hb.latency} мс, ошибок не зафиксировано.`;
    }

    openModal(modal);
    lucide.createIcons();
  };

  // --- Uptime Scale Helpers ---
  const TICK_HEIGHT_PATTERN = [13, 11, 13, 15, 12, 11, 14, 15, 12, 11, 13, 15, 12, 14, 13, 15, 12, 11, 14, 15, 13, 11, 14, 15];
  const lastHeartbeatMap = new Map();

  function getTickHeight(hb, index) {
    if (!hb) return 8;
    const i = Math.abs(typeof index === 'number' ? index : Math.round((hb.created_at || Date.now()) / 10000)) % TICK_HEIGHT_PATTERN.length;
    return TICK_HEIGHT_PATTERN[i];
  }

  function getTickInfo(hb) {
    const timeAgo = formatRelativeTime(hb.created_at);
    const timeExact = new Date(hb.created_at).toLocaleTimeString();
    let cls = 'tick-good';
    let title = `✅ Доступен: ${hb.latency} мс · ${timeAgo} (${timeExact})\nКликните для подробного отчёта`;

    if (hb.status === 'down') {
      cls = 'tick-down';
      const reason = hb.error || 'Сбой подключения';
      title = `❌ Сбой: ${escapeHtml(reason)} · ${timeAgo} (${timeExact})\nКликните для подробного отчёта`;
    } else if (hb.status === 'degraded') {
      cls = 'tick-warn';
      const reason = hb.error || (hb.latency > 1000 ? `Задержка ${hb.latency} мс выше нормы` : 'Замечено замедление отклика');
      title = `⚠️ Деградация: ${escapeHtml(reason)} · ${hb.latency} мс (${timeAgo} в ${timeExact})\nКликните для подробного отчёта`;
    }

    return { cls, title };
  }

  function renderSingleTickHtml(hb, isLatest, monitorId, index) {
    if (!hb) {
      return `<i class="tick-empty" style="height:8px" title="Ожидание следующей проверки"></i>`;
    }
    const { cls, title } = getTickInfo(hb);
    const height = getTickHeight(hb, index);
    const escapedTitle = title.replace(/\n/g, '&#10;');
    return `<i class="${cls} ${isLatest ? 'tick-latest' : ''}" style="height:${height}px" title="${escapedTitle}" onclick="window.openHeartbeatDetails(event, '${monitorId}', ${index})"></i>`;
  }

  function createSingleTickElement(hb, isLatest, monitorId, hbIndexOrObj) {
    const el = document.createElement('i');
    if (!hb) {
      el.className = 'tick-empty';
      el.style.height = '8px';
      el.title = 'Ожидание следующей проверки';
      return el;
    }
    const { cls, title } = getTickInfo(hb);
    const height = getTickHeight(hb, typeof hbIndexOrObj === 'number' ? hbIndexOrObj : 23);
    el.className = `${cls} ${isLatest ? 'tick-latest' : ''}`;
    el.style.height = `${height}px`;
    el.title = title;
    el.onclick = (e) => window.openHeartbeatDetails(e, monitorId, hb);
    return el;
  }

  function renderMonitorsTable(forceRebuild = false) {
    let filtered = monitorsList.filter((m) => {
      if (currentFilter === 'online') return m.status === 'online';
      if (currentFilter === 'issues') return m.status === 'down' || m.status === 'degraded';
      return true;
    });

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((m) => m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q));
    }

    if (filtered.length === 0) {
      monitorsTbody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <i data-lucide="shield-alert"></i>
              <p>Мониторы не найдены</p>
              ${
                authState.authenticated && authState.user?.role === 'admin'
                  ? '<button class="btn btn-primary" onclick="document.getElementById(\'addMonitor\').click()"><i data-lucide="plus"></i> Добавить монитор</button>'
                  : '<p style="font-size:10px">Войдите под учетной записью администратора для добавления мониторов.</p>'
              }
            </div>
          </td>
        </tr>
      `;
      lucide.createIcons();
      return;
    }

    const existingRows = Array.from(monitorsTbody.querySelectorAll('tr[data-id]'));
    const existingRowIds = existingRows.map((r) => r.getAttribute('data-id'));
    const targetRowIds = filtered.map((m) => m.id);
    const canPatchInPlace =
      !forceRebuild &&
      existingRowIds.length === targetRowIds.length &&
      existingRowIds.every((id, idx) => id === targetRowIds[idx]);

    if (!canPatchInPlace) {
      monitorsTbody.innerHTML = filtered
        .map((m) => {
          const { icon, cls } = getIconForTypes(m.type);

          // Status badge
          let statusBadge = '';
          if (m.is_paused) {
            statusBadge = `<span class="status muted"><i></i> На паузе</span>`;
          } else if (m.status === 'online') {
            statusBadge = `<span class="status okay"><i></i> Онлайн</span>`;
          } else if (m.status === 'degraded') {
            statusBadge = `<span class="status warn"><i></i> Деградация</span>`;
          } else if (m.status === 'down') {
            statusBadge = `<span class="status down"><i></i> Недоступен</span>`;
          } else {
            statusBadge = `<span class="status muted"><i></i> Ожидание</span>`;
          }

          // Active check badges - clickable to run single diagnostic check
          const checkBadges = (m.type || 'http')
            .split(',')
            .map((t) => {
              const cleanType = t.trim().toLowerCase();
              return `<span class="type-badge clickable" onclick="window.runBadgeCheck(event, '${m.id}', '${cleanType}')" title="Нажмите для проверки ${cleanType.toUpperCase()}">${cleanType.toUpperCase()}</span>`;
            })
            .join('');

          // SSL Tag - also clickable to inspect certificate
          let sslTag = '';
          if (m.check_ssl && m.ssl_days_remaining !== null && m.ssl_days_remaining !== undefined) {
            const days = m.ssl_days_remaining;
            let sslClass = 'good';
            let sslIcon = 'shield-check';
            let sslText = `SSL ${days} дн`;
            if (days <= 0) {
              sslClass = 'danger';
              sslIcon = 'shield-x';
              sslText = 'SSL истёк';
            } else if (days <= m.ssl_alert_days) {
              sslClass = 'warning';
              sslIcon = 'shield-alert';
              sslText = `SSL ${days} дн!`;
            }
            sslTag = `<span class="ssl-tag ${sslClass}" style="cursor:pointer" onclick="window.runBadgeCheck(event, '${m.id}', 'ssl')" title="Нажмите для проверки сертификата (${m.ssl_expiry_date || ''})"><i data-lucide="${sslIcon}"></i> ${sslText}</span>`;
          }

          // Live Uptime Scale Ticks (24 slots)
          const maxTicks = 24;
          const heartbeats = m.heartbeats || [];
          const count = heartbeats.length;

          const tickElements = Array(maxTicks)
            .fill(0)
            .map((_, i) => {
              if (count === 0) {
                return `<i class="tick-empty" style="height:8px" title="Ожидание проверки"></i>`;
              }
              if (count < maxTicks) {
                if (i < count) {
                  return renderSingleTickHtml(heartbeats[i], i === count - 1, m.id, i);
                } else {
                  return `<i class="tick-empty" style="height:8px" title="Ожидание следующей проверки"></i>`;
                }
              } else {
                return renderSingleTickHtml(heartbeats[i], i === maxTicks - 1, m.id, i);
              }
            })
            .join('');

          // Record latest heartbeat timestamp
          const latestHb = heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : null;
          lastHeartbeatMap.set(m.id, {
            lastCreatedAt: latestHb ? latestHb.created_at : 0,
            count: heartbeats.length
          });

          const latencyDisplay =
            m.status === 'down'
              ? `<b class="mono muted">—</b>`
              : `<b class="mono">${m.current_latency} <small>мс</small></b>`;

          // Role-based actions cell
          const isViewer = authState.user?.role === 'viewer';
          const actionsHtml = isViewer
            ? `<button class="dots" style="opacity:0.3;cursor:default" title="Наблюдатель (только чтение)"><i data-lucide="eye"></i></button>`
            : `<button class="dots" onclick="window.openActionMenu(event, '${m.id}')" aria-label="Действия"><i data-lucide="more-horizontal"></i></button>`;

          return `
            <tr data-id="${m.id}" data-status="${m.status}" data-paused="${m.is_paused}">
              <td>
                <div class="monitor-name">
                  <span class="mon-icon ${cls}"><i data-lucide="${icon}"></i></span>
                  <div>
                    <div style="display:flex;align-items:center;gap:6px">
                      <b>${escapeHtml(m.name)}</b>
                      ${checkBadges}
                    </div>
                    <small>${escapeHtml(m.target)}${m.port ? `:${m.port}` : ''}</small>
                    ${sslTag}
                  </div>
                </div>
              </td>
              <td class="status-cell">${statusBadge}</td>
              <td>
                <div class="uptime">
                  <button type="button" class="uptime-btn ${m.uptime24h < 100 ? 'has-issues' : ''}" onclick="window.goToIncidents('${m.id}')" title="Uptime ${m.uptime24h || 100}% за 24 ч · Нажмите для просмотра сбоев и инцидентов">
                    <b>${m.uptime24h || 100}%</b>
                    <i data-lucide="arrow-up-right"></i>
                  </button>
                  <span class="ticks good-ticks">${tickElements}</span>
                </div>
              </td>
              <td class="latency-cell">${latencyDisplay}</td>
              <td class="time">${formatRelativeTime(m.last_checked_at)}</td>
              <td class="actions-cell">
                ${actionsHtml}
              </td>
            </tr>
          `;
        })
        .join('');

      lucide.createIcons();
    } else {
      // In-place patch preserving DOM elements and smoothly animating ticks!
      filtered.forEach((m) => {
        const row = monitorsTbody.querySelector(`tr[data-id="${m.id}"]`);
        if (!row) return;

        // 1. Status badge
        if (row.dataset.status !== m.status || row.dataset.paused !== String(m.is_paused)) {
          row.dataset.status = m.status;
          row.dataset.paused = String(m.is_paused);
          const statusCell = row.querySelector('.status-cell');
          if (statusCell) {
            if (m.is_paused) {
              statusCell.innerHTML = `<span class="status muted"><i></i> На паузе</span>`;
            } else if (m.status === 'online') {
              statusCell.innerHTML = `<span class="status okay"><i></i> Онлайн</span>`;
            } else if (m.status === 'degraded') {
              statusCell.innerHTML = `<span class="status warn"><i></i> Деградация</span>`;
            } else if (m.status === 'down') {
              statusCell.innerHTML = `<span class="status down"><i></i> Недоступен</span>`;
            } else {
              statusCell.innerHTML = `<span class="status muted"><i></i> Ожидание</span>`;
            }
          }
        }

        // 2. Uptime %
        const uptimeB = row.querySelector('.uptime-btn > b, .uptime > b');
        if (uptimeB) uptimeB.textContent = `${m.uptime24h || 100}%`;
        const uptimeBtn = row.querySelector('.uptime-btn');
        if (uptimeBtn) {
          if (m.uptime24h < 100) uptimeBtn.classList.add('has-issues');
          else uptimeBtn.classList.remove('has-issues');
        }

        // 3. Latency
        const latencyCell = row.querySelector('.latency-cell');
        if (latencyCell) {
          latencyCell.innerHTML =
            m.status === 'down'
              ? `<b class="mono muted">—</b>`
              : `<b class="mono">${m.current_latency} <small>мс</small></b>`;
        }

        // 4. Last checked time
        const timeCell = row.querySelector('td.time');
        if (timeCell) {
          timeCell.textContent = formatRelativeTime(m.last_checked_at);
        }

        // 5. Live ticks conveyor animation
        const ticksContainer = row.querySelector('.ticks');
        if (ticksContainer) {
          const heartbeats = m.heartbeats || [];
          const newestHb = heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : null;
          const newestTime = newestHb ? newestHb.created_at : 0;
          const prev = lastHeartbeatMap.get(m.id);

          if (!prev) {
            lastHeartbeatMap.set(m.id, { lastCreatedAt: newestTime, count: heartbeats.length });
          } else if (newestTime > prev.lastCreatedAt) {
            // A new heartbeat has arrived!
            const emptyTicks = ticksContainer.querySelectorAll('i.tick-empty');

            if (emptyTicks.length === 0) {
              // Scale is completely full (24 ticks).
              // The conveyor smoothly shifts left:
              // - Leftmost tick shrinks out with .tick-slide-out
              // - All 23 siblings naturally glide leftwards
              // - New tick slides in on the far right with .tick-slide-in

              // Remove latest pulse from the previous latest tick
              const prevLatest = ticksContainer.querySelector('i.tick-latest');
              if (prevLatest) {
                prevLatest.classList.remove('tick-latest');
              }

              // Leftmost tick begins shrinking and sliding out
              const oldestTick = ticksContainer.firstElementChild;
              if (oldestTick) {
                oldestTick.classList.add('tick-slide-out');
              }

              // Create new tick element and append to the right
              const newTick = createSingleTickElement(newestHb, true, m.id, newestHb);
              newTick.classList.add('tick-slide-in');
              ticksContainer.appendChild(newTick);

              // Once the 0.4s transition completes, cleanly remove the oldest element
              setTimeout(() => {
                if (oldestTick && oldestTick.parentNode === ticksContainer) {
                  oldestTick.remove();
                }
                if (newTick) {
                  newTick.classList.remove('tick-slide-in');
                }
              }, 420);
            } else {
              // Still have empty slots on the right: fill next slot
              const firstEmpty = emptyTicks[0];
              const prevLatest = ticksContainer.querySelector('i.tick-latest');
              if (prevLatest) {
                prevLatest.classList.remove('tick-latest');
              }

              const newTick = createSingleTickElement(newestHb, true, m.id, newestHb);
              newTick.classList.add('tick-slide-in');
              ticksContainer.insertBefore(newTick, firstEmpty);
              firstEmpty.remove();

              setTimeout(() => {
                if (newTick) {
                  newTick.classList.remove('tick-slide-in');
                }
              }, 420);
            }

            lastHeartbeatMap.set(m.id, { lastCreatedAt: newestTime, count: heartbeats.length });
          }
        }
      });
    }

    document.getElementById('tableSubtitle').textContent = `${monitorsList.length} мониторов · обновлено ${new Date().toLocaleTimeString()}`;
  }

  function updateGroupCounts() {
    const total = monitorsList.length;
    const online = monitorsList.filter((m) => m.status === 'online').length;
    const issues = monitorsList.filter((m) => m.status === 'down' || m.status === 'degraded').length;

    document.getElementById('groupAllCount').textContent = total;
    document.getElementById('groupOnlineCount').textContent = online;
    document.getElementById('groupIssuesCount').textContent = issues;
    document.getElementById('navMonitorCount').textContent = total;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Filter Group Tabs
  document.querySelectorAll('.groups .group').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.groups .group').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter') || 'all';
      renderMonitorsTable(true);
    });
  });

  // Search input
  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderMonitorsTable(true);
  });

  // --- Stats, Incidents and Latency Chart ---
  async function loadStats() {
    try {
      const summary = await api('/stats/summary');
      document.getElementById('statTotalMonitors').textContent = summary.total;
      document.getElementById('statMonitorsSubtitle').textContent = `${summary.online} онлайн, ${summary.down} оффлайн`;
      document.getElementById('statOnlineMonitors').textContent = summary.online;
      document.getElementById('statUptimePercent').textContent =
        summary.total > 0 ? `${Math.round((summary.online / summary.total) * 100)}% от всех сервисов` : '100%';
      document.getElementById('statAvgLatency').textContent = summary.avgLatency;
      document.getElementById('statActionNeeded').textContent = summary.actionNeeded;
      document.getElementById('statCriticalIncidents').textContent = `${summary.criticalIncidents} критических`;

      const overallBadge = document.getElementById('systemStatusBadge');
      if (summary.down > 0) {
        overallBadge.innerHTML = `<i style="background:var(--red);box-shadow:0 0 0 4px var(--red-soft)"></i> Есть сбои в системе`;
        overallBadge.style.color = 'var(--red)';
      } else if (summary.degraded > 0) {
        overallBadge.innerHTML = `<i style="background:var(--amber);box-shadow:0 0 0 4px var(--amber-soft)"></i> Замечена деградация`;
        overallBadge.style.color = 'var(--amber)';
      } else {
        overallBadge.innerHTML = `<i></i> Все системы наблюдаются`;
        overallBadge.style.color = 'var(--green)';
      }
    } catch (err) {
      console.error('Error loading stats summary:', err);
    }
  }

  // --- Incidents & History Management ---
  let selectedIncidentMonitorId = '';
  let activeIncidentsTab = 'active';

  // --- Error Explanations Database & Popover Logic ---
  function getErrorExplanation(rawErr) {
    if (!rawErr) {
      return {
        title: 'Успешная проверка',
        category: 'Штатная работа',
        description: 'Ошибок не зафиксировано, целевой сервис отвечает в пределах нормы.',
        recommendation: 'Действий не требуется.'
      };
    }

    const err = String(rawErr).toLowerCase();

    // 1. 504 Gateway Time-out
    if (err.includes('504') || err.includes('gateway time-out') || err.includes('gateway timeout')) {
      return {
        title: 'HTTP 504 Gateway Time-out',
        category: 'Таймаут шлюза / прокси',
        description: 'Промежуточный сервер или прокси (Nginx, Traefik, Cloudflare) ждал ответа от основного приложения (бэкенда), но время вышло. Приложение зависло или перегружено.',
        recommendation: 'Проверьте логи бэкенда (Node.js/Python/Go/PHP), загрузку CPU/RAM и оптимизируйте медленные SQL-запросы к базе данных.'
      };
    }

    // 2. 502 Bad Gateway
    if (err.includes('502') || err.includes('bad gateway')) {
      return {
        title: 'HTTP 502 Bad Gateway',
        category: 'Ошибочный шлюз',
        description: 'Веб-сервер получил некорректный ответ от внутреннего приложения или процесс приложения упал и разорвал соединение до передачи ответа.',
        recommendation: 'Проверьте статус службы бэкенда (systemctl status / docker ps). Убедитесь, что приложение не упало из-за нехватки памяти (OOM).'
      };
    }

    // 3. 500 Internal Server Error
    if (err.includes('500') || err.includes('internal server error')) {
      return {
        title: 'HTTP 500 Internal Server Error',
        category: 'Внутренняя ошибка сервера',
        description: 'Сервер столкнулся с непредвиденным исключением или сбоем в коде приложения при обработке HTTP-запроса.',
        recommendation: 'Изучите файл журнала ошибок приложения (error.log), проверьте доступность базы данных и переменные окружения.'
      };
    }

    // 4. 503 Service Unavailable
    if (err.includes('503') || err.includes('service unavailable')) {
      return {
        title: 'HTTP 503 Service Unavailable',
        category: 'Сервис временно недоступен',
        description: 'Сервер временно не готов обработать запрос. Обычно это вызвано перегрузкой пула потоков или проведением регламентных работ.',
        recommendation: 'Проверьте нагрузку на сервер и лимиты одновременных подключений воркеров веб-сервера.'
      };
    }

    // 5. 403 Forbidden
    if (err.includes('403') || err.includes('forbidden')) {
      return {
        title: 'HTTP 403 Forbidden',
        category: 'Доступ запрещён',
        description: 'Сервер отклонил запрос. Часто это срабатывание защиты от ботов (Cloudflare, DDoS-Guard, WAF) или блокировка по IP-адресу/User-Agent.',
        recommendation: 'Проверьте правила файрвола (WAF) и убедитесь, что IP-адрес мониторинга не внесён в чёрный список.'
      };
    }

    // 6. 401 Unauthorized
    if (err.includes('401') || err.includes('unauthorized')) {
      return {
        title: 'HTTP 401 Unauthorized',
        category: 'Требуется авторизация',
        description: 'Для доступа к этому ресурсу требуются корректные учетные данные (Basic Auth или API-токен).',
        recommendation: 'Проверьте настройки пути монитора или передачу необходимых заголовков авторизации.'
      };
    }

    // 7. 404 Not Found
    if (err.includes('404') || err.includes('not found')) {
      return {
        title: 'HTTP 404 Not Found',
        category: 'Страница не найдена',
        description: 'Запрашиваемый адрес или эндпоинт отсутствует на сервере.',
        recommendation: 'Проверьте правильность URL цели (Target) в настройках монитора.'
      };
    }

    // 8. TLS Handshake connection timed out
    if (err.includes('handshake') || (err.includes('tls') && err.includes('time'))) {
      return {
        title: 'Таймаут TLS-рукопожатия',
        category: 'Задержка защищённого соединения',
        description: 'Сервер не успел обменяться сертификатами и ключами шифрования за лимит времени из-за сильной задержки сети, потери пакетов или перегрузки CPU сервера. Сам сертификат при этом валиден.',
        recommendation: 'Проверьте стабильность интернет-канала до сервера и загрузку процессора на целевом хосте.'
      };
    }

    // 9. SSL Expired or invalid
    if (err.includes('ssl') || err.includes('certificate') || err.includes('cert')) {
      return {
        title: 'Ошибка SSL-сертификата',
        category: 'Безопасность HTTPS',
        description: 'Цифровой сертификат безопасности сайта просрочен, самоподписан или выпущен для другого домена. Браузеры блокируют вход на такой сайт.',
        recommendation: 'Перевыпустите SSL-сертификат (например, командой certbot renew) и проверьте привязку доменного имени.'
      };
    }

    // 10. Request timeout
    if (err.includes('timeout') || err.includes('timed out')) {
      return {
        title: 'Таймаут ожидания ответа',
        category: 'Сетевой таймаут',
        description: 'Сервер не прислал ответ за установленное время ожидания. Сервер завис, перегружен либо сетевые пакеты теряются по пути.',
        recommendation: 'Убедитесь, что сервер не завис, проверьте потребление памяти и сетевые правила файрвола (iptables/ufw).'
      };
    }

    // 11. Ping / ICMP failure
    if (err.includes('ping') || err.includes('icmp')) {
      return {
        title: 'Сбой проверки Ping (ICMP)',
        category: 'Сетевая связность',
        description: 'Сервер не ответил на сетевой эхо-запрос (ping). Сервер либо выключен, либо перезагружается, либо хостинг заблокировал протокол ICMP.',
        recommendation: 'Проверьте, включён ли сервер, и разрешены ли входящие ICMP-пакеты (Echo Request) в настройках сетевой защиты.'
      };
    }

    // 12. Connection refused (ECONNREFUSED)
    if (err.includes('refused') || err.includes('econnrefused')) {
      return {
        title: 'Соединение отклонено (Port Closed)',
        category: 'Сетевой порт закрыт',
        description: 'Сервер доступен в сети, но указанный порт закрыт — ни одна программа сейчас не слушает входящие подключения на этом порту.',
        recommendation: 'Проверьте, запущена ли служба (Nginx, PostgreSQL, Docker) и слушает ли она внешний адрес 0.0.0.0, а не только 127.0.0.1.'
      };
    }

    // 13. DNS lookup failed
    if (err.includes('dns') || err.includes('enotfound') || err.includes('getaddrinfo')) {
      return {
        title: 'Ошибка DNS-разрешения',
        category: 'Разрешение доменных имён',
        description: 'Системе не удалось определить IP-адрес по указанному домену. Либо домен не существует, либо сбоит DNS-сервер.',
        recommendation: 'Проверьте правильность написания домена и настройки DNS (A-записи) у регистратора.'
      };
    }

    // 14. Keyword not found
    if (err.includes('keyword') || err.includes('ключевое слово')) {
      return {
        title: 'Ключевое слово не найдено',
        category: 'Контроль контента',
        description: 'Страница успешно загрузилась, но на ней отсутствует обязательное слово, заданное в настройках монитора. Возможно, сайт отдал заглушку ошибки.',
        recommendation: 'Откройте сайт в браузере и проверьте, отображается ли искомый текст в исходном HTML.'
      };
    }

    // 15. Latency / Degraded
    if (err.includes('задержка') || err.includes('замедление') || err.includes('latency')) {
      return {
        title: 'Высокая задержка отклика',
        category: 'Деградация производительности',
        description: 'Время ответа сервиса существенно превысило норму (> 2000 мс). Сервис работает медленно и может испытывать пиковую нагрузку.',
        recommendation: 'Проверьте загрузку дисковой подсистемы (iostat), использование памяти и время выполнения тяжелых фоновых задач.'
      };
    }

    // Default Fallback
    return {
      title: 'Сбой проверки сервиса',
      category: 'Диагностика',
      description: `Зафиксирована ошибка: ${rawErr}. Сервис не прошёл проверку параметров доступности.`,
      recommendation: 'Проверьте доступность целевого адреса вручную и изучите системные логи сервера.'
    };
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderErrorHelpBtn(errorText) {
    if (!errorText) return '';
    const cleanErr = escapeAttr(String(errorText));
    return `<button type="button" class="error-help-btn" data-error="${cleanErr}" onclick="window.toggleErrorHelp(event, this)" onmouseenter="window.hoverErrorHelp(event, this)" onmouseleave="window.leaveErrorHelp(event)" title="Что значит эта ошибка? (Нажмите для фиксации)"><i data-lucide="help-circle"></i></button>`;
  }

  let isErrorHelpPinned = false;
  let errorHelpHoverTimeout = null;

  function positionErrorHelpPopover(btn) {
    const popover = document.getElementById('errorHelpPopover');
    if (!popover || !btn) return;

    const rect = btn.getBoundingClientRect();
    const popWidth = 350;
    let left = rect.left - 40;
    if (left + popWidth > window.innerWidth - 15) {
      left = window.innerWidth - popWidth - 15;
    }
    if (left < 15) left = 15;

    let top = rect.bottom + 8;
    if (rect.bottom + 260 > window.innerHeight && rect.top > 260) {
      top = rect.top - 250;
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  window.showErrorHelpContent = function (errorText, btn, isPinned = false) {
    clearTimeout(errorHelpHoverTimeout);
    const popover = document.getElementById('errorHelpPopover');
    if (!popover) return;

    const info = getErrorExplanation(errorText);
    document.getElementById('ehTitle').textContent = info.title;
    document.getElementById('ehCategory').textContent = info.category;
    document.getElementById('ehDescription').textContent = info.description;
    document.getElementById('ehRecommendation').textContent = info.recommendation;

    positionErrorHelpPopover(btn);
    popover.style.display = 'block';
    isErrorHelpPinned = isPinned;

    const closeBtn = popover.querySelector('.eh-close');
    if (closeBtn) closeBtn.style.display = isPinned ? 'grid' : 'none';
    lucide.createIcons();
  };

  window.hoverErrorHelp = function (e, btn) {
    if (isErrorHelpPinned) return;
    const errText = btn.getAttribute('data-error');
    if (!errText) return;
    window.showErrorHelpContent(errText, btn, false);
  };

  window.leaveErrorHelp = function () {
    if (isErrorHelpPinned) return;
    errorHelpHoverTimeout = setTimeout(() => {
      if (!isErrorHelpPinned) {
        const popover = document.getElementById('errorHelpPopover');
        if (popover) popover.style.display = 'none';
      }
    }, 160);
  };

  window.toggleErrorHelp = function (e, btn) {
    if (e) e.stopPropagation();
    const errText = btn.getAttribute('data-error');
    if (!errText) return;

    const popover = document.getElementById('errorHelpPopover');
    if (isErrorHelpPinned && popover && popover.style.display === 'block') {
      window.closeErrorHelp();
    } else {
      window.showErrorHelpContent(errText, btn, true);
    }
  };

  window.closeErrorHelp = function () {
    isErrorHelpPinned = false;
    const popover = document.getElementById('errorHelpPopover');
    if (popover) popover.style.display = 'none';
  };

  // Keep popover open if user hovers directly over the popover content
  const helpPopoverEl = document.getElementById('errorHelpPopover');
  helpPopoverEl?.addEventListener('mouseenter', () => {
    clearTimeout(errorHelpHoverTimeout);
  });
  helpPopoverEl?.addEventListener('mouseleave', () => {
    if (!isErrorHelpPinned) {
      window.leaveErrorHelp();
    }
  });

  // Clicking outside or pressing Escape closes pinned popover
  document.addEventListener('click', (e) => {
    if (isErrorHelpPinned) {
      const popover = document.getElementById('errorHelpPopover');
      if (popover && !popover.contains(e.target) && !e.target.closest('.error-help-btn')) {
        window.closeErrorHelp();
      }
    }
  });

  function formatIncidentTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (isToday) return `Сегодня в ${timeStr}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return 'менее секунды';
    if (sec < 60) return `${sec} сек`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec > 0 ? `${min} мин ${remSec} сек` : `${min} мин`;
    const hours = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hours} ч ${remMin} мин`;
  }

  function switchIncidentsTab(tabName) {
    activeIncidentsTab = tabName;
    document.querySelectorAll('.incident-tabs-bar .inc-tab').forEach((btn) => {
      if (btn.dataset.tab === tabName) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    const activePane = document.getElementById('incidentsTabContentActive');
    const resolvedPane = document.getElementById('incidentsTabContentResolved');
    const issuesPane = document.getElementById('incidentsTabContentHeartbeats');

    if (activePane) activePane.style.display = tabName === 'active' ? 'block' : 'none';
    if (resolvedPane) resolvedPane.style.display = tabName === 'resolved' ? 'block' : 'none';
    if (issuesPane) issuesPane.style.display = tabName === 'heartbeats' ? 'block' : 'none';
    lucide.createIcons();
  }

  // Bind tabs click
  document.querySelectorAll('.incident-tabs-bar .inc-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchIncidentsTab(btn.dataset.tab);
    });
  });

  // Bind Monitor Filter select
  const incFilterSelect = document.getElementById('incidentMonitorFilter');
  const resetIncFilterBtn = document.getElementById('resetIncidentFilterBtn');

  incFilterSelect?.addEventListener('change', (e) => {
    selectedIncidentMonitorId = e.target.value;
    if (resetIncFilterBtn) {
      resetIncFilterBtn.style.display = selectedIncidentMonitorId ? 'inline-grid' : 'none';
    }
    loadIncidents();
  });

  resetIncFilterBtn?.addEventListener('click', () => {
    selectedIncidentMonitorId = '';
    if (incFilterSelect) incFilterSelect.value = '';
    resetIncFilterBtn.style.display = 'none';
    loadIncidents();
  });

  window.goToIncidents = function (monitorId) {
    selectedIncidentMonitorId = monitorId || '';
    navigateTo('/incidents');
    if (incFilterSelect) {
      incFilterSelect.value = selectedIncidentMonitorId;
    }
    if (resetIncFilterBtn) {
      resetIncFilterBtn.style.display = selectedIncidentMonitorId ? 'inline-grid' : 'none';
    }
    loadIncidents().then(() => {
      const activeCount = parseInt(document.getElementById('incidentBadgeCount')?.textContent || '0', 10);
      const resolvedCount = parseInt(document.getElementById('incidentResolvedCount')?.textContent || '0', 10);
      const issuesCount = parseInt(document.getElementById('incidentIssuesCount')?.textContent || '0', 10);

      if (activeCount > 0) {
        switchIncidentsTab('active');
      } else if (resolvedCount > 0) {
        switchIncidentsTab('resolved');
      } else if (issuesCount > 0) {
        switchIncidentsTab('heartbeats');
      } else {
        switchIncidentsTab('active');
      }
    });

    const mon = monitorsList.find((m) => m.id === monitorId);
    if (mon) {
      showToast(`Инциденты и сбои для «${mon.name}» (${mon.uptime24h || 100}%)`);
    }
  };

  async function loadIncidents() {
    try {
      // Populate monitor filter dropdown
      if (incFilterSelect && monitorsList.length > 0) {
        const currentVal = incFilterSelect.value || selectedIncidentMonitorId;
        const optionsHtml = [
          `<option value="">Все сервисы (${monitorsList.length})</option>`,
          ...monitorsList.map((m) => `<option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>${escapeHtml(m.name)} (${m.uptime24h || 100}%)</option>`)
        ].join('');
        incFilterSelect.innerHTML = optionsHtml;
        incFilterSelect.value = currentVal;
      }

      const queryUrl = selectedIncidentMonitorId ? `/stats/incidents?monitor_id=${encodeURIComponent(selectedIncidentMonitorId)}` : '/stats/incidents';
      const { active = [], recent = [], issueHeartbeats = [] } = await api(queryUrl);

      const countEl = document.getElementById('incidentBadgeCount');
      const navCountEl = document.getElementById('navIncidentCount');
      const resolvedCountEl = document.getElementById('incidentResolvedCount');
      const issuesCountEl = document.getElementById('incidentIssuesCount');

      const activeListEl = document.getElementById('incidentsList');
      const resolvedListEl = document.getElementById('incidentsResolvedList');
      const issuesListEl = document.getElementById('incidentsIssuesList');

      if (countEl) countEl.textContent = active.length;
      if (navCountEl) navCountEl.textContent = active.length;
      if (resolvedCountEl) resolvedCountEl.textContent = recent.length;
      if (issuesCountEl) issuesCountEl.textContent = issueHeartbeats.length;

      // 1. Render Active Incidents
      if (activeListEl) {
        if (active.length === 0) {
          activeListEl.innerHTML = `
            <div style="padding:26px 20px;text-align:center;color:var(--muted);font-size:11px">
              <i data-lucide="check-circle" style="width:28px;height:28px;color:var(--green);margin-bottom:8px"></i>
              <p style="margin:0;font-weight:600;color:var(--text);font-size:12px">Активных сбоев не зафиксировано</p>
              <p style="margin:4px 0 0;font-size:10px;color:var(--muted)">Все сервисы отвечают в штатном режиме.</p>
            </div>
          `;
        } else {
          activeListEl.innerHTML = active
            .map((inc) => {
              const isCritical = inc.status === 'critical';
              const dotClass = isCritical ? 'critical-dot' : 'warn-dot';
              const icon = isCritical ? 'x' : 'triangle-alert';
              const startedMin = Math.round((Date.now() - inc.started_at) / (1000 * 60));

              return `
                <div class="incident-row">
                  <span class="incident-dot ${dotClass}"><i data-lucide="${icon}"></i></span>
                  <div style="flex:1">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                      <b style="font-size:11px">${escapeHtml(inc.monitor_name)}: ${escapeHtml(inc.cause)}</b>
                      ${renderErrorHelpBtn(inc.cause)}
                      <span class="${isCritical ? '' : 'warn-badge'}">${isCritical ? 'Критический' : 'Деградация'}</span>
                    </div>
                    <p style="margin:0;font-size:10px;color:var(--muted)">
                      Начался ${startedMin > 0 ? `${startedMin} мин назад` : 'только что'} (${formatIncidentTime(inc.started_at)})
                    </p>
                  </div>
                </div>
              `;
            })
            .join('');
        }
      }

      // 2. Render Resolved Incidents
      if (resolvedListEl) {
        if (recent.length === 0) {
          resolvedListEl.innerHTML = `
            <div style="padding:26px 20px;text-align:center;color:var(--muted);font-size:11px">
              <i data-lucide="shield-check" style="width:28px;height:28px;color:var(--green);margin-bottom:8px"></i>
              <p style="margin:0;font-weight:600;color:var(--text);font-size:12px">Завершённых инцидентов нет</p>
              <p style="margin:4px 0 0;font-size:10px;color:var(--muted)">За историю наблюдений не зафиксировано сбоев.</p>
            </div>
          `;
        } else {
          resolvedListEl.innerHTML = recent
            .map((inc) => {
              return `
                <div class="incident-row">
                  <span class="incident-dot resolved-dot"><i data-lucide="check-circle-2"></i></span>
                  <div style="flex:1">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                      <b style="font-size:11px">${escapeHtml(inc.monitor_name)}</b>
                      <span class="resolved-badge"><i data-lucide="check" style="width:10px;height:10px;vertical-align:-1px"></i> Устранено</span>
                      <span class="duration-badge">Длился: ${formatDuration(inc.duration_seconds)}</span>
                    </div>
                    <p style="margin:0;font-size:10px;color:var(--text);display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                      <span>${escapeHtml(inc.cause)}</span>
                      ${renderErrorHelpBtn(inc.cause)}
                    </p>
                    <p style="margin:4px 0 0;font-size:9px;color:var(--muted)">
                      Начало: ${formatIncidentTime(inc.started_at)} · Восстановлен: ${formatIncidentTime(inc.resolved_at)}
                    </p>
                  </div>
                </div>
              `;
            })
            .join('');
        }
      }

      // 3. Render 24h Check Issue Heartbeats
      if (issuesListEl) {
        if (issueHeartbeats.length === 0) {
          issuesListEl.innerHTML = `
            <div style="padding:26px 20px;text-align:center;color:var(--muted);font-size:11px">
              <i data-lucide="sparkles" style="width:28px;height:28px;color:var(--green);margin-bottom:8px"></i>
              <p style="margin:0;font-weight:600;color:var(--text);font-size:12px">За последние 24 часа все проверки прошли идеально</p>
              <p style="margin:4px 0 0;font-size:10px;color:var(--muted)">Текущий показатель доступности Uptime составляет 100.0%.</p>
            </div>
          `;
        } else {
          issuesListEl.innerHTML = issueHeartbeats
            .map((hb) => {
              const isDown = hb.status === 'down';
              const dotClass = isDown ? 'critical-dot' : 'warn-dot';
              const icon = isDown ? 'x' : 'alert-triangle';
              return `
                <div class="issue-row">
                  <span class="incident-dot ${dotClass}" style="flex:0 0 28px"><i data-lucide="${icon}"></i></span>
                  <div style="flex:1">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
                      <b style="font-size:11px">${escapeHtml(hb.monitor_name)}</b>
                      <span class="${isDown ? 'issue-badge-down' : 'issue-badge-warn'}">
                        ${isDown ? 'Сбой проверки' : 'Замедление'}
                      </span>
                      <small style="color:var(--muted);font-size:9px;margin-left:auto">${formatIncidentTime(hb.created_at)} (${formatRelativeTime(hb.created_at)})</small>
                    </div>
                    <p style="margin:0;font-size:10px;color:var(--text);display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                      <span>${escapeHtml(hb.error || (hb.latency ? `Задержка отклика ${hb.latency} мс` : 'Сбой'))}</span>
                      ${renderErrorHelpBtn(hb.error || (hb.latency ? `Задержка отклика ${hb.latency} мс` : 'Сбой'))}
                    </p>
                    <div style="display:flex;align-items:center;gap:12px;margin-top:4px;font-size:9px;color:var(--muted)">
                      <span>Отклик: <b>${hb.latency || 0} мс</b></span>
                      ${hb.status_code ? `<span>HTTP Код: <b>${hb.status_code}</b></span>` : ''}
                      <span style="color:var(--amber)">• Учтено в расчёте Uptime за 24 ч</span>
                    </div>
                  </div>
                </div>
              `;
            })
            .join('');
        }
      }

      lucide.createIcons();
    } catch (err) {
      console.error('Error loading incidents:', err);
    }
  }

  async function loadLatencyHistory() {
    try {
      const { points, average24h } = await api('/stats/latency-history');
      document.getElementById('chartAvgValue').textContent = average24h || 0;

      const chartEl = document.getElementById('latencyBarChart');
      if (!points || points.length === 0) return;

      const maxLatency = Math.max(...points.map((p) => p.latency), 100);

      chartEl.innerHTML = points
        .map((p, idx) => {
          const isCurrent = idx === points.length - 1;
          const heightPercent = Math.max(8, Math.min(100, Math.round((p.latency / maxLatency) * 100)));
          return `<i class="${isCurrent ? 'current' : ''}" style="height:${heightPercent}%" title="${p.label}: ${p.latency} ms"></i>`;
        })
        .join('');
    } catch (err) {
      console.error('Error loading latency history:', err);
    }
  }

  async function loadAllData() {
    await Promise.all([loadMonitors(), loadStats(), loadIncidents(), loadLatencyHistory()]);
  }

  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    showToast('Обновление данных...');
    await loadAllData();
  });

  // --- Initialize App ---
  async function init() {
    await checkAuthStatus();
    if (authState.authenticated) {
      await loadAllData();
    }
    const initialRoute = window.location.pathname || window.location.hash || '/overview';
    navigateTo(initialRoute, false);

    // Start background auto-poll if authenticated
    pollInterval = setInterval(() => {
      if (authState.authenticated) {
        loadAllData();
      }
    }, pollIntervalMs);
  }

  init();
})();
