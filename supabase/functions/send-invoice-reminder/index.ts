// supabase/functions/send-invoice-reminder/index.ts
// Edge function: sends queued SMS reminders via Termii gateway.
// Invoked from client with { reminder_id } — fetches the reminder row,
// dispatches SMS via Termii, updates row with gateway response.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY")!;
const TERMII_SENDER_ID = Deno.env.get("TERMII_SENDER_ID") || "MEDHUB";
const TERMII_CHANNEL = "dnd";  // 'dnd' delivers to all numbers including DND-listed
const TERMII_BASE_URL = "https://api.ng.termii.com/api/sms/send";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

interface ReminderRow {
  id: string;
  hospital_id: string;
  patient_id: string;
  invoice_id: string | null;
  payment_plan_id: string | null;
  reminder_type: string;
  channel: string;
  phone_number: string | null;
  email_address: string | null;
  message_body: string;
  amount_outstanding: number;
  days_overdue: number;
  status: string;
  sent_by: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { reminder_id, reminder_ids } = body;

  // Bulk dispatch: pass array of reminder_ids
  const ids: string[] = reminder_ids || (reminder_id ? [reminder_id] : []);
  if (ids.length === 0) {
    return json({ error: "reminder_id or reminder_ids required" }, 400);
  }

  const results: any[] = [];

  for (const id of ids) {
    try {
      const result = await dispatchOne(id);
      results.push({ id, ...result });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  return json({ dispatched: ok, failed, results });
});

async function dispatchOne(reminderId: string) {
  // Load reminder row
  const { data: reminder, error } = await supabase
    .from("invoice_reminders")
    .select("*")
    .eq("id", reminderId)
    .single<ReminderRow>();

  if (error || !reminder) {
    throw new Error(`Reminder ${reminderId} not found`);
  }

  if (reminder.status === "sent" || reminder.status === "delivered") {
    return { ok: true, skipped: "already sent" };
  }

  if (!reminder.phone_number) {
    await supabase
      .from("invoice_reminders")
      .update({
        status: "failed",
        error_message: "Patient has no phone number on file",
        updated_at: new Date().toISOString(),
      })
      .eq("id", reminderId);
    throw new Error("No phone number on file");
  }

  // Normalize phone (Nigerian default)
  const phone = normalizePhone(reminder.phone_number);
  if (!phone) {
    await supabase
      .from("invoice_reminders")
      .update({
        status: "failed",
        error_message: `Invalid phone: ${reminder.phone_number}`,
      })
      .eq("id", reminderId);
    throw new Error(`Invalid phone: ${reminder.phone_number}`);
  }

  // Send via Termii
  const payload = {
    to: phone,
    from: TERMII_SENDER_ID,
    sms: reminder.message_body,
    type: "plain",
    channel: TERMII_CHANNEL,
    api_key: TERMII_API_KEY,
  };

  try {
    const termiiResp = await fetch(TERMII_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const termiiData = await termiiResp.json();

    if (!termiiResp.ok || termiiData.code !== "ok") {
      await supabase
        .from("invoice_reminders")
        .update({
          status: "failed",
          gateway_response: termiiData,
          error_message: termiiData.message || `HTTP ${termiiResp.status}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", reminderId);
      throw new Error(`Termii: ${termiiData.message || termiiResp.status}`);
    }

    await supabase
      .from("invoice_reminders")
      .update({
        status: "sent",
        gateway_message_id: termiiData.message_id || null,
        gateway_response: termiiData,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", reminderId);

    return { ok: true, message_id: termiiData.message_id };
  } catch (e) {
    await supabase
      .from("invoice_reminders")
      .update({
        status: "failed",
        error_message: e.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reminderId);
    throw e;
  }
}

// Normalize Nigerian phone numbers to international format without +.
// e.g. "0803 123 4567" -> "2348031234567"
function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d+]/g, "");
  // Strip leading +
  if (s.startsWith("+")) s = s.slice(1);
  // 0XXXXXXXXXX -> 234XXXXXXXXXX
  if (s.startsWith("0")) s = "234" + s.slice(1);
  // +234XXXXXXXXXX -> 234XXXXXXXXXX (already handled)
  if (s.startsWith("234") && s.length === 13) return s;
  // 10-digit starting with 8/7/9 (no leading 0) -> prepend 234
  if (s.length === 10 && /^[789]/.test(s)) return "234" + s;
  if (s.length === 11 && s.startsWith("234")) return s;
  return null;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
