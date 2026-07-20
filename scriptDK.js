// ============================================================
// TODO: заменить на реальный адрес Cloud Function после деплоя.
// Пока функция не задеплоена, все fetch-запросы обёрнуты в try/catch
// и деградируют мягко (форма всё равно работает, просто без реальной
// отправки на сервер) — чтобы сайт можно было смотреть уже сейчас.
// ============================================================
var CLOUD_FUNCTION_URL = 'https://functions.yandexcloud.net/d4etksl13sj6jgi4cigo';

function callBackend(action, data) {
  return fetch(CLOUD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, data)),
  }).then(function (res) { return res.json(); });
}

// Экранирование перед вставкой в innerHTML — на этой странице это в
// основном свои же данные, которые пользователь только что ввёл сам
// (self-XSS низкой критичности), но serviceName в «Моих записях»
// приходит с сервера по чужому запросу (getBookingsByPhone) — это уже
// не self-XSS, поэтому экранируем везде одинаково, а не выборочно.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Автоформатирование телефона в +7 (900) 000-00-00 по мере ввода
function formatPhoneDigits(digits) {
  if (digits.charAt(0) === '8') digits = '7' + digits.slice(1);
  if (digits.charAt(0) !== '7') digits = '7' + digits;
  digits = digits.slice(0, 11);

  var rest = digits.slice(1);
  var out = '+7';
  if (rest.length > 0) out += ' (' + rest.slice(0, 3);
  if (rest.length >= 3) out += ')';
  if (rest.length > 3) out += ' ' + rest.slice(3, 6);
  if (rest.length > 6) out += '-' + rest.slice(6, 8);
  if (rest.length > 8) out += '-' + rest.slice(8, 10);
  return out;
}

function attachPhoneMask(input) {
  if (!input) return;

  // Backspace обрабатываем отдельно: если просто дать браузеру стереть
  // последний символ строки, это часто окажется «)» или «-», а не цифра —
  // форматтер тут же перерисует ту же скобку на то же место, и внешне
  // ничего не изменится (залипает на границе скобок). Поэтому явно
  // убираем последнюю ЦИФРУ, а не последний символ.
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    e.preventDefault();
    var digits = input.value.replace(/\D/g, '');
    digits = digits.slice(0, -1);
    input.value = digits ? formatPhoneDigits(digits) : '';
  });

  input.addEventListener('input', function () {
    var digits = input.value.replace(/\D/g, '');
    input.value = digits ? formatPhoneDigits(digits) : '';
  });
  input.addEventListener('focus', function () {
    if (!input.value) input.value = '+7 ';
  });
}

document.querySelectorAll('input[type="tel"]').forEach(attachPhoneMask);

// Переключение вкладок каталога услуг
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var target = btn.getAttribute('data-tab');

    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.remove('active');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.remove('active');
    });

    btn.classList.add('active');
    document.getElementById(target).classList.add('active');
  });
});

// Модальное окно записи на консультацию
var consultModal = document.getElementById('consult-modal');
var openModalBtn = document.getElementById('open-consult-modal');
var closeModalBtn = document.getElementById('close-consult-modal');

if (consultModal && openModalBtn) {
  openModalBtn.addEventListener('click', function () {
    consultModal.showModal();
  });
}
if (consultModal && closeModalBtn) {
  closeModalBtn.addEventListener('click', function () {
    consultModal.close();
  });
}
if (consultModal) {
  // закрытие по клику на подложку
  consultModal.addEventListener('click', function (e) {
    if (e.target === consultModal) consultModal.close();
  });
}

// Форма записи на консультацию
var consultForm = document.getElementById('consult-form');
if (consultForm) {
  consultForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var name = consultForm.name.value.trim();
    var phone = consultForm.phone.value.trim();
    var consent = consultForm.consent.checked;
    var intents = Array.prototype.slice
      .call(consultForm.querySelectorAll('input[name="intent"]:checked'))
      .map(function (el) { return el.value; });

    var errorEl = document.getElementById('consult-error');

    if (!name || !phone || !consent || intents.length === 0) {
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    callBackend('createConsultationRequest', {
      request: {
        name: name,
        phone: phone,
        comment: consultForm.comment.value.trim(),
        intents: intents,
      },
    }).catch(function (err) {
      console.warn('Не удалось отправить заявку на бэкенд (URL ещё не настроен?):', err);
    });

    consultForm.hidden = true;
    document.getElementById('consult-success').hidden = false;
  });
}

