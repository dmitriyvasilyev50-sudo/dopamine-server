require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { supabase, ping: supabasePing } = require("./lib/supabase");
const { complete: aiComplete, ping: anthropicPing, DEFAULT_MODEL, FAST_MODEL } = require("./lib/anthropic");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// SSE: real-time события для прототипа v7
// ---------------------------------------------------------------------------

const clients = new Set();
const ALLOWED = new Set([
  "sessions_update",
  "bookings_update",
  "hall_snapshot",
  "admin_login",
  "admin_logout",
  "shift_close",
  "external_event",
]);

function broadcast(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(message);
}

// ---------------------------------------------------------------------------
// HEALTH
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true, clients: clients.size }));

app.get("/health/full", async (_req, res) => {
  const [sb, an] = await Promise.all([supabasePing(), anthropicPing()]);
  const ok = sb.ok && an.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    clients: clients.size,
    supabase: sb,
    anthropic: an,
    models: { default: DEFAULT_MODEL, fast: FAST_MODEL },
    uptime_sec: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// SSE-канал
// ---------------------------------------------------------------------------

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Webhook от Langame (как было)
// ---------------------------------------------------------------------------

app.post("/webhook/langame", (req, res) => {
  const event = req.body || {};
  if (!ALLOWED.has(event.type)) {
    return res.status(400).json({ ok: false, error: "Unsupported event type" });
  }
  broadcast(event);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Webhook от внешних продуктов Dopamine (LMS, видео-аудио мониторинг и т.п.)
// ---------------------------------------------------------------------------
//
// Контракт (минимально):
// {
//   "source": "lms" | "video_audio" | "service_inspector" | ...,
//   "type": "exam_passed" | "upsell_missed" | "checklist_review" | ...,
//   "club": "JVC" | "JBR",
//   "occurred_at": "ISO8601",
//   "subject": { ... }   // про кого/что
//   "payload": { ... }   // произвольные данные источника
// }
//
// Сервер:
//  1) Записывает в таблицу external_events (если Supabase настроен).
//  2) Транслирует в SSE как { type: "external_event", ... } — UI решит, что показать.
// ---------------------------------------------------------------------------

app.post("/webhook/external", async (req, res) => {
  const body = req.body || {};
  const required = ["source", "type", "club"];
  const missing = required.filter((k) => !body[k]);
  if (missing.length) {
    return res.status(400).json({ ok: false, error: "missing_fields", missing });
  }

  const occurredAt = body.occurred_at || new Date().toISOString();
  const sev = body.severity && ["low", "medium", "high"].includes(body.severity) ? body.severity : null;

  const event = {
    source: String(body.source),
    event_type: String(body.type),
    club_id: String(body.club).toUpperCase(),
    employee_id: body.employee_id || null,
    zone: body.zone || null,
    severity: sev,
    details: body.details || body.payload || null,
    recommended_action: body.recommended_action || null,
    target_role: body.target_role || null,
    occurred_at: occurredAt,
  };

  let saved = null;
  if (supabase) {
    const { data, error } = await supabase
      .from("external_events")
      .insert(event)
      .select("id")
      .single();
    if (error) {
      console.error("[external] supabase insert error:", error.message);
      return res.status(500).json({ ok: false, error: "db_error", detail: error.message });
    }
    saved = data;
  } else {
    console.warn("[external] supabase not configured, event NOT persisted:", event);
  }

  broadcast({
    type: "external_event",
    source: event.source,
    event_type: event.event_type,
    club: event.club_id,
    occurred_at: event.occurred_at,
    severity: event.severity,
    target_role: event.target_role,
  });

  return res.json({ ok: true, id: saved?.id || null });
});

// ---------------------------------------------------------------------------
// AI: краткое резюме по одному ПК (тикеты + жалобы)
// ---------------------------------------------------------------------------
//
// POST /ai/summary
// body: { club: "JVC", pc_number: 25, days: 30 }
// Берём последние тикеты и жалобы по этому ПК → отдаём в Claude → возвращаем
// плотный текст с тремя блоками: что происходит / что чинили / что делать.
// ---------------------------------------------------------------------------

app.post("/ai/summary", async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: "supabase_not_configured" });

  const { club, pc_number, days = 30 } = req.body || {};
  if (!club || pc_number === undefined || pc_number === null) {
    return res.status(400).json({ ok: false, error: "missing_fields", required: ["club", "pc_number"] });
  }

  const clubUp = String(club).toUpperCase();
  const pcNum = Number(pc_number);
  if (!Number.isInteger(pcNum)) {
    return res.status(400).json({ ok: false, error: "pc_number_must_be_integer" });
  }

  const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();

  const { data: tickets, error: tErr } = await supabase
    .from("tickets")
    .select("id, created_at, status, severity, priority, component, problem, notes, resolved_at")
    .eq("club_id", clubUp)
    .eq("pc_number", pcNum)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);

  if (tErr) return res.status(500).json({ ok: false, error: "db_error", detail: tErr.message });

  const { data: complaints, error: cErr } = await supabase
    .from("guest_complaints")
    .select("id, occurred_at, status, message, guest_name")
    .eq("club_id", clubUp)
    .eq("pc_number", pcNum)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(20);

  if (cErr) return res.status(500).json({ ok: false, error: "db_error", detail: cErr.message });

  if ((tickets?.length || 0) === 0 && (complaints?.length || 0) === 0) {
    return res.json({
      ok: true,
      empty: true,
      summary: `За ${days} дней по ПК ${pcNum} (${clubUp}) нет ни одного тикета и ни одной жалобы. Машина работает чисто.`,
    });
  }

  const userPrompt = [
    `Клуб: ${clubUp}. ПК №${pcNum}. Период: последние ${days} дней.`,
    ``,
    `ТИКЕТЫ (${tickets?.length || 0}):`,
    JSON.stringify(tickets || [], null, 2),
    ``,
    `ЖАЛОБЫ ГОСТЕЙ (${complaints?.length || 0}):`,
    JSON.stringify(complaints || [], null, 2),
    ``,
    `Сделай краткое резюме на 5–8 строк по структуре:`,
    `1) ЧТО ПРОИСХОДИТ — какие 1–3 проблемы повторяются (компонент + симптом).`,
    `2) ЧТО ЧИНИЛИ — есть ли одинаковые ремонты подряд (= техподдержка не лечит корень).`,
    `3) ЧТО ДЕЛАТЬ — 1–2 конкретных следующих шага.`,
    `Без воды. На русском.`,
  ].join("\n");

  const ai = await aiComplete({
    system: "Ты технический аналитик компьютерного клуба. Пишешь сухо и по делу, цифрами.",
    user: userPrompt,
    maxTokens: 600,
  });

  if (!ai.ok) return res.status(502).json({ ok: false, error: "ai_failed", detail: ai.error });

  return res.json({
    ok: true,
    club: clubUp,
    pc_number: pcNum,
    period_days: days,
    counts: { tickets: tickets?.length || 0, complaints: complaints?.length || 0 },
    model: ai.model,
    summary: ai.text,
  });
});

