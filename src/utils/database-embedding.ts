export function serializeEmbeddingForDatabase(embedding: number[] | null): string | null {
  return embedding ? JSON.stringify(embedding) : null;
}
