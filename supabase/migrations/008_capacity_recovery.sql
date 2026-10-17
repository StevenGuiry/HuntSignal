begin;
create table if not exists hs_archive_objects(path text primary key check(path ~ '^[a-f0-9]{64}\.json\.gz$'),bytes bigint not null check(bytes>=0),reserved_at timestamptz not null default now());
create table if not exists hs_privacy_tombstones(owner_id uuid primary key,deleted_at timestamptz not null default now());
create or replace function hs_ops_capacity(p jsonb default '{}') returns jsonb language plpgsql stable set search_path=public as $$
declare used bigint; actual bigint;unknown integer;dbbytes bigint:=pg_database_size(current_database());
begin
 select coalesce(sum(bytes),0) into used from hs_archive_objects;
 select count(*) into unknown from hs_revisions r join hs_documents d on d.id=r.document_id and d.status='published' where not exists(select 1 from hs_archive_objects o where o.path=r.object_path);
 if to_regclass('storage.objects') is not null then
  execute $q$select coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::bigint else 0 end),0) from storage.objects where bucket_id='archive'$q$ into actual;
  execute $q$select coalesce(sum(bytes),0) from public.hs_archive_objects o where not exists(select 1 from storage.objects s where s.bucket_id='archive' and s.name=o.path)$q$ into used;
  used:=used+actual;unknown:=0;
 end if;
 return jsonb_build_object('databaseBytes',dbbytes,'databaseLimit',500000000,'storageBytes',used,'storageLimit',1000000000,'unknownObjects',unknown,'warning',dbbytes>=350000000 or used>=700000000,'backfillAllowed',dbbytes<400000000 and used<800000000 and unknown=0,'writeAllowed',dbbytes<450000000 and used<900000000 and unknown=0);
end $$;
create or replace function hs_ops_object(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare c jsonb;old_bytes bigint;proposed bigint:=(p->>'bytes')::bigint;
begin
 if proposed<0 or proposed>10000000 then raise exception 'Invalid archive size';end if;
 perform pg_advisory_xact_lock(8124301);
 select bytes into old_bytes from hs_archive_objects where path=p->>'path';
 c:=hs_ops_capacity('{}');
 if coalesce(p->>'action','reserve')<>'measure' and (not (c->>'writeAllowed')::boolean or (c->>'storageBytes')::bigint+greatest(0,proposed-coalesce(old_bytes,0))>=900000000) then raise exception 'Archive capacity stop';end if;
 insert into hs_archive_objects(path,bytes) values(p->>'path',proposed) on conflict(path) do update set bytes=excluded.bytes;
 return jsonb_build_object('ok',true);
end $$;
create or replace function hs_ops_preflight(p jsonb) returns jsonb language plpgsql stable set search_path=public as $$
declare c jsonb:=hs_ops_capacity('{}'); d hs_documents;r hs_revisions;
begin
 select * into d from hs_documents where canonical_url=p->>'canonicalUrl';
 if d.status='withdrawn' then return jsonb_build_object('action','suppressed','id',d.id);end if;
 select * into r from hs_revisions where id=d.current_revision_id;
 if r.content_hash=p->>'contentHash' then return jsonb_build_object('action','unchanged','id',d.id);end if;
 if d.completeness='full' and p->>'completeness'<>'full' then return jsonb_build_object('action','preserved','id',d.id);end if;
 if not (c->>'writeAllowed')::boolean then raise exception 'Archive capacity stop';end if;
 return jsonb_build_object('action','write','previousPath',r.object_path,'id',d.id);
end $$;
do $$begin if to_regprocedure('public.hs_ingest_v3(jsonb)') is null then alter function hs_ingest(jsonb) rename to hs_ingest_v3;end if;end $$;
create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare check_result jsonb;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(p->>'canonicalUrl',0));
 check_result:=hs_ops_preflight(p);
 if check_result->>'action'<>'write' then return jsonb_build_object('id',check_result->'id','action',case when check_result->>'action'='suppressed' then 'preserved' else check_result->>'action' end);end if;
 result:=hs_ingest_v3(p);
 if result->>'action'='updated' then update hs_review_queue set status='superseded',resolved_at=now() where document_id=(result->>'id')::uuid and kind='embedding' and status='open';end if;
 if result->>'action' in ('inserted','updated') and length(coalesce((p->'changes')::text,''))<60000 then update hs_revisions set changes=p->'changes' where id=(select current_revision_id from hs_documents where id=(result->>'id')::uuid);end if;
 return result;
end $$;

