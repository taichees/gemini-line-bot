-- ユーザー管理テーブル
CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,       -- LINEのユーザーID（一意のキー）
  status TEXT DEFAULT 'free',          -- 状態（'free' または 'premium'）
  stripe_customer_id TEXT,             -- Stripeの顧客ID（顧客管理・解約時に使用）
  stripe_subscription_id TEXT,         -- Stripeのサブスク契約ID
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);