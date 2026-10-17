-- Phase 2: additive, transactional, and safe to apply to the existing archive.
begin;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table if not exists hs_embedding_models (
 id text primary key, revision text not null, dimensions integer not null, active boolean not null default false
);
insert into hs_embedding_models(id,revision,dimensions,active)
values('minilm-l6-q8-751bff3-v1','751bff37182d3f1213fa05d7196b954e230abad9',384,true) on conflict(id) do nothing;
create table if not exists hs_embedding_sets (
 document_id uuid not null references hs_documents(id) on delete cascade,
 model_id text not null references hs_embedding_models(id),
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 centroid extensions.vector(384) not null, passage_count integer not null,
 body_hash text, word_count integer not null default 0, indexed_at timestamptz not null default now(),
 primary key(document_id,model_id)
);
create table if not exists hs_embedding_passages (
 document_id uuid not null references hs_documents(id) on delete cascade,
 model_id text not null references hs_embedding_models(id),
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 ordinal integer not null, body text not null, section_heading text not null default '',
 embedding extensions.vector(384) not null,
 primary key(document_id,model_id,ordinal)
);
create index if not exists hs_embedding_sets_body on hs_embedding_sets(body_hash) where body_hash is not null;
create table if not exists hs_citations (
 document_id uuid not null references hs_documents(id) on delete cascade,
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 target_url text not null, primary key(document_id,target_url)
);

create or replace function hs_phase2_status(p jsonb default '{}') returns jsonb
language sql stable set search_path=public,extensions as $$
 select jsonb_build_object('phase',2,'model_id',m.id,'dimensions',m.dimensions,
 'indexed_documents',(select count(*) from hs_embedding_sets e join hs_documents d on d.id=e.document_id and d.current_revision_id=e.revision_id where d.status='published' and e.model_id=m.id),
 'total_documents',(select count(*) from hs_documents where status='published'),
 'database_bytes',pg_database_size(current_database())) from hs_embedding_models m where m.active limit 1;
$$;

create or replace function hs_index_pending(p jsonb) returns jsonb
language sql stable set search_path=public,extensions as $$
 select coalesce(jsonb_agg(x),'[]') from (
 select d.*,r.object_path from hs_documents d join hs_revisions r on r.id=d.current_revision_id
 where d.status='published' and not exists(select 1 from hs_embedding_sets e where e.document_id=d.id and e.revision_id=d.current_revision_id and e.model_id=p->>'model_id')
 order by d.first_seen_at,d.id limit least(greatest(coalesce((p->>'limit')::int,20),1),100)
 ) x;
$$;

create or replace function hs_index_put(p jsonb) returns jsonb
language plpgsql set search_path=public,extensions as $$
declare doc uuid:=(p->>'document_id')::uuid; rev uuid:=(p->>'revision_id')::uuid; model text:=p->>'model_id'; current_rev uuid; n integer;
begin
 select current_revision_id into current_rev from hs_documents where id=doc and status='published' for update;
 if current_rev is null or current_rev<>rev then return jsonb_build_object('status','stale'); end if;
 if not exists(select 1 from hs_embedding_models where id=model and active) then raise exception 'Unknown embedding model'; end if;
 n:=jsonb_array_length(p->'passages');
 if n is null or n<1 or n>512 then raise exception 'Passage count must be between 1 and 512'; end if;
 delete from hs_embedding_passages where document_id=doc and model_id=model;
 insert into hs_embedding_passages(document_id,model_id,revision_id,ordinal,body,section_heading,embedding)
 select doc,model,rev,(ordinality-1)::int,left(value->>'text',6000),left(coalesce(value->>'heading',''),300),(value->'vector')::text::extensions.vector(384)
 from jsonb_array_elements(p->'passages') with ordinality;
 insert into hs_embedding_sets(document_id,model_id,revision_id,centroid,passage_count,body_hash,word_count)
 select doc,model,rev,avg(embedding),n,case when p->>'body_hash' ~ '^[a-f0-9]{64}$' then p->>'body_hash' else null end,coalesce((p->>'word_count')::int,0)
 from hs_embedding_passages where document_id=doc and model_id=model
 on conflict(document_id,model_id) do update set revision_id=excluded.revision_id,centroid=excluded.centroid,passage_count=excluded.passage_count,body_hash=excluded.body_hash,word_count=excluded.word_count,indexed_at=now();
 delete from hs_citations where document_id=doc;
 insert into hs_citations(document_id,revision_id,target_url)
 select doc,rev,left(value,2048) from jsonb_array_elements_text(coalesce(p->'citations','[]')) as t(value)
 where value ~ '^https?://' and length(value)<=2048 limit 200 on conflict do nothing;
 return jsonb_build_object('status','indexed','passages',n);
end $$;

