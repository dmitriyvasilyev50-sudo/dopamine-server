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
    const { error } = await supabase.from("clubs").select("id", { count: "exact", head: true });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || "unknown" };
  }
}

module.exports = { supabase, ping };
