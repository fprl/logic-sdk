create extension if not exists btree_gist;

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  name text not null,
  nightly_rate integer not null,
  cleaning_fee integer not null,
  min_nights integer not null default 1
);

create table if not exists availability_holds (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null,
  "from" date not null,
  "to" date not null,
  reason text not null,
  source_id text not null,
  check ("from" < "to"),
  -- the real guarantee: no overlapping holds per property, even under concurrency
  exclude using gist (property_id with =, daterange("from", "to") with &&)
);

create table if not exists enquiries (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  property_id uuid not null,
  guest_email text not null,
  message text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  property_id uuid not null,
  enquiry_id uuid,
  guest_email text not null,
  check_in date not null,
  check_out date not null,
  total integer not null,
  status text not null default 'pending'
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  title text not null,
  booking_id uuid,
  status text not null default 'todo'
);