// ============================================================
// Форма записи — шаг 1 (выбор услуг) встроен прямо в каталог выше,
// шаги 2-4 — в секции #zapis.
// ============================================================

var selectedServices = []; // { key, name, duration (мин), price }

function serviceKey(name, duration, price) {
  return name + '|' + duration + '|' + price;
}

function updateBookingBar() {
  var bar = document.getElementById('booking-bar');
  var summaryEl = document.getElementById('booking-bar-summary');
  if (!bar || !summaryEl) return;

  if (selectedServices.length === 0) {
    bar.hidden = true;
    return;
  }

  var totalMin = selectedServices.reduce(function (s, x) { return s + x.duration; }, 0);
  var totalPrice = selectedServices.reduce(function (s, x) { return s + x.price; }, 0);
  summaryEl.textContent = 'Выбрано: ' + selectedServices.length + ' · ' + totalMin + ' мин · ' + totalPrice.toLocaleString('ru-RU') + ' ₽';
  bar.hidden = false;
}

// Клик по кнопке варианта услуги (60/90 мин и т.п., включая SPA) —
// делегирование на весь документ, чтобы работало и для уже раскрытых
// карточек, и стопаем всплытие, чтобы не дёргать открытие/закрытие
// аккордеона у <details>-карточек.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.variant-pick');
  if (!btn) return;
  e.stopPropagation();

  var name = btn.getAttribute('data-name');
  var duration = parseInt(btn.getAttribute('data-duration'), 10);
  var price = parseInt(btn.getAttribute('data-price'), 10);
  if (!name || !duration || !price) return; // на всякий случай, если что-то не распарсилось

  var key = serviceKey(name, duration, price);
  var idx = selectedServices.findIndex(function (s) { return s.key === key; });

  // У одной услуги с несколькими вариантами длительности можно выбрать
  // только один (60 ИЛИ 90, не оба сразу) — снимаем выбор с соседей
  // по этой же карточке перед тем как переключить текущую кнопку.
  var variantsWrap = btn.closest('.service-variants');
  if (variantsWrap) {
    variantsWrap.querySelectorAll('.variant-pick.picked').forEach(function (sibling) {
      if (sibling === btn) return;
      sibling.classList.remove('picked');
      var sKey = serviceKey(
        sibling.getAttribute('data-name'),
        parseInt(sibling.getAttribute('data-duration'), 10),
        parseInt(sibling.getAttribute('data-price'), 10)
      );
      var sIdx = selectedServices.findIndex(function (s) { return s.key === sKey; });
      if (sIdx !== -1) selectedServices.splice(sIdx, 1);
    });
  }

  if (idx === -1) {
    selectedServices.push({ key: key, name: name, duration: duration, price: price });
    btn.classList.add('picked');
  } else {
    selectedServices.splice(idx, 1);
    btn.classList.remove('picked');
  }

  var card = btn.closest('.service-card, .service-expandable, .spa-card');
  if (card) {
    var anyPicked = card.querySelectorAll('.variant-pick.picked').length > 0;
    card.classList.toggle('has-picked', anyPicked);
  }

  updateBookingBar();
}, true); // capture: перехватываем раньше нативного toggle у <details>

// ---------- Переход к шагам 2-4 ----------

var bookingSection = document.getElementById('zapis');
var bookingBarNext = document.getElementById('booking-bar-next');

