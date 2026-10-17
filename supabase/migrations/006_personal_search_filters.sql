-- Phase 3 follow-up: exact author filters and removal of unavailable saved items.
begin;
create or replace function hs_search(p jsonb) returns jsonb language sql stable set search_path=public set statement_timeout='5s' as $$
with queries as materialized (
 select ordinality as n,hs_query_group(value) as q from jsonb_array_elements(coalesce(p->'groups','[]'::jsonb)) with ordinality
), matches as (
 select c.document_id,count(distinct q.n) as matched,max(ts_rank_cd(c.fts,q.q)*(case when c.ordinal=0 then 3 else 1 end)) as rank
 from hs_chunks c join queries q on c.fts @@ q.q group by c.document_id
), eligible as (
 select d.*,s.name as source_name,coalesce(m.rank,0) as rank from hs_documents d join hs_sources s on s.id=d.source_id left join matches m on m.document_id=d.id
 where d.status='published' and ((select count(*) from queries)=0 or m.matched=(select count(*) from queries))
 and (coalesce(p->>'kind','')='' or d.kind=p->>'kind')
 and (coalesce(p->>'source','')='' or d.platform=p->>'source')
 and (coalesce(p->>'author','')='' or p->>'author'=any(d.authors))
 and (coalesce(p->>'topic','')='' or p->>'topic'=any(d.topics))
 and (coalesce(p->>'completeness','')='' or d.completeness=p->>'completeness')
 and (nullif(p->>'after','') is null or d.published_at >= (p->>'after')::date)
 and (nullif(p->>'before','') is null or d.published_at < (p->>'before')::date+interval '1 day')
), paged as (
 select * from eligible order by
 case when p->>'sort'='relevance' then rank end desc nulls last,
 case when p->>'sort'='oldest' then published_at end asc nulls last,
 case when p->>'sort'='indexed' then first_seen_at end desc nulls last,
 case when p->>'sort' in ('newest','relevance') then published_at end desc nulls last,id
 limit least(greatest(coalesce((p->>'limit')::int,20),1),50) offset (greatest(coalesce((p->>'page')::int,1),1)-1)*least(greatest(coalesce((p->>'limit')::int,20),1),50)
), cards as (
 select jsonb_build_object('id',d.id,'title',d.title,'canonical_url',d.canonical_url,'kind',d.kind,'platform',d.platform,
 'source_id',d.source_id,'source_name',d.source_name,'authors',d.authors,'topics',d.topics,'programs',d.programs,'excerpt',d.excerpt,
 'published_at',d.published_at,'first_seen_at',d.first_seen_at,'completeness',d.completeness,'rank',d.rank,
 'snippet',coalesce((select ts_headline('simple',c.body,q.q,'MaxWords=45,MinWords=20,StartSel=⟦,StopSel=⟧') from hs_chunks c join queries q on c.fts @@ q.q where c.document_id=d.id order by c.ordinal=0,c.ordinal limit 1),left(d.excerpt,280))) as card from paged d
)
select jsonb_build_object('items',coalesce((select jsonb_agg(card) from cards),'[]'::jsonb),'total',(select count(*) from eligible),'page',coalesce((p->>'page')::int,1),'limit',coalesce((p->>'limit')::int,20));
$$;
create or replace function hs_search_v2(p jsonb) returns jsonb
language plpgsql stable set search_path=public,extensions set statement_timeout='5s' as $$
declare base jsonb; lex jsonb; result jsonb; query_vector extensions.vector(384); model text; total_keywords integer;
begin
 if coalesce(p->>'mode','keyword')='keyword' or trim(coalesce(p->>'q',''))='' then
  base:=hs_search(p);
  select coalesce(jsonb_agg(item||jsonb_build_object('duplicate_count',hs_duplicate_count((item->>'id')::uuid),'match_reasons',
   case when trim(coalesce(p->>'q',''))='' then '[]'::jsonb else jsonb_build_array('Keyword or synonym match') end)),'[]') into result from jsonb_array_elements(base->'items') item;
  return base||jsonb_build_object('items',result,'mode','keyword','total_type','exact');
 end if;
 model:=p->>'modelId';
 if not exists(select 1 from hs_embedding_models where id=model and active) then raise exception 'Embedding model mismatch'; end if;
 if jsonb_array_length(p->'vector')<>384 then raise exception 'Invalid query vector'; end if;
 query_vector:=(p->'vector')::text::extensions.vector(384);
 if vector_norm(query_vector)<0.9 or vector_norm(query_vector)>1.1 then raise exception 'Query vector must be normalized'; end if;
 base:=hs_search(p||jsonb_build_object('sort','relevance','page',1,'limit',50));
 total_keywords:=(base->>'total')::int;
 lex:=base->'items';
 if total_keywords>50 then lex:=lex||(hs_search(p||jsonb_build_object('sort','relevance','page',2,'limit',50))->'items'); end if;
 if jsonb_array_length(coalesce(p->'groups','[]'))=0 then lex:='[]';total_keywords:=0;end if;
 with eligible as (
  select d.*,s.name as source_name from hs_documents d join hs_sources s on s.id=d.source_id
  where d.status='published'
  and (coalesce(p->>'kind','')='' or d.kind=p->>'kind')
  and (coalesce(p->>'source','')='' or d.platform=p->>'source')
 and (coalesce(p->>'author','')='' or p->>'author'=any(d.authors))
  and (coalesce(p->>'topic','')='' or p->>'topic'=any(d.topics))
  and (coalesce(p->>'completeness','')='' or d.completeness=p->>'completeness')
  and (nullif(p->>'after','') is null or d.published_at>=(p->>'after')::date)
  and (nullif(p->>'before','') is null or d.published_at<(p->>'before')::date+interval '1 day')
 ), semantic_scores as (
  select distinct on(e.document_id) e.document_id,e.body,1-(e.embedding<=>query_vector) as similarity
  from hs_embedding_passages e join eligible d on d.id=e.document_id and d.current_revision_id=e.revision_id
  where e.model_id=model order by e.document_id,e.embedding<=>query_vector,e.ordinal
 ), semantic as (
  select *,row_number() over(order by similarity desc,document_id) as ranking from semantic_scores where similarity>=0.25 order by similarity desc,document_id limit 100
 ), lexical as (
  select (value->>'id')::uuid as document_id,ordinality as ranking,value->>'snippet' as snippet from jsonb_array_elements(lex) with ordinality
 ), combined as (
  select coalesce(l.document_id,s.document_id) as document_id,
   coalesce(1.0/(60+l.ranking),0)+coalesce(1.0/(60+s.ranking),0) as score,
   coalesce(l.snippet,left(s.body,360)) as snippet,l.ranking as lexical_rank,s.similarity
  from lexical l full outer join semantic s on s.document_id=l.document_id
 ), grouped as (
  select c.*,d.*,row_number() over(partition by coalesce(case when e.word_count>=150 then e.body_hash end,d.id::text) order by c.score desc,d.id) as group_rank
  from combined c join eligible d on d.id=c.document_id
  left join hs_embedding_sets e on e.document_id=d.id and e.revision_id=d.current_revision_id and e.model_id=model
 ), selected as (
  select * from grouped where group_rank=1 order by score desc,id limit least(greatest(coalesce((p->>'limit')::int,20),1),50)
  offset (greatest(coalesce((p->>'page')::int,1),1)-1)*least(greatest(coalesce((p->>'limit')::int,20),1),50)
 ), cards as (
  select jsonb_build_object('id',id,'title',title,'canonical_url',canonical_url,'kind',kind,'platform',platform,'source_id',source_id,'source_name',source_name,
  'authors',authors,'topics',topics,'programs',programs,'excerpt',excerpt,'snippet',snippet,'published_at',published_at,'first_seen_at',first_seen_at,'completeness',completeness,'rank',score,
  'duplicate_count',hs_duplicate_count(id),'similarity',similarity,'match_reasons',to_jsonb(array_remove(array[
   case when lexical_rank is not null then 'Keyword or synonym match' end,
   case when similarity is not null then 'Similar meaning in an indexed passage' end],null))) as card from selected
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(card) from cards),'[]'),'total',(select count(*) from grouped where group_rank=1),'keyword_total',total_keywords,
 'page',coalesce((p->>'page')::int,1),'limit',coalesce((p->>'limit')::int,20),'mode','hybrid','total_type','ranked','candidate_limit',200) into result;
 return result;
