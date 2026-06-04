create table if not exists settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
create table if not exists instagram_accounts (
  id bigserial primary key,
  ig_user_id text unique not null,
  username text,
  access_token text not null,
  token_expires_at timestamptz,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists automation_rules (
  id bigserial primary key,
  account_id bigint references instagram_accounts(id) on delete cascade,
  name text not null,
  enabled boolean default true,
  keywords text[] default '{}',
  public_replies text[] default '{}',
  dm_replies text[] default '{}',
  reply_to_comments boolean default true,
  reply_to_dm boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists webhook_events (
  id bigserial primary key,
  object_type text,
  raw_event jsonb,
  entry_count int default 0,
  change_fields text[] default '{}',
  messaging_count int default 0,
  processed_count int default 0,
  status text default 'received',
  error text,
  created_at timestamptz default now()
);
create table if not exists activity_logs (
  id bigserial primary key,
  account_id bigint references instagram_accounts(id) on delete set null,
  event_id bigint references webhook_events(id) on delete set null,
  source text,
  status text not null,
  username text,
  sender_id text,
  comment_id text,
  media_id text,
  message_id text,
  text text,
  response text,
  reason text,
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_logs_created_at on activity_logs(created_at desc);
create index if not exists idx_events_created_at on webhook_events(created_at desc);
