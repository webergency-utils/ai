#!/bin/bash -eu

npm install
npm run build

compile_javascript_fuzzer ai fuzz_ai.cjs
compile_javascript_fuzzer ai fuzz_stream.cjs