create or replace function hs_ops_personal_quota() returns trigger language plpgsql security definer set search_path=public as $$
declare used integer;maximum integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,0));
 if pg_database_size(current_database())>=480000000 then raise exception 'Personal write capacity reached' using errcode='23514';end if;
 if tg_table_name='hs_collection_items' then
  if exists(select 1 from hs_collection_items where owner_id=new.owner_id and collection_id=new.collection_id and document_id=new.document_id) then return new;end if;
 else
  execute format('select count(*) from public.%I where owner_id=$1 and document_id=$2',tg_table_name) into used using new.owner_id,new.document_id;
  if used>0 then return new;end if;
 end if;
 maximum:=case tg_table_name when 'hs_notes' then 2000 when 'hs_collection_items' then 20000 else 10000 end;
 execute format('select count(*) from public.%I where owner_id=$1',tg_table_name) into used using new.owner_id;
 if used>=maximum then raise exception 'Personal storage quota reached' using errcode='23514';end if;
 return new;
end $$;
do $$declare t text;begin foreach t in array array['hs_notes','hs_bookmarks','hs_reading_state','hs_collection_items'] loop
 execute format('drop trigger if exists hs_storage_quota on %I',t);execute format('create trigger hs_storage_quota before insert on %I for each row execute function hs_ops_personal_quota()',t);end loop;end $$;
create or replace function hs_ops_record_deletion() returns trigger language plpgsql security definer set search_path=public as $$begin insert into hs_privacy_tombstones(owner_id) values(old.id) on conflict(owner_id) do update set deleted_at=now();return old;end $$;
drop trigger if exists hs_deletion_ledger on auth.users;
create trigger hs_deletion_ledger after delete on auth.users for each row execute function hs_ops_record_deletion();

create or replace function hs_ops_backup_table(name text) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;schema_name text:='public';table_name text:=name;
begin
 if not name=any(array['hs_embedding_models','hs_sources','hs_documents','hs_revisions','hs_runs','hs_jobs','hs_state','hs_source_control','hs_admins','hs_admin_audit','hs_review_queue','hs_suppressions','hs_ops_daily','hs_archive_objects','hs_privacy_tombstones','hs_bookmarks','hs_reading_state','hs_collections','hs_collection_items','hs_notes','hs_saved_searches','hs_notifications','hs_publication_events','hs_alert_pending','hs_alert_runner_state','auth.users','auth.identities']) then raise exception 'Table excluded from backup';end if;
 if name like 'auth.%' then schema_name:='auth';table_name:=split_part(name,'.',2);end if;
 if to_regclass(format('%I.%I',schema_name,table_name)) is null then return '[]';end if;
 execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from %I.%I t',schema_name,table_name) into result;
 return result;
end $$;
create or replace function hs_ops_backup_snapshot(p jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=public as $$
declare tables jsonb:='{}';name text;
begin
 if (select count(*) from hs_documents)>10000 or (select count(*) from auth.users)>1000 then raise exception 'Use a database dump for this archive size';end if;
 foreach name in array array['hs_embedding_models','hs_sources','hs_documents','hs_revisions','hs_runs','hs_jobs','hs_state','hs_source_control','hs_admins','hs_admin_audit','hs_review_queue','hs_suppressions','hs_ops_daily','hs_archive_objects','hs_privacy_tombstones','hs_bookmarks','hs_reading_state','hs_collections','hs_collection_items','hs_notes','hs_saved_searches','hs_notifications','hs_publication_events','hs_alert_pending','hs_alert_runner_state','auth.users','auth.identities'] loop
 tables:=tables||jsonb_build_object(name,hs_ops_backup_table(name));end loop;
 return jsonb_build_object('formatVersion',2,'createdAt',now(),'tables',tables,'schemaVersion',9);
end $$;
create or replace function hs_ops_privacy_ledger(p jsonb default '{}') returns jsonb language sql stable security definer set search_path=public as $$select jsonb_build_object('checkedAt',now(),'deletions',coalesce((select jsonb_agg(t) from hs_privacy_tombstones t),'[]'),'suppressions',coalesce((select jsonb_agg(t) from hs_suppressions t),'[]'));$$;
create or replace function hs_ops_housekeeping(p jsonb default '{}') returns jsonb language plpgsql set search_path=public as $$
begin
 update hs_runs set status='interrupted',finished_at=now(),detail='Worker lease expired' where status='running' and started_at<now()-interval '30 minutes';
 delete from hs_runs where finished_at<now()-interval '14 days';
 delete from hs_ops_daily where day<current_date-90;
 delete from hs_jobs where status='done' and updated_at<now()-interval '30 days';
 perform hs_state_set(jsonb_build_object('key','watchdog:last','value',hs_ops_health('{}')));
 return hs_ops_health('{}');
end $$;
create or replace function hs_ops_status(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$select jsonb_build_object('phase',4,'schemaVersion',8);$$;
do $$declare t text;f record;begin
 foreach t in array array['hs_archive_objects','hs_privacy_tombstones'] loop execute format('alter table %I enable row level security',t);execute format('revoke all on %I from public,anon,authenticated',t);execute format('grant all on %I to service_role',t);end loop;
 for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and (proname like 'hs_ops_%' or proname in ('hs_ingest','hs_ingest_v3')) loop execute format('revoke all on function %s from public,anon,authenticated',f.sig);execute format('grant execute on function %s to service_role',f.sig);end loop;
end $$;
commit;
