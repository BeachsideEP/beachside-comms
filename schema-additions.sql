-- ============================================================
-- BEP Comms — Schema Additions
-- Run this in Supabase SQL Editor AFTER the original schema.sql
-- ============================================================

-- ============================================================
-- CONVERSATIONS
-- One row per patient — holds the thread state
-- ============================================================

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id bigint NOT NULL UNIQUE,
  patient_name text NOT NULL,
  patient_email text,
  patient_phone text,
  last_message_at timestamptz,
  last_message_preview text,
  unread boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_patient ON conversations(patient_id);
CREATE INDEX idx_conversations_unread ON conversations(unread);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);

-- ============================================================
-- MESSAGES
-- Every inbound and outbound message across both channels
-- ============================================================

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  patient_id bigint NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  subject text,                        -- Email subject (outbound) or sender (inbound)
  body text NOT NULL,
  status text NOT NULL DEFAULT 'sent', -- sent | delivered | failed | received
  provider_id text,                    -- Twilio SID or SendGrid message ID
  from_address text,                   -- Phone or email it came from
  to_address text,                     -- Phone or email it went to
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_patient ON messages(patient_id);
CREATE INDEX idx_messages_direction ON messages(direction);
CREATE INDEX idx_messages_created ON messages(created_at DESC);

-- ============================================================
-- VIEW: INBOX
-- Conversations ordered by most recent message
-- ============================================================

CREATE VIEW inbox AS
SELECT
  c.id,
  c.patient_id,
  c.patient_name,
  c.patient_email,
  c.patient_phone,
  c.last_message_at,
  c.last_message_preview,
  c.unread,
  COUNT(m.id) FILTER (WHERE m.direction = 'inbound' AND m.read = false) AS unread_count
FROM conversations c
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY c.id
ORDER BY c.last_message_at DESC NULLS LAST;
