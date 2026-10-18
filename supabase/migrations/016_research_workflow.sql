-- Filters share one predicate across lexical, semantic and saved-search matching.
begin;
create or replace function hs_content_quality(d hs_documents) returns jsonb language sql stable set search_path=public as $$
 select value-'revisionId' from hs_state where key='quality:'||d.id::text and value->>'revisionId'=d.current_revision_id::text;
$$;
create or replace function hs_research_matches(d hs_documents,p jsonb) returns boolean language plpgsql stable set search_path=public as $$
declare f jsonb; q jsonb; amount numeric; disclosed boolean;
begin
 if nullif(p->>'program','') is not null and not p->>'program'=any(d.programs) then return false;end if;
 q:=hs_content_quality(d);
 if p->>'completeness'='full' and coalesce(q->'issues','[]') ?| array['possible_truncation','navigation_text'] then return false;end if;
 if coalesce(p->>'severity','')='' and coalesce(p->>'bounty','')='' and coalesce(p->>'currency','')='' and nullif(p->>'bountyMin','') is null and nullif(p->>'bountyMax','') is null then return true;end if;
 if d.kind<>'report' then return false;end if;
 select value into f from hs_state where key='report-facts:'||d.id::text;
 if f is null then return false;end if;
 if nullif(p->>'severity','') is not null then
  if p->>'severity'='high-critical' then if coalesce(f->>'severity','') not in ('high','critical') then return false;end if;
  elsif f->>'severity' is distinct from p->>'severity' then return false;end if;
 end if;
 disclosed:=nullif(f->>'bountyAmount','') is not null or nullif(f->>'bountyDisplay','') is not null;
 if (p->>'bounty'='disclosed' and not disclosed) or (p->>'bounty'='undisclosed' and disclosed) then return false;end if;
 if nullif(p->>'currency','') is not null and f->>'currency' is distinct from p->>'currency' then return false;end if;
 if nullif(p->>'bountyMin','') is not null or nullif(p->>'bountyMax','') is not null then
  if nullif(p->>'currency','') is null or nullif(f->>'bountyAmount','') is null then return false;end if;
  amount:=(f->>'bountyAmount')::numeric;
  if amount<coalesce(nullif(p->>'bountyMin','')::numeric,0) or amount>coalesce(nullif(p->>'bountyMax','')::numeric,1e12) then return false;end if;
 end if;
 return true;
