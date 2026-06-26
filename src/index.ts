import { Hono } from 'hono'
import { GoogleGenAI } from '@google/genai'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Gemini Worker is active!'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  // 💡 ここがポイント：LINEには「受け取ったよ」と即座に200 OKを返却し、
  // 重たいAI処理は裏側（バックグラウンド）で並行実行させます。
  c.executionCtx.waitUntil(
    (async () => {
      const ai = new GoogleGenAI({ apiKey: c.env.GEMINI_API_KEY })

      for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
          const replyToken = event.replyToken
          const userMessage = event.message.text

          try {
            // 裏側でGeminiをじっくり呼び出す
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: userMessage,
              config: {
                systemInstruction:
                  'あなたは親切で少しお茶目なAIアシスタントです。LINEのチャットらしく、短く親しみやすい日本語でテンポよく返答してください。絵文字も適度に使ってください。',
              },
            })

            const aiResponseText = response.text || 'お返事をうまく作れませんでした。'

            // 返信する
            await replyToLine(replyToken, aiResponseText, c.env.LINE_CHANNEL_ACCESS_TOKEN)
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Gemini Background Error:', error)
            await replyToLine(
              replyToken,
              'エラーが起きちゃいました。もう一度話しかけてね！',
              c.env.LINE_CHANNEL_ACCESS_TOKEN,
            )
          }
        }
      }
    })(),
  )

  // LINEサーバーを待たせずに即レスポンス
  return c.text('OK', 200)
})

/**
 * LINEに返信する共通関数
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
