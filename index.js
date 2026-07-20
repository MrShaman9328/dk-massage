// ============================================================
// DK MASSAGE — Cloud Function (студия массажа Дианы Коноплёвой)
// Хранит данные как JSON-файлы в Yandex Object Storage:
//   schedule.json               — расписание мастера
//   bookings.json                — предстоящие записи
//   history.json                 — завершённые записи (выполнено/не пришёл)
//   clients.json                 — база клиентов (ключ — номер телефона)
//   consultation-requests.json   — заявки на консультацию (без даты/времени/услуги)
//
// Архитектурная основа — проект РАЙ, адаптирована под DK. Отличия от РАЙ,
// зафиксированные сознательно (см. историю обсуждения):
//   1. Дневной лимит нагрузки — ПОЛНОСТЬЮ УБРАН (в РАЙ был 5–6ч/день).
//   2. Буфер между визитами — оставлен 15 минут (шаг календаря на фронте
//      при этом 30 минут — это независимые друг от друга параметры,
//      буфер не пересчитывается под шаг сетки).
//   3. Отмена/перенос брони — ТОЛЬКО по телефону. 6-значный код отмены
//      (как в исходной версии РАЙ) сюда не перенесён — по фидбеку
//      от Дарьи с РАЯ, клиенты код забывают, для нового проекта он не нужен.
//   4. Уведомления клиентам и n8n/VM/Caddy — НЕ используются вообще
//      (нет ни привязки chat_id, ни почасовых напоминаний). Только
//      уведомления мастеру, прямо из Cloud Function, как и в РАЙ.
//   5. Новое поле в брони — contactMethods (массив, 1–4 значения):
//      как клиент хочет, чтобы с ним связались для подтверждения.
//   6. Новая сущность — заявки на консультацию (createConsultationRequest
//      и админские getConsultationRequests/deleteConsultationRequest):
//      отдельно от bookings.json, т.к. там нет ни даты, ни времени, ни
//      услуги — слот-логика и буферы к ним неприменимы.
//
// ---- Хардненинг, июль 2026 (второй проход, после ревью DK) ----
//   7. Телефон в брони/заявке теперь ПЕРЕСОБИРАЕТСЯ сервером из уже
//      проверенных цифр (formatPhoneForStorage), а не берётся сырой
//      строкой от клиента. Раньше raw.clientPhone/raw.phone сохранялись
//      как есть — проверка на 11 цифр смотрела в normalisePhone(), но
//      в базу уходила исходная строка целиком, так что лишние символы
//      (включая <script>) проходили мимо очистки, которая есть у
//      clientName/comment/serviceName. Теперь такой возможности нет —
//      строка телефона всегда строится нами из цифр + фиксированного
//      формата, никаких посторонних символов физически попасть не может.
//   8. saveClientNote — заметка админа теперь тоже проходит через
//      cleanOptionalText (раньше писалась без всякой очистки).
//   9. markBooking — payload.status теперь проверяется по белому списку
//      ('completed' | 'no_show'), а не принимается как есть.
//  10. createBooking / rescheduleBookingByPhone — сервер теперь сам
//      отклоняет слоты ближе MIN_LEAD_MINUTES (сейчас 60 мин) до начала,
//      считая по МСК (смещение +03:00 явно, не по часовому поясу сервера
//      и не по часам браузера клиента). Раньше прошедшее время отсеивал
//      только фронтенд (buildTimeSlots) — можно было отправить запрос в
//      обход сайта (или просто с переведёнными назад часами) и
//      записаться "прямо сейчас" или "во вчера". Проверка конфликтов
//      слотов (hasBookingConflict) от этого не страдает, она как искала
//      пересечения с другими бронями, так и ищет — это отдельная,
//      дополнительная проверка.
// ============================================================

const AWS = require('aws-sdk');
const https = require('https');
const crypto = require('crypto');

const BUCKET = 'dk-massage-data';

const s3 = new AWS.S3({
  endpoint: 'https://storage.yandexcloud.net',
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  region: 'ru-central1',
  s3ForcePathStyle: true,
});

// ---------- Telegram ----------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const ADMIN_PASSWORD     = process.env.ADMIN_PASSWORD;

