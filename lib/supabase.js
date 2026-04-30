const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { "x-application-name": "dopamine-server" },
    },
  });
} else {
  console.warn(
    "[supabase] SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не заданы. Supabase-клиент не инициализирован."
  );
}

async function ping() {
  if (!supabase) return { ok: false, reason: "not_initialized" };
  try {
    const { data, error } = await supabase.from("clubs").select("id").limit(1);
    if (error) {
      console.error("[supabase] ping error object:", JSON.stringify(error));
      return {
        ok: false,
        reason: error.message || error.code || error.hint || "supabase_query_error",
        code: error.code || null,
        details: error.details || null,
      };
    }
    return { ok: true, rows_seen: Array.isArray(data) ? data.length : 0 };
  } catch (e) {
    console.error("[supabase] ping exception:", e);
    return { ok: false, reason: e?.message || String(e) || "exception" };
  }
}

module.exports = { supabase, ping };
