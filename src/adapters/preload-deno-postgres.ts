// Ensure Deno includes the JSR package in the entrypoint module graph before
// the runtime adapter dynamically imports it under cached-only execution.
import "jsr:@db/postgres";
