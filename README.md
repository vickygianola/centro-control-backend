# Centro de Control — Backend

Backend Express para el sistema de gestión de proyectos con IA.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Estado del servidor |
| `POST` | `/api/chat` | Envía mensajes a Claude |

### POST /api/chat

**Body:**
```json
{
  "messages": [
    { "role": "user", "content": "Hola" }
  ],
  "system": "Eres un asistente de gestión de proyectos."
}
```

`system` es opcional.

**Respuesta:** objeto `Message` de la API de Anthropic.

## Desarrollo local

```bash
# 1. Instalar dependencias
npm install

# 2. Crear archivo .env
cp .env.example .env
# Editar .env y agregar tu ANTHROPIC_API_KEY

# 3. Iniciar servidor
npm run dev
```

## Deploy en Railway

### Opción A — desde GitHub

1. Subí este proyecto a un repositorio de GitHub.
2. En [railway.app](https://railway.app), creá un nuevo proyecto y elegí **Deploy from GitHub repo**.
3. Seleccioná el repositorio.
4. Railway detecta Node.js automáticamente y ejecuta `npm start`.

### Opción B — desde la CLI de Railway

```bash
# Instalar CLI
npm install -g @railway/cli

# Login
railway login

# Crear proyecto e iniciar deploy
railway init
railway up
```

### Variables de entorno en Railway

En el panel de Railway, ir a tu servicio → **Variables** y agregar:

| Variable | Valor |
|----------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

Railway asigna `PORT` automáticamente — no hace falta configurarlo.

### Obtener la URL pública

Una vez desplegado, Railway te da una URL del estilo `https://centro-control-backend-production.up.railway.app`. Usá esa URL como base para llamar a los endpoints desde tu frontend.