function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.warn('Telegram не настроен — уведомление пропущено.');
      resolve(false);
      return;
    }
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', (e) => { console.error('Telegram error:', e); resolve(false); });
    req.write(body);
    req.end();
  });
}

// Человекочитаемые подписи способа связи — используются и в уведомлении
// мастеру, и потенциально в админке.
const CONTACT_METHOD_LABELS = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  call: 'СМС/звонок',
};

function formatContactMethods(methods) {
  return (methods || []).map(m => CONTACT_METHOD_LABELS[m] || m).join(', ') || '—';
}

function formatBookingMessage(booking, eventType) {
  const dateObj = new Date(booking.date + 'T00:00:00');
  const dateStr = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
  if (eventType === 'cancelled_by_client') {
    return `❌ Клиент отменил запись — DK\n\n💆 ${booking.serviceName}\n📅 ${dateStr}\n🕐 ${booking.start}–${booking.end}\n\n👤 ${booking.clientName}\n📞 ${booking.clientPhone}`;
  }
  return `✨ Новая запись — DK\n\n💆 ${booking.serviceName}\n📅 ${dateStr}\n🕐 ${booking.start}–${booking.end}\n💰 ${(booking.servicePrice || 0).toLocaleString('ru-RU')} ₽\n\n👤 ${booking.clientName}\n📞 ${booking.clientPhone}\n📱 Связь: ${formatContactMethods(booking.contactMethods)}` + (booking.comment ? `\n📝 ${booking.comment}` : '');
}

// Отдельное сообщение для переноса времени клиентом — старое и новое время
// сразу оба, чтобы Диана не листала расписание в поисках, что именно изменилось.
function formatRescheduleMessage(booking, oldStart, oldEnd) {
  const dateObj = new Date(booking.date + 'T00:00:00');
  const dateStr = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
  return `🔄 Клиент перенёс время записи — DK\n\n💆 ${booking.serviceName}\n📅 ${dateStr}\n🕐 было ${oldStart}–${oldEnd} → стало ${booking.start}–${booking.end}\n\n👤 ${booking.clientName}\n📞 ${booking.clientPhone}`;
}

const INTENT_LABELS = {
  first_time: 'первый раз',
  course: 'индивидуальный курс',
};

function formatConsultationMessage(request) {
  const intentsText = (request.intents || []).map(i => INTENT_LABELS[i] || i).join(', ') || '—';
  return `📋 Заявка на консультацию — DK\n\n👤 ${request.name}\n📞 ${request.phone}\n🎯 ${intentsText}` + (request.comment ? `\n📝 ${request.comment}` : '');
}

// ---------- Storage helpers ----------

async function readJson(key, fallback) {
  try {
    const res = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    return JSON.parse(res.Body.toString('utf-8'));
  } catch (e) {
    if (e.code === 'NoSuchKey' || e.code === 'NotFound') return fallback;
    throw e;
  }
}

async function writeJson(key, data) {
  await s3.putObject({ Bucket: BUCKET, Key: key, Body: JSON.stringify(data), ContentType: 'application/json' }).promise();
}

// ---------- Безопасная запись с защитой от гонки (optimistic concurrency) ----------
// Та же логика, что и в РАЙ: пишем с условием If-Match/If-None-Match на ETag,
// при конфликте (412) — короткая пауза и повтор всего цикла чтение→изменение→запись.
const WRITE_MAX_RETRIES = 5;

async function writeJsonSafe(key, fallback, mutateFn) {
  for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
    let currentData = fallback;
    let etag = null;
    try {
      const res = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
      currentData = JSON.parse(res.Body.toString('utf-8'));
      etag = res.ETag;
    } catch (e) {
      if (e.code !== 'NoSuchKey' && e.code !== 'NotFound') throw e;
    }

    const { data, result } = mutateFn(currentData);
    if (data === undefined) return result;

    const putParams = { Bucket: BUCKET, Key: key, Body: JSON.stringify(data), ContentType: 'application/json' };
    const request = s3.putObject(putParams);
    request.on('build', () => {
      request.httpRequest.headers[etag ? 'If-Match' : 'If-None-Match'] = etag || '*';
    });

    try {
      await request.promise();
      return result;
    } catch (e) {
      const isConflict = e.statusCode === 412 || e.code === 'PreconditionFailed';
      if (!isConflict) throw e;
      await new Promise(r => setTimeout(r, 80 + Math.random() * 160));
    }
  }
  throw new Error(`write-conflict: не удалось записать ${key} за ${WRITE_MAX_RETRIES} попыток — слишком много одновременных запросов`);
}

