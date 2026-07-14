// ============================================================
// TODO: заменить на реальный адрес Cloud Function после деплоя (тот же,
// что и в scriptDK.js).
// ============================================================
var CLOUD_FUNCTION_URL = 'https://functions.yandexcloud.net/d4etksl13sj6jgi4cigo';
var PASSWORD_KEY = 'dk_admin_password';
var ACTIVITY_KEY = 'dk_admin_last_activity';
var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут без действий в панели — и снова спросит пароль

function getStoredPassword() {
  return sessionStorage.getItem(PASSWORD_KEY) || '';
}

// Отмечаем момент последнего действия в панели — таймаут отсчитывается
// от него, а не от момента входа (то есть активная работа не обрывается
// по таймеру, а вот забытая открытой вкладка — да).
function touchActivity() {
  sessionStorage.setItem(ACTIVITY_KEY, String(Date.now()));
}

function isSessionExpired() {
  var last = parseInt(sessionStorage.getItem(ACTIVITY_KEY), 10);
  if (!last) return true;
  return (Date.now() - last) > SESSION_TIMEOUT_MS;
}

function clearSession() {
  sessionStorage.removeItem(PASSWORD_KEY);
  sessionStorage.removeItem(ACTIVITY_KEY);
}

function callAdmin(action, data) {
  touchActivity();
  var body = Object.assign({ action: action, adminPassword: getStoredPassword() }, data || {});
  return fetch(CLOUD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) { return res.json().then(function (json) { return { status: res.status, json: json }; }); });
}

var STATUS_LABELS = {
  completed: 'Выполнено',
  no_show: 'Не пришёл',
};

var CONTACT_LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX', call: 'СМС/звонок' };
var INTENT_LABELS = { first_time: 'первый раз', course: 'индивидуальный курс' };

// Кэш загруженных данных — чтобы не дёргать сервер каждый переключением вкладки,
// и чтобы аналитика (считается на клиенте) могла опираться на уже загруженную историю.
var cache = { bookings: [], history: [], clients: {}, requests: [], lastSeenAt: null };

// ============================================================
// Вход
// ============================================================

var loginScreen = document.getElementById('login-screen');
var adminApp = document.getElementById('admin-app');
var loginBtn = document.getElementById('login-btn');
var loginError = document.getElementById('login-error');
var passwordInput = document.getElementById('admin-password-input');

function showApp() {
  loginScreen.hidden = true;
  adminApp.hidden = false;
  loadAll();
}

function showLoginScreen(message) {
  clearSession();
  adminApp.hidden = true;
  loginScreen.hidden = false;
  passwordInput.value = '';
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  }
}

function tryLogin(password) {
  sessionStorage.setItem(PASSWORD_KEY, password);
  touchActivity();
  return callAdmin('adminLogin', {}).then(function (r) {
    if (r.status === 200) {
      showApp();
      return true;
    }
    clearSession();
    loginError.textContent = r.status === 429
      ? 'Слишком много попыток — подождите немного.'
      : 'Неверный пароль.';
    loginError.hidden = false;
    return false;
  }).catch(function (err) {
    console.warn('Бэкенд пока не подключен (CLOUD_FUNCTION_URL — заглушка):', err);
    loginError.hidden = true;
    showApp(); // показываем оболочку панели, чтобы можно было оценить вёрстку до деплоя
    return false;
  });
}

loginBtn.addEventListener('click', function () {
  var pwd = passwordInput.value.trim();
  if (!pwd) return;
  loginError.hidden = true;
  loginBtn.disabled = true;
  tryLogin(pwd).finally(function () { loginBtn.disabled = false; });
});
passwordInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loginBtn.click();
});

document.getElementById('logout-btn').addEventListener('click', function () {
  clearSession();
  location.reload();
});

// Если пароль уже сохранён в этой вкладке браузера — пробуем войти тихо,
// чтобы не заставлять вводить пароль заново при каждой перезагрузке страницы.
// Но если с последнего действия прошло больше получаса — считаем сессию
// истёкшей и просим войти заново, даже если вкладка всё это время была открыта.
if (getStoredPassword()) {
  if (isSessionExpired()) {
    clearSession();
  } else {
    tryLogin(getStoredPassword());
  }
}

