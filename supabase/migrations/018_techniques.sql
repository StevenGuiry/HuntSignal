-- Rebuildable, revision-bound evidence extracted only from published reports.
begin;
create table if not exists hs_technique_sets(
 document_id uuid primary key references hs_documents(id) on delete cascade,
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 version text not null check(length(version)<=80),extracted_at timestamptz not null default now(),
 evidence_count integer not null check(evidence_count between 0 and 50),payload_count integer not null check(payload_count between 0 and 50),
 oversized integer not null default 0 check(oversized>=0),limited boolean not null default false,
 unique(document_id,revision_id)
);
create table if not exists hs_technique_entries(
 document_id uuid not null,revision_id uuid not null,ordinal integer not null check(ordinal between 0 and 49),
 data jsonb not null check(jsonb_typeof(data)='object' and length(data::text)<=16000),
 primary key(document_id,ordinal),foreign key(document_id,revision_id) references hs_technique_sets(document_id,revision_id) on delete cascade
);
create index if not exists hs_technique_topic on hs_technique_entries((data->>'topic'));
create index if not exists hs_technique_type on hs_technique_entries((data->>'techniqueId'));
alter table hs_technique_sets enable row level security;
alter table hs_technique_entries enable row level security;
revoke all on hs_technique_sets,hs_technique_entries from public,anon,authenticated;
grant all on hs_technique_sets,hs_technique_entries to service_role;

create or replace function hs_invalidate_techniques() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status<>'published' or new.current_revision_id is distinct from old.current_revision_id then
  delete from hs_technique_sets where document_id=new.id;
  update hs_review_queue set status='superseded',resolved_at=now() where document_id=new.id and kind='techniques' and status='open';
 end if;return new;
end $$;
drop trigger if exists hs_invalidate_techniques on hs_documents;
create trigger hs_invalidate_techniques after update of status,current_revision_id on hs_documents for each row execute function hs_invalidate_techniques();

