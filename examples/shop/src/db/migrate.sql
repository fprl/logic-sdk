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

insert into products (sku, name, price, stock) values
  ('mug', 'Logic mug', 1200, 10),
  ('tee', 'Logic tee', 2500, 5),
  ('poster', 'Signed poster', 4000, 1)
on conflict do nothing;
