create table if not exists hs_sources (
 id text primary key, name text not null, url text not null, last_success_at timestamptz,
 status text not null default 'ready', detail text not null default ''
);
create table if not exists hs_documents (
 id uuid primary key default gen_random_uuid(), source_id text not null references hs_sources(id),
 external_id text not null, canonical_url text not null unique, title text not null,
 kind text not null check(kind in ('report','article','paper')), platform text not null,
 authors text[] not null default '{}', topics text[] not null default '{}', programs text[] not null default '{}',
 excerpt text not null default '', published_at timestamptz, first_seen_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), completeness text not null check(completeness in ('full','partial','metadata')),
 license text not null, license_url text, attribution text not null, rights_evidence text not null,
 current_revision_id uuid, status text not null default 'published' check(status in ('published','withdrawn')),
 unique(source_id,external_id)
);
create table if not exists hs_revisions (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references hs_documents(id) on delete cascade,
 content_hash text not null, object_path text not null, fetched_at timestamptz not null default now(),
 source_revision text, unique(document_id,content_hash)
);
create table if not exists hs_chunks (
 id bigint generated always as identity primary key, document_id uuid not null references hs_documents(id) on delete cascade,
 ordinal integer not null, body text not null,
 fts tsvector generated always as (to_tsvector('simple',body)) stored,
 unique(document_id,ordinal)
);
create index if not exists hs_chunks_fts on hs_chunks using gin(fts);
create index if not exists hs_documents_topics on hs_documents using gin(topics);
create index if not exists hs_documents_date on hs_documents(published_at desc,id);
create table if not exists hs_runs (
 id uuid primary key default gen_random_uuid(), source_id text not null, started_at timestamptz not null default now(),
 finished_at timestamptz, status text not null default 'running', processed integer not null default 0,
 inserted integer not null default 0, updated integer not null default 0, failed integer not null default 0,
 detail text not null default ''
);
create table if not exists hs_jobs (
 source_id text not null, external_id text not null, status text not null default 'pending',
 attempts integer not null default 0, lease_until timestamptz, next_attempt_at timestamptz not null default now(),
 last_error text, updated_at timestamptz not null default now(), primary key(source_id,external_id)
);
create table if not exists hs_state (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

create or replace function hs_ingest(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare d uuid; r uuid; old_hash text; is_new boolean; chunks jsonb; result text;
begin
 if p->>'completeness'='full' and (not coalesce((p->>'canArchive')::boolean,false) or length(p->>'markdown')<80) then raise exception 'Full text requires archival permission'; end if;
 if not coalesce((p->>'canArchive')::boolean,false) and length(coalesce(p->>'markdown',''))>0 then raise exception 'Body is not permitted'; end if;
 insert into hs_sources(id,name,url) values(p->>'sourceId',p->>'sourceName',p->>'sourceUrl') on conflict(id) do update set name=excluded.name,url=excluded.url;
 select id into d from hs_documents where canonical_url=p->>'canonicalUrl';
 is_new := d is null;
 if d is null then
  insert into hs_documents(source_id,external_id,canonical_url,title,kind,platform,completeness,license,attribution,rights_evidence)
  values(p->>'sourceId',p->>'externalId',p->>'canonicalUrl',p->>'title',p->>'kind',p->>'platform',p->>'completeness',p->>'license',p->>'attribution',p->>'rightsEvidence') returning id into d;
 end if;
 perform 1 from hs_documents where id=d for update;
 select content_hash into old_hash from hs_revisions where id=(select current_revision_id from hs_documents where id=d);
 -- A failed extraction cannot downgrade a previously complete archive.
 if (select completeness from hs_documents where id=d)='full' and p->>'completeness'<>'full' and not is_new then
  return jsonb_build_object('id',d,'action','preserved');
 end if;
 if old_hash = p->>'contentHash' then return jsonb_build_object('id',d,'action','unchanged'); end if;
 insert into hs_revisions(document_id,content_hash,object_path,source_revision)
 values(d,p->>'contentHash',p->>'objectPath',p->>'revision') on conflict(document_id,content_hash) do update set object_path=excluded.object_path returning id into r;
 update hs_documents set title=p->>'title',kind=p->>'kind',platform=p->>'platform',
 authors=array(select jsonb_array_elements_text(p->'authors')),topics=array(select jsonb_array_elements_text(p->'topics')),
 programs=array(select jsonb_array_elements_text(p->'programs')),excerpt=p->>'excerpt',published_at=nullif(p->>'publishedAt','')::timestamptz,
 completeness=p->>'completeness',license=p->>'license',license_url=p->>'licenseUrl',attribution=p->>'attribution',
 rights_evidence=p->>'rightsEvidence',current_revision_id=r,updated_at=now() where id=d;
 delete from hs_chunks where document_id=d;
 insert into hs_chunks(document_id,ordinal,body) select d,(ordinality-1)::integer,value from jsonb_array_elements_text(p->'chunks') with ordinality;
 result := case when is_new then 'inserted' else 'updated' end;
 return jsonb_build_object('id',d,'action',result);
end $$;

create or replace function hs_query_group(terms jsonb) returns tsquery language plpgsql immutable set search_path=public as $$
declare term text; q tsquery; part tsquery;
begin
 for term in select jsonb_array_elements_text(terms) loop
  part:=plainto_tsquery('simple',term);
  if numnode(part)>0 then q:=case when q is null then part else q || part end; end if;
 end loop;
 return q;
end $$;

create or replace function hs_search(p jsonb) returns jsonb language sql stable set search_path=public set statement_timeout='5s' as $$
with queries as (
 select ordinality as n,hs_query_group(value) as q from jsonb_array_elements(coalesce(p->'groups','[]'::jsonb)) with ordinality
), matches as (
 select c.document_id,count(distinct q.n) as matched,max(ts_rank_cd(c.fts,q.q)*(case when c.ordinal=0 then 3 else 1 end)) as rank
 from hs_chunks c join queries q on c.fts @@ q.q group by c.document_id
), eligible as (
 select d.*,s.name as source_name,coalesce(m.rank,0) as rank from hs_documents d join hs_sources s on s.id=d.source_id left join matches m on m.document_id=d.id
 where d.status='published' and ((select count(*) from queries)=0 or m.matched=(select count(*) from queries))
 and (coalesce(p->>'kind','')='' or d.kind=p->>'kind')
 and (coalesce(p->>'source','')='' or d.platform=p->>'source')
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

create or replace function hs_detail(p jsonb) returns jsonb language sql stable set search_path=public as $$
 select to_jsonb(d)||jsonb_build_object('source_name',s.name,'source_url',s.url,'object_path',r.object_path,'content_hash',r.content_hash,'fetched_at',r.fetched_at,'revision_count',(select count(*) from hs_revisions where document_id=d.id))
 from hs_documents d join hs_sources s on s.id=d.source_id join hs_revisions r on r.id=d.current_revision_id where d.id=(p->>'id')::uuid and d.status='published';
$$;
create or replace function hs_stats(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('total',count(*),'full',count(*) filter(where completeness='full'),'reports',count(*) filter(where kind='report'),'articles',count(*) filter(where kind in ('article','paper')),
 'sources',count(distinct platform),'last_ingested_at',max(updated_at),'oldest',min(published_at),'newest',max(published_at),
 'topics',(select coalesce(jsonb_agg(t),'[]') from (select topic,count(*) from hs_documents cross join lateral unnest(topics) as topic where status='published' group by topic order by count(*) desc limit 20) t),
 'platforms',(select coalesce(jsonb_agg(s),'[]') from (select platform,count(*) from hs_documents where status='published' group by platform order by count(*) desc) s)) from hs_documents where status='published';
$$;
create or replace function hs_sources_list(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (select s.*,(select count(*) from hs_documents where source_id=s.id and status='published') as documents,(select count(*) from hs_documents where source_id=s.id and status='published' and completeness='full') as full from hs_sources s order by s.name) x;
$$;
create or replace function hs_runs_list(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (select * from hs_runs order by started_at desc limit 20) x;
$$;
create or replace function hs_run_start(p jsonb) returns jsonb language plpgsql set search_path=public as $$ declare r uuid; begin
 insert into hs_runs(source_id) values(p->>'sourceId') returning id into r; return jsonb_build_object('id',r); end $$;
create or replace function hs_run_finish(p jsonb) returns jsonb language plpgsql set search_path=public as $$ begin
 update hs_runs set finished_at=now(),status=p->>'status',processed=(p->>'processed')::int,inserted=(p->>'inserted')::int,updated=(p->>'updated')::int,failed=(p->>'failed')::int,detail=left(p->>'detail',1000) where id=(p->>'id')::uuid;
 update hs_sources set last_success_at=case when p->>'status'='success' then now() else last_success_at end,status=p->>'status',detail=left(p->>'detail',1000) where id=(select source_id from hs_runs where id=(p->>'id')::uuid);
 return '{}'::jsonb; end $$;
create or replace function hs_state_get(p jsonb) returns jsonb language sql stable set search_path=public as $$ select value from hs_state where key=p->>'key'; $$;
create or replace function hs_state_set(p jsonb) returns jsonb language plpgsql set search_path=public as $$ begin
 insert into hs_state(key,value) values(p->>'key',p->'value') on conflict(key) do update set value=excluded.value,updated_at=now(); return '{}'::jsonb; end $$;
create or replace function hs_job_claim(p jsonb) returns jsonb language plpgsql set search_path=public as $$ declare claimed text; begin
 insert into hs_jobs(source_id,external_id) values(p->>'sourceId',p->>'externalId') on conflict do nothing;
 update hs_jobs set status='running',lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now()
 where source_id=p->>'sourceId' and external_id=p->>'externalId' and (lease_until is null or lease_until<now()) and next_attempt_at<=now()
 returning external_id into claimed; return jsonb_build_object('claimed',claimed is not null); end $$;
create or replace function hs_job_finish(p jsonb) returns jsonb language plpgsql set search_path=public as $$ begin
 update hs_jobs set status=case when coalesce(p->>'error','')='' then 'done' else 'retry' end,lease_until=null,last_error=p->>'error',
 next_attempt_at=case when coalesce(p->>'error','')='' then now() else now()+make_interval(secs=>least(86400,60*power(2,least(attempts,10)))) end,updated_at=now()
 where source_id=p->>'sourceId' and external_id=p->>'externalId'; return '{}'::jsonb; end $$;
