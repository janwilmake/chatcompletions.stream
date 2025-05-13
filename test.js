// test-ultimate-cache.js
import dotenv from "dotenv";
import { createHash } from "crypto";

dotenv.config();

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Please set OPENAI_API_KEY in your .env file");
  process.exit(1);
}

// Generate unique test content to ensure cold cache
const UNIQUE_ID = Date.now();
const TEST_PROMPT = `Tell me a short story about a cloudflare worker that caches responses. Include this unique ID: ${UNIQUE_ID}`;

const REQUEST_BODY = {
  model: "gpt-3.5-turbo",
  messages: [
    {
      role: "user",
      content: TEST_PROMPT,
    },
  ],
  stream: true,
  temperature: 0,
  max_tokens: 150,
};

// Calculate hash for this unique request
function calculateHash() {
  const encoder = new TextEncoder();
  const hasher = createHash("sha256");
  hasher.update(encoder.encode("api.openai.com/v1"));
  hasher.update(encoder.encode(JSON.stringify(REQUEST_BODY)));
  return hasher.digest("hex");
}

// Helper to make a streaming request and track its progress
async function makeStreamingRequest(name, startImmediately = true) {
  const startTime = Date.now();
  const events = [];

  const executeRequest = async () => {
    console.log(`[${name}] Starting at ${new Date().toISOString()}`);

    try {
      const response = await fetch(
        `${WORKER_URL}/api.openai.com/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(REQUEST_BODY),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const hasContentLength = response.headers.get("content-length");
      const firstByteTime = Date.now() - startTime;
      console.log(`[${name}] First byte received after ${firstByteTime}ms`);
      console.log(`[${name}] Has Content-Length: ${!!hasContentLength}`);

      // Read the response
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        let totalBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.length;
          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);

          // Track streaming events
          const chunkTime = Date.now() - startTime;
          events.push({ time: chunkTime, bytes: value.length });
        }

        const content = chunks.join("");
        const duration = Date.now() - startTime;

        console.log(`[${name}] Completed in ${duration}ms`);
        console.log(`[${name}] Total bytes: ${totalBytes}`);
        console.log(`[${name}] Chunks received: ${chunks.length}`);

        return {
          name,
          startTime,
          duration,
          firstByteTime,
          content,
          totalBytes,
          events,
          hasContentLength,
          chunksCount: chunks.length,
        };
      }
    } catch (error) {
      console.error(`[${name}] Error:`, error.message);
      throw error;
    }
  };

  if (startImmediately) {
    return executeRequest();
  } else {
    return executeRequest;
  }
}

// Main test function
async function runUltimateTest() {
  console.log("🚀 Ultimate Cloudflare Worker Cache Test");
  console.log("=======================================\n");
  console.log(`Unique test ID: ${UNIQUE_ID}`);
  console.log(`Request hash: ${calculateHash()}\n`);

  // Test 1: Cold cache - first request
  console.log("📊 Test 1: Cold Cache Request");
  console.log("-----------------------------");
  const coldStart = Date.now();
  const coldRequest = makeStreamingRequest("COLD");

  // Test 2: In-flight request - start while first is still processing
  console.log("\n📊 Test 2: In-Flight Request (starting 500ms after cold)");
  console.log("-------------------------------------------------------");
  const inflightRequestFn = await makeStreamingRequest("IN-FLIGHT", false);

  // Wait 500ms then start the in-flight request
  setTimeout(() => {
    inflightRequestFn();
  }, 500);

  // Wait for cold request to complete
  const coldResult = await coldRequest;

  // Wait a bit more for in-flight to complete
  await new Promise((resolve) =>
    setTimeout(resolve, coldResult.duration + 1000),
  );

  // Test 3: Multiple simultaneous requests after cold is done
  console.log("\n📊 Test 3: Simultaneous Cache Hits");
  console.log("----------------------------------");
  const simultaneousPromises = [
    makeStreamingRequest("CACHED-1"),
    makeStreamingRequest("CACHED-2"),
    makeStreamingRequest("CACHED-3"),
  ];

  const simultaneousResults = await Promise.all(simultaneousPromises);

  // Test 4: Single request after delay
  console.log("\n📊 Test 4: Delayed Cache Hit");
  console.log("----------------------------");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const delayedResult = await makeStreamingRequest("DELAYED");

  // Analysis
  console.log("\n📈 Results Analysis");
  console.log("==================");

  // Cold request analysis
  console.log("\n1️⃣ Cold Request:");
  console.log(`   Duration: ${coldResult.duration}ms`);
  console.log(`   First byte: ${coldResult.firstByteTime}ms`);
  console.log(`   Streaming: ${!coldResult.hasContentLength}`);
  console.log(`   Chunks: ${coldResult.chunksCount}`);
  console.log(`   Size: ${coldResult.totalBytes} bytes`);

  // Cached requests analysis
  console.log("\n2️⃣ Cached Requests:");
  simultaneousResults.forEach((result) => {
    console.log(
      `   ${result.name}: ${result.duration}ms, first byte at ${result.firstByteTime}ms`,
    );
  });
  console.log(
    `   ${delayedResult.name}: ${delayedResult.duration}ms, first byte at ${delayedResult.firstByteTime}ms`,
  );

  // Content verification
  console.log("\n3️⃣ Content Verification:");
  const allMatch =
    simultaneousResults.every((r) => r.content === coldResult.content) &&
    delayedResult.content === coldResult.content;
  console.log(`   All responses identical: ${allMatch ? "✅" : "❌"}`);
  console.log(
    `   Contains unique ID: ${
      coldResult.content.includes(UNIQUE_ID) ? "✅" : "❌"
    }`,
  );

  // Performance metrics
  console.log("\n4️⃣ Performance Metrics:");
  const avgCachedTime =
    (simultaneousResults.reduce((sum, r) => sum + r.duration, 0) +
      delayedResult.duration) /
    (simultaneousResults.length + 1);
  console.log(`   Average cached response time: ${avgCachedTime.toFixed(2)}ms`);
  console.log(
    `   Speed improvement: ${(coldResult.duration / avgCachedTime).toFixed(
      1,
    )}x faster`,
  );

  // Cache behavior validation
  console.log("\n5️⃣ Cache Behavior Validation:");

  if (coldResult.duration > 500 && !coldResult.hasContentLength) {
    console.log("   ✅ Cold request was truly cold (slow and streaming)");
  } else if (coldResult.duration < 100) {
    console.log("   ⚠️  Cold request was too fast - might have been cached");
  }

  if (
    avgCachedTime < 50 &&
    simultaneousResults.every((r) => r.hasContentLength)
  ) {
    console.log("   ✅ Cached responses are fast and complete");
  }

  if (allMatch) {
    console.log("   ✅ Cache consistency verified - all responses match");
  }

  // Streaming behavior
  console.log("\n6️⃣ Streaming Behavior:");
  console.log(`   Cold request chunks: ${coldResult.chunksCount}`);
  console.log(
    `   Cached request chunks: ${simultaneousResults[0].chunksCount}`,
  );

  if (coldResult.chunksCount > 5 && simultaneousResults[0].chunksCount <= 2) {
    console.log(
      "   ✅ Cold request streamed, cached requests returned complete",
    );
  }

  // Extract and display the actual message
  console.log("\n7️⃣ Response Content Sample:");
  const events = coldResult.content
    .split("\n\n")
    .filter((e) => e.startsWith("data: "));
  let fullMessage = "";

  for (const event of events) {
    if (event === "data: [DONE]") continue;
    try {
      const data = JSON.parse(event.substring(6));
      if (data.choices?.[0]?.delta?.content) {
        fullMessage += data.choices[0].delta.content;
      }
    } catch (e) {
      // Skip non-JSON events
    }
  }

  console.log(`   Message preview: "${fullMessage.substring(0, 100)}..."`);
  console.log(
    `   Contains unique ID ${UNIQUE_ID}: ${
      fullMessage.includes(UNIQUE_ID) ? "✅" : "❌"
    }`,
  );

  // Final summary
  console.log("\n🏁 Test Summary");
  console.log("===============");

  const cacheWorking =
    coldResult.duration > 500 && avgCachedTime < 50 && allMatch;

  if (cacheWorking) {
    console.log("✅ Cache is working perfectly!");
    console.log(
      `   - Cold request took ${coldResult.duration}ms (actual API call)`,
    );
    console.log(`   - Cached requests average ${avgCachedTime.toFixed(2)}ms`);
    console.log(
      `   - ${(coldResult.duration / avgCachedTime).toFixed(
        1,
      )}x performance improvement`,
    );
    console.log("   - All responses are identical");
  } else {
    console.log("⚠️  Cache behavior needs investigation");
    if (coldResult.duration < 100) {
      console.log("   - Cold request was too fast, might be pre-cached");
    }
    if (avgCachedTime > 100) {
      console.log("   - Cached requests are slower than expected");
    }
    if (!allMatch) {
      console.log("   - Response consistency issue detected");
    }
  }
}

// Run the ultimate test
console.log("Starting ultimate cache test with unique content...\n");
runUltimateTest().catch(console.error);
