-- Phase 4: resumable operations, ownership-fenced leases, health and administration.
begin;
create table if not exists hs_source_control(
 source_id text primary key,enabled boolean not null default true,poll_seconds integer not null default 3600 check(poll_seconds between 300 and 2592000),
 lease_token uuid,lease_until timestamptz,last_attempt_at timestamptz,last_success_at timestamptz,
 status text not null default 'ready',last_error text not null default '',recent_cursor jsonb not null default '{}',backfill_cursor jsonb not null default '{}',refresh_requested boolean not null default false,retry_at timestamptz
);
insert into hs_source_control(source_id,poll_seconds,last_success_at) select id,case id when 'owasp-cheatsheets' then 604800 when 'pentester-land' then 86400 else 3600 end,last_success_at from hs_sources on conflict do nothing;
alter table hs_jobs add column if not exists payload jsonb;
alter table hs_jobs add column if not exists fingerprint text;
alter table hs_jobs add column if not exists lease_token uuid;
alter table hs_revisions add column if not exists changes jsonb;
create table if not exists hs_admins(owner_id uuid primary key references auth.users(id) on delete cascade);
create table if not exists hs_admin_audit(id bigint generated always as identity primary key,actor_id uuid,action text not null,target text not null,reason text not null default '',created_at timestamptz not null default now());
create table if not exists hs_review_queue(id uuid primary key default gen_random_uuid(),source_id text,document_id uuid references hs_documents(id),kind text not null,detail text not null,status text not null default 'open',created_at timestamptz not null default now(),resolved_at timestamptz);
create unique index if not exists hs_review_open on hs_review_queue(coalesce(source_id,''),coalesce(document_id,'00000000-0000-0000-0000-000000000000'::uuid),kind) where status='open';
create table if not exists hs_suppressions(document_id uuid primary key references hs_documents(id),reason text not null,created_at timestamptz not null default now());
create table if not exists hs_ops_daily(day date primary key default current_date,runs integer not null default 0,successes integer not null default 0,failures integer not null default 0,documents integer not null default 0);