// ---------- Rate limiting (защита от перебора телефона / спама заявками) ----------
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function getClientIp(event) {
  return (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || 'unknown';
}

async function checkRateLimit(ip, scope) {
  const limits = await readJson('rate-limits.json', {});
  const entry = limits[`${ip}:${scope}`];
  if (!entry || !entry.blockedUntil) return { blocked: false };
  const remaining = entry.blockedUntil - Date.now();
  if (remaining <= 0) return { blocked: false };
  return { blocked: true, retryAfterMs: remaining };
}

async function recordFailedAttempt(ip, scope) {
  const key = `${ip}:${scope}`;
  await writeJsonSafe('rate-limits.json', {}, (limits) => {
    const now = Date.now();
    const entry = limits[key];
    const stillInWindow = entry && entry.windowStart && (now - entry.windowStart < RATE_LIMIT_WINDOW_MS);
    const attempts = stillInWindow ? (entry.attempts || 0) + 1 : 1;
    const windowStart = stillInWindow ? entry.windowStart : now;
    const updatedEntry = { attempts, windowStart };
    if (attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
      updatedEntry.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
    }
    return { data: { ...limits, [key]: updatedEntry }, result: updatedEntry };
  });
}

async function clearRateLimit(ip, scope) {
  const key = `${ip}:${scope}`;
  await writeJsonSafe('rate-limits.json', {}, (limits) => {
    if (!limits[key]) return { data: undefined, result: null };
    const updated = { ...limits };
    delete updated[key];
    return { data: updated, result: null };
  });
}

// ---------- Client record helpers ----------

function normalisePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

// Телефон для сохранения СОБИРАЕМ САМИ из уже проверенных цифр (11 цифр,
// начинается с 7 или 8 — это гарантировано вызывающим кодом до вызова
// этой функции). Раньше в bookings.json/consultation-requests.json
// уходила исходная строка raw.clientPhone/raw.phone целиком — проверка
// длины смотрела на "очищенные" цифры, а сохранялось всё как есть,
// то есть посторонние символы (включая <script>) спокойно проходили
// мимо любой очистки. Теперь строка физически не может содержать ничего,
// кроме цифр и фиксированных символов формата.
function formatPhoneForStorage(digits) {
  const normalized = digits.charAt(0) === '8' ? '7' + digits.slice(1) : digits;
  const rest = normalized.slice(1);
  return `+7 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 8)}-${rest.slice(8, 10)}`;
}

async function upsertClientOnCompletion(booking) {
  const phone = normalisePhone(booking.clientPhone);
  if (!phone) return;
  await writeJsonSafe('clients.json', {}, (clients) => {
    const existing = clients[phone] || {
      name: booking.clientName,
      phone: booking.clientPhone,
      firstVisit: booking.date,
      lastVisit: booking.date,
      visits: 0,
      totalSpent: 0,
      notes: '',
    };
    const updatedEntry = {
      ...existing,
      name: booking.clientName,
      lastVisit: booking.date > (existing.lastVisit || '') ? booking.date : existing.lastVisit,
      firstVisit: booking.date < (existing.firstVisit || '9999') ? booking.date : existing.firstVisit,
      visits: (existing.visits || 0) + 1,
      totalSpent: (existing.totalSpent || 0) + (booking.servicePrice || 0),
    };
    const updated = { ...clients, [phone]: updatedEntry };
    return { data: updated, result: updatedEntry };
  });
}

// ---------- Time helpers ----------

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  if (!Number.isFinite(mins) || mins < 0 || mins >= 24 * 60) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Момент времени (мс от эпохи) для даты+времени слота. Часовой пояс —
// явное смещение +03:00 (МСК, без перехода на летнее/зимнее время), а не
// локальный часовой пояс сервера Cloud Function (он может быть UTC) и уж
// тем более не часы клиента (их легко перевести назад, чтобы обойти
// проверку на фронте) — так дата/время слота трактуется однозначно
// независимо от того, где физически исполняется функция.
function slotTimestampMsk(dateIso, timeStr) {
  return new Date(`${dateIso}T${timeStr}:00+03:00`).getTime();
}

// Минимальный лид-тайм: за сколько минут до начала слота ещё можно
// записаться/перенестись. Сейчас 60 мин (по договорённости с Дианой,
// июль 2026) — может смениться на "не менее суток". То же значение
// продублировано во фронтенде (scriptDK.js, MIN_LEAD_MINUTES) — при
// изменении менять в обоих местах.
const MIN_LEAD_MINUTES = 60;

// Буфер между визитами — 15 минут. Не зависит от шага календаря на фронте
// (там 30 минут) — это два независимых параметра, см. комментарий в шапке файла.
const SLOT_BUFFER_MINUTES = 15;

function hasBookingConflict(bookings, candidate) {
  const candStart = timeToMinutes(candidate.start) - SLOT_BUFFER_MINUTES;
  const candEnd = timeToMinutes(candidate.end) + SLOT_BUFFER_MINUTES;
  return bookings.some(b => {
    if (b.date !== candidate.date) return false;
    if (b.id === candidate.id) return false;
    const bStart = timeToMinutes(b.start);
    const bEnd = timeToMinutes(b.end);
    return candStart < bEnd && candEnd > bStart;
  });
}

// Дневного лимита нагрузки у DK нет (сознательное отличие от РАЙ) —
// функции getDailyBookedMinutes и связанных проверок здесь намеренно нет.

// ---------- Booking validation ----------

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// До начала слота должно оставаться не меньше MIN_LEAD_MINUTES.
// Используется и при создании брони, и при переносе (rescheduleBookingByPhone).
function isTooSoon(dateIso, timeStr) {
  return slotTimestampMsk(dateIso, timeStr) < Date.now() + MIN_LEAD_MINUTES * 60 * 1000;
}

function cleanRequiredText(s, maxLen) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().replace(/[<>]/g, '');
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

function cleanOptionalText(s, maxLen) {
  if (typeof s !== 'string') return { ok: true, value: '' };
  const trimmed = s.trim().replace(/[<>]/g, '');
  if (trimmed.length > maxLen) return { ok: false };
  return { ok: true, value: trimmed };
}

// Способы связи — минимум 1, максимум все 4, только из белого списка.
const ALLOWED_CONTACT_METHODS = ['telegram', 'whatsapp', 'max', 'call'];

function validateContactMethods(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cleaned = [...new Set(raw)].filter(m => ALLOWED_CONTACT_METHODS.includes(m));
  if (cleaned.length === 0) return null;
  return cleaned;
}

// Возвращает { booking } при успехе или { error, field } при провале валидации.
function validateBooking(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'missing-booking' };

  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : null;
  if (!id) return { error: 'invalid-booking', field: 'id' };

  if (!isValidDate(raw.date)) return { error: 'invalid-booking', field: 'date' };
  if (!isValidTime(raw.start)) return { error: 'invalid-booking', field: 'start' };
  if (!isValidTime(raw.end)) return { error: 'invalid-booking', field: 'end' };
  if (timeToMinutes(raw.end) <= timeToMinutes(raw.start)) {
    return { error: 'invalid-booking', field: 'end' };
  }
  if (isTooSoon(raw.date, raw.start)) {
    return { error: 'invalid-booking', field: 'start' };
  }

  const clientName = cleanRequiredText(raw.clientName, 100);
  if (!clientName || clientName.length < 2) return { error: 'invalid-booking', field: 'clientName' };

  const phoneDigits = normalisePhone(raw.clientPhone);
  if (phoneDigits.length !== 11 || !/^[78]/.test(phoneDigits)) {
    return { error: 'invalid-booking', field: 'clientPhone' };
  }

  const serviceName = cleanRequiredText(raw.serviceName, 200);
  if (!serviceName) return { error: 'invalid-booking', field: 'serviceName' };

  const servicePrice = Number(raw.servicePrice);
  if (!Number.isFinite(servicePrice) || servicePrice < 0 || servicePrice > 100000) {
    return { error: 'invalid-booking', field: 'servicePrice' };
  }

  const serviceDuration = Number(raw.serviceDuration);
  if (!Number.isFinite(serviceDuration) || serviceDuration < 5 || serviceDuration > 600) {
    return { error: 'invalid-booking', field: 'serviceDuration' };
  }

  const commentResult = cleanOptionalText(raw.comment, 500);
  if (!commentResult.ok) return { error: 'invalid-booking', field: 'comment' };

  const contactMethods = validateContactMethods(raw.contactMethods);
  if (!contactMethods) return { error: 'invalid-booking', field: 'contactMethods' };

  const booking = {
    id,
    // createdAt клиенту не доверяем — выставляем сами (иначе можно подделать
    // дату создания, чтобы бронь не подсвечивалась как «новая»).
    createdAt: new Date().toISOString(),
    date: raw.date,
    start: raw.start,
    end: raw.end,
    serviceName,
    serviceDuration,
    servicePrice,
    clientName,
    // Телефон — не raw.clientPhone, а пересобранный из проверенных цифр
    // (formatPhoneForStorage). См. комментарий у функции.
    clientPhone: formatPhoneForStorage(phoneDigits),
    comment: commentResult.value,
    contactMethods,
  };

  return { booking };
}

