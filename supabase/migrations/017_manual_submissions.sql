-- Administrator-reviewed URL submissions. Draft bodies are bounded and private.
begin;
insert into hs_source_control(source_id,poll_seconds) values('manual-submissions',14400) on conflict do nothing;

create or replace function hs_me_submissions(p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from hs_admins where owner_id=auth.uid()) then raise exception 'Administrator required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(item) from (select value-'document'-'token'-'contentHash'-'bodyHash'-'requestedBy' as item from hs_state where key like 'submission:%' order by updated_at desc limit 50) r),'[]');
end $$;

create or replace function hs_me_submission(p jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); a text:=p->>'action'; id uuid; v jsonb; d hs_documents; target text:=p->>'url';
begin
 if not exists(select 1 from hs_admins where owner_id=actor) then raise exception 'Administrator required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(817263517);
 if a='request' then
  if target is null or length(target)>2048 or target !~ '^https://[A-Za-z0-9.-]+(:443)?/' or target ~ '^https://[^/]*@' or coalesce(p->>'kind','') not in ('report','article') then raise exception 'Invalid public source URL';end if;
  select * into d from hs_documents where canonical_url=target;
  if d.status='withdrawn' then return jsonb_build_object('status','blocked','error','This source was withdrawn and cannot be resubmitted.');end if;
  if d.status='published' then return jsonb_build_object('id',d.id,'status','duplicate','documentId',d.id,'title',d.title,'url',target);end if;
  select value into v from hs_state where key like 'submission:%' and value->>'url'=target and value->>'status' not in ('cancelled','expired') order by updated_at desc limit 1;
  if v is not null then return v-'document'-'token'-'contentHash'-'bodyHash'-'requestedBy';end if;
  if pg_database_size(current_database())>=400000000 or (select count(*) from hs_state where key like 'submission:%' and value->>'status' in ('preview_queued','previewing','ready','ingest_queued','ingesting','failed'))>=20 then raise exception 'Submission queue capacity reached';end if;
  if (select count(*) from hs_admin_audit where actor_id=actor and action in ('submission_request','submission_retry') and created_at>now()-interval '1 day')>=20 then raise exception 'Daily submission limit reached';end if;
  id:=gen_random_uuid();v:=jsonb_build_object('id',id,'url',target,'kind',p->>'kind','status','preview_queued','requestedBy',actor,'requestedAt',now(),'updatedAt',now());
 else
  id:=(p->>'id')::uuid;select value into v from hs_state where key='submission:'||id::text for update;
  if v is null then raise exception 'Submission not found';end if;
  if a='approve' then
   if v->>'status'<>'ready' or (v->>'previewExpiresAt')::timestamptz<=now() or v->'document' is null then raise exception 'A current preview is required';end if;
   v:=v||jsonb_build_object('status','ingest_queued','approvedAt',now(),'approvedBy',actor);
  elsif a='cancel' then
   if v->>'status' in ('ingesting','published','duplicate','cancelled','blocked') then raise exception 'Submission cannot be cancelled in this state';end if;
   v:=(v-'document'-'token'-'previewMarkdown')||jsonb_build_object('status','cancelled');
  elsif a='retry' then
   if v->>'status' not in ('failed','expired') then raise exception 'Submission is not retryable';end if;
   if (select count(*) from hs_admin_audit where actor_id=actor and action in ('submission_request','submission_retry') and created_at>now()-interval '1 day')>=20 then raise exception 'Daily submission limit reached';end if;
   v:=(v-'document'-'token'-'previewMarkdown'-'approvedAt'-'approvedBy'-'error'-'previewExpiresAt')||jsonb_build_object('status','preview_queued');
  else raise exception 'Unknown submission operation';end if;
  v:=v||jsonb_build_object('updatedAt',now());
 end if;
 perform hs_state_set(jsonb_build_object('key','submission:'||id::text,'value',v));
 insert into hs_admin_audit(actor_id,action,target) values(actor,'submission_'||a,id::text);
 return v-'document'-'token'-'contentHash'-'bodyHash'-'requestedBy';
end $$;

