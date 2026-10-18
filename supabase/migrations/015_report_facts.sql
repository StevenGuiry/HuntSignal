-- Public report outcomes live in backed-up hs_state, independently of text revisions.
begin;
create or replace function hs_report_facts_candidates(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (
  select d.id,d.canonical_url as url from hs_documents d
  left join hs_state st on st.key='report-facts-check:'||d.id::text
  where d.kind='report' and d.status='published'
  and d.canonical_url ~ '^https://(hackerone\.com/reports/[0-9]+/?|bugcrowd\.com/disclosures/[^?#]+)$'
  and (st.key is null or (st.value->>'nextAttemptAt')::timestamptz<=now())
  order by st.updated_at asc nulls first,d.published_at desc nulls last,d.id
  limit least(100,greatest(1,coalesce((p->>'limit')::integer,25)))
 )x;
$$;

create or replace function hs_report_facts_put(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare doc hs_documents; f jsonb:=p->'facts'; old jsonb; checked timestamptz;
begin
 select * into doc from hs_documents where id=(p->>'id')::uuid and kind='report' and status='published';
 if not found then raise exception 'Report unavailable';end if;
 perform pg_advisory_xact_lock(hashtextextended('report-facts:'||doc.id::text,0));
 if f is not null and f<>'null'::jsonb then
  if jsonb_typeof(f)<>'object' or f->>'sourceUrl' is distinct from doc.canonical_url
   or f->>'sourceUrl' !~ '^https://(hackerone\.com/reports/[0-9]+/?|bugcrowd\.com/disclosures/[^?#]+)$'
   or not (f ?& array['bountyAmount','currency','bountyDisplay','severity','priority','severityFinal','outcome','checkedAt'])
   or (f->'bountyAmount'<>'null'::jsonb and (jsonb_typeof(f->'bountyAmount')<>'number' or (f->>'bountyAmount')::numeric<0 or (f->>'bountyAmount')::numeric>1e12))
   or (f->'currency'<>'null'::jsonb and (f->>'currency') !~ '^[A-Z]{3}$')
   or (f->'severity'<>'null'::jsonb and f->>'severity' not in ('critical','high','medium','low','informational','none'))
   or (f->'priority'<>'null'::jsonb and f->>'priority' not in ('P1','P2','P3','P4','P5'))
   or jsonb_typeof(f->'severityFinal')<>'boolean'
   or length(coalesce(f->>'bountyDisplay',''))>120 or length(coalesce(f->>'outcome',''))>80
   or nullif(f->>'checkedAt','') is null
  then raise exception 'Invalid public report facts';end if;
  checked:=(f->>'checkedAt')::timestamptz;
  if checked>now()+interval '5 minutes' then raise exception 'Invalid check time';end if;
  select value into old from hs_state where key='report-facts:'||doc.id::text;
  if old is not null and (old->>'checkedAt')::timestamptz>=checked then return jsonb_build_object('state','stale');end if;
  -- Explicit allowlist prevents accidental retention of unrelated source response fields.
  select jsonb_object_agg(key,value) into f from jsonb_each(f) where key=any(array['bountyAmount','currency','bountyDisplay','severity','priority','severityFinal','outcome','sourceUrl','checkedAt']);
  perform hs_state_set(jsonb_build_object('key','report-facts:'||doc.id::text,'value',f));
 end if;
 perform hs_state_set(jsonb_build_object('key','report-facts-check:'||doc.id::text,'value',jsonb_build_object('nextAttemptAt',now()+interval '1 day','state',case when f is null or f='null'::jsonb then 'retry' else 'checked' end)));
 return jsonb_build_object('state',case when f is null or f='null'::jsonb then 'retry' else 'checked' end);
end $$;
revoke all on function hs_report_facts_candidates(jsonb),hs_report_facts_put(jsonb) from public,anon,authenticated;
grant execute on function hs_report_facts_candidates(jsonb),hs_report_facts_put(jsonb) to service_role;

create or replace function hs_detail(p jsonb) returns jsonb language sql stable set search_path=public as $$
 select to_jsonb(d)||jsonb_build_object('source_name',s.name,'source_url',s.url,'object_path',r.object_path,'content_hash',r.content_hash,'fetched_at',r.fetched_at,'revision_count',(select count(*) from hs_revisions where document_id=d.id),
 'report_facts',case when d.kind='report' then (select value from hs_state where key='report-facts:'||d.id::text) else null end)
 from hs_documents d join hs_sources s on s.id=d.source_id join hs_revisions r on r.id=d.current_revision_id where d.id=(p->>'id')::uuid and d.status='published';
$$;
commit;