create or replace function hs_techniques_pending(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (
  select d.id,d.current_revision_id as revision_id,d.title,d.topics,r.object_path from hs_documents d join hs_revisions r on r.id=d.current_revision_id
  left join hs_technique_sets s on s.document_id=d.id and s.revision_id=d.current_revision_id and s.version=p->>'version'
  where d.kind='report' and d.status='published' and s.document_id is null
  and not exists(select 1 from hs_review_queue q where q.document_id=d.id and q.kind='techniques' and q.status='open')
  order by d.id limit least(1000,greatest(1,coalesce((p->>'limit')::integer,500)))
 )x;
$$;
create or replace function hs_techniques_put(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare d hs_documents; entry jsonb; entries jsonb:=p->'items'; n integer:=0; payloads integer:=0;
begin
 select * into d from hs_documents where id=(p->>'id')::uuid for update;
 if not found or d.kind<>'report' or d.status<>'published' or d.current_revision_id::text is distinct from p->>'revisionId' then return jsonb_build_object('stale',true);end if;
 if pg_database_size(current_database())>=400000000 then raise exception 'Technique index capacity reached';end if;
 if coalesce(p->>'version','') !~ '^archive-techniques-v[0-9]+$' or jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries)>50 or length(entries::text)>600000 then raise exception 'Invalid extraction batch';end if;
 delete from hs_technique_sets where document_id=d.id;
 insert into hs_technique_sets(document_id,revision_id,version,evidence_count,payload_count,oversized,limited)
 values(d.id,d.current_revision_id,p->>'version',jsonb_array_length(entries),0,coalesce((p->>'oversized')::integer,0),coalesce((p->>'limited')::boolean,false));
 for entry in select value from jsonb_array_elements(entries) loop
  if coalesce(entry->>'kind','') not in ('payload','technique') or coalesce(entry->>'format','') not in ('fenced code','inline code','indented code','report wording')
   or length(coalesce(entry->>'text','')) not between 1 and 8000 or length(coalesce(entry->>'label','')) not between 1 and 150 or length(coalesce(entry->>'topic','')) not between 1 and 80
   or coalesce(entry->>'techniqueId','') !~ '^[a-z0-9-]{1,80}$' or length(coalesce(entry->>'before',''))>400 or length(coalesce(entry->>'after',''))>400
   or coalesce(entry->>'sourceStart','') !~ '^[0-9]{1,7}$' or coalesce(entry->>'sourceEnd','') !~ '^[0-9]{1,7}$'
   or (entry->>'sourceEnd')::integer<=(entry->>'sourceStart')::integer or (entry->>'sourceEnd')::integer>2000000
   or coalesce(entry->>'lineStart','') !~ '^[0-9]{1,7}$' or (entry->>'lineStart')::integer<1 or coalesce(entry->>'lineEnd','') !~ '^[0-9]{1,7}$' or (entry->>'lineEnd')::integer<(entry->>'lineStart')::integer
  then raise exception 'Invalid technique evidence';end if;
  insert into hs_technique_entries(document_id,revision_id,ordinal,data) values(d.id,d.current_revision_id,n,entry);
  n:=n+1;if entry->>'kind'='payload' then payloads:=payloads+1;end if;
 end loop;
 update hs_technique_sets set payload_count=payloads where document_id=d.id;
 return jsonb_build_object('stale',false,'count',n);
end $$;

create or replace function hs_techniques_search(p jsonb default '{}') returns jsonb language sql stable set search_path=public set jit=off as $$
 with reports as materialized (
  select d.* from hs_documents d where d.kind='report' and d.status='published' and (nullif(p->>'reportId','') is null or d.id=(p->>'reportId')::uuid)
 ), sets as materialized (
  select s.* from hs_technique_sets s join reports d on d.id=s.document_id and d.current_revision_id=s.revision_id where s.version=coalesce(p->>'version','archive-techniques-v1')
 ), evidence as materialized (
  select e.*,d.title,d.canonical_url,d.platform,d.completeness,d.published_at from hs_technique_entries e join sets s using(document_id,revision_id) join reports d on d.id=e.document_id
 ), eligible as (
  select * from evidence e where (coalesce(p->>'topic','')='' or e.data->>'topic'=p->>'topic')
  and (coalesce(p->>'technique','')='' or e.data->>'techniqueId'=p->>'technique')
  and (coalesce(p->>'kind','')='' or e.data->>'kind'=p->>'kind')
  and (coalesce(p->>'q','')='' or exists(select 1 from jsonb_array_elements_text(coalesce(p->'terms',jsonb_build_array(p->>'q'))) t(term)
   where position(lower(t.term) in lower(concat_ws(' ',e.title,e.data->>'text',e.data->>'label',e.data->>'topic',e.data->>'before',e.data->>'after')))>0))
 ), selected as (
  select * from eligible order by case when data->>'kind'='payload' then 0 else 1 end,published_at desc nulls last,document_id,ordinal
  limit least(50,greatest(1,coalesce((p->>'limit')::integer,20))) offset (greatest(1,coalesce((p->>'page')::integer,1))-1)*least(50,greatest(1,coalesce((p->>'limit')::integer,20)))
 ) select jsonb_build_object(
  'items',coalesce((select jsonb_agg(data||jsonb_build_object('document_id',document_id,'revision_id',revision_id,'ordinal',ordinal,'title',title,'canonical_url',canonical_url,'platform',platform,'completeness',completeness,'published_at',published_at)) from selected),'[]'),
  'total',(select count(*) from eligible),'page',coalesce((p->>'page')::integer,1),'limit',coalesce((p->>'limit')::integer,20),
  'coverage',jsonb_build_object('reports',(select count(*) from reports),'indexed',(select count(*) from sets),'withEvidence',(select count(*) from sets where evidence_count>0),'withPayloads',(select count(*) from sets where payload_count>0),'limited',(select count(*) from sets where limited or oversized>0)),
  'topics',coalesce((select jsonb_agg(x) from (select data->>'topic' as topic,count(distinct document_id) as reports from evidence group by data->>'topic' order by data->>'topic')x),'[]'),
  'techniques',coalesce((select jsonb_agg(x) from (select data->>'techniqueId' as id,data->>'label' as label,data->>'topic' as topic,count(distinct document_id) as reports from evidence where coalesce(p->>'topic','')='' or data->>'topic'=p->>'topic' group by data->>'techniqueId',data->>'label',data->>'topic' order by data->>'label')x),'[]')
 );
$$;
revoke all on function hs_invalidate_techniques(),hs_techniques_pending(jsonb),hs_techniques_put(jsonb),hs_techniques_search(jsonb) from public,anon,authenticated;
grant execute on function hs_techniques_pending(jsonb),hs_techniques_put(jsonb),hs_techniques_search(jsonb) to service_role;
commit;
