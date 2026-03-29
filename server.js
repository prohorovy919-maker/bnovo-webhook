require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { checkAvailability } = require('./bnovo');

const app = express();
app.use(express.json());

// Названия домиков Fox Sisters (room_id → название для гостя)
// Заполни после того как получим список комнат из Bnovo
const ROOM_NAMES = {};

// Главный эндпоинт — amoCRM Salesbot вызывает сюда
app.post('/availability', async (req, res) => {
  console.log('Запрос от Salesbot:', JSON.stringify(req.body, null, 2));

  const { data, return_url } = req.body;

  // Сразу отвечаем 200 чтобы Salesbot не ждал
  res.sendStatus(200);

  try {
    const dateFrom = data?.date_from;
    const dateTo = data?.date_to;

    if (!dateFrom || !dateTo) {
      await sendToAmo(return_url, 'Не удалось определить даты. Уточни пожалуйста дату заезда и выезда.');
      return;
    }

    console.log(`Проверяю наличие: ${dateFrom} → ${dateTo}`);
    const { freeRooms, allRooms } = await checkAvailability(dateFrom, dateTo);

    let message;
    if (freeRooms.length === 0) {
      message = formatNoAvailability(dateFrom, dateTo);
    } else {
      message = formatAvailability(freeRooms, dateFrom, dateTo);
    }

    console.log('Отправляю в amoCRM:', message);
    await sendToAmo(return_url, message);

  } catch (err) {
    console.error('Ошибка:', err.message);
    await sendToAmo(return_url, 'Не смог проверить наличие — уточню у старшего менеджера и свяжусь с тобой.').catch(() => {});
  }
});

// Тестовый эндпоинт — проверить что сервер работает
app.get('/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Тестовый эндпоинт — проверить Bnovo без Salesbot
app.get('/test-availability', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.json({ error: 'Укажи ?from=2026-04-01&to=2026-04-03' });
  }
  try {
    const result = await checkAvailability(from, to);
    res.json({
      freeCount: result.freeRooms.length,
      freeRooms: result.freeRooms.map(r => ({ id: r.id, name: r.name, type: r.room_type })),
      bookedIds: result.bookedRoomIds
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

function formatAvailability(freeRooms, dateFrom, dateTo) {
  const list = freeRooms.map(r => `• ${r.name}`).join('\n');
  return `На период с ${formatDate(dateFrom)} по ${formatDate(dateTo)} свободны:\n${list}\n\nПодобрать что-то конкретное под ваши пожелания?`;
}

function formatNoAvailability(dateFrom, dateTo) {
  return `К сожалению, на период с ${formatDate(dateFrom)} по ${formatDate(dateTo)} все домики уже заняты. Могу посмотреть другие даты — какие вам подходят?`;
}

function formatDate(str) {
  // 2026-04-01 → 1 апреля
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const [, m, d] = str.split('-');
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

async function sendToAmo(returnUrl, text) {
  if (!returnUrl) return;
  await axios.post(returnUrl, {
    execute_handlers: [
      {
        handler: 'show',
        params: { type: 'text', value: text }
      }
    ]
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Тест: http://localhost:${PORT}/ping`);
  console.log(`Тест наличия: http://localhost:${PORT}/test-availability?from=2026-04-01&to=2026-04-03`);
});
