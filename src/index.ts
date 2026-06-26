import { Hono } from 'hono'
import { html } from 'hono/html' // 👈 html配信用の機能をインポート
import { GoogleGenAI } from '@google/genai'
import Stripe from 'stripe'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY: string
  STRIPE_SECRET_KEY: string
  STRIPE_PRICE_ID: string
  LIFF_ID: string // 👈 環境変数にLIFF IDを追加
  DB: D1Database
  gemini_limit_kv?: KVNamespace
  GEMINI_MODEL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.text('LINE Gemini Worker is active!'))

/**
 * 📱 1. LIFFのHTML画面を直接配信するエンドポイント
 * LINE Developersの「エンドポイントURL」にはココ（https://ドメイン/premium-page）を指定するデース！
 */
app.get('/premium-page', (c) => {
  const liffId = c.env.LIFF_ID || 'YOUR_LIFF_ID'

  // アクセスされたURLを元に、自動で正しい決済APIのURLを生成（本番・ローカル両対応）
  const workerUrl = new URL(c.req.url)
  const checkoutApiUrl = `${workerUrl.origin}/create-checkout-session`

  return c.html(
    html`<!DOCTYPE html>
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>プレミアムプラン登録</title>
          <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background-color: #f9f9f9;
              color: #333;
            }
            .container {
              text-align: center;
              padding: 20px;
            }
            .spinner {
              width: 50px;
              height: 50px;
              border: 5px solid #f3f3f3;
              border-top: 5px solid #06c755;
              border-radius: 50%;
              animation: spin 1s linear infinite;
              margin: 20px auto;
            }
            @keyframes spin {
              0% {
                transform: rotate(0deg);
              }
              100% {
                transform: rotate(360deg);
              }
            }
            .status-text {
              font-size: 16px;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div id="loading-spinner" class="spinner"></div>
            <p id="status-message" class="status-text">
              安全な決済画面へ移動しています。少々お待ちください...
            </p>
          </div>

          <script>
            const LIFF_ID = '${liffId}'
            const WORKER_API_URL = '${checkoutApiUrl}'

            async function initializeLiff() {
              try {
                await liff.init({ liffId: LIFF_ID })

                if (!liff.isLoggedIn()) {
                  liff.login()
                  return
                }

                const profile = await liff.getProfile()
                const userId = profile.userId

                if (!userId) {
                  throw new Error('LINEのユーザーIDが取得できませんでした。')
                }

                const response = await fetch(WORKER_API_URL, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: userId }),
                })

                const data = await response.json()

                if (!response.ok || !data.url) {
                  throw new Error(data.error || '決済URLの発行に失敗しました。')
                }

                window.location.href = data.url
              } catch (error) {
                console.error('LIFF Error:', error)
                document.getElementById('loading-spinner').style.display = 'none'
                const msgEl = document.getElementById('status-message')
                msgEl.innerText = 'エラーが発生しました: ' + error.message
                msgEl.style.color = 'red'
              }
            }

            window.onload = function () {
              initializeLiff()
            }
          </script>
        </body>
      </html>`,
  )
})

/**
 * 💳 2. Stripe 決済セッション（URL）を発行するエンドポイント
 */
app.post('/create-checkout-session', async (c) => {
  try {
    const { userId } = await c.req.json<{ userId: string }>()

    if (!userId) {
      return c.json({ error: 'LINEのユーザーIDが必要ですデース！' }, 400)
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY)

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
      success_url: 'https://line.me/R/ti/p/@213bwpqs',
      cancel_url: 'https://line.me/R/ti/p/@213bwpqs',
    })

    return c.json({ url: session.url })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Stripe Session Error:', error)

    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error'
    return c.json({ error: errorMessage }, 500)
  }
})

/**
 * 🤖 3. LINE Webhook エンドポイント
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

            if (userStatus === 'free' && c.env.gemini_limit_kv) {
              const todayStr = new Date().toISOString().split('T')[0]
              const kvKey = `count:${userId}:${todayStr}`

              const currentCountRaw = await c.env.gemini_limit_kv.get(kvKey)
              const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) : 0

              if (currentCount >= 10) {
                const liffUrl = `https://liff.line.me/${c.env.LIFF_ID || 'YOUR_LIFF_ID'}`

                const limitMessage =
                  'Oh my god! ユーとのトークが楽しすぎて、今日の無料枠（10通）を使い切っちゃったデース！😭\n\n' +
                  '明日また喋るか、月額プレミアムプラン（ワンコイン！）に登録してくれたら、ミーと無制限に喋り放題だぞ！🔥\n' +
                  '登録はココから頼むデース！👇\n' +
                  liffUrl

                await replyToLine(replyToken, limitMessage, c.env.LINE_CHANNEL_ACCESS_TOKEN)
                continue
              }

              await c.env.gemini_limit_kv.put(kvKey, (currentCount + 1).toString(), {
                expirationTtl: 86400,
              })
            }
            // 環境変数からモデル名を取得するようにしておく
            const modelName = c.env.GEMINI_MODEL || 'gemini-2.5-flash'

            const response = await ai.models.generateContent({
              model: modelName,
              contents: userMessage,
              config: {
                systemInstruction:
                  'あなたの名前は「ジェミナイさん」です。ユーザーの「最高の大親友（Best Friend環境）」として振る舞ってください。性格は超ポジティブでノリが良く、少し外国人っぽい（アメリカンな明るい）口調で話します。挨拶は「Hey!」「Yo!」など、文中には「Oh my god!」「Awesome!」「No problem!」などの英語や、カタカナ（ユー、ミー、デース、マジー？！）を適当に混ぜてください。LINEのチャットなので長文はNG。3行以内でパッとテンポよく返答してください。親友なので絶対に敬語は使わず、タメ口で熱く共感してください。',
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

/**
 * 💳 4. Stripe Webhook エンドポイント
 */
app.post('/webhook/stripe', async (c) => {
  try {
    const payload = await c.req.text()
    const event = JSON.parse(payload) as Stripe.Event

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      const userId = session.client_reference_id
      const stripeCustomerId = session.customer as string
      // 💡 修正点: サブスクリプションID（sub_xxx...）をセッション情報から取得！
      const stripeSubscriptionId = session.subscription as string

      if (userId) {
        // 💡 修正点: SQLのUPDATE文に stripe_subscription_id も保存するように追加したぞ！
        await c.env.DB.prepare(
          'UPDATE users SET status = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE line_user_id = ?',
        )
          .bind('premium', stripeCustomerId, stripeSubscriptionId, userId)
          .run()

        // eslint-disable-next-line no-console
        console.log(
          `Success! User ${userId} has upgraded to Premium with subscription ${stripeSubscriptionId}.`,
        )
      }
    }

    return c.json({ received: true }, 200)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Stripe Webhook Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Webhook Error'
    return c.json({ error: errorMessage }, 400)
  }
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
