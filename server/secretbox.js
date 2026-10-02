// Encrypts secrets kept in the database (stream keys, Twitch/Kick sign-in tokens) with AES-256-GCM.
// The secret is STREAM_KEY_SECRET from the host, or one made once and kept in the settings table.
import crypto from 'node:crypto';
import { q, one } from './db.js';

let key = null;
async function cipherKey() {
  if (!key) {
    let secret = String(process.env.STREAM_KEY_SECRET || '').trim();
    if (!secret) {
      await q("INSERT INTO settings (key, value) VALUES ('_stream_key_secret', $1) ON CONFLICT DO NOTHING", [crypto.randomBytes(32).toString('hex')]);
      secret = (await one("SELECT value FROM settings WHERE key='_stream_key_secret'")).value;
    }
    key = crypto.createHash('sha256').update(`wpg-stream-keys:${secret}`).digest();
  }
  return key;
}

export async function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', await cipherKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

// Only for server-side use (e.g. calling Twitch with a member's token). Never send the result to a browser.
export async function open(sealed) {
  const [v, iv, tag, data] = String(sealed || '').split(':');
  if (v !== 'v1' || !data) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', await cipherKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
