# `@ubiquity-os/issue-comment-embeddings`

This is a plugin for [Ubiquibot](https://github.com/ubiquity-os/ubiquity-os-kernel). It listens for issue comments, and adds them to a vector store. It handles comment edits and deletions as well.

## Configuration

- Host the plugin on a server that Ubiquibot can access.
  To set up the `.dev.vars` file, you will need to provide the following variables:
- `SUPABASE_URL`: The URL for your Supabase instance.
- `SUPABASE_KEY`: The key for your Supabase instance.
- `VOYAGEAI_API_KEY`: The API key for Voyage.

## Usage

- Add the following to your `.ubiquity-os.config.yml` file with the appropriate URL:

```yaml
- plugin: https://ubiquity-os-comment-vector-embeddings-main.ubiquity.workers.dev
  with:
    matchThreshold: 0.95
    warningThreshold: 0.75
    jobMatchingThreshold: 0.75
```

## Testing Locally

- Run `bun install` to install the dependencies.
- Run `bun worker` to start the server.
- Make HTTP requests to the server to test the plugin with content type `Application/JSON`

```
{
    "stateId": "",
    "eventName": "issue_comment.created",
    "eventPayload": {
        "comment": {
            "user": {
                "login" : "COMMENTER"
            },
            "body": "<COMMENT_BODY>" ,
            "id": <UNIQUE_COMMENT_ID>
        },
        "repository" : {
            "name" : "REPONAME",
            "owner":{
                "login" : "USERNAME"
            }
        },
        "issue": {
            "number": <ISSUE_NUMBER>,
            "body": "<ISSUE_TEXT>"
        }
    },
    "env": {},
    "settings": {},
    "ref": "",
    "authToken": ""
}
```

- Replace the placeholders with the appropriate values.

## Testing

- Run `bun run test` to run the tests.
