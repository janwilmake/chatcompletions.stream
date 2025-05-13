`LLMStreamDO is a cloudflare worker, backed by durable objects.`

- only listens to POST /{llmBasePath}/chat/completions with Authorization bearer token and json body
- calculates a deterministic hash of the llmBasePath + body text as it comes in (no need to parse json first).also collects body as string
- checks kv if hash already present. if so, respond with that immediately
- if not, gets DO with name of that hash
- forwards request to the DO including authorization and x-name being the calculated hash
- also proxies back response , directly

The DO:

- Takes POST https://basepath.com/chat/completions
- Streams back the result after proxying to the real one.
- After streaming, sets it to KV at hash
- While streaming, takes any other POST request, which will always connect to the current `ReadableStream` but prepend it with all results so far.
- destroys itself 60 seconds after final result is submitted to KV (relying on eventual consistency of max 60 seconds)

make this typesctip cloudflare worker

# Non-goals:

- Model configuration storage
- Model Routing
- Monetisation
