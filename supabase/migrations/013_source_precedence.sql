-- Keep one canonical record and its strongest capture when multiple sources overlap.
begin;
create or replace function hs_ops_preflight(p jsonb) returns jsonb language plpgsql stable set search_path=public as $$
declare c jsonb;d hs_documents;r hs_revisions;old_quality integer;new_quality integer;
begin
 select * into d from hs_documents where canonical_url=p->>'canonicalUrl';
 if d.status='withdrawn' then return jsonb_build_object('action','suppressed','id',d.id);end if;
 select * into r from hs_revisions where id=d.current_revision_id;
 if r.content_hash=p->>'contentHash' then return jsonb_build_object('action','unchanged','id',d.id);end if;
 old_quality:=case d.completeness when 'full' then 2 when 'partial' then 1 else 0 end;
 new_quality:=case p->>'completeness' when 'full' then 2 when 'partial' then 1 else 0 end;
 if d.id is not null and new_quality<old_quality then
  return jsonb_build_object('action',case when d.source_id=p->>'sourceId' then 'preserved' else 'unchanged' end,'id',d.id);
 end if;
 -- Prefer direct publishers over the historical discovery index. Other equal-quality
 -- cross-source records keep the current publisher rather than alternating revisions.
 if d.id is not null and new_quality=old_quality and d.source_id<>p->>'sourceId' and (d.source_id<>'pentester-land' or p->>'sourceId'='pentester-land') then
  return jsonb_build_object('action','unchanged','id',d.id);
 end if;
 c:=hs_ops_capacity('{}');if not (c->>'writeAllowed')::boolean then raise exception 'Archive capacity stop';end if;
 return jsonb_build_object('action','write','previousPath',r.object_path,'id',d.id);
end $$;
create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare check_result jsonb;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(p->>'canonicalUrl',0));
 if p ? 'jobLeaseToken' or p ? 'jobSourceId' then
  perform 1 from hs_jobs where source_id=p->>'jobSourceId' and external_id=p->>'jobExternalId'
   and lease_token=(p->>'jobLeaseToken')::uuid and lease_until>clock_timestamp() and status='running' and fingerprint=p->>'contentHash' for update;
  if not found then raise exception 'Job lease lost before activation' using errcode='40001';end if;
  perform 1 from hs_source_control where source_id=p->>'jobSourceId' and lease_token=(p->>'sourceLeaseToken')::uuid and lease_until>clock_timestamp() for update;
  if not found then raise exception 'Source lease lost before activation' using errcode='40001';end if;
 end if;
 check_result:=hs_ops_preflight(p);
 if check_result->>'action'<>'write' then return jsonb_build_object('id',check_result->'id','action',case when check_result->>'action'='suppressed' then 'preserved' else check_result->>'action' end);end if;
 result:=hs_ingest_v3(p);
 if result->>'action' in ('inserted','updated') then
  update hs_documents set source_id=p->>'sourceId',external_id=p->>'externalId' where id=(result->>'id')::uuid;
  if length(coalesce((p->'changes')::text,''))<60000 then update hs_revisions set changes=p->'changes' where id=(select current_revision_id from hs_documents where id=(result->>'id')::uuid);end if;
 end if;
 if result->>'action'='updated' then update hs_review_queue set status='superseded',resolved_at=now() where document_id=(result->>'id')::uuid and kind='embedding' and status='open';end if;
 return result;
end $$;
commit;
