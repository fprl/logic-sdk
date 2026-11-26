create table if not exists products (
  sku text primary key,
  name text not null,
  price integer not null, -- cents
  stock integer not null check (stock >= 0)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null,
  status text not null default 'placed', -- placed, shipped, cancelled
  items jsonb not null,
  total integer not null,
  created_at timestamptz not null
);

-- logic-sdk's tables. With drizzle-kit, export jobsTable and cronRunsTable from your schema instead.
create table if not exists logic_jobs (
  id text primary key,
  job jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  receipt text,
  claimed_at timestamptz,
  last_error text,
  failed_at timestamptz,
  replace_key text,
  created_at timestamptz not null default now()
);
create index if not exists logic_jobs_due on logic_jobs (available_at) where status = 'pending';
create unique index if not exists logic_jobs_replace on logic_jobs (replace_key) where status = 'pending' and attempts = 0;
create index if not exists logic_jobs_failed on logic_jobs (failed_at, id) where status = 'failed';

create table if not exists logic_cron_runs (
  id text primary key,
  ran_at timestamptz not null default now()
);
create index if not exists logic_cron_runs_ran_at on logic_cron_runs (ran_at);

insert into products (sku, name, price, stock) values
  ('mug', 'Logic mug', 1200, 10),
  ('tee', 'Logic tee', 2500, 5),
  ('poster', 'Signed poster', 4000, 1)
on conflict do nothing;
