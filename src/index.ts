import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_ID: string
  LINE_CHANNEL_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Webhook Server is active.'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  // 1. まずChannel IDとSecretからJWT（アサーション）を作る
  const jwt = await generateJWT(c.env.LINE_CHANNEL_ID, c.env.LINE_CHANNEL_SECRET)

  // 2. そのJWTを使って、LINEから本物の「チャネルアクセストークン」を発行してもらう
  const accessToken = await issueChannelAccessToken(jwt)

  if (!accessToken) {
    // eslint-disable-next-line no-console
    console.error('Failed to issue Line Access Token')
    return c.text('Internal Server Error', 500)
  }

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken
      const userMessage = event.message.text

      // 3. 取得した正式なトークンを使ってリプライを送る
      await replyToLine(replyToken, `あなたが送ったメッセージ: ${userMessage}`, accessToken)
    }
  }

  return c.text('OK', 200)
})

/**
 * LINEのOAuth 2.0仕様に準拠したJWTを生成する関数
 */
async function generateJWT(channelId: string, channelSecret: string): Promise<string> {
  const encoder = new TextEncoder()
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: channelId,
    sub: channelId,
    aud: 'https://api.line.me/oauth2/v3/token',
    exp: now + 60,
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
 * JWTをLINEに提示して、有効なChannel Access Tokenを取得する関数
 */
async function issueChannelAccessToken(jwt: string): Promise<string | null> {
  const url = 'https://api.line.me/oauth2/v3/token'

  const params = new URLSearchParams()
  params.append('grant_type', 'client_credentials')
  params.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
  params.append('client_assertion', jwt)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error('Token API Error:', await response.text())
    return null
  }

  const resData = (await response.json()) as { access_token: string }
  return resData.access_token
}

/**
 * LINEに返信する関数
 */
async function replyToLine(replyToken: string, text: string, accessToken: string) {
  const url = 'https://api.line.me/v2/bot/message/reply'

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }],
    }),
  })
}

export default app
