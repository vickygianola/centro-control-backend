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
//  GMAIL — helpers
// ══════════════════════════════════════════════════════════

// Patrones de pre-filtro (sin IA)
const SPAM_FROM = [
  "noreply", "no-reply", "notifications", "newsletter",
  "mailer", "bounce", "donotreply", "automated",
];
const SPAM_SUBJECT = [
  "unsubscribe", "newsletter", "promotion",
  "verify your email", "tracking number",
];

function isAutomatic(from, subject) {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  return (
    SPAM_FROM.some((p) => f.includes(p)) ||
    SPAM_SUBJECT.some((p) => s.includes(p))
  );
}

// Extrae texto plano del payload de un mensaje Gmail (format: 'full')
function extractBody(payload, maxChars = 500) {
  if (!payload) return "";

  // Busca recursivamente partes text/plain
  function findPlain(parts) {
    if (!parts) return null;
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return part.body.data;
      const nested = findPlain(part.parts);
      if (nested) return nested;
    }
    return null;
  }

  let b64 = null;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    b64 = payload.body.data;
  } else {
    b64 = findPlain(payload.parts);
  }

  if (!b64) return "";
  const text = Buffer.from(b64, "base64url").toString("utf-8");
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// Trae TODOS los mensajes de una query con paginación
async function fetchAllMessages(gmail, query) {
  const all = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    const msgs = res.data.messages || [];
    all.push(...msgs);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// ══════════════════════════════════════════════════════════
//  GMAIL — endpoint
// ══════════════════════════════════════════════════════════

app.get("/api/gmail", async (req, res) => {
  const { user_id, projects: projectsParam } = req.query;

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

    // Persistir renovación automática de tokens
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

    // ── CAPA 1: pre-filtro por código ──────────────────────
    const rawMessages = await fetchAllMessages(gmail, "is:unread newer_than:2d");
    console.log(`Gmail: ${rawMessages.length} emails sin leer en últimas 48hs`);

    // Traer detalles en paralelo (format: full para extraer body)
    const detailed = await Promise.all(
      rawMessages.map(async ({ id }) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
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
          body: extractBody(msg.data.payload, 500),
        };
      })
    );

    // Descartar automáticos / spam
    const preFiltered = detailed.filter(
      (e) => !isAutomatic(e.from, e.subject)
    );
    console.log(`Gmail: ${preFiltered.length} emails tras pre-filtro`);

    // Si no quedó nada, devolvemos vacío directamente
    if (preFiltered.length === 0) {
      return res.json({ emails: [], total_raw: rawMessages.length, pre_filtered: 0 });
    }

    // ── CAPA 2: Claude clasifica ────────────────────────────
    let projects = [];
    try {
      if (projectsParam) projects = JSON.parse(projectsParam);
    } catch (_) { /* si el JSON está mal, seguimos sin proyectos */ }

    const emailList = preFiltered.map((e, i) =>
      `[${i + 1}] ID: ${e.id}\nDe: ${e.from}\nAsunto: ${e.subject}\nFecha: ${e.date}\nSnippet: ${e.snippet}\nCuerpo: ${e.body}`
    ).join("\n\n---\n\n");

    const projectList = projects.length
      ? projects.map((p) => `• ${p.name} (${p.status}, ${p.pct}%)`).join("\n")
      : "Sin proyectos activos";

    const prompt = `Tenés estos emails de las últimas 48hs con su contenido parcial, y estos proyectos activos del usuario. Analizá cada email y devolvé SOLO los que son genuinamente relevantes: que requieren acción, se relacionan con algún proyecto activo, representan una oportunidad importante, o son urgentes. No pongas límite de cantidad.

PROYECTOS ACTIVOS:
${projectList}

EMAILS:
${emailList}

Para cada email relevante incluí: id, from, subject, snippet, date, relevancia (por qué importa), proyecto (nombre del proyecto relacionado o null), accion (qué hay que hacer o null), urgencia (alta/media/baja).

Respondé SOLO con JSON válido, sin texto adicional:
{ "emails": [ { "id": "...", "from": "...", "subject": "...", "snippet": "...", "date": "...", "relevancia": "...", "proyecto": null, "accion": null, "urgencia": "media" } ] }`;

    const aiResponse = await client.messages.create({
      model: "claude-sonnet-4-0",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = aiResponse.content[0]?.text || "{}";

    // Extraer JSON aunque Claude agregue texto alrededor
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { emails: [] };

    console.log(`Gmail: ${parsed.emails?.length ?? 0} emails relevantes según Claude`);

    res.json({
      emails: parsed.emails || [],
      total_raw: rawMessages.length,
      pre_filtered: preFiltered.length,
    });
  } catch (err) {
    console.error("Error en /api/gmail:", err.message);
    res.status(500).json({ error: "Error al procesar Gmail: " + err.message });
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
