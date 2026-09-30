// Writes capacitor.config.json so the app opens your live WPG website.
// The address comes from the APP_URL setting, or from app-url.txt if that is not set.
import fs from 'node:fs';

const raw = (process.env.APP_URL || fs.readFileSync(new URL('./app-url.txt', import.meta.url), 'utf8')).trim();
let url;
try {
  url = new URL(raw);
} catch {
  console.error(`APP_URL / app-url.txt is not a valid web address: "${raw}"`);
  process.exit(1);
}
if (url.protocol !== 'https:' || url.hostname.startsWith('change-me')) {
  console.error('Put your live https:// Replit address in android-app/app-url.txt (or the APP_URL setting) first.');
  process.exit(1);
}

const config = {
  appId: 'com.wpg.barracks',
  appName: 'WPG Barracks',
  webDir: 'www',
  server: {
    url: url.origin,
    cleartext: false,
    errorPath: 'offline.html',
    // Steam sign-in must stay inside the app so the login sticks.
    allowNavigation: [url.hostname, 'steamcommunity.com', '*.steamcommunity.com', '*.steampowered.com', '*.steamstatic.com'],
  },
  android: {
    backgroundColor: '#050a12',
  },
};
fs.writeFileSync(new URL('./capacitor.config.json', import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
fs.writeFileSync(new URL('./www/app-url.js', import.meta.url), `window.WPG_URL = ${JSON.stringify(url.origin)};\n`);
console.log(`App will open ${url.origin}`);
