-- Apply after 001 in Supabase. Local PGlite runs the same core schema without hosted roles.
do $$ declare obj record; begin
 for obj in select tablename from pg_tables where schemaname='public' and tablename like 'hs_%' loop
  execute format('alter table public.%I enable row level security',obj.tablename);
  execute format('revoke all on table public.%I from public',obj.tablename);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on table public.%I from anon, authenticated',obj.tablename);end if;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant all on table public.%I to service_role',obj.tablename);end if;
 end loop;
 for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hs_%' loop
  execute format('revoke all on function %s from public',obj.signature);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on function %s from anon, authenticated',obj.signature);end if;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role',obj.signature);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant usage,select on sequence hs_chunks_id_seq to service_role;end if;
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('archive','archive',false,10485760,array['application/gzip']) on conflict(id) do nothing;
 end if;
end $$;
