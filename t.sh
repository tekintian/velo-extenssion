#!/bin/bash
cd "$(dirname "$0")"

echo "========== 1. 双站点广告检测精度 =========="
bun run diagnose.ts

echo ""
echo "========== 2. 单元测试 =========="
bun x vitest run tests/unit/engine/hls 2>&1 | tail -15

echo ""
echo "========== 3. 类型检查 =========="
bun x tsc --noEmit 2>&1 | tail -20

echo ""
echo "========== 4. 构建 =========="
bun x wxt build 2>&1 | tail -6

echo ""
echo "========== 5. 产物校验 =========="
echo -n "minority-path-block: "
grep -c "minority-path-block" .output/chrome-mv3/background.js
echo -n "short-block: "
grep -c "short-block" .output/chrome-mv3/background.js