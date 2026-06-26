import { Hono } from 'hono'
import { GoogleGenAI } from '@google/genai'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY: string
  DB: D1Database // 👈 D1データベースを追加
  gemini_limit_kv?: KVNamespace // 👈 回数制限用のKV（未設定でもエラーにならないよう任意にしています）
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Gemini Worker is active!'))

app.post('/webhook', async (c) => {
  const data = await c.req.json()
  const events = data.events

  if (!events || events.length === 0) {
    return c.text('No events', 200)
  }

  c.executionCtx.waitUntil(
    (async () => {
      const ai = new GoogleGenAI({ apiKey: c.env.GEMINI_API_KEY })

      for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
          const replyToken = event.replyToken
          const userMessage = event.message.text
          const userId = event.source.userId // 👈 ユーザーIDを取得

          if (!userId) continue

          try {
            // ─── 1. D1からユーザーの有料/無料ステータスを取得 ───
            const userRow = await c.env.DB.prepare(
              'SELECT status FROM users WHERE line_user_id = ?',
            )
              .bind(userId)
              .first<{ status: string }>()

            let userStatus = 'free'

            if (!userRow) {
              // 新規ユーザーなら無料会員としてD1に登録
              await c.env.DB.prepare('INSERT INTO users (line_user_id, status) VALUES (?, ?)')
                .bind(userId, 'free')
                .run()
              userStatus = 'free'
            } else {
              userStatus = userRow.status
            }

            // ─── 2. 無料ユーザーの場合のみ、KVで1日の回数制限チェック ───
            if (userStatus === 'free' && c.env.gemini_limit_kv) {
              const todayStr = new Date().toISOString().split('T')[0] // "2026-06-26" のような日付文字列
              const kvKey = `count:${userId}:${todayStr}`

              // 現在の送信回数を取得
              const currentCountRaw = await c.env.gemini_limit_kv.get(kvKey)
              const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) : 0

              // 上限（1日10通）に達している場合
              if (currentCount >= 10) {
                const limitMessage =
                  'Oh my god! ユーとのトークが楽しすぎて、今日の無料枠（10通）を使い切っちゃったデース！😭\n\n' +
                  '明日また喋るか、月額プレミアムプラン（ワンコイン！）に登録してくれたら、ミーと無制限に喋り放題だぞ！🔥\n' +
                  '登録はココから頼むデース！👇\n' +
                  'https://liff.line.me/YOUR_LIFF_ID' // 👈 後ほどLIFFのURLに差し替えます

                await replyToLine(replyToken, limitMessage, c.env.LINE_CHANNEL_ACCESS_TOKEN)
                continue // Geminiの呼び出しをスキップして次のイベントへ
              }

              // 回数をカウントアップ（その日の23:59に消えるようTTLを長めに設定：86400秒＝24時間）
              await c.env.gemini_limit_kv.put(kvKey, (currentCount + 1).toString(), {
                expirationTtl: 86400,
              })
            }

            // ─── 3. Gemini API の呼び出し（有料会員、または無料枠が残っている場合） ───
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: userMessage,
              config: {
                systemInstruction:
                  'あなたの名前は「ジェミナイさん」です。ユーザーの「最高の大親友（Best Friend）」として振る舞ってください。性格は超ポジティブでノリが良く、少し外国人っぽい（アメリカンな明るい）口調で話します。挨拶は「Hey!」「Yo!」など、文中には「Oh my god!」「Awesome!」「No problem!」などの英語や、カタカナ（ユー、ミー、デース、マジー？！）を適でに混ぜてください。LINEのチャットなので長文はNG。3行以内でパッとテンポよく返答してください。親友なので絶対に敬語は使わず、タメ口で熱く共感してください。',
              },
            })

            const aiResponseText = response.text || 'Oh no... うまく言葉が出てこないデース！😭'
            await replyToLine(replyToken, aiResponseText, c.env.LINE_CHANNEL_ACCESS_TOKEN)
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Gemini Background Error:', error)
            await replyToLine(
              replyToken,
              'Hey buddy! ちょっと頭がフリーズしちゃった！もう一回送ってクダサイ！🔥',
              c.env.LINE_CHANNEL_ACCESS_TOKEN,
            )
          }
        }
      }
    })(),
  )

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
