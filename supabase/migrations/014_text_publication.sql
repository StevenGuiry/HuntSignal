-- Discovery links remain internal until a substantive text capture is activated.
begin;
alter table hs_documents drop constraint if exists hs_documents_status_check;
alter table hs_documents add constraint hs_documents_status_check check(status in ('pending','published','withdrawn'));
create or replace function hs_require_archived_text() returns trigger language plpgsql set search_path=public as $$
begin
 if new.status<>'withdrawn' then new.status:=case when new.completeness='metadata' or new.current_revision_id is null then 'pending' else 'published' end;end if;
 return new;
end $$;
drop trigger if exists hs_require_archived_text on hs_documents;
create trigger hs_require_archived_text before insert or update of completeness,current_revision_id,status on hs_documents for each row execute function hs_require_archived_text();
update hs_documents set status='pending' where completeness='metadata' and status='published';
create or replace function hs_record_publication() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.current_revision_id is not null and new.current_revision_id is distinct from old.current_revision_id and new.status='published' then
  insert into hs_publication_events(document_id,revision_id,kind,historical)
  values(new.id,new.current_revision_id,case when old.current_revision_id is null or old.status<>'published' then 'published' else 'updated' end,
   (old.current_revision_id is null or old.status<>'published') and (new.published_at is null or new.published_at<now()-interval '7 days')) on conflict do nothing;
 end if;return new;
end $$;

do $$begin if to_regprocedure('public.hs_ingest_with_precedence(jsonb)') is null then alter function hs_ingest(jsonb) rename to hs_ingest_with_precedence;end if;end $$;
create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
begin
 if p->>'completeness'<>'metadata' and length(trim(coalesce(p->>'markdown','')))<80 then raise exception 'Substantive archived text is required';end if;
 return hs_ingest_with_precedence(p);
end $$;
revoke all on function hs_ingest(jsonb),hs_require_archived_text() from public,anon,authenticated;
grant execute on function hs_ingest(jsonb) to service_role;

create or replace function hs_capture_candidates(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (
 select d.id,jsonb_build_object('sourceId',d.source_id,'sourceName',s.name,'sourceUrl',s.url,'externalId',d.external_id,'canonicalUrl',d.canonical_url,'title',d.title,'kind',d.kind,'platform',d.platform,'authors',d.authors,'topics',d.topics,'programs',d.programs,'excerpt',d.excerpt,'markdown','','publishedAt',d.published_at,'completeness','metadata','license',d.license,'licenseUrl',d.license_url,'attribution',d.attribution,'rightsEvidence',d.rights_evidence,'canArchive',false) as document
 from hs_documents d join hs_sources s on s.id=d.source_id left join hs_revisions r on r.id=d.current_revision_id left join hs_state st on st.key='capture:'||d.id::text
 where ((d.status='pending' and d.completeness='metadata') or (d.status='published' and r.source_revision like 'public-text-%'))
 and (coalesce(p->>'source','')='' or d.source_id=p->>'source')
 and (st.value->>'version' is distinct from p->>'version' or nullif(st.value->>'nextAttemptAt','') is null or (st.value->>'nextAttemptAt')::timestamptz<=now())
 order by case when d.status='pending' then 0 else 1 end,case when d.source_id='pentester-land' then 1 else 0 end,d.published_at desc nulls last,d.first_seen_at desc,d.id
 limit least(100,greatest(1,coalesce((p->>'limit')::integer,25)))
 )x;
$$;
create or replace function hs_capture_record(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare doc uuid:=(p->>'id')::uuid;attempts integer;state text;
begin
 if not exists(select 1 from hs_documents where id=doc) then raise exception 'Document unavailable';end if;
 select coalesce((value->>'attempts')::integer,0)+1 into attempts from hs_state where key='capture:'||doc::text;attempts:=coalesce(attempts,1);
 state:=case when exists(select 1 from hs_documents where id=doc and status='published' and completeness<>'metadata') then 'captured' else left(coalesce(p->>'state','retry'),40) end;
 perform hs_state_set(jsonb_build_object('key','capture:'||doc::text,'value',jsonb_build_object('state',state,'version',left(p->>'version',80),'attempts',attempts,'lastAttemptAt',now(),'nextAttemptAt',now()+make_interval(secs=>case when state='captured' then 604800 else least(604800,3600*power(2,least(attempts-1,7))::integer) end),'reason',left(coalesce(p->>'reason',''),160))));
 return jsonb_build_object('state',state);
end $$;
revoke all on function hs_capture_candidates(jsonb),hs_capture_record(jsonb) from public,anon,authenticated;
grant execute on function hs_capture_candidates(jsonb),hs_capture_record(jsonb) to service_role;
insert into hs_source_control(source_id,poll_seconds) values('fulltext-capture',14400) on conflict(source_id) do nothing;

do $$begin if to_regprocedure('public.hs_ops_health_v5(jsonb)') is null then alter function hs_ops_health(jsonb) rename to hs_ops_health_v5;end if;end $$;
create or replace function hs_ops_health(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select hs_ops_health_v5(p)||jsonb_build_object('phase',5,'awaitingCapture',(select count(*) from hs_documents where status='pending'));
$$;
revoke all on function hs_ops_health(jsonb) from public,anon,authenticated;
grant execute on function hs_ops_health(jsonb) to service_role;
create or replace function hs_ops_status(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$select jsonb_build_object('phase',5,'schemaVersion',14,'requiresArchivedText',true);$$;
do $$begin if to_regprocedure('public.hs_ops_backup_snapshot_v9(jsonb)') is null then alter function hs_ops_backup_snapshot(jsonb) rename to hs_ops_backup_snapshot_v9;end if;end $$;
create or replace function hs_ops_backup_snapshot(p jsonb default '{}') returns jsonb language sql stable security definer set search_path=public as $$select hs_ops_backup_snapshot_v9(p)||jsonb_build_object('schemaVersion',14);$$;
revoke all on function hs_ops_backup_snapshot(jsonb) from public,anon,authenticated;
grant execute on function hs_ops_backup_snapshot(jsonb) to service_role;
commit;
