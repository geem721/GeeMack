import 'dotenv/config';
import twilio from 'twilio';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const messages = await client.messages.list({ to: process.env.ADMIN_NOTIFY_PHONE, limit: 5 });
for (const m of messages) {
  console.log(m.dateCreated, '|', m.status, '| error:', m.errorCode, m.errorMessage);
}