if (bookingBarNext) {
  bookingBarNext.addEventListener('click', function () {
    if (selectedServices.length === 0) return;
    bookingSection.hidden = false;

    var listEl = document.getElementById('step2-services-list');
    if (listEl) {
      listEl.textContent = selectedServices.map(function (s) { return s.name + ' (' + s.duration + ' мин)'; }).join(', ');
    }

    lockServicesCatalog();
    goToStep(2);
    buildDatePicker();
    bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Как только клиент ушёл дальше шага 1 — фиксируем выбор услуг наверху,
// чтобы случайный клик там не разъехался с уже открытыми шагами 2-4.
// Разблокируется кнопкой «К услугам».
function lockServicesCatalog() {
  var servicesSection = document.getElementById('uslugi');
  if (servicesSection) servicesSection.classList.add('services-locked');
}

function unlockServicesCatalog() {
  var servicesSection = document.getElementById('uslugi');
  if (servicesSection) servicesSection.classList.remove('services-locked');
}

// ---------- Навигация по шагам ----------

function goToStep(n) {
  document.querySelectorAll('.booking-step').forEach(function (el) {
    el.hidden = (parseInt(el.getAttribute('data-step'), 10) !== n);
  });
  document.querySelectorAll('.progress-step').forEach(function (el, i) {
    el.classList.toggle('active', i + 1 <= n);
  });
}

document.querySelectorAll('[data-back]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var target = parseInt(btn.getAttribute('data-back'), 10);
    if (target === 1) {
      unlockServicesCatalog();
      bookingSection.hidden = true;
      document.getElementById('uslugi').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    goToStep(target);
  });
});

// ---------- Шаг 2: календарь и слоты ----------

var pickedDate = null; // 'YYYY-MM-DD'
var pickedStart = null; // 'HH:MM'
var bookedSlotsCache = null;
var scheduleCache = null;

var GRID_STEP_MIN = 30;        // шаг календаря — 30 минут (буфер между визитами отдельно, 15 мин)
var BUFFER_MIN = 15;

// Минимальный лид-тайм: за сколько минут до начала слота ещё можно записаться.
// Сейчас 60 мин (по договорённости с Дианой на июль 2026, "не менее часа") —
// может смениться на "не менее суток", если так решит заказчик. Значение то
// же самое (в минутах) продублировано на бэкенде в index.js — если меняете
// здесь, поменяйте и там.
var MIN_LEAD_MINUTES = 60;

function pad2(n) { return String(n).padStart(2, '0'); }

// Момент времени (мс от эпохи) для даты+времени слота. Часовой пояс берём
// явным смещением +03:00 (МСК, без перехода на летнее/зимнее время), а не
// полагаемся на часовой пояс браузера клиента — так дата/время слота
// трактуется одинаково независимо от того, где физически находится клиент
// или как настроены часы на его устройстве.
function slotTimestamp(dateIso, timeStr) {
  return new Date(dateIso + 'T' + timeStr + ':00+03:00').getTime();
}

// Самый ранний момент, на который ещё можно записаться прямо сейчас
// (текущее время + лид-тайм).
function earliestBookableTimestamp() {
  return Date.now() + MIN_LEAD_MINUTES * 60 * 1000;
}

// Реальное расписание работы мастера — задаётся в админ-панели (вкладка «Расписание»)
// по КОНКРЕТНЫМ датам, не по дням недели: Диана открывает дни вперёд сама,
// всё остальное по умолчанию закрыто.
function fetchSchedule() {
  if (scheduleCache) return Promise.resolve(scheduleCache);
  return callBackend('getSchedule', {})
    .then(function (res) {
      scheduleCache = (res && res.schedule) || {};
      return scheduleCache;
    })
    .catch(function (err) {
      console.warn('Не удалось получить расписание (URL бэкенда ещё не настроен?):', err);
      scheduleCache = {};
      return scheduleCache;
    });
}

// Возвращает массив интервалов [{ start, end }] в минутах для конкретной даты
// (может быть несколько интервалов — например, до и после обеда), или пустой
// массив, если дата не открыта Дианой в админке.
function getDayIntervals(dateIso, schedule) {
  var day = schedule[dateIso];
  if (!day || !Array.isArray(day.intervals)) return [];
  return day.intervals
    .filter(function (iv) { return iv && iv.start && iv.end; })
    .map(function (iv) { return { start: timeToMin(iv.start), end: timeToMin(iv.end) }; });
}

// Проверяет, есть ли в интервалах дня хотя бы один свободный слот под
// нужную длительность — та же логика, что и в buildTimeSlots ниже, но
// без построения самих кнопок (нужен только факт "есть/нет"). Используется
// в календаре дат, чтобы зачёркивать не только полностью закрытые дни,
// но и открытые, но уже целиком занятые под выбранные услуги.
// dateIso нужен, чтобы отсечь слоты, до начала которых осталось меньше
// MIN_LEAD_MINUTES (актуально для сегодняшнего и — в теории — завтрашнего
// раннего утра, если лид-тайм когда-нибудь перевалит через полночь).
function hasAnyAvailableSlot(intervals, dayBooked, totalDuration, dateIso) {
  var cutoff = earliestBookableTimestamp();
  return intervals.some(function (hours) {
    for (var start = hours.start; start + totalDuration <= hours.end; start += GRID_STEP_MIN) {
      if (slotTimestamp(dateIso, minToTime(start)) < cutoff) continue;
      var end = start + totalDuration;
      var candStart = start - BUFFER_MIN;
      var candEnd = end + BUFFER_MIN;
      var conflict = dayBooked.some(function (b) {
        var bStart = timeToMin(b.start);
        var bEnd = timeToMin(b.end);
        return candStart < bEnd && candEnd > bStart;
      });
      if (!conflict) return true;
    }
    return false;
  });
}

function buildDatePicker() {
  var wrap = document.getElementById('date-picker');
  if (!wrap) return;
  wrap.innerHTML = '<p class="booking-step-placeholder">Загружаю расписание…</p>';

  var totalDuration = selectedServices.reduce(function (s, x) { return s + x.duration; }, 0);

  Promise.all([fetchSchedule(), fetchBookedSlots()]).then(function (results) {
    var schedule = results[0];
    var booked = results[1];

    wrap.innerHTML = '';
    var today = new Date();
    for (var i = 0; i < 21; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      var weekday = d.toLocaleDateString('ru-RU', { weekday: 'short' });
      var dayNum = d.getDate();

      var intervals = getDayIntervals(iso, schedule);
      var dayBooked = booked.filter(function (b) { return b.date === iso; });
      var isOff = intervals.length === 0 || !hasAnyAvailableSlot(intervals, dayBooked, totalDuration, iso);

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'date-chip';
      chip.dataset.date = iso;
      chip.disabled = isOff;
      chip.innerHTML = '<span>' + weekday + '</span><span class="date-chip-day">' + dayNum + '</span>';
      if (!isOff) {
        chip.addEventListener('click', function () {
          wrap.querySelectorAll('.date-chip').forEach(function (c) { c.classList.remove('picked'); });
          this.classList.add('picked');
          pickedDate = this.dataset.date;
          pickedStart = null;
          document.getElementById('to-step-3').disabled = true;
          buildTimeSlots();
        });
      }
      wrap.appendChild(chip);
    }
  });
}

function timeToMin(t) {
  var parts = t.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minToTime(m) {
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

function fetchBookedSlots() {
  if (bookedSlotsCache) return Promise.resolve(bookedSlotsCache);
  return callBackend('getBookedSlots', {})
    .then(function (res) {
      bookedSlotsCache = (res && res.slots) || [];
      return bookedSlotsCache;
    })
    .catch(function (err) {
      console.warn('Не удалось получить занятые слоты (URL бэкенда ещё не настроен?):', err);
      bookedSlotsCache = [];
      return bookedSlotsCache;
    });
}

function buildTimeSlots() {
  var wrap = document.getElementById('time-picker');
  if (!wrap || !pickedDate) return;
  wrap.innerHTML = '<p class="booking-step-placeholder">Загружаю занятые слоты…</p>';

  var totalDuration = selectedServices.reduce(function (s, x) { return s + x.duration; }, 0);

  Promise.all([fetchSchedule(), fetchBookedSlots()]).then(function (results) {
    var schedule = results[0];
    var booked = results[1];
    var intervals = getDayIntervals(pickedDate, schedule);

    wrap.innerHTML = '';

    if (intervals.length === 0) {
      wrap.innerHTML = '<p class="booking-step-placeholder">В этот день мастер не работает — выберите другую дату.</p>';
      return;
    }

    var dayBooked = booked.filter(function (b) { return b.date === pickedDate; });
    var any = false;

    // Слоты ближе, чем MIN_LEAD_MINUTES до начала (включая уже прошедшие),
    // недоступны — иначе можно "записаться" впритык или на ушедшее время.
    var cutoff = earliestBookableTimestamp();

    intervals.forEach(function (hours) {
      for (var start = hours.start; start + totalDuration <= hours.end; start += GRID_STEP_MIN) {
        var end = start + totalDuration;
        var candStart = start - BUFFER_MIN;
        var candEnd = end + BUFFER_MIN;
        var isTooSoon = slotTimestamp(pickedDate, minToTime(start)) < cutoff;

        var conflict = dayBooked.some(function (b) {
          var bStart = timeToMin(b.start);
          var bEnd = timeToMin(b.end);
          return candStart < bEnd && candEnd > bStart;
        });

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'time-slot';
        btn.textContent = minToTime(start);
        btn.disabled = conflict || isTooSoon;
        if (!conflict && !isTooSoon) {
          any = true;
          btn.addEventListener('click', function () {
            wrap.querySelectorAll('.time-slot').forEach(function (s) { s.classList.remove('picked'); });
            this.classList.add('picked');
            pickedStart = this.textContent;
            document.getElementById('to-step-3').disabled = false;
          });
        }
        wrap.appendChild(btn);
      }
    });

    if (!any) {
      wrap.innerHTML = '<p class="booking-step-placeholder">На эту дату свободных слотов не осталось — выберите другой день.</p>';
    }
  });
}

var toStep3Btn = document.getElementById('to-step-3');
if (toStep3Btn) {
  toStep3Btn.addEventListener('click', function () {
    if (!pickedDate || !pickedStart) return;
    goToStep(3);
  });
}

// ---------- Шаг 3: контакты ----------

var toStep4Btn = document.getElementById('to-step-4');
if (toStep4Btn) {
  toStep4Btn.addEventListener('click', function () {
    var form = document.getElementById('booking-contact-form');
    var errorEl = document.getElementById('step3-error');
    var name = form.name.value.trim();
    var phone = form.phone.value.trim();
    var consent = form.consent.checked;
    var methods = Array.prototype.slice
      .call(form.querySelectorAll('input[name="contactMethod"]:checked'))
      .map(function (el) { return el.value; });

    if (!name || !phone || !consent || methods.length === 0) {
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    buildFinalSummary();
    goToStep(4);
  });
}

var CONTACT_METHOD_LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX', call: 'СМС/звонок' };

function buildFinalSummary() {
  var el = document.getElementById('booking-final-summary');
  if (!el) return;

  var form = document.getElementById('booking-contact-form');
  var totalMin = selectedServices.reduce(function (s, x) { return s + x.duration; }, 0);
  var totalPrice = selectedServices.reduce(function (s, x) { return s + x.price; }, 0);
  var methods = Array.prototype.slice
    .call(form.querySelectorAll('input[name="contactMethod"]:checked'))
    .map(function (el) { return CONTACT_METHOD_LABELS[el.value] || el.value; });

  var endMin = timeToMin(pickedStart) + totalMin;

  el.innerHTML =
    '<p><strong>Услуги:</strong> ' + escapeHtml(selectedServices.map(function (s) { return s.name + ' (' + s.duration + ' мин)'; }).join(', ')) + '</p>' +
    '<p><strong>Дата и время:</strong> ' + escapeHtml(pickedDate) + ', ' + escapeHtml(pickedStart) + '–' + escapeHtml(minToTime(endMin)) + '</p>' +
    '<p><strong>Имя:</strong> ' + escapeHtml(form.name.value.trim()) + '</p>' +
    '<p><strong>Телефон:</strong> ' + escapeHtml(form.phone.value.trim()) + '</p>' +
    '<p><strong>Связь:</strong> ' + escapeHtml(methods.join(', ')) + '</p>' +
    '<p class="summary-total">Итого: ' + totalPrice.toLocaleString('ru-RU') + ' ₽</p>';
}

// ---------- Шаг 4: подтверждение и отправка ----------

var confirmBtn = document.getElementById('confirm-booking');
if (confirmBtn) {
  confirmBtn.addEventListener('click', function () {
    var form = document.getElementById('booking-contact-form');
    var totalMin = selectedServices.reduce(function (s, x) { return s + x.duration; }, 0);
    var totalPrice = selectedServices.reduce(function (s, x) { return s + x.price; }, 0);
    var methods = Array.prototype.slice
      .call(form.querySelectorAll('input[name="contactMethod"]:checked'))
      .map(function (el) { return el.value; });
    var endMin = timeToMin(pickedStart) + totalMin;

    var booking = {
      id: 'dk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      date: pickedDate,
      start: pickedStart,
      end: minToTime(endMin),
      serviceName: selectedServices.map(function (s) { return s.name; }).join(', '),
      serviceDuration: totalMin,
      servicePrice: totalPrice,
      clientName: form.name.value.trim(),
      clientPhone: form.phone.value.trim(),
      comment: form.comment.value.trim(),
      contactMethods: methods,
    };

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Записываем…';

    callBackend('createBooking', { booking: booking })
      .then(function (res) {
        if (res && res.ok) {
          document.querySelectorAll('.booking-step').forEach(function (el) { el.hidden = true; });
          document.getElementById('booking-progress').hidden = true;
          document.getElementById('booking-success').hidden = false;
          document.getElementById('booking-success-details').textContent =
            selectedServices.map(function (s) { return s.name; }).join(', ') + ' — ' + pickedDate + ', ' + pickedStart;
          document.getElementById('booking-bar').hidden = true;
        } else if (res && res.error === 'slot-taken') {
          alert('Это время уже заняли, пока вы оформляли запись. Выберите другое время.');
          goToStep(2);
          buildTimeSlots();
        } else {
          alert('Не получилось записаться. Попробуйте ещё раз или напишите нам напрямую.');
        }
      })
      .catch(function (err) {
        console.warn('Бэкенд пока не подключен (CLOUD_FUNCTION_URL — заглушка):', err);
        alert('Форма готова, но ещё не подключена к серверу — это нормально на этапе превью.');
      })
      .finally(function () {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Подтвердить запись';
      });
  });
}

var bookAgainBtn = document.getElementById('book-again-btn');
if (bookAgainBtn) {
  bookAgainBtn.addEventListener('click', function () {
    // Сброс выбора услуг
    selectedServices = [];
    document.querySelectorAll('.variant-pick.picked').forEach(function (btn) { btn.classList.remove('picked'); });
    document.querySelectorAll('.service-card.has-picked, .service-expandable.has-picked, .spa-card.has-picked')
      .forEach(function (card) { card.classList.remove('has-picked'); });
    unlockServicesCatalog();
    document.getElementById('booking-bar').hidden = true;

    // Сброс даты/времени
    pickedDate = null;
    pickedStart = null;
    bookedSlotsCache = null; // на новую запись слоты могли уже измениться

    // Сброс формы контактов
    var contactForm = document.getElementById('booking-contact-form');
    if (contactForm) contactForm.reset();

    // Возврат к шагу 2 (пустому) и скрытие экрана успеха
    document.getElementById('booking-progress').hidden = false;
    document.getElementById('booking-success').hidden = true;
    goToStep(2);
    document.getElementById('to-step-3').disabled = true;
    document.getElementById('date-picker').innerHTML = '';
    document.getElementById('time-picker').innerHTML = '<p class="booking-step-placeholder">Сначала выберите дату выше.</p>';
    bookingSection.hidden = true;

    document.getElementById('uslugi').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ============================================================
// Модалка «Мои записи» — поиск по телефону, отмена, перенос
// ============================================================

var mybookingsModal = document.getElementById('mybookings-modal');
var openMybookingsBtn = document.getElementById('open-mybookings-modal');
var closeMybookingsBtn = document.getElementById('close-mybookings-modal');

if (mybookingsModal && openMybookingsBtn) {
  openMybookingsBtn.addEventListener('click', function () {
    mybookingsModal.showModal();
  });
}
if (mybookingsModal && closeMybookingsBtn) {
  closeMybookingsBtn.addEventListener('click', function () { mybookingsModal.close(); });
}
if (mybookingsModal) {
  mybookingsModal.addEventListener('click', function (e) {
    if (e.target === mybookingsModal) mybookingsModal.close();
  });
}

var mybookingsFindBtn = document.getElementById('mybookings-find-btn');
if (mybookingsFindBtn) {
  mybookingsFindBtn.addEventListener('click', function () {
    var phoneInput = document.getElementById('mybookings-phone');
    var errorEl = document.getElementById('mybookings-error');
    var resultsEl = document.getElementById('mybookings-results');
    var phone = phoneInput.value.trim();
    var digits = phone.replace(/\D/g, '');

    if (digits.length < 10) {
      errorEl.textContent = 'Введите номер телефона полностью.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    mybookingsFindBtn.disabled = true;
    mybookingsFindBtn.textContent = 'Ищем…';

    callBackend('getBookingsByPhone', { phone: phone })
      .then(function (res) {
        var bookings = (res && res.bookings) || [];
        if (bookings.length === 0) {
          errorEl.textContent = 'Не нашли записей на этот номер — проверьте, что ввели верно.';
          errorEl.hidden = false;
          resultsEl.hidden = true;
          return;
        }
        renderMybookings(bookings, phone);
        resultsEl.hidden = false;
      })
      .catch(function (err) {
        console.warn('Бэкенд пока не подключен (CLOUD_FUNCTION_URL — заглушка):', err);
        errorEl.textContent = 'Сервер пока не подключен — это ожидаемо на этапе превью.';
        errorEl.hidden = false;
      })
      .finally(function () {
        mybookingsFindBtn.disabled = false;
        mybookingsFindBtn.textContent = 'Найти мои записи';
      });
  });
}

function renderMybookings(bookings, phone) {
  var resultsEl = document.getElementById('mybookings-results');
  resultsEl.innerHTML = '';

  bookings.forEach(function (b) {
    var card = document.createElement('div');
    card.className = 'mybooking-card';
    card.innerHTML =
      '<p class="mybooking-service">' + escapeHtml(b.serviceName) + '</p>' +
      '<p>' + escapeHtml(b.date) + ', ' + escapeHtml(b.start) + '–' + escapeHtml(b.end) + '</p>' +
      '<div class="mybooking-actions">' +
        '<button type="button" class="btn btn-ghost btn-reschedule">Перенести</button>' +
        '<button type="button" class="btn btn-ghost btn-cancel">Отменить запись</button>' +
      '</div>' +
      '<div class="mybooking-reschedule-panel" hidden></div>' +
      '<p class="mybooking-status" hidden></p>';

    var statusEl = card.querySelector('.mybooking-status');

    // ---- Отмена ----
    card.querySelector('.btn-cancel').addEventListener('click', function () {
      if (!confirm('Точно отменить запись на ' + b.date + ', ' + b.start + '?')) return;

      callBackend('cancelBookingByPhone', { phone: phone, id: b.id })
        .then(function (res) {
          if (res && res.ok) {
            card.classList.add('is-cancelled');
            card.querySelector('.mybooking-actions').hidden = true;
            statusEl.textContent = '✅ Запись отменена';
            statusEl.className = 'mybooking-status success';
            statusEl.hidden = false;
          } else {
            statusEl.textContent = 'Не получилось отменить. Попробуйте ещё раз.';
            statusEl.className = 'mybooking-status error';
            statusEl.hidden = false;
          }
        })
        .catch(function (err) {
          console.warn('Бэкенд пока не подключен:', err);
          statusEl.textContent = 'Сервер пока не подключен — это ожидаемо на этапе превью.';
          statusEl.className = 'mybooking-status error';
          statusEl.hidden = false;
        });
    });

    // ---- Перенос (только в пределах того же дня) ----
    card.querySelector('.btn-reschedule').addEventListener('click', function () {
      var panel = card.querySelector('.mybooking-reschedule-panel');
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.hidden = false;
      buildRescheduleSlots(panel, b, phone, statusEl);
    });

    resultsEl.appendChild(card);
  });
}

function buildRescheduleSlots(panel, booking, phone, statusEl) {
  panel.innerHTML = '<p class="booking-step-hint">Новое время в пределах ' + escapeHtml(booking.date) + ':</p><div class="time-picker"></div>';
  var picker = panel.querySelector('.time-picker');
  var duration = timeToMin(booking.end) - timeToMin(booking.start);

  Promise.all([
    fetchSchedule(),
    callBackend('getBookedSlots', {}).then(function (res) { return (res && res.slots) || []; }).catch(function () { return []; }),
  ])
    .then(function (results) {
      var schedule = results[0];
      var allSlots = results[1];
      var intervals = getDayIntervals(booking.date, schedule);

      picker.innerHTML = '';

      if (intervals.length === 0) {
        picker.innerHTML = '<p class="booking-step-placeholder">В этот день мастер не работает.</p>';
        return;
      }

      // Исключаем собственный текущий слот этой же брони из проверки конфликтов —
      // иначе бронь будет «конфликтовать сама с собой» на своём же текущем времени.
      var dayBooked = allSlots.filter(function (s) {
        return s.date === booking.date && !(s.start === booking.start && s.end === booking.end);
      });

      var any = false;

      // Перенос в пределах того же дня — те же MIN_LEAD_MINUTES, что и при
      // обычной записи (та же логика, что в buildTimeSlots).
      var cutoff = earliestBookableTimestamp();

      intervals.forEach(function (hours) {
        for (var start = hours.start; start + duration <= hours.end; start += GRID_STEP_MIN) {
          var end = start + duration;
          var candStart = start - BUFFER_MIN;
          var candEnd = end + BUFFER_MIN;
          var isTooSoon = slotTimestamp(booking.date, minToTime(start)) < cutoff;

          var conflict = dayBooked.some(function (s) {
            var sStart = timeToMin(s.start);
            var sEnd = timeToMin(s.end);
            return candStart < sEnd && candEnd > sStart;
          });

          var slotBtn = document.createElement('button');
          slotBtn.type = 'button';
          slotBtn.className = 'time-slot';
          slotBtn.textContent = minToTime(start);
          slotBtn.disabled = conflict || isTooSoon;
          if (minToTime(start) === booking.start) slotBtn.classList.add('picked');

          if (!conflict && !isTooSoon) {
            any = true;
            slotBtn.addEventListener('click', function () {
              var newStart = this.textContent;
              callBackend('rescheduleBookingByPhone', { phone: phone, id: booking.id, newStart: newStart })
                .then(function (res) {
                  if (res && res.ok) {
                    statusEl.textContent = 'Перенесено на ' + newStart + '.';
                    statusEl.className = 'mybooking-status success';
                    statusEl.hidden = false;
                    panel.hidden = true;
                  } else if (res && res.error === 'slot-taken') {
                    statusEl.textContent = 'Это время уже заняли. Выберите другое.';
                    statusEl.className = 'mybooking-status error';
                    statusEl.hidden = false;
                  } else {
                    statusEl.textContent = 'Не получилось перенести. Попробуйте ещё раз.';
                    statusEl.className = 'mybooking-status error';
                    statusEl.hidden = false;
                  }
                })
                .catch(function (err) {
                  console.warn('Бэкенд пока не подключен:', err);
                  statusEl.textContent = 'Сервер пока не подключен — это ожидаемо на этапе превью.';
                  statusEl.className = 'mybooking-status error';
                  statusEl.hidden = false;
                });
            });
          }
          picker.appendChild(slotBtn);
        }
      });

      if (!any) {
        picker.innerHTML = '<p class="booking-step-placeholder">На этот день свободных слотов не осталось.</p>';
      }
    });
}
