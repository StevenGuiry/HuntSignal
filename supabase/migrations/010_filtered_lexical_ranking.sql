-- Rank only documents that satisfy every query group and filter.
-- This preserves scores/order while avoiding expensive ranking of discarded chunks.
begin;
create or replace function hs_search(p jsonb) returns jsonb language sql stable set search_path=public set statement_timeout='5s' as $$
with queries as materialized (
 select ordinality as n,hs_query_group(value) as q from jsonb_array_elements(coalesce(p->'groups','[]'::jsonb)) with ordinality
), matches as (
 select c.document_id,count(distinct q.n) as matched
 from hs_chunks c join queries q on c.fts @@ q.q group by c.document_id
), eligible as (
 select d.*,s.name as source_name from hs_documents d join hs_sources s on s.id=d.source_id left join matches m on m.document_id=d.id
 where d.status='published' and ((select count(*) from queries)=0 or m.matched=(select count(*) from queries))
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
 'snippet',coalesce((select ts_headline('simple',c.body,q.q,'MaxWords=45,MinWords=20,StartSel=⟦,StopSel=⟧') from hs_chunks c join queries q on c.fts @@ q.q where c.document_id=d.id order by c.ordinal=0,c.ordinal limit 1),left(d.excerpt,280))) as card from paged d
)
select jsonb_build_object('items',coalesce((select jsonb_agg(card) from cards),'[]'::jsonb),'total',(select count(*) from eligible),'page',coalesce((p->>'page')::int,1),'limit',coalesce((p->>'limit')::int,20));
$$;


alter function public.hs_search(jsonb) set jit=off;
commit;
