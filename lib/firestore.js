// lib/firestore.js
const { Firestore } = require('@google-cloud/firestore');
const { getServiceAccountFromEnv } = require('./googleCreds');

let instance = null;
let mode = 'adc';

function getFirestore() {
  if (instance) return instance;

  const got = getServiceAccountFromEnv();
  if (got) {
    const { creds } = got;
    instance = new Firestore({
      projectId: creds.project_id,
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
    });
    mode = 'service_account';
  } else {
    instance = new Firestore(); // fallback local
    mode = 'adc';
  }

  console.log(`[Firestore] init mode=${mode}`);
  return instance;
}

module.exports = {
  db: getFirestore(),
  firestoreAuthMode: () => mode,
};