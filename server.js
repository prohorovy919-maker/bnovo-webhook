require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { checkAvailability } = require('./bnovo');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const AMO_DOMAIN = process.env.AMO_DOMAIN;
const AMO_LOGIN = process.env.AMO_LOGIN;
const AMO_HASH = process.env.AMO_HASH;

// ─── Месяцы на русском ────────────────────────────────────────────────────────

const MONTHS = {
  'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4,
  'май': 5, 'мая': 5, 'июн': 6, 'июл': 7, 'август': 8,
  'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12
};

function getMonth(str) {
  const s = str.toLowerCase();
  for (const [key, val] of Object.entries(MONTHS)) {
    if (s.startsWith(key)) return val;
  }
  return null;
}

function toDate(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// Определяет год: если дата уже прошла — следующий год
function guessYear(month, day) {
  const now = new Date();
  const year = now.getFullYear();
  const d = new Date(year, month - 1, day);
  return d < now ? year + 1 : year;
}

// ─── Парсер дат из русского текста ───────────────────────────────────────────

function parseDates(text) {
  const t = text.toLowerCase();

  // Паттерн 1: "с 8 по 10 мая" / "с 8 мая по 10 мая"
  let m = t.match(/с\s+(\d{1,2})(?:\s+(\S+))?\s+по\s+(\d{1,2})\s+(\S+)/);
  if (m) {
    const monthStr = m[4];
    const month = getMonth(monthStr);
    if (month) {
      const year = guessYear(month, parseInt(m[3]));
      return { dateFrom: toDate(year, month, m[1]), dateTo: toDate(year, month, m[3]) };
    }
  }

  // Паттерн 2: "8-10 мая" / "8 - 10 мая"
  m = t.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+(\S+)/);
  if (m) {
    const month = getMonth(m[3]);
    if (month) {
      const year = guessYear(month, parseInt(m[2]));
      return { dateFrom: toDate(year, month, m[1]), dateTo: toDate(year, month, m[2]) };
    }
  }

  // Паттерн 3: "8, 9, 10 мая" → первая и последняя дата
  m = t.match(/([\d,\s]+)\s+(\S+)/);
  if (m) {
    const month = getMonth(m[2]);
    if (month) {
      const days = m[1].split(/[,\s]+/).map(Number).filter(Boolean);
      if (days.length >= 2) {
        const year = guessYear(month, Math.max(...days));
        return { dateFrom: toDate(year, month, Math.min(...days)), dateTo: toDate(year, month, Math.max(...days)) };
      }
      if (days.length === 1) {
        // Одна дата — скорее всего только заезд
        const year = guessYear(month, days[0]);
        return { dateFrom: toDate(year, month, days[0]), dateTo: null };
      }
    }
  }

  // Паттерн 4: "8 мая" (одна дата)
  m = t.match(/(\d{1,2})\s+(\S+)/);
  if (m) {
    const month = getMonth(m[2]);
    if (month) {
      const year = guessYear(month, parseInt(m[1]));
      return { dateFrom: toDate(year, month, m[1]), dateTo: null };
    }
  }

  return null;
}

// Слова-признаки запроса о наличии
const AVAILABILITY_KEYWORDS = [
  'свобод', 'наличи', 'есть ли', 'доступн', 'занят', 'бронир', 'забронир',
  'заезд', 'въезд', 'заехат', 'приехат', 'погостит', 'остановит',
  'мест', 'домик', 'номер', 'купол', 'резиденц',
  'май', 'мая', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
  'январ', 'феврал', 'март', 'апрел'
];

function isAvailabilityRequest(text) {
  const t = text.toLowerCase();
  return AVAILABILITY_KEYWORDS.some(kw => t.includes(kw));
}

// ─── Старый Salesbot endpoint ─────────────────────────────────────────────────

app.post('/availability', async (req, res) => {
  console.log('Salesbot /availability:', JSON.stringify(req.body, null, 2));
  const { data, return_url } = req.body;
  res.sendStatus(200);

  try {
    const dateFrom = data?.date_from;
    const dateTo = data?.date_to;

    if (!dateFrom || !dateTo) {
      await sendToAmo(return_url, 'Уточни пожалуйста дату заезда и выезда.');
      return;
    }

    const { freeRooms, busyRooms } = await checkAvailability(dateFrom, dateTo);
    const message = freeRooms.length === 0
      ? formatNoAvailability(dateFrom, dateTo)
      : formatAvailability(freeRooms, dateFrom, dateTo);

    await sendToAmo(return_url, message);
  } catch (err) {
    console.error('Ошибка /availability:', err.message);
    await sendToAmo(return_url, 'Не смог проверить наличие — уточню дополнительно.').catch(() => {});
  }
});