// Раз в минуту проверяем, не истёк ли таймаут бездействия, пока панель
// открыта — чтобы забытая открытой вкладка сама вернулась на экран входа,
// а не только при следующем действии.
setInterval(function () {
  if (!adminApp.hidden && isSessionExpired()) {
    showLoginScreen('Сессия истекла из-за бездействия — войдите заново.');
  }
}, 60 * 1000);

// ============================================================
// Вкладки
// ============================================================

document.querySelectorAll('.admin-tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.admin-tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelector('[data-admin-panel="' + btn.getAttribute('data-admin-tab') + '"]').classList.add('active');
  });
});

function loadAll() {
  loadSchedule();
  loadBookings();
  loadHistory();
  loadClients();
  loadRequests();
}

// ============================================================
// Расписание
// ============================================================

function loadSchedule() {
  callAdmin('getSchedule', {}).then(function (r) {
    renderSchedule((r.json && r.json.schedule) || {});
  }).catch(function () { renderSchedule({}); });
}

function createIntervalRow(start, end) {
  var row = document.createElement('div');
  row.className = 'schedule-interval';
  row.innerHTML =
    '<input type="time" class="start-input" value="' + (start || '09:00') + '">' +
    '<span class="dash">—</span>' +
    '<input type="time" class="end-input" value="' + (end || '20:00') + '">' +
    '<button type="button" class="remove-interval-btn" aria-label="Убрать интервал">×</button>';
  row.querySelector('.remove-interval-btn').addEventListener('click', function () {
    row.remove();
  });
  return row;
}

var SCHEDULE_DAYS_AHEAD = 30; // на сколько дней вперёд показываем строки расписания

function pad2(n) { return String(n).padStart(2, '0'); }

function renderSchedule(schedule) {
  var grid = document.getElementById('schedule-grid');
  grid.innerHTML = '';
  var today = new Date();

  for (let i = 0; i < SCHEDULE_DAYS_AHEAD; i++) {
    let d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    let iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    let weekday = d.toLocaleDateString('ru-RU', { weekday: 'short' });
    let dateLabel = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1);

    let saved = schedule[iso];
    // Дни по умолчанию ЗАКРЫТЫ, пока Диана сама не откроет конкретную дату —
    // никакого автооткрытия «на все дни вперёд».
    let isOpen = !!(saved && saved.intervals && saved.intervals.length);
    let intervals = isOpen ? saved.intervals : [{ start: '09:00', end: '20:00' }];

    let dayEl = document.createElement('div');
    dayEl.className = 'schedule-day' + (isOpen ? '' : ' off');
    dayEl.dataset.date = iso;
    dayEl.innerHTML =
      '<div class="schedule-day-head">' +
        '<span class="day-label">' + weekday + ', ' + dateLabel + '</span>' +
        '<label><input type="checkbox" class="open-checkbox" ' + (isOpen ? 'checked' : '') + '> открыт для записи</label>' +
      '</div>' +
      '<div class="schedule-intervals"></div>' +
      '<button type="button" class="add-interval-btn">+ добавить интервал</button>';

    let intervalsWrap = dayEl.querySelector('.schedule-intervals');
    intervalsWrap.hidden = !isOpen;
    dayEl.querySelector('.add-interval-btn').hidden = !isOpen;

    intervals.forEach(function (iv) {
      intervalsWrap.appendChild(createIntervalRow(iv.start, iv.end));
    });

    dayEl.querySelector('.open-checkbox').addEventListener('change', function () {
      var open = this.checked;
      dayEl.classList.toggle('off', !open);
      intervalsWrap.hidden = !open;
      dayEl.querySelector('.add-interval-btn').hidden = !open;
      if (open && intervalsWrap.children.length === 0) {
        intervalsWrap.appendChild(createIntervalRow('09:00', '20:00'));
      }
    });

    dayEl.querySelector('.add-interval-btn').addEventListener('click', function () {
      intervalsWrap.appendChild(createIntervalRow('09:00', '20:00'));
    });

    grid.appendChild(dayEl);
  }
}

