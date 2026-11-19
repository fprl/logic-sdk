create table if not exists links (
  slug text primary key,
  url text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists visits (
  slug text primary key,
  count integer not null default 0
);
