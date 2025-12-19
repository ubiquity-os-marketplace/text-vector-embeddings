# Supabase migration evidence (2025-12-19)

## Scope
Migrate legacy text-vector-embeddings data into the main Supabase project:
- Target project: wfzpewmlyiozupulbuur
- Tables: public.issues, public.issue_comments
- Embeddings are stored in the embedding columns on both tables.

## Workflow run
- Workflow: .github/workflows/supabase-migrate-embeddings.yml
- Run ID: 20367292657
- URL: https://github.com/ubiquity-os-marketplace/text-vector-embeddings/actions/runs/20367292657
- Inputs: batch_size=100, dry_run=false

## Schema provisioning
Schema is created by scripts/bootstrap-schema.sql and includes:
- vector extension
- public.issues and public.issue_comments tables
- HNSW indexes for embedding search
- matching/annotation helper SQL functions

## Migration results (from run logs)
The migration script logs source and target counts and enforces target >= source.
- issues: source=2795, target_before=1803, target_after=2808
- issue_comments: source=3922, target_before=0, target_after=3922

Note: target issues count was higher after migration because pre-existing rows were present.

## Production secrets update
After the migration, production secrets were updated in the repo:
- SUPABASE_URL
- SUPABASE_KEY
- SUPABASE_PROJECT_ID
- SUPABASE_DB_PASSWORD

Values are stored only in GitHub Actions secrets and not committed.

## References
- scripts/bootstrap-schema.sql
- scripts/migrate-supabase.ts