end $$;
create or replace function hs_me_mutate(p jsonb) returns jsonb language plpgsql set search_path=public,extensions as $$
declare u uuid:=hs_require_user(); a text:=p->>'action'; doc uuid; collection uuid; v_search uuid; changed integer;
begin
 if a in ('bookmark','reading','note','collection_item') then
  doc:=(p->>'documentId')::uuid;
  -- Deleting an owned annotation must still work after a source is withdrawn.
  if ((a='bookmark' and (p->>'saved')::boolean) or (a='reading' and (p->>'read')::boolean)
    or (a='note' and trim(coalesce(p->>'body',''))<>'') or (a='collection_item' and (p->>'present')::boolean))
    and not exists(select 1 from hs_documents where id=doc and status='published') then
    raise exception 'Document unavailable' using errcode='P0002';
  end if;
 end if;
 if a='bookmark' then
  if (p->>'saved')::boolean then insert into hs_bookmarks(owner_id,document_id) values(u,doc) on conflict do nothing;
  else delete from hs_bookmarks where owner_id=u and document_id=doc;end if;
 elsif a='reading' then
  if (p->>'read')::boolean then insert into hs_reading_state(owner_id,document_id) values(u,doc) on conflict(owner_id,document_id) do update set read_at=now();
  else delete from hs_reading_state where owner_id=u and document_id=doc;end if;
 elsif a='note' then
  if trim(coalesce(p->>'body',''))='' then delete from hs_notes where owner_id=u and document_id=doc;
  else insert into hs_notes(owner_id,document_id,body) values(u,doc,p->>'body') on conflict(owner_id,document_id) do update set body=excluded.body,updated_at=now();end if;
 elsif a='collection_create' then
  insert into hs_collections(owner_id,name) values(u,trim(p->>'name')) returning id into collection;return jsonb_build_object('id',collection);
 elsif a='collection_rename' then
  update hs_collections set name=trim(p->>'name') where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Collection not found' using errcode='P0002';end if;
 elsif a='collection_delete' then
  delete from hs_collections where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Collection not found' using errcode='P0002';end if;
 elsif a='collection_item' then
  collection:=(p->>'collectionId')::uuid;
  if not exists(select 1 from hs_collections where id=collection and owner_id=u) then raise exception 'Collection not found' using errcode='P0002';end if;
  if (p->>'present')::boolean then insert into hs_collection_items(owner_id,collection_id,document_id) values(u,collection,doc) on conflict do nothing;
  else delete from hs_collection_items where owner_id=u and collection_id=collection and document_id=doc;end if;
 elsif a='search_save' then
  v_search:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
  if p ? 'id' and not exists(select 1 from hs_saved_searches where id=v_search and owner_id=u) then raise exception 'Saved search not found' using errcode='P0002';end if;
  if p ? 'id' then
   update hs_saved_searches set name=trim(p->>'name'),query_text=coalesce(p->>'queryText',''),filters=coalesce(p->'filters','{}'),groups=coalesce(p->'groups','[]'),
    mode=coalesce(p->>'mode','keyword'),query_vector=case when p->>'mode'='hybrid' then (p->'vector')::text::extensions.vector(384) else null end,
    model_id=case when p->>'mode'='hybrid' then p->>'modelId' else null end,threshold=coalesce((p->>'threshold')::real,0.6),
    include_history=coalesce((p->>'includeHistory')::boolean,false),include_updates=coalesce((p->>'includeUpdates')::boolean,false),updated_at=now(),
    last_event_id=hs_event_watermark() where id=v_search and owner_id=u;
  else
   insert into hs_saved_searches(id,owner_id,name,query_text,filters,groups,mode,query_vector,model_id,threshold,include_history,include_updates,last_event_id)
   values(v_search,u,trim(p->>'name'),coalesce(p->>'queryText',''),coalesce(p->'filters','{}'),coalesce(p->'groups','[]'),coalesce(p->>'mode','keyword'),
    case when p->>'mode'='hybrid' then (p->'vector')::text::extensions.vector(384) else null end,
    case when p->>'mode'='hybrid' then p->>'modelId' else null end,coalesce((p->>'threshold')::real,0.6),coalesce((p->>'includeHistory')::boolean,false),
    coalesce((p->>'includeUpdates')::boolean,false),hs_event_watermark());
  end if;return jsonb_build_object('id',v_search);
 elsif a='search_toggle' then
  update hs_saved_searches set enabled=(p->>'enabled')::boolean,updated_at=now() where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='search_options' then
  update hs_saved_searches set threshold=coalesce((p->>'threshold')::real,threshold),include_history=coalesce((p->>'includeHistory')::boolean,include_history),
   include_updates=coalesce((p->>'includeUpdates')::boolean,include_updates),updated_at=now() where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='search_delete' then
  delete from hs_saved_searches where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='notification_read' then
  update hs_notifications set read_at=case when (p->>'read')::boolean then now() else null end where id=(p->>'id')::uuid and owner_id=u;
 elsif a='feed_rotate' then
  v_search:=(p->>'searchId')::uuid;
  if not exists(select 1 from hs_saved_searches where id=v_search and owner_id=u) then raise exception 'Saved search not found' using errcode='P0002';end if;
  insert into hs_feed_tokens(owner_id,search_id,token_hash) values(u,v_search,p->>'tokenHash')
  on conflict(search_id) do update set token_hash=excluded.token_hash,created_at=now();
 elsif a='feed_revoke' then delete from hs_feed_tokens where search_id=(p->>'searchId')::uuid and owner_id=u;
 else raise exception 'Unknown personal operation' using errcode='22023';end if;
 return jsonb_build_object('ok',true);