// ---------- Consultation request validation ----------
// Заявка на консультацию — без даты/времени/услуги, поэтому отдельная
// от бронирования модель и отдельное хранилище (consultation-requests.json).

const ALLOWED_INTENTS = ['first_time', 'course'];

function validateConsultationRequest(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'missing-request' };

  const name = cleanRequiredText(raw.name, 100);
  if (!name || name.length < 2) return { error: 'invalid-request', field: 'name' };

  const phoneDigits = normalisePhone(raw.phone);
  if (phoneDigits.length !== 11 || !/^[78]/.test(phoneDigits)) {
    return { error: 'invalid-request', field: 'phone' };
  }

  const commentResult = cleanOptionalText(raw.comment, 500);
  if (!commentResult.ok) return { error: 'invalid-request', field: 'comment' };

  const intents = Array.isArray(raw.intents)
    ? [...new Set(raw.intents)].filter(i => ALLOWED_INTENTS.includes(i))
    : [];
  if (intents.length === 0) return { error: 'invalid-request', field: 'intents' };

  const request = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name,
    // Тот же фикс, что и в брони — телефон пересобран из цифр, не сырой.
    phone: formatPhoneForStorage(phoneDigits),
    comment: commentResult.value,
    intents,
  };

  return { request };
}

// ---------- HTTP response helper ----------

