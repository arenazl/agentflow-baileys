/**
 * Adapter de auth state para Baileys que persiste en AgentFlow API (MySQL Aiven).
 *
 * Implementa la interfaz que espera Baileys (initAuthCreds + writeData + readData + removeData)
 * pero usa HTTP POST/GET/DELETE a /api/baileys-auth/{key} con header X-API-Key.
 *
 * Asi la sesion sobrevive a reinicios del dyno Heroku (filesystem efimero).
 */
import { fetch } from 'undici'
import {
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys'

const AGENTFLOW_API_URL = process.env.AGENTFLOW_API_URL || 'http://localhost:8200/api'
const API_KEY = process.env.WHATSAPP_WEBHOOK_API_KEY || 'dev-secret'

const HEADERS = { 'X-API-Key': API_KEY }

async function apiGet(key) {
  const r = await fetch(`${AGENTFLOW_API_URL}/baileys-auth/${encodeURIComponent(key)}`, { headers: HEADERS })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GET ${key} status ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  return buf.toString('utf-8')
}

async function apiSet(key, valueStr) {
  const value_b64 = Buffer.from(valueStr, 'utf-8').toString('base64')
  const r = await fetch(`${AGENTFLOW_API_URL}/baileys-auth/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value_b64 }),
  })
  if (!r.ok) throw new Error(`POST ${key} status ${r.status}`)
}

async function apiDelete(key) {
  await fetch(`${AGENTFLOW_API_URL}/baileys-auth/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: HEADERS,
  }).catch(() => {})
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

export async function useRemoteAuthState() {
  const writeData = async (data, file) => {
    try {
      await apiSet(fixFileName(file), JSON.stringify(data, BufferJSON.replacer))
    } catch (err) {
      console.error('[remoteAuth] writeData error', file, err.message)
    }
  }

  const readData = async (file) => {
    try {
      const data = await apiGet(fixFileName(file))
      if (!data) return null
      return JSON.parse(data, BufferJSON.reviver)
    } catch (err) {
      console.error('[remoteAuth] readData error', file, err.message)
      return null
    }
  }

  const removeData = async (file) => {
    try {
      await apiDelete(fixFileName(file))
    } catch (err) {
      console.error('[remoteAuth] removeData error', file, err.message)
    }
  }

  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            }),
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const file = `${category}-${id}`
              tasks.push(value ? writeData(value, file) : removeData(file))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  }
}