end $$;
create or replace function hs_research_card(id uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('report_facts',case when d.kind='report' then (select value from hs_state where key='report-facts:'||d.id::text) else null end,'content_quality',hs_content_quality(d)) from hs_documents d where d.id=$1 and d.status='published';
$$;
create or replace function hs_search_facets(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('programs',(select coalesce(jsonb_agg(x),'[]') from (select program,count(*) as count from hs_documents d cross join lateral unnest(d.programs) program where d.status='published' group by program order by count(*) desc,program limit 500)x),
 'currencies',(select coalesce(jsonb_agg(currency order by currency),'[]') from (select distinct st.value->>'currency' as currency from hs_documents d join hs_state st on st.key='report-facts:'||d.id::text where d.status='published' and st.value->>'currency' ~ '^[A-Z]{3}$')x));
$$;

-- Quality reviews are revision-bound and already covered by hs_state backups.
create or replace function hs_quality_candidates(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (
 select d.id,d.current_revision_id as revision_id,r.object_path,
 jsonb_build_object('sourceId',d.source_id,'sourceName',s.name,'sourceUrl',s.url,'externalId',d.external_id,'canonicalUrl',d.canonical_url,'title',d.title,'kind',d.kind,'platform',d.platform,'authors',d.authors,'topics',d.topics,'programs',d.programs,'excerpt',d.excerpt,'publishedAt',d.published_at,'completeness',d.completeness,'license',d.license,'licenseUrl',d.license_url,'attribution',d.attribution,'rightsEvidence',d.rights_evidence,'canArchive',true,'revision',r.source_revision) as document
 from hs_documents d join hs_sources s on s.id=d.source_id join hs_revisions r on r.id=d.current_revision_id
 left join hs_state st on st.key='quality:'||d.id::text
 where d.status='published' and (st.value->>'revisionId' is distinct from d.current_revision_id::text or st.value->>'version' is distinct from p->>'version')
 order by d.id limit least(500,greatest(1,coalesce((p->>'limit')::integer,100)))
 )x;
$$;
create or replace function hs_quality_put(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare d hs_documents; q jsonb:=p->'quality';
begin
 select * into d from hs_documents where id=(p->>'id')::uuid for update;
 if d.status<>'published' or d.current_revision_id::text is distinct from p->>'revisionId' then return jsonb_build_object('stale',true);end if;
 if q->>'version'<>'quality-v1' or jsonb_typeof(q->'issues')<>'array' or jsonb_array_length(q->'issues')>3 or exists(select 1 from jsonb_array_elements_text(q->'issues') x where x not in ('duplicate_sections','possible_truncation','navigation_text')) then raise exception 'Invalid quality report';end if;
 perform hs_state_set(jsonb_build_object('key','quality:'||d.id::text,'value',q||jsonb_build_object('revisionId',d.current_revision_id)));
 if jsonb_array_length(q->'issues')>0 then perform hs_ops_review(jsonb_build_object('sourceId',d.source_id,'documentId',d.id,'kind','quality','detail','Extraction checks: '||(q->'issues')::text));end if;
 return jsonb_build_object('stale',false);
end $$;

create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
begin
 if p->>'completeness'<>'metadata' and length(trim(coalesce(p->>'markdown','')))<80 then raise exception 'Substantive archived text is required';end if;
 if p ? 'expectedRevisionId' then
  perform pg_advisory_xact_lock(hashtextextended(p->>'canonicalUrl',0));
  if not exists(select 1 from hs_documents where canonical_url=p->>'canonicalUrl' and current_revision_id::text=p->>'expectedRevisionId') then raise exception 'Revision changed during quality repair' using errcode='40001';end if;
 end if;
 return hs_ingest_with_precedence(p);
end $$;

create or replace function hs_detail(p jsonb) returns jsonb language sql stable set search_path=public as $$
 select to_jsonb(d)||jsonb_build_object('source_name',s.name,'source_url',s.url,'object_path',r.object_path,'content_hash',r.content_hash,'fetched_at',r.fetched_at,'revision_count',(select count(*) from hs_revisions where document_id=d.id))||hs_research_card(d.id)
 from hs_documents d join hs_sources s on s.id=d.source_id join hs_revisions r on r.id=d.current_revision_id where d.id=(p->>'id')::uuid and d.status='published';
$$;


create or replace function hs_search(p jsonb) returns jsonb language sql stable set search_path=public set statement_timeout='5s' as $$
with queries as materialized (
 select ordinality as n,hs_query_group(value) as q from jsonb_array_elements(coalesce(p->'groups','[]'::jsonb)) with ordinality
), matches as (
 select c.document_id,count(distinct q.n) as matched
 from hs_chunks c join queries q on c.fts @@ q.q group by c.document_id
), eligible as (
 select d.*,s.name as source_name from hs_documents d join hs_sources s on s.id=d.source_id left join matches m on m.document_id=d.id
 where d.status='published' and hs_research_matches(d,p) and ((select count(*) from queries)=0 or m.matched=(select count(*) from queries))
 and (coalesce(p->>'sort','')<>'updated' or (select count(*) from hs_revisions where document_id=d.id)>1)
 and (coalesce(p->>'kind','')='' or d.kind=p->>'kind')
 and (coalesce(p->>'source','')='' or d.platform=p->>'source')
 and (coalesce(p->>'author','')='' or p->>'author'=any(d.authors))
 and (coalesce(p->>'topic','')='' or p->>'topic'=any(d.topics))
 and (coalesce(p->>'completeness','')='' or d.completeness=p->>'completeness')
 and (nullif(p->>'after','') is null or d.published_at >= (p->>'after')::date)
 and (nullif(p->>'before','') is null or d.published_at < (p->>'before')::date+interval '1 day')
), ranked as materialized (
 select d.*,case when (select count(*) from queries)=0 then 0 else coalesce((
  select max(ts_rank_cd(c.fts,q.q)*(case when c.ordinal=0 then 3 else 1 end))
  from hs_chunks c join queries q on c.fts @@ q.q where c.document_id=d.id
 ),0) end as rank from eligible d
), paged as (
 select * from ranked order by
 case when p->>'sort'='relevance' then rank end desc nulls last,
 case when p->>'sort'='oldest' then published_at end asc nulls last,
 case when p->>'sort'='indexed' then first_seen_at end desc nulls last,
 case when p->>'sort'='updated' then updated_at end desc nulls last,
 case when p->>'sort' in ('newest','relevance') then published_at end desc nulls last,id
 limit least(greatest(coalesce((p->>'limit')::int,20),1),50) offset (greatest(coalesce((p->>'page')::int,1),1)-1)*least(greatest(coalesce((p->>'limit')::int,20),1),50)
), cards as (
 select jsonb_build_object('id',d.id,'title',d.title,'canonical_url',d.canonical_url,'kind',d.kind,'platform',d.platform,
 'source_id',d.source_id,'source_name',d.source_name,'authors',d.authors,'topics',d.topics,'programs',d.programs,'excerpt',d.excerpt,
 'published_at',d.published_at,'first_seen_at',d.first_seen_at,'completeness',d.completeness,'rank',d.rank,
 'snippet',coalesce((select ts_headline('simple',c.body,q.q,'MaxWords=45,MinWords=20,StartSel=⟦,StopSel=⟧') from hs_chunks c join queries q on c.fts @@ q.q where c.document_id=d.id order by c.ordinal=0,c.ordinal limit 1),left(d.excerpt,280))) ||hs_research_card(d.id) as card from paged d
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
  where d.status='published' and hs_research_matches(d,p)
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
   case when similarity is not null then 'Similar meaning in an indexed passage' end],null))) ||hs_research_card(id) as card from selected
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(card) from cards),'[]'),'total',(select count(*) from grouped where group_rank=1),'keyword_total',total_keywords,
 'page',coalesce((p->>'page')::int,1),'limit',coalesce((p->>'limit')::int,20),'mode','hybrid','total_type','ranked','candidate_limit',200) into result;
 return result;
