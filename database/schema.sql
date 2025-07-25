-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone_number TEXT UNIQUE,
  pin TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Alert Criteria
CREATE TABLE alert_criteria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  keywords TEXT[], -- array of keywords
  notify_phone TEXT,
  notify_email TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Calls
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  call_sid TEXT,
  from_number TEXT,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  alert_triggered BOOLEAN DEFAULT FALSE,
  transcript TEXT,
  created_at TIMESTAMP DEFAULT now()
);