// ---------------------------------------------------------------------------
// AI: общий анализ парка (агрегаты по клубу)
// ---------------------------------------------------------------------------
//
// POST /ai/parc-analysis
// body: { club: "JVC", days: 30 }
// Группирует тикеты/жалобы за период и просит Claude выделить
// топ-3 проблемных ПК и системные паттерны (не разовые).
// ---------------------------------------------------------------------------

app.post("/ai/parc-analysis", async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: "supabase_not_configured" });

  const { club, days = 30 } = req.body || {};
  if (!club) return res.status(400).json({ ok: false, error: "missing_fields", required: ["club"] });

  const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
  const clubUp = String(club).toUpperCase();

  const { data: tickets, error: tErr } = await supabase
    .from("tickets")
    .select("pc_number, zone_name, status, severity, component, problem, created_at")
    .eq("club_id", clubUp)
    .gte("created_at", since)
    .limit(500);
  if (tErr) return res.status(500).json({ ok: false, error: "db_error", detail: tErr.message });

  const { data: complaints, error: cErr } = await supabase
    .from("guest_complaints")
    .select("pc_number, message, occurred_at, status")
    .eq("club_id", clubUp)
    .gte("occurred_at", since)
    .limit(500);
  if (cErr) return res.status(500).json({ ok: false, error: "db_error", detail: cErr.message });

  const byPc = {};
  for (const t of tickets || []) {
    if (t.pc_number == null) continue;
    const k = String(t.pc_number);
    byPc[k] = byPc[k] || { tickets: 0, complaints: 0, components: {}, problems: [], zone: t.zone_name };
    byPc[k].tickets += 1;
    if (t.component) byPc[k].components[t.component] = (byPc[k].components[t.component] || 0) + 1;
    if (t.problem) byPc[k].problems.push(t.problem);
  }
  for (const c of complaints || []) {
    if (c.pc_number == null) continue;
    const k = String(c.pc_number);
    byPc[k] = byPc[k] || { tickets: 0, complaints: 0, components: {}, problems: [], zone: null };
    byPc[k].complaints += 1;
  }

  const aggregate = Object.entries(byPc)
    .map(([pc_number, v]) => ({
      pc_number: Number(pc_number),
      zone: v.zone,
      tickets: v.tickets,
      complaints: v.complaints,
      total: v.tickets + v.complaints,
      top_components: Object.entries(v.components)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c, n]) => ({ component: c, count: n })),
      sample_problems: v.problems.slice(0, 5),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  if (aggregate.length === 0) {
    return res.json({
      ok: true,
      empty: true,
      summary: `За ${days} дней по ${clubUp} нет тикетов и жалоб. Парк работает чисто.`,
    });
  }

  const userPrompt = [
    `Клуб: ${clubUp}. Период: ${days} дней.`,
    `Топ ПК по числу инцидентов (тикеты + жалобы):`,
    JSON.stringify(aggregate, null, 2),
    ``,
    `Сделай отчёт на 8–12 строк:`,
    `1) ТОП-3 ПРОБЛЕМНЫХ ПК — номер, цифры, главный компонент, краткое "почему".`,
    `2) ПАТТЕРНЫ — есть ли одинаковые проблемы на разных машинах (один тип компонента, одна зона). Не выдумывай.`,
    `3) РЕКОМЕНДАЦИИ — 3 конкретных действия для менеджера на эту неделю.`,
    `Если паттернов нет — так и пиши. На русском.`,
  ].join("\n");

  const ai = await aiComplete({
    system: "Ты аналитик IT-инфраструктуры компьютерного клуба. Цифры важнее эмоций.",
    user: userPrompt,
    maxTokens: 900,
  });

  if (!ai.ok) return res.status(502).json({ ok: false, error: "ai_failed", detail: ai.error });

  return res.json({
    ok: true,
    club: clubUp,
    period_days: days,
    top_pc: aggregate.slice(0, 5),
    counts: { tickets: tickets?.length || 0, complaints: complaints?.length || 0 },
    model: ai.model,
    summary: ai.text,
  });
});

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`dopamine-server listening on :${port}`);
  console.log(`  supabase:  ${supabase ? "configured" : "NOT configured"}`);
  console.log(`  anthropic: ${process.env.ANTHROPIC_API_KEY ? "configured" : "NOT configured"}`);
});