create or replace function hs_ops_source(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare s hs_source_control; a text:=p->>'action'; sid text:=p->>'sourceId'; token uuid;
begin
 if sid is null or length(sid)>120 then raise exception 'Invalid source';end if;
 insert into hs_source_control(source_id,poll_seconds) values(sid,case sid when 'owasp-cheatsheets' then 604800 when 'pentester-land' then 86400 else 3600 end) on conflict do nothing;
 select * into s from hs_source_control where source_id=sid for update;
 if a='claim' then
  if not s.enabled or s.lease_until>now() or s.retry_at>now() or (not s.refresh_requested and not coalesce((p->>'force')::boolean,false) and s.last_success_at+make_interval(secs=>s.poll_seconds)>now()) then return jsonb_build_object('claimed',false,'status',case when not s.enabled then 'paused' when s.lease_until>now() then 'busy' when s.retry_at>now() then 'retry_delay' else 'not_due' end);end if;
  token:=gen_random_uuid();update hs_source_control set lease_token=token,lease_until=now()+interval '5 minutes',last_attempt_at=now(),status='running' where source_id=sid;
  return jsonb_build_object('claimed',true,'token',token,'cursor',case when p->>'mode'='backfill' then s.backfill_cursor else s.recent_cursor end);
 end if;
 if s.lease_token is null or p->>'token' is null or s.lease_token is distinct from (p->>'token')::uuid or s.lease_until<now() then raise exception 'Source lease lost' using errcode='40001';end if;
 if a='heartbeat' then update hs_source_control set lease_until=now()+interval '5 minutes' where source_id=sid;
 elsif a='checkpoint' then
  if jsonb_typeof(p->'cursor')<>'object' or length((p->'cursor')::text)>20000 then raise exception 'Invalid cursor';end if;
  update hs_source_control set recent_cursor=case when p->>'mode'='backfill' then recent_cursor else p->'cursor' end,backfill_cursor=case when p->>'mode'='backfill' then p->'cursor' else backfill_cursor end where source_id=sid;
 elsif a='release' then
  update hs_source_control set lease_token=null,lease_until=null,refresh_requested=false,retry_at=case when (p->>'ok')::boolean then null else now()+make_interval(secs=>least(86400,greatest(300,coalesce((p->>'retrySeconds')::int,0)))) end,status=case when coalesce((p->>'ok')::boolean,false) then 'success' else 'partial' end,last_success_at=case when coalesce((p->>'ok')::boolean,false) then now() else last_success_at end,last_error=left(coalesce(p->>'error',''),300) where source_id=sid;
  insert into hs_ops_daily(day,runs,successes,failures,documents) values(current_date,1,case when (p->>'ok')::boolean then 1 else 0 end,case when (p->>'ok')::boolean then 0 else 1 end,coalesce((p->>'processed')::int,0)) on conflict(day) do update set runs=hs_ops_daily.runs+1,successes=hs_ops_daily.successes+excluded.successes,failures=hs_ops_daily.failures+excluded.failures,documents=hs_ops_daily.documents+excluded.documents;
 else raise exception 'Invalid operation';end if;return jsonb_build_object('ok',true);
end $$;

create or replace function hs_ops_job(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare j hs_jobs; token uuid; sid text:=p->>'sourceId'; ext text:=p->>'externalId';a text:=p->>'action';
begin
 if a='due' then return coalesce((select jsonb_agg(x) from (select source_id,external_id,payload from hs_jobs where source_id=sid and payload is not null and status in ('pending','retry','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by updated_at limit 100) x),'[]');end if;
 if a='enqueue' then
  if pg_database_size(current_database())>=450000000 then raise exception 'Pending work capacity reached';end if;
  perform pg_advisory_xact_lock(hashtextextended('jobs:'||sid,0));
  select * into j from hs_jobs where source_id=sid and external_id=ext for update;
  if j.lease_until>now() then return jsonb_build_object('accepted',false);end if;
  if j.fingerprint=p->>'fingerprint' then return jsonb_build_object('accepted',true,'unchanged',true);end if;
  if length((p->'document')::text)>2200000 or (select count(*) from hs_jobs where payload is not null and source_id=sid)>=200 then raise exception 'Pending work capacity reached';end if;
  insert into hs_jobs(source_id,external_id,payload,fingerprint,status) values(sid,ext,p->'document',p->>'fingerprint','pending') on conflict(source_id,external_id) do update set payload=excluded.payload,fingerprint=excluded.fingerprint,status='pending',attempts=0,next_attempt_at=now(),lease_until=null,lease_token=null,updated_at=now();
  return jsonb_build_object('accepted',true);
 elsif a='claim' then
  token:=gen_random_uuid();update hs_jobs set status='running',lease_token=token,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where source_id=sid and external_id=ext and payload is not null and status<>'failed' and next_attempt_at<=now() and (lease_until is null or lease_until<now()) returning * into j;
  return jsonb_build_object('claimed',found,'token',case when j.external_id is not null then token else null end,'document',j.payload);
 end if;
 select * into j from hs_jobs where source_id=sid and external_id=ext for update;
 if j.lease_token is null or p->>'token' is null or j.lease_token is distinct from (p->>'token')::uuid or j.lease_until<now() then raise exception 'Job lease lost' using errcode='40001';end if;
 if a='heartbeat' then update hs_jobs set lease_until=now()+interval '3 minutes' where source_id=sid and external_id=ext;
 elsif a='finish' then
  update hs_jobs set status=case when coalesce(p->>'error','')='' then 'done' when attempts>=5 then 'failed' else 'retry' end,payload=case when coalesce(p->>'error','')='' then null else payload end,last_error=left(coalesce(p->>'error',''),300),lease_token=null,lease_until=null,next_attempt_at=now()+make_interval(secs=>least(86400,greatest(coalesce((p->>'retrySeconds')::int,0),60*power(2,least(attempts,10))::int))),updated_at=now() where source_id=sid and external_id=ext;
 else raise exception 'Invalid operation';end if;return jsonb_build_object('ok',true);
end $$;

create or replace function hs_ops_health(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
select jsonb_build_object('phase',4,'checkedAt',now(),'sources',coalesce((select jsonb_agg(x) from (select c.source_id,coalesce(s.name,c.source_id) name,s.url,c.enabled,c.poll_seconds,c.last_attempt_at,c.last_success_at,
 case when not c.enabled then 'paused' when c.lease_until>now() then 'running' when c.last_success_at is null then 'never' when c.last_success_at+make_interval(secs=>2*c.poll_seconds+3600)<now() then 'stale' else c.status end status,
 (select max(published_at) from hs_documents where source_id=c.source_id and status='published') latest_publication,
 (select count(*) from hs_documents where source_id=c.source_id and status='published') documents,
 (select count(*) from hs_documents where source_id=c.source_id and status='published' and completeness='full') full,
 (select count(*) from hs_jobs where source_id=c.source_id and payload is not null and status in ('pending','retry','running')) pending,
 (select count(*) from hs_jobs where source_id=c.source_id and status='failed') failed
 from hs_source_control c left join hs_sources s on s.id=c.source_id order by c.source_id) x),'[]'),
 'indexPending',(select count(*) from hs_documents d where status='published' and not exists(select 1 from hs_embedding_sets e join hs_embedding_models m on m.id=e.model_id and m.active where e.document_id=d.id and e.revision_id=d.current_revision_id)),
 'lastBackup',(select value->'completedAt' from hs_state where key='backup:last'));
$$;
create or replace function hs_ops_review(p jsonb) returns jsonb language plpgsql set search_path=public as $$
begin insert into hs_review_queue(source_id,document_id,kind,detail) values(p->>'sourceId',nullif(p->>'documentId','')::uuid,left(p->>'kind',50),left(p->>'detail',500)) on conflict do nothing;return '{}';end $$;
create or replace function hs_me_ops_status(p jsonb default '{}') returns jsonb language sql stable security definer set search_path=public as $$select jsonb_build_object('admin',exists(select 1 from hs_admins where owner_id=auth.uid()));$$;
create or replace function hs_me_ops(p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from hs_admins where owner_id=auth.uid()) then raise exception 'Administrator required' using errcode='42501';end if;
 return hs_ops_health('{}')||jsonb_build_object('capacity',hs_ops_capacity('{}'),'jobs',coalesce((select jsonb_agg(x) from (select source_id,external_id,status,attempts,last_error,next_attempt_at from hs_jobs where status in ('retry','failed') order by updated_at desc limit 50)x),'[]'),'reviews',coalesce((select jsonb_agg(x) from (select * from hs_review_queue where status='open' order by created_at limit 50)x),'[]'),'audit',coalesce((select jsonb_agg(x) from (select action,target,reason,created_at from hs_admin_audit order by id desc limit 30)x),'[]'),'daily',coalesce((select jsonb_agg(x) from (select * from hs_ops_daily order by day desc limit 30)x),'[]'));
end $$;
create or replace function hs_me_ops_mutate(p jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid();a text:=p->>'action';changed integer;
begin
 if not exists(select 1 from hs_admins where owner_id=actor) then raise exception 'Administrator required' using errcode='42501';end if;
 if a='source_enabled' then update hs_source_control set enabled=(p->>'enabled')::boolean where source_id=p->>'sourceId';
 elsif a='source_refresh' then update hs_source_control set refresh_requested=true where source_id=p->>'sourceId';
 elsif a='retry_job' then update hs_jobs set status='retry',attempts=0,next_attempt_at=now(),last_error='' where source_id=p->>'sourceId' and external_id=p->>'externalId' and payload is not null and (lease_until is null or lease_until<now());
 elsif a='resolve_review' then update hs_review_queue set status='resolved',resolved_at=now() where id=(p->>'id')::uuid and status='open';
 elsif a='withdraw' then
  if length(trim(coalesce(p->>'reason','')))<5 then raise exception 'Withdrawal reason required';end if;
  update hs_documents set status='withdrawn' where id=(p->>'documentId')::uuid;
  if not found then raise exception 'Document not found';end if;
  insert into hs_suppressions(document_id,reason) values((p->>'documentId')::uuid,left(p->>'reason',500)) on conflict(document_id) do update set reason=excluded.reason;
  delete from hs_chunks where document_id=(p->>'documentId')::uuid;
  delete from hs_embedding_passages where document_id=(p->>'documentId')::uuid;
  delete from hs_embedding_sets where document_id=(p->>'documentId')::uuid;
  delete from hs_citations where document_id=(p->>'documentId')::uuid;
 else raise exception 'Unknown admin action';end if;
 get diagnostics changed=row_count;
 insert into hs_admin_audit(actor_id,action,target,reason) values(actor,a,coalesce(p->>'sourceId',p->>'documentId',p->>'id',''),left(coalesce(p->>'reason',''),500));
 return jsonb_build_object('ok',true,'changed',changed);
end $$;
create or replace function hs_ops_revisions(p jsonb) returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (select r.id,r.fetched_at,r.content_hash,r.source_revision,r.changes,r.id=d.current_revision_id as current from hs_revisions r join hs_documents d on d.id=r.document_id where d.id=(p->>'id')::uuid and d.status='published' order by r.fetched_at desc,r.id limit 50)x;
$$;

do $$ declare t text; f record;begin
 foreach t in array array['hs_source_control','hs_admins','hs_admin_audit','hs_review_queue','hs_suppressions','hs_ops_daily'] loop
 execute format('alter table %I enable row level security',t);execute format('revoke all on %I from public,anon,authenticated',t);execute format('grant all on %I to service_role',t);end loop;
 grant usage,select on sequence hs_admin_audit_id_seq to service_role;
 for f in select oid::regprocedure sig,proname from pg_proc where pronamespace='public'::regnamespace and (proname like 'hs_ops_%' or proname like 'hs_me_ops%') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);execute format('grant execute on function %s to service_role',f.sig);
 if f.proname like 'hs_me_ops%' then execute format('grant execute on function %s to authenticated',f.sig);end if;end loop;
 -- Bootstrap only the verified GitHub identity of this installation's owner, not editable user metadata.
 if to_regclass('auth.identities') is not null then execute $q$insert into hs_admins(owner_id) select user_id from auth.identities where provider='github' and provider_id='46968144' on conflict do nothing$q$;end if;
end $$;
commit;
