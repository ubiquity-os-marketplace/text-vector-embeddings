DROP FUNCTION IF EXISTS find_similar_issues_annotate;
DROP FUNCTION IF EXISTS find_similar_comments_annotate;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, issue_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    -- Ensure the query_embedding is in the correct format
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS issue_id,
           plaintext AS issue_plaintext,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issues
    WHERE id <> current_id
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, comment_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    -- Ensure the query_embedding is in the correct format
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS comment_id,
           plaintext AS comment_plaintext,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issue_comments
    WHERE id <> current_id 
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;