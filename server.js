require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { checkAvailability } = require('./bnovo');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AMO_DOMAIN = process.env.AMO_DOMAIN;
const AMO_LOGIN = process.env.AMO_LOGIN;
const AMO_HASH = process.env.AMO_HASH;

// Храним историю диалогов по talk_id
const conversations = new Map();

const SYSTEM_PROMPT = `Ты — Фокси, дружелюбный менеджер глэмпинга Fox Sisters (Самарская Лука, Жигулёвск).
Твоя задача — выяснить у клиента детали и проверить наличие домиков.

Порядок выяснения информации:
1. Дата заезда и выезда
2. Количество гостей
3. Пожелания (тип домика, бюджет — опционально)

Когда у тебя ЕСТЬ даты заезда и выезда — вызови инструмент check_availability.
Не придумывай информацию о наличии сам — только через инструмент.
Общайся тепло, коротко, по-русски.`;

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Проверяет свободные домики Fox Sisters на указанный период',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Дата заезда YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Дата выезда YYYY-MM-DD' }
      },
      required: ['date_from', 'date_to']
    }
  }
];

// ─── Обработка входящих сообщений из AmoCRM ──────────────────────────────────

app.post('/amo-webhook', async (req, res) => {
  console.log('AmoCRM webhook:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);

  try {
    const body = req.body;
    const message = extractMessage(body);
    const talkId = extractTalkId(body);
    const messageType = extractMessageType(body);

    // Пропускаем исходящие сообщения (от бота/менеджера)
    if (!message || !talkId || messageType === 'outbound') {
      console.log('Пропускаем:', { message: !!message, talkId, messageType });
      return;
    }

    console.log(`Входящее сообщение (talk ${talkId}): ${message}`);

    // Получаем или создаём историю диалога
    if (!conversations.has(talkId)) {
      conversations.set(talkId, []);
    }
    const history = conversations.get(talkId);
    history.push({ role: 'user', content: message });

    // Запускаем агента
    const reply = await runAgent(history);
    if (reply) {
      history.push({ role: 'assistant', content: reply });
      await sendChatMessage(talkId, reply);
    }

  } catch (err) {
    console.error('Ошибка /amo-webhook:', err.message);
  }
});

// ─── Агент с Claude ───────────────────────────────────────────────────────────

async function runAgent(history) {
  let messages = [...history];

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text || null;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUse = response.content.find(b => b.type === 'tool_use');
      if (!toolUse) break;

      console.log(`Вызов инструмента: ${toolUse.name}`, toolUse.input);

      let toolResult;
      if (toolUse.name === 'check_availability') {
        toolResult = await handleCheckAvailability(toolUse.input);
      } else {
        toolResult = 'Неизвестный инструмент';
      }

      console.log('Результат инструмента:', toolResult);

      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] }
      ];
      continue;
    }

    break;
  }
  return null;
}

async function handleCheckAvailability({ date_from, date_to }) {
  try {
    const { freeRooms, busyRooms } = await checkAvailability(date_from, date_to);
    if (freeRooms.length === 0) {
      return `На ${date_from} – ${date_to} все домики заняты.`;
    }
    const list = freeRooms.map(r => r.name).join(', ');
    return `Свободны: ${list}. Занято: ${busyRooms.map(r => r.name).join(', ') || 'нет'}.`;
  } catch (e) {
    return `Ошибка проверки: ${e.message}`;
  }
}

// ─── Старый Salesbot endpoint (оставляем для совместимости) ─────────────────

app.post('/availability', async (req, res) => {
  const { data, return_url } = req.body;
  res.sendStatus(200);
  try {
    const dateFrom = data?.date_from;
    const dateTo = data?.date_to;
    if (!dateFrom || !dateTo) {
      await sendToAmo(return_url, 'Уточни дату заезда и выезда.');
      return;
    }
    const { freeRooms } = await checkAvailability(dateFrom, dateTo);
    const message = freeRooms.length === 0
      ? formatNoAvailability(dateFrom, dateTo)
      : formatAvailability(freeRooms, dateFrom, dateTo);
    await sendToAmo(return_url, message);
  } catch (err) {
    await sendToAmo(return_url, 'Не смог проверить — уточню дополнительно.').catch(() => {});
  }
});

// ─── Отправка сообщения в чат AmoCRM ─────────────────────────────────────────

async function sendChatMessage(talkId, text) {
  try {
    const url = `https://${AMO_DOMAIN}/api/v4/talks/${talkId}/messages`;
    const resp = await axios.post(url, { text }, {
      params: { USER_LOGIN: AMO_LOGIN, USER_HASH: AMO_HASH }
    });
    console.log(`Ответ отправлен в talk ${talkId}`);
  } catch (err) {
    console.error('Ошибка отправки:', err.response?.status, err.response?.data || err.message);
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
  return body?.message?.add?.[0]?.text
    || body?.message?.text
    || body?.messages?.[0]?.text
    || body?.text
    || null;
}

function extractTalkId(body) {
  return body?.message?.add?.[0]?.talk_id
    || body?.talk_id
    || body?.message?.talk_id
    || body?.messages?.[0]?.talk_id
    || null;
}

function extractMessageType(body) {
  return body?.message?.add?.[0]?.type
    || body?.message?.type
    || null;
}

function formatAvailability(freeRooms, dateFrom, dateTo) {
  const list = freeRooms.map(r => `• ${r.name}`).join('\n');
  return `На ${formatDate(dateFrom)} – ${formatDate(dateTo)} свободны:\n${list}\n\nПодобрать что-то под ваши пожелания? 😊`;
}

function formatNoAvailability(dateFrom, dateTo) {
  return `К сожалению, на ${formatDate(dateFrom)} – ${formatDate(dateTo)} все домики заняты 😔\nМогу посмотреть другие даты?`;
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

app.get('/test-agent', async (req, res) => {
  const { msg } = req.query;
  if (!msg) return res.json({ error: 'Укажи ?msg=текст' });
  try {
    const history = [{ role: 'user', content: msg }];
    const reply = await runAgent(history);
    res.json({ reply });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── Старт ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