document.getElementById('save-schedule-btn').addEventListener('click', function () {
  var schedule = {};
  document.querySelectorAll('.schedule-day').forEach(function (dayEl) {
    var open = dayEl.querySelector('.open-checkbox').checked;
    if (!open) return; // закрытый день — просто не попадает в объект расписания

    var intervals = [];
    dayEl.querySelectorAll('.schedule-interval').forEach(function (row) {
      intervals.push({
        start: row.querySelector('.start-input').value,
        end: row.querySelector('.end-input').value,
      });
    });
    if (intervals.length) schedule[dayEl.dataset.date] = { intervals: intervals };
  });

  var statusEl = document.getElementById('schedule-status');
  callAdmin('saveSchedule', { schedule: schedule }).then(function (r) {
    statusEl.hidden = false;
    if (r.status === 200) {
      statusEl.textContent = 'Расписание сохранено.';
      statusEl.className = 'a-status success';
    } else {
      statusEl.textContent = 'Не получилось сохранить.';
      statusEl.className = 'a-status error';
    }
  }).catch(function () {
    statusEl.hidden = false;
    statusEl.textContent = 'Сервер пока не подключен — это ожидаемо на этапе превью.';
    statusEl.className = 'a-status error';
  });
});

// ============================================================
// Записи (предстоящие)
// ============================================================

function loadBookings() {
  var list = document.getElementById('bookings-list');
  callAdmin('getBookings', {}).then(function (r) {
    cache.bookings = (r.json && r.json.bookings) || [];
    cache.lastSeenAt = r.json && r.json.lastSeenAt;
    renderBookings();
    callAdmin('markBookingsSeen', {}); // отмечаем как просмотренные после рендера
  }).catch(function () {
    list.innerHTML = '<p class="a-empty">Сервер пока не подключен — это ожидаемо на этапе превью.</p>';
  });
}

