const Anthropic = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_LOG_REQUESTS = String(process.env.AI_LOG_REQUESTS || "false").toLowerCase() === "true";

// Модели можно переопределить через env (на случай выхода новых версий).
// На момент создания актуальные слаги — claude-sonnet-4-5 / claude-haiku-4-5.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-5";
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5";

let client = null;

if (ANTHROPIC_API_KEY) {
  client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
} else {
  console.warn("[anthropic] ANTHROPIC_API_KEY не задан. AI-эндпоинты будут возвращать 503.");
}

async function complete({
  system,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
  temperature = 0.2,
}) {
  if (!client) {
    return { ok: false, error: "anthropic_not_configured" };
  }

  if (AI_LOG_REQUESTS) {
    console.log("[anthropic] →", { model, system: (system || "").slice(0, 80), userLen: (user || "").length });
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || "Ты лаконичный аналитический ассистент. Отвечай по делу, без воды.",
      messages: [{ role: "user", content: user }],
    });

    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      ok: true,
      text,
      model: response.model,
      usage: response.usage,
    };
  } catch (e) {
    console.error("[anthropic] error:", e?.message || e);
    return { ok: false, error: e?.message || "unknown" };
  }
}

async function ping() {
  if (!client) return { ok: false, reason: "not_initialized" };
  try {
    const res = await complete({
      system: "Отвечай одним словом.",
      user: "ping?",
      model: FAST_MODEL,
      maxTokens: 16,
    });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, model: res.model };
  } catch (e) {
    return { ok: false, reason: e?.message || "unknown" };
  }
}

module.exports = { complete, ping, DEFAULT_MODEL, FAST_MODEL };
