require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const passport     = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool }     = require('pg');
const { google }   = require('googleapis');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── BANCO DE DADOS ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Cria tabelas se não existirem
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200),
      email VARCHAR(200) UNIQUE NOT NULL,
      perfil VARCHAR(20) DEFAULT 'professor',
      telefone VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS aulas (
      id VARCHAR(300) PRIMARY KEY,
      titulo VARCHAR(500),
      professor_email VARCHAR(200),
      data_aula DATE,
      hora_inicio VARCHAR(10),
      hora_fim VARCHAR(10),
      telefone_responsavel VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS feedbacks (
      id SERIAL PRIMARY KEY,
      aula_id VARCHAR(300) NOT NULL,
      professor_email VARCHAR(200),
      aluno VARCHAR(200),
      data_aula VARCHAR(20),
      feedback TEXT,
      imagem_url VARCHAR(500),
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alertas_enviados (
      id SERIAL PRIMARY KEY,
      aula_id VARCHAR(300),
      tipo VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE(aula_id, tipo)
    );
  `);
  console.log('Banco de dados inicializado');
}

// ── UPLOAD DE IMAGENS ───────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── SESSÃO ──────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'smartutors-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── PASSPORT / GOOGLE AUTH ──────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.CALLBACK_URL || '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  const email = profile.emails[0].value;
  const nome  = profile.displayName;
  try {
    // Verifica se o usuário está cadastrado
    const res = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1', [email]
    );
    if (res.rows.length === 0) {
      return done(null, false, { message: 'nao_autorizado' });
    }
    const usuario = res.rows[0];
    // Atualiza nome se necessário
    await pool.query('UPDATE usuarios SET nome=$1 WHERE email=$2', [nome, email]);
    return done(null, { ...usuario, nome, accessToken });
  } catch(e) {
    return done(e);
  }
}));

passport.serializeUser((user, done) => done(null, user.email));
passport.deserializeUser(async (email, done) => {
  try {
    const res = await pool.query('SELECT * FROM usuarios WHERE email=$1', [email]);
    done(null, res.rows[0] || false);
  } catch(e) { done(e); }
});

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── AUTH ROUTES ─────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    accessType: 'offline',
    prompt: 'select_account'
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?erro=nao_autorizado' }),
  (req, res) => res.redirect('/app')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── MIDDLEWARE DE AUTH ──────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ erro: 'Não autenticado' });
}

// ── ROTAS PRINCIPAIS ────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── API: USUÁRIO ATUAL ──────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    nome:   req.user.nome,
    email:  req.user.email,
    perfil: req.user.perfil
  });
});

// ── API: AULAS ──────────────────────────────────────────────
app.get('/api/aulas', requireAuth, async (req, res) => {
  try {
    const { email, perfil } = req.user;
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let query, params;
    if (perfil === 'admin') {
      query = `
        SELECT a.*, 
          EXISTS(SELECT 1 FROM feedbacks f WHERE f.aula_id = a.id) as tem_feedback
        FROM aulas a
        WHERE a.data_aula >= $1
        ORDER BY a.data_aula ASC, a.hora_inicio ASC
      `;
      params = [hoje];
    } else {
      query = `
        SELECT a.*,
          EXISTS(SELECT 1 FROM feedbacks f WHERE f.aula_id = a.id) as tem_feedback
        FROM aulas a
        WHERE a.data_aula >= $1
          AND a.professor_email = $2
        ORDER BY a.data_aula ASC, a.hora_inicio ASC
      `;
      params = [hoje, email];
    }

    const result = await pool.query(query, params);

    const agora = new Date();
    const aulas = result.rows
      .filter(a => !a.tem_feedback)
      .map(a => {
        const [h, m] = (a.hora_inicio || '00:00').split(':');
        const dtInicio = new Date(a.data_aula);
        dtInicio.setHours(parseInt(h), parseInt(m), 0, 0);
        return {
          id:                 a.id,
          titulo:             a.titulo,
          professor:          a.professor_email || '',
          data:               formatDate(a.data_aula),
          horaInicio:         a.hora_inicio || '',
          horaFim:            a.hora_fim || '',
          temFeedback:        false,
          feedbackDisponivel: agora >= dtInicio,
          inicioTimestamp:    dtInicio.getTime()
        };
      });

    res.json(aulas);
  } catch(e) {
    console.error('Erro /api/aulas:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── API: FEEDBACKS ──────────────────────────────────────────
app.get('/api/feedbacks', requireAuth, async (req, res) => {
  try {
    const { email, perfil } = req.user;
    let query, params;
    if (perfil === 'admin') {
      query = 'SELECT * FROM feedbacks ORDER BY criado_em DESC';
      params = [];
    } else {
      query = 'SELECT * FROM feedbacks WHERE professor_email=$1 ORDER BY criado_em DESC';
      params = [email];
    }
    const result = await pool.query(query, params);
    res.json(result.rows.map(f => ({
      idAula:    f.aula_id,
      professor: f.professor_email,
      aluno:     f.aluno,
      dataAula:  f.data_aula,
      feedback:  f.feedback,
      imagemUrl: f.imagem_url || '',
      timestamp: formatDateTime(f.criado_em)
    })));
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/feedbacks', requireAuth, async (req, res) => {
  try {
    const { idAula, aluno, dataAula, feedback, imagemUrl } = req.body;
    await pool.query(
      `INSERT INTO feedbacks (aula_id, professor_email, aluno, data_aula, feedback, imagem_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [idAula, req.user.email, aluno, dataAula, feedback, imagemUrl || '']
    );
    res.json({ sucesso: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── API: UPLOAD DE IMAGEM ───────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  const url = '/uploads/' + req.file.filename;
  res.json({ sucesso: true, url });
});

// ── API: PROFESSORES ────────────────────────────────────────
app.get('/api/professores', requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT nome, email FROM usuarios WHERE perfil='professor' ORDER BY nome"
  );
  res.json(result.rows);
});