end $$;
create or replace function hs_event_matches(s hs_saved_searches,e hs_publication_events) returns text
language plpgsql stable set search_path=public,extensions set jit=off as $$
declare d hs_documents; keyword_match boolean; score real;
begin
 select * into d from hs_documents where id=e.document_id and status='published' and current_revision_id=e.revision_id;
 if not found then return 'skip';end if;
 if e.historical and not s.include_history then return 'skip';end if;
 if e.kind='updated' and not s.include_updates then return 'skip';end if;
 if (coalesce(s.filters->>'kind','')<>'' and d.kind<>s.filters->>'kind')
 or (coalesce(s.filters->>'source','')<>'' and d.platform<>s.filters->>'source')
 or (coalesce(s.filters->>'topic','')<>'' and not s.filters->>'topic'=any(d.topics))
 or (coalesce(s.filters->>'author','')<>'' and not s.filters->>'author'=any(d.authors))
 or (coalesce(s.filters->>'completeness','')<>'' and d.completeness<>s.filters->>'completeness')
 or (nullif(s.filters->>'after','') is not null and (d.published_at is null or d.published_at<(s.filters->>'after')::date))
 or (nullif(s.filters->>'before','') is not null and (d.published_at is null or d.published_at>=(s.filters->>'before')::date+interval '1 day')) then return 'skip';end if;
 -- A newly published report can precede its first outcomes refresh. Keep it pending.
 if (nullif(s.filters->>'severity','') is not null or nullif(s.filters->>'bounty','') is not null or nullif(s.filters->>'currency','') is not null or nullif(s.filters->>'bountyMin','') is not null or nullif(s.filters->>'bountyMax','') is not null)
 and d.kind='report' and d.canonical_url ~ '^https://(hackerone\.com/reports/[0-9]+/?|bugcrowd\.com/disclosures/[^?#]+)$'
 and not exists(select 1 from hs_state where key='report-facts:'||d.id::text) and e.created_at>now()-interval '7 days' then return 'pending';end if;
 if not hs_research_matches(d,s.filters) then return 'skip';end if;
 if jsonb_array_length(s.groups)=0 then keyword_match:=s.filters<>'{}';
 else select not exists(select 1 from jsonb_array_elements(s.groups) as g(value) where not exists(select 1 from hs_chunks c where c.document_id=d.id and c.fts @@ hs_query_group(g.value))) into keyword_match;end if;
 if keyword_match then return 'Keyword or followed-filter match';end if;
 if s.mode='hybrid' then
  if not exists(select 1 from hs_embedding_sets x where x.document_id=d.id and x.revision_id=d.current_revision_id and x.model_id=s.model_id) then return 'pending';end if;
  select max(1-(embedding<=>s.query_vector)) into score from hs_embedding_passages where document_id=d.id and revision_id=d.current_revision_id and model_id=s.model_id;
  if score>=s.threshold then return 'Semantic match';end if;
 end if;return 'skip';
end $$;
alter function hs_search(jsonb) set jit=off;
alter function hs_search_v2(jsonb) set jit=off;
revoke all on function hs_content_quality(hs_documents),hs_research_matches(hs_documents,jsonb),hs_research_card(uuid),hs_search_facets(jsonb),hs_quality_candidates(jsonb),hs_quality_put(jsonb) from public,anon,authenticated;
grant execute on function hs_content_quality(hs_documents),hs_research_matches(hs_documents,jsonb),hs_research_card(uuid),hs_search_facets(jsonb),hs_quality_candidates(jsonb),hs_quality_put(jsonb) to service_role;
commit;
