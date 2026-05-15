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
  fetchLatestBaileysVersion,
  Browsers,
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
let isReadySince = null      // timestamp del ultimo isReady=true
let lastNotReadySince = null // timestamp desde que esta down
let restartCount = 0          // cuantas veces reinicio el watchdog
let reconnectInProgress = false

async function startBaileys() {
  const { state, saveCreds } = await useRemoteAuthState()
  const { version } = await fetchLatestBaileysVersion()
  logger.info({ version }, 'Usando version de WhatsApp Web')

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('AgentFlow'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
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
      isReadySince = Date.now()
      lastNotReadySince = null
      lastQR = null
      lastError = null
      lastUser = sock.user?.id || null
      logger.info({ user: lastUser, restartCount }, 'Conectado a WhatsApp')
    }

    if (connection === 'close') {
      isReady = false
      lastNotReadySince = lastNotReadySince || Date.now()
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      lastError = lastDisconnect?.error?.message || `code ${code}`
      logger.warn({ code, shouldReconnect, err: lastError }, 'Conexion cerrada')
      if (shouldReconnect && !reconnectInProgress) {
        reconnectInProgress = true
        setTimeout(() => {
          reconnectInProgress = false
          startBaileys().catch((err) => logger.error({ err: err.message }, 'Reconnect fallo'))
        }, 3000)
      } else if (!shouldReconnect) {
        logger.error('Sesion cerrada por logout. Borrar baileys_auth en la DB y reescanear QR.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({ type, count: messages.length }, '[upsert] evento recibido')
    for (const msg of messages) {
      logger.info({
        fromMe: msg.key.fromMe,
        remoteJid: msg.key.remoteJid,
        senderPn: msg.key.senderPn,
        id: msg.key.id,
        pushName: msg.pushName,
        hasMessage: !!msg.message,
      }, '[upsert] msg detail')

      if (msg.key.fromMe) { logger.info('  skip: fromMe'); continue }
      const jid = msg.key.remoteJid
      // Aceptamos chats individuales (s.whatsapp.net) Y nuevos LID (@lid)
      // Filtramos solo grupos (@g.us) y broadcasts (@broadcast)
      if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
        logger.info({ jid }, '  skip: grupo/broadcast')
        continue
      }

      // CRITICO: usar SIEMPRE el remoteJid original como "telefono".
      // Esto es la identidad criptografica con la que tenemos sesion Signal-Protocol.
      // Si respondemos a otro JID (ej: el phone real cuando vino por @lid),
      // el cliente recibe el mensaje pero no puede desencriptarlo
      // (aparece "Esperando el mensaje" en el chat del cliente).
      const telefono = jid

      // Numero de phone publico (si esta disponible) - solo para mostrar en CRM/matching
      const phonePublico = msg.key.senderPn
        ? '+' + msg.key.senderPn.split('@')[0]
        : (jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : null)

      const nombre = msg.pushName || null
      const contenido =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '[mensaje no soportado]'

      logger.info({ telefono, phonePublico, nombre, contenido: contenido.slice(0, 80) }, 'Mensaje entrante PROCESANDO')

      try {
        const res = await fetch(`${AGENTFLOW_API_URL}/whatsapp/webhook/incoming`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
          body: JSON.stringify({
            telefono,
            phone_publico: phonePublico,
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

  // Resolver JID:
  // - Si telefono ya es un JID (contiene @), usarlo tal cual
  // - Si empieza con +, es numero E.164 → construir s.whatsapp.net JID
  let jid
  if (telefono.includes('@')) {
    jid = telefono
  } else {
    const phone = telefono.replace(/[^0-9]/g, '')
    jid = `${phone}@s.whatsapp.net`
  }

  try {
    const result = await sock.sendMessage(jid, { text: contenido })
    logger.info({ jid }, 'Mensaje enviado')
    res.json({ ok: true, meta_message_id: result?.key?.id || null })
  } catch (err) {
    logger.error({ err: err.message, jid }, 'Error enviando')
    res.status(500).json({ ok: false, error: err.message })
  }
})

// === WATCHDOG: si el bot esta down > 3 min, fuerza un restart limpio ===
const WATCHDOG_INTERVAL_MS = 60 * 1000          // chequear cada 60s
const MAX_DOWN_MS = 3 * 60 * 1000               // tolera hasta 3 min down
const MAX_RESTARTS_PER_HOUR = 10                // safety

let restartTimestamps = []

setInterval(async () => {
  // Limpiar restarts viejos (> 1h)
  const oneHourAgo = Date.now() - 3600 * 1000
  restartTimestamps = restartTimestamps.filter((t) => t > oneHourAgo)

  if (isReady) return  // todo OK

  const downMs = Date.now() - (lastNotReadySince || Date.now())
  logger.warn({ downMs, baileys_ready: isReady, restartsLastHour: restartTimestamps.length }, '[watchdog] bot esta down')

  if (downMs < MAX_DOWN_MS) return  // todavia dentro del tiempo de gracia

  if (restartTimestamps.length >= MAX_RESTARTS_PER_HOUR) {
    logger.error({ count: restartTimestamps.length }, '[watchdog] demasiados restarts en 1h, parando')
    return
  }

  if (reconnectInProgress) {
    logger.info('[watchdog] ya hay un reconnect en progreso, espero')
    return
  }

  logger.warn('[watchdog] forzando restart de Baileys')
  restartCount++
  restartTimestamps.push(Date.now())
  reconnectInProgress = true
  try {
    if (sock) {
      try { await sock.end() } catch {}
    }
    sock = null
    isReady = false
    await startBaileys()
  } catch (err) {
    logger.error({ err: err.message }, '[watchdog] restart fallo')
  } finally {
    reconnectInProgress = false
  }
}, WATCHDOG_INTERVAL_MS)

// === ERROR HANDLERS: prevenir muerte silenciosa del proceso ===
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '[process] uncaughtException — no muere, sigue corriendo')
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  logger.error({ reason: msg }, '[process] unhandledRejection — no muere, sigue corriendo')
})

// === START ===
app.listen(PORT, () => {
  logger.info(`AgentFlow Baileys escuchando en :${PORT}`)
  logger.info(`AGENTFLOW_API_URL: ${AGENTFLOW_API_URL}`)
  lastNotReadySince = Date.now()
  startBaileys().catch((err) => {
    logger.error({ err: err.message }, 'Error iniciando Baileys (continua corriendo, watchdog reintentara)')
  })
})