app.post('/api/aulas/:id/professor', requireAuth, async (req, res) => {
  if (req.user.perfil !== 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  await pool.query(
    'UPDATE aulas SET professor_email=$1 WHERE id=$2',
    [req.body.email, req.params.id]
  );
  res.json({ sucesso: true });
});

// ── SINCRONIZAÇÃO GOOGLE CALENDAR ───────────────────────────
async function sincronizarCalendario() {
  try {
    const auth = new google.auth.JWT({
      email:   process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:     (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
      scopes:  ['https://www.googleapis.com/auth/calendar.readonly'],
      subject: process.env.CALENDAR_OWNER_EMAIL
    });

    const calendar = google.calendar({ version: 'v3', auth });
    const profsRes = await pool.query("SELECT email FROM usuarios WHERE perfil='professor'");
    const emailsProfs = new Set(profsRes.rows.map(r => r.email.toLowerCase()));

    const agora = new Date();
    const janela = new Date();
    janela.setDate(janela.getDate() + 30);

    // Busca em todas as agendas do calendário do owner
    const calList = await calendar.calendarList.list();
    let novos = 0;

    for (const cal of calList.data.items || []) {
      let eventos;
      try {
        eventos = await calendar.events.list({
          calendarId:   cal.id,
          timeMin:      agora.toISOString(),
          timeMax:      janela.toISOString(),
          singleEvents: true,
          orderBy:      'startTime',
          maxResults:   100
        });
      } catch(e) { continue; }

      for (const ev of eventos.data.items || []) {
        if (!ev.start || !ev.start.dateTime) continue;

        // Verifica se já existe
        const existe = await pool.query('SELECT id FROM aulas WHERE id=$1', [ev.id]);
        if (existe.rows.length > 0) continue;

        // Identifica professor pelos convidados
        let profEmail = '';
        const convidados = (ev.attendees || []).map(a => a.email.toLowerCase());
        for (const c of convidados) {
          if (emailsProfs.has(c)) { profEmail = c; break; }
        }

        // Tenta pelo nome da agenda
        if (!profEmail) {
          const nomeCal = (cal.summary || '').toLowerCase();
          for (const pe of emailsProfs) {
            const nome = pe.split('@')[0].toLowerCase();
            if (nomeCal.includes(nome) || nomeCal.includes(pe)) {
              profEmail = pe; break;
            }
          }
        }

        const descricao  = ev.description || '';
        const telefone   = extrairTelefone(descricao);
        const dtInicio   = new Date(ev.start.dateTime);
        const dtFim      = new Date(ev.end.dateTime);

        await pool.query(
          `INSERT INTO aulas (id, titulo, professor_email, data_aula, hora_inicio, hora_fim, telefone_responsavel)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [
            ev.id,
            ev.summary || 'Aula',
            profEmail || null,
            dtInicio.toISOString().split('T')[0],
            pad(dtInicio.getHours()) + ':' + pad(dtInicio.getMinutes()),
            pad(dtFim.getHours())    + ':' + pad(dtFim.getMinutes()),
            telefone || null
          ]
        );
        novos++;
      }
    }
    console.log(`Sincronização: ${novos} novos eventos`);
  } catch(e) {
    console.error('Erro sincronização:', e.message);
  }
}

// ── UTILITÁRIOS ─────────────────────────────────────────────
function extrairTelefone(texto) {
  const limpo = texto.replace(/\D/g, '');
  const match = limpo.match(/\d{10,13}/);
  if (!match) return null;
  let num = match[0];
  if (!num.startsWith('55')) num = '55' + num;
  return num;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return pad(dt.getUTCDate()) + '/' + pad(dt.getUTCMonth()+1) + '/' + dt.getUTCFullYear();
}

function formatDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return pad(dt.getDate()) + '/' + pad(dt.getMonth()+1) + '/' + dt.getFullYear()
    + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
}

// ── START ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Smartutors App rodando na porta ${PORT}`);
    // Sincroniza a cada 15 minutos
    sincronizarCalendario();
    setInterval(sincronizarCalendario, 15 * 60 * 1000);
  });
});
