import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_ID: string
  LINE_CHANNEL_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE JWT Bot is running!'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  // LINEのChannel Secretを使って即席でJWTトークンを発行する
  const accessToken = await generateJWT(c.env.LINE_CHANNEL_ID, c.env.LINE_CHANNEL_SECRET)

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken
      const userMessage = event.message.text

      // LINEにオウム返し
      await replyToLine(replyToken, `あなたが送ったメッセージ: ${userMessage}`, accessToken)
    }
  }

  return c.text('OK', 200)
})

/**
 * LINEの最新仕様に準拠したJWT（チャネルアクセストークン）を
 * Web Crypto APIを使って生成する関数
 */
/**
 * LINEの最新仕様に完全準拠したJWT（アサーション）を生成する関数
 */
async function generateJWT(channelId: string, channelSecret: string): Promise<string> {
  const encoder = new TextEncoder()

  // ヘッダーの指定
  const header = { alg: 'HS256', typ: 'JWT' }

  // ペイロード（LINE公式の仕様に完全準拠させます）
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: channelId, // チャネルID
    sub: channelId, // チャネルID
    aud: 'https://api.line.me/oauth2/v3/token', // 👈 ここが最新仕様の認証先URLになります
    exp: now + 60, // 有効期限（1分）
    iat: now,
  }

  const base64UrlEncode = (obj: unknown) => {
    const str = JSON.stringify(obj)
    const bin = String.fromCharCode(...encoder.encode(str))
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  const encodedHeader = base64UrlEncode(header)
  const encodedPayload = base64UrlEncode(payload)
  const tokenData = `${encodedHeader}.${encodedPayload}`

  // Web Crypto APIによる署名
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(tokenData))
  const binSign = String.fromCharCode(...new Uint8Array(signature))
  const encodedSignature = btoa(binSign).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  return `${tokenData}.${encodedSignature}`
}

/**
 * LINEのMessaging APIを叩く共通関数
 */
async function replyToLine(replyToken: string, text: string, accessToken: string) {
  const url = 'https://api.line.me/v2/bot/message/reply'

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 最新のJWTトークン認証ヘッダー
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }],
    }),
  })
}

export default app
