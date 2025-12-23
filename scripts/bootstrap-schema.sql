create extension if not exists vector;

create table if not exists documents (
  id varchar primary key,
  doc_type text not null,
  parent_id varchar,
  embedding vector(1024),
  payload jsonb,
  author_id varchar not null,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now(),
  markdown text,
  deleted_at timestamptz,
  embedding_status text not null default 'ready',
  embedding_model text,
  embedding_dim integer,
  constraint documents_doc_type_check check (doc_type in ('issue', 'issue_comment', 'review_comment', 'pull_request')),
  constraint documents_parent_id_fkey foreign key (parent_id) references documents(id) on delete cascade
);

alter table documents enable row level security;

drop policy if exists documents_service_role_all on documents;
create policy documents_service_role_all
  on documents
  for all
  to service_role
  using (true)
  with check (true);

create or replace function find_similar_issues_to_match(current_id varchar, query_embedding vector(1024), threshold float8, top_k int)
returns table(issue_id varchar, similarity float8) as $$
declare
  current_quantized vector(1024);
begin
  current_quantized := query_embedding;

  return query
  select id as issue_id,
         ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
  from documents
  where id <> current_id
    and doc_type = 'issue'
    and ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
  order by similarity desc
  limit top_k;
end;
$$ language plpgsql;

create or replace function find_similar_issues_annotate(current_id varchar, query_embedding vector(1024), threshold float8, top_k int)
returns table(issue_id varchar, similarity float8) as $$
declare
  current_quantized vector(1024);
begin
  current_quantized := query_embedding;

  return query
  select id as issue_id,
         ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
  from documents
  where id <> current_id
    and doc_type = 'issue'
    and ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
  order by similarity desc
  limit top_k;
end;
$$ language plpgsql;

create or replace function find_similar_comments_annotate(current_id varchar, query_embedding vector(1024), threshold float8, top_k int)
returns table(comment_id varchar, similarity float8) as $$
declare
  current_quantized vector(1024);
begin
  current_quantized := query_embedding;

  return query
  select id as comment_id,
         ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
  from documents
  where id <> current_id
    and doc_type in ('issue_comment', 'review_comment')
    and ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
  order by similarity desc
  limit top_k;
end;
$$ language plpgsql;
