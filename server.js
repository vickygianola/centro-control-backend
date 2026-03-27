import Anthropic from "@anthropic-ai/sdk";
import cors from "cors";
import express from "express";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

const app = express();
const port = process.env.PORT || 3000;

const FRONTEND_URL = "https://dapper-rabanadas-191c13.netlify.app";
const REDIRECT_URI = "https://centro-control-backend-production.up.railway.app/auth/google/callback";

// ── Anthropic ──
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Supabase (service key — server only) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Google OAuth client ──
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ── Health ──
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ══════════════════════════════════════════════════════════
//  GOOGLE OAUTH
// ══════════════════════════════════════════════════════════

// 1. Redirige al usuario a la pantalla de consentimiento de Google
app.get("/auth/google", (req, res) => {
  const { user_id } = req.query;
  const oauth2Client = makeOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",          // fuerza que Google devuelva refresh_token siempre
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    state: user_id || "",       // pasamos el user_id para guardarlo en el callback
  });

  res.redirect(url);
});

// 2. Google redirige acá con el código de autorización
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: user_id } = req.query;

  if (!code) {
    return res.status(400).send("Código de autorización no recibido.");
  }

  try {
    const oauth2Client = makeOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Guardamos los tokens en Supabase (upsert por user_id)
    const { error } = await supabase
      .from("google_tokens")
      .upsert({
        user_id: user_id || null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        expiry_date: tokens.expiry_date || null,
      }, { onConflict: "user_id" });

    if (error) {
      console.error("Error guardando tokens en Supabase:", error.message);
      return res.redirect(`${FRONTEND_URL}?google=error`);
    }

    res.redirect(`${FRONTEND_URL}?google=connected`);
  } catch (err) {
    console.error("Error en callback de Google:", err.message);
    res.redirect(`${FRONTEND_URL}?google=error`);
  }
});

// ══════════════════════════════════════════════════════════
//  GMAIL
// ══════════════════════════════════════════════════════════

// 3. Devuelve los últimos 10 emails no leídos del usuario
app.get("/api/gmail", async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: "user_id requerido" });
  }

  // Recuperamos tokens de Supabase
  const { data: row, error: dbErr } = await supabase
    .from("google_tokens")
    .select("access_token, refresh_token, expiry_date")
    .eq("user_id", user_id)
    .single();

  if (dbErr || !row) {
    return res.status(401).json({ error: "Google no conectado para este usuario" });
  }

  try {
    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials({
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: row.expiry_date,
    });

    // Si el access_token expiró, googleapis lo renueva automáticamente con el refresh_token.
    // Guardamos el token renovado en Supabase.
    oauth2Client.on("tokens", async (tokens) => {
      if (tokens.access_token) {
        await supabase
          .from("google_tokens")
          .update({
            access_token: tokens.access_token,
            expiry_date: tokens.expiry_date || null,
          })
          .eq("user_id", user_id);
      }
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Lista los 10 mensajes no leídos más recientes
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults: 10,
    });

    const messages = listRes.data.messages || [];

    // Obtenemos el detalle de cada mensaje en paralelo
    const emails = await Promise.all(
      messages.map(async ({ id }) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = msg.data.payload?.headers || [];
        const get = (name) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

        return {
          id,
          from: get("From"),
          subject: get("Subject"),
          snippet: msg.data.snippet || "",
          date: get("Date"),
          labels: msg.data.labelIds || [],
        };
      })
    );

    res.json(emails);
  } catch (err) {
    console.error("Error leyendo Gmail:", err.message);
    res.status(500).json({ error: "Error al leer Gmail: " + err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  CHAT (Anthropic)
// ══════════════════════════════════════════════════════════

app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  try {
    const params = {
      model: "claude-sonnet-4-0",
      max_tokens: 8096,
      messages,
    };

    if (system) {
      params.system = system;
    }

    const response = await client.messages.create(params);
    res.json(response);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`Centro de Control backend corriendo en puerto ${port}`);
});