create or replace function hs_submission_work(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare a text:=p->>'action'; v jsonb; doc jsonb:=p->'document'; id uuid; t uuid; d hs_documents; matches jsonb;
begin
 perform 1 from hs_source_control where source_id='manual-submissions' and lease_token=(p->>'sourceToken')::uuid and lease_until>clock_timestamp() for update;
 if not found then raise exception 'Source lease lost' using errcode='40001';end if;
 if a='claim' then
  update hs_state set value=(value-'document'-'token'-'previewMarkdown')||jsonb_build_object('status','expired','updatedAt',now()),updated_at=now()
   where key like 'submission:%' and value->>'status' in ('ready','ingest_queued','failed') and (value->>'previewExpiresAt')::timestamptz<now();
  select value into v from hs_state where key like 'submission:%' and (value->>'status' in ('preview_queued','ingest_queued') or (value->>'status' in ('previewing','ingesting') and (value->>'leaseUntil')::timestamptz<now())) order by updated_at limit 1 for update;
  if v is null then return null;end if;
  id:=(v->>'id')::uuid;t:=gen_random_uuid();
  v:=v||jsonb_build_object('status',case when v->>'status' in ('ingest_queued','ingesting') then 'ingesting' else 'previewing' end,'phase',case when v->>'status' in ('ingest_queued','ingesting') then 'ingest' else 'preview' end,'token',t,'leaseUntil',now()+interval '5 minutes','updatedAt',now());
 else
  id:=(p->>'id')::uuid;select value into v from hs_state where key='submission:'||id::text for update;
  if v is null or v->>'status' not in ('previewing','ingesting') or v->>'token' is distinct from p->>'token' or (v->>'leaseUntil')::timestamptz<=now() then raise exception 'Submission lease lost' using errcode='40001';end if;
  if a='preview' then
   if v->>'status'<>'previewing' or doc->>'sourceId'<>'manual-submissions' or coalesce(doc->>'completeness','') not in ('full','partial') or length(coalesce(doc->>'markdown','')) not between 80 and 200000 or length(doc::text)>250000 or coalesce(p->>'contentHash','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid source preview';end if;
   select * into d from hs_documents where canonical_url=doc->>'canonicalUrl';
   if d.status='withdrawn' then v:=v||jsonb_build_object('status','blocked','error','This source was withdrawn and cannot be resubmitted.');
   elsif d.status='published' then v:=v||jsonb_build_object('status','duplicate','documentId',d.id,'title',d.title);
   else
    select coalesce(jsonb_agg(x),'[]') into matches from (
      select distinct candidate.id,candidate.title,case when es.body_hash=p->>'bodyHash' then 'same archived text' else 'same title' end as match
      from hs_documents candidate left join hs_embedding_sets es on es.document_id=candidate.id and es.revision_id=candidate.current_revision_id
      where candidate.status='published' and (es.body_hash=p->>'bodyHash' or lower(trim(candidate.title))=lower(trim(doc->>'title')))
      order by candidate.title limit 5)x;
    v:=v||jsonb_build_object('status','ready','document',doc,'contentHash',p->>'contentHash','title',doc->>'title','authors',doc->'authors','kind',doc->>'kind','publishedAt',doc->'publishedAt','completeness',doc->>'completeness','characters',length(doc->>'markdown'),'previewMarkdown',left(doc->>'markdown',12000),'previewExpiresAt',now()+interval '7 days','duplicates',matches,'quality',p->'quality');
   end if;
  elsif a='published' then
   select * into d from hs_documents where hs_documents.id=(p->>'documentId')::uuid and status='published';
   if v->>'status'<>'ingesting' or not found or d.canonical_url is distinct from v->'document'->>'canonicalUrl' then raise exception 'Published document unavailable';end if;
   v:=(v-'document'-'previewMarkdown')||jsonb_build_object('status','published','documentId',d.id);
  elsif a='failed' then v:=v||jsonb_build_object('status','failed','error',left(coalesce(p->>'error','Source unavailable'),300),'previewExpiresAt',coalesce(v->'previewExpiresAt',to_jsonb(now()+interval '7 days')));
  else raise exception 'Unknown worker operation';end if;
  v:=(v-'token'-'leaseUntil')||jsonb_build_object('updatedAt',now());
 end if;
 perform hs_state_set(jsonb_build_object('key','submission:'||id::text,'value',v));
 return v;
end $$;

-- Keep cancellation/approval and ingestion activation in one fenced transaction.
do $$begin if to_regprocedure('public.hs_ingest_before_submissions(jsonb)') is null then alter function hs_ingest(jsonb) rename to hs_ingest_before_submissions;end if;end $$;
create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare v jsonb;
begin
 if p ? 'manualSubmissionId' then
  perform 1 from hs_source_control where source_id='manual-submissions' and lease_token=(p->>'manualSourceToken')::uuid and lease_until>clock_timestamp() for update;
  if not found then raise exception 'Source lease lost' using errcode='40001';end if;
  select value into v from hs_state where key='submission:'||(p->>'manualSubmissionId') for update;
  if v is null or v->>'status'<>'ingesting' or v->>'token' is distinct from p->>'manualSubmissionToken' or v->>'contentHash' is distinct from p->>'contentHash' or v->>'approvedAt' is null or (v->>'leaseUntil')::timestamptz<=clock_timestamp() then raise exception 'Approved submission lease lost' using errcode='40001';end if;
 end if;
 return hs_ingest_before_submissions(p);
end $$;
revoke all on function hs_me_submissions(jsonb),hs_me_submission(jsonb),hs_submission_work(jsonb),hs_ingest(jsonb) from public,anon,authenticated;
grant execute on function hs_me_submissions(jsonb),hs_me_submission(jsonb) to authenticated;
grant execute on function hs_me_submissions(jsonb),hs_me_submission(jsonb),hs_submission_work(jsonb),hs_ingest(jsonb) to service_role;
commit;