function respond(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...(extraHeaders || {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// ---------- Main handler ----------

module.exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return respond(400, { error: 'invalid-json' }); }

  const { action } = payload;

  // ── Действия, доступные только из панели администратора ──────
  const ADMIN_ACTIONS = new Set([
    'adminLogin', 'saveSchedule', 'getBookings', 'markBookingsSeen',
    'deleteBooking', 'updateBookingTime', 'markBooking',
    'getHistory', 'getClients', 'saveClientNote',
    'getConsultationRequests', 'deleteConsultationRequest',
  ]);
  if (ADMIN_ACTIONS.has(action)) {
    const ip = getClientIp(event);
    const limitStatus = await checkRateLimit(ip, 'admin');
    if (limitStatus.blocked) {
      return respond(429, { error: 'too-many-attempts', retryAfterSeconds: Math.ceil(limitStatus.retryAfterMs / 1000) });
    }
    if (!ADMIN_PASSWORD || payload.adminPassword !== ADMIN_PASSWORD) {
      await recordFailedAttempt(ip, 'admin');
      return respond(401, { error: 'unauthorized' });
    }
    await clearRateLimit(ip, 'admin');
  }

  try {
    switch (action) {

      case 'adminLogin': {
        return respond(200, { ok: true });
      }

      // ── Расписание ──────────────────────────────────────────
      case 'getSchedule': {
        const schedule = await readJson('schedule.json', {});
        return respond(200, { schedule });
      }
      case 'saveSchedule': {
        await writeJson('schedule.json', payload.schedule || {});
        return respond(200, { ok: true });
      }

      // ── Предстоящие записи ──────────────────────────────────
      case 'getBookings': {
        const [bookings, clients, seen] = await Promise.all([
          readJson('bookings.json', []),
          readJson('clients.json', {}),
          readJson('bookings-seen.json', { lastSeenAt: null }),
        ]);
        const enriched = bookings.map(b => {
          const phone = normalisePhone(b.clientPhone);
          const client = clients[phone];
          return { ...b, clientNotes: (client && client.notes) ? client.notes : '' };
        });
        return respond(200, { bookings: enriched, lastSeenAt: seen.lastSeenAt });
      }

      case 'markBookingsSeen': {
        await writeJson('bookings-seen.json', { lastSeenAt: new Date().toISOString() });
        return respond(200, { ok: true });
      }

      // ── Публичный облегчённый список занятых слотов ─────────
      case 'getBookedSlots': {
        const bookings = await readJson('bookings.json', []);
        const slots = bookings.map(b => ({ date: b.date, start: b.start, end: b.end }));
        return respond(200, { slots });
      }

      // ── Публичный поиск своих записей по телефону ────────────
      case 'getBookingsByPhone': {
        const ip = getClientIp(event);
        const limitStatus = await checkRateLimit(ip, 'phoneLookup');
        if (limitStatus.blocked) {
          return respond(429, { error: 'too-many-attempts', retryAfterSeconds: Math.ceil(limitStatus.retryAfterMs / 1000) });
        }

        // Honeypot: скрытое на клиенте поле, которое видят и заполняют только скрипты.
        if (payload.hp) {
          await recordFailedAttempt(ip, 'phoneLookup');
          return respond(200, { bookings: [] });
        }

        const inputDigits = normalisePhone(payload.phone).slice(-10);
        if (inputDigits.length !== 10) return respond(400, { error: 'invalid-phone' });

        const bookings = await readJson('bookings.json', []);
        const matches = bookings
          .filter(b => normalisePhone(b.clientPhone).slice(-10) === inputDigits)
          .map(b => ({ id: b.id, date: b.date, start: b.start, end: b.end, serviceName: b.serviceName }));

        if (matches.length === 0) {
          await recordFailedAttempt(ip, 'phoneLookup');
        } else {
          await clearRateLimit(ip, 'phoneLookup');
        }

        return respond(200, { bookings: matches });
      }

      // ── Публичная отмена записи по телефону ──────────────────
      case 'cancelBookingByPhone': {
        const ip = getClientIp(event);
        const limitStatus = await checkRateLimit(ip, 'cancelPhone');
        if (limitStatus.blocked) {
          return respond(429, { error: 'too-many-attempts', retryAfterSeconds: Math.ceil(limitStatus.retryAfterMs / 1000) });
        }

        const inputDigits = normalisePhone(payload.phone).slice(-10);
        const bookingId = typeof payload.id === 'string' ? payload.id : null;
        if (inputDigits.length !== 10 || !bookingId) return respond(400, { error: 'invalid-request' });

        const cancelled = await writeJsonSafe('bookings.json', [], (bookings) => {
          const idx = bookings.findIndex(b => b.id === bookingId && normalisePhone(b.clientPhone).slice(-10) === inputDigits);
          if (idx === -1) return { data: undefined, result: null };
          const found = bookings[idx];
          const updated = bookings.filter((_, i) => i !== idx);
          return { data: updated, result: found };
        });

        if (!cancelled) {
          await recordFailedAttempt(ip, 'cancelPhone');
          return respond(404, { error: 'booking-not-found' });
        }
        await clearRateLimit(ip, 'cancelPhone');

        await sendTelegramMessage(formatBookingMessage(cancelled, 'cancelled_by_client'));

        return respond(200, {
          ok: true,
          date: cancelled.date,
          start: cancelled.start,
          serviceName: cancelled.serviceName,
        });
      }

      // ── Публичный перенос времени по телефону (в пределах того же дня) ──
      case 'rescheduleBookingByPhone': {
        const ip = getClientIp(event);
        const limitStatus = await checkRateLimit(ip, 'reschedulePhone');
        if (limitStatus.blocked) {
          return respond(429, { error: 'too-many-attempts', retryAfterSeconds: Math.ceil(limitStatus.retryAfterMs / 1000) });
        }

        const inputDigits = normalisePhone(payload.phone).slice(-10);
        const bookingId = typeof payload.id === 'string' ? payload.id : null;
        const newStart = payload.newStart;
        if (inputDigits.length !== 10 || !bookingId || !isValidTime(newStart)) {
          return respond(400, { error: 'invalid-request' });
        }

        let outcome = null; // 'moved' | 'not-found' | 'slot-taken' | 'too-soon'
        let oldStart = null, oldEnd = null;

        const updated = await writeJsonSafe('bookings.json', [], (bookings) => {
          const idx = bookings.findIndex(b => b.id === bookingId && normalisePhone(b.clientPhone).slice(-10) === inputDigits);
          if (idx === -1) { outcome = 'not-found'; return { data: undefined, result: null }; }

          const original = bookings[idx];

          if (isTooSoon(original.date, newStart)) {
            outcome = 'too-soon';
            return { data: undefined, result: null };
          }

          const duration = timeToMinutes(original.end) - timeToMinutes(original.start);
          const newEnd = minutesToTime(timeToMinutes(newStart) + duration);
          if (!isValidTime(newEnd)) { outcome = 'not-found'; return { data: undefined, result: null }; }

          // rescheduledAt — отдельная метка (не трогает createdAt, бронь не
          // становится "новой"), чтобы админка могла подсветить именно факт
          // переноса отдельной плашкой "Изменена".
          const candidate = { ...original, start: newStart, end: newEnd, rescheduledAt: new Date().toISOString() };

          if (hasBookingConflict(bookings, candidate)) {
            outcome = 'slot-taken';
            return { data: undefined, result: null };
          }

          oldStart = original.start;
          oldEnd = original.end;
          outcome = 'moved';
          const nextBookings = bookings.slice();
          nextBookings[idx] = candidate;
          return { data: nextBookings, result: candidate };
        });

        if (outcome === 'not-found') {
          await recordFailedAttempt(ip, 'reschedulePhone');
          return respond(404, { error: 'booking-not-found' });
        }
        if (outcome === 'slot-taken') return respond(409, { error: 'slot-taken' });
        if (outcome === 'too-soon') return respond(400, { error: 'invalid-request', field: 'newStart' });

        await clearRateLimit(ip, 'reschedulePhone');
        await sendTelegramMessage(formatRescheduleMessage(updated, oldStart, oldEnd));

        return respond(200, {
          ok: true,
          date: updated.date,
          start: updated.start,
          end: updated.end,
          serviceName: updated.serviceName,
        });
      }

      case 'createBooking': {
        let validationError = null;
        let outcome = null; // 'created' | 'idempotent' | 'slot-taken'

        const savedBooking = await writeJsonSafe('bookings.json', [], (bookings) => {
          const rawId = payload.booking && typeof payload.booking.id === 'string' ? payload.booking.id : null;
          if (rawId) {
            const existing = bookings.find(b => b.id === rawId);
            if (existing) {
              outcome = 'idempotent';
              return { data: undefined, result: existing };
            }
          }

          const { booking: candidate, error, field } = validateBooking(payload.booking);
          if (error) {
            validationError = { error, field };
            return { data: undefined, result: null };
          }

          if (hasBookingConflict(bookings, candidate)) {
            outcome = 'slot-taken';
            return { data: undefined, result: null };
          }

          outcome = 'created';
          return { data: [...bookings, candidate], result: candidate };
        });

        if (validationError) return respond(400, validationError);
        if (outcome === 'slot-taken') return respond(409, { error: 'slot-taken' });
        if (outcome === 'idempotent') return respond(200, { ok: true, booking: savedBooking });

        await sendTelegramMessage(formatBookingMessage(savedBooking, 'new'));
        return respond(200, { ok: true, booking: savedBooking });
      }

      case 'deleteBooking': {
        const cancelled = await writeJsonSafe('bookings.json', [], (bookings) => {
          const found = bookings.find(b => b.id === payload.bookingId);
          if (!found) return { data: undefined, result: null };
          const updated = bookings.filter(b => b.id !== payload.bookingId);
          return { data: updated, result: found };
        });
        if (cancelled && payload.notifyCancellation) {
          await sendTelegramMessage(formatBookingMessage(cancelled, 'cancelled_by_client'));
        }
        return respond(200, { ok: true });
      }

      case 'updateBookingTime': {
        let notFound = false;
        await writeJsonSafe('bookings.json', [], (bookings) => {
          const idx = bookings.findIndex(b => b.id === payload.bookingId);
          if (idx === -1) { notFound = true; return { data: undefined, result: null }; }
          const updated = bookings.slice();
          updated[idx] = { ...updated[idx], date: payload.date, start: payload.start, end: payload.end };
          return { data: updated, result: updated[idx] };
        });
        if (notFound) return respond(404, { error: 'booking-not-found' });
        return respond(200, { ok: true });
      }

      // ── Закрытие записи → История ────────────────────────────
      case 'markBooking': {
        // Раньше payload.status принимался как есть — теперь только
        // из белого списка (иначе опечатка/произвольная строка от
        // клиента админки могла попасть в history.json и сломать
        // фильтры аналитики, которая сравнивает статус строго).
        const ALLOWED_STATUSES = ['completed', 'no_show'];
        if (!ALLOWED_STATUSES.includes(payload.status)) {
          return respond(400, { error: 'invalid-status' });
        }

        const removedBooking = await writeJsonSafe('bookings.json', [], (bookings) => {
          const idx = bookings.findIndex(b => b.id === payload.bookingId);
          if (idx === -1) return { data: undefined, result: null };
          const found = bookings[idx];
          const updated = bookings.filter((_, i) => i !== idx);
          return { data: updated, result: found };
        });

        if (!removedBooking) return respond(404, { error: 'booking-not-found' });

        const historyEntry = {
          ...removedBooking,
          status: payload.status,
          closedAt: new Date().toISOString(),
        };
        await writeJsonSafe('history.json', [], (history) => {
          return { data: [...history, historyEntry], result: historyEntry };
        });

        if (payload.status === 'completed') {
          await upsertClientOnCompletion(removedBooking);
        }

        return respond(200, { ok: true });
      }

      // ── История ─────────────────────────────────────────────
      case 'getHistory': {
        const history = await readJson('history.json', []);
        return respond(200, { history });
      }

      // ── База клиентов ────────────────────────────────────────
      case 'getClients': {
        const clients = await readJson('clients.json', {});
        return respond(200, { clients });
      }

      case 'saveClientNote': {
        const phone = normalisePhone(payload.phone);
        if (!phone) return respond(400, { error: 'missing-phone' });

        // Заметку админа тоже чистим той же функцией, что и клиентские
        // поля (comment/clientName) — раньше payload.notes писался как есть.
        const notesResult = cleanOptionalText(payload.notes, 1000);
        if (!notesResult.ok) return respond(400, { error: 'invalid-notes' });

        let notFound = false;
        await writeJsonSafe('clients.json', {}, (clients) => {
          if (!clients[phone]) { notFound = true; return { data: undefined, result: null }; }
          const updated = { ...clients, [phone]: { ...clients[phone], notes: notesResult.value } };
          return { data: updated, result: updated[phone] };
        });

        if (notFound) return respond(404, { error: 'client-not-found' });
        return respond(200, { ok: true });
      }

      // ── Публичная заявка на консультацию (без даты/времени/услуги) ──
      case 'createConsultationRequest': {
        // Без rate-limit на "неудачные попытки" — тут нет секрета для перебора,
        // это просто форма. Осознанное упрощение (как и часть решений в РАЙ) —
        // если начнётся спам, добавим отдельный флуд-лимитер по IP.
        const { request, error, field } = validateConsultationRequest(payload.request || payload);
        if (error) return respond(400, { error, field });

        await writeJsonSafe('consultation-requests.json', [], (requests) => {
          return { data: [...requests, request], result: request };
        });

        await sendTelegramMessage(formatConsultationMessage(request));

        return respond(200, { ok: true });
      }

      // ── Админка: заявки на консультацию ──────────────────────
      case 'getConsultationRequests': {
        const requests = await readJson('consultation-requests.json', []);
        return respond(200, { requests });
      }

      case 'deleteConsultationRequest': {
        const removed = await writeJsonSafe('consultation-requests.json', [], (requests) => {
          const found = requests.find(r => r.id === payload.requestId);
          if (!found) return { data: undefined, result: null };
          const updated = requests.filter(r => r.id !== payload.requestId);
          return { data: updated, result: found };
        });
        if (!removed) return respond(404, { error: 'request-not-found' });
        return respond(200, { ok: true });
      }

      default:
        return respond(400, { error: 'unknown-action' });
    }
  } catch (e) {
    console.error('Function error:', e);
    return respond(500, { error: 'internal-error', message: String(e.message || e) });
  }
};