// ─── AI-агент: входящие сообщения из AmoCRM ──────────────────────────────────

app.post('/amo-webhook', async (req, res) => {
  console.log('AmoCRM webhook:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);

  try {
    const body = req.body;
    const message = extractMessage(body);
    const talkId = extractTalkId(body);

    if (!message || !talkId) {
      console.log('Нет сообщения или talk_id, пропускаем');
      return;
    }

    console.log(`Сообщение (talk ${talkId}): ${message}`);

    if (!isAvailabilityRequest(message)) {
      console.log('Не запрос о наличии, пропускаем');
      return;
    }

    const dates = parseDates(message);
    console.log('Распознанные даты:', dates);

    if (!dates || !dates.dateFrom) {
      await sendChatMessage(talkId, 'Подскажи даты заезда и выезда — сразу проверю свободные домики! 🏡');
      return;
    }

    if (!dates.dateTo) {
      await sendChatMessage(talkId, `Понял, заезд ${formatDate(dates.dateFrom)}. А когда планируете выезд?`);
      return;
    }

    const { freeRooms, busyRooms } = await checkAvailability(dates.dateFrom, dates.dateTo);
    const reply = freeRooms.length === 0
      ? formatNoAvailability(dates.dateFrom, dates.dateTo)
      : formatAvailability(freeRooms, dates.dateFrom, dates.dateTo);

    await sendChatMessage(talkId, reply);

  } catch (err) {
    console.error('Ошибка /amo-webhook:', err.message);
  }
});

// ─── Отправка сообщения в чат AmoCRM ─────────────────────────────────────────

async function sendChatMessage(talkId, text) {
  try {
    const url = `https://${AMO_DOMAIN}/api/v4/talks/${talkId}/messages`;
    await axios.post(url, { text }, {
      params: { USER_LOGIN: AMO_LOGIN, USER_HASH: AMO_HASH }
    });
    console.log(`Ответ в talk ${talkId}: ${text.substring(0, 60)}...`);
  } catch (err) {
    console.error('Ошибка отправки в AmoCRM:', err.response?.data || err.message);
  }
}

async function sendToAmo(returnUrl, text) {
  if (!returnUrl) return;
  await axios.post(returnUrl, {
    execute_handlers: [{ handler: 'show', params: { type: 'text', value: text } }]
  });
}

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function extractMessage(body) {
  return body?.message?.text
    || body?.messages?.[0]?.text
    || body?.text
    || null;
}

function extractTalkId(body) {
  return body?.talk_id
    || body?.message?.talk_id
    || body?.messages?.[0]?.talk_id
    || null;
}

function formatAvailability(freeRooms, dateFrom, dateTo) {
  const list = freeRooms.map(r => `• ${r.name}`).join('\n');
  return `На ${formatDate(dateFrom)} – ${formatDate(dateTo)} свободны:\n${list}\n\nПодобрать что-то под ваши пожелания? 😊`;
}

function formatNoAvailability(dateFrom, dateTo) {
  return `К сожалению, на ${formatDate(dateFrom)} – ${formatDate(dateTo)} все домики уже заняты 😔\nМогу посмотреть другие даты — какие вам подходят?`;
}

function formatDate(str) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const [, m, d] = str.split('-');
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

// ─── Тесты ───────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/test-availability', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.json({ error: 'Укажи ?from=2026-04-01&to=2026-04-03' });
  try {
    const result = await checkAvailability(from, to);
    res.json({
      freeCount: result.freeRooms.length,
      freeRooms: result.freeRooms.map(r => ({ id: r.id, name: r.name })),
      busyRooms: result.busyRooms.map(r => ({ id: r.id, name: r.name }))
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/test-parse', (req, res) => {
  const { msg } = req.query;
  if (!msg) return res.json({ error: 'Укажи ?msg=текст' });
  res.json({
    isAvailability: isAvailabilityRequest(msg),
    dates: parseDates(msg)
  });
});

// ─── Старт ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
