// Prints the Telegram chat id for any chat your bot can see.
// Run it, then send "/id@YOUR_BOT" (or any message) in the target group.
//   TG_BOT_TOKEN=123:abc node scripts/get-chat-id.js
const token = process.env.TG_BOT_TOKEN;
if (!token) { console.error("Set TG_BOT_TOKEN"); process.exit(1); }

let offset = 0;
const seen = new Set();
console.log("Listening… now send  /id@YOUR_BOT  in the group (Ctrl+C to stop)\n");

async function poll() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`);
    const j = await r.json();
    if (!j.ok) { console.error("Telegram error:", j.description); if (j.description && j.description.includes("webhook")) { await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`); console.log("(cleared a webhook that was blocking getUpdates; retrying)"); } }
    for (const u of j.result || []) {
      offset = u.update_id + 1;
      const chat = (u.message || u.my_chat_member || u.channel_post || {}).chat;
      if (chat && !seen.has(chat.id)) {
        seen.add(chat.id);
        console.log(`FOUND chat id: ${chat.id}   (${chat.type}${chat.title ? " — " + chat.title : ""})`);
        console.log(`  -> use  TG_CHAT_ID=${chat.id}\n`);
      }
    }
  } catch (e) { console.error("poll error:", e.message); }
  setTimeout(poll, 500);
}
poll();
