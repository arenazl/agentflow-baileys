/**
 * AgentFlow WhatsApp Service (Baileys + Express)
 *
 * - Conecta a WhatsApp via @whiskeysockets/baileys
 * - Recibe mensajes y los POSTea al webhook /api/whatsapp/webhook/incoming
 * - Expone POST /send para que el backend envie mensajes
 * - Expone GET /qr para mostrar el QR de pareo desde el navegador
 * - Persistencia de sesion en AgentFlow API (MySQL Aiven)
 *
 * Variables de entorno requeridas:
 *  PORT
 *  AGENTFLOW_API_URL              ej: https://agentflow-d82efcddea71.herokuapp.com/api
 *  WHATSAPP_WEBHOOK_API_KEY       secret compartido con el backend
 */
import {
  default as makeWASocket,
  DisconnectReason,
} from '@whiskeysockets/baileys'
import express from 'express'
import qrcodeLib from 'qrcode'
import pino from 'pino'
import { fetch } from 'undici'
import { useRemoteAuthState } from './remoteAuthState.js'

const PORT = parseInt(process.env.PORT || '3100', 10)
const AGENTFLOW_API_URL = process.env.AGENTFLOW_API_URL || 'http://localhost:8200/api'
const API_KEY = process.env.WHATSAPP_WEBHOOK_API_KEY || 'dev-secret'

const logger = pino({ level: 'info' })

let sock = null
let isReady = false
let lastQR = null  // string del QR para mostrar via /qr
let lastUser = null
let lastError = null

async function startBaileys() {
  const { state, saveCreds } = await useRemoteAuthState()

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    markOnlineOnConnect: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      lastQR = qr
      logger.info('Nuevo QR pendiente. Abrir GET /qr para escanear.')
    }

    if (connection === 'open') {
      isReady = true
      lastQR = null
      lastError = null
      lastUser = sock.user?.id || null
      logger.info({ user: lastUser }, 'Conectado a WhatsApp')
    }

    if (connection === 'close') {
      isReady = false
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      lastError = lastDisconnect?.error?.message || `code ${code}`
      logger.warn({ code, shouldReconnect, err: lastError }, 'Conexion cerrada')
      if (shouldReconnect) {
        setTimeout(startBaileys, 3000)
      } else {
        logger.error('Sesion cerrada por logout. Borrar baileys_auth en la DB y reescanear QR.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.key.remoteJid?.endsWith('@s.whatsapp.net')) continue

      const phoneRaw = msg.key.remoteJid.split('@')[0]
      const telefono = '+' + phoneRaw
      const nombre = msg.pushName || null
      const contenido =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '[mensaje no soportado]'

      logger.info({ telefono, nombre, contenido: contenido.slice(0, 80) }, 'Mensaje entrante')

      try {
        const res = await fetch(`${AGENTFLOW_API_URL}/whatsapp/webhook/incoming`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
          body: JSON.stringify({
            telefono,
            nombre_contacto: nombre,
            contenido,
            meta_message_id: msg.key.id,
            timestamp: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
          }),
        })
        if (!res.ok) {
          logger.error({ status: res.status }, 'Webhook AgentFlow rechazo')
        }
      } catch (err) {
        logger.error({ err: err.message }, 'Error llamando webhook AgentFlow')
      }
    }
  })
}

// HTTP server
const app = express()
app.use(express.json())

// Health publico
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    baileys_ready: isReady,
    user: lastUser,
    has_pending_qr: !!lastQR,
    error: lastError,
  })
})

// QR como PNG embebido para escanear desde el navegador
app.get('/qr', async (req, res) => {
  if (!lastQR) {
    return res.status(404).send('<html><body style="font-family:sans-serif;padding:2rem;text-align:center"><h2>No hay QR pendiente</h2><p>' + (isReady ? 'Baileys ya esta conectado: ' + (lastUser || '') : 'Esperando conexion...') + '</p></body></html>')
  }
  try {
    const dataUrl = await qrcodeLib.toDataURL(lastQR, { width: 360, margin: 2 })
    res.send(`
      <html>
      <head><title>WhatsApp QR - AgentFlow</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}img{background:white;padding:1rem;border-radius:1rem}h2{margin-bottom:0.5rem}p{color:#94a3b8;max-width:400px;text-align:center}</style>
      </head>
      <body>
        <h2>Escaneá con WhatsApp Business</h2>
        <p>Abrí WhatsApp Business en el celu de Beyker · Menú · Dispositivos vinculados · Vincular un dispositivo</p>
        <img src="${dataUrl}" />
        <p style="margin-top:1rem;font-size:0.8rem">Esta pagina se actualiza sola cuando el QR cambia (refresca cada 20s).</p>
        <script>setTimeout(()=>location.reload(), 20000)</script>
      </body>
      </html>
    `)
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message)
  }
})

// Middleware de auth para endpoints protegidos
const requireKey = (req, res, next) => {
  const key = req.header('X-API-Key')
  if (API_KEY && key !== API_KEY) {
    return res.status(401).json({ error: 'API key invalida' })
  }
  next()
}

// Envio de mensajes (lo llama el backend AgentFlow)
app.post('/send', requireKey, async (req, res) => {
  if (!isReady || !sock) {
    return res.status(503).json({ ok: false, error: 'Baileys no esta listo' })
  }
  const { telefono, contenido } = req.body || {}
  if (!telefono || !contenido) {
    return res.status(400).json({ ok: false, error: 'telefono y contenido requeridos' })
  }
  const phone = telefono.replace(/[^0-9]/g, '')
  const jid = `${phone}@s.whatsapp.net`

  try {
    const result = await sock.sendMessage(jid, { text: contenido })
    res.json({ ok: true, meta_message_id: result?.key?.id || null })
  } catch (err) {
    logger.error({ err: err.message, jid }, 'Error enviando')
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.listen(PORT, () => {
  logger.info(`AgentFlow Baileys escuchando en :${PORT}`)
  logger.info(`AGENTFLOW_API_URL: ${AGENTFLOW_API_URL}`)
  startBaileys().catch((err) => {
    logger.error({ err: err.message }, 'Error iniciando Baileys')
    process.exit(1)
  })
})
