// lib/googleCreds.js
function getServiceAccountFromEnv() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64 && b64.trim()) {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    json.private_key = String(json.private_key || '').replace(/\\n/g, '\n');
    return { creds: json, source: 'base64' };
  }

  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw && raw.trim()) {
    const json = JSON.parse(raw);
    json.private_key = String(json.private_key || '').replace(/\\n/g, '\n');
    return { creds: json, source: 'json' };
  }

  return null;
}

module.exports = { getServiceAccountFromEnv };