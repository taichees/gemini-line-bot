import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Bot is running!'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  for (const event of events) {
    // テキストメッセージが届いた場合のみ処理
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken
      const userMessage = event.message.text

      // LINEにそのままオウム返し
      await replyToLine(
        replyToken,
        `あなたが送ったメッセージ: ${userMessage}`,
        c.env.LINE_CHANNEL_ACCESS_TOKEN,
      )
    }
  }

  return c.text('OK', 200)
})

/**
 * LINEにメッセージを返信する関数（長期トークン認証版）
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
