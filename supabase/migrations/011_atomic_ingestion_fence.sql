-- Hold the current job/source leases in the same transaction as revision activation.
begin;
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
 if result->>'action'='updated' then update hs_review_queue set status='superseded',resolved_at=now() where document_id=(result->>'id')::uuid and kind='embedding' and status='open';end if;
 if result->>'action' in ('inserted','updated') and length(coalesce((p->'changes')::text,''))<60000 then update hs_revisions set changes=p->'changes' where id=(select current_revision_id from hs_documents where id=(result->>'id')::uuid);end if;
 return result;
end $$;


commit;