function renderBookings() {
  var list = document.getElementById('bookings-list');
  var badge = document.getElementById('new-bookings-badge');

  if (cache.bookings.length === 0) {
    list.innerHTML = '<p class="a-empty">Пока нет предстоящих записей.</p>';
    badge.hidden = true;
    return;
  }

  var sorted = cache.bookings.slice().sort(function (a, b) {
    return (a.date + a.start).localeCompare(b.date + b.start);
  });

  var newCount = 0;
  list.innerHTML = '';
  sorted.forEach(function (b) {
    var isNew = cache.lastSeenAt && b.createdAt && b.createdAt > cache.lastSeenAt;
    if (isNew) newCount++;

    var methods = (b.contactMethods || []).map(function (m) { return CONTACT_LABELS[m] || m; }).join(', ');

    var card = document.createElement('div');
    card.className = 'a-card' + (isNew ? ' is-new' : '');
    card.innerHTML =
      '<div class="a-card-top">' +
        '<span class="a-card-date">' + b.date + ', ' + b.start + '–' + b.end + '</span>' +
        (isNew ? '<span class="a-new-badge">Новая</span>' : '') +
      '</div>' +
      '<p class="a-card-service">' + b.serviceName + '</p>' +
      '<p class="a-card-line"><strong>' + b.clientName + '</strong> · ' + b.clientPhone + '</p>' +
      (methods ? '<p class="a-card-line">Связь: ' + methods + '</p>' : '') +
      (b.comment ? '<p class="a-card-line a-card-comment">💬 Комментарий клиента: «' + b.comment + '»</p>' : '') +
      (b.clientNotes ? '<p class="a-card-line">Заметка о клиенте: ' + b.clientNotes + '</p>' : '') +
      (b.servicePrice ? '<p class="a-card-line">' + Number(b.servicePrice).toLocaleString('ru-RU') + ' ₽</p>' : '') +
      '<div class="a-card-actions">' +
        '<button type="button" class="a-btn a-btn-ghost a-btn-small btn-complete">Выполнено</button>' +
        '<button type="button" class="a-btn a-btn-ghost a-btn-small btn-noshow">Не пришёл</button>' +
        '<button type="button" class="a-btn a-btn-danger a-btn-small btn-delete">Удалить</button>' +
      '</div>';

    card.querySelector('.btn-complete').addEventListener('click', function () {
      markBooking(b.id, 'completed');
    });
    card.querySelector('.btn-noshow').addEventListener('click', function () {
      markBooking(b.id, 'no_show');
    });
    card.querySelector('.btn-delete').addEventListener('click', function () {
      if (!confirm('Удалить запись ' + b.clientName + ' на ' + b.date + '?')) return;
      callAdmin('deleteBooking', { bookingId: b.id, notifyCancellation: true }).then(function () {
        loadBookings();
      });
    });

    list.appendChild(card);
  });

  if (newCount > 0) {
    badge.textContent = String(newCount);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function markBooking(bookingId, status) {
  callAdmin('markBooking', { bookingId: bookingId, status: status }).then(function () {
    loadBookings();
    loadHistory();
    loadClients();
  });
}

document.getElementById('refresh-bookings-btn').addEventListener('click', loadBookings);

// ============================================================
// История
// ============================================================

function loadHistory() {
  var list = document.getElementById('history-list');
  callAdmin('getHistory', {}).then(function (r) {
    cache.history = (r.json && r.json.history) || [];
    renderHistory();
    renderAnalytics();
  }).catch(function () {
    list.innerHTML = '<p class="a-empty">Сервер пока не подключен — это ожидаемо на этапе превью.</p>';
  });
}

function renderHistory() {
  var list = document.getElementById('history-list');
  if (cache.history.length === 0) {
    list.innerHTML = '<p class="a-empty">История пока пуста.</p>';
    return;
  }

  var sorted = cache.history.slice().sort(function (a, b) { return (b.date + b.start).localeCompare(a.date + a.start); });

  list.innerHTML = '';
  sorted.forEach(function (h) {
    var card = document.createElement('div');
    card.className = 'a-card';
    card.innerHTML =
      '<div class="a-card-top"><span class="a-card-title">' + h.serviceName + '</span><span class="a-card-meta">' + h.date + ', ' + h.start + '</span></div>' +
      '<p class="a-card-line"><strong>' + h.clientName + '</strong> · ' + h.clientPhone + '</p>' +
      '<p class="a-card-line">' + (STATUS_LABELS[h.status] || h.status) + ' · ' + Number(h.servicePrice || 0).toLocaleString('ru-RU') + ' ₽</p>';
    list.appendChild(card);
  });
}

// ============================================================
// Клиенты
// ============================================================

function loadClients() {
  var list = document.getElementById('clients-list');
  callAdmin('getClients', {}).then(function (r) {
    cache.clients = (r.json && r.json.clients) || {};
    renderClients();
  }).catch(function () {
    list.innerHTML = '<p class="a-empty">Сервер пока не подключен — это ожидаемо на этапе превью.</p>';
  });
}

function renderClients() {
  var list = document.getElementById('clients-list');
  var phones = Object.keys(cache.clients);

  if (phones.length === 0) {
    list.innerHTML = '<p class="a-empty">Пока нет клиентов с завершёнными визитами.</p>';
    return;
  }

  var sorted = phones.map(function (p) { return cache.clients[p]; })
    .sort(function (a, b) { return (b.lastVisit || '').localeCompare(a.lastVisit || ''); });

  list.innerHTML = '';
  sorted.forEach(function (c) {
    var card = document.createElement('div');
    card.className = 'a-card';
    card.innerHTML =
      '<div class="a-card-top"><span class="a-card-title">' + c.name + '</span><span class="a-card-meta">' + c.visits + ' визит(ов)</span></div>' +
      '<p class="a-card-line">' + c.phone + '</p>' +
      '<p class="a-card-line">Потрачено: ' + Number(c.totalSpent || 0).toLocaleString('ru-RU') + ' ₽ · последний визит ' + (c.lastVisit || '—') + '</p>' +
      '<textarea class="a-note-field" rows="2" placeholder="Заметка о клиенте…">' + (c.notes || '') + '</textarea>' +
      '<div class="a-card-actions"><button type="button" class="a-btn a-btn-ghost a-btn-small btn-save-note">Сохранить заметку</button></div>' +
      '<p class="a-status" hidden></p>';

    var statusEl = card.querySelector('.a-status');
    card.querySelector('.btn-save-note').addEventListener('click', function () {
      var notes = card.querySelector('.a-note-field').value;
      callAdmin('saveClientNote', { phone: c.phone, notes: notes }).then(function (r) {
        statusEl.hidden = false;
        statusEl.className = r.status === 200 ? 'a-status success' : 'a-status error';
        statusEl.textContent = r.status === 200 ? 'Сохранено.' : 'Не получилось сохранить.';
      });
    });

    list.appendChild(card);
  });
}

// ============================================================
// Аналитика (считается на клиенте из уже загруженной истории)
// ============================================================

function renderAnalytics() {
  var cardsEl = document.getElementById('analytics-cards');
  var topEl = document.getElementById('analytics-top');

  var completed = cache.history.filter(function (h) { return h.status === 'completed'; });
  var noShows = cache.history.filter(function (h) { return h.status === 'no_show'; });
  var totalRevenue = completed.reduce(function (s, h) { return s + (h.servicePrice || 0); }, 0);

  var now = new Date();
  var monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var monthRevenue = completed
    .filter(function (h) { return (h.date || '').startsWith(monthPrefix); })
    .reduce(function (s, h) { return s + (h.servicePrice || 0); }, 0);

  cardsEl.innerHTML =
    '<div class="analytics-card"><span class="value">' + totalRevenue.toLocaleString('ru-RU') + ' ₽</span><span class="label">выручка всего</span></div>' +
    '<div class="analytics-card"><span class="value">' + monthRevenue.toLocaleString('ru-RU') + ' ₽</span><span class="label">выручка за этот месяц</span></div>' +
    '<div class="analytics-card"><span class="value">' + completed.length + '</span><span class="label">выполненных визитов</span></div>' +
    '<div class="analytics-card"><span class="value">' + noShows.length + '</span><span class="label">не пришли</span></div>';

  var counts = {};
  completed.forEach(function (h) { counts[h.serviceName] = (counts[h.serviceName] || 0) + 1; });
  var top = Object.keys(counts).map(function (name) { return { name: name, count: counts[name] }; })
    .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

  if (top.length === 0) {
    topEl.innerHTML = '';
    return;
  }
  topEl.innerHTML = '<h3>Популярные услуги</h3>' + top.map(function (t) {
    return '<div class="analytics-top-row"><span>' + t.name + '</span><span>' + t.count + '</span></div>';
  }).join('');
}

// ============================================================
// Заявки на консультацию
// ============================================================

function loadRequests() {
  var list = document.getElementById('requests-list');
  callAdmin('getConsultationRequests', {}).then(function (r) {
    cache.requests = (r.json && r.json.requests) || [];
    renderRequests();
  }).catch(function () {
    list.innerHTML = '<p class="a-empty">Сервер пока не подключен — это ожидаемо на этапе превью.</p>';
  });
}

function renderRequests() {
  var list = document.getElementById('requests-list');
  var badge = document.getElementById('new-requests-badge');

  if (cache.requests.length === 0) {
    list.innerHTML = '<p class="a-empty">Пока нет заявок на консультацию.</p>';
    badge.hidden = true;
    return;
  }

  badge.textContent = String(cache.requests.length);
  badge.hidden = false;

  var sorted = cache.requests.slice().sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });

  list.innerHTML = '';
  sorted.forEach(function (req) {
    var intents = (req.intents || []).map(function (i) { return INTENT_LABELS[i] || i; }).join(', ');
    var card = document.createElement('div');
    card.className = 'a-card';
    card.innerHTML =
      '<div class="a-card-top"><span class="a-card-title">' + req.name + '</span><span class="a-card-meta">' + (req.createdAt ? req.createdAt.slice(0, 10) : '') + '</span></div>' +
      '<p class="a-card-line">' + req.phone + '</p>' +
      '<p class="a-card-line">Интерес: ' + intents + '</p>' +
      (req.comment ? '<p class="a-card-line">' + req.comment + '</p>' : '') +
      '<div class="a-card-actions"><button type="button" class="a-btn a-btn-danger a-btn-small btn-delete-request">Обработано — удалить</button></div>';

    card.querySelector('.btn-delete-request').addEventListener('click', function () {
      callAdmin('deleteConsultationRequest', { requestId: req.id }).then(function () { loadRequests(); });
    });

    list.appendChild(card);
  });
}
