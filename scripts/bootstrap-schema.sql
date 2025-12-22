create extension if not exists vector;

create table if not exists issues (
  id varchar primary key,
  embedding vector(1024) not null,
  payload jsonb,
  author_id varchar not null,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now(),
  markdown text
);

create table if not exists issue_comments (
  id varchar primary key,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now(),
  author_id varchar not null,
  embedding vector(1024) not null,
  payload jsonb,
  issue_id varchar references issues(id) on delete cascade,
  markdown text
);

alter table issues enable row level security;
alter table issue_comments enable row level security;

create or replace function find_similar_issues_to_match(current_id varchar, query_embedding vector(1024), threshold float8, top_k int)
returns table(issue_id varchar, similarity float8) as $$
declare
  current_quantized vector(1024);
begin
  current_quantized := query_embedding;

  return query
  select id as issue_id,
         ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
  from issues
  where id <> current_id
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
  from issues
  where id <> current_id
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
  from issue_comments
  where id <> current_id
    and ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
  order by similarity desc
  limit top_k;
end;
$$ language plpgsql;
