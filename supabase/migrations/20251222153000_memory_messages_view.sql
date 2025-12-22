SET search_path = public, extensions;
SET maintenance_work_mem = '64MB';

CREATE OR REPLACE VIEW memory_messages AS
  SELECT
    'issue'::text AS source_type,
    id AS source_id,
    payload->'repository'->>'name' AS repo,
    payload->'repository'->'owner'->>'login' AS owner,
    payload->'issue'->>'html_url' AS source_url,
    payload->'issue'->>'number' AS issue_number,
    author_id,
    markdown,
    plaintext,
    embedding,
    created_at,
    modified_at
  FROM issues
  WHERE deleted_at IS NULL
    AND embedding_status = 'ready'
    AND embedding IS NOT NULL
  UNION ALL
  SELECT
    'issue_comment'::text AS source_type,
    id AS source_id,
    payload->'repository'->>'name' AS repo,
    payload->'repository'->'owner'->>'login' AS owner,
    payload->'comment'->>'html_url' AS source_url,
    COALESCE(payload->'issue'->>'number', payload->'pull_request'->>'number') AS issue_number,
    author_id,
    markdown,
    plaintext,
    embedding,
    created_at,
    modified_at
  FROM issue_comments
  WHERE deleted_at IS NULL
    AND embedding_status = 'ready'
    AND embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS issues_embedding_ivfflat
  ON issues USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

CREATE INDEX IF NOT EXISTS issue_comments_embedding_ivfflat
  ON issue_comments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
