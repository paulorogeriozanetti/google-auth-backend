const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const bodyParser = require('body-parser');
const path = require('path'); // Servir arquivos estáticos

const app = express();
const PORT = 3000;

// 🔐 Configuração do CORS (em produção: especifique seu domínio real)
app.use(cors());

// 📦 Interpreta JSON nas requisições
app.use(bodyParser.json());

// 📂 Servir arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// 🧩 Google OAuth config
const CLIENT_ID = '775119501851-1qsm8b7sf50k0jar8i75qsffh0hfi0pl.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

// 🛠️ Endpoint para validar o ID Token recebido do One Tap
app.post('/auth/google', async (req, res) => {
  const { idToken, anonId } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: CLIENT_ID
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email || '';
    const name = payload.name || '';
    const userId = `usr_${googleId.slice(-10)}`; // Gera ID interno com base no Google ID

    console.log(`[✔️ Login] ${email} | ID: ${googleId} | user_id: ${userId}`);
    if (anonId) {
      console.log(`[🔗 Vinculando anon_id] ${anonId}`);
      // Aqui você pode salvar no banco:
      // { anon_id: anonId, user_id: userId, email, nome, timestamp }
    }

    res.json({
      success: true,
      user_id: userId,
      name,
      email
    });

  } catch (error) {
    console.error('[❌ Auth Error]', error);
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

// 🚀 Iniciar o servidor
app.listen(PORT, () => {
  console.log(`🚀 Auth server running on http://localhost:${PORT}`);
});