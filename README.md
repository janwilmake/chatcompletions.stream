# LLMStreamDO - share chat completion streams across multiple requests

**Why**? See this post of [Theo](https://x.com/theo/status/1923336741420765557) who made something similar - it perfectly explains why you may want to stream your LLM request without risking it may be interrupted.

**Limitations**: [be wary of wall clock time](https://x.com/janwilmake/status/1923340938266501330) and the fact that you [pay for it](https://developers.cloudflare.com/durable-objects/platform/pricing/) in durable objects when designing a system that might use this.

# SPEC

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

Make this typesctip cloudflare worker

# Non-goals:

- Model configuration storage
- Model Routing
- Monetisation
