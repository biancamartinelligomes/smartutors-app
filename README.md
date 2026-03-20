# Smartutors App Interno

App interno para gestão de aulas e feedbacks de professores.

## Setup no Railway

### 1. Faça o upload deste projeto no GitHub
- Crie um repositório no GitHub chamado `smartutors-app`
- Faça upload de todos os arquivos desta pasta

### 2. Crie o projeto no Railway
- Acesse railway.app
- Clique em "New Project" → "Deploy from GitHub repo"
- Selecione o repositório `smartutors-app`
- O Railway vai detectar o Node.js automaticamente

### 3. Adicione o banco de dados
- No painel do projeto, clique em "New" → "Database" → "PostgreSQL"
- O Railway vai criar a variável DATABASE_URL automaticamente

### 4. Configure as variáveis de ambiente
No Railway, vá em "Variables" e adicione:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CALLBACK_URL=https://seu-app.railway.app/auth/google/callback
SESSION_SECRET=qualquer-texto-longo-e-aleatorio
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_SERVICE_ACCOUNT_KEY=...
CALENDAR_OWNER_EMAIL=bianca@smartutors.com.br
NODE_ENV=production
```

### 5. Configure o Google OAuth
- Acesse console.cloud.google.com
- Crie um projeto → Ative a API Google Calendar
- Crie credenciais OAuth 2.0
- Adicione o URL de callback: https://seu-app.railway.app/auth/google/callback

### 6. Cadastre os usuários
Conecte ao banco PostgreSQL do Railway e insira os usuários:

```sql
INSERT INTO usuarios (nome, email, perfil) VALUES
  ('Bianca', 'bianca@smartutors.com.br', 'admin'),
  ('Nome Professor', 'professor@email.com', 'professor');
```

## Estrutura
```
smartutors-app/
├── server.js          # Servidor Node.js + Express
├── package.json
├── .env.example       # Modelo de variáveis de ambiente
└── public/
    ├── login.html     # Tela de login
    └── app.html       # App principal
```
