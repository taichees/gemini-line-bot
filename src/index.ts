import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  // 後ほど Gemini API Key もここに追加します
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Bot is running on Cloudflare Workers!'))

// LINEからのWebhookを受け取るエンドポイント
app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  // イベントが空、またはプレビュー（検証）イベントの場合は200を返して終了
  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  for (const event of events) {
    // テキストメッセージだけを処理
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken
      const userMessage = event.message.text

      // LINEに返信する（リプライメッセージ）
      await replyToLine(
        replyToken,
        `あなたが送ったメッセージ: ${userMessage}`, // ここを後でGeminiの回答に変えます
        c.env.LINE_CHANNEL_ACCESS_TOKEN,
      )
    }
  }

  return c.text('OK', 200)
})

// LINEのMessaging APIを叩く共通関数
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