end $$;
alter function public.hs_search(jsonb) set jit=off;
alter function public.hs_search_v2(jsonb) set jit=off;
-- Persist the bounded processor cursor across cron runs so later accounts are not starved.
create table if not exists hs_alert_runner_state(singleton boolean primary key default true check(singleton),after_search_id uuid);
insert into hs_alert_runner_state(singleton) values(true) on conflict do nothing;
alter table hs_alert_runner_state enable row level security;
revoke all on hs_alert_runner_state from public,anon,authenticated;
grant all on hs_alert_runner_state to service_role;
create or replace function hs_alert_run(p jsonb default '{}') returns jsonb
language plpgsql set search_path=public,extensions set jit=off as $$
declare s hs_saved_searches; e hs_publication_events; decision text; n integer; created integer:=0; checked integer:=0; searches integer:=0; invalid_searches integer:=0; last_search uuid; event_max bigint; v_after uuid;
begin
 -- Serialize processors; retries cannot race notification deduplication or watermarks.
 if not pg_try_advisory_xact_lock(817263510) then return jsonb_build_object('busy',true,'created',0);end if;
 select after_search_id into v_after from hs_alert_runner_state where singleton;
 for s in select * from hs_saved_searches where enabled and (v_after is null or id>v_after) order by id limit 25 loop
  searches:=searches+1;last_search:=s.id;event_max:=s.last_event_id;
  begin
  for e in select ev.* from hs_publication_events ev where ev.id in (
   (select id from hs_publication_events where id>s.last_event_id order by id limit 40)
   union
   (select w.event_id from hs_alert_pending w join hs_publication_events pending_event on pending_event.id=w.event_id
    where w.search_id=s.id order by exists(select 1 from hs_embedding_sets x where x.document_id=pending_event.document_id and x.revision_id=pending_event.revision_id and x.model_id=s.model_id) desc,w.event_id limit 10)
  ) order by ev.id loop
   checked:=checked+1;decision:=hs_event_matches(s,e);event_max:=greatest(event_max,e.id);
   if decision='pending' then insert into hs_alert_pending(search_id,event_id) values(s.id,e.id) on conflict do nothing;
   else
    delete from hs_alert_pending where search_id=s.id and event_id=e.id;
    if decision<>'skip' then
     insert into hs_notifications(owner_id,search_id,document_id,revision_id,kind,reason) values(s.owner_id,s.id,e.document_id,e.revision_id,e.kind,decision) on conflict do nothing;
     get diagnostics n=row_count;created:=created+n;
    end if;
   end if;
  end loop;
  update hs_saved_searches set last_event_id=event_max where id=s.id;
  exception when data_exception then
   -- Direct writes to an owned row can bypass API validation. Isolate bad data to its owner.
   update hs_saved_searches set enabled=false,updated_at=now() where id=s.id;
   invalid_searches:=invalid_searches+1;
  end;
 end loop;
 update hs_alert_runner_state set after_search_id=case when searches=25 then last_search else null end where singleton;
 return jsonb_build_object('processedSearches',searches,'checkedEvents',checked,'created',created,'invalidSearches',invalid_searches,'afterSearchId',case when searches=25 then last_search else null end);
end $$;

create or replace function hs_phase3_status(p jsonb default '{}') returns jsonb language sql stable as $$select jsonb_build_object('phase',3,'schemaVersion',6);$$;
-- Revision updates are governed by include_updates. History suppression applies to first publication.
create or replace function hs_record_publication() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.current_revision_id is not null and new.current_revision_id is distinct from old.current_revision_id and new.status='published' then
  insert into hs_publication_events(document_id,revision_id,kind,historical)
  values(new.id,new.current_revision_id,case when old.current_revision_id is null then 'published' else 'updated' end,
   old.current_revision_id is null and (new.published_at is null or new.published_at < now()-interval '7 days')) on conflict do nothing;
 end if; return new;
end $$;
commit;
