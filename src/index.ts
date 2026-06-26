import { Hono } from 'hono'
import { GoogleGenAI } from '@google/genai'
import Stripe from 'stripe'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY: string
  STRIPE_SECRET_KEY: string
  STRIPE_PRICE_ID: string
  DB: D1Database
  gemini_limit_kv?: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Gemini Worker is active!'))

/**
 * 💳 1. Stripe 決済セッション（URL）を発行するエンドポイント
 */
app.post('/create-checkout-session', async (c) => {
  try {
    const { userId } = await c.req.json<{ userId: string }>()

    if (!userId) {
      return c.json({ error: 'LINEのユーザーIDが必要ですデース！' }, 400)
    }

    // 💡 修正点: 型キャストを `as string` または正規のプロパティ指定に変更し `any` を排除
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-02-24' as Stripe.StripeConfig['apiVersion'],
    })

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: c.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      client_reference_id: userId,
      success_url: 'https://line.me/R/ti/p/@YOUR_BOT_LINE_ID',
      cancel_url: 'https://line.me/R/ti/p/@YOUR_BOT_LINE_ID',
    })

    return c.json({ url: session.url })
  } catch (error) {
    // 💡 修正点: eslint のルールを一時的に無効化してログ出力を許可
    // eslint-disable-next-line no-console
    console.error('Stripe Session Error:', error)

    // 💡 修正点: error を unknown として扱い、安全にメッセージを抽出（anyの排除）
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'
    return c.json({ error: errorMessage }, 500)
  }
})

/**
 * 🤖 2. LINE Webhook エンドポイント
 */
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
          const userId = event.source.userId

          if (!userId) continue

          try {
            // ─── D1からユーザーの有料/無料ステータスを取得 ───
            const userRow = await c.env.DB.prepare(
              'SELECT status FROM users WHERE line_user_id = ?',
            )
              .bind(userId)
              .first<{ status: string }>()

            let userStatus = 'free'

            if (!userRow) {
              await c.env.DB.prepare('INSERT INTO users (line_user_id, status) VALUES (?, ?)')
                .bind(userId, 'free')
                .run()
              userStatus = 'free'
            } else {
              userStatus = userRow.status
            }

            // ─── 無料ユーザーの場合のみ、KVで1日の回数制限チェック ───
            if (userStatus === 'free' && c.env.gemini_limit_kv) {
              const todayStr = new Date().toISOString().split('T')[0]
              const kvKey = `count:${userId}:${todayStr}`

              const currentCountRaw = await c.env.gemini_limit_kv.get(kvKey)
              const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) : 0

              if (currentCount >= 10) {
                const limitMessage =
                  'Oh my god! ユーとのトークが楽しすぎて、今日の無料枠（10通）を使い切っちゃったデース！😭\n\n' +
                  '明日また喋るか、月額プレミアムプラン（ワンコイン！）に登録してくれたら、ミーと無制限に喋り放題だぞ！🔥\n' +
                  '登録はココから頼むデース！👇\n' +
                  'https://liff.line.me/YOUR_LIFF_ID'

                await replyToLine(replyToken, limitMessage, c.env.LINE_CHANNEL_ACCESS_TOKEN)
                continue
              }

              await c.env.gemini_limit_kv.put(kvKey, (currentCount + 1).toString(), {
                expirationTtl: 86400,
              })
            }

            // ─── Gemini API の呼び出し ───
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