create or replace function hs_duplicate_count(doc uuid) returns integer
language sql stable set search_path=public,extensions as $$
 select count(distinct other.id)::int from hs_embedding_sets anchor
 join hs_documents a on a.id=anchor.document_id and a.current_revision_id=anchor.revision_id
 join hs_embedding_sets e on e.body_hash=anchor.body_hash and e.model_id=anchor.model_id
 join hs_documents other on other.id=e.document_id and other.current_revision_id=e.revision_id
 where a.id=doc and a.status='published' and other.status='published' and other.id<>a.id and anchor.word_count>=150 and e.word_count>=150;
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

create or replace function hs_related(p jsonb) returns jsonb
language sql stable set search_path=public,extensions set statement_timeout='5s' as $$
 with anchor as (
  select d.*,e.centroid,e.body_hash,e.word_count,e.model_id from hs_documents d left join hs_embedding_sets e on e.document_id=d.id and e.revision_id=d.current_revision_id
  where d.id=(p->>'id')::uuid and d.status='published'
 ), candidates as (
  select d.*,a.canonical_url as anchor_url,e.centroid,e.body_hash,e.word_count,
  case when a.body_hash=e.body_hash and a.word_count>=150 and e.word_count>=150 then 4
       when exists(select 1 from hs_citations c where c.document_id=a.id and c.revision_id=a.current_revision_id and c.target_url=d.canonical_url) then 3
       when exists(select 1 from hs_citations c where c.document_id=d.id and c.revision_id=d.current_revision_id and c.target_url=a.canonical_url) then 2 else 1 end as priority,
  case when a.centroid is not null and e.centroid is not null then 1-(a.centroid<=>e.centroid) else 0 end as score,
  array(select unnest(d.topics) intersect select unnest(a.topics)) as shared_topics
  from anchor a cross join hs_documents d left join hs_embedding_sets e on e.document_id=d.id and e.revision_id=d.current_revision_id and e.model_id=a.model_id
  where d.status='published' and d.id<>a.id
 ), chosen as (
  select * from candidates where priority>1 or score>=0.35 or cardinality(shared_topics)>0 order by priority desc,score desc,cardinality(shared_topics) desc,id limit 12
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'canonical_url',canonical_url,'platform',platform,'kind',kind,'completeness',completeness,
 'relation',case priority when 4 then 'duplicate' when 3 then 'cites' when 2 then 'cited_by' else 'related' end,
 'reason',case priority when 4 then 'Identical archived text; both sources retained' when 3 then 'Linked in this archived article' when 2 then 'Links to this article' else 'Shared topic or similar meaning' end,
 'topics',shared_topics,'score',score)) from chosen),'[]'),
 'citations',coalesce((select jsonb_agg(c.target_url) from hs_citations c join hs_documents d on d.id=c.document_id and d.current_revision_id=c.revision_id where d.id=(p->>'id')::uuid and d.status='published'),'[]'));
$$;

create or replace function hs_duplicate_candidates(p jsonb default '{}') returns jsonb
language sql stable set search_path=public,extensions set statement_timeout='5s' as $$
 select coalesce(jsonb_agg(x),'[]') from (
 select a.id as left_id,a.title as left_title,a.canonical_url as left_url,b.id as right_id,b.title as right_title,b.canonical_url as right_url,
 case when ea.body_hash=eb.body_hash and ea.word_count>=150 and eb.word_count>=150 then 'exact' else 'suggested' end as status,
 similarity(a.title,b.title) as title_similarity,1-(ea.centroid<=>eb.centroid) as semantic_similarity
 from hs_documents a join hs_embedding_sets ea on ea.document_id=a.id and ea.revision_id=a.current_revision_id
 join hs_documents b on a.id<b.id join hs_embedding_sets eb on eb.document_id=b.id and eb.revision_id=b.current_revision_id and ea.model_id=eb.model_id
 where a.status='published' and b.status='published' and
 ((ea.body_hash=eb.body_hash and ea.word_count>=150 and eb.word_count>=150) or
 (similarity(a.title,b.title)>=0.7 and 1-(ea.centroid<=>eb.centroid)>=0.85))
 order by status,title_similarity desc,left_id,right_id limit 30
 ) x;
$$;

create or replace function hs_topic_summary(p jsonb) returns jsonb
language sql stable set search_path=public,extensions as $$
 select jsonb_build_object('total',count(*),'reports',count(*) filter(where kind='report'),'research',count(*) filter(where kind<>'report'),'full',count(*) filter(where completeness='full'))
 from hs_documents where status='published' and p->>'topic'=any(topics);
$$;

-- New RPCs/tables must not inherit public execution or read access.
do $$ declare obj record; begin
 for obj in select tablename from pg_tables where schemaname='public' and tablename like 'hs\_%' escape '\' loop
  execute format('alter table public.%I enable row level security',obj.tablename);
  execute format('revoke all on table public.%I from public',obj.tablename);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on table public.%I from anon, authenticated',obj.tablename);end if;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant all on table public.%I to service_role',obj.tablename);end if;
 end loop;
 for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hs\_%' escape '\' loop
  execute format('revoke all on function %s from public',obj.signature);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on function %s from anon, authenticated',obj.signature);end if;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role',obj.signature);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant usage on schema extensions to service_role;end if;
end $$;
commit;
