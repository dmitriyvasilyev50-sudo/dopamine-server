/**
 * Dopamine JVC — Webhook Server
 * 
 * Запуск:
 *   npm install express cors
 *   node dopamine-server.js
 * 
 * Или с автоперезапуском:
 *   npm install -g nodemon
 *   nodemon dopamine-server.js
 * 
 * Порт по умолчанию: 3001
 * Вебхук URL для Langame: http://YOUR_IP:3001/webhook/langame
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ============================================================
// IN-MEMORY STATE  (заменяется при каждом push от Langame)
// ============================================================
let STATE = {
  lastUpdate: null,
  hall: {
    sessions: [],     // активные сессии
    bookings: [],     // брони на сегодня
    zones: {          // загрузка зон
      Comfort: { occupied: 0, capacity: 20 },
      BC:      { occupied: 0, capacity: 12 },
      VIP2K:   { occupied: 0, capacity: 11 },
      VIP4K:   { occupied: 0, capacity: 5  },
      PS:      { occupied: 0, capacity: 4  }
    }
  },
  currentAdmin: null  // кто сейчас на смене (из Langame логина)
};

// SSE clients (подключённые браузеры)
let clients = [];

// ============================================================
// SSE — отправить всем подключённым браузерам
// ============================================================
function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(res => {
    try { res.write(msg); return true; }
    catch(e) { return false; }
  });
  console.log(`[SSE] broadcast "${eventName}" → ${clients.length} clients`);
}

// ============================================================
// SSE ENDPOINT  (браузер подключается сюда)
// GET /events
// ============================================================
app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Сразу отдать текущее состояние
  res.write(`event: init\ndata: ${JSON.stringify(STATE)}\n\n`);

  clients.push(res);
  console.log(`[SSE] client connected (total: ${clients.length})`);

  // Пинг каждые 25 сек чтобы соединение не падало
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients = clients.filter(c => c !== res);
    console.log(`[SSE] client disconnected (total: ${clients.length})`);
  });
});

// ============================================================
// REST — получить текущее состояние (для polling fallback)
// GET /api/state
// ============================================================
app.get('/api/state', (req, res) => {
  res.json(STATE);
});

// ============================================================
// WEBHOOK — Langame отправляет данные сюда
// POST /webhook/langame
//
// Ожидаемые форматы:
// 1. Полный снапшот зала:
//    { type: "hall_snapshot", sessions: [...], bookings: [...], admin: {...} }
//
// 2. Только сессии:
//    { type: "sessions_update", sessions: [...] }
//
// 3. Только брони:
//    { type: "bookings_update", bookings: [...] }
//
// 4. Логин/выход администратора:
//    { type: "admin_login",  admin: { name, login, shiftType } }
//    { type: "admin_logout", admin: { name, login } }
//
// 5. Закрытие смены:
//    { type: "shift_close", admin: { name }, revenue: 12000, barRevenue: 1500 }
// ============================================================
app.post('/webhook/langame', (req, res) => {
  const { type, ...payload } = req.body;
  const ts = new Date().toISOString();

  console.log(`[WEBHOOK] ${ts} type="${type}"`, JSON.stringify(payload).slice(0, 200));

  if (!type) {
    return res.status(400).json({ error: 'Missing type field' });
  }

  STATE.lastUpdate = ts;

  switch (type) {

    case 'hall_snapshot': {
      // Полный снапшот: сессии + брони + инфо о смене
      if (payload.sessions) {
        STATE.hall.sessions = normalizeSessions(payload.sessions);
        recalcZones();
      }
      if (payload.bookings) {
        STATE.hall.bookings = normalizeBookings(payload.bookings);
      }
      if (payload.admin) {
        STATE.currentAdmin = payload.admin;
      }
      broadcast('hall_snapshot', STATE);
      break;
    }

    case 'sessions_update': {
      STATE.hall.sessions = normalizeSessions(payload.sessions || []);
      recalcZones();
      broadcast('sessions_update', {
        sessions: STATE.hall.sessions,
        zones: STATE.hall.zones,
        lastUpdate: ts
      });
      break;
    }

    case 'bookings_update': {
      STATE.hall.bookings = normalizeBookings(payload.bookings || []);
      broadcast('bookings_update', {
        bookings: STATE.hall.bookings,
        lastUpdate: ts
      });
      break;
    }

    case 'admin_login': {
      STATE.currentAdmin = payload.admin || null;
      broadcast('admin_login', {
        admin: STATE.currentAdmin,
        lastUpdate: ts
      });
      break;
    }

    case 'admin_logout': {
      STATE.currentAdmin = null;
      broadcast('admin_logout', { lastUpdate: ts });
      break;
    }

    case 'shift_close': {
      // Langame закрыл смену — сообщаем браузеру
      broadcast('shift_close', {
        admin:      payload.admin,
        revenue:    payload.revenue    || 0,
        barRevenue: payload.barRevenue || 0,
        lastUpdate: ts
      });
      // Сбросить текущего администратора
      STATE.currentAdmin = null;
      break;
    }

    default: {
      console.warn(`[WEBHOOK] Unknown type: ${type}`);
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  }

  res.json({ ok: true, type, timestamp: ts });
});

// ============================================================
// ТЕСТОВЫЙ ЭНДПОИНТ — имитировать push от Langame
// POST /test/push
// { "type": "sessions_update", "sessions": [...] }
// ============================================================
app.post('/test/push', (req, res) => {
  // Просто перенаправляем в /webhook/langame
  req.url = '/webhook/langame';
  app.handle(req, res);
});

// ============================================================
// ТЕСТОВЫЙ СНАПШОТ — заполнить демо-данными
// GET /test/demo
// ============================================================
app.get('/test/demo', (req, res) => {
  STATE.hall.sessions = [
    { pc: 6,  guestName: 'Jorge Villanueva', phone4: '1258', tariff: '3h Pack',     endTime: Date.now() + 84*60000,  zone: 'Comfort' },
    { pc: 15, guestName: 'Rami Sabayon',     phone4: '4020', tariff: 'Evening Pack', endTime: Date.now() + 227*60000, zone: 'Comfort' },
    { pc: 11, guestName: null,               phone4: '3841', tariff: 'Hourly',       endTime: null,                   zone: 'Comfort' },
    { pc: 24, guestName: 'Marwan Helmy',     phone4: '6362', tariff: '5h Pack',      endTime: Date.now() + 252*60000, zone: 'BC',     hasBooking: true },
    { pc: 38, guestName: 'Malik Ivanov',     phone4: '9246', tariff: '3h Pack',      endTime: Date.now() + 22*60000,  zone: 'VIP2K',  hasBooking: true },
    { pc: 44, guestName: 'Raif Al Hamed',   phone4: '0397', tariff: 'Evening Pack', endTime: Date.now() + 175*60000, zone: 'VIP4K'  }
  ];
  STATE.hall.bookings = [
    { guestName: 'Adam Hamed',  phone4: '4691', zone: 'Comfort', pc: 30, timeFrom: '11:00', timeTo: '14:00' },
    { guestName: null,           phone4: '5521', zone: 'Comfort', pc: 7,  timeFrom: '12:30', timeTo: '17:30' },
    { guestName: 'Delvin Swart', phone4: '2733', zone: 'Comfort', pc: 5,  timeFrom: '14:00', timeTo: '19:00' },
    { guestName: 'Корпоратив',   phone4: null,   zone: 'Comfort', pcs: [1,2,3,4,5], timeFrom: '18:00', timeTo: '23:00', isGroup: true }
  ];
  STATE.currentAdmin = { name: 'Олег Павлов', login: 'oleg', shiftType: 'Дневная', shiftHours: '09:00–21:00' };
  STATE.lastUpdate = new Date().toISOString();
  recalcZones();
  broadcast('hall_snapshot', STATE);
  res.json({ ok: true, message: 'Demo data pushed to all clients', clients: clients.length });
});

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, clients: clients.length, lastUpdate: STATE.lastUpdate });
});

// ============================================================
// HELPERS
// ============================================================
function normalizeSessions(sessions) {
  return sessions.map(s => ({
    pc:          s.pc          || s.computer || 0,
    guestName:   s.guestName   || s.name     || null,
    phone4:      s.phone4      || (s.phone ? String(s.phone).slice(-4) : null),
    tariff:      s.tariff      || s.package  || 'Hourly',
    endTime:     s.endTime     || (s.endsAt ? new Date(s.endsAt).getTime() : null),
    zone:        s.zone        || detectZone(s.pc || s.computer || 0),
    hasBooking:  s.hasBooking  || false
  }));
}

function normalizeBookings(bookings) {
  return bookings.map(b => ({
    guestName: b.guestName || b.name || null,
    phone4:    b.phone4    || (b.phone ? String(b.phone).slice(-4) : null),
    zone:      b.zone      || 'Comfort',
    pc:        b.pc        || b.computer || null,
    pcs:       b.pcs       || null,
    timeFrom:  b.timeFrom  || b.from    || '—',
    timeTo:    b.timeTo    || b.to      || '—',
    isGroup:   b.isGroup   || (b.pcs && b.pcs.length > 1) || false
  }));
}

function detectZone(pc) {
  if (pc >= 1  && pc <= 20) return 'Comfort';
  if (pc >= 21 && pc <= 32) return 'BC';
  if (pc >= 33 && pc <= 43) return 'VIP2K';
  if (pc >= 44 && pc <= 48) return 'VIP4K';
  return 'PS';
}

function recalcZones() {
  // Сбросить
  Object.keys(STATE.hall.zones).forEach(z => {
    STATE.hall.zones[z].occupied = 0;
  });
  // Посчитать
  STATE.hall.sessions.forEach(s => {
    const z = s.zone;
    if (STATE.hall.zones[z]) STATE.hall.zones[z].occupied++;
  });
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Dopamine Admin — Webhook Server      ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  Webhook:   POST http://localhost:${PORT}/webhook/langame`);
  console.log(`  Events:    GET  http://localhost:${PORT}/events  (SSE)`);
  console.log(`  Health:    GET  http://localhost:${PORT}/health`);
  console.log(`  Demo push: GET  http://localhost:${PORT}/test/demo`);
  console.log('');
  console.log('  Waiting for connections...');
  console.log('');
});
