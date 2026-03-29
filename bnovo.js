const axios = require('axios');

const BASE_URL = 'https://api.pms.bnovo.ru';
let token = null;
let tokenExpiry = 0;

// Все домики Fox Sisters с их ID из Bnovo (только размещение, без услуг)
const ALL_ROOMS = [
  { id: 1172833, name: 'Домик Мышки' },
  { id: 1172834, name: 'Домик Барсука' },
  { id: 1172835, name: 'Домик Индия 1' },
  { id: 1172837, name: 'Домик Бали 1' },
  { id: 1172838, name: 'Домик Бали 2' },
  { id: 1172839, name: 'Домик Зайки' },
  { id: 1172840, name: 'Домик Лисы' },
  { id: 1172841, name: 'Домик Совы' },
  { id: 1172842, name: 'Резиденция Хозяйки Жигулей' },
  { id: 1172843, name: 'Купол 1' },
  { id: 1172844, name: 'Купол 2' },
  { id: 1172845, name: 'Купол 3' },
  { id: 1199603, name: 'Семейный дом' },
];

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;
  const res = await axios.post(`${BASE_URL}/api/v1/auth`, {
    id: Number(process.env.BNOVO_ACCOUNT_ID),
    password: process.env.BNOVO_API_KEY
  });
  token = res.data.data.access_token;
  tokenExpiry = Date.now() + (res.data.data.expires_in - 300) * 1000;
  return token;
}

// Получить все активные брони (Bnovo фильтрует по дате создания, поэтому берём широкий диапазон)
let bookingsCache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function getAllBookings() {
  if (bookingsCache && Date.now() - cacheTime < CACHE_TTL) return bookingsCache;

  const t = await getToken();
  const headers = { Authorization: `Bearer ${t}` };
  const allBookings = [];
  let offset = 0;

  // Берём все брони созданные за последние 2 года и на 2 года вперёд
  const dateFrom = '2024-01-01';
  const dateTo = '2028-01-01';

  while (true) {
    const res = await axios.get(`${BASE_URL}/api/v1/bookings`, {
      headers,
      params: { date_from: dateFrom, date_to: dateTo, limit: 50, offset }
    });
    const bookings = res.data.data?.bookings || [];
    allBookings.push(...bookings);
    if (bookings.length < 50) break;
    offset += 50;
  }

  bookingsCache = allBookings;
  cacheTime = Date.now();
  return allBookings;
}

// Проверить наличие на период (dateFrom/dateTo в формате YYYY-MM-DD)
async function checkAvailability(dateFrom, dateTo) {
  const allBookings = await getAllBookings();

  const checkIn = new Date(dateFrom);
  const checkOut = new Date(dateTo);

  const bookedRoomIds = new Set();

  for (const b of allBookings) {
    // Пропускаем отменённые
    const statusName = b.status?.name || '';
    if (statusName.toLowerCase().includes('отмен') || statusName.toLowerCase().includes('cancel')) continue;

    const arrival = new Date(b.dates?.arrival);
    const departure = new Date(b.dates?.departure);

    // Пересечение периодов: бронь занимает домик если заезд < наш выезд И выезд > наш заезд
    if (arrival < checkOut && departure > checkIn) {
      if (b.room_id) bookedRoomIds.add(b.room_id);
    }
  }

  const freeRooms = ALL_ROOMS.filter(r => !bookedRoomIds.has(r.id));
  const busyRooms = ALL_ROOMS.filter(r => bookedRoomIds.has(r.id));

  return { freeRooms, busyRooms, total: ALL_ROOMS.length };
}

// Сброс кеша (вызывать при необходимости)
function clearCache() {
  bookingsCache = null;
  cacheTime = 0;
}

module.exports = { checkAvailability, clearCache, ALL_ROOMS };
