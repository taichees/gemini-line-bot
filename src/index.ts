import { Hono } from 'hono'
import { GoogleGenAI } from '@google/genai'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY: string // 👈 環境変数の型を追加
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Gemini Bot is active!'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  // GoogleGenAIの初期化（Cloudflareの環境変数からAPIキーを渡す）
  const ai = new GoogleGenAI({ apiKey: c.env.GEMINI_API_KEY })

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken
      const userMessage = event.message.text

      try {
        // Gemini APIを呼び出して、高速・格安な gemini-2.5-flash で返答を生成
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: userMessage,
          config: {
            // 💡 ここでお好みのキャラクター付け（システムプロンプト）ができます！
            systemInstruction:
              'あなたは親切で少しお茶目なAIアシスタントです。LINEのチャットらしく、短く親しみやすい日本語でテンポよく返答してください。絵文字も適度に使ってください。',
          },
        })

        const aiResponseText = response.text || 'ごめんなさい、うまくお返事を作れませんでした。'

        // LINEにGeminiの回答を返信
        await replyToLine(replyToken, aiResponseText, c.env.LINE_CHANNEL_ACCESS_TOKEN)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Gemini API Error:', error)
        // エラーが起きた場合も既読無視にせず、エラー通知を返す
        await replyToLine(
          replyToken,
          'ごめんなさい、頭がのぼせてしまいました。少し時間を置いて話しかけてね！',
          c.env.LINE_CHANNEL_ACCESS_TOKEN,
        )
      }
    }
  }

  return c.text('OK', 200)
})

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
