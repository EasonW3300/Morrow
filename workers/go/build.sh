#!/usr/bin/env bash
# 构建 Morrow Go Worker（票 M2-T2 / Issue #23）。产物：bin/textstats（宿主平台）。
# 注册形态：manifest {author:"human", runtime:"go", sandbox:{type:"builtin"}}——
# 编译产物直跑，不经容器；调用方：apps/runtime ToolInvoker（go-worker.ts）。
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p bin
OUT="bin/textstats"
if [ "$(go env GOOS)" = "windows" ]; then
  OUT="bin/textstats.exe"
fi

CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" ./textstats
echo "built $(pwd)/$OUT ($(go env GOOS)/$(go env GOARCH), $(go version | awk '{print $3}'))"
