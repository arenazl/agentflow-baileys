# AgentFlow Baileys

Servicio Node.js que conecta WhatsApp (via [Baileys](https://github.com/WhiskeySockets/Baileys)) con [AgentFlow](https://github.com/arenazl/agentflow).

## Qué hace

- Mantiene una sesión activa de WhatsApp Web del número oficial de la oficina.
- Cuando entra un mensaje al número, lo POSTea al webhook de AgentFlow.
- Cuando AgentFlow necesita enviar un mensaje (bot o vendedor), lo envía via Baileys.
- La sesión se persiste en la base de datos Aiven de AgentFlow para sobrevivir reinicios.

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio + Baileys |
| `GET` | `/qr` | Página HTML con el QR para escanear (solo cuando hay pareo pendiente) |
| `POST` | `/send` | Envía mensaje (requiere `X-API-Key`) |

## Variables de entorno

| Var | Descripción |
|---|---|
| `PORT` | Puerto HTTP (Heroku lo setea solo) |
| `AGENTFLOW_API_URL` | URL del backend AgentFlow (ej: `https://agentflow-d82efcddea71.herokuapp.com/api`) |
| `WHATSAPP_WEBHOOK_API_KEY` | Secret compartido con AgentFlow |

## Setup local

```bash
npm install
cp .env.example .env  # editar valores
npm start
# Abrir http://localhost:3100/qr para escanear con WhatsApp Business app
```

## Deploy en Heroku

```bash
heroku create agentflow-baileys
heroku config:set AGENTFLOW_API_URL=https://agentflow-d82efcddea71.herokuapp.com/api -a agentflow-baileys
heroku config:set WHATSAPP_WEBHOOK_API_KEY=<el-mismo-secret-que-agentflow> -a agentflow-baileys
git push heroku main
heroku logs -t -a agentflow-baileys
```

Después abrir `https://agentflow-baileys.herokuapp.com/qr` y escanear con WhatsApp Business app del celular dedicado.

## Persistencia de sesión

A diferencia de la receta default de Baileys (que guarda archivos en disco), este servicio persiste todo en la base de datos de AgentFlow via los endpoints `/api/baileys-auth/*`. Esto permite que el dyno Heroku se reinicie sin perder la sesión y sin tener que reescanear QR.

## Notas operativas

- El celular físico de Beyker (con WhatsApp Business app y el chip) tiene que estar disponible **para escanear el QR la primera vez**. Después puede quedar guardado, pero **no apagado** (Meta requiere que el dispositivo "padre" siga existiendo).
- No abrir WhatsApp Web normal con el mismo número en otro lado mientras este servicio está corriendo.
- Si la sesión se rompe (Meta cierra remotamente, etc.), borrar las filas de la tabla `baileys_auth` en Aiven y volver a escanear desde `/qr`.
