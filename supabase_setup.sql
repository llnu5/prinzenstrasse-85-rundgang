-- ===========================================================================
--  Supabase-Setup für das Kommentar-/Annotationssystem (3D-Rundgang)
--  Im Supabase SQL-Editor einfügen und "Run" klicken.
-- ===========================================================================

-- Ein "Thread" = ein Pin im 3D-Modell + der erste Kommentar dazu
create table if not exists public.threads (
  id          uuid primary key default gen_random_uuid(),
  author      text not null,
  body        text not null,
  pos_x       double precision not null,
  pos_y       double precision not null,
  pos_z       double precision not null,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- "Comments" = Antworten innerhalb eines Threads
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.threads(id) on delete cascade,
  author      text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists comments_thread_idx on public.comments(thread_id);

-- Row Level Security aktivieren
alter table public.threads  enable row level security;
alter table public.comments enable row level security;

-- Offene Policies: jeder Besucher darf lesen, anlegen, aktualisieren, löschen.
-- (Passend für ein öffentliches Gästebuch/Review-Tool. Bei Bedarf später verschärfen.)
drop policy if exists threads_all  on public.threads;
drop policy if exists comments_all on public.comments;
create policy threads_all  on public.threads  for all using (true) with check (true);
create policy comments_all on public.comments for all using (true) with check (true);

-- Echtzeit-Synchronisierung aktivieren
alter publication supabase_realtime add table public.threads;
alter publication supabase_realtime add table public.comments;

-- ---------------------------------------------------------------------------
--  Messwerkzeug: dauerhafte Messstrecken (2 Punkte im 3D-Modell)
-- ---------------------------------------------------------------------------
create table if not exists public.measurements (
  id          uuid primary key default gen_random_uuid(),
  author      text,
  ax double precision not null, ay double precision not null, az double precision not null,
  bx double precision not null, by double precision not null, bz double precision not null,
  created_at  timestamptz not null default now()
);
alter table public.measurements enable row level security;
drop policy if exists measurements_all on public.measurements;
create policy measurements_all on public.measurements for all using (true) with check (true);
alter publication supabase_realtime add table public.measurements;
