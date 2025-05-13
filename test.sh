#!/bin/bash

# Test script for LLM Stream Cache Worker

# Configuration
WORKER_URL="http://localhost:3000"  # For local dev
# WORKER_URL="https://llm-cache.workers.dev"  # For production
BEARER_TOKEN=""
LLM_BASEPATH="https://api.openai.com/v1"  # Example LLM endpoint

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "Testing LLM Stream Cache Worker..."
echo "================================"

# Test 1: Basic request
echo -e "\n${GREEN}Test 1: Basic completion request${NC}"
curl -X POST "${WORKER_URL}/${LLM_BASEPATH}/chat/completions" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Say hello in exactly 5 words"}
    ],
    "temperature": 0,
    "max_tokens": 20,
    "stream": true
  }' \
  --no-buffer \
  -w "\nResponse time: %{time_total}s\n"

# Test 2: Same request (should be cached)
echo -e "\n${GREEN}Test 2: Same request (should be cached)${NC}"
time curl -X POST "${WORKER_URL}/${LLM_BASEPATH}/chat/completions" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Say hello in exactly 5 words"}
    ],
    "temperature": 0,
    "max_tokens": 20,
    "stream": true
  }' \
  --no-buffer \
  -w "\nResponse time: %{time_total}s\n"

# Test 3: Concurrent requests (testing DO behavior)
echo -e "\n${GREEN}Test 3: Concurrent requests${NC}"
for i in {1..3}; do
  curl -X POST "${WORKER_URL}/${LLM_BASEPATH}/chat/completions" \
    -H "Authorization: Bearer ${BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "gpt-3.5-turbo",
      "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Count from 1 to 5"}
      ],
      "temperature": 0,
      "max_tokens": 30,
      "stream": true
    }' \
    --no-buffer \
    -w "\nRequest $i - Response time: %{time_total}s\n" &
done
wait

# Test 4: Different content (should not be cached)
echo -e "\n${GREEN}Test 4: Different content${NC}"
curl -X POST "${WORKER_URL}/${LLM_BASEPATH}/chat/completions" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is 2+2?"}
    ],
    "temperature": 0,
    "max_tokens": 10,
    "stream": true
  }' \
  --no-buffer \
  -w "\nResponse time: %{time_total}s\n"

# Test 5: Invalid endpoint (should 404)
echo -e "\n${GREEN}Test 5: Invalid endpoint${NC}"
curl -X POST "${WORKER_URL}/invalid/endpoint" \
  -H "Authorization: Bearer ${BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  -s -o /dev/null

# Test 6: Missing authorization (should 401)
echo -e "\n${GREEN}Test 6: Missing authorization${NC}"
curl -X POST "${WORKER_URL}/${LLM_BASEPATH}/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  -s -o /dev/null

echo -e "\n${GREEN}All tests completed!${NC}"