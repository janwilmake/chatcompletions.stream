// Worker Env interface
interface Env {
  CACHE_KV: KVNamespace;
  LLM_STREAM_DO: DurableObjectNamespace;
}

// Durable Object for handling streaming and caching
export class LLMStreamDO {
  private state: DurableObjectState;
  private env: Env;
  private accumulatedData: Uint8Array[] = [];
  private hash: string | null = null;
  private streamComplete: boolean = false;
  private selfDestructTimer: NodeJS.Timeout | null = null;
  private isFirstRequest: boolean = true;
  private activeControllers: ReadableStreamDefaultController<Uint8Array>[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const hash = request.headers.get("x-name");
    if (!hash) {
      return new Response("Missing x-name header", { status: 400 });
    }

    // If stream is complete, return accumulated data
    if (this.streamComplete) {
      const fullData = new Uint8Array(
        this.accumulatedData.reduce((acc, chunk) => acc + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of this.accumulatedData) {
        fullData.set(chunk, offset);
        offset += chunk.length;
      }

      return new Response(fullData, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Create a new stream for this request
    const stream = new ReadableStream({
      start: (controller) => {
        // First, send all accumulated data
        for (const chunk of this.accumulatedData) {
          controller.enqueue(chunk);
        }

        // If stream is already complete, close immediately
        if (this.streamComplete) {
          controller.close();
          return;
        }

        // Add this controller to the list of active controllers
        this.activeControllers.push(controller);

        // If this is the first request, start the upstream fetch
        if (this.isFirstRequest) {
          this.isFirstRequest = false;
          this.hash = hash;
          this.initializeStream(request);
        }
      },
      cancel: (controller) => {
        // Remove this controller from the active list when canceled
        const index = this.activeControllers.indexOf(controller);
        if (index > -1) {
          this.activeControllers.splice(index, 1);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async initializeStream(request: Request) {
    try {
      const authorization = request.headers.get("authorization");
      if (!authorization) {
        throw new Error("Missing authorization header");
      }

      // Forward the request to the actual LLM API
      const llmResponse = await fetch(request);

      if (!llmResponse.ok) {
        throw new Error(`LLM API error: ${llmResponse.status}`);
      }

      const reader = llmResponse.body!.getReader();

      // Read from the upstream and broadcast to all active controllers
      const pump = async () => {
        try {
          const { done, value } = await reader.read();

          if (done) {
            this.handleStreamComplete();
            return;
          }

          // Accumulate the data
          this.accumulatedData.push(value);

          // Broadcast to all active controllers
          for (const controller of this.activeControllers) {
            try {
              controller.enqueue(value);
            } catch (e) {
              // Controller might be closed, ignore
            }
          }

          pump();
        } catch (error) {
          this.handleStreamError(error);
        }
      };

      pump();
    } catch (error) {
      this.handleStreamError(error);
    }
  }

  private async handleStreamComplete() {
    this.streamComplete = true;

    // Close all active controllers
    for (const controller of this.activeControllers) {
      try {
        controller.close();
      } catch (e) {
        // Controller might already be closed
      }
    }
    this.activeControllers = [];

    // Combine all accumulated data
    const fullData = new Uint8Array(
      this.accumulatedData.reduce((acc, chunk) => acc + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of this.accumulatedData) {
      fullData.set(chunk, offset);
      offset += chunk.length;
    }

    // Store in KV
    if (this.hash) {
      await this.env.CACHE_KV.put(this.hash, fullData, {
        expirationTtl: 3600, // 1 hour TTL
      });
    }

    // Set self-destruct timer for 60 seconds
    this.selfDestructTimer = setTimeout(() => {
      // The DO will be garbage collected when there are no more references
    }, 60000);
  }

  private handleStreamError(error: any) {
    // Notify all active controllers of the error
    for (const controller of this.activeControllers) {
      try {
        controller.error(error);
      } catch (e) {
        // Controller might already be closed
      }
    }
    this.activeControllers = [];
  }
}

class IncrementalSHA256 {
  private buffer: Uint8Array;
  private bufferLength: number;
  private bytesHashed: number;
  private h: Uint32Array;
  private k: Uint32Array;

  constructor() {
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;

    // Initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);

    // Round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
    this.k = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
  }

  update(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.buffer[this.bufferLength++] = data[i];
      if (this.bufferLength === 64) {
        this.processBlock();
        this.bufferLength = 0;
      }
    }
    this.bytesHashed += data.length;
  }

  private processBlock(): void {
    const w = new Uint32Array(64);

    // Copy block into first 16 words w[0..15]
    for (let i = 0; i < 16; i++) {
      w[i] =
        (this.buffer[i * 4] << 24) |
        (this.buffer[i * 4 + 1] << 16) |
        (this.buffer[i * 4 + 2] << 8) |
        this.buffer[i * 4 + 3];
    }

    // Extend the first 16 words into the remaining 48 words w[16..63]
    for (let i = 16; i < 64; i++) {
      const s0 =
        this.rightRotate(w[i - 15], 7) ^
        this.rightRotate(w[i - 15], 18) ^
        (w[i - 15] >>> 3);
      const s1 =
        this.rightRotate(w[i - 2], 17) ^
        this.rightRotate(w[i - 2], 19) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    // Working variables
    let [a, b, c, d, e, f, g, h] = this.h;

    // Main loop
    for (let i = 0; i < 64; i++) {
      const S1 =
        this.rightRotate(e, 6) ^
        this.rightRotate(e, 11) ^
        this.rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + this.k[i] + w[i]) >>> 0;
      const S0 =
        this.rightRotate(a, 2) ^
        this.rightRotate(a, 13) ^
        this.rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    // Update hash values
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  private rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
  }

  finalize(): string {
    // Pad the message
    const bitLength = this.bytesHashed * 8;
    this.buffer[this.bufferLength++] = 0x80;

    if (this.bufferLength > 56) {
      while (this.bufferLength < 64) {
        this.buffer[this.bufferLength++] = 0;
      }
      this.processBlock();
      this.bufferLength = 0;
    }

    while (this.bufferLength < 56) {
      this.buffer[this.bufferLength++] = 0;
    }

    // Append length in bits as 64-bit big-endian
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;

    this.buffer[56] = high >>> 24;
    this.buffer[57] = high >>> 16;
    this.buffer[58] = high >>> 8;
    this.buffer[59] = high;
    this.buffer[60] = low >>> 24;
    this.buffer[61] = low >>> 16;
    this.buffer[62] = low >>> 8;
    this.buffer[63] = low;

    this.processBlock();

    // Convert hash to hex string
    let result = "";
    for (let i = 0; i < 8; i++) {
      result += this.h[i].toString(16).padStart(8, "0");
    }

    return result;
  }
}

// Main worker handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Extract the llmBasePath from the URL
    const pathParts = url.pathname.split("/");
    if (
      pathParts.length < 4 ||
      pathParts[pathParts.length - 2] !== "chat" ||
      pathParts[pathParts.length - 1] !== "completions"
    ) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Check authorization
    const authorization = request.headers.get("authorization");
    if (!authorization || !authorization.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const llmBasePath = pathParts.slice(1, -2).join("/");

      // Initialize streaming hash
      const hasher = new IncrementalSHA256();
      const encoder = new TextEncoder();

      // Add the prefix to the hash
      hasher.update(encoder.encode(llmBasePath));

      // Stream the body while simultaneously hashing it and collecting it
      const chunks: Uint8Array[] = [];
      const reader = request.body!.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Update hash with this chunk
        hasher.update(value);

        // Collect chunk for later use
        chunks.push(value);
      }

      // Finalize the hash
      const hash = hasher.finalize();

      console.log({ hash });
      // Check KV cache first
      const cachedData = await env.CACHE_KV.get(hash, { type: "arrayBuffer" });
      if (cachedData) {
        return new Response(cachedData, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // Reconstruct the body for forwarding
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const body = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }

      // Get or create Durable Object
      const doId = env.LLM_STREAM_DO.idFromName(hash);
      const doStub = env.LLM_STREAM_DO.get(doId);

      const withProtocol = (url: string) =>
        url.startsWith("https://") ? url : "https://" + url;

      // Forward request to DO with the actual LLM base path
      const doRequest = new Request(
        `${withProtocol(llmBasePath)}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            "x-name": hash,
          },
          body: body,
        },
      );

      // Proxy the response back
      return await doStub.fetch(doRequest);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error:
            error instanceof Error ? error.message : "Internal Server Error",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
