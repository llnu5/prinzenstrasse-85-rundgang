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
  view        text,                              -- 'cad' | 'scan' | null: in welchem Ansichtsmodus erstellt
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
  view text,                                     -- 'cad' | 'scan' | null: in welchem Ansichtsmodus erstellt
  created_at  timestamptz not null default now()
);
alter table public.measurements enable row level security;
drop policy if exists measurements_all on public.measurements;
create policy measurements_all on public.measurements for all using (true) with check (true);
alter publication supabase_realtime add table public.measurements;

-- Migration für bestehende Datenbanken: 'view'-Spalte nachrüsten
alter table public.threads      add column if not exists view text;
alter table public.measurements add column if not exists view text;

-- ---------------------------------------------------------------------------
--  Projekte + Upload (Multi-Projekt)
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null,                 -- 'matterport' | 'rhino'
  file_path   text,                          -- Pfad im Storage-Bucket 'models'
  file_name   text,
  has_2d_scan boolean not null default false,
  version     int not null default 1,
  created_at  timestamptz not null default now()
);
alter table public.projects enable row level security;
drop policy if exists projects_all on public.projects;
create policy projects_all on public.projects for all using (true) with check (true);
alter publication supabase_realtime add table public.projects;

-- project_id an alle Annotationen (NULL = Standard-/Prinzenstrasse-Projekt)
alter table public.threads       add column if not exists project_id uuid;
alter table public.comments      add column if not exists project_id uuid;
alter table public.measurements  add column if not exists project_id uuid;
alter table public.bookmarks     add column if not exists project_id uuid;
alter table public.chat_messages add column if not exists project_id uuid;

-- Storage-Bucket fuer Modelldateien (oeffentlich lesbar, 500 MB/Datei)
insert into storage.buckets (id, name, public, file_size_limit)
  values ('models','models', true, 524288000)
  on conflict (id) do update set public = true, file_size_limit = 524288000;
drop policy if exists models_read  on storage.objects;
drop policy if exists models_write on storage.objects;
create policy models_read  on storage.objects for select using (bucket_id = 'models');
create policy models_write on storage.objects for all    using (bucket_id = 'models') with check (bucket_id = 'models');